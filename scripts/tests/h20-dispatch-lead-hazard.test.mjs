// H20 dispatch surface: the lead hazard stays whole, the rest become one-line
// trigger pointers, and hazards the brief already cites are dropped (user
// ruling h20-dispatch-surface-lead-hazard-whole-rest-as-trigger-lines,
// a4912f91). Measured basis: finding 8d488eb5 (rank 3 acted on 0 of 77 times;
// knowledge_get on a hazard never ran) and finding 0a1e3af8 (~55k tokens per
// session for three whole hazards).
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
const NOW = '2026-09-30T12:00:00.000Z';

let SterlingStore;
let guardPath;
let readGuard;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ guardPath, readGuard } = await import(pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href));
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

function antiPattern(n, extra = {}) {
  return {
    id: randomUUID(),
    type: 'anti_pattern',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    slug: `breach-countdown-hazard-${n}`,
    title: `Breach countdown widget hazard ${n} re-triggers a HUD timer reload mid-breach`,
    trigger:
      `Any breach countdown widget that shows countdown seconds while the HUD timer subsystem reloads during a breach — ` +
      `the reload restarts the seconds from zero. Variant ${n} TRIGGER_TAIL_${n} is past the one-line clip.`,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: `right way ${n} RIGHT_WAY_BODY_${n}`,
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: [],
    ...extra,
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-lead-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const PROMPT = 'Fix the breach countdown widget so the countdown seconds survive when the HUD timer reloads during a breach.';

function dispatch(dir, prompt = PROMPT) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'implementor', prompt }, session_id: 's1', cwd: dir };
}

