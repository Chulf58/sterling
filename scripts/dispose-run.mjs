// dispose-run [S] (spec §6 H9, CLAUDE.md invariant 6): THE gate — the only
// path to deleting runs/<id>/. It re-verifies every promotion condition
// against the store and REFUSES otherwise, exit non-zero naming every unmet
// condition. Bad disposal is impossible, not detected — this holds even if
// every hook is broken.
//
// On success (order is load-bearing):
//   1. fold summaries (knowledge_pack facts + check_skipped) — the only
//      survivors of disposal (§3.7),
//   2. snapshot the touched store to the configured backup path (§2.3) BEFORE
//      anything is deleted,
//   3. dispose run-scoped SQLite rows (handoffs, check_skipped) + advance
//      completing → awaiting_merge_gate via CAS (one transaction),
//   4. delete runs/<id>/ (reads ledgers, fills, knowledge_packs die with it).
//
//   node scripts/dispose-run.mjs --run <id> [--target <dir>]
//
// --abort: sanctioned teardown of a run blocked BEFORE green (cannot reach the
// merge gate). Promotion is NOT verified and NOTHING is snapshotted/promoted —
// the run is abandoned and its branch commits are discarded. Durable knowledge
// captured during the run already lives in the project store and is untouched;
// abort only tears down the run's transient state + branch. The --abort flag IS
// the confirmation (no interactive prompt, P1). Drives running/halted/… →
// 'rejected' (CAS on the observed state), discards the run branch, removes
// runs/<id>/. The normal (no --abort) path is unchanged.
//   node scripts/dispose-run.mjs --abort [--run <id>] [--target <dir>]
import { readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SterlingStore, resolveDomainMounts } from '@sterling/store';
import { REVIEWER_ROLES } from '@sterling/schemas';
import { arg, fail, openProject, runDir } from './lib/project.mjs';
import { backupPathForRuntime } from './lib/wsl-path.mjs';
import { verifyPromotionConditions } from './lib/promotion.mjs';
import { isGitRepo, discardRun } from './lib/branch-manager.mjs';

const abort = process.argv.slice(2).includes('--abort');
const target = arg('--target') ?? process.cwd();
const { cwd, store, config } = openProject(target);
const requestedRun = arg('--run');
const runId = requestedRun ?? store.getRun()?.id;
const run = runId ? store.getRun(runId) : undefined;
if (!run) {
  store.close();
  fail(
    requestedRun
      ? `dispose-run REFUSED: no_active_run — no run '${requestedRun}' found — there is no run to dispose`
      : 'dispose-run REFUSED: no_active_run — there is no run to dispose'
  );
}

