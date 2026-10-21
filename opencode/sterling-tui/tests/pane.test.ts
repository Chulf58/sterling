import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reopenPane, projectRootOf, type ExecFn, type PaneDeps } from '../pane.ts';

const ROOT = '/work/proj';
const SCRIPT = `${ROOT}/sterling-launch.sh`;

interface Call {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

function deps(over: Partial<PaneDeps> = {}, calls: Call[] = []): PaneDeps {
  const exec: ExecFn = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: 'TUI pane added to session s\n', stderr: '' };
  };
  return { env: { TMUX: '/tmp/tmux-1/default,1,0' }, exists: (p) => p === SCRIPT, exec, ...over };
}

test('pane: outside tmux it warns and runs nothing', async () => {
  const calls: Call[] = [];
  const toast = await reopenPane(ROOT, deps({ env: {} }, calls));
  assert.equal(toast.variant, 'warning');
  assert.match(toast.message, /not inside tmux/i);
  assert.equal(calls.length, 0);
});

test('pane: a missing launcher script warns to run /sterling:init and runs nothing', async () => {
  const calls: Call[] = [];
  const toast = await reopenPane(ROOT, deps({ exists: () => false }, calls));
  assert.equal(toast.variant, 'warning');
  assert.match(toast.message, /sterling-launch\.sh/);
  assert.match(toast.message, /\/sterling:init/);
  assert.equal(calls.length, 0);
});

test('pane: success shows the launcher stdout, trimmed', async () => {
  const toast = await reopenPane(ROOT, deps());
  assert.equal(toast.variant, 'success');
  assert.equal(toast.message, 'TUI pane added to session s');
});

test('pane: success with empty stdout still says something', async () => {
  const toast = await reopenPane(ROOT, deps({ exec: async () => ({ stdout: '', stderr: '' }) }));
  assert.equal(toast.variant, 'success');
  assert.ok(toast.message.length > 0);
});

test('pane: failure shows the launcher stderr as an error', async () => {
  const exec: ExecFn = async () => {
    throw Object.assign(new Error('Command failed'), { stdout: '', stderr: 'no tmux session found for project\n' });
  };
  const toast = await reopenPane(ROOT, deps({ exec }));
  assert.equal(toast.variant, 'error');
  assert.equal(toast.message, 'no tmux session found for project');
});

test('pane: a failure with no output (spawn error, timeout) shows the error message', async () => {
  const exec: ExecFn = async () => {
    throw new Error('spawn bash ENOENT');
  };
  const toast = await reopenPane(ROOT, deps({ exec }));
  assert.equal(toast.variant, 'error');
  assert.equal(toast.message, 'spawn bash ENOENT');
});

test('pane: exec is bash with the exact argv [script, "tui"], run in the project root, with no shell', async () => {
  const calls: Call[] = [];
  await reopenPane(ROOT, deps({}, calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'bash');
  assert.deepEqual(calls[0].args, [SCRIPT, 'tui']);
  assert.equal(calls[0].options.cwd, ROOT);
  assert.equal(typeof calls[0].options.timeout, 'number');
  assert.ok(!('shell' in calls[0].options), 'no shell option');
});

test('projectRootOf: the directory above .sterling, else the fallback', () => {
  assert.equal(projectRootOf('/work/proj/.sterling/sterling.db', '/x'), '/work/proj');
  assert.equal(projectRootOf('/elsewhere/store.db', '/x'), '/x');
  assert.equal(projectRootOf(undefined, '/x'), '/x');
});
