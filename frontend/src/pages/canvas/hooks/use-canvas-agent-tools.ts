import { useEffect, useRef, type RefObject } from "react";

import { getNodeSpec } from "@/constant/canvas";
import { repeatedConnectedText } from "@/components/canvas/canvas-node-generation";
import { resolveMediaUrl } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { onAnyAgentEvent, sendAgentMessage, type ToolContent } from "@/services/api/agent";
import type { RunRequest } from "@/services/api/runs";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type Position } from "@/types/canvas";

/**
 * The canvas's hands.
 *
 * The gateway advertises the tools and cannot run any of them: it holds the socket, not the nodes. So a
 * tool call arrives here — `{"type":"tool","callId":…,"name":…,"arguments":…}` — and this runs it against
 * the page's own state and answers on the same session it came from. Whatever the user's buttons do, a
 * tool does; nothing here is a second way to change a canvas.
 *
 * It answers every session, not just the canvas panel's: the canvas is one, and a node's agent asking to
 * see it is the same question as the panel's agent asking.
 */
export function useCanvasAgentTools({
    nodesRef,
    connectionsRef,
    createNode,
    generateNode,
    setNodePrompt,
    connectNodes,
    deleteNodes,
    focusNode,
    moveNode,
}: {
    nodesRef: RefObject<CanvasNodeData[]>;
    connectionsRef: RefObject<CanvasConnection[]>;
    createNode: CanvasHands["createNode"];
    generateNode: CanvasHands["generateNode"];
    setNodePrompt: CanvasHands["setNodePrompt"];
    connectNodes: CanvasHands["connectNodes"];
    deleteNodes: CanvasHands["deleteNodes"];
    focusNode: CanvasHands["focusNode"];
    moveNode: CanvasHands["moveNode"];
}) {
    // The refs and callbacks outlive a render, and a tool call can arrive between two of them.
    const hands = useRef<CanvasHands>({
        nodes: () => [],
        connections: () => [],
        createNode,
        generateNode,
        setNodePrompt,
        connectNodes,
        deleteNodes,
        focusNode,
        moveNode,
    });
    hands.current = {
        nodes: () => nodesRef.current || [],
        connections: () => connectionsRef.current || [],
        createNode,
        generateNode,
        setNodePrompt,
        connectNodes,
        deleteNodes,
        focusNode,
        moveNode,
    };

    useEffect(
        () =>
            onAnyAgentEvent((session, event) => {
                if (event.type !== "tool" || !event.callId) return;
                const callId = event.callId;
                const answer = (content: ToolContent[], isError?: boolean) => sendAgentMessage(session, { toolResult: { callId, content, isError } });
                void runTool(event.name || "", event.arguments, hands.current, session).then(
                    (result) => answer(result.content, result.isError),
                    (error: unknown) => answer([textBlock(error instanceof Error ? error.message : String(error))], true),
                );
            }),
        [],
    );
}

/** What the page lends a tool: its state to read, the way it makes a node, and the button that runs one. */
type CanvasHands = {
    nodes: () => CanvasNodeData[];
    connections: () => CanvasConnection[];
    createNode: (type: CanvasNodeTypeId, position?: Position, patch?: CanvasNodeMetadata) => CanvasNodeData;
    generateNode: (nodeId: string, mode: CanvasGenerationMode, prompt: string, askedBy?: RunRequest["askedBy"]) => Promise<void>;
    setNodePrompt: (nodeId: string, prompt: string) => void;
    connectNodes: (firstNodeId: string, secondNodeId: string, firstHandleType: "source" | "target") => boolean;
    deleteNodes: (nodeIds: string[]) => void;
    focusNode: (nodeId: string) => void;
    moveNode: (nodeId: string, position: Position) => void;
};

/** One tool's result: the content blocks the agent reads, and whether it failed rather than did something. */
type ToolAnswer = { content: ToolContent[]; isError?: boolean };

