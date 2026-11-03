import type { CanvasNodeMetadata } from "@/types/canvas";

/**
 * How a node's content came to be, in one clause, for the two tools that answer questions about a node.
 *
 * `list_nodes` said every fact about a node except what made its content, and `read_node` handed over the
 * bytes and nothing about them, so an agent asked "which model drew this picture, and when" could only
 * guess from the prompt. The facts are on the node itself (docs/decisions.md #227, `workflow` and
 * `generatedAt`); this is the one place they are put into words, so the two tools cannot word them
 * differently and a third caller gets the same sentence.
 *
 * The stamp is the gateway's own: an ISO 8601 instant in UTC, printed as it was recorded rather than
 * formatted for a locale. The same sentence is read by a model and by the user, and the user's machine is
 * not necessarily where the gateway runs — a `toLocaleString` here would be a different string for every
 * reader of the same fact.
 */
export function generationClause(metadata: CanvasNodeMetadata | undefined): string {
    const workflow = (metadata?.workflow || "").trim();
    const generatedAt = (metadata?.generatedAt || "").trim();
    if (workflow && generatedAt) return `made ${generatedAt} with ${workflow}`;
    if (workflow) return `made with ${workflow}`;
    if (generatedAt) return `made ${generatedAt}`;
    return "";
}

/**
 * What a node forgets while its content is being replaced by a new run: the workflow and the time that
 * described the picture which is now gone.
 *
 * Spread into a patch to erase both fields (`undefined` overwrites, and the document drops the key when it
 * is serialized). A run that fails leaves the node with no content, and a node that claims a maker for
 * content it does not hold is worse than one that says nothing: the agent would report the old model with
 * the new picture's confidence (#227).
 */
export const NO_MAKER: Partial<CanvasNodeMetadata> = { workflow: undefined, generatedAt: undefined };
