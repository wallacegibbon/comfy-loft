import { useEffect } from "react";
import type { ReactNode } from "react";
import { Download, Group, Info, Plus, Trash2, Ungroup } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ContextMenuState } from "@/types/canvas";
import { CANVAS_DISMISS_GUARD } from "@/lib/canvas-overlay";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";

/**
 * The menu for a node or a connection, and only what *every* node has (docs/decisions.md #332): information,
 * download, duplicate, grouping, delete. What one kind of node can do lives on the bar over its card — a clip's
 * three frame grabs included, since they are as much a clip's own as its interpolate (#333).
 */
export function CanvasNodeContextMenu({
    menu,
    canDelete,
    canDownload,
    canGroup,
    canUngroup,
    onClose,
    onInfo,
    onDownload,
    onDuplicate,
    onGroup,
    onUngroup,
    onDelete,
}: {
    menu: ContextMenuState;
    /**
     * A group cannot be deleted — deleting one only dissolves it and destroys nothing (#327), so the menu offers
     * Ungroup and no delete row: two names for one act, one of them a lie (#334).
     */
    canDelete: boolean;
    canDownload: boolean;
    canGroup?: boolean;
    canUngroup?: boolean;
    onClose: () => void;
    onInfo: () => void;
    onDownload: () => void;
    onDuplicate: () => void;
    onGroup?: () => void;
    onUngroup?: () => void;
    onDelete: () => void;
}) {
    const { t } = useTranslation();
    const theme = useCanvasTheme();

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(CANVAS_DISMISS_GUARD)) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            className="fixed z-[80] min-w-44 overflow-hidden rounded-xl border py-1 shadow-2xl"
            style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {menu.type === "node" ? (
                <>
                    <MenuButton icon={<Info className="size-4" />} label={t("canvas.nodeToolbar.info")} onClick={onInfo} />
                    {canDownload ? <MenuButton icon={<Download className="size-4" />} label={t("common.download")} onClick={onDownload} /> : null}
                    <MenuButton icon={<Plus className="size-4" />} label={t("canvas.controls.duplicate")} onClick={onDuplicate} />
                    {canGroup ? <MenuButton icon={<Group className="size-4" />} label={t("canvas.nodeToolbar.group")} onClick={onGroup} /> : null}
                    {canUngroup ? <MenuButton icon={<Ungroup className="size-4" />} label={t("canvas.nodeToolbar.ungroup")} onClick={onUngroup} /> : null}
                    {canDelete ? <MenuDivider /> : null}
                </>
            ) : null}
            {canDelete ? <MenuButton icon={<Trash2 className="size-4" />} label={t("canvas.controls.delete")} onClick={onDelete} danger /> : null}
        </div>
    );
}

function MenuDivider() {
    const theme = useCanvasTheme();
    return <div className="my-1 border-t" style={{ borderColor: theme.toolbar.border }} />;
}

// `onClick={() => onClick?.()}` and not `onClick={onClick}`: a handler taking a `Set` of ids was being handed the
// click's MouseEvent, which is how Ungroup threw `e.has is not a function` (#334).
function MenuButton({ icon, label, onClick, danger = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean }) {
    const theme = useCanvasTheme();

    return (
        <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" style={{ color: danger ? "#f87171" : theme.node.text }} onClick={() => onClick?.()}>
            {icon}
            <span>{label}</span>
        </button>
    );
}
