// Same-id move between two mounted domain stores (GitHub issue #110, decision
// move-a-record-between-domains-with-knowledge-move-same-id): the SterlingStore
// primitives (exportMoveBundle, importMoveBundle, relinquishMovedRecord,
// moveMarkers) and MountedStores.moveRecordBetweenDomains / recoverMoves.
// Crash states are built by running the primitives one phase at a time through
// a second connection to the domain file, which leaves exactly the rows a crash
// between phases would leave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MountedStores, MoveClaimLostError, MoveInFlightError, MoveLockBusyError, SterlingStore, createDomain, type RecordMoveBundle } from '../index.js';
import { sqliteOnly } from './pg-test-support.js';

const NOW = '2026-10-16T12:00:00.000Z';
const LATER = '2026-10-16T12:05:00.000Z';
const SKIP = { skip: sqliteOnly('seeds alias rows and reads rows through node:sqlite') };

function decision(scope: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id: randomUUID(), type: 'decision', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null,
    links: [], scope, stack_tags: ['alpha'], file_keys: ['src/a.ts'], title, statement: `${title} statement zebrafinch`,
    alternatives_rejected: [], rationale: 'r', ...extra,
  };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-record-move-'));
  const path = (name: string) => join(dir, 'domains', name, 'sterling.db');
  const mounts = ['alpha', 'beta', 'gamma'].map((name) => ({ name, dbPath: path(name) }));
  for (const m of mounts) createDomain(m.name, `test domain ${m.name}`, m.dbPath);
  const moveLockPath = join(dir, 'domains', '.move.lock');
  const stores = new MountedStores(join(dir, '.sterling', 'sterling.db'), mounts, { moveLockPath });
  const raw = (name: string) => new DatabaseSync(path(name));
  const side = (name: string) => new SterlingStore(path(name));
  /** Another project on this machine: its own project store, the named domains, the same move lock. */
  const mount = (project: string, names: string[]) =>
    new MountedStores(join(dir, project, '.sterling', 'sterling.db'), names.map((name) => ({ name, dbPath: path(name) })), { moveLockPath });
  return { dir, path, moveLockPath, stores, raw, side, mount, cleanup: () => { stores.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A domain:alpha record with an archived version, an alias, outbound edges (one to a record in
 *  beta, one supersedes edge to a tombstone in alpha) and an inbound edge from the project. */
function seed(h: ReturnType<typeof harness>) {
  const old = h.stores.create(decision('domain:alpha', 'Old rule'));
  const x = h.stores.supersede(old.id, decision('domain:alpha', 'Move me', { slug: 'move-me' }));
  h.stores.updateRecord(x.id, { ...h.stores.get(x.id)!, rationale: 'r2' });
  const other = h.stores.create(decision('domain:beta', 'Beta neighbour'));
  h.stores.addLink(x.id, 'cites', other.id);
  const inbound = h.stores.create(decision('project', 'Project citer'));
  h.stores.addLink(inbound.id, 'cites', x.id);
  const db = h.raw('alpha');
  db.prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), x.id, 1, NOW);
  db.close();
  return { old, x, other, inbound };
}

function rowsFor(db: DatabaseSync, id: string) {
  return {
    record: db.prepare('SELECT scope, body FROM records WHERE id = ?').get(id) as { scope: string; body: string } | undefined,
    versions: db.prepare('SELECT COUNT(*) AS n FROM record_versions WHERE record_id = ?').get(id) as { n: number },
    aliases: db.prepare('SELECT COUNT(*) AS n FROM record_aliases WHERE canonical_id = ?').get(id) as { n: number },
    outbound: db.prepare('SELECT rel, target_id FROM record_relations WHERE source_id = ? ORDER BY rel').all(id) as { rel: string; target_id: string }[],
    markers: db.prepare("SELECT COUNT(*) AS n FROM store_meta WHERE key LIKE 'move_in:%' OR key LIKE 'move_out:%'").get() as { n: number },
  };
}

