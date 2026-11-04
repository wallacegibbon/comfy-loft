import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

/**
 * A node's words, and the one function that answers each question about them.
 *
 * There are two kinds, and they are not interchangeable: `content` is what the node holds, and `prompt` is
 * the words it will be asked next — the ones that made it, for a node a run made and nobody has retyped
 * since. A text node has only the first: its card *is* its content, and nothing asks it a question (#278).
 *
 * The canvas used to answer both with one function and a chain of fallbacks —
 * `composerContent ?? prompt ?? content ?? texts[0]` — which is harmless while every node's content is a
 * file: reading a picture answered with its prompt and nobody minded, because the picture came along in
 * the same answer. A text node's content is words, so the same chain answered "what does this node say" with
 * the question that was asked to make it. The agent could read the box and never the card, and it wrote the
 * box when it was asked to change the text (#229).
 *
 * One question, one function. The panel and the tools ask the same ones, so they cannot disagree about
 * where a node's words live.
 *
 * `prompt` is a question, not a record of provenance, and the difference is what keeps a hand-edited card
 * honest: editing the words (by hand, or with `set_text`) leaves the question they no longer answer, which
 * is right — it is still what running the node sends. Nothing is left claiming to have made those words,
 * because on a text node there is nothing to claim: a text node has no run behind it, so #227's maker
 * facts are stamped on media only. That is why writing a card needs no scrubbing, while a file entering a
 * node needed all of it (#228).
 */

/** The types whose content is media — a picture, a film, a sound — rather than words. */
const MEDIA_TYPES: string[] = [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio];

/**
 * What the node shows: a text node's words. A picture, a film or a sound holds no words at all — its
 * content is the media itself, and `read_node` hands that over as bytes rather than as text.
 *
 * Trimmed, because this is the answer to "what does it say": a card's trailing whitespace is not a word,
 * and a node with nothing but whitespace on it says nothing.
 */
export function nodeContentOf(node: CanvasNodeData): string {
    if (node.type !== CanvasNodeType.Text) return "";
    return (node.metadata?.content || "").trim();
}

/**
 * The words the node will be asked next: what its own panel shows in the box, and what running it sends.
 *
 * A text node has no prompt — it is the answer, not a question — so this answers `""` for one, and every
 * caller that would have written it refuses instead (`set_prompt`, `pressGenerate`).
 *
 * For a node a run made, and nobody has retyped since, these are also the words that made it — and they
 * stop being that the moment a hand edits the content, which is why this is a question and not evidence.
 * The list says which it is, rather than calling the field a node's provenance.
 *
 * Returned as typed, without trimming: the panel syncs its textarea against this, and a value that came
 * back shorter than what the user typed would eat the space they had just pressed.
 */
export function nodePromptOf(node: CanvasNodeData): string {
    if (node.type === CanvasNodeType.Text) return "";
    return node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
}

/**
 * Whether the node holds anything — a run's result, an import, or words someone typed on the card.
 *
 * Every content type answers the same way: what matters is that `content` is there, not which type the
 * node is. It used to be a whitelist of text and image, so a video or a sound — which hold a result just
 * as plainly — kept its prompt in `prompt` and lost the words that made it to the first keystroke (#229).
 */
function holdsResult(node: CanvasNodeData): boolean {
    const content = node.metadata?.content || "";
    if (node.type === CanvasNodeType.Text) return Boolean(content.trim());
    if (MEDIA_TYPES.includes(node.type)) return Boolean(content);
    return false;
}

/**
 * The field a node's instruction lives in — the one question the panel and `set_prompt` both ask.
 *
 * A node that holds something keeps it in `composerContent`, so typing never overwrites a result.
 */
function promptFieldOf(node: CanvasNodeData): "composerContent" | "prompt" {
    return holdsResult(node) ? "composerContent" : "prompt";
}

/** `promptFieldOf` as the patch a caller writes: one field, whichever it is. */
export function promptPatch(node: CanvasNodeData, words: string): Partial<CanvasNodeMetadata> {
    return { [promptFieldOf(node)]: words };
}

/**
 * The words a node holds, for finding it.
 *
 * Generous on purpose — this is a search: it looks in whatever field the node's words may be in. Media
 * nodes contribute no words beyond their title and prompt: their `content` is the picture itself, so
 * searching it made "png" match every image on the canvas.
 */
export function nodeWords(node: CanvasNodeData): string {
    const parts: Array<string | undefined> = [node.title, node.metadata?.composerContent, node.metadata?.prompt];
    if (node.type === CanvasNodeType.Text) parts.push(node.metadata?.content);
    return parts.filter(Boolean).join("\n");
}
