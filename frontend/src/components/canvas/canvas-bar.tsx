import { useEffect, useRef, useState, type ReactNode } from "react";

import { ChevronDown } from "lucide-react";

import { Tooltip } from "@/components/kit/tooltip";

/**
 * The two bars that float over the canvas, as one pill and one button.
 *
 * There are two of them — the one over a selected card (its own verbs, docs/decisions.md #332) and the one over
 * a selection of several (group, ungroup, play together, join) — and they are the same object at different
 * sizes: a white 48-pixel pill with a list of labelled buttons, drawn at `z-[45]`, under the canvas chrome and
 * above the board (#192). Each was written out in full in its own file, so the shadow, the radius, the hover
 * background and the tooltip's four props existed twice, and adding a verb to either bar meant copying the
 * button again. One pill, one button, two callers.
 *
 * What stays with the callers is where the bar goes: a card's bar hangs from its top edge, a selection's hangs
 * from the top of the box drawn around it.
 */

/** The pill every canvas bar is drawn on. `nodeId` tags it for the one reader that measures it (`project.tsx`). */
export function CanvasBar({ left, top, nodeId, children }: { left: number; top: number; nodeId?: string; children: ReactNode }) {
    return (
        <div
            className="absolute z-[45] flex h-12 -translate-x-1/2 -translate-y-full items-center overflow-visible rounded-[18px] border border-black/10 bg-white text-[15px] text-[#242529] shadow-[0_8px_28px_rgba(15,23,42,.12)]"
            data-node-toolbar={nodeId}
            style={{ left, top }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {children}
        </div>
    );
}

export type CanvasBarItem = {
    id: string;
    /** What the button says. Always visible since #332, so it is the verb rather than a hint at one. */
    label: string;
    /** What hovering it says: the same act, with room for the sentence the label cannot hold. */
    title: string;
    icon: ReactNode;
    onClick?: () => void;
    /** The choices behind one button, when the verbs are forms of one act — a clip's frame grabs are (#333). */
    menu?: { id: string; label: string; icon: ReactNode; onClick: () => void }[];
};

/** One labelled button on a bar, with the choices behind it when it has any. */
export function CanvasBarButton({ label, title, icon, onClick, menu }: Omit<CanvasBarItem, "id">) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const isOpen = Boolean(menu) && open;

    // The popover belongs to the button and closes on any press outside it. Capture phase, so a press that starts
    // a drag on the canvas closes the menu before the drag begins.
    useEffect(() => {
        if (!open) return;
        const close = (event: PointerEvent) => {
            if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
            setOpen(false);
        };
        window.addEventListener("pointerdown", close, true);
        return () => window.removeEventListener("pointerdown", close, true);
    }, [open]);

    return (
        <div ref={rootRef} className="relative flex h-12 items-center">
            <Tooltip title={title} placement="top" mouseEnterDelay={0.2} color="#ffffff" styles={{ root: { color: "#242529", boxShadow: "0 8px 24px rgba(15,23,42,.16)", fontSize: 13, fontWeight: 500 } }}>
                <button
                    type="button"
                    className="group relative flex h-12 items-center whitespace-nowrap px-1.5"
                    onClick={() => (menu ? setOpen((value) => !value) : onClick?.())}
                    aria-label={title}
                    aria-haspopup={menu ? "menu" : undefined}
                    aria-expanded={menu ? isOpen : undefined}
                >
                    <span className={`flex h-9 items-center gap-2 rounded-lg px-2.5 transition group-hover:bg-[#f0f0f1] ${isOpen ? "bg-[#eeeeef]" : ""}`}>
                        {icon}
                        <span>{label}</span>
                        {menu ? <ChevronDown className="size-3.5 opacity-40" /> : null}
                    </span>
                </button>
            </Tooltip>
            {isOpen ? (
                <div role="menu" className="absolute left-0 top-full z-10 mt-1 min-w-44 overflow-hidden rounded-xl border border-[#e3e3e5] bg-white py-1 text-[13px] text-[#242529] shadow-[0_12px_32px_rgba(15,23,42,.18)]">
                    {menu?.map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            role="menuitem"
                            className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left transition-colors hover:bg-[#f0f0f1]"
                            onClick={() => {
                                setOpen(false);
                                item.onClick();
                            }}
                        >
                            {item.icon}
                            <span>{item.label}</span>
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
