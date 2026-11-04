import { modelTakesPrompt, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * The settings a video run may write back onto its node.
 *
 * A workflow that takes a prompt is described by the settings that shaped it — size, length, resolution,
 * mode — and a node that remembers them can be re-run as it was. A *step* has none of those: an
 * interpolation was told a multiplier and given a clip, so writing "720p · 6s · first & last frame" onto it
 * would invent facts about the run, and the panel would then show controls the workflow does not have.
 *
 * The parameters are kept for both: they are what the workflow declares and what the next run needs.
 */
export function videoRunMetadata(config: AiConfig): CanvasNodeData["metadata"] {
    const params = config.params ? { params: config.params } : {};
    if (!modelTakesPrompt(config, config.model)) return { model: config.model, ...params };
    return {
        model: config.model,
        size: config.size,
        seconds: config.videoSeconds,
        vquality: config.vquality,
        generateAudio: config.videoGenerateAudio,
        watermark: config.videoWatermark,
        videoMode: config.videoMode,
        ...params,
    };
}
