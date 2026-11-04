import { describe, expect, test } from "vitest";

import { runTool, type CanvasHands } from "../src/lib/canvas/canvas-agent-tools";
import { registerBuiltinNodes } from "../src/components/canvas/nodes/builtin-nodes";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata } from "../src/types/canvas";

/**
 * The tools the agent may call, and what each one writes.
 *
 * These are decisions rather than wiring, so they are called here the way the page calls them: a name, the
 * arguments as they arrived, the hands the page lends, and a session to answer on. What the fix behind them
 * has to hold is one thing above all: a text node is its words and nothing else, so every tool that treats
 * it as something with a question refuses instead of writing a field no surface shows (#278).
 */

// The node types' own definitions, which is where "a card that frames a picture keeps its shape" lives
// (docs/decisions.md #264): `resize_node` asks them rather than switching on the type itself.
registerBuiltinNodes();

function node(type: CanvasNodeData["type"], metadata: CanvasNodeMetadata = {}): CanvasNodeData {
    return { id: `${type}-1`, type, title: `${type}-1`, position: { x: 0, y: 0 }, width: 320, height: 240, metadata };
}

/** The page's hands, with every write recorded instead of performed. */
function handsFor(nodes: CanvasNodeData[], connections: CanvasConnection[] = []) {
    const written = {
        prompts: [] as Array<[string, string]>,
        texts: [] as Array<[string, string]>,
        generated: [] as Array<[string, string]>,
        created: [] as string[],
        resized: [] as Array<[string, number, number]>,
    };
    const hands: CanvasHands = {
        nodes: () => nodes,
        connections: () => connections,
        createNode: (type) => {
            written.created.push(type);
            return node(type);
        },
        generateNode: async (nodeId, mode, prompt) => {
            written.generated.push([nodeId, prompt]);
            void mode;
        },
        setNodePrompt: (nodeId, prompt) => void written.prompts.push([nodeId, prompt]),
        writeText: (nodeId, text) => void written.texts.push([nodeId, text]),
        connectNodes: () => false,
        deleteNodes: () => {},
        focusNode: () => {},
        moveNode: () => {},
        resizeNode: (nodeId, width, height) => void written.resized.push([nodeId, width, height]),
    };
    return { hands, written };
}

const card = "宫崎骏风格的森林。";
const textSaying = (content: string) => node("text", { content });

const textOf = async (hands: CanvasHands, name: string, args: Record<string, unknown>) => {
    const answer = await runTool(name, args, hands, "canvas:test");
    return { answer, text: (answer.content[0] as { text: string }).text };
};

describe("set_text: writing what the card says", () => {
    test("writes the text itself, and it is the only field a text node has", async () => {
        const { hands, written } = handsFor([textSaying(card)]);
        const { answer, text } = await textOf(hands, "set_text", { nodeId: "text-1", text: "夜里的森林。" });
        expect(answer.isError).not.toBe(true);
        expect(written.texts).toEqual([["text-1", "夜里的森林。"]]);
        expect(written.prompts).toEqual([]);
        expect(text).toContain("text-1 now says: 夜里的森林。");
    });

    test("refuses a node whose content is not words, and says what to do instead", async () => {
        const { hands, written } = handsFor([node("image", { content: "/api/canvases/c/files/a.png", prompt: "a brass compass" })]);
        const { answer, text } = await textOf(hands, "set_text", { nodeId: "image-1", text: "a brass compass" });
        expect(answer.isError).toBe(true);
        expect(written.texts).toEqual([]);
        expect(text).toContain("it holds a picture");
        expect(text).toContain("set_prompt");
    });

    test("asks for the words when the call carries none", async () => {
        const { hands } = handsFor([textSaying(card)]);
        const { answer, text } = await textOf(hands, "set_text", { nodeId: "text-1" });
        expect(answer.isError).toBe(true);
        expect(text).toContain("set_text needs text");
    });

    test("answers a node the canvas does not hold", async () => {
        const { hands } = handsFor([]);
        const { answer } = await textOf(hands, "set_text", { nodeId: "text-9", text: "anything" });
        expect(answer.isError).toBe(true);
    });
});

describe("set_prompt: the question a node will be asked", () => {
    test("a text node has no question, so it is refused rather than written somewhere nothing shows", async () => {
        const { hands, written } = handsFor([textSaying(card)]);
        const { answer, text } = await textOf(hands, "set_prompt", { nodeId: "text-1", prompt: "改成夜景。" });
        expect(answer.isError).toBe(true);
        expect(written.prompts).toEqual([]);
        expect(text).toContain("it holds words and has no prompt");
        expect(text).toContain("set_text");
    });

    test("on a picture, it is the words that will make it", async () => {
        const { hands, written } = handsFor([node("image", { content: "/api/canvases/c/files/a.png" })]);
        const { answer } = await textOf(hands, "set_prompt", { nodeId: "image-1", prompt: "a brass compass" });
        expect(answer.isError).not.toBe(true);
        expect(written.prompts).toEqual([["image-1", "a brass compass"]]);
    });
});

