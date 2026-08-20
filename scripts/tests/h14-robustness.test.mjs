// H14 allowlist match robustness (board 4c7b84d3) — SPEC ONLY, red-first.
//
// Feedback measured (background given to the test-writer, not re-derived from
// code): a debugger could not run the project's own declared toolchain because
// its cwd broke the literal prefix match; quoting variants of an allowed
// command were denied unpredictably ("same command, different quoting"); a
// read-only `git log` was denied to a debugger asking a legitimate history
// question. The fix is NORMALIZATION before matching, not a wider allowlist —
// AC4 exists precisely to pin that the deny surface is otherwise unchanged.
//
// Harness idiom mirrors scripts/tests/enforcement.test.mjs's H14 battery
// (makeProject/hookInput/bash closures, CONFIG shape, stderr regex
// conventions) and scripts/tests/hooks-full.test.mjs's subdirectory-cwd
// pattern ("hook cwd: a SUBDIRECTORY resolves to the project root").
//
// RED DISCIPLINE: every assertion below is a plain assert.equal/match on the
// hook's exit code or stderr text — these fire as clean assertion_fail results
// against TODAY's h14-bash-allowlist.mjs (none of AC1–AC3's normalization is
// implemented yet), never a crash. Per-test expected failure shapes are called
// out inline and repeated in the handoff.

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

function makeProject({ config = CONFIG } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h14r-'));
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

// `dir` is the project root (holds .sterling/); `cwd` is the process/hook cwd,
// which defaults to the project root but is overridden to a subdirectory for
// AC2. This split mirrors the hooks-full.test.mjs subdirectory-cwd idiom,
// where hookInput's cwd field and spawnSync's cwd option are both set to the
// simulated platform cwd, distinct from the project root the store lives in.
function bash(dir, command, cwd = dir, over = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h14-bash-allowlist.mjs')], {
    input: JSON.stringify(hookInput(cwd, { tool_name: 'Bash', tool_input: { command }, ...over })),
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// AC1 — quoting variants of an allowed command never change the verdict
// ---------------------------------------------------------------------------

test('H14 AC1: quoting an ARGUMENT of an allowed command must not change the verdict (double, single, and combined with a quoted executable)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const baseline = bash(dir, 'node --test scripts/tests/foo.test.mjs');
    assert.equal(baseline.code, 0, 'sanity: the unquoted allowed command matches today');

    // EXPECTED FAILURE SHAPE (today): these assert.equal(..., 0) calls fire
    // because the current matcher denies these quoted variants (the exact bug
    // reported: "same command, different quoting").
    const doubleQuoted = bash(dir, 'node --test "scripts/tests/foo.test.mjs"');
    assert.equal(doubleQuoted.code, 0, 'double-quoting the path argument must not change the verdict');

    const singleQuoted = bash(dir, "node --test 'scripts/tests/foo.test.mjs'");
    assert.equal(singleQuoted.code, 0, 'single-quoting the path argument must not change the verdict either');

    const bothQuoted = bash(dir, '"node" --test "scripts/tests/foo.test.mjs"');
    assert.equal(bothQuoted.code, 0, 'quoting BOTH the executable token and the path argument together must not change the verdict');
  } finally {
    cleanup();
  }
});

