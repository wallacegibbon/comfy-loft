import { generationClause, runClause } from "@/lib/canvas/node-generation-facts";
import { nodeContentOf } from "@/lib/canvas/node-prompt-field";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasTrashEntry } from "@/types/canvas";

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
export function describeCanvas(nodes: CanvasNodeData[], connections: CanvasConnection[], trash: CanvasTrashEntry[] = []): string {
    const lines = [`${nodes.length} nodes, ${connections.length} connections${trash.length ? `, ${trash.length} in the trash` : ""}`];
    const members = membersByGroup(nodes);
    for (const node of nodes) {
        // No title: a node has no name. The line says what it is by id, type and contents, and a name that
        // belonged to eleven pictures taught a caller a token that resolved to none of them (#321).
        const at = ` at (${Math.round(node.position.x)}, ${Math.round(node.position.y)}), ${Math.round(node.width)}×${Math.round(node.height)}`;
        const picture = pictureClause(node);
        const made = generationClause(node.metadata);
        const running = runClause(node.metadata);
        const content = oneLine(nodeContentOf(node));
        lines.push(`- ${node.id} (${node.type})${at}${picture}${groupClause(node, members)}${running ? ` [${running}]` : ""}${made ? ` ${made}` : ""}${content ? ` content: ${content}` : ""}`);
    }
    if (connections.length) lines.push("connections:");
    for (const connection of connections) lines.push(`- ${connection.fromNodeId} -> ${connection.toNodeId}`);
    // What the canvas threw away. A deletion is not visible on the board, so this is the only place a reader
    // can learn that a node it remembers is recoverable rather than gone (#327) — and the `no node with that
    // id` answer points here.
    if (trash.length) lines.push("trash:");
    for (const entry of trash) lines.push(trashLine(entry));
    return lines.join("\n");
}

/**
 * One trashed node, in the same words as a live one: what it is, what it held, and when it went.
 *
 * The pixel and duration clause is here for the same reason it is on a live line — it is how a picture is
 * told from the other pictures — and the words are only printed for a text node, because for the others
 * `content` is the URL they are rendered from and a URL identifies nothing to a reader.
 */
function trashLine(entry: CanvasTrashEntry): string {
    const held = entry.node.type === CanvasNodeType.Text ? oneLine(nodeContentOf(entry.node)) : "";
    const when = sinceWords(entry.deletedAt);
    return `- ${entry.node.id} (${entry.node.type})${pictureClause(entry.node)}${when ? ` deleted ${when}` : ""}${held ? ` content: ${held}` : ""}`;
}

/**
 * How long ago something happened, in words a reader can order without doing arithmetic.
 *
 * A timestamp would make the model compare dates against a clock it does not have, and "3 minutes ago" is
 * what the question actually is: is this the thing I deleted a moment ago, or one from last week.
 */
function sinceWords(iso: string, now = Date.now()): string {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return "";
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
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
 * What a node holds, in the numbers the card does not show: the picture's own pixels, and how long a clip or
 * a sound runs.
 *
 * A card is the shape of what it holds, but not its size: a 1920×1280 photograph in a 480×320 card is one
 * line's worth of fact, and a reader deciding whether a node is worth looking at needs both. The pixels are
 * left out when the two agree, because a fact repeated is noise — the *length* never is, because no card
 * shows one and "how long is this clip" is the question a chain of clips is planned from.
 */
function pictureClause(node: CanvasNodeData): string {
    const facts: string[] = [];
    const width = Math.round(node.metadata?.naturalWidth || 0);
    const height = Math.round(node.metadata?.naturalHeight || 0);
    if (width && height && (width !== Math.round(node.width) || height !== Math.round(node.height))) facts.push(`picture ${width}×${height}`);
    const duration = node.metadata?.durationMs || 0;
    if (duration > 0) facts.push(`${(duration / 1000).toFixed(1)} s`);
    return facts.length ? ` (${facts.join(", ")})` : "";
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
