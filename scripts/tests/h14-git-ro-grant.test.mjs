// H14 × git-ro: the wrapper grant lands and the four direct git verb prefixes
// are REMOVED in the same slice. SPEC ONLY, red-first.
//
// SPEC: decision `git-ro-wrapper-fixed-recipes-no-caller-flags`
// (knowledge_get 1a7f3926-703a-471c-b33a-c3907bc9c3b3), H14 INTEGRATION
// clause, verbatim: "the four direct read-only git verb prefixes (git log /
// git show <ref> --stat / git diff --name-only / git branch --list, board
// 4c7b84d3 lineage) are REMOVED in the same slice and replaced by one exact
// prefix 'node scripts/git-ro.mjs' on the Bash-holding roster roles (coder,
// debugger); test-writer stays Bash-less".
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
// the verdict role-agnostically. If the implementation instead makes the
// git-ro prefix conditional on some role field in the hook payload, these
// tests fail — and that failure is the correct signal to bring back to the
// conductor, because it would mean the interface changed shape.
//
// RED DISCIPLINE: every assertion is a plain assert.equal on the hook's exit
// code, or assert.match on its stderr — clean assertion_fail results against
// today's H14 (the git-ro prefix is not on the allowlist yet, and the four
// direct git prefixes are still allowed). Per-test expected failure shape and
// NAMED SABOTAGE are inline and repeated in the report.

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

const ALLOWED_TOOLCHAIN_CMD = 'node --test scripts/tests/foo.test.mjs';
const WRAPPER_PREFIX = 'node scripts/git-ro.mjs';

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
    assert.match(r.stderr, /not on the allowlist/, 'control: the denial is ordinary allowlist reasoning');
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
// (1) THE GRANT — one exact prefix: `node scripts/git-ro.mjs`
// ===========================================================================

test('H14 git-ro GRANT: `node scripts/git-ro.mjs log` is ALLOWED (the single replacement prefix for the removed direct git verbs)', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): assert.equal(r.code, 0) fires with
    // stderr "not on the allowlist" — no git-ro arm exists yet.
    // NAMED SABOTAGE (post-fix): delete the 'node scripts/git-ro.mjs' entry
    // from the allowlist — this goes red immediately (code 2).
    const r = bash(dir, `${WRAPPER_PREFIX} log`);
    assert.equal(r.code, 0, `the wrapper invocation must be allowlisted; stderr=${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H14 git-ro GRANT: every wrapper VERB and argument shape rides the one prefix — show / show-stat / diff-names, with revs, REV:path, and paths after --', () => {
  const { dir, cleanup } = makeProject();
  try {
    // NAMED SABOTAGE: allowlist the prefix as the FULL command (exact-equality
    // match instead of a prefix match) — every arm below except a bare
    // invocation goes red. This is the pin that keeps the grant a PREFIX,
    // since the wrapper's whole point is to take verbs and revs.
    for (const cmd of [
      `${WRAPPER_PREFIX} show HEAD`,
      `${WRAPPER_PREFIX} show-stat HEAD`,
      `${WRAPPER_PREFIX} diff-names HEAD~1 HEAD`,
      `${WRAPPER_PREFIX} diff-names HEAD~1 HEAD -- CLAUDE.md`,
      `${WRAPPER_PREFIX} show HEAD:CLAUDE.md`,
      `${WRAPPER_PREFIX} log HEAD -- scripts`,
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
    for (const cmd of [WRAPPER_PREFIX, `${WRAPPER_PREFIX} bogus-verb`, `${WRAPPER_PREFIX} diff-names HEAD`]) {
      const r = bash(dir, cmd);
      assert.equal(r.code, 0, `\`${cmd}\` is the wrapper's to refuse, not H14's to deny; stderr=${r.stderr}`);
    }
  } finally {
    cleanup();
  }
});

