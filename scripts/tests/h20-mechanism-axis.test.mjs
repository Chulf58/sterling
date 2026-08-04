// H20 mechanism-axis delivery at dispatch (board 62806222). The two load-bearing
// properties: it FINDS a record no file-key join could reach, and it stays SILENT
// when the prompt is about ungoverned subject matter. The second is the AC that
// keeps it from becoming what board 7bbec3bd says H10 became.
// AC7 floor applies here too: no path through this hook may exit 2.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-03T12:00:00.000Z';

let SterlingStore;
let extractAxisTerms;
let axisHits;
let hasDiscriminatingHit;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ extractAxisTerms, axisHits, hasDiscriminatingHit } = await import(
    pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href
  ));
});

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h20-mechanism-axis.mjs')], {
    input: JSON.stringify(input),
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

function antiPattern(title, trigger, paths = []) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: 'right way text',
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: paths,
  };
}

function decisionRecord(title, statement, paths = []) {
  return {
    ...envelope('decision'),
    title,
    statement,
    alternatives_rejected: [{ option: 'a numeric countdown in the HUD', reason: 'kills the dread' }],
    rationale: 'rationale',
    file_keys: paths,
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function dispatch(dir, prompt, subagent_type = 'coder') {
  return { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type, prompt }, cwd: dir };
}

/** The AskUserQuestion surface — note it has NO prompt field at all. */
function askQuestion(dir, question, options = [], header = 'Choice') {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question, header, multiSelect: false, options }] },
    cwd: dir,
  };
}

// --- the motivating case -----------------------------------------------------

test('H20: delivers an anti_pattern whose file_keys name a file the prompt never mentions — the case no file-key join can reach', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // Filed against the file where the incident happened. The dispatch is about
    // a DIFFERENT file entirely; only the mechanism matches.
    store.create(
      antiPattern(
        'Signal connected at boot but emitter initialises later',
        'whenever a node connects a signal in _ready() but finishes initialising LATER',
        ['game/run/worker_crew.gd']
      )
    );
    const r = runHook(
      dispatch(dir, 'Wire the harvester so it connects its ready signal in _ready(), then finishes initialising the crew later in the boot sequence.'),
      dir
    );
    assert.equal(r.code, 0, 'never blocks (AC7)');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /MECHANISM-AXIS DELIVERY \(H20\)/);
    assert.match(ctx, /Signal connected at boot but emitter initialises later/, 'the hazard reaches the conductor');
    assert.match(ctx, /matched on: /, 'and names which terms matched, so a false positive is legible as one');
    assert.doesNotMatch(ctx, /worker_crew/, 'the record is not delivered because of any path the prompt named');
  } finally {
    cleanup();
  }
});

test('H20: delivers a decision whose subject appears in NO file — a ruling about a subject, not a territory', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(
      decisionRecord(
        'Breach timing is never shown to the player',
        'No surface may display when the next breach arrives — no seconds, no minutes, no numeric or graphical countdown, at any point in the game.',
        []
      )
    );
    const r = runHook(dispatch(dir, 'Add a breach countdown widget so the player can see the seconds until the next breach arrives.'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    // A decision pointer renders its STATEMENT, not its title (decision ca23c811,
    // the shared H19 renderer) — so assert on what is actually delivered. The
    // title is where half the match came from and never appears in the payload;
    // the header's "matched on:" list is what keeps that legible, and it is
    // asserted below rather than left implicit.
    assert.match(ctx, /No surface may display when the next breach arrives/, 'the ruling reaches the conductor before the brief goes out');
    assert.match(ctx, /ALREADY REJECTED: a numeric countdown in the HUD/, 'and carries its rejected alternatives (decision 6a3b1a46)');
    assert.match(ctx, /matched on:[^\n]*countdown/, 'the matched term is named, so a title-only match is still legible');
  } finally {
    cleanup();
  }
});

// --- the silence AC (the one that keeps it from becoming noise) --------------

test('H20: SILENT when the prompt is about ungoverned subject matter — the confirmed end-to-end criterion', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(antiPattern('Signal boot ordering', 'a node connects a signal in _ready() but initialises later', ['game/a.gd']));
    const r = runHook(dispatch(dir, 'Rename the invoice tax column to vat_amount and update the two callers.'), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'nothing injected — no hit, no output');
  } finally {
    cleanup();
  }
});

