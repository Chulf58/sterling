// The 'PR review loop owed' duty rule H10 and the OpenCode plugin share
// (scripts/hooks/lib/pr-loop-duty.mjs): whether the loop is owed, what a state
// that cannot be evaluated says, and the exact next-action text. The H10 hook
// behavior around it stays pinned by h10-pr-review-loop.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

// GitHub issue #100: on OpenCode the notice said "(background)", which reads as
// "detach the wait" there, against the skill's OpenCode wait bullet.
test('issue #100: the OpenCode next-action text says to start the wait with the shell tool\'s background: true (which notifies), names --request-copilot and forbids nohup/&; Claude Code keeps (background)', () => {
  const oc = duty.prLoopNext(STATE, '/opt/sterling/bin/pr-review-wait.mjs', { host: 'opencode' });
  assert.match(oc, /wait with node "\/opt\/sterling\/bin\/pr-review-wait\.mjs" https:\/\/github\.com\/acme\/widget\/pull\/7 \(add --request-copilot on the first wait after a push\) started with the shell tool's background: true, which notifies you when it ends; never detach it with nohup or &/);
  assert.doesNotMatch(oc, /\(background\)/, 'never the bare (background) that read as "detach it"');
  assert.match(oc, /--settle <clean\|capped\|escalated> --pr 7/);
  assert.match(duty.prLoopNext(STATE, '/x/pr-review-wait.mjs'), /\(background\)/);
});

// GitHub issue #104: one armed loop per PR. Arming PR 8 used to overwrite
// PR 7's loop, so settling PR 7 then refused ("the armed loop is for PR #8").
const work = await import(pathToFileURL(join(root, 'scripts', 'lib', 'work-pr.mjs')).href);
const ORIGIN = 'github.com/acme/widget';
const armArgs = (n, head = 'a'.repeat(40)) => ({ pr_url: `https://github.com/acme/widget/pull/${n}`, pr_number: n, repo: ORIGIN, head_sha: head });

test('issue #104: arming a second PR keeps the first PR\'s owed loop; each settles on its own and the duty lists every owed PR', () => {
  const p = project('work');
  try {
    work.armPrLoop(p.dir, { ...armArgs(7), now: '2026-10-01T10:00:00.000Z' });
    work.armPrLoop(p.dir, { ...armArgs(8), now: '2026-10-01T11:00:00.000Z' });
    work.armPrLoop(p.dir, { ...armArgs(9), now: '2026-10-01T12:00:00.000Z' });
    assert.deepEqual(duty.evaluatePrLoops(p.dir).states.map((s) => s.pr_number), [7, 8, 9]);
    assert.equal(duty.evaluatePrLoop(p.dir).state.pr_number, 7, 'the single-loop view is the oldest owed loop');
    const s9 = work.settlePrLoop(p.dir, 'clean', '9', { originRepo: ORIGIN, now: '2026-10-01T13:00:00.000Z' });
    assert.equal(s9.status, 'clean');
    const s7 = work.settlePrLoop(p.dir, 'capped', 'https://github.com/acme/widget/pull/7', { originRepo: ORIGIN, now: '2026-10-01T13:00:00.000Z' });
    assert.equal(s7.status, 'capped');
    assert.deepEqual(duty.evaluatePrLoops(p.dir).states.map((s) => s.pr_number), [8]);
    assert.equal(work.readPrLoop(p.dir, 9).status, 'clean');
    assert.equal(work.readPrLoop(p.dir, 8).status, 'owed');
    assert.throws(() => work.settlePrLoop(p.dir, 'clean', '10', { originRepo: ORIGIN }), /no PR review loop is armed for 10; the armed loops are for PR #7 .*PR #8 .*PR #9/s);
    work.armPrLoop(p.dir, { ...armArgs(7, 'b'.repeat(40)), now: '2026-10-01T14:00:00.000Z' });
    assert.deepEqual(duty.evaluatePrLoops(p.dir).states.map((s) => [s.pr_number, s.head_sha[0]]), [[8, 'a'], [7, 'b']], 're-arming PR 7 replaces only its own loop');
  } finally {
    p.cleanup();
  }
});

test('issue #104: a legacy single-loop pr-loop.json is read and settled in place; the next arm of ANOTHER PR moves it to its per-PR file and deletes it', () => {
  const p = project('work', STATE);
  const legacy = join(p.dir, '.sterling', 'transient', 'pr-loop.json');
  try {
    assert.deepEqual(duty.evaluatePrLoop(p.dir), { state: STATE, degraded: null });
    work.armPrLoop(p.dir, { ...armArgs(8), now: '2026-10-01T11:00:00.000Z' });
    assert.equal(existsSync(legacy), false, 'the legacy file is gone after the arm');
    assert.deepEqual(work.readPrLoop(p.dir, 7), STATE, 'PR 7\'s loop moved to its per-PR file unchanged');
    assert.deepEqual(duty.evaluatePrLoops(p.dir).states.map((s) => s.pr_number), [7, 8]);
  } finally {
    p.cleanup();
  }
  const q = project('work', STATE);
  try {
    const settled = work.settlePrLoop(q.dir, 'escalated', '7', { originRepo: ORIGIN, now: '2026-10-01T12:00:00.000Z' });
    assert.equal(JSON.parse(readFileSync(join(q.dir, '.sterling', 'transient', 'pr-loop.json'), 'utf8')).status, 'escalated', 'settled in the legacy file');
    assert.equal(settled.status, 'escalated');
    work.armPrLoop(q.dir, { ...armArgs(7, 'b'.repeat(40)), now: '2026-10-01T13:00:00.000Z' });
    assert.equal(existsSync(join(q.dir, '.sterling', 'transient', 'pr-loop.json')), false);
    assert.deepEqual(work.readPrLoops(q.dir).map((s) => [s.pr_number, s.status]), [[7, 'owed']], 're-arming the legacy PR supersedes it');
  } finally {
    q.cleanup();
  }
});

test('issue #104: an unreadable per-PR file is disclosed by name, and an unreadable legacy file survives an arm so it stays disclosed', () => {
  const p = project('work', '{broken');
  try {
    work.armPrLoop(p.dir, { ...armArgs(8), now: '2026-10-01T11:00:00.000Z' });
    assert.match(duty.evaluatePrLoops(p.dir).degraded, /\.sterling\/transient\/pr-loop\.json is unreadable .*UNKNOWN/);
  } finally {
    p.cleanup();
  }
  const q = project('work');
  try {
    mkdirSync(join(q.dir, '.sterling', 'transient', 'pr-loops'), { recursive: true });
    writeFileSync(join(q.dir, '.sterling', 'transient', 'pr-loops', '7.json'), JSON.stringify({ ...STATE, pr_number: 8 }));
    assert.match(duty.evaluatePrLoops(q.dir).degraded, /pr-loops\/7\.json is unreadable .*holds the loop of PR #8/);
  } finally {
    q.cleanup();
  }
});

// Sol review (HIGH) on #104: migrating the legacy loop of PR 7 while PR 8 is
// armed must never overwrite a concurrent re-arm of PR 7 that lands between
// reading the legacy file and publishing it. The seam re-arms PR 7 there.
test('issue #104: a re-arm of the legacy PR that lands mid-migration is never overwritten by the old settled state', () => {
  const settled = { ...STATE, status: 'clean', settled_at: '2026-09-27T10:00:00.000Z' };
  const p = project('work', settled);
  try {
    let fresh;
    work.armPrLoop(p.dir, {
      ...armArgs(8),
      now: '2026-10-01T11:00:00.000Z',
      beforeLegacyPublish: () => {
        fresh = work.armPrLoop(p.dir, { ...armArgs(7, 'c'.repeat(40)), now: '2026-10-01T11:00:01.000Z' });
      },
    });
    assert.deepEqual(work.readPrLoop(p.dir, 7), fresh, 'PR 7 keeps the concurrent owed arm, not the legacy settled state');
    assert.equal(existsSync(join(p.dir, '.sterling', 'transient', 'pr-loop.json')), false, 'the legacy copy is dropped');
    assert.deepEqual(duty.evaluatePrLoops(p.dir).states.map((s) => s.pr_number), [8, 7]);
    const left = readdirSync(join(p.dir, '.sterling', 'transient', 'pr-loops')).sort();
    assert.deepEqual(left, ['7.json', '8.json'], 'no temp file is left behind');
  } finally {
    p.cleanup();
  }
});

// Sol review (MEDIUM) on #104: settling one PR reads only that PR's state.
test('issue #104: a malformed loop file of ANOTHER PR never blocks settling or reading this PR; it is named when this PR has no loop', () => {
  const p = project('work');
  try {
    work.armPrLoop(p.dir, { ...armArgs(7), now: '2026-10-01T10:00:00.000Z' });
    writeFileSync(join(p.dir, '.sterling', 'transient', 'pr-loops', '8.json'), '{broken');
    assert.equal(work.readPrLoop(p.dir, 7).status, 'owed');
    assert.equal(work.settlePrLoop(p.dir, 'capped', '7', { originRepo: ORIGIN, now: '2026-10-01T12:00:00.000Z' }).status, 'capped');
    assert.equal(work.readPrLoop(p.dir, 7).status, 'capped');
    assert.throws(() => work.settlePrLoop(p.dir, 'clean', '9', { originRepo: ORIGIN }), /no PR review loop is armed for 9; .*PR #7 .*pr-loops\/8\.json \(unreadable: .*not valid JSON/s);
    assert.throws(() => work.settlePrLoop(p.dir, 'clean', '8', { originRepo: ORIGIN }), /pr-loops\/8\.json is not valid JSON/, 'the named PR\'s own malformed file still refuses');
    assert.match(duty.evaluatePrLoops(p.dir).degraded, /pr-loops\/8\.json is unreadable/, 'the duty still discloses it');
  } finally {
    p.cleanup();
  }
});
