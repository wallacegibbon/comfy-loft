import i18n from "@/i18n";

// Workflow metadata comes from workflows/registry.json, which is written in English because it
// is data rather than UI copy (docs/decisions.md #8). Chinese for the workflows that ship with
// this repo therefore lives in the dictionary, keyed by the identifier the server already
// sends — a model id, a variant mode — and anything the dictionary does not know falls back to
// the English text, so a hand-written workflow still renders instead of showing a raw key.
//
// The lookup names the language instead of reading the active one: this helper exists to answer with the
// Chinese label, and it is only asked in the Chinese UI.
function chinese(key: string): string {
    if (i18n.resolvedLanguage !== "zh-CN") return "";
    const text = i18n.getFixedT("zh-CN")(key, { defaultValue: "" });
    return text === key ? "" : text;
}

export function serverModelLabel(id: string, fallback?: string) {
    return chinese(`server.models.${id}.label`) || fallback || id;
}

export function serverVariantLabel(mode: string, fallback?: string) {
    return chinese(`server.variants.${mode}`) || fallback || mode;
}

/**
 * A workflow's knob, named the same way a model id and a variant mode are.
 *
 * `parameters[].label` is the registry's English (`Multiplier`, `Horizontal angle`), and a knob declared by a
 * hand-written workflow has nothing else. So the dictionary answers for the ones that ship here, keyed by the
 * parameter's own `key` — the identifier the server already sends — and an unknown knob still renders the
 * registry's words instead of a raw key.
 */
export function serverParameterLabel(key: string, fallback?: string) {
    return chinese(`server.parameters.${key}`) || fallback || key;
}
