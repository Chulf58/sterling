// H15 store-guard — ALLOWLIST ANCHORING pins (frozen).
//
// WHAT THIS FILE PINS, IN ONE SENTENCE: a name listed in
// `config.store_guard.allow_scripts` exempts a command fragment from
// classification ONLY when it is that fragment's EXECUTABLE argument — never
// merely because the fragment's raw text happens to contain it somewhere.
//
// PROVENANCE — a CONFIRMED, REPRODUCED bypass, not a hypothesis. Measured
// 2026-08-26 against BOTH the bundled live hook and the source (exit 2 = deny,
// exit 0 = allow). H15 tests each allow_scripts entry as a RAW UNANCHORED
// SUBSTRING of the fragment, per fragment, BEFORE classification; the fragment
// splitter is quote- and heredoc-aware but has NO `#` comment handling, so a
// comment stays inside its fragment and its text feeds the exemption. Four
// shapes measured ALLOW that must DENY:
//   (1) rm -f .sterling/sterling.db # scripts/init.mjs
//   (2) rm -rf .sterling # scripts/init.mjs
//   (3) rm -f .sterling/sterling.db --label "scripts/init.mjs"
//   (4) rm -f .sterling/sterling.db /tmp/scripts/init.mjs
// The same commands WITHOUT the sanctioned name measured DENY, and the
// cross-separator shapes (`node scripts/init.mjs ; rm -f …`, `… && rm -f …`)
// measured DENY — the per-fragment split already defends across separators.
// The hole is strictly WITHIN one fragment.
//
// WHY IT MATTERS BEYOND THE CONDUCTOR: the `rm` shapes are conductor-only
// (H14 denies `rm` for agents), but the DB SEAL is AGENT-REACHABLE —
// `grep -c . .sterling/sterling.db # scripts/init.mjs` passes H14 AND H15 and
// reaches the shell, while the identical command without the comment is
// denied. That is store read-exfiltration through the guard. See AL-5.
//
// SETTLED FIX DIRECTION (governing spec; these pins fix the OUTCOME, not the
// mechanism): a sanctioned name counts only when it is the fragment's
// executable argument — matched against tokenized fragment words with any `#`
// comment tail stripped. Nothing here pins how the tokenizer is written, and
// nothing here reopens decision ccc44a8e (`h15-broad-command-text-guard-is-
// terminal-accepted`): the broad command-TEXT classifier stays broad and
// fail-safe. This is a NARROWING OF AN EXEMPTION, which only ever removes
// allow surface — it is not the rejected resolve-then-classify redesign.
//
// Related governing records, read before authoring: decision ccc44a8e
// (broad text guard is terminal-accepted), decision fd9e96e0 (the raw
// command-text DB seal fires on ANY occurrence of the literal, before verb
// classification — which is exactly why the comment shapes are so dangerous:
// the exemption runs EARLIER and cancels the seal), decision a8bec43f
// (improving a denial NEVER loosens the allow surface), feature_article
// 7699f843 `hook-write-gates` (a gate names the DISCRIMINATOR that fired).
//
// Written BLIND to scripts/hooks/h15-store-guard.mjs (H4 read wall; the
// reproduction above is the entire spec). Harness conventions
// (runHook/CONFIG/makeProject) follow scripts/tests/h15-precision*.test.mjs
// and are reproduced STANDALONE so this file runs independently — those files
// are NEITHER modified, imported, nor duplicated by reference. Fixtures live
// only in an os.tmpdir() project built by makeProject(); no new top-level temp
// path is introduced (research_finding 01cab59b — the clean-room location gap).
//
// MUTATION DISCIPLINE (decision 23afbc83): every pin below carries a SABOTAGE
// comment naming the one-line implementation change that must turn it RED.
// None of them is executed here — this file's author holds no Bash by design.

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