test('moveRecordBetweenDomains keeps id, versions, aliases and outbound edges; rewrites scope in column and body', SKIP, () => {
  const h = harness();
  try {
    const { old, x, other, inbound } = seed(h);
    const alphaSide = h.side('alpha');
    const before = alphaSide.exportMoveBundle(x.id)!;
    alphaSide.close();
    assert.ok(before.versions.length >= 1 && before.aliases.length === 1, 'fixture carries a version and an alias');

    const out = h.stores.moveRecordBetweenDomains(x.id, 'beta', LATER);
    assert.deepEqual(out, { id: x.id, from: 'domain:alpha', to: 'domain:beta' });

    const beta = h.raw('beta');
    const alpha = h.raw('alpha');
    try {
      const moved = rowsFor(beta, x.id);
      assert.equal(moved.record?.scope, 'domain:beta');
      assert.equal((JSON.parse(moved.record!.body) as { scope: string }).scope, 'domain:beta');
      assert.equal(moved.markers.n, 0, 'the journal marker is cleared');
      const betaSide = h.side('beta');
      const after = betaSide.exportMoveBundle(x.id)!;
      betaSide.close();
      assert.deepEqual(after.versions, before.versions, 'version snapshots are byte-exact');
      assert.deepEqual(after.aliases, before.aliases);
      assert.deepEqual(after.relations, before.relations);
      assert.deepEqual(after.stack_tags, before.stack_tags);
      assert.deepEqual(after.file_keys, before.file_keys);

      const gone = rowsFor(alpha, x.id);
      assert.equal(gone.record, undefined);
      assert.equal(gone.versions.n, 0);
      assert.equal(gone.aliases.n, 0);
      assert.deepEqual(gone.outbound.map((r) => ({ ...r })), [{ rel: 'supersedes', target_id: old.id }], 'only the supersedes edge to the alpha tombstone stays in alpha');
    } finally {
      beta.close();
      alpha.close();
    }

    const served = h.stores.get(x.id)!;
    assert.equal(served.scope, 'domain:beta');
    assert.equal((served as unknown as { slug: string }).slug, 'move-me');
    assert.equal(h.stores.scopeOfHolder(x.id), 'domain:beta');
    assert.deepEqual(
      served.links.map((l) => `${l.rel}:${l.target_id}`).sort(),
      [`cites:${other.id}`, `supersedes:${old.id}`].sort(),
      'outbound links are served from the new store'
    );
    assert.equal(h.stores.get(old.id)?.superseded_by, x.id, 'the alpha tombstone still names its successor');
    assert.ok(h.stores.get(inbound.id)!.links.some((l) => l.target_id === x.id), 'the inbound edge stays with its source');
    assert.ok(h.stores.query({ rank_terms: ['zebrafinch'], cap: 10 }).some((r) => r.id === x.id), 'the record is searchable in its new store');
  } finally {
    h.cleanup();
  }
});

test('moveRecordBetweenDomains refuses a project record, an unmounted target and the same domain', SKIP, () => {
  const h = harness();
  try {
    const p = h.stores.create(decision('project', 'Project rule'));
    assert.throws(() => h.stores.moveRecordBetweenDomains(p.id, 'beta', LATER), /held by the project store.*knowledge_promote/);
    const x = h.stores.create(decision('domain:alpha', 'Alpha rule'));
    assert.throws(() => h.stores.moveRecordBetweenDomains(x.id, 'delta', LATER), /domain 'delta' is not mounted/);
    assert.throws(() => h.stores.moveRecordBetweenDomains(x.id, 'alpha', LATER), /already lives in domain:alpha/);
    assert.equal(h.stores.scopeOfHolder(x.id), 'domain:alpha');
  } finally {
    h.cleanup();
  }
});

