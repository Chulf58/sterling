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
import { readStdin, deny, allow, openStore, repoRel, withRetry, environmentDefectDenial } from './lib/common.mjs';
import { ledgerPath, hasFreshRead, readLedger, isLedgerTorn } from './lib/ledger.mjs';
import { scopeCheck, readDebugScope, ENFORCEMENT_SURFACE } from './lib/contract.mjs';

const input = readStdin();
const cwd = input.cwd;
const toolPath = input.tool_input?.file_path;
const rel = repoRel(toolPath, cwd);

// NAME THE LEDGER AND ITS WINDOW. ledgerPath resolves THREE different files
// (lib/ledger.mjs) and the old denial named none of them, so one sentence covered
// "you never read it", "you read it in an earlier prompt turn", and "a different
// agent read it". Since board 776d2b65 evidence expires with the FILE, not the
// prompt: a hashed entry counts while the file's bytes still match its
// read-time hash, so the denial's live cases are "never read it", "read it but
// the file has CHANGED since", and (post-compaction) "the ledger was cleared
// because compaction may have dropped the read from your window".
function evidenceDenial(mode, lp, path) {
  // ENVIRONMENT DEFECT, not misconduct (board c7b81456): a torn ledger file
  // (readLedger salvages it silently — see lib/ledger.mjs) means entries may
  // have been lost to a concurrent-write race, not that the agent skipped
  // the Read. Without this check the resulting denial is indistinguishable
  // from ordinary "you never read it" wording, which is exactly what burned
  // ~205k tokens in the motivating incident: the agent diagnosed its own
  // conduct instead of exiting blocked over broken ledger state.
  if (isLedgerTorn(lp)) {
    // SELF-HEALING (review finding F1): unlike the other environment-defect
    // branches, a torn ledger repairs itself on the caller's very next
    // successful Read — appendRead rewrites the file from the salvaged
    // entries (lib/ledger.mjs). "Do not retry" is exactly the wrong
    // instruction here; the fix IS the retry.
    const salvagedCount = readLedger(lp).length;
    return environmentDefectDenial(
      'H3',
      `The read-evidence ledger '${lp}' is TORN — present, non-empty, and not valid JSON (a concurrent writer likely interleaved two writes). ` +
        `${salvagedCount} entr${salvagedCount === 1 ? 'y' : 'ies'} were salvaged from the leading valid array; any record of a fresh read of '${path}' beyond ` +
        `that point may have been silently lost in the tear. This is NOT evidence that you skipped the Read.`,
      {
        agentId: input.agent_id,
        selfHeal: {
          action: 'Read the target file now — a successful Read is valid evidence AND repairs the torn ledger.',
          onRepeat: 'If this same TORN denial repeats after that Read',
        },
      }
    );
  }
  const count = readLedger(lp).length;
  const window = input.agent_id
    ? "this AGENT's own ledger — reads by the conductor or by another agent are never yours"
    : 'the CONDUCTOR ledger. Evidence EXPIRES WHEN THE FILE CHANGES (read-time content hash vs current bytes) and on context compaction — so either you never Read this exact file, or it has been modified since your last Read';
  return (
    `H3 [${mode}]: no fresh read-evidence for '${path}' — Read the exact file before editing. ` +
    `Checked ${lp} (${count} entr${count === 1 ? 'y' : 'ies'}), which is ${window}. ` +
    `Grep/Glob hits are not read-evidence.`
  );
}

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
  if (!store)
    deny(
      environmentDefectDenial('H3', 'No Sterling store at .sterling/ — the contract gate cannot evaluate scope; failing closed (P5).', {
        agentId: input.agent_id,
      })
    );

  const run = withRetry(() => store.getRun());
  const absolute = toolPath && (isAbsolute(String(toolPath)) || /^[A-Za-z]:/.test(String(toolPath)));
  const absPath = rel ? join(cwd, rel) : absolute ? String(toolPath) : undefined;
  const isCreation = absPath ? !existsSync(absPath) : false;

  if (run) {
    if (!rel) deny(`H3 [run mode]: '${toolPath}' is outside the repository — the run owns only the working tree; out of scope`);
    const brief = withRetry(() => store.get(run.brief_ref));
    if (!brief || brief.type !== 'brief')
      deny(
        environmentDefectDenial('H3', `Run '${run.id}' points at brief '${run.brief_ref}', which is not found in the store; failing closed (P5).`, {
          agentId: input.agent_id,
        })
      );
    const scope = scopeCheck({ brief, rel, amendments: (run.scope_amendments ?? []).map((a) => a.path) });
    if (scope.deny) deny(`H3 [run mode]: ${scope.deny}`);
    if (!isCreation && !hasFreshRead(ledgerPath(cwd, run.id, input.agent_id), rel, absPath)) {
      deny(evidenceDenial('run mode', ledgerPath(cwd, run.id, input.agent_id), rel));
    }
    allow();
  }

  // direct mode (+ debug-scope when a map is registered); file-touch registration is H7's job
  if (!rel) allow(); // outside the repo: the contract governs the repository
  const scope = scopeCheck({ debugScope: readDebugScope(cwd), rel });
  if (scope.deny) deny(`H3 [debug-scope mode]: ${scope.deny}`);
  if (!isCreation && !hasFreshRead(ledgerPath(cwd, undefined, input.agent_id), rel, absPath)) {
    deny(evidenceDenial('direct mode', ledgerPath(cwd, undefined, input.agent_id), rel));
  }
  allow();
} catch (e) {
  deny(
    environmentDefectDenial('H3', `Contract evaluation failed (${(e && e.message) || e}) — failing closed (P5).`, {
      agentId: input.agent_id,
    })
  );
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
