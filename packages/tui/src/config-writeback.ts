// Config write-back for the System-tab sparring/TDD/mutation-verification
// toggles (decision 752caf98, tdd-and-mutation-toggles-in-system-tab) —
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
// behavior of swallowing the error into a UI notice the caller owns.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SparringToggleEffect, TddToggleEffect, MutationToggleEffect } from './state.js';

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
export function applySparringToggle(e: SparringToggleEffect, onError?: (msg: string) => void, path?: string): void {
  try {
    const target = configPath(path);
    const raw = JSON.parse(readFileSync(target, 'utf8')) as { sparring_partner?: { enabled?: boolean; model?: string } };
    raw.sparring_partner = { ...raw.sparring_partner, enabled: e.enabled };
    writeFileSync(target, JSON.stringify(raw, null, 2) + '\n');
  } catch (err) {
    onError?.(`sparring partner toggle failed — ${(err as Error).message}`);
  }
}

/** Execute a tdd_toggle effect: config.tdd.enabled write only (decision
 *  752caf98) — mirrors applySparringToggle exactly. OFF silences the
 *  automatic default TDD posture only; H5/H18 test protection is untouched.
 *  Optional trailing `path` overrides the cwd-derived default (see
 *  applySparringToggle). */
export function applyTddToggle(e: TddToggleEffect, onError?: (msg: string) => void, path?: string): void {
  try {
    const target = configPath(path);
    const raw = JSON.parse(readFileSync(target, 'utf8')) as { tdd?: { enabled?: boolean } };
    raw.tdd = { ...raw.tdd, enabled: e.enabled };
    writeFileSync(target, JSON.stringify(raw, null, 2) + '\n');
  } catch (err) {
    onError?.(`tdd toggle failed — ${(err as Error).message}`);
  }
}

/** Execute a mutation_toggle effect: config.mutation_verification.enabled
 *  write only (decision 752caf98) — mirrors applySparringToggle exactly.
 *  Optional trailing `path` overrides the cwd-derived default (see
 *  applySparringToggle). */
export function applyMutationToggle(e: MutationToggleEffect, onError?: (msg: string) => void, path?: string): void {
  try {
    const target = configPath(path);
    const raw = JSON.parse(readFileSync(target, 'utf8')) as { mutation_verification?: { enabled?: boolean } };
    raw.mutation_verification = { ...raw.mutation_verification, enabled: e.enabled };
    writeFileSync(target, JSON.stringify(raw, null, 2) + '\n');
  } catch (err) {
    onError?.(`mutation verification toggle failed — ${(err as Error).message}`);
  }
}
