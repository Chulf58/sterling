// H15 store-guard — STRUCTURED-WRITE ARM pins (Edit / Write / MultiEdit /
// NotebookEdit into `.sterling/`). Branch fix/issues-log-2026-09-05.
//
// IN ONE SENTENCE: on the AGENT TOOL CHANNEL, a structured write is judged by
// its DESTINATION and not by the caller's cwd — the SUBMITTED SPELLING is
// normalized per the applicable path grammar FIRST, and only then is a verdict
// reached: a normalized destination that carries a `.sterling` path COMPONENT
// (matched case-insensitively) or that lands inside the project's `.sterling`
// namespace — the directory itself included — is DENIED (exit 2); the
// destination is extracted per tool_name; anything that cannot be decided
// conclusively FAILS CLOSED.
//
// THIS FILE IS THE FROZEN ATTACK SET FOR A REBUILD (CLAUDE.md
// `rebuild-over-patch-third-round-rebuilds-against-frozen-pins`). The arm is on
// its third fix round; per that rule the pins below are frozen and the arm is
// rebuilt from blank against them, NOT patched with a fourth guard. Sections 15
// through 19 were added at the freeze from an outside-family review that
// executed its cases against BOTH the source hook and the shipped bundle.
// Sections 0-14 are the pre-existing pins, kept verbatim except for the two
// fixture repairs marked CONDUCTOR REPAIR / FREEZE REPAIR.
//
// ---------------------------------------------------------------------------
// THE HOLE THIS CHANNEL CLOSES (named because pin S1 reproduces it)
// ---------------------------------------------------------------------------
// H15 guarded `.sterling/` against the Bash/PowerShell channel only. Edit,
// Write, MultiEdit and NotebookEdit into the store were denied by NO hook, so
// ANY Edit-holding agent could overwrite `.sterling/review-ledger.json` — the
// ledger the merge gate reads to refuse unreviewed commits. That is a gate
// that can rewrite its own evidence, which is why S1 is the first subject pin
// and why it names the file explicitly.
//
// ---------------------------------------------------------------------------
// THE CONTRACT UNDER TEST (the entire spec this file answers to)
// ---------------------------------------------------------------------------
// (C1) EXTRACTION per tool_name: Edit/Write/MultiEdit → `tool_input.file_path`;
//      NotebookEdit → `tool_input.notebook_path`. MultiEdit's `edits[]` carries
//      MUTATIONS, never additional destination paths.
// (C2) FAIL-CLOSED on the path value: absent / empty / whitespace-only /
//      non-string (array, object, number, null, boolean) → DENY. The type check
//      happens BEFORE any path helper, because a `String(...)` coercion inside
//      `repoRel` would launder garbage into a plausible-looking path and then
//      decide containment on the laundered value.
// (C3) CONTAINMENT is decided with `path.relative`, NEVER a string prefix:
//      (a) LEXICAL, against the normalized project root; and
//      (b) CANONICAL, via the NEAREST EXISTING ANCESTOR — walk up to the first
//          ancestor that exists, realpath it, re-append the unresolved suffix,
//          and compare against realpath(`<root>/.sterling`). Resolving only the
//          IMMEDIATE parent is insufficient: Write may create several missing
//          components at once, and a symlink can sit above all of them.
// (C4) PROTECTED SURFACE is the whole `.sterling` namespace INCLUDING the
//      directory itself. There is NO sanctioned-script exemption on this arm at
//      all — not for config.json, not for transient/, not for any agent_id.
// (C5) DENY if canonicalization needed for a conclusive decision fails, or if
//      no usable ancestor can be found.
// (C6) ORDERING: the structured arm sits BEFORE the Bash `command` handling.
//      Below the Bash path, an Edit payload looks like an EMPTY COMMAND and
//      exits allowed — that regression is what S12a/S12b exist to catch. It
//      also sits BEFORE any `if (!inSterlingProject) allow();` bail, because
//      the DESTINATION decides and not the caller's project (S13c; superseded
//      the original wording of this clause, see the note above S13c).
//
// --- ADDED AT THE FREEZE (rounds 2 and 3). Source of truth for these four is
// --- decision `h15-structured-write-arm-rebuilt-from-blank-third-round-trigger`
// --- (knowledge_get 2507e2c7), whose INVARIANT paragraph the rebuild answers
// --- to. Quoted where it binds, because a ruling stripped of its reason
// --- reproduces the gap it was written to close.
//
// (C7) NORMALIZE BEFORE THE VERDICT — the round-3 trigger. "'Resolved' means
//      normalized per the applicable path grammar BEFORE any verdict — `..`
//      collapsed, separators canonical for the host, and case compared so that
//      a case-insensitive filesystem cannot alias a differing spelling past the
//      check." A check that reads the SUBMITTED SPELLING denies destinations
//      that are not in any store: `/tmp/.sterling/../ordinary.txt` resolves to
//      `/tmp/ordinary.txt`. Separators are HOST separators: on POSIX a literal
//      backslash is an ordinary filename character, NOT a component boundary.
//      Section 15 pins this; it is the only section RED TODAY BECAUSE THE
//      CURRENT FIX IS WRONG rather than missing.
// (C8) CASE: a `.sterling` component is matched CASE-INSENSITIVELY, in ANY
//      position, not only the final one — `.STERLING/transient/x.json` denies.
//      Independent of the host filesystem's own case sensitivity. Section 16.
// (C9) UNRECOGNIZED TOOL NAME fails closed: a `tool_name` the arm does not
//      recognize cannot have its destination extracted, so it DENIES and NAMES
//      the tool. Section 18.
// (CA) THE DESTINATION DECIDES, NEVER THE CWD: "a call launched anywhere may
//      not write any Sterling store" — including Sterling project A writing
//      project B's store. This rule is DELIBERATELY LEXICAL, not realpath-based
//      (rejected alternative, verbatim reason: "calling realpath globally on
//      every structured write machine-wide lets an unreadable or pathological
//      path block work in unrelated projects"). CONSEQUENCE THE REBUILD IS
//      ALLOWED TO LEAVE OPEN: a SYMLINK into another project's store is not
//      covered. Sections 17/19 pin only what lexical resolution can decide.
//
// ---------------------------------------------------------------------------
// THE HONEST LIMIT — READ THIS BEFORE CITING ANY GREEN BELOW. (Comment block,
// deliberately NOT an assertion: there is no test that could establish it, and
// a pin that implied filesystem-level enforcement would be worse than none.)
// ---------------------------------------------------------------------------
// WHAT A GREEN SUITE HERE PROVES: that for each payload shape ENUMERATED BELOW,
// the hook reached the verdict this file pins. Nothing wider. It is a claim
// about a finite list of cases, not a coverage claim about the channel.
//
// WHAT A GREEN SUITE HERE DOES *NOT* PROVE — and this list is load-bearing,
// because the earlier version of this block claimed a green proved an agent
// "cannot reach the store", which the residuals below contradict. A test file
// that overstates its own coverage is the same defect class as a tool printing
// "NOTHING IS REPAIRED" while holding a destructive path (shipped and caught in
// this repo on 2026-09-06); the pins are the honest unit, the slogan was not.
//
// (1) NOT filesystem integrity enforcement, only the AGENT/CONDUCTOR TOOL
//     CHANNEL. It is a PreToolUse decision on a hook payload and has no
//     visibility into, and no power over, a process that opens the file itself.
//     All of these write `.sterling/review-ledger.json` with this arm fully
//     green and completely unaware: an allowlisted script invoked through the
//     Bash channel (its write happens inside the child process); the Sterling
//     TUI, the MCP server, or any Sterling process of our own; an external
//     editor, another terminal, a cron job, or a git checkout; anything at all
//     on a machine where the hook is not registered.
// (2) HARD LINKS are NOT covered. A pre-existing hard link outside the store to
//     a store file is "outside" by every test realpath can perform; whether the
//     write reaches the store bytes depends on the writing tool's
//     truncate-vs-rename semantics. No pin below detects this.
// (3) TOCTOU is NOT covered. A symlink swapped into any component AFTER the
//     verdict reroutes the write — a PreToolUse hook resolves the path twice
//     and cannot be descriptor-bound. S6a/S6b pin the STATIC symlink only.
// (4) A SYMLINK INTO ANOTHER PROJECT'S STORE is NOT covered, and this is a
//     DELIBERATE design choice rather than an oversight — see contract clause
//     (CA). The rebuild is NOT answerable for it.
// (5) UNICODE CASE-FOLDING EQUIVALENCE is NOT covered — see residual R1 at the
//     foot of this file. The fold is a simple `toLowerCase`, not the
//     filesystem's folding table.
//
// So the supported claim is narrow: "for the enumerated shapes, an agent using
// Edit/Write/MultiEdit/NotebookEdit gets the pinned verdict." NEVER "the store
// file is protected." The merge gate's ledger is tamper-EVIDENT at best, and
// the tamper-evidence is not this file's subject.
//
// ---------------------------------------------------------------------------
// BEHAVIOUR vs RESIDUAL — how to read a pin, and what the rebuild owes.
// ---------------------------------------------------------------------------
// Every pin below is one of two kinds, and each new pin says which in its own
// comment:
//   BEHAVIOUR — the rebuilt arm MUST exhibit this. It is spec. A red here
//               blocks the rebuild.
//   RESIDUAL  — a known gap the rebuild is PERMITTED to leave open. It is
//               documented, never asserted as if closed, and it must NOT block
//               the rebuild. Residuals appear as comments or as loudly-skipped
//               arms, never as passing assertions.
// Pins written before the freeze (sections 0-14) are all BEHAVIOUR.
//
// ---------------------------------------------------------------------------
// WHICH ARTIFACT THESE PINS DRIVE
// ---------------------------------------------------------------------------
// Every pin EXCEPT S14b and section 19 (S19a-S19d) spawns
// scripts/hooks/h15-store-guard.mjs — the MAINTAINED SOURCE — matching the nine
// existing h15-*.test.mjs suites, which all drive the source
// (h15-precision.test.mjs:73, h15-failclosed-boundary.test.mjs:50;
// h15-active-root-provenance.test.mjs:179 drives the source or a purpose-built
// temp bundle, never the repo's shipped one).
//
// PRODUCTION RUNS THE BUNDLE: hooks.json points at hooks/h15-store-guard.mjs.
// A green pin against the source therefore proves NOTHING about what ships if
// the bundle has not been rebuilt. S14b spawns the BUNDLED artifact for the
// originally reproduced hole; S14a pins the REGISTRATION (an arm that no matcher
// routes to is dead code). ADDED AT THE FREEZE: S14b alone drove the bundle only
// for the ORIGINAL lowercase in-project case, so bundle drift in the round-2 and
// round-3 fixes was invisible to a 42/42 green — section 19 extends the currency
// arm to the case fix, the cross-project fix and the normalization fix.
// Treat S14a/S14b/S19a-d as the currency pins: if they are red while their
// source-driven twins are green, the defect is a missing rebuild/registration,
// not a missing guard.
//
// ---------------------------------------------------------------------------
// MUTATION DISCIPLINE (CLAUDE.md verify-by-mutation; decision 23afbc83)
// ---------------------------------------------------------------------------
// Every pin carries a SABOTAGE comment naming the ONE-LINE implementation
// change that must turn it RED, and names WHICH GUARD carries the verdict where
// more than one could. Where a pin survives a single-guard mutation because the
// lexical AND canonical layers both catch it, that is stated as DEFENCE IN
// DEPTH rather than claimed as load-bearing. NO MUTATION IS EXECUTED HERE — the
// author of this file holds no shell by design, and no mutation result is
// claimed anywhere in it.
//
// Written BLIND to scripts/hooks/h15-store-guard.mjs (H4 read wall); the
// contract above is the entire spec. THE FREEZE ADDITIONS (sections 15-20) WERE
// ALSO AUTHORED BLIND — their source is decision 2507e2c7's INVARIANT paragraph
// plus the outside-family review's MEASURED payloads, never a reading of the
// arm. That is deliberate: an oracle anchored to the code under test certifies
// whatever the code happens to do, which is how round 2's false denial got a
// green suite. Harness conventions (runRaw / makeProject
// / an explicit fixture config / a real store db so project-root resolution
// keys on it / STERLING_CURRENCY_DISABLE) are COPIED, not imported, from
// scripts/tests/h15-precision.test.mjs:63-102 and
// scripts/tests/h15-failclosed-boundary.test.mjs:49-93. No existing test file
// is modified or referenced at runtime; this file is standalone.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_HOOK = join(root, 'scripts', 'hooks', 'h15-store-guard.mjs');
const BUNDLED_HOOK = join(root, 'hooks', 'h15-store-guard.mjs');
const HOOKS_JSON = join(root, 'hooks', 'hooks.json');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// Flatten multi-line child stderr before interpolating it into an assertion
// message (anti-pattern ee89c3fd).
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');

