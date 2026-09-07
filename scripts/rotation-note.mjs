// rotation-note.mjs — write the single-slot ROTATION NOTE (context-rotation slice 3,
// no-capture.mjs precedent: a small sanctioned CLI for a conductor-declared transient).
//
// The note carries ONLY what a fresh session cannot reconstruct from the store, the
// board, or git: the exact next slice, in-flight risks, and pointers. Everything else
// (decisions, remaining work, validation state) already lives in durable surfaces —
// a fat note is a capture-duty failure upstream, not a reason to widen this schema.
//
// Lifecycle (P4): single slot at .sterling/transient/rotation-note.json — a rewrite
// supersedes; H1 CONSUMES it on SessionStart source=clear (single-shot injection).
// Anchored to git HEAD + branch at write time so the restore can disclose drift.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { classifyRegister } from './lib/dispatch-register.mjs';
import { readLock } from './hooks/lib/plan-lock.mjs';
import { arg as sharedArg, fail as sharedFail } from './lib/project.mjs';
import { resolveStoreWritePath } from './lib/store-path.mjs';

// Local wrappers preserve this script's existing exit code (2) and message
// prefix while delegating all real parsing to the ONE shared, exact-token
// parser (decision sanctioned-script-store-writes-one-containment-helper-one-
// arg-parser, R5) — both spellings, duplicate refusal, flag-as-value refusal.
function arg(name) {
  try {
    return sharedArg(`--${name}`) ?? null;
  } catch (e) {
    fail(e.message);
  }
}

function fail(msg) {
  sharedFail(`rotation-note: ${msg}`, 2);
}

const cwd = process.cwd();
// CONTAINMENT (decision sanctioned-script-store-writes-one-containment-helper-
// one-arg-parser, R5): even this existence probe derives its path through the
// helper, so a symlinked `.sterling` is refused here rather than followed.
let sterlingDirForCheck;
try {
  sterlingDirForCheck = resolveStoreWritePath(cwd, '.sterling');
} catch (e) {
  fail(e.message);
}
if (!existsSync(sterlingDirForCheck)) {
  fail(`${cwd} is not a Sterling project (.sterling/ missing) — run from the project root`);
}

const nextSlice = (arg('next-slice') ?? '').trim();
if (!nextSlice) {
  fail('--next-slice "<the exact next execution slice>" is required and must be non-empty — a note without a next slice restores nothing actionable');
}

// --reason=code-reload (board d5942fa0, fix candidate d): an OPTIONAL, explicit
// flag for the one case the rotation mechanism cannot serve on its own — a
// rotation that requires a code reload (migration, update, rebuild) BEFORE the
// /clear that consumes this note. H1's source=clear gate is deliberate and
// unchanged (a note prepared for a rotation that hasn't happened must survive
// an unrelated restart) — this flag only sharpens the wording, additive to the
// unconditional guidance already printed/injected below. Validated against the
// one supported value rather than accepted as free text: a typo'd reason would
// otherwise silently fail to trigger the sequence it exists to state (P5).
const reasonArg = arg('reason');
if (reasonArg !== null && reasonArg !== 'code-reload') {
  fail(`--reason '${reasonArg}' is not recognized — the only supported value is 'code-reload' (flags that a server/hook code reload is required before the next slice can proceed)`);
}
const reason = reasonArg; // null, or 'code-reload'

const git = (args) => {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000 });
    return r.status === 0 ? (r.stdout ?? '').trim() : null;
  } catch {
    return null;
  }
};

