// The session-end duty rules H10 and the OpenCode settlement share
// (scripts/hooks/lib/session-duties.mjs). The item texts are pinned to the
// exact strings H10 wrote before the extraction, so a Claude Code queue item
// stays byte-identical; the h10-*.test.mjs suite pins the hook's behaviour.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as duties from '../hooks/lib/session-duties.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
});

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-duties-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    return fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const env = (type, at) => ({ id: randomUUID(), type, created_at: at, updated_at: at, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] });
const finding = (at) => ({ ...env('research_finding', at), question: 'q?', answer: 'a', source_urls: [], source_date: '2026-09-01', capture_date: '2026-09-02' });
const conceptArticle = (family, at, path = 'src/x.mjs') => ({
  ...env('feature_article', at),
  slug: `${family}-article`,
  title: 't',
  what_it_does: 'w',
  intended_behavior: 'i',
  files: [{ path, role: 'impl' }],
  file_baselines: {},
  current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
  dependencies: { relies_on: [], relied_by: [] },
  state: 'active',
  version: 1,
  history: [{ date: at, event: 'brief' }],
  live_test_refs: [],
  concept_family: family,
});

test('golden: the four item texts are byte-identical to what H10 wrote before the extraction', () => {
  assert.equal(
    duties.articleMissingText(['a', 'b'], { newlyCreated: 1 }),
    'article missing: 2 file(s) nothing owns (feature_article or repo-located reference doc) (1 newly created) — create the owning article(s) (§6 H10 / §12 accretion)'
  );
  assert.equal(duties.articleMissingText(['a']), 'article missing: 1 file(s) nothing owns (feature_article or repo-located reference doc) — create the owning article(s) (§6 H10 / §12 accretion)');
  assert.equal(
    duties.conceptArticleMissingText('fam'),
    "concept article missing: design settled for concept family 'fam' and the session ended without its concept article — create/update the feature_article with concept_family 'fam'"
  );
  assert.equal(duties.researchOwedText('q1; q2'), 'research owed: session research not captured (queries/agents: q1; q2)');
  assert.equal(duties.captureOwedText(3, ''), 'capture owed: direct-mode session touched 3 file(s) and ended without capture');
});

test('golden: systemTodo builds the envelope H10 enqueued, field for field and in order', () => {
  const t = duties.systemTodo('2026-10-02T00:00:00.000Z', { text: 'x', system_reason: 'research_owed' });
  assert.match(t.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(t), ['id', 'type', 'created_at', 'updated_at', 'author', 'status', 'superseded_by', 'links', 'scope', 'stack_tags', 'text', 'source', 'system_reason']);
  assert.deepEqual({ ...t, id: null }, {
    id: null, type: 'todo', created_at: '2026-10-02T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z', author: 'system', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [], text: 'x', source: 'system', system_reason: 'research_owed',
  });
  const k = duties.systemTodo('2026-10-02T00:00:00.000Z', { text: 'y', system_reason: 'capture_owed', file_keys: ['a'] });
  assert.deepEqual(Object.keys(k).slice(-4), ['text', 'source', 'system_reason', 'file_keys']);
});

test('isValidAt accepts only canonical ISO stamps', () => {
  assert.equal(duties.isValidAt('2026-10-02T00:00:00.000Z'), true);
  for (const bad of ['0', 'n/a', undefined, null, '2026-10-02', '2026-13-45T00:00:00.000Z']) assert.equal(duties.isValidAt(bad), false, String(bad));
});

