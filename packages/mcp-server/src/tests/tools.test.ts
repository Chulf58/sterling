import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DurableRecord } from '@sterling/schemas';
import { REVIEWER_ROLES, parseConfig } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';
import { SterlingTools, type NoteExtractionPayload } from '../tools.js';

const NOW = '2026-06-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tools-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function harnessWithConfig(configOverrides: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tools-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, config: parseConfig(configOverrides) });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function startRun(store: SterlingStore, phases = ['p1', 'p2']) {
  return store.createRun({
    id: 'r-0001',
    brief_ref: randomUUID(),
    branch: 'sterling/run-r-0001',
    machine_state: 'running',
    phases: phases.map((id, i) => ({ id, status: i === 0 ? 'in_progress' : 'pending', signals: [], commits: [] })),
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
  });
}

test('knowledge_create assembles the envelope server-side and emits check_skipped (never silent — §16.1.9)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record, check_skipped } = tools.knowledgeCreate('decision', {
      title: 'Use SQLite',
      statement: 'SQLite it is.',
      alternatives_rejected: [],
      rationale: 'Fits the criteria.',
      stack_tags: ['node'],
    });
    assert.equal(record.type, 'decision');
    assert.equal(record.status, 'active');
    assert.equal(record.author, 'conductor');
    assert.match(record.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(check_skipped, [{ check: 'dedup-merge', reason: 'not_built' }]);
    assert.throws(() => tools.knowledgeCreate('escalation_log', { title: 'x' }), /unregistered record type/);
  } finally {
    cleanup();
  }
});

test('note_remove deletes a note outright and refuses non-notes; inbound cites survive (§3.2.6)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: note } = tools.knowledgeCreate('note', {
      raw_text: 'a user note, later spent',
      captured_at: NOW,
      capture_source: 'tui',
      derived: [],
    });
    const { record: extraction } = tools.knowledgeCreate('decision', {
      title: 'extracted',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
      links: [{ rel: 'cites', target_id: note.id }],
    });
    const { record: keeper } = tools.knowledgeCreate('note', {
      raw_text: 'another note that stays',
      captured_at: NOW,
      capture_source: 'command',
      derived: [],
    });

    assert.throws(() => tools.noteRemove(extraction.id), /not a note/);
    assert.throws(() => tools.noteRemove(randomUUID()), /no record/);

    assert.deepEqual(tools.noteRemove(note.id), { removed: note.id });
    assert.throws(() => tools.knowledgeGet(note.id), /no record/, 'the note is gone, not superseded');
    assert.deepEqual(
      tools.knowledgeQuery({ types: ['note'] }).map((r) => r.id),
      [keeper.id],
      'only the removed note left the Notes surface'
    );
    const survivor = tools.knowledgeGet(extraction.id);
    assert.ok(survivor.links.some((l) => l.rel === 'cites' && l.target_id === note.id), 'extraction stands alone with its cite intact');
  } finally {
    cleanup();
  }
});

test('knowledge_update writes a new version and supersedes the prior; article version auto-bumps', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: v1 } = tools.knowledgeCreate('feature_article', {
      slug: 'csv-export',
      title: 'CSV export',
      what_it_does: 'Exports the board.',
      intended_behavior: 'User clicks Export and gets a file.',
      files: [{ path: 'src/export/csv.ts', role: 'serializer' }],
      current_ac: [{ ac_id: 'AC1', text: 'export works', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'originating brief' }],
      live_test_refs: [],
    });
    const v2 = tools.knowledgeUpdate(v1.id, { what_it_does: 'Exports the board with headers.' });
    assert.equal((v2 as { version: number }).version, 2, 'version auto-bumped');
    assert.equal(tools.knowledgeGet(v1.id).status, 'superseded', 'prior retained and flagged');
    assert.ok(v2.links.some((l) => l.rel === 'supersedes' && l.target_id === v1.id));
    assert.equal(tools.knowledgeQuery({ types: ['feature_article'] }).length, 1, 'only current version retrieved');
  } finally {
    cleanup();
  }
});

test('knowledge_append extends an array without retransmitting it, and inherits the update path whole', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: v1 } = tools.knowledgeCreate('feature_article', {
      slug: 'csv-export',
      title: 'CSV export',
      what_it_does: 'Exports the board.',
      intended_behavior: 'User clicks Export and gets a file.',
      files: [{ path: 'src/export/csv.ts', role: 'serializer' }],
      current_ac: [{ ac_id: 'AC1', text: 'export works', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'originating brief' }],
      live_test_refs: [],
    });

    // THE POINT: one entry added, the existing entry NOT resent. That is the whole
    // reason this tool exists — the cost of keeping a record true was scaling with
    // how much truth it already held.
    const appended = tools.knowledgeAppend(v1.id, 'history', [{ date: NOW, event: 'second entry' }]);
    assert.deepEqual(appended.warnings, [], 'well under the oversize threshold — no warning');
    const v2 = appended.record as unknown as {
      id: string;
      history: { event: string }[];
      version: number;
      what_it_does: string;
      links: { rel: string; target_id: string }[];
    };
    assert.deepEqual(
      v2.history.map((h) => h.event),
      ['originating brief', 'second entry'],
      'appended in order, the prior entry preserved without being passed'
    );
    assert.equal(v2.what_it_does, 'Exports the board.', 'untouched fields carry over as with any update');

    // It must be the SAME write path, not a second one: version bump, prior
    // retained + supersede link, and only the head served.
    assert.equal(v2.version, 2, 'version auto-bumped exactly as knowledge_update does');
    assert.equal(tools.knowledgeGet(v1.id).status, 'superseded', 'prior version retained');
    assert.ok(v2.links.some((l) => l.rel === 'supersedes' && l.target_id === v1.id));
    assert.equal(tools.knowledgeQuery({ types: ['feature_article'] }).length, 1, 'only the head is served');

    // Any array field, not just history — and note the id CHANGED with the append,
    // which is the identity half of the problem this tool only half-solves.
    const v3 = tools.knowledgeAppend(v2.id, 'current_ac', [{ ac_id: 'AC2', text: 'header row included', verifiable_at: 'final' }]).record as unknown as {
      id: string;
      current_ac: { ac_id: string }[];
    };
    assert.deepEqual(
      v3.current_ac.map((a) => a.ac_id),
      ['AC1', 'AC2'],
      'current_ac extends too'
    );

    // Refusals — each names what to do instead rather than guessing (P5).
    const head = v3.id;
    assert.throws(() => tools.knowledgeAppend(head, 'history', []), /non-empty array/);
    assert.throws(() => tools.knowledgeAppend(head, 'what_it_does', ['more prose']), /not an array/);
    assert.throws(() => tools.knowledgeAppend(head, 'nonexistent_field', ['x']), /does not define/);
    assert.throws(() => tools.knowledgeAppend(head, 'links', [{ rel: 'cites', target_id: 'x' }]), /knowledge_link/);
    assert.throws(() => tools.knowledgeAppend(head, 'status', ['superseded']), /SERVER-OWNED/);
    assert.throws(() => tools.knowledgeAppend('no-such-id', 'history', [{ date: NOW, event: 'x' }]), /no record/);
  } finally {
    cleanup();
  }
});

test('knowledge_update WARNS when what_it_does changes but its paired fields were not passed — a warning, never a refusal', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');

    // The observed failure: revise the description, leave intended_behavior and
    // current_ac asserting the opposite, and nothing objects — the stale half then
    // reads as authoritative. One project shipped that four times in one session.
    const partial = tools.knowledgeUpdateResult(article.id, { what_it_does: 'does something else entirely now' });
    assert.equal(partial.warnings.length, 1);
    assert.match(partial.warnings[0], /intended_behavior and current_ac/, 'names exactly what was left behind');
    assert.match(partial.warnings[0], /WARNING, not a refusal/, 'and says why it is not blocking');
    assert.equal(
      (partial.record as unknown as { what_it_does: string }).what_it_does,
      'does something else entirely now',
      'the write LANDS — warning, not refusal'
    );

    // Passing the pairing clears it; so does an update that never touches the description.
    const head = (tools.knowledgeQuery({ types: ['feature_article'] })[0] as unknown as { id: string }).id;
    const coherent = tools.knowledgeUpdateResult(head, { what_it_does: 'x', intended_behavior: 'y', current_ac: [] });
    assert.deepEqual(coherent.warnings, [], 'no warning when the pairing is passed');
    const head2 = (tools.knowledgeQuery({ types: ['feature_article'] })[0] as unknown as { id: string }).id;
    assert.deepEqual(tools.knowledgeUpdateResult(head2, { state: 'active' }).warnings, [], 'a re-baseline refresh warns about nothing');
  } finally {
    cleanup();
  }
});

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

test('knowledge_update drains the article\'s drift maintenance items (reconcile_needed/refresh_reference) but RE-POINTS an open promotion_review rather than draining it — P4 lifecycle-bind + todo 6202a0f5', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    const other = mkArticle(tools, 'other', 'src/other.ts');
    // drift debt for `thing` the conductor is about to reconcile, a human-gated
    // promotion review for `thing`, and unrelated drift debt for `other`.
    tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: `reconcile 'thing'`, file_keys: ['src/thing.ts'], feature_link: article.id });
    tools.maintenanceEnqueue({ reason: 'refresh_reference', text: `refresh 'thing'`, file_keys: ['src/thing.ts'], feature_link: article.id });
    const review = tools.maintenanceEnqueue({ reason: 'promotion_review', text: `promote 'thing'`, feature_link: article.id });
    tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: `reconcile 'other'`, file_keys: ['src/other.ts'], feature_link: other.id });
    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 4);

    const updated = tools.knowledgeUpdate(article.id, { what_it_does: 'does, now reconciled' });

    const open = tools.maintenanceQuery({ cap: 1000 });
    const has = (reason: string, link: string) =>
      open.some((t) => (t as { system_reason?: string }).system_reason === reason && (t as { feature_link?: string }).feature_link === link);
    assert.equal(has('reconcile_needed', article.id), false, 'reconcile_needed drained by the reconcile');
    assert.equal(has('refresh_reference', article.id), false, 'refresh_reference drained by the reconcile');
    assert.equal(has('promotion_review', article.id), false, 'promotion_review no longer points at the now-superseded id — it must not strand there');
    assert.equal(has('promotion_review', updated.id), true, 'promotion_review re-pointed to the superseding version — same review, same lineage, still owed');
    assert.equal(open.length, 2, 'still exactly 2 open items: the unrelated other-article debt and the re-pointed review');
    assert.equal(has('reconcile_needed', other.id), true, "an unrelated article's debt is untouched");
    assert.equal(tools.maintenanceQuery({ cap: 1000 }).find((t) => t.id === review.record.id)?.id, review.record.id, 'same item id — re-pointed in place, not replaced');
  } finally {
    cleanup();
  }
});

test('knowledge_update re-points a promotion_review through the whole supersede CHAIN, and leaves other lanes/records untouched (todo 6202a0f5)', () => {
  const { tools, cleanup } = harness();
  try {
    const v1 = mkArticle(tools, 'thing', 'src/thing.ts');
    const review = tools.maintenanceEnqueue({ reason: 'promotion_review', text: `promote 'thing'`, feature_link: v1.id });
    const v2 = tools.knowledgeUpdate(v1.id, { what_it_does: 'v2' });
    // the review now points at v2 — reconcile again (v2 -> v3) and it must follow
    // via the chain, exactly as reconcile_needed already does for ancestor links.
    const v3 = tools.knowledgeUpdate(v2.id, { what_it_does: 'v3' });
    const item = tools.maintenanceQuery({ cap: 1000 }).find((t) => t.id === review.record.id) as unknown as { feature_link?: string } | undefined;
    assert.ok(item, 'the review item still exists — never drained');
    assert.equal(item?.feature_link, v3.id, 'followed the chain to the CURRENT version, not just the immediate successor');
  } finally {
    cleanup();
  }
});

test('article_oversize: under threshold, knowledge_update warns nothing and queues nothing (board 8390f8fa)', () => {
  const { tools, cleanup } = harnessWithConfig({ article_oversize_chars: 60000 });
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    // state-only change: no coherence warning in play, isolating the oversize check.
    const result = tools.knowledgeUpdateResult(article.id, { state: 'active' });
    assert.deepEqual(result.warnings, [], 'well under threshold — no warning');
    assert.equal(tools.maintenanceQuery({ system_reason: 'article_oversize', cap: 1000 }).length, 0, 'nothing queued');
  } finally {
    cleanup();
  }
});

test('article_oversize: over threshold, knowledge_update warns via the coherence-warning channel and queues exactly one deduped item', () => {
  // A tiny threshold makes the article oversize without needing a 60KB fixture.
  const { tools, cleanup } = harnessWithConfig({ article_oversize_chars: 200 });
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    // state-only change: no coherence warning in play, isolating the oversize check.
    const result = tools.knowledgeUpdateResult(article.id, { state: 'active' });
    assert.equal(result.warnings.length, 1, 'exactly one oversize warning');
    assert.match(result.warnings[0], /article_oversize_chars threshold/);
    assert.match(result.warnings[0], /'thing'/, 'names the article');
    assert.match(result.warnings[0], /split it/, 'names the split remedy');
    assert.match(result.warnings[0], /knowledge_edit|knowledge_append/, 'names the surgical-write remedy');

    const items = tools.maintenanceQuery({ system_reason: 'article_oversize', cap: 1000 });
    assert.equal(items.length, 1, 'exactly one item');
    assert.match((items[0] as unknown as { text: string }).text, /article_oversize_chars threshold/);

    // Second write while the item is still open: no duplicate (dedup by file_keys,
    // stable across the article's version bump — the id itself changed).
    const head2 = (tools.knowledgeQuery({ types: ['feature_article'] })[0] as unknown as { id: string }).id;
    tools.knowledgeUpdateResult(head2, { state: 'active' });
    assert.equal(tools.maintenanceQuery({ system_reason: 'article_oversize', cap: 1000 }).length, 1, 'no duplicate — same open item');
  } finally {
    cleanup();
  }
});

