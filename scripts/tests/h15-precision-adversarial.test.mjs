// H15 store-guard — ADVERSARIAL pins for three regressions found by EXTERNAL
// REVIEW of the precision/hardening work (board 6051f202-fafd-4ef8-8360-
// 74fa0cd8153d follow-up; governing spec: decision 0b4d3c8c — reads on
// non-DB store files are ALLOWED; only writes/redirections/moves INTO
// .sterling/ are denied; the db itself is sealed for every verb regardless).
//
// SUPPLEMENTAL to scripts/tests/h15-precision.test.mjs and
// scripts/tests/h15-precision-hardening.test.mjs (both read in full, for
// harness conventions only; NEITHER modified, NEITHER imported, NEITHER
// duplicated-by-reference). This file's runHook()/CONFIG/makeProject() below
// are reproduced STANDALONE so this file runs independently, the same
// convention the hardening spec uses relative to its own base spec.
//
// Written BLIND to scripts/hooks/h15-store-guard.mjs's internals (H4 read
// wall; also true by design here) — every expectation below comes from
// decision 0b4d3c8c plus the launching agent's brief describing three
// regressions the recent flag-skip (skipping past -c/-C/--git-dir/--work-tree
// to find the subverb) and redirect-loosening (FP-2: redirects outside the
// store are allowed) changes introduced:
//
//   REGRESSION 1 — config-injection via a skipped `-c` VALUE: the flag-skip
//     logic that lets `git -c color.ui=false log` through skips past the -c
//     flag's VALUE without checking whether that value itself names a store
//     path. `git -c core.fsmonitor=.sterling/writer status` uses `status` (a
//     read-only subverb) to smuggle a store path into a git config value —
//     this is a config-injection gadget and must deny.
//
//   REGRESSION 2 — a skipped GLOBAL FLAG value pointing INTO the store: the
//     same flag-skip logic that lets `git -C <path> log ...` through when
//     <path> is benign must still catch it when the -C/--git-dir/--work-tree
//     VALUE points into .sterling/, even though the subverb behind it
//     (status/log) is read-only on its own.
//
//   REGRESSION 3 — the FP-2 redirect fix (allow an outward redirect whose
//     target is NOT the store) was implemented as a literal-text check, which
//     fails to recognize that a target built from command substitution, a
//     shell variable expansion, or quote-concatenation is NOT a statically-
//     parseable plain word at all — the gate cannot know where it points
//     without actually running the shell, so it must FAIL CLOSED (deny)
//     rather than default-allow just because the literal text does not
//     contain a recognizable ".sterling/" plain-word target.
//
// Regression pins (MUST STILL ALLOW / MUST STILL DENY) guard against a fix
// for the above overshooting into re-breaking the already-pinned FP-1/FP-2
// loosenings from the hardening spec.

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h15adv-'));
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
// REGRESSION 1 — MUST DENY: config-injection via a skipped `-c` VALUE.
// =========================================================================

test('ADV-1 (expect RED): `git -c core.fsmonitor=.sterling/writer status` is denied — the -c VALUE names a store path (config-injection gadget), even though `status` is a read-only subverb', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('git -c core.fsmonitor=.sterling/writer status', dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a -c value naming a store path — a crash is not a decision');
    assert.equal(
      r.code,
      2,
      'a skipped -c flag VALUE that itself names a store path must deny — the flag-skip logic must inspect the value, not just skip past it because the subverb (status) looks read-only'
    );
    assert.match(r.stderr, /\.sterling/, 'the denial should mention the store path carried in the -c value');
  } finally {
    cleanup();
  }
});

// =========================================================================
// REGRESSION 2 — MUST DENY: a skipped global-flag VALUE pointing INTO the
// store, even when the subverb behind it is read-only.
// =========================================================================

test('ADV-2a (expect RED): `git -C <abs>/.sterling status` is denied — the -C VALUE points INTO the store even though `status` is a read-only subverb', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`git -C ${dir}/.sterling status`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a -C value pointing into the store');
    assert.equal(
      r.code,
      2,
      'a skipped -C VALUE naming a path inside .sterling/ must deny regardless of how read-only the subverb behind it is'
    );
    assert.match(r.stderr, /\.sterling/, 'the denial should mention the store path carried in the -C value');
  } finally {
    cleanup();
  }
});

