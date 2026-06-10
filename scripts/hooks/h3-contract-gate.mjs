// H3 — contract gate, dual-mode (spec §6 H3). PreToolUse Edit|Write|MultiEdit, blocking exit-2.
// run mode: scope = brief blast_radius + incidental_scope; out_of_scope globs deny;
//           read-evidence required via the H13 ledger.
// direct mode: read-before-edit via the same ledger; file-touch registration is
//           H7's (not built) — skipped loudly, never silently (§16.1.9).
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { matchesGlob } from '@sterling/schemas';
import { readStdin, deny, allow, openStore, repoRel } from './lib/common.mjs';
import { ledgerPath, hasRead } from './lib/ledger.mjs';

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
    for (const oos of brief.out_of_scope) {
      if (matchesGlob(rel, oos)) deny(`H3 [run mode]: '${rel}' is declared out_of_scope ('${oos}') in the brief`);
    }
    const allowed = new Set([...brief.blast_radius.files.map((f) => f.path), ...brief.incidental_scope]);
    if (!allowed.has(rel)) {
      deny(`H3 [run mode]: '${rel}' is outside the brief's blast_radius + incidental_scope — re-scope, don't route around the gate (contract-violated)`);
    }
    if (!isCreation && !hasRead(ledgerPath(cwd, run.id, input.agent_id), rel)) {
      deny(`H3: no read-evidence for '${rel}' — Read the exact file before editing (read before edit; Grep/Glob hits are not read-evidence)`);
    }
    allow();
  }

  // direct mode
  if (!rel) allow(); // outside the repo: the contract governs the repository
  if (!isCreation && !hasRead(ledgerPath(cwd, undefined, input.agent_id), rel)) {
    deny(`H3 [direct mode]: no read-evidence for '${rel}' — Read the exact file before editing`);
  }
  store.recordCheckSkipped('h7-file-touch-reconcile', 'not_built', undefined, new Date().toISOString());
  allow();
} finally {
  store.close();
}
