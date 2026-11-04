import { describe, expect, it } from "vitest";

import { reasoningPreview } from "@/lib/canvas/reasoning-preview";

describe("the two ends of a folded thought", () => {
    it("shows a short thought whole, with nothing to elide", () => {
        expect(reasoningPreview("The canvas has nine nodes.")).toEqual({ head: "The canvas has nine nodes.", tail: "" });
    });

    it("keeps the start and the end of a long one", () => {
        const thought = `${"a".repeat(120)}${"b".repeat(500)}${"c".repeat(20)}`;
        const { head, tail } = reasoningPreview(thought);
        expect(head).toBe("a".repeat(120));
        expect(tail).toBe("c".repeat(20));
    });

    it("does not show the same words twice when the head already reaches the end", () => {
        // 130 characters: the last 20 are inside the first 120, so there is no middle to elide.
        expect(reasoningPreview("x".repeat(130)).tail).toBe("");
        // One more character and the two halves are disjoint.
        expect(reasoningPreview("x".repeat(141)).tail).toBe("x".repeat(20));
    });

    it("folds the line breaks of a paragraph into one line", () => {
        expect(reasoningPreview("first line\n\nsecond\tline").head).toBe("first line second line");
    });

    it("never cuts a character in half", () => {
        // An emoji is two code units. A cut between them would draw a replacement box, so the half with no
        // partner is dropped instead.
        const emoji = "🙂";
        // The head's 120th unit is the emoji's high half, and its low half is left behind.
        expect(reasoningPreview(`${"a".repeat(119)}${emoji}${"b".repeat(200)}`).head).toBe("a".repeat(119));
        // The tail starts on an emoji's low half, whose high half was cut, so it goes too.
        expect(reasoningPreview(`${"a".repeat(200)}${emoji}${"b".repeat(19)}`).tail).toBe("b".repeat(19));
        // A character whole on both sides of the cut is kept whole.
        expect(reasoningPreview(`${"a".repeat(200)}${emoji}`).tail).toBe(`${"a".repeat(18)}${emoji}`);
    });

    it("starts the end at a word, not at the punctuation the cut left behind", () => {
        // The twenty units the tail keeps begin on the comma that joined them to a sentence nobody can see.
        expect(reasoningPreview(`${"a".repeat(200)}，${"b".repeat(19)}`).tail).toBe("b".repeat(19));
        expect(reasoningPreview(`${"a".repeat(200)}。${"b".repeat(19)}`).tail).toBe("b".repeat(19));
    });

    it("has nothing to show for nothing", () => {
        expect(reasoningPreview("")).toEqual({ head: "", tail: "" });
        expect(reasoningPreview("   \n  ")).toEqual({ head: "", tail: "" });
    });
});