test('no_capture cutoffs are lane-scoped; a legacy declaration is the capture lane and "all" covers both', () => {
  const ev = [
    { kind: 'no_capture', at: '2026-10-02T01:00:00.000Z' },
    { kind: 'no_capture', lane: 'research', at: '2026-10-02T02:00:00.000Z' },
    { kind: 'no_capture', lane: 'bogus', at: '2026-10-02T09:00:00.000Z' },
    { kind: 'no_capture', lane: 'capture', at: 'n/a' },
  ];
  assert.deepEqual(duties.noCaptureCutoffs(ev), { capture: '2026-10-02T01:00:00.000Z', research: '2026-10-02T02:00:00.000Z' });
  assert.deepEqual(duties.noCaptureCutoffs([...ev, { kind: 'no_capture', lane: 'all', at: '2026-10-02T03:00:00.000Z' }]), { capture: '2026-10-02T03:00:00.000Z', research: '2026-10-02T03:00:00.000Z' });
  assert.equal(duties.dischargedByCutoff('2026-10-02T01:00:00.000Z', '2026-10-02T01:00:00.000Z'), true);
  assert.equal(duties.dischargedByCutoff('0', '2026-10-02T01:00:00.000Z'), false, 'a malformed at is never covered');
  assert.equal(duties.dischargedByCutoff('2026-10-02T00:00:00.000Z', null), false);
});

test('concept families anchor at the earliest valid at, and a family with none anchors null', () => {
  const fam = duties.conceptFamiliesFrom([
    { kind: 'concept_designed', detail: 'a', at: '2026-10-02T02:00:00.000Z' },
    { kind: 'concept_designed', detail: 'a', at: '2026-10-02T01:00:00.000Z' },
    { kind: 'concept_designed', detail: 'b', at: '0' },
    { kind: 'concept_designed', detail: '', at: '2026-10-02T01:00:00.000Z' },
    { kind: 'no_capture', detail: 'c', at: '2026-10-02T01:00:00.000Z' },
  ]);
  assert.deepEqual([...fam.entries()], [['a', '2026-10-02T01:00:00.000Z'], ['b', null]]);
});

test('capture, research and concept satisfaction read the store from the window start', () =>
  withStore((store) => {
    store.create(finding('2026-10-02T05:00:00.000Z'));
    assert.equal(duties.capturedSince(store, '2026-10-02T04:00:00.000Z'), true);
    assert.equal(duties.capturedSince(store, '2026-10-02T06:00:00.000Z'), false);
    assert.equal(duties.researchCapturedSince(store, '2026-10-02T04:00:00.000Z'), true);
    assert.equal(duties.researchCapturedSince(store, '2026-10-02T06:00:00.000Z'), false);
    store.create(conceptArticle('fam', '2026-10-02T05:00:00.000Z'));
    const fams = new Map([['fam', '2026-10-02T05:10:00.000Z'], ['other', '2026-10-02T05:10:00.000Z'], ['nul', null]]);
    assert.deepEqual(duties.unmetConceptFamilies(store, fams, '2026-10-02T05:10:00.000Z'), ['other', 'nul'], 'an article 10 minutes before its event satisfies through the pre-event window');
    assert.deepEqual(duties.unmetConceptFamilies(store, new Map([['fam', '2026-10-02T06:00:00.000Z']]), '2026-10-02T06:00:00.000Z'), ['fam'], 'an article an hour before its event does not');
  }));

test('ownership join and demand exemption', () =>
  withStore((store, dir) => {
    store.create(conceptArticle('fam', '2026-10-02T05:00:00.000Z', 'src/owned.mjs'));
    const { isUnowned, ownerRows } = duties.ownershipJoin(store, dir);
    assert.equal(isUnowned('src/owned.mjs'), false);
    assert.equal(isUnowned('src/free.mjs'), true);
    assert.equal(ownerRows('src/owned.mjs').length, 1);
    const exempt = duties.demandExemption({ article_demand: { ignore_globs: ['**/*.uid'] } }, new Set(['architecture.md']));
    assert.equal(exempt('architecture.md'), true);
    assert.equal(exempt('a/b.gd.uid'), true);
    assert.equal(exempt('a/b.gd'), false);
    assert.equal(duties.hasOpenSystemTodo(store, 'research_owed'), false);
    store.enqueueSystemTodo(duties.systemTodo('2026-10-02T00:00:00.000Z', { text: duties.researchOwedText('q'), system_reason: 'research_owed' }));
    assert.equal(duties.hasOpenSystemTodo(store, 'research_owed'), true);
  }));

