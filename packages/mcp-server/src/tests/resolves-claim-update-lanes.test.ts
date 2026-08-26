import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// EXTENSION of resolves-claim.test.ts's contract (decision
// 68988832-2ef5-4ff3-b693-4f0f0ea8dae1) to three additional maintenance-queue
// lanes: stale_research, wire_in_dormant, state_review. Per board item
// 4afbfa56 ("resolves LANE COVERAGE — investigated 2026-08-25"): these three
// lanes already have a fulfilling-write discharge shape (knowledge_update),
// wireable exactly like reconcile_needed/refresh_reference — tranche (a) of
// the awaited ruling. This file pins that widening is IN and SCOPED: the
// three new lanes close via resolves, an unclaimed item in a new lane still
// warns (never silently drains), a wrong-lane item (capture_owed,
// deletion_candidate — whose discharging write is knowledge_create /
// knowledge_retire, not knowledge_update) is still refused, and the
// pre-existing reconcile_needed lane is undisturbed by the widening.
//
// This file does NOT edit the frozen resolves-claim.test.ts — it is a new,
// separate suite following that file's harness and assertion patterns
// exactly (widen() cast, openIds() via maintenanceQuery, idOf() drain-log
// tolerance, knowledgeUpdateResult().warnings for the unclaimed case).

const NOW = '2026-06-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-resolves-lanes-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

const mkArticle = (tools: SterlingTools, slug: string, path: string) =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does',
    intended_behavior: 'b',
    files: [{ path, role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record;

type Resolving = {
  knowledgeUpdate(id: string, patch: Record<string, unknown>, resolves?: string[]): unknown;
  knowledgeUpdateResult(id: string, patch: Record<string, unknown>, resolves?: string[]): { record: Record<string, unknown>; warnings: string[] };
};
const widen = (tools: SterlingTools) => tools as unknown as Resolving;

function idOf(result: unknown): string | undefined {
  const r = result as { removed?: string; id?: string };
  return r.removed ?? r.id;
}

function openIds(tools: SterlingTools): string[] {
  return (tools.maintenanceQuery({ cap: 1000 }) as unknown as { id: string }[]).map((t) => t.id);
}

// --- CLOSURE: one pin per new lane -----------------------------------------

test('AC-EXT1: knowledge_update resolves closes a stale_research item — drain-log proof matches AC1', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing-sr', 'src/thing-sr.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'stale_research',
      text: `research on 'thing-sr' has aged out`,
      file_keys: ['src/thing-sr.ts'],
      feature_link: article.id,
    });
    assert.equal(openIds(tools).length, 1, 'precondition: one open item');

    widen(tools).knowledgeUpdate(article.id, { what_it_does: 'refreshed' }, [item.id]);

    assert.ok(!openIds(tools).includes(item.id), 'the named stale_research item is gone from the open queue');
    const proof = tools.maintenanceRemove(item.id) as { removed?: string; id?: string; already_drained?: boolean };
    assert.equal(proof.already_drained, true, 'the resolves-claim removal left the same drain-log trace maintenance_remove would have');
    assert.equal(idOf(proof), item.id);
  } finally {
    cleanup();
  }
});

test('AC-EXT2: knowledge_update resolves closes a wire_in_dormant item — drain-log proof matches AC1', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing-wid', 'src/thing-wid.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'wire_in_dormant',
      text: `'thing-wid' has a dormant wiring gap`,
      file_keys: ['src/thing-wid.ts'],
      feature_link: article.id,
    });
    assert.equal(openIds(tools).length, 1, 'precondition: one open item');

    widen(tools).knowledgeUpdate(article.id, { what_it_does: 'wired' }, [item.id]);

    assert.ok(!openIds(tools).includes(item.id), 'the named wire_in_dormant item is gone from the open queue');
    const proof = tools.maintenanceRemove(item.id) as { removed?: string; id?: string; already_drained?: boolean };
    assert.equal(proof.already_drained, true, 'the resolves-claim removal left the same drain-log trace maintenance_remove would have');
    assert.equal(idOf(proof), item.id);
  } finally {
    cleanup();
  }
});

test('AC-EXT3: knowledge_update resolves closes a state_review item — drain-log proof matches AC1', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing-sv', 'src/thing-sv.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'state_review',
      text: `'thing-sv' metadata may contradict its code`,
      file_keys: ['src/thing-sv.ts'],
      feature_link: article.id,
    });
    assert.equal(openIds(tools).length, 1, 'precondition: one open item');

    widen(tools).knowledgeUpdate(article.id, { what_it_does: 'state corrected' }, [item.id]);

    assert.ok(!openIds(tools).includes(item.id), 'the named state_review item is gone from the open queue');
    const proof = tools.maintenanceRemove(item.id) as { removed?: string; id?: string; already_drained?: boolean };
    assert.equal(proof.already_drained, true, 'the resolves-claim removal left the same drain-log trace maintenance_remove would have');
    assert.equal(idOf(proof), item.id);
  } finally {
    cleanup();
  }
});

