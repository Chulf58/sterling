// H1 SessionStart — TDD/mutation-verification POSTURE LINE (slice 3C, board
// 7e7279c4, objective dome-farmer-issues-2026-09-05).
// SPEC-ONLY, blind to the coder's parallel implementation.
//
// Governing knowledge: decision foreign_752caf98 (tdd-and-mutation-toggles-in-
// system-tab) — OFF silences the automatic default only, explicit asks
// still work, both toggles independently default TRUE when absent from
// config. Board 7e7279c4: the toggles were prose-only in CLAUDE.md, unread
// by any hook; this line is the fix for H1's half of that gap.
//
// THE SPEC (from the dispatch brief): H1 prints exactly one line, after the
// existing MACHINE ROLE line, read live from loadConfig:
//   "TDD posture: tests-first OFF · mutation verification OFF
//    (config.tdd.enabled / config.mutation_verification.enabled — TUI
//    System tab; explicit asks still work)"
// with ON/OFF independently reflecting config.tdd.enabled and
// config.mutation_verification.enabled.
//
// Harness copied from scripts/tests/h1-accuracy.test.mjs (SterlingStore
// import, BASE_CONFIG, h1()/additionalContext() helpers, STERLING_NO_BANNER/
// STERLING_PLUGIN_ROOT env). CURRENT STATE: H1 now reads both config keys
// and renders the posture line described above; every test below is green
// at HEAD and proves the live ON/OFF/UNKNOWN gating, not merely that the
// string was once absent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildSeamHook } from './lib/seam-hook.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

let SterlingStore;
// H1_SEAM (decision foreign_95c2c109 F2, harness idiom copied from
// scripts/tests/hooks-full.test.mjs's "H1 machine role" tests): H1's
// pluginRoot() resolution is walkUpPluginRoot() || STERLING_PLUGIN_ROOT, and
// scripts/hooks/h1-session-start.mjs's own walk-up always finds THIS repo
// (it lives inside it), so faking the plugin root through the env var
// against the SOURCE hook is inert — the walk-up wins every time and the
// MACHINE ROLE line never appears, because samePath(cwd, pluginRoot()) is
// never true. A bundle built into a marker-free temp dir (buildSeamHook)
// makes the walk-up genuinely fail so the env seam is legitimately reached.
// This is used by exactly one test below (the ordering pin, which needs the
// MACHINE ROLE line to exist at all) — the other four posture-line tests
// don't depend on it and keep using the plain HOOKS-sourced runHook.
let H1_SEAM;
before(async () => {
  H1_SEAM = await buildSeamHook('h1-session-start.mjs');
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});
after(() => {
  H1_SEAM?.cleanup();
});

function runHook(script, input, cwd, env = {}) {
  return runHookAt(join(HOOKS, script), input, cwd, env);
}
// Same envelope, explicit hook path — for a bundle built outside scripts/hooks/
// (the H1_SEAM case).
function runHookAt(hookPath, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

// Base toolchain/caps config every fixture project needs — mirrors the sibling h1
// test files' CONFIG so H1's other guarded reads (context_watch, caps) don't warn
// or misbehave and pollute the assertions below.
const BASE_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
};

function makeProject(configOverride = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1-tdd-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const config = { ...BASE_CONFIG, ...configOverride };
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function h1(dir, source = 'startup', envOverride = {}) {
  const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart', source }), dir, {
    NO_COLOR: '1',
    STERLING_NO_BANNER: '1',
    STERLING_PLUGIN_ROOT: root,
    ...envOverride,
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // caller asserts
  }
  return { ...r, out };
}

function additionalContext(res) {
  return res.out && res.out.hookSpecificOutput ? res.out.hookSpecificOutput.additionalContext : undefined;
}

const POSTURE_SUFFIX =
  '(config.tdd.enabled / config.mutation_verification.enabled — TUI System tab; explicit asks still work)';

