// ---------------------------------------------------------------------------
// SPEC-ONLY pins for build slice S2c — "queue truth at read" (boards
// be0ea20a HIGH + ab5ef216, objective consumer-feedback-2026-08-28).
// Governing spec: decision e0c36dc0-7eb3-4175-969e-3a6ec3d17744, slug
// queue-truth-at-read-annotation-design. Written BLIND to any implementation
// — the feature does not exist yet. H4 forbids reading packages/mcp-server/
// src/tools.ts while this slice lands; every fixture below uses ONLY tool
// methods already proven to exist in sibling test files (tools.test.ts,
// file-parked-ancestry.test.ts, board-provenance.test.ts,
// knowledge-query-baseline-drift.test.ts) plus knowledge_schema('todo').
//
// WHERE THE DECISION WINS OVER THE RAW AC TEXT (per dispatch instruction):
//   - The decision's exact quoted strings are pinned VERBATIM where quoted
//     (the file_keys-changed precedent already proved this idiom works):
//       "no longer reproduces in the working tree at HEAD <sha8>"
//       "measured N commits before HEAD at <sha8> — no file_keys,
//        path-level provenance unavailable; re-verify any absence claim
//        before acting"
//       "measured at current HEAD" (also directly quoted in AC7's own text)
//   - reconcile_provenance is asserted as a literal field name — the
//     decision names it explicitly ("(3) COST ... a new envelope status
//     reconcile_provenance"), so this is spec, not an assumption.
//
// ASSUMPTIONS FLAGGED (no interface was declared for these — the one thing
// to move if the real shape differs; the pinned SUBSTANCE is unchanged):
//   (a) FIELD LOCATION for the per-item stale/unavailable/keyless-distance
//       text is unspecified. Every presence/absence check below searches
//       JSON.stringify(record) for the exact decision-quoted substring,
//       agnostic to which field carries it — mirroring STALE4's
//       raw-hash-absence idiom in knowledge-query-baseline-drift.test.ts and
//       board-provenance.test.ts's text-append precedent for the sibling
//       file_keys-changed annotation.
//   (b) THE FILE-ATTEMPT BUDGET MAGNITUDE is not declared. AC6 constructs
//       200 real, baselined, owned files in one item to very likely exceed
//       whatever cap exists ("a plain N-files recompute cap" was explicitly
//       REJECTED by the decision precisely because uncapped-feeling numbers
//       get expensive fast, implying the real cap sits well under 200) — if
//       the shipped cap is larger, 200 is the one number to raise.
//   (c) THE EXISTING "unverifiable" WORDING for a non-ancestor
//       measured_at_head is not given by the decision or the ACs (only that
//       it is "kept"), so AC7's non-ancestor arm pins ABSENCE of the two NEW
//       annotation phrases rather than the old wording's exact shape.
//
// Harness idiom: gitFixture() copied from file-parked-ancestry.test.ts /
// tools.test.ts (gitRepo) and board-provenance.test.ts (gitFixture,
// including its toolsAt()-style secondary-now instance sharing one store).
// The superseded-chain fixture (AC5) copies tools.test.ts's rawLegacy
// pattern verbatim: knowledge_supersede refuses feature_article ("articles
// evolve in place"), so a legacy predecessor is built via store.create
// directly, successor-first so superseded_by always resolves.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;

const NOW = '2026-08-31T12:00:00.000Z';
const LATER = '2026-08-31T13:00:00.000Z';

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-queue-truth-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const git = (...a: string[]): string => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  // An initial commit so HEAD is never unborn — every test below can call
  // headSha()/rev-parse HEAD immediately, and the reconcile predicate reads
  // WORKING-TREE bytes (not the committed tree, per the decision's own
  // wording), so this commit need not include any of a test's fixture
  // files for content comparisons to work.
  git('commit', '--allow-empty', '-qm', 'initial');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  const toolsAt = (when: string) => new SterlingTools({ store, now: () => when, repoRoot: dir });
  const headSha = () => git('rev-parse', 'HEAD');
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, tools, toolsAt, git, headSha, cleanup };
}

const mkArticle = (t: SterlingTools, slug: string, paths: string[]): Loose =>
  t.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: paths.map((p) => ({ path: p, role: 'impl' })),
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record as unknown as Loose;

const mkDecision = (t: SterlingTools, title: string): Loose =>
  t.knowledgeCreate('decision', { title, statement: 'S', alternatives_rejected: [], rationale: 'R' }).record as unknown as Loose;

const enqueue = (t: SterlingTools, args: Loose): Loose =>
  (t.maintenanceEnqueue(args as unknown as Parameters<SterlingTools['maintenanceEnqueue']>[0]) as unknown as { record: Loose }).record;