// The sanctioned name every bypass shape below smuggles. Set EXPLICITLY in the
// fixture config rather than relying on the schema default, so these pins keep
// meaning if the shipped default list is ever re-ordered or trimmed.
const SANCTIONED = 'scripts/init.mjs';
// A name deliberately NOT in allow_scripts, used as the negative half of the
// control arm — it proves the ALLOWLIST is what carries an allow verdict.
const UNSANCTIONED = 'scripts/not-a-sanctioned-script.mjs';

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
  store_guard: { allow_scripts: ['scripts/init.mjs', 'scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs'] },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h15allow-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  // A REAL store db file, matching how every other hook test builds a project —
  // project-root resolution keys on .sterling/sterling.db actually existing.
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { dir, cleanup };
}

// =========================================================================
// CONTROL ARM — FIRST, DELIBERATELY.
//
// Every pin after this section asserts a DENY, and a deny verdict has MORE
// THAN ONE possible cause: the intended anchoring fix, or a fix that simply
// stops honouring allow_scripts (or denies everything). These controls must
// pass for the OPPOSITE reason, so a green run below always carries its own
// evidence that the exemption still exists and still works.
//
// AL-C1 is the shape the brief names, and it is a WEAK control ON PURPOSE:
// `node scripts/init.mjs` mentions no store path at all, so it is allowed by
// the no-store-mention path whether or not the allowlist exists. It pins that
// the fix did not turn into "deny anything mentioning a sanctioned script".
// AL-C3/AL-C4 are the STRONG control pair: identical command shapes differing
// only in whether the executed script is sanctioned, both naming the sealed
// db — the allow in C3 can ONLY come from the allowlist exemption, because C4
// proves the same shape denies without it.
// =========================================================================