test('ADV-2b (expect RED): `git --git-dir=.sterling/repo log` is denied — the --git-dir VALUE points INTO the store even though `log` is a read-only subverb', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('git --git-dir=.sterling/repo log', dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a --git-dir value pointing into the store');
    assert.equal(
      r.code,
      2,
      'a skipped --git-dir VALUE naming a path inside .sterling/ must deny regardless of how read-only the subverb behind it is'
    );
    assert.match(r.stderr, /\.sterling/, 'the denial should mention the store path carried in the --git-dir value');
  } finally {
    cleanup();
  }
});

test('ADV-2c (expect RED): `git --work-tree=.sterling/x status` is denied — the --work-tree VALUE points INTO the store even though `status` is a read-only subverb', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('git --work-tree=.sterling/x status', dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a --work-tree value pointing into the store');
    assert.equal(
      r.code,
      2,
      'a skipped --work-tree VALUE naming a path inside .sterling/ must deny regardless of how read-only the subverb behind it is'
    );
    assert.match(r.stderr, /\.sterling/, 'the denial should mention the store path carried in the --work-tree value');
  } finally {
    cleanup();
  }
});

// =========================================================================
// REGRESSION 3 — MUST DENY: an outward redirect whose target is NOT one
// statically-parseable plain word FAILS CLOSED, rather than being
// default-allowed because the literal text does not contain a recognizable
// ".sterling/" plain-word target.
// =========================================================================

test('ADV-3a (expect RED): `cat /tmp/in > $(printf .sterling/config.json)` fails closed — the redirect target is a command substitution, not a statically-parseable plain word', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('cat /tmp/in > $(printf .sterling/config.json)', dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a command-substitution redirect target — a crash is not a decision');
    assert.equal(
      r.code,
      2,
      'the redirect target is built by a command substitution the gate cannot statically evaluate — it must fail closed (deny) rather than default-allow'
    );
  } finally {
    cleanup();
  }
});

test('ADV-3b (expect RED): `echo x > ${STORE_DIR}/.sterling/y` fails closed — the redirect target contains a shell variable expansion, not a plain word', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('echo x > ${STORE_DIR}/.sterling/y', dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a variable-expansion redirect target');
    assert.equal(
      r.code,
      2,
      'the redirect target contains an unresolved shell variable expansion — the gate cannot know where it points without running the shell, so it must fail closed (deny)'
    );
  } finally {
    cleanup();
  }
});

test('ADV-3c (expect RED): `echo x > `printf .sterling/z`` fails closed — the redirect target is a backtick command substitution, not a plain word', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('echo x > `printf .sterling/z`', dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a backtick command-substitution redirect target');
    assert.equal(
      r.code,
      2,
      'the redirect target is a backtick command substitution the gate cannot statically evaluate — it must fail closed (deny) rather than default-allow'
    );
  } finally {
    cleanup();
  }
});

test("ADV-3d (expect RED): `echo x > .st''erling/config.json` fails closed — a quote-concatenated store target must still deny", () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook("echo x > .st''erling/config.json", dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a quote-concatenated redirect target');
    assert.equal(
      r.code,
      2,
      'the redirect target is quote-concatenated (".st" + "" + "erling/config.json") rather than one plain word — it resolves into the store and must deny even though the literal text never contains the bare substring ".sterling/"'
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// REGRESSION PINS — MUST STILL ALLOW: the already-pinned FP-1/FP-2
// loosenings from the hardening spec must not be clawed back by the fixes
// for regressions 1-3 above.
// =========================================================================

test('REGRESSION PIN (expect GREEN): `git -C <path> log --oneline main..sterling/foo` stays allowed — benign -C value, read-only subverb, already pinned by the hardening spec', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`git -C ${dir} log --oneline main..sterling/foo`, dir);
    assert.equal(
      r.code,
      0,
      'a -C value that is just the project root (not a store path) must still pass, with a read-only subverb, after the config-injection/global-flag fixes'
    );
  } finally {
    cleanup();
  }
});

test('REGRESSION PIN (expect GREEN): `git -c color.ui=false log` stays allowed — benign -c value, read-only subverb', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('git -c color.ui=false log', dir);
    assert.equal(
      r.code,
      0,
      'a -c value that names an ordinary git config key (not a store path) must still pass after the config-injection fix'
    );
  } finally {
    cleanup();
  }
});

