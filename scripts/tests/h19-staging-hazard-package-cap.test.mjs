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

function antiPattern(title, trigger, paths, tag, extra = {}) {
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
    ...extra,
  };
}

function decision(title, statement, paths) {
  return {
    id: randomUUID(), type: 'decision', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null,
    links: [], scope: 'project', stack_tags: [], title, statement,
    alternatives_rejected: [{ option: 'another way', reason: 'worse' }], rationale: 'rationale', file_keys: paths,
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

test('staging: the shared cap ranks BOTH channels by severity — a block subject hazard beats warn path hazards', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seed(store, 3, 0);
    const block = store.create(
      antiPattern('Boolean modifier mesh manifold topology solver stability failure block', SUBJECT_TRIGGER, [], 'SUBJECT_RW_BLOCK', { severity: 'block' })
    );
    const ctx = stageAndStart(dir, `Go work on src/a.mjs. ${SUBJECT_PROMPT}`);
    assert.equal(wholeCount(ctx), 3, ctx);
    assert.ok(ctx.includes('SUBJECT_RW_BLOCK'), `the block-severity subject hazard is whole, not merely disclosed:\n${ctx}`);
    assert.equal([0, 1, 2].filter((i) => ctx.includes(`PATH_RW_${i}`)).length, 2, 'two warn path hazards fill the rest');
    assert.match(ctx, /1 more hazard\(s\) NOT shown/, 'the third path hazard is disclosed');
    assert.ok(guardOf(dir).substance.some((e) => e.id === block.id));
  } finally {
    cleanup();
  }
});

// `/⚠ ANTI-PATTERN/` also matches a degrade notice, so the sweeps count WHOLE
// hazards (a RIGHT WAY line) and "delivery full" notices separately. The accepted
// trade, stated rather than hidden: a pinned header is never evicted, so once the
// pinned chrome plus two whole hazards leave no room for a third, the third
// degrades to a one-line "delivery full" notice (P5: disclosed, never silent).
// From `degradeFrom` bytes up that is exactly 2 whole + 1 notice; below it, 3 whole.
const deliveryFullCount = (ctx) => (ctx.match(/not shown whole: delivery full/g) ?? []).length;
function assertWholeVersusNotice(ctx, size, degradeFrom) {
  const [whole, notices] = size >= degradeFrom ? [2, 1] : [3, 0];
  assert.equal(wholeCount(ctx), whole, `~${size}B hazards: ${whole} whole:\n${ctx}`);
  assert.equal(deliveryFullCount(ctx), notices, `~${size}B hazards: ${notices} "delivery full" notice(s)`);
}
// Measured thresholds (the 2,900B path and 2,700B subject sizes are the first to degrade).
const PATH_DEGRADE_FROM = 2900;
const SUBJECT_DEGRADE_FROM = 2700;

// The staging headers are PINNED chrome (same class as the H20 header, commit
// e2d41d6): under disclosure pressure at the transport ceiling a whole hazard
// falls to its pointer before a header is evicted, so the lane never gets
// unattributed hazards. Swept because the defect lives in a narrow byte window.
for (const size of [2850, 2900, 2950, 3000, 3100, 3200]) {
  test(`staging: a write lane with three ~${size}B path hazards plus overflow keeps its header (P5: never unattributed)`, () => {
    const { dir, store, cleanup } = makeProject();
    try {
      for (let i = 0; i < 3; i++) {
        store.create(antiPattern(`Path hazard ${i} for the staged file`, `editing the staged file path case ${i}`, ['src/a.mjs'], `PATH_RW_${i} ${'r'.repeat(size)}`));
      }
      for (let i = 0; i < 4; i++) store.create(decision(`Staged file ruling ${i}`, `Ruling ${i} about the staged file. ${'s'.repeat(300)}`, ['src/a.mjs']));
      const ctx = stageAndStart(dir, 'Go work on src/a.mjs and report back.');
      assert.ok(Buffer.byteLength(ctx, 'utf8') <= 10000, `the transport ceiling holds (${Buffer.byteLength(ctx, 'utf8')})`);
      assert.match(ctx, /⚠ ANTI-PATTERN/, 'hazards are delivered');
      assertWholeVersusNotice(ctx, size, PATH_DEGRADE_FROM);
      assert.match(ctx.split('\n')[0], /^STERLING KNOWLEDGE DELIVERY \(H19\) — owning knowledge for 'src\/a\.mjs'/, `the header is the first line:\n${ctx.slice(0, 300)}`);
    } finally {
      cleanup();
    }
  });
}

