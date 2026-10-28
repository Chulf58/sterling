import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { readMultiSession, multiSessionRefusal } from '../lib/multi-session.mjs';

const lib = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'multi-session.mjs');

function project(config) {
  const root = mkdtempSync(join(tmpdir(), 'multi-session-'));
  if (config !== undefined) {
    mkdirSync(join(root, '.sterling'));
    writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify(config));
  }
  return root;
}

function runRequire(root) {
  const env = { ...process.env };
  delete env.OPENCODE;
  delete env.OPENCODE_SESSION_ID;
  const code = `import(${JSON.stringify(lib)}).then(m => { const s = m.requireMultiSession(${JSON.stringify(root)}, 'launch a session'); console.log(JSON.stringify(s)); });`;
  return spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
}

test('absent config file and absent key both read as off (default), never an error', () => {
  const none = project();
  const noKey = project({ mode: 'hobby' });
  try {
    assert.deepEqual(readMultiSession(none), { enabled: false, max_sessions: 1, source: 'default' });
    assert.deepEqual(readMultiSession(noKey), { enabled: false, max_sessions: 1, source: 'default' });
  } finally {
    rmSync(none, { recursive: true });
    rmSync(noKey, { recursive: true });
  }
});

test('enabled true with max_sessions 3 reads from config; max_sessions defaults to 1', () => {
  const a = project({ multi_session: { enabled: true, max_sessions: 3 } });
  const b = project({ multi_session: { enabled: true } });
  try {
    assert.deepEqual(readMultiSession(a), { enabled: true, max_sessions: 3, source: 'config' });
    assert.deepEqual(readMultiSession(b), { enabled: true, max_sessions: 1, source: 'config' });
  } finally {
    rmSync(a, { recursive: true });
    rmSync(b, { recursive: true });
  }
});

test('a present but malformed key throws loudly', () => {
  for (const bad of [{ max_sessions: 0 }, { max_sessions: 2.5 }, { enabled: 'yes' }]) {
    const root = project({ multi_session: bad });
    try {
      assert.throws(() => readMultiSession(root), /multi_session\./);
    } finally {
      rmSync(root, { recursive: true });
    }
  }
});

test('refusal message names the key and how to set it', () => {
  const msg = multiSessionRefusal('launch a session');
  assert.match(msg, /multi_session\.enabled/);
  assert.doesNotMatch(msg, /System tab/);
  assert.match(msg, /\.sterling\/config\.json/);
  assert.match(msg, /config_set/);
});

test('requireMultiSession exits 2 with the refusal when off, and returns settings when on', () => {
  const off = project();
  const on = project({ multi_session: { enabled: true, max_sessions: 3 } });
  try {
    const refused = runRequire(off);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /multi_session\.enabled/);
    const ok = runRequire(on);
    assert.equal(ok.status, 0);
    assert.deepEqual(JSON.parse(ok.stdout), { enabled: true, max_sessions: 3, source: 'config' });
  } finally {
    rmSync(off, { recursive: true });
    rmSync(on, { recursive: true });
  }
});

test('a config whose root is not a plain JSON object throws, never reads as default off', () => {
  for (const bad of [null, false, true, 0, 5, '', 'x', []]) {
    const root = project(bad);
    try {
      assert.throws(() => readMultiSession(root), /not a JSON object/, JSON.stringify(bad));
    } finally {
      rmSync(root, { recursive: true });
    }
  }
});

test('a multi_session value of the wrong type throws via the schema', () => {
  for (const bad of [null, false, 'on', []]) {
    const root = project({ multi_session: bad });
    try {
      assert.throws(() => readMultiSession(root), /multi_session/, JSON.stringify(bad));
    } finally {
      rmSync(root, { recursive: true });
    }
  }
});

function linkedWorktree(mainConfig, worktreeConfig) {
  const base = mkdtempSync(join(tmpdir(), 'multi-session-wt-'));
  const main = join(base, 'main');
  const wt = join(base, 'wt');
  mkdirSync(main);
  const git = (...args) => execFileSync('git', args, { cwd: main, stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', wt);
  for (const [dir, cfg] of [[main, mainConfig], [wt, worktreeConfig]]) {
    if (cfg === undefined) continue;
    mkdirSync(join(dir, '.sterling'));
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(cfg));
  }
  return { base, main, wt };
}

test('a linked worktree without its own config reads the main checkout config', () => {
  const { base, wt } = linkedWorktree({ multi_session: { enabled: true, max_sessions: 3 } });
  try {
    assert.deepEqual(readMultiSession(wt), { enabled: true, max_sessions: 3, source: 'config' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the main checkout config wins over a worktree copy; a worktree-only config is used when main has none', () => {
  const both = linkedWorktree({ multi_session: { enabled: true, max_sessions: 2 } }, { multi_session: { enabled: false } });
  const only = linkedWorktree(undefined, { multi_session: { enabled: true, max_sessions: 4 } });
  try {
    assert.deepEqual(readMultiSession(both.wt), { enabled: true, max_sessions: 2, source: 'config' });
    assert.deepEqual(readMultiSession(only.wt), { enabled: true, max_sessions: 4, source: 'config' });
  } finally {
    rmSync(both.base, { recursive: true, force: true });
    rmSync(only.base, { recursive: true, force: true });
  }
});