// Directory symlinks are unavailable to an unprivileged user on some Windows
// hosts. S6a/S6b CANNOT be built without them, and a silently-degraded fixture
// would pass vacuously — exactly the false negative these pins exist to
// prevent — so they SKIP LOUDLY instead.
const SYMLINK_SKIP = (() => {
  const d = mkdtempSync(join(tmpdir(), 'sterling-h15sw-symprobe-'));
  try {
    mkdirSync(join(d, 'target'), { recursive: true });
    symlinkSync(join(d, 'target'), join(d, 'link'), 'dir');
    return false;
  } catch (err) {
    return `directory symlinks unavailable on this host (${err && err.code}) — the canonical-containment fixture cannot be built, and a degraded fixture would pass vacuously`;
  } finally {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})();

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
  // Declared deliberately: C4 says this arm has NO sanctioned-script exemption,
  // so a populated allowlist must change NOTHING about a structured write.
  // Without this key present, S4c would be green for the wrong reason.
  store_guard: { allow_scripts: ['scripts/init.mjs', 'scripts/review-ledger.mjs'] },
};

// A REAL tmpdir project root, NEVER the live checkout (a pin that wrote into
// the real .sterling/ would be the very defect under test).
// realpathSync on the mkdtemp result: on hosts where the tmp root is itself a
// symlink, an unresolved fixture path would make the LEXICAL and CANONICAL
// layers disagree for reasons that have nothing to do with the code, and every
// containment verdict below would be uninterpretable.
function makeProject(prefix = 'sterling-h15sw-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.mjs'), '// ordinary source file\n');
  // A REAL store db, matching every other hook suite — project-root resolution
  // keys on .sterling/sterling.db actually existing.
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { dir, cleanup };
}

function runRaw(stdin, cwd, hookPath = SOURCE_HOOK) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: stdin,
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    // H1's clone-currency probe must never fire inside a hook unit test.
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// The structured channel. `tool_input` is passed through EXACTLY as given so a
// pin can omit a key, or give it a non-string value, without the harness
// tidying it — the harness must never repair the payload it is testing.
function runTool(tool_name, tool_input, cwd, { agent_id = 'coder', hookPath = SOURCE_HOOK } = {}) {
  const payload = {
    session_id: 's1',
    transcript_path: join(cwd, 't', 's1.jsonl'),
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
  };
  if (agent_id !== null) payload.agent_id = agent_id;
  return runRaw(JSON.stringify(payload), cwd, hookPath);
}

// The pre-existing Bash channel, verbatim in shape from the nine green suites.
function runBash(command, cwd) {
  return runTool('Bash', { command }, cwd);
}

const DENY = 2;
const ALLOW = 0;

// A deny must be a DECISION (exit 2), never a crash (exit 1 / null), because
// the hook runner treats any non-2 exit as NON-BLOCKING: a crashed gate is an
// ALLOWED write (anti_pattern e13f0fb5, the F5 "gate voids itself" class).
function assertDeny(r, what) {
  assert.equal(r.code, DENY, `${what}: expected DENY (exit 2); got exit ${r.code} — anything but 2 is non-blocking, i.e. the write RAN. stderr: ${flat(r.stderr)}`);
  assert.notEqual(String(r.stderr ?? '').trim(), '', `${what}: a deny must say something — a silent exit 2 is indistinguishable from a coincidence`);
}

function assertAllow(r, what) {
  assert.equal(r.code, ALLOW, `${what}: expected ALLOW (exit 0); got exit ${r.code}. stderr: ${flat(r.stderr)}`);
}

// =============================================================================
// SECTION 0 — CONTROL ARMS, PLACED FIRST AND DELIBERATELY.
//
// Almost every subject below asserts a DENY. An arm that had degenerated into
// deny-everything — or a fixture whose project root failed to resolve, so the
// hook bailed one way for reasons unrelated to containment — would satisfy all
// of them identically and read exactly like a passing suite. These four must
// pass for the OPPOSITE reason. Until C1 and C2 are green, no deny verdict in
// this file is interpretable.
// =============================================================================

test('C1 (control): an Edit to an ordinary source file inside the project is ALLOWED — the structured arm has not degenerated into deny-everything', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertAllow(runTool('Edit', { file_path: join(dir, 'src', 'app.mjs'), old_string: 'a', new_string: 'b' }, dir), 'C1');
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the structured arm `deny()` unconditionally once tool_name is
// one of the four → C1 red. GUARD: the containment test itself. C1 is the arm
// that gives every DENY below its meaning.

test('C2 (control): the Bash channel still ALLOWS an ordinary command — adding the structured arm did not swallow the pre-existing path', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertAllow(runBash('ls /tmp', dir), 'C2');
  } finally {
    cleanup();
  }
});
// SABOTAGE: `process.exit(2)` at the top of the structured arm regardless of
// tool_name → C2 red (an Edit-shaped guard must not decide Bash payloads).

test('C3 (control): the Bash channel still DENIES `rm -rf .sterling`, and does so through the ORDINARY shell classifier', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runBash('rm -rf .sterling', dir);
    assertDeny(r, 'C3');
    assert.match(r.stderr, /shell write access to the Sterling store is denied/, 'the shell deny keeps its own pre-existing wording — if this changed, the structured arm has annexed the Bash verdict');
  } finally {
    cleanup();
  }
});
// SABOTAGE: place the structured arm BEFORE the Bash handling but let it fall
// through into a generic deny for every tool_name → C3 still exits 2 but with
// the wrong message, and this assertion goes red. GUARD: the shell classifier.

test('C4 (control): a Bash READ of a non-db store file stays ALLOWED — the shell channel policy is file-level, the structured channel is not', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), '[]');
    assertAllow(runBash('cat .sterling/transient/touches.json', dir), 'C4');
  } finally {
    cleanup();
  }
});
// SABOTAGE: route Bash payloads through the structured arm's path-containment
// test → C4 red. This control is the partner of S4b: the SAME file that Bash
// may read is a DENY on the structured channel, and C4 is what proves S4b's
// deny comes from the write-channel rule rather than from a blanket file ban.

// =============================================================================
// SECTION 1 — THE REPRODUCED HOLE.
// =============================================================================

