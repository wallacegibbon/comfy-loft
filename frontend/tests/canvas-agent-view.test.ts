import { describe, expect, test } from "vitest";

import { describeCanvas } from "../src/lib/canvas/canvas-agent-view";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata } from "../src/types/canvas";

/**
 * What `list_nodes` answers with.
 *
 * One line per node, and the two kinds of words named apart: `content:` is what the node says, `prompt:`
 * is what it will be asked next. One `prompt:` that meant either, depending on the node's type, is what
 * taught the agent that a text node's prompt box was its body (#229).
 */

function node(type: CanvasNodeData["type"], metadata: CanvasNodeMetadata = {}, title = ""): CanvasNodeData {
    return { id: `${type}-1`, type, title, position: { x: 40, y: -12 }, width: 320, height: 240, metadata };
}

const canvas = (nodes: CanvasNodeData[], connections: CanvasConnection[] = []) => describeCanvas(nodes, connections).split("\n");

describe("the canvas as the agent reads it", () => {
    test("a text node shows the text it says and the question it was asked, named apart", () => {
        const lines = canvas([node("text", { content: "宫崎骏风格的森林。", composerContent: "改成无字幕的版本" }, "森林")]);
        expect(lines[0]).toBe("1 nodes, 0 connections");
        expect(lines[1]).toBe(`- text-1 (text) "森林" at (40, -12) content: 宫崎骏风格的森林。 prompt: 改成无字幕的版本`);
    });

    test("a picture shows the run that made it, and no content words of its own", () => {
        // Its content is the picture, which a line cannot carry: the type says what it is, `read_node`
        // hands the bytes over, and the file's URL — which used to fall through as "words" — is not text.
        const lines = canvas([node("image", { content: "/api/canvases/c/files/a.png", prompt: "a brass compass", workflow: "image-z-image-turbo", generatedAt: "2026-11-03T13:09:19.928Z" })]);
        expect(lines[1]).toBe("- image-1 (image) at (40, -12) made 2026-11-03T13:09:19.928Z with image-z-image-turbo prompt: a brass compass");
    });

    test("a node with no words at all is still a line, because an empty node is a fact too", () => {
        expect(canvas([node("image", { content: "/api/canvases/c/files/a.png" })])[1]).toBe("- image-1 (image) at (40, -12)");
    });

    test("a node's words stay on its own line, however many paragraphs they were", () => {
        const lines = canvas([node("audio", { prompt: "line one\nline two\n\nline three" }), node("image", { prompt: "second node" })]);
        expect(lines).toHaveLength(3);
        expect(lines[1]).toContain("prompt: line one line two line three");
        expect(lines[2]).toContain("image-1");
    });

    test("the connections are listed after the nodes, in the order they exist", () => {
        const lines = canvas([node("text", { content: "a brass compass" }), node("image", { prompt: "a compass on a table" })], [{ id: "c1", fromNodeId: "text-1", toNodeId: "image-1" }]);
        expect(lines).toEqual(["2 nodes, 1 connections", "- text-1 (text) at (40, -12) content: a brass compass", "- image-1 (image) at (40, -12) prompt: a compass on a table", "connections:", "- text-1 -> image-1"]);
    });
});
