import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Video generation through the run protocol.
 *
 * A video node used to submit a multipart task to `/v1/videos` and then poll `/v1/videos/{id}`. It
 * now submits a run: media is uploaded once and referenced by role, the knobs are the workflow's own
 * typed inputs, and the id that comes back is a run id — which is what makes the node resumable
 * after a reload.
 */
const t = vi.fn((key: string) => key);

vi.mock("@/i18n", () => ({ default: { t: (key: string) => t(key) } }));
vi.mock("@/services/api/server-status", () => ({ noteServerError: () => undefined, noteServerResponse: () => undefined }));

// Media conversion is a browser concern; these tests are about the request the canvas builds.
vi.mock("@/services/image-storage", () => ({ imageToDataUrl: async () => "data:image/png;base64,AAAA" }));
vi.mock("@/lib/image-utils", () => ({
    dataUrlToFile: (image: { name?: string }) => new File([new Uint8Array([1, 2, 3])], image.name || "reference.png", { type: "image/png" }),
}));
vi.mock("@/services/file-storage", () => ({
    getMediaBlob: async () => new Blob([new Uint8Array([4, 5, 6])], { type: "video/mp4" }),
    resolveMediaUrl: async () => "",
    uploadMediaFile: async () => ({ url: "", storageKey: "", bytes: 0, mimeType: "video/mp4" }),
    // A generated clip is measured where it is served, not downloaded and re-uploaded (#173).
    readVideoMeta: async () => ({ width: 1280, height: 720, durationMs: 5000 }),
}));

const { createVideoGenerationTask, createVideoInterpolateTask, waitForVideoGenerationTask } = await import("@/services/api/video");

// A run belongs to a canvas (#156): these cases post into one.
const { setActiveCanvas } = await import("@/services/canvas-files");
const CANVAS_ID = "40e8afb47f10";
setActiveCanvas(CANVAS_ID);

type Config = Parameters<typeof createVideoGenerationTask>[0];
const server = (overrides: Record<string, unknown> = {}) =>
    ({
        baseUrl: "http://127.0.0.1:8190/v1",
        apiKey: "local",
        apiFormat: "openai",
        channels: [],
        models: ["video-h3-frames"],
        model: "video-h3-frames",
        videoModel: "video-h3-frames",
        videoSeconds: "5",
        size: "16:9",
        vquality: "720",
        videoMode: "frames",
        videoInterpolation: "off",
        frameMode: "first",
        seedFixed: "false",
        ...overrides,
    }) as unknown as Config;

const image = (name: string) => ({ id: name, name, dataUrl: "data:image/png;base64,AAAA" }) as never;

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

const run = (overrides: Record<string, unknown> = {}) => ({
    id: "task_video_1",
    workflow: "video-h3-frames",
    status: "running",
    progress: { step: 0, total: 0 },
    outputs: [],
    error: null,
    ...overrides,
});

/** Where the server is in these cases: `serverProtocolRoot` strips the legacy `/v1`, nothing else. */
const ROOT = "http://127.0.0.1:8190";

/** The names the server gives uploaded files: an id is that name, not a handle of its own (#156). */
const UPLOAD_ID = "up-2b7788de.png";
const UPLOAD_ID_2 = "up-5b1c9e3f.png";
const VIDEO_ID = "up-77aa01bc.mp4";

/**
 * Route a stubbed fetch by the **whole** URL, and answer `404` to anything else.
 *
 * A stub that matched a path suffix (`url.endsWith("/runs")`) accepts a request sent to the wrong place,
 * and the case then passes on a URL the server does not serve (#161). An unexpected address here is a
 * failure the caller cannot miss, which is what makes the URLs in these cases worth asserting.
 */
