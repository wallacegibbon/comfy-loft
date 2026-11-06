import { type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { CanvasCanvasesSection } from "@/components/canvas/canvas-side-panel-canvases";
import { CanvasDeletedSection } from "@/components/canvas/canvas-side-panel-deleted";
import { CanvasElementsSection } from "@/components/canvas/canvas-side-panel-elements";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import {
    CANVAS_CHROME_GUTTER,
    CANVAS_COLUMN_HEIGHT,
    CANVAS_SIDE_PANEL_MAX_WIDTH,
    CANVAS_SIDE_PANEL_MIN_WIDTH,
    CANVAS_SIDE_PANEL_MOTION_MS,
    CANVAS_TOP_BAR_ROW,
    useCanvasChromeWidth,
    useCanvasSidePanelStore,
    type CanvasPanelSection,
} from "@/stores/canvas/use-canvas-side-panel-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { type CanvasNodeData, type CanvasTrashEntry } from "@/types/canvas";

/**
 * The middle box of the board's left column (#191), holding the two lists the app has: the canvases in the
 * workspace and the nodes in this one (#195).
 *
 * One column, one list at a time, behind a switch at the top. They are lists of the same species but they
 * answer different questions, and the column is 220–480px wide — stacked, each would get half a column and
 * the elements list would lose the room its hover preview needs. Both stay mounted, so switching back finds
 * the search box, the filter and the selection as they were left.
 *
 * It opens and closes by *height*: the box grows down from the bar's row and gives that height back, and the
 * content inside stays at the column's full height and is clipped instead of squashed. That is what "from
 * its top edge" means, and it rules out the two cheaper ways of doing it — a `translate` moves the whole box
 * sideways while the list's own top edge stays put, and a `scaleY` squashes the rows on the way down.
 * `height` on an absolutely positioned box costs nothing outside itself: the canvas beside it does not
 * reflow, because this floats over it (#98). A drag on the edge never animates anything — the width was
 * never animated and the height does not change during a drag — so there is no "resizing" flag any more.
 */
const PANEL_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/**
 * The two transitions, as whole declarations rather than three properties.
 *
 * `visibility` is in both on purpose. At `height: 0` the box's own border and shadow would still draw a
 * two-pixel line across the canvas at the top of the column — measured, not guessed — and `overflow:
 * hidden` cannot clip a border. So it is hidden, but only *after* the height has finished collapsing (the
 * delayed `visibility` below); on the way in the delay is zero, or nothing would be there to grow.
 */
const OPEN_TRANSITION = `height ${CANVAS_SIDE_PANEL_MOTION_MS}ms ${PANEL_EASE}, visibility 0s`;
const CLOSED_TRANSITION = `height ${CANVAS_SIDE_PANEL_MOTION_MS}ms ${PANEL_EASE}, visibility 0s ${CANVAS_SIDE_PANEL_MOTION_MS}ms`;

const SECTIONS: Array<{ id: CanvasPanelSection; labelKey: string }> = [
    { id: "canvases", labelKey: "canvas.sidePanel.tab.canvases" },
    { id: "elements", labelKey: "canvas.sidePanel.tab.elements" },
    // The third list is what the canvas threw away (#327): the one place a mistake is still recoverable after
    // the tab that made it is gone.
    { id: "deleted", labelKey: "canvas.sidePanel.tab.deleted" },
];

type Props = {
    /** The canvas on screen, so the list of every canvas can mark where you are. */
    projectId: string;
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    /** What this canvas deleted and can still put back, newest first. */
    trash: CanvasTrashEntry[];
    onRestoreNode: (nodeId: string) => void;
    onFocusNode: (nodeId: string) => void;
    onPreviewNode: (nodeId: string) => void;
    onHoverNode: (nodeId: string | null) => void;
};

export function CanvasSidePanel({ projectId, nodes, selectedNodeIds, trash, onFocusNode, onPreviewNode, onHoverNode, onRestoreNode }: Props) {
    const { t } = useTranslation();
    const theme = useCanvasTheme();
    const colorTheme = useThemeStore((state) => state.theme);
    const width = useCanvasSidePanelStore((state) => state.width);
    // The width it draws at: the stored one, clamped so the column never eats the whole window (#191).
    const chromeWidth = useCanvasChromeWidth();
    const panelOpen = useCanvasSidePanelStore((state) => state.panelOpen);
    const section = useCanvasSidePanelStore((state) => state.section);
    const setSection = useCanvasSidePanelStore((state) => state.setSection);
    const setWidth = useCanvasSidePanelStore((state) => state.setWidth);
    const commitWidth = useCanvasSidePanelStore((state) => state.commitWidth);

    const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        // Start from the width on screen, not the stored one: in a window too narrow for the column the two
        // differ, and dragging from the stored number would spend the first few centimetres doing nothing.
        const startWidth = Math.round(event.currentTarget.parentElement?.getBoundingClientRect().width ?? width);
        let nextWidth = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            nextWidth = Math.min(CANVAS_SIDE_PANEL_MAX_WIDTH, Math.max(CANVAS_SIDE_PANEL_MIN_WIDTH, startWidth + moveEvent.clientX - startX));
            setWidth(nextWidth);
        };
        const onUp = () => {
            commitWidth();
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    // A board over the canvas, not a column beside it: the canvas keeps its full width whether this is
    // open or shut, and nothing reflows when it moves. It is the middle box of the board's left column
    // (#191) — under the bar, above the zoom dock, so it stops short of the bottom instead of running to
    // the edge and leaving the dock to be pushed out beside it. While shut it has no height and is hidden —
    // out of hit-testing, out of the tab order, and drawing nothing, so the gutter belongs to the canvas
    // again.
    return (
        <aside
            className="absolute z-[60] flex flex-col overflow-hidden rounded-xl border"
            style={{
                width: chromeWidth,
                left: CANVAS_CHROME_GUTTER,
                top: CANVAS_TOP_BAR_ROW,
                height: panelOpen ? CANVAS_COLUMN_HEIGHT : 0,
                background: theme.toolbar.panel,
                borderColor: theme.toolbar.border,
                color: theme.node.text,
                boxShadow: colorTheme === "dark" ? "0 18px 45px rgba(0,0,0,.32)" : "0 16px 40px rgba(28,25,23,.12)",
                visibility: panelOpen ? "visible" : "hidden",
                transition: panelOpen ? OPEN_TRANSITION : CLOSED_TRANSITION,
                pointerEvents: panelOpen ? undefined : "none",
            }}
            inert={!panelOpen}
            data-canvas-no-zoom
        >
            {/* Pinned at the height the column opens to, so what the box reveals is the list at rest and not
                a list compressed into the height it has this frame. */}
            <div className="flex min-h-0 shrink-0 flex-col" style={{ height: CANVAS_COLUMN_HEIGHT }}>
                <div className="flex shrink-0 items-center gap-1 px-3 pb-2.5 pt-2" role="tablist">
                    {SECTIONS.map((item) => {
                        const active = item.id === section;
                        return (
                            <button
                                key={item.id}
                                type="button"
                                role="tab"
                                aria-selected={active}
                                onClick={() => setSection(item.id)}
                                className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-xs font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
                                style={active ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText } : { color: theme.node.muted }}
                            >
                                {t(item.labelKey)}
                            </button>
                        );
                    })}
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                    <div className="h-full" hidden={section !== "canvases"}>
                        <CanvasCanvasesSection projectId={projectId} />
                    </div>
                    <div className="h-full" hidden={section !== "elements"}>
                        <CanvasElementsSection nodes={nodes} selectedNodeIds={selectedNodeIds} onFocusNode={onFocusNode} onPreviewNode={onPreviewNode} onHoverNode={onHoverNode} />
                    </div>
                    <div className="h-full" hidden={section !== "deleted"}>
                        <CanvasDeletedSection trash={trash} onRestoreNode={onRestoreNode} />
                    </div>
                </div>
            </div>
            <button type="button" className="absolute inset-y-0 right-0 z-40 w-4 translate-x-1/2 cursor-col-resize" onPointerDown={startResize} aria-label={t("canvas.sidePanel.resize")} />
        </aside>
    );
}
