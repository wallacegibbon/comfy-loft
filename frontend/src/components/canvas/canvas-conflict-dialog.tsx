import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { toast } from "@/components/kit/toast";
import { Dialog } from "@/components/kit/dialog";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

/**
 * The canvas on disk is not the one in this tab.
 *
 * One person, one workspace, but two tabs is a thing that happens — a ⌘-click, a restored session, a
 * link opened twice. Both tabs then hold a copy, and the whole document is what a save replaces, so the
 * second one to save would erase the first one's work without ever looking like it (#158).
 *
 * So the save stops here instead of winning, and this asks which copy is meant. Neither button is
 * highlighted: overwriting the other tab is a real choice, and discarding what is on screen is too.
 * Neither is dismissal: there is no close button, the backdrop and Escape do nothing, and the window
 * cannot be put away with a gesture that silently answers "use the disk" (decisions #176).
 *
 * The "disk" answer reloads the page rather than patching the editor's state: the nodes, the undo stack
 * and the selection are all derived from the document that was read at load, and a reload is how you get
 * all three to agree with the file. It is also the one reload in this app that the person asked for —
 * #157 removed the automatic one.
 */
export function CanvasConflictDialog({ projectId }: { projectId: string }) {
    const { t } = useTranslation();
    const conflict = useCanvasStore((state) => state.conflicts[projectId]);
    const resolveWithMine = useCanvasStore((state) => state.resolveConflictWithMine);

    if (!conflict) return null;

    // Answering "use the disk" is a reload, which is the one reload in this app a person asked for (#157).
    const useDisk = () => window.location.reload();

    const useMine = async () => {
        try {
            await resolveWithMine(projectId);
            toast.success(t("canvas.conflict.kept"));
        } catch (error) {
            console.error(error);
            toast.error(t("canvas.save.failed"));
        }
    };

    return (
        <Dialog
            open
            title={t("canvas.conflict.title")}
            onClose={useDisk}
            closable={false}
            maskClosable={false}
            escapeClosable={false}
            size="form"
            footer={
                <>
                    <Button onClick={useDisk}>{t("canvas.conflict.useDisk")}</Button>
                    <Button type="primary" danger onClick={() => void useMine()}>
                        {t("canvas.conflict.useMine")}
                    </Button>
                </>
            }
        >
            <p className="text-sm leading-relaxed text-stone-600 dark:text-stone-300">{t("canvas.conflict.description")}</p>
            <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">{t("canvas.conflict.hint", { time: new Date(conflict.updatedAt).toLocaleString() })}</p>
        </Dialog>
    );
}
