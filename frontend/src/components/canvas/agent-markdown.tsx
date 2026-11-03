import { Fragment, useMemo, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { parseInline, parseMarkdown, type MarkdownAlign, type MarkdownBlock, type MarkdownInline } from "@/lib/markdown";

/**
 * An answer, drawn as the document it is.
 *
 * The model writes headings, lists and tables; a `pre-wrap` paragraph showed the pipes instead of the
 * table, which is the whole reason this exists (#237). The tokens come from `lib/markdown`, and every run
 * of text is handed back to `renderText` — that is where the panel turns `@label` into a citation button,
 * so formatting and citation have to share the walk rather than run one after the other.
 *
 * **A table scrolls inside its own box.** An answer sits in a card a few hundred pixels wide, and a table
 * that widened the card would push the transcript and the input out of the window — so the cells do not
 * wrap and the box scrolls sideways. The rest of the block set has no width of its own beyond the text.
 */

/** What a run of plain text becomes: the panel's own renderer, so a citation stays clickable. */
type RenderText = (text: string) => ReactNode;

const BLOCK_GAP = "space-y-1.5 break-words";
const CODE_BLOCK = "thin-scrollbar mt-1 overflow-x-auto rounded-md bg-black/5 p-2 font-mono text-[12px] leading-5 dark:bg-white/10";
const INLINE_CODE = "rounded bg-black/5 px-1 py-px font-mono text-[0.92em] dark:bg-white/10";
const RULE = "my-2 border-black/10 dark:border-white/15";
const CELL = "whitespace-nowrap border border-black/10 px-2 py-1 align-top dark:border-white/15";
const ALIGN: Record<MarkdownAlign, string> = { left: "text-left", center: "text-center", right: "text-right" };

export function AgentMarkdown({ text, renderText }: { text: string; renderText: RenderText }) {
    const blocks = useMemo(() => parseMarkdown(text), [text]);
    return (
        <div className={BLOCK_GAP}>
            {blocks.map((block, index) => (
                <Block key={index} block={block} renderText={renderText} />
            ))}
        </div>
    );
}

function Block({ block, renderText }: { block: MarkdownBlock; renderText: RenderText }) {
    switch (block.kind) {
        case "paragraph":
            return (
                <p>
                    <Lines lines={block.lines} renderText={renderText} />
                </p>
            );
        case "heading":
            // A card is not a page: a level 1 and a level 2 read as the same slightly larger line, and the
            // deeper ones only keep the weight — six sizes in a 360px column is noise, not structure.
            return (
                <p className={block.level <= 2 ? "text-[15px] font-semibold" : "font-semibold"}>
                    <Inline tokens={parseInline(block.text)} renderText={renderText} />
                </p>
            );
        case "code":
            return (
                <pre className={CODE_BLOCK}>
                    <code>{block.text}</code>
                </pre>
            );
        case "rule":
            return <hr className={RULE} />;
        case "quote":
            return (
                <blockquote className="border-l-2 border-black/15 pl-2 opacity-80 dark:border-white/25">
                    {block.blocks.map((inner, index) => (
                        <Block key={index} block={inner} renderText={renderText} />
                    ))}
                </blockquote>
            );
        case "list": {
            // An item that is one sentence is that sentence, not a paragraph in a box: a bullet list of
            // steps would otherwise draw its spacing differently from a list of one-line items.
            const items = block.items.map((item, index) => (
                <li key={index}>{item.map((inner, position) => (inner.kind === "paragraph" ? <Lines key={position} lines={inner.lines} renderText={renderText} /> : <Block key={position} block={inner} renderText={renderText} />))}</li>
            ));
            return block.ordered ? (
                <ol start={block.start} className="list-decimal space-y-0.5 pl-5">
                    {items}
                </ol>
            ) : (
                <ul className="list-disc space-y-0.5 pl-5">{items}</ul>
            );
        }
        case "table":
            return (
                <div className="thin-scrollbar max-w-full overflow-x-auto">
                    <table className="w-max border-collapse text-[13px]">
                        <thead>
                            <tr>
                                {block.header.map((cell, column) => (
                                    <th key={column} className={cn(CELL, "font-semibold", ALIGN[block.align[column] ?? "left"])}>
                                        <Inline tokens={parseInline(cell)} renderText={renderText} />
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {block.rows.map((row, index) => (
                                <tr key={index}>
                                    {row.map((cell, column) => (
                                        <td key={column} className={cn(CELL, ALIGN[block.align[column] ?? "left"])}>
                                            <Inline tokens={parseInline(cell)} renderText={renderText} />
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
    }
}

/**
 * A paragraph's lines, or an item's, with the line breaks the model wrote.
 *
 * A soft break is a break here, and not the space CommonMark would make it: an answer is typed as one line
 * per thought, and under the `pre-wrap` these replaced every one of them stayed a break. Joining them would
 * silently reflow every reply ever written in this panel.
 */
function Lines({ lines, renderText }: { lines: string[]; renderText: RenderText }) {
    return (
        <>
            {lines.map((line, index) => (
                <Fragment key={index}>
                    {index ? <br /> : null}
                    <Inline tokens={parseInline(line)} renderText={renderText} />
                </Fragment>
            ))}
        </>
    );
}

function Inline({ tokens, renderText }: { tokens: MarkdownInline[]; renderText: RenderText }) {
    return (
        <>
            {tokens.map((token, index) => {
                switch (token.kind) {
                    case "text":
                        return <Fragment key={index}>{renderText(token.text)}</Fragment>;
                    case "code":
                        return (
                            <code key={index} className={INLINE_CODE}>
                                {token.text}
                            </code>
                        );
                    case "strong":
                        return (
                            <strong key={index} className="font-semibold">
                                <Inline tokens={token.tokens} renderText={renderText} />
                            </strong>
                        );
                    case "em":
                        return (
                            <em key={index}>
                                <Inline tokens={token.tokens} renderText={renderText} />
                            </em>
                        );
                    case "strike":
                        return (
                            <s key={index}>
                                <Inline tokens={token.tokens} renderText={renderText} />
                            </s>
                        );
                    case "link":
                        return (
                            <a key={index} href={token.href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                                <Inline tokens={token.tokens} renderText={renderText} />
                            </a>
                        );
                }
            })}
        </>
    );
}
