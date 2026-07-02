// Mid-run scope amendment — conductor-only CLI (brief mid-run-scope-amendment,
// decision 8e6f9491). Appends an exact repo-relative path to the run record so
// H3/H17/fs-move/fs-remove accept it as in-contract for the remainder of the run.
// NOT H14-allowlisted: agent Bash invocations are denied at the seam.
//
//   node scripts/amend-scope.mjs record --path <p> --reason <r> [--run <id>] [--target <dir>]
//   node scripts/amend-scope.mjs show [--run <id>] [--target <dir>]
import { normalizeRepoPath, matchesGlob } from '@sterling/schemas';
import { arg, fail, openProject } from './lib/project.mjs';
import { isEnforcementSurface } from './hooks/lib/contract.mjs';

// Terminal states (only reachable via explicit --run; getRun() auto excludes them).
const TERMINAL_STATES = new Set(['merged', 'rejected']);
// Glob metacharacters that make a path non-exact (repoPath does NOT reject these).
const GLOB_METACHARS = /[*?[\]{}]/;

const verb = process.argv[2];
const target = arg('--target') ?? process.cwd();
const runId = arg('--run');

if (verb === 'record') {
  const rawPath = arg('--path');
  const reason = arg('--reason');

  // (a) Usage failure: missing required args — always exit 1.
  if (!rawPath) {
    fail(
      'amend-scope: --path is required\n' +
        'usage: amend-scope.mjs record --path <p> --reason <r> [--run <id>] [--target <dir>]',
      1
    );
  }
  if (!reason) {
    fail(
      'amend-scope: --reason is required\n' +
        'usage: amend-scope.mjs record --path <p> --reason <r> [--run <id>] [--target <dir>]',
      1
    );
  }

  const { store } = openProject(target);

  // (b/c) Resolve the run. With --run: any state by id; without: active run only.
  let run;
  if (runId) {
    run = store.getRun(runId);
    if (!run) {
      store.close();
      fail(`amend-scope: no run '${runId}'`);
    }
    // (c) Terminal-state check (only reached via explicit --run; getRun() excludes terminals).
    if (TERMINAL_STATES.has(run.machine_state)) {
      store.close();
      fail(
        `amend-scope: run '${run.id}' is in terminal state '${run.machine_state}' — ` +
          `a merged or rejected run cannot be amended`
      );
    }
  } else {
    run = store.getRun();
    if (!run) {
      store.close();
      fail('amend-scope: no active run — record an amendment only during a live run');
    }
  }

  // (d) Glob-metachar check on the RAW path (before normalization — repoPath does not reject globs).
  if (GLOB_METACHARS.test(rawPath)) {
    store.close();
    fail(
      `amend-scope: '${rawPath}' contains glob metacharacters (*?[]{}); ` +
        `only exact repo-relative paths are accepted`
    );
  }

  // (d) Repo-path normalization: throws on absolute, drive-prefixed, parent-escaping paths.
  let rel;
  try {
    rel = normalizeRepoPath(rawPath);
  } catch (e) {
    store.close();
    fail(`amend-scope: non-exact or non-repo-relative path '${rawPath}' — ${e.message}`);
  }

  // (e) out_of_scope check — load brief and deny any path the brief explicitly gates out.
  const briefRecord = store.get(run.brief_ref);
  if (!briefRecord || briefRecord.type !== 'brief') {
    store.close();
    fail(`amend-scope: brief '${run.brief_ref}' not found for run '${run.id}'`);
  }
  const brief = /** @type {any} */ (briefRecord);
  for (const oos of brief.out_of_scope) {
    if (matchesGlob(rel, oos)) {
      store.close();
      fail(
        `amend-scope: '${rel}' matches the brief's out_of_scope glob '${oos}' — ` +
          `out_of_scope paths can never be amended in (crossing an explicit gate-time negative is a scope change)`
      );
    }
  }

  // (f) Enforcement-surface check — ENFORCEMENT_SURFACE globs + hooks/** are self-protection.
  if (isEnforcementSurface(rel) || matchesGlob(rel, 'hooks/**')) {
    store.close();
    fail(
      `amend-scope: '${rel}' is an enforcement-surface path — ` +
        `protected paths (self-protection, ENFORCEMENT_SURFACE ∪ hooks/**) cannot be amended in`
    );
  }

  // Idempotent-skip: if already amended, report (exit 0) without writing a duplicate.
  // The store primitive is idempotent-on-path; we detect membership here to give the
  // right output shape (already-amended vs amended).
  const existingAmendments = run.scope_amendments ?? [];
  const existing = existingAmendments.find((a) => a.path === rel);
  if (existing) {
    store.close();
    console.log(JSON.stringify({ 'already-amended': { path: rel, reason: existing.reason, at: existing.at } }));
    process.exit(0);
  }

  // Record the amendment and report it.
  const at = new Date().toISOString();
  store.appendRunScopeAmendment(run.id, { path: rel, reason, at });
  store.close();
  console.log(JSON.stringify({ amended: { path: rel, reason, at } }));
} else if (verb === 'show') {
  const { store } = openProject(target);
  const run = runId ? store.getRun(runId) : store.getRun();
  if (!run) {
    store.close();
    fail(runId ? `amend-scope: no run '${runId}'` : 'amend-scope: no active run');
  }
  const amendments = run.scope_amendments ?? [];
  store.close();
  console.log(JSON.stringify(amendments, null, 2));
} else {
  fail(
    'usage: amend-scope.mjs record --path <p> --reason <r> [--run <id>] [--target <dir>]\n' +
      '       amend-scope.mjs show [--run <id>] [--target <dir>]'
  );
}
