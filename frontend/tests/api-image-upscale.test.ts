import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Image upscaling through the run protocol.
 *
 * The upscaler used to be a multipart post to `/v1/images/upscale`. It is one of the workflows the
 * canvas drives from a button rather than the model list, so it was the last image action outside
 * the run protocol: now the source image is uploaded once, named by role, and the chosen workflow's
 * own knobs are the typed inputs.
 */
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/services/api/gateway-status", () => ({ noteGatewayError: () => undefined, noteGatewayResponse: () => undefined }));

// Media conversion is a browser concern; these tests are about the request the canvas builds. A generated
// image is measured where it is served, not downloaded and re-uploaded (#173).
vi.mock("@/services/image-storage", () => ({
    imageToDataUrl: async () => "data:image/png;base64,AAAA",
    readImageSize: async () => ({ width: 512, height: 512 }),
}));
vi.mock("@/lib/image-utils", () => ({
    dataUrlToFile: (image: { name?: string }) => new File([new Uint8Array([1, 2, 3])], image.name || "source.png", { type: "image/png" }),
}));

const { requestUpscale } = await import("@/services/api/image");

// A run belongs to a canvas (#156): these cases post into one.
const { setActiveCanvas } = await import("@/services/canvas-files");
const CANVAS_ID = "40e8afb47f10";
setActiveCanvas(CANVAS_ID);
type Config = Parameters<typeof requestUpscale>[0];

const gateway = () =>
    ({
        baseUrl: "http://127.0.0.1:8190/v1",
        apiKey: "local",
        apiFormat: "openai",
        channels: [],
        models: ["image-qwen21"],
        model: "image-qwen21",
        imageModel: "image-qwen21",
        size: "1024x1024",
        count: "1",
        systemPrompt: "",
        quality: "",
        params: {},
    }) as unknown as Config;

const image = (name: string, storageKey?: string) => ({ id: name, name, dataUrl: "data:image/png;base64,AAAA", storageKey }) as never;

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

const run = (overrides: Record<string, unknown> = {}) => ({
    id: "task_upscale_1",
    workflow: "image-esrgan-upscale",
    status: "running",
    progress: { step: 0, total: 0 },
    outputs: [],
    error: null,
    ...overrides,
});

const succeeded = () =>
    json(
        run({
            status: "succeeded",
            outputs: [{ index: 0, kind: "image", mime: "image/png", bytes: 3, filename: "task_upscale_1.png", url: `/api/canvases/${CANVAS_ID}/files/task_upscale_1.png` }],
        }),
    );

type Call = { url: string; method: string; body: unknown };

/** Where the gateway is in these cases: `gatewayProtocolRoot` strips the legacy `/v1`, nothing else. */
const ROOT = "http://127.0.0.1:8190";

/** The name the gateway gives an uploaded file: its id is that name, not a handle of its own (#156). */
const UPLOAD_ID = "up-9f01ab2c.png";

/**
 * Route a stubbed fetch by the **whole** URL, and answer `404` to anything else.
 *
 * This is deliberate. A stub that matched a path suffix (`url.endsWith("/runs")`) accepts a request sent
 * to the wrong place, and the test then passes on a URL the gateway does not serve — which is exactly how
 * `POST /api/runs` survived #156 until a browser click found it (#161). Here an unexpected address is a
 * failure the caller cannot miss.
 */
