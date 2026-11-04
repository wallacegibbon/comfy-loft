import { describe, expect, test } from "vitest";

import { describeCanvas } from "../src/lib/canvas/canvas-agent-view";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata } from "../src/types/canvas";

/**
 * What `list_nodes` answers with.
 *
 * One line per node, carrying what the node *holds* — `content:` — and nothing else. What a node will be
 * asked is a private word until someone reads it on purpose, which `read_prompt` is for: a list that
 * printed both carried every node's words twice, and put a field with two meanings back where #229 had
 * just cleaned it up (#233).
 */

function node(type: CanvasNodeData["type"], metadata: CanvasNodeMetadata = {}, title = ""): CanvasNodeData {
    return { id: `${type}-1`, type, title, position: { x: 40, y: -12 }, width: 320, height: 240, metadata };
}

const canvas = (nodes: CanvasNodeData[], connections: CanvasConnection[] = []) => describeCanvas(nodes, connections).split("\n");

describe("the canvas as the agent reads it", () => {
    test("a text node shows the text it says, and not the question standing behind it", () => {
        const lines = canvas([node("text", { content: "宫崎骏风格的森林。", composerContent: "改成无字幕的版本" }, "森林")]);
        expect(lines[0]).toBe("1 nodes, 0 connections");
        expect(lines[1]).toBe(`- text-1 (text) "森林" at (40, -12), 320×240 content: 宫崎骏风格的森林。`);
        // The question is still there, one call away: `read_prompt` is what answers with it (#233).
        expect(describeCanvas([node("text", { composerContent: "改成无字幕的版本" })], [])).not.toContain("改成无字幕的版本");
    });

    test("a picture shows the run that made it, and no content words of its own", () => {
        // Its content is the picture, which a line cannot carry: the type says what it is, `read_node`
        // hands the bytes over, and the file's URL — which used to fall through as "words" — is not text.
        const lines = canvas([node("image", { content: "/api/canvases/c/files/a.png", prompt: "a brass compass", workflow: "image-z-image-turbo", generatedAt: "2026-11-03T13:09:19.928Z" })]);
        expect(lines[1]).toBe("- image-1 (image) at (40, -12), 320×240 made 2026-11-03T13:09:19.928Z with image-z-image-turbo");
    });

    test("a node with no words at all is still a line, because an empty node is a fact too", () => {
        expect(canvas([node("image", { content: "/api/canvases/c/files/a.png" })])[1]).toBe("- image-1 (image) at (40, -12), 320×240");
    });

    test("a node's words stay on its own line, however many paragraphs they were", () => {
        const lines = canvas([node("text", { content: "line one\nline two\n\nline three" }), node("image", { prompt: "second node" })]);
        expect(lines).toHaveLength(3);
        expect(lines[1]).toContain("content: line one line two line three");
        expect(lines[2]).toContain("image-1");
    });

    test("the connections are listed after the nodes, in the order they exist", () => {
        const lines = canvas([node("text", { content: "a brass compass" }), node("image", { prompt: "a compass on a table" })], [{ id: "c1", fromNodeId: "text-1", toNodeId: "image-1" }]);
        expect(lines).toEqual(["2 nodes, 1 connections", "- text-1 (text) at (40, -12), 320×240 content: a brass compass", "- image-1 (image) at (40, -12), 320×240", "connections:", "- text-1 -> image-1"]);
    });

    // A card is the shape of what it holds, not its size: an agent deciding whether a node is worth reading
    // needs to know the photograph is 1920×1280 in a 480×320 card. The second size is left out when the two
    // agree, because a fact repeated is noise.
    test("a picture's own size is on the line when the card is not that size", () => {
        const picture = (naturalWidth: number, naturalHeight: number) => ({ ...node("image", { content: "/api/canvases/c/files/a.png", naturalWidth, naturalHeight }) });
        expect(canvas([picture(1920, 1280)])[1]).toBe("- image-1 (image) at (40, -12), 320×240 (picture 1920×1280)");
        // The card IS the picture here (320×240), so there is one size to state and it has been stated.
        expect(canvas([picture(320, 240)])[1]).toBe("- image-1 (image) at (40, -12), 320×240");
    });
});
