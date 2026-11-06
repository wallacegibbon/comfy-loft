/**
 * A node's title, in the language the reader is using.
 *
 * A canvas is saved data, and a title used to be saved *translated*: creating an image node in the
 * Chinese UI wrote that language's title for the type into the node, so the same canvas showed it in the
 * English UI forever. The fix is the one the rest of the app already uses for shipped text: store the
 * identifier, render the translation. `titleKey` is that identifier, `titleParams` are its values, and
 * `title` stays as the snapshot — a filename, an export, or a node the user renamed.
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

/**
 * What a mention calls a node: the name the user gave it, or its id.
 *
 * A mention has to name one node. A title does not: every picture starts as "Image", so a canvas of ten of them
 * cites ten `@Image`s and the eleventh reader cannot tell which is meant — the ordinal `@Image 2` disambiguates
 * them but says nothing about the picture. The id is the one token that names exactly one node, it is what every
 * tool answers with, and it is what an agent writes back. So a node the user has not named is mentioned by its
 * id, and a node they have named keeps their words.
 */
export function mentionLabel(node: TitleSource & { id: string }) {
    return node.titleKey ? node.id : node.title || node.id;
}