test('S1: an Edit into `.sterling/review-ledger.json` is DENIED — this is the reproduced hole: the merge gate reads that ledger to refuse unreviewed commits, and until this arm shipped any Edit-holding agent could rewrite it', () => {
  const { dir, cleanup } = makeProject();
  try {
    const ledger = join(dir, '.sterling', 'review-ledger.json');
    writeFileSync(ledger, JSON.stringify({ receipts: [] }));
    const r = runTool('Edit', { file_path: ledger, old_string: '[]', new_string: '[{"forged":true}]' }, dir);
    assertDeny(r, 'S1');
    assert.match(r.stderr, /\.sterling|Sterling store/i, 'the denial must name the protected namespace, so a reader can tell this deny from an unrelated one');
  } finally {
    cleanup();
  }
});
// SABOTAGE: delete the structured arm entirely (or change its `deny(` to
// `allow(`) → S1 red with exit 0. GUARD: the LEXICAL containment test carries
// this verdict (the path exists, its parent is the real store directory);
// the canonical layer would catch it too, so S1 SURVIVES a single-layer
// mutation — DEFENCE IN DEPTH, not load-bearing alone. S6b is the pin that
// isolates the canonical layer.

test('S1b: a Write (not Edit) over `.sterling/review-ledger.json` is DENIED — the hole is per-tool, and Write is a whole-file clobber', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runTool('Write', { file_path: join(dir, '.sterling', 'review-ledger.json'), content: '{"receipts":[]}' }, dir);
    assertDeny(r, 'S1b');
  } finally {
    cleanup();
  }
});
// SABOTAGE: narrow the tool_name set to `['Edit']` → S1b red, S1 green. That
// asymmetry is the per-tool evidence.

// =============================================================================
// SECTION 2 — THE ALLOW SURFACE (beyond control C1).
// =============================================================================

test('S2: a Write to an ordinary project file is ALLOWED', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertAllow(runTool('Write', { file_path: join(dir, 'src', 'new-module.mjs'), content: 'export const x = 1;\n' }, dir), 'S2');
  } finally {
    cleanup();
  }
});
// SABOTAGE: invert the containment verdict (deny when OUTSIDE) → S2 red and
// S1 green — the pair distinguishes "denies the store" from "denies at all".

// =============================================================================
// SECTION 3 — THE NEAREST-EXISTING-ANCESTOR WALK (C3b).
// =============================================================================

test('S3: a Write into `.sterling/` whose intermediate directories do NOT exist yet is DENIED — a store write must not become legal merely by naming a deeper, not-yet-created path', () => {
  const { dir, cleanup } = makeProject();
  try {
    const target = join(dir, '.sterling', 'a', 'b', 'c', 'planted.json');
    assert.equal(existsSync(dirname(target)), false, 'fixture precondition: the parent chain must be ABSENT, otherwise this pin tests nothing');
    assertDeny(runTool('Write', { file_path: target, content: 'x' }, dir), 'S3');
  } finally {
    cleanup();
  }
});
// SABOTAGE: replace the ancestor WALK with `realpathSync(dirname(p))` (immediate
// parent only) → the realpath throws ENOENT on `<root>/.sterling/a/b/c`, and
// under C5 that must still DENY, so S3 stays GREEN. STATED PLAINLY: S3 does NOT
// isolate the walk. It is caught by the LEXICAL layer too (path.relative from
// the root yields `.sterling/a/b/c/planted.json`), so it survives BOTH
// single-guard mutations. It is a defence-in-depth pin and an honest
// precondition check; S6b is the ONLY pin here whose verdict the walk carries
// alone. The sabotage that DOES turn S3 red: make the lexical layer bail
// (`if (!existsSync(p)) allow()`) — which is exactly the fail-open shape C5
// forbids.

test('S4: the SAME missing-parent shape OUTSIDE the store is ALLOWED — the control that stops S3 passing for the wrong reason (i.e. "any non-existent path denies")', () => {
  const { dir, cleanup } = makeProject();
  try {
    const target = join(dir, 'src', 'a', 'b', 'c', 'planted.mjs');
    assert.equal(existsSync(dirname(target)), false, 'fixture precondition: the parent chain must be ABSENT — this pin is only a control if it mirrors S3 exactly');
    assertAllow(runTool('Write', { file_path: target, content: 'x' }, dir), 'S4');
  } finally {
    cleanup();
  }
});
// SABOTAGE: deny whenever the target path does not exist → S4 red while S3
// stays green, which is precisely the wrong-reason failure this control exists
// to expose. GUARD: the ancestor walk must resolve `<root>/src` and conclude
// OUTSIDE, not conclude "unresolvable, therefore deny".

test('S4b: an Edit into `.sterling/transient/touches.json` is DENIED although the Bash channel may READ that same file (control C4) — the structured channel is a WRITE channel, so the whole namespace is protected (C4 of the contract)', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    const f = join(dir, '.sterling', 'transient', 'touches.json');
    writeFileSync(f, '[]');
    assertDeny(runTool('Edit', { file_path: f, old_string: '[]', new_string: '[1]' }, dir), 'S4b');
  } finally {
    cleanup();
  }
});
// SABOTAGE: import the shell channel's file-level policy (db sealed, non-db
// readable) into the structured arm → S4b red. GUARD: the namespace rule; the
// arm must not consult which store FILE is targeted.

test('S4c: an Edit into `.sterling/config.json` is DENIED even though the fixture config declares sanctioned allow_scripts — there is NO script exemption on this arm', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Edit', { file_path: join(dir, '.sterling', 'config.json'), old_string: 'a', new_string: 'b' }, dir), 'S4c');
  } finally {
    cleanup();
  }
});
// SABOTAGE: reuse the Bash channel's sanctioned-script exemption on the
// structured arm (any exemption at all) → S4c red. GUARD: the arm must reach
// its deny with no exemption lookup; note the fixture CONFIG deliberately
// carries a non-empty allow_scripts so this pin is not green by vacuity.

test('S4d: an Edit into `.sterling/sterling.db` is DENIED (the sealed db, through the structured channel)', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Edit', { file_path: join(dir, '.sterling', 'sterling.db'), old_string: 'a', new_string: 'b' }, dir), 'S4d');
  } finally {
    cleanup();
  }
});
// SABOTAGE: exclude binary/db targets from the structured arm → S4d red.

test('S4e: a store Edit with NO agent_id on the payload (the conductor-shaped call) is still DENIED — no agent is exempt', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Edit', { file_path: join(dir, '.sterling', 'review-ledger.json'), old_string: 'a', new_string: 'b' }, dir, { agent_id: null }), 'S4e');
  } finally {
    cleanup();
  }
});
// SABOTAGE: gate the arm on `if (input.agent_id) { ...deny... }` → S4e red
// while S1 (agent_id 'coder') stays green. That asymmetry is the evidence that
// the verdict is path-based, not identity-based.

// =============================================================================
// SECTION 5 — TRAVERSAL.
// =============================================================================

test('S5: a `..` segment that resolves INTO the store (`<root>/src/../.sterling/x.json`) is DENIED', () => {
  const { dir, cleanup } = makeProject();
  try {
    // CONDUCTOR REPAIR 2026-09-06 (test-repair.mjs, evidence recorded): built
    // with join(), which NORMALIZES '..' as it builds — the string never
    // contained 'src', so the precondition below threw in 2.8ms and the hook
    // was never spawned (siblings take ~370ms; that gap was the tell). Failed
    // identically at HEAD. Concatenated so the traversal survives into the
    // payload the hook actually receives, which is the whole point of the pin.
    const target = `${dir}/src/../.sterling/x.json`;
    assert.match(target, /src/, 'fixture precondition: the raw string must still contain the traversal — a pre-normalized fixture tests nothing');
    assertDeny(runTool('Write', { file_path: target, content: 'x' }, dir), 'S5');
  } finally {
    cleanup();
  }
});
// SABOTAGE: compare the RAW path string against `<root>/.sterling` with
// `startsWith` instead of normalizing → S5 red (the raw string starts with
// `<root>/src/`). SURVIVES a single-layer mutation: `path.relative` normalizes
// `..` on its own, so the LEXICAL layer alone catches this, and the canonical
// layer would too — defence in depth, stated rather than claimed.

// FREEZE REPAIR 2026-09-06 (F2 — the vacuous control, and the reason the whole
// round-3 defect escaped). This pin's ENTIRE JOB is proving a `..` traversal
// OUT of the store is allowed. It built its payload with join(), which
// COLLAPSES `/.sterling/../` before the hook is ever spawned — measured:
//   join('/tmp/project', '.sterling', '..', 'src', 'x.mjs')
//     -> '/tmp/project/src/x.mjs'
// so the hook received an ordinary source path and the pin asserted nothing.
// The IDENTICAL defect was found and repaired in S5 earlier the same day by
// conductor test-repair, and its MIRROR here was missed. A vacuous control is
// worse than a missing one: it reads as coverage. Rebuilt with template-literal
// construction so the traversal survives into the payload, plus a fixture
// precondition so it can never silently go vacuous again.
//
// KIND: BEHAVIOUR. PREDICTION: RED TODAY, AND RED BECAUSE THE CURRENT FIX IS
// WRONG (not because a fix is missing) — this is the in-project instance of the
// F1 false denial. Green after the rebuild.
test('S5b: a `..` traversal that resolves OUT of the store (`<root>/.sterling/../src/x.mjs`) is ALLOWED — the control proving S5 is decided by RESOLUTION and not by the presence of `.sterling` in the string', () => {
  const { dir, cleanup } = makeProject();
  try {
    const target = `${dir}/.sterling/../src/x.mjs`;
    assert.match(target, /\.sterling\/\.\./, 'fixture precondition: the RAW string handed to the hook must still contain the `.sterling/..` traversal — if a path helper normalized it away, this control is vacuous and proves nothing (this is exactly the F2 defect)');
    assertAllow(runTool('Write', { file_path: target, content: 'x' }, dir), 'S5b');
  } finally {
    cleanup();
  }
});
// SABOTAGE: deny on any path whose text contains `.sterling` (the old
// deny-any-mention shape that decision 0b4d3c8c retired for the shell channel)
// → S5b red. Without S5b, a substring implementation passes S1/S3/S5/S6 and
// looks fully correct. WHICH GUARD CARRIES THE VERDICT: normalize-before-verdict
// (C7), alone — no other layer can distinguish this from S5. It does NOT survive
// a single-guard mutation, which is the whole reason the vacuous version was
// invisible: it had no second layer to hide behind, it simply never ran.

