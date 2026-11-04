import { describe, expect, test } from "vitest";

import { runTool, type CanvasHands } from "../src/lib/canvas/canvas-agent-tools";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata } from "../src/types/canvas";

/**
 * The tools the agent may call, and what each one writes.
 *
 * These are decisions rather than wiring, so they are called here the way the page calls them: a name, the
 * arguments as they arrived, the hands the page lends, and a session to answer on. What the fix behind
 * them has to hold is one thing above all: a text node's prompt is the question it will answer and its
 * content is the answer it gave, so `set_prompt` must never be mistaken for "change the text" (#229).
 */

function node(type: CanvasNodeData["type"], metadata: CanvasNodeMetadata = {}): CanvasNodeData {
    return { id: `${type}-1`, type, title: `${type}-1`, position: { x: 0, y: 0 }, width: 320, height: 240, metadata };
}

/** The page's hands, with every write recorded instead of performed. */
function handsFor(nodes: CanvasNodeData[], connections: CanvasConnection[] = []) {
    const written = { prompts: [] as Array<[string, string]>, texts: [] as Array<[string, string]>, generated: [] as Array<[string, string]>, created: [] as string[] };
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
    };
    return { hands, written };
}

const card = "宫崎骏风格的森林。";
const question = "宫崎骏风格的森林场景，无文字，无字幕，无对话气泡";
const textSaying = (content: string, composerContent?: string) => node("text", { content, ...(composerContent ? { composerContent } : {}) });

const textOf = async (hands: CanvasHands, name: string, args: Record<string, unknown>) => {
    const answer = await runTool(name, args, hands, "canvas:test");
    return { answer, text: (answer.content[0] as { text: string }).text };
};

describe("set_text: writing what the card says", () => {
    test("writes the text itself, and leaves the question alone", async () => {
        const { hands, written } = handsFor([textSaying(card, question)]);
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

describe("set_prompt: the question, and where it stops being one", () => {
    test("on a text node holding its answer, it says the text is unchanged", async () => {
        const { hands, written } = handsFor([textSaying(card, question)]);
        const { text } = await textOf(hands, "set_prompt", { nodeId: "text-1", prompt: "改成夜景。" });
        expect(written.prompts).toEqual([["text-1", "改成夜景。"]]);
        expect(text).toContain("not its text");
        expect(text).toContain("set_text");
    });

    test("on a node that says nothing yet, it is the whole story", async () => {
        const { hands } = handsFor([node("image", { content: "/api/canvases/c/files/a.png" })]);
        const { text } = await textOf(hands, "set_prompt", { nodeId: "image-1", prompt: "a brass compass" });
        expect(text).not.toContain("not its text");
    });
});

describe("read_node: what the node holds", () => {
    test("a text node answers with its card, not with the question that made it", async () => {
        const { hands } = handsFor([textSaying(card, question)]);
        const { answer } = await textOf(hands, "read_node", { nodeId: "text-1" });
        expect(answer.content).toEqual([{ type: "text", text: card }]);
    });

    test("a batch answers with every text, the card's own first", async () => {
        const batch = node("text", {
            content: "second",
            primaryTextId: "t2",
            texts: [
                { id: "t1", status: "success", content: "first" },
                { id: "t2", status: "success", content: "second" },
            ],
        });
        const { hands } = handsFor([batch]);
        const { answer } = await textOf(hands, "read_node", { nodeId: "text-1" });
        expect(answer.content).toEqual([
            { type: "text", text: "second" },
            { type: "text", text: "first" },
        ]);
    });

    test("a node holding nothing says so rather than inventing words", async () => {
        const { hands } = handsFor([node("text", { prompt: "a brass compass" })]);
        const { answer } = await textOf(hands, "read_node", { nodeId: "text-1" });
        expect(answer.content).toEqual([{ type: "text", text: "text-1 (text) holds nothing to read" }]);
    });
});

describe("generate: the words that were asked", () => {
    test("a text node is asked its question, never handed its own answer to rewrite", async () => {
        // The panel's box is what gets run. Passing the card instead would ask the node to answer its own
        // text, which is the same confusion this fix is about, one tool further in.
        const { hands, written } = handsFor([textSaying(card, question)]);
        await runTool("generate", { nodeId: "text-1" }, hands, "canvas:test");
        expect(written.generated).toEqual([["text-1", question]]);
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
 * The page refuses it too, and a picture's refusal comes back through the press (`pressAndWait`). A text
 * node's does not: it streams, so there is no run id to report and the agent would be told an answer is on
 * its way. One function answers "what would this wire carry", asked here as well (#230).
 */
describe("generate: a wire that carries nothing", () => {
    test("refuses in the page's own words, and starts nothing", async () => {
        const { hands, written } = handsFor([node("text", { content: "" }), node("image", { prompt: "a brass compass" })], [{ id: "c1", fromNodeId: "text-1", toNodeId: "image-1" }]);
        const { answer, text } = await textOf(hands, "generate", { nodeId: "image-1" });

        expect(answer.isError).toBe(true);
        expect(text).toMatch(/^text-1 .*holds nothing yet/);
        expect(written.generated).toEqual([]);
    });

    test("refuses a text node's press the same way, because that press reports nothing back", async () => {
        const { hands, written } = handsFor([node("image", {}), node("text", { prompt: "write about the forest" })], [{ id: "c1", fromNodeId: "image-1", toNodeId: "text-1" }]);
        const { answer, text } = await textOf(hands, "generate", { nodeId: "text-1" });

        expect(answer.isError).toBe(true);
        expect(text).toMatch(/^image-1 .*holds nothing yet/);
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
    test("answers with the words the panel shows, and says what they are", async () => {
        const { hands } = handsFor([textSaying(card, question)]);
        const { answer, text } = await textOf(hands, "read_prompt", { nodeId: "text-1" });

        expect(answer.isError).not.toBe(true);
        expect(text).toContain(question);
        expect(text).toContain("the question it will answer next");
        // The card is the other kind of words, and the answer points at the tool that reads it.
        expect(text).not.toContain(card);
        expect(text).toContain("read_node");
    });

    test("says so when nothing has been asked of the node", async () => {
        const { hands } = handsFor([textSaying(card)]);
        const { answer, text } = await textOf(hands, "read_prompt", { nodeId: "text-1" });

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
