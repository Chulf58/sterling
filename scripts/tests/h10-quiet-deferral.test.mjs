// H10 QUIET DEFERRAL — the fan-out deferral line is conductor-facing only;
// degradation disclosures stay loud on Stop.
//
// RULING: decision h10-deferral-is-conductor-facing-degradations-stay-loud
// (user-ruled 2026-09-30, "These message are very noisy in the terminal
// output. Can we make them only conductor facing?"):
//   (2) a deferral-only Stop emits NO systemMessage; the line goes through the
//       notice channel (publishNotice -> h19-delivery-drain additionalContext),
//       deduped per session on the owners and paths;
//   (3) degradations ([dispatch_status_unknown] here) stay on systemMessage (P5);
//   (4) inside a blocking duty nag the line names at most 3 paths plus "+N more"
//       and carries no "(repeats by design ... not a stuck nag)" tail.
// Plus the lifecycle gap the move opens: notices are not pruned at session
// start, so a deferral notice published by a session's last Stop must not
// drain into the NEXT session's first prompt.
//
// Harness duplicated rather than imported from a sibling h10-*.test.mjs
// (importing would double-run its registered test() calls).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const H10 = join(root, 'scripts', 'hooks', 'h10-direct-capture.mjs');
const DRAIN = join(root, 'scripts', 'hooks', 'h19-delivery-drain.mjs');
const TOUCH_AT = '2026-06-10T12:00:00.000Z';
const CAPTURE_AT = '2026-06-10T13:00:00.000Z';
const DIR_ENTRY = 'game/world/beam_pad';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.error?.message ?? ''}${r.stderr}`);
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-quietdefer-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  mkdirSync(join(dir, 'game', 'world'), { recursive: true });
  writeFileSync(join(dir, 'game', 'world', 'seed.gd'), '# seed\n');
  git(dir, ['add', 'game/world/seed.gd']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function runHook(script, dir, over = {}) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop', ...over }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const stop = (dir, over) => runHook(H10, dir, over);
const drain = (dir, over = {}) => runHook(DRAIN, dir, { hook_event_name: 'UserPromptSubmit', prompt: 'next', ...over });
const out = (r) => `${r.stdout}\n${r.stderr}`;

const noticesDir = (dir) => join(dir, '.sterling', 'transient', 'notices');
const noticeFiles = (dir) => (existsSync(noticesDir(dir)) ? readdirSync(noticesDir(dir)).filter((n) => n.endsWith('.json')) : []);
const deferralNotices = (dir) =>
  noticeFiles(dir)
    .map((n) => JSON.parse(readFileSync(join(noticesDir(dir), n), 'utf8')))
    .filter((n) => /deferred: \d+ file\(s\) owned by live dispatch/.test(n.text));

// Files are created AFTER the seed commit, so each is new against HEAD.
function createAndTouch(dir, paths) {
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '# new\n');
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at: TOUCH_AT }))));
}

// The capture lane is paid, so only the article demand could raise a duty.
function captureDecision(store) {
  store.create({
    id: randomUUID(), type: 'decision', created_at: CAPTURE_AT, updated_at: CAPTURE_AT, author: 'conductor',
    status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
    title: 'learned things', statement: 's', alternatives_rejected: [], rationale: 'r',
  });
}

const writeRegister = (dir, entries) => writeFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), JSON.stringify(entries));
const liveDirEntry = () => ({
  agent_id: 'lane-beam', agent_type: 'implementor', session_id: 's1',
  files: [DIR_ENTRY], files_source: 'review-territory', attribution: 'block', at: new Date().toISOString(),
});
const systemMessageOf = (r) => {
  const line = r.stdout.trim();
  if (!line) return null;
  return JSON.parse(line).systemMessage ?? null;
};

test('a deferral-only Stop emits NO systemMessage and publishes exactly one notice carrying the deferral line', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    captureDecision(store);
    writeRegister(dir, [liveDirEntry()]);
    createAndTouch(dir, [`${DIR_ENTRY}/x.gd`]);
    const r = stop(dir);
    assert.equal(r.code, 0, `nothing blocks: the only touched file is deferred; out=${out(r)}`);
    assert.equal(systemMessageOf(r), null, `no systemMessage for an informational deferral; out=${out(r)}`);
    assert.doesNotMatch(out(r), /deferred: /, `the deferral line does not reach the terminal; out=${out(r)}`);
    const notices = deferralNotices(dir);
    assert.equal(notices.length, 1, `one deferral notice is published; notices=${JSON.stringify(notices)}`);
    assert.match(notices[0].text, /deferred: 1 file\(s\) owned by live dispatch\(es\) \[lane-beam\]: game\/world\/beam_pad\/x\.gd/);
    assert.doesNotMatch(notices[0].text, /repeats by design/, 'the notice is published once, so the repeat rationale is gone');
  } finally {
    cleanup();
  }
});

test('the drain delivers the deferral notice as UserPromptSubmit additionalContext; an identical Stop republishes nothing; a changed set publishes again', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    captureDecision(store);
    writeRegister(dir, [liveDirEntry()]);
    createAndTouch(dir, [`${DIR_ENTRY}/x.gd`]);
    stop(dir);
    assert.equal(deferralNotices(dir).length, 1);

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const payload = JSON.parse(d.stdout);
    assert.equal(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(payload.hookSpecificOutput.additionalContext, /deferred: 1 file\(s\) owned by live dispatch\(es\) \[lane-beam\]: game\/world\/beam_pad\/x\.gd/);
    assert.equal(noticeFiles(dir).length, 0, 'the drain removes what it delivered');

    const same = stop(dir);
    assert.equal(systemMessageOf(same), null, `still quiet; out=${out(same)}`);
    assert.equal(deferralNotices(dir).length, 0, 'an unchanged deferral set is published once per session');

    createAndTouch(dir, [`${DIR_ENTRY}/x.gd`, `${DIR_ENTRY}/y.gd`]);
    const changed = stop(dir);
    assert.equal(systemMessageOf(changed), null, `still quiet; out=${out(changed)}`);
    const notices = deferralNotices(dir);
    assert.equal(notices.length, 1, 'a changed deferral set publishes one new notice');
    assert.match(notices[0].text, /deferred: 2 file\(s\)/);
  } finally {
    cleanup();
  }
});

test('a degradation ([dispatch_status_unknown]) still emits a systemMessage, and the deferral beside it does not ride it', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    captureDecision(store);
    // seed.gd is tracked (modified, not new), so no article demand; its only
    // register owner is a same-session row whose lease expired -> unknown.
    writeRegister(dir, [
      liveDirEntry(),
      { agent_id: 'expired-1', agent_type: 'coder', session_id: 's1', files: ['game/world/seed.gd'], attribution: 'block', at: new Date(Date.now() - 60 * 60_000).toISOString() },
    ]);
    createAndTouch(dir, [`${DIR_ENTRY}/x.gd`]);
    writeFileSync(join(dir, 'game', 'world', 'seed.gd'), '# seed changed\n');
    writeFileSync(
      join(dir, '.sterling', 'transient', 'touches.json'),
      JSON.stringify([{ path: `${DIR_ENTRY}/x.gd`, at: TOUCH_AT }, { path: 'game/world/seed.gd', at: TOUCH_AT }])
    );
    const r = stop(dir);
    assert.equal(r.code, 0, `the degradation discloses, it never blocks; out=${out(r)}`);
    const msg = systemMessageOf(r);
    assert.ok(msg, `a degradation stays loud on systemMessage; out=${out(r)}`);
    assert.match(msg, /\[dispatch_status_unknown\]/);
    assert.doesNotMatch(msg, /deferred: /, 'the informational deferral line goes to the notice channel, not the terminal');
    assert.equal(deferralNotices(dir).length, 1, 'the deferral still reaches the conductor through the notice channel');
  } finally {
    cleanup();
  }
});

test('a blocking duty nag with 13 deferred files names 3 paths plus "+10 more" and no "repeats by design" tail', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    captureDecision(store);
    writeRegister(dir, [liveDirEntry()]);
    const deferred = Array.from({ length: 13 }, (_, i) => `${DIR_ENTRY}/f${String(i).padStart(2, '0')}.gd`);
    // One new UNOWNED file outside the dispatch's directory raises the article demand.
    createAndTouch(dir, [...deferred, 'game/world/unowned.gd']);
    const r = stop(dir);
    assert.equal(r.code, 2, `the article demand blocks; out=${out(r)}`);
    const line = r.stderr.split('\n').find((l) => /deferred: \d+ file\(s\) owned by live dispatch/.test(l));
    assert.ok(line, `the deferral line stays visible inside the nag; stderr=${r.stderr}`);
    assert.match(line, /deferred: 13 file\(s\) owned by live dispatch\(es\) \[lane-beam\]: game\/world\/beam_pad\/f00\.gd, game\/world\/beam_pad\/f01\.gd, game\/world\/beam_pad\/f02\.gd \+10 more/);
    assert.doesNotMatch(line, /f03\.gd/, 'at most 3 paths are named');
    assert.doesNotMatch(r.stderr, /repeats by design/, 'the rationale tail is gone');
  } finally {
    cleanup();
  }
});

test('a deferral notice from an EARLIER session is not delivered into the next session, and is removed; a same-session one and an unkeyed one still are', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(noticesDir(dir), { recursive: true });
    writeFileSync(join(noticesDir(dir), 'h10-a-old.json'), JSON.stringify({ text: '• deferred: stale from s-old', session_id: 's-old' }));
    writeFileSync(join(noticesDir(dir), 'h10-b-now.json'), JSON.stringify({ text: '• deferred: fresh from s1', session_id: 's1' }));
    writeFileSync(join(noticesDir(dir), 'h10-c-unkeyed.json'), JSON.stringify({ text: 'pressure advisory' }));
    const d = drain(dir, { session_id: 's1' });
    assert.equal(d.code, 0, d.stderr);
    const ctx = JSON.parse(d.stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /stale from s-old/, 'an earlier session\'s deferral is stale here');
    assert.match(ctx, /fresh from s1/);
    assert.match(ctx, /pressure advisory/, 'a notice without a session key keeps today\'s behavior');
    assert.equal(noticeFiles(dir).length, 0, 'the stale notice is removed too, never left to accumulate');
  } finally {
    cleanup();
  }
});

test('a stale-only notice directory yields no output and still removes the stale notice', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(noticesDir(dir), { recursive: true });
    writeFileSync(join(noticesDir(dir), 'h10-a-old.json'), JSON.stringify({ text: '• deferred: stale from s-old', session_id: 's-old' }));
    const d = drain(dir, { session_id: 's1' });
    assert.equal(d.code, 0, d.stderr);
    assert.doesNotMatch(d.stdout, /stale from s-old/);
    assert.equal(noticeFiles(dir).length, 0);
  } finally {
    cleanup();
  }
});
