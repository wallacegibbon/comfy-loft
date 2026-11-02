import type { ReactNode } from "react";

import { PreferencesDialog } from "@/components/settings/preferences-dialog";
import { AddWorkflowsDialog } from "@/components/settings/workflows-dialog";
import { ResourceSetupGate } from "@/components/settings/resource-setup-gate";

/**
 * The only layout left.
 *
 * There used to be a top bar here with a brand link and three tabs — canvases, assets,
 * settings. All three became panels over the canvas (the asset library has since been
 * removed), so the bar had nothing to hold. What remains are the three dialogs that are genuinely
 * global and belong outside any one canvas: preferences, the workflows you can install, and the
 * first-run resource prompt. The storage-recovery banner went with the browser store it reported
 * on (#154).
 */
export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
            <PreferencesDialog />
            <AddWorkflowsDialog />
            <ResourceSetupGate />
        </div>
    );
}
