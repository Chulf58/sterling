// H15 store-guard — DB-SEAL DISCLOSURE pins (decision ccc44a8e-25d8-43ad-
// b4f6-215fd6f77933 ratifies the raw command-text DB seal as ACCEPTED
// TERMINAL — no narrowing of the matcher, ever; decision a8bec43f-4657-
// 446a-8bfe-6a558f9e9d8c already established the "gate matches command TEXT,
// not resolved target" posture and its own message fix precedent for a
// DIFFERENT H15 branch). THIS CHANGE IS DISCLOSURE-ONLY: the allow surface
// stays byte-identical; only the DENY MESSAGE for the raw sterling.db
// literal-text seal improves — it must (AC1) name the exact matched
// substring and its offset in the command, (AC2) state plainly that this is
// a raw command-text DB seal where syntactic role and verb are intentionally
// ignored, and (AC3) drop the current message's factually wrong claim that
// only redirections INTO .sterling/ are denied — it is also denying, e.g., a
// redirect whose target merely CONTAINS the literal while pointing OUTSIDE
// .sterling/ (measured: `cat .sterling/config.json > /tmp/sterling.db`), and
// a plain `grep -rn "sterling.db" skills templates` where grep is otherwise
// allowlisted as a store read verb.
//
// SUPPLEMENTAL to scripts/tests/h15-precision.test.mjs,
// scripts/tests/h15-precision-hardening.test.mjs and
// scripts/tests/h15-precision-adversarial.test.mjs (all read in full, for
// harness conventions only; NONE modified, NONE imported, NONE duplicated-
// by-reference). This file's runHook()/CONFIG/makeProject() below are
// reproduced STANDALONE so this file runs independently, the same
// convention those three files use relative to one another.
//
// Written BLIND to scripts/hooks/h15-store-guard.mjs's internals (H4 read
// wall; also true by design here) — every expectation below comes from
// decisions ccc44a8e + a8bec43f, the hook-write-gates article, and the
// launching agent's brief, not from the code.
//
// MUTATION DESIGN ONLY — never executed here (decision 23afbc83). Each test
// below carries a comment naming the one-line sabotage that must flip it
// red; the conductor applies these to a clean-room mutant copy of
// scripts/hooks/h15-store-guard.mjs, never to this file or the shipped hook.

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h15dbseal-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  // A REAL store db file, matching how every other hook test builds a
  // project — project-root resolution keys on .sterling/sterling.db
  // actually existing.
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

// =========================================================================
// CONTROL (placed FIRST) — proves the DENY verdicts below carry genuine
// evidence rather than reflecting a guard that has degenerated into
// deny-everything. Without this arm, every "still DENIED" pin in this file
// would pass identically under a broken unconditional-deny H15, and a
// reader could not tell the difference from a green suite alone.
// =========================================================================

