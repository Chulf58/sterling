// H23 output-axis delivery (board 5e3d6ff4). H19/H20 key delivery on file PATHS
// and dispatch PROMPTS respectively; neither ever looks at what a tool call
// actually RETURNED. H23 closes that gap: a PostToolUse hook on Read|Bash that
// matches the tool_response CONTENT — a log tail, a rendered artifact, a probe's
// stdout — against the store's governing anti_pattern/decision records under the
// same three-floor axis discipline H20 already proved (>=2 distinct axis-term
// hits, at least one discriminating, and record centrality: hasRecordCentralityHit
// over the record's own top-6 terms). H23 does not exist yet — every test below
// is RED because scripts/hooks/h23-output-axis.mjs is missing; that is correct
// per the dispatch brief. No implementation code is written here.
//
// Harness idiom mirrored from scripts/tests/h20-prior-answers.test.mjs (runHook/
// envelope/makeProject/spawnSync) and the pending-file idiom from
// scripts/tests/h19-delivery.test.mjs (pendingOf / guard-conductor.json path —
// H23 enqueues into the SAME pending.json h19-bash-delivery drains at the next
// UserPromptSubmit).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isListingCommand } from '../hooks/lib/listing-command.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-21T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h23-output-axis.mjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// 2026-09-19 step 2: transport changed from a delayed queue to this call's
// additionalContext.  All assertions below keep their matching/shape strength.
const directPayload = (result) => JSON.parse(result.stdout).hookSpecificOutput.additionalContext;

/** For the malformed-stdin case: stdin that is not JSON at all. */
function runRaw(raw, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h23-output-axis.mjs')], {
    input: raw,
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function envelope(type) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function antiPattern(title, trigger, extra = {}) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger,
    guidance: `${title} — guidance prose that must NEVER appear in a pointer line`,
    wrong_way: 'wrong way',
    right_way: 'right way text',
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: [],
    ...extra,
  };
}

function decisionRecord(title, statement, extra = {}) {
  return {
    ...envelope('decision'),
    title,
    statement,
    alternatives_rejected: [
      { option: 'a rival ballast configuration', reason: 'introduces resonance with the flywheel' },
    ],
    rationale: `${statement} — rationale prose that must NEVER appear in a pointer line`,
    file_keys: [],
    ...extra,
  };
}

function article(slug, paths, extra = {}) {
  return {
    ...envelope('feature_article'),
    slug,
    title: slug,
    what_it_does: `${slug} does the ${slug} thing`,
    intended_behavior: `${slug} intends`,
    files: paths.map((p) => ({ path: p, role: 'owner' })),
    current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [],
    live_test_refs: [],
    ...extra,
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h23-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const guardOf = (dir) => {
  const p = join(dir, '.sterling', 'transient', 'delivery', 's1', 'guard-conductor.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { records: [], frontier_files: [] };
};

const postRead = (dir, file, response, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, file) },
  tool_response: response,
  session_id: 's1',
  cwd: dir,
  ...extra,
});

const postBash = (dir, command, response, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: response,
  session_id: 's1',
  cwd: dir,
  ...extra,
});

// ---------------------------------------------------------------------------
// Domain vocabulary — the same proven floor-clearing idiom as
// scripts/tests/h20-centrality.test.mjs's CENTRAL_TITLE/CENTRAL_TRIGGER: six
// invented multi-word-flavoured nouns, each appearing 1x in the title and 2x
// in the trigger/statement (freq 3 total), so they deterministically dominate
// the record's own top-6 terms by raw frequency while every other content
// word appears once and cannot crowd in. A marker token (ALPHA/BETA/...) sits
// at position 0 of the title so identity survives any left-anchored clip.
// ---------------------------------------------------------------------------

const DOMAIN_TRIGGER =
  'breach countdown breach countdown widget flywheel widget flywheel ballast klaxon ballast klaxon ' +
  'recur constantly though this bug rarely touches a game field cell during setup work';

const DOMAIN_STATEMENT =
  'No surface may ever silence the breach countdown alarm: breach countdown widget flywheel widget flywheel ' +
  'ballast klaxon ballast klaxon must remain audible regardless of setup context.';

function markedAntiPattern(marker, extra = {}) {
  return antiPattern(`${marker} breach countdown widget flywheel ballast klaxon failure`, DOMAIN_TRIGGER, extra);
}

