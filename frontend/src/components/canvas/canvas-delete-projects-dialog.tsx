import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/kit/button";
import { Dialog } from "@/components/kit/dialog";
import { toast } from "@/components/kit/toast";
import { forgetLastCanvas } from "@/lib/canvas/last-canvas";
import { forgetCanvasConversation } from "@/services/api/agent";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasListStore } from "@/stores/canvas/use-canvas-list-store";
import { useEffectiveConfig } from "@/stores/use-config-store";

/**
 * The one confirmation every canvas deletion goes through.
 *
 * It names what it is about to destroy. A count is not enough: the list it was opened from is a list of
 * titles, deleting is not undoable, and "will delete 2 canvases" asks the reader to go back and look at which
 * two. One canvas is named in the sentence; several are listed under it, because a sentence with eight names
 * in it is unreadable and a list of eight is not.
 *
 * It is also where deleting has its consequences, because it is the only thing that deletes: the row menu,
 * the select bar and anything added later all end up here. Two of those consequences are invisible from the
 * list — the canvas you are standing on is now gone, and each canvas owns an agent conversation that lives
 * in a file on the server. Both used to be handled by the top bar's "delete current canvas", which went with
 * the rest of the workspace commands (#196).
 */
export function CanvasDeleteProjectsDialog({ currentId }: { currentId: string }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const ids = useCanvasListStore((state) => state.deleteProjectIds);
    const setDeleteIds = useCanvasListStore((state) => state.setDeleteProjectIds);
    const removeSelectedIds = useCanvasListStore((state) => state.removeSelectedProjectIds);
    const deleteCanvases = useCanvasStore((state) => state.deleteCanvases);
    const canvases = useCanvasStore((state) => state.canvases);
    const config = useEffectiveConfig();
    // The titles as the list knows them. An id with no summary left is still deletable — say what it is by
    // the name the rest of the app gives an unnamed canvas.
    const titles = useMemo(() => ids.map((id) => canvases.find((canvas) => canvas.id === id)?.title || t("canvas.project.untitled")), [canvases, ids, t]);
    const confirm = async () => {
        try {
            await deleteCanvases(ids);
        } catch (error) {
            // The list is only changed once the server agrees, so a failure here leaves the canvases
            // where they were and says why. Deleting is not undoable, so silence is not an option.
            console.error(error);
            toast.error(t("canvas.deleteFailed"));
            return;
        }
        // Each canvas also owns an agent conversation, which lives in a file on the server.
        for (const id of ids) void forgetCanvasConversation(config, id);
        removeSelectedIds(ids);
        setDeleteIds([]);
        // Deleting the canvas on screen throws away the view as well as the record: leave for whatever is
        // left, the way the root route picks the canvas to open.
        if (ids.includes(currentId)) {
            forgetLastCanvas(currentId);
            navigate("/canvas");
        }
    };

    return (
        <Dialog
            title={ids.length === 1 ? t("canvas.project.deleteOneTitle") : t("canvas.project.deleteTitle")}
            open={ids.length > 0}
            onClose={() => setDeleteIds([])}
            footer={
                <>
                    <Button onClick={() => setDeleteIds([])}>{t("common.cancel")}</Button>
                    <Button type="primary" danger onClick={() => void confirm()}>
                        {t("common.delete")}
                    </Button>
                </>
            }
            size="form"
        >
            {ids.length === 1 ? (
                <p className="text-sm text-stone-500">{t("canvas.project.deleteOne", { name: titles[0] })}</p>
            ) : (
                <>
                    <p className="text-sm text-stone-500">{t("canvas.project.deleteDescription", { count: ids.length })}</p>
                    <ul className="mt-3 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-sm text-stone-700 dark:text-stone-200">
                        {titles.map((title, index) => (
                            <li key={ids[index]} className="truncate">
                                {title}
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </Dialog>
    );
}
