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