function markedDecision(marker, extra = {}) {
  return decisionRecord(`${marker} breach countdown widget flywheel ballast klaxon ruling`, DOMAIN_STATEMENT, extra);
}

// Content that shares 3 of the 6 dominant terms with any record built above —
// comfortably clears AXIS_MIN_HITS(2), hasDiscriminatingHit (none of these are
// generic dev vocabulary) and hasRecordCentralityHit (>=2 of the record's own
// top-6 terms appear here).
const CONTENT_SENTENCE =
  'The reactor log shows the breach alarm firing while the widget assembly and the flywheel governor both spike past nominal load.';

const UNRELATED_CONTENT =
  'The invoice export pipeline now writes a CSV header row before every batch of billing rows.';

// ---------------------------------------------------------------------------
// AC1 — Bash content match enqueues a pointer block, never stdout
// ---------------------------------------------------------------------------

test('AC1: Bash tool_response content matching an anti_pattern under the H20 three-floor axis discipline delivers a direct pointer block and always exits 0', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0, 'never blocks');
    const payload = directPayload(r); // 2026-09-19: direct PostToolUse transport.
    assert.match(payload, /output-axis/i, 'header names the output-axis seam');
    assert.match(payload, /H23/);
    assert.match(payload, new RegExp(`knowledge_get ${ap.id}`), 'the matched record is pointed at by id');
  } finally {
    cleanup();
  }
});

test('AC1: an object-shaped tool_response (e.g. a structured Bash result) is stringified before matching', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postBash(dir, 'run-probe.sh', { stdout: CONTENT_SENTENCE, stderr: '', exitCode: 0 }), dir);
    assert.equal(r.code, 0);
    const payload = directPayload(r); // 2026-09-19: direct PostToolUse transport.
    assert.match(payload, new RegExp(`knowledge_get ${ap.id}`), 'the object body was stringified and still matched');
  } finally {
    cleanup();
  }
});

// Decision `h23-kept-raised-threshold-one-pointer-payload` (foreign_284fc4b0, user-ruled
// 2026-08-31): "payload drops to ONE pointer plus the suppressed-count tail (was
// 3 + tail)" — the volume cut that keeps H23's unique output-axis coverage while
// removing the noise its ~6% follow rate paid for. Class ordering (hazards ahead
// of decisions) survived until 2026-09-29, when ruling
// h23-output-axis-hazards-only-skip-listings-advisory-label (5564361d v2) dropped
// decisions from this channel entirely: a matching decision now neither renders
// nor counts toward the tail. Two hazards plus one decision must therefore
// disclose "(+1 more matched)" — 1, not 2 — which is the control arm proving
// the decision was excluded rather than silently folded into the count.
test('AC1: only hazards occupy the single pointer line and the suppressed count, a matching decision is excluded from both, and no record body renders inline', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    store.create(markedAntiPattern('AP-BETA'));
    const dec = store.create(markedDecision('DEC-GAMMA'));
    const r = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    const payload = directPayload(r); // 2026-09-19: direct PostToolUse transport.

    const lines = payload.split('\n').filter((l) => l.includes('knowledge_get'));
    assert.equal(lines.length, 1, 'exactly one pointer line renders — OUTPUT_AXIS_POINTER_CAP is 1 per decision 284fc4b0'); // not-a-citation: fixture id

    assert.match(payload, /HAZARD anti_pattern '(AP-ALPHA|AP-BETA) /, 'a hazard occupies the one available pointer line');
    assert.ok(!payload.includes('DEC-GAMMA'), 'the decision renders no pointer of its own');
    assert.doesNotMatch(payload, new RegExp(`knowledge_get ${dec.id}`), 'the decision contributes no knowledge_get line');

    const remainder = payload.match(/\(\+(\d+) more matched\)/);
    assert.ok(remainder, 'the suppressed-count tail discloses what the cap withheld');
    assert.equal(remainder[1], '1', 'CONTROL: 2 hazards matched minus the 1 shown leaves exactly 1 suppressed — the matching decision is not counted');

    assert.doesNotMatch(payload, /guidance prose that must NEVER appear/, 'anti_pattern guidance never renders inline');
    assert.doesNotMatch(payload, /rationale prose that must NEVER appear/, 'decision rationale never renders inline');
    assert.doesNotMatch(payload, /No surface may ever silence/, 'the decision statement body never renders inline — pointer only');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// NARROWED 2026-09-29 (user ruling h23-output-axis-hazards-only-skip-listings-
// advisory-label, knowledge_get 5564361d v2): the notice is labelled ADVISORY
// (not an error), VCS/listing command output (first token git, ls, find, grep,
// rg) is skipped, and only anti_pattern records are pointed at.
// ---------------------------------------------------------------------------

test('narrowed: an anti_pattern match emits, and the header opens with "ADVISORY (not an error)"', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    const payload = directPayload(r);
    assert.match(payload, /^ADVISORY \(not an error\)/, 'the notice must never read as an error');
    assert.match(payload, new RegExp(`knowledge_get ${ap.id}`));
  } finally {
    cleanup();
  }
});

