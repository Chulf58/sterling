// Pins for the advisory firing counter — EXPIRING SCAFFOLDING (de-complication
// campaign S2; deleted with lib/advisory-counter.mjs at slice S5 regardless of
// outcome). Two duties: (1) the unit contract — one parseable NDJSON line per
// fire, session id carried when present, and NEVER a throw, because a telemetry
// failure inside an advisory hook must not change what the hook does; (2) the
// wiring — each advisory hook this campaign measures actually calls the counter,
// so S5's verdict is read off real data rather than an unwired instrument (the
// half-measured-finding failure this repo has already paid for once).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'hooks');
const { recordAdvisoryFire } = await import(new URL('../hooks/lib/advisory-counter.mjs', import.meta.url));

function freshRoot() {
  // A STERLING root: the .sterling marker exists (the lib refuses to create it —
  // see the non-Sterling guard test below).
  const root = mkdtempSync(join(tmpdir(), 'advisory-counter-'));
  mkdirSync(join(root, '.sterling'));
  return root;
}
const firesPath = (root) => join(root, '.sterling', 'transient', 'advisory-fires.ndjson');

test('one fire appends exactly one parseable NDJSON line with hook + at', () => {
  const root = freshRoot();
  try {
    recordAdvisoryFire(root, 'h25');
    const lines = readFileSync(firesPath(root), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.hook, 'h25');
    assert.equal(row.session, null); // no session.json in a fresh root
    assert.ok(!Number.isNaN(Date.parse(row.at)), `at is a parseable timestamp, got ${row.at}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('appends accumulate across fires and sessions are carried when session.json is readable', () => {
  const root = freshRoot();
  try {
    const dir = join(root, '.sterling', 'transient');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ session_id: 'sess-abc', source: 'startup' }));
    recordAdvisoryFire(root, 'h20');
    recordAdvisoryFire(root, 'h26');
    const rows = readFileSync(firesPath(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.hook), ['h20', 'h26']);
    assert.ok(rows.every((r) => r.session === 'sess-abc'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt session.json degrades to session:null, never a throw, and the sample is still kept', () => {
  const root = freshRoot();
  try {
    const dir = join(root, '.sterling', 'transient');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.json'), '{not json');
    assert.doesNotThrow(() => recordAdvisoryFire(root, 'h30'));
    const row = JSON.parse(readFileSync(firesPath(root), 'utf8').trim());
    assert.equal(row.hook, 'h30');
    assert.equal(row.session, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('never throws when the destination is unwritable (root is a plain FILE), and writes nothing', () => {
  const root = freshRoot();
  try {
    const fileAsRoot = join(root, 'not-a-dir');
    writeFileSync(fileAsRoot, 'occupied'); // .sterling/ cannot be created beneath a file
    assert.doesNotThrow(() => recordAdvisoryFire(fileAsRoot, 'h23'));
    assert.equal(existsSync(join(fileAsRoot, '.sterling')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('NON-STERLING GUARD: a root without a .sterling marker is a silent no-op — the lib never materializes .sterling/ (review finding, 2026-08-30)', () => {
  const bare = mkdtempSync(join(tmpdir(), 'advisory-counter-bare-'));
  try {
    assert.doesNotThrow(() => recordAdvisoryFire(bare, 'h29'));
    assert.equal(existsSync(join(bare, '.sterling')), false, 'no .sterling tree was created in a non-Sterling root');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('missing arguments are a silent no-op, never a throw', () => {
  const root = freshRoot();
  try {
    assert.doesNotThrow(() => recordAdvisoryFire(undefined, 'h25'));
    assert.doesNotThrow(() => recordAdvisoryFire(root, undefined));
    assert.equal(existsSync(firesPath(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit sessionId argument wins over session.json (concurrent-session attribution, Codex review 2026-08-30)', () => {
  const root = freshRoot();
  try {
    const dir = join(root, '.sterling', 'transient');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ session_id: 'stale-other-session' }));
    recordAdvisoryFire(root, 'h20', 'live-session-xyz');
    const row = JSON.parse(readFileSync(firesPath(root), 'utf8').trim());
    assert.equal(row.session, 'live-session-xyz');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// WIRING PINS — source-level, EXACT CALL COUNTS (Codex review 2026-08-30: h20
// must carry exactly TWO call sites — the deny-once path and the delivery
// write — and every other hook exactly ONE; a removed or duplicated site is a
// count-bias defect for the S5 verdict, not a style issue). Source-level (not
// execution) is deliberate for expiring scaffolding and disclosed: these pins
// prove textual presence at the right cardinality, not runtime reachability —
// reachability was mutation-verified by hand (h25 sabotage → red). If a hook
// below is DELETED at S5, delete its row here in the same commit.
const WIRED = [
  ['h20-mechanism-axis.mjs', 2],
  ['h23-output-axis.mjs', 1],
  ['h25-dispatch-capability.mjs', 1],
  ['h26-dispatch-overlap.mjs', 1],
  ['h29-codex-consult-failure.mjs', 1],
  ['h30-bare-id-legibility.mjs', 1],
];

for (const [file, expected] of WIRED) {
  test(`${file} imports the counter and calls recordAdvisoryFire exactly ${expected}x with its own id + input.session_id`, () => {
    const src = readFileSync(join(HOOKS, file), 'utf8');
    assert.match(src, /from '\.\/lib\/advisory-counter\.mjs'/, `${file} imports the counter`);
    const id = file.split('-')[0];
    const calls = src.match(new RegExp(`recordAdvisoryFire\\(input\\.cwd, '${id}', input\\.session_id\\)`, 'g')) ?? [];
    assert.equal(calls.length, expected, `${file}: expected exactly ${expected} call site(s), found ${calls.length}`);
    assert.equal((src.match(/recordAdvisoryFire\(/g) ?? []).length, expected, `${file}: no extra call sites under a different shape`);
  });
}
