// scripts/git-ro.mjs — the read-only git wrapper. SPEC ONLY, red-first.
//
// SPEC: decision `git-ro-wrapper-fixed-recipes-no-caller-flags`
// (knowledge_get 1a7f3926-703a-471c-b33a-c3907bc9c3b3), read in full. Nothing
// below is derived from implementation: scripts/git-ro.mjs DOES NOT EXIST at
// authoring time, and this file was written blind to
// scripts/hooks/h14-bash-allowlist.mjs (H4 read wall).
//
// HARNESS SHAPE — why there are no temp git fixtures for the happy path.
// The decision pins the child cwd to the canonical project root and states the
// wrapper "refuses when its own cwd is not that root, canonical-path compare".
// The root is derived from the wrapper's own location, so a temp git repo can
// never be a legal cwd for a happy-path call. Therefore:
//   * HAPPY PATH  = HISTORY-ONLY, against THIS repo, cwd = the real project
//     root, using only revisions that always exist (HEAD, HEAD~1) and paths
//     that always exist (CLAUDE.md). Every verb in the decision is read-only,
//     so this touches nothing.
//   * CWD RULE    = spawn from a throwaway temp dir and require a refusal.
// A consequence worth stating: these tests read real repository history, so
// their INPUTS move as commits land. They are written to depend only on
// invariants of any non-empty history (HEAD exists, HEAD~1 exists, CLAUDE.md
// is tracked, the repo has >200 commits), never on a specific sha or subject.
//
// RED DISCIPLINE. Today `node scripts/git-ro.mjs ...` exits nonzero with
// ERR_MODULE_NOT_FOUND, which would make every REFUSAL test pass for the wrong
// reason — a crash-red that pins nothing. Two guards close that:
//   (1) every test opens with requireWrapper(), a plain assert.ok on the
//       wrapper's existence, which is the clean assertion_fail red today; and
//   (2) assertRefusal() rejects a stderr carrying an exception stack or a
//       module-resolution error, so "the wrapper crashed" can never satisfy a
//       refusal pin.
//
// CONTROL-ARM DISCIPLINE. Every refusal family has a control arm placed FIRST
// that must pass for the OPPOSITE reason (the same verb, well-formed,
// succeeding), so a green refusal always carries evidence that it was caused
// by the rule under test rather than by a wrapper that refuses everything.
//
// PER-TEST EXPECTED FAILURE SHAPE + NAMED SABOTAGE are inline, and repeated in
// the report.
//
// KNOWN COVERAGE GAPS (named, not faked — see the report):
//   * the 5MiB stdout overflow refusal (needs a >5MiB blob fixture we may not
//     create in this repo);
//   * the 30s timeout -> wrapper-owned code 124;
//   * the path-count / total-argv byte caps (the decision states the caps
//     exist but not their values — pinning a number would invent an interface);
//   * GIT_LITERAL_PATHSPECS=1 (its only cheap observable needs a glob-shaped
//     path argument, and the decision does not say whether the argv path
//     charset admits '*').

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync, existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const WRAPPER = join(root, 'scripts', 'git-ro.mjs');

// Assertion-shaped existence guard: the FIRST line of every test. Today this
// is the clean red; once the wrapper lands it becomes a no-op and the real
// pins below take over.
function requireWrapper() {
  assert.ok(
    existsSync(WRAPPER),
    'scripts/git-ro.mjs must exist — until it does, every assertion below is unreachable and a nonzero exit means "module not found", not "the wrapper refused"'
  );
}

function gitro(args, { cwd = root, extraEnv = null, env = null } = {}) {
  const childEnv = env ?? { ...process.env, ...(extraEnv ?? {}) };
  const r = spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    spawnError: r.error ?? null,
  };
}

const STACK_FRAME = /\n\s+at\s+\S+.*:\d+:\d+/;
const MODULE_MISSING = /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/;

// A refusal is: nonzero exit, NOTHING on stdout (a partial result with a
// refusal is the misleading shape the decision rejects), a stderr that NAMES
// the rule, and demonstrably not an uncaught exception.
function assertRefusal(r, rulePattern, label) {
  assert.equal(r.spawnError, null, `${label}: the wrapper process itself must start`);
  assert.notEqual(r.code, 0, `${label}: must refuse with a nonzero exit (got ${r.code}); stderr=${r.stderr}`);
  assert.equal(r.stdout, '', `${label}: a refusal emits NOTHING on stdout — a partial result beside a refusal is the actively-misleading shape the decision rejects`);
  assert.doesNotMatch(r.stderr, MODULE_MISSING, `${label}: the nonzero exit must be a deliberate refusal, not a missing/unresolvable module`);
  assert.doesNotMatch(r.stderr, STACK_FRAME, `${label}: the nonzero exit must be a deliberate refusal naming its rule, not an uncaught exception stack`);
  assert.match(r.stderr, rulePattern, `${label}: the refusal must NAME the rule it enforced; stderr=${r.stderr}`);
}

// Tolerant JSON accessor: the decision fixes that diff-names/log "emit JSON"
// but not the envelope, so a bare array and a {entries|commits|changes:[...]}
// wrapper are both accepted. The FIELDS of a diff-names entry (status, path)
// ARE pinned — see the diff-names tests.
function jsonArray(stdout, label) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    assert.fail(`${label}: stdout must be parseable JSON (the decision: diff-names/log "emit JSON" rather than NUL-delimited passthrough); parse error=${err.message}; stdout starts: ${JSON.stringify(stdout.slice(0, 200))}`);
  }
  if (Array.isArray(parsed)) return parsed;
  for (const key of ['entries', 'commits', 'changes', 'results', 'files']) {
    if (Array.isArray(parsed?.[key])) return parsed[key];
  }
  assert.fail(`${label}: the JSON must carry an array of records (bare array, or under entries/commits/changes/results/files); got keys=${JSON.stringify(Object.keys(parsed ?? {}))}`);
}

