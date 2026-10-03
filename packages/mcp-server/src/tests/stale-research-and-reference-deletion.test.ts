// Board 7a75851c steps (4) and (5), decision
// record-audit-dead-records-superseded-stale-findings-by-age-report-arm-plus-sampled-audit
// (b032fd9f):
//   (4) stale_research is minted at READ time when a research_finding's
//       volatility clock runs out (fast 30, medium 90, stable 365 days from
//       source_date) — one open item per finding, the way refresh_reference works.
//   (5) refresh_reference gains a deletion case: a repo-located reference_material
//       whose location no longer exists is drift.
// Queue data only: nothing here refuses a read or a write. A mint the store
// refuses is disclosed on the read, never thrown from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;
type Envelope = { records: Loose[]; maintenance_mint_failed?: { record_id: string; reason: string; error: string }[] };

const NOW = '2026-10-03T12:00:00.000Z';

function fixture(opts: { repo?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stale-research-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const dbPath = join(dir, '.sterling', 'sterling.db');
  const store = new SterlingStore(dbPath);
  const clock = { now: NOW };
  const tools = new SterlingTools({ store, now: () => clock.now, repoRoot: dir });
  const vcs = (...a: string[]): string => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  if (opts.repo) {
    vcs('init', '-q', '-b', 'main');
    vcs('config', 'user.email', 't@t.t');
    vcs('config', 'user.name', 't');
    vcs('config', 'core.autocrlf', 'false');
  }
  /** Move user_version from a second connection: every later write on `store` is refused. */
  const driftSchemaVersion = (): void => {
    const other = new DatabaseSync(dbPath);
    try {
      const v = (other.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      other.exec(`PRAGMA user_version = ${v + 1}`);
    } finally {
      other.close();
    }
  };
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, tools, clock, vcs, driftSchemaVersion, cleanup };
}

/** ISO date `days` before NOW. */
const daysAgo = (days: number): string => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

const mkFinding = (tools: SterlingTools, question: string, sourceDate: string, hint?: 'fast' | 'medium' | 'stable'): Loose =>
  (
    tools.knowledgeCreate('research_finding', {
      question,
      answer: 'a',
      source_urls: [],
      source_date: sourceDate,
      capture_date: sourceDate,
      ...(hint ? { volatility_hint: hint } : {}),
    } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose }
  ).record;

const readFindings = (tools: SterlingTools): Envelope =>
  tools.knowledgeQueryResult({ types: ['research_finding'] } as unknown as Parameters<SterlingTools['knowledgeQueryResult']>[0]) as unknown as Envelope;

const openItems = (tools: SterlingTools, reason: string): Loose[] =>
  tools.maintenanceQuery({ system_reason: reason }) as unknown as Loose[];

// ---------------------------------------------------------------------------
// (4) stale_research by age
// ---------------------------------------------------------------------------
test('(4) a medium finding past 90 days mints ONE stale_research item linked to the finding; a younger one mints none', () => {
  const { tools, cleanup } = fixture();
  try {
    const old = mkFinding(tools, 'how old finding behaves', daysAgo(91));
    mkFinding(tools, 'how young finding behaves', daysAgo(89));
    readFindings(tools);
    const items = openItems(tools, 'stale_research');
    assert.equal(items.length, 1, 'only the finding past its clock is minted');
    assert.equal(items[0].feature_link, old.id);
    assert.equal(items[0].source, 'system');
  } finally {
    cleanup();
  }
});

test('(4) the clock follows volatility_hint: fast 30, medium (default) 90, stable 365', () => {
  const { tools, cleanup } = fixture();
  try {
    const fast = mkFinding(tools, 'fast finding past', daysAgo(31), 'fast');
    mkFinding(tools, 'fast finding within', daysAgo(29), 'fast');
    mkFinding(tools, 'stable finding within', daysAgo(364), 'stable');
    const stable = mkFinding(tools, 'stable finding past', daysAgo(366), 'stable');
    mkFinding(tools, 'unhinted finding within medium', daysAgo(60));
    readFindings(tools);
    const links = openItems(tools, 'stale_research')
      .map((i) => i.feature_link)
      .sort();
    assert.deepEqual(links, [fast.id, stable.id].sort());
  } finally {
    cleanup();
  }
});

test('(4) one open item per finding: repeated reads, including one a day later, do not mint a second or churn its version', () => {
  const { tools, clock, cleanup } = fixture();
  try {
    mkFinding(tools, 'dedupe finding', daysAgo(120));
    readFindings(tools);
    const first = openItems(tools, 'stale_research');
    readFindings(tools);
    clock.now = new Date(Date.parse(NOW) + 86_400_000).toISOString();
    readFindings(tools);
    const again = openItems(tools, 'stale_research');
    assert.equal(again.length, 1);
    assert.equal(again[0].id, first[0].id);
    assert.equal(again[0].version, first[0].version, 'the item text carries no per-day number, so a re-read writes nothing');
  } finally {
    cleanup();
  }
});

test('(4) the item text names how to close it: knowledge_update with resolves, or maintenance_remove after superseding', () => {
  const { tools, cleanup } = fixture();
  try {
    mkFinding(tools, 'close step finding', daysAgo(120));
    readFindings(tools);
    const text = String(openItems(tools, 'stale_research')[0].text);
    assert.match(text, /knowledge_update/);
    assert.match(text, /resolves/);
    assert.match(text, /maintenance_remove/);
  } finally {
    cleanup();
  }
});

test('(4) a re-verified finding (superseded) is no longer read, so no second item appears for it; the replacement is fresh and mints none', () => {
  const { tools, cleanup } = fixture();
  try {
    const old = mkFinding(tools, 'to be reverified', daysAgo(200));
    readFindings(tools);
    assert.equal(openItems(tools, 'stale_research').length, 1);
    tools.knowledgeSupersede(old.id as string, {
      question: 'to be reverified',
      answer: 'b',
      source_urls: [],
      source_date: daysAgo(1),
      capture_date: daysAgo(1),
    });
    readFindings(tools);
    assert.equal(openItems(tools, 'stale_research').length, 1, 'the earlier item stays until drained; nothing new is minted for the superseded finding or its fresh replacement');
  } finally {
    cleanup();
  }
});

// A read must never throw because a mint was refused (the maintenanceEnqueue
// contract: "a mint must never make a READ throw"). Reproduction: a second
// connection moves user_version, so every write on this store is refused with
// "Live schema version drift". The read returns its results and says so loudly.
test('(4) a refused mint does not make the read throw: results come back with a maintenance_mint_failed disclosure naming the record and the error', () => {
  const { tools, driftSchemaVersion, cleanup } = fixture();
  try {
    const old = mkFinding(tools, 'drifted finding', daysAgo(120));
    driftSchemaVersion();
    const env = readFindings(tools);
    assert.equal(env.records.length, 1, 'the finding is still served');
    assert.equal(env.maintenance_mint_failed?.length, 1);
    assert.equal(env.maintenance_mint_failed?.[0].record_id, old.id);
    assert.equal(env.maintenance_mint_failed?.[0].reason, 'stale_research');
    assert.match(env.maintenance_mint_failed?.[0].error ?? '', /Live schema version drift/);
  } finally {
    cleanup();
  }
});

// Cost: an already-open, already-current item must not take the write path.
// Proof without a stopwatch: after the first read minted the items, drift the
// schema version. Any write attempt would now be refused and disclosed, so a
// clean second read means it performed none.
test('(4) a second read of N overdue findings takes no write path (the open items are current)', () => {
  const { tools, driftSchemaVersion, cleanup } = fixture();
  try {
    for (let i = 0; i < 5; i++) mkFinding(tools, `overdue finding ${i}`, daysAgo(120));
    readFindings(tools);
    assert.equal(openItems(tools, 'stale_research').length, 5);
    driftSchemaVersion();
    const env = readFindings(tools);
    assert.equal(env.records.length, 5);
    assert.equal(env.maintenance_mint_failed, undefined, 'no write was attempted, so none was refused');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (5) refresh_reference deletion case
// ---------------------------------------------------------------------------
const mkDocRef = (tools: SterlingTools, location: string): Loose =>
  (
    tools.knowledgeCreate('reference_material', {
      title: location,
      kind: 'doc',
      location,
      summary: 'x',
      source_date: '2026-09-06',
      capture_date: '2026-09-06',
    } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose }
  ).record;

const readRefs = (tools: SterlingTools): Loose[] =>
  (
    tools.knowledgeQueryResult({ types: ['reference_material'] } as unknown as Parameters<SterlingTools['knowledgeQueryResult']>[0]) as unknown as Envelope
  ).records;

test('(5) a doc reference whose location no longer exists mints ONE refresh_reference item and reads verify_before_use', () => {
  const { dir, tools, cleanup } = fixture();
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'gone.md'), 'x');
    const ref = mkDocRef(tools, 'docs/gone.md');
    rmSync(join(dir, 'docs', 'gone.md'));
    const read = readRefs(tools);
    assert.equal(read.find((r) => r.id === ref.id)?.verify_before_use, true);
    readRefs(tools);
    const items = openItems(tools, 'refresh_reference');
    assert.equal(items.length, 1, 'one item however many reads');
    assert.equal(items[0].feature_link, ref.id);
    assert.deepEqual(items[0].file_keys, ['docs/gone.md']);
    assert.match(String(items[0].text), /no longer exists/);
  } finally {
    cleanup();
  }
});

test('(5) a doc reference whose location exists and is unchanged mints nothing', () => {
  const { dir, tools, cleanup } = fixture();
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'here.md'), 'x');
    mkDocRef(tools, 'docs/here.md');
    readRefs(tools);
    assert.equal(openItems(tools, 'refresh_reference').length, 0);
  } finally {
    cleanup();
  }
});

