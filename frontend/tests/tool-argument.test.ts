import { describe, expect, it } from "vitest";

import { toolSubjectOf } from "@/lib/canvas/tool-argument";

describe("what a tool call is about", () => {
    it("names the file a file tool touched", () => {
        expect(toolSubjectOf("read_file", '{"path":"frontend/src/main.tsx"}').subject).toBe("frontend/src/main.tsx");
        expect(toolSubjectOf("edit_file", '{"path":"a.go","old_string":"x","new_string":"y"}').subject).toBe("a.go");
        expect(toolSubjectOf("write_file", '{"path":"/tmp/a.txt","content":""}').subject).toBe("/tmp/a.txt");
    });

    it("names the command that was run and the pattern that was searched for", () => {
        expect(toolSubjectOf("execute_command", '{"command":"go test ./..."}').subject).toBe("go test ./...");
        expect(toolSubjectOf("search_content", '{"pattern":"toolSubjectOf","path":"src"}').subject).toBe("toolSubjectOf");
    });

    it("keeps a command on one line, whatever it was written with", () => {
        expect(toolSubjectOf("execute_command", '{"command":"go build ./...\\n  && go vet ./..."}').subject).toBe("go build ./... && go vet ./...");
    });

    it("says which part of the file a read asked for", () => {
        expect(toolSubjectOf("read_file", '{"path":"a.go","start_line":12,"num_lines":40}').range).toBe("start=12, count=40");
        // A start with no count is where it began and nothing about where it ended.
        expect(toolSubjectOf("read_file", '{"path":"a.go","start_line":12}').range).toBe("start=12");
        // Zero is AlayaCore's "from the top" and "to the end", not a place in the file.
        expect(toolSubjectOf("read_file", '{"path":"a.go","start_line":0,"num_lines":40}').range).toBe("count=40");
        expect(toolSubjectOf("read_file", '{"path":"a.go","start_line":0,"num_lines":0}').range).toBe("");
        expect(toolSubjectOf("read_file", '{"path":"a.go"}').range).toBe("");
    });

    it("has no range for a tool that takes none", () => {
        // Only a file read is about a place inside the file; a command is the whole command.
        expect(toolSubjectOf("execute_command", '{"command":"ls","start_line":12}').range).toBe("");
        expect(toolSubjectOf("search_content", '{"pattern":"x","num_lines":3}').range).toBe("");
    });

    it("has nothing to say about a tool whose arguments are not words", () => {
        // The canvas's own tools: a node id is not something a reader can follow, and the panel they belong
        // to already says which node it is.
        expect(toolSubjectOf("read_node", '{"nodeId":"3f2a1b"}')).toEqual({ subject: "", range: "" });
        expect(toolSubjectOf("generate", '{"nodeId":"3f2a1b"}')).toEqual({ subject: "", range: "" });
    });

    it("has nothing to say before the arguments arrive, or when they are not arguments", () => {
        // The two frames of a call: the name, then the JSON. Between them there is only a name.
        expect(toolSubjectOf("read_file", undefined).subject).toBe("");
        expect(toolSubjectOf("read_file", "").subject).toBe("");
        expect(toolSubjectOf("read_file", '{"path":"a.go"').subject).toBe("");
        expect(toolSubjectOf("read_file", "not json").subject).toBe("");
        expect(toolSubjectOf("read_file", "null").subject).toBe("");
        expect(toolSubjectOf("read_file", '"a.go"').subject).toBe("");
    });

    it("has nothing to say when the field is missing, empty, or not a string", () => {
        expect(toolSubjectOf("read_file", "{}").subject).toBe("");
        expect(toolSubjectOf("read_file", '{"path":""}').subject).toBe("");
        expect(toolSubjectOf("read_file", '{"path":42}').subject).toBe("");
        expect(toolSubjectOf("search_content", '{"pattern":"  "}').subject).toBe("");
    });

    it("draws no range without a subject to narrow", () => {
        // Numbers about a file it could not name are numbers about nothing.
        expect(toolSubjectOf("read_file", '{"start_line":12,"num_lines":40}')).toEqual({ subject: "", range: "" });
        expect(toolSubjectOf("read_file", '{"path":"","num_lines":40}')).toEqual({ subject: "", range: "" });
    });
});