for (const [label, plant] of [
  ['the record id as an alias', (db: DatabaseSync, x: { id: string }) => db.prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, 1, ?)').run(x.id, randomUUID(), NOW)],
  ['version history for the id', (db: DatabaseSync, x: { id: string }) => db.prepare('INSERT INTO record_versions (record_id, version, archived_at, body) VALUES (?, 1, ?, ?)').run(x.id, NOW, '{}')],
  ['version history keyed by one of its historical ids', (db: DatabaseSync, _x: { id: string }, alias: string) => db.prepare('INSERT INTO record_versions (record_id, version, archived_at, body) VALUES (?, 1, ?, ?)').run(alias, NOW, '{}')],
  ['one of its historical ids as an alias', (db: DatabaseSync, _x: { id: string }, alias: string) => db.prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, 1, ?)').run(alias, randomUUID(), NOW)],
] as const) {
  test(`importMoveBundle refuses when the destination already holds ${label}; nothing is written on either side`, SKIP, () => {
    const h = harness();
    try {
      const x = h.stores.create(decision('domain:alpha', 'Alpha rule'));
      const alias = randomUUID();
      const a = h.raw('alpha');
      a.prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, 1, ?)').run(alias, x.id, NOW);
      a.close();
      const b = h.raw('beta');
      plant(b, x, alias);
      b.close();
      assert.throws(() => h.stores.moveRecordBetweenDomains(x.id, 'beta', LATER), /destination already holds/);
      const beta = h.raw('beta');
      try {
        const rows = rowsFor(beta, x.id);
        assert.equal(rows.record, undefined);
        assert.equal(rows.markers.n, 0);
      } finally {
        beta.close();
      }
      assert.equal(h.stores.scopeOfHolder(x.id), 'domain:alpha');
    } finally {
      h.cleanup();
    }
  });
}

test('a claimed record refuses ordinary writes, and relinquishMovedRecord deletes nothing without its claim token', SKIP, () => {
  // Rewritten in the third round: the source no longer changes after the copy (the claim fences it),
  // so the old "changed after it was copied" refusal is replaced by the fence plus the token check.
  const h = harness();
  try {
    const x = h.stores.create(decision('domain:alpha', 'Alpha rule'));
    const alpha = h.side('alpha');
    try {
      const token = randomUUID();
      alpha.claimMoveOut(x.id, { token, target: 'beta', at: LATER });
      assert.throws(() => h.stores.updateRecord(x.id, { ...h.stores.get(x.id)!, rationale: 'changed meanwhile' }), MoveInFlightError);
      assert.throws(() => alpha.relinquishMovedRecord(x.id, randomUUID(), LATER, 'moved out'), MoveClaimLostError);
      assert.ok(alpha.exportMoveBundle(x.id), 'the record is still held');
      assert.equal(alpha.releaseMoveOut(x.id, randomUUID()), false, 'another token cannot release the claim');
      assert.equal(alpha.releaseMoveOut(x.id, token), true);
    } finally {
      alpha.close();
    }
    h.stores.updateRecord(x.id, { ...h.stores.get(x.id)!, rationale: 'writable again' });
  } finally {
    h.cleanup();
  }
});

/** Phases 0 and 1 only, through second connections: the state a crash right after the destination
 *  transaction committed leaves behind. */
function crashAfterPhase1(h: ReturnType<typeof harness>, id: string, from = 'alpha', to = 'beta'): { bundle: RecordMoveBundle; token: string } {
  const src = h.side(from);
  const dst = h.side(to);
  try {
    const token = randomUUID();
    const bundle = src.claimMoveOut(id, { token, target: to, at: LATER });
    dst.importMoveBundle(bundle, `domain:${to}`, { source: from, at: LATER, token });
    return { bundle, token };
  } finally {
    src.close();
    dst.close();
  }
}

test('a crash after phase 1 leaves the id with two holders; recoverMoves completes the move and is idempotent', SKIP, () => {
  const h = harness();
  try {
    const { x } = seed(h);
    crashAfterPhase1(h, x.id);
    assert.throws(() => h.stores.scopeOfHolder(x.id), /ambiguous holder/, 'every route refuses the two-holder state');

    const outcomes = h.stores.recoverMoves(LATER);
    assert.deepEqual(outcomes, [{ id: x.id, from: 'domain:alpha', to: 'domain:beta', outcome: 'completed' }]);
    assert.equal(h.stores.scopeOfHolder(x.id), 'domain:beta');
    const beta = h.raw('beta');
    try {
      assert.equal(rowsFor(beta, x.id).markers.n, 0);
    } finally {
      beta.close();
    }
    assert.deepEqual(h.stores.recoverMoves(LATER), [], 'a second run has nothing to do');
  } finally {
    h.cleanup();
  }
});

