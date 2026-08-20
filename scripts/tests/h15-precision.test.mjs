// H15 store-guard PRECISION — spec under test, NOT YET IMPLEMENTED (every test
// here must be RED against the current hook before the fix lands).
//
// Background (docs/feedback/sterling-plugin-retrospective-2026-08-19-1145.md):
// H15 today denies ANY shell command whose text contains ".sterling/" (or a
// bare ".sterling" token) ANYWHERE in the command line, regardless of whether
// the command actually reads or writes the store. That blocked a plain
// `git log --oneline -- .sterling/config.json` — a read-only command that
// merely NAMES a store path alongside unrelated, harmless work — denying the
// session's very first command.
//
// This file specifies the fix:
//  AC1 — a read-only command that merely NAMES a (non-db) store path is
//        ALLOWED. Read access is not an out-of-band write.
//  AC2 — direct write/mutation commands against the store stay DENIED exactly
//        as today (rm, redirection, sqlite3 UPDATE, sed -i, mv/cp INTO the
//        store).
//  AC3 — compound commands: allowed when NO fragment writes (even if a
//        benign fragment mentions the store); denied — naming the specific
//        writing fragment — when any fragment writes.
//  AC4 — fail-closed regression: an unparseable config still denies, even for
//        a read, because the gate cannot safely evaluate the read/write split
//        without it.
//  AC5 — .sterling/sterling.db itself is NEVER shell-readable-or-writable
//        regardless of verb (DB access is the MCP tool surface's job, never
//        raw shell); only non-db store files (config.json, transient/) gain
//        the new read-only allowance.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(command, cwd) {
  const input = {
    session_id: 's1',
    transcript_path: join(cwd, 't', 's1.jsonl'),
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  };
  const r = spawnSync(process.execPath, [join(HOOKS, 'h15-store-guard.mjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    // H1's clone-currency probe must never fire inside a hook unit test.
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h15p-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  // A REAL store db file, matching how every other hook test builds a project —
  // project-root resolution keys on .sterling/sterling.db actually existing.
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

// --------------------------- AC1: read-only mentions are allowed ---------------------------

test('AC1: `git log` naming a store path (not the db) is allowed — read access is not an out-of-band write', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('git log --oneline -- .sterling/config.json', dir);
    assert.equal(r.code, 0, 'read-only command merely naming a store path must pass');
  } finally {
    cleanup();
  }
});

test('AC1: `grep` reading a store path is allowed', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('grep -n backup_path .sterling/config.json', dir);
    assert.equal(r.code, 0, 'grep reading config.json must pass — it is not a write');
  } finally {
    cleanup();
  }
});

test('AC1: `ls` on the store directory is allowed', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('ls .sterling/', dir);
    assert.equal(r.code, 0, 'listing the store directory must pass');
  } finally {
    cleanup();
  }
});

// --------------------------- AC2: writes stay denied exactly as today ---------------------------

test('AC2: `rm` of the store db file stays denied', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('rm .sterling/sterling.db', dir);
    assert.equal(r.code, 2, 'deleting the store db is an out-of-band write and must be denied');
  } finally {
    cleanup();
  }
});

test('AC2: redirection into config.json stays denied', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('echo x > .sterling/config.json', dir);
    assert.equal(r.code, 2, 'shell redirection is a write regardless of the command name');
  } finally {
    cleanup();
  }
});

test('AC2: `sqlite3 ... UPDATE` against the store db stays denied', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('sqlite3 .sterling/sterling.db "UPDATE records SET version=1"', dir);
    assert.equal(r.code, 2, 'a direct SQL mutation against the store must be denied');
  } finally {
    cleanup();
  }
});

test('AC2: `sed -i` in-place edit of config.json stays denied', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('sed -i "s/foo/bar/" .sterling/config.json', dir);
    assert.equal(r.code, 2, 'in-place edit of the store config is a write and must be denied');
  } finally {
    cleanup();
  }
});

test('AC2: `mv` into the store directory stays denied', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('mv ./stray.txt .sterling/stray.txt', dir);
    assert.equal(r.code, 2, 'moving a file into the store is an out-of-band write and must be denied');
  } finally {
    cleanup();
  }
});

