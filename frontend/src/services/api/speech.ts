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
 * WAV and answering `{"text": "..."}` — a local audio.cpp server, in the default this build fills in. That
 * shape is a fact about the protocol; the address and the model name are facts about the server at the other
 * end, so they are settings (#246).
 *
 * **What is not here: the key.** A speech server may want a credential, and the page never holds it —
 * `data/settings.json` is served to every browser that loads the canvas (`/config.js`), so a credential in it
 * would be a credential for anyone who can reach the server. It is stored server-side instead, mode 0600, and
 * this module can only ask whether one is there and hand a new one over (#246).
 */

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

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
    // Omitted when blank rather than sent empty: `model` is required by the protocol, and the server that
    // refuses it says so in its own words (`requires a 'model' field`) — where a name this build invented
    // would come back as `unknown model id: refine` on somebody else's provider.
    const model = (config.asrModel || "").trim();
    if (model) body.append("model", model);
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

/** `{baseUrl}` is all these two need, which is why they take that and not the whole config. */
type Server = { baseUrl: string };

const SPEECH_KEY_URL = (server: Server) => `${serverRoot(server.baseUrl)}/api/speech/key`;

/**
 * Whether a credential is stored on the server.
 *
 * The only thing this build can learn about it: the key itself is never sent to a page, so a form can say
 * "a key is stored" and offer to replace it, and nothing more.
 */
export async function loadSpeechKey(server: Server, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    try {
        const payload = await httpJson<{ stored?: boolean }>(SPEECH_KEY_URL(server), { signal: options.signal, timeout: 8000 });
        return payload?.stored === true;
    } catch (error) {
        throwIfCanceled(error);
        throw new Error(apiErrorMessage(error, apiText("speechKeyFailed")));
    }
}

/** Store the credential, or clear it with a blank one. Answers what is stored afterwards. */
export async function saveSpeechKey(server: Server, key: string): Promise<boolean> {
    try {
        const payload = await httpJson<{ stored?: boolean }>(SPEECH_KEY_URL(server), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: key.trim() }),
            timeout: 8000,
        });
        return payload?.stored === true;
    } catch (error) {
        throwIfCanceled(error);
        throw new Error(apiErrorMessage(error, apiText("speechKeyFailed")));
    }
}
