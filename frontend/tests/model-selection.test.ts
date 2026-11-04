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

const { defaultConfig, defaultModelOptions, resolveModelForCapability, useConfigStore, workflowModelOptions } = await import("../src/stores/use-config-store");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const { CanvasNodeType } = await import("../src/types/canvas");

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

// The node remembers what it was made with. Recovery asks about that model by name, so a task that
// outlived a restart is queried on the canvas that started it, not on whatever the default now is.
test("a saved task keeps the model it was made with", () => {
    const node = videoNode("replacement::video-a");
    const selected = buildGenerationConfig(config, node, "video");
    expect(selected.model).toBe("replacement::video-a");
    expect(ready(selected, selected.model)).toBe(true);
    expect(node.metadata?.runId).toBe("original-task");
});
