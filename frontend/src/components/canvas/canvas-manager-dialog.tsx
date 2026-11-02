import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Download, FileUp, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { Dialog } from "@/components/kit/dialog";
import { toast } from "@/components/kit/toast";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import { documentOf } from "@/lib/canvas/canvas-document";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { readZip } from "@/lib/zip";
import { fileNameOf, writeCanvasFile } from "@/services/canvas-files";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasListStore } from "@/stores/canvas/use-canvas-list-store";
import { useCanvasPanelStore } from "@/stores/canvas/use-canvas-panel-store";
import type { CanvasExportFile } from "@/types/canvas-export";

/**
 * The canvas list, floating over the canvas you are already in.
 *
 * This used to be a route (`/canvas`), which meant opening a panel that shows six cards
 * cost you an unmount of the canvas, a route change and a full remount to get back. The
 * list is a management surface: nobody bookmarks it, nobody shares its URL, and refreshing
 * it is meaningless. Only a canvas is worth an address.
 *
 * The body is the old page unchanged — multi-select, batch export, import, delete — because
 * that is the part that was always right. `CanvasDeleteProjectsDialog` is a sibling rather
 * than a child so the two dialogs are independent radix roots instead of a nested trap.
 */
function projectTitle(project: { title: string }) {
    return project.title || "";
}

export function CanvasManagerDialog() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const inputRef = useRef<HTMLInputElement>(null);
    const open = useCanvasPanelStore((state) => state.canvasManagerOpen);
    const setOpen = useCanvasPanelStore((state) => state.setCanvasManagerOpen);
    const ready = useCanvasStore((state) => state.ready);
    const canvases = useCanvasStore((state) => state.canvases);
    const createCanvas = useCanvasStore((state) => state.createCanvas);
    const deleteCanvases = useCanvasStore((state) => state.deleteCanvases);
    const loadCanvas = useCanvasStore((state) => state.loadCanvas);
    const selectedIds = useCanvasListStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasListStore((state) => state.setDeleteProjectIds);

    const enterProject = (id: string) => {
        setOpen(false);
        navigate(`/canvas/${id}`);
    };
    const createAndEnter = async () => {
        try {
            enterProject(await createCanvas(t("canvas.defaultTitle", { count: canvases.length + 1 })));
        } catch (error) {
            console.error(error);
            toast.error(t("canvas.createFailed"));
        }
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("missing projects.json");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            // Each project becomes a canvas, carrying the document it was exported with. Only the id is new
            // — the exported one belongs to the canvas it came from, which still exists — and nothing inside
            // the document names a canvas, so nothing has to be rewritten.
            for (const item of data.projects) {
                const id = await createCanvas(projectTitle(item.project) || t("canvas.project.imported"), documentOf(item.project));
                try {
                    // The files keep the names the document uses. That is why this writes them instead of
                    // uploading: an upload names files itself, and every `files/<name>` reference would then
                    // have to be rewritten to whatever it chose.
                    for (const entry of item.files) {
                        const name = fileNameOf(entry.storageKey);
                        const blob = zip.get(entry.path);
                        if (!name || !blob) throw new Error(`the archive has no ${entry.path}`);
                        await writeCanvasFile(id, name, blob.type ? blob : blob.slice(0, blob.size, entry.mimeType));
                    }
                } catch (error) {
                    // Nothing references these files yet, so this canvas is a shell: remove it rather than
                    // leave a project in the list that cannot be opened.
                    await deleteCanvases([id]).catch(() => undefined);
                    throw error;
                }
            }
            toast.success(t("canvas.imported", { count: data.projects.length }));
        } catch {
            toast.error(t("canvas.importFailed"));
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    return (
        <>
            <Dialog open={open} onClose={() => setOpen(false)} title={t("canvas.title")} size="panel" bodyClassName="pr-1">
                <div className="flex flex-wrap items-center justify-end gap-2">
                    {selectedIds.length ? (
                        <>
                            <Button
                                disabled={!ready}
                                icon={<Download className="size-4" />}
                                onClick={() =>
                                    void (async () => {
                                        const loaded = await Promise.all(selectedIds.map((id) => loadCanvas(id)));
                                        await exportCanvasProjects(
                                            loaded.filter((project): project is NonNullable<typeof project> => Boolean(project)),
                                            `${t("canvas.title")}-${selectedIds.length}`,
                                        );
                                    })()
                                }
                            >
                                {t("canvas.exportSelected")}
                            </Button>
                            <Button disabled={!ready} onClick={() => setDeleteIds(selectedIds)}>
                                {t("canvas.deleteSelected")}
                            </Button>
                        </>
                    ) : null}
                    {canvases.length ? (
                        <Button disabled={!ready} onClick={() => setDeleteIds(canvases.map((canvas) => canvas.id))}>
                            {t("canvas.deleteAll")}
                        </Button>
                    ) : null}
                    <Button disabled={!ready} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                        {t("canvas.import")}
                    </Button>
                    <Button disabled={!ready} type="primary" icon={<Plus className="size-4" />} onClick={() => void createAndEnter()}>
                        {t("canvas.create")}
                    </Button>
                </div>

                {!ready ? (
                    <div className="mt-4 flex min-h-[240px] items-center justify-center text-sm text-stone-500">{t("canvas.loading")}</div>
                ) : canvases.length ? (
                    <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {canvases.map((canvas) => (
                            <CanvasProjectCard key={canvas.id} project={canvas} />
                        ))}
                    </div>
                ) : (
                    <div className="mt-4 flex min-h-[240px] flex-col items-center justify-center text-center">
                        <h2 className="text-lg font-medium">{t("canvas.empty")}</h2>
                        <p className="mt-2 text-sm text-stone-500">{t("canvas.emptyDescription")}</p>
                        <Button type="primary" className="mt-5" icon={<Plus className="size-4" />} onClick={() => void createAndEnter()}>
                            {t("canvas.create")}
                        </Button>
                    </div>
                )}

                <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            </Dialog>
            <CanvasDeleteProjectsDialog />
        </>
    );
}