// =============================================================================
// SECTION 6 — CANONICAL CONTAINMENT (the layer no other pin isolates).
// =============================================================================

test('S6a: a SYMLINK sitting outside the store but pointing INTO it is DENIED — containment is canonical, not lexical', { skip: SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeProject();
  try {
    symlinkSync(join(dir, '.sterling'), join(dir, 'sneak'), 'dir');
    const target = join(dir, 'sneak', 'review-ledger.json');
    assertDeny(runTool('Write', { file_path: target, content: '{"receipts":[]}' }, dir), 'S6a');
  } finally {
    cleanup();
  }
});
// SABOTAGE: delete the canonical (realpath) layer and keep only the lexical
// `path.relative(root, p)` test → S6a red with exit 0: `<root>/sneak/...` is
// lexically outside `.sterling`. GUARD: the CANONICAL layer alone carries this
// verdict — this is the pin that is NOT defence in depth.

test('S6b: a symlink into the store with SEVERAL missing components beneath it is DENIED — the nearest-existing-ancestor walk, isolated', { skip: SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeProject();
  try {
    symlinkSync(join(dir, '.sterling'), join(dir, 'sneak'), 'dir');
    const target = join(dir, 'sneak', 'a', 'b', 'c', 'planted.json');
    assert.equal(existsSync(join(dir, 'sneak', 'a')), false, 'fixture precondition: everything below the symlink must be ABSENT — that is the whole point of this pin');
    assertDeny(runTool('Write', { file_path: target, content: 'x' }, dir), 'S6b');
  } finally {
    cleanup();
  }
});
// SABOTAGE (two, and BOTH must be checked because they fail differently):
//   (1) drop the canonical layer → S6b red with exit 0 (lexically outside);
//   (2) replace the walk with `realpathSync(dirname(p))` — immediate parent
//       only → the realpath throws ENOENT on `<root>/sneak/a/b/c`; if the
//       implementation then falls back to ALLOW, S6b goes red, and if it fails
//       closed it stays green for a DIFFERENT reason (C5, not containment).
// GUARD: S6b is the ONLY pin whose green requires the ancestor WALK to have
// produced a conclusive INSIDE verdict; read it together with S4 (which proves
// a missing chain outside the store still resolves to ALLOW rather than being
// swept up by a blanket unresolvable-deny). S4 + S6b together are what make the
// walk load-bearing; either one alone is satisfiable by a fail-closed stub.

// =============================================================================
// SECTION 7 — THE PREFIX CONTROL. Without this pin a `startsWith` bug passes
// every other pin in the file.
// =============================================================================

test('S7: a sibling directory whose name merely STARTS WITH `.sterling` (`.sterlingish/notes.json`) is ALLOWED — containment is `path.relative`, never a string prefix', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterlingish'), { recursive: true });
    assertAllow(runTool('Write', { file_path: join(dir, '.sterlingish', 'notes.json'), content: 'x' }, dir), 'S7');
  } finally {
    cleanup();
  }
});
// SABOTAGE: `p.startsWith(join(root, '.sterling'))` instead of a
// `path.relative` containment test → S7 red. GUARD: the relative-path
// containment test; nothing else in the file distinguishes the two
// implementations.

test('S7b: a sibling FILE whose name starts with the protected name (`.sterling.bak`) is ALLOWED — same prefix trap, file-shaped', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertAllow(runTool('Write', { file_path: join(dir, '.sterling.bak'), content: 'x' }, dir), 'S7b');
  } finally {
    cleanup();
  }
});
// SABOTAGE: the same `startsWith` bug → S7b red. Pinned separately from S7
// because a naive fix (`startsWith(storeDir + path.sep)`) repairs S7b's shape
// while a directory named `.sterlingish` still needs the relative test.

// =============================================================================
// SECTION 8 — THE DIRECTORY ITSELF.
// =============================================================================

test('S8: the `.sterling` DIRECTORY ITSELF as the destination is DENIED — the protected surface includes the directory, not only what is under it', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Write', { file_path: join(dir, '.sterling'), content: 'x' }, dir), 'S8');
  } finally {
    cleanup();
  }
});
// SABOTAGE: require the relative path to be non-empty before denying (e.g.
// `if (rel && !rel.startsWith('..')) deny()`) → S8 red, because
// `path.relative(store, store)` is the EMPTY STRING and a truthiness check
// reads it as outside. GUARD: the containment test's treatment of rel === ''.
// This is the single most likely off-by-one in the whole arm.

test('S8b: the `.sterling` directory named with a trailing separator is DENIED — the same target, spelled differently', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Write', { file_path: join(dir, '.sterling') + '/', content: 'x' }, dir), 'S8b');
  } finally {
    cleanup();
  }
});
// SABOTAGE: decide containment on the raw string before normalization → S8b
// red while S8 stays green. Defence in depth with S8 only if the
// implementation normalizes first; if it does not, this pin fails alone, which
// is the finding.

// =============================================================================
// SECTION 9 — NotebookEdit (previously in NO matcher at all).
// =============================================================================

test('S9a: a NotebookEdit whose `notebook_path` is inside the store is DENIED — extraction is per tool_name (C1)', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('NotebookEdit', { notebook_path: join(dir, '.sterling', 'notes.ipynb'), new_source: 'x', cell_type: 'code', edit_mode: 'insert' }, dir), 'S9a');
  } finally {
    cleanup();
  }
});
// SABOTAGE: read `tool_input.file_path` for every tool → S9a red (notebook_path
// is never consulted, the absent file_path either allows or denies for the
// WRONG reason — check the stderr, not just the code, if this one moves).

test('S9b: a NotebookEdit whose `notebook_path` is outside the store is ALLOWED', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertAllow(runTool('NotebookEdit', { notebook_path: join(dir, 'src', 'analysis.ipynb'), new_source: 'x', cell_type: 'code', edit_mode: 'insert' }, dir), 'S9b');
  } finally {
    cleanup();
  }
});
// SABOTAGE: deny whenever tool_name === 'NotebookEdit' → S9b red while S9a
// stays green. S9b is what makes S9a's green mean "containment decided it".

test('S9c: a NotebookEdit carrying only `file_path` (and NO notebook_path) is DENIED — the declared key for this tool is absent, and an absent path fails closed (C1 + C2)', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('NotebookEdit', { file_path: join(dir, 'src', 'analysis.ipynb'), new_source: 'x' }, dir), 'S9c');
  } finally {
    cleanup();
  }
});
// SABOTAGE: fall back to `file_path` when `notebook_path` is missing → S9c red
// with exit 0. Pinned because that fallback looks like helpful leniency and is
// exactly how a store-targeting payload with the wrong key would get through:
// the mirror case (notebook_path pointing INTO the store on an Edit payload) is
// S11g.

// =============================================================================
// SECTION 10 — MultiEdit.
// =============================================================================

test('S10: a MultiEdit whose `file_path` is in the store is DENIED', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runTool('MultiEdit', {
      file_path: join(dir, '.sterling', 'review-ledger.json'),
      edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }],
    }, dir);
    assertDeny(r, 'S10');
  } finally {
    cleanup();
  }
});
// SABOTAGE: omit 'MultiEdit' from the tool_name set → S10 red.

test('S10b: a MultiEdit OUTSIDE the store whose `edits[]` strings merely CONTAIN store paths is ALLOWED — `edits[]` carries mutations, not destinations (C1)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runTool('MultiEdit', {
      file_path: join(dir, 'src', 'app.mjs'),
      edits: [
        { old_string: 'const p = "a"', new_string: `const p = ${JSON.stringify(join(dir, '.sterling', 'review-ledger.json'))}` },
        { old_string: 'x', new_string: '.sterling/config.json' },
      ],
    }, dir);
    assertAllow(r, 'S10b');
  } finally {
    cleanup();
  }
});
// SABOTAGE: scan `edits[]` for paths and treat them as destinations → S10b red.
// This is an OVER-DENY pin: source code that legitimately references a store
// path (every hook and every store test does) must remain editable, or the arm
// bricks routine work and gets disabled.

// =============================================================================
// SECTION 11 — FAIL-CLOSED FAMILY (C2). Absent, blank and non-string paths.
// Each must DENY; at least one must SAY WHAT IT RECEIVED, so a silent deny
// cannot be mistaken for a correct one.
// =============================================================================

test('S11a: an Edit payload with NO `file_path` at all is DENIED (fail-closed)', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Edit', { old_string: 'a', new_string: 'b' }, dir), 'S11a');
  } finally {
    cleanup();
  }
});
// SABOTAGE: `if (!p) allow()` on a missing path → S11a red. GUARD: the
// fail-closed branch; nothing else in the arm can decide an absent path.