function stubServer(handlers: { run?: () => Response; status?: () => Response; delete?: () => Response; output?: () => Response; upload?: (count: number) => Response } = {}) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let uploads = 0;
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: String(init.method || "GET"), body: init.body });
        if (url === `${ROOT}/api/canvases/${CANVAS_ID}/uploads`) {
            uploads += 1;
            // Each upload gets its own name, so a case with two of them can tell them apart.
            return handlers.upload?.(uploads) ?? json({ upload: { id: uploads === 1 ? UPLOAD_ID : UPLOAD_ID_2, kind: "image", mime: "image/png", bytes: 3, filename: uploads === 1 ? "a.png" : "b.png" } });
        }
        if (url === `${ROOT}/api/canvases/${CANVAS_ID}/runs`) return handlers.run?.() ?? json(run({ status: "queued" }), 202);
        if (url === `${ROOT}/api/canvases/${CANVAS_ID}/files/task_video_1.mp4`) return handlers.output?.() ?? new Response(new Blob(["MP4"], { type: "video/mp4" }), { status: 200 });
        if (url === `${ROOT}/api/runs/task_video_1` && init.method === "DELETE") return handlers.delete?.() ?? json(run({ status: "cancelled" }));
        if (url === `${ROOT}/api/runs/task_video_1`) return handlers.status?.() ?? json(run());
        return json({ error: { code: "not_found", message: `no such route: ${init.method || "GET"} ${url}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls, fetchMock };
}

/** The JSON body of the one run-submission call. */
function runBody(calls: Array<{ url: string; method: string; body: unknown }>) {
    const call = calls.find((item) => item.url === `${ROOT}/api/canvases/${CANVAS_ID}/runs` && item.method === "POST");
    if (!call) throw new Error(`no run was submitted; the calls were ${calls.map((item) => `${item.method} ${item.url}`).join(", ")}`);
    return JSON.parse(String(call.body));
}

beforeEach(() => {
    t.mockClear();
    vi.unstubAllGlobals();
});

describe("createVideoGenerationTask", () => {
    it("submits one run with the frame uploaded by role", async () => {
        const { calls } = stubServer({});

        const task = await createVideoGenerationTask(server(), "a cat walks", [image("first.png")]);

        expect(task.id).toBe("task_video_1");
        const body = runBody(calls);
        expect(body.workflow).toBe("video-h3-frames");
        expect(body.inputs).toMatchObject({ prompt: "a cat walks", mode: "frames", frameMode: "first", seconds: 5 });
        expect(body.inputs.size).toMatch(/^\d+x\d+$/);
        expect(body.media).toEqual({ first_frame: UPLOAD_ID });
        // Both addresses in full: the frame goes into the canvas, and the run is that canvas's run.
        expect(calls.map((call) => call.url)).toEqual([`${ROOT}/api/canvases/${CANVAS_ID}/uploads`, `${ROOT}/api/canvases/${CANVAS_ID}/runs`]);
    });

    it("sends the second image as the last frame when both are asked for", async () => {
        const { calls } = stubServer({});

        await createVideoGenerationTask(server({ frameMode: "both" }), "morph", [image("a.png"), image("b.png")]);

        expect(runBody(calls).media).toEqual({ first_frame: UPLOAD_ID, last_frame: UPLOAD_ID_2 });
    });

    it("references multi-modal media by role instead of by form field", async () => {
        const { calls } = stubServer({});

        await createVideoGenerationTask(server({ model: "video-h3-ref2va", videoModel: "video-h3-ref2va", videoMode: "reference" }), "same dancer", [image("a.png")], {
            videos: [{ id: "v1", name: "ref.mp4", type: "video/mp4", storageKey: "k1" } as never],
            audios: [{ id: "a1", name: "ref.mp3", type: "audio/mpeg", storageKey: "k2" } as never],
        });

        const body = runBody(calls);
        expect(body.workflow).toBe("video-h3-ref2va");
        expect(body.inputs.mode).toBe("reference");
        expect(body.inputs.frameMode).toBeUndefined();
        expect(Object.keys(body.media).sort()).toEqual(["audio", "reference", "video"]);
        expect(body.media.reference).toEqual([UPLOAD_ID]);
    });

    it("sends no interpolation: raising the frame rate is a run of its own", async () => {
        const { calls } = stubServer({});

        await createVideoGenerationTask(server(), "a cat", [image("a.png")]);

        expect(runBody(calls).inputs.interpolation).toBeUndefined();
    });

    it("sends no media for a text-to-video workflow", async () => {
        const { calls } = stubServer({});

        await createVideoGenerationTask(server({ model: "video-h3-t2v", videoModel: "video-h3-t2v", videoMode: "text" }), "a cat", [image("a.png")]);

        const body = runBody(calls);
        expect(body.inputs.mode).toBe("text");
        expect(body.media).toBeUndefined();
    });
});

/** A config whose one model is a *step*: no prompt binding, one declared knob. */
const stepServer = (overrides: Record<string, unknown> = {}) =>
    server({
        channels: [
            {
                id: "local",
                name: "local",
                baseUrl: "http://127.0.0.1:8190/v1",
                models: [
                    {
                        name: "video-rife",
                        capability: "video",
                        workflowId: "video-rife",
                        tool: true,
                        hasPrompt: false,
                        accepts: { videos: { min: 1, max: 1 }, minTotal: 0 },
                        parameters: [{ key: "multiplier", type: "number", min: 2, max: 3, default: 2 }],
                    },
                ],
            },
        ],
        model: "local::video-rife",
        videoModel: "local::video-rife",
        params: { multiplier: 3 },
        ...overrides,
    });

describe("createVideoGenerationTask on a step workflow", () => {
    it("sends the workflow's own parameters and its clip, and no prompt at all", async () => {
        const { calls } = stubServer({ upload: () => json({ upload: { id: VIDEO_ID, kind: "video", mime: "video/mp4", bytes: 3, filename: "clip.mp4" } }) });

        await createVideoGenerationTask(stepServer(), "words an interpolation never reads", [], { videos: [{ id: "v1", name: "clip.mp4", type: "video/mp4", storageKey: "k1" } as never] });

        const body = runBody(calls);
        expect(body.workflow).toBe("video-rife");
        // Exactly the declared knob: `prompt`/`size`/`seconds` are accepted by the server and ignored,
        // which is the silent no-op this path exists to avoid.
        expect(body.inputs).toEqual({ multiplier: 3 });
        expect(body.media).toEqual({ video: [VIDEO_ID] });
    });
});

describe("createVideoInterpolateTask", () => {
    it("is one run of the RIFE workflow with the clip and the multiplier", async () => {
        const { calls } = stubServer({ upload: () => json({ upload: { id: VIDEO_ID, kind: "video", mime: "video/mp4", bytes: 3, filename: "source.mp4" } }) });

        const task = await createVideoInterpolateTask(server(), { name: "clip.mp4", type: "video/mp4", storageKey: "k1" }, { multiplier: 2 });

        expect(task).toMatchObject({ model: "video-rife" });
        const body = runBody(calls);
        expect(body.workflow).toBe("video-rife");
        expect(body.inputs).toEqual({ multiplier: 2 });
        expect(body.media).toEqual({ video: VIDEO_ID });
    });
});

describe("waitForVideoGenerationTask", () => {
    it("reports steps and preview frames, then returns the run's video", async () => {
        const { calls } = stubServer({
            status: () =>
                json(
                    run({
                        status: "succeeded",
                        progress: { step: 8, total: 8 },
                        preview: { url: "/api/runs/task_video_1/preview?t=42", mime: "image/jpeg" },
                        outputs: [{ index: 0, kind: "video", mime: "video/mp4", bytes: 3, filename: "task_video_1.mp4", url: `/api/canvases/${CANVAS_ID}/files/task_video_1.mp4` }],
                    }),
                ),
        });

        const steps: Array<{ step: number; total: number }> = [];
        const previews: Array<{ url: string } | null> = [];
        const result = await waitForVideoGenerationTask(
            server(),
            { id: "task_video_1", model: "video-h3-frames" },
            {
                onSteps: (value) => steps.push(value),
                onPreview: (value) => previews.push(value),
            },
        );

        // The result is the file the run wrote, by reference: name, URL, size and duration, no copy.
        expect(result).toMatchObject({
            storageKey: "files/task_video_1.mp4",
            url: `${ROOT}/api/canvases/${CANVAS_ID}/files/task_video_1.mp4`,
            mimeType: "video/mp4",
            bytes: 3,
            width: 1280,
            height: 720,
            durationMs: 5000,
        });
        expect(steps).toEqual([{ step: 8, total: 8 }]);
        expect(previews[0]).toMatchObject({ url: "http://127.0.0.1:8190/api/runs/task_video_1/preview?t=42" });
        expect(previews[previews.length - 1]).toBeNull();
        // The artifact is never fetched: it is already a file of the canvas.
        expect(calls.map((call) => call.url)).not.toContain(`${ROOT}/api/canvases/${CANVAS_ID}/files/task_video_1.mp4`);
    });

    it("passes a run the server failed on as a run failure, the one shape every mode reads", async () => {
        // It used to be rewrapped under a video-only name. The node has to tell "the run ended" from "the
        // question did not get there", and one error type for all three modes is what makes that one rule
        // (#235).
        stubServer({ status: () => json(run({ status: "failed", error: { code: "comfy_execution_failed", message: "Prompt outputs failed validation" } })) });

        const error = await waitForVideoGenerationTask(server(), { id: "task_video_1", model: "video-h3-frames" }).catch((caught) => caught);

        expect(error.name).toBe("RunFailedError");
        expect(error.message).toBe("Prompt outputs failed validation");
    });

    it("cancels the run only when the user stopped it", async () => {
        const { calls } = stubServer({});
        const controller = new AbortController();
        const watching = waitForVideoGenerationTask(server(), { id: "task_video_1", model: "video-h3-frames" }, { signal: controller.signal });
        controller.abort("user-stop");

        await expect(watching).rejects.toMatchObject({ name: "AbortError" });
        expect(calls.some((call) => call.method === "DELETE")).toBe(true);
    });

    it("leaves the run alone when the page goes away", async () => {
        const { calls } = stubServer({});
        const controller = new AbortController();
        const watching = waitForVideoGenerationTask(server(), { id: "task_video_1", model: "video-h3-frames" }, { signal: controller.signal });
        controller.abort();

        await expect(watching).rejects.toMatchObject({ name: "AbortError" });
        expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    });
});
