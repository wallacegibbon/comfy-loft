import { generationClause, runClause } from "@/lib/canvas/node-generation-facts";
import { nodeContentOf } from "@/lib/canvas/node-prompt-field";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

/**
 * The whole canvas as text: every node with the id a tool call can act on, and every edge.
 *
 * One line per node, because a model reads lines and diffs them. What a line carries is what the node
 * *holds* — `content:` — and nothing else: the prompt is what the node was asked, a private word until
 * someone reads it on purpose with `read_prompt` (#233). Printing it here meant every list carried a copy
 * of every node's words twice, and it put a field with two meanings back into the one place #229 had just
 * cleaned up.
 *
 * What made a node's content and when is on that line, before the words: a canvas of a dozen pictures is
 * exactly where "which model drew this one" is a question, and asking it node by node would cost a
 * `read_node` and a picture's bytes each time (#227).
 *
 * A group is the one relation the flat list could not show, and it is shown from both ends (see
 * `groupClause`): the canvas draws groups as containers, so a list that named them without saying what they
 * hold described a box and not the thing in it.
 */
export function describeCanvas(nodes: CanvasNodeData[], connections: CanvasConnection[]): string {
    const lines = [`${nodes.length} nodes, ${connections.length} connections`];
    const members = membersByGroup(nodes);
    for (const node of nodes) {
        const title = node.title ? ` "${node.title}"` : "";
        const at = ` at (${Math.round(node.position.x)}, ${Math.round(node.position.y)}), ${Math.round(node.width)}×${Math.round(node.height)}`;
        const picture = pictureClause(node);
        const made = generationClause(node.metadata);
        const running = runClause(node.metadata);
        const content = oneLine(nodeContentOf(node));
        lines.push(`- ${node.id} (${node.type})${title}${at}${picture}${groupClause(node, members)}${running ? ` [${running}]` : ""}${made ? ` ${made}` : ""}${content ? ` content: ${content}` : ""}`);
    }
    if (connections.length) lines.push("connections:");
    for (const connection of connections) lines.push(`- ${connection.fromNodeId} -> ${connection.toNodeId}`);
    return lines.join("\n");
}

/**
 * Which nodes each group holds, by group id.
 *
 * A group is a container, and membership is one field on the member (`metadata.groupId`) rather than a list
 * on the group — so this is the one place the flat list is turned back into the hierarchy the canvas draws.
 */
function membersByGroup(nodes: CanvasNodeData[]): Map<string, string[]> {
    const members = new Map<string, string[]>();
    for (const node of nodes) {
        const groupId = node.type === CanvasNodeType.Group ? undefined : node.metadata?.groupId;
        if (!groupId) continue;
        const held = members.get(groupId);
        if (held) held.push(node.id);
        else members.set(groupId, [node.id]);
    }
    return members;
}

/**
 * What a node is to a group, in the two directions one line can state it from.
 *
 * Without this the list was flat and a group was a box with nothing in it: `- g1 (group)` told an agent that
 * a container existed and gave it no way to say — or to find out — what was in it, so a question about the
 * group could only be answered by guessing from geometry. A member's line names its group and a group's line
 * names its members, which is one clause either way and covers both ways the question is asked: "what is in
 * g1" reads the group's own line, "where does this node belong" reads the node's.
 */
function groupClause(node: CanvasNodeData, members: Map<string, string[]>): string {
    if (node.type === CanvasNodeType.Group) {
        const held = members.get(node.id) || [];
        return held.length ? ` members: ${held.join(", ")}` : " members: none";
    }
    const groupId = node.metadata?.groupId;
    return groupId ? ` in group ${groupId}` : "";
}

/**
 * The picture's own pixels, when they are not the card's — the second size a node has.
 *
 * A card is the shape of what it holds, but not its size: a 1920×1280 photograph in a 480×320 card is one
 * line's worth of fact, and a reader deciding whether a node is worth looking at needs both. It is left out
 * when the two agree, because a fact repeated is noise.
 */
function pictureClause(node: CanvasNodeData): string {
    const width = Math.round(node.metadata?.naturalWidth || 0);
    const height = Math.round(node.metadata?.naturalHeight || 0);
    if (!width || !height) return "";
    if (width === Math.round(node.width) && height === Math.round(node.height)) return "";
    return ` (picture ${width}×${height})`;
}

/**
 * A node's words on one line.
 *
 * A prompt can span paragraphs, and a line that does would break the shape the format promises — one node,
 * one line — for every node after it. Whatever the words were, this is what it says in a list.
 */
function oneLine(words: string, limit = 300): string {
    return words.replace(/\s+/g, " ").trim().slice(0, limit);
}
