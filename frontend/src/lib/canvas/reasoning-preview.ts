/**
 * The two ends of a thought, for the row a folded one leaves behind.
 *
 * Reasoning is folded away by default, and a closed drawer that says only "Thinking" says nothing about what
 * was thought. What fits on one line is the beginning and the end of it — where the thought started and what
 * it concluded — with the middle elided, because the middle is the part a reader skips.
 *
 * Both halves are cut before they are tidied, so neither walks the whole thought: this runs on every frame
 * while the thought is still arriving, and the text only grows (#237). The cost is the two lengths asked
 * for, whatever the thought is up to.
 */

/** How much of the start is offered — more than fits in the widest panel, so the row is filled by CSS. */
const HEAD = 120;

/** How much of the end is kept. Short, because it must survive a panel dragged to its 320px minimum. */
const TAIL = 20;

/**
 * A slice of text, without half a character at either edge.
 *
 * A string is indexed by code unit, so a slice can land between the two halves of an emoji or a rare CJK
 * character and the row would draw a replacement box. The half with no partner is dropped: one character
 * of a preview is worth less than a broken one.
 */
function whole(slice: string): string {
    let text = slice;
    const first = text.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) text = text.slice(1);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    return text;
}

/** Line breaks and runs of spaces are one line's business: the row is one line, so they become one space. */
function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/**
 * The start and the end of a thought.
 *
 * `tail` is empty when the thought is short enough that the head is all of it — there is nothing to elide,
 * so the row is just the thought, and the panel's own truncation is the only thing that can cut it.
 */
export function reasoningPreview(text: string): { head: string; tail: string } {
    const head = oneLine(whole(text.slice(0, HEAD)));
    if (text.length <= HEAD + TAIL) return { head, tail: "" };
    // A cut lands wherever the count lands, so the tail can begin on the punctuation that joined it to the
    // sentence before it. The ellipsis already says a sentence was cut; a leading "，," only says where.
    const tail = oneLine(whole(text.slice(-TAIL)))
        .replace(/^[,.;:!?，。；：！？、]+/, "")
        .trim();
    return { head, tail };
}
