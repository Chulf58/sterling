// Consumer-side distribution pins for check-record-citations.mjs and
// check-stale-claims.mjs (board 4ccf0644-b1a4-4859-b318-fb666b486176).
//
// SPEC ONLY: init.mjs's in-flight wiring changes were NOT read to author these
// (H4 read wall) — the CLI surfaces of the two check scripts were learned from
// their CURRENT committed behavior via scripts/tests/checks.test.mjs (which
// already spawns check-record-citations.mjs against a temp consumer-shaped
// fixture) and from the store's owning article for stale-claim-scan (the
// check-stale-claims.mjs `--base <ref> [--target <dir>]` CLI surface).
//
// FIXTURE SHAPE: a "consuming project" is built by actually running the
// committed scripts/init.mjs against a fresh temp dir (git-init'd first, like
// a real consumer's own repo) — this gets a schema-correct .sterling/config.json
// (toolchains, stack_tags) without guessing its field shape by hand, matching
// how scripts/tests/init-ensure.test.mjs builds fixtures. A decision record is
// then seeded directly into the fixture's OWN .sterling/sterling.db (never this
// repo's store) so the citation check's empty-project-store skip does not mask
// the pins. git identity is set inline per commit (as in update.test.mjs) so no
// machine git config is required.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT_ID = ['-c', 'user.email=t@sterling.test', '-c', 'user.name=sterling test'];

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function git(dir, args) {
  return spawnSync('git', [...GIT_ID, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
}

/** A consuming project: its own git repo, its own /sterling:init'd .sterling/
 *  store+config (native launcher generation forced off — irrelevant here and
 *  slow). Nothing here is committed yet; each test commits its own fixture. */
function buildConsumerFixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);
  const initResult = spawnSync(
    process.execPath,
    [
      join(root, 'scripts', 'init.mjs'),
      '--target', dir,
      '--project-name', 'consumer-fixture',
      '--stack-tags', 'node',
      '--toolchain', 'node:**/*.mjs',
      '--backup-path', 'backups',
    ],
    {
      encoding: 'utf8',
      cwd: dir,
      timeout: 180_000,
      env: { ...process.env, STERLING_REGISTRY_DB: join(dir, 'registry.db'), STERLING_WIN_NODE: '' },
    }
  );
  assert.equal(initResult.status, 0, `consumer fixture init failed: ${initResult.stdout}${initResult.stderr}`);
  return dir;
}

/** Seeds one 'active' decision straight into the FIXTURE's own project store
 *  (never this repo's), returning its id — mirrors checks.test.mjs's envelope. */
function seedDecision(dir) {
  const NOW = '2026-06-10T12:00:00.000Z';
  const id = randomUUID();
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    store.create({
      id, type: 'decision', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
      superseded_by: null, links: [], scope: 'project', stack_tags: [],
      title: 'consumer fixture decision', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: [],
    });
  } finally {
    store.close();
  }
  return id;
}

function runCitationCheck(dir) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'check-record-citations.mjs'), dir], {
    encoding: 'utf8', cwd: dir, timeout: 120_000,
  });
}

// check-stale-claims is invoked from THIS repo's root (the plugin/clone the
// checks ship from) with --target pointing at the consumer fixture, never with
// cwd==target — this is the actual "reachable from the clone against a foreign
// consumer tree" shape the board item is about, and it is what would catch a
// checker that silently ignored --target and scanned its invoking cwd instead
// (that sabotage would diff THIS repo's history against a base sha that only
// exists in the fixture's independent git history, and fail to resolve it).
function runStaleClaimsCheck(dir, baseSha) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'check-stale-claims.mjs'), '--base', baseSha, '--target', dir], {
    encoding: 'utf8', cwd: root, timeout: 120_000,
  });
}

