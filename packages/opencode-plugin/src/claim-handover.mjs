// Claim hand-over across /new (board 05fbab98; decision
// board-task-claims-for-parallel-sessions-claim-generation-ren: "Claims hand over across
// /new from the board (generation-checked, repeatable), not only from the rotation note").
// The predecessor's claims stay on the board, held by the old session, during rotation.
// When the restore runs for the new session, the plugin adopts the claims the rotation
// note's session held in this checkout (store.adoptClaims) BEFORE the note is consumed,
// so a crash before the transfer leaves the note for the next session. Adoption is
// repeatable, so a crash after the transfer costs nothing either. Recovery never depends
// on the note: a root session's context lists every claim in its checkout held by
// another session, naming board_adopt, and nothing is adopted by guess.

/**
 * Whether the rotation note names a board item as in flight (GitHub #230, user-ruled
 * 2026-11-17 "Adopt only named lanes"). The rule: the item counts as named when its full
 * id, its 8-char id prefix or its slug appears as a whole token in `next_slice` or in any
 * `lanes` text; an id or slug inside a longer word or slug does not count. Only named
 * items stay adopted; the rest are released at adoption.
 */
export function noteNamesItem(note, { id, slug }) {
  const texts = [note?.next_slice, ...(Array.isArray(note?.lanes) ? note.lanes : [])].filter((t) => typeof t === 'string');
  const keys = [id, typeof id === 'string' ? id.slice(0, 8) : null, slug].filter((k) => typeof k === 'string' && k);
  const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return keys.some((k) => {
    const re = new RegExp(`(?<![\\w-])${esc(k)}(?![\\w-])`, 'i');
    return texts.some((t) => re.test(t));
  });
}

/** `name (id8)` for one adopted or refused item, from the store row's label. */
export function itemName(entry) {
  const id8 = String(entry.id).slice(0, 8);
  return entry.label ? `${entry.label} (${id8})` : id8;
}

/**
 * The restore's line for one adoption run (`result` is store.adoptClaims' result with
 * `label` on each entry), or '' when the predecessor held no claim here.
 */
export function adoptionText(result, from) {
  const parts = [];
  if (result.adopted.length) parts.push(`adopted ${result.adopted.length}: ${result.adopted.map(itemName).join(', ')}`);
  if (result.released?.length) parts.push(`released ${result.released.length} (the rotation note does not name them as in flight, so they are free for any session to claim): ${result.released.map(itemName).join(', ')}`);
  if (result.releaseFailed?.length) parts.push(`could NOT release ${result.releaseFailed.length} (the rotation note does not name them, but the release failed; board_release them if they are not yours to keep): ${result.releaseFailed.map((r) => `${itemName(r)}, ${r.error}`).join('; ')}`);
  if (result.already.length) parts.push(`already yours from an earlier hand-over: ${result.already.map(itemName).join(', ')}`);
  if (result.refused.length) {
    const why = (r) =>
      r.reason === 'other_checkout'
        ? `held in checkout '${r.checkout}', not this one (that session may be live there; board_takeover takes it)`
        : r.reason === 'moved'
          ? `moved before the hand-over: session '${r.holder_session}' holds it at generation ${r.generation}`
          : 'released before the hand-over';
    parts.push(`left alone ${result.refused.length}: ${result.refused.map((r) => `${itemName(r)}, ${why(r)}`).join('; ')}`);
  }
  if (!parts.length) return '';
  return `BOARD CLAIMS HANDED OVER from session '${from}' (the rotation note's session) to this session: ${parts.join('. ')}.`;
}

/**
 * The orphan notice for a root session: claims in `checkout` held by any session other
 * than `session`, grouped by holder, from the board readiness rows (store.boardReadiness).
 * '' when there are none. The text carries no ages, so it is re-sent only when the set
 * of claims changes.
 */
export function orphanClaimsText(readiness, { checkout, session }) {
  const byHolder = new Map();
  for (const r of readiness ?? []) {
    const c = r.claim;
    if (!c || c.state === 'unreadable' || c.checkout !== checkout || c.holder_session === session) continue;
    if (!byHolder.has(c.holder_session)) byHolder.set(c.holder_session, []);
    byHolder.get(c.holder_session).push(`${r.name ?? String(r.id).slice(0, 8)} at generation ${c.generation}${c.state === 'expired' ? ', check owner' : ''}`);
  }
  if (!byHolder.size) return '';
  const lines = [...byHolder].map(([holder, items]) => `- session '${holder}': ${items.join('; ')}. Adopt with board_adopt from_session '${holder}'.`);
  return (
    `CLAIMS HELD BY AN EARLIER SESSION IN THIS CHECKOUT (nothing was adopted for you):\n${lines.join('\n')}\n` +
    `If that session has ended (a /new whose hand-over did not run, or a crash), adopt them; if it is still running in this checkout, leave them.`
  );
}

/**
 * The restore's line when the hand-over threw. An adoption can stop part-way: the store's
 * ClaimAdoptionIncomplete carries `partial` (labelled by the plugin), whose adopted items
 * are committed. Without it, which items moved is unknown. The current holders are not
 * restated here: the orphan notice re-reads the board after the restore and lists what
 * the earlier session still holds.
 */
export function handoverFailedText(error, from) {
  const why = error?.cause instanceof Error ? error.cause.message : error?.message ?? String(error);
  const moved = error?.partial?.adopted;
  // StoreOutcomeUncertainError: the failing write may have committed, so even an empty
  // `adopted` does not prove nothing moved.
  const uncertain = error?.cause?.name === 'StoreOutcomeUncertainError';
  const done = Array.isArray(moved)
    ? moved.length
      ? `it stopped part-way: adopted ${moved.length} (${moved.map(itemName).join(', ')}) before the failure; those stay adopted` +
        (uncertain ? ', and whether the last claim was adopted is not known' : '')
      : uncertain
        ? 'it stopped part-way, and whether the last claim was adopted is not known'
        : 'it stopped before adopting any claim'
    : 'it may have stopped part-way, and which claims moved is not known';
  return (
    `BOARD CLAIM HAND-OVER FAILED (${why}): ${done}. ` +
    `Claims session '${from}' still holds in this checkout are listed under CLAIMS HELD BY AN EARLIER SESSION; finish with board_adopt from_session '${from}' (safe to repeat).`
  );
}
