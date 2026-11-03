import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Run } from "@/services/api/runs";

/**
 * The run protocol client.
 *
 * Two properties matter and neither is visible in the browser: a relative output URL must resolve
 * against the gateway root (not the `/v1` API root), and polling must stop at a terminal state,
 * reporting failed runs and aborting without leaving a request in flight.
 */
const t = vi.fn((key: string) => key);

vi.mock("@/i18n", () => ({ default: { t: (key: string) => t(key) } }));

const noteGatewayError = vi.fn();
vi.mock("@/services/api/gateway-status", () => ({ noteGatewayError: (...args: unknown[]) => noteGatewayError(...args), noteGatewayResponse: () => undefined }));
vi.mock("@/services/image-storage", () => ({ readImageSize: async () => ({ width: 512, height: 512 }) }));

const { RunFailedError, createRun, gatewayProtocolRoot, outputUrl, waitForRun } = await import("@/services/api/runs");
const { generatedImage } = await import("@/lib/canvas/generated-media");
const { setActiveCanvas } = await import("@/services/canvas-files");

// A run and an upload belong to the canvas on screen (#156), so every case here opens one.
const CANVAS = "40e8afb47f10";

type Config = Parameters<typeof createRun>[0];
const config = { baseUrl: "http://gateway.test:8190/v1", apiKey: "local" } as unknown as Config;

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

const run = (overrides: Partial<Run> = {}): Run => ({
    id: "task_1",
    workflow: "audio-minimax-music-3",
    status: "running",
    progress: { step: 0, total: 0 },
    outputs: [],
    error: null,
    ...overrides,
});

beforeEach(() => {
    t.mockClear();
    noteGatewayError.mockClear();
    vi.unstubAllGlobals();
});

describe("gatewayProtocolRoot", () => {
    it("strips the /v1 suffix so /api routes address the gateway, not its API prefix", () => {
        expect(gatewayProtocolRoot("http://gateway.test:8190/v1")).toBe("http://gateway.test:8190");
        expect(gatewayProtocolRoot("http://gateway.test:8190/v1/")).toBe("http://gateway.test:8190");
        expect(gatewayProtocolRoot("http://gateway.test:8190/")).toBe("http://gateway.test:8190");
    });
});

describe("createRun", () => {
    beforeEach(() => setActiveCanvas(CANVAS));

    it("posts the workflow and inputs into the canvas", async () => {
        const fetchMock = vi.fn(async () => json(run({ status: "queued" })));
        vi.stubGlobal("fetch", fetchMock);

        const created = await createRun(config, {
            workflow: "audio-minimax-music-3",
            inputs: { prompt: "indie folk", lyrics: "[Verse]\nhello" },
        });

        expect(created.id).toBe("task_1");
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`http://gateway.test:8190/api/canvases/${CANVAS}/runs`);
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({
            workflow: "audio-minimax-music-3",
            inputs: { prompt: "indie folk", lyrics: "[Verse]\nhello" },
        });
    });

    it("says which conversation asked, so the gateway can tell it when the run ends", async () => {
        // `generate` answers at once, so the agent's turn can end with the run still going. The session
        // and node travel with the request: that pairing is the mapping the gateway reports on (#225).
        const fetchMock = vi.fn(async () => json(run({ status: "queued" })));
        vi.stubGlobal("fetch", fetchMock);

        await createRun(config, { workflow: "flux", inputs: { prompt: "a cat" }, askedBy: { session: "canvas:40e8afb47f10", node: "n12" } });

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({
            workflow: "flux",
            inputs: { prompt: "a cat" },
            askedBy: { session: "canvas:40e8afb47f10", node: "n12" },
        });
    });

    it("leaves the field out for a run the user started", async () => {
        // Nobody has to be told about their own button — and an `askedBy: undefined` key would say the
        // same thing only by accident (it survives JSON.stringify only as an absent key).
        const fetchMock = vi.fn(async () => json(run({ status: "queued" })));
        vi.stubGlobal("fetch", fetchMock);

        await createRun(config, { workflow: "flux", inputs: { prompt: "a cat" }, askedBy: undefined });

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(String(init.body))).not.toHaveProperty("askedBy");
    });
});

describe("waitForRun", () => {
    it("polls until succeeded and reports steps", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(json(run({ progress: { step: 3, total: 10 } })))
            .mockResolvedValueOnce(json(run({ status: "succeeded", progress: { step: 10, total: 10 }, outputs: [{ index: 0, kind: "audio", mime: "audio/mpeg", bytes: 3, filename: "t.mp3", url: `/api/canvases/${CANVAS}/files/task_1.mp3` }] })));
        vi.stubGlobal("fetch", fetchMock);

        const steps: Array<{ step: number; total: number }> = [];
        const finished = await waitForRun(config, "task_1", { intervalMs: 1, onSteps: (value) => steps.push(value) });

        expect(finished.status).toBe("succeeded");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(steps).toEqual([
            { step: 3, total: 10 },
            { step: 10, total: 10 },
        ]);
    });

    it("throws the gateway's message when the run fails", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => json(run({ status: "failed", error: { code: "comfy_execution_failed", message: "Prompt outputs failed validation" } }))),
        );

        const error = await waitForRun(config, "task_1", { intervalMs: 1 }).catch((caught) => caught);
        expect(error).toBeInstanceOf(RunFailedError);
        expect(error.message).toBe("Prompt outputs failed validation");
    });

    it("cancels the run when the caller aborts, if asked to", async () => {
        const fetchMock = vi.fn(async () => json(run({ status: "cancelled" })));
        vi.stubGlobal("fetch", fetchMock);
        const controller = new AbortController();
        controller.abort();

        await expect(waitForRun(config, "task_1", { signal: controller.signal, cancelOnAbort: true })).rejects.toMatchObject({ name: "AbortError" });

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("http://gateway.test:8190/api/runs/task_1");
        expect(init.method).toBe("DELETE");
    });

    it("does not cancel a run it is only watching", async () => {
        const fetchMock = vi.fn(async () => json(run()));
        vi.stubGlobal("fetch", fetchMock);
        const controller = new AbortController();
        controller.abort();

        await expect(waitForRun(config, "task_1", { signal: controller.signal, cancelOnAbort: false })).rejects.toMatchObject({ name: "AbortError" });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("a run's files", () => {
    // The run wrote them into the canvas, so a node references the file where it is: the name the document
    // uses (`files/<name>`) and the URL a browser reads it from. Nothing is downloaded or copied (#173).
    const finished = () =>
        run({
            status: "succeeded",
            outputs: [
                { index: 0, kind: "image", mime: "image/png", bytes: 12, filename: "task_1.png", url: `/api/canvases/${CANVAS}/files/task_1.png` },
                { index: 1, kind: "image", mime: "image/png", bytes: 34, filename: "task_1-2.png", url: `/api/canvases/${CANVAS}/files/task_1-2.png` },
            ],
        });

    it("resolves a relative output URL against the gateway root", () => {
        const output = finished().outputs![0];
        expect(outputUrl(config, output)).toBe(`http://gateway.test:8190/api/canvases/${CANVAS}/files/task_1.png`);
    });

    it("names the file the way the document does", async () => {
        const image = await generatedImage(config, finished());
        expect(image.storageKey).toBe("files/task_1.png");
        expect(image.url).toBe(`http://gateway.test:8190/api/canvases/${CANVAS}/files/task_1.png`);
        expect(image).toMatchObject({ bytes: 12, mimeType: "image/png", width: 512, height: 512 });
    });
});