// (retired raw-ESC regex literal, replaced by the char-code form below)/\[/;

// Truncation-disclosure accessor for the `log` envelope. The decision fixes
// that log "emits JSON" and is BOUNDED to a recipe cap, but does NOT fix the
// envelope shape, so disclosure is read TOLERANTLY: an own field whose KEY
// matches /truncat/i with a truthy value discloses truncation; OR a shown/total
// -style pair of numbers where shown < total. A bare array — or an envelope
// carrying neither signal — is "not disclosed", which is exactly the shape the
// truncation pin below must catch when the true result IS truncated.
function truncationMarker(parsed) {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { disclosed: false, flag: false, shown: null, total: null };
  }
  let flag = false;
  for (const [k, v] of Object.entries(parsed)) {
    if (/truncat/i.test(k) && v) flag = true;
  }
  const pick = (patterns) => {
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && patterns.some((p) => p.test(k))) return v;
    }
    return null;
  };
  const shown = pick([/^shown$/i, /returned/i, /^count$/i, /^n$/i]);
  const total = pick([/^total$/i, /matched/i, /available$/i, /^full$/i]);
  const pairDiscloses = shown != null && total != null && shown < total;
  return { disclosed: flag || pairDiscloses, flag, shown, total };
}

// ANSI escape detector, built from a char code rather than a raw ESC byte in a
// regex literal: an editor that strips the raw byte would silently degrade the
// pattern to /\[/, which matches ordinary JSON output and would fail these
// tests for a reason that has nothing to do with --no-color.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`);

// The raw ESC (0x1b) byte itself, built from a char code so no literal control
// byte lives in source (an editor round-trip would strip it silently). Used by
// the refusal-sanitization family below.
const ESC = String.fromCharCode(27);

// NOTE: there is deliberately NO top-level `before` existence check. A failing
// before-hook collapses the whole file into one failure and hides the per-test
// expected failure shapes the red gate is read against; requireWrapper() gives
// every test its own clean assertion_fail instead.

// ===========================================================================
// FAMILY 1 — CONTROLS. Every verb, well-formed, against real history.
// These run FIRST: every refusal pin below is only evidence of a RULE firing
// if the same verb demonstrably succeeds when the rule is satisfied.
// ===========================================================================

test('git-ro CONTROL log: `log` with no rev exits 0, emits JSON (never NUL-delimited passthrough), and is BOUNDED to the recipe cap of 200', () => {
  requireWrapper();
  const r = gitro(['log']);
  assert.equal(r.code, 0, `log with no rev must succeed; stderr=${r.stderr}`);

  // NAMED SABOTAGE (JSON): delete the internal -z parse + JSON.stringify and
  // pass git's output through raw — flips the JSON.parse assertion red.
  const entries = jsonArray(r.stdout, 'log');
  assert.ok(entries.length > 0, 'a repo with history yields at least one log entry');
  assert.doesNotMatch(r.stdout, /\0/, 'the wrapper parses -z internally; a NUL byte on stdout means raw passthrough leaked out');

  // NAMED SABOTAGE (bound): drop `-n 200` from the log recipe — this repo has
  // far more than 200 commits, so entries.length blows past the cap and this
  // assertion goes red. (Assumption stated in the report: >200 commits.)
  assert.ok(
    entries.length <= 200,
    `the log recipe is fixed at -n 200; got ${entries.length} entries, which means the caller-invisible bound is gone`
  );

  // NAMED SABOTAGE (color): drop `--no-color` — an ANSI escape appears in the
  // serialized output and this goes red.
  assert.doesNotMatch(r.stdout, ANSI, 'the log recipe pins --no-color; no ANSI escapes may reach stdout');
});

test('git-ro CONTROL show: `show HEAD` exits 0 and emits real patch text for the commit', (t) => {
  requireWrapper();
  const r = gitro(['show', 'HEAD']);
  assert.equal(r.code, 0, `show HEAD must succeed; stderr=${r.stderr}`);
  assert.match(r.stdout, /^commit [0-9a-f]{7,40}/m, 'show emits git commit text, headed by the resolved commit');
  assert.doesNotMatch(r.stdout, ANSI, 'the show recipe pins --no-color');

  // A merge commit legitimately shows no patch body under plain `git show`;
  // the patch assertion is skipped in that case rather than pinned falsely.
  if (/^Merge: /m.test(r.stdout)) {
    t.diagnostic('HEAD is a merge commit — the patch-body assertion is skipped for this run');
  } else {
    // NAMED SABOTAGE: make `show` an alias of the show-stat recipe (add
    // --no-patch) — the patch body disappears and this goes red.
    assert.match(r.stdout, /^diff --git /m, 'show of a non-merge commit carries the patch body — this is the verb that restores content');
  }
});

test('git-ro CONTROL show-stat: `show-stat HEAD` exits 0, emits the stat, and carries NO patch body', () => {
  requireWrapper();
  const r = gitro(['show-stat', 'HEAD']);
  assert.equal(r.code, 0, `show-stat HEAD must succeed; stderr=${r.stderr}`);
  assert.match(r.stdout, /^commit [0-9a-f]{7,40}/m, 'show-stat still identifies the commit');
  assert.match(r.stdout, /\|\s+\d+|files? changed/, 'show-stat emits a diffstat');

  // WHICH GUARD CARRIES THE VERDICT — stated honestly, per the mutation
  // corollary. The decision records that a probe showed NO patch under
  // `show --stat` alone, and that `--no-patch` was kept as DEFENSE IN DEPTH.
  // So the single-guard sabotage (delete --no-patch) is EXPECTED to leave
  // this green: `--stat` is what carries the verdict in the simple case.
  // The mutation that actually flips it red is stripping BOTH --stat and
  // --no-patch (i.e. making show-stat an alias of show).
  assert.doesNotMatch(r.stdout, /^diff --git /m, 'show-stat is stat-only: no patch header may appear');
  assert.doesNotMatch(r.stdout, /^@@ /m, 'show-stat is stat-only: no hunk header may appear');
});

