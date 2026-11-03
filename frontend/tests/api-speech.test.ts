import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Speech, from the page to the server.
 *
 * Three things matter and none of them is visible in a browser until the feature already works: the address
 * the user configured travels *with* the request (it is not the server's setting), the body is a WAV file
 * named as one, and a refusal from the speech server arrives as its own sentence rather than as "request
 * failed". Two more are the server's business rather than the protocol's — the model name and the credential
 * — and each travels only when the user gave one (#246).
 */
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/services/api/server-status", () => ({ noteServerError: () => undefined, noteServerResponse: () => undefined }));

const { transcribeSpeech, loadSpeechKey, saveSpeechKey } = await import("@/services/api/speech");
type Config = Parameters<typeof transcribeSpeech>[0];

const ADDRESS = "http://127.0.0.1:18080/v1/audio/transcriptions";

const config = (overrides: Partial<{ asrUrl: string; asrModel: string }> = {}) =>
    ({
        baseUrl: "http://127.0.0.1:8190",
        asrUrl: ADDRESS,
        asrModel: "refine",
        ...overrides,
    }) as unknown as Config;

const samples = (count = 16_000) => new Float32Array(count).fill(0.25);

/** One recording posted, as the stub fetch saw it. */
type Sent = { url: string; fields: Record<string, string>; file?: File; body?: string };

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
        const entry: Sent = { url, fields: {} };
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
    it("sends the recording to the server, naming the address it was given", async () => {
        const text = await transcribeSpeech(config(), samples(), 16_000, "zh");

        expect(text).toBe("帮我画一只猫");
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe("http://127.0.0.1:8190/api/speech/transcriptions");
        expect(sent[0].fields.url).toBe(ADDRESS);
        expect(sent[0].fields.model).toBe("refine");
        expect(sent[0].fields.language).toBe("zh");
    });

    // The speech server reads the bytes and nothing else: a name and a MIME type are all the page can add.
    it("sends the audio as a WAV file", async () => {
        await transcribeSpeech(config(), samples(8000), 16_000, "zh");

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
        await expect(transcribeSpeech(config(), samples(), 16_000, "zh")).rejects.toThrow("only WAV audio uploads are currently supported");
    });

    // A cough, a silent room, a tap that got through: an empty transcript is an answer, and the panel
    // inserts nothing rather than reporting a failure.
    it("answers an empty transcript as an empty string", async () => {
        reply = respond({ text: "  " });
        await expect(transcribeSpeech(config(), samples(), 16_000, "zh")).resolves.toBe("");
    });

    it("refuses to post when no address is configured", async () => {
        await expect(transcribeSpeech(config({ asrUrl: "  " }), samples(), 16_000, "zh")).rejects.toThrow("apiErrors.speechAddressMissing");
        expect(sent).toHaveLength(0);
    });

    // The model is a fact about the server at the other end, not about this build: audio.cpp names its own
    // gguf (`refine`), OpenAI names `whisper-1`. A build that sent its own would get `unknown model id`.
    it("names the model the user configured", async () => {
        await transcribeSpeech(config({ asrModel: "gpt-4o-transcribe" }), samples(), 16_000, "zh");

        expect(sent[0].fields.model).toBe("gpt-4o-transcribe");
    });

    // Blank is not a missing setting to complain about: `model` is required by the protocol, and a server
    // that wants one says so in its own words. A name invented here would be worse than the silence.
    it("sends no model at all when the field is empty", async () => {
        await transcribeSpeech(config({ asrModel: "  " }), samples(), 16_000, "zh");

        expect(sent[0].fields).not.toHaveProperty("model");
    });

    // The page never holds the credential: it is stored on the server, so nothing about it is on the wire
    // here. A `key` field in this request would be a secret in a document every browser can read (#246).
    it("sends no credential of its own", async () => {
        await transcribeSpeech(config(), samples(), 16_000, "zh");

        expect(sent[0].fields).not.toHaveProperty("key");
        expect(Object.keys(sent[0].fields).sort()).toEqual(["language", "model", "url"]);
    });
});

describe("the speech key", () => {
    it("asks only whether one is stored", async () => {
        reply = respond({ stored: true });
        await expect(loadSpeechKey({ baseUrl: "http://127.0.0.1:8190" })).resolves.toBe(true);
        expect(sent[0].url).toBe("http://127.0.0.1:8190/api/speech/key");
    });

    it("says no when the server has none", async () => {
        reply = respond({ stored: false });
        await expect(loadSpeechKey({ baseUrl: "http://127.0.0.1:8190" })).resolves.toBe(false);
    });

    // Trimming happens here so a key pasted with a trailing newline is stored as the key.
    it("hands a new key over, and clears it with a blank one", async () => {
        reply = respond({ stored: true });
        await expect(saveSpeechKey({ baseUrl: "http://127.0.0.1:8190" }, "  sk-test  ")).resolves.toBe(true);
        expect(sent[0].url).toBe("http://127.0.0.1:8190/api/speech/key");
        expect(sent[0].body).toBe(JSON.stringify({ key: "sk-test" }));

        reply = respond({ stored: false });
        await expect(saveSpeechKey({ baseUrl: "http://127.0.0.1:8190" }, "")).resolves.toBe(false);
        expect(sent[1].body).toBe(JSON.stringify({ key: "" }));
    });

    it("reports a refusal in the server's own sentence", async () => {
        reply = respond({ error: { message: "the key must be a string" } }, 400);
        await expect(saveSpeechKey({ baseUrl: "http://127.0.0.1:8190" }, "sk-test")).rejects.toThrow("the key must be a string");
    });
});
