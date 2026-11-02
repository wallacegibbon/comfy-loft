import { describe, expect, test } from "vitest";

import { documentOf, normalizeConnections } from "../src/lib/canvas/canvas-document";
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
    return { nodes, connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, agent: { open: false, position: null, size: null } };
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
        expect(Object.keys(written).sort()).toEqual(["agent", "backgroundMode", "connections", "nodes", "showImageInfo", "viewport"]);
    });

    test("carries the agent window with the canvas", () => {
        const document = documentWith([]);
        document.agent = { open: true, position: { x: 40, y: 60 }, size: { width: 640, height: 520 } };
        expect(documentOf(document).agent).toEqual({ open: true, position: { x: 40, y: 60 }, size: { width: 640, height: 520 } });
    });
});

/**
 * A connection's id has to identify one connection.
 *
 * The agent wires several nodes inside one millisecond, so a document written before #205 holds several
 * connections with `conn-<Date.now()>` — and the id is what selecting, highlighting and deleting go by.
 * `canvases/3df8b7a65088/canvas.json` still had a pair when this was written, which is why reading repairs
 * it rather than waiting for the next gesture that mints one.
 */
describe("the connections a document is read with", () => {
    const connection = (id: string, fromNodeId = "text-1", toNodeId = "image-1") => ({ id, fromNodeId, toNodeId });

    test("keeps one that is already whole", () => {
        const stored = [connection("conn-a"), connection("conn-b", "text-1", "image-2")];
        expect(normalizeConnections(stored)).toEqual(stored);
    });

    test("gives a duplicate id to a fresh one, and leaves the first alone", () => {
        const [first, second] = normalizeConnections([connection("conn-1"), connection("conn-1", "text-1", "image-2")]);
        expect(first.id).toBe("conn-1");
        expect(second.id).not.toBe("conn-1");
        expect(new Set([first.id, second.id]).size).toBe(2);
        // The endpoints are what the connection means, and they are untouched.
        expect(second).toMatchObject({ fromNodeId: "text-1", toNodeId: "image-2" });
    });

    test("names one that arrived without an id, and drops one that names no node", () => {
        expect(normalizeConnections([{ fromNodeId: "a", toNodeId: "b" }])[0].id).toBeTruthy();
        expect(normalizeConnections([{ fromNodeId: "a" }, { toNodeId: "b" }, connection("conn-c")])).toEqual([connection("conn-c")]);
    });

    test("is empty rather than broken for anything that is not a list", () => {
        expect(normalizeConnections(undefined)).toEqual([]);
        expect(normalizeConnections("files/x.png")).toEqual([]);
        expect(normalizeConnections([null, 3, "conn-1"])).toEqual([]);
    });
});
