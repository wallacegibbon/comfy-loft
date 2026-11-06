import { FileText, Image as ImageIcon, Music2, Square, Type, Undo2, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PanelHeaderRow } from "@/components/canvas/canvas-side-panel-parts";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { nodeContentOf } from "@/lib/canvas/node-prompt-field";
import { previewUrlFor } from "@/services/image-storage";
import { CanvasNodeType, type CanvasNodeData, type CanvasTrashEntry } from "@/types/canvas";

/**
 * What this canvas deleted, and the way back (#327).
 *
 * It is the column's third list for one reason: an undo stack lives in a tab, and a mistake is usually noticed
 * after the tab has been closed, the canvas reopened, or the next day. What is here travels with the canvas, so
 * the way back is still there — and because a deleted node's picture stays on disk while the trash names it, a
 * restored row is the picture and not an empty card.
 *
 * A row is one node, not one deletion: putting back the one picture out of a batch of five is the ordinary
 * wish, and a list that could only be restored whole would refuse it.
 */
const NODE_TYPE_ICON: Record<string, typeof Square> = {
    [CanvasNodeType.Image]: ImageIcon,
    [CanvasNodeType.Video]: Video,
    [CanvasNodeType.Audio]: Music2,
    [CanvasNodeType.Text]: Type,
};

function nodeLabel(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return nodeContentOf(node);
    return getNodeDefinition(node.type)?.title || node.type;
}

/**
 * How long ago the deletion was, in the reader's own language.
 *
 * The agent's version of this sentence is English words in a tool answer (`sinceWords`); this one is read by a
 * person in whatever language the app is in, so it asks `Intl` rather than carrying a table of its own.
 */
function whenWords(iso: string, language: string): string {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return "";
    const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
    const seconds = Math.round((at - Date.now()) / 1000);
    for (const [unit, size] of [
        ["day", 86400],
        ["hour", 3600],
        ["minute", 60],
    ] as const) {
        if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
    }
    return format.format(seconds, "second");
}

export function CanvasDeletedSection({ trash, onRestoreNode }: { trash: CanvasTrashEntry[]; onRestoreNode: (nodeId: string) => void }) {
    const { t, i18n } = useTranslation();
    const theme = useCanvasTheme();

    return (
        <div className="flex h-full flex-col">
            <PanelHeaderRow>
                {trash.length ? <span className="shrink-0 text-xs opacity-35">{trash.length}</span> : null}
                <span className="ml-auto truncate text-xs opacity-45">{t("canvas.sidePanel.trashHint")}</span>
            </PanelHeaderRow>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {trash.length ? (
                    <div className="space-y-1.5">
                        {trash.map((entry) => {
                            const Icon = NODE_TYPE_ICON[entry.node.type] || FileText;
                            const isImage = entry.node.type === CanvasNodeType.Image && entry.node.metadata?.content;
                            const when = whenWords(entry.deletedAt, i18n.language);
                            return (
                                <div key={entry.node.id} data-trash-item className="group relative flex items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/5">
                                    <div className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-2">
                                        <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md">
                                            {isImage ? <img src={previewUrlFor(entry.node.metadata?.storageKey) || entry.node.metadata?.content} alt="" className="size-full object-cover" /> : <Icon className="size-5 opacity-60" />}
                                        </span>
                                        <span className="min-w-0 flex-1 space-y-0.5">
                                            <span className="block truncate text-sm font-medium leading-snug">{nodeLabel(entry.node)}</span>
                                            <span className="block truncate text-xs leading-snug opacity-50">
                                                {entry.node.id}
                                                {when ? ` · ${when}` : ""}
                                            </span>
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => onRestoreNode(entry.node.id)}
                                        className="mr-1 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                                        style={{ color: theme.node.text }}
                                        title={t("canvas.sidePanel.restoreTitle")}
                                    >
                                        <Undo2 className="size-3.5" />
                                        {t("canvas.sidePanel.restore")}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="pt-16 text-center text-sm opacity-40">{t("canvas.sidePanel.trashEmpty")}</div>
                )}
            </div>
        </div>
    );
}
