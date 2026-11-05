import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ConnectionHandle, type ViewportTransform } from "@/types/canvas";

export function nodeBounds(nodes: CanvasNodeData[]) {
    return nodes.reduce(
        (acc, node) => ({
            left: Math.min(acc.left, node.position.x),
            top: Math.min(acc.top, node.position.y),
            right: Math.max(acc.right, node.position.x + node.width),
            bottom: Math.max(acc.bottom, node.position.y + node.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
}

function containsCenter(group: CanvasNodeData, node: CanvasNodeData) {
    const centerX = node.position.x + node.width / 2;
    const centerY = node.position.y + node.height / 2;
    return centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height;
}

export function findGroupDropTarget(movedIds: Set<string>, nodes: CanvasNodeData[]) {
    if (nodes.some((node) => movedIds.has(node.id) && node.type === CanvasNodeType.Group)) return null;
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return null;
    // Walk backwards instead of copying and reversing; this runs on every drag frame.
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const group = nodes[index];
        if (group.type !== CanvasNodeType.Group || movedIds.has(group.id)) continue;
        if (movingNodes.some((node) => containsCenter(group, node))) return group;
    }
    return null;
}

export function snapNodesIntoGroup(movedIds: Set<string>, nodes: CanvasNodeData[], group: CanvasNodeData) {
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return nodes;
    const pad = 24;
    const bounds = nodeBounds(movingNodes);
    const left = group.position.x + pad;
    const top = group.position.y + pad;
    const right = group.position.x + group.width - pad;
    const bottom = group.position.y + group.height - pad;
    const dx = bounds.right - bounds.left > right - left ? left - bounds.left : bounds.left < left ? left - bounds.left : bounds.right > right ? right - bounds.right : 0;
    const dy = bounds.bottom - bounds.top > bottom - top ? top - bounds.top : bounds.top < top ? top - bounds.top : bounds.bottom > bottom ? bottom - bounds.bottom : 0;
    return nodes.map((node) => {
        if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
        return { ...node, position: { x: node.position.x + dx, y: node.position.y + dy }, metadata: { ...node.metadata, groupId: group.id } };
    });
}

const GROUP_WRAP_PADDING = 24;
const GROUP_WRAP_TOP_PADDING = 52;

function selectedGroupIds(selectedIds: Set<string>, nodes: CanvasNodeData[]) {
    return new Set(nodes.filter((node) => selectedIds.has(node.id) && node.type === CanvasNodeType.Group).map((node) => node.id));
}

export function collectGroupMemberNodes(selectedIds: Set<string>, nodes: CanvasNodeData[]) {
    const groups = selectedGroupIds(selectedIds, nodes);
    return nodes.filter((node) => node.type !== CanvasNodeType.Group && (selectedIds.has(node.id) || (node.metadata?.groupId != null && groups.has(node.metadata.groupId))));
}

/**
 * The cards a move carries: the ones named, and — for every group among them — the nodes inside it.
 *
 * A group is a box drawn around nodes that stay where they are, so moving the box alone would leave its
 * members behind and the card would be drawn around nothing. One function for both callers: a drag names the
 * live selection, a tool names the one card it was given, and a group means the same thing to each of them.
 *
 * Members are found by `groupId`, not by geometry: a member may sit outside the card's box (#290), and it is
 * still a member.
 */
export function withGroupMembers(ids: Set<string>, nodes: CanvasNodeData[]) {
    const groups = new Set(nodes.filter((node) => node.type === CanvasNodeType.Group && ids.has(node.id)).map((node) => node.id));
    return new Set(nodes.filter((node) => ids.has(node.id) || (node.metadata?.groupId != null && groups.has(node.metadata.groupId))).map((node) => node.id));
}

export function getGroupWrapRect(members: CanvasNodeData[]) {
    const bounds = nodeBounds(members);
    return {
        x: bounds.left - GROUP_WRAP_PADDING,
        y: bounds.top - GROUP_WRAP_TOP_PADDING,
        width: bounds.right - bounds.left + GROUP_WRAP_PADDING * 2,
        height: bounds.bottom - bounds.top + GROUP_WRAP_TOP_PADDING + GROUP_WRAP_PADDING,
    };
}

export function canGroupSelectedNodes(selectedIds: Set<string>, nodes: CanvasNodeData[]) {
    const members = collectGroupMemberNodes(selectedIds, nodes);
    if (members.length < 2) return false;
    const groupId = members[0].metadata?.groupId;
    return !groupId || members.some((node) => node.metadata?.groupId !== groupId);
}

export function canUngroupSelectedNodes(selectedIds: Set<string>, nodes: CanvasNodeData[]) {
    return nodes.some((node) => selectedIds.has(node.id) && (node.type === CanvasNodeType.Group || Boolean(node.metadata?.groupId)));
}

/**
 * The groups this operation left empty — a box whose members all went somewhere else in the same press.
 *
 * The shell is debris: it held nodes, this call moved them into another group, and what is left is a card
 * with nothing in it that the press itself created. The rule is "emptied by this call", and the before/after
 * comparison is what makes it that rule: a group that was *already* empty before the press is not this
 * call's debris, it is something the person made — a box waiting to be filled — and deleting it because
 * something unrelated was grouped elsewhere on the canvas was never the intent.
 */
function emptiedGroupIds(before: CanvasNodeData[], after: CanvasNodeData[]): Set<string> {
    const held = (nodes: CanvasNodeData[]) => new Set(nodes.filter((node) => node.type !== CanvasNodeType.Group && node.metadata?.groupId).map((node) => node.metadata?.groupId as string));
    const was = held(before);
    const now = held(after);
    const boxes = new Set(after.filter((node) => node.type === CanvasNodeType.Group).map((node) => node.id));
    return new Set([...was].filter((groupId) => !now.has(groupId) && boxes.has(groupId)));
}

function withoutRemoved(nodes: CanvasNodeData[], connections: CanvasConnection[], removedIds: Set<string>) {
    return {
        nodes: nodes.filter((node) => !removedIds.has(node.id)),
        connections: connections.filter((connection) => !removedIds.has(connection.fromNodeId) && !removedIds.has(connection.toNodeId)),
    };
}

export function applyGroupSelection(selectedIds: Set<string>, nodes: CanvasNodeData[], connections: CanvasConnection[], group: CanvasNodeData) {
    const members = collectGroupMemberNodes(selectedIds, nodes);
    if (members.length < 2) return null;
    const memberIds = new Set(members.map((node) => node.id));
    const flattenedGroupIds = selectedGroupIds(selectedIds, nodes);
    const updated = nodes.filter((node) => !flattenedGroupIds.has(node.id)).map((node) => (memberIds.has(node.id) ? { ...node, metadata: { ...node.metadata, groupId: group.id } } : node));
    const insertAt = updated.findIndex((node) => memberIds.has(node.id));
    const withGroup = insertAt < 0 ? [...updated, group] : [...updated.slice(0, insertAt), group, ...updated.slice(insertAt)];
    const next = withoutRemoved(withGroup, connections, new Set([...flattenedGroupIds, ...emptiedGroupIds(nodes, withGroup)]));
    return { ...next, selectedIds: [group.id] };
}

export function applyUngroupSelection(selectedIds: Set<string>, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const flattenedGroupIds = selectedGroupIds(selectedIds, nodes);
    if (!flattenedGroupIds.size && !nodes.some((node) => selectedIds.has(node.id) && node.metadata?.groupId)) return null;
    const releasedIds = new Set<string>();
    const updated = nodes
        .filter((node) => !flattenedGroupIds.has(node.id))
        .map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            if (!flattenedGroupIds.has(groupId) && !selectedIds.has(node.id)) return node;
            releasedIds.add(node.id);
            return { ...node, metadata: { ...node.metadata, groupId: undefined } };
        });
    const next = withoutRemoved(updated, connections, new Set([...flattenedGroupIds, ...emptiedGroupIds(nodes, updated)]));
    return { ...next, selectedIds: next.nodes.filter((node) => selectedIds.has(node.id) || releasedIds.has(node.id)).map((node) => node.id) };
}

export function findContainingGroupId(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    // Called once per moved node when a drag ends, so avoid copying the node list each time.
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const group = nodes[index];
        if (group.type === CanvasNodeType.Group && group.id !== node.id && containsCenter(group, node)) return group.id;
    }
    return undefined;
}

