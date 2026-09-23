// OUTSIDE-COMMIT NEWNESS BASE FIX (board 4e624c1a; finding
// outside-commit-drift-detection-owned-detected-new-unowned-silent-september-2026,
// 6d1b3c99). A plain `git commit` made OUTSIDE Claude Code (no hooks, no MCP)
// between two sessions can add a brand-new UNOWNED file. By the time the next
// Stop runs, that file is already committed into HEAD, so H10's "any NEW
// unowned file" fast path — which tested newness against `git ls-tree HEAD`
// — never saw it as new, and the ordinary min_unowned_files threshold
// (default 3) rarely catches a single stray file either. The fix tests
// newness against the SETTLED SNAPSHOT'S BASE COMMIT instead (the same base
// gitTouches, scripts/hooks/lib/settlement.mjs:451-471, diffs candidates
// from) — a file absent at the last settled observation counts as new
// whoever committed it since — falling back to HEAD when that base is
// unavailable (no settled snapshot yet, or one whose SHA no longer resolves).
//
// Harness copied verbatim in shape from h10-git-touches-and-gauge.test.mjs
// (makeGitProject / articleWithBaseline / runStop), which owns the git-backed
// H10 fixtures; a real H1 SessionStart run added per the repro script this
// test formalizes (scratchpad h10-outside-commit-repro.mjs).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
// Deliberately in the PAST relative to real wall-clock, same reasoning as the
// repro script: the article's created_at must predate the git-candidate
// touches' `at` (real file mtimes), or the pre-existing article record
// itself trivially satisfies the capture duty by timestamp coincidence.
const NOW = '2020-01-01T08:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const sha256hex = (content) => createHash('sha256').update(content, 'utf8').digest('hex');

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-outside-commit-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(
    join(dir, '.sterling', 'config.json'),
    JSON.stringify({ toolchains: [], context_watch: { windows: { default: 200_000 }, conductor: { soft_pct: 35, hard_pct: 50 } } })
  );
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\nt/\n');
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, g, cleanup };
}

