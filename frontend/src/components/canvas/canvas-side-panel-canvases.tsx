import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Download, FileUp, ListChecks, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CheckMark } from "@/components/canvas/canvas-side-panel-parts";
import { Button } from "@/components/kit/button";
import { Dropdown } from "@/components/kit/floating";
import { Input } from "@/components/kit/input";
import { toast } from "@/components/kit/toast";
import { Tooltip } from "@/components/kit/tooltip";
import { exportCanvas } from "@/lib/canvas/canvas-export";
import { byUpdatedAtDesc } from "@/lib/canvas/last-canvas";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { apiErrorMessage } from "@/services/api/http";
import { useCanvasListStore } from "@/stores/canvas/use-canvas-list-store";
import { useCanvasSidePanelStore } from "@/stores/canvas/use-canvas-side-panel-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

/**
 * The canvases in the workspace, as a list in the left column.
 *
 * This was a 1000×760 window over the canvas (`canvas-manager-dialog.tsx`), and before that a route. It is
 * a section of the column now (#195): the column is the app's one list surface, it is already open while
 * you work, and a management surface that has to be summoned and dismissed is a mode, not a place.
 *
 * What the window had and this keeps: create, import, rename, export one, delete one, delete several. Two
 * things changed shape because a 280px column is not a 1000px dialog — the tall card became a row, and
 * "delete all" became select-all: the list already knows how to select, and one dangerous button for the
 * whole workspace is a trap, not a feature. The confirmation dialog it opens is unchanged.
 *
 * The two lists in the column are the same gesture, deliberately: select mode on the right of the header
 * row, then a bar at the foot with select-all, a count and the one action (delete here, export in the
 * elements list).
 */
