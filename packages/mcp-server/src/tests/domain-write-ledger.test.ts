import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWLEDGE_WRITES_COMPACT_LINES, KNOWLEDGE_WRITES_KEEP_IDS, KNOWLEDGE_WRITES_REL, knowledgeWriteSchema, parseConfig, type KnowledgeWrite } from '@sterling/schemas';
import { MountedStores, createDomain } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// The domain-write ledger, server side (decision
// domain-record-duty-credit-comes-from-a-per-project-write-ledger): after each
// write of a record a mounted domain store holds, the server appends one
// {id, type, at} line to <repoRoot>/.sterling/transient/knowledge-writes.jsonl.
// The session-end duty reads (scripts/hooks/lib/session-duties.mjs) count a
// domain record only when this file holds an in-window entry for it; that side
// is pinned in scripts/tests/session-duties.test.mjs.

const T0 = '2026-10-04T12:00:00.000Z';
const T1 = '2026-10-04T12:05:00.000Z';
const T2 = '2026-10-04T12:10:00.000Z';
const NOT_LOGGED = /domain-write ledger: this write was NOT logged/;
const notLogged = (warnings: string[]) => warnings.filter((w) => NOT_LOGGED.test(w));

/** Every line of a ledger file that is the shared shape, in file order. */
function readLedger(ledgerPath: string): KnowledgeWrite[] {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const ok = knowledgeWriteSchema.safeParse(JSON.parse(line));
        return ok.success ? [ok.data] : [];
      } catch {
        return [];
      }
    });
}
const seedLines = (entries: KnowledgeWrite[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');

function harness({ repoRoot = true }: { repoRoot?: boolean | string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-write-ledger-'));
  const domainDb = join(dir, 'domains', 'genesys', 'sterling.db');
  createDomain('genesys', 'test domain genesys', domainDb);
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'genesys', dbPath: domainDb }]);
  const clock = { now: T0 };
  const root = typeof repoRoot === 'string' ? repoRoot.replace('<dir>', dir) : repoRoot ? dir : undefined;
  const tools = new SterlingTools({ store, config: parseConfig({ stack_tags: ['genesys'] }), now: () => clock.now, newId: randomUUID, ...(root ? { repoRoot: root } : {}) });
  const ledgerPath = join(dir, KNOWLEDGE_WRITES_REL);
  const ledger = () => readLedger(ledgerPath);
  return {
    dir,
    store,
    tools,
    clock,
    ledgerPath,
    ledger,
    /** The newest line for one record id, which is what a reader counts. */
    latest: (id: string) => ledger().filter((e) => e.id === id).at(-1),
    seed: (text: string) => {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, text);
    },
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Harness = ReturnType<typeof harness>;

const decision = (scope: string, title = 'webhook secrets are per-org') => ({ scope, title, statement: 'one secret per org, checked at the edge', alternatives_rejected: [], rationale: 'r' });

const PASSAGE = ' The vendor documents three attempts with a fixed backoff between them.';
/** A domain decision whose rationale holds a passage knowledge_extract can lift out. */
const extractable = (h: Harness) => h.tools.knowledgeCreate('decision', { ...decision('domain:genesys', 'callbacks are retried'), rationale: `Measured on two orgs.${PASSAGE}` }).record;
const extractInput = (id: string) => ({
  id,
  field: 'rationale',
  find: PASSAGE,
  new_record: { type: 'decision', fields: { title: 'callback retries follow the vendor backoff', statement: 'three attempts, fixed backoff', alternatives_rejected: [], rationale: 'vendor documentation' } },
});

/** A record another project's server wrote into the shared domain store: it is there, and this project's ledger has no line for it. */
function writtenByAnotherProject(store: MountedStores, at: string) {
  return store.create({
    id: randomUUID(),
    type: 'decision',
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    stack_tags: [],
    ...decision('domain:genesys', 'queue routing uses skills'),
  });
}

test('knowledge_create: a domain-scoped create appends {id, type, at}; a project-scoped create logs nothing', () => {
  const h = harness();
  try {
    h.tools.knowledgeCreate('decision', decision('project', 'a project ruling'));
    assert.equal(existsSync(h.ledgerPath), false, 'a project-store record is not logged: it pays the duty by its own timestamps');

    const made = h.tools.knowledgeCreate('decision', decision('domain:genesys'));
    assert.deepEqual(h.ledger(), [{ id: made.record.id, type: 'decision', at: T0 }]);
    assert.equal(notLogged(made.warnings).length, 0, 'a logged write carries no ledger warning');
    const text = readFileSync(h.ledgerPath, 'utf8');
    assert.equal(text.endsWith('\n'), true, 'JSON Lines: every entry ends its own line');
    assert.equal(text.split('\n').filter(Boolean).length, 1);
  } finally {
    h.cleanup();
  }
});

test('every write of a domain record appends a line: update, append, edit, array_remove, supersede and extract; a record another project created is logged when THIS server updates it', () => {
  const h = harness();
  try {
    const foreign = writtenByAnotherProject(h.store, T0);
    assert.deepEqual(h.ledger(), [], 'a record this server did not write has no line');

    h.clock.now = T1;
    h.tools.knowledgeUpdateResult(foreign.id, { rationale: 'measured on two orgs' });
    assert.deepEqual(h.ledger(), [{ id: foreign.id, type: 'decision', at: T1 }], 'knowledge_update: the update is the write this project made');

    const own = h.tools.knowledgeCreate('decision', decision('domain:genesys')).record;
    h.clock.now = T2;
    h.tools.knowledgeAppend(own.id, 'alternatives_rejected', [{ option: 'one global secret', reason: 'a leak exposes every org' }]);
    assert.deepEqual(h.latest(own.id), { id: own.id, type: 'decision', at: T2 }, 'knowledge_append logs');

    h.clock.now = '2026-10-04T12:20:00.000Z';
    h.tools.knowledgeEdit(own.id, 'rationale', 'r', 'the vendor documents one secret per org');
    assert.equal(h.latest(own.id)?.at, '2026-10-04T12:20:00.000Z', 'knowledge_edit logs');

    h.clock.now = '2026-10-04T12:30:00.000Z';
    const version = (h.tools.knowledgeGet(own.id) as unknown as { version: number }).version;
    h.tools.knowledgeArrayRemove(own.id, 'alternatives_rejected[option=one global secret]', version);
    assert.equal(h.latest(own.id)?.at, '2026-10-04T12:30:00.000Z', 'knowledge_array_remove logs');
    assert.equal(h.ledger().filter((e) => e.id === own.id).length, 4, 'append-only: create, append, edit and array_remove are four lines for one id');

    h.clock.now = '2026-10-04T12:40:00.000Z';
    const head = h.tools.knowledgeSupersede(own.id, { title: 'webhook secrets are per-org and rotated', statement: 'one secret per org, rotated every quarter', alternatives_rejected: [], rationale: 'r' });
    assert.deepEqual(h.latest(head.id), { id: head.id, type: 'decision', at: '2026-10-04T12:40:00.000Z' }, 'knowledge_supersede logs the new head');

    const source = extractable(h);
    h.clock.now = '2026-10-04T12:50:00.000Z';
    const before = h.ledger().length;
    const res = h.tools.knowledgeExtractResult(extractInput(source.id));
    assert.deepEqual(h.latest(res.edges.cites), { id: res.edges.cites, type: 'decision', at: '2026-10-04T12:50:00.000Z' }, 'knowledge_extract logs the new record');
    assert.equal(h.latest(source.id)?.at, '2026-10-04T12:50:00.000Z', 'knowledge_extract logs the trimmed source');
    assert.equal(h.ledger().length, before + 2, 'two domain records written, two lines');
    assert.equal(notLogged(res.warnings).length, 0);
  } finally {
    h.cleanup();
  }
});

test('knowledge_line_ref_fix cannot reach a domain record: it takes feature_articles only, and those are always project-scoped', () => {
  const h = harness();
  try {
    const own = h.tools.knowledgeCreate('decision', decision('domain:genesys')).record;
    const lines = h.ledger().length;
    assert.throws(() => h.tools.knowledgeLineRefFix(own.id, 'rationale', 'a.mjs:3', 'a.mjs:4', 'anchor'), /is a decision, not a feature_article/);
    assert.throws(() => h.tools.knowledgeCreate('feature_article', { scope: 'domain:genesys', slug: 'x', title: 't', what_it_does: 'w', intended_behavior: 'i', files: [], current_ac: [], state: 'active' }));
    assert.equal(h.ledger().length, lines, 'so it has no ledger line to write and no warning to carry');
  } finally {
    h.cleanup();
  }
});

test('knowledge_promote logs the promoted domain copy, not the project original', () => {
  const h = harness();
  try {
    const original = h.tools.knowledgeCreate('decision', decision('project')).record;
    h.clock.now = T1;
    const { promoted, warnings } = h.tools.knowledgePromote(original.id, 'genesys');
    assert.deepEqual(h.ledger(), [{ id: promoted.id, type: 'decision', at: T1 }]);
    assert.equal(notLogged(warnings).length, 0);
  } finally {
    h.cleanup();
  }
});

test('knowledge_extract logs only after its transaction commits: a rolled-back extract leaves no line', () => {
  const h = harness();
  try {
    const source = extractable(h);
    const before = readFileSync(h.ledgerPath, 'utf8');
    const store = h.store as unknown as { addLink: (...args: unknown[]) => unknown };
    const realAddLink = store.addLink;
    store.addLink = () => {
      throw new Error('late failure after both writes');
    };
    try {
      assert.throws(() => h.tools.knowledgeExtractResult(extractInput(source.id)), /late failure after both writes/);
    } finally {
      store.addLink = realAddLink;
    }
    assert.equal((h.tools.knowledgeGet(source.id) as unknown as { rationale: string }).rationale.includes(PASSAGE), true, 'fixture: the extract rolled back');
    assert.equal(readFileSync(h.ledgerPath, 'utf8'), before, 'ROLLED-BACK-WRITE-LOGGED SHAPE if this differs: a line for a write that never landed');

    const res = h.tools.knowledgeExtractResult(extractInput(source.id));
    assert.equal(h.ledger().filter((e) => e.id === res.edges.cites || e.id === source.id).length, 3, 'control: the next extract logs normally (source create + new record + source trim)');
  } finally {
    h.cleanup();
  }
});

test('a caller cannot add a ledger line: no field of a write reaches the ledger, and a project record cannot be relabelled into it', () => {
  const h = harness();
  try {
    const forged = { id: randomUUID(), type: 'decision', at: T2 };
    assert.throws(() => h.tools.knowledgeCreate('decision', { ...decision('project'), knowledge_writes: [forged] }), 'an unknown field is refused, not written anywhere');
    assert.throws(() => h.tools.knowledgeCreate('decision', { ...decision('project'), id: forged.id }), 'the id is server-owned');
    const project = h.tools.knowledgeCreate('decision', decision('project')).record;
    assert.throws(() => h.tools.knowledgeUpdateResult(project.id, { scope: 'domain:genesys' }), 'scope is immutable after creation');
    h.tools.knowledgeUpdateResult(project.id, { rationale: 'still a project record' });
    assert.equal(existsSync(h.ledgerPath), false, 'none of it produced a ledger file');

    const real = h.tools.knowledgeCreate('decision', { ...decision('domain:genesys'), stack_tags: ['genesys'] }).record;
    assert.deepEqual(h.ledger(), [{ id: real.id, type: 'decision', at: T0 }], 'the line carries the stored id and type and the server clock, nothing else');
  } finally {
    h.cleanup();
  }
});

test(`compaction: past ${KNOWLEDGE_WRITES_COMPACT_LINES} lines the file is rewritten to the latest line of each id, and an in-window entry survives it`, () => {
  const h = harness();
  try {
    const first: KnowledgeWrite = { id: 'first-in-window', type: 'decision', at: T0 };
    const busy = (i: number): KnowledgeWrite => ({ id: i % 2 ? 'busy-a' : 'busy-b', type: 'decision', at: new Date(Date.parse(T1) + i * 1000).toISOString() });

    // One short of the threshold after the write: nothing is rewritten.
    h.seed(seedLines([first, ...Array.from({ length: KNOWLEDGE_WRITES_COMPACT_LINES - 2 }, (_, i) => busy(i))]));
    h.clock.now = '2026-10-04T13:00:00.000Z';
    const atLimit = h.tools.knowledgeCreate('decision', decision('domain:genesys')).record;
    assert.equal(h.ledger().length, KNOWLEDGE_WRITES_COMPACT_LINES, `${KNOWLEDGE_WRITES_COMPACT_LINES} lines is not past the threshold`);

    // The next write passes it.
    const over = h.tools.knowledgeCreate('decision', decision('domain:genesys', 'callbacks retry three times'));
    const after = h.ledger();
    assert.deepEqual(after.map((e) => e.id).sort(), ['busy-a', 'busy-b', 'first-in-window', atLimit.id, over.record.id].sort(), 'one line per id after compaction');
    assert.deepEqual(after.find((e) => e.id === first.id), first, 'COMPACTION-EVICTS-IN-WINDOW SHAPE if this is missing: 1001 writes over five records keep the first record\'s line');
    assert.equal(after.find((e) => e.id === 'busy-a')?.at, busy(KNOWLEDGE_WRITES_COMPACT_LINES - 3).at, 'each id keeps its LATEST at');
    assert.equal(over.warnings.some((w) => /domain-write ledger/.test(w)), false, 'a compaction is not a warning');
  } finally {
    h.cleanup();
  }
});

test(`compaction: the stated bound is the newest ${KNOWLEDGE_WRITES_KEEP_IDS} record ids`, () => {
  const h = harness();
  try {
    const distinct = Array.from({ length: KNOWLEDGE_WRITES_COMPACT_LINES }, (_, i): KnowledgeWrite => ({ id: `id-${i}`, type: 'decision', at: new Date(Date.parse(T0) + i * 1000).toISOString() }));
    h.seed(seedLines(distinct));
    h.clock.now = '2026-10-04T13:00:00.000Z';
    const made = h.tools.knowledgeCreate('decision', decision('domain:genesys')).record;
    const after = h.ledger();
    assert.equal(after.length, KNOWLEDGE_WRITES_KEEP_IDS);
    assert.equal(after.at(-1)?.id, made.id, 'the newest write is kept');
    assert.equal(after[0].id, `id-${KNOWLEDGE_WRITES_COMPACT_LINES - KNOWLEDGE_WRITES_KEEP_IDS + 1}`, 'the oldest ids are the ones dropped');
    assert.equal(after.some((e) => e.id === 'id-0'), false);
  } finally {
    h.cleanup();
  }
});

test('a garbage line and a torn last line do not stop the append, and the lines around them stay readable', () => {
  const h = harness();
  try {
    const kept: KnowledgeWrite = { id: 'before-garbage', type: 'decision', at: T0 };
    // The file ends in a torn line with no newline, as a write cut short would leave it.
    h.seed(`${JSON.stringify(kept)}\nnot json at all\n{"id":"wrong-shape"}\n{"id":"torn","type":"decis`);
    const made = h.tools.knowledgeCreate('decision', decision('domain:genesys'));
    assert.deepEqual(h.ledger(), [kept, { id: made.record.id, type: 'decision', at: T0 }], 'TORN-LINE-SWALLOWS-NEXT SHAPE if the new entry is missing: the append starts its own line');
    assert.equal(made.warnings.some((w) => /domain-write ledger/.test(w)), false, 'nothing is read on the write path, so nothing is reported');
    assert.match(readFileSync(h.ledgerPath, 'utf8'), /not json at all/, 'the write path does not rewrite what is already there');
  } finally {
    h.cleanup();
  }
});

test('concurrency: several server processes appending under one root lose no entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sterling-write-ledger-shared-'));
  try {
    mkdirSync(join(root, '.sterling'));
    const child = join(dirname(fileURLToPath(import.meta.url)), 'test-helpers', 'ledger-writer-child.js');
    const PROCESSES = 8;
    const WRITES = 40;
    const runs = await Promise.all(
      Array.from(
        { length: PROCESSES },
        () =>
          new Promise<string[]>((resolve, reject) => {
            const proc = spawn(process.execPath, [child, root, String(WRITES)], { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            let err = '';
            proc.stdout.on('data', (d) => (out += d));
            proc.stderr.on('data', (d) => (err += d));
            proc.on('error', reject);
            proc.on('close', (code) => (code === 0 ? resolve(JSON.parse(out) as string[]) : reject(new Error(`child exited ${code}: ${err}`))));
          })
      )
    );
    const written = runs.flat();
    assert.equal(written.length, PROCESSES * WRITES, 'fixture: every child made all its writes');
    const logged = new Set(readLedger(join(root, KNOWLEDGE_WRITES_REL)).map((e) => e.id));
    const lost = written.filter((id) => !logged.has(id));
    assert.equal(lost.length, 0, `LOST-APPEND SHAPE: ${lost.length} of ${written.length} writes have no ledger line`);
    assert.equal(readFileSync(join(root, KNOWLEDGE_WRITES_REL), 'utf8').split('\n').filter(Boolean).length, written.length, 'and no line is torn or doubled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repo root spelled with a trailing slash writes the same ledger file', () => {
  const h = harness({ repoRoot: '<dir>/' });
  try {
    const made = h.tools.knowledgeCreate('decision', decision('domain:genesys')).record;
    assert.deepEqual(h.ledger(), [{ id: made.id, type: 'decision', at: T0 }], 'read back at join(dir, KNOWLEDGE_WRITES_REL), the spelling the hooks use');
  } finally {
    h.cleanup();
  }
});

/** Every tool that writes a domain record, run once; each receipt must carry exactly `perWrite` not-logged warnings per domain record it wrote. */
function assertEveryReceiptWarns(h: Harness, why: RegExp) {
  const made = h.tools.knowledgeCreate('decision', decision('domain:genesys'));
  assert.equal(h.tools.knowledgeGet(made.record.id).scope, 'domain:genesys', 'the knowledge write itself succeeded');
  assert.equal(notLogged(made.warnings).length, 1, 'knowledge_create warns');
  assert.match(notLogged(made.warnings)[0], why);
  const id = made.record.id;

  assert.equal(notLogged(h.tools.knowledgeUpdateResult(id, { rationale: 'r2' }).warnings).length, 1, 'knowledge_update warns');
  assert.equal(notLogged(h.tools.knowledgeAppend(id, 'alternatives_rejected', [{ option: 'o', reason: 'because' }]).warnings).length, 1, 'knowledge_append warns');
  assert.equal(notLogged(h.tools.knowledgeEdit(id, 'rationale', 'r2', 'r3').warnings).length, 1, 'knowledge_edit warns');
  const version = (h.tools.knowledgeGet(id) as unknown as { version: number }).version;
  assert.equal(notLogged(h.tools.knowledgeArrayRemove(id, 'alternatives_rejected[option=o]', version).warnings).length, 1, 'knowledge_array_remove warns');
  const head = h.tools.knowledgeSupersede(id, { title: 'webhook secrets are per-org and rotated', statement: 'one secret per org, rotated every quarter', alternatives_rejected: [], rationale: 'r' });
  assert.equal(notLogged(head.warnings).length, 1, 'knowledge_supersede warns');

  const source = extractable(h);
  const extracted = h.tools.knowledgeExtractResult(extractInput(source.id));
  assert.equal(notLogged(extracted.warnings).length, 2, 'EXTRACT-DROPS-LEDGER-WARNINGS SHAPE if this is 0: knowledge_extract wrote two domain records and names both');
  assert.equal(extracted.warnings.some((w) => w.includes(extracted.edges.cites)), true, 'one warning names the new record');
  assert.equal(extracted.warnings.some((w) => w.includes(source.id)), true, 'one names the trimmed source');
  assert.equal((h.tools.knowledgeGet(source.id) as unknown as { ledger_warning?: unknown }).ledger_warning, undefined, 'the warning is a receipt field, never a record field');

  const project = h.tools.knowledgeCreate('decision', decision('project', 'a project ruling'));
  assert.equal(notLogged(project.warnings).length, 0, 'a project write needs no ledger, so it does not warn');
  assert.equal(notLogged(h.tools.knowledgePromote(project.record.id, 'genesys').warnings).length, 1, 'knowledge_promote warns');
}

test('no repoRoot: the records are written, no ledger is written, and every domain write says so on its receipt', () => {
  const h = harness({ repoRoot: false });
  try {
    assertEveryReceiptWarns(h, /no project root is known to this server/);
    assert.equal(existsSync(h.ledgerPath), false);
  } finally {
    h.cleanup();
  }
});

test('a ledger that cannot be written never fails the knowledge write; every domain write says so on its receipt', () => {
  const h = harness();
  try {
    mkdirSync(h.ledgerPath, { recursive: true }); // a directory where the file belongs
    assertEveryReceiptWarns(h, /EISDIR/);
  } finally {
    h.cleanup();
  }
});

test('a root with no .sterling directory gets no ledger and no new directory; the receipt says the write was not logged', () => {
  const h = harness({ repoRoot: '<dir>/elsewhere' });
  try {
    mkdirSync(join(h.dir, 'elsewhere'));
    const made = h.tools.knowledgeCreate('decision', decision('domain:genesys'));
    assert.equal(h.tools.knowledgeGet(made.record.id).id, made.record.id, 'the record landed');
    assert.equal(existsSync(join(h.dir, 'elsewhere', '.sterling')), false, 'STRAY-DOT-STERLING SHAPE if this exists: the ledger never plants a .sterling directory');
    assert.match(notLogged(made.warnings)[0] ?? '', /has no \.sterling directory/);
  } finally {
    h.cleanup();
  }
});

test('the maintenance-worker child logs like any other server under the same root (STERLING_MAINTENANCE_WORKER=1)', () => {
  const before = process.env.STERLING_MAINTENANCE_WORKER;
  process.env.STERLING_MAINTENANCE_WORKER = '1';
  const h = harness();
  try {
    const made = h.tools.knowledgeCreate('decision', decision('domain:genesys')).record;
    assert.deepEqual(h.ledger(), [{ id: made.id, type: 'decision', at: T0 }], 'a worker write under this root is this project\'s write');
  } finally {
    h.cleanup();
    if (before === undefined) delete process.env.STERLING_MAINTENANCE_WORKER;
    else process.env.STERLING_MAINTENANCE_WORKER = before;
  }
});
