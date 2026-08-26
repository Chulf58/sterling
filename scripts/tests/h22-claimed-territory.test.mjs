// H22 CLAIMED-TERRITORY (write-side negation guard) — board c56862a9,
// research_finding 289cd172 v2 (h26-registers-do-not-touch-paths-as-held-territory).
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
const H26_PATH = join(HOOKS, 'h26-dispatch-overlap.mjs');

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

// One dispatching assistant message carrying one Task block per [type, prompt].
function writeTranscript(dir, blocks) {
  const p = join(dir, 't', 'parent.jsonl');
  mkdirSync(dirname(p), { recursive: true });
  const line = {
    type: 'assistant',
    message: {
      content: blocks.map(([subagent_type, prompt]) => ({
        type: 'tool_use',
        name: 'Task',
        input: { subagent_type, prompt },
      })),
    },
  };
  writeFileSync(p, JSON.stringify(line) + '\n');
}

function subagentStart(dir, { agent_id = 'a1', agent_type = 'coder', session_id = 's1' } = {}) {
  return runHook(
    H22_PATH,
    { hook_event_name: 'SubagentStart', session_id, transcript_path: join(dir, 't', 'parent.jsonl'), cwd: dir, agent_id, agent_type },
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

function writeRegister(dir, entries) {
  writeFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), JSON.stringify(entries));
}

function h26Task(dir, { subagent_type = 'coder', prompt, session_id = 's1' }) {
  return runHook(
    H26_PATH,
    { hook_event_name: 'PreToolUse', tool_name: 'Task', session_id, cwd: dir, tool_input: { subagent_type, prompt } },
    dir
  );
}

function advisoryText(r) {
  if (!r.stdout || !r.stdout.trim()) return '';
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    assert.fail(`stdout was not valid JSON: ${JSON.stringify(r.stdout)}`);
  }
  return parsed?.hookSpecificOutput?.additionalContext ?? '';
}

