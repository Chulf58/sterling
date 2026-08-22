// H15 store-guard — PRECISION HARDENING pins (board
// 6051f202-fafd-4ef8-8360-74fa0cd8153d; spec: decision 0b4d3c8c — reads on
// non-DB store files are ALLOWED; only writes/redirections/moves INTO
// .sterling/ are denied; the db itself is sealed for every verb regardless).
//
// SUPPLEMENTAL to scripts/tests/h15-precision.test.mjs (base spec — read in
// full, for harness conventions only; NOT modified, NOT imported, NOT
// duplicated-by-reference). This file's runHook()/CONFIG/makeProject() below
// are reproduced STANDALONE so this file runs independently, the same
// convention scripts/tests/commit-reviewed-hardening.test.mjs and
// scripts/tests/merge-review-receipts-hardening.test.mjs use relative to
// their own base specs.
//
// Written BLIND to scripts/hooks/h15-store-guard.mjs's internals (H4 read
// wall; also true by design here) — every expectation below comes from
// decision 0b4d3c8c and the launching agent's brief, not from the code.
//
// Two confirmed false-positive classes (MUST ALLOW — expect RED today):
//   FP-1 — a `git -C <path> <verb> ...` invocation where the range/diff
//          argument names a `sterling/*` branch: the substring ".sterling/"
//          appears in the range token (e.g. "main..sterling/session-guards"
//          contains ".sterling/" purely because of the ".." before the
//          branch name), and/or the `-C <path>` flag shifts the read-only
//          verb (log/diff) out of the position the gate expects it in. Either
//          way this is a READ-ONLY git invocation and must be allowed.
//   FP-2 — a store-path read whose ONLY redirection targets somewhere that is
//          NOT the store (/dev/null, or an arbitrary path outside .sterling/):
//          decision 0b4d3c8c denies redirections INTO .sterling/, not every
//          redirection that merely appears on the same line as a store path.
//
// Regression pins (MUST STILL DENY — expect GREEN today) guard against a fix
// for the above overshooting into allowing real writes.

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h15ph-'));
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

// =========================================================================
// MUST ALLOW — false-positive class FP-1: `git -C <path> <read-only-verb>`
// against a range/diff arg naming a `sterling/*` branch. No real git repo is
// built here: H15 is a text-matching gate (it never shells out to git — see
// h15-precision.test.mjs's own git tests, which pass bare command strings
// against a fixture dir that is never `git init`'d), so a plain command
// string against the fixture project root is the correct-shaped input.
// =========================================================================

test('MUST ALLOW (expect RED): `git -C <path> log --oneline` on a range naming a sterling/* branch is allowed — the range only NAMES a branch, it does not touch the store', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`git -C ${dir} log --oneline main..sterling/session-guards`, dir);
    assert.equal(
      r.code,
      0,
      'read-only `git -C <path> log` must pass even though the range token "main..sterling/session-guards" contains the substring ".sterling/" purely because of the branch name'
    );
  } finally {
    cleanup();
  }
});

test('MUST ALLOW (expect RED): the same range shape without -C — `git log --oneline main..sterling/foo` — is allowed', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('git log --oneline main..sterling/foo', dir);
    assert.equal(
      r.code,
      0,
      'read-only `git log` must pass on a range naming a sterling/* branch even without -C'
    );
  } finally {
    cleanup();
  }
});

test('MUST ALLOW (expect RED): `git -C <path> diff` on the same range shape is allowed — second read-only subverb behind -C', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`git -C ${dir} diff main..sterling/foo`, dir);
    assert.equal(
      r.code,
      0,
      'read-only `git -C <path> diff` must pass on a range naming a sterling/* branch — -C must not hide the read-only verb from the gate'
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// MUST ALLOW — false-positive class FP-2: a store-path read whose ONLY
// redirection targets somewhere that is NOT the store.
// =========================================================================

test('MUST ALLOW (expect RED): `ls <abs>/.sterling/transient/ 2>/dev/null` is allowed — the only redirection targets /dev/null, not the store', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    const r = runHook(`ls ${dir}/.sterling/transient/ 2>/dev/null`, dir);
    assert.equal(
      r.code,
      0,
      'listing a non-db store directory, with stderr redirected to /dev/null, must pass — /dev/null is not the store'
    );
  } finally {
    cleanup();
  }
});

