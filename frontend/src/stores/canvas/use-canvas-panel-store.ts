import { create } from "zustand";

/**
 * Which panel is floating over the canvas right now.
 *
 * It lives on its own because it answers one question — "what is open?" — and because it
 * does not deserve a route. A canvas has an address; the list of canvases does not. Nobody
 * bookmarks it, and refreshing it means nothing. Only a canvas is worth a URL.
 *
 * Settings keep their own state in `use-config-store` (`preferencesOpen`, `workflowsOpen`) because
 * twenty-odd call sites already open the preferences window on a missing model, and moving that would
 * have been churn with no payoff.
 */
type PanelStore = {
    canvasManagerOpen: boolean;
    setCanvasManagerOpen: (open: boolean) => void;
};

export const useCanvasPanelStore = create<PanelStore>((set) => ({
    canvasManagerOpen: false,
    setCanvasManagerOpen: (canvasManagerOpen) => set({ canvasManagerOpen }),
}));
