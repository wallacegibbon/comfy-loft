import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeText } from "@/types/canvas";

/**
 * A node's words, and the one function that answers each question about them.
 *
 * There are three kinds, and they are not interchangeable: `content` is what the node holds, `prompt` is
 * the words that made it, and `composerContent` is what you type when it already holds something (so
 * typing cannot throw the result away, #91).
 *
 * The canvas used to answer all three with one function and a chain of fallbacks —
 * `composerContent ?? prompt ?? content ?? texts[0]` — which is harmless while every node's content is a
 * file: reading a picture answered with its prompt and nobody minded, because the picture came along in
 * the same answer. A text node's content *is* words, so the same chain answered "what does this node say"
 * with the question that was asked to make it. The agent could read the box and never the card, and it
 * wrote the box when it was asked to change the text — the tools were telling it a different story than
 * the canvas shows (#229).
 *
 * One question, one function. The panel and the tools ask the same ones, so they cannot disagree about
 * where a node's words live.
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
    return (primaryTextOf(node)?.content || node.metadata?.content || "").trim();
}

/**
 * The rest of a text batch: what the card is not showing.
 *
 * A batch is one node holding several texts (the `N 条` button expands them). The card shows the primary
 * one, so a reader that only asked `nodeContentOf` would silently drop the others — the same omission this
 * module exists to end, in miniature.
 */
export function nodeOtherTextsOf(node: CanvasNodeData): string[] {
    if (node.type !== CanvasNodeType.Text) return [];
    const primaryId = primaryTextOf(node)?.id;
    return (node.metadata?.texts || [])
        .filter((text) => text.id !== primaryId)
        .map((text) => (text.content || "").trim())
        .filter(Boolean);
}

/**
 * The words the node was made from — what its own panel shows in the box.
 *
 * Returned as typed, without trimming: the panel syncs its textarea against this, and a value that came
 * back shorter than what the user typed would eat the space they had just pressed.
 */
export function nodePromptOf(node: CanvasNodeData): string {
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
 * A node that holds something keeps it in `composerContent`, so typing never overwrites a result. A config
 * node always does, because its composer is where its words have always been.
 */
function promptFieldOf(node: CanvasNodeData): "composerContent" | "prompt" {
    return node.type === CanvasNodeType.Config || holdsResult(node) ? "composerContent" : "prompt";
}

/** `promptFieldOf` as the patch a caller writes: one field, whichever it is. */
export function promptPatch(node: CanvasNodeData, words: string): Partial<CanvasNodeMetadata> {
    return { [promptFieldOf(node)]: words };
}

/**
 * The words a node holds, for finding it.
 *
 * Generous on purpose — this is a search: it looks in whatever field the node's words may be in, and in a
 * text node's batch. Media nodes contribute no words beyond their title and prompt: their `content` is the
 * picture itself, so searching it made "png" match every image on the canvas.
 */
export function nodeWords(node: CanvasNodeData): string {
    const parts: Array<string | undefined> = [node.title, node.metadata?.composerContent, node.metadata?.prompt];
    if (node.type === CanvasNodeType.Text) parts.push(node.metadata?.content, ...(node.metadata?.texts || []).map((text) => text.content));
    return parts.filter(Boolean).join("\n");
}

/** The text a card is showing: the primary of a batch, or the node's own single text. */
function primaryTextOf(node: CanvasNodeData): CanvasNodeText | undefined {
    const texts = node.metadata?.texts || [];
    if (!texts.length) return undefined;
    return texts.find((text) => text.id === (node.metadata?.primaryTextId || texts[0].id)) || texts[0];
}
