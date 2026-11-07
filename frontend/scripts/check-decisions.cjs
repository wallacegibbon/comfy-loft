#!/usr/bin/env node
// A citation must answer to something: every `#N` a comment, a test or a doc points at has an entry in
// `docs/decisions.md`. None of the other gates can see this one.
//
// Why it is needed: `docs/decisions.md` says an entry whose subject is gone leaves with it — the file is a
// record of rules that are true now, not a graveyard. That rule is right, and it leaves a hole behind every
// time it is applied: three files cited `#312` for a decision #312's own commit never wrote down, and two
// comments cited `#188` and `#190` for entries the same rule had deleted. A reader follows the number and finds
// nothing, which is worse than the sentence carrying no number at all: it reads like the rule was recorded
// somewhere and they have simply not found it yet.
//
// What counts: a `#N` written in **prose** — a comment in a source file, or a line of Markdown, this record
// included: an entry that cites an entry the record no longer has is the same broken pointer. A `#` in code
// is not a citation, and that is also what keeps hex colours out of the check: this tree writes them in strings
// (`style={{ background: "#242529" }}`), never in a comment.
//
// Usage: npm run check:decisions   (exits non-zero, naming the file and the number)

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const RECORD = path.join(ROOT, "docs", "decisions.md");

/** Every `## N.` heading in the record. */
function entries() {
    const known = new Set();
    for (const match of fs.readFileSync(RECORD, "utf8").matchAll(/^## (\d+)\./gm)) known.add(Number(match[1]));
    return known;
}

/** Every file a citation can live in: the canvas, its tests, the server, and the docs that are not the record. */
function sources() {
    const out = [];
    const skip = new Set(["node_modules", "dist", ".git", "canvases", "data", "bin"]);
    const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!skip.has(entry.name)) walk(full);
            } else if (/\.(tsx?|go|md)$/.test(entry.name)) {
                out.push(full);
            }
        }
    };
    ["frontend/src", "frontend/tests", "internal", "cmd", "docs"].forEach((dir) => walk(path.join(ROOT, dir)));
    return out;
}

/** Where the prose on this line starts, or -1 when the line holds no prose. Markdown is prose all through. */
function proseStart(line, isMarkdown) {
    if (isMarkdown) return 0;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return 0;
    const slash = line.indexOf("//");
    return slash;
}

const CITATION = /#(\d{1,3})(?![\d\w])/g;

function main() {
    const known = entries();
    const problems = [];
    for (const file of sources()) {
        const isMarkdown = file.endsWith(".md");
        fs.readFileSync(file, "utf8")
            .split("\n")
            .forEach((line, index) => {
                const start = proseStart(line, isMarkdown);
                if (start < 0) return;
                const prose = line.slice(start);
                for (const match of prose.matchAll(CITATION)) {
                    const number = Number(match[1]);
                    if (known.has(number)) continue;
                    problems.push({ file: path.relative(ROOT, file), line: index + 1, number });
                }
            });
    }
    if (!problems.length) {
        console.log(`decisions check passed: ${known.size} entries, every #N cited in prose answers to one`);
        return;
    }
    console.error("cited decisions with no entry:");
    for (const problem of problems) console.error(`    #${problem.number}  ${problem.file}:${problem.line}`);
    console.error(`failed: ${problems.length} dangling citation(s). Write the entry, or drop the number from the sentence.`);
    process.exit(1);
}

main();
