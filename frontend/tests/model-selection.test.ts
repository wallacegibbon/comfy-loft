import { afterAll, expect, test } from "vitest";
import type { AiConfig } from "../src/stores/use-config-store";
import type { CanvasNodeData } from "../src/types/canvas";

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

const { defaultConfig, defaultModelOptions, modelIsStep, paramsAcceptedBy, resolveModelForCapability, useConfigStore, workflowModelOptions } = await import("../src/stores/use-config-store");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const { CanvasNodeType } = await import("../src/types/canvas");
const { videoFollowsSource, videoModelForMode } = await import("../src/lib/canvas/video-model-mode");
const { imageModeFor } = await import("../src/lib/canvas/image-mode");

const config: AiConfig = {
    ...defaultConfig,
    videoModel: "replacement::video-b",
    channels: [
        {
            id: "replacement",
            name: "Replacement",
            baseUrl: "https://example.com",
            models: [
                { name: "video-b", capability: "video" },
                { name: "video-a", capability: "video" },
                { name: "image-a", capability: "image" },
            ],
        },
    ],
};
const ready = useConfigStore.getState().isAiConfigReady;
const videoNode = (model: string): CanvasNodeData => ({
    id: "saved-video",
    type: CanvasNodeType.Video,
    title: "Saved video",
    position: { x: 0, y: 0 },
    width: 320,
    height: 180,
    metadata: { model, runId: "original-task", seconds: "4" },
});

test("task recovery rejects a model nothing offers instead of querying the first channel", () => {
    expect(ready(config, "removed::video-a")).toBe(false);
    expect(ready(config, "unknown-video")).toBe(false);
});

test("a new node without a selection still uses its configured default", () => {
    const selected = buildGenerationConfig(config, undefined, "video");
    expect(selected.model).toBe("replacement::video-b");
    expect(ready(selected, selected.model)).toBe(true);
});

test("switching generation capability still selects a model of the new capability", () => {
    expect(resolveModelForCapability(config, "replacement::image-a", "video")).toBe("replacement::video-b");
});

// A tool — an interpolation, an upscaler — takes a clip or a picture and has nothing to be asked, so it can
// never be the answer to "which model does a new node use". It is offered in a node's own list, which is how
// a node can be one at all.
test("a step is offered to a node but never picked as the default", () => {
    const withStep: AiConfig = {
        ...config,
        channels: [
            {
                id: "replacement",
                name: "Replacement",
                baseUrl: "https://example.com",
                // First in the list, which is what a fallback would otherwise reach for.
                models: [
                    { name: "image-esrgan-upscale", capability: "image", workflowId: "image-esrgan-upscale", tool: true, hasPrompt: false },
                    { name: "image-a", capability: "image", workflowId: "image-a" },
                ],
            },
        ],
    };
    expect(workflowModelOptions(withStep, "image")).toContain("replacement::image-esrgan-upscale");
    expect(defaultModelOptions(withStep, "image")).toEqual(["replacement::image-a"]);
    expect(defaultModelOptions(withStep, "image")).not.toContain("replacement::image-esrgan-upscale");
});

// A mode switch is a lookup over what the workflows declare, not a table of ids: `reference` is whichever
// video model says `mode: "reference"`. A model the server did not list claims nothing, so a stale
// selection is not silently locked or unlocked.
test("a mode finds the model that declares it, and an unknown model claims nothing", () => {
    const withModes: AiConfig = {
        ...config,
        channels: [
            {
                id: "replacement",
                name: "Replacement",
                baseUrl: "https://example.com",
                models: [
                    { name: "video-h3-t2v", capability: "video", workflowId: "video-h3-t2v", mode: "text", bindsSeconds: true },
                    { name: "video-h3-frames", capability: "video", workflowId: "video-h3-frames", mode: "frames", bindsSeconds: true },
                    { name: "video-h3-character-swap", capability: "video", workflowId: "video-h3-character-swap", mode: "reference", bindsSeconds: false },
                ],
            },
        ],
    };
    expect(videoModelForMode(withModes, "reference")).toBe("replacement::video-h3-character-swap");
    expect(videoModelForMode(withModes, "frames")).toBe("replacement::video-h3-frames");
    expect(videoModelForMode(withModes, "inpaint")).toBe("");

    expect(videoFollowsSource(withModes, "replacement::video-h3-character-swap")).toBe(true);
    expect(videoFollowsSource(withModes, "replacement::video-h3-t2v")).toBe(false);
    expect(videoFollowsSource(withModes, "replacement::not-listed")).toBe(false);
});

// A step is what a button drives — and it is one whether or not it happens to take words. The angle
// re-render takes words, which used to make it look like a composer model: its panel hid its knobs and its
// run went down the from-prompt path, where those knobs are never sent (docs/decisions.md #267).
test("a tool is a step even when it takes words, and a model that takes none is a step too", () => {
    const withModels: AiConfig = {
        ...config,
        channels: [
            {
                id: "replacement",
                name: "Replacement",
                baseUrl: "https://example.com",
                models: [
                    { name: "image-qwen21", capability: "image", workflowId: "image-qwen21", hasPrompt: true },
                    { name: "image-qwen21-angle", capability: "image", workflowId: "image-qwen21-angle", tool: true, hasPrompt: true },
                    { name: "image-esrgan-upscale", capability: "image", workflowId: "image-esrgan-upscale", tool: true, hasPrompt: false },
                ],
            },
        ],
    };
    expect(modelIsStep(withModels, "replacement::image-qwen21-angle")).toBe(true);
    expect(modelIsStep(withModels, "replacement::image-esrgan-upscale")).toBe(true);
    expect(modelIsStep(withModels, "replacement::image-qwen21")).toBe(false);
    // A model the server did not list is unknown, not a step: nothing is claimed about it.
    expect(modelIsStep(withModels, "replacement::not-listed")).toBe(false);
});

