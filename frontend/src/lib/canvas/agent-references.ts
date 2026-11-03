/**
 * The block the canvas puts in front of a prompt when the user cites nodes.
 *
 * The agent needs it — a mention is a node's label with an `@` in front, which means nothing without the
 * text that follows — but it is plumbing, not something anybody typed. So the same module builds it and
 * takes it off again: the panel shows the words the person wrote, and a conversation replayed from the
 * agent's session file shows them too, even though what was sent was the marked-up version.
 *
 * **A citation is an id, and its label is only what the message shows.** Titles are not unique — every
 * image node is created with the same default, so a canvas has as many nodes under one default title as
 * it has images — which is why the block carries the node's id on every line and why a label that is
 * already in use in one message gets an ordinal (`label 2`). Reading a mention back is therefore never a
 * lookup of a node by the text after the `@`: it is the id the message recorded, in the order the message
 * cited them (#163).
 */

/** The marker in either language: a conversation can be read back in a UI that has switched languages. */
const MARKERS = ["【画布引用】", "[Canvas references]"];

/** One cited node: the node's id, and the token the message shows for it. */
export type Citation = { id: string; label: string };

/** One line describing a cited node: `- <id> (<kind>) <label>: <prompt>`. */
export function referenceLine(id: string, kind: string, label: string, prompt: string): string {
    return `- ${id} (${kind}) ${label}${prompt ? `: ${prompt}` : ""}`;
}

/** The whole leading block, including the blank line that separates it from the prompt. */
export function referenceBlock(marker: string, lines: string[]): string {
    if (!lines.length) return "";
    return `${marker}\n${lines.join("\n")}\n\n`;
}

/**
 * The prompt without its leading reference block — what the user actually typed.
 *
 * A prompt that does not begin with a marker is returned unchanged, and so is one whose marker is not
 * followed by a blank line: guessing where the block ends would cut words off a message that only looked
 * like one.
 */
export function withoutReferences(prompt: string): string {
    const marker = MARKERS.find((candidate) => prompt.startsWith(`${candidate}\n`));
    if (!marker) return prompt;
    const blank = prompt.indexOf("\n\n");
    if (blank < 0) return prompt;
    return prompt.slice(blank + 2);
}

/**
 * The nodes a prompt cited, as the block recorded them: `- <id> (<kind>) <label>: <prompt>`.
 *
 * Reading the block back is what lets a mention in a message be a link to the node: the visible text
 * shows a label, and only the block says which node that label was.
 */
export function referenceEntries(prompt: string): Citation[] {
    const marker = MARKERS.find((candidate) => prompt.startsWith(`${candidate}\n`));
    if (!marker) return [];
    const end = prompt.indexOf("\n\n");
    if (end < 0) return [];
    const entries: Citation[] = [];
    for (const line of prompt.slice(marker.length + 1, end).split("\n")) {
        const match = /^-\s+(\S+)\s+\(([^)]*)\)\s*(.*)$/.exec(line);
        if (!match) continue;
        const rest = match[3] || "";
        const colon = rest.indexOf(": ");
        entries.push({ id: match[1], label: (colon >= 0 ? rest.slice(0, colon) : rest).trim() });
    }
    return entries;
}

/**
 * The label one more citation gets: what the node is called, and an ordinal when that name is taken.
 *
 * The token is what the message carries, so it has to be unique inside one message — otherwise two
 * citations read the same and there is nothing left to tell them apart but their order.
 */
export function citationLabel(base: string, taken: string[]): string {
    const name = base.trim();
    if (!taken.includes(name)) return name;
    for (let index = 2; ; index += 1) {
        const candidate = `${name} ${index}`;
        if (!taken.includes(candidate)) return candidate;
    }
}

type MentionSegment = { kind: "text"; text: string } | { kind: "link"; id: string; label: string };

/**
 * A message's text, cut into plain runs and `@label` citations, each link carrying the node's id.
 *
 * The ids come from the message itself — the block it was sent with — so two nodes with the same name
 * are two different links even though they read the same; a transcript written before labels were made
 * unique is read the same way, one citation per occurrence in the order they were cited, and an
 * occurrence past the last of them stays on the node that was cited. A name the canvas still has is the
 * fallback, so an answer that mentions a node is clickable too; it is only ever used when the message
 * cited nothing by that name.
 */
export function mentionSegments(text: string, citations: Citation[], nodes: Citation[]): MentionSegment[] {
    const cited = new Map<string, { queue: string[]; last: string }>();
    for (const citation of citations) {
        if (!citation.label) continue;
        const entry = cited.get(citation.label);
        if (entry) {
            entry.queue.push(citation.id);
            entry.last = citation.id;
        } else cited.set(citation.label, { queue: [citation.id], last: citation.id });
    }
    const named = new Map<string, string>();
    for (const node of nodes) {
        if (!node.label || named.has(node.label)) continue;
        named.set(node.label, node.id);
    }

    const labels = [...new Set([...named.keys(), ...cited.keys()])].sort((a, b) => b.length - a.length);
    if (!labels.length) return [{ kind: "text", text }];

    const segments: MentionSegment[] = [];
    let plain = "";
    let index = 0;
    while (index < text.length) {
        const label = text[index] === "@" ? labels.find((candidate) => text.startsWith(candidate, index + 1)) : undefined;
        const entry = label ? cited.get(label) : undefined;
        const id = label ? (entry ? (entry.queue.length ? entry.queue.shift() : entry.last) : named.get(label)) : undefined;
        if (!label || !id) {
            plain += text[index];
            index += 1;
            continue;
        }
        if (plain) segments.push({ kind: "text", text: plain });
        plain = "";
        segments.push({ kind: "link", id, label });
        index += 1 + label.length;
    }
    if (plain) segments.push({ kind: "text", text: plain });
    return segments;
}
