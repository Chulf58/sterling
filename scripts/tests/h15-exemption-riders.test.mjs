// H15 store-guard — EXEMPTION RIDER pins (frozen). Board 98889ecd.
//
// IN ONE SENTENCE: a sanctioned `allow_scripts` executable exempts a fragment
// from classification ONLY when that invocation is RIDER-FREE — a command
// substitution, process substitution, or a redirect INTO the store riding on
// the same fragment sends it back through ordinary classification.
//
// PROVENANCE — a REPRODUCED bypass. `fragmentRunsSanctionedScript` is correctly
// anchored to the executable word, but its call site did a bare `continue`,
// skipping classifyFragment entirely. The acceptance premise ("the attacker
// must already be running a sanctioned script") is FALSE: the attacker need
// only INVOKE an existing sanctioned filename and attach shell syntax —
// `$(...)`, backticks and `<(...)`/`>(...)` execute in the SHELL before, or
// independently of, the sanctioned program, and a redirect can damage the store
// using the launcher's own output. Measured with the bare `continue` restored,
// ALL SIX rider shapes below exit 0 (ALLOW), including
// `node scripts/init.mjs "$(cat .sterling/sterling.db)"` — store
// read-exfiltration straight past the DB seal.
//
// GOVERNING RULINGS: decision ccc44a8e (classify-by-static-text is the TERMINAL
// design; resolve-then-classify is REJECTED) — these pins narrow only the
// EXEMPTION, never the DENY surface, which is what keeps them legal. Decision
// 2c3e3136 (a full shell tokenizer was built, reviewed and PARKED TWICE) — so
// the check is deliberately COARSE: any substitution syntax at all disqualifies,
// even a read-only one, because classifyFragment returns a fragment-wide verdict
// with no provenance saying which text produced a finding. Decision fd9e96e0
// (the raw command-text DB seal fires on ANY occurrence of the literal).
//
// ACCEPTED NEW DENIALS (do NOT pin these as allows): a launcher with an
// unrelated substitution (`--label "$(date)"`); a read-only store access inside
// a substitution; literal/escaped `$(`/backticks in launcher data. Refine only
// from a real incident.
//
// HARNESS: the H15 hook is run DIRECTLY (never the combined H14+H15 pipeline,
// whose exit code another layer could carry). Conventions follow
// scripts/tests/h15-allowlist-anchoring.test.mjs:75-93, reproduced STANDALONE.
//
// MUTATION DISCIPLINE (decision 23afbc83): every pin carries a SABOTAGE comment
// naming the one-line change that must turn it RED. All were EXECUTED against
// the source hook 2026-08-27; the recorded outcome is in each comment.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

// Set EXPLICITLY in the fixture config rather than relying on the schema
// default, so these pins keep meaning if the shipped list is re-ordered.
const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
  store_guard: { allow_scripts: ['scripts/init.mjs', 'scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs'] },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h15rider-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  // A REAL store db — project-root resolution keys on it existing.
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { dir, cleanup };
}

// =========================================================================
// CONTROL ARM — FIRST, DELIBERATELY. Every pin after this asserts a DENY, and
// a deny has more than one possible cause (the intended narrowing, or a fix
// that stopped honouring allow_scripts at all). RID-C1/C2 must pass for the
// OPPOSITE reason: they name the SEALED DB, so nothing but the exemption can
// produce an allow. FALSE DENY IS THE RANKED RISK — a fix that denies the
// configured launchers is worse than the hole it closes.
// =========================================================================

test('RID-C1 (control, STRONG): `node scripts/migration-preflight.mjs --db .sterling/sterling.db` — the bc0f81e3 remediation floor, direct --db form — stays ALLOWED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('node scripts/migration-preflight.mjs --db .sterling/sterling.db', dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a sanctioned launcher');
    assert.equal(r.code, 0, 'THE load-bearing control: the fragment names the sealed db, so only the allow_scripts exemption can allow it. Red here means the narrowing became "deny the launchers", and every DENY pin below is passing for the wrong reason');
  } finally { cleanup(); }
});
// SABOTAGE (executed): force the anchored allowlist result to false at the call
// site — this pin goes red (allow 0 -> deny 2) via the DB seal. CARRIER: the
// allowlist exemption.

test('RID-C2 (control, STRONG): `node scripts/migrate-stores.mjs --db .sterling/sterling.db` — the second half of the remediation floor — stays ALLOWED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('node scripts/migrate-stores.mjs --db .sterling/sterling.db', dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a sanctioned launcher');
    assert.equal(r.code, 0, 'the allowlist is a LIST — the narrowing must leave every configured launcher working, not just the one the reproduction used');
  } finally { cleanup(); }
});
// SABOTAGE (executed): same as RID-C1 — red (allow 0 -> deny 2). CARRIER: the
// allowlist exemption.

