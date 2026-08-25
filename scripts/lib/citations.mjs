// Record-id resolution seam (board item c3705a15, step 1 — pure refactor,
// no behavior change): extracted from scripts/check-record-citations.mjs so
// scripts/knowledge-export.mjs can reuse the SAME resolver instead of
// re-deriving id-universe rules a second place would drift from.
//
// Builds the full id universe from a store-shaped object (SterlingStore or
// MountedStores both expose recordIdIndex/recordAliases/get with identical
// shapes) and returns the three primitives check-record-citations used
// inline: resolve(id), getById(id) for the full-body currency walk, and
// size (the id-universe count, aliases included, used in the ok-line).
//
// See check-record-citations.mjs's own header comment for the two
// load-bearing resolution rules this seam preserves: (1) resolve across
// MOUNTED stores, not just the project store; (2) resolve at ANY status —
// citing a superseded record is legitimate (a tombstone), only "resolves to
// nothing" fails.

/**
 * @param {{
 *   recordIdIndex(): {id:string,type:string,status:string}[],
 *   recordAliases?(): {historical_id:string}[],
 *   get(id:string): unknown,
 * }} store
 */
export function buildResolver(store) {
  const index = store.recordIdIndex();

  // Stable identity (S5, decision stable-identity-design-v2): the migration
  // collapses legacy chain members into record_aliases — every pre-migration
  // historical id must KEEP resolving (the design's no-false-positives promise),
  // so the dead-id index joins the resolution set as synthetic rows whose
  // status reads 'superseded' (they forward to a canonical live record).
  let aliasRows = [];
  try {
    aliasRows = store.recordAliases();
  } catch {
    aliasRows = []; // pre-v2 store: no alias table, nothing to join
  }
  for (const a of aliasRows) {
    index.push({ id: a.historical_id, type: 'alias', status: 'superseded' });
  }

  const fullIds = new Set(index.map((r) => r.id));
  const byId = new Map(index.map((r) => [r.id, r]));
  const byPrefix = new Map();
  for (const r of index) {
    const p = r.id.slice(0, 8);
    if (!byPrefix.has(p)) byPrefix.set(p, []);
    byPrefix.get(p).push(r);
  }

  /** undefined = nothing anywhere (the only failure), 'ambiguous' = prefix hits
   *  several records, otherwise the resolved {id,type,status} row — a FULL id.
   *  A FULL id must match a full id: a prefix collision must never let a
   *  wrong-record citation pass. The returned row's `.id` and `.status` are what
   *  a currency check (lintCitationCurrency) needs on top of plain existence. */
  function resolve(id) {
    if (id.length > 8) return fullIds.has(id) ? byId.get(id) : undefined;
    const hits = byPrefix.get(id);
    if (!hits || hits.length === 0) return undefined;
    return hits.length > 1 ? 'ambiguous' : hits[0];
  }

  // Full-body lookup for a currency walk ONLY — recordIdIndex (above) omits
  // superseded_by by design (it is the cheap id/type/status projection every
  // existence check needs; a currency walk needs the chain, so it pays for a
  // get() per hop instead of widening that index for every caller).
  const getById = (id) => store.get(id);

  return { resolve, getById, size: index.length };
}
