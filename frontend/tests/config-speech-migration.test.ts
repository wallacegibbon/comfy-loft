import { afterAll, expect, test, vi } from "vitest";

/**
 * What a stored preferences document loses when it is read by this build.
 *
 * `asrUrl` and `asrModel` were where the single speech server lived (#246). The speech servers are a list on the
 * server now, one profile each, and the active one is what dictation uses (#252) — so a copy in the preferences
 * would be a second answer to where audio goes, and the mirror would keep writing it back to every browser. It is
 * dropped on hydrate rather than left to rot.
 *
 * The reverse rule matters as much: nothing else in the document may be dropped on the way past, which is what the
 * second half of this file checks.
 */
const stored = {
    config: {
        asrUrl: "http://127.0.0.1:18080/v1/audio/transcriptions",
        asrModel: "refine",
        channels: [{ id: "local-server", name: "Local", models: [{ name: "img-a", capability: "image" }] }],
        imageModel: "local-server::img-a",
        systemPrompt: "You are a visual director.",
    },
};

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
});
Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
        __RUNTIME_CONFIG__: { SETTINGS: stored },
        location: { origin: "http://127.0.0.1:8190", hostname: "127.0.0.1" },
    },
});

vi.resetModules();
const { useConfigStore } = await import("@/stores/use-config-store");

afterAll(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

test("the two speech fields the server now owns are gone from the hydrated config", () => {
    const config = useConfigStore.getState().config as unknown as Record<string, unknown>;
    expect(config).not.toHaveProperty("asrUrl");
    expect(config).not.toHaveProperty("asrModel");
});

test("and nothing else in the document was dropped with them", () => {
    const config = useConfigStore.getState().config;
    expect(config.systemPrompt).toBe("You are a visual director.");
    expect(config.channels[0].models.map((model) => model.name)).toEqual(["img-a"]);
});
