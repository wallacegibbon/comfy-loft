import { NODE_STATUS_ERROR, NODE_STATUS_LOADING } from "@/lib/canvas/canvas-node-status";
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
 * The stamp is the server's own: an ISO 8601 instant in UTC, printed as it was recorded rather than
 * formatted for a locale. The same sentence is read by a model and by the user, and the user's machine is
 * not necessarily where the server runs — a `toLocaleString` here would be a different string for every
 * reader of the same fact.
 */
/**
 * What a node's run is doing right now, or what its last one ended in: the answer to "is anything happening
 * here?", which nothing on the canvas used to say.
 *
 * An agent told to check a node it just pressed (#285) can only do that if the node says so. A run in flight,
 * a failure with the reason it gave, or nothing — an idle node is not news, and a line of "idle" on every node
 * of a big canvas is noise.
 */
export function runClause(metadata: CanvasNodeMetadata | undefined): string {
    if (metadata?.status === NODE_STATUS_LOADING) return "generating now";
    if (metadata?.status === NODE_STATUS_ERROR) {
        const reason = (metadata?.errorDetails || "").trim() || "no reason given";
        return `last run failed: ${reason}`;
    }
    return "";
}

export function generationClause(metadata: CanvasNodeMetadata | undefined): string {
    const workflow = (metadata?.workflow || "").trim();
    const generatedAt = (metadata?.generatedAt || "").trim();
    if (workflow && generatedAt) return `made ${generatedAt} with ${workflow}`;
    if (workflow) return `made with ${workflow}`;
    if (generatedAt) return `made ${generatedAt}`;
    return "";
}

/**
 * What a node is set to run, in one clause — the other half of `generationClause`.
 *
 * One answers what *made* the content in the node, this one what the next run will be. They are different
 * facts and they disagree the moment the user changes the picker: an image node made by
 * `image-z-image-turbo` can be set to run `image-qwen21`. An agent asked to rewrite a prompt needs this
 * one, because the wording it must write is chosen by the workflow (`h3-prompt-writing` has a different
 * section order for each H3 input mode) and nothing else on the canvas says which will run.
 *
 * It is read from the picker's own value, so it says nothing about a node that has never been given one —
 * a text node's model belongs to the agent, not to a workflow. The seconds are the node's, when it has
 * kept a duration of its own; the global default is not a fact about this node.
 */
export function configuredClause(metadata: CanvasNodeMetadata | undefined): string {
    const model = (metadata?.model || "").trim();
    if (!model) return "";
    // A picker value is `channel::model` or a bare model name; either way the tail is what the server is
    // asked for, and the channel is a local naming detail the reader cannot act on.
    const at = model.lastIndexOf("::");
    const name = (at >= 0 ? model.slice(at + 2) : model).trim();
    const seconds = (metadata?.seconds || "").trim();
    return seconds ? `set to run ${name}, ${seconds} s` : `set to run ${name}`;
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
