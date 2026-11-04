import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Slider } from "@/components/kit/input";
import { audioFormatLabel, audioFormatOptions, clampAudioSeconds, normalizeAudioFormatValue } from "@/lib/audio-generation";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { channelModelOf, type AiConfig } from "@/stores/use-config-store";

type AudioSettingKey = "audioFormat" | "audioSeconds" | "audioInstructions";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

/**
 * What a music node can be told: the container it is written in, how long it may run, and the lyrics.
 *
 * Every control here reaches the run — the format and the length go on the request, the lyrics field is its
 * `lyrics` input. A voice and a speed used to sit next to them, from when audio meant OpenAI's speech
 * endpoint; neither is declared by any workflow the server registers, and both were dropped with that
 * endpoint (#260).
 *
 * The length control exists only when the workflow declares a range for it, so a workflow that has no
 * duration input offers none rather than a number that would go nowhere. The bounds are the workflow's own
 * (`parameters.duration`), which is why a song may be asked to run for six minutes while a five-second
 * ceiling would come from a different graph's declaration.
 */
export function AudioSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: AudioSettingsPanelProps) {
    const { t } = useTranslation();
    const format = normalizeAudioFormatValue(config.audioFormat);
    const duration = channelModelOf(config, config.model || config.audioModel)?.model.duration;
    const seconds = duration ? clampAudioSeconds(config.audioSeconds, duration) : 0;

    return (
        <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
            {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.audio.title")}</div> : null}
            <SettingGroup title={t("settingsPanels.audio.format")} color={theme.node.muted}>
                <div className="grid grid-cols-3 gap-2.5">
                    {audioFormatOptions.map((item) => (
                        <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("audioFormat", item.value)}>
                            {item.label}
                        </OptionPill>
                    ))}
                </div>
            </SettingGroup>
            {duration ? (
                <SettingGroup title={t("settingsPanels.audio.seconds")} color={theme.node.muted}>
                    <div className="flex items-center gap-3" onMouseDown={(event) => event.stopPropagation()}>
                        <Slider className="min-w-0 flex-1" min={duration.min} max={duration.max} step={1} value={seconds} onChange={(value) => onConfigChange("audioSeconds", String(value))} />
                        <SecondsInput value={seconds} min={duration.min} max={duration.max} theme={theme} onCommit={(value) => onConfigChange("audioSeconds", String(value))} />
                        <span className="shrink-0 text-sm" style={{ color: theme.node.muted }}>
                            s
                        </span>
                    </div>
                    <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                        {t("settingsPanels.audio.secondsHint", { min: duration.min, max: duration.max })}
                    </div>
                </SettingGroup>
            ) : null}
            <SettingGroup title={t("settingsPanels.audio.instructions")} color={theme.node.muted}>
                <textarea
                    value={config.audioInstructions || ""}
                    placeholder={t("settingsPanels.audio.instructionsPlaceholder")}
                    className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                    onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                    onMouseDown={(event) => event.stopPropagation()}
                />
            </SettingGroup>
        </div>
    );
}

/**
 * The number beside the slider.
 *
 * A committed value is clamped to the workflow's range, so typing `900` into a 360-second workflow asks for
 * 360 rather than a run the server would refuse. `defaultValue` plus a `key` on the clamped value keeps the
 * box usable while it is being typed into: the stored number only changes when the field is left.
 */
function SecondsInput({ value, min, max, theme, onCommit }: { value: number; min: number; max: number; theme: CanvasTheme; onCommit: (value: number) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = clampAudioSeconds(input.value, { min, max });
        input.value = String(next);
        onCommit(next);
    };

    return (
        <label className="flex h-9 w-[68px] shrink-0 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text }}>
            <input
                type="number"
                min={min}
                max={max}
                className="min-w-0 flex-1 bg-transparent px-2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value}
                key={value}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

/** The trigger's one line: the container and, when the workflow has one, the length. */
export function audioSettingsSummary(config: AiConfig) {
    const duration = channelModelOf(config, config.model || config.audioModel)?.model.duration;
    const format = audioFormatLabel(config.audioFormat);
    return duration ? `${format} · ${clampAudioSeconds(config.audioSeconds, duration)}s` : format;
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}