const addRaw = (t: SterlingTools, args: Loose): Loose =>
  (t.boardAdd(args as unknown as Parameters<SterlingTools['boardAdd']>[0]) as unknown as { record: Loose }).record;

const boardSys = (t: SterlingTools, extra: Loose = {}): Loose =>
  t.boardQueryResult({ source: 'system', ...extra } as unknown as Parameters<SterlingTools['boardQueryResult']>[0]) as unknown as Loose;

const boardUser = (t: SterlingTools, extra: Loose = {}): Loose =>
  t.boardQueryResult({ source: 'user', ...extra } as unknown as Parameters<SterlingTools['boardQueryResult']>[0]) as unknown as Loose;

const maintRes = (t: SterlingTools, extra: Loose = {}): Loose =>
  t.maintenanceQueryResult(extra as unknown as Parameters<SterlingTools['maintenanceQueryResult']>[0]) as unknown as Loose;

const findRec = (env: Loose, id: string): Loose | undefined => (env.records as Loose[] | undefined)?.find((r) => r.id === id);
const blob = (rec: Loose | undefined | null): string => JSON.stringify(rec ?? null);
const envelopeOnly = (env: Loose): Loose => {
  const { records, ...rest } = env;
  return rest;
};

const rawSupersededArticle = (store: SterlingStore, slug: string, supersededBy: string, path: string): Loose =>
  store.create({
    id: randomUUID(),
    type: 'feature_article',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'superseded',
    superseded_by: supersededBy,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
    slug,
    title: slug,
    what_it_does: 'legacy',
    intended_behavior: 'b',
    files: [{ path, role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  } as never) as unknown as Loose;

const RECONCILE_TEXT = (slug: string, path: string) => `reconcile '${slug}' — owned file ${path} changed on disk after the article's last update`;

// ===========================================================================
// AC1 — REPRODUCE/STALE SPLIT. Control (still reproduces) placed first — it
// is what proves the stale annotation is a verdict, not a decoration applied
// to every reconcile_needed row regardless of file state.
// SABOTAGE: hardcode the stale annotation onto every reconcile_needed row →
// AC1a goes red (control fails); hardcode it onto NO row → AC1b goes red.
// ===========================================================================

test('AC1a (CONTROL): a reconcile_needed item whose owned file STILL differs from the live baseline carries NO stale annotation, in board_query AND maintenance_query', () => {
  const { dir, tools, headSha, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'live.ts'), 'export const v = 1;\n');
    const art = mkArticle(tools, 'feat-live-drift', ['src/live.ts']);
    const item = enqueue(tools, {
      reason: 'reconcile_needed',
      text: RECONCILE_TEXT('feat-live-drift', 'src/live.ts'),
      file_keys: ['src/live.ts'],
      feature_link: art.id as string,
    });
    // The drift genuinely still reproduces: content differs from the
    // baseline recorded at article creation.
    writeFileSync(join(dir, 'src', 'live.ts'), 'export const v = 2; // still different\n');

    // REPAIRED 2026-08-31 (test-repair register): the original second assertion
    // (!blob(rec).includes(sha8)) was unsatisfiable by construction — boardAdd
    // server-stamps measured_at_head with the FULL 40-hex HEAD sha, so the record
    // JSON always contains the sha8 prefix. The stale-annotation absence above
    // fully carries this control's intent.
    for (const env of [boardSys(tools), maintRes(tools)]) {
      const rec = findRec(env, item.id as string);
      assert.ok(rec, 'the item is in the result');
      assert.ok(
        !blob(rec).includes('no longer reproduces in the working tree at HEAD'),
        'a genuinely still-differing file must NOT be annotated stale'
      );
    }
  } finally {
    cleanup();
  }
});

