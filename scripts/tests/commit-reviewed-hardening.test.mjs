// COMMIT-REVIEWED CLI — HARDENING PINS (decision review-receipt-ledger, id
// 12a26ca6-a301-466d-a45c-5e1eeff36694; board 7814acc3-bb22-4cc5-abd7-789d6396743f)
//
// SUPPLEMENTAL to scripts/tests/commit-reviewed.test.mjs (base spec — read in
// full, NOT modified) and scripts/tests/h22-review-ledger.test.mjs (promotion
// spec — read in full, NOT modified). Both were read for harness conventions
// only; nothing here imports either file, and neither is duplicated — this
// file's five properties are the ones the base spec does not cover:
//
//   1. CONSUME-SNAPSHOT — an entry appended to the ledger file DURING the
//      `git commit` invocation (by a pre-commit hook) survives consumption:
//      the CLI must only remove the entries it actually read and stamped
//      into trailers, re-diffed against the ledger's POST-commit on-disk
//      state — never a blind overwrite (e.g. "write back my in-memory
//      snapshot minus the stamped ones" would silently erase the hook's
//      concurrent append; "write []" would erase it even harder).
//   2. CONSUME-ONLY-AFTER-SUCCESS — if `git commit` itself fails (e.g. a
//      pre-commit hook exits non-zero), the ledger must be byte-preserved:
//      no consumption happens for a commit that never landed. This may
//      already hold under the base (unhardened) implementation if it simply
//      never reaches its consumption step on a failed spawnSync — pinned
//      here regardless, as a regression pin, with that noted per-test.
//   3. VALIDATION — a ledger entry whose agent_type is not a safe, single-
//      line string (embedded newline enabling trailer/commit-message
//      injection; non-string values like null or an object) must be
//      SKIPPED, not stamped and not silently coerced via string
//      interpolation — while a valid entry alongside it still gets its
//      trailer and gets consumed. A ledger of ONLY invalid entries must
//      refuse exactly like the base spec's zero-entries case.
//   4. DUPLICATES — two ledger entries sharing the same agent_type produce
//      TWO separate `Reviewed-By-Agent` trailer lines (one per entry) — the
//      CLI must never de-duplicate by value, since each entry is a distinct
//      piece of review evidence even when the reviewer role recurs.
//   5. CWD GUARD — invoked from a directory that is not a Sterling project
//      at all (no .sterling/ present), the CLI must refuse with a message
//      DISTINCT from the base spec's zero-ledger-entries guidance (which
//      talks about dispatching a reviewer / the merge gate — advice that
//      presupposes a Sterling-governed repo and is actively misleading for
//      "this isn't a Sterling project"). This test pins the MISMATCH, not
//      any specific replacement wording, per the launching agent's brief.
//
// Written BLIND to scripts/commit-reviewed.mjs's internals — a fixer is
// hardening it in a parallel lane right now; this file specifies the target
// behavior from the decision record and the launching agent's brief only, and
// does not read that script (H4 read wall; also true by design here). The
// `git()`/`stageChange()`/`ledgerPath()`/`readTrailerValues()` idioms below
// are adapted from scripts/tests/commit-reviewed.test.mjs's own helpers,
// reproduced standalone (not imported) so this file runs independently, per
// the same convention scripts/tests/merge-review-receipts-hardening.test.mjs
// uses relative to its own base spec.
//
// Every property here is exercised via a REAL git pre-commit hook installed
// in the fixture repo's .git/hooks/ — a deterministic way to observe/control
// exactly what happens "while git commit runs" without reading the CLI's
// internals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_PATH = join(root, 'scripts', 'commit-reviewed.mjs');

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-hardening-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Same as makeRepo(), but deliberately never creates .sterling/ at all — a
// directory that is not a Sterling project, for the CWD GUARD pin.
function makeRepoNoSterling() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-hardening-nosterling-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function ledgerPath(dir) {
  return join(dir, '.sterling', 'review-ledger.json');
}
function writeLedger(dir, entries) {
  writeFileSync(ledgerPath(dir), JSON.stringify(entries));
}
function readLedgerRaw(dir) {
  return readFileSync(ledgerPath(dir), 'utf8');
}
function readLedger(dir) {
  return existsSync(ledgerPath(dir)) ? JSON.parse(readFileSync(ledgerPath(dir), 'utf8')) : null;
}

