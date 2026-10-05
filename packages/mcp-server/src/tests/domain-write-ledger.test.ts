import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KNOWLEDGE_WRITES_COMPACT_LINES, KNOWLEDGE_WRITES_DIR_REL, KNOWLEDGE_WRITES_KEEP_IDS, KNOWLEDGE_WRITES_PROCESS_FILE, KNOWLEDGE_WRITES_REL, KNOWLEDGE_WRITES_RETENTION_MS, knowledgeWriteSchema, knowledgeWritesOwnerPid, knowledgeWritesProcessFile, knowledgeWritesTempFile, parseConfig, type KnowledgeWrite } from '@sterling/schemas';
import { MountedStores, createDomain } from '@sterling/store';
import { createSterlingServer } from '../server.js';
import { PROCESS_KNOWLEDGE_WRITES_REL, SterlingTools } from '../tools.js';

// The domain-write ledger, server side (decision
// domain-record-duty-credit-comes-from-a-per-project-write-ledger): after each
// write of a record a mounted domain store holds, the server appends one
// {id, type, at} line to its OWN file under the project root,
// .sterling/transient/knowledge-writes.<pid>-<uuid>.jsonl
// (PROCESS_KNOWLEDGE_WRITES_REL): one file per server process (board 813fe004),
// because appends from two processes to one file overwrite each other on
// /mnt/c under WSL2. The session-end duty reads
// (scripts/hooks/lib/session-duties.mjs) take the union of those files and the
// legacy knowledge-writes.jsonl, and count a domain record only when the union
// holds an in-window entry for it; that side is pinned in
// scripts/tests/session-duties.test.mjs.

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
  // This process's own ledger file: every SterlingTools in this test process writes the same name under its own root.
  const ledgerPath = join(dir, PROCESS_KNOWLEDGE_WRITES_REL);
  const ledger = () => readLedger(ledgerPath);
  return {
    dir,
    root,
    legacyPath: join(dir, KNOWLEDGE_WRITES_REL),
    transientDir: join(dir, KNOWLEDGE_WRITES_DIR_REL),
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

type LedgerRead = { latestAt: Map<string, string>; unreadable: { file: string; error: string }[] };
/** The reader H10 and the OpenCode settlement share, loaded from its source: the union this suite's writer side must satisfy. */
async function unionReader(): Promise<(root: string) => LedgerRead> {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'scripts', 'hooks', 'lib', 'session-duties.mjs');
  const mod = (await import(pathToFileURL(src).href)) as { readKnowledgeWrites: (root: string) => LedgerRead };
  return mod.readKnowledgeWrites;
}

