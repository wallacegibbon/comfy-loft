import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Image upscaling through the run protocol.
 *
 * The upscaler used to be a multipart post to `/v1/images/upscale`. It is one of the workflows the
 * canvas drives from a button rather than the model list, so it was the last image action outside
 * the run protocol: now the source image is uploaded once, named by role, and the chosen workflow's
 * own knobs are the typed inputs.
 */
// `t` answers with the key, except where the caller passes the sentence to wrap: the reference-prefix
// template takes the user's words as `prompt`, and keeping them makes the assertion below about the words
// that reached the run rather than about the wrapper's own text.
vi.mock("@/i18n", () => ({ default: { t: (key: string, options?: { prompt?: string }) => (typeof options?.prompt === "string" ? options.prompt : key) } }));
vi.mock("@/services/api/server-status", () => ({ noteServerError: () => undefined, noteServerResponse: () => undefined }));

// Media conversion is a browser concern; these tests are about the request the canvas builds. A generated
// image is measured where it is served, not downloaded and re-uploaded (#173).
vi.mock("@/services/image-storage", () => ({
    imageToDataUrl: async () => "data:image/png;base64,AAAA",
    readImageSize: async () => ({ width: 512, height: 512 }),
}));
vi.mock("@/lib/image-utils", () => ({
    dataUrlToFile: (image: { name?: string }) => new File([new Uint8Array([1, 2, 3])], image.name || "source.png", { type: "image/png" }),
}));

const { requestEdit, requestGeneration } = await import("@/services/api/image");

// A run belongs to a canvas (#156): these cases post into one.
const { setActiveCanvas } = await import("@/services/canvas-files");
const CANVAS_ID = "40e8afb47f10";
setActiveCanvas(CANVAS_ID);
type Config = Parameters<typeof requestEdit>[0];

const server = () =>
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

/** Where the server is in these cases: `serverProtocolRoot` strips the legacy `/v1`, nothing else. */
const ROOT = "http://127.0.0.1:8190";

/** The name the server gives an uploaded file: its id is that name, not a handle of its own (#156). */
const UPLOAD_ID = "up-9f01ab2c.png";

/**
 * Route a stubbed fetch by the **whole** URL, and answer `404` to anything else.
 *
 * This is deliberate. A stub that matched a path suffix (`url.endsWith("/runs")`) accepts a request sent
 * to the wrong place, and the test then passes on a URL the server does not serve — which is exactly how
 * `POST /api/runs` survived #156 until a browser click found it (#161). Here an unexpected address is a
 * failure the caller cannot miss.
 */
