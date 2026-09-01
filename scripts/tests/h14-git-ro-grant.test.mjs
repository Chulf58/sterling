// H14 × git-ro: the wrapper grant is the EXACT plugin-owned wrapper identity
// (spec S1), not a cwd-relative literal. SPEC ONLY, red-first.
//
// SPEC: /tmp/claude-1000/-mnt-c-Users-cuj-Sterling/2f52faee-d898-40b6-9eae-f67501e2bf0c/scratchpad/git-ro-reach-spec.md
// section S1 (board 512f7595, branch fix/git-ro-consumer-reach), governed by
// decision `git-ro-wrapper-fixed-recipes-no-caller-flags`
// (knowledge_get 1a7f3926-703a-471c-b33a-c3907bc9c3b3) and article
// `git-ro-wrapper` (d87cb243). Read in full; nothing below is derived from
// scripts/hooks/h14-bash-allowlist.mjs itself (H4 read wall) beyond what the
// spec quotes.
//
// THE NEW RULE (S1.1-S1.4), replacing the old cwd-relative literal prefix
// `node scripts/git-ro.mjs`: the ONLY allowed shape is a TWO-TOKEN command
// head, `<realpath(process.execPath)> "<expected-wrapper-path>" <args...>`,
// where token 1 canonically equals the live node executable and token 2 is
// ABSOLUTE and canonically equals realpath(<clone>/scripts/git-ro.mjs) — the
// clone root is derived the same way H14 derives it at runtime (a bounded
// walk-up from its own import.meta.url), which for THIS test file is simply
// the repo root the test runs in. A RELATIVE token 2 is denied even if it
// would resolve to the right file (S1.2's cwd/shell resolution mismatch
// rationale). Quoting (bare / "double" / 'single') and backslash path
// separators (normalized on every platform, S1.2) are all legal spellings of
// the SAME absolute path; nothing else varies the identity check.
//
// Harness idiom mirrors scripts/tests/h14-robustness.test.mjs and
// scripts/tests/h14-sandbox-bypass-log.test.mjs exactly (makeProject /
// hookInput / bash closures, CONFIG shape, stdin-JSON PreToolUse invocation).
// Those two files were read for convention only — never imported, never
// modified. scripts/hooks/h14-bash-allowlist.mjs itself was NOT read (H4).
//
// ROLE DIMENSION — stated, not faked. The decision names the grant as landing
// "on the Bash-holding roster roles (coder, debugger)". H14's observable input
// (the PreToolUse payload above) carries NO agent role, and the sibling H14
// suites judge every command role-agnostically, so at THIS surface the
// allowlist is uniform and role is a GRANT-level fact (which templates hold
// the Bash tool at all — test-writer holds none). These tests therefore pin
// the verdict role-agnostically.
//
// STDERR-PATTERN DISCIPLINE. S1.3 fixes that a git-ro-shaped command that
// fails IDENTITY gets a denial naming the exact accepted form and WHY it
// failed (relative path / wrong node / lookalike / not the plugin copy) — the
// pins for those four categories match on the named concept word, loosely
// (the decision does not fix exact wording). A command that does not even
// LEXICALLY MATCH the two-token shape (a node flag between tokens, an
// env-assignment prefix, an unbalanced quote, a $-expansion) is NOT
// git-ro-shaped at all in H14's eyes — S1.2 says these fail to match, which
// means ordinary allowlist reasoning applies, so those pins match the
// existing generic denial text `/not on the allowlist/` used everywhere else
// in this file. Chaining/redirection is denied by the PRE-EXISTING
// control-operator gate per S1.2 — those pins match `/control operators/`,
// the same pattern the UNCHANGED section already relies on.
//
// ENVIRONMENT ASSUMPTION, stated rather than hidden: the bare/unquoted
// two-token pin assumes neither the live node path nor the clone's wrapper
// path contains a space — true on this machine/CI. A path-with-space
// environment would need the quoted forms only; that is exactly why quoted
// forms are pinned as their OWN, independently-passing arms.
//
// RED DISCIPLINE: every assertion is a plain assert.equal on the hook's exit
// code, or assert.match on its stderr — clean assertion_fail results against
// today's H14 (today's allowlist still recognizes the OLD cwd-relative
// literal `node scripts/git-ro.mjs` and has no absolute-identity check at
// all, so every new ALLOW pin here is red because the exact absolute form is
// not recognized, and every new DENY pin naming "relative" is red because the
// old relative form is exactly what today's allowlist accepts). Per-test
// expected failure shape and NAMED SABOTAGE are inline and repeated in the
// report.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
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

const ALLOWED_TOOLCHAIN_CMD = 'node --test scripts/tests/foo.test.mjs';

