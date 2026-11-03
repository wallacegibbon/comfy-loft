import { getNodeSpec } from "@/constant/canvas";
import { describeEmptyInputs, inputsHoldingNothing, repeatedConnectedText } from "@/components/canvas/canvas-node-generation";
import { resolveMediaUrl } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import type { ToolContent } from "@/services/api/agent";
import { generateAnswer, GENERATE_START_WAIT_MS, type GenerateOptions, type GenerateStart } from "@/lib/canvas/agent-generate";
import { describeCanvas } from "@/lib/canvas/canvas-agent-view";
import { generationClause } from "@/lib/canvas/node-generation-facts";
import { nodeContentOf, nodeOtherTextsOf, nodePromptOf } from "@/lib/canvas/node-prompt-field";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type Position } from "@/types/canvas";

/**
 * The tools, as functions: one call in, one answer out, against the page's own state.
 *
 * The gateway advertises the tools and cannot run any of them: it holds the socket, not the nodes. So a
 * call arrives as `{\"type\":\"tool\",\"callId\":…,\"name\":…,\"arguments\":…}` at the canvas hook
 * (`use-canvas-agent-tools`), which hands it to `runTool` and answers on the session it came from.
 *
 * They live here rather than in the hook because they are decisions, not wiring: what `set_text` writes,
 * what a node that is not text answers, where an instruction goes. Tests call them directly.
 */

/** What the page lends a tool: its state to read, the way it makes a node, and the button that runs one. */
export type CanvasHands = {
    nodes: () => CanvasNodeData[];
    connections: () => CanvasConnection[];
    createNode: (type: CanvasNodeTypeId, position?: Position, patch?: CanvasNodeMetadata) => CanvasNodeData;
    generateNode: (nodeId: string, mode: CanvasGenerationMode, prompt: string, options?: GenerateOptions) => Promise<void>;
    setNodePrompt: (nodeId: string, prompt: string) => void;
    /** Write a text node's words, the way editing the card on the canvas does. */
    writeText: (nodeId: string, text: string) => void;
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

export async function runTool(name: string, args: unknown, hands: CanvasHands, session: string): Promise<ToolAnswer> {
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
        case "set_text":
            return setText(hands, args);
        case "generate":
            return pressGenerate(hands, args, session);
        case "delete_node":
            return deleteNode(hands, args);
        case "focus_node":
            return focusNode(hands, args);
        case "move_node":
            return moveNode(hands, args);
        default:
            // Not "no such tool": the tool list the agent was handed is the server's, and this switch is the
            // page's, so a name missing here is a page older than its own tools. Saying which is what makes
            // the failure fixable — an agent told only "no such tool" retries, or works around a bug that is
            // not there (#230).
            return {
                content: [textBlock(`no tool called ${name} on this canvas: the page in front of the user was built before the tool list you were given. Ask them to reload it — if it still does not know ${name}, the frontend needs rebuilding`)],
                isError: true,
            };
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

/** The words a `set_text` call wants the card to say. */
function textOf(args: unknown): string | undefined {
    const text = argsOf(args).text;
    return typeof text === "string" ? text : undefined;
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
    return { content: [textBlock(`connected ${from.id} -> ${to.id}${saidTwice(to.id, nodePromptOf(to), nodes, [...hands.connections(), { id: `${from.id}->${to.id}`, fromNodeId: from.id, toNodeId: to.id }])}`)], isError: false };
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
 *
 * On a text node this is the question, not the answer: the panel's box is what the node will be asked to
 * write, and the card is what it wrote. The answer says so, because an agent that is told "the prompt of
 * text-1 is now …" and nothing else reasonably concludes it has changed the text (#229).
 */
function setPrompt(hands: CanvasHands, args: unknown): ToolAnswer {
    const prompt = promptOf(args);
    if (prompt === undefined) return { content: [textBlock("set_prompt needs a prompt")], isError: true };
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);

    hands.setNodePrompt(node.id, prompt);
    const isQuestion = node.type === CanvasNodeType.Text && Boolean(nodeContentOf(node));
    const note = isQuestion ? ` — that is the question ${node.id} will answer next, not its text: what it says now is unchanged. Use set_text to write the text itself, or generate to have it answer again` : "";
    return { content: [textBlock(`the prompt of ${node.id} is now: ${prompt.slice(0, 200)}${note}${saidTwice(node.id, prompt, hands.nodes(), hands.connections())}`)], isError: false };
}

/**
 * Write a text node's words, the way editing the card on the canvas does.
 *
 * A text node's content is words, so it is the one node whose content an agent can write directly; for a
 * picture, a film or a sound the same intent is `set_prompt` plus `generate`, because the content there is
 * bytes (#229). The prompt is left alone: it is the question that made the words, and rewriting the answer
 * by hand does not make that question untrue — it is still what was last asked.
 */
function setText(hands: CanvasHands, args: unknown): ToolAnswer {
    const text = textOf(args);
    if (text === undefined) return { content: [textBlock("set_text needs text: the words the node should say (an empty string clears it)")], isError: true };
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);
    if (node.type !== CanvasNodeType.Text) {
        const holds = node.type === CanvasNodeType.Image ? "a picture" : node.type === CanvasNodeType.Video ? "a film" : node.type === CanvasNodeType.Audio ? "a sound" : "no text";
        return { content: [textBlock(`${node.id} is a ${node.type} node: it holds ${holds}, so it has no words to write. set_prompt changes what it is made from, and generate makes a new one.`)], isError: true };
    }

    hands.writeText(node.id, text);
    return { content: [textBlock(`${node.id} now says: ${text.slice(0, 300)}`)], isError: false };
}

/**
 * Press one node's generate button — the same function the node's own panel presses.
 *
 * The run is not waited on: a picture takes minutes, and the tool's job is to start it, not to be the
 * progress bar. What *is* waited on is whether it started at all, because that is what the agent's next
 * move depends on: a run that is out means a message will come when it ends, and a refusal means there is
 * nothing to wait for and why (docs/decisions.md #225). The answer is therefore built from the page's own
 * word — a run id, or a reason — not from the absence of an error.
 *
 * The session travels with the generation for the message that comes later: it is the one thing that
 * knows which conversation asked, and the run carries it so the gateway can say how it went.
 *
 * The mode is the one the node's own panel would use: a content node generates what it is, and a config node
 * generates the kind its composer is set to (that is what pressing its button does).
 */
async function pressGenerate(hands: CanvasHands, args: unknown, session: string): Promise<ToolAnswer> {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);

    // A content node generates what it is; a config node generates the kind its composer is set to.
    const mode: string = node.type === CanvasNodeType.Config ? node.metadata?.generationMode || "image" : node.type;
    if (!GENERATE_MODES.includes(mode)) return { content: [textBlock(`a ${node.type} node has nothing to generate`)], isError: true };

    // Ask the question the page is about to ask, before pressing. A wire into a node that holds nothing
    // carries nothing (#230), and the page refuses a press like that — but a text node's press reports
    // nothing back at all (it streams, so there is no run id to report), and the agent would be told an
    // answer was on its way when nothing was started. The rule is one function, asked here as well.
    const blocked = inputsHoldingNothing(node.id, hands.nodes(), hands.connections());
    if (blocked.length) return { content: [textBlock(describeEmptyInputs(blocked))], isError: true };

    // A text node is answered by its own agent, which writes into the node: there is no run behind it and
    // so nothing to be told about later.
    if (mode === CanvasNodeType.Text) {
        void hands.generateNode(node.id, mode as CanvasGenerationMode, nodePromptOf(node));
        return { content: [textBlock(`pressed generate on ${node.id} (text). The node writes the answer itself as it streams — canvas_read_node it to see how far it has got.`)], isError: false };
    }

    const start = await pressAndWait(hands, node.id, mode as CanvasGenerationMode, nodePromptOf(node), session);
    // A refusal is a failed call: the agent asked for something that did not happen, and a quiet success
    // would leave it waiting for a message that will never come.
    return { content: [textBlock(generateAnswer(node.id, mode, start))], isError: start?.started === false };
}

