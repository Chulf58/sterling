// Batch store replies (board f6c4bc5d): a caller of inboundSupersedesEach or
// queryEach reads element i only after checking the reply is exactly one array
// per item. A short or malformed reply is a failed lookup, never "no rows":
// read as empty, a superseded decision would render [standing] and a subject
// query would go silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withInboundSupersedesAll, assertBatchShape, BatchShapeError } from '../hooks/lib/delivery.mjs';
import { composeMechanismAxis } from '../hooks/lib/axis-compose.mjs';

const decision = (id) => ({ id, type: 'decision', title: `decision ${id}`, status: 'active', authority: 'standing' });

test('withInboundSupersedesAll: a short batch ([[]] for two records) marks BOTH supersession_unknown, never standing', () => {
  const store = { inboundSupersedesEach: () => [[]] };
  const out = withInboundSupersedesAll(store, [decision('a'), decision('b')]);
  assert.equal(out.length, 2);
  for (const r of out) {
    assert.match(r.supersession_unknown ?? '', /BatchShapeError|expected 2 array\(s\)/, `record ${r.id} is marked unknown`);
    assert.equal(r.inbound_supersedes, undefined);
  }
});

test('withInboundSupersedesAll: a non-array element or a non-array reply is a failed lookup for every record', () => {
  for (const reply of [[[], null], [[], {}], null, {}, [[], [], []]]) {
    const out = withInboundSupersedesAll({ inboundSupersedesEach: () => reply }, [decision('a'), decision('b')]);
    assert.ok(out.every((r) => typeof r.supersession_unknown === 'string'), `reply ${JSON.stringify(reply)}`);
  }
});

test('withInboundSupersedesAll: a well-shaped batch attaches each record its own successors', () => {
  const store = { inboundSupersedesEach: () => [[{ id: 's1', slug: 'succ', title: 'Successor', status: 'active' }], []] };
  const [a, b] = withInboundSupersedesAll(store, [decision('a'), decision('b')]);
  assert.deepEqual(a.inbound_supersedes, [{ id: 's1', slug: 'succ', title: 'Successor', status: 'active' }]);
  assert.equal(a.supersession_unknown, undefined);
  assert.deepEqual(b, decision('b'));
});

test('composeMechanismAxis: a short queryEach reply throws BatchShapeError instead of reading as no candidates', () => {
  const store = { queryEach: () => [[]], query: () => [] };
  assert.throws(
    () =>
      composeMechanismAxis(store, {
        root: '/nonexistent',
        outgoing: 'broker hooks dispatch scripts socket operation registry server',
        toolInput: {},
        surface: 'dispatch',
        subagentType: 'implementor',
        guardFor: () => ({}),
        pinLine: undefined,
        overlap: null,
        host: 'claude',
      }),
    (e) => e instanceof BatchShapeError && /queryEach: expected 6 array\(s\)/.test(e.message),
  );
});

test('assertBatchShape: exactly n arrays passes through; anything else throws by name', () => {
  const ok = [[], [1]];
  assert.equal(assertBatchShape(ok, 2, 'x'), ok);
  for (const bad of [[[]], [[], 1], undefined, 'no', [[], [], []]]) assert.throws(() => assertBatchShape(bad, 2, 'x'), BatchShapeError);
});
