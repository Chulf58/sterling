// The 'PR review loop owed' duty rule H10 and the OpenCode plugin share
// (scripts/hooks/lib/pr-loop-duty.mjs): whether the loop is owed, what a state
// that cannot be evaluated says, and the exact next-action text. The H10 hook
// behavior around it stays pinned by h10-pr-review-loop.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const duty = await import(pathToFileURL(join(root, 'scripts', 'hooks', 'lib', 'pr-loop-duty.mjs')).href);

const PR_URL = 'https://github.com/acme/widget/pull/7';
const STATE = { pr_url: PR_URL, pr_number: 7, repo: 'github.com/acme/widget', head_sha: 'a'.repeat(40), armed_at: '2026-09-26T10:00:00.000Z', status: 'owed' };

function project(mode, loop) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-prloop-duty-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(mode === undefined ? {} : { mode }));
  if (loop !== undefined) writeFileSync(join(dir, '.sterling', 'transient', 'pr-loop.json'), typeof loop === 'string' ? loop : JSON.stringify(loop));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a work project with an owed loop returns its state and nothing degraded', () => {
  const p = project('work', STATE);
  try {
    assert.deepEqual(duty.evaluatePrLoop(p.dir), { state: STATE, degraded: null });
  } finally {
    p.cleanup();
  }
});

test('hobby, mode-less, unarmed and settled projects owe nothing', () => {
  for (const [mode, loop] of [
    ['hobby', STATE],
    [undefined, STATE],
    ['work', undefined],
    ['work', { ...STATE, status: 'clean', settled_at: '2026-09-26T11:00:00.000Z' }],
  ]) {
    const p = project(mode, loop);
    try {
      assert.deepEqual(duty.evaluatePrLoop(p.dir), { state: null, degraded: null }, `${mode} ${loop?.status}`);
    } finally {
      p.cleanup();
    }
  }
});

test('an unreadable pr-loop.json in a work project is disclosed, never read as settled', () => {
  const p = project('work', '{not json');
  try {
    const r = duty.evaluatePrLoop(p.dir);
    assert.equal(r.state, null);
    assert.match(r.degraded, /PR review loop: \.sterling\/transient\/pr-loop\.json is unreadable .*UNKNOWN/);
  } finally {
    p.cleanup();
  }
});

test('an unreadable mode with an armed loop present is disclosed; without the file it is silent', () => {
  const p = project('nonsense', STATE);
  const q = project('nonsense');
  try {
    const r = duty.evaluatePrLoop(p.dir);
    assert.equal(r.state, null);
    assert.match(r.degraded, /project mode is unreadable .*state was not evaluated/);
    assert.deepEqual(duty.evaluatePrLoop(q.dir), { state: null, degraded: null });
  } finally {
    p.cleanup();
    q.cleanup();
  }
});

test('the next-action text names the wait script, the PR and the settle command', () => {
  const next = duty.prLoopNext(STATE, '/opt/sterling/bin/pr-review-wait.mjs');
  assert.match(next, /pr-review-loop skill: wait with node "\/opt\/sterling\/bin\/pr-review-wait\.mjs" https:\/\/github\.com\/acme\/widget\/pull\/7 \(background\)/);
  assert.match(next, /--settle <clean\|capped\|escalated> --pr 7/);
  const full = duty.prLoopOwedText(STATE, next);
  assert.match(full, /^• PR review loop owed \(work mode\): PR #7 .* \(head aaaaaaa, armed 2026-09-26T10:00:00\.000Z\) — run the pr-review-loop skill/);
  assert.match(duty.prLoopReminderText(STATE), /^PR review loop owed: PR #7 https:\/\/github\.com\/acme\/widget\/pull\/7 — next: pr-review-loop skill, then --settle clean\|capped\|escalated --pr 7\.$/);
});
