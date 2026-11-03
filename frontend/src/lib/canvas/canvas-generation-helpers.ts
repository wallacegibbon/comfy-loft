import { defaultConfig, resolveModelForCapability, type AiConfig } from "@/stores/use-config-store";
import i18n from "@/i18n";
import { ensureImagePreview, resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { referenceUrl } from "@/lib/canvas/canvas-node-factory";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

export function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

export function generationReferenceUrls(context: { referenceImages: ReferenceImage[]; referenceVideos: Array<{ storageKey?: string; url?: string }>; referenceAudios?: Array<{ storageKey?: string; url?: string }> }) {
    return [
        ...context.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
        ...context.referenceVideos.map((video) => video.storageKey || video.url).filter((url): url is string => Boolean(url)),
        ...(context.referenceAudios || []).map((audio) => audio.storageKey || audio.url).filter((url): url is string => Boolean(url)),
    ];
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    return Promise.all(
        nodes.map(async (node) => {
            const metadata = node.metadata;
            const content = metadata?.content;
            if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && metadata?.storageKey) return { ...node, metadata: { ...metadata, content: await resolveMediaUrl(metadata.storageKey, content) } };
            if (node.type !== CanvasNodeType.Image || !metadata || !metadata.storageKey) return node;
            void ensureImagePreview(metadata.storageKey);
            return { ...node, metadata: { ...metadata, content: await resolveImageUrl(metadata.storageKey, content) } };
        }),
    );
}

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    const params = { ...(node?.metadata?.params || config.params || {}) };
    const seedFixed = (node?.metadata?.seedFixed ?? config.seedFixed ?? "") === "true";
    const seed = String(node?.metadata?.seed ?? config.seed ?? "").trim();
    if (seedFixed && seed) params.seed = seed;
    else delete params.seed;
    return {
        ...config,
        seed,
        seedFixed: seedFixed ? "true" : "false",
        model: resolveModelForCapability(config, node?.metadata?.model, mode),
        quality: node?.metadata?.quality || config.quality || defaultConfig.quality,
        size: node?.metadata?.size || config.size || defaultConfig.size,
        background: node?.metadata?.background ?? "",
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || defaultConfig.videoSeconds,
        vquality: node?.metadata?.vquality || config.vquality || defaultConfig.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio || config.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark || config.videoWatermark || defaultConfig.videoWatermark,
        videoMode: node?.metadata?.videoMode || config.videoMode || defaultConfig.videoMode,
        videoSelfLiftMode: node?.metadata?.videoSelfLiftMode || config.videoSelfLiftMode || defaultConfig.videoSelfLiftMode,
        frameMode: node?.metadata?.frameMode || config.frameMode,
        imageMode: node?.metadata?.imageMode || config.imageMode || "",
        outpaint: node?.metadata?.outpaint || config.outpaint,
        layout: node?.metadata?.layout || config.layout,
        audioVoice: node?.metadata?.audioVoice || config.audioVoice || defaultConfig.audioVoice,
        audioFormat: node?.metadata?.audioFormat || config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed || config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node?.metadata?.audioInstructions || config.audioInstructions || defaultConfig.audioInstructions,
        params: Object.keys(params).length ? params : undefined,
    };
}

export function hasResumableVideoTask(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Video && Boolean(node.metadata?.videoTaskId) && !node.metadata?.content;
}

/**
 * An audio node whose run is still in flight. The gateway keeps the run when the page goes away, so
 * the node stays `loading` and is polled again after a reload instead of being marked interrupted.
 * Only loading nodes qualify: an error node keeps its last run id, but resuming it would be noise.
 */
export function hasResumableAudioRun(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Audio && node.metadata?.status === "loading" && Boolean(node.metadata?.audioRunId) && !node.metadata?.content;
}

/**
 * An image node whose batch run is still in flight.
 *
 * The slots (`metadata.images`) are written before the run is submitted, so a reload finds the same
 * placeholders the live request would have filled: resuming is one poll and a fill per slot, not a
 * second batch.
 */