describe("read_node: what the node holds", () => {
    test("a text node answers with its words", async () => {
        const { hands } = handsFor([textSaying(card)]);
        const { answer } = await textOf(hands, "read_node", { nodeId: "text-1" });
        expect(answer.content).toEqual([{ type: "text", text: card }]);
    });

    test("a node holding nothing says so rather than inventing words", async () => {
        const { hands } = handsFor([node("text", { prompt: "a brass compass" })]);
        const { answer } = await textOf(hands, "read_node", { nodeId: "text-1" });
        expect(answer.content).toEqual([{ type: "text", text: "text-1 (text) holds nothing to read" }]);
    });
});

describe("generate: pressing a node's button", () => {
    test("a text node generates nothing, and the answer says what does write it", async () => {
        const { hands, written } = handsFor([textSaying(card)]);
        const { answer, text } = await textOf(hands, "generate", { nodeId: "text-1" });
        expect(answer.isError).toBe(true);
        expect(written.generated).toEqual([]);
        expect(text).toContain("nothing generates them");
        expect(text).toContain("set_text");
    });
});

describe("create_node: what this canvas can make", () => {
    test("makes the four content types", async () => {
        for (const type of ["image", "video", "audio", "text"]) {
            const { hands, written } = handsFor([]);
            const answer = await runTool("create_node", { type }, hands, "canvas:test");
            expect(answer.isError).not.toBe(true);
            expect(written.created).toEqual([type]);
        }
    });

    test("refuses a node it cannot fill in, naming what it does make", async () => {
        // A LoRA node needs a file picked in its own panel, which no argument here can supply: the tool used
        // to advertise `lora` and refuse it.
        for (const type of ["lora", "group"]) {
            const { hands, written } = handsFor([]);
            const answer = await runTool("create_node", { type }, hands, "canvas:test");
            expect(answer.isError).toBe(true);
            expect((answer.content[0] as { text: string }).text).toContain("this canvas makes image, video, audio, text");
            expect(written.created).toEqual([]);
        }
    });

    test("a text node's starting words are its body, not its prompt", async () => {
        const { hands } = handsFor([]);
        const seen: CanvasNodeMetadata[] = [];
        hands.createNode = (type, position, patch) => {
            void position;
            seen.push(patch || {});
            return node(type);
        };
        await runTool("create_node", { type: "text", prompt: card }, hands, "canvas:test");
        expect(seen).toEqual([{ content: card }]);
    });
});

/**
 * A tool the page does not know is a page older than its own tools.
 *
 * The list the agent is handed comes from the server and the switch behind it is the page's, so they can be
 * built at different times — which is exactly what happened when `set_text` was answered with "this canvas
 * has no tool called set_text" and the agent spent a conversation working around a tool that existed (#230).
 */
describe("a name this page does not know", () => {
    test("says the page is older than the tool list, not that the tool does not exist", async () => {
        const { hands } = handsFor([]);
        const answer = await runTool("set_node", { nodeId: "text-1", text: "x" }, hands, "canvas:test");

        expect(answer.isError).toBe(true);
        expect((answer.content[0] as { text: string }).text).toContain("the page in front of the user was built before the tool list you were given");
    });
});

/**
 * A press that would carry nothing is refused before it is made.
 *
 * The page refuses it too, but the agent would be told a run is out and then wait for a message that never
 * comes, so the same function is asked here as well (#230).
 */
describe("generate: a wire that carries nothing", () => {
    test("refuses in the page's own words, and starts nothing", async () => {
        const { hands, written } = handsFor([node("text", { content: "" }), node("image", { prompt: "a brass compass" })], [{ id: "c1", fromNodeId: "text-1", toNodeId: "image-1" }]);
        const { answer, text } = await textOf(hands, "generate", { nodeId: "image-1" });

        expect(answer.isError).toBe(true);
        expect(text).toMatch(/^text-1 .*holds nothing yet/);
        expect(written.generated).toEqual([]);
    });

    test("presses when the wire does carry something", async () => {
        const { hands, written } = handsFor([node("text", { content: "a red ceramic teapot" }), node("image", { prompt: "a brass compass" })], [{ id: "c1", fromNodeId: "text-1", toNodeId: "image-1" }]);
        // The page reports the run as soon as it exists; a fake that stays silent would be answered with
        // "no run was reported" after the press timeout, which is a different test.
        hands.generateNode = async (nodeId, mode, prompt, options) => {
            written.generated.push([nodeId, prompt]);
            void mode;
            options?.onStart?.({ started: true, runId: "run-1" });
        };
        const { answer, text } = await textOf(hands, "generate", { nodeId: "image-1" });

        expect(answer.isError).not.toBe(true);
        expect(text).toContain("run run-1 is out");
        expect(written.generated).toEqual([["image-1", "a brass compass"]]);
    });
});

/**
 * `read_prompt` is the pair to `read_node`.
 *
 * A node has two kinds of words and they are not interchangeable: what it holds (the card, the picture,
 * the film — `read_node`) and what it will be asked (the prompt its panel shows — this). The list stopped
 * carrying the second (#233), so this is the one way to it, and its answer says which is which where the
 * two are easiest to confuse.
 */
