// ATTESTATION-DISCLOSURE WIRING (R1 pin re-cut, group D — CONTRACTS KEPT WHOLE).
//
// The SHARED INSPECTOR is pinned by attestation-inspection.test.mjs; this file pins the
// SURFACE: that commit-reviewed reads the declaration, takes a rename-safe touched set,
// prints one rollup per declaration, degrades to ONE loud line, and — the load-bearing one —
// never costs a commit (decision `attestation-staleness-disclosure-only-never-a-refusing-gate`,
// 1f069af4 v2; board attestation-gate 9868a0dd).
//
// WHAT THE R1 RE-CUT CHANGED HERE, AND ONLY THIS: the ledger fixtures are ReceiptV2 covering
// every staged path with its INDEX blob (v1 entries are no longer spendable, and the byte rule
// now compares the index — decision 24dc4c63), and "the ledger is consumed" is asserted as the
// status transition rather than as an emptied array. The ATTESTATION assertions themselves are
// UNCHANGED: the attestation disclosure surface is outside the R1 refusal/disclosure code set
// (contract sheet §1.4 defines no attestation codes), so converting its rollup vocabulary to
// [code] tokens would be inventing codes the sheet does not define. REPORTED as such.
//
// NOTE FOR THE R1 REVIEW: the `REFUSED TO REBASELINE` family named in the R1 brief for this
// file was never here — it lived in scripts/tests/h22-review-ledger.test.mjs (another group's
// territory). Sheet amendment A14 then REMOVED `attestation_rebaseline_refused` from CODES
// altogether: the only mechanism that emitted it was H22's refresh path, which the rebuild
// deletes. There is nothing left to convert, here or anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '@sterling/schemas';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_PATH = join(root, 'scripts', 'commit-reviewed.mjs');
const NOW = '2026-08-31T09:00:00.000Z';
const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-attestation-wiring-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  mkdirSync(join(dir, 'renders'), { recursive: true });
  writeFileSync(join(dir, 'renders', 'base.png'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// v2-shaped fixture table (same DDL the inspector suite uses) — fixture setup, never store code.
const RECORDS_V2_DDL = `
  CREATE TABLE records (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, superseded_by TEXT,
    lifecycle TEXT NOT NULL DEFAULT 'live', freshness TEXT NOT NULL DEFAULT 'fresh',
    version INTEGER NOT NULL DEFAULT 1, scope TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, author TEXT NOT NULL, derived_unconfirmed INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL
  );
`;

function writeAttestationStore(dir, attestations) {
  const dbPath = join(dir, '.sterling', 'sterling.db');
  const db = new DatabaseSync(dbPath);
  db.exec(RECORDS_V2_DDL);
  const stmt = db.prepare(
    `INSERT INTO records (id, type, status, superseded_by, lifecycle, freshness, version, scope, created_at, updated_at, author, derived_unconfirmed, body)
     VALUES (?, 'attestation', 'active', NULL, 'live', 'fresh', 1, 'project', ?, ?, 'user', 0, ?)`
  );
  for (const a of attestations) {
    const id = a.id ?? randomUUID();
    stmt.run(
      id, NOW, NOW,
      JSON.stringify({
        id, type: 'attestation', created_at: NOW, updated_at: NOW, author: 'user', status: 'active',
        superseded_by: null, lifecycle: 'live', freshness: 'fresh', version: 1, links: [], scope: 'project',
        stack_tags: [], artifact_key: a.artifact_key ?? 'artifact', verdict: a.verdict ?? 'approved',
        inspector: 'human-tester', inspected_at: a.inspected_at ?? '2026-08-20', file_keys: a.file_keys ?? [],
      })
    );
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return dbPath;
}

function writeConfig(dir, globs) {
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ attestation_path_globs: globs }));
}
const ledgerPath = (dir) => join(dir, '.sterling', 'review-ledger.json');
const writeLedger = (dir, entries) => writeFileSync(ledgerPath(dir), JSON.stringify(entries));
const readLedger = (dir) => (existsSync(ledgerPath(dir)) ? JSON.parse(readFileSync(ledgerPath(dir), 'utf8')) : null);

