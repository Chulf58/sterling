// H22 CLAIMED-TERRITORY (write-side negation guard) — board c56862a9,
// research_finding 289cd172 v2 (h26-registers-do-not-touch-paths-as-held-territory).
//
// R1 PIN RE-CUT: KEPT WHOLE. The rebuild keeps `files` (territory EXAMINED)
// and `claimed_files` (territory CLAIMED) as separate RegisterEntry fields
// (contract sheet §1.1) and keeps H26's claimed-first / files-fallback read.
// The only change is Section 5's ledger lookup: a promoted receipt's declared
// territory lives at `territory.files` (§1.2) and the dual-shape tolerance is
// no longer needed — the v1 flat shape is never PRODUCED, only read through
// the legacy adapter.
//   RETIRED: the `ledger[0].territory?.files ?? ledger[0].files` dual-shape
//   read — a promotion writes one shape, and tolerating two hid which.
//
// SPEC UNDER TEST (given by the launching agent):
//   H22 SubagentStart keeps writing `files` = EVERY path candidate the matched
//   block(s) mention (territory EXAMINED — review receipts, residue probes and
//   H10 deferral all depend on that breadth) and ADDS `claimed_files` = the
//   subset whose mentions are not all inside a prohibition clause (territory
//   CLAIMED), computed with the SAME shared detector the read side already
//   uses (lib/dispatch-advisory.mjs hasUnsuppressedMatch, checkSubjectVerb:false).
//   `claimed_files` is ALWAYS written, even empty — its ABSENCE means "legacy
//   entry". H26 compares overlaps against `claimed_files` when present and
//   falls back to `files` when absent.
//
// CORPUS: the measured false positives in 289cd172 v2. The v1 example that
// record WITHDREW (record ids such as "DO NOT TOUCH: 59d810cf" — no slash or
// extension, so PATH_CANDIDATE_RE extracts nothing) is deliberately NOT
// resurrected here.
//
// WHICH GUARD CARRIES WHICH VERDICT (stated per section, because two layers
// could otherwise satisfy one assertion):
//   - Section 2 register assertions are carried SOLELY by h22's
//     claimedFromBlocks(). Sabotage: `.filter((raw) => true || hasUnsuppressed…)`
//     in scripts/hooks/h22-dispatch-register.mjs -> Section 2 red, Section 4
//     (legacy) unaffected.
//   - Section 3 end-to-end assertions are carried by BOTH h22's write and
//     h26's read. Sabotage EITHER (the filter above, or forcing
//     `const entryFiles = e.files;` in scripts/hooks/h26-dispatch-overlap.mjs)
//     -> Section 3 red. Measured 2026-08-26: with only the h26 half reverted the
//     pre-existing suites stay GREEN, which is why Section 3 exists.
//   - Section 4 (legacy fallback) is carried SOLELY by h26's
//     `Array.isArray(e.claimed_files) ? e.claimed_files : e.files`. Sabotage:
//     `e.claimed_files ?? []` -> Section 4 red (and ~10 pre-existing H26 tests).
//   - Section 5 (receipt preservation) is carried by h22 leaving `files`
//     unfiltered. Sabotage: write `files: claimedFiles` -> Section 5 red while
//     Sections 2/3 stay green, which is the whole reason the field was split.
//
// CONTROL ARM RUNS FIRST (Section 1): a plain positive claim must still be
// registered AND still warn, so no green below can be "nothing matched".
//
// Harness idiom mirrors scripts/tests/h25-h26-advisory-precision.test.mjs and
// scripts/tests/h22-attribution.test.mjs (spawnSync runner, transcript
// fixtures, register/ledger readers), reused without modifying either file.
// No SterlingStore import is needed: H22 gates on .sterling/config.json
// EXISTENCE and H26 on a .sterling/sterling.db marker file only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H22_PATH = join(HOOKS, 'h22-dispatch-register.mjs');

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function runHook(hookPath, input, cwd) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// A Sterling project for BOTH hooks: H22 needs .sterling/config.json to exist,
// H26 needs the .sterling/sterling.db marker for its FILE-overlap check.
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22claim-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [] }));
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ===========================================================================
// STATE-MACHINE RE-CUT (board 5445066b, decision
// `dispatch-state-machine-pre-slot-post-binding-locked-start-resolution-replaces-transcript-attribution`,
// knowledge_get 7c515e52 — opened, not paraphrased): SubagentStart no longer
// reads the parent transcript; it resolves ONE prompt from the per-dispatch
// state record written at PreToolUse. The FIXTURE KEEPS ITS NAME AND
// SIGNATURE — one entry per [subagent_type, prompt] — so every call site and
// every claim/territory assertion in this file is byte-identical; each entry
// now fires a REAL PreToolUse Task event instead of planting a tool_use block.
// SubagentStart's transcript_path points at a file that does not exist, which
// is correct under the new contract and doubles as a pin that no transcript is
// read (a surviving reader would extract nothing and every claim assertion
// would go red).
// ===========================================================================
let toolUseSeq = 0;
function writeTranscript(dir, blocks) {
  for (const [subagent_type, prompt] of blocks) {
    const r = runHook(
      H22_PATH,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_use_id: `toolu_cl_${(toolUseSeq += 1)}`,
        tool_input: { subagent_type, prompt, description: 'a lane' },
        session_id: 's1',
        cwd: dir,
        transcript_path: join(dir, 't', 'parent.jsonl'),
        prompt_id: 'pr-1',
      },
      dir
    );
    assert.notEqual(r.code, 2, `PreToolUse must never deny a dispatch: ${r.stderr}`);
  }
}

