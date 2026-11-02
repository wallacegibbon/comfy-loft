import { readSetting, writeSetting } from "@/stores/use-settings-store";

/**
 * The canvas you were last inside.
 *
 * This is the one preference that is genuinely about a person rather than a workspace, and it lives in
 * the workspace's settings anyway (#155): the alternative was a `localStorage` key that made the
 * workspace unresolved from a second browser, and "open where I left off" was the most obviously wrong
 * thing to lose there. Two people sharing a gateway share this, which is a cost worth naming and not
 * worth a second storage mechanism.
 */

const KEY = "lastCanvas";

export function lastCanvasId(): string {
    const id = readSetting<string>(KEY, "");
    return typeof id === "string" ? id : "";
}

export function rememberLastCanvas(id: string) {
    if (lastCanvasId() !== id) writeSetting(KEY, id);
}

export function forgetLastCanvas(id: string) {
    if (lastCanvasId() === id) writeSetting(KEY, "");
}

/**
 * The canvas to open when there is nothing remembered: the one written most recently.
 *
 * Ordered by the parsed timestamp, not by the string. The gateway writes RFC3339 with Go's nanoseconds,
 * which drops trailing zeros, so two canvases saved in the same second compare the wrong way round as text
 * — `…34.9Z` sorts after `…34.916503133Z` byte-wise because `Z` > `1`. Ties keep the first entry, which is
 * the order the gateway lists them in (newest first).
 */
export function newestCanvasId(canvases: Array<{ id: string; updatedAt: string }>): string {
    let newest = "";
    let newestAt = Number.NEGATIVE_INFINITY;
    for (const canvas of canvases) {
        const parsed = Date.parse(canvas.updatedAt);
        const at = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
        if (!newest || at > newestAt) {
            newest = canvas.id;
            newestAt = at;
        }
    }
    return newest;
}

/**
 * Most recently written first, for any list of canvases.
 *
 * The same parse as `newestCanvasId`, for the same reason: `updatedAt` is an instant written as text, and
 * the text does not sort like the instant. Ties fall back to the id so the order of two canvases saved in
 * the same millisecond is stable rather than whichever the server happened to send first.
 */
export function byUpdatedAtDesc(left: { id: string; updatedAt: string }, right: { id: string; updatedAt: string }): number {
    const leftAt = Date.parse(left.updatedAt);
    const rightAt = Date.parse(right.updatedAt);
    const leftStamp = Number.isFinite(leftAt) ? leftAt : Number.NEGATIVE_INFINITY;
    const rightStamp = Number.isFinite(rightAt) ? rightAt : Number.NEGATIVE_INFINITY;
    if (leftStamp !== rightStamp) return rightStamp - leftStamp;
    return left.id.localeCompare(right.id);
}