// A node keeps its mode after the model under it changes, so the mode has to be resolved against the model
// that will actually run: an inpaint mode sent to a workflow with no mask binding is a request for something
// the graph cannot do (docs/decisions.md #267).
test("the image mode sent is one the running model declares", () => {
    const variants = [
        { name: "edit", accepts: { images: { min: 1, max: 4 } } },
        { name: "inpaint", accepts: { images: { min: 2, max: 2 } } },
        { name: "outpaint", accepts: { images: { min: 1, max: 1 } } },
        { name: "t2i", accepts: { images: { max: 0 } } },
    ];
    const withModes = (imageMode: string, modes = variants, workflowId = "image-qwen21"): AiConfig => ({
        ...config,
        imageMode,
        channels: [
            {
                id: "replacement",
                name: "Replacement",
                baseUrl: "https://example.com",
                models: [
                    {
                        name: workflowId,
                        capability: "image",
                        workflowId,
                        hasPrompt: true,
                        variantModes: modes.map((mode) => mode.name),
                        contracts: Object.fromEntries(modes.map((mode) => [mode.name, { accepts: mode.accepts as never }])),
                    },
                    { name: "image-z-image-turbo", capability: "image", workflowId: "image-z-image-turbo", hasPrompt: true },
                ],
            },
        ],
    });
    expect(imageModeFor(withModes("inpaint"), "replacement::image-qwen21")).toBe("inpaint");
    // A workflow with no modes is sent none: the field is not part of its request at all.
    expect(imageModeFor(withModes("inpaint"), "replacement::image-z-image-turbo")).toBe("");
    // A stale or empty mode falls to the one whose contract asks for least — not to a name. Its `t2i` here
    // only because that is the mode this family declares as needing nothing.
    expect(imageModeFor(withModes("nonsense"), "replacement::image-qwen21")).toBe("t2i");
    expect(imageModeFor(withModes(""), "replacement::image-qwen21")).toBe("t2i");
    // A family whose cheapest mode is not called `t2i` still resolves, which is the point of asking contracts:
    const other = [
        { name: "alpha", accepts: { images: { min: 2, max: 2 } } },
        { name: "beta", accepts: { images: { min: 1, max: 1 } } },
    ];
    expect(imageModeFor(withModes("inpaint", other, "image-other-family"), "replacement::image-other-family")).toBe("beta");
});

// A node keeps its knobs when the model under it changes, and a knob belongs to the model that declared it. So
// the request carries only the ones the running model takes — a leftover used to be refused as `unknown_input`,
// failing the run for a field nobody typed (docs/decisions.md #274).
test("a stored knob the model does not take is not sent", () => {
    const withKnobs: AiConfig = {
        ...config,
        channels: [
            {
                id: "replacement",
                name: "Replacement",
                baseUrl: "https://example.com",
                models: [
                    { name: "image-z-image-turbo", capability: "image", workflowId: "image-z-image-turbo", hasPrompt: true, inputs: ["prompt", "size", "seed", "steps", "editCanvasSize"] },
                    { name: "image-esrgan-upscale", capability: "image", workflowId: "image-esrgan-upscale", tool: true, hasPrompt: false, inputs: ["prompt", "upscale_model"] },
                    { name: "image-unlisted", capability: "image", workflowId: "image-unlisted" },
                ],
            },
        ],
    };
    // `upscale_model` came from the upscaler; the image workflow does not declare it.
    expect(paramsAcceptedBy(withKnobs, "replacement::image-z-image-turbo", { upscale_model: "x", seed: 7, steps: 4 })).toEqual({ seed: 7, steps: 4 });
    // `editCanvasSize` is a request key of every workflow rather than a declared parameter, and it survives.
    expect(paramsAcceptedBy(withKnobs, "replacement::image-z-image-turbo", { editCanvasSize: "1024x1024" })).toEqual({ editCanvasSize: "1024x1024" });
    // Nothing left is `undefined`, not an empty object: the request carries no `params` at all.
    expect(paramsAcceptedBy(withKnobs, "replacement::image-z-image-turbo", { upscale_model: "x" })).toBeUndefined();
    // A model the server did not describe claims nothing, so nothing is dropped on a guess.
    expect(paramsAcceptedBy(withKnobs, "replacement::image-unlisted", { anything: 1 })).toEqual({ anything: 1 });
});

// The node remembers what it was made with. Recovery asks about that model by name, so a task that

// outlived a restart is queried on the canvas that started it, not on whatever the default now is.
test("a saved task keeps the model it was made with", () => {
    const node = videoNode("replacement::video-a");
    const selected = buildGenerationConfig(config, node, "video");
    expect(selected.model).toBe("replacement::video-a");
    expect(ready(selected, selected.model)).toBe(true);
    expect(node.metadata?.runId).toBe("original-task");
});
