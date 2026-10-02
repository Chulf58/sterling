// Spec-only tests for scripts/knowledge-export.mjs (board c3705a15, knowledge-export
// half of the approved design; article 'knowledge-transfer-export' is the spec).
//
// BLIND BY DESIGN: this file was authored without reading scripts/knowledge-export.mjs
// or scripts/lib/citations.mjs, which are being written concurrently. Every assertion
// below is phrased against the OBSERVABLE contract (exit code, stderr naming, directory
// contents by pattern) rather than exact strings, per the dispatch brief.
//
// CLI INTERFACE ASSUMPTION (the spec/article does not declare one; stated so it can be
// reconciled against whatever scripts/knowledge-export.mjs actually parses):
//   node scripts/knowledge-export.mjs <root> <outDir> --ids <id1>,<id2>,...
// where <root> is a project root containing .sterling/config.json (same convention as
// check-record-citations.mjs's sole positional arg), <outDir> is the destination payload
// directory, and --ids is a comma-separated list of full ids or unambiguous 8-char
// prefixes to export. Exit 0 = success; non-zero = refusal, nothing written.
//
// FIELD-PLACEMENT ASSUMPTION for prose citations: the knowledge-transfer-export article's
// OWN history entries are where real citations and "origin-only ids" provenance lists
// already live in this store (see its history[3]/history[8] events, e.g. "ORIGIN-ONLY IDS
// THAT DO NOT RESOLVE HERE"). Fixtures below place citations in feature_article `history[].event`
// text on that precedent, rather than guessing at a field the export tool might not scan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
async function getStore() {
  if (!SterlingStore) {
    ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  }
  return SterlingStore;
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-kexport-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ stack_tags: [] }));
  return dir;
}

function decisionRow(id, { statement = 's', rationale = 'r' } = {}) {
  return {
    id, type: 'decision', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
    title: 't', statement, alternatives_rejected: [], rationale, file_keys: [],
  };
}

function articleRow(id, { slug, history = [], fileBaselines } = {}) {
  const row = {
    id, type: 'feature_article', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
    slug: slug || `article-${id.slice(0, 8)}`, title: 't', what_it_does: 'w', intended_behavior: 'b',
    files: [], current_ac: [], dependencies: { relies_on: [], relied_by: [] }, state: 'active',
    history, live_test_refs: [],
  };
  if (fileBaselines) row.file_baselines = fileBaselines;
  return row;
}

function runExport(root_, outDir, ids) {
  return spawnSync(
    process.execPath,
    [join(root, 'scripts', 'knowledge-export.mjs'), root_, outDir, '--ids', ids.join(',')],
    { encoding: 'utf8', cwd: root_, timeout: 120_000 }
  );
}

function listOutput(outDir) {
  return existsSync(outDir) ? readdirSync(outDir) : [];
}

// -- behavior 1: clean export -------------------------------------------------

test('clean export of resolvable records emits NN-<type>-<slug>.json files, README.md, provenance.json', async () => {
  await getStore();
  const dir = makeProject();
  try {
    const decId = randomUUID();
    const artId = randomUUID();
    const store = new (await getStore())(join(dir, '.sterling', 'sterling.db'));
    store.create(decisionRow(decId));
    store.create(articleRow(artId, { slug: 'my-article' }));
    store.close();

    const outDir = join(dir, 'out');
    const r = runExport(dir, outDir, [decId, artId]);
    assert.equal(r.status, 0, `expected clean export to succeed: ${r.stdout}${r.stderr}`);

    const entries = listOutput(outDir);
    assert.ok(entries.includes('README.md'), 'README.md must be written');
    assert.ok(entries.includes('provenance.json'), 'provenance.json must be written');
    assert.ok(
      entries.some((f) => /^\d{2}-decision-.+\.json$/.test(f)),
      `expected a NN-decision-<slug>.json file, got: ${entries.join(', ')}`
    );
    assert.ok(
      entries.some((f) => /^\d{2}-feature_article-.+\.json$/.test(f)),
      `expected a NN-feature_article-<slug>.json file, got: ${entries.join(', ')}`
    );
    // SABOTAGE: comment out the write of README.md (or provenance.json) in the
    // success path -> the corresponding `entries.includes(...)` assertion goes red.
    // SABOTAGE (files): rename the per-record output filename template to drop
    // the leading NN- index or the type segment -> the regex assertions go red.
  } finally {
    // no cleanup needed beyond OS tmp reaping; keep parity with sibling tests
  }
});

// -- behavior 1 (second half): stripped fields --------------------------------