test('H20: SILENT against a REALISTIC corpus — stage 2 is the filter, and it has to survive real records', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // Verbatim titles from this repo's own store. The point of using real ones:
    // stage 1 (FTS, OR-joined) admits nearly EVERYTHING for a prompt built from
    // generic verbs — measured 2026-08-03, an invoice/VAT prompt pulled a full
    // cap of 40 real records. So the silence AC rests entirely on stage 2, and a
    // one-record fixture proves nothing about that. These titles carry the
    // dangerous overlap ('update', 'rename', 'module', 'column', 'callers').
    for (const title of [
      'knowledge_append for array fields, and a coherence warning on partial updates — the cheap half of the append/identity problem',
      'Two-axis phase discipline design: split_interface_threshold config rename; phase_over_wide gate flag; prep breadth refusal',
      'knowledge_update lifecycle-binds (auto-drains) the article drift maintenance items',
      'TUI Knowledge tab: re-introduce a component SUB-CATEGORY level, single-bucket dominant; rename Articles to Features',
      'Citing a record id in another record prose — every update stales it, and no check can see it',
      'Every machine but the authoring one is a PURE CONSUMER of origin/main — updates are fast-forward-or-refuse',
      'relies_on/relied_by hold article SLUGS — cleanup-plan matches slug primarily and id as a transition fallback',
      'Add a none toolchain adapter — first-class no automated checks for docs / not-yet-coded projects',
      'Writes fail loud too, queues state their depth, and the depth reaches whoever drains',
      'Retrieval tells the truth about itself: strict tool params, a disclosed query window, a projected payload',
    ]) {
      store.create(decisionRecord(title, `${title} — statement text carrying the same vocabulary.`, []));
    }
    const r = runHook(dispatch(dir, 'Rename the invoice tax column to vat_amount and update the two callers in the billing module.'), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'ten real records, generic-verb overlap, and still silent');
  } finally {
    cleanup();
  }
});

test('H20: SILENT on an empty store — zero ceremony where there is no knowledge (P1)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(dispatch(dir, 'connects a signal in _ready and initialises the crew later during boot'), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally {
    cleanup();
  }
});

test('H20: a single shared word is NOT enough — one match is coincidence, two is signal', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // 'signal' is the only overlap; the trigger is about something else entirely.
    store.create(antiPattern('Latch flipped twice', 'a signal handler flips a one-way latch on every emission', ['game/b.gd']));
    const r = runHook(dispatch(dir, 'Refactor the signal wiring in the harvester module.'), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'below the two-distinct-term threshold, so silent');
  } finally {
    cleanup();
  }
});

// --- guard sharing and non-blocking floor -----------------------------------

test('H20: shares H19 session guard — a second dispatch matching the same record delivers nothing', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(antiPattern('Boot ordering hazard', 'a node connects a signal in _ready() but initialises later', ['game/a.gd']));
    const p = 'connects a signal in _ready then initialises later during boot';
    const first = runHook(dispatch(dir, p), dir);
    assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /Boot ordering hazard/);
    const second = runHook(dispatch(dir, p), dir);
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '', 'already in this context — not re-injected');
  } finally {
    cleanup();
  }
});

// --- the AskUserQuestion surface (board 4e6eb510) -----------------------------

test('H20: reads the AskUserQuestion surface, which has NO prompt field — the registration is inert without this', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(
      decisionRecord(
        'Breach timing is never shown to the player',
        'No surface may display when the next breach arrives — no seconds, no minutes, no numeric or graphical countdown.',
        []
      )
    );
    const r = runHook(
      askQuestion(dir, 'How should the breach countdown be displayed?', [
        { label: 'Numeric seconds', description: 'A countdown showing seconds until the next breach arrives' },
        { label: 'Graphical arc', description: 'A filling arc instead of numbers' },
      ]),
      dir
    );
    assert.equal(r.code, 0, 'never blocks (AC7)');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /No surface may display when the next breach arrives/, 'the ruling reaches the conductor BEFORE the question is asked');
    assert.match(ctx, /put a CHOICE TO THE USER/, 'the header names the surface — a user answer becomes authoritative');
    assert.doesNotMatch(ctx, /about to dispatch/, 'and does NOT use the dispatch wording');
  } finally {
    cleanup();
  }
});