function postureLine(tddOn, mutOn) {
  return `TDD posture: tests-first ${tddOn ? 'ON' : 'OFF'} · mutation verification ${mutOn ? 'ON' : 'OFF'} ${POSTURE_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// CONTROL, placed first: both toggles explicitly ON. A hardcoded-OFF/OFF
// posture line (e.g. left over from development against the OFF fixture)
// fails this test even though it might pass an OFF/OFF-only suite — this is
// the arm that must pass for the OPPOSITE reason from the OFF/OFF test below.
// ---------------------------------------------------------------------------
test('CONTROL: both toggles ON -> posture line reads ON / ON', () => {
  const { dir, cleanup } = makeProject({ tdd: { enabled: true }, mutation_verification: { enabled: true } });
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r) ?? '';
    assert.ok(ctx.includes(postureLine(true, true)), `expected the ON/ON posture line verbatim; got: ${ctx}`);
  } finally {
    cleanup();
  }
});
// Sabotage: hardcode the injected line to always read "tests-first OFF ·
// mutation verification OFF" regardless of config — this test goes red (the
// ON/ON line is never found).

test('both toggles OFF -> posture line reads OFF / OFF', () => {
  const { dir, cleanup } = makeProject({ tdd: { enabled: false }, mutation_verification: { enabled: false } });
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r) ?? '';
    assert.ok(ctx.includes(postureLine(false, false)), `expected the OFF/OFF posture line verbatim; got: ${ctx}`);
  } finally {
    cleanup();
  }
});
// Sabotage: hardcode the injected line to always read "tests-first ON ·
// mutation verification ON" regardless of config — this test goes red.

test('MIXED: tdd ON, mutation_verification OFF -> posture line reads ON / OFF (catches a field swap the symmetric cases cannot)', () => {
  const { dir, cleanup } = makeProject({ tdd: { enabled: true }, mutation_verification: { enabled: false } });
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r) ?? '';
    assert.ok(ctx.includes(postureLine(true, false)), `expected the ON/OFF posture line verbatim; got: ${ctx}`);
    assert.ok(!ctx.includes(postureLine(false, true)), 'must not print the swapped OFF/ON line');
  } finally {
    cleanup();
  }
});
// Sabotage: swap which config key drives which half of the line (read
// mutation_verification.enabled for the "tests-first" clause and vice versa)
// — undetectable by the ON/ON and OFF/OFF tests alone (both halves would
// still match their own symmetric value), but this test goes red because it
// would print "tests-first OFF · mutation verification ON" instead.

test('DEFAULT: config carries neither tdd nor mutation_verification keys -> both default to ON (decision foreign_752caf98)', () => {
  const { dir, cleanup } = makeProject(); // no tdd / mutation_verification block at all
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r) ?? '';
    assert.ok(ctx.includes(postureLine(true, true)), `expected both defaults to read ON per decision 752caf98; got: ${ctx}`); // not-a-citation: fixture id
  } finally {
    cleanup();
  }
});
// Sabotage: default an absent tdd/mutation_verification block to `false`
// (opt-out by default) instead of the documented default TRUE — this test
// goes red (finds the OFF/OFF line instead of ON/ON).

test('the posture line appears strictly AFTER the MACHINE ROLE line', () => {
  const { dir, cleanup } = makeProject({ tdd: { enabled: false }, mutation_verification: { enabled: false } });
  try {
    // The MACHINE ROLE line only renders when samePath(input.cwd, pluginRoot())
    // is true. Spawned from its real source location, H1's own walk-up always
    // finds THIS repo, so STERLING_PLUGIN_ROOT would go inert and the line
    // would never appear (a plain-tmpdir fixture makes this test unable to
    // reach the ordering question at all). Spawning the H1_SEAM bundle
    // (built into a marker-free temp dir) with STERLING_PLUGIN_ROOT pointed
    // at this fixture's OWN dir makes the walk-up genuinely fail and the env
    // seam legitimately reached, so cwd === pluginRoot() and the role line
    // renders — see the H1_SEAM comment above the `let H1_SEAM;` declaration.
    const r = runHookAt(
      H1_SEAM.hookPath,
      hookInput(dir, { hook_event_name: 'SessionStart', source: 'startup' }),
      dir,
      { NO_COLOR: '1', STERLING_PLUGIN_ROOT: dir }
    );
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      // asserted below
    }
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(out, 'H1 must emit parseable JSON');
    const ctx = out.hookSpecificOutput ? out.hookSpecificOutput.additionalContext : undefined;
    const roleIdx = (ctx ?? '').indexOf('MACHINE ROLE');
    const postureIdx = (ctx ?? '').indexOf(postureLine(false, false));
    assert.notEqual(roleIdx, -1, 'the existing MACHINE ROLE line must be present on the self-hosted seam (pre-existing H1 behavior) -- if this is -1, the fixture failed to reach the role line at all, not a mis-ordering');
    assert.notEqual(postureIdx, -1, 'the posture line must be present');
    assert.ok(postureIdx > roleIdx, `posture line (index ${postureIdx}) must come after MACHINE ROLE (index ${roleIdx})`);
  } finally {
    cleanup();
  }
});
// Sabotage: inject the posture line at the very start of additionalContext
// (or anywhere before the MACHINE ROLE line assembly) instead of directly
// after it — the ordering assertion (`postureIdx > roleIdx`) goes red. Note
// this sabotage must NOT be confused with a fixture defect: with the seam
// hook in place, roleIdx is a real, present index (asserted via
// assert.notEqual(roleIdx, -1) immediately above), so the ordering
// assertion is genuinely exercised rather than vacuously true against -1.

// ===========================================================================
// COVERAGE GAPS closed per external review (5 named sabotages predicted
// GREEN against the suite as it stood; each gets its own pin below).
// ===========================================================================

// GAP 4: malformed-but-PARSEABLE value shapes for the flags — only a real
// boolean `false` is OFF; every other JSON-legal value (including falsy
// non-boolean values, and values loose-equal to `false`) must still render
// ON. `0` specifically catches a `== false` loose-equality bug (`0 == false`
// is true in JS, unlike `'false' == false`, which is false); `''` and `null`
// catch a truthiness/`!value` check (`!''` and `!null` are both true).
const MALFORMED_BUT_PARSEABLE_VALUES = ['', 'false', null, 0, {}];

for (const value of MALFORMED_BUT_PARSEABLE_VALUES) {
  test(`GAP 4: config value ${JSON.stringify(value)} for both flags -> renders ON/ON (only a real boolean false is OFF)`, () => {
    const { dir, cleanup } = makeProject({ tdd: { enabled: value }, mutation_verification: { enabled: value } });
    try {
      const r = h1(dir, 'startup');
      assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
      assert.ok(r.out, 'H1 must emit parseable JSON');
      const ctx = additionalContext(r) ?? '';
      assert.ok(
        ctx.includes(postureLine(true, true)),
        `value ${JSON.stringify(value)} is not the boolean false — must still render ON/ON under strict-false semantics; got: ${ctx}`
      );
    } finally {
      cleanup();
    }
  });
}
// Named sabotage (verbatim from review): read the flag as `config?.tdd?.
// enabled ?? true` where the surrounding check ALSO applies truthiness or
// loose equality instead of a strict `=== false` test (e.g. `!config.tdd.
// enabled` or `config.tdd.enabled == false`) — '' and null (falsy) flip
// under a `!value` check, and 0 flips under `== false` (loose equality),
// so one or more of the five arms above renders OFF instead of ON.

// ===========================================================================
// GAP 5 — NEW BEHAVIOUR (genuine spec change, not a coverage gap in the old
// spec): h1-session-start.mjs now distinguishes an ABSENT config from an
// UNREADABLE one. loadConfig returns null when the file is absent (still
// renders the documented default ON/ON), and THROWS when the file exists
// but is malformed JSON — that case now renders, instead of any ON/OFF
// reading, the literal line:
//   "TDD posture: UNKNOWN — the project config could not be read, so
//    neither config.tdd.enabled nor config.mutation_verification.enabled
//    could be determined. This is NOT the default posture: repair the
//    config, or state your posture explicitly."
// The defect this closes: a corrupt config used to print a confident
// "ON / ON" — in THIS repo, where both toggles are actually OFF, that
// stated the exact opposite of the truth.
// ===========================================================================

const UNKNOWN_POSTURE_LINE =
  'TDD posture: UNKNOWN — the project config could not be read, so neither config.tdd.enabled nor config.mutation_verification.enabled could be determined. This is NOT the default posture: repair the config, or state your posture explicitly.';

// A project directory with a store but deliberately NO .sterling/config.json
// file at all — the ABSENT case (loadConfig returns null, not an exception).
function makeProjectNoConfigFile() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1-tdd-noconfig-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

test('GAP 5a: config file ABSENT entirely (no .sterling/config.json) -> still renders the documented default ON/ON, never UNKNOWN', () => {
  const { dir, cleanup } = makeProjectNoConfigFile();
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r) ?? '';
    assert.ok(ctx.includes(postureLine(true, true)), `an absent config file must still render the ON/ON default; got: ${ctx}`);
    assert.doesNotMatch(ctx, /TDD posture: UNKNOWN/, 'an absent file is NOT the same case as a malformed one — must not render UNKNOWN');
  } finally {
    cleanup();
  }
});
// Named sabotage: collapse the absent/malformed distinction by treating a
// null loadConfig result (absent) the same as a caught parse exception
// (malformed) — this test goes red (UNKNOWN appears, or ON/ON is missing,
// for a project that never had a config file at all).

