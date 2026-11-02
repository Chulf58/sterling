// Checkout evidence identity (decision
// maintenance-reconciliation-retains-checkout-evidence-and-use): the one
// definition of when two observations are the same evidence, shared by the
// store's fold and the settlement minter that names observations to replace.
// The shape itself is the todo schema's `observations` (packages/schemas); this
// module only derives from it.
import type { DurableRecord } from '@sterling/schemas';

export type Observation = NonNullable<Extract<DurableRecord, { type: 'todo' }>['observations']>[number];

/** Identity of one observation; equal keys are the same evidence. */
export function observationKey(o: Observation): string {
  const c = o.checkout as { kind: string; worktree?: string; branch?: string };
  const s = o.state as { kind: string; mode?: string; blob?: string };
  return JSON.stringify([o.path, c.kind, c.worktree ?? '', c.branch ?? '', o.commit ?? '', s.kind, s.mode ?? '', s.blob ?? '']);
}

/** An explicit unknown contribution for `path` (legacy debt that kept no evidence). */
export function unknownObservation(path: string): Observation {
  return { path, checkout: { kind: 'unknown' }, state: { kind: 'unknown' } };
}

/** Supersede hops followed before a debt link counts as unresolved. */
export const DEBT_OWNER_HOP_CAP = 32;

/**
 * THE ONE resolution of a reconcile item's `feature_link` to the record that
 * owns its debt now: a historical id maps to its canonical id (record_aliases),
 * then the supersede chain is followed to its live end. Returns that record's
 * id, or undefined when the link resolves nowhere (missing, broken or cyclic
 * chain, too many hops). Internal links only: it never readdresses a caller's
 * write. Used by the store's reconcile pruning and by the MCP server's worker
 * gate, attested close and resolves validation, so all of them read the same
 * known lineage.
 */
export function resolveDebtOwner(
  link: string | undefined,
  get: (id: string) => { id: string; status?: string; superseded_by?: string | null } | undefined,
  aliases: Iterable<{ historical_id: string; canonical_id: string }>
): string | undefined {
  if (!link) return undefined;
  let canonical = link;
  for (const a of aliases) if (a.historical_id === link) canonical = a.canonical_id;
  let record = get(canonical);
  const seen = new Set<string>();
  while (record && record.status === 'superseded') {
    if (seen.size >= DEBT_OWNER_HOP_CAP || seen.has(record.id) || !record.superseded_by) return undefined;
    seen.add(record.id);
    record = get(record.superseded_by);
  }
  return record?.id;
}
