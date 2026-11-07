import { afterAll, expect, test, vi } from "vitest";

/**
 * What a stored preferences document loses when this build reads it.
 *
 * `canvas-image-quick-tools-v8` was the list of tools a picture's bar showed, back when the bar could be
 * configured (#332 removed it: every kind of node has one fixed list now, and there is nothing left to choose).
 * The reader and the writer went with the feature; the key stayed in the workspace's document, where the next
 * reader has to spend a moment proving nothing wants it. It is dropped on read, not left to rot.
 *
 * The reverse rule matters as much: nothing else in the document may be dropped on the way past, which is what
 * the second half of this file checks.
 */
const stored = {
    "canvas-image-quick-tools-v8": ["crop", "split", "upscale"],
    lastCanvas: "0d0a9a0c2250",
    locale: "zh-CN",
    config: { imageModel: "local-server::img-a" },
};

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
        __RUNTIME_CONFIG__: { SETTINGS: stored },
        location: { origin: "http://127.0.0.1:8190", hostname: "127.0.0.1" },
    },
});

vi.resetModules();
const { useSettingsStore } = await import("@/stores/use-settings-store");

afterAll(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("the quick-tools key the bar no longer reads is gone from the document", () => {
    expect(useSettingsStore.getState().settings).not.toHaveProperty("canvas-image-quick-tools-v8");
});

test("and nothing else in the document was dropped with it", () => {
    const settings = useSettingsStore.getState().settings;
    expect(settings.lastCanvas).toBe("0d0a9a0c2250");
    expect(settings.locale).toBe("zh-CN");
    expect(settings.config).toEqual({ imageModel: "local-server::img-a" });
});
