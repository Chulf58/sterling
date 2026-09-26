// H10 'PR review loop owed' duty (decision
// project-mode-hobby-work-toggle-decides-flow, slice S3; skill
// skills/pr-review-loop/SKILL.md). A work-mode /sterling:merge that creates or
// reuses a PR arms .sterling/transient/pr-loop.json {status:'owed'}; H10 then
// carries the duty on EVERY Stop, even one with no file changes, using the
// preserved-debt lifecycle: it BLOCKS once per session per arming (the nag,
// with the PR link and the next action), and every other Stop releases with a
// non-blocking reminder. The debt itself stays in pr-loop.json until the
// conductor settles it (pr-review-wait.mjs --settle clean|capped|escalated).
// It is never an indefinite Stop refusal. A hobby project never carries it.
//
// NEW SIBLING FILE by the established precedent (h10-*.test.mjs siblings
// duplicate their harness rather than importing one another).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(root, 'scripts', 'hooks', 'h10-direct-capture.mjs');
const PR_URL = 'https://github.com/acme/widget/pull/7';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-prloop-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(mode === undefined ? CONFIG : { ...CONFIG, mode }));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const loopFile = (dir) => join(dir, '.sterling', 'transient', 'pr-loop.json');
function arm(dir, over = {}) {
  writeFileSync(
    loopFile(dir),
    JSON.stringify({ pr_url: PR_URL, pr_number: 7, repo: 'github.com/acme/widget', head_sha: 'a'.repeat(40), armed_at: '2026-09-26T10:00:00.000Z', status: 'owed', ...over })
  );
}

function stop(dir, { session = 's1', active = false } = {}) {
  const input = { session_id: session, transcript_path: join(dir, 't', `${session}.jsonl`), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: active };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', cwd: dir, timeout: 60_000, env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' } });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const systemMessage = (r) => {
  try {
    return JSON.parse(r.stdout).systemMessage ?? '';
  } catch {
    return '';
  }
};

test('work, owed, NO file changes: the first Stop blocks once with the PR link and the next action; the next Stop releases with a reminder', () => {
  const p = makeProject('work');
  try {
    arm(p.dir);
    const first = stop(p.dir);
    assert.equal(first.code, 2, `the first Stop nags (exit 2): ${first.stdout} ${first.stderr}`);
    assert.match(first.stderr, /PR review loop owed/);
    assert.ok(first.stderr.includes(PR_URL), 'names the PR link');
    assert.match(first.stderr, /pr-review-loop/, 'names the skill (the next action)');
    assert.match(first.stderr, /--settle (clean\|capped\|escalated|<clean\|capped\|escalated>)/, 'names how the duty is discharged');

    for (const active of [true, false]) {
      const again = stop(p.dir, { active });
      assert.equal(again.code, 0, `never blocks twice in one session (stop_hook_active=${active}): ${again.stderr}`);
      assert.ok(systemMessage(again).includes(PR_URL), `a non-blocking reminder rides the release: ${again.stdout}`);
    }
    assert.equal(JSON.parse(readFileSync(loopFile(p.dir), 'utf8')).status, 'owed', 'the debt is preserved, not cleared by the nag');
  } finally {
    p.cleanup();
  }
});

test('the debt is preserved across sessions: a NEW session is nagged once again; a re-arm (new push) is nagged once again', () => {
  const p = makeProject('work');
  try {
    arm(p.dir);
    assert.equal(stop(p.dir).code, 2);
    assert.equal(stop(p.dir).code, 0);
    assert.equal(stop(p.dir, { session: 's2' }).code, 2, 'new session: one nag');
    assert.equal(stop(p.dir, { session: 's2' }).code, 0);
    arm(p.dir, { armed_at: '2026-09-26T11:00:00.000Z', head_sha: 'c'.repeat(40) });
    assert.equal(stop(p.dir, { session: 's2' }).code, 2, 'a fresh arming in the same session: one nag');
  } finally {
    p.cleanup();
  }
});

