import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { useConfigStore } from "@/stores/use-config-store";

/**
 * `/config` is not a page any more. Preferences are a window over the canvas, opened from the first
 * button at the right end of the top bar. The address stays so a bookmark or a pasted link still
 * works: it opens the window and puts you back on a canvas.
 */
export function ConfigEntry() {
    const navigate = useNavigate();
    const openPreferences = useConfigStore((state) => state.openPreferences);

    useEffect(() => {
        openPreferences();
        navigate("/", { replace: true });
    }, [navigate, openPreferences]);

    return null;
}
