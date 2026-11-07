import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useTranslation } from "react-i18next";

import { Dialog } from "@/components/kit/dialog";
import { Segmented } from "@/components/kit/segmented";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { formatBytes, getDataUrlByteSize } from "@/lib/image-utils";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function CanvasNodeInfoModal({ node, open, onClose }: { node: CanvasNodeData | null; open: boolean; onClose: () => void }) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    const [view, setView] = useState<"info" | "json">("info");
    const imageBytes = node?.type === CanvasNodeType.Image && node.metadata?.content ? getDataUrlByteSize(node.metadata.content) : 0;
    const json = useMemo(() => {
        if (!node) return "";
        return JSON.stringify(
            node,
            (key, value) => {
                if (key === "content" && typeof value === "string" && value.startsWith("data:image/")) {
                    return "[base64 image]";
                }
                return value;
            },
            2,
        );
    }, [node]);

    useEffect(() => {
        if (open) setView("info");
    }, [node?.id, open]);

    const title = (
        <div className="flex items-center justify-between gap-4 pr-12">
            <span>{t("canvas.nodeToolbar.nodeInfo")}</span>
            <Segmented
                size="small"
                value={view}
                onChange={(value) => setView(value as "info" | "json")}
                options={[
                    { label: t("canvas.nodeToolbar.info"), value: "info" },
                    { label: "JSON", value: "json" },
                ]}
            />
        </div>
    );

    return (
        <Dialog title={title} open={open && Boolean(node)} onClose={onClose} size="panel" bodyClassName="flex flex-col">
            {node ? (
                <div className="min-h-0 flex-1 select-text text-sm" data-canvas-shortcuts-ignore>
                    {view === "info" ? (
                        <div className="thin-scrollbar grid h-full grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-5 gap-y-3 overflow-auto pr-1">
                            <InfoRow label="ID" value={node.id} />
                            <InfoRow
                                label={t("canvas.nodeToolbar.type")}
                                value={
                                    node.type === CanvasNodeType.Group
                                        ? t("canvas.node.group")
                                        : [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text].includes(node.type as CanvasNodeType)
                                          ? t(`canvas.nodeTypes.${node.type}`)
                                          : getNodeDefinition(node.type)?.title || node.type
                                }
                            />
                            <InfoRow label={t("canvas.nodeToolbar.size")} value={`${Math.round(node.width)} x ${Math.round(node.height)}`} />
                            <InfoRow label={t("canvas.nodeToolbar.position")} value={`${Math.round(node.position.x)}, ${Math.round(node.position.y)}`} />
                            <InfoRow label={t("canvas.nodeToolbar.status")} value={node.metadata?.status || "idle"} />
                            {/* What made this content and when it stopped — the same two facts the agent is
                                told, in the reader's own clock (#227). */}
                            {node.metadata?.workflow ? <InfoRow label={t("canvas.nodeToolbar.workflow")} value={node.metadata.workflow} /> : null}
                            {node.metadata?.generatedAt ? <InfoRow label={t("canvas.nodeToolbar.generatedAt")} value={new Date(node.metadata.generatedAt).toLocaleString()} /> : null}
                            {node.metadata?.prompt ? <InfoRow label={t("canvas.nodeToolbar.prompt")} value={node.metadata.prompt} /> : null}
                            {node.metadata?.runId ? <InfoRow label={t("canvas.nodeToolbar.runId")} value={node.metadata.runId} /> : null}
                            {imageBytes ? <InfoRow label={t("canvas.nodeToolbar.imageSize")} value={formatBytes(imageBytes)} /> : null}
                            {node.metadata?.errorDetails ? (
                                <div className="col-span-2 rounded-lg border p-3 text-red-400" style={{ borderColor: theme.node.stroke }}>
                                    {node.metadata.errorDetails}
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <pre className="thin-scrollbar h-full overflow-auto rounded-lg border p-3 text-xs leading-5" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}>
                            {json}
                        </pre>
                    )}
                </div>
            ) : null}
        </Dialog>
    );
}

/**
 * One fact about the node: its key, and what the key says.
 *
 * A fragment rather than a row of its own, because the *list* is the grid and its first column is `max-content`:
 * the key column is one column for the whole panel, sized to the widest key in it. It used to be a grid per
 * row with a 72px key column, which is a number somebody guessed: "Generated at" wrapped onto two lines while
 * "ID" left most of its cell empty, and a translation only has to be a little longer than the last one for the
 * next key to wrap too. Sizing the column by its own words is the rule that cannot go stale — a key is as wide
 * as it is, in whatever language the reader is in.
 *
 * The value keeps `min-w-0` and `break-words`: a prompt is a paragraph, and it is the value that gives way when
 * the panel is narrow, never the key.
 */
function InfoRow({ label, value }: { label: string; value: ReactNode }) {
    return (
        <>
            <span className="opacity-50">{label}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{value}</span>
        </>
    );
}