const textBlock = (text: string): ToolContent => ({ type: "text", text });

/** The node types a tool may make. A group is structure, not content. */
const CREATE_TYPES: string[] = [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text, CanvasNodeType.Config];

async function runTool(name: string, args: unknown, hands: CanvasHands, session: string): Promise<ToolAnswer> {
    switch (name) {
        case "ping":
            return { content: [textBlock(`listening: ${hands.nodes().length} nodes, ${hands.connections().length} connections`)] };
        case "list_nodes":
            return { content: [textBlock(describeCanvas(hands.nodes(), hands.connections()))] };
        case "create_node":
            return createNode(hands, args);
        case "read_node":
            return readNode(hands, args);
        case "connect":
            return connect(hands, args);
        case "set_prompt":
            return setPrompt(hands, args);
        case "generate":
            return pressGenerate(hands, args, session);
        case "delete_node":
            return deleteNode(hands, args);
        case "focus_node":
            return focusNode(hands, args);
        case "move_node":
            return moveNode(hands, args);
        default:
            return { content: [textBlock(`this canvas has no tool called ${name}`)], isError: true };
    }
}

/** A tool's arguments as an object, whatever the agent sent instead. */
function argsOf(args: unknown): Record<string, unknown> {
    return (typeof args === "object" && args ? args : {}) as Record<string, unknown>;
}

/** The id a tool names, as the agent wrote it. */
function nodeIdOf(args: unknown): string {
    const nodeId = argsOf(args).nodeId;
    return typeof nodeId === "string" ? nodeId.trim() : "";
}

/** The words a tool asks a node to hold, or nothing when it asked with something else. */
function promptOf(args: unknown): string | undefined {
    const prompt = argsOf(args).prompt;
    return typeof prompt === "string" ? prompt : undefined;
}

/** The node a tool names. Every tool that takes a `nodeId` asks this, so they all answer a miss alike. */
function namedNode(hands: CanvasHands, args: unknown): CanvasNodeData | undefined {
    const nodeId = nodeIdOf(args);
    return hands.nodes().find((candidate) => candidate.id === nodeId);
}

/** The answer for a tool that names a node the canvas does not hold. */
const noSuchNode = (args: unknown): ToolAnswer => ({ content: [textBlock(`no node with id "${nodeIdOf(args)}" on this canvas`)], isError: true });

/**
 * Make one node, the way the user's own button makes one — placed where the view is looking, selected, and
 * with its panel open when that is what pressing the button does.
 *
 * The position a tool states is the node's top-left corner, which is what `list_nodes` reports; the page's
 * own create takes a centre.
 */
function createNode(hands: CanvasHands, args: unknown): ToolAnswer {
    const input = (typeof args === "object" && args ? args : {}) as { type?: unknown; prompt?: unknown; position?: unknown };
    const type = typeof input.type === "string" ? input.type.trim() : "";
    if (!CREATE_TYPES.includes(type)) return { content: [textBlock(`no node type "${type}": this canvas makes ${CREATE_TYPES.join(", ")}`)], isError: true };

    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    // A text node holds its words in `content`; every other node holds a prompt, which its own panel edits.
    const patch: CanvasNodeMetadata | undefined = prompt ? (type === CanvasNodeType.Text ? { content: prompt } : { prompt }) : undefined;
    const corner = readPosition(input.position);
    const centre = corner ? centreOf(type, corner) : undefined;

    const node = hands.createNode(type, centre, patch);
    return { content: [textBlock(`created ${node.id} (${node.type}) at (${Math.round(node.position.x)}, ${Math.round(node.position.y)})`)] };
}

/**
 * Connect two nodes, the way dragging from one handle to the other does — a reference bar pick is the same
 * connection. The pair is stated in order, so the gesture starts from the source handle; the canvas decides
 * whether those two may be connected at all (a group, or a config into a config, may not).
 */
