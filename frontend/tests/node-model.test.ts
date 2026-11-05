import { describe, expect, test } from "vitest";

import { describeModelCatalogs, planNodeModel, type ModelCatalog } from "../src/lib/canvas/node-model";
import type { CanvasNodeData, CanvasNodeMetadata } from "../src/types/canvas";

/**
 * Which run a node is, and what changing it costs.
 *
 * The decisions here are three: which model a name means (the workflow id or the picker's value, refused when
 * a name is two channels' copy), whether a mode is one the family offers (and not one whose node pack is
 * missing), and which settings the new run no longer reads — values the node keeps and the request drops, which
 * nothing else in the canvas would say out loud (docs/decisions.md #311).
 */

const node = (type: CanvasNodeData["type"], metadata: CanvasNodeMetadata = {}): CanvasNodeData => ({ id: `${type}-1`, type, title: `${type}-1`, position: { x: 0, y: 0 }, width: 320, height: 240, metadata });

/** One picker entry, as the page builds it: the fields the decision reads, and nothing else. */
type Entry = { value: string; workflowId: string } & Partial<{ names: string[]; label: string; mode: string; modes: string[]; blocked: string[]; step: boolean; takes: string }>;

const option = (over: Entry): Entry & Required<Pick<Entry, "names" | "label" | "mode" | "modes" | "blocked" | "step" | "takes">> => ({
    names: [over.workflowId],
    label: over.workflowId,
    mode: "",
    modes: [],
    blocked: [],
    step: false,
    takes: "",
    ...over,
});

/** What the shipped canvas offers: one picture family with four modes, one picture workflow, two film modes. */
const catalog = (over: Partial<ModelCatalog> = {}): ModelCatalog => ({
    options: [
        option({ value: "default::image-qwen21", workflowId: "image-qwen21", names: ["image-qwen21"], modes: ["t2i", "edit", "inpaint", "outpaint"], blocked: ["outpaint"] }),
        option({ value: "default::image-z-image-turbo", workflowId: "image-z-image-turbo", names: ["image-z-image-turbo"] }),
        option({ value: "default::image-esrgan-upscale", workflowId: "image-esrgan-upscale", names: ["image-esrgan-upscale"] }),
        option({ value: "default::video-h3-t2v", workflowId: "video-h3-t2v", names: ["video-h3-t2v"], mode: "text" }),
        option({ value: "default::video-h3-frames", workflowId: "video-h3-frames", names: ["video-h3-frames"], mode: "frames" }),
    ],
    accepts: (value, mode, key) => {
        void mode;
        // The shipped shape: Qwen's edit reads no size, Z-Image reads one, a step reads its own knob only.
        if (value.includes("image-qwen21")) return ["editCanvasSize", "resolution", "prompt", "mode", "seed"].includes(key);
        if (value.includes("z-image-turbo")) return ["size", "seed", "prompt"].includes(key);
        if (value.includes("esrgan")) return key === "upscale_model";
        return true;
    },
    ...over,
});

const image = node("image", { size: "1360x768", seed: "42", seedFixed: "true", params: { steps: 8 } });

describe("which model a name means", () => {
    test("a workflow id and the picker's own value are the same run", () => {
        const byName = planNodeModel(image, { model: "image-z-image-turbo" }, catalog());
        const byValue = planNodeModel(image, { model: "default::image-z-image-turbo" }, catalog());
        expect(byName.ok && byName.patch).toEqual({ model: "default::image-z-image-turbo" });
        expect(byValue.ok && byValue.patch).toEqual({ model: "default::image-z-image-turbo" });
    });

    test("a name the canvas does not have is refused, with the ones it does", () => {
        const plan = planNodeModel(image, { model: "image-flux" }, catalog());
        expect(plan.ok).toBe(false);
        expect(!plan.ok && plan.reason).toContain("image-qwen21, image-z-image-turbo, image-esrgan-upscale");
    });

    test("a name two channels both carry is refused rather than guessed", () => {
        // Picking one of them would be picking a server for the user.
        const twice = catalog({
            options: [option({ value: "a::image-qwen21", workflowId: "image-qwen21", names: ["image-qwen21"], label: "Qwen (A)" }), option({ value: "b::image-qwen21", workflowId: "image-qwen21", names: ["image-qwen21"], label: "Qwen (B)" })],
        });
        const plan = planNodeModel(image, { model: "image-qwen21" }, twice);
        expect(plan.ok).toBe(false);
        expect(!plan.ok && plan.reason).toContain("more than one channel");
        expect(!plan.ok && plan.reason).toContain("Qwen (A), Qwen (B)");
    });

    test("a model on a node of the wrong kind is not in its catalog, so it is refused", () => {
        const film = node("video");
        const plan = planNodeModel(film, { model: "image-z-image-turbo" }, catalog({ options: [option({ value: "default::video-h3-t2v", workflowId: "video-h3-t2v", mode: "text" })] }));
        expect(!plan.ok && plan.reason).toContain("video-h3-t2v");
    });
});

