import { getNodeSpec, NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { isInheritableNodeField, recallNodeSettings, rememberNodeSettings } from "@/lib/canvas/node-settings-memory";
import { activeFileUrl } from "@/services/canvas-files";
import type { AiConfig } from "@/stores/use-config-store";
import type { UploadedImage } from "@/services/image-storage";
import type { UploadedFile } from "@/services/file-storage";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasImageGenerationType, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type Position } from "@/types/canvas";

export function createCanvasNode(type: CanvasNodeTypeId, position: Position, metadata?: CanvasNodeMetadata): CanvasNodeData {
    const spec = getNodeSpec(type);
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const finalMetadata = { ...spec.metadata, ...(recallNodeSettings(type, metadata) || {}), ...metadata };
    rememberNodeSettings(type, finalMetadata);

    return {
        id,
        type,
        title: spec.title,
        ...("titleKey" in spec && spec.titleKey ? { titleKey: spec.titleKey } : {}),
        position: {
            x: position.x - spec.width / 2,
            y: position.y - spec.height / 2,
        },
        width: spec.width,
        height: spec.height,
        metadata: finalMetadata,
    };
}

/**
 * A node's `content` is the URL its media is *shown* from, and `storageKey` is the reference
 * (`files/<name>`) the document keeps.
 *
 * The two are not interchangeable, which is what these functions got wrong: `content` was set to the
 * reference, so a node built in this session held a `files/<name>` where every reader — a lightbox, the
 * mask and crop editors, a magnified node — expects something an `<img>` can load. It looked fine until
 * the page was reloaded, because loading a canvas is what resolves `content` to a URL
 * (`hydrateCanvasImages`). `documentOf` puts the reference back before anything is written (#152, #156).
 *
 * The URL is derived from the reference through the canvas the node belongs to, not taken from whatever
 * address the run reported: a run's absolute URL is built from the gateway's `PUBLIC_BASE_URL`, which is
 * wrong for a page opened through a name or a proxy that address does not mention. `activeFileUrl` asks the
 * same question every other renderer asks ("where is this canvas's file served from"), so the thumbnail and
 * the lightbox cannot disagree.
 */
export function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    return { content: servedUrlOf(image), storageKey: image.storageKey, status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType };
}

export function videoMetadata(video: UploadedFile): CanvasNodeMetadata {
    return { content: servedUrlOf(video), storageKey: video.storageKey, status: "success", naturalWidth: video.width, naturalHeight: video.height, bytes: video.bytes, mimeType: video.mimeType || "video/mp4", durationMs: video.durationMs };
}

export function audioMetadata(audio: UploadedFile): CanvasNodeMetadata {
    return { content: servedUrlOf(audio), storageKey: audio.storageKey, status: "success", bytes: audio.bytes, mimeType: audio.mimeType || "audio/mpeg", durationMs: audio.durationMs };
}

/** The address one of these files is served at: this canvas's file URL, then the caller's, then the reference. */
function servedUrlOf(file: { url?: string; storageKey?: string }) {
    return activeFileUrl(file.storageKey) || file.url || file.storageKey || "";
}

export function referenceUrl(image: ReferenceImage) {
    return image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

export function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, references: ReferenceImage[]): CanvasNodeMetadata {
    return {
        generationType: type,
        model: config.model,
        size: config.size,
        quality: config.quality,
        ...(config.background ? { background: config.background } : {}),
        ...(config.imageMode ? { imageMode: config.imageMode as CanvasNodeMetadata["imageMode"] } : {}),
        ...(config.imageMode === "layout" && config.layout ? { layout: config.layout } : {}),
        ...(config.outpaint ? { outpaint: config.outpaint } : {}),
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
    };
}

export function buildAudioGenerationMetadata(config: AiConfig): CanvasNodeMetadata {
    return {
        model: config.model,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions,
    };
}

export function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]>) {
    const safePatch = patch || {};
    const next = { ...node, metadata: { ...node.metadata, ...safePatch } };
    if (Object.keys(safePatch).some(isInheritableNodeField)) rememberNodeSettings(next.type, next.metadata);
    const spec = node.type === CanvasNodeType.Video ? NODE_DEFAULT_SIZE[CanvasNodeType.Video] : NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = typeof safePatch.size === "string" && !node.metadata?.content ? nodeSizeFromRatio(safePatch.size, spec.width, spec.height) : null;
    return size && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) ? { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } } : next;
}
