import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The length a music node asks for.
 *
 * A music run has a ceiling it did not used to state: the workflow declares a `duration` range
 * (`audio-minimax-music-3` allows 4–360 s) and binds it to the graph's `max_duration`, but the canvas
 * sent the caption, the lyrics and the container and nothing else, so every song came out at the
 * workflow's own 60-second default whatever the panel said (#259).
 *
 * Two properties matter here and neither is visible in the browser: the number on the wire is inside the
 * range the selected workflow declares — not the range of some other workflow, and not the one hardcoded
 * for video clips — and a workflow that declares no range is sent no number at all, so its own binding
 * default answers instead of a length the client invented.
 */
const t = vi.fn((key: string) => key);

vi.mock("@/i18n", () => ({ default: { t: (key: string) => t(key) } }));
vi.mock("@/services/api/server-status", () => ({ noteServerError: () => undefined, noteServerResponse: () => undefined }));
// The artifact is read back through the browser (a duration from the audio element); the request is what
// this file is about, so the finished run's file is stubbed and the polling around it is real.
vi.mock("@/lib/canvas/generated-media", () => ({ generatedAudio: async () => ({ url: "http://server.test:8190/files/task_1.mp3", storageKey: "files/task_1.mp3", bytes: 3, mimeType: "audio/mpeg" }) }));

const { requestAudioGeneration } = await import("@/services/api/audio");
const { clampAudioSeconds } = await import("@/lib/audio-generation");
const { defaultConfig } = await import("@/stores/use-config-store");
const { setActiveCanvas } = await import("@/services/canvas-files");

type Config = Parameters<typeof requestAudioGeneration>[0];

const CANVAS = "40e8afb47f10";
const BASE = "http://server.test:8190";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

/** A run that is accepted, then finishes with one audio file. */
const finishedRun = () => {
    let calls = 0;
    return vi.fn(async () => {
        calls += 1;
        const running =
            calls === 1
                ? { id: "task_1", workflow: "audio-minimax-music-3", status: "queued", outputs: [], error: null }
                : { id: "task_1", workflow: "audio-minimax-music-3", status: "succeeded", outputs: [{ index: 0, kind: "audio", mime: "audio/mpeg", bytes: 3, filename: "task_1.mp3", url: `/api/canvases/${CANVAS}/files/task_1.mp3` }], error: null };
        return json(running);
    });
};

/** The audio model as the server reports it, with or without a declared length. */
const audioConfig = (duration: { min: number; max: number } | undefined, overrides: Partial<Config> = {}): Config =>
    ({
        ...defaultConfig,
        baseUrl: BASE,
        model: "local::audio-minimax-music-3",
        audioModel: "local::audio-minimax-music-3",
        channels: [
            {
                id: "local",
                name: "Local",
                baseUrl: BASE,
                models: [{ name: "audio-minimax-music-3", capability: "audio", workflowId: "audio-minimax-music-3", duration }],
            },
        ],
        audioFormat: "mp3",
        audioInstructions: "",
        audioSeconds: "90",
        ...overrides,
    }) as Config;

const sentInputs = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).inputs;

beforeEach(() => {
    t.mockClear();
    vi.unstubAllGlobals();
    setActiveCanvas(CANVAS);
});

describe("requestAudioGeneration", () => {
    it("asks for the seconds on the panel, inside the range the workflow declares", async () => {
        const fetchMock = finishedRun();
        vi.stubGlobal("fetch", fetchMock);

        await requestAudioGeneration(audioConfig({ min: 4, max: 360 }), "lofi piano", {});

        expect(sentInputs(fetchMock)).toEqual({ prompt: "lofi piano", format: "mp3", seconds: 90 });
    });

    it("clamps a stored length into the declared range rather than sending one the workflow would refuse", async () => {
        const fetchMock = finishedRun();
        vi.stubGlobal("fetch", fetchMock);

        await requestAudioGeneration(audioConfig({ min: 4, max: 120 }, { audioSeconds: "600" }), "techno", {});

        expect(sentInputs(fetchMock).seconds).toBe(120);
    });

    it("sends no length at all when the workflow declares none", async () => {
        // The declaration is what puts the control on the panel, so without it there is no number to send:
        // the workflow's own binding default answers, instead of a length this client made up.
        const fetchMock = finishedRun();
        vi.stubGlobal("fetch", fetchMock);

        await requestAudioGeneration(audioConfig(undefined), "ambient", {});

        expect(sentInputs(fetchMock)).not.toHaveProperty("seconds");
    });

    it("keeps the lyrics and the container beside it", async () => {
        const fetchMock = finishedRun();
        vi.stubGlobal("fetch", fetchMock);

        await requestAudioGeneration(audioConfig({ min: 4, max: 360 }, { audioInstructions: "[Verse]\nhello", audioFormat: "flac" }), "folk", {});

        expect(sentInputs(fetchMock)).toEqual({ prompt: "folk", format: "flac", lyrics: "[Verse]\nhello", seconds: 90 });
    });
});

describe("clampAudioSeconds", () => {
    const bounds = { min: 4, max: 360 };

    it("keeps a whole number of seconds inside the range", () => {
        expect(clampAudioSeconds("90", bounds)).toBe(90);
        expect(clampAudioSeconds(90, bounds)).toBe(90);
        expect(clampAudioSeconds("90.6", bounds)).toBe(91);
    });

    it("rounds the declared step away, because a song length is read in seconds", () => {
        // The music workflow's own step is 1/25 s — the latent's grid, not a number anyone types.
        expect(clampAudioSeconds("74.04", bounds)).toBe(74);
    });

    it("holds the ends of the range", () => {
        expect(clampAudioSeconds("1", bounds)).toBe(4);
        expect(clampAudioSeconds("-30", bounds)).toBe(4);
        expect(clampAudioSeconds("3600", bounds)).toBe(360);
    });

    it("falls back to the shortest run for a value that is not a number", () => {
        expect(clampAudioSeconds("", bounds)).toBe(4);
        expect(clampAudioSeconds("lots", bounds)).toBe(4);
        expect(clampAudioSeconds(undefined, bounds)).toBe(4);
    });
});
