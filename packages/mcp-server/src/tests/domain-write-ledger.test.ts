import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWLEDGE_WRITES_CAP, KNOWLEDGE_WRITES_REL, knowledgeWriteSchema, parseConfig, type KnowledgeWrite } from '@sterling/schemas';
import { MountedStores, createDomain } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// The domain-write ledger, server side (decision
// domain-record-duty-credit-comes-from-a-per-project-write-ledger): after each
// write of a record a mounted domain store holds, the server appends
// {id, type, at} to <repoRoot>/.sterling/transient/knowledge-writes.json. The
// session-end duty reads (scripts/hooks/lib/session-duties.mjs) count a domain
// record only when this file holds an in-window entry for it; that side is
// pinned in scripts/tests/session-duties.test.mjs.

const T0 = '2026-10-04T12:00:00.000Z';
const T1 = '2026-10-04T12:05:00.000Z';
const T2 = '2026-10-04T12:10:00.000Z';
const NOT_LOGGED = /domain-write ledger: this write was NOT logged/;

function harness({ repoRoot = true }: { repoRoot?: boolean | string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-write-ledger-'));
  const domainDb = join(dir, 'domains', 'genesys', 'sterling.db');
  createDomain('genesys', 'test domain genesys', domainDb);
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'genesys', dbPath: domainDb }]);
  const clock = { now: T0 };
  const root = typeof repoRoot === 'string' ? repoRoot.replace('<dir>', dir) : repoRoot ? dir : undefined;
  const tools = new SterlingTools({ store, config: parseConfig({ stack_tags: ['genesys'] }), now: () => clock.now, newId: randomUUID, ...(root ? { repoRoot: root } : {}) });
  const ledgerPath = join(dir, KNOWLEDGE_WRITES_REL);
  return {
    dir,
    store,
    tools,
    clock,
    ledgerPath,
    ledger: (): KnowledgeWrite[] => (existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : []),
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const decision = (scope: string, title = 'webhook secrets are per-org') => ({ scope, title, statement: 'one secret per org, checked at the edge', alternatives_rejected: [], rationale: 'r' });

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

test('knowledge_create: a domain-scoped create logs {id, type, at}; a project-scoped create logs nothing', () => {
  const h = harness();
  try {
    h.tools.knowledgeCreate('decision', decision('project', 'a project ruling'));
    assert.equal(existsSync(h.ledgerPath), false, 'a project-store record is not logged: it pays the duty by its own timestamps');

    const made = h.tools.knowledgeCreate('decision', decision('domain:genesys'));
    assert.deepEqual(h.ledger(), [{ id: made.record.id, type: 'decision', at: T0 }]);
    assert.doesNotThrow(() => h.ledger().forEach((e) => knowledgeWriteSchema.parse(e)), 'every line is the shared schema shape');
    assert.equal(made.warnings.some((w) => NOT_LOGGED.test(w)), false, 'a logged write carries no ledger warning');
  } finally {
    h.cleanup();
  }
});

test('knowledge_update, _append and _edit on a domain record each log the write; a record another project created is logged when THIS server updates it', () => {
  const h = harness();
  try {
    const foreign = writtenByAnotherProject(h.store, T0);
    assert.deepEqual(h.ledger(), [], 'a record this server did not write has no line');

    h.clock.now = T1;
    h.tools.knowledgeUpdateResult(foreign.id, { rationale: 'measured on two orgs' });
    assert.deepEqual(h.ledger(), [{ id: foreign.id, type: 'decision', at: T1 }], 'the update is the write this project made');

    const own = h.tools.knowledgeCreate('decision', decision('domain:genesys')).record;
    h.clock.now = T2;
    h.tools.knowledgeAppend(own.id, 'alternatives_rejected', [{ option: 'one global secret', reason: 'a leak exposes every org' }]);
    assert.deepEqual(h.ledger().find((e) => e.id === own.id), { id: own.id, type: 'decision', at: T2 }, 'append logs');

    const third = h.tools.knowledgeCreate('decision', decision('domain:genesys', 'callbacks retry three times')).record;
    assert.equal(h.ledger().find((e) => e.id === third.id)?.at, T2);
    h.clock.now = '2026-10-04T12:20:00.000Z';
    h.tools.knowledgeEdit(third.id, 'rationale', 'r', 'the vendor documents three attempts');
    assert.equal(h.ledger().find((e) => e.id === third.id)?.at, '2026-10-04T12:20:00.000Z', 'edit logs');

    assert.equal(h.ledger().length, 3, 'one line per record id: a later write replaces the id\'s earlier line');
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
    assert.equal(warnings.some((w) => NOT_LOGGED.test(w)), false);
  } finally {
    h.cleanup();
  }
});

test('knowledge_supersede of a domain record logs the new head', () => {
  const h = harness();
  try {
    const old = h.tools.knowledgeCreate('decision', decision('domain:genesys')).record;
    h.clock.now = T1;
    const res = h.tools.knowledgeSupersede(old.id, { title: 'webhook secrets are per-org and rotated', statement: 'one secret per org, rotated every quarter', alternatives_rejected: [], rationale: 'r' });
    assert.deepEqual(h.ledger().find((e) => e.id === res.id), { id: res.id, type: 'decision', at: T1 });
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

test(`the bound: the newest ${KNOWLEDGE_WRITES_CAP} record ids are kept, one line each, so repeated writes never evict another record's line`, () => {
  const h = harness();
  try {
    const first = h.tools.knowledgeCreate('decision', decision('domain:genesys')).record;
    const busy = h.tools.knowledgeCreate('decision', decision('domain:genesys', 'callbacks retry three times')).record;
    for (let i = 0; i < KNOWLEDGE_WRITES_CAP + 1; i += 1) {
      h.clock.now = new Date(Date.parse(T1) + i * 1000).toISOString();
      h.tools.knowledgeUpdate(busy.id, { rationale: `measurement ${i}` });
    }
    assert.equal(h.ledger().length, 2, `${KNOWLEDGE_WRITES_CAP + 2} writes to two records are two lines`);
    assert.deepEqual(h.ledger()[0], { id: first.id, type: 'decision', at: T0 }, 'the first record\'s in-window line survives the 501st write after it');
    assert.equal(h.ledger()[1].at, h.clock.now, 'the busy record keeps its latest write');

    // The stated limit: writes to more than CAP distinct domain records drop the oldest id.
    const filler: KnowledgeWrite[] = Array.from({ length: KNOWLEDGE_WRITES_CAP - 1 }, (_, i) => ({ id: `filler-${i}`, type: 'decision', at: T1 }));
    writeFileSync(h.ledgerPath, JSON.stringify([{ id: first.id, type: 'decision', at: T0 }, ...filler]));
    const extra = h.tools.knowledgeCreate('decision', decision('domain:genesys', 'transfers keep the wrap-up code')).record;
    const after = h.ledger();
    assert.equal(after.length, KNOWLEDGE_WRITES_CAP, 'never more than the cap');
    assert.equal(after.some((e) => e.id === first.id), false, `the oldest of ${KNOWLEDGE_WRITES_CAP + 1} distinct ids is dropped`);
    assert.equal(after.at(-1)?.id, extra.id, 'the newest write is kept');
  } finally {
    h.cleanup();
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

test('no repoRoot: the record is written, no ledger is written, and every domain write says so on its receipt', () => {
  const h = harness({ repoRoot: false });
  try {
    const made = h.tools.knowledgeCreate('decision', decision('domain:genesys'));
    assert.equal(h.tools.knowledgeGet(made.record.id).scope, 'domain:genesys', 'the knowledge write itself succeeded');
    assert.equal(made.warnings.filter((w) => NOT_LOGGED.test(w)).length, 1);
    assert.match(made.warnings.find((w) => NOT_LOGGED.test(w)) ?? '', /no project root is known to this server/);

    assert.equal(h.tools.knowledgeUpdateResult(made.record.id, { rationale: 'r2' }).warnings.filter((w) => NOT_LOGGED.test(w)).length, 1, 'knowledge_update warns');
    assert.equal(h.tools.knowledgeAppend(made.record.id, 'alternatives_rejected', [{ option: 'o', reason: 'because' }]).warnings.filter((w) => NOT_LOGGED.test(w)).length, 1, 'knowledge_append warns');
    assert.equal(h.tools.knowledgeEdit(made.record.id, 'rationale', 'r2', 'r3').warnings.filter((w) => NOT_LOGGED.test(w)).length, 1, 'knowledge_edit warns');
    const project = h.tools.knowledgeCreate('decision', decision('project', 'a project ruling'));
    assert.equal(project.warnings.some((w) => NOT_LOGGED.test(w)), false, 'a project write needs no ledger, so it does not warn');
    assert.equal(h.tools.knowledgePromote(project.record.id, 'genesys').warnings.filter((w) => NOT_LOGGED.test(w)).length, 1, 'knowledge_promote warns');
    assert.equal(existsSync(h.ledgerPath), false);
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
    assert.match(made.warnings.find((w) => NOT_LOGGED.test(w)) ?? '', /has no \.sterling directory/);
  } finally {
    h.cleanup();
  }
});

test('a ledger that cannot be written never fails the knowledge write; the receipt says the write was not logged', () => {
  const h = harness();
  try {
    mkdirSync(h.ledgerPath, { recursive: true }); // a directory where the file belongs
    const made = h.tools.knowledgeCreate('decision', decision('domain:genesys'));
    assert.equal(h.tools.knowledgeGet(made.record.id).id, made.record.id, 'the record landed');
    assert.equal(made.warnings.filter((w) => NOT_LOGGED.test(w)).length, 1);
  } finally {
    h.cleanup();
  }
});

test('a malformed ledger is restarted rather than refused, and the receipt says earlier lines were lost', () => {
  const h = harness();
  try {
    mkdirSync(join(h.dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(h.ledgerPath, '{ not json');
    const made = h.tools.knowledgeCreate('decision', decision('domain:genesys'));
    assert.deepEqual(h.ledger(), [{ id: made.record.id, type: 'decision', at: T0 }]);
    assert.equal(made.warnings.some((w) => /domain-write ledger: .*could not be read.*restarted/.test(w)), true);
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
