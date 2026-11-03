import { useCallback, useEffect, useRef, useState } from "react";

import { isSpeakable } from "@/lib/canvas/agent-dictation";
import { startPcmRecording, type PcmRecording } from "@/lib/pcm-recorder";

/**
 * Hold a key, say a sentence, let go: the words come back.
 *
 * The gesture is the whole interface — `Ctrl`/`⌘` plus `'`, or a button held down with a pointer — and what
 * it produces is text handed to the caller, which puts it where the caret was. It deliberately does not know
 * where that is: this hook is about the sound, and the panel is about the draft.
 *
 * **The key.** `Ctrl + '` because a quote is what a person uses to quote speech, and because it collides with
 * nothing here: `Space` is the canvas's temporary tool, `Shift` and `Ctrl` on their own are selection and the
 * temporary tool, and the keys the canvas reads are all of the form "modifier + letter". A chord with a
 * printable in it also cannot be started by accident the way a held modifier can — and `Ctrl+'` types nothing
 * and is bound by no browser (`⌘+'` is Firefox's quick-find on macOS, which is why `Ctrl` is said first).
 *
 * **Repeat.** A modifier held down does not repeat; a printable key does, dozens of times a second, so the
 * repeats are dropped rather than treated as "press again".
 *
 * **The lost keyup.** Switching windows mid-sentence means the key comes up on a page that is not listening,
 * and a microphone that is never told to stop is the one failure worth code: the window losing focus ends the
 * recording. Nothing else here defends against a gesture that ended oddly — a press too short to be speech is
 * dropped silently rather than being reported as a broken microphone (#239).
 */

type DictationPhase = "idle" | "listening" | "transcribing";

type Options = {
    /** Send the recording and answer with what was said; "" when nothing was. */
    transcribe: (samples: Float32Array, sampleRate: number) => Promise<string>;
    /** What was said, once it is known and it is not empty. */
    onWords: (text: string) => void;
};

type HoldToTalk = {
    phase: DictationPhase;
    /** The sentence to show for the last attempt that failed, or "". */
    error: string;
    start: () => void;
    stop: () => void;
};

export function useHoldToTalk({ transcribe, onWords }: Options): HoldToTalk {
    const [phase, setPhase] = useState<DictationPhase>("idle");
    const [error, setError] = useState("");

    const recordingRef = useRef<PcmRecording | null>(null);
    /** A gesture is held down. It can outlive `start()`: the microphone is opened asynchronously. */
    const heldRef = useRef(false);
    /** A recording is on its way to the server, and a second gesture would race it. */
    const busyRef = useRef(false);

    // The callbacks are read through refs so the listeners can be attached once: `transcribe` closes over a
    // config object that is rebuilt on every render of the panel.
    const transcribeRef = useRef(transcribe);
    transcribeRef.current = transcribe;
    const onWordsRef = useRef(onWords);
    onWordsRef.current = onWords;

    const start = useCallback(() => {
        if (heldRef.current || busyRef.current) return;
        heldRef.current = true;
        setError("");
        setPhase("listening");
        void (async () => {
            let recording: PcmRecording;
            try {
                recording = await startPcmRecording();
            } catch (failure) {
                heldRef.current = false;
                setPhase("idle");
                setError(failure instanceof Error ? failure.message : String(failure));
                return;
            }
            // The gesture ended while the microphone was opening — the permission prompt, usually. There is
            // nothing recorded and nothing to say about it.
            if (!heldRef.current) {
                recording.stop();
                setPhase("idle");
                return;
            }
            recordingRef.current = recording;
        })();
    }, []);

    const stop = useCallback(() => {
        if (!heldRef.current) return;
        heldRef.current = false;
        const recording = recordingRef.current;
        recordingRef.current = null;
        // Still opening: the start path sees the released gesture and throws the stream away.
        if (!recording) return;
        const { samples, sampleRate } = recording.stop();
        if (!isSpeakable(samples.length, sampleRate)) {
            setPhase("idle");
            return;
        }
        busyRef.current = true;
        setPhase("transcribing");
        void (async () => {
            try {
                const text = await transcribeRef.current(samples, sampleRate);
                if (text) onWordsRef.current(text);
            } catch (failure) {
                setError(failure instanceof Error ? failure.message : String(failure));
            } finally {
                busyRef.current = false;
                setPhase("idle");
            }
        })();
    }, []);

    useEffect(() => {
        const isTalkKey = (event: KeyboardEvent) => (event.ctrlKey || event.metaKey) && (event.code === "Quote" || event.key === "'");
        const onKeyDown = (event: KeyboardEvent) => {
            if (!isTalkKey(event)) return;
            event.preventDefault();
            if (event.repeat) return;
            start();
        };
        // Either half of the chord ends it: the quote first is "I am done", the modifier first is "oops".
        const onKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Quote" || event.key === "'" || event.key === "Control" || event.key === "Meta") stop();
        };
        const onBlur = () => stop();
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("keyup", onKeyUp);
            window.removeEventListener("blur", onBlur);
        };
    }, [start, stop]);

    // Closed in the middle of a sentence: the microphone belongs to this gesture and does not outlive it.
    useEffect(
        () => () => {
            recordingRef.current?.stop();
        },
        [],
    );

    return { phase, error, start, stop };
}