test('H20: OPTION text alone can trigger it — the mockup-in-an-option case that motivated board 4e6eb510', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(
      decisionRecord('Countdown ruling', 'No numeric or graphical countdown may ever be displayed to the player.', [])
    );
    // The QUESTION text is innocuous; only an OPTION carries the governed subject.
    const r = runHook(
      askQuestion(dir, 'Which layout do you prefer?', [
        { label: 'Option A', description: 'Adds a numeric countdown displayed to the player above the dome' },
        { label: 'Option B', description: 'Plain status bar' },
      ]),
      dir
    );
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /No numeric or graphical countdown/, 'option text is scanned, not just the question');
  } finally {
    cleanup();
  }
});

test('H20: SILENT on an ungoverned question, and on an unrecognised tool shape', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(decisionRecord('Countdown ruling', 'No numeric or graphical countdown may be displayed.', []));
    const ungoverned = runHook(
      askQuestion(dir, 'Should the invoice export be CSV or XLSX?', [
        { label: 'CSV', description: 'Comma separated, one row per invoice line' },
        { label: 'XLSX', description: 'Excel workbook with a sheet per month' },
      ]),
      dir
    );
    assert.equal(ungoverned.code, 0);
    assert.equal(ungoverned.stdout, '', 'ungoverned question injects nothing (AC10)');

    // A tool carrying neither `prompt` nor `questions` is inert, never half-scanned.
    const other = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: '**/*.gd' }, cwd: dir }, dir);
    assert.equal(other.code, 0);
    assert.equal(other.stdout, '');
  } finally {
    cleanup();
  }
});

test('H20: never denies, even with an unreadable store — delivery is an aid, not a gate (AC7)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(antiPattern('x', 'a node connects a signal in _ready() but initialises later', ['a.gd']));
    // Corrupt the guard directory into a file so the guard write throws.
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'delivery'), 'not a directory');
    const r = runHook(dispatch(dir, 'connects a signal in _ready then initialises later during boot'), dir);
    assert.notEqual(r.code, 2, 'exit 2 is the only blocking code and must never be used here');
  } finally {
    cleanup();
  }
});

test('H20: a non-dispatch call with no prompt is ignored', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: {}, cwd: dir }, dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally {
    cleanup();
  }
});

// --- the extractor, directly -------------------------------------------------

test('extractAxisTerms: ranks by term frequency, is deterministic, and respects the cap', () => {
  const terms = extractAxisTerms('breach countdown breach timing breach widget seconds', 16);
  assert.equal(terms[0], 'breach', 'the repeated subject ranks first');
  assert.deepEqual(extractAxisTerms('breach countdown breach timing breach widget seconds', 16), terms, 'same prompt, same terms');
  assert.ok(extractAxisTerms('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike', 3).length === 3);
});

test('extractAxisTerms: drops dispatch boilerplate and short words, so they cannot cause a match', () => {
  const terms = extractAxisTerms('Please verify the record in the store and report the evidence for this file', 16);
  for (const noise of ['verify', 'record', 'store', 'report', 'evidence', 'file', 'this', 'the']) {
    assert.ok(!terms.includes(noise), `'${noise}' must not survive extraction`);
  }
});

// --- the generic-term floor (board 648bb497, research_finding bf74c65f) ----
//
// FROZEN over the REAL matched-term sets captured 2026-08-03/04 in this
// repo's own session transcripts (the 'matched on:' list H20 prints in every
// payload header). AXIS_MIN_HITS=2 alone was trivially satisfied by universal
// dev vocabulary; the floor added above requires at least one matched term to
// escape GENERIC_DEV_TERMS.
//
// THE HONEST BOUNDARY, chosen and documented here rather than left implicit:
// GENERIC_DEV_TERMS is UNIVERSAL coding vocabulary only (test, check, file,
// commit, ...) — it deliberately does NOT include Sterling's own domain
// words ('board', 'decision', 'triage', 'user', 'recommendation',
// 'dependencies', 'open', 'full', 'anything', 'itself'). Those read as
// ordinary English, but in THIS store — whose subject is Sterling's own
// mechanism — they discriminate between dispatches, so widening the generic
// set to swallow them would silence exactly the matches H20 exists to
// deliver. Consequence: a real observed set that mixes generic terms with
// even one of those domain words STILL FIRES. Only a set that is generic
// start-to-finish goes silent.
test('hasDiscriminatingHit: a real matched-term set mixing generic and Sterling-domain vocabulary STILL FIRES', () => {
  // Verbatim from a captured H20 payload header (research_finding bf74c65f).
  // 'board', 'decision', 'triage', 'user', 'recommendation', 'dependencies',
  // 'open', 'full', 'anything', 'itself' are NOT in GENERIC_DEV_TERMS (they are
  // Sterling-domain, not universal-coding), so this set clears the floor.
  const hits = [
    'item', 'board', 'decision', 'text', 'items', 'open', 'full', 'triage',
    'anything', 'itself', 'user', 'behavior', 'recommendation', 'dependencies',
  ];
  assert.equal(hasDiscriminatingHit(hits), true, 'board/decision/triage/... discriminate in this store — not generic');
});

