/**
 * What an exported canvas zip is.
 *
 * One canvas, one zip (decisions #172): `canvas.json` is the document exactly as the server stores it,
 * `manifest.json` describes the archive (and carries the title, which is not part of the document), and
 * `files/<name>` are the media under the names the document already uses. There is no id and no rev — an
 * import is a new canvas — and no URL anywhere, so the zip can be opened in another workspace.
 */
export type CanvasExportManifest = {
    app: "comfyloft";
    /** Archive format, not the app's version. 1 is "canvas.json + manifest.json + files/". */
    version: 1;
    title: string;
    exportedAt: string;
};
