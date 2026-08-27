// LAND AT: packages/store/src/tests/create-field-loss.test.ts
// (H5 denied the pipeline-agent write to that path; this is the complete file.)
//
// Board bd3f0acf — the packages/store half of "SILENT KNOWLEDGE LOSS on record
// copy". validateRecord ends in `entry.schema.parse(input)` (packages/schemas/
// src/records.ts:1052) and zod STRIPS unknown keys silently AT EVERY DEPTH, so
// before this guard every create caller other than the MCP tool surface handed
// over a body carrying a legacy or hand-added field, got SUCCESS back, and read
// it back missing that field.
//
// THE NESTED CASES ARE THE POINT. A top-level-only detector (`unknownFieldsIn`,
// which inspects Object.keys(candidate) alone — records.ts:1036) ships green
// while still losing `files[0].note`; that is exactly the hollow version review
// caught on the scripts/ half of this item. Each behavior below is pinned at
// BOTH depths, on BOTH write surfaces, and each asserts the full refusal
// contract: the dropped path is NAMED, the call THREW, no record row exists,
// and no activity entry was written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, MountedStores } from '../index.js';

const NOW = '2026-08-27T09:00:00.000Z';

function envelope(type: string) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
  };
}

/** A feature_article is the shape that makes the depth question real: `files` is
 *  an array of OBJECTS, so a key buried in files[0] is invisible to any
 *  top-level key comparison. */