test('AL-C1 (control, expect GREEN today and after): `node scripts/init.mjs` — a genuinely sanctioned launcher invocation — stays ALLOWED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`node ${SANCTIONED}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a plain sanctioned launcher invocation');
    assert.equal(
      r.code,
      0,
      'the ordinary sanctioned launcher shape must keep working — anchoring the allowlist to the executable argument must not become "deny anything that names a sanctioned script"'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the anchored allowlist check compare the sanctioned name
// against tokens[0] ONLY (the interpreter word `node`) instead of the executed
// SCRIPT argument — this pin goes red (allow 0 -> deny 2) because no token in
// executable position equals `scripts/init.mjs` under that reading.

test('AL-C2 (control, expect GREEN today and after): `node scripts/migrate-stores.mjs` — a second real launcher shape from the config list — stays ALLOWED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('node scripts/migrate-stores.mjs', dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a second sanctioned launcher invocation');
    assert.equal(
      r.code,
      0,
      'the allowlist is a LIST — the fix must anchor every entry, not special-case the one entry the bypass reproduction happened to use'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: hardcode the anchored check to the single literal
// 'scripts/init.mjs' instead of iterating config.store_guard.allow_scripts —
// this pin goes red (allow 0 -> deny 2) while AL-C1 stays green, which is
// exactly why a second launcher shape is pinned separately.

test('AL-C3 (control, STRONG half, expect GREEN today and after): `node scripts/migration-preflight.mjs .sterling/sterling.db` — a sanctioned script doing sanctioned store work — stays ALLOWED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('node scripts/migration-preflight.mjs .sterling/sterling.db', dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a sanctioned script invoked against the store db');
    assert.equal(
      r.code,
      0,
      'THIS is the load-bearing control: the fragment names the sealed db, so nothing but the allow_scripts exemption can produce an allow here. If this goes red, the fix removed the exemption rather than anchoring it, and every DENY pin below is passing for the wrong reason'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: delete the allow_scripts exemption outright (always classify) —
// this pin goes red (allow 0 -> deny 2) via the DB seal, while AL-C1/AL-C2
// stay green because they name no store path. That asymmetry is the whole
// point of pinning C3 beside C1.

test('AL-C4 (control, STRONG half — the opposite reason): `node scripts/not-a-sanctioned-script.mjs .sterling/sterling.db` is DENIED — the exemption is the only difference from AL-C3', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`node ${UNSANCTIONED} .sterling/sterling.db`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on an unsanctioned script naming the store db');
    assert.equal(
      r.code,
      2,
      'same command shape as AL-C3, same store path, only the script name differs — an UNSANCTIONED executable naming the sealed db must deny. Together C3+C4 prove the allowlist (not blanket allow, not blanket deny) is what decides'
    );
    assert.match(r.stderr, /sterling\.db/, 'the denial names the sealed db path it fired on (hook-write-gates: a gate names the discriminator)');
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the exemption match ANY script-looking `*.mjs` token in
// executable position instead of comparing against the configured list —
// this pin goes red (deny 2 -> allow 0) while AL-C3 stays green.

// =========================================================================
// AL-1 .. AL-4 — THE FOUR MEASURED BYPASS SHAPES. All four measured ALLOW (0)
// on 2026-08-26 and MUST DENY (2). Each is paired immediately with the
// already-correct control (same command, no sanctioned name) that measured
// DENY and must keep denying — so a red here is always attributable to the
// smuggled name and nothing else.
// =========================================================================

// --------------------------- AL-1: comment tail after a db-deleting rm ---------------------------

test('AL-1 (expect RED today): `rm -f .sterling/sterling.db # scripts/init.mjs` is DENIED — a sanctioned name inside a `#` comment is not an invocation', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`rm -f .sterling/sterling.db # ${SANCTIONED}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a fragment carrying a `#` comment — a crash is not a decision');
    assert.equal(
      r.code,
      2,
      'MEASURED BYPASS: today the raw unanchored substring test sees `scripts/init.mjs` in the comment text and exempts the whole fragment BEFORE classification, so a delete of the sealed store db is allowed. The executed command is `rm -f .sterling/sterling.db`; the comment executes nothing'
    );
    assert.match(r.stderr, /sterling\.db/, 'the denial names the sealed db path, not the comment');
  } finally {
    cleanup();
  }
});
// SABOTAGE: restore the raw unanchored substring test
// (`fragment.includes(entry)`) for the allowlist check — this pin goes red
// (deny 2 -> allow 0), reproducing the measured bypass exactly.
// WHICH GUARD CARRIES THE VERDICT — checked, not assumed: this pin is DEFENSE
// IN DEPTH. Executable-argument anchoring alone denies it (the exec word is
// `rm`), AND comment-tail stripping alone denies it (stripping removes the
// only occurrence of the name). So a SINGLE-layer mutation leaves it GREEN;
// only reverting to raw-substring-over-the-whole-fragment turns it red. The
// pins that isolate one layer each are AL-3 (exec position) and AL-9 (token
// boundary) — do not read this pin as evidence for either layer alone.
// (CORRECTED 2026-08-26: AL-4 does not isolate token boundary — see AL-4's
// own corrected comments and AL-9 below.)

test('AL-1-control (expect GREEN today and after): `rm -f .sterling/sterling.db` — same command, no sanctioned name — stays DENIED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('rm -f .sterling/sterling.db', dir);
    assert.equal(r.code, 2, 'the already-correct behaviour: deleting the sealed store db by shell is denied, and the anchoring fix must not disturb it');
  } finally {
    cleanup();
  }
});
// SABOTAGE: exempt any fragment whose text contains a `#` from classification
// (a naive "it's just a comment" shortcut) — this control stays green, but
// pair it with AL-1 which would go red; that pairing is what makes the AL-1
// verdict attributable to the smuggled NAME rather than to the `rm` shape.

// --------------------------- AL-2: comment tail after a recursive store delete ---------------------------

