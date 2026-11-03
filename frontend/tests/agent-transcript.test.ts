import { describe, expect, it } from "vitest";

import { referenceBlock, referenceLine } from "@/lib/canvas/agent-references";
import { transcriptEvent, type ToolStep, type TranscriptMessage } from "@/lib/canvas/agent-transcript";
import type { AgentEvent } from "@/services/api/agent";

/**
 * The transcript is the arrival order, and nothing else decides it.
 *
 * These cover the shape that used to get this wrong: a tool call was a list hanging off the message and
 * was drawn above every sentence in it, so a call made between two sentences read as if it had come
 * before both. A message is a list of parts now, appended as the frames arrive (#221).
 */

/** One transcript, built by folding the frames through the reducer the panel uses. */
const fold = (...events: AgentEvent[]): TranscriptMessage[] => events.reduce<TranscriptMessage[]>((messages, event) => transcriptEvent(messages, event), []);

/** The parts of the one message there is, in the order they are drawn. */
const partsOf = (messages: TranscriptMessage[]): string[] => messages.flatMap((message) => message.parts.map((part) => (part.kind === "tool" ? `tool:${part.name}` : part.kind)));

const tool = (messages: TranscriptMessage[], callId: string): ToolStep => {
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.kind === "tool" && part.callId === callId) return part;
        }
    }
    throw new Error(`no step for ${callId}`);
};

