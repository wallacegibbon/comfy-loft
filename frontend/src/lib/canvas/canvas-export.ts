import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { documentOf } from "@/lib/canvas/canvas-document";
import { createZip } from "@/lib/zip";
import { activeFileUrl, canvasFileUrl, fileNameOf } from "@/services/canvas-files";
import type { CanvasExportManifest } from "@/types/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * Export one canvas as a zip.
 *
 * The archive is the canvas directory, without its id: `canvas.json` (the document), `manifest.json` (the
 * format and the title) and `files/<name>`. Importing it is that directory unpacked into a new canvas, so
 * nothing in here has to be renamed or rewritten later (decisions #172).
 */
export async function exportCanvas(project: CanvasProject, fileName = i18n.t("canvas.export.defaultProjectName")) {
    const document = documentOf(project);
    const manifest: CanvasExportManifest = { app: "comfyloft", version: 1, title: project.title, exportedAt: new Date().toISOString() };
    const entries: { name: string; data: BlobPart }[] = [
        { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
        { name: "canvas.json", data: JSON.stringify(document, null, 2) },
    ];
    for (const storageKey of collectStorageKeys(document)) {
        const name = fileNameOf(storageKey);
        const url = canvasFileUrl(project.id, storageKey);
        if (!name || !url) continue;
        // The file already has a name on disk; the zip keeps it, which is what lets an import put the same
        // name back and leave the document's references alone.
        const blob = await (await fetch(url)).blob().catch(() => null);
        if (!blob) continue;
        entries.push({ name: `files/${name}`, data: blob });
    }
    saveAs(await createZip(entries), `${safeFileName(fileName)}.zip`);
}

export async function exportCanvasNodes(nodes: CanvasNodeData[], fileName = i18n.t("canvas.export.defaultNodesName")) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const used = new Set<string>();
    const uniqueName = (base: string, ext: string) => {
        const safe = safeFileName(base) || i18n.t("canvas.export.item");
        let name = `${safe}.${ext}`;
        for (let i = 1; used.has(name); i += 1) name = `${safe}-${i}.${ext}`;
        used.add(name);
        return name;
    };

    await Promise.all(
        nodes.map(async (node) => {
            const title = node.title || node.type;
            const storageKey = node.metadata?.storageKey || "";
            if (storageKey) {
                const blob = await (await fetch(activeFileUrl(storageKey))).blob().catch(() => null);
                if (blob) return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            if (node.type === CanvasNodeType.Text) return void zipFiles.push({ name: uniqueName(title, "txt"), data: node.metadata?.content || node.metadata?.prompt || "" });
            const content = node.metadata?.content;
            if (content && content.startsWith("data:")) {
                const blob = await (await fetch(content)).blob();
                return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            zipFiles.push({ name: uniqueName(title, "json"), data: JSON.stringify(node, null, 2) });
        }),
    );

    const zip = await createZip(zipFiles);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    // A reference is `files/<name>` (#156). The `image:`/`video:` keys this used to look for died with the
    // browser store, so a document written by this build has no other form.
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("files/")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg")) return "ogg";
    return storageKey.startsWith("image:") ? "png" : "bin";
}