describe("the mode, and what it writes", () => {
    test("a picture family takes the mode a caller names, and it lands beside the model", () => {
        const plan = planNodeModel(image, { model: "image-qwen21", mode: "edit" }, catalog());
        expect(plan.ok && plan.patch).toEqual({ model: "default::image-qwen21", imageMode: "edit" });
    });

    test("a mode the family does not offer is refused with the ones it does", () => {
        const plan = planNodeModel(image, { model: "image-qwen21", mode: "sketch" }, catalog());
        expect(!plan.ok && plan.reason).toContain("t2i, edit, inpaint, outpaint");
    });

    test("a mode whose node pack is missing is refused here, not inside ComfyUI", () => {
        const plan = planNodeModel(image, { model: "image-qwen21", mode: "outpaint" }, catalog());
        expect(!plan.ok && plan.reason).toContain("node packs");
        expect(!plan.ok && plan.reason).toContain("outpaint");
    });

    test("a workflow with no modes says so instead of accepting one", () => {
        const plan = planNodeModel(image, { model: "image-z-image-turbo", mode: "edit" }, catalog());
        expect(!plan.ok && plan.reason).toContain("no modes");
    });

    test("a picture keeps the mode it has when only the model is named", () => {
        // The request resolves a mode the new family does not offer (#267), so nothing is invented here.
        const plan = planNodeModel(node("image", { imageMode: "edit" }), { model: "image-z-image-turbo" }, catalog());
        expect(plan.ok && plan.patch).toEqual({ model: "default::image-z-image-turbo" });
    });

    test("a film's mode names its workflow, and the pair is written together", () => {
        // The panel's mode pill does exactly this (`videoModelForMode`); `videoModelModePatch` writes both.
        const plan = planNodeModel(node("video"), { mode: "frames" }, catalog());
        expect(plan.ok && plan.patch).toEqual({ model: "default::video-h3-frames", videoMode: "frames" });

        const both = planNodeModel(node("video"), { model: "video-h3-t2v" }, catalog());
        expect(both.ok && both.patch).toEqual({ model: "default::video-h3-t2v", videoMode: "text" });
    });

    test("a film mode and a film that runs in another are refused as a contradiction", () => {
        const plan = planNodeModel(node("video"), { model: "video-h3-t2v", mode: "frames" }, catalog());
        expect(!plan.ok && plan.reason).toContain("runs in text, not frames");
    });

    test("a sound has no modes, and says so rather than accepting one", () => {
        const sound = node("audio", { model: "default::audio-ace-step" });
        const plan = planNodeModel(sound, { mode: "edit" }, catalog({ options: [option({ value: "default::audio-ace-step", workflowId: "audio-ace-step" })] }));
        expect(!plan.ok && plan.reason).toContain("no modes");
    });
});

describe("what a model change leaves behind", () => {
    test("the settings the new run does not read are named, and kept on the node", () => {
        const plan = planNodeModel(image, { model: "image-qwen21", mode: "edit" }, catalog());
        // Qwen's edit reads neither size nor the Z-Image knob; both stay on the node and the request drops them.
        expect(plan.ok && plan.stale).toEqual(["size", "steps"]);
        expect(plan.ok && plan.patch).not.toHaveProperty("size");
    });

    test("a seed that is not fixed is not a value a run reads, so it is not reported", () => {
        const unfixed = node("image", { size: "1360x768", seed: "42", seedFixed: "false" });
        const plan = planNodeModel(unfixed, { model: "image-qwen21", mode: "edit" }, catalog());
        expect(plan.ok && plan.stale).toEqual(["size"]);
    });

    test("nothing published about the new model means nothing is claimed", () => {
        const silent = planNodeModel(image, { model: "image-qwen21" }, catalog({ accepts: () => undefined }));
        expect(silent.ok && silent.stale).toEqual([]);
    });
});

