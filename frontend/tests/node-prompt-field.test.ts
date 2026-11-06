import { describe, expect, test } from "vitest";

import { nodeContentOf, nodePromptOf, nodeWords, promptPatch } from "../src/lib/canvas/node-prompt-field";
import type { CanvasNodeData, CanvasNodeMetadata } from "../src/types/canvas";

/**
 * A node's words: what it holds, and where an instruction goes.
 *
 * These used to be one function with a chain of fallbacks (`composerContent ?? prompt ?? content ??
 * texts[0]`), which answered "what does this node say" with the question that was asked to make it. On a
 * picture that is invisible — the picture travels in the same answer — and on a text node it was the whole
 * problem: the agent could read the prompt box and never the card, so that is what it wrote when it was
 * asked to change the text (#229).
 *
 * A text node has since lost the question altogether (#278): it holds words and nothing asks it anything,
 * so it answers `""` for a prompt and every writer of one refuses it.
 */

function node(type: CanvasNodeData["type"], metadata: CanvasNodeMetadata = {}): CanvasNodeData {
    return { id: `${type}-1`, type, position: { x: 0, y: 0 }, width: 320, height: 240, metadata };
}

const card = "宫崎骏风格的森林。";
const question = "宫崎骏风格的森林场景，无文字，无字幕，无对话气泡";

describe("what a node holds", () => {
    test("a text node's content is its card, and it is all it has", () => {
        const text = node("text", { content: card });
        expect(nodeContentOf(text)).toBe(card);
        expect(nodePromptOf(text)).toBe("");
    });

    test("a picture, a film or a sound holds no words at all", () => {
        for (const type of ["image", "video", "audio"] as const) {
            const media = node(type, { content: "/api/canvases/c/files/a.png", prompt: "a brass compass" });
            expect(nodeContentOf(media)).toBe("");
            expect(nodePromptOf(media)).toBe("a brass compass");
        }
    });

    test("a file nothing asked for has no words — the URL it is served from is not one", () => {
        // An imported picture (or a crop, or a drawn mask) has content and no prompt. The old chain fell
        // through to `content`, so `read_node` answered with `/api/canvases/…/files/a.png` and `list_nodes`
        // printed it as the node's prompt.
        const imported = node("image", { content: "/api/canvases/349b70cf4764/files/task_ab12.png" });
        expect(nodeContentOf(imported)).toBe("");
        expect(nodePromptOf(imported)).toBe("");
    });
});

/** The field an instruction lands in: the one thing `promptPatch` writes. */
function instructionField(target: CanvasNodeData): string {
    return Object.keys(promptPatch(target, "words"))[0];
}

describe("whether a node holds a result", () => {
    test("every content type answers the same way", () => {
        // It used to be a whitelist of text and image, so a film or a sound — which hold a result just as
        // plainly — kept the next instruction in `prompt` and lost the words that made them (#229).
        for (const type of ["text", "image", "video", "audio"] as const) {
            expect(instructionField(node(type, { content: "something" }))).toBe("composerContent");
            expect(instructionField(node(type))).toBe("prompt");
        }
    });

    test("a text node holding only whitespace holds nothing", () => {
        expect(instructionField(node("text", { content: "   \n " }))).toBe("prompt");
    });

    test("a node that carries no content of its own never holds one", () => {
        expect(instructionField(node("group"))).toBe("prompt");
    });
});

describe("finding a node by its words", () => {
    test("the card's words are searchable, and so is a picture's question", () => {
        const text = node("text", { content: card });
        expect(nodeWords(text)).toContain(card);
        // A node has no name to search by: what a search finds is the words it holds or was asked (#321).
        expect(nodeWords(node("image", { prompt: question }))).toContain(question);
    });

    test("a picture contributes its prompt and not its file name", () => {
        expect(nodeWords(node("image", { content: "/api/canvases/c/files/task_ab12.png", prompt: "a brass compass" }))).not.toContain("png");
    });
});