function connect(hands: CanvasHands, args: unknown): ToolAnswer {
    const input = (typeof args === "object" && args ? args : {}) as { fromNodeId?: unknown; toNodeId?: unknown };
    const fromNodeId = typeof input.fromNodeId === "string" ? input.fromNodeId.trim() : "";
    const toNodeId = typeof input.toNodeId === "string" ? input.toNodeId.trim() : "";
    const nodes = hands.nodes();
    const from = nodes.find((candidate) => candidate.id === fromNodeId);
    const to = nodes.find((candidate) => candidate.id === toNodeId);
    if (!from || !to) return { content: [textBlock(`no node with id "${from ? toNodeId : fromNodeId}" on this canvas`)], isError: true };
    if (hands.connections().some((connection) => connection.fromNodeId === from.id && connection.toNodeId === to.id)) {
        return { content: [textBlock(`${from.id} -> ${to.id} is already connected`)], isError: false };
    }
    if (!hands.connectNodes(from.id, to.id, "source")) {
        return { content: [textBlock(`this canvas will not connect ${from.id} (${from.type}) to ${to.id} (${to.type})`)], isError: true };
    }
    return { content: [textBlock(`connected ${from.id} -> ${to.id}${saidTwice(to.id, wordsOf(to), nodes, [...hands.connections(), { id: `${from.id}->${to.id}`, fromNodeId: from.id, toNodeId: to.id }])}`)], isError: false };
}

/**
 * What a node would say twice once this connection exists, in one clause — or nothing to add.
 *
 * The canvas composes a request from the node's own prompt and every text connected to it, so the same
 * words in both places travel twice. Nothing here refuses or edits: the connection is made either way, and
 * the agent is told what it built, in the answer to the call that built it (#203). The words are passed in
 * rather than read back from the node, because a tool that has just written them is answering before the
 * canvas has re-rendered.
 */
function saidTwice(nodeId: string, words: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): string {
    const repeated = repeatedConnectedText(nodeId, words, nodes, connections);
    if (!repeated.length) return "";
    return `; note: ${nodeId} already says ${repeated.join(", ")}'s words in its own prompt, so generating it would send them twice — clear it with set_prompt ""`;
}

/**
 * Write one node's prompt, in the same field the node's own panel writes it to.
 *
 * Changing what a node says and running it again is one gesture in the canvas: the result is replaced in that
 * node (docs/decisions.md #77), not made beside it. A variant is a new node fed through the reference bar,
 * which is what `create_node` plus a connection is — so both intents keep their own tool.
 */
function setPrompt(hands: CanvasHands, args: unknown): ToolAnswer {
    const prompt = promptOf(args);
    if (prompt === undefined) return { content: [textBlock("set_prompt needs a prompt")], isError: true };
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);

    hands.setNodePrompt(node.id, prompt);
    return { content: [textBlock(`the prompt of ${node.id} is now: ${prompt.slice(0, 200)}${saidTwice(node.id, prompt, hands.nodes(), hands.connections())}`)], isError: false };
}

/**
 * Press one node's generate button — the same function the node's own panel presses.
 *
 * It is not waited on: a picture takes minutes, and the tool's job is to start it, not to be the progress
 * bar. The node itself shows what is happening, which is where the user will look anyway — and when the
 * run ends, the agent that asked is told, as a message from the user (docs/decisions.md #225).
 *
 * The session travels with the generation for exactly that: it is the one thing that knows which
 * conversation asked, and the run carries it so the gateway can say how it went long after this answer.
 *
 * The mode is the one the node's own panel would use: a content node generates what it is, and a config node
 * generates the kind its composer is set to (that is what pressing its button does).
 */
