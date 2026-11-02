import i18n from "@/i18n";
import { LOCAL_GATEWAY_BASE_URL, isLocalGatewayUrl } from "@/constant/app-mode";
import { channelModelOf, modelImageInputs, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { dataUrlToFile } from "@/lib/image-utils";
import { mediaIdOf } from "@/services/canvas-files";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { IMAGE_ANGLE_WORKFLOW } from "@/lib/canvas/tool-workflows";
import { imageToDataUrl, type UploadedImage } from "@/services/image-storage";
import { imageSizePresets } from "@/lib/media-size";
import { apiErrorMessage, throwIfCanceled } from "@/services/api/http";
import { createRun, uploadMedia, waitForRun, type Run } from "@/services/api/runs";
import { generatedImage } from "@/lib/canvas/generated-media";
import type { ReferenceImage } from "@/types/image";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

type RequestOptions = {
    signal?: AbortSignal;
    /** The exact prompt that was sent, once it is composed: the panel shows it back to the user. */
    onPrompt?: (prompt: string) => void;
    params?: Record<string, unknown>;
    /** Reported as soon as the gateway accepts a run, so the node can resume it after a reload. */
    onRun?: (runId: string) => void;
    onProgress?: (run: Run) => void;
};

const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;

export function localGatewayRoot(baseUrl: string) {
    const url = String(baseUrl || "")
        .trim()
        .replace(/\/+$/, "");
    if (!isLocalGatewayUrl(url)) return "";
    try {
        return new URL(url).origin;
    } catch {
        return "";
    }
}

// Explicit cancellation against the local gateway: it does not rely on when the browser tears down the XHR.
/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** Map a bare ratio such as "1:1" to an explicit pixel dimension like "1024x1024". */
function resolveSize(ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const preset = imageSizePresets["1k"][ratio];
    if (preset) return preset;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    const shortSide = DEFAULT_IMAGE_SHORT_SIDE;
    const longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error(apiText("invalidImageSizeFormat"));
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error(apiText("positiveImageRatio"));
    return { width: w, height: h };
}

function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    return ratio;
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error(apiText("positiveImageDimensions"));
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error(apiText("imageDimensionStep"));
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error(apiText("imageEdgeLimit"));
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error(apiText("imagePixelLimit"));
}