// The canonical identity pair the new grant is anchored to. NODE_PATH is the
// live node binary actually running this suite (realpath'd, so an nvm-style
// symlink resolves the same way H14's own realpath check would). WRAPPER_PATH
// is the live clone's copy of the wrapper — the same file H14 is specified to
// derive via its own bounded walk-up from import.meta.url (S1.1); for this
// test file the clone root IS the repo root the test runs in.
const NODE_PATH = realpathSync(process.execPath);
const WRAPPER_PATH = realpathSync(join(root, 'scripts', 'git-ro.mjs'));

// The four legal spellings of the SAME two-token head (S1.2).
const GRANT_BARE = `${NODE_PATH} ${WRAPPER_PATH}`;
const GRANT_DQ = `${NODE_PATH} "${WRAPPER_PATH}"`;
const GRANT_SQ = `${NODE_PATH} '${WRAPPER_PATH}'`;
// Windows-style separators spelling the SAME absolute path. The leading '/'
// (POSIX absolute marker) is kept; every OTHER separator becomes '\'.
// SECURITY CORRECTION (both reviewers + Codex HIGH): this is a WIN32-ONLY
// legal spelling, not "normalized on every platform" as originally pinned.
// On POSIX, backslash is an ORDINARY filename character, never a path
// separator — bash inside a quoted token leaves `\` untouched (it is not one
// of the few characters `\` escapes inside double quotes: $, `, ", \,
// newline), so a backslash-bearing token executes as a LITERAL, different
// path from whatever H14 would resolve it to if H14 normalized `\`→`/` before
// comparing. That mismatch (H14 validates file A, bash executes file B) is
// exactly the check/use gap this constant now exists to DENY on POSIX — see
// the win32-gated ALLOW test and the POSIX DENY tests below.
const GRANT_BACKSLASH = `${NODE_PATH} "/${WRAPPER_PATH.slice(1).split('/').join('\\')}"`;

// The OLD grant — cwd-relative, no node-executable identity at all. Today's
// allowlist accepts this; the new spec denies it as RELATIVE.
const GRANT_OLD_RELATIVE = 'node scripts/git-ro.mjs';

const NOT_ON_ALLOWLIST = /not on the allowlist/;

function makeProject({ config = CONFIG } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h14-gitro-'));
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

function bash(dir, command, cwd = dir, over = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h14-bash-allowlist.mjs')], {
    input: JSON.stringify(hookInput(cwd, { tool_name: 'Bash', tool_input: { command }, ...over })),
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ===========================================================================
// CONTROLS — placed first, and they must pass for OPPOSITE reasons.
// Every verdict below has two possible causes ("the rule fired" vs "this hook
// allows/denies everything in this fixture"); these two arms rule the second
// cause out for both directions before any grant/removal pin is read.
// ===========================================================================

test('H14 git-ro CONTROL (deny side): an off-allowlist command is still DENIED in this fixture — the hook is not allow-everything', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = bash(dir, 'git status');
    assert.equal(r.code, 2, `control: an off-allowlist command must deny; stderr=${r.stderr}`);
    assert.match(r.stderr, NOT_ON_ALLOWLIST, 'control: the denial is ordinary allowlist reasoning');
  } finally {
    cleanup();
  }
});

