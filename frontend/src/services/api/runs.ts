import i18n from "@/i18n";
import { activeCanvasId } from "@/services/canvas-files";
import { gatewayRoot } from "@/constant/app-mode";
import { apiErrorMessage, httpJson } from "@/services/api/http";
import type { AiConfig } from "@/stores/use-config-store";

/**
 * The gateway's run protocol (docs/protocol.md): submit a workflow run, poll it, fetch its outputs.
 *
 * This is the only path the canvas uses to produce media: a run is the shape the gateway exposes, so
 * nothing here maps fields or guesses at a response envelope.
 */
type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type RunProgress = { phase?: string; step?: number; total?: number; percent?: number };

/** A live frame from a run that is still rendering, with a `t` stamp so a poll can replace it. */
type RunPreview = { url: string; mime?: string };

export type RunOutput = {
    index: number;
    kind: string;
    mime: string;
    bytes: number;
    filename: string;
    url: string;
};

export type Run = {
    id: string;
    workflow: string;
    status: RunStatus;
    progress?: RunProgress;
    preview?: RunPreview | null;
    outputs?: RunOutput[];
    error?: { code?: string; message?: string; details?: unknown } | null;
    created_at?: string;
    started_at?: string | null;
    finished_at?: string | null;
    prompt_id?: string;
};

type RunRequest = {
    workflow: string;
    inputs?: Record<string, unknown>;
    media?: Record<string, string | string[]>;
};

type RunWaitOptions = {
    signal?: AbortSignal;
    /** Milliseconds between status reads. */
    intervalMs?: number;
    onProgress?: (run: Run) => void;
    onSteps?: (steps: { step: number; total: number }) => void;
    /**
     * Cancel the run on the gateway when the caller aborts. Set for a generation the user started;
     * leave unset when merely watching a run that should survive a page leaving.
     */
    cancelOnAbort?: boolean;
};

/** A terminal failure reported by the gateway, kept as a type so callers can tell it from a network error. */
export class RunFailedError extends Error {
    constructor(readonly run: Run) {
        super(runErrorMessage(run));
        this.name = "RunFailedError";
    }
}

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);
const DEFAULT_INTERVAL_MS = 500;

/** The gateway root for `/api/*`: the channel address, with any legacy `/v1` suffix removed. */
export function gatewayProtocolRoot(baseUrl: string) {
    return gatewayRoot(baseUrl);
}

function runUrl(config: AiConfig, path: string) {
    return `${gatewayProtocolRoot(config.baseUrl)}${path}`;
}

/**
 * Where a run is submitted and where its media goes in: inside the canvas being edited.
 *
 * Since #156 a run belongs to a canvas — its artifacts are written into that canvas's `files/` and served
 * from there — so both endpoints are canvas-scoped. The canvas is the one on screen; there is no such
 * thing as a run that does not belong to one.
 */
function canvasApiUrl(config: AiConfig, path: string) {
    const canvas = activeCanvasId();
    if (!canvas) throw new Error(apiText("noCanvas"));
    return `${gatewayProtocolRoot(config.baseUrl)}/api/canvases/${encodeURIComponent(canvas)}${path}`;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Submit a run. Always answers with the run, never with its result: the id is the handle. */
export async function createRun(config: AiConfig, request: RunRequest): Promise<Run> {
    try {
        const run = await httpJson<Run>(canvasApiUrl(config, "/runs"), {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify(request),
        });
        if (!run?.id) throw new Error(apiText("runCreateFailed"));
        return run;
    } catch (error) {
        throw new Error(apiErrorMessage(error, apiText("runCreateFailed")));
    }
}

/** One media file uploaded to the gateway, ready to be referenced by a run. */
type UploadedMedia = { id: string; kind: string; mime: string; bytes: number; filename: string };

/**
 * Upload one media file and return its id.
 *
 * Runs reference media by id and role, so a reference image is uploaded once and named in the run
 * request instead of being re-sent as a multipart part with a guessed field name.
 */
export async function uploadMedia(config: AiConfig, file: Blob, filename: string, options: { signal?: AbortSignal } = {}): Promise<UploadedMedia> {
    const body = new FormData();
    body.append("file", file, filename);
    try {
        const payload = await httpJson<{ upload?: UploadedMedia }>(canvasApiUrl(config, "/uploads"), {
            method: "POST",
            body,
            signal: options.signal,
        });
        if (!payload?.upload?.id) throw new Error(apiText("runUploadFailed"));
        return payload.upload;
    } catch (error) {
        throw new Error(apiErrorMessage(error, apiText("runUploadFailed")));
    }
}

/** Read one run. */
async function getRun(config: AiConfig, id: string): Promise<Run> {
    try {
        return await httpJson<Run>(runUrl(config, `/api/runs/${encodeURIComponent(id)}`), {
            headers: JSON_HEADERS,
        });
    } catch (error) {
        throw new Error(apiErrorMessage(error, apiText("runQueryFailed")));
    }
}

/** Cancel a run. Idempotent on the gateway. */
export async function cancelRun(config: AiConfig, id: string): Promise<Run> {
    return httpJson<Run>(runUrl(config, `/api/runs/${encodeURIComponent(id)}`), {
        method: "DELETE",
        headers: JSON_HEADERS,
    });
}

/**
 * Poll a run until it is terminal.
 *
 * Resolves with the finished run, throws `RunFailedError` when the gateway reports a failure or a
 * cancellation, and rethrows the abort error when the caller aborts (cancelling the run first if
 * `cancelOnAbort` is set).
 */
export async function waitForRun(config: AiConfig, id: string, options: RunWaitOptions = {}): Promise<Run> {
    const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    for (;;) {
        if (options.signal?.aborted) {
            await cancelOnAbort(config, id, options);
            throw abortError();
        }
        const run = await getRun(config, id);
        options.onProgress?.(run);
        if (run.progress && run.progress.total && run.progress.total > 0) {
            options.onSteps?.({ step: Math.min(run.progress.total, Math.max(0, run.progress.step || 0)), total: run.progress.total });
        }
        if (run.status === "succeeded") return run;
        if (run.status === "failed" || run.status === "cancelled") throw new RunFailedError(run);
        try {
            await delay(interval, options.signal);
        } catch (error) {
            await cancelOnAbort(config, id, options);
            throw error;
        }
    }
}

/**
 * Where one output of a finished run is served from.
 *
 * The gateway answers with a path on itself; a run whose file lives elsewhere may answer with a URL, and
 * either is accepted. Nothing downloads: the file is already in the canvas the run belongs to, so a node
 * references it where it is (decisions #173).
 */
export function outputUrl(config: AiConfig, output: RunOutput): string {
    return /^https?:/i.test(output.url) ? output.url : runUrl(config, output.url);
}

function runErrorMessage(run: Run) {
    return run.error?.message || apiText("runFailed");
}

async function cancelOnAbort(config: AiConfig, id: string, options: RunWaitOptions) {
    if (!options.cancelOnAbort) return;
    try {
        await cancelRun(config, id);
    } catch {
        // Best effort: the caller is already aborting, and reporting this would replace its reason.
    }
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function abortError() {
    return new DOMException("Aborted", "AbortError");
}
