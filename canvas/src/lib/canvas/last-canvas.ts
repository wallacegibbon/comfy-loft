/**
 * The canvas the browser was last inside.
 *
 * This is a preference, not workspace state: it says where *you* were, and two people opening the same
 * workspace from two machines should land where each of them left off. It lives in `localStorage` for
 * one more entry — the preferences endpoint (`/api/settings`) is the next step, and every other
 * browser-stored preference moves with it (#155). Keeping it here until then is cheaper than two
 * rewrites of the same three call sites.
 */

const KEY = "comfyloft:last_canvas";

export function lastCanvasId(): string {
    try {
        return window.localStorage.getItem(KEY) || "";
    } catch {
        // Storage can be denied (private mode, an embedding policy). Not remembering is survivable.
        return "";
    }
}

export function rememberLastCanvas(id: string) {
    try {
        window.localStorage.setItem(KEY, id);
    } catch {
        // See above: the cost is landing on the newest canvas instead of the last one.
    }
}

export function forgetLastCanvas(id: string) {
    try {
        if (window.localStorage.getItem(KEY) === id) window.localStorage.removeItem(KEY);
    } catch {
        // Nothing to do: a stale id is caught by the lookup in entry.tsx.
    }
}
