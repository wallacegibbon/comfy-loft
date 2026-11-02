import { ArchiveRestore, Download, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { toast } from "@/components/kit/toast";
import { discardLegacyAssetLibrary, exportLegacyAssetLibrary, loadLegacyAssetLibrary, type LegacyAssetLibrary } from "@/lib/canvas/legacy-asset-store";

/**
 * Something the removal in #144 left behind, said out loud once.
 *
 * The asset library is gone from the code, but its records are still in IndexedDB and some of the
 * files they name exist nowhere else. The sweep will collect those files the first time it runs, so
 * this banner is the only moment at which they can still be taken out. Two actions and no third:
 * export, or say you do not want it — dismissing without exporting discards the records too, which
 * is the point of it being a decision rather than a notice.
 *
 * Not a toast, for the reason `StorageRecoveryBanner` is not: it has to survive until it is answered.
 * That banner is about data that could not be read; this one is about data nothing reads any more.
 */
export function LegacyAssetsBanner() {
    const { t } = useTranslation();
    const [library, setLibrary] = useState<LegacyAssetLibrary | null>(null);
    const [working, setWorking] = useState(false);

    useEffect(() => {
        let live = true;
        void loadLegacyAssetLibrary().then((found) => {
            if (!live) return;
            // An envelope with nothing in it is the common case — every machine that opened the app
            // once has one. There is nothing to ask, so it goes without a word.
            if (found?.empty) {
                void discardLegacyAssetLibrary();
                return;
            }
            setLibrary(found);
        });
        return () => {
            live = false;
        };
    }, []);

    if (!library) return null;

    const count = library.assets.length;

    const exportAndKeep = async () => {
        setWorking(true);
        try {
            const files = await exportLegacyAssetLibrary(library);
            toast.success(t("canvas.legacyAssets.exported", { count: files }));
        } catch (error) {
            console.error(error);
            toast.error(t("canvas.legacyAssets.exportFailed"));
        } finally {
            setWorking(false);
        }
    };

    const discard = async () => {
        setWorking(true);
        try {
            await discardLegacyAssetLibrary();
            toast.success(t("canvas.legacyAssets.discarded"));
            setLibrary(null);
        } finally {
            setWorking(false);
        }
    };

    return (
        <div className="pointer-events-auto flex w-full max-w-2xl items-start gap-3 rounded-xl border border-sky-300 bg-white/97 p-4 shadow-xl backdrop-blur dark:border-sky-900/70 dark:bg-stone-900/97">
            <ArchiveRestore className="mt-0.5 size-5 shrink-0 text-sky-600 dark:text-sky-500" />
            <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{t("canvas.legacyAssets.title")}</div>
                <p className="mt-1 text-xs leading-relaxed text-stone-600 dark:text-stone-300">{t("canvas.legacyAssets.description", { count })}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button type="primary" icon={<Download className="size-4" />} disabled={working} onClick={() => void exportAndKeep()}>
                        {t("canvas.legacyAssets.export")}
                    </Button>
                    <button type="button" className="ml-1 flex items-center gap-1 text-xs text-stone-500 underline underline-offset-2 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200" disabled={working} onClick={() => void discard()}>
                        <X className="size-3.5" />
                        {t("canvas.legacyAssets.discard")}
                    </button>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-stone-500 dark:text-stone-400">{t("canvas.legacyAssets.hint")}</p>
            </div>
        </div>
    );
}
