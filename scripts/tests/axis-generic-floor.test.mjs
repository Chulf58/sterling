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
    const hazardBytes = [...ctx.matchAll(/⚠ ANTI-PATTERN[\s\S]*?RIGHT WAY: [^\n]*/g)].reduce((n, m) => n + bytes(m[0]), 0);
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

const pendingOf = (dir) => {
  const p = join(dir, '.sterling', 'transient', 'delivery', 'pending.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};

test('H23 CONTROL: tool output naming a specific record subject still enqueues a pointer', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const d = store.create(decisionRecord(SPECIFIC_TITLE, SPECIFIC_STATEMENT));
    runHook('h23-output-axis.mjs', postBash(dir, SPECIFIC_PROMPT), dir);
    const q = pendingOf(dir);
    assert.equal(q.length, 1);
    assert.ok(q[0].payload.includes(d.id));
    assert.ok(bytes(q[0].payload) <= DELIVERY_TOTAL_CAP_DEFAULT);
  } finally {
    cleanup();
  }
});

test('H23: generic output vocabulary does NOT enqueue a pointer', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(decisionRecord(GENERIC_TITLE, GENERIC_STATEMENT));
    runHook('h23-output-axis.mjs', postBash(dir, GENERIC_PROMPT), dir);
    assert.equal(pendingOf(dir).length, 0, 'generic vocabulary must not enqueue');
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
