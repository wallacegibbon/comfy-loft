import { Group, Merge, Play, Ungroup } from "lucide-react";

import { useTranslation } from "react-i18next";

import { CanvasBar, CanvasBarButton } from "@/components/canvas/canvas-bar";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { nodeBounds } from "@/lib/canvas/canvas-node-geometry";
import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

const SELECTION_PAD = 14;

export function CanvasSelectionToolbar({
    nodes,
    viewport,
    showToolbar,
    canGroup,
    canUngroup,
    canSyncPlay,
    canJoinClips,
    onGroup,
    onUngroup,
    onSyncPlay,
    onJoinClips,
}: {
    nodes: CanvasNodeData[];
    viewport: ViewportTransform;
    showToolbar: boolean;
    canGroup: boolean;
    canUngroup: boolean;
    canSyncPlay: boolean;
    /** Whether the selection is two or more finished clips, which is the only thing a join takes. */
    canJoinClips: boolean;
    onGroup: () => void;
    onUngroup: () => void;
    onSyncPlay: () => void;
    onJoinClips: () => void;
}) {
    const { t } = useTranslation();
    const theme = useCanvasTheme();
    if (nodes.length < 2) return null;

    const bounds = nodeBounds(nodes);
    const left = viewport.x + bounds.left * viewport.k - SELECTION_PAD;
    const top = viewport.y + bounds.top * viewport.k - SELECTION_PAD;
    const width = (bounds.right - bounds.left) * viewport.k + SELECTION_PAD * 2;
    const height = (bounds.bottom - bounds.top) * viewport.k + SELECTION_PAD * 2;
    const showActions = showToolbar && (canGroup || canUngroup || canSyncPlay || canJoinClips);

    return (
        <>
            {/* The lasso and the group/sync bar belong to the nodes they box in, so they sit under the chrome
                with them (#192) — above the canvas, below the bars, the dock and the side panel. */}
            <svg className="pointer-events-none absolute z-[40] overflow-visible" style={{ left, top, width, height }}>
                <rect
                    x={1}
                    y={1}
                    width={Math.max(width - 2, 0)}
                    height={Math.max(height - 2, 0)}
                    rx={16}
                    ry={16}
                    fill={theme.canvas.selectionFill}
                    stroke={theme.canvas.selectionStroke}
                    strokeOpacity={0.55}
                    strokeWidth={1.5}
                    strokeDasharray="7 5"
                    strokeLinecap="round"
                />
            </svg>
            {showActions ? (
                <CanvasBar left={left + width / 2} top={top - 8}>
                    {canSyncPlay ? <CanvasBarButton title={t("canvas.nodeToolbar.syncPlayTitle")} label={t("canvas.nodeToolbar.syncPlay")} icon={<Play className="size-4" />} onClick={onSyncPlay} /> : null}
                    {canJoinClips ? <CanvasBarButton title={t("canvas.nodeToolbar.joinClipsTitle")} label={t("canvas.nodeToolbar.joinClips")} icon={<Merge className="size-4" />} onClick={onJoinClips} /> : null}
                    {canGroup ? <CanvasBarButton title={t("canvas.nodeToolbar.groupTitle")} label={t("canvas.nodeToolbar.group")} icon={<Group className="size-4" />} onClick={onGroup} /> : null}
                    {canUngroup ? <CanvasBarButton title={t("canvas.nodeToolbar.ungroupTitle")} label={t("canvas.nodeToolbar.ungroup")} icon={<Ungroup className="size-4" />} onClick={onUngroup} /> : null}
                </CanvasBar>
            ) : null}
        </>
    );
}
