import i18n from "@/i18n";
import { serverRoot } from "@/constant/app-mode";
import { wavBytes } from "@/lib/wav";
import { apiErrorMessage, httpJson, throwIfCanceled } from "@/services/api/http";
import type { AiConfig } from "@/stores/use-config-store";

/**
 * Speech to text, through the server.
 *
 * The page cannot call the speech server itself: it answers no CORS headers, so a request from this origin
 * can be sent and the answer can never be read — and on a phone opening the canvas over the LAN, `127.0.0.1`
 * is the phone. So the recording goes to `/api/speech/transcriptions` on the server, which is the one
 * process that can reach the address, and the address travels with it (`internal/server/routes_speech.go`,
 * docs/decisions.md #239).
 *
 * **The one shape this build speaks.** An OpenAI-compatible `POST /v1/audio/transcriptions` taking multipart
 * WAV and answering `{"text": "..."}` — a local audio.cpp server, in the default this build fills in. One
 * address is the only setting because one protocol is the only thing here; a second provider would be a
 * second form of the same request, and nothing else in the app would change.
 */

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

/**
 * The model, as the server names it.
 *
 * Not a preference: this build supports one speech server, and `refine` is the model it exposes. The
 * server forwards whatever it is given and names nothing itself.
 */
const SPEECH_MODEL = "refine";

/** What the panel says when it failed without a sentence of its own. */
const SPEECH_FALLBACK = "speechFailed";

/**
 * Transcribe one recording.
 *
 * Samples and their rate go in — the WAV is written here, so the caller never holds a file format. An empty
 * transcript (silence, or a cough) comes back as an empty string: that is an answer, not a failure.
 */
export async function transcribeSpeech(config: AiConfig, samples: Float32Array, sampleRate: number, language: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    const address = (config.asrUrl || "").trim();
    if (!address) throw new Error(apiText("speechAddressMissing"));

    const body = new FormData();
    body.append("url", address);
    body.append("model", SPEECH_MODEL);
    // The language is a hint about the sound, so it follows the words the interface is written in. It is
    // only a hint: the model answers in the language it hears either way (measured — English audio with a
    // Chinese hint transcribes to English), so an English interface and a Chinese sentence is not a conflict.
    body.append("language", language);
    body.append("file", new File([wavBytes(samples, sampleRate)], "speech.wav", { type: "audio/wav" }));

    try {
        const payload = await httpJson<{ text?: string }>(`${serverRoot(config.baseUrl)}/api/speech/transcriptions`, {
            method: "POST",
            body,
            signal: options.signal,
            timeout: 180_000,
        });
        return (payload?.text || "").trim();
    } catch (error) {
        throwIfCanceled(error);
        throw new Error(apiErrorMessage(error, apiText(SPEECH_FALLBACK)));
    }
}
