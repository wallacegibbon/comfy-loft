import { describe, expect, it } from "vitest";

import { atSpeechLimit, insertSpoken, isSpeakable, isTalkChord, isTalkKey, MAX_SPEECH_SECONDS, MIN_SPEECH_SECONDS } from "@/lib/canvas/agent-dictation";

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

/**
 * The cap, and why it is not a preference.
 *
 * The gesture is held, so nothing but a length stops a capture whose release never arrives — a stuck pointer,
 * a key the window never hears come up. The number matters only at the boundary: a sample short of the minute
 * is still recording, and the minute itself ends it (#251).
 */
describe("atSpeechLimit", () => {
    it("keeps recording right up to the minute", () => {
        expect(atSpeechLimit(16_000 * (MAX_SPEECH_SECONDS - 1), 16_000)).toBe(false);
        expect(atSpeechLimit(16_000 * MAX_SPEECH_SECONDS - 1, 16_000)).toBe(false);
    });

    it("ends the recording at the minute, whatever rate the graph ran at", () => {
        expect(atSpeechLimit(16_000 * MAX_SPEECH_SECONDS, 16_000)).toBe(true);
        expect(atSpeechLimit(48_000 * MAX_SPEECH_SECONDS, 48_000)).toBe(true);
        // A browser that ignored the requested rate is still a minute of audio.
        expect(atSpeechLimit(44_100 * (MAX_SPEECH_SECONDS + 5), 44_100)).toBe(true);
        expect(atSpeechLimit(44_100 * (MAX_SPEECH_SECONDS - 5), 44_100)).toBe(false);
    });

    it("says nothing about a recording that has no rate to divide by", () => {
        expect(atSpeechLimit(1_000_000, 0)).toBe(false);
    });

    it("is far longer than the gesture it is a safety net for", () => {
        expect(MAX_SPEECH_SECONDS).toBeGreaterThan(10);
        expect(MAX_SPEECH_SECONDS).toBeLessThanOrEqual(120);
    });
});

/**
 * The two keys, and why a test says so twice.
 *
 * `Ctrl + '` and `Ctrl + the backquote above Tab` are meant to be *the same gesture*, not two features that
 * happen to be near each other (#314): one predicate pair decides both, so the cases below ask each question
 * of each key and expect the same answer. A future edit that gives one of them its own path fails here.
 */
describe("isTalkChord", () => {
    const TALK_KEYS = [
        { key: "'", code: "Quote" },
        { key: "`", code: "Backquote" },
    ];

    it("starts a gesture from either key, with either modifier", () => {
        for (const talk of TALK_KEYS) {
            expect(isTalkChord({ ...talk, ctrlKey: true })).toBe(true);
            expect(isTalkChord({ ...talk, metaKey: true })).toBe(true);
        }
    });

    // Both are characters someone types into the very box the gesture types into: without a modifier a press
    // has to be a keystroke, or the prompt could not contain a quote or a backtick.
    it("is typing when no modifier is held", () => {
        for (const talk of TALK_KEYS) {
            expect(isTalkChord(talk)).toBe(false);
            expect(isTalkChord({ ...talk, ctrlKey: false, metaKey: false })).toBe(false);
        }
    });

    it("leaves every other chord alone", () => {
        expect(isTalkChord({ key: "a", code: "KeyA", ctrlKey: true })).toBe(false);
        expect(isTalkChord({ key: "z", code: "KeyZ", metaKey: true })).toBe(false);
        expect(isTalkChord({ key: "Control", code: "ControlLeft", ctrlKey: true })).toBe(false);
        expect(isTalkChord({ key: "Meta", code: "MetaLeft", metaKey: true })).toBe(false);
    });

    // The physical key is what a held gesture is made of: a layout that types something else there still means
    // this chord, and an event that reports no `code` at all is still matched on the character.
    it("reads the key by position or by character", () => {
        expect(isTalkChord({ key: "^", code: "Backquote", ctrlKey: true })).toBe(true);
        expect(isTalkChord({ key: "'", ctrlKey: true })).toBe(true);
        expect(isTalkChord({ key: "`", ctrlKey: true })).toBe(true);
        expect(isTalkChord({ key: "^", code: "", ctrlKey: true })).toBe(false);
    });
});

/**
 * Letting go.
 *
 * Either half of the chord ends the sentence — the key first is "I am done", the modifier first is "oops" —
 * so the release has to be recognised from both keys as well. `Control` and `Meta` are the hook's own case and
 * are checked here only so that this stays about the keys.
 */
describe("isTalkKey", () => {
    it("recognises the release of either key", () => {
        expect(isTalkKey({ key: "'", code: "Quote" })).toBe(true);
        expect(isTalkKey({ key: "`", code: "Backquote" })).toBe(true);
        expect(isTalkKey({ key: "'" })).toBe(true);
        expect(isTalkKey({ key: "`" })).toBe(true);
    });

    it("is not the release of anything else", () => {
        expect(isTalkKey({ key: "a", code: "KeyA" })).toBe(false);
        expect(isTalkKey({ key: "Control", code: "ControlLeft" })).toBe(false);
        expect(isTalkKey({ key: "Meta", code: "MetaLeft" })).toBe(false);
        expect(isTalkKey({ key: "Shift", code: "ShiftLeft" })).toBe(false);
    });
});
