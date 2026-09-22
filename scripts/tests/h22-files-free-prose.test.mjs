// H22 `files` — FREE-PROSE EXTRACTION ONLY (fix round after Sol review
// REQUEST_CHANGES on the H22 dispatch-register slim-down, board d7a509d9).
//
// COVERAGE GAP THIS FILE CLOSES: deleting scripts/tests/h22-claimed-
// territory.test.mjs (and Group D of dispatch-advisory-trailing-
// prohibition.test.mjs) removed every assertion that `files` — territory
// EXAMINED, the field H10's deferral and residue readers actually consume —
// keeps a prohibited/context-only path mention rather than filtering it (that
// filtering was `claimed_files`'s job, and `claimed_files` is deleted: no
// non-test reader ever consumed it, research_finding h22-dispatch-register-
// consumer-map-which-parts-have-a-reader-september-2026). Nothing also
// verified that a REVIEW-TERRITORY-shaped line, now unparsed, still
// contributes its path through plain free-prose extraction alongside the
// surrounding prose, with `files_source: 'free-prose-fallback'` rather than
// the deleted 'review-territory' provenance.
//
// Harness mirrors the now-deleted scripts/tests/h22-claimed-territory.test.mjs
// (real PreToolUse Task events, then a real SubagentStart, reading the
// register file directly) — reused, not modified (that file no longer
// exists; this is the same pattern, not an import).
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

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [H22_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-freeprose-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [] }));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

let toolUseSeq = 0;
function stagePre(dir, prompt, subagent_type = 'coder') {
  const r = runHook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: `toolu_fp_${(toolUseSeq += 1)}`,
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

function subagentStart(dir, { agent_id = 'a1', agent_type = 'coder', session_id = 's1' } = {}) {
  return runHook(
    {
      hook_event_name: 'SubagentStart',
      session_id,
      // Points at a file that does not exist: under the state-machine
      // resolver the parent transcript is never read at Start, so a
      // surviving transcript reader would fail loudly here instead of
      // passing by accident.
      transcript_path: join(dir, 't', 'no-such-parent-transcript.jsonl'),
      cwd: dir,
      agent_id,
      agent_type,
    },
    dir
  );
}

function readRegister(dir) {
  return JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), 'utf8'));
}

function entryFor(dir, agentId) {
  const reg = readRegister(dir);
  const entry = reg.find((e) => e.agent_id === agentId);
  assert.ok(entry, `entry for ${agentId} was appended to the register`);
  return entry;
}

// ===========================================================================
// (a) BREADTH: a prohibited / context-only path mention stays IN `files` —
// there is no write-side negation guard any more (claimed_files is deleted),
// so `files` is exactly every path-shaped candidate the free-prose extractor
// finds, prohibition or not. This is the breadth H10's deferral and the
// residue probe rely on (research_finding foreign_289cd172).
// ===========================================================================

test('(a) a prohibited path mention and an owned path mention BOTH land in files — no negation guard survives the write side', () => {
  const { dir, cleanup } = makeProject();
  try {
    stagePre(dir, 'Own scripts/hooks/h17-bash-write-sweep.mjs. DO NOT TOUCH: scripts/lib/codex-mcp.mjs (another lane owns it).');
    const s = subagentStart(dir, { agent_id: 'sub-a' });
    assert.equal(s.code, 0, `SubagentStart must exit 0; stderr: ${s.stderr}`);

    const entry = entryFor(dir, 'sub-a');
    assert.equal(entry.attribution, 'block', 'a single type-matching block attributes precisely');
    assert.deepEqual(
      [...entry.files].sort(),
      ['scripts/hooks/h17-bash-write-sweep.mjs', 'scripts/lib/codex-mcp.mjs'],
      'files is the full free-prose extraction — the prohibited path is never filtered out'
    );
    assert.equal(entry.claimed_files, undefined, 'claimed_files is not written at all any more');
    assert.equal(entry.claimed_glob_prefixes, undefined, 'claimed_glob_prefixes is not written at all any more');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (b) A REVIEW-TERRITORY-shaped line is no longer parsed as a structured
// declaration — it is scanned by the SAME bare free-prose extractor as the
// rest of the prompt, so the path INSIDE the marker's JSON array and a path
// mentioned elsewhere in the prose both land in `files` (a union), and
// files_source is always 'free-prose-fallback' now that the
// 'review-territory' provenance value is never produced.
// ===========================================================================

test('(b) a REVIEW-TERRITORY-shaped line contributes its path via bare free-prose extraction, unioned with surrounding prose — files_source stays free-prose-fallback', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = [
      'Please review the diff for correctness.',
      'REVIEW-TERRITORY: ["scripts/target-a.mjs"]',
      'FYI scripts/decoy-analysis.mjs was mentioned in an earlier, unrelated message.',
    ].join('\n');
    stagePre(dir, prompt);
    const s = subagentStart(dir, { agent_id: 'sub-b' });
    assert.equal(s.code, 0, `SubagentStart must exit 0; stderr: ${s.stderr}`);

    const entry = entryFor(dir, 'sub-b');
    assert.equal(entry.attribution, 'block');
    assert.deepEqual(
      [...entry.files].sort(),
      ['scripts/decoy-analysis.mjs', 'scripts/target-a.mjs'],
      'no REVIEW-TERRITORY precedence exists any more — the marker-carried path and the surrounding prose path both survive as an ordinary free-prose union'
    );
    assert.equal(entry.files_source, 'free-prose-fallback', "'review-territory' is never produced — parseReviewTerritory is deleted");
    assert.doesNotMatch(s.stderr, /REVIEW-TERRITORY/, 'no territory_declaration_malformed/missing disclosure fires any more — that advisory is deleted with the parser');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (c) UNATTRIBUTABLE: a Start with no resolvable dispatch-state slot at all
// (no prior Pre for this agent) writes files: [] and files_source:
// 'unattributable' — the fail-closed value when positional attribution
// cannot be proven safe.
// ===========================================================================

test("(c) an unattributable Start (no prior Pre registration) writes files: [] and files_source: 'unattributable'", () => {
  const { dir, cleanup } = makeProject();
  try {
    const s = subagentStart(dir, { agent_id: 'sub-c' });
    assert.equal(s.code, 0, `SubagentStart must exit 0; stderr: ${s.stderr}`);

    const entry = entryFor(dir, 'sub-c');
    assert.deepEqual(entry.files, []);
    assert.equal(entry.files_source, 'unattributable');
    assert.equal(entry.attribution, 'none');
  } finally {
    cleanup();
  }
});