test('H14 git-ro CONTROL (allow side): the declared toolchain command is still ALLOWED in this fixture — the hook is not deny-everything', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = bash(dir, ALLOWED_TOOLCHAIN_CMD);
    assert.equal(r.code, 0, `control: the declared toolchain command must be allowed; stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (1a) THE GRANT — the exact absolute two-token form, every legal spelling
// ===========================================================================

test('H14 git-ro GRANT (bare): `<realpath(node)> <realpath(wrapper)> log` is ALLOWED', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): assert.equal(r.code, 0) fires with code
    // 2 "not on the allowlist" — today's allowlist recognizes only the OLD
    // cwd-relative literal, and this command does not match it.
    // NAMED SABOTAGE (post-fix): remove the bare (unquoted) lexer arm, or
    // require quoting unconditionally — this goes red (code 2) while the
    // quoted-form pins below stay green, proving bare specifically broke.
    const r = bash(dir, `${GRANT_BARE} log`);
    assert.equal(r.code, 0, `the bare absolute two-token form must be allowed; stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 git-ro GRANT (double-quoted): `<node> "<wrapper>" log` is ALLOWED', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): code 2 "not on the allowlist".
    // NAMED SABOTAGE: drop double-quote handling from the two-token lexer
    // (treat a quote character as unrecognized) — this goes red while the
    // bare-form pin stays green, proving quoting specifically broke.
    const r = bash(dir, `${GRANT_DQ} log`);
    assert.equal(r.code, 0, `the double-quoted absolute form must be allowed; stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 git-ro GRANT (single-quoted): `<node> \'<wrapper>\' log` is ALLOWED', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): code 2 "not on the allowlist".
    // NAMED SABOTAGE: implement ONLY double-quote handling (treat single
    // quotes as ordinary characters, not a quoting form) — this goes red
    // while the double-quoted pin stays green, proving the single-quote arm
    // specifically is missing.
    const r = bash(dir, `${GRANT_SQ} log`);
    assert.equal(r.code, 0, `the single-quoted absolute form must be allowed; stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 git-ro GRANT (win32 ONLY): backslashes spelling the exact plugin path are ALLOWED — this is a win32 spelling rule, not a cross-platform one', (t) => {
  if (process.platform !== 'win32') {
    t.skip('backslash is an ordinary POSIX filename character, never a separator — this ALLOW arm is win32-only; the POSIX behavior (DENY) is pinned by the tests below');
    return;
  }
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today, on win32): code 2 "not on the
    // allowlist" — today's allowlist is a literal-string prefix match with no
    // path canonicalization at all, so backslash-separated spelling never
    // matches.
    // NAMED SABOTAGE: canonicalize token 2 by string-compare only, without a
    // backslash-to-forward-slash normalization step ON WIN32 — this goes red
    // while the double-quoted (already-forward-slash) pin stays green,
    // proving the normalization step specifically is missing.
    const r = bash(dir, `${GRANT_BACKSLASH} log`);
    assert.equal(r.code, 0, `on win32, a backslash-separated spelling of the same absolute wrapper path must be allowed; stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 git-ro DENY (non-win32): ANY backslash in token 1 or token 2 is DENIED — a `\\`→`/` normalization on POSIX would validate a DIFFERENT file than the one the shell actually executes', (t) => {
  if (process.platform === 'win32') {
    t.skip('the POSIX backslash-is-not-a-separator hazard this pin guards against does not apply on win32, where backslash IS the native separator (see the win32-only ALLOW arm above)');
    return;
  }
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): today's allowlist recognizes neither
    // form at all (it only knows the OLD relative literal), so both arms are
    // already code 2 for the WRONG reason. The pin that actually exercises
    // the fix is the SABOTAGE below — a correct absolute-identity check must
    // still deny a backslash-bearing token even once it starts accepting the
    // clean absolute forms.
    // NAMED SABOTAGE: normalize `\`→`/` in token 2 (or token 1) before the
    // canonical-path comparison, as the ORIGINAL (incorrect) design of this
    // suite assumed "backslashes are normalized on every platform" — this
    // goes red (code 0), and the security gap is that bash, executing the
    // SAME quoted string, leaves the backslash literal: H14 would have
    // validated a different file (the real wrapper, after normalization)
    // than the one that actually runs (a literal path component containing
    // `\`, which an attacker can plant as an ordinary POSIX filename).
    const token2Backslash = bash(dir, `${GRANT_DQ.replace(WRAPPER_PATH, WRAPPER_PATH.replace('/scripts/', '\\scripts\\'))} log`);
    assert.equal(token2Backslash.code, 2, `a backslash inside token 2 must be denied on POSIX; stdout=${token2Backslash.stdout} stderr=${token2Backslash.stderr}`);
    assert.match(token2Backslash.stderr, /not on the allowlist|backslash/i, `stderr=${token2Backslash.stderr}`);

    const nodeWithBackslash = NODE_PATH.replace('/', '\\');
    const token1Backslash = bash(dir, `${nodeWithBackslash} "${WRAPPER_PATH}" log`);
    assert.equal(token1Backslash.code, 2, `a backslash inside token 1 (the node path) must be denied on POSIX; stdout=${token1Backslash.stdout} stderr=${token1Backslash.stderr}`);
    assert.match(token1Backslash.stderr, /not on the allowlist|backslash/i, `stderr=${token1Backslash.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 git-ro DENY (non-win32): the concrete Dataverse-style `\\..\\` traversal — a backslash-normalizing check/use mismatch, denied', (t) => {
  if (process.platform === 'win32') {
    t.skip('this pin exercises the POSIX backslash-literalness hazard specifically; the win32 spelling is covered by the win32-only ALLOW arm above');
    return;
  }
  const { dir, cleanup } = makeProject();
  try {
    // The measured attack shape (both reviewers + Codex HIGH): a sibling
    // directory ("Dataverse", alongside the Sterling clone) contains an
    // entry whose NAME IS LITERALLY `\..\<clone-basename>` — a perfectly
    // legal POSIX filename (backslash and '.' are ordinary bytes; only a bare
    // '..' component is special, and this is not one). Bash, given the
    // double-quoted token below, executes exactly that literal path — an
    // attacker-controlled file the attacker planted themselves. A wrapper
    // that normalizes `\`→`/` BEFORE canonical-path comparison would instead
    // resolve `.../Dataverse/\..\Sterling/scripts/git-ro.mjs` (after
    // normalization: `.../Dataverse/../Sterling/scripts/git-ro.mjs`) to the
    // REAL, trusted wrapper — validating a DIFFERENT file than the one that
    // actually runs. This must be denied outright, not "validated as
    // equivalent".
    const cloneParent = dirname(root);
    const cloneBase = root.split(/[/\\]/).filter(Boolean).pop();
    const traversalPath = `${cloneParent}/Dataverse/\\..\\${cloneBase}/scripts/git-ro.mjs`;
    const r = bash(dir, `${NODE_PATH} "${traversalPath}" log`);
    assert.equal(r.code, 2, `the Dataverse-style backslash-traversal path must be denied on POSIX; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /not on the allowlist|backslash/i, `stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (1c) UNQUOTED SHELL-METACHARACTER DENIALS (Codex re-review). Token 2 is
// specified to be a plain path, bare or quoted — an UNQUOTED token carrying
// shell-expansion metacharacters (braces, globs, tilde) is a mismatch class
// exactly like the backslash one above: bash expands it before exec, H14's
// two-token lexer does not, so the two can resolve to DIFFERENT files even
// when H14's own canonicalization (which may itself follow symlinks) says
// they match. These deny on EVERY platform — unlike the backslash pin, there
// is no OS where shell-metacharacter expansion in an unquoted bash word stops
// applying.
// ===========================================================================

test('H14 git-ro DENY: unquoted BRACE expansion in token 2 is denied — a symlink literally named `{evil,good}` realpaths to the trusted wrapper, but bash brace-expands to TWO words and would exec the first one, a different (attacker) path', () => {
  const { dir, cleanup } = makeProject();
  const braceDir = mkdtempSync(join(tmpdir(), 'sterling-h14-gitro-brace-'));
  try {
    // The concrete bypass: this symlink's realpath IS the real, trusted
    // wrapper — if H14 canonicalized token 2 via fs.realpath alone (ignoring
    // shell semantics), it would validate this token as a match. Bash never
    // sees the symlink at all: brace expansion is purely lexical and happens
    // BEFORE any filesystem lookup, splitting `{evil,good}` into two words
    // and executing whichever resolves first — an attacker-controlled path
    // (e.g. `${braceDir}/evil`) that need not exist on disk at all for the
    // deny verdict to be the correct one.
    const braceLink = join(braceDir, '{evil,good}');
    symlinkSync(WRAPPER_PATH, braceLink);

    // EXPECTED FAILURE SHAPE (today): code 2 "not on the allowlist" — already
    // red today for the WRONG reason (today's allowlist recognizes no
    // absolute path at all). The pin that actually exercises the metachar
    // check is the SABOTAGE below, once the absolute-identity check exists.
    // NAMED SABOTAGE: remove the shell-metacharacter check from lexTwoTokens
    // (accept any unquoted token 2 and canonicalize/realpath it as-is) — this
    // goes red (code 0), because the symlink's realpath equals the expected
    // wrapper path even though the ACTUAL command bash would run resolves to
    // a different, attacker-controlled file.
    const r = bash(dir, `${NODE_PATH} ${braceLink} log`);
    assert.equal(r.code, 2, `an unquoted brace-expansion token 2 must be denied; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, NOT_ON_ALLOWLIST, `stderr=${r.stderr}`);
  } finally {
    cleanup();
    rmSync(braceDir, { recursive: true, force: true });
  }
});

