// SubagentStart staging holds ONE hazard cap per package across its path and
// subject channels (decision knowledge-delivery-target-design-no-delayed-delivery,
// 92088a62: "HAZARDS: at most 3 per package"). Each channel used to call
// hazardParts at cap 3 on its own, so one package could carry six whole hazards.
// The path channel fills the cap first; the subject channel gets what is left,
// and anything beyond is disclosed by the omitted-count line.
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
const NOW = '2026-09-30T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function antiPattern(title, trigger, paths, tag) {
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
    title,
    trigger,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: `right way ${tag}`,
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: paths,
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-pkgcap-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const noTranscript = (dir) => join(dir, 'no-such-parent-transcript.jsonl');

/** Declare the dispatch through its real PreToolUse seam (h22), then fire SubagentStart. */
function stageAndStart(dir, prompt, agent_type = 'general-purpose') {
  const pre = spawnSync(process.execPath, [join(HOOKS, 'h22-dispatch-register.mjs')], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: `toolu_pc_${randomUUID().slice(0, 8)}`,
      tool_input: { subagent_type: agent_type, prompt, description: 'a lane' },
      session_id: 's1', cwd: dir, transcript_path: noTranscript(dir), prompt_id: 'p1',
    }),
    encoding: 'utf8', cwd: dir, timeout: 60_000,
  });
  assert.notEqual(pre.status, 2, pre.stderr);
  const r = spawnSync(process.execPath, [join(HOOKS, 'h19-dispatch-staging.mjs')], {
    input: JSON.stringify({
      hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'agent-1', agent_type,
      cwd: dir, transcript_path: noTranscript(dir), prompt_id: 'p1',
    }),
    encoding: 'utf8', cwd: dir, timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '';
}

const guardOf = (dir) => {
  const p = join(dir, '.sterling', 'transient', 'delivery', 's1', 'guard-agent-agent-1.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

// h19-staging-axis.test.mjs vocabulary: six domain words dominate the
// record's own top terms, so the subject match clears all three floors.
const SUBJECT_TRIGGER =
  'boolean modifier boolean modifier mesh manifold mesh manifold topology solver topology solver ' +
  'recur constantly though this bug rarely touches a game field cell during setup work';
const SUBJECT_PROMPT =
  'Investigate why the boolean operation corrupts the mesh: check whether the modifier stack ' +
  'introduces non-manifold geometry that breaks downstream processing.';

function seed(store, pathCount, subjectCount) {
  const path = Array.from({ length: pathCount }, (_, i) =>
    store.create(antiPattern(`Path hazard ${i} for the staged file`, `editing the staged file path case ${i}`, ['src/a.mjs'], `PATH_RW_${i}`))
  );
  const subject = Array.from({ length: subjectCount }, (_, i) =>
    store.create(antiPattern(`Boolean modifier mesh manifold topology solver stability failure ${i}`, SUBJECT_TRIGGER, [], `SUBJECT_RW_${i}`))
  );
  return { path, subject };
}

const wholeCount = (ctx) => (ctx.match(/^RIGHT WAY: /gm) ?? []).length;

test('staging: 3 path hazards plus 3 subject hazards emit at most 3 whole hazards, path channel first', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const { path, subject } = seed(store, 3, 3);
    const ctx = stageAndStart(dir, `Go work on src/a.mjs. ${SUBJECT_PROMPT}`);
    assert.ok(ctx.includes('STERLING MECHANISM-AXIS STAGING'), `fixture control: the subject channel matched:\n${ctx}`);
    assert.equal(wholeCount(ctx), 3, `one package, at most HAZARD_CAP (3) whole hazards:\n${ctx}`);
    for (let i = 0; i < 3; i++) assert.ok(ctx.includes(`PATH_RW_${i}`), `path hazard ${i} arrives whole (the path channel fills the cap first)`);
    for (let i = 0; i < 3; i++) assert.ok(!ctx.includes(`SUBJECT_RW_${i}`), `subject hazard ${i} is not rendered whole`);
    assert.match(ctx, /3 more hazard\(s\) NOT shown/, 'the subject hazards beyond the package cap are disclosed, not silently dropped');
    const guard = guardOf(dir);
    for (const r of path) assert.ok(guard.substance.some((e) => e.id === r.id));
    for (const r of subject) assert.ok(!guard.substance.some((e) => e.id === r.id) && !guard.discovery.some((e) => e.id === r.id), 'a disclosed-only hazard spends no mark');
  } finally {
    cleanup();
  }
});

test('staging: 1 path hazard leaves room for 2 subject hazards, and the third is disclosed', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seed(store, 1, 3);
    const ctx = stageAndStart(dir, `Go work on src/a.mjs. ${SUBJECT_PROMPT}`);
    assert.equal(wholeCount(ctx), 3, `the cap is shared, not per channel:\n${ctx}`);
    assert.ok(ctx.includes('PATH_RW_0'));
    assert.equal([0, 1, 2].filter((i) => ctx.includes(`SUBJECT_RW_${i}`)).length, 2, 'two subject hazards fill the remaining room');
    assert.match(ctx, /1 more hazard\(s\) NOT shown/);
  } finally {
    cleanup();
  }
});