describe("the agent transcript", () => {
    it("draws a tool call where it happened, not at the top of the message", () => {
        const messages = fold(
            { type: "delta", text: "Let me look at the canvas." },
            { type: "tool_call", callId: "c1", name: "canvas_list_nodes" },
            { type: "tool_result", callId: "c1", output: "38 nodes", isError: false },
            { type: "delta", text: "There are 38 nodes." },
        );

        expect(messages).toHaveLength(1);
        // The sentences are two parts, not one, because the call happened between them — and the call is
        // drawn between them.
        expect(partsOf(messages)).toEqual(["text", "tool:canvas_list_nodes", "text"]);
        const [before, , after] = messages[0].parts;
        expect(before.kind === "text" && before.text).toBe("Let me look at the canvas.");
        expect(after.kind === "text" && after.text).toBe("There are 38 nodes.");
    });

    it("keeps the order of several calls and the sentences between them", () => {
        const messages = fold(
            { type: "delta", text: "one" },
            { type: "tool_call", callId: "a", name: "first" },
            { type: "tool_result", callId: "a", output: "", isError: false },
            { type: "delta", text: "two" },
            { type: "tool_call", callId: "b", name: "second" },
            { type: "delta", text: "three" },
        );

        expect(partsOf(messages)).toEqual(["text", "tool:first", "text", "tool:second", "text"]);
    });

    it("gives a message an id, and the next message one that sorts after it", () => {
        const messages = fold({ type: "user", text: "what is on the canvas?" }, { type: "delta", text: "38 nodes." }, { type: "done" }, { type: "user", text: "and the connections?" });

        const ids = messages.map((message) => message.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect([...ids].sort()).toEqual(ids);
    });

    it("is one step for the two frames a call arrives in", () => {
        const messages = fold({ type: "tool_call", callId: "c1", name: "canvas_read_node" }, { type: "tool_call", callId: "c1", input: '{"nodeId":"n1"}' }, { type: "tool_result", callId: "c1", output: "a picture", isError: false });

        expect(partsOf(messages)).toEqual(["tool:canvas_read_node"]);
        expect(tool(messages, "c1")).toMatchObject({ name: "canvas_read_node", input: '{"nodeId":"n1"}', output: "a picture", state: "ok" });
    });

    it("says whether the call worked, from the result's own verdict", () => {
        const messages = fold({ type: "tool_call", callId: "ok", name: "read" }, { type: "tool_result", callId: "ok", isError: false }, { type: "tool_call", callId: "bad", name: "read" }, { type: "tool_result", callId: "bad", isError: true });

        expect(tool(messages, "ok").state).toBe("ok");
        expect(tool(messages, "bad").state).toBe("failed");
    });

    it("leaves a call the turn never answered as running, not as a failure", () => {
        const messages = fold({ type: "tool_call", callId: "c1", name: "read" }, { type: "delta", text: "stopped" }, { type: "done" });

        expect(tool(messages, "c1").state).toBe("running");
        expect(messages[0].streaming).toBe(false);
    });

    it("updates the result onto the call where it was made, however late it arrives", () => {
        const messages = fold({ type: "tool_call", callId: "c1", name: "read" }, { type: "delta", text: "after" }, { type: "tool_result", callId: "c1", output: "late", isError: false });

        expect(partsOf(messages)).toEqual(["tool:read", "text"]);
        expect(tool(messages, "c1")).toMatchObject({ output: "late", state: "ok" });
    });

    it("ignores a result for a call nobody made", () => {
        const messages = fold({ type: "delta", text: "hello" });
        expect(transcriptEvent(messages, { type: "tool_result", callId: "ghost", output: "x" })).toBe(messages);
    });

    it("keeps reasoning where it was thought, before the answer it led to", () => {
        const messages = fold({ type: "reasoning", text: "which one?" }, { type: "tool_call", callId: "c1", name: "read" }, { type: "delta", text: "this one" });

        expect(partsOf(messages)).toEqual(["reasoning", "tool:read", "text"]);
    });

    it("draws a system notice as a message of its own, where it arrived", () => {
        const messages = fold({ type: "delta", text: "Before." }, { type: "notice", text: "Summarizing conversation..." }, { type: "delta", text: "After." });

        expect(messages.map((message) => message.role)).toEqual(["assistant", "system", "assistant"]);
        expect(messages[1].parts).toEqual([{ kind: "text", text: "Summarizing conversation..." }]);
        // The answer a notice interrupted stops where it was: the words after it were said after it.
        expect(messages[0].streaming).toBe(false);
        expect(messages[2].streaming).toBe(true);
    });

    it("puts a message echoed mid-answer at the end, and the answer goes on below it", () => {
        // The echo is not this side's to schedule: it is drawn where it arrives. Text that comes after it
        // opens an answer below, rather than reaching back into the bubble above it.
        const messages = fold({ type: "delta", text: "Answering." }, { type: "user", text: "wait — use the blue one" }, { type: "delta", text: " Using blue." });

        expect(messages.map((message) => message.role)).toEqual(["assistant", "user", "assistant"]);
        const [first, , third] = messages;
        expect(first.parts).toEqual([{ kind: "text", text: "Answering." }]);
        expect(third.parts).toEqual([{ kind: "text", text: " Using blue." }]);
        expect(first.streaming).toBe(false);
        expect(third.streaming).toBe(true);
    });

    it("reads a user message the way it was typed, citations and all", () => {
        const block = referenceBlock("【画布引用】", [referenceLine("n1", "image", "补全背景", "一只猫")]);
        const messages = fold({ type: "user", text: `${block}@补全背景 再画一张` });

        expect(messages[0].parts).toEqual([{ kind: "text", text: "@补全背景 再画一张" }]);
        expect(messages[0].mentions).toEqual([{ id: "n1", label: "补全背景" }]);
    });

    it("replaces the transcript with the conversation the agent replayed", () => {
        const live = fold({ type: "delta", text: "a live answer" }, { type: "notice", text: "a live notice" });
        const replayed = transcriptEvent(live, {
            type: "history",
            history: [
                { type: "user", text: "hello" },
                { type: "reasoning", text: "what is this?" },
                { type: "tool_call", callId: "c1", name: "read" },
                { type: "tool_result", callId: "c1", output: "a file", isError: false },
                { type: "delta", text: "hi" },
            ],
        });

        // The replayed frames are the events a live turn sends, so the answer keeps its thinking and its
        // call — a reload shows what the first pass showed, not a stripped copy of it.
        expect(replayed.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(partsOf(replayed)).toEqual(["text", "reasoning", "tool:read", "text"]);
        expect(tool(replayed, "c1").state).toBe("ok");
        expect(replayed.every((message) => !message.streaming)).toBe(true);
    });

    it("opens nothing for a frame that says nothing", () => {
        expect(fold({ type: "delta", text: "" })).toEqual([]);
        expect(fold({ type: "done" })).toEqual([]);
    });
});
