// Shared "provably-unmodified-since-generation" marker (board bb3aa162).
//
// The problem: ensureUpdateLauncher and ensureConsumerCheckLauncher (its
// deliberate faithful mirror) both compared the on-disk file against a
// FRESHLY re-rendered expected. Any mismatch — including one caused only by
// the clone moving or the template changing — read as "possibly hand-edited"
// and was left in place forever, so a stale generated launcher never
// self-heals until someone notices and hand-deletes it.
//
// The fix: stamp a content-hash marker into the file at generation time,
// hashing the rendered body EXCLUDING the marker itself. On a later ensure
// pass, if the file's CURRENT body still hashes to what its own marker
// claims, nothing has touched it since IT was generated — safe to overwrite
// with a fresh render even when that fresh render now differs (a clone move,
// a template edit). If the hash no longer matches, something DID touch the
// file after generation (hand-edit, corruption) — leave it alone. A file
// with no marker at all (hand-authored, or generated before this marker
// existed) falls back to the caller's original bare content-equality
// compare — a one-time migration cost, not a silent overwrite of something
// that might be hand-edited.
//
// Mirrors sync-agents' template_hash/content_hash precedent
// (scripts/lib/agent-distribution.mjs) at a smaller scale: one hash, no
// template-drift distinction, because these launchers have no per-install
// customization surface to preserve.
//
// BOOTSTRAP INDEPENDENCE: imported by both update-launcher.mjs and
// consumer-checks.mjs at load time, so builtins only.
import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// LF-normalize before hashing: a Windows checkout with core.autocrlf=true (no
// .gitattributes pins these templates' line endings) reads the SOURCE
// template back with CRLF already embedded, so the un-normalized body hashed
// here would never again match a disk read that has since been
// LF-normalized by the caller (renderUpdateLauncher's own crlf()/normalize()
// round trip) — a permanent, spurious 'differs' on exactly the Windows/.bat
// path this marker exists to self-heal (parity requirement). Both stampBody
// and verifyStamp hash the SAME normalized form regardless of what line
// endings the caller handed in.
const normalizeEol = (s) => s.replace(/\r\n/g, '\n');
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Inserts a content-hash marker as the SECOND line of `body` (right after
 * its first line — a shebang or `@echo off` — so the marker never displaces
 * what must stay line 1). `body` is LF-normalized before hashing/splitting,
 * so the hash is stable regardless of the line endings the caller handed in.
 *
 * @param {string} body - the fully-rendered content, no marker
 * @param {string} prefix - this file's comment syntax, e.g. '//' or 'rem'
 * @returns {string} body with the marker line inserted after its first line
 */
export function stampBody(body, prefix) {
  const normalized = normalizeEol(body);
  const lines = normalized.split('\n');
  const [first, ...rest] = lines;
  return [first, `${prefix} sterling-generated content_hash=${sha256(normalized)}`, ...rest].join('\n');
}

/**
 * Verifies a previously-stamped file's body against ITS OWN embedded hash —
 * true only when nothing has touched the body since it was generated,
 * regardless of whether a fresh render would now produce different content.
 *
 * @param {string} content - the on-disk content, LF-normalized
 * @param {string} prefix - same comment syntax passed to stampBody
 * @returns {{ unmodified: boolean } | null} null when no marker is present
 *   (legacy or foreign file) — the caller falls back to its own compare
 */
export function verifyStamp(content, prefix) {
  const normalized = normalizeEol(content);
  const lines = normalized.split('\n');
  const marker = lines[1] ?? '';
  const m = new RegExp(`^${escapeRegExp(prefix)} sterling-generated content_hash=([0-9a-f]{64})$`).exec(marker);
  if (!m) return null;
  const rebuilt = [lines[0], ...lines.slice(2)].join('\n');
  return { unmodified: sha256(rebuilt) === m[1] };
}