describe("read_prompt: the question behind a node", () => {
    test("a text node has no prompt, and the answer points at what it does have", async () => {
        const { hands } = handsFor([textSaying(card)]);
        const { answer, text } = await textOf(hands, "read_prompt", { nodeId: "text-1" });

        expect(answer.isError).not.toBe(true);
        expect(text).toContain("has no prompt");
        expect(text).not.toContain(card);
        expect(text).toContain("read_node");
    });

    test("says so when nothing has been asked of a picture", async () => {
        const { hands } = handsFor([node("image", { content: "/api/canvases/c/files/a.png" })]);
        const { answer, text } = await textOf(hands, "read_prompt", { nodeId: "image-1" });

        expect(answer.isError).not.toBe(true);
        expect(text).toContain("has no prompt");
        expect(text).toContain("nothing has been asked of it yet");
    });

    test("answers for a picture too, which has a prompt and no words of its own", async () => {
        const { hands } = handsFor([node("image", { content: "data:image/png;base64,AAAA", prompt: "a brass compass" })]);
        const { text } = await textOf(hands, "read_prompt", { nodeId: "image-1" });

        // Exactly the prompt: a node that was never given a model has nothing to say about what will run.
        expect(text).toBe("a brass compass");
    });

    test("says what the node is set to run, which the words alone cannot", async () => {
        const { hands } = handsFor([node("video", { prompt: "一只猫在雪地里跑", model: "default::video-h3-frames", seconds: "4" })]);
        const { text } = await textOf(hands, "read_prompt", { nodeId: "video-1" });

        expect(text).toBe("一只猫在雪地里跑\nvideo-1 is set to run video-h3-frames, 4 s.");
    });

    test("refuses a node the canvas does not hold", async () => {
        const { hands } = handsFor([]);
        const { answer } = await textOf(hands, "read_prompt", { nodeId: "text-9" });

        expect(answer.isError).toBe(true);
    });
});

// A card's box, which the agent could not see or set at all until now. What matters here is the rule the
// canvas already had: a card that frames a picture is that picture's shape (#264), so it has one degree of
// freedom — and a call that states two numbers contradicting it is refused with the one that fits, rather
// than quietly resized to something the caller did not ask for.
describe("resize_node: the card's box, not a zoom", () => {
    const picture = (naturalWidth: number, naturalHeight: number) => node("image", { content: "/api/canvases/c/files/a.png", naturalWidth, naturalHeight });

    test("a card that frames a picture is told a width, and the height follows", async () => {
        const { hands, written } = handsFor([picture(1920, 1280)]);
        const { answer, text } = await textOf(hands, "resize_node", { nodeId: "image-1", size: { width: 480 } });

        expect(answer.isError).not.toBe(true);
        expect(written.resized).toEqual([["image-1", 480, 320]]);
        // The answer is the box it now occupies, because the number asked for is not always the number set.
        expect(text).toContain("480×320");
        expect(text).toContain("1920×1280");
    });

    test("a pair that contradicts the picture's shape is refused, with the height that fits", async () => {
        const { hands, written } = handsFor([picture(1920, 1280)]);
        const { answer, text } = await textOf(hands, "resize_node", { nodeId: "image-1", size: { width: 480, height: 200 } });

        expect(answer.isError).toBe(true);
        expect(written.resized).toEqual([]);
        expect(text).toContain("320");
    });

    test("a card of words takes both numbers, and keeps its height when only one is given", async () => {
        const { hands, written } = handsFor([textSaying(card)]);
        await textOf(hands, "resize_node", { nodeId: "text-1", size: { width: 400, height: 700 } });
        await textOf(hands, "resize_node", { nodeId: "text-1", size: { width: 500 } });

        expect(written.resized).toEqual([
            ["text-1", 400, 700],
            ["text-1", 500, 240],
        ]);
    });

    test("the floor is refused and named, and it is not the same number on both sides", async () => {
        // A 3:2 card cannot go under the height floor, so its narrowest width is 240 rather than 220 — the same
        // clamp the corner drag applies.
        const tall = handsFor([picture(1920, 1280)]);
        const refused = await textOf(tall.hands, "resize_node", { nodeId: "image-1", size: { width: 200 } });
        expect(refused.answer.isError).toBe(true);
        expect(refused.text).toContain("240");

        const free = handsFor([textSaying(card)]);
        const small = await textOf(free.hands, "resize_node", { nodeId: "text-1", size: { width: 200, height: 120 } });
        expect(small.answer.isError).toBe(true);
        expect(small.text).toContain("220×160");
        expect(free.written.resized).toEqual([]);
    });

    test("asks for the size when the call carries none, and answers a node it does not hold", async () => {
        const { hands } = handsFor([textSaying(card)]);
        const missing = await textOf(hands, "resize_node", { nodeId: "text-1" });
        expect(missing.answer.isError).toBe(true);
        expect(missing.text).toContain("resize_node needs a size");

        const unknown = await textOf(hands, "resize_node", { nodeId: "text-9", size: { width: 400 } });
        expect(unknown.answer.isError).toBe(true);
    });
});
