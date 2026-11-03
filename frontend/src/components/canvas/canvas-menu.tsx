import { Check, CircleDot, Download, Eraser, Grid2x2, Group, Hand, Image as ImageIcon, Info, LocateFixed, MousePointer2, Redo2, SlidersHorizontal, Square, Trash2, Type, Undo2, Upload, Video } from "lucide-react";

import type { DropdownItem } from "@/components/kit/floating";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";

/**
 * The canvas's commands, as the items of the menu that opens on its name.
 *
 * They used to be an icon dock across the bottom of the canvas. It was sixteen glyphs with tooltips and no
 * words: the thing you press once a session (export, clear) took the same room as the thing you press
 * constantly (a new node), and every one of them needed a tooltip to be readable at all. Here the same
 * commands are named, grouped, and out of the way of the canvas.
 *
 * The set is the dock's set, not a new one: `text`/`image`/`video`/`group`/`lora` create nodes, `upload`
 * picks files, `undo`/`redo` walk the history, `focus` and `delete` act on the selection, the grid and
 * image-info toggles change how the canvas is drawn, and `export`/`clear` are the two that touch the whole
 * canvas. The viewport's own controls (zoom, minimap, reset) stay where they were, at the bottom left:
 * they are a dial, not a menu.
 */
export function canvasMenuItems({
    t,
    canvasTool,
    canUndo,
    canRedo,
    selectedCount,
    backgroundMode,
    showImageInfo,
    onCanvasToolChange,
    onAddText,
    onAddImage,
    onAddVideo,
    onAddGroup,
    onAddLora,
    onUpload,
    onUndo,
    onRedo,
    onFocusSelected,
    onDeleteSelected,
    onBackgroundModeChange,
    onShowImageInfoChange,
    onExport,
    onClear,
}: {
    t: (key: string) => string;
    canvasTool: "select" | "pan";
    canUndo: boolean;
    canRedo: boolean;
    selectedCount: number;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    onCanvasToolChange: (tool: "select" | "pan") => void;
    onAddText: () => void;
    onAddImage: () => void;
    onAddVideo: () => void;
    onAddGroup: () => void;
    onAddLora: () => void;
    onUpload: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onFocusSelected: () => void;
    onDeleteSelected: () => void;
    onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
    onShowImageInfoChange: (show: boolean) => void;
    onExport: () => void;
    onClear: () => void;
}): DropdownItem[] {
    return [
        { type: "label", key: "create-label", text: t("canvas.menu.create") },
        { key: "add-text", icon: <Type className="size-4" />, label: t("canvas.toolbar.text"), onClick: onAddText },
        { key: "add-image", icon: <ImageIcon className="size-4" />, label: t("canvas.toolbar.image"), onClick: onAddImage },
        { key: "add-video", icon: <Video className="size-4" />, label: t("canvas.toolbar.video"), onClick: onAddVideo },
        { key: "add-group", icon: <Group className="size-4" />, label: t("canvas.toolbar.group"), onClick: onAddGroup },
        { key: "add-lora", icon: <SlidersHorizontal className="size-4" />, label: t("canvas.toolbar.lora"), onClick: onAddLora },
        { key: "import", icon: <Upload className="size-4" />, label: t("canvas.toolbar.import"), onClick: onUpload },

        { type: "divider", key: "edit-divider" },
        { type: "label", key: "edit-label", text: t("canvas.menu.edit") },
        { key: "undo", icon: <Undo2 className="size-4" />, label: t("canvas.undo"), shortcut: "Ctrl+Z", disabled: !canUndo, onClick: onUndo },
        { key: "redo", icon: <Redo2 className="size-4" />, label: t("canvas.redo"), shortcut: "Ctrl+Shift+Z", disabled: !canRedo, onClick: onRedo },
        { key: "focus", icon: <LocateFixed className="size-4" />, label: t("canvas.toolbar.focus"), disabled: !selectedCount, onClick: onFocusSelected },
        { key: "delete-selected", icon: <Trash2 className="size-4" />, label: t("canvas.deleteSelected"), shortcut: "Delete", disabled: !selectedCount, danger: true, onClick: onDeleteSelected },

        { type: "divider", key: "view-divider" },
        { type: "label", key: "view-label", text: t("canvas.menu.view") },
        { key: "tool-select", icon: marked(canvasTool === "select", <MousePointer2 className="size-4" />), label: t("canvas.toolbar.select"), onClick: () => onCanvasToolChange("select") },
        { key: "tool-pan", icon: marked(canvasTool === "pan", <Hand className="size-4" />), label: t("canvas.toolbar.pan"), onClick: () => onCanvasToolChange("pan") },
        { key: "grid-dots", icon: marked(backgroundMode === "dots", <CircleDot className="size-4" />), label: t("canvas.toolbar.dots"), onClick: () => onBackgroundModeChange("dots") },
        { key: "grid-lines", icon: marked(backgroundMode === "lines", <Grid2x2 className="size-4" />), label: t("canvas.toolbar.lines"), onClick: () => onBackgroundModeChange("lines") },
        { key: "grid-blank", icon: marked(backgroundMode === "blank", <Square className="size-4" />), label: t("canvas.toolbar.blank"), onClick: () => onBackgroundModeChange("blank") },
        { key: "image-info", icon: marked(showImageInfo, <Info className="size-4" />), label: t("canvas.toolbar.imageInfo"), onClick: () => onShowImageInfoChange(!showImageInfo) },

        { type: "divider", key: "canvas-divider" },
        { key: "export", icon: <Download className="size-4" />, label: t("canvas.exportCurrent"), onClick: onExport },
        { key: "clear", icon: <Eraser className="size-4" />, label: t("canvas.toolbar.clear"), danger: true, onClick: onClear },
    ];
}

/** A toggle's icon: the tick says which of a set is on, the picture says what the set is. */
function marked(active: boolean, icon: React.ReactNode) {
    return active ? <Check className="size-4" /> : icon;
}
