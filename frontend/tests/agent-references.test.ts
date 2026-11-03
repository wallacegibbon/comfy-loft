import { describe, expect, it } from "vitest";

import { citationLabel, mentionResolver, referenceBlock, referenceEntries, referenceLine, withoutReferences } from "@/lib/canvas/agent-references";

/**
 * The block is plumbing that the agent needs and the reader does not. These check the two directions
 * against each other: whatever the canvas puts in front of a prompt is exactly what comes off again — and
 * that two nodes which happen to share a name stay two nodes (#162).
 */

describe("canvas references", () => {
    it("takes the block it built off again, in either language", () => {
        const lines = [referenceLine("lPiENyy6iXVTwtTVDzd7M", "image", "补全背景", "补全背景")];
        for (const marker of ["【画布引用】", "[Canvas references]"]) {
            expect(withoutReferences(referenceBlock(marker, lines) + "@补全背景 描述一下这张图片的背景。")).toBe("@补全背景 描述一下这张图片的背景。");
        }
    });

    it("takes off a block written in the other language than the UI is in now", () => {
        const prompt = referenceBlock("【画布引用】", ["- n1 (image) 图: 一只猫"]) + "再生成一张";
        expect(withoutReferences(prompt)).toBe("再生成一张");
    });

    it("leaves a prompt that never had a block exactly as it is", () => {
        expect(withoutReferences("@补全背景 描述一下这张图片的背景。")).toBe("@补全背景 描述一下这张图片的背景。");
        expect(withoutReferences("look at 【画布引用】 in the middle")).toBe("look at 【画布引用】 in the middle");
    });

    it("leaves a marker without its blank line alone rather than guessing where the words start", () => {
        const cut = "【画布引用】\n- n1 (image) x: y\n没有空行的一句话";
        expect(withoutReferences(cut)).toBe(cut);
    });

    it("reads the cited nodes back, so a mention can be a link", () => {
        const block = referenceBlock("【画布引用】", [referenceLine("lPiENyy6iXVTwtTVDzd7M", "image", "补全背景", "补全背景"), referenceLine("n2", "text", "第二章的开头", "正文")]);
        expect(referenceEntries(block + "@补全背景 描述一下")).toEqual([
            { id: "lPiENyy6iXVTwtTVDzd7M", label: "补全背景" },
            { id: "n2", label: "第二章的开头" },
        ]);
        expect(referenceEntries("没有引用块的一句话")).toEqual([]);
        // A label containing the separator costs the tail of the label in the match, never the id: the line is
        // still readable, and the link still knows which node it points at.
        expect(referenceEntries(referenceBlock("【画布引用】", [referenceLine("n3", "text", "第二章: 开头", "正文")]))).toEqual([{ id: "n3", label: "第二章" }]);
    });

    it("builds no block when nothing is cited", () => {
        expect(referenceBlock("【画布引用】", [])).toBe("");
    });
});

describe("citationLabel", () => {
    it("keeps the name while it is the only one, and numbers the second of the same name", () => {
        expect(citationLabel("图片", [])).toBe("图片");
        expect(citationLabel("图片", ["图片"])).toBe("图片 2");
        expect(citationLabel("图片", ["图片", "图片 2"])).toBe("图片 3");
    });

    it("fills the first free number, so a node genuinely called `图片 2` is not stepped on", () => {
        // A node's own name is a name, not a gap in the numbering.
        expect(citationLabel("图片", ["图片", "图片 3"])).toBe("图片 2");
    });
});

describe("mentionSegments", () => {
    /** The resolver is prepared once per message and asked once per run of text; this is one run. */
    const mentionSegments = (text: string, citations: { id: string; label: string }[], nodes: { id: string; label: string }[]) => mentionResolver(citations, nodes)(text);

    const nodes = [
        { id: "image-1", label: "图片" },
        { id: "image-2", label: "图片" },
    ];

    it("sends two citations that read the same to the two nodes they cited", () => {
        // The bug: both links followed the name, so both went to the first node called `图片`.
        const text = "@图片 把这张的背景补一下，参考 @图片 2 的色调";
        const citations = [
            { id: "image-1", label: "图片" },
            { id: "image-2", label: "图片 2" },
        ];
        expect(mentionSegments(text, citations, nodes)).toEqual([
            { kind: "link", id: "image-1", label: "图片" },
            { kind: "text", text: " 把这张的背景补一下，参考 " },
            { kind: "link", id: "image-2", label: "图片 2" },
            { kind: "text", text: " 的色调" },
        ]);
    });

    it("reads a transcript written before labels were unique one citation at a time", () => {
        // Same visible token twice, two ids in the block: the first occurrence is the first citation.
        const citations = [
            { id: "image-1", label: "图片" },
            { id: "image-2", label: "图片" },
        ];
        expect(mentionSegments("@图片 和 @图片", citations, nodes)).toEqual([
            { kind: "link", id: "image-1", label: "图片" },
            { kind: "text", text: " 和 " },
            { kind: "link", id: "image-2", label: "图片" },
        ]);
    });

    it("keeps a repeated citation on the node that was cited, not on the next node of that name", () => {
        // The same node cited twice reads the same twice; the third occurrence has no citation left to
        // spend, and must not drift to the other node that happens to be called `图片`.
        const citations = [{ id: "image-1", label: "图片" }];
        expect(mentionSegments("@图片 和 @图片", citations, nodes)).toEqual([
            { kind: "link", id: "image-1", label: "图片" },
            { kind: "text", text: " 和 " },
            { kind: "link", id: "image-1", label: "图片" },
        ]);
    });

    it("links a node the canvas still names, for an answer that mentions it", () => {
        expect(mentionSegments("我把 @补全背景 调亮了一点", [], [{ id: "text-9", label: "补全背景" }])).toEqual([
            { kind: "text", text: "我把 " },
            { kind: "link", id: "text-9", label: "补全背景" },
            { kind: "text", text: " 调亮了一点" },
        ]);
    });

    it("follows the citation rather than a node of the same name", () => {
        // A node that happens to be called `图片 2` must not capture a citation that is not it.
        const citations = [{ id: "image-2", label: "图片 2" }];
        expect(mentionSegments("@图片 2", citations, [{ id: "other", label: "图片 2" }])).toEqual([{ kind: "link", id: "image-2", label: "图片 2" }]);
    });

    it("prefers the longest name, so a citation does not end inside a longer one", () => {
        const citations = [
            { id: "image-1", label: "图片 1" },
            { id: "image-10", label: "图片 10" },
        ];
        expect(mentionSegments("@图片 10 对比 @图片 1", citations, nodes)).toEqual([
            { kind: "link", id: "image-10", label: "图片 10" },
            { kind: "text", text: " 对比 " },
            { kind: "link", id: "image-1", label: "图片 1" },
        ]);
    });

    it("leaves an @ that names nothing as text", () => {
        expect(mentionSegments("给 @某人 发一下", [], nodes)).toEqual([{ kind: "text", text: "给 @某人 发一下" }]);
        expect(mentionSegments("没有 @ 的句子", [], [])).toEqual([{ kind: "text", text: "没有 @ 的句子" }]);
    });
});