test('openDutyRecords.close closes every domain store and returns the close errors instead of throwing', () =>
  withStore((store, dir) => {
    const paths = { a: join(dir, 'a.db'), b: join(dir, 'b.db'), gone: join(dir, 'gone.db') };
    writeFileSync(paths.a, '');
    writeFileSync(paths.b, '');
    const closed = [];
    const opener = (dbPath) => ({
      query: () => [{ id: dbPath }],
      close: () => {
        closed.push(dbPath);
        throw new Error(`close boom ${dbPath === paths.a ? 'a' : 'b'}`);
      },
    });
    const unreadable = [];
    const records = duties.openDutyRecords(store, { stack_tags: ['a', 'gone', 'b'], domain_paths: paths }, { opener, onUnreadable: (name) => unreadable.push(name) });
    assert.deepEqual(records.query({ types: ['decision'], cap: 10 }).map((r) => r.id), [paths.a, paths.b], 'project first (empty), then each domain store that exists');
    let errors;
    assert.doesNotThrow(() => (errors = records.close()));
    assert.deepEqual(closed, [paths.a, paths.b], 'the second store is closed although the first close threw');
    assert.deepEqual(errors, [{ name: 'a', error: 'close boom a' }, { name: 'b', error: 'close boom b' }]);
    assert.deepEqual(unreadable, [], 'a close error is not an unreadable store');
    assert.deepEqual(records.close(), [], 'a second close has nothing left to close');
  }));