test('AL-2 (expect RED today): `rm -rf .sterling # scripts/init.mjs` is DENIED — a comment must not exempt a recursive delete of the whole store directory', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`rm -rf .sterling # ${SANCTIONED}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a commented recursive delete');
    assert.equal(
      r.code,
      2,
      'MEASURED BYPASS: the most destructive shape there is — `rm -rf .sterling` — is allowed today purely because a sanctioned script name follows a `#`. Pinned separately from AL-1 because it exercises the store DIRECTORY matcher, not the db seal'
    );
    assert.match(r.stderr, /\.sterling/, 'the denial names the store directory it fired on');
  } finally {
    cleanup();
  }
});
// SABOTAGE: restore the raw unanchored substring test for the allowlist check
// — this pin goes red (deny 2 -> allow 0). Same defense-in-depth caveat as
// AL-1: either layer alone is sufficient, so a single-layer mutation leaves it
// green. Kept distinct from AL-1 because it is the DIRECTORY matcher, and a
// fix that anchored only the db-seal path would leave this one open.

test('AL-2-control (expect GREEN today and after): `rm -rf .sterling` — same command, no sanctioned name — stays DENIED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('rm -rf .sterling', dir);
    assert.equal(r.code, 2, 'the already-correct behaviour: recursively deleting the store directory is denied, and the anchoring fix must not disturb it');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop `.sterling` (the directory form) from the store matcher,
// keeping only `sterling.db` — this control goes red (deny 2 -> allow 0),
// which is how you tell an AL-2 regression caused by the matcher apart from
// one caused by the exemption.

// --------------------------- AL-3: sanctioned name inside a QUOTED ARGUMENT ---------------------------
// AL-3 IS THE PIN THAT ISOLATES EXECUTABLE-POSITION ANCHORING. No comment is
// involved, and after quote handling `scripts/init.mjs` is an exact TOKEN of
// the fragment — so an implementation that tokenizes and then matches the name
// against ANY token still allows this. Only "the sanctioned name must be the
// fragment's EXECUTABLE argument" closes it. Do not merge this with AL-4.

test('AL-3 (expect RED today): `rm -f .sterling/sterling.db --label "scripts/init.mjs"` is DENIED — a sanctioned name inside a quoted ARGUMENT is data, not an invocation', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`rm -f .sterling/sterling.db --label "${SANCTIONED}"`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a quoted argument carrying a sanctioned name');
    assert.equal(
      r.code,
      2,
      'MEASURED BYPASS: the executed program is `rm`. A sanctioned script name appearing as the VALUE of some flag is data the guard must ignore — the exemption belongs to the executable argument alone'
    );
    assert.match(r.stderr, /sterling\.db/, 'the denial names the sealed db path');
  } finally {
    cleanup();
  }
});
// SABOTAGE (single-layer, ISOLATING): match the sanctioned name against ANY
// token of the fragment instead of the EXECUTABLE argument — this pin goes red
// (deny 2 -> allow 0) while AL-4 stays green (its token is
// `/tmp/scripts/init.mjs`, not an exact match) and AL-1/AL-2 stay green
// (comment stripping still removes their occurrence). AL-3 is therefore the
// sole load-bearing pin for exec-position anchoring.

