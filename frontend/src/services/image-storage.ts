import i18n from "@/i18n";
import type { RunFacts } from "@/services/api/runs";
import { activeCanvasId, activeFileUrl, uploadCanvasFile } from "@/services/canvas-files";

/**
 * Images, as canvas files.
 *
 * Both the bytes and the thumbnails used to live in IndexedDB: `image_files` held every picture a node
 * showed and `image_previews` held a WebP per picture, generated in this browser and valid only in this
 * browser. The originals now live in the canvas directory (#156) and are addressed by `files/<name>`;
 * the *browser* HTTP cache replaces the previews, because a canvas file's name never changes, so its URL
 * is its ETag.
 *
 * The exported names are unchanged on purpose: `resolveImageUrl` still answers "what do I put in an
 * `img src`", and every caller kept working when the answer stopped being a blob URL.
 */

export type UploadedImage = {
    url: string;
    storageKey?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
    /**
     * The run that made it, when a run did.
     *
     * It rides on the artifact rather than on the node because the artifact is the only thing the run's
     * result and the node's metadata have in common: every path from a finished run to a node goes through
     * here, so "what made this picture, and when" cannot be forgotten by one of them and remembered by
     * another. A picked file, a crop of one, a pasted picture: no run, no field (docs/decisions.md #227).
     */
    run?: RunFacts;
};

type ImageReadOptions = { signal?: AbortSignal };

const IMAGE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_DECODE_TIMEOUT_MS = 10_000;
const IMAGE_RESPONSE_ERROR = "ImageResponseError";
const IMAGE_TIMEOUT_ERROR = "ImageTimeoutError";

/**
 * A picture as a canvas file: the bytes are downloaded first when all there is to start with is a URL.
 *
 * There is no path that keeps the URL itself. A reference the canvas cannot serve is not a reference this
 * build can draw after a reload, and storing the address would put an absolute `http://…` into the document
 * — the thing #152 is about. Nothing reaches here with a URL it cannot fetch either: every caller hands over
 * a `File`, a paste, or a data URL.
 */
export async function uploadImage(input: string | Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    if (typeof input !== "string") return storeImage(input, options);
    return storeImage(await fetchImageBlob(input, options), options);
}

async function storeImage(blob: Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    const canvasId = activeCanvasId();
    if (!canvasId) throw new Error(i18n.t("apiErrors.noCanvas"));
    // A blob URL holds the blob alive for the life of the document, so it is released as soon as the
    // dimensions are read: one per generated picture is a leak nobody would look for.
    const objectUrl = URL.createObjectURL(blob);
    let meta: { width: number; height: number } | null;
    try {
        meta = await loadImageMeta(objectUrl, options);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
    if (!meta) throw new Error(i18n.t("common.imageReadFailed"));
    throwIfAborted(options?.signal);
    const uploaded = await uploadCanvasFile(canvasId, blob, `image.${extensionOf(blob)}`, options?.signal);
    return { url: uploaded.url, storageKey: uploaded.key, width: meta.width, height: meta.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType.startsWith("image/") ? uploaded.mimeType : "" };
}

/**
 * A picture's size, read from where it is served.
 *
 * This is what a generated image needs before it becomes a node: the run already wrote the file into the
 * canvas, so there is nothing to upload — only something to measure (decisions #173).
 */
export async function readImageSize(url: string, options?: ImageReadOptions): Promise<{ width: number; height: number } | null> {
    return loadImageMeta(url, options);
}

/** Where an image reference is shown from. Empty for a reference this build cannot resolve. */
export async function resolveImageUrl(storageKey?: string, fallback = "") {
    return activeFileUrl(storageKey) || fallback;
}

/** Thumbnails are the browser's job now: the same URL, cached by the HTTP layer. */
export function previewUrlFor(storageKey?: string) {
    const url = activeFileUrl(storageKey);
    return url || undefined;
}

/** Kept for the components that re-render when a preview appears; nothing appears later now. */
export function subscribeImagePreviews(_listener: () => void) {
    return () => {};
}

export function getImagePreviewRevision() {
    return 0;
}

export async function ensureImagePreview(storageKey?: string) {
    return previewUrlFor(storageKey);
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }, options?: ImageReadOptions) {
    const url = image.dataUrl || activeFileUrl(image.storageKey) || image.url || "";
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await fetchImageBlob(url, options));
}

function extensionOf(blob: Blob) {
    if (blob.type.includes("png")) return "png";
    if (blob.type.includes("jpeg")) return "jpg";
    if (blob.type.includes("webp")) return "webp";
    if (blob.type.includes("gif")) return "gif";
    return "png";
}

async function fetchImageBlob(url: string, options?: ImageReadOptions) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, IMAGE_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw namedError(IMAGE_RESPONSE_ERROR);
        return await response.blob();
    } catch (error) {
        if (timedOut) throw namedError(IMAGE_TIMEOUT_ERROR);
        if (options?.signal?.aborted) throw abortReason(options.signal);
        throw error;
    } finally {
        window.clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    }
}

function loadImageMeta(url: string, options?: ImageReadOptions, timeoutMs = IMAGE_DECODE_TIMEOUT_MS) {
    return new Promise<{ width: number; height: number } | null>((resolve, reject) => {
        if (options?.signal?.aborted) return reject(abortReason(options.signal));
        const image = new Image();
        let settled = false;
        const finish = (value: { width: number; height: number } | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            options?.signal?.removeEventListener("abort", abort);
            image.onload = null;
            image.onerror = null;
            resolve(value);
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            reject(abortReason(options!.signal!));
        };
        const timer = window.setTimeout(() => finish(null), timeoutMs);
        options?.signal?.addEventListener("abort", abort, { once: true });
        image.onload = () => finish(image.naturalWidth && image.naturalHeight ? { width: image.naturalWidth, height: image.naturalHeight } : null);
        image.onerror = () => finish(null);
        image.src = url;
    });
}

function namedError(name: string) {
    const error = new Error(i18n.t("common.imageReadFailed"));
    error.name = name;
    return error;
}

function abortReason(signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortReason(signal);
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}
