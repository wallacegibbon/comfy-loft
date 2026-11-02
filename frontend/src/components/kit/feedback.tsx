import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Status display, replacing antd's `Progress`.
 *
 * It keeps antd's prop names for the subset in use, and draws a single bar — antd's circle and
 * dashboard variants are not needed here. `Alert` lived here too, for the browser storage panel; that
 * panel went with the browser store it reported on (#155), so the banner went with it.
 */
type ProgressStatus = "normal" | "active" | "success" | "exception";

export function Progress({ percent = 0, showInfo = false, size = "middle", status = "normal", className }: { percent?: number; showInfo?: boolean; size?: "small" | "middle"; status?: ProgressStatus; className?: string }): ReactNode {
    const clamped = Math.max(0, Math.min(100, percent));
    const fill = status === "exception" ? "bg-red-500" : status === "success" ? "bg-emerald-500" : "bg-stone-900 dark:bg-stone-100";
    return (
        <div className={cn("flex items-center gap-2", className)}>
            <div role="progressbar" aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100} className={cn("flex-1 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800", size === "small" ? "h-1.5" : "h-2")}>
                <div className={cn("h-full rounded-full transition-[width] duration-300", fill)} style={{ width: `${clamped}%` }} />
            </div>
            {showInfo ? <span className="shrink-0 text-xs tabular-nums text-stone-500 dark:text-stone-400">{Math.round(clamped)}%</span> : null}
        </div>
    );
}