export function hasResumableImageRun(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Image && node.metadata?.status === "loading" && Boolean(node.metadata?.imageRunId) && !node.metadata?.content;
}

export function resetInterruptedGeneration(nodes: CanvasNodeData[]) {
    return nodes.map((node) =>
        node.metadata?.status === "loading"
            ? hasResumableVideoTask(node) || hasResumableAudioRun(node) || hasResumableImageRun(node)
                ? node
                : {
                      ...node,
                      metadata: {
                          ...node.metadata,
                          status: "error" as const,
                          errorDetails: i18n.t("canvas.generation.interrupted"),
                          texts: node.metadata.texts?.map((text) => (text.status === "loading" ? { ...text, status: "error" as const, errorDetails: i18n.t("canvas.generation.interrupted") } : text)),
                      },
                  }
            : node,
    );
}

export function clearStaleNodeErrors(nodes: CanvasNodeData[]) {
    return nodes.map((node) => (node.metadata?.status === "error" ? { ...node, metadata: { ...node.metadata, status: "idle" as const, errorDetails: undefined } } : node));
}

/**
 * Whether this error is the user stopping, rather than something going wrong.
 *
 * By name: every service rethrows a cancellation as an `AbortError` before wrapping an error into a sentence
 * (`throwIfCanceled`), so the test does not depend on which words the dictionary happens to use for it. It used
 * to compare two translated strings, which agreed by luck.
 */
export function isGenerationCanceled(error: unknown) {
    return error instanceof Error && error.name === "AbortError";
}

export function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
}

function angleViewLabel(signed: number) {
    const abs = Math.abs(signed);
    const right = signed > 0;
    if (abs <= 15) return i18n.t("canvas.generation.viewFront");
    if (abs <= 45) return i18n.t(right ? "canvas.generation.viewFrontRight" : "canvas.generation.viewFrontLeft");
    if (abs <= 75) return i18n.t(right ? "canvas.generation.viewSideRight" : "canvas.generation.viewSideLeft");
    if (abs <= 135) return i18n.t(right ? "canvas.generation.viewBackSideRight" : "canvas.generation.viewBackSideLeft");
    return i18n.t(right ? "canvas.generation.viewBackRight" : "canvas.generation.viewBackLeft");
}

function angleShotLabel(distance: number) {
    if (distance <= 2.5) return i18n.t("canvas.generation.shotClose");
    if (distance <= 5) return i18n.t("canvas.generation.shotMedium");
    if (distance <= 7.5) return i18n.t("canvas.generation.shotMediumWide");
    return i18n.t("canvas.generation.shotWide");
}

export function buildAngleLabel(params: CanvasImageAngleParams) {
    const raw = ((params.horizontalAngle % 360) + 360) % 360;
    const signed = raw > 180 ? raw - 360 : raw;
    const horizontal = signed === 0 ? i18n.t("canvas.generation.front") : signed > 0 ? i18n.t("canvas.generation.rotateRight", { angle: Math.round(signed) }) : i18n.t("canvas.generation.rotateLeft", { angle: Math.abs(Math.round(signed)) });
    const pitch = params.pitchAngle === 0 ? i18n.t("canvas.generation.level") : params.pitchAngle > 0 ? i18n.t("canvas.generation.topDown", { angle: params.pitchAngle }) : i18n.t("canvas.generation.lowAngle", { angle: Math.abs(params.pitchAngle) });
    return i18n.t("canvas.generation.angleLabel", {
        view: angleViewLabel(signed),
        horizontal,
        pitch,
        shot: angleShotLabel(params.cameraDistance),
        distance: params.cameraDistance.toFixed(1),
        lens: i18n.t(params.wideAngle ? "canvas.editors.wide" : "canvas.editors.standard"),
    });
}

export function buildAnglePrompt(params: CanvasImageAngleParams) {
    return i18n.t("canvas.generation.anglePrompt", { angle: buildAngleLabel(params) });
}