// ---- --abort: sanctioned pre-green teardown (no promotion, no snapshot) ----
if (abort) {
  if (run.machine_state === 'merged' || run.machine_state === 'rejected') {
    store.close();
    fail(`dispose-run --abort REFUSED: run '${run.id}' is already terminal ('${run.machine_state}') — nothing to abort`);
  }
  // LOUD summary BEFORE acting — an accidental abort must be obvious.
  console.error(`dispose-run --abort: tearing down run '${run.id}' (NO promotion, NO snapshot)`);
  console.error(`  machine_state : ${run.machine_state}`);
  console.error(`  base_branch   : ${run.base_branch ?? '(none recorded)'}`);
  console.error(`  run branch    : ${run.branch}`);
  console.error(`  phases        : ${run.phases.map((p) => `${p.id}=${p.status}`).join(', ') || '(none)'}`);
  console.error(`  escalations   : ${run.escalations.length}`);
  for (const e of run.escalations) console.error(`    - ${JSON.stringify(e)}`);

  // (1) brain → 'rejected', merge-safe CAS on the observed current state (§5.2):
  // the mutate fn applies to the FRESH body so a concurrent hook write (H6/H8
  // escalation, H7 reconcile mark) survives on the surviving audit-trail record
  // (the 1/43+18/43 stale-rewrite class — R2 board ab9e8d98). 'rejected' is
  // non-active, so getRun() (no id) stops returning it.
  store.casTransitionMerge(run.machine_state, run.id, (fresh) => ({ ...fresh, machine_state: 'rejected' }));

  // (2) discard the run branch (checkout base + delete branch) — exactly as the
  // merge-gate reject path. Non-git / no base branch degrades LOUD, never crashes.
  let branchNote;
  if (isGitRepo(target) && run.base_branch) {
    branchNote = discardRun({ cwd, store, runId: run.id });
  } else {
    const reason = run.base_branch ? 'no_git' : 'no_base_branch';
    store.recordCheckSkipped('branch-discard', reason, run.id, new Date().toISOString());
    branchNote = { skipped: 'branch-discard', reason };
  }

  // (3) remove runs/<id>/ (the same teardown the normal path does).
  const dir = runDir(cwd, run.id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  // (4) purge the run's SQLite transients (P4 — the abort event ends the run's
  // life, so its handoff/check_skipped rows go with it; previously only
  // disposeRunRows deleted them and it refuses non-'completing' runs, so every
  // aborted run leaked its rows forever — R2 board 82f04007). The branch-discard
  // note above is already printed loudly; the run record itself persists.
  store.purgeRunRows(run.id);
  store.close();

  console.log(JSON.stringify({ run_id: run.id, aborted: true, machine_state: 'rejected', branch: branchNote }));
  process.exit(0);
}

// One definition of the promotion conditions, shared with the H9 backstop.
const { refusals } = verifyPromotionConditions({ store, config, run });

if (refusals.length) {
  store.close();
  fail(`dispose-run REFUSED (nothing was deleted):\n  ${refusals.join('\n  ')}`);
}

// Unbuilt promotion conditions are skipped LOUDLY at the point they would run
// (§16.1.9). Recorded ONLY after the refusal gate passes (audit finding 35/43):
// a refused attempt never reaches the point these checks "would have run", so
// recording them first inflated the surviving summary counts on retries.
const now = new Date().toISOString();
store.recordCheckSkipped('objection-triage', 'not_built', run.id, now);
store.recordCheckSkipped('mutation-survivors-to-known-gaps', 'not_built', run.id, now);

// ---- promotion verified; summaries → snapshot → rows → directory ----

const dir = runDir(cwd, run.id);
const packs = [];
if (existsSync(dir)) {
  for (const f of readdirSync(dir).filter((f) => f.startsWith('knowledge_pack-') && f.endsWith('.json'))) {
    const pack = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    packs.push({
      phase_id: pack.phase_id,
      consumer_role: pack.consumer_role,
      returned: pack.returned_record_ids.length,
      cap_omissions: pack.cap_omissions,
      mandatory: pack.mandatory,
    });
  }
}
const skipCounts = new Map();
for (const s of store.listCheckSkipped(run.id)) {
  // JSON tuple key: self-documenting and text-safe. The previous separator was a
  // literal NUL byte - correct at runtime (no reason can contain NUL), but it
  // made this file BINARY to git and rendered invisibly as a space to every
  // reader and tool (R2 board 88150540).
  const key = JSON.stringify([s.check_name, s.reason]);
  skipCounts.set(key, (skipCounts.get(key) ?? 0) + 1);
}
const checkSkippedSummary = [...skipCounts.entries()].map(([key, count]) => {
  const [check_name, reason] = JSON.parse(key);
  return { check_name, reason, count };
});

// Undispositioned-mandatory fold (decision 628c4b7f (c)) — the disposal backstop
// for the free-string agent_role hole the handoffWrite wire cannot fully close.
// Computed BEFORE disposeRunRows deletes the handoff rows (P4 ordering): the
// per-phase review_mandatory ids minus the ids dispositioned across the run's
// handoffs whose agent_role is an EXACT REVIEWER_ROLES member. A wrong role
// string (out-of-band bypass) never credits coverage. Folded into the surviving
// summaries; merge-gate prints it (the wire can be fooled, the gate cannot).
const dispositionedIds = new Set();
for (const h of store.readHandoffs(run.id)) {
  if (!REVIEWER_ROLES.has(h.agent_role)) continue;
  for (const d of h.dispositions ?? []) dispositionedIds.add(d.record_id);
}
const undispositionedMandatory = (run.review_mandatory ?? [])
  .filter((m) => !dispositionedIds.has(m.record_id))
  .map((m) => ({ phase_id: m.phase_id, record_id: m.record_id, reason: m.reason }));

let snapshotPath;
const domainSnapshots = [];
if (config.backup_path) {
  // relative backup paths resolve against the project, never the caller's cwd;
  // backupPathForRuntime first rewrites a Windows drive path (a legacy config
  // recorded under native Windows) to /mnt form under WSL, so it resolves to the
  // real backup location instead of a junk 'C:/...' dir inside the repo (r-dd88).
  const backupDir = resolve(cwd, backupPathForRuntime(config.backup_path));
  const stamp = Date.now();
  snapshotPath = join(backupDir, `sterling-${run.id}-${stamp}.db`).replace(/\\/g, '/');
  store.snapshot(snapshotPath);
  // §2.3: the knowledge base is the product — every store the run could have
  // written, the project store AND each mounted domain store, snapshots before
  // anything is deleted. The mount manifest is the project's stack_tags (§3.3,
  // resolveDomainMounts — the same resolver the MCP server uses, so the
  // snapshotted set matches the mounted set). Snapshot each that exists —
  // disposal is not a mount, so never create one here.
  for (const { name, dbPath } of resolveDomainMounts(config)) {
    if (!existsSync(dbPath)) continue;
    const ds = new SterlingStore(dbPath);
    const domainPath = join(backupDir, `sterling-domain-${name}-${run.id}-${stamp}.db`).replace(/\\/g, '/');
    try {
      ds.snapshot(domainPath);
    } finally {
      ds.close();
    }
    domainSnapshots.push(domainPath);
  }
} else {
  // recorded opt-out (§2.3): the skip is loud, never silent
  snapshotPath = '(backup opted out)';
  store.recordCheckSkipped('backup-snapshot', 'opted_out', run.id, now);
  checkSkippedSummary.push({ check_name: 'backup-snapshot', reason: 'opted_out', count: 1 });
}

store.disposeRunRows(run.id, {
  check_skipped: checkSkippedSummary,
  knowledge_packs: packs,
  undispositioned_mandatory: undispositionedMandatory,
  snapshot_path: snapshotPath,
});
if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
store.close();

console.log(
  JSON.stringify({
    disposed: run.id,
    machine_state: 'awaiting_merge_gate',
    snapshot: snapshotPath,
    domain_snapshots: domainSnapshots,
    check_skipped: checkSkippedSummary,
    knowledge_packs: packs.length,
    undispositioned_mandatory: undispositionedMandatory.length,
  })
);
