import { CanvasConflictError, CanvasMissingError, type CanvasDocument, type CanvasSummary } from "@/services/api/canvases";

/**
 * The queue that turns "the canvas changed" into saves.
 *
 * The browser used to be the truth: a change updated the store and a debounce wrote the whole thing
 * into IndexedDB. Now the document lives on disk and this queue is the only writer, which makes three
 * things its job:
 *
 *   - **Coalescing.** Dragging a node is sixty changes a second. A save per change would be sixty
 *     requests and sixty versions; the debounce means one, carrying whatever the canvas looks like
 *     when it fires. The snapshot is read at flush time, not at schedule time, for exactly that
 *     reason — a queued save must send the newest state, never the one that queued it.
 *   - **Ordering.** One save per canvas at a time. A second flush while one is in flight does not
 *     start a second request: it marks the canvas dirty again, and the in-flight save schedules the
 *     next one when it finishes. That is what keeps `rev` meaningful — two saves racing each other
 *     would hand the server a stale `If-Match` on purpose.
 *   - **Deciding what a failure means.** A network error is temporary: retry with backoff and keep the
 *     canvas dirty. A 409 is neither temporary nor a network failure: the copy on disk moved on, which
 *     in a single-user build means another tab is editing the same canvas. Retrying with the new version
 *     would overwrite that tab's work with this one's older document, so the queue **stops** and hands
 *     the decision to the user (#158).
 *
 * Timers and the save function are injected so the whole thing is testable without a browser, which is
 * the only reason this is a module rather than twenty lines inside the store.
 */

export type SaveSnapshot = { document: CanvasDocument; rev: string; title?: string };

type SaveQueueOptions = {
    /** The canvas as it is now, or null if it is gone (deleted while a save was queued). */
    snapshot: (id: string) => SaveSnapshot | null;
    /**
     * Write one snapshot.
     *
     * `keepalive` is set when this flush happens because the page is going away: the request has to survive
     * the navigation, and the transport decides whether the body is small enough to be kept (decisions #177).
     */
    save: (id: string, snapshot: SaveSnapshot, options?: { keepalive?: boolean }) => Promise<CanvasSummary>;
    onSaved: (id: string, summary: CanvasSummary) => void;
    onConflict: (id: string, current: CanvasSummary) => void;
    /** The canvas is gone. Nothing to retry: what is on screen can only be exported now. */
    onMissing: (id: string) => void;
    onError: (id: string, error: unknown) => void;
    /** How long the canvas must sit still before a save fires. */
    debounceMs?: number;
    /** Delays for retrying a failed save. Running out does not drop the change; the next edit retries. */
    retryDelaysMs?: number[];
    timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
};

export type SaveQueue = {
    /** Note that a canvas changed. Idempotent: a burst of changes is one save. */
    schedule: (id: string) => void;
    /** Save now, cancelling the pending debounce. */
    flush: (id: string) => Promise<void>;
    /** Save every canvas that has anything pending. Used when the page is going away. */
    flushAll: () => Promise<void>;
    isDirty: (id: string) => boolean;
    /** Drop everything known about a canvas, after it was deleted. */
    forget: (id: string) => void;
};

type Entry = {
    timer: unknown;
    retry: unknown;
    running: boolean;
    dirty: boolean;
    conflicts: number;
    /** How many of `retryDelaysMs` have been spent on the current failure. */
    attempt: number;
    /** The retry schedule ran out: only a new edit may try again. */
    exhausted: boolean;
};

