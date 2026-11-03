import { describe, expect, test } from "vitest";

import { parseInline, parseMarkdown, type MarkdownBlock, type MarkdownInline } from "../src/lib/markdown";

/**
 * The Markdown an answer is drawn from (#237).
 *
 * The subset is what a model writes, and the cases that matter are the ones a plain `pre-wrap` paragraph
 * got wrong: a table (it printed the pipes), a fence with no closing line (an answer arrives a word at a
 * time), a name with an underscore in it (`snake_case` is not emphasis), and anything that would have
 * become a tag — nothing here ever produces HTML, so the only thing to check is that it stays text.
 */

/** Every inline token's words, in order, so a test can read a line without walking the tree. */
function flat(tokens: MarkdownInline[]): string {
    return tokens.map((token) => (token.kind === "text" || token.kind === "code" ? token.text : flat(token.tokens))).join("");
}

function kinds(tokens: MarkdownInline[]): string[] {
    return tokens.map((token) => token.kind);
}

const kindsOf = (blocks: MarkdownBlock[]) => blocks.map((block) => block.kind);

describe("an answer, in blocks", () => {
    test("a blank line separates paragraphs, and a single newline stays in one", () => {
        const blocks = parseMarkdown("first line\nsecond line\n\nnext paragraph");
        expect(kindsOf(blocks)).toEqual(["paragraph", "paragraph"]);
        expect(blocks[0]).toEqual({ kind: "paragraph", lines: ["first line", "second line"] });
        expect(blocks[1]).toEqual({ kind: "paragraph", lines: ["next paragraph"] });
    });

    test("a heading is a level and its words, and the closing hashes are decoration", () => {
        expect(parseMarkdown("## Steps ##")).toEqual([{ kind: "heading", level: 2, text: "Steps" }]);
        expect(parseMarkdown("###### deep")).toEqual([{ kind: "heading", level: 6, text: "deep" }]);
        // No space means it is not a heading: `#hashtag` is a word.
        expect(parseMarkdown("#hashtag")[0].kind).toBe("paragraph");
    });

    test("a fenced block keeps every character, because a code block is not prose", () => {
        const [block] = parseMarkdown("```\n**not bold** and | pipes |\n\n  indented\n```");
        expect(block).toEqual({ kind: "code", text: "**not bold** and | pipes |\n\n  indented" });
    });

    test("a fence with no closing line yet is the code written so far, not a broken answer", () => {
        // What a half-streamed answer looks like: the model has opened a block and is still typing in it.
        expect(parseMarkdown("before\n\n```js\nconst a = 1;")).toEqual([
            { kind: "paragraph", lines: ["before"] },
            { kind: "code", text: "const a = 1;" },
        ]);
    });

    test("a rule is a rule, even though `- - -` also reads as a bullet", () => {
        expect(kindsOf(parseMarkdown("---\n\n***\n\n- - -"))).toEqual(["rule", "rule", "rule"]);
    });

    test("a quote is a document of its own, one level in", () => {
        const [block] = parseMarkdown("> quoted **words**\n> second line");
        expect(block.kind).toBe("quote");
        if (block.kind !== "quote") return;
        expect(block.blocks).toEqual([{ kind: "paragraph", lines: ["quoted **words**", "second line"] }]);
    });
});

describe("a list", () => {
    test("a bullet item owns the lines indented under it, and a nested list sits inside it", () => {
        const [block] = parseMarkdown("- first line\n  second line\n  - nested\n- second item");
        expect(block.kind).toBe("list");
        if (block.kind !== "list") return;
        expect(block.ordered).toBe(false);
        expect(block.items).toHaveLength(2);
        expect(block.items[0]).toEqual([
            { kind: "paragraph", lines: ["first line", "second line"] },
            { kind: "list", ordered: false, start: 1, items: [[{ kind: "paragraph", lines: ["nested"] }]] },
        ]);
        expect(block.items[1]).toEqual([{ kind: "paragraph", lines: ["second item"] }]);
    });

    test("a blank line between items is a loose list, not the end of it", () => {
        const [block] = parseMarkdown("1. one\n\n2. two");
        expect(block).toEqual({ kind: "list", ordered: true, start: 1, items: [[{ kind: "paragraph", lines: ["one"] }], [{ kind: "paragraph", lines: ["two"] }]] });
    });

    test("an ordered list keeps the number it starts on", () => {
        const [block] = parseMarkdown("3. three\n4. four");
        expect(block).toMatchObject({ kind: "list", ordered: true, start: 3 });
    });

    test("what comes after the list is not swallowed by it", () => {
        const blocks = parseMarkdown("- item\n\nA paragraph under the list.");
        expect(kindsOf(blocks)).toEqual(["list", "paragraph"]);
        expect(blocks[1]).toEqual({ kind: "paragraph", lines: ["A paragraph under the list."] });
    });
});

