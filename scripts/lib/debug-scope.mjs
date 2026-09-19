// scripts/lib/debug-scope.mjs — debug-scope registration + the scope check the
// contract-checked fs helpers (fs-remove / fs-move) still need.
//
// MIGRATED from scripts/hooks/lib/contract.mjs under decision
// `sterling-claude-code-scale-down-boundary` (2ad87dd1): contract.mjs's other
// two concerns — the pipeline BRIEF (run-mode) scope check and the
// ENFORCEMENT_SURFACE self-protection helpers — died with H3/H17/H18 and the
// staged pipeline (briefs no longer exist). Debug-scope registration backs
// the surviving debug SOP (skills/debug) and stays; the fs helpers still need
// a scope check when a debug-scope map is registered, so `scopeCheck` here is
// the direct-mode/debug-scope-mode subset of the original three-mode function
// — the run/brief branch and the mid-run scope-amendment union are gone along
// with the brief they operated on.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { matchesGlob } from '@sterling/schemas';

export function debugScopePath(cwd) {
  return join(cwd, '.sterling', 'transient', 'debug-scope.json');
}

export function readDebugScope(cwd) {
  const p = debugScopePath(cwd);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export function registerDebugScope(cwd, paths) {
  const p = debugScopePath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ paths: paths.map((x) => x.replace(/\\/g, '/')), registered_at: new Date().toISOString() }));
}

export function clearDebugScope(cwd) {
  rmSync(debugScopePath(cwd), { force: true });
}

/**
 * Scope decision, direct mode only (the run/brief branch is gone with the
 * staged pipeline). debugScope != null → debug-scope mode; else no scope
 * denial here — the read-evidence ledger is the only remaining direct-mode
 * discipline, and that stays with H13/the ledger, not this check.
 * Returns { deny: <reason> } or {}.
 */
export function scopeCheck({ debugScope, rel }) {
  if (debugScope) {
    const inMap = debugScope.paths.some((g) => rel === g || matchesGlob(rel, g));
    if (!inMap) {
      return {
        deny: `'${rel}' is outside the registered debug-scope map — confirm or expand the map (scripts/debug-scope.mjs register) before editing`,
      };
    }
  }
  return {};
}
