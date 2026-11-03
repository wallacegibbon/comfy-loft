/**
 * Microphone in, samples out.
 *
 * `MediaRecorder` would be the short path, and it is the wrong one: it produces webm/opus or mp4, and the
 * speech server refuses anything that is not real WAV. So the stream is read through the Web Audio graph
 * instead — a `MediaStreamSource` into a `ScriptProcessorNode` — which hands back the raw samples the
 * encoder needs and nothing else.
 *
 * `ScriptProcessorNode` is deprecated and still the right tool here: it needs no second module to load, it
 * starts synchronously in the same gesture that got the permission, and the work is copying a few hundred
 * numbers every 4096 samples. An `AudioWorklet` would move that work off the main thread for a gesture that
 * is, by definition, a few seconds long.
 *
 * **What is not handled here.** A browser refuses the microphone outright on a page that is not a secure
 * context (`http://192.168.x.x` on the LAN), so that failure is the caller's to show; and the very first
 * gesture of a session waits on the permission prompt, which is why the panel treats a gesture that ended
 * before the stream arrived as nothing at all rather than as a recording.
 */

import { mergeSamples } from "@/lib/wav";

/** One recording in progress. */
export type PcmRecording = {
    /** End the recording and hand back everything captured, as one array. */
    stop: () => { samples: Float32Array; sampleRate: number };
};

/**
 * Start recording. The promise resolves when the microphone is open, so a caller can await it inside the
 * gesture that asked for it.
 */
export async function startPcmRecording(): Promise<PcmRecording> {

    // Asked for by name because a speech model reads 16 kHz mono: every browser that honours it resamples
    // the microphone into the graph for free, and one that does not still arrives at the right rate in the
    // header (see `wavBytes`).
    const context = new AudioContext({ sampleRate: 16_000 });
    let stream: MediaStream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
        void context.close();
        throw error;
    }
    // The context can come up suspended even inside a gesture, and a suspended node delivers no samples.
    if (context.state === "suspended") await context.resume();

    const chunks: Float32Array[] = [];
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
        // The graph is mono, but a browser is free to hand over both channels; the first is what a
        // microphone's mono mixdown would keep and saves an averaging pass over every frame.
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    // A `ScriptProcessorNode` only runs while it is connected to a destination.
    processor.connect(context.destination);

    let stopped = false;
    return {
        stop: () => {
            const sampleRate = context.sampleRate;
            if (stopped) return { samples: new Float32Array(0), sampleRate };
            stopped = true;
            processor.onaudioprocess = null;
            source.disconnect();
            processor.disconnect();
            for (const track of stream.getTracks()) track.stop();
            void context.close();
            return { samples: mergeSamples(chunks), sampleRate };
        },
    };
}