test('H14 git-ro NODE_OPTIONS DEFENSE-IN-DEPTH: an env-assignment PREFIX on the wrapper command is DENIED — the grant matches only a command STARTING with the exact prefix, so an env-injection wrapper cannot ride it', () => {
  const { dir, cleanup } = makeProject();
  try {
    // CONTROL first, and it must pass for the OPPOSITE reason: the BARE wrapper
    // command is ALLOWED. This is what proves the denials below are caused by
    // the env-assignment PREFIX, not by the wrapper prefix being off-allowlist
    // (which would deny everything and make the pin meaningless).
    // EXPECTED FAILURE SHAPE (today): this assert.equal(code,0) fires with
    // code 2 "/not on the allowlist/" — the grant has not landed yet.
    const control = bash(dir, `${WRAPPER_PREFIX} log`);
    assert.equal(control.code, 0, `control: the bare wrapper command is allowed; stderr=${control.stderr}`);

    // NAMED SABOTAGE (post-fix): add env-assignment-prefix STRIPPING /
    // normalization before the allowlist match (a "helpful" change so
    // `FOO=bar node ...` is treated as `node ...`) — these go red (code 0),
    // silently opening a code-injection route INTO the node process
    // (NODE_OPTIONS=--import runs before the wrapper sanitizes anything) or a
    // config-hijack route (GIT_CONFIG_GLOBAL) around the wrapper's positive-set
    // env. The command simply does not START with the allowed prefix, so it
    // must be denied by ordinary allowlist reasoning.
    for (const cmd of [
      `NODE_OPTIONS=--import=data:x ${WRAPPER_PREFIX} log`,
      `GIT_CONFIG_GLOBAL=/x ${WRAPPER_PREFIX} log`,
    ]) {
      const r = bash(dir, cmd);
      assert.equal(r.code, 2, `\`${cmd}\` must be denied — an env-assignment prefix means the command does not start with the allowed prefix; stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stderr, /not on the allowlist/, `\`${cmd}\` is denied by ordinary allowlist reasoning, not a crash; stderr=${r.stderr}`);
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (2) THE REMOVAL — the four direct git verb prefixes now DENY
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
      assert.match(r.stderr, /not on the allowlist/, `\`${cmd}\` is denied by ordinary allowlist reasoning, not a crash`);
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

test('H14 git-ro REMOVAL: the denial POINTS AT the replacement — the allowlist named in the refusal now includes the wrapper prefix', () => {
  const { dir, cleanup } = makeProject();
  try {
    // H14's existing behavior is to NAME the allowlist in its denial (pinned
    // by the sibling suite: "the allowlist is still named in the denial").
    // This arm pins that a denied direct-git call therefore shows the agent
    // the route that still works, instead of a dead end.
    // NAMED SABOTAGE: add the git-ro prefix to the match logic but omit it
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
      assert.match(r.stderr, /not on the allowlist/, `\`${cmd}\` denial still names the allowlist`);
    }
  } finally {
    cleanup();
  }
});

test('H14 git-ro UNCHANGED: control operators and redirection still deny, even riding the newly-granted wrapper prefix', () => {
  const { dir, cleanup } = makeProject();
  try {
    // NAMED SABOTAGE: check the git-ro prefix BEFORE the control-operator /
    // redirection gates (an "allowlisted prefix short-circuits" refactor) —
    // these go red and the grant becomes a laundering route for arbitrary
    // chained commands.
    let r = bash(dir, `${WRAPPER_PREFIX} log && git push`);
    assert.equal(r.code, 2, 'chaining a mutation onto the wrapper invocation is denied');
    assert.match(r.stderr, /control operators/, 'the denial cites control operators');

    r = bash(dir, `${WRAPPER_PREFIX} log; rm -rf x`);
    assert.equal(r.code, 2, "';' chaining onto the wrapper invocation is denied");
    assert.match(r.stderr, /control operators/, 'the denial cites control operators');

    r = bash(dir, `${WRAPPER_PREFIX} log | tee out.txt`);
    assert.equal(r.code, 2, 'piping the wrapper output into another command is denied');

    r = bash(dir, `${WRAPPER_PREFIX} show HEAD > patch.txt`);
    assert.equal(r.code, 2, 'redirecting the wrapper output is denied — the grant is read-only, and redirection is a write vector');
    assert.match(r.stderr, /redirection/, 'the denial cites redirection');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (4) EXACT-PREFIX BOUNDARY — the lookalike class
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
      assert.equal(r.code, 2, `\`${cmd}\` must be denied — the grant is one EXACT prefix, token-bounded; stderr=${r.stderr}`);
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
