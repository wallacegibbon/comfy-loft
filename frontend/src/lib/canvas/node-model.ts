import { heldKeys } from "@/lib/canvas/node-settings";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

/**
 * Which run this node is — the half of `set_node` that decides *what* the run is rather than its shape.
 *
 * `set_node` settles both in one call, and this is the half that cannot be reasoned about alone: it resolves
 * the workflow, and the mode a family of workflows is asked in, before any size or length can be judged — the
 * contract those values are checked against is the new model's. The two are separate plans because a size is a
 * number and a model is a different picture: the plan that can change what a node *is* also has to say which
 * settings the new run stops reading.
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

/** The three kinds of content a workflow can make. A text card makes none of them. */
export type ModelCapability = "image" | "video" | "audio";

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
    /** What a run of each mode takes, in three words — a mode is a different graph, so it takes a different mix. */
    modeMedia: Record<string, string>;
    blocked: string[];
    /**
     * Whether this is a *step* rather than a generator: it takes a picture or a clip and a knob, and nothing is
     * asked of it in words. The pickers show these (a node can be one), so a listing has to say which they are
     * — "how many image models" has a different answer once the upscaler stops counting (docs/decisions.md #312).
     */
    step: boolean;
    /** What the workflow takes as media, in three words: "1 image", "1-4 images", "words only". */
    takes: string;
    /** The knobs a step declares, by the key a caller sets — an upscaler's file, an angle's three numbers. */
    knobs: string[];
};

/** What the page lends the decision: the choices, and the contract answer for each (#304). */
export type ModelCatalog = {
    options: ModelOption[];
    /** Whether a run of `value` in `mode` reads `key`: true, false, or undefined when nothing is published. */
    accepts: (value: string, mode: string, key: string) => boolean | undefined;
};

/** Every kind's catalog, for the question "what models does this canvas have at all". */
export type ModelCatalogs = Record<ModelCapability, ModelCatalog>;

type ModelPlan = { ok: true; patch: CanvasNodeMetadata; model: ModelOption; mode: string; stale: string[] } | { ok: false; reason: string };

/** What a caller may state: the model, the mode, or both. */
type ModelChoice = { model?: unknown; mode?: unknown };

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
    if (!requested && !wanted) return { ok: false, reason: "model was empty: name a model, a mode, or both" };

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

/** The kinds a listing covers, in the order a reader thinks of them. */
export const MODEL_CAPABILITIES: ModelCapability[] = ["image", "video", "audio"];

/**
 * What this canvas can run, as one answer — the question the tools could not answer at all.
 *
 * Every model name an agent had ever seen came from a node that already had one: `read_prompt` says "set to run
 * image-qwen21" and `read_node` says "made with image-z-image-turbo", and neither is a list. Asked how many
 * models there were, an agent recited the names it had scraped off the canvas, counted an upscaler among the
 * image generators, and said it could not get the complete list. It was right — nothing offered one.
 *
 * So the listing is grouped by what the workflow makes, and **steps are their own line**: an upscaler or an
 * interpolation is offered by the pickers, because a node can be one, but it is not something a prompt makes,
 * and counting it as a picture model is how the wrong number gets said out loud. What each workflow *reads* is
 * not here: that is the contract of the node it runs on, and `set_node` refuses a key outside it.
 */
export function describeModelCatalogs(catalogs: ModelCatalogs): string {
    const lines: string[] = [];
    const total = new Set<string>();
    for (const capability of MODEL_CAPABILITIES) {
        // A kind nobody asked about is not a kind with nothing: a narrowed call answers about one, and claiming
        // the others are empty would be the same lie as reciting a list from the nodes on screen.
        const catalog = catalogs[capability];
        if (!catalog) continue;
        const options = catalog.options || [];
        if (!options.length) {
            lines.push(`${capability}: none configured on this canvas`);
            continue;
        }
        const generators = options.filter((option) => !option.step);
        const steps = options.filter((option) => option.step);
        for (const option of options) total.add(option.workflowId || option.value);
        lines.push(`${capability} — ${count(generators.length, "workflow")} to generate with${steps.length ? `, ${count(steps.length, "step")}` : ""}`);
        for (const option of generators) lines.push(`  ${describeModel(option)}`);
        // Named together rather than one per line: a step has no modes worth reading, and the point of the line
        // is that they are not part of the number above.
        if (steps.length) {
            lines.push("  steps (they take media and a knob, and nothing is asked of them in words):");
            for (const step of steps) {
                const parts = [step.takes, step.knobs.length ? `knobs ${step.knobs.join(", ")}` : ""].filter(Boolean);
                lines.push(`  - ${step.workflowId}${parts.length ? ` · ${parts.join(" · ")}` : ""}`);
            }
        }
    }
    lines.push("");
    lines.push(
        `${count(total.size, "workflow")} in all, each one of them something a node can be set to with set_node. What a workflow reads is the contract of the node that runs it — set_node refuses a key it does not read. A base model is a file inside a family, not a workflow: each family is pointed at one of the files its own picker lists.`,
    );
    return lines.join("\n");
}

/** One model, as a line: the name to use, what it is called, what it takes, and the modes it offers. */
function describeModel(option: ModelOption) {
    const name = option.workflowId || option.names[0] || option.value;
    const parts: string[] = [];
    if (option.label && option.label !== name) parts.push(option.label);
    if (option.takes) parts.push(option.takes);
    parts.push(...modesOf(option));
    return `- ${name}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

/** A family's modes, with the blocked one marked — a mode offered and refused is the one to name. */
function modesOf(option: ModelOption) {
    const modes: string[] = [];
    if (option.mode) modes.push(`mode ${option.mode}`);
    if (option.modes.length) {
        // Each mode with what a run of it takes: a family's modes are different graphs, and the one that needs a
        // mask looks exactly like the one that needs nothing until this says so (#313).
        const offered = option.modes.map((mode) => {
            const media = option.modeMedia?.[mode];
            if (option.blocked.includes(mode)) return `${mode} (blocked: its node pack is missing)`;
            return media ? `${mode} (${media})` : mode;
        });
        modes.push(`modes ${offered.join(", ")}`);
    }
    return modes;
}

function count(number: number, noun: string) {
    return `${number} ${noun}${number === 1 ? "" : "s"}`;
}
