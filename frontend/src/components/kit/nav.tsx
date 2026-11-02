import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Collapse — the one piece of chrome that carries its content in antd's `items` array. Keeping that
 * shape means the `items` literal at the call site did not move; only what renders it changed.
 *
 * `Tabs` used to sit here too. It rendered the three tabs of the settings window (Gateway,
 * Preferences, Add workflows); when the window was split into two, nothing else wanted tabs (#190).
 */

/* -------------------------------------------------------------- Collapse */

type CollapseItem = { key: string; label?: ReactNode; children?: ReactNode; extra?: ReactNode };

export function Collapse({
    items,
    activeKey,
    defaultActiveKey = [],
    onChange,
    ghost = false,
    size = "middle",
    className,
}: {
    items: readonly CollapseItem[];
    activeKey?: string | string[];
    defaultActiveKey?: string | string[];
    onChange?: (keys: string[]) => void;
    ghost?: boolean;
    size?: "small" | "middle";
    className?: string;
}): ReactNode {
    const asArray = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
    const [internal, setInternal] = useState<string[]>(asArray(defaultActiveKey));
    const openKeys = activeKey === undefined ? internal : asArray(activeKey);
    const toggle = (key: string) => {
        const next = openKeys.includes(key) ? openKeys.filter((current) => current !== key) : [...openKeys, key];
        if (activeKey === undefined) setInternal(next);
        onChange?.(next);
    };
    return (
        <div className={cn(!ghost && "overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800", className)}>
            {items.map((item) => {
                const open = openKeys.includes(item.key);
                return (
                    <div key={item.key} className={cn(!ghost && "border-b border-stone-200 last:border-b-0 dark:border-stone-800")}>
                        <button
                            type="button"
                            aria-expanded={open}
                            onClick={() => toggle(item.key)}
                            className={cn(
                                "flex w-full items-center justify-between gap-2 text-left text-stone-700 transition-colors hover:bg-stone-50 dark:text-stone-200 dark:hover:bg-stone-800",
                                size === "small" ? "px-2 py-1.5 text-[13px]" : "px-3 py-2 text-sm",
                            )}
                        >
                            <span className="min-w-0">{item.label}</span>
                            <span className="flex shrink-0 items-center gap-2">
                                {item.extra}
                                <ChevronDown className={cn("size-4 text-stone-400 transition-transform", open && "rotate-180")} />
                            </span>
                        </button>
                        {open ? <div className={cn(size === "small" ? "px-2 pb-2" : "px-3 pb-3")}>{item.children}</div> : null}
                    </div>
                );
            })}
        </div>
    );
}
