import { create } from "zustand";

import { readSetting, writeSetting } from "@/stores/use-settings-store";

export const CANVAS_SIDE_PANEL_MOTION_MS = 500;
export const CANVAS_SIDE_PANEL_MIN_WIDTH = 220;
export const CANVAS_SIDE_PANEL_MAX_WIDTH = 480;
const CANVAS_SIDE_PANEL_DEFAULT_WIDTH = 280;

const WIDTH_KEY = "canvas-side-panel-width";
const OPEN_KEY = "canvas-side-panel-open";
const NODE_VIEW_KEY = "canvas-side-panel-node-view";

type CanvasNodeViewMode = "list" | "grid";

function initialWidth() {
    const stored = Number(readSetting(WIDTH_KEY, 0));
    if (!stored) return CANVAS_SIDE_PANEL_DEFAULT_WIDTH;
    return Math.min(CANVAS_SIDE_PANEL_MAX_WIDTH, Math.max(CANVAS_SIDE_PANEL_MIN_WIDTH, stored));
}

/** Shut until asked for: the board floats over the canvas, so nothing is missing while it is away. */
function initialOpen() {
    return readSetting<boolean>(OPEN_KEY, false);
}

function initialNodeView(): CanvasNodeViewMode {
    return readSetting<CanvasNodeViewMode>(NODE_VIEW_KEY, "list") === "grid" ? "grid" : "list";
}

type CanvasSidePanelStore = {
    width: number;
    panelOpen: boolean;
    nodeViewMode: CanvasNodeViewMode;
    setWidth: (width: number) => void;
    /** Write the current width to storage. Called when a drag ends, not on every pixel. */
    commitWidth: () => void;
    setNodeViewMode: (mode: CanvasNodeViewMode) => void;
    togglePanel: () => void;
};

export const useCanvasSidePanelStore = create<CanvasSidePanelStore>((set, get) => ({
    width: initialWidth(),
    panelOpen: initialOpen(),
    nodeViewMode: initialNodeView(),
    setWidth: (width) => set({ width }),
    commitWidth: () => writeSetting(WIDTH_KEY, get().width),
    setNodeViewMode: (mode) => {
        writeSetting(NODE_VIEW_KEY, mode);
        set({ nodeViewMode: mode });
    },
    togglePanel: () => {
        const open = !get().panelOpen;
        writeSetting(OPEN_KEY, open);
        set({ panelOpen: open });
    },
}));

/**
 * Where the canvas's own chrome should sit, measured from the left edge. The board floats there, so a
 * zoom dock or a minimap that used to be pushed aside by a column now has to step over it instead.
 */
export function useSidePanelInset(gap: number) {
    const open = useCanvasSidePanelStore((state) => state.panelOpen);
    const width = useCanvasSidePanelStore((state) => state.width);
    return open ? width + gap : gap;
}
