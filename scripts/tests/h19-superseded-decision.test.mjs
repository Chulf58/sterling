// REGRESSION: H19's file-touch decision pointers printed "[standing]" for a
// decision another record supersedes (the H19 half of the Dome Farmer
// 2026-10-02 incident, board 7e4850cf sub-item (c); the H20 half is pinned in
// h20-superseded-decision.test.mjs). The incident shape: the newer decision
// was created with links[{rel:'supersedes'}], which writes the edge but leaves
// the target active and live, so its own `authority: standing` still renders.
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
const FILE = 'game/sim/day_clock.gd';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h19-knowledge-delivery.mjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const envelope = (type) => ({
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
});

const article = (slug) => ({
  ...envelope('feature_article'),
  slug,
  title: slug,
  what_it_does: `${slug} does the ${slug} thing`,
  intended_behavior: `${slug} intends`,
  files: [{ path: FILE, role: 'owner' }],
  current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
  dependencies: { relies_on: [], relied_by: [] },
  state: 'active',
  version: 1,
  history: [],
  live_test_refs: [],
});

const decision = (slug, statement, extra = {}) => ({
  ...envelope('decision'),
  slug,
  title: statement,
  statement,
  alternatives_rejected: [],
  rationale: `${statement} rationale`,
  authority: 'standing',
  file_keys: [FILE],
  ...extra,
});

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-superseded-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: 'read' } }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  store.create(article('day-clock'));
  return {
    dir,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const postRead = (dir) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, FILE) },
  session_id: 's1',
  cwd: dir,
});

function ctxOf(r) {
  assert.equal(r.code, 0, `never blocks; stderr: ${r.stderr}`);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

// A record's own pointer line ends its pointer with `(knowledge_get <full id>)`.
const lineOf = (ctx, rec) => ctx.split('\n').find((l) => l.includes(`(knowledge_get ${rec.id})`));

const OLD_SLUG = 'one-day-is-150-seconds-peacetime-is-8-days';
const NEW_SLUG = 'fifteen-minute-day-one-third-night-game-speeds';

test('H19 file touch: a decision another record supersedes is never labelled [standing] and names its superseder', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const oldRec = store.create(decision(OLD_SLUG, 'One day is 150 seconds and peacetime is 8 days.'));
    const newRec = store.create(
      decision(NEW_SLUG, 'One day is 900 seconds and peacetime is about 2 days.', { links: [{ rel: 'supersedes', target_id: oldRec.id }] })
    );
    assert.equal(store.get(oldRec.id).status, 'active', 'precondition: the incident shape leaves the old record active');
    const ctx = ctxOf(runHook(postRead(dir), dir));
    const oldLine = lineOf(ctx, oldRec);
    assert.ok(oldLine, `the superseded decision is still pointed at (its edge may be partial):\n${ctx}`);
    assert.doesNotMatch(oldLine, /\[standing\]/, `a superseded decision must not read as standing:\n${oldLine}`);
    assert.ok(oldLine.includes(`SUPERSEDED, whole or in part, by ${NEW_SLUG} (${newRec.id.slice(0, 8)})`), `names the superseder:\n${oldLine}`);
    const newLine = lineOf(ctx, newRec);
    assert.ok(newLine, `the superseder is delivered:\n${ctx}`);
    assert.match(newLine, /\[standing\]/, 'the live superseder keeps its authority');
    assert.doesNotMatch(newLine, /SUPERSEDED/);
  } finally {
    cleanup();
  }
});

test('H19 file touch CONTROL: a decision with no inbound supersedes edge keeps [standing] and no SUPERSEDED note', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const d = store.create(decision(OLD_SLUG, 'One day is 150 seconds and peacetime is 8 days.'));
    const ctx = ctxOf(runHook(postRead(dir), dir));
    const line = lineOf(ctx, d);
    assert.ok(line, `the decision is delivered:\n${ctx}`);
    assert.match(line, /\[standing\]/);
    assert.doesNotMatch(ctx, /SUPERSEDED/);
  } finally {
    cleanup();
  }
});
