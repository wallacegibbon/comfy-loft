import { getNodeSpec } from "@/constant/canvas";
import { NODE_MIN_SIZE, nodeRatio } from "@/lib/canvas/canvas-node-size";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { canGroupSelectedNodes, collectGroupMemberNodes } from "@/lib/canvas/canvas-node-geometry";
import { describeEmptyInputs, inputsHoldingNothing, repeatedConnectedText } from "@/components/canvas/canvas-node-generation";
import { resolveMediaUrl } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import type { ToolContent } from "@/services/api/agent";
import { generateAnswer, type GenerateOptions, type GenerateStart } from "@/lib/canvas/agent-generate";
import { describeCanvas } from "@/lib/canvas/canvas-agent-view";
import { configuredClause, generationClause, requiresClause, type MediaCounts } from "@/lib/canvas/node-generation-facts";
import { nodeContentOf, nodePromptOf } from "@/lib/canvas/node-prompt-field";
import { planNodeSettings, type NodeSettings, type SettingsContract } from "@/lib/canvas/node-settings";
import { describeModelCatalogs, MODEL_CAPABILITIES, planNodeModel, type ModelCapability, type ModelCatalog, type ModelCatalogs } from "@/lib/canvas/node-model";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type Position } from "@/types/canvas";

/**
 * The tools, as functions: one call in, one answer out, against the page's own state.
 *
 * The server advertises the tools and cannot run any of them: it holds the socket, not the nodes. So a
 * call arrives as `{\"type\":\"tool\",\"callId\":…,\"name\":…,\"arguments\":…}` at the canvas hook
 * (`use-canvas-agent-tools`), which hands it to `runTool` and answers on the session it came from.
 *
 * They live here rather than in the hook because they are decisions, not wiring: what `set_text` writes,
 * what a node that is not text answers, where an instruction goes. Tests call them directly.
 */

/**
 * What a move did, as the page can see it: the cards it carried, and every membership its landing changed.
 *
 * Membership is one field on a node, so a change is stated as the group left and the group joined — absent on
 * either end means the canvas itself. A group's members never appear here: they keep the group they travelled
 * with (#316).
 */
export type MoveOutcome = {
    /** The card the tool named, then everything that travelled with it. */
    carried: string[];
    membership: Array<{ nodeId: string; from?: string; to?: string }>;
    /** The groups this move left with nothing in them, which are gone (#317). */
    removed: string[];
};

/** What the page lends a tool: its state to read, the way it makes a node, and the button that runs one. */
export type CanvasHands = {
    nodes: () => CanvasNodeData[];
    connections: () => CanvasConnection[];
    createNode: (type: CanvasNodeTypeId, position?: Position, patch?: CanvasNodeMetadata) => CanvasNodeData;
    generateNode: (nodeId: string, mode: CanvasGenerationMode, prompt: string, options?: GenerateOptions) => Promise<void>;
    setNodePrompt: (nodeId: string, prompt: string) => void;
    /** Write a text node's words, the way editing the card on the canvas does. */
    writeText: (nodeId: string, text: string) => void;
    /**
     * Stop what this node is generating, the way the panel's stop button does — and answer with what that did.
     *
     * The page owns two kinds of run: the one it submitted (whose watch can cancel it as it aborts) and the one
     * it picked up again after a reload (whose watch deliberately does not). So the run is also cancelled by its
     * id, which is the one path every watcher shares; a cancel for a run that has already ended is refused by
     * the node's own record and comes back as `finished`.
     */
    stopNode: (nodeId: string) => Promise<StopOutcome>;
    connectNodes: (firstNodeId: string, secondNodeId: string, firstHandleType: "source" | "target") => boolean;
    /**
     * Delete these nodes, the way the Delete key does, and say which cards went with them.
     *
     * Deleting a group's last member empties it, and a box drawn around nothing is debris the delete itself
     * made — the same rule grouping, ungrouping and moving follow (#318). What is never touched is a card that
     * was already empty before the press.
     */
    deleteNodes: (nodeIds: string[]) => { removed: string[] };
    focusNode: (nodeId: string) => void;
    /**
     * Move one card, and say what travelled and what the landing did to membership.
     *
     * A move is also one of the two ways a node changes groups — dropped on a card it joins it, moved out of
     * the card it was in it leaves — so the answer is what a tool has to report. A group's own members cannot
     * change: they travel with the card (#316). Null when the canvas no longer holds the node.
     */
    moveNode: (nodeId: string, position: Position) => MoveOutcome | null;
    /** Give one card a new size, the way the end of a corner drag does: the top-left corner stays put. */
    resizeNode: (nodeId: string, width: number, height: number) => void;
    /**
     * Wrap these nodes in one group, the way the Group button wraps a selection, and say what it made.
     *
     * The members of a group named here come with it and the old group is absorbed, which is the canvas's
     * own behaviour for a selection that spans groups — so merging two groups is this tool with both ids.
     * Null when there is nothing to wrap.
     */
    groupNodes: (nodeIds: string[]) => { groupId: string; memberIds: string[] } | null;
    /**
     * Release these nodes from their groups, the way Ungroup does: a group named here is dissolved, a member
     * named here leaves, and a group left with no members goes away. Null when nothing was in a group.
     */
    ungroupNodes: (nodeIds: string[]) => { released: string[]; dissolved: string[] } | null;
    /**
     * What the node's model publishes, as a contract: the keys a run accepts, the media it takes, a sound's
     * length bound.
     *
     * Read from the same published list the panel's own rows ask (#304), so a setting this refuses is one the
     * panel would not have offered either — the tool and the UI cannot disagree about what a node takes.
     *
     * `run` is the choice a call is about to make: a size stated beside a new model has to be judged by the
     * contract of the model that will run it, not the one being replaced, and the two are one write. Absent, the
     * question is about the node as it stands.
     */
    nodeContract: (nodeId: string, run?: { model?: string; mode?: string }) => SettingsContract;
    /** Write the fields a call settles on — a setting, or which model runs — the way the panel writes them. */
    writeMetadata: (nodeId: string, patch: CanvasNodeMetadata) => void;
    /**
     * The models one kind of node may be set to, in the picker's own order, and whether a run of one reads a key.
     *
     * Built from the same `workflowModelOptions` the pickers offer, so a model the panel would not show is not
     * a model a caller can name — and the contract answer is the panel's own three-state one (#304). Asked by
     * kind rather than by node, because a question about models does not name a node.
     */
    modelCatalog: (capability: ModelCapability) => ModelCatalog;
};

