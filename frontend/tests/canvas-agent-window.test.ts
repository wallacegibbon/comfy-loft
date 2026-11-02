import { beforeEach, describe, expect, test } from "vitest";

import { useCanvasAgentStore } from "../src/stores/canvas/use-canvas-agent-store";

/**
 * The agent window is document state, so the store's one job is to keep each canvas's copy apart and
 * to let the document fill an empty slot without overwriting edits the same session has not saved yet.
 */

beforeEach(() => {
    useCanvasAgentStore.setState({ windows: {} });
});

describe("the agent window", () => {
    test("is closed, in the default corner and at its default size until the user says otherwise", () => {
        expect(useCanvasAgentStore.getState().windows["aaaaaaaaaaaa"]).toBeUndefined();
    });

    test("belongs to one canvas: opening one does not open another", () => {
        const store = useCanvasAgentStore.getState();
        store.toggle("aaaaaaaaaaaa");
        store.setSize("aaaaaaaaaaaa", { width: 600, height: 500 });
        store.setPosition("aaaaaaaaaaaa", { x: 12, y: 34 });
        expect(useCanvasAgentStore.getState().windows["aaaaaaaaaaaa"]).toEqual({ open: true, position: { x: 12, y: 34 }, size: { width: 600, height: 500 } });
        expect(useCanvasAgentStore.getState().windows["bbbbbbbbbbbb"]).toBeUndefined();
    });

    test("is restored from the document when the store has nothing for that canvas", () => {
        useCanvasAgentStore.getState().restore("aaaaaaaaaaaa", { open: true, position: { x: 8, y: 9 }, size: { width: 640, height: 520 } });
        expect(useCanvasAgentStore.getState().windows["aaaaaaaaaaaa"]).toEqual({ open: true, position: { x: 8, y: 9 }, size: { width: 640, height: 520 } });
    });

    test("keeps what this session has edited rather than replaying an older document", () => {
        const store = useCanvasAgentStore.getState();
        store.toggle("aaaaaaaaaaaa");
        store.setSize("aaaaaaaaaaaa", { width: 700, height: 600 });
        store.restore("aaaaaaaaaaaa", { open: false, position: null, size: null });
        expect(useCanvasAgentStore.getState().windows["aaaaaaaaaaaa"]).toEqual({ open: true, position: null, size: { width: 700, height: 600 } });
    });

    test("opens closed for a document written before the window was remembered", () => {
        useCanvasAgentStore.getState().restore("aaaaaaaaaaaa", undefined);
        expect(useCanvasAgentStore.getState().windows["aaaaaaaaaaaa"]).toEqual({ open: false, position: null, size: null });
    });
});
