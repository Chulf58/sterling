// SLICE 4 (board slice-4-touches-from-git-gauge-with-the-right-window-at-stop,
// 400f578b; Astra follow-ups board 5e032781; decision
// sterling-claude-code-scale-down-boundary changes 1 and 2).
//
// (a) TOUCHES FROM GIT. At Stop, H10 derives a touched set from git — tracked
//     changes (working tree + index) against a PERSISTED settled snapshot, plus
//     untracked files (.gitignore respected) — and unions it with H7's touch
//     register, so an edit made by hand or through Bash mints the same duties
//     an Edit-tool edit does. When git knows a register path is unchanged since
//     the settled snapshot, that register entry mints nothing. The snapshot
//     advances ONLY after a successful settlement; a failed mint leaves it
//     where it was so the next Stop retries the same range.
// (b) GAUGE. Fill is measured by a three-step lookup: windows[model], then
//     windows[baseModel] (a context-variant suffix like "[1m]" strips to its
//     base entry), then windows.default as a real fallback (decision
//     context-window-default-is-a-real-fallback, user-ruled 2026-09-22) — a
//     per-model entry always wins over the default when one exists. Only a
//     model matching NONE of the three reports the fill as UNRELIABLE (no
//     percentage guessed). The 50% target is a WARNING to finish and commit —
//     never a demand to clear.
//
// Every fixture is a real git repo in the OS tmpdir. The FIRST Stop on a clean
// committed tree seeds the settled snapshot (the documented first-run
// baseline: "the tree as it stands at the first settle"), so each pin starts
// from a settled state exactly as a live session would after one Stop.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-09-19T08:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const sha256hex = (content) => createHash('sha256').update(content, 'utf8').digest('hex');

// The SHIPPED window map — the pins below must hold for what a consumer gets.
const SHIPPED_WINDOWS = JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8')).context_watch.windows;

function makeGitProject(windows = { default: 200_000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-slice4-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(
    join(dir, '.sterling', 'config.json'),
    JSON.stringify({ toolchains: [], context_watch: { windows, conductor: { soft_pct: 35, hard_pct: 50 } } })
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
  // Mirrors an init'd project: .sterling/ is gitignored; t/ holds the fixture
  // transcript, which lives outside the repo in reality.
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

/** A durable capture stamped AFTER every edit so far — satisfies the capture lane. */
function captureNow(store) {
  const at = new Date(Date.now() + 1000).toISOString();
  return store.create({ ...envelope('decision', at), title: 'learned', statement: 's', alternatives_rejected: [], rationale: 'r' });
}

function registerTouches(dir, paths) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at: NOW }))));
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

function drainNotices(dir) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h19-delivery-drain.mjs')], {
    input: JSON.stringify({ cwd: dir, hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', cwd: dir, timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function noticeTexts(dir) {
  const notices = join(dir, '.sterling', 'transient', 'notices');
  return readdirSync(notices).map((name) => JSON.parse(readFileSync(join(notices, name), 'utf8')).text);
}

const reconcileItems = (store) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.source === 'system' && t.system_reason === 'reconcile_needed');

function writeTranscript(dir, inputTokens, model) {
  const p = join(dir, 't', 's1.jsonl');
  mkdirSync(dirname(p), { recursive: true });
  const message = { usage: { input_tokens: inputTokens, cache_read_input_tokens: 0 } };
  if (model !== undefined) message.model = model;
  writeFileSync(p, JSON.stringify({ type: 'assistant', message }) + '\n');
}

const pressureSample = (dir) => JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'conductor-pressure.json'), 'utf8'));

// =========================================================================
// (a) touches from git
// =========================================================================

