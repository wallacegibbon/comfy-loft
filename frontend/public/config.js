// Runtime configuration, copied from public/ into dist/ at build time.
// The gateway rewrites this file on every start and after every settings save — the address comes
// from .env and the preferences from data/settings.json (docs/decisions.md #155) — so edit .env
// rather than this file.
// Assign window.__RUNTIME_CONFIG__ here when a value has to be baked into the bundle.
// The only keys the frontend reads are LOCAL_GATEWAY_URL / LOCAL_GATEWAY_HOST /
// LOCAL_GATEWAY_PORT — see src/constant/runtime-config.ts.
window.__RUNTIME_CONFIG__ = window.__RUNTIME_CONFIG__ || {};
