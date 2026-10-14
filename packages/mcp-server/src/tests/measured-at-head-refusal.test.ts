/**
 * board_add / board_update refuse a caller-supplied measured_at_head and name
 * the real reason (decision board-provenance-measured-at-head: refuse, never
 * silently replace with HEAD).
 *
 *  - a value that is not a full 40-char lowercase hex SHA is refused for its
 *    SHAPE, even when it abbreviates a real commit (git would resolve it);
 *  - a well-shaped 40-hex value that is not a commit is refused as
 *    "does not resolve to a commit".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-10-14T12:00:00.000Z';

type Loose = Record<string, unknown>;

function addRaw(tools: SterlingTools, args: Loose): Loose {
  return tools.boardAdd(args as unknown as Parameters<SterlingTools['boardAdd']>[0]) as unknown as Loose;
}

function updateRaw(tools: SterlingTools, id: string, patch: Loose): Loose {
  return tools.boardUpdate(id, patch as unknown as Parameters<SterlingTools['boardUpdate']>[1]) as unknown as Loose;
}

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-measured-at-head-refusal-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const git = (...a: string[]): string => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { tools, headSha: git('rev-parse', 'HEAD'), cleanup };
}

const SHAPE = /full 40-character lowercase hex SHA is required/;
const RESOLVE = /does not resolve to a commit/;

for (const verb of ['board_add', 'board_update'] as const) {
  const attempt = (tools: SterlingTools, value: string): void => {
    if (verb === 'board_add') {
      addRaw(tools, { text: 'probe', source: 'user', measured_at_head: value });
    } else {
      const { record } = addRaw(tools, { text: 'seed', source: 'user' }) as unknown as { record: { id: string } };
      updateRaw(tools, record.id, { measured_at_head: value });
    }
  };

  test(`${verb}: a short SHA of a real commit is refused for its shape, naming the 40-character requirement`, () => {
    const { tools, headSha, cleanup } = gitFixture();
    try {
      const short = headSha.slice(0, 8);
      assert.throws(
        () => attempt(tools, short),
        (err: Error) => {
          assert.ok(err.message.startsWith(`${verb}:`), err.message);
          assert.ok(err.message.includes(short), 'names the offending value');
          assert.match(err.message, SHAPE);
          assert.doesNotMatch(err.message, RESOLVE, 'a real commit is not reported as unresolvable');
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  test(`${verb}: an uppercase 40-hex value is refused for its shape`, () => {
    const { tools, headSha, cleanup } = gitFixture();
    try {
      assert.throws(
        () => attempt(tools, headSha.toUpperCase()),
        (err: Error) => {
          assert.match(err.message, SHAPE);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  test(`${verb}: a well-shaped 40-hex value that is not a commit still gets "does not resolve to a commit"`, () => {
    const { tools, cleanup } = gitFixture();
    try {
      const fake = 'a'.repeat(40);
      assert.throws(
        () => attempt(tools, fake),
        (err: Error) => {
          assert.ok(err.message.startsWith(`${verb}:`), err.message);
          assert.ok(err.message.includes(fake), 'names the offending value');
          assert.match(err.message, RESOLVE);
          assert.doesNotMatch(err.message, SHAPE);
          return true;
        }
      );
    } finally {
      cleanup();
    }
  });

  test(`${verb}: the full SHA of a real commit is accepted`, () => {
    const { tools, headSha, cleanup } = gitFixture();
    try {
      assert.doesNotThrow(() => attempt(tools, headSha));
    } finally {
      cleanup();
    }
  });
}