test('article_oversize lane is registered: SYSTEM_REASONS/DRAIN_VERBS totality holds', async () => {
  const { SYSTEM_REASONS, DRAIN_VERBS } = await import('@sterling/schemas');
  assert.ok((SYSTEM_REASONS as readonly string[]).includes('article_oversize'), 'article_oversize must join SYSTEM_REASONS');
  assert.equal(typeof (DRAIN_VERBS as Record<string, string>)['article_oversize'], 'string', 'article_oversize needs a DRAIN_VERBS entry');
  assert.deepEqual(
    Object.keys(DRAIN_VERBS as Record<string, string>).sort(),
    [...(SYSTEM_REASONS as readonly string[])].sort(),
    'DRAIN_VERBS and SYSTEM_REASONS stay 1:1 (a half-registered lane fails this)'
  );
});

test('article_oversize: knowledge_append and knowledge_edit carry the same warning on the same channel', () => {
  const { tools, cleanup } = harnessWithConfig({ article_oversize_chars: 200 });
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    const appended = tools.knowledgeAppend(article.id, 'history', [{ date: NOW, event: 'grew past threshold' }]);
    assert.equal(appended.warnings.length, 1, 'knowledge_append warns too — same channel');
    assert.match(appended.warnings[0], /article_oversize_chars threshold/);

    const head = appended.record.id;
    const edited = tools.knowledgeEdit(head, 'what_it_does', 'does', 'does, edited');
    assert.equal(edited.warnings.length, 1, 'knowledge_edit warns too — same channel');
    assert.match(edited.warnings[0], /article_oversize_chars threshold/);

    // one producer, one article, one open item throughout — both writes deduped.
    assert.equal(tools.maintenanceQuery({ system_reason: 'article_oversize', cap: 1000 }).length, 1);
  } finally {
    cleanup();
  }
});

test('knowledge_update drains a drift item whose feature_link points to an ANCESTOR version (supersede-chain match)', () => {
  const { tools, cleanup } = harness();
  try {
    const v1 = mkArticle(tools, 'thing', 'src/thing.ts');
    const v2 = tools.knowledgeUpdate(v1.id, { what_it_does: 'v2' });
    // an item raised against the now-superseded v1 (a flag that lagged a version);
    // reconciling v2→v3 must still drain it via the supersede chain.
    tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: `reconcile 'thing'`, file_keys: ['src/thing.ts'], feature_link: v1.id });
    tools.knowledgeUpdate(v2.id, { what_it_does: 'v3' });
    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 0, 'ancestor-linked drift item drained via the chain');
  } finally {
    cleanup();
  }
});

test('board tools: add/query separates board from maintenance queue; remove is todo-only', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: userTodo } = tools.boardAdd({ text: 'ship csv export', source: 'user', priority: 'high' });
    tools.boardAdd({ text: 'reconcile auth article', source: 'system', system_reason: 'reconcile_needed' });
    assert.equal(tools.boardQuery({}).length, 2);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, 'board view filters user');
    assert.equal(tools.boardQuery({ source: 'system' }).length, 1, 'maintenance queue is source=system');
    assert.throws(() => tools.boardAdd({ text: 'x', source: 'system' }), /system_reason/);

    const { record: d } = tools.knowledgeCreate('decision', {
      title: 't',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    });
    assert.throws(() => tools.boardRemove(d.id), /not a todo/);
    const res = tools.boardRemove(userTodo.id);
    // the artifact binding is BUILT now (board b8ff0b68): a keyless item still
    // reports the check as skipped, but for the real reason — no file identity
    // to join on — not as not_built
    assert.deepEqual(res.check_skipped, [{ check: 'board-remove-artifact-binding', reason: 'no_file_keys' }]);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0);
  } finally {
    cleanup();
  }
});

test('board_update: in-place edit of text/priority/file_keys — id stable, no new version, never closes an item (work order 9a06b6aa)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { record: original } = tools.boardAdd({ text: 'ship csv export', source: 'user', priority: 'low' });

    // A second clock, sharing the SAME store, so updated_at's refresh is
    // actually observable — harness() freezes `now` for determinism elsewhere.
    const LATER = '2026-06-10T13:00:00.000Z';
    const laterTools = new SterlingTools({ store, now: () => LATER });

    // update text only — id, created_at, source, status all hold
    const afterText = laterTools.boardUpdate(original.id, { text: 'ship csv export with headers' });
    assert.equal(afterText.id, original.id, 'the id is stable — no new record is minted');
    assert.equal((afterText as unknown as { text: string }).text, 'ship csv export with headers');
    assert.equal((afterText as unknown as { priority: string }).priority, 'low', 'untouched fields persist');
    assert.equal(afterText.status, 'active');
    assert.equal(afterText.created_at, original.created_at);
    assert.equal(afterText.updated_at, LATER, 'updated_at is refreshed to the write-time clock');
    assert.notEqual(afterText.updated_at, original.updated_at, 'and differs from the original');
    assert.equal(tools.boardQuery({}).length, 1, 'still exactly one item — an update never mints a second record');

    // updating never closes an item — it is still on the board afterward
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1);

    // priority + file_keys together in one patch
    const afterMulti = tools.boardUpdate(original.id, { priority: 'high', file_keys: ['src/csv.ts'] });
    assert.equal((afterMulti as unknown as { priority: string }).priority, 'high');
    assert.deepEqual((afterMulti as unknown as { file_keys: string[] }).file_keys, ['src/csv.ts']);
    assert.equal(tools.boardQuery({ file_keys: ['src/csv.ts'] }).length, 1, 'the file_keys index was rebuilt for the new value');

    // refuses source/system_reason/status changes, naming the valid set
    assert.throws(() => tools.boardUpdate(original.id, { source: 'system' } as unknown as Record<string, unknown>), (err: Error) => {
      assert.match(err.message, /'source'/, 'names the offending field');
      assert.match(err.message, /text\/priority\/file_keys|text, priority, file_keys/, 'and the valid set');
      return true;
    });
    assert.throws(() => tools.boardUpdate(original.id, { status: 'superseded' } as unknown as Record<string, unknown>), /'status'/);
    assert.throws(() => tools.boardUpdate(original.id, { system_reason: 'reconcile_needed' } as unknown as Record<string, unknown>), /'system_reason'/);
    assert.throws(() => tools.boardUpdate(original.id, { id: 'x' } as unknown as Record<string, unknown>), /'id'/);

    // refuses an empty patch — nothing to update is not a no-op success
    assert.throws(() => tools.boardUpdate(original.id, {}), /no fields to update/);

    // refuses a non-todo id
    const { record: d } = tools.knowledgeCreate('decision', { title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' });
    assert.throws(() => tools.boardUpdate(d.id, { text: 'x' }), /not a todo/);

    // refuses an unknown id
    assert.throws(() => tools.boardUpdate(randomUUID(), { text: 'x' }), /no record/);
  } finally {
    cleanup();
  }
});

test('a write carrying a field the type does not define is REFUSED, never silently dropped (P5)', () => {
  const { tools, cleanup } = harness();
  try {
    // The reported failure, verbatim in shape: reference_material has no files or
    // file_keys (its paths come from `location`), so the write was accepted, the
    // field discarded, and success returned — caught only by later querying for
    // the thing the write was supposed to have done.
    assert.throws(
      () =>
        tools.knowledgeCreate('reference_material', {
          title: 'ROADMAP',
          kind: 'doc',
          location: 'ROADMAP.md',
          summary: 's',
          source_date: '2026-07-29',
          capture_date: '2026-07-29',
          files: [{ path: 'ROADMAP.md', role: 'plan' }],
        }),
      (err: Error) => {
        assert.match(err.message, /'files'/, 'the refusal names the offending field');
        assert.match(err.message, /silently dropped/, 'and says what would have happened');
        assert.match(err.message, /location/, 'and lists the valid fields so the fix needs no round-trip');
        return true;
      }
    );
    // nothing was written by the refused create
    assert.equal(tools.knowledgeQuery({ types: ['reference_material'] }).length, 0);

    // a correct create still lands, and the SAME guard covers update
    const { record: ref } = tools.knowledgeCreate('reference_material', {
      title: 'ROADMAP',
      kind: 'doc',
      location: 'ROADMAP.md',
      summary: 's',
      source_date: '2026-07-29',
      capture_date: '2026-07-29',
    });
    assert.throws(() => tools.knowledgeUpdate(ref.id, { file_keys: ['ROADMAP.md'] }), /'file_keys'/);
    assert.equal(tools.knowledgeQuery({ types: ['reference_material'] })[0].id, ref.id, 'the refused update wrote no new version');

    // the per-type split is real, and the guard respects it: files[] is exactly
    // how a feature_article carries paths, so the same field is valid there
    const { record: art } = tools.knowledgeCreate('feature_article', {
      slug: 'a',
      title: 'a',
      what_it_does: 'x',
      intended_behavior: 'y',
      files: [{ path: 'src/a.ts', role: 'impl' }],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    });
    assert.equal((art as unknown as { files: unknown[] }).files.length, 1);
  } finally {
    cleanup();
  }
});

test('board_query / maintenance_query DISCLOSE their depth — a queue that under-reports reads as drained (P5)', () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 5; i++) {
      tools.boardAdd({ text: `queue item ${i}`, source: 'system', system_reason: 'reconcile_needed' });
    }
    tools.boardAdd({ text: 'real work', source: 'user' });

    // The reported failure: "maintenance_query caps at 50 silently. No count, no
    // '50 of N'. I only learned the tail was deep because removing 19 revealed 19
    // more." capped is EXACT here (the filter runs in JS over the scanned set),
    // unlike knowledge_query where FTS rank-blindness forces returned === cap.
    const capped = tools.maintenanceQueryResult({ cap: 2 });
    assert.equal(capped.returned, 2);
    assert.equal(capped.matched_filter, 5, 'the queue states its real depth, not its window');
    assert.equal(capped.capped, true);
    assert.match(capped.note ?? '', /cap reached/);
    assert.match(capped.note ?? '', /tail behind/, 'the notice names the drain consequence');

    const full = tools.maintenanceQueryResult({ cap: 50 });
    assert.equal(full.returned, 5);
    assert.equal(full.capped, false);
    assert.equal(full.note, undefined, 'a complete result carries no notice');

    // source still separates the two surfaces through the envelope
    assert.equal(tools.boardQueryResult({ source: 'user' }).matched_filter, 1);
    assert.equal(tools.boardQueryResult({ source: 'system' }).matched_filter, 5);
    assert.equal(tools.boardQueryResult({}).matched_filter, 6);
  } finally {
    cleanup();
  }
});

test('contains narrows board_query and maintenance_query — a genuine WHERE, not a rank (work order d9960c98)', () => {
  const { tools, cleanup } = harness();
  try {
    tools.boardAdd({ text: 'ship csv export', source: 'user' });
    tools.boardAdd({ text: 'fix the login bug', source: 'user' });
    tools.boardAdd({ text: 'reconcile CSV importer article', source: 'system', system_reason: 'reconcile_needed' });
    tools.boardAdd({ text: 'refresh the models catalog', source: 'system', system_reason: 'refresh_reference' });

    // board_query: case-insensitive substring, and matched_filter reflects the
    // NARROWED count — this is a WHERE, not an ORDER, so the filter count itself
    // must shrink (unlike rank_terms, which orders the filter set and never
    // narrows it).
    const boardHit = tools.boardQueryResult({ source: 'user', contains: 'CSV' });
    assert.equal(boardHit.matched_filter, 1, 'matched_filter reflects the narrowed count, not the unfiltered board');
    assert.equal(boardHit.returned, 1);
    assert.match((boardHit.records[0] as unknown as { text: string }).text, /csv export/i);

    const boardMiss = tools.boardQueryResult({ source: 'user', contains: 'nonexistent-term' });
    assert.equal(boardMiss.matched_filter, 0);

    // maintenance_query inherits the SAME shared filter (boardFiltered) —
    // board d9960c98's point (b): one definition, both surfaces. (A board id:
    // the item was drained on fulfillment, so it must not be cited as a
    // resolvable record — the citation check exempts board ids.)
    const queueHit = tools.maintenanceQueryResult({ contains: 'csv' });
    assert.equal(queueHit.matched_filter, 1);
    assert.match((queueHit.records[0] as unknown as { text: string }).text, /CSV importer/);

    // FTS5 metacharacters must not crash the filter and must match LITERALLY —
    // contains never goes near records_fts MATCH, so quoting/escaping is moot.
    tools.boardAdd({ text: 'handle the "quoted" OR* weird case', source: 'user' });
    const metachar = tools.boardQueryResult({ source: 'user', contains: '"quoted" OR*' });
    assert.equal(metachar.matched_filter, 1, 'FTS5 syntax characters are matched literally, not interpreted as query syntax');

    // absent contains means no filtering at all — unchanged behaviour
    assert.equal(tools.boardQueryResult({ source: 'user' }).matched_filter, 3);
  } finally {
    cleanup();
  }
});