/** What stopping one node's run did, in the page's own words. */
export type StopOutcome = {
    /** Whether anything was in flight at all: a live watch, or a run the node still names. */
    running: boolean;
    /** What became of the run on the server, when there was one to cancel. */
    cancel?: "cancelled" | "finished" | "unknown";
    /** Why the server could not be asked, when it could not. */
    reason?: string;
};

/** One tool's result: the content blocks the agent reads, and whether it failed rather than did something. */
type ToolAnswer = { content: ToolContent[]; isError?: boolean };

const textBlock = (text: string): ToolContent => ({ type: "text", text });

/** The node types a tool may make: the four that hold content, and the one that holds nodes. */
const CREATE_TYPES: string[] = [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text, CanvasNodeType.Group];

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
        case "read_prompt":
            return readPrompt(hands, args);
        case "read_text":
            return readText(hands, args);
        case "read_media":
            return readMedia(hands, args);
        case "connect":
            return connect(hands, args);
        case "set_prompt":
            return setPrompt(hands, args);
        case "set_text":
            return setText(hands, args);
        case "set_node":
            return setNode(hands, args);
        case "list_models":
            return listModels(hands, args);
        case "generate":
            return pressGenerate(hands, args, session);
        case "stop_node":
            return stopNode(hands, args);
        case "delete_node":
            return deleteNode(hands, args);
        case "focus_node":
            return focusNode(hands, args);
        case "move_node":
            return moveNode(hands, args);
        case "resize_node":
            return resizeNode(hands, args);
        case "group_nodes":
            return groupNodes(hands, args);
        case "ungroup_nodes":
            return ungroupNodes(hands, args);
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
    // A group holds nodes, not words: a prompt on one has no field behind it, so the call is refused rather
    // than quietly answered with a node that is not what was asked for.
    if (type === CanvasNodeType.Group && prompt) {
        return {
            content: [textBlock("a group is a container: it holds nodes, not words, so there is nothing to ask it. Make it without a prompt, or wrap the nodes that exist in one with group_nodes")],
            isError: true,
        };
    }
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
 * Change what a node is made from: a picture's prompt, a film's, a sound's. A text node has none — it holds
 * words and nothing asks it anything — so the call is refused rather than writing a field no surface shows.
 */
function setPrompt(hands: CanvasHands, args: unknown): ToolAnswer {
    const prompt = promptOf(args);
    if (prompt === undefined) return { content: [textBlock("set_prompt needs a prompt")], isError: true };
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);
    if (node.type === CanvasNodeType.Text) {
        return {
            content: [textBlock(`${node.id} is a text node: it holds words and has no prompt, so there is nothing to ask it. Write what it says with set_text — an empty string clears it.`)],
            isError: true,
        };
    }

    hands.setNodePrompt(node.id, prompt);
    return { content: [textBlock(`the prompt of ${node.id} is now: ${prompt.slice(0, 200)}${saidTwice(node.id, prompt, hands.nodes(), hands.connections())}`)], isError: false };
}

/**
 * Write a text node's words, the way editing the card on the canvas does.
 *
 * A text node's content is words, so it is the one node whose content an agent can write directly; for a
 * picture, a film or a sound the same intent is `set_prompt` plus `generate`, because the content there is
 * bytes (#229).
 */