test('RID-C3 (control, opposite reason): `node scripts/not-sanctioned.mjs --db .sterling/sterling.db` is DENIED — the exemption is the only difference from RID-C1', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('node scripts/not-sanctioned.mjs --db .sterling/sterling.db', dir);
    assert.equal(r.code, 2, 'same shape, same store path, unsanctioned executable — RID-C1+RID-C3 together prove the ALLOWLIST decides, not blanket allow and not blanket deny');
    assert.match(r.stderr, /sterling\.db/, 'the denial names the discriminator it fired on');
  } finally { cleanup(); }
});
// SABOTAGE (executed): exempt any `*.mjs` in executable position instead of the
// configured list — red (deny 2 -> allow 0) while RID-C1 stays green.

test('RID-C4 (control, weak by design): `node scripts/init.mjs --label plain-value` — a sanctioned launcher with an ordinary quoted-free argument — stays ALLOWED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('node scripts/init.mjs --label plain-value', dir);
    assert.equal(r.code, 0, 'an ordinary launcher argument is not a rider — the narrowing must not degenerate into "deny any launcher with arguments"');
  } finally { cleanup(); }
});
// SABOTAGE (executed): this pin is WEAK ON PURPOSE — it names no store path, so
// it stays green under the exemption sabotage and only reddens if the rider
// check starts firing on ordinary argument text. That asymmetry vs RID-C1 is
// why both are pinned.

// =========================================================================
// RID-1 .. RID-6 — THE RIDER SHAPES. Every one measured ALLOW (exit 0) with the
// bare `continue` and MUST DENY (exit 2). Restoring the bare `continue` turns
// all six green-to-red at once, which is how we know no other deny layer is
// silently carrying them.
// =========================================================================

test('RID-1: `node scripts/init.mjs > .sterling/config.json` is DENIED — a sanctioned launcher does not sanction a redirect INTO the store', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('node scripts/init.mjs > .sterling/config.json', dir);
    assert.notEqual(r.code, null, 'the gate must not crash');
    assert.equal(r.code, 2, 'the launcher writes the store with its own output — the shell performs the redirect, not the sanctioned program');
  } finally { cleanup(); }
});
// SABOTAGE (executed): drop `redirectsIntoStore(fragment)` from the rider
// helper — red (deny 2 -> allow 0). CARRIER: the redirect classifier.

test('RID-2: `node scripts/init.mjs "$(cat .sterling/sterling.db)"` is DENIED — a command substitution reads the sealed db in the shell, before the launcher runs', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('node scripts/init.mjs "$(cat .sterling/sterling.db)"', dir);
    assert.equal(r.code, 2, 'store read-exfiltration through the exemption — this shape measured ALLOW before the fix');
    // NOT /sterling\.db/ — the GENERIC denial body also contains
    // ".sterling/sterling.db is sealed … for EVERY verb" (h15-store-guard.mjs:785),
    // so that pattern is satisfied by an ordinary unknown-verb deny too. MEASURED
    // 2026-08-27: with the DB seal disabled this shape still denies generically and
    // still matches /sterling\.db/, while the pattern below correctly goes red.
    assert.match(r.stderr, /raw command-text DB seal|Matched substring/, 'the DB-SEAL discriminator must be what fires — assert the discriminator, never exit code alone, and never a pattern the generic denial also satisfies');
  } finally { cleanup(); }
});
// SABOTAGE (executed): drop the `\$\(` alternative from the rider regex — red
// (deny 2 -> allow 0). CARRIER: the DB seal, reached only because the rider
// check refused the exemption.

test('RID-3: `node scripts/init.mjs "$(rm .sterling/config.json)"` is DENIED — a substitution that MUTATES a non-db store file', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('node scripts/init.mjs "$(rm .sterling/config.json)"', dir);
    assert.equal(r.code, 2, 'the substitution runs in the shell; `rm` is an unknown verb naming the store and must classify closed');
  } finally { cleanup(); }
});
// SABOTAGE (executed): drop `\$\(` from the rider regex — red (deny 2 -> allow
// 0). CARRIER: default-closed unknown-verb classification (NOT the DB seal —
// this shape names no db path, which is why it is pinned separately from RID-2).