test('a crash after phase 2 (source relinquished, marker still set) recovers by clearing the marker', SKIP, () => {
  const h = harness();
  try {
    const { x } = seed(h);
    const { token } = crashAfterPhase1(h, x.id);
    const alpha = h.side('alpha');
    alpha.relinquishMovedRecord(x.id, token, LATER, 'moved out');
    alpha.close();
    assert.deepEqual(h.stores.recoverMoves(LATER).map((o) => o.outcome), ['completed']);
    assert.equal(h.stores.scopeOfHolder(x.id), 'domain:beta');
    assert.deepEqual(h.stores.recoverMoves(LATER), []);
  } finally {
    h.cleanup();
  }
});

test('recovery finishes from the journal even when the copy was changed out of band: such writes are not detected', SKIP, () => {
  // Changed in the fifth round: the digest/conflict layer is cut (it only guarded hand-written SQL,
  // which the design leaves out of scope, and its 'conflict' state had no way out), so a claim
  // beside its marker always finishes, whatever the rows hold.
  const h = harness();
  try {
    const { x } = seed(h);
    crashAfterPhase1(h, x.id);
    const b = h.raw('beta');
    b.prepare('DELETE FROM record_aliases WHERE canonical_id = ?').run(x.id);
    b.close();

    assert.deepEqual(h.stores.recoverMoves(LATER).map((o) => o.outcome), ['completed']);
    assert.equal(h.stores.scopeOfHolder(x.id), 'domain:beta');
    for (const name of ['alpha', 'beta']) {
      const db = h.raw(name);
      assert.equal(rowsFor(db, x.id).markers.n, 0, `no journal entry left in ${name}, so the id is usable again`);
      db.close();
    }
    const beta = h.raw('beta');
    assert.equal(rowsFor(beta, x.id).aliases.n, 0, 'the out-of-band deletion stands: it was not detected');
    beta.close();
    assert.deepEqual(h.stores.recoverMoves(LATER), []);
  } finally {
    h.cleanup();
  }
});

test('a crash after phase 1: a source-only client cannot edit the claimed source either, and recovery completes the move', SKIP, () => {
  // Rewritten in the third round: this used to edit the source and expect a rollback; the claim now
  // fences the source, so that edit is refused and the interrupted move finishes.
  const h = harness();
  try {
    const { x } = seed(h);
    crashAfterPhase1(h, x.id);
    const onlyAlpha = h.mount('alpha-only', ['alpha']);
    try {
      assert.throws(() => onlyAlpha.updateRecord(x.id, { ...onlyAlpha.get(x.id)!, rationale: 'edited in alpha meanwhile' }), MoveInFlightError);
    } finally {
      onlyAlpha.close();
    }
    assert.deepEqual(h.stores.recoverMoves(LATER).map((o) => o.outcome), ['completed']);
    assert.equal(h.stores.scopeOfHolder(x.id), 'domain:beta');
    for (const name of ['alpha', 'beta']) {
      const db = h.raw(name);
      assert.equal(rowsFor(db, x.id).markers.n, 0, `no journal entry left in ${name}`);
      db.close();
    }
    assert.deepEqual(h.stores.recoverMoves(LATER), []);
  } finally {
    h.cleanup();
  }
});

test('a crash after phase 0 (claim written, no copy) rolls back by releasing the claim', SKIP, () => {
  const h = harness();
  try {
    const x = h.stores.create(decision('domain:alpha', 'Alpha rule'));
    const alpha = h.side('alpha');
    alpha.claimMoveOut(x.id, { token: randomUUID(), target: 'beta', at: LATER });
    alpha.close();
    assert.deepEqual(h.stores.recoverMoves(LATER).map((o) => o.outcome), ['rolled_back']);
    assert.equal(h.stores.scopeOfHolder(x.id), 'domain:alpha');
    h.stores.updateRecord(x.id, { ...h.stores.get(x.id)!, rationale: 'writable again' });
    assert.deepEqual(h.stores.recoverMoves(LATER), []);
  } finally {
    h.cleanup();
  }
});

