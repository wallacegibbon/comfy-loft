import { CANVAS_CHROME_GAP, CANVAS_CHROME_GUTTER, CANVAS_ABOVE_DOCK_BOTTOM, CANVAS_TOP_BAR_ROW, CANVAS_ZOOM_DOCK_HEIGHT, useCanvasChromeWidth, useCanvasSidePanelStore } from "@/stores/canvas/use-canvas-side-panel-store";

/**
 * The board's frame, drawn while the canvas loads.
 *
 * It is the same three boxes the app stacks on the left — the bar at the top, the panel under it, the zoom
 * dock at the foot — at the same width, on the same left edge and with the same gaps (#191), so the real
 * chrome lands where the sketch was instead of jumping. Nothing else is sketched: this used to draw a
 * centred bottom dock and a minimap too, and neither exists any more, so the loading frame promised chrome
 * that never came.
 */
export function CanvasRefreshShell() {
    const width = useCanvasChromeWidth();
    const panelOpen = useCanvasSidePanelStore((state) => state.panelOpen);
    const frame = { background: "var(--background)", borderColor: "var(--border)", width, left: CANVAS_CHROME_GUTTER };

    return (
        <main className="relative h-full min-h-0 overflow-hidden bg-background text-foreground">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
                    backgroundSize: "28px 28px",
                }}
            />

            {/* The bar is centred in the top row, so it sits one gap inside it either way. */}
            <div className="absolute z-50 flex items-center gap-2 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ ...frame, height: CANVAS_TOP_BAR_ROW - CANVAS_CHROME_GAP * 2, top: CANVAS_CHROME_GAP }} aria-hidden="true">
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="h-4 flex-1 rounded-sm bg-current opacity-10" />
            </div>

            {panelOpen ? (
                <div className="absolute z-50 rounded-xl border shadow-2xl backdrop-blur-sm" style={{ ...frame, top: CANVAS_TOP_BAR_ROW, bottom: CANVAS_ABOVE_DOCK_BOTTOM }} aria-hidden="true">
                    <div className="absolute left-4 top-4 h-6 w-24 rounded-sm bg-current opacity-10" />
                    <div className="absolute inset-x-4 top-14 h-8 rounded-md bg-current opacity-10" />
                </div>
            ) : null}

            <div className="absolute z-50 flex items-center gap-2 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ ...frame, bottom: CANVAS_CHROME_GUTTER, height: CANVAS_ZOOM_DOCK_HEIGHT }} aria-hidden="true">
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="h-1 flex-1 rounded-full bg-current opacity-10" />
                <div className="h-4 w-10 rounded bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
            </div>
        </main>
    );
}
