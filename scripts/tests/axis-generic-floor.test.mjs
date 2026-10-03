// Mechanism-axis GENERIC-TERM FLOOR raised (Sterling scale-down Slice 3d,
// decision sterling-claude-code-scale-down-boundary; board d0f3647a).
//
// Measured 2026-09-19: H20 injected ~3.5KB on a real dispatch whose matched
// terms were "test, names, full, list, path, scripts, hook" — one or two
// ordinary words escaped GENERIC_DEV_TERMS and that single escape was enough
// for hasDiscriminatingHit. The raised floor: a push delivery (H20, H23, H19
// dispatch staging's subject channel) needs at least
// AXIS_MIN_DISCRIMINATING_HITS (2) matched terms outside the generic set, and
// 'full' joins the generic set. knowledge_preflight (a deliberate pull) keeps
// the one-term floor.
//
// Pins: the generic dispatch shape does NOT fire on any push surface, while a
// prompt naming a specific record subject still does (CONTROL arm, first).
// Each H20/H23 injection also stays within the delivery total cap.
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
const NOW = '2026-09-19T12:00:00.000Z';
const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

let SterlingStore;
let hasDiscriminatingHit;
let AXIS_MIN_DISCRIMINATING_HITS;
let DELIVERY_TOTAL_CAP_DEFAULT;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ hasDiscriminatingHit, AXIS_MIN_DISCRIMINATING_HITS, DELIVERY_TOTAL_CAP_DEFAULT } = await import(
    pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href
  ));
});

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
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

function decisionRecord(title, statement) {
  return {
    ...envelope('decision'),
    title,
    statement,
    alternatives_rejected: [{ option: 'something else', reason: 'no' }],
    rationale: 'rationale',
    file_keys: [],
  };
}

function antiPattern(title, trigger, rightWay = 'right way text') {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: rightWay,
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: [],
  };
}

function makeProject(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-axis-floor-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return {
    dir,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The generic record: its narrow text is built from the very words the
// measured dispatch matched on, so every lower floor (AXIS_MIN_HITS, record
// centrality) is satisfied — only the discriminating-term floor can silence it.
const GENERIC_TITLE = 'Hook scripts run the full test list for every path name';
const GENERIC_STATEMENT = 'The hook scripts run the full test list; names and path are listed per hook in full.';
const GENERIC_PROMPT = 'run the full test list for scripts path hook names';

// The specific record: a subject no generic prompt shares.
const SPECIFIC_TITLE = 'One-way latch must not flip on every emission countdown';
const SPECIFIC_STATEMENT = 'The one-way latch flips once; the emission countdown never re-arms the latch after the flywheel spins.';
const SPECIFIC_PROMPT = 'Fix the one-way latch so the emission countdown stops re-arming it when the flywheel spins.';

const dispatch = (dir, prompt) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Task',
  tool_input: { subagent_type: 'general-purpose', prompt },
  cwd: dir,
});

const ctxOf = (r) => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '' : '');

test('unit: the floor constant is 2, and one discriminating term among generic ones no longer clears a push floor', () => {
  assert.equal(AXIS_MIN_DISCRIMINATING_HITS, 2);
  assert.equal(hasDiscriminatingHit(['test', 'names', 'full', 'list', 'path', 'scripts', 'hook'], AXIS_MIN_DISCRIMINATING_HITS), false);
  assert.equal(hasDiscriminatingHit(['latch', 'emission', 'test'], AXIS_MIN_DISCRIMINATING_HITS), true);
  // The pull surface's default floor is unchanged: one escape still counts.
  assert.equal(hasDiscriminatingHit(['hook', 'test']), true);
});

// Word variants (finding h20-discriminating-term-floor-counts-word-variants-as-two-terms-october-2026):
// 'resolved' and 'resolve' are one word, so they are one term against the floor.
test('unit: two forms of one word count as ONE discriminating term', () => {
  assert.equal(hasDiscriminatingHit(['path', 'resolved', 'resolve'], 2), false);
  assert.equal(hasDiscriminatingHit(['resolve', 'RESOLVED'], 2), false, 'case-insensitive');
  assert.equal(hasDiscriminatingHit(['latch', 'latches', 'latching'], 2), false, 'a chain of variants is still one word');
  // The pull default of one term is unaffected by collapsing.
  assert.equal(hasDiscriminatingHit(['resolved', 'resolve']), true);
});

test('unit: inflections that are not prefixes of each other are one word', () => {
  assert.equal(hasDiscriminatingHit(['test', 'resolved', 'resolving'], 2), false);
  assert.equal(hasDiscriminatingHit(['resolving', 'resolved', 'test'], 2), false, 'input order does not matter');
  assert.equal(hasDiscriminatingHit(['resolve', 'resolved', 'resolving', 'resolves'], 2), false);
  assert.equal(hasDiscriminatingHit(['class', 'classes', 'test'], 2), false);
  assert.equal(hasDiscriminatingHit(['latch', 'latches', 'latching'], 2), false);
});