function pressGenerate(hands: CanvasHands, args: unknown, session: string): ToolAnswer {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);

    // A content node generates what it is; a config node generates the kind its composer is set to.
    const mode: string = node.type === CanvasNodeType.Config ? node.metadata?.generationMode || "image" : node.type;
    if (!GENERATE_MODES.includes(mode)) return { content: [textBlock(`a ${node.type} node has nothing to generate`)], isError: true };

    void hands.generateNode(node.id, mode as CanvasGenerationMode, wordsOf(node), { session, node: node.id });
    // A text node is answered by its own agent, which writes into the node: there is no run behind it and
    // so nothing to be told about later.
    if (mode === CanvasNodeType.Text) {
        return { content: [textBlock(`pressed generate on ${node.id} (text). The node writes the answer itself as it streams — canvas_read_node it to see how far it has got.`)], isError: false };
    }
    return { content: [textBlock(`pressed generate on ${node.id} (${mode}). It will take a while: you will be sent a message when it finishes, so do not wait for it or poll the node — carry on with something else, or answer me now.`)], isError: false };
}

const GENERATE_MODES: string[] = [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio];

/**
 * Read one node's actual content.
 *
 * What comes back is the node's own stuff, not a description of it: the words it holds, and — for a node
 * that holds a picture, a film or a sound — the media itself, as the block the protocol defines for it.
 * The block carries its type, so the choice of block is the media's, not ours: an image is an image, a
 * sound is a sound, and a film travels as a `resource` blob because the protocol has no video block.
 */
async function readNode(hands: CanvasHands, args: unknown): Promise<ToolAnswer> {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);

    const content: ToolContent[] = [];
    const words = wordsOf(node);
    if (words) content.push(textBlock(words));

    const media = await mediaOf(node);
    if (media) content.push(media);
    if (!content.length) content.push(textBlock(`${node.id} (${node.type}) holds nothing to read`));
    return { content };
}

/** The words a node holds: a text node's body, or the prompt its own panel shows. */
function wordsOf(node: CanvasNodeData): string {
    return (node.metadata?.composerContent ?? node.metadata?.prompt ?? node.metadata?.content ?? node.metadata?.texts?.[0]?.content ?? "").trim();
}

/**
 * Delete one node, the way the Delete key does: the node, and every connection that touched it.
 *
 * It is the page's own delete, so everything a removal means happens with it — the node's panel closes, a
 * group forgets the member — and it becomes one history entry, which is what makes it removable by the same
 * Ctrl+Z as a deletion the user made.
 */
function deleteNode(hands: CanvasHands, args: unknown): ToolAnswer {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);

    const edges = hands.connections().filter((connection) => connection.fromNodeId === node.id || connection.toNodeId === node.id).length;
    hands.deleteNodes([node.id]);
    const connected = edges ? `, and ${edges} connection${edges === 1 ? "" : "s"} that touched it` : "";
    return { content: [textBlock(`deleted ${node.id} (${node.type})${connected}`)], isError: false };
}

/**
 * Select one node and bring it into view, the way clicking its row in the side panel does.
 *
 * The viewport belongs to the user, so this tool is a deliberate act: it is how the agent points at what
 * it changed, or at something the user could not otherwise find on a canvas the agent has grown.
 */
function focusNode(hands: CanvasHands, args: unknown): ToolAnswer {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);

    hands.focusNode(node.id);
    return { content: [textBlock(`selected ${node.id} (${node.type}) and moved the view to it`)], isError: false };
}

/**
 * Move one node so its top-left corner lands where the tool says, the way dragging it there does.
 *
 * It is the same space `list_nodes` and `create_node` speak: canvas coordinates, the corner, not the
 * centre. Nothing else about the node moves — not its prompt, not its result — so a node can be tidied
 * out of the way without being re-run.
 */
function moveNode(hands: CanvasHands, args: unknown): ToolAnswer {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);
    const position = readPosition(argsOf(args).position);
    if (!position) return { content: [textBlock("move_node needs a position: {x, y} in canvas coordinates")], isError: true };

    const corner = { x: Math.round(position.x), y: Math.round(position.y) };
    hands.moveNode(node.id, corner);
    return { content: [textBlock(`moved ${node.id} (${node.type}) to (${corner.x}, ${corner.y})`)], isError: false };
}

