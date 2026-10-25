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
