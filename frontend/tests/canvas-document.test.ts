import { describe, expect, test } from "vitest";

import { documentOf } from "../src/lib/canvas/canvas-document";
import type { CanvasDocument } from "../src/services/api/canvases";
import type { CanvasNodeData } from "../src/types/canvas";

/**
 * What a canvas document is.
 *
 * The save path and the export path both build it here, because what a zip carries has to be what the
 * gateway would have stored — the export used to serialise the in-memory project, absolute URLs and all,
 * which put this gateway's address into a file meant to travel (decisions #152, #171).
 */

function node(overrides: Partial<CanvasNodeData>): CanvasNodeData {
    return { id: "n1", type: "image", title: "n1", position: { x: 0, y: 0 }, width: 100, height: 100, ...overrides } as CanvasNodeData;
}

function documentWith(nodes: CanvasNodeData[]): CanvasDocument {
    return { nodes, connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
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

    test("is the document and nothing else", () => {
        const project = { ...documentWith([]), id: "349b70cf4764", title: "kept by the summary", rev: "abc", createdAt: "x", updatedAt: "y", bytes: 2 };
        const written = documentOf(project);
        expect(Object.keys(written).sort()).toEqual(["backgroundMode", "connections", "nodes", "showImageInfo", "viewport"]);
    });
});
