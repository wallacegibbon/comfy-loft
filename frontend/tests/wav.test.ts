import { describe, expect, it } from "vitest";

import { mergeSamples, WAV_HEADER_BYTES, wavBytes } from "@/lib/wav";

/**
 * The WAV encoder.
 *
 * It exists because the speech server refuses anything that is not real WAV, so the header is the contract:
 * what is asserted here is what that server reads — the tags, the sizes, the rate it will resample from, and
 * samples that are 16-bit little-endian rather than wrapped.
 */
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const tag = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.slice(at, at + 4));

describe("wavBytes", () => {
    it("writes the canonical 44-byte PCM header", () => {
        const file = wavBytes(new Float32Array(0), 16_000);
        expect(file.length).toBe(WAV_HEADER_BYTES);
        const head = view(file);
        expect(tag(file, 0)).toBe("RIFF");
        expect(tag(file, 8)).toBe("WAVE");
        expect(tag(file, 12)).toBe("fmt ");
        expect(tag(file, 36)).toBe("data");
        expect(head.getUint32(16, true)).toBe(16); // fmt chunk size
        expect(head.getUint16(20, true)).toBe(1); // PCM
        expect(head.getUint16(22, true)).toBe(1); // mono
        expect(head.getUint32(24, true)).toBe(16_000);
        expect(head.getUint32(28, true)).toBe(32_000); // bytes per second
        expect(head.getUint16(32, true)).toBe(2); // bytes per frame
        expect(head.getUint16(34, true)).toBe(16); // bits per sample
    });

    it("counts the sample bytes in the chunk sizes", () => {
        const file = wavBytes(new Float32Array(1000), 16_000);
        const head = view(file);
        expect(file.length).toBe(WAV_HEADER_BYTES + 2000);
        expect(head.getUint32(40, true)).toBe(2000);
        expect(head.getUint32(4, true)).toBe(file.length - 8);
    });

    it("writes samples as 16-bit little-endian", () => {
        const file = wavBytes(new Float32Array([0, 1, -1]), 16_000);
        const samples = view(file);
        expect(samples.getInt16(WAV_HEADER_BYTES, true)).toBe(0);
        expect(samples.getInt16(WAV_HEADER_BYTES + 2, true)).toBe(0x7fff);
        expect(samples.getInt16(WAV_HEADER_BYTES + 4, true)).toBe(-0x8000);
    });

    // A wrapped peak is a loud click in the middle of otherwise quiet audio: clipping is what every other
    // recorder does and what a 16-bit file can hold.
    it("clamps instead of wrapping", () => {
        const file = wavBytes(new Float32Array([2, -2, 0.5]), 16_000);
        const samples = view(file);
        expect(samples.getInt16(WAV_HEADER_BYTES, true)).toBe(0x7fff);
        expect(samples.getInt16(WAV_HEADER_BYTES + 2, true)).toBe(-0x8000);
        expect(samples.getInt16(WAV_HEADER_BYTES + 4, true)).toBe(Math.round(0.5 * 0x7fff));
    });

    it("writes the rate it was given, so the server resamples from the truth", () => {
        const file = wavBytes(new Float32Array(4), 48_000);
        const head = view(file);
        expect(head.getUint32(24, true)).toBe(48_000);
        expect(head.getUint32(28, true)).toBe(96_000);
    });
});

describe("mergeSamples", () => {
    it("joins the chunks in the order they arrived", () => {
        const merged = mergeSamples([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])]);
        expect(Array.from(merged)).toEqual([1, 2, 3, 4, 5]);
    });

    it("returns the one chunk it was given as it is", () => {
        const only = new Float32Array([0.5]);
        expect(mergeSamples([only])).toBe(only);
    });

    it("has nothing to join when nothing arrived", () => {
        expect(mergeSamples([]).length).toBe(0);
    });
});
