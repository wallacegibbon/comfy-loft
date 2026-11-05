import { useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { Dialog } from "@/components/kit/dialog";
import { Select } from "@/components/kit/select";
import { IMAGE_UPSCALE_WORKFLOW } from "@/lib/canvas/tool-workflows";
import { readImageMeta } from "@/lib/image-utils";
import { requestWorkflows, type ServerWorkflow } from "@/services/api/workflows";
import type { AiConfig } from "@/stores/use-config-store";

/** Which upscaler ran, and the one knob it was given. The node records both. */
export type CanvasUpscaleParams = { workflowId: string; params: Record<string, unknown> };

/** The single knob the upscaler declares. */
const MODEL_PARAMETER = "upscale_model";

/** Past this long edge the run is a memory question, not a quality one — said out loud rather than capped. */
const LARGE_OUTPUT_EDGE = 4096;

function prettyModel(value: string) {
    return value.replace(/\.(safetensors|pth|gguf)$/i, "").replace(/_/g, " ");
}

/**
 * One option, as the picker needs it: the file name, prettified — or the server's own wording when it sent a
 * pair. `#8` puts the words on the server, so a label it does carry wins over anything made here.
 */
function optionOf(option: string | { value: string; label: string }) {
    return typeof option === "string" ? { value: option, label: prettyModel(option) } : { value: option.value, label: option.label || prettyModel(option.value) };
}

function even(value: number) {
    return Math.max(2, Math.round(value / 2) * 2);
}

/** The factor a weight file upscales by: 2×/4× is the file, not a number the user sets. */
function modelScaleOf(value: string) {
    const lower = value.toLowerCase();
    const match = /(?:^|[^0-9])([234])\s*x/.exec(lower) || /x\s*([234])/.exec(lower);
    return match ? Number(match[1]) : 1;
}

/**
 * Upscale one picture: the ESRGAN workflow, one image, one weight file.
 *
 * There is no workflow picker and no scale control, because there is nothing to pick: the canvas has one
 * upscaler, and 2×/4× is decided by the file the model dropdown names. What is left is the only two facts
 * the run needs — which weight, and how big the result will be — plus the one sentence this dialog owes a
 * creation tool: enlarging does not add detail, a bigger canvas does.
 */
export function CanvasNodeUpscaleDialog({ dataUrl, open, config, onClose, onConfirm }: { dataUrl: string; open: boolean; config: AiConfig; onClose: () => void; onConfirm: (params: CanvasUpscaleParams) => void }) {
    const { t } = useTranslation();
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [workflows, setWorkflows] = useState<ServerWorkflow[]>([]);
    const [model, setModel] = useState("");
    const [error, setError] = useState("");

    const workflow = workflows.find((item) => item.id === IMAGE_UPSCALE_WORKFLOW) || null;
    const modelParameter = (workflow?.parameters || []).find((parameter) => parameter.key === MODEL_PARAMETER) || null;
    const options = (modelParameter?.options || []).map(optionOf);
    // Whether ComfyUI can run it is the server's answer; a missing weight or node pack is why the button is
    // disabled, and the server's own sentence is the reason shown.
    const available = workflow?.availability?.available === true;
    const problems = workflow?.availability?.problems || [];
    const output = useMemo(() => {
        if (!image) return null;
        const scale = modelScaleOf(model);
        return { width: even(image.width * scale), height: even(image.height * scale) };
    }, [image, model]);

    useEffect(() => {
        if (!open) return;
        setImage(null);
        setError("");
        setWorkflows([]);
        setModel("");
        void readImageMeta(dataUrl).then(setImage);
        let alive = true;
        requestWorkflows(config)
            .then((items) => {
                if (!alive) return;
                setWorkflows(items);
                const found = items.find((item) => item.id === IMAGE_UPSCALE_WORKFLOW);
                const declared = (found?.parameters || []).find((parameter) => parameter.key === MODEL_PARAMETER);
                const first = declared?.default ?? declared?.options?.[0];
                setModel(first ? optionOf(first as string).value : "");
            })
            .catch((reason) => {
                if (alive) setError(reason instanceof Error ? reason.message : String(reason));
            });
        return () => {
            alive = false;
        };
    }, [open, dataUrl, config]);

    const canRun = Boolean(available && image && model);
    const large = Boolean(output && Math.max(output.width, output.height) > LARGE_OUTPUT_EDGE);

    return (
        <Dialog label={t("canvas.upscale.title")} open={open && Boolean(dataUrl)} onClose={onClose} size="panel">
            <div className="space-y-5">
                <h2 className="text-xl font-semibold">{t("canvas.upscale.title")}</h2>
                <div className="grid gap-6 md:grid-cols-[minmax(260px,1fr)_360px]">
                    <div className="rounded-xl border p-4">
                        <div className="grid min-h-[280px] place-items-center rounded-lg bg-black/5">
                            <img src={dataUrl} alt="" className="max-h-[320px] max-w-full rounded-lg object-contain shadow-xl" draggable={false} />
                        </div>
                        <div className="mt-3 flex items-center justify-between text-sm">
                            <span className="opacity-60">{t("canvas.upscale.source")}</span>
                            <span className="font-semibold">{image ? `${image.width} x ${image.height} px` : t("canvas.editors.loading")}</span>
                        </div>
                    </div>
                    <div className="space-y-5 py-1">
                        {modelParameter ? (
                            <div className="space-y-2">
                                <div className="font-medium opacity-75">{t("canvas.upscale.model")}</div>
                                <Select className="w-full" value={model} options={options} onChange={(value) => setModel(value)} notFoundContent={t("canvas.upscale.noWorkflow")} />
                            </div>
                        ) : null}
                        {workflow && !available ? <div className="text-xs text-[#ef4444]">{problems[0]?.message || t("canvas.upscale.unavailable")}</div> : null}
                        {!workflow && !error ? <div className="text-xs text-[#ef4444]">{t("canvas.upscale.noWorkflow")}</div> : null}
                        <div className="rounded-xl border px-4 py-3 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="opacity-60">{t("canvas.upscale.output")}</span>
                                <span className="font-semibold">{output ? `${output.width} x ${output.height} px` : t("canvas.editors.unknown")}</span>
                            </div>
                            {large ? <div className="mt-1 text-xs opacity-55">{t("canvas.upscale.largeOutput", { edge: LARGE_OUTPUT_EDGE })}</div> : null}
                        </div>
                        {error ? <div className="text-xs text-[#ef4444]">{error}</div> : null}
                        <div className="space-y-1 text-xs leading-5 opacity-55">
                            <div>{t("canvas.upscale.note")}</div>
                            {/* A creation tool's honest sentence: this makes the picture bigger, not clearer. */}
                            <div>{t("canvas.upscale.hint")}</div>
                        </div>
                    </div>
                </div>
                <div className="flex justify-end">
                    <Button type="primary" size="large" icon={<Sparkles className="size-4" />} disabled={!canRun} onClick={() => canRun && onConfirm({ workflowId: IMAGE_UPSCALE_WORKFLOW, params: { [MODEL_PARAMETER]: model } })}>
                        {t("canvas.upscale.run")}
                    </Button>
                </div>
            </div>
        </Dialog>
    );
}
