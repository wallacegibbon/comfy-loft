import { useEffect } from "react";
import type { ReactNode } from "react";

import { useLocalGatewaySync } from "@/hooks/use-local-gateway-sync";
import { flushCanvasSaves, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useSettingsStore } from "@/stores/use-settings-store";

/**
 * What has to run once, before the canvas is usable.
 *
 * Three things now, and the third is the one the browser store used to do for free: the canvas list
 * lives on the gateway, so somebody has to ask for it, and the saves that a debounce is still holding
 * have to be pushed out when the page goes away.
 *
 * It used to also read a channel out of the address bar. There is one channel and its address is the
 * page's own gateway (docs/decisions.md #71), so there is nothing left to import — and since #153
 * nothing left to authenticate with either.
 */
export function ClientRootInit({ children }: { children: ReactNode }) {
    useLocalGatewaySync();

    useEffect(() => {
        void useCanvasStore.getState().refresh();
        // Normally a no-op: the preferences arrive in `config.js`, before the bundle. This asks over
        // HTTP only when an operator serves no first-paint file, and the store refuses to save until
        // one of the two has produced a document.
        void useSettingsStore.getState().load();
        // `pagehide` rather than `beforeunload`: it also fires on the mobile cases where `beforeunload`
        // does not, and a queued save is the only thing here that cannot be reconstructed.
        const flush = () => {
            flushCanvasSaves();
            useSettingsStore.getState().flush();
        };
        window.addEventListener("pagehide", flush);
        return () => window.removeEventListener("pagehide", flush);
    }, []);

    return <>{children}</>;
}