test('GAP 5b: config file present but MALFORMED (unparseable) -> renders the exact UNKNOWN line, and NO tests-first ON/OFF text at all', () => {
  const { dir, cleanup } = makeProjectNoConfigFile();
  try {
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not valid json');
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook) even on a malformed config: ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON even when the project config throws');
    const ctx = additionalContext(r) ?? '';
    assert.ok(ctx.includes(UNKNOWN_POSTURE_LINE), `expected the exact UNKNOWN posture line verbatim; got: ${ctx}`);
    assert.doesNotMatch(
      ctx,
      /tests-first (ON|OFF)/,
      'a malformed config must render NO confident ON/OFF reading — the old behavior (a false "ON/ON") stated the exact opposite of the truth in this repo'
    );
  } finally {
    cleanup();
  }
});
// Named sabotage: on a config parse failure, fall back to the same
// default-ON/ON path used for an absent file (i.e. treat the thrown
// exception as if loadConfig had returned null) instead of rendering the
// UNKNOWN line — this test goes red (either the UNKNOWN line is missing, or
// the forbidden "tests-first ON" text appears).

// ===========================================================================
// GAP 6 — a hole one level up from GAP 4: GAP 4 pins the shape of the VALUE
// at config.tdd.enabled; this pins the shape of the WHOLE CONFIG. A config
// file whose contents are JSON-legal but NOT AN OBJECT (e.g. [], true, "x",
// 5, false, 0, "" — the full seven-shape list the loop below walks) parses
// without throwing, so a naive implementation never takes the
// UNREADABLE path (GAP 5b) — every `config?.tdd?.enabled` read
// optional-chains straight through a non-object to `undefined`, and the `??
// true` default renders a confident "ON/ON". That is the exact false-posture
// defect the UNKNOWN branch exists to eliminate, reached through a
// JSON-legal corruption instead of a syntax error. Per this spec, the fix
// treats a parseable-but-non-object config the SAME as an unreadable one:
// it renders UNKNOWN, not ON/ON. Kept as its own GAP (not folded into 5a/5b)
// so all three cases stay independently diagnosable: ABSENT file -> ON/ON;
// UNPARSEABLE file -> UNKNOWN (5b); PARSEABLE-but-not-an-object -> UNKNOWN
// (6, here) -- EXCEPT literal `null`, which is its own carved-out case
// immediately below (an accepted limitation, not a defect: see that block).
// ===========================================================================

