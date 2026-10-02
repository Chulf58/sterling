// REGRESSION: H20 delivered a superseded decision as "[standing]" (Dome Farmer
// issue 2026-10-02, FRICTION near-miss; board 7e4850cf sub-item (c)). Measured
// in Dome Farmer's store: decision foreign_bac7bcdb was created with a
// links[{rel:'supersedes', target_id: 64a315d9}] entry. That writes the
// record_relations edge but does NOT retire the target (create admits a
// supersedes link as a partial override; only supersede/retireInFavorOf retire),
// so 64a315d9 stayed status active, lifecycle live, superseded_by null. The MCP
// read surfaces disclose such an edge as `inbound_supersedes`; H20 did not, and
// printed the old record's own `authority: standing` as "[standing]", so the
// conductor read the stale day length (150 s) as the current ruling.
//
// Pins: on both H20 surfaces that render decisions (question and dispatch), a
// decision that another record holds a supersedes edge onto never carries the
// [standing] marker and names its superseder; a decision with no such edge is
// unchanged; a decision retired through supersede() is not delivered at all.
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
const NOW = '2026-10-02T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
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

function decisionRecord(slug, title, statement, extra = {}) {
  return {
    id: randomUUID(),
    type: 'decision',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    slug,
    title,
    statement,
    alternatives_rejected: [],
    rationale: 'rationale',
    authority: 'standing',
    file_keys: [],
    ...extra,
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-superseded-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const QUESTION = 'How long is one farm day in seconds, and how many farm days does peacetime last before the breach?';
const OPTIONS = [
  { label: 'Keep the farm day', description: 'One farm day stays as ruled; peacetime days unchanged' },
  { label: 'Shorter peacetime', description: 'Fewer peacetime farm days before the breach' },
];
const OLD_SLUG = 'one-farm-day-is-150-seconds-peacetime-is-8-farm-days';
const OLD_TITLE = 'One farm day is 150 seconds; peacetime is 8 farm days before the breach';
const OLD_STATEMENT = 'One farm day lasts 150 seconds and peacetime lasts 8 farm days before the breach.';
const NEW_SLUG = 'one-farm-day-is-900-seconds-peacetime-is-2-farm-days';
const NEW_TITLE = 'One farm day is 900 seconds; peacetime is about 2 farm days before the breach';
const NEW_STATEMENT = 'One farm day lasts 900 seconds and peacetime lasts about 2 farm days before the breach.';

function askQuestion(dir) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: QUESTION, header: 'Day length', multiSelect: false, options: OPTIONS }] },
    session_id: 's1',
    cwd: dir,
  };
}

function dispatch(dir) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Task',
    tool_input: { subagent_type: 'debugger', prompt: `Investigate: ${QUESTION}` },
    session_id: 's1',
    cwd: dir,
  };
}

