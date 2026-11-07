import { toast as sonnerToast } from "sonner";

/**
 * Application toast — the only way UI code should surface a transient message.
 *
 * The shape deliberately mirrors antd's `message.success/error/warning/info/loading`
 * so that swapping the implementation (antd → sonner → whatever comes next) never
 * touches a call site: this module owns the library choice, call sites own the copy.
 *
 * `loading()` is sticky and hands back its own dismiss handler, which is the antd
 * idiom it replaces (`const hide = message.loading(text, 0)` … `hide()`). Do not
 * "simplify" it into a fire-and-forget call — the export/import flows rely on the
 * toast surviving until the work finishes, however long that takes.
 *
 * The `<Toaster />` that renders these is mounted in
 * `components/layout/app-providers.tsx` alongside the other app-level providers.
 */
export const toast = {
    success: (text: string) => sonnerToast.success(text),
    error: (text: string) => sonnerToast.error(text),
    warning: (text: string) => sonnerToast.warning(text),
    info: (text: string) => sonnerToast.info(text),
    loading(text: string): () => void {
        const id = sonnerToast.loading(text, { duration: Infinity });
        return () => sonnerToast.dismiss(id);
    },
    /**
     * A message with one button on it — the way back out of a gesture that just destroyed something.
     *
     * The action is the point: a delete is the one thing on this canvas a person can see disappear and cannot
     * draw again, so the sentence that says it happened carries the undo with it instead of trusting anyone to
     * find the menu (#328). Long enough to read and act on, short enough not to sit over the canvas.
     */
    action(text: string, options: { label: string; onClick: () => void; duration?: number }) {
        sonnerToast(text, { action: { label: options.label, onClick: options.onClick }, duration: options.duration ?? 8000 });
    },
};
