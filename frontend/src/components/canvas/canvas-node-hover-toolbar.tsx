import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Clapperboard, Download, Ellipsis, Info, Maximize2, Minus, Plus, Trash2, Ungroup } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Dialog } from "@/components/kit/dialog";
import { Segmented } from "@/components/kit/segmented";
import { Tooltip } from "@/components/kit/tooltip";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { formatBytes, getDataUrlByteSize } from "@/lib/image-utils";
import { readSetting, writeSetting } from "@/stores/use-settings-store";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";
import type { CanvasNodeToolbarItem } from "@/types/canvas-node";
import { ImageToolSettingsModal, type ImageToolbarSettingsTool } from "./canvas-image-toolbar-settings-modal";
import { IMAGE_QUICK_TOOLS_STORAGE_KEY, buildImageToolbarTools, defaultImageQuickToolIds, readImageQuickToolsConfig, type ImageQuickToolId } from "./canvas-image-toolbar-tools";

type CanvasNodeHoverToolbarProps = {
    node: CanvasNodeData | null;
    viewport: ViewportTransform;
    onKeep: (nodeId: string) => void;
    onLeave: () => void;
    onInfo: (node: CanvasNodeData) => void;
    onDecreaseFont: (node: CanvasNodeData) => void;
    onIncreaseFont: (node: CanvasNodeData) => void;
    onInterpolateVideo: (node: CanvasNodeData) => void;
    onDownload: (node: CanvasNodeData) => void;
    onCrop: (node: CanvasNodeData) => void;
    onSplit: (node: CanvasNodeData) => void;
    onUpscale: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    /** Opens the node's media at its own size — the clip's button, and the picture's `view` tool both. */
    onView: (node: CanvasNodeData) => void;
    onDelete: (node: CanvasNodeData) => void;
    onUngroup?: (node: CanvasNodeData) => void;
    extraTools?: CanvasNodeToolbarItem[];
};

type ToolbarTool = {
    id: string;
    title: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    active?: boolean;
    danger?: boolean;
};

