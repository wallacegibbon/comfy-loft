import { describe, expect, it } from "vitest";

import { insertSpoken, isSpeakable, MIN_SPEECH_SECONDS } from "@/lib/canvas/agent-dictation";

/**
 * Where the words land.
 *
 * The caret is the whole point of the feature: speaking is another way of typing, and typing goes in at the
 * caret. The cases are the ones a textarea can be in when the gesture starts — a caret in the middle, a
 * selection, nothing at all — plus the ranges that only exist because the box and the range can drift.
 */
describe("insertSpoken", () => {
    it("puts the words at the caret", () => {
        expect(insertSpoken("画一只猫", "帮我", { start: 0, end: 0 })).toEqual({ value: "帮我画一只猫", caret: 2 });
        expect(insertSpoken("帮我猫", "画一只", { start: 2, end: 2 })).toEqual({ value: "帮我画一只猫", caret: 5 });
        expect(insertSpoken("画一只猫", "，谢谢", { start: 4, end: 4 })).toEqual({ value: "画一只猫，谢谢", caret: 7 });
    });

    it("replaces what was selected, the way typing over it would", () => {
        expect(insertSpoken("画一只狗", "猫", { start: 3, end: 4 })).toEqual({ value: "画一只猫", caret: 4 });
    });

    it("appends to an empty draft", () => {
        expect(insertSpoken("", "你好", { start: 0, end: 0 })).toEqual({ value: "你好", caret: 2 });
    });

    it("keeps the lines the words were spoken with", () => {
        expect(insertSpoken("a\nb", "1\n2", { start: 3, end: 3 })).toEqual({ value: "a\nb1\n2", caret: 6 });
    });

    // The range comes from a box that may have been edited since it was read: a wider range has to mean the
    // end of the draft, not a splice somewhere unintended.
    it("clamps a range that outlived the draft", () => {
        expect(insertSpoken("abc", "!", { start: 9, end: 12 })).toEqual({ value: "abc!", caret: 4 });
        expect(insertSpoken("abc", "!", { start: -3, end: -1 })).toEqual({ value: "!abc", caret: 1 });
        expect(insertSpoken("abc", "!", { start: 2, end: 1 })).toEqual({ value: "ab!c", caret: 3 });
    });
});

describe("isSpeakable", () => {
    it("counts a press that said something as speech", () => {
        expect(isSpeakable(16_000 * 1, 16_000)).toBe(true);
        expect(isSpeakable(Math.ceil(16_000 * MIN_SPEECH_SECONDS), 16_000)).toBe(true);
    });

    // A tap, a key held by accident, and a gesture that ended while the permission prompt was open: sending
    // any of these is a request the speech server refuses, shown as if the microphone had failed.
    it("ignores a gesture too short to be speech", () => {
        expect(isSpeakable(0, 16_000)).toBe(false);
        expect(isSpeakable(100, 16_000)).toBe(false);
        expect(isSpeakable(16_000, 0)).toBe(false);
    });
});