describe("a table", () => {
    const table = "| model | speed | note |\n| :--- | :---: | ---: |\n| turbo | 12 steps | fast |\n| base | 30 steps | slow |";

    test("columns, alignment and rows, with the second line as the only thing that makes it a table", () => {
        expect(parseMarkdown(table)).toEqual([
            {
                kind: "table",
                align: ["left", "center", "right"],
                header: ["model", "speed", "note"],
                rows: [
                    ["turbo", "12 steps", "fast"],
                    ["base", "30 steps", "slow"],
                ],
            },
        ]);
    });

    test("the outer pipes are optional, and an escaped pipe is a character in the cell", () => {
        const [block] = parseMarkdown("a | b\n--- | ---\nx \\| y | z");
        expect(block).toMatchObject({ kind: "table", header: ["a", "b"], rows: [["x | y", "z"]] });
    });

    test("a short row is padded, so a table the model wrote unevenly still lines up", () => {
        const [block] = parseMarkdown("| a | b |\n| --- | --- |\n| 1 |");
        expect(block).toMatchObject({ kind: "table", rows: [["1", ""]] });
    });

    test("a cell holds inline Markdown, because a cell is text like any other", () => {
        const [block] = parseMarkdown("| a |\n| --- |\n| **bold** and `code` |");
        expect(block.kind).toBe("table");
        if (block.kind !== "table") return;
        expect(kinds(parseInline(block.rows[0][0]))).toEqual(["strong", "text", "code"]);
    });

    test("a header with no column marks under it stays a paragraph — the pipes are just characters", () => {
        expect(kindsOf(parseMarkdown("| a | b |\nnot a delimiter row"))).toEqual(["paragraph"]);
        // And a delimiter row of the wrong width is not this table's: taking it would eat the text below.
        expect(kindsOf(parseMarkdown("| a | b |\n| --- |"))).toEqual(["paragraph"]);
    });

    test("a table inside a fence is code", () => {
        expect(kindsOf(parseMarkdown("```\n| a | b |\n| --- | --- |\n```"))).toEqual(["code"]);
    });
});

describe("inline", () => {
    test("a strong run, an emphasised one and a struck one", () => {
        expect(parseInline("**bold** *soft* ~~gone~~")).toEqual([
            { kind: "strong", tokens: [{ kind: "text", text: "bold" }] },
            { kind: "text", text: " " },
            { kind: "em", tokens: [{ kind: "text", text: "soft" }] },
            { kind: "text", text: " " },
            { kind: "strike", tokens: [{ kind: "text", text: "gone" }] },
        ]);
    });

    test("a code span is literal, and a longer run holds a shorter one", () => {
        expect(parseInline("`no **bold** here`")).toEqual([{ kind: "code", text: "no **bold** here" }]);
        // Two backticks close on two, which is how one backtick fits inside a span.
        expect(parseInline("``a ` b``")).toEqual([{ kind: "code", text: "a ` b" }]);
    });

    test("a name with underscores is a name", () => {
        expect(parseInline("call get_input_summary(node)")).toEqual([{ kind: "text", text: "call get_input_summary(node)" }]);
    });

    test("an emphasis that starts with a space is not one, which is what keeps arithmetic arithmetic", () => {
        expect(flat(parseInline("a * b * c"))).toBe("a * b * c");
        expect(kinds(parseInline("a * b * c"))).toEqual(["text"]);
    });

    test("a half-streamed delimiter stays the characters that arrived", () => {
        expect(parseInline("**bold")).toEqual([{ kind: "text", text: "**bold" }]);
        expect(parseInline("a `code")).toEqual([{ kind: "text", text: "a `code" }]);
    });

    test("an escape takes back the character", () => {
        expect(parseInline("\\*not emphasis\\* and \\`not code\\`")).toEqual([{ kind: "text", text: "*not emphasis* and `not code`" }]);
    });

    test("a link opens what it says it opens, and nothing else", () => {
        expect(parseInline("[docs](https://example.com/a)")).toEqual([{ kind: "link", href: "https://example.com/a", tokens: [{ kind: "text", text: "docs" }] }]);
        // A scheme we would not open is shown as the characters it was written as, not as a dead link.
        expect(parseInline("[click](javascript:alert)")).toEqual([{ kind: "text", text: "[click](javascript:alert)" }]);
    });

    test("raw HTML is characters, because nothing here ever produces markup", () => {
        expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([{ kind: "text", text: "<img src=x onerror=alert(1)>" }]);
    });
});
