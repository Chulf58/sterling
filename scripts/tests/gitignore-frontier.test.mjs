// Gitignore-awareness for the H19 frontier signal and the H10 article demand.
// SPEC UNDER TEST (not yet implemented — every test here must be RED first):
//
//  1. NEW helper scripts/hooks/lib/common.mjs:
//       gitIgnored(paths: string[], cwd: string): Set<string> | null
//     - empty input -> empty Set (no git spawn required)
//     - no paths ignored -> empty Set
//     - git unavailable/errors (exit code not 0 or 1) -> null
//
//  2. H19 (scripts/hooks/h19-knowledge-delivery.mjs) frontier suppression:
//     AC1 - a gitignored, unowned touch raises NO frontier signal at all when
//           nothing else is fresh for the path (silent: no enqueue, no
//           additionalContext).
//     AC2 - the same gitignored+unowned file WITH a fresh anti_pattern still
//           delivers the hazard, but under the NORMAL delivery header, never
//           the frontier/unowned header (that header's claim — "H10 will
//           demand an article" — would now be false).
//     AC3 - regression: an unowned, NON-ignored file still fires the frontier
//           signal exactly as today, once per file per session.
//     AC4 - degrade: git unavailable/erroring leaves frontier behavior
//           unchanged from today (it still fires) — the check degrades
//           toward signaling, never toward silence.
//
//  3. H10 (scripts/hooks/h10-direct-capture.mjs) article demand:
//     AC5 - gitignored files never count toward min_unowned_files and never
//           appear in a raised item's file_keys; an all-ignored session
//           raises no demand at all.
//     AC6 - regression: non-ignored unowned files still trigger the demand at
//           threshold.
//     AC7 - degrade: a failing ignore-check falls back to the UNFILTERED
//           (pre-feature) unowned list — loud via check_skipped, never a
//           silent narrowing of what counts as unowned.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-07-19T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** git init WITHOUT committing anything — check-ignore only reads the working-tree .gitignore. */
function initGit(dir, ignoreLines = []) {
  const r = spawnSync('git', ['init', '--initial-branch=main'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `fixture setup: git init failed: ${r.stderr}`);
  if (ignoreLines.length) writeFileSync(join(dir, '.gitignore'), ignoreLines.join('\n') + '\n');
}

async function loadGitIgnored() {
  const m = await import(pathToFileURL(join(HOOKS, 'lib', 'common.mjs')).href);
  return m.gitIgnored;
}

function envelope(type, at = NOW) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function antiPattern(title, paths, extra = {}) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger: `${title} trigger text`,
    guidance: `${title} guidance`,
    wrong_way: `${title} wrong way`,
    right_way: `${title} right way text`,
    source_evidence: `${title} evidence`,
    basis: 'codebase',
    file_keys: paths,
    ...extra,
  };
}

// =========================================================================
// SECTION 1 — gitIgnored(paths, cwd) helper, tested directly as a pure fn.
// =========================================================================

