/**
 * A WAV file, written by hand.
 *
 * The speech server this build talks to accepts **only** real WAV: a `MediaRecorder` recording is
 * webm/opus (Chrome) or mp4 (Safari) and both are refused by name, and renaming the file does not help
 * because the bytes are what gets sniffed. So the samples are captured raw and the 44-byte header is
 * written here — 16-bit PCM, one channel, at the rate the browser's audio graph actually ran at.
 *
 * **No resampling on this side.** The server was measured transcribing 24, 44.1 and 48 kHz files with the
 * reported duration intact, so it resamples correctly by itself; writing the true rate into the header is
 * both less code and less to be wrong about. (The graph asks for 16 kHz first, which every current browser
 * honours — a smaller upload for free when it does.)
 */

/** Size of the canonical PCM header: RIFF + fmt + data, before any samples. */
export const WAV_HEADER_BYTES = 44;

/**
 * Encode mono float samples as a 16-bit PCM WAV.
 *
 * Samples outside [-1, 1] are clamped rather than wrapped: a wrapped peak is a loud click, and a clipped
 * one is what every other recorder in the world produces.
 */
export function wavBytes(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
    const dataBytes = samples.length * 2;
    const file = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
    const view = new DataView(file.buffer);
    const rate = Math.round(sampleRate);

    writeTag(file, 0, "RIFF");
    view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
    writeTag(file, 8, "WAVE");
    writeTag(file, 12, "fmt ");
    view.setUint32(16, 16, true); // the fmt chunk is the canonical 16 bytes
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // one channel
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true); // bytes per second
    view.setUint16(32, 2, true); // bytes per frame
    view.setUint16(34, 16, true); // bits per sample
    writeTag(file, 36, "data");
    view.setUint32(40, dataBytes, true);

    for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        view.setInt16(WAV_HEADER_BYTES + index * 2, Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff)), true);
    }
    return file;
}

/**
 * Join the chunks a recording arrived in.
 *
 * One `AudioProcessingEvent` is one array and the recorder keeps them as they come, so the file is only
 * ever built once, when the gesture ends.
 */
export function mergeSamples(chunks: Float32Array[]): Float32Array {
    if (chunks.length === 1) return chunks[0];
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return merged;
}

function writeTag(target: Uint8Array, offset: number, tag: string) {
    for (let index = 0; index < tag.length; index += 1) target[offset + index] = tag.charCodeAt(index);
}
