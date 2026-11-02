import { Check } from "lucide-react";
import type { ReactNode } from "react";

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

/**
 * The row above a list in the column, at one height for both lists and for every mode they can be in.
 *
 * The height is on the row because the row's contents change as the list is used and they are not the same
 * height as each other (#199): the type filter's dropdown is `h-7` (28px), the ghost buttons beside it are 24,
 * the count is 16, and entering select mode takes the dropdown away entirely. A row that sized itself moved the
 * list under it up by four pixels every time a control appeared or disappeared — and the two sections, with
 * different children, were a couple of pixels apart from each other as well, so switching tabs moved the list
 * too. 32px clears the tallest of them with room to breathe; what is inside is centred and cannot reach it.
 */
export function PanelHeaderRow({ children }: { children: ReactNode }) {
    return <div className="mb-2.5 flex h-8 shrink-0 items-center gap-1.5 px-3">{children}</div>;
}
