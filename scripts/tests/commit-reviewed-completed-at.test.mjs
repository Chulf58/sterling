// COMMIT-REVIEWED — RECEIPT AGE DISCLOSURES (R1 pin re-cut, group D).
//
// AUTHORITY: contract sheet §3.2 "Disclosures printed (never refuse): receipt_stale,
// receipt_age_unverifiable, …" and §1.2 (ReceiptV2 carries `started_at` / `finished_at`;
// there is no `at` and no `reviewed_state.completed_at`). Decision 24dc4c63: age never
// decides spendability — `receiptIsSpendable` has no age code — so every arm here is a
// DISCLOSURE beside a successful spend.
//
// RE-CUT: stale horizon per A11 (14 days default)
// RE-CUT: finished_at admission per A11 — parseReceipt REQUIRES a string; an unparseable
//   STRING is admitted and surfaces as [receipt_age_unverifiable], a NON-STRING (including an
//   absent field) is [ledger_entry_malformed].
//
// RETIRED: the whole `reviewed_state.completed_at` field contract — v2 has no such field;
//   the range check is re-cut onto finished_at vs started_at (R1-D65).
// RETIRED: the `COMPLETED_AT OUT OF RANGE` / `STALE RECEIPT` / `RECEIPT AGE UNVERIFIABLE` /
//   `NO CONTENT EVIDENCE` banner assertions and the "30.0h old" / "12h" / "1 of the 2"
//   literal-count assertions — converted to [code] tokens and --json `disclosures[].code`.
//   The horizon VALUE is deliberately not pinned: the sheet does not name one, and pinning a
//   number the spec does not state would freeze an implementation detail as a contract.
// RETIRED: arms (c), (d) and (e) (the NO CONTENT EVIDENCE advisory family) — under §6 A9 a
//   path with no usable blob is UNCOVERED, so the verdict is [coverage_incomplete], pinned in
//   commit-reviewed-bytes-refuse.test.mjs R1-D34 and commit-reviewed-bytes-v2-malformed.test.mjs
//   R1-D56/R1-D60. `receipt_bytes_no_evidence` is REMOVED from CODES by sheet amendment A13
//   (unreachable: a path without evidence is uncovered, never mismatched).
// RETIRED: every v1 (flat `at` + `reviewed_state`) fixture — v1 receipts are never spendable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_PATH = join(root, 'scripts', 'commit-reviewed.mjs');

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

const token = (c) => new RegExp('\\[' + c + '\\]');
const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const isoIn = (msFuture) => new Date(Date.now() + msFuture).toISOString();
const DAY = 86_400_000;
// A11: the staleness horizon is `config.review_ledger.stale_days` if present, else 14 days.
// Fixtures age past the DEFAULT (400 days) so no arm depends on the exact default; R1-D63b is
// the only arm that measures the horizon itself.
const PAST_DEFAULT_HORIZON = 400 * DAY;

const CONFIG_BASE = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};
const writeConfig = (dir, extra) => writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ ...CONFIG_BASE, ...extra }));

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-age-'));
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

const ledgerPath = (dir) => join(dir, '.sterling', 'review-ledger.json');
const writeLedger = (dir, entries) => writeFileSync(ledgerPath(dir), JSON.stringify(entries));
const readLedger = (dir) => (existsSync(ledgerPath(dir)) ? JSON.parse(readFileSync(ledgerPath(dir), 'utf8')) : null);
const readLedgerRaw = (dir) => (existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null);
const entryById = (dir, id) => (readLedger(dir) ?? []).find((e) => e.entry_id === id);