function subagentStart(dir, { agent_id = 'a1', agent_type = 'coder', session_id = 's1' } = {}) {
  return runHook(
    H22_PATH,
    {
      hook_event_name: 'SubagentStart',
      session_id,
      transcript_path: join(dir, 't', 'no-such-parent-transcript.jsonl'),
      cwd: dir,
      agent_id,
      agent_type,
    },
    dir
  );
}

function subagentStop(dir, { agent_id = 'a1', agent_type = 'coder', session_id = 's1', last_assistant_message = 'done' } = {}) {
  return runHook(
    H22_PATH,
    { hook_event_name: 'SubagentStop', session_id, transcript_path: join(dir, 't', 'parent.jsonl'), cwd: dir, agent_id, agent_type, last_assistant_message },
    dir
  );
}

function readRegister(dir) {
  return JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), 'utf8'));
}

// writeRegister/h26Task/advisoryText/pathRe REMOVED — their only callers were
// the BACK-COMPAT/END-TO-END/POSTURE H26 assertions removed above (H26 is
// deleted under decision `sterling-claude-code-scale-down-boundary`,
// 2ad87dd1) — grep confirms zero remaining callers in this file.

function assertNeverDenies(r, label) {
  assert.notEqual(r.code, 2, `must never deny (exit 2) for ${label}; got ${r.code}, stderr: ${r.stderr}`);
}

// ===========================================================================
// SECTION 1 — CONTROL ARM, FIRST. A plain POSITIVE claim must still be
// registered as claimed territory AND still warn. This must pass for the
// OPPOSITE reason to every suppression assertion below: if the whole
// extraction path broke, this goes red and the silences below become
// meaningless.
// TODAY (pre-fix): GREEN for `files` and for the warning; RED only on
// `claimed_files` (the field does not exist yet).
// ===========================================================================

