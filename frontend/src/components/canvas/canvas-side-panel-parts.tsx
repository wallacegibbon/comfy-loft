import { Check } from "lucide-react";

import { type CanvasTheme } from "@/lib/canvas-theme";

/**
 * The tick a list in the left column draws when it is in select mode.
 *
 * A file of its own because both sections draw it: the canvases list selects canvases to delete, the
 * elements list selects nodes to export, and the two have to look like the same gesture (#195). Both
 * sections' bars — select all, how many, the action — are the same shape for the same reason.
 */
export function CheckMark({ checked, theme }: { checked: boolean; theme: CanvasTheme }) {
    return (
        <span className="grid size-4 shrink-0 place-items-center rounded border transition" style={{ borderColor: checked ? theme.toolbar.activeText : theme.node.stroke, background: checked ? theme.toolbar.activeText : "transparent" }}>
            {checked ? <Check className="size-3 text-white" /> : null}
        </span>
    );
}
