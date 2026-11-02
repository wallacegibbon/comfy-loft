import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Dialog } from "@/components/kit/dialog";
import { ResourceCenterPanel } from "@/components/settings/resource-center-panel";
import { useConfigStore } from "@/stores/use-config-store";

/**
 * The Add workflows window: the resource panel in a floating frame.
 *
 * Two things open it — the button next to the preferences one in the top bar, and the first-run
 * `ResourceSetupGate` — and they must look like the same window, so the frame, its width and its padding
 * are stated once, here. The panel is the body; the caller brings the heading.
 */
export function WorkflowsDialog({
    open,
    onClose,
    title,
    closable = true,
    compact = false,
    footer,
}: {
    open: boolean;
    onClose: () => void;
    /** The window heading. Required: the panel draws a summary card, not a title bar. */
    title: ReactNode;
    /** The first-run gate cannot be dismissed while it is the only way in. */
    closable?: boolean;
    /** Smaller rows, for the gate that has to fit the same frame. */
    compact?: boolean;
    /** Rendered at the end of the panel, inside the scrolling body. */
    footer?: ReactNode;
}) {
    return (
        <Dialog open={open} onClose={onClose} size="panel" title={title} closable={closable} bodyStyle={{ maxHeight: "72vh" }} bodyClassName="pr-3">
            <ResourceCenterPanel compact={compact} footer={footer} />
        </Dialog>
    );
}

/** The window the top bar's Add workflows button opens. */
export function AddWorkflowsDialog() {
    const { t } = useTranslation();
    const open = useConfigStore((state) => state.workflowsOpen);
    const setOpen = useConfigStore((state) => state.setWorkflowsOpen);
    return <WorkflowsDialog open={open} onClose={() => setOpen(false)} title={<div className="text-lg font-semibold">{t("resources.panel.title")}</div>} />;
}