test('CONTROL: a clean consumer fixture — all citations resolve, no absence-claims — both checks exit 0', () => {
  const dir = buildConsumerFixture('sterling-consumer-control-');
  try {
    const goodId = seedDecision(dir);
    writeFileSync(join(dir, 'notes.md'), `See decision ${goodId.slice(0, 8)} for context.\n`);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'economy.mjs'), 'export function broadcast_trade_signal(x) { return x; }\n');
    assert.equal(git(dir, ['add', 'notes.md', 'src/economy.mjs']).status, 0);
    assert.equal(git(dir, ['commit', '-m', 'base']).status, 0);
    const baseSha = git(dir, ['rev-parse', 'HEAD']).stdout.trim();

    // a genuine diff lands afterward (a new caller), with NO absence-claim
    // anywhere in the tree — the control must stay clean through a real diff,
    // not merely through an empty one.
    writeFileSync(join(dir, 'src', 'farm.mjs'), 'export function run() { return broadcast_trade_signal(1); }\n');
    assert.equal(git(dir, ['add', 'src/farm.mjs']).status, 0);
    assert.equal(git(dir, ['commit', '-m', 'wire the caller']).status, 0);

    const citations = runCitationCheck(dir);
    assert.equal(citations.status, 0, `clean consumer fixture must pass the citation check: ${citations.stdout}${citations.stderr}`);

    const stale = runStaleClaimsCheck(dir, baseSha);
    assert.equal(stale.status, 0, `clean consumer fixture must pass the stale-claim scan: ${stale.stdout}${stale.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE for this pin: make check-record-citations report EVERY citation as
// citation_unresolved unconditionally (over-eager resolution) — citations.status
// flips 0→1, caught; OR make scanStaleClaims report a finding for every
// declared+called symbol regardless of any absence-claim (over-eager scanning)
// — stale.status flips 0→1, caught. (A checker stubbed to always exit 0 would
// NOT be caught by this test alone — that hollow case is what tests 2 and 3
// below exist to catch, by requiring a nonzero exit on seeded bad input.)

test('check-record-citations FLAGS a nonexistent id-shaped citation while resolving the good one against the CONSUMER store', () => {
  const dir = buildConsumerFixture('sterling-consumer-citation-');
  try {
    const goodId = seedDecision(dir);
    writeFileSync(
      dir + '/notes.md',
      `See decision ${goodId.slice(0, 8)} for context.\n` +
        `See decision deadbeef for a rule that was never recorded here.\n` // not-a-citation: fixture id, deliberately unresolved
    );
    assert.equal(git(dir, ['add', 'notes.md']).status, 0);

    const r = runCitationCheck(dir);
    assert.equal(r.status, 1, `an unresolved consumer-side citation must fail the check: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /citation_unresolved/);
    assert.match(r.stderr, /deadbeef/);
    assert.doesNotMatch(
      r.stderr,
      new RegExp(goodId.slice(0, 8)),
      'the id seeded in the CONSUMER store must resolve against it, not be reported unresolved'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: make check-record-citations resolve ids against THIS repo's own
// .sterling/sterling.db (or any fixed path) instead of the passed consumer
// `dir` — the good id (minted only inside the fixture's store) would then ALSO
// fail to resolve, so the `doesNotMatch(goodId)` assertion fails, catching it;
// equally, deleting the unresolved-citation branch entirely (always "resolves")
// flips r.status 1→0, caught directly.

test('check-stale-claims detects a seeded absence-claim in a consumer-side diff (run from the clone root, --target at the fixture)', () => {
  const dir = buildConsumerFixture('sterling-consumer-stale-');
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'economy.mjs'), 'export function broadcast_trade_signal(x) { return x; }\n');
    writeFileSync(join(dir, 'src', 'header.mjs'), '// broadcast_trade_signal is not yet wired to the economy loop\nexport const a = 1;\n');
    assert.equal(git(dir, ['add', 'src/economy.mjs', 'src/header.mjs']).status, 0);
    assert.equal(git(dir, ['commit', '-m', 'base']).status, 0);
    const baseSha = git(dir, ['rev-parse', 'HEAD']).stdout.trim();

    writeFileSync(join(dir, 'src', 'farm.mjs'), 'export function run() { return broadcast_trade_signal(1); }\n');
    assert.equal(git(dir, ['add', 'src/farm.mjs']).status, 0);
    assert.equal(git(dir, ['commit', '-m', 'wire the caller']).status, 0);

    const r = runStaleClaimsCheck(dir, baseSha);
    assert.equal(r.status, 1, `a seeded stale absence-claim must be detected consumer-side: ${r.stdout}${r.stderr}`);
    const out = r.stdout + r.stderr;
    assert.match(out, /broadcast_trade_signal/);
    assert.match(out, /header\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: make check-stale-claims ignore --target and scan process.cwd()
// instead (here, this repo's root) — baseSha only exists in the fixture's
// independent git history, so git operations against root's history either
// error on the unknown revision or, if silently tolerant, scan an unrelated
// diff — either way `header.mjs`/`broadcast_trade_signal` never appear in the
// output, failing the assert.match pair. Equally, deleting the absence-claim
// detection branch (always exit 0) flips r.status 1→0, caught directly.
