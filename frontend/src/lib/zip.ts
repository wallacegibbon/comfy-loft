import { zipSync } from "fflate";

type ZipFile = {
    name: string;
    data: BlobPart;
};

/**
 * Build a zip from named entries.
 *
 * Only building: unpacking an archive is the gateway's job now (decisions #172), which is what lets the
 * import be one request and keeps a decompression bomb out of the browser tab.
 */
export async function createZip(files: ZipFile[]) {
    const entries = await Promise.all(
        files.map(async (file) => {
            const data = new Uint8Array(await new Blob([file.data]).arrayBuffer());
            return [file.name, data] as const;
        }),
    );
    return new Blob([zipSync(Object.fromEntries(entries), { level: 0 })], { type: "application/zip" });
}
