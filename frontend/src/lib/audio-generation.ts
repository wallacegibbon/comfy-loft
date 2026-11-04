export const audioFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "opus", label: "Opus" },
    { value: "aac", label: "AAC" },
    { value: "flac", label: "FLAC" },
    { value: "pcm", label: "PCM" },
];

/** The whole-second lengths a music run may ask for, clamped into the range its workflow declares. */
export function clampAudioSeconds(value: string | number | undefined, duration: { min: number; max: number }) {
    const seconds = Math.round(Number(value));
    // Whole seconds, not the declared step (a music workflow's is 1/25 s, the latent's own grid): the number
    // is an upper bound the model may finish under, and a song length is not something anyone reads to a
    // hundredth. A value that is not a number at all becomes the shortest run rather than a surprise one.
    if (!Number.isFinite(seconds)) return duration.min;
    return Math.min(duration.max, Math.max(duration.min, seconds));
}

export function normalizeAudioFormatValue(value: string) {
    return audioFormatOptions.some((item) => item.value === value) ? value : "mp3";
}

export function audioFormatLabel(value: string) {
    const format = normalizeAudioFormatValue(value);
    return audioFormatOptions.find((item) => item.value === format)?.label || format;
}