function setText(hands: CanvasHands, args: unknown): ToolAnswer {
    const text = textOf(args);
    if (text === undefined) return { content: [textBlock("set_text needs text: the words the node should say (an empty string clears it)")], isError: true };
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);
    if (node.type !== CanvasNodeType.Text) {
        return { content: [textBlock(`${node.id} is a ${node.type} node: it holds ${heldNoun(node.type)}, so it has no words to write. set_prompt changes what it is made from, and generate makes a new one.`)], isError: true };
    }

    hands.writeText(node.id, text);
    return { content: [textBlock(`${node.id} now says: ${text.slice(0, 300)}`)], isError: false };
}

/** What a node of this kind holds, for the two tools that write and read words to refuse with. */
function heldNoun(type: string): string {
    if (type === CanvasNodeType.Image) return "a picture";
    if (type === CanvasNodeType.Video) return "a film";
    if (type === CanvasNodeType.Audio) return "a sound";
    return "nodes";
}

/**
 * Set what a node's next run is: which workflow and mode it runs, and the shape that run takes.
 *
 * One tool rather than two, because the two halves cannot be set separately and honestly. A size is judged
 * against the workflow that will run it, so the contract read is the *new* model's; and a call that states both
 * must land both or neither — a model change that succeeded followed by a refused size left the user's one
 * sentence half applied, which is a promise two separate tools made and could not keep.
 *
 * The panel's own rules stay where they were: `planNodeModel` resolves names and modes, `planNodeSettings`
 * reads every value and the published contract, and this composes them in the only order that works — the run
 * first, then the shape judged against it.
 *
 * It writes no words. A text node's card is `set_text`'s and the question a media node will be asked is
 * `set_prompt`'s, so a call that mistakes one for a setting is refused rather than quietly written.
 */
function setNode(hands: CanvasHands, args: unknown): ToolAnswer {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);
    // The id names the node; every other key is either which run this is or how that run is shaped, and a key
    // that is neither is refused by the plan rather than ignored, which is what makes a typo an answer.
    const { nodeId: _named, model, mode, ...settings } = argsOf(args) as { nodeId?: unknown; model?: unknown; mode?: unknown } & NodeSettings;

    // Which run this is, first: the shape is judged against it.
    let run: { patch: CanvasNodeMetadata; ran: string; stale: string[] } | undefined;
    if (model !== undefined || mode !== undefined) {
        const plan = planNodeModel(node, { model, mode }, hands.modelCatalog(node.type as ModelCapability));
        if (!plan.ok) return { content: [textBlock(plan.reason)], isError: true };
        run = { patch: plan.patch, ran: plan.mode ? `${plan.model.workflowId} as ${plan.mode}` : plan.model.workflowId, stale: plan.stale };
    }

    const stated = Object.keys(settings).length > 0;
    if (!run && !stated) {
        return { content: [textBlock(`${node.id}: nothing was stated. set_node takes a model, a mode, a size, a length, a quality, a background, a seed, a format, instructions, or params`)], isError: true };
    }

    let patch: CanvasNodeMetadata = run ? run.patch : {};
    let written: string[] = [];
    if (stated) {
        // The node as it will be once the run is chosen: the settings *and* the contract are read off that, so
        // "switch to Qwen's edit mode at 1360x768" is judged by Qwen's keys and lands in one write.
        const chosen = { ...node, metadata: { ...node.metadata, ...patch } };
        const override = run ? { model: String(run.patch.model || ""), mode: String(run.patch.imageMode || run.patch.videoMode || "") } : undefined;
        const plan = planNodeSettings(chosen, settings, hands.nodeContract(node.id, override));
        if (!plan.ok) return { content: [textBlock(plan.reason)], isError: true };
        patch = { ...patch, ...plan.patch };
        written = plan.written;
    }

    hands.writeMetadata(node.id, patch);
    // The settings the new run does not read: still on the node, and dropped by the request, so the caller is
    // told rather than left to discover it when a number stops mattering (#302).
    const dropped = run?.stale.length ? `; this run no longer reads ${run.stale.join(", ")}, and ${run.stale.length === 1 ? "it is" : "they are"} still on the node — the request leaves ${run.stale.length === 1 ? "it" : "them"} out` : "";
    if (run) return { content: [textBlock(`${node.id} now runs ${run.ran}${written.length ? `, set ${written.join(", ")}` : ""}${dropped}`)], isError: false };
    // The clause is the read-back: a setting can be written and still not be the one a run uses (a seed with no
    // `seedFixed`, say), and `read_node` is what says which.
    const clause = configuredClause({ ...node.metadata, ...patch });
    return { content: [textBlock(`set ${written.join(", ")} on ${node.id}${clause ? `; it is now ${clause}` : ""}`)], isError: false };
}

