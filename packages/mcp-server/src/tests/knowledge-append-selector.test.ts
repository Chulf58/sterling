// knowledge_append's array-element selector `arr[key=value].sub` (board
// 7e4850cf, sub-item d; Dome Farmer FRICTION 2026-10-02): add entries to the
// array held by ONE element of an array field without rewriting the outer
// array. The canonical case: add a test path to one acceptance criterion's
// `live_test_refs[ac_id=AC4].test_paths`. Before this, the only route was a
// whole-array knowledge_update of live_test_refs, which a librarian brief
// correctly forbade because it can miscopy the other entries.
//
// SPEC: the selector grammar and the match predicate are knowledge_edit's
// (`arr[key=value].sub`, an element counts only if it OWNS `key`). The
// selector must match exactly one element; zero and several are refused with
// the count. `sub` must already be an array on that element; anything else
// is refused. Every refusal writes nothing. A success rides the one versioned
// update path, so appended paths are POSIX-normalized by the shared schema
// and the directory-claim guard applies to them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-10-02T12:00:00.000Z';

type Ref = { ac_id: string; test_paths: string[] };
type Article = { id: string; version: number; live_test_refs: Ref[]; history: unknown[] };

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-append-selector-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, repoRoot: dir, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, tools, cleanup };
}

function mkArticle(tools: SterlingTools, refs: Ref[]): string {
  const { record } = tools.knowledgeCreate('feature_article', {
    slug: 'event-bag',
    title: 'event bag',
    what_it_does: 'does things',
    intended_behavior: 'intends things',
    files: [{ path: 'game/run/event_bag.gd', role: 'impl' }],
    current_ac: [
      { ac_id: 'AC1', text: 'one', verifiable_at: 'final' },
      { ac_id: 'AC4', text: 'four', verifiable_at: 'final' },
    ],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: refs,
  });
  return record.id as string;
}

function get(tools: SterlingTools, id: string): Article {
  return tools.knowledgeGet(id) as unknown as Article;
}

const SEED: Ref[] = [
  { ac_id: 'AC1', test_paths: ['game/test/run/a_test.gd', 'game/test/run/b_test.gd'] },
  { ac_id: 'AC4', test_paths: ['game/test/run/event_bag_test.gd'] },
];

test('CONTROL: live_test_refs[ac_id=AC4].test_paths appends to AC4 only; AC1 is untouched and the version bumps', () => {
  const { tools, cleanup } = harness();
  try {
    const id = mkArticle(tools, SEED);
    const before = get(tools, id);
    tools.knowledgeAppend(id, 'live_test_refs[ac_id=AC4].test_paths', ['game/test/run/event_bag_link_test.gd']);
    const after = get(tools, id);
    assert.equal(after.version, before.version + 1, 'one versioned write');
    assert.deepEqual(after.live_test_refs, [
      SEED[0],
      { ac_id: 'AC4', test_paths: ['game/test/run/event_bag_test.gd', 'game/test/run/event_bag_link_test.gd'] },
    ]);
    assert.deepEqual(after.history, before.history, 'no other field changes');
  } finally {
    cleanup();
  }
});

test('appended paths are POSIX-normalized by the shared schema', () => {
  const { tools, cleanup } = harness();
  try {
    const id = mkArticle(tools, SEED);
    tools.knowledgeAppend(id, 'live_test_refs[ac_id=AC1].test_paths', ['.\\game\\test\\run\\c_test.gd']);
    assert.deepEqual(get(tools, id).live_test_refs[0].test_paths, [
      'game/test/run/a_test.gd',
      'game/test/run/b_test.gd',
      'game/test/run/c_test.gd',
    ]);
  } finally {
    cleanup();
  }
});

function assertRefusedNothingWritten(tools: SterlingTools, id: string, call: () => unknown, pattern: RegExp, msg: string) {
  const before = get(tools, id);
  assert.throws(call, pattern, msg);
  const after = get(tools, id);
  assert.equal(after.version, before.version, `${msg}: no version minted`);
  assert.deepEqual(after.live_test_refs, before.live_test_refs, `${msg}: live_test_refs unchanged`);
}

