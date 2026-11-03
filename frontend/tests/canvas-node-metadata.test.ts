import { describe, expect, test } from "vitest";

import { documentOf } from "../src/lib/canvas/canvas-document";
import { audioMetadata, imageMetadata, videoMetadata } from "../src/lib/canvas/canvas-node-factory";
import type { CanvasDocument } from "../src/services/api/canvases";
import type { CanvasNodeData } from "../src/types/canvas";

/**
 * What a node's metadata holds while the canvas is open.
 *
 * `content` is the URL the media is shown from, `storageKey` the reference the document keeps. A node
 * built in this session used to carry the reference in `content`, which only worked for the renderers
 * that resolve it themselves: the enlarged preview and the mask/crop editors load `content` as an
 * image, so they pointed at `files/<name>` — a URL that does not exist until the page is reloaded and
 * the canvas is hydrated (#152, #156, #173).
 */

const url = "http://127.0.0.1:8190/api/canvases/349b70cf4764/files/task_ab12.png";
const key = "files/task_ab12.png";

function documentWith(nodes: CanvasNodeData[]): CanvasDocument {
    return { nodes, connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, agent: { open: false, position: null, size: null } };
}

function nodeFrom(metadata: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id: "n1", type: "image", title: "n1", position: { x: 0, y: 0 }, width: 100, height: 100, metadata };
}

describe("a node built from a finished file", () => {
    test("is shown from the URL it is served at", () => {
        const metadata = imageMetadata({ url, storageKey: key, width: 512, height: 512, bytes: 10, mimeType: "image/png" });
        expect(metadata.content).toBe(url);
        expect(metadata.storageKey).toBe(key);
        expect(metadata.naturalWidth).toBe(512);
    });

    test("keeps the reference for the document, never the URL", () => {
        const metadata = imageMetadata({ url, storageKey: key, width: 512, height: 512, bytes: 10, mimeType: "image/png" });
        const written = documentOf(documentWith([nodeFrom(metadata)]));
        expect(written.nodes[0].metadata?.content).toBe(key);
        expect(JSON.stringify(written)).not.toContain("127.0.0.1");
    });

    test("falls back to the reference when a file has no URL", () => {
        expect(imageMetadata({ url: "", storageKey: key, width: 1, height: 1, bytes: 1, mimeType: "" }).content).toBe(key);
    });

    test("is derived from the canvas it belongs to, not from the address a run reported", async () => {
        // A run's absolute URL is built from the gateway's PUBLIC_BASE_URL, which need not be the address
        // the page was opened at (a LAN name, a reverse proxy). The canvas's own file URL is the one every
        // other renderer resolves, so the lightbox and the thumbnail cannot disagree about where it is.
        const { setActiveCanvas } = await import("../src/services/canvas-files");
        setActiveCanvas("349b70cf4764");
        const metadata = imageMetadata({ url: "http://elsewhere.example/files/task_ab12.png", storageKey: key, width: 1, height: 1, bytes: 1, mimeType: "" });
        setActiveCanvas("");
        expect(metadata.content).toBe(`http://127.0.0.1:8190/api/canvases/349b70cf4764/files/task_ab12.png`);
    });

    test("does the same for clips and sounds", () => {
        const clip = videoMetadata({ url, storageKey: key, bytes: 10, mimeType: "video/mp4", width: 64, height: 64 });
        const sound = audioMetadata({ url, storageKey: key, bytes: 10, mimeType: "audio/mpeg" });
        expect(clip.content).toBe(url);
        expect(sound.content).toBe(url);
        expect(documentOf(documentWith([nodeFrom(clip), nodeFrom(sound)])).nodes.every((node) => node.metadata?.content === key)).toBe(true);
    });
});