export function CanvasNodeHoverToolbar({
    node,
    viewport,
    onKeep,
    onLeave,
    onInfo,
    onDecreaseFont,
    onIncreaseFont,
    onInterpolateVideo,
    onDownload,
    onCrop,
    onSplit,
    onUpscale,
    onAngle,
    onView,
    onDelete,
    onUngroup,
    extraTools = [],
}: CanvasNodeHoverToolbarProps) {
    const [quickImageToolIds, setQuickImageToolIds] = useState<ImageQuickToolId[]>(defaultImageQuickToolIds);
    const [showImageToolLabels, setShowImageToolLabels] = useState(false);
    const [draftImageToolIds, setDraftImageToolIds] = useState<ImageQuickToolId[]>(defaultImageQuickToolIds);
    const [draftShowImageToolLabels, setDraftShowImageToolLabels] = useState(false);
    const [imageToolSettingsOpen, setImageToolSettingsOpen] = useState(false);
    const { t } = useTranslation();

    useEffect(() => {
        // Whatever was saved is untrusted: it may predate a tool, or name one that is gone.
        const config = readImageQuickToolsConfig(readSetting(IMAGE_QUICK_TOOLS_STORAGE_KEY, null));
        if (!config.ids.length && !config.showLabels) return;
        setQuickImageToolIds(config.ids);
        setShowImageToolLabels(config.showLabels);
    }, []);

    useEffect(() => {
        setImageToolSettingsOpen(false);
    }, [node?.id]);

    if (!node) return null;

    const activeNode = node;
    const left = viewport.x + (node.position.x + node.width / 2) * viewport.k;
    const top = viewport.y + node.position.y * viewport.k - 14;
    const isImage = node.type === CanvasNodeType.Image;
    const isVideo = node.type === CanvasNodeType.Video;
    const isAudio = node.type === CanvasNodeType.Audio;
    const hasImage = isImage && Boolean(node.metadata?.content);
    const hasVideo = isVideo && Boolean(node.metadata?.content);
    const hasAudio = isAudio && Boolean(node.metadata?.content);
    const isText = node.type === CanvasNodeType.Text;
    const quickImageToolIdSet = new Set(quickImageToolIds);
    const imageTools = buildImageToolbarTools(node, { onCrop, onSplit, onUpscale, onAngle, onViewImage: onView });

    function openImageToolSettings() {
        onKeep(activeNode.id);
        setDraftImageToolIds(quickImageToolIds);
        setDraftShowImageToolLabels(showImageToolLabels);
        setImageToolSettingsOpen(true);
    }

    const baseToolbarTools: ToolbarTool[] = [
        { id: "info", title: t("canvas.nodeToolbar.infoTitle"), label: t("canvas.nodeToolbar.info"), icon: <Info className="size-4" />, onClick: () => onInfo(node) },
        ...(node.type === CanvasNodeType.Group && onUngroup ? [{ id: "ungroup", title: t("canvas.nodeToolbar.ungroupTitle"), label: t("canvas.nodeToolbar.ungroup"), icon: <Ungroup className="size-4" />, onClick: () => onUngroup(node) }] : []),
        { id: "delete", title: t("canvas.nodeToolbar.removeTitle"), label: t("common.delete"), icon: <Trash2 className="size-4" />, onClick: () => onDelete(node), danger: true },
    ];
    const nodeToolbarTools: ToolbarTool[] = [
        ...(hasImage || hasVideo || hasAudio
            ? [
                  {
                      id: "download",
                      title: t(hasAudio ? "canvas.nodeToolbar.downloadAudio" : hasVideo ? "canvas.nodeToolbar.downloadVideo" : "canvas.nodeToolbar.downloadImage"),
                      label: t("common.download"),
                      icon: <Download className="size-4" />,
                      onClick: () => onDownload(node),
                  },
              ]
            : []),
        ...(hasVideo ? [{ id: "videoInterpolate", title: t("canvas.nodeToolbar.interpolateTitle"), label: t("canvas.nodeToolbar.interpolate"), icon: <Clapperboard className="size-4" />, onClick: () => onInterpolateVideo(node) }] : []),
        // The card's double click opens a clip at its own size, and a gesture nobody can see is not a tool (#331).
        // Same act as the picture's `view`, so the same glyph, and last for the same reason it is last there.
        ...(hasVideo ? [{ id: "viewVideo", title: t("canvas.nodeToolbar.viewVideoTitle"), label: t("canvas.nodeToolbar.viewVideo"), icon: <Maximize2 className="size-4" />, onClick: () => onView(node) }] : []),
        ...(isText ? [{ id: "decreaseFont", title: t("canvas.nodeToolbar.decreaseFont"), label: t("canvas.nodeToolbar.zoomOut"), icon: <Minus className="size-4" />, onClick: () => onDecreaseFont(node) }] : []),
        ...(isText ? [{ id: "increaseFont", title: t("canvas.nodeToolbar.increaseFont"), label: t("canvas.nodeToolbar.zoomIn"), icon: <Plus className="size-4" />, onClick: () => onIncreaseFont(node) }] : []),
        ...(hasImage ? imageTools.map((tool) => ({ id: tool.id, title: tool.title, label: tool.label, icon: tool.icon, active: tool.active, onClick: tool.onClick })) : []),
    ];
    const toolbarTools = hasImage ? [...baseToolbarTools, ...nodeToolbarTools].filter((tool) => quickImageToolIdSet.has(tool.id as ImageQuickToolId)) : [...baseToolbarTools, ...nodeToolbarTools, ...extraTools];
    const selectableImageToolbarTools = [...baseToolbarTools, ...nodeToolbarTools].filter((tool) => tool.id !== "retry") as ImageToolbarSettingsTool[];

    const closeImageToolSettings = () => {
        setImageToolSettingsOpen(false);
        onLeave();
    };

    const setDraftImageToolVisible = (id: ImageQuickToolId, visible: boolean) => {
        setDraftImageToolIds((current) => {
            const selected = new Set(current);
            if (visible) selected.add(id);
            else selected.delete(id);
            return selectableImageToolbarTools.filter((tool) => selected.has(tool.id)).map((tool) => tool.id);
        });
    };

    const saveImageToolSettings = () => {
        const config = { ids: draftImageToolIds, showLabels: draftShowImageToolLabels };
        setQuickImageToolIds(config.ids);
        setShowImageToolLabels(config.showLabels);
        writeSetting(IMAGE_QUICK_TOOLS_STORAGE_KEY, config);
        closeImageToolSettings();
    };

    return (
        <>
            {/* Under the canvas chrome, with the node it belongs to: the bars, the dock and the side panel are
                the board's frame, and a node that slides under them takes its toolbar along (#192). At 70 it
                was drawn *over* the panel while the node itself was under it, which reads as a floating tool
                attached to nothing. */}
            <div
                className="absolute z-[45] flex h-12 -translate-x-1/2 -translate-y-full items-center overflow-visible rounded-[18px] border border-black/10 bg-white text-[15px] text-[#242529] shadow-[0_8px_28px_rgba(15,23,42,.12)]"
                data-node-toolbar={node.id}
                style={{ left, top }}
                onMouseEnter={() => onKeep(node.id)}
                onMouseLeave={() => {
                    if (!imageToolSettingsOpen) onLeave();
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
            >
                {toolbarTools.map((tool) => (
                    <ToolbarAction key={tool.id} {...tool} showLabel={isImage ? showImageToolLabels : true} />
                ))}
                {hasImage ? (
                    <ToolbarAction
                        id="more"
                        title={t("canvas.imageTools.configure")}
                        label={t("canvas.imageTools.more")}
                        icon={<Ellipsis className="size-4" />}
                        active={imageToolSettingsOpen}
                        onClick={openImageToolSettings}
                        showLabel={showImageToolLabels}
                    />
                ) : null}
            </div>
            {hasImage ? (
                <ImageToolSettingsModal
                    open={imageToolSettingsOpen}
                    tools={selectableImageToolbarTools}
                    selectedIds={draftImageToolIds}
                    showLabels={draftShowImageToolLabels}
                    onToggle={setDraftImageToolVisible}
                    onShowLabelsChange={setDraftShowImageToolLabels}
                    onCancel={closeImageToolSettings}
                    onSave={saveImageToolSettings}
                />
            ) : null}
        </>
    );
}

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

function ToolbarAction({ title, label, icon, onClick, showLabel, active = false, danger = false }: ToolbarTool & { showLabel: boolean }) {
    const hasText = showLabel && Boolean(label);
    return (
        <Tooltip title={title} placement="top" mouseEnterDelay={0.2} color="#ffffff" styles={{ root: { color: "#242529", boxShadow: "0 8px 24px rgba(15,23,42,.16)", fontSize: 13, fontWeight: 500 } }}>
            <button type="button" className={`group relative flex h-12 items-center whitespace-nowrap px-1.5 ${danger ? "text-[#ef4444]" : ""}`} onClick={onClick} aria-label={title}>
                <span className={`flex h-9 items-center ${hasText ? "gap-2 px-2.5" : "justify-center px-2"} rounded-lg transition group-hover:bg-[#f0f0f1] ${active ? "bg-[#eeeeef]" : ""}`}>
                    {icon}
                    {hasText ? <span>{label}</span> : null}
                </span>
            </button>
        </Tooltip>
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