test('a selector matching zero elements is refused naming 0', () => {
  const { tools, cleanup } = harness();
  try {
    const id = mkArticle(tools, SEED);
    assertRefusedNothingWritten(
      tools,
      id,
      () => tools.knowledgeAppend(id, 'live_test_refs[ac_id=AC9].test_paths', ['game/test/x_test.gd']),
      /matches 0 element/,
      'zero matches'
    );
  } finally {
    cleanup();
  }
});

test('a selector on a key no element owns matches zero, never every key-lacking element', () => {
  const { tools, cleanup } = harness();
  try {
    const id = mkArticle(tools, SEED);
    assertRefusedNothingWritten(
      tools,
      id,
      () => tools.knowledgeAppend(id, 'live_test_refs[nokey=undefined].test_paths', ['game/test/x_test.gd']),
      /matches 0 element/,
      'absent key'
    );
  } finally {
    cleanup();
  }
});

test('a selector matching two elements is refused naming 2', () => {
  const { tools, cleanup } = harness();
  try {
    const id = mkArticle(tools, [SEED[0], { ac_id: 'AC1', test_paths: ['game/test/run/dup_test.gd'] }]);
    assertRefusedNothingWritten(
      tools,
      id,
      () => tools.knowledgeAppend(id, 'live_test_refs[ac_id=AC1].test_paths', ['game/test/x_test.gd']),
      /matches 2 element/,
      'two matches'
    );
  } finally {
    cleanup();
  }
});

test('a sub-field that is not an array (a string, or absent because misspelled) is refused', () => {
  const { tools, cleanup } = harness();
  try {
    const id = mkArticle(tools, SEED);
    assertRefusedNothingWritten(
      tools,
      id,
      () => tools.knowledgeAppend(id, 'live_test_refs[ac_id=AC4].ac_id', ['x']),
      /'ac_id' on the selected live_test_refs element is string, not an array/,
      'string sub-field'
    );
    assertRefusedNothingWritten(
      tools,
      id,
      () => tools.knowledgeAppend(id, 'live_test_refs[ac_id=AC4].test_path', ['game/test/x_test.gd']),
      /'test_path' on the selected live_test_refs element is absent, not an array/,
      'misspelled sub-field'
    );
  } finally {
    cleanup();
  }
});

test('an unknown base field and links are refused through the selector as they are without it', () => {
  const { tools, cleanup } = harness();
  try {
    const id = mkArticle(tools, SEED);
    assertRefusedNothingWritten(
      tools,
      id,
      () => tools.knowledgeAppend(id, 'live_test_ref[ac_id=AC4].test_paths', ['game/test/x_test.gd']),
      /does not define 'live_test_ref'/,
      'unknown base field, named as the base and not the whole selector'
    );
    assertRefusedNothingWritten(
      tools,
      id,
      () => tools.knowledgeAppend(id, 'links[rel=fulfills].x', ['y']),
      /use knowledge_link/,
      'links base'
    );
  } finally {
    cleanup();
  }
});

test('an empty entry list through the selector is refused', () => {
  const { tools, cleanup } = harness();
  try {
    const id = mkArticle(tools, SEED);
    assertRefusedNothingWritten(
      tools,
      id,
      () => tools.knowledgeAppend(id, 'live_test_refs[ac_id=AC4].test_paths', []),
      /non-empty array/,
      'empty entries'
    );
  } finally {
    cleanup();
  }
});

test('an appended test path that is an existing directory is refused by the claim guard', () => {
  const { dir, tools, cleanup } = harness();
  try {
    const id = mkArticle(tools, SEED);
    mkdirSync(join(dir, 'game', 'test', 'run'), { recursive: true });
    assertRefusedNothingWritten(
      tools,
      id,
      () => tools.knowledgeAppend(id, 'live_test_refs[ac_id=AC4].test_paths', ['game/test/run']),
      /director/i,
      'directory claim'
    );
  } finally {
    cleanup();
  }
});