test('the move fence: every write path refuses the copy (destination-only client) and the claimed source', SKIP, () => {
  const h = harness();
  try {
    const { x, other } = seed(h);
    crashAfterPhase1(h, x.id);
    const beta = h.side('beta');
    try {
      const copy = beta.get(x.id)!;
      const copyBefore = beta.exportMoveBundle(x.id);
      const fenced: [string, () => unknown][] = [
        ['updateRecord', () => beta.updateRecord(x.id, { ...copy, rationale: 'edit' })],
        ['editRecordField', () => beta.editRecordField(x.id, 'rationale', 'r2', 'r3')],
        ['appendRecordField', () => beta.appendRecordField(x.id, 'stack_tags', 'beta')],
        ['addLink', () => beta.addLink(x.id, 'informed_by', other.id)],
        ['supersede', () => beta.supersede(x.id, decision('domain:beta', 'Replacement'))],
        ['retireInFavorOf (retiree)', () => beta.retireInFavorOf(x.id, other.id, LATER)],
        ['retireInFavorOf (survivor)', () => beta.retireInFavorOf(other.id, x.id, LATER)],
        ['remove', () => beta.remove(x.id, LATER)],
      ];
      for (const [label, write] of fenced) {
        assert.throws(write, (e: unknown) => e instanceof MoveInFlightError && e.record_id === x.id, `${label} is fenced`);
      }
      assert.deepEqual(beta.exportMoveBundle(x.id), copyBefore, 'the copy is unchanged');
    } finally {
      beta.close();
    }
    // A project mounting only beta goes through MountedStores and meets the same fence.
    const onlyBeta = h.mount('beta-only', ['beta']);
    try {
      assert.throws(() => onlyBeta.updateRecord(x.id, { ...onlyBeta.get(x.id)!, rationale: 'edit' }), MoveInFlightError);
    } finally {
      onlyBeta.close();
    }
    const alpha = h.side('alpha');
    try {
      assert.throws(() => alpha.updateRecord(x.id, { ...alpha.get(x.id)!, rationale: 'edit' }), MoveInFlightError, 'the claimed source is fenced too');
      assert.throws(() => alpha.remove(x.id, LATER), MoveInFlightError);
    } finally {
      alpha.close();
    }
    assert.deepEqual(h.stores.recoverMoves(LATER).map((o) => o.outcome), ['completed']);
  } finally {
    h.cleanup();
  }
});

test('the move lock: a recovery run from another instance during an ACTIVE move is refused, and the move completes', SKIP, () => {
  // Changed in the fourth round: this used to let recovery finish the active move and check that
  // the two converged; the machine-level move lock now keeps recovery out of a running move.
  const h = harness();
  const second = h.mount('second', ['alpha', 'beta']);
  let id = '';
  const proto = SterlingStore.prototype as unknown as { importMoveBundle: (...a: unknown[]) => string };
  const original = proto.importMoveBundle;
  let fired = false;
  proto.importMoveBundle = function (this: SterlingStore, ...a: unknown[]) {
    const digest = original.apply(this, a);
    if (!fired) {
      fired = true;
      assert.throws(() => second.recoverMoves(LATER, { lockTimeoutMs: 50 }), MoveLockBusyError);
    }
    return digest;
  };
  try {
    const { x } = seed(h);
    id = x.id;
    assert.equal(h.stores.moveRecordBetweenDomains(x.id, 'beta', LATER).to, 'domain:beta');
    assert.ok(fired, 'the interleaving ran');
    assert.equal(h.stores.scopeOfHolder(id), 'domain:beta');
    assert.equal(existsSync(h.moveLockPath), false, 'the lock is released');
  } finally {
    proto.importMoveBundle = original;
    second.close();
    h.cleanup();
  }
});