export function getConnectionTargetAnchor(node: CanvasNodeData, current: ConnectionHandle) {
    return {
        x: current.handleType === "source" ? node.position.x : node.position.x + node.width,
        y: node.position.y + node.height / 2,
    };
}

/**
 * Which way a connection runs, and whether the pair may be connected at all.
 *
 * It runs from the node the gesture started at — the two ids are stated in the order the gesture stated
 * them. A group is a container rather than a source, so nothing may be wired *into* one.
 */
export function normalizeConnection(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[]) {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    if (!first || !second || first.id === second.id) return null;
    if (second.type === CanvasNodeType.Group) return null;
    return { fromNodeId: first.id, toNodeId: second.id };
}

type FocusFrame = {
    // Screen-space room taken above/below the node by open overlays (hover toolbar, prompt panel), gaps included.
    above?: number;
    below?: number;
};

// Viewport that centers the node (plus any open overlay above/below) in the canvas, zoomed so the whole
// thing fits (the node itself is kept within 60% of the viewport). When an overlay is open below the node,
// the remaining space is split 3:1, so the node sits in the upper part of the room it has rather than in
// the middle of it.
export function focusViewportForNode(node: Pick<CanvasNodeData, "position" | "width" | "height">, size: { width: number; height: number }, frame: FocusFrame = {}): ViewportTransform {
    const above = frame.above ?? 0;
    const below = frame.below ?? 0;
    const usableBottom = size.height;
    const nodeCenterX = node.position.x + node.width / 2;
    const nodeCenterY = node.position.y + node.height / 2;
    const verticalRoom = usableBottom * 0.92 - above - below;
    const k = Math.min(Math.max(Math.min((size.width * 0.6) / node.width, (size.height * 0.6) / node.height, verticalRoom / node.height), 0.05), 1);
    const groupHeight = above + node.height * k + below;
    const slack = usableBottom - groupHeight;
    const groupTop = slack * (below > 0 && slack > 0 ? 0.75 : 0.5);
    return { x: size.width / 2 - nodeCenterX * k, y: groupTop + groupHeight / 2 - nodeCenterY * k - (below - above) / 2, k };
}
