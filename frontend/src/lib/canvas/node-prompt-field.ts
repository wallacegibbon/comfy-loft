import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * Whether a node already holds a result.
 *
 * It decides where that node's prompt lives: a node that holds a result keeps the words you are editing in
 * `composerContent`, so the result is not overwritten by typing; a node that holds none keeps them in
 * `prompt`, ready to be run. The node's own prompt panel asks this, and so does the agent's `set_prompt` —
 * one question, so a prompt written by the agent lands in the same field the user's typing would.
 */
export function holdsResult(node: CanvasNodeData): boolean {
    const content = node.metadata?.content || "";
    if (node.type === CanvasNodeType.Text) return Boolean(content.trim());
    if (node.type === CanvasNodeType.Image) return Boolean(content);
    return false;
}

/**
 * The words a node holds, for finding it and for reading it.
 *
 * A node's text is in whichever field its state keeps it in (see above), and a text node holds a batch of
 * them (`texts`, the primary one being what it says). The list in the left column searched `title`,
 * `content` and `prompt`, which was wrong in both directions: it could not find the words in the box the
 * prompt panel shows — `composerContent` once the node holds a result — while it *did* search `content`,
 * which for a picture is a file name, so "png" matched every image on the canvas.
 *
 * Media nodes contribute no words beyond their title and prompt: their `content` is the picture itself.
 */
export function nodeWords(node: CanvasNodeData): string {
    const parts: Array<string | undefined> = [node.title, node.metadata?.composerContent, node.metadata?.prompt];
    if (node.type === CanvasNodeType.Text) parts.push(node.metadata?.content, ...(node.metadata?.texts || []).map((text) => text.content));
    return parts.filter(Boolean).join("\n");
}
