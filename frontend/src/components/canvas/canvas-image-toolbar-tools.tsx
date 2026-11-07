import type { ReactNode } from "react";
import { Grid2x2, Maximize2, Rotate3d, Scissors, ZoomIn } from "lucide-react";

import type { CanvasNodeData } from "@/types/canvas";
import i18n from "@/i18n";

type ImageNodeActionToolId = "crop" | "split" | "upscale" | "angle" | "view";

type ImageToolHandlers = {
    onCrop: (node: CanvasNodeData) => void;
    onSplit: (node: CanvasNodeData) => void;
    onUpscale: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    onViewImage: (node: CanvasNodeData) => void;
};

type ImageToolDefinition = {
    id: ImageNodeActionToolId;
    /** Both are read when the bar is drawn, so the dictionary is asked at the moment the words are shown. */
    label: () => string;
    title: () => string;
    icon: () => ReactNode;
    run: (node: CanvasNodeData, handlers: ImageToolHandlers) => void;
};

// Everything here is a thing only a picture has (docs/decisions.md #332): crop, split, enlarge, re-shoot from
// another angle, look at it bigger. What every node has — info, download, delete — lives in the right-click menu.
// Mask editing is absent for its own reason (#330): it is the input one *mode* of one model needs, and the place
// that chooses the mode opens it.
const imageToolDefinitions: ImageToolDefinition[] = [
    {
        id: "crop",
        label: () => i18n.t("canvas.imageTools.crop"),
        title: () => i18n.t("canvas.imageTools.cropTitle"),
        icon: () => <Scissors className="size-4" />,
        run: (node, handlers) => handlers.onCrop(node),
    },
    {
        id: "split",
        label: () => i18n.t("canvas.imageTools.split"),
        title: () => i18n.t("canvas.imageTools.splitTitle"),
        icon: () => <Grid2x2 className="size-4" />,
        run: (node, handlers) => handlers.onSplit(node),
    },
    {
        id: "upscale",
        label: () => i18n.t("canvas.imageTools.upscale"),
        title: () => i18n.t("canvas.imageTools.upscaleTitle"),
        icon: () => <ZoomIn className="size-4" />,
        run: (node, handlers) => handlers.onUpscale(node),
    },
    {
        id: "angle",
        label: () => i18n.t("canvas.imageTools.angle"),
        title: () => i18n.t("canvas.imageTools.angleTitle"),
        // A camera says "take a picture", which is every other button here. The control behind this one is
        // the viewpoint — azimuth, pitch, distance — so the glyph is a rotation in space.
        icon: () => <Rotate3d className="size-4" />,
        run: (node, handlers) => handlers.onAngle(node),
    },
    {
        id: "view",
        label: () => i18n.t("canvas.imageTools.view"),
        title: () => i18n.t("canvas.imageTools.viewTitle"),
        icon: () => <Maximize2 className="size-4" />,
        run: (node, handlers) => handlers.onViewImage(node),
    },
];

export function buildImageToolbarTools(node: CanvasNodeData, handlers: ImageToolHandlers) {
    return imageToolDefinitions.map((tool) => ({
        id: tool.id,
        label: tool.label(),
        title: tool.title(),
        icon: tool.icon(),
        onClick: () => tool.run(node, handlers),
    }));
}
