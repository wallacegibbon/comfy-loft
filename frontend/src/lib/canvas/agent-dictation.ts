/**
 * Dictation: the words come back and go in where the caret was.
 *
 * Speaking is another way of typing, so it does what typing does — the text lands at the caret, replaces
 * whatever was selected, and the caret ends up after it. Not at the end of the draft: someone who clicked
 * into the middle of a sentence is asking for the words *there*, and the caret is the only thing that knows
 * where "there" is.
 *
 * That is why this is a pure function of the draft and a range. The panel reads the range from the box (a
 * textarea keeps its selection while it is not focused, which is the whole trick — the gesture starts on the
 * canvas and the box has no focus at all by the time the words arrive), and this decides what the new draft
 * is. It can be tested without a DOM, which is the only way to test it at all.
 *
 * The gesture's first half is here for the same reason: which keys start it is a question about a key event,
 * and there are two of them (#314). Everything after the key — the microphone, the cap, the words, the caret —
 * is the same code from either.
 */

/**
 * The two keys a gesture starts with — both, because they are one gesture.
 *
 * `'` is what a person reaches for to quote what they say; the backquote above Tab is the same chord on the
 * home row, and the reason it was asked for was that it is easier to hold and asks less of a keyboard. So the
 * keys are matched here, once: the microphone, the length cap and the caret never learn which was pressed,
 * and there is no second handler to drift from the first.
 *
 * Matched on `code` *or* `key`: the physical position survives a layout that types a different character
 * there, and `key` covers an event that reports no `code` at all.
 */
const TALK_CHARS = ["'", "`"];
const TALK_CODES = ["Quote", "Backquote"];

/** The part of a key event a chord is read from. Structural, so the pairing is testable without a DOM. */
type ChordEvent = { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean };

/** Whether this is the gesture's own key, either one of them. */
export function isTalkKey(event: Pick<ChordEvent, "key" | "code">): boolean {
    return TALK_CHARS.includes(event.key) || TALK_CODES.includes(event.code ?? "");
}

/**
 * Whether this press begins a gesture: a modifier and the key.
 *
 * The modifier is what makes it one. A bare `'` is a quote and a bare backquote is a character, and both are
 * things someone may be typing into the box this gesture types into.
 */
export function isTalkChord(event: ChordEvent): boolean {
    return Boolean(event.ctrlKey || event.metaKey) && isTalkKey(event);
}

/**
 * How much sound is worth a request.
 *
 * A press is not a recording: a tap, a key held by accident and a gesture that ended while the permission
 * prompt was up all produce a few samples, and the speech server answers those with a refusal that would be
 * shown as a failure of the user's microphone. Below this, nothing was said.
 */
export const MIN_SPEECH_SECONDS = 0.2;

/** Whether a gesture captured enough to be speech: samples over the rate the graph ran at. */
export function isSpeakable(samples: number, sampleRate: number): boolean {
    return sampleRate > 0 && samples / sampleRate >= MIN_SPEECH_SECONDS;
}

/**
 * How much speech one gesture may hold: a minute.
 *
 * The gesture is *held*, so this is the length of a paragraph spoken without pausing — already far more than
 * a prompt, and the point past which the wait stops being free: at the measured rtf of the server this build
 * was built against (0.12), a minute of audio is about seven seconds of transcription, and two minutes would
 * be fourteen. It is also the safety net for the failure the gesture has no other answer to: a pointer capture
 * or a key that never comes up records forever and uploads on release, and a cap turns that into a minute
 * rather than however long the window was left open (#251).
 *
 * Nothing else enforces this. The server bounds the upload (`MaxUploadBytes`) and would transcribe a longer
 * file happily; the cap is about how long a *person* may hold the button, which only this side knows.
 */
export const MAX_SPEECH_SECONDS = 60;

/** Whether a gesture has reached the cap and must be ended. */
export function atSpeechLimit(samples: number, sampleRate: number): boolean {
    return sampleRate > 0 && samples / sampleRate >= MAX_SPEECH_SECONDS;
}

/** Where the words go: the selection the box had, which may be a caret (start === end). */
type DraftSelection = { start: number; end: number };

/**
 * Put the spoken words where the caret was.
 *
 * The range is clamped to the draft rather than trusted: the box may have been edited by something else,
 * and an index past the end would splice the words into the wrong place instead of failing loudly.
 */
export function insertSpoken(draft: string, spoken: string, selection: DraftSelection): { value: string; caret: number } {
    const length = draft.length;
    const start = Math.min(Math.max(0, selection.start), length);
    const end = Math.min(Math.max(start, selection.end), length);
    return {
        value: `${draft.slice(0, start)}${spoken}${draft.slice(end)}`,
        caret: start + spoken.length,
    };
}
