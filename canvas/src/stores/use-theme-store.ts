import { create } from "zustand";

import type { CardSkinId } from "@/lib/canvas-theme";
import { isCardSkinLocked } from "@/lib/canvas/skin-unlocks";
import { mirrorToSettings, readSetting } from "@/stores/use-settings-store";

type ThemeName = "light" | "dark";
type FishWhipSide = "left" | "right";

type ThemeStore = {
    theme: ThemeName;
    cardSkin: CardSkinId;
    unlockedCardSkins: CardSkinId[];
    fishWhipEnabled: boolean;
    fishWhipSide: FishWhipSide;
    setTheme: (theme: ThemeName) => void;
    setCardSkin: (cardSkin: CardSkinId) => void;
    unlockCardSkin: (skinId: CardSkinId) => void;
    mergeUnlockedCardSkins: (skinIds: CardSkinId[]) => void;
    setFishWhipEnabled: (enabled: boolean) => void;
    setFishWhipSide: (side: FishWhipSide) => void;
};

/** What this store persists: the appearance, and nothing the canvas depends on. */
type StoredTheme = Pick<ThemeStore, "theme" | "cardSkin" | "unlockedCardSkins" | "fishWhipEnabled" | "fishWhipSide">;

const DEFAULT_THEME: StoredTheme = {
    theme: "dark",
    cardSkin: "warm",
    unlockedCardSkins: [],
    fishWhipEnabled: true,
    fishWhipSide: "right",
};

/** A workspace that has never saved anything, or saved a shape an older build wrote. */
const storedTheme = readSetting<Partial<StoredTheme>>("theme", {});

export const useThemeStore = create<ThemeStore>()((set) => ({
    ...DEFAULT_THEME,
    ...storedTheme,
    theme: storedTheme.theme === "light" ? "light" : "dark",
    setTheme: (theme) => set({ theme }),
    setCardSkin: (cardSkin) =>
        set((state) => {
            if (isCardSkinLocked(cardSkin) && !state.unlockedCardSkins.includes(cardSkin)) return state;
            return { cardSkin };
        }),
    unlockCardSkin: (skinId) =>
        set((state) => ({
            unlockedCardSkins: state.unlockedCardSkins.includes(skinId) ? state.unlockedCardSkins : [...state.unlockedCardSkins, skinId],
            cardSkin: skinId,
        })),
    mergeUnlockedCardSkins: (skinIds) =>
        set((state) => {
            const next = [...new Set([...state.unlockedCardSkins, ...skinIds])];
            return next.length === state.unlockedCardSkins.length ? state : { unlockedCardSkins: next };
        }),
    setFishWhipEnabled: (enabled) => set({ fishWhipEnabled: enabled }),
    setFishWhipSide: (side) => set({ fishWhipSide: side }),
}));

// One subscription instead of a write in each setter: the store cannot drift from what is saved.
mirrorToSettings(useThemeStore, "theme", (state) => ({
    theme: state.theme,
    cardSkin: state.cardSkin,
    unlockedCardSkins: state.unlockedCardSkins,
    fishWhipEnabled: state.fishWhipEnabled,
    fishWhipSide: state.fishWhipSide,
}));
