// H30 bare-id legibility — FROZEN SPEC PIN. PreToolUse advisory on
// AskUserQuestion: warn when a bare record id (uuid or 8-hex) is put in front
// of a HUMAN with no human-readable gloss beside it. ADVISORY, EXIT 0, NEVER
// BLOCKING.
//
// ORACLE / READ WALL (H4). This file does NOT read
// scripts/hooks/h30-bare-id-legibility.mjs — the test-writer read wall denied
// it (verbatim: "H30 ... is implementation — the test-writer never reads
// code"), which is the point: an oracle anchored to the code under test
// certifies whatever the code happens to do. The spec below comes from
//   - decision 2e8c30e4 human-readable-ids-for-board-items (layer S3),
//   - board item 6510a9da s3-the-shared-rule-plus-enforcement... ,
//   - the dispatch brief's verbatim behaviour statement,
// and the HARNESS IDIOM from sibling TESTS only:
// scripts/tests/h29-codex-consult-failure.test.mjs and
// scripts/tests/h25-h26-advisory-precision.test.mjs.
//
// SOURCE, NOT BUNDLE. The esbuild bundle hooks/h30-bare-id-legibility.mjs does
// not exist yet (H17 reverted it under a concurrent .git/index.lock). Per the
// sibling convention above, this suite spawns the SOURCE at
// scripts/hooks/h30-bare-id-legibility.mjs. If the bundle is later built, this
// suite keeps pinning the source — the bundle is covered by the bundling
// checks, not here.
//
// WHY THE MESSAGE TEXT IS PINNED (T12). A non-blocking PreToolUse advisory
// reaches the model only WITH THE TOOL RESULT — i.e. AFTER the user has
// already answered. "Do better next time" therefore changes no outcome and is
// P1 ceremony. The only outcome-changing message is: DO NOT TREAT THIS ANSWER
// AS A RULING, RE-ASK WITH READABLE NAMES. Decision 2e8c30e4's rationale is
// the justification clause and is quoted with the ruling on purpose: "an
// unanswerable question is worse than an unasked one, because it manufactures
// a ruling from someone who could not see what they were ruling on".
//
// FALSE-POSITIVE PROFILE IS THE POINT (T2, T3). The detection rule
// deliberately biases toward MISSED warnings over false alarms — an advisory
// that cries wolf gets ignored (the H26 lesson, named by board 6510a9da
// itself). A candidate is admitted ONLY when it (a) resolves UNIQUELY through
// the mounted record/alias universe, or (b) sits in an explicit Sterling
// citation context (board / todo / maintenance / decision / article / finding
// / brief / knowledge_get).
//
// LIVE-STORE FIXTURE DEPENDENCY, stated so a failure is diagnosable. T4, T8
// and T10 exercise the RESOLUTION branch and therefore depend on this repo's
// own mounted store still holding the board item whose id starts c3705a15
// ("prose citation resolution"). T4 is the canary: if T4, T8 and T10 fail
// TOGETHER while T1 passes, suspect that fixture record's absence (a fixture
// defect) before suspecting the hook. Every other arm is store-independent.
//
// CONTROL ARMS. T1 runs FIRST and must WARN: it rules out "the hook is dead /
// silent unconditionally" as the explanation for every silence arm below — a
// dead hook passes T2/T3/T6/T7/T9 vacuously but fails T1. T9 is the second
// control, passing for the OPPOSITE reason (a candidate that must NOT be
// admitted), so T8's warning cannot be explained by "this hook admits
// everything". Read T1 + T9 together before trusting any single verdict here.
//
// PER-ARM EXPECTED RESULT AND NAMED SABOTAGE — the mutation that must make
// each arm RED (decision a-ruling-change-is-verified-by-mutation-not-by-a-green-suite):
//   T1  WARN    M6  drop the citation-context branch            (LIVE CONTROL)
//   T2  SILENT  M5  admit every candidate
//   T3  SILENT  M5  admit every candidate (date/sha/word-hex/colour battery)
//   T4  WARN    M11 drop the unique-resolution branch
//   T4b SILENT  M12 relax "resolves uniquely" to "resolves at all" against an
//                   isolated fixture store holding a genuine 8-hex collision;
//                   CONTROL (same fixture, unique id, no trigger) must WARN
//                   FIRST — proves the fixture store is actually read before
//                   T4b's silence is trusted (round-2 fix: the JSON stdin
//                   `cwd` field, not just spawnSync's OS cwd, must point at
//                   the fixture — decision d9521e96)
//   T5  WARN    M2  drop the generic-type-word check
//   T6  SILENT  M1  isGlossed always false (clipped-name gloss)
//   T7  SILENT  M1  isGlossed always false (full-name gloss)
//   T9  SILENT  M5  admit every candidate                    (OPPOSITE-REASON CONTROL)
//   T8  WARN    M3  concatenate all visible fields before scanning
//   T10 WARN    M4  gloss lookback line-start -> 0
//   T11 WARN    M7B uuid-alternative-second AND `-` dropped from the trailing
//                   lookahead (see the defence-in-depth note on T11)
//   T12 WARN    M8  reword the advisory to "do better next time"
//   T13 EXIT 0  M9  exit 2 / permissionDecision deny on the warning path
//   T14 (hooks.json scoping, not a hook-source mutation) — M10 was a no-op:
//                   grep -n tool_name over the hook source is ZERO hits, so
//                   there is no in-hook filter to sabotage. This arm instead
//                   pins hooks/hooks.json's AskUserQuestion matcher block as
//                   the SOLE registration of H30 — see the T14 block below
//                   for its own named sabotage against hooks.json.
//
// The author of this file holds no Bash and has RUN NOTHING. The expected
// results above are the oracle the conductor gates against, not observations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(root, 'scripts', 'hooks', 'h30-bare-id-legibility.mjs');

