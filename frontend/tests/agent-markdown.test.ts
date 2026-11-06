import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { AgentMarkdown } from "../src/components/canvas/agent-markdown";

/**
 * What a tag a model wrote actually becomes on the page.
 *
 * `markdown.test.ts` pins the tokens; this pins the drawing — that the tag reaches the reader as the thing it
 * meant, that none of it reaches the reader as markup, and that a node id inside it is still a citation, which
 * is the whole point of the monospace chip a model writes when it means "this node".
 */
const draw = (text: string, renderText: (value: string) => string = (value) => value) => renderToStaticMarkup(createElement(AgentMarkdown, { text, renderText }));

describe("a tag a model wrote", () => {
    test("is drawn as the thing it meant, and nothing of the tag survives", () => {
        const html = draw('已将图片 <span style="font-family: monospace;">@image-1</span> 移到 (500, -200)');
        expect(html).toContain("<code");
        expect(html).toContain("@image-1");
        expect(html).not.toContain("span");
        expect(html).not.toContain("font-family");
    });

    test("a node id inside it is still a citation: the chip is where the click lives", () => {
        const html = draw('<span style="font-family: monospace;">@image-1</span>', (value) => `<CITE:${value}>`);
        expect(html).toContain("&lt;CITE:@image-1&gt;");
    });

    test("a hostile tag is characters, which is what a reader has always been shown", () => {
        const html = draw("<img src=x onerror=alert(1)>");
        expect(html).not.toContain("<img");
        expect(html).toContain("&lt;img");
    });

    test("a break inside a line is a break", () => {
        expect(draw("a<br>b")).toContain("<br/>");
    });
});