export function createSaveQueue(options: SaveQueueOptions): SaveQueue {
    const debounceMs = options.debounceMs ?? 400;
    const retryDelaysMs = options.retryDelaysMs ?? [1000, 2000, 5000];
    const timers = options.timers ?? globalThis;
    const entries = new Map<string, Entry>();

    const entryOf = (id: string): Entry => {
        let entry = entries.get(id);
        if (!entry) {
            entry = { timer: undefined, retry: undefined, running: false, dirty: false, conflicts: 0, attempt: 0, exhausted: false };
            entries.set(id, entry);
        }
        return entry;
    };

    const cancel = (handle: unknown) => {
        if (handle !== undefined) timers.clearTimeout(handle as never);
    };

    /** Arm the debounce that turns a pending change into a save, unless one is already armed. */
    const arm = (id: string, entry: Entry) => {
        if (entry.running || entry.timer !== undefined || entry.retry !== undefined) return;
        entry.timer = timers.setTimeout(() => {
            entry.timer = undefined;
            void flush(id);
        }, debounceMs);
    };

    /** A settled save: either it worked, or the canvas is dirty again and the caller has been told. */
    const settle = (id: string, entry: Entry) => {
        entry.running = false;
        // Nothing more to do when the change is gone, when a timer is already armed, or when the retry
        // schedule ran out — that last case is the one that used to re-arm the debounce for ever, one
        // refused save every 400 ms.
        if (!entry.dirty || entry.exhausted || entry.timer !== undefined || entry.retry !== undefined) return;
        // A change arrived while this save was in flight. Wait out a fresh debounce rather than
        // firing immediately: the next keystroke is usually already on its way.
        arm(id, entry);
    };

    /** A change worth saving. Idempotent, and it restarts a retry schedule that had run out. */
    const schedule = (id: string) => {
        const entry = entryOf(id);
        entry.dirty = true;
        entry.exhausted = false;
        entry.attempt = 0;
        cancel(entry.retry);
        entry.retry = undefined;
        arm(id, entry);
    };

    const flush = async (id: string, flushOptions?: { keepalive?: boolean }): Promise<void> => {
        const entry = entryOf(id);
        if (entry.running) return;
        cancel(entry.timer);
        entry.timer = undefined;

        const snapshot = options.snapshot(id);
        // Nothing to send: the canvas was deleted, or its document never loaded.
        if (!snapshot) {
            entry.dirty = false;
            return;
        }
        if (!entry.dirty) return;

        entry.dirty = false;
        entry.running = true;
        try {
            const summary = await options.save(id, snapshot, flushOptions?.keepalive ? { keepalive: true } : undefined);
            entry.conflicts = 0;
            entry.attempt = 0;
            entry.exhausted = false;
            cancel(entry.retry);
            entry.retry = undefined;
            options.onSaved(id, summary);
        } catch (error) {
            if (error instanceof CanvasMissingError) {
                // Deleted under us. Retrying would answer 404 forever, and the user's next edit would
                // queue another one, so the canvas stops being dirty and stops being saved.
                entry.dirty = false;
                options.onMissing(id);
            } else if (isConflict(error)) {
                // Stop here, with the change still in memory and on screen. Overwriting is a decision for
                // the person, not a retry policy: the other copy is not stale, it is someone's work.
                entry.conflicts += 1;
                entry.dirty = false;
                cancel(entry.retry);
                entry.retry = undefined;
                options.onConflict(id, error.current);
            } else {
                options.onError(id, error);
                entry.dirty = true;
                const delay = retryDelaysMs[entry.attempt];
                if (delay !== undefined) {
                    entry.attempt += 1;
                    cancel(entry.retry);
                    entry.retry = timers.setTimeout(() => {
                        entry.retry = undefined;
                        void flush(id);
                    }, delay);
                } else {
                    // Out of retries. The change is kept (the canvas stays dirty) but nothing tries again
                    // on its own: the next edit calls `schedule`, which starts a fresh schedule.
                    entry.exhausted = true;
                }
            }
        } finally {
            entry.running = false;
            if (entry.dirty) settle(id, entry);
        }
    };

    /**
     * Flush everything, for a page that is closing.
     *
     * The saves carry `keepalive` so the transport can ask the browser to deliver them across the navigation;
     * nothing here waits for an answer, because nothing survives the unload.
     */
    const flushAll = async () => {
        const ids = [...entries.entries()].filter(([, entry]) => entry.dirty || entry.timer !== undefined).map(([id]) => id);
        await Promise.all(ids.map((id) => flush(id, { keepalive: true })));
    };

    return {
        schedule,
        flush,
        flushAll,
        isDirty: (id) => Boolean(entries.get(id)?.dirty),
        forget: (id) => {
            const entry = entries.get(id);
            if (entry) {
                cancel(entry.timer);
                cancel(entry.retry);
            }
            entries.delete(id);
        },
    };
}

function isConflict(error: unknown): error is CanvasConflictError {
    return error instanceof CanvasConflictError;
}
