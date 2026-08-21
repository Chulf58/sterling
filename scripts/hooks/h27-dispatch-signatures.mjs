// H27 — dispatch-time SIGNATURES verifier (board a06e4a1c). PreToolUse
// Task|Agent, joins the existing entry (after h8-dispatch-cap,
// h20-mechanism-axis, h25-dispatch-capability, h26-dispatch-overlap).
// Governing decision: knowledge_get 7a4c3fb6-dc23-4c2f-9369-d2592132f408
// (slug frozen-test-repair-signatures-plus-visible-repair) is the authority
// on semantics — the PREVENTION half of the ruling; the frozen suite
// (scripts/tests/h27-dispatch-signatures.test.mjs) is authoritative where
// more specific.
//
// UNLIKE H25/H26, THIS HOOK DOES DENY (exit 2): a conductor dispatching a
// blind test-writer (or any agent) can append a structured
// `STERLING-SIGNATURES` section to the outgoing prompt naming repo-relative
// source files plus the exact signature text the blind author is expected
// to rely on. Before the spawn proceeds, this hook re-reads each named file
// from disk and confirms the declared signature text appears VERBATIM
// (substring, trimmed) in it. A wrong signature handed to a blind test
// author has twice produced a project-wide scan error only the conductor
// could repair (retro 2026-08-17 §2.1) — that cost is why this channel gets
// a real gate instead of an advisory (P5). The channel is strictly OPT-IN:
// no `STERLING-SIGNATURES` marker anywhere in the prompt means silent
// allow, zero ceremony (P1) — ordinary dispatches are never touched.
//
// WHAT IT DOES: a `STERLING-SIGNATURES` marker LINE (trimmed exact match)
// starts a section; each immediately-following line of the form
// `- <repo-relative-path> :: <signature text>` is an entry (path/signature
// trimmed around the ` :: ` separator, tolerant of extra internal
// whitespace). Any other line — including a blank line — ends the section;
// content after that point is never parsed, even if it looks like an entry.
// A bulleted line under the marker with no ` :: ` separator is a malformed
// entry: DENY naming the exact bad line. Zero entries following a present
// marker is a half-wired declaration: DENY showing the expected format. For
// every parsed entry, the named file is resolved against the project root;
// a nonexistent file DENIES naming it, and a file whose content does not
// contain the (trimmed) signature text as an exact substring DENIES naming
// the path, quoting the failed signature, and stating the remedy (re-read
// the source and paste the exact line, or drop the entry) — matching is
// exact-substring only, never fuzzy. All entries verified → allow, plus an
// advisory (hookSpecificOutput.additionalContext) confirming the count.
// Non-Sterling cwd (no .sterling/sterling.db) always allows silently, even
// with a full section that would otherwise deny. Unparseable stdin exits 1
// via warnNonBlocking — an internal failure, distinct from every allow(0)/
// deny(2) case above.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readStdin, allow, deny, warnNonBlocking } from './lib/common.mjs';

const MARKER = 'STERLING-SIGNATURES';

let input;
try {
  input = readStdin();
} catch (e) {
  // Internal failure — the stdin contract itself is broken, not a dispatch to
  // evaluate. Loud but non-blocking (P5 without a denial): distinct from
  // every deny(2) below.
  warnNonBlocking(`H27: failed to parse stdin: ${(e && e.message) || e}`);
}

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext },
    })
  );
}

try {
  // Not a Sterling project — no ceremony (P1), same DB-file marker every
  // other hook in this layer keys on.
  if (!existsSync(join(input.cwd ?? '.', '.sterling', 'sterling.db'))) allow();

  const prompt = String(input.tool_input?.prompt ?? '');
  const lines = prompt.split('\n');
  // A prompt may MENTION the marker on its own line (a brief documenting
  // H27, a pasted excerpt) before carrying the real section — so among all
  // marker lines, the FIRST ONE FOLLOWED BY A BULLETED LINE wins (review
  // finding 2026-08-21); only when no marker has entries does the first
  // occurrence stand, feeding the zero-entry deny below.
  const markerIdxs = lines.flatMap((l, i) => (l.trim() === MARKER ? [i] : []));
  if (!markerIdxs.length) allow(); // opt-in channel: no marker, no output at all
  const markerIdx = markerIdxs.find((i) => (lines[i + 1] ?? '').startsWith('- ')) ?? markerIdxs[0];

  // Consecutive `- <path> :: <sig>` lines immediately after the marker. The
  // first line that is not of that shape (including a blank line) ends the
  // section — content after it is never parsed, even a decoy entry-shaped
  // line naming a file that would otherwise deny.
  const entries = [];
  for (let i = markerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('- ')) break;
    const rest = line.slice(2);
    const sep = rest.match(/\s+::\s+/);
    if (!sep) {
      deny(
        `H27: malformed STERLING-SIGNATURES entry (missing ' :: ' separator): '${line}'\n` +
          `Expected format: - <repo-relative-path> :: <signature text>`
      );
    }
    const path = rest.slice(0, sep.index).trim();
    const sig = rest.slice(sep.index + sep[0].length).trim();
    entries.push({ path, sig });
  }

  if (!entries.length) {
    deny(
      `H27: STERLING-SIGNATURES marker present but zero entries follow it — a declared-but-empty section is a ` +
        `half-wired extension.\nExpected format: - <repo-relative-path> :: <signature text>`
    );
  }

  const root = resolve(input.cwd ?? '.');
  for (const entry of entries) {
    // Repo containment (invariant 2): an entry must name a repo-relative
    // path; one that resolves outside the project root is refused, never
    // read (review finding 2026-08-21).
    const abs = resolve(root, entry.path);
    if (abs !== root && !abs.startsWith(root + sep)) {
      deny(`H27: STERLING-SIGNATURES entry escapes the project root: '${entry.path}' — paths must be repo-relative.`);
    }
    if (!existsSync(abs)) {
      deny(`H27: STERLING-SIGNATURES entry names a file that does not exist: '${entry.path}'`);
    }
    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch (e) {
      // A blocking gate that cannot evaluate must DENY, never shrug (the
      // e13f0fb5 fail-closed class): an unreadable entry (directory,
      // permission error) would otherwise pass unverified.
      deny(`H27: STERLING-SIGNATURES entry '${entry.path}' could not be read (${(e && e.message) || e}) — the gate cannot verify it.`);
    }
    if (!content.includes(entry.sig)) {
      deny(
        `H27: STERLING-SIGNATURES entry for '${entry.path}' — declared signature not found verbatim in the file: ` +
          `'${entry.sig}'. Re-read the source and paste the exact line, or drop the entry.`
      );
    }
  }

  emit(
    `H27: ${entries.length} signature(s) verified against source files named in the STERLING-SIGNATURES section.`
  );
  allow();
} catch (e) {
  // Internal failure — distinct from a genuine finding above. Loud, never a
  // silent gate-void (P5).
  warnNonBlocking(`H27: dispatch-signature verification failed: ${(e && e.message) || e}`);
}
// no close: every path above exits the process, releasing the handle (board f81b1987)
