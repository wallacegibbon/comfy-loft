import type { CanvasDocument } from "@/services/api/canvases";

export type CanvasExportFile = {
    app: "comfyloft";
    version: 3;
    exportedAt: string;
    projects: CanvasProjectExportItem[];
};

/**
 * One canvas in a zip: its document and the title the list shows.
 *
 * No id and no rev: an import creates a new canvas, and nothing inside a document names a canvas. The files
 * keep the names the document uses, so importing this needs no rewriting at all (decisions #171).
 */
type CanvasExportProject = CanvasDocument & { title: string };

type CanvasProjectExportItem = {
    project: CanvasExportProject;
    files: CanvasExportProjectFile[];
};

export type CanvasExportProjectFile = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};