// --- isolated collision fixture (T4b) ---------------------------------------
// Working pattern lifted from scripts/tests/knowledge-export.test.mjs:36-56
// (getStore / makeProject / decisionRow) — a project-local store the hook is
// pointed at via cwd, so T4b can force a genuine 8-hex AMBIGUOUS prefix
// without depending on (or risking collision with) this repo's own live
// store, which knowledge-export.test.mjs's sibling REFUSAL test (lines
// 237-254) already relies on for the identical id shape.
const FIXTURE_NOW = '2026-06-10T12:00:00.000Z';
let SterlingStore;
async function getStore() {
  if (!SterlingStore) {
    ({ SterlingStore } = await import(
      pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href
    ));
  }
  return SterlingStore;
}
function decisionRow(id) {
  return {
    id, type: 'decision', created_at: FIXTURE_NOW, updated_at: FIXTURE_NOW, author: 'conductor',
    status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
    title: 't', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: [],
  };
}
function makeCollisionFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h30-collision-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ stack_tags: [] }));
  return dir;
}

// A real board item id prefix in this repo's store ("prose citation
// resolution"), used ONLY where the arm must exercise unique resolution.
const RESOLVING = 'c3705a15';
// A synthetic 8-hex that must not resolve to anything.
const SYNTHETIC = '9c8b7a65';
// A real decision id (human-readable-ids-for-board-items), used whole in T11.
const FULL_UUID = '2e8c30e4-36e6-4c18-8ce8-98f7c1d5e1da';

// ---------------------------------------------------------------------------
// Harness (spawnSync + JSON stdin, per the sibling suites)
// ---------------------------------------------------------------------------

function runRaw(rawStdin, cwd = root) {
  // Spawn EXACTLY as hooks/hooks.json does. Without --disable-warning the node
  // SQLite ExperimentalWarning lands on stderr, and assertSilent's stderr filter
  // strips only the warning's FIRST line — leaving its '(Use `node --trace-warnings`)'
  // trailer to be scored as a false advisory. That made all 7 silence arms fail
  // against a hook that had written zero bytes to stdout. Diagnosed 2026-08-29.
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', HOOK], {
    input: rawStdin,
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runHook(input, cwd = root) {
  return runRaw(JSON.stringify(input), cwd);
}

/** Build a PreToolUse/AskUserQuestion payload from one question spec. */
function ask(question) {
  return {
    session_id: 'h30-frozen-pin',
    cwd: root,
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          question: question.question ?? 'Proceed?',
          header: question.header ?? 'Decide',
          multiSelect: false,
          options: question.options ?? [
            { label: 'Yes', description: 'go ahead' },
            { label: 'No', description: 'stop here' },
          ],
        },
      ],
    },
  };
}