test('narrowed: a decision-only match is silent — H23 points at anti_pattern records only', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedDecision('DEC-GAMMA'));
    const r = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'a matching decision alone produces no additionalContext');
    // CONTROL: the same content DOES fire once a hazard is present, so the
    // silence above is the type filter, not content that never matches.
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const control = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE, { session_id: 's2' }), dir);
    assert.match(directPayload(control), new RegExp(`knowledge_get ${ap.id}`));
  } finally {
    cleanup();
  }
});

test('narrowed: `git status --short` output containing store terms is silent', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postBash(dir, 'git status --short', ` M ${CONTENT_SENTENCE}`), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'VCS output is skipped whatever it contains');
    // CONTROL: the same session, same content via a non-listing command fires —
    // proving the silence above is the command-class skip, not dedup or a miss.
    const control = runHook(postBash(dir, 'cat run.log', ` M ${CONTENT_SENTENCE}`), dir);
    assert.match(directPayload(control), new RegExp(`knowledge_get ${ap.id}`));
  } finally {
    cleanup();
  }
});

test('narrowed: `cd x && git log` is silent — a cd prefix does not hide the listing command', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postBash(dir, 'cd x && git log', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    const control = runHook(postBash(dir, 'cd x && cat run.log', CONTENT_SENTENCE), dir);
    assert.match(directPayload(control), new RegExp(`knowledge_get ${ap.id}`), 'control: a cd prefix before a non-listing command still fires');
  } finally {
    cleanup();
  }
});

test('narrowed: every listing command class is skipped through env, sudo and cd prefixes; a listing tool later in a pipe is not', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const skipped = [
      'ls -la',
      'find . -name "*.log"',
      'grep -rn breach .',
      'rg breach',
      '/usr/bin/git log --oneline',
      'GIT_PAGER=cat git log',
      'sudo git status',
      'FOO=1 sudo ls -la logs',
      'cd "a b" && cd c; rg flywheel',
    ];
    for (const command of skipped) {
      const r = runHook(postBash(dir, command, CONTENT_SENTENCE), dir);
      assert.equal(r.code, 0, command);
      assert.equal(r.stdout, '', `${command} must be skipped`);
    }
    for (const [i, command] of ['cat run.log | grep breach', 'gitleaks detect', 'node find-probe.mjs'].entries()) {
      const r = runHook(postBash(dir, command, CONTENT_SENTENCE, { session_id: `fires-${i}` }), dir);
      assert.match(directPayload(r), new RegExp(`knowledge_get ${ap.id}`), `${command} is not a listing command and must still fire`);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC2 — Read of a GOVERNED file stays silent on this axis
// ---------------------------------------------------------------------------

test('AC2: Read of a file with an owning feature_article stays silent on the output axis, even when the content matches a governing record', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.log']));
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postRead(dir, 'src/a.log', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', '2026-09-19: governed territory produces no direct additionalContext');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC3 — Read of an UNOWNED file with matching content enqueues
// ---------------------------------------------------------------------------

test('AC3: Read of a file with no owning article, whose content matches a governing anti_pattern, delivers the pointer block directly', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postRead(dir, 'logs/probe.txt', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    const payload = directPayload(r); // 2026-09-19: direct PostToolUse transport.
    assert.match(payload, new RegExp(`knowledge_get ${ap.id}`));
  } finally {
    cleanup();
  }
});

test('an over-long [a-z0-9_] token in the output is skipped, never a rank_terms validation failure', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const longToken = 'a1_'.repeat(34).slice(0, 100);
    assert.equal(longToken.length, 100);
    const r = runHook(postRead(dir, 'logs/probe.txt', `${CONTENT_SENTENCE} ${longToken}`), dir);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout + r.stderr, /delivery failed/, 'the long token must not reach the rank_terms validator');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4 — the silence floor
// ---------------------------------------------------------------------------

test('AC4: unrelated vocabulary in the tool_response delivers nothing', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postBash(dir, 'cat run.log', UNRELATED_CONTENT), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', '2026-09-19: no direct additionalContext for an unrelated result');
  } finally {
    cleanup();
  }
});

test('AC4: malformed (non-JSON) stdin is a visible non-blocking internal failure', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runRaw('{not json at all', dir);
    assert.equal(r.code, 1, 'malformed stdin is a visible non-blocking internal failure');
    assert.match(r.stderr, /H23: output-axis delivery failed:/, 'H23 internal failure is visible, never silently swallowed');
  } finally {
    cleanup();
  }
});

