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
 *
 * The settings follow — the same fields `set_node_settings` writes (#309). They are facts about the node
 * whether or not a model has been picked for it, which is why a node with a size and no picker still says so:
 * an agent about to write a size has to be able to read the one that is there. `auto` is left out, because it
 * is the absence of a choice rather than one.
 */
export function configuredClause(metadata: CanvasNodeMetadata | undefined): string {
    const settings = settingsClause(metadata);
    const model = (metadata?.model || "").trim();
    if (!model) return settings;
    // A picker value is `channel::model` or a bare model name; either way the tail is what the server is
    // asked for, and the channel is a local naming detail the reader cannot act on.
    const at = model.lastIndexOf("::");
    const name = (at >= 0 ? model.slice(at + 2) : model).trim();
    // The mode is part of which run this is, so a rewrite needs it: `image-qwen21 as edit` takes a picture and
    // the words for changing it, `as t2i` takes words alone. It is not a setting (#309) — it comes with the
    // model — but it is a fact about the next run, which is what this clause is (#311).
    const mode = (metadata?.imageMode || "").trim();
    return [`set to run ${name}${mode ? ` as ${mode}` : ""}`, ...(settings ? [settings] : [])].join(", ");
}

/** The params a settings clause leaves out: two the run fills in, and one it has already stated. */
const UNSTATED_PARAMS: string[] = ["loras", "layout", "layoutEnabled", "seed"];

function settingsClause(metadata: CanvasNodeMetadata | undefined) {
    const parts: string[] = [];
    const size = (metadata?.size || "").trim();
    if (size && size.toLowerCase() !== "auto") parts.push(`size ${size}`);
    const seconds = (metadata?.seconds || "").trim();
    if (seconds) parts.push(`${seconds} s`);
    // A seed is only a fact about the run when the node also says it is fixed — the pair `set_node_settings`
    // writes together, and the one `buildGenerationConfig` reads before it puts a seed in the request.
    const seed = (metadata?.seed || "").trim();
    if (seed && metadata?.seedFixed === "true") parts.push(`seed ${seed}`);
    if ((metadata?.background || "").trim().toLowerCase() === "transparent") parts.push("transparent background");
    const quality = (metadata?.quality || metadata?.vquality || "").trim();
    if (quality) parts.push(`quality ${quality}`);
    const params = Object.entries(metadata?.params || {}).filter(([key, value]) => !UNSTATED_PARAMS.includes(key) && value !== "" && value != null);
    if (params.length) parts.push(`params ${params.map(([key, value]) => `${key} ${value && typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(", ")}`);
    return parts.join(", ");
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
