import type { CSSProperties } from "react";

import { Keyboard, PackagePlus, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Tooltip } from "@/components/kit/tooltip";
import { AnimatedThemeToggler } from "@/components/kit/animated-theme-toggler";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { writeSetting } from "@/stores/use-settings-store";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

type UserStatusActionsProps = {
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
};

/**
 * The right-hand end of the top bar: the two windows that are settings-ish, then the toggles.
 *
 * Preferences and Add workflows used to be two tabs of one window behind one gear, so the gear's own
 * label was a choice ("Settings") that described neither. They are separate windows now, and each has the
 * button that opens it (#190).
 */
export function UserStatusActions({ variant = "default", onOpenShortcuts }: UserStatusActionsProps) {
    const { i18n, t } = useTranslation();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openPreferences = useConfigStore((state) => state.openPreferences);
    const openWorkflows = useConfigStore((state) => state.openWorkflows);
    const canvasTheme = useCanvasTheme();
    const naturalIconClass =
        "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const languageLabel = t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") });

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openPreferences()} aria-label={t("topNav.preferences")} title={t("topNav.preferences")}>
                <SlidersHorizontal className="size-4" />
            </button>
            <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openWorkflows()} aria-label={t("topNav.addWorkflows")} title={t("topNav.addWorkflows")}>
                <PackagePlus className="size-4" />
            </button>
            <Tooltip title={languageLabel} mouseEnterDelay={0.2}>
                <button
                    type="button"
                    className={`${naturalIconClass} text-[11px] font-semibold tracking-tight`}
                    style={iconStyle}
                    onClick={() => {
                        writeSetting("locale", nextLocale);
                        void changeAppLocale(nextLocale);
                    }}
                    aria-label={languageLabel}
                >
                    {/* Shows the language a click switches to: EN while Chinese is active, and the Chinese
                        label while English is active, so someone who cannot read the current UI still
                        finds the toggle. */}
                    {nextLocale === "zh-CN" ? "中" : "EN"}
                </button>
            </Tooltip>
            <AnimatedThemeToggler
                theme={theme}
                onThemeChange={setTheme}
                className={naturalIconClass}
                style={iconStyle}
                aria-label={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")}
                title={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")}
            />
            {onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={t("topNav.shortcuts")} title={t("topNav.shortcuts")}>
                    <Keyboard className="size-4" />
                </button>
            ) : null}
        </div>
    );
}