function stageChange(dir, relPath = 'src/feature.mjs', content = 'export const f = 1;\n') {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}

function runCommitReviewed(dir, args = []) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// The EXACT read scripts/direct-merge.mjs:143 uses (per the base spec).
function readTrailerValues(dir, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)', sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}

// Installs a REAL, executable pre-commit hook in the fixture repo. `script`
// is the complete file content including its own shebang line.
function installPreCommitHook(dir, script) {
  const hookPath = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hookPath, script, { mode: 0o755 });
  chmodSync(hookPath, 0o755);
}

// A pre-commit hook that appends a fresh, valid ledger entry (agent_type
// 'reviewer-security') to .sterling/review-ledger.json and exits 0 — used to
// simulate a concurrent reviewer landing its promotion while `git commit` is
// mid-flight for property (1).
const HOOK_APPEND_VALID_ENTRY = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const p = path.join(process.cwd(), '.sterling', 'review-ledger.json');
let entries = [];
try { entries = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { entries = []; }
entries.push({ agent_type: 'reviewer-security', files: ['src/hookadded.mjs'], at: '2026-08-22T00:02:00.000Z' });
fs.writeFileSync(p, JSON.stringify(entries));
`;

// A pre-commit hook that always fails the commit — used to simulate `git
// commit` itself failing (e.g. a lint/format hook rejecting the change) for
// property (2).
const HOOK_ALWAYS_FAIL = `#!/bin/sh
exit 1
`;

// ---------------------------------------------------------------------------
// (1) CONSUME-SNAPSHOT
// ---------------------------------------------------------------------------

test('commit-reviewed.mjs (hardening) CONSUME-SNAPSHOT: a ledger entry appended by a pre-commit hook WHILE git commit runs survives consumption', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    installPreCommitHook(dir, HOOK_APPEND_VALID_ENTRY);
    stageChange(dir);
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/feature.mjs'], at: '2026-08-22T00:00:00.000Z' }]);

    // EXPECTED FAILURE SHAPE: today's (or a naively-hardened) implementation
    // most likely reads the ledger once, decides the trailer set, spawns
    // `git commit`, and on success writes back its OWN in-memory snapshot
    // (e.g. `[]`, or "everything minus what I stamped" computed against the
    // stale pre-commit copy) rather than re-reading the current on-disk
    // ledger and removing only the stamped entries from it. That clobbers
    // the hook's concurrent append. The `ledgerAfter.length === 1` /
    // `agent_type === 'reviewer-security'` assertions below are the ones
    // expected to fail red — most likely the file comes back empty (`[]`)
    // or still containing the ORIGINAL pre-existing entry instead of the
    // hook-appended one.
    const r = runCommitReviewed(dir, ['-m', 'feature reviewed, hook appends mid-commit']);
    assert.equal(r.code, 0, `commit must succeed — the pre-commit hook itself exits 0 — stdout=${r.stdout} stderr=${r.stderr}`);

    const trailers = readTrailerValues(dir);
    assert.deepEqual(trailers, ['reviewer-correctness'], 'the trailer set reflects only the PRE-EXISTING entry the CLI read before spawning git commit — the hook-appended entry was not yet on disk when trailers were decided');

    const ledgerAfter = readLedger(dir);
    assert.equal(ledgerAfter.length, 1, 'exactly one entry remains: the one the hook appended mid-commit — it must never be silently erased by consumption');
    assert.equal(ledgerAfter[0].agent_type, 'reviewer-security');
    assert.deepEqual(ledgerAfter[0].files, ['src/hookadded.mjs']);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (2) CONSUME-ONLY-AFTER-SUCCESS
// ---------------------------------------------------------------------------

test('commit-reviewed.mjs (hardening) CONSUME-ONLY-AFTER-SUCCESS: if git commit itself fails, the ledger is byte-preserved (not consumed)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    installPreCommitHook(dir, HOOK_ALWAYS_FAIL);
    stageChange(dir);
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/feature.mjs'], at: '2026-08-22T00:00:00.000Z' }]);
    const before = readLedgerRaw(dir);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    // EXPECTED FAILURE SHAPE: this property may ALREADY hold under an
    // unhardened implementation, if it simply never reaches its consumption
    // step when the git-commit spawn returns non-zero (a straight-line
    // "spawn, then on success consume" shape naturally satisfies this without
    // any dedicated hardening). Pinned here regardless as a REGRESSION pin —
    // if it is red today, the failing line is most likely `assert.equal
    // (readLedgerRaw(dir), before, ...)`, i.e. the ledger got consumed (or
    // partially rewritten) even though the underlying commit never landed.
    const r = runCommitReviewed(dir, ['-m', 'this commit must fail']);
    assert.notEqual(r.code, 0, `a failing git commit must propagate as a nonzero exit — stdout=${r.stdout} stderr=${r.stderr}`);

    const afterHead = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(afterHead, beforeHead, 'no commit was created when the pre-commit hook rejected it');

    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-preserved — consumption never happens for a commit that did not land');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (3) VALIDATION
// ---------------------------------------------------------------------------

test('commit-reviewed.mjs (hardening) VALIDATION: unsafe/non-string agent_type entries are skipped (not stamped, not consumed) while a valid entry alongside them still works', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    const invalidNewline = { agent_type: 'reviewer-good\nCo-authored-by: attacker', files: ['src/feature.mjs'], at: '2026-08-22T00:00:00.000Z' };
    const invalidNull = { agent_type: null, files: ['src/feature.mjs'], at: '2026-08-22T00:01:00.000Z' };
    const invalidObject = { agent_type: { nested: true }, files: ['src/feature.mjs'], at: '2026-08-22T00:02:00.000Z' };
    const valid = { agent_type: 'reviewer-correctness', files: ['src/feature.mjs'], at: '2026-08-22T00:03:00.000Z' };
    writeLedger(dir, [invalidNewline, invalidNull, invalidObject, valid]);

    // EXPECTED FAILURE SHAPE: an unhardened implementation most likely builds
    // each trailer via plain string interpolation of `entry.agent_type` with
    // no type/shape check, so it (a) stamps 4 trailers instead of 1 — a
    // literal `\n` inside the interpolated value splits the commit message
    // into an extra line that git's own trailer parser may or may not
    // attribute back to `Reviewed-By-Agent`, and `null`/the object stringify
    // to `"null"` / `"[object Object]"` and get stamped as if valid — and (b)
    // never mentions "skip" on stderr, since no validation branch exists to
    // report it. `assert.deepEqual(trailers, ['reviewer-correctness'])` and
    // the `/skip/i` stderr match are expected to fail red first.
    const r = runCommitReviewed(dir, ['-m', 'mixed valid/invalid ledger entries']);
    assert.equal(r.code, 0, `a ledger with at least one valid entry must still succeed — stdout=${r.stdout} stderr=${r.stderr}`);

    const trailers = readTrailerValues(dir);
    assert.deepEqual(trailers, ['reviewer-correctness'], 'exactly one trailer is stamped — the sole safe, valid entry; the unsafe/non-string entries are excluded entirely');

    assert.match(r.stderr, /skip/i, 'stderr mentions skipping the invalid entries');

    const ledgerAfter = readLedger(dir);
    assert.equal(ledgerAfter.length, 3, 'the three invalid entries remain in the ledger, un-consumed');
    assert.ok(ledgerAfter.some((e) => e.agent_type === null), 'the null-agent_type entry survives untouched');
    assert.ok(ledgerAfter.some((e) => e.agent_type !== null && typeof e.agent_type === 'object'), 'the object-agent_type entry survives untouched');
    assert.ok(
      ledgerAfter.some((e) => typeof e.agent_type === 'string' && e.agent_type.includes('\n')),
      'the newline-carrying agent_type entry survives untouched'
    );
  } finally {
    cleanup();
  }
});

test('commit-reviewed.mjs (hardening) VALIDATION: a ledger with ONLY invalid entries refuses exactly like the zero-entries case', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      { agent_type: 'reviewer-good\nCo-authored-by: attacker', files: ['src/feature.mjs'], at: '2026-08-22T00:00:00.000Z' },
      { agent_type: null, files: ['src/feature.mjs'], at: '2026-08-22T00:01:00.000Z' },
      { agent_type: { nested: true }, files: ['src/feature.mjs'], at: '2026-08-22T00:02:00.000Z' },
    ]);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    // EXPECTED FAILURE SHAPE: an unhardened implementation, absent any
    // validation step, sees 3 (raw) entries and takes the happy path,
    // stamping 3 garbage trailers and succeeding (r.code === 0) — the
    // `assert.equal(r.code, 1, ...)` line is expected to fail red first.
    const r = runCommitReviewed(dir, ['-m', 'attempt with only invalid entries']);
    assert.equal(r.code, 1, `a ledger with zero VALID entries must refuse exactly like zero entries — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /dispatch.*review|reviewer/i, 'refusal guidance matches the base zero-entries contract');
    assert.match(r.stderr, /merge gate|commit bare/i, 'refusal guidance matches the base zero-entries contract');

    const afterHead = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(afterHead, beforeHead, 'no commit was made against an all-invalid ledger');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (4) DUPLICATES
// ---------------------------------------------------------------------------

test('commit-reviewed.mjs (hardening) DUPLICATES: two ledger entries sharing the same agent_type stamp TWO trailer lines — no dedupe', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/feature.mjs'], at: '2026-08-22T00:00:00.000Z' },
      { agent_type: 'reviewer-correctness', files: ['src/other.mjs'], at: '2026-08-22T00:01:00.000Z' },
    ]);

    // EXPECTED FAILURE SHAPE: an implementation that de-dupes trailers by
    // value (e.g. building a Set of agent_types before stamping) produces
    // exactly ONE trailer line instead of two — `assert.equal(trailers.length,
    // 2, ...)` is the line expected to fail red.
    const r = runCommitReviewed(dir, ['-m', 'two reviews from the same reviewer role']);
    assert.equal(r.code, 0, `two valid (duplicate agent_type) entries must still succeed — stdout=${r.stdout} stderr=${r.stderr}`);

    const trailers = readTrailerValues(dir);
    assert.equal(trailers.length, 2, 'one trailer line PER ledger entry — duplicates are never collapsed');
    assert.deepEqual(trailers, ['reviewer-correctness', 'reviewer-correctness']);

    const ledgerAfter = readLedger(dir);
    assert.deepEqual(ledgerAfter, [], 'both duplicate entries are consumed');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (5) CWD GUARD
// ---------------------------------------------------------------------------

test('commit-reviewed.mjs (hardening) CWD GUARD: invoked where .sterling/ does not exist at all, refuses with a message DISTINCT from the zero-entry-ledger guidance', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepoNoSterling();
  try {
    assert.equal(existsSync(join(dir, '.sterling')), false, 'fixture guard: this is genuinely not a Sterling project directory');
    stageChange(dir);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    // EXPECTED FAILURE SHAPE: an implementation that treats "ledger file
    // missing" (because .sterling/ itself is missing) identically to "ledger
    // present but empty" reuses the exact zero-entries guidance verbatim
    // ("dispatch a reviewer ... or commit bare and answer at the merge
    // gate") — advice that presupposes a Sterling-governed repo and is
    // actively wrong here. The `assert.doesNotMatch(r.stderr, /merge gate|
    // commit bare/i, ...)` line is expected to fail red (i.e. that phrase IS
    // present) against such an implementation.
    const r = runCommitReviewed(dir, ['-m', 'attempt outside any Sterling project']);
    assert.equal(r.code, 1, `no .sterling/ at all must refuse — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(r.stderr.trim().length > 0, 'the refusal names a reason on stderr');
    assert.doesNotMatch(
      r.stderr,
      /merge gate|commit bare/i,
      'the missing-.sterling guard must be a DISTINCT message from the zero-ledger-entries guidance, not a reused copy of the "commit bare / merge gate" advice'
    );

    const afterHead = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(afterHead, beforeHead, 'no commit was made outside a Sterling project');
  } finally {
    cleanup();
  }
});
