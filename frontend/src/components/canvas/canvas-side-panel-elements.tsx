import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight, Download, Eye, FileText, Image as ImageIcon, LayoutGrid, ListChecks, Music2, Rows3, Search, Settings2, Square, Type, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CheckMark, PanelHeaderRow } from "@/components/canvas/canvas-side-panel-parts";
import { Input } from "@/components/kit/input";
import { Select } from "@/components/kit/select";
import { toast } from "@/components/kit/toast";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { exportCanvasNodes } from "@/lib/canvas/canvas-export";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { nodeWords } from "@/lib/canvas/node-prompt-field";
import { cn } from "@/lib/utils";
import { previewUrlFor, subscribeImagePreviews, getImagePreviewRevision } from "@/services/image-storage";
import { useCanvasSidePanelStore } from "@/stores/canvas/use-canvas-side-panel-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * What is on this canvas, as a list: every node, with its picture, searchable and filterable, one click from
 * the node itself.
 *
 * It is the column's other section (#195). It used to be the whole panel, with a heading of its own; the
 * column's switch names it now, so the row starts with the count and the controls. Hovering a row shows the
 * node's media over the canvas and clicking one takes the view there — that pair is why this list is worth a
 * column at all: on a board grown past the window, it is the only way to find a node by name and look at it
 * without hunting for it first.
 */

const NODE_TYPE_ICON: Record<string, typeof Square> = {
    [CanvasNodeType.Image]: ImageIcon,
    [CanvasNodeType.Video]: Video,
    [CanvasNodeType.Audio]: Music2,
    [CanvasNodeType.Text]: Type,
    [CanvasNodeType.Config]: Settings2,
    [CanvasNodeType.Group]: Square,
};

const STATUS_COLOR: Record<string, string> = {
    success: "#22c55e",
    loading: "#f59e0b",
    error: "#ef4444",
    idle: "transparent",
};

const NODE_FILTER_VALUES = ["all", CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Text, CanvasNodeType.Audio, CanvasNodeType.Config, CanvasNodeType.Group];

function nodePreviewText(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return getNodeDefinition(node.type)?.title || node.type;
}

