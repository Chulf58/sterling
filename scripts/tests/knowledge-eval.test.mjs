import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addWorktree, aggregateMetricValues, DEFAULT_PROJECTS, emittedLevel, linkNodeModules, lockfilesEquivalent, mrrFromHistogram, parseCaseDirectives, patchAdapter, resolveProjects, scoreEventIndexes, caseProject, pluginTree, removeWorktrees, replayCommit, runWithCleanup, scorePull, scorePush, withWorktreeLedger } from '../knowledge-eval.mjs';
import { PG_COPY_BATCH_CHARS, PG_PUSH_SKIP_REASON, ProjectsRequiredError, errorKind, isPgBackend, openPgEvalRun, pgRanking, pairedComparison, parseBackendFlag, parseBackends, pgChecksumSql, requireProjects, runKey } from '../knowledge-eval.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const id = '11111111-1111-4111-8111-111111111111';
const r = { id, title: 'Hazard', trigger: 'exact trigger text', right_way: 'exact right way text', guidance: 'distinctive guidance passage' };
test('pointer-only is not substance', () => assert.deepEqual(emittedLevel(id, r), { pointer: true, substance: false, whole: false, clipped: false, withheldOversize: false }));
test('H20 rendered decision pointers remain discovery, not substance', () => {
  const envelope = readFileSync(new URL('./fixtures/knowledge-eval/h20-decision-pointer-envelope.txt', import.meta.url), 'utf8');
  const record = { id: '276cd235-2455-4b0c-bb52-9f592138c3a4', slug: 'review-sparsely-before-commit-ledger-kept', title: "Sterling's review posture", statement: 'Sparse review before commit with NO enforcement' };
  const score = scorePush({ envelopes: [envelope], labels: { required: [{ id: record.id, level: 'pointer' }] }, recordsById: { [record.id]: record } });
  assert.deepEqual(score.timely.discovery, [1, 1]); assert.deepEqual(score.timely.substance, [0, 0]);
});
const h20Header = 'STERLING MECHANISM-AXIS DELIVERY (H20) — you have just dispatched an agent; the brief has already gone out.';
const h20DecisionBlock = (statement, decisionId) => `▸ DECISIONS for this subject (1) — why it is this way and what was rejected. Pointers only; follow one before contradicting it:\n  → ${statement} (knowledge_get ${decisionId})`;
test('a hazard rendered whole scores substance even when the same H20 envelope carries a decision pointer block', () => {
  const envelope = `${h20Header}\n\n⚠ ANTI-PATTERN [WARN] for this subject — '${r.title}' [hazard-slug] (full record: knowledge_get ${id})\nTRIGGER: ${r.trigger}\nRIGHT WAY: ${r.right_way}\n\n${h20DecisionBlock('Some other ruling, clipped…', '22222222-2222-4222-8222-222222222222')}`;
  assert.deepEqual(emittedLevel(envelope, r), { pointer: true, substance: true, whole: true, clipped: false, withheldOversize: false });
  const score = scorePush({ envelopes: [envelope], labels: { required: [{ id, level: 'hazard_whole' }] }, recordsById: { [id]: r } });
  assert.deepEqual(score.timely.substance, [1, 1]); assert.deepEqual(score.wholeHazard, [1, 1]);
});
test('a decision shown only as an H20 pointer excerpt scores no substance, with or without a whole hazard beside it', () => {
  const ruling = { id: '22222222-2222-4222-8222-222222222222', slug: 'some-ruling', title: 'Some ruling', statement: 'A ruling whose opening passage is long enough to count as a passage.' };
  const pointerOnly = `${h20Header}\n\n${h20DecisionBlock(ruling.statement, ruling.id)}`;
  assert.deepEqual(emittedLevel(pointerOnly, ruling), { pointer: true, substance: false, whole: false, clipped: false, withheldOversize: false });
  const besideHazard = `${h20Header}\n\n⚠ ANTI-PATTERN [WARN] for this subject — '${r.title}' [hazard-slug] (full record: knowledge_get ${id})\nTRIGGER: ${r.trigger}\nRIGHT WAY: ${r.right_way}\n\n${h20DecisionBlock(ruling.statement, ruling.id)}`;
  assert.equal(emittedLevel(besideHazard, ruling).substance, false);
});
test('MRR derives from rank histogram, not summed ranks',() => assert.equal(mrrFromHistogram({ 2: 1, 4: 1 }), 0.375));
test('MRR counts positive misses in its denominator', () => assert.equal(mrrFromHistogram({ 1: 1, miss: 1 }), 0.5));
test('knowledge get bare record is normalized for pull scoring', () => assert.deepEqual(scorePull({ id }, { required: [{ id }] }).recall.at1, [1, 1]));
test('Agent input score selects both dispatch hooks, ending at child start', () => assert.deepEqual(scoreEventIndexes([{ tool: 'Read' }, { tool: 'Agent' }], 1), [1, 2]));
test('metric aggregation preserves numeric pairs and de-duplicates id lists', () => {
  assert.deepEqual(aggregateMetricValues([[1, 2], [3, 4]]), [4, 6]);
  assert.deepEqual(aggregateMetricValues([['a', 'b'], ['b', 'c']]), { ids: ['a', 'b', 'c'], count: 3 });
});
test('case directives parse config, mutation, and lifecycle', () => {
  assert.deepEqual(parseCaseDirectives(`ordinary narrative\nconfig: injection_rung=edit\nmutate: ${id} revision\nlifecycle: clear`), [
    { kind: 'config', key: 'injection_rung', value: 'edit' }, { kind: 'mutate', id }, { kind: 'lifecycle', source: 'clear' },
  ]);
  assert.throws(() => parseCaseDirectives('lifecycle: rotate'), /invalid lifecycle directive/);
  assert.throws(() => parseCaseDirectives('unknown: value'), /unknown case directive/);
});
test('project mapping defaults and allows an explicit project root override', () => {
  assert.deepEqual(resolveProjects(), DEFAULT_PROJECTS);
  assert.equal(resolveProjects('{"dome-farmer":"/tmp/dome"}')['dome-farmer'], '/tmp/dome');
  assert.throws(() => resolveProjects('[]'), /JSON object/);
});
test('clipped hazard is not whole', () => assert.equal(emittedLevel(`${id} exact trigger text`, r).whole, false));
test('cross-reference UUID is not substance', () => assert.equal(emittedLevel(`see ${id} for background`, r).substance, false));
test('late drain is not timely', () => { const s = scorePush({ envelopes: [`${id} exact trigger text exact right way text`], labels: { required: [{ id, level: 'hazard_whole' }] }, recordsById: { [id]: r }, late: true }); assert.deepEqual(s.timely.substance, [0, 1]); assert.equal(s.late, 1); });
test('a sequence scores only its selected Read event', () => {
  const bashPointer = `${id}`;
  const readSubstance = `${id} exact trigger text exact right way text`;
  const s = scorePush({ envelopes: [readSubstance], labels: { required: [{ id, level: 'hazard_whole' }] }, recordsById: { [id]: r } });
  assert.deepEqual(emittedLevel(bashPointer, r), { pointer: true, substance: false, whole: false, clipped: false, withheldOversize: false });
  assert.deepEqual(s.timely.substance, [1, 1]);
});
test('late envelopes are counted late and never timely', () => {
  const s = scorePush({ envelopes: [], lateEnvelopes: [`${id} exact trigger text exact right way text`], labels: { required: [{ id, level: 'hazard_whole' }] }, recordsById: { [id]: r } });
  assert.deepEqual(s.timely.substance, [0, 1]); assert.equal(s.late, 1); assert.equal(s.lateEnvelopes, 1);
});
test('noise counts mentioned records outside the case labels', () => {
  const noiseId = '22222222-2222-4222-8222-222222222222';
  const s = scorePush({ envelopes: [`${id} ${noiseId}`], labels: { required: [{ id, level: 'pointer' }], acceptable: [] }, recordsById: { [id]: r, [noiseId]: { id: noiseId } } });
  assert.equal(s.noise, 1);
});
test('a guard mark without emitted content is a false substance mark', () => {
  const s = scorePush({ envelopes: [id], labels: { required: [{ id, level: 'substance' }] }, recordsById: { [id]: r }, guardBefore: {}, guardAfter: { 'guard.json': JSON.stringify({ delivered: [id] }) } });
  assert.deepEqual(s.timely.substance, [0, 1]); assert.equal(s.falseSubstanceMarks, 1);
});
test('a whole hazard block is counted whole, never clipped or withheld', () => {
  const envelope = `⚠ ANTI-PATTERN [WARN] for this path — '${r.title}' [hazard-slug] (full record: knowledge_get ${id})\nTRIGGER: ${r.trigger}\nRIGHT WAY: ${r.right_way}`;
  assert.deepEqual(emittedLevel(envelope, r), { pointer: true, substance: true, whole: true, clipped: false, withheldOversize: false });
});
test('a hazard with an elision inside its own block is NOT whole, and is counted clipped', () => {
  // TRIGGER: and RIGHT WAY: are both present verbatim (hazardSubstance would
  // credit it whole under the old logic), but the same localized block also
  // carries an elision — scripts/hooks/lib/delivery.mjs never clips a hazard's
  // own trigger/right_way (renderHazards' only caller passes an unbounded char
  // cap), so this simulates a block-local degrade the scorer must still catch.
  const envelope = `⚠ ANTI-PATTERN [WARN] for this path — '${r.title}' [hazard-slug] (full record: knowledge_get ${id})\nTRIGGER: ${r.trigger}\nRIGHT WAY: ${r.right_way}\n… 1 related note NOT shown for this hazard`;
  assert.deepEqual(emittedLevel(envelope, r), { pointer: true, substance: true, whole: false, clipped: true, withheldOversize: false });
});
test('a TOO-LARGE withheld-oversize pointer is NOT whole, and is counted withheld — never clipped, never silence', () => {
  // Real marker copied from a recorded f567a92 envelope (485b603b, decision
  // `delivery-floor-and-transport-ceiling-constants` 97c313a8's hazardOverflowPointer):
  // '⚠ ANTI-PATTERN [WARN] for this path — TOO LARGE to show in full (exceeds the
  // transport limit) · knowledge_get 485b603b-ddcc-4e5c-be6c-85786271cbd4'.
  const withheldId = '485b603b-ddcc-4e5c-be6c-85786271cbd4';
  const withheldRecord = { id: withheldId, title: 'parallel-lanes-each-define-the-shared-enum', trigger: 'dispatch two lanes', right_way: 'grep the two definitions' };
  const envelope = `⚠ ANTI-PATTERN [WARN] for this path — TOO LARGE to show in full (exceeds the transport limit) · knowledge_get ${withheldId}`;
  assert.deepEqual(emittedLevel(envelope, withheldRecord), { pointer: true, substance: false, whole: false, clipped: false, withheldOversize: true });
});
test('nothing delivered is none of whole, clipped, or withheld', () => {
  assert.deepEqual(emittedLevel('unrelated text', r), { pointer: false, substance: false, whole: false, clipped: false, withheldOversize: false });
});
test('a literal "..." inside a hazard\'s own authored prose is whole, never clipped — only the single-character ellipsis is a clip marker', () => {
  // Real trap, dome-farmer record ce103428 ("A mech death PAUSES THE TREE..."):
  // its own right_way is a code sample containing "# ... assert here, in the
  // same call ..." as authored placeholder text, not a delivery elision.
  const codeRecord = { id, title: r.title, trigger: r.trigger, right_way: 'do_the_thing() # ... assert here, in the same call ...' };
  const envelope = `⚠ ANTI-PATTERN [WARN] for this path — '${codeRecord.title}' [hazard-slug] (full record: knowledge_get ${id})\nTRIGGER: ${codeRecord.trigger}\nRIGHT WAY: ${codeRecord.right_way}`;
  assert.deepEqual(emittedLevel(envelope, codeRecord), { pointer: true, substance: true, whole: true, clipped: false, withheldOversize: false });
});
test('scorePush separates whole, clipped, and withheld-oversize hazard outcomes into their own counters', () => {
  const wholeEnvelope = `⚠ ANTI-PATTERN [WARN] for this path — '${r.title}' [hazard-slug] (full record: knowledge_get ${id})\nTRIGGER: ${r.trigger}\nRIGHT WAY: ${r.right_way}`;
  const wholeScore = scorePush({ envelopes: [wholeEnvelope], labels: { required: [{ id, level: 'hazard_whole' }] }, recordsById: { [id]: r } });
  assert.deepEqual(wholeScore.wholeHazard, [1, 1]);
  assert.deepEqual(wholeScore.clippedHazard, [0, 1]);
  assert.deepEqual(wholeScore.withheldOversize, [0, 1]);

  const clippedEnvelope = `⚠ ANTI-PATTERN [WARN] for this path — '${r.title}' [hazard-slug] (full record: knowledge_get ${id})\nTRIGGER: ${r.trigger}\nRIGHT WAY: ${r.right_way}\n… 1 related note NOT shown for this hazard`;
  const clippedScore = scorePush({ envelopes: [clippedEnvelope], labels: { required: [{ id, level: 'hazard_whole' }] }, recordsById: { [id]: r } });
  assert.deepEqual(clippedScore.wholeHazard, [0, 1]);
  assert.deepEqual(clippedScore.clippedHazard, [1, 1]);
  assert.deepEqual(clippedScore.withheldOversize, [0, 1]);

  const withheldId = '485b603b-ddcc-4e5c-be6c-85786271cbd4';
  const withheldRecord = { id: withheldId, title: 'x', trigger: 'x', right_way: 'y' };
  const withheldEnvelope = `⚠ ANTI-PATTERN [WARN] for this path — TOO LARGE to show in full (exceeds the transport limit) · knowledge_get ${withheldId}`;
  const withheldScore = scorePush({ envelopes: [withheldEnvelope], labels: { required: [{ id: withheldId, level: 'hazard_whole' }] }, recordsById: { [withheldId]: withheldRecord } });
  assert.deepEqual(withheldScore.wholeHazard, [0, 1]);
  assert.deepEqual(withheldScore.clippedHazard, [0, 1]);
  assert.deepEqual(withheldScore.withheldOversize, [1, 1]);
});
test('real H19 push-read capture is discovery and substance despite delivery clipping', () => {
  const record = {
    id: '6976b7c5-3ac9-4267-92df-d5a31e6c8724', slug: 'store-database-seal-h15',
    title: 'H15 store database seal — the one rule that survives the scale-down',
    what_it_does: 'H15 is a PreToolUse hook registered (hooks/hooks.json) on Bash|PowerShell and on Edit|Write|MultiEdit|NotebookEdit. It enforces ONE rule: nothing but the Sterling MCP server touches the store DATABASE — `.sterling/sterling.db` and its siblings (`sterling.db-wal`, `-shm`, `-journal`, `sterling.db.*` backup/migration files). Every other file under `.sterling/` (config.json, transient/*, delivery-audit/*, review-ledger.json) is ordinary project state that any tool may read or write. Structured channel: the destination path (tool_input.file_path, or notebook_path for NotebookEdit) is resolved against cwd; denied (exit 2) when it carries a `.sterling` directory component AND its basename matches the database-file pattern.',
  };
  const envelope = readFileSync(new URL('./fixtures/knowledge-eval/v1/push-read-001-h19-envelope.txt', import.meta.url), 'utf8');
  const score = scorePush({ envelopes: [envelope], labels: { required: [{ id: record.id, level: 'substance' }] }, recordsById: { [record.id]: record }, guardBefore: {}, guardAfter: { 'delivery/guard-conductor.json': JSON.stringify({ records: [record.id] }) } });
  assert.deepEqual(score.timely.discovery, [0, 0]);
  assert.deepEqual(score.timely.substance, [1, 1]);
  assert.equal(score.falseSubstanceMarks, 0);
});

