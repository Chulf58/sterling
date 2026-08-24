// ---------------------------------------------------------------------------
// SPEC-ONLY pins for board-provenance-measured-at-head (decision e9858b23,
// slug board-provenance-measured-at-head). Written BLIND to the in-flight
// coder diff to packages/mcp-server/src/tools.ts and packages/schemas/src/
// records.ts — H4 forbids reading either while this slice lands. Harness and
// git-fixture idiom copied verbatim from sibling conventions only:
//   - store/tools instantiation: read-surface-wave.test.ts, tools.test.ts
//   - git fixture (mkdtempSync + .sterling dir + `git init -q -b main` +
//     user.email/user.name + SterlingStore + SterlingTools({..., repoRoot}))
//     : packages/mcp-server/src/tests/file-parked-ancestry.test.ts (gitRepo()),
//     tools.test.ts (gitRepo() ~line 2405)
//   - board_update allowlist / in-place-edit semantics: tools.test.ts
//     ("board_update: in-place edit of text/priority/file_keys ...")
//   - boardQueryResult envelope + digest projection shape: count-projection
//     .test.ts, board-objective.test.ts
//   - not-yet-declared-field cast convention (`as unknown as
//     Parameters<SterlingTools['boardAdd']>[0]`): board-objective.test.ts
//
// ASSUMPTION FLAGGED (no interface was declared for WHERE the file_keys-
// changed annotation lands — only its exact string shape and that it rides
// "full AND digest projections"): this file assumes the annotation is
// APPENDED to the returned record's `text` field at query/projection time
// (mirroring how digest's own ellipsis-clip already rewrites `.text` at read
// time without touching the stored value — see SPEC3(d) in
// read-surface-wave.test.ts) rather than a new sibling field. If the real
// shape is a dedicated field instead, that is the one line to move — the
// pinned behavior (which N, which sha7, which items get it, which don't) is
// unchanged either way.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-24T12:00:00.000Z';
const LATER = '2026-08-24T13:00:00.000Z';

type Loose = Record<string, unknown>;

function addRaw(tools: SterlingTools, args: Loose): Loose {
  return tools.boardAdd(args as unknown as Parameters<SterlingTools['boardAdd']>[0]) as unknown as Loose;
}

function updateRaw(tools: SterlingTools, id: string, patch: Loose): Loose {
  return tools.boardUpdate(id, patch as unknown as Parameters<SterlingTools['boardUpdate']>[1]) as unknown as Loose;
}

// git fixture idiom copied from file-parked-ancestry.test.ts / tools.test.ts.
function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-provenance-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const git = (...a: string[]): string => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  const headSha = () => git('rev-parse', 'HEAD');
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, tools, git, headSha, cleanup };
}

const HEX40 = /^[0-9a-f]{40}$/;

// ===========================================================================
// PIN 1 — board_add stamps measured_at_head with HEAD; a caller-supplied
// resolvable sha is kept, not overwritten.
// ===========================================================================

