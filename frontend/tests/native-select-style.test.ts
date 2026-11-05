import { expect, test } from "vitest";

import { canvasThemes, nativeOptionStyle, nativeSelectStyle } from "../src/lib/canvas-theme";

/**
 * A native `<select>`'s popup is the browser's, and it is painted from the colour scheme the element declares.
 *
 * Without that, a select whose text colour came from the dark palette opened a light list of light text — the
 * upscaler's model names were unreadable, and no stylesheet could reach that list.
 */
test("the popup follows the palette the card was drawn in", () => {
    expect(nativeSelectStyle(canvasThemes.dark).colorScheme).toBe("dark");
    expect(nativeSelectStyle(canvasThemes.light).colorScheme).toBe("light");
});

test("a select's text is the card's text, not the OS's", () => {
    expect(nativeSelectStyle(canvasThemes.dark).color).toBe(canvasThemes.dark.node.text);
    expect(nativeOptionStyle(canvasThemes.dark).color).toBe(canvasThemes.dark.node.text);
    // An option that inherited the popup's own colour would be light-on-light again.
    expect(nativeOptionStyle(canvasThemes.dark).background).toBe(canvasThemes.dark.node.panel);
    expect(nativeOptionStyle(canvasThemes.light).background).toBe(canvasThemes.light.node.panel);
});