test('S11b: an Edit whose `file_path` is an ARRAY is DENIED, and the denial NAMES WHAT IT RECEIVED — the type check must precede any path helper, because `String([...])` launders an array into a plausible path', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runTool('Edit', { file_path: [join(dir, 'src', 'app.mjs')], old_string: 'a', new_string: 'b' }, dir);
    assertDeny(r, 'S11b');
    assert.match(r.stderr, /file_path|notebook_path|path/i, 'the denial must name the FIELD it could not use');
    assert.match(r.stderr, /array|object|non-?string|not a string|invalid|unusable|type/i, `the denial must name the SHAPE received, so an operator can tell a fail-closed refusal from a containment refusal. stderr: ${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});
// SABOTAGE (1): move the type check AFTER `repoRel(...)` → the single-element
// array coerces via String() to a real-looking path OUTSIDE the store and S11b
// goes red with exit 0. SABOTAGE (2): replace the message with a bare
// "denied" → the two stderr assertions go red while the exit code stays 2,
// which is the whole point of asserting on substance here.

test('S11c: an Edit whose `file_path` is a NUMBER is DENIED', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Edit', { file_path: 42, old_string: 'a', new_string: 'b' }, dir), 'S11c');
  } finally {
    cleanup();
  }
});
// SABOTAGE: `typeof p !== 'string' ? allow() : ...` → S11c red.

test('S11d: an Edit whose `file_path` is NULL is DENIED', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Edit', { file_path: null, old_string: 'a', new_string: 'b' }, dir), 'S11d');
  } finally {
    cleanup();
  }
});
// SABOTAGE: `p == null` treated as "key not present, not our business" and
// allowed → S11d red. Pinned separately from S11a because `null` and absent
// take different branches in most implementations.

test('S11e: an Edit whose `file_path` is an OBJECT is DENIED — `String({})` yields "[object Object]", a relative path that lands OUTSIDE the store and would be silently allowed', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Edit', { file_path: { path: join(dir, '.sterling', 'x.json') }, old_string: 'a', new_string: 'b' }, dir), 'S11e');
  } finally {
    cleanup();
  }
});
// SABOTAGE: coerce before type-checking → "[object Object]" resolves under the
// project root but outside `.sterling`, so S11e goes red with exit 0. This is
// the laundering case the contract's ordering requirement exists for.

test('S11f: an EMPTY-STRING `file_path` is DENIED — an empty relative path resolves to the project ROOT, which a truthiness-free containment test would read as a legal target', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Write', { file_path: '', content: 'x' }, dir), 'S11f');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the empty-string check → S11f red (resolve(root, '') === root,
// which is outside `.sterling`, so it allows).

test('S11f2: a WHITESPACE-ONLY `file_path` is DENIED — trimming is not enough on its own, the trimmed-empty case must reach the same branch as S11f', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Write', { file_path: '   \t\n ', content: 'x' }, dir), 'S11f2');
  } finally {
    cleanup();
  }
});
// SABOTAGE: check `p === ''` only, without trimming → S11f2 red while S11f
// stays green. That asymmetry is why both are pinned.

test('S11g: an Edit carrying ONLY `notebook_path` (pointing into the store) and no `file_path` is DENIED — the wrong-key mirror of S9c: the declared key is absent, so it fails closed rather than being read from another key', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Edit', { notebook_path: join(dir, '.sterling', 'review-ledger.json'), old_string: 'a', new_string: 'b' }, dir), 'S11g');
  } finally {
    cleanup();
  }
});
// SABOTAGE: `const p = ti.file_path ?? ti.notebook_path` for every tool → S11g
// stays GREEN for the wrong reason (it would deny by CONTAINMENT, not by
// fail-closed). Read S11g together with S9c, which is the arm that goes RED
// under that same mutation: neither pin is conclusive alone, the PAIR is.

// =============================================================================
// SECTION 12 — THE ORDERING PIN. The regression most likely to be introduced
// later, and the one no other pin in this file would catch.
// =============================================================================

test('S12a: a store-targeting Edit whose `tool_input` also carries an EMPTY `command` is DENIED — the exact payload that would fall through to the Bash path`s empty-command early-allow if the structured arm were moved below it (C6)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runTool('Edit', { file_path: join(dir, '.sterling', 'review-ledger.json'), command: '', old_string: 'a', new_string: 'b' }, dir);
    assertDeny(r, 'S12a');
  } finally {
    cleanup();
  }
});
// GUARD CARRYING THE VERDICT: the arm's POSITION in the file — after the
// `if (!inSterlingProject) allow();` check and before the Bash `command`
// handling — not any predicate inside it. SABOTAGE: move the whole structured
// arm below the Bash `command === ''` early-allow (a pure code MOVE, no logic
// change) → S12a red with exit 0, while S1 also goes red for the same reason.
// S12a is the pin that DOCUMENTS why: it puts the empty command in the payload
// explicitly, so the failure message points at the ordering rather than at the
// containment test.

test('S12b: a store-targeting Edit whose payload also carries a BENIGN Bash command (`ls /tmp`) is DENIED — the verdict comes from tool_name-based extraction, never from classifying the command text', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runTool('Edit', { file_path: join(dir, '.sterling', 'review-ledger.json'), command: 'ls /tmp', old_string: 'a', new_string: 'b' }, dir);
    assertDeny(r, 'S12b');
  } finally {
    cleanup();
  }
});
// Control C2 proves `ls /tmp` is ALLOWED on the Bash channel, so a green here
// cannot be explained by the shell classifier — that is the pair that makes
// S12b interpretable. SABOTAGE: dispatch on the presence of `tool_input.command`
// instead of on `tool_name` → S12b red with exit 0.