test('H14 AC1 boundary: a GENUINELY DIFFERENT command stays denied regardless of quoting — normalization, not a wider allowlist', () => {
  const { dir, cleanup } = makeProject();
  try {
    const differentUnquoted = bash(dir, 'node --build scripts/tests/foo.test.mjs');
    assert.equal(differentUnquoted.code, 2, 'sanity: a non-allowlisted prefix is denied unquoted today');

    // EXPECTED FAILURE SHAPE: this must stay 2 after the fix too — if a future
    // "fix" instead widens the allowlist or strips quotes indiscriminately,
    // this assertion is what catches it going to 0.
    const differentQuoted = bash(dir, 'node --build "scripts/tests/foo.test.mjs"');
    assert.equal(differentQuoted.code, 2, 'quoting the argument must not launder a genuinely different command past the allowlist');
    assert.match(differentQuoted.stderr, /not on the allowlist/, 'still denied by ordinary allowlist reasoning, not a crash');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC2 — cwd robustness: a subdirectory cwd must not break the literal prefix
// ---------------------------------------------------------------------------

test('H14 AC2: an allowed toolchain command with an explicit repo-relative path matches from a SUBDIRECTORY cwd (board 4c7b84d3)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const sub = join(dir, 'packages', 'deep', 'nested');
    mkdirSync(sub, { recursive: true });

    const fromRoot = bash(dir, 'node --test scripts/tests/foo.test.mjs', dir);
    assert.equal(fromRoot.code, 0, 'sanity: allowed from the project root cwd');

    // EXPECTED FAILURE SHAPE (today): this assert.equal(..., 0) fires — the
    // reported bug is that the SAME command, run with a subdirectory cwd, is
    // denied (the debugger-cannot-run-its-own-toolchain case).
    const fromSub = bash(dir, 'node --test scripts/tests/foo.test.mjs', sub);
    assert.equal(
      fromSub.code,
      0,
      'the SAME repo-relative command must match when the platform hands the hook a subdirectory cwd — a debugger running the declared toolchain from a subdirectory must not be denied for that reason alone'
    );
  } finally {
    cleanup();
  }
});

test('H14 AC2 boundary: cwd robustness is not a path-scope bypass — a path argument that escapes the repo via cwd-relative traversal stays denied', () => {
  const { dir, cleanup } = makeProject();
  try {
    const sub = join(dir, 'packages', 'deep', 'nested');
    mkdirSync(sub, { recursive: true });

    // Relative to `sub`, '../../../outside.mjs' resolves OUTSIDE the repo root
    // entirely. AC2 says the match must hold for a path that "resolves INSIDE
    // the repo" — the converse (escapes it) must stay denied regardless of cwd.
    const escaping = bash(dir, 'node --test ../../../outside.mjs', sub);
    assert.equal(escaping.code, 2, 'a path argument resolving outside the repo stays denied even from a subdirectory cwd');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC3 — read-only git verbs are allowed; mutating git stays denied
// ---------------------------------------------------------------------------

test('H14 AC3: read-only git verbs are allowed for agents (git log / show --stat / diff --name-only / branch --list)', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): each assert.equal(..., 0) fires because
    // every git invocation is currently denied outright ("not on the
    // allowlist") — the reported case is a debugger denied `git log` on a
    // legitimate history question.
    assert.equal(bash(dir, 'git log').code, 0, 'git log is read-only history access');
    assert.equal(bash(dir, 'git show abc123 --stat').code, 0, 'git show <sha> --stat is read-only');
    assert.equal(bash(dir, 'git diff --name-only').code, 0, 'git diff --name-only is read-only');
    assert.equal(bash(dir, 'git branch --list').code, 0, 'git branch --list is read-only');
  } finally {
    cleanup();
  }
});

test('H14 AC3 regression: mutating git verbs stay denied exactly as today', () => {
  const { dir, cleanup } = makeProject();
  try {
    for (const cmd of ['git commit -m "x"', 'git push', 'git checkout main', 'git rebase main', 'git reset --hard']) {
      const r = bash(dir, cmd);
      assert.equal(r.code, 2, `${cmd} must stay denied`);
      assert.match(r.stderr, /not on the allowlist/, `${cmd} denial still names the allowlist`);
    }
  } finally {
    cleanup();
  }
});

test('H14 AC3 boundary: the read-only allowance is VERB-SHAPED, not "git anything" — chaining, redirection, and lookalikes stay denied', () => {
  const { dir, cleanup } = makeProject();
  try {
    // an allowed read-only verb still cannot smuggle a chained mutation
    let r = bash(dir, 'git log && git push');
    assert.equal(r.code, 2, 'chaining onto an allowed git verb is denied same as any other allowed prefix');
    assert.match(r.stderr, /control operators/);

    // redirection on an allowed read-only verb is still a write vector
    r = bash(dir, 'git log > history.txt');
    assert.equal(r.code, 2, 'redirection on an allowed git verb is denied');
    assert.match(r.stderr, /redirection/);

    // word-boundary lookalike must not match
    r = bash(dir, 'git logger');
    assert.equal(r.code, 2, 'a lookalike verb (git logger, not git log) must not match');

    // a git verb NOT on the read-only list stays denied even though it starts
    // with "git " (e.g. git stash mutates the working tree)
    r = bash(dir, 'git stash');
    assert.equal(r.code, 2, 'git stash is neither the declared toolchain nor a listed read-only verb');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4 — regression: existing denials survive the robustness change
// ---------------------------------------------------------------------------

test('H14 AC4 regression: chaining/control-operators, redirection, find, arbitrary interpreters, and off-allowlist commands stay denied', () => {
  const { dir, cleanup } = makeProject();
  try {
    let r = bash(dir, 'node --test && git push');
    assert.equal(r.code, 2, 'chaining an allowed prefix into a second command is denied');
    assert.match(r.stderr, /control operators/);

    r = bash(dir, 'node --test > /tmp/evil.txt');
    assert.equal(r.code, 2, 'redirection on an allowed prefix is denied');
    assert.match(r.stderr, /redirection/);

    r = bash(dir, 'find . -name "*.ts"');
    assert.equal(r.code, 2, 'find stays denied (-exec/-delete execute)');
    assert.match(r.stderr, /read-only search/);

    r = bash(dir, 'node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"');
    assert.equal(r.code, 2, 'an arbitrary interpreter invocation (node -e) is not the declared "node --test" prefix and stays denied');

    r = bash(dir, 'git status');
    assert.equal(r.code, 2, 'a command off both the toolchain allowlist and the new read-only git verbs stays denied');
    assert.match(r.stderr, /not on the allowlist/);
    assert.match(r.stderr, /node --test/, 'the allowlist is still named in the denial');
  } finally {
    cleanup();
  }
});
