import { create } from "zustand";

import { mirrorToSettings, readSetting } from "@/stores/use-settings-store";

type ThemeName = "light" | "dark";

type ThemeStore = {
    theme: ThemeName;
    setTheme: (theme: ThemeName) => void;
};

/** What this store persists: the appearance, and nothing the canvas depends on. */
type StoredTheme = Pick<ThemeStore, "theme">;

const DEFAULT_THEME: StoredTheme = {
    theme: "dark",
};

/** A workspace that has never saved anything, or saved a shape an older build wrote. */
const storedTheme = readSetting<Partial<StoredTheme>>("theme", {});

export const useThemeStore = create<ThemeStore>()((set) => ({
    ...DEFAULT_THEME,
    ...storedTheme,
    theme: storedTheme.theme === "light" ? "light" : "dark",
    setTheme: (theme) => set({ theme }),
}));

// One subscription instead of a write in each setter: the store cannot drift from what is saved.
mirrorToSettings(useThemeStore, "theme", (state) => ({
    theme: state.theme,
}));