test('git-ro CONTROL diff-names: `diff-names HEAD~1 HEAD` exits 0 and emits a JSON array of {status, path} records with repo-relative POSIX paths', () => {
  requireWrapper();
  const r = gitro(['diff-names', 'HEAD~1', 'HEAD']);
  assert.equal(r.code, 0, `diff-names over two real commits must succeed; stderr=${r.stderr}`);
  assert.doesNotMatch(r.stdout, /\0/, 'the -z stream is parsed internally; NUL on stdout means passthrough leaked');

  const entries = jsonArray(r.stdout, 'diff-names');
  assert.ok(entries.length > 0, 'HEAD~1..HEAD changed at least one file');
  for (const e of entries) {
    // NAMED SABOTAGE: emit bare path strings instead of {status, path}
    // records (drop --name-status, or drop the status field) — flips these red.
    assert.equal(typeof e?.status, 'string', `each entry carries a status; got ${JSON.stringify(e)}`);
    assert.match(e.status, /^[A-Z]\d*$/, `status is a git name-status letter (optionally scored, e.g. R100); got ${JSON.stringify(e.status)}`);
    assert.equal(typeof e?.path, 'string', `each entry carries a path; got ${JSON.stringify(e)}`);
    assert.ok(e.path.length > 0, 'no empty paths');
    // Repo path invariant: repo-relative, forward slashes.
    assert.doesNotMatch(e.path, /^[/\\]|^[A-Za-z]:/, `paths are repo-relative, never absolute; got ${e.path}`);
    assert.doesNotMatch(e.path, /\\/, `paths use forward slashes; got ${e.path}`);
  }
});