test('unit: words that share letters but not a stem stay two terms', () => {
  assert.equal(hasDiscriminatingHit(['mode', 'model'], 2), true);
  assert.equal(hasDiscriminatingHit(['model', 'mode'], 2), true);
  assert.equal(hasDiscriminatingHit(['provenance', 'resolve'], 2), true);
});

test('unit: a bare word is never stripped, so near-spellings of different words stay two terms', () => {
  assert.equal(hasDiscriminatingHit(['stat', 'state'], 2), true);
  assert.equal(hasDiscriminatingHit(['state', 'stat'], 2), true);
  assert.equal(hasDiscriminatingHit(['plan', 'plane'], 2), true);
});

test('unit: a short word and its plural or -s form are one term', () => {
  assert.equal(hasDiscriminatingHit(['test', 'type', 'types'], 2), false);
  assert.equal(hasDiscriminatingHit(['types', 'type', 'test'], 2), false, 'input order does not matter');
  assert.equal(hasDiscriminatingHit(['test', 'make', 'makes'], 2), false);
  assert.equal(hasDiscriminatingHit(['makes', 'make', 'test'], 2), false, 'input order does not matter');
});

test('unit: a lone term that merely ends like an inflection still counts as one term', () => {
  assert.equal(hasDiscriminatingHit(['bus']), true);
  assert.equal(hasDiscriminatingHit(['embed']), true);
  assert.equal(hasDiscriminatingHit(['bus', 'embed'], 2), true);
  assert.equal(hasDiscriminatingHit(['analysis']), true);
});

test('unit: two different words still count as two', () => {
  assert.equal(hasDiscriminatingHit(['path', 'provenance', 'resolve'], 2), true);
  assert.equal(hasDiscriminatingHit(['latch', 'emission'], 2), true);
});

test('unit: short words do not collapse into longer unrelated words', () => {
  // 'cap' is a prefix of 'capture' but is not its stem: two words.
  assert.equal(hasDiscriminatingHit(['cap', 'capture'], 2), true);
  // 'hook' / 'hooks' share a stem: one word.
  assert.equal(hasDiscriminatingHit(['hook', 'hooks'], 2), false);
  // 'bus' / 'busy' do not share a stem: two words.
  assert.equal(hasDiscriminatingHit(['bus', 'busy'], 2), true);
});

test('unit: a generic term plus one variant pair stays below the floor of 2', () => {
  assert.equal(hasDiscriminatingHit(['test', 'resolved', 'resolve'], 2), false);
  assert.equal(hasDiscriminatingHit(['test', 'resolved', 'resolve', 'provenance'], 2), true);
});

test('H20 CONTROL: a dispatch naming a specific record subject still fires', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const d = store.create(decisionRecord(SPECIFIC_TITLE, SPECIFIC_STATEMENT));
    const r = runHook('h20-mechanism-axis.mjs', dispatch(dir, SPECIFIC_PROMPT), dir);
    assert.equal(r.code, 0);
    assert.ok(ctxOf(r).includes(d.id), 'the specific ruling is delivered');
  } finally {
    cleanup();
  }
});

test('H20: the generic dispatch shape "run the full test list for scripts path hook names" does NOT fire', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(decisionRecord(GENERIC_TITLE, GENERIC_STATEMENT));
    const r = runHook('h20-mechanism-axis.mjs', dispatch(dir, GENERIC_PROMPT), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', `generic vocabulary must not inject (got ${bytes(r.stdout)} bytes)`);
  } finally {
    cleanup();
  }
});