test('H14 git-ro DENY: unquoted GLOB metacharacters in token 2 are denied — `git-ro.m?s` is not the literal expected path, even though it happens to glob-match the real file here', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): code 2 "not on the allowlist" (already
    // red for the wrong reason, same as above).
    // NAMED SABOTAGE: remove the shell-metacharacter check from lexTwoTokens
    // — this goes red (code 0). The categorical rule holds even though THIS
    // particular glob happens to match only the real wrapper file in this
    // repo: the point is that H14 cannot rely on a glob resolving safely in
    // general, so an unquoted glob is refused outright, never evaluated.
    const globPath = join(root, 'scripts', 'git-ro.m?s');
    const r = bash(dir, `${NODE_PATH} ${globPath} log`);
    assert.equal(r.code, 2, `an unquoted glob-metacharacter token 2 must be denied; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, NOT_ON_ALLOWLIST, `stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 git-ro DENY: unquoted TILDE expansion in token 2 is denied — `~/whatever/git-ro.mjs` is a shell-expanded, caller-relative path, never the literal expected absolute path', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): code 2 "not on the allowlist" (already
    // red for the wrong reason, same as above).
    // NAMED SABOTAGE: remove the shell-metacharacter check from lexTwoTokens
    // — this goes red (code 0), because a leading `~` would otherwise be
    // accepted as an ordinary path character and (depending on how loosely
    // the rest of the match is written) could be treated as "close enough" to
    // an absolute path, when bash actually expands it against $HOME — a
    // value H14 does not control and cannot predict.
    const r = bash(dir, `${NODE_PATH} ~/whatever/git-ro.mjs log`);
    assert.equal(r.code, 2, `an unquoted tilde-expansion token 2 must be denied; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, NOT_ON_ALLOWLIST, `stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 git-ro GRANT: every wrapper VERB and argument shape rides the exact absolute prefix — show / show-stat / diff-names, with revs, REV:path, and paths after --', () => {
  const { dir, cleanup } = makeProject();
  try {
    // NAMED SABOTAGE: allowlist the grant as the FULL command (exact-equality
    // match instead of a prefix match) — every arm below except a bare
    // invocation goes red. This is the pin that keeps the grant a PREFIX,
    // since the wrapper's whole point is to take verbs and revs.
    for (const cmd of [
      `${GRANT_DQ} show HEAD`,
      `${GRANT_DQ} show-stat HEAD`,
      `${GRANT_DQ} diff-names HEAD~1 HEAD`,
      `${GRANT_DQ} diff-names HEAD~1 HEAD -- CLAUDE.md`,
      `${GRANT_DQ} show HEAD:CLAUDE.md`,
      `${GRANT_DQ} log HEAD -- scripts`,
    ]) {
      const r = bash(dir, cmd);
      assert.equal(r.code, 0, `\`${cmd}\` must be allowed by the wrapper grant; stderr=${r.stderr}`);
    }
  } finally {
    cleanup();
  }
});

test('H14 git-ro GRANT LAYERING: H14 is not the wrapper\'s arity gate — a malformed wrapper invocation still passes H14 and is refused by the WRAPPER itself', () => {
  const { dir, cleanup } = makeProject();
  try {
    // The wrapper owns verb/arity/flag refusals (pinned in
    // scripts/tests/git-ro.test.mjs). H14's job is the command PREFIX only.
    // NAMED SABOTAGE: teach H14 to parse and validate wrapper verbs — this
    // goes red, and the duplication it represents is exactly the drift surface
    // the fixed-recipe design exists to avoid.
    for (const cmd of [GRANT_DQ, `${GRANT_DQ} bogus-verb`, `${GRANT_DQ} diff-names HEAD`]) {
      const r = bash(dir, cmd);
      assert.equal(r.code, 0, `\`${cmd}\` is the wrapper's to refuse, not H14's to deny; stderr=${r.stderr}`);
    }
  } finally {
    cleanup();
  }
});

test('H14 git-ro NODE_OPTIONS DEFENSE-IN-DEPTH: an env-assignment PREFIX on the wrapper command is DENIED — the grant matches only a command STARTING with the exact two-token identity, so an env-injection wrapper cannot ride it', () => {
  const { dir, cleanup } = makeProject();
  try {
    // CONTROL first, and it must pass for the OPPOSITE reason: the BARE
    // absolute-form wrapper command is ALLOWED. This is what proves the
    // denials below are caused by the env-assignment PREFIX, not by the
    // absolute form being off-allowlist (which would deny everything and make
    // the pin meaningless).
    // EXPECTED FAILURE SHAPE (today): this assert.equal(code,0) fires with
    // code 2 "not on the allowlist" — the new absolute grant has not landed.
    const control = bash(dir, `${GRANT_DQ} log`);
    assert.equal(control.code, 0, `control: the bare absolute wrapper command is allowed; stderr=${control.stderr}`);

    // NAMED SABOTAGE (post-fix): add env-assignment-prefix STRIPPING /
    // normalization before the allowlist match (a "helpful" change so
    // `FOO=bar <node> "<wrapper>" ...` is treated as `<node> "<wrapper>" ...`)
    // — these go red (code 0), silently opening a code-injection route INTO
    // the node process (NODE_OPTIONS=--import runs before the wrapper
    // sanitizes anything) or a config-hijack route (GIT_CONFIG_GLOBAL) around
    // the wrapper's positive-set env. The command simply does not START with
    // the allowed two-token identity, so it must be denied.
    for (const cmd of [
      `NODE_OPTIONS=--import=data:x ${GRANT_DQ} log`,
      `GIT_CONFIG_GLOBAL=/x ${GRANT_DQ} log`,
    ]) {
      const r = bash(dir, cmd);
      assert.equal(r.code, 2, `\`${cmd}\` must be denied — an env-assignment prefix means the command does not start with the allowed identity; stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stderr, NOT_ON_ALLOWLIST, `\`${cmd}\` is denied by ordinary allowlist reasoning, not a crash; stderr=${r.stderr}`);
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (1b) NEW IDENTITY DENIALS — the two-token shape matches lexically but the
// IDENTITY check fails (S1.2/S1.3): relative path, wrong node, lookalike.
// ===========================================================================

test('H14 git-ro IDENTITY DENY: the OLD cwd-relative literal `node scripts/git-ro.mjs` is now DENIED as RELATIVE', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): assert.equal(r.code, 2) fires with code
    // 0 — this is exactly today's allowed literal prefix, the very thing S1
    // replaces.
    // NAMED SABOTAGE (post-fix): keep the old relative literal as a SECOND
    // accepted arm alongside the new absolute check ("for compatibility") —
    // this goes red (code 0), and that compatibility arm is exactly the
    // relative-path bypass S1.2 rejects (a relative spelling can validate one
    // file while the shell resolves against a different real cwd).
    const r = bash(dir, `${GRANT_OLD_RELATIVE} log`);
    assert.equal(r.code, 2, `a relative wrapper path must be denied even though it names the right file; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /relative|absolute/i, `the denial names the relative/absolute rule; stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 git-ro IDENTITY DENY: literal `node` as token 1 (not the resolved node executable) is DENIED — wrong node identity, even with the correct absolute wrapper path', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): code 2 "not on the allowlist" (today's
    // allowlist does not recognize an absolute wrapper path at all, so this
    // is already red for the wrong reason — the SABOTAGE below is what makes
    // it red for the RIGHT reason once the absolute check lands).
    // NAMED SABOTAGE (post-fix): match token 1 by BASENAME ('node') instead of
    // by realpath-equality to process.execPath — this goes red (code 0),
    // which is exactly the PATH-selected-node-shim bypass S1.2 rejects (a
    // trusted-wrapper guarantee that assumes it is really node running the
    // wrapper, not an arbitrary PATH `node`).
    const r = bash(dir, `node "${WRAPPER_PATH}" log`);
    assert.equal(r.code, 2, `a literal "node" head (not the resolved executable) must be denied; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /node/i, `the denial names the node-identity rule; stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 git-ro IDENTITY DENY: a consumer-planted `<project>/scripts/git-ro.mjs` copy, passed by its own absolute path, is DENIED — lookalike, not the plugin copy', () => {
  const { dir, cleanup } = makeProject();
  const consumerRoot = mkdtempSync(join(tmpdir(), 'sterling-h14-consumer-'));
  try {
    mkdirSync(join(consumerRoot, 'scripts'), { recursive: true });
    const consumerWrapper = join(consumerRoot, 'scripts', 'git-ro.mjs');
    writeFileSync(consumerWrapper, '// not the plugin copy\n');
    const consumerWrapperReal = realpathSync(consumerWrapper);

    // EXPECTED FAILURE SHAPE (today): code 2 "not on the allowlist" (today's
    // check is a literal-string prefix, so any absolute path is already
    // off-allowlist — again already red for the wrong reason; the SABOTAGE
    // below is the one that must be caught once the absolute check lands).
    // NAMED SABOTAGE (post-fix): compare token 2 by BASENAME ('git-ro.mjs')
    // instead of by full canonical path equality to the plugin's own copy —
    // this goes red (code 0). A consumer project has no such file today
    // (D1's MODULE_NOT_FOUND); this pin is what stops a project that has since
    // GAINED a same-named file of its own from being trusted as if it were
    // the reviewed plugin copy.
    const r = bash(dir, `${NODE_PATH} "${consumerWrapperReal}" log`);
    assert.equal(r.code, 2, `an absolute path to a consumer-planted lookalike must be denied; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /lookalike|not the plugin copy/i, `the denial names the lookalike/not-the-plugin-copy rule; stderr=${r.stderr}`);
  } finally {
    cleanup();
    rmSync(consumerRoot, { recursive: true, force: true });
  }
});

test('H14 git-ro IDENTITY DENY: sibling-named files `git-ro-evil.mjs` and `git-ro.mjs.bak`, passed by ABSOLUTE path in the plugin scripts/ dir, are DENIED', () => {
  const { dir, cleanup } = makeProject();
  try {
    // NAMED SABOTAGE: canonicalize token 2 by DIRECTORY match only (accept any
    // absolute path inside <clone>/scripts/) instead of full-path equality to
    // the one expected file — both arms below go red (code 0). This is the
    // H15 unanchored-substring/directory class applied to the new absolute
    // check.
    for (const name of ['git-ro-evil.mjs', 'git-ro.mjs.bak']) {
      const evilPath = join(root, 'scripts', name);
      const r = bash(dir, `${NODE_PATH} "${evilPath}" log`);
      assert.equal(r.code, 2, `an absolute path to \`${name}\` must be denied — it is not the expected file; stdout=${r.stdout} stderr=${r.stderr}`);
    }
  } finally {
    cleanup();
  }
});

test('H14 git-ro LEXICAL DENY: a node FLAG between the two tokens is DENIED — the shape does not match the two-token lexer at all', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): code 2 "not on the allowlist" — already
    // red today because today's allowlist does not accept an absolute path
    // either way; remains the correct verdict after the fix.
    // NAMED SABOTAGE (post-fix): scan for the node executable and the wrapper
    // path ANYWHERE in the command (a permissive "does it contain both
    // tokens" match) instead of requiring them to be exactly tokens 1 and 2 —
    // this goes red (code 0), and a node flag between them (or after) is a
    // route to arbitrary node startup behavior (e.g. --inspect opens a debug
    // port) riding the trusted-wrapper grant.
    const r = bash(dir, `${NODE_PATH} --inspect "${WRAPPER_PATH}" log`);
    assert.equal(r.code, 2, `a node flag between the two tokens must be denied; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, NOT_ON_ALLOWLIST, `stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 git-ro LEXICAL DENY: an unbalanced quote around the wrapper path is DENIED', () => {
  const { dir, cleanup } = makeProject();
  try {
    // NAMED SABOTAGE: make quote-balance checking best-effort (treat an
    // unterminated quote as "quote to end of string, then re-tokenize the
    // rest") — this goes red (code 0), and an unbalanced quote is exactly the
    // shape a lexer bug would misparse into accepting a different token 2
    // than the one that was actually reviewed.
    const r = bash(dir, `${NODE_PATH} "${WRAPPER_PATH} log`);
    assert.equal(r.code, 2, `an unbalanced quote must be denied; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, NOT_ON_ALLOWLIST, `stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 git-ro LEXICAL DENY: a `$`-expansion inside the wrapper path token is DENIED — the lexer never expands it, so it cannot spell the expected absolute path', () => {
  const { dir, cleanup } = makeProject();
  try {
    // NAMED SABOTAGE: shell out (or otherwise expand `$VAR`) to resolve token
    // 2 before comparing it to the expected path — this goes red (code 0) if
    // HOME happens to expand into the clone root on the running machine, and
    // more importantly reintroduces a shell-expansion surface the two-token
    // LEXER (explicitly not a shell) is specified to never have.
    const r = bash(dir, `${NODE_PATH} "$HOME/scripts/git-ro.mjs" log`);
    assert.equal(r.code, 2, `a $-expansion inside the path token must be denied; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, NOT_ON_ALLOWLIST, `stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 git-ro LEXICAL DENY: chaining onto the exact absolute grant is DENIED by the pre-existing control-operator gate (`log && echo x`)', () => {
  const { dir, cleanup } = makeProject();
  try {
    // CONTROL first, opposite reason: the bare chained-free grant succeeds.
    const control = bash(dir, `${GRANT_DQ} log`);
    assert.equal(control.code, 0, `control: the unchained absolute grant succeeds; stderr=${control.stderr}`);

    // NAMED SABOTAGE: check the new absolute-identity prefix BEFORE the
    // control-operator / redirection gates (an "allowlisted prefix
    // short-circuits" refactor) — this goes red (code 0), and the grant
    // becomes a laundering route for an arbitrary chained command riding the
    // trusted wrapper identity.
    const r = bash(dir, `${GRANT_DQ} log && echo x`);
    assert.equal(r.code, 2, `chaining onto the absolute grant must be denied; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /control operators/, 'the denial cites control operators');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (2) THE REMOVAL — the four direct git verb prefixes now DENY
// (unchanged by S1 — kept verbatim as regression coverage)
// ===========================================================================

test('H14 git-ro REMOVAL: the four direct read-only git prefixes now DENY — git log / git show <ref> --stat / git diff --name-only / git branch --list', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): each assert.equal(r.code, 2) fires with
    // code 0 — these four are currently ALLOWED (board 4c7b84d3 lineage,
    // pinned green by scripts/tests/h14-robustness.test.mjs AC3, which this
    // slice's decision supersedes; that file is NOT edited here — the
    // conflict is evidence for the conductor).
    // NAMED SABOTAGE (post-fix): restore any one of the four direct prefixes
    // to the allowlist — that arm goes red. Keeping them beside the wrapper is
    // the alternative the decision explicitly rejected ("preserves a bypass
    // around every guarantee the wrapper adds").
    for (const cmd of ['git log', 'git show HEAD --stat', 'git diff --name-only', 'git branch --list']) {
      const r = bash(dir, cmd);
      assert.equal(r.code, 2, `\`${cmd}\` must be denied now that the wrapper replaces it; stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stderr, NOT_ON_ALLOWLIST, `\`${cmd}\` is denied by ordinary allowlist reasoning, not a crash`);
    }
  } finally {
    cleanup();
  }
});

test('H14 git-ro REMOVAL: the argument variants of the removed prefixes are denied too — no residual direct-git arm survives with different revs or flags', () => {
  const { dir, cleanup } = makeProject();
  try {
    for (const cmd of [
      'git log --oneline -n 5',
      'git log HEAD~3..HEAD',
      'git show abc123 --stat',
      'git show HEAD:CLAUDE.md',
      'git diff --name-only HEAD~1 HEAD',
      'git branch --list feature/*',
    ]) {
      const r = bash(dir, cmd);
      assert.equal(r.code, 2, `\`${cmd}\` must be denied — the direct git surface is gone entirely; stderr=${r.stderr}`);
    }
  } finally {
    cleanup();
  }
});

test('H14 git-ro REMOVAL: the denial POINTS AT the replacement — the allowlist named in the refusal now includes the wrapper', () => {
  const { dir, cleanup } = makeProject();
  try {
    // H14's existing behavior is to NAME the allowlist in its denial (pinned
    // by the sibling suite: "the allowlist is still named in the denial").
    // This arm pins that a denied direct-git call therefore shows the agent
    // the route that still works, instead of a dead end.
    // NAMED SABOTAGE: add the git-ro identity to the match logic but omit it
    // from the allowlist text rendered into the denial — this goes red while
    // every other grant/removal arm stays green.
    const r = bash(dir, 'git log');
    assert.equal(r.code, 2, `sanity: git log is denied; stderr=${r.stderr}`);
    assert.match(r.stderr, /git-ro/, `the denial names the wrapper as the surviving route; stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (3) UNCHANGED DENIALS — the removal must not disturb the rest of the surface
// ===========================================================================

test('H14 git-ro UNCHANGED: mutating and lookalike git verbs stay denied exactly as before (git logger / git stash / git commit / git push / git checkout)', () => {
  const { dir, cleanup } = makeProject();
  try {
    for (const cmd of ['git logger', 'git stash', 'git commit -m "x"', 'git push', 'git checkout main', 'git reset --hard']) {
      const r = bash(dir, cmd);
      assert.equal(r.code, 2, `\`${cmd}\` must stay denied; stderr=${r.stderr}`);
      assert.match(r.stderr, NOT_ON_ALLOWLIST, `\`${cmd}\` denial still names the allowlist`);
    }
  } finally {
    cleanup();
  }
});

test('H14 git-ro UNCHANGED: control operators and redirection still deny, even riding the newly-shaped absolute grant', () => {
  const { dir, cleanup } = makeProject();
  try {
    // NAMED SABOTAGE: check the absolute grant identity BEFORE the
    // control-operator / redirection gates (an "allowlisted prefix
    // short-circuits" refactor) — these go red and the grant becomes a
    // laundering route for arbitrary chained commands.
    let r = bash(dir, `${GRANT_DQ} log && git push`);
    assert.equal(r.code, 2, 'chaining a mutation onto the wrapper invocation is denied');
    assert.match(r.stderr, /control operators/, 'the denial cites control operators');

    r = bash(dir, `${GRANT_DQ} log; rm -rf x`);
    assert.equal(r.code, 2, "';' chaining onto the wrapper invocation is denied");
    assert.match(r.stderr, /control operators/, 'the denial cites control operators');

    r = bash(dir, `${GRANT_DQ} log | tee out.txt`);
    assert.equal(r.code, 2, 'piping the wrapper output into another command is denied');

    r = bash(dir, `${GRANT_DQ} show HEAD > patch.txt`);
    assert.equal(r.code, 2, 'redirecting the wrapper output is denied — the grant is read-only, and redirection is a write vector');
    assert.match(r.stderr, /redirection/, 'the denial cites redirection');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (4) EXACT-PREFIX BOUNDARY — the lookalike class (relative-form lookalikes;
// unaffected by S1, kept verbatim — a relative lookalike was already
// off-allowlist under the old literal-prefix match and stays denied under the
// new absolute-identity check for the SAME reason plus the new one)
// ===========================================================================

test('H14 git-ro BOUNDARY: a LOOKALIKE script is denied — `node scripts/git-ro-evil.mjs` is not `node scripts/git-ro.mjs`', () => {
  const { dir, cleanup } = makeProject();
  try {
    // NAMED SABOTAGE: match the grant as a substring of the command, or as a
    // prefix of the PATH SEGMENT ('node scripts/git-ro') rather than the whole
    // final token — the evil lookalike is allowed and this goes red. This is
    // the H15 unanchored-substring class (anti_pattern
    // `unanchored-substring-allowlist-in-command-guard`) applied to H14.
    for (const cmd of [
      'node scripts/git-ro-evil.mjs',
      'node scripts/git-ro-evil.mjs log',
      'node scripts/git-ro.mjs.bak log',
      'node scripts/git-ro.mjsx log',
      'node scripts/../scripts/git-ro-evil.mjs log',
      'node scripts/git-ro2.mjs log',
    ]) {
      const r = bash(dir, cmd);
      assert.equal(r.code, 2, `\`${cmd}\` must be denied — the grant is one EXACT identity, token-bounded; stderr=${r.stderr}`);
    }
  } finally {
    cleanup();
  }
});

test('H14 git-ro BOUNDARY: the sanctioned name appearing ANYWHERE OTHER than the command head never exempts the command', () => {
  const { dir, cleanup } = makeProject();
  try {
    // NAMED SABOTAGE: exempt any command whose text CONTAINS 'scripts/git-ro.mjs'
    // (raw unanchored substring) — every arm below is allowed and goes red.
    // Every head below is independently off-allowlist today (see the sibling
    // suite's regression battery), so a green here means the SUBSTRING did not
    // launder them — never that the head happened to be allowed.
    for (const cmd of [
      'rm -rf /tmp/x # node scripts/git-ro.mjs',
      'bash -c "node scripts/git-ro.mjs log"',
      'sh scripts/git-ro.mjs log',
      'git push # node scripts/git-ro.mjs',
    ]) {
      const r = bash(dir, cmd);
      assert.equal(r.code, 2, `\`${cmd}\` must be denied — the wrapper name is not an exemption token; stderr=${r.stderr}`);
    }
  } finally {
    cleanup();
  }
});