/**
 * The most base64 this page will put in one socket message.
 *
 * The gateway refuses a message over 8 MiB and closes the socket when one arrives, and base64 costs a third
 * more than the bytes it carries: a 20 MB generated clip read back through `read_node` used to end the whole
 * conversation, with the agent's next question unanswered and nothing to say why. Above this bound the tool
 * answers with the file's size instead of its bytes — the file is not lost, it is on the canvas.
 */
const MAX_INLINE_MEDIA_BASE64 = 5 * 1024 * 1024;

/** The block a node's media travels in — or nothing, for a node that holds no media. */
async function mediaOf(node: CanvasNodeData): Promise<ToolContent | undefined> {
    if (!MEDIA_TYPES.includes(node.type)) return undefined;
    const dataUrl = await dataUrlOf(node);
    if (!dataUrl) return undefined;
    const parsed = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
    if (!parsed) return undefined;
    const mimeType = node.metadata?.mimeType || parsed[1];
    const data = parsed[2];
    if (data.length > MAX_INLINE_MEDIA_BASE64) {
        return textBlock(`${node.id} holds a ${mimeType} of about ${formatBytes(Math.round((data.length * 3) / 4))}, which is too large to hand over through this socket; the file itself is on the canvas and the user can open it`);
    }
    // A film has no block of its own in the protocol; it travels as a resource whose mimeType says what it is.
    return node.type === CanvasNodeType.Video ? { type: "resource", resource: { uri: `canvas://${node.id}`, mimeType, blob: data } } : { type: node.type === CanvasNodeType.Audio ? "audio" : "image", data, mimeType };
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
    return `${bytes} bytes`;
}

const MEDIA_TYPES: string[] = [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio];

/** A node's media as a data URL, however it is stored: an uploaded file in the page's own store, or a URL. */
async function dataUrlOf(node: CanvasNodeData): Promise<string> {
    const content = node.metadata?.content || "";
    const storageKey = node.metadata?.storageKey;
    if (content.startsWith("data:")) return content;
    if (node.type === CanvasNodeType.Image) return imageToDataUrl({ url: content, storageKey });
    const url = await resolveMediaUrl(storageKey, content);
    if (!url) return "";
    if (url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(url)).blob());
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("the file could not be read"));
        reader.readAsDataURL(blob);
    });
}

/** Where the node's centre has to be for its top-left corner to land where the tool asked. */
function centreOf(type: string, corner: Position): Position {
    const spec = getNodeSpec(type);
    return { x: corner.x + spec.width / 2, y: corner.y + spec.height / 2 };
}

function readPosition(value: unknown): Position | undefined {
    if (typeof value !== "object" || !value) return undefined;
    const { x, y } = value as { x?: unknown; y?: unknown };
    return typeof x === "number" && typeof y === "number" ? { x, y } : undefined;
}

/**
 * The whole canvas as text: every node with the id a tool call can act on, and every edge.
 *
 * One line per node, because a model reads lines and diffs them; nothing is omitted for looking empty,
 * since a node with no prompt is a fact about the canvas too.
 */
function describeCanvas(nodes: CanvasNodeData[], connections: CanvasConnection[]): string {
    const lines = [`${nodes.length} nodes, ${connections.length} connections`];
    for (const node of nodes) {
        const prompt = wordsOf(node).slice(0, 300);
        const title = node.title ? ` "${node.title}"` : "";
        const at = ` at (${Math.round(node.position.x)}, ${Math.round(node.position.y)})`;
        lines.push(`- ${node.id} (${node.type})${title}${at}${prompt ? ` prompt: ${prompt}` : ""}`);
    }
    if (connections.length) lines.push("connections:");
    for (const connection of connections) lines.push(`- ${connection.fromNodeId} -> ${connection.toNodeId}`);
    return lines.join("\n");
}
