// Runtime configuration, copied from public/ into dist/ at build time.
//
// When the gateway serves the canvas it answers `/config.js` itself, with the workspace preferences it
// holds (data/settings.json) — this file is then never read (docs/decisions.md #220). It is what a static
// host with no gateway in the request path serves instead: an empty document, which the canvas treats as
// "read the preferences over HTTP" and does not save over until it has.
//
// Assign window.__RUNTIME_CONFIG__ here when a value has to be baked into the bundle. The keys the frontend
// reads are LOCAL_GATEWAY_URL (the address, when the canvas is served from somewhere else),
// LOCAL_GATEWAY_HOST / LOCAL_GATEWAY_PORT (the older shape of the same thing) and SETTINGS — see
// src/constant/runtime-config.ts.
window.__RUNTIME_CONFIG__ = window.__RUNTIME_CONFIG__ || {};
