import type { AiConfig } from "@/stores/use-config-store";
import { outputUrl, type Run, type RunOutput } from "@/services/api/runs";
import { readAudioMeta, readVideoMeta, type UploadedFile } from "@/services/file-storage";
import { readImageSize, type UploadedImage } from "@/services/image-storage";

/**
 * A finished run's files, as node references.
 *
 * The run already wrote every artifact into the canvas the run belongs to (`files/task_<id>.png`), and the
 * document names files exactly that way — so a node references the file where it is. Nothing is downloaded
 * and nothing is uploaded: doing that (which this replaced) stored a second copy under an `up-` name and cost
 * a full round trip per artifact (#173). What has to be discovered is only the media's own shape — a
 * picture's size, a clip's duration — and a browser reads that from the URL the run reports.
 *
 * The user's own files still go through `uploadCanvasFile`: those bytes are new, they have no name yet, and
 * picking one is the gateway's job.
 */

/** One output of a run, as the document names it. */
type GeneratedFile = {
    /** `files/<name>` — the reference a node stores. */
    key: string;
    /** Where the browser can read or show it now. */
    url: string;
    filename: string;
    mime: string;
    bytes: number;
};

/** One output of a finished run. Throws when the run has none, which is a failure the caller must report. */
function generatedFile(config: AiConfig, run: Run, index = 0): GeneratedFile {
    const output = run.outputs?.[index];
    if (!output) throw new Error(`run ${run.id} has no output ${index}`);
    return generatedFileOf(config, output);
}

function generatedFileOf(config: AiConfig, output: RunOutput): GeneratedFile {
    return {
        key: `files/${output.filename}`,
        url: outputUrl(config, output),
        filename: output.filename,
        mime: output.mime || "application/octet-stream",
        bytes: output.bytes || 0,
    };
}

/** A generated picture, ready to become a node's content. */
async function imageOf(file: GeneratedFile, options: { signal?: AbortSignal }): Promise<UploadedImage> {
    const size = await readImageSize(file.url, options);
    return {
        url: file.url,
        storageKey: file.key,
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        bytes: file.bytes,
        mimeType: file.mime,
    };
}

/** The picture a run made, ready to become a node's content. One run, one picture (#180). */
export async function generatedImage(config: AiConfig, run: Run, options: { signal?: AbortSignal } = {}): Promise<UploadedImage> {
    return imageOf(generatedFile(config, run), options);
}

/** A generated clip, with the duration the node shows. */
export async function generatedVideo(config: AiConfig, run: Run, index = 0): Promise<UploadedFile> {
    const file = generatedFile(config, run, index);
    const meta = await readVideoMeta(file.url);
    return { url: file.url, storageKey: file.key, bytes: file.bytes, mimeType: file.mime, ...meta };
}

/** A generated sound, with the duration the node shows. */
export async function generatedAudio(config: AiConfig, run: Run, index = 0): Promise<UploadedFile> {
    const file = generatedFile(config, run, index);
    const meta = await readAudioMeta(file.url);
    return { url: file.url, storageKey: file.key, bytes: file.bytes, mimeType: file.mime, ...meta };
}