test('RID-4: a BACKTICK substitution rider on a sanctioned launcher is DENIED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('node scripts/init.mjs "`cat .sterling/sterling.db`"', dir);
    assert.equal(r.code, 2, 'backticks are command substitution too — the older spelling must not be a hole the `$()` spelling is not');
    assert.match(r.stderr, /raw command-text DB seal|Matched substring/, 'the DB-seal discriminator fires — see the RID-2 note on why /sterling\\.db/ is not discriminating');
  } finally { cleanup(); }
});
// SABOTAGE (executed): drop the backtick alternative from the rider regex — red
// (deny 2 -> allow 0) while RID-2/RID-3 stay green. CARRIER: the DB seal.

test('RID-5: `node scripts/init.mjs <(cat .sterling/sterling.db)` is DENIED — PROCESS substitution also executes in the shell', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('node scripts/init.mjs <(cat .sterling/sterling.db)', dir);
    assert.equal(r.code, 2, 'process substitution spawns its own shell command independently of the sanctioned program');
    assert.match(r.stderr, /raw command-text DB seal|Matched substring/, 'the DB-seal discriminator fires — see the RID-2 note on why /sterling\\.db/ is not discriminating');
  } finally { cleanup(); }
});
// SABOTAGE (executed): drop the `[<>]\(` alternative — red (deny 2 -> allow 0).
// CARRIER: the DB seal.

test('RID-6: `node scripts/init.mjs >(tee .sterling/config.json)` is DENIED — output process substitution writing the store', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('node scripts/init.mjs >(tee .sterling/config.json)', dir);
    assert.equal(r.code, 2, 'the `>(...)` form writes the store through a spawned command');
  } finally { cleanup(); }
});
// SABOTAGE (executed, BOTH ARMS — this pin has TWO carriers and a single-guard
// mutation does NOT redden it, which is defense-in-depth, not hollowness):
// dropping `[<>]\(` alone leaves it green (redirectsIntoStore fails closed on
// the unparseable `(tee` target); dropping `redirectsIntoStore` alone also
// leaves it green (the `>(` alternative fires). Restoring the bare `continue`
// (removing the eligibility check entirely) reddens it: deny 2 -> allow 0.

// =========================================================================
// NON-REGRESSION + FAIL-CLOSED
// =========================================================================

test('RID-7 (non-regression): `node scripts/init.mjs > /tmp/out.txt` stays ALLOWED — an OUTWARD redirect is not a rider (decision 0b4d3c8c: only redirections INTO the store are writes)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('node scripts/init.mjs > /tmp/out.txt', dir);
    assert.equal(r.code, 0, 'the narrowing must not become "any redirect on a launcher denies" — that would break ordinary log capture');
  } finally { cleanup(); }
});
// SABOTAGE (executed as design check): replace `redirectsIntoStore(fragment)`
// in the rider helper with a bare `/[<>]/` test — red (allow 0 -> deny 2).

test('RID-8 (STRUCTURAL, deliberately — not a behavioural pin): the rider call sits INSIDE the fragment loop\'s fail-closed try, so a throw there DENIES instead of exiting non-2', () => {
  // WHY STRUCTURAL: H15 exposes no runtime seam that makes the helper throw, and
  // the obvious behavioural proxy (an unparseable config) is answered by the
  // config guard at h15-store-guard.mjs:203-209, long BEFORE the fragment loop —
  // that assertion passes byte-identically with or without this diff, so it pins
  // nothing. This reads the source instead, in the spirit of H3's AC4.
  // The behavioural evidence is a MUTATION, executed 2026-08-27: replacing the
  // helper body with `throw` turned RID-C1/RID-C2 from allow 0 into deny 2
  // carrying "Internal error while evaluating shell command safety … the gate
  // fails closed rather than risk a silent void".
  const src = readFileSync(join(HOOKS, 'h15-store-guard.mjs'), 'utf8');
  const loopTry = src.indexOf('let offending = null;');
  const riderCall = src.indexOf('sanctionedFragmentHasShellRider(frag)');
  const failClosedCatch = src.indexOf('Internal error while evaluating shell command safety');
  assert.notEqual(loopTry, -1, 'the fragment loop preamble must still be findable — if this moved, re-anchor the pin rather than deleting it');
  assert.notEqual(riderCall, -1, 'the rider check must still be called from the fragment loop');
  assert.notEqual(failClosedCatch, -1, 'the fail-closed evaluation catch must still exist');
  assert.ok(loopTry < riderCall, 'the rider call must come AFTER the fragment loop\'s try opens — outside it, a throw exits non-2 and the platform ALLOWS the command unexamined (F5 fail-open, anti_pattern e13f0fb5)');
  assert.ok(riderCall < failClosedCatch, 'and BEFORE the catch that converts an evaluation throw into a denial');
});
// SABOTAGE (executed): hoist the rider call above `let offending = null;` — red.
// CARRIER: the internal-error catch around the fragment loop.
