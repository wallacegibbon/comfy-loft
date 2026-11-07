import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasConnection, CanvasNodeData, CanvasTrashEntry } from "@/types/canvas";

/**
 * What a history step changed, in the words the Undo menu item is written in.
 *
 * An undo stack stores states, and a state does not say what happened between two of them: "Undo" alone was
 * the same word whether the last thing was a picture deleted or a node nudged two pixels, so a user who had
 * just asked the agent to tidy the canvas had no way to know what pressing it would take back (#328). The
 * step is described instead, from the two states it sits between.
 *
 * One function decides both questions the stack asks: *did anything worth a step happen* and *what was it*.
 * A change it answers `null` for is not an edit — which is how a run's progress ticks stop filling the stack
 * with entries that undo nothing (see `sameNode`).
 */

/** The part of a canvas a step is a change to. `trash` is optional so a caller may describe nodes alone. */
export type CanvasSnapshot = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    trash?: CanvasTrashEntry[];
    backgroundMode?: CanvasBackgroundMode;
    showImageInfo?: boolean;
};

/** One kind of change, as data: the wording is the UI's, in the reader's own language. */
export type CanvasChange =
    | { kind: "delete"; ids: string[] }
    | { kind: "restore"; ids: string[] }
    | { kind: "create"; ids: string[] }
    | { kind: "update"; ids: string[] }
    | { kind: "move"; ids: string[] }
    | { kind: "resize"; ids: string[] }
    | { kind: "connect"; pairs: Array<[string, string]> }
    | { kind: "disconnect"; pairs: Array<[string, string]> }
    | { kind: "canvas" };

/**
 * What changed between two states of the canvas, or null when nothing did.
 *
 * One sentence, not a list: the menu item has one line, and a step that did three things is told by the
 * loudest of them — a deletion over an addition over a wire over a change — because that is the one a reader
 * scanning "what will this take back" needs. The rest are recoverable by undoing again.
 */
export function describeChange(before: CanvasSnapshot, after: CanvasSnapshot): CanvasChange | null {
    const removed = before.nodes.filter((node) => !after.nodes.some((candidate) => candidate.id === node.id)).map((node) => node.id);
    const added = after.nodes.filter((node) => !before.nodes.some((candidate) => candidate.id === node.id)).map((node) => node.id);
    // What entered the trash and what left it: the two halves of a delete and of a restore.
    const entered = (after.trash || []).filter((entry) => !(before.trash || []).some((candidate) => candidate.node.id === entry.node.id));
    const left = (before.trash || []).filter((entry) => !(after.trash || []).some((candidate) => candidate.node.id === entry.node.id));

    // A node that moved from the canvas into the trash, or back out of it, is one gesture even though both
    // lists changed: saying "deleted" (or "restored") is what the user did.
    if (entered.length && removed.length) return { kind: "delete", ids: entered.map((entry) => entry.node.id) };
    if (left.length && added.length) return { kind: "restore", ids: left.map((entry) => entry.node.id) };
    if (removed.length) return { kind: "delete", ids: removed };
    if (added.length) return { kind: "create", ids: added };
    if (entered.length) return { kind: "delete", ids: entered.map((entry) => entry.node.id) };
    if (left.length) return { kind: "restore", ids: left.map((entry) => entry.node.id) };

    const beforeWires = new Set(before.connections.map(edgeKey));
    const afterWires = new Set(after.connections.map(edgeKey));
    const joined: Array<[string, string]> = after.connections.filter((connection) => !beforeWires.has(edgeKey(connection))).map((connection) => [connection.fromNodeId, connection.toNodeId]);
    if (joined.length) return { kind: "connect", pairs: joined };
    const cut: Array<[string, string]> = before.connections.filter((connection) => !afterWires.has(edgeKey(connection))).map((connection) => [connection.fromNodeId, connection.toNodeId]);
    if (cut.length) return { kind: "disconnect", pairs: cut };

    const edited = after.nodes.filter((node) => {
        const was = before.nodes.find((candidate) => candidate.id === node.id);
        return was ? !sameNode(was, node) : false;
    });
    if (edited.length) {
        const moved = edited.every((node) => onlyDiffersIn(node, before.nodes, "position"));
        const resized = edited.every((node) => onlyDiffersIn(node, before.nodes, "size"));
        const ids = edited.map((node) => node.id);
        if (moved) return { kind: "move", ids };
        if (resized) return { kind: "resize", ids };
        return { kind: "update", ids };
    }

    if (before.backgroundMode !== after.backgroundMode || before.showImageInfo !== after.showImageInfo) return { kind: "canvas" };

    // A node's run progress changed and nothing else did. That is not an edit — it is the canvas reporting,
    // and a step that undoes nothing must not take a slot from a step that does (#328).
    return null;
}

/** The wording of one change, in the reader's language. */
export function changeText(change: CanvasChange, t: (key: string, options?: Record<string, unknown>) => string): string {
    const what = "ids" in change ? changeSubject(change.ids, t) : change.kind === "connect" || change.kind === "disconnect" ? change.pairs.map(([from, to]) => `${from} → ${to}`).join(", ") : "";
    return t(`canvas.change.${change.kind}`, { what });
}

/**
 * One, or how many — never a column of ids.
 *
 * A node's id is long (`image-1793978334704-fsh6g`), and a step that took six of them would push the menu item
 * off the menu. Above one, the count is the useful fact anyway.
 */
export function changeSubject(ids: string[], t: (key: string, options?: Record<string, unknown>) => string): string {
    return ids.length === 1 ? ids[0] : t("canvas.change.nodes", { count: ids.length });
}

/**
 * Whether two versions of one node are the same node, as far as an edit is concerned.
 *
 * The two fields a run writes on every poll — the step count and "progress could not be shown" — are the
 * canvas reporting on itself, not something anyone did. Comparing them made every poll a history entry: a
 * two-minute render wrote eighty steps and pushed everything the user had done out of a fifty-step stack
 * (#328).
 */
function sameNode(a: CanvasNodeData, b: CanvasNodeData): boolean {
    return quiet(a) === quiet(b);
}

/** A node with the run's own reporting taken out, as a string two versions can be compared by. */
function quiet(node: CanvasNodeData): string {
    const metadata = node.metadata;
    if (!metadata) return JSON.stringify(node);
    const { stepProgress, progressUnavailable, ...rest } = metadata;
    void stepProgress;
    void progressUnavailable;
    return JSON.stringify({ ...node, metadata: rest });
}

/** True when the only thing these two versions of a node disagree about is its corner or its size. */
function onlyDiffersIn(node: CanvasNodeData, before: CanvasNodeData[], field: "position" | "size"): boolean {
    const was = before.find((candidate) => candidate.id === node.id);
    if (!was) return false;
    if (field === "position") {
        return was.position.x === node.position.x && was.position.y === node.position.y ? false : quiet({ ...node, position: was.position }) === quiet(was);
    }
    return was.width === node.width && was.height === node.height ? false : quiet({ ...node, width: was.width, height: was.height }) === quiet(was);
}

function edgeKey(connection: CanvasConnection): string {
    return `${connection.fromNodeId}->${connection.toNodeId}`;
}
