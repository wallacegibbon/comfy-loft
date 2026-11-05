import { heldKeys } from "@/lib/canvas/node-settings";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

/**
 * Which run this node is — the half of the panel `set_node_settings` does not write.
 *
 * `set_node_settings` settles the *shape* of a run: how big, how long, with what seed. This settles which run
 * it is at all: the workflow, and the mode a family of workflows is asked in. They are two tools because they
 * are two decisions, and because only one of them can have a consequence the caller did not intend: a size is
 * a number, a model is a different picture.
 *
 * The vocabulary is the canvas's own, not the picker's storage format. A node's `model` holds
 * `channel::model` (`default::image-qwen21`), which is a naming detail of the channels; every sentence in this
 * build names the workflow instead (`image-qwen21`), so a caller may use either and the tool resolves both.
 * Which models exist is the panel's own list — a caller cannot be offered one the picker would not show.
 *
 * A mode is a property of a family, not a free choice: `image-qwen21` offers `t2i`/`edit`/`inpaint`/`outpaint`,
 * and a film's workflow *is* its mode (`videoModelModePatch` writes the workflow's own declared mode whenever
 * the workflow changes). So a mode is resolved the way the panel resolves it — including a mode whose own node
 * pack is missing, which is refused here rather than queued to fail inside ComfyUI.
 */

/** The kinds of node that run a model. A text card holds words, a group holds nodes, a LoRA a stack. */
const MODEL_KINDS: string[] = [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio];

/** One model a node of this kind may be set to, as the pickers describe it. */
type ModelOption = {
    /** The value the node stores, as the pickers write it (`default::image-qwen21`). */
    value: string;
    /** Every name a caller may use for it: the model's own name and the workflow it runs. */
    names: string[];
    /** What the canvas shows a reader, for a refusal that has to name the choices. */
    label: string;
    /** The workflow id, which is what `list_nodes` and `read_prompt` report a run as. */
    workflowId: string;
    /** The mode this workflow declares it runs in; a film's workflow is its mode. `""` when it declares none. */
    mode: string;
    /** The modes the family offers, and the ones whose own nodes are missing. */
    modes: string[];
    blocked: string[];
};

/** What the page lends the decision: the choices, and the contract answer for each (#304). */
export type ModelCatalog = {
    options: ModelOption[];
    /** Whether a run of `value` in `mode` reads `key`: true, false, or undefined when nothing is published. */
    accepts: (value: string, mode: string, key: string) => boolean | undefined;
};

type ModelPlan = { ok: true; patch: CanvasNodeMetadata; model: ModelOption; mode: string; stale: string[] } | { ok: false; reason: string };

/** What a caller may state: the model, the mode, or both. */
export type ModelChoice = { model?: unknown; mode?: unknown };

/**
 * Resolve a caller's model and mode into the fields the node's picker writes, or say why it cannot.
 *
 * Both names are accepted — `image-qwen21` and `default::image-qwen21` are the same run — and a name that
 * matches more than one channel's copy is refused rather than guessed: two channels can carry the same model
 * name, and choosing between them is choosing a server for the user.
 */