// A configured cap (1200) well under this fixture's uncapped non-hazard text
// (~2KB), so the pin discriminates: an H20 that ignored the cap goes red.
const H20_CAP = 1200;
test('H20: the injection stays within the configured delivery total cap, and a strongly matching question is never denied (advisory only)', () => {
  const { dir, store, cleanup } = makeProject({ delivery: { total_cap_bytes: H20_CAP } });
  try {
    for (let i = 0; i < 3; i++) {
      store.create(antiPattern(`${SPECIFIC_TITLE} ${i}`, `${SPECIFIC_STATEMENT} ${'latch emission detail '.repeat(30)}`, 'r'.repeat(600)));
    }
    for (let i = 0; i < 5; i++) store.create(decisionRecord(`${SPECIFIC_TITLE} ruling ${i}`, `${SPECIFIC_STATEMENT} ${'more text '.repeat(20)}`));
    const r = runHook('h20-mechanism-axis.mjs', dispatch(dir, SPECIFIC_PROMPT), dir);
    assert.equal(r.code, 0);
    const ctx = ctxOf(r);
    assert.match(ctx, /MECHANISM-AXIS DELIVERY/, 'CONTROL: it fired');
    // Hazards are exempt from the cap; everything else fits what remains.
    // Hazard text on the dispatch surface is the lead block plus the trigger
    // lines, their one-line header and the '+N more' line (decision
    // h20-dispatch-surface-lead-hazard-whole-rest-as-trigger-lines, a4912f91).
    // All are hazard parts, exempt from the configured cap like the block.
    const hazardBytes = [
      ...ctx.matchAll(/⚠ ANTI-PATTERN[\s\S]*?RIGHT WAY: [^\n]*/g),
      ...ctx.matchAll(/^▸ \d+ MORE HAZARD\(S\) [^\n]*|^ {2}→ [^\n]* — HAZARD: [^\n]*|^ {2}… \d+ more hazard\(s\) NOT shown[^\n]*/gm),
    ].reduce((n, m) => n + bytes(m[0]), 0);
    assert.ok(bytes(ctx) - hazardBytes <= H20_CAP, `non-hazard H20 text must fit the cap (was ${bytes(ctx) - hazardBytes})`);

    const q = runHook(
      'h20-mechanism-axis.mjs',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: `${SPECIFIC_PROMPT} Which way?`, header: 'Latch', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] }] },
        cwd: dir,
      },
      dir
    );
    assert.notEqual(q.code, 2, 'H20 never denies');
    assert.ok(!/"permissionDecision"\s*:\s*"deny"/.test(q.stdout), 'no deny decision is emitted');
  } finally {
    cleanup();
  }
});

// --- H23 output axis ----------------------------------------------------------

const postBash = (dir, response) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'cat run.log' },
  tool_response: response,
  cwd: dir,
});

const assertNoDelayedDeliveryArtifacts = (dir) => {
  for (const name of ['pending.json', 'pending.lock', 'recipes.json']) {
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'delivery', name)), false, `${name} must not return`);
  }
};

test('H23 CONTROL: tool output naming a specific record subject still delivers a direct pointer', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // anti_pattern, not decision: H23 points at hazards only since ruling
    // h23-output-axis-hazards-only-skip-listings-advisory-label (5564361d v2).
    const d = store.create(antiPattern(SPECIFIC_TITLE, SPECIFIC_STATEMENT));
    const r = runHook('h23-output-axis.mjs', postBash(dir, SPECIFIC_PROMPT), dir);
    const payload = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; // 2026-09-19: direct PostToolUse transport.
    assert.ok(payload.includes(d.id));
    assert.ok(bytes(payload) <= DELIVERY_TOTAL_CAP_DEFAULT);
  } finally {
    cleanup();
  }
});

test('H23: generic output vocabulary emits no direct pointer and leaves no delayed-delivery artifact', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // anti_pattern so the silence below is the generic floor, not H23's type filter.
    store.create(antiPattern(GENERIC_TITLE, GENERIC_STATEMENT));
    const r = runHook('h23-output-axis.mjs', postBash(dir, GENERIC_PROMPT), dir);
    assert.equal(r.stdout, '', 'generic vocabulary must emit no direct context');
    assertNoDelayedDeliveryArtifacts(dir);
  } finally {
    cleanup();
  }
});

// --- H19 dispatch staging's subject channel -----------------------------------

function stageAndStart(dir, prompt) {
  const transcript = join(dir, 'no-such-parent-transcript.jsonl');
  spawnSync(process.execPath, [join(HOOKS, 'h22-dispatch-register.mjs')], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: `toolu_${randomUUID().slice(0, 8)}`,
      tool_input: { subagent_type: 'general-purpose', prompt, description: 'a lane' },
      session_id: 's1',
      cwd: dir,
      transcript_path: transcript,
      prompt_id: 'p1',
    }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
  return runHook(
    'h19-dispatch-staging.mjs',
    {
      hook_event_name: 'SubagentStart',
      session_id: 's1',
      transcript_path: transcript,
      cwd: dir,
      prompt_id: 'p1',
      agent_id: 'agent-1',
      agent_type: 'general-purpose',
    },
    dir
  );
}

test('H19 staging CONTROL: a specific subject still stages on the subject channel', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(antiPattern(SPECIFIC_TITLE, SPECIFIC_STATEMENT));
    const ctx = ctxOf(stageAndStart(dir, SPECIFIC_PROMPT));
    assert.ok(ctx.includes(ap.id), 'the specific hazard is staged');
  } finally {
    cleanup();
  }
});

test('H19 staging: the generic dispatch shape does NOT stage a subject match', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(antiPattern(GENERIC_TITLE, GENERIC_STATEMENT));
    const ctx = ctxOf(stageAndStart(dir, GENERIC_PROMPT));
    assert.ok(!ctx.includes(ap.id), 'generic vocabulary must not stage a subject match');
    assert.ok(!/MECHANISM-AXIS STAGING/.test(ctx));
  } finally {
    cleanup();
  }
});
