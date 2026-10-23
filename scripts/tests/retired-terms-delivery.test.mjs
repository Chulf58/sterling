// Retired terms on the delivery and hygiene surfaces (GitHub #188): H20's
// shared composition (composeMechanismAxis, also the OpenCode dispatch path)
// warns when a brief uses a retired term, with or without a subject match;
// the record-hygiene arm lists records still using one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeMechanismAxis } from '../hooks/lib/axis-compose.mjs';
import { retiredTermNotice } from '../hooks/lib/retired-terms.mjs';
import { auditRecords } from '../lib/record-hygiene.mjs';

const NOW = '2026-10-23T00:00:00.000Z';
const base = (type, extra) => ({
  id: randomUUID(), type, version: 1, status: 'active', superseded_by: null, created_at: NOW, updated_at: NOW, author: 'conductor', links: [], scope: 'project', stack_tags: [], ...extra,
});
const rename = base('decision', { slug: 'rename-north-barn', title: 'Rename North Barn to Hay Barn', statement: 'North Barn is now Hay Barn.', alternatives_rejected: [], rationale: 'r', retired_terms: [{ term: 'North Barn', replacement: 'Hay Barn' }] });
const fakeStore = (records) => ({
  query: ({ types }) => records.filter((r) => types.includes(r.type)),
  inboundSupersedes: () => [],
  retiredTermDecisions: () => records.filter((r) => r.type === 'decision' && r.status === 'active' && Array.isArray(r.retired_terms)),
});

function compose(records, outgoing) {
  const root = mkdtempSync(join(tmpdir(), 'h20-retired-'));
  try {
    return composeMechanismAxis(fakeStore(records), {
      root, outgoing, toolInput: { prompt: outgoing, subagent_type: 'implementor' }, surface: 'dispatch', subagentType: 'implementor', guardFor: () => ({}), host: 'claude', pinLine: 'PIN',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('H20: a brief using a retired term gets the advisory line even when no record matches its subject', () => {
  const composed = compose([rename], 'Write the feeding fixtures for the north barn schedule.');
  assert.ok(composed, 'the retired-term line alone produces a carriage');
  assert.match(composed.assembled.text, /STERLING RETIRED TERMS/);
  assert.match(composed.assembled.text, /retired term 'North Barn': renamed to 'Hay Barn' by decision rename-north-barn/);
  assert.match(composed.assembled.text, /PIN/, 'the model pin still rides the carriage');
});

test('H20: quoted uses and briefs without the term stay silent', () => {
  // The rename decision may still be delivered by subject; only the retired-term line must be absent.
  const text = (c) => (c ? c.assembled.text : '');
  assert.doesNotMatch(text(compose([rename], 'Write the feeding fixtures; the user once said "North Barn".')), /STERLING RETIRED TERMS/);
  assert.doesNotMatch(text(compose([rename], 'Write the feeding fixtures for the Hay Barn schedule.')), /STERLING RETIRED TERMS/);
});

test('H20: the line rides on a subject payload too, after the header', () => {
  const t = compose([rename], 'Rewire the feeding line in the North Barn before the turbine spins.').assembled.text;
  assert.match(t, /STERLING MECHANISM-AXIS DELIVERY \(H20\)/);
  assert.ok(t.indexOf('STERLING RETIRED TERMS') > t.indexOf('STERLING MECHANISM-AXIS DELIVERY'), 'the line follows the H20 header');
});

test('retiredTermNotice: a superseded rename retires nothing', () => {
  assert.equal(retiredTermNotice(fakeStore([{ ...rename, status: 'superseded' }]), 'north barn'), '');
});

test('record hygiene lists records still using a retired term and skips quotes, history and the rename itself', () => {
  const plain = base('decision', { title: 'Feed in North Barn', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: ['src/a.mjs'] });
  const quoted = base('decision', { title: 'Quote', statement: 'The user said "North Barn".', alternatives_rejected: [], rationale: 'r', file_keys: ['src/a.mjs'] });
  const { findings } = auditRecords([rename, plain, quoted], { headFiles: new Set(['src/a.mjs']) });
  const listed = findings.filter((f) => f.kind === 'retired_term_use');
  assert.deepEqual(listed.map((f) => f.ids[0]), [plain.id]);
  assert.match(listed[0].detail, /still uses retired term 'North Barn' \(now 'Hay Barn', decision rename-north-barn\) in title/);
});

test('retiredTermNotice: a failing scan becomes one loud line, and composeMechanismAxis still delivers the rest', () => {
  const broken = { ...fakeStore([rename]), retiredTermDecisions: () => { throw new Error('injected scan failure'); } };
  const line = retiredTermNotice(broken, 'north barn fixtures');
  assert.match(line, /retired-term check FAILED \(injected scan failure\).*NOT checked/);
  const root = mkdtempSync(join(tmpdir(), 'h20-retired-fault-'));
  try {
    const composed = composeMechanismAxis(broken, { root, outgoing: 'Feed the north barn cows', toolInput: { prompt: 'x' }, surface: 'dispatch', subagentType: 'implementor', guardFor: () => ({}), host: 'claude' });
    assert.match(composed.assembled.text, /retired-term check FAILED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
