type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

/**
 * Canvas surface palette — deliberately its own thing.
 *
 * This is *feature data*, not app chrome: `useCanvasTheme()` hands these values to
 * node renderers and to the node context. It therefore stays plain hex/rgba in TS
 * rather than moving into CSS custom properties.
 *
 * The light palette leans on the same warm neutrals as Tailwind's `stone` scale but is
 * not generated from it: the canvas is warm paper, while app chrome is cooler, and
 * several values here have no `stone` counterpart. Don't "unify" it without deciding
 * that the canvas should stop looking like paper.
 */
export const canvasThemes = {
    light: {
        canvas: {
            background: "#f4f2ed",
            dot: "rgba(68,64,60,.28)",
            line: "rgba(68,64,60,.12)",
            selectionStroke: "#1c1917",
            selectionFill: "rgba(28,25,23,.06)",
        },
        node: {
            label: "#57534e",
            fill: "#e7e5df",
            panel: "#fbfaf7",
            stroke: "#d6d3ca",
            activeStroke: "#1c1917",
            placeholder: "#8a8479",
            text: "#292524",
            muted: "#78716c",
            faint: "#a8a29e",
        },
        toolbar: {
            panel: "rgba(251,250,247,.96)",
            border: "#d6d3ca",
            item: "#57534e",
            itemHover: "#e7e5df",
            activeBg: "#e7e5df",
            activeText: "#292524",
        },
    },
    dark: {
        canvas: {
            background: "#181715",
            dot: "rgba(245,245,244,.24)",
            line: "rgba(245,245,244,.10)",
            selectionStroke: "#fafaf9",
            selectionFill: "rgba(250,250,249,.10)",
        },
        node: {
            label: "#d6d3d1",
            fill: "#292524",
            panel: "#1f1d1a",
            stroke: "#44403c",
            activeStroke: "#fafaf9",
            placeholder: "#a8a29e",
            text: "#f5f5f4",
            muted: "#d6d3d1",
            faint: "#78716c",
        },
        toolbar: {
            panel: "rgba(31,29,26,.96)",
            border: "#44403c",
            item: "#d6d3d1",
            itemHover: "#292524",
            activeBg: "#3a3631",
            activeText: "#f5f5f4",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];

/** Which palette this is. The two are singletons in `canvasThemes`, so identity answers it. */
function modeOf(theme: CanvasTheme): CanvasColorTheme {
    return theme === canvasThemes.dark ? "dark" : "light";
}

/**
 * What a native `<select>` on the canvas needs — and why it needs anything at all.
 *
 * Its popup is the browser's, not ours: it is painted from the colour scheme the element declares, not from
 * the card behind it. A select whose text colour came from the palette therefore opened a **light** list of
 * **light** text in dark mode — the upscaler's model names were unreadable, and nothing in the CSS could reach
 * that list. `colorScheme` is the one property Chromium and Firefox paint the popup from; the option colours
 * (`nativeOptionStyle`) cover renderers that take them from the element instead.
 */
export function nativeSelectStyle(theme: CanvasTheme) {
    return { colorScheme: modeOf(theme), borderColor: theme.node.stroke, color: theme.node.text };
}

/** The same for one option: a popup row follows the card it belongs to, not the OS. */
export function nativeOptionStyle(theme: CanvasTheme) {
    return { background: theme.node.panel, color: theme.node.text };
}
