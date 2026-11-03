// Runtime configuration access layer.
//
// `window.__RUNTIME_CONFIG__` is what the page reads before its own bundle runs. When the gateway serves the
// canvas it answers `/config.js` itself with the workspace preferences — and, only when the operator named
// `PUBLIC_BASE_URL`, with the gateway's address (docs/decisions.md #220). A static host with no gateway in
// the request path serves `frontend/public/config.js` instead, which assigns nothing: every reader here
// then falls back, and the preferences are read over HTTP after the first frame.
//
// The two analytics IDs that used to live here (GA4, Baidu) were deleted with the injector that was supposed
// to read them: nothing imported them, no script was ever built, and no documentation or .env entry
// mentioned them.

type RuntimeConfig = {
    /** e.g. http://127.0.0.1:8190 — written only when the canvas is served from somewhere else. */
    LOCAL_GATEWAY_URL?: string;
    /** The older shape of the same thing: a host, a port, or both, from a hand-written `config.js`. */
    LOCAL_GATEWAY_HOST?: string;
    LOCAL_GATEWAY_PORT?: string;
    /**
     * The workspace preferences, as the gateway holds them (docs/decisions.md #155).
     *
     * This is the same document `/api/settings` serves, in the script the page loads before its own bundle.
     * It is here so the theme and the language can be applied to the first frame: a preferences document
     * that only arrives over HTTP opens every dark workspace white for a moment, and every English
     * workspace in Chinese.
     */
    SETTINGS?: Record<string, unknown>;
};

declare global {
    interface Window {
        __RUNTIME_CONFIG__?: RuntimeConfig;
    }
}

const runtime: RuntimeConfig = (typeof window !== "undefined" && window.__RUNTIME_CONFIG__) || {};

function read(key: keyof RuntimeConfig, fallback = ""): string {
    const value = runtime[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    return fallback;
}

export const RUNTIME_LOCAL_GATEWAY_URL = read("LOCAL_GATEWAY_URL");
export const RUNTIME_LOCAL_GATEWAY_HOST = read("LOCAL_GATEWAY_HOST");
export const RUNTIME_LOCAL_GATEWAY_PORT = read("LOCAL_GATEWAY_PORT");

/** The bootstrapped preferences document, or `{}` when nothing assigned `window.__RUNTIME_CONFIG__`. */
export const RUNTIME_SETTINGS: Record<string, unknown> = runtime.SETTINGS && typeof runtime.SETTINGS === "object" ? runtime.SETTINGS : {};
