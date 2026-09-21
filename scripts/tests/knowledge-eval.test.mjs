import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateMetricValues, DEFAULT_PROJECTS, emittedLevel, mrrFromHistogram, parseCaseDirectives, resolveProjects, scoreEventIndexes, scorePull, scorePush } from '../knowledge-eval.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const r = { id, title: 'Hazard', trigger: 'exact trigger text', right_way: 'exact right way text', guidance: 'distinctive guidance passage' };
test('pointer-only is not substance', () => assert.deepEqual(emittedLevel(id, r), { pointer: true, substance: false, whole: false, clipped: false, withheldOversize: false }));
test('H20 rendered decision pointers remain discovery, not substance', () => {
  const envelope = readFileSync(new URL('./fixtures/knowledge-eval/h20-decision-pointer-envelope.txt', import.meta.url), 'utf8');
  const record = { id: '276cd235-2455-4b0c-bb52-9f592138c3a4', slug: 'review-sparsely-before-commit-ledger-kept', title: "Sterling's review posture", statement: 'Sparse review before commit with NO enforcement' };
  const score = scorePush({ envelopes: [envelope], labels: { required: [{ id: record.id, level: 'pointer' }] }, recordsById: { [record.id]: record } });
  assert.deepEqual(score.timely.discovery, [1, 1]); assert.deepEqual(score.timely.substance, [0, 0]);
});
test('MRR derives from rank histogram, not summed ranks', () => assert.equal(mrrFromHistogram({ 2: 1, 4: 1 }), 0.375));
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
