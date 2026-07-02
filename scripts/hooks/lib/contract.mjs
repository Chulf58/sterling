// H3's contract logic, ONE definition (spec §6 H3, §7.1): shared by the H3
// hook and the contract-checked fs helpers (fs-remove / fs-move). Three modes:
// run (brief contract), debug-scope (registered explorer map), direct (no
// scope constraint beyond read-evidence, which stays with the ledger).
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

// The enforcement surface, ONE definition (§6 H3 self-protection; H17 (A)/(B)
// verification). NO hooks/** here — H3 self-protects the bundled hooks dir by
// absolute path, and H17 pins hooks/** with a SEPARATE matchesGlob check.
export const ENFORCEMENT_SURFACE = ['.claude/settings*.json', '.claude/agents/**', '.sterling/config.json'];

/** True when a repo-relative POSIX path is enforcement surface. Arity 1 (rel) — no hooksRel. */
export function isEnforcementSurface(rel) {
  return typeof rel === 'string' && ENFORCEMENT_SURFACE.some((g) => matchesGlob(rel, g));
}

/**
 * Scope decision. brief != null → run mode; else debugScope != null →
 * debug-scope mode; else direct (no scope denial here).
 * `amendments` (string[] of exact repo-relative paths, mid-run-scope-amendment
 * decision 8e6f9491) are unioned into the allowed set AFTER the out_of_scope
 * loop — ordering is load-bearing: an amended path that also matches out_of_scope
 * stays denied. Omitting amendments (or []) is byte-identical to prior behavior.
 * Returns { deny: <reason> } or {}.
 */
export function scopeCheck({ brief, debugScope, rel, amendments = [] }) {
  if (brief) {
    for (const oos of brief.out_of_scope) {
      if (matchesGlob(rel, oos)) return { deny: `'${rel}' is declared out_of_scope ('${oos}') in the brief` };
    }
    const allowed = new Set([...brief.blast_radius.files.map((f) => f.path), ...brief.incidental_scope, ...amendments]);
    if (!allowed.has(rel)) {
      return { deny: `'${rel}' is outside the brief's blast_radius + incidental_scope — re-scope, don't route around the gate (contract-violated)` };
    }
    return {};
  }
  if (debugScope) {
    const inMap = debugScope.paths.some((g) => rel === g || matchesGlob(rel, g));
    if (!inMap) {
      return {
        deny: `'${rel}' is outside the registered debug-scope map — confirm or expand the map (scripts/debug-scope.mjs register) before editing (§6 H3 debug-scope mode)`,
      };
    }
  }
  return {};
}
