import { describe, expect, it, vi } from "vitest";

/**
 * Which nodes pick their run back up when the canvas is opened.
 *
 * A run belongs to the gateway, so a node waiting on one must not be marked "interrupted" by the restore
 * pass — that is what the resume effect depends on. One rule for every kind of content, and the same rule
 * whatever the node's status says: a watch that could not ask leaves an error behind *and* keeps the id,
 * and a reload is how that node gets picked up again (#235).
 */
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

const { adoptLegacyRunIds, failedWatch, hasResumableRun, resetInterruptedGeneration } = await import("@/lib/canvas/canvas-generation-helpers");
const { RunFailedError } = await import("@/services/api/runs");

type Node = Parameters<typeof hasResumableRun>[0];
const node = (overrides: Record<string, unknown>): Node =>
    ({
        id: "n1",
        type: "audio",
        title: "n1",
        position: { x: 0, y: 0 },
        width: 100,
        height: 100,
        metadata: { status: "loading" },
        ...overrides,
    }) as unknown as Node;

describe("hasResumableRun", () => {
    it("is true for every kind of content with a run id and nothing to show yet", () => {
        for (const type of ["image", "video", "audio"]) {
            expect(hasResumableRun(node({ type, metadata: { status: "loading", runId: "run_1" } }))).toBe(true);
        }
    });

    it("is true whatever the status says: a node in error may still have a live run", () => {
        expect(hasResumableRun(node({ metadata: { status: "error", runId: "run_1" } }))).toBe(true);
    });

    it("is false once the content exists, and for a node with no run", () => {
        expect(hasResumableRun(node({ metadata: { status: "loading", runId: "run_1", content: "blob:1" } }))).toBe(false);
        expect(hasResumableRun(node({ metadata: { status: "loading" } }))).toBe(false);
        expect(hasResumableRun(node({ type: "text", metadata: { status: "loading", runId: "run_1" } }))).toBe(false);
    });
});

describe("resetInterruptedGeneration", () => {
    it("keeps a node whose run can be resumed", () => {
        const input = [node({ metadata: { status: "loading", runId: "run_1" } })];
        expect(resetInterruptedGeneration(input)[0].metadata?.status).toBe("loading");
    });

    it("marks a loading node with no run as interrupted, and says why", () => {
        const [restored] = resetInterruptedGeneration([node({ metadata: { status: "loading" } })]);
        expect(restored.metadata?.status).toBe("error");
        expect(restored.metadata?.errorDetails).toBe("canvas.generation.interrupted");
    });

    it("leaves nodes that were not loading alone, including the errors already on the canvas", () => {
        expect(resetInterruptedGeneration([node({ metadata: { status: "success" } })])[0].metadata?.status).toBe("success");
        // A failure that was on the canvas before the page closed is what happened; opening the canvas is
        // not the place to quietly clear it.
        expect(resetInterruptedGeneration([node({ metadata: { status: "error", errorDetails: "CUDA out of memory", runId: "run_1" } })])[0].metadata?.errorDetails).toBe("CUDA out of memory");
    });
});

describe("adoptLegacyRunIds", () => {
    it("reads the three old names into the one field, and drops them", () => {
        const cases: Array<[string, string]> = [
            ["video", "videoTaskId"],
            ["audio", "audioRunId"],
            ["image", "imageRunId"],
        ];
        for (const [type, legacy] of cases) {
            const [adopted] = adoptLegacyRunIds([node({ type, metadata: { status: "loading", [legacy]: "task_9" } })]);
            expect(adopted.metadata).toMatchObject({ runId: "task_9" });
            expect(adopted.metadata).not.toHaveProperty(legacy);
        }
    });

    it("keeps a run id the canvas already has, and leaves a node without one alone", () => {
        const [kept] = adoptLegacyRunIds([node({ metadata: { runId: "run_now", videoTaskId: "task_old" } })]);
        expect(kept.metadata).toMatchObject({ runId: "run_now" });
        expect(adoptLegacyRunIds([node({ metadata: { status: "idle" } })])[0].metadata).toEqual({ status: "idle" });
    });
});

describe("failedWatch", () => {
    const run = { id: "run_1", workflow: "w", status: "failed", error: { message: "ComfyUI ran out of memory" } } as never;

    it("keeps the run id when the question did not get there, and says the run may still be out", () => {
        const { ended, errorDetails } = failedWatch(new TypeError("Failed to fetch"), "fallback");
        expect(ended).toBe(false);
        // The message points at the remedy rather than at the error alone.
        expect(errorDetails).toBe("canvas.runtime.runUnwatched");
    });

    it("lets the id go when the gateway says the run itself failed, and shows its reason", () => {
        const { ended, errorDetails } = failedWatch(new RunFailedError(run), "fallback");
        expect(ended).toBe(true);
        expect(errorDetails).toBe("ComfyUI ran out of memory");
    });
});
