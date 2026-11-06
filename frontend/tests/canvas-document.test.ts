import { describe, expect, test } from "vitest";

import { documentOf } from "../src/lib/canvas/canvas-document";
import type { CanvasDocument } from "../src/services/api/canvases";
import type { CanvasNodeData, CanvasTrashEntry } from "../src/types/canvas";

/**
 * What a canvas document is.
 *
 * The save path and the export path both build it here, because what a zip carries has to be what the
 * server would have stored — the export used to serialise the in-memory project, absolute URLs and all,
 * which put this server's address into a file meant to travel (decisions #152, #171).
 */

function node(overrides: Partial<CanvasNodeData>): CanvasNodeData {
    return { id: "n1", type: "image", position: { x: 0, y: 0 }, width: 100, height: 100, ...overrides } as CanvasNodeData;
}

function documentWith(nodes: CanvasNodeData[], trash: CanvasTrashEntry[] = []): CanvasDocument {
    return { nodes, connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, agent: { open: false, position: null, size: null }, trash };
}

const resolved = "http://127.0.0.1:8190/api/canvases/349b70cf4764/files/up-a1b2c3d4.png";

describe("a canvas document", () => {
    test("names media by reference, never by the URL it was rendered from", () => {
        const written = documentOf(
            documentWith([
                node({
                    metadata: {
                        content: resolved,
                        storageKey: "files/up-a1b2c3d4.png",
                    },
                }),
            ]),
        );
        const metadata = written.nodes[0].metadata;
        expect(metadata?.content).toBe("files/up-a1b2c3d4.png");
        expect(JSON.stringify(written)).not.toContain("127.0.0.1");
    });

    test("leaves what it does not understand alone", () => {
        const noMetadata = node({ metadata: undefined });
        const inline = { id: "i2", content: "data:image/png;base64,AAAA", naturalWidth: 1, naturalHeight: 1, bytes: 1, mimeType: "image/png" };
        const written = documentOf(documentWith([noMetadata, node({ metadata: inline as never })]));
        expect(written.nodes[0]).toBe(noMetadata);
        expect(written.nodes[1].metadata?.content).toBe("data:image/png;base64,AAAA");
    });

    test("drops the title an older canvas gave its nodes", () => {
        // A node has no name (#321). The fields stay readable in old documents — nothing looks at them — and
        // the next save is what takes them out, so a canvas does not carry a label nothing draws forever.
        const legacy = { ...node({ metadata: { content: "/api/canvases/c/files/a.png" } }), title: "Image", titleKey: "canvas.nodeTypes.image", titleParams: { name: "x" } };
        const written = documentOf(documentWith([legacy as never]));
        expect(written.nodes[0]).not.toHaveProperty("title");
        expect(written.nodes[0]).not.toHaveProperty("titleKey");
        expect(written.nodes[0]).not.toHaveProperty("titleParams");
    });

    test("is the document and nothing else", () => {
        const project = { ...documentWith([]), id: "349b70cf4764", rev: "abc", createdAt: "x", updatedAt: "y", bytes: 2 };
        const written = documentOf(project);
        expect(Object.keys(written).sort()).toEqual(["agent", "backgroundMode", "connections", "nodes", "showImageInfo", "trash", "viewport"]);
    });

    test("names a deleted node's media by reference too, which is what keeps the file alive", () => {
        // A trashed node is in the document on purpose (#327): the server frees a file the document does not
        // name, so this line is the difference between "restorable" and "gone". It has to be written the same
        // way a live node is, or the document carries this server's address for a picture it owns.
        const written = documentOf(documentWith([], [{ deletedAt: "2026-01-02T03:04:05.000Z", node: node({ metadata: { content: resolved, storageKey: "files/up-a1b2c3d4.png" } }), connections: [] }]));
        expect(written.trash[0].node.metadata?.content).toBe("files/up-a1b2c3d4.png");
        expect(JSON.stringify(written)).not.toContain("127.0.0.1");
    });

    test("carries the agent window with the canvas", () => {
        const document = documentWith([]);
        document.agent = { open: true, position: { x: 40, y: 60 }, size: { width: 640, height: 520 } };
        expect(documentOf(document).agent).toEqual({ open: true, position: { x: 40, y: 60 }, size: { width: 640, height: 520 } });
    });
});
