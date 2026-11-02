import { Button } from "@/components/kit/button";
import { toast } from "@/components/kit/toast";
import { useTranslation } from "react-i18next";

import { Dialog } from "@/components/kit/dialog";
import { forgetCanvasConversation } from "@/services/api/agent";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasListStore } from "@/stores/canvas/use-canvas-list-store";
import { useEffectiveConfig } from "@/stores/use-config-store";

export function CanvasDeleteProjectsDialog() {
    const { t } = useTranslation();
    const ids = useCanvasListStore((state) => state.deleteProjectIds);
    const setDeleteIds = useCanvasListStore((state) => state.setDeleteProjectIds);
    const removeSelectedIds = useCanvasListStore((state) => state.removeSelectedProjectIds);
    const deleteCanvases = useCanvasStore((state) => state.deleteCanvases);
    const config = useEffectiveConfig();
    const confirm = async () => {
        try {
            await deleteCanvases(ids);
        } catch (error) {
            // The list is only changed once the gateway agrees, so a failure here leaves the canvases
            // where they were and says why. Deleting is not undoable, so silence is not an option.
            console.error(error);
            toast.error(t("canvas.deleteFailed"));
            return;
        }
        // Each canvas also owns an agent conversation, which lives in a file on the gateway.
        for (const id of ids) void forgetCanvasConversation(config, id);
        removeSelectedIds(ids);
        setDeleteIds([]);
    };

    return (
        <Dialog
            title={t("canvas.project.deleteTitle")}
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
            <p className="text-sm text-stone-500">{t("canvas.project.deleteDescription", { count: ids.length })}</p>
        </Dialog>
    );
}
