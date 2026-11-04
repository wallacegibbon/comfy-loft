import { describe, expect, it } from "vitest";

/**
 * Workflows into picker entries.
 *
 * The canvas used to read `GET /v1/models`, a list of workflows dressed as OpenAI models. The ids in it
 * were still the workflow's business — `img-zit-int8` is a spelling only the server can build — so
 * that information moved onto the workflow row (`models`) and the selection rules moved here, where
 * they are testable without a browser or a server.
 */
const { serverModels, modelsOf, modelSignature } = await import("@/lib/server-models");

type Workflow = Parameters<typeof modelsOf>[0];

const workflow = (overrides: Partial<Workflow> = {}): Workflow => ({
    id: "image-z-image-turbo",
    name: "image-z-image-turbo",
    type: "image",
    label: "Z-Image Turbo",
    enabled: true,
    availability: { available: true },
    models: [{ id: "image-z-image-turbo", label: "Z-Image Turbo", baseModel: null, baseModelLabel: null, imageInputs: 0 }],
    ...overrides,
});

describe("modelsOf", () => {
    it("is one entry per model id the workflow answers to", () => {
        const models = modelsOf(
            workflow({
                models: [
                    { id: "image-z-image-turbo", label: "Z-Image Turbo", baseModel: null, baseModelLabel: null, imageInputs: 0 },
                    { id: "img-zit-int8", label: "Z-Image Turbo · int8", baseModel: "z_image_int8.safetensors", baseModelLabel: "int8", imageInputs: 0 },
                ],
            }),
        );

        expect(models).toHaveLength(2);
        expect(models[0]).toMatchObject({ name: "image-z-image-turbo", capability: "image", workflowId: "image-z-image-turbo", imageInputs: 0 });
        // The base-model label is what the second dropdown shows; `baseModel` is the switch behind it.
        expect(models[1]).toMatchObject({ name: "img-zit-int8", baseModel: "z_image_int8.safetensors", baseModelLabel: "int8", label: "Z-Image Turbo · int8" });
        expect(models[1].baseModelLabel).toBe("int8");
    });

    it("takes the capability from the workflow's own type", () => {
        expect(modelsOf(workflow({ type: "audio", models: [{ id: "audio-minimax-music-3" }] }))[0].capability).toBe("audio");
        expect(modelsOf(workflow({ type: "video", models: [{ id: "video-h3-t2v" }] }))[0].capability).toBe("video");
    });

    it("drops a type the canvas cannot render", () => {
        expect(modelsOf(workflow({ type: "text", models: [{ id: "text-some-flow" }] }))).toEqual([]);
    });

    it("leaves out a workflow the user disabled", () => {
        expect(modelsOf(workflow({ enabled: false }))).toEqual([]);
    });

    it("leaves out a workflow ComfyUI cannot run", () => {
        expect(modelsOf(workflow({ availability: { available: false } }))).toEqual([]);
    });

    it("leaves out the workflows the canvas drives from a button", () => {
        // An upscaler takes a clip, not a prompt: it is not a model the picker should offer.
        expect(modelsOf(workflow({ id: "video-rife", type: "video", models: [{ id: "video-rife" }] }))).toEqual([]);
        expect(modelsOf(workflow({ id: "image-esrgan-upscale", models: [{ id: "image-esrgan-upscale" }] }))).toEqual([]);
    });

    it("carries the workflow's variant modes onto every entry", () => {
        const models = modelsOf(
            workflow({
                id: "image-qwen21",
                variantModes: ["edit", "inpaint", "t2i"],
                variantLabels: { edit: "Multi-image edit" },
                models: [{ id: "image-qwen21" }],
            }),
        );
        expect(models[0].variantModes).toEqual(["edit", "inpaint", "t2i"]);
        expect(models[0].variantLabels).toEqual({ edit: "Multi-image edit" });
    });

    it("carries the range the workflow declares for its output length", () => {
        // A music workflow says how long a song may be; the panel and the request both read the bounds from
        // here rather than repeating them, so the registry stays the one place that knows (docs/decisions.md #259).
        const models = modelsOf(
            workflow({
                id: "audio-minimax-music-3",
                type: "audio",
                parameters: [
                    { key: "seed", type: "number" },
                    { key: "duration", type: "number", min: 4, max: 360, step: 0.04 },
                ],
                models: [{ id: "audio-minimax-music-3" }],
            }),
        );
        expect(models[0].duration).toEqual({ min: 4, max: 360 });
    });

    it("has no length to offer when the workflow declares none", () => {
        // An image workflow has nothing to say about duration, and a `duration` that is not a number is not one
        // either: both leave the node without the control, and the request without the input.
        expect(modelsOf(workflow({ parameters: [{ key: "steps", type: "number", min: 1, max: 60 }] }))[0].duration).toBeUndefined();
        expect(modelsOf(workflow({ type: "audio", parameters: [{ key: "duration", type: "select", options: ["short", "long"] }], models: [{ id: "audio-minimax-music-3" }] }))[0].duration).toBeUndefined();
    });

    it("contributes nothing when the server lists no ids", () => {
        // A workflow whose base models are all missing is not selectable; it is also not a name to
        // guess at, so the workflow id is not used as a fallback.
        expect(modelsOf(workflow({ models: [] }))).toEqual([]);
        expect(modelsOf(workflow({ models: undefined }))).toEqual([]);
    });
});

describe("serverModels", () => {
    it("flattens the workflows in the order the server sent them", () => {
        const models = serverModels([workflow(), workflow({ id: "video-h3-t2v", name: "video-h3-t2v", type: "video", models: [{ id: "video-h3-t2v" }] }), workflow({ id: "video-rife", type: "video", models: [{ id: "video-rife" }] })]);
        expect(models.map((model) => model.name)).toEqual(["image-z-image-turbo", "video-h3-t2v"]);
    });
});

describe("modelSignature", () => {
    it("ignores a rebuilt but identical list", () => {
        expect(modelSignature(serverModels([workflow()]))).toBe(modelSignature(serverModels([workflow()])));
    });

    it("changes when a label changes, so an edited registry reaches the picker", () => {
        const before = modelSignature(modelsOf(workflow()));
        const after = modelSignature(modelsOf(workflow({ models: [{ id: "image-z-image-turbo", label: "Renamed" }] })));
        expect(after).not.toBe(before);
    });

    it("changes when a declared duration range changes", () => {
        // Otherwise the eight-second sweep would compare equal and the slider would keep the range of the
        // registry that was loaded when the page opened.
        const before = modelSignature(modelsOf(workflow({ type: "audio", parameters: [{ key: "duration", type: "number", min: 4, max: 360 }], models: [{ id: "audio-x" }] })));
        const after = modelSignature(modelsOf(workflow({ type: "audio", parameters: [{ key: "duration", type: "number", min: 4, max: 120 }], models: [{ id: "audio-x" }] })));
        expect(after).not.toBe(before);
    });
});