/** Only the question field carries the fixture text; everything else is inert. */
function askQuestionText(text) {
  return ask({ question: text, header: 'Decide' });
}

/**
 * Override the JSON stdin payload's `cwd` field (NOT just the spawned
 * process's OS cwd) to point at an isolated fixture directory.
 *
 * WHY THIS EXISTS (found via CLAUDE.md's own stated invariant, not by reading
 * the hook): "every hook resolves `.sterling/` through readStdin's
 * project-root normalization, never the raw shell cwd (decision d9521e96)".
 * `ask()` above hardcodes `cwd: root` into the JSON body. Passing a fixture
 * dir as runHook's second argument only sets spawnSync's OS-level cwd (the
 * "raw shell cwd" the invariant says hooks do NOT use) — the JSON `cwd` field
 * the hook actually reads was, until this helper existed, always `root`. That
 * is precisely why T4b's fixture store was never being consulted: the hook
 * was reading THIS repo's real store both with and without the sabotage,
 * making its silence unrelated to ambiguity.
 */
function withCwd(input, dir) {
  return { ...input, cwd: dir };
}

/**
 * The advisory a run produced, or null when the hook stayed SILENT.
 * Any output on any channel counts as "not silent" — a legibility advisory
 * that leaks into a silence case is a false alarm regardless of channel.
 */
function advisoryOf(r) {
  const err = (r.stderr || '')
    .split('\n')
    .filter((l) => l.trim() && !/Warning:/.test(l))
    .join('\n')
    .trim();
  const out = (r.stdout || '').trim();
  if (out) {
    let parsed = null;
    try {
      parsed = JSON.parse(out);
    } catch {
      return out; // non-JSON stdout is still output, so still not silence
    }
    const text =
      parsed?.hookSpecificOutput?.additionalContext ??
      parsed?.systemMessage ??
      '';
    if (String(text).trim()) return String(text);
    // A JSON envelope carrying no advisory text is silence.
    return err || null;
  }
  return err || null;
}

function assertWarns(r, id, label) {
  const advisory = advisoryOf(r);
  assert.ok(
    advisory,
    `${label}: expected an advisory naming '${id}', got SILENCE (exit ${r.code})`,
  );
  assert.ok(
    advisory.includes(id),
    `${label}: advisory fired but does not name '${id}': ${JSON.stringify(advisory)}`,
  );
  assert.equal(r.code, 0, `${label}: advisory must exit 0, never block`);
  return advisory;
}

function assertSilent(r, label) {
  const advisory = advisoryOf(r);
  assert.equal(
    advisory,
    null,
    `${label}: expected SILENCE (false alarms get the channel ignored — the H26 lesson), got: ${JSON.stringify(advisory)}`,
  );
  assert.equal(r.code, 0, `${label}: must exit 0`);
}

// ===========================================================================
// T1 — LIVE CONTROL. Must WARN. Runs first so no silence arm below can pass
// vacuously against a dead hook.
// SABOTAGE M6: drop the citation-context branch -> SILENT -> red.
// ===========================================================================
test('T1 (LIVE CONTROL): a bare 8-hex id in an explicit citation context warns', () => {
  const r = runHook(
    askQuestionText(`Should we close board ${SYNTHETIC} before merging?`),
  );
  assertWarns(r, SYNTHETIC, 'T1');
});

