import { create } from "zustand";

import type { CanvasAgentWindow } from "@/types/canvas";

/**
 * Where each canvas's agent window is, and whether it is open.
 *
 * This is document state now, not window state: where the panel sits and how big it is are part of how
 * the person left the canvas, so they travel with the document and are restored with it. The store is
 * still the live copy — one record per canvas, so switching canvases cannot carry one panel's geometry
 * onto another — and `project.tsx` writes it back on the same debounce as the viewport.
 *
 * `position` is null until the panel has been dragged, and null means "the default corner"; `size` is
 * null until it has been resized. Keeping "not touched" distinct from a pixel value is what lets the
 * panel open at a share of whatever window it is opened in, while still restoring an explicit size.
 */
type CanvasAgentStore = {
    windows: Record<string, CanvasAgentWindow>;
    setOpen: (canvasId: string, open: boolean) => void;
    toggle: (canvasId: string) => void;
    setPosition: (canvasId: string, position: { x: number; y: number }) => void;
    setSize: (canvasId: string, size: { width: number; height: number }) => void;
    /**
     * Take the window a canvas document describes, once, when that canvas opens.
     *
     * A record already in memory is newer than the document — it is the same session's edits, possibly
     * still waiting for the save debounce — so it wins. An empty slot is what a page load leaves, and
     * that is the case this fills.
     */
    restore: (canvasId: string, window: CanvasAgentWindow | null | undefined) => void;
};

const CLOSED: CanvasAgentWindow = { open: false, position: null, size: null };

/** Apply a change to one canvas's window, creating it from the default when this is the first one. */
function change(windows: Record<string, CanvasAgentWindow>, canvasId: string, patch: Partial<CanvasAgentWindow>): Record<string, CanvasAgentWindow> {
    return { ...windows, [canvasId]: { ...(windows[canvasId] ?? CLOSED), ...patch } };
}

export const useCanvasAgentStore = create<CanvasAgentStore>((set) => ({
    windows: {},
    setOpen: (canvasId, open) => set((state) => ({ windows: change(state.windows, canvasId, { open }) })),
    toggle: (canvasId) => set((state) => ({ windows: change(state.windows, canvasId, { open: !(state.windows[canvasId] ?? CLOSED).open }) })),
    setPosition: (canvasId, position) => set((state) => ({ windows: change(state.windows, canvasId, { position }) })),
    setSize: (canvasId, size) => set((state) => ({ windows: change(state.windows, canvasId, { size }) })),
    // A document written before the panel had a remembered window carries no `agent` at all, and one
    // the person has never opened the panel on carries the default. Both open closed, which is what
    // such a canvas did before there was anything to remember.
    restore: (canvasId, window) => set((state) => (state.windows[canvasId] ? state : { windows: { ...state.windows, [canvasId]: { ...(window ?? CLOSED) } } })),
}));