test('gitIgnored: empty input returns an empty Set without needing git to answer anything (proof: works even where git could not possibly answer — no repo at all)', async () => {
  const gitIgnored = await loadGitIgnored();
  assert.equal(typeof gitIgnored, 'function', 'scripts/hooks/lib/common.mjs must export gitIgnored(paths, cwd)');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-gi-empty-'));
  try {
    const result = gitIgnored([], dir);
    assert.ok(result instanceof Set, 'returns a Set for empty input, not null and not an array');
    assert.equal(result.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitIgnored: a real repo with no matching ignore rule returns an empty Set', async () => {
  const gitIgnored = await loadGitIgnored();
  const dir = mkdtempSync(join(tmpdir(), 'sterling-gi-none-'));
  try {
    initGit(dir, ['nothing-matches-this-pattern.mjs']);
    const result = gitIgnored(['src/a.mjs', 'src/b.mjs'], dir);
    assert.ok(result instanceof Set);
    assert.equal(result.size, 0, 'neither path is matched by the .gitignore in this repo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitIgnored: returns EXACTLY the ignored subset of a mixed path list', async () => {
  const gitIgnored = await loadGitIgnored();
  const dir = mkdtempSync(join(tmpdir(), 'sterling-gi-subset-'));
  try {
    initGit(dir, ['ignored-one.mjs', 'build/']);
    mkdirSync(join(dir, 'build'), { recursive: true });
    const result = gitIgnored(['ignored-one.mjs', 'kept.mjs', 'build/artifact.js'], dir);
    assert.deepEqual([...result].sort(), ['build/artifact.js', 'ignored-one.mjs'], 'only the two matched paths come back — kept.mjs is excluded from the Set');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitIgnored: a directory that is not a git repo at all (fatal, non-0/1 exit) returns null, not an empty Set', async () => {
  const gitIgnored = await loadGitIgnored();
  const dir = mkdtempSync(join(tmpdir(), 'sterling-gi-nogit-'));
  try {
    const result = gitIgnored(['src/a.mjs', 'src/b.mjs'], dir);
    assert.equal(result, null, 'a fatal git error must be distinguishable from "nothing is ignored" — callers degrade differently on null vs empty Set');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// SECTION 2 — H19 frontier suppression (AC1-AC4)
// =========================================================================

function makeH19Project({ rung = 'prompt' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-gi-h19-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: rung } }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const pendingOf = (dir) => {
  const p = join(dir, '.sterling', 'transient', 'delivery', 'pending.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};

const postRead = (dir, file, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, file) },
  cwd: dir,
  ...extra,
});

test('AC1a: a gitignored, unowned file stays fully silent at rung read — no additionalContext at all', () => {
  const { dir, cleanup } = makeH19Project({ rung: 'read' });
  try {
    initGit(dir, ['ignored.mjs']);
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'ignored.mjs'), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'nothing fresh for a gitignored+unowned path — no direct injection, not even a frontier notice');
  } finally {
    cleanup();
  }
});

test('AC1b: a gitignored, unowned file enqueues nothing at rung prompt (the frontier signal never reaches the pending queue either)', () => {
  const { dir, cleanup } = makeH19Project(); // default rung: prompt
  try {
    initGit(dir, ['ignored.mjs']);
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'ignored.mjs'), dir);
    assert.equal(r.code, 0);
    assert.equal(pendingOf(dir).length, 0, 'no frontier entry, no delivery entry — a gitignored unowned touch is a pure no-op');
  } finally {
    cleanup();
  }
});

test('AC2: a gitignored, unowned file WITH a fresh anti_pattern still delivers the hazard, but under the NORMAL header, never the frontier one', () => {
  const { dir, store, cleanup } = makeH19Project({ rung: 'read' });
  try {
    initGit(dir, ['ignored.mjs']);
    store.create(antiPattern('latch', ['ignored.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'ignored.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /ANTI-PATTERN \[WARN\] for this path — 'latch'/, 'the hazard still delivers');
    assert.match(ctx, /TRIGGER: latch trigger text/);
    assert.doesNotMatch(ctx, /STERLING FRONTIER SIGNAL/, 'the frontier header must not render for a gitignored path');
    assert.doesNotMatch(ctx, /H10 will demand the owning article/, 'that claim would now be FALSE — H10 excludes gitignored files from its demand (AC5)');
    assert.match(ctx, /STERLING KNOWLEDGE DELIVERY/, 'falls back to the normal delivery header instead of the frontier one');
  } finally {
    cleanup();
  }
});

test('AC3 (regression): an unowned file that git does NOT ignore still fires the frontier signal, once per file per session', () => {
  const { dir, cleanup } = makeH19Project(); // default rung: prompt
  try {
    initGit(dir, ['some-other-file.mjs']); // present but irrelevant to the touched path
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/new.mjs'), dir);
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/new.mjs'), dir);
    const pending = pendingOf(dir);
    assert.equal(pending.length, 1, 'the frontier signal fires once, exactly as it did before gitignore-awareness');
    assert.match(pending[0].payload, /FRONTIER SIGNAL/);
    assert.match(pending[0].payload, /src\/new\.mjs/);
  } finally {
    cleanup();
  }
});

test('AC4 (degrade): with no git repo present at all, the frontier signal still fires — the check degrades TOWARD signaling, never toward silence', () => {
  const { dir, cleanup } = makeH19Project({ rung: 'read' }); // no git init: an ignore-check would error, not answer
  try {
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/orphan.mjs'), dir);
    assert.equal(r.code, 0, 'AC7 floor (never deny) holds even when the ignore-check itself cannot run');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING FRONTIER SIGNAL/, 'an unanswerable ignore-check must never be treated as "this file is ignored"');
  } finally {
    cleanup();
  }
});

// =========================================================================
// SECTION 3 — H10 article demand (AC5-AC7)
// =========================================================================

const H10_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeH10Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-gi-h10-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(H10_CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

function touchRegister(dir, paths) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n'); // H10 acts only on files that still exist
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at: NOW }))));
}

function captureDecision(store) {
  store.create({
    ...envelope('decision', '2026-07-19T13:00:00.000Z'),
    title: 'learned things',
    statement: 's',
    alternatives_rejected: [],
    rationale: 'r',
  });
}

