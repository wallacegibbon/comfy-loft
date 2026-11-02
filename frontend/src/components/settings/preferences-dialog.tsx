import { ArrowLeft, ArrowRight, ChevronDown, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { Switch } from "@/components/kit/choice";
import { Dialog } from "@/components/kit/dialog";
import { Field } from "@/components/kit/field";
import { Input } from "@/components/kit/input";
import { Select } from "@/components/kit/select";
import { toast } from "@/components/kit/toast";
import { WorkflowModelPicker } from "@/components/model-picker";
import { imageAspectOptions } from "@/components/image-settings-panel";
import { videoResolutionOptions } from "@/components/video-settings-panel";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaScaleOptions, parseVideoResolution } from "@/lib/media-size";
import { progressRingSkins } from "@/lib/canvas/progress-ring-skins";
import { cardSkinIds, getCanvasTheme, type CardSkinId } from "@/lib/canvas-theme";
import { stone } from "@/lib/design-tokens";
import { isCardSkinLocked, verifySkinPassword } from "@/lib/canvas/skin-unlocks";
import { persistSkinUnlock } from "@/services/api/skin-unlocks";
import { useConfigStore, type ModelCapability } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

/**
 * The media kinds with a default model to pick.
 *
 * Only these two: text runs on the agent and has no model of its own (`hydrateConfig` clears `textModel`),
 * and the audio model is chosen per node in the prompt panel, so a default here would be a setting nothing
 * reads.
 */
const modelGroups: Array<{ capability: ModelCapability; modelKey: "imageModel" | "videoModel"; labelKey: string }> = [
    { capability: "image", modelKey: "imageModel", labelKey: "config.preferences.defaultImageModel" },
    { capability: "video", modelKey: "videoModel", labelKey: "config.preferences.defaultVideoModel" },
];

/**
 * The preferences window: default models, generation defaults, and the canvas's look.
 *
 * There is nothing to apply. Every control writes into `use-config-store`, which mirrors the document to
 * the gateway as it changes (#155, #166), so closing the window loses nothing and a "Done" button would
 * only be claiming to do what already happened.
 *
 * The gateway itself is not here. The channel is the gateway that served the page — its address comes from
 * the page and its models from `GET /api/workflows` (#71) — so the "Gateway" tab that let you rename it and
 * re-tag a model's media kind was a form over values nothing else could change.
 */
