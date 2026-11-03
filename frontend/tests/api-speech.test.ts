import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Speech, from the page to the server.
 *
 * Three things matter and none of them is visible in a browser until the feature already works: the address
 * the user configured travels *with* the request (it is not the server's setting), the body is a WAV file
 * named as one, and a refusal from the speech server arrives as its own sentence rather than as "request
 * failed".
 */
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/services/api/server-status", () => ({ noteServerError: () => undefined, noteServerResponse: () => undefined }));

const { transcribeSpeech } = await import("@/services/api/speech");
type Config = Parameters<typeof transcribeSpeech>[0];

const ADDRESS = "http://127.0.0.1:18080/v1/audio/transcriptions";

const config = (overrides: Partial<{ asrUrl: string }> = {}) =>
    ({
        baseUrl: "http://127.0.0.1:8190",
        asrUrl: ADDRESS,
        ...overrides,
    }) as unknown as Config;

const samples = (count = 16_000) => new Float32Array(count).fill(0.25);

/** One recording posted, as the stub fetch saw it. */
type Sent = { url: string; fields: Record<string, string>; file?: File };

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
        const body = init.body as FormData;
        const entry: Sent = { url, fields: {} };
        for (const [name, value] of body.entries()) {
            if (typeof value === "string") entry.fields[name] = value;
            else entry.file = value as File;
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
});
