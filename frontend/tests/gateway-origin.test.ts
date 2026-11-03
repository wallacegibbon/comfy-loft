import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * Where the canvas says the gateway is (#219).
 *
 * The gateway serves the bundle, so the page's own origin is the answer — the only one that stays right
 * behind a LAN name, a phone, or a reverse proxy. An address is taken from `config.js` only when the
 * operator named one, for a canvas served from somewhere else. Both live in a module that reads
 * `window` at load, so each case stubs it and imports the module fresh.
 */

async function baseUrlWith(runtime: Record<string, string>, page: { origin: string; hostname: string } | null) {
    vi.resetModules();
    vi.stubGlobal("window", page ? { __RUNTIME_CONFIG__: runtime, location: page } : undefined);
    const module = await import("../src/constant/app-mode");
    return module.LOCAL_GATEWAY_BASE_URL;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("the gateway's address", () => {
    test("is the origin the page was served from when nothing names one", async () => {
        expect(await baseUrlWith({}, { origin: "http://192.168.3.232:8190", hostname: "192.168.3.232" })).toBe("http://192.168.3.232:8190");
    });

    test("is the address the operator named, without a trailing slash or a legacy /v1", async () => {
        expect(await baseUrlWith({ LOCAL_GATEWAY_URL: "http://127.0.0.1:8190/v1/" }, { origin: "http://127.0.0.1:3000", hostname: "127.0.0.1" })).toBe("http://127.0.0.1:8190");
    });

    test("is built from a host and a port when only those were named", async () => {
        expect(await baseUrlWith({ LOCAL_GATEWAY_HOST: "10.0.0.5", LOCAL_GATEWAY_PORT: "9000" }, { origin: "http://127.0.0.1:3000", hostname: "127.0.0.1" })).toBe("http://10.0.0.5:9000");
    });

    test("is the loopback address outside a browser, where there is no page to be relative to", async () => {
        expect(await baseUrlWith({}, null)).toBe("http://127.0.0.1:8190");
    });
});