// NOTE: the downstream-warning half of this control (an H26 overlap check via
// h26Task) was REMOVED — h26-dispatch-overlap.mjs is deleted under decision
// `sterling-claude-code-scale-down-boundary` (2ad87dd1). The register-side
// assertions (files[]/claimed_files[] on a positive claim) are unrelated to
// H26 and stay as the control arm for the REGISTER corpus below.
test('H22 claimed-territory CONTROL: a positively-claimed path lands in BOTH files[] and claimed_files[]', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [['coder', 'Modify src/shared/util.mjs for the fix.']]);
    const s = subagentStart(dir, { agent_id: 'sub-1', agent_type: 'coder' });
    assert.equal(s.code, 0, `SubagentStart must exit 0; stderr: ${s.stderr}`);

    const entry = readRegister(dir).find((e) => e.agent_id === 'sub-1');
    assert.ok(entry, 'the entry was appended');
    assert.ok(entry.files.includes('src/shared/util.mjs'), `files must record the claim: ${JSON.stringify(entry.files)}`);
    assert.ok(Array.isArray(entry.claimed_files), 'claimed_files must be an array on every new entry');
    assert.ok(entry.claimed_files.includes('src/shared/util.mjs'), `claimed_files must record the claim: ${JSON.stringify(entry.claimed_files)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SECTION 2 — THE MEASURED CORPUS, at the REGISTER. Each case is
// self-controlling: the SAME brief names a genuinely-owned path (which must
// survive into claimed_files) and a prohibited path (which must not), so a
// green result can never be "the extractor found nothing".
// `files` must keep BOTH in every case — that breadth is what the review
// receipt, the residue probe and H10's deferral consume.
// TODAY (pre-fix): RED — claimed_files does not exist.
// SABOTAGE: `.filter((raw) => true || hasUnsuppressedMatch(…))` in
// scripts/hooks/h22-dispatch-register.mjs claimedFromBlocks -> every
// "must EXCLUDE" assertion here flips red; the "must KEEP" halves stay green.
// ===========================================================================

const CORPUS = [
  [
    'colon list ("DO NOT TOUCH: <path> (another lane owns it)")',
    'You own scripts/hooks/h17-bash-write-sweep.mjs. DO NOT TOUCH: scripts/lib/codex-mcp.mjs (another lane owns it).',
    'scripts/hooks/h17-bash-write-sweep.mjs',
    'scripts/lib/codex-mcp.mjs',
  ],
  [
    'inline prohibition ahead of the path, semicolon after it',
    'Do not touch scripts/hooks/h15-store-guard.mjs; implement the change in scripts/hooks/h22-dispatch-register.mjs instead.',
    'scripts/hooks/h22-dispatch-register.mjs',
    'scripts/hooks/h15-store-guard.mjs',
  ],
  [
    'em-dash header (the domain-doctor coder shape)',
    'Implement the guard in scripts/domain-doctor.mjs. DO NOT TOUCH — scripts/lib/codex-mcp.mjs (another lane owns it)',
    'scripts/domain-doctor.mjs',
    'scripts/lib/codex-mcp.mjs',
  ],
  [
    'CRLF colon-list form',
    'Fix scripts/hooks/h10-direct-capture.mjs as briefed. DO NOT TOUCH:\r\nscripts/lib/codex-mcp.mjs',
    'scripts/hooks/h10-direct-capture.mjs',
    'scripts/lib/codex-mcp.mjs',
  ],
  [
    "test-writer's frozen-path line (\"Don't edit …, it is frozen\")",
    "Author pins for scripts/hooks/h26-dispatch-overlap.mjs. Don't edit scripts/tests/h26-dispatch-overlap.test.mjs, it is frozen.",
    'scripts/hooks/h26-dispatch-overlap.mjs',
    'scripts/tests/h26-dispatch-overlap.test.mjs',
  ],
  [
    'multi-path prohibition list (a comma is deliberately NOT a clause boundary)',
    'Own packages/mcp-server/src/server.ts. Do not touch scripts/hooks/h15-store-guard.mjs, scripts/hooks/h17-bash-write-sweep.mjs, scripts/lib/codex-mcp.mjs.',
    'packages/mcp-server/src/server.ts',
    'scripts/lib/codex-mcp.mjs',
  ],
];

for (const [label, prompt, owned, prohibited] of CORPUS) {
  test(`H22 claimed-territory REGISTER [${label}]: the prohibited path stays in files[] but never enters claimed_files[]`, () => {
    const { dir, cleanup } = makeProject();
    try {
      writeTranscript(dir, [['coder', prompt]]);
      const s = subagentStart(dir, { agent_id: 'sub-c', agent_type: 'coder' });
      assertNeverDenies(s, label);
      assert.equal(s.code, 0, `SubagentStart must exit 0; stderr: ${s.stderr}`);

      const entry = readRegister(dir).find((e) => e.agent_id === 'sub-c');
      assert.ok(entry, 'the entry was appended');
      assert.equal(entry.attribution, 'block', 'a single type-matching block must attribute precisely');

      // files[] = TERRITORY EXAMINED — unchanged breadth, both paths present.
      assert.ok(entry.files.includes(owned), `files must keep the owned path: ${JSON.stringify(entry.files)}`);
      assert.ok(entry.files.includes(prohibited), `files must KEEP the prohibited path (receipts/residue/H10 depend on it): ${JSON.stringify(entry.files)}`);

      // claimed_files[] = TERRITORY CLAIMED — the prohibited path is gone.
      assert.ok(Array.isArray(entry.claimed_files), 'claimed_files must be an array');
      assert.ok(entry.claimed_files.includes(owned), `claimed_files must keep the owned path: ${JSON.stringify(entry.claimed_files)}`);
      assert.ok(!entry.claimed_files.includes(prohibited), `claimed_files must EXCLUDE the prohibited path: ${JSON.stringify(entry.claimed_files)}`);
    } finally {
      cleanup();
    }
  });
}

// ===========================================================================
// SECTION 3 (END-TO-END) and SECTION 4 (BACK-COMPAT) REMOVED — both were
// wholly about h26-dispatch-overlap.mjs's overlap-suppression behavior
// (invoked via h26Task), which is deleted under decision
// `sterling-claude-code-scale-down-boundary` (2ad87dd1); no H22-only
// assertion remained once the H26 invocation was stripped, so the tests were
// removed outright rather than trimmed.
// ===========================================================================
// SECTION 5 (RECEIPT SAFETY) REMOVED — asserted that a reviewer Stop promotes
// a .sterling/review-ledger.json receipt naming its examined territory. That
// whole promotion mechanism (promoteAtStop and its owner module
// scripts/hooks/lib/review-ledger-entry.mjs) was deleted under decision
// `sterling-claude-code-scale-down-boundary` (2ad87dd1) — h22-dispatch-
// register.mjs's SubagentStop no longer writes a ledger at all, so there is
// nothing left for this test to assert.
// ===========================================================================
// SECTION 6 — POSTURE INVARIANT. H22 is advisory: no input may make it deny a
// tool call. The H26 half of this posture check (an overlap probe via
// h26Task) was REMOVED — h26-dispatch-overlap.mjs is deleted under decision
// `sterling-claude-code-scale-down-boundary` (2ad87dd1).
// ===========================================================================

test('H22 claimed-territory POSTURE: SubagentStart never exits 2, including on an all-prohibition brief', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [['coder', 'DO NOT TOUCH: scripts/lib/codex-mcp.mjs, scripts/hooks/h15-store-guard.mjs']]);
    const s = subagentStart(dir, { agent_id: 'sub-p', agent_type: 'coder' });
    assertNeverDenies(s, 'all-prohibition brief at SubagentStart');

    const entry = readRegister(dir).find((e) => e.agent_id === 'sub-p');
    assert.deepEqual(entry.claimed_files, [], 'an all-prohibition brief claims nothing at all');
    assert.ok(entry.files.length >= 2, `files must still record what the brief examined: ${JSON.stringify(entry.files)}`);
  } finally {
    cleanup();
  }
});
