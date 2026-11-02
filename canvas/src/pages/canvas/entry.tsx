import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { lastCanvasId } from "@/lib/canvas/last-canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

/**
 * `/` is not a page, it is the way in.
 *
 * This renders nothing: it picks a canvas and replaces the URL with that canvas's own address, so the
 * app has no landing screen to sit on. The choice, in order:
 *
 *   1. the canvas you were last inside — read from a stored id rather than inferred from `updatedAt`,
 *      because opening a canvas to look at it does not change `updatedAt` and the most recently
 *      *modified* canvas is often not the one you left;
 *   2. otherwise the most recently modified one, for when that memory is stale or belongs to a canvas
 *      this machine has never seen;
 *   3. otherwise a new canvas, which is the first-run case.
 *
 * `replace` matters: without it the history keeps `/`, and every Back press bounces through the
 * redirect again.
 *
 * The list comes from the gateway now, so this waits for it and is allowed to fail: if the gateway is
 * unreachable the app stays here rather than inventing a canvas it cannot save.
 */
export function CanvasEntry() {
    const { t } = useTranslation();
    const ready = useCanvasStore((state) => state.ready);
    const [targetId, setTargetId] = useState("");
    const [failed, setFailed] = useState(false);
    const resolved = useRef(false);

    useEffect(() => {
        if (!ready || resolved.current) return;
        resolved.current = true;

        void (async () => {
            const store = useCanvasStore.getState();
            const remembered = lastCanvasId();
            if (remembered && store.canvases.some((canvas) => canvas.id === remembered)) {
                setTargetId(remembered);
                return;
            }
            const newest = store.canvases.reduce<{ id: string; updatedAt: string } | null>((best, canvas) => (!best || canvas.updatedAt > best.updatedAt ? canvas : best), null);
            if (newest) {
                setTargetId(newest.id);
                return;
            }
            try {
                setTargetId(await store.createCanvas(t("canvas.defaultTitle", { count: store.canvases.length + 1 })));
            } catch {
                // No canvas and no way to make one: the gateway is down. Staying put is honest — a
                // canvas created optimistically would have nowhere to be saved.
                setFailed(true);
            }
        })();
    }, [ready, t]);

    if (failed) {
        return <div className="flex h-dvh items-center justify-center p-8 text-center text-sm text-stone-500">{t("canvas.gatewayUnavailable")}</div>;
    }
    if (!targetId) return null;
    return <Navigate replace to={`/canvas/${targetId}`} />;
}
