// A server in a linked git worktree (board 4da6582b): the store, config and board
// are the project's (repoRoot), while board provenance HEAD and the session-event
// register are the worktree checkout's (checkoutRoot). A server given no
// checkoutRoot behaves exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const git = (cwd: string, args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-checkout-root-')));
  const main = join(base, 'main');
  mkdirSync(join(main, '.sterling'), { recursive: true });
  writeFileSync(join(main, '.sterling', 'config.json'), '{}');
  writeFileSync(join(main, '.gitignore'), '.sterling/\n');
  writeFileSync(join(main, 'a.txt'), 'a\n');
  git(main, ['init', '-q']);
  git(main, ['config', 'user.email', 't@example.com']);
  git(main, ['config', 'user.name', 't']);
  git(main, ['add', '-A']);
  git(main, ['commit', '-q', '-m', 'main']);
  const wt = join(base, 'wt');
  git(main, ['worktree', 'add', '-q', '-b', 'wt-branch', wt]);
  writeFileSync(join(wt, 'b.txt'), 'b\n');
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-q', '-m', 'worktree']);
  const store = new SterlingStore(join(main, '.sterling', 'sterling.db'));
  return { base, main, wt, store, cleanup: () => (store.close(), rmSync(base, { recursive: true, force: true })) };
}

test('in a linked worktree board_add stamps the worktree HEAD, the item lands in the shared store and session events go to the worktree', () => {
  const f = fixture();
  try {
    const tools = new SterlingTools({ store: f.store, repoRoot: f.main, checkoutRoot: f.wt });
    const added = tools.boardAdd({ text: 'worktree item', source: 'user' } as never);
    const stored = f.store.get(added.record.id) as unknown as { measured_at_head?: string };
    assert.equal(stored.measured_at_head, git(f.wt, ['rev-parse', 'HEAD']), 'provenance HEAD is the worktree checkout');
    assert.notEqual(stored.measured_at_head, git(f.main, ['rev-parse', 'HEAD']));
    tools.noCapture('nothing durable here');
    assert.ok(existsSync(join(f.wt, '.sterling', 'transient', 'session-events.json')), 'session events land in the worktree');
    assert.equal(existsSync(join(f.main, '.sterling', 'transient', 'session-events.json')), false, 'not in the main checkout');
  } finally {
    f.cleanup();
  }
});

test('without checkoutRoot the server stamps the project root HEAD and writes events there, as before', () => {
  const f = fixture();
  try {
    const tools = new SterlingTools({ store: f.store, repoRoot: f.main });
    const added = tools.boardAdd({ text: 'main item', source: 'user' } as never);
    const stored = f.store.get(added.record.id) as unknown as { measured_at_head?: string };
    assert.equal(stored.measured_at_head, git(f.main, ['rev-parse', 'HEAD']));
    tools.noCapture('nothing durable here');
    const events = JSON.parse(readFileSync(join(f.main, '.sterling', 'transient', 'session-events.json'), 'utf8'));
    assert.ok(Array.isArray(events.events ?? events), 'the register is written at the project root');
  } finally {
    f.cleanup();
  }
});