/**
 * Press generate, and answer with the first word about the run — or with nothing, if it takes too long.
 *
 * The wait is bounded because the agent is holding a turn open on this answer, and because a press that is
 * slow to report is not the same thing as a press that failed (`generateAnswer` says so in its own words).
 */
function pressAndWait(hands: CanvasHands, nodeId: string, mode: CanvasGenerationMode, words: string, session: string): Promise<GenerateStart | undefined> {
    return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (start: GenerateStart | undefined) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(start);
        };
        timer = setTimeout(() => finish(undefined), GENERATE_START_WAIT_MS);
        // A press that fails on its way to a run is a refusal with the page's own reason; a promise the
        // page rejects is the same thing, and silence would leave the agent waiting.
        void hands.generateNode(nodeId, mode, words, { askedBy: { session, node: nodeId }, onStart: finish }).catch((error: unknown) => finish({ started: false, reason: error instanceof Error ? error.message : String(error) }));
    });
}

const GENERATE_MODES: string[] = [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio];

/**
 * Read one node's actual content.
 *
 * What comes back is the node's own stuff, not a description of it: the words it holds, and — for a node
 * that holds a picture, a film or a sound — the media itself, as the block the protocol defines for it.
 * The block carries its type, so the choice of block is the media's, not ours: an image is an image, a
 * sound is a sound, and a film travels as a `resource` blob because the protocol has no video block.
 *
 * A node something made ends with one line saying what made it and when — the caption a picture would have
 * in a book, and the answer to the question a model cannot ask: "was this drawn by the model I am about to
 * blame, or by another one, an hour ago?" (#227).
 */
async function readNode(hands: CanvasHands, args: unknown): Promise<ToolAnswer> {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);

    const content: ToolContent[] = [];
    // What the node holds. A text node holds words; a batch holds several, and the card is only showing
    // one of them — dropping the rest would be this module's own mistake in miniature (#229).
    const words = nodeContentOf(node);
    if (words) content.push(textBlock(words));
    for (const other of nodeOtherTextsOf(node)) content.push(textBlock(other));

    const media = await mediaOf(node);
    if (media) content.push(media);
    if (!content.length) content.push(textBlock(`${node.id} (${node.type}) holds nothing to read`));
    const clause = generationClause(node.metadata);
    if (clause) content.push(textBlock(`${node.id} (${node.type}) ${clause}`));
    return { content };
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