test('stale-at-read (§3.4): research findings get both clocks + flag; platform basis gets verify_before_use', () => {
  const { store, tools, cleanup } = harness();
  try {
    const mk = (over: Record<string, unknown>) =>
      tools.knowledgeCreate('research_finding', {
        question: `q-${Math.random()}`,
        answer: 'a',
        source_urls: [],
        source_date: '2026-05-20',
        capture_date: '2026-06-01',
        ...over,
      });
    mk({ volatility_hint: 'stable', question: 'fresh-stable' });
    mk({ source_date: '2026-01-15', volatility_hint: 'medium', question: 'old-medium' });
    const served = tools.knowledgeQuery({ types: ['research_finding'], cap: 10 }) as unknown as {
      question: string;
      staleness: { stale: boolean; source_age_days: number; note?: string };
    }[];
    const fresh = served.find((r) => r.question === 'fresh-stable')!;
    const old = served.find((r) => r.question === 'old-medium')!;
    assert.equal(fresh.staleness.stale, false);
    assert.equal(old.staleness.stale, true, 'born from an old source on a medium topic = stale at first read');
    assert.match(old.staleness.note!, /re-verify/);
    assert.equal(typeof old.staleness.source_age_days, 'number');

    // Seed the aged record at the STORE layer: knowledge_create now (correctly)
    // owns the envelope and strips caller-supplied created_at/updated_at (audit
    // finding 14/43), so an old record is seeded directly with a full envelope —
    // the annotation logic under test still keys verify_before_use off updated_at.
    store.create({
      id: randomUUID(),
      type: 'reference_material',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      author: 'conductor',
      status: 'active',
      superseded_by: null,
      links: [],
      scope: 'project',
      stack_tags: [],
      title: 'old platform doc',
      kind: 'url',
      location: 'https://x',
      summary: 's',
      source_date: '2025-01-01',
      capture_date: '2025-01-01',
      basis: 'platform',
    });
    const refs = tools.knowledgeQuery({ types: ['reference_material'], cap: 10 }) as unknown as { verify_before_use?: boolean }[];
    assert.equal(refs[0].verify_before_use, true, 'wrong old knowledge is worse than no knowledge');
  } finally {
    cleanup();
  }
});

test('knowledge_query DISCLOSES its window: capped says so with the filter count, uncapped GUARANTEES nothing was dropped (P5)', () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 5; i++) {
      tools.knowledgeCreate('decision', { title: `D${i}`, statement: 'S', alternatives_rejected: [], rationale: 'R' });
    }
    // The failure this pins (sibling-project retrospective, 2026-07-29): a caller
    // received a capped window with no signal, read it as the whole store, and
    // reasoned from that. matched_filter is the number it previously had to guess.
    const capped = tools.knowledgeQueryResult({ types: ['decision'], cap: 2 });
    assert.equal(capped.returned, 2);
    assert.equal(capped.matched_filter, 5, 'the count matching the FILTER, not the size of the window');
    assert.equal(capped.cap, 2);
    assert.equal(capped.capped, true);
    assert.match(capped.note ?? '', /cap reached/, 'the disclosure teaches how to widen the window');

    // Disclosure appears ONLY when the window is actually partial (P1 — a notice
    // on every complete result is ceremony): capped:false is a guarantee.
    const full = tools.knowledgeQueryResult({ types: ['decision'], cap: 50 });
    assert.equal(full.returned, 5);
    assert.equal(full.capped, false);
    assert.equal(full.note, undefined, 'a complete result carries no notice');

    // rank_terms restricting the set is NOT the cap truncating it — the two are
    // reported distinctly, so "3 of 5" never gets misread as "the cap dropped 2".
    const ranked = tools.knowledgeQueryResult({ types: ['decision'], rank_terms: ['D3'], cap: 50 });
    assert.equal(ranked.capped, false, 'rank_terms narrowing is not a cap truncation');
    assert.equal(ranked.matched_filter, 5);
    assert.match(ranked.note ?? '', /rank_terms restricted/, 'the FTS narrowing is disclosed too');
  } finally {
    cleanup();
  }
});

test('knowledge_query PROJECTS version history out of results; knowledge_get stays full-fidelity (the 56KB cap:6 payload)', () => {
  // A repoRoot + a real owned file, because file_baselines is only computed where
  // there is a tree to hash — the default harness has none, so a projection test
  // on it would assert the absence of something that was never there.
  const dir = mkdtempSync(join(tmpdir(), 'sterling-proj-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'thing.ts'), 'export const x = 1;\n');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    let article = mkArticle(tools, 'thing', 'src/thing.ts');
    assert.ok(
      Object.keys((article as unknown as { file_baselines: Record<string, string> }).file_baselines).length > 0,
      'precondition: the article really does carry a server-computed baseline'
    );
    const firstId = article.id;
    for (let i = 0; i < 3; i++) article = tools.knowledgeUpdate(article.id, { what_it_does: `does ${i}` });

    const [projected] = tools.knowledgeQueryResult({ types: ['feature_article'] }).records;
    assert.equal(projected.supersedes_count, 3, 'chain DEPTH stays visible without the uuids');
    assert.deepEqual(projected.links, [], 'the supersedes chain is gone from query results');
    assert.ok(!('file_baselines' in projected), 'server-owned baseline hashes are gone from query results');
    assert.equal(projected.what_it_does, 'does 2', 'the readable content is untouched');

    // Nothing became unreachable — it just stopped being paid for on every hit.
    const full = tools.knowledgeGet(article.id) as unknown as Record<string, unknown>;
    assert.equal((full.links as unknown[]).length, 3, 'knowledge_get keeps the full chain');
    assert.ok('file_baselines' in full, 'knowledge_get keeps the baselines');
    assert.equal(tools.knowledgeGet(firstId).status, 'superseded', 'and the superseded versions remain retrievable by id');
  } finally {
    cleanup();
  }
});

test("projection:'digest' returns the LANDSCAPE, not the bodies — and 'full' stays the default", () => {
  const { tools, cleanup } = harness();
  try {
    const body = 'x'.repeat(3000);
    for (let i = 0; i < 6; i++) {
      tools.knowledgeCreate('decision', { title: `Decision ${i}`, statement: body, alternatives_rejected: [], rationale: body });
    }
    tools.knowledgeCreate('anti_pattern', {
      title: 'Absence claimed from a guessed symbol name',
      trigger: 'an agent greps for a name it expects and reports the concept absent when the grep is empty',
      guidance: 'verify absence by reading the thing that would do the job',
      wrong_way: 'grep lose(',
      right_way: 'open the file',
      source_evidence: 'sibling retrospective 2026-08-02',
      file_keys: ['src/run.ts'],
      severity: 'warn',
    });

    // DEFAULT UNCHANGED — no existing caller sees different data (P1: an opt-in
    // read, not a migration).
    const full = tools.knowledgeQueryResult({ types: ['decision'], cap: 50 });
    assert.equal(full.records[0].statement, body, "'full' is still the default and still carries bodies");

    const digest = tools.knowledgeQueryResult({ types: ['decision'], cap: 50, projection: 'digest' });
    assert.equal(digest.matched_filter, 6);
    assert.equal(digest.returned, 6, 'a digest is a projection, never a different filter — same records, less of each');
    for (const r of digest.records) {
      assert.ok(r.id && r.type && r.title, 'every digest carries the handle and the headline');
      assert.ok(!('statement' in r), 'and none of the body');
      assert.ok(!('rationale' in r), 'nor the rationale');
    }

    // The measured complaint was token cost, so the test asserts token cost.
    const fullBytes = JSON.stringify(full.records).length;
    const digestBytes = JSON.stringify(digest.records).length;
    assert.ok(
      digestBytes * 10 < fullBytes,
      `a digest must be at least an order of magnitude cheaper (full ${fullBytes}B vs digest ${digestBytes}B)`
    );

    // The type-aware half: an anti_pattern leads with its TRIGGER, because that
    // is what tells a reader whether the hazard applies to what they are doing.
    // A title-only digest would have made the "what governs this path?" read —
    // named as the single most common retrieval shape with no direct expression
    // — still require opening every record.
    const [hazard] = tools.knowledgeQueryResult({ types: ['anti_pattern'], file_keys: ['src/run.ts'], projection: 'digest' }).records;
    assert.match(hazard.trigger as string, /greps for a name it expects/, 'the hazard states its own trigger');
    assert.equal(hazard.severity, 'warn');
    assert.ok(!('right_way' in hazard), 'without the remedy body — that is what knowledge_get is for');
  } finally {
    cleanup();
  }
});

test('a capped window says what matched_filter does NOT mean, and names the cheap way to see the whole set', () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 8; i++) {
      tools.knowledgeCreate('decision', { title: `Garage decision ${i}`, statement: 'S', alternatives_rejected: [], rationale: 'R' });
    }

    // Reported misreading: "matched_filter: 179" against rank_terms was read as
    // "179 records about my terms". rank_terms ORDER the filter set (ORDER BY
    // bm25), they never narrow it — so a capped ranked window must say so.
    const ranked = tools.knowledgeQueryResult({ types: ['decision'], rank_terms: ['garage'], cap: 3 });
    assert.equal(ranked.capped, true);
    assert.equal(ranked.matched_filter, 8, 'the count belongs to the FILTER, not to the terms');
    assert.match(ranked.note ?? '', /rank_terms ORDERED those 8 and did not narrow them/);
    assert.match(ranked.note ?? '', /NOT a measure of how many are relevant/);
    assert.match(ranked.note ?? '', /can never establish absence/, 'the half of retrieval a capped result cannot serve');
    assert.match(ranked.note ?? '', /projection:"digest"/, 'and the route out of the window is named, not left to be discovered');

    // Unranked capped windows get the digest route without the rank caveat —
    // an irrelevant warning on every result is the noise P1 exists to prevent.
    const plain = tools.knowledgeQueryResult({ types: ['decision'], cap: 3 });
    assert.match(plain.note ?? '', /projection:"digest"/);
    assert.ok(!/rank_terms ORDERED/.test(plain.note ?? ''), 'no rank caveat where no rank_terms were passed');

    // Already digesting? Then advertising the digest is noise — say raise cap.
    const digested = tools.knowledgeQueryResult({ types: ['decision'], cap: 3, projection: 'digest' });
    assert.ok(!/re-run with projection/.test(digested.note ?? ''), 'never advise what the caller already did');
    assert.match(digested.note ?? '', /raise cap/);
  } finally {
    cleanup();
  }
});

test("board_query / maintenance_query take projection:'digest' — the 478 KB board read", () => {
  const { tools, cleanup } = harness();
  try {
    // Board items are free text and run to several KB each; the reported audit
    // dumped 132 of them to keyword-sweep with a regex in node.
    for (let i = 0; i < 5; i++) {
      tools.boardAdd({ text: `item ${i}: ${'y'.repeat(2000)}`, source: 'user', priority: 'high' });
    }
    tools.boardAdd({ text: `reconcile ${'z'.repeat(2000)}`, source: 'system', system_reason: 'reconcile_needed' });

    const full = tools.boardQueryResult({ source: 'user' });
    const digest = tools.boardQueryResult({ source: 'user', projection: 'digest' });
    assert.equal(digest.returned, full.returned, 'same items');
    assert.ok(
      JSON.stringify(digest.records).length * 5 < JSON.stringify(full.records).length,
      'a digested board is dramatically cheaper to hold'
    );
    const [item] = digest.records as Record<string, unknown>[];
    assert.match(item.text as string, /^item 0/, 'the text is clipped, not dropped — triage needs to read it');
    assert.match(item.text as string, /…$/);
    assert.equal(item.priority, 'high', 'the fields you triage BY survive');

    // The queue's lane is its headline: a drain sorts by system_reason.
    const [queued] = tools.maintenanceQueryResult({ projection: 'digest' }).records as Record<string, unknown>[];
    assert.equal(queued.system_reason, 'reconcile_needed');
    assert.equal(queued.source, 'system');
  } finally {
    cleanup();
  }
});

test("write tools take projection:'digest' — the envelope survives, only the echo collapses (the 49.8KB append)", () => {
  const { tools, cleanup } = harness();
  try {
    // The measured complaint (2026-08-09 consuming-project retrospective): every
    // write echoes the record the caller JUST authored — one history append
    // echoed 49.8KB, 100KB+ of pure echo per session across ~10 writes.
    const body = 'w'.repeat(3000);
    const article = mkArticle(tools, 'echoey', 'src/echoey.ts');

    // DEFAULT UNCHANGED — a write result never changes shape under an existing
    // caller (same posture as the read-side digest: opt-in, not a migration).
    const full = tools.writeProjected(tools.knowledgeUpdateResult(article.id, { what_it_does: body }));
    const fullRecord = (full as { record: Record<string, unknown> }).record;
    assert.equal(fullRecord.what_it_does, body, "'full' stays the default and still echoes the body");

    // digest: the envelope is what a caller ACTS on (warnings, check_skipped,
    // replaced) — it survives; only the echoed record collapses to its digest.
    const digested = tools.writeProjected(
      tools.knowledgeUpdateResult(fullRecord.id as string, { what_it_does: `${body} v2` }),
      'digest'
    ) as Record<string, unknown>;
    assert.ok(Array.isArray(digested.warnings), 'the warnings channel survives the projection');
    const receipt = digested.record as Record<string, unknown>;
    assert.equal(receipt.slug, 'echoey', 'the receipt carries the stable handle');
    assert.equal(receipt.type, 'feature_article');
    assert.ok(typeof receipt.version === 'number', 'and the version the write minted');
    assert.ok(!('what_it_does' in receipt), 'without re-sending the body the caller just wrote');
    assert.ok(
      JSON.stringify(digested).length * 5 < JSON.stringify(full).length,
      'a digested write response is dramatically cheaper to receive'
    );

    // knowledge_create keeps its declared envelope fields the same way.
    const created = tools.writeProjected(
      tools.knowledgeCreate('decision', { title: 'Echo decision', statement: body, alternatives_rejected: [], rationale: body }),
      'digest'
    ) as Record<string, unknown>;
    assert.ok(Array.isArray(created.check_skipped), 'check_skipped is declared, not dropped, in the digest shape');
    const createdReceipt = created.record as Record<string, unknown>;
    assert.equal(createdReceipt.title, 'Echo decision');
    assert.ok(!('statement' in createdReceipt));

    // board_update returns a BARE record — the projection handles that shape too.
    const todo = (tools.boardAdd({ text: `long item ${'y'.repeat(2000)}`, source: 'user' }) as { record: { id: string } }).record;
    const updated = tools.writeProjected(tools.boardUpdate(todo.id, { priority: 'high' }), 'digest') as Record<string, unknown>;
    assert.equal(updated.priority, 'high', 'the fields you triage by survive');
    assert.match(updated.text as string, /…$/, 'the text is clipped, not echoed whole');
  } finally {
    cleanup();
  }
});

