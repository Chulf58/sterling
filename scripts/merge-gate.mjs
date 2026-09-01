// Merge gate [S] (spec §8.1 spine slice): the second of the two human gates.
// Without --decision: print the gate summary (state, escalations, every
// check_skipped — a wrong skip is auditable, never silent). With --decision:
// record the human's call via CAS. Branch operations are the §16.2 branch
// manager — skipped loudly here.
//   node scripts/merge-gate.mjs --run <id> [--decision merge|reject] [--target <dir>]
import { spawnSync } from 'node:child_process';
import { arg, fail, openProject, requireRun } from './lib/project.mjs';
import { isGitRepo, mergeRun, discardRun, branchExists } from './lib/branch-manager.mjs';
import { stateRefusal } from './lib/run-state.mjs';
// Attestation disclosure (decision attestation-staleness-disclosure-only-never-
// a-refusing-gate, 1f069af4 v2) — the SAME read-only inspector commit-reviewed
// and direct-merge use; see attestationDisclosure() below.
import { inspectAttestations, readAttestationGlobs, attestationDisclosureLines, parseNulPathList } from './lib/attestation-inspection.mjs';

const target = arg('--target') ?? process.cwd();
const { store } = openProject(target);
const run = requireRun(store, arg('--run'));
const decision = arg('--decision');

if (run.machine_state !== 'awaiting_merge_gate') {
  store.close();
  // The old trailing clause — "the gate opens after disposal" — is true only for
  // 'completing'. Told to a run already 'merged', it sent the operator to run
  // disposal on a merged run, which dispose-run then refuses from the other side:
  // a full round trip caused by the message rather than by the state.
  fail(
    `merge-gate: ${stateRefusal({
      runId: run.id,
      observed: run.machine_state,
      expected: 'awaiting_merge_gate',
      why: 'The gate opens once disposal has advanced the run (H9).',
    })}`
  );
}

const summary = {
  run_id: run.id,
  branch: run.branch,
  phases: run.phases.map((p) => ({ id: p.id, status: p.status, signals: p.signals.length })),
  escalations: run.escalations,
  check_skipped: run.summaries?.check_skipped ?? [],
  scope_amendments: run.scope_amendments ?? [],
  // Disposal backstop surfaced at the gate (decision 628c4b7f (c)): the
  // undispositioned reviewer-mandatory remainder the disposal fold left on the
  // run summaries (P5 — the wire can be fooled, the gate cannot).
  undispositioned_mandatory: run.summaries?.undispositioned_mandatory ?? [],
  summaries: run.summaries ?? null,
};

