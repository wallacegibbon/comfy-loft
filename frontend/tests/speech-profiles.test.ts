import { describe, expect, it } from "vitest";

import { emptySpeechDraft, speechDraftComplete, speechDraftOf, speechProfilesPayload } from "@/lib/speech-profiles";
import type { SpeechProfile } from "@/services/api/speech";

/**
 * The editor's side of the speech server list.
 *
 * The rules worth pinning down are the ones a list of servers with credentials makes easy to get wrong: an entry
 * the page did not touch carries no key (so the server keeps the one it has), a blank key field is not a request
 * to erase, and removing a key is its own answer. The rest is shape — the whole list travels, in the user's
 * order, because the list *is* the file on the server.
 */

const profile = (overrides: Partial<SpeechProfile> = {}): SpeechProfile => ({
    id: 1,
    name: "Local",
    url: "http://127.0.0.1:18080/v1/audio/transcriptions",
    model: "refine",
    hasKey: true,
    ...overrides,
});

describe("a speech profile draft", () => {
    it("starts from the address this build was measured against", () => {
        expect(emptySpeechDraft.url).toBe("http://127.0.0.1:18080/v1/audio/transcriptions");
        expect(emptySpeechDraft.model).toBe("refine");
        expect(speechDraftComplete(emptySpeechDraft)).toBe(true);
    });

    // The key is not the page's to know, so it starts empty and means "keep the stored one".
    it("never carries the stored key, and does not ask to remove it", () => {
        expect(speechDraftOf(profile())).toEqual({ name: "Local", url: profile().url, model: "refine", key: "", removeKey: false });
    });

    // An address is the one thing a request cannot do without; a name and a model may be blank, because a
    // server that names no model is a real shape (`whisper.cpp`'s `/inference`).
    it("is complete only with an http or https address", () => {
        const draft = (url: string) => ({ ...emptySpeechDraft, name: "", model: "", url });

        expect(speechDraftComplete(draft("https://api.openai.com/v1/audio/transcriptions"))).toBe(true);
        expect(speechDraftComplete(draft("  http://127.0.0.1:18080/v1/audio/transcriptions  "))).toBe(true);
        expect(speechDraftComplete(draft("ftp://127.0.0.1:18080/v1/audio/transcriptions"))).toBe(false);
        expect(speechDraftComplete(draft("127.0.0.1:18080/v1/audio/transcriptions"))).toBe(false);
        expect(speechDraftComplete(draft("   "))).toBe(false);
    });
});

describe("the list a change produces", () => {
    const state = { profiles: [profile(), profile({ id: 2, name: "Cloud", url: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1", hasKey: false })], active: 1 };

    // The unedited entries are described back exactly as they were shown: no key field at all, which is how the
    // server knows to keep what it holds.
    it("leaves every entry it did not touch without a key", () => {
        const payload = speechProfilesPayload(state, { kind: "activate", id: 2 });

        expect(payload.active).toBe(2);
        expect(payload.profiles).toEqual([
            { id: 1, name: "Local", url: profile().url, model: "refine" },
            { id: 2, name: "Cloud", url: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1" },
        ]);
        expect(payload.profiles.every((entry) => !("key" in entry))).toBe(true);
    });

    it("adds a profile with the key that was typed and nothing else", () => {
        const payload = speechProfilesPayload(state, { kind: "add", draft: { ...emptySpeechDraft, name: "  Home  ", key: "  sk-new  " } });

        expect(payload.profiles).toHaveLength(3);
        expect(payload.profiles[2]).toEqual({ name: "Home", url: "http://127.0.0.1:18080/v1/audio/transcriptions", model: "refine", key: "sk-new" });
        expect(payload.active).toBe(1);
    });

    it("edits one entry in place, keeping its id", () => {
        const payload = speechProfilesPayload(state, { kind: "edit", id: 2, draft: { name: "Renamed", url: "https://api.openai.com/v1/audio/transcriptions", model: "gpt-4o-transcribe", key: "", removeKey: false } });

        expect(payload.profiles[1]).toEqual({ id: 2, name: "Renamed", url: "https://api.openai.com/v1/audio/transcriptions", model: "gpt-4o-transcribe" });
        expect(payload.profiles[1]).not.toHaveProperty("key");
        expect(payload.profiles[0]).toEqual({ id: 1, name: "Local", url: profile().url, model: "refine" });
    });

    it("replaces a key only when there is one to give", () => {
        const typed = speechProfilesPayload(state, { kind: "edit", id: 1, draft: { ...speechDraftOf(profile()), key: " sk-typed " } });
        expect(typed.profiles[0].key).toBe("sk-typed");

        // A blank field is not a request to erase: it says nothing about the key the server holds.
        const blank = speechProfilesPayload(state, { kind: "edit", id: 1, draft: speechDraftOf(profile()) });
        expect(blank.profiles[0]).not.toHaveProperty("key");
    });

    // The one answer a blank field cannot also carry, so it is its own answer — and a blank one, which is how the
    // server spells "remove it".
    it("removes a stored key when that is what was asked", () => {
        const payload = speechProfilesPayload(state, { kind: "edit", id: 1, draft: { ...speechDraftOf(profile()), removeKey: true } });

        expect(payload.profiles[0].key).toBe("");
    });

    it("deletes an entry by leaving it out", () => {
        const payload = speechProfilesPayload(state, { kind: "delete", id: 1 });

        expect(payload.profiles.map((entry) => entry.id)).toEqual([2]);
    });
});