test("knowledge_edit array-element addressing: files[path=x].role edits ONE string in ONE element — exactly-once at both levels (board b078167a)", () => {
  const { tools, cleanup } = harness();
  try {
    const article = tools.knowledgeCreate('feature_article', {
      slug: 'multi',
      title: 'multi',
      what_it_does: 'does',
      intended_behavior: 'b',
      files: [
        { path: 'src/a.ts', role: 'the seam (uncommitted at writing)' },
        { path: 'src/b.ts', role: 'the sibling seam (uncommitted at writing)' },
      ],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    }).record;

    // The motivating case: fix ONE stale clause inside ONE role without
    // retransmitting the sibling elements.
    const edited = tools.knowledgeEdit(article.id, 'files[path=src/a.ts].role', ' (uncommitted at writing)', '');
    const files = (edited.record as unknown as { files: { path: string; role: string }[] }).files;
    assert.equal(files.find((f) => f.path === 'src/a.ts')?.role, 'the seam', 'the selected element is corrected');
    assert.equal(files.find((f) => f.path === 'src/b.ts')?.role, 'the sibling seam (uncommitted at writing)', 'the sibling is byte-untouched');
    assert.equal(edited.replaced.field, 'files[path=src/a.ts].role');

    const current = edited.record.id;
    // selector matching ZERO elements refuses with the count
    assert.throws(
      () => tools.knowledgeEdit(current, 'files[path=src/zzz.ts].role', 'x', 'y'),
      /matches 0 element/,
      'an unmatched selector is refused, nothing written'
    );
    // non-array base field refuses the selector shape
    assert.throws(
      () => tools.knowledgeEdit(current, 'what_it_does[path=x].role', 'x', 'y'),
      /not an array/,
      'the selector only addresses array fields'
    );
    // find must still match exactly once INSIDE the selected element
    assert.throws(
      () => tools.knowledgeEdit(current, 'files[path=src/b.ts].role', 'e', 'E'),
      /appears \d+ times/,
      'ambiguity inside the element is refused exactly like the plain path'
    );
    // unknown base field is refused naming the valid set (same guard as everywhere)
    assert.throws(() => tools.knowledgeEdit(current, 'nonsense[path=x].role', 'x', 'y'), /nonsense/);
  } finally {
    cleanup();
  }
});

test('session-event writers (no_capture / concept_designed / capture_pending) append schema-valid events to the transient register (boards 75b1a05f + 1af5d630)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-events-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  const eventsPath = join(dir, '.sterling', 'transient', 'session-events.json');
  try {
    // blank inputs are refused BEFORE anything is written — a false or empty
    // declaration is drift, and these are honesty surfaces, not silencers
    assert.throws(() => tools.noCapture('   '), /reason/);
    assert.throws(() => tools.capturePending('', 'capture riding commit'), /target/);
    assert.throws(() => tools.capturePending('commit abc', '  '), /reason/);
    assert.throws(() => tools.conceptDesigned([]), /non-empty/);
    assert.throws(() => tools.conceptDesigned(['ok', ' ']), /blank/);
    assert.equal(existsSync(eventsPath), false, 'refused declarations write nothing');

    tools.noCapture('read-only investigation');
    tools.conceptDesigned(['weapons', 'armor']);
    const pending = tools.capturePending('commit sterling/wave-3', 'three decisions drafted, riding the gated commit');
    assert.match(pending.pending, /^commit sterling\/wave-3 — /, 'the pending detail leads with the target so the debt stays traceable');

    const events = JSON.parse(readFileSync(eventsPath, 'utf8')) as { kind: string; detail: string; at: string }[];
    assert.deepEqual(
      events.map((e) => e.kind),
      ['no_capture', 'concept_designed', 'concept_designed', 'capture_pending'],
      'one event per declaration, in order, in the ONE register H10 reads'
    );
    assert.ok(events.every((e) => e.detail && e.at === NOW), 'every event carries detail + timestamp (sessionEventSchema shape)');

    // a server with no resolvable project root refuses loudly instead of
    // writing the register somewhere no hook will ever read it (P5)
    const rootless = new SterlingTools({ store, now: () => NOW });
    assert.throws(() => rootless.noCapture('x'), /no project root/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board_remove / maintenance_remove disclose artifact_evidence — the binding is visibility, not a gate (board b8ff0b68)', () => {
  const { tools, cleanup } = harness();
  try {
    // fulfilled item: a durable record touching its file_keys landed after it
    const fulfilled = (tools.boardAdd({ text: 'fix the widget', source: 'user', file_keys: ['src/widget.ts'] }) as { record: { id: string } }).record;
    tools.knowledgeCreate('decision', { title: 'widget fixed thus', statement: 'S', alternatives_rejected: [], rationale: 'R', file_keys: ['src/widget.ts'] });
    const closed = tools.boardRemove(fulfilled.id);
    assert.equal(closed.artifact_evidence?.length, 1, 'the fulfilling write is visible in the receipt');
    assert.equal((closed.artifact_evidence?.[0] as { type?: unknown }).type, 'decision');
    assert.equal(closed.note, undefined, 'no operator-word warning when evidence exists');

    // unfulfilled item: nothing touched its file_keys — removed, but the
    // receipt says out loud that the close rides the operator's word
    const bare = (tools.boardAdd({ text: 'someday thing', source: 'user', file_keys: ['src/never.ts'] }) as { record: { id: string } }).record;
    const abandoned = tools.boardRemove(bare.id);
    assert.deepEqual(abandoned.artifact_evidence, [], 'empty evidence is reported, never fabricated');
    assert.match(abandoned.note ?? '', /operator's word/, 'and the receipt names what that means');

    // no file identity → the check cannot run and says so (P5)
    const keyless = (tools.boardAdd({ text: 'free-floating idea', source: 'user' }) as { record: { id: string } }).record;
    const skipped = tools.boardRemove(keyless.id);
    assert.equal(skipped.check_skipped?.[0]?.check, 'board-remove-artifact-binding');
    assert.equal(skipped.check_skipped?.[0]?.reason, 'no_file_keys');

    // maintenance_remove discloses the same evidence on queue items
    const qi = tools.maintenanceEnqueue({ reason: 'capture_owed', text: 'capture owed on the widget work', file_keys: ['src/widget.ts'] });
    const drained = tools.maintenanceRemove(qi.record.id);
    assert.ok((drained.artifact_evidence?.length ?? 0) >= 1, 'the drain receipt shows the fulfilling write too');
  } finally {
    cleanup();
  }
});

test('removal evidence survives the store cap: old high-overlap records cannot push the one fulfilling write out (review finding 12)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-evidence-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  let t = '2026-06-10T12:00:00.000Z';
  const tools = new SterlingTools({ store, now: () => t });
  try {
    // A well-documented area: 30 OLD records overlapping BOTH of the item's
    // file_keys (overlap 2 → sorted first by the store), predating the item.
    for (let i = 0; i < 30; i++) {
      tools.knowledgeCreate('decision', {
        title: `old lore ${i}`,
        statement: 'S',
        alternatives_rejected: [],
        rationale: 'R',
        file_keys: ['src/hot.ts', 'src/hot2.ts'],
      });
    }
    t = '2026-06-11T12:00:00.000Z';
    const item = (tools.boardAdd({ text: 'work the hot area', source: 'user', file_keys: ['src/hot.ts', 'src/hot2.ts'] }) as { record: { id: string } }).record;
    t = '2026-06-12T12:00:00.000Z';
    // The one FULFILLING write overlaps only one key (overlap 1 → sorted last),
    // so a small pre-filter cap would drop exactly the record that matters and
    // the receipt would falsely accuse drift.
    tools.knowledgeCreate('decision', { title: 'the fulfilling ruling', statement: 'S', alternatives_rejected: [], rationale: 'R', file_keys: ['src/hot.ts'] });
    const closed = tools.boardRemove(item.id);
    assert.ok(
      (closed.artifact_evidence ?? []).some((e) => (e as { title?: string }).title === 'the fulfilling ruling'),
      'the since-filter runs over a wide scan, not a pre-filtered window'
    );
    assert.equal(closed.note, undefined, "and no operator's-word accusation fires when evidence exists");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dedup guard (§3.2.2): an overlapping anti_pattern is REFUSED naming the match — the author merges via knowledge_update or stores with dedup_override', () => {
  const { tools, cleanup } = harness();
  try {
    const first = tools.knowledgeCreate('anti_pattern', {
      title: 'No raw SQL concatenation',
      trigger: 'building queries from user input',
      guidance: 'parameterize',
      wrong_way: 'concat',
      right_way: 'prepare',
      source_evidence: 'run r-1, src/db.ts:10',
      file_keys: ['src/db.ts'],
    });
    // a genuine restatement (strong token overlap + shared key) is refused loudly, never silently merged
    const restatement = {
      title: 'SQL concatenation strikes again',
      trigger: 'queries from user input',
      guidance: 'parameterize',
      wrong_way: 'concat',
      right_way: 'prepare',
      source_evidence: 'run r-2, src/api.ts:44',
      file_keys: ['src/db.ts'],
    };
    assert.throws(() => tools.knowledgeCreate('anti_pattern', restatement), new RegExp(first.record.id), 'the refusal names the match');
    assert.throws(() => tools.knowledgeCreate('anti_pattern', restatement), /dedup_override/, 'the refusal teaches the distinct-lesson verb');
    assert.equal(tools.knowledgeQuery({ types: ['anti_pattern'], cap: 10 }).length, 1, 'a refused create writes nothing — no version bump, no new record');

    // same-finding verb: the author merges evidence through knowledge_update
    const prior = tools.knowledgeQuery({ types: ['anti_pattern'], cap: 10 })[0] as unknown as { source_evidence: string };
    tools.knowledgeUpdate(first.record.id, { source_evidence: `${prior.source_evidence}\n${restatement.source_evidence}` });
    const active = tools.knowledgeQuery({ types: ['anti_pattern'], cap: 10 });
    assert.equal(active.length, 1);
    const evidence = (active[0] as unknown as { source_evidence: string }).source_evidence;
    assert.ok(evidence.includes('run r-1') && evidence.includes('run r-2'), 'evidence merged into the surviving record');

    // distinct-lesson verb: dedup_override stores it, and the directive is never persisted
    const overridden = tools.knowledgeCreate('anti_pattern', { ...restatement, dedup_override: true });
    assert.equal((overridden.record as unknown as Record<string, unknown>).dedup_override, undefined, 'dedup_override is a create-time directive, not a field');
    assert.equal(tools.knowledgeQuery({ types: ['anti_pattern'], cap: 10 }).length, 2);
  } finally {
    cleanup();
  }
});

test('dedup guard Dice threshold (§3.2.2): strong token overlap refuses naming the match; shared domain words alone do not', () => {
  const { tools, cleanup } = harness();
  try {
    // no file_keys → matching is purely token-based (Dice coefficient over title+trigger)
    const base = tools.knowledgeCreate('anti_pattern', {
      title: 'Power Automate apply-to-each swallows errors',
      trigger: 'apply to each over a large array without concurrency control',
      guidance: 'g',
      wrong_way: 'w',
      right_way: 'r',
      source_evidence: 'run r-base',
    });

    // a genuine restatement of the SAME gotcha — high token overlap (Dice >= 0.5) → refused naming the match
    assert.throws(
      () =>
        tools.knowledgeCreate('anti_pattern', {
          title: 'Power Automate apply-to-each swallows errors silently',
          trigger: 'apply to each over a large array without concurrency',
          guidance: 'g',
          wrong_way: 'w',
          right_way: 'r',
          source_evidence: 'run r-restate',
        }),
      new RegExp(base.record.id),
      'a genuine restatement is refused on strong token overlap'
    );

    // a DIFFERENT gotcha sharing only domain words ("power","automate") — Dice < 0.5 → distinct.
    // The prior `shared >= 2` gate wrongly collapsed these same-domain findings.
    const other = tools.knowledgeCreate('anti_pattern', {
      title: 'Power Automate connection references expire after tenant migration',
      trigger: 'reusing exported connection references across environments',
      guidance: 'g',
      wrong_way: 'w',
      right_way: 'r',
      source_evidence: 'run r-other',
    });
    assert.ok(other.record.id, 'shared domain words alone must not flag distinct gotchas');

    assert.equal(tools.knowledgeQuery({ types: ['anti_pattern'], cap: 10 }).length, 2, 'restatement refused; distinct gotcha stands alone');
  } finally {
    cleanup();
  }
});

test('dedup guard (board 3f9591e9 replay): one shared file_key never swallows a distinct lesson; the key-assist tier still flags look-alikes; validation precedes dedup', () => {
  const { tools, cleanup } = harness();
  try {
    const machineFlip = tools.knowledgeCreate('anti_pattern', {
      title: 'Machine-context flip leaves installed agent hooks dead — sync-agents reports up_to_date',
      trigger: 'running sessions from a machine context other than the one that last installed or synced the agents',
      guidance: 'g',
      wrong_way: 'w',
      right_way: 'r',
      source_evidence: 'run r-ea9e, 2026-07-03',
      file_keys: ['scripts/lib/agent-distribution.mjs'],
    });

    // the 2026-07-04 incident, replayed: a DISTINCT lesson sharing ONE busy file_key,
    // near-zero token overlap → stores directly (the old hard key signal swallowed it)
    const distinct = tools.knowledgeCreate('anti_pattern', {
      title: 'Wiring a formerly-inert config field to authoritative without migrating live values silently reverts policy',
      trigger: 'promoting a config declaration to the source of truth while gitignored configs carry stale values',
      guidance: 'g',
      wrong_way: 'w',
      right_way: 'r',
      source_evidence: 'conductor-direct 2026-07-04',
      file_keys: ['scripts/lib/agent-distribution.mjs'],
    });
    assert.ok(distinct.record.id, 'a shared file_key alone never swallows a distinct lesson');
    assert.equal(tools.knowledgeQuery({ types: ['anti_pattern'], cap: 10 }).length, 2);

    // the ASSIST tier: shared key + moderate token overlap (0.3 <= Dice < 0.5) still flags…
    const lookAlike = {
      title: 'Machine context flip breaks hook execution for installed agents',
      trigger: 'agents installed by another launcher fail their hook commands at sessions',
      guidance: 'g',
      wrong_way: 'w',
      right_way: 'r',
      source_evidence: 'probe',
      file_keys: ['scripts/lib/agent-distribution.mjs'],
    };
    assert.throws(() => tools.knowledgeCreate('anti_pattern', lookAlike), new RegExp(machineFlip.record.id), 'shared key + look-alike tokens still flags the match');
    // …and is key-driven: the same tokens WITHOUT the shared key stay below the standalone threshold
    const noSharedKey = tools.knowledgeCreate('anti_pattern', { ...lookAlike, file_keys: ['scripts/other.mjs'] });
    assert.ok(noSharedKey.record.id, 'the assist tier is key-driven — no shared key, no flag at moderate overlap');

    // validation precedes dedup: a schema-invalid candidate that WOULD overlap gets the schema error, not a dedup refusal
    assert.throws(
      () =>
        tools.knowledgeCreate('anti_pattern', {
          title: 'Machine-context flip leaves installed agent hooks dead — sync-agents reports up_to_date',
          trigger: 'running sessions from a machine context other than the one that last installed or synced the agents',
          guidance: 'g',
          wrong_way: 'w',
          right_way: 'r',
          file_keys: ['scripts/lib/agent-distribution.mjs'],
        }),
      /source_evidence/,
      'schema validation runs before the dedup guard'
    );
  } finally {
    cleanup();
  }
});

test('knowledge_link, run_escalate, maintenance queue tools (§10)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { record: a } = tools.knowledgeCreate('decision', { title: 'a', statement: 's', alternatives_rejected: [], rationale: 'r' });
    const { record: b } = tools.knowledgeCreate('note', { raw_text: 'context note', captured_at: NOW, capture_source: 'conductor', derived: [] });
    const linked = tools.knowledgeLink(a.id, 'informed_by', b.id);
    assert.ok(linked.links.some((l) => l.rel === 'informed_by' && l.target_id === b.id));
    assert.throws(() => tools.knowledgeLink(a.id, 'replaces', b.id), /invalid/i, 'rel is the closed §3.2 set');
    assert.throws(() => tools.knowledgeLink(a.id, 'cites', randomUUID()), /no target record/);

    startRun(store);
    const esc = tools.runEscalate({ kind: 'plan-broken', detail: 'assumption X contradicted' });
    assert.equal(esc.escalations, 1);

    const { record: item } = tools.maintenanceEnqueue({ reason: 'stale_research', text: 're-verify genesys limits' });
    assert.equal((item as { source: string }).source, 'system');
    assert.equal(tools.maintenanceQuery({ system_reason: 'stale_research' }).length, 1);
    assert.equal(tools.maintenanceQuery({ system_reason: 'capture_owed' }).length, 0);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'maintenance items never pollute the user board');
  } finally {
    cleanup();
  }
});