test('git touches (1): a file edited ONLY via Bash (no H7 register entry) appears in the Stop duties and settles to a reconcile_needed item', () => {
  const { dir, store, g, cleanup } = makeGitProject();
  try {
    const original = 'export const a = 1;\n';
    writeFile(dir, 'src/a.mjs', original);
    commitAll(g);
    const article = articleWithBaseline(store, 'feat-a', [{ path: 'src/a.mjs', content: original }]);
    assert.equal(runStop(dir).code, 0, 'seed Stop on a clean tree releases');

    // A shell edit: bytes change on disk, H7 never fires, touches.json is empty.
    writeFile(dir, 'src/a.mjs', 'export const a = 2;\n');
    assert.ok(!existsSync(join(dir, '.sterling', 'transient', 'touches.json')), 'precondition: no register entry exists');

    const nag = runStop(dir);
    assert.equal(nag.code, 2, `the shell edit arms the capture duty — stderr=${nag.stderr}`);
    assert.match(nag.stderr, /capture · 1 file/, 'the Bash-only edit is counted in the Stop duties');

    captureNow(store);
    const settle = runStop(dir);
    assert.equal(settle.code, 0, settle.stderr);
    const items = reconcileItems(store);
    assert.equal(items.length, 1, 'the shell edit settles to exactly one reconcile_needed item');
    assert.equal(items[0].feature_link, article.id);
    assert.deepEqual(items[0].file_keys, ['src/a.mjs']);
  } finally {
    cleanup();
  }
});

test('git touches (2): a path in the H7 register but unchanged in git (tracked, not untracked) mints nothing — CONTROL: the article baseline is STALE, so without the git check settlement would mint', () => {
  const { dir, store, g, cleanup } = makeGitProject();
  try {
    // Committed content differs from the article's baseline: settlement's
    // baseline predicate alone WOULD mint for this path (the control that
    // makes a zero here mean "git said unchanged", not "nothing to mint").
    writeFile(dir, 'src/b.mjs', 'export const b = 2;\n');
    commitAll(g);
    articleWithBaseline(store, 'feat-b', [{ path: 'src/b.mjs', content: 'export const b = 1;\n' }]);
    assert.equal(runStop(dir).code, 0, 'seed Stop');

    registerTouches(dir, ['src/b.mjs']); // an Edit that left the bytes unchanged
    captureNow(store);
    const r = runStop(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reconcileItems(store).length, 0, 'a register path git reports unchanged since the settled snapshot mints nothing');
  } finally {
    cleanup();
  }
});

test('git touches (3): an UNTRACKED new file (never git-added, no register entry) mints its reconcile duty', () => {
  const { dir, store, g, cleanup } = makeGitProject();
  try {
    writeFile(dir, 'base.mjs', '// base\n');
    commitAll(g);
    // The article already claims a file that does not exist yet (its baseline
    // names the planned content) — the untracked file lands with other bytes.
    const article = articleWithBaseline(store, 'feat-c', [{ path: 'src/new.mjs', content: 'planned\n' }]);
    assert.equal(runStop(dir).code, 0, 'seed Stop');

    writeFile(dir, 'src/new.mjs', 'export const c = 3;\n');
    captureNow(store);
    const r = runStop(dir);
    assert.equal(r.code, 0, r.stderr);
    const items = reconcileItems(store);
    assert.equal(items.length, 1, 'the untracked file mints');
    assert.equal(items[0].feature_link, article.id);
    assert.deepEqual(items[0].file_keys, ['src/new.mjs']);
  } finally {
    cleanup();
  }
});