test('exported article strips file_baselines (leaving _export_note) and drops staleness/verify_before_use', async () => {
  await getStore();
  const dir = makeProject();
  const artId = randomUUID();
  const store = new (await getStore())(join(dir, '.sterling', 'sterling.db'));
  store.create(articleRow(artId, {
    slug: 'baseline-bearer',
    fileBaselines: { 'scripts/knowledge-export.mjs': 'deadbeef00000000000000000000000000000000000000000000000000' },
  }));
  store.close();

  const outDir = join(dir, 'out');
  const r = runExport(dir, outDir, [artId]);
  assert.equal(r.status, 0, `expected export to succeed: ${r.stdout}${r.stderr}`);

  const files = listOutput(outDir).filter((f) => /^\d{2}-feature_article-.+\.json$/.test(f));
  assert.equal(files.length, 1, `expected exactly one article payload file, got: ${files.join(', ')}`);
  const payload = JSON.parse(readFileSync(join(outDir, files[0]), 'utf8'));

  assert.equal(payload.file_baselines, undefined, 'file_baselines must be stripped');
  assert.equal(typeof payload._export_note, 'string', 'a stripped record carries an _export_note');
  assert.ok(payload._export_note.length > 0);
  assert.equal(payload.staleness, undefined, 'staleness is a read-time annotation, never exported');
  assert.equal(payload.verify_before_use, undefined, 'verify_before_use is a read-time annotation, never exported');
  // SABOTAGE (strip): delete the line that removes file_baselines before
  // serialization -> the file_baselines assertion goes red.
  // SABOTAGE (_export_note): delete the line that sets _export_note when
  // file_baselines was stripped -> the typeof assertion goes red.
});

// -- CONTROL for behavior 2, placed first: an id that resolves in the source --
// but sits outside the payload must NOT refuse. Without this control, a refusal
// on the dangling-citation test below would be equally explained by "this tool
// refuses on any external citation" or even "this tool refuses unconditionally" —
// this test must pass, and for the opposite reason (the id DOES resolve).

test('CONTROL: a citation resolving in the source store but outside the payload succeeds, and is auto-listed in provenance.json + an origin-ids block', async () => {
  await getStore();
  const dir = makeProject();
  const requestedId = randomUUID();
  const collateralId = randomUUID(); // exists in source, NOT requested for export
  const store = new (await getStore())(join(dir, '.sterling', 'sterling.db'));
  store.create(articleRow(requestedId, {
    slug: 'cites-collateral',
    history: [{ date: NOW, event: `decision ${collateralId} informed this design` }], // not-a-citation: fixture id
  }));
  store.create(decisionRow(collateralId));
  store.close();

  const outDir = join(dir, 'out');
  const r = runExport(dir, outDir, [requestedId]);
  assert.equal(r.status, 0, `an in-source, out-of-payload citation must not refuse: ${r.stdout}${r.stderr}`);

  const provenancePath = join(outDir, 'provenance.json');
  assert.ok(existsSync(provenancePath), 'provenance.json must exist on a successful export');
  const provenanceText = readFileSync(provenancePath, 'utf8');
  JSON.parse(provenanceText); // must be valid JSON
  assert.ok(provenanceText.includes(collateralId), 'provenance.json must list the collateral id');

  const allText = listOutput(outDir)
    .map((f) => readFileSync(join(outDir, f), 'utf8'))
    .join('\n');
  assert.match(allText, /\[origin-ids:[\s\S]*\[\/origin-ids\]/, 'a pre-formatted origin-ids block must be generated');
  assert.ok(allText.includes(collateralId), 'the origin-ids block (or provenance) must name the collateral id');
  // SABOTAGE (control validity): change the citation check to require every
  // cited id resolve WITHIN THE PAYLOAD (not the source store) -> this test's
  // exit-0 assertion goes red instead of the dangling-citation test below,
  // proving the two tests are actually distinguishing different causes.
  // SABOTAGE (provenance listing): skip writing collateral ids into
  // provenance.json -> the `includes(collateralId)` assertion on provenance goes red.
  // SABOTAGE (origin-ids block): never generate the [origin-ids: ...] block for
  // auto-detected collateral -> the regex match goes red.
});

// -- behavior 2: dangling citation refuses -------------------------------------

test('REFUSAL: a payload record citing an id resolving to nothing in the source store fails loud naming it; nothing written', async () => {
  await getStore();
  const dir = makeProject();
  const artId = randomUUID();
  const store = new (await getStore())(join(dir, '.sterling', 'sterling.db'));
  store.create(articleRow(artId, {
    slug: 'cites-nothing',
    history: [{ date: NOW, event: 'decision deadbeef never existed anywhere' }], // not-a-citation: fixture id
  }));
  store.close();

  const outDir = join(dir, 'out');
  const r = runExport(dir, outDir, [artId]);
  assert.notEqual(r.status, 0, 'a dangling citation must refuse');
  assert.match(`${r.stdout}${r.stderr}`, /deadbeef/, 'the refusal must name the dangling id');
  assert.deepEqual(listOutput(outDir), [], 'nothing may be written on refusal');
  // SABOTAGE: remove (or always-pass) the citation-resolution check against the
  // source store's id index -> exit code assertion goes red (becomes 0) and/or
  // files get written, failing the deepEqual([]) assertion.
});

// -- behavior 3: request-shape refusals ----------------------------------------

test('REFUSAL: an unresolvable requested id fails loud naming it; nothing written', async () => {
  await getStore();
  const dir = makeProject();
  const store = new (await getStore())(join(dir, '.sterling', 'sterling.db'));
  store.close(); // empty store: nothing resolves
  const ghostId = randomUUID();

  const outDir = join(dir, 'out');
  const r = runExport(dir, outDir, [ghostId]);
  assert.notEqual(r.status, 0, 'requesting an id absent from the store must refuse');
  assert.match(`${r.stdout}${r.stderr}`, new RegExp(ghostId), 'the refusal must name the unresolvable id');
  assert.deepEqual(listOutput(outDir), [], 'nothing may be written on refusal');
  // SABOTAGE: silently filter out unresolvable requested ids instead of
  // refusing (export whatever DID resolve) -> exit code goes 0 and/or files
  // get written, failing this test.
});

test('REFUSAL: an ambiguous 8-char prefix fails loud; nothing written', async () => {
  await getStore();
  const dir = makeProject();
  const idA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const idB = 'aaaaaaaa-2222-4222-8222-222222222222';
  const store = new (await getStore())(join(dir, '.sterling', 'sterling.db'));
  store.create(decisionRow(idA));
  store.create(decisionRow(idB));
  store.close();

  const outDir = join(dir, 'out');
  const r = runExport(dir, outDir, ['aaaaaaaa']);
  assert.notEqual(r.status, 0, 'an ambiguous prefix must refuse rather than pick one');
  assert.match(`${r.stdout}${r.stderr}`, /aaaaaaaa/, 'the refusal must name the ambiguous prefix');
  assert.deepEqual(listOutput(outDir), [], 'nothing may be written on refusal');
  // SABOTAGE: resolve an ambiguous prefix to its first match instead of
  // refusing -> exit code goes 0 and a payload file is written, failing this test.
});

test('REFUSAL: a non-empty outDir fails loud; the existing directory is left untouched', async () => {
  await getStore();
  const dir = makeProject();
  const decId = randomUUID();
  const store = new (await getStore())(join(dir, '.sterling', 'sterling.db'));
  store.create(decisionRow(decId));
  store.close();

  const outDir = join(dir, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'sentinel.txt'), 'pre-existing content');

  const r = runExport(dir, outDir, [decId]);
  assert.notEqual(r.status, 0, 'a non-empty outDir must refuse');
  assert.match(`${r.stdout}${r.stderr}`, /out/, 'the refusal should name the outDir');
  assert.deepEqual(listOutput(outDir), ['sentinel.txt'], 'the pre-existing directory must be left untouched');
  assert.equal(readFileSync(join(outDir, 'sentinel.txt'), 'utf8'), 'pre-existing content');
  // SABOTAGE: drop the emptiness check on outDir and always write into it ->
  // exit code goes 0 and listOutput(outDir) gains new entries, failing this test.
});

