const CANVAS_IMAGE_PREVIEW_MAX_EDGE = 768;

type ImageSourceChoice = {
    previewUrl?: string;
    originalUrl: string;
    naturalWidth?: number;
    naturalHeight?: number;
    renderedWidth: number;
    renderedHeight: number;
    scale: number;
    devicePixelRatio?: number;
    previewMaxEdge?: number;
};

// Small previews keep panning cheap, but they look soft once the node is magnified.
// Use the original only when the on-screen size actually needs more pixels than the preview holds.
//
// Since #156 the canvas keeps no thumbnails: a file's URL is its own ETag and the browser caches it, so
// `previewUrl` is the same URL as `originalUrl` and this collapses to "the original". It is kept because
// it is the one place that decides which URL a node renders, and the shape is what a server-side thumbnail
// would plug into.
export function pickImageSource({ previewUrl, originalUrl, naturalWidth, naturalHeight, renderedWidth, renderedHeight, scale, devicePixelRatio = globalThis.devicePixelRatio || 1, previewMaxEdge = CANVAS_IMAGE_PREVIEW_MAX_EDGE }: ImageSourceChoice) {
    if (!previewUrl) return originalUrl;
    const naturalLongEdge = Math.max(naturalWidth || 0, naturalHeight || 0);
    const previewLongEdge = naturalLongEdge > 0 ? Math.min(previewMaxEdge, naturalLongEdge) : previewMaxEdge;
    const requiredLongEdge = Math.max(renderedWidth, renderedHeight) * scale * devicePixelRatio;
    return requiredLongEdge > previewLongEdge ? originalUrl : previewUrl;
}
