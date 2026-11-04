/**
 * What a tool call is about, in the few words that name it.
 *
 * "调用 read_file" says what kind of thing happened and nothing about which file, so a transcript of ten
 * reads reads as ten identical lines. The argument that identifies the subject is the one thing worth
 * showing — a path, a command, a pattern — and it is read out of the call's own JSON rather than out of
 * the tool's name, so a call whose arguments have not arrived yet simply has no subject.
 *
 * A file read is also about *where* in the file, so `read_file` carries the line range too. That half is
 * drawn apart from the subject (`range`), because it is short and the path is not: the panel lets the path
 * give way with an ellipsis and keeps "start=1, count=40" whole.
 *
 * The table covers AlayaCore's built-in tools, whose arguments are known here by name. A tool that is not
 * in it — the canvas's own, whose arguments are ids and whose line already sits in the panel that drew the
 * canvas — has no subject, and the line stays as it was.
 */

/** One narrowing argument, drawn as `label=value` — AlayaCore's own words for it in its terminal. */
type Narrowing = { field: string; label: string };

/** Per tool, the argument that names the call's subject, and the numbers that narrow it. */
const SUBJECTS: Record<string, { field: string; range?: Narrowing[] }> = {
    read_file: {
        field: "path",
        range: [
            { field: "start_line", label: "start" },
            { field: "num_lines", label: "count" },
        ],
    },
    edit_file: { field: "path" },
    write_file: { field: "path" },
    execute_command: { field: "command" },
    search_content: { field: "pattern" },
};

const NOTHING = { subject: "", range: "" };

/**
 * What a call is about, or two empty strings when there is nothing to add: a tool with no known argument, a
 * call whose arguments have not arrived, arguments that are not JSON yet, or a field that is missing, empty
 * or not a string.
 *
 * A command can hold line breaks and a directory of them; they are folded into single spaces, because this
 * is one line of a transcript and a line break in it would push the rest of the transcript down.
 */
export function toolSubjectOf(name: string, input: string | undefined): { subject: string; range: string } {
    const spec = SUBJECTS[name];
    if (!spec || !input) return NOTHING;
    let parsed: unknown;
    try {
        parsed = JSON.parse(input);
    } catch {
        return NOTHING;
    }
    if (!parsed || typeof parsed !== "object") return NOTHING;
    const args = parsed as Record<string, unknown>;
    const value = args[spec.field];
    if (typeof value !== "string") return NOTHING;
    const subject = value.replace(/\s+/g, " ").trim();
    if (!subject) return NOTHING;
    // A narrowing the call did not make is not drawn: `start_line: 0` is AlayaCore's "from the top", not a
    // place in the file, so a read of the first 40 lines says `count=40` and nothing about a start.
    const range = (spec.range ?? [])
        .flatMap(({ field, label }) => {
            const number = args[field];
            return typeof number === "number" && number > 0 ? [`${label}=${number}`] : [];
        })
        .join(", ");
    return { subject, range };
}
