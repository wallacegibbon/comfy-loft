import i18n from "@/i18n";
import { LOCAL_SERVER_BASE_URL, isLocalServerUrl } from "@/constant/app-mode";
import { modelImageInputs, modelIsStep, modelTakesPrompt, acceptedInputs, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { imageModeFor } from "@/lib/canvas/image-mode";
import { dataUrlToFile } from "@/lib/image-utils";
import { mediaIdOf } from "@/services/canvas-files";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { IMAGE_ANGLE_WORKFLOW } from "@/lib/canvas/tool-workflows";
import { imageToDataUrl, type UploadedImage } from "@/services/image-storage";
import { imageSizePresets } from "@/lib/media-size";
import { apiErrorMessage, throwIfCanceled } from "@/services/api/http";
import { createRun, uploadMedia, waitForRun, type Run, type RunRequest } from "@/services/api/runs";
import { generatedImage } from "@/lib/canvas/generated-media";
import type { ReferenceImage } from "@/types/image";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

type RequestOptions = {
    signal?: AbortSignal;
    /** The exact prompt that was sent, once it is composed: the panel shows it back to the user. */
    onPrompt?: (prompt: string) => void;
    params?: Record<string, unknown>;
    /** Reported as soon as the server accepts a run, so the node can resume it after a reload. */
    onRun?: (runId: string) => void;
    onProgress?: (run: Run) => void;
    /** The agent that asked for this generation, if one did: the server tells it when the run ends. */
    askedBy?: RunRequest["askedBy"];
};

const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;

export function localServerRoot(baseUrl: string) {
    const url = String(baseUrl || "")
        .trim()
        .replace(/\/+$/, "");
    if (!isLocalServerUrl(url)) return "";
    try {
        return new URL(url).origin;
    } catch {
        return "";
    }
}

// Explicit cancellation against the local server: it does not rely on when the browser tears down the XHR.
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

type ImageSizeProblem = "format" | "positive" | "step" | "edge" | "ratio" | "pixels";

const SIZE_PROBLEM_KEYS: Record<ImageSizeProblem, string> = {
    format: "invalidImageSizeFormat",
    positive: "positiveImageDimensions",
    step: "imageDimensionStep",
    edge: "imageEdgeLimit",
    ratio: "imageRatioLimit",
    pixels: "imagePixelLimit",
};

/**
 * What a size is, or what is wrong with it — the one decision behind every reader.
 *
 * `validateImageSize` refuses, `resolveRequestSize` normalises, and the agent's `set_node` asks before
 * it writes a value into a node: three audiences, one answer. The alternative was a second opinion about sizes
 * in the tool, where "1024x1000 is fine because the request aligns it" and "1024x1000 is refused" could both be
 * true in the same build.
 *
 * `kind: "pixels"` is the size a run will get, aligned up to the step the panel's own inputs align to. A ratio
 * is a shape rather than a size — only a run knows what short side the canvas gives it — so it is its own kind
 * and the caller decides whether it can take one.
 */
type PlannedImageSize = { kind: "auto" } | { kind: "pixels"; size: string; width: number; height: number } | { kind: "ratio"; ratio: string } | { kind: "invalid"; problem: ImageSizeProblem };

/** What is wrong with these pixel dimensions, or null when a run would take them. */
function sizeProblem(width: number, height: number): ImageSizeProblem | null {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return "positive";
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) return "step";
    if (Math.max(width, height) > IMAGE_MAX_EDGE) return "edge";
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) return "ratio";
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) return "pixels";
    return null;
}

export function planImageSize(value: string): PlannedImageSize {
    const trimmed = String(value ?? "").trim();
    if (!trimmed || trimmed.toLowerCase() === "auto") return { kind: "auto" };
    const dimensions = parseImageDimensions(trimmed);
    if (dimensions) {
        const aligned = alignImageDimensions(dimensions.width, dimensions.height);
        const problem = sizeProblem(aligned.width, aligned.height);
        if (problem) return { kind: "invalid", problem };
        return { kind: "pixels", size: `${aligned.width}x${aligned.height}`, width: aligned.width, height: aligned.height };
    }
    if (trimmed.includes(":")) return { kind: "ratio", ratio: trimmed };
    return { kind: "invalid", problem: "format" };
}

function validateImageSize(width: number, height: number) {
    const problem = sizeProblem(width, height);
    if (problem) throw new Error(apiText(SIZE_PROBLEM_KEYS[problem]));
}