// -- behavior 5: origin-ids exempt region --------------------------------------

test('origin-ids region is exempt from citation resolution and round-trips into the export intact', async () => {
  await getStore();
  const dir = makeProject();
  const artId = randomUUID();
  const originBlock =
    '[origin-ids: legacy references from a prior import, kept for provenance]\n' +
    'decision facade00 - superseded on the origin machine\n' + // not-a-citation: fixture id
    '[/origin-ids]';
  const store = new (await getStore())(join(dir, '.sterling', 'sterling.db'));
  store.create(articleRow(artId, {
    slug: 'has-origin-block',
    history: [{ date: NOW, event: `Import note.\n${originBlock}\n` }],
  }));
  store.close();

  const outDir = join(dir, 'out');
  const r = runExport(dir, outDir, [artId]);
  assert.equal(r.status, 0, `a dangling id inside an origin-ids block must not refuse: ${r.stdout}${r.stderr}`);

  const files = listOutput(outDir).filter((f) => /^\d{2}-feature_article-.+\.json$/.test(f));
  assert.equal(files.length, 1);
  const payload = JSON.parse(readFileSync(join(outDir, files[0]), 'utf8'));
  const historyText = JSON.stringify(payload.history);
  assert.ok(historyText.includes('[origin-ids:'), 'the origin-ids marker must round-trip');
  assert.ok(historyText.includes('facade00'), 'the exempt id text must round-trip unchanged'); // not-a-citation: fixture id
  assert.ok(historyText.includes('[/origin-ids]'), 'the closing marker must round-trip');
  // SABOTAGE (exemption): remove the origin-ids region special-case so its
  // contents are resolved like ordinary prose -> exit code goes non-zero,
  // failing the equal(r.status, 0) assertion.
  // SABOTAGE (round-trip): strip or redact text inside [origin-ids:...] blocks
  // during export instead of passing it through -> the historyText.includes(...)
  // assertions go red while the exit-code assertion stays green (a distinct
  // sabotage from the one above).
});
