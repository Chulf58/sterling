// H17 "honor a fresh conductor attestation for an IN-WINDOW change" (board
// 2af7a75f-8793-4835-a6d9-635683bf4f67).
//
// *** RE-CUT 2026-08-30 — BOTH FIXES BELOW ARE NOW REVERSED RULINGS. ***
// dc616f69 R11 DELETES the (A) stamp exemption outright ("the same-UID findings
// establish the stamp cannot prove authorship, so keeping it as a 'do not latch'
// authority reintroduces the very attestation premise this decision rejects"),
// and R12 DELETES `mintRestorePerformed` because `restore_performed` has no
// consumer. 78dc9bd6 then demotes H17 to a tripwire and deletes the stamp
// apparatus wholesale. So FIX-A is INVERTED here (a matching fresh stamp no
// longer exempts anything) and FIX-B's pins are REPLACED by their negatives (no
// restore happens, therefore no item may be minted). The historical design
// statement is kept below as the record of what these pins used to assert.
//
// SETTLED DESIGN (test-writer brief, 2026-08-22 — HISTORICAL, superseded above):
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

// FIXTURE HAZARD (dc616f69): an (A) detection now LATCHES eagerly at
// `.sterling/enforcement-taint.json`, and the latch denies the NEXT Pre. Every
// test remaining in this file runs exactly ONE Pre/Post pair on a fresh
// fixture, so none needs a between-case latch cleanup — anything added here
// that invokes the hook twice on one fixture MUST rm the latch between windows
// (see PIN 4's retirement note). The latch's own contract is pinned by
// enforcement.test.mjs AC8-LATCH and h17-b-surface-survives-a-sweep PIN 2.

// =========================================================================
// PIN 1 — INVERTED per dc616f69 R11 ("ALSO REMOVE THE (A) STAMP EXEMPTION as an
// authorization decision"). This block used to pin FIX-A: a fresh stamp matching
// the CURRENT bytes exempts an in-window change. It now pins the OPPOSITE, and
// this fixture is the ONLY one that can prove the exemption is gone: the stamp
// matches EXACTLY, so a deny here has exactly one possible cause — no stamp can
// authorize an (A) change any more.
//
// READ WITH PIN 2, WHICH IS ITS CONTROL: PIN 2's stamp does NOT match, so PIN 2
// denies under BOTH the old and the new hook and can never distinguish them.
// PIN 1 is the treatment; PIN 2 rules out "this path denies for some unrelated
// reason". (Control-arm discipline, decision cf863d84 — kept in file order
// rather than physically re-ordered so the diff stays reviewable.)
//
// EXPECTED FAILURE SHAPE: `r.code === 2` fires with actual 0 if the stamp
// consult is ever restored to the clean-at-Pre arm; the byte assertion fires if
// a restore returns.
// SABOTAGE: re-add `if (stampAttestsPath(rel)) continue;` to the clean-at-Pre
// branch -> this test goes RED on the exit code while PIN 2 stays GREEN.
// =========================================================================

test('PIN1 (dc616f69 R11): a fresh stamp matching the CURRENT bytes of an in-window hooks.json change NO LONGER exempts it — denied, latched, left on disk', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const hooksJson = join(dir, 'hooks', 'hooks.json');

    assert.equal(h17(dir, 'PreToolUse', A1).code, 0, 'Pre snapshot succeeds');

    // conductor-style edit, made DURING the window (after Pre, before Post)
    const newBytes = JSON.stringify({ hooks: { PreToolUse: [] }, CONDUCTOR_EDIT: true }) + '\n';
    writeFileSync(hooksJson, newBytes);

    // a FRESH stamp attesting exactly the CURRENT bytes, written after the edit
    writeStamp(dir, [{ path: 'hooks/hooks.json', sha256: sha256Of(hooksJson), at: NOW }]);

    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `an exact fresh stamp is NOT an authorization — a same-UID-forgeable attestation may never change the verdict (dc616f69 R11) — actual ${r.code}, stderr: ${r.stderr}`
    );
    assert.equal(readFileSync(hooksJson, 'utf8'), newBytes, 'and the bytes are left exactly as the command wrote them — denied, never reverted');
    assert.match(r.stderr, /hooks\.json/, 'the denial names the path so a human can adjudicate it');
    assert.match(r.stderr, /left on disk/i, 'and STATES the disposition');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN 2 — THE CONTROL FOR PIN 1, restore assertion inverted per dc616f69. A
// stamp is present but hashes DIFFERENT bytes than what's on disk. This denies
// under the OLD hook (mismatch -> no exemption) and under the NEW one (no
// exemption exists at all), so on its own it proves nothing about the ruling —
// which is exactly its job: it establishes that this fixture and this path deny
// for the ordinary reason, so PIN 1's deny cannot be explained away.
//
// EXPECTED FAILURE SHAPE: if detection is dropped entirely, `r.code === 2`
// fires with actual 0 — and PIN 1 fires with it, which is the signature of a
// broken sweep rather than a restored exemption.
// SABOTAGE: none unique to this arm; it is a control, and it must NOT go red
// under PIN 1's sabotage.
// =========================================================================