export function planNodeModel(node: CanvasNodeData, choice: ModelChoice, catalog: ModelCatalog): ModelPlan {
    if (!MODEL_KINDS.includes(node.type)) {
        const what = node.type === CanvasNodeType.Text ? "a text card holds words and runs nothing" : node.type === CanvasNodeType.Group ? "a group holds nodes and runs nothing" : "a LoRA node holds a stack, and runs nothing";
        return { ok: false, reason: `${node.id} is ${node.type} and has no run to choose: ${what}` };
    }

    if (choice.model !== undefined && typeof choice.model !== "string") return { ok: false, reason: "model needs the name of one, as list_nodes and read_prompt report it" };
    const requested = typeof choice.model === "string" ? choice.model.trim() : "";
    const wanted = typeof choice.mode === "string" ? choice.mode.trim() : "";
    if (!requested && !wanted) return { ok: false, reason: "set_model needs a model, a mode, or both" };

    const current = node.metadata?.model ? resolve(node.metadata.model, catalog) : undefined;
    let chosen: ModelOption | undefined;
    if (requested) {
        const resolved = resolve(requested, catalog);
        if ("reason" in resolved) return { ok: false, reason: resolved.reason };
        chosen = resolved.option;
    }

    let mode = "";
    if (node.type === CanvasNodeType.Video) {
        // A film's workflow is its mode, so a mode alone is a way of naming the workflow — which is what the
        // panel's own mode pill does (`videoModelForMode`).
        if (wanted) {
            const declaring = catalog.options.find((option) => option.mode === wanted);
            if (!declaring) return { ok: false, reason: `${wanted} is not a mode a film runs in here: ${modesIn(catalog)}` };
            if (chosen && chosen.mode !== wanted) return { ok: false, reason: `${chosen.workflowId} runs in ${chosen.mode || "no mode"}, not ${wanted}: name the workflow whose mode it is, or the mode alone` };
            chosen = chosen || declaring;
        }
        mode = chosen?.mode || "";
    } else if (node.type === CanvasNodeType.Image) {
        if (wanted) {
            const family = chosen || (current && "option" in current ? current.option : undefined);
            if (!family) return { ok: false, reason: `${node.id} runs no model yet, so ${wanted} is a mode of nothing: name the model too` };
            if (!family.modes.length) return { ok: false, reason: `${family.workflowId} has no modes: it is one run, asked one way` };
            if (!family.modes.includes(wanted)) return { ok: false, reason: `${family.workflowId} does not offer ${wanted}: ${family.modes.join(", ")}` };
            if (family.blocked.includes(wanted)) {
                return {
                    ok: false,
                    reason: `${family.workflowId}'s ${wanted} needs node packs this install does not have, so a run of it would be refused inside ComfyUI: ${family.blocked.join(", ")} ${family.blocked.length === 1 ? "is" : "are"} blocked`,
                };
            }
            mode = wanted;
        }
    } else if (wanted) {
        return { ok: false, reason: `a sound's workflow declares no modes: ${node.id} runs ${chosen?.workflowId || currentName(current)} as it is` };
    }

    if (!chosen) return { ok: false, reason: `${node.id} has no model to change the mode of: name the model too` };

    const patch: CanvasNodeMetadata = { model: chosen.value };
    if (mode && node.type !== CanvasNodeType.Video) patch.imageMode = mode as CanvasNodeMetadata["imageMode"];
    // A film's mode travels with its workflow, exactly as `videoModelModePatch` writes the pair.
    if (node.type === CanvasNodeType.Video && chosen.mode) patch.videoMode = chosen.mode;

    // What this run no longer reads. The values stay on the node — a knob belongs to the model that declared it,
    // and the panel leaves them too (#274) — but a caller that set one for the old model has to be told, because
    // the request will now leave it out and nothing else would say why (#302).
    const effectiveMode = mode || (node.type === CanvasNodeType.Image ? String(node.metadata?.imageMode || "") : chosen.mode);
    const stale = heldKeys(node).filter((key) => catalog.accepts(chosen.value, effectiveMode, key) === false);

    return { ok: true, patch, model: chosen, mode, stale };
}

/** Resolve one name to one option, refusing what is ambiguous or absent. */
function resolve(name: string, catalog: ModelCatalog): { option: ModelOption } | { reason: string } {
    const trimmed = name.trim();
    if (!trimmed) return { reason: "no model was named" };
    const exact = catalog.options.find((option) => option.value === trimmed);
    if (exact) return { option: exact };
    const named = catalog.options.filter((option) => option.names.includes(trimmed));
    if (named.length === 1) return { option: named[0] };
    if (named.length > 1) {
        return { reason: `${trimmed} is more than one channel's copy of a model (${named.map((option) => option.label).join(", ")}): name the one you mean by its channel::model value` };
    }
    return { reason: `${trimmed} is not a model this canvas has: ${choosable(catalog)}` };
}

/** The models a refusal offers, by the name a caller can use: the workflow, which is what the tools report. */
function choosable(catalog: ModelCatalog) {
    const names = [...new Set(catalog.options.map((option) => option.workflowId || option.names[0]).filter(Boolean))];
    return names.length ? names.join(", ") : "nothing is configured for this kind yet";
}

/** The modes a film runs in, for a refusal that names them. */
function modesIn(catalog: ModelCatalog) {
    const modes = [...new Set(catalog.options.map((option) => option.mode).filter(Boolean))];
    return modes.length ? modes.join(", ") : "no workflow here declares one";
}

function currentName(current: { option: ModelOption } | { reason: string } | undefined) {
    return current && "option" in current ? current.option.workflowId : "its model";
}
