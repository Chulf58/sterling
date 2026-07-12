// H3 — contract gate, dual-mode + debug-scope (spec §6 H3). PreToolUse
// Edit|Write|MultiEdit, blocking exit-2. Scope logic lives in ONE definition
// (lib/contract.mjs) shared with the contract-checked fs helpers.
// run mode: brief contract + H13 read-evidence (creation exempt).
// debug-scope mode: registered explorer map bounds direct-mode edits.
// direct mode: read-before-edit via the conductor ledger (H7 registers touches).
import { existsSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesGlob } from '@sterling/schemas';
import { readStdin, deny, allow, openStore, repoRel, withRetry } from './lib/common.mjs';
import { ledgerPath, hasRead } from './lib/ledger.mjs';
import { scopeCheck, readDebugScope, ENFORCEMENT_SURFACE } from './lib/contract.mjs';

const input = readStdin();
const cwd = input.cwd;
const toolPath = input.tool_input?.file_path;
const rel = repoRel(toolPath, cwd);

// Enforcement self-protection (§6 H3, build-proven — a blocked session
// attempted disableAllHooks self-repair): for SPAWNED AGENTS, edits to the
// enforcement surface are denied unconditionally in every mode, regardless of
// scope, store presence, or registered maps. The conductor (human-attended)
// is exempt and goes through the normal contract rules below.
if (input.agent_id && toolPath) {
  const fwd = String(toolPath).replace(/\\/g, '/');
  const hooksDir = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/'); // bundled: <plugin>/hooks
  if (fwd === hooksDir || fwd.startsWith(hooksDir + '/')) {
    deny(`H3 [self-protection]: '${toolPath}' is inside the bundled hooks directory — the enforcement surface is never agent-editable, in any mode (§6 H3)`);
  }
  if (rel && ENFORCEMENT_SURFACE.some((g) => matchesGlob(rel, g))) {
    deny(`H3 [self-protection]: '${rel}' is enforcement surface (${ENFORCEMENT_SURFACE.join(', ')}) — never agent-editable, in any mode (§6 H3); if enforcement is misbehaving, exit blocked and report it`);
  }
}

// A BLOCKING gate that cannot verify must DENY, never void itself: an uncaught
// throw exits 1, which the platform treats as non-blocking (decision 2422e76a's
// fail-closed rule, applied here per audit finding 5/43). Busy throws retry;
// everything else denies in the catch below.
let store;
try {
  store = openStore(cwd);
  if (!store) deny('H3: no Sterling store at .sterling/ — the contract gate cannot evaluate scope; failing closed (P5)');

  const run = withRetry(() => store.getRun());
  const absolute = toolPath && (isAbsolute(String(toolPath)) || /^[A-Za-z]:/.test(String(toolPath)));
  const absPath = rel ? join(cwd, rel) : absolute ? String(toolPath) : undefined;
  const isCreation = absPath ? !existsSync(absPath) : false;

  if (run) {
    if (!rel) deny(`H3 [run mode]: '${toolPath}' is outside the repository — the run owns only the working tree; out of scope`);
    const brief = withRetry(() => store.get(run.brief_ref));
    if (!brief || brief.type !== 'brief') deny(`H3 [run mode]: brief '${run.brief_ref}' not found in the store; failing closed (P5)`);
    const scope = scopeCheck({ brief, rel, amendments: (run.scope_amendments ?? []).map((a) => a.path) });
    if (scope.deny) deny(`H3 [run mode]: ${scope.deny}`);
    if (!isCreation && !hasRead(ledgerPath(cwd, run.id, input.agent_id), rel)) {
      deny(`H3: no read-evidence for '${rel}' — Read the exact file before editing (read before edit; Grep/Glob hits are not read-evidence)`);
    }
    allow();
  }

  // direct mode (+ debug-scope when a map is registered); file-touch registration is H7's job
  if (!rel) allow(); // outside the repo: the contract governs the repository
  const scope = scopeCheck({ debugScope: readDebugScope(cwd), rel });
  if (scope.deny) deny(`H3 [debug-scope mode]: ${scope.deny}`);
  if (!isCreation && !hasRead(ledgerPath(cwd, undefined, input.agent_id), rel)) {
    deny(`H3 [direct mode]: no read-evidence for '${rel}' — Read the exact file before editing`);
  }
  allow();
} catch (e) {
  deny(`H3: contract evaluation failed (${(e && e.message) || e}) — failing closed (P5); retry the edit`);
} finally {
  store?.close();
}
