import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { uploadImage } from "@/services/image-storage";

/** An `<img>` that always loads, so a "the URL can be displayed" path would succeed if one existed. */
class LoadsEveryImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 1024;
    naturalHeight = 768;
    set src(_value: string) {
        queueMicrotask(() => this.onload?.());
    }
}

beforeEach(() => {
    // The module's timer host and its way of measuring a picture: the node environment has neither.
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    vi.stubGlobal("Image", LoadsEveryImage);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// A URL that could not be downloaded used to be kept as the reference itself — an absolute address in the
// document, which #152 forbids and which no caller ever produced. It fails instead, because a reference the
// canvas cannot serve is not one this build can draw again (decisions #179).
it("rejects a URL it cannot download instead of keeping the address", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(uploadImage("https://example.com/pic.png")).rejects.toThrow();
});
