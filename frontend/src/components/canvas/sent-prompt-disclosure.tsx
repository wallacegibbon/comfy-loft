import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * What was actually sent, when it is not what the user typed.
 *
 * The canvas appends connected text behind the citation marker, numbers reference images and may prepend
 * the settings' system prompt. That composition is necessary — the request means nothing without it —
 * but it must not be silent, so the panel shows the exact string that went out.
 *
 * The count is characters, and `[...sent]` is what makes that word true: `sent.length` is UTF-16 code
 * units, so one emoji or one of the CJK ideographs outside the BMP would count as two. Bytes would be a
 * different fact and a worse one — the same Chinese character is three of them, so the number would
 * triple as the user switches language — and nothing in the pipeline interrupts a prompt at a byte
 * boundary: the gateway's own transcript truncates at 400 runes (docs/decisions.md #258).
 */
export function SentPromptDisclosure({ sent, current, className }: { sent?: string; current: string; className?: string }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    if (!sent || sent.trim() === current.trim()) return null;

    return (
        <div className={className || "mt-1.5 text-[11px] opacity-70"}>
            <button type="button" className="underline underline-offset-2" onClick={() => setOpen((value) => !value)}>
                {open ? t("canvas.promptPanel.sentPromptHide") : t("canvas.promptPanel.sentPrompt", { count: [...sent].length })}
            </button>
            {open ? <pre className="thin-scrollbar mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/10 p-2 font-mono text-[11px] leading-5">{sent}</pre> : null}
        </div>
    );
}
