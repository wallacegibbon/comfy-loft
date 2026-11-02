import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Tabs and Collapse — the two pieces of chrome that carry their content in antd's `items`
 * arrays. Keeping that shape means the `items` literals at the call sites did not move;
 * only what renders them changed.
 */

/* ------------------------------------------------------------------ Tabs */

type TabItem = { key: string; label?: ReactNode; children?: ReactNode; icon?: ReactNode };

export function Tabs({ items, activeKey, defaultActiveKey, onChange, className }: { items: readonly TabItem[]; activeKey?: string; defaultActiveKey?: string; onChange?: (key: string) => void; className?: string }): ReactNode {
    const [internal, setInternal] = useState(defaultActiveKey ?? items[0]?.key);
    const current = activeKey ?? internal;
    const select = (key: string) => {
        if (activeKey === undefined) setInternal(key);
        onChange?.(key);
    };
    const active = items.find((item) => item.key === current);
    return (
        <div className={className}>
            <div role="tablist" className="flex items-center gap-1 border-b border-stone-200 dark:border-stone-800">
                {items.map((item) => {
                    const selected = item.key === current;
                    return (
                        <button
                            key={item.key}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            onClick={() => select(item.key)}
                            className={cn(
                                "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
                                selected ? "border-stone-900 font-medium text-stone-900 dark:border-stone-100 dark:text-stone-100" : "border-transparent text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200",
                            )}
                        >
                            {item.icon}
                            {item.label}
                        </button>
                    );
                })}
            </div>
            {active?.children !== undefined ? (
                <div role="tabpanel" className="pt-4">
                    {active.children}
                </div>
            ) : null}
        </div>
    );
}

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