function pathRe(p) {
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc.replace(/\//g, '\\/'), 'i');
}

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

test('H22 claimed-territory CONTROL: a positively-claimed path lands in BOTH files[] and claimed_files[], and still warns downstream', () => {
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

    const w = h26Task(dir, { subagent_type: 'coder', prompt: 'please modify src/shared/util.mjs today' });
    assertNeverDenies(w, 'control overlap');
    assert.match(advisoryText(w), pathRe('src/shared/util.mjs'), 'a genuine overlap must still warn');
    assert.ok(advisoryText(w).includes('coder:sub-1'), `advisory must name the live dispatch; got: ${advisoryText(w)}`);
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
// SECTION 3 — END TO END: the false positive itself. A later dispatch that
// LEGITIMATELY owns a path an earlier brief forbade must not be warned off it,
// while a genuine overlap on the earlier brief's OWN territory must still fire
// in the very same fixture (the paired control).
// TODAY (pre-fix): the first half is RED (the warning fires), the second GREEN.
// SABOTAGE: either the h22 filter above, or `const entryFiles = e.files;` in
// scripts/hooks/h26-dispatch-overlap.mjs -> the first half flips red.
// ===========================================================================

test('H22/H26 claimed-territory END-TO-END: a later dispatch legitimately owning a forbidden-in-another-brief path is NOT warned, while a real overlap still warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [
      ['coder', 'You own scripts/hooks/h17-bash-write-sweep.mjs. DO NOT TOUCH: scripts/lib/codex-mcp.mjs (another lane owns it).'],
    ]);
    subagentStart(dir, { agent_id: 'sub-live', agent_type: 'coder' });

    // (a) THE FALSE POSITIVE: the legitimate owner of the forbidden path.
    const quiet = h26Task(dir, { subagent_type: 'coder', prompt: 'You now own scripts/lib/codex-mcp.mjs; implement the change there.' });
    assertNeverDenies(quiet, 'legitimate owner of a path another brief forbade');
    assert.equal(quiet.code, 0, `must exit 0; stderr: ${quiet.stderr}`);
    assert.equal(
      advisoryText(quiet),
      '',
      `a path the live dispatch was told NOT to touch is not its lane — no advisory expected; got: ${advisoryText(quiet)}`
    );

    // (b) PAIRED CONTROL, same fixture: the live dispatch's REAL territory.
    const loud = h26Task(dir, { subagent_type: 'coder', prompt: 'Please also edit scripts/hooks/h17-bash-write-sweep.mjs in this lane.' });
    assert.match(advisoryText(loud), pathRe('scripts/hooks/h17-bash-write-sweep.mjs'), 'a genuine overlap must still warn');
    assert.ok(advisoryText(loud).includes('coder:sub-live'), `advisory must name the live dispatch; got: ${advisoryText(loud)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SECTION 4 — BACK-COMPAT. A register entry written before claimed_files
// existed (H1 wipes the register each SessionStart, but a mid-session bundle
// swap can leave one) has no claimed_files and must fall back to files —
// today's behavior exactly, never a silently empty lane.
// TODAY (pre-fix): GREEN (regression net).
// SABOTAGE: `const entryFiles = e.claimed_files ?? [];` in
// scripts/hooks/h26-dispatch-overlap.mjs -> red here (and in ~10 pre-existing
// H26 tests, which is the layer that actually carries this verdict).
// ===========================================================================

test('H26 claimed-territory BACK-COMPAT: a legacy entry with no claimed_files falls back to files[] and still warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [
      {
        agent_id: 'legacy-1',
        agent_type: 'coder',
        session_id: 's1',
        files: ['src/legacy.mjs'],
        at: new Date().toISOString(),
        attribution: 'block',
      },
    ]);
    const w = h26Task(dir, { subagent_type: 'coder', prompt: 'please modify src/legacy.mjs' });
    assertNeverDenies(w, 'legacy entry');
    assert.match(advisoryText(w), pathRe('src/legacy.mjs'), 'a legacy entry must keep warning exactly as before the field existed');
    assert.ok(advisoryText(w).includes('coder:legacy-1'), `advisory must name the legacy dispatch; got: ${advisoryText(w)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SECTION 5 — THE DANGER CASE the field split exists to prevent
// (research_finding 289cd172: "the cheap fix is dangerous"). A reviewer brief
// that names its subject ONLY inside a prohibition must still promote a review
// receipt that NAMES that territory: scripts/commit-reviewed.mjs treats an
// EMPTY files[] as the STRONGEST form of unverifiable territory, so filtering
// `files` in place would silently degrade merge-gate review evidence.
// TODAY (pre-fix): GREEN (regression net) — it is the pin that must stay green
// while Sections 2/3 turn green.
// SABOTAGE: write `files: claimedFiles` on the entry in
// scripts/hooks/h22-dispatch-register.mjs -> RED here while Sections 2 and 3
// stay green. That asymmetry IS the reason for two fields.
// ===========================================================================

test('H22 claimed-territory RECEIPT SAFETY: a reviewer brief naming its subject only inside a prohibition still promotes a receipt naming that territory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [['reviewer-correctness', 'Review the auth change. Do not modify src/auth.mjs — you are read-only.']]);
    subagentStart(dir, { agent_id: 'rev-1', agent_type: 'reviewer-correctness' });

    const entry = readRegister(dir).find((e) => e.agent_id === 'rev-1');
    assert.ok(entry, 'the reviewer entry was appended');
    assert.ok(entry.files.includes('src/auth.mjs'), `files must record examined territory: ${JSON.stringify(entry.files)}`);
    assert.deepEqual(entry.claimed_files, [], `a read-only brief claims no write territory: ${JSON.stringify(entry.claimed_files)}`);

    const stopped = subagentStop(dir, { agent_id: 'rev-1', agent_type: 'reviewer-correctness', last_assistant_message: 'review complete' });
    assertNeverDenies(stopped, 'reviewer stop');
    assert.equal(stopped.code, 0, `SubagentStop must exit 0; stderr: ${stopped.stderr}`);

    const ledger = JSON.parse(readFileSync(join(dir, '.sterling', 'review-ledger.json'), 'utf8'));
    assert.equal(ledger.length, 1, 'exactly one receipt was promoted');
    assert.ok(
      ledger[0].files.includes('src/auth.mjs'),
      `the promoted receipt must NAME the reviewed territory — an empty files[] is the strongest unverifiable-territory signal at commit-reviewed.mjs:428-436; got: ${JSON.stringify(ledger[0])}`
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SECTION 6 — POSTURE INVARIANT. Both hooks are advisory: no input may make
// either deny a tool call.
// ===========================================================================

test('H22/H26 claimed-territory POSTURE: neither hook ever exits 2, including on an all-prohibition brief', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [['coder', 'DO NOT TOUCH: scripts/lib/codex-mcp.mjs, scripts/hooks/h15-store-guard.mjs']]);
    const s = subagentStart(dir, { agent_id: 'sub-p', agent_type: 'coder' });
    assertNeverDenies(s, 'all-prohibition brief at SubagentStart');

    const entry = readRegister(dir).find((e) => e.agent_id === 'sub-p');
    assert.deepEqual(entry.claimed_files, [], 'an all-prohibition brief claims nothing at all');
    assert.ok(entry.files.length >= 2, `files must still record what the brief examined: ${JSON.stringify(entry.files)}`);

    const w = h26Task(dir, { subagent_type: 'coder', prompt: 'edit scripts/lib/codex-mcp.mjs now' });
    assertNeverDenies(w, 'overlap check against an all-prohibition entry');
    assert.equal(w.code, 0, `must exit 0; stderr: ${w.stderr}`);
  } finally {
    cleanup();
  }
});
