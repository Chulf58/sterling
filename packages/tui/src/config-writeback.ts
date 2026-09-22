// Config write-back for the System-tab sparring/TDD toggles (decision
// foreign_752caf98, tdd-and-mutation-toggles-in-system-tab; the sibling
// mutation-verification toggle this module used to also write back was
// REMOVED entirely — decision
// cleanup-run-deletes-dead-scripts-and-removes-mutation-verification-key,
// 2026-09-22, no live mechanism ever performed the check it promised) —
// EXTRACTED from main.ts (Codex review finding) so the frozen pins in
// tests/config-writeback.test.ts can import this module directly without
// pulling in main.ts's argv-parsing/terminal-kit side effects on import.
//
// Reads/writes .sterling/config.json under the PROCESS CWD — read-modify-
// write with a spread-merge: unrelated top-level keys and unrelated sibling
// keys inside the touched block survive byte-for-byte; a config missing the
// block entirely gains exactly {enabled: <effect value>}.
//
// Each function stays SYNC (the pre-extraction convention). onError is an
// optional callback (main.ts wires it to its local notice state); a caller
// that omits it gets silent-but-caught failure, matching the pre-extraction
// behavior of swallowing the error into a UI notice the caller owns. Each
// function returns `true` on a successful write and `false` on a caught
// failure (onError still fires with the byte-identical failure message) —
// on SUCCESS, nothing is emitted here: a throwing onError must never land
// inside the try and turn a completed write into a false failure report,
// and a later success in a same-tick batch must never clobber an earlier
// failure on the shared UI notice sink. The caller (main.ts) composes the
// single H17-latch reminder itself once all appliers in the batch have run
// — board 09f05fca half 2, review fix.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SparringToggleEffect, TddToggleEffect } from './state.js';

function configPath(explicit?: string): string {
  return explicit ?? join(process.cwd(), '.sterling', 'config.json');
}

/** Execute a sparring_toggle effect: config.sparring_partner.enabled write
 *  only (advisory-only surface, article interaction a — never gates, so
 *  there is no downstream projection or decision record the way a model swap
 *  has). Preserves the model field untouched. Optional trailing `path`
 *  overrides the cwd-derived default (delta review finding: the TUI's own
 *  read/write path is argv-derived, not cwd-derived, so a foreign launch cwd
 *  must never split the two). */
export function applySparringToggle(e: SparringToggleEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    const target = configPath(path);
    const raw = JSON.parse(readFileSync(target, 'utf8')) as { sparring_partner?: { enabled?: boolean; model?: string } };
    raw.sparring_partner = { ...raw.sparring_partner, enabled: e.enabled };
    writeFileSync(target, JSON.stringify(raw, null, 2) + '\n');
    return true;
  } catch (err) {
    onError?.(`sparring partner toggle failed — ${(err as Error).message}`);
    return false;
  }
}

/** Execute a tdd_toggle effect: config.tdd.enabled write only (decision
 *  752caf98) — mirrors applySparringToggle exactly. OFF silences the
 *  automatic default TDD posture only; H5/H18 test protection is untouched.
 *  Optional trailing `path` overrides the cwd-derived default (see
 *  applySparringToggle). */
export function applyTddToggle(e: TddToggleEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    const target = configPath(path);
    const raw = JSON.parse(readFileSync(target, 'utf8')) as { tdd?: { enabled?: boolean } };
    raw.tdd = { ...raw.tdd, enabled: e.enabled };
    writeFileSync(target, JSON.stringify(raw, null, 2) + '\n');
    return true;
  } catch (err) {
    onError?.(`tdd toggle failed — ${(err as Error).message}`);
    return false;
  }
}
