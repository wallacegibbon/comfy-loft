import { create } from "zustand";

import { readSetting, writeSetting } from "@/stores/use-settings-store";

export const CANVAS_SIDE_PANEL_MOTION_MS = 240;
export const CANVAS_SIDE_PANEL_MIN_WIDTH = 220;
export const CANVAS_SIDE_PANEL_MAX_WIDTH = 480;
const CANVAS_SIDE_PANEL_DEFAULT_WIDTH = 280;

/**
 * The geometry of the board's left column.
 *
 * The bar at the top, the panel and the zoom dock are stacked, not scattered: one width, one left edge,
 * and the same gap between the three boxes. They are declared here rather than as Tailwind classes at the
 * three call sites because the panel's bottom edge *is* the dock's height plus two gaps — a panel that
 * guessed would either overlap the dock or leave a hole that changes with the window (#191).
 */
export const CANVAS_CHROME_GUTTER = 12;
export const CANVAS_CHROME_GAP = 8;
export const CANVAS_ZOOM_DOCK_HEIGHT = 56;
/** The bar's row: the top bar is this tall and the bar itself is centred in it. */
export const CANVAS_TOP_BAR_ROW = 64;
/** The bottom offset of anything that floats above the dock: the dock itself, the gutter under it, one gap. */
export const CANVAS_ABOVE_DOCK_BOTTOM = CANVAS_CHROME_GUTTER + CANVAS_ZOOM_DOCK_HEIGHT + CANVAS_CHROME_GAP;
/**
 * The height of the column's middle box, from the bar's row down to the dock's offset.
 *
 * The panel opens by growing to this height from its top edge and closes by giving it back (#195), so the
 * number is needed in two places that cannot read it off each other: the box that animates, and the content
 * inside it, which stays at its full height and is clipped instead of squashed. It is in `dvh` because the
 * app's layout is one full-window column (`layouts/user-layout.tsx`) — there is no chrome above the canvas
 * and none below it, so the window *is* the section's height.
 */
export const CANVAS_COLUMN_HEIGHT = `calc(100dvh - ${CANVAS_TOP_BAR_ROW + CANVAS_ABOVE_DOCK_BOTTOM}px)`;
/**
 * What the bar at the right end of the row needs, gutter and gap included, so the column can stop before
 * it. Measured from the default contents (the system readout and five buttons); a little slack either way
 * is harmless — the bar has no width of its own and gives way first.
 */
const CANVAS_RIGHT_BAR_RESERVE = 300;

const WIDTH_KEY = "canvas-side-panel-width";
const OPEN_KEY = "canvas-side-panel-open";
const NODE_VIEW_KEY = "canvas-side-panel-node-view";
const SECTION_KEY = "canvas-side-panel-section";

type CanvasNodeViewMode = "list" | "grid";

/**
 * Which of the column's two lists is on screen: the canvases in the workspace, or the nodes in this one.
 *
 * One column, two sections, one at a time. They are lists of the same species — a name, a picture, a
 * click that takes you there — but they answer different questions ("which canvas?" and "which node?"),
 * and the column is 220–480px wide: stacked, each would get half a column and the elements list would lose
 * the room its hover preview needs (#195). The section is remembered, so the column comes back the way it
 * was left. Nothing outside the column asks for a section any more: one button opens it, and the switch
 * inside picks the list (#197).
 */
export type CanvasPanelSection = "canvases" | "elements";

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

/** The elements first: the canvas is what you came for, and its list is the surface you work in. */
function initialSection(): CanvasPanelSection {
    return readSetting<CanvasPanelSection>(SECTION_KEY, "elements") === "canvases" ? "canvases" : "elements";
}

type CanvasSidePanelStore = {
    width: number;
    panelOpen: boolean;
    section: CanvasPanelSection;
    nodeViewMode: CanvasNodeViewMode;
    setWidth: (width: number) => void;
    /** Write the current width to storage. Called when a drag ends, not on every pixel. */
    commitWidth: () => void;
    setNodeViewMode: (mode: CanvasNodeViewMode) => void;
    togglePanel: () => void;
    setSection: (section: CanvasPanelSection) => void;
};

export const useCanvasSidePanelStore = create<CanvasSidePanelStore>((set, get) => ({
    width: initialWidth(),
    panelOpen: initialOpen(),
    section: initialSection(),
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
    setSection: (section) => {
        writeSetting(SECTION_KEY, section);
        set({ section });
    },
}));

/**
 * The width the left-hand chrome shares, as a CSS length.
 *
 * The bar at the top, the panel and the zoom dock are one column: three boxes of the same width, aligned on
 * the same left edge, which is what makes them read as a column rather than as three unrelated panels
 * (#191). The panel is the only one that can be dragged, so it owns the number, and widening it widens the
 * other two with it.
 *
 * The clamp is why this is a CSS length and not a number: in a window too narrow to hold the column *and*
 * the bar on the right, the column stops at `CANVAS_RIGHT_BAR_RESERVE` from the edge. Being a `min()` in
 * one place rather than a number frozen at render time, all three boxes follow a window resize together and
 * none of them ends up a different width from its neighbours.
 */
export function useCanvasChromeWidth() {
    const width = useCanvasSidePanelStore((state) => state.width);
    return `min(${width}px, calc(100vw - ${CANVAS_RIGHT_BAR_RESERVE}px))`;
}
