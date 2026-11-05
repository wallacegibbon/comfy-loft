import { describe, expect, test } from "vitest";

import { runTool, type CanvasHands } from "../src/lib/canvas/canvas-agent-tools";
import type { GenerateStart } from "../src/lib/canvas/agent-generate";
import { registerBuiltinNodes } from "../src/components/canvas/nodes/builtin-nodes";
import type { SettingsContract } from "../src/lib/canvas/node-settings";
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
function handsFor(nodes: CanvasNodeData[], connections: CanvasConnection[] = [], contract: SettingsContract = {}) {
    const written = {
        prompts: [] as Array<[string, string]>,
        texts: [] as Array<[string, string]>,
        generated: [] as Array<[string, string]>,
        created: [] as string[],
        resized: [] as Array<[string, number, number]>,
        moved: [] as Array<[string, { x: number; y: number }]>,
        grouped: [] as string[][],
        ungrouped: [] as string[][],
        settings: [] as Array<[string, CanvasNodeMetadata]>,
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
        moveNode: (nodeId, position) => void written.moved.push([nodeId, position]),
        resizeNode: (nodeId, width, height) => void written.resized.push([nodeId, width, height]),
        // The real hands group through `applyGroupSelection`, which is the canvas's own rule and tested
        // where it lives; what these have to answer is only what the tool reports back.
        groupNodes: (nodeIds) => {
            written.grouped.push(nodeIds);
            return nodeIds.length < 2 ? null : { groupId: "group-1", memberIds: nodeIds };
        },
        ungroupNodes: (nodeIds) => {
            written.ungrouped.push(nodeIds);
            const dissolved = nodes.filter((each) => nodeIds.includes(each.id) && each.type === "group").map((each) => each.id);
            const released = nodes.filter((each) => (nodeIds.includes(each.id) ? Boolean(each.metadata?.groupId) : dissolved.includes(each.metadata?.groupId || ""))).map((each) => each.id);
            return dissolved.length || released.length ? { released, dissolved } : null;
        },
        // The published contract is the page's to read and the panel's to ask; what these answer is only
        // whether a setting is written and how the answer reads.
        nodeContract: () => contract,
        writeSettings: (nodeId, patch) => void written.settings.push([nodeId, patch]),
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

    /**
     * One press, one word (#285).
     *
     * The rule the four cases below state from four sides: an agent that believes a run is out has to be
     * told how that run ended, and an agent that was told "still setting up" has to be told too — a turn
     * waiting on a message that never comes has no way to continue, and nobody is watching the canvas to
     * notice. So the answer is either "a run exists" (the server will say how it went) or "it did not start"
     * (said now), and the only case that leaves a promise open is the one that states the promise.
     */
    describe("one press, one word", () => {
        const picture = () => node("image", { prompt: "a rabbit" });
        /** Press a picture, and let the test decide when and how the page reports. */
        const pressing = (report: (say: (start: GenerateStart) => void) => Promise<void>) => {
            const { hands, written } = handsFor([picture()]);
            hands.generateNode = async (nodeId, mode, prompt, options) => {
                written.generated.push([nodeId, prompt]);
                void mode;
                await report((start) => options?.onStart?.(start));
            };
            return { hands, written };
        };

        test("a run is answered as a run: it is out, and the server will say how it went", async () => {
            const { hands } = pressing(async (say) => say({ started: true, runId: "task_6f2c" }));
            const { answer, text } = await textOf(hands, "generate", { nodeId: "image-1" });
            expect(answer.isError).not.toBe(true);
            expect(text).toContain("task_6f2c");
            expect(text).toContain("you will be sent a message");
        });

        test("a refusal is answered with the page's own reason, and promises nothing", async () => {
            const { hands } = pressing(async (say) => say({ started: false, reason: "workflow image-z-image-turbo requires a non-empty prompt" }));
            const { answer, text } = await textOf(hands, "generate", { nodeId: "image-1" });
            expect(answer.isError).toBe(true);
            expect(text).toContain("requires a non-empty prompt");
            expect(text).toContain("did not start");
            // Nothing is promised, because nothing is coming: the answer is the press's own word (#285).
            expect(text).not.toContain("will be sent");
        });
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
        // to advertise `lora` and refuse it. A group is no longer refused this way — it holds nodes rather
        // than content, and the menu makes one too (#292).
        const { hands, written } = handsFor([]);
        const answer = await runTool("create_node", { type: "lora" }, hands, "canvas:test");
        expect(answer.isError).toBe(true);
        expect((answer.content[0] as { text: string }).text).toContain("this canvas makes image, video, audio, text, group");
        expect(written.created).toEqual([]);
    });

    test("makes a group, and refuses to put words in it", async () => {
        // The container the menu can make: empty, and asking it anything is a call with no field behind it.
        const empty = handsFor([]);
        const made = await runTool("create_node", { type: "group" }, empty.hands, "canvas:test");
        expect(made.isError).not.toBe(true);
        expect(empty.written.created).toEqual(["group"]);

        const asked = handsFor([]);
        const refused = await textOf(asked.hands, "create_node", { type: "group", prompt: card });
        expect(refused.answer.isError).toBe(true);
        expect(refused.text).toContain("a group is a container");
        expect(refused.text).toContain("group_nodes");
        expect(asked.written.created).toEqual([]);
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

/** A node with the id the test needs, since the group tools are about ids and relations between them. */
const placed = (id: string, type: CanvasNodeData["type"], metadata: CanvasNodeMetadata = {}): CanvasNodeData => ({ ...node(type, metadata), id });

/**
 * The settings a run's shape is made of: the size, the length, the seed, the knobs.
 *
 * The tool writes what the node's panel writes and answers with the node's own clause, so what an agent is
 * told afterwards is what `read_prompt` would say. What is checked here is the wiring — the plan's refusals
 * and the field each setting names are `planNodeSettings`'s, tested where it lives (#309).
 */
describe("set_node_settings: how a node is set to run", () => {
    const picture = (metadata: CanvasNodeMetadata = {}) => placed("image-1", "image", metadata);

    test("writes the settings the plan settled on, and answers with the node's own clause", async () => {
        const { hands, written } = handsFor([picture()], [], { accepts: ["size", "seed"] });
        const { answer, text } = await textOf(hands, "set_node_settings", { nodeId: "image-1", size: "1024x1024", seed: 42 });

        expect(answer.isError).not.toBe(true);
        expect(written.settings).toEqual([["image-1", { size: "1024x1024", seed: "42", seedFixed: "true" }]]);
        // The clause is the read-back: the node as its next run would see it.
        expect(text).toBe("set size 1024x1024, seed 42 on image-1; it is now size 1024x1024, seed 42");
    });

    test("a key the workflow does not read is refused, and nothing is written", async () => {
        const { hands, written } = handsFor([picture()], [], { accepts: ["seed"] });
        const { answer, text } = await textOf(hands, "set_node_settings", { nodeId: "image-1", size: "1024x1024" });

        expect(answer.isError).toBe(true);
        expect(written.settings).toEqual([]);
        expect(text).toContain("size means nothing to this workflow");
        expect(text).toContain("seed");
    });

    test("a node it does not hold, and a node kind that has no run to configure", async () => {
        const { hands } = handsFor([textSaying(card)], [], { accepts: ["size"] });
        const unknown = await textOf(hands, "set_node_settings", { nodeId: "image-9", size: "1024x1024" });
        expect(unknown.answer.isError).toBe(true);

        const words = await textOf(hands, "set_node_settings", { nodeId: "text-1", size: "1024x1024" });
        expect(words.answer.isError).toBe(true);
        expect(words.text).toContain("its words");
    });
});

/**
 * Moving a group, which is a move of the card and of what it holds.
 *
 * The tool states one card, so a group's members came along only in the drag — an agent tidying a group
 * scattered it instead, leaving the box behind and its members where they were. The answer says how many
 * travelled, because that is the difference between moving a group and moving a box (docs/decisions.md #308).
 */
describe("move_node: what a move carries", () => {
    test("a group's card takes its members with it, and the answer says how many", async () => {
        const { hands, written } = handsFor([placed("group-1", "group"), placed("text-1", "text", { groupId: "group-1" }), placed("image-1", "image", { groupId: "group-1" }), placed("loose", "text")]);
        const { answer, text } = await textOf(hands, "move_node", { nodeId: "group-1", position: { x: 640, y: 320 } });

        expect(answer.isError).not.toBe(true);
        // The corner is what the tool states; the members are the canvas's own rule, one call behind it.
        expect(written.moved).toEqual([["group-1", { x: 640, y: 320 }]]);
        expect(text).toBe("moved group-1 (group) and its 2 members to (640, 320)");
    });

    test("a plain node moves alone and says so", async () => {
        const { hands } = handsFor([placed("text-1", "text", { groupId: "group-1" }), placed("group-1", "group")]);
        const { text } = await textOf(hands, "move_node", { nodeId: "text-1", position: { x: 10, y: 20 } });
        expect(text).toBe("moved text-1 (text) to (10, 20)");
    });
});
/**
 * The two structure tools: a group holds nodes, so these describe a relation rather than a node.
 *
 * What is checked here is the answer and the three refusals — a single node, a set that is already one
 * group, and ids the canvas does not hold. Which nodes end up in which card is `applyGroupSelection`'s
 * business, tested where it lives.
 */
describe("group_nodes: putting nodes in one card", () => {
    test("hands the ids to the canvas, and says what was wrapped", async () => {
        const { hands, written } = handsFor([placed("image-1", "image"), placed("text-1", "text")]);
        const { answer, text } = await textOf(hands, "group_nodes", { nodeIds: ["image-1", "text-1"] });
        expect(answer.isError).not.toBe(true);
        expect(written.grouped).toEqual([["image-1", "text-1"]]);
        expect(text).toBe("grouped image-1, text-1 into group-1");
    });

    test("refuses one node: a group holds at least two", async () => {
        const { hands } = handsFor([placed("image-1", "image")]);
        const { answer, text } = await textOf(hands, "group_nodes", { nodeIds: ["image-1"] });
        expect(answer.isError).toBe(true);
        expect(text).toContain("nothing was grouped");
        expect(text).toContain("a group holds at least two");
    });

    test("refuses a set that is already one group, and names that group", async () => {
        // A second card around the same nodes is the same thing drawn twice, so the answer points at the
        // group they are in and at the two ways forward instead of making another one.
        const { hands, written } = handsFor([placed("image-1", "image", { groupId: "group-9" }), placed("text-1", "text", { groupId: "group-9" })]);
        const { answer, text } = await textOf(hands, "group_nodes", { nodeIds: ["image-1", "text-1"] });
        expect(answer.isError).toBe(true);
        expect(text).toContain("already one group (group-9)");
        expect(text).toContain("ungroup_nodes");
        expect(written.grouped).toEqual([]);
    });

    test("asks for the ids, and answers an id the canvas does not hold", async () => {
        const { hands } = handsFor([placed("image-1", "image"), placed("text-1", "text")]);
        const none = await textOf(hands, "group_nodes", {});
        expect(none.answer.isError).toBe(true);
        expect(none.text).toContain("group_nodes needs nodeIds");

        const unknown = await textOf(hands, "group_nodes", { nodeIds: ["image-1", "ghost"] });
        expect(unknown.answer.isError).toBe(true);
        expect(unknown.text).toContain('no node with id "ghost"');
    });
});

describe("ungroup_nodes: letting nodes out", () => {
    test("dissolving a group releases its members and says the card is gone", async () => {
        const { hands, written } = handsFor([placed("group-1", "group"), placed("image-1", "image", { groupId: "group-1" }), placed("text-1", "text", { groupId: "group-1" })]);
        const { answer, text } = await textOf(hands, "ungroup_nodes", { nodeIds: ["group-1"] });
        expect(answer.isError).not.toBe(true);
        expect(written.ungrouped).toEqual([["group-1"]]);
        expect(text).toBe("released image-1, text-1; removed group-1");
    });

    test("taking one node out leaves the group standing", async () => {
        const { hands } = handsFor([placed("group-1", "group"), placed("image-1", "image", { groupId: "group-1" })]);
        const { text } = await textOf(hands, "ungroup_nodes", { nodeIds: ["image-1"] });
        expect(text).toBe("released image-1");
    });

    test("refuses a node that is in no group", async () => {
        const { hands } = handsFor([placed("image-1", "image")]);
        const { answer, text } = await textOf(hands, "ungroup_nodes", { nodeIds: ["image-1"] });
        expect(answer.isError).toBe(true);
        expect(text).toContain("not in a group");
    });

    test("asks for the ids, and answers an id the canvas does not hold", async () => {
        const { hands } = handsFor([placed("image-1", "image")]);
        const none = await textOf(hands, "ungroup_nodes", {});
        expect(none.answer.isError).toBe(true);
        expect(none.text).toContain("ungroup_nodes needs nodeIds");

        const unknown = await textOf(hands, "ungroup_nodes", { nodeIds: ["ghost"] });
        expect(unknown.answer.isError).toBe(true);
        expect(unknown.text).toContain('no node with id "ghost"');
    });
});
