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

// THE INPUT BOUNDARY IS ITSELF A GATE (board 4a66ba58 — same F5 class as the
// fail-closed try below; anti_pattern e13f0fb5 owns the class). readStdin()
// reads fd 0 and JSON.parses it, both unguarded: called bare at the top level,
// a truncated or non-JSON stdin threw OUT of the hook, Node exited 1, and exit
// 1 is the platform's NON-BLOCKING code — the runner reads it as ALLOW and the
// Edit/Write runs UNEXAMINED. A gate that cannot read its own input has
// verified NOTHING and must fail CLOSED (P5). Reproduced against HEAD.
//
// EXPLICITLY ACCEPTED AVAILABILITY TRADEOFF (the same one H15 discloses, and
// it applies here in FULL): H3 is registered BOTH globally (hooks.json) and in
// agent frontmatter, so this denial reaches the CONDUCTOR's own Edit/Write
// too. A persistent runner/input fault therefore blocks the repair edits as
// well, and the session can wedge until restart. Accepted deliberately — under
// broken infrastructure the alternative is a contract gate that silently
// passes every edit it never read — but it is an availability cost, not a free
// win, and it is recorded here rather than discovered later.
//
// AND THE BLAST RADIUS IS THE WHOLE MACHINE, NOT "THIS PROJECT": this catch
// sits ABOVE the openStore probe below, because the project is unknowable
// before the input parses — so a broken runner denies Edit/Write in EVERY
// project the plugin is loaded into, not only Sterling ones. That ordering is
// forced (the probe needs `input.cwd`). It does not WIDEN H3's project reach —
// the existing `if (!store) deny(...)` branch already refuses in a project with
// no store — but stating this as "the conductor's own edits" would understate
// which sessions a runner fault can wedge.
//
// AUDIENCE IS UNKNOWABLE ON THIS PATH, which is why the wording carries BOTH
// resolutions: the field that names the audience (`agent_id`) rides in the very
// input that failed to parse. `agentId: undefined` selects the repair-facing
// instruction (correct for the conductor, who has no one above to escalate to)
// and the detail states the agent-facing half explicitly, so a spawned agent is
// never told to "let the conductor fix it" when it may BE the conductor reading.
let input;
try {
  input = readStdin();
  // NOT EVERY BAD PARSE THROWS (independent review, MEDIUM). `JSON.parse` on a
  // valid-but-non-object document returns a non-object WITHOUT throwing, so
  // wrapping the parse CALL does not by itself guarantee this gate holds an
  // object. This guard validates the RESULT.
  //
  // WHICH INPUTS ACTUALLY REACH IT — measured, not assumed (an earlier revision
  // of this comment claimed `null` reached here and it was WRONG; the test file's
  // AC6/AC7 now pin the real division):
  //   • `null` NEVER reaches this line. readStdin dereferences the parsed value
  //     itself — `projectRoot(input.cwd)` at lib/common.mjs:102 — so a null
  //     document throws INSIDE readStdin, and the catch below is what denies.
  //     That is a correct, already-fail-closed outcome; it simply is not this
  //     guard's doing, and this guard cannot be made to fire first without
  //     either editing the shared readStdin (out of this file's contract) or
  //     re-reading fd 0, which is impossible after readStdin has consumed it.
  //   • SCALARS DO reach it: `"x"`, `5`, `true` all survive readStdin untouched
  //     (`'x'.cwd` is undefined, not a throw; `projectRoot(undefined)` returns
  //     null on its own `!from` guard), arrive here as non-objects, and would
  //     otherwise flow into the derivations with every field silently
  //     undefined — a gate evaluating a contract against nothing. This guard is
  //     the only thing that stops that, and AC7 is its pin.
  // Throwing rather than denying inline is deliberate: it routes through the
  // SAME catch and the SAME both-audiences wording, so every "the gate never
  // saw its input" case reads identically to the reader.
  if (!input || typeof input !== 'object') {
    throw new TypeError(`hook input parsed to ${input === null ? 'null' : typeof input}, not an object`);
  }
} catch (e) {
  deny(
    environmentDefectDenial(
      'H3',
      `[stdin] hook input could not be read or parsed (${(e && e.message) || e}) — a gate that cannot read its own input has verified nothing, so it fails CLOSED (P5). ` +
        `An uncaught throw here would exit non-2, which the hook runner treats as NON-BLOCKING (the edit would be ALLOWED unexamined). ` +
        `IF YOU ARE A SPAWNED AGENT: do not diagnose, repair, or retry H3 yourself — exit \`blocked\`, citing this message VERBATIM. Otherwise:`,
      { agentId: undefined }
    )
  );
}

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

// A BLOCKING gate that cannot verify must DENY, never void itself: an uncaught
// throw exits 1, which the platform treats as non-blocking (decision 2422e76a's
// fail-closed rule, applied here per audit finding 5/43). Busy throws retry;
// everything else denies in the catch below.
//
// THE BOUNDARY NOW OPENS BEFORE THE PATH DERIVATION AND THE SELF-PROTECTION
// BLOCK (board 4a66ba58 — H3 was the worst instance of the class, ~74 lines of
// executable statements sitting OUTSIDE it). What makes a statement dangerous
// is its POSITION, not the identity of the call: `repoRel`/`join` throw a
// TypeError on a non-string cwd, and `fileURLToPath`/`matchesGlob` can throw
// too — and every one of those throws exited 1, i.e. ALLOW. The block that
// makes `.claude/agents/**` and `settings*.json` un-editable was itself
// unprotected, so the self-protection could be voided by exactly the throw it
// exists to survive. Nothing was reordered: the statements keep their original
// sequence (derive → self-protect → store), so the self-protection still runs
// BEFORE the store probe and stays independent of store presence. A throw
// inside them now routes through this function's catch, which DENIES.
let store;
try {
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
  // `input?.agent_id`, NOT `input.agent_id`: a handler that throws while
  // building its denial is uncaught, and uncaught means exit 1 — NON-BLOCKING,
  // i.e. the fail-closed catch would fail OPEN. This is DEFENCE IN DEPTH, and
  // deliberately unfalsifiable by input today: the stdin boundary above now
  // guarantees a non-null object, so no hook input can reach this line with a
  // null `input`. It stays because the cost is one character and the failure it
  // prevents is silent — but do not mistake it for the guard that carries the
  // null-stdin verdict. That verdict is carried by the typeof check above, and
  // the test file records exactly that division.
  deny(
    environmentDefectDenial('H3', `Contract evaluation failed (${(e && e.message) || e}) — failing closed (P5).`, {
      agentId: input?.agent_id,
    })
  );
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