test('the move lock: a second move from another instance during an ACTIVE move is refused', SKIP, () => {
  // Changed in the fourth round: this used to relinquish the source mid-move and check that the
  // mover finished anyway; with the lock no other actor runs inside a move.
  const h = harness();
  const second = h.mount('second', ['alpha', 'gamma']);
  const proto = SterlingStore.prototype as unknown as { importMoveBundle: (...a: unknown[]) => string };
  const original = proto.importMoveBundle;
  let fired = false;
  let id = '';
  proto.importMoveBundle = function (this: SterlingStore, ...a: unknown[]) {
    const digest = original.apply(this, a);
    if (!fired) {
      fired = true;
      assert.throws(() => second.withMoveLock(() => second.moveRecordBetweenDomains(id, 'gamma', LATER), { timeoutMs: 50 }), MoveLockBusyError);
    }
    return digest;
  };
  try {
    const { x } = seed(h);
    id = x.id;
    assert.equal(h.stores.moveRecordBetweenDomains(x.id, 'beta', LATER).to, 'domain:beta');
    assert.ok(fired);
    const gamma = h.raw('gamma');
    assert.equal(rowsFor(gamma, id).record, undefined);
    gamma.close();
  } finally {
    proto.importMoveBundle = original;
    second.close();
    h.cleanup();
  }
});

test('a source-only client cannot edit the record during an ACTIVE move; the move completes', SKIP, () => {
  // Rewritten in the third round: this used to edit the source mid-move and expect recovery to roll
  // the move back; the claim now refuses that edit.
  const h = harness();
  const proto = SterlingStore.prototype as unknown as { importMoveBundle: (...a: unknown[]) => string };
  const original = proto.importMoveBundle;
  let fired = false;
  let id = '';
  proto.importMoveBundle = function (this: SterlingStore, ...a: unknown[]) {
    const digest = original.apply(this, a);
    if (!fired) {
      fired = true;
      const alpha = new SterlingStore(h.path('alpha'));
      try {
        assert.throws(() => alpha.updateRecord(id, { ...alpha.get(id)!, rationale: 'edited in alpha meanwhile' }), MoveInFlightError);
      } finally {
        alpha.close();
      }
    }
    return digest;
  };
  try {
    const { x } = seed(h);
    id = x.id;
    assert.equal(h.stores.moveRecordBetweenDomains(x.id, 'beta', LATER).to, 'domain:beta');
    assert.ok(fired);
    assert.equal((h.stores.get(x.id) as unknown as { rationale: string }).rationale, 'r2');
  } finally {
    proto.importMoveBundle = original;
    h.cleanup();
  }
});

test('blocker A: while alpha→beta is unfinished, a project mounting alpha+gamma can neither move the record nor settle the move', SKIP, () => {
  // Changed in the fourth round: the unfinished move is a crash leftover rather than a paused mover,
  // since the move lock keeps other actors out of a running move.
  const h = harness();
  try {
    const { x } = seed(h);
    crashAfterPhase1(h, x.id);
    const other = h.mount('other', ['alpha', 'gamma']);
    try {
      assert.throws(() => other.moveRecordBetweenDomains(x.id, 'gamma', LATER), MoveInFlightError);
      assert.deepEqual(other.recoverMoves(LATER).map((o) => o.outcome), ['pending'], 'beta is not mounted there');
    } finally {
      other.close();
    }
    assert.deepEqual(h.stores.recoverMoves(LATER).map((o) => o.outcome), ['completed']);
    assert.equal(h.stores.scopeOfHolder(x.id), 'domain:beta', 'exactly one holder');
    const gamma = h.raw('gamma');
    assert.equal(rowsFor(gamma, x.id).record, undefined, 'gamma never got a copy');
    gamma.close();
  } finally {
    h.cleanup();
  }
});

test('blocker B: the unfinished copy of alpha→beta cannot be moved on to gamma by a beta+gamma project', SKIP, () => {
  const h = harness();
  try {
    const { x } = seed(h);
    crashAfterPhase1(h, x.id);
    const client = h.mount('client', ['beta', 'gamma']);
    try {
      assert.throws(() => client.moveRecordBetweenDomains(x.id, 'gamma', LATER), MoveInFlightError);
      assert.deepEqual(client.recoverMoves(LATER).map((o) => o.outcome), ['pending'], 'alpha is not mounted there');
    } finally {
      client.close();
    }
    assert.deepEqual(h.stores.recoverMoves(LATER).map((o) => o.outcome), ['completed']);
    assert.equal(h.stores.scopeOfHolder(x.id), 'domain:beta');
    const gamma = h.raw('gamma');
    assert.equal(rowsFor(gamma, x.id).record, undefined);
    gamma.close();
  } finally {
    h.cleanup();
  }
});

