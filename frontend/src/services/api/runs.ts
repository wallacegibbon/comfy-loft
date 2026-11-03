import i18n from "@/i18n";
import { activeCanvasId } from "@/services/canvas-files";
import { gatewayRoot } from "@/constant/app-mode";
import { ApiError, apiErrorMessage, httpJson, throwIfCanceled } from "@/services/api/http";
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

/**
 * The run a file came from, as the node keeps it: the workflow that made it, and the moment it stopped.
 *
 * A node outlives its run. The record is pruned by the store (`TASK_RETENTION_DAYS`, `MAX_STORED_TASKS`) and
 * a finished image node keeps no run id at all, so the two facts that answer *what made this, and when* have
 * to be written down where the picture is. Absent on a file the user picked: nothing made it
 * (docs/decisions.md #227).
 */
export type RunFacts = { workflow: string; finishedAt: string };

/**
 * What a finished run leaves on its artifacts — or nothing, for a run that names no workflow to believe.
 *
 * `finished_at` is stamped under the same lock that marks the run terminal, so a poll that sees `succeeded`
 * sees it too; `created_at` is the fallback for a record that carries only that. `workflow` is the gateway's
 * own id for what ran (`image-z-image-turbo`), which is not the same string as the model the user picked
 * (`default::image-z-image-turbo`): a pick can be renamed or deleted afterwards, and what ran cannot.
 */
export function factsOf(run: Run): RunFacts | undefined {
    const workflow = (run.workflow || "").trim();
    const finishedAt = (run.finished_at || run.created_at || "").trim();
    return workflow && finishedAt ? { workflow, finishedAt } : undefined;
}

export type RunRequest = {
    workflow: string;
    inputs?: Record<string, unknown>;
    media?: Record<string, string | string[]>;
    /**
     * The agent that asked for this run: the session to tell when it ends, and the node it asked about.
     *
     * A generation takes minutes and `generate` answers at once, so the agent's turn can end with the run
     * still going. The mapping travels with the run — the gateway keeps it, and says what happened when
     * the run ends (docs/decisions.md #225). Absent for a run the user started: nobody has to be told
     * about their own button.
     */
    askedBy?: { session: string; node?: string };
};

type RunWaitOptions = {
    signal?: AbortSignal;
    /** Milliseconds between status reads. */
    intervalMs?: number;
    /** How long the gateway may be unreachable before the watch gives up. Defaults to three minutes. */
    unreachableMs?: number;
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
        throwIfCanceled(error);
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
        throwIfCanceled(error);
        throw new Error(apiErrorMessage(error, apiText("runUploadFailed")));
    }
}

/**
 * One read of a run.
 *
 * The error is passed on as it arrived: `waitForRun` has to tell a gateway that will not answer from a
 * gateway that has no record of this run, and only the status says which (#234).
 */
async function getRun(config: AiConfig, id: string): Promise<Run> {
    return httpJson<Run>(runUrl(config, `/api/runs/${encodeURIComponent(id)}`), { headers: JSON_HEADERS });
}

/** Cancel a run. Idempotent on the gateway. */
export async function cancelRun(config: AiConfig, id: string): Promise<Run> {
    return httpJson<Run>(runUrl(config, `/api/runs/${encodeURIComponent(id)}`), {
        method: "DELETE",
        headers: JSON_HEADERS,
    });
}

/**
 * How long a run may be unreachable before the canvas stops watching it.
 *
 * A run belongs to the gateway, and a gateway goes away for ordinary reasons — a restart, a deploy, a
 * dropped network. The run itself has not changed when it does, and the node still holds its id, so the
 * honest thing is to keep asking. This is the bound on "keep asking": past it the node is told it could not
 * reach the run, instead of sitting on a progress bar that will never move again (#234).
 */
const RUN_UNREACHABLE_MS = 3 * 60_000;

/**
 * Poll a run until it is terminal.
 *
 * Resolves with the finished run, throws `RunFailedError` when the gateway reports a failure or a
 * cancellation, and rethrows the abort error when the caller aborts (cancelling the run first if
 * `cancelOnAbort` is set).
 *
 * A run that cannot be *reached* is not a run that failed. The gateway being away — restarted, redeployed,
 * off the network for a moment — leaves the run exactly where it was, so the loop keeps asking and picks the
 * run up again when it answers. Only two things end the watch: the gateway saying the run ended, and the
 * gateway being gone long enough that waiting is no longer honest. A 404 is the first: it means the gateway
 * has no record of this run, and it will not grow one.
 */
export async function waitForRun(config: AiConfig, id: string, options: RunWaitOptions = {}): Promise<Run> {
    const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const unreachableMs = options.unreachableMs ?? RUN_UNREACHABLE_MS;
    let unreachableSince: number | null = null;
    for (;;) {
        if (options.signal?.aborted) {
            await cancelOnAbort(config, id, options);
            throw abortError();
        }
        let run: Run;
        try {
            run = await getRun(config, id);
            unreachableSince = null;
        } catch (error) {
            throwIfCanceled(error);
            if (error instanceof ApiError && error.status === 404) throw new Error(apiErrorMessage(error, apiText("runQueryFailed")));
            unreachableSince ??= Date.now();
            if (Date.now() - unreachableSince > unreachableMs) throw new Error(apiText("runUnreachable"));
            try {
                await delay(interval, options.signal);
            } catch (delayedError) {
                await cancelOnAbort(config, id, options);
                throw delayedError;
            }
            continue;
        }
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