function writeFile(dir, path, content) {
  const abs = join(dir, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commitAll(g, msg = 'c') {
  g(['add', '-A']);
  g(['commit', '-qm', msg]);
}

function envelope(type, at = NOW) {
  return { id: randomUUID(), type, created_at: at, updated_at: at, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
}

function articleWithBaseline(store, slug, files) {
  return store.create({
    ...envelope('feature_article'),
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: files.map((f) => ({ path: f.path, role: 'impl' })),
    file_baselines: Object.fromEntries(files.map((f) => [f.path, sha256hex(f.content)])),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
  });
}

function captureNow(store) {
  const at = new Date(Date.now() + 1000).toISOString();
  return store.create({ ...envelope('decision', at), title: 'learned', statement: 's', alternatives_rejected: [], rationale: 'r' });
}

function runSessionStart(dir, source = 'startup') {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h1-session-start.mjs')], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runStop(dir) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h10-direct-capture.mjs')], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop' }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const out = (r) => `${r.stdout}\n${r.stderr}`;
const articleMissingItems = (store) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.source === 'system' && t.system_reason === 'article_missing');

test('setup', async () => {
  // `before` already awaited above; this keeps the async import ordered
  // ahead of every fixture-building test below, matching the sibling files.
});

test('OUTSIDE COMMIT: a brand-new unowned file added by a plain git commit between sessions is caught — newness is tested against the settled BASE, not HEAD', () => {
  const { dir, store, g, cleanup } = makeGitProject();
  try {
    // SESSION 1: an owned file exists; H1 seeds nothing (no register yet); H10
    // Stop with nothing touched seeds the FIRST settled snapshot (the
    // documented first-run baseline).
    const originalOwned = 'export const owned = 1;\n';
    writeFile(dir, 'src/owned.mjs', originalOwned);
    commitAll(g, 'initial owned.mjs');
    articleWithBaseline(store, 'feat-owned', [{ path: 'src/owned.mjs', content: originalOwned }]);

    assert.equal(runSessionStart(dir, 'startup').code, 0, 'S1 H1 SessionStart must not fail');
    assert.equal(runStop(dir).code, 0, 'S1 H10 Stop (nothing touched) seeds the settled snapshot and releases quietly');

    // OUTSIDE CLAUDE CODE: a plain git commit, no hooks fired, adds ONE
    // brand-new unowned file (well under the default min_unowned_files
    // threshold of 3 — this must be caught by the "any new file" fast path,
    // not the threshold).
    writeFile(dir, 'src/brand-new-unowned.mjs', 'export const totallyNew = 42;\n');
    g(['add', '-A']);
    g(['-c', 'user.email=outside@t', '-c', 'user.name=outside-git', 'commit', '-qm', 'outside commit: add brand-new-unowned.mjs']);

    // SESSION 2: H1 does not re-seed (writeInitialGitSettled is an exclusive
    // 'wx' create — S1's snapshot survives), so H10 still diffs from S1's
    // base. Capture a decision first so the CAPTURE lane is satisfied and the
    // article-demand lane is isolated as the only remaining duty.
    assert.equal(runSessionStart(dir, 'startup').code, 0, 'S2 H1 SessionStart must not fail');
    captureNow(store);

    const nag = runStop(dir);
    assert.equal(
      nag.code,
      2,
      'HEAD-BASED-NEWNESS BUG if this is 0: the new file is already committed into HEAD by the time this Stop runs, so a newness probe against HEAD (pre-fix) never sees it as new, and 1 file never meets the default min_unowned_files threshold of 3 — the article demand must still fire against the settled BASE'
    );
    assert.match(out(nag), /article/i, 'the nag is the article-demand duty');
    assert.match(out(nag), /brand-new-unowned/, 'the nag names the newly discovered unowned file');

    const settle = runStop(dir);
    assert.equal(settle.code, 0, 'soft-blocked exactly once — the second Stop releases and queues the demand');
    const missing = articleMissingItems(store);
    assert.equal(missing.length, 1, 'exactly one article_missing item minted for the outside-committed unowned file');
    assert.ok(
      missing[0].file_keys.includes('src/brand-new-unowned.mjs'),
      `the queued item must name the outside-committed file; got file_keys=${JSON.stringify(missing[0].file_keys)}`
    );
  } finally {
    cleanup();
  }
});

test('FALLBACK: a first-ever session (no settled snapshot yet) falls back to HEAD-only newness — byte-identical to the pre-fix control', () => {
  const { dir, store, g, cleanup } = makeGitProject();
  try {
    // No prior Stop ever ran in this project: git-settled.json does not
    // exist, so `git.settled` is null and the newness probe must fall back
    // to HEAD (its only meaningful base — there is no prior observation).
    writeFile(dir, 'src/brand-new-unowned.mjs', 'export const totallyNew = 42;\n');
    commitAll(g, 'first commit: adds an unowned file directly');
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'git-settled.json')), false, 'CONTROL: no settled snapshot exists yet');

    assert.equal(runSessionStart(dir, 'startup').code, 0, 'H1 SessionStart must not fail');
    captureNow(store);

    const r = runStop(dir);
    // FIRST-RUN BEHAVIOUR IS UNCHANGED BY THIS FIX: with no settled snapshot,
    // git contributes NO candidates at all (gitTouches' documented first-run
    // baseline), so `unowned`/`paths` stays empty on this very first Stop and
    // nothing is demanded yet — the SAME shape as before this fix, since the
    // newnessBase fallback only matters once `unowned` is non-empty, which
    // requires a SECOND Stop to observe the file as a git candidate.
    assert.equal(r.code, 0, 'FALLBACK-BROKEN SHAPE if this is not 0: a first-ever session (no settled snapshot) must behave exactly as it did before this fix — no crash, no false demand');
    assert.doesNotMatch(out(r), /article/i, 'no article demand on the very first Stop of a project — matches pre-fix first-run behavior');
  } finally {
    cleanup();
  }
});
