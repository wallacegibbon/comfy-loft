import { RUNTIME_LOCAL_GATEWAY_HOST, RUNTIME_LOCAL_GATEWAY_PORT, RUNTIME_LOCAL_GATEWAY_URL } from "./runtime-config";

/**
 * The gateway's address, without an API prefix.
 *
 * It used to carry `/v1`, because the gateway spoke OpenAI's paths. It does not any more: every
 * endpoint is under `/api`, so the suffix was carried around and stripped again by each caller. What
 * is left is a URL `fetch` can append `/api/...` to, and an address a deployment can point at another
 * gateway (docs/decisions.md #72).
 *
 * Who answers this changed with #219: the gateway serves the canvas bundle itself, so the page knows
 * where the gateway is — it came from it. The address is taken from `config.js` only when the operator
 * named one (`PUBLIC_BASE_URL`, for a canvas served from another origin), because `hostname:8190` is a
 * guess that is wrong behind a LAN name, a phone or a reverse proxy, which is exactly the case it used
 * to be written for.
 */
function runtimeGatewayBaseUrl() {
    if (RUNTIME_LOCAL_GATEWAY_URL) return gatewayRoot(RUNTIME_LOCAL_GATEWAY_URL);
    if (RUNTIME_LOCAL_GATEWAY_HOST || RUNTIME_LOCAL_GATEWAY_PORT) {
        const host = RUNTIME_LOCAL_GATEWAY_HOST || pageHostname() || "127.0.0.1";
        const port = RUNTIME_LOCAL_GATEWAY_PORT || "8190";
        return `http://${host}:${port}`;
    }
    // Nothing named: this page came from the gateway, so it is this origin — the only answer that
    // survives a LAN name, a phone or a reverse proxy. Outside a browser there is no page to be relative
    // to, and every caller here builds an absolute URL (`new URL`, `localGatewayRoot`), so the loopback
    // address the gateway defaults to is the honest answer.
    return pageOrigin() || "http://127.0.0.1:8190";
}

/**
 * Normalize any gateway address to its root.
 *
 * A trailing `/v1` is still tolerated: an older `dist/config.js` (or a hand-written channel entry)
 * can carry one, and stripping it here is what keeps the suffix from spreading again.
 */
export function gatewayRoot(url: string) {
    return String(url || "")
        .trim()
        .replace(/\/+$/, "")
        .replace(/\/v1$/i, "");
}

/** The origin this page was served from — the gateway's own, once the gateway serves the bundle (#219). */
function pageOrigin(): string {
    if (typeof window === "undefined") return "";
    return window.location?.origin || "";
}

// The gateway listens on the machine that serves this bundle, so the page's own hostname is
// the right address for it: a canvas opened as http://192.168.3.232:3000 must reach
// http://192.168.3.232:8190, not the loopback of whatever device holds the browser. Only a
// non-browser context falls back to 127.0.0.1. This is left for a `config.js` that names a host and
// no port — the shape a hand-written channel entry still can have.
function pageHostname(): string {
    if (typeof window === "undefined") return "";
    return window.location?.hostname || "";
}

export const LOCAL_GATEWAY_BASE_URL = import.meta.env.VITE_LOCAL_GATEWAY_URL ? gatewayRoot(import.meta.env.VITE_LOCAL_GATEWAY_URL) : runtimeGatewayBaseUrl();
export const LOCAL_GATEWAY_ORIGIN = (() => {
    try {
        return new URL(LOCAL_GATEWAY_BASE_URL).origin;
    } catch {
        return "";
    }
})();
export const LOCAL_GATEWAY_CHANNEL_ID = "local-gateway";

// There is no hardcoded model list. A model is a workflow, and the gateway reports which ones it has
// (`GET /api/workflows`); a list in the bundle drifted from the registry every time a workflow was
// added or removed — it still named two that no longer exist. The channel starts empty and the sync
// fills it (hooks/use-local-gateway-sync.ts).

export function isLocalGatewayUrl(url: string) {
    try {
        const parsed = new URL(String(url || ""));
        if (LOCAL_GATEWAY_ORIGIN && parsed.origin === LOCAL_GATEWAY_ORIGIN) return true;
        return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
    } catch {
        return false;
    }
}