for (const size of [2600, 2650, 2700, 2750, 2800, 2850]) {
  test(`staging: a write lane with three ~${size}B subject hazards plus overflow keeps the MECHANISM-AXIS STAGING header`, () => {
    const { dir, store, cleanup } = makeProject();
    try {
      for (let i = 0; i < 3; i++) {
        store.create(antiPattern(`Boolean modifier mesh manifold topology solver stability failure ${i}`, SUBJECT_TRIGGER, [], `SUBJECT_RW_${i} ${'r'.repeat(size)}`));
      }
      for (let i = 0; i < 4; i++) {
        store.create(decision(`Boolean modifier mesh manifold topology solver ruling ${i}`, `${SUBJECT_TRIGGER} ruling ${i} ${'s'.repeat(300)}`, []));
      }
      const ctx = stageAndStart(dir, SUBJECT_PROMPT);
      assert.ok(Buffer.byteLength(ctx, 'utf8') <= 10000, `the transport ceiling holds (${Buffer.byteLength(ctx, 'utf8')})`);
      assert.match(ctx, /⚠ ANTI-PATTERN/, 'hazards are delivered');
      assertWholeVersusNotice(ctx, size, SUBJECT_DEGRADE_FROM);
      assert.match(ctx, /^STERLING MECHANISM-AXIS STAGING \(H19\)/m, 'the subject header survives');
    } finally {
      cleanup();
    }
  });
}

// THE STAGING HEADER'S TERM LISTS ARE BOUNDED like H20's (user ruling
// 2026-09-24, finding df5d9f7d, decision 301d8a0a): the header is pinned, so an
// uncapped union of five records' terms is charged to the ordinary cap BEFORE
// the owner article body. Six terms are named, the rest counted.
test('staging: five subject records with ~10 central terms each cap both header term lists at 6 plus a count, and the owner article stays whole', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const groups = [
      ['granite', 'basalt', 'quartz', 'feldspar', 'obsidian', 'pumice'],
      ['violin', 'cello', 'oboe', 'bassoon', 'clarinet', 'trombone'],
      ['cobalt', 'nickel', 'zinc', 'tungsten', 'titanium', 'vanadium'],
      ['glacier', 'moraine', 'tundra', 'fjord', 'permafrost', 'drumlin'],
      ['sextant', 'compass', 'astrolabe', 'chronometer', 'quadrant', 'backstaff'],
    ];
    groups.forEach((words, g) => {
      const vocab = `${words.join(' ')} ${words.join(' ')} ${words.join(' ')}`;
      store.create(antiPattern(`${words.join(' ')} failure ${g}`, `${vocab} recur though this bug rarely touches a field`, [], `SUBJECT_RW_${g}`));
    });
    const OWNER_MARK = 'OWNER_BODY_DELIVERED_WHOLE';
    store.create({
      id: randomUUID(), type: 'feature_article', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null,
      links: [], scope: 'project', stack_tags: [], slug: 'staged-owner', title: 'staged-owner',
      what_it_does: `the staged owner does a thing ${OWNER_MARK}`, intended_behavior: 'owner intends',
      files: [{ path: 'src/a.mjs', role: 'owner' }],
      current_ac: [{ ac_id: 'AC1', text: 'owner works', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1, history: [], live_test_refs: [],
    });
    const prompt = `Go work on src/a.mjs. Investigate ${groups.flat().join(' ')} together.`;
    const ctx = stageAndStart(dir, prompt);
    const header = ctx.split('\n').find((l) => l.startsWith('STERLING MECHANISM-AXIS STAGING (H19)'));
    assert.ok(header, `fixture control: the subject header is present:\n${ctx}`);
    const m = /\(matched on: (.*?); central to the record: (.*?)\), beyond any file/.exec(header);
    assert.ok(m, `the header keeps its clause shape:\n${header}`);
    for (const [label, clause] of [['matched', m[1]], ['central', m[2]]]) {
      const named = clause.replace(/ \(\+\d+ more\)$/, '').split(', ');
      assert.ok(named.length <= 6, `${label} names at most 6 terms, got ${named.length}: ${clause}`);
      assert.match(clause, / \(\+\d+ more\)$/, `${label} counts the terms it did not name: ${clause}`);
    }
    assert.ok(ctx.includes(OWNER_MARK), `the owner article body is delivered whole:\n${ctx}`);
  } finally {
    cleanup();
  }
});

test('staging: a read-only lane keeps per-channel POINTER caps (decision 21e3637e, current behaviour)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', 'researcher.md'), ['---', 'name: researcher', 'tools: Read, Grep, Glob', '---', '# researcher', ''].join('\n'));
    seed(store, 3, 3);
    const ctx = stageAndStart(dir, `Go work on src/a.mjs. ${SUBJECT_PROMPT}`, 'researcher');
    assert.equal(wholeCount(ctx), 0, 'a read-only lane gets no whole hazard');
    assert.equal((ctx.match(/^⚠ ANTI-PATTERN \[WARN\] for this (path|subject) — '/gm) ?? []).length, 6, `three pointers per channel:\n${ctx}`);
    assert.doesNotMatch(ctx, /NOT shown/, 'nothing is withheld by a shared cap in pointer mode');
  } finally {
    cleanup();
  }
});