// ===========================================================================
// T2 — the same id with NO citation trigger and no resolution: SILENT.
// Together with T1 this isolates the admission rule: identical token, verdict
// flips on context alone.
// SABOTAGE M5: admit every candidate -> warns -> red.
// ===========================================================================
test('T2: an unresolvable 8-hex with no citation context does NOT warn', () => {
  const r = runHook(askQuestionText(`Should we close ${SYNTHETIC} before merging?`));
  assertSilent(r, 'T2');
});

// ===========================================================================
// T3 — THE FALSE-POSITIVE PROFILE. Each of these is 8 hex characters and none
// is a record id. The rule biases toward missed warnings over false alarms.
// SABOTAGE M5: admit every candidate -> every case warns -> red.
// (Carried by T1: if the hook were simply dead, T1 fails, so a green T3 here
// is evidence of selectivity rather than of silence.)
// ===========================================================================
test('T3: dates, commit shas, hex words and colours do NOT warn', () => {
  const cases = [
    ['a date', 'Ship the 20260829 build?'],
    ['a bare commit sha', 'Revert to 80fa755d?'],
    ['deadbeef', 'Is the sentinel value deadbeef still written?'],
    ['cafebabe', 'Should the magic number stay cafebabe?'],
    ['an 8-digit CSS colour', 'Use #1a2b3c4d for the banner background?'],
  ];
  for (const [what, text] of cases) {
    assertSilent(runHook(askQuestionText(text)), `T3/${what}`);
  }
});

// ===========================================================================
// T4 — THE RESOLUTION BRANCH, and the canary for this suite's live-store
// fixture dependency. A bare prefix that resolves UNIQUELY is admitted with no
// trigger word beside it.
// SABOTAGE M11: drop the unique-resolution branch -> SILENT -> red.
// Paired with T2 (identical shape, non-resolving id, must stay silent), so a
// green T4 cannot be explained by "everything is admitted".
// ===========================================================================
test('T4: a bare id that resolves uniquely warns even with no trigger word', () => {
  const r = runHook(askQuestionText(`Should we close ${RESOLVING} before merging?`));
  assertWarns(r, RESOLVING, 'T4');
});

// ===========================================================================
// T4b — ACCEPTED RESIDUAL, PINNED AS CURRENT BEHAVIOUR, NOT AS A BUG.
// An AMBIGUOUS prefix (matching several records) is NOT admitted by the
// resolution branch, because the test is "resolves UNIQUELY". With no trigger
// word beside it, it is a KNOWN ACCEPTED MISS — the citation-context branch
// normally catches it (see T1), which is why the residual was judged
// acceptable. DO NOT "FIX" THIS ARM by making it warn: widening admission to
// ambiguous prefixes reopens the false-alarm profile T3 exists to protect.
//
// PREVIOUSLY HOLLOW, FIXED HERE (round 1). The old fixture used
// `RESOLVING.slice(0, 4)` — a 4-char string — which CANDIDATE_RE (8 hex chars
// or a full UUID) never even admits as a candidate, so the hook `allow()`s
// before the ambiguity logic runs at all; the arm passed for a reason that
// has nothing to do with ambiguity. Fixed by building an ISOLATED fixture
// store (never the live repo store) holding records that share an 8-hex
// prefix.
//
// STILL HOLLOW AFTER ROUND 1 (measured by the conductor, 2026-08-29): the
// fixture dir was passed only as runHook's second argument (spawnSync's OS
// cwd), while `ask()` hardcodes `cwd: root` into the JSON stdin BODY. Per
// decision d9521e96 the hook resolves `.sterling/` through readStdin's cwd,
// never the raw shell cwd — so the hook kept reading THIS REPO'S real store
// throughout, and T4b's silence had nothing to do with ambiguity (it would
// have been silent identically had the fixture held nothing at all).
//
// FIX, ROUND 2: `withCwd()` overrides the JSON payload's `cwd` field, and a
// CONTROL ARM runs FIRST, in the SAME fixture store, on a bare id that
// resolves UNIQUELY with no trigger word — it must WARN. Without this
// control, T4b's silence would again have more than one possible cause: real
// ambiguity, or "the fixture store still isn't being read". If the control is
// silent, that is proof the fixture is unreachable and must be fixed before
// T4b's silence means anything.
// SABOTAGE (control): relax "resolves uniquely" to "resolves at all" ->
// UNIQUE_ID still warns (no change) but the AMBIGUOUS-prefix arm below now
// also warns -> that assertion goes red. (The control's OWN failure mode is a
// fixture-plumbing regression, not this sabotage — see note above.)
// ===========================================================================
test('T4b (ACCEPTED RESIDUAL): a genuinely ambiguous bare prefix with no trigger stays silent', async () => {
  const Store = await getStore();
  const dir = makeCollisionFixture();
  const store = new Store(join(dir, '.sterling', 'sterling.db'));
  const UNIQUE_ID = 'bbbbbbbb-1111-4111-8111-111111111111';
  store.create(decisionRow(UNIQUE_ID));
  store.create(decisionRow('aaaaaaaa-1111-4111-8111-111111111111'));
  store.create(decisionRow('aaaaaaaa-2222-4222-8222-222222222222'));
  store.close();

  // CONTROL, FIRST, OPPOSITE REASON: a uniquely-resolving id in this SAME
  // fixture store, no trigger word, must WARN. Proves the fixture store is
  // actually being read by the spawned hook before trusting T4b's silence.
  const control = runHook(
    withCwd(askQuestionText('Should we close bbbbbbbb before merging?'), dir),
    dir,
  );
  assertWarns(control, 'bbbbbbbb', 'T4b-CONTROL');

  // MAIN ARM: 'aaaaaaaa' resolves to TWO records in this fixture — no
  // citation trigger word (mirrors T2's phrasing) — so admission, if any,
  // could only come from the resolution branch, which must decline.
  const r = runHook(
    withCwd(askQuestionText('Should we close aaaaaaaa before merging?'), dir),
    dir,
  );
  assertSilent(r, 'T4b');
});

