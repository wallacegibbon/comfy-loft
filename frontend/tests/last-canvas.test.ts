import { describe, expect, test, vi } from "vitest";

// The module reads and writes one preference; these tests only care about the ordering rule, so the store
// is a stub.
vi.mock("@/stores/use-settings-store", () => ({
    readSetting: () => "",
    writeSetting: () => undefined,
}));

const { byCreatedAtDesc, newestCanvasId } = await import("../src/lib/canvas/last-canvas");

/**
 * Which canvas a bare visit opens.
 *
 * The interesting case is the one a string comparison gets wrong: the server writes timestamps with Go's
 * RFC3339Nano, which drops trailing zeros, so `…34.9Z` and `…34.916503133Z` are the same second and compare
 * the wrong way round as text (`Z` > `1` — the one written *first* would win).
 */
describe("the canvas to open", () => {
    test("nothing to open", () => {
        expect(newestCanvasId([])).toBe("");
    });

    test("one canvas is the newest", () => {
        expect(newestCanvasId([{ id: "a", updatedAt: "2026-11-02T11:00:00.000Z" }])).toBe("a");
    });

    test("the later second wins", () => {
        const canvases = [
            { id: "older", updatedAt: "2026-11-02T11:00:00.000Z" },
            { id: "newer", updatedAt: "2026-11-02T11:00:01.000Z" },
        ];
        expect(newestCanvasId(canvases)).toBe("newer");
    });

    test("within one second the fractional part is compared as a number, not as text", () => {
        const canvases = [
            { id: "earlier", updatedAt: "2026-11-02T11:00:00.900Z" },
            { id: "later", updatedAt: "2026-11-02T11:00:00.916503133Z" },
        ];
        // As strings `…34.9Z` sorts after `…34.916…Z`; as instants it is 90 ms before it.
        expect(newestCanvasId(canvases)).toBe("later");
    });

    test("a timestamp nothing can parse does not beat a real one", () => {
        const canvases = [
            { id: "broken", updatedAt: "not a date" },
            { id: "real", updatedAt: "2026-11-02T11:00:00.000Z" },
        ];
        expect(newestCanvasId(canvases)).toBe("real");
    });

    test("all of them unreadable keeps the server's order, newest first", () => {
        const canvases = [
            { id: "first", updatedAt: "?" },
            { id: "second", updatedAt: "?" },
        ];
        expect(newestCanvasId(canvases)).toBe("first");
    });
});

/**
 * The order the list in the left column draws in (#198).
 *
 * It is the order the canvases were *made* in, so it does not move while you work: a canvas is saved on
 * every edit, and sorting by `updatedAt` put the canvas you were looking at back on top after each save.
 */
describe("the canvas list order", () => {
    test("newest canvas first", () => {
        const canvases = [
            { id: "a", createdAt: "2026-11-02T11:00:00.900Z" },
            { id: "b", createdAt: "2026-11-02T11:00:00.916503133Z" },
            { id: "c", createdAt: "2026-11-02T10:59:59.000Z" },
        ];
        expect(canvases.sort(byCreatedAtDesc).map((canvas) => canvas.id)).toEqual(["b", "a", "c"]);
    });

    test("two canvases made in the same millisecond keep a stable order", () => {
        const first = { id: "aaa", createdAt: "2026-11-02T11:00:00.000Z" };
        const second = { id: "bbb", createdAt: "2026-11-02T11:00:00.000Z" };
        expect([second, first].sort(byCreatedAtDesc).map((canvas) => canvas.id)).toEqual(["aaa", "bbb"]);
        expect([first, second].sort(byCreatedAtDesc).map((canvas) => canvas.id)).toEqual(["aaa", "bbb"]);
    });

    test("the last write does not move a canvas", () => {
        // `updatedAt` is what the store bumps on every save; the comparator must not read it.
        const canvases = [
            { id: "old", createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-02T11:59:00.000Z" },
            { id: "new", createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:00:00.000Z" },
        ];
        expect(canvases.sort(byCreatedAtDesc).map((canvas) => canvas.id)).toEqual(["new", "old"]);
    });
});
