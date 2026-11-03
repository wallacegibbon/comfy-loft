import { describe, expect, it } from "vitest";

import { buildNodeGenerationContext, describeEmptyInputs, inputsHoldingNothing, repeatedConnectedText } from "@/components/canvas/canvas-node-generation";
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

/**
 * The same words in both places are said twice, and the agent's tools are the one writer that can still do
 * it: the panel stopped copying a connected text into the box (#185), `create_node` did not (#203). This is
 * what those tools name in their answer — the check, not a refusal and not a rewrite.
 */
describe("repeatedConnectedText", () => {
    it("names the text node whose words the node's own prompt repeats", () => {
        expect(repeatedConnectedText("i1", "  a red ceramic teapot\n", [text("t1", "a red ceramic teapot"), image("i1")], [connect("t1", "i1")])).toEqual(["t1"]);
    });

    it("names only the text that is repeated word for word", () => {
        const nodes = [text("t1", "a red ceramic teapot"), text("t2", "on a wooden shelf", 200), image("i1")];

        expect(repeatedConnectedText("i1", "on a wooden shelf", nodes, [connect("t1", "i1"), connect("t2", "i1")])).toEqual(["t2"]);
    });

    it("says nothing when the prompt only mentions those words inside a longer sentence", () => {
        expect(repeatedConnectedText("i1", "a red ceramic teapot on a shelf", [text("t1", "a red ceramic teapot"), image("i1")], [connect("t1", "i1")])).toEqual([]);
    });

    it("says nothing when nothing is connected, or when the prompt is empty", () => {
        expect(repeatedConnectedText("i1", "a red ceramic teapot", [image("i1")], [])).toEqual([]);
        expect(repeatedConnectedText("i1", "", [text("t1", "a red ceramic teapot"), image("i1")], [connect("t1", "i1")])).toEqual([]);
    });
});

/**
 * A wire carries the upstream node's content, and never its prompt.
 *
 * The prompt is what a node was asked — it is how the node is made, not what it has to give — so nothing
 * downstream may read it. These are the two places the old rule was broken: a text node with words only in
 * its prompt (nothing on its card) still fed those words downstream, and a picture with no picture yet fed
 * the words it was asked as though they were something it held (#230).
 */
describe("a wire that carries nothing", () => {
    const picture = (id: string, metadata: CanvasNodeData["metadata"], x = 400) => node(id, CanvasNodeType.Image, metadata, x);

    it("carries a text node's card, and nothing when the card is empty", () => {
        const empty = buildNodeGenerationContext("i1", [node("t1", CanvasNodeType.Text, { prompt: "a red ceramic teapot" }), image("i1")], [connect("t1", "i1")], "a still life");
        const written = buildNodeGenerationContext("i1", [text("t1", "a red ceramic teapot"), image("i1")], [connect("t1", "i1")], "a still life");

        expect(empty.prompt).toBe("a still life");
        expect(empty.textCount).toBe(0);
        expect(written.textCount).toBe(1);
    });

    it("carries a picture, not the words the picture was asked for", () => {
        const context = buildNodeGenerationContext("i1", [picture("i0", { content: "data:image/png;base64,AAAA", prompt: "a red ceramic teapot" }), image("i1")], [connect("i0", "i1")], "a still life");

        expect(context.referenceImages).toHaveLength(1);
        expect(context.textCount).toBe(0);
        expect(context.prompt).toBe("a still life");
    });

    it("names the wired node when it holds nothing, so the run can refuse instead of making something up", () => {
        const nodes = [node("t1", CanvasNodeType.Text, { prompt: "a red ceramic teapot" }), picture("i0", { prompt: "on a shelf" }), image("i1")];

        const missing = inputsHoldingNothing("i1", nodes, [connect("t1", "i1"), connect("i0", "i1")]);

        expect(missing.map((input) => [input.node.id, input.state])).toEqual([
            ["t1", "empty"],
            ["i0", "empty"],
        ]);
        expect(describeEmptyInputs(missing)).toMatch(/^t1 \(Text\) holds nothing yet.*; i0 \(Image\) holds nothing yet/);
    });

    it("says nothing when every wired node holds what it promised", () => {
        const nodes = [text("t1", "a red ceramic teapot"), picture("i0", { content: "data:image/png;base64,AAAA" }), image("i1")];

        expect(inputsHoldingNothing("i1", nodes, [connect("t1", "i1"), connect("i0", "i1")])).toEqual([]);
    });

    it("tells a node still being made apart from one that failed, because what to do differs", () => {
        const nodes = [picture("i0", { status: "loading" }), picture("i1", { status: "error" }), image("i2")];

        const missing = inputsHoldingNothing("i2", nodes, [connect("i0", "i2"), connect("i1", "i2")]);

        expect(missing.map((input) => input.state)).toEqual(["running", "failed"]);
        expect(describeEmptyInputs(missing)).toMatch(/i0 \(Image\) is still being made/);
        expect(describeEmptyInputs(missing)).toMatch(/i1 \(Image\)'s last run failed/);
    });

    it("reads a group by what is inside it", () => {
        const group = node("g1", CanvasNodeType.Group, {}, 200);
        const nodes = [group, node("t1", CanvasNodeType.Text, { prompt: "words with no card", groupId: "g1" } as CanvasNodeData["metadata"], 200), image("i1")];

        expect(inputsHoldingNothing("i1", nodes, [connect("g1", "i1")]).map((input) => input.node.id)).toEqual(["g1"]);
    });

    it("does not report a config node: it is a selector, not a source", () => {
        const nodes = [node("c1", CanvasNodeType.Config, {}, 200), image("i1")];

        expect(inputsHoldingNothing("i1", nodes, [connect("c1", "i1")])).toEqual([]);
    });
});

/**
 * The config node is a hub, and the run reads through it.
 *
 * A node wired to a config node takes its inputs from the config's other wires, so a wire to an empty node
 * one hop away is still a wire to nothing. The refusal has to follow the same road the request does, or it
 * refuses for the wires it can see and quietly runs on the ones it cannot.
 */
describe("a wire through a config hub", () => {
    it("names an empty node that reaches the run through the config node", () => {
        const nodes = [node("t1", CanvasNodeType.Text, { prompt: "words with no card" }), node("c1", CanvasNodeType.Config, {}, 200), image("i1")];

        const missing = inputsHoldingNothing("i1", nodes, [connect("t1", "c1"), connect("i1", "c1")]);

        expect(missing.map((input) => input.node.id)).toEqual(["t1"]);
    });

    it("says nothing when the config hub's inputs hold what they promised", () => {
        const nodes = [text("t1", "a red ceramic teapot"), node("c1", CanvasNodeType.Config, {}, 200), image("i1")];

        expect(inputsHoldingNothing("i1", nodes, [connect("t1", "c1"), connect("i1", "c1")])).toEqual([]);
    });
});