export function CanvasElementsSection({
    nodes,
    selectedNodeIds,
    onFocusNode,
    onPreviewNode,
    onHoverNode,
}: {
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    onFocusNode: (nodeId: string) => void;
    onPreviewNode: (nodeId: string) => void;
    onHoverNode: (nodeId: string | null) => void;
}) {
    const { t } = useTranslation();
    const theme = useCanvasTheme();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const [keyword, setKeyword] = useState("");
    const [typeFilter, setTypeFilter] = useState<string>("all");
    const [selectMode, setSelectMode] = useState(false);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
    const [exporting, setExporting] = useState(false);
    const nodeViewMode = useCanvasSidePanelStore((state) => state.nodeViewMode);
    const setNodeViewMode = useCanvasSidePanelStore((state) => state.setNodeViewMode);

    const orderedNodes = useMemo(() => [...nodes].reverse(), [nodes]);
    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return orderedNodes.filter((node) => (typeFilter === "all" || node.type === typeFilter) && (!query || nodeWords(node).toLowerCase().includes(query)));
    }, [orderedNodes, keyword, typeFilter]);
    const treeRows = useMemo(() => {
        const filteredIds = new Set(filtered.map((node) => node.id));
        const groups = new Set(orderedNodes.filter((node) => node.type === CanvasNodeType.Group).map((node) => node.id));
        const children = new Map<string, CanvasNodeData[]>();
        filtered.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId && groups.has(groupId)) children.set(groupId, [...(children.get(groupId) || []), node]);
        });
        return orderedNodes.flatMap((node) => {
            if (node.metadata?.groupId && groups.has(node.metadata.groupId)) return [];
            if (node.type !== CanvasNodeType.Group) return filteredIds.has(node.id) ? [{ node, depth: 0, hasChildren: false }] : [];
            const groupChildren = children.get(node.id) || [];
            if (!filteredIds.has(node.id) && !groupChildren.length) return [];
            return [{ node, depth: 0, hasChildren: groupChildren.length > 0 }, ...(collapsedGroups.has(node.id) ? [] : groupChildren.map((child) => ({ node: child, depth: 1, hasChildren: false })))];
        });
    }, [collapsedGroups, filtered, orderedNodes]);

    const exitSelect = () => {
        setSelectMode(false);
        setChecked(new Set());
    };
    const toggleChecked = (id: string) =>
        setChecked((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    const allChecked = filtered.length > 0 && filtered.every((node) => checked.has(node.id));
    const toggleAll = () => setChecked(allChecked ? new Set() : new Set(filtered.map((node) => node.id)));

    // Let the hover preview fade out before the canvas starts moving to the node.
    const PRESS_FOCUS_DELAY = 180;
    const focusTimerRef = useRef<number | null>(null);
    useEffect(
        () => () => {
            if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
        },
        [],
    );
    const activateNode = (node: CanvasNodeData) => {
        if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
        const hasPreview = (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) && Boolean(node.metadata?.content);
        if (!hasPreview) {
            onFocusNode(node.id);
            return;
        }
        onHoverNode(null);
        focusTimerRef.current = window.setTimeout(() => {
            focusTimerRef.current = null;
            onFocusNode(node.id);
        }, PRESS_FOCUS_DELAY);
    };

    const handleExport = async () => {
        const targets = nodes.filter((node) => checked.has(node.id));
        if (!targets.length) return;
        setExporting(true);
        const hide = toast.loading(t("canvas.sidePanel.exporting"));
        try {
            await exportCanvasNodes(targets, t("canvas.sidePanel.exportName", { count: targets.length }));
            toast.success(t("canvas.sidePanel.exported", { count: targets.length }));
            exitSelect();
        } catch (error) {
            console.error(error);
            toast.error(t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
            setExporting(false);
        }
    };

    // An empty list has two reasons and they are not the same sentence. It used to say "no nodes on this
    // canvas" for both, so a search that found nothing read as if the panel had lost its contents.
    const emptyText = keyword.trim() ? t("canvas.sidePanel.noMatch") : t("canvas.sidePanel.noNodes");

    return (
        <div className="flex h-full flex-col" onMouseLeave={() => onHoverNode(null)}>
            <PanelHeaderRow>
                {filtered.length ? <span className="shrink-0 text-xs opacity-35">{filtered.length}</span> : null}
                <button
                    type="button"
                    onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
                    className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-xs font-medium opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                    style={selectMode ? { color: theme.toolbar.activeText, opacity: 1 } : undefined}
                >
                    <ListChecks className="size-3.5" />
                    {selectMode ? t("common.cancel") : t("canvas.sidePanel.select")}
                </button>
                {selectMode ? null : (
                    <Select
                        size="small"
                        variant="borderless"
                        className="w-20"
                        value={typeFilter}
                        onChange={setTypeFilter}
                        options={NODE_FILTER_VALUES.map((value) => ({ value, label: value === "all" ? t("common.all") : t(`canvas.sidePanel.filter.${value}`) }))}
                    />
                )}
                <button
                    type="button"
                    onClick={() => setNodeViewMode(nodeViewMode === "grid" ? "list" : "grid")}
                    className="flex shrink-0 items-center rounded-md px-1.5 py-1 opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                    title={nodeViewMode === "grid" ? t("canvas.sidePanel.viewList") : t("canvas.sidePanel.viewGrid")}
                    aria-label={nodeViewMode === "grid" ? t("canvas.sidePanel.viewList") : t("canvas.sidePanel.viewGrid")}
                >
                    {nodeViewMode === "grid" ? <Rows3 className="size-3.5" /> : <LayoutGrid className="size-3.5" />}
                </button>
            </PanelHeaderRow>
            <div className="px-3 pb-2.5">
                <Input size="small" allowClear prefix={<Search className="size-3.5 text-stone-400" />} placeholder={t("canvas.sidePanel.searchNodes")} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {nodeViewMode === "grid" ? (
                    filtered.length ? (
                        <div className="grid gap-2 px-1 [grid-template-columns:repeat(auto-fill,minmax(88px,1fr))]">
                            {filtered.map((node) => {
                                const Icon = NODE_TYPE_ICON[node.type] || FileText;
                                const isImage = node.type === CanvasNodeType.Image && node.metadata?.content;
                                const isChecked = checked.has(node.id);
                                const active = selectMode ? isChecked : selectedNodeIds.has(node.id);
                                return (
                                    <button
                                        key={node.id}
                                        type="button"
                                        data-node-item
                                        onClick={() => (selectMode ? toggleChecked(node.id) : activateNode(node))}
                                        onMouseEnter={() => onHoverNode(node.id)}
                                        onMouseLeave={(event) => {
                                            const to = event.relatedTarget as Element | null;
                                            if (!to || !to.closest("[data-node-item]")) onHoverNode(null);
                                        }}
                                        className="group relative flex min-w-0 flex-col rounded-lg p-1 text-left transition hover:bg-black/5 dark:hover:bg-white/5"
                                        style={active ? { background: theme.toolbar.activeBg } : undefined}
                                        title={selectMode ? undefined : t("canvas.sidePanel.focusNode")}
                                    >
                                        <span className="relative grid aspect-square w-full place-items-center overflow-hidden rounded-md">
                                            {isImage ? <img src={previewUrlFor(node.metadata?.storageKey) || node.metadata?.content} alt={node.title} className="size-full object-cover" /> : <Icon className="size-6 opacity-60" />}
                                            {selectMode ? (
                                                <span className="absolute left-1 top-1">
                                                    <CheckMark checked={isChecked} theme={theme} />
                                                </span>
                                            ) : null}
                                            {node.metadata?.status && node.metadata.status !== "idle" ? <span className="absolute right-1 top-1 size-1.5 rounded-full" style={{ background: STATUS_COLOR[node.metadata.status] || "transparent" }} /> : null}
                                        </span>
                                        <span className="mt-1 block truncate text-xs font-medium leading-snug">{node.title || getNodeDefinition(node.type)?.title || t("canvas.node.untitled")}</span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="pt-16 text-center text-sm opacity-40">{emptyText}</div>
                    )
                ) : treeRows.length ? (
                    <div className="space-y-1.5">
                        {treeRows.map(({ node, depth, hasChildren }) => {
                            const Icon = NODE_TYPE_ICON[node.type] || FileText;
                            const isImage = node.type === CanvasNodeType.Image && node.metadata?.content;
                            const isChecked = checked.has(node.id);
                            const active = selectMode ? isChecked : selectedNodeIds.has(node.id);
                            return (
                                <Fragment key={node.id}>
                                    <div
                                        data-node-item
                                        className={cn("group relative flex items-center rounded-lg transition", depth && "ml-5", active ? "" : "hover:bg-black/5 dark:hover:bg-white/5")}
                                        style={active ? { background: theme.toolbar.activeBg } : undefined}
                                        onMouseEnter={() => onHoverNode(node.id)}
                                        onMouseLeave={(event) => {
                                            const to = event.relatedTarget as Element | null;
                                            if (!to || !to.closest("[data-node-item]")) onHoverNode(null);
                                        }}
                                    >
                                        {depth ? <span className="pointer-events-none absolute -left-3 top-[calc(-50%-0.4rem)] h-[calc(100%+0.4rem)] w-3 rounded-bl-md border-b border-l opacity-45" style={{ borderColor: theme.node.stroke }} /> : null}
                                        {node.type === CanvasNodeType.Group && hasChildren ? (
                                            <button
                                                type="button"
                                                onClick={() => setCollapsedGroups((prev) => (prev.has(node.id) ? new Set([...prev].filter((id) => id !== node.id)) : new Set(prev).add(node.id)))}
                                                className="ml-1 grid size-6 shrink-0 place-items-center opacity-55 transition hover:opacity-100"
                                                aria-label={node.title}
                                            >
                                                <ChevronRight className={cn("size-3.5 transition-transform", !collapsedGroups.has(node.id) && "rotate-90")} />
                                            </button>
                                        ) : null}
                                        <button
                                            type="button"
                                            onClick={() => (selectMode ? toggleChecked(node.id) : activateNode(node))}
                                            className={cn("flex min-w-0 flex-1 items-center gap-3 py-2 pr-2 text-left", node.type === CanvasNodeType.Group && hasChildren ? "pl-0" : "pl-2")}
                                            title={selectMode ? undefined : t("canvas.sidePanel.focusNode")}
                                        >
                                            {selectMode ? <CheckMark checked={isChecked} theme={theme} /> : null}
                                            <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md">
                                                {isImage ? <img src={previewUrlFor(node.metadata?.storageKey) || node.metadata?.content} alt={node.title} className="size-full object-cover" /> : <Icon className="size-5 opacity-60" />}
                                            </span>
                                            <span className="min-w-0 flex-1 space-y-0.5">
                                                <span className="block truncate text-sm font-medium leading-snug">{node.title || getNodeDefinition(node.type)?.title || t("canvas.node.untitled")}</span>
                                                <span className="block truncate text-xs leading-snug opacity-50">{nodePreviewText(node)}</span>
                                            </span>
                                            {node.metadata?.status && node.metadata.status !== "idle" ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[node.metadata.status] || "transparent" }} /> : null}
                                        </button>
                                        {selectMode || !isImage ? null : (
                                            <div className="flex shrink-0 flex-col items-center gap-0.5 pr-1.5">
                                                <button
                                                    type="button"
                                                    onClick={() => onPreviewNode(node.id)}
                                                    className="grid size-7 place-items-center rounded-md opacity-55 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                                                    aria-label={t("canvas.sidePanel.preview")}
                                                    title={t("canvas.sidePanel.preview")}
                                                >
                                                    <Eye className="size-3.5" />
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </Fragment>
                            );
                        })}
                    </div>
                ) : (
                    <div className="pt-16 text-center text-sm opacity-40">{emptyText}</div>
                )}
            </div>
            {selectMode ? (
                <div className="flex items-center gap-2 border-t px-3 py-2.5" style={{ borderColor: theme.toolbar.border }}>
                    <button type="button" onClick={toggleAll} className="rounded-md px-2 py-1 text-xs font-medium opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10">
                        {allChecked ? t("canvas.sidePanel.clearAll") : t("workbench.selectAll")}
                    </button>
                    <span className="text-xs opacity-45">{t("canvas.sidePanel.selected", { count: checked.size })}</span>
                    <button
                        type="button"
                        onClick={() => void handleExport()}
                        disabled={!checked.size || exporting}
                        className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10"
                        style={{ color: theme.node.text }}
                    >
                        <Download className="size-3.5" />
                        {t("canvas.exportSelected")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