describe("what has no run to choose", () => {
    test("a text card, a group and a LoRA node are refused", () => {
        for (const [kind, words] of [
            [node("text"), "holds words"],
            [node("group"), "holds nodes"],
            [node("lora"), "holds a stack"],
        ] as const) {
            const plan = planNodeModel(kind, { model: "image-qwen21" }, catalog());
            expect(!plan.ok && plan.reason).toContain(words);
        }
    });

    test("a call with neither a model nor a mode says what it needs", () => {
        const plan = planNodeModel(image, {}, catalog());
        expect(!plan.ok && plan.reason).toContain("needs a model, a mode, or both");
    });

    test("a mode alone on a node that runs no model names the model it needs", () => {
        const plan = planNodeModel(node("image"), { mode: "edit" }, catalog());
        expect(!plan.ok && plan.reason).toContain("name the model too");
    });
});

/**
 * The listing: what this canvas can run, said once.
 *
 * The question it exists for is "how many image models are there", and the two things that made the old answer
 * wrong are pinned here: **steps are not generators** (an upscaler counted among the image models is the wrong
 * number), and a workflow nothing on the canvas uses is still on the list (docs/decisions.md #312).
 */
describe("describeModelCatalogs: what this canvas can run", () => {
    const catalogs = (over: Partial<Record<"image" | "video" | "audio", ModelCatalog>> = {}) => ({
        image: {
            options: [
                option({ value: "default::image-qwen21", workflowId: "image-qwen21", label: "Qwen Image 2.1", modes: ["t2i", "edit", "inpaint", "outpaint"], blocked: ["outpaint"], takes: "1-4 images" }),
                option({ value: "default::image-z-image-turbo", workflowId: "image-z-image-turbo", takes: "words only" }),
                option({ value: "default::image-esrgan-upscale", workflowId: "image-esrgan-upscale", step: true, takes: "1 image" }),
            ],
            accepts: () => undefined,
        },
        video: {
            options: [option({ value: "default::video-h3-t2v", workflowId: "video-h3-t2v", mode: "text", takes: "words only" })],
            accepts: () => undefined,
        },
        audio: { options: [], accepts: () => undefined },
        ...over,
    });

    test("groups by what a workflow makes, and counts only generators in the heading", () => {
        const text = describeModelCatalogs(catalogs());
        expect(text).toContain("image — 2 workflows to generate with, 1 step");
        expect(text).toContain("video — 1 workflow to generate with");
        // A kind with nothing configured says so rather than going missing.
        expect(text).toContain("audio: none configured on this canvas");
    });

    test("a step is named on its own line, so it cannot be counted as a model that draws", () => {
        const text = describeModelCatalogs(catalogs());
        expect(text).toContain("steps (they take a picture or a clip and a knob");
        expect(text).toContain("image-esrgan-upscale");
        // …and it is not in the generators' lines.
        expect(text).not.toContain("- image-esrgan-upscale ·");
    });

    test("a mode whose node pack is missing is marked where the mode is offered", () => {
        expect(describeModelCatalogs(catalogs())).toContain("outpaint (blocked: its node pack is missing)");
    });

    test("the workflow is named by the id a caller can pass, with what it takes beside it", () => {
        const text = describeModelCatalogs(catalogs());
        expect(text).toContain("- image-qwen21 · Qwen Image 2.1 · 1-4 images · modes t2i, edit, inpaint");
        expect(text).toContain("- video-h3-t2v · words only · mode text");
    });

    test("the total counts workflows, not channels, and points at the two things left out", () => {
        const doubled = catalogs({ image: { options: [option({ value: "a::image-qwen21", workflowId: "image-qwen21" }), option({ value: "b::image-qwen21", workflowId: "image-qwen21" })], accepts: () => undefined } });
        const text = describeModelCatalogs(doubled);
        // Two channels' copies are one workflow: the count is of workflows, not of entries.
        expect(text).toContain("2 workflows in all");
        expect(text).toContain("A base model is a file inside a family");
        expect(text).toContain("set_node_settings refuses a key it does not read");
    });
});
