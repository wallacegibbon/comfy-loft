import { expect, test } from "vitest";

import type { CanvasNodeData } from "../src/types/canvas";

const { nodeCanGenerate } = await import("../src/lib/canvas/canvas-generation-helpers");
const { CanvasNodeType } = await import("../src/types/canvas");

const node = (metadata: CanvasNodeData["metadata"]): CanvasNodeData => ({
    id: "n",
    type: CanvasNodeType.Image,
    position: { x: 0, y: 0 },
    width: 240,
    height: 240,
    metadata,
});

/**
 * Three states, read off two facts: whether there is content, and whether the node recorded what runs.
 *
 * The middle state is the one that matters here. A crop, a split and an upload are content with no model —
 * nothing on the canvas asked anything to make them — and the panel used to fall back to the canvas's default
 * model for exactly that case, showing a send button whose only outcome was to repaint the material.
 */
test("an empty node is a generator: the default model runs into it", () => {
    expect(nodeCanGenerate(node({}))).toBe(true);
    expect(nodeCanGenerate(node(undefined))).toBe(true);
});

test("a node that records its model can be asked again", () => {
    expect(nodeCanGenerate(node({ content: "files/a.png", model: "default::image-z-image-turbo" }))).toBe(true);
});

test("material is content with nothing recorded to run", () => {
    // A crop, a split, an upload, a mask node.
    expect(nodeCanGenerate(node({ content: "files/a.png" }))).toBe(false);
    // A node from the build that did not record what made it (#293): it knows the workflow, not the model, so
    // there is still nothing to re-run here.
    expect(nodeCanGenerate(node({ content: "files/a.png", workflow: "image-esrgan-upscale" }))).toBe(false);
});