test('AC1b (VERDICT): a reconcile_needed item whose file content again MATCHES the live baseline carries the stale annotation with the exact phrase and an 8-char sha, in board_query AND maintenance_query', () => {
  const { dir, tools, headSha, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'gone-stale.ts'), 'export const v = 1;\n');
    const art = mkArticle(tools, 'feat-gone-stale', ['src/gone-stale.ts']);
    const item = enqueue(tools, {
      reason: 'reconcile_needed',
      text: RECONCILE_TEXT('feat-gone-stale', 'src/gone-stale.ts'),
      file_keys: ['src/gone-stale.ts'],
      feature_link: art.id as string,
    });
    // The file is left exactly as baselined — the claimed drift no longer
    // reproduces against the live article.
    const sha8 = headSha().slice(0, 8);

    for (const env of [boardSys(tools), maintRes(tools)]) {
      const rec = findRec(env, item.id as string);
      assert.ok(rec, 'the item is in the result');
      assert.ok(
        blob(rec).includes('no longer reproduces in the working tree at HEAD'),
        'a file matching the live baseline again must be annotated stale'
      );
      assert.ok(blob(rec).includes(sha8), 'the annotation carries an 8-char sha of the current HEAD');
      // control still stays open, per AC2 — asserted properly there.
      assert.equal(rec!.status ?? 'active', 'active', 'the item is not closed by the annotation');
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC2 — NEVER CLOSURE. Uses the AC1b stale item: query twice, second read
// identical; the stored row survives untouched.
// SABOTAGE: make the annotator call maintenanceRemove/board_remove on a
// stale-classified item → this test goes red (item disappears / count drops).
// ===========================================================================

test('AC2: an annotated-stale item remains open and returned on a second identical read; the store row is never mutated or removed by a read', () => {
  const { dir, tools, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'never-closes.ts'), 'export const v = 1;\n');
    const art = mkArticle(tools, 'feat-never-closes', ['src/never-closes.ts']);
    const item = enqueue(tools, {
      reason: 'reconcile_needed',
      text: RECONCILE_TEXT('feat-never-closes', 'src/never-closes.ts'),
      file_keys: ['src/never-closes.ts'],
      feature_link: art.id as string,
    });

    const before = tools.maintenanceQuery({ system_reason: 'reconcile_needed' } as unknown as Parameters<SterlingTools['maintenanceQuery']>[0]) as unknown as Loose[];
    const beforeCount = before.length;
    assert.ok(before.some((r) => r.id === item.id), 'precondition: the item is present before annotation is even considered');

    const first = boardSys(tools);
    const second = boardSys(tools);
    const r1 = findRec(first, item.id as string);
    const r2 = findRec(second, item.id as string);
    assert.ok(r1, 'first read returns the item');
    assert.ok(r2, 'second read returns the item');
    assert.deepEqual(r1, r2, 'two identical reads produce an identical annotated record — a read is a pure function, not a mutation');

    const after = tools.maintenanceQuery({ system_reason: 'reconcile_needed' } as unknown as Parameters<SterlingTools['maintenanceQuery']>[0]) as unknown as Loose[];
    assert.equal(after.length, beforeCount, 'the underlying store still holds exactly as many reconcile_needed rows as before any read');
    assert.ok(after.some((r) => r.id === item.id), 'the row itself is still present after two reads');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC3 — ABSTENTION DISCLOSED. Two independent causes of abstention: (a) the
// feature_link does not resolve to a feature_article at all; (b) the article
// resolves but carries no baseline for the named path. Neither is ever
// reported as stale. The envelope also carries reconcile_provenance as its
// OWN field, distinct from the pre-existing `provenance` field.
// SABOTAGE: collapse an abstain into the same code path as "clean" → both
// AC3a/AC3b go red (stale annotation appears where it must not).
// ===========================================================================

test('AC3a: a feature_link that does not resolve to a feature_article is marked unavailable with a reason, never annotated stale', () => {
  const { dir, tools, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'orphan.ts'), 'export const v = 1;\n');
    // A record that genuinely exists in the store (so a write-time
    // existence check, if any, is satisfied) but is the WRONG type — not a
    // feature_article — so resolving it AS an article for baseline lookup
    // must fail.
    const wrongTypeTarget = mkDecision(tools, 'not an article');
    const item = enqueue(tools, {
      reason: 'reconcile_needed',
      text: `reconcile 'orphan' — owned file src/orphan.ts changed on disk after the article's last update`,
      file_keys: ['src/orphan.ts'],
      feature_link: wrongTypeTarget.id as string,
    });

    const env = boardSys(tools);
    const rec = findRec(env, item.id as string);
    assert.ok(rec, 'the item is still returned');
    assert.ok(!blob(rec).includes('no longer reproduces in the working tree at HEAD'), 'an unresolvable article link is NEVER read as stale');
    assert.match(blob(rec), /unavailable/i, 'the item discloses that it could not be checked, with a reason');
  } finally {
    cleanup();
  }
});

test('AC3b: an owned path with no baseline on the live article is marked unavailable, never stale (ghost-path shape)', () => {
  const { dir, tools, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'has-baseline.ts'), 'export const v = 1;\n');
    // ghost.ts is declared as owned but never exists at creation — the
    // article never records a baseline for it (STALE3 shape, reused here at
    // the reconcile-item annotation seam rather than knowledge_query's).
    const art = mkArticle(tools, 'feat-ghost-owned', ['src/has-baseline.ts', 'src/ghost.ts']);
    const item = enqueue(tools, {
      reason: 'reconcile_needed',
      text: `reconcile 'feat-ghost-owned' — owned file src/ghost.ts changed on disk after the article's last update`,
      file_keys: ['src/ghost.ts'],
      feature_link: art.id as string,
    });

    const env = boardSys(tools);
    assert.equal(env.reconcile_provenance, 'checked', 'the CALL overall could check (other paths/articles are fine) — this is a per-item abstention, not a call-wide failure');
    assert.ok('provenance' in env, 'the pre-existing provenance field (measured_at_head git walk) is untouched and still present');

    const rec = findRec(env, item.id as string);
    assert.ok(rec, 'the item is still returned');
    assert.ok(!blob(rec).includes('no longer reproduces in the working tree at HEAD'), 'a path with no baseline to compare against is NEVER read as stale');
    assert.match(blob(rec), /unavailable/i, 'the item discloses unavailability, with a reason');
  } finally {
    cleanup();
  }
});