/**
 * Stop what a node is generating — the panel's stop button, without the question before it.
 *
 * The panel asks "are you sure?" because a stop throws away work in progress and the press is one keystroke
 * away; a call *is* the sure part, so this asks nobody and does it. What it must not do is claim more than it
 * did: a run the server has already finished cannot be cancelled back into existence, and a server that did not
 * answer leaves a run possibly still rendering — both are said, and the second is a failed call, because the
 * caller asked for the run to stop and cannot be told that it did.
 *
 * The node keeps what it held before the run started: a stop is not a delete, and the picture that was there is
 * still there.
 */
async function stopNode(hands: CanvasHands, args: unknown): Promise<ToolAnswer> {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);
    if (!GENERATE_MODES.includes(node.type)) {
        const what = node.type === CanvasNodeType.Text ? "it holds words and nothing generates them" : "nothing generates it";
        return { content: [textBlock(`${node.id} is a ${node.type} node: ${what}, so there is nothing to stop`)], isError: true };
    }

    const outcome = await hands.stopNode(node.id);
    if (!outcome.running) return { content: [textBlock(`${node.id} is not generating: there was nothing to stop`)], isError: false };
    if (!outcome.cancel) {
        // A press caught before it submitted: no run exists, so nothing was thrown away, and the node is idle.
        return { content: [textBlock(`stopped ${node.id} before it reached the server: nothing had been submitted, and the node is idle again`)], isError: false };
    }
    if (outcome.cancel === "finished") {
        return { content: [textBlock(`${node.id} was generating, and its run had already ended by the time the stop arrived: the node is idle again`)], isError: false };
    }
    if (outcome.cancel === "unknown") {
        const why = outcome.reason ? ` (${outcome.reason})` : "";
        return {
            content: [textBlock(`stopped watching ${node.id}, but the server did not confirm the cancel${why}: the run may still be rendering there, and this node will not pick it up again. The canvas is free of it either way; the work is not`)],
            isError: true,
        };
    }
    return { content: [textBlock(`stopped ${node.id}: the run was cancelled and the node is idle again, holding what it held before`)], isError: false };
}

/**
 * What this canvas can run, by kind — the question no tool could answer.
 *
 * Every model name an agent had seen came from a node that already had one, so "how many image models are
 * there" was answered by reciting the canvas: an upscaler counted among the generators, two workflows missing
 * because nothing on screen used them, and an honest admission that the list was not complete. The list is
 * data the page already holds (the pickers' own), and this is it said once, grouped by what a workflow makes,
 * with steps on their own line because they are not what a prompt makes.
 *
 * `capability` narrows it to one kind; without it the answer is all three, which is the shape a question about
 * "models" usually has.
 */
function listModels(hands: CanvasHands, args: unknown): ToolAnswer {
    const asked = argsOf(args).capability;
    if (asked !== undefined && typeof asked !== "string") return { content: [textBlock("capability needs one of image, video, audio — or leave it out for all three")], isError: true };
    const wanted = typeof asked === "string" ? asked.trim().toLowerCase() : "";
    if (wanted && !MODEL_CAPABILITIES.includes(wanted as ModelCapability)) {
        return { content: [textBlock(`${wanted} is not a kind of content this canvas makes: ${MODEL_CAPABILITIES.join(", ")}`)], isError: true };
    }
    const catalogs = {} as ModelCatalogs;
    for (const capability of wanted ? [wanted as ModelCapability] : MODEL_CAPABILITIES) catalogs[capability] = hands.modelCatalog(capability);
    return { content: [textBlock(describeModelCatalogs(catalogs))], isError: false };
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
 * knows which conversation asked, and the run carries it so the server can say how it went.
 *
 * The mode is the one the node's own panel would use: a node generates what it is. A text node generates
 * nothing, so it is refused here rather than pressed.
 */
async function pressGenerate(hands: CanvasHands, args: unknown, session: string): Promise<ToolAnswer> {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);

    // A node generates what it is.
    const mode: string = node.type;
    if (mode === CanvasNodeType.Text) {
        return { content: [textBlock(`${node.id} is a text node: it holds words, and nothing generates them. Write what it should say with set_text — that is the same thing as editing the card on the canvas.`)], isError: true };
    }
    if (!GENERATE_MODES.includes(mode)) return { content: [textBlock(`a ${node.type} node has nothing to generate`)], isError: true };

    // Ask the question the page is about to ask, before pressing. A wire into a node that holds nothing
    // carries nothing (#230), and the page refuses a press like that — so the refusal is stated here too,
    // in the same words, rather than the agent being told a run is out when none was started.
    const blocked = inputsHoldingNothing(node.id, hands.nodes(), hands.connections());
    if (blocked.length) return { content: [textBlock(describeEmptyInputs(blocked))], isError: true };

    const start = await press(hands, node.id, mode as CanvasGenerationMode, nodePromptOf(node), session);
    // A refusal is a failed call: the agent asked for something that did not happen, and a quiet success
    // would leave it waiting for a message that will never come.
    return { content: [textBlock(generateAnswer(node.id, mode, start))], isError: start.started === false };
}