// BASE BRANCH (N15 + Codex P1-B): mirrors scripts/lib/branch-manager.mjs's
// defaultBranch() resolution order (origin/HEAD symbolic ref, else main,
// else master) rather than importing it, so a base that cannot be
// determined here degrades to "commits_ahead unavailable" instead of
// throwing and refusing the whole note write — the note's other fields are
// still worth saving. TWO CAVEATS this resolution does NOT fix, closed
// instead by the explicit override below: (1) it names the REPO's default
// branch, not the current branch's actual fork point — a feature branch cut
// from a non-default base (e.g. off `release`) mis-counts against `main`;
// (2) origin/HEAD names the REPO default only as a REMOTE-TRACKING ref —
// unconditionally stripping the `origin/` prefix can produce a bare local
// name (`main`) that does not exist as a local branch in a plain clone,
// silently turning `main..HEAD` into a git error and commits_ahead into a
// false null. --base/--into names the ref to diff against directly,
// bypassing resolution entirely — pass it whenever the branch's real base
// differs from the repo default.
function resolveBaseBranch() {
  const explicit = arg('base') ?? arg('into');
  if (explicit) return explicit;
  const sym = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']); // e.g. 'origin/main'
  if (sym) {
    const local = sym.replace(/^origin\//, '');
    // Prefer the identically-named LOCAL branch when it exists (matches
    // what direct-merge.mjs would actually merge into), but when it does
    // NOT — a plain clone with no local `main`, only `origin/main` — use
    // the remote-tracking ref directly rather than stripping it to a name
    // that fails to resolve.
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${local}`])) return local;
    return sym;
  }
  for (const b of ['main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) return b;
  }
  return null;
}

const baseBranch = resolveBaseBranch();
// COUNTS RECOMPUTE, NEVER GET TYPED (N15, docs/feedback/sterling-plugin-*
// 2026-08-24*): the prose fields (objective/risks/pointers) are free text a
// conductor can misstate ("FOURTEEN commits" when the real count was 39) —
// stamping the actual number at write time, the same way head_sha is
// stamped rather than described, gives H1 something it can mechanically
// verify against reality at restore time instead of trusting the prose.
const commitsAheadRaw = baseBranch ? git(['rev-list', '--count', `${baseBranch}..HEAD`]) : null;
const commitsAhead = commitsAheadRaw !== null && /^\d+$/.test(commitsAheadRaw) ? Number(commitsAheadRaw) : null;

// LIVE DISPATCHES (board efbddf09; R1 tri-state re-cut): a subagent dispatched
// before the /clear keeps running across it — the register is the only
// mechanical record of that, and the note is the only thing the fresh session
// reads. Without it a coder still writing files is invisible and a second one
// gets dispatched at the same slice (measured 2026-09-04, ~330k subagent
// tokens wasted). Liveness is now TRI-STATE (decision review-receipt-rebuild-
// invariant-three-owner-modules-tri-state-liveness-receipt-bound-
// supersession): presumed-active entries are LIVE, an out-of-lease entry is
// UNCERTAIN (carried, never silently dropped, never counted as live),
// inactive-confirmed (Stop already marked it ended) is ignored entirely. This
// CLI has NO stdin session_id to join on — it calls the ONE owner classifier
// with ctx.sessionId: null, the NO-SESSION-JOIN mode (lease half only; an
// entry is never 'other-session' in this mode), exactly the reading this
// file has always documented ("H10 fires session_id AND TTL; a session-less
// CLI can only apply the TTL half"). Two negatives stay distinct: a
// readable-and-empty register is CONFIRMED-ZERO ([]), an unreadable/absent
// one is UNKNOWN (null) — a silent [] there would be a false all-clear, the
// exact failure this closes.
function readStaleMinutes() {
  try {
    const cfgPath = resolveStoreWritePath(cwd, '.sterling', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const v = cfg?.dispatch_register?.stale_minutes;
    return typeof v === 'number' && v > 0 ? v : 60;
  } catch {
    return 60;
  }
}

const classified = classifyRegister(cwd, { now: Date.now(), sessionId: null, staleMinutes: readStaleMinutes() });
let liveDispatches = null;
let uncertainDispatches = null;
if (classified.availability === 'ok') {
  const toEntry = (row) => ({
    agent_type: row.entry?.agent_type ?? null,
    agent_id: row.entry?.agent_id ?? null,
    territory: Array.isArray(row.entry?.files) ? row.entry.files : [],
  });
  liveDispatches = classified.entries.filter((r) => r.status === 'presumed-active').map(toEntry);
  uncertainDispatches = classified.entries.filter((r) => r.status === 'unknown').map((r) => ({ ...toEntry(r), reason: r.reason ?? null }));
}

// PLAN PATH (decision `plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry`):
// EXACTLY ONE new field, and no flag — the note copies the live lock's
// plan_path at write time so a fresh session's restore can point at the plan
// that governs the next slice. Title and status are deliberately NOT duplicated:
// they are reconstructable from the lock, and the note's contract stays thin.
// null is written EXPLICITLY when there is no lock (or it cannot be read) —
// absent and "no plan" must not be the same shape to a reader.
// Read through the SHARED validating reader — the same one H31, H1, H19 and
// the plan-lock CLI use — so this file holds no second idea of what a lock is.
// plan_path is copied ONLY from a VALID lock; absent, malformed or unreadable
// all yield null, because a note pointing at a plan the lock cannot vouch for
// is worse than a note with no plan.
const planPath = (() => {
  try {
    const read = readLock(resolveStoreWritePath(cwd, '.sterling'));
    return read.lock ? read.lock.plan_path : null;
  } catch {
    return null; // a broken lock costs this field, never the note
  }
})();

const note = {
  plan_path: planPath,
  next_slice: nextSlice,
  objective: (arg('objective') ?? '').trim() || null,
  risks: (arg('risks') ?? '').trim() || null,
  pointers: (arg('pointers') ?? '').trim() || null,
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  head_sha: git(['rev-parse', 'HEAD']),
  base_branch: baseBranch,
  commits_ahead: commitsAhead,
  live_dispatches: liveDispatches,
  uncertain_dispatches: uncertainDispatches,
  reason,
  at: new Date().toISOString(),
};

// CONTAINMENT (decision sanctioned-script-store-writes-one-containment-helper-
// one-arg-parser, R5): refuses a symlink component beneath cwd on the way to
// the note, naming both resolved paths, before anything is written.
let notePath;
try {
  notePath = resolveStoreWritePath(cwd, '.sterling', 'transient', 'rotation-note.json');
} catch (e) {
  fail(e.message);
}
mkdirSync(dirname(notePath), { recursive: true });
writeFileSync(notePath, JSON.stringify(note, null, 2) + '\n');
process.stdout.write(
  `rotation note written (single slot — this supersedes any prior note).\n` +
    `next_slice: ${note.next_slice}\n` +
    (note.branch ? `anchored: ${note.branch} @ ${note.head_sha?.slice(0, 8) ?? '?'}\n` : 'anchored: no git (drift disclosure unavailable)\n') +
    (note.commits_ahead !== null
      ? `commits_ahead: ${note.commits_ahead} (vs ${note.base_branch})\n`
      : 'commits_ahead: unavailable (no origin/HEAD, main, or master to diff against — pass --into to a future version if this recurs)\n') +
    // Silent when the set is a confirmed zero (P1 — nothing to check).
    (liveDispatches === null
      ? 'live_dispatches: UNKNOWN — the dispatch register exists but could not be read; check ListAgents before re-dispatching\n'
      : liveDispatches.length
        ? `live_dispatches: ${liveDispatches.length} (${liveDispatches.map((d) => `${d.agent_type ?? 'agent'}:${d.agent_id ?? '?'}`).join(', ')}) — still running across the /clear\n`
        : '') +
    (uncertainDispatches && uncertainDispatches.length
      ? `uncertain_dispatches: ${uncertainDispatches.length} (${uncertainDispatches.map((d) => `${d.agent_type ?? 'agent'}:${d.agent_id ?? '?'}`).join(', ')}) — lease expired, not confirmed dead; settle with ListAgents\n`
      : '') +
    (note.reason === 'code-reload'
      ? `CODE RELOAD REQUIRED (--reason=code-reload) — /clear alone will NOT load it (MCP servers survive it). The sequence is:\n` +
        `  1. exit and relaunch the Claude Code CLI now\n` +
        `  2. THEN /clear — H1 restores and consumes this note automatically\n`
      : `Tell the user READY TO CLEAR — on /clear, H1 restores and consumes this note automatically.\n` +
        `If server/hook CODE changed since this session started (migration, update, rebuild), /clear alone will not reload it — EXIT AND RELAUNCH the Claude Code CLI first, THEN /clear.\n`)
);
