import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

/** The canvas palette for the app's current light/dark setting. */
export function useCanvasTheme() {
    const theme = useThemeStore((state) => state.theme);
    return canvasThemes[theme];
}