test('AC4: a missing tool_response field never crashes or delivers context', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat run.log' }, cwd: dir }, dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', '2026-09-19: missing content produces no direct additionalContext');
  } finally {
    cleanup();
  }
});

test('AC4: a tool name other than Read or Bash is ignored — exit 0, no direct context', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(
      { hook_event_name: 'PostToolUse', tool_name: 'Glob', tool_input: { pattern: '**/*.log' }, tool_response: CONTENT_SENTENCE, cwd: dir },
      dir
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', '2026-09-19: ignored tools produce no direct additionalContext');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC5 — guard dedup, in H23's OWN namespace
// ---------------------------------------------------------------------------

test('AC5: the same record match on a second event does not re-deliver', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const first = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(first.code, 0);
    assert.match(directPayload(first), /knowledge_get/, '2026-09-19: first touch delivers direct additionalContext');
    const second = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '', '2026-09-19: second touch is silent — no re-delivery');
  } finally {
    cleanup();
  }
});

test('AC5: H23\'s own dedup namespace leaves the substance-delivery guard ledger untouched — H23 must not consume H19\'s eligibility', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const first = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir); // dedup should suppress this one
    assert.match(directPayload(first), /knowledge_get/, '2026-09-19: the original delivery is direct additionalContext');
    const guard = guardOf(dir);
    assert.ok(!(guard.records ?? []).includes(ap.id), "H23's dedup key must be a SEPARATE namespace from H19's substance ledger (guard.records)");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC6 — subagent silence
// ---------------------------------------------------------------------------

test('AC6: an event carrying a subagent session marker delivers directly to that child context', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE, { agent_id: 'coder-1' }), dir);
    assert.equal(r.code, 0);
    // 2026-09-19 step 2: child delivery is direct, never routed to conductor.
    assert.match(directPayload(r), /knowledge_get/, 'the child receives the pointer on its own PostToolUse');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC7 — cap
// ---------------------------------------------------------------------------

// Decision `h23-kept-raised-threshold-one-pointer-payload` (foreign_284fc4b0, user-ruled
// 2026-08-31) supersedes the 3-line cap: the payload is ONE pointer plus the
// suppressed-count tail. The remainder is therefore matched-minus-one, and the
// tail is the only thing standing between a volume cut and silent knowledge loss
// — a cap that drops records without disclosing the count is the failure mode
// this assertion exists to catch.
test('AC7: more than 1 matching record caps the pointer block at 1 line and discloses the full suppressed remainder', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    store.create(markedAntiPattern('AP-BETA'));
    store.create(markedAntiPattern('AP-GAMMA'));
    store.create(markedAntiPattern('AP-DELTA'));
    const r = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    const payload = directPayload(r); // 2026-09-19: direct PostToolUse transport.
    const lines = payload.split('\n').filter((l) => l.includes('knowledge_get'));
    assert.equal(lines.length, 1, 'at most 1 pointer line renders — OUTPUT_AXIS_POINTER_CAP is 1 per decision 284fc4b0'); // not-a-citation: fixture id
    const remainderMatch = payload.match(/\(\+(\d+) more matched\)/);
    assert.ok(remainderMatch, 'a remainder disclosure names how many more matched');
    assert.equal(remainderMatch[1], '3', '4 matched minus the 1 shown leaves exactly 3 suppressed records disclosed as the remainder');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC8 — clip: large content, matched only within the first 16,000 chars
// ---------------------------------------------------------------------------

test('AC8: a >64KB tool_response with matching vocabulary inside the first 16,000 chars matches without crashing', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const huge = `${CONTENT_SENTENCE} ${'noise '.repeat(12_000)}`; // domain words at offset 0; total > 64KB
    assert.ok(huge.length > 64 * 1024, 'fixture really is > 64KB');
    const r = runHook(postBash(dir, 'cat huge.log', huge), dir);
    assert.equal(r.code, 0, 'a large tool_response must never crash the hook');
    const payload = directPayload(r); // 2026-09-19: direct PostToolUse transport.
    assert.match(payload, new RegExp(`knowledge_get ${ap.id}`), 'the match inside the first 16,000 chars still fires');
  } finally {
    cleanup();
  }
});

