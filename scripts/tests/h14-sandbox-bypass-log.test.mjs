// H14 dangerouslyDisableSandbox DISCLOSURE + REGISTER (board
// f46f09a2-198f-4697-bb27-dd838de9d544) — SPEC ONLY, red-first.
// scripts/hooks/h14-bash-allowlist.mjs DOES NOT YET disclose or log this
// signal (confirmed via Grep before writing this file: the board item cites
// a self-reported bypass "which no mechanism prevented" — the fix does not
// exist under scripts/hooks yet).
//
// Spec under test (board f46f09a2, verbatim fix shape): a Bash PreToolUse
// payload carrying tool_input.dangerouslyDisableSandbox === true gets (1) a
// LOUD, session-visible disclosure naming the command head, and (2) an
// appended register entry shaped {at, command_head, cwd} under
// .sterling/transient/ — NEVER a denial on this signal alone, and FAIL-OPEN:
// a corrupt pre-existing register must not turn into a nonzero exit.
//
// Harness idiom mirrors scripts/tests/h14-robustness.test.mjs exactly
// (makeProject/hookInput/bash closures, CONFIG shape, stdin-JSON PreToolUse
// invocation) — read in full for convention, never imported, never modified.
// Written BLIND to scripts/hooks/h14-bash-allowlist.mjs internals (H4 read
// wall; a fixer is landing this in a parallel lane).
//
// FILE-NAME SEAM: the board item names the directory (.sterling/transient/)
// and the entry shape, but not the register's filename. Rather than guess and
// risk pinning a name the implementation never uses (which would make the
// corrupt-register pin silently vacuous — corrupting the WRONG file tests
// nothing), pins (a)-(c) below scan .sterling/transient/ generically for any
// JSON file holding {command_head, ...}-shaped entries — no filename is
// hardcoded. Pin (d) additionally needs to corrupt the SAME file the
// hook will read, so it first DISCOVERS the real filename via one live
// (pre-)invocation in a throwaway project, then reuses that exact name to
// pre-seed corruption in the actual test's fixture — this is black-box
// behavior probing (spawn + filesystem listing), never a read of hook
// internals, so it does not cross H4.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const CONFIG = {
  toolchains: [
    {
      adapter: 'node',
      path_globs: ['**/*.mjs'],
      test_globs: ['**/*.test.mjs', 'scripts/tests/**'],
      run_commands: { test: 'node --test' },
    },
  ],
};

const ALLOWED_CMD = 'node --test scripts/tests/foo.test.mjs';

function makeProject({ config = CONFIG } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h14-sandbox-log-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

function hookInput(cwd, over = {}) {
  return {
    session_id: 's1',
    transcript_path: join(cwd, 'transcripts', 's1.jsonl'),
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    ...over,
  };
}

function bash(dir, command, { cwd = dir, disableSandbox = false } = {}) {
  const tool_input = disableSandbox ? { command, dangerouslyDisableSandbox: true } : { command };
  const r = spawnSync(process.execPath, [join(HOOKS, 'h14-bash-allowlist.mjs')], {
    input: JSON.stringify(hookInput(cwd, { tool_name: 'Bash', tool_input })),
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function combinedOutput(r) {
  return `${r.stdout}\n${r.stderr}`;
}

function transientDir(dir) {
  return join(dir, '.sterling', 'transient');
}

// Generic, filename-agnostic scan: returns every {command_head,...}-shaped
// entry found across all JSON files directly under .sterling/transient/.
// Tolerates a top-level array OR a `{ entries: [...] }` wrapper, and never
// throws on an unrelated or corrupt JSON file — those are simply skipped.
function listRegisterEntries(dir) {
  const tdir = transientDir(dir);
  if (!existsSync(tdir)) return [];
  const files = readdirSync(tdir).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(tdir, f), 'utf8'));
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : null;
      if (!arr) continue;
      for (const e of arr) {
        if (e && typeof e === 'object' && 'command_head' in e) out.push(e);
      }
    } catch {
      // not a (parseable) register file — ignore for discovery/assertion
    }
  }
  return out;
}

// Returns the basename of the first JSON file under .sterling/transient/ that
// holds at least one {command_head,...}-shaped entry, or null if none is
// found (e.g. today, pre-implementation).
function discoverRegisterFilename(dir) {
  const tdir = transientDir(dir);
  if (!existsSync(tdir)) return null;
  const files = readdirSync(tdir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(tdir, f), 'utf8'));
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : null;
      if (arr?.some((e) => e && typeof e === 'object' && 'command_head' in e)) return f;
    } catch {
      // skip
    }
  }
  return files[0] ?? null;
}

// ---------------------------------------------------------------------------
// (a) CONTROL — same command WITHOUT the flag: no disclosure, no register
// entry. Placed first: (b)/(c)/(d) below must each be shown to differ from
// this baseline for the RIGHT reason (the flag's presence), not merely
// because something unconditional fired.
// ---------------------------------------------------------------------------