function alignImageDimensions(width: number, height: number) {
    return {
        width: Math.ceil(width / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP,
        height: Math.ceil(height / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP,
    };
}

function resolveRequestSize(size: string) {
    const planned = planImageSize(size);
    if (planned.kind === "auto") return undefined;
    if (planned.kind === "pixels") return planned.size;
    // A ratio is the run's to resolve: the canvas gives it its own short side (and refuses one that is
    // lopsided, on the same numbers as every other size).
    if (planned.kind === "ratio") return resolveSize(planned.ratio);
    throw new Error(apiText(SIZE_PROBLEM_KEYS[planned.problem]));
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

async function requestServerImages(input: { config: AiConfig; prompt: string; references: ReferenceImage[]; size?: string; background?: string; imageMode?: string; params: Record<string, unknown>; options?: RequestOptions }): Promise<UploadedImage> {
    const { config, prompt, references, size, background, imageMode, params, options } = input;
    // A step rather than a prompt: an upscaler is told which model and given a picture. Its inputs are the
    // ones it declares, and its media is the picture by kind — nothing here is renamed into a prompt field,
    // because sending an undeclared key is accepted and ignored, which reads as a knob that did nothing.
    if (modelIsStep(config, config.model)) return requestServerStep({ config, prompt, references, params, options });
    const inputs: Record<string, unknown> = { prompt };
    if (size) inputs.size = size;
    if (background) inputs.background = background;
    // "layout" is a MOSS mode expressed entirely by params.layout, not a workflow variant.
    if (imageMode && imageMode !== "layout") inputs.mode = imageMode;
    if (config.quality?.trim()) inputs.quality = config.quality.trim();
    Object.assign(inputs, params);
    // ...and only what this workflow reads: a key the run would ignore is not sent, so the contract, the panel and
    // the request answer with one list (#302).
    const accepted = acceptedInputs(config, config.model, inputs, imageMode) || {};

    const capacity = modelImageInputs(config, config.model);
    const usable = typeof capacity === "number" ? references.slice(0, Math.max(0, capacity)) : references;
    const media: Record<string, string[]> = {};
    for (const [index, reference] of usable.entries()) {
        const role = imageMode === "inpaint" ? (index === 0 ? "source" : "mask") : imageMode === "outpaint" ? "source" : "reference";
        media[role] = [...(media[role] || []), await mediaId(config, reference, `reference-${index + 1}.png`, options?.signal)];
    }

    try {
        const run = await createRun(config, { workflow: config.model, inputs: accepted, ...(Object.keys(media).length ? { media } : {}), askedBy: options?.askedBy });
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
 * Submit an image *step*: the workflow's declared parameters, and its source picture by kind.
 *
 * The count is the capacity the workflow reports (`imageInputs`), which is the same number the server
 * derives from its bindings — an upscaler takes one picture, so an extra one is not uploaded at all rather
 * than silently dropped later.
 */
async function requestServerStep(input: { config: AiConfig; prompt: string; references: ReferenceImage[]; params: Record<string, unknown>; options?: RequestOptions }): Promise<UploadedImage> {
    const { config, prompt, references, params, options } = input;
    const capacity = modelImageInputs(config, config.model);
    const usable = typeof capacity === "number" ? references.slice(0, Math.max(0, capacity)) : references;
    const media: Record<string, string[]> = {};
    for (const [index, reference] of usable.entries()) {
        media.image = [...(media.image || []), await mediaId(config, reference, `source-${index + 1}.png`, options?.signal)];
    }
    try {
        // A step is a workflow whose knobs are its own, but one of them can be words: the angle re-render is
        // told what to keep and what to change. It is sent only where the workflow binds a prompt, so a step
        // that has no such binding is not handed a field the server would refuse.
        const words = modelTakesPrompt(config, config.model) ? { prompt } : {};
        const run = await createRun(config, { workflow: config.model, inputs: { ...words, ...params }, ...(Object.keys(media).length ? { media } : {}), askedBy: options?.askedBy });
        options?.onRun?.(run.id);
        const finished = await waitForRun(config, run.id, { signal: options?.signal, onProgress: options?.onProgress, cancelOnAbort: true });
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
    // Resolved against the model that will run, not taken on trust: a stored mode can outlive the model it was
    // chosen for, and this is the line that decides the roles and the outpaint numbers (#267).
    const imageMode = imageModeFor(requestConfig, requestConfig.model);
    // Only the knobs this model takes travel: one left over from another model is a 400 for a field nobody
    // typed (#274). The layout below is added after, because it is this client's own word rather than a knob.
    const requestParams = acceptedInputs(requestConfig, requestConfig.model, options?.params ?? requestConfig.params, imageMode) || {};
    // `layout` is the node's own word, not a mode the server has: it means "a text-to-image run whose prompt
    // carries a MOSS layout", and the server renders it into the prompt (`internal/prompt/layout.go`). So it is
    // read from the node's choice, while the mode beside it is the one the model declares — reading the pseudo
    // mode from the resolved one dropped the layout on every workflow without variants (#271).
    if (config.imageMode === "layout" && config.layout) {
        requestParams.layout = config.layout;
        requestParams.layoutEnabled = true;
    }
    const finalPrompt = withSystemPrompt(requestConfig, prompt);
    options?.onPrompt?.(finalPrompt);
    return requestServerImages({
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
    const requestParams = acceptedInputs(requestConfig, requestConfig.model, options?.params ?? requestConfig.params, imageMode) || {};
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
    return requestServerImages({
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
 * takes. `wideAngle` is a UI toggle the graph has no counterpart for, so it is not sent: the server
 * rejects inputs a workflow does not declare, and a binding that reaches nothing would be worse than
 * leaving the knob out until the model can honour it.
 */
export async function requestImageAngle(config: AiConfig, prompt: string, params: ImageAngleParams, references: ReferenceImage[], options?: RequestOptions): Promise<UploadedImage> {
    const requestConfig = { ...resolveModelRequestConfig(config, config.imageModel || config.model), baseUrl: LOCAL_SERVER_BASE_URL, model: IMAGE_ANGLE_WORKFLOW };
    return requestServerImages({
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
