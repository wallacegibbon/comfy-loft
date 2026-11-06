/**
 * The Markdown an answer uses, as tokens.
 *
 * The panel draws a model's reply, and a reply is a document: it has headings, lists and above all tables,
 * which is the one thing a `whitespace-pre-wrap` paragraph cannot show — it prints the pipes. Everything
 * else here exists to make the table possible: a cell holds inline Markdown, so the inline parser is not
 * optional once tables are in.
 *
 * **No HTML is ever produced.** A token tree that React turns into elements is what stops a model we do not
 * control — and text it was handed by a file on the canvas — from putting a tag or an event handler into a
 * page served over plain HTTP. It is also the only shape that can keep a citation clickable: every run of
 * text goes back out through the panel's `withMentions`, which is what turns `@label` into a button (#237).
 *
 * **A few inline tags are read, and none is written.** A model does not always write Markdown: measured over
 * one session, every answer dressed a node id as `<span style="font-family: monospace">@image-1</span>`,
 * because a code span is what it meant and a tag is what it typed. So `INLINE_TAGS` reads the handful of tags
 * whose meaning is already a token here — `code`, `b`/`strong`, `i`/`em`, `del`/`s`/`strike`, `br`, and that
 * one monospace `span`. The tag becomes a token and the token a React element, so nothing on this path builds
 * an HTML string and no attribute of any tag is carried anywhere. Everything else stays the characters it was
 * written as — the same answer an unclosed `**` and a stray `|` get.
 *
 * **The subset is what an answer writes**, not CommonMark: headings, paragraphs, fenced code, quotes,
 * rules, lists and tables, inline code, strong, emphasis, strikethrough, links, and those few tags. No images
 * (a picture in this app is a node), no footnotes, no math, no reference-style links, no task-list boxes. A
 * construct outside the subset is not an error — it stays the text it was.
 *
 * Text nodes do not use this: the canvas draws what a text node holds as the words that were typed.
 */

export type MarkdownAlign = "left" | "center" | "right";

/** One block of an answer. A quote and each list item are documents of their own, so both hold blocks. */
export type MarkdownBlock =
    | { kind: "paragraph"; lines: string[] }
    | { kind: "heading"; level: number; text: string }
    | { kind: "code"; text: string }
    | { kind: "quote"; blocks: MarkdownBlock[] }
    | { kind: "rule" }
    | { kind: "list"; ordered: boolean; start: number; items: MarkdownBlock[][] }
    | { kind: "table"; align: MarkdownAlign[]; header: string[]; rows: string[][] };

/** One run of inline Markdown. Everything but `text` and `code` holds more inline. */
export type MarkdownInline =
    | { kind: "text"; text: string }
    | { kind: "code"; text: string }
    | { kind: "strong"; tokens: MarkdownInline[] }
    | { kind: "em"; tokens: MarkdownInline[] }
    | { kind: "strike"; tokens: MarkdownInline[] }
    | { kind: "link"; href: string; tokens: MarkdownInline[] }
    | { kind: "break" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
/** One column of a table's second line: `---`, `:---`, `---:`, `:---:`. */
const COLUMN_MARK = /^:?-+:?$/;
/** A link whose target we are willing to open. Anything else — `javascript:`, a relative path — stays text. */
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const LINK = /^\[([^\]]*)\]\(([^()\s]*)\)/;
/**
 * The inline tags an answer may write, and the token each of them means.
 *
 * Read, never written: the tag is consumed and the token that comes out is drawn as a React element, so a
 * `style` attribute cannot reach the page and no event handler survives. Only the tags whose meaning already
 * exists here are listed; the monospace `span` is the one a model reaches for when it means a code span.
 */
type InlineTag = { kind: "code"; open: RegExp; close: RegExp } | { kind: "strong" | "em" | "strike"; open: RegExp; close: RegExp };

