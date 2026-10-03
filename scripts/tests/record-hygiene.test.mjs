// Contract tests for the record-hygiene REPORTING arm (board 7a75851c step 3;
// decisions record-audit-dead-records-superseded-stale-findings-by-age-report-arm-
// plus-sampled-audit and make-records-findable-authoring-rule-disclosure-lint-then-
// blind-experiment, part 3 of each). The arm lists findings and NEVER fails the
// battery: every exit below is 0.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRecords, pathLive, FILLER_WORDS } from '../lib/record-hygiene.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-10-03T12:00:00.000Z';
const base = (type, extra = {}) => ({
  id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
  superseded_by: null, links: [], scope: 'project', stack_tags: [], ...extra,
});
const decision = (extra = {}) =>
  base('decision', {
    title: 'Latch widgets rotate nightly', statement: 'Latch widgets rotate nightly', alternatives_rejected: [],
    rationale: 'r', file_keys: ['src/a.mjs'], ...extra,
  });
const article = (extra = {}) =>
  base('feature_article', {
    slug: 'a', title: 'A', what_it_does: 'x', intended_behavior: 'y', files: [{ path: 'src/a.mjs', role: 'r' }],
    article_kind: 'feature', current_ac: [], live_test_refs: [], history: [], state: 'active', ...extra,
  });

const HEAD_FILES = new Set(['src/a.mjs', 'src/dir/b.mjs', 'tests/a.test.mjs']);
const live = (p) => pathLive(p, HEAD_FILES);
const kinds = (r) => r.findings.map((f) => f.kind).sort();

test('pathLive: exact file and directory prefix are live; absent and traversal are not', () => {
  assert.equal(live('src/a.mjs'), true);
  assert.equal(live('src/dir'), true);
  assert.equal(live('src/dir/'), true);
  assert.equal(live('src/gone.mjs'), false);
  assert.equal(live('src/di'), false);
});

test('dead file_keys on a decision are reported with the record and the path', () => {
  const r = auditRecords([decision({ file_keys: ['src/a.mjs', 'src/gone.mjs'] })], { headFiles: HEAD_FILES });
  assert.deepEqual(kinds(r), ['dead_path']);
  assert.match(r.findings[0].detail, /src\/gone\.mjs/);
  assert.equal(r.findings[0].type, 'decision');
});

test('dead article files[] and dead reference location (kind doc only) are reported; url and pdf are not paths', () => {
  const art = article({ files: [{ path: 'src/a.mjs', role: 'r' }, { path: 'src/old.mjs', role: 'r' }] });
  const refDoc = base('reference_material', { title: 'Doc', kind: 'doc', location: 'docs/gone.md', summary: 's' });
  const refUrl = base('reference_material', { title: 'Url', kind: 'url', location: 'https://example.com/x', summary: 's' });
  const r = auditRecords([art, refDoc, refUrl], { headFiles: HEAD_FILES });
  assert.deepEqual(kinds(r), ['dead_path', 'dead_path']);
  assert.ok(r.findings.some((f) => /src\/old\.mjs/.test(f.detail)));
  assert.ok(r.findings.some((f) => /docs\/gone\.md/.test(f.detail)));
});

test('a type that carries file paths but has none is reported; reference url is exempt', () => {
  const r = auditRecords(
    [decision({ file_keys: [] }), base('reference_material', { title: 'U', kind: 'url', location: 'https://x.y', summary: 's' })],
    { headFiles: HEAD_FILES }
  );
  assert.deepEqual(kinds(r), ['no_file_paths']);
});

test('article ACs: missing live_test_ref reported; untestable_because and a covered AC are not', () => {
  const art = article({
    current_ac: [
      { ac_id: 'AC1', text: 'covered', verifiable_at: 'final' },
      { ac_id: 'AC2', text: 'uncovered', verifiable_at: 'final' },
      { ac_id: 'AC3', text: 'cannot', verifiable_at: 'final', untestable_because: { reason: 'r', blocking_record_id: randomUUID() } },
      { ac_id: 'AC4', text: 'empty paths', verifiable_at: 'final' },
    ],
    live_test_refs: [{ ac_id: 'AC1', test_paths: ['tests/a.test.mjs'] }, { ac_id: 'AC4', test_paths: [] }],
  });
  const r = auditRecords([art], { headFiles: HEAD_FILES });
  const missing = r.findings.filter((f) => f.kind === 'ac_without_test_ref');
  assert.equal(missing.length, 2);
  assert.ok(missing.some((f) => /AC2/.test(f.detail)));
  assert.ok(missing.some((f) => /AC4/.test(f.detail)));
  assert.ok(!missing.some((f) => /AC1|AC3/.test(f.detail)));
});