function alignImageDimensions(width: number, height: number) {
    return {
        width: Math.ceil(width / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP,
        height: Math.ceil(height / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP,
    };
}

function resolveRequestSize(size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        const aligned = alignImageDimensions(dimensions.width, dimensions.height);
        validateImageSize(aligned.width, aligned.height);
        return `${aligned.width}x${aligned.height}`;
    }
    if (value.includes(":")) return resolveSize(value);
    throw new Error(apiText("invalidImageSizeFormat"));
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

async function requestGatewayImages(input: { config: AiConfig; prompt: string; references: ReferenceImage[]; size?: string; background?: string; imageMode?: string; params: Record<string, unknown>; options?: RequestOptions }): Promise<UploadedImage> {
    const { config, prompt, references, size, background, imageMode, params, options } = input;
    const inputs: Record<string, unknown> = { prompt };
    if (size) inputs.size = size;
    if (background) inputs.background = background;
    // "layout" is a MOSS mode expressed entirely by params.layout, not a workflow variant.
    if (imageMode && imageMode !== "layout") inputs.mode = imageMode;
    if (config.quality?.trim()) inputs.quality = config.quality.trim();
    Object.assign(inputs, params);

    const capacity = modelImageInputs(config, config.model);
    const usable = typeof capacity === "number" ? references.slice(0, Math.max(0, capacity)) : references;
    const media: Record<string, string[]> = {};
    for (const [index, reference] of usable.entries()) {
        const role = imageMode === "inpaint" ? (index === 0 ? "source" : "mask") : imageMode === "outpaint" ? "source" : "reference";
        media[role] = [...(media[role] || []), await mediaId(config, reference, `reference-${index + 1}.png`, options?.signal)];
    }

    try {
        const run = await createRun(config, { workflow: config.model, inputs, ...(Object.keys(media).length ? { media } : {}) });
        options?.onRun?.(run.id);
        const finished = await waitForRun(config, run.id, { signal: options?.signal, onProgress: options?.onProgress, cancelOnAbort: true });
        // The run wrote these files into the canvas; the node references them where they are (#173).
        return await generatedImage(config, finished, { signal: options?.signal });
    } catch (error) {
        throwIfCanceled(error);
        throw new Error(apiErrorMessage(error, apiText("requestFailed"), "imageTimeout"));
    }
}

/**
 * The id a run's media map takes for this reference.
 *
 * A reference that is already a canvas file (a node's picture, a mask, an upscale source) is named where it
 * is: a run looks media up by name inside its own canvas, so copying it first would store the same bytes again
 * for nothing (#174). Only a reference with no file yet — a paste, a crop, a data URL — is uploaded.
 */
async function mediaId(config: AiConfig, reference: ReferenceImage, filename: string, signal?: AbortSignal): Promise<string> {
    const existing = mediaIdOf(reference);
    if (existing) return existing;
    const dataUrl = await imageToDataUrl(reference, { signal });
    const uploaded = await uploadMedia(config, dataUrlToFile({ ...reference, dataUrl }), filename, { signal });
    return uploaded.id;
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const requestSize = resolveRequestSize(config.size);
    const background = normalizeBackground(config.background);
    const imageMode = config.imageMode || (channelModelOf(config, requestConfig.model)?.model?.workflowId === "image-qwen21" ? "t2i" : "");
    const requestParams = { ...(options?.params ?? requestConfig.params ?? {}) };
    if (imageMode === "layout" && config.layout) {
        requestParams.layout = config.layout;
        requestParams.layoutEnabled = true;
    }
    const finalPrompt = withSystemPrompt(requestConfig, prompt);
    options?.onPrompt?.(finalPrompt);
    return requestGatewayImages({
        config: requestConfig,
        prompt: finalPrompt,
        references: [],
        size: requestSize,
        background,
        imageMode,
        params: requestParams,
        options,
    });
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    const requestSize = resolveRequestSize(config.size);
    const background = normalizeBackground(config.background);
    const imageMode = String(config.imageMode || requestConfig.imageMode || "").trim();
    const requestParams = { ...(options?.params ?? requestConfig.params ?? {}) };
    if (config.imageMode === "outpaint" && config.outpaint) {
        const { left, top, right, bottom, width, height } = config.outpaint;
        // ComfyUI's ImageScaleToTotalPixels counts 1 MP as 1024², not 1e6.
        const megapixels = Math.min(16, Math.max(0.1, (width * height) / (1024 * 1024)));
        Object.assign(requestParams, { left, top, right, bottom, megapixels, outpaintWidth: width, outpaintHeight: height });
    }
    if (config.imageMode === "layout" && config.layout) {
        requestParams.layout = config.layout;
        requestParams.layoutEnabled = true;
    }
    const finalPrompt = withSystemPrompt(requestConfig, requestPrompt);
    options?.onPrompt?.(finalPrompt);
    return requestGatewayImages({
        config: requestConfig,
        prompt: finalPrompt,
        references,
        size: requestSize,
        background,
        imageMode,
        params: requestParams,
        options,
    });
}

type ImageAngleParams = {
    horizontalAngle: number;
    pitchAngle: number;
    cameraDistance: number;
    wideAngle: boolean;
};

/**
 * Re-render one image from a new camera angle.
 *
 * The angle knobs are the workflow's own inputs (`horizontalAngle`, `pitchAngle`, `cameraDistance`),
 * so this is one run with the source image as its reference — the same path every other image edit
 * takes. `wideAngle` is a UI toggle the graph has no counterpart for, so it is not sent: the gateway
 * rejects inputs a workflow does not declare, and a binding that reaches nothing would be worse than
 * leaving the knob out until the model can honour it.
 */
export async function requestImageAngle(config: AiConfig, prompt: string, params: ImageAngleParams, references: ReferenceImage[], options?: RequestOptions): Promise<UploadedImage> {
    const requestConfig = { ...resolveModelRequestConfig(config, config.imageModel || config.model), baseUrl: LOCAL_GATEWAY_BASE_URL, model: IMAGE_ANGLE_WORKFLOW };
    return requestGatewayImages({
        config: requestConfig,
        prompt,
        references,
        params: {
            horizontalAngle: params.horizontalAngle,
            pitchAngle: params.pitchAngle,
            cameraDistance: params.cameraDistance,
        },
        options,
    });
}

type UpscaleOptions = { workflowId: string; params?: Record<string, unknown>; signal?: AbortSignal };

/**
 * Upscale one image with a tool workflow, as a run.
 *
 * The chosen upscaler is a workflow id, its knobs (`upscale_model`, `resolution`) are that
 * workflow's own inputs and the source image is its media, so this is one run — the same path every
 * other image edit takes. There is no prompt: the workflow's prompt binding carries its own
 * default, and sending an undeclared key would be rejected by the typed input contract.
 */
export async function requestUpscale(config: AiConfig, image: ReferenceImage, options: UpscaleOptions) {
    const requestConfig = { ...resolveModelRequestConfig(config, config.imageModel || config.model), baseUrl: LOCAL_GATEWAY_BASE_URL, model: options.workflowId };
    try {
        const run = await createRun(requestConfig, {
            workflow: options.workflowId,
            inputs: { ...(options.params ?? {}) },
            media: { image: [await mediaId(requestConfig, image, image.name || `${image.id}.png`, options.signal)] },
        });
        const finished = await waitForRun(requestConfig, run.id, { signal: options.signal, cancelOnAbort: true });
        return await generatedImage(requestConfig, finished, { signal: options.signal });
    } catch (error) {
        throw new Error(apiErrorMessage(error, apiText("requestFailed"), "imageTimeout"));
    }
}