// The domain-write ledger (decision
// domain-record-duty-credit-comes-from-a-per-project-write-ledger). Two
// projects, A and B, mount the same domain store; each has its own ledger under
// its own root, written by its own MCP server (pinned in
// packages/mcp-server/src/tests/domain-write-ledger.test.ts).
const W0 = '2026-10-04T12:00:00.000Z'; // window start
const BEFORE_W0 = '2026-10-04T11:00:00.000Z';
const IN_WINDOW = '2026-10-04T12:30:00.000Z';
const domainDecision = (at) => ({ ...env('decision', at), scope: 'domain:shared', title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' });

// The ledger is JSON Lines: one entry per line, appended by the server.
const ledgerFile = (root) => join(root, '.sterling', 'transient', 'knowledge-writes.jsonl');
function writeLedger(root, entries) {
  mkdirSync(join(root, '.sterling', 'transient'), { recursive: true });
  writeFileSync(ledgerFile(root), typeof entries === 'string' ? entries : entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

/** Projects A and B (each a root with its own project store) over one shared domain store. */
function withSharedDomain(fn) {
  const base = mkdtempSync(join(tmpdir(), 'sterling-duties-ledger-'));
  const domainDb = join(base, 'domains', 'shared', 'sterling.db');
  mkdirSync(dirname(domainDb), { recursive: true });
  const domain = new SterlingStore(domainDb);
  const config = { stack_tags: ['shared'], domain_paths: { shared: domainDb } };
  const opened = [];
  const project = (name) => {
    const root = join(base, name);
    mkdirSync(join(root, '.sterling'), { recursive: true });
    const store = new SterlingStore(join(root, '.sterling', 'sterling.db'));
    opened.push(store);
    /** Both duty answers for this project at window start W0, plus what was announced. */
    const paid = (over = {}) => {
      const said = { domains: [], ledger: [] };
      const records = duties.openDutyRecords(store, config, { onUnreadable: (n, e) => said.domains.push(`${n}: ${e}`), root, onLedgerUnreadable: (e) => said.ledger.push(e), ...over });
      try {
        return { capture: duties.capturedSince(records, W0), research: duties.researchCapturedSince(records, W0), said };
      } finally {
        records.close();
      }
    };
    return { root, store, paid };
  };
  try {
    return fn({ domain, domainDb, a: project('a'), b: project('b') });
  } finally {
    for (const s of opened) s.close();
    domain.close();
    rmSync(base, { recursive: true, force: true });
  }
}

test('ledger: a domain record B wrote pays B and not A; one A wrote pays A', () =>
  withSharedDomain(({ domain, a, b }) => {
    const byB = domain.create(domainDecision(IN_WINDOW));
    writeLedger(b.root, [{ id: byB.id, type: 'decision', at: IN_WINDOW }]);
    assert.deepEqual({ capture: a.paid().capture, research: a.paid().research }, { capture: false, research: false }, "FOREIGN-WRITE-PAYS SHAPE if true: B's in-window domain record must not pay A");
    assert.deepEqual({ capture: b.paid().capture, research: b.paid().research }, { capture: true, research: true }, 'it pays the project that logged it');

    const byA = domain.create(domainDecision(IN_WINDOW));
    writeLedger(a.root, [{ id: byA.id, type: 'decision', at: IN_WINDOW }]);
    assert.equal(a.paid().capture, true);
    assert.equal(a.paid().research, true);
    assert.deepEqual(a.paid().said, { domains: [], ledger: [] }, 'nothing is degraded');
  }));

test('ledger: a domain record with no entry never pays, with or without a ledger file', () =>
  withSharedDomain(({ domain, a }) => {
    domain.create(domainDecision(IN_WINDOW));
    assert.equal(a.paid().capture, false, 'no ledger file: every existing domain record is unlogged');
    assert.deepEqual(a.paid().said.ledger, [], 'an absent ledger is empty, not an error');
    writeLedger(a.root, [{ id: randomUUID(), type: 'decision', at: IN_WINDOW }]);
    assert.equal(a.paid().capture, false, 'an entry for another id does not pay');
    assert.equal(a.paid().research, false);
  }));

test('ledger: the entry must be inside the window as well as name the id', () =>
  withSharedDomain(({ domain, a }) => {
    // B created it before the window; A updates it inside A's window.
    const rec = domain.create(domainDecision(BEFORE_W0));
    domain.updateRecord(rec.id, { ...rec, rationale: 'r2', updated_at: IN_WINDOW });
    assert.equal(domain.get(rec.id).updated_at, IN_WINDOW);

    writeLedger(a.root, [{ id: rec.id, type: 'decision', at: BEFORE_W0 }]);
    assert.equal(a.paid().capture, false, "ID-ALONE-PAYS SHAPE if true: A's old entry must not let a later write by another project pay");
    assert.equal(a.paid().research, false);

    writeLedger(a.root, [{ id: rec.id, type: 'decision', at: IN_WINDOW }]);
    assert.equal(a.paid().capture, true, 'a record B created, updated by A inside the window, pays A');
    assert.equal(a.paid().research, true);
  }));

test('ledger: an in-window entry does not pay for a record that itself was not written in the window', () =>
  withSharedDomain(({ domain, a }) => {
    const rec = domain.create(domainDecision(BEFORE_W0));
    writeLedger(a.root, [{ id: rec.id, type: 'decision', at: IN_WINDOW }]);
    assert.equal(a.paid().capture, false, 'the record and the entry must both be inside the window');
  }));

test('ledger: a project-store record pays on its own timestamps, with no entry', () =>
  withSharedDomain(({ a }) => {
    a.store.create({ ...domainDecision(IN_WINDOW), scope: 'project' });
    assert.equal(a.paid().capture, true);
    assert.equal(a.paid().research, true);
  }));

test('ledger: a root spelled with a trailing slash reads the same ledger', () =>
  withSharedDomain(({ domain, a }) => {
    const rec = domain.create(domainDecision(IN_WINDOW));
    writeLedger(a.root, [{ id: rec.id, type: 'decision', at: IN_WINDOW }]);
    assert.equal(a.paid({ root: `${a.root}/` }).capture, true);
  }));

test('ledger: with no root there is no ledger, so no domain record pays', () =>
  withSharedDomain(({ domain, a }) => {
    const rec = domain.create(domainDecision(IN_WINDOW));
    writeLedger(a.root, [{ id: rec.id, type: 'decision', at: IN_WINDOW }]);
    assert.equal(a.paid({ root: undefined }).capture, false);
  }));

test('ledger: a file that cannot be read is announced once and pays nothing', () =>
  withSharedDomain(({ domain, a }) => {
    domain.create(domainDecision(IN_WINDOW));
    mkdirSync(ledgerFile(a.root), { recursive: true }); // a directory where the file belongs
    const broken = a.paid();
    assert.deepEqual({ capture: broken.capture, research: broken.research }, { capture: false, research: false });
    assert.equal(broken.said.ledger.length, 1, 'announced once, not once per record or per duty');
    assert.match(broken.said.ledger[0], /EISDIR/);
  }));

test('ledger: a line that does not parse or is not the entry shape is skipped, and the entries around it still count; a file left with no valid entry is reported', () =>
  withSharedDomain(({ domain, a }) => {
    const rec = domain.create(domainDecision(IN_WINDOW));
    for (const bad of [{ id: rec.id, type: 'decision', at: '0' }, { id: rec.id, type: 'decision' }, { id: rec.id, type: 'decision', at: IN_WINDOW, project: a.root }, null, [{ id: rec.id, type: 'decision', at: IN_WINDOW }]]) {
      writeLedger(a.root, [bad]);
      assert.equal(a.paid().capture, false, `ignored: ${JSON.stringify(bad)}`);
      const said = a.paid().said.ledger;
      assert.equal(said.length, 1, 'a non-empty file with no valid entry is reported, once');
      assert.match(said[0], /none of its 1 line\(s\) is a valid entry/);
    }
    assert.deepEqual([...duties.readKnowledgeWrites(a.root).latestAt], []);

    const good = JSON.stringify({ id: rec.id, type: 'decision', at: IN_WINDOW });
    const other = JSON.stringify({ id: 'another-record', type: 'decision', at: IN_WINDOW });
    writeLedger(a.root, `not json at all\n\n${good}\n{"id":"torn","type":"decis\n${other}\n{"id":"cut-short","ty`);
    assert.equal(a.paid().capture, true, 'GARBAGE-LINE-HIDES-ENTRIES SHAPE if false: the entry between a garbage line and a torn one still pays');
    assert.equal(a.paid().research, true);
    assert.deepEqual(a.paid().said.ledger, []);
    assert.deepEqual([...duties.readKnowledgeWrites(a.root).latestAt], [[rec.id, IN_WINDOW], ['another-record', IN_WINDOW]], 'the entry after the torn line is read too');
  }));

test('ledger: several lines for one id count as its latest at, in whatever order they sit', () =>
  withSharedDomain(({ domain, a }) => {
    const rec = domain.create(domainDecision(BEFORE_W0));
    domain.updateRecord(rec.id, { ...rec, rationale: 'r2', updated_at: IN_WINDOW });
    const line = (at) => ({ id: rec.id, type: 'decision', at });
    writeLedger(a.root, [line(BEFORE_W0), line('2026-10-04T10:00:00.000Z')]);
    assert.equal(a.paid().capture, false, 'every line for the id is before the window');
    writeLedger(a.root, [line(IN_WINDOW), line(BEFORE_W0)]);
    assert.equal(a.paid().capture, true, 'one in-window line pays, even when an older line follows it');
    assert.deepEqual([...duties.readKnowledgeWrites(a.root).latestAt], [[rec.id, IN_WINDOW]]);
  }));

test('ledger: an unreadable domain store is still announced and pays nothing, even with an in-window entry for a record in it', () =>
  withSharedDomain(({ domain, domainDb, a }) => {
    const rec = domain.create(domainDecision(IN_WINDOW));
    writeLedger(a.root, [{ id: rec.id, type: 'decision', at: IN_WINDOW }]);
    const opener = (dbPath) => {
      if (dbPath === domainDb) throw new Error('open boom');
      return new SterlingStore(dbPath);
    };
    const r = a.paid({ opener });
    assert.equal(r.capture, false, 'the ledger names an id; only a record actually read can pay');
    assert.equal(r.research, false);
    assert.deepEqual(r.said.domains, ['shared: open boom'], 'the unreadable-domain announcement is kept');
  }));

// One ledger file per server process (board 813fe004): the reader takes the
// union of the legacy single file and every file whose name is exactly the
// per-process pattern, latest `at` per id.
const DEAD_PID = 2147483646; // above any Linux pid_max, so no process can hold it
const processLedgerName = (pid = DEAD_PID, uuid = randomUUID()) => `knowledge-writes.${pid}-${uuid}.jsonl`;
const asLines = (entries) => (typeof entries === 'string' ? entries : entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
function writeLedgerFile(root, name, entries) {
  const p = join(root, '.sterling', 'transient', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, asLines(entries));
  return p;
}

test('ledger union: the legacy file and every per-process file count, with the latest at per id across files', () =>
  withSharedDomain(({ domain, a }) => {
    const inLegacy = domain.create(domainDecision(IN_WINDOW));
    const inProcess = domain.create(domainDecision(IN_WINDOW));
    const inBoth = domain.create(domainDecision(IN_WINDOW));
    const line = (rec, at) => ({ id: rec.id, type: 'decision', at });
    writeLedger(a.root, [line(inLegacy, IN_WINDOW), line(inBoth, BEFORE_W0)]);
    assert.deepEqual([...duties.readKnowledgeWrites(a.root).latestAt], [[inLegacy.id, IN_WINDOW], [inBoth.id, BEFORE_W0]], 'the legacy file alone still reads');

    writeLedgerFile(a.root, processLedgerName(101), [line(inProcess, IN_WINDOW)]);
    writeLedgerFile(a.root, processLedgerName(202), [line(inBoth, IN_WINDOW), line(inLegacy, BEFORE_W0)]);
    const read = duties.readKnowledgeWrites(a.root);
    assert.deepEqual(new Map(read.latestAt), new Map([[inLegacy.id, IN_WINDOW], [inProcess.id, IN_WINDOW], [inBoth.id, IN_WINDOW]]), 'LEDGER-UNION SHAPE if an id is missing or older: every file counts and the newest at wins');
    assert.deepEqual(read.unreadable, []);
    const r = a.paid();
    assert.deepEqual({ capture: r.capture, research: r.research, said: r.said.ledger }, { capture: true, research: true, said: [] });
  }));

test('ledger union: only the exact per-process name is read; a compaction temp file and a near-miss name are not', () =>
  withSharedDomain(({ domain, a }) => {
    const rec = domain.create(domainDecision(IN_WINDOW));
    const entry = [{ id: rec.id, type: 'decision', at: IN_WINDOW }];
    const real = processLedgerName(101);
    for (const name of [`${real}.tmp-101-${randomUUID()}`, `knowledge-writes.jsonl.tmp-101-${randomUUID()}`, 'knowledge-writes.101.jsonl', `knowledge-writes.0-${randomUUID()}.jsonl`, `knowledge-writes.x-${randomUUID()}.jsonl`, `knowledge-writes.101-${randomUUID()}.jsonl.bak`, `other.101-${randomUUID()}.jsonl`]) {
      writeLedgerFile(a.root, name, entry);
    }
    assert.deepEqual([...duties.readKnowledgeWrites(a.root).latestAt], [], 'TEMP-FILE-PAYS SHAPE if an entry shows: none of these names is a ledger file');
    assert.equal(a.paid().capture, false);
    assert.deepEqual(a.paid().said.ledger, [], 'a file that is not a ledger file is not an unreadable ledger');

    writeLedgerFile(a.root, real, entry);
    assert.equal(a.paid().capture, true, 'control: the exact name is read');
  }));

test('ledger union: a corrupt file is reported by name and the valid files still pay', () =>
  withSharedDomain(({ domain, a }) => {
    const rec = domain.create(domainDecision(IN_WINDOW));
    const good = processLedgerName(101);
    const garbage = processLedgerName(202);
    const badStamps = processLedgerName(303);
    const unreadable = processLedgerName(404);
    writeLedgerFile(a.root, good, [{ id: rec.id, type: 'decision', at: IN_WINDOW }]);
    writeLedgerFile(a.root, garbage, 'not json at all\n{"id":"torn","type":"decis\n');
    writeLedgerFile(a.root, badStamps, [{ id: rec.id, type: 'decision', at: '2026-10-04 12:30' }, { id: 'x', type: 'decision', at: '0' }, { id: 'y', type: 'decision', at: 'yesterday' }]);
    mkdirSync(join(a.root, '.sterling', 'transient', unreadable)); // a directory where a file belongs
    writeLedgerFile(a.root, processLedgerName(505), '\n\n'); // blank lines only: empty, nothing to report

    const said = [];
    const r = a.paid({ onLedgerUnreadable: (error, file) => said.push({ error, file }) });
    assert.deepEqual({ capture: r.capture, research: r.research }, { capture: true, research: true }, 'CORRUPT-FILE-HIDES-VALID SHAPE if false: the valid file still pays');
    const rel = (name) => `.sterling/transient/${name}`;
    assert.deepEqual(said.map((x) => x.file).sort(), [rel(garbage), rel(badStamps), rel(unreadable)].sort(), 'each bad file is reported once, by its own name; the valid and the blank ones are not');
    const errorOf = (name) => said.find((x) => x.file === rel(name)).error;
    assert.match(errorOf(garbage), /none of its 2 line\(s\) is a valid entry/);
    assert.match(errorOf(badStamps), /none of its 3 line\(s\) is a valid entry/);
    assert.match(errorOf(unreadable), /EISDIR/);
    assert.deepEqual(duties.readKnowledgeWrites(a.root).unreadable.map((u) => u.file).sort(), said.map((x) => x.file).sort());
  }));

test('ledger union: the reader never removes a file, however old it is and whether or not its owner is alive', () =>
  withSharedDomain(({ domain, a }) => {
    const rec = domain.create(domainDecision(IN_WINDOW));
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const stale = writeLedgerFile(a.root, processLedgerName(DEAD_PID), [{ id: rec.id, type: 'decision', at: IN_WINDOW }]);
    writeLedger(a.root, []);
    for (const p of [stale, ledgerFile(a.root)]) utimesSync(p, old, old);
    assert.equal(a.paid().capture, true, 'an old file of a dead process still counts while it exists');
    assert.equal(existsSync(stale), true, 'READER-DELETES SHAPE if gone: removal is the server\'s, at its start');
    assert.equal(existsSync(ledgerFile(a.root)), true);
  }));

test('ledger union: a transient folder that cannot be listed is reported and pays nothing', () =>
  withSharedDomain(({ domain, a }) => {
    domain.create(domainDecision(IN_WINDOW));
    writeFileSync(join(a.root, '.sterling', 'transient'), 'a file where the folder belongs');
    const said = [];
    const r = a.paid({ onLedgerUnreadable: (error, file) => said.push({ error, file }) });
    assert.equal(r.capture, false);
    assert.equal(said.length, 1);
    assert.equal(said[0].file, '.sterling/transient');
    assert.match(said[0].error, /ENOTDIR/);
  }));