test('(5) a refused deletion mint does not make the read throw: the reference is flagged and the failure disclosed', () => {
  const { tools, driftSchemaVersion, cleanup } = fixture();
  try {
    const ref = mkDocRef(tools, 'docs/missing.md');
    driftSchemaVersion();
    const env = tools.knowledgeQueryResult({ types: ['reference_material'] } as unknown as Parameters<SterlingTools['knowledgeQueryResult']>[0]) as unknown as Envelope;
    assert.equal(env.records.length, 1);
    assert.equal(env.maintenance_mint_failed?.[0].record_id, ref.id);
    assert.equal(env.maintenance_mint_failed?.[0].reason, 'refresh_reference');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (5) deletion with a real repository: parked on another ref is NOT deleted
// ---------------------------------------------------------------------------
test('(5) repo: a doc committed on another ref and absent here is parked, not deleted: no item', () => {
  const { dir, tools, vcs, cleanup } = fixture({ repo: true });
  try {
    writeFileSync(join(dir, 'README.md'), 'base');
    vcs('add', '-A', '--', 'README.md');
    vcs('commit', '-qm', 'base');
    vcs('checkout', '-q', '-b', 'feature');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'parked.md'), 'x');
    vcs('add', '-A', '--', 'docs');
    vcs('commit', '-qm', 'add parked doc');
    vcs('checkout', '-q', 'main');
    const ref = mkDocRef(tools, 'docs/parked.md');
    const read = readRefs(tools);
    assert.equal(read.find((r) => r.id === ref.id)?.verify_before_use, undefined, 'a parked path is not flagged');
    assert.equal(openItems(tools, 'refresh_reference').length, 0);
  } finally {
    cleanup();
  }
});

test('(5) repo: a doc still tracked at HEAD but removed from the working tree is parked on HEAD (the uncommitted-deletion shape): no item', () => {
  const { dir, tools, vcs, cleanup } = fixture({ repo: true });
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'tracked.md'), 'x');
    vcs('add', '-A', '--', 'docs');
    vcs('commit', '-qm', 'add doc');
    const ref = mkDocRef(tools, 'docs/tracked.md');
    rmSync(join(dir, 'docs', 'tracked.md'));
    const read = readRefs(tools);
    assert.equal(read.find((r) => r.id === ref.id)?.verify_before_use, undefined);
    assert.equal(openItems(tools, 'refresh_reference').length, 0);
  } finally {
    cleanup();
  }
});

test('(5) repo: a doc that was committed and then deleted mints the deletion item; one never committed and absent does too', () => {
  const { dir, tools, vcs, cleanup } = fixture({ repo: true });
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'deleted.md'), 'x');
    vcs('add', '-A', '--', 'docs');
    vcs('commit', '-qm', 'add doc');
    vcs('rm', '-q', 'docs/deleted.md');
    vcs('commit', '-qm', 'delete doc');
    const deleted = mkDocRef(tools, 'docs/deleted.md');
    const never = mkDocRef(tools, 'docs/never-existed.md');
    readRefs(tools);
    const items = openItems(tools, 'refresh_reference');
    assert.deepEqual(items.map((i) => i.feature_link).sort(), [deleted.id, never.id].sort());
    for (const i of items) assert.match(String(i.text), /no longer exists/);
  } finally {
    cleanup();
  }
});
