import { nanoid } from "nanoid";

import type { CanvasDocument } from "@/services/api/canvases";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

/**
 * What belongs in `canvas.json`, and nothing else.
 *
 * One function, two callers — the save queue and the export — because they must agree: what a zip carries
 * has to be exactly what the gateway would have stored for that canvas. They disagreed once: the export
 * serialised the in-memory project, whose `metadata.content` is the absolute URL an `<img>` needs, so a zip
 * carried this gateway's host, port and canvas id into a document that is supposed to be portable
 * (decisions #152), and importing it put those URLs back on screen until the next save stripped them.
 *
 * The other direction lives here too: `normalizeConnections` is what reading a stored document puts back
 * into shape, and it is the same rule either way — a connection's id identifies one connection.
 */
export function documentOf(project: CanvasDocument): CanvasDocument {
    return {
        nodes: project.nodes.map(withoutResolvedUrls),
        connections: project.connections,
        backgroundMode: project.backgroundMode,
        showImageInfo: project.showImageInfo,
        viewport: project.viewport,
        agent: project.agent,
    };
}

/**
 * The connections a stored document carries, with ids that are ids.
 *
 * A document written before #205 can hold several connections sharing one id — `conn-\u003cDate.now()\u003e` is one
 * value per millisecond, and the agent wires several nodes inside one — and the id is what selecting,
 * highlighting and deleting go by, so two connections with one id light up together and a delete of either
 * removes both. `canvases/3df8b7a65088/canvas.json` was still carrying that pair when this was written.
 *
 * Reading is the place to repair it: the first connection keeps its id, a later duplicate gets a fresh one,
 * and an entry that names no node at all is dropped rather than rendered. The repaired ids are what the next
 * save writes, so a document is fixed by being opened — and an export made before this is fixed by being
 * imported (#205).
 */
export function normalizeConnections(raw: unknown): CanvasConnection[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const connections: CanvasConnection[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const candidate = entry as Partial<CanvasConnection>;
        const fromNodeId = typeof candidate.fromNodeId === "string" ? candidate.fromNodeId : "";
        const toNodeId = typeof candidate.toNodeId === "string" ? candidate.toNodeId : "";
        if (!fromNodeId || !toNodeId) continue;
        const stored = typeof candidate.id === "string" ? candidate.id.trim() : "";
        const id = stored && !seen.has(stored) ? stored : nanoid();
        seen.add(id);
        connections.push({ id, fromNodeId, toNodeId });
    }
    return connections;
}

/**
 * A node as it belongs on disk: media named by reference, never by the URL it was rendered from.
 *
 * The editor holds absolute URLs in `metadata.content` because that is what an `<img>` needs. Writing them
 * back would put this gateway's host and port into the workspace — a document that breaks on another
 * machine, and the exact thing #152 said a canvas may not contain. `storageKey` is the reference
 * (`files/<name>`), so it is what the document keeps.
 */
function withoutResolvedUrls(node: CanvasNodeData): CanvasNodeData {
    const metadata = node.metadata;
    if (!metadata) return node;
    const next = { ...metadata };
    if (metadata.storageKey) next.content = metadata.storageKey;
    return { ...node, metadata: next };
}