test('S12c: a payload that mixes an out-of-store Edit target with a store-writing `command` string still reaches a DECISION (exit 0 or 2) and never crashes the gate into a non-blocking exit', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runTool('Edit', { file_path: join(dir, 'src', 'app.mjs'), command: 'rm -rf .sterling', old_string: 'a', new_string: 'b' }, dir);
    assert.ok(r.code === ALLOW || r.code === DENY, `expected a decision (0 or 2); got exit ${r.code}. stderr: ${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});
// DELIBERATELY WEAK, AND SAID SO: the contract does not settle whether an Edit
// payload continues into the Bash classifier after the structured arm allows
// it, so pinning either verdict here would be inventing spec. What IS pinned is
// the only part the contract does settle — the gate must reach a DECISION, and
// exit 1 / null is a VOIDED gate (anti_pattern e13f0fb5). SABOTAGE: let an
// undefined `command` reach a `.match()` in the Bash path → exit 1, S12c red.

// =============================================================================
// SECTION 13 — NO REGRESSION ON THE BASH CHANNEL (beyond controls C2/C3).
// =============================================================================

test('S13: `sqlite3 .sterling/sterling.db "UPDATE ..."` is still DENIED on the Bash channel after the structured arm landed', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runBash('sqlite3 .sterling/sterling.db "UPDATE records SET version=1"', dir), 'S13');
  } finally {
    cleanup();
  }
});
// SABOTAGE: `return allow()` immediately after the structured arm for any
// tool_name → S13 red (the Bash channel never gets evaluated).

test('S13b: a read-only `git log` naming a store path is still ALLOWED on the Bash channel (the precision behaviour decision 0b4d3c8c bought must survive)', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertAllow(runBash('git log --oneline -- .sterling/config.json', dir), 'S13b');
  } finally {
    cleanup();
  }
});
// SABOTAGE: apply the structured arm's namespace rule to Bash paths too →
// S13b red, and H15 regresses to the deny-any-mention behaviour that decision
// 0b4d3c8c explicitly retired.

// CONDUCTOR REPAIR 2026-09-06 (scripts/test-repair.mjs, evidence recorded).
// This pin previously asserted ALLOW, on the premise that the structured arm
// sits AFTER the `if (!inSterlingProject) allow();` bail. That premise was the
// contract when the pin was authored and has since been SUPERSEDED by a
// measured bypass: an outside-family review EXECUTED
//   {cwd:'/tmp', file_path:'<repo>/.sterling/enforcement-baseline.json'}
// against both the source hook and the shipped bundle; BOTH exited 0. So an
// agent launched in any other project — or in another session, or in Sterling
// project A targeting project B — could write any known Sterling checkout's
// store, including the review ledger the merge gate reads. The ruling is now
// that the arm judges the DESTINATION, not the cwd. Inverted to DENY: leaving
// it as ALLOW would have pinned the bypass as intended behaviour and gone red
// against the correct implementation.
test('S13c: a `.sterling`-shaped destination is DENIED even from a NON-Sterling cwd — the destination decides, not the caller\'s project (cross-project store write, measured bypass 2026-09-06)', () => {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-h15sw-nonproj-')));
  try {
    mkdirSync(join(outer, 'src'), { recursive: true });
    assert.equal(existsSync(join(outer, '.sterling')), false, 'fixture precondition: this directory must NOT be a Sterling project');
    assertDeny(runTool('Edit', { file_path: join(outer, '.sterling', 'review-ledger.json'), old_string: 'a', new_string: 'b' }, outer), 'S13c');
  } finally {
    rmSync(outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: restore the destination check to run only INSIDE the
// `inSterlingProject` branch → S13c red. WHICH GUARD CARRIES THE VERDICT: the
// pre-bail destination-component check, and it alone — the arm's own
// containment tests are never reached here, because the fixture is not a
// Sterling project at all. So unlike S1/S5 this pin does NOT survive a
// single-guard mutation; it is load-bearing by itself.
// NOTE the fixture contains no `.sterling` directory, so a green here cannot be
// "the store happened to be empty" — the project-root resolution keys on the
// store db existing, which is exactly why the old ALLOW premise looked sound.

// =============================================================================
// SECTION 14 — CURRENCY: what SHIPS, not what is maintained.
// A green S1 against the source says nothing about production if the bundle is
// stale or no matcher routes the four tools to H15. These two pins are the only
// ones in the file that speak about the shipped surface.
// =============================================================================

test('S14a: hooks.json routes Edit, Write, MultiEdit and NotebookEdit to h15-store-guard — an unregistered arm is dead code however correct it is', () => {
  const raw = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  // Structure-agnostic walk: collect every object that carries a `matcher` and,
  // anywhere beneath it, a command string naming h15-store-guard. Written this
  // way so the pin survives a re-shaping of hooks.json and fails only on the
  // fact it asserts.
  const matchers = [];
  const namesH15 = (node) => JSON.stringify(node ?? null).includes('h15-store-guard');
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.matcher === 'string' && namesH15(node)) matchers.push(node.matcher);
    Object.values(node).forEach(walk);
  };
  walk(raw);
  assert.ok(matchers.length > 0, 'no hooks.json entry with a matcher references h15-store-guard at all');
  // A matcher is either an alternation list or a regex; an unparseable matcher
  // counts as NOT covering (never as an error), so this pin fails on the fact
  // it asserts rather than on a RegExp throw.
  const covers = (m, tool) => {
    if (m.split('|').map((s) => s.trim()).includes(tool)) return true;
    try {
      return new RegExp(`^(?:${m})$`).test(tool);
    } catch {
      return false;
    }
  };
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) {
    assert.ok(
      matchers.some((m) => covers(m, tool)),
      `no h15 matcher covers ${tool}; matchers seen: ${JSON.stringify(matchers)}`
    );
  }
});
// SABOTAGE: delete `NotebookEdit` from the new hooks.json matcher → S14a red
// while every behavioural pin above stays green. That gap — correct code, no
// registration — is precisely the state NotebookEdit was in before this arm,
// and no payload-driven pin can see it. `Bash` is asserted in the same loop as
// a regression control: the new entry must not have replaced the old one.

test('S14b (currency): the BUNDLED artifact production actually runs denies the reproduced hole — a pin against the source proves nothing about what ships', () => {
  assert.ok(existsSync(BUNDLED_HOOK), `${BUNDLED_HOOK} does not exist — production has no H15 at all`);
  const { dir, cleanup } = makeProject('sterling-h15sw-bundled-');
  try {
    const r = runTool('Edit', { file_path: join(dir, '.sterling', 'review-ledger.json'), old_string: 'a', new_string: 'b' }, dir, { hookPath: BUNDLED_HOOK });
    assertDeny(r, 'S14b (bundled artifact)');
  } finally {
    cleanup();
  }
});
// SABOTAGE: land the arm in scripts/hooks/ and skip the esbuild bundle step →
// S14b red while S1 is green. READ THE PAIR: S1 red means the guard is wrong;
// S1 green + S14b red means the guard is right and UNSHIPPED. Only S14b (with
// S14a) can tell those apart, which is why the currency pins are separate
// tests and not an extra assertion inside S1.

// #############################################################################
// ###  PINS ADDED AT THE REBUILD FREEZE (2026-09-06). Sections 15-20.       ###
// ###  Everything above this line is the pre-existing attack set, kept.     ###
// #############################################################################

// A directory that is deliberately NOT a Sterling project. The F1 false-denial
// cases and the cross-project cases both need one, and both are meaningless if
// the fixture accidentally contains a store — so the absence is ASSERTED, not
// assumed.
function makeNonProject(prefix = 'sterling-h15sw-outer-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(dir, 'src'), { recursive: true });
  assert.equal(existsSync(join(dir, '.sterling')), false, 'fixture precondition: this directory must NOT be a Sterling project, or every verdict below is uninterpretable');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) };
}

// =============================================================================
// SECTION 15 — NORMALIZE BEFORE THE VERDICT (contract C7).
//
// THE ROUND-3 TRIGGER, AND THE ONLY SECTION IN THIS FILE THAT IS RED TODAY
// BECAUSE THE SHIPPED FIX IS *WRONG* RATHER THAN MISSING. The round-2
// cross-project check inspects the SUBMITTED SPELLING before resolving `..`, so
// it denies destinations that are not in any store at all — a MACHINE-WIDE
// FALSE DENIAL, reproduced by an outside-family review against both the source
// hook and the shipped bundle.
//
// THE ALLOW ARMS COME FIRST AND ARE THE CONTROLS FOR SECTION 17. Section 17
// asserts that a `.sterling` destination denies from any cwd; an implementation
// that simply denied every path with `.sterling` ANYWHERE IN THE STRING would
// satisfy all of section 17 identically. These three arms are what make that
// implementation fail, so section 17's greens carry their evidence.
// =============================================================================

// KIND: BEHAVIOUR. PREDICTION: RED TODAY — WRONG FIX, not missing fix.
test('S15a (control): from a NON-Sterling cwd, a destination spelled `<outer>/.sterling/../ordinary.txt` is ALLOWED — it resolves to `<outer>/ordinary.txt`, which is in no store; a check that reads the submitted spelling false-denies ordinary work machine-wide', () => {
  const { dir, cleanup } = makeNonProject();
  try {
    const target = `${dir}/.sterling/../ordinary.txt`;
    assert.match(target, /\.sterling\/\.\./, 'fixture precondition: the RAW string must still carry the traversal (F2 defect class)');
    assertAllow(runTool('Write', { file_path: target, content: 'x' }, dir), 'S15a');
  } finally {
    cleanup();
  }
});
// SABOTAGE: compare the SUBMITTED spelling's components against `.sterling`
// before collapsing `..` (i.e. reinstate the round-2 shape) → S15a red with
// exit 2. WHICH GUARD CARRIES THE VERDICT: normalize-before-verdict, ALONE.
// This pin does NOT survive a single-guard mutation and is not defence in
// depth — no other layer in the arm can reach a different answer here.
// NOTE it is the DENY that is the bug: a red here is a FALSE DENIAL, i.e. the
// gate blocking ordinary work in unrelated projects, which is why the rejected
// alternative "leave the shipped false denial in place" was accepted only as a
// short-lived state and not as a resting one.

// KIND: BEHAVIOUR. PREDICTION: RED TODAY — WRONG FIX, not missing fix.
test('S15b (control): on POSIX, a legal filename containing literal BACKSLASHES (`notes\\.sterling\\x.txt`) is ALLOWED — a backslash is an ordinary filename character here, not a component boundary, and separators must be canonical FOR THE HOST', {
  skip: process.platform === 'win32' ? 'POSIX-only: on Windows a backslash IS a separator, so this exact spelling is a genuine store path — the win32 counterpart is S15b-win' : false,
}, () => {
  const { dir, cleanup } = makeProject();
  try {
    const target = `${dir}/notes\\.sterling\\x.txt`;
    assert.ok(target.includes('\\'), 'fixture precondition: the raw string must contain a literal backslash, or this pin tests nothing');
    assert.equal(target.split('/').pop(), 'notes\\.sterling\\x.txt', 'fixture precondition: on POSIX grammar this is ONE final component, not three');
    assertAllow(runTool('Write', { file_path: target, content: 'x' }, dir), 'S15b');
  } finally {
    cleanup();
  }
});
// SABOTAGE: split path components on `[\\/]` regardless of host (the round-2
// helper's shape) → S15b red with exit 2, because the middle "component" reads
// as `.sterling`. WHICH GUARD: host-appropriate separator grammar, alone.

// KIND: BEHAVIOUR. PREDICTION: SKIPPED on this machine (linux/WSL), so it
// contributes no signal here — it exists so a Windows run pins the mirror, per
// the standing Windows/Linux 1:1 parity requirement. NOT a residual: on win32
// it is spec.
test('S15b-win: on Windows, the SAME spelling `notes\\.sterling\\x.txt` IS a store-shaped path and is DENIED — the separator grammar is the host\'s, so the identical string gets opposite (and correct) verdicts on the two platforms', {
  skip: process.platform === 'win32' ? false : 'win32-only mirror of S15b; on POSIX a backslash is a filename character and the correct verdict is ALLOW (see S15b)',
}, () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Write', { file_path: `${dir}\\notes\\.sterling\\x.txt`, content: 'x' }, dir), 'S15b-win');
  } finally {
    cleanup();
  }
});
// SABOTAGE: treat `/` as the only separator on win32 → S15b-win red with exit 0
// (a real store write allowed). Read S15b and S15b-win as ONE pin with two host
// arms: exactly one of them runs on any given machine, and an implementation
// that hardcodes either grammar fails on the other platform.

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY (the round-2 spelling check already
// denies it, for the wrong reason but with the right verdict) and GREEN after
// the rebuild. Its VALUE is as the opposite-direction partner of S15a.
test('S15c: from a NON-Sterling cwd, a traversal that resolves INTO a store (`<outer>/src/../.sterling/review-ledger.json`) is DENIED — normalization must not become a way to LAUNDER a store path past the check', () => {
  const { dir, cleanup } = makeNonProject();
  try {
    const target = `${dir}/src/../.sterling/review-ledger.json`;
    assert.match(target, /src\/\.\./, 'fixture precondition: the raw string must still carry the traversal');
    assertDeny(runTool('Write', { file_path: target, content: '{"receipts":[]}' }, dir), 'S15c');
  } finally {
    cleanup();
  }
});
// SABOTAGE: collapse `..` and then FORGET to re-run the component check on the
// collapsed result (i.e. check the raw spelling only) → S15c red with exit 0.
// READ S15a AND S15c AS A PAIR AND NEITHER ALONE: S15a alone is satisfied by
// deleting the check entirely; S15c alone is satisfied by the buggy round-2
// check. Only the two together specify "normalize, THEN decide". This pairing
// is the core of the rebuild's spec.

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY, GREEN after the rebuild.
test('S15d: a store destination spelled with `.` segments and doubled separators (`<root>/./.sterling//x.json`) is DENIED — `..` is not the only spelling normalization must collapse', () => {
  const { dir, cleanup } = makeProject();
  try {
    const target = `${dir}/./.sterling//x.json`;
    assert.match(target, /\/\.\/|\/\//, 'fixture precondition: the raw string must still carry the dot-segment / doubled separator');
    assertDeny(runTool('Write', { file_path: target, content: 'x' }, dir), 'S15d');
  } finally {
    cleanup();
  }
});
// SABOTAGE: compare components with a plain `split('/')` and no empty/`.`
// filtering, then require an EXACT full-path match against `<root>/.sterling`
// → S15d red. DEFENCE IN DEPTH, STATED: the in-project canonical layer also
// catches this one, so S15d survives a single-guard mutation. It is here to
// specify the normalization's SCOPE, not to isolate a layer.

// =============================================================================
// SECTION 16 — CASE FOLDING (contract C8). Round-2 fix, previously UNPINNED:
// 42/42 green would not have noticed its removal.
//
// The measured bypass: `.STERLING/config.json` reached the store at exit 0 on
// both source and bundle. /mnt/c is case-INSENSITIVE (research_finding
// `mnt-c-case-insensitive-defeats-case-sensitive-path-containment`), so a
// case-sensitive containment test is not merely untidy there — it is bypassable.
// CONTROLS FIRST: the fix must not degenerate into "deny anything containing
// the word sterling in any case".
// =============================================================================

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY, GREEN after the rebuild.
test('S16a (control): an ordinary file whose NAME merely contains the word in caps (`src/STERLING-notes.md`) is ALLOWED — the rule matches a `.sterling` path COMPONENT, not the word anywhere in the string', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertAllow(runTool('Write', { file_path: join(dir, 'src', 'STERLING-notes.md'), content: 'x' }, dir), 'S16a');
  } finally {
    cleanup();
  }
});
// SABOTAGE: implement the case fix as `p.toLowerCase().includes('sterling')`
// → S16a red. Without this control, that substring implementation passes every
// deny pin in section 16 and reads as a correct fix.

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY, GREEN after the rebuild.
test('S16b (control): a mixed-case sibling whose component merely STARTS WITH the protected name (`.STERLINGISH/notes.json`) is ALLOWED — the case-insensitive fix must not reintroduce the prefix trap S7 closed', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.STERLINGISH'), { recursive: true });
    assertAllow(runTool('Write', { file_path: join(dir, '.STERLINGISH', 'notes.json'), content: 'x' }, dir), 'S16b');
  } finally {
    cleanup();
  }
});
// SABOTAGE: fold case and then compare with `startsWith('.sterling')` instead
// of equality → S16b red. This is the CASE-FOLDED mirror of S7: a fix written
// in a hurry tends to reimplement containment at the new fold site rather than
// reuse the existing component test, and the prefix bug comes back with it.

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY (round-2 fix present), and RED if
// the rebuild drops the fold — which is precisely why it is now pinned.
test('S16c: `.STERLING/config.json` is DENIED — the measured round-2 bypass, which reached the store at exit 0 on BOTH source and bundle before the fold was added', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Edit', { file_path: `${dir}/.STERLING/config.json`, old_string: 'a', new_string: 'b' }, dir), 'S16c');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the `.toLowerCase()` from the component comparison → S16c red
// with exit 0. WHICH GUARD CARRIES THE VERDICT: the case fold, alone, on a
// case-SENSITIVE filesystem (the canonical realpath layer cannot help — the
// path does not exist there). On a case-INSENSITIVE filesystem such as /mnt/c
// the canonical layer WOULD also catch it, so on such a host this pin is
// defence in depth. STATED PLAINLY BECAUSE IT MATTERS FOR MUTATION TESTING:
// this pin's guard attribution DEPENDS ON THE HOST FILESYSTEM. Under WSL /tmp
// (case-sensitive) the fold carries it alone; verify the mutation there.

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY, GREEN after the rebuild.
test('S16d: mixed case in a NON-FINAL component (`.STERLING/transient/x.json`) is DENIED — the fold applies to every component, not just the last one', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertDeny(runTool('Write', { file_path: `${dir}/.STERLING/transient/x.json`, content: 'x' }, dir), 'S16d');
  } finally {
    cleanup();
  }
});
// SABOTAGE: fold only the FINAL component (or only `basename(p)`) → S16d red
// while S16c stays green, because in S16c `.STERLING` happens to be the
// second-to-last component too but the file name is the plain `config.json`.
// Pinned separately from S16c for exactly that asymmetry: a basename-only fold
// is a plausible implementation that S16c alone does not exclude.

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY, GREEN after the rebuild.
test('S16e: mixed case COMBINED with a not-yet-existing directory chain (`.Sterling/a/b/planted.json`) is DENIED — the fold must not depend on the path existing, since realpath cannot resolve what is not there', () => {
  const { dir, cleanup } = makeProject();
  try {
    const target = `${dir}/.Sterling/a/b/planted.json`;
    assert.equal(existsSync(join(dir, '.Sterling', 'a')), false, 'fixture precondition: the chain below must be ABSENT, or the canonical layer decides this instead of the fold');
    assertDeny(runTool('Write', { file_path: target, content: 'x' }, dir), 'S16e');
  } finally {
    cleanup();
  }
});
// SABOTAGE: apply the fold only after a successful realpath (i.e. fold the
// CANONICAL path only) → S16e red, because nothing below `.Sterling` exists to
// canonicalize. GUARD: the LEXICAL fold on the normalized-but-unresolved path.
// This is the pin that stops the fold from being implemented in the one place
// where it is least useful.