const NON_OBJECT_JSON_SHAPES = [
  { label: 'array []', raw: '[]' },
  { label: 'boolean true', raw: 'true' },
  { label: 'string "x"', raw: '"x"' },
  { label: 'number 5', raw: '5' },
  // FALSY non-object shapes (external review): these must ALSO render
  // UNKNOWN, for the identical reason as the four above (JSON-legal,
  // non-object, so `config?.tdd?.enabled` would optional-chain to
  // undefined and fall through to the `?? true` default). They exist as
  // their own arms because the whole-config guard's exclusion of `null`
  // must be a STRICT `config !== null` check — a TRUTHINESS rewrite
  // (`if (config && ...)`) would leave the four arms above AND the
  // null-trap arm all green (none of [], true, "x", 5, or null are falsy
  // in a way that check mishandles) while these three silently regress to
  // a confident ON/ON, since `false`, `0`, and `""` are all falsy.
  // MEASURED, not assumed (coordinator applied both mutations and ran the
  // suite): `config != null` is an INERT CONTROL here, not a discriminating
  // sabotage — `!=` and `!==` against null differ only for `undefined`,
  // and loadConfig can only ever return a JSON.parse() result or the
  // literal `null` (JSON.parse cannot yield `undefined` — "undefined" is
  // not valid JSON), so that swap changes nothing and all 20 arms stayed
  // green under it. Without these three arms, the truthiness regression is
  // invisible to the suite.
  { label: 'boolean false', raw: 'false' },
  { label: 'number 0', raw: '0' },
  { label: 'empty string ""', raw: '""' },
];

