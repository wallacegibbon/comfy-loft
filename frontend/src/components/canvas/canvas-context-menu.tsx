import { useEffect } from "react";
import type { ReactNode } from "react";
import { BetweenHorizontalStart, Download, GalleryHorizontalEnd, GalleryHorizontal, Group, Info, Plus, Trash2, Ungroup } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ContextMenuState } from "@/types/canvas";
import type { VideoFramePosition } from "@/lib/canvas/canvas-video-frame";
import { CANVAS_DISMISS_GUARD } from "@/lib/canvas-overlay";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";

/**
 * The menu for a node or a connection, and only what *every* node has (docs/decisions.md #332): information,
 * download, duplicate, grouping, delete — plus the three frame grabs, which are a clip's own but need the frame
 * under the pointer, so they belong to the moment rather than to the node. What one kind of node can do lives on
 * the bar over its card.
 */
export function CanvasNodeContextMenu({
    menu,
    canCaptureVideoFrame,
    canDownload,
    canGroup,
    canUngroup,
    onClose,
    onCaptureVideoFrame,
    onInfo,
    onDownload,
    onDuplicate,
    onGroup,
    onUngroup,
    onDelete,
}: {
    menu: ContextMenuState;
    canCaptureVideoFrame: boolean;
    canDownload: boolean;
    canGroup?: boolean;
    canUngroup?: boolean;
    onClose: () => void;
    onCaptureVideoFrame: (position: VideoFramePosition) => void;
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
            {canCaptureVideoFrame ? (
                <>
                    <MenuButton icon={<BetweenHorizontalStart className="size-4" />} label={t("canvas.videoFrames.first")} onClick={() => onCaptureVideoFrame("first")} />
                    <MenuButton icon={<GalleryHorizontalEnd className="size-4" />} label={t("canvas.videoFrames.last")} onClick={() => onCaptureVideoFrame("last")} />
                    <MenuButton icon={<GalleryHorizontal className="size-4" />} label={t("canvas.videoFrames.current")} onClick={() => onCaptureVideoFrame("current")} />
                    <MenuDivider />
                </>
            ) : null}
            {menu.type === "node" ? (
                <>
                    <MenuButton icon={<Info className="size-4" />} label={t("canvas.nodeToolbar.info")} onClick={onInfo} />
                    {canDownload ? <MenuButton icon={<Download className="size-4" />} label={t("common.download")} onClick={onDownload} /> : null}
                    <MenuButton icon={<Plus className="size-4" />} label={t("canvas.controls.duplicate")} onClick={onDuplicate} />
                    {canGroup ? <MenuButton icon={<Group className="size-4" />} label={t("canvas.nodeToolbar.group")} onClick={onGroup} /> : null}
                    {canUngroup ? <MenuButton icon={<Ungroup className="size-4" />} label={t("canvas.nodeToolbar.ungroup")} onClick={onUngroup} /> : null}
                    <MenuDivider />
                </>
            ) : null}
            <MenuButton icon={<Trash2 className="size-4" />} label={t("canvas.controls.delete")} onClick={onDelete} danger />
        </div>
    );
}

function MenuDivider() {
    const theme = useCanvasTheme();
    return <div className="my-1 border-t" style={{ borderColor: theme.toolbar.border }} />;
}

function MenuButton({ icon, label, onClick, danger = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean }) {
    const theme = useCanvasTheme();

    return (
        <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" style={{ color: danger ? "#f87171" : theme.node.text }} onClick={onClick}>
            {icon}
            <span>{label}</span>
        </button>
    );
}