// =============================================================================
// SECTION 17 — CROSS-PROJECT: PROJECT A MAY NOT WRITE PROJECT B'S STORE
// (contract CA). Round-2 fix, previously pinned only by S13c's non-project cwd.
//
// S13c covers "cwd is not a Sterling project at all". This section covers the
// harder and likelier shape: the caller IS a legitimate Sterling project, so
// every project-root resolution succeeds and an implementation that scopes the
// check to "my own project's store" looks entirely correct.
// CONTROL FIRST: crossing a project boundary is not itself the offence.
// =============================================================================

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY, GREEN after the rebuild.
test('S17a (control): from Sterling project A, writing an ORDINARY file inside Sterling project B is ALLOWED — the offence is the store destination, never the crossing of a project boundary', () => {
  const a = makeProject('sterling-h15sw-projA-');
  const b = makeProject('sterling-h15sw-projB-');
  try {
    assertAllow(runTool('Write', { file_path: join(b.dir, 'src', 'new.mjs'), content: 'x' }, a.dir), 'S17a');
  } finally {
    b.cleanup();
    a.cleanup();
  }
});
// SABOTAGE: deny whenever the destination lies outside the caller's own project
// root → S17a red. Without this control, "deny every out-of-project write"
// passes S17b, S17c and S13c and reads as a correct cross-project fix — while
// bricking every legitimate multi-repo edit on the machine.

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY, GREEN after the rebuild.
test('S17b: from Sterling project A, an Edit into project B\'s `.sterling/review-ledger.json` is DENIED — a call launched anywhere may not write ANY Sterling store, including another project\'s merge-gate evidence', () => {
  const a = makeProject('sterling-h15sw-projA-');
  const b = makeProject('sterling-h15sw-projB-');
  try {
    const ledger = join(b.dir, '.sterling', 'review-ledger.json');
    writeFileSync(ledger, JSON.stringify({ receipts: [] }));
    const r = runTool('Edit', { file_path: ledger, old_string: '[]', new_string: '[{"forged":true}]' }, a.dir);
    assertDeny(r, 'S17b');
    assert.match(r.stderr, /\.sterling|Sterling store/i, 'the denial must name the protected namespace');
  } finally {
    b.cleanup();
    a.cleanup();
  }
});
// SABOTAGE: scope the destination check to the CALLER'S OWN project root
// (`path.relative(myRoot, p)` only) → S17b red with exit 0, while S1 and every
// in-project pin stays green. WHICH GUARD CARRIES THE VERDICT: the cwd-
// independent `.sterling`-component rule, alone. Not defence in depth — the
// in-project lexical and canonical layers both resolve against project A and
// conclude "outside", which is exactly how this bypass survived round 1.

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY, GREEN after the rebuild. This is
// the intersection of C7 and CA — it must survive the round-3 normalization fix.
test('S17c: from Sterling project A, a TRAVERSAL into project B\'s store (`<B>/src/../.sterling/x.json`) is DENIED — the round-3 normalization fix must not open a laundering route through a sibling project', () => {
  const a = makeProject('sterling-h15sw-projA-');
  const b = makeProject('sterling-h15sw-projB-');
  try {
    const target = `${b.dir}/src/../.sterling/x.json`;
    assert.match(target, /src\/\.\./, 'fixture precondition: the raw string must still carry the traversal');
    assertDeny(runTool('Write', { file_path: target, content: 'x' }, a.dir), 'S17c');
  } finally {
    b.cleanup();
    a.cleanup();
  }
});
// SABOTAGE: fix the F1 false denial by SKIPPING the component check whenever
// the path contains `..` (the tempting one-line "fix" for S15a) → S17c red with
// exit 0. THIS PIN EXISTS TO FORBID THE LAZY REPAIR OF S15a. Read S15a, S15c
// and S17c as the trio that pins the round-3 fix: allow what resolves out, deny
// what resolves in, and decide it AFTER resolution rather than by the presence
// or absence of `..`.

