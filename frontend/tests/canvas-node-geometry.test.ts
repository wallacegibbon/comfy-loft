import { describe, expect, test } from "vitest";

import { applyGroupSelection, applyUngroupSelection, withGroupMembers } from "../src/lib/canvas/canvas-node-geometry";
import type { CanvasNodeData } from "../src/types/canvas";

/**
 * Grouping and ungrouping, as the two pure functions behind both the toolbar and the agent's tools.
 *
 * The one rule these pin down is what happens to a group's *shell*. A press that takes every member of one
 * group into another leaves the first holding nothing, and that card is debris the press itself made. A card
 * that was already empty before the press is not: it is something the person made — a box waiting to be
 * filled — and deleting it because something unrelated was grouped elsewhere was never the intent (#292).
 */

const node = (id: string, type: CanvasNodeData["type"], groupId?: string): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 240, metadata: groupId ? { groupId } : {} });

const ids = (result: { nodes: CanvasNodeData[] } | null) => result?.nodes.map((each) => each.id);
const groupOf = (result: { nodes: CanvasNodeData[] } | null, nodeId: string) => result?.nodes.find((each) => each.id === nodeId)?.metadata?.groupId;

describe("grouping", () => {
    test("wraps the members in one card, and points every member at it", () => {
        const result = applyGroupSelection(new Set(["a", "b"]), [node("a", "text"), node("b", "text")], [], node("g", "group"));
        expect(ids(result)).toEqual(["g", "a", "b"]);
        expect(groupOf(result, "a")).toBe("g");
        expect(groupOf(result, "b")).toBe("g");
    });

    test("leaves an empty group alone: it was not this press that emptied it", () => {
        // The box somebody made and has not filled yet. Grouping two unrelated nodes used to delete it.
        const result = applyGroupSelection(new Set(["a", "b"]), [node("empty", "group"), node("a", "text"), node("b", "text")], [], node("g", "group"));
        expect(ids(result)).toEqual(["empty", "g", "a", "b"]);
    });

    test("removes a group this press emptied, because the shell is its own debris", () => {
        // Both of g1's members are taken into the new card and g1 itself was not selected: nothing is left in
        // it, and the person did not make it that way.
        const result = applyGroupSelection(new Set(["m1", "m2"]), [node("g1", "group"), node("m1", "text", "g1"), node("m2", "text", "g1")], [], node("g2", "group"));
        expect(ids(result)).toEqual(["g2", "m1", "m2"]);
        expect(groupOf(result, "m1")).toBe("g2");
    });

    test("takes a group named in the selection with it, and absorbs its members", () => {
        // Merging: g1 is selected, so it is flattened into the new card rather than left as a shell.
        const result = applyGroupSelection(new Set(["g1", "c"]), [node("g1", "group"), node("m1", "text", "g1"), node("c", "text")], [], node("g2", "group"));
        expect(ids(result)).toEqual(["g2", "m1", "c"]);
        expect(groupOf(result, "m1")).toBe("g2");
    });
});

describe("ungrouping", () => {
    test("dissolves the group and lets its members out where they stand", () => {
        const result = applyUngroupSelection(new Set(["g1"]), [node("g1", "group"), node("m1", "text", "g1"), node("m2", "text", "g1")], []);
        expect(ids(result)).toEqual(["m1", "m2"]);
        expect(groupOf(result, "m1")).toBeUndefined();
        expect(groupOf(result, "m2")).toBeUndefined();
    });

    test("taking one member out leaves the card standing for the others", () => {
        const result = applyUngroupSelection(new Set(["m1"]), [node("g1", "group"), node("m1", "text", "g1"), node("m2", "text", "g1")], []);
        expect(ids(result)).toEqual(["g1", "m1", "m2"]);
        expect(groupOf(result, "m1")).toBeUndefined();
        expect(groupOf(result, "m2")).toBe("g1");
    });

    test("taking the last member out removes the card it emptied", () => {
        const result = applyUngroupSelection(new Set(["m1"]), [node("g1", "group"), node("m1", "text", "g1")], []);
        expect(ids(result)).toEqual(["m1"]);
    });

    test("leaves an empty group that was already empty", () => {
        const result = applyUngroupSelection(new Set(["m1"]), [node("empty", "group"), node("g1", "group"), node("m1", "text", "g1")], []);
        expect(ids(result)).toEqual(["empty", "m1"]);
    });

    test("says nothing when there is nothing to release", () => {
        expect(applyUngroupSelection(new Set(["a"]), [node("a", "text")], [])).toBeNull();
    });
});

/**
 * What a move carries.
 *
 * A group is a box drawn around nodes; moving the box alone leaves its members standing where they were, and
 * the card is then drawn around nothing. The drag and the agent's `move_node` both ask this one function, so
 * the gesture and the tool cannot disagree about what "move this group" means (docs/decisions.md #308).
 */
describe("the cards a move carries", () => {
    const canvas = [node("g1", "group"), node("m1", "text", "g1"), node("m2", "image", "g1"), node("loose", "text")];

    test("a group brings its members, and nothing else", () => {
        expect([...withGroupMembers(new Set(["g1"]), canvas)].sort()).toEqual(["g1", "m1", "m2"]);
    });

    test("a plain node brings only itself", () => {
        expect([...withGroupMembers(new Set(["loose"]), canvas)]).toEqual(["loose"]);
    });

    test("a selection that holds both also names each once", () => {
        expect([...withGroupMembers(new Set(["g1", "m1"]), canvas)].sort()).toEqual(["g1", "m1", "m2"]);
    });

    test("a member named on its own does not drag the group's other members", () => {
        // Taking one card out of a group is a move of that card: the box stays where it is, for the others.
        expect([...withGroupMembers(new Set(["m1"]), canvas)]).toEqual(["m1"]);
    });
});