test('git touches (4): the settled snapshot does NOT advance when minting fails — the next Stop re-derives and mints the same shell edit', () => {
  const { dir, store, g, cleanup } = makeGitProject();
  try {
    const original = 'export const d = 1;\n';
    writeFile(dir, 'src/d.mjs', original);
    commitAll(g);
    const article = articleWithBaseline(store, 'feat-d', [{ path: 'src/d.mjs', content: original }]);
    assert.equal(runStop(dir).code, 0, 'seed Stop');

    writeFile(dir, 'src/d.mjs', 'export const d = 2;\n');
    captureNow(store);

    // Make every todo INSERT abort — settlement's enqueue throws inside H10.
    const db = new DatabaseSync(join(dir, '.sterling', 'sterling.db'));
    db.exec("CREATE TRIGGER fail_todo BEFORE INSERT ON records WHEN NEW.type = 'todo' BEGIN SELECT RAISE(ABORT, 'injected mint failure'); END;");
    const failed = runStop(dir);
    assert.equal(reconcileItems(store).length, 0, 'precondition: the injected failure really prevented the mint');
    db.exec('DROP TRIGGER fail_todo;');
    db.close();
    assert.notEqual(failed.code, null, failed.stderr);

    // No new edits. If the snapshot had advanced past the failed range, git
    // would now report src/d.mjs as already settled and nothing would mint.
    const retry = runStop(dir);
    assert.equal(retry.code, 0, retry.stderr);
    const items = reconcileItems(store);
    assert.equal(items.length, 1, 'the failed range is retried, not lost');
    assert.equal(items[0].feature_link, article.id);
  } finally {
    cleanup();
  }
});

test('git touches (5): rewritten settled history mints one loud capture_owed recovery item and advances only after it is durable', () => {
  const { dir, store, g, cleanup } = makeGitProject();
  try {
    writeFile(dir, 'src/rewrite.mjs', 'export const v = 1;\n');
    commitAll(g, 'original');
    articleWithBaseline(store, 'rewrite', [{ path: 'src/rewrite.mjs', content: 'export const v = 1;\n' }]);
    assert.equal(runStop(dir).code, 0, 'seed the original settled SHA');
    const oldSha = g(['rev-parse', 'HEAD']).trim();
    writeFile(dir, 'src/rewrite.mjs', 'export const v = 2;\n');
    g(['add', '-A']); g(['commit', '--amend', '-qm', 'rewritten']);
    captureNow(store);
    const first = runStop(dir);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /SETTLEMENT HISTORY REWRITTEN/);
    assert.match(first.stdout, new RegExp(oldSha));
    const recovery = store.query({ types: ['todo'], cap: 100 }).filter((r) => r.system_reason === 'capture_owed' && /settlement history rewritten/.test(r.text));
    assert.equal(recovery.length, 1, 'one durable recovery item is minted');
    assert.match(recovery[0].text, /reconcile them by hand from git log/i);
    const second = runStop(dir);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(store.query({ types: ['todo'], cap: 100 }).filter((r) => /settlement history rewritten/.test(r.text)).length, 1, 'advance prevents repeated recovery minting');
  } finally { cleanup(); }
});

test('git touches (6): an EMPTY_TREE snapshot from an unborn repository becomes the first commit baseline, not rewritten history', () => {
  const { dir, store, g, cleanup } = makeGitProject();
  try {
    assert.equal(runStop(dir).code, 0, 'unborn Stop persists the empty-tree baseline');
    const firstContent = 'export const first = 1;\n';
    writeFile(dir, 'src/first.mjs', firstContent);
    commitAll(g, 'first');
    // Owned (board 4e624c1a fix): src/first.mjs is absent from the settled
    // EMPTY_TREE base, so the article-demand newness probe now correctly
    // reads it as new — orthogonal to what THIS test pins (the
    // settlement-history-rewrite guard). Owning it isolates that unrelated,
    // now-correctly-firing lane so this test's own assertions stay exact.
    articleWithBaseline(store, 'feat-first', [{ path: 'src/first.mjs', content: firstContent }]);
    captureNow(store);
    const settled = runStop(dir);
    assert.equal(settled.code, 0, settled.stderr);
    assert.doesNotMatch(settled.stdout, /SETTLEMENT HISTORY REWRITTEN/);
    assert.equal(store.query({ types: ['todo'], cap: 100 }).filter((r) => r.system_reason === 'capture_owed' && /settlement history rewritten/.test(r.text)).length, 0);
  } finally { cleanup(); }
});

// =========================================================================
// (b) gauge against the right window
// =========================================================================