export function CanvasCanvasesSection({ projectId }: { projectId: string }) {
    const { i18n, t } = useTranslation();
    const theme = useCanvasTheme();
    const navigate = useNavigate();
    const ready = useCanvasStore((state) => state.ready);
    const canvases = useCanvasStore((state) => state.canvases);
    const createCanvas = useCanvasStore((state) => state.createCanvas);
    const importCanvas = useCanvasStore((state) => state.importCanvas);
    const loadCanvas = useCanvasStore((state) => state.loadCanvas);
    const renameCanvas = useCanvasStore((state) => state.renameCanvas);
    const selectedIds = useCanvasListStore((state) => state.selectedProjectIds);
    const toggleSelected = useCanvasListStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasListStore((state) => state.setDeleteProjectIds);
    const editingId = useCanvasListStore((state) => state.editingProjectId);
    const editingTitle = useCanvasListStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasListStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasListStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasListStore((state) => state.stopEditingProject);
    const setSection = useCanvasSidePanelStore((state) => state.setSection);
    const [selectMode, setSelectMode] = useState(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const ordered = useMemo(() => [...canvases].sort(byUpdatedAtDesc), [canvases]);

    /**
     * Go to a canvas.
     *
     * The column follows you to the elements list: the question "which canvas?" has just been answered, and
     * the next one is about that canvas. It is also what the window did — it closed on the way in.
     */
    const enterCanvas = (id: string) => {
        setSelectMode(false);
        setSection("elements");
        navigate(`/canvas/${id}`);
    };

    const createAndEnter = async () => {
        try {
            enterCanvas(await createCanvas(t("canvas.defaultTitle", { count: canvases.length + 1 })));
        } catch (error) {
            console.error(error);
            toast.error(t("canvas.createFailed"));
        }
    };

    const importArchive = async (file?: File) => {
        if (!file) return;
        try {
            enterCanvas(await importCanvas(file));
            toast.success(t("canvas.imported"));
        } catch (error) {
            console.error(error);
            toast.error(apiErrorMessage(error, t("canvas.importFailed")));
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    /** Export one canvas: the archive is the canvas directory, so it has to be read before it can be written. */
    const exportOne = async (id: string) => {
        try {
            const loaded = await loadCanvas(id);
            if (loaded) await exportCanvas(loaded, loaded.title || t("canvas.title"));
        } catch (error) {
            console.error(error);
            toast.error(t("canvas.sidePanel.exportFailed"));
        }
    };

    const saveTitle = (id: string) => {
        void renameCanvas(id, editingTitle);
        stopEditing();
    };

    const allSelected = ordered.length > 0 && ordered.every((canvas) => selectedIds.includes(canvas.id));

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-1 px-3 pb-2.5 pt-1">
                <Tooltip title={t("canvas.create")}>
                    <button
                        type="button"
                        disabled={!ready}
                        onClick={() => void createAndEnter()}
                        aria-label={t("canvas.create")}
                        className="grid size-7 place-items-center rounded-md transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10"
                        style={{ color: theme.node.text }}
                    >
                        <Plus className="size-4" />
                    </button>
                </Tooltip>
                <Tooltip title={t("canvas.import")}>
                    <button
                        type="button"
                        disabled={!ready}
                        onClick={() => fileInputRef.current?.click()}
                        aria-label={t("canvas.import")}
                        className="grid size-7 place-items-center rounded-md transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10"
                        style={{ color: theme.node.text }}
                    >
                        <FileUp className="size-4" />
                    </button>
                </Tooltip>
                <button
                    type="button"
                    onClick={() => setSelectMode((current) => !current)}
                    className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-xs font-medium opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                    style={selectMode ? { color: theme.toolbar.activeText, opacity: 1 } : undefined}
                >
                    <ListChecks className="size-3.5" />
                    {selectMode ? t("common.cancel") : t("canvas.sidePanel.select")}
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {!ready ? (
                    <div className="pt-16 text-center text-sm opacity-40">{t("canvas.loading")}</div>
                ) : ordered.length ? (
                    <div className="space-y-1">
                        {ordered.map((canvas) => {
                            const current = canvas.id === projectId;
                            const editing = editingId === canvas.id;
                            const checked = selectedIds.includes(canvas.id);
                            const active = selectMode ? checked : current;
                            return (
                                <div key={canvas.id} data-canvas-row className="group flex items-center gap-1 rounded-lg pl-1 pr-0.5 transition" style={active ? { background: theme.toolbar.activeBg } : undefined}>
                                    {selectMode ? (
                                        <button type="button" onClick={() => toggleSelected(canvas.id, !checked)} className="grid size-6 shrink-0 place-items-center" aria-label={t("canvas.project.select", { name: canvas.title })}>
                                            <CheckMark checked={checked} theme={theme} />
                                        </button>
                                    ) : null}
                                    {editing ? (
                                        <div className="min-w-0 flex-1 py-1.5">
                                            <Input
                                                autoFocus
                                                value={editingTitle}
                                                onChange={(event) => setEditingTitle(event.target.value)}
                                                onKeyDown={(event) => {
                                                    if (event.key === "Enter") saveTitle(canvas.id);
                                                    if (event.key === "Escape") stopEditing();
                                                }}
                                            />
                                        </div>
                                    ) : (
                                        <button type="button" onClick={() => (selectMode ? toggleSelected(canvas.id, !checked) : enterCanvas(canvas.id))} className="min-w-0 flex-1 py-2 text-left">
                                            <span className="flex min-w-0 items-center gap-1.5">
                                                <span className="truncate text-sm font-medium leading-snug">{canvas.title}</span>
                                                {/* The canvas you are in, marked: the column is always on screen, so "where am I" has to be. */}
                                                {current ? <Check className="size-3 shrink-0 opacity-55" /> : null}
                                            </span>
                                            <span className="block truncate text-xs leading-snug opacity-45">
                                                {t("canvas.project.updated", { date: new Date(canvas.updatedAt).toLocaleString(i18n.resolvedLanguage, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) })}
                                            </span>
                                        </button>
                                    )}
                                    {selectMode || editing ? null : (
                                        <Dropdown
                                            menu={{
                                                items: [
                                                    { key: "export", icon: <Download className="size-4" />, label: t("canvas.project.export"), onClick: () => void exportOne(canvas.id) },
                                                    { key: "rename", icon: <Pencil className="size-4" />, label: t("canvas.project.rename"), onClick: () => startEditing(canvas.id, canvas.title) },
                                                    { type: "divider", key: "delete-divider" },
                                                    { key: "delete", danger: true, icon: <Trash2 className="size-4" />, label: t("canvas.project.delete"), onClick: () => setDeleteIds([canvas.id]) },
                                                ],
                                            }}
                                        >
                                            <button
                                                type="button"
                                                className="grid size-7 shrink-0 place-items-center rounded-md opacity-40 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                                                aria-label={t("canvas.project.more")}
                                                style={{ color: theme.node.text }}
                                            >
                                                <MoreHorizontal className="size-4" />
                                            </button>
                                        </Dropdown>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="flex flex-col items-center px-6 pt-12 text-center">
                        <h2 className="text-sm font-medium">{t("canvas.empty")}</h2>
                        <p className="mt-2 text-xs leading-relaxed opacity-50">{t("canvas.emptyDescription")}</p>
                        <Button type="primary" size="small" className="mt-4" icon={<Plus className="size-4" />} onClick={() => void createAndEnter()}>
                            {t("canvas.create")}
                        </Button>
                    </div>
                )}
            </div>

            {selectMode ? (
                <div className="flex items-center gap-2 border-t px-3 py-2.5" style={{ borderColor: theme.toolbar.border }}>
                    <button
                        type="button"
                        onClick={() => (allSelected ? ordered.forEach((canvas) => toggleSelected(canvas.id, false)) : ordered.forEach((canvas) => toggleSelected(canvas.id, true)))}
                        className="rounded-md px-2 py-1 text-xs font-medium opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                    >
                        {allSelected ? t("canvas.sidePanel.clearAll") : t("workbench.selectAll")}
                    </button>
                    <span className="text-xs opacity-45">{t("canvas.sidePanel.selected", { count: selectedIds.length })}</span>
                    <button
                        type="button"
                        onClick={() => setDeleteIds(selectedIds)}
                        disabled={!selectedIds.length}
                        className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-400"
                    >
                        <Trash2 className="size-3.5" />
                        {t("common.delete")}
                    </button>
                </div>
            ) : null}

            <input ref={fileInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importArchive(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </div>
    );
}
