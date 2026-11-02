/**
 * A node's title, in the language the reader is using.
 *
 * A canvas is saved data, and a title used to be saved *translated*: creating an image node in the
 * Chinese UI wrote "图片" into the node, so the same canvas showed "图片" in the English UI forever.
 * The fix is the one the rest of the app already uses for shipped text: store the identifier, render
 * the translation. `titleKey` is that identifier, `titleParams` are its values, and `title` stays as
 * the snapshot — a filename, an export, or a node the user renamed.
 */

type TitleSource = { title?: string; titleKey?: string; titleParams?: Record<string, string | number> };

type Translate = (key: string, options?: Record<string, string | number>) => string;

/**
 * The title to render for a node.
 *
 * A key wins, so a canvas created in one language reads correctly in the other. Without one the
 * stored title is the answer — that is what a user-typed name looks like, and what any node created
 * before the title became a key carries.
 */
export function nodeTitle(node: TitleSource, t: Translate) {
    if (node.titleKey) return t(node.titleKey, node.titleParams);
    return node.title || "";
}