test('AC3c: the envelope carries reconcile_provenance as its OWN field, distinct from the pre-existing provenance field, on an ordinary checkable call', () => {
  const { dir, tools, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'plain.ts'), 'export const v = 1;\n');
    const art = mkArticle(tools, 'feat-plain', ['src/plain.ts']);
    enqueue(tools, {
      reason: 'reconcile_needed',
      text: RECONCILE_TEXT('feat-plain', 'src/plain.ts'),
      file_keys: ['src/plain.ts'],
      feature_link: art.id as string,
    });

    const env = boardSys(tools);
    assert.ok('provenance' in env, 'control: the existing measured_at_head-walk provenance field is unaffected by this feature');
    assert.ok('reconcile_provenance' in env, 'reconcile_provenance is a NEW, separate envelope field for the drift-recheck seam');
    assert.equal(env.reconcile_provenance, 'checked', 'a normal git repo with a resolvable article and baseline genuinely could check');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC4 — MULTI-PATH. Control (one path still drifting) placed first: proves
// "any path reconciles ⇒ reproduces" rather than a naive first-path-wins or
// last-path-wins rule. Then: both clean ⇒ stale. Then: one clean + one
// unevaluable ⇒ unavailable, never stale (never let an abstention default
// to the more "optimistic" stale verdict).
// SABOTAGE: change the multi-path rule to "ALL paths must differ to count as
// still reproducing" → AC4a goes red (stale would wrongly appear).
// ===========================================================================

test('AC4a (CONTROL): a multi-path item where ONE path still drifts is NOT annotated stale', () => {
  const { dir, tools, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'multiA.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'src', 'multiB.ts'), 'export const b = 1;\n');
    const art = mkArticle(tools, 'feat-multi', ['src/multiA.ts', 'src/multiB.ts']);
    const item = enqueue(tools, {
      reason: 'reconcile_needed',
      text: `reconcile 'feat-multi' — owned files src/multiA.ts, src/multiB.ts changed on disk after the article's last update`,
      file_keys: ['src/multiA.ts', 'src/multiB.ts'],
      feature_link: art.id as string,
    });
    // multiA now differs; multiB is untouched (matches). One drifting path
    // is enough to keep the item reproducing.
    writeFileSync(join(dir, 'src', 'multiA.ts'), 'export const a = 999; // differs\n');

    const rec = findRec(boardSys(tools), item.id as string);
    assert.ok(rec, 'the item is returned');
    assert.ok(!blob(rec).includes('no longer reproduces in the working tree at HEAD'), 'one drifting path among several must suppress the stale annotation');
    assert.ok(!blob(rec).match(/unavailable/i), 'and this is a real reproducing case, not an abstention');
  } finally {
    cleanup();
  }
});

test('AC4b (VERDICT): a multi-path item where BOTH paths are clean and fully evaluated IS annotated stale', () => {
  const { dir, tools, headSha, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'multiD.ts'), 'export const d = 1;\n');
    writeFileSync(join(dir, 'src', 'multiE.ts'), 'export const e = 1;\n');
    const art = mkArticle(tools, 'feat-multi-clean', ['src/multiD.ts', 'src/multiE.ts']);
    const item = enqueue(tools, {
      reason: 'reconcile_needed',
      text: `reconcile 'feat-multi-clean' — owned files src/multiD.ts, src/multiE.ts changed on disk after the article's last update`,
      file_keys: ['src/multiD.ts', 'src/multiE.ts'],
      feature_link: art.id as string,
    });
    // Neither file is touched after creation — both match their baselines.
    const sha8 = headSha().slice(0, 8);

    const rec = findRec(boardSys(tools), item.id as string);
    assert.ok(rec, 'the item is returned');
    assert.ok(
      blob(rec).includes('no longer reproduces in the working tree at HEAD'),
      'both paths clean and fully evaluated must produce the stale annotation'
    );
    assert.ok(blob(rec).includes(sha8), 'carries the sha8');
  } finally {
    cleanup();
  }
});