function ctxOf(r) {
  assert.equal(r.code, 0, `never blocks (AC7); stderr: ${r.stderr}`);
  assert.notEqual(r.stdout, '', 'expected a delivery');
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

const count = (text, re) => (text.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`)) ?? []).length;
const id8 = (r) => r.id.slice(0, 8);
const guardOf = (dir) => readGuard(guardPath(dir, undefined, 's1'));
const has = (ledger, r) => ledger.some((e) => e.id === r.id);

/** One `block` hazard (rank 1 by severity) plus `warn` ones. */
function seed(store, n) {
  return Array.from({ length: n }, (_, i) => store.create(antiPattern(i + 1, i === 0 ? { severity: 'block' } : {})));
}

test('dispatch: rank 1 renders whole, ranks 2-3 render as one line each, and the 4th is disclosed by ONE line', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const [lead, ...rest] = seed(store, 4);
    const ctx = ctxOf(runHook(dispatch(dir), dir));

    assert.equal(count(ctx, /^TRIGGER: /m), 1, `exactly one hazard is whole:\n${ctx}`);
    assert.equal(count(ctx, /^RIGHT WAY: /m), 1);
    assert.match(ctx, /⚠ ANTI-PATTERN \[BLOCK\] for this subject — 'Breach countdown widget hazard 1 /, 'the rank-1 (block) hazard is the whole one');
    assert.ok(ctx.includes('RIGHT_WAY_BODY_1'), 'its right way arrives');

    const lined = rest.filter((r) => ctx.includes(id8(r)));
    assert.equal(lined.length, 2, 'ranks 2-3 are named; the 4th is not');
    for (const r of lined) {
      const lines = ctx.split('\n').filter((l) => l.includes(id8(r)));
      assert.equal(lines.length, 1, `a rank-2/3 hazard occupies exactly one line:\n${ctx}`);
      assert.match(lines[0], new RegExp(`^\\s+→ ${r.slug} \\(${id8(r)}\\) — HAZARD: Any breach countdown widget`), 'name (id8) — HAZARD: trigger');
      assert.ok(!lines[0].includes(`TRIGGER_TAIL_`), 'the trigger is clipped to about 100 chars');
      assert.ok(!ctx.includes(`RIGHT_WAY_BODY_${r.slug.slice(-1)}`), 'a line never carries the right way');
    }
    assert.equal(count(ctx, /more hazard\(s\) NOT shown/), 1, 'one disclosure line for the whole hazard set');
    assert.match(ctx, /… 1 more hazard\(s\) NOT shown \(cap 3\)/);

    const guard = guardOf(dir);
    assert.ok(has(guard.substance, lead), 'the whole hazard earns substance');
    for (const r of lined) {
      assert.ok(has(guard.discovery, r), 'a line earns discovery');
      assert.ok(!has(guard.substance, r), 'a line never earns substance');
    }
    const unshown = rest.find((r) => !lined.includes(r));
    assert.ok(!has(guard.discovery, unshown) && !has(guard.substance, unshown), 'the disclosed-only hazard spends no mark');
  } finally {
    cleanup();
  }
});

test('dispatch: exactly three matching hazards render one whole plus two lines and no disclosure line', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const [, h2, h3] = seed(store, 3);
    const ctx = ctxOf(runHook(dispatch(dir), dir));
    assert.equal(count(ctx, /^RIGHT WAY: /m), 1);
    assert.match(ctx, new RegExp(`→ ${h2.slug} \\(${id8(h2)}\\) — HAZARD: `));
    assert.match(ctx, new RegExp(`→ ${h3.slug} \\(${id8(h3)}\\) — HAZARD: `));
    assert.doesNotMatch(ctx, /NOT shown/);
  } finally {
    cleanup();
  }
});

test('dispatch: a hazard the brief already cites by id8 is not shown and earns no mark', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const [cited, other] = seed(store, 2);
    const ctx = ctxOf(runHook(dispatch(dir, `${PROMPT} Governing hazard: breach hazard (${id8(cited)}).`), dir));
    const withoutPrompt = ctx.split('\n').filter((l) => !l.startsWith('STERLING MECHANISM-AXIS')).join('\n');
    assert.ok(!withoutPrompt.includes(id8(cited)), `the cited hazard is not repeated:\n${ctx}`);
    assert.doesNotMatch(ctx, /hazard 1 re-triggers/, 'not by title either');
    assert.ok(ctx.includes('RIGHT_WAY_BODY_2'), 'the uncited hazard takes rank 1 and renders whole');
    const guard = guardOf(dir);
    assert.ok(!has(guard.substance, cited) && !has(guard.discovery, cited), 'a cited hazard spends no mark');
    assert.ok(has(guard.substance, other));
  } finally {
    cleanup();
  }
});

test('dispatch: a hazard the brief cites by slug or full id is not shown either', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const [bySlug, byId, shown] = seed(store, 3);
    const ctx = ctxOf(runHook(dispatch(dir, `${PROMPT} Read [${bySlug.slug}] and knowledge_get ${byId.id} first.`), dir));
    assert.doesNotMatch(ctx, /hazard 1 re-triggers|hazard 2 re-triggers/, `cited hazards are dropped:\n${ctx}`);
    assert.ok(ctx.includes('RIGHT_WAY_BODY_3'), 'the uncited hazard renders whole');
    const guard = guardOf(dir);
    for (const r of [bySlug, byId]) assert.ok(!has(guard.substance, r) && !has(guard.discovery, r));
    assert.ok(has(guard.substance, shown));
  } finally {
    cleanup();
  }
});

test('dispatch: a slug that is only a prefix of a longer cited slug does not count as cited', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const [lead] = seed(store, 1);
    const ctx = ctxOf(runHook(dispatch(dir, `${PROMPT} See ${lead.slug}-followup for context.`), dir));
    assert.ok(ctx.includes('RIGHT_WAY_BODY_1'), `a different slug is not a citation:\n${ctx}`);
  } finally {
    cleanup();
  }
});

test('dispatch: a second dispatch in the same session does not re-show the line-rendered hazards', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const [lead, ...rest] = seed(store, 4);
    const first = ctxOf(runHook(dispatch(dir), dir));
    const lined = rest.filter((r) => first.includes(id8(r)));
    const unshown = rest.find((r) => !lined.includes(r));
    assert.equal(lined.length, 2);
    assert.equal(count(first, /^RIGHT WAY: /m), 1, 'precondition: ranks 2-3 went out as lines (discovery), not whole');

    const second = ctxOf(runHook(dispatch(dir), dir));
    for (const r of lined) assert.ok(!second.includes(id8(r)), `line-rendered ${r.slug} is not re-shown:\n${second}`);
    assert.ok(!second.includes(id8(lead)), 'the whole hazard is not re-shown');
    assert.ok(second.includes(`knowledge_get ${unshown.id}`), 'the hazard that was only disclosed now gets its turn');
    assert.equal(count(second, /^RIGHT WAY: /m), 1, 'and it arrives whole, as the new rank 1');
  } finally {
    cleanup();
  }
});

test('dispatch header: pinned first line, says the audit arrives WITH the dispatch and prompts an amendment', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seed(store, 1);
    const ctx = ctxOf(runHook(dispatch(dir), dir));
    const head = ctx.split('\n')[0];
    assert.match(head, /^STERLING MECHANISM-AXIS DELIVERY \(H20\)/);
    assert.doesNotMatch(ctx, /BEFORE the brief goes out/, 'the timing claim is false: PreToolUse context arrives with the dispatch');
    assert.match(head, /already sent|already gone out/i, 'it says the brief has gone');
    assert.match(head, /SendMessage/, 'it names the correction');
  } finally {
    cleanup();
  }
});

test('consult surface is unchanged: a codex consult still gets up to three whole hazards', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seed(store, 4);
    const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__codex__codex', tool_input: { prompt: PROMPT }, session_id: 's1', cwd: dir }, dir);
    const ctx = ctxOf(r);
    assert.equal(count(ctx, /^RIGHT WAY: /m), 3, `the ruling covers the dispatch surface only:\n${ctx}`);
  } finally {
    cleanup();
  }
});
