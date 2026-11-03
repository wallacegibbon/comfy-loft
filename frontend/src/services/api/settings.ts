import { LOCAL_SERVER_BASE_URL } from "@/constant/app-mode";
import { KEEPALIVE_BYTES, httpJson } from "@/services/api/http";

/**
 * The workspace preferences, as the server keeps them (#155).
 *
 * The document is opaque on both sides: the server stores the bytes without reading a key, and this
 * module passes them through without knowing what is in them. The shape lives in
 * `stores/use-settings-store.ts`, one level up, where the keys are actually named.
 */

const URL = `${LOCAL_SERVER_BASE_URL}/api/settings`;

export type SettingsBlob = Record<string, unknown>;

export async function requestSettings(): Promise<SettingsBlob> {
    const payload = await httpJson<{ settings?: SettingsBlob }>(URL, { timeout: 8000 });
    return payload?.settings && typeof payload.settings === "object" ? payload.settings : {};
}

export async function requestSettingsSave(settings: SettingsBlob, options: { keepalive?: boolean } = {}): Promise<SettingsBlob> {
    const body = JSON.stringify({ settings });
    const payload = await httpJson<{ settings?: SettingsBlob }>(URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
        // Only a body the browser will actually keep; see KEEPALIVE_BYTES.
        keepalive: options.keepalive === true && body.length <= KEEPALIVE_BYTES,
        timeout: 8000,
    });
    return payload?.settings && typeof payload.settings === "object" ? payload.settings : settings;
}
