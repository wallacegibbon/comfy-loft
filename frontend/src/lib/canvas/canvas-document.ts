import type { CanvasDocument } from "@/services/api/canvases";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * What belongs in `canvas.json`, and nothing else.
 *
 * One function, two callers — the save queue and the export — because they must agree: what a zip carries
 * has to be exactly what the server would have stored for that canvas. They disagreed once: the export
 * serialised the in-memory project, whose `metadata.content` is the absolute URL an `<img>` needs, so a zip
 * carried this server's host, port and canvas id into a document that is supposed to be portable
 * (decisions #152), and importing it put those URLs back on screen until the next save stripped them.
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
 * A node as it belongs on disk: media named by reference, never by the URL it was rendered from.
 *
 * The editor holds absolute URLs in `metadata.content` because that is what an `<img>` needs. Writing them
 * back would put this server's host and port into the workspace — a document that breaks on another
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