test('narrowed: a compound command is skipped only when EVERY segment is a listing program (unit)', () => {
  const skipped = [
    'git status | grep foo',
    'cd a && git log',
    'git log && git diff',
    'ls -la; ls src',
    'grep -rl x . | rg y',
    'git log 2>&1',
    'find . -name "*.log" -print',
    'git.exe status',
    'C:\\Git\\bin\\git.exe log',
    '"C:\\Program Files\\Git\\bin\\git.exe" log',
    'LS',
    'Git Status',
    '& git status',
    "& 'C:\\Git\\bin\\git.exe' log",
  ];
  for (const command of skipped) assert.equal(isListingCommand(command), true, `${command} must be skipped`);
  const fires = [
    'git log && cat secret.md',
    'ls; cat notes.txt',
    'grep -rl x | xargs cat',
    'find . -exec cat {} \\;',
    'find . -execdir cat {} +',
    'ls || cat notes.txt',
    'ls\ncat notes.txt',
    'ls & cat notes.txt',
    'cd a; cat notes.txt',
    'cd a',
    'cat run.log | grep breach',
    'grep -rl x . | sort',
    'grep "a;b" f',
    'gitleaks detect',
    'node find-probe.mjs',
    'git.bat status',
    '',
  ];
  for (const command of fires) assert.equal(isListingCommand(command), false, `${JSON.stringify(command)} must NOT be skipped`);
  assert.equal(isListingCommand(undefined), false);
});

test('narrowed: a compound with a non-listing segment still fires end to end', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    for (const [i, command] of ['git log && cat secret.md', 'ls; cat notes.txt', 'grep -rl x | xargs cat', 'find . -exec cat {} \\;'].entries()) {
      const r = runHook(postBash(dir, command, CONTENT_SENTENCE, { session_id: `compound-${i}` }), dir);
      assert.match(directPayload(r), new RegExp(`knowledge_get ${ap.id}`), `${command} must fire`);
    }
  } finally {
    cleanup();
  }
});

test('narrowed: PowerShell `git status` output containing store terms is silent, and Get-Content still fires', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(
      { hook_event_name: 'PostToolUse', tool_name: 'PowerShell', tool_input: { command: 'git status' }, tool_response: CONTENT_SENTENCE, cwd: dir },
      dir
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'the command-class skip applies to PowerShell exactly as to Bash');
    const control = runHook(
      { hook_event_name: 'PostToolUse', tool_name: 'PowerShell', tool_input: { command: 'Get-Content run.log' }, tool_response: CONTENT_SENTENCE, cwd: dir },
      dir
    );
    assert.match(directPayload(control), new RegExp(`knowledge_get ${ap.id}`), 'control: a non-listing PowerShell command still fires');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Review-mandated additions (2026-08-21 correctness review of commit 4d854b6):
// PowerShell parity, the .sterling/ self-reference exclusion, the two ownership
// edge cases the gate predicate turns on, and the same-event concurrency pin
// for the withFileLock fix in lib/delivery.mjs.
// ---------------------------------------------------------------------------

test('review (a): PowerShell tool_response content delivers directly exactly like Bash', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(
      { hook_event_name: 'PostToolUse', tool_name: 'PowerShell', tool_input: { command: 'Get-Content run.log' }, tool_response: CONTENT_SENTENCE, cwd: dir },
      dir
    );
    assert.equal(r.code, 0);
    const payload = directPayload(r); // 2026-09-19: direct PostToolUse transport.
    assert.match(payload, new RegExp(`knowledge_get ${ap.id}`), 'PowerShell is a first-class seam, same as Bash');
  } finally {
    cleanup();
  }
});