// A ReceiptV2 that covers EVERY currently-staged path with its index blob, so no arm in this
// file can fail for a coverage or byte reason unrelated to its own subject. A staged path with
// no index entry (a deletion) is recorded in `absent_paths`, which is the deletion sentinel
// decision 57984926 §1 defines.
function receiptCoveringStaged(dir, entry_id = 'a77e0000-0000-4000-8000-000000000001') {
  const names = git(dir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  const blobs = {};
  const absent_paths = [];
  for (const p of names) {
    const m = git(dir, ['ls-files', '-s', '--', p]).match(/^\d+ ([0-9a-f]{40}) \d+\t/);
    if (m) blobs[p] = m[1]; else absent_paths.push(p);
  }
  return {
    schema_version: 2, entry_id, kind: 'roster_receipt', status: 'active',
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    reviewer: { agent_type: 'reviewer-correctness', model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id: SESSION, branch: 'main', base_sha: git(dir, ['rev-parse', 'HEAD']), agent_id: 'agent-attestation' },
    territory: { files: names, source: 'review-territory', attribution: 'block' },
    content_evidence: {
      basis: 'stop-time-worktree-snapshot', status: 'complete', blobs,
      absent_paths, truncated_of: null, failure_reason: null,
    },
    disposition: null,
  };
}
const seedReceipt = (dir, id) => writeLedger(dir, [receiptCoveringStaged(dir, id)]);

function runCommitReviewed(dir, args) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...ENV_SESSION },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const disclosureLines = (stderr) => stderr.split('\n').filter((l) => /ATTESTATION/.test(l));

// W1 — DORMANT CONTROL, placed first: without it, a wiring that never emits anything would
// pass W3/W4 identically.
test('R1-D120 / W1 [dormant control]: with attestation_path_globs empty, a commit prints NO attestation output and reports an EMPTY array', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeConfig(dir, []);
    writeAttestationStore(dir, [{ file_keys: ['renders/scene.png'], verdict: 'approved' }]);
    writeFileSync(join(dir, 'renders', 'scene.png'), 'v1\n');
    git(dir, ['add', '-A']);
    seedReceipt(dir);

    const r = runCommitReviewed(dir, ['-m', 'render change']);
    assert.equal(r.code, 0, `dormant project must still commit — stderr=${r.stderr}`);
    assert.deepEqual(disclosureLines(r.stderr), [], 'a dormant project prints NOTHING about attestations');
    assert.deepEqual(JSON.parse(r.stdout).attestation_disclosure, [], 'the report field is present and empty, never omitted');
  } finally { cleanup(); }
});
// SABOTAGE: emit the rollup whenever the store is readable, ignoring the declaration list.
// EXPECTED RED: disclosureLines is non-empty despite zero declared globs.

// W2 — the rollup itself, both channels.
test('R1-D121 / W2 [rollup]: a declared glob whose paths this commit touches produces ONE rollup block, in stderr AND in the JSON report', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeConfig(dir, ['renders/**']);
    writeAttestationStore(dir, [
      { file_keys: ['renders/scene.png'], verdict: 'approved' },
      { file_keys: ['renders/other.png'], verdict: 'rejected' },
    ]);
    writeFileSync(join(dir, 'renders', 'scene.png'), 'v1\n');
    writeFileSync(join(dir, 'renders', 'other.png'), 'v1\n');
    writeFileSync(join(dir, 'renders', 'fresh.png'), 'v1\n');
    git(dir, ['add', '-A']);
    seedReceipt(dir);

    const r = runCommitReviewed(dir, ['-m', 'render change']);
    assert.equal(r.code, 0, `an advisory must never cost a commit — stderr=${r.stderr}`);
    const lines = disclosureLines(r.stderr);
    assert.equal(lines.length, 1, `exactly one rollup block for one declaration: ${JSON.stringify(lines)}`);
    const line = lines[0];
    assert.match(line, /renders\/\*\*/, 'the block names the DECLARATION it reports on');
    assert.match(line, /3 touched path/, 'counts the touched paths under that declaration');
    assert.match(line, /2 have a comparable human record/, 'says "comparable human record", never "covered"');
    assert.match(line, /approved 1, rejected 1, needs_rework 0/, 'carries the verdict DISTRIBUTION, not just a count');
    assert.match(line, /1 have NO comparable human record/, 'names the no-record count');
    assert.match(line, /UNPROVABLE/, 'states that currency against the staged bytes is unprovable');
    assert.match(line, /no commit\/blob\/render binding/, 'says WHY currency is unprovable');
    assert.match(line, /Advisory only — never a refusal/, 'says it is advisory');
    assert.deepEqual(JSON.parse(r.stdout).attestation_disclosure, lines, 'stdout report carries exactly the printed lines');
  } finally { cleanup(); }
});
// SABOTAGE: route the lines through the ordinary disclosure emitter (so they land in
// disclosures[]) instead of the distinct emitter + attestation_disclosure field.
// EXPECTED RED: the final deepEqual fails — attestation_disclosure is [] while the lines printed.

