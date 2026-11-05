import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { nativeOptionStyle, nativeSelectStyle, type CanvasTheme } from "@/lib/canvas-theme";
import { fetchLoras } from "@/services/api/loras";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

/**
 * The LoRA card: pick one file and a strength, and the node contributes it downstream.
 *
 * It is a card rather than a field on the generation panel because a LoRA is a *choice about the model*,
 * and the same choice usually applies to several generations: wiring one card into two config nodes is
 * how a stack gets reused. The node's whole payload is `metadata.params.loras` — the shape the server's
 * `ApplyLoraChain` already reads — so nothing downstream had to learn about this node (`lora.go`).
 *
 * Strength is snapped to 0.05 and the slider is eased around zero: ±1.0 takes the middle half of the
 * track, because that is where a LoRA is usually tuned, and ±6 is reachable but not in the way.
 */

const STRENGTH_MIN = -6;
const STRENGTH_MAX = 6;
const CENTER_SLOPE = 2.6;
/** Shipped inside a model pack and never meant to be picked by hand. */
const INTERNAL_LORAS = new Set(["MOSS-Image-SFT-8-steps.safetensors"]);

type LoraSpec = { name: string; strength: number };

/** The LoRA this node currently holds, or null when it holds none. */
function loraSpecOf(node: CanvasNodeData): LoraSpec | null {
    const loras = node.metadata?.params?.loras;
    const first = Array.isArray(loras) ? loras[0] : null;
    return first && typeof first.name === "string" ? { name: first.name, strength: Number(first.strength) || 0 } : null;
}

/** What this node contributes to whatever it is wired into. */
export function loraResource(node: CanvasNodeData) {
    const spec = loraSpecOf(node);
    return spec ? { kind: "lora" as const, loras: [{ name: spec.name, strength: spec.strength }] } : null;
}

function shortName(name: string) {
    return (
        String(name || "")
            .split(/[\\/]/)
            .pop() || ""
    );
}

function folderName(name: string) {
    const normalized = String(name || "");
    const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
    return index >= 0 ? normalized.slice(0, index) : "";
}

function snapStrength(value: number) {
    const snapped = Math.round((Number(value) || 0) * 20) / 20;
    return Object.is(snapped, -0) ? 0 : snapped;
}

function sliderToStrength(value: number) {
    const x = Math.max(-1, Math.min(1, Number(value) * 2 - 1));
    return snapStrength(Math.sign(x) * Math.pow(Math.abs(x), CENTER_SLOPE) * STRENGTH_MAX);
}

function strengthToSlider(strength: number) {
    const value = Math.max(STRENGTH_MIN, Math.min(STRENGTH_MAX, Number(strength) || 0));
    const x = Math.sign(value) * Math.pow(Math.abs(value) / STRENGTH_MAX, 1 / CENTER_SLOPE);
    return Math.max(0, Math.min(1, (x + 1) / 2));
}

/** The card's face: what is loaded, and how hard it is pushing. */
export function LoraNodeContent({ node, theme }: { node: CanvasNodeData; theme: CanvasTheme }) {
    const { t } = useTranslation();
    const spec = loraSpecOf(node);
    return (
        <div className="flex h-full flex-col justify-center gap-[5px] overflow-hidden px-3 py-2.5" style={{ color: theme.node.text }}>
            <div className="flex items-center justify-between gap-2 text-[10px] leading-tight" style={{ color: theme.node.muted }}>
                <span className="tracking-[.04em]">LORA</span>
                <span className="tabular-nums">{spec ? spec.strength.toFixed(2) : "—"}</span>
            </div>
            <div className="truncate text-[13px] font-semibold leading-tight">{spec ? shortName(spec.name) : t("canvas.lora.none")}</div>
            <div className="truncate text-[10px] leading-tight" style={{ color: theme.node.faint }}>
                {spec ? folderName(spec.name) || t("canvas.lora.rootFolder") : t("canvas.lora.hint")}
            </div>
        </div>
    );
}

/** The panel under the node: choose the file, set the strength. */
export function LoraNodePanel({ node, theme, onChange }: { node: CanvasNodeData; theme: CanvasTheme; onChange: (patch: Partial<CanvasNodeMetadata>) => void }) {
    const { t } = useTranslation();
    const spec = loraSpecOf(node);
    const [name, setName] = useState(spec?.name || "");
    const [strength, setStrength] = useState(snapStrength(spec?.strength ?? 0.8));
    const [options, setOptions] = useState<string[] | null>(null);

    useEffect(() => {
        let live = true;
        void fetchLoras()
            .then((items) => {
                if (live) setOptions(items.filter((item) => !INTERNAL_LORAS.has(shortName(item))));
            })
            .catch(() => {
                if (live) setOptions([]);
            });
        return () => {
            live = false;
        };
    }, []);

    const apply = (nextName: string, nextStrength: number) => {
        const loras = nextName.trim() ? [{ name: nextName.trim(), strength: Number(nextStrength) || 0 }] : [];
        onChange({ params: { ...(node.metadata?.params || {}), loras } });
    };

    // Grouped by folder, because ComfyUI lists LoRAs by path and two folders can hold the same file name.
    const groups = useMemo(() => {
        const byFolder = new Map<string, string[]>();
        for (const option of options || []) {
            const folder = folderName(option) || t("canvas.lora.rootFolder");
            byFolder.set(folder, [...(byFolder.get(folder) || []), option]);
        }
        return [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b));
    }, [options, t]);

    const inputStyle = { borderColor: theme.node.stroke, background: theme.node.panel, color: theme.node.text };
    // The closed select is styled like the inputs; its popup is the browser's and needs the scheme (`#298`).
    const selectStyle = { ...inputStyle, ...nativeSelectStyle(theme) };

    return (
        <div className="flex flex-col gap-2.5 px-0.5 pt-2.5 text-xs" style={{ color: theme.node.text }}>
            <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{t("canvas.nodeTypes.lora")}</span>
                <span className="text-[11px]" style={{ color: theme.node.muted }}>
                    {options === null ? t("canvas.lora.loading") : t("canvas.lora.available", { count: options.length })}
                </span>
            </div>

            <select
                className="w-full rounded-md border px-2 py-1.5 text-xs outline-none"
                style={selectStyle}
                value={name}
                onChange={(event) => {
                    const next = event.target.value;
                    setName(next);
                    apply(next, strength);
                }}
            >
                <option value="" style={nativeOptionStyle(theme)}>
                    {t("canvas.lora.choose")}
                </option>
                {groups.map(([folder, items]) => (
                    <optgroup key={folder} label={folder}>
                        {items.map((option) => (
                            <option key={option} value={option} style={nativeOptionStyle(theme)}>
                                {shortName(option)}
                            </option>
                        ))}
                    </optgroup>
                ))}
            </select>

            <label className="flex flex-col gap-1 text-[11px]" style={{ color: theme.node.muted }}>
                <span className="flex justify-between">
                    <span>{t("canvas.lora.strength")}</span>
                    <span className="tabular-nums">{strength.toFixed(2)}</span>
                </span>
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.001}
                    value={strengthToSlider(strength)}
                    onChange={(event) => {
                        const next = sliderToStrength(Number(event.target.value));
                        setStrength(next);
                        apply(name, next);
                    }}
                    className="w-full"
                    style={{ accentColor: theme.node.text }}
                />
                <span className="flex justify-between text-[9px] tabular-nums" style={{ color: theme.node.faint }}>
                    <span>-6</span>
                    <span>0</span>
                    <span>+6</span>
                </span>
            </label>
        </div>
    );
}