test('review (b): Read of a path under .sterling/ delivers nothing — the store tree is the highest-false-positive, self-referential input', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postRead(dir, '.sterling/config.json', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', '2026-09-19: reading .sterling never produces direct additionalContext');
  } finally {
    cleanup();
  }
});

test('review (c): a file owned ONLY by a working_tree-scoped article still delivers — working-tree owners do not gate, matching H19', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('tree-scoped', ['logs/probe.txt'], { working_tree: 'detached-copy' }));
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postRead(dir, 'logs/probe.txt', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    const payload = directPayload(r); // 2026-09-19: direct PostToolUse transport.
    assert.match(payload, new RegExp(`knowledge_get ${ap.id}`), 'a working_tree-scoped owner means H19 delivers no substance here, so H23 must fire');
  } finally {
    cleanup();
  }
});

test('review (d): a file owned by a repo-located reference_material delivers nothing — the ownership predicate matches H19 exactly', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create({
      ...envelope('reference_material'),
      title: 'probe rendering reference',
      kind: 'doc',
      location: 'docs/probe-ref.md',
      summary: 'reference summary',
      source_date: '2026-08-01',
      capture_date: '2026-08-02',
    });
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postRead(dir, 'docs/probe-ref.md', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', '2026-09-19: a repo-located reference doc produces no direct additionalContext');
  } finally {
    cleanup();
  }
});

test('AC8: vocabulary appearing only AFTER the first 16,000 chars is never matched — the clip boundary is real, not a suggestion', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const padding = 'noise '.repeat(3_000); // 18,000 chars — past the 16,000-char clip boundary
    const huge = `${padding}${CONTENT_SENTENCE}${'noise '.repeat(8_000)}`;
    assert.ok(padding.length > 16_000, 'the domain sentence genuinely starts past the clip boundary');
    assert.ok(huge.length > 64 * 1024, 'fixture really is > 64KB');
    const r = runHook(postBash(dir, 'cat huge.log', huge), dir);
    assert.equal(r.code, 0, 'never crashes even when nothing matches');
    assert.equal(r.stdout, '', '2026-09-19: vocabulary past the clip produces no direct additionalContext');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4b rendering marker (c): the "[authority]" marker exists only on decisions,
// and since ruling h23-output-axis-hazards-only-skip-listings-advisory-label
// (5564361d v2) H23 renders no decision line at all — so a decision carrying
// authority stays silent here, and the surviving hazard line carries no marker.
// ---------------------------------------------------------------------------

test('S4b (c): a decision with authority renders no H23 pointer line — the marker has no output-axis surface any more', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedDecision('DEC-GAMMA', { authority: 'one_off' }));
    const r = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'a matching decision, with or without authority, renders nothing on H23');
  } finally {
    cleanup();
  }
});

test('S4b (c): an H23 hazard pointer line carries no bracketed authority marker', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    const payload = directPayload(r); // 2026-09-19: direct PostToolUse transport.
    const line = payload.split('\n').find((l) => l.includes(`knowledge_get ${ap.id}`));
    assert.ok(line, 'the hazard pointer line renders');
    assert.doesNotMatch(line, /\[(standing|session_scoped|one_off)\]/, 'no bracketed authority marker on a hazard line');
  } finally {
    cleanup();
  }
});

test('self-root (Dome Farmer 454): a file owned by an article whose working_tree IS the project root gates H23 like a root owner — H19 delivers it, so no second block', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-SELF'));
    // CONTROL: the same read of an UNOWNED path fires the hazard, so the
    // silence asserted below is the owner gate and not a hazard that never matches.
    const control = runHook(postRead(dir, 'logs/unowned.txt', CONTENT_SENTENCE), dir);
    assert.equal(control.code, 0);
    assert.match(directPayload(control), new RegExp(`knowledge_get ${ap.id}`), 'control: with no owner the hazard fires');
    store.create(article('self-rooted', ['logs/probe.txt'], { working_tree: `${dir}/` }));
    const r = runHook(postRead(dir, 'logs/probe.txt', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'a self-rooted owner suppresses the output axis exactly as a root owner does');
  } finally {
    cleanup();
  }
});
