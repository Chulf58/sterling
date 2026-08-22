// H17 "honor a fresh conductor attestation for an IN-WINDOW change" (board
// 2af7a75f-8793-4835-a6d9-635683bf4f67) — NOT YET IMPLEMENTED.
//
// SETTLED DESIGN (test-writer brief, 2026-08-22):
//   FIX-A: at Post, before restoring an in-window tracked enforcement
//     violation (a path NOT in the Pre dirty-set), H17 reads the enforcement
//     stamp (.sterling/transient/enforcement-stamp.json) FRESH and hashes the
//     file's CURRENT bytes. An exact {path, sha256} match => conductor-
//     attested: the file is NOT restored and that path produces NO
//     violation/deny. No match (missing entry, wrong hash, no stamp at all)
//     => restore + deny exactly as today (unchanged).
//   FIX-B: every ACTUAL restore additionally mints a maintenance-queue item
//     via the store: source 'system', system_reason 'restore_performed' (a
//     newly registered reason), DEDUPED PER PATH — one open item per restored
//     path (file_keys: [path]); a second restore of the same path
//     refreshes/reuses the open item rather than minting a second one. Item
//     text names the path, the agent_id, and a timestamp. The store write is
//     fail-open (a store failure never breaks the deny) and happens only
//     AFTER a successful restore. Agent-facing stderr/deny behavior is
//     otherwise unchanged.
//
// This file is deliberately separate from scripts/tests/enforcement.test.mjs
// (which already carries the AC1-AC9 + FIX-C "pre-existing dirty path"
// stamp-attestation tests) — it pins ONLY the new FIX-A/FIX-B behavior. The
// fixture below (makeGitProject/h17/git helpers) is a deliberate, faithful
// mirror of enforcement.test.mjs's H17 harness (same temp-git-repo shape,
// same Pre-then-mutate-then-Post pattern, same projectTag-derived baseline
// paths) so the two files stay behaviorally consistent with each other.
//
// RUN COMMAND (per the node toolchain adapter): `node --test
// scripts/tests/h17-stamp-honor.test.mjs`.
//
// Per-test EXPECTED FAILURE SHAPE is documented immediately above each test.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

function envelope(type) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
  };
}

const CONFIG = {
  toolchains: [
    {
      adapter: 'node',
      path_globs: ['**/*.mjs', '**/*.ts'],
      test_globs: ['**/*.test.mjs', 'tests/**'],
      run_commands: { test: 'node --test' },
    },
  ],
  context_watch: { warn_pct: 60, block_pct: 95, mode: 'observe', windows: { default: 200000 } },
};

// Mirrors enforcement.test.mjs's node-adapter brief fixture exactly: in-scope
// src/feature.ts + src/new-file.ts, incidental src/types.ts, out_of_scope
// src/legacy/**.
function briefRecord() {
  return {
    ...envelope('brief'),
    slug: 'feat',
    title: 'Feature',
    problem: 'p',
    feature: 'f',
    user_stated: { criteria: [], constraints: [] },
    conductor_proposals: [],
    acceptance_criteria: [{ ac_id: 'AC1', text: 'works end to end', verifiable_at: 'final' }],
    technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
    blast_radius: {
      files: [
        { path: 'src/feature.ts', owning_articles: [] },
        { path: 'src/new-file.ts', owning_articles: [] },
      ],
      reconcile_list: [],
    },
    incidental_scope: ['src/types.ts'],
    out_of_scope: ['src/legacy/**'],
    phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
    decisions_made: [],
  };
}

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

// run git in `dir` (setup helper — never silently swallows a setup failure: P5)
function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