// ===========================================================================
// T5 — THE GLOSS TEST IS NOT SATISFIED BY A GENERIC TYPE WORD. The token
// IMMEDIATELY adjacent to '(' is "item", which names the TYPE, not the thing —
// exactly the phrasing decision 2e8c30e4 was written about ("board 17204d1e"
// / "no way of knowing what that refers to"). This is the case the coder
// tightened for: a line-scoped gloss test let an ordinary sentence verb
// ("should", "close") launder the type word.
// SABOTAGE M2: drop the generic-type-word check -> "item" counts as a gloss
// -> SILENT -> red.
// ===========================================================================
test('T5: a generic type word next to the id is NOT a gloss — still warns', () => {
  const r = runHook(askQuestionText('Should we close board item (17204d1e)?'));
  assertWarns(r, '17204d1e', 'T5');
});

// ===========================================================================
// T6 — A CLIPPED NAME STILL COUNTS AS A GLOSS. Names clip; ids never do
// (decision 2e8c30e4 S2: "names clip and ids never do, because a truncated id
// is unresolvable while a truncated name is still recognisable"). The id is
// admitted here (citation context: "board"), so silence can only come from the
// gloss test.
// SABOTAGE M1: isGlossed always false -> warns -> red.
// ===========================================================================
test('T6: a CLIPPED human-readable name beside the id counts as a gloss', () => {
  const r = runHook(
    askQuestionText(`Close board item prose citation resol… (${RESOLVING}) now?`),
  );
  assertSilent(r, 'T6');
});

// ===========================================================================
// T7 — the ordinary glossed shape: a full human-readable name beside the id.
// Admitted via the citation context ("decision"); silence is the gloss test.
// SABOTAGE M1: isGlossed always false -> warns -> red.
// (M1 kills T6 and T7 — two arms, matching the coder's battery.)
// ===========================================================================
test('T7: a full human-readable name beside the id counts as a gloss', () => {
  const r = runHook(
    askQuestionText(
      'Apply decision human-readable-ids-for-board-items (2e8c30e4) to this project?',
    ),
  );
  assertSilent(r, 'T7');
});