test('AL-3-control (expect GREEN today and after): `rm -f .sterling/sterling.db --label "x"` — same shape, unsanctioned quoted value — stays DENIED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('rm -f .sterling/sterling.db --label "x"', dir);
    assert.equal(r.code, 2, 'the flag/quote shape itself is not what allows AL-3 today — with an unsanctioned value the same command already denies');
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the fragment splitter quote-BLIND so a quoted region is
// dropped from the classified text — this control goes red (deny 2 -> allow 0)
// if the store path is ever moved inside quotes; it also proves the AL-3
// verdict is about the NAME, not about quoting.

// --------------------------- AL-4: sanctioned name as an unrelated PATH TOKEN (redundant with AL-3) ---------------------------
// CORRECTED 2026-08-26 (CORRECTION 2): this pin does NOT isolate
// token-boundary matching, as originally claimed here. `/tmp/scripts/init.mjs`
// sits in ARGUMENT position behind the executable `rm`, so exec-position
// anchoring — the same guard AL-3 pins — already denies this fragment (the
// executable itself, `rm`, is not a sanctioned name) before any token-boundary
// comparison on the lookalike path is even reached. Measured via mutation: an
// `endsWith`-instead-of-equality sabotage on the allowlist match leaves this
// pin GREEN, because the sanctioned-name comparison the sabotage targets never
// runs against this fragment's lookalike token. AL-4 is kept (not deleted — a
// redundant pin is not a wrong one) as a realistic path-lookalike shape,
// redundant with AL-3. AL-9, added below, is the pin that actually isolates
// token-boundary equality.

test('AL-4 (expect RED today): `rm -f .sterling/sterling.db /tmp/scripts/init.mjs` is DENIED — a path that merely CONTAINS the sanctioned name is a different path', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`rm -f .sterling/sterling.db /tmp/${SANCTIONED}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a fragment carrying a lookalike path token');
    assert.equal(
      r.code,
      2,
      'MEASURED BYPASS: `/tmp/scripts/init.mjs` is an unrelated file that happens to end with the sanctioned name. An unanchored substring test cannot tell it from the real launcher, and it is trivially attacker-chosen — any writable directory ending in the sanctioned suffix unlocks the store'
    );
    assert.match(r.stderr, /sterling\.db/, 'the denial names the sealed db path');
  } finally {
    cleanup();
  }
});
// SABOTAGE (does NOT isolate token-boundary — see the corrected header above):
// mutating the allowlist match from whole-word equality to
// `token.endsWith(entry)` does NOT turn this pin red. This fragment's
// executable is `rm`, not a `node`-plus-script invocation, so exec-position
// anchoring alone already denies it — the executable itself is never a
// sanctioned name, regardless of how the (unreached) token comparison on the
// lookalike path is written. The sabotage that DOES turn AL-4 red is the same
// one that turns AL-3 red: match the sanctioned name against ANY token in the
// fragment instead of the executable argument alone — this pin goes red
// (deny 2 -> allow 0) together with AL-3, which is exactly why AL-4 is
// redundant with it rather than an independent layer.

test('AL-4-control (expect GREEN today and after): `rm -f .sterling/sterling.db /tmp/other.mjs` — same shape, no sanctioned name — stays DENIED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('rm -f .sterling/sterling.db /tmp/other.mjs', dir);
    assert.equal(r.code, 2, 'a second path argument does not itself change the verdict — with no sanctioned name the same command already denies');
  } finally {
    cleanup();
  }
});
// SABOTAGE: classify only the FIRST path-looking argument of a fragment — this
// control stays green while a store path in a later position would slip; the
// pair (AL-4 + this control) attributes AL-4's verdict to the NAME rather than
// to argument position.

// --------------------------- AL-9: token-boundary equality on the EXECUTABLE argument (the pin AL-4 does not isolate) ---------------------------
// ADDED 2026-08-26 (CORRECTION 2). The mutation run showed AL-4 does not
// isolate token-boundary equality — its lookalike sits in ARGUMENT position
// behind `rm`, so exec-position anchoring denies it before any endsWith/
// equality comparison is reached (see the corrected AL-4 comments above).
// This is the genuinely isolating shape: under `node /tmp/scripts/init.mjs
// .sterling/sterling.db`, `/tmp/scripts/init.mjs` IS the script argument to
// the `node` interpreter — the exact token compared against allow_scripts in
// executable position — and it merely ENDS WITH the sanctioned
// `scripts/init.mjs`; it is not equal to it. Only whole-word equality (not
// `endsWith`) on that comparison closes this.

test('AL-9-control (control, expect GREEN today and after): `node scripts/init.mjs .sterling/sterling.db` — the genuinely sanctioned launcher against the sealed db — stays ALLOWED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`node ${SANCTIONED} .sterling/sterling.db`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on the sanctioned launcher invoked against the store db');
    assert.equal(
      r.code,
      0,
      'THIS is the load-bearing control for AL-9: the fragment names the sealed db, so only the allow_scripts exemption on the exact sanctioned name can produce an allow here. If this goes red, the fix removed or over-narrowed the exemption rather than tightening its comparison, and AL-9 below would be passing for the wrong reason'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: delete the allow_scripts exemption outright (always classify) —
// this pin goes red (allow 0 -> deny 2), the same class of sabotage as AL-C3,
// kept local to this pair so AL-9's deny cannot be misread as evidence the
// exemption was removed entirely rather than merely tightened to whole-word
// equality.

test('AL-9 (expect RED today): `node /tmp/scripts/init.mjs .sterling/sterling.db` is DENIED — the executed script only ENDS WITH the sanctioned name, it is not equal to it', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`node /tmp/${SANCTIONED} .sterling/sterling.db`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a node invocation whose script argument merely ends with a sanctioned name');
    assert.equal(
      r.code,
      2,
      "MEASURED GAP: the interpreter's first non-flag argument is `/tmp/scripts/init.mjs`, a different, attacker-choosable path that merely ENDS WITH the sanctioned `scripts/init.mjs`. It occupies the same executable-argument POSITION that the AL-9-control/AL-C1/AL-C3 launcher shapes use, so exec-position anchoring alone does not close this — only whole-word equality on that argument does"
    );
    assert.match(r.stderr, /sterling\.db/, 'the denial names the sealed db path it fired on');
  } finally {
    cleanup();
  }
});
// SABOTAGE: match allow_scripts with `token.endsWith(entry)` instead of
// whole-word equality — this pin goes red (deny 2 -> allow 0) while
// AL-9-control, AL-C1, AL-C2, and AL-C3 all stay green (their script arguments
// are exactly equal to a sanctioned entry, which endsWith also accepts), and
// while AL-4 stays green too (its lookalike never reaches the
// executable-argument comparison at all, per the corrected AL-4 comments).
// AL-9 is therefore the sole load-bearing pin for token-boundary equality on
// the executable argument.

// =========================================================================
// AL-5 — THE AGENT-REACHABLE READ-EXFILTRATION SHAPE.
//
// DO NOT "SIMPLIFY THIS AWAY AS A DUPLICATE OF THE rm SHAPES." It is the only
// pin in this file describing a bypass a SUBAGENT can actually execute. H14
// (the bash allowlist, agent-frontmatter-scoped) denies `rm` for agents, so
// AL-1..AL-4 are conductor-only. `grep` is NOT denied by H14 and IS in H15's
// READONLY_VERBS — the sealed db is what normally stops it. With a `#` comment
// carrying a sanctioned name, the exemption fires BEFORE the db seal and the
// command reaches the shell: a subagent can read the store's bytes out.
// The equivalent statement for the record: this is the pin that makes the
// defect a security bypass rather than a conductor papercut.
// =========================================================================

test('AL-5 (expect RED today, AGENT-REACHABLE): `grep -c . .sterling/sterling.db # scripts/init.mjs` is DENIED — store read-exfiltration through the comment exemption', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`grep -c . .sterling/sterling.db # ${SANCTIONED}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a commented grep of the store db');
    assert.equal(
      r.code,
      2,
      'MEASURED BYPASS, AGENT-REACHABLE: this passes H14 (grep is allowed for agents) and today passes H15 too, reaching the shell and reading the sealed store db. The DB seal is universal and verb-independent (decision fd9e96e0); the allowlist exemption must never run ahead of it for a name that is not the executable argument'
    );
    assert.match(r.stderr, /sterling\.db/, 'the denial names the sealed db path it fired on');
  } finally {
    cleanup();
  }
});
// SABOTAGE: restore the raw unanchored substring test for the allowlist check
// — this pin goes red (deny 2 -> allow 0). Defense-in-depth caveat as AL-1:
// exec-position anchoring alone and comment-stripping alone each suffice, so a
// single-layer mutation leaves it green. Its independent value is COVERAGE of
// a READ verb, not of a delete: a fix that anchored the exemption only on the
// write/destructive classification path would leave this one open, and AL-1..4
// would not notice.

test('AL-5-control (expect GREEN today and after): `grep -c . .sterling/sterling.db` — same read, no comment — stays DENIED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('grep -c . .sterling/sterling.db', dir);
    assert.equal(
      r.code,
      2,
      'the already-correct behaviour that makes AL-5 a bypass rather than a policy question: grep is a READONLY_VERB and the db seal denies it anyway, so the only difference between this and AL-5 is the comment'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: add `grep` to a set that skips the db seal for read-only verbs —
// this control goes red (deny 2 -> allow 0), which would silently make AL-5
// unpinnable; keep the pair together.

// =========================================================================
// NON-REGRESSION — the behaviours that are ALREADY CORRECT and must survive
// the fix. Measured DENY on 2026-08-26.
//
// The cross-separator shapes matter because they are the closest neighbours of
// this defect: the per-fragment split ALREADY defends across `;`, `&&`. If a
// fix restructured fragment splitting while anchoring the allowlist, these are
// what would break, and they would break SILENTLY into a false-ALLOW.
// =========================================================================

test('AL-6a (expect GREEN today and after): `node scripts/init.mjs ; rm -f .sterling/sterling.db` stays DENIED — a sanctioned fragment never exempts its `;` neighbour', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`node ${SANCTIONED} ; rm -f .sterling/sterling.db`, dir);
    assert.equal(
      r.code,
      2,
      'the per-fragment split already defends across `;` — the exemption is scoped to the fragment that carries the sanctioned executable, and the second fragment is classified on its own merits'
    );
    assert.match(r.stderr, /sterling\.db/, 'the denial names the sealed db path in the offending fragment');
  } finally {
    cleanup();
  }
});
// SABOTAGE: apply the allowlist exemption to the WHOLE COMMAND STRING once
// (any sanctioned executable anywhere exempts everything) instead of per
// fragment — this pin goes red (deny 2 -> allow 0) while AL-C1/AL-C3 stay
// green, isolating fragment-scoping as the guard under test.

test('AL-6b (expect GREEN today and after): `node scripts/init.mjs && rm -f .sterling/sterling.db` stays DENIED — same for `&&`', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`node ${SANCTIONED} && rm -f .sterling/sterling.db`, dir);
    assert.equal(
      r.code,
      2,
      '`&&` splits fragments exactly like `;` — pinned separately because a splitter rewrite can easily handle one separator and drop the other'
    );
    assert.match(r.stderr, /sterling\.db/, 'the denial names the sealed db path in the offending fragment');
  } finally {
    cleanup();
  }
});
// SABOTAGE: remove `&&` from the fragment separator set (keep `;`) — this pin
// goes red (deny 2 -> allow 0) while AL-6a stays green.

// --------------------------- AL-7: comment stripping must not become a NEW allow surface ---------------------------
// THE MIRROR-IMAGE HAZARD, pinned deliberately. The fix strips a `#` comment
// tail for the purpose of the ALLOWLIST TOKEN MATCH. It must NOT strip comments
// before CLASSIFICATION: decisions ccc44a8e and a8bec43f settled that H15's
// broad command-TEXT matcher denies a store reference in ANY syntactic role,
// prose included, and that the allow surface is never loosened to fix
// ergonomics. If comment-stripping were applied to classification, a store
// mention inside a comment would stop denying — the same class of hole as the
// one this file closes, in the opposite direction.
//
// CORRECTED 2026-08-26 (CORRECTION 1): this pin originally asserted DENY on
// `ls /tmp # .sterling/config.json` and was invalid as written — RED at
// baseline, before any fix. `ls` is in READONLY_VERBS and `config.json` is a
// NON-DB store file, which decision 0b4d3c8c deliberately ALLOWS regardless of
// any comment (h15-precision.test.mjs pins that exact allow green), so the
// two suites contradicted each other and the precision pin matches the live
// ruling. The INTENT survives unchanged — comment text must still reach the
// deny classifier, and comment-stripping stays confined to the exemption
// match — carried instead by the DB path, which is unconditionally denied
// (decision fd9e96e0) and so gives the pin a command that genuinely flips
// ALLOW->DENY under the sabotage below. Do not reintroduce the config.json
// form: it is a legitimately allowed non-DB store read.

test('AL-7 (expect GREEN today and after): `ls /tmp # .sterling/sterling.db` stays DENIED — comment stripping is for the allowlist match ONLY, never for classification', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('ls /tmp # .sterling/sterling.db', dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a commented store mention');
    assert.equal(
      r.code,
      2,
      'H15 matches command TEXT by settled design (decisions ccc44a8e + a8bec43f): a store DB path in a comment still denies, fail-safe, with a one-keystroke workaround. Narrowing the classifier to ignore comments would be a LOOSENING of the allow surface, which is exactly what those decisions forbid — and it is not what the anchoring fix is licensed to do. (Not `.sterling/config.json`: that non-DB store file is deliberately ALLOWED by decision 0b4d3c8c even without a comment, so it cannot pin this behaviour — see the correction note above.)'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: strip the `#` comment tail from the fragment before CLASSIFICATION
// (rather than only before the allowlist token match) — this pin goes red
// (deny 2 -> allow 0) while every other pin in this file stays green. AL-7 is
// the sole guard against the fix over-reaching into the classifier.

// --------------------------- AL-8: the ambiguous case, resolved ---------------------------
// A sanctioned name in EXECUTABLE position AND again as a plain argument.
// VERDICT: ALLOW. Reasoning, stated so a later reader can overturn it on
// argument rather than on taste — the settled spec keys the exemption on the
// fragment's EXECUTABLE argument, and here that argument IS sanctioned. What
// the defect is about is a NON-sanctioned executable (`rm`, `grep`) borrowing
// a sanctioned name from elsewhere in its text; that is absent here. The
// premise of allow_scripts is that a sanctioned script may do store work with
// whatever arguments it takes, so denying because a data argument repeats the
// script's own name would break real invocations for a reason unrelated to the
// hole (e.g. a launcher passed its own path for re-exec or self-check).
// FLAGGED AS GENUINELY ARGUABLE: the opposite reading — "a sanctioned name in
// a non-executable position is always suspicious, deny it even when the
// executable is sanctioned" — is defensible and would make this pin's expected
// verdict 2. It is NOT settled by the brief. If the implementer disagrees,
// that is a spec question for the conductor, not a test to quietly edit.
// The store path below is deliberate: without it the fragment mentions no
// store at all and would be allowed by the no-store-mention path, making the
// pin hollow — with it, only the exemption can produce the allow.

test('AL-8 (expect GREEN today; verdict ALLOW after the fix — see the arguable-case note above): `node scripts/init.mjs .sterling/sterling.db scripts/init.mjs` is ALLOWED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`node ${SANCTIONED} .sterling/sterling.db ${SANCTIONED}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash when a sanctioned name appears in two positions');
    assert.equal(
      r.code,
      0,
      'the EXECUTABLE argument is sanctioned, which is the whole test the settled fix direction states; a repeated occurrence in argument position neither adds nor removes authority. If this is meant to deny, the spec must say so explicitly — do not flip it silently'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: after finding the sanctioned executable, additionally require that
// NO other token equals a sanctioned name (a "suspicious repetition" rule) —
// this pin goes red (allow 0 -> deny 2) while AL-C3 stays green. That mutation
// is precisely the alternative reading flagged above, so a red here is a SPEC
// DISAGREEMENT to escalate, not necessarily a defect.