test('blocker C: no step removes another move\'s journal entry; a crash leftover is settled only under its own token', SKIP, () => {
  // Changed in the fourth round: the stale mover of the original repro cannot run inside another
  // move any more (move lock); the token rule it exercised still guards crash leftovers, pinned here.
  const h = harness();
  try {
    const { x } = seed(h);
    const { token } = crashAfterPhase1(h, x.id);
    const stale = randomUUID();
    const alpha = h.side('alpha');
    const beta = h.side('beta');
    try {
      assert.equal(beta.rollbackMoveCopy(x.id, stale, LATER), false);
      assert.equal(beta.clearMoveIn(x.id, stale), false);
      assert.equal(alpha.releaseMoveOut(x.id, stale), false);
      assert.equal(alpha.deleteDoneClaim(x.id, stale), false);
      assert.throws(() => alpha.relinquishMovedRecord(x.id, stale, LATER, 'moved out'), MoveClaimLostError);
      assert.equal(beta.moveMarkers()[0].token, token, 'the marker is untouched');
      assert.equal(alpha.moveMarkers()[0].token, token, 'the claim is untouched');
    } finally {
      alpha.close();
      beta.close();
    }
    assert.deepEqual(h.stores.recoverMoves(LATER).map((o) => o.outcome), ['completed']);
    assert.equal(h.stores.scopeOfHolder(x.id), 'domain:beta');
  } finally {
    h.cleanup();
  }
});

/** Patch SterlingStore.prototype[method] so `before` runs once, before the first call. */
function beforeFirstCall(method: string, before: () => void): () => boolean {
  const proto = SterlingStore.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const original = proto[method];
  let fired = false;
  proto[method] = function (this: SterlingStore, ...a: unknown[]) {
    if (!fired) {
      fired = true;
      before();
    }
    return original.apply(this, a);
  };
  return () => {
    proto[method] = original;
    return fired;
  };
}

/** Run `fn` while moveMarkers() on the store at `stalePath` answers [] — what a recovery scan of
 *  that store returned before the move wrote its entry there (a stale read). */
function withStaleScan<T>(stalePath: string, fn: () => T): T {
  const proto = SterlingStore.prototype as unknown as { moveMarkers: (this: SterlingStore) => unknown[] };
  const original = proto.moveMarkers;
  proto.moveMarkers = function (this: SterlingStore) {
    return (this as unknown as { dbPath: string }).dbPath === stalePath ? [] : original.apply(this);
  };
  try {
    return fn();
  } finally {
    proto.moveMarkers = original;
  }
}

function holdersOf(h: ReturnType<typeof harness>, id: string): string[] {
  return ['alpha', 'beta'].filter((name) => {
    const db = h.raw(name);
    const held = rowsFor(db, id).record !== undefined;
    db.close();
    return held;
  });
}

test('scan race 1: recovery read beta before the move, the move crashes after relinquishing alpha — the record survives', SKIP, () => {
  // Sol's interleaving: recovery scans beta (no marker yet); the mover writes claim, copy and
  // relinquish, then crashes; recovery reads alpha's 'done' claim without beta's marker and drops
  // the claim; the next run deletes beta's copy as orphaned. With the move lock that recovery
  // cannot run inside the move, so the record ends in exactly one store.
  const h = harness();
  const recovery = h.mount('recovery', ['alpha', 'beta']);
  let recoveryError: unknown;
  const restore = beforeFirstCall('clearMoveIn', () => {
    try {
      withStaleScan(h.path('beta'), () => recovery.recoverMoves(LATER, { lockTimeoutMs: 50 }));
    } catch (e) {
      recoveryError = e;
    }
    throw new Error('simulated crash after phase 2');
  });
  try {
    const { x } = seed(h);
    assert.throws(() => h.stores.moveRecordBetweenDomains(x.id, 'beta', LATER), /simulated crash/);
    assert.ok(restore(), 'the interleaving ran');
    recovery.recoverMoves(LATER);
    recovery.recoverMoves(LATER);
    assert.deepEqual(holdersOf(h, x.id), ['beta'], 'the record is held by exactly one store');
    assert.ok(recoveryError instanceof MoveLockBusyError, `the interleaved recovery was kept out by the lock (got ${String(recoveryError)})`);
  } finally {
    restore();
    recovery.close();
    h.cleanup();
  }
});

