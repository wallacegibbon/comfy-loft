import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Speech, from the page to the server, and the list of speech servers behind it.
 *
 * Three things matter and none of them is visible in a browser until the feature already works: the recording
 * travels without naming a server (the active profile is the server's answer, not the page's), the body is a WAV
 * file named as one, and a refusal from the speech server arrives as its own sentence rather than as "request
 * failed". The list is the fourth: a page sends the whole thing back with one entry changed, and a profile's key
 * is never something it has, only something the server says it has (#246, #252).
 */
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/services/api/server-status", () => ({ noteServerError: () => undefined, noteServerResponse: () => undefined }));

const { transcribeSpeech, loadSpeechProfiles, saveSpeechProfiles } = await import("@/services/api/speech");

const SERVER = { baseUrl: "http://127.0.0.1:8190" };
const ADDRESS = "http://127.0.0.1:18080/v1/audio/transcriptions";

const samples = (count = 16_000) => new Float32Array(count).fill(0.25);

/** One request, as the stub fetch saw it. */
type Sent = { url: string; method: string; fields: Record<string, string>; file?: File; body?: string };

let sent: Sent[] = [];
let reply: () => Response;

const respond =
    (body: unknown, status = 200) =>
    () =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
    sent = [];
    reply = respond({ text: "帮我画一只猫" });
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        const entry: Sent = { url, method: init.method || "GET", fields: {} };
        if (typeof init.body === "string") {
            entry.body = init.body;
        } else if (init.body instanceof FormData) {
            for (const [name, value] of init.body.entries()) {
                if (typeof value === "string") entry.fields[name] = value;
                else entry.file = value as File;
            }
        }
        sent.push(entry);
        return reply();
    });
});

describe("transcribeSpeech", () => {
    it("sends the recording to the server and lets it choose the speech server", async () => {
        const text = await transcribeSpeech(SERVER, samples(), 16_000, "zh");

        expect(text).toBe("帮我画一只猫");
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe("http://127.0.0.1:8190/api/speech/transcriptions");
        expect(sent[0].method).toBe("POST");
        expect(sent[0].fields.language).toBe("zh");
        // Nothing in this request names a server, a model or a key: the active profile is the whole answer to
        // all three, and a field here would be a page choosing where its own audio goes.
        expect(Object.keys(sent[0].fields)).toEqual(["language"]);
    });

    // The speech server reads the bytes and nothing else: a name and a MIME type are all the page can add.
    it("sends the audio as a WAV file", async () => {
        await transcribeSpeech(SERVER, samples(8000), 16_000, "zh");

        const file = sent[0].file;
        expect(file?.name).toBe("speech.wav");
        expect(file?.type).toBe("audio/wav");
        const bytes = new Uint8Array(await file!.arrayBuffer());
        expect(bytes.length).toBe(44 + 8000 * 2);
        expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
        expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    });

    it("passes on the speech server's own reason for refusing", async () => {
        reply = respond({ error: { message: "only WAV audio uploads are currently supported" } }, 400);
        await expect(transcribeSpeech(SERVER, samples(), 16_000, "zh")).rejects.toThrow("only WAV audio uploads are currently supported");
    });

    // A cough, a silent room, a tap that got through: an empty transcript is an answer, and the panel inserts
    // nothing rather than reporting a failure.
    it("answers an empty transcript as an empty string", async () => {
        reply = respond({ text: "  " });
        await expect(transcribeSpeech(SERVER, samples(), 16_000, "zh")).resolves.toBe("");
    });

    // The one refusal this page words for itself: "no speech server is configured" is a setting with a name in
    // the preferences window, and the server's English sentence is not where a Chinese reader would look.
    it("says where to configure a speech server when there is none", async () => {
        reply = respond({ error: { message: "no speech server is configured: add one in the preferences", code: "speech_profile_missing" } }, 400);

        await expect(transcribeSpeech(SERVER, samples(), 16_000, "zh")).rejects.toThrow("apiErrors.speechProfileMissing");
    });

    // Every other refusal keeps the server's words, which name the thing to change.
    it("keeps a refusal that has something to say", async () => {
        reply = respond({ error: { message: "the speech server answered 502", code: "speech_failed" } }, 502);

        await expect(transcribeSpeech(SERVER, samples(), 16_000, "zh")).rejects.toThrow("the speech server answered 502");
    });
});

describe("the speech server list", () => {
    it("reads the list and which entry is active", async () => {
        reply = respond({ profiles: [{ id: 2, name: "Local", url: ADDRESS, model: "refine", hasKey: true }], active: 2 });

        await expect(loadSpeechProfiles(SERVER)).resolves.toEqual({ profiles: [{ id: 2, name: "Local", url: ADDRESS, model: "refine", hasKey: true }], active: 2 });
        expect(sent[0].url).toBe("http://127.0.0.1:8190/api/speech/profiles");
        expect(sent[0].method).toBe("GET");
    });

    // An answer with no list is an empty list, not `undefined`: the window renders it before anything else.
    it("reads an empty answer as an empty list", async () => {
        reply = respond({});
        await expect(loadSpeechProfiles(SERVER)).resolves.toEqual({ profiles: [], active: 0 });
    });

    it("sends the whole list back, with the entry that changed", async () => {
        reply = respond({ profiles: [{ id: 1, name: "Local", url: ADDRESS, model: "refine", hasKey: false }], active: 1 });

        const answer = await saveSpeechProfiles(SERVER, { profiles: [{ name: "Local", url: ADDRESS, model: "refine" }], active: 0 });

        expect(answer.active).toBe(1);
        expect(sent[0].url).toBe("http://127.0.0.1:8190/api/speech/profiles");
        expect(sent[0].method).toBe("PUT");
        expect(sent[0].body).toBe(JSON.stringify({ profiles: [{ name: "Local", url: ADDRESS, model: "refine" }], active: 0 }));
    });

    // Two windows on one file: the other one deleted the profile this one is editing, and "there is no speech
    // profile 7" is not something a reader can act on.
    it("says the list changed elsewhere when an edit names a profile that is gone", async () => {
        reply = respond({ error: { message: "there is no speech profile 7", code: "speech_profile_unknown" } }, 400);
        await expect(saveSpeechProfiles(SERVER, { profiles: [{ id: 7, name: "x", url: ADDRESS, model: "" }], active: 7 })).rejects.toThrow("apiErrors.speechProfileStale");
    });

    it("reports a refused list in the server's own sentence", async () => {
        reply = respond({ error: { message: "every speech profile needs an address", code: "speech_address_missing" } }, 400);
        await expect(saveSpeechProfiles(SERVER, { profiles: [{ name: "x", url: "", model: "" }], active: 0 })).rejects.toThrow("every speech profile needs an address");
    });

    it("reports an unreachable server in a sentence rather than a bare failure", async () => {
        reply = respond({ error: { message: "could not read" } }, 500);
        await expect(loadSpeechProfiles(SERVER)).rejects.toThrow("could not read");
    });
});
