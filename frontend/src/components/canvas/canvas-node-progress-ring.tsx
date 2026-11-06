import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";

const ringPad = 2;
const ringRadius = 26;

/**
 * The one charge light: a breathing halo, a brushing midpoint and a tapered tail that rides the
 * card's rounded rectangle as the run advances.
 *
 * Deliberately not a palette table: the look is fixed here and there is nothing to choose.
 */
const glow = {
    dark: { aura: "#38d6ff", mid: "#8cefff", core: "#d7fbff", gradient: ["#8cefff", "#6edcff", "#4aa3ff"] },
    light: { aura: "#2f9bff", mid: "#5bb8ff", core: "#0b6fd6", gradient: ["#0b6fd6", "#2f9bff", "#7dd3fc"] },
} as const;

const look = {
    coreWidth: 1.4,
    auraWidth: 11,
    auraOpacity: 0.05,
    auraBlur: 8,
    haloWidth: 6,
    haloOpacity: 0.11,
    haloBlur: 5,
    midWidth: 3,
    midOpacity: 0.18,
    midBlur: 2,
    tailLength: 9,
    tailWidth: 3.4,
    tailOpacity: 0.15,
    tailBlur: 3,
    headScale: 1,
    breatheSeconds: 2.8,
} as const;

export function CanvasNodeProgressRing({ width, height, step, total, complete = false }: { width: number; height: number; step: number; total: number; complete?: boolean }) {
    const themeName = useThemeStore((state) => state.theme);
    const theme = useCanvasTheme();
    const palette = glow[themeName];
    const ratio = complete ? 1 : total > 0 ? Math.min(1, Math.max(0, step / total)) : 0;
    const boxWidth = width + ringPad * 2;
    const boxHeight = height + ringPad * 2;
    const radius = Math.min(ringRadius, boxWidth / 2, boxHeight / 2);
    const coreWidth = look.coreWidth;
    const path = roundedRectPath(boxWidth, boxHeight, radius, coreWidth);
    const head = pointAtProgress(boxWidth, boxHeight, radius, ratio, coreWidth / 2);
    const { aura, mid, core } = palette;
    const track = theme.node.stroke;
    const gradientId = `canvas-ring-gradient-${themeName}`;
    const fillLength = ratio * 100;
    const tailLength = Math.min(look.tailLength, fillLength);

    return (
        <div className="pointer-events-none absolute z-[58]" style={{ left: -ringPad, top: -ringPad, width: boxWidth, height: boxHeight }}>
            <style>{`
                @keyframes canvas-ring-breathe { 0%, 100% { opacity: .45 } 50% { opacity: 1 } }
                @keyframes canvas-ring-head { 0%, 100% { opacity: .62 } 50% { opacity: 1 } }
                @keyframes canvas-ring-fade { 0%, 55% { opacity: 1 } 100% { opacity: 0 } }
                @keyframes canvas-ring-flash { 0% { opacity: 0 } 35% { opacity: .5 } 100% { opacity: 0 } }
                @keyframes canvas-ring-core-flash { 0% { opacity: 0 } 30% { opacity: 1 } 100% { opacity: 0 } }
            `}</style>
            <svg width={boxWidth} height={boxHeight} viewBox={`0 0 ${boxWidth} ${boxHeight}`} className="overflow-visible" aria-hidden="true">
                <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor={palette.gradient[0]} />
                        <stop offset="55%" stopColor={palette.gradient[1]} />
                        <stop offset="100%" stopColor={palette.gradient[2]} />
                    </linearGradient>
                </defs>
                <g style={complete ? { animation: "canvas-ring-fade 1.45s ease forwards" } : undefined}>
                    <path d={path} fill="none" stroke={track} strokeWidth={1.1} opacity={0.18} style={{ animation: `canvas-ring-breathe ${look.breatheSeconds + 0.4}s ease-in-out infinite` }} />
                    {ratio > 0 ? (
                        <g>
                            <path
                                d={path}
                                fill="none"
                                stroke={aura}
                                strokeWidth={look.auraWidth}
                                strokeLinecap="round"
                                pathLength={100}
                                style={{
                                    strokeDasharray: `${fillLength} 100`,
                                    opacity: look.auraOpacity,
                                    filter: `blur(${look.auraBlur}px)`,
                                    transition: "stroke-dasharray 320ms cubic-bezier(.22,.61,.36,1)",
                                }}
                            />
                            <path
                                d={path}
                                fill="none"
                                stroke={aura}
                                strokeWidth={look.haloWidth}
                                strokeLinecap="round"
                                pathLength={100}
                                style={{
                                    strokeDasharray: `${fillLength} 100`,
                                    opacity: look.haloOpacity,
                                    filter: `blur(${look.haloBlur}px) drop-shadow(0 0 4px ${aura})`,
                                    transition: "stroke-dasharray 320ms cubic-bezier(.22,.61,.36,1)",
                                    animation: `canvas-ring-breathe ${look.breatheSeconds}s ease-in-out infinite`,
                                }}
                            />
                            <path
                                d={path}
                                fill="none"
                                stroke={mid}
                                strokeWidth={look.midWidth}
                                strokeLinecap="round"
                                pathLength={100}
                                style={{
                                    strokeDasharray: `${fillLength} 100`,
                                    opacity: look.midOpacity,
                                    filter: `blur(${look.midBlur}px)`,
                                    transition: "stroke-dasharray 320ms cubic-bezier(.22,.61,.36,1)",
                                    animation: `canvas-ring-breathe ${look.breatheSeconds}s ease-in-out .5s infinite`,
                                }}
                            />
                            {tailLength > 0.5 ? (
                                <path
                                    d={path}
                                    fill="none"
                                    stroke={aura}
                                    strokeWidth={look.tailWidth}
                                    strokeLinecap="round"
                                    pathLength={100}
                                    style={{
                                        strokeDasharray: `${tailLength} 100`,
                                        strokeDashoffset: -(fillLength - tailLength),
                                        opacity: look.tailOpacity,
                                        filter: `blur(${look.tailBlur}px)`,
                                        transition: "stroke-dasharray 320ms cubic-bezier(.22,.61,.36,1), stroke-dashoffset 320ms cubic-bezier(.22,.61,.36,1)",
                                    }}
                                />
                            ) : null}
                        </g>
                    ) : null}
                    {ratio > 0 ? (
                        <path
                            d={path}
                            fill="none"
                            stroke={`url(#${gradientId})`}
                            strokeWidth={coreWidth}
                            strokeLinecap="round"
                            pathLength={100}
                            opacity={0.9}
                            style={{
                                strokeDasharray: `${fillLength} 100`,
                                filter: `drop-shadow(0 0 2px ${aura})`,
                                transition: "stroke-dasharray 320ms cubic-bezier(.22,.61,.36,1)",
                            }}
                        />
                    ) : null}
                    {ratio > 0 && ratio < 1 ? (
                        <g
                            style={{
                                transform: `translate(${head.x}px, ${head.y}px)`,
                                transition: "transform 320ms cubic-bezier(.22,.61,.36,1)",
                            }}
                        >
                            <g style={{ animation: `canvas-ring-head ${Math.max(1.4, look.breatheSeconds - 0.9)}s ease-in-out infinite` }}>
                                <circle r={4.5 * look.headScale} fill={aura} opacity={0.14} style={{ filter: "blur(3px)" }} />
                                <circle r={2.2 * look.headScale} fill={mid} opacity={0.28} style={{ filter: "blur(1px)" }} />
                                <circle r={0.9 * look.headScale} fill={core} opacity={0.95} />
                            </g>
                        </g>
                    ) : null}
                    {complete ? (
                        <>
                            <path d={path} fill="none" stroke={aura} strokeWidth={look.haloWidth + 3} strokeLinecap="round" opacity={0} style={{ filter: `blur(${look.haloBlur}px)`, animation: "canvas-ring-flash .95s ease-out forwards" }} />
                            <path d={path} fill="none" stroke={core} strokeWidth={coreWidth + 0.2} strokeLinecap="round" opacity={0} style={{ filter: `drop-shadow(0 0 4px ${aura})`, animation: "canvas-ring-core-flash .95s ease-out forwards" }} />
                        </>
                    ) : null}
                </g>
            </svg>
        </div>
    );
}