// W3 — unavailable: ONE line per INVOCATION, not one per declaration.
test('R1-D122 / W3 [unavailable]: declared globs with NO attestation store print exactly ONE loud unavailable line, and the commit still lands', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeConfig(dir, ['renders/**', 'art/**']);
    assert.equal(existsSync(join(dir, '.sterling', 'sterling.db')), false, 'precondition: no store');
    writeFileSync(join(dir, 'renders', 'scene.png'), 'v1\n');
    git(dir, ['add', '-A']);
    seedReceipt(dir);

    const r = runCommitReviewed(dir, ['-m', 'render change']);
    assert.equal(r.code, 0, `an unreadable store must never cost a commit — stderr=${r.stderr}`);
    const lines = disclosureLines(r.stderr);
    assert.equal(lines.length, 1, `ONE line per invocation, never one per declaration: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /UNAVAILABLE/, 'the single line names the unavailability');
    assert.match(lines[0], /Advisory only — never a refusal/, 'even the degraded line says it is advisory');
    assert.deepEqual(JSON.parse(r.stdout).attestation_disclosure, lines, 'the degraded line reaches the JSON report too');
  } finally { cleanup(); }
});
// SABOTAGE: render the unavailable notice per declared glob instead of once.
// EXPECTED RED: lines.length is 2, not 1.

// W4 — FAIL-OPEN, the load-bearing pin.
test('R1-D123 / W4 [fail-open]: a store that cannot be opened at all does not block the commit — it lands, stamped and consumed, with the failure disclosed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeConfig(dir, ['renders/**']);
    writeFileSync(join(dir, '.sterling', 'sterling.db'), 'this is not a sqlite database at all\n');
    writeFileSync(join(dir, 'renders', 'scene.png'), 'v1\n');
    git(dir, ['add', '-A']);
    const id = 'a77e0000-0000-4000-8000-000000000004';
    seedReceipt(dir, id);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'render change']);
    assert.equal(r.code, 0, `fail-open: the disclosure may lose its voice, never the commit — stderr=${r.stderr}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, beforeHead, 'the commit genuinely landed');
    const trailers = git(dir, ['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)']);
    assert.match(trailers, /reviewer-correctness/, 'the review trailer is stamped exactly as it would be without this feature');
    const entry = (readLedger(dir) ?? []).find((e) => e.entry_id === id);
    assert.equal(entry?.status, 'consumed', 'the receipt is consumed exactly as it would be');
    assert.equal(entry?.consumption?.commit_sha, head, 'and bound to this commit');
    assert.equal(disclosureLines(r.stderr).length, 1, 'the failure is disclosed, in one line');
  } finally { cleanup(); }
});
// SABOTAGE: remove the try/catch around the disclosure computation (or let the inspector throw
// instead of returning {available:false}).
// EXPECTED RED: exit is non-zero and HEAD is unmoved — a disclosure has cost a commit.