// ===========================================================================
// ATTESTATION DISCLOSURE (decision attestation-staleness-disclosure-only-never-
// a-refusing-gate, 1f069af4 v2; board attestation-gate 9868a0dd).
//
// The §8.1 counterpart of direct-merge's block: for each declared attestation
// path glob this RUN BRANCH touches, how many of those paths have a comparable
// human inspection record. ADVISORY ONLY — it can never refuse a merge, and it
// is fail-open end to end; the refusing form of this feature was declined
// (a gate the conductor must pass makes the conductor the attestation trigger,
// hollowing decision a7dbac2f).
//
// THE DIFF IS THE RUN BRANCH AGAINST ITS MERGE BASE, NEVER BARE HEAD (§4 of the
// decision, explicit). At this gate HEAD is wherever the operator happens to
// stand — often the base branch already — so a HEAD-relative diff would report
// either nothing or somebody else's work, and a disclosure that names the wrong
// files is worse than no disclosure at all. Anything that prevents that exact
// comparison (no git, no base branch, a vanished branch) degrades to ONE
// disclosed line rather than a silently empty result.
//
// THE GLOBS COME FROM readAttestationGlobs, NEVER FROM openProject's PARSED
// CONFIG (Codex review HIGH-1, 2026-09-01): openProject/parseConfig runs at the
// top of this file, outside this fail-open wrapper, so any validation of this
// advisory field there would terminate the gate command outright. The schema is
// unrefined; the tolerant read drops unusable entries and DISCLOSES the drop.
// ===========================================================================
function attestationDisclosure() {
  try {
    const { globs: declaredGlobs, dropped } = readAttestationGlobs(target);
    const hasDrop = dropped.invalid_container || dropped.non_string > 0 || dropped.empty > 0 || dropped.duplicates.length > 0;
    if (declaredGlobs.length === 0 && !hasDrop) return []; // DORMANT (shipped default) — no store read, no diff, no output
    if (!isGitRepo(target) || !run.base_branch || !run.branch) {
      throw new Error(`cannot diff the run branch against its merge base (git=${isGitRepo(target)}, branch=${run.branch ?? '<none>'}, base=${run.base_branch ?? '<none>'})`);
    }
    const git = (args) => {
      const r = spawnSync('git', args, { cwd: target, encoding: 'utf8', timeout: 60_000 });
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${(r.stderr || '').trim()}`);
      return r.stdout ?? '';
    };
    const mergeBase = git(['merge-base', run.base_branch, run.branch]).trim();
    // --no-renames + -z, identically to every other surface: an attestation
    // names the path a human inspected, so a rename must surface as a gone path
    // rather than follow silently to its destination.
    const touchedPaths = parseNulPathList(
      git(['-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-only', '-z', '--end-of-options', mergeBase, run.branch])
    );
    const result = inspectAttestations({ projectRoot: target, touchedPaths, declaredGlobs });
    return attestationDisclosureLines({ tool: 'merge-gate', result, declaredGlobs, subject: 'the branch tree', dropped });
  } catch (e) {
    return [
      `merge-gate: ATTESTATION DISCLOSURE SKIPPED — the disclosure computation itself threw (${e?.message ?? e}). Disclosed and NON-FATAL: ` +
        `the gate is unaffected, because this mechanism is advisory only and never a refusal.`,
    ];
  }
}

if (!decision) {
  // Store closed first purely for tidiness — the disclosure never touches this
  // handle. It opens its own read-only connection to the same live database,
  // which is safe alongside any other connection precisely because it manages no
  // WAL sidecar in either direction (see readOnlyProbe). Empty array on a dormant
  // project (the shipped default); never omitted, so an absent key means an older
  // CLI rather than nothing to disclose.
  store.close();
  summary.attestation_disclosure = attestationDisclosure();
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}
if (decision !== 'merge' && decision !== 'reject') {
  store.close();
  fail(`merge-gate: --decision must be 'merge' or 'reject' — received '${decision}'`);
}

// RECOMPUTED AT THE DECISION, not reused from a summary printed minutes or hours
// ago (decision 1f069af4 v2 §6): the branch can have moved since, and a stale
// disclosure at the moment of merging is exactly the wrong direction for a
// mechanism whose entire subject is what the store can and cannot prove. Printed
// BEFORE the branch operations below, so it reaches the human while the merge
// has not yet happened — after them the branch is gone and its diff with it.
if (decision === 'merge') {
  for (const line of attestationDisclosure()) console.error(line);
}

// Branch operations through the §8.1 branch manager; non-git projects degrade loud.
// A branch that is ALREADY GONE is skipped loudly instead of thrown on: the branch
// ops run before the CAS, so a CAS rejection after a successful merge/discard used
// to leave a retry that re-ran mergeRun on the deleted branch and could never pass
// the gate (R2 board e2069f68) — the retry is now idempotent.
let branchNote;
if (isGitRepo(target) && run.base_branch) {
  if (branchExists(target, run.branch)) {
    branchNote = decision === 'merge' ? mergeRun({ cwd: target, store, runId: run.id }) : discardRun({ cwd: target, store, runId: run.id });
  } else {
    console.error(`merge-gate: run branch '${run.branch}' no longer exists — branch ops already performed (wedged retry); proceeding to the state transition`);
    branchNote = { skipped: decision === 'merge' ? 'branch-merge' : 'branch-discard', reason: 'branch_already_absent' };
  }
} else {
  const check = decision === 'merge' ? 'branch-merge' : 'branch-discard';
  store.recordCheckSkipped(check, run.base_branch ? 'no_git' : 'no_base_branch', run.id, new Date().toISOString());
  branchNote = { skipped: check };
}
// Merge-safe transition (audit findings 1/43, 18/43): apply the state change onto
// the FRESH body so any concurrent write is preserved (consistency with the other
// transition seams; at the merge gate the run is post-disposal so races are
// unlikely, but the seam is uniform).
const targetState = decision === 'merge' ? 'merged' : 'rejected';
store.casTransitionMerge('awaiting_merge_gate', run.id, (fresh) => ({ ...fresh, machine_state: targetState }));
// The run is terminal — purge any row recorded AFTER disposal (e.g. the gate's
// own no_git/no_base_branch skip above), which otherwise outlives the run
// forever (P4, R2 board 82f04007). The skip is preserved in stdout + branchNote.
store.purgeRunRows(run.id);
store.close();
console.log(JSON.stringify({ run_id: run.id, decision, machine_state: targetState, branch: branchNote }));
