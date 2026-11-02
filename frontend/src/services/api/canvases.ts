import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { normalizeConnections } from "@/lib/canvas/canvas-document";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { ApiError, KEEPALIVE_BYTES, httpJson, httpVoid } from "@/services/api/http";
import type { CanvasAgentWindow, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

/**
 * The canvas documents, as the gateway keeps them.
 *
 * A canvas is two halves on the wire and one object here. The server owns the summary — id, title,
 * timestamps and `rev` — and never looks inside `document`, which is the canvas's own shape
 * (`docs/decisions.md` #152). Keeping them apart in the types is what stops a caller from believing
 * that editing a node changes anything on the server before a save says so.
 */

const BASE = `${LOCAL_GATEWAY_BASE_URL}/api/canvases`;

export type CanvasSummary = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    /** The version a save must name to be accepted. */
    rev: string;
    bytes: number;
};

/** Everything a canvas holds that is the canvas's business rather than the gateway's. */
export type CanvasDocument = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    /** The agent panel's window: open or not, and the place and size the user left it at. */
    agent: CanvasAgentWindow;
};

type CanvasRecord = {
    summary: CanvasSummary;
    document: CanvasDocument;
};

/** A save that named a version older than the one on disk. `current` is what is there now. */
export class CanvasConflictError extends Error {
    constructor(readonly current: CanvasSummary) {
        super("the canvas changed since it was read");
        this.name = "CanvasConflictError";
    }
}

/** A save for a canvas that is no longer there: deleted here, in another tab, or by hand. */
export class CanvasMissingError extends Error {
    constructor() {
        super("this canvas no longer exists");
        this.name = "CanvasMissingError";
    }
}

/** The agent window as a new canvas starts: closed, in the default corner, at its default size. */
const DEFAULT_AGENT_WINDOW: CanvasAgentWindow = { open: false, position: null, size: null };

/** The document as a new canvas starts: no nodes, a blank view, the default background. */
export function emptyCanvasDocument(): CanvasDocument {
    return { nodes: [], connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, agent: { ...DEFAULT_AGENT_WINDOW } };
}

/**
 * The agent window a document describes, or the default when it does not describe one.
 *
 * A document written before the window was part of the canvas has no `agent` field at all, and one
 * written by hand can hold a position that is not a pair of numbers. Both open the panel where it
 * would have opened anyway rather than putting a `NaN` into its style.
 */
function readAgentWindow(raw: unknown): CanvasAgentWindow {
    const source = (raw || {}) as Partial<CanvasAgentWindow>;
    const position = source.position;
    const size = source.size;
    return {
        open: source.open === true,
        position: position && Number.isFinite(position.x) && Number.isFinite(position.y) ? { x: position.x, y: position.y } : null,
        size: size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : null,
    };
}

/** Fill in whatever a document is missing, so a canvas written by an older build still opens. */
function readDocument(raw: unknown): CanvasDocument {
    const source = (raw || {}) as Partial<CanvasDocument>;
    const empty = emptyCanvasDocument();
    return {
        nodes: Array.isArray(source.nodes) ? source.nodes : empty.nodes,
        // Repaired on the way in: an older document can hold two connections with one id, and the id is what
        // selecting, highlighting and deleting go by (see `normalizeConnections`).
        connections: normalizeConnections(source.connections),
        backgroundMode: source.backgroundMode || empty.backgroundMode,
        showImageInfo: Boolean(source.showImageInfo),
        viewport: source.viewport && typeof source.viewport.k === "number" ? source.viewport : empty.viewport,
        agent: readAgentWindow(source.agent),
    };
}

/** The embedded summary in a `{canvas}` payload, with the document split back out. */
function readRecord(payload: { canvas?: unknown }): CanvasRecord {
    const canvas = (payload.canvas || {}) as CanvasSummary & { document?: unknown };
    const { document, ...summary } = canvas;
    return { summary: summary as CanvasSummary, document: readDocument(document) };
}

/** Every canvas, newest first. */
export async function requestCanvases(): Promise<CanvasSummary[]> {
    const payload = await httpJson<{ canvases?: CanvasSummary[] }>(BASE, { timeout: 8000 });
    return Array.isArray(payload?.canvases) ? payload.canvases : [];
}

/** One canvas with its document, or null when there is no canvas with that id. */
export async function requestCanvas(id: string): Promise<CanvasRecord | null> {
    try {
        return readRecord(await httpJson<{ canvas?: unknown }>(`${BASE}/${id}`, { timeout: 8000 }));
    } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
    }
}

/** Create a canvas. The document travels with it, so there is no window where it exists but is empty. */
export async function requestCanvasCreate(title: string, document: CanvasDocument): Promise<CanvasRecord> {
    const payload = await httpJson<{ canvas?: unknown }>(BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, document }),
        timeout: 8000,
    });
    return readRecord(payload);
}

/**
 * Restore an exported canvas from its archive.
 *
 * The body is the zip itself: the gateway unpacks `canvas.json`, `manifest.json` and `files/<name>` into a new
 * canvas directory and keeps the names the document uses, so the client has nothing to rename or repair
 * (decisions #172). It answers with the canvas it created, exactly like a create.
 */
export async function requestCanvasImport(archive: Blob, signal?: AbortSignal): Promise<CanvasRecord> {
    const payload = await httpJson<{ canvas?: unknown }>(`${BASE}/import`, {
        method: "POST",
        headers: { "Content-Type": archive.type || "application/zip" },
        body: archive,
        signal,
        timeout: 10 * 60_000,
    });
    return readRecord(payload);
}

/**
 * Save the document.
 *
 * `rev` is the version this save was made against, sent as `If-Match`. A gateway that has moved on
 * answers 409 with the current summary, which becomes a `CanvasConflictError` rather than a plain
 * failure: the caller has to decide something different for it than it would for a network error.
 */
export async function requestCanvasSave(id: string, rev: string, document: CanvasDocument, title?: string, options: { keepalive?: boolean } = {}): Promise<CanvasSummary> {
    const body = JSON.stringify(title === undefined ? { document } : { document, title });
    try {
        const payload = await httpJson<{ summary?: CanvasSummary }>(`${BASE}/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...(rev ? { "If-Match": `"${rev}"` } : {}) },
            body,
            // A document too big for the browser to keep is sent normally: a refused keepalive saves nothing.
            keepalive: options.keepalive === true && body.length <= KEEPALIVE_BYTES,
            timeout: 8000,
        });
        if (!payload?.summary?.rev) throw new ApiError(502, payload);
        return payload.summary;
    } catch (error) {
        const current = conflictedSummary(error);
        if (current) throw new CanvasConflictError(current);
        // 404 is not a temporary failure: the directory is gone, and a retry would 404 forever.
        if (error instanceof ApiError && error.status === 404) throw new CanvasMissingError();
        throw error;
    }
}

/** Delete a canvas and everything under it. A canvas that is already gone is not an error. */
export async function requestCanvasDelete(id: string): Promise<void> {
    try {
        await httpVoid(`${BASE}/${id}`, { method: "DELETE", timeout: 8000 });
    } catch (error) {
        if (error instanceof ApiError && error.status === 404) return;
        throw error;
    }
}

/** The current summary out of a 409, if that is what this is. */
function conflictedSummary(error: unknown): CanvasSummary | null {
    if (!(error instanceof ApiError) || error.status !== 409) return null;
    const body = error.data as { error?: { details?: { current?: CanvasSummary } } };
    const current = body?.error?.details?.current;
    return current?.rev ? current : null;
}