test('agent_exit: in-band rejection of non-enum signals; valid exit lands on the run record (§5.2)', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    assert.throws(() => tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'victory' }), /enum is closed/);
    const { recorded } = tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } });
    assert.equal(recorded.signal, 'complete');
    assert.equal(store.getPendingExit('r-0001')!.phase_id, 'p1');
    assert.throws(
      () => tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'blocked', payload: { reason: 'second exit' } }),
      /unconsumed exit/,
      'a second exit before run_signal is a protocol violation'
    );
  } finally {
    cleanup();
  }
});

test('agent_exit: a phase_id not on the active run is refused at RECORD time — nothing enters the slot (board 7d051522)', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    // the 2026-07-03 incident: a conductor-direct subagent's exit bound to the
    // active run with a phase that does not exist, wedging the wire for the
    // whole phase. The seam must fail HERE, loudly, with nothing recorded.
    assert.throws(
      () => tools.agentExit({ phase_id: 'conductor-direct', agent_role: 'reviewer-correctness', signal: 'complete', payload: { handoff_ref: 'x/y' } }),
      /no phase 'conductor-direct' on run 'r-0001'.*phases: p1/s,
      'unknown phase refused, run phases named'
    );
    assert.equal(store.getPendingExit('r-0001'), undefined, 'nothing recorded — the slot stays empty');
    // abnormal signals with a bogus phase are refused the same way (never wedged)
    assert.throws(
      () => tools.agentExit({ phase_id: 'nope', agent_role: 'coder', signal: 'blocked', payload: { reason: 'r' } }),
      /no phase 'nope'/
    );
    // a valid phase still records exactly as before
    const { recorded } = tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } });
    assert.equal(recorded.phase_id, 'p1');
  } finally {
    cleanup();
  }
});

test('run_signal: reads the stored exit, applies the CAS transition, advances phases', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } });
    const r1 = tools.runSignal();
    assert.deepEqual(r1.action, { action: 'spawn', phase_id: 'p2', respawn: false });
    const after = tools.runState();
    assert.equal(after.phases[0].status, 'complete');
    assert.equal(after.phases[1].status, 'in_progress');
    assert.equal(after.phases[0].signals.length, 1);
    assert.equal(store.getPendingExit('r-0001'), undefined, 'exit consumed');

    // final phase → completing + complete_run
    tools.agentExit({ phase_id: 'p2', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p2/coder' } });
    const r2 = tools.runSignal();
    assert.equal(r2.action.action, 'complete_run');
    assert.equal(tools.runState('r-0001').machine_state, 'completing');
  } finally {
    cleanup();
  }
});

test('run_signal: conductor-reported agent-died, respawn then death cap; no exit at all is guided', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    assert.throws(() => tools.runSignal(), /no exit recorded.*agent-died/s);
    const died = { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'crash' as const } };
    const r1 = tools.runSignal({ exit: died });
    assert.equal(r1.action.action, 'spawn');
    assert.equal((r1.action as { respawn: boolean }).respawn, true);
    assert.equal(tools.runState().phases[0].status, 'in_progress', 'respawn keeps the phase open');

    const r2 = tools.runSignal({ exit: { ...died, payload: { observed: 'empty_output' } } });
    assert.equal(r2.action.action, 'judgment_needed');
    assert.equal(tools.runState().escalations.length, 1, 'escalation recorded on the run record');
  } finally {
    cleanup();
  }
});

test('agent_exit: a real-but-not-current phase is refused (currency, not just existence) — audit finding 3/43', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    // advance p1 → complete, p2 → in_progress
    tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } });
    tools.runSignal();
    assert.equal(tools.runState().phases[0].status, 'complete');
    // exit naming the already-complete p1 must refuse — it EXISTS but is not current
    assert.throws(
      () => tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/again' } }),
      /is 'complete', not the current \(in_progress\) phase.*'p2'/s,
      'stale-but-existing phase refused, current phase named'
    );
    assert.equal(store.getPendingExit('r-0001'), undefined, 'nothing recorded');
    // the current phase (p2) still records exactly as before
    const { recorded } = tools.agentExit({ phase_id: 'p2', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p2/coder' } });
    assert.equal(recorded.phase_id, 'p2', 'the current phase still records');
  } finally {
    cleanup();
  }
});

test('run_signal: an explicit exit refuses to overwrite an unconsumed recorded exit — audit finding 2/43', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    // agent recorded a valid exit
    tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'blocked', payload: { reason: 'stuck' } });
    // conductor reports a DIFFERENT signal explicitly — must refuse, nothing consumed
    assert.throws(
      () => tools.runSignal({ exit: { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'empty_output' } } }),
      /already has a recorded agent exit \(signal 'blocked'.*refusing to overwrite/s,
      'the recorded exit is protected'
    );
    assert.equal(store.getPendingExit('r-0001')!.signal, 'blocked', 'recorded exit survives the refusal');
    // reacting to the recorded exit (no explicit exit) still works
    const r = tools.runSignal();
    assert.equal(r.run_id, 'r-0001');
  } finally {
    cleanup();
  }
});

test('run_signal: a reconcile mark written concurrently (H7) SURVIVES the transition — merge-safe (audit findings 1/43, 18/43)', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } });
    // an H7 file-touch lands a reconcile mark on the run body AFTER the conductor's
    // conceptual read but BEFORE run_signal commits — the old casTransition rebuilt
    // the body from the stale read and dropped it, weakening dispose-run's refusal.
    const article = randomUUID();
    store.appendRunReconcileNeeded('r-0001', article);
    const r = tools.runSignal();
    assert.deepEqual(r.action, { action: 'spawn', phase_id: 'p2', respawn: false }, 'the phase still advances');
    const after = tools.runState('r-0001');
    assert.equal(after.phases[0].status, 'complete');
    assert.equal(after.phases[1].status, 'in_progress');
    assert.deepEqual(after.reconcile_needed, [article], 'the concurrent reconcile mark survived run_signal (dispose-run will still refuse on it)');
  } finally {
    cleanup();
  }
});

test('knowledge_create: caller cannot override the server-owned envelope (id/timestamps/status) — audit finding 14/43', () => {
  const { tools, cleanup } = harness();
  try {
    const forgedId = randomUUID();
    // The envelope is still unforgeable — but as of 2026-07-29 the attempt is
    // REFUSED rather than silently ignored. The strip alone satisfied finding
    // 14/43 while telling the caller the write succeeded, and a project acting on
    // that belief wrote store records asserting a retirement that never happened.
    assert.throws(
      () =>
        tools.knowledgeCreate('decision', {
          title: 'envelope test',
          statement: 's',
          alternatives_rejected: [],
          rationale: 'r',
          id: forgedId,
          status: 'superseded',
          superseded_by: randomUUID(),
          created_at: '2000-01-01T00:00:00.000Z',
          updated_at: '2000-01-01T00:00:00.000Z',
        }),
      (err: Error) => {
        assert.match(err.message, /SERVER-OWNED/);
        assert.match(err.message, /'id'/, 'the refusal names every attempted key');
        assert.match(err.message, /'status'/);
        // Corrected 2026-08-04: the message used to assert that NO retire path
        // exists, which knowledge_retire made false. It must now NAME the path and
        // its duplicate-only boundary, so neither half can rot silently again.
        assert.match(err.message, /knowledge_retire\(id, in_favor_of\)/, 'reaching for status gets pointed at the retirement path');
        assert.match(err.message, /genuine DUPLICATE/, 'and told the boundary, so it is not read as retire-away-your-errors');
        assert.doesNotMatch(err.message, /NO way to retire/, 'the superseded denial is gone');
        return true;
      }
    );
    assert.equal(tools.knowledgeQuery({ types: ['decision'], cap: 10 }).length, 0, 'the refused create wrote nothing');

    // A clean create still lands, born with the server's own envelope.
    const { record } = tools.knowledgeCreate('decision', {
      title: 'envelope test',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    });
    assert.notEqual(record.id, forgedId, 'server assigns the id');
    assert.equal(record.status, 'active', 'born active');
    assert.equal(record.superseded_by, null, 'not born superseded');
    // the record is actually served (a caller-forged status:superseded would have hidden it)
    const served = tools.knowledgeQuery({ types: ['decision'], cap: 10 });
    assert.ok(served.some((r) => r.id === record.id), 'the created record is visible to default queries');

    // The measured silent no-op, now loud: the retirement attempt that returned
    // status:'active' and superseded_by:null with no error (2026-07-29).
    assert.throws(() => tools.knowledgeUpdate(record.id, { status: 'superseded', superseded_by: randomUUID() }), /knowledge_retire/);
    assert.equal(tools.knowledgeGet(record.id).status, 'active', 'the refused update changed nothing');
  } finally {
    cleanup();
  }
});

test('maintenance_query: system_reason is filtered BEFORE the cap — matches past the cap are not missed (audit finding 33/43)', () => {
  const { tools, cleanup } = harness();
  try {
    // 55 newer reconcile_needed items, then 3 older promotion_review items
    for (let i = 0; i < 55; i++) tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: `r${i}` });
    for (let i = 0; i < 3; i++) tools.maintenanceEnqueue({ reason: 'promotion_review', text: `p${i}` });
    // default cap (50): the 3 promotion_review items must still be found, though
    // they are the oldest and would fall outside a cap-first slice
    const found = tools.maintenanceQuery({ system_reason: 'promotion_review' });
    assert.equal(found.length, 3, 'reason-filtered query finds all matches regardless of cap');
    assert.ok(found.every((t) => (t as { system_reason?: string }).system_reason === 'promotion_review'));
  } finally {
    cleanup();
  }
});

test('run_signal: unknown signal reaching the brain halts the run loudly and durably (P5)', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    const r = tools.runSignal({ exit: { signal: 'garbage', phase_id: 'p1' } });
    assert.equal(r.action.action, 'halt');
    assert.equal(tools.runState('r-0001').machine_state, 'halted');
  } finally {
    cleanup();
  }
});

test('handoff pair: write validates, read filters by phase and files', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    assert.throws(() => tools.handoffWrite({ handoff: { phase_id: 'p1' } }), /invalid/i);
    tools.handoffWrite({
      handoff: {
        phase_id: 'p1',
        agent_role: 'coder',
        what_changed: [{ path: 'src\\a.ts', change_role: 'implemented' }],
        wired: [],
        deferred: [],
        decisions_made: [],
        tests_produced: [],
        exit_signal: 'complete',
        unresolved: [],
      },
    });
    assert.equal(tools.handoffRead({ phase_id: 'p1' }).length, 1);
    assert.equal(tools.handoffRead({ files: ['src/a.ts'] }).length, 1);
    assert.equal(tools.handoffRead({ phase_id: 'p2' }).length, 0);
  } finally {
    cleanup();
  }
});