function stubGateway(handlers: { status?: () => Response } = {}) {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: String(init.method || "GET"), body: init.body });
        if (url === `${ROOT}/api/canvases/${CANVAS_ID}/uploads`) return json({ upload: { id: UPLOAD_ID, kind: "image", mime: "image/png", bytes: 3, filename: "source.png" } });
        if (url === `${ROOT}/api/canvases/${CANVAS_ID}/runs`) return json(run({ status: "queued" }), 202);
        if (url === `${ROOT}/api/runs/task_upscale_1`) return handlers.status?.() ?? succeeded();
        return json({ error: { code: "not_found", message: `no such route: ${init.method || "GET"} ${url}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls, fetchMock };
}

/** The JSON body of the one run-submission call. */
function runBody(calls: Call[]) {
    const call = calls.find((item) => item.url === `${ROOT}/api/canvases/${CANVAS_ID}/runs` && item.method === "POST");
    if (!call) throw new Error(`no run was submitted; the calls were ${calls.map((item) => `${item.method} ${item.url}`).join(", ")}`);
    return JSON.parse(String(call.body));
}

beforeEach(() => {
    vi.unstubAllGlobals();
});

describe("requestUpscale", () => {
    it("names a source that is already a canvas file instead of copying it", async () => {
        // The node's picture is a file of this canvas, and a run reads its media by name from the same canvas
        // (#156, #174): uploading it first would store the same bytes again under an `up-` name.
        const { calls } = stubGateway();

        const images = await requestUpscale(gateway(), image("source.png", "files/up-abcdef12.png"), {
            workflowId: "image-esrgan-upscale",
            params: { upscale_model: "RealESRGAN_x4plus.pth" },
        });

        expect(images).toHaveLength(1);
        expect(calls.map((call) => call.url)).toEqual([`${ROOT}/api/canvases/${CANVAS_ID}/runs`, `${ROOT}/api/runs/task_upscale_1`]);
        expect(runBody(calls).media).toEqual({ image: ["up-abcdef12.png"] });
    });

    it("is one run with the source image uploaded by role", async () => {
        const { calls } = stubGateway();

        const images = await requestUpscale(gateway(), image("source.png"), {
            workflowId: "image-esrgan-upscale",
            params: { upscale_model: "RealESRGAN_x4plus.pth" },
        });

        expect(images).toHaveLength(1);
        // The result is a reference to the file the run wrote, not a copy of it.
        expect(images[0]).toMatchObject({
            storageKey: "files/task_upscale_1.png",
            url: `${ROOT}/api/canvases/${CANVAS_ID}/files/task_upscale_1.png`,
            width: 512,
            height: 512,
            bytes: 3,
            mimeType: "image/png",
        });
        // Three addresses, in full: the source into the canvas, the run into it, and the run's status. The
        // artifact is *not* fetched — it is already there, and the node points at it.
        expect(calls.map((call) => call.url)).toEqual([`${ROOT}/api/canvases/${CANVAS_ID}/uploads`, `${ROOT}/api/canvases/${CANVAS_ID}/runs`, `${ROOT}/api/runs/task_upscale_1`]);
        // Nothing reaches the OpenAI-shaped surface any more: the id in hand is a run id.
        expect(calls.some((call) => call.url.includes("/v1/"))).toBe(false);

        const body = runBody(calls);
        expect(body.workflow).toBe("image-esrgan-upscale");
        expect(body.inputs).toEqual({ upscale_model: "RealESRGAN_x4plus.pth" });
        // An upload is referenced by the name the gateway gave it, which is its id.
        expect(body.media).toEqual({ image: [UPLOAD_ID] });
    });

    it("sends no prompt: the workflow's own default is the prompt", async () => {
        const { calls } = stubGateway();

        await requestUpscale(gateway(), image("source.png"), { workflowId: "image-esrgan-upscale" });

        // An undeclared key is a 400 from the typed input contract, so a prompt here would break
        // every upscale that has its own text binding.
        expect(runBody(calls).inputs).toEqual({});
    });

    it("reports the run's failure as the request's failure", async () => {
        stubGateway({
            status: () => json(run({ status: "failed", error: { code: "comfy_execution_failed", message: "Prompt outputs failed validation" } })),
        });

        await expect(requestUpscale(gateway(), image("source.png"), { workflowId: "image-esrgan-upscale" })).rejects.toThrow("Prompt outputs failed validation");
    });
});
