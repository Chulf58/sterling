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
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ extractAxisTerms, axisHits } = await import(pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href));
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

test('axisHits: matches trigger and title but NOT rationale or right_way', () => {
  const ap = antiPattern('Latch title', 'a one-way latch flips on every emission', []);
  ap.right_way = 'the countdown widget approach';
  assert.deepEqual(axisHits(ap, ['latch', 'emission']).sort(), ['emission', 'latch']);
  assert.deepEqual(axisHits(ap, ['countdown']), [], 'right_way is outside the narrow surface on purpose');
});