// W5 — rename-safe touched set (--no-renames).
// R1 NOTE: this arm stages a DELETION (the rename's old spelling), which is COVERABLE through
// content_evidence.absent_paths (contract sheet §6 A13) — `receiptCoveringStaged` records it
// there, so the receipt covers both halves of the rename and this arm's verdict is about the
// attestation rollup alone. The deletion contract itself is pinned by
// commit-reviewed-bytes-refuse.test.mjs R1-D124a/b/c.
test('R1-D128 / W5 [rename-safe]: a renamed attested path is disclosed as BOTH a comparable-record path and a new no-record path (--no-renames)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeConfig(dir, ['renders/**']);
    writeFileSync(join(dir, 'renders', 'scene.png'), 'v1\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'add scene']);
    writeAttestationStore(dir, [{ file_keys: ['renders/scene.png'], verdict: 'approved' }]);
    git(dir, ['mv', 'renders/scene.png', 'renders/scene-final.png']);
    seedReceipt(dir);

    const r = runCommitReviewed(dir, ['-m', 'rename the render']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const line = disclosureLines(r.stderr)[0];
    assert.match(line, /2 touched path/, 'a rename is TWO touched paths (delete + add), never one destination — the inspected path must not silently follow');
    assert.match(line, /1 have a comparable human record/, 'the OLD path keeps its record');
    assert.match(line, /1 have NO comparable human record/, 'the NEW path has none');
    assert.match(line, /renders\/scene-final\.png \[no comparable record\]/, 'the new spelling is shown as having no record');
  } finally { cleanup(); }
});
// SABOTAGE (VERIFIED 2026-09-01, applied and confirmed present before reading the result):
// drop --no-renames from the staged-diff invocation in commit-reviewed.mjs.
// EXPECTED RED — and this is exactly what happened: "1 touched path(s); 0 have a comparable
// human record", the attested old path gone entirely.

// W6 — defective declaration is DISCLOSED, never refused.
test('R1-D125 / W6 [defective declaration is DISCLOSED, never refused]: duplicate + empty globs neither refuse the config nor the commit, and the drop is named', { skip: GIT_SKIP }, () => {
  // (a) the SCHEMA must accept them — an advisory field that refuses at parseConfig kills
  // direct-merge/merge-gate before any fail-open wrapper runs.
  assert.deepEqual(
    parseConfig({ attestation_path_globs: ['renders/**', 'renders/**', ''] }).attestation_path_globs,
    ['renders/**', 'renders/**', ''],
    'the config schema must NOT refuse duplicates or empty strings — tolerance lives in readAttestationGlobs, not in a refusal'
  );

  const { dir, cleanup } = makeRepo();
  try {
    writeConfig(dir, ['renders/**', 'renders/**', '']);
    writeAttestationStore(dir, [{ file_keys: ['renders/scene.png'], verdict: 'approved' }]);
    writeFileSync(join(dir, 'renders', 'scene.png'), 'v1\n');
    git(dir, ['add', '-A']);
    seedReceipt(dir);

    const r = runCommitReviewed(dir, ['-m', 'render change']);
    assert.equal(r.code, 0, `a defective declaration must never cost a commit — stderr=${r.stderr}`);
    const lines = disclosureLines(r.stderr);
    const defect = lines.filter((l) => /DECLARATION DEFECT/.test(l));
    assert.equal(defect.length, 1, `the drop is disclosed exactly once: ${JSON.stringify(lines)}`);
    assert.match(defect[0], /1 exact duplicate/, 'names the duplicate it dropped');
    assert.match(defect[0], /1 empty string/, 'names the empty entry it dropped');
    assert.match(defect[0], /DROPPED, NOT REFUSED/, 'says explicitly that it did not refuse');
    assert.equal(lines.filter((l) => /ATTESTATION DISCLOSURE —/.test(l)).length, 1, 'the duplicate declaration produces ONE rollup, not two');
  } finally { cleanup(); }
});
// SABOTAGE: restore a refusing refinement on the config field (.min(1) or a duplicate check).
// EXPECTED RED: the parseConfig assertion throws — and on the merge surfaces that same throw
// is a dead merge command, which is the defect this pin exists for.

// W7 — the inspector opens the LIVE store read-only in place.
test('R1-D126 / W7 [no app-level store contact]: a commit-time inspection adds no file of its own to the store directory and leaves the db bytes identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeConfig(dir, ['renders/**']);
    const dbPath = writeAttestationStore(dir, [{ file_keys: ['renders/scene.png'], verdict: 'approved' }]);
    const sterlingDir = join(dir, '.sterling');
    const beforeDb = readFileSync(dbPath);

    writeFileSync(join(dir, 'renders', 'scene.png'), 'v1\n');
    git(dir, ['add', '-A']);
    seedReceipt(dir);
    // Snapshot AFTER the fixture's own ledger write — the ledger (and its rewrite by
    // commit-reviewed's finalize) is the CLI's territory, not the inspector's; this pin
    // watches only for files the INSPECTOR adds.
    const beforeEntries = new Set(readdirSync(sterlingDir));
    const r = runCommitReviewed(dir, ['-m', 'render change']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.equal(disclosureLines(r.stderr).length, 1, 'sanity: the inspection genuinely ran and read the store');

    const ALLOWED_NEW = new Set(['sterling.db-wal', 'sterling.db-shm', 'review-ledger.lock']);
    const strays = readdirSync(sterlingDir).filter((f) => !beforeEntries.has(f) && !ALLOWED_NEW.has(f));
    assert.deepEqual(strays, [], 'any NEW entry beyond SQLite-managed sidecars and the ledger lock is a file this module wrote itself — forbidden (no temp copy, no backup, no scratch file)');
    assert.deepEqual(readFileSync(dbPath), beforeDb, 'the live store bytes are untouched (readOnly open, no journal-mode pragma)');
  } finally { cleanup(); }
});
// SABOTAGE: reinstate the copy protocol (write a scratch/temp copy beside the store), or open
// the db WRITABLE (its close checkpoints, changing the bytes).
// EXPECTED RED: the strays filter (copy) or the byte comparison (writable open).

// W8 — invalid container tolerated + disclosed.
test('R1-D127 / W8 [invalid container]: a bracket-less "attestation_path_globs": "renders/**" refuses neither parseConfig nor the commit — dormant WITH disclosure', { skip: GIT_SKIP }, () => {
  assert.equal(
    parseConfig({ attestation_path_globs: 'renders/**' }).attestation_path_globs, 'renders/**',
    'a non-array value must parse AND survive verbatim — any refusal here kills direct-merge/merge-gate before their fail-open wrapper exists'
  );

  const { dir, cleanup } = makeRepo();
  try {
    writeConfig(dir, 'renders/**'); // note: raw value, not an array
    writeFileSync(join(dir, 'renders', 'scene.png'), 'v1\n');
    git(dir, ['add', '-A']);
    seedReceipt(dir);

    const r = runCommitReviewed(dir, ['-m', 'render change']);
    assert.equal(r.code, 0, `a bracket-less hand-edit must never cost a commit — stderr=${r.stderr}`);
    const lines = disclosureLines(r.stderr);
    const defect = lines.filter((l) => /DECLARATION DEFECT/.test(l));
    assert.equal(defect.length, 1, `the malformed container is disclosed exactly once: ${JSON.stringify(lines)}`);
    assert.match(defect[0], /not a LIST/, 'names the container shape as the defect');
    assert.match(defect[0], /DROPPED, NOT REFUSED/, 'says explicitly that it did not refuse');
    assert.equal(lines.filter((l) => /ATTESTATION DISCLOSURE —/.test(l)).length, 0, 'nothing usable was declared, so there is no rollup');
    assert.deepEqual(JSON.parse(r.stdout).attestation_disclosure, lines, 'the disclosure reaches the JSON report');
  } finally { cleanup(); }
});
// SABOTAGE: restore a typed/refusing schema for the field, or drop the invalid_container arm
// from readAttestationGlobs (silent dormancy).
// EXPECTED RED: the parseConfig assertion throws, or the defect line count is 0.
