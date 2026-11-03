import { afterAll, expect, test, vi } from "vitest";

/**
 * Where the server is, and where it is *not*.
 *
 * A stored document used to be the authority on the server's address, which meant the address could outlive
 * itself: open the canvas at `http://192.168.3.232:8190`, restart the server on `127.0.0.1`, open the page
 * again — and every request, the agent's WebSocket included, still dialled `192.168.3.232` (measured:
 * `ERR_CONNECTION_REFUSED` on the socket, found in #241). The canvas is served by the server it talks to
 * (#219), so the page is the only answer that cannot be stale.
 */
const STALE = "http://192.168.3.232:8190";
const HERE = "http://127.0.0.1:8190";

const stored = {
    config: {
        baseUrl: STALE,
        channels: [{ id: "local-server", name: "Local", baseUrl: STALE, models: [{ name: "img-a", capability: "image" }] }],
        imageModel: "local-server::img-a",
        model: "local-server::img-a",
    },
};

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
});
// The page this document is being read by: the server from a different address than the one it remembers.
Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
        __RUNTIME_CONFIG__: { SETTINGS: stored },
        location: { origin: HERE, hostname: "127.0.0.1" },
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

test("the server's address comes from the page, not from the stored document", () => {
    const config = useConfigStore.getState().config;
    expect(config.baseUrl).toBe(HERE);
});

test("so does every channel's, which is what the requests are actually built from", () => {
    const config = useConfigStore.getState().config;
    expect(config.channels).not.toHaveLength(0);
    for (const channel of config.channels) {
        expect(channel.baseUrl).toBe(HERE);
    }
});

test("the stored models and the stored selection still survive the move", () => {
    const config = useConfigStore.getState().config;
    expect(config.channels[0].models.map((model) => model.name)).toEqual(["img-a"]);
    expect(config.imageModel).toBe("local-server::img-a");
});
