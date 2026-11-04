import i18n from "@/i18n";
import { clampAudioSeconds, normalizeAudioFormatValue } from "@/lib/audio-generation";
import type { UploadedFile } from "@/services/file-storage";
import { apiErrorMessage, throwIfCanceled } from "@/services/api/http";
import { createRun, waitForRun, type Run, type RunRequest } from "@/services/api/runs";
import { generatedAudio } from "@/lib/canvas/generated-media";
import { channelModelOf, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

type RequestOptions = { signal?: AbortSignal; askedBy?: RunRequest["askedBy"] };

/**
 * Hooks a canvas node needs to keep its generation alive across a reload: the run id arrives as soon
 * as the server accepts the job, and the progress ticks come from the run itself.
 */
type AudioRunHooks = {
    onRun?: (runId: string) => void;
    onProgress?: (run: Run) => void;
};

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

/**
 * One music run: the prompt is the style caption, the voice-instructions field the lyrics.
 *
 * The chosen container is sent as-is rather than downgraded: the workflow declares which containers
 * it writes, and an unsupported one comes back as a message naming the accepted set — a silent
 * substitution would leave the node labelled with a format it does not hold.
 *
 * The length is sent only when the workflow declares a range for it. That declaration is what puts the
 * control on the panel, so a workflow without one offers no number to send — and the binding's own
 * default answers instead. `seconds` is the key both this client and `internal/server/routes_runs.go`
 * use (`ctx.Seconds`, which the audio binding reads), even though the parameter the run is told about
 * is called `duration` (docs/decisions.md #59).
 */
export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions & AudioRunHooks): Promise<UploadedFile> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const model = requestConfig.model.trim();
    const format = normalizeAudioFormatValue(config.audioFormat);
    assertAudioConfig(requestConfig, model);
    const lyrics = config.audioInstructions.trim();

    const inputs: Record<string, unknown> = { prompt, format };
    if (lyrics) inputs.lyrics = lyrics;
    const duration = channelModelOf(requestConfig, model)?.model.duration;
    if (duration) inputs.seconds = clampAudioSeconds(config.audioSeconds, duration);
    try {
        const run = await createRun(requestConfig, { workflow: model, inputs, askedBy: options?.askedBy });
        options?.onRun?.(run.id);
        const finished = await waitForRun(requestConfig, run.id, {
            signal: options?.signal,
            onProgress: options?.onProgress,
            // The user asked for this: stopping it should free the GPU, not leave it rendering.
            cancelOnAbort: true,
        });
        // The run wrote the clip into the canvas; the node references it there (#173).
        return await generatedAudio(requestConfig, finished);
    } catch (error) {
        throwIfCanceled(error);
        throw new Error(apiErrorMessage(error, apiText("audioGenerationFailed")));
    }
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("audioModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
}
