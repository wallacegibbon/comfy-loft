import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** The loading state every list in this app needs, replacing antd's `Spin`. */
export function Spin({ size = "middle", className }: { size?: "small" | "middle" | "large"; className?: string }): ReactNode {
    const dimension = size === "small" ? "size-4" : size === "large" ? "size-8" : "size-5";
    return (
        <span role="status" aria-live="polite" className={cn("inline-flex items-center justify-center text-stone-400", className)}>
            <LoaderCircle className={cn(dimension, "animate-spin")} aria-hidden="true" />
        </span>
    );
}
