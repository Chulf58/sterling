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
//
// ---------------------------------------------------------------------------
// SUPERSESSION NOTICE (2026-08-31) — AC3 IS INVERTED.
// Decision `git-ro-wrapper-fixed-recipes-no-caller-flags`
// (knowledge_get 1a7f3926-703a-471c-b33a-c3907bc9c3b3), H14 INTEGRATION
// clause, REMOVES H14's four direct read-only git verb prefixes (git log /
// git show <ref> --stat / git diff --name-only / git branch --list — the
// board 4c7b84d3 lineage the header above describes) and replaces them with
// one exact prefix `node scripts/git-ro.mjs`. The AC3 background in the
// header above is therefore HISTORY, not the live ruling: those four are now
// DENIED. Only the AC3 arms are re-pinned below; AC1, AC2, AC4's assertions,
// AC-Y, AC-Z and the run-gate arms are untouched.
//
// SCOPE FENCE: the wrapper GRANT, the removed prefixes' argument variants,
// the denial's git-ro pointer vocabulary and the exact-prefix lookalike class
// are pinned in scripts/tests/h14-git-ro-grant.test.mjs and are deliberately
// NOT duplicated here — AC3's job shrinks to inverting its own superseded
// pin. That sibling file was read for vocabulary consistency only; it is not
// modified by this edit.
//
// WHAT FLIPS THESE ARMS: the H14 allowlist edit, alone. H14 matches the
// command STRING, so whether scripts/git-ro.mjs exists on disk changes no
// verdict in this file.
// ---------------------------------------------------------------------------

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
// AC3 — SUPERSEDED AND INVERTED by `git-ro-wrapper-fixed-recipes-no-caller-flags`:
// the four direct read-only git verb prefixes are REMOVED, so they now DENY.
// Mutating git stays denied exactly as before.
// ---------------------------------------------------------------------------