test('PIN1 CONTROL: board_add in a git fixture stamps measured_at_head with the fixture HEAD (40-hex, resolvable) when the caller supplies none', () => {
  const { dir, tools, git, headSha, cleanup } = gitFixture();
  try {
    writeFileSync(join(dir, 'seed.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');
    const expectedHead = headSha();

    const { record } = addRaw(tools, { text: 'stamp on add', source: 'user' }) as unknown as { record: Loose };

    const stamped = record.measured_at_head as string;
    assert.match(stamped, HEX40, 'measured_at_head is a 40-hex sha, not a shortened/derived form');
    assert.equal(stamped, expectedHead, 'the stamped sha is exactly the fixture HEAD at add time, resolvable via git rev-parse HEAD');
  } finally {
    cleanup();
  }
});

test('PIN1: a caller-supplied RESOLVABLE sha on board_add is kept verbatim — never silently overwritten by HEAD', () => {
  const { dir, tools, git, headSha, cleanup } = gitFixture();
  try {
    writeFileSync(join(dir, 'seed.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'commit one');
    const earlierSha = headSha();

    // Advance HEAD so the fixture's real HEAD strictly differs from earlierSha —
    // otherwise "kept, not overwritten" would be indistinguishable from "always
    // re-stamped to HEAD" by coincidence.
    writeFileSync(join(dir, 'seed.txt'), 'y\n');
    git('add', '-A');
    git('commit', '-qm', 'commit two');
    const newHead = headSha();
    assert.notEqual(earlierSha, newHead, 'sanity: HEAD genuinely moved between the two commits');

    const { record } = addRaw(tools, { text: 'caller supplies an old but real sha', source: 'user', measured_at_head: earlierSha }) as unknown as {
      record: Loose;
    };

    assert.equal(record.measured_at_head, earlierSha, 'the caller-supplied resolvable sha is stored VERBATIM');
    assert.notEqual(record.measured_at_head, newHead, 'and is NOT silently replaced by the current HEAD');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 2 — a caller-supplied UNRESOLVABLE sha is refused naming it; no item created.
// ===========================================================================

test('PIN2: a caller-supplied UNRESOLVABLE sha on board_add is refused by name — no item is created', () => {
  const { tools, cleanup } = gitFixture();
  try {
    const fakeSha = 'a'.repeat(40);
    const before = tools.boardQuery({ source: 'user' }).length;

    assert.throws(
      () => addRaw(tools, { text: 'bogus sha attempt', source: 'user', measured_at_head: fakeSha }),
      (err: Error) => {
        assert.ok(err.message.includes(fakeSha), 'the refusal names the specific unresolvable sha');
        return true;
      },
      'an unresolvable sha must be refused, never silently replaced by HEAD'
    );

    assert.equal(tools.boardQuery({ source: 'user' }).length, before, 'no item was created by the refused call');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 3 — board_update re-stamps on a text change; a priority-only update
// leaves measured_at_head untouched. Control (priority-only) placed FIRST.
// ===========================================================================

test('PIN3: board_update re-stamps measured_at_head on a text change but NOT on a priority-only change', () => {
  const { dir, store, tools, git, headSha, cleanup } = gitFixture();
  try {
    writeFileSync(join(dir, 'seed.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');
    const headAtAdd = headSha();

    const { record: original } = addRaw(tools, { text: 'item to update', source: 'user', priority: 'low' }) as unknown as { record: Loose };
    assert.equal(original.measured_at_head, headAtAdd, 'precondition: stamped at add time');

    // Advance HEAD so a re-stamp is observably different from the original.
    writeFileSync(join(dir, 'seed.txt'), 'y\n');
    git('add', '-A');
    git('commit', '-qm', 'advance head');
    const headAfterAdvance = headSha();
    assert.notEqual(headAtAdd, headAfterAdvance, 'sanity: HEAD moved between add and update');

    const laterTools = new SterlingTools({ store, now: () => LATER, repoRoot: dir });

    // CONTROL FIRST: priority-only patch must NOT re-stamp — rules out a
    // blind "always re-stamp on any update" implementation.
    const afterPriority = updateRaw(laterTools, original.id as string, { priority: 'high' });
    assert.equal(afterPriority.measured_at_head, headAtAdd, 'priority-only update leaves measured_at_head UNTOUCHED');
    assert.notEqual(afterPriority.measured_at_head, headAfterAdvance, 'still not re-stamped to the newer HEAD');

    // VERDICT: a text change DOES re-stamp — rules out "never re-stamps".
    const afterText = updateRaw(laterTools, original.id as string, { text: 'item to update, rewritten' });
    assert.equal(afterText.measured_at_head, headAfterAdvance, 'a text change re-stamps to the CURRENT HEAD at update time');
    assert.notEqual(afterText.measured_at_head, headAtAdd, 'and differs from the stale original stamp');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 4/5 — board_query annotates an item whose file_keys changed since its
// measured_at_head with the exact N and sha7; an item with NO such commits
// carries no annotation (control, placed first). Envelope provenance:'checked'.
// ===========================================================================

test("PIN4/5: board_query annotates only the item whose file_keys changed since measured_at_head, with the exact commit count and sha7; the untouched sibling gets no annotation; envelope provenance:'checked'", () => {
  const { dir, tools, git, headSha, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'seed a and b');
    const baseHead = headSha();
    const baseSha7 = baseHead.slice(0, 7);

    const { record: itemA } = addRaw(tools, { text: 'owns a.ts', source: 'user', file_keys: ['src/a.ts'] }) as unknown as { record: Loose };
    const { record: itemB } = addRaw(tools, { text: 'owns b.ts', source: 'user', file_keys: ['src/b.ts'] }) as unknown as { record: Loose };
    assert.equal(itemA.measured_at_head, baseHead, 'precondition: A stamped at base');
    assert.equal(itemB.measured_at_head, baseHead, 'precondition: B stamped at base, same as A');

    // Two commits touching ONLY a.ts — b.ts is never touched again.
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    git('add', '-A');
    git('commit', '-qm', 'edit a once');
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 3;\n');
    git('add', '-A');
    git('commit', '-qm', 'edit a twice');

    for (const projection of ['full', 'digest'] as const) {
      const result = tools.boardQueryResult({ source: 'user', projection } as unknown as Parameters<SterlingTools['boardQueryResult']>[0]) as unknown as {
        records: Loose[];
        provenance?: string;
      };
      assert.equal(result.provenance, 'checked', `envelope provenance is 'checked' for a real git repo (projection=${projection})`);

      const recA = result.records.find((r) => r.id === itemA.id)!;
      const recB = result.records.find((r) => r.id === itemB.id)!;

      // CONTROL FIRST: B saw no commits touching its file_keys — no annotation.
      assert.ok(
        !(recB.text as string).includes('file_keys changed'),
        `CONTROL (projection=${projection}): the untouched sibling carries NO warning annotation`
      );

      // VERDICT: A saw exactly 2 commits touching src/a.ts since baseHead.
      const expected = `⚠ file_keys changed in 2 commits since this item's evidence was measured (${baseSha7})`;
      assert.ok(
        (recA.text as string).includes(expected),
        `(projection=${projection}): expected substring "${expected}" in text "${recA.text as string}"`
      );
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 6 — git-absent direction: a non-git project dir yields
// provenance:'unavailable:<reason>' and no annotations — never a throw.
// ===========================================================================

test("PIN6: board_query against a project dir that is NOT a git repo yields provenance starting 'unavailable:', no annotations, and never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-provenance-nogit-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  try {
    addRaw(tools, { text: 'no git here', source: 'user', file_keys: ['src/whatever.ts'] });

    let result: { records: Loose[]; provenance?: string } | undefined;
    assert.doesNotThrow(() => {
      result = tools.boardQueryResult({ source: 'user' }) as unknown as { records: Loose[]; provenance?: string };
    }, 'a git-absent project dir must never throw on board_query');

    assert.match(result!.provenance as string, /^unavailable:/, 'the envelope discloses WHY provenance could not be checked, never a silent "checked"');
    for (const rec of result!.records) {
      assert.ok(!(rec.text as string).includes('file_keys changed'), 'no annotation is fabricated with nothing to check it against');
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN 7 — todo digests omit freshness (control: full projection carries it).
// ===========================================================================

test("PIN7: a todo's digest projection OMITS freshness; the full projection carries it (control, placed first)", () => {
  const { tools, cleanup } = gitFixture();
  try {
    const { record } = addRaw(tools, { text: 'freshness omission target', source: 'user' }) as unknown as { record: Loose };

    // CONTROL FIRST: the full projection actually carries the field — proves
    // the digest omission is a targeted strip, not "todos never had it".
    const fullResult = tools.boardQueryResult({ source: 'user' } as unknown as Parameters<SterlingTools['boardQueryResult']>[0]) as unknown as {
      records: Loose[];
    };
    const fullRec = fullResult.records.find((r) => r.id === record.id)!;
    assert.ok('freshness' in fullRec, "CONTROL: the full projection carries 'freshness' on a todo");
    assert.equal(fullRec.freshness, 'fresh', "a todo's freshness is always 'fresh' — zero information, per the ruling");

    // VERDICT: the digest projection strips it.
    const digestResult = tools.boardQueryResult({
      source: 'user',
      projection: 'digest',
    } as unknown as Parameters<SterlingTools['boardQueryResult']>[0]) as unknown as { records: Loose[] };
    const digestRec = digestResult.records.find((r) => r.id === record.id)!;
    assert.ok(!('freshness' in digestRec), "the digest projection of a todo OMITS 'freshness' entirely — zero-information field is not wasted on the wire");
  } finally {
    cleanup();
  }
});
