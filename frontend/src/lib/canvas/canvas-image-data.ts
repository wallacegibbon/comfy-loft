type ImageCropRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type ImageSplitParams = {
    rows: number;
    columns: number;
    horizontalLines?: number[];
    verticalLines?: number[];
};

type ImageSplitPiece = {
    row: number;
    column: number;
    dataUrl: string;
};

export async function cropDataUrl(dataUrl: string, crop?: ImageCropRect) {
    const image = await loadDrawableImage(dataUrl);
    if (crop) {
        return drawCrop(image, Math.floor(crop.x * image.width), Math.floor(crop.y * image.height), Math.ceil(crop.width * image.width), Math.ceil(crop.height * image.height));
    }
    const size = Math.min(image.width, image.height);
    const sx = Math.max(0, Math.floor((image.width - size) / 2));
    const sy = Math.max(0, Math.floor((image.height - size) / 2));
    return drawCrop(image, sx, sy, size, size);
}

export async function splitDataUrl(dataUrl: string, params: ImageSplitParams): Promise<ImageSplitPiece[]> {
    const image = await loadDrawableImage(dataUrl);
    const xCuts = buildSplitCuts(params.verticalLines, image.width, Math.max(1, Math.floor(params.columns)));
    const yCuts = buildSplitCuts(params.horizontalLines, image.height, Math.max(1, Math.floor(params.rows)));
    const pieces: ImageSplitPiece[] = [];

    for (let row = 0; row < yCuts.length - 1; row += 1) {
        const sy = yCuts[row];
        const sh = yCuts[row + 1] - sy;
        for (let column = 0; column < xCuts.length - 1; column += 1) {
            const sx = xCuts[column];
            const sw = xCuts[column + 1] - sx;
            pieces.push({ row, column, dataUrl: drawCrop(image, sx, sy, sw, sh) });
        }
    }

    return pieces;
}

function buildSplitCuts(lines: number[] | undefined, size: number, count: number) {
    if (!lines?.length) return Array.from({ length: count + 1 }, (_, index) => Math.floor((index * size) / count));
    return [
        0,
        ...lines
            .map((line) => Math.round(line * size))
            .filter((line) => line > 0 && line < size)
            .sort((a, b) => a - b),
        size,
    ];
}

function drawCrop(image: HTMLImageElement, sx: number, sy: number, sw: number, sh: number) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sw);
    canvas.height = Math.max(1, sh);
    const context = canvas.getContext("2d");
    if (!context) return image.src;
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
}

/**
 * A picture decoded for drawing onto a canvas that will be exported.
 *
 * `canvas.toDataURL()` throws `SecurityError` — "tainted canvases may not be exported" — as soon as the
 * canvas has drawn bytes from another origin, and every picture here is from another origin: the canvas
 * bundle is served on :3000 and the gateway holding the files on :8190. The taint is not about reading
 * the pixels, it is about *how* they arrived, so the fix is at the source: `crossOrigin` asks for the
 * image in CORS mode, which the gateway already answers (its CORS middleware allows the canvas's own
 * host, `httpx.CORS`). A response that does not answer it would fail to load at all, so the last resort
 * fetches the same bytes and hands them back as a `blob:` URL — same origin by definition, therefore
 * safe to draw.
 */
export async function loadDrawableImage(src: string) {
    if (!needsCors(src)) return decodeImage(src);
    try {
        return await decodeImage(src, "anonymous");
    } catch {
        const response = await fetch(src).catch(() => null);
        if (!response?.ok) throw new Error(`image could not be read: ${src}`);
        const objectUrl = URL.createObjectURL(await response.blob());
        try {
            return await decodeImage(objectUrl);
        } finally {
            // The element keeps the decoded picture once it has loaded; only the address is released.
            URL.revokeObjectURL(objectUrl);
        }
    }
}

/** `data:` and `blob:` bytes are this document's own, so no CORS request is involved. */
function needsCors(src: string) {
    return !src.startsWith("data:") && !src.startsWith("blob:");
}

function decodeImage(src: string, crossOrigin?: "anonymous") {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        if (crossOrigin) image.crossOrigin = crossOrigin;
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`image could not be decoded: ${src}`));
        image.src = src;
    });
}