function stageChange(dir, relPath, content) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}
function indexBlob(dir, relPath) {
  const out = git(dir, ['ls-files', '-s', '--', relPath]);
  const m = out.match(/^\d+ ([0-9a-f]{40}) \d+\t/);
  assert.ok(m, `fixture guard: ${relPath} must be staged in the index — got ${out}`);
  return m[1];
}
function runCommitReviewed(dir, args = [], env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function trailerValues(dir, key, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`, sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}
const reviewedByTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Reviewed-By-Agent', sha);
function soleJson(r) {
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
    `--json must print exactly ONE JSON object on stdout — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
  return parsed;
}
const codesOf = (out) => (out.disclosures ?? []).map((d) => d.code);
const disclosuresFor = (out, code, id) => (out.disclosures ?? []).filter((d) => d.code === code && JSON.stringify(d).includes(id));

// `OMIT` removes finished_at entirely; a non-string value is passed through verbatim.
const OMIT = Symbol('omit-the-key');
function v2({
  entry_id, agent_type, files, blobs = {}, base_sha,
  started_at = isoAgo(60_000), finished_at = isoAgo(60_000),
}) {
  const e = {
    schema_version: 2, entry_id, kind: 'roster_receipt', status: 'active',
    started_at, finished_at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id: SESSION, branch: 'main', base_sha, agent_id: 'agent-fixture' },
    territory: { files, source: 'review-territory', attribution: 'block' },
    content_evidence: {
      basis: 'stop-time-worktree-snapshot', status: 'complete', blobs,
      absent_paths: [], truncated_of: null, failure_reason: null,
    },
    disposition: null,
  };
  if (finished_at === OMIT) delete e.finished_at;
  return e;
}

const CODE = 'export const f = 1;\n';

// ===========================================================================
// R1-D62 — CONTROL, PLACED FIRST. Rules out "the age checker discloses on every
// receipt" as the explanation for any green arm below.
// ===========================================================================

// EXPECTED: RED today only on the consumed-status assertion; the two doesNotMatch assertions
// pass today under the old banner-free path as well, so this arm's value is as a control.
// SABOTAGE: widen the staleness horizon check to fire on any receipt carrying a finished_at
// -> both doesNotMatch assertions red, and every "still commits" arm below becomes
// unattributable.
test('R1-D62 (CONTROL, first): a receipt finished seconds ago discloses NEITHER receipt_stale NOR receipt_age_unverifiable, and spends normally', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '62000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-fresh', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base, started_at: isoAgo(10_000), finished_at: isoAgo(5_000) })]);

    const r = runCommitReviewed(dir, ['-m', 'D62 fresh receipt', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.ok(!codesOf(out).includes('receipt_stale'), `got ${JSON.stringify(out.disclosures)}`);
    assert.ok(!codesOf(out).includes('receipt_age_unverifiable'), `got ${JSON.stringify(out.disclosures)}`);
    assert.equal(entryById(dir, id).status, 'consumed');
  } finally { cleanup(); }
});

// EXPECTED: RED today — there is no [receipt_stale] code and no disclosures[] array; today's
// STALE RECEIPT text is prose only.
// SABOTAGE (the never-a-refusal half): promote staleness from disclosure to refusal -> exit 1
// and the stamped/consumed assertions red while the code assertion stays green. Age is
// advisory by construction: a stale receipt is still a real review.
test('R1-D63: a receipt finished 400 days ago — well past the 14-day default horizon — discloses [receipt_stale] naming the entry and STILL spends; age never refuses', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '63000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-stale', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base, started_at: isoAgo(PAST_DEFAULT_HORIZON + DAY), finished_at: isoAgo(PAST_DEFAULT_HORIZON) })]);

    const r = runCommitReviewed(dir, ['-m', 'D63 stale receipt', '--json']);
    assert.equal(r.code, 0, `a stale receipt must not refuse — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(disclosuresFor(out, 'receipt_stale', id).length, 1, `exactly one staleness disclosure, naming the entry — got ${JSON.stringify(out.disclosures)}`);
    assert.match(r.stderr, token('receipt_stale'), `and it reaches the human channel too — stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-stale'], 'the stale receipt still stamps');
    assert.equal(entryById(dir, id).status, 'consumed', 'and is still consumed');
  } finally { cleanup(); }
});

