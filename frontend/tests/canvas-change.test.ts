import { describe, expect, it } from "vitest";

import { changeText, describeChange, type CanvasSnapshot } from "../src/lib/canvas/canvas-change";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasTrashEntry } from "../src/types/canvas";

/**
 * What a history step is called.
 *
 * Two questions for one function, both asked by the undo stack: *did anything worth a step happen* (null when
 * the answer is no — a run's progress tick is not an edit) and *what was it* (the menu item's words). The
 * second is what makes "Undo" mean something after an agent has been at the canvas (#328).
 */

const NOW = "2026-01-02T03:04:05.000Z";

function node(id: string, overrides: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 320, height: 240, metadata: {}, ...overrides };
}

function edge(fromNodeId: string, toNodeId: string): CanvasConnection {
    return { id: `${fromNodeId}->${toNodeId}`, fromNodeId, toNodeId };
}

function trashEntry(...ids: string[]): CanvasTrashEntry[] {
    return ids.map((id) => ({ deletedAt: NOW, node: node(id), connections: [] }));
}

const snap = (overrides: Partial<CanvasSnapshot> = {}): CanvasSnapshot => ({ nodes: [], connections: [], trash: [], ...overrides });

describe("what a step changed", () => {
    it("says nothing when nothing changed", () => {
        expect(describeChange(snap({ nodes: [node("a")] }), snap({ nodes: [node("a")] }))).toBeNull();
    });

    it("calls a node that left the canvas a delete, and names it", () => {
        const change = describeChange(snap({ nodes: [node("a"), node("b")] }), snap({ nodes: [node("a")], trash: trashEntry("b") }));
        expect(change).toEqual({ kind: "delete", ids: ["b"] });
    });

    it("calls a node that came back out of the trash a restore, not an addition", () => {
        const change = describeChange(snap({ nodes: [node("a")], trash: trashEntry("b") }), snap({ nodes: [node("a"), node("b")] }));
        expect(change).toEqual({ kind: "restore", ids: ["b"] });
    });

    it("calls a name that was not there an addition", () => {
        expect(describeChange(snap(), snap({ nodes: [node("a")] }))).toEqual({ kind: "create", ids: ["a"] });
    });

    it("tells a move from a resize from an edit", () => {
        const still = node("a");
        expect(describeChange(snap({ nodes: [still] }), snap({ nodes: [{ ...still, position: { x: 40, y: -12 } }] }))).toEqual({ kind: "move", ids: ["a"] });
        expect(describeChange(snap({ nodes: [still] }), snap({ nodes: [{ ...still, width: 480, height: 360 }] }))).toEqual({ kind: "resize", ids: ["a"] });
        expect(describeChange(snap({ nodes: [still] }), snap({ nodes: [{ ...still, metadata: { ...still.metadata, prompt: "new words" } }] }))).toEqual({ kind: "update", ids: ["a"] });
    });

    it("a move that also changed the words is an edit, not a move", () => {
        const still = node("a");
        const moved = { ...still, position: { x: 40, y: -12 }, metadata: { ...still.metadata, prompt: "new words" } };
        expect(describeChange(snap({ nodes: [still] }), snap({ nodes: [moved] }))).toEqual({ kind: "update", ids: ["a"] });
    });

    it("tells a wire made from a wire cut", () => {
        const pair = [node("a"), node("b")];
        expect(describeChange(snap({ nodes: pair }), snap({ nodes: pair, connections: [edge("a", "b")] }))).toEqual({ kind: "connect", pairs: [["a", "b"]] });
        expect(describeChange(snap({ nodes: pair, connections: [edge("a", "b")] }), snap({ nodes: pair }))).toEqual({ kind: "disconnect", pairs: [["a", "b"]] });
    });

    it("says the canvas when only how it is drawn changed", () => {
        expect(describeChange(snap({ backgroundMode: "lines" }), snap({ backgroundMode: "dots" }))).toEqual({ kind: "canvas" });
    });

    it("sees a deletion before an addition, because that is the one worth taking back", () => {
        // An agent turn that made one node and deleted another is one step of the stack (the debounce), and one
        // line in the menu. The deletion is the part a person cannot fix by hand.
        const change = describeChange(snap({ nodes: [node("a")] }), snap({ nodes: [node("c")], trash: trashEntry("a") }));
        expect(change).toEqual({ kind: "delete", ids: ["a"] });
    });
});

describe("a run's reporting is not an edit", () => {
    // The step count is written into the node's metadata on every poll. Comparing it made every poll a history
    // entry: a two-minute render wrote eighty steps and pushed the user's own work out of a fifty-step stack.
    it("a progress tick changes nothing", () => {
        const running = node("a", { metadata: { status: "loading", stepProgress: { step: 3, total: 20 } } });
        const later = node("a", { metadata: { status: "loading", stepProgress: { step: 4, total: 20 } } });
        expect(describeChange(snap({ nodes: [running] }), snap({ nodes: [later] }))).toBeNull();
    });

    it("a run that ended is a step, because the node now holds something else", () => {
        const running = node("a", { metadata: { status: "loading", stepProgress: { step: 20, total: 20 } } });
        const done = node("a", { metadata: { status: "success", content: "files/task_1.png", storageKey: "files/task_1.png" } });
        expect(describeChange(snap({ nodes: [running] }), snap({ nodes: [done] }))).toEqual({ kind: "update", ids: ["a"] });
    });
});

describe("the words", () => {
    // A fake `t` so the test pins the key and the values, which is the whole of the wording's contract.
    const t = (key: string, options?: Record<string, unknown>) =>
        `${key}(${
            options
                ? Object.entries(options)
                      .map(([name, value]) => `${name}=${String(value)}`)
                      .join(",")
                : ""
        })`;

    it("names one node, and counts more than one", () => {
        expect(changeText({ kind: "delete", ids: ["image-1"] }, t)).toBe("canvas.change.delete(what=image-1)");
        expect(changeText({ kind: "delete", ids: ["image-1", "image-2", "image-3"] }, t)).toBe("canvas.change.delete(what=canvas.change.nodes(count=3))");
    });

    it("names both ends of a wire", () => {
        expect(changeText({ kind: "connect", pairs: [["a", "b"]] }, t)).toBe("canvas.change.connect(what=a → b)");
    });

    it("says the canvas has no subject", () => {
        expect(changeText({ kind: "canvas" }, t)).toBe("canvas.change.canvas(what=)");
    });
});