test('H14 AC3 (INVERTED by `git-ro-wrapper-fixed-recipes-no-caller-flags`): the four direct read-only git prefixes are now DENIED (git log / show <ref> --stat / diff --name-only / branch --list)', () => {
  const { dir, cleanup } = makeProject();
  try {
    // SUPERSESSION. This arm formerly pinned these four as ALLOWED (board
    // 4c7b84d3). Decision `git-ro-wrapper-fixed-recipes-no-caller-flags`
    // (knowledge_get 1a7f3926-703a-471c-b33a-c3907bc9c3b3) removes them
    // verbatim: "the four direct read-only git verb prefixes (git log / git
    // show <ref> --stat / git diff --name-only / git branch --list, board
    // 4c7b84d3 lineage) are REMOVED in the same slice and replaced by one
    // exact prefix 'node scripts/git-ro.mjs'". Keeping them beside the
    // wrapper is the alternative the decision explicitly REJECTED
    // ("preserves a bypass around every guarantee the wrapper adds").
    //
    // CONTROL (placed first, must pass for the OPPOSITE reason): the four
    // denials below would be produced equally by a fixture in which H14
    // denies EVERYTHING (an unreadable config, fail-closed). This allow-side
    // arm rules that second cause out before any denial is read, so a green
    // here carries its own evidence.
    assert.equal(
      bash(dir, 'node --test scripts/tests/foo.test.mjs').code,
      0,
      'control: the declared toolchain command is still ALLOWED in this fixture — the denials below are the git removal, not a deny-everything hook'
    );

    // EXPECTED FAILURE SHAPE (pre-implementation): the first
    // assert.equal(r.code, 2) fires receiving 0, because `git log` is still on
    // today's H14 allowlist; likewise the other three once it is fixed.
    // NAMED SABOTAGE (post-implementation): restore any ONE of the four
    // prefixes to H14's allowlist — that command's assert.equal(r.code, 2)
    // goes red immediately. The /not on the allowlist/ assertion beside it is
    // the discriminator that carries the verdict's REASON: it proves ordinary
    // allowlist reasoning rather than a crash or a fail-closed config error.
    //
    // The denial's git-ro POINTER vocabulary (stderr naming the wrapper as the
    // surviving route), the argument variants of these four, and the exact
    // wrapper prefix grant are pinned in
    // scripts/tests/h14-git-ro-grant.test.mjs — not re-pinned here.
    for (const cmd of ['git log', 'git show abc123 --stat', 'git diff --name-only', 'git branch --list']) {
      const r = bash(dir, cmd);
      assert.equal(
        r.code,
        2,
        `\`${cmd}\` must now be DENIED — the direct git prefixes were removed in favour of the git-ro wrapper; stdout=${r.stdout} stderr=${r.stderr}`
      );
      assert.match(r.stderr, /not on the allowlist/, `\`${cmd}\` is denied by ordinary allowlist reasoning, not a crash`);
    }
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

test('H14 AC3 boundary (re-framed by `git-ro-wrapper-fixed-recipes-no-caller-flags`): with the direct git prefixes removed, chaining and redirection still deny FOR THEIR OWN REASON, and git lookalikes stay denied', () => {
  const { dir, cleanup } = makeProject();
  try {
    // RE-FRAMING, not a weakening: every assertion below is unchanged. What
    // changed is the PREMISE. There is no longer an "allowed read-only verb"
    // for these two arms to chain onto, so their exit-code verdict is now
    // OVER-DETERMINED — code 2 could come from the control-operator /
    // redirection gate, or simply from `git log` being off the allowlist
    // since the decision. The stderr assertions are therefore the ones that
    // carry the pin: they demand the denial cite control operators /
    // redirection, which is only true if those gates fire BEFORE the
    // allowlist match. (That ordering is pinned in-file for a non-allowlisted
    // head by the run-gate ';' arm at the end of this file, and for the
    // wrapper head in scripts/tests/h14-git-ro-grant.test.mjs.)
    // NAMED SABOTAGE: move the control-operator / redirection checks AFTER the
    // allowlist match — the exit codes stay 2 (the head is off-allowlist now)
    // while both assert.match arms go red. That is precisely the regression
    // the exit-code assertions alone can no longer see.
    let r = bash(dir, 'git log && git push');
    assert.equal(r.code, 2, 'chaining onto a git verb is denied');
    assert.match(r.stderr, /control operators/);

    // redirection is a write vector regardless of the head's allowlist status
    r = bash(dir, 'git log > history.txt');
    assert.equal(r.code, 2, 'redirection on a git verb is denied');
    assert.match(r.stderr, /redirection/);

    // HONEST LABELLING: the two arms below no longer pin a word-boundary
    // distinction — since the decision there is no allowed `git log` for
    // `git logger` to be confused with, so both are now plain off-allowlist
    // denials. They are RETAINED as regression pins against a future edit
    // that reintroduces a broad "git " family allowance; neither is
    // load-bearing for the removal itself, which the inverted arm above owns.
    r = bash(dir, 'git logger');
    assert.equal(r.code, 2, 'a lookalike verb (git logger) must not match any allowlist entry');

    // a mutating git verb stays denied even though it starts with "git "
    r = bash(dir, 'git stash');
    assert.equal(r.code, 2, 'git stash is not the declared toolchain, and the read-only git verb category no longer exists');
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

    // Assertions unchanged; only the message is corrected. Since decision
    // `git-ro-wrapper-fixed-recipes-no-caller-flags` there is no "read-only
    // git verbs" category for `git status` to be measured against — it is an
    // ordinary off-allowlist command, and the allowlist named in the denial no
    // longer contains any direct git entry.
    r = bash(dir, 'git status');
    assert.equal(r.code, 2, 'a command off the toolchain allowlist stays denied — and there is no read-only git verb category to fall back on either');
    assert.match(r.stderr, /not on the allowlist/);
    assert.match(r.stderr, /node --test/, 'the allowlist is still named in the denial');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC-Y / AC-Z — escaping paths riding inside flag tokens or shell quoting
// must not be laundered past the allowlist by normalization
// ---------------------------------------------------------------------------

test('H14 AC-Y: an allowed toolchain prefix whose ESCAPING path rides inside a flag token is denied (node --test --import=../../outside.mjs)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = bash(dir, 'node --test --import=../../outside.mjs');
    assert.equal(
      r.code,
      2,
      'a traversal path embedded inside a --flag=value token must be extracted and boundary-checked the same as a bare positional path argument — a matcher that only checks the literal "node --test" prefix and never inspects subsequent flag values would incorrectly match this as the allowed command and let the escape through'
    );
  } finally {
    cleanup();
  }
});

test('H14 AC-Z: a QUOTED path argument containing whitespace that climbs out of the repo is denied — the quote must not shield the traversal from the boundary check', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = bash(dir, 'node --test "../../x y/evil.test.mjs"');
    assert.equal(
      r.code,
      2,
      'quoting a whitespace-containing traversal path must not shield it from the repo-boundary check — a matcher that naively splits on whitespace before stripping quotes would either mis-tokenize this argument or skip boundary-checking it entirely, incorrectly allowing an escape that plain (unquoted) traversal already denies (AC2 boundary)'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Review finding pinned below (board babf3a9e, governing decision
// knowledge_get 98549344-e355-42da-93dd-ce7c2dc4dfcb): "H14 allowlists the
// run-gate invocation prefix so agents can be briefed to run gates through
// it" — and the arm must be PATH-AGNOSTIC (an absolute clone path, not just
// a repo-relative "scripts/run-gate.mjs" literal). ADD-ONLY: nothing above
// this line was touched. A fixer is landing the corresponding repair in
// parallel.
// ---------------------------------------------------------------------------

test('H14 (review finding — run-gate path-agnostic arm): the coder allowlist accepts an absolute-path run-gate invocation regardless of where the clone lives', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (pre-fix): if H14's allowlist has no run-gate
    // arm yet (or only recognizes a repo-relative "scripts/run-gate.mjs"
    // literal), an absolute clone path is denied "not on the allowlist" and
    // this assert.equal(r.code, 0) fails.
    const r = bash(dir, 'node /abs/clone/scripts/run-gate.mjs export');
    assert.equal(r.code, 0, `an absolute-path run-gate invocation must be allowlisted regardless of clone location; stderr: ${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 (review finding): the same run-gate arm still denies when chained with \';\' into a mutating command — the control-operator gate fires before any allowlist prefix match', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED SHAPE: this is a regression-pinning case, not a red one — the
    // existing control-operator check (exercised by AC3/AC4 above, e.g.
    // 'node --test && git push') already fires on ANY additional chained
    // command regardless of whether the leading prefix is allowlisted, so
    // this is expected to be GREEN today independent of whether the run-gate
    // arm itself has landed yet. It is included to pin that adding the arm
    // must never accidentally widen past the control-operator gate.
    const r = bash(dir, 'node /abs/clone/scripts/run-gate.mjs export; rm -rf x');
    assert.equal(r.code, 2, "chaining a run-gate invocation with a mutating command via ';' must stay denied — the control-operator check fires before any allowlist prefix match");
    assert.match(r.stderr, /control operators/, 'the denial cites control operators, same as any other chained command');
  } finally {
    cleanup();
  }
});