test('scan race 2: recovery read alpha before the claim, then reads beta\'s marker mid-move — the record survives', SKIP, () => {
  // Sol's interleaving: recovery scans alpha (no claim yet); the mover claims, copies and verifies;
  // recovery scans beta's marker, finds no claim of its token and deletes the copy; the mover then
  // relinquishes alpha, and neither store holds the record. The move lock keeps that recovery out.
  const h = harness();
  const recovery = h.mount('recovery', ['alpha', 'beta']);
  let recoveryError: unknown;
  const restore = beforeFirstCall('relinquishMovedRecord', () => {
    try {
      withStaleScan(h.path('alpha'), () => recovery.recoverMoves(LATER, { lockTimeoutMs: 50 }));
    } catch (e) {
      recoveryError = e;
    }
  });
  try {
    const { x } = seed(h);
    h.stores.moveRecordBetweenDomains(x.id, 'beta', LATER);
    assert.ok(restore(), 'the interleaving ran');
    assert.deepEqual(holdersOf(h, x.id), ['beta'], 'the record is held by exactly one store');
    assert.ok(recoveryError instanceof MoveLockBusyError, `the interleaved recovery was kept out by the lock (got ${String(recoveryError)})`);
  } finally {
    restore();
    recovery.close();
    h.cleanup();
  }
});

test('moveRecordBetweenDomains checks expected_version against the exported source and writes nothing on a mismatch', SKIP, () => {
  const h = harness();
  try {
    const x = h.stores.create(decision('domain:alpha', 'Alpha rule'));
    h.stores.updateRecord(x.id, { ...h.stores.get(x.id)!, rationale: 'v2' });
    assert.throws(() => h.stores.moveRecordBetweenDomains(x.id, 'beta', LATER, { expected_version: 1 }), /version conflict.*version 2/);
    const beta = h.raw('beta');
    try {
      assert.equal(rowsFor(beta, x.id).record, undefined);
      assert.equal(rowsFor(beta, x.id).markers.n, 0);
    } finally {
      beta.close();
    }
    assert.deepEqual(h.stores.moveRecordBetweenDomains(x.id, 'beta', LATER, { expected_version: 2 }).to, 'domain:beta');
  } finally {
    h.cleanup();
  }
});

test('importMoveBundle refuses a slug a live destination record already uses, inside its transaction', SKIP, () => {
  const h = harness();
  try {
    const x = h.stores.create(decision('domain:alpha', 'Alpha rule', { slug: 'shared-slug' }));
    h.stores.create(decision('domain:beta', 'Beta rule', { slug: 'shared-slug' }));
    assert.throws(() => h.stores.moveRecordBetweenDomains(x.id, 'beta', LATER), /slug 'shared-slug' on live record/);
    assert.equal(h.stores.scopeOfHolder(x.id), 'domain:alpha');
  } finally {
    h.cleanup();
  }
});

test('recoverMoves leaves a marker whose source domain is not mounted and reports it pending', SKIP, () => {
  const h = harness();
  try {
    const beta = h.side('beta');
    const bundle = { ...beta.exportMoveBundle(h.stores.create(decision('domain:beta', 'Beta rule')).id)! };
    beta.close();
    const foreign: RecordMoveBundle = { ...bundle, record: { ...bundle.record, id: randomUUID(), operation_id: null } };
    const b2 = h.side('beta');
    b2.importMoveBundle(foreign, 'domain:beta', { source: 'gone', at: LATER, token: randomUUID() });
    b2.close();
    const outcomes = h.stores.recoverMoves(LATER);
    assert.deepEqual(outcomes.map((o) => [o.id, o.outcome]), [[foreign.record.id, 'pending']]);
    assert.deepEqual(h.stores.recoverMoves(LATER).map((o) => o.outcome), ['pending'], 'still pending, never guessed');
  } finally {
    h.cleanup();
  }
});