/**
 * Press generate, and answer with the press's own word: a run is out, or it did not start and why.
 *
 * No clock of its own. A press that is slow is a press the agent waits for, and a page that never answers at
 * all is answered by the bridge's own timeout — a third sentence here, promising news either way, is what
 * made a simple question need a promise, a keeper and a ledger (#285).
 */
function press(hands: CanvasHands, nodeId: string, mode: CanvasGenerationMode, words: string, session: string): Promise<GenerateStart> {
    return new Promise((resolve) => {
        // A press that fails on its way to a run is a refusal with the page's own reason; a promise the page
        // rejects is the same thing, and silence would leave the agent waiting.
        void hands.generateNode(nodeId, mode, words, { askedBy: { session, node: nodeId }, onStart: resolve }).catch((error: unknown) => resolve({ started: false, reason: error instanceof Error ? error.message : String(error) }));
    });
}

const GENERATE_MODES: string[] = [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio];

/**
 * Read what a node's next run is set to: the workflow and mode it runs, and the shape that run takes.
 *
 * The reader that pairs with `set_node`: every field that tool writes is stated here, in the same words
 * (`configuredClause`, the one place they are worded), plus what a press would still need — a configuration
 * that cannot run yet is worth knowing about before it is pressed.
 *
 * It carries no words and no bytes. A card is `read_text`'s, the question a node will be asked is
 * `read_prompt`'s, the picture is `read_media`'s; and what a node *did* — the state of its run, and what made
 * its content — is on the `list_nodes` line, with the caption `read_media` sends. One question, one reader.
 */
function readNode(hands: CanvasHands, args: unknown): ToolAnswer {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);
    if (node.type === CanvasNodeType.Text) {
        return { content: [textBlock(`${node.id} is a text node and has no run to configure: nothing asks it anything. What it says is its content, which read_text answers with and set_text writes`)], isError: false };
    }
    if (!GENERATE_MODES.includes(node.type)) {
        return { content: [textBlock(`${node.id} is a ${node.type} node and runs nothing: ${node.type === CanvasNodeType.Group ? "it holds nodes, not content" : "a LoRA node names a stack its own panel picks"}`)], isError: false };
    }

    const clause = configuredClause(node.metadata);
    const parts: string[] = [clause ? `${node.id} (${node.type}) is ${clause}` : `${node.id} (${node.type}) is not set to run anything: no model has been picked for it`];
    // What a press would need and what is wired in front of it: the half of a run a configuration cannot state.
    const requirement = requiresClause(hands.nodeContract(node.id).media, connectedMedia(node.id, hands));
    if (requirement) parts.push(`${node.id} ${requirement}.`);
    return { content: [textBlock(parts.join("\n"))], isError: false };
}

/**
 * Read a text node's card: the words it holds, whole.
 *
 * The reader that pairs with `set_text`, and with nothing else. A picture's words are the question it will be
 * asked (`read_prompt`) and its content is the picture itself (`read_media`), so neither is here. `list_nodes`
 * shows the first 300 characters of every card, which is a glance across the canvas; this is the card.
 */
function readText(hands: CanvasHands, args: unknown): ToolAnswer {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);
    if (node.type !== CanvasNodeType.Text) {
        return {
            content: [
                textBlock(
                    `${node.id} is a ${node.type} node: it holds ${heldNoun(node.type)}, not words. ${node.type === CanvasNodeType.Group ? "A group holds nodes, and the members are on its own list line" : "What it holds is read_media's, and what it will be asked is read_prompt's"}`,
                ),
            ],
            isError: true,
        };
    }
    const words = nodeContentOf(node);
    if (!words) return { content: [textBlock(`${node.id} says nothing yet: set_text writes what it should say`)], isError: false };
    return { content: [textBlock(words)], isError: false };
}

/**
 * Read a node's media: the picture, the film or the sound itself, as the block the protocol defines for it.
 *
 * The block carries its type, so the choice of block is the media's, not ours: an image is an image, a sound is
 * a sound, and a film travels as a `resource` blob because the protocol has no video block. It arrives with one
 * line naming the node and what made it — the caption a picture has in a book, and the answer to the question a
 * model cannot ask: "was this drawn by the model I am about to blame, or by another one, an hour ago?" — because
 * a picture alone does not say which of five candidates it is.
 *
 * This is the one read that costs anything, which is why it is the one read with its own name. Everything an
 * agent usually asks about a node — its words, its question, its settings — is answered in hundreds of bytes; a
 * single tool that answered both was read 20 times for 54.9 MiB in one session, 99.7% of the conversation.
 */
