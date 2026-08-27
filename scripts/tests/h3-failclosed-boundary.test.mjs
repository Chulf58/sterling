// H3 contract-gate — FAIL-CLOSED BOUNDARY pins (board 4a66ba58, which names H3
// the WORST INSTANCE of the roster-wide class; anti_pattern e13f0fb5 owns the
// class "gate voids itself on a non-blocking exit 1"). The identical fix landed
// for H15 in commit 5eea229 — scripts/tests/h15-failclosed-boundary.test.mjs is
// this file's shape.
//
// THE DEFECT PINNED HERE: every statement between process start and the deny
// decision must sit inside the fail-closed boundary. At HEAD 5eea229, H3 had
// ~74 lines outside it — `readStdin()` (:15), the path derivations (:16-18),
// and THE ENTIRE ENFORCEMENT-SURFACE SELF-PROTECTION BLOCK (:73-82) — while the
// try opened at :89. An uncaught throw in any of them exits 1, which the hook
// runner treats as NON-BLOCKING: the Edit/Write runs UNEXAMINED. Two
// consequences, and the second is the reason this hook went first: malformed
// stdin voided the write gate, and the block that makes `.claude/agents/**` and
// `settings*.json` un-editable was ITSELF unprotected, so the self-protection
// could be voided by exactly the throw it exists to survive.
//
// NOT EVERY BAD PARSE THROWS (independent review, MEDIUM). A valid-but-non-object
// JSON document — `null`, `"x"`, `5`, `true` — parses fine, so wrapping the parse
// CALL never guaranteed this gate holds an object. TWO DIFFERENT GUARDS answer
// that, and AC6/AC7 exist to keep the division HONEST, because the first version
// of this file attributed both cases to the wrong one and a green suite would
// have preserved the error (anti_pattern 586bccdc — a pin whose stated carrier is
// wrong):
//   • `null` is carried by the READSTDIN WRAP (AC6). readStdin dereferences the
//     parsed value itself, `projectRoot(input.cwd)` at lib/common.mjs:102, so a
//     null document throws INSIDE readStdin and never reaches the typeof guard.
//     MEASURED, not assumed: the denial reads "(Cannot read properties of null
//     (reading 'cwd'))".
//   • SCALARS are carried by the TYPEOF GUARD (AC7). `'x'.cwd` is undefined
//     rather than a throw, so a string/number/boolean survives readStdin intact
//     and only the result-validation stops it.
// Both exit 2, so the fail-open is closed either way — but they are different
// guards with different messages, and this file says which is which.
//
// WHAT IS DEMONSTRABLE AND WHAT IS NOT — read this before adding a pin:
// only ONE input-driven throw exists before the old boundary, and it is
// JSON.parse inside readStdin (AC1/AC2/AC6). The self-protection block's statements
// were each checked and none throws from hook input today: `repoRel` swallows
// its own errors and returns null (lib/common.mjs), `projectRoot` does
// String(from), and `fileURLToPath(import.meta.url)` / `matchesGlob` run against
// fixed ENFORCEMENT_SURFACE globs, not against input. So the relocation of that
// block is an INVARIANT REPAIR, not a demonstrated bypass — the same honest
// framing H15 used for its own project probe. It is therefore pinned two ways:
// AC3 behaviourally (the move must not have reordered self-protection behind the
// store probe) and AC4 structurally (position). Do NOT replace AC4 with a
// fabricated "throwing" input; there isn't one, and a pin that cannot fail is
// worse than no pin.
//
// NOT A NARROWING OF THE ALLOW SURFACE: every pin below only converts a VOIDED
// gate into a DENY. No edit that H3 allowed before this fix is denied after it —
// CONTROL-1 is the arm that says so.
//
// MUTATION DESIGN ONLY — never executed here (decision 23afbc83). Each test
// names the one-line sabotage that must flip it red, applied to a clean-room
// mutant COPY of the hook, never to the shipped file.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H3 = join(HOOKS, 'h3-contract-gate.mjs');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// Anti-pattern ee89c3fd: never interpolate raw multi-line child stderr into an
// assertion message — the multi-line `code:` diagnostic poisons the TAP
// crash/assertion classifier, and a red gate then cannot tell "the pin caught
// the sabotage" from "the harness fell over". Flatten only; never truncate.
function oneLine(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function runRaw(stdin, cwd) {
  const r = spawnSync(process.execPath, [H3], { input: stdin, encoding: 'utf8', cwd, timeout: 30_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runHook(over, cwd) {
  return runRaw(
    JSON.stringify({
      session_id: 's1',
      transcript_path: join(cwd, 'transcripts', 's1.jsonl'),
      cwd,
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      ...over,
    }),
    cwd
  );
}

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs', '**/*.ts'], test_globs: ['**/*.test.mjs', 'tests/**'], run_commands: { test: 'node --test' } }],
  context_watch: { warn_pct: 60, block_pct: 95, mode: 'observe', windows: { default: 200000 } },
};

// A Sterling project with a store, no run (direct mode) and one real source
// file, so edit-vs-creation is distinguishable.
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h3failclosed-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const x = 1;');
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

// A directory with NO .sterling store at all.
function makeBareDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h3bare-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// =========================================================================
// CONTROL ARMS — PLACED FIRST. Every SUBJECT below asserts a DENY, and a gate
// that had degenerated into deny-everything would satisfy all of them
// identically. These four must pass for the OPPOSITE reason: one ALLOW proving
// H3 still HAS an allow surface (this fix must not narrow it), and three DENYs
// proving three DIFFERENT ordinary paths — evidence, self-protection, store
// probe — still produce their own verdicts rather than routing through a
// fail-closed catch. Read together they say: the subjects' verdicts come from
// the boundary, not from breakage.
// =========================================================================

test('CONTROL-1: a conductor edit of a NOT-YET-EXISTING in-repo file is ALLOWED — the creation exemption survives, H3 has not degenerated into deny-everything', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook({ tool_input: { file_path: join(dir, 'src', 'brand-new.ts') } }, dir);
    assert.equal(r.code, 0, oneLine(r.stderr));
  } finally {
    cleanup();
  }
});
// SABOTAGE: `process.exit(2)` as the first statement inside the fail-closed try
// → CONTROL-1 red. This is the arm that would catch a fix which converted a
// voided gate into a DENY-EVERYTHING gate instead of a correct one.

test('CONTROL-2: an ordinary missing-read-evidence denial comes from the EVIDENCE path, not from any fail-closed catch', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook({ tool_input: { file_path: join(dir, 'src', 'feature.ts') } }, dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no fresh read-evidence/);
    assert.doesNotMatch(r.stderr, /ENVIRONMENT DEFECT/, 'ordinary misconduct must NOT be dressed as broken state (board c7b81456)');
  } finally {
    cleanup();
  }
});
// SABOTAGE: make hasFreshRead always return true → CONTROL-2 red.

test('CONTROL-3: a spawned agent editing the enforcement surface is denied by the SELF-PROTECTION block itself, not by a catch', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook({ tool_input: { file_path: join(dir, '.claude', 'agents', 'coder.md') }, agent_id: 'a1' }, dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /self-protection/);
    assert.doesNotMatch(r.stderr, /ENVIRONMENT DEFECT/, 'the block still reaches its own deny — it is not merely throwing into the catch');
  } finally {
    cleanup();
  }
});
// SABOTAGE: delete the `ENFORCEMENT_SURFACE.some(...)` branch → CONTROL-3 red.
// NOTE the asymmetry that makes this a control and not a duplicate of AC3: here
// a store EXISTS, so a self-protection block wrongly moved BELOW the store probe
// would still deny with this same text. Only AC3 can see that mistake.

test('CONTROL-4: the storeless denial comes from the STORE PROBE and names it — the new stdin catch is not swallowing unrelated failures', () => {
  const { dir, cleanup } = makeBareDir();
  try {
    const r = runHook({ tool_input: { file_path: join(dir, 'x.ts') } }, dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /No Sterling store/);
    assert.doesNotMatch(r.stderr, /\[stdin\]/, 'a perfectly parseable input must never be reported as an unreadable one');
  } finally {
    cleanup();
  }
});
// SABOTAGE: move the readStdin catch's deny() to cover the whole file (one
// try wrapping everything, single message) → CONTROL-4 red, because the store
// probe's specific wording disappears. This arm is what keeps the fix from
// collapsing four distinct verdicts into one unreadable denial.

// =========================================================================
// SUBJECTS — the input boundary.
// =========================================================================

test('AC1: unparseable hook stdin DENIES — a gate that cannot read its own input has verified nothing (P5)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runRaw('{ not json', dir);
    assert.equal(r.code, 2, 'exit 1 here is a VOIDED gate — the platform treats non-2 as NON-BLOCKING, so the Edit would run unexamined');
    assert.match(r.stderr, /ENVIRONMENT DEFECT \(H3\)/);
    assert.match(r.stderr, /\[stdin\] hook input could not be read/, 'the denial must NAME the boundary that refused, so a reader can tell a fail-closed refusal from ordinary contract enforcement');
  } finally {
    cleanup();
  }
});
// SABOTAGE: change the new stdin catch's `deny(` to `allow(` → AC1 red (exit 0).
// NOTE the second, weaker mutation this pin also survives: deleting the
// try/catch entirely reproduces the original defect and AC1 goes red with exit
// 1. Both must be checked. The message-text assertion is what stops the pin
// going hollow — without it, a future deny-everything regression would keep AC1
// green for the wrong reason.

test('AC2: the stdin denial carries BOTH audience resolutions — agent_id rides in the very input that failed to parse, so the wording cannot assume a reader', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runRaw('{"cwd": "truncated mid-', dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /IF YOU ARE A SPAWNED AGENT/, 'the agent-facing half: exit blocked, do not diagnose the gate');
    assert.match(r.stderr, /there is no conductor above you/, 'the repair-facing half: H3 is registered GLOBALLY, so this reaches the conductor too');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the `IF YOU ARE A SPAWNED AGENT:` clause from the detail (or
// pass `{ agentId: input.agent_id }` instead of `{ agentId: undefined }`, which
// would throw on the undefined `input`) → AC2 red. This pin exists because the
// audience is genuinely UNKNOWABLE on this path; a message that picks one
// audience tells the other one to do something impossible.

test('AC6: the literal `null` on stdin DENIES — and it is the READSTDIN WRAP that carries it, because readStdin dereferences the parsed value itself', () => {
  const { dir, cleanup } = makeProject();
  try {
    // `null` is VALID JSON, so JSON.parse does not throw. readStdin then does
    // `projectRoot(input.cwd)` (lib/common.mjs:102) on the parsed value, and
    // THAT throws — inside readStdin, inside the wrap. So the wrap's catch
    // denies and the typeof result-check below it is never reached.
    // PRE-FIX this was the worst shape of the class: the throw landed in the
    // fail-closed try instead, whose handler threw AGAIN on `input.agent_id`,
    // and an uncaught throw inside a catch exits 1 — the FAIL-CLOSED path
    // itself failed OPEN and the Edit ran unexamined.
    const r = runRaw('null', dir);
    assert.equal(r.code, 2, 'exit 1 here means the fail-closed handler is what failed open — the worst shape of this defect');
    assert.match(r.stderr, /ENVIRONMENT DEFECT \(H3\)/);
    assert.match(r.stderr, /\[stdin\] hook input could not be read/, 'a null input must read like any other "the gate never saw its input" case');
    assert.doesNotMatch(r.stderr, /Contract evaluation failed/, 'NOT the outer evaluation catch — that would mean the throw escaped the input boundary again');
    assert.doesNotMatch(
      r.stderr,
      /parsed to null, not an object/,
      'NOT the typeof result-check either: it cannot fire for null, and claiming it does is the misattribution this arm exists to prevent. If this assertion ever fails because readStdin was hardened to validate before dereferencing, that is GOOD — update this arm and the header, do not delete the check.'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: delete the `let input; try {` wrap around readStdin (the HEAD-5eea229
// shape) → AC6 red with exit 1, the original fail-open reproduced exactly.
// CARRIER, stated precisely because the first version of this file got it wrong
// and said the typeof guard carried this: for `null` the carrier is the WRAP.
// Deleting the typeof guard leaves AC6 GREEN — that is not hollowness, it is the
// guard genuinely not being on this path (AC7 is where it IS on the path).
// The `input?.agent_id` in the outer catch is a third layer, unfalsifiable by any
// input while the wrap stands, kept as the backstop for a future edit that
// weakens it. Two negative assertions above are what stop this arm from being
// satisfied by the wrong layer.

test('AC7: stdin that parses to a SCALAR ("x") DENIES via the typeof result-check — the guard `null` never reaches, pinned where it actually fires', () => {
  const { dir, cleanup } = makeProject();
  try {
    // Unlike `null`, a string survives readStdin untouched: `'x'.cwd` is
    // undefined rather than a throw, and `projectRoot(undefined)` returns null
    // on its own `!from` guard. So the parsed value arrives INTACT and only the
    // result-validation stops it. Without that check every field of the
    // contract evaluation would be silently undefined — a gate solemnly
    // evaluating a contract against nothing, which is a voided gate wearing a
    // deny's clothes.
    const r = runRaw('"x"', dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ENVIRONMENT DEFECT \(H3\)/);
    assert.match(r.stderr, /\[stdin\] hook input could not be read/);
    assert.match(r.stderr, /parsed to string, not an object/, 'THIS is the typeof guard speaking, and the detail names which way the input was unusable');
  } finally {
    cleanup();
  }
});
// SABOTAGE: delete the `if (!input || typeof input !== 'object') throw ...`
// result-check → AC7 red (the scalar flows on and the run ends at some later,
// differently-worded denial) while AC6 stays GREEN. That asymmetry IS the
// carrier evidence: two input classes, two guards, two messages, and neither
// arm can be satisfied by the other's layer.

// =========================================================================
// SUBJECT — the relocation of the self-protection block into the boundary.
// =========================================================================

test('AC3: in a STORELESS project a spawned agent editing .claude/agents/** is still refused by SELF-PROTECTION, not by the store probe — the block did not migrate behind openStore', () => {
  const { dir, cleanup } = makeBareDir();
  try {
    const r = runHook({ tool_input: { file_path: join(dir, '.claude', 'agents', 'coder.md') }, agent_id: 'a1' }, dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /self-protection/);
    assert.doesNotMatch(r.stderr, /No Sterling store/, 'self-protection is unconditional — it must precede the store probe, regardless of scope, store presence, or registered maps (§6 H3)');
  } finally {
    cleanup();
  }
});
// SABOTAGE: move the self-protection block one statement DOWN, below
// `store = openStore(cwd)` → AC3 red (the message becomes the storeless
// environment-defect denial) while CONTROL-3 stays GREEN. That asymmetry is the
// whole value of this pin: it is the only arm that can see the exact mistake
// this fix's relocation could have introduced. Overlaps deliberately with
// enforcement.test.mjs "H3 [self-protection]: … in EVERY mode" — kept here
// because that suite pins the RULE while this one pins the ORDER.

// =========================================================================
// SUBJECT — the position invariant itself (STRUCTURAL).
// =========================================================================

test('AC4 [structural]: every executable statement precedes no fail-closed try — readStdin and the self-protection block both sit INSIDE a boundary', () => {
  const src = readFileSync(H3, 'utf8');

  // readStdin is never called at the top level.
  assert.doesNotMatch(src, /^const input = readStdin\(\);$/m, 'a bare top-level readStdin() is the original defect: JSON.parse throws, Node exits 1, the runner reads ALLOW');
  const stdinTry = src.indexOf('let input;\ntry {');
  assert.ok(stdinTry >= 0, 'readStdin must be assigned inside its own try (H15 shape, commit 5eea229)');
  assert.ok(src.indexOf('input = readStdin();') > stdinTry, 'the readStdin call must come AFTER its try opens');

  // The self-protection block sits after the fail-closed try opens.
  const failClosedTry = src.indexOf('let store;\ntry {');
  const selfProtect = src.indexOf('if (input.agent_id && toolPath) {');
  assert.ok(failClosedTry >= 0, 'the fail-closed try must still exist');
  assert.ok(selfProtect >= 0, 'the self-protection block must still exist');
  assert.ok(
    selfProtect > failClosedTry,
    'the block that makes .claude/agents/** and settings*.json un-editable must not itself be voidable by an uncaught throw — POSITION is the criterion, not the identity of the call (board 4a66ba58)'
  );
});
// SABOTAGE: hoist either statement back above its try (the exact HEAD-5eea229
// shape) → AC4 red.
// WHY STRUCTURAL AND NOT BEHAVIOURAL: no hook input throws inside that block
// today — see the header. A behavioural pin here would be fabricated. This
// assertion is the honest one, and it is EXPECTED TO BE REPLACED by the
// roster-wide scripts/check-failclosed-boundary.mjs (board 4a66ba58's "recipe
// replacement") once that lands in the `npm run check` chain; delete it then
// rather than maintaining two copies of one rule.

// =========================================================================
// LAYER SEPARATION — WHICH guard owns WHICH verdict. Pinned so a later reader
// never assumes one catch covers everything, and so a second deny layer cannot
// silently satisfy a pin that a first layer was written for.
// =========================================================================

test('AC5: the three fail-closed messages are DISJOINT — stdin, store probe, and the pre-existing evaluation catch each speak for themselves', () => {
  const { dir, cleanup } = makeProject();
  const bare = makeBareDir();
  try {
    const stdin = runRaw('{ not json', dir);
    const nostore = runHook({ tool_input: { file_path: join(bare.dir, 'x.ts') } }, bare.dir);

    assert.equal(stdin.code, 2);
    assert.equal(nostore.code, 2);
    assert.match(stdin.stderr, /\[stdin\]/);
    assert.doesNotMatch(stdin.stderr, /Contract evaluation failed/, 'the stdin catch fires BEFORE the evaluation try is ever entered');
    assert.doesNotMatch(stdin.stderr, /No Sterling store/, 'the project is unknowable before the input parses');
    assert.match(nostore.stderr, /No Sterling store/);
    assert.doesNotMatch(nostore.stderr, /\[stdin\]/);
  } finally {
    bare.cleanup();
    cleanup();
  }
});
// SABOTAGE: replace the stdin catch's message with the generic
// `Contract evaluation failed (...)` text → AC5 red while AC1 stays green on
// exit code alone. That is the layer-separation evidence: distinct guards,
// distinct verdicts, no overlap.
