// @sterling/store — read shares across the mounted stores (board 675daf9d part (b);
// decision projects-mount-domains-and-sibling-projects, READ SHARE ruling: "when
// other stores have matches, the project gets up to about 60% of the cap and the
// rest is split across mounted domains; a share a store does not use spills to
// the others; each store ranks its own results, and scores are never merged
// across databases (bm25 statistics differ per database)").
//
// Pure: it sees only how many matches each store has, never a score. The caller
// takes the first N of each store's own ranked list and concatenates them,
// project first, so no cross-database comparison happens anywhere.

/** The project's share of the cap when a domain also has matches. */
export const DEFAULT_PROJECT_SHARE = 0.6;

/**
 * How many results each source contributes to one capped read.
 *
 * `perSourceCounts[0]` is the project store, the rest are the mounted domains in
 * manifest order. Each count is how many matches that store has (a store queried
 * at `cap` reports at most `cap`, which is all this needs).
 *
 * Quotas: the project gets ceil(projectShare x cap); the remainder is split
 * evenly across the domains, the odd units going to the earlier domains. Each
 * source takes min(count, quota). Whatever is left of the cap then spills one
 * unit at a time, round-robin in source order (project first), to every source
 * that still has unreturned matches. So the result always sums to
 * min(cap, total matches), and when only the project matches it gets the whole
 * cap, exactly as the old project-first concatenation did.
 */
export function allocateShares(perSourceCounts: number[], cap: number, projectShare: number = DEFAULT_PROJECT_SHARE): number[] {
  if (!Array.isArray(perSourceCounts) || perSourceCounts.length === 0) {
    throw new Error('allocateShares: perSourceCounts must contain at least the project count (index 0)');
  }
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`allocateShares: cap must be a positive integer, got ${cap}`);
  for (const c of perSourceCounts) {
    if (!Number.isInteger(c) || c < 0) throw new Error(`allocateShares: every count must be a non-negative integer, got ${c}`);
  }
  if (typeof projectShare !== 'number' || !(projectShare >= 0 && projectShare <= 1)) {
    throw new Error(`allocateShares: projectShare must be between 0 and 1, got ${projectShare}`);
  }

  const domainCount = perSourceCounts.length - 1;
  // The epsilon keeps a product such as 0.6 x 15 = 9.000000000000002 from ceiling to 10.
  const projectQuota = domainCount === 0 ? cap : Math.min(cap, Math.ceil(projectShare * cap - 1e-9));
  const quotas = [projectQuota];
  const rest = cap - projectQuota;
  for (let i = 0; i < domainCount; i++) {
    quotas.push(Math.floor(rest / domainCount) + (i < rest % domainCount ? 1 : 0));
  }

  const alloc = perSourceCounts.map((count, i) => Math.min(count, quotas[i]));
  let left = cap - alloc.reduce((a, b) => a + b, 0);
  while (left > 0) {
    let gave = false;
    for (let i = 0; i < alloc.length && left > 0; i++) {
      if (alloc[i] < perSourceCounts[i]) {
        alloc[i]++;
        left--;
        gave = true;
      }
    }
    if (!gave) break;
  }
  return alloc;
}
