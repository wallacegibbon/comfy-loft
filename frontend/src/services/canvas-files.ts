import { LOCAL_SERVER_BASE_URL } from "@/constant/app-mode";
import { httpJson } from "@/services/api/http";

/**
 * Where a canvas's media lives, and how it is named.
 *
 * Every picture and clip a node shows is a file in the canvas directory (`<CANVAS_ROOT>/<id>/files/`),
 * served by `GET /api/canvases/{id}/files/{name}` (#156). A node names it as `files/<name>` — the same
 * string in the document, in the export zip and in the URL — so a reference survives being carried from
 * one to the other without a lookup table anywhere.
 *
 * This module is the only place that knows the shape of that name. It also holds the id of the canvas
 * being edited, because the canvas is a singleton on screen: the editors, the reference bars and the
 * previews all ask "the file this node names" without carrying an id through ten call sites, and the two
 * places that operate on more than one canvas (export, import) pass the id explicitly.
 */

let active = "";

/** Point the media layer at the canvas now on screen. Called when a canvas finishes loading. */
export function setActiveCanvas(id: string) {
    active = id;
}

export function activeCanvasId(): string {
    return active;
}

/** The document form of a file name: `files/<name>`. */
function fileKey(name: string): string {
    return `files/${name}`;
}

/** The name inside a `files/<name>` reference, or "" when this is not one. */
export function fileNameOf(key: string | undefined): string {
    if (!key || !key.startsWith("files/")) return "";
    return key.slice("files/".length);
}

/**
 * The id a run's `media` map takes for a reference that is already a canvas file: the file's own name.
 *
 * A run looks its media up by name inside the canvas it belongs to, so a node's picture or clip is referenced
 * where it is instead of being copied under a new `up-` name (#174). Empty when the reference has no file yet
 * — a paste, a crop, a data URL — which is the case an upload exists for.
 */
export function mediaIdOf(reference: { storageKey?: string }): string {
    return fileNameOf(reference.storageKey);
}

/** The URL one file of a canvas is served from. */
export function canvasFileUrl(canvasId: string, key: string | undefined): string {
    const name = fileNameOf(key);
    if (!canvasId || !name) return "";
    return `${LOCAL_SERVER_BASE_URL}/api/canvases/${encodeURIComponent(canvasId)}/files/${encodeURIComponent(name)}`;
}

/** The URL of a file in the canvas being edited. */
export function activeFileUrl(key: string | undefined): string {
    return canvasFileUrl(active, key);
}

type UploadedCanvasFile = { key: string; name: string; url: string; mimeType: string; bytes: number };

/**
 * Put bytes into a canvas and get back the name they were given.
 *
 * The server names files, not the client: names are unique inside a canvas, and a client that picked
 * them would have to avoid collisions it cannot see (a run finishing in another tab, an import).
 */
export async function uploadCanvasFile(canvasId: string, blob: Blob, filename: string, signal?: AbortSignal): Promise<UploadedCanvasFile> {
    if (!canvasId) throw new Error("no canvas is open");
    const body = new FormData();
    body.append("file", blob, filename);
    const payload = await httpJson<{ upload?: { id?: string; url?: string; mime?: string; bytes?: number } }>(`${LOCAL_SERVER_BASE_URL}/api/canvases/${encodeURIComponent(canvasId)}/uploads`, {
        method: "POST",
        body,
        signal,
        timeout: 10 * 60_000,
    });
    const upload = payload?.upload;
    if (!upload?.id) throw new Error("the upload returned no file name");
    return {
        key: fileKey(upload.id),
        name: upload.id,
        url: canvasFileUrl(canvasId, fileKey(upload.id)),
        mimeType: upload.mime || blob.type || "application/octet-stream",
        bytes: typeof upload.bytes === "number" ? upload.bytes : blob.size,
    };
}