const INLINE_TAGS: InlineTag[] = [
    { kind: "code", open: /^<code(?:\s[^<>]*)?>/i, close: /<\/code\s*>/i },
    // Any other attribute on it is irrelevant: the tag is read for the one thing it means, and the rest of it
    // is dropped with it — an `onclick` is not carried anywhere because no attribute is carried at all.
    { kind: "code", open: /^<span\s+[^<>]*font-family\s*:\s*monospace[^<>]*>/i, close: /<\/span\s*>/i },
    { kind: "strong", open: /^<(?:b|strong)(?:\s[^<>]*)?>/i, close: /<\/(?:b|strong)\s*>/i },
    { kind: "em", open: /^<(?:i|em)(?:\s[^<>]*)?>/i, close: /<\/(?:i|em)\s*>/i },
    { kind: "strike", open: /^<(?:del|s|strike)(?:\s[^<>]*)?>/i, close: /<\/(?:del|s|strike)\s*>/i },
];

/** A `<br>` is a break: `<span>` is not the only tag a model writes when it means layout. */
const LINE_BREAK = /^<br\s*\/?>/i;

/** What a backslash takes back, per CommonMark: punctuation only, and `\n` is not one of them. */
const ESCAPABLE = "\\`*_{}[]()#+-.!>~|\"'";

/** An answer, split into blocks. Carriage returns are normalised so a copy from a Windows file reads the same. */
export function parseMarkdown(text: string): MarkdownBlock[] {
    return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): MarkdownBlock[] {
    const blocks: MarkdownBlock[] = [];
    let index = 0;
    while (index < lines.length) {
        if (!lines[index].trim()) {
            index += 1;
            continue;
        }
        const fence = FENCE.exec(lines[index]);
        if (fence) {
            const [block, next] = readFence(lines, index, fence[1]);
            blocks.push(block);
            index = next;
            continue;
        }
        const heading = HEADING.exec(lines[index]);
        if (heading) {
            // `## Title ##` is one heading: the closing run is decoration, not words.
            blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim().replace(/\s+#+$/, "") });
            index += 1;
            continue;
        }
        // Before the list check: `- - -` is a rule, and it also reads as a bullet.
        if (RULE.test(lines[index])) {
            blocks.push({ kind: "rule" });
            index += 1;
            continue;
        }
        const [block, next] = QUOTE.test(lines[index]) ? readQuote(lines, index) : isTable(lines, index) ? readTable(lines, index) : BULLET.test(lines[index]) || ORDERED.test(lines[index]) ? readList(lines, index) : readParagraph(lines, index);
        blocks.push(block);
        index = next;
    }
    return blocks;
}

/**
 * A fenced block, up to the line that closes it — or to the end of what has arrived.
 *
 * An answer arrives a word at a time, so a fence with no closing line yet is the code written so far, not
 * a broken document. Nothing inside is looked at: `**` in a code block is two asterisks.
 */
function readFence(lines: string[], from: number, fence: string): [MarkdownBlock, number] {
    const marker = fence[0];
    const closing = new RegExp("^\\s{0,3}" + marker + "{" + fence.length + ",}\\s*$");
    const body: string[] = [];
    let index = from + 1;
    while (index < lines.length && !closing.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
    }
    return [{ kind: "code", text: body.join("\n") }, Math.min(index + 1, lines.length)];
}

/** A quote, quoted again: the marker comes off one level and the rest is parsed as the document it is. */
function readQuote(lines: string[], from: number): [MarkdownBlock, number] {
    const inner: string[] = [];
    let index = from;
    while (index < lines.length && QUOTE.test(lines[index])) {
        inner.push(lines[index].replace(QUOTE, ""));
        index += 1;
    }
    return [{ kind: "quote", blocks: parseBlocks(inner) }, index];
}

/**
 * Whether a table starts here: a line with a cell divider, and under it a row of column marks.
 *
 * The second line is what makes it a table, and the count is part of the test — `|---|---|` under a header
 * of three cells is not this table's delimiter, and treating it as one would eat the paragraph below.
 */
function isTable(lines: string[], from: number): boolean {
    if (from + 1 >= lines.length || !lines[from].includes("|") || !lines[from + 1].includes("|")) return false;
    const header = splitRow(lines[from]);
    const marks = splitRow(lines[from + 1]);
    return header.length > 0 && header.length === marks.length && marks.every((cell) => COLUMN_MARK.test(cell));
}

function readTable(lines: string[], from: number): [MarkdownBlock, number] {
    const header = splitRow(lines[from]);
    const align = splitRow(lines[from + 1]).map((cell): MarkdownAlign => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left"));
    const rows: string[][] = [];
    // A row is a line with a divider in it. A short row is padded with nothing, so a table the model wrote
    // unevenly still lines up under its own headings.
    let index = from + 2;
    while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        const cells = splitRow(lines[index]);
        rows.push(header.map((_, column) => cells[column] ?? ""));
        index += 1;
    }
    return [{ kind: "table", align, header, rows }, index];
}

/** A row's cells. An escaped `\|` is a character in a cell, which is the only way to put one there. */
function splitRow(line: string): string[] {
    let text = line.trim();
    if (text.startsWith("|")) text = text.slice(1);
    if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
    const cells: string[] = [];
    let cell = "";
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "\\" && text[index + 1] === "|") {
            cell += "|";
            index += 1;
            continue;
        }
        if (text[index] === "|") {
            cells.push(cell.trim());
            cell = "";
            continue;
        }
        cell += text[index];
    }
    cells.push(cell.trim());
    return cells;
}