test('live_test_refs naming a test path absent at HEAD are reported', () => {
  const art = article({
    current_ac: [{ ac_id: 'AC1', text: 't', verifiable_at: 'final' }],
    live_test_refs: [{ ac_id: 'AC1', test_paths: ['tests/a.test.mjs', 'tests/deleted.test.mjs'] }],
  });
  const r = auditRecords([art], { headFiles: HEAD_FILES });
  assert.deepEqual(kinds(r), ['dead_test_path']);
  assert.match(r.findings[0].detail, /tests\/deleted\.test\.mjs/);
});

test('the not_applicable exemption on current_ac or live_test_refs is skipped, not crashed on', () => {
  const art = article({
    article_kind: 'probe',
    current_ac: { not_applicable: { reason: 'r' } },
    live_test_refs: { not_applicable: { reason: 'r' } },
  });
  assert.deepEqual(auditRecords([art], { headFiles: HEAD_FILES }).findings, []);
});

test('records sharing an identical central-term set are grouped, naming every member', () => {
  const a = decision({ slug: 'one', title: 'Latch widgets rotate nightly', statement: 'Latch widgets rotate nightly' });
  const b = decision({ slug: 'two', title: 'Rotate nightly latch widgets', statement: 'Rotate nightly latch widgets' });
  const c = decision({ slug: 'three', title: 'Completely different subject matter', statement: 'Completely different subject matter' });
  const r = auditRecords([a, b, c], { headFiles: HEAD_FILES });
  const shared = r.findings.filter((f) => f.kind === 'shared_central_terms');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].ids.length, 2);
  assert.ok(shared[0].ids.includes(a.id) && shared[0].ids.includes(b.id));
});

test('filler words among a record central terms are reported; the list is data', () => {
  assert.ok(Array.isArray(FILLER_WORDS) && FILLER_WORDS.length > 0);
  const filler = FILLER_WORDS[0];
  const r = auditRecords(
    [decision({ title: `Latch widgets ${filler} ${filler} rotate`, statement: `Latch widgets ${filler} ${filler} rotate` })],
    { headFiles: HEAD_FILES }
  );
  const f = r.findings.find((x) => x.kind === 'filler_central_terms');
  assert.ok(f, 'a filler central term must be reported');
  assert.match(f.detail, new RegExp(filler));
});

test('a GENERIC_DEV_TERMS-only word among the central terms is not filler', async () => {
  const { GENERIC_DEV_TERMS, recordCentralTerms } = await import('@sterling/store');
  const generic = 'test';
  assert.ok(GENERIC_DEV_TERMS.has(generic) && !FILLER_WORDS.includes(generic));
  const rec = decision({ title: `Latch widgets ${generic} ${generic} rotate`, statement: `Latch widgets ${generic} ${generic} rotate` });
  assert.ok(recordCentralTerms(rec).includes(generic), 'the generic word must really be a central term here');
  assert.deepEqual(auditRecords([rec], { headFiles: HEAD_FILES }).findings, []);
});

test('a clean record yields no findings and the counts cover every kind', () => {
  const r = auditRecords([decision()], { headFiles: HEAD_FILES });
  assert.deepEqual(r.findings, []);
  assert.equal(r.scanned, 1);
});

// ---- the arm itself, against a fixture project ----
let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import('@sterling/store'));
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-hygiene-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export {};\n');
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('add', 'src/a.mjs');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  return dir;
}
const runArm = (dir, ...extra) =>
  spawnSync(process.execPath, [join(root, 'scripts', 'check-record-hygiene.mjs'), dir, ...extra], {
    encoding: 'utf8', cwd: dir, timeout: 120_000,
  });

test('arm: reports dead paths loudly, exits 0 anyway, and never writes the store', () => {
  const dir = fixture();
  try {
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    store.create(decision({ file_keys: ['src/a.mjs', 'src/gone.mjs'] }));
    store.close();
    const before = spawnSync('sha256sum', [join(dir, '.sterling', 'sterling.db')], { encoding: 'utf8' }).stdout;
    const r = runArm(dir);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /record hygiene: 1 finding\(s\)/);
    assert.match(r.stdout, /REPORTING ONLY/);
    assert.match(r.stdout, /dead_path/);
    assert.match(r.stdout, /src\/gone\.mjs/);
    const after = spawnSync('sha256sum', [join(dir, '.sterling', 'sterling.db')], { encoding: 'utf8' }).stdout;
    assert.equal(after, before, 'the arm must not change the store file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arm: a clean store says so; no store and an empty store are loud skips, all exit 0', () => {
  const dir = fixture();
  try {
    const none = runArm(dir);
    assert.equal(none.status, 0);
    assert.match(none.stdout, /skipped/);

    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const empty = runArm(dir);
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /skipped/);

    store.create(decision());
    store.close();
    const clean = runArm(dir);
    assert.equal(clean.status, 0);
    assert.match(clean.stdout, /record hygiene: 0 finding\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arm: outside a git repo it reports it could not run and still exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-hygiene-nogit-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    store.create(decision());
    store.close();
    const r = runArm(dir);
    assert.equal(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /could not run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
