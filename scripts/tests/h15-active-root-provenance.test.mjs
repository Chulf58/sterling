// H15 store-guard — ACTIVE-PLUGIN-ROOT PROVENANCE pins (spec-only, red-first).
// Objective dome-farmer-issues-2026-09-05, slice 1 (board 891284a9).
//
// IN ONE SENTENCE: H15's sanctioned-script exemption compares FILE IDENTITY,
// never spelling — the candidate must canonicalize (realpath) to a regular file
// sitting inside the canonicalized ACTIVE PLUGIN ROOT, at a clone-relative
// POSIX path that EXACTLY equals a sanctioned entry.
//
// ---------------------------------------------------------------------------
// GOVERNING SPEC — decision 5b82e94f
// (`h15-realpath-binding-active-plugin-root-provenance`, user-approved
// 2026-09-05), which adopts decision 1434cd54 Ruling 3's seven-step sequence as
// the binding and quotes its Ruling 4 for what provenance does and does not
// buy. The EXECUTED bypass it closes is research_finding cc35e43c
// (`h15-clone-provenance-binds-spelling-not-file`). Decision a206a529 is the
// superseded predecessor — read its two ⚠ amendments, not its original
// rationale, which the record itself marks factually false.
//
// Written BLIND to scripts/hooks/h15-store-guard.mjs and
// scripts/lib/store-remediation.mjs (H4 read wall; neither was opened by this
// author). `git stash@{0}` — the PARKED, known-bypassable implementation —
// was neither read nor applied. The records above are the entire spec.
// Harness conventions (runHook / makeProject / an explicit fixture config /
// a real store db so project-root resolution keys on it) are copied, not
// imported, from scripts/tests/h15-allowlist-anchoring.test.mjs:75-123 and
// scripts/tests/h15-exemption-riders.test.mjs:58-99. Those files are NEITHER
// modified nor referenced at runtime; this file is standalone.
//
// ---------------------------------------------------------------------------
// WHY SO MANY PINS ARE "GREEN TODAY FOR THE WRONG REASON", AND WHY THAT IS
// STATED RATHER THAN HIDDEN.
// ---------------------------------------------------------------------------
// At HEAD the sanctioned check is NAME-ONLY STRING EQUALITY on the executable
// argument (5b82e94f's measured_by: `isSanctionedScript` at
// h15-store-guard.mjs:650-653) and H15 does not derive a plugin root at all.
// Consequently EVERY absolute-path shape below — attacker clone, bad layout,
// directory candidate, `..` escape, sibling prefix, the cc35e43c exploit word —
// already DENIES today, because an absolute path never equals `scripts/init.mjs`.
// A green on those pins today therefore proves NOTHING: the mechanism under
// test does not exist yet.
//
// That is exactly the false negative cc35e43c nearly published ("the FIRST run
// of this probe denied all four arms including the genuine-form control"), and
// it is why EVERY deny pin in this file is preceded by a CONTROL that must pass
// for the OPPOSITE reason. PV-C1 is the load-bearing one: the GENUINE absolute
// in-clone sanctioned script must be ALLOWED. It is RED at HEAD. Until PV-C1 is
// green, every deny verdict in this file is uninterpretable — a control that
// denies alongside the exploit means the mechanism never engaged.
//
// THE PINS THAT ARE GENUINELY RED AT HEAD (they fail on their assertions, not
// on a crash): PV-C1, PV-1-control, PV-5, PV-7a, PV-7b, PV-8a, PV-9a, PV-9b,
// PV-10-control, and the PV-6 / PV-2 / PV-3 / PV-4 control arms that share
// PV-C1's shape. The rest are non-regression and must-never-false-ALLOW pins.
//
// ---------------------------------------------------------------------------
// SPEC AMBIGUITIES RESOLVED HERE, STATED SO THEY CAN BE OVERTURNED ON ARGUMENT
// ---------------------------------------------------------------------------
// (A1) IS `scripts/rotation-note.mjs` A SHIPPED `SANCTIONED_SCRIPTS` ENTRY
//      AFTER THIS SLICE? 5b82e94f says the three machine-local `allow_scripts`
//      entries from 1434cd54 Ruling 1 "are removed from this repo's config when
//      the mechanism ships", which only makes sense if the shipped list gains
//      them — but it never says so outright, and 1434cd54 Ruling 6 forbids
//      bulk-adding. RESOLUTION: this file does NOT pin rotation-note's
//      membership. Every rotation-note pin puts the entry in the FIXTURE's
//      `store_guard.allow_scripts` instead, which decision 5b82e94f step (6)
//      names as an equally valid entry source. So PV-7* pin the PROVENANCE
//      MECHANISM (an absolute in-clone path matching a configured entry) and
//      are independent of the list question. Only `scripts/review-ledger.mjs`
//      is pinned as a SANCTIONED_SCRIPTS member (PV-9a), because the slice
//      brief states that outright.
// (A2) EXACT DENIAL WORDING for a layout failure. 5b82e94f step (8) requires
//      the denial to NAME the resolved canonical candidate "and the entry set
//      it was compared against"; it does not fix a vocabulary for the
//      root-layout failure. PV-2d therefore matches on SUBSTANCE (the root path
//      or an explicit layout/plugin-marker word), never a guessed keyword.
// (A3) `allow_scripts` ENTRIES ARE CLONE-RELATIVE, not project-relative —
//      a206a529's closing paragraph says so explicitly and flags the two stale
//      comments that still claim otherwise. Every fixture entry below is
//      written clone-relative.
//
// ---------------------------------------------------------------------------
// MUTATION DISCIPLINE (decision 23afbc83, CLAUDE.md's verify-by-mutation rule):
// every pin carries a SABOTAGE comment naming the ONE-LINE implementation
// change that must turn it RED, and says WHICH GUARD carries the verdict where
// more than one could. NONE is executed here — this file's author holds no Bash
// by design, and NO MUTATION RESULT IS CLAIMED.
// ---------------------------------------------------------------------------

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, chmodSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildSeamHook } from './lib/seam-hook.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

let SterlingStore;
// The seam-spawnable H15 bundle (95c2c109 F2) — built once per suite.
let SEAM;
after(() => SEAM?.cleanup());
before(async () => {
  SEAM = await buildSeamHook('h15-store-guard.mjs');
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// Flatten multi-line child stderr before interpolating it into an assertion
// message (anti-pattern ee89c3fd).
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');

// The canonicalizer the spec names (5b82e94f step 3). Used by the TEST only to
// compute what a correct denial must print — never to decide a verdict.
const realNative = realpathSync.native ?? realpathSync;
const canon = (p) => {
  try {
    return realNative(p);
  } catch {
    return p;
  }
};
const posix = (p) => String(p).split(sep).join('/');

// Directory/file symlinks are unavailable to an unprivileged user on some
// Windows hosts. The cc35e43c fixture CANNOT be built without them, and a
// silently-degraded fixture is exactly the false negative that finding warns
// about — so those pins SKIP loudly rather than passing vacuously.
const SYMLINK_SKIP = (() => {
  const d = mkdtempSync(join(tmpdir(), 'sterling-symprobe-'));
  try {
    mkdirSync(join(d, 'target'), { recursive: true });
    symlinkSync(join(d, 'target'), join(d, 'link'), 'dir');
    return false;
  } catch (err) {
    return `directory symlinks unavailable on this host (${err && err.code}) — the cc35e43c bypass fixture cannot be built, and a degraded fixture would pass vacuously`;
  } finally {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})();

// ---------------------------------------------------------------------------
// Hook invocation. CLAUDE_PLUGIN_ROOT and STERLING_PLUGIN_ROOT are DELETED from
// the inherited environment on every call and re-set only by a test that means
// to. Without that, a run launched from inside a live Sterling session inherits
// a real CLAUDE_PLUGIN_ROOT and PV-1 would be testing the ambient session, not
// the fixture — the fixture-defect class cc35e43c records.
//
// SPAWN LOCATION (decision 95c2c109 F2, user-ruled 2026-09-05): the active root
// PREFERS the running hook's own import.meta.url walk-up and consults the
// STERLING_PLUGIN_ROOT seam ONLY when that walk-up finds no plugin tree. So
// `from = 'seam'` (the default) spawns a FRESH BUNDLE built into a marker-free
// temp dir (scripts/tests/lib/seam-hook.mjs) — the only shape in which the seam
// is read — and `from = 'source'` spawns scripts/hooks/h15-store-guard.mjs,
// whose walk-up resolves THIS repo as the root and ignores the seam (PV-1b).
// ---------------------------------------------------------------------------
function runHook(command, cwd, env = {}, from = 'seam') {
  const childEnv = { ...process.env, STERLING_CURRENCY_DISABLE: '1' };
  delete childEnv.CLAUDE_PLUGIN_ROOT;
  delete childEnv.STERLING_PLUGIN_ROOT;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  const input = {
    session_id: 's1',
    transcript_path: join(cwd, 't', 's1.jsonl'),
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  };
  // A THIRD shape (board fb7c43fb pin gap, section 14 below): `from` may also
  // be a literal hook path, for a fixture that copies the guard to a
  // caller-chosen walk-up location. 'source' and 'seam' behave exactly as
  // before this addition.
  const hookPath = from === 'source' ? join(HOOKS, 'h15-store-guard.mjs') : from === 'seam' ? SEAM.hookPath : from;
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: childEnv,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// The sealed store db. EVERY pin whose verdict must be decided BY THE EXEMPTION
// names it: decision 0b4d3c8c seals sterling.db for every verb and fd9e96e0
// fires the seal on ANY occurrence of the literal, so without it a fragment is
// allowed by the no-store-mention path and the pin is hollow.
const DB = '.sterling/sterling.db';

// Clone-relative sanctioned entries (ambiguity A3). `scripts/init.mjs` is also
// a shipped default; rotation-note and review-ledger are declared explicitly so
// PV-7/PV-9b pin the MECHANISM rather than the open list question (A1).
const SANCTIONED_INIT = 'scripts/init.mjs';
const SANCTIONED_ROTATION = 'scripts/rotation-note.mjs';
const SANCTIONED_LEDGER = 'scripts/review-ledger.mjs';
// A real regular file inside the clone that is in NEITHER set — the subject of
// every opposite-reason control.
const UNSANCTIONED = 'scripts/not-a-sanctioned-script.mjs';

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
  store_guard: { allow_scripts: [SANCTIONED_INIT, SANCTIONED_ROTATION, SANCTIONED_LEDGER] },
};

// commit-reviewed.mjs is a SHIPPED sanctioned entry (store-remediation.mjs); it exists in the
// fixture clone so PV-11-control-a can exercise the real commit command.
const CLONE_SCRIPTS = ['init.mjs', 'rotation-note.mjs', 'review-ledger.mjs', 'commit-reviewed.mjs', 'not-a-sanctioned-script.mjs'];

// A fixture plugin root. `layout` selects which of the three required markers
// (5b82e94f step 2) are present; `scripts` selects which regular files exist.
function makeClone(base, name, opts = {}) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  if (!opts.noPluginJson) {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: '0.0.0-fixture' }));
  }
  if (!opts.noHooksDir) {
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    if (!opts.noHooksJson) writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
  }
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const s of opts.scripts ?? CLONE_SCRIPTS) {
    writeFileSync(join(dir, 'scripts', s), '// fixture script — never executed by these pins\n');
  }
  return dir;
}