export function PreferencesDialog() {
    const { t } = useTranslation();
    const open = useConfigStore((state) => state.preferencesOpen);
    const setOpen = useConfigStore((state) => state.setPreferencesOpen);
    const [passwordSkinId, setPasswordSkinId] = useState<CardSkinId | null>(null);
    const [skinPassword, setSkinPassword] = useState("");
    const [skinPasswordError, setSkinPasswordError] = useState("");
    const [verifyingSkinPassword, setVerifyingSkinPassword] = useState(false);
    const [fishOptionsOpen, setFishOptionsOpen] = useState(false);
    const config = useConfigStore((state) => state.config);
    const appTheme = useThemeStore((state) => state.theme);
    const cardSkin = useThemeStore((state) => state.cardSkin) || "warm";
    const unlockedCardSkins = useThemeStore((state) => state.unlockedCardSkins);
    const setCardSkin = useThemeStore((state) => state.setCardSkin);
    const unlockCardSkin = useThemeStore((state) => state.unlockCardSkin);
    const fishWhipEnabled = useThemeStore((state) => state.fishWhipEnabled);
    const setFishWhipEnabled = useThemeStore((state) => state.setFishWhipEnabled);
    const fishWhipSide = useThemeStore((state) => state.fishWhipSide);
    const setFishWhipSide = useThemeStore((state) => state.setFishWhipSide);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const imageResolutionOptions = mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? t("settingsPanels.common.auto") : value.toUpperCase() }));

    const selectCardSkin = (skinId: CardSkinId) => {
        if (isCardSkinLocked(skinId) && !unlockedCardSkins.includes(skinId)) {
            setFishOptionsOpen(true);
            setPasswordSkinId(skinId);
            setSkinPassword("");
            setSkinPasswordError("");
            return;
        }
        if (skinId === "fish" || skinId === "angel") {
            setFishOptionsOpen(cardSkin === skinId ? !fishOptionsOpen : true);
        } else {
            setFishOptionsOpen(false);
        }
        setCardSkin(skinId);
    };

    const closeSkinPasswordModal = () => {
        if (verifyingSkinPassword) return;
        setPasswordSkinId(null);
        setSkinPassword("");
        setSkinPasswordError("");
    };

    const unlockSelectedSkin = async () => {
        if (!passwordSkinId || verifyingSkinPassword) return;
        setVerifyingSkinPassword(true);
        setSkinPasswordError("");
        try {
            const valid = await verifySkinPassword(passwordSkinId, skinPassword);
            if (!valid) {
                setSkinPasswordError(t("config.preferences.cardSkinPasswordWrong"));
                return;
            }
            unlockCardSkin(passwordSkinId);
            if (passwordSkinId === "fish") setFishOptionsOpen(true);
            void persistSkinUnlock(passwordSkinId).catch(() => undefined);
            toast.success(t("config.preferences.cardSkinUnlocked", { name: t(`config.preferences.cardSkins.${passwordSkinId}.label`) }));
            setPasswordSkinId(null);
            setSkinPassword("");
        } catch {
            setSkinPasswordError(t("config.preferences.cardSkinPasswordUnavailable"));
        } finally {
            setVerifyingSkinPassword(false);
        }
    };

    useEffect(() => {
        if ((cardSkin === "fish" && unlockedCardSkins.includes("fish")) || cardSkin === "angel") setFishOptionsOpen(true);
    }, [cardSkin, unlockedCardSkins]);

    return (
        <>
            <Dialog
                open={open}
                onClose={() => setOpen(false)}
                size="panel"
                title={
                    <div>
                        <div className="text-lg font-semibold">{t("config.preferences.title")}</div>
                        <div className="mt-1 text-xs font-normal text-stone-500">{t("config.preferences.description")}</div>
                    </div>
                }
                bodyStyle={{ maxHeight: "72vh" }}
                bodyClassName="pr-3"
            >
                <div className="border-b border-stone-200 pb-3 text-xs text-stone-500 dark:border-stone-800">{t("config.settingsNote")}</div>
                <div className="mb-2 mt-4 text-sm font-semibold">{t("config.preferences.defaultModels")}</div>
                <div className="mb-4 grid gap-4 md:grid-cols-2">
                    {modelGroups.map((group) => (
                        <Field key={group.modelKey} label={t(group.labelKey)} className="mb-0">
                            <WorkflowModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth />
                        </Field>
                    ))}
                </div>
                <div className="mb-2 text-sm font-semibold">{t("config.preferences.generation")}</div>
                <div className="grid gap-4 md:grid-cols-4">
                    <Field label={t("config.preferences.imageResolution")} className="mb-4">
                        <Select value={inferMediaScale(config.size)} options={imageResolutionOptions} onChange={(scale) => updateConfig("size", computeMediaSize(scale, inferMediaRatio(config.size)))} />
                    </Field>
                    <Field label={t("config.preferences.imageAspectRatio")} className="mb-4">
                        <Select value={inferMediaRatio(config.size)} options={imageAspectOptions} onChange={(ratio) => updateConfig("size", computeMediaSize(inferMediaScale(config.size), ratio))} />
                    </Field>
                    <Field label={t("config.preferences.videoResolution")} className="mb-4">
                        <Select value={parseVideoResolution(config.vquality)} options={videoResolutionOptions} onChange={(value) => updateConfig("vquality", value)} />
                    </Field>
                </div>
                <Field label={t("config.preferences.cardSkin")} extra={t("config.preferences.cardSkinDescription")} className="mb-4">
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {cardSkinIds.map((id) => {
                            const locked = isCardSkinLocked(id) && !unlockedCardSkins.includes(id);
                            const selected = cardSkin === id && !locked;
                            const palette = getCanvasTheme(appTheme, id).node;
                            return (
                                <button
                                    key={id}
                                    type="button"
                                    title={locked ? t("config.preferences.cardSkinLockedHint") : undefined}
                                    onClick={() => selectCardSkin(id)}
                                    className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${selected ? "border-stone-900 bg-stone-100 dark:border-stone-100 dark:bg-white/10" : "border-stone-200 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-white/5"}`}
                                >
                                    <span className="relative grid h-10 w-16 shrink-0 place-items-center overflow-hidden rounded-md border" style={{ background: palette.fill, borderColor: palette.stroke }}>
                                        {id === "fish" ? (
                                            <img src="/skins/lantern-guard-idle.png" alt="" draggable={false} className="size-10 object-contain" />
                                        ) : id === "angel" ? (
                                            <img src="/skins/angel-girl-idle.webp" alt="" draggable={false} className="size-10 object-contain" />
                                        ) : (
                                            <span className="space-y-1">
                                                <span className="block h-1 w-8 rounded-full" style={{ background: palette.text, opacity: 0.85 }} />
                                                <span className="block h-1 w-5 rounded-full" style={{ background: palette.muted, opacity: 0.65 }} />
                                            </span>
                                        )}
                                        {locked ? (
                                            <span className="absolute inset-0 grid place-items-center bg-stone-950/45 text-white">
                                                <Lock className="size-4" />
                                            </span>
                                        ) : null}
                                    </span>
                                    <span className="min-w-0">
                                        <span className="flex items-center gap-1.5 text-sm font-medium">
                                            <span className="truncate">{t(`config.preferences.cardSkins.${id}.label`)}</span>
                                            {locked ? <span className="shrink-0 rounded-full border border-current px-1.5 py-0.5 text-[9px] font-medium opacity-70">{t("config.preferences.cardSkinLocked")}</span> : null}
                                            {(id === "fish" || id === "angel") && !locked ? <ChevronDown className={`ml-auto size-3.5 shrink-0 opacity-45 transition-transform ${selected && fishOptionsOpen ? "rotate-180" : ""}`} /> : null}
                                        </span>
                                        <span className="mt-0.5 block truncate text-[11px] opacity-60">{locked ? t("config.preferences.cardSkinLockedHint") : t(`config.preferences.cardSkins.${id}.description`)}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    {((cardSkin === "fish" && unlockedCardSkins.includes("fish")) || cardSkin === "angel") && fishOptionsOpen ? (
                        <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50/80 px-3 py-3 dark:border-stone-800 dark:bg-white/5">
                            <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium">{t("config.preferences.fishWhip")}</div>
                                    <div className="mt-1 text-[11px] leading-5 opacity-60">{t("config.preferences.fishWhipDescription")}</div>
                                </div>
                                <Switch checked={fishWhipEnabled} onChange={setFishWhipEnabled} />
                            </div>
                            <div className="mt-3 flex items-center justify-between gap-3 border-t border-stone-200/70 pt-3 dark:border-stone-800/70">
                                <div className="text-xs opacity-60">{t("config.preferences.fishWhipSide")}</div>
                                <Button size="small" icon={fishWhipSide === "right" ? <ArrowLeft className="size-3.5" /> : <ArrowRight className="size-3.5" />} onClick={() => setFishWhipSide(fishWhipSide === "right" ? "left" : "right")}>
                                    {fishWhipSide === "right" ? t("config.preferences.fishWhipMoveLeft") : t("config.preferences.fishWhipMoveRight")}
                                </Button>
                            </div>
                        </div>
                    ) : null}
                </Field>
                <Field label={t("config.preferences.progressRingSkin")} extra={t("config.preferences.progressRingSkinDescription")} className="mb-4">
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {progressRingSkins.map((skin) => {
                            const selected = (config.progressRingSkin || "cyan") === skin.id;
                            const palette = appTheme === "dark" ? skin.dark : skin.light;
                            return (
                                <button
                                    key={skin.id}
                                    type="button"
                                    onClick={() => updateConfig("progressRingSkin", skin.id)}
                                    className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${selected ? "border-stone-900 bg-stone-100 dark:border-stone-100 dark:bg-white/10" : "border-stone-200 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-white/5"}`}
                                >
                                    <span className="relative grid h-7 w-14 shrink-0 place-items-center overflow-hidden rounded-md" style={{ background: appTheme === "dark" ? stone[900] : stone[100] }}>
                                        {skin.mode === "tide" ? (
                                            <span
                                                className="absolute inset-x-0 bottom-0 h-[62%]"
                                                style={{ background: `linear-gradient(to top, ${palette.glow}66, ${palette.core}2e)`, borderTop: `1px solid ${palette.glow}`, boxShadow: `0 -3px 8px ${palette.glow}66` }}
                                            />
                                        ) : (
                                            <span
                                                className="absolute inset-x-1.5 top-1/2 h-[2px] -translate-y-1/2 rounded-full"
                                                style={{ background: `linear-gradient(90deg, ${palette.gradient[0]}, ${palette.gradient[2]})`, boxShadow: `0 0 8px ${palette.glow}` }}
                                            />
                                        )}
                                    </span>
                                    <span className="min-w-0">
                                        <span className="block text-sm font-medium">{t(`config.preferences.progressRingSkins.${skin.id}.label`)}</span>
                                        <span className="mt-0.5 block truncate text-[11px] opacity-60">{t(`config.preferences.progressRingSkins.${skin.id}.description`)}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </Field>
                <Field className="mb-4">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-sm">{t("config.preferences.autoFocusOnSelect")}</span>
                        <Switch checked={config.autoFocusOnSelect} onChange={(checked) => updateConfig("autoFocusOnSelect", checked)} />
                    </div>
                </Field>
                <Field label={t("config.preferences.systemPrompt")} className="mb-0">
                    <Input.TextArea rows={4} value={config.systemPrompt} placeholder={t("config.preferences.systemPromptPlaceholder")} onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                </Field>
            </Dialog>
            <Dialog
                open={Boolean(passwordSkinId)}
                size="form"
                maskClosable={false}
                title={passwordSkinId ? t("config.preferences.cardSkinUnlockTitle", { name: t(`config.preferences.cardSkins.${passwordSkinId}.label`) }) : ""}
                onClose={closeSkinPasswordModal}
                footer={
                    <>
                        <Button disabled={verifyingSkinPassword} onClick={closeSkinPasswordModal}>
                            {t("common.cancel")}
                        </Button>
                        <Button type="primary" loading={verifyingSkinPassword} disabled={!skinPassword.trim()} onClick={() => void unlockSelectedSkin()}>
                            {t("config.preferences.cardSkinUnlockAction")}
                        </Button>
                    </>
                }
            >
                <p className="mb-3 text-sm text-stone-500">{t("config.preferences.cardSkinUnlockHint")}</p>
                <Input.Password
                    autoFocus
                    value={skinPassword}
                    status={skinPasswordError ? "error" : undefined}
                    placeholder={t("config.preferences.cardSkinPasswordPlaceholder")}
                    onChange={(event) => {
                        setSkinPassword(event.target.value);
                        if (skinPasswordError) setSkinPasswordError("");
                    }}
                    onPressEnter={() => {
                        if (skinPassword.trim() && !verifyingSkinPassword) void unlockSelectedSkin();
                    }}
                />
                {skinPasswordError ? <p className="mt-2 text-xs text-red-500">{skinPasswordError}</p> : null}
            </Dialog>
        </>
    );
}
