// Saved rounds without a version predate the corrected army placement.
// Keep this metadata separate from the WASM loader so the page can import it.
export const LEGACY_RULES_VERSION = 1;
export const RULES_VERSION = 2;

// The deployed release: the content-addressed assets/<hash>/ directory build_site.py
// served this module from, or 'dev' when served straight from public/ (or node).
export const RELEASE = new URL(import.meta.url).pathname
  .match(/\/assets\/([0-9a-f]{16})\//)?.[1] ?? 'dev';