/**
 * A list, one item at a time.
 *
 * An item owns every line indented at least as far as its own first word, which is how a wrapped line and a
 * nested list both stay inside it. A blank line between items is a loose list and does not end it; the
 * number is taken from the first item, so a list the model numbered from 3 keeps its numbers.
 */
function readList(lines: string[], from: number): [MarkdownBlock, number] {
    const ordered = ORDERED.test(lines[from]) && !BULLET.test(lines[from]);
    const marker = ordered ? ORDERED : BULLET;
    const items: MarkdownBlock[][] = [];
    let start = 1;
    let index = from;
    while (index < lines.length) {
        const found = nextFilled(lines, index);
        const match = found < lines.length ? marker.exec(lines[found]) : null;
        if (!match) break;
        index = found;
        if (ordered && items.length === 0) start = Number(match[2]);
        const content = ordered ? match[3] : match[2];
        const column = lines[index].length - content.length;
        const own = [content];
        index += 1;
        while (index < lines.length) {
            if (!lines[index].trim()) {
                // A blank line belongs to the item only if what follows is inside it too.
                const after = nextFilled(lines, index);
                if (after < lines.length && indentOf(lines[after]) >= column) {
                    own.push("");
                    index = after;
                    continue;
                }
                break;
            }
            if (indentOf(lines[index]) < column) break;
            own.push(lines[index].slice(column));
            index += 1;
        }
        items.push(parseBlocks(own));
    }
    return [{ kind: "list", ordered, start, items }, index];
}

function readParagraph(lines: string[], from: number): [MarkdownBlock, number] {
    const body: string[] = [];
    let index = from;
    while (index < lines.length && lines[index].trim() && !(index > from && startsBlock(lines, index))) {
        body.push(lines[index].trim());
        index += 1;
    }
    return [{ kind: "paragraph", lines: body }, index];
}

function startsBlock(lines: string[], index: number): boolean {
    const line = lines[index];
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line) || isTable(lines, index);
}

function nextFilled(lines: string[], from: number): number {
    let index = from;
    while (index < lines.length && !lines[index].trim()) index += 1;
    return index;
}

function indentOf(line: string): number {
    return line.length - line.trimStart().length;
}

/**
 * One line — or one table cell — as inline tokens.
 *
 * The rules that keep a name a name: `snake_case` is not emphasis, because an underscore inside a word
 * never opens one; `a * b * c` is multiplication, because an emphasis that starts with a space is not one;
 * and an escaped character is content, so `\*` is the asterisk the model meant.
 */
