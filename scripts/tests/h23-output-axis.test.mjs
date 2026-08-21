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

const pendingOf = (dir) => {
  const p = join(dir, '.sterling', 'transient', 'delivery', 'pending.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};

const guardOf = (dir) => {
  const p = join(dir, '.sterling', 'transient', 'delivery', 'guard-conductor.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { records: [], frontier_files: [] };
};

const postRead = (dir, file, response, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, file) },
  tool_response: response,
  cwd: dir,
  ...extra,
});

const postBash = (dir, command, response, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: response,
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

test('AC1: Bash tool_response content matching an anti_pattern under the H20 three-floor axis discipline enqueues a pointer block, never stdout, and always exits 0', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0, 'never blocks');
    assert.equal(r.stdout, '', 'no direct stdout injection — pointer goes to the pending queue only');
    const pending = pendingOf(dir);
    assert.equal(pending.length, 1, 'the pointer block was enqueued');
    assert.match(pending[0].payload, /output-axis/i, 'header names the output-axis seam');
    assert.match(pending[0].payload, /H23/);
    assert.match(pending[0].payload, new RegExp(`knowledge_get ${ap.id}`), 'the matched record is pointed at by id');
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
    const pending = pendingOf(dir);
    assert.equal(pending.length, 1, 'the object body was stringified and still matched');
    assert.match(pending[0].payload, new RegExp(`knowledge_get ${ap.id}`));
  } finally {
    cleanup();
  }
});

test('AC1: hazards render before decisions, one pointer line per record, and the record body never renders inline', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const dec = store.create(markedDecision('DEC-GAMMA'));
    const r = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    const payload = pendingOf(dir)[0].payload;

    const hazardIdx = payload.indexOf('AP-ALPHA');
    const decisionIdx = payload.indexOf('DEC-GAMMA');
    assert.ok(hazardIdx >= 0, 'the hazard pointer is present');
    assert.ok(decisionIdx >= 0, 'the decision pointer is present');
    assert.ok(hazardIdx < decisionIdx, 'hazards lead, decisions follow');

    assert.match(payload, new RegExp(`knowledge_get ${ap.id}`));
    assert.match(payload, new RegExp(`knowledge_get ${dec.id}`));

    const lines = payload.split('\n').filter((l) => l.includes('knowledge_get'));
    assert.equal(lines.length, 2, 'exactly one pointer line per matched record');

    assert.doesNotMatch(payload, /guidance prose that must NEVER appear/, 'anti_pattern guidance never renders inline');
    assert.doesNotMatch(payload, /rationale prose that must NEVER appear/, 'decision rationale never renders inline');
    assert.doesNotMatch(payload, /No surface may ever silence/, 'the decision statement body never renders inline — pointer only');
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
    assert.equal(pendingOf(dir).length, 0, 'governed territory is H19\'s job — H23 exists for ungoverned consumption only');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC3 — Read of an UNOWNED file with matching content enqueues
// ---------------------------------------------------------------------------

test('AC3: Read of a file with no owning article, whose content matches a governing decision, enqueues the pointer block', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const dec = store.create(markedDecision('DEC-GAMMA'));
    const r = runHook(postRead(dir, 'logs/probe.txt', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    const pending = pendingOf(dir);
    assert.equal(pending.length, 1);
    assert.match(pending[0].payload, new RegExp(`knowledge_get ${dec.id}`));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4 — the silence floor
// ---------------------------------------------------------------------------

test('AC4: unrelated vocabulary in the tool_response enqueues nothing', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postBash(dir, 'cat run.log', UNRELATED_CONTENT), dir);
    assert.equal(r.code, 0);
    assert.equal(pendingOf(dir).length, 0);
  } finally {
    cleanup();
  }
});

test('AC4: malformed (non-JSON) stdin never crashes — exit 0, nothing enqueued', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runRaw('{not json at all', dir);
    assert.equal(r.code, 0, 'malformed stdin must never crash the hook');
    assert.equal(pendingOf(dir).length, 0);
  } finally {
    cleanup();
  }
});

test('AC4: a missing tool_response field never crashes — exit 0, nothing enqueued', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat run.log' }, cwd: dir }, dir);
    assert.equal(r.code, 0);
    assert.equal(pendingOf(dir).length, 0);
  } finally {
    cleanup();
  }
});

test('AC4: a tool name other than Read or Bash is ignored — exit 0, nothing enqueued', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(
      { hook_event_name: 'PostToolUse', tool_name: 'Glob', tool_input: { pattern: '**/*.log' }, tool_response: CONTENT_SENTENCE, cwd: dir },
      dir
    );
    assert.equal(r.code, 0);
    assert.equal(pendingOf(dir).length, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC5 — guard dedup, in H23's OWN namespace
// ---------------------------------------------------------------------------

test('AC5: the same record match on a second event does not re-enqueue', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const first = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(first.code, 0);
    assert.equal(pendingOf(dir).length, 1, 'first touch enqueues');
    const second = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(second.code, 0);
    assert.equal(pendingOf(dir).length, 1, 'second touch of the same record on this axis is silent — no re-enqueue');
  } finally {
    cleanup();
  }
});

test('AC5: H23\'s own dedup namespace leaves the substance-delivery guard ledger untouched — H23 must not consume H19\'s eligibility', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir); // dedup should suppress this one
    assert.equal(pendingOf(dir).length, 1, 'sanity: dedup held');
    const guard = guardOf(dir);
    assert.ok(!(guard.records ?? []).includes(ap.id), "H23's dedup key must be a SEPARATE namespace from H19's substance ledger (guard.records)");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC6 — subagent silence
