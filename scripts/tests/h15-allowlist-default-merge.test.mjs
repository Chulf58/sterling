// H15 store-guard — EXPLICIT allow_scripts MUST EXTEND THE SHIPPED DEFAULT,
// NOT REPLACE IT (frozen pins).
//
// WHAT THIS FILE PINS, IN ONE SENTENCE: when a project's
// `.sterling/config.json` carries an EXPLICIT `store_guard.allow_scripts`
// array, the shipped sanctioned scripts stay sanctioned — the project's array
// ADDS to the shipped set instead of silently shadowing it — while a script in
// NEITHER set stays DENIED and the denial stays loud.
//
// ---------------------------------------------------------------------------
// PROVENANCE — board 94d6368a (HIGH), consumer feedback 2026-08-28.
// ---------------------------------------------------------------------------
// An explicit `allow_scripts` array REPLACES the zod schema default rather than
// growing with it (`config.ts`'s `.default([...])` applies only when the key is
// ABSENT). Consequence, measured 2026-08-27 and recorded in decision 77c5b85a
// (`sanctioned-script-reach-carries-the-shipped-list`): every consuming
// project's TUI launcher `packages/tui/bundle/sterling-tui.mjs` stayed falsely
// H15-DENIED — including this repo's own project — because config.ts had gained
// the entry in its default while every explicit array was frozen without it.
// The failure is SILENT and it fails CLOSED on the enforcement surface: a
// project that sets `allow_scripts` to add ONE entry silently loses EVERY
// shipped default, and the consumer cannot distinguish that from the script
// simply not being allowlisted.
//
// WHAT ALREADY EXISTS, so these pins are not mistaken for uncovered ground:
// decision 77c5b85a shipped a CONFIG-SPACE mitigation — `/sterling:init` and
// `/sterling:update` now APPEND the missing shipped entries into a consuming
// project's explicit array (append-missing-only, disclosed, no reorder or
// removal). That closes the gap ONLY for a project that RUNS update. These pins
// are about the GUARD's own reading of a config it is handed: between a
// Sterling release adding a sanctioned script and a consumer running update —
// or forever, if they never run it — the hook itself must not treat an explicit
// array as a replacement of the shipped set.
//
// THE WORST SHAPE, which board 94d6368a says to verify FIRST: decision bc0f81e3
// exists because a false DENY on the schema-migration scripts is the one trap
// that must never spring. The store's refuse-until-migrated posture makes
// `scripts/migrate-stores.mjs` / `scripts/migration-preflight.mjs` the ONLY
// exit from a read-only store, so a stale explicit array that shadows them
// locks a consumer out of their own remediation. EX-2 and EX-2b pin exactly
// that shape. (bc0f81e3's hardcoded remediation floor was BUILT and PARKED, not
// shipped — three review rounds each found a distinct bypass — so today nothing
// rescues those two scripts from a shadowing array.)
//
// ---------------------------------------------------------------------------
// THE DIRECTION OF THE FIX IS DANGEROUS. READ THIS BEFORE CHANGING ANYTHING.
// ---------------------------------------------------------------------------
// The obvious fix — union the project's array with the shipped defaults — makes
// a SECURITY BOUNDARY MORE PERMISSIVE. `allow_scripts` is H15's allowlist: an
// entry exempts a command fragment from classification, which is what lets it
// touch the sealed store. So this file pins BOTH directions, and the CONTROL
// ARM COMES FIRST, deliberately: every "allow" pin below has more than one
// possible cause (the intended union, or a fix that simply stopped honouring
// the allowlist / started allowing everything), and EX-C2 / EX-C4b must pass
// for the OPPOSITE reason so a green run always carries its own evidence.
//
// ---------------------------------------------------------------------------
// A SPEC CHOICE MADE HERE, FLAGGED FOR THE CONDUCTOR TO RULE ON: `[]`
// ---------------------------------------------------------------------------
// The design is SILENT on what `allow_scripts: []` means. Two readings:
//   (a) "extend with nothing" -> all nine shipped defaults are still sanctioned;
//   (b) "trust nothing"       -> an explicit empty array is a deliberate
//                                lockdown and NOTHING is sanctioned.
// EX-4 / EX-4b pin (b), the CONSERVATIVE reading, and it is also the STATUS QUO
// (today an explicit `[]` replaces the default, so nothing is sanctioned — these
// two pins are GREEN at HEAD and must STAY green). Reading (a) would let a
// project that deliberately locked itself down be QUIETLY RE-OPENED by an
// upgrade, which is the same class of silent policy change this whole file
// exists to close, just pointing the other way.
// THE TENSION, stated rather than buried: (b) collides with bc0f81e3's
// operability concern — a locked-down consumer whose store is refuse-until-
// migrated cannot run the migration scripts either. That is a genuine
// conductor ruling, not a test detail. If the ruling goes the other way, EX-4b
// flips to ALLOW and EX-4 stays DENY (a remediation FLOOR is not the same as
// merging the whole shipped list). Do not flip either one silently.
//
// ---------------------------------------------------------------------------
// NOT DUPLICATED HERE — the sibling hardening item. ⚠ IT HAS NOW LANDED.
// ---------------------------------------------------------------------------
// Board 2ca5d977 (`h15-enforcement-hardening`) owned CLONE PROVENANCE: requiring
// the matched path to resolve INSIDE the plugin clone. It was BUILT, REVIEWED and
// PARKED IN A STASH, carrying 13 pins. THAT PARK IS OVER: decision 5b82e94f
// (`h15-realpath-binding-active-plugin-root-provenance`, user-approved
// 2026-09-05) made the outstanding realpath-binding ruling, the mechanism
// shipped, and its pins live in scripts/tests/h15-active-root-provenance.test.mjs.
// Nothing here re-pins resolution, `..` escapes, symlinks, drive letters, or
// planted-decoy shapes — that is still its territory and it must not be forked.
// EX-6a/EX-6b touch path SHAPE only as a PARITY question (does the merge
// normalize both halves of the union the same way), and they still move as a
// PAIR.
//
// FIXTURE RE-CUT 2026-09-05, EXECUTING THIS FILE'S OWN INSTRUCTION. The
// paragraph that stood here said: "at HEAD the sanctioned-script check is
// NAME-ONLY EQUALITY (no existence, identity or provenance check), so the
// fixtures below deliberately do NOT create any file at the sanctioned paths …
// If clone provenance ever lands, EVERY pin in this file must be re-cut to
// invoke through the clone path; that is a re-cut, not a bend."
//   OLD PREMISE: spelling was the grant; a fixture file at a sanctioned path
//     would have been a decoy, so none was created.
//   NEW PREMISE (5b82e94f): spelling grants NOTHING. A candidate must realpath
//     to a REGULAR FILE inside the canonicalized, layout-validated ACTIVE PLUGIN
//     ROOT at a clone-relative POSIX path equal to an entry. `allow_scripts`
//     entries are therefore CLONE-RELATIVE (a206a529's closing paragraph).
//   HOW IT IS RE-CUT: `makeProject()` builds the fixture project AS a valid
//     active plugin root — the three layout markers, plus a real regular file at
//     every SANCTIONED_SCRIPTS entry (read from the module, never copied) and at
//     the two fixture-declared names — and `runHook()` points the
//     STERLING_PLUGIN_ROOT test seam at it. EVERY COMMAND STRING BELOW IS
//     BYTE-IDENTICAL. Planting the files is no longer building a decoy: the
//     project IS the root, which is the SELF-HOSTED shape (project and clone are
//     one tree) that decision a206a529 requires to keep working and that the
//     provenance suite pins as PV-C3. The CONSUMER shape (project ≠ clone, where
//     a planted `<project>/scripts/init.mjs` MUST deny) is pinned there, by
//     PV-5, and is not forked here.
//   WHY NOT "invoke through a separate clone path" instead: it would hollow the
//     deny pins. EX-C2/EX-C4b/EX-4/EX-4b must deny for a LIST reason; if their
//     subject resolved to nothing, the regular-file check would carry every one
//     of those verdicts and their named sabotages would be inert.
// ⚠ SEMANTIC CONSEQUENCE, SURFACED NOT BURIED: under 5b82e94f a project can no
//   longer sanction a script that lives only in ITS OWN tree — `allow_scripts` is
//   now a clone-relative allowlist, so PROJECT_SCRIPT below is a project-DECLARED
//   entry that must still resolve inside the active plugin root. On the authoring
//   machine those are the same tree and nothing is lost; in a consuming project
//   the ability to allowlist a project-local tool is GONE. That is a real
//   consequence of the ruling, reported to the conductor rather than settled by a
//   test.
//
// ---------------------------------------------------------------------------
// Related governing records, read before authoring: board 94d6368a (the
// defect), decision 77c5b85a (the shipped list IS the reach; the bidirectional
// drift pin in scripts/tests/store-remediation.test.mjs holds
// SANCTIONED_SCRIPTS == the config.ts allow_scripts default), decision bc0f81e3
// (the migration-lockout trap; floor parked), decision 0b4d3c8c (H15 is
// write-precision: non-DB store reads allowed, sterling.db sealed for every
// verb — which is why every pin below names the db), decision a8bec43f
// (improving a denial NEVER loosens the allow surface), decision ccc44a8e (the
// broad command-TEXT classifier is terminal-accepted — nothing here reopens
// it), anti_pattern caecf8a6 (the exemption must be anchored to the fragment's
// EXECUTABLE argument), anti_pattern f1d66bef (an early assertion masks every
// later one — hence one behaviour per test, and EX-3 collects rather than
// short-circuits), feature_article 7699f843 `hook-write-gates` (a gate names
// the DISCRIMINATOR that fired).
//
// Written BLIND to scripts/hooks/h15-store-guard.mjs (H4 read wall); the
// records above are the entire spec. Harness conventions (runHook / makeProject)
// follow scripts/tests/h15-precision*.test.mjs and
// scripts/tests/h15-allowlist-anchoring.test.mjs and are reproduced STANDALONE
// so this file runs independently — those files are NEITHER modified, imported,
// nor duplicated by reference.
//
// MUTATION DISCIPLINE (decision 23afbc83): every pin below carries a SABOTAGE
// comment naming the one-line implementation change that must turn it RED, and
// says which guard carries the verdict. NONE of them is executed here — this
// file's author holds no Bash by design, and NO RED OUTPUT IS CLAIMED.

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
// The seam-spawnable H15 bundle (95c2c109 F2) — built once per suite.
let SEAM;
after(() => SEAM?.cleanup());
// FIXTURE RE-CUT: the shipped list is IMPORTED, never copied, so this file still
// cannot become a second rotting copy of it (the EX-3 convention). It is needed
// at FIXTURE-BUILD time now, because every entry must exist as a real regular
// file inside the fixture's plugin root. EX-3 keeps its OWN local import and its
// own re-point message — that pin is byte-identical and deliberately shadows
// this binding.
let SHIPPED_SANCTIONED = [];
before(async () => {
  SEAM = await buildSeamHook('h15-store-guard.mjs');
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ SANCTIONED_SCRIPTS: SHIPPED_SANCTIONED } = await import(pathToFileURL(join(root, 'scripts', 'lib', 'store-remediation.mjs')).href));
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
  // H1's clone-currency probe must never fire inside a hook unit test.
  const childEnv = { ...process.env, STERLING_CURRENCY_DISABLE: '1' };
  // FIXTURE RE-CUT (5b82e94f step 1): CLAUDE_PLUGIN_ROOT is AGENT-SETTABLE and is
  // never provenance — scrubbed so an ambient live-session value cannot decide
  // these verdicts. STERLING_PLUGIN_ROOT is the TEST-ONLY seam and names the
  // fixture project, which IS the active plugin root.
  delete childEnv.CLAUDE_PLUGIN_ROOT;
  childEnv.STERLING_PLUGIN_ROOT = cwd;
  // SPAWN LOCATION RE-CUT (decision 95c2c109 F2): the hook is a FRESH BUNDLE
  // built from the live sources into a marker-free temp dir (see
  // scripts/tests/lib/seam-hook.mjs). The active root PREFERS the running
  // hook's own walk-up and reads STERLING_PLUGIN_ROOT only when that walk-up
  // finds no plugin tree — so spawning the SOURCE hook from scripts/hooks/
  // would resolve THIS repo as the root and silently ignore the seam.
  const r = spawnSync(process.execPath, [SEAM.hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: childEnv,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// The sealed store db. Every pin that must be decided BY THE ALLOWLIST names
// it: without a store reference the fragment is allowed by the no-store-mention
// path and the pin would be hollow (decision 0b4d3c8c seals the db for every
// verb, so nothing but the exemption can produce an allow).
const DB = '.sterling/sterling.db';

// A script the PROJECT declares. Not shipped by Sterling; named only by the
// fixture config. Its continued reachability is the no-regression half.
// RE-CUT 2026-09-05: since 5b82e94f an `allow_scripts` entry is CLONE-RELATIVE
// (a206a529's closing paragraph), so a project-DECLARED entry must ALSO resolve
// inside the active plugin root — the fixture therefore creates this file there.
// See the ⚠ SEMANTIC CONSEQUENCE note in the header: on a consuming machine a
// genuinely project-local tool can no longer be allowlisted at all.
const PROJECT_SCRIPT = 'scripts/project-local-tool.mjs';

// A script in NEITHER set. The security control's subject.
const UNSANCTIONED = 'scripts/not-a-sanctioned-script.mjs';

// SHIPPED DEFAULTS used by name. Sourced from the DECISION RECORDS, not from
// reading config.ts (H4). 77c5b85a names the TUI launcher as the measured
// casualty; bc0f81e3 names the two migration scripts as the lockout trap;
// 2ca5d977 names init/domain-doctor as shipped entries that are FREE NAMES in a
// consuming project. EX-3 re-derives the WHOLE list mechanically so this file
// does not become a second, rotting copy of it.
const SHIPPED_TUI = 'packages/tui/bundle/sterling-tui.mjs';
const SHIPPED_MIGRATE = 'scripts/migrate-stores.mjs';
const SHIPPED_PREFLIGHT = 'scripts/migration-preflight.mjs';
const SHIPPED_INIT = 'scripts/init.mjs';
const SHIPPED_DOCTOR = 'scripts/domain-doctor.mjs';

const TOOLCHAINS = [
  { adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } },
];
const CAPS = { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 };
const CONTEXT_WATCH = { windows: { default: 200_000, 'claude-fable-5': 200_000 } };

// storeGuard is passed through VERBATIM so each fixture states exactly the
// config posture it is testing: an explicit array, an explicit EMPTY array, or
// `{}` (the key absent, so the schema default applies).
function makeProject(storeGuard, tag = 'merge') {
  const dir = mkdtempSync(join(tmpdir(), `sterling-h15${tag}-`));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(
    join(dir, '.sterling', 'config.json'),
    JSON.stringify({ toolchains: TOOLCHAINS, caps: CAPS, context_watch: CONTEXT_WATCH, store_guard: storeGuard })
  );
  // FIXTURE RE-CUT (5b82e94f step 2): the three plugin-layout markers, validated
  // BEFORE the root is trusted. Without them the marker-validated seam fails
  // closed (a206a529) and every ALLOW pin here would be red for a fixture reason.
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: '0.0.0-fixture' }));
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
  // FIXTURE RE-CUT (5b82e94f step 4): every candidate must exist as a REGULAR
  // FILE under the root. UNSANCTIONED is created deliberately — with the file
  // PRESENT, EX-C2's and EX-C4b's denies are attributable to LIST MEMBERSHIP
  // alone, which is the only thing they are meant to prove; absent, the
  // regular-file check would carry those verdicts and both pins would be hollow.
  assert.ok(
    Array.isArray(SHIPPED_SANCTIONED) && SHIPPED_SANCTIONED.length > 0,
    'FIXTURE PRECONDITION, not a behaviour: SANCTIONED_SCRIPTS must have imported (see the before() hook). An empty list would build a root holding none of the shipped scripts, and every ALLOW pin in this file would be red for a FIXTURE reason rather than a behavioural one — which is the false negative research_finding cc35e43c warns about'
  );
  for (const rel of [...SHIPPED_SANCTIONED, PROJECT_SCRIPT, UNSANCTIONED]) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '// fixture script — never executed by these pins\n');
  }
  // A REAL store db file, matching how every other hook test builds a project —
  // project-root resolution keys on .sterling/sterling.db actually existing.
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { dir, cleanup };
}

