// Decision a-supersedes-link-on-create-or-update-is-refused-use-knowledge-supersede
// (board ec9789f0), at the tool surface: knowledge_create and knowledge_update
// refuse a links entry with rel 'supersedes', write nothing, and point to
// knowledge_supersede or rel 'cites'. knowledge_supersede and cites links keep
// working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-10-03T12:00:00.000Z';

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-raw-supersedes-tools-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function mkDecision(tools: SterlingTools, title: string, overrides: Loose = {}): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement: `${title} statement`,
    alternatives_rejected: [],
    rationale: 'r',
    ...overrides,
  }).record as unknown as Loose;
}

const REFUSAL = /rel 'supersedes'[\s\S]*knowledge_supersede[\s\S]*'cites'[\s\S]*Nothing was written/;

test('knowledge_create with a supersedes link is refused and nothing is written', () => {
  const { store, tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'old ruling');
    const before = store.query({ types: ['decision'], cap: 100 }).length;
    assert.throws(() => mkDecision(tools, 'new ruling', { links: [{ rel: 'supersedes', target_id: old.id }] }), REFUSAL);
    assert.equal(store.query({ types: ['decision'], cap: 100 }).length, before, 'no record was written');
    assert.equal(store.get(old.id as string)?.status, 'active', 'the old record is untouched');
    assert.deepEqual(store.inboundSupersedes(old.id as string), [], 'no supersedes edge onto the old record');
  } finally {
    cleanup();
  }
});

test('knowledge_update adding a supersedes link is refused and nothing is written', () => {
  const { store, tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'old ruling');
    const rec = mkDecision(tools, 'new ruling');
    assert.throws(() => tools.knowledgeUpdate(rec.id as string, { links: [{ rel: 'supersedes', target_id: old.id }] }), REFUSAL);
    const after = store.get(rec.id as string) as unknown as { version: number; links: unknown[] };
    assert.equal(after.version, 1, 'no version was written');
    assert.deepEqual(after.links, []);
    assert.deepEqual(store.inboundSupersedes(old.id as string), []);
  } finally {
    cleanup();
  }
});

test('knowledge_supersede still writes the edge and retires the old record', () => {
  const { store, tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'old ruling');
    const res = tools.knowledgeSupersede(old.id as string, {
      title: 'replacement ruling',
      statement: 'replacement statement',
      alternatives_rejected: [],
      rationale: 'r',
    });
    assert.equal(res.superseded, old.id);
    assert.equal(store.get(old.id as string)?.status, 'superseded');
    assert.equal(store.get(old.id as string)?.superseded_by, res.id);
    // The successor already holds the edge, so an update that keeps it passes.
    const updated = tools.knowledgeUpdate(res.id, { rationale: 'edited' }) as unknown as { version: number };
    assert.equal(updated.version, 2);
  } finally {
    cleanup();
  }
});

test('a cites link still works on knowledge_create and knowledge_update', () => {
  const { store, tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'old ruling');
    const a = mkDecision(tools, 'partial override', { links: [{ rel: 'cites', target_id: old.id }] });
    assert.deepEqual(a.links, [{ rel: 'cites', target_id: old.id }]);
    const b = mkDecision(tools, 'another ruling');
    tools.knowledgeUpdate(b.id as string, { links: [{ rel: 'cites', target_id: old.id }] });
    assert.deepEqual((store.get(b.id as string) as unknown as { links: unknown[] }).links, [{ rel: 'cites', target_id: old.id }]);
    assert.equal(store.get(old.id as string)?.status, 'active');
  } finally {
    cleanup();
  }
});