for (const { label, raw } of NON_OBJECT_JSON_SHAPES) {
  test(`GAP 6: config file is JSON-legal but NOT AN OBJECT (${label}) -> renders the exact UNKNOWN line, no ON/OFF text`, () => {
    const { dir, cleanup } = makeProjectNoConfigFile();
    try {
      writeFileSync(join(dir, '.sterling', 'config.json'), raw);
      const r = h1(dir, 'startup');
      assert.equal(r.code, 0, `H1 must exit 0 (soft hook) even on a non-object config: ${r.stderr}`);
      assert.ok(r.out, 'H1 must emit parseable JSON even when the project config is a non-object');
      const ctx = additionalContext(r) ?? '';
      assert.ok(
        ctx.includes(UNKNOWN_POSTURE_LINE),
        `config content ${JSON.stringify(raw)} is JSON-legal but not an object — expected the exact UNKNOWN posture line; got: ${ctx}`
      );
      assert.doesNotMatch(
        ctx,
        /tests-first (ON|OFF)/,
        `config content ${JSON.stringify(raw)} must not fall through optional-chaining to a confident ON/OFF default`
      );
    } finally {
      cleanup();
    }
  });
}
// Named sabotage (general, all seven arms): drop the whole-config shape
// check (no `typeof config === 'object' && config !== null &&
// !Array.isArray(config)` guard, or equivalent) before reading
// config.tdd/config.mutation_verification, so a non-object config falls
// through every `?.` read to `undefined` and hits the `?? true` default —
// every arm above goes red (UNKNOWN disappears, replaced by "tests-first ON
// · mutation verification ON").
//
// Named sabotage (the one this round exists to catch, discriminating):
// weaken the guard's STRICT `config !== null` exclusion to a TRUTHINESS
// rewrite — `if (config && ...)` (equivalently, a bare `!config` check).
// Under that mutation the four pre-existing non-object arms ([], true, "x",
// 5) and the null-trap arm all stay GREEN, while the three FALSY arms just
// added (`false`, `0`, `""`) go RED: a truthiness-based null-exclusion
// treats these three the same as an absent-like `null`, rendering a
// confident ON/ON instead of the correct UNKNOWN. That is exactly the
// discrimination the four pre-existing arms (plus the null-trap arm) cannot
// provide on their own — this is why they are their own arms rather than
// being folded into an existing one.
//
// INERT CONTROL, measured (not a discriminating sabotage — do not run this
// one expecting a red): `config !== null` -> `config != null`. `!=` and
// `!==` against `null` differ only for `undefined`, and loadConfig can only
// ever return a JSON.parse() result or the literal `null` (JSON.parse
// cannot yield `undefined`), so `undefined` is unreachable here — this swap
// is behaviourally inert and the coordinator confirmed all 20 arms in this
// file stay green under it. Recorded so a future maintainer who tries this
// mutation first, sees green, and is tempted to conclude these three arms
// pin nothing does not draw that inverted conclusion — the discriminating
// mutation is the truthiness rewrite above, not this one.

