import { activeCanvasId, activeFileUrl, uploadCanvasFile } from "@/services/canvas-files";

/**
 * Media files, as canvas files.
 *
 * This used to be an IndexedDB blob store keyed by `video:<nanoid>`: the browser held the only copy of
 * anything a node showed, which is why the export zip had to carry every byte and why clearing site data
 * lost the workspace. The bytes now live in the canvas directory and a node names them as `files/<name>`
 * (#156), so everything here is a thin layer over that name: a URL to show it, a fetch to get it back.
 */

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const canvasId = activeCanvasId();
    if (!canvasId) throw new Error("no canvas is open");
    const uploaded = await uploadCanvasFile(canvasId, blob, outputName(prefix, blob));
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(uploaded.url) : blob.type.startsWith("audio/") ? await readAudioMeta(uploaded.url) : {};
    return { url: uploaded.url, storageKey: uploaded.key, bytes: uploaded.bytes, mimeType: uploaded.mimeType, ...meta };
}

/** The URL a reference is shown from. Synchronous in practice: a canvas file has a URL already. */
export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    return activeFileUrl(storageKey) || fallback;
}

/** The bytes behind a reference, for an export or a re-upload. */
export async function getMediaBlob(storageKey: string) {
    const url = activeFileUrl(storageKey);
    if (!url) return null;
    const response = await fetch(url);
    return response.ok ? response.blob() : null;
}

function outputName(prefix: string, blob: Blob) {
    const extension = blob.type.startsWith("video/") ? "mp4" : blob.type.startsWith("audio/") ? "mp3" : blob.type.includes("png") ? "png" : blob.type.includes("jpeg") ? "jpg" : blob.type.includes("webp") ? "webp" : "bin";
    return `${prefix}.${extension}`;
}

export function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

export function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
