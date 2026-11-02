import { describe, expect, it } from "vitest";

import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

/**
 * A connected text node is an input, not a copy.
 *
 * The panel's box holds what the user typed and nothing else — a connection that silently copied its
 * words into the box would leave the line on the canvas meaning nothing visually. The words reach the
 * model where they are useful: in the request, labelled, next to whatever the box says
 * (docs/decisions.md #185).
 */

const node = (id: string, type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"], x = 0): CanvasNodeData => ({
    id,
    type,
    title: type === CanvasNodeType.Text ? "Text" : "Image",
    position: { x, y: 0 },
    width: 340,
    height: 240,
    metadata,
});

const connect = (fromNodeId: string, toNodeId: string): CanvasConnection => ({ id: `${fromNodeId}->${toNodeId}`, fromNodeId, toNodeId });

const text = (id: string, content: string, x = 0) => node(id, CanvasNodeType.Text, { content }, x);
const image = (id: string, x = 400) => node(id, CanvasNodeType.Image, {}, x);

describe("a connected text node", () => {
    it("reaches the request, labelled, after the words the box holds", () => {
        const context = buildNodeGenerationContext("i1", [text("t1", "a red ceramic teapot"), image("i1")], [connect("t1", "i1")], "a slow pan across the shelf");

        expect(context.prompt).toMatch(/^a slow pan across the shelf\n\n【[^】]+】\na red ceramic teapot$/);
        expect(context.textCount).toBe(1);
    });

    it("is the whole request when the box is empty", () => {
        const context = buildNodeGenerationContext("i1", [text("t1", "a red ceramic teapot"), image("i1")], [connect("t1", "i1")], "");

        // The separator the composition puts between the two parts is trimmed on the way out
        // (`handleGenerateNode`), so what the model sees is just the block.
        expect(context.prompt.trim()).toMatch(/^【[^】]+】\na red ceramic teapot$/);
    });

    it("is appended even when the box happens to say the same words: the connection is an input", () => {
        const context = buildNodeGenerationContext("i1", [text("t1", "a red ceramic teapot"), image("i1")], [connect("t1", "i1")], "a red ceramic teapot");

        expect(context.prompt).toMatch(/^a red ceramic teapot\n\n【[^】]+】\na red ceramic teapot$/);
    });

    it("keeps one block per text node, in connection order", () => {
        const nodes = [text("t1", "a red ceramic teapot"), text("t2", "on a wooden shelf", 200), image("i1")];

        const context = buildNodeGenerationContext("i1", nodes, [connect("t1", "i1"), connect("t2", "i1")], "a still life");

        const blocks = context.prompt.split("\n\n").slice(1);
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toMatch(/^【[^】]+】\na red ceramic teapot$/);
        expect(blocks[1]).toMatch(/^【[^】]+】\non a wooden shelf$/);
    });

    it("changes nothing about a node with no text connected", () => {
        const context = buildNodeGenerationContext("i1", [image("i1")], [], "a red ceramic teapot");

        expect(context.prompt).toBe("a red ceramic teapot");
        expect(context.textCount).toBe(0);
    });
});
