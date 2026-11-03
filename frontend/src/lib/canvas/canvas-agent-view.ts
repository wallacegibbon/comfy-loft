import { generationClause } from "@/lib/canvas/node-generation-facts";
import { nodeContentOf } from "@/lib/canvas/node-prompt-field";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

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
 */
export function describeCanvas(nodes: CanvasNodeData[], connections: CanvasConnection[]): string {
    const lines = [`${nodes.length} nodes, ${connections.length} connections`];
    for (const node of nodes) {
        const title = node.title ? ` "${node.title}"` : "";
        const at = ` at (${Math.round(node.position.x)}, ${Math.round(node.position.y)})`;
        const made = generationClause(node.metadata);
        const content = oneLine(nodeContentOf(node));
        lines.push(`- ${node.id} (${node.type})${title}${at}${made ? ` ${made}` : ""}${content ? ` content: ${content}` : ""}`);
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
