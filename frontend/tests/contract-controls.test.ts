import { afterAll, expect, test } from "vitest";

// Config and i18n use browser storage during module initialization.
const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    },
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { defaultConfig, acceptsInput, acceptedInputs } = await import("../src/stores/use-config-store");
type AiConfig = import("../src/stores/use-config-store").AiConfig;
type ChannelModel = import("../src/stores/use-config-store").ChannelModel;

/**
 * Whether a control exists is the same question as whether the request may carry its key (#304).
 *
 * The panel used to ask nothing: the size row and the transparent switch were rendered for every image workflow,
 * while the request has been filtered by the workflow's own contract since #302. A control whose key the run
 * drops does nothing when the user moves it — the failure this file pins, from the side the user sees.
 *
 * Three states, and the middle one is why this is not a boolean: a workflow the server never described lists no
 * inputs, so the canvas knows nothing and must not hide what the user already has.
 */
const model = (overrides: Partial<ChannelModel> & { name: string }): ChannelModel => ({ capability: "image", ...overrides });

const config: AiConfig = {
    ...defaultConfig,
    model: "qwen",
    imageModel: "qwen",
    channels: [
        {
            id: "default",
            name: "Default",
            baseUrl: "http://127.0.0.1:8190/v1",
            models: [
                // Qwen: words-only runs take a size, edits follow their reference, and only its prompt carries the
                // transparency wording.
                model({
                    name: "qwen",
                    workflowId: "image-qwen21",
                    variantModes: ["t2i", "edit"],
                    inputs: ["prompt"],
                    contracts: {
                        t2i: { mode: "text", inputs: ["prompt", "size", "background", "seed"] },
                        edit: { mode: "edit", inputs: ["prompt", "editCanvasSize", "background", "seed"] },
                    },
                }),
                // A text-to-image workflow with no background prompt declared: the transparent switch had nothing
                // behind it.
                model({ name: "z-image", workflowId: "image-z-image-turbo", inputs: ["prompt", "size", "seed"] }),
                // An upscaler declares no prompt, no size and no seed — everything the image panel offers.
                model({ name: "upscale", workflowId: "image-esrgan-upscale", inputs: ["loras", "upscale_model"] }),
                // A workflow from an older stored config: the server said nothing about its inputs.
                model({ name: "legacy", workflowId: "image-old" }),
            ],
        },
    ],
};

test("a size control exists only where the mode reads a size", () => {
    expect(acceptsInput(config, "qwen", "size", "t2i")).toBe(true);
    // Qwen's edit follows the first reference; a chosen size was accepted and dropped.
    expect(acceptsInput(config, "qwen", "size", "edit")).toBe(false);
    expect(acceptsInput(config, "z-image", "size")).toBe(true);
    expect(acceptsInput(config, "upscale", "size")).toBe(false);
});

test("the transparent switch exists only where a background prompt is declared", () => {
    expect(acceptsInput(config, "qwen", "background", "t2i")).toBe(true);
    // Z-Image has no `backgroundPrompt`, so "transparent" never reached its graph.
    expect(acceptsInput(config, "z-image", "background")).toBe(false);
});

test("a workflow the server did not describe is not a reason to hide a control", () => {
    expect(acceptsInput(config, "legacy", "size")).toBeUndefined();
    // A model that is not in the config at all — a node pointing at a channel that was removed.
    expect(acceptsInput(config, "gone", "size")).toBeUndefined();
});

test("no image control survives on a workflow that reads none of them", () => {
    expect(acceptsInput(config, "upscale", "size")).toBe(false);
    expect(acceptsInput(config, "upscale", "background")).toBe(false);
    expect(acceptsInput(config, "upscale", "seed")).toBe(false);
});

test("the control and the request answer the same question", () => {
    const keys = ["size", "background", "seed", "editCanvasSize", "quality", "loras"];
    for (const name of ["qwen", "z-image", "upscale", "legacy"]) {
        for (const mode of ["", "t2i", "edit"]) {
            for (const key of keys) {
                const accepted = acceptsInput(config, name, key, mode);
                // `acceptedInputs` keeps the whole object when it knows nothing, and drops exactly the keys the
                // contract omits otherwise — so "undefined" here means "still sent", not "hidden".
                const sent = acceptedInputs(config, name, { [key]: "x" }, mode) !== undefined;
                expect(sent, `${name} ${mode || "(base)"} ${key}`).toBe(accepted !== false);
            }
        }
    }
});