function roundedRectPath(width: number, height: number, radius: number, strokeWidth: number) {
    const inset = strokeWidth / 2;
    const left = inset;
    const top = inset;
    const right = width - inset;
    const bottom = height - inset;
    const r = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
    return [
        `M ${left + r} ${top}`,
        `H ${right - r}`,
        `A ${r} ${r} 0 0 1 ${right} ${top + r}`,
        `V ${bottom - r}`,
        `A ${r} ${r} 0 0 1 ${right - r} ${bottom}`,
        `H ${left + r}`,
        `A ${r} ${r} 0 0 1 ${left} ${bottom - r}`,
        `V ${top + r}`,
        `A ${r} ${r} 0 0 1 ${left + r} ${top}`,
        "Z",
    ].join(" ");
}

function pointAtProgress(width: number, height: number, radius: number, ratio: number, inset: number) {
    const left = inset;
    const top = inset;
    const right = width - inset;
    const bottom = height - inset;
    const r = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
    const straightX = Math.max(0, right - left - 2 * r);
    const straightY = Math.max(0, bottom - top - 2 * r);
    const arc = (Math.PI * r) / 2;
    const perimeter = 2 * straightX + 2 * straightY + 4 * arc;
    let distance = Math.min(perimeter, Math.max(0, ratio * perimeter));
    const segments = [
        { type: "line" as const, length: straightX, from: { x: left + r, y: top }, to: { x: right - r, y: top } },
        { type: "arc" as const, length: arc, cx: right - r, cy: top + r, from: -Math.PI / 2, to: 0 },
        { type: "line" as const, length: straightY, from: { x: right, y: top + r }, to: { x: right, y: bottom - r } },
        { type: "arc" as const, length: arc, cx: right - r, cy: bottom - r, from: 0, to: Math.PI / 2 },
        { type: "line" as const, length: straightX, from: { x: right - r, y: bottom }, to: { x: left + r, y: bottom } },
        { type: "arc" as const, length: arc, cx: left + r, cy: bottom - r, from: Math.PI / 2, to: Math.PI },
        { type: "line" as const, length: straightY, from: { x: left, y: bottom - r }, to: { x: left, y: top + r } },
        { type: "arc" as const, length: arc, cx: left + r, cy: top + r, from: Math.PI, to: (Math.PI * 3) / 2 },
    ];
    for (const segment of segments) {
        if (distance > segment.length) {
            distance -= segment.length;
            continue;
        }
        if (segment.type === "line") {
            const progress = segment.length > 0 ? distance / segment.length : 0;
            return {
                x: segment.from.x + (segment.to.x - segment.from.x) * progress,
                y: segment.from.y + (segment.to.y - segment.from.y) * progress,
            };
        }
        const angle = segment.from + (segment.to - segment.from) * (segment.length > 0 ? distance / segment.length : 0);
        return { x: segment.cx + Math.cos(angle) * r, y: segment.cy + Math.sin(angle) * r };
    }
    return { x: left + r, y: top };
}
