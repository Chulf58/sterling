// Handoff projection (decision
// init-prepares-opencode-portable-agents-and-target-handoff-projections, refinements
// (a) and (e)-(g)): a target project's own store projected into committed files an
// engineer WITHOUT Sterling can read — root architecture.md / rulings.md as indexes,
// docs/sterling/<type>/<slug>.md carrying each record's complete text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SterlingStore } from '@sterling/store';
import { buildHandoffFiles } from '../lib/handoff-projection.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-09-24T12:00:00.000Z';

const base = (type) => ({
  id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
  superseded_by: null, links: [], scope: 'project', stack_tags: [],
});

const ARTICLE = {
  ...base('feature_article'), id: 'aaaaaaaa-0000-4000-8000-000000000001',
  slug: 'order-import',
  title: 'Order import — pulls orders from the shop API',
  what_it_does: 'Fetches new orders every five minutes and writes them to the orders table. The queue redelivers on failure.',
  intended_behavior: 'An order is imported exactly once.',
  files: [
    { path: 'src/importer/fetch.ts', role: 'calls the shop API' },
    { path: 'src/importer/write.ts', role: 'writes rows' },
  ],
  current_ac: [{ ac_id: 'AC1', text: 'a redelivered order is not duplicated', verifiable_at: 'final' }],
  dependencies: { relies_on: [], relied_by: [] }, state: 'active', history: [{ date: NOW, event: 'created' }], live_test_refs: [],
};
const DECISION = {
  ...base('decision'), id: 'bbbbbbbb-0000-4000-8000-000000000002',
  slug: 'importer-has-no-retry-loop',
  title: 'The importer has no retry loop; the queue redelivers',
  statement: 'The importer calls the shop API once per order and never retries.',
  rationale: 'Retries duplicated orders when the API timed out after committing.',
  alternatives_rejected: [{ option: 'Exponential backoff in the importer', reason: 'Duplicates on a late commit.' }],
  file_keys: ['src/importer/fetch.ts'],
};
const ANTI_PATTERN = {
  ...base('anti_pattern'), id: 'cccccccc-0000-4000-8000-000000000003',
  slug: 'mocking-the-shop-api-clock',
  title: 'Mocking the shop API clock in importer tests',
  trigger: 'Writing an importer test that needs a timeout.',
  guidance: 'Use the fake transport instead.',
  wrong_way: 'Stubbing Date.now globally.',
  right_way: 'Inject the FakeTransport with a scripted delay.',
  source_evidence: 'flaky CI run',
  severity: 'warn',
  file_keys: [],
};

function fixture({ records = [ARTICLE, DECISION, ANTI_PATTERN], config = {}, store = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-handoff-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'fixture', ...config }, null, 2) + '\n');
  if (store) {
    const s = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    for (const r of records) s.create(r);
    s.close();
  }
  return dir;
}