test('MUST ALLOW (expect RED, if piped forms are in scope): `cat <abs>/.sterling/config.json 2>&1 | head -5` is allowed — a read piped through a pager, not redirected into the store', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`cat ${dir}/.sterling/config.json 2>&1 | head -5`, dir);
    assert.equal(
      r.code,
      0,
      'a piped read of a non-db store file must pass — the pipe never writes into .sterling/'
    );
  } finally {
    cleanup();
  }
});

test('MUST ALLOW (expect RED — contentious, pins the DECISION\'S LITERAL WORDING): `grep foo <abs>/.sterling/transient/rotation-note.json > /tmp/out.txt` is allowed — the redirection writes OUTSIDE .sterling/, and decision 0b4d3c8c denies redirections INTO the store, not every redirection that appears on a line naming a store path', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'rotation-note.json'), '{}');
    const r = runHook(`grep foo ${dir}/.sterling/transient/rotation-note.json > /tmp/out.txt`, dir);
    assert.equal(
      r.code,
      0,
      'reading a store file and redirecting the OUTPUT outside .sterling/ is a store READ, not a store write — the decision only denies redirections INTO the store'
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// MUST STILL DENY — regression pins guarding against the FP-1/FP-2 fix
// overshooting into allowing real writes. Expect GREEN today.
// =========================================================================

test('MUST STILL DENY (expect GREEN): `git -C <path> checkout -- .sterling/config.json` stays denied — a write subverb behind -C is still a write', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`git -C ${dir} checkout -- .sterling/config.json`, dir);
    assert.equal(
      r.code,
      2,
      'git checkout overwrites the working-tree file from another revision — -C must not launder a write subverb into an allow'
    );
    assert.match(r.stderr, /checkout/, 'the denial should identify the checkout subverb as the discriminator');
    assert.match(r.stderr, /\.sterling\/config\.json/, 'the denial should name the store path being overwritten');
  } finally {
    cleanup();
  }
});

test('MUST STILL DENY (expect GREEN): `echo x > <abs>/.sterling/config.json` stays denied — redirection INTO the store', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`echo x > ${dir}/.sterling/config.json`, dir);
    assert.equal(r.code, 2, 'shell redirection into a store file must be denied regardless of absolute-vs-relative path spelling');
  } finally {
    cleanup();
  }
});

test('MUST STILL DENY (expect GREEN): `cp foo <abs>/.sterling/bar.json` stays denied — copy INTO the store', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`cp foo ${dir}/.sterling/bar.json`, dir);
    assert.equal(r.code, 2, 'copying a file into the store is an out-of-band write and must be denied regardless of absolute path spelling');
  } finally {
    cleanup();
  }
});

test('MUST STILL DENY (expect GREEN): `sqlite3 <abs>/.sterling/sterling.db \'select 1\'` stays denied — the db is sealed for every verb, even a read-only SELECT', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`sqlite3 ${dir}/.sterling/sterling.db 'select 1'`, dir);
    assert.equal(r.code, 2, 'the db file is never shell-accessible regardless of verb, even with an absolute path and a read-only SELECT');
  } finally {
    cleanup();
  }
});

test('MUST STILL DENY (expect GREEN): `cat <abs>/.sterling/sterling.db` stays denied — the db is sealed for every verb, even a mere read', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`cat ${dir}/.sterling/sterling.db`, dir);
    assert.equal(r.code, 2, 'the db file is never shell-readable regardless of verb, even with an absolute path — DB access is the MCP surface job');
  } finally {
    cleanup();
  }
});