// ===========================================================================
// T9 — OPPOSITE-REASON CONTROL for T8, placed FIRST. Same fixture SHAPE as the
// field-independence arm (an id parenthesized and alone in its own field, a
// human-readable name in a SIBLING field) but with a NON-RESOLVING id. It must
// stay SILENT. Without this, T8's warning has more than one possible cause:
// "fields are scanned independently" and "this hook admits every candidate"
// both produce a green T8. T9 rules the second one out.
// SABOTAGE M5: admit every candidate -> warns -> red.
// ===========================================================================
test('T9 (OPPOSITE-REASON CONTROL): the same field shape with an unresolvable id is silent', () => {
  const r = runHook(
    ask({
      question: 'Which lane should we run next',
      header: 'Pick a lane',
      options: [
        {
          label: 'prose citation resolution',
          description: 'the deferred write-time citation warnings',
        },
        { label: `(${SYNTHETIC})`, description: 'the other candidate lane' },
      ],
    }),
  );
  assertSilent(r, 'T9');
});

// ===========================================================================
// T8 — FIELD INDEPENDENCE. Each visible string field is scanned on its own, so
// a human-readable name in option A cannot gloss an id in option B.
//
// FIXTURE SHAPE IS LOAD-BEARING AND WAS CORRECTED ONCE — DO NOT REGRESS IT.
// The id sits PARENTHESIZED AND ALONE IN ITS OWN FIELD, with the name in a
// SIBLING field. An earlier draft put an UNPARENTHESIZED id in the sibling
// option: that arm was HOLLOW, because the gloss test requires parentheses, so
// concatenating the fields could never have laundered it and M3 would have
// SURVIVED against a test that looked like it pinned field independence.
// With the corrected shape, concatenation places "…resolution" / "…warnings" /
// "…lane" immediately before "(c3705a15)" — a letter-carrying, non-type-word,
// non-hex token — which IS a gloss, so the arm goes silent under M3.
// Every sibling field therefore deliberately ENDS in such a token.
//
// Admission here is by unique RESOLUTION (see T4), not by citation context:
// the field holds nothing but the parenthesized id, which is precisely what
// makes the concatenation mutation observable.
//
// SABOTAGE M3: concatenate all visible fields before scanning -> SILENT -> red.
// DEFENCE-IN-DEPTH CAVEAT, stated so a survival is not misread as hollowness:
// if M3's concatenation joins fields with a NEWLINE rather than a space, the
// line-scoped gloss lookback pinned by T10 also blocks the laundering, and
// this arm may survive. That would be a second layer holding, not a hollow
// pin — strip both (concatenate with a space) to see this arm go red.
// ===========================================================================
test('T8: a name in one option does NOT gloss an id sitting alone in another field', () => {
  const r = runHook(
    ask({
      question: 'Which lane should we run next',
      header: 'Pick a lane',
      options: [
        {
          label: 'prose citation resolution',
          description: 'the deferred write-time citation warnings',
        },
        { label: `(${RESOLVING})`, description: 'the other candidate lane' },
      ],
    }),
  );
  assertWarns(r, RESOLVING, 'T8');
});

// ===========================================================================
// T10 — THE GLOSS LOOKBACK IS LINE-SCOPED. The id opens its own line, so
// nothing precedes '(' on that line and it is NOT glossed; the letter-carrying
// word ending the PREVIOUS line ("refresh") must not reach across the newline
// to launder it. Admission is by unique resolution, so this arm isolates the
// lookback window and nothing else.
// SABOTAGE M4: gloss lookback line-start -> 0 (search the whole field) ->
// "refresh" is taken as the adjacent token -> SILENT -> red.
// ===========================================================================
test('T10: a gloss cannot reach across a newline — the lookback is line-scoped', () => {
  const r = runHook(
    askQuestionText(`Slice S3 still needs a rotation note refresh\n(${RESOLVING}) — proceed?`),
  );
  assertWarns(r, RESOLVING, 'T10');
});

