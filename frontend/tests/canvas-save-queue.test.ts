import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createSaveQueue, type SaveSnapshot } from "../src/lib/canvas/save-queue";
import { CanvasConflictError, CanvasMissingError, emptyCanvasDocument, type CanvasSummary } from "../src/services/api/canvases";

/**
 * The save queue is the only writer the canvas has, so these are the cases that matter: a burst of
 * edits is one save carrying the newest state, saves never overlap within a canvas, a lost version
 * race is retried after being reported, and a temporary failure is retried without dropping the edit.
 */

const DEBOUNCE_MS = 400;

function summary(id: string, rev: string): CanvasSummary {
    return { id, title: "canvas", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", rev, bytes: 2 };
}

function snapshotOf(marker: string, rev = "rev-1"): SaveSnapshot {
    const document = emptyCanvasDocument();
    document.showImageInfo = marker !== "";
    return { document, rev, title: marker };
}

/** A queue wired to a fake canvas whose snapshot the test controls. */
function harness(overrides: { save?: (id: string, snapshot: SaveSnapshot, options?: { keepalive?: boolean }) => Promise<CanvasSummary> } = {}) {
    const state = {
        snapshots: new Map<string, SaveSnapshot>(),
        saved: [] as Array<{ id: string; snapshot: SaveSnapshot }>,
        summaries: [] as CanvasSummary[],
        conflicts: [] as Array<{ id: string; current: CanvasSummary }>,
        errors: [] as Array<{ id: string; error: unknown }>,
        missing: [] as string[],
        /** Which saves asked to survive the page going away. */
        keepalive: [] as string[],
    };
    const queue = createSaveQueue({
        snapshot: (id) => state.snapshots.get(id) ?? null,
        save:
            overrides.save ??
            (async (id, snapshot, options) => {
                state.saved.push({ id, snapshot });
                if (options?.keepalive) state.keepalive.push(id);
                return summary(id, `rev-${state.saved.length + 1}`);
            }),
        onSaved: (_id, summaryValue) => state.summaries.push(summaryValue),
        onConflict: (id, current) => state.conflicts.push({ id, current }),
        onMissing: (id) => state.missing.push(id),
        onError: (id, error) => state.errors.push({ id, error }),
        debounceMs: DEBOUNCE_MS,
        retryDelaysMs: [1000, 2000],
    });
    return { queue, state };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("coalescing", () => {
    test("a burst of edits is one save", async () => {
        const { queue, state } = harness();
        state.snapshots.set("c1", snapshotOf("first"));

        queue.schedule("c1");
        queue.schedule("c1");
        queue.schedule("c1");
        expect(state.saved).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        expect(state.saved).toHaveLength(1);
        expect(state.saved[0].snapshot.title).toBe("first");
    });

    test("the save carries the state at flush time, not the state that queued it", async () => {
        const { queue, state } = harness();
        state.snapshots.set("c1", snapshotOf("stale"));

        queue.schedule("c1");
        // The user drags another node while the debounce is still counting down.
        state.snapshots.set("c1", snapshotOf("fresh"));
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

        expect(state.saved).toHaveLength(1);
        expect(state.saved[0].snapshot.title).toBe("fresh");
    });

    test("a save reports the new summary and clears the dirty flag", async () => {
        const { queue, state } = harness();
        state.snapshots.set("c1", snapshotOf("x"));

        queue.schedule("c1");
        expect(queue.isDirty("c1")).toBe(true);
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

        expect(queue.isDirty("c1")).toBe(false);
        expect(state.summaries).toHaveLength(1);
    });
});

describe("ordering", () => {
    test("an edit during a save runs a second save afterwards, not a concurrent one", async () => {
        let release: (() => void) | null = null;
        const inFlight: string[] = [];
        const { queue, state } = harness({
            save: async (id, snapshot) => {
                inFlight.push(snapshot.title || "");
                if (inFlight.length === 1) await new Promise<void>((resolve) => (release = resolve));
                state.saved.push({ id, snapshot });
                return summary(id, `rev-${inFlight.length + 1}`);
            },
        });
        state.snapshots.set("c1", snapshotOf("one"));

        queue.schedule("c1");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        expect(inFlight).toHaveLength(1);

        // A change arrives while the first save is still in flight.
        state.snapshots.set("c1", snapshotOf("two"));
        queue.schedule("c1");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        expect(inFlight).toHaveLength(1);

        release!();
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        expect(inFlight).toEqual(["one", "two"]);
        expect(state.saved.map((item) => item.snapshot.title)).toEqual(["one", "two"]);
    });

    test("two canvases save independently", async () => {
        const { queue, state } = harness();
        state.snapshots.set("c1", snapshotOf("a"));
        state.snapshots.set("c2", snapshotOf("b"));

        queue.schedule("c1");
        queue.schedule("c2");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

        expect(state.saved.map((item) => item.id).sort()).toEqual(["c1", "c2"]);
    });
});

describe("a lost version race", () => {
    test("stops instead of retrying over the other copy", async () => {
        const current = summary("c1", "rev-server");
        let attempt = 0;
        const { queue, state } = harness({
            save: async (id, snapshot) => {
                attempt += 1;
                state.saved.push({ id, snapshot });
                throw new CanvasConflictError(current);
            },
        });
        state.snapshots.set("c1", snapshotOf("mine", "rev-stale"));

        queue.schedule("c1");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        // Nothing else may happen on its own: the other copy is somebody's work, not a stale read.
        await vi.advanceTimersByTimeAsync(60_000);

        expect(attempt).toBe(1);
        expect(state.conflicts).toEqual([{ id: "c1", current }]);
        expect(state.errors).toHaveLength(0);
        expect(state.saved).toHaveLength(1);
        expect(queue.isDirty("c1")).toBe(false);
    });

    test("a later edit does not silently start overwriting again", async () => {
        let attempt = 0;
        const { queue, state } = harness({
            save: async () => {
                attempt += 1;
                throw new CanvasConflictError(summary("c1", "rev-server"));
            },
        });
        state.snapshots.set("c1", snapshotOf("mine"));

        queue.schedule("c1");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        state.snapshots.set("c1", snapshotOf("more edits"));
        queue.schedule("c1");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

        // The user has to answer the question first; until then every attempt is refused, not merged.
        expect(attempt).toBe(2);
        expect(state.conflicts).toHaveLength(2);
        expect(state.summaries).toHaveLength(0);
    });
});

describe("a temporary failure", () => {
    test("is retried on the configured schedule and keeps the canvas dirty meanwhile", async () => {
        let attempt = 0;
        const { queue, state } = harness({
            save: async (id) => {
                attempt += 1;
                if (attempt === 1) throw new TypeError("network down");
                return summary(id, "rev-2");
            },
        });
        state.snapshots.set("c1", snapshotOf("content"));

        queue.schedule("c1");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        expect(state.errors).toHaveLength(1);
        expect(queue.isDirty("c1")).toBe(true);

        // The first retry delay, not the debounce, is what brings the save back.
        await vi.advanceTimersByTimeAsync(1000);
        expect(attempt).toBe(2);
        expect(state.summaries.at(-1)?.rev).toBe("rev-2");
    });

    test("stops once the retry schedule runs out, and a new edit starts it again", async () => {
        let attempt = 0;
        const { queue, state } = harness({
            save: async () => {
                attempt += 1;
                throw new TypeError("network down");
            },
        });
        state.snapshots.set("c1", snapshotOf("content"));

        queue.schedule("c1");
        // The initial save plus both configured retries, then nothing: a gateway that is refusing this
        // document will refuse it again, and a loop every debounce would only fill the console.
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1000 + 2000 + 60_000);

        expect(attempt).toBe(3);
        expect(state.errors).toHaveLength(3);
        expect(queue.isDirty("c1")).toBe(true);

        // The next edit is a new reason to try.
        queue.schedule("c1");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        expect(attempt).toBe(4);
    });

    test("a new edit during the retry wait saves sooner than the wait would", async () => {
        let attempt = 0;
        const { queue, state } = harness({
            save: async (id, snapshot) => {
                attempt += 1;
                state.saved.push({ id, snapshot });
                if (attempt === 1) throw new TypeError("network down");
                return summary(id, "rev-2");
            },
        });
        state.snapshots.set("c1", snapshotOf("first"));

        queue.schedule("c1");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        state.snapshots.set("c1", snapshotOf("second"));
        queue.schedule("c1");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

        expect(state.saved.map((item) => item.snapshot.title)).toEqual(["first", "second"]);
    });
});

describe("a canvas that was deleted under us", () => {
    test("is reported once and is not retried", async () => {
        let attempt = 0;
        const { queue, state } = harness({
            save: async () => {
                attempt += 1;
                throw new CanvasMissingError();
            },
        });
        state.snapshots.set("c1", snapshotOf("orphan"));

        queue.schedule("c1");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        await vi.advanceTimersByTimeAsync(10000);

        expect(attempt).toBe(1);
        expect(state.missing).toEqual(["c1"]);
        expect(state.errors).toHaveLength(0);
        expect(queue.isDirty("c1")).toBe(false);
    });
});

describe("the edges", () => {
    test("a canvas that is gone is not saved and is no longer dirty", async () => {
        const { queue, state } = harness();
        queue.schedule("c1");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

        expect(state.saved).toHaveLength(0);
        expect(queue.isDirty("c1")).toBe(false);
    });

    test("flushAll saves everything pending, and flush saves one now", async () => {
        const { queue, state } = harness();
        state.snapshots.set("c1", snapshotOf("a"));
        state.snapshots.set("c2", snapshotOf("b"));

        queue.schedule("c1");
        queue.schedule("c2");
        await queue.flush("c1");
        expect(state.saved.map((item) => item.id)).toEqual(["c1"]);

        await queue.flushAll();
        expect(state.saved.map((item) => item.id)).toEqual(["c1", "c2"]);
    });

    test("flushAll asks for a save the browser will keep across the navigation", async () => {
        const { queue, state } = harness();
        state.snapshots.set("c1", snapshotOf("a"));

        queue.schedule("c1");
        await queue.flushAll();

        expect(state.saved.map((item) => item.id)).toEqual(["c1"]);
        // The debounced save is an ordinary one; only the pagehide flush has to survive the unload (#177).
        expect(state.keepalive).toEqual(["c1"]);
    });

    test("a debounced save does not ask for keepalive", async () => {
        const { queue, state } = harness();
        state.snapshots.set("c1", snapshotOf("a"));

        queue.schedule("c1");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

        expect(state.saved).toHaveLength(1);
        expect(state.keepalive).toEqual([]);
    });

    test("forget drops the pending save", async () => {
        const { queue, state } = harness();
        state.snapshots.set("c1", snapshotOf("a"));

        queue.schedule("c1");
        queue.forget("c1");
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

        expect(state.saved).toHaveLength(0);
    });
});