test('REGRESSION PIN (expect GREEN): `ls <abs>/.sterling/transient/ 2>/dev/null` stays allowed — read of a non-db store path, redirected to /dev/null', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    const r = runHook(`ls ${dir}/.sterling/transient/ 2>/dev/null`, dir);
    assert.equal(
      r.code,
      0,
      'listing a non-db store directory with stderr redirected to /dev/null must still pass after the redirect fail-closed fix'
    );
  } finally {
    cleanup();
  }
});

test('REGRESSION PIN (expect GREEN): `grep foo <abs>/.sterling/transient/rotation-note.json > /tmp/out.txt` stays allowed — plain-word outward redirect target', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'rotation-note.json'), '{}');
    const r = runHook(`grep foo ${dir}/.sterling/transient/rotation-note.json > /tmp/out.txt`, dir);
    assert.equal(
      r.code,
      0,
      'a redirect target that IS one statically-parseable plain word pointing outside the store must still pass — the fail-closed fix targets unparseable targets, not every outward redirect'
    );
  } finally {
    cleanup();
  }
});

test('REGRESSION PIN (expect GREEN): `echo x > <abs>/.sterling/config.json` stays denied — direct plain-word redirect into the store, unchanged', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`echo x > ${dir}/.sterling/config.json`, dir);
    assert.equal(
      r.code,
      2,
      'a plain-word redirect target that IS the store must stay denied regardless of the fail-closed fix for unparseable targets'
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// FOLLOW-UP: three MORE holes found by a verification review of the fixed
// H15, adjudicated must-close. Appended per the coordinator's direct
// instruction (existing 13 tests above left unchanged).
// =========================================================================

// --------------------------- ADV-4: `&` is a fragment separator ---------------------------
// A lone background `&` splits fragments exactly like `;`/`&&`/newline — the
// gate must not treat the whole line as one fragment keyed off the first
// word (`ls`, read-only) while a later `&`-separated fragment writes.

test('ADV-4a (expect RED): `ls /tmp/x & rm -rf <abs>/.sterling` is denied — a lone `&` separates fragments and the second fragment writes the store', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`ls /tmp/x & rm -rf ${dir}/.sterling`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a `&`-separated command line');
    assert.equal(
      r.code,
      2,
      'today the whole line is judged as one fragment whose first word `ls` reads as read-only-allowed; a lone `&` must be recognized as a fragment separator so the `rm -rf .sterling` fragment is caught and denied'
    );
    assert.match(r.stderr, /\.sterling/, 'the denial should mention the store path in the offending backgrounded fragment');
  } finally {
    cleanup();
  }
});

test('ADV-4b (expect GREEN, non-regression): `echo hi & ls /tmp` stays allowed — a `&`-separated command line with no store mention anywhere', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('echo hi & ls /tmp', dir);
    assert.equal(
      r.code,
      0,
      'neither `&`-separated fragment mentions the store, so recognizing `&` as a separator must not turn this into a false deny'
    );
  } finally {
    cleanup();
  }
});

test('ADV-4c (expect GREEN, non-regression): `ls <abs>/.sterling/transient/ && echo ok` keeps today\'s behavior — `&&` chains stay allowed when no fragment writes', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    const r = runHook(`ls ${dir}/.sterling/transient/ && echo ok`, dir);
    assert.equal(
      r.code,
      0,
      'an `&&`-chained read of a non-db store path followed by a benign fragment must still pass after the `&` fragment-separator fix'
    );
  } finally {
    cleanup();
  }
});

// --------------------------- ADV-5: `sed` long-form in-place flag ---------------------------
// The existing `-i` short-form in-place detector misses `--in-place` and
// `--in-place=SUFFIX` (GNU sed long forms) — both mutate the target file
// exactly like `-i` and must deny on a store path.

test('ADV-5a (expect RED): `sed --in-place s/a/b/ <abs>/.sterling/config.json` is denied — the long-form in-place flag mutates the store file, same as `-i`', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`sed --in-place s/a/b/ ${dir}/.sterling/config.json`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on the long-form --in-place flag');
    assert.equal(
      r.code,
      2,
      'the short-form `-i` detector misses `--in-place`, which mutates the file in place exactly like `-i`, and must deny on a store path'
    );
    assert.match(r.stderr, /\.sterling\/config\.json/, 'the denial should name the store file being mutated in place');
  } finally {
    cleanup();
  }
});

