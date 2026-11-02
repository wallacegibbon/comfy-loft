import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasExportFile = {
    app: "comfy-loft";
    version: 3;
    exportedAt: string;
    projects: CanvasProjectExportItem[];
};

type CanvasProjectExportItem = {
    project: CanvasProject;
    files: CanvasExportProjectFile[];
};

export type CanvasExportProjectFile = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};