test('gauge (1): the SHIPPED window map reports a claude-fable-5-1 session against 1,000,000 tokens', () => {
  const { dir, cleanup } = makeGitProject(SHIPPED_WINDOWS);
  try {
    writeTranscript(dir, 300_000, 'claude-fable-5-1');
    const r = runStop(dir);
    assert.equal(r.code, 0, `30% is below every threshold: ${r.stderr}`);
    const s = pressureSample(dir);
    assert.equal(s.window, 1_000_000, 'fable-5-1 is measured against its 1M window');
    assert.ok(Math.abs(s.fill_pct - 30) < 0.01, `fill 30%, got ${s.fill_pct}`);
    assert.equal(s.unmapped_model, undefined);
  } finally {
    cleanup();
  }
});

test('gauge (2): a model id with a context-variant suffix ("claude-opus-5[1m]") resolves to its BASE entry, not the default — proven by giving them DIFFERENT values (Sol review: an equal default would pass even with the baseModel lookup deleted)', () => {
  // default deliberately != claude-opus-5's window, so a fill/window/message
  // match against 1,000,000 can only come from the base-model lookup, never
  // from falling through to windows.default (which is 200,000 here).
  const { dir, cleanup } = makeGitProject({ ...SHIPPED_WINDOWS, default: 200_000 });
  try {
    writeTranscript(dir, 132_400, 'claude-opus-5[1m]');
    const r = runStop(dir);
    assert.equal(r.code, 0, r.stderr);
    // 13.24% is below every threshold — no systemMessage is printed at all;
    // only assert the sample the hook persisted regardless of stdout.
    const message = r.stdout.trim() ? JSON.parse(r.stdout).systemMessage ?? '' : '';
    const s = pressureSample(dir);
    assert.equal(s.window, 1_000_000, 'the [1m] variant resolves to the claude-opus-5 BASE entry, not the 200,000 default');
    assert.ok(Math.abs(s.fill_pct - 13.24) < 0.01, `fill ~13.2%, got ${s.fill_pct}`);
    assert.equal(s.window_source, undefined, 'a resolved base-model entry is not a default fallback');
    assert.doesNotMatch(message, /\(window from context_watch\.windows\.default\)/, 'a mapped base entry carries no guessed-denominator note');
  } finally {
    cleanup();
  }
});

test('gauge (3): an UNKNOWN model with NO default configured reports the fill as unreliable — no percentage measured against a guessed window', () => {
  // Changed for decision context-window-default-is-a-real-fallback (user-ruled
  // 2026-09-22): windows.default is now a real fallback, so this UNRELIABLE
  // pin must remove the default key to still exercise the "no window at all"
  // path — see gauge (5) below for the unmapped-model-WITH-a-default case.
  const { dir, cleanup } = makeGitProject({});
  try {
    writeTranscript(dir, 132_400, 'claude-novel-9');
    const r = runStop(dir);
    assert.equal(r.code, 0, 'an unknown window is advisory, never a Stop refusal');
    const message = JSON.parse(r.stdout).systemMessage;
    assert.match(message, /claude-novel-9/, 'names the model');
    assert.match(message, /unreliable/i, 'says the number is unreliable');
    assert.match(message, /context_watch\.windows/, 'names the config key to add');
    assert.doesNotMatch(message, /\d+(\.\d+)?%/, 'prints no percentage');
    const notices = noticeTexts(dir);
    assert.ok(notices.some((text) => /claude-novel-9/.test(text) && /unreliable/i.test(text)), 'the immutable notice preserves the unknown-window advisory');
    const drained = drainNotices(dir);
    assert.equal(drained.code, 0, drained.stderr);
    assert.match(drained.stdout, /claude-novel-9/);
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'notices')) && readdirSync(join(dir, '.sterling', 'transient', 'notices')).length, 0, 'notice files delete only after emission');
    const s = pressureSample(dir);
    assert.equal(s.fill_pct, null, 'no fill number is persisted');
    assert.equal(s.level, 'unknown');
    assert.equal(s.unmapped_model, 'claude-novel-9');
  } finally {
    cleanup();
  }
});

