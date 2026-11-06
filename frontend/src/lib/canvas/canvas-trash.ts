import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasTrashEntry } from "@/types/canvas";

/**
 * The canvas's trash: what a delete keeps, and what a restore puts back.
 *
 * A delete used to be the one gesture on this canvas with no way back. Ctrl+Z undid it while the tab stayed
 * open, but the undo stack is memory, and what a node holds is a file: the server frees a file it finds in no
 * document, measuring the grace from the file's own age, so deleting an old picture had its bytes swept at the
 * next save — the card came back and the picture did not (#327).
 *
 * So a deleted node moves into the document instead of out of it: the node, and the wires that touched it. Two
 * things follow, and both are why this is the shape it is:
 *
 *   - the file survives without the collector learning a new rule. It already answers "what does the document
 *     name" by scanning for `files/<name>` anywhere (#148), and a trashed node is in the document, so its
 *     picture is named. No second store, no second lifetime rule.
 *   - a reload is not a loss. The trash travels with the canvas, so the recovery path does not depend on a
 *     stack that lived in a tab.
 *
 * A group is not trashed. Deleting one releases its members and destroys nothing, so there is nothing to give
 * back — and this canvas never keeps a box with nothing in it (#318).
 */

/** How many deletions one canvas remembers. Older ones are let go, and their files with them. */
export const TRASH_LIMIT = 20;

/**
 * The entries a delete makes: one per node that was holding something, keeping the wires it had.
 *
 * `before` is the canvas as it was, not as it settles: a node dropped out of a group that is also going keeps
 * its `groupId` in here, so a restore can put it back into that group when the group is still there. Nothing a
 * group can be is lost by leaving it out, and a group in the trash would be a box with no members — the debris
 * #318 exists to prevent.
 */
export function trashedEntries(before: CanvasNodeData[], connections: CanvasConnection[], ids: Set<string>, deletedAt: string): CanvasTrashEntry[] {
    const entries: CanvasTrashEntry[] = [];
    for (const node of before) {
        if (!ids.has(node.id) || node.type === CanvasNodeType.Group) continue;
        entries.push({ deletedAt, node, connections: connections.filter((connection) => connection.fromNodeId === node.id || connection.toNodeId === node.id) });
    }
    return entries;
}

/** The trash with these entries on top of it, newest first, forgetting the oldest past the limit. */
export function withTrashed(trash: CanvasTrashEntry[], entries: CanvasTrashEntry[], limit = TRASH_LIMIT): CanvasTrashEntry[] {
    return [...entries, ...trash].slice(0, limit);
}

/** What one restore put back, and what it could not find. */
type RestoreOutcome = {
    trash: CanvasTrashEntry[];
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    restored: string[];
    /** Ids that were not in the trash: already emptied, or never there. */
    missing: string[];
};

/**
 * Take these nodes out of the trash and put them back on the canvas, wires and all.
 *
 * Three things can be wrong with a restore, and each has one answer:
 *
 *   - a wire whose other end is gone (that node was deleted too and not restored) is dropped, because a
 *     connection to nothing is not a connection;
 *   - a wire that is already there is not added twice — restoring two nodes that were wired to each other
 *     would otherwise give the pair two edges;
 *   - a `groupId` whose group is gone is cleared, because membership of a group the canvas does not hold is
 *     not a relation either — it would be a member of nothing, which nothing on the canvas can show.
 *
 * Ids not found are reported rather than ignored: a restore that put back less than it was asked for has to
 * say so, or the caller believes a node is on the canvas when it is not.
 */
export function restoreFromTrash(trash: CanvasTrashEntry[], nodes: CanvasNodeData[], connections: CanvasConnection[], ids: string[]): RestoreOutcome {
    const wanted = new Set(ids);
    const taken = trash.filter((entry) => wanted.has(entry.node.id));
    const restored = taken.map((entry) => entry.node.id);
    const missing = ids.filter((id) => !taken.some((entry) => entry.node.id === id));
    if (!taken.length) return { trash, nodes, connections, restored: [], missing };

    const nextNodes = [...nodes];
    const nextConnections = [...connections];
    for (const entry of taken) {
        // The group it left has to still be here: a member of a group the canvas does not hold is a
        // membership nothing can draw.
        const groupId = entry.node.metadata?.groupId;
        const keepGroup = groupId && nextNodes.some((node) => node.id === groupId);
        nextNodes.push(keepGroup ? entry.node : { ...entry.node, metadata: { ...entry.node.metadata, groupId: undefined } });
        for (const connection of entry.connections) {
            const bothEnds = nextNodes.some((node) => node.id === connection.fromNodeId) && nextNodes.some((node) => node.id === connection.toNodeId);
            if (!bothEnds) continue;
            if (nextConnections.some((existing) => existing.fromNodeId === connection.fromNodeId && existing.toNodeId === connection.toNodeId)) continue;
            nextConnections.push(connection);
        }
    }
    const restoredIds = new Set(restored);
    return { trash: trash.filter((entry) => !restoredIds.has(entry.node.id)), nodes: nextNodes, connections: nextConnections, restored, missing };
}