async function readMedia(hands: CanvasHands, args: unknown): Promise<ToolAnswer> {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);
    if (!MEDIA_TYPES.includes(node.type)) {
        return { content: [textBlock(`${node.id} is a ${node.type} node and holds no media: ${node.type === CanvasNodeType.Text ? "its words are read_text's" : "a group holds nodes, and a LoRA node a stack"}`)], isError: true };
    }
    const media = await mediaOf(node);
    if (!media) return { content: [textBlock(`${node.id} (${node.type}) holds no media yet: no run has put one in it`)], isError: true };
    const clause = generationClause(node.metadata);
    return { content: [media, textBlock(`${node.id} (${node.type})${clause ? ` ${clause}` : ""}`)] };
}

/**
 * Read the words a node will be asked — the prompt its own panel shows, and the words `set_prompt` writes.
 *
 * One of the three readers that replaced a single over-full `read_node`: the card is `read_text`'s, the settings
 * are `read_node`'s, and this answers with the words and nothing else. A text node has no prompt at all, and says
 * so, pointing at its card; a node nobody has asked anything of has no prompt either, and that is the answer too.
 */
function readPrompt(hands: CanvasHands, args: unknown): ToolAnswer {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);
    if (node.type === CanvasNodeType.Text) {
        return { content: [textBlock(`${node.id} (text) has no prompt: it holds words, and nothing asks it anything. What it says is its content, which read_text answers with, and set_text writes.`)], isError: false };
    }
    const words = nodePromptOf(node);
    if (!words.trim()) return { content: [textBlock(`${node.id} (${node.type}) has no prompt: nothing has been asked of it yet`)], isError: false };
    return { content: [textBlock(words)], isError: false };
}