// --------------------------- AC2: reviewer disposition coverage enforcement (run r-d630 phase 2) ---------------------------
// A reviewer-role handoff_write must disposition EXACTLY the record_ids the run
// record's review_mandatory holds for that handoff's phase — set equality. A
// missing or extra id refuses the write LOUDLY, naming the offending ids, and
// nothing is persisted. Non-reviewer roles are entirely unaffected. Placement
// mirrors the 32fa4a05 agent_exit off-run-phase refusal (fail-loud at the seam,
// nothing written). REVIEWER_ROLES is imported, never redefined (invariant 1).

// The four exact agent_role strings the reviewer templates emit — pinned here so
// the wire is proven to fire for exactly these and no others (the free-string
// hole is left to the phase-3 disposal-fold backstop per decision 628c4b7f).
const REVIEWER_ROLE_STRINGS = ['reviewer-correctness', 'reviewer-security', 'reviewer-performance', 'reviewer-skeptic'] as const;

type Disposition = { record_id: string; disposition: 'addressed' | 'not_applicable_because'; reason?: string };

const handoffArgs = (agent_role: string, phase_id: string, dispositions?: Disposition[]) => ({
  handoff: {
    phase_id,
    agent_role,
    what_changed: [],
    wired: [],
    deferred: [],
    decisions_made: [],
    tests_produced: [],
    exit_signal: 'complete',
    unresolved: [],
    ...(dispositions ? { dispositions } : {}),
  },
});

test('AC2: the enforced reviewer role strings are exactly REVIEWER_ROLES — the wire fires for these four and no others', () => {
  // The pinned template strings and the imported registry must set-equal; if a
  // template role were renamed or a fifth reviewer added, this fails loudly.
  assert.deepEqual([...REVIEWER_ROLES].sort(), [...REVIEWER_ROLE_STRINGS].sort());
});

test('AC2: a reviewer handoff without exact review_mandatory coverage is REFUSED loudly (missing/extra ids named) with nothing written — all four roles', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    const m1 = randomUUID();
    const m2 = randomUUID();
    const extra = randomUUID();

    for (const role of REVIEWER_ROLE_STRINGS) {
      // replace-by-phase: p1 requires exactly {m1, m2}
      store.setRunReviewMandatory('r-0001', 'p1', [
        { record_id: m1, reason: 'blocking anti-pattern' },
        { record_id: m2, reason: 'blocking anti-pattern' },
      ]);

      // (a) no dispositions at all → both mandatory ids missing, both named
      assert.throws(
        () => tools.handoffWrite(handoffArgs(role, 'p1')),
        (err: Error) => new RegExp(m1).test(err.message) && new RegExp(m2).test(err.message) && /missing/i.test(err.message),
        `${role}: empty dispositions refused, both missing ids named`
      );

      // (b) partial coverage → the one uncovered id is named as missing
      assert.throws(
        () => tools.handoffWrite(handoffArgs(role, 'p1', [{ record_id: m1, disposition: 'addressed' }])),
        (err: Error) => new RegExp(m2).test(err.message) && /missing/i.test(err.message),
        `${role}: partial coverage refused, the missing id named`
      );

      // (c) superset → the id not in the mandatory set is named as extra
      assert.throws(
        () =>
          tools.handoffWrite(
            handoffArgs(role, 'p1', [
              { record_id: m1, disposition: 'addressed' },
              { record_id: m2, disposition: 'addressed' },
              { record_id: extra, disposition: 'addressed' },
            ])
          ),
        (err: Error) => new RegExp(extra).test(err.message) && /extra/i.test(err.message),
        `${role}: superset refused, the extra id named`
      );
    }

    // every refused write persisted NOTHING (the seam refuses before writing)
    assert.equal(tools.handoffRead({ phase_id: 'p1' }).length, 0, 'no refused reviewer handoff was persisted');
  } finally {
    cleanup();
  }
});

test('AC2: a reviewer handoff with EXACT coverage lands — any mix of addressed / not_applicable_because+reason — all four roles', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    const m1 = randomUUID();
    const m2 = randomUUID();
    store.setRunReviewMandatory('r-0001', 'p1', [
      { record_id: m1, reason: 'blocking anti-pattern' },
      { record_id: m2, reason: 'blocking anti-pattern' },
    ]);
    for (const role of REVIEWER_ROLE_STRINGS) {
      assert.doesNotThrow(
        () =>
          tools.handoffWrite(
            handoffArgs(role, 'p1', [
              { record_id: m1, disposition: 'addressed' },
              { record_id: m2, disposition: 'not_applicable_because', reason: 'out of scope for this surface' },
            ])
          ),
        `${role}: exact-coverage reviewer handoff lands`
      );
      assert.ok(
        tools.handoffRead({ phase_id: 'p1' }).some((h) => (h as { agent_role?: string }).agent_role === role),
        `${role}: the landed reviewer handoff is readable`
      );
    }
  } finally {
    cleanup();
  }
});

test('AC2: a reviewer handoff lands with NO dispositions when the phase mandatory set is empty; a DIFFERENT phase\'s review_mandatory never binds this phase', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    // (1) no review_mandatory anywhere → empty set-equals empty → lands, no dispositions
    assert.doesNotThrow(() => tools.handoffWrite(handoffArgs('reviewer-correctness', 'p1')));
    assert.equal(tools.handoffRead({ phase_id: 'p1' }).length, 1);

    // (2) review_mandatory seeded ONLY for p2 must not bind a p1 handoff
    store.setRunReviewMandatory('r-0001', 'p2', [{ record_id: randomUUID(), reason: 'blocking anti-pattern' }]);
    assert.doesNotThrow(() => tools.handoffWrite(handoffArgs('reviewer-security', 'p1')));
    assert.equal(tools.handoffRead({ phase_id: 'p1' }).length, 2, "another phase's mandatory set never binds p1");
  } finally {
    cleanup();
  }
});

test('AC2: non-reviewer handoffs are entirely unaffected — they land with or without dispositions regardless of review_mandatory state', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    const m1 = randomUUID();
    // a non-empty mandatory set that a reviewer WOULD have to satisfy exactly
    store.setRunReviewMandatory('r-0001', 'p1', [{ record_id: m1, reason: 'blocking anti-pattern' }]);

    // coder with NO dispositions → lands despite the non-empty mandatory set
    assert.doesNotThrow(() => tools.handoffWrite(handoffArgs('coder', 'p1')));
    // test-writer WITH non-matching dispositions → dispositions ignored, lands
    assert.doesNotThrow(() =>
      tools.handoffWrite(handoffArgs('test-writer', 'p1', [{ record_id: randomUUID(), disposition: 'addressed' }]))
    );
    assert.equal(tools.handoffRead({ phase_id: 'p1' }).length, 2, 'both non-reviewer handoffs persisted, coverage never checked');
  } finally {
    cleanup();
  }
});

// --------------------------- note structuring dispatch (board ccb14030) ---------------------------
// knowledgeCreate itself dispatches the bundled worker — originally because
// PostToolUse did not fire on MCP tool calls (CC 2.1.198), now by decision
// 5ef11bd4 since that constraint was disproven (research_finding e7bd5c19).
// These tests pin the
// dispatch seam; the worker's own behavior stays covered in hooks-full.test.mjs.