// A "tuned" project config of exactly the shape the defect describes: the
// project declared ONE entry of its own and, by doing so, silently lost every
// shipped default.
const TUNED = { allow_scripts: [PROJECT_SCRIPT] };
// The key ABSENT — the schema default applies. This is the posture that proves
// the shipped names are genuinely sanctioned names.
const DEFAULTED = {};
// The deliberate lockdown. See the `[]` spec-choice note in the header.
const LOCKED = { allow_scripts: [] };

// =========================================================================
// CONTROL ARM — FIRST, DELIBERATELY.
//
// EX-C1 proves the fixture config PARSES (H15 is fail-closed on an unparseable
// config, so without this a deny anywhere below could just be fail-closed).
// EX-C2 is the SECURITY control: it must pass for the OPPOSITE reason to every
// allow pin, and it is the arm that stops the union fix from becoming a hole.
// EX-C3 is the NO-REGRESSION control: a project-declared entry keeps working.
// EX-C4 + EX-C4b are the load-bearing PAIR: under a DEFAULTED config the
// shipped launcher is allowed and an unsanctioned script is denied — which is
// what establishes that EX-1's red is about the EXPLICIT ARRAY SHADOWING the
// shipped set, and not about the shipped name being bogus in the first place.
// =========================================================================

test('EX-C1 (control, expect GREEN today and after): the tuned fixture config PARSES — a fragment naming no store path is ALLOWED', () => {
  const { dir, cleanup } = makeProject(TUNED);
  try {
    const r = runHook('node scripts/some-unrelated-thing.mjs', dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a fragment naming no store path');
    assert.equal(
      r.code,
      0,
      'H15 is fail-closed on an unparseable config. If THIS denies, the fixture config is malformed and every deny verdict in this file is meaningless — fix the fixture before reading any other result here'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the config loader treat a `store_guard` object without every
// optional key as invalid (fail-closed) — this pin goes red (allow 0 -> deny 2)
// and takes the whole file's interpretability with it, which is exactly why it
// is pinned first and separately.

test('EX-C2 (control, SECURITY ARM, expect GREEN today and after): a script in NEITHER set is DENIED against the sealed db, loudly', () => {
  const { dir, cleanup } = makeProject(TUNED);
  try {
    const r = runHook(`node ${UNSANCTIONED} ${DB}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on an unsanctioned script naming the store db');
    assert.equal(
      r.code,
      2,
      'THE ARM THAT STOPS THIS FIX BECOMING A SECURITY HOLE. Merging the shipped defaults into an explicit array makes the allowlist STRICTLY LARGER; a script that is in neither the project array nor the shipped list must still be denied. If this ever goes green, the union was implemented as "allow anything script-shaped" and every allow pin below is passing for the wrong reason'
    );
    assert.match(
      r.stderr,
      /sterling\.db/,
      'THE DENY MUST STAY LOUD: the denial names the sealed db path it fired on (feature_article hook-write-gates — a gate names the DISCRIMINATOR). A union fix that broadened the allowlist and also blurred the refusal would hide its own blast radius'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: replace the merged-allowlist membership test with a predicate that
// accepts any `*.mjs` token in executable position — this pin goes red
// (deny 2 -> allow 0) while EX-C3 and EX-1 stay green. It is the sole
// load-bearing pin for "the union did not become a blanket allow".

// RE-CUT 2026-09-05 (decision 5b82e94f; discipline per 77c5b85a).
// OLD PREMISE: the project's array entry `scripts/project-local-tool.mjs` was
//   exempt by SPELLING, and no such file existed in the fixture.
// NEW PREMISE: the word must resolve to a regular file inside the layout-
//   validated active plugin root at exactly that clone-relative path — so the
//   fixture creates it. See the ⚠ SEMANTIC CONSEQUENCE note in the header: a
//   project-DECLARED entry is now also CLONE-relative.
// CLAIM UNCHANGED: the project's own array stays authoritative for its own
//   entries — the fix ADDS the shipped set and must never replace the project's
//   array in the other direction. This is still the only pin catching that
//   mirror-image defect.
test('EX-C3 (control, NO-REGRESSION arm, expect GREEN today and after): the PROJECT-declared entry stays ALLOWED against the sealed db', () => {
  const { dir, cleanup } = makeProject(TUNED);
  try {
    const r = runHook(`node ${PROJECT_SCRIPT} ${DB}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a project-declared sanctioned script');
    assert.equal(
      r.code,
      0,
      "the project's own array is still authoritative for its own entries. The fix ADDS the shipped set; it must never replace the project's array in the other direction, which would be the identical defect with the operands swapped"
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the merged list the SHIPPED defaults only, discarding the
// project's array — this pin goes red (allow 0 -> deny 2) while EX-1/EX-2 stay
// green. That mutation is the mirror-image defect and this is the only pin that
// catches it.

// RE-CUT 2026-09-05 (decision 5b82e94f; discipline per 77c5b85a).
// OLD PREMISE: `packages/tui/bundle/sterling-tui.mjs` was exempt by SPELLING
//   under a defaulted config, with no file at that path in the fixture.
// NEW PREMISE: it must resolve to a regular file inside the active plugin root
//   at exactly that clone-relative path — created by the fixture from the
//   IMPORTED shipped list, so this pin still cannot hardcode the list.
// CLAIM UNCHANGED: with the key ABSENT the schema default applies, so the TUI
//   launcher IS a genuinely sanctioned name — which is what makes EX-1's verdict
//   attributable to the SHADOWING and to nothing else.
test('EX-C4 (control, OPPOSITE-REASON arm, expect GREEN today and after): with allow_scripts ABSENT the shipped TUI launcher is ALLOWED against the sealed db', () => {
  const { dir, cleanup } = makeProject(DEFAULTED, 'dflt');
  try {
    const r = runHook(`node ${SHIPPED_TUI} ${DB}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on the shipped launcher under a defaulted config');
    assert.equal(
      r.code,
      0,
      'THIS IS THE EVIDENCE THAT MAKES EX-1 READABLE: with the key absent the schema default applies, so packages/tui/bundle/sterling-tui.mjs IS a genuinely sanctioned name. EX-1 runs the identical command against a config differing ONLY by carrying an explicit array — so EX-1\'s red is attributable to the SHADOWING and to nothing else. If this pin is red at HEAD, the shipped default no longer carries the launcher and the whole file must be re-cut against decision 77c5b85a'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop `packages/tui/bundle/sterling-tui.mjs` from the shipped
// allow_scripts default — this pin goes red (allow 0 -> deny 2) TOGETHER with
// EX-1, and the pair going red together (rather than EX-1 alone) is how you
// tell "the shipped list shrank" apart from "the merge broke".

test('EX-C4b (control, the opposite reason for EX-C4, expect GREEN today and after): under the SAME defaulted config an unsanctioned script is DENIED', () => {
  const { dir, cleanup } = makeProject(DEFAULTED, 'dflt');
  try {
    const r = runHook(`node ${UNSANCTIONED} ${DB}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on an unsanctioned script under a defaulted config');
    assert.equal(
      r.code,
      2,
      'same config, same command SHAPE, only the script name differs — so EX-C4\'s allow came from the ALLOWLIST and not from a defaulted config being treated as "no guard configured, allow everything". Without this pin, EX-C4 has more than one possible cause'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: treat an absent `store_guard.allow_scripts` as "guard not
// configured, skip classification" instead of applying the schema default —
// this pin goes red (deny 2 -> allow 0) while EX-C4 stays green, which is
// exactly the false-green EX-C4 alone could not detect.

// =========================================================================
// THE DEFECT — board 94d6368a. All RED at HEAD.
//
// Each pin below is the SAME COMMAND as an EX-C4-class control, run against a
// config that differs ONLY by carrying an explicit `allow_scripts` array which
// omits the entry. One behaviour per test (anti_pattern f1d66bef).
// =========================================================================

// RE-CUT 2026-09-05 (decision 5b82e94f; discipline per 77c5b85a). Applies to
// EX-1, EX-2, EX-2b, EX-3 and EX-5b alike — one shared premise change:
// OLD PREMISE: a shipped entry merged into the effective allowlist was exempt by
//   SPELLING, so the fixture created no file for it.
// NEW PREMISE: the merge decides MEMBERSHIP; provenance decides IDENTITY, and
//   BOTH must now hold. The fixture creates a real regular file inside the
//   active plugin root for every imported shipped entry, so membership is the
//   only variable left — which is exactly what these pins are about.
// CLAIM UNCHANGED: an explicit array EXTENDS the shipped default rather than
//   replacing it (decision 00867be9 / board 94d6368a). The named sabotage
//   ("restore replace-semantics") stays live and load-bearing.
test('EX-1 (expect RED today): with an explicit allow_scripts that omits it, the shipped TUI launcher is still ALLOWED against the sealed db', () => {
  const { dir, cleanup } = makeProject(TUNED);
  try {
    const r = runHook(`node ${SHIPPED_TUI} ${DB}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on the shipped launcher under a tuned config');
    assert.equal(
      r.code,
      0,
      'THE DEFECT, MEASURED (decision 77c5b85a): an explicit array REPLACES the schema default instead of growing with it, so a config frozen before the default gained this entry silently un-sanctions it. This is the exact command that stayed falsely DENIED in every consuming project — including this repo\'s own — and the consumer had no way to tell it from "not allowlisted". Compare EX-C4: identical command, config differs ONLY by the presence of the explicit array'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: restore replace-semantics — read the effective allowlist as
// `config.store_guard.allow_scripts` alone rather than as its union with the
// shipped list — this pin goes red (allow 0 -> deny 2), reproducing the defect
// exactly, while EX-C3 (project entry) and EX-C4 (defaulted config) both stay
// green. WHICH GUARD CARRIES THE VERDICT: a SINGLE guard, the union itself.
// There is no defense in depth here — this pin is load-bearing on its own.

// RE-CUT 2026-09-05 — same premise change as EX-1 above (spelling -> identity;
// the fixture now holds a real `scripts/migrate-stores.mjs` inside the active
// plugin root). CLAIM UNCHANGED: the lockout trap. Note the trap got SHARPER
// under 5b82e94f, not milder — a consumer's only exit from a refuse-until-
// migrated store must satisfy BOTH the merge and provenance, so the absolute
// clone form is now the one that matches (pinned in the provenance suite).
test('EX-2 (expect RED today, THE LOCKOUT TRAP — verify this first): with an explicit allow_scripts that omits it, scripts/migrate-stores.mjs is still ALLOWED against the sealed db', () => {
  const { dir, cleanup } = makeProject(TUNED);
  try {
    const r = runHook(`node ${SHIPPED_MIGRATE} ${DB}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on the migration runner under a tuned config');
    assert.equal(
      r.code,
      0,
      'THE WORST SHAPE THE DEFECT CAN TAKE (board 94d6368a; decision bc0f81e3). The store\'s refuse-until-migrated posture makes migrate-stores.mjs the ONLY exit from a read-only store. A stale explicit array that shadows it turns a RECOVERABLE state into a dead end the consumer cannot self-serve out of — a refusal whose remediation is itself config-deniable is a trap. bc0f81e3\'s hardcoded remediation floor was BUILT and PARKED, never shipped, so nothing else rescues this today'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: restore replace-semantics (as EX-1) — this pin goes red
// (allow 0 -> deny 2). It is NOT redundant with EX-1: a fix that curated a
// short "important entries" sublist to merge instead of merging the whole
// shipped list could leave EX-1 green and this red, or the reverse. Pinning the
// launcher and the migration runner separately is what makes the difference
// visible; EX-3 then closes the general case.

// RE-CUT 2026-09-05 — same premise change as EX-1 above; the fixture now holds a
// real `scripts/migration-preflight.mjs` inside the active plugin root. CLAIM
// UNCHANGED: both migration scripts are the remediation path, pinned separately
// because a curated merge could plausibly carry one and not the other.
test('EX-2b (expect RED today, THE LOCKOUT TRAP, second half): with an explicit allow_scripts that omits it, scripts/migration-preflight.mjs is still ALLOWED against the sealed db', () => {
  const { dir, cleanup } = makeProject(TUNED);
  try {
    const r = runHook(`node ${SHIPPED_PREFLIGHT} ${DB}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on the migration preflight under a tuned config');
    assert.equal(
      r.code,
      0,
      'decision bc0f81e3 names BOTH migration scripts as the remediation path, and the preflight is what a consumer is told to run FIRST. Pinned separately from EX-2 because a curated merge could plausibly carry one and not the other'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: restore replace-semantics (as EX-1) — this pin goes red
// (allow 0 -> deny 2). Same single-guard verdict as EX-1; its independent value
// is COVERAGE of the second remediation script, not a second layer.

// RE-CUT 2026-09-05 — same premise change as EX-1 above, with one addition that
// matters: the fixture creates a regular file for EVERY entry of the IMPORTED
// list (see makeProject), so this pin still covers the WHOLE list mechanically
// and grows by itself when the list does. It grew on 2026-09-05: the list gained
// `scripts/review-ledger.mjs` (board 891284a9, a single Ruling-6 disposition
// under decision 1434cd54), so this loop now runs 10 entries, not 9 — with no
// edit here, which is the property the mechanical derivation was for.
test('EX-3 (expect RED today): EVERY entry of the shipped sanctioned list is reachable under an explicit allow_scripts that omits it', async () => {
  // The list is re-derived MECHANICALLY rather than copied, so this file cannot
  // become a second rotting copy of it. Decision 77c5b85a makes
  // `SANCTIONED_SCRIPTS` and the config.ts `allow_scripts` default
  // element-identical, and holds that invariant with a bidirectional drift pin
  // in scripts/tests/store-remediation.test.mjs — so reading either one names
  // the same entries (nine until 2026-09-05; ten since `scripts/review-ledger.mjs`
  // was added, board 891284a9 — the count is deliberately not asserted here).
  let SANCTIONED_SCRIPTS;
  try {
    ({ SANCTIONED_SCRIPTS } = await import(pathToFileURL(join(root, 'scripts', 'lib', 'store-remediation.mjs')).href));
  } catch (err) {
    assert.fail(
      `could not import SANCTIONED_SCRIPTS from scripts/lib/store-remediation.mjs (${err && err.message}). Decision 77c5b85a renamed REMEDIATION_SCRIPTS -> SANCTIONED_SCRIPTS and deliberately did NOT rename the file. If the export moved again, re-point this pin — do not delete it and do not hardcode the list`
    );
  }
  assert.ok(
    Array.isArray(SANCTIONED_SCRIPTS) && SANCTIONED_SCRIPTS.length > 0,
    'SANCTIONED_SCRIPTS must be a non-empty array — an empty one would make this pin vacuously green, which is the hollow shape this file is written to avoid'
  );

  const { dir, cleanup } = makeProject(TUNED);
  try {
    // COLLECT, never short-circuit: anti_pattern f1d66bef — an early assertion
    // failure would hide how many entries are actually unreachable, and the
    // COUNT is the finding here.
    const denied = [];
    for (const entry of SANCTIONED_SCRIPTS) {
      const r = runHook(`node ${entry} ${DB}`, dir);
      assert.notEqual(r.code, null, `the gate must not crash on shipped entry ${entry}`);
      if (r.code !== 0) denied.push(`${entry} (exit ${r.code})`);
    }
    assert.deepEqual(
      denied,
      [],
      `SHIPPED SANCTIONED SCRIPTS UNREACHABLE under an explicit allow_scripts array that omits them. This is the general case EX-1/EX-2/EX-2b sample: every entry Sterling ships as sanctioned must survive a project declaring its own array, or the consuming project silently freezes at whatever the list was on the day its config was written. Unreachable: ${denied.join(', ')}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: merge only a curated SUBSET of SANCTIONED_SCRIPTS (e.g. the two
// migration scripts) instead of the whole list — this pin goes red while EX-2
// and EX-2b stay green, which is precisely the failure mode EX-1/EX-2 alone
// cannot see. WHICH GUARD CARRIES THE VERDICT: the union's SOURCE (whole list
// vs sublist), which is a different guard from the union's EXISTENCE that EX-1
// pins.

// =========================================================================
// EX-4 / EX-4b — THE EMPTY ARRAY. SPEC CHOICE, GREEN AT HEAD, MUST STAY GREEN.
// See the `[]` note in the header. These are the pins that stop the union fix
// from quietly re-opening a project that deliberately locked itself down.
// =========================================================================

test('EX-4 (SPEC CHOICE — expect GREEN today and after): an explicit EMPTY allow_scripts is a deliberate lockdown — the shipped TUI launcher is DENIED', () => {
  const { dir, cleanup } = makeProject(LOCKED, 'lock');
  try {
    const r = runHook(`node ${SHIPPED_TUI} ${DB}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash under an empty allow_scripts');
    assert.equal(
      r.code,
      2,
      'CONSERVATIVE READING, DELIBERATELY CHOSEN AND FLAGGED (see the header): `allow_scripts: []` means TRUST NOTHING, not "extend with nothing". A project that empties the array has made a policy statement; a union fix that read `[]` as "all nine shipped defaults allowed" would silently RE-OPEN it on upgrade — the same silent policy change this file exists to close, pointing the other way. Contrast EX-C4: the key ABSENT is a different posture from the key PRESENT AND EMPTY, and the two must not collapse'
    );
    assert.match(r.stderr, /sterling\.db/, 'the lockdown denial is loud and names the sealed db it fired on');
  } finally {
    cleanup();
  }
});
// SABOTAGE: implement the union as `[...shipped, ...(config.allow_scripts ??
// [])]` unconditionally — this pin goes red (deny 2 -> allow 0) while EX-1,
// EX-2, EX-3 and EX-C3 ALL stay green. That is the whole point: the naive union
// passes every defect pin in this file and silently re-opens a locked project,
// and EX-4 is the SOLE load-bearing pin against it. The correct shape
// distinguishes ABSENT (default applies, then union) from PRESENT-AND-EMPTY
// (explicit lockdown, no union).

test('EX-4b (SPEC CHOICE, FLAGGED FOR RULING — expect GREEN today; a ruling may flip it): under an EMPTY allow_scripts the migration runner is DENIED too', () => {
  const { dir, cleanup } = makeProject(LOCKED, 'lock');
  try {
    const r = runHook(`node ${SHIPPED_MIGRATE} ${DB}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on the migration runner under an empty allow_scripts');
    assert.equal(
      r.code,
      2,
      'THE PIN WHERE TWO RULINGS COLLIDE, stated rather than buried. EX-4\'s conservative reading of `[]` says deny; decision bc0f81e3\'s operability concern says a consumer must NEVER be config-denied out of their only migration path. Today bc0f81e3\'s remediation floor is PARKED (not shipped), so DENY is the status quo and that is what is pinned. If the conductor rules that a remediation FLOOR overrides an explicit lockdown, THIS pin flips to 0 and EX-4 stays 2 — a floor for two named scripts is not the same as merging the whole shipped list. Do not flip it because it is inconvenient; flip it on a ruling, and record the ruling'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: add a hardcoded remediation floor that bypasses the empty-array
// lockdown — this pin goes red (deny 2 -> allow 0) while EX-4 stays green. That
// mutation IS the open bc0f81e3 question, so a red here is a SPEC RULING TO
// ESCALATE, never silently a defect.

// =========================================================================
// EX-5 — LISTING IS ADDITIVE, NEVER SUBTRACTIVE.
//
// The dangerous middle case: a project array that mentions SOME shipped
// entries. A naive reading — "they curated the list, honour it exactly" —
// makes the act of listing one entry SUBTRACT every other. If replacement is
// ever wanted it must be requested EXPLICITLY and LOUDLY, never as a side
// effect of listing. NOTE: no replacement opt-out KEY is pinned here, because
// none exists in the declared config interface and inventing one is not this
// file's job — that shape is a conductor question, flagged in the report.
// =========================================================================

const PARTIAL = { allow_scripts: [SHIPPED_INIT, PROJECT_SCRIPT] };

// RE-CUT 2026-09-05 — same premise change as EX-1 above; `scripts/init.mjs` now
// exists inside the active plugin root, so the verdict turns on the merge and not
// on identity. CLAIM UNCHANGED: a duplicate between the project array and the
// shipped list must not cancel out (the XOR-merge sabotage stays live and is
// still the only pin catching it).
test('EX-5a (control, expect GREEN today and after): an explicitly RE-LISTED shipped entry still works', () => {
  const { dir, cleanup } = makeProject(PARTIAL, 'part');
  try {
    const r = runHook(`node ${SHIPPED_INIT} ${DB}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a re-listed shipped entry');
    assert.equal(
      r.code,
      0,
      'a duplicate between the project array and the shipped list must not cancel out. This is the control that makes EX-5b readable: the array IS being honoured, so EX-5b\'s deny is about the OMITTED entry alone'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: implement the union with a symmetric-difference / XOR-style merge
// (an entry present in both sets is dropped) — this pin goes red
// (allow 0 -> deny 2) while EX-1 and EX-3 stay green. A plausible off-by-one in
// a de-duplicating merge, and nothing else in this file catches it.

// RE-CUT 2026-09-05 — same premise change as EX-1 above; `scripts/domain-doctor.mjs`
// now exists inside the active plugin root, so an omitted-but-merged entry is
// denied only if the MERGE dropped it. CLAIM UNCHANGED: omission is not removal.
test('EX-5b (expect RED today): listing SOME shipped entries must not SUBTRACT the ones left out', () => {
  const { dir, cleanup } = makeProject(PARTIAL, 'part');
  try {
    const r = runHook(`node ${SHIPPED_DOCTOR} ${DB}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on an omitted shipped entry');
    assert.equal(
      r.code,
      0,
      'OMISSION IS NOT REMOVAL. A project that lists scripts/init.mjs plus one of its own has ADDED, not curated: scripts/domain-doctor.mjs stays sanctioned. Silent subtraction is exactly the defect board 94d6368a reports, in the shape that is easiest to mistake for intent — "they wrote a list, honour the list". If a project genuinely wants to REPLACE the shipped set, that must be requested explicitly and disclosed loudly; it must never be a side effect of naming one entry'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: union the shipped list only when the project array is EMPTY-OR-
// ABSENT, treating any non-empty array as a full curation — this pin goes red
// (allow 0 -> deny 2) together with EX-1/EX-2/EX-3. WHICH GUARD CARRIES THE
// VERDICT: the same single union guard as EX-1, so EX-5b is not an independent
// layer; its value is stating the ADDITIVE/SUBTRACTIVE semantics as an explicit
// frozen claim a later reader cannot re-litigate by reading code.

// =========================================================================
// EX-6 — PATH-SHAPE PARITY ACROSS THE TWO HALVES OF THE UNION.
//
// SCOPE FENCE: this is NOT clone provenance. Board 2ca5d977 owns resolution,
// `..` escapes, symlinks and planted decoys, is BUILT AND PARKED with its own
// 13 pins, and must not be forked here. What EX-6 pins is narrower and belongs
// squarely to the merge: whatever normalization the allowlist ALREADY applies
// to a project-declared entry must apply EQUALLY to a merged shipped entry. A
// naive union that concatenates raw strings while normalizing only the config
// half is a real and easy mistake, and it fails CLOSED and SILENTLY — the exact
// failure mode of the defect being fixed.
//
// THE PAIR MOVES TOGETHER. EX-6a states the believed HEAD behaviour (a single
// leading `./` is stripped before comparison). If the parked clone-provenance
// work later rules a leading `./` DENIED, then EX-6a and EX-6b BOTH flip to 2 —
// re-cut as a pair, never flip one. If EX-6a is RED at HEAD, EX-6b is moot and
// the finding is that `./` is not normalized at all: report it, do not "fix"
// the test.
// =========================================================================

// RE-CUT 2026-09-05 (decision 5b82e94f) — THE ONE PLACE WHERE THE MECHANISM
// CARRYING THE CLAIM CHANGED, so read this before trusting the sabotage below.
// OLD PREMISE: HEAD stripped a single leading `./` from the word as a STRING
//   before comparing it to the entry, and this pin pinned that strip.
// NEW PREMISE: nothing strips anything. `./x` and `x` resolve to the SAME path
//   and therefore canonicalize to the same regular file, so the leading `./`
//   is normalized by realpath rather than by a text rule.
// CLAIM UNCHANGED: a leading `./` must not defeat the allowlist, and it must not
//   defeat it differently for the two halves of the union (EX-6b).
// ⚠ SABOTAGE RE-STATED, because the printed one is now INERT: "remove the
//   leading-`./` strip from the allowlist comparison" no longer reddens this pin
//   — there is no strip left to remove, and realpath handles the shape. THE
//   SABOTAGE THAT NOW REDDENS EX-6a: compare the WORD AS TYPED against the entry
//   instead of the CANONICAL clone-relative path (allow 0 -> deny 2), which
//   reddens EX-6a and EX-6b together; the isolating one for EX-6b alone is still
//   "normalize the config half but not the merged shipped half".
test('EX-6a (control, expect GREEN today and after): a leading `./` does not defeat the allowlist for a PROJECT-declared entry', () => {
  const { dir, cleanup } = makeProject(TUNED);
  try {
    const r = runHook(`node ./${PROJECT_SCRIPT} ${DB}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a `./`-prefixed sanctioned invocation');
    assert.equal(
      r.code,
      0,
      'HEAD strips a single leading `./` before comparing against allow_scripts. This pin states that behaviour for the CONFIG half of the union, so EX-6b can attribute any difference to the SHIPPED half alone. If this is red, `./` is not normalized at all and EX-6b is moot — report it rather than editing either pin'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: remove the leading-`./` strip from the allowlist comparison — this
// pin goes red (allow 0 -> deny 2) together with EX-6b, and the PAIR going red
// together is how you tell "normalization was removed" apart from "the merge
// normalizes only one half", which is EX-6b alone.

// RE-CUT 2026-09-05 — the EX-6a premise change applies here identically (the
// `./` shape is now normalized by realpath, not by a text strip), plus the shared
// EX-1 change (the shipped entry now exists inside the active plugin root). CLAIM
// UNCHANGED, INCLUDING THE PAIRING RULE: EX-6a and EX-6b move together; if EX-6a
// is red, EX-6b is moot and the finding is reported, not "fixed".
test('EX-6b (expect RED today): a leading `./` does not defeat the allowlist for a MERGED SHIPPED entry either', () => {
  const { dir, cleanup } = makeProject(TUNED);
  try {
    const r = runHook(`node ./${SHIPPED_TUI} ${DB}`, dir);
    assert.notEqual(r.code, null, 'the gate must not crash on a `./`-prefixed shipped invocation');
    assert.equal(
      r.code,
      0,
      'PARITY: the two halves of the union must be matched by the SAME comparison. A merge that appends the shipped entries after the normalization step — or that compares them with a different, stricter test than the config entries get — produces a guard whose verdict depends on which half of its own allowlist an entry came from. That asymmetry fails closed and silently, which is the very shape of the defect being fixed. RED TODAY for the ordinary reason (replace-semantics means the shipped entry is not in the effective list at all), so it must be read TOGETHER with EX-1: if EX-1 goes green and this stays red, the parity bug is real and isolated'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: build the effective allowlist by concatenating the RAW shipped
// strings after the config entries have been normalized, and compare the
// executable argument against the raw shipped strings without stripping `./` —
// this pin goes red (allow 0 -> deny 2) while EX-1, EX-3 and EX-6a ALL stay
// green. EX-6b is the sole load-bearing pin for union normalization parity.
