// H3 — contract gate, dual-mode + debug-scope (spec §6 H3). PreToolUse
// Edit|Write|MultiEdit, blocking exit-2. Scope logic lives in ONE definition
// (lib/contract.mjs) shared with the contract-checked fs helpers.
// run mode: brief contract + H13 read-evidence (creation exempt).
// debug-scope mode: registered explorer map bounds direct-mode edits.
// direct mode: read-before-edit via the conductor ledger (H7 registers touches).
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readStdin, deny, allow, openStore, repoRel } from './lib/common.mjs';
import { ledgerPath, hasRead } from './lib/ledger.mjs';
import { scopeCheck, readDebugScope } from './lib/contract.mjs';

const input = readStdin();
const cwd = input.cwd;
const toolPath = input.tool_input?.file_path;
const rel = repoRel(toolPath, cwd);

const store = openStore(cwd);
if (!store) deny('H3: no Sterling store at .sterling/ — the contract gate cannot evaluate scope; failing closed (P5)');

try {
  const run = store.getRun();
  const absolute = toolPath && (isAbsolute(String(toolPath)) || /^[A-Za-z]:/.test(String(toolPath)));
  const absPath = rel ? join(cwd, rel) : absolute ? String(toolPath) : undefined;
  const isCreation = absPath ? !existsSync(absPath) : false;

  if (run) {
    if (!rel) deny(`H3 [run mode]: '${toolPath}' is outside the repository — the run owns only the working tree; out of scope`);
    const brief = store.get(run.brief_ref);
    if (!brief || brief.type !== 'brief') deny(`H3 [run mode]: brief '${run.brief_ref}' not found in the store; failing closed (P5)`);
    const scope = scopeCheck({ brief, rel });
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
} finally {
  store.close();
}