// ===========================================================================
// T11 — A FULL UUID IS ONE FINDING, NOT TWO. Its leading 8 hex characters must
// not be reported separately as a second bare id.
//
// WHICH GUARD CARRIES THIS VERDICT — read before mutating. Two layers exist:
//   (a) the trailing lookahead (?![0-9A-Za-z-]) — the '-' in that class is
//       what actually rejects the 8-hex head of a uuid, and it is LOAD-BEARING
//       for this arm;
//   (b) the regex alternation order (uuid alternative first) — redundant
//       belt-and-braces.
// Measured by the coder's battery: M7A (reorder so the 8-hex alternative comes
// first) SURVIVES this arm, because (a) still holds. M7B (M7A plus dropping
// '-' from the trailing lookahead) kills it. A SINGLE-LAYER MUTATION SURVIVING
// HERE IS DEFENCE IN DEPTH, NOT A HOLLOW PIN — do not report M7A's survival as
// evidence this arm pins nothing.
// SABOTAGE M7B: 8-hex alternative first AND '-' dropped from the trailing
// lookahead -> the head is reported as its own bare id -> red.
// ===========================================================================
test('T11: a full uuid is reported once, not also as its 8-hex head', () => {
  const r = runHook(askQuestionText(`Should we apply board ${FULL_UUID} now?`));
  const advisory = assertWarns(r, FULL_UUID, 'T11');
  const head = FULL_UUID.slice(0, 8);
  const occurrences = [...advisory.matchAll(new RegExp(`${head}(.?)`, 'g'))];
  assert.ok(
    occurrences.length > 0,
    `T11: advisory names the uuid but not via its head — fixture drift: ${JSON.stringify(advisory)}`,
  );
  for (const m of occurrences) {
    assert.equal(
      m[1],
      '-',
      `T11: '${head}' appears in the advisory NOT as part of the full uuid, i.e. the 8-hex head was reported separately: ${JSON.stringify(advisory)}`,
    );
  }
});

// ===========================================================================
// T12 — THE MESSAGE MUST CHANGE AN OUTCOME THAT IS STILL CHANGEABLE.
// A non-blocking PreToolUse advisory reaches the model WITH THE TOOL RESULT —
// after the user has already answered. So the message must tell the conductor
// NOT TO TREAT THE ANSWER AS A RULING and TO RE-ASK with readable names.
// A "do better next time" message changes nothing and is P1 ceremony.
// Justification carried with the ruling (decision 2e8c30e4): "an unanswerable
// question is worse than an unasked one, because it manufactures a ruling from
// someone who could not see what they were ruling on".
// SABOTAGE M8: reword the advisory to "do better next time" -> red on all four
// assertions below.
// ===========================================================================
test('T12: the advisory says do not treat the answer as a ruling, and re-ask', () => {
  const r = runHook(
    askQuestionText(`Should we close board ${SYNTHETIC} before merging?`),
  );
  const advisory = assertWarns(r, SYNTHETIC, 'T12');
  assert.match(
    advisory,
    /re-?ask/i,
    'T12: advisory must instruct a RE-ASK with readable names; a future-improvement note changes no outcome',
  );
  assert.match(
    advisory,
    /\b(ruling|authoritative|binding)\b/i,
    'T12: advisory must say the answer is not to be taken as a ruling',
  );
  assert.match(
    advisory,
    /\banswers?\b/i,
    'T12: advisory must speak about the ANSWER already given, not about future questions',
  );
  assert.ok(
    !/(next time|in the future|in future|going forward|from now on)/i.test(advisory),
    `T12: advisory is phrased as deferred self-improvement, which arrives after the user answered and changes nothing: ${JSON.stringify(advisory)}`,
  );
});