test('git-ro CONTROL restore: `show HEAD:CLAUDE.md` returns the file content at that revision (the REV:path restore case)', () => {
  requireWrapper();
  const r = gitro(['show', 'HEAD:CLAUDE.md']);
  assert.equal(r.code, 0, `show REV:path must succeed for a tracked file; stderr=${r.stderr}`);

  // NAMED SABOTAGE: reject any rev token containing ':' during the lexical
  // pre-check (a plausible "rev grammar" over-tightening) — this refuses and
  // the exit-0 assertion goes red, which is exactly the measured restore
  // capability the decision says must survive.
  assert.match(r.stdout, /# CLAUDE\.md/, 'the output is the FILE CONTENT at that revision, not a commit header');
  assert.doesNotMatch(r.stdout, /^commit [0-9a-f]{7,40}/m, 'REV:path yields blob content, never commit metadata');
  assert.ok(r.stdout.length > 500, 'the whole blob is emitted, not a truncated fragment');

  const older = gitro(['show', 'HEAD~1:CLAUDE.md']);
  assert.equal(older.code, 0, `the same restore works at an older revision; stderr=${older.stderr}`);
  assert.ok(older.stdout.length > 500, 'HEAD~1 content is emitted whole');
});

test('git-ro CONTROL restore of a DELETED file: a path deleted in recent history is still recoverable via `show <parent-rev>:<path>`', (t) => {
  requireWrapper();
  // Discovery uses only the wrapper's own read-only verbs (no direct git), so
  // this stays inside the spec surface. If recent history holds no deletion,
  // the arm skips LOUDLY rather than asserting something vacuous.
  let found = null;
  for (let k = 1; k <= 12 && !found; k++) {
    const older = `HEAD~${k}`;
    const newer = k === 1 ? 'HEAD' : `HEAD~${k - 1}`;
    const r = gitro(['diff-names', older, newer]);
    if (r.code !== 0) continue;
    let entries;
    try {
      entries = jsonArray(r.stdout, 'diff-names discovery');
    } catch {
      continue;
    }
    const del = entries.find((e) => typeof e?.status === 'string' && e.status.startsWith('D') && typeof e?.path === 'string');
    if (del) found = { rev: older, path: del.path };
  }

  if (!found) {
    t.skip('no file deletion found in the last 12 commits — the deleted-file restore arm is CONDITIONAL on repo history and is reported as such');
    return;
  }

  // NAMED SABOTAGE: resolve the rev with `^{commit}` only and reject a
  // REV:path token — the deleted-file restore (the decision's measured
  // motivating case) refuses and this goes red.
  const r = gitro(['show', `${found.rev}:${found.path}`]);
  assert.equal(r.code, 0, `a file deleted after ${found.rev} must still be readable at ${found.rev} (${found.path}); stderr=${r.stderr}`);
  assert.ok(r.stdout.length > 0, 'the recovered blob is non-empty');
});

test('git-ro CONTROL path filter: `log HEAD -- CLAUDE.md` is non-empty and `log HEAD -- <path that never existed>` is EMPTY with exit 0', () => {
  requireWrapper();
  const hit = gitro(['log', 'HEAD', '--', 'CLAUDE.md']);
  assert.equal(hit.code, 0, `a path-filtered log must succeed; stderr=${hit.stderr}`);
  assert.ok(jsonArray(hit.stdout, 'log -- CLAUDE.md').length > 0, 'CLAUDE.md has history');

  // NAMED SABOTAGE: drop the `-- PATH...` tail from the log recipe (build the
  // argv without the paths) — the filtered call below returns the unfiltered
  // log, and this length-0 assertion goes red. This is the pin that proves
  // paths after `--` actually REACH git rather than being parsed and dropped.
  const miss = gitro(['log', 'HEAD', '--', 'no/such/path-that-never-existed-9f2a.mjs']);
  assert.equal(miss.code, 0, `a pathspec matching nothing is an empty result, not an error; stderr=${miss.stderr}`);
  assert.equal(jsonArray(miss.stdout, 'log -- missing').length, 0, 'a pathspec matching nothing yields zero entries');
});

test('git-ro CONTROL determinism: the same call twice yields byte-identical stdout', () => {
  requireWrapper();
  const a = gitro(['show-stat', 'HEAD']);
  const b = gitro(['show-stat', 'HEAD']);
  assert.equal(a.code, 0, `first call must succeed; stderr=${a.stderr}`);
  assert.equal(b.code, 0, `second call must succeed; stderr=${b.stderr}`);
  // NAMED SABOTAGE: let a locale/relative-date/color-auto influence into the
  // recipe (e.g. --date=relative) — repeated output drifts and this goes red.
  assert.equal(a.stdout, b.stdout, 'a read-only recipe is deterministic across invocations');
});

// ===========================================================================
// FAMILY 2 — ARITY AND VERB REFUSALS.
// Control arm for the family = FAMILY 1 above (each verb succeeds well-formed).
// ===========================================================================

test('git-ro REFUSAL: an unknown verb is refused naming the verb rule', () => {
  requireWrapper();
  // NAMED SABOTAGE: replace the verb switch's default-refuse branch with a
  // pass-through that forwards the token to git — `status` succeeds and this
  // goes red. (This is the pin that keeps the surface FOUR verbs, not "git".)
  assertRefusal(gitro(['status']), /verb/i, 'unknown verb `status`');
  assertRefusal(gitro(['blame', 'CLAUDE.md']), /verb/i, 'unknown verb `blame`');
  assertRefusal(gitro(['push']), /verb/i, 'unknown verb `push`');
});

test('git-ro REFUSAL: empty argv (no verb at all) is refused', () => {
  requireWrapper();
  // NAMED SABOTAGE: default the verb to `log` when argv is empty — this goes
  // red (exit 0, JSON on stdout).
  assertRefusal(gitro([]), /verb|usage/i, 'empty argv');
});

test('git-ro REFUSAL: diff-names with ONE rev is refused — one-rev diff compares the WORKTREE, which this wrapper never does', () => {
  requireWrapper();
  // CONTROL (opposite reason, and it must pass): two endpoints succeed.
  const ok = gitro(['diff-names', 'HEAD~1', 'HEAD']);
  assert.equal(ok.code, 0, `control: two endpoints succeed; stderr=${ok.stderr}`);

  // NAMED SABOTAGE: make the second endpoint optional in the diff-names arity
  // check (`>= 1` instead of `=== 2`) — the call below succeeds against the
  // worktree and this goes red. This is the round-2 defect the decision
  // records as empirically verified.
  assertRefusal(gitro(['diff-names', 'HEAD']), /exactly two|two (commits|revs|endpoints)|arity|endpoint/i, 'diff-names with one rev');
});

test('git-ro REFUSAL: diff-names with THREE revs is refused', () => {
  requireWrapper();
  // NAMED SABOTAGE: change the arity check to a lower bound — the third rev is
  // silently ignored or appended to the recipe and this goes red.
  assertRefusal(
    gitro(['diff-names', 'HEAD~2', 'HEAD~1', 'HEAD']),
    /exactly two|two (commits|revs|endpoints)|arity|endpoint/i,
    'diff-names with three revs'
  );
});

test('git-ro REFUSAL: show with TWO objects is refused — the recipe takes exactly one', () => {
  requireWrapper();
  const ok = gitro(['show', 'HEAD']);
  assert.equal(ok.code, 0, `control: one object succeeds; stderr=${ok.stderr}`);
  // NAMED SABOTAGE: spread every positional rev into the show recipe instead
  // of asserting a single object — two commits print and this goes red.
  assertRefusal(gitro(['show', 'HEAD', 'HEAD~1']), /exactly one|one (object|rev)|arity/i, 'show with two objects');
});

test('git-ro REFUSAL: a RANGE or SET expression can never stand in for one object (HEAD~2..HEAD, HEAD^@)', () => {
  requireWrapper();
  // CONTROL first: the same verb with a single resolvable object succeeds.
  const ok = gitro(['show', 'HEAD']);
  assert.equal(ok.code, 0, `control: a single object resolves and prints; stderr=${ok.stderr}`);

  // The decision: cardinality is enforced by RESOLUTION (rev-parse --verify
  // ... ^{object}), not by a regex — a range fails that resolve, so the
  // refusal may be either the wrapper's own or git's passed-through failure.
  // Both are acceptable; what is NOT acceptable is expansion into many
  // objects, or any patch text on stdout.
  //
  // NAMED SABOTAGE: drop `--verify ... ^{object}` and pass the raw token into
  // the show recipe — `HEAD~2..HEAD` starts producing output and the empty-
  // stdout assertion goes red.
  for (const expr of ['HEAD~2..HEAD', 'HEAD~2...HEAD', 'HEAD^@']) {
    const r = gitro(['show', expr]);
    assert.notEqual(r.code, 0, `a range/set expression must not resolve to one object (${expr}); code=${r.code}`);
    assert.equal(r.stdout, '', `no output may be produced for ${expr} — one token must never expand into many objects`);
    assert.doesNotMatch(r.stderr, MODULE_MISSING, `${expr}: the nonzero exit must not be a missing module`);
    assert.doesNotMatch(r.stderr, STACK_FRAME, `${expr}: the nonzero exit must not be an uncaught exception`);
    assert.ok(r.stderr.trim().length > 0, `${expr}: the failure is explained on stderr (wrapper rule or passed-through git error), never silent`);
  }
});

test('git-ro REFUSAL: a well-formed but nonexistent object fails with git\'s error passed through — nonzero, empty stdout, explained', () => {
  requireWrapper();
  const r = gitro(['show', '0'.repeat(40)]);
  assert.notEqual(r.code, 0, 'an unresolvable object must not succeed');
  assert.equal(r.stdout, '', 'no partial output for an unresolvable object');
  assert.doesNotMatch(r.stderr, STACK_FRAME, 'a git failure passes through as code+stderr, never as an uncaught exception');
  assert.ok(r.stderr.trim().length > 0, 'the failure is explained on stderr');
});

// ===========================================================================
// FAMILY 3 — LEXICAL PRE-CHECKS ON REV TOKENS.
// Control arm: HEAD (a legal rev) succeeds on the same verb, first.
// ===========================================================================

test('git-ro REFUSAL: a flag-shaped positional is refused on every verb — the wrapper takes ZERO caller-controlled git flags', () => {
  requireWrapper();
  // CONTROL: the same verbs succeed with a plain rev.
  assert.equal(gitro(['show', 'HEAD']).code, 0, 'control: show HEAD succeeds');
  assert.equal(gitro(['log']).code, 0, 'control: log succeeds');

  // NAMED SABOTAGE: delete the leading-dash / flag-shape check so unmatched
  // positionals are appended to the recipe — each of these reaches git and
  // the refusal assertions go red. `-O/etc/passwd` is the one that matters:
  // git's short-option-with-attached-value form is how a flagless surface
  // becomes an arbitrary-file writer.
  assertRefusal(gitro(['show', '--output=x', 'HEAD']), /flag|option|dash/i, 'show --output=x');
  assertRefusal(gitro(['log', '-p']), /flag|option|dash/i, 'log -p');
  assertRefusal(gitro(['show', '-O/etc/passwd', 'HEAD']), /flag|option|dash/i, 'show -O/etc/passwd');
  assertRefusal(gitro(['show', '--no-color', 'HEAD']), /flag|option|dash/i, 'even a HARMLESS-looking flag is refused — the rule is zero caller flags, not a deny-list of dangerous ones');
  assertRefusal(gitro(['diff-names', '--name-only', 'HEAD~1', 'HEAD']), /flag|option|dash/i, 'diff-names --name-only');
});

test('git-ro REFUSAL: a rev token with a LEADING DASH is refused rather than reaching resolution as an option', () => {
  requireWrapper();
  assertRefusal(gitro(['show', '-HEAD']), /flag|option|dash/i, 'show -HEAD');
  assertRefusal(gitro(['log', '-HEAD~1']), /flag|option|dash/i, 'log -HEAD~1');
});

test('git-ro REFUSAL: control characters, newlines and whitespace inside a rev token are refused by the lexical pre-check', () => {
  requireWrapper();
  // NAMED SABOTAGE: delete the control-char/whitespace rejection from the
  // lexical layer — these tokens reach rev-parse and the refusal (or its
  // rule-naming stderr) changes shape, flipping these red.
  //
  // The next line is the ORIGINAL raw-byte arm, retired in place: a literal
  // control byte in source is stripped by some editors, and a stripped byte
  // turns it into a plain `show HEAD` that SUCCEEDS — a false red that has
  // nothing to do with the rule. The fromCharCode arms below carry the pin.
  // assertRefusal(gitro(['show', 'HEAD']), /control|character|invalid|grammar|charset|rev/i, 'raw SOH byte embedded in the rev token');
  // Same rule, built programmatically so the coverage does not depend on a raw
  // control byte surviving an editor round-trip. NUL is deliberately absent:
  // node refuses to spawn with a NUL in argv, so the NUL half of the rule is
  // unreachable from this harness and is reported as a named gap.
  assertRefusal(gitro(['show', `HEAD${String.fromCharCode(1)}`]), /control|character|invalid|grammar|charset|rev/i, 'SOH via fromCharCode');
  assertRefusal(gitro(['show', `HEAD${String.fromCharCode(27)}[31m`]), /control|character|invalid|grammar|charset|rev/i, 'ESC (ANSI injection shape) in rev');
  assertRefusal(gitro(['show', `HEAD${String.fromCharCode(9)}HEAD~1`]), /control|character|whitespace|invalid|grammar|charset|rev/i, 'TAB in rev');
  assertRefusal(gitro(['show', 'HEAD\nHEAD~1']), /control|character|whitespace|invalid|grammar|charset|rev/i, 'newline in rev');
  assertRefusal(gitro(['show', 'HEAD HEAD~1']), /whitespace|control|invalid|grammar|charset|rev/i, 'embedded space in rev');
  assertRefusal(gitro(['show', '']), /empty|invalid|rev/i, 'empty rev token');
});

test('git-ro REFUSAL: a rev token longer than the 256-char cap is refused (300 chars)', () => {
  requireWrapper();
  // NAMED SABOTAGE: remove the 256-char length cap — the token reaches
  // rev-parse, fails there instead, and the rule-naming stderr assertion goes
  // red (the refusal no longer cites a length rule).
  assertRefusal(gitro(['show', 'a'.repeat(300)]), /length|256|too long|long/i, '300-char rev');
});

// ===========================================================================
// FAMILY 4 — ARGV STRUCTURE: the mandatory `--` separator.
// Control arm: the same call WITH a correct `--` succeeds, first.
// ===========================================================================

test('git-ro REFUSAL: a path without the mandatory literal `--` separator is refused', () => {
  requireWrapper();
  // CONTROL, placed first and passing for the opposite reason.
  const ok = gitro(['log', 'HEAD', '--', 'scripts']);
  assert.equal(ok.code, 0, `control: the SAME path IS accepted after an explicit --; stderr=${ok.stderr}`);

  // NAMED SABOTAGE: treat trailing positionals as paths when they fail rev
  // resolution (an "obviously helpful" fallback) — this call succeeds and the
  // refusal goes red. The separator is mandatory precisely so a path can never
  // be reinterpreted as a rev or vice versa.
  assertRefusal(gitro(['log', 'HEAD', 'scripts']), /--|separator|path/i, 'path before --');
});

test('git-ro REFUSAL: a DUPLICATE or TRAILING `--` is refused, and an EMPTY path after `--` is refused', () => {
  requireWrapper();
  const ok = gitro(['log', 'HEAD', '--', 'CLAUDE.md']);
  assert.equal(ok.code, 0, `control: a single -- with one path succeeds; stderr=${ok.stderr}`);

  // NAMED SABOTAGE: use indexOf('--') and splice once, ignoring later
  // occurrences — the duplicate-separator call below succeeds and goes red.
  assertRefusal(gitro(['log', 'HEAD', '--', 'CLAUDE.md', '--', 'scripts']), /--|separator|duplicate/i, 'duplicate --');
  assertRefusal(gitro(['log', 'HEAD', '--']), /--|separator|trailing|path/i, 'trailing -- with no paths');
  assertRefusal(gitro(['log', 'HEAD', '--', '']), /empty|path/i, 'empty path after --');
});

// ===========================================================================
// FAMILY 5 — CHILD ENVIRONMENT IS A POSITIVE SET (the round-2 defect).
// Control arm: the identical call with an unmodified env succeeds, first.
// ===========================================================================

test('git-ro ENV: hostile inherited env (GIT_PAGER, GIT_EXTERNAL_DIFF, LD_PRELOAD) never reaches the git child — every verb still succeeds', () => {
  requireWrapper();
  // CONTROL first: clean env, same calls, exit 0 — so a green below cannot be
  // explained by "this wrapper succeeds no matter what".
  assert.equal(gitro(['show', 'HEAD']).code, 0, 'control: show HEAD succeeds under a clean env');

  const hostile = {
    GIT_PAGER: '/bin/false',
    GIT_EXTERNAL_DIFF: '/bin/false',
    GIT_TEXTCONV_CACHE: '/nonexistent',
    LD_PRELOAD: '/nonexistent.so',
    LD_LIBRARY_PATH: '/nonexistent-lib',
    GIT_CONFIG_GLOBAL: '/nonexistent/gitconfig',
  };

  // NAMED SABOTAGE: build the child env as {...process.env} minus GIT_* (the
  // copy-except shape the decision explicitly rejects) — LD_PRELOAD survives
  // into the child; on a machine where that preload is merely missing this
  // may still exit 0, so the LOAD-BEARING pin here is GIT_EXTERNAL_DIFF /
  // GIT_PAGER reaching git. Stated plainly in the report: this arm proves the
  // GIT_* half by observation, and the LD_* half by construction only.
  for (const args of [['log'], ['show', 'HEAD'], ['show-stat', 'HEAD'], ['diff-names', 'HEAD~1', 'HEAD'], ['show', 'HEAD:CLAUDE.md']]) {
    const r = gitro(args, { extraEnv: hostile });
    assert.equal(r.code, 0, `\`${args.join(' ')}\` must succeed with a hostile inherited env; stderr=${r.stderr}`);
    assert.ok(r.stdout.length > 0, `\`${args.join(' ')}\` still produces its output under a hostile env`);
  }
  // NOTE (defense in depth, stated rather than assumed): GIT_EXTERNAL_DIFF is
  // neutralized TWICE — by the positive-set env AND by --no-ext-diff in the
  // recipes. Stripping either one alone is expected to leave this green; both
  // must go for it to fail. The env construction is what this test NAMES.
});

test('git-ro ENV: a bogus GIT_DIR in the inherited env is stripped — the wrapper still reads THIS repo', () => {
  requireWrapper();
  const control = gitro(['show-stat', 'HEAD']);
  assert.equal(control.code, 0, `control: clean env succeeds; stderr=${control.stderr}`);

  // NAMED SABOTAGE: pass process.env through to the child (or add GIT_DIR to
  // an allowlist) — git follows the bogus GIT_DIR, fails to find a repository,
  // and this exit-0 assertion goes red. This arm has a single load-bearing
  // guard (the positive-set env), so it is a true single-mutation pin.
  const r = gitro(['show-stat', 'HEAD'], { extraEnv: { GIT_DIR: join(tmpdir(), 'definitely-not-a-repo-8f31.git') } });
  assert.equal(r.code, 0, `a bogus inherited GIT_DIR must be stripped, not honored; stderr=${r.stderr}`);
  assert.equal(r.stdout, control.stdout, 'the stripped-GIT_DIR run reads the SAME repository as the clean run — identical output');
});

test('git-ro EXECUTABLE: git is resolved from a hardcoded absolute-path roster — a hostile `git` first on PATH is never executed', (t) => {
  requireWrapper();
  if (process.platform === 'win32') {
    t.skip('the PATH-poisoning fixture uses a POSIX shell script; the win32 roster arm is a named coverage gap');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'gitro-path-poison-'));
  try {
    const marker = join(dir, 'HOSTILE-GIT-RAN');
    const fake = join(dir, 'git');
    writeFileSync(fake, `#!/bin/sh\n: > "${marker}"\nexit 42\n`);
    chmodSync(fake, 0o755);

    // NAMED SABOTAGE: resolve the executable as the bare string 'git' (PATH
    // resolution) instead of probing the hardcoded roster — the fake runs,
    // the marker file appears, and BOTH assertions below go red (exit 42, and
    // a marker on disk).
    const r = gitro(['show-stat', 'HEAD'], { extraEnv: { PATH: dir } });
    assert.ok(!existsSync(marker), 'a `git` planted first on PATH must never be executed — the roster is hardcoded, not PATH-derived');
    assert.equal(r.code, 0, `the wrapper still succeeds with a poisoned PATH; stderr=${r.stderr}`);
    assert.match(r.stdout, /^commit [0-9a-f]{7,40}/m, 'the output came from real git, not the planted script');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// FAMILY 6 — THE CWD RULE.
// Control arm placed first: the identical call from the canonical project root
// SUCCEEDS, so the refusal below is evidence of the cwd rule and not of a
// wrapper that refuses unconditionally.
// ===========================================================================

test('git-ro CWD RULE: invoked from outside the canonical project root, the wrapper refuses naming the root rule and writes nothing', () => {
  requireWrapper();
  // CONTROL — same argv, cwd = the canonical project root.
  const fromRoot = gitro(['log']);
  assert.equal(fromRoot.code, 0, `control: the SAME call succeeds from the canonical project root; stderr=${fromRoot.stderr}`);

  const outside = mkdtempSync(join(tmpdir(), 'gitro-wrong-cwd-'));
  try {
    // NAMED SABOTAGE: delete the canonical-path cwd comparison (or downgrade
    // it to a warning) — the call below succeeds and this refusal goes red.
    const r = gitro(['log'], { cwd: realpathSync(outside) });
    assertRefusal(r, /project root|root|cwd|directory/i, 'invocation from a foreign cwd');
    assert.deepEqual(readdirSync(outside), [], 'a refused invocation creates nothing in the foreign directory');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('git-ro CWD RULE: the refusal is about the CWD, not about the verb — every verb refuses from a foreign cwd, and all of them succeed from the root', () => {
  requireWrapper();
  const outside = mkdtempSync(join(tmpdir(), 'gitro-wrong-cwd-verbs-'));
  try {
    for (const args of [['log'], ['show', 'HEAD'], ['show-stat', 'HEAD'], ['diff-names', 'HEAD~1', 'HEAD']]) {
      // CONTROL arm, per verb, evaluated first.
      assert.equal(gitro(args).code, 0, `control: \`${args.join(' ')}\` succeeds from the project root`);
      const r = gitro(args, { cwd: realpathSync(outside) });
      assertRefusal(r, /project root|root|cwd|directory/i, `\`${args.join(' ')}\` from a foreign cwd`);
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// ===========================================================================
// FAMILY 7 — COMMIT-TO-COMMIT SEMANTICS (never the worktree).
// ===========================================================================

test('git-ro SEMANTICS: `diff-names HEAD HEAD` is EMPTY — the comparison is commit-to-commit, never against the working tree', () => {
  requireWrapper();
  // CONTROL first: a genuinely different pair is non-empty, so an empty result
  // below cannot be explained by "diff-names always returns nothing".
  const changed = gitro(['diff-names', 'HEAD~1', 'HEAD']);
  assert.equal(changed.code, 0, `control: HEAD~1..HEAD succeeds; stderr=${changed.stderr}`);
  assert.ok(jsonArray(changed.stdout, 'control diff-names').length > 0, 'control: a real pair of commits reports changes');

  // NAMED SABOTAGE: build the diff recipe with a single endpoint (the round-2
  // worktree defect) — on a dirty worktree this returns the dirty files and
  // goes red. HONEST LIMIT, reported as such: on a perfectly CLEAN worktree
  // this arm passes under that sabotage too, so its strength depends on tree
  // state; the arity refusal test in FAMILY 2 is the unconditional pin for the
  // same rule, and this one is its semantic companion.
  const r = gitro(['diff-names', 'HEAD', 'HEAD']);
  assert.equal(r.code, 0, `a commit compared with itself is a legal, empty diff; stderr=${r.stderr}`);
  assert.equal(jsonArray(r.stdout, 'diff-names HEAD HEAD').length, 0, 'a commit compared with itself reports no changes');
});

// ===========================================================================
// FAMILY 8 — LOG TRUNCATION DISCLOSURE.
// The log recipe is BOUNDED to the 200 cap; when this repo's >200-commit
// history overflows it, the envelope must SAY SO — and it must NOT cry
// truncation on a result that fit. The CONTROL (a small, non-truncated
// result) runs FIRST so the disclosure verdict below carries evidence that the
// marker tracks reality rather than being a pinned constant. Together the two
// arms bracket the marker to the actual overflow: the control goes red if the
// field is hardcoded true, the main test goes red if it is hardcoded false /
// absent / a bare array.
// ===========================================================================

test('git-ro TRUNCATION CONTROL: a path-filtered `log` returning FEWER than the cap of commits is NOT marked truncated (truncated falsy / shown==total)', (t) => {
  requireWrapper();
  // Find a real, tracked path whose filtered history is non-empty yet well
  // under the 200 cap, so "not truncated" is read against a genuine small
  // result and not merely an empty one (an empty result would leave a
  // "true-except-when-empty" bug undetected). The first qualifying candidate is
  // used; if none qualifies the arm SKIPS loudly rather than asserting
  // something vacuous. Discovery uses only the wrapper's own read-only `log`.
  const candidates = [
    'scripts/git-ro.mjs',
    'scripts/tests/git-ro.test.mjs',
    'scripts/tests/h14-git-ro-grant.test.mjs',
    'scripts/list-projects.mjs',
    'scripts/architecture-projection.mjs',
    'scripts/rotation-note.mjs',
  ];
  let picked = null;
  for (const p of candidates) {
    const r = gitro(['log', 'HEAD', '--', p]);
    if (r.code !== 0) continue;
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch { continue; }
    let arr;
    try { arr = jsonArray(r.stdout, `log -- ${p}`); } catch { continue; }
    if (arr.length > 0 && arr.length < 200) { picked = { p, parsed, arr }; break; }
  }
  if (!picked) {
    t.skip('no tracked candidate produced a non-empty sub-cap history — the small-result truncation control is CONDITIONAL on repo history and reported as such');
    return;
  }

  // NAMED SABOTAGE: hardcode the disclosure field to `truncated: true` (or set
  // it true whenever any entries exist) — this control goes red, proving the
  // marker no longer reflects reality. THIS is the arm that proves the main
  // test's green is caused by a real overflow, not a constant.
  const m = truncationMarker(picked.parsed);
  assert.equal(
    m.disclosed,
    false,
    `a sub-cap result (${picked.arr.length} entries for ${picked.p}) must NOT be marked truncated; marker=${JSON.stringify(m)}`
  );
});

test('git-ro TRUNCATION: `log` over this >200-commit repo DISCLOSES truncation — a truthy /truncat/i field OR shown<total, with entries bounded to the 200 cap', () => {
  requireWrapper();
  const r = gitro(['log']);
  assert.equal(r.code, 0, `log with no rev must succeed; stderr=${r.stderr}`);

  const arr = jsonArray(r.stdout, 'log');
  // Cap half of the contract: whatever the envelope, the entries never exceed
  // the recipe's fixed bound.
  assert.ok(arr.length <= 200, `the log recipe is fixed at -n 200; got ${arr.length} entries`);

  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    assert.fail(`log stdout must be parseable JSON; parse error=${err.message}`);
  }

  // NAMED SABOTAGE: emit a bare array (drop the envelope), or hardcode
  // `truncated: false` / omit the disclosure field — this repo has >200
  // commits so the true result IS truncated at 200, and this assertion goes
  // red. (Assumption stated in the report: this repo carries >200 commits —
  // the same invariant the CONTROL log test in Family 1 already relies on.)
  const m = truncationMarker(parsed);
  assert.ok(
    m.disclosed,
    `the 200-cap log over a >200-commit repo MUST disclose truncation (a truthy /truncat/i field, or a shown<total pair); a bare array or a silent cap hides that the answer is incomplete; marker=${JSON.stringify(m)}, entries=${arr.length}`
  );
});

// ===========================================================================
// FAMILY 9 — REFUSAL OUTPUT IS SANITIZED (transcript-injection defense).
// A refusal provoked by a token carrying terminal control bytes must never
// echo the raw ESC (0x1b) back onto stderr/stdout, or the refusal message
// itself becomes an ANSI-injection vector into the conductor's transcript.
// The CONTROL/companion runs FIRST: a refusal with a CLEAN token still names
// its rule on a non-empty stderr, so the ESC-absence assertions below cannot
// pass vacuously against an empty stream — the byte is STRIPPED, not merely
// never emitted.
// ===========================================================================

test('git-ro REFUSAL OUTPUT: a refusal provoked by a control byte never echoes the raw ESC (0x1b) into stderr/stdout — pins against transcript-injection', () => {
  requireWrapper();
  // CONTROL / companion, first and passing for the OPPOSITE reason: a clean
  // unknown verb still refuses with a non-empty, rule-naming stderr. Without
  // this arm the ESC-absence checks below could be satisfied by an empty
  // stderr, which would prove nothing about sanitization.
  const clean = gitro(['bogus-verb']);
  assertRefusal(clean, /verb/i, 'control: a clean unknown verb refuses with rule-naming stderr');
  assert.ok(clean.stderr.trim().length > 0, 'control: a refusal carries a non-empty explanation on stderr');
  assert.equal(clean.stderr.includes(ESC), false, 'control: a clean refusal has no ESC to begin with');

  // NAMED SABOTAGE: interpolate the offending token verbatim into the refusal
  // message (e.g. `bad rev token: ${tok}` / `unknown verb: ${verb}`) without
  // sanitizing control bytes — the raw ESC reaches the terminal and every arm
  // below goes red. Two echo SITES are covered: a rev token, and the VERB
  // string (the two caller-controlled values a refusal is most likely to quote
  // back).
  for (const args of [
    ['show', `HEAD${ESC}[31mINJECTED`],
    ['show', `HEAD${ESC}[2J${ESC}[H`],
    ['diff-names', `HEAD${ESC}[0m`, 'HEAD'],
    [`ev${ESC}il-verb`],
    [`${ESC}[31mstatus`],
  ]) {
    const r = gitro(args);
    assert.notEqual(r.code, 0, `${JSON.stringify(args)}: a control-byte token must be refused; stderr=${JSON.stringify(r.stderr)}`);
    assert.equal(
      r.stderr.includes(ESC),
      false,
      `${JSON.stringify(args)}: the refusal stderr must NOT contain the raw ESC (0x1b) byte — echo it escaped/sanitized, never raw; stderr=${JSON.stringify(r.stderr)}`
    );
    assert.equal(
      r.stdout.includes(ESC),
      false,
      `${JSON.stringify(args)}: no raw ESC on stdout either — a refusal writes nothing, and certainly no control bytes`
    );
  }
});