test('H14 sandbox-bypass CONTROL: same command WITHOUT dangerouslyDisableSandbox — no disclosure line, no register entry', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = bash(dir, ALLOWED_CMD, { disableSandbox: false });
    assert.equal(r.code, 0, `sanity: the allowed command succeeds without the flag — stdout=${r.stdout} stderr=${r.stderr}`);

    // NAMED SABOTAGE: drop the `=== true` guard on
    // tool_input.dangerouslyDisableSandbox so the disclosure/log branch runs
    // on every Bash call regardless of the flag — flips both assertions below
    // red (a disclosure line appears, and/or a register entry is created,
    // when neither should exist).
    assert.doesNotMatch(combinedOutput(r), /sandbox/i, 'no sandbox-bypass disclosure appears when the flag is absent');
    assert.deepEqual(listRegisterEntries(dir), [], 'no register entry is created when the flag is absent');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (b) flag set: disclosure present AND register entry exists with the
// command head — never denies on this signal alone.
// ---------------------------------------------------------------------------

test('H14 sandbox-bypass: dangerouslyDisableSandbox === true — loud disclosure naming the command head, AND a register entry, AND no denial from this signal alone', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = bash(dir, ALLOWED_CMD, { disableSandbox: true });
    // EXPECTED FAILURE SHAPE (today): the disclosure/register mechanism does
    // not exist at all — this line is expected to fail red first only if
    // some OTHER, unrelated denial fires; more likely it passes trivially
    // today (the command is already allowlisted) while the two assertions
    // below are what actually fail red, since no disclosure/log branch exists
    // yet at all.
    assert.equal(r.code, 0, `an already-allowed command with the flag set must not be denied on the flag's presence alone — stdout=${r.stdout} stderr=${r.stderr}`);

    // NAMED SABOTAGE (disclosure): delete the loud stderr/stdout disclosure
    // print, leaving only the register write — flips this assertion red.
    assert.match(combinedOutput(r), /sandbox/i, 'a loud disclosure is emitted');
    assert.ok(
      combinedOutput(r).includes('node') && /--test/.test(combinedOutput(r)),
      'the disclosure names the command head (the command actually invoked is recognizable in the output)'
    );

    // NAMED SABOTAGE (register): delete the register-append call, leaving
    // only the console disclosure — flips this assertion red (no matching
    // entry found at all).
    const entries = listRegisterEntries(dir);
    assert.equal(entries.length, 1, 'exactly one register entry was appended');
    const [entry] = entries;
    assert.ok(typeof entry.command_head === 'string' && entry.command_head.length > 0, 'command_head is a non-empty string');
    assert.ok(ALLOWED_CMD.startsWith(entry.command_head), 'command_head is a prefix ("head") of the actual command');
    assert.ok(typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at)), 'at is a parseable timestamp');
    assert.equal(entry.cwd, dir, 'cwd records the invocation cwd');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c) flag set TWICE: two entries (append, not overwrite).
// ---------------------------------------------------------------------------

test('H14 sandbox-bypass: the flag set on two separate invocations appends TWO register entries — never overwrites', () => {
  const { dir, cleanup } = makeProject();
  try {
    const first = bash(dir, ALLOWED_CMD, { disableSandbox: true });
    assert.equal(first.code, 0, `first invocation must succeed — stdout=${first.stdout} stderr=${first.stderr}`);
    const second = bash(dir, 'node --test scripts/tests/bar.test.mjs', { disableSandbox: true });
    assert.equal(second.code, 0, `second invocation must succeed — stdout=${second.stdout} stderr=${second.stderr}`);

    // NAMED SABOTAGE: replace the append (read existing entries, push, write
    // back the whole array) with a bare overwrite — e.g. `writeFileSync(path,
    // JSON.stringify([newEntry]))` instead of appending to what was read —
    // flips this assertion red (entries.length collapses to 1).
    const entries = listRegisterEntries(dir);
    assert.equal(entries.length, 2, 'two invocations produce two register entries, not one overwritten entry');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (d) corrupt register JSON pre-seeded: exit 0, disclosure still emitted —
// fail-open. Also confirms the hook actually engaged with (and recovered)
// the register rather than trivially succeeding because it never reads it.
// ---------------------------------------------------------------------------

test('H14 sandbox-bypass FAIL-OPEN: a corrupt pre-existing register file never turns into a nonzero exit, and the disclosure still fires', () => {
  // Discover the real register filename via one live, throwaway invocation —
  // deliberately NOT a hardcoded guess (see file header). Today (pre-fix)
  // this discovers nothing (null), which is expected: the primary assertions
  // below are what pin the red state in that case.
  const discovery = makeProject();
  let registerFilename;
  try {
    bash(discovery.dir, ALLOWED_CMD, { disableSandbox: true });
    registerFilename = discoverRegisterFilename(discovery.dir);
  } finally {
    discovery.cleanup();
  }

  const { dir, cleanup } = makeProject();
  try {
    if (registerFilename) {
      mkdirSync(transientDir(dir), { recursive: true });
      writeFileSync(join(transientDir(dir), registerFilename), '{ not valid json at all');
    }

    const r = bash(dir, ALLOWED_CMD, { disableSandbox: true });
    // EXPECTED FAILURE SHAPE: today the mechanism does not exist, so this is
    // trivially green in isolation (the allowed command succeeds anyway);
    // once a naive implementation lands that reads the register with an
    // unguarded JSON.parse and lets a throw propagate, this is the assertion
    // that catches it going nonzero.
    // NAMED SABOTAGE: remove the try/catch fail-open wrapper around reading
    // the pre-existing register file — flips this exact assertion red (the
    // corrupt JSON.parse throws uncaught, nonzero exit).
    assert.equal(r.code, 0, `a corrupt pre-existing register must fail OPEN, never crash the hook — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(combinedOutput(r), /sandbox/i, 'the disclosure still fires even when the register is corrupt');

    // Control-style check folded into this test: a hook that never reads or
    // writes the register at all would ALSO exit 0 on corrupt content it
    // never opens — that would make the assertion above pass for the wrong
    // reason. This asserts real engagement: the hook recovered a usable
    // register and appended THIS run's entry despite the pre-existing
    // corruption.
    const entries = listRegisterEntries(dir);
    assert.ok(
      entries.some((e) => typeof e.command_head === 'string' && ALLOWED_CMD.startsWith(e.command_head)),
      'the hook recovered from the corrupt register and appended a fresh, valid entry for this invocation — proving fail-open engagement, not mere non-engagement'
    );
  } finally {
    cleanup();
  }
});