export function parseInline(text: string): MarkdownInline[] {
    const tokens: MarkdownInline[] = [];
    let plain = "";
    const flush = () => {
        if (!plain) return;
        tokens.push({ kind: "text", text: plain });
        plain = "";
    };
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        const next = text[index + 1];
        if (char === "\\" && next && ESCAPABLE.includes(next)) {
            plain += next;
            index += 2;
            continue;
        }
        if (char === "<") {
            const html = readInlineHTML(text, index);
            if (html) {
                flush();
                tokens.push(...html.tokens);
                index = html.next;
                continue;
            }
        }
        if (char === "`") {
            const run = runLength(text, index);
            const close = findRun(text, index + run, run);
            if (close >= 0) {
                flush();
                tokens.push({ kind: "code", text: text.slice(index + run, close) });
                index = close + run;
                continue;
            }
            plain += text.slice(index, index + run);
            index += run;
            continue;
        }
        if (char === "~" && next === "~") {
            const close = findDelimiter(text, index + 2, "~~");
            if (close > index + 2) {
                flush();
                tokens.push({ kind: "strike", tokens: parseInline(text.slice(index + 2, close)) });
                index = close + 2;
                continue;
            }
            plain += "~~";
            index += 2;
            continue;
        }
        if (char === "*" || char === "_") {
            const match = readEmphasis(text, index);
            if (match) {
                flush();
                tokens.push({ kind: match.kind, tokens: match.tokens });
                index = match.next;
                continue;
            }
        }
        if (char === "[") {
            const match = LINK.exec(text.slice(index));
            if (match) {
                flush();
                // A target we would not open is shown as the text it was written as, rather than as a link
                // that does nothing when it is clicked.
                tokens.push(SAFE_HREF.test(match[2]) ? { kind: "link", href: match[2], tokens: parseInline(match[1]) } : { kind: "text", text: match[0] });
                index += match[0].length;
                continue;
            }
        }
        plain += char;
        index += 1;
    }
    flush();
    return tokens;
}

/** One allowlisted tag at `index`, as the tokens it means — or null, and then it stays the text it was. */
function readInlineHTML(text: string, index: number): { tokens: MarkdownInline[]; next: number } | null {
    const rest = text.slice(index);
    const br = LINE_BREAK.exec(rest);
    if (br) return { tokens: [{ kind: "break" }], next: index + br[0].length };
    for (const tag of INLINE_TAGS) {
        const open = tag.open.exec(rest);
        if (!open) continue;
        const body = rest.slice(open[0].length);
        const close = tag.close.exec(body);
        // An unclosed tag is characters, not an unterminated run of code or emphasis.
        if (!close) continue;
        const inner = body.slice(0, close.index);
        const next = index + open[0].length + close.index + close[0].length;
        // Inline code is literal; the rest keeps its own Markdown, as an emphasis delimiter does.
        if (tag.kind === "code") return { tokens: [{ kind: "code", text: inner }], next };
        return { tokens: [{ kind: tag.kind, tokens: parseInline(inner) }], next };
    }
    return null;
}

/** A run of `**strong**` or `*em*` starting at `index`, or null when the delimiter opens nothing. */
function readEmphasis(text: string, index: number): { kind: "strong" | "em"; tokens: MarkdownInline[]; next: number } | null {
    const char = text[index];
    const strong = text[index + 1] === char;
    const delimiter = strong ? char + char : char;
    const inner = index + delimiter.length;
    if (!text[inner] || text[inner] === " ") return null;
    if (char === "_" && isWord(text[index - 1])) return null;
    let close = findDelimiter(text, inner, delimiter);
    while (close > inner) {
        // The closing delimiter may not follow a space, and inside a word an underscore never closes.
        if (text[close - 1] !== " " && (char !== "_" || !isWord(text[close + delimiter.length]))) {
            return { kind: strong ? "strong" : "em", tokens: parseInline(text.slice(inner, close)), next: close + delimiter.length };
        }
        close = findDelimiter(text, close + 1, delimiter);
    }
    return null;
}

/** Where `delimiter` next appears from `from`, or -1. An escaped delimiter is content, not a close. */
function findDelimiter(text: string, from: number, delimiter: string): number {
    let index = from;
    while (index < text.length) {
        if (text[index] === "\\") {
            index += 2;
            continue;
        }
        if (text.startsWith(delimiter, index)) return index;
        index += 1;
    }
    return -1;
}

/** How many backticks start at `index`: a code span is closed by a run of the same length, so `` `` `` can hold one. */
function runLength(text: string, index: number): number {
    let length = 0;
    while (text[index + length] === "`") length += 1;
    return length;
}

function findRun(text: string, from: number, length: number): number {
    let index = from;
    while (index < text.length) {
        if (text[index] === "`" && runLength(text, index) === length) return index;
        index = text[index] === "`" ? index + runLength(text, index) : index + 1;
    }
    return -1;
}

function isWord(char: string | undefined): boolean {
    return Boolean(char) && /[\p{L}\p{N}_]/u.test(char as string);
}
