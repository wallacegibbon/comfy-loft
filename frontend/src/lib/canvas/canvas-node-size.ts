import type { CanvasNodeData } from "@/types/canvas";

export function fitNodeSize(width: number, height: number, maxWidth = 640, maxHeight = 640) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    return { width: w * scale, height: h * scale };
}

/**
 * The smallest a card may be: one number for the user's drag and for anything else that resizes a card.
 *
 * The drag clamped to these and nothing else did, so an agent asking for a 100-pixel card had no floor to be
 * told about. They are the same two numbers, in the one place both readers look.
 */
export const NODE_MIN_SIZE = { width: 220, height: 160 };

/**
 * The shape a card holds: the picture's own pixels when they are known, else the card's current box.
 *
 * A card that frames a picture keeps this ratio when it is resized, and its own metadata is what says so —
 * `naturalWidth`/`naturalHeight` are written when the picture arrives. A card with neither (an empty one, or
 * one written before they were recorded) keeps the shape it happens to have, which is why the fallback is the
 * box rather than a constant.
 */
export function nodeRatio(node: Pick<CanvasNodeData, "width" | "height" | "metadata">) {
    const width = node.metadata?.naturalWidth || node.width;
    const height = node.metadata?.naturalHeight || node.height || 1;
    return width / Math.max(1, height);
}

export function nodeSizeFromRatio(size: string, baseWidth: number, baseHeight: number) {
    const match = size?.match(/^(\d+)(?:x|:)(\d+)/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const ratio = width / Math.max(1, height);
    if (ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
    return ratio >= baseWidth / baseHeight ? { width: baseWidth, height: baseWidth / ratio } : { width: baseHeight * ratio, height: baseHeight };
}
