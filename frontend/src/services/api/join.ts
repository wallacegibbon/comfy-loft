import { LOCAL_SERVER_BASE_URL } from "@/constant/app-mode";
import { canvasFileUrl, fileNameOf } from "@/services/canvas-files";
import { apiErrorMessage, httpJson } from "@/services/api/http";
import type { UploadedFile } from "@/services/file-storage";

/**
 * Join several of a canvas's own clips into one — the one media operation the browser cannot do.
 *
 * A frame can be taken from a clip by drawing it on a canvas, which is why `captureFrame` lives in the page.
 * A file cannot: making one clip out of several means muxing H.264 streams, and the browser has no muxer
 * (WebCodecs would mean writing one, and it still could not stream-copy). So this is the server's, and the
 * page's job is only to say which files and in what order.
 *
 * What comes back is shaped like an upload — the same `UploadedFile` a run's artifact or a dropped file is —
 * so the node that shows it is made by the same builders as any other clip, and nothing downstream has to
 * know a join happened.
 */

type JoinPayload = {
    upload?: { id?: string; mime?: string; bytes?: number };
    /** The joined clip's own length and picture size, probed by the server: the page cannot measure a file it
     *  has not downloaded, and a node's card and its duration come from these three numbers. */
    durationMs?: number;
    width?: number;
    height?: number;
    mode?: "copy" | "reencode";
};

type JoinedClip = {
    file: UploadedFile;
    /** Whether the server copied the streams or re-encoded them — the second only when the inputs disagreed. */
    mode: "copy" | "reencode";
};

/**
 * Ask the server to join these canvas files, in this order.
 *
 * The files are named the way the document names them (`files/<name>`), because that is the one form the
 * page has: a node's `storageKey`. A refusal is the server's own sentence — "clip-2 is 25 fps, clip-1 is
 * 24 fps" — and is thrown, not swallowed, so the caller can say it to the user or the agent.
 */
export async function joinCanvasFiles(canvasId: string, files: string[], options?: { reencode?: boolean }): Promise<JoinedClip> {
    if (!canvasId) throw new Error("no canvas is open");
    const names = files.map((file) => fileNameOf(file)).filter(Boolean);
    if (names.length < 2) throw new Error("joining needs at least two clips");
    let payload: JoinPayload;
    try {
        payload = await httpJson<JoinPayload>(`${LOCAL_SERVER_BASE_URL}/api/canvases/${encodeURIComponent(canvasId)}/join`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ files: names, ...(options?.reencode ? { reencode: true } : {}) }),
            // A copy is instant; a re-encode of a few minutes is not, and the server gives up before this does.
            timeout: 15 * 60_000,
        });
    } catch (error) {
        throw new Error(apiErrorMessage(error, "joining the clips failed"));
    }
    const upload = payload?.upload;
    if (!upload?.id) throw new Error("the join returned no file name");
    const key = `files/${upload.id}`;
    return {
        mode: payload.mode === "reencode" ? "reencode" : "copy",
        file: {
            url: canvasFileUrl(canvasId, key),
            storageKey: key,
            bytes: typeof upload.bytes === "number" ? upload.bytes : 0,
            mimeType: upload.mime || "video/mp4",
            width: payload.width,
            height: payload.height,
            durationMs: payload.durationMs,
        },
    };
}