// Build a git-backed project with a live Sterling store + active run — a
// faithful mirror of enforcement.test.mjs's makeGitProject (same fixture
// shape, same .gitignore, same TRACKED hooks/ + src/ + tests/ layout, same
// projectTag-derived baseline/dirty temp paths).
function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-stamp-'));
  const runId = 'r-h17s-' + randomUUID().slice(0, 8);

  git(dir, ['init', '-q'], { must: true });
  git(dir, ['config', 'user.email', 'h17@sterling.test'], { must: true });
  git(dir, ['config', 'user.name', 'H17 Test'], { must: true });
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false'], { must: true }); // pin line endings (see enforcement.test.mjs)

  writeFileSync(join(dir, '.gitignore'), ['.claude/agents/', '.claude/settings.local.json', '.sterling/', ''].join('\n'));

  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + '\n');
  writeFileSync(join(dir, 'hooks', 'h3-contract-gate.mjs'), '// bundled enforcement hook (pristine)\nprocess.exit(0);\n');

  mkdirSync(join(dir, 'src', 'legacy'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'src', 'types.ts'), 'export type T = 1;\n');
  writeFileSync(join(dir, 'src', 'other.ts'), 'export const other = 1;\n');
  writeFileSync(join(dir, 'src', 'legacy', 'old.ts'), 'export const legacy = 1;\n');
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'tests', 'frozen.test.mjs'), "import { test } from 'node:test';\ntest('frozen', () => {});\n");

  git(dir, ['add', '-A'], { must: true });
  git(dir, ['commit', '-q', '-m', 'init'], { must: true });

  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', 'coder.md'), '# coder (legit)\n');
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: 'enabled' }) + '\n');

  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const dbPath = join(dir, '.sterling', 'sterling.db');
  const store = new SterlingStore(dbPath);
  const brief = store.create(briefRecord());
  store.createRun({
    id: runId,
    brief_ref: brief.id,
    branch: 'sterling/' + runId,
    machine_state: 'running',
    phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
  });

  // Must mirror h17's projectTag(cwd) EXACTLY — sha256(realpath(cwd)).slice(0,16).
  const projectTag = createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 16);
  const baselinePath = join(tmpdir(), `sterling-enforce-${projectTag}-${runId}.json`);
  const dirtyPath = join(tmpdir(), `sterling-enforce-${projectTag}-${runId}.dirty.json`);
  let closed = false;
  const closeStore = () => {
    if (!closed) {
      try {
        store.close();
      } catch {}
      closed = true;
    }
  };
  const cleanup = () => {
    closeStore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(baselinePath, { force: true });
    rmSync(dirtyPath, { force: true });
  };
  return { dir, store, runId, dbPath, baselinePath, dirtyPath, closeStore, cleanup };
}

// run h17 in Pre (snapshot) or Post (verify+sweep) mode. agent_id via `over`.
function h17(dir, event, over = {}) {
  return runHook(
    'h17-bash-write-sweep.mjs',
    {
      session_id: 's1',
      transcript_path: join(dir, 'transcripts', 's1.jsonl'),
      cwd: dir,
      permission_mode: 'default',
      hook_event_name: event,
      tool_name: 'Bash',
      tool_input: { command: 'node --test src/x.mjs' },
      ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '' } } : {}),
      ...over,
    },
    dir
  );
}

const A1 = { agent_id: 'a1' };

function stampPath(dir) {
  return join(dir, '.sterling', 'transient', 'enforcement-stamp.json');
}