// ---------------------------------------------------------------------------

test('AC6: an event carrying a subagent session marker enqueues nothing — the queue serves only the conductor', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE, { agent_id: 'coder-1' }), dir);
    assert.equal(r.code, 0);
    assert.equal(pendingOf(dir).length, 0, 'a spawned agent\'s session never enqueues into the conductor\'s queue');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC7 — cap
// ---------------------------------------------------------------------------

test('AC7: more than 3 matching records caps the pointer block at 3 lines and discloses the remainder count', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    store.create(markedAntiPattern('AP-BETA'));
    store.create(markedAntiPattern('AP-GAMMA'));
    store.create(markedAntiPattern('AP-DELTA'));
    const r = runHook(postBash(dir, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    const payload = pendingOf(dir)[0].payload;
    const lines = payload.split('\n').filter((l) => l.includes('knowledge_get'));
    assert.equal(lines.length, 3, 'at most 3 pointer lines render');
    const remainderMatch = payload.match(/\(\+(\d+) more matched\)/);
    assert.ok(remainderMatch, 'a remainder disclosure names how many more matched');
    assert.equal(remainderMatch[1], '1', '4 matched minus 3 shown leaves exactly 1 undisclosed record disclosed as a remainder');
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
    const pending = pendingOf(dir);
    assert.equal(pending.length, 1, 'the match inside the first 16,000 chars still fires');
    assert.match(pending[0].payload, new RegExp(`knowledge_get ${ap.id}`));
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

test('review (a): PowerShell tool_response content matches enqueue exactly like Bash', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(
      { hook_event_name: 'PostToolUse', tool_name: 'PowerShell', tool_input: { command: 'Get-Content run.log' }, tool_response: CONTENT_SENTENCE, cwd: dir },
      dir
    );
    assert.equal(r.code, 0);
    const pending = pendingOf(dir);
    assert.equal(pending.length, 1, 'PowerShell is a first-class seam, same as Bash');
    assert.match(pending[0].payload, new RegExp(`knowledge_get ${ap.id}`));
  } finally {
    cleanup();
  }
});

test('review (b): Read of a path under .sterling/ enqueues nothing — the store tree is the highest-false-positive, self-referential input', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(markedAntiPattern('AP-ALPHA'));
    const r = runHook(postRead(dir, '.sterling/transient/delivery/pending.json', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    assert.equal(pendingOf(dir).length, 0, 'reading the delivery queue must never feed the delivery queue');
  } finally {
    cleanup();
  }
});

test('review (c): a file owned ONLY by a working_tree-scoped article still enqueues — working-tree owners do not gate, matching H19', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('tree-scoped', ['logs/probe.txt'], { working_tree: 'detached-copy' }));
    const dec = store.create(markedDecision('DEC-GAMMA'));
    const r = runHook(postRead(dir, 'logs/probe.txt', CONTENT_SENTENCE), dir);
    assert.equal(r.code, 0);
    const pending = pendingOf(dir);
    assert.equal(pending.length, 1, 'a working_tree-scoped owner means H19 delivers no substance here, so H23 must fire');
    assert.match(pending[0].payload, new RegExp(`knowledge_get ${dec.id}`));
  } finally {
    cleanup();
  }
});

test('review (d): a file owned by a repo-located reference_material enqueues nothing — the ownership predicate matches H19 exactly', () => {
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
    assert.equal(pendingOf(dir).length, 0, 'a repo-located reference doc confers ownership, same as H19');
  } finally {
    cleanup();
  }
});

// Second, disjoint vocabulary family for the concurrency pin, same freq-3
// centrality idiom as the DOMAIN_* fixtures — so each concurrent process
// matches exactly one record and the two enqueues are distinguishable.
const SLUICE_TRIGGER =
  'quench manifold quench manifold arbor sluice arbor sluice gantry pylon gantry pylon ' +
  'recur constantly though this fault rarely touches a coolant loop stage during purge work';

const SLUICE_CONTENT =
  'The purge trace shows the quench manifold venting while the sluice arbor and the gantry pylon both drift past nominal torque.';

test('review (e): two h23 processes on the SAME project concurrently — pending.json stays valid JSON and holds BOTH entries (withFileLock pin)', async () => {
  const { spawn } = await import('node:child_process');
  const { dir, store, cleanup } = makeProject();
  try {
    const a = store.create(markedAntiPattern('AP-ALPHA'));
    const b = store.create(antiPattern('AP-SLUICE quench manifold sluice arbor gantry pylon failure', SLUICE_TRIGGER));
    const run = (input) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [join(HOOKS, 'h23-output-axis.mjs')], { cwd: dir });
        p.on('exit', (code) => resolve(code));
        p.stdin.write(JSON.stringify(input));
        p.stdin.end();
      });
    const [c1, c2] = await Promise.all([
      run(postBash(dir, 'cat run.log', CONTENT_SENTENCE)),
      run(postBash(dir, 'cat purge.log', SLUICE_CONTENT)),
    ]);
    assert.equal(c1, 0);
    assert.equal(c2, 0);
    const pending = pendingOf(dir); // JSON.parse here IS the torn-file assertion
    assert.equal(pending.length, 2, 'both concurrent enqueues survive — no lost update, no torn queue');
    const all = pending.map((e) => e.payload).join('\n');
    assert.match(all, new RegExp(`knowledge_get ${a.id}`));
    assert.match(all, new RegExp(`knowledge_get ${b.id}`));
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
    assert.equal(pendingOf(dir).length, 0, 'the domain vocabulary lives past char 16,000 and must not be seen');
  } finally {
    cleanup();
  }
});