test('AC2: `cp` into the store directory stays denied', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('cp ./stray.txt .sterling/stray.txt', dir);
    assert.equal(r.code, 2, 'copying a file into the store is an out-of-band write and must be denied');
  } finally {
    cleanup();
  }
});

// --------------------------- AC3: compound commands ---------------------------

test('AC3: a compound command where only a benign fragment mentions the store is allowed when no fragment writes', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('git log --oneline && grep foo .sterling/config.json', dir);
    assert.equal(r.code, 0, 'neither fragment writes, so the compound command must pass');
  } finally {
    cleanup();
  }
});

test('AC3: the same shape of compound command with a writing fragment is denied, naming the writing fragment', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('git log --oneline && rm .sterling/sterling.db', dir);
    assert.equal(r.code, 2, 'a writing fragment anywhere in the compound command must still deny the whole command');
    assert.match(
      r.stderr,
      /rm \.sterling\/sterling\.db/,
      'the deny message names the SPECIFIC writing fragment, not just a generic whole-command notice'
    );
  } finally {
    cleanup();
  }
});

// --------------------------- AC4: fail-closed regression ---------------------------

test('AC4: unparseable config still fails closed (deny) even for a read-only command', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not json');
    const r = runHook('cat .sterling/config.json', dir);
    assert.equal(r.code, 2, 'the gate cannot safely tell read from write without a parseable config, so it fails closed');
    assert.match(r.stderr, /fails closed/, 'the fail-closed path keeps its own distinct message');
  } finally {
    cleanup();
  }
});

test('AC4: unparseable config still fails closed (deny) for a store-db command (regression pin)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not json');
    const r = runHook('sqlite3 .sterling/sterling.db ".tables"', dir);
    assert.equal(r.code, 2, 'unreadable config denies rather than voiding the gate (unchanged regression)');
    assert.match(r.stderr, /fails closed/);
  } finally {
    cleanup();
  }
});

// --------------------------- AC5: sterling.db is never shell-accessible ---------------------------

test('AC5: `cat` on the store db file itself stays denied even though it is a mere read', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('cat .sterling/sterling.db', dir);
    assert.equal(r.code, 2, 'the db file is never shell-readable regardless of verb — DB access is the MCP surface job');
  } finally {
    cleanup();
  }
});

test('AC5: `sqlite3` read-only query against the store db stays denied', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('sqlite3 .sterling/sterling.db "SELECT * FROM records"', dir);
    assert.equal(r.code, 2, 'even a read-only SQL query against the db file is denied — use knowledge_query instead');
  } finally {
    cleanup();
  }
});

test('AC5: `cat` on a non-db store file (config.json) is allowed once the precision fix lands', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('cat .sterling/config.json', dir);
    assert.equal(r.code, 0, 'config.json is a non-db store file and a mere read must pass');
  } finally {
    cleanup();
  }
});

test('AC5: `cat` on a file under .sterling/transient/ is allowed (non-db store file)', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), '[]');
    const r = runHook('cat .sterling/transient/touches.json', dir);
    assert.equal(r.code, 0, 'transient/ is a non-db store file and a mere read must pass');
  } finally {
    cleanup();
  }
});

// Caught live 2026-08-20, minutes after the fragment gate shipped: UNQUOTED
// newlines are fragment separators exactly like ';' — a multiline batch is
// judged per line, while newlines INSIDE a quoted argument never fracture it.
test('AC3: unquoted newlines split fragments — a multiline batch whose only store mention is prose inside a quoted git message is allowed', () => {
  const { dir, cleanup } = makeProject();
  try {
    const cmd = 'set -e\ngit add scripts/foo.mjs\ngit commit -q -m "feat: seal the db behind the\n.sterling MCP surface"';
    const r = runHook(cmd, dir);
    assert.equal(r.code, 0, 'each line judged on its own: set / git add / git commit, store mention only in quoted prose');
  } finally {
    cleanup();
  }
});

test('AC3: a multiline batch with a genuinely writing line is denied naming that line', () => {
  const { dir, cleanup } = makeProject();
  try {
    const cmd = 'git add scripts/foo.mjs\nrm .sterling/config.json\ngit status';
    const r = runHook(cmd, dir);
    assert.equal(r.code, 2, 'the writing line denies the batch');
    assert.match(r.stderr, /rm \.sterling\/config\.json/, 'the denial names the offending line, not the batch');
  } finally {
    cleanup();
  }
});