function project(dir, env = {}) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'handoff-projection.mjs'), dir], {
    encoding: 'utf8', cwd: dir, timeout: 120_000, env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).replace(/\\/g, '/'));
    }
  };
  for (const top of ['architecture.md', 'rulings.md']) if (existsSync(join(dir, top))) out.push(top);
  if (existsSync(join(dir, 'docs'))) walk(join(dir, 'docs'));
  return out.sort();
}
const snapshot = (dir) => Object.fromEntries(listTree(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

const EXPECTED_FILES = [
  'architecture.md',
  'docs/sterling/anti-patterns/mocking-the-shop-api-clock-cccccccc.md',
  'docs/sterling/articles/order-import-aaaaaaaa.md',
  'docs/sterling/decisions/importer-has-no-retry-loop-bbbbbbbb.md',
  'rulings.md',
];

test('projects indexes at the root and one COMPLETE record file per record under docs/sterling/', () => {
  const dir = fixture();
  try {
    const r = project(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /handoff projection: written/);
    assert.deepEqual(listTree(dir), EXPECTED_FILES);

    const article = readFileSync(join(dir, 'docs/sterling/articles/order-import-aaaaaaaa.md'), 'utf8');
    for (const text of [ARTICLE.title, ARTICLE.what_it_does, ARTICLE.intended_behavior, '`src/importer/fetch.ts` — calls the shop API', '`src/importer/write.ts` — writes rows', 'a redelivered order is not duplicated']) {
      assert.ok(article.includes(text), `article file carries: ${text}`);
    }
    const decision = readFileSync(join(dir, 'docs/sterling/decisions/importer-has-no-retry-loop-bbbbbbbb.md'), 'utf8');
    for (const text of [DECISION.statement, DECISION.rationale, 'Exponential backoff in the importer', 'Duplicates on a late commit.', '`src/importer/fetch.ts`']) {
      assert.ok(decision.includes(text), `decision file carries: ${text}`);
    }
    const anti = readFileSync(join(dir, 'docs/sterling/anti-patterns/mocking-the-shop-api-clock-cccccccc.md'), 'utf8');
    for (const text of [ANTI_PATTERN.trigger, ANTI_PATTERN.guidance, ANTI_PATTERN.wrong_way, ANTI_PATTERN.right_way]) {
      assert.ok(anti.includes(text), `anti-pattern file carries: ${text}`);
    }

    const arch = readFileSync(join(dir, 'architecture.md'), 'utf8');
    assert.match(arch, /DO NOT EDIT/);
    assert.match(arch, /^## src\/importer$/m, 'grouped by area (path prefix)');
    assert.ok(arch.includes('[Order import — pulls orders from the shop API](docs/sterling/articles/order-import-aaaaaaaa.md)'), 'index links the full record');
    assert.ok(arch.includes('`src/importer/fetch.ts`'), 'index names the owning paths');
    const rulings = readFileSync(join(dir, 'rulings.md'), 'utf8');
    assert.ok(rulings.includes('(docs/sterling/decisions/importer-has-no-retry-loop-bbbbbbbb.md)'));
    assert.ok(rulings.includes('(docs/sterling/anti-patterns/mocking-the-shop-api-clock-cccccccc.md)'));
    assert.match(rulings, /^## No file paths$/m, 'a record with no file keys gets its own section');
    for (const f of EXPECTED_FILES) {
      assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, `${f}: no timestamp`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deterministic: a second run is byte-identical and writes nothing', () => {
  const dir = fixture();
  try {
    assert.equal(project(dir).code, 0);
    const first = snapshot(dir);
    const mtimes = Object.fromEntries(EXPECTED_FILES.map((f) => [f, statSync(join(dir, f)).mtimeMs]));
    const r = project(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /handoff projection: unchanged/);
    assert.deepEqual(snapshot(dir), first);
    for (const f of EXPECTED_FILES) assert.equal(statSync(join(dir, f)).mtimeMs, mtimes[f], `${f} not rewritten`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registers the generated FILES (not a glob) in config.generated_projections, keeping other keys and entries', () => {
  const dir = fixture({ config: { generated_projections: ['docs/api.md'], delegation: { max_concurrent: 3 } } });
  try {
    assert.equal(project(dir).code, 0);
    const config = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.deepEqual(config.generated_projections, ['docs/api.md', ...EXPECTED_FILES]);
    assert.deepEqual(config.delegation, { max_concurrent: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Sol review: registration removed EVERY entry under docs/sterling/, including
// ones another producer registered. Only this producer's own files and the
// marker-verified stale files it removes leave the list.
test('registration keeps a foreign generated_projections entry inside docs/sterling/', () => {
  const foreign = ['docs/sterling/api-reference.md', 'docs/sterling/decisions/imported-by-hand.md'];
  const dir = fixture({ config: { generated_projections: [...foreign] } });
  try {
    mkdirSync(join(dir, 'docs', 'sterling', 'decisions'), { recursive: true });
    writeFileSync(join(dir, 'docs/sterling/api-reference.md'), '# produced by another generator\n');
    writeFileSync(join(dir, 'docs/sterling/decisions/imported-by-hand.md'), '# not ours\n');
    const r = project(dir);
    assert.equal(r.code, 0, r.out);
    const config = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.deepEqual(config.generated_projections, [...foreign, ...EXPECTED_FILES]);
    assert.equal(project(dir).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8')).generated_projections, [...foreign, ...EXPECTED_FILES], 'stable on rerun');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removes a stale record file (a record no longer in the store) and unregisters it', () => {
  const dir = fixture();
  try {
    assert.equal(project(dir).code, 0);
    const stale = 'docs/sterling/decisions/an-old-ruling.md';
    writeFileSync(join(dir, stale), readFileSync(join(dir, 'docs/sterling/decisions/importer-has-no-retry-loop-bbbbbbbb.md'), 'utf8'));
    const configPath = join(dir, '.sterling', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config, generated_projections: [...config.generated_projections, stale] }, null, 2) + '\n');

    const r = project(dir);
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(join(dir, stale)), 'stale generated record file removed');
    assert.match(r.out, /removed 1/);
    assert.ok(!JSON.parse(readFileSync(configPath, 'utf8')).generated_projections.includes(stale));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-written file under docs/sterling/ is never removed', () => {
  const dir = fixture();
  try {
    assert.equal(project(dir).code, 0);
    writeFileSync(join(dir, 'docs/sterling/decisions/notes.md'), '# our own notes\n');
    const r = project(dir);
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(join(dir, 'docs/sterling/decisions/notes.md'), 'utf8'), '# our own notes\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: a secondary store refuses, loudly, and leaves existing exports untouched', () => {
  const dir = fixture();
  try {
    assert.equal(project(dir).code, 0);
    const before = snapshot(dir);
    const configPath = join(dir, '.sterling', 'config.json');
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, 'utf8')), store_authority: 'secondary' }, null, 2) + '\n');
    const s = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    s.create({ ...DECISION, id: randomUUID(), slug: 'a-second-ruling', title: 'A second ruling' });
    s.close();
    const r = project(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /handoff projection: REFUSED .*store_authority is 'secondary'/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: a missing store refuses loudly and writes nothing', () => {
  const dir = fixture({ store: false });
  try {
    const r = project(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /handoff projection: REFUSED .*no Sterling store/);
    assert.deepEqual(listTree(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: an empty store never wipes existing exports', () => {
  const dir = fixture();
  try {
    assert.equal(project(dir).code, 0);
    const before = snapshot(dir);
    rmSync(join(dir, '.sterling', 'sterling.db'));
    for (const f of readdirSync(join(dir, '.sterling'))) if (f.startsWith('sterling.db')) rmSync(join(dir, '.sterling', f));
    new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
    const r = project(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /handoff projection: REFUSED .*holds no articles, decisions or anti-patterns/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuinely new, empty store writes explicit "no records yet" indexes', () => {
  const dir = fixture({ records: [] });
  try {
    const r = project(dir);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(listTree(dir), ['architecture.md', 'rulings.md']);
    assert.match(readFileSync(join(dir, 'architecture.md'), 'utf8'), /No records yet/);
    assert.match(readFileSync(join(dir, 'rulings.md'), 'utf8'), /No records yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-written root architecture.md is foreign: refused, untouched, nothing written', () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, 'architecture.md'), '# Our architecture\n');
    const r = project(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /handoff projection: REFUSED .*architecture\.md/);
    assert.equal(readFileSync(join(dir, 'architecture.md'), 'utf8'), '# Our architecture\n');
    assert.deepEqual(listTree(dir), ['architecture.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('never runs against the Sterling clone itself: skipped loudly, its own projections untouched', () => {
  const before = readFileSync(join(root, 'architecture.md'), 'utf8');
  const r = project(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /handoff projection: SKIPPED .*Sterling clone/);
  assert.equal(readFileSync(join(root, 'architecture.md'), 'utf8'), before);
  assert.ok(!existsSync(join(root, 'docs', 'sterling')));
});

// Sol review (duplicate slugs collapse records): record filenames are
// <slug>-<id8>, always, lowercase, and the id part grows while a case-folded
// collision persists — so no two records ever share a file, on any filesystem.
test('record filenames are unique and case-insensitive-safe: duplicate slugs, shared id prefixes, truncation, case', () => {
  const rec = (id, slug, title = 'A title') => ({ ...DECISION, id, slug, title });
  const long = 'x'.repeat(100);
  const records = [
    rec('11111111-aaaa-4000-8000-000000000001', 'same-slug'),
    rec('22222222-aaaa-4000-8000-000000000002', 'same-slug'),
    rec('33333333-aaaa-4000-8000-000000000003', 'shared-prefix'),
    rec('33333333-bbbb-4000-8000-000000000004', 'shared-prefix'),
    rec('44444444-aaaa-4000-8000-000000000005', `${long}-first`),
    rec('44444444-aaaa-4000-8000-000000000015', `${long}-second`),
    rec('66666666-aaaa-4000-8000-000000000007', 'Mixed-CASE'),
    rec('66666666-aaaa-4000-8000-000000000008', 'mixed-case'),
    rec('77777777-aaaa-4000-8000-000000000009', undefined, 'No Slug Here'),
  ];
  const { files } = buildHandoffFiles(records);
  const recordFiles = [...files.keys()].filter((f) => f.startsWith('docs/sterling/'));
  assert.equal(recordFiles.length, records.length, `one file per record: ${recordFiles.join(', ')}`);
  assert.equal(new Set(recordFiles.map((f) => f.toLowerCase())).size, records.length, 'unique under case folding');
  for (const f of recordFiles) assert.equal(f, f.toLowerCase(), `${f} is lowercase`);
  assert.ok(recordFiles.includes('docs/sterling/decisions/same-slug-11111111.md'));
  assert.ok(recordFiles.includes('docs/sterling/decisions/same-slug-22222222.md'));
  assert.ok(recordFiles.includes('docs/sterling/decisions/shared-prefix-33333333.md'));
  assert.ok(recordFiles.includes('docs/sterling/decisions/shared-prefix-33333333-bbbb.md'), `a shared id8 extends: ${recordFiles.join(', ')}`);
  assert.ok(recordFiles.includes('docs/sterling/decisions/no-slug-here-77777777.md'));
  assert.ok(recordFiles.every((f) => f.split('/').pop().length <= 100), 'a long slug is truncated');
  assert.deepEqual([...buildHandoffFiles([...records].reverse()).files.keys()], [...files.keys()], 'deterministic whatever the input order');
});