function ctxOf(r) {
  assert.equal(r.code, 0, `never blocks; stderr: ${r.stderr}`);
  assert.ok(r.stdout.trim(), `H20 delivered something; stderr: ${r.stderr}`);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

// The incident's store shape: the newer record carries the supersedes link, the
// older record stays active and live.
function seedPartialSupersession(store) {
  const oldRec = store.create(decisionRecord(OLD_SLUG, OLD_TITLE, OLD_STATEMENT));
  const newRec = store.create(
    decisionRecord(NEW_SLUG, NEW_TITLE, NEW_STATEMENT, { links: [{ rel: 'supersedes', target_id: oldRec.id }] })
  );
  const reread = store.get(oldRec.id);
  assert.equal(reread.status, 'active', 'precondition: the incident shape leaves the old record active');
  assert.equal(reread.superseded_by ?? null, null, 'precondition: and with no superseded_by');
  return { oldRec, newRec };
}

// A record's OWN pointer line: the question surface opens it with `→ name (id8)`,
// the dispatch surface ends its pointer with `(knowledge_get <full id>)`. A
// superseder named inside another record's line matches neither form.
const lineOf = (ctx, rec) =>
  ctx.split('\n').find((l) => l.trimStart().startsWith(`→ ${rec.slug} (${rec.id.slice(0, 8)})`) || l.includes(`(knowledge_get ${rec.id})`));

for (const [surface, input] of [
  ['question', askQuestion],
  ['dispatch', dispatch],
]) {
  test(`${surface} surface: a decision another record supersedes is never labelled [standing] and names its superseder`, () => {
    const { dir, store, cleanup } = makeProject();
    try {
      const { oldRec, newRec } = seedPartialSupersession(store);
      const ctx = ctxOf(runHook(input(dir), dir));
      const line = lineOf(ctx, oldRec);
      assert.ok(line, `the superseded decision is still pointed at (its edge may be partial):\n${ctx}`);
      assert.doesNotMatch(line, /\[standing\]/, `a superseded decision must not read as standing:\n${line}`);
      assert.match(line, /SUPERSEDED/, `the line says it is superseded:\n${line}`);
      assert.ok(line.includes(`${NEW_SLUG} (${newRec.id.slice(0, 8)})`), `the line names the superseder as name (id8):\n${line}`);
    } finally {
      cleanup();
    }
  });

  test(`${surface} surface CONTROL: a decision with no inbound supersedes edge keeps its [standing] marker and no SUPERSEDED note`, () => {
    const { dir, store, cleanup } = makeProject();
    try {
      const d = store.create(decisionRecord(OLD_SLUG, OLD_TITLE, OLD_STATEMENT));
      const ctx = ctxOf(runHook(input(dir), dir));
      const line = lineOf(ctx, d);
      assert.ok(line, `the decision is delivered:\n${ctx}`);
      assert.match(line, /\[standing\]/);
      assert.doesNotMatch(ctx, /SUPERSEDED/);
    } finally {
      cleanup();
    }
  });

  test(`${surface} surface: the superseding decision itself is not marked superseded`, () => {
    const { dir, store, cleanup } = makeProject();
    try {
      const { newRec } = seedPartialSupersession(store);
      const ctx = ctxOf(runHook(input(dir), dir));
      const line = lineOf(ctx, newRec);
      assert.ok(line, `the superseder is delivered:\n${ctx}`);
      assert.match(line, /\[standing\]/, `the live superseder keeps its authority:\n${line}`);
      assert.doesNotMatch(line, /SUPERSEDED/, `nothing supersedes the superseder:\n${line}`);
    } finally {
      cleanup();
    }
  });
}

test('dispatch surface: a decision retired through supersede() is not delivered at all', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const oldRec = store.create(decisionRecord(OLD_SLUG, OLD_TITLE, OLD_STATEMENT));
    const newRec = store.supersede(oldRec.id, decisionRecord(NEW_SLUG, NEW_TITLE, NEW_STATEMENT));
    assert.equal(store.get(oldRec.id).status, 'superseded', 'precondition: supersede() retires the old record');
    const ctx = ctxOf(runHook(dispatch(dir), dir));
    assert.ok(!ctx.includes(oldRec.id.slice(0, 8)), `a retired decision is never pointed at:\n${ctx}`);
    assert.ok(ctx.includes(newRec.id), `its successor is:\n${ctx}`);
  } finally {
    cleanup();
  }
});

test('pointer helpers: a superseder that is itself no longer active carries its status, so the reader can follow the chain', async () => {
  const { supersededAnnotation, authorityMarker } = await import(pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href);
  const rec = {
    authority: 'standing',
    inbound_supersedes: [
      { id: 'aaaaaaaa-0000-0000-0000-000000000000', slug: 'live-one', status: 'active' },
      { id: 'bbbbbbbb-0000-0000-0000-000000000000', title: 'Retired one', status: 'superseded' },
    ],
  };
  assert.equal(authorityMarker(rec), '');
  assert.equal(authorityMarker({ authority: 'standing' }), '[standing] ');
  assert.equal(
    supersededAnnotation(rec),
    ' [SUPERSEDED, whole or in part, by live-one (aaaaaaaa); Retired one (bbbbbbbb, superseded): read it before relying on this]'
  );
  assert.equal(supersededAnnotation({ authority: 'standing' }), '');
});