test('CONTROL: a plain command with no store mention at all is ALLOWED — establishes H15 is not denying unconditionally, so the DENY pins below mean something', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('echo hello world', dir);
    assert.equal(
      r.code,
      0,
      'a command naming no store path and no db-seal literal must pass; if this goes red, H15 has degenerated into deny-everything and every DENY assertion in this file is meaningless'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE for CONTROL: make h15-store-guard.mjs exit 2 unconditionally
// (e.g. `process.exit(2)` before any check runs) → CONTROL flips red. This
// is the mutation every other test in this file is defenseless against on
// its own — CONTROL is what makes their green meaningful.

// =========================================================================
// AC1 — on a db-seal deny, the message names the EXACT matched substring
// and its OFFSET in the command.
// =========================================================================

test('AC1: db-seal deny on `cat .sterling/config.json > /tmp/sterling.db` names the matched substring "sterling.db" and its exact offset in the command', () => {
  const { dir, cleanup } = makeProject();
  try {
    const command = `cat ${dir}/.sterling/config.json > /tmp/sterling.db`;
    const r = runHook(command, dir);
    assert.equal(r.code, 2, 'the raw literal "sterling.db" appears in the command text and must still deny — this is the disclosure-only change, not a loosening');
    const offset = command.toLowerCase().indexOf('sterling.db');
    assert.ok(offset >= 0, 'test precondition: the fixture command must contain the literal');
    assert.match(r.stderr, /sterling\.db/i, 'the denial must name the exact matched substring "sterling.db"');
    assert.match(
      r.stderr,
      new RegExp(`\\b${offset}\\b`),
      `the denial must state the offset (${offset}) at which "sterling.db" occurs in the command text`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE for AC1: replace the offset-aware message with the old generic
// "shell access to the Sterling store is denied" text (drop the matched-
// substring/offset interpolation entirely) → AC1 red.

// =========================================================================
// AC2 — the message states the discriminator plainly: this is a RAW
// COMMAND-TEXT DB seal, and syntactic role / verb are intentionally ignored.
// =========================================================================

test('AC2: db-seal deny on `grep -rn "sterling.db" skills templates` (grep is otherwise an allowlisted read verb, and the literal sits inside a quoted search pattern, not a path) states plainly that this is a raw command-text match where verb and syntactic role are intentionally ignored', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('grep -rn "sterling.db" skills templates', dir);
    assert.equal(r.code, 2, 'the literal "sterling.db" appears in the command text (as a grep pattern, not a path) and must still deny');
    assert.match(
      r.stderr,
      /(raw\s+command|command[\s-]*text)/i,
      'the denial must state that the match is against raw COMMAND TEXT, not a resolved path or write target'
    );
    assert.match(
      r.stderr,
      /seal/i,
      'the denial must name this as the DB SEAL discriminator (distinct from the general write-precision denial family)'
    );
    assert.match(
      r.stderr,
      /(verb|syntactic role|argument (role|position)|position)\b[^.]*\b(ignor|regardless|irrelevant|not\s+(checked|considered|evaluated))/i,
      'the denial must state that syntactic role and verb are intentionally ignored for this seal'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE for AC2: revert to the old undifferentiated deny text (e.g.
// "shell access to the Sterling store is denied" with no mention of raw-text
// matching or verb/role irrelevance) → AC2 red.

// =========================================================================
// AC3 — the message no longer asserts that only redirections INTO
// .sterling/ are denied; the factually wrong claim is gone.
// =========================================================================

test('AC3: the db-seal deny on a redirect whose target lies OUTSIDE .sterling/ (`cat .sterling/config.json > /tmp/sterling.db`) does not claim that only redirections INTO .sterling/ are denied', () => {
  const { dir, cleanup } = makeProject();
  try {
    const command = `cat ${dir}/.sterling/config.json > /tmp/sterling.db`;
    const r = runHook(command, dir);
    assert.equal(r.code, 2, 'still denied — disclosure-only, the allow surface is unchanged');
    assert.doesNotMatch(
      r.stderr,
      /redirections?\s+into\s+\.?sterling/i,
      'the message must not claim that only redirections INTO .sterling/ are denied — this command\'s redirect target (/tmp/sterling.db) is OUTSIDE .sterling/, so that claim is factually wrong for the case that just fired'
    );
    assert.doesNotMatch(
      r.stderr,
      /only\b[^.]*\binto\b[^.]*\.sterling/i,
      'the message must not restate the "only...into .sterling/" claim in any word order'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE for AC3: restore the old sentence claiming "only redirections
// into .sterling/ are denied" (or equivalent phrasing) in the db-seal branch
// → AC3 red.

// =========================================================================
// AC4 — regression pins: the allow surface is BYTE-IDENTICAL. Both measured
// false-positive-shaped commands (grep on a quoted pattern; a redirect OUT
// of the store that merely mentions the literal) stay DENIED. Disclosure is
// not permission. These pins are independent of message wording (AC1-3
// above) so a message-only regression cannot mask an allow-surface
// regression, and vice versa.
// =========================================================================

test('AC4a (regression floor): `grep -rn "sterling.db" skills templates` stays DENIED — disclosure does not relax the terminal seal for an otherwise-allowlisted read verb', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('grep -rn "sterling.db" skills templates', dir);
    assert.equal(
      r.code,
      2,
      'grep is normally an allowlisted store-read verb, but the raw-text DB seal is terminal per decision ccc44a8e — it must still deny regardless of verb or the literal\'s syntactic role inside a quoted pattern'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE for AC4a: narrow DB_MENTION_RE (or add a quoted-argument /
// verb-conditioned carve-out) so a "sterling.db" occurrence inside a quoted
// grep pattern no longer matches → AC4a red (this is exactly the matcher
// narrowing decisions ccc44a8e and a8bec43f reject).

test('AC4b (regression floor): `cat .sterling/config.json > /tmp/sterling.db` stays DENIED — disclosure does not relax the terminal seal for a redirect target that merely contains the literal while pointing outside .sterling/', () => {
  const { dir, cleanup } = makeProject();
  try {
    const command = `cat ${dir}/.sterling/config.json > /tmp/sterling.db`;
    const r = runHook(command, dir);
    assert.equal(
      r.code,
      2,
      'the redirect target /tmp/sterling.db lies outside .sterling/, but the raw-text DB seal fires on the literal substring anywhere in the command, terminally, per decision ccc44a8e — it must still deny'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE for AC4b: add a redirect-target carve-out that allows a redirect
// whose target is outside .sterling/ even when the literal "sterling.db"
// appears in it (i.e. resolve-then-classify the redirect target) → AC4b red
// (this is the exact carve-out decision a8bec43f rejects as exploitable via
// command substitution / quote-concatenation, and ccc44a8e reaffirms).