test('note create dispatches note-structuring with the hook-shaped payload; success is not a skip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tools-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const payloads: NoteExtractionPayload[] = [];
  const tools = new SterlingTools({
    store,
    now: () => NOW,
    repoRoot: dir,
    noteExtraction: (p) => {
      payloads.push(p);
      return { dispatched: true };
    },
  });
  try {
    const { record, check_skipped } = tools.knowledgeCreate('note', {
      raw_text: 'queue-level retries beat global backoff',
      captured_at: NOW,
      capture_source: 'conductor',
      derived: [],
    });
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].cwd, dir, 'worker opens the store at the project root');
    assert.equal(payloads[0].tool_input.type, 'note');
    assert.equal(payloads[0].tool_input.fields.raw_text, 'queue-level retries beat global backoff');
    const echoed = JSON.parse(payloads[0].tool_response.content[0].text) as { record: { id: string } };
    assert.equal(echoed.record.id, record.id, 'tool_response carries the created record like the hook input did');
    assert.ok(
      !check_skipped.some((s) => s.check === 'note-structuring-h11'),
      'a dispatched extraction is not a skipped check'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('note-structuring dispatch failure is loud: reason in the envelope AND a store row (P5)', () => {
  // no repoRoot → the server cannot tell the worker where the store lives
  const { store, tools, cleanup } = harness();
  try {
    const { check_skipped } = tools.knowledgeCreate('note', {
      raw_text: 'a note with nowhere to extract',
      captured_at: NOW,
      capture_source: 'conductor',
      derived: [],
    });
    assert.ok(check_skipped.some((s) => s.check === 'note-structuring-h11' && s.reason === 'no_repo_root'));
    assert.ok(store.listCheckSkipped().some((s) => s.check_name === 'note-structuring-h11' && s.reason === 'no_repo_root'));
  } finally {
    cleanup();
  }

  // an injected dispatcher that reports failure (e.g. worker script missing) surfaces its reason
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tools-'));
  const store2 = new SterlingStore(join(dir, 'sterling.db'));
  const tools2 = new SterlingTools({
    store: store2,
    now: () => NOW,
    repoRoot: dir,
    noteExtraction: () => ({ dispatched: false, reason: 'worker_script_missing' }),
  });
  try {
    const { check_skipped } = tools2.knowledgeCreate('note', {
      raw_text: 'another note',
      captured_at: NOW,
      capture_source: 'conductor',
      derived: [],
    });
    assert.ok(check_skipped.some((s) => s.check === 'note-structuring-h11' && s.reason === 'worker_script_missing'));
  } finally {
    store2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default dispatch spawns the bundled worker end-to-end: candidate lands derived_unconfirmed citing the note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-note-e2e-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const fake = join(dir, 'fake-extractor.mjs');
  writeFileSync(
    fake,
    `process.stdout.write(JSON.stringify({ candidates: [{ type: 'decision', fields: { title: 'Queue-level retries', statement: 'Retry per queue, not global backoff.', alternatives_rejected: [], rationale: 'per-org limits' } }] }));`
  );
  const prevExtractor = process.env.STERLING_H11_EXTRACTOR;
  process.env.STERLING_H11_EXTRACTOR = fake;
  const tools = new SterlingTools({ store, repoRoot: dir }); // default noteExtraction — the real spawn
  try {
    const { record, check_skipped } = tools.knowledgeCreate('note', {
      raw_text: 'genesys rate limits are per-org; we chose queue-level retries',
      captured_at: NOW,
      capture_source: 'conductor',
      derived: [],
    });
    assert.ok(!check_skipped.some((s) => s.check === 'note-structuring-h11'), 'dispatch started');
    // fire-and-forget: poll the store for the worker's cross-process write
    const deadline = Date.now() + 20_000;
    let candidates: DurableRecord[] = [];
    while (Date.now() < deadline) {
      candidates = store.query({ types: ['decision'], include_unconfirmed: true, cap: 5 });
      if (candidates.length) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(candidates.length, 1, 'worker wrote the extraction candidate');
    assert.equal(candidates[0].derived_unconfirmed, true);
    assert.ok(candidates[0].links.some((l) => l.rel === 'cites' && l.target_id === record.id), 'candidate cites the note');
    assert.deepEqual((store.get(record.id) as { derived: string[] }).derived, [candidates[0].id], 'note.derived[] updated');
  } finally {
    if (prevExtractor === undefined) delete process.env.STERLING_H11_EXTRACTOR;
    else process.env.STERLING_H11_EXTRACTOR = prevExtractor;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// knowledge_get id-PREFIX resolution (decision 27f148c2) — the citation format
// the whole repo writes, which get() alone could not serve.
// ---------------------------------------------------------------------------

test('knowledge_get resolves the 8-char citation prefix, at any status, and refuses ambiguity loudly', () => {
  const { store, tools, cleanup } = harness();
  try {
    const rec = tools.knowledgeCreate('decision', {
      title: 'a choice',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    }).record as unknown as DurableRecord;

    const byPrefix = tools.knowledgeGet(rec.id.slice(0, 8));
    assert.equal(byPrefix.id, rec.id, 'an 8-char prefix resolves to the record');
    assert.equal(tools.knowledgeGet(rec.id).id, rec.id, 'full-id lookups are unchanged');

    // A SUPERSEDED record must stay reachable by prefix: citing the version that
    // was live at the time is legitimate and common (history entries do it).
    const next = tools.knowledgeUpdate(rec.id, { rationale: 'r2' });
    assert.equal(tools.knowledgeGet(rec.id.slice(0, 8)).status, 'superseded', 'tombstones resolve by prefix too');
    assert.equal(tools.knowledgeGet(next.id.slice(0, 8)).id, next.id);

    assert.throws(() => tools.knowledgeGet('deadbeef'), /no record 'deadbeef'/, 'an unknown prefix is a plain miss');
    assert.throws(
      () => tools.knowledgeGet(rec.id.slice(0, 4)),
      /too little to resolve/,
      'shorter than the citation prefix is refused as under-specified, not searched'
    );

    // Collision: two records sharing an 8-char prefix must refuse, never pick.
    const collide = store.recordIdIndex()[0].id.slice(0, 8);
    const twin = tools.knowledgeCreate('decision', {
      title: 'twin',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    }).record as unknown as DurableRecord;
    // ids are server-minted, so the collision is forced through the store directly.
    store.create({
      ...(JSON.parse(JSON.stringify(twin)) as Record<string, unknown>),
      id: `${collide}-0000-4000-8000-000000000000`,
    });
    assert.throws(() => tools.knowledgeGet(collide), /is ambiguous — it prefixes 2 records/, 'a collision names both candidates');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The run wire outside a run (decision 391fae4f): eight agents in a consuming
// project burned tokens diagnosing `run_state: no active run`.
// ---------------------------------------------------------------------------

test('agent_exit/handoff_write/handoff_read name conductor-direct when no run is active, and record nothing', () => {
  const { store, tools, cleanup } = harness();
  try {
    for (const call of [
      () => tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } }),
      () => tools.handoffWrite({ handoff: { phase_id: 'p1', agent_role: 'coder' } }),
      () => tools.handoffRead({}),
    ]) {
      assert.throws(call, /no run is active/, 'the refusal names the real precondition, not run_state');
      assert.throws(call, /CONDUCTOR-DIRECT mode, not a fault to diagnose/, 'and says it is a mode, not a bug to chase');
      assert.throws(call, /final message IS your deliverable/, 'and tells the agent what to do instead');
      assert.throws(call, /never invent a run_id/, 'and forecloses the fabricated-run_id retry that was measured');
    }
    assert.equal(store.getRun(), undefined, 'nothing was recorded and no implicit run was minted');

    // THE MEASURED RETRY: agents fabricated a run_id when the first call failed.
    // Keying the guard on "did the caller omit run_id" let exactly that case fall
    // through to the bare `no run '<made up>'` this change exists to kill.
    assert.throws(
      () => tools.agentExit({ run_id: 'r-invented', phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'x' } }),
      /CONDUCTOR-DIRECT mode, not a fault to diagnose/,
      'a fabricated run_id with no active run gets the guidance, not the bare no-run error'
    );
    assert.throws(() => tools.handoffRead({ run_id: 'r-invented' }), /final message IS your deliverable/);

    // The guidance is scoped to the runless case: with a run active, the existing
    // off-run-phase refusal is untouched.
    startRun(store);
    assert.throws(
      () => tools.agentExit({ phase_id: 'nope', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'x' } }),
      /no phase 'nope' on run/
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FEEDBACK BATCH 2026-08-03 (§2.5, §2.7, §2.12, §3.4, §3.6, §3.9, §3.10 + board
// fd6d8da9): slug-collision refusal, the schema read, the retirement path, the
// queue-scoped removal, and the surgical string edit.
// ---------------------------------------------------------------------------

function articleFields(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    title: slug,
    what_it_does: `${slug} does the thing`,
    intended_behavior: `${slug} intends`,
    files: [{ path: `src/${slug}.ts`, role: 'owner' }],
    current_ac: [{ ac_id: 'AC1', text: 'works', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
    ...extra,
  };
}

test('knowledge_create REFUSES a second feature_article under an existing slug (§2.5)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: first } = tools.knowledgeCreate('feature_article', articleFields('multiplayer'));
    assert.throws(
      () => tools.knowledgeCreate('feature_article', articleFields('multiplayer', { title: 'DUPLICATE of multiplayer' })),
      (e: Error) => {
        assert.match(e.message, /already exists/, 'names the collision');
        assert.ok(e.message.includes(first.id), 'names the record to update instead — a refusal without a next step is where the tombstone workaround got invented');
        assert.match(e.message, /knowledge_update/, 'points at fix-it-forward');
        assert.match(e.message, /knowledge_retire/, 'and at the wholesale-replacement path');
        return true;
      }
    );
    // The refusal must not have written anything.
    assert.equal(tools.knowledgeQuery({ types: ['feature_article'] }).length, 1, 'no duplicate landed');
  } finally {
    cleanup();
  }
});

test('knowledge_create slug refusal is scoped: a different slug passes, and non-articles are unaffected', () => {
  const { tools, cleanup } = harness();
  try {
    tools.knowledgeCreate('feature_article', articleFields('alpha'));
    tools.knowledgeCreate('feature_article', articleFields('beta'));
    assert.equal(tools.knowledgeQuery({ types: ['feature_article'] }).length, 2);
    // Two decisions may share a title — only ARTICLE SLUGS are unique.
    const d = { title: 'same', statement: 's', alternatives_rejected: [], rationale: 'r' };
    tools.knowledgeCreate('decision', d);
    tools.knowledgeCreate('decision', d);
    assert.equal(tools.knowledgeQuery({ types: ['decision'] }).length, 2);
  } finally {
    cleanup();
  }
});

test('a superseded slug does NOT block a create — only a live one does', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: v1 } = tools.knowledgeCreate('feature_article', articleFields('gamma'));
    tools.knowledgeUpdate(v1.id, { what_it_does: 'revised' }); // v1 becomes superseded
    // The live head still holds the slug, so a create is still refused.
    assert.throws(() => tools.knowledgeCreate('feature_article', articleFields('gamma')), /already exists/);
  } finally {
    cleanup();
  }
});

test('knowledge_schema reports required vs optional, types and closed enums (§2.7)', () => {
  const { tools, cleanup } = harness();
  try {
    const dec = tools.knowledgeSchema('decision');
    assert.ok(dec.required.includes('title'), 'title required — the field rejected three times across three types');
    assert.ok(dec.required.includes('statement'));
    assert.ok(dec.required.includes('rationale'));
    assert.ok(dec.optional.includes('file_keys'), 'file_keys optional on decision');
    const alts = dec.fields.find((f) => f.name === 'alternatives_rejected');
    assert.ok(alts, 'alternatives_rejected is reported');
    assert.equal(alts?.type, '{option, reason}[]', 'an array of OBJECTS, not of strings — the shape that refused a write this session');

    // The closed enum the feedback documented a plausible-but-refused value for.
    const vol = tools.knowledgeSchema('research_finding').fields.find((f) => f.name === 'volatility_hint');
    assert.ok(vol, 'volatility_hint is reported');
    assert.deepEqual(vol?.enum_values, ['fast', 'medium', 'stable'], "so 'low' is visibly not an option");

    // feature_article's four undocumented-required fields.
    const art = tools.knowledgeSchema('feature_article');
    for (const f of ['slug', 'version', 'history', 'live_test_refs']) {
      assert.ok(art.required.includes(f), `${f} reported required`);
    }
    assert.ok(art.optional.includes('concept_family'), 'concept_family is an optional STRING, not a boolean mark');
    assert.equal(art.fields.find((f) => f.name === 'concept_family')?.type, 'string');

    assert.throws(() => tools.knowledgeSchema('escalation_log'), (e: Error) => {
      assert.match(e.message, /not a registered record type/);
      assert.match(e.message, /decision/, 'lists the registered vocabulary — not knowing it is why you called');
      return true;
    });
  } finally {
    cleanup();
  }
});

test('knowledge_schema is derived from the live schema — every registered type answers', () => {
  const { tools, cleanup } = harness();
  try {
    for (const type of ['decision', 'anti_pattern', 'research_finding', 'reference_material', 'feature_article', 'note', 'todo', 'brief']) {
      const s = tools.knowledgeSchema(type);
      assert.ok(s.fields.length > 0, `${type} reports fields`);
      assert.ok(s.required.includes('type'), `${type} reports the envelope`);
      assert.ok(
        s.fields.every((f) => typeof f.type === 'string' && f.type !== 'unknown'),
        `${type} has no undescribed field types`
      );
    }
  } finally {
    cleanup();
  }
});

test('knowledge_retire supersedes in favour of a survivor; queries stop serving it, id still resolves (§3.9)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: canonical } = tools.knowledgeCreate('feature_article', articleFields('runtime-architecture'));
    const { record: dupe } = tools.knowledgeCreate('decision', {
      title: 'DUPLICATE of runtime-architecture',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    });
    assert.equal(tools.knowledgeQuery({ types: ['decision'] }).length, 1, 'the duplicate is served before retirement');

    const { retired } = tools.knowledgeRetire(dupe.id, canonical.id);
    assert.equal(retired.status, 'superseded');
    assert.equal(retired.superseded_by, canonical.id, 'it forwards to the survivor — an old citation lands right');
    assert.equal(tools.knowledgeQuery({ types: ['decision'] }).length, 0, 'retrieval stops serving it — retiring now REDUCES visibility');
    assert.equal(tools.knowledgeGet(dupe.id).status, 'superseded', 'provenance survives: still fetchable by id');
  } finally {
    cleanup();
  }
});

test('knowledge_retire refuses self-retirement, a missing or dead survivor, and P4 record types', () => {
  const { tools, store, cleanup } = harness();
  try {
    const { record: a } = tools.knowledgeCreate('decision', { title: 'a', statement: 's', alternatives_rejected: [], rationale: 'r' });
    const { record: b } = tools.knowledgeCreate('decision', { title: 'b', statement: 's', alternatives_rejected: [], rationale: 'r' });
    assert.throws(() => tools.knowledgeRetire(a.id, a.id), /cannot be retired in favour of itself/);
    assert.throws(() => tools.knowledgeRetire(a.id, randomUUID()), /no record .* to retire in favour of/);
    assert.throws(() => tools.knowledgeRetire(randomUUID(), b.id), /no record/);

    // A survivor that is itself a tombstone would forward the reader nowhere.
    const { record: c } = tools.knowledgeCreate('decision', { title: 'c', statement: 's', alternatives_rejected: [], rationale: 'r' });
    tools.knowledgeRetire(c.id, b.id);
    assert.throws(() => tools.knowledgeRetire(a.id, c.id), /itself superseded/);

    // todos/notes have their own P4 removal path and must not gain a second one.
    const { record: todo } = tools.boardAdd({ text: 'a todo', source: 'user' });
    assert.throws(() => tools.knowledgeRetire(todo.id, b.id), /board_remove \/ maintenance_remove/);
    // Field set read off knowledge_schema('note') rather than guessed.
    const note = store.create({
      id: randomUUID(), type: 'note', created_at: NOW, updated_at: NOW, author: 'user', status: 'active',
      superseded_by: null, links: [], scope: 'project', stack_tags: [],
      raw_text: 'n', captured_at: NOW, capture_source: 'conductor', derived: [],
    } as unknown as DurableRecord);
    assert.throws(() => tools.knowledgeRetire(note.id, b.id), /note_remove/);
  } finally {
    cleanup();
  }
});

test('maintenance_remove closes a system item and REFUSES a user board item (§2.12)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: sys } = tools.maintenanceEnqueue({ reason: 'article_missing', text: 'no article owns src/x.ts', file_keys: ['src/x.ts'] });
    const { record: usr } = tools.boardAdd({ text: "the human's own item", source: 'user' });

    // The lane the librarian could never close: no feature_link, so no auto-drain.
    const { removed } = tools.maintenanceRemove(sys.id);
    assert.equal(removed, sys.id);
    assert.equal(tools.boardQuery({ source: 'system' }).length, 0, 'the queue item is closed');

    assert.throws(() => tools.maintenanceRemove(usr.id), (e: Error) => {
      assert.match(e.message, /not a maintenance-queue item/);
      assert.match(e.message, /board_remove/, 'names the conductor path rather than only blocking');
      return true;
    });
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, "the user's board is untouched");
  } finally {
    cleanup();
  }
});

test('knowledge_edit replaces a unique passage in a long string without retransmitting it (board fd6d8da9)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record } = tools.knowledgeCreate('feature_article', articleFields('hooks-suite', {
      what_it_does: 'TWENTY-THREE standalone .mjs hooks authored in scripts/hooks, bundled into hooks/. The set: H1 SessionStart, H2 inject, H3 gate.',
    }));
    const { record: v2, replaced } = tools.knowledgeEdit(record.id, 'what_it_does', 'TWENTY-THREE standalone', 'TWENTY-FOUR standalone');
    assert.match((v2 as unknown as { what_it_does: string }).what_it_does, /^TWENTY-FOUR standalone \.mjs hooks/);
    assert.match((v2 as unknown as { what_it_does: string }).what_it_does, /The set: H1 SessionStart, H2 inject, H3 gate\.$/, 'the rest of the field is untouched');
    assert.equal((v2 as unknown as { version: number }).version, 2, 'a normal supersession, not a back door');
    assert.equal(replaced.field, 'what_it_does');
    assert.equal(replaced.chars_after, replaced.chars_before - 1, 'THREE -> FOUR is one char shorter');
  } finally {
    cleanup();
  }
});

test('knowledge_edit refuses a miss and an AMBIGUOUS match, writing nothing either way', () => {
  const { tools, cleanup } = harness();
  try {
    const { record } = tools.knowledgeCreate('feature_article', articleFields('amb', {
      what_it_does: 'the hook fires. the hook fires again.',
    }));
    assert.throws(() => tools.knowledgeEdit(record.id, 'what_it_does', 'absent text', 'x'), (e: Error) => {
      assert.match(e.message, /does not appear/);
      assert.match(e.message, /nothing was written/);
      return true;
    });
    assert.throws(() => tools.knowledgeEdit(record.id, 'what_it_does', 'the hook fires', 'the hook does not fire'), (e: Error) => {
      assert.match(e.message, /appears 2 times/, 'reports the count');
      assert.match(e.message, /nothing was written/);
      assert.match(e.message, /Extend 'find'/, 'says how to disambiguate');
      return true;
    });
    assert.equal((tools.knowledgeGet(record.id) as unknown as { version: number }).version, 1, 'no version was minted by either refusal');

    // Disambiguating by extending the match is the documented remedy.
    const { record: v2 } = tools.knowledgeEdit(record.id, 'what_it_does', 'the hook fires again', 'the hook fires once more');
    assert.match((v2 as unknown as { what_it_does: string }).what_it_does, /once more/);
  } finally {
    cleanup();
  }
});

