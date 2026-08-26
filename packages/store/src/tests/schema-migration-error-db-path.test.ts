// ---------------------------------------------------------------------------
// PIN GROUP E — SchemaMigrationRequiredError gains db_path + a remediation
// message. LIVE against the shipped implementation — all pins below pass.
// Originating measured defect (Salesforce consumer, 2026-08-26): a hook died with a bare
// "h2-selection-inject.mjs:5355" because SchemaMigrationRequiredError
// (packages/store/src/index.ts ~187) today carries only {found, supported}
// — no DB path — so on a machine with 23 stores the user could not tell
// WHICH store file was legacy.
//
// SPEC: SterlingStore retains the database path it was constructed with.
// SchemaMigrationRequiredError gains a `db_path` property equal to that
// path, and its message includes BOTH the offending absolute path AND the
// remediation command as the literal substring
// "scripts/migrate-stores.mjs --db '<path>'" — the path is POSIX
// SINGLE-quoted (double quotes would still let $/backtick expand), both
// quote characters present around the FULL path, an embedded single quote
// escaped as '\'', so the command stays copy-paste safe even when the path
// contains a space or a literal quote. E1/E2 use space-free fixture paths
// and pin the single-quoted substring directly; E4 below is the boundary
// pin proving the quoting is real (not merely absent because no fixture
// ever needed it) by using a path that DOES contain a space and checking
// the quotes land exactly around it; E5 (where feasible on this platform)
// pins the '\'' escape for a path containing a literal single quote.
// assertV2Surface passes the store's path into EVERY such throw — both the
// simple-writer ("assertWritable") call site (pin group A's territory:
// schema-version-guard.test.ts A2, frozen, not touched here) and the
// transaction-backstop call site.
//
// SEAM NOTE (disclosed, not verified by execution — this role has no Bash):
// "the transaction backstop" is assumed to be the check that guards the
// RETRY-LOOP CAS writers (updateRunOptimistic-backed methods and
// casTransitionMerge), by direct analogy with how this suite already splits
// the LIVE schema-version-drift guard into pin group B (simple autocommit
// writers: create/remove/writeHandoff/writeSelection/recordCheckSkipped,
// schema-version-live-write-guard.test.ts) versus pin group C (retry-loop
// writers inside tx(), retry-loop-live-schema-guard.test.ts). E2 below
// exercises casTransitionMerge for this reason. If assertV2Surface turns
// out to route every writer through one single call site, E2 is still a
// correct, non-hollow pin (casTransitionMerge on a legacy store must still
// refuse with db_path) — it would simply not be distinguishing two call
// sites the way it is designed to.
//
// Existing found/supported behavior (pin group A) is NOT rewritten here —
// E3 is a NEW, additive regression-control pin proving the db_path addition
// does not replace found/supported.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';

const NOW = '2026-06-10T12:00:00.000Z';

function tempDbPath(prefix = 'sterling-migration-db-path-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, path: join(dir, 'sterling.db') };
}

/** Raw, out-of-band pragma read — never through SterlingStore. */
function rawUserVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    return row ? row.user_version : NaN;
  } finally {
    db.close();
  }
}