function writeStamp(dir, entries) {
  const p = stampPath(dir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(entries));
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// =========================================================================
// PIN 1 — STAMP HONORED: a fresh stamp matching the CURRENT (in-window
// tampered) bytes exempts the path — no restore, no deny naming it.
//
// EXPECTED FAILURE TODAY (RED): H17 has no notion of a fresh, at-Post stamp
// check for in-window changes yet — it always restores + denies any tracked
// hooks/** change made during the command, regardless of any stamp file.
// So `r.code` will be 2 (not the asserted 0), and the file will have been
// reverted to `origJson` (not the asserted `newBytes`) — both assertions
// below fire.
// =========================================================================

test('PIN1 (FIX-A): a fresh stamp matching the CURRENT bytes of an in-window hooks.json change is honored — not restored, not denied', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const hooksJson = join(dir, 'hooks', 'hooks.json');

    assert.equal(h17(dir, 'PreToolUse', A1).code, 0, 'Pre snapshot succeeds');

    // conductor-style edit, made DURING the window (after Pre, before Post) —
    // the exact shape H17 today always treats as a must-deny tamper.
    const newBytes = JSON.stringify({ hooks: { PreToolUse: [] }, CONDUCTOR_EDIT: true }) + '\n';
    writeFileSync(hooksJson, newBytes);

    // a FRESH stamp attesting exactly the CURRENT bytes, written after the edit
    writeStamp(dir, [{ path: 'hooks/hooks.json', sha256: sha256Of(hooksJson), at: NOW }]);

    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `a matching fresh stamp for an in-window change must let the command proceed — actual ${r.code}, stderr: ${r.stderr}`);
    assert.equal(readFileSync(hooksJson, 'utf8'), newBytes, 'the attested new bytes are KEPT, not reverted to HEAD');
    assert.doesNotMatch(r.stderr, /hooks\.json/, 'no deny names the attested path');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN 2 — NO MATCH RESTORES: a stamp is present but hashes DIFFERENT bytes
// than what's currently on disk — falls back to today's restore + deny.
//
// EXPECTED (may already be GREEN today): no stamp-honoring mechanism exists
// yet for in-window changes, so this is the pre-existing, unconditional
// restore+deny behavior (mirrors enforcement.test.mjs's H17 AC1). This pin
// exists to lock that fallback in place once FIX-A lands, so a mismatched
// stamp can never be mistaken for a match.
// =========================================================================

test('PIN2 (FIX-A regression guard): a stamp hashing DIFFERENT bytes than the CURRENT file still restores + denies', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const hooksJson = join(dir, 'hooks', 'hooks.json');
    const origJson = readFileSync(hooksJson, 'utf8');

    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(hooksJson, JSON.stringify({ hooks: {}, TAMPERED: true }));

    // a stamp exists but attests bytes that do NOT match what's on disk now
    writeStamp(dir, [{ path: 'hooks/hooks.json', sha256: createHash('sha256').update('completely different bytes').digest('hex'), at: NOW }]);

    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a stamp hash mismatch must fall back to the existing denial — ${r.stderr}`);
    assert.equal(readFileSync(hooksJson, 'utf8'), origJson, 'restored to HEAD despite the (non-matching) stamp being present');
    assert.match(r.stderr, /hooks\.json/, 'the denial names the path');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN 3 — QUEUE MINT: an actual restore mints exactly one open
// restore_performed maintenance item naming the path, agent, and time.
//
// EXPECTED FAILURE TODAY (RED): H17 has no maintenance-queue mint on restore
// yet, so `items.length` will be 0, not the asserted 1 — the `deepEqual`/
// `match` assertions on `items[0]` never even run (they'd throw on undefined
// first, which still fails the test as expected).
// =========================================================================

test('PIN3 (FIX-B): an actual restore mints exactly one open restore_performed item naming the path/agent/time', { skip: GIT_SKIP }, () => {
  const { dir, store, cleanup } = makeGitProject();
  try {
    const hooksJson = join(dir, 'hooks', 'hooks.json');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(hooksJson, JSON.stringify({ hooks: {}, TAMPERED: true }));

    const r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `an actual restore must occur for this pin to test anything — ${r.stderr}`);

    const items = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.source === 'system' && t.system_reason === 'restore_performed');
    assert.equal(items.length, 1, 'exactly one restore_performed maintenance item is minted on an actual restore');
    assert.deepEqual([...items[0].file_keys].sort(), ['hooks/hooks.json'], 'file_keys names the restored path');
    assert.match(items[0].text, /hooks\/hooks\.json/, 'the item text names the restored path');
    assert.match(items[0].text, /a1/, 'the item text names the attributed agent_id');
    assert.match(items[0].text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'the item text carries a timestamp');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN 4 — PER-PATH DEDUP: two separate restore events for the SAME path
// still leave exactly one open restore_performed item for that path.
//
// EXPECTED FAILURE TODAY (RED): with no mint mechanism at all, `items.length`
// is 0 (not 1). Once a naive (non-deduped) mint exists, this pin would still
// fail RED at 2 (not 1) until the per-path dedup choke point is wired —
// exactly the failure this pin exists to catch.
// =========================================================================

test('PIN4 (FIX-B): two restores of the SAME path across two Pre/Post windows still leave exactly one open restore_performed item', { skip: GIT_SKIP }, () => {
  const { dir, store, cleanup } = makeGitProject();
  try {
    const hooksJson = join(dir, 'hooks', 'hooks.json');

    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(hooksJson, JSON.stringify({ hooks: {}, TAMPERED: true, round: 1 }));
    let r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `round 1 restore — ${r.stderr}`);

    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(hooksJson, JSON.stringify({ hooks: {}, TAMPERED: true, round: 2 }));
    r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `round 2 restore of the SAME path — ${r.stderr}`);

    const items = store
      .query({ types: ['todo'], cap: 100 })
      .filter((t) => t.source === 'system' && t.system_reason === 'restore_performed' && (t.file_keys || []).includes('hooks/hooks.json'));
    assert.equal(items.length, 1, 'a second restore of the same path refreshes/reuses the open item rather than minting a second one');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN 5 — FAIL-OPEN: an unopenable store never breaks the restore or the
// deny, and never crashes (no non-blocking exit 1, no hang/kill).
//
// Uses the SAME store-corruption technique enforcement.test.mjs's existing
// "H17 AC9d: store/resolveRun throw (corrupt sterling.db)" test uses
// (close the fixture's handle, drop -wal/-shm, overwrite the db file with
// non-sqlite bytes) — applied here, after an in-window tamper exists, to
// prove the NEW restore_performed mint specifically degrades to fail-open
// rather than fail-closed or crashing (the settled design's explicit
// contract: "the store write is fail-open ... happens only AFTER a
// successful restore").
//
// EXPECTED FAILURE TODAY (RED): the mint does not exist yet, so this pin's
// `r.code === 2` / restored-file assertions currently coincide with
// whatever today's (pre-FIX-B) behavior does for a corrupt store during an
// active run — if that today ALSO denies before ever restoring (as AC9d's
// clean-tree case suggests happens for some early store-dependent gate),
// then the `readFileSync(...) === origJson` assertion here fails today
// because the file is never touched at all (still holds the tampered
// bytes), which is the concrete red signal for this pin. Disclosed
// explicitly: this pin's exact today-failure reason is inferred from
// enforcement.test.mjs's AC9d rather than confirmed against the
// implementation (test-writer stays blind to hook source, H4) — the
// conductor should re-check this pin's actual failure message once red.
// =========================================================================

test('PIN5 (FIX-B fail-open): an unopenable store never breaks the restore/deny and never crashes', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, closeStore, dbPath } = makeGitProject();
  try {
    const hooksJson = join(dir, 'hooks', 'hooks.json');
    const origJson = readFileSync(hooksJson, 'utf8');

    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(hooksJson, JSON.stringify({ hooks: {}, TAMPERED: true }));

    // corrupt the store AFTER the tamper exists but BEFORE Post runs — same
    // technique as enforcement.test.mjs's AC9d.
    closeStore();
    rmSync(dbPath + '-wal', { force: true });
    rmSync(dbPath + '-shm', { force: true });
    writeFileSync(dbPath, 'this is not a sqlite database — the restore_performed mint must not crash or fail closed here');

    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, null, 'the process must exit deterministically — never crash/hang without a status');
    assert.notEqual(r.code, 1, 'a broken store must never produce a non-blocking exit 1');
    assert.equal(r.code, 2, `the deny must still fire even though the mint's store write cannot succeed — ${r.stderr}`);
    assert.equal(readFileSync(hooksJson, 'utf8'), origJson, 'the file is still restored to HEAD despite the store being unopenable for the mint');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN 6 — GREEN regression guard: an attested PRE-EXISTING dirty path (FIX
// C's existing contract — see enforcement.test.mjs's "H17 stamp fix: a
// stamp matching every dirty hooks/ path's CURRENT bytes ...") must not
// regress while FIX-A/FIX-B land in the same "read the stamp, hash current
// bytes" code region. Kept cheap and duplicated here deliberately, as a
// same-file tripwire for this change specifically (primary coverage stays
// enforcement.test.mjs's FIX C suite).
//
// EXPECTED: RED against today's code exactly like FIX C's own suite (no
// stamp-exemption mechanism exists yet at all) — `r.code` will be 2, not the
// asserted 0. Once FIX C ships this specific pin should read GREEN even
// before FIX-A/FIX-B land; it stays in this file to catch FIX-A/FIX-B from
// breaking it on the way in.
// =========================================================================

test('PIN6 (regression guard for FIX C while FIX-A/B land): an attested pre-existing dirty path is still allowed, not restored', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = join(dir, 'hooks', 'h3-contract-gate.mjs');
    writeFileSync(bundle, '// conductor rebuild, not yet committed, attested up front\n');
    writeStamp(dir, [{ path: 'hooks/h3-contract-gate.mjs', sha256: sha256Of(bundle), at: NOW }]);

    assert.equal(h17(dir, 'PreToolUse', A1).code, 0, 'Pre now records this path as already dirty');
    const r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 0, `a matching pre-existing-dirt attestation must still allow (FIX C's contract) — ${r.stderr}`);
  } finally {
    cleanup();
  }
});
