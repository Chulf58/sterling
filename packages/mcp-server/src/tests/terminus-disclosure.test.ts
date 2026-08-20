// ---------------------------------------------------------------------------
// knowledge_get supersession-terminus disclosure (AC5/AC6/AC7 of the
// supersession-terminus-disclosure brief). Governing facts (verified):
//   - store.query() already excludes superseded records.
//   - store.get(id)/knowledge_get already returns a superseded record PINNED
//     (its own id, own fields) with its own status:'superseded' and a
//     one-hop superseded_by — decision de1a7329 rules ids stay
//     version-pinned; this change DISCLOSES the chain, it never redirects.
//   - the fix adds an additive `terminus` field: { id, status, hops } (plus
//     `truncated` when applicable), sourced from the new
//     SterlingStore.resolveTerminus(id) (see resolve-terminus.test.ts for its
//     own store-level spec).
//
// Written blind to tools.ts. On the current server, knowledge_get returns the
// pinned record with no `terminus` field at all, so every "terminus present"
// assertion below fails RED on `assert.ok(terminus, ...)` (terminus is
// `undefined`), never on a thrown error — the tool call itself succeeds
// today, it simply doesn't disclose anything past one hop yet.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-20T12:00:00.000Z';

interface TerminusField {
  id: string;
  status: string;
  hops: number;
  truncated?: boolean;
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-terminus-tool-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function terminusOf(record: unknown): TerminusField | undefined {
  return (record as Record<string, unknown>).terminus as TerminusField | undefined;
}

test('AC5: knowledge_get on a SUPERSEDED record adds a terminus field for the chain end; the pinned record\'s own fields are unchanged', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: a } = tools.knowledgeCreate('decision', {
      title: 'origin decision',
      statement: 'v1 statement',
      alternatives_rejected: [],
      rationale: 'v1 rationale',
    });
    const b = tools.knowledgeUpdate(a.id, { statement: 'v2 statement' });
    const c = tools.knowledgeUpdate(b.id, { statement: 'v3 statement' });

    const pinned = tools.knowledgeGet(a.id) as unknown as Record<string, unknown>;
    assert.equal(pinned.id, a.id, 'knowledge_get(a) still returns the PINNED a — never silently redirected (decision de1a7329)');
    assert.equal(pinned.status, 'superseded');
    assert.equal(pinned.superseded_by, b.id, 'the existing one-hop superseded_by is unchanged');
    assert.equal(pinned.statement, 'v1 statement', "the pinned record's own fields are untouched by the disclosure");

    const terminus = terminusOf(pinned);
    assert.ok(terminus, 'a superseded record carries a terminus field');
    assert.equal(terminus!.id, c.id, 'terminus resolves to the chain END (c), two hops from a — not to b');
    assert.equal(terminus!.status, 'active');
    assert.equal(terminus!.hops, 2);
  } finally {
    cleanup();
  }
});

test('AC6: knowledge_get on a LIVE record carries NO terminus field at all (no noise on the healthy path)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: a } = tools.knowledgeCreate('decision', {
      title: 'live decision',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    });
    const live = tools.knowledgeGet(a.id) as unknown as Record<string, unknown>;
    assert.equal(live.status, 'active');
    assert.ok(!('terminus' in live), 'a live record has no terminus key at all — not even null/undefined noise');
  } finally {
    cleanup();
  }
});

test("AC7 (retro 2026-08-15-1520 §3.2, the exact feedback defect): a two-hop chain discloses the TRUE terminus, not the one-hop pointer — a reader must not stop at hop one believing the record is merely one version stale", () => {
  const { tools, cleanup } = harness();
  try {
    const { record: origin } = tools.knowledgeCreate('decision', {
      title: 'origin',
      statement: 'origin body',
      alternatives_rejected: [],
      rationale: 'r',
    });
    const mid = tools.knowledgeUpdate(origin.id, { statement: 'mid body' });
    const end = tools.knowledgeUpdate(mid.id, { statement: 'end body' });

    const pinned = tools.knowledgeGet(origin.id) as unknown as Record<string, unknown>;
    const terminus = terminusOf(pinned);
    assert.ok(terminus, 'terminus must be present for a superseded origin');
    // THE DEFECT this AC exists to prevent: a fix that reads only
    // origin.superseded_by (one hop) and reports THAT as "the terminus" would
    // report mid.id here — leaving a reader believing the record is merely
    // one version stale when it is actually two hops behind a semantically
    // different end state.
    assert.notEqual(terminus!.id, pinned.superseded_by, 'terminus must not equal the one-hop pointer when the chain runs deeper');
    assert.equal(terminus!.id, end.id, 'terminus discloses the chain END, not hop one');
    assert.equal(terminus!.hops, 2);
  } finally {
    cleanup();
  }
});

test('AC5 truncation passthrough: a chain deeper than the traversal cap discloses truncated:true through knowledge_get too, and never claims the unreached true end', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: head } = tools.knowledgeCreate('decision', {
      title: 'chain head',
      statement: 's0',
      alternatives_rejected: [],
      rationale: 'r',
    });
    const headId = head.id;
    let current = head;
    // 40 supersessions — comfortably past a 32-hop traversal cap.
    for (let i = 1; i <= 40; i += 1) {
      current = tools.knowledgeUpdate(current.id, { statement: `s${i}` });
    }
    const trueEndId = current.id;

    const pinned = tools.knowledgeGet(headId) as unknown as Record<string, unknown>;
    const terminus = terminusOf(pinned);
    assert.ok(terminus, 'terminus present for the deeply superseded head');
    assert.equal(terminus!.truncated, true, 'a chain deeper than the traversal cap discloses truncated:true');
    assert.notEqual(terminus!.id, trueEndId, 'a truncated terminus never claims to be the true (unreached) chain end');
  } finally {
    cleanup();
  }
});
