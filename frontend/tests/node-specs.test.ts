import { describe, expect, test } from "vitest";

import { getNodeSpec, NODE_DEFAULT_SIZE, NODE_SPECS } from "@/constant/canvas";
import { CanvasNodeType } from "@/types/canvas";

/**
 * One table for a node's first size, and one lookup over it.
 *
 * The two lookups that used to exist disagreed the moment one was edited: `getNodeSpec` read this table, and
 * the registry's read the registered definitions — built from this same table — so the second could only ever
 * repeat the first, and the sizes were written down twice (`NODE_DEFAULT_SIZE` beside `NODE_SPECS`). These
 * tests are what makes "derived" safe: every type has a card, the two views of the table agree by construction,
 * and a type this build does not have still answers with a card that can be clicked.
 */
describe("the node spec table", () => {
    test("gives every type this build has a card and a starting metadata", () => {
        for (const type of Object.values(CanvasNodeType)) {
            const spec = getNodeSpec(type);
            expect(spec.width).toBeGreaterThan(0);
            expect(spec.height).toBeGreaterThan(0);
            expect(spec.metadata).toBeDefined();
        }
    });

    test("states each size once: the sizes are the specs' own", () => {
        for (const type of Object.values(CanvasNodeType)) {
            expect(NODE_DEFAULT_SIZE[type]).toEqual({ width: NODE_SPECS[type].width, height: NODE_SPECS[type].height });
        }
    });

    test("a text card starts with a font size, because that is the one thing it draws with", () => {
        expect(getNodeSpec(CanvasNodeType.Text).metadata?.fontSize).toBeGreaterThan(0);
    });

    test("a type this build does not have still gets a card: an old document may hold one", () => {
        const spec = getNodeSpec("some-node-from-another-build");
        expect(spec.width).toBeGreaterThan(0);
        expect(spec.height).toBeGreaterThan(0);
        expect(spec.metadata?.content).toBeUndefined();
    });
});