test('ADV-5b (expect RED): `sed --in-place=.bak s/a/b/ <abs>/.sterling/config.json` is denied — the long-form in-place flag with a backup suffix also mutates the store file', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`sed --in-place=.bak s/a/b/ ${dir}/.sterling/config.json`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on the long-form --in-place=SUFFIX flag');
    assert.equal(
      r.code,
      2,
      'the short-form `-i` detector misses `--in-place=SUFFIX`, which mutates the file in place (keeping a backup) exactly like `-i`, and must deny on a store path'
    );
    assert.match(r.stderr, /\.sterling\/config\.json/, 'the denial should name the store file being mutated in place');
  } finally {
    cleanup();
  }
});

// Non-regression: the base spec (h15-precision.test.mjs) and the hardening
// spec (h15-precision-hardening.test.mjs) pin `sed -i` as denied but pin no
// case of a plain `sed` read (no in-place flag) against a store path — so
// this is unpinned territory. Per decision 0b4d3c8c (reads on non-db store
// files are allowed), a plain `sed` with no in-place flag only writes its
// result to stdout and must be allowed, matching every other read-only
// command already pinned (cat/grep/ls) against a non-db store file.
test('ADV-5c (expect GREEN per decision 0b4d3c8c, unpinned elsewhere): `sed s/a/b/ <abs>/.sterling/config.json` (no in-place flag) is allowed — output goes to stdout only, a read, not a write', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`sed s/a/b/ ${dir}/.sterling/config.json`, dir);
    assert.equal(
      r.code,
      0,
      'a `sed` invocation with no in-place flag only prints to stdout — it is a read of a non-db store file and must be allowed per decision 0b4d3c8c, matching the long-form in-place fix that must not overshoot into denying plain reads'
    );
  } finally {
    cleanup();
  }
});

// --------------------------- ADV-6: `awk` leaves the blanket read-only set ---------------------------
// `awk` is only CONDITIONALLY read-only: its own `print > "file"` redirection
// and `system("...")` let it write or shell out to a write, exactly like the
// existing `sed -i`/`find -delete` conditional treatments.

test('ADV-6a (expect RED): `awk \'{print > ".sterling/config.json"}\' /tmp/f` is denied — awk\'s own `>` redirection writes into the store from inside the awk program', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('awk \'{print > ".sterling/config.json"}\' /tmp/f', dir);
    assert.notEqual(r.code, null, 'the gate must not crash on an awk program containing its own redirection');
    assert.equal(
      r.code,
      2,
      'awk is only conditionally read-only — a `print > "path"` redirection inside the awk program itself writes the store and must be denied even though the shell-level command line has no `>` of its own'
    );
    assert.match(r.stderr, /\.sterling\/config\.json/, 'the denial should name the store path awk redirects into');
  } finally {
    cleanup();
  }
});

test('ADV-6b (expect RED): `awk \'BEGIN{system("rm <abs>/.sterling/config.json")}\'` is denied — awk\'s `system()` shells out to a store-mutating command', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`awk 'BEGIN{system("rm ${dir}/.sterling/config.json")}'`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on an awk program calling system()');
    assert.equal(
      r.code,
      2,
      'awk\'s `system(...)` call shells out to an arbitrary command — here a store-deleting `rm` — and must be denied even though the outer command is just `awk`'
    );
    assert.match(r.stderr, /\.sterling\/config\.json/, 'the denial should name the store path the system() call removes');
  } finally {
    cleanup();
  }
});

// Accepted cost, pinned deliberately: pulling awk out of the blanket
// read-only set (ADV-6a/b) means a LEGITIMATE awk read of a store file now
// also denies fail-closed, because the gate can no longer cheaply tell an
// awk program that only reads fields from one that redirects/shells out.
// grep/cat already cover the legitimate store-read case, so this is an
// accepted, intentional cost of closing ADV-6a/b — not a bug.
test('ADV-6c (expect RED, accepted fail-closed cost): `awk \'{print $1}\' <abs>/.sterling/transient/x.json` — a legitimate awk READ of a store file — now also denies', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'x.json'), '{}');
    const r = runHook(`awk '{print $1}' ${dir}/.sterling/transient/x.json`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a plain awk read of a store file');
    assert.equal(
      r.code,
      2,
      'ACCEPTED COST: taking awk out of the blanket read-only set to catch print-redirection/system() means a plain awk field-read of a non-db store file also fails closed now — grep/cat remain the sanctioned way to read store files by shell, so this is a deliberate tradeoff, not a regression to fix'
    );
  } finally {
    cleanup();
  }
});