/** What is wired into one node, one count per kind — the state a run's media requirement is read against. */
function connectedMedia(nodeId: string, hands: CanvasHands): MediaCounts {
    const counts: MediaCounts = { image: 0, video: 0, audio: 0 };
    for (const connection of hands.connections()) {
        if (connection.toNodeId !== nodeId) continue;
        const source = hands.nodes().find((candidate) => candidate.id === connection.fromNodeId);
        if (source && source.type in counts) counts[source.type as keyof MediaCounts] += 1;
    }
    return counts;
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
    const done = hands.deleteNodes([node.id]);
    const connected = edges ? `, and ${edges} connection${edges === 1 ? "" : "s"} that touched it` : "";
    const emptied = done.removed.length ? `; removed ${done.removed.join(", ")}, which the delete left empty` : "";
    return { content: [textBlock(`deleted ${node.id} (${node.type})${connected}${emptied}`)], isError: false };
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
 * Move one card so its top-left corner lands where the tool says, the way dragging it there does.
 *
 * It is the same space `list_nodes` and `create_node` speak: canvas coordinates, the corner, not the
 * centre. Nothing else about the node moves — not its prompt, not its result — so a node can be tidied
 * out of the way without being re-run.
 *
 * A group is a box drawn around nodes, so moving one carries its members: the card and what it holds are one
 * thing to move, and a box that travelled alone would be drawn around nothing. The answer says how many came
 * with it, because that is the difference between tidying a group and scattering one.
 *
 * A node that travels alone is also how membership changes without the two structure tools — dropped on a card
 * it joins it, drawn out of the card it was in it leaves — so the answer names that too. The agent's only view
 * of the canvas is what these answers say, and a node that silently changed groups is one it will reason about
 * wrongly next call (#317).
 */
function moveNode(hands: CanvasHands, args: unknown): ToolAnswer {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);
    const position = readPosition(argsOf(args).position);
    if (!position) return { content: [textBlock("move_node needs a position: {x, y} in canvas coordinates")], isError: true };

    const corner = { x: Math.round(position.x), y: Math.round(position.y) };
    const done = hands.moveNode(node.id, corner);
    if (!done) return { content: [textBlock(`nothing was moved: this canvas no longer holds ${node.id}`)], isError: true };
    // What came along, from the canvas's own rule (`withGroupMembers`): the card named, then its members.
    const carried = done.carried.length - 1;
    const carriedClause = carried > 0 ? ` and its ${carried} member${carried === 1 ? "" : "s"}` : "";
    return { content: [textBlock(`moved ${node.id} (${node.type})${carriedClause} to (${corner.x}, ${corner.y})${moveClause(done.membership, done.removed)}`)], isError: false };
}

/**
 * The membership a move changed and the cards it took away, in the answer's own words.
 *
 * Stated by group rather than by node, because that is the fact: the moved node is the sentence's subject
 * already, and "left g1, joined g2" is what a reader does with it. A node that changed nothing gets no
 * clause, so the common answer stays as short as it was.
 *
 * A card the move emptied is deleted (`withoutEmptiedGroups`), and that is said in the same breath as the
 * leaving — "left g1, removed because nothing was left in it" is one event, not two. Said out loud at all for
 * the same reason membership is: the agent's picture of the canvas is built from these answers, and a card
 * that vanishes between two calls without a word is a wrong picture it will act on.
 */
function moveClause(membership: MoveOutcome["membership"], removed: string[]): string {
    const gone = new Set(removed);
    const left = [...new Set(membership.filter((change) => change.from && change.from !== change.to).map((change) => change.from as string))];
    const joined = [...new Set(membership.filter((change) => change.to && change.to !== change.from).map((change) => change.to as string))];
    const parts = left.map((groupId) => (gone.has(groupId) ? `left ${groupId}, removed because nothing was left in it` : `left ${groupId}`));
    if (joined.length) parts.push(`joined ${joined.join(", ")}`);
    // A group emptied without the moved node leaving it cannot happen today (a card travels with its members);
    // kept so the sentence still holds if some future move empties one another way.
    const besides = removed.filter((groupId) => !left.includes(groupId));
    if (besides.length) parts.push(`removed ${besides.join(", ")}, which the move left empty`);
    return parts.length ? `; ${parts.join(", ")}` : "";
}

/**
 * Give one card a new size, the way the end of a corner drag does — from that same corner, so a resize never
 * moves a node that was just placed.
 *
 * A card that frames a picture or a film is that picture's shape (docs/decisions.md #264), so it has one
 * degree of freedom: the width is the number to state, and the height follows. Stating both is allowed and
 * checked — a pair that disagrees with the picture's shape is refused with the height that would fit, because
 * the alternative is a call that silently does something other than what it said. A card holding words, a
 * sound or a group is free in both directions, and a height left out keeps the one it has.
 *
 * What this is *not* is a zoom. A card is measured in canvas coordinates, so making one bigger does not make
 * the user see it better — `focus_node` is the tool for that, and the answer says so when the request is
 * suspiciously small or the card is off-screen? no: it says nothing it cannot know. The description carries
 * the distinction, once, where the agent reads it before calling.
 */
function resizeNode(hands: CanvasHands, args: unknown): ToolAnswer {
    const node = namedNode(hands, args);
    if (!node) return noSuchNode(args);
    const size = readSize(argsOf(args));
    if (!size) return { content: [textBlock("resize_node needs a size: {width} or {width, height} in canvas pixels")], isError: true };

    const locked = Boolean(getNodeDefinition(node.type)?.keepsAspectRatio);
    const shape = shapeOf(node);
    if (locked) {
        // One degree of freedom, and a floor that is not the same on both sides: a card this shape cannot go
        // under the height floor, which for a wide picture is a larger width than the floor itself.
        const ratio = nodeRatio(node);
        const minimumWidth = Math.max(NODE_MIN_SIZE.width, Math.ceil(NODE_MIN_SIZE.height * ratio));
        const width = Math.round(size.width);
        if (width < minimumWidth) {
            return { content: [textBlock(`${node.id} cannot be narrower than ${minimumWidth}: ${shape}, and a card is never shorter than ${NODE_MIN_SIZE.height}`)], isError: true };
        }
        const height = Math.round(width / ratio);
        if (size.height !== undefined && Math.abs(Math.round(size.height) - height) > 1) {
            return { content: [textBlock(`${node.id} keeps its shape ${shape}, so ${width} wide is ${height} high — state that, or change only the width`)], isError: true };
        }
        hands.resizeNode(node.id, width, height);
        return { content: [textBlock(`resized ${node.id} (${node.type}) to ${width}×${height}, keeping its shape ${shape}; its top-left corner is still (${Math.round(node.position.x)}, ${Math.round(node.position.y)})`)], isError: false };
    }

    const width = Math.round(size.width);
    const height = Math.round(size.height ?? node.height);
    if (width < NODE_MIN_SIZE.width || height < NODE_MIN_SIZE.height) {
        return { content: [textBlock(`${node.id} cannot be smaller than ${NODE_MIN_SIZE.width}×${NODE_MIN_SIZE.height}`)], isError: true };
    }
    hands.resizeNode(node.id, width, height);
    return { content: [textBlock(`resized ${node.id} (${node.type}) to ${width}×${height}; its top-left corner is still (${Math.round(node.position.x)}, ${Math.round(node.position.y)})`)], isError: false };
}

/** A card's shape in words: the picture's own pixels when they are known, else the shape the card has now. */
function shapeOf(node: CanvasNodeData) {
    const { naturalWidth, naturalHeight } = node.metadata || {};
    if (naturalWidth && naturalHeight) return `${naturalWidth}×${naturalHeight}`;
    return `${Math.round(node.width)}×${Math.round(node.height)} now`;
}

/** The size a resize asks for, or nothing when it asked for neither number. */
function readSize(args: Record<string, unknown>): { width: number; height?: number } | undefined {
    const value = args.size;
    if (typeof value !== "object" || !value) return undefined;
    const { width, height } = value as { width?: unknown; height?: unknown };
    if (typeof width !== "number" || !Number.isFinite(width)) return undefined;
    if (height !== undefined && (typeof height !== "number" || !Number.isFinite(height))) return undefined;
    return { width, height };
}

/**
 * The ids a group tool names: the array as given, without blanks or repeats.
 *
 * Both group tools take a set rather than one id, because both are about a relation between nodes.
 */
function nodeIdsOf(args: unknown): string[] | undefined {
    const value = argsOf(args).nodeIds;
    if (!Array.isArray(value)) return undefined;
    const ids = [
        ...new Set(
            value
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim())
                .filter(Boolean),
        ),
    ];
    return ids.length ? ids : undefined;
}