function stubServer(handlers: { status?: () => Response } = {}) {
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

/** A config whose one model is a *step*: no prompt binding, one declared knob. */
const stepServer = () =>
    ({
        ...server(),
        channels: [
            {
                id: "local",
                name: "local",
                baseUrl: "http://127.0.0.1:8190/v1",
                models: [
                    {
                        name: "image-esrgan-upscale",
                        capability: "image",
                        workflowId: "image-esrgan-upscale",
                        tool: true,
                        hasPrompt: false,
                        imageInputs: 1,
                        parameters: [{ key: "upscale_model", type: "select", options: ["RealESRGAN_x2plus.pth", "RealESRGAN_x4plus.pth"], default: "RealESRGAN_x2plus.pth" }],
                    },
                ],
            },
        ],
        model: "local::image-esrgan-upscale",
        imageModel: "local::image-esrgan-upscale",
        params: { upscale_model: "RealESRGAN_x4plus.pth" },
    }) as unknown as Config;

describe("an image node running a step", () => {
    it("sends the declared knob and the source picture, and no prompt", async () => {
        const { calls } = stubServer();

        await requestEdit(stepServer(), "words an upscaler never reads", [image("source.png")]);

        const body = runBody(calls);
        expect(body.workflow).toBe("image-esrgan-upscale");
        // No `prompt`, no `size`, no `mode`: the upscaler declares none of them, and the server accepts and
        // ignores an undeclared key, so sending one would read as a knob that did nothing.
        expect(body.inputs).toEqual({ upscale_model: "RealESRGAN_x4plus.pth" });
        expect(body.media).toEqual({ image: [UPLOAD_ID] });
    });
});

// A step that takes words: the angle re-render is told what to keep and what to change, and it is one of the
// workflows the canvas drives from a button. It is a step because it is a tool — not because it has no prompt
// box — so its request carries the prompt *and* its knobs (docs/decisions.md #267).
const angleServer = () =>
    ({
        ...server(),
        channels: [
            {
                id: "local",
                name: "local",
                baseUrl: "http://127.0.0.1:8190/v1",
                models: [
                    {
                        name: "image-qwen21-angle",
                        capability: "image",
                        workflowId: "image-qwen21-angle",
                        tool: true,
                        hasPrompt: true,
                        imageInputs: 1,
                        parameters: [],
                    },
                ],
            },
        ],
        model: "local::image-qwen21-angle",
        imageModel: "local::image-qwen21-angle",
        params: { horizontalAngle: 30, pitchAngle: 5, cameraDistance: 4 },
    }) as unknown as Config;

describe("a step that takes words", () => {
    it("sends the prompt beside its knobs, and only because it binds one", async () => {
        const { calls } = stubServer();

        await requestEdit(angleServer(), "keep the colours, turn the camera left", [image("source.png")]);

        const body = runBody(calls);
        expect(body.workflow).toBe("image-qwen21-angle");
        expect(body.inputs).toEqual({ prompt: "keep the colours, turn the camera left", horizontalAngle: 30, pitchAngle: 5, cameraDistance: 4 });
        expect(body.media).toEqual({ image: [UPLOAD_ID] });
    });
});

// `layout` is the node's own word, not a mode the server has: it means "a text-to-image run whose prompt
// carries a MOSS layout". Reading it off the *resolved* mode dropped the layout on every workflow without
// variants — the case that actually works — while sending nothing (docs/decisions.md #271).
describe("a layout run", () => {
    const layout = { rows: [{ cells: [{ nodeId: "image-1", w: 1, h: 1 }] }] };
    const moss = () =>
        ({
            ...server(),
            imageMode: "layout",
            layout,
            channels: [
                {
                    id: "local",
                    name: "local",
                    baseUrl: "http://127.0.0.1:8190/v1",
                    models: [{ name: "image-moss-sft-8step", capability: "image", workflowId: "image-moss-sft-8step", hasPrompt: true }],
                },
            ],
            model: "local::image-moss-sft-8step",
            imageModel: "local::image-moss-sft-8step",
        }) as unknown as Config;

    it("carries the layout, and sends no mode the workflow does not have", async () => {
        const { calls } = stubServer();

        await requestGeneration(moss(), "a poster in four panels");

        const body = runBody(calls);
        expect(body.inputs.layout).toEqual(layout);
        expect(body.inputs.layoutEnabled).toBe(true);
        // A workflow with no variants is sent no `mode` at all, exactly as before.
        expect(body.inputs.mode).toBeUndefined();
    });

    it("pins a declared mode when the family has one, and still carries the layout", async () => {
        const { calls } = stubServer();
        const family = {
            ...moss(),
            channels: [
                {
                    id: "local",
                    name: "local",
                    baseUrl: "http://127.0.0.1:8190/v1",
                    models: [
                        {
                            name: "image-family",
                            capability: "image",
                            workflowId: "image-family",
                            hasPrompt: true,
                            variantModes: ["edit", "t2i"],
                            contracts: { edit: { accepts: { images: { min: 1, max: 4 } } }, t2i: { accepts: { images: { max: 0 } } } },
                        },
                    ],
                },
            ],
            model: "local::image-family",
            imageModel: "local::image-family",
        } as unknown as Config;

        await requestGeneration(family, "a poster in four panels");

        const body = runBody(calls);
        // `layout` is not a mode this family declares, so the run pins the mode that asks least — and the
        // layout, which is what the node asked for, is still attached.
        expect(body.inputs.mode).toBe("t2i");
        expect(body.inputs.layout).toEqual(layout);
    });
});

// A knob the running model does not declare used to be sent and refused: `unknown_input`, on a field the user
// never typed. The node keeps its params when the model changes, so the request is where they are pruned
// (docs/decisions.md #274).
describe("a stale knob", () => {
    it("is dropped from the request instead of being refused by the server", async () => {
        const { calls } = stubServer();
        const image = {
            ...server(),
            channels: [
                {
                    id: "local",
                    name: "local",
                    baseUrl: "http://127.0.0.1:8190/v1",
                    models: [{ name: "image-z-image-turbo", capability: "image", workflowId: "image-z-image-turbo", hasPrompt: true, inputs: ["prompt", "size", "seed", "editCanvasSize"] }],
                },
            ],
            model: "local::image-z-image-turbo",
            imageModel: "local::image-z-image-turbo",
            // `upscale_model` is what the upscaler wrote onto the node before the model was changed.
            params: { upscale_model: "RealESRGAN_x4plus.pth", seed: 7 },
        } as unknown as Config;

        await requestGeneration(image, "a brass compass");

        const body = runBody(calls);
        expect(body.inputs).toEqual({ prompt: "a brass compass", seed: 7, size: "1024x1024" });
    });
});
