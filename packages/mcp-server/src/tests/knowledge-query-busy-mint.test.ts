// GitHub #92: knowledge_query mints maintenance items while it maps records. The
// feature_article drift arm called maintenanceEnqueue directly, so when another
// connection held the write lock past busy_timeout the StoreBusyError escaped
// and the whole read failed. A read-time mint must never make a read throw: a
// refused mint is disclosed as maintenance_mint_failed on the record and the
// envelope, the same contract the stale_research and refresh_reference arms
// already follow (stale-research-and-reference-deletion.test.ts, test 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;
type Envelope = { records: Loose[]; maintenance_mint_failed?: { record_id: string; reason: string; error: string }[] };

const NOW = '2026-09-06T12:00:00.000Z';

/** Another connection takes BEGIN IMMEDIATE plus a DDL statement, which forces the write lock to materialize. */
function holdWriteLock(path: string): DatabaseSync {
  const holder = new DatabaseSync(path);
  holder.exec('PRAGMA busy_timeout=0');
  holder.exec('BEGIN IMMEDIATE');
  holder.exec('CREATE TABLE IF NOT EXISTS zz_lock (x)');
  return holder;
}

function release(holder: DatabaseSync): void {
  holder.exec('ROLLBACK');
  holder.close();
}

/** A git repo holding committed files, and an article that owns them, whose files are then edited out of band. */
function driftedArticleFixture(paths: string[] = ['src/a.ts']) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-query-busy-mint-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const p of paths) writeFileSync(join(dir, p), `${p} v1`);
  git('add', '-A');
  git('commit', '-qm', 'seed');
  const dbPath = join(dir, '.sterling', 'sterling.db');
  const store = new SterlingStore(dbPath, { busyTimeoutMs: 200 });
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  const { record: article } = tools.knowledgeCreate('feature_article', {
    slug: 'busy-drift',
    title: 'busy drift',
    what_it_does: 'x',
    intended_behavior: 'x',
    files: paths.map((path) => ({ path, role: 'impl' })),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose };
  // The out-of-band edit: new bytes, mtime (real clock) after the article's updated_at (NOW).
  for (const p of paths) writeFileSync(join(dir, p), `${p} v2 edited out of band`);
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dbPath, store, tools, articleId: article.id as string, cleanup };
}

const reconcileItemsFor = (tools: SterlingTools, articleId: string) =>
  (tools.maintenanceQuery({ system_reason: 'reconcile_needed' }) as unknown as Loose[]).filter((t) => t.feature_link === articleId);

test('#92: a drifted feature_article read while another connection holds the write lock returns the record with maintenance_mint_failed instead of throwing', () => {
  const { dbPath, tools, articleId, cleanup } = driftedArticleFixture();
  let holder: DatabaseSync | undefined;
  try {
    holder = holdWriteLock(dbPath);
    let env: Envelope | undefined;
    assert.doesNotThrow(() => {
      env = tools.knowledgeQueryResult({ types: ['feature_article'] }) as unknown as Envelope;
    }, 'a busy write lock must not make the read throw');
    const rec = env!.records.find((r) => r.id === articleId);
    assert.ok(rec, 'the drifted article is still served');
    assert.equal(rec.verify_before_use, true, 'the drift flag still reaches the reader');
    const onRecord = rec.maintenance_mint_failed as { reason: string; error: string } | undefined;
    assert.ok(onRecord, 'the record carries the mint refusal');
    assert.equal(onRecord.reason, 'reconcile_needed');
    assert.match(onRecord.error, /database is locked/);
    const onEnvelope = (env!.maintenance_mint_failed ?? []).filter((f) => f.record_id === articleId);
    assert.equal(onEnvelope.length, 1, 'the envelope discloses the refusal once for the record');
    assert.equal(onEnvelope[0].reason, 'reconcile_needed');
    assert.match(onEnvelope[0].error, /database is locked/);

    release(holder);
    holder = undefined;
    assert.equal(reconcileItemsFor(tools, articleId).length, 0, 'the refused mint wrote nothing');

    // Once the lock is free the same read mints the item, and discloses no failure.
    const after = tools.knowledgeQueryResult({ types: ['feature_article'] }) as unknown as Envelope;
    assert.equal(after.maintenance_mint_failed, undefined);
    assert.equal(after.records.find((r) => r.id === articleId)?.maintenance_mint_failed, undefined);
    const items = reconcileItemsFor(tools, articleId);
    assert.equal(items.length, 1, 'the free-lock read minted exactly one reconcile_needed item');
    assert.deepEqual(items[0].file_keys, ['src/a.ts']);
    assert.match(items[0].text as string, /owned file src\/a\.ts changed on disk/);
  } finally {
    if (holder) release(holder);
    cleanup();
  }
});

// Review finding on #92: keeping the first refusal must not stop later mints.
// The lock is held for the first mint attempt only (a real busy refusal) and
// released straight after it, so the second drifting file's mint can land.
test('#92: after one mint is refused, the arm still attempts the next drifting file, whose item is created, and the first refusal is the one disclosed', () => {
  const { dbPath, tools, articleId, cleanup } = driftedArticleFixture(['src/a.ts', 'src/b.ts']);
  let holder: DatabaseSync | undefined;
  const original = tools.maintenanceEnqueue.bind(tools);
  const attempted: string[][] = [];
  tools.maintenanceEnqueue = (args) => {
    attempted.push(args.file_keys ?? []);
    try {
      return original(args);
    } finally {
      if (holder) {
        release(holder);
        holder = undefined;
      }
    }
  };
  try {
    holder = holdWriteLock(dbPath);
    const env = tools.knowledgeQueryResult({ types: ['feature_article'] }) as unknown as Envelope;
    assert.deepEqual(attempted.slice(0, 2), [['src/a.ts'], ['src/b.ts']], 'both drifting files were attempted, in files[] order');
    const items = reconcileItemsFor(tools, articleId);
    assert.equal(items.length, 1, 'the second file minted its reconcile_needed item');
    assert.deepEqual(items[0].file_keys, ['src/b.ts'], 'only the refused first file is missing from the item');
    const onRecord = env.records.find((r) => r.id === articleId)?.maintenance_mint_failed as { reason: string; error: string } | undefined;
    assert.equal(onRecord?.reason, 'reconcile_needed');
    assert.match(onRecord?.error ?? '', /database is locked/, 'the disclosed failure is the first, refused attempt');
    const onEnvelope = (env.maintenance_mint_failed ?? []).filter((f) => f.record_id === articleId);
    assert.equal(onEnvelope.length, 1);
    assert.match(onEnvelope[0].error, /database is locked/);
  } finally {
    if (holder) release(holder);
    cleanup();
  }
});

test('#92: with the write lock free, reading a drifted feature_article mints its reconcile_needed item once and a re-read does not duplicate it', () => {
  const { tools, articleId, cleanup } = driftedArticleFixture();
  try {
    const first = tools.knowledgeQueryResult({ types: ['feature_article'] }) as unknown as Envelope;
    assert.equal(first.maintenance_mint_failed, undefined);
    assert.equal(first.records.find((r) => r.id === articleId)?.verify_before_use, true);
    assert.equal(reconcileItemsFor(tools, articleId).length, 1);
    tools.knowledgeQueryResult({ types: ['feature_article'] });
    assert.equal(reconcileItemsFor(tools, articleId).length, 1, 'the re-read folds into the open item');
  } finally {
    cleanup();
  }
});