test('knowledge_edit refuses a non-string field and an empty find', () => {
  const { tools, cleanup } = harness();
  try {
    const { record } = tools.knowledgeCreate('feature_article', articleFields('kinds'));
    assert.throws(() => tools.knowledgeEdit(record.id, 'files', 'x', 'y'), /not a string/);
    assert.throws(() => tools.knowledgeEdit(record.id, 'files', 'x', 'y'), /knowledge_append/, 'routes arrays to the right tool');
    assert.throws(() => tools.knowledgeEdit(record.id, 'what_it_does', '', 'y'), /non-empty string/);
    assert.throws(() => tools.knowledgeEdit(record.id, 'nonexistent_field', 'x', 'y'), /does not define/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// PARKED vs DELETED (board 1d6a721a / feedback §2.3+§2.4). Every existence check
// evaluates the CHECKED-OUT tree, so a file on an unmerged branch read as an
// out-of-band deletion — and that reconcile_needed could never be closed, because
// the trigger is absence and no write makes a file appear. It re-fired on every
// read. These tests pin: git is asked before concluding, a parked file gets an
// INFORMATIONAL lane instead, and a genuinely absent file still flags.
// ---------------------------------------------------------------------------

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-parked-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  return { dir, store, tools, git, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const systemQueue = (tools: SterlingTools) =>
  tools.boardQuery({ source: 'system' }) as unknown as { id: string; system_reason: string; text: string; file_keys?: string[]; feature_link?: string }[];

test('a file parked on an unmerged branch is file_parked, NOT an out-of-band deletion', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'seed.ts'), 'export const s = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');

    // The owned file exists ONLY on a side branch — exactly the reported case.
    git('checkout', '-q', '-b', 'feat/parked');
    mkdirSync(join(dir, 'game'), { recursive: true });
    writeFileSync(join(dir, 'game', 'terrain.gd'), 'extends Node\n');
    git('add', '-A');
    git('commit', '-qm', 'terrain on a branch');
    git('checkout', '-q', 'main');
    assert.ok(!existsSync(join(dir, 'game', 'terrain.gd')), 'precondition: absent from the working tree');

    const article = mkArticle(tools, 'world-generation', 'game/terrain.gd');
    tools.knowledgeQuery({ types: ['feature_article'] });

    const queue = systemQueue(tools);
    assert.equal(queue.filter((t) => t.system_reason === 'reconcile_needed').length, 0, 'no unclosable reconcile item for a file that is merely elsewhere');
    const parkedItems = queue.filter((t) => t.system_reason === 'file_parked');
    assert.equal(parkedItems.length, 1, 'the informational lane carries it instead');
    assert.match(parkedItems[0].text, /ALIVE on 'feat\/parked'/, 'and names the ref that holds it');
    assert.match(parkedItems[0].text, /DO NOT DROP game\/terrain\.gd/, 'warns against the tempting wrong fix');
    assert.equal(parkedItems[0].feature_link, article.id);

    // The article's claims are accurate, so a reader must NOT be told to verify.
    const [served] = tools.knowledgeQueryResult({ types: ['feature_article'] }).records as unknown as { verify_before_use?: boolean }[];
    assert.ok(!served.verify_before_use, 'a parked file is not staleness — the article is correct as written');
  } finally {
    cleanup();
  }
});

test('a parked file is recorded ONCE however many times the article is read', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    writeFileSync(join(dir, 'seed.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');
    git('checkout', '-q', '-b', 'side');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'gone.ts'), 'export const g = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'add');
    git('checkout', '-q', 'main');

    mkArticle(tools, 'parked-twice', 'src/gone.ts');
    for (let i = 0; i < 4; i++) tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(systemQueue(tools).filter((t) => t.system_reason === 'file_parked').length, 1, 'a pure-function-of-disk read path must not pile up copies');
  } finally {
    cleanup();
  }
});

test('a file that exists on NO ref still flags as an out-of-band deletion — the arm is trustworthy, not disabled', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    writeFileSync(join(dir, 'seed.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');

    mkArticle(tools, 'really-gone', 'src/never-existed.ts');
    tools.knowledgeQuery({ types: ['feature_article'] });
    const queue = systemQueue(tools);
    assert.equal(queue.filter((t) => t.system_reason === 'file_parked').length, 0, 'nothing to park — it lives nowhere');
    const reconciles = queue.filter((t) => t.system_reason === 'reconcile_needed');
    assert.equal(reconciles.length, 1, 'the deletion finding survives the change');
    assert.match(reconciles[0].text, /no longer exists \(out-of-band deletion\)/);
  } finally {
    cleanup();
  }
});

test('a file present in HEAD but deleted from the working tree parks against HEAD', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'committed.ts'), 'export const c = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');
    rmSync(join(dir, 'src', 'committed.ts')); // deleted on disk, still in HEAD

    mkArticle(tools, 'head-parked', 'src/committed.ts');
    tools.knowledgeQuery({ types: ['feature_article'] });
    const parkedItems = systemQueue(tools).filter((t) => t.system_reason === 'file_parked');
    assert.equal(parkedItems.length, 1);
    assert.match(parkedItems[0].text, /ALIVE on 'HEAD'/, 'HEAD is probed first — the commonest shape, in one call');
  } finally {
    cleanup();
  }
});

test('outside a git repo the deletion arm behaves exactly as before (the probe degrades in the safe direction)', () => {
  // No git init: every probe fails, so nothing is parked and the deletion item
  // still fires. A missing or broken git must never SUPPRESS a real finding.
  const dir = mkdtempSync(join(tmpdir(), 'sterling-nogit-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  try {
    mkArticle(tools, 'nogit', 'src/absent.ts');
    tools.knowledgeQuery({ types: ['feature_article'] });
    const queue = systemQueue(tools);
    assert.equal(queue.filter((t) => t.system_reason === 'reconcile_needed').length, 1, 'the deletion finding is preserved');
    assert.equal(queue.filter((t) => t.system_reason === 'file_parked').length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('knowledge_update does NOT auto-drain a file_parked item — no write changes where the file lives', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    writeFileSync(join(dir, 'seed.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');
    git('checkout', '-q', '-b', 'side');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'p.ts'), 'export const p = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'add');
    git('checkout', '-q', 'main');

    const article = mkArticle(tools, 'no-drain', 'src/p.ts');
    tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(systemQueue(tools).filter((t) => t.system_reason === 'file_parked').length, 1);

    tools.knowledgeUpdate(article.id, { what_it_does: 'revised' });
    assert.equal(
      systemQueue(tools).filter((t) => t.system_reason === 'file_parked').length,
      1,
      'the drift auto-drain is scoped to the two drift lanes; this fact is still true after the write'
    );
  } finally {
    cleanup();
  }
});

test('an article whose own role text DISCLAIMS a path is told so on the item (§2.10 forever-item)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-disclaim-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.ts'), 'v1\n');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  try {
    // The degenerate shape a consuming project found: the article owns the file
    // and its own role says the entry is historical, redirecting the reader
    // elsewhere. Every future edit to that file enqueues an already-paid no-op.
    const art = tools.knowledgeCreate('feature_article', {
      slug: 'dev-toolchain-setup',
      title: 'dev-toolchain-setup',
      what_it_does: 'proves the LSP resolves symbols',
      intended_behavior: 'x',
      files: [{ path: 'src/main.ts', role: 'HISTORICAL — a leftover from proving the LSP could resolve symbols; see world-visuals for the actual behaviour' }],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    }).record;

    // A real out-of-band content change, so the drift wire fires.
    writeFileSync(join(dir, 'src', 'main.ts'), 'v2 changed\n');
    const future = new Date(Date.parse(NOW) + 86_400_000);
    utimesSync(join(dir, 'src', 'main.ts'), future, future);
    tools.knowledgeQuery({ types: ['feature_article'] });

    const [item] = tools.maintenanceQuery({ system_reason: 'reconcile_needed', cap: 10 }) as unknown as { text: string; feature_link?: string }[];
    assert.equal(item.feature_link, art.id);
    assert.match(item.text, /disclaims ownership of it/, 'the observation lands on the item — the only place a reader will look');
    assert.match(item.text, /will recur on every future edit/, 'and says why this is not just noise');
    assert.match(item.text, /Consider REMOVING src\/main\.ts from files\[\]/, 'offering the real remedy');
    assert.match(item.text, /check the co-owners first/, 'without inviting an orphaned path');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an ordinary role text gets NO disclaimer note — the hint is tuned for precision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-noclaim-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'own.ts'), 'v1\n');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  try {
    tools.knowledgeCreate('feature_article', {
      slug: 'real-owner',
      title: 'real-owner',
      what_it_does: 'x',
      intended_behavior: 'x',
      // Mentions another article WITHOUT disclaiming: a false positive here would
      // tell someone to drop a path they actually own, the expensive direction.
      files: [{ path: 'src/own.ts', role: 'the serializer; see world-visuals for the rendering side' }],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    });
    writeFileSync(join(dir, 'src', 'own.ts'), 'v2 changed\n');
    const future = new Date(Date.parse(NOW) + 86_400_000);
    utimesSync(join(dir, 'src', 'own.ts'), future, future);
    tools.knowledgeQuery({ types: ['feature_article'] });
    const [item] = tools.maintenanceQuery({ system_reason: 'reconcile_needed', cap: 10 }) as unknown as { text: string }[];
    assert.doesNotMatch(item.text, /disclaims ownership/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// STATE HONESTY (board db7cd16c / feedback §2.8). Nothing watched the state
// field — the hooks watch content hashes — so an article sat at `planned` over a
// shipped, wired, probe-verified feature whose ten ACs all held. The prose was
// right; the METADATA was the lie, and metadata is what a reader trusts first.
// ---------------------------------------------------------------------------

function stateProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-state-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  return { dir, store, tools, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const stateReviews = (tools: SterlingTools) =>
  tools.maintenanceQuery({ system_reason: 'state_review', cap: 50 }) as unknown as { text: string; file_keys?: string[]; feature_link?: string }[];

const shippedArticle = (tools: SterlingTools, over: Record<string, unknown> = {}) =>
  tools.knowledgeCreate('feature_article', {
    slug: 'housing',
    title: 'housing',
    what_it_does: 'houses the dome farmers',
    intended_behavior: 'x',
    files: [{ path: 'src/housing.ts', role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'planned',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
    ...over,
  }).record;

test("an article claiming 'planned' over real code raises state_review", () => {
  const { dir, tools, cleanup } = stateProject();
  try {
    // 674 lines was the measured case; anything past a placeholder qualifies.
    writeFileSync(join(dir, 'src', 'housing.ts'), 'export const x = 1;\n'.repeat(300));
    const art = shippedArticle(tools);
    tools.knowledgeQuery({ types: ['feature_article'] });

    const items = stateReviews(tools);
    assert.equal(items.length, 1);
    assert.equal(items[0].feature_link, art.id);
    assert.match(items[0].text, /declares state 'planned' while the files it owns hold \d+ bytes/);
    assert.match(items[0].text, /Check the prose against the code before changing anything/, 'the fix is usually metadata, not a rewrite');
  } finally {
    cleanup();
  }
});

test('a small file does NOT raise it — a scaffolded placeholder is legitimately planned', () => {
  const { dir, tools, cleanup } = stateProject();
  try {
    writeFileSync(join(dir, 'src', 'housing.ts'), '// TODO: build housing\n');
    shippedArticle(tools);
    tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(stateReviews(tools).length, 0);
  } finally {
    cleanup();
  }
});

test("an 'active' article over real code raises nothing — the metadata is honest", () => {
  const { dir, tools, cleanup } = stateProject();
  try {
    writeFileSync(join(dir, 'src', 'housing.ts'), 'export const x = 1;\n'.repeat(300));
    shippedArticle(tools, { state: 'active' });
    tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(stateReviews(tools).length, 0);
  } finally {
    cleanup();
  }
});

test('an unverified files[] role raises state_review whatever the state, and names the paths', () => {
  const { dir, tools, cleanup } = stateProject();
  try {
    writeFileSync(join(dir, 'src', 'housing.ts'), 'export const x = 1;\n');
    shippedArticle(tools, {
      state: 'active',
      files: [{ path: 'src/housing.ts', role: 'ROLE NOT YET WRITTEN FROM THE FILE', unverified: true }],
    });
    tools.knowledgeQuery({ types: ['feature_article'] });

    const items = stateReviews(tools);
    assert.equal(items.length, 1, 'the honest "I do not know this yet" is now acted on rather than buried in prose');
    assert.match(items[0].text, /roles for src\/housing\.ts are still flagged unverified/);
    assert.deepEqual(items[0].file_keys, ['src/housing.ts'], 'and the item is keyed to the file whose role is owed');
  } finally {
    cleanup();
  }
});

test('state_review is minted ONCE across repeated reads, and clearing the flag stops it', () => {
  const { dir, tools, cleanup } = stateProject();
  try {
    writeFileSync(join(dir, 'src', 'housing.ts'), 'export const x = 1;\n');
    const art = shippedArticle(tools, {
      state: 'active',
      files: [{ path: 'src/housing.ts', role: 'not written yet', unverified: true }],
    });
    for (let i = 0; i < 3; i++) tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(stateReviews(tools).length, 1, 'the atomic dedup covers this lane too');

    // Writing the role from the file is the fulfilling artifact.
    tools.knowledgeUpdate(art.id, { files: [{ path: 'src/housing.ts', role: 'exports x, consumed by the dome loop' }] });
    const after = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal((after[0] as unknown as { files: { unverified?: boolean }[] }).files[0].unverified, undefined, 'the flag is gone');
    // The state_review item is NOT auto-drained (that drain is scoped to the two
    // drift lanes), so it is still open — but nothing NEW is minted.
    assert.equal(stateReviews(tools).length, 1, 'no second item once the condition is gone');
  } finally {
    cleanup();
  }
});

test("state_review does NOT double-report a deletion the drift arm already named", () => {
  const { dir, tools, cleanup } = stateProject();
  try {
    // 'active' with an absent file: the deletion item covers it; a second lane on
    // the same fact is the double-reporting this batch reduces.
    shippedArticle(tools, { state: 'active' });
    tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(stateReviews(tools).length, 0);
    assert.equal(tools.maintenanceQuery({ system_reason: 'reconcile_needed', cap: 10 }).length, 1, 'the deletion IS reported, once');
  } finally {
    cleanup();
  }
});
