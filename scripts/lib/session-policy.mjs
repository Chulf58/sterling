// Shared read-only session policy for the inventory and the wake and clear scripts.
// Older conductors have no agent field; other top-level agents are workers.
export const isConductorCandidate = (session) => session.parentID == null && !session.time?.archived
  && (session.agent === undefined || session.agent === 'sterling/conductor');

// Synthetic shell results and Sterling context injections can sit in an idle inbox
// indefinitely. Typed text and every other (including unreadable) entry remain input.
export const isNonInputNotice = (entry) => entry?.type === 'synthetic' && (entry.payload?.metadata?.source === 'shell'
  || (typeof entry.payload?.text === 'string' && entry.payload.text.startsWith('STERLING CONTEXT (added by the Sterling plugin')));

// The ordering-only sign that a user's manual /clear left owners.json naming the session that was cleared : the top-level conductors of ONE checkout (`tops`, each
// { id, created }) that were created after the owner entry was recorded (`entry.set_at`), the newest ones. Activity is
// never judged here: the old owner's lanes or unread notices may keep it live long after the clear, so a test of its
// quiet would never fire in the usual case. a caller's takeover adds its own strict conditions to this answer, and none of them writes the owner list for it. An entry with no readable set_at and a
// session with no creation time never count. Returns the sessions created at the newest time (several when they tie, in the
// order given: the caller decides what an ambiguity is), or [] when there is none.
export function likelyReset(entry, tops) {
  const designatedAt = Date.parse(entry?.set_at);
  if (!Number.isFinite(designatedAt)) return [];
  const newer = tops.filter((t) => t.id !== entry.session && Number.isFinite(t.created) && t.created > designatedAt);
  if (newer.length === 0) return [];
  const latest = Math.max(...newer.map((t) => t.created));
  return newer.filter((t) => t.created === latest);
}
