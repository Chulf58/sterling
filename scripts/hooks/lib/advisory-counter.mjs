// Advisory firing counter — EXPIRING SCAFFOLDING for the de-complication campaign.
//
// Records one NDJSON line per advisory-hook firing so slice S5 can put measured
// fired-counts in front of the user before any advisory is deleted (finding
// `sterling-accretes-because-every-mechanism-has-an-advocate-and-no-opponent`
// proposal (1); the Codex round's standing objection was that without this,
// line count stands in for measured value). THIS FILE IS DELETED AT SLICE S5
// REGARDLESS OF OUTCOME — it is the campaign's one allowed addition, and it is
// not permitted to outlive the verdict it exists to inform.
//
// Contract: NEVER throws and never changes a hook's OBSERVABLE behavior — a
// telemetry failure inside an advisory hook must not alter what the hook does
// (the hooks it rides are advisory; breaking them over a counter would invert
// the priority). Every error is swallowed; there is deliberately no fail-loud
// arm here because this is measurement scaffolding, not enforcement (P5 governs
// signals that gate work — a lost sample only under-counts a firing). NARROWED
// CLAIM (Codex review 2026-08-30): the calls are SYNCHRONOUS — one existsSync,
// one mkdirSync, one small append — so this is "bounded small sync I/O", not
// an absolute never-blocks; a pathological filesystem stalls it like any other
// sync hook I/O. Agent-planted special-file targets are out of reach: H15
// denies shell writes into .sterling/, and the Write tool creates only regular
// files.
//
// One line per fire: {"hook":"h25","session":"<id|null>","at":"<iso>"}
// session comes from the CALLER's stdin session_id when it has one (concurrent
// sessions overwrite session.json last-writer-wins, so the file is only the
// fallback — Codex review 2026-08-30). Destination:
// <root>/.sterling/transient/advisory-fires.ndjson — append-only, deliberately
// NOT per-session-reset (S5 needs the cross-session history), riding the same
// transient-directory convention as h21's counters. The S5 reader MUST skip
// unparseable lines (append atomicity is not contractual on /mnt/c drvfs).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function recordAdvisoryFire(root, hook, sessionId) {
  try {
    if (!root || !hook) return;
    // NON-STERLING GUARD (correctness review 2026-08-30, MEDIUM): readStdin
    // leaves cwd untouched when no project root is found, and h29 carries no
    // store/config gate of its own — without this check a codex failure inside
    // a non-Sterling repo would MATERIALIZE a .sterling/ tree there. Telemetry
    // observes; it never creates the project marker it rides on.
    if (!existsSync(join(root, '.sterling'))) return;
    const dir = join(root, '.sterling', 'transient');
    mkdirSync(dir, { recursive: true });
    let session = typeof sessionId === 'string' && sessionId ? sessionId : null;
    if (!session) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
        session = typeof parsed?.session_id === 'string' ? parsed.session_id : null;
      } catch {
        // no session marker (or corrupt) — the sample is still worth keeping
      }
    }
    appendFileSync(
      join(dir, 'advisory-fires.ndjson'),
      JSON.stringify({ hook, session, at: new Date().toISOString() }) + '\n'
    );
  } catch {
    // swallowed by contract — see header
  }
}