test('AC4c: a multi-path item where one path is clean and the other is UNEVALUABLE is marked unavailable, never stale', () => {
  const { dir, tools, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'multiClean.ts'), 'export const c = 1;\n');
    // multi-ghost2.ts is declared as owned but never created — no baseline.
    const art = mkArticle(tools, 'feat-multi-mixed', ['src/multiClean.ts', 'src/multi-ghost2.ts']);
    const item = enqueue(tools, {
      reason: 'reconcile_needed',
      text: `reconcile 'feat-multi-mixed' — owned files src/multiClean.ts, src/multi-ghost2.ts changed on disk after the article's last update`,
      file_keys: ['src/multiClean.ts', 'src/multi-ghost2.ts'],
      feature_link: art.id as string,
    });

    const rec = findRec(boardSys(tools), item.id as string);
    assert.ok(rec, 'the item is returned');
    assert.ok(
      !blob(rec).includes('no longer reproduces in the working tree at HEAD'),
      'ONE clean path is not enough to call this stale when a sibling path could not be evaluated'
    );
    assert.match(blob(rec), /unavailable/i, 'the unevaluable sibling forces an unavailable disclosure instead');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC5 — SUPERSEDED LINK resolves through the chain to the LIVE article.
// Control (still differs from the LIVE article's baseline) placed first,
// proving the chain-resolution and NOT a coincidental match against the
// dead predecessor's (absent) baseline.
// SABOTAGE: compare against the LEGACY (feature_link) article's own
// baseline instead of walking superseded_by to the live head → AC5a would
// wrongly read as unavailable/clean (legacy has no baseline at all here),
// and AC5b would wrongly stay unannotated.
// ===========================================================================

test('AC5a (CONTROL): an item whose feature_link points at a SUPERSEDED article, still differing from the LIVE article baseline, is NOT annotated stale', () => {
  const { dir, store, tools, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'chain.ts'), 'export const v2 = 1;\n');
    const live = mkArticle(tools, 'feat-chain', ['src/chain.ts']); // baseline = hash of the content above
    const legacy = rawSupersededArticle(store, 'feat-chain', live.id as string, 'src/chain.ts');

    const item = enqueue(tools, {
      reason: 'reconcile_needed',
      text: RECONCILE_TEXT('feat-chain', 'src/chain.ts'),
      file_keys: ['src/chain.ts'],
      feature_link: legacy.id as string,
    });

    // Content now differs from the LIVE article's baseline.
    writeFileSync(join(dir, 'src', 'chain.ts'), 'export const v2 = 2; // differs from live baseline\n');

    const rec = findRec(boardSys(tools), item.id as string);
    assert.ok(rec, 'the item is returned');
    assert.ok(
      !blob(rec).includes('no longer reproduces in the working tree at HEAD'),
      'resolved through the chain to the live article, the content genuinely still differs — not stale'
    );
  } finally {
    cleanup();
  }
});

