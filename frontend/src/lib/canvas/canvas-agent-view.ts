import { generationClause } from "@/lib/canvas/node-generation-facts";
import { nodeContentOf, nodePromptOf } from "@/lib/canvas/node-prompt-field";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

/**
 * The whole canvas as text: every node with the id a tool call can act on, and every edge.
 *
 * One line per node, because a model reads lines and diffs them. Nothing is omitted for looking empty,
 * since a node with no prompt is a fact about the canvas too — but the two kinds of words are named
 * separately, because they are two different things: `content:` is what the node says, `prompt:` is what
 * made it. One `prompt:` that meant either, depending on the node's type, is what let an agent read the
 * prompt box as the text node's body (#229).
 *
 * What made a node's content and when is on that line, before the words: a canvas of a dozen pictures is
 * exactly where "which model drew this one" is a question, and asking it node by node would cost a
 * `read_node` and a picture's bytes each time (#227).
 */
export function describeCanvas(nodes: CanvasNodeData[], connections: CanvasConnection[]): string {
    const lines = [`${nodes.length} nodes, ${connections.length} connections`];
    for (const node of nodes) {
        const title = node.title ? ` "${node.title}"` : "";
        const at = ` at (${Math.round(node.position.x)}, ${Math.round(node.position.y)})`;
        const made = generationClause(node.metadata);
        const content = oneLine(nodeContentOf(node));
        const prompt = oneLine(nodePromptOf(node));
        lines.push(`- ${node.id} (${node.type})${title}${at}${made ? ` ${made}` : ""}${content ? ` content: ${content}` : ""}${prompt ? ` prompt: ${prompt}` : ""}`);
    }
    if (connections.length) lines.push("connections:");
    for (const connection of connections) lines.push(`- ${connection.fromNodeId} -> ${connection.toNodeId}`);
    return lines.join("\n");
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
