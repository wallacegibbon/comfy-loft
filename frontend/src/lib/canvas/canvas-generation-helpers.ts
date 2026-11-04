import { defaultConfig, resolveModelForCapability, type AiConfig } from "@/stores/use-config-store";
import i18n from "@/i18n";
import { ensureImagePreview, resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { referenceUrl } from "@/lib/canvas/canvas-node-factory";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import type { ReferenceImage } from "@/types/image";
import { RunFailedError } from "@/services/api/runs";
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
        audioFormat: node?.metadata?.audioFormat || config.audioFormat || defaultConfig.audioFormat,
        audioSeconds: node?.metadata?.seconds || config.audioSeconds || defaultConfig.audioSeconds,
        audioInstructions: node?.metadata?.audioInstructions || config.audioInstructions || defaultConfig.audioInstructions,
        params: Object.keys(params).length ? params : undefined,
    };
}

/** The content a run produces: the three kinds the server generates into a node. */
const RUN_CONTENT_TYPES = [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio];

/**
 * A node whose run was still out when the page went away.
 *
 * The run belongs to the server, not to the page, so the only thing that has to survive is the id the
 * node keeps in `runId` — and the answer is the same for every kind of content. It used to be three
 * predicates with three names for the field and a status check on two of them, so a single failed check
 * left an audio or image node unable to re-attach at all, while video re-attached whatever its status
 * said (#235).
 */
export function hasResumableRun(node: CanvasNodeData) {
    return RUN_CONTENT_TYPES.includes(node.type as CanvasNodeType) && Boolean(node.metadata?.runId) && !node.metadata?.content;
}

/**
 * What a canvas written before `runId` had one name looks like when it is opened.
 *
 * The three old names — `videoTaskId`, `audioRunId`, `imageRunId` — are read into `runId` and dropped, so
 * a run that was in flight when that build wrote the file is still picked up. Saved data, so the fields are
 * read through a record: the type has no room for them any more.
 */
export function adoptLegacyRunIds(nodes: CanvasNodeData[]) {
    return nodes.map((node) => {
        const metadata = node.metadata as Record<string, unknown> | undefined;
        if (!metadata) return node;
        const legacy = [metadata.videoTaskId, metadata.audioRunId, metadata.imageRunId].find((value) => typeof value === "string" && value) as string | undefined;
        if (!legacy) return node;
        const { videoTaskId: _video, audioRunId: _audio, imageRunId: _image, ...rest } = metadata;
        return { ...node, metadata: { ...rest, runId: node.metadata?.runId || legacy } };
    });
}

/**
 * What a failed watch leaves on the node: the words it shows, and whether the run id stays.
 *
 * Two very different things end a watch, and only one of them is about the run. `RunFailedError` is the
 * server answering — the run failed or was cancelled — so the node says that and lets the id go. Anything
 * else is the question not getting there: the run may be rendering still, so the node keeps the id, says it
 * could not confirm it, and the next canvas open picks the watch up (#235).
 *
 * One function for the three modes: video used to wrap its failures in a name of its own, and the three
 * endings had drifted apart with it.
 */
export function runWatchEnded(error: unknown) {
    return error instanceof RunFailedError;
}

/** `failedWatch`'s four lines, once: the words to show, and whether the run id has a run left behind it. */
export function failedWatch(error: unknown, fallback: string) {
    const ended = runWatchEnded(error);
    // A blank reason would read as "could not confirm the run ()" — the caller's sentence is better there.
    const reason = error instanceof Error && error.message ? error.message : fallback;
    return { ended, errorDetails: ended ? reason : i18n.t("canvas.runtime.runUnwatched", { reason }) };
}

/**
 * What a node looks like when the page is opened on it again.
 *
 * A node that was waiting on a run keeps waiting — the run is the server's, and it is still out. Any
 * other node that was `loading` is told the truth instead of being left spinning: the work stopped with
 * the page, and the reason says so. Errors already on the canvas are left alone: they are what happened,
 * and clearing them on open is how a failure became invisible (#235).
 */
export function resetInterruptedGeneration(nodes: CanvasNodeData[]) {
    return nodes.map((node) =>
        node.metadata?.status === "loading" && !hasResumableRun(node)
            ? {
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