test('gauge (4): past the 50% target H10 WARNS to finish and commit through an immutable notice — it never demands a clear or refuses Stop', () => {
  const { dir, cleanup } = makeGitProject(SHIPPED_WINDOWS);
  try {
    writeTranscript(dir, 600_000, 'claude-fable-5-1');
    const r = runStop(dir);
    // EXIT-2 PIN UPDATE (settled conductor design A): this used to assert 2 because
    // pressure rode writeThenSpend. A warning cannot refuse Stop; it is now exit 0,
    // visible to the user and published for UserPromptSubmit.
    assert.equal(r.code, 0, 'pressure is advisory and never refuses Stop');
    const message = JSON.parse(r.stdout).systemMessage;
    assert.match(message, /60\.0%/, 'names the fill');
    assert.match(message, /1000000/, 'names the window it measured against');
    assert.match(message, /50%/, 'names the target');
    assert.match(message, /finish/i);
    assert.match(message, /commit/i);
    assert.doesNotMatch(message, /READY TO CLEAR|\/clear|rotation-note/i, 'no clear demand, no rotation protocol');
    const notices = noticeTexts(dir);
    assert.ok(notices.some((text) => /60\.0%/.test(text) && /finish/i.test(text) && /commit/i.test(text)), 'the immutable notice preserves the pressure advisory');
    const drained = drainNotices(dir);
    assert.equal(drained.code, 0, drained.stderr);
    assert.match(drained.stdout, /60\.0%/);
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'notices')) && readdirSync(join(dir, '.sterling', 'transient', 'notices')).length, 0, 'notice files delete only after emission');
    assert.equal(runStop(dir).code, 0, 'once per session');
  } finally {
    cleanup();
  }
});

test('gauge (5): an UNMAPPED model with a default configured falls back to context_watch.windows.default and the line names it (decision context-window-default-is-a-real-fallback)', () => {
  const { dir, cleanup } = makeGitProject({ default: 1_000_000 });
  try {
    writeTranscript(dir, 600_000, 'claude-novel-9');
    const r = runStop(dir);
    assert.equal(r.code, 0, r.stderr);
    const message = JSON.parse(r.stdout).systemMessage;
    assert.doesNotMatch(message, /UNRELIABLE/i, 'a default window means the fill IS reported');
    assert.match(message, /60\.0%/, 'fill is measured against the default window');
    assert.match(message, /1000000/, 'names the default window it measured against');
    assert.match(message, /\(window from context_watch\.windows\.default\)/, 'flags the guessed denominator so it reads differently from a mapped one');
    const s = pressureSample(dir);
    assert.equal(s.window, 1_000_000);
    assert.equal(s.window_source, 'default');
    assert.equal(s.unmapped_model, undefined, 'a resolved default is not the unmapped-model case');
    assert.ok(Math.abs(s.fill_pct - 60) < 0.01, `fill 60%, got ${s.fill_pct}`);
  } finally {
    cleanup();
  }
});

test('gauge (6): a MAPPED model wins over a configured default — the per-model window is used and the default note is absent', () => {
  const { dir, cleanup } = makeGitProject({ default: 1_000_000, 'claude-custom-1': 250_000 });
  try {
    writeTranscript(dir, 150_000, 'claude-custom-1');
    const r = runStop(dir);
    assert.equal(r.code, 0, r.stderr);
    const message = JSON.parse(r.stdout).systemMessage;
    assert.match(message, /60\.0%/, 'fill measured against the PER-MODEL window (150k/250k), not the 1M default');
    assert.match(message, /250000/, 'names the per-model window');
    assert.doesNotMatch(message, /\(window from context_watch\.windows\.default\)/, 'a mapped entry is not a guessed denominator');
    const s = pressureSample(dir);
    assert.equal(s.window, 250_000);
    assert.equal(s.window_source, undefined, 'no window_source is recorded when a per-model entry resolves the window');
  } finally {
    cleanup();
  }
});