test('stop_hook_active on the first Stop: no block, only the reminder (a continuation is never re-blocked)', () => {
  const p = makeProject('work');
  try {
    arm(p.dir);
    const r = stop(p.dir, { active: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(systemMessage(r).includes(PR_URL));
  } finally {
    p.cleanup();
  }
});

for (const outcome of ['clean', 'capped', 'escalated']) {
  test(`a loop settled '${outcome}' is discharged: no nag, no reminder`, () => {
    const p = makeProject('work');
    try {
      arm(p.dir, { status: outcome, settled_at: '2026-09-26T12:00:00.000Z' });
      const r = stop(p.dir);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(!(r.stdout + r.stderr).includes(PR_URL), `nothing names the PR: ${r.stdout} ${r.stderr}`);
    } finally {
      p.cleanup();
    }
  });
}

for (const mode of ['hobby', undefined]) {
  test(`a ${mode ?? 'mode-less'} project never carries the duty, even with a stray pr-loop.json`, () => {
    const p = makeProject(mode);
    try {
      arm(p.dir);
      const r = stop(p.dir);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(!(r.stdout + r.stderr).includes(PR_URL));
    } finally {
      p.cleanup();
    }
  });
}

test('with a capture duty ALSO open, ONE block carries both the capture nag and the PR loop text (the PR nag never steals the capture nag)', () => {
  const p = makeProject('work');
  try {
    arm(p.dir);
    mkdirSync(join(p.dir, 'src'), { recursive: true });
    writeFileSync(join(p.dir, 'src', 'x.mjs'), '// touched\n');
    writeFileSync(join(p.dir, '.sterling', 'transient', 'touches.json'), JSON.stringify([{ path: 'src/x.mjs', at: new Date().toISOString() }]));
    const r = stop(p.dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /knowledge_create/, 'the capture nag is there');
    assert.ok(r.stderr.includes(PR_URL), 'the PR loop rides the same block');
    const again = stop(p.dir, { active: true });
    assert.ok(!again.stderr.includes('PR review loop owed') || again.code !== 2, 'the PR nag was spent by the shared block');
  } finally {
    p.cleanup();
  }
});

test('an unreadable pr-loop.json in a work project is disclosed, never silently ignored, and never blocks', () => {
  const p = makeProject('work');
  try {
    writeFileSync(loopFile(p.dir), '{not json');
    const r = stop(p.dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(systemMessage(r), /pr-loop\.json/);
  } finally {
    p.cleanup();
  }
});

// Sol review (MEDIUM): a loop state that is not EXACTLY owed|clean|capped|
// escalated, lacks repo/head_sha, or is settled without settled_at is
// UNREADABLE — disclosed, never read as settled (silence) and never blocking.
for (const [label, over] of [
  ['an unknown status', { status: 'done' }],
  ['a wrong-case status', { status: 'CLEAN', settled_at: '2026-09-26T12:00:00.000Z' }],
  ['a settled status without settled_at', { status: 'clean' }],
  ['no repo', { repo: undefined }],
  ['no head_sha', { head_sha: undefined }],
]) {
  test(`a malformed loop state (${label}) is disclosed as unreadable, never treated as settled`, () => {
    const p = makeProject('work');
    try {
      arm(p.dir, over);
      const r = stop(p.dir);
      assert.equal(r.code, 0, r.stderr);
      assert.match(systemMessage(r), /pr-loop\.json is unreadable/, `disclosed: ${r.stdout}`);
    } finally {
      p.cleanup();
    }
  });
}

test('sessionless Stops (Sol review): with no session_id the owed loop NEVER blocks — a loud non-blocking reminder every Stop', () => {
  const p = makeProject('work');
  try {
    arm(p.dir);
    for (let i = 0; i < 2; i++) {
      const r = stop(p.dir, { session: null }); // null: undefined would take the default 's1'
      assert.equal(r.code, 0, `sessionless Stop ${i + 1} must not block: ${r.stderr}`);
      assert.ok(systemMessage(r).includes(PR_URL), r.stdout);
      assert.match(systemMessage(r), /no session id/i);
    }
  } finally {
    p.cleanup();
  }
});

test('an INVALID mode with a pr-loop.json present is disclosed: the mode is unreadable and the PR loop state was not evaluated (never silently suppressed)', () => {
  const p = makeProject('banana');
  try {
    arm(p.dir);
    const r = stop(p.dir);
    assert.equal(r.code, 0, r.stderr);
    const msg = systemMessage(r);
    assert.match(msg, /mode/i, r.stdout);
    assert.match(msg, /not evaluated/, r.stdout);
    assert.match(msg, /pr-loop\.json/);
  } finally {
    p.cleanup();
  }
});

test('an invalid mode with NO pr-loop.json adds no PR-loop disclosure', () => {
  const p = makeProject('banana');
  try {
    const r = stop(p.dir);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /pr-loop/);
  } finally {
    p.cleanup();
  }
});