/** The answer for a tool that named ids the canvas does not hold. */
function noSuchNodes(missing: string[]): ToolAnswer {
    const names = missing.map((nodeId) => `"${nodeId}"`).join(", ");
    return { content: [textBlock(`no node with id ${names} on this canvas`)], isError: true };
}

/**
 * Wrap nodes in one group — the Group button, given ids instead of the live selection.
 *
 * A group is structure and not content, which is why `create_node` refuses one: there is no group to make out
 * of nothing, and no prompt behind it. Nothing about the members changes — they keep their places, their
 * prompts and their results, and the group is a card drawn around them that carries them when it moves.
 *
 * A group named among the ids is absorbed into the new one, which is the canvas's own rule for a selection
 * that spans groups: merging two groups is this tool with both ids.
 */
function groupNodes(hands: CanvasHands, args: unknown): ToolAnswer {
    const nodeIds = nodeIdsOf(args);
    if (!nodeIds) return { content: [textBlock("group_nodes needs nodeIds: the ids list_nodes reported, at least two of them")], isError: true };
    const nodes = hands.nodes();
    const missing = nodeIds.filter((nodeId) => !nodes.some((node) => node.id === nodeId));
    if (missing.length) return noSuchNodes(missing);

    // What would end up in the card: the nodes named, and the members of any group named — the same expansion
    // the canvas makes for a selection that spans groups (`collectGroupMemberNodes`).
    const named = new Set(nodeIds);
    const members = collectGroupMemberNodes(named, nodes);
    if (members.length < 2) {
        return {
            content: [
                textBlock(`nothing was grouped: ${nodeIds.join(", ")} makes ${members.length} member${members.length === 1 ? "" : "s"}, and a group holds at least two. A group named here brings its own members, so name the nodes that should be inside`),
            ],
            isError: true,
        };
    }

    // Everything would be one group already. A second card around the same nodes is the same thing drawn
    // twice, so this names the group they are in and the two ways forward instead of making another one.
    if (!canGroupSelectedNodes(named, nodes)) {
        const groupId = members[0].metadata?.groupId;
        return { content: [textBlock(`${nodeIds.join(", ")} are already one group (${groupId}): nothing to wrap. Name another node to merge into it, or release it with ungroup_nodes`)], isError: true };
    }

    const made = hands.groupNodes(nodeIds);
    if (!made) return { content: [textBlock(`nothing was grouped: the canvas has no group to make out of ${nodeIds.join(", ")}`)], isError: true };
    return { content: [textBlock(`grouped ${made.memberIds.join(", ")} into ${made.groupId}`)], isError: false };
}

/**
 * Release nodes from their groups — the Ungroup button, given ids instead of the live selection.
 *
 * Two shapes, and which one is meant is decided by what the ids name: a group is dissolved and its members
 * stay on the canvas exactly as they were, and a member is taken out of its group. A group left with no
 * members goes away, which is the rule the button follows too. Nothing is deleted but the group's own card —
 * the members, their prompts and their results are untouched, and the connections were never inside it.
 */
function ungroupNodes(hands: CanvasHands, args: unknown): ToolAnswer {
    const nodeIds = nodeIdsOf(args);
    if (!nodeIds) return { content: [textBlock("ungroup_nodes needs nodeIds: a group's id to dissolve it, or the ids of the nodes to take out of theirs")], isError: true };
    const nodes = hands.nodes();
    const missing = nodeIds.filter((nodeId) => !nodes.some((node) => node.id === nodeId));
    if (missing.length) return noSuchNodes(missing);

    const done = hands.ungroupNodes(nodeIds);
    if (!done) return { content: [textBlock(`${nodeIds.join(", ")} ${nodeIds.length === 1 ? "is" : "are"} not in a group: there is nothing to release`)], isError: true };
    const parts: string[] = [];
    if (done.released.length) parts.push(`released ${done.released.join(", ")}`);
    if (done.dissolved.length) parts.push(`removed ${done.dissolved.join(", ")}`);
    return { content: [textBlock(parts.join("; "))], isError: false };
}

/**
 * How much base64 one media answer may carry: 40 MiB, which is about 30 MB of file.
 *
 * Not a taste: a tool answer is one WebSocket message, and its bound is the agent's frame bound
 * (`internal/agent.MaxFrameSize` — `internal/ws.maxMessage` is pinned to the same number, and base64 costs
 * a third on top). The limit is a wire budget, so the only honest refusal is "bigger than one frame", which
 * no picture is: scaling a picture down for the model is AlayaCore's business, not this file's.
 */
const MAX_INLINE_MEDIA_BASE64 = 40 * 1024 * 1024;

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