function article(over: Record<string, unknown> = {}) {
  return {
    ...envelope('feature_article'),
    slug: 'csv-export',
    title: 'CSV export',
    what_it_does: 'Exports the board as a CSV file for spreadsheets.',
    intended_behavior: 'User clicks Export and receives a CSV download.',
    files: [{ path: 'src/export/csv.ts', role: 'serializer' }],
    current_ac: [{ ac_id: 'AC1', text: 'export downloads a file', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
    ...over,
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'sterling-field-loss-'));
}

/** Every refusal pin asserts the SAME four things, so the contract cannot be
 *  half-satisfied: it threw, the message names the dropped path, the message
 *  says nothing was written, and the store agrees — no row, no activity entry. */
function assertRefusedAndUnwritten(
  run: () => unknown,
  expectedPath: string,
  probe: { get(id: string): unknown },
  activity: () => unknown[],
  id: string
) {
  const activityBefore = activity().length;
  assert.throws(run, (err: unknown) => {
    const message = (err as Error).message;
    assert.ok(
      message.includes(expectedPath),
      `the refusal must NAME the dropped path '${expectedPath}' — a caller cannot fix what it is not told. Got: ${message}`
    );
    assert.match(message, /NOTHING WAS WRITTEN/);
    return true;
  });
  assert.equal(probe.get(id), undefined, 'the refused record must not exist — the throw precedes the transaction');
  assert.equal(activity().length, activityBefore, 'a refused create must leave NO activity_log entry');
}

test('SterlingStore.create REFUSES a TOP-LEVEL unknown field and writes nothing', () => {
  const dir = tempDir();
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    const input = article({ bogus: 'a legacy field the schema does not define' });
    assertRefusedAndUnwritten(() => store.create(input), 'bogus', store, () => store.listActivityLog(50), input.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SterlingStore.create REFUSES a NESTED unknown field (files[0].bogus) — the depth case a top-level check misses', () => {
  const dir = tempDir();
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    const input = article({
      files: [{ path: 'src/export/csv.ts', role: 'serializer', bogus: 'lost silently before this guard' }],
    });
    assertRefusedAndUnwritten(() => store.create(input), 'files[0].bogus', store, () => store.listActivityLog(50), input.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MountedStores.create REFUSES a TOP-LEVEL unknown field — it parses BEFORE delegating, so it needs its own guard', () => {
  const dir = tempDir();
  const mounted = new MountedStores(join(dir, 'sterling.db'));
  try {
    const input = article({ bogus: 'a legacy field the schema does not define' });
    assertRefusedAndUnwritten(
      () => mounted.create(input),
      'bogus',
      mounted,
      () => mounted.project.listActivityLog(50),
      input.id
    );
  } finally {
    mounted.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MountedStores.create REFUSES a NESTED unknown field (files[0].bogus)', () => {
  const dir = tempDir();
  const mounted = new MountedStores(join(dir, 'sterling.db'));
  try {
    const input = article({
      files: [{ path: 'src/export/csv.ts', role: 'serializer', bogus: 'lost silently before this guard' }],
    });
    assertRefusedAndUnwritten(
      () => mounted.create(input),
      'files[0].bogus',
      mounted,
      () => mounted.project.listActivityLog(50),
      input.id
    );
  } finally {
    mounted.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the refusal names EVERY dropped path, not just the first — one refusal is enough to fix the caller', () => {
  const dir = tempDir();
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    const input = article({
      bogus: 'top level',
      files: [{ path: 'src/export/csv.ts', role: 'serializer', note: 'nested' }],
      current_ac: [{ ac_id: 'AC1', text: 'export downloads a file', verifiable_at: 'final', owner: 'also nested' }],
    });
    assert.throws(
      () => store.create(input),
      (err: unknown) => {
        const message = (err as Error).message;
        for (const path of ['bogus', 'files[0].note', 'current_ac[0].owner']) {
          assert.ok(message.includes(path), `every dropped path must be named; '${path}' was missing from: ${message}`);
        }
        return true;
      }
    );
    assert.equal(store.get(input.id), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// CONTROL ARMS — these must pass for the OPPOSITE reason. Without them a guard
// that simply threw on every create would satisfy every pin above.

test('CONTROL: a clean record still creates on BOTH surfaces, and schema DEFAULTS adding keys are not read as loss', () => {
  const dir = tempDir();
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const mountedDir = tempDir();
  const mounted = new MountedStores(join(mountedDir, 'sterling.db'));
  try {
    const direct = article();
    assert.equal(store.create(direct).id, direct.id);
    assert.ok(store.get(direct.id), 'a clean create still lands');
    assert.equal(store.listActivityLog(50).length, 1);

    const viaMount = article({ slug: 'csv-export-2' });
    assert.equal(mounted.create(viaMount).id, viaMount.id);
    assert.ok(mounted.get(viaMount.id));

    // research_finding.source_urls carries a zod DEFAULT, so the parse ADDS a key
    // the caller never sent. One-directional containment must not read that as
    // loss — round-trip EQUALITY would false-deny this record.
    const finding = {
      ...envelope('research_finding'),
      question: 'does the platform rate-limit per org or per token?',
      answer: 'per-org',
      source_date: '2026-01-15',
      capture_date: '2026-08-01',
      volatility_hint: 'medium',
    };
    assert.equal(store.create(finding).id, finding.id);
  } finally {
    store.close();
    mounted.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(mountedDir, { recursive: true, force: true });
  }
});

// NO EXEMPTION FOR INTERNAL MINTS (the ruling on board bd3f0acf). These two mints
// go through the SAME guard as any other caller, so these pins are the tripwire
// that makes future schema/mint drift fail immediately instead of silently.

test('internal mints pass the guard TODAY — bootstrapCatalogIfAbsent and enqueueRefreshReferenceOnce carry no unknown field', () => {
  const dir = tempDir();
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    store.bootstrapCatalogIfAbsent({ models: { coder: { model: 'claude-opus-5' } } }, NOW);
    const catalogs = store.query({ types: ['reference_material'], cap: 50 });
    assert.equal(catalogs.length, 1, 'the catalog mint must survive the create guard unmodified');

    store.enqueueRefreshReferenceOnce(NOW);
    const todos = store
      .query({ types: ['todo'], cap: 50 })
      .filter((r) => (r as Record<string, unknown>).system_reason === 'refresh_reference');
    assert.equal(todos.length, 1, 'the refresh_reference mint must survive the create guard unmodified');
    assert.ok(
      (todos[0] as Record<string, unknown>).feature_link,
      'feature_link is set on this mint and must not be stripped — if this fails, schema and mint have drifted'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
