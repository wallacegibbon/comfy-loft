import { describe, expect, test } from "vitest";

import { applyGroupSelection, applyUngroupSelection, canUngroupSelectedNodes, movingIntoGroupIds, settleMoveMembership, withGroupMembers, withoutEmptiedGroups } from "../src/lib/canvas/canvas-node-geometry";
import type { CanvasNodeData } from "../src/types/canvas";

/**
 * Grouping and ungrouping, as the two pure functions behind both the toolbar and the agent's tools.
 *
 * The one rule these pin down is what happens to a group's *shell*. A press that takes every member of one
 * group into another leaves the first holding nothing, and that card is debris the press itself made. A card
 * that was already empty before the press is not: it is something the person made — a box waiting to be
 * filled — and deleting it because something unrelated was grouped elsewhere was never the intent (#292).
 */

const node = (id: string, type: CanvasNodeData["type"], groupId?: string): CanvasNodeData => ({ id, type, position: { x: 0, y: 0 }, width: 320, height: 240, metadata: groupId ? { groupId } : {} });

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

    test("a member on its own is not a group to dissolve: nothing happens", () => {
        // Standing inside the box *is* membership — the next move of that card puts it back
        // (`findContainingGroupId`), so "out of the group but still in the box" is a state the drawing cannot
        // show (#335). Taking a card out means taking it out.
        const canvas = [node("g1", "group"), node("m1", "text", "g1"), node("m2", "text", "g1")];
        expect(applyUngroupSelection(new Set(["m1"]), canvas, [])).toBeNull();
        expect(applyUngroupSelection(new Set(["m1", "m2"]), canvas, [])).toBeNull();
    });

    test("only a group among the selection can be ungrouped", () => {
        const canvas = [node("g1", "group"), node("m1", "text", "g1"), node("m2", "text", "g1"), node("loose", "text")];
        expect(canUngroupSelectedNodes(new Set(["g1"]), canvas)).toBe(true);
        expect(canUngroupSelectedNodes(new Set(["m1"]), canvas)).toBe(false);
        expect(canUngroupSelectedNodes(new Set(["m1", "m2"]), canvas)).toBe(false);
        expect(canUngroupSelectedNodes(new Set(["loose"]), canvas)).toBe(false);
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

/**
 * Who belongs to what after a move.
 *
 * The gesture says what moves; it does not say who belongs to whom. A card carried by its own group keeps
 * that group wherever it lands, and only a node that moved on its own is placed by the rectangle it ended up
 * in. Without this, moving a group whose card overlaps its neighbour's handed the group's members to the
 * neighbour: on a real canvas (#316) one `move_node` took two images out of the Qwen group and put them in the
 * Z-Image group, which had been six cards apart in the person's mind, and left an empty box behind.
 */
describe("who belongs to what after a move", () => {
    const card = (id: string, type: CanvasNodeData["type"], x: number, y: number, groupId?: string, size = 100): CanvasNodeData => ({
        id,
        type,
        position: { x, y },
        width: size,
        height: size,
        metadata: groupId ? { groupId } : {},
    });
    const groupOf = (nodes: CanvasNodeData[], nodeId: string) => nodes.find((node) => node.id === nodeId)?.metadata?.groupId;

    // Two 300×300 cards stacked with a gap between them; m1 sits in g1 and m2 in g2, 100×100 each.
    const canvas = () => [card("g1", "group", 0, 0, undefined, 300), card("m1", "text", 100, 100, "g1"), card("g2", "group", 0, 400, undefined, 300), card("m2", "text", 100, 450, "g2")];

    test("a group moved over another card keeps its own members", () => {
        // g1 travels down 400 into g2's place, so m1's centre (150, 540) is inside *both* rectangles — the
        // overlap a canvas has whenever two cards are near each other. g2 is later in the list, so reading
        // geometry alone names g2; the move must not.
        const moved = [card("g1", "group", 0, 400, undefined, 300), card("m1", "text", 100, 500, "g1"), card("g2", "group", 0, 400, undefined, 300), card("m2", "text", 100, 450, "g2")];
        const after = settleMoveMembership(moved, new Set(["g1", "m1"]));
        expect(groupOf(after, "m1")).toBe("g1");
        // and the card it passed over keeps its own member
        expect(groupOf(after, "m2")).toBe("g2");
    });

    test("a member that sits outside its card keeps it too", () => {
        // Membership is not geometry (#290): a member drawn outside the box still travels with it.
        const moved = [card("g1", "group", 0, 50, undefined, 300), card("m1", "text", 600, 650, "g1")];
        const after = settleMoveMembership(moved, new Set(["g1", "m1"]));
        expect(groupOf(after, "m1")).toBe("g1");
    });

    test("a loose node dropped on a card joins it", () => {
        const moved = [card("g2", "group", 0, 400, undefined, 300), card("loose", "text", 100, 450)];
        const after = settleMoveMembership(moved, new Set(["loose"]));
        expect(groupOf(after, "loose")).toBe("g2");
    });

    test("a member moved on its own out of its card leaves it", () => {
        // y=340: below g1's rectangle (0–300) and above g2's (400–700), so it landed on bare canvas.
        const moved = canvas().map((node) => (node.id === "m1" ? card("m1", "text", 100, 340, "g1") : node));
        const after = settleMoveMembership(moved, new Set(["m1"]));
        expect(groupOf(after, "m1")).toBeUndefined();
    });

    test("one drag, two cards: each of them lands where its own card is", () => {
        // The rule is per node, so a gesture is not one answer. Two loose cards dragged at once, one over g1 and
        // one over g2, join the two different groups they landed in — which is what two separate drags would do,
        // and what move_node does one card at a time. Before #339 the drag had a second rule for this: every
        // moving card joined the last group *any* of them touched, and both cards were snapped into its box.
        const moved = [card("g1", "group", 0, 0, undefined, 300), card("g2", "group", 0, 400, undefined, 300), card("a", "text", 100, 100), card("b", "text", 100, 450)];
        const after = settleMoveMembership(moved, new Set(["a", "b"]));
        expect(groupOf(after, "a")).toBe("g1");
        expect(groupOf(after, "b")).toBe("g2");
    });

    test("the highlight names the same groups the drop will use", () => {
        // Drawn from the same function, so it cannot promise something the drop does not do.
        const moved = [card("g1", "group", 0, 0, undefined, 300), card("g2", "group", 0, 400, undefined, 300), card("a", "text", 100, 100), card("b", "text", 100, 450)];
        expect([...movingIntoGroupIds(moved, new Set(["a", "b"]))].sort()).toEqual(["g1", "g2"]);
        // A card over bare canvas joins nothing, so nothing lights up.
        const loose = [card("g1", "group", 0, 0, undefined, 300), card("a", "text", 100, 340)];
        expect([...movingIntoGroupIds(loose, new Set(["a"]))]).toEqual([]);
    });

    test("a member moved on its own into another card joins that one", () => {
        const moved = canvas().map((node) => (node.id === "m1" ? card("m1", "text", 100, 450, "g1") : node));
        const after = settleMoveMembership(moved, new Set(["m1"]));
        expect(groupOf(after, "m1")).toBe("g2");
    });
});

/**
 * The card a move leaves with nothing in it, which is discarded — #292's rule for the third gesture that can
 * empty a group.
 *
 * Grouping and ungrouping already remove the shell they empty. A move that takes a card's last member away
 * leaves the same debris, and a box drawn around nothing is exactly what a person would delete by hand. What
 * is never touched is a card that was already empty before the move: that is a box made to be filled later,
 * and keeping it is the whole point of #292.
 */
describe("the cards a move emptied", () => {
    const box = (id: string): CanvasNodeData => ({ id, type: "group", position: { x: 0, y: 0 }, width: 300, height: 300, metadata: {} });
    const held = (id: string, groupId: string): CanvasNodeData => ({ id, type: "text", position: { x: 100, y: 100 }, width: 100, height: 100, metadata: { groupId } });

    test("a card whose last member was moved out is taken away", () => {
        const before = [box("g1"), held("m1", "g1")];
        const settled = [box("g1"), { ...held("m1", "g1"), metadata: {}, position: { x: 100, y: 900 } }];
        const result = withoutEmptiedGroups(before, settled, [{ id: "c1", fromNodeId: "g1", toNodeId: "m1" }]);
        expect(result.nodes.map((node) => node.id)).toEqual(["m1"]);
        expect(result.removed).toEqual(["g1"]);
        // A card that is gone is not a wire's other end any more.
        expect(result.connections).toEqual([]);
    });

    test("a card that still holds a member stays", () => {
        const before = [box("g1"), held("m1", "g1"), held("m2", "g1")];
        const settled = [box("g1"), { ...held("m1", "g1"), position: { x: 100, y: 900 } }, held("m2", "g1")];
        const result = withoutEmptiedGroups(before, settled, []);
        expect(result.nodes.map((node) => node.id)).toEqual(["g1", "m1", "m2"]);
        expect(result.removed).toEqual([]);
    });

    test("a box that was already empty is nobody's debris", () => {
        // Somebody made it to be filled later; a move elsewhere on the canvas must not delete it.
        const before = [box("empty"), box("g1"), held("m1", "g1")];
        const settled = [box("empty"), box("g1"), { ...held("m1", "g1"), metadata: {}, position: { x: 100, y: 900 } }];
        const result = withoutEmptiedGroups(before, settled, []);
        expect(result.nodes.map((node) => node.id)).toEqual(["empty", "m1"]);
        expect(result.removed).toEqual(["g1"]);
    });
});
