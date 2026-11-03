import { readSetting, writeSetting } from "@/stores/use-settings-store";

/**
 * The canvas you were last inside.
 *
 * This is the one preference that is genuinely about a person rather than a workspace, and it lives in
 * the workspace's settings anyway (#155): the alternative was a `localStorage` key that made the
 * workspace unresolved from a second browser, and "open where I left off" was the most obviously wrong
 * thing to lose there. Two people sharing a server share this, which is a cost worth naming and not
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
 * Ordered by the parsed timestamp, not by the string. The server writes RFC3339 with Go's nanoseconds,
 * which drops trailing zeros, so two canvases saved in the same second compare the wrong way round as text
 * — `…34.9Z` sorts after `…34.916503133Z` byte-wise because `Z` > `1`. Ties keep the first entry, which is
 * the order the server lists them in (newest first).
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
 * Newest canvas first, for the list in the left column.
 *
 * By *creation*, not by the last write, and that is the whole point (#198): the list sits under the pointer
 * while you work, and a canvas that jumps to the top because it was just saved — which happens on every
 * edit, to the canvas you are looking at — is a list that moves under the cursor and can be misclicked.
 * Creation order never changes for a canvas, so switching between them only changes which row is
 * highlighted.
 *
 * The same parse as `newestCanvasId`, for the same reason: the timestamp is an instant written as text, and
 * two canvases made in the same second do not sort like text. Ties fall back to the id.
 */
export function byCreatedAtDesc(left: { id: string; createdAt: string }, right: { id: string; createdAt: string }): number {
    const leftAt = Date.parse(left.createdAt);
    const rightAt = Date.parse(right.createdAt);
    const leftStamp = Number.isFinite(leftAt) ? leftAt : Number.NEGATIVE_INFINITY;
    const rightStamp = Number.isFinite(rightAt) ? rightAt : Number.NEGATIVE_INFINITY;
    if (leftStamp !== rightStamp) return rightStamp - leftStamp;
    return left.id.localeCompare(right.id);
}
