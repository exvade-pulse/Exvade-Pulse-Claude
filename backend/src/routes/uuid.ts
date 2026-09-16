// Route params arrive as arbitrary strings (a stale link, a typo, a poked-at
// URL) -- Postgres throws (not a clean empty result) on a non-UUID literal
// against a uuid column, which would otherwise surface as a 500 instead of
// the 404 a bad id should produce.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