// ---------------------------------------------------------------------------
// GAP 6 — the null trap, pinned SEPARATELY from the four shapes above.
//
// RESOLVED against the real contract (confirmed by the coordinator, who
// could see it): loadConfig is `existsSync(p) ? JSON.parse(readFileSync(p))
// : null` — an ABSENT file and a file whose content is the literal text
// `null` both return the identical JS value `null` through the SAME return
// path, with no existence signal surviving past that point. The two cases
// are therefore INDISTINGUISHABLE to every downstream reader, including
// this hook, and a config file containing literal `null` renders the same
// documented default (ON/ON) as an absent file — NOT UNKNOWN. This is a
// KNOWN AND ACCEPTED LIMITATION (a degenerate config file whose entire
// content is the word "null" reads as if it were never there), not a
// defect: loadConfig is a shared helper every hook imports, and adding an
// existence signal there to distinguish this one degenerate case would
// touch the whole enforcement surface for a trade judged not worth it.
// This arm pins the ACCEPTED behavior so a future change cannot silently
// regress it in either direction without a test noticing.
// ---------------------------------------------------------------------------
test('GAP 6 (null trap, ACCEPTED LIMITATION): a file containing literal `null` is INDISTINGUISHABLE from an absent file (loadConfig returns null for both) -> renders the documented ON/ON default, not UNKNOWN', () => {
  const { dir, cleanup } = makeProjectNoConfigFile();
  try {
    writeFileSync(join(dir, '.sterling', 'config.json'), 'null');
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook) even on a null-content config: ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON even when the project config file contains null');
    const ctx = additionalContext(r) ?? '';
    assert.ok(
      ctx.includes(postureLine(true, true)),
      `a config file whose CONTENT is the literal null is indistinguishable from an absent file (loadConfig returns null for both) and must render the documented ON/ON default; got: ${ctx}`
    );
    assert.doesNotMatch(
      ctx,
      /TDD posture: UNKNOWN/,
      'a null-content config is NOT the same as an unreadable/non-object config — it must not render UNKNOWN (that would require an existence signal loadConfig does not preserve)'
    );
  } finally {
    cleanup();
  }
});
// Named sabotage: add an existence check (or a distinct absent-vs-null
// sentinel) so a null-content file is treated as UNKNOWN instead of ON/ON —
// this test goes red (the ON/ON line disappears, or UNKNOWN wrongly
// appears). This is the DELIBERATE INVERSE of what was pinned in the
// previous round: that arm asserted UNKNOWN for this exact fixture and was
// itself the wrong pin (an instruction based on a misreading of the real
// loadConfig contract) — this test replaces it, not supplements it.