test('AC5b (VERDICT): the same superseded-link item, once content MATCHES the LIVE article baseline, IS annotated stale — not unavailable', () => {
  const { dir, store, tools, headSha, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'chain2.ts'), 'export const v2 = 1;\n');
    const live = mkArticle(tools, 'feat-chain2', ['src/chain2.ts']);
    const legacy = rawSupersededArticle(store, 'feat-chain2', live.id as string, 'src/chain2.ts');

    const item = enqueue(tools, {
      reason: 'reconcile_needed',
      text: RECONCILE_TEXT('feat-chain2', 'src/chain2.ts'),
      file_keys: ['src/chain2.ts'],
      feature_link: legacy.id as string,
    });
    // File is left exactly matching the LIVE article's baseline.
    const sha8 = headSha().slice(0, 8);

    const rec = findRec(boardSys(tools), item.id as string);
    assert.ok(rec, 'the item is returned');
    assert.ok(
      blob(rec).includes('no longer reproduces in the working tree at HEAD'),
      'resolved through the chain, content matches the LIVE baseline — stale'
    );
    assert.ok(blob(rec).includes(sha8), 'carries the sha8');
    assert.ok(!blob(rec).match(/unavailable/i), 'a resolvable chain to a real baseline is never reported as unavailable');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC6 — BUDGET. A single item with 200 real, owned, baselined, always-clean
// files (heuristic magnitude — see file header (b)) forces the file-attempt
// budget to exhaust before full evaluation completes; a small, otherwise
// trivially-evaluable item queued to be processed AFTER it (via a strictly
// later updated_at, so ordering is deterministic rather than relying on a
// same-timestamp tie-break) is ALSO marked unavailable — "items past the
// budget", not just the one that blew it. The envelope discloses truncation.
// Separately: a source:'user' item performs NO drift recomputation at all.
// SABOTAGE (budget): remove the cap entirely (always evaluate to
// completion) → both arms go red (no unavailable:budget anywhere, no
// truncation disclosure). SABOTAGE (user-source): recompute drift for user
// rows too → the user-source arm goes red (an annotation appears).
// ===========================================================================

test('AC6a: a file-attempt budget exhausted by one large item ALSO marks a later-processed small item unavailable (naming budget), and the envelope discloses truncation', () => {
  const { dir, tools, toolsAt, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'many'), { recursive: true });
    const bigPaths: string[] = [];
    for (let i = 0; i < 200; i++) {
      const rel = `many/f${i}.ts`;
      writeFileSync(join(dir, rel), `export const v${i} = ${i};\n`);
      bigPaths.push(rel);
    }
    const bigArt = mkArticle(tools, 'feat-budget-big', bigPaths); // all 200 clean/baselined

    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'small.ts'), 'export const s = 1;\n');
    const smallArt = mkArticle(tools, 'feat-budget-small', ['src/small.ts']); // also clean

    // Small item created FIRST (older updated_at) so it is NOT the one that
    // exhausts the budget; the big item is created with a strictly LATER
    // `now`, so DESC-by-updated_at ordering deterministically processes it
    // first, consuming the shared per-call budget before reaching the small
    // item.
    const smallItem = enqueue(tools, {
      reason: 'reconcile_needed',
      text: RECONCILE_TEXT('feat-budget-small', 'src/small.ts'),
      file_keys: ['src/small.ts'],
      feature_link: smallArt.id as string,
    });
    const toolsLater = toolsAt(LATER);
    const bigItem = enqueue(toolsLater, {
      reason: 'reconcile_needed',
      text: `reconcile 'feat-budget-big' — 200 owned files changed on disk after the article's last update`,
      file_keys: bigPaths,
      feature_link: bigArt.id as string,
    });

    const env = boardSys(toolsLater);
    const bigRec = findRec(env, bigItem.id as string);
    const smallRec = findRec(env, smallItem.id as string);
    assert.ok(bigRec, 'the big item is still returned');
    assert.ok(smallRec, 'the small item is still returned');

    assert.ok(!blob(bigRec).includes('no longer reproduces in the working tree at HEAD'), 'a partially-evaluated item is never declared stale');
    assert.match(blob(bigRec), /unavailable/i, 'the big item discloses it could not be fully evaluated');
    assert.match(blob(bigRec), /budget/i, 'the reason names the budget specifically');

    assert.ok(!blob(smallRec).includes('no longer reproduces in the working tree at HEAD'), 'the small item is never declared stale once the shared budget is gone');
    assert.match(blob(smallRec), /unavailable/i, 'the small item, though trivially evaluable in isolation, is unavailable because the CALL-WIDE budget ran out first');
    assert.match(blob(smallRec), /budget/i, 'and names budget as the reason, not a coincidental unrelated abstention');

    const envNoRecords = envelopeOnly(env);
    assert.match(JSON.stringify(envNoRecords), /budget|truncat/i, 'the envelope itself discloses that the call was truncated by budget');
  } finally {
    cleanup();
  }
});