test('PIN2 CONTROL: a stamp hashing DIFFERENT bytes than the CURRENT file denies — and the tampered bytes are left on disk (dc616f69)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const hooksJson = join(dir, 'hooks', 'hooks.json');
    const origJson = readFileSync(hooksJson, 'utf8');

    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    const tampered = JSON.stringify({ hooks: {}, TAMPERED: true });
    writeFileSync(hooksJson, tampered);

    // a stamp exists but attests bytes that do NOT match what's on disk now
    writeStamp(dir, [{ path: 'hooks/hooks.json', sha256: createHash('sha256').update('completely different bytes').digest('hex'), at: NOW }]);

    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a stamp hash mismatch must deny — ${r.stderr}`);
    assert.equal(readFileSync(hooksJson, 'utf8'), tampered, 'and the bytes stay as the command wrote them — the restore arm is deleted (dc616f69 R11)');
    assert.notEqual(readFileSync(hooksJson, 'utf8'), origJson, 'specifically NOT put back to the committed image');
    assert.match(r.stderr, /hooks\.json/, 'the denial names the path');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN 3 — REPLACED BY ITS NEGATIVE per dc616f69 R12 and R16(iii). FIX-B's mint
// pin ("an actual restore mints exactly one restore_performed item") cannot be
// inverted mechanically, because there is no restore to mint for: R12 deletes
// `mintRestorePerformed` on the finding that `restore_performed` HAS NO
// CONSUMER, while RETAINING the schema enum so existing items elsewhere stay
// readable. What is worth pinning is that the lane is now DEAD ON THE WRITE
// SIDE: a real (A) violation, with a working store attached, mints nothing.
//
// This is not a vacuous green — the fixture produces a genuine violation (the
// exit-code assertion proves the detection ran), so a zero here is a statement
// about the mint, not about the sweep failing to fire.
//
// EXPECTED FAILURE SHAPE: `items.length === 0` fires with actual 1 if any mint
// is reintroduced on the (A) path.
// SABOTAGE: re-add `mintRestorePerformed(...)` (or any `enqueueSystemTodo` with
// system_reason 'restore_performed') to the (A) detection branch -> RED.
// =========================================================================

test('PIN3 (dc616f69 R12): a real (A) violation mints NO restore_performed maintenance item — the lane is dead on the write side', { skip: GIT_SKIP }, () => {
  const { dir, store, cleanup } = makeGitProject();
  try {
    const hooksJson = join(dir, 'hooks', 'hooks.json');
    assert.equal(h17(dir, 'PreToolUse', A1).code, 0);
    writeFileSync(hooksJson, JSON.stringify({ hooks: {}, TAMPERED: true }));

    const r = h17(dir, 'PostToolUse', A1);
    assert.equal(r.code, 2, `PRECONDITION: a genuine (A) violation must be detected, or a zero mint count below proves nothing — ${r.stderr}`);

    const items = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.source === 'system' && t.system_reason === 'restore_performed');
    assert.equal(items.length, 0, 'no restore_performed item is minted — nothing is restored, so nothing may claim a restore was performed');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN 4 — RETIRED per dc616f69 R12 / R16(iii). Its entire subject was the
// PER-PATH DEDUP of a mint that no longer exists; with no item minted at all
// there is nothing to dedup, and the assertion `items.length === 1` asserts the
// behaviour the ruling removed. PIN 3's negative covers the whole lane in one
// assertion. (Its two-window fixture would also now be poisoned by its own
// first-round latch — the second Pre would deny — which is the fixture hazard
// R16 warns about for every reused fixture.)
// =========================================================================

// =========================================================================
// PIN 5 — RETIRED per dc616f69 R12 / R16(iii): its subject was FIX-B's
// fail-OPEN mint under a broken store, and both the mint and the restore it
// guarded are deleted. The surviving property it shared — a broken store still
// denies and never exits 1 — is pinned by enforcement.test.mjs's H17 AC9d, by
// h17-stamp-honor-hardening.test.mjs's PIN H1 (which additionally pins the
// loud environment-defect wording), and by h17-b-surface-survives-a-sweep's
// PIN 5. Nothing is lost by removing it. Historical comment retained below.
//
// PIN 5 (HISTORICAL) — FAIL-OPEN: an unopenable store never breaks the restore
// or the deny, and never crashes (no non-blocking exit 1, no hang/kill).
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
//
// KEPT UNCHANGED at the dc616f69 re-cut (2026-08-30) — R11 removes the (A)
// stamp exemption only; the PRE-EXISTING/degraded-fallback attestation path
// survives, so this block still describes live behaviour.
// HONEST NOTE ON WHICH GUARD CARRIES THIS VERDICT, since a comment naming a
// non-load-bearing guard is how a hollow pin escapes notice: the path here is
// dirty at Pre and UNCHANGED across the window, so under decision 7021526c it
// ALLOWS by OBSERVATION with no stamp consulted at all (that is exactly what
// h17-pre-state-snapshot.test.mjs PIN-ALLOW pins). The stamp written below is
// therefore NOT what makes this green. Read this as a cheap same-file tripwire
// on "an untouched pre-dirty path still allows"; the real pin for the surviving
// stamp exemption is enforcement.test.mjs's FIX C suite. It is left in place
// rather than deleted because that tripwire still has value.
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