// =============================================================================
// SECTION 18 — UNRECOGNIZED TOOL NAME FAILS CLOSED (contract C9). Round-2 fix,
// previously unpinned.
//
// Rationale: the arm extracts the destination PER tool_name. A tool_name it does
// not recognize is a payload whose destination it cannot locate, which is the
// same epistemic position as an absent path (C2) — and the fail-closed answer
// there is already DENY (S11a).
// =============================================================================

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY, GREEN after the rebuild.
test('S18a (control): the BYTE-IDENTICAL tool_input under a RECOGNIZED tool name (`Edit`) is ALLOWED — so S18b\'s deny is attributable to the TOOL NAME and to nothing else in the payload, the destination, or the fixture', () => {
  const { dir, cleanup } = makeProject();
  try {
    // Deliberately the SAME object shape S18b sends, so the two payloads differ
    // in exactly one field. A control built from a different tool_input would
    // leave "the payload shape caused it" as a live second cause.
    assertAllow(runTool('Edit', { file_path: join(dir, 'src', 'app.mjs'), old_string: 'a', new_string: 'b' }, dir), 'S18a');
  } finally {
    cleanup();
  }
});
// SABOTAGE: any change that makes the fixture deny generally → S18a red. This
// control is what stops S18b from being green for the reason "this fixture
// denies everything", which is the one-cause-too-many failure the mutation
// discipline warns about. It duplicates C1's subject on purpose: a control is
// worth more beside the pin it defends than deduplicated 900 lines away.

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY (round-2 fix present); RED if the
// rebuild forgets it. NOTE the destination here is an ORDINARY source file, so
// containment cannot explain the deny.
test('S18b: an UNRECOGNIZED `tool_name` ("FancyEdit") under a Sterling cwd is DENIED and the denial NAMES THE TOOL — an unknown structured writer is a destination the arm cannot extract, and that fails closed', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runTool('FancyEdit', { file_path: join(dir, 'src', 'app.mjs'), old_string: 'a', new_string: 'b' }, dir);
    assertDeny(r, 'S18b');
    assert.match(r.stderr, /FancyEdit/, `the denial must NAME the unrecognized tool: an operator hitting this needs to know which tool to add to the extraction table, and a generic refusal sends them to the wrong place. stderr: ${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});
// SABOTAGE (1): `if (!KNOWN_TOOLS.has(tool_name)) return allow();` — the
// natural shape, and the round-1 behaviour → S18b red with exit 0.
// SABOTAGE (2): keep the deny but emit a generic message → the stderr assertion
// goes red while the exit code stays 2, which is the point of asserting on
// substance. WHICH GUARD: the unknown-tool branch, alone; no containment test
// is reached, since the destination is ordinary source.
// HONEST SCOPE NOTE, so a reader does not overread this pin: in production only
// the tool names in hooks.json's matcher ever reach H15 (S14a pins that set), so
// this branch is DEFENCE IN DEPTH against a future platform tool being routed
// here before the extraction table learns about it. It is spec because the
// invariant says so ("an unrecognized tool name ... DENIES"), not because a
// live payload reaches it today.

// =============================================================================
// SECTION 19 — BUNDLE PARITY FOR THE ROUND-2 AND ROUND-3 FIXES (F3d).
//
// PRODUCTION RUNS THE BUNDLE. S14b drives the bundle for the ORIGINAL lowercase
// in-project hole only, so bundle drift in the CASE fix, the CROSS-PROJECT fix,
// or the round-3 NORMALIZATION fix is invisible to the whole suite. These four
// arms close that: they are the same subjects as S16c / S17b / S15a, aimed at
// the shipped artifact.
//
// READING THE SECTION: if a section-19 arm is red while its source-driven twin
// is green, the defect is a MISSING REBUILD, never a missing guard.
// =============================================================================

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY, GREEN after the rebuild.
test('S19a (control, bundled): the BUNDLED artifact ALLOWS an ordinary in-project Write — without this, every bundled deny below is satisfied by a bundle that is simply broken and denies everything', () => {
  const { dir, cleanup } = makeProject('sterling-h15sw-bundled-');
  try {
    assertAllow(runTool('Write', { file_path: join(dir, 'src', 'new-module.mjs'), content: 'x' }, dir, { hookPath: BUNDLED_HOOK }), 'S19a (bundled)');
  } finally {
    cleanup();
  }
});
// SABOTAGE: ship a bundle whose entry point throws before reaching a verdict →
// S19a red (exit 1, a VOIDED gate) while a naive "did it exit 2?" bundled pin
// would have stayed green. This is the control that makes S19b-d interpretable.

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY, GREEN after the rebuild.
test('S19b (currency): the BUNDLED artifact denies the MIXED-CASE store path (`.STERLING/config.json`) — pins the round-2 case fix in what actually ships, not only in the maintained source', () => {
  const { dir, cleanup } = makeProject('sterling-h15sw-bundled-');
  try {
    assertDeny(runTool('Edit', { file_path: `${dir}/.STERLING/config.json`, old_string: 'a', new_string: 'b' }, dir, { hookPath: BUNDLED_HOOK }), 'S19b (bundled)');
  } finally {
    cleanup();
  }
});
// SABOTAGE: apply the case fold in scripts/hooks/ and do not re-run esbuild →
// S16c green, S19b red. That pair is the entire diagnostic.

// KIND: BEHAVIOUR. PREDICTION: GREEN TODAY, GREEN after the rebuild.
test('S19c (currency): the BUNDLED artifact denies a CROSS-PROJECT store write (project A cwd, project B ledger) — pins the round-2 cross-project fix in what ships', () => {
  const a = makeProject('sterling-h15sw-bundled-projA-');
  const b = makeProject('sterling-h15sw-bundled-projB-');
  try {
    assertDeny(runTool('Edit', { file_path: join(b.dir, '.sterling', 'review-ledger.json'), old_string: 'a', new_string: 'b' }, a.dir, { hookPath: BUNDLED_HOOK }), 'S19c (bundled)');
  } finally {
    b.cleanup();
    a.cleanup();
  }
});
// SABOTAGE: rebuild the bundle from a source predating the cross-project fix →
// S17b green, S19c red. NOTE this is the bypass that was EXECUTED against the
// shipped bundle on 2026-09-06 and exited 0; the pin exists because the bundle
// was measured, and the source alone would not have shown it.

// KIND: BEHAVIOUR. PREDICTION: RED TODAY — WRONG FIX, not missing fix (the
// bundled twin of S15a; the outside review measured the false denial against
// BOTH artifacts). Green after the rebuild is bundled.
test('S19d (currency): the BUNDLED artifact ALLOWS `<outer>/.sterling/../ordinary.txt` from a non-Sterling cwd — the round-3 false denial is a SHIPPED defect, so its repair must be pinned in the shipped artifact', () => {
  const { dir, cleanup } = makeNonProject('sterling-h15sw-bundled-outer-');
  try {
    const target = `${dir}/.sterling/../ordinary.txt`;
    assert.match(target, /\.sterling\/\.\./, 'fixture precondition: the RAW string must still carry the traversal');
    assertAllow(runTool('Write', { file_path: target, content: 'x' }, dir, { hookPath: BUNDLED_HOOK }), 'S19d (bundled)');
  } finally {
    cleanup();
  }
});
// SABOTAGE: fix normalization in scripts/hooks/ and do not re-bundle → S15a
// green, S19d red. WHICH GUARD: normalize-before-verdict, in the shipped
// artifact. Not defence in depth.

// =============================================================================
// SECTION 20 — DOCUMENTED RESIDUALS. NOT SPEC. THE REBUILD IS NOT ANSWERABLE
// FOR ANYTHING IN THIS SECTION AND MUST NOT BE BLOCKED BY IT.
//
// These are recorded here, beside the pins, because the failure mode this whole
// freeze exists to correct was a preamble that CLAIMED more coverage than the
// assertions delivered. A residual stated next to the tests is honest; a
// residual left implicit becomes tomorrow's overclaim.
// =============================================================================

// R1 — UNICODE CASE-FOLDING EQUIVALENCE. KIND: RESIDUAL (permitted open).
//
// The fold in C8 is JavaScript `toLowerCase()`, which is NOT the filesystem's
// folding table. U+017F LATIN SMALL LETTER LONG S ("ſ") is the known shape:
// toLowerCase() leaves "ſ" unchanged, while Unicode full case FOLDING maps it
// to "s". So on a filesystem whose folding table aliases them, `.ſterling/`
// would name the real store directory while the arm's fold reads it as an
// unrelated component and ALLOWS.
//
// MEASURED, and this is why no pin asserts a deny: on THIS machine's /mnt/c
// mount, long-s, dotless-i, full-width-s, dotted-I and NFD spellings did NOT
// alias to the store directory — the write does not reach it. Writing
// `assertDeny(...)` here would therefore be FAKING a green (the arm does not
// deny it), and writing `assertAllow(...)` would PIN A BYPASS as intended
// behaviour. Both are worse than an honest skip, so this arm never runs.
//
// THE CONDITION UNDER WHICH IT BECOMES REACHABLE, i.e. what would promote this
// residual to spec: a filesystem (or a network/container mount) whose case
// table performs full Unicode case folding rather than simple ASCII/Latin-1
// lowercasing, such that `.ſterling` and `.sterling` open the same directory.
// The repair then is to fold with full Unicode case folding on both sides of
// the comparison. Detect it by creating `<dir>/.sterling/` and testing whether
// `existsSync('<dir>/.ſterling/')` is true; that probe is deliberately NOT run
// here, because a probe that silently flips a pin between hosts is the vacuous-
// fixture defect (F2) in another costume.
test('R1 (RESIDUAL, never runs): `.ſterling/config.json` (U+017F LONG S) is NOT covered by the simple case fold — documented gap, not a pinned behaviour', {
  skip: 'RESIDUAL, deliberately not asserted: measured NOT to alias on this machine (/mnt/c), so the arm neither denies it nor needs to. A deny assertion here would be faked and an allow assertion would pin a bypass. Promote to spec only on a host whose case table performs full Unicode case folding — see the comment block above for the probe and the repair.',
}, () => {
  throw new Error('unreachable: R1 is a documented residual and must never be un-skipped without first replacing this body with a real, host-verified assertion');
});

// R2 — HARD LINKS, TOCTOU, AND CROSS-PROJECT SYMLINKS. KIND: RESIDUAL.
// Stated in the header block (limits 2, 3 and 4) rather than as arms, because
// each would need a fixture whose verdict is a property of the filesystem or of
// a race, not of the hook. Limit 4 in particular is a DELIBERATE design choice
// (contract CA): the cross-project rule is lexical precisely so that a
// pathological path cannot wedge unrelated projects machine-wide, and the
// accepted cost is that a symlink into another project's store is not seen.
// The rebuild is NOT answerable for any of the three.