test('AC6b: a source:user board item performs NO drift recomputation — no stale annotation appears even where the underlying file genuinely matches an article baseline', () => {
  const { dir, tools, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'usercheck.ts'), 'export const u = 1;\n');
    mkArticle(tools, 'feat-user-check', ['src/usercheck.ts']);
    // A user-source item naming the same path — content is left matching,
    // the strongest possible case for a stale annotation IF this were
    // recomputed the way a system reconcile_needed row is.
    const item = addRaw(tools, { text: 'user task naming a file that happens to match an article baseline', source: 'user', file_keys: ['src/usercheck.ts'] });

    const rec = findRec(boardUser(tools), item.id as string);
    assert.ok(rec, 'the item is returned');
    assert.ok(
      !blob(rec).includes('no longer reproduces in the working tree at HEAD'),
      'a user-source row is never annotated by the reconcile-drift recheck — that lane only touches source:system reconcile_needed rows'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC7 — KEYLESS DISTANCE. Zero-distance control placed first: proves the
// annotation is a genuine measured distance, not "always annotate a keyless
// item". Then N-commits-behind (the exact decision-quoted phrase). Then a
// non-ancestor measured_at_head (a rebased/divergent shape) keeps the
// EXISTING treatment — i.e. neither of the two new phrases appears.
// SABOTAGE: always emit the N-commits phrasing regardless of distance →
// AC7a (zero distance) goes red. Compute distance without checking ancestry
// at all → AC7c goes red (a bogus "N commits" appears for a divergent sha).
// ===========================================================================

test('AC7a (CONTROL): a keyless item measured at the CURRENT HEAD gets "measured at current HEAD", never an N-commits phrasing', () => {
  const { dir, tools, cleanup } = gitFixture();
  try {
    writeFileSync(join(dir, 'seed.txt'), 'x\n');
    const git = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('add', '-A');
    git('commit', '-qm', 'seed');

    // Keyless: no file_keys at all.
    const item = addRaw(tools, { text: 'keyless user note, measured at current HEAD', source: 'user' });

    const rec = findRec(boardUser(tools), item.id as string);
    assert.ok(rec, 'the item is returned');
    assert.ok(blob(rec).includes('measured at current HEAD'), 'zero distance is reported as measured at current HEAD');
    assert.ok(!blob(rec).match(/commits before HEAD/), 'and NOT as some N commits behind — there are none');
  } finally {
    cleanup();
  }
});

test('AC7b (VERDICT): a keyless item behind by N real commits gets the exact decision-quoted phrasing with N, sha8, and the re-verify note', () => {
  const { dir, tools, headSha, cleanup } = gitFixture();
  try {
    writeFileSync(join(dir, 'seed.txt'), 'x\n');
    const git = (...a: string[]) => {
      const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    git('add', '-A');
    git('commit', '-qm', 'seed');

    const item = addRaw(tools, { text: 'keyless user note, about to age behind HEAD', source: 'user' });

    const N = 3;
    for (let i = 0; i < N; i++) {
      git('commit', '--allow-empty', '-qm', `advance ${i}`);
    }
    const sha8 = headSha().slice(0, 8);

    const rec = findRec(boardUser(tools), item.id as string);
    assert.ok(rec, 'the item is returned');
    const expected = `measured ${N} commits before HEAD at ${sha8} — no file_keys, path-level provenance unavailable; re-verify any absence claim before acting`;
    assert.ok(blob(rec).includes(expected), `expected the exact decision-quoted phrase "${expected}" somewhere in the served record`);
  } finally {
    cleanup();
  }
});

test('AC7c: a keyless item whose measured_at_head is a resolvable but NON-ANCESTOR sha (a rebased/divergent shape) keeps the EXISTING unverifiable treatment — neither new phrase appears', () => {
  const { dir, tools, cleanup } = gitFixture();
  try {
    writeFileSync(join(dir, 'seed.txt'), 'x\n');
    const git = (...a: string[]) => {
      const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    git('add', '-A');
    git('commit', '-qm', 'seed');

    // A resolvable sha that lives on a branch NOT reachable from main's
    // current tip — a real, add-time-valid sha that is nonetheless not an
    // ancestor of the eventual HEAD (the rebase/reset shape).
    git('checkout', '-q', '-b', 'sideline');
    writeFileSync(join(dir, 'side.txt'), 'y\n');
    git('add', '-A');
    git('commit', '-qm', 'sideline commit');
    const sidelineSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    git('commit', '--allow-empty', '-qm', 'main diverges independently');

    const item = addRaw(tools, { text: 'keyless item stamped at a now-unreachable sha', source: 'user', measured_at_head: sidelineSha });

    const rec = findRec(boardUser(tools), item.id as string);
    assert.ok(rec, 'the item is returned');
    assert.ok(!blob(rec).match(/commits before HEAD/), 'a non-ancestor sha never gets a fabricated N-commits distance');
    assert.ok(!blob(rec).includes('measured at current HEAD'), 'and is not misreported as measured at the current HEAD either');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC8 — PROJECTION SURVIVAL. Reuses the AC1b stale shape and the AC7b
// keyless-distance shape; asserts both annotations survive digest AND
// headline projections, with a CONTROL proving the projections actually
// clipped something (so "it survived" cannot be explained by a seam that
// silently ignored `projection` and served full records).
// SABOTAGE: compose the annotation BEFORE projection instead of after →
// this test goes red under digest/headline (annotation clipped away).
// ===========================================================================

test('AC8: the stale annotation and the keyless-distance annotation both survive digest AND headline projections', () => {
  const { dir, tools, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'proj-stale.ts'), 'export const v = 1;\n');
    const art = mkArticle(tools, 'feat-proj-stale', ['src/proj-stale.ts']);
    const staleItem = enqueue(tools, {
      reason: 'reconcile_needed',
      text: RECONCILE_TEXT('feat-proj-stale', 'src/proj-stale.ts'),
      file_keys: ['src/proj-stale.ts'],
      feature_link: art.id as string,
    });

    const git = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('add', '-A');
    git('commit', '-qm', 'seed for AC8');
    const keylessItem = addRaw(tools, { text: 'keyless item for projection survival', source: 'user' });
    git('commit', '--allow-empty', '-qm', 'advance once');

    for (const projection of ['digest', 'headline'] as const) {
      const sysEnv = boardSys(tools, { projection });
      const userEnv = boardUser(tools, { projection });

      const staleRec = findRec(sysEnv, staleItem.id as string);
      assert.ok(staleRec, `stale item present under projection=${projection}`);
      // CONTROL, per projection: prove the projection genuinely ran (a field
      // normally on the full record is gone) so "the annotation survived"
      // cannot be explained by a seam that ignored `projection` and served
      // full records — same idiom as STALE1's digest control in
      // knowledge-query-baseline-drift.test.ts.
      if (projection === 'digest') {
        assert.ok(!('freshness' in staleRec!), "CONTROL: digest genuinely ran — a todo's 'freshness' field (present on full, per board-provenance PIN7) is stripped");
      } else {
        // REPAIRED 2026-08-31 (test-repair register): the original control asserted
        // system_reason absent under headline, contradicting the shipped pin
        // read-surface-wave.test.ts:466 (headline CARRIES system_reason for system
        // items, records.ts:813). Control now uses 'source', which headline
        // genuinely omits.
        assert.ok(!('source' in staleRec!), "CONTROL: headline genuinely ran — 'source' (present on full records) is stripped");
      }
      assert.ok(
        blob(staleRec).includes('no longer reproduces in the working tree at HEAD'),
        `the stale annotation survives projection=${projection}`
      );

      const keylessRec = findRec(userEnv, keylessItem.id as string);
      assert.ok(keylessRec, `keyless item present under projection=${projection}`);
      assert.ok(
        blob(keylessRec).match(/commits before HEAD/) || blob(keylessRec).includes('measured at current HEAD'),
        `the keyless-distance annotation survives projection=${projection}`
      );
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC9 — MTIME PREFILTER COMPATIBILITY. A re-baselined item whose file mtime
// sits OLDER than the article's updated_at (the everyday shape: the article
// was reconciled later than the file was last written, with the file's
// content unchanged throughout) must still be correctly annotated stale —
// a cheap mtime-based prefilter must not read "old mtime" as "skip the
// check, assume still reproducing".
// SABOTAGE: short-circuit on mtime(file) <= article.updated_at by assuming
// "unchanged since baseline, still reproducing" without hashing → this test
// goes red (no stale annotation appears).
// ===========================================================================

test('AC9: a file whose mtime is OLDER than the article\'s updated_at (re-baselined via a later reconcile, content never touched) is still correctly annotated stale', () => {
  const { dir, tools, toolsAt, headSha, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'mtime-shape.ts'), 'export const m = 1;\n');
    const art = mkArticle(tools, 'feat-mtime-shape', ['src/mtime-shape.ts']);
    const item = enqueue(tools, {
      reason: 'reconcile_needed',
      text: RECONCILE_TEXT('feat-mtime-shape', 'src/mtime-shape.ts'),
      file_keys: ['src/mtime-shape.ts'],
      feature_link: art.id as string,
    });

    // Reconcile the ARTICLE later (bumping updated_at strictly past the
    // file's real mtime) WITHOUT touching the file at all — the file's
    // on-disk mtime is now definitely older than article.updated_at, while
    // its content still matches the baseline exactly.
    const toolsLater = toolsAt(LATER);
    toolsLater.knowledgeUpdate(art.id as string, { what_it_does: 'reconciled later — AC9 shape' } as unknown as Parameters<SterlingTools['knowledgeUpdate']>[1]);

    const sha8 = headSha().slice(0, 8);
    const rec = findRec(boardSys(toolsLater), item.id as string);
    assert.ok(rec, 'the item is returned');
    assert.ok(
      blob(rec).includes('no longer reproduces in the working tree at HEAD'),
      'an mtime OLDER than updated_at must not suppress the stale verdict when content genuinely matches'
    );
    assert.ok(blob(rec).includes(sha8), 'carries the sha8');
  } finally {
    cleanup();
  }
});
