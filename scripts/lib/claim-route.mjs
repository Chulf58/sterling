// Routing by board claim (multi-session toolkit slice 5; decision
// sterling-ports-ch-hub-s-whole-multi-session-toolkit-session). Ported in behaviour from CH.Hub's
// scripts/lib/claim-route.mjs, for ONE item: `--item <board id>` sends a wake or a notice to the session
// holding that item's claim instead of the checkout's owner.
//
// The claim is read from the target project's own board through Sterling's read-only foreign board reader
// (getForeignBoardItem; nothing is written and no SterlingStore is opened) and judged by boardClaimView with
// the TARGET project's board_claims.lease_minutes, never a default. Only a HELD claim routes: no claim, or an
// expired one (nobody renews it), routes to the checkout's owner as without --item. A held claim whose holder
// cannot take the message is never replaced by the owner: the caller refuses.
//
// The reader is synchronous, so the re-read right before the send (recheckClaim) sits with the synchronous
// owner re-read after the closing activity read, with no await between it and the POST. The send goes ahead
// only if the claim still sends the message where the first read pointed it.
import { existsSync } from 'node:fs';
import { boardClaimView, getForeignBoardItem, SUPPORTED_SCHEMA_VERSION } from '@sterling/store';
import { resolveStoreRoute } from '@sterling/store/routing';

export const CLAIM_READ_BUDGET_MS = 3_000;

/** A claim problem the caller turns into a refusal: `reason` is a stable word, `why` the sentence. */
export class ClaimProblem extends Error {
  constructor(reason, why) {
    super(`${reason}: ${why}`);
    this.reason = reason;
    this.why = why;
  }
}

// An item reference as getForeignBoardItem takes it: a full id, an 8-hex prefix or a slug. No spaces, no flags.
export const isItemRef = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(v);

/**
 * The real reader: `{ root, ref, now }` -> { state: 'none' | 'held' | 'expired', id, ... } for the item, or
 * { state: 'not_found' } / { state: 'ambiguous', matches }. Anything else the board cannot say (no store, a
 * newer schema, a cut-short read, an unreadable claim) throws, so an unreadable claim is never taken for none.
 */
export function realClaimReader({ root, ref, now, budgetMs = CLAIM_READ_BUDGET_MS }) {
  if (!existsSync(root)) throw new Error(`the project folder ${root} does not exist`);
  const route = resolveStoreRoute(root);
  if (route === null) throw new Error(`${root} has no Sterling store`);
  if (route.storage !== 'sqlite') throw new Error(`the board of ${root} is on ${route.storage}, which this reader cannot open`);
  if (!existsSync(route.projectDbPath)) throw new Error(`${root} has no board store yet`);
  const { lookup, board } = getForeignBoardItem(route.projectDbPath, ref, 'in the target project', { budgetMs });
  if (!('found' in lookup)) {
    if (/names no user board item/.test(lookup.refused)) return { state: 'not_found' };
    const matches = /ambiguous[^:]*: (.*)$/.exec(lookup.refused)?.[1].split(', ');
    if (matches) return { state: 'ambiguous', matches };
    throw new Error(`the item ${lookup.refused}`);
  }
  if (board.schemaVersion > SUPPORTED_SCHEMA_VERSION) throw new Error(`the board is schema v${board.schemaVersion}, newer than this Sterling reads`);
  const item = lookup.found;
  const view = boardClaimView(item.claim, now, route.config.board_claims.lease_minutes);
  if (view === undefined) return { state: 'none', id: item.id };
  if (view.state === 'unreadable') throw new Error(`the claim on item ${item.id} lacks a field this Sterling reads`);
  return { state: view.state, id: item.id, holder_session: view.holder_session, checkout: view.checkout, generation: view.generation };
}

const STATES = new Set(['none', 'held', 'expired']);

/** One read of the item's claim through deps.readClaim; throws ClaimProblem for every state that cannot route. */
export function readItemClaim(deps, root, project, ref) {
  let r;
  try {
    r = deps.readClaim({ root, ref, now: deps.now() });
  } catch (e) {
    throw new ClaimProblem('claim_unreadable', `the claim on item ${ref} of ${project}'s board cannot be read (${e?.message ?? e}); nothing sent`);
  }
  if (r?.state === 'not_found') throw new ClaimProblem('item_not_found', `item ${ref} is not on ${project}'s board, so it has no claim to route by; nothing sent`);
  if (r?.state === 'ambiguous') throw new ClaimProblem('item_ambiguous', `item ${ref} starts more than one item of ${project}'s board (${(r.matches ?? []).join(', ')}); give the full id; nothing sent`);
  const sane = STATES.has(r?.state) && typeof r.id === 'string' && (r.state === 'none' || (typeof r.holder_session === 'string' && typeof r.checkout === 'string' && Number.isInteger(r.generation)));
  if (!sane) throw new ClaimProblem('claim_unreadable', `the claim reader answered an unusable shape for item ${ref} of ${project}'s board; nothing sent`);
  return r;
}

/** How a read is shown in a result. */
export const summarize = (ref, r) => ({ item: ref, state: r.state, ...(r.state === 'held' || r.state === 'expired' ? { holder_session: r.holder_session, checkout: r.checkout, generation: r.generation } : {}) });

const stateOf = (r) => (r.state === 'held' || r.state === 'expired' ? `${r.state} by ${r.holder_session}, generation ${r.generation}` : r.state);

/**
 * Right before the send: read the claim again (synchronously) and compare it with `before`, the read the destination was
 * chosen from. The resolved full item id must be the same (a slug or prefix that now names another item is a change).
 *   to the owner (before not held): the claim must still not be held; one taken meanwhile means the message now belongs to
 *     its holder.
 *   to a holder (before held): still held by the same session, from the same checkout, under the same generation.
 * A read that cannot be had throws its own ClaimProblem.
 */
export function recheckClaim(deps, root, project, ref, before) {
  const again = readItemClaim(deps, root, project, ref);
  const same = again.id === before.id && (before.state === 'held'
    ? again.state === 'held' && again.holder_session === before.holder_session && again.checkout === before.checkout && again.generation === before.generation
    : again.state !== 'held');
  if (!same) throw new ClaimProblem('claim_changed', `the claim on item ${ref} of ${project}'s board changed after it was read (was ${stateOf(before)}; now ${stateOf(again)}); nothing sent`);
}