test('hasDiscriminatingHit: a set already dominated by domain-discriminating terms STILL FIRES', () => {
  // Verbatim from a captured H20 payload header — machine/authoring/config/
  // consumer/update/json/clone are all Sterling-mechanism vocabulary.
  const hits = ['machine', 'authoring', 'config', 'consumer', 'update', 'json', 'clone'];
  assert.equal(hasDiscriminatingHit(hits), true, 'authoring/consumer/clone are domain-discriminating, not generic boilerplate');
});

test('hasDiscriminatingHit: judged honestly — a third real set STILL FIRES on its non-generic terms', () => {
  // Verbatim from a captured H20 payload header. 'test' and 'commit' and
  // 'check' are generic, but 'empty', 'brief', 'refusal', 'article' are not.
  const hits = ['test', 'empty', 'commit', 'brief', 'check', 'refusal', 'article'];
  assert.equal(hasDiscriminatingHit(hits), true, 'empty/brief/refusal/article are not universal coding vocabulary');
});

test('hasDiscriminatingHit: SILENT only when EVERY matched term is strictly generic', () => {
  // The strictly-generic subset of the finding's own "dominated by" list
  // (test/tests, scripts, commit, check, node, build, branch, merge, text,
  // item(s)) — with the non-generic outliers the finding also names ('board',
  // 'open', 'hooks') removed, since those are Sterling-domain under the chosen
  // boundary. This is the honest positive case: a match confined ENTIRELY to
  // universal vocabulary goes silent.
  const hits = ['test', 'tests', 'scripts', 'commit', 'check', 'node', 'build', 'branch', 'merge', 'text', 'item', 'items'];
  assert.equal(hasDiscriminatingHit(hits), false, 'purely generic — must not be a reason to interrupt a dispatch');
});

test('H20: end-to-end SILENT when the only matched terms are universal dev vocabulary', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // Title/statement built ENTIRELY from GENERIC_DEV_TERMS so axisHits can only
    // ever return generic terms, however many — the floor, not AXIS_MIN_HITS,
    // is what must silence this.
    store.create(
      decisionRecord(
        'Commit checks run tests before every build',
        'The build script runs tests and checks on every commit; errors and messages go to the output file.',
        []
      )
    );
    const r = runHook(
      dispatch(dir, 'Run the tests and checks before this commit, then build and review the output file for errors and messages.'),
      dir
    );
    assert.equal(r.code, 0, 'never blocks (AC7)');
    assert.equal(r.stdout, '', 'matched purely on generic dev vocabulary — the new floor silences it');
  } finally {
    cleanup();
  }
});

test('H20: end-to-end STILL FIRES when a domain-discriminating term rides alongside generic ones', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(
      decisionRecord(
        'Board triage runs before every commit check',
        'Every commit check first runs a board triage pass; the build script tests and checks the item list.',
        []
      )
    );
    const r = runHook(
      dispatch(dir, 'Run the tests and checks before this commit, then triage the board item list and build.'),
      dir
    );
    assert.equal(r.code, 0);
    // Decision pointers render the STATEMENT, not the title (ca23c811) — assert
    // on what is actually delivered.
    assert.match(
      JSON.parse(r.stdout).hookSpecificOutput.additionalContext,
      /Every commit check first runs a board triage pass/,
      "'board'/'triage' are Sterling-domain, not generic — one such term is enough to fire"
    );
  } finally {
    cleanup();
  }
});

test('axisHits: matches trigger and title but NOT rationale or right_way', () => {
  const ap = antiPattern('Latch title', 'a one-way latch flips on every emission', []);
  ap.right_way = 'the countdown widget approach';
  assert.deepEqual(axisHits(ap, ['latch', 'emission']).sort(), ['emission', 'latch']);
  assert.deepEqual(axisHits(ap, ['countdown']), [], 'right_way is outside the narrow surface on purpose');
});
