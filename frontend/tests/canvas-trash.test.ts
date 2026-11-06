import { describe, expect, it } from "vitest";

import { restoreFromTrash, TRASH_LIMIT, trashedEntries, withTrashed } from "../src/lib/canvas/canvas-trash";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasTrashEntry } from "../src/types/canvas";

/**
 * The trash: what a delete keeps, and what a restore is allowed to put back.
 *
 * The two facts this file exists for are that a deleted node's *file* is named by the document (so the
 * server's collector leaves it alone, #327) and that a restore never invents a relation the canvas cannot
 * draw: a wire to a node that is gone, a second edge between one pair, a member of a group that is gone.
 */

function image(id: string, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { storageKey: `files/${id}.png`, ...metadata } };
}

function group(id: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Group, position: { x: 0, y: 0 }, width: 480, height: 360 };
}

function edge(fromNodeId: string, toNodeId: string): CanvasConnection {
    return { id: `${fromNodeId}->${toNodeId}`, fromNodeId, toNodeId };
}

const NOW = "2026-01-02T03:04:05.000Z";

describe("what a delete keeps", () => {
    it("keeps each deleted node with the wires that touched it", () => {
        const a = image("a");
        const b = image("b");
        const c = image("c");
        const connections = [edge("a", "b"), edge("b", "c")];

        const entries = trashedEntries([a, b, c], connections, new Set(["b"]), NOW);

        expect(entries).toHaveLength(1);
        expect(entries[0].node).toBe(b);
        expect(entries[0].deletedAt).toBe(NOW);
        // Both directions, because both are what made the node part of the canvas.
        expect(entries[0].connections).toEqual([edge("a", "b"), edge("b", "c")]);
    });

    it("keeps the node as it was, group and all, so a restore can put it back into a group that stayed", () => {
        const member = image("a", { groupId: "g1" });
        const [entry] = trashedEntries([member, group("g1")], [], new Set(["a"]), NOW);
        expect(entry.node.metadata?.groupId).toBe("g1");
    });

    it("does not keep a group: deleting one destroys nothing, so there is nothing to give back", () => {
        const box = group("g1");
        expect(trashedEntries([box, image("a", { groupId: "g1" })], [], new Set(["g1", "a"]), NOW).map((entry) => entry.node.id)).toEqual(["a"]);
    });

    it("keeps several deleted nodes in canvas order and forgets the oldest past the limit", () => {
        const many = Array.from({ length: TRASH_LIMIT + 5 }, (_, index) => image(`n${index}`));
        const fresh = trashedEntries(many, [], new Set(many.map((node) => node.id)), NOW);
        const trash = withTrashed([], fresh);

        expect(trash).toHaveLength(TRASH_LIMIT);
        // Newest first: the entries of this delete lead, in the order the canvas listed them.
        expect(trash[0].node.id).toBe("n0");
        expect(trash[TRASH_LIMIT - 1].node.id).toBe(`n${TRASH_LIMIT - 1}`);
        // And a later delete goes on top of what is already there.
        expect(withTrashed(trash, trashedEntries([image("latest")], [], new Set(["latest"]), NOW))[0].node.id).toBe("latest");
    });
});

describe("what a restore puts back", () => {
    const trashed = (node: CanvasNodeData, connections: CanvasConnection[] = []): CanvasTrashEntry => ({ deletedAt: NOW, node, connections });

    it("brings the node and its wires back, and takes it out of the trash", () => {
        const a = image("a");
        const b = image("b");
        const outcome = restoreFromTrash([trashed(b, [edge("a", "b")])], [a], [edge("a", "b")], ["b"]);

        expect(outcome.restored).toEqual(["b"]);
        expect(outcome.missing).toEqual([]);
        expect(outcome.nodes.map((node) => node.id)).toEqual(["a", "b"]);
        expect(outcome.connections).toEqual([edge("a", "b")]);
        expect(outcome.trash).toEqual([]);
    });

    it("does not add a wire that is already there", () => {
        const a = image("a");
        const b = image("b");
        // The pair was deleted and restored once already, or reconnected by hand since.
        const outcome = restoreFromTrash([trashed(b, [edge("a", "b")])], [a, b], [edge("a", "b")], ["b"]);
        expect(outcome.connections).toEqual([edge("a", "b")]);
    });

    it("drops a wire whose other end is gone, because a connection to nothing is not a connection", () => {
        const b = image("b");
        const outcome = restoreFromTrash([trashed(b, [edge("a", "b"), edge("b", "c")])], [], [], ["b"]);
        expect(outcome.connections).toEqual([]);
        expect(outcome.nodes.map((node) => node.id)).toEqual(["b"]);
    });

    it("wires two nodes restored together, once", () => {
        const a = image("a");
        const b = image("b");
        const trash = [trashed(a, [edge("a", "b")]), trashed(b, [edge("a", "b")])];
        const outcome = restoreFromTrash(trash, [], [], ["a", "b"]);
        expect(outcome.connections).toEqual([edge("a", "b")]);
    });

    it("keeps a membership whose group is still here and clears the one whose group is gone", () => {
        const member = image("a", { groupId: "g1" });
        const kept = restoreFromTrash([trashed(member)], [group("g1")], [], ["a"]);
        expect(kept.nodes.find((node) => node.id === "a")?.metadata?.groupId).toBe("g1");

        const cleared = restoreFromTrash([trashed(member)], [], [], ["a"]);
        expect(cleared.nodes.find((node) => node.id === "a")?.metadata?.groupId).toBeUndefined();
        // The rest of its metadata is not touched: a restore is not a reset.
        expect(cleared.nodes.find((node) => node.id === "a")?.metadata?.storageKey).toBe("files/a.png");
    });

    it("says which ids it could not find instead of quietly putting back less", () => {
        const outcome = restoreFromTrash([], [], [], ["gone"]);
        expect(outcome.restored).toEqual([]);
        expect(outcome.missing).toEqual(["gone"]);
    });
});