/** Raw, out-of-band pragma write — rolls a real, fully-initialized store's marker back to simulate a pre-v2 (legacy) file on an otherwise real schema, exactly as schema-version-guard.test.ts A2 does. */
function rawSetUserVersion(path: string, value: number): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA user_version = ${value}`);
  } finally {
    db.close();
  }
}

function decisionRecord(id: string) {
  return {
    id,
    type: 'decision',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
    title: 'db_path probe',
    statement: 'write probe against a pre-v2 store to observe SchemaMigrationRequiredError.db_path',
    alternatives_rejected: [],
    rationale: 'must refuse and must name the offending db file',
    file_keys: [],
  };
}

function runRecord(over: Record<string, unknown> = {}) {
  return {
    id: 'r-e2',
    brief_ref: randomUUID(),
    branch: 'sterling/run-r-e2',
    machine_state: 'running',
    phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
    ...over,
  };
}

test('E1: a write against a legacy (pre-v2) store throws SchemaMigrationRequiredError whose db_path equals the fixture\'s absolute path, and whose message names both the path and the migrate-stores remediation command', () => {
  const { dir, path } = tempDbPath();
  try {
    const seed = new SterlingStore(path);
    seed.close();
    rawSetUserVersion(path, 1); // simulate a pre-v2 legacy store (same technique as A2)
    assert.equal(rawUserVersion(path), 1, 'precondition: the file now looks like a pre-v2 (legacy) store');

    const store = new SterlingStore(path);
    let caught: unknown;
    try {
      store.create(decisionRecord('00000000-0000-4000-8000-0000000000e1') as never);
      assert.fail('a write against a pre-v2 store must throw');
    } catch (err) {
      caught = err;
    }
    store.close();

    assert.ok(caught instanceof Error, 'the refusal is a real Error');
    assert.match((caught as Error).message, /migrat/i, 'still refuses naming the migration (A2 contract unchanged)');
    assert.equal(
      (caught as unknown as { db_path?: string }).db_path,
      path,
      'SchemaMigrationRequiredError carries db_path equal to the EXACT absolute path of the offending store file'
    );
    assert.ok(
      (caught as Error).message.includes(path),
      'the message includes the offending absolute db path, so a multi-store machine can tell which store is legacy'
    );
    assert.ok(
      (caught as Error).message.includes(`scripts/migrate-stores.mjs --db '${path}'`),
      'the message includes the remediation command with the path substituted in and POSIX SINGLE-quoted, so the user can copy-paste the fix'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E2 (transaction backstop): a retry-loop CAS writer (casTransitionMerge) against a legacy (pre-v2) store throws SchemaMigrationRequiredError carrying the same db_path and remediation message as the simple-writer path, and commits nothing', () => {
  const { dir, path } = tempDbPath();
  try {
    const seed = new SterlingStore(path);
    const run = seed.createRun(runRecord());
    seed.close();
    rawSetUserVersion(path, 1); // simulate a pre-v2 legacy store AFTER the run was seeded on a real v2 file
    assert.equal(rawUserVersion(path), 1, 'precondition: the file now looks like a pre-v2 (legacy) store');

    const store = new SterlingStore(path);
    let caught: unknown;
    try {
      store.casTransitionMerge('running', run.id, (fresh) => ({ ...fresh, machine_state: 'completing' }));
      assert.fail('casTransitionMerge against a pre-v2 store must throw');
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof Error, 'the refusal is a real Error');
    assert.match((caught as Error).message, /migrat/i, 'the retry-loop writer refuses naming the migration too — not special-cased away from the guard');
    assert.equal(
      (caught as unknown as { db_path?: string }).db_path,
      path,
      'the transaction-backstop throw carries the same db_path as the assertWritable (E1) path'
    );
    assert.ok((caught as Error).message.includes(path), 'the backstop message also includes the offending absolute path');
    assert.ok(
      (caught as Error).message.includes(`scripts/migrate-stores.mjs --db '${path}'`),
      'the backstop message also includes the remediation command, path POSIX SINGLE-quoted, matching E1'
    );

    const stillRunning = store.getRun(run.id);
    assert.equal(stillRunning?.machine_state, 'running', 'the refused transition left the run body unchanged — no partial write, matching pin group C\'s no-partial-write contract');

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E3 (regression control): found/supported are unchanged by the db_path addition — both properties still present, alongside (not replaced by) db_path', () => {
  const supportedProbe = tempDbPath('sterling-migration-db-path-probe-');
  const probe = new SterlingStore(supportedProbe.path);
  probe.close();
  const supportedVersion = rawUserVersion(supportedProbe.path);
  rmSync(supportedProbe.dir, { recursive: true, force: true });

  const { dir, path } = tempDbPath();
  try {
    const seed = new SterlingStore(path);
    seed.close();
    rawSetUserVersion(path, 1);

    const store = new SterlingStore(path);
    let caught: unknown;
    try {
      store.create(decisionRecord('00000000-0000-4000-8000-0000000000e3') as never);
      assert.fail('a write against a pre-v2 store must throw');
    } catch (err) {
      caught = err;
    }
    store.close();

    const typed = caught as unknown as { found?: number; supported?: number; db_path?: string };
    assert.equal(typed.found, 1, 'found still names the version found on disk (1) — unchanged by the db_path addition');
    assert.equal(typed.supported, supportedVersion, `supported still names the currently-supported version (${supportedVersion}) — unchanged by the db_path addition`);
    assert.equal(typed.db_path, path, 'db_path is present ALONGSIDE found/supported, proving the addition is additive, not a replacement');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E4 (boundary, quoting): a legacy store whose path contains a space — the remediation command single-quotes the path verbatim (--db \'<path>\') so copy-pasting it into a shell is safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling migration db path with space-'));
  const path = join(dir, 'sterling.db');
  assert.ok(path.includes(' '), 'precondition: the fixture path actually contains a space — otherwise this pin cannot distinguish quoted from unquoted');
  try {
    const seed = new SterlingStore(path);
    seed.close();
    rawSetUserVersion(path, 1); // simulate a pre-v2 legacy store (same technique as E1)
    assert.equal(rawUserVersion(path), 1, 'precondition: the file now looks like a pre-v2 (legacy) store');

    const store = new SterlingStore(path);
    let caught: unknown;
    try {
      store.create(decisionRecord('00000000-0000-4000-8000-0000000000e4') as never);
      assert.fail('a write against a pre-v2 store must throw');
    } catch (err) {
      caught = err;
    }
    store.close();

    assert.ok(caught instanceof Error, 'the refusal is a real Error');
    assert.equal(
      (caught as unknown as { db_path?: string }).db_path,
      path,
      'db_path is the exact space-containing path, unmodified/unescaped'
    );
    assert.ok(
      (caught as Error).message.includes(`scripts/migrate-stores.mjs --db '${path}'`),
      'the remediation command single-quotes the FULL path verbatim — both single-quote characters present, one immediately before and one immediately after the path — so a space inside the path cannot split the command into two shell arguments'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E5 (boundary, embedded quote — skipped if this platform cannot create such a path): a legacy store whose path contains a literal single quote — the remediation command escapes it with the standard POSIX \'\\\'\' form', (t) => {
  const prefix = join(tmpdir(), "sterling-migration-db-path-with'quote-");
  let dir: string;
  try {
    dir = mkdtempSync(prefix);
  } catch {
    t.skip("this platform's filesystem/mkdtemp rejected a single-quote path segment — pin skipped, not failed");
    return;
  }
  const path = join(dir, 'sterling.db');
  assert.ok(path.includes("'"), 'precondition: the fixture path actually contains a literal single quote — otherwise this pin cannot distinguish escaped from unescaped');
  const expectedQuoted = `'${path.split("'").join("'\\''")}'`;
  try {
    const seed = new SterlingStore(path);
    seed.close();
    rawSetUserVersion(path, 1); // simulate a pre-v2 legacy store (same technique as E1)
    assert.equal(rawUserVersion(path), 1, 'precondition: the file now looks like a pre-v2 (legacy) store');

    const store = new SterlingStore(path);
    let caught: unknown;
    try {
      store.create(decisionRecord('00000000-0000-4000-8000-0000000000e5') as never);
      assert.fail('a write against a pre-v2 store must throw');
    } catch (err) {
      caught = err;
    }
    store.close();

    assert.ok(caught instanceof Error, 'the refusal is a real Error');
    assert.equal(
      (caught as unknown as { db_path?: string }).db_path,
      path,
      'db_path is the exact quote-containing path, unmodified/unescaped — escaping is a MESSAGE-rendering concern only'
    );
    assert.ok(
      (caught as Error).message.includes(`scripts/migrate-stores.mjs --db ${expectedQuoted}`),
      "the remediation command escapes the embedded single quote as the standard POSIX '\\'' form, so the command remains a single valid shell argument"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