// The probe behind board 813fe004. The shared root defaults to os.tmpdir(), a
// Linux filesystem; point STERLING_LEDGER_PROBE_DIR at a directory on /mnt/c
// to run it where appends from several processes to ONE file lost entries
// (finding o-append-is-not-atomic-across-processes-on-wsl2-mnt-c). The ledger
// files are written under that directory; each child's stores stay in tmpdir.
test('concurrency: several server processes writing under one root lose no entry, each in its own ledger file', async (t) => {
  const root = mkdtempSync(join(process.env.STERLING_LEDGER_PROBE_DIR ?? tmpdir(), 'sterling-write-ledger-shared-'));
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
    const read = (await unionReader())(root);
    const lost = written.filter((id) => !read.latestAt.has(id));
    t.diagnostic(`ledger probe: ${written.length - lost.length} of ${written.length} entries in the union under ${root}`);
    assert.equal(lost.length, 0, `LOST-APPEND SHAPE: ${lost.length} of ${written.length} writes have no entry in the union of the ledger files`);
    assert.deepEqual(read.unreadable, []);

    const files = readdirSync(join(root, KNOWLEDGE_WRITES_DIR_REL));
    assert.equal(files.length, PROCESSES, 'one ledger file per process, and no temp file left behind');
    assert.equal(files.every((f) => KNOWLEDGE_WRITES_PROCESS_FILE.test(f)), true, 'each is named by the per-process pattern; nothing wrote the legacy file');
    assert.equal(new Set(files.map(knowledgeWritesOwnerPid)).size, PROCESSES, 'each carries its own owner pid');
    for (const f of files) {
      assert.equal(readFileSync(join(root, KNOWLEDGE_WRITES_DIR_REL, f), 'utf8').split('\n').filter(Boolean).length, WRITES, `${f}: no line is torn or doubled`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repo root spelled with a trailing slash writes the same ledger file', () => {
  const h = harness({ repoRoot: '<dir>/' });
  try {
    const made = h.tools.knowledgeCreate('decision', decision('domain:genesys')).record;
    assert.deepEqual(h.ledger(), [{ id: made.id, type: 'decision', at: T0 }], 'read back at join(dir, PROCESS_KNOWLEDGE_WRITES_REL), the spelling the hooks use');
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

// -- one file per server process (board 813fe004) ---------------------------

test('the ledger file is this process\'s own: named by its pid, fixed for the process, created by the first domain write, and the legacy file is never written', () => {
  const h = harness();
  const other = harness();
  try {
    const name = PROCESS_KNOWLEDGE_WRITES_REL.slice(KNOWLEDGE_WRITES_DIR_REL.length + 1);
    assert.equal(PROCESS_KNOWLEDGE_WRITES_REL.startsWith(`${KNOWLEDGE_WRITES_DIR_REL}/`), true);
    assert.match(name, KNOWLEDGE_WRITES_PROCESS_FILE);
    assert.equal(knowledgeWritesOwnerPid(name), process.pid);
    assert.equal(existsSync(h.transientDir), false, 'nothing is created before the first domain write');

    h.tools.knowledgeCreate('decision', decision('domain:genesys'));
    h.tools.knowledgeCreate('decision', decision('domain:genesys', 'callbacks retry three times'));
    other.tools.knowledgeCreate('decision', decision('domain:genesys'));
    assert.deepEqual(readdirSync(h.transientDir), [name], 'every write of this process goes to the one file');
    assert.deepEqual(readdirSync(other.transientDir), [name], 'a second tools instance in the same process uses the same name under its own root');
    assert.equal(existsSync(h.legacyPath), false, 'LEGACY-APPEND SHAPE if this exists: nothing appends to knowledge-writes.jsonl any more');
    assert.equal(h.ledger().length, 2);
  } finally {
    h.cleanup();
    other.cleanup();
  }
});

test('the file name pattern is exact: a pid and a uuid, nothing before or after', () => {
  const uuid = randomUUID();
  assert.equal(knowledgeWritesOwnerPid(knowledgeWritesProcessFile(4321, uuid)), 4321);
  for (const name of ['knowledge-writes.jsonl', `knowledge-writes.4321-${uuid}.jsonl.tmp-4321-${randomUUID()}`, `knowledge-writes.0-${uuid}.jsonl`, `knowledge-writes.-1-${uuid}.jsonl`, `knowledge-writes.4321-${uuid.toUpperCase()}.jsonl`, 'knowledge-writes.4321.jsonl', `x-knowledge-writes.4321-${uuid}.jsonl`, `knowledge-writes.4321-${uuid}.json`, `knowledge-writes.99999999999999999999-${uuid}.jsonl`]) {
    assert.equal(knowledgeWritesOwnerPid(name), null, `${name} names no owner`);
  }
});

const DEAD_PID = 2147483646; // above any Linux pid_max (at most 2^22), so no process can hold it
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const ENTRY = seedLines([{ id: 'kept-or-not', type: 'decision', at: T0 }]);

/** A project root with ledger files of other processes in it, and the removal a server start runs under it. */
function startHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-write-ledger-start-'));
  const transient = join(dir, KNOWLEDGE_WRITES_DIR_REL);
  mkdirSync(transient, { recursive: true });
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), []);
  return {
    dir,
    transient,
    /** Writes one file in the transient folder with the given age. */
    file: (name: string, ageDays: number, text = ENTRY) => {
      const p = join(transient, name);
      writeFileSync(p, text);
      utimesSync(p, daysAgo(ageDays), daysAgo(ageDays));
      return name;
    },
    /** The removal a server start runs under this root (createSterlingServer calls it once); returns its report. */
    start: () => new SterlingTools({ store, repoRoot: dir }).removeExpiredDomainWriteLedgers(),
    names: () => readdirSync(transient).sort(),
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('server start removes another process\'s ledger file only when it is older than 7 days AND its owner pid is gone', () => {
  const h = startHarness();
  try {
    assert.equal(KNOWLEDGE_WRITES_RETENTION_MS, 7 * DAY_MS);
    const expiredDead = h.file(knowledgeWritesProcessFile(DEAD_PID, randomUUID()), 8);
    const expiredLive = h.file(knowledgeWritesProcessFile(process.ppid, randomUUID()), 30);
    const expiredNotOurs = h.file(knowledgeWritesProcessFile(1, randomUUID()), 30); // pid 1: alive, and EPERM for a non-root user
    const recentDead = h.file(knowledgeWritesProcessFile(DEAD_PID, randomUUID()), 6);
    const freshDead = h.file(knowledgeWritesProcessFile(DEAD_PID, randomUUID()), 0);
    const ownPidOtherRun = h.file(knowledgeWritesProcessFile(process.pid, randomUUID()), 30);
    const own = h.file(PROCESS_KNOWLEDGE_WRITES_REL.slice(KNOWLEDGE_WRITES_DIR_REL.length + 1), 30);
    const tempFile = h.file(`${knowledgeWritesProcessFile(DEAD_PID, randomUUID())}.tmp-${DEAD_PID}`, 30); // not exactly the temp pattern
    const nearMiss = h.file(`knowledge-writes.${DEAD_PID}.jsonl`, 30);
    const unrelated = h.file('session-events.json', 30, '[]');

    assert.equal(h.start(), undefined, 'nothing to report');
    const left = h.names();
    assert.equal(left.includes(expiredDead), false, 'EXPIRED-DEAD-KEPT SHAPE if present: older than 7 days and the owner is gone, so it is removed');
    assert.equal(left.includes(expiredLive), true, 'LIVE-OWNER-REMOVED SHAPE if missing: an expired file whose owner is alive is kept');
    assert.equal(left.includes(expiredNotOurs), true, 'a pid that cannot be probed as gone keeps its file');
    assert.equal(left.includes(recentDead), true, 'DEAD-OWNER-ALONE-REMOVES SHAPE if missing: a dead owner with a file inside 7 days is kept, the session still needs its entries');
    assert.equal(left.includes(freshDead), true);
    assert.equal(left.includes(ownPidOtherRun), true, 'a live pid keeps the file, whichever run wrote it');
    assert.equal(left.includes(own), true, 'this process\'s own file is never removed');
    assert.deepEqual([tempFile, nearMiss, unrelated].filter((n) => !left.includes(n)), [], 'a name that is not exactly a ledger or temp file name is never removed');
    assert.equal(left.length, 9);
  } finally {
    h.cleanup();
  }
});

test('server start removes the legacy ledger file on age alone: it has no owner and no writer', () => {
  const recent = startHarness();
  const expired = startHarness();
  try {
    recent.file('knowledge-writes.jsonl', 6);
    assert.equal(recent.start(), undefined);
    assert.deepEqual(recent.names(), ['knowledge-writes.jsonl'], 'inside 7 days it is kept, and still read by the union');

    expired.file('knowledge-writes.jsonl', 8);
    assert.equal(expired.start(), undefined);
    assert.deepEqual(expired.names(), [], 'EXPIRED-LEGACY-KEPT SHAPE if present: older than 7 days, removed');
  } finally {
    recent.cleanup();
    expired.cleanup();
  }
});

test('removal runs at server start only: no write and no later call path removes a file that expires afterwards', () => {
  const h = harness();
  try {
    h.tools.knowledgeCreate('decision', decision('domain:genesys'));
    const late = join(h.transientDir, knowledgeWritesProcessFile(DEAD_PID, randomUUID()));
    writeFileSync(late, ENTRY);
    utimesSync(late, daysAgo(30), daysAgo(30));
    h.tools.knowledgeCreate('decision', decision('domain:genesys', 'callbacks retry three times'));
    assert.equal(existsSync(late), true, 'a domain write does not run the removal');
    assert.equal(h.tools.removeExpiredDomainWriteLedgers(), undefined, 'control: the rule itself removes it and reports nothing');
    assert.equal(existsSync(late), false);
  } finally {
    h.cleanup();
  }
});

test('a compaction temp file a crash left is removed by the same rule: older than 7 days AND its pid gone', () => {
  const h = startHarness();
  try {
    const ledgerOf = (pid: number) => knowledgeWritesProcessFile(pid, randomUUID());
    const expiredDead = h.file(knowledgeWritesTempFile(ledgerOf(DEAD_PID), DEAD_PID, randomUUID()), 8);
    const expiredDeadLegacy = h.file(knowledgeWritesTempFile('knowledge-writes.jsonl', DEAD_PID, randomUUID()), 8);
    const expiredLive = h.file(knowledgeWritesTempFile(ledgerOf(process.ppid), process.ppid, randomUUID()), 30);
    const expiredOwn = h.file(knowledgeWritesTempFile(PROCESS_KNOWLEDGE_WRITES_REL.slice(KNOWLEDGE_WRITES_DIR_REL.length + 1), process.pid, randomUUID()), 30);
    const expiredNotOurs = h.file(knowledgeWritesTempFile(ledgerOf(1), 1, randomUUID()), 30);
    // The pid that decides is the temp file's own, not the one in the ledger name before it.
    const expiredLiveCompactor = h.file(knowledgeWritesTempFile(ledgerOf(DEAD_PID), process.ppid, randomUUID()), 30);
    const recentDead = h.file(knowledgeWritesTempFile(ledgerOf(DEAD_PID), DEAD_PID, randomUUID()), 6);

    assert.equal(h.start(), undefined);
    const left = h.names();
    assert.deepEqual([expiredDead, expiredDeadLegacy].filter((n) => left.includes(n)), [], 'TEMP-LEFTOVER-KEPT SHAPE if any is listed: expired and its pid gone, so it is removed');
    assert.equal(left.includes(expiredLive), true, 'LIVE-COMPACTOR-TEMP-REMOVED SHAPE if missing: a live pid may be about to rename it');
    assert.equal(left.includes(expiredOwn), true);
    assert.equal(left.includes(expiredNotOurs), true, 'a pid that cannot be probed as gone keeps its temp file');
    assert.equal(left.includes(expiredLiveCompactor), true);
    assert.equal(left.includes(recentDead), true, 'a dead pid alone does not remove a temp file inside 7 days');
    assert.equal(left.length, 5);
  } finally {
    h.cleanup();
  }
});

test('constructing SterlingTools removes nothing and writes nothing to stderr: the removal is the server start\'s call', () => {
  const h = startHarness();
  const written: string[] = [];
  const realWrite = process.stderr.write;
  try {
    const expiredDead = h.file(knowledgeWritesProcessFile(DEAD_PID, randomUUID()), 30);
    const stuck = knowledgeWritesProcessFile(DEAD_PID, randomUUID());
    mkdirSync(join(h.transient, stuck));
    utimesSync(join(h.transient, stuck), daysAgo(30), daysAgo(30));
    const store = new MountedStores(join(h.dir, '.sterling', 'second.db'), []);
    process.stderr.write = ((chunk: unknown) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      new SterlingTools({ store, repoRoot: h.dir });
    } finally {
      process.stderr.write = realWrite;
      store.close();
    }
    assert.deepEqual(h.names(), [expiredDead, stuck].sort(), 'CONSTRUCTOR-SWEEPS SHAPE if a file is gone: a tools object built outside a server start (a test harness, knowledge-eval) removes nothing');
    assert.deepEqual(written, [], 'and reports nothing');
  } finally {
    process.stderr.write = realWrite;
    h.cleanup();
  }
});

test('server start (createSterlingServer) runs the removal once, announces a failed removal once on stderr, and still starts', async () => {
  const h = startHarness();
  const written: string[] = [];
  const realWrite = process.stderr.write;
  try {
    const removable = h.file(knowledgeWritesProcessFile(DEAD_PID, randomUUID()), 30);
    const leftoverTemp = h.file(knowledgeWritesTempFile(knowledgeWritesProcessFile(DEAD_PID, randomUUID()), DEAD_PID, randomUUID()), 30);
    const recent = h.file(knowledgeWritesProcessFile(DEAD_PID, randomUUID()), 1);
    const stuck = knowledgeWritesProcessFile(DEAD_PID, randomUUID());
    mkdirSync(join(h.transient, stuck)); // cannot be unlinked: a directory where a file belongs
    utimesSync(join(h.transient, stuck), daysAgo(30), daysAgo(30));

    process.stderr.write = ((chunk: unknown) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
    let started;
    try {
      started = createSterlingServer(join(h.dir, '.sterling', 'server.db')); // REMOVAL-FAILS-START SHAPE if this throws
    } finally {
      process.stderr.write = realWrite;
    }
    try {
      assert.deepEqual(h.names().filter((n) => n.startsWith('knowledge-writes.')), [recent, stuck].sort(), 'the start removed what the rule allows, a crash-left temp file included, and kept the rest');
      assert.equal([removable, leftoverTemp].some((n) => h.names().includes(n)), false);
      const said = written.filter((w) => /domain-write ledger/.test(w));
      assert.equal(said.length, 1, `announced once: ${JSON.stringify(written)}`);
      assert.equal(said[0].startsWith('domain-write ledger: 1 expired ledger file(s) in .sterling/transient could not be removed ('), true, said[0]);
      assert.equal(said[0].includes(stuck), true);
      assert.equal(typeof started.tools.knowledgeCreate, 'function', 'the server started');
    } finally {
      started.store.close();
    }
  } finally {
    process.stderr.write = realWrite;
    h.cleanup();
  }
});

test('a removal that fails is reported in one message naming each file; a root with no transient folder reports nothing', () => {
  const h = startHarness();
  try {
    // Two expired dead-owner entries that cannot be unlinked: each is a directory where a file belongs.
    const stuck = [knowledgeWritesProcessFile(DEAD_PID, randomUUID()), knowledgeWritesProcessFile(DEAD_PID, randomUUID())];
    for (const name of stuck) {
      mkdirSync(join(h.transient, name));
      utimesSync(join(h.transient, name), daysAgo(30), daysAgo(30));
    }
    const removable = h.file(knowledgeWritesProcessFile(DEAD_PID, randomUUID()), 30);

    const said = h.start();
    assert.equal(h.names().includes(removable), false, 'the removable file is still removed');
    assert.equal(h.start(), said, 'a later start reports the same files again: they are still there');
    assert.match(said ?? '', /^domain-write ledger: 2 expired ledger file\(s\) in \.sterling\/transient could not be removed \(/, 'ONE message for both files');
    for (const name of stuck) assert.equal(said?.includes(name), true, 'each file that stays is named');
    assert.match(said ?? '', /they stay until a later server start removes them\.$/);

    const bare = harness({ repoRoot: false });
    const fresh = harness();
    try {
      assert.equal(bare.tools.removeExpiredDomainWriteLedgers(), undefined, 'no repoRoot: nothing to list');
      assert.equal(fresh.tools.removeExpiredDomainWriteLedgers(), undefined, 'no transient folder yet: nothing to remove, nothing to report');
      assert.equal(existsSync(fresh.transientDir), false, 'and the removal never creates the folder');
    } finally {
      bare.cleanup();
      fresh.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

// A symlink to itself makes statSync fail with ELOOP, a stat failure that needs no root and no child process.
test('a ledger file whose age cannot be read is kept and reported by err.code only, with no path in the message', () => {
  const h = startHarness();
  try {
    const loop = knowledgeWritesProcessFile(DEAD_PID, randomUUID());
    symlinkSync(loop, join(h.transient, loop));
    const removable = h.file(knowledgeWritesProcessFile(DEAD_PID, randomUUID()), 30);

    const said = h.start();
    assert.equal(lstatSync(join(h.transient, loop)).isSymbolicLink(), true, 'STAT-FAILURE-REMOVED SHAPE if gone: a file with an unknown age is kept');
    assert.equal(h.names().includes(removable), false, 'the removable file is still removed');
    assert.match(said ?? '', /^domain-write ledger: 1 expired ledger file\(s\) in \.sterling\/transient could not be removed \(/, 'the stat failure joins the one failure report');
    assert.equal(said?.includes(`${loop}: ELOOP`), true, said);
    assert.equal(said?.includes(h.dir), false, 'PATH-IN-NOTICE SHAPE if true: the report holds the file name and err.code, never an absolute path');
  } finally {
    h.cleanup();
  }
});

test('compaction rewrites only this process\'s own file: another process\'s file and the legacy file stay byte-identical', () => {
  const h = harness();
  try {
    const big = seedLines(Array.from({ length: KNOWLEDGE_WRITES_COMPACT_LINES + 50 }, (_, i): KnowledgeWrite => ({ id: `other-${i}`, type: 'decision', at: new Date(Date.parse(T0) + i * 1000).toISOString() })));
    mkdirSync(h.transientDir, { recursive: true });
    const foreign = join(h.transientDir, knowledgeWritesProcessFile(DEAD_PID, randomUUID()));
    writeFileSync(foreign, big);
    writeFileSync(h.legacyPath, big);
    h.seed(seedLines(Array.from({ length: KNOWLEDGE_WRITES_COMPACT_LINES }, (): KnowledgeWrite => ({ id: 'busy', type: 'decision', at: T0 }))));

    h.clock.now = T1;
    const made = h.tools.knowledgeCreate('decision', decision('domain:genesys'));
    assert.deepEqual(h.ledger(), [{ id: 'busy', type: 'decision', at: T0 }, { id: made.record.id, type: 'decision', at: T1 }], 'fixture: the own file was compacted');
    assert.equal(readFileSync(foreign, 'utf8'), big, 'COMPACTS-ANOTHER-PROCESS SHAPE if this differs: a file past the threshold that is not ours is left alone');
    assert.equal(readFileSync(h.legacyPath, 'utf8'), big, 'the legacy file is never compacted either');
    assert.deepEqual(readdirSync(h.transientDir).filter((n) => n.includes('.tmp-')), [], 'no temp file is left behind');
  } finally {
    h.cleanup();
  }
});

// A read-only folder stops the temp file, not the append to the existing file.
// Root ignores the mode bits, so the case cannot be staged as root.
test('a compaction that fails says so on the receipt: the write was logged, the file was not compacted', { skip: process.getuid?.() === 0 ? 'runs as root: a read-only folder does not stop root' : false }, () => {
  const h = harness();
  try {
    h.seed(seedLines(Array.from({ length: KNOWLEDGE_WRITES_COMPACT_LINES }, (): KnowledgeWrite => ({ id: 'busy', type: 'decision', at: T0 }))));
    chmodSync(h.transientDir, 0o555);
    let made;
    try {
      made = h.tools.knowledgeCreate('decision', decision('domain:genesys'));
    } finally {
      chmodSync(h.transientDir, 0o755);
    }
    assert.equal(h.tools.knowledgeGet(made.record.id).id, made.record.id, 'the knowledge write itself succeeded');
    const said = made.warnings.filter((w) => /domain-write ledger/.test(w));
    assert.equal(said.length, 1);
    assert.equal(said[0].startsWith(`domain-write ledger: this write was logged, but ${PROCESS_KNOWLEDGE_WRITES_REL} could not be compacted (`), true, said[0]);
    assert.match(said[0], /EACCES/);
    assert.match(said[0], /the file keeps growing until a compaction succeeds\.$/);
    assert.equal(notLogged(made.warnings).length, 0, 'it is not the not-logged warning: the entry is in the file');
    assert.deepEqual(h.latest(made.record.id), { id: made.record.id, type: 'decision', at: T0 });
    assert.equal(h.ledger().length, KNOWLEDGE_WRITES_COMPACT_LINES + 1, 'nothing was rewritten');
    assert.deepEqual(readdirSync(h.transientDir).filter((n) => n.includes('.tmp-')), [], 'no temp file is left behind');
  } finally {
    h.cleanup();
  }
});
