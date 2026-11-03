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
 */

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
