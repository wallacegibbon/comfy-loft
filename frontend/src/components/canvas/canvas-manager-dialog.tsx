import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import { FileUp, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { Dialog } from "@/components/kit/dialog";
import { toast } from "@/components/kit/toast";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import { apiErrorMessage } from "@/services/api/http";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasListStore } from "@/stores/canvas/use-canvas-list-store";
import { useCanvasPanelStore } from "@/stores/canvas/use-canvas-panel-store";

/**
 * The canvas list, floating over the canvas you are already in.
 *
 * This used to be a route (`/canvas`), which meant opening a panel that shows six cards
 * cost you an unmount of the canvas, a route change and a full remount to get back. The
 * list is a management surface: nobody bookmarks it, nobody shares its URL, and refreshing
 * it is meaningless. Only a canvas is worth an address.
 *
 * The body is the old page's: the list, multi-select for delete, import, and a card per canvas that
 * exports itself. There is no batch export any more — one archive is one canvas (decisions #172).
 * `CanvasDeleteProjectsDialog` is a sibling rather than a child so the two dialogs are independent radix
 * roots instead of a nested trap.
 */
export function CanvasManagerDialog() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const inputRef = useRef<HTMLInputElement>(null);
    const open = useCanvasPanelStore((state) => state.canvasManagerOpen);
    const setOpen = useCanvasPanelStore((state) => state.setCanvasManagerOpen);
    const ready = useCanvasStore((state) => state.ready);
    const canvases = useCanvasStore((state) => state.canvases);
    const createCanvas = useCanvasStore((state) => state.createCanvas);
    const importCanvasFile = useCanvasStore((state) => state.importCanvas);
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
    /**
     * Import one exported canvas.
     *
     * The archive goes to the gateway whole, which unpacks it into a new canvas directory — the files keep
     * the names the document uses, so there is nothing to rename here and no document to repair
     * (decisions #172). One request, one canvas.
     */
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            enterProject(await importCanvasFile(file));
            toast.success(t("canvas.imported"));
        } catch (error) {
            console.error(error);
            toast.error(apiErrorMessage(error, t("canvas.importFailed")));
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    return (
        <>
            <Dialog open={open} onClose={() => setOpen(false)} title={t("canvas.title")} size="panel" bodyClassName="pr-1">
                <div className="flex flex-wrap items-center justify-end gap-2">
                    {selectedIds.length ? (
                        <Button disabled={!ready} onClick={() => setDeleteIds(selectedIds)}>
                            {t("canvas.deleteSelected")}
                        </Button>
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