// THE HORIZON IS MEASURED HERE, NOT ASSUMED (A11: `config.review_ledger.stale_days` if
// present, else 14 days). ONE fixture, TWO configurations, OPPOSITE verdicts: with
// `stale_days: 1` a 2-day-old receipt is stale; the SAME receipt with no config at all is not,
// because 2 days is inside the 14-day default. Neither arm carries the verdict alone — the
// pair is what proves the config is read rather than a constant being satisfied by luck.
// EXPECTED: RED today — there is no [receipt_stale] code and no configurable horizon.
// SABOTAGE (the hardcode): ignore config.review_ledger.stale_days and always use the default
// -> the override arm goes green-to-red (no disclosure at 2 days) while the default arm stays
// green. SABOTAGE (the inversion): read the config but apply it as hours, or default to 1 day
// -> the default arm reds while the override arm stays green. The two arms fail under
// different one-liners, which is what makes them a measurement and not a restatement.
test('R1-D63b (A11 horizon): config.review_ledger.stale_days OVERRIDES the default — a 2-day-old receipt is [receipt_stale] under stale_days:1 and NOT stale with no config, same fixture both times', { skip: GIT_SKIP }, () => {
  const verdicts = {};
  for (const [label, config] of [['override-1-day', { review_ledger: { stale_days: 1 } }], ['default-14-days', null]]) {
    const { dir, cleanup } = makeRepo();
    try {
      if (config) writeConfig(dir, config);
      stageChange(dir, 'src/laneA.mjs', CODE);
      const base = git(dir, ['rev-parse', 'HEAD']);
      const id = '63b00000-0000-4000-8000-000000000001';
      writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-twodays', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base, started_at: isoAgo(2 * DAY + 1_000), finished_at: isoAgo(2 * DAY) })]);

      const r = runCommitReviewed(dir, ['-m', `D63b ${label}`, '--json']);
      assert.equal(r.code, 0, `[${label}] age never refuses — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.equal(entryById(dir, id).status, 'consumed', `[${label}] and the receipt still spends`);
      verdicts[label] = disclosuresFor(soleJson(r), 'receipt_stale', id).length;
    } finally { cleanup(); }
  }
  assert.equal(verdicts['override-1-day'], 1, `a 2-day-old receipt is stale under stale_days:1 — got ${JSON.stringify(verdicts)}`);
  assert.equal(verdicts['default-14-days'], 0, `and the SAME receipt is not stale under the 14-day default — got ${JSON.stringify(verdicts)}`);
});

// A11 SPLITS WHAT AN EARLIER DRAFT TREATED AS ONE CLASS: parseReceipt REQUIRES a string, so an
// unparseable STRING is ADMITTED (evidence recorded as captured) and only surfaces at spend as
// a disclosure. R1-D66 pins the other half — a NON-STRING is malformed.
// EXPECTED: RED today — the code does not exist and today's warning is prose.
// SABOTAGE: treat an unparseable age as an unspendable receipt -> exit 1 and the consumed
// assertion reds; an unreadable clock is not evidence of a bad review, and refusing on it
// would strand every receipt whose Stop-time clock write was interrupted.
// SECOND SABOTAGE: admit the string but emit no disclosure -> only the disclosure assertion
// reds, which is the half pinning that an unmeasurable age is never silently treated as fresh.
test('R1-D64 (A11): an UNPARSEABLE STRING finished_at ("whenever") is ADMITTED — the receipt spends and discloses [receipt_age_unverifiable]', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '64000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-badclock', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base, finished_at: 'whenever' })]);

    const r = runCommitReviewed(dir, ['-m', 'D64 unparseable string clock', '--json']);
    assert.equal(r.code, 0, `an unreadable age must not refuse — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(disclosuresFor(out, 'receipt_age_unverifiable', id).length, 1, `got ${JSON.stringify(out.disclosures)}`);
    assert.ok(!codesOf(out).includes('ledger_entry_malformed'), `a STRING that will not parse as a date is admitted evidence, not a malformed entry — got ${JSON.stringify(out.disclosures)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-badclock'], 'the receipt still stamps');
    assert.equal(entryById(dir, id).status, 'consumed', 'and is consumed');
  } finally { cleanup(); }
});

// THE LOAD-BEARING ARM (carried over from the retired completed_at family, re-cut onto v2):
// an out-of-range finished_at is DISCARDED, never clamped to `now`, so the age falls back to
// started_at and the receipt still reads as stale.
// EXPECTED: RED today — the field does not exist on v2 fixtures today and neither code does.
// SABOTAGE (measured on the retired arm, and it is why this arm exists): clamp an
// out-of-range finished_at to `now` instead of discarding it -> the age computes as ~0h
// fresh, the [receipt_stale] disclosure disappears, and only that assertion reds. The
// [receipt_age_unverifiable] assertion alone cannot see it, and the pair is what makes the
// discard path observable at all — do not "simplify" this arm to one code.
test('R1-D65: a finished_at OUTSIDE [started_at, now] is DISCARDED, not clamped — [receipt_age_unverifiable] fires AND the age falls back to started_at, so a 400-day-old receipt is still [receipt_stale]', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '65000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({
      entry_id: id, agent_type: 'reviewer-outofrange', files: ['src/laneA.mjs'],
      blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base,
      started_at: isoAgo(PAST_DEFAULT_HORIZON), finished_at: isoIn(400 * 3_600_000),
    })]);

    const r = runCommitReviewed(dir, ['-m', 'D65 out-of-range finished_at', '--json']);
    assert.equal(r.code, 0, `neither an out-of-range clock nor staleness may refuse — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(disclosuresFor(out, 'receipt_age_unverifiable', id).length, 1, `the discard itself is disclosed — this is the assertion proving the field was READ, not silently skipped — got ${JSON.stringify(out.disclosures)}`);
    assert.equal(disclosuresFor(out, 'receipt_stale', id).length, 1, `and the age falls back to started_at (400 days), which a clamp-to-now would have read as ~0 fresh — got ${JSON.stringify(out.disclosures)}`);
    assert.equal(entryById(dir, id).status, 'consumed');
  } finally { cleanup(); }
});

// THE OTHER HALF OF A11's SPLIT: a NON-STRING finished_at is [ledger_entry_malformed] and is
// never spent. Two shapes, one code — an ABSENT field and a JSON-valid hostile object — kept
// together because they are the same distinct failure and because the object shape is also the
// crash probe: `{toString: null}` has no primitive conversion at all.
// EXPECTED: RED today — neither shape is rejected today and there is no code.
// SABOTAGE (the admission half): coerce a non-string with `String(finished_at)` before
// classifying -> the entry is admitted as merely age-unverifiable, spends, and the malformed
// assertions red — which is precisely the difference A11 draws between "recorded oddly" and
// "not a receipt".
// SABOTAGE (the crash half): interpolate the raw value into any message template -> the object
// arm throws `TypeError: Cannot convert object to primitive value` before printing valid JSON,
// and the no-crash assertion reds first, before any verdict can be read.
test('R1-D66 (A11): a NON-STRING finished_at — absent, or a hostile {toString:null} object — is [ledger_entry_malformed], never spent, and never crashes the CLI', { skip: GIT_SKIP }, () => {
  for (const [label, finished_at] of [['absent', OMIT], ['hostile-object', { toString: null }]]) {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneA.mjs', CODE);
      const base = git(dir, ['rev-parse', 'HEAD']);
      const id = '66000000-0000-4000-8000-000000000001';
      writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-noclock', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base, finished_at })]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['-m', `D66 ${label}`]);
      assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${label}] no raw-interpolation crash may leak — stderr=${flat(r.stderr)}`);
      assert.equal(r.code, 1, `[${label}] a malformed entry is not a candidate, and it is the only entry — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      const combined = `${r.stdout}\n${r.stderr}`;
      assert.match(combined, token('ledger_entry_malformed'), `[${label}] the shape defect is NAMED — stderr=${flat(r.stderr)}`);
      assert.doesNotMatch(combined, token('receipt_age_unverifiable'), `[${label}] a non-string clock is not an unreadable clock — different code, different remedy — stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), base, `[${label}] no commit`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] ledger byte-identical`);
    } finally { cleanup(); }
  }
});
