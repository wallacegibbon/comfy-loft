import type { ReactNode } from "react";

import { StorageRecoveryBanner } from "@/components/layout/storage-recovery-banner";
import { AppConfigModal } from "@/components/settings/app-config-modal";
import { ResourceSetupGate } from "@/components/settings/resource-setup-gate";

/**
 * The only layout left.
 *
 * There used to be a top bar here with a brand link and three tabs — canvases, assets,
 * settings. All three became panels over the canvas (the asset library has since been
 * removed), so the bar had nothing to hold. What remains is the two things that are genuinely
 * global and belong outside any one canvas: the settings dialog and the first-run resource
 * prompt.
 */
export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
            {/* The one notice that must survive until it is answered: a store that could not be
                read. It is kept out of the canvas so that it cannot be covered by anything. */}
            <div className="pointer-events-none fixed inset-x-0 top-16 z-[2999] flex flex-col items-center gap-2 px-4">
                <StorageRecoveryBanner />
            </div>
            <AppConfigModal />
            <ResourceSetupGate />
        </div>
    );
}