const stop = (dir, env = {}) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir, env);
const articleMissingItems = (store) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'article_missing');

test('AC5a: a session whose only unowned touches are ALL gitignored raises NO article demand', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    initGit(dir, ['ignored-a.mjs', 'ignored-b.mjs', 'ignored-c.mjs']);
    touchRegister(dir, ['ignored-a.mjs', 'ignored-b.mjs', 'ignored-c.mjs']);
    captureDecision(store);
    const r = stop(dir);
    assert.equal(r.code, 0, 'three touches, all gitignored — nothing unowned to raise a demand for');
    assert.equal(articleMissingItems(store).length, 0);
  } finally {
    cleanup();
  }
});

test('AC5b: gitignored files never count toward the threshold — 3 touches with 1 gitignored leaves only 2 REAL unowned files, under the default threshold of 3, so no demand fires', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    initGit(dir, ['ignored.mjs']);
    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'ignored.mjs']);
    captureDecision(store);
    const r = stop(dir);
    assert.equal(r.code, 0, 'a naive raw-count implementation would see 3 touches and fire; the correct one filters the ignored file out first and sees only 2');
    assert.equal(articleMissingItems(store).length, 0);
  } finally {
    cleanup();
  }
});

test('AC5c: gitignored paths never appear in a raised demand\'s file_keys, even when other real files reach threshold', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    initGit(dir, ['ignored-a.mjs', 'ignored-b.mjs']);
    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs', 'ignored-a.mjs', 'ignored-b.mjs']);
    captureDecision(store);
    const first = stop(dir);
    assert.equal(first.code, 2, 'the three real unowned files still reach the threshold');
    assert.match(first.stderr, /article demand/);
    assert.equal(stop(dir).code, 0, 'second Stop releases the session');
    const missing = articleMissingItems(store);
    assert.equal(missing.length, 1);
    assert.deepEqual(
      [...missing[0].file_keys].sort(),
      ['src/x.mjs', 'src/y.mjs', 'src/z.mjs'],
      'the two gitignored files were touched but must never appear in the raised item\'s file_keys'
    );
  } finally {
    cleanup();
  }
});

test('AC6 (regression): non-ignored unowned files still trigger the article demand at threshold, with a .gitignore present but irrelevant to the touched paths', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    initGit(dir, ['node_modules/']); // present, but does not match any touched path
    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
    captureDecision(store);
    const first = stop(dir);
    assert.equal(first.code, 2, 'threshold reached exactly as before gitignore-awareness existed');
    assert.match(first.stderr, /article demand/);
    assert.match(first.stderr, /no owner \(feature_article or repo-located reference doc\)/);
    const second = stop(dir);
    assert.equal(second.code, 0, 'second Stop releases the session (P1)');
    const missing = articleMissingItems(store);
    assert.equal(missing.length, 1);
    assert.deepEqual([...missing[0].file_keys].sort(), ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
  } finally {
    cleanup();
  }
});

test('AC7 (degrade): a failing ignore-check (no git repo at all) falls back to the UNFILTERED unowned list — the demand still fires from all 3 touches, and the degrade is recorded loudly via check_skipped, never silently narrowing the count', () => {
  const { dir, store, cleanup } = makeH10Project(); // no git init anywhere: check-ignore has no repo to answer from
  try {
    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
    captureDecision(store);
    const first = stop(dir);
    assert.equal(first.code, 2, 'the full, unfiltered touch list still reaches threshold — a failing ignore-check must not shrink the unowned set below it');
    assert.notEqual(first.code, 1, 'a failed sub-check degrades that check alone — it must not abort all Stop duties the way a genuine internal throw does');
    assert.match(first.stderr, /article demand/);
    const second = stop(dir);
    assert.equal(second.code, 0);
    const missing = articleMissingItems(store);
    assert.equal(missing.length, 1);
    assert.deepEqual(
      [...missing[0].file_keys].sort(),
      ['src/x.mjs', 'src/y.mjs', 'src/z.mjs'],
      'unfiltered — nothing was excluded just because the ignore-check itself failed'
    );
    const skipped = store.listCheckSkipped();
    assert.ok(
      skipped.some((c) => /gitignore/i.test(`${c.check_name ?? ''} ${c.reason ?? ''}`)),
      'the ignore-check failure must be recorded via the store\'s existing check_skipped mechanism (P5) — a silently-absorbed failure is exactly the drift this AC forbids'
    );
  } finally {
    cleanup();
  }
});