// The world every pin runs in.
//   <base>/project          the H15 project (cwd), EXACTLY ONE level under base
//                           — the cc35e43c word's `../..` arithmetic depends on it
//   <base>/clone            the active plugin root (pointed at by the seam)
// Extra fixtures are added per-test on top of this.
function makeWorld(cloneOpts = {}) {
  const base = mkdtempSync(join(tmpdir(), 'sterling-h15prov-'));
  const project = join(base, 'project');
  mkdirSync(join(project, '.sterling'), { recursive: true });
  writeFileSync(join(project, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  // A REAL store db — project-root resolution keys on it actually existing.
  const store = new SterlingStore(join(project, '.sterling', 'sterling.db'));
  const clone = makeClone(base, 'clone', cloneOpts);
  const cleanup = () => {
    store.close();
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { base, project, clone, cleanup };
}

// Point the hook at a fixture root through the TEST SEAM (5b82e94f step 1:
// STERLING_PLUGIN_ROOT is test-only; the running bundle's own import.meta.url
// is the production derivation — and since 95c2c109 F2 the seam is read only
// when that derivation finds nothing, which runHook's default spawn location
// guarantees).
const seam = (dir) => ({ STERLING_PLUGIN_ROOT: dir });

// =============================================================================
// SECTION 0 — CONTROL ARM, FIRST AND DELIBERATELY.
//
// Read this before reading any deny pin below. PV-C1 is the arm that gives
// every other verdict in this file its meaning.
// =============================================================================

test('PV-C1 (CONTROL, LOAD-BEARING, expect RED today): the GENUINE absolute in-clone sanctioned script is ALLOWED against the sealed db', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    const r = runHook(`node ${join(clone, 'scripts', 'init.mjs')} ${DB}`, project, seam(clone));
    assert.notEqual(r.code, null, 'the gate must not crash on the genuine in-clone launcher');
    assert.equal(
      r.code,
      0,
      `THE ARM THE WHOLE FILE RESTS ON. The fragment names the sealed db, so only the sanctioned-script exemption can produce an allow. RED AT HEAD, deliberately: H15 compares the literal word against the literal entry (5b82e94f measured_by), so an absolute clone path never matches — which is precisely the consumer defect this slice exists to fix (decision 1434cd54 Ruling 3: repo-relative entries "never match the documented absolute invocation"). Until this is GREEN, every deny pin below is passing for the wrong reason and proves nothing. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the provenance check return false unconditionally (grant no
// exemption ever) — this pin goes red (allow 0 -> deny 2) via the DB seal, while
// PV-C2 stays green. WHICH GUARD CARRIES THE VERDICT: the exemption's EXISTENCE.
// A hardening that denies everything is not a fix, and this is the sole pin that
// distinguishes the two.

test('PV-C2 (CONTROL, OPPOSITE REASON, expect GREEN today and after): a real regular file inside the SAME canonical root that is in NEITHER entry set is DENIED', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    const r = runHook(`node ${join(clone, UNSANCTIONED)} ${DB}`, project, seam(clone));
    assert.notEqual(r.code, null, 'the gate must not crash on an unsanctioned in-clone file');
    assert.equal(
      r.code,
      2,
      'identical shape to PV-C1, identical root, identical containment, real regular file — ONLY the entry-set membership differs. PV-C1 + PV-C2 together prove the EXACT-EQUALITY MATCH (5b82e94f step 6) decides, and not "anything under the clone root is sanctioned"'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: grant the exemption to any regular file contained under the
// canonical root, skipping the entry-set equality — this pin goes red
// (deny 2 -> allow 0) while PV-C1 stays green. It is the sole load-bearing pin
// against "provenance replaced the allowlist" rather than binding it.

test('PV-C3 (CONTROL, AUTHORING-MACHINE NON-REGRESSION, expect GREEN today and after): when the PROJECT IS the active plugin root, the repo-relative form is still ALLOWED', () => {
  // The authoring machine (this repo) is the case where the active clone and
  // the writable project are the same tree — 1434cd54 Ruling 4 says provenance
  // buys little here, but it must not BREAK here either. The project gets the
  // full plugin layout so it is a legitimate root in its own right.
  const { project, cleanup } = makeWorld();
  try {
    mkdirSync(join(project, '.claude-plugin'), { recursive: true });
    writeFileSync(join(project, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: '0.0.0-fixture' }));
    mkdirSync(join(project, 'hooks'), { recursive: true });
    writeFileSync(join(project, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
    mkdirSync(join(project, 'scripts'), { recursive: true });
    writeFileSync(join(project, 'scripts', 'rotation-note.mjs'), '// fixture\n');

    const r = runHook(`node ${SANCTIONED_ROTATION} ${DB}`, project, seam(project));
    assert.notEqual(r.code, null, 'the gate must not crash on the self-hosted repo-relative form');
    assert.equal(
      r.code,
      0,
      `a relative word resolves against the PROJECT CWD, the way the shell resolves it (a206a529: validating a file other than the one bash would run is the same false-ALLOW under a new name) — and here that canonicalizes to a regular file inside the canonical root at exactly \`${SANCTIONED_ROTATION}\`. GREEN today for the ordinary reason (string equality) and must STAY green: this is the shape every self-hosted invocation uses. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: require the candidate word to be ABSOLUTE before considering the
// exemption (dropping project-cwd resolution of a relative word) — this pin goes
// red (allow 0 -> deny 2) while PV-C1 stays green. That asymmetry is why the
// absolute and relative forms are pinned separately.

// =============================================================================
// SECTION 1 — ROOT PROVENANCE: THE ROOT IS NOT AGENT-SETTABLE.
// 5b82e94f step 1 / 1434cd54 Ruling 3: derive from the RUNNING BUNDLE, never
// CLAUDE_PLUGIN_ROOT (agent-settable), never config (agent-writable (B)
// surface). "A root the gated party can move is not provenance."
// The control comes FIRST: it is what proves the attacker root is a VALID root
// in every respect except the env-var name that named it.
// =============================================================================

// RE-CUT 2026-09-05 (95c2c109 F2): the CLAIM is unchanged — through the seam the
// attacker root is exempt — but the seam is now consulted only when the
// running hook's walk-up finds no plugin tree, so this pin spawns the seam
// bundle (runHook's default), never the source hook. PV-1b is its inverse arm.
test('PV-1-control (CONTROL): the SAME attacker-built root, named through the STERLING_PLUGIN_ROOT test seam from a marker-free spawn location, DOES grant the exemption', () => {
  const { base, project, cleanup } = makeWorld();
  try {
    const attacker = makeClone(base, 'attacker-clone');
    const r = runHook(`node ${join(attacker, 'scripts', 'init.mjs')} ${DB}`, project, seam(attacker));
    assert.notEqual(r.code, null, 'the gate must not crash on a well-formed alternate root');
    assert.equal(
      r.code,
      0,
      `the evidence PV-1 needs: this root has a complete plugin layout and a real regular file at a sanctioned clone-relative path, so through the SEAM it is exempt. PV-1 runs the IDENTICAL command against the IDENTICAL tree and differs ONLY in which environment variable names the root — so PV-1's deny is attributable to the VARIABLE NAME and to nothing else. Without this arm, PV-1 is satisfied by "the fixture root was bogus" or by "nothing is ever exempt". stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop STERLING_PLUGIN_ROOT support entirely — this pin goes red
// (allow 0 -> deny 2) together with PV-C1 and most of this file, which is how
// you tell "the seam was removed" (re-point the pins) apart from "the root
// derivation is wrong" (a defect).

test('PV-1b (F2, decision 95c2c109): with a REAL plugin tree above the running hook, STERLING_PLUGIN_ROOT naming an attacker root is IGNORED — the walk-up root wins and the attacker script is DENIED', () => {
  const { base, project, cleanup } = makeWorld();
  try {
    const attacker = makeClone(base, 'attacker-clone');
    // IDENTICAL command, IDENTICAL tree and IDENTICAL env to PV-1-control; the
    // ONLY difference is the spawn location: the SOURCE hook under scripts/hooks/,
    // whose walk-up resolves this repo as the active root.
    const r = runHook(`node ${join(attacker, 'scripts', 'init.mjs')} ${DB}`, project, seam(attacker), 'source');
    assert.notEqual(r.code, null, 'the gate must not crash when the seam is set beside a resolvable walk-up');
    assert.equal(
      r.code,
      2,
      `95c2c109 F2 (user-ruled): the seam is consulted ONLY when the walk-up finds no plugin tree. Here it finds one, so the attacker root named by the variable must be inert and the attacker's file — outside the real root — denied. Before F2 the seam was honoured unconditionally, which made a test-only variable a production root override for any agent able to reach hook env. stderr=${flat(r.stderr)}`
    );
    const text = String(r.stderr ?? '');
    assert.match(text, /OUTSIDE the active plugin root/, 'the denial attributes itself to containment against the WALK-UP root — evidence the seam was not consulted');
    assert.doesNotMatch(text, /STERLING_PLUGIN_ROOT test seam/, 'the provenance line must not claim the seam supplied the root');
  } finally {
    cleanup();
  }
});
// SABOTAGE: read STERLING_PLUGIN_ROOT before (or regardless of) the walk-up —
// this pin goes red (deny 2 -> allow 0) while PV-1-control stays green. The two
// pins differ ONLY in where the hook was spawned from, so the pair isolates the
// ORDER of the two derivations and nothing else.

test('PV-1 (expect GREEN today FOR THE WRONG REASON — see PV-1-control): CLAUDE_PLUGIN_ROOT pointing at an attacker clone grants NO exemption', () => {
  const { base, project, cleanup } = makeWorld();
  try {
    const attacker = makeClone(base, 'attacker-clone');
    const r = runHook(`node ${join(attacker, 'scripts', 'init.mjs')} ${DB}`, project, {
      CLAUDE_PLUGIN_ROOT: attacker,
      STERLING_PLUGIN_ROOT: undefined,
    });
    assert.notEqual(r.code, null, 'the gate must not crash when CLAUDE_PLUGIN_ROOT names an alternate root');
    assert.equal(
      r.code,
      2,
      `CLAUDE_PLUGIN_ROOT IS AGENT-SETTABLE, and a root the gated party can move is not provenance (5b82e94f step 1; 1434cd54 Ruling 3). An agent that can set this variable could otherwise point the guard at a tree it controls and inherit every shipped script capability. GREEN AT HEAD only because H15 derives no root at all today — read this pin ONLY beside PV-1-control, which is RED at HEAD. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: add `process.env.CLAUDE_PLUGIN_ROOT` to the root-derivation chain
// (as a fallback, or ahead of the bundle's own import.meta.url) — this pin goes
// red (deny 2 -> allow 0) while PV-1-control and PV-C1 both stay green. It is
// the sole load-bearing pin for "the root is not agent-settable".

// =============================================================================
// SECTION 2 — PLUGIN LAYOUT VALIDATION (5b82e94f step 2).
// A root is trusted only when it carries `hooks/`, `.claude-plugin/plugin.json`
// and `hooks/hooks.json`. a206a529 already ruled the seam MARKER-VALIDATED and
// fail-closed: "a bogus override must fail closed rather than silently
// re-finding the real clone."
// Every pin here is GREEN AT HEAD for the wrong reason; PV-C1 is their evidence.
// =============================================================================

for (const [id, label, cloneOpts, marker] of [
  ['PV-2a', 'missing .claude-plugin/plugin.json', { noPluginJson: true }, '.claude-plugin/plugin.json'],
  ['PV-2b', 'missing the hooks/ directory', { noHooksDir: true }, 'hooks/'],
  ['PV-2c', 'missing hooks/hooks.json (hooks/ present)', { noHooksJson: true }, 'hooks/hooks.json'],
]) {
  test(`${id} (expect GREEN today for the wrong reason — evidence is PV-C1): a root ${label} yields NO exemption for an otherwise-genuine sanctioned candidate`, () => {
    const { project, clone, cleanup } = makeWorld(cloneOpts);
    try {
      const r = runHook(`node ${join(clone, 'scripts', 'init.mjs')} ${DB}`, project, seam(clone));
      assert.notEqual(r.code, null, `the gate must not crash on a root ${label}`);
      assert.equal(
        r.code,
        2,
        `the candidate is a real regular file at a genuinely sanctioned clone-relative path, contained under this root — EVERYTHING is right except the root's own credentials (${marker} absent). 5b82e94f step 2 validates the layout BEFORE trusting the root, so this must deny. Compare PV-C1: identical command, identical file, root differs ONLY by the missing marker. stderr=${flat(r.stderr)}`
      );
    } finally {
      cleanup();
    }
  });
  // SABOTAGE: skip layout validation and trust whatever the root derivation
  // returned — this pin goes red (deny 2 -> allow 0) while PV-C1 stays green.
  // WHICH GUARD CARRIES THE VERDICT: layout validation alone. Each of the three
  // markers is pinned SEPARATELY because a check that validates only
  // plugin.json (the a206a529-era marker) leaves 2b and 2c open and 2a green.
}

test('PV-2d (expect RED today): a root that fails layout validation DENIES with a message naming the layout failure, not a bare "not sanctioned"', () => {
  const { project, clone, cleanup } = makeWorld({ noPluginJson: true });
  try {
    const r = runHook(`node ${join(clone, 'scripts', 'init.mjs')} ${DB}`, project, seam(clone));
    assert.equal(r.code, 2, `precondition: the layout failure denies (PV-2a) — stderr=${flat(r.stderr)}`);
    const text = String(r.stderr ?? '').replace(/\s+/g, ' ');
    assert.ok(
      text.includes(posix(clone)) ||
        text.includes(clone) ||
        /plugin\.json|hooks\.json|plugin (root|layout)|layout/i.test(text),
      `1434cd54 Ruling 3 is explicit: H15's denial must NAME the resolved candidate "or the hardening reads as random breakage", and 5b82e94f step 8 carries that forward. A root rejected for its LAYOUT must say so — naming the root path or the missing marker class — so an operator whose clone is incomplete is not left guessing. Vocabulary is deliberately unpinned (ambiguity A2): any of the root path, plugin.json, hooks.json, "plugin root" or "layout" satisfies this. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: route the layout failure into the generic "not a sanctioned script"
// denial text — this pin goes red while PV-2a stays green, which is exactly the
// "random breakage" failure Ruling 3 names. WHICH GUARD CARRIES THE VERDICT: the
// denial's provenance line, a different guard from the deny decision itself.

// =============================================================================
// SECTION 3 — THE CANDIDATE MUST EXIST AND BE A REGULAR FILE (5b82e94f step 4).
// Each fixture below puts the defect at a GENUINELY SANCTIONED clone-relative
// path inside a GENUINELY VALID root, so containment and equality both succeed
// and only the stat check can produce the deny. That is what isolates step 4.
// =============================================================================

test('PV-3a (expect GREEN today for the wrong reason — evidence is PV-C1): a DIRECTORY at the sanctioned clone-relative path yields NO exemption', () => {
  const { project, clone, cleanup } = makeWorld({ scripts: ['rotation-note.mjs', 'review-ledger.mjs', 'not-a-sanctioned-script.mjs'] });
  try {
    mkdirSync(join(clone, 'scripts', 'init.mjs'), { recursive: true });
    const r = runHook(`node ${join(clone, 'scripts', 'init.mjs')} ${DB}`, project, seam(clone));
    assert.notEqual(r.code, null, 'the gate must not crash on a directory candidate');
    assert.equal(
      r.code,
      2,
      `the path resolves, is contained under the canonical root, and its clone-relative form EXACTLY EQUALS the sanctioned entry — every step but one succeeds. It is a DIRECTORY, and \`node <dir>\` is not the shipped launcher. 5b82e94f step 4 requires a REGULAR FILE. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the lstat/stat regular-file requirement, accepting any path
// that canonicalizes and contains — this pin goes red (deny 2 -> allow 0)
// together with PV-3c, while PV-C1/PV-C2 stay green. WHICH GUARD CARRIES THE
// VERDICT: the regular-file stat alone.

test('PV-3b (expect GREEN today for the wrong reason — evidence is PV-C1): a DANGLING SYMLINK at the sanctioned path yields NO exemption', { skip: SYMLINK_SKIP }, () => {
  const { project, clone, cleanup } = makeWorld({ scripts: ['rotation-note.mjs', 'review-ledger.mjs', 'not-a-sanctioned-script.mjs'] });
  try {
    symlinkSync(join(clone, 'scripts', 'target-that-does-not-exist.mjs'), join(clone, 'scripts', 'init.mjs'));
    const r = runHook(`node ${join(clone, 'scripts', 'init.mjs')} ${DB}`, project, seam(clone));
    assert.notEqual(r.code, null, 'the gate must not crash on a dangling symlink candidate');
    assert.equal(
      r.code,
      2,
      `realpath on a dangling link THROWS, and 5b82e94f is fail-closed throughout: "a candidate that cannot be resolved to a regular file under the canonical root is denied, naming why" (its rejection of the bare-name fallback — anti_pattern caecf8a6, severity block). A resolution failure must never degrade into a name comparison. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: catch the realpath failure and fall back to the LEXICAL
// resolve()/bare-name comparison — this pin goes red (deny 2 -> allow 0) while
// PV-3a and PV-3c stay green (those paths never throw). It is the sole
// load-bearing pin for "a resolution failure denies rather than degrading",
// which is the exact shape anti_pattern caecf8a6 blocks.

test('PV-3c (expect GREEN today for the wrong reason — evidence is PV-C1): an ABSENT candidate at the sanctioned path yields NO exemption', () => {
  const { project, clone, cleanup } = makeWorld({ scripts: ['rotation-note.mjs', 'review-ledger.mjs', 'not-a-sanctioned-script.mjs'] });
  try {
    const r = runHook(`node ${join(clone, 'scripts', 'init.mjs')} ${DB}`, project, seam(clone));
    assert.notEqual(r.code, null, 'the gate must not crash on an absent candidate');
    assert.equal(
      r.code,
      2,
      `nothing exists at the path. The name is perfect and the containment arithmetic is perfect; the FILE is the thing being trusted, and there is no file. This is also the shape a consumer hits when an entry rots out of a shipped clone — 1434cd54 Ruling 3 requires /sterling:update to DISCLOSE such entries, which presupposes the guard denies them. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the existence check (accept a canonicalization result for a
// path that does not exist, e.g. by realpath'ing the PARENT and re-joining the
// basename) — this pin goes red (deny 2 -> allow 0) while PV-3b stays green,
// because that shape resolves the parent successfully in both cases.

// =============================================================================
// SECTION 4 — CONTAINMENT UNDER THE CANONICAL ROOT (5b82e94f step 5):
// path.relative on the two CANONICAL paths, rejecting `..`, an absolute result,
// and the root itself.
// =============================================================================

test('PV-4a (expect GREEN today for the wrong reason — evidence is PV-C1): a `..` escape out of the root yields NO exemption', () => {
  const { base, project, clone, cleanup } = makeWorld();
  try {
    // A real, complete decoy tree OUTSIDE the root, holding a real regular file
    // at the sanctioned clone-relative path — so only containment can deny.
    makeClone(base, 'outside');
    // Built by STRING CONCATENATION, never path.join — join() normalizes `..`
    // lexically and would erase the very segment under test, handing the hook a
    // pre-cleaned word and making this pin hollow.
    const word = `${posix(clone)}/../outside/scripts/init.mjs`;
    const r = runHook(`node ${word} ${DB}`, project, seam(clone));
    assert.notEqual(r.code, null, 'the gate must not crash on a `..` escape');
    assert.equal(
      r.code,
      2,
      `the word passes THROUGH the root and back out. The canonical candidate is <base>/outside/scripts/init.mjs, which is not under <base>/clone, so path.relative yields a leading \`..\` and the exemption is refused. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: compute containment but never inspect the path.relative result for a
// leading `..` (or an absolute result) — this pin goes red (deny 2 -> allow 0)
// while PV-4b stays green (a sibling-prefix escape produces a relative result
// with no `..` segment at all, which is why the two are pinned separately).

test('PV-4b (expect GREEN today for the wrong reason — evidence is PV-C1): a SIBLING directory sharing a string prefix with the root yields NO exemption', () => {
  const { base, project, clone, cleanup } = makeWorld();
  try {
    const evil = makeClone(base, 'clone-evil');
    const r = runHook(`node ${join(evil, 'scripts', 'init.mjs')} ${DB}`, project, seam(clone));
    assert.notEqual(r.code, null, 'the gate must not crash on a sibling-prefix root');
    assert.equal(
      r.code,
      2,
      `\`<clone>-evil/scripts/init.mjs\` STARTS WITH the canonical root as a STRING but is not INSIDE it as a PATH. cc35e43c records that the reviewer "tried and FAILED to defeat it via <clone>-evil sibling prefixes (segment-boundary containment)" at HEAD-of-the-parked-lane — that surviving property must be re-established by the rewrite, not silently dropped. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: implement containment as
// `canonicalCandidate.startsWith(canonicalRoot)` without a trailing-separator /
// path-segment boundary — this pin goes red (deny 2 -> allow 0) while PV-4a and
// PV-C1 both stay green. It is the sole load-bearing pin for segment-boundary
// containment.

test('PV-4c (expect GREEN today for the wrong reason — evidence is PV-C1): the ROOT ITSELF is not a sanctioned candidate', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    const r = runHook(`node ${clone} ${DB}`, project, seam(clone));
    assert.notEqual(r.code, null, 'the gate must not crash when the candidate IS the root');
    assert.equal(
      r.code,
      2,
      `5b82e94f step 5 rejects the root itself by name. TWO CAUSES CAN PRODUCE THIS VERDICT and that is stated rather than hidden: the root is also a DIRECTORY (step 4) and its clone-relative form is the empty string (step 6). This pin is therefore CONFIRMATORY, not isolating — PV-3a isolates the regular-file check and PV-C2 isolates the equality check. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: none isolates this pin — by construction three guards each deny it,
// so a SINGLE-guard mutation leaves it green. That is DEFENSE IN DEPTH, not
// hollowness, and it is why the pin is labelled confirmatory. The mutation that
// reddens it is removing the exemption's eligibility check wholesale (deny 2 ->
// allow 0), the same one that reddens every deny pin here.

// =============================================================================
// SECTION 5 — EXACT EQUALITY, NO BARE-NAME FALLBACK (5b82e94f steps 6 + 7).
// "NO BARE-NAME COMPATIBILITY FALLBACK — a fallback is the bypass"
// (anti_pattern caecf8a6, severity block).
// =============================================================================

test('PV-5 (expect RED today — THE ORIGINAL FREE-NAME HOLE): a planted <project>/scripts/init.mjs with a sanctioned BASENAME is DENIED', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    // The decoy a206a529 describes: in a CONSUMING project, Sterling's scripts
    // live in the plugin clone, so `scripts/init.mjs` is a FREE NAME there.
    mkdirSync(join(project, 'scripts'), { recursive: true });
    writeFileSync(join(project, 'scripts', 'init.mjs'), '// planted attacker file\n');

    const r = runHook(`node ${SANCTIONED_INIT} ${DB}`, project, seam(clone));
    assert.notEqual(r.code, null, 'the gate must not crash on a planted project-local decoy');
    assert.equal(
      r.code,
      2,
      `MEASURED HOLE (a206a529): "A file planted at <project>/scripts/init.mjs made \`node scripts/init.mjs --db .sterling/sterling.db\` satisfy the sanctioned-script check, and H15 waved the fragment straight past the database seal." The word resolves against the project cwd (the way bash resolves it) to <project>/scripts/init.mjs, which is NOT under the canonical plugin root — so it must deny however perfectly its name matches. Contrast PV-C3, where the identical WORD is allowed because the project genuinely IS the clone. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: add a bare-name / basename compatibility fallback when containment
// or resolution fails ("if we cannot resolve it, fall back to comparing the word
// against the entry") — this pin goes red (deny 2 -> allow 0) while PV-C1,
// PV-C3 and PV-C2 all stay green. THE FALLBACK IS THE BYPASS: this is the sole
// load-bearing pin for step 7, and it is the one pin in this section that is
// genuinely RED at HEAD rather than green-for-the-wrong-reason.

// =============================================================================
// SECTION 6 — THE cc35e43c BYPASS, REPRODUCED AS A FIXTURE.
//
// Project holds `evil -> <base>/decoy/x/y`. The word
// `evil/../../clone/scripts/init.mjs` normalizes LEXICALLY to
// <base>/clone/scripts/init.mjs (the genuine sanctioned file) but resolves
// PHYSICALLY — the way bash/execve resolve it, after following the symlink — to
// <base>/decoy/clone/scripts/init.mjs, the planted file. cc35e43c measured
// exit 0 (ALLOW) for exactly this, "waving the fragment past the DATABASE SEAL".
//
// THE FINDING'S OWN CONTROL DISCIPLINE IS REPRODUCED VERBATIM: an unsanctioned
// name must deny in the same run, and the genuine absolute clone path must
// ALLOW. "A control that denies alongside the exploit means the mechanism under
// test never engaged" — that fixture defect produced a false negative on the
// finding's first probe run, and it is the reason the controls are listed first.
// =============================================================================

// Build the exploit world once per test (never shared) so a mutation cannot
// leak between arms.
function makeExploitWorld() {
  const w = makeWorld();
  mkdirSync(join(w.base, 'decoy', 'x', 'y'), { recursive: true });
  mkdirSync(join(w.base, 'decoy', 'clone', 'scripts'), { recursive: true });
  writeFileSync(join(w.base, 'decoy', 'clone', 'scripts', 'init.mjs'), '// PLANTED attacker file — the one execve actually opens\n');
  writeFileSync(join(w.base, 'decoy', 'clone', 'scripts', 'not-a-sanctioned-script.mjs'), '// planted, unsanctioned name\n');
  symlinkSync(join(w.base, 'decoy', 'x', 'y'), join(w.project, 'evil'), 'dir');
  return w;
}

const EXPLOIT_WORD = 'evil/../../clone/scripts/init.mjs';
const EXPLOIT_CONTROL_WORD = 'evil/../../clone/scripts/not-a-sanctioned-script.mjs';

test('PV-6-control-a (CONTROL, expect RED today): IN THE EXPLOIT FIXTURE, the genuine absolute clone path is ALLOWED — the mechanism engaged', { skip: SYMLINK_SKIP }, () => {
  const w = makeExploitWorld();
  try {
    const r = runHook(`node ${join(w.clone, 'scripts', 'init.mjs')} ${DB}`, w.project, seam(w.clone));
    assert.notEqual(r.code, null, 'the gate must not crash in the exploit fixture');
    assert.equal(
      r.code,
      0,
      `cc35e43c's PROBE-HYGIENE arm, reproduced verbatim: its first run denied ALL FOUR arms including this one, and that was a FIXTURE DEFECT, not a holding guard. If this denies, PV-6 below proves nothing whatsoever — the exemption never engaged in this world. stderr=${flat(r.stderr)}`
    );
  } finally {
    w.cleanup();
  }
});
// SABOTAGE: any mutation that removes the exemption reddens this — it is the
// same class of arm as PV-C1, kept LOCAL to the exploit fixture because the
// finding's false negative was fixture-specific, not global.

test('PV-6-control-b (CONTROL, opposite reason, expect GREEN today and after): the same symlink+`..` word carrying an UNSANCTIONED name DENIES in the same fixture', { skip: SYMLINK_SKIP }, () => {
  const w = makeExploitWorld();
  try {
    const r = runHook(`node ${EXPLOIT_CONTROL_WORD} ${DB}`, w.project, seam(w.clone));
    assert.notEqual(r.code, null, 'the gate must not crash on the unsanctioned exploit control');
    assert.equal(
      r.code,
      2,
      'cc35e43c: "A CONTROL arm using an unsanctioned name (evil.mjs) DENIED in the same run, proving the exemption produced the verdict rather than some blanket allow." Same symlink, same `..` arithmetic, same everything — only the name differs'
    );
  } finally {
    w.cleanup();
  }
});
// SABOTAGE: exempt any word that lexically resolves under the root regardless of
// the entry set — this pin goes red (deny 2 -> allow 0) while PV-6-control-a
// stays green.

test('PV-6 (THE EXECUTED BYPASS — expect GREEN today for the wrong reason, RED against the PARKED lexical implementation): a symlink + lexical `..` word is DENIED', { skip: SYMLINK_SKIP }, () => {
  const w = makeExploitWorld();
  try {
    const r = runHook(`node ${EXPLOIT_WORD} ${DB}`, w.project, seam(w.clone));
    assert.notEqual(r.code, null, 'the gate must not crash on the exploit word');
    assert.equal(
      r.code,
      2,
      `research_finding cc35e43c, EXECUTED not constructed: \`resolve()\` normalizes \`..\` LEXICALLY while bash/execve resolve it PHYSICALLY after following symlinks, so this word validated as <base>/clone/scripts/init.mjs (genuine, sanctioned) while the file that would actually run is <base>/decoy/clone/scripts/init.mjs (planted, attacker-controlled) — measured exit 0, past the DATABASE SEAL. Canonicalizing BOTH root and candidate with realpath (5b82e94f step 3) is what closes it. THIS PIN IS GREEN AT HEAD because HEAD compares literal strings and never resolves anything; its evidence is PV-6-control-a, which is RED at HEAD, and its real target is the parked lexical implementation, against which it goes red immediately. stderr=${flat(r.stderr)}`
    );
  } finally {
    w.cleanup();
  }
});
// SABOTAGE: replace the realpath canonicalization of the candidate with a
// lexical `resolve(projectDir, word)` — this pin goes red (deny 2 -> allow 0),
// reproducing cc35e43c's measured ALLOW exactly, while PV-6-control-a and
// PV-6-control-b both stay green. WHICH GUARD CARRIES THE VERDICT: realpath
// canonicalization of the CANDIDATE, single-handedly. Canonicalizing only the
// ROOT does not close it — the escape happens on the candidate side.

// =============================================================================
// SECTION 7 — THE CONSUMER FORM. This is the defect the slice exists to fix:
// H10 and CLAUDE.md print `node <clone>/scripts/rotation-note.mjs …` while H15
// compares against a repo-relative literal, so "the documented remedy is denied"
// (1434cd54's measured cost — two consecutive sessions could not write a
// rotation note; the consuming project's 2026-09-05 issues log repeats it).
// See ambiguity A1: rotation-note is sanctioned here VIA THE FIXTURE CONFIG, so
// these pin the mechanism, not the shipped-list question.
// =============================================================================

test('PV-7c (CONTROL, opposite reason, expect GREEN today and after): the same consumer-shaped invocation of an UNSANCTIONED clone script is DENIED', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    const r = runHook(
      `node ${join(clone, UNSANCTIONED)} --next-slice x --risks "vs ${DB}"`,
      project,
      seam(clone)
    );
    assert.equal(
      r.code,
      2,
      'identical shape, identical root, identical store-mentioning argument text — only the script name differs. PV-7b + PV-7c together prove the ENTRY SET decides, not "any absolute in-clone path is fine"'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: skip the entry-set equality once containment succeeds — this pin
// goes red (deny 2 -> allow 0) while PV-7b stays green.

test('PV-7a (expect RED today — THE CONSUMING-PROJECT DEFECT, as documented): the absolute clone rotation-note invocation is ALLOWED even though its ARGUMENT TEXT names a store path', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    const r = runHook(
      `node ${join(clone, 'scripts', 'rotation-note.mjs')} --next-slice x --risks "the .sterling/config.json toggle"`,
      project,
      seam(clone)
    );
    assert.notEqual(r.code, null, 'the gate must not crash on the documented rotation-note form');
    assert.equal(
      r.code,
      0,
      `THE EXACT SHAPE FROM THE ISSUES LOG. 5b82e94f: "the absolute clone invocation H10 and CLAUDE.md print becomes the form that matches, which is what the 2026-09-05 rotation-note denial needed." A sanctioned script's own ARGUMENTS are its business — the exemption exists precisely so a sanctioned launcher may do store work with whatever arguments it takes (see the AL-8 ruling in h15-allowlist-anchoring.test.mjs). NOTE, deliberately: this pin is WEAKER than PV-7b because \`.sterling/config.json\` is a non-DB store file that decision 0b4d3c8c may allow on other grounds — PV-7b is the load-bearing half. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: apply the store-path classifier to a sanctioned fragment's ARGUMENT
// text before granting the exemption — this pin goes red (allow 0 -> deny 2)
// together with PV-7b, reproducing the consumer denial this slice fixes.

test('PV-7b (expect RED today, STRONG HALF): the absolute clone rotation-note invocation is ALLOWED even when its argument text names the SEALED DB', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    const r = runHook(
      `node ${join(clone, 'scripts', 'rotation-note.mjs')} --next-slice x --risks "regression vs ${DB}"`,
      project,
      seam(clone)
    );
    assert.notEqual(r.code, null, 'the gate must not crash on the sealed-db-mentioning rotation-note form');
    assert.equal(
      r.code,
      0,
      `THE LOAD-BEARING HALF: the fragment names the SEALED db (fd9e96e0 fires the seal on ANY occurrence of the literal, for every verb), so NOTHING but the sanctioned-script exemption can produce an allow here. Unlike PV-7a it cannot be satisfied by the non-DB-store-read allowance. Compare PV-7c, which is the same command with an unsanctioned name and must deny. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the provenance check return false unconditionally — this pin
// goes red (allow 0 -> deny 2) via the DB seal, together with PV-C1. WHICH GUARD
// CARRIES THE VERDICT: the exemption's existence plus the absolute-form match;
// PV-C3 (relative form) stays green under an absolute-only regression, which is
// why the two forms are pinned apart.

// =============================================================================
// SECTION 8 — THE DENIAL TEXT (5b82e94f step 8; feature_article 7699f843:
// a gate NAMES the discriminator that fired).
// =============================================================================

test('PV-8a (expect RED today): a provenance denial NAMES the resolved canonical candidate', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    mkdirSync(join(project, 'scripts'), { recursive: true });
    writeFileSync(join(project, 'scripts', 'init.mjs'), '// planted attacker file\n');
    const expected = canon(join(project, 'scripts', 'init.mjs'));

    const r = runHook(`node ${SANCTIONED_INIT} ${DB}`, project, seam(clone));
    assert.equal(r.code, 2, `precondition: the planted decoy denies (PV-5) — stderr=${flat(r.stderr)}`);
    const text = String(r.stderr ?? '').replace(/\s+/g, ' ');
    assert.ok(
      text.includes(expected) || text.includes(posix(expected)),
      `5b82e94f step 8: "the denial NAMES the resolved canonical candidate and the entry set it was compared against, so the hardening never reads as random breakage." The operator here typed a command that looks correct and matches a sanctioned name exactly; without the RESOLVED path in the message there is no way to learn that the file resolved outside the active plugin root. Expected to find ${expected} (or its POSIX spelling) in the denial. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: print only the WORD as typed (or a bare "not a sanctioned script")
// instead of the canonical resolution — this pin goes red while PV-5 stays
// green. WHICH GUARD CARRIES THE VERDICT: the denial's provenance line, which is
// a DIFFERENT guard from the deny decision — a fix can be perfectly safe and
// still fail this pin, and that is the point.

test('PV-8b (expect RED today): no H15 denial still carries the FALSE clause "only writes, redirections, and moves/copies INTO .sterling/ are denied"', () => {
  // The clause is false as a description of H15's actual surface — the raw
  // command-text DB seal (fd9e96e0) fires on ANY occurrence of the literal, for
  // EVERY verb including reads, and the sanctioned-script check denies on
  // provenance grounds having classified nothing at all. A denial that misstates
  // its own rule sends the operator to rewrite a command that was never the
  // problem, which is what the consuming project's issues log records.
  //
  // ABSENCE IS ASSERTED WITH A DELIBERATELY LOOSE PATTERN: for a
  // must-not-contain pin, looser is STRONGER (a strict verbatim match would be
  // satisfied vacuously by a line wrap or a capitalization change).
  const FALSE_CLAUSE = /moves\s*\/\s*copies\s+into\s+\.sterling/i;

  const { project, clone, cleanup } = makeWorld();
  try {
    const denials = [];
    const push = (label, r) => {
      assert.equal(r.code, 2, `${label}: precondition — this shape must DENY for its stderr to be evidence. stderr=${flat(r.stderr)}`);
      denials.push([label, String(r.stderr ?? '').replace(/\s+/g, ' ')]);
    };
    push('unsanctioned in-clone script vs the sealed db', runHook(`node ${join(clone, UNSANCTIONED)} ${DB}`, project, seam(clone)));
    push('a plain read of the sealed db', runHook(`grep -c . ${DB}`, project, seam(clone)));

    // Non-vacuity: an absence assertion over an empty collection is always green.
    assert.ok(denials.length >= 2, 'at least two real denials must have been collected, or this absence pin is vacuous');
    for (const [label, text] of denials) {
      assert.doesNotMatch(
        text,
        FALSE_CLAUSE,
        `${label}: the denial still claims only writes/redirections/moves INTO .sterling are denied. That is FALSE — this very denial fired on a shape the clause says is permitted — and a gate that misstates its own rule is worse than a terse one, because the operator obeys the wrong instruction. Full text: ${text}`
      );
    }
  } finally {
    cleanup();
  }
});
// SABOTAGE: restore the clause to the shared denial body — this pin goes red
// while every verdict pin in this file stays green, which is exactly why the
// denial's WORDING is pinned separately from its DECISION.

// =============================================================================
// SECTION 9 — scripts/review-ledger.mjs IS A SANCTIONED ENTRY.
// Without it the discharge route decision 57984926 (3) prescribes is
// UNREACHABLE FROM THE SHELL — the same class as 1434cd54 Ruling 2's
// "the sanctioned recovery route is unreachable by its operator", and the
// consuming project's 2026-09-03 unreachable-receipt-discharge report.
// =============================================================================

test('PV-9a (expect RED today): SANCTIONED_SCRIPTS contains scripts/review-ledger.mjs', async () => {
  // The list is IMPORTED, never copied, so this file cannot become a second
  // rotting copy of it (the convention EX-3 in h15-allowlist-default-merge.test.mjs
  // established; decision 77c5b85a renamed REMEDIATION_SCRIPTS -> SANCTIONED_SCRIPTS
  // and deliberately did NOT rename the file).
  let SANCTIONED_SCRIPTS;
  try {
    ({ SANCTIONED_SCRIPTS } = await import(pathToFileURL(join(root, 'scripts', 'lib', 'store-remediation.mjs')).href));
  } catch (err) {
    assert.fail(
      `could not import SANCTIONED_SCRIPTS from scripts/lib/store-remediation.mjs (${err && err.message}). If the export moved, re-point this pin — do not delete it and do not hardcode the list`
    );
  }
  assert.ok(
    Array.isArray(SANCTIONED_SCRIPTS) && SANCTIONED_SCRIPTS.length > 0,
    'SANCTIONED_SCRIPTS must be a non-empty array — an empty one makes this pin vacuously meaningless'
  );
  assert.ok(
    SANCTIONED_SCRIPTS.includes(SANCTIONED_LEDGER),
    `decision 57984926 (3) makes \`scripts/review-ledger.mjs discharge\` the ONE explicit route for an unspendable receipt, and H1 is to PRINT that route (see scripts/tests/h1-receipt-remedy-wording.test.mjs). A remedy the guard denies is not a remedy — 1434cd54 Ruling 2 names exactly this shape ("the sanctioned recovery route H17's own denial text prescribes is UNREACHABLE BY ITS OPERATOR"), and 1434cd54 Ruling 6's no-bulk-add fence does not apply to a writer with an individual disposition, which this one now has. Current list: ${JSON.stringify(SANCTIONED_SCRIPTS)}`
  );
});
// SABOTAGE: remove `scripts/review-ledger.mjs` from SANCTIONED_SCRIPTS — this
// pin goes red on its own. WHICH GUARD CARRIES THE VERDICT: the list itself.
// Note this is a DATA pin, not a mechanism pin: it is deliberately separate from
// PV-9b so "the entry is missing" and "the provenance match is broken" cannot be
// confused for one another.

test('PV-9b (expect RED today): the documented discharge command runs through the absolute clone path against the sealed db', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    const r = runHook(
      `node ${join(clone, 'scripts', 'review-ledger.mjs')} discharge --entry-id x --digest y --class z --reason "foreign session, vs ${DB}"`,
      project,
      seam(clone)
    );
    assert.notEqual(r.code, null, 'the gate must not crash on the discharge command');
    assert.equal(
      r.code,
      0,
      `the sealed db is named in the argument text, so only the exemption can allow this. The consuming project reported the discharge route unreachable on 2026-09-03; a receipt that cannot be discharged is a permanent refusal on the merge gate. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop `scripts/review-ledger.mjs` from the entry set — this pin goes
// red (allow 0 -> deny 2) together with PV-9a. Dropping the ABSOLUTE-form match
// instead reddens this and PV-7b while PV-9a stays green: the pair separates the
// list question from the mechanism question.

test('PV-9c (expect GREEN today and after — WEAK BY DESIGN): the discharge command as documented, naming no store path, is ALLOWED', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    const r = runHook(
      `node ${join(clone, 'scripts', 'review-ledger.mjs')} discharge --entry-id x --digest y --class z --reason r`,
      project,
      seam(clone)
    );
    assert.equal(
      r.code,
      0,
      'the literal documented form. WEAK ON PURPOSE and labelled as such: it mentions no store path, so it is allowed by the no-store-mention path whether or not the exemption exists. Its value is stating that the documented command line must not become collateral of the hardening — PV-9b is the arm that proves the exemption'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: this pin is WEAK BY CONSTRUCTION and stays green under every
// exemption mutation; it only reddens if the hardening starts denying ordinary
// argument text. That asymmetry against PV-9b is why both exist — never read a
// PV-9c green as evidence about the exemption.

// =============================================================================
// SECTION 10 — WINDOWS / WSL PATH SHAPE.
// cc35e43c records that case variation on the case-insensitive /mnt/c mount was
// tried and produced "false-DENY only, never false-ALLOW". That asymmetry is
// the property to keep: comparison is on canonical forward-slash POSIX paths,
// and a wrong-case spelling must NEVER admit a non-sanctioned file.
// The case-fixture clone deliberately contains NO `scripts/init.mjs`, so the
// fixture is meaningful on a case-INSENSITIVE filesystem too (there is no
// lowercase sibling for the wrong-case spelling to alias onto).
// =============================================================================

const CASE_SCRIPTS = ['Init.mjs', 'rotation-note.mjs'];

// =============================================================================
// SECTION 11 — F1 (decision 95c2c109, TIGHTENED by the independent correctness +
// security reviews and the Codex consult of 2026-09-05): THE PLAIN-INVOCATION
// INVARIANT. A sanctioned script is run as `<interpreter> <script> <args>` with
// NOTHING between interpreter and script — the candidate is words[1], and a
// words[1] beginning with `-` voids the exemption whatever the option is.
//
// RE-CUT the same day it was written. The first cut enumerated code-execution
// options and scanned the WHOLE fragment. Review killed both halves: glued short
// forms (`python3 -c'code'`), stdin-program options (`bash -s`, `python3 -`),
// underscore spellings (`--experimental_loader=`), value-taking operands
// (`node --title <clone-file> /tmp/evil.mjs`) and `--env-file` all escaped the
// list while a GENUINE clone file sat in candidate position — and the trailing
// scan denied the repo's own sanctioned commit path (`commit-reviewed.mjs -m
// "<msg naming the store>"`), because every listed interpreter stops option
// parsing at the script path, so a `-` word AFTER the script is the script's
// argument and can never inject code. The old PV-11g pinned that false deny as
// desired behaviour; it is inverted below as PV-11-control-b, premise stated.
// =============================================================================

test('PV-11-control-a (CONTROL, F1 — THE REAL COMMAND): the documented sanctioned commit path, `commit-reviewed.mjs -m "<message naming the store>"`, is ALLOWED', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    const r = runHook(`node ${join(clone, 'scripts', 'commit-reviewed.mjs')} -m "chore: teach the ${DB} guard to explain itself"`, project, seam(clone));
    assert.equal(
      r.code,
      0,
      `commit-reviewed.mjs is a SHIPPED sanctioned entry and \`-m "<message>"\` is its ONLY invocation form (commands/merge.md). The message names the sealed db, so only the exemption can allow this; \`-m\` sits AFTER the script and is the script's own argument. The first F1 cut denied exactly this (its whole-fragment scan read -m as a code flag) — a live regression on the sanctioned commit path that the review caught. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: scan words AFTER the script for `-` words (or for a flag list
// containing -m) — this pin goes red (allow 0 -> deny 2) while every PV-11 deny
// stays green.

// RE-CUT 2026-09-05 — PIN-LEVEL PREMISE CHANGE (decision 95c2c109 F1 as tightened).
// OLD PREMISE (PV-11g): `-p "<code>"` AFTER the sanctioned script was pinned as an
//   exploit and required a deny.
// NEW PREMISE: node hands a post-script `-p` to the script in process.argv and
//   evaluates nothing, so the word is an ordinary argument and the exemption holds.
test('PV-11-control-b (CONTROL, F1): a `-` word AFTER the sanctioned script is the script\'s argument and keeps the exemption', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    const r = runHook(`node ${join(clone, 'scripts', 'init.mjs')} -p "require('fs').appendFileSync('${DB}','x')"`, project, seam(clone));
    assert.equal(
      r.code,
      0,
      `every interpreter in the set stops option parsing at the script path; -p here is argv to init.mjs, not node's --print. Denying it buys no security and costs every sanctioned script its own dash-prefixed arguments. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: restore the whole-fragment scan — this pin goes red while PV-11a..l
// stay green, which is how you tell "over-broad" from "positional".

for (const [id, label, mk] of [
  ['PV-11a', 'THE EXPLOIT: --import <genuine clone file> -e "<code>"', (clone) => `node --import ${join(clone, 'scripts', 'rotation-note.mjs')} -e "require('fs').appendFileSync('${DB}','x')"`],
  ['PV-11b', '--import=<genuine clone file> (equals form) -e "<code>"', (clone) => `node --import=${join(clone, 'scripts', 'rotation-note.mjs')} -e "require('fs').appendFileSync('${DB}','x')"`],
  ['PV-11c', '-r <genuine clone file> with the db as the "script"', (clone) => `node -r ${join(clone, 'scripts', 'init.mjs')} ${DB}`],
  ['PV-11d', '--require <genuine clone file> --eval "<code>"', (clone) => `node --require ${join(clone, 'scripts', 'init.mjs')} --eval "require('fs').appendFileSync('${DB}','x')"`],
  ['PV-11e', '--loader <genuine clone file>', (clone) => `node --loader ${join(clone, 'scripts', 'init.mjs')} ${DB}`],
  ['PV-11f', '--experimental_loader=<genuine clone file> (UNDERSCORE spelling node accepts — the one-character escape from any flag list)', (clone) => `node --experimental_loader=${join(clone, 'scripts', 'init.mjs')} ${DB}`],
  ['PV-11g', 'a HARMLESS option before the script (--no-warnings) — the invariant is positional, not a list', (clone) => `node --no-warnings ${join(clone, 'scripts', 'init.mjs')} ${DB}`],
  ['PV-11h', "python3 -c'<code>' <genuine clone file> (GLUED short form python accepts)", (clone) => `python3 -c'import os' ${join(clone, 'scripts', 'init.mjs')} ${DB}`],
  ['PV-11i', 'bash -s <genuine clone file> (program from STDIN, the file becomes $1)', (clone) => `bash -s ${join(clone, 'scripts', 'init.mjs')} ${DB}`],
  ['PV-11j', 'python3 - <genuine clone file> (bare dash: program from stdin)', (clone) => `python3 - ${join(clone, 'scripts', 'init.mjs')} ${DB}`],
  ['PV-11k', 'node --title <genuine clone file> /tmp/evil.mjs (a VALUE-TAKING option eats the sanctioned path; the next word runs — Codex finding)', (clone) => `node --title ${join(clone, 'scripts', 'init.mjs')} /tmp/evil.mjs ${DB}`],
  ['PV-11l', 'node --env-file=/tmp/e <genuine clone file> (NODE_OPTIONS re-entry through an env file)', (clone) => `node --env-file=/tmp/e ${join(clone, 'scripts', 'init.mjs')} ${DB}`],
]) {
  test(`${id} (F1, 95c2c109): ${label} is DENIED although a genuine sanctioned clone file sits in the fragment`, () => {
    const { project, clone, cleanup } = makeWorld();
    try {
      const r = runHook(mk(clone), project, seam(clone));
      assert.notEqual(r.code, null, 'the gate must not crash on an interpreter fragment carrying an option before the script');
      assert.equal(
        r.code,
        2,
        `${id}: a \`-\` word sits between the interpreter and the first non-option word, so the fragment is not a plain \`<interpreter> <script> <args>\` run — the genuine clone file in the fragment may be an option's VALUE, a stdin program's $1, or simply sit beside inline code, and no list of flags can tell which. The exemption is withheld and the fragment falls through to the classifier, where the DB seal fires. stderr=${flat(r.stderr)}`
      );
      assert.match(String(r.stderr ?? ''), /interpreter option/, `${id}: the denial's provenance line must NAME the interpreter option as the reason, so the operator learns to run the script plainly`);
    } finally {
      cleanup();
    }
  });
}
for (const [id, label, mk] of [
  ['PV-11o', 'command export (a wrapper word ahead of the mutator)', (s) => `command export NODE_OPTIONS='--require=/tmp/evil.cjs' && node ${s} ${DB}`],
  ['PV-11p', 'a brace group hiding the export', (s) => `{ export NODE_OPTIONS='--require=/tmp/evil.cjs'; node ${s} ${DB}; }`],
  ['PV-11q', 'a function definition shadowing the interpreter word', (s) => `node() { command node "$@"; }; node ${s} ${DB}`],
  ['PV-11r', 'a cd ahead of an absolute in-clone invocation (the compound-cd class MEDIUM b once disclosed)', (s) => `cd /tmp && node ${s} ${DB}`],
  ['PV-11s', 'printf -v PATH (a builtin OPTION that assigns — printf is not on the safe list at all)', (s) => `printf -v PATH %s 0 && node ${s} ${DB}`],
  ['PV-11t', 'echo "$((PATH=0))" (a safe VERB carrying an arithmetic expansion that assigns before echo runs)', (s) => `echo "$((PATH=0))" && node ${s} ${DB}`],
  ['PV-11u', 'a SANCTIONED predecessor whose own rider assigns — the predecessor verdict must be the FINAL one, rider check included', (s) => `node ${s} "$((PATH=0))" ; node ${s} ${DB}`],
  ['PV-11v', 'a safe VERB carrying a REDIRECT that overwrites the sanctioned file before running it (echo payload > <clone file> && node <clone file>)', (s) => `echo payload > ${s} && node ${s} ${DB}`],
]) {
  test(`${id} (F1, Codex round 3): ${label} withholds the exemption from the sanctioned invocation that follows`, () => {
    const { project, clone, cleanup } = makeWorld();
    try {
      const r = runHook(mk(join(clone, 'scripts', 'init.mjs')), project, seam(clone));
      assert.equal(
        r.code,
        2,
        `${id}: the predecessor is not on the known-safe list (a literal echo/true/:/pwd with no expansion, or a fragment granted the exemption), so nothing about the environment or cwd the interpreter starts in can be assumed. A MUTATOR list was tried first and every one of these shapes escaped it — the list is inverted to a safe list precisely so the next wrapper word does not reopen it. stderr=${flat(r.stderr)}`
      );
      assert.match(String(r.stderr ?? ''), /known-safe predecessor list/, `${id}: the denial names the predecessor rule`);
    } finally {
      cleanup();
    }
  });
}
// SABOTAGE: go back to a MUTATOR list (deny only when words[0] is export/declare/
// an assignment) — PV-11o..r all go red (deny 2 -> allow 0) while PV-11m still
// denies and PV-11n still allows. That asymmetry is the whole point of the pins.

test('PV-11m (F1, Codex round 2): an EARLIER fragment exporting NODE_OPTIONS disqualifies the plain sanctioned invocation that follows it', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    const r = runHook(`export NODE_OPTIONS='--require=/tmp/evil.cjs' && node ${join(clone, 'scripts', 'init.mjs')} ${DB}`, project, seam(clone));
    assert.equal(
      r.code,
      2,
      `fragment 2 is a textbook plain invocation of a genuine sanctioned file, but fragment 1 put a code-loading option into the ENVIRONMENT node reads at startup. The exemption is per fragment (AC-E) yet the environment is per command, so a predecessor that mutates it must disqualify every later exemption. stderr=${flat(r.stderr)}`
    );
    assert.match(String(r.stderr ?? ''), /EARLIER fragment of this command/, 'the denial names the predecessor as the reason');
  } finally {
    cleanup();
  }
});
// SABOTAGE: judge each fragment's exemption in isolation (drop unsafePredecessor)
// — this pin goes red (deny 2 -> allow 0) while PV-11-control-a/b and every other
// PV-11 arm are unaffected.

test('PV-11n (control, F1): the sanctioned script chained after a NON-env-mutating fragment keeps the exemption', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    const r = runHook(`echo starting && node ${join(clone, 'scripts', 'init.mjs')} ${DB}`, project, seam(clone));
    assert.equal(r.code, 0, `\`echo\` mutates nothing, so the predecessor rule must not fire — otherwise PV-11m is satisfiable by "any compound command denies". stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});
// SABOTAGE: set unsafePredecessor on ANY predecessor fragment (drop the safe
// list) — this pin goes red while PV-11m stays green.

// SABOTAGE: restore the "skip words starting with '-', take the first non-flag
// word as the program" extractor — PV-11a..l all go red (deny 2 -> allow 0)
// while both controls stay green. WHICH GUARD CARRIES THE VERDICT: the
// positional check on words[1] alone; provenance itself ALLOWS every one of
// these clone files. A flag LIST instead of the positional rule leaves 11f
// (underscore), 11g (harmless option), 11h (glued), 11i/11j (stdin), 11k
// (operand) and 11l (env-file) green — each is an escape the list had.

test('PV-10-control (CONTROL, expect RED today): in the case fixture, a correctly-spelled sanctioned script is ALLOWED', () => {
  const { base, project, cleanup } = makeWorld();
  try {
    const caseClone = makeClone(base, 'case-clone', { scripts: CASE_SCRIPTS });
    const r = runHook(`node ${join(caseClone, 'scripts', 'rotation-note.mjs')} ${DB}`, project, seam(caseClone));
    assert.notEqual(r.code, null, 'the gate must not crash in the case fixture');
    assert.equal(
      r.code,
      0,
      `the case fixture's own engagement control — without it, PV-10's deny could simply mean "this root never worked". stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: any mutation removing the exemption reddens this, as with PV-C1.
// It is kept local to the case fixture for the same fixture-defect reason
// cc35e43c records.

test('PV-10 (expect GREEN today and after — MUST NEVER FALSE-ALLOW): a case-only variation does NOT sanction a non-sanctioned file', () => {
  const { base, project, cleanup } = makeWorld();
  try {
    // `scripts/Init.mjs` is a REAL REGULAR FILE inside a VALID root, and it is
    // NOT `scripts/init.mjs`. The clone contains no lowercase sibling, so this
    // holds identically on ext4 and on NTFS/`/mnt/c`.
    const caseClone = makeClone(base, 'case-clone', { scripts: CASE_SCRIPTS });
    const r = runHook(`node ${join(caseClone, 'scripts', 'Init.mjs')} ${DB}`, project, seam(caseClone));
    assert.notEqual(r.code, null, 'the gate must not crash on a case-variant candidate');
    assert.equal(
      r.code,
      2,
      `THE ASYMMETRY THAT MATTERS (cc35e43c: case variation on the case-insensitive mount was "false-DENY only, never false-ALLOW"). A case-only difference may cost a legitimate operator a denial — annoying, recoverable, and explicitly accepted. It must never do the reverse: \`scripts/Init.mjs\` is a different file from the sanctioned \`scripts/init.mjs\`, and canonical comparison is EXACT on forward-slash POSIX paths, never case-folded. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: compare the canonical clone-relative path case-insensitively
// (`a.toLowerCase() === b.toLowerCase()`, a plausible "Windows friendliness"
// change) — this pin goes red (deny 2 -> allow 0) while PV-10-control, PV-C1 and
// PV-C2 all stay green. It is the sole load-bearing pin against case-folding,
// and the mutation is exactly the one a future Windows-parity fix would reach
// for.

test('PV-10b (expect GREEN today and after): a BACKSLASH spelling of an in-clone sanctioned path does not sanction a non-sanctioned file either', () => {
  const { base, project, cleanup } = makeWorld();
  try {
    const caseClone = makeClone(base, 'case-clone', { scripts: CASE_SCRIPTS });
    // a206a529 already fences the word syntax: no backslash, `~`, `$`, backtick,
    // colon or glob may appear in a sanctionable word. This pins that the fence
    // is not relaxed as collateral of "compare as POSIX" — normalizing
    // separators at comparison time must not start ACCEPTING words the syntax
    // fence rejects.
    const r = runHook(`node ${join(caseClone, 'scripts')}\\Init.mjs ${DB}`, project, seam(caseClone));
    assert.notEqual(r.code, null, 'the gate must not crash on a backslash-bearing word');
    assert.equal(
      r.code,
      2,
      'the canonical comparison is on forward-slash POSIX paths, which is about the COMPARISON, not about widening what spellings are sanctionable. A backslash word stays outside the accepted syntax (a206a529) and a non-sanctioned basename stays non-sanctioned either way'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: relax the sanctionable-word syntax to admit `\` while normalizing
// separators before comparison — this pin goes red (deny 2 -> allow 0) while
// PV-10 and PV-C1 stay green. Pinned separately from PV-10 because a
// Windows-parity change is likely to touch BOTH case-folding and separator
// normalization, and only separate pins say which one broke.

// ---------------------------------------------------------------------------
// PV-10c / PV-10d — R3's WIN32 FORWARD-SLASH DRIVE FORM.
//
// SPEC: decision `r3-plugin-root-resolver-canonical-module-win32-forward-slash-
// drive-word-backslash-provisional` (knowledge_get 37e588fb), step (B):
// sanctioned-provenance.mjs gains `wordSyntaxAdmits(word, platform =
// process.platform)` — the POSIX form /^[A-Za-z0-9_./+-]+$/ on EVERY platform,
// and when `platform === 'win32'` ALSO the forward-slash drive-absolute form
// /^[A-Za-z]:\/[A-Za-z0-9_./+-]+$/. Step (C): the BACKSLASH form stays refused
// on every platform (PROVISIONAL — the native-Windows shell string is
// unmeasured, and H14's h14-git-ro-grant.test.mjs:241-257 currently disagrees;
// the conflict is ruled once, after measurement, not here). Step (E): a drive
// path containing SPACES stays refused, symmetrically with the POSIX form — a
// DISCLOSED limitation, deliberately pinned so widening it is a visible,
// deliberate act rather than a quiet regex edit.
//
// The platform seam is a FUNCTION PARAMETER, never env/config (an env seam is
// the production-bypass shape 95c2c109 F2 rejected). That is what lets PV-10c
// exercise the win32 branch on this Linux host without any ambient state, and
// it is also why PV-10c is a UNIT pin: end-to-end, this platform's gate can
// never take the win32 branch at all.
// ---------------------------------------------------------------------------

test('PV-10c (UNIT, expect RED today): wordSyntaxAdmits gates the forward-slash DRIVE form on the platform PARAMETER, keeps refusing backslashes on both platforms, and keeps refusing spaces', async () => {
  let mod;
  try {
    mod = await import(pathToFileURL(join(root, 'scripts', 'hooks', 'lib', 'sanctioned-provenance.mjs')).href);
  } catch (err) {
    assert.fail(
      `could not import scripts/hooks/lib/sanctioned-provenance.mjs (${err && err.message}) — R3 step (B) puts wordSyntaxAdmits in this module (the RESOLVER moves to plugin-root.mjs; the word syntax does not)`
    );
  }
  assert.ok(
    typeof mod.wordSyntaxAdmits === 'function',
    `expected a wordSyntaxAdmits export — decision 37e588fb step (B) names it by this exact name and gives it the signature (word, platform = process.platform). exports=${Object.keys(mod).join(', ')}`
  );
  // Boolean-coerced deliberately: the spec fixes the DECISION ("admits" /
  // "refuses"), not the exact truthy value, and this author has not read the
  // module (H4). Over-pinning a return shape the spec never states would be a
  // false red.
  const admits = (word, platform) => Boolean(mod.wordSyntaxAdmits(word, platform));
  // NO platform argument at all — the shape PRODUCTION uses.
  const admitsByDefault = (word) => Boolean(mod.wordSyntaxAdmits(word));

  // --- CONTROL ARMS FIRST (they must pass for the OPPOSITE reason) ----------
  // Without these, every refusal below is satisfied identically by a function
  // that returns false unconditionally — "this syntax refuses everything" and
  // "this syntax refuses the drive form off win32" are indistinguishable from
  // a deny alone. These two arms are what make the refusals interpretable.
  assert.ok(
    admits('scripts/init.mjs', 'linux'),
    'CONTROL: the POSIX form /^[A-Za-z0-9_./+-]+$/ is admitted on EVERY platform (step B). If this is false, the function refuses everything and no refusal arm below proves anything'
  );
  assert.ok(
    admits('scripts/init.mjs', 'win32'),
    'CONTROL: the POSIX form is admitted on win32 TOO — the drive form is an ADDITION on win32, never a replacement (step B). A win32 branch that only admits drive-absolute words would break every self-hosted repo-relative invocation (PV-C3\'s shape)'
  );
  assert.ok(
    admits('C:/clone/scripts/init.mjs', 'win32'),
    'CONTROL / THE R3 WIDENING ITSELF: on win32 the forward-slash drive-absolute form /^[A-Za-z]:\\/[A-Za-z0-9_./+-]+$/ is admitted. This is the whole point of R3 step (B) — the word-syntax fence refusing `:` meant no native-Windows clone could ever sanction its own scripts (Windows/Linux 1:1 parity is a standing requirement)'
  );
  // WIDENED POSITIVES, so that a LITERAL-MATCHING implementation cannot pass
  // this pin: an `if (word === 'C:/clone/scripts/init.mjs')` special case, or a
  // regex anchored to this file's one fixture spelling, satisfies the three
  // arms above and NONE of the five below. Different drive letter, different
  // depth, and the POSIX class's less-obvious members (`..`, nested
  // directories, `+ - _`) are all admitted by the stated regexes.
  assert.ok(admits('D:/work/init.mjs', 'win32'), 'ANY drive letter, not just C: — /^[A-Za-z]:\\//. A pin that only ever showed C: would be satisfied by a hardcoded "C:" prefix test');
  assert.ok(admits('C:/a/b/c/init.mjs', 'win32'), 'ANY depth under the drive root — the tail class /[A-Za-z0-9_./+-]+/ includes `/`, so nesting is not a special case');
  assert.ok(admits('../scripts/init.mjs', 'linux'), 'the POSIX class admits `.` and `/`, so a `..` word is SYNTACTICALLY admitted on every platform. Syntax is not the guard that stops a `..` escape — realpath + containment is (PV-6), and conflating the two is exactly how a syntax tweak silently becomes a containment change');
  assert.ok(admits('../scripts/init.mjs', 'win32'), 'the same on win32: the drive form is an ADDITION, so the POSIX class must still admit a relative `..` word there');
  assert.ok(admits('scripts/sub/x.mjs', 'linux'), 'nested relative paths are admitted — the POSIX class is not one-segment-deep');
  assert.ok(admits('a+b-c_d.mjs', 'linux'), 'the `+`, `-` and `_` members of the POSIX class /^[A-Za-z0-9_./+-]+$/ are admitted. They are the characters most easily lost in a hand-retyped character class, and losing one would silently deny a legitimate consumer script');
  assert.ok(admits('a+b-c_d.mjs', 'win32'), 'the same on win32 — every POSIX-form word stays admitted there');

  // --- THE DEFAULT PLATFORM (the shape production uses) ---------------------
  // The `platform` parameter DEFAULTS to process.platform, so a call with no
  // second argument must behave exactly like this host. Guarded on the runner:
  // on win32 the correct answer inverts.
  if (process.platform !== 'win32') {
    assert.ok(
      admitsByDefault('scripts/init.mjs'),
      'CONTROL for the default-platform arm below, opposite reason: called with NO platform argument, the POSIX form is still admitted. Without this, the refusal below is satisfied identically by a defaulted call that throws away every word'
    );
    assert.ok(
      !admitsByDefault('C:/x/y.mjs'),
      `called with NO platform argument on a ${process.platform} host, the drive form must be REFUSED — the default is the RUNNING platform, never a hardcoded 'win32'. WHAT THIS ARM DOES AND DOES NOT CATCH, stated because the difference is easy to assume away: it reddens if the default is written as \`platform = 'win32'\` (or if the parameter is ignored and win32 assumed), and it does NOT redden if the default is DROPPED ALTOGETHER — an absent default makes platform \`undefined\`, which refuses the drive form on this host exactly as process.platform does. That second mutation is invisible to every runnable arm off win32, and is pinned in the SOURCE by PV-10f instead`
    );
  }

  // --- THE REFUSALS --------------------------------------------------------
  assert.ok(
    !admits('C:/clone/scripts/init.mjs', 'linux'),
    'THE PLATFORM GATE. The drive form is admitted ONLY when the platform argument is win32; the identical word must be REFUSED for a non-win32 platform. A drive-lettered word on POSIX is not a path — `C:` is a plain directory-name component there — and admitting it would let a word be sanctioned whose canonicalization is not what the shell would run'
  );
  assert.ok(
    !admits('C:\\clone\\scripts\\init.mjs', 'win32'),
    'STEP (C), PROVISIONAL AND DELIBERATE: the BACKSLASH drive form stays refused on win32. Which shell string the gate actually sees on native Windows is UNMEASURED (sterling.bat enters WSL; in Git Bash a backslash word is escape-processed before argv), so admitting it would sanction a word that is not the path the shell runs — and the rejected alternative in 37e588fb is exactly a backslash-to-slash substitution before realpath. Overturning this needs the native measurement (raw tool_input.command AND executed argv), not a regex edit'
  );
  assert.ok(
    !admits('C:\\clone\\scripts\\init.mjs', 'linux'),
    'the backslash form is refused on EVERY platform — this arm is the non-win32 half of step (C), and it is also the unit-level statement of what PV-10b pins end-to-end'
  );
  assert.ok(
    !admits('C:/Program Files/x/init.mjs', 'win32'),
    'STEP (E), DISCLOSED NOT WIDENED: a drive path containing SPACES is refused, exactly as a POSIX path with spaces is. The asymmetric widening (admit spaces on win32 only, because a quoted argument stays one word) was REJECTED in 37e588fb and is its own item if ever needed. This arm exists so that widening becomes a visible decision instead of a silent character-class edit'
  );
});
// SABOTAGE (one line each; each names the arm that must redden, and every other
// arm must stay green — that separation is the point of pinning them apart):
//   * drop the `platform === 'win32'` condition (admit the drive form
//     unconditionally) -> the 'linux' drive arm goes red; both CONTROLs and the
//     win32 drive arm stay green.
//   * delete the drive-form alternative from the syntax -> the win32 drive
//     CONTROL goes red; every refusal arm stays green (which is exactly why the
//     control is placed FIRST — a suite passing only its refusals would look
//     identical to a syntax that admits nothing).
//   * add `\\` to the character class (or substitute backslash->slash before
//     matching) -> both backslash arms go red.
//   * add a space to the character class -> the 'Program Files' arm goes red.
//   * `return false` unconditionally -> the two POSIX CONTROL arms go red FIRST,
//     which is the difference between "the fence works" and "the fence is a
//     brick wall".
//   * default the parameter to 'win32' (or ignore it and assume win32) -> the
//     default-platform arm goes red on this host. DROPPING the default entirely
//     is NOT caught here and cannot be caught off win32 (undefined refuses the
//     drive form exactly as a POSIX platform string does) — PV-10f pins that in
//     the source.
//   * special-case the one fixture spelling (`word === 'C:/clone/scripts/init.mjs'`)
//     or anchor the regex to it -> the widened positives (other drive letter,
//     deeper path, `..`, nested relative, `a+b-c_d.mjs`) go red while the three
//     original controls stay green. That is what those five arms are for.
// WHICH GUARD CARRIES THE VERDICT: the platform parameter alone for the
// linux/win32 split, and the character class alone for the backslash and space
// arms — nothing else in the function can produce these verdicts, because this
// is a pure syntax predicate with no filesystem access.

test('PV-10d (END-TO-END on the RUNNING platform, expect GREEN today and after — MUST NEVER FALSE-ALLOW): a forward-slash DRIVE-form word naming a non-sanctioned basename is DENIED', () => {
  const { base, project, cleanup } = makeWorld();
  try {
    // Same fixture shape as PV-10b: the case-clone contains `scripts/Init.mjs`
    // (a REAL regular file, in NO entry set) and NO lowercase sibling, so the
    // fixture is meaningful on a case-insensitive mount too.
    const caseClone = makeClone(base, 'case-clone', { scripts: CASE_SCRIPTS });
    const candidate = posix(join(caseClone, 'scripts', 'Init.mjs'));
    // Platform-neutral construction of the DRIVE-ABSOLUTE FORWARD-SLASH word:
    // on win32 the clone path is already `X:/…` in POSIX spelling; on this host
    // it is `/tmp/…`, so a `C:` prefix produces the shape R3 step (B) admits
    // only on win32. Both spellings are the word syntax's drive form; what
    // differs is whether this platform admits it at all.
    const word = /^[A-Za-z]:\//.test(candidate) ? candidate : `C:${candidate}`;
    const r = runHook(`node ${word} ${DB}`, project, seam(caseClone));
    assert.notEqual(r.code, null, 'the gate must not crash on a drive-form word');
    assert.equal(
      r.code,
      2,
      `R3 widens the SYNTAX only; it does not widen WHAT IS SANCTIONED. The admitted word still flows into the UNCHANGED realpath + active-plugin-root containment + EXACT clone-relative equality (5b82e94f steps 3-6), so \`scripts/Init.mjs\` — a real regular file in the root, in NO entry set — must still be DENIED. WHAT THE VERDICT RESTS ON, per platform, stated because it differs: on win32 the word IS admitted and canonicalizes to a real in-root file, so the deny is carried by the ENTRY-SET EQUALITY alone (the PV-10/PV-C2 guard); on this non-win32 host the word is refused by the platform gate AND could not canonicalize anyway, so the deny is carried by the syntax fence and the containment check together. The OPPOSITE-REASON CONTROL for this exact fixture is PV-10-control above (a correctly-spelled sanctioned script in the SAME case-clone must be ALLOWED) — without it, this deny could merely mean "this root never worked". word=${word} stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE (on THIS host — a non-win32 runner): treat a syntactically-admitted
// word as sanctioned WITHOUT the realpath/containment/equality steps (i.e.
// return the exemption straight off the syntax match), or fail OPEN when the
// candidate cannot be canonicalized (allow on a realpath throw) — either one
// turns this pin red (deny 2 -> allow 0) while PV-C1, PV-C2 and PV-10-control
// all stay green, because none of those exercises an uncanonicalizable word.
// ON A WIN32 RUNNER the load-bearing guard is a DIFFERENT one and the sabotage
// changes accordingly: skip the entry-set equality and grant any regular file
// contained under the canonical root (the PV-C2 sabotage) — there the word
// resolves, so only the equality check stands between it and a false allow.
// NOT hollow-by-construction and stated plainly: this pin is GREEN at HEAD, as
// PV-10b is, because a HEAD that compares literal words denies every absolute
// spelling. Its job is the never-false-ALLOW direction across the R3 change,
// which is the direction a syntax widening actually threatens.

// ---------------------------------------------------------------------------
// PV-10f — SOURCE PIN: THE WIDENED PREDICATE IS WIRED INTO PRODUCTION.
//
// WHY A SOURCE PIN, STATED PLAINLY BECAUSE IT IS THE ONLY ONE IN THIS FILE:
// OFF WIN32 THE WIDENING IS UNOBSERVABLE END-TO-END. PV-10d's deny is
// satisfied by the OLD fence just as well as by the new one (both refuse
// `C:/…` on a POSIX host), and no runnable arm here can tell "production
// consults the widened predicate" apart from "production still inlines the old
// regex" — the two agree on EVERY input a Linux runner can present. So the
// end-to-end surface cannot carry this claim at all, and the only
// Linux-observable evidence is the SOURCE. This is a static pin BY NECESSITY,
// not preference; the behavioural half is measurement-owed on native Windows
// (board cbe93c31, which names the drive-form sanction arm).
//
// WHAT IT ASSERTS IS STRUCTURE, NEVER PROSE, AND IT IS IDENTIFIER-AGNOSTIC:
// the ARITY of the production call (one argument, so the platform parameter
// DEFAULTS), never the local variable's name; and the presence of
// `= process.platform` in the definition's parameter list, which is the exact
// signature decision 37e588fb step (B) states. The test reads the module's
// TEXT at runtime — the author of this file has not read that module (H4).
//
// FAIL-OPEN CORNERS, DISCLOSED: the surviving-raw-regex check keys on an
// UPPER_SNAKE identifier containing "SYNTAX"; a differently-named constant
// makes that arm pass vacuously. It is a hygiene check riding beside the two
// load-bearing assertions, not the pin itself.
// ---------------------------------------------------------------------------

test('PV-10f (SOURCE PIN, expect RED today): the production fence calls wordSyntaxAdmits with ONE argument (platform DEFAULTS), the definition defaults it to process.platform, and no raw word-syntax regex test survives outside that function', () => {
  const srcPath = join(root, 'scripts', 'hooks', 'lib', 'sanctioned-provenance.mjs');
  let src;
  try {
    src = readFileSync(srcPath, 'utf8');
  } catch (err) {
    assert.fail(`could not read scripts/hooks/lib/sanctioned-provenance.mjs (${err && err.message}) — R3 step (B) puts the word-syntax predicate in this module`);
  }

  // (1) THE DEFINITION EXISTS AND CARRIES THE DEFAULT. Both the `function` and
  // the assigned-expression forms are accepted: the spec fixes the SIGNATURE
  // (`wordSyntaxAdmits(word, platform = process.platform)`), not the form.
  const defIdx = src.search(/(?:export\s+)?(?:function\s+wordSyntaxAdmits\b|(?:const|let|var)\s+wordSyntaxAdmits\b)/);
  assert.ok(
    defIdx >= 0,
    'no definition of wordSyntaxAdmits found in sanctioned-provenance.mjs — decision 37e588fb step (B) names it by this exact name and puts it in this module'
  );
  const defParams = (src.slice(defIdx).match(/\(([^)]*)\)/) || [, ''])[1];
  assert.match(
    defParams,
    /=\s*process\.platform/,
    `THE PLATFORM SEAM IS A FUNCTION PARAMETER THAT DEFAULTS TO THE RUNNING PLATFORM. 37e588fb states the signature verbatim: wordSyntaxAdmits(word, platform = process.platform). A default of 'win32' (or no default at all) would either sanction drive-shaped words on every POSIX host or silently disable the widening on Windows, and NO arm runnable on this host can see either one — which is why it is pinned here. got params=${JSON.stringify(defParams)}`
  );

  // (2) EVERY PRODUCTION CALL SITE PASSES EXACTLY ONE ARGUMENT. Both modules
  // that could legitimately hold the call site are scanned, so a coder who
  // wires the fence from the guard rather than from the provenance module gets
  // a GREEN, not a false red — the claim is about the CALL, not its address.
  // Two filters exclude the DEFINITION itself: the negative lookbehind on
  // `function `, and (for spacing/arrow forms the lookbehind cannot see) the
  // presence of a `= process.platform` default in the captured parameter list.
  const callSiteSources = [src];
  try {
    callSiteSources.push(readFileSync(join(root, 'scripts', 'hooks', 'h15-store-guard.mjs'), 'utf8'));
  } catch {
    // the guard is scanned only if present; its absence is PV-1's problem, not this pin's
  }
  const calls = callSiteSources
    .flatMap((text) => [...text.matchAll(/(?<!function\s)wordSyntaxAdmits\s*\(([^)]*)\)/g)])
    .map((m) => m[1].trim())
    .filter((argList) => !/=\s*process\.platform/.test(argList));
  assert.ok(
    calls.length >= 1,
    'wordSyntaxAdmits is DEFINED but never CALLED in sanctioned-provenance.mjs or h15-store-guard.mjs — the fence must consult it, or the widening is dead code and the gate still runs the old inline regex'
  );
  for (const argList of calls) {
    assert.ok(
      argList.length > 0 && !argList.includes(','),
      `THE SURVIVING MUTATION THIS PIN CLOSES: a production call of the form wordSyntaxAdmits(word, 'win32') leaves every RUNNABLE pin in this file green — PV-10c supplies its own platform argument, and PV-10d's deny is over-determined (its word also fails canonicalization). Production must pass ONE argument and let the platform DEFAULT. got call args=${JSON.stringify(argList)}`
    );
  }

  // (3) HYGIENE, fail-open by construction (see the disclosed corner above): no
  // raw word-syntax regex test survives outside the predicate's own body, so
  // there is exactly ONE place the syntax is decided.
  const after = src.slice(defIdx);
  const endRel = after.search(/\n\}/);
  const defEnd = endRel === -1 ? src.length : defIdx + endRel + 2;
  for (const m of src.matchAll(/\b[A-Z][A-Z0-9_]*SYNTAX[A-Z0-9_]*\s*\.test\s*\(/g)) {
    assert.ok(
      m.index >= defIdx && m.index < defEnd,
      `a raw word-syntax regex test survives OUTSIDE wordSyntaxAdmits (at index ${m.index}, the predicate spans ${defIdx}..${defEnd}) — two places deciding one syntax is how a widening ships while the gate keeps consulting the old fence. match=${JSON.stringify(m[0])}`
    );
  }
});
// SABOTAGE (each reddens exactly one assertion above; nothing else in this file
// observes any of them):
//   * change the production call to `wordSyntaxAdmits(word, 'win32')` -> (2)
//     goes red; PV-10c, PV-10d, PV-C1 and PV-C2 all stay green.
//   * change the definition's default to `platform = 'win32'`, or drop the
//     default entirely -> (1) goes red. Dropping it is INVISIBLE to every
//     runnable arm on a POSIX host (undefined !== 'win32' refuses the drive
//     form exactly as process.platform does), which is precisely why it is
//     pinned in the source.
//   * leave the fence calling the old inline regex and never call the new
//     predicate -> (2)'s `calls.length >= 1` goes red.
// WHICH GUARD CARRIES THE VERDICT: assertions (1) and (2) are independent and
// each stands alone; (3) is hygiene and may pass vacuously — it is NOT claimed
// as load-bearing.

// =============================================================================
// SECTION 12 — A CONSUMER-DECLARED, PROJECT-LOCAL allow_scripts ENTRY.
// Slice dome-farmer-issues-2026-09-05, follow-up ruling 2026-09-05 (prose-only
// until this section): 5b82e94f binds EVERY allow_scripts entry — shipped or
// consumer-declared — to the active plugin root, so a CONSUMING project can no
// longer sanction a store-writing script that lives only in its OWN tree, even
// one it names explicitly in its own config. h15-allowlist-default-merge.test.mjs
// states this at its ⚠ SEMANTIC CONSEQUENCE note (:119) without pinning it.
// PV-5 (:620) already denies a project-local file bearing a SHIPPED name, but
// nothing there is consumer-configured — it cannot tell "project entries are
// unconditionally clone-bound" apart from a future "project entries are
// project-scoped" branch that would reopen exactly this. This section is that
// missing pin.
//
// INVARIANT: "a consumer-declared allow_scripts entry does not sanction a
// project-local store writer; only the same entry resolving to a regular file
// inside the active plugin root is exempt."
// =============================================================================

// Unique to this section: appears in no shipped SANCTIONED_SCRIPTS entry and no
// other fixture name in this file (CLONE_SCRIPTS, CASE_SCRIPTS above). PV-12
// confirms this AT RUNTIME by importing the list, never by reading
// scripts/lib/store-remediation.mjs source (H4 read wall) — this author did not
// open that file.
const CUSTOM_ENTRY = 'scripts/project-writer.mjs';

// A world whose fixture config adds ONE consumer-declared custom entry on top
// of the shared CONFIG, by overwriting the config.json makeWorld() already
// wrote — the shared CONFIG constant, and every other pin that reads it, stays
// untouched.
function makeCustomEntryWorld() {
  const w = makeWorld();
  const cfg = {
    ...CONFIG,
    store_guard: { allow_scripts: [...CONFIG.store_guard.allow_scripts, CUSTOM_ENTRY] },
  };
  writeFileSync(join(w.project, '.sterling', 'config.json'), JSON.stringify(cfg));
  return w;
}

test('PV-12-control-a (CONTROL, opposite reason, expect GREEN — proves the mechanism engaged): the custom entry resolving inside the active plugin root IS exempt', () => {
  const { project, clone, cleanup } = makeCustomEntryWorld();
  try {
    writeFileSync(join(clone, CUSTOM_ENTRY), '// fixture: consumer-declared entry, genuinely inside the clone\n');
    const r = runHook(`node ${join(clone, CUSTOM_ENTRY)} ${DB}`, project, seam(clone));
    assert.notEqual(r.code, null, 'the gate must not crash on a genuinely in-clone consumer-declared entry');
    assert.equal(
      r.code,
      0,
      `IDENTICAL configured entry to PV-12, IDENTICAL config, differing ONLY in where the real file sits and which path invokes it. Without this arm PV-12's deny could mean "the entry was never read" or "nothing is ever exempt" — this is the evidence that the ENTRY ITSELF is honoured and only its LOCATION decided the verdict. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: stop reading project store_guard.allow_scripts into the entry set
// entirely (only the shipped SANCTIONED_SCRIPTS list is consulted) — this pin
// goes red (allow 0 -> deny 2) while PV-9a/PV-C1 (shipped entries) stay green,
// isolating "the project's OWN declared entries are honoured at all" from
// "which location they must resolve to".

test('PV-12 (TREATMENT, expect RED — THE ACCEPTED CONSEQUENCE, PROSE-ONLY UNTIL NOW): a consumer-declared entry naming a project-local file does NOT sanction it', async () => {
  const { SANCTIONED_SCRIPTS } = await import(pathToFileURL(join(root, 'scripts', 'lib', 'store-remediation.mjs')).href);
  assert.ok(
    !SANCTIONED_SCRIPTS.includes(CUSTOM_ENTRY),
    `${CUSTOM_ENTRY} collides with a shipped SANCTIONED_SCRIPTS entry, which would make this pin test the shipped-list question instead of the consumer-declared one — pick a different CUSTOM_ENTRY. Current list: ${JSON.stringify(SANCTIONED_SCRIPTS)}`
  );

  const { project, clone, cleanup } = makeCustomEntryWorld();
  try {
    // A REAL regular file, planted ONLY in the project's own tree — never in
    // the clone. The consumer's own store_guard.allow_scripts names exactly
    // this clone-relative word; decision 5b82e94f binds it to the active
    // plugin root regardless of who declared it.
    mkdirSync(join(project, 'scripts'), { recursive: true });
    writeFileSync(join(project, CUSTOM_ENTRY), '// fixture: a real project-local store writer, named only by the consumer config\n');
    const expected = canon(join(project, CUSTOM_ENTRY));

    const r = runHook(`node ${CUSTOM_ENTRY} ${DB}`, project, seam(clone));
    assert.notEqual(r.code, null, 'the gate must not crash on a consumer-declared project-local candidate');
    assert.equal(
      r.code,
      2,
      `THE ACCEPTED CONSEQUENCE, PINNED: 5b82e94f binds provenance to the active plugin root for EVERY allow_scripts entry, including one the CONSUMER declared in their own config — so a script that lives only in the consumer's own tree can no longer be sanctioned even by explicit configuration. Compare PV-12-control-a: identical entry, identical config, genuinely inside the clone, and ALLOWED. stderr=${flat(r.stderr)}`
    );
    const text = String(r.stderr ?? '').replace(/\s+/g, ' ');
    assert.ok(
      text.includes(expected) || text.includes(posix(expected)),
      `5b82e94f step 8 requires the denial to NAME the resolved canonical candidate. Expected to find ${expected} (or its POSIX spelling) in the denial. stderr=${flat(r.stderr)}`
    );
    assert.match(
      text,
      /OUTSIDE the active plugin root/,
      `the denial must attribute itself to CONTAINMENT — the candidate resolves outside the active plugin root — not to a bare "not sanctioned", or a future "project entries are project-scoped" branch could satisfy a weaker assertion while reopening exactly this. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: when an entry comes from the PROJECT's own store_guard.allow_scripts
// (as opposed to the shipped SANCTIONED_SCRIPTS list), skip the active-plugin-
// root containment check and accept a candidate resolving anywhere under the
// PROJECT instead — i.e. treat project-declared entries as project-scoped. This
// pin goes red (deny 2 -> allow 0) while PV-12-control-a stays green (its file
// already sits inside the clone, so a project-scoped OR a root-scoped check both
// pass it) — PV-12 is the ONLY pin in this file that tells the two apart.

test('PV-12-control-b (CONTROL, expect ALLOW when supported — REALPATH IDENTITY, not lexical location): a project-side symlink to the genuine in-clone entry keeps the exemption', { skip: SYMLINK_SKIP }, () => {
  const { project, clone, cleanup } = makeCustomEntryWorld();
  try {
    writeFileSync(join(clone, CUSTOM_ENTRY), '// fixture: consumer-declared entry, genuinely inside the clone\n');
    mkdirSync(join(project, 'scripts'), { recursive: true });
    symlinkSync(join(clone, CUSTOM_ENTRY), join(project, CUSTOM_ENTRY));

    const r = runHook(`node ${CUSTOM_ENTRY} ${DB}`, project, seam(clone));
    assert.notEqual(r.code, null, 'the gate must not crash on a project-side symlink to a genuine clone file');
    assert.equal(
      r.code,
      0,
      `a PROJECT-SIDE SYMLINK whose realpath IS the genuine in-clone file must be ALLOWED — proving REALPATH IDENTITY governs the exemption, not lexical project-vs-clone location. If PV-12's deny were instead keyed on "the invoking word lexically points somewhere under the project", this pin would wrongly deny too. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: decide containment by inspecting the INVOKING WORD's lexical
// location (does it look like it starts under the project directory?) rather
// than the realpath'd candidate — this pin goes red (allow 0 -> deny 2) while
// PV-12 stays green, isolating "identity, not spelling or location" as its own
// claim.

// =============================================================================
// SECTION 13 (board 8d8fc4e5) — EXACT EQUALITY MUST BE ANCHORED, NOT A SUFFIX.
//
// AL-9 in h15-allowlist-anchoring.test.mjs pins whole-word equality (a token
// merely ENDING WITH a sanctioned entry must not be exempt), but under
// provenance an absolute decoy like /tmp/scripts/init.mjs is now denied by TWO
// independent guards at once (containment AND equality), so AL-9's own
// endsWith sabotage no longer isolates anything there. The shape that DOES
// isolate anchored equality under provenance is a REAL file INSIDE the
// canonical root whose clone-relative path merely ENDS WITH a sanctioned entry
// — containment succeeds, only equality can decide.
// =============================================================================

test('PV-13 (board 8d8fc4e5, expect RED today): a real in-clone file whose clone-relative path merely ENDS WITH a sanctioned entry is DENIED, not exempted', () => {
  const { project, clone, cleanup } = makeWorld();
  try {
    mkdirSync(join(clone, 'scripts', 'vendor', 'scripts'), { recursive: true });
    writeFileSync(
      join(clone, 'scripts', 'vendor', 'scripts', 'init.mjs'),
      '// fixture: same BASENAME and same TAIL SEGMENTS as the sanctioned entry, wrong full path\n'
    );

    const r = runHook(`node ${join(clone, 'scripts', 'vendor', 'scripts', 'init.mjs')} ${DB}`, project, seam(clone));
    assert.notEqual(r.code, null, 'the gate must not crash on a suffix-matching in-clone candidate');
    assert.equal(
      r.code,
      2,
      `\`scripts/vendor/scripts/init.mjs\` ENDS WITH the sanctioned entry \`scripts/init.mjs\` as a STRING but is not EQUAL to it as a PATH — real file, real containment under the canonical root, everything correct except the comparison itself. An endsWith-based match would smuggle any file sitting under a same-named tail directory into the sanctioned set. Compare PV-C1: identical root, identical containment, and the entry's OWN exact path (\`scripts/init.mjs\`) is allowed there. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: change the entry-set comparison from exact string equality
// (`canonicalRelative === entry`) to a suffix test
// (`canonicalRelative.endsWith(entry)` or `.endsWith('/' + entry)`) — this pin
// goes red (deny 2 -> allow 0) while PV-C1 and PV-C2 both stay green (PV-C1's
// candidate is already exactly equal to the entry; PV-C2's shares no suffix
// with any entry at all) — PV-13 is the sole pin in this file that isolates
// anchored equality from a suffix match under provenance.

// =============================================================================
// SECTION 14 (board fb7c43fb, PIN GAP) — resolveActivePluginRoot FAILS CLOSED.
//
// "no arm exercises the fail-closed returns in `resolveActivePluginRoot` for an
// unreadable marker (chmod-000 fixture, skip when uid 0) or a module-URL
// failure — both must return root:null with source 'walk-up' and never
// consult the seam." (board fb7c43fb, PIN GAP, verbatim)
//
// B2a is tested END-TO-END. REPAIR (coder-measured, 2026-09-06): a plain
// recursive file copy of scripts/hooks/ + scripts/lib/ is NOT standalone —
// invariant #4 ("no workspace imports at runtime") describes the BUNDLES, not
// the SOURCES, and the copied guard dies with `Cannot find package
// '@sterling/schemas'` (exit 1, not a wrong verdict) because the raw source
// still imports the workspace package by specifier. The fixture below instead
// reuses buildSeamHook() — the SAME, already-proven bundling call this file
// uses at the top level (`SEAM = await buildSeamHook('h15-store-guard.mjs')`,
// used by every 'seam'-shaped pin above) — to obtain a single-file, dependency
// -free BUNDLE, and places that bundle's bytes at the SAME relative depth the
// real repo uses (scripts/hooks/<file>.mjs, two levels under a root carrying
// .claude-plugin/plugin.json + hooks/hooks.json), so ITS OWN walk-up discovers
// that root — and that root's plugin.json is then made unreadable. A SEPARATE,
// fully valid, genuinely sanctioned root is named through STERLING_PLUGIN_ROOT
// beside it, to prove that root is never reached despite being perfectly valid.
//
// B2b is tested by DIRECT IMPORT; its call shape is now CONFIRMED (coder
// measurement, not inference — see the comment at its call site).
// =============================================================================

const IS_ROOT_UID = process.getuid?.() === 0;

// Places a BUILT, standalone BUNDLE of the named hook at
// <fixtureRoot>/scripts/hooks/<hookFile> — the same depth this file already
// uses for hookPath construction elsewhere (e.g. runHook's 'source' shape) —
// inside a root that otherwise carries a full plugin layout. Reusing
// buildSeamHook() (rather than a fresh, unverifiable buildHooks({only})
// inference this author cannot confirm without reading implementation, H4)
// keeps this fixture on an already-proven call shape.
async function makeWalkUpFixture(base, { readableMarker = true } = {}) {
  const fixtureRoot = join(base, 'walkup-root');
  mkdirSync(join(fixtureRoot, '.claude-plugin'), { recursive: true });
  writeFileSync(join(fixtureRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: '0.0.0-fixture-walkup' }));
  mkdirSync(join(fixtureRoot, 'hooks'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
  mkdirSync(join(fixtureRoot, 'scripts', 'hooks'), { recursive: true });
  const built = await buildSeamHook('h15-store-guard.mjs');
  try {
    cpSync(built.hookPath, join(fixtureRoot, 'scripts', 'hooks', 'h15-store-guard.mjs'));
  } finally {
    await built.cleanup();
  }
  // This root's OWN genuine sanctioned script (fixture content, never executed).
  writeFileSync(join(fixtureRoot, 'scripts', 'init.mjs'), "// fixture: this root's OWN genuine sanctioned script\n");
  if (!readableMarker) {
    chmodSync(join(fixtureRoot, '.claude-plugin', 'plugin.json'), 0o000);
  }
  return fixtureRoot;
}

test('B2-control (CONTROL, expect GREEN when supported — proves the fixture engages): spawned from a READABLE walk-up root with NO env seam set at all, that root exempts its own genuine sanctioned script', async () => {
  const { base, project, cleanup } = makeWorld();
  try {
    const fixtureRoot = await makeWalkUpFixture(base, { readableMarker: true });
    const hookPath = join(fixtureRoot, 'scripts', 'hooks', 'h15-store-guard.mjs');
    const r = runHook(`node ${join(fixtureRoot, 'scripts', 'init.mjs')} ${DB}`, project, {}, hookPath);
    assert.notEqual(r.code, null, 'the gate must not crash when spawned from a copied walk-up root');
    assert.equal(
      r.code,
      0,
      `EVIDENCE for B2a: with NO env seam set at all, a copy of the guard running from inside a genuinely marker-carrying root must resolve THAT root by walk-up and exempt its own genuine sanctioned script. If this denies, B2a proves nothing — it could be failing because this copied-fixture shape never engages walk-up at all, rather than because of the unreadable marker. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: none isolates this control by itself — its purpose is proving the
// copied-fixture SHAPE engages walk-up at all; B2a is the pin that isolates the
// unreadable-marker fail-closed behavior specifically.

test(
  'B2a (board fb7c43fb PIN GAP, expect RED today)',
  { skip: IS_ROOT_UID ? 'running as uid 0: chmod 000 does not deny root, so this fixture cannot be built meaningfully' : false },
  async () => {
    const { base, project, clone, cleanup } = makeWorld();
    try {
      const fixtureRoot = await makeWalkUpFixture(base, { readableMarker: false });
      const hookPath = join(fixtureRoot, 'scripts', 'hooks', 'h15-store-guard.mjs');
      // `clone` is a SEPARATE, fully valid, genuinely sanctioned root (built by
      // makeWorld() itself) named through the env seam beside the broken
      // walk-up root. If the seam were consulted despite the walk-up failure,
      // this exact command would be exempt.
      const r = runHook(`node ${join(clone, 'scripts', 'init.mjs')} ${DB}`, project, seam(clone), hookPath);
      assert.notEqual(r.code, null, 'the gate must not crash on an unreadable walk-up marker');
      assert.equal(
        r.code,
        2,
        `an UNREADABLE walk-up marker fails closed — root:null — and must NEVER fall through to a validly-configured env seam (board fb7c43fb, PIN GAP). Here the seam names a PERFECTLY VALID alternate root carrying a genuinely sanctioned scripts/init.mjs; if this allows, the seam was consulted despite the walk-up failure. Compare B2-control, where the identical fixture shape with a READABLE marker allows its own script with no seam at all. stderr=${flat(r.stderr)}`
      );
    } finally {
      cleanup();
    }
  }
);
// SABOTAGE: catch the unreadable-marker (EACCES) error during layout
// validation and fall back to consulting STERLING_PLUGIN_ROOT — this pin goes
// red (deny 2 -> allow 0) while B2-control stays green (its marker is
// readable, so the fallback path is never reached there).

test('B2b (board fb7c43fb PIN GAP, expect RED today — CALL SHAPE CONFIRMED by coder measurement)', async () => {
  // ---------------------------------------------------------------------
  // REPAIR (coder-measured, 2026-09-06): the earlier `{ fromUrl }` shape here
  // was an unverified inference and worked only by accident — it stringifies
  // to '[object Object]', `new URL(...)` throws, and the fail-closed arm
  // returns, which is why `deepStrictEqual` against a two-key literal
  // happened to pass. The REAL export is
  // `resolveActivePluginRoot(moduleUrl, env = process.env)` — a POSITIONAL
  // STRING module-URL argument, not an options object — returning THREE keys
  // `{ root, source, reason }`; `reason` is LOAD-BEARING
  // (sanctionedProvenance reads `opts.pluginRoot.reason` for its denial
  // text), so the assertions below check the SUBSET the PIN GAP actually
  // states (root, source) plus reason's non-emptiness and subject, rather
  // than pinning the exact prose of a string this file's author has never
  // read (H4).
  // ---------------------------------------------------------------------
  let mod;
  try {
    // R3 (decision r3-plugin-root-resolver-canonical-module-…, step (A)): the
    // resolver's ONE canonical home is scripts/hooks/lib/plugin-root.mjs, and
    // the spec states there is NO compatibility re-export from
    // sanctioned-provenance.mjs — exactly one import path exists, so this pin
    // imports the canonical module DIRECTLY. If the extraction is incomplete
    // (module absent, or the export left behind), this fails on the assertion
    // below, never on a crash.
    mod = await import(pathToFileURL(join(root, 'scripts', 'hooks', 'lib', 'plugin-root.mjs')).href);
  } catch (err) {
    assert.fail(
      `could not import scripts/hooks/lib/plugin-root.mjs (${err && err.message}) — this module and its resolveActivePluginRoot export are the subject of board fb7c43fb's pin gap, and R3 step (A) makes plugin-root.mjs its ONE canonical home (no re-export from sanctioned-provenance.mjs)`
    );
  }
  assert.ok(
    typeof mod.resolveActivePluginRoot === 'function',
    `expected a resolveActivePluginRoot export — board fb7c43fb names it by this exact name. exports=${Object.keys(mod).join(', ')}`
  );

  const priorSeam = process.env.STERLING_PLUGIN_ROOT;
  const { clone, cleanup } = makeWorld();
  // A VALID, genuinely sanctioned root named through the seam — must never be
  // reached on a module-URL resolution failure.
  process.env.STERLING_PLUGIN_ROOT = clone;
  try {
    const result = mod.resolveActivePluginRoot('not a valid module url');
    assert.equal(
      result.root,
      null,
      `board fb7c43fb (PIN GAP): "both must return root:null ... and never consult the seam." A module-URL resolution failure must fail exactly like the unreadable-marker arm (B2a) — never degrading into reading STERLING_PLUGIN_ROOT, which is agent-settable. got=${JSON.stringify(result)}`
    );
    assert.equal(
      result.source,
      'walk-up',
      `board fb7c43fb (PIN GAP): "...with source 'walk-up'." The source must report the derivation that was ATTEMPTED (walk-up), not one that never ran — this is the field that would flip to something seam-derived if the code fell through despite the resolution failure. got=${JSON.stringify(result)}`
    );
    assert.equal(
      typeof result.reason,
      'string',
      `the real export returns {root, source, reason} — reason is LOAD-BEARING (sanctionedProvenance reads opts.pluginRoot.reason for its denial text), not an optional extra. got=${JSON.stringify(result)}`
    );
    assert.ok(result.reason.length > 0, `reason must be non-empty. got=${JSON.stringify(result)}`);
    assert.match(
      result.reason,
      /seam|STERLING_PLUGIN_ROOT/i,
      `reason must say the test seam was not consulted (its EXACT prose is deliberately unpinned — this author has not read the module, H4). got=${JSON.stringify(result.reason)}`
    );
  } finally {
    if (priorSeam === undefined) delete process.env.STERLING_PLUGIN_ROOT;
    else process.env.STERLING_PLUGIN_ROOT = priorSeam;
    cleanup();
  }
});
// SABOTAGE: catch the module-URL resolution failure and fall through to
// reading process.env.STERLING_PLUGIN_ROOT — this pin goes red (result.root
// becomes the clone path, or result.source stops reporting 'walk-up') while
// B2a (a different code path — the unreadable-marker arm, not the module-URL
// arm) is unaffected.