// ===========================================================================
// T13 — ADVISORY, NEVER A BLOCK. Exit 0 on the warning path, the silent path,
// and on malformed stdin. A legibility warning is not a safety gate (P1: a
// gate that changes no outcome is ceremony), and board 6510a9da states it
// explicitly: "ADVISORY, NEVER A BLOCK".
// SABOTAGE M9: exit 2 (or emit permissionDecision "deny") on the warning path
// -> red.
// ===========================================================================
test('T13: never blocks — exit 0 on warn, on silence, and on malformed stdin', () => {
  const warned = runHook(
    askQuestionText(`Should we close board ${SYNTHETIC} before merging?`),
  );
  assert.equal(warned.code, 0, 'T13: the WARNING path must exit 0');
  assert.ok(
    !/"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"block"/.test(warned.stdout),
    `T13: the advisory must not carry a deny/block decision: ${JSON.stringify(warned.stdout)}`,
  );

  const silent = runHook(askQuestionText('Should we ship the 20260829 build?'));
  assert.equal(silent.code, 0, 'T13: the SILENT path must exit 0');

  const malformed = runRaw('this is not json at all');
  assert.equal(malformed.code, 0, 'T13: malformed stdin must not block a tool call');
});

// ===========================================================================
// T14 — SCOPE: the hook only speaks for AskUserQuestion. Bare ids are correct
// on mechanically-resolved surfaces (spawn inputs, tool parameters, the id
// ladder) — decision 2e8c30e4 S3 names that fence explicitly.
//
// PREVIOUSLY A NO-OP, FIXED HERE. `grep -n tool_name` over
// scripts/hooks/h30-bare-id-legibility.mjs returns ZERO hits — the hook
// itself carries no tool_name filter to sabotage. hooks/hooks.json's
// AskUserQuestion PreToolUse matcher is the ONLY thing scoping H30 to that
// tool. Per the dispatch brief: do NOT add a redundant tool_name check to the
// hook (that would change production behaviour, out of scope here) — instead
// pin the thing that actually does the scoping: hooks.json's registration.
// SABOTAGE: list 'h30-bare-id-legibility' under a second matcher block (e.g.
// PostToolUse, or a wildcard/empty matcher) in hooks/hooks.json -> more than
// one matching block is found -> red. Equally: change the sole matcher away
// from the bare string 'AskUserQuestion' in EITHER direction — narrow it to
// '*'/'' (regex would already catch this) OR BROADEN it to something like
// 'AskUserQuestion|Bash' (a substring/regex match would NOT catch this, since
// 'AskUserQuestion|Bash' still matches /AskUserQuestion/ and H30 would then
// fire on Bash calls too) -> the exact-equality assertion below goes red
// either way, because only the literal string 'AskUserQuestion' passes.
// ===========================================================================
test('T14: hooks.json scopes H30 to AskUserQuestion only — no other matcher block also lists it', () => {
  const hooksJsonPath = join(root, 'hooks', 'hooks.json');
  const config = JSON.parse(readFileSync(hooksJsonPath, 'utf8'));
  const HOOK_NAME = 'h30-bare-id-legibility';

  const matchingBlocks = [];
  for (const [event, blocks] of Object.entries(config.hooks || {})) {
    for (const block of blocks || []) {
      const commands = (block.hooks || []).map((h) => h.command || '');
      if (commands.some((c) => c.includes(HOOK_NAME))) {
        matchingBlocks.push({ event, matcher: block.matcher });
      }
    }
  }

  assert.equal(
    matchingBlocks.length,
    1,
    `H30 must be scoped by exactly one matcher block; found ${matchingBlocks.length}: ${JSON.stringify(matchingBlocks)}`,
  );
  assert.equal(matchingBlocks[0].event, 'PreToolUse', 'H30 must be registered under PreToolUse');
  assert.equal(
    matchingBlocks[0].matcher,
    'AskUserQuestion',
    // A substring/regex check (e.g. /AskUserQuestion/) is too weak here: a
    // matcher BROADENED to 'AskUserQuestion|Bash' (or any expression that
    // still contains 'AskUserQuestion' plus extra tools) would still match
    // that regex and pass, while H30 would in fact run outside its intended
    // surface. Exact equality to the bare string is the only assertion that
    // catches broadening inside the block, not just a second block appearing.
    `the sole matcher block scoping H30 must be EXACTLY the bare string "AskUserQuestion" (no alternation, no wildcard, no extra tools); got ${JSON.stringify(matchingBlocks[0].matcher)}`,
  );
});