// --- CONTROL: the widening is scoped, not blanket --------------------------

test('AC-EXT4 (control): resolves naming a capture_owed item refuses — that lane discharges via knowledge_create, not knowledge_update', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing-co', 'src/thing-co.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'capture_owed',
      text: `capture owed for 'thing-co'`,
      file_keys: ['src/thing-co.ts'],
      feature_link: article.id,
    });
    const before = tools.knowledgeGet(article.id) as unknown as { version: number };

    assert.throws(
      () => widen(tools).knowledgeUpdate(article.id, { what_it_does: 'x' }, [item.id]),
      (err: Error) => {
        assert.match(err.message, new RegExp(item.id), 'names the offending id');
        assert.match(err.message, /capture_owed/, 'and names the wrong-lane reason');
        return true;
      },
      'a capture_owed item cannot be claimed through knowledge_update resolves'
    );
    const after = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the capture_owed item is untouched — still open');
  } finally {
    cleanup();
  }
});

test('AC-EXT5 (control): resolves naming a deletion_candidate item refuses — that lane discharges via knowledge_retire, not knowledge_update', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing-dc', 'src/thing-dc.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'deletion_candidate',
      text: `'thing-dc' file has no git history`,
      file_keys: ['src/thing-dc.ts'],
      feature_link: article.id,
    });
    const before = tools.knowledgeGet(article.id) as unknown as { version: number };

    assert.throws(
      () => widen(tools).knowledgeUpdate(article.id, { what_it_does: 'x' }, [item.id]),
      (err: Error) => {
        assert.match(err.message, new RegExp(item.id), 'names the offending id');
        assert.match(err.message, /deletion_candidate/, 'and names the wrong-lane reason');
        return true;
      },
      'a deletion_candidate item cannot be claimed through knowledge_update resolves'
    );
    const after = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the deletion_candidate item is untouched — still open');
  } finally {
    cleanup();
  }
});

// --- UNCLAIMED: named vs unnamed, in the same call --------------------------

test('AC-EXT6 (partial claim across new lanes): resolves naming the stale_research item drains it; the sibling wire_in_dormant item stays open and is named in the warning', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing-mix', 'src/thing-mix.ts');
    const { record: claimed } = tools.maintenanceEnqueue({
      reason: 'stale_research',
      text: `research on 'thing-mix' has aged out`,
      file_keys: ['src/thing-mix.ts'],
      feature_link: article.id,
    });
    const { record: unclaimed } = tools.maintenanceEnqueue({
      reason: 'wire_in_dormant',
      text: `'thing-mix' has a dormant wiring gap`,
      file_keys: ['src/thing-mix.ts'],
      feature_link: article.id,
    });

    const result = widen(tools).knowledgeUpdateResult(article.id, { what_it_does: 'partially resolved' }, [claimed.id]);

    assert.ok(!openIds(tools).includes(claimed.id), 'the named stale_research item drained');
    assert.ok(openIds(tools).includes(unclaimed.id), 'the unnamed wire_in_dormant item stays open');
    assert.ok(
      result.warnings.some((w) => w.includes(unclaimed.id)),
      'the receipt warns, naming the still-open wire_in_dormant item — not a silent leave-behind'
    );
    assert.ok(
      !result.warnings.some((w) => w.includes(claimed.id)),
      'and does not warn about the one it just closed'
    );
  } finally {
    cleanup();
  }
});

test('AC-EXT6b: an unclaimed state_review item on an otherwise-clean write is still named in the warning', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing-sv2', 'src/thing-sv2.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'state_review',
      text: `'thing-sv2' metadata may contradict its code`,
      file_keys: ['src/thing-sv2.ts'],
      feature_link: article.id,
    });

    const result = widen(tools).knowledgeUpdateResult(article.id, { state: 'active' });

    assert.ok(openIds(tools).includes(item.id), 'the unclaimed state_review item stays open');
    assert.ok(
      result.warnings.some((w) => w.includes(item.id)),
      'the receipt names the open state_review item even though the write did not touch it'
    );
  } finally {
    cleanup();
  }
});

// --- REGRESSION: the pre-existing lane is undisturbed -----------------------

test('AC-EXT7 (regression): reconcile_needed still closes via resolves after the lane widening', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing-regress', 'src/thing-regress.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'thing-regress'`,
      file_keys: ['src/thing-regress.ts'],
      feature_link: article.id,
    });
    assert.equal(openIds(tools).length, 1, 'precondition: one open item');

    widen(tools).knowledgeUpdate(article.id, { what_it_does: 'reconciled' }, [item.id]);

    assert.ok(!openIds(tools).includes(item.id), 'reconcile_needed still drains via resolves — the widening did not regress the original lane');
  } finally {
    cleanup();
  }
});