function worktreeFixture() {
  const base = mkdtempSync(join(tmpdir(), 'knowledge-eval-wt-'));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  git('init', '-q'); writeFileSync(join(repo, 'a.txt'), 'a');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const shared = join(base, 'shared'); mkdirSync(shared); writeFileSync(join(shared, 'sentinel'), 'keep');
  const worktrees = () => git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
  return { base, repo, head: git('rev-parse', 'HEAD').trim(), shared, worktrees };
}
test('every worktree a run creates is removed when the run throws, without following symlinks out of it', async () => {
  const f = worktreeFixture();
  try {
    assert.equal(f.worktrees().length, 1);
    await assert.rejects(withWorktreeLedger(async (ledger) => {
      for (const id of ['case-a', 'case-b']) {
        const tree = join(f.base, 'work', 'projects', f.head, id);
        addWorktree(ledger, f.repo, tree, f.head);
        symlinkSync(f.shared, join(tree, 'node_modules'), 'dir');
      }
      assert.equal(f.worktrees().length, 3);
      throw new Error('case exploded');
    }), /case exploded/);
    assert.equal(f.worktrees().length, 1);
    assert.equal(existsSync(join(f.base, 'work', 'projects', f.head, 'case-a')), false);
    assert.equal(readFileSync(join(f.shared, 'sentinel'), 'utf8'), 'keep');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
test('a completed run removes its worktrees and returns the run result', async () => {
  const f = worktreeFixture();
  try {
    const result = await withWorktreeLedger(async (ledger) => { addWorktree(ledger, f.repo, join(f.base, 'work', 'worktrees', f.head), f.head); return 'summary'; });
    assert.equal(result, 'summary');
    assert.equal(f.worktrees().length, 1);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
test('removeWorktrees releases one case worktree mid-run and leaves the ledger empty', () => {
  const f = worktreeFixture();
  try {
    const ledger = [];
    addWorktree(ledger, f.repo, join(f.base, 'case'), f.head);
    removeWorktrees(ledger);
    assert.deepEqual(ledger, []);
    assert.equal(f.worktrees().length, 1);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
function replayFixture(f) {
  const workDir = join(f.base, 'work'); const snap = join(f.base, 'snap');
  mkdirSync(join(snap, 'projects', 'sterling-main'), { recursive: true }); writeFileSync(join(snap, 'projects', 'sterling-main', 'project.db'), 'db');
  const projectSnapshot = { root: f.repo, head: f.head };
  const openCase = (c, ledger) => caseProject(f.head, workDir, c.id, snap, 'sterling-main', projectSnapshot, {}, false, ledger);
  return { workDir, openCase, onCaseError: (c, error) => ({ id: c.id, error }) };
}
test('replayCommit removes each case worktree at case end and the plugin tree at commit end, even when a case throws', async () => {
  const f = worktreeFixture(); const r = replayFixture(f);
  try {
    const seen = [];
    const summary = await replayCommit({ workDir: r.workDir, repos: [f.repo], cases: [{ id: 'c1' }, { id: 'c2', boom: true }, { id: 'c3' }],
      setup: (ledger) => pluginTree(f.repo, f.head, r.workDir, ledger),
      runCase: async (c, tree, { ledger }) => { seen.push(f.worktrees().length); assert.ok(existsSync(tree)); r.openCase(c, ledger); if (c.boom) throw new Error('case exploded'); return { id: c.id }; },
      onCaseError: r.onCaseError, finish: (tree, scored) => scored });
    assert.deepEqual(seen, [2, 2, 2]);
    assert.equal(summary[1].error.message, 'case exploded');
    assert.equal(f.worktrees().length, 1);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
test('replayCommit reaps a killed prior run\'s plugin and case worktrees under this work-dir only', async () => {
  const f = worktreeFixture(); const r = replayFixture(f);
  const git = (...args) => { const x = spawnSync('git', args, { cwd: f.repo, encoding: 'utf8' }); assert.equal(x.status, 0, x.stderr); };
  try {
    git('worktree', 'add', '--detach', join(r.workDir, 'worktrees', f.head), f.head);
    git('worktree', 'add', '--detach', join(r.workDir, 'projects', f.head, 'sterling-main', 'c1'), f.head);
    git('worktree', 'lock', join(r.workDir, 'projects', f.head, 'sterling-main', 'c1'));
    const outside = [join(`${r.workDir}-sibling`, 'projects', 'x'), join(f.base, 'elsewhere')];
    for (const p of outside) git('worktree', 'add', '--detach', p, f.head);
    assert.equal(f.worktrees().length, 5);
    await replayCommit({ workDir: r.workDir, repos: [f.repo], cases: [{ id: 'c1' }],
      setup: (ledger) => pluginTree(f.repo, f.head, r.workDir, ledger),
      runCase: async (c, tree, { ledger }) => { r.openCase(c, ledger); return { id: c.id }; },
      onCaseError: (c, error) => { throw error; }, finish: (tree, scored) => scored });
    assert.equal(f.worktrees().length, 3);
    for (const p of outside) assert.ok(existsSync(join(p, 'a.txt')), p);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
test('a failing store close still removes the case worktree, and both errors are recorded, never replaced', async () => {
  const f = worktreeFixture(); const r = replayFixture(f);
  try {
    const summary = await replayCommit({ workDir: r.workDir, repos: [f.repo], cases: [{ id: 'c1' }],
      setup: (ledger) => pluginTree(f.repo, f.head, r.workDir, ledger),
      runCase: async (c, tree, { ledger, onClose }) => { r.openCase(c, ledger); onClose(() => { throw new Error('close broke'); }); throw new Error('case broke'); },
      onCaseError: r.onCaseError, finish: (tree, scored) => scored });
    assert.ok(summary[0].error instanceof AggregateError);
    assert.deepEqual(summary[0].error.errors.map((e) => e.message), ['case broke', 'close broke']);
    assert.match(String(summary[0].error), /case broke.*close broke/);
    assert.equal(f.worktrees().length, 1);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
test('removeWorktrees keeps a failed entry in the ledger for retry and still removes the rest', () => {
  const f = worktreeFixture();
  try {
    const ledger = [];
    addWorktree(ledger, f.repo, join(f.base, 'good'), f.head);
    const bogus = { repo: f.repo, path: join(f.base, 'never-a-worktree') };
    ledger.unshift(bogus);
    assert.throws(() => removeWorktrees(ledger), /never-a-worktree/);
    assert.deepEqual(ledger, [bogus]);
    assert.equal(f.worktrees().length, 1);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
test('runWithCleanup aggregates an execution failure with a cleanup failure and runs every cleanup step', async () => {
  let ran = false;
  const err = await runWithCleanup(async () => { throw new Error('run broke'); }, () => [() => { throw new Error('remove broke'); }, () => { ran = true; }]).catch((e) => e);
  assert.ok(err instanceof AggregateError);
  assert.deepEqual(err.errors.map((e) => e.message), ['run broke', 'remove broke']);
  assert.equal(ran, true);
});
test('v2 gold set: ids are unique, every required label is a uuid, and each dilution case names a required record', () => {
  const cases = readFileSync(new URL('./fixtures/knowledge-eval/v2/cases.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  const dilution = cases.filter((c) => c.id.startsWith('d-'));
  assert.equal(dilution.length, 13);
  for (const c of dilution) {
    assert.ok(['preflight', 'dispatch'].includes(c.kind), c.id);
    assert.ok(c.labels.required.length > 0 && c.labels.required.every((l) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(l.id)), c.id);
    assert.equal(c.negative, false);
  }
});
test('lockfilesEquivalent ignores the package version bump but not a dependency change', () => {
  const lock = (version, dep) => JSON.stringify({ name: 'x', version, packages: { '': { name: 'x', version }, 'node_modules/typescript': { version: dep } } });
  assert.equal(lockfilesEquivalent(lock('0.18.59', '5.9.2'), lock('0.18.61', '5.9.2')), true);
  assert.equal(lockfilesEquivalent(lock('0.18.59', '5.9.2'), lock('0.18.59', '5.9.3')), false);
});
test('linkNodeModules points @sterling at the tree\'s own packages and every other entry at the source', () => {
  const base = mkdtempSync(join(tmpdir(), 'kev-nm-'));
  try {
    const source = join(base, 'main', 'node_modules'); const tree = join(base, 'tree');
    mkdirSync(join(source, '@sterling'), { recursive: true }); mkdirSync(join(source, 'left-pad'), { recursive: true }); mkdirSync(join(source, '.bin'), { recursive: true });
    symlinkSync('../../packages/store', join(source, '@sterling', 'store'), 'dir');
    mkdirSync(join(tree, 'packages', 'store'), { recursive: true });
    linkNodeModules(source, tree);
    assert.equal(realpathSync(join(tree, 'node_modules', '@sterling', 'store')), realpathSync(join(tree, 'packages', 'store')));
    assert.equal(realpathSync(join(tree, 'node_modules', 'left-pad')), realpathSync(join(source, 'left-pad')));
    assert.equal(realpathSync(join(tree, 'node_modules', '.bin')), realpathSync(join(source, '.bin')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
// patchAdapter makes a built store open its snapshot read-only. The store's
// constructor changed shape at the driver seam, so it knows two builds.
const PRE_SEAM_NEEDLE = 'this.db = new DatabaseSync(path);';
const POST_SEAM_NEEDLE = 'this.db = options.driver ?? new SqliteDriver(path, { busyTimeoutMs: options.busyTimeoutMs });';
const ADAPTER_MARK = 'knowledge-eval adapter: snapshot schema lacks records';
function storeDistTree(files) {
  const tree = mkdtempSync(join(tmpdir(), 'kev-adapter-'));
  const dist = join(tree, 'packages', 'store', 'dist'); mkdirSync(dist, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dist, name), text);
  return { tree, read: (name) => readFileSync(join(dist, name), 'utf8') };
}
test('patchAdapter patches a pre-seam store build: the constructor opens read-only and returns early', () => {
  const t = storeDistTree({ 'index.js': `class SterlingStore {\n    constructor(path) {\n        ${PRE_SEAM_NEEDLE}\n        this.db.exec('PRAGMA busy_timeout=5000');\n    }\n}\n` });
  try {
    const sha = patchAdapter(t.tree); const out = t.read('index.js');
    assert.match(sha, /^[0-9a-f]{64}$/);
    assert.ok(out.includes('this.db = new DatabaseSync(path, { readOnly: true });'));
    assert.ok(out.includes(ADAPTER_MARK) && out.includes("this.openedSchemaVersion = this.db.prepare('PRAGMA user_version').get().user_version;"));
    assert.ok(out.indexOf('return; // evaluation-only') < out.indexOf("this.db.exec('PRAGMA busy_timeout=5000')"), 'the early return sits before the open-time writes');
    assert.equal(patchAdapter(t.tree), sha, 'a second call changes nothing');
    assert.equal(t.read('index.js'), out);
  } finally { rmSync(t.tree, { recursive: true, force: true }); }
});
test('patchAdapter patches a post-seam store build: the SQLite driver opens read-only and the store constructor returns early', () => {
  const t = storeDistTree({
    'index.js': `class SterlingStore {\n    constructor(path, options = {}) {\n        ${POST_SEAM_NEEDLE}\n        const foundSchemaVersion = this.db.schemaVersion();\n        this.db.prepareWritable(isFresh);\n    }\n}\n`,
    'sqlite-driver.js': `class SqliteDriver {\n    constructor(path, options = {}) {\n        ${PRE_SEAM_NEEDLE}\n        this.db.exec(\`PRAGMA busy_timeout=\${busyTimeoutMs}\`);\n    }\n}\n`,
  });
  try {
    const sha = patchAdapter(t.tree); const index = t.read('index.js'); const driver = t.read('sqlite-driver.js');
    assert.match(sha, /^[0-9a-f]{64}$/);
    assert.ok(driver.includes('this.db = new DatabaseSync(path, { readOnly: true });') && !driver.includes(PRE_SEAM_NEEDLE));
    assert.ok(index.includes(POST_SEAM_NEEDLE), 'the store still opens its driver');
    assert.ok(index.includes(ADAPTER_MARK) && index.includes('this.openedSchemaVersion = this.db.schemaVersion();'));
    assert.ok(index.indexOf(POST_SEAM_NEEDLE) < index.indexOf('return; // evaluation-only'));
    assert.ok(index.indexOf('return; // evaluation-only') < index.indexOf('this.db.prepareWritable(isFresh)'), 'the early return sits before the open-time writes');
    assert.equal(patchAdapter(t.tree), sha, 'a second call changes nothing');
    assert.equal(t.read('index.js'), index); assert.equal(t.read('sqlite-driver.js'), driver);
  } finally { rmSync(t.tree, { recursive: true, force: true }); }
});
test('patchAdapter refuses a store build with neither constructor shape, naming both needles, and writes nothing', () => {
  const unknown = 'class SterlingStore {\n    constructor(path) {\n        this.db = openSomethingElse(path);\n    }\n}\n';
  const t = storeDistTree({ 'index.js': unknown });
  try {
    assert.throws(() => patchAdapter(t.tree), (e) => e.message.includes('adapter seam missing') && e.message.includes(PRE_SEAM_NEEDLE) && e.message.includes(POST_SEAM_NEEDLE));
    assert.equal(t.read('index.js'), unknown);
  } finally { rmSync(t.tree, { recursive: true, force: true }); }
});
test('patchAdapter refuses a post-seam store whose SQLite driver does not open the way it expects, and leaves the store unpatched', () => {
  const index = `class SterlingStore {\n    constructor(path, options = {}) {\n        ${POST_SEAM_NEEDLE}\n    }\n}\n`;
  const t = storeDistTree({ 'index.js': index, 'sqlite-driver.js': 'class SqliteDriver {\n    constructor(path) {\n        this.db = openSomethingElse(path);\n    }\n}\n' });
  try {
    assert.throws(() => patchAdapter(t.tree), (e) => e.message.includes('adapter seam missing') && e.message.includes('sqlite-driver.js') && e.message.includes(PRE_SEAM_NEEDLE));
    assert.equal(t.read('index.js'), index, 'a half-patched store would skip its open steps on a writable connection');
  } finally { rmSync(t.tree, { recursive: true, force: true }); }
});
test('patchAdapter matches the store build of this tree', () => {
  // The fixtures above are hand-written; this is the one that fails when the
  // real constructor drifts from the needles.
  const dist = join(fileURLToPath(new URL('../..', import.meta.url)), 'packages', 'store', 'dist');
  const files = { 'index.js': readFileSync(join(dist, 'index.js'), 'utf8') };
  if (existsSync(join(dist, 'sqlite-driver.js'))) files['sqlite-driver.js'] = readFileSync(join(dist, 'sqlite-driver.js'), 'utf8');
  const t = storeDistTree(files);
  try {
    assert.match(patchAdapter(t.tree), /^[0-9a-f]{64}$/);
    assert.ok(t.read('index.js').includes(ADAPTER_MARK));
  } finally { rmSync(t.tree, { recursive: true, force: true }); }
});

// --backend, the run key, and --projects.
test('parseBackends defaults to sqlite, accepts sqlite, pg and a comma list, and refuses anything else naming the choices', () => {
  assert.deepEqual(parseBackends(undefined), ['sqlite']);
  assert.deepEqual(parseBackends('sqlite'), ['sqlite']);
  assert.deepEqual(parseBackends('pg'), ['pg']);
  assert.deepEqual(parseBackends('sqlite,pg'), ['sqlite', 'pg']);
  assert.deepEqual(parseBackends('sqlite,pg:bm25,pg:tsrank_cd'), ['sqlite', 'pg:bm25', 'pg:tsrank_cd'], 'pg:<ranking> names a ranking candidate');
  for (const bad of ['pg:', 'pg:BM25', 'sqlite:bm25', 'pg:bm25,pg:bm25']) assert.throws(() => parseBackends(bad), /--backend must be/, JSON.stringify(bad));
  for (const bad of ['postgres', '', 'pg,', 'pg,pg', 'sqlite;pg']) assert.throws(() => parseBackends(bad), /--backend must be sqlite or pg/, JSON.stringify(bad));
});
test('parseBackendFlag reads --backend from argv: absent is sqlite, present needs a value', () => {
  assert.deepEqual(parseBackendFlag(['node', 'knowledge-eval.mjs', '--commits', 'abc']), ['sqlite']);
  assert.deepEqual(parseBackendFlag(['node', 'x', '--backend', 'pg', '--commits', 'abc']), ['pg']);
  assert.deepEqual(parseBackendFlag(['node', 'x', '--backend', 'sqlite,pg']), ['sqlite', 'pg']);
  assert.throws(() => parseBackendFlag(['node', 'x', '--backend']), /--backend needs a value/);
  assert.throws(() => parseBackendFlag(['node', 'x', '--backend', '--commits', 'abc']), /--backend needs a value/);
  assert.throws(() => parseBackendFlag(['node', 'x', '--backend', 'mysql']), /--backend must be/);
});
test('runKey keeps the bare commit for sqlite and separates every other backend, so two runs of one commit never share a directory', () => {
  assert.equal(runKey('abc123'), 'abc123');
  assert.equal(runKey('abc123', 'sqlite'), 'abc123');
  assert.equal(runKey('abc123', 'pg'), 'abc123@pg');
  assert.notEqual(runKey('abc123', 'sqlite'), runKey('abc123', 'pg'));
  assert.equal(runKey('abc123', 'pg:bm25'), 'abc123@pg-bm25');
  assert.notEqual(runKey('abc123', 'pg:bm25'), runKey('abc123', 'pg:tsrank_cd'));
  assert.throws(() => runKey('abc123', 'mysql'), /unknown backend/);
  assert.equal(isPgBackend('pg'), true); assert.equal(isPgBackend('pg:idf_tsrank'), true); assert.equal(isPgBackend('sqlite'), false);
  assert.equal(pgRanking('pg:idf_tsrank'), 'idf_tsrank'); assert.equal(pgRanking('pg'), undefined);
});
test('requireProjects demands --projects when a default project root is missing, naming the flag and the missing roots', () => {
  const none = () => false;
  assert.throws(() => requireProjects(undefined, none), (e) => e instanceof ProjectsRequiredError && e.name === 'ProjectsRequiredError' && e.message.includes('--projects is required') && Object.values(DEFAULT_PROJECTS).every((root) => e.message.includes(root)));
  assert.deepEqual(requireProjects(undefined, () => true), { projects: DEFAULT_PROJECTS, dropped: [] });
});
test('requireProjects with --projects drops a default root that does not exist here and was not named, and keeps what the caller named', () => {
  const onlyMine = (p) => p === '/tmp/mine';
  const { projects, dropped } = requireProjects('{"sterling-main":"/tmp/mine"}', onlyMine);
  assert.deepEqual(projects, { 'sterling-main': '/tmp/mine' });
  assert.deepEqual(dropped, ['dome-farmer']);
  const named = requireProjects('{"sterling-main":"/tmp/mine","dome-farmer":"/tmp/gone"}', onlyMine);
  assert.deepEqual(named.projects, { 'sterling-main': '/tmp/mine', 'dome-farmer': '/tmp/gone' }, 'a root the caller named is never dropped; its snapshot fails loudly instead');
  assert.deepEqual(named.dropped, []);
  assert.throws(() => requireProjects('[]', onlyMine), /JSON object/);
});
const caseResult = (id, extra = {}) => ({ id, case_schema: 'v2', label_sha256: 'h', score: { recall: { at1: [1, 1] } }, ...extra });
test('pairedComparison pairs one commit across backends and names each run by its key', () => {
  const sqlite = { commit: 'abc', backend: 'sqlite', key: runKey('abc', 'sqlite'), cases: [caseResult('c1'), caseResult('c2')] };
  const pg = { commit: 'abc', backend: 'pg', key: runKey('abc', 'pg'), cases: [caseResult('c1', { score: { recall: { at1: [0, 1] } } }), caseResult('c2', { error: 'PgSearchNotImplementedError: x', error_kind: 'PgSearchNotImplementedError' })] };
  const paired = pairedComparison([sqlite, pg]);
  assert.equal(paired.invalid, true);
  assert.deepEqual(paired.cases.c1.recall.at1, { before: [1, 1], after: [0, 1], delta: [-1, 0] });
  assert.equal(paired.invalid_reasons.length, 1);
  assert.match(paired.invalid_reasons[0], /case c2: harness error on abc@pg/);
  const missing = pairedComparison([sqlite, { ...pg, cases: [caseResult('c1')] }]);
  assert.match(missing.invalid_reasons[0], /case c2: result missing.*\[abc, abc@pg\].*got \[abc, missing\]/);
});
test('pairedComparison leaves a skipped case out of the deltas, lists it, and does not call the run invalid', () => {
  const sqlite = { commit: 'abc', key: 'abc', cases: [caseResult('c1'), caseResult('p1')] };
  const pg = { commit: 'abc', key: 'abc@pg', cases: [caseResult('c1'), caseResult('p1', { score: undefined, skipped: PG_PUSH_SKIP_REASON })] };
  const paired = pairedComparison([sqlite, pg]);
  assert.equal(paired.invalid, false);
  assert.deepEqual(Object.keys(paired.cases), ['c1']);
  assert.deepEqual(paired.skipped_cases, [{ id: 'p1', reason: 'push needs item 5 routing' }]);
  assert.equal(pairedComparison([sqlite, { ...sqlite, key: 'abc2' }]).skipped_cases, undefined, 'a run with nothing skipped reports as before');
});
test('errorKind names the first error of an aggregate, so a case error and its close error report as the case error', () => {
  assert.equal(errorKind(new RangeError('x')), 'RangeError');
  assert.equal(errorKind(new AggregateError([new TypeError('a'), new Error('b')], 'a; and b')), 'TypeError');
  assert.equal(errorKind('plain string'), 'unknown');
});
test('pgChecksumSql refuses any schema outside the eval run\'s sterling_test_ prefix and any table outside the store tables', () => {
  assert.match(pgChecksumSql('sterling_test_eval0a1b2c3d_1', 'records'), /"sterling_test_eval0a1b2c3d_1"\."records"/);
  for (const bad of ['sterling_p_0123456789abcdef0123456789abcdef', 'sterling_meta', 'public', 'sterling_test_x"; DROP SCHEMA y; --']) assert.throws(() => pgChecksumSql(bad, 'records'), /refusing/, bad);
  assert.throws(() => pgChecksumSql('sterling_test_eval0a1b2c3d_1', 'pg_user'), /refusing/);
});

test('openPgEvalRun passes a pg:<ranking> to every PgDriver it opens, and refuses a ranking the commit\'s store lacks', () => {
  const made = [];
  let factory;
  const fake = {
    PG_RANKINGS: ['bm25', 'tsrank_cd'],
    PgBridge: class { constructor() { this.closed = false; } query() { return { rows: [] }; } close() { this.closed = true; } },
    PgDriver: class { constructor(bridge, options) { made.push(options); } },
    SterlingStore: class {}, createPgStore() {}, ensurePgLayout() {}, readPgCredentials: () => ({}),
    setStoreDriverFactory: (f) => { factory = f; },
  };
  assert.throws(() => openPgEvalRun(fake, { wireSignals: false, ranking: 'idf_tsrank' }), /has no ranking 'idf_tsrank'/);
  assert.throws(() => openPgEvalRun({ ...fake, PG_RANKINGS: undefined }, { wireSignals: false, ranking: 'bm25' }), /has no ranking 'bm25'.*none/);
  const run = openPgEvalRun(fake, { wireSignals: false, ranking: 'tsrank_cd' });
  try {
    run.route('/tmp/x.db', `${run.prefix}_1`);
    factory('/tmp/x.db');
    assert.equal(made.at(-1).ranking, 'tsrank_cd');
  } finally { run.dispose(); }
  const plain = openPgEvalRun(fake, { wireSignals: false });
  try {
    plain.route('/tmp/x.db', `${plain.prefix}_1`);
    factory('/tmp/x.db');
    assert.equal('ranking' in made.at(-1), false, 'plain pg leaves the ranking to the store default');
  } finally { plain.dispose(); }
});

// The pg loader against Served. Needs STERLING_TEST_PG=1 and the credentials file, like the store's own pg tests.
test('the pg loader copies a SQLite snapshot row by row into a disposable schema, routes stores to it, and leaves no schema behind', { skip: process.env.STERLING_TEST_PG === '1' ? false : 'set STERLING_TEST_PG=1 to run against Served' }, async () => {
  const mod = await import(new URL('../../packages/store/dist/index.js', import.meta.url).href);
  const base = mkdtempSync(join(tmpdir(), 'kev-pg-'));
  const dbPath = join(base, 'sterling.db');
  const at = '2026-06-10T12:00:00.000Z';
  const decision = (title, links = []) => ({ id: randomUUID(), type: 'decision', created_at: at, updated_at: at, author: 'conductor', status: 'active', superseded_by: null, links, scope: 'project', stack_tags: ['node'], title, statement: `${title} statement about snapshots.`, alternatives_rejected: [{ option: 'none', reason: 'none' }], rationale: 'because', file_keys: ['scripts/knowledge-eval.mjs'] });
  const sqliteStore = new mod.SterlingStore(dbPath);
  const first = sqliteStore.create(decision('Snapshot one'));
  const second = sqliteStore.create(decision('Snapshot two', [{ rel: 'cites', target_id: first.id }]));
  sqliteStore.close();
  const fileHash = () => createHash('sha256').update(readFileSync(dbPath)).digest('hex');
  const before = fileHash();
  const run = openPgEvalRun(mod, { wireSignals: false });
  const catalog = () => { const bridge = new mod.PgBridge(mod.readPgCredentials()); try { return bridge.query('SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)', [`${run.prefix}_`]).rows.map((r) => r.nspname); } finally { bridge.close(); } };
  try {
    const { schema, counts } = run.loadStore(dbPath, 'test/project');
    assert.match(schema, /^sterling_test_eval[0-9a-f]{8}_1$/);
    assert.equal(counts.records, 2); assert.equal(counts.records_fts, 2); assert.equal(counts.record_relations, 1); assert.equal(counts.record_file_keys, 2);
    const src = new DatabaseSync(dbPath, { readOnly: true });
    try { assert.deepEqual(run.bridge.query(`SELECT id FROM "${schema}".records ORDER BY _seq`).rows.map((r) => r.id), src.prepare('SELECT id FROM records ORDER BY rowid').all().map((r) => r.id)); } finally { src.close(); }
    assert.equal(run.checksum([schema]), run.checksum([schema]), 'a read leaves the row checksum alone');
    // records_fts is rebuilt through the store's fold, so Postgres builds tsv and dl from the folded text and ranked search answers.
    const src2 = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const sqliteText = Object.fromEntries(src2.prepare('SELECT record_id, text FROM records_fts').all().map((r) => [r.record_id, r.text]));
      for (const row of run.bridge.query(`SELECT record_id, text, dl FROM "${schema}".records_fts`).rows) {
        assert.equal(row.text, mod.pgDialect.searchText(sqliteText[row.record_id]), 'the rebuilt text is the fold of the SQLite text');
        assert.equal(row.dl, row.text.split(' ').length);
      }
    } finally { src2.close(); }
    const routed = new mod.SterlingStore(dbPath);
    try {
      assert.deepEqual(routed.query({}).map((r) => r.id).sort(), [first.id, second.id].sort());
      assert.deepEqual(routed.query({ rank_terms: ['snapshot'] }).map((r) => r.id).sort(), [first.id, second.id].sort(), 'ranked search runs on the loaded copy');
      assert.deepEqual(routed.query({ rank_terms: ['Snapshot-two'] }).map((r) => r.id), [second.id], 'a phrase term');
      assert.equal(routed.scoreScale(), 'pg_bm25_v1');
    } finally { routed.close(); }
    const checksumBefore = run.checksum([schema]);
    run.bridge.query(`UPDATE "${schema}".records SET version = version + 1 WHERE id = '${first.id}'`);
    assert.notEqual(run.checksum([schema]), checksumBefore, 'a changed row changes the checksum');
  } finally { run.dispose(); }
  try {
    assert.deepEqual(catalog(), [], 'dispose drops the meta schema and every store schema');
    assert.equal(fileHash(), before, 'the snapshot file is never written');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
test('the pg loader splits a table whose rows exceed PG_COPY_BATCH_CHARS into several INSERTs and copies every row', { skip: process.env.STERLING_TEST_PG === '1' ? false : 'set STERLING_TEST_PG=1 to run against Served' }, async () => {
  const mod = await import(new URL('../../packages/store/dist/index.js', import.meta.url).href);
  const base = mkdtempSync(join(tmpdir(), 'kev-pg-big-'));
  const dbPath = join(base, 'sterling.db');
  const at = '2026-06-10T12:00:00.000Z';
  const sqliteStore = new mod.SterlingStore(dbPath);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(sqliteStore.create({ id: randomUUID(), type: 'decision', created_at: at, updated_at: at, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: ['node'], title: `Big ${i}`, statement: `bigword${i} `.repeat(Math.ceil(PG_COPY_BATCH_CHARS / 2 / 9)), alternatives_rejected: [{ option: 'none', reason: 'none' }], rationale: 'because', file_keys: [] }).id);
  sqliteStore.close();
  const run = openPgEvalRun(mod, { wireSignals: false });
  try {
    const { counts } = run.loadStore(dbPath, 'test/big');
    assert.equal(counts.records, 3); assert.equal(counts.records_fts, 3);
    const routed = new mod.SterlingStore(dbPath);
    try { assert.deepEqual(routed.query({ rank_terms: ['bigword1'] }).map((r) => r.id), [ids[1]]); } finally { routed.close(); }
  } finally { run.dispose(); rmSync(base, { recursive: true, force: true }); }
});
test('the pg loader rebuilds search text from the record, so words after a raw NUL stay searchable (node:sqlite reads TEXT only up to a NUL)', { skip: process.env.STERLING_TEST_PG === '1' ? false : 'set STERLING_TEST_PG=1 to run against Served' }, async () => {
  const mod = await import(new URL('../../packages/store/dist/index.js', import.meta.url).href);
  const base = mkdtempSync(join(tmpdir(), 'kev-pg-nul-'));
  const dbPath = join(base, 'sterling.db');
  const at = '2026-06-10T12:00:00.000Z';
  const sqliteStore = new mod.SterlingStore(dbPath);
  const made = sqliteStore.create({ id: randomUUID(), type: 'decision', created_at: at, updated_at: at, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: ['node'], title: 'Nul title', statement: 'before\u0000afterword tail', alternatives_rejected: [{ option: 'none', reason: 'none' }], rationale: 'because', file_keys: [] });
  assert.equal(sqliteStore.query({ rank_terms: ['afterword'] }).length, 1, 'precondition: FTS5 indexed the words after the NUL');
  sqliteStore.close();
  const src = new DatabaseSync(dbPath, { readOnly: true });
  try { assert.ok(!src.prepare('SELECT text FROM records_fts').get().text.includes('afterword'), 'precondition: node:sqlite returns the text cut at the NUL'); } finally { src.close(); }
  const run = openPgEvalRun(mod, { wireSignals: false });
  try {
    run.loadStore(dbPath, 'test/nul');
    const routed = new mod.SterlingStore(dbPath);
    try { assert.deepEqual(routed.query({ rank_terms: ['afterword'] }).map((r) => r.id), [made.id]); } finally { routed.close(); }
  } finally { run.dispose(); rmSync(base, { recursive: true, force: true }); }
});
