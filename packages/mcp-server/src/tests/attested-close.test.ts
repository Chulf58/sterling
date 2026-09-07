// ---------------------------------------------------------------------------
// R9 — the attested-close primitive (board 8c8b6d78).
//
// Closing a `reconcile_needed` maintenance item as ALREADY-PAID must stop H7
// re-minting it, without claiming a content reconcile happened. The close
// re-stamps the owning feature_article's `file_baselines` for exactly that
// item's `file_keys`, records `baseline_attestations: {[path]: {attested_at,
// item_id, head_commit, sha256}}`, and removes the item — ONE transaction,
// reachable from BOTH `SterlingTools.boardRemove` and `maintenanceRemove`.
//
// Written from the SPEC handed down with the board item and the coordinator's
// mid-task rulings, NOT from the implementation (H4 read wall). Interface
// names (`boardRemove`, `maintenanceRemove`, `knowledgeGet`, etc.) are the
// EXISTING, already-established tool surface used throughout this directory's
// sibling suites — see the harness-convention citations below each helper.
//
// RULING IN FORCE (decision
// attestation-bypass-requires-affirmative-exemption-not-unavailable-evidence,
// 2026-09-06): a missing repoRoot HARD-REFUSES (never falls through to
// ordinary removal) — see [R9-9c]. An unmapped `working_tree` refuses the
// same way — see [R9-9b]. Ordinary removal may bypass attestation ONLY when
// the item is AFFIRMATIVELY outside every re-mint predicate (a
// generated-projection key) — never merely because the evidence needed to
// attest is unavailable to this process.
//
// SCOPE NOTE ([R9-6], recurrence suppression): the TRUE end-to-end mint
// suppression lives hook-side in scripts/hooks/lib/settlement.mjs (a
// candidate-register + Stop/pre-merge settlement boundary design — see
// article h7-settlement-predicate, AC2: "Stop-settlement mints one grouped
// item per owning article for candidate paths whose FINAL CONTENT DIFFERS
// FROM THE ARTICLE BASELINE"), which is scripts/tests/ territory, not this
// file's (REVIEW-TERRITORY is packages/mcp-server/src/tests/ and
// packages/store/src/tests/ only). [R9-6] instead proves, at this layer, that
// the shared predicate's INPUT reads clean after the close — the article's
// `file_baselines` for the closed path exactly matches the live committed
// bytes, and the independent read-time `baseline_drift` wire (knowledge-
// query-baseline-drift.test.ts) — which consults the SAME `file_baselines`
// map — stops reporting drift on that path. This is the closest reachable,
// non-fake proof from within this territory that "the next pass over the
// same unchanged bytes mints nothing": it verifies the exact fact settlement
// mints against, not a hook invocation this suite cannot legally construct
// (H4) or legally own (REVIEW-TERRITORY).
//
// TWO NAMED RACES ARE NOT DRIVEN HERE, both flagged explicitly rather than
// faked, per the H15 S15b/S21b written-out-sabotage precedent:
//   [R9-16-race] the symlink swap-BETWEEN-check-and-read TOCTOU (only the
//     reachable half — a symlink present up front — is pinned, at [R9-14a]).
//   [R9-17-race] the final-live-reverification mutate-DURING-processing race:
//     both hash passes happen inside ONE synchronous call with no I/O
//     yield point available to a black-box test harness; driving it would
//     require monkeypatching the exact low-level fs primitive the
//     implementation uses (readFileSync vs an fd-based read), which is
//     itself implementation detail this suite is walled off from knowing
//     (H4) — and a REAL concurrent-process race against a sub-millisecond
//     window would be a timing race, forbidden by the test-writer's own
//     determinism rubric. See the comment at [R9-17-race] below.
//
// Harness conventions copied from sibling suites in this directory:
//   - git fixture (mkdtempSync + .sterling dir + `git init -q -b main` +
//     user.email/user.name + SterlingStore + SterlingTools({..., repoRoot})):
//     file-parked-ancestry.test.ts (gitRepo()), board-provenance.test.ts
//     (gitFixture()), tools.test.ts (gitRepo()).
//   - mkArticle via tools.knowledgeCreate('feature_article', {...}):
//     file-parked-ancestry.test.ts, board-provenance.test.ts,
//     knowledge-query-baseline-drift.test.ts.
//   - config: parseConfig({ generated_projections / working_trees }):
//     server.test.ts (the generated-projections + working_tree fixtures).
//   - knowledgeQueryResult's `baseline_drift`/`provenance` envelope:
//     knowledge-query-baseline-drift.test.ts.
//   - idOf() tolerant of `removed`/`id` on a removal receipt:
//     idempotent-remove.test.ts, resolves-claim.test.ts.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';
import { parseConfig } from '@sterling/schemas';

type Loose = Record<string, unknown>;
type Config = ReturnType<typeof parseConfig>;

const NOW = '2026-09-06T12:00:00.000Z';

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function gitFixture(opts: { config?: Config } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-attested-close-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const git = (...a: string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
    return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
  };
  const gitOut = (...a: string[]): string => git(...a).stdout;
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir, ...(opts.config ? { config: opts.config } : {}) });
  const headSha = () => gitOut('rev-parse', 'HEAD');
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, tools, git: gitOut, headSha, cleanup };
}

const mkArticle = (tools: SterlingTools, slug: string, files: { path: string; role?: string }[], extra: Loose = {}): Loose =>
  (
    tools.knowledgeCreate('feature_article', {
      slug,
      title: slug,
      what_it_does: 'x',
      intended_behavior: 'x',
      files: files.map((f) => ({ path: f.path, role: f.role ?? 'impl' })),
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
      ...extra,
    } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose }
  ).record;

/** TEST REPAIR 2026-09-07 (conductor-adjudicated, fix-forward of the pins'
 *  PRECONDITION, not their subject): since decision
 *  path-claims-are-leaf-or-absent-directory-claims-refused-at-the-tool-write-boundary
 *  (7933e3a8) knowledge_create REFUSES an article claiming an existing
 *  directory, so [R9-14b]/[R9-14c] can no longer build their fixture through
 *  the tool surface. A raw envelope written below the write boundary is the
 *  only way such a record can exist (legacy data); mirrors
 *  directory-claims.test.ts / resolves-append-join.test.ts field-for-field. */
const mkRawArticle = (store: SterlingStore, slug: string, filePaths: string[]): Loose => {
  const h = createHash('sha1').update(slug).digest('hex'); // deterministic, all-hex → a valid v4-shaped uuid
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-8${h.slice(15, 18)}-${h.slice(18, 30)}`;
  const rec: Loose = {
    id,
    type: 'feature_article',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: filePaths.map((path) => ({ path, role: 'impl' })),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  };
  store.create(rec as never);
  return rec;
};

/** Same repair for the ITEM half of the precondition: maintenanceEnqueue funnels
 *  through knowledge_create, which now refuses a directory file_key, so the
 *  reconcile_needed item is minted raw below the boundary too. */
const mkRawItem = (store: SterlingStore, text: string, fileKeys: string[], featureLink: string): Loose => {
  const h = createHash('sha1').update(`item:${text}`).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-8${h.slice(15, 18)}-${h.slice(18, 30)}`;
  const rec: Loose = {
    id,
    type: 'todo',
    created_at: NOW,
    updated_at: NOW,
    author: 'system',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    version: 1,
    text,
    source: 'system',
    system_reason: 'reconcile_needed',
    file_keys: fileKeys,
    feature_link: featureLink,
    priority: 'normal',
  };
  store.create(rec as never);
  return rec;
};

const mkRefMaterial = (tools: SterlingTools, location: string, extra: Loose = {}): Loose =>
  (
    tools.knowledgeCreate('reference_material', {
      title: location,
      kind: 'doc',
      location,
      summary: 'x',
      source_date: '2026-09-06',
      capture_date: '2026-09-06',
      ...extra,
    } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose }
  ).record;

function commitFile(dir: string, git: (...a: string[]) => string, relPath: string, content: string | Buffer): void {
  const abs = join(dir, ...relPath.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  git('add', '-A');
  git('commit', '-qm', `write ${relPath}`);
}

function idOf(result: unknown): string | undefined {
  const r = result as { removed?: string; id?: string };
  return r.removed ?? r.id;
}

function baselinesOf(rec: Loose): Record<string, string> {
  return (rec.file_baselines as Record<string, string>) ?? {};
}

function attestationsOf(rec: Loose): Record<string, Loose> {
  return (rec.baseline_attestations as Record<string, Loose>) ?? {};
}

const queryDrift = (tools: SterlingTools, articleId: string): string[] => {
  const env = tools.knowledgeQueryResult({ types: ['feature_article'] } as unknown as Parameters<SterlingTools['knowledgeQueryResult']>[0]) as unknown as {
    records: Loose[];
  };
  const rec = env.records.find((r) => r.id === articleId);
  return ((rec?.baseline_drift as { changed?: string[] } | undefined)?.changed) ?? [];
};

// ===========================================================================
// PIN [R9-1] — exact-key scope: only the item's own file_keys are re-stamped.
// SABOTAGE: stamp EVERY path the article owns instead of intersecting with
// the item's file_keys → src/b.ts gains an attestation entry it was never
// claimed for, and this test's final assertion goes red.
// ===========================================================================
test('[R9-1] exact-key scope: closing a reconcile_needed item stamps baseline_attestations ONLY for that item\'s own file_keys — a sibling owned path the item never named carries no attestation', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/b.ts', 'b-v1');
    const article = mkArticle(tools, 'exact-scope', [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'exact-scope' (a only)`,
      file_keys: ['src/a.ts'],
      feature_link: article.id as string,
    });

    const result = tools.maintenanceRemove(item.id as string);
    assert.equal(idOf(result), item.id, 'the item closed');

    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    const attest = attestationsOf(after);
    assert.ok(attest['src/a.ts'], 'the claimed path is attested');
    assert.ok(!('src/b.ts' in attest), 'the sibling path the item never named carries NO attestation entry');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-2] — unrelated drift on a sibling owned path SURVIVES an attested
// close scoped to a different path: the baseline for the untouched path is
// left byte-for-byte as it was, and still reads as genuinely drifted.
// SABOTAGE: re-baseline every owned path to its CURRENT content whenever any
// one of them is attested → b's baseline silently updates to match b-v2 and
// this test's "still drifted" assertions go red.
// ===========================================================================
test('[R9-2] unrelated drift on a sibling owned path survives an attested close scoped to a different path — the stamp is per-path, not wholesale', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/b.ts', 'b-v1');
    const article = mkArticle(tools, 'unrelated-drift', [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
    const bBaselineBefore = baselinesOf(article)['src/b.ts'];
    assert.ok(bBaselineBefore, 'precondition: b has a real recorded baseline to compare against');

    // b drifts for real — committed, genuinely different bytes — while a
    // stays byte-identical. The item claims only a.
    commitFile(dir, git, 'src/b.ts', 'b-v2-drifted');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'unrelated-drift' (a only)`,
      file_keys: ['src/a.ts'],
      feature_link: article.id as string,
    });
    tools.maintenanceRemove(item.id as string);

    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.equal(baselinesOf(after)['src/b.ts'], bBaselineBefore, "b's baseline is UNCHANGED — its drift was never claimed and is never silently absorbed");
    assert.notEqual(baselinesOf(after)['src/b.ts'], sha256('b-v2-drifted'), 'and the unchanged baseline genuinely no longer matches the live drifted bytes');
    assert.ok(!('src/b.ts' in attestationsOf(after)), 'b carries no attestation — the close never touched it');

    const changed = queryDrift(tools, article.id as string);
    assert.ok(changed.includes('src/b.ts'), 'the independent read-time drift wire still reports b as changed after the close');
    assert.ok(!changed.includes('src/a.ts'), 'and a — genuinely reconciled — does not');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-5] — system board_remove parity: boardRemove attests a
// reconcile_needed item exactly like maintenanceRemove would.
// SABOTAGE: wire the attestation path into maintenanceRemove only, leaving
// boardRemove's reconcile_needed branch as an ordinary bare removal → the
// attestation lookup after boardRemove comes back empty and this test's
// central assertion goes red.
// ===========================================================================
test('[R9-5] board_remove attests a reconcile_needed item exactly like maintenance_remove — parity across both removal entry points', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    const article = mkArticle(tools, 'parity', [{ path: 'src/a.ts' }]);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'parity'`,
      file_keys: ['src/a.ts'],
      feature_link: article.id as string,
    });

    const result = tools.boardRemove(item.id as string);
    assert.equal(idOf(result), item.id, 'board_remove closes the system item too — no source restriction blocks it');

    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    const attest = attestationsOf(after)['src/a.ts'] as { item_id?: string } | undefined;
    assert.ok(attest, 'board_remove produced the SAME attested close as maintenance_remove would have');
    assert.equal(attest!.item_id, item.id, 'names the item that closed it');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-6] — recurrence suppressed. See the file-header SCOPE NOTE for
// exactly what this proves and why, given the review-territory boundary.
// SABOTAGE: attest without actually re-stamping file_baselines to the LIVE
// bytes (e.g. write baseline_attestations only, leaving file_baselines
// stale) → the post-close `baselinesOf(after)['src/a.ts']` assertion goes
// red, and the derived drift wire keeps reporting 'src/a.ts' as changed.
// ===========================================================================
test('[R9-6] recurrence suppressed: after the attested close, a fresh read over the SAME unchanged bytes finds no drift on the closed path — the exact predicate a settlement mint depends on (AC2, h7-settlement-predicate) reads clean', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    const article = mkArticle(tools, 'recurrence', [{ path: 'src/a.ts' }]);
    // drift it for real, committed — the exact shape settlement mints against.
    commitFile(dir, git, 'src/a.ts', 'a-v2-drifted');

    // CONTROL, first: before the close, the shared predicate genuinely reads drifted.
    assert.ok(queryDrift(tools, article.id as string).includes('src/a.ts'), 'precondition: before the close, the path reads as changed against the recorded baseline');

    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'recurrence'`,
      file_keys: ['src/a.ts'],
      feature_link: article.id as string,
    });
    tools.maintenanceRemove(item.id as string);

    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.equal(baselinesOf(after)['src/a.ts'], sha256('a-v2-drifted'), 'the baseline now matches the live committed bytes exactly');

    assert.ok(!queryDrift(tools, article.id as string).includes('src/a.ts'), 'a fresh read over the unchanged bytes now reads CLEAN — the next settlement pass has nothing to mint here');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-7] — provenance readable: baseline_attestations names attested_at,
// item_id, head_commit and sha256, correctly.
// SABOTAGE: swap `head_commit` for the ITEM's created_at commit rather than
// the CLOSE-TIME HEAD, or record the wrong item's id → any one of the four
// field assertions below goes red.
// ===========================================================================
test('[R9-7] provenance readable: baseline_attestations records attested_at/item_id/head_commit/sha256 correctly, naming the closing item and the real HEAD', () => {
  const { dir, tools, git, headSha, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    const article = mkArticle(tools, 'provenance', [{ path: 'src/a.ts' }]);
    const head = headSha();
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'provenance'`,
      file_keys: ['src/a.ts'],
      feature_link: article.id as string,
    });
    tools.maintenanceRemove(item.id as string);

    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    const attest = attestationsOf(after)['src/a.ts'] as { attested_at?: string; item_id?: string; head_commit?: string; sha256?: string } | undefined;
    assert.ok(attest, 'an attestation entry exists for the closed path');
    assert.equal(attest!.item_id, item.id, 'names the item that attested it');
    assert.equal(attest!.head_commit, head, 'names the real repo HEAD at close time');
    assert.equal(attest!.sha256, sha256('a-v1'), 'names the sha256 of the actually-committed bytes');
    assert.equal(attest!.attested_at, NOW, "names when it was attested (the fixture's fixed clock)");
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-8a] — missing/unowned key refusal: an item naming a file_key the
// article does not own is refused, naming the offending key; nothing is
// removed and nothing (not even a legitimately-owned sibling) is stamped.
// SABOTAGE: silently intersect file_keys with owned paths instead of
// requiring a full subset → the throw never fires and this test's
// assert.throws itself fails.
// ===========================================================================
test('[R9-8a] an item naming a file_key the article does NOT own is refused, naming the offending key — nothing removed, nothing stamped even for the legitimate sibling key', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    commitFile(dir, git, 'src/rogue.ts', 'rogue-v1');
    const article = mkArticle(tools, 'unowned-key', [{ path: 'src/a.ts' }]);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'unowned-key'`,
      file_keys: ['src/a.ts', 'src/rogue.ts'],
      feature_link: article.id as string,
    });

    assert.throws(
      () => tools.maintenanceRemove(item.id as string),
      (err: Error) => {
        assert.match(err.message, /src\/rogue\.ts/, 'names the offending unowned key');
        return true;
      }
    );
    assert.ok(
      tools.maintenanceQuery({ cap: 1000 }).some((t) => (t as unknown as { id: string }).id === item.id),
      'the item is still open — the refused call removed nothing'
    );
    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.ok(!('src/a.ts' in attestationsOf(after)), 'not even the legitimately-owned sibling key got stamped — the refusal is whole-call, not partial');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-8b] — a reconcile_needed item with NO file_keys is refused: there
// is nothing to attest.
// SABOTAGE: treat an empty/absent file_keys as "nothing to do, remove
// cleanly" → the assert.throws below fails.
// ===========================================================================
test('[R9-8b] a reconcile_needed item with NO file_keys is refused — there is nothing to attest', () => {
  const { tools, cleanup } = gitFixture();
  try {
    const article = mkArticle(tools, 'zero-key', [{ path: 'src/a.ts' }]);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'zero-key', no keys named`,
      feature_link: article.id as string,
    });
    assert.throws(() => tools.maintenanceRemove(item.id as string));
    assert.ok(
      tools.maintenanceQuery({ cap: 1000 }).some((t) => (t as unknown as { id: string }).id === item.id),
      'still open after the refusal'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-9] — HEAD/worktree mismatch refusal: a dirty (uncommitted) edit on
// the claimed path is refused — attesting it would stamp uncommitted bytes.
// SABOTAGE: hash the WORKING TREE bytes without ever comparing against HEAD
// → this call would succeed and stamp `sha256('a-v2-uncommitted')`, and this
// test's assert.throws (plus the untouched-baseline check) goes red.
// ===========================================================================
test('[R9-9] a dirty worktree (uncommitted edit) on the claimed path is refused — attesting would stamp uncommitted bytes', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    const article = mkArticle(tools, 'dirty-worktree', [{ path: 'src/a.ts' }]);
    writeFileSync(join(dir, 'src', 'a.ts'), 'a-v2-uncommitted'); // dirty, never committed
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'dirty-worktree'`,
      file_keys: ['src/a.ts'],
      feature_link: article.id as string,
    });

    assert.throws(
      () => tools.maintenanceRemove(item.id as string),
      (err: Error) => {
        assert.match(err.message, /src\/a\.ts/);
        return true;
      }
    );
    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.equal(baselinesOf(after)['src/a.ts'], sha256('a-v1'), 'the baseline is untouched by the refused attempt');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-9b] — settled ruling: an UNMAPPED working_tree refuses (never
// falls through). No baseline exists to compare against, but the article's
// declared working_tree names a real symbolic tree this process simply
// cannot resolve — evidentiary unavailability, not affirmative exemption.
// SABOTAGE: fall through to ordinary removal whenever no baseline exists to
// compare against, folding "unmapped tree" into the same bucket as a
// generated-projection exemption → this test's assert.throws fails.
// ===========================================================================
test('[R9-9b] an item claiming a path whose article declares an UNMAPPED working_tree is refused — this process cannot identify the correct bytes, so it fails closed rather than falling through', () => {
  const { tools, cleanup } = gitFixture(); // no config.working_trees at all — 'ghost' resolves nowhere
  try {
    const article = mkArticle(tools, 'unmapped-tree', [{ path: 'src/whatever.mjs' }], { working_tree: 'ghost' });
    assert.equal((article as { file_baselines?: unknown }).file_baselines, undefined, 'precondition: no baseline was ever computed for an unmapped tree');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'unmapped-tree'`,
      file_keys: ['src/whatever.mjs'],
      feature_link: article.id as string,
    });

    assert.throws(
      () => tools.maintenanceRemove(item.id as string),
      (err: Error) => {
        assert.match(err.message, /working_tree|ghost/i);
        return true;
      }
    );
    assert.ok(tools.maintenanceQuery({ cap: 1000 }).some((t) => (t as unknown as { id: string }).id === item.id), 'still open');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-9c] — settled ruling: a SterlingTools instance with NO repoRoot
// hard-refuses; it never falls through to ordinary removal. Decision
// attestation-bypass-requires-affirmative-exemption-not-unavailable-evidence:
// settlement runs hook-side with its OWN independently-derived root, so a
// rootless bare-remove would leave the article's baseline stale and get
// re-minted by the next hook pass — silently reopening R9's own loop.
// SABOTAGE: `if (!this.repoRoot) return ordinaryRemove(...)` → the
// assert.throws below fails and the item vanishes with nothing attested.
// ===========================================================================
test('[R9-9c] a SterlingTools instance with NO repoRoot hard-refuses an attested close — missing evidence is never an affirmative exemption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-attested-close-noroot-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW }); // no repoRoot
  try {
    const article = mkArticle(tools, 'no-root', [{ path: 'src/a.ts' }]);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'no-root'`,
      file_keys: ['src/a.ts'],
      feature_link: article.id as string,
    });

    assert.throws(
      () => tools.maintenanceRemove(item.id as string),
      (err: Error) => {
        assert.match(err.message, /repo ?root/i);
        return true;
      }
    );
    assert.ok(
      tools.maintenanceQuery({ cap: 1000 }).some((t) => (t as unknown as { id: string }).id === item.id),
      'REFUSED, never falls through to an ordinary bare removal'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN [R9-11] — an attested path is NOT exempted from future drift
// detection: an edit after the close, even with a backdated mtime (the
// git-checkout shape the mtime prefilter cannot see — see
// knowledge-query-baseline-drift.test.ts STALE1), is still read as changed.
// SABOTAGE: cache "this path was just attested, skip re-hashing it" at
// read-time classification → the post-edit `changed` assertion goes red.
// ===========================================================================
test('[R9-11] an attested path is not exempted from future drift detection — a post-close edit with a backdated mtime is still read as changed', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    const article = mkArticle(tools, 'post-attest-drift', [{ path: 'src/a.ts' }]);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'post-attest-drift'`,
      file_keys: ['src/a.ts'],
      feature_link: article.id as string,
    });
    tools.maintenanceRemove(item.id as string);

    // CONTROL, first: right after the close, it reads clean.
    assert.ok(!queryDrift(tools, article.id as string).includes('src/a.ts'), 'precondition: clean right after the close');

    // edit AFTER attestation, mtime pushed BACKWARDS.
    const old = new Date('2020-01-01T00:00:00Z');
    writeFileSync(join(dir, 'src', 'a.ts'), 'a-v3-after-attest');
    utimesSync(join(dir, 'src', 'a.ts'), old, old);

    assert.ok(
      queryDrift(tools, article.id as string).includes('src/a.ts'),
      'the attested path is STILL hashed and STILL reports drift — attestation never grants a future trust-cache exemption'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-13] — baseline_attestations is server-owned: a caller cannot set
// it directly through knowledge_create or knowledge_update. Refused BY NAME
// — whether as an explicitly-guarded server-owned field, or (per the
// knowledge_schema('feature_article') introspection not yet listing this
// field — see the report) at minimum as an unrecognized key. Either shape
// satisfies the caller-facing guarantee this pin exists to protect.
// SABOTAGE: accept baseline_attestations verbatim on knowledge_create /
// knowledge_update → both assert.throws calls below fail.
// ===========================================================================
test('[R9-13] baseline_attestations cannot be set directly by a caller through knowledge_create or knowledge_update', () => {
  const { tools, cleanup } = gitFixture();
  try {
    const forgedAttestation = { attested_at: NOW, item_id: 'x', head_commit: 'a'.repeat(40), sha256: 'x' };
    assert.throws(
      () =>
        tools.knowledgeCreate('feature_article', {
          slug: 'try-set-attest',
          title: 'x',
          what_it_does: 'x',
          intended_behavior: 'x',
          files: [{ path: 'src/a.ts', role: 'impl' }],
          current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
          dependencies: { relies_on: [], relied_by: [] },
          state: 'active',
          version: 1,
          history: [{ date: NOW, event: 'seed' }],
          live_test_refs: [],
          baseline_attestations: { 'src/a.ts': forgedAttestation },
        } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]),
      (err: Error) => {
        assert.match(err.message, /baseline_attestations/);
        return true;
      }
    );
    assert.equal(tools.knowledgeQuery({ types: ['feature_article'] }).length, 0, 'the refused create wrote nothing');

    const article = mkArticle(tools, 'try-update-attest', [{ path: 'src/a.ts' }]);
    assert.throws(
      () =>
        tools.knowledgeUpdate(article.id as string, { baseline_attestations: { 'src/a.ts': forgedAttestation } } as unknown as Record<string, unknown>),
      (err: Error) => {
        assert.match(err.message, /baseline_attestations/);
        return true;
      }
    );
    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.equal(after.version, 1, 'the refused update minted nothing');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-14a] — a SYMLINK present at attestation time is refused, and the
// link target's bytes are never incorporated into any baseline anywhere on
// the record. This is the REACHABLE HALF of reviewer item 16 (symlink
// no-follow): the swap-BETWEEN-check-and-read race is a separate, undriven
// concern — see the comment immediately below this test.
// SABOTAGE: open the path with a plain (link-following) read for hashing
// after only an lstat-based shape check → the throw disappears AND/OR the
// "never incorporated" assertion goes red because the outside-tree secret's
// hash appears in some baseline.
// ===========================================================================
test('[R9-14a] a path that is a SYMLINK at attestation time is refused, and the link target\'s bytes are never incorporated into any baseline', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    writeFileSync(join(dir, 'secret-outside.txt'), 'OUTSIDE_TREE_SECRET');
    mkdirSync(join(dir, 'src'), { recursive: true });
    symlinkSync(join(dir, 'secret-outside.txt'), join(dir, 'src', 'link.ts'));
    git('add', '-A');
    git('commit', '-qm', 'commit the symlink itself');
    const article = mkArticle(tools, 'symlink-shape', [{ path: 'src/link.ts' }]);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'symlink-shape'`,
      file_keys: ['src/link.ts'],
      feature_link: article.id as string,
    });

    assert.throws(
      () => tools.maintenanceRemove(item.id as string),
      (err: Error) => {
        assert.match(err.message, /src\/link\.ts/);
        assert.match(err.message, /symlink|not a regular file|regular file/i);
        return true;
      }
    );
    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.ok(!('src/link.ts' in attestationsOf(after)), 'no attestation was written for the symlink path');
    assert.ok(
      !Object.values(baselinesOf(after)).includes(sha256('OUTSIDE_TREE_SECRET')),
      "the link target's bytes never made it into any baseline anywhere on the record"
    );
  } finally {
    cleanup();
  }
});
// WRITTEN-OUT SABOTAGE NOTE for [R9-16-race] (reviewer item 16, the harder
// half — NOT executed here, per the sanctioned H15 S15b/S21b precedent for a
// race that cannot be driven deterministically from a black-box harness):
// the vulnerable shape is a REGULAR FILE at the moment of the shape check
// (lstatSync passes as "not a symlink") that is SWAPPED for a symlink before
// the subsequent read/hash call reopens the SAME PATHNAME. Reproducing this
// requires either (a) genuine OS-level concurrency racing a sub-millisecond
// window — a timing race, forbidden by this suite's own determinism rubric —
// or (b) monkeypatching the exact low-level fs primitive the implementation
// uses between its check and its read (openSync+fstat vs readFileSync vs
// readSync), which is implementation detail this suite is walled off from
// knowing (H4): guessing wrong makes the mock silently never fire, producing
// a hollow pass indistinguishable from a real one. NEITHER is attempted here.
// The fix's stated guarantee ("open ONCE with O_NOFOLLOW, fstat that SAME
// handle, hash from that handle") is pinned at its OBSERVABLE BOUNDARY
// instead, by [R9-14a] above: a symlink present at call time is refused and
// never contributes bytes to any baseline. If the real implementation opens
// twice (check-then-reopen) rather than once (open-then-fstat-then-read),
// [R9-14a] cannot detect that — this is the honest limit of this pin.

// ===========================================================================
// PIN [R9-14b] — a path that resolves to a DIRECTORY (not a file) is refused
// rather than hashed.
// SABOTAGE: only check for symlinks, never for "is this a regular file at
// all" → the assert.throws below fails (or throws for an unrelated reason
// like an EISDIR crash rather than a named refusal).
// ===========================================================================
test('[R9-14b] a path that resolves to a DIRECTORY (not a file) is refused rather than hashed', () => {
  const { dir, store, tools, git, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src', 'adir', 'inner'), { recursive: true });
    writeFileSync(join(dir, 'src', 'adir', 'inner', 'x.ts'), 'inner content');
    git('add', '-A');
    git('commit', '-qm', 'commit a nested dir');
    const article = mkRawArticle(store, 'directory-shape', ['src/adir']); // owns a DIRECTORY path — raw envelope, see mkRawArticle
    const item = mkRawItem(store, `reconcile 'directory-shape'`, ['src/adir'], article.id as string);

    assert.throws(
      () => tools.maintenanceRemove(item.id as string),
      (err: Error) => {
        assert.match(err.message, /src\/adir/);
        return true;
      }
    );
    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.ok(!('src/adir' in attestationsOf(after)), 'no attestation for a directory shape');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-14c] — a path that is a git SUBMODULE (gitlink, tree mode 160000)
// is refused rather than hashed. NOTE (disclosed, not hidden): this fixture
// is a PLUMBING-level gitlink (`git update-index --add --cacheinfo 160000`),
// not a full `git submodule add` checkout — it avoids this host's git
// protocol.file.allow restrictions on local submodules. On disk this
// presents as an empty directory (the realistic shape of an un-checked-out
// submodule after clone), so this pin may share its actual refusal GUARD
// with [R9-14b]'s "not a regular file" check rather than exercising a
// dedicated gitlink-mode check — that is disclosed as a real possibility,
// not asserted against.
// SABOTAGE: special-case ONLY plain directories and never consult git's tree
// mode for a path with no on-disk regular file → the assert.throws below
// fails.
// ===========================================================================
test('[R9-14c] a path that is a git SUBMODULE (gitlink, tree mode 160000) is refused rather than hashed', () => {
  const { dir, store, tools, git, cleanup } = gitFixture();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'src', 'sub'), { recursive: true }); // present, empty — the un-checked-out submodule shape
    git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},src/sub`);
    git('commit', '-qm', 'add a gitlink entry (plumbing-level, not a full submodule checkout)');
    const article = mkRawArticle(store, 'gitlink-shape', ['src/sub']); // raw envelope, see mkRawArticle
    const item = mkRawItem(store, `reconcile 'gitlink-shape'`, ['src/sub'], article.id as string);

    assert.throws(
      () => tools.maintenanceRemove(item.id as string),
      (err: Error) => {
        assert.match(err.message, /src\/sub/);
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-15a] — a path-count cap: an implausibly large number of file_keys
// is refused WHOLE, before any mutation. NOTE (disclosed, not hidden): the
// brief names no exact threshold, so N=600 is a STRESS value chosen to sit
// safely above any plausible per-item cap, not a boundary probe of the real
// number — see the report for why a precise boundary pin is not written.
// SABOTAGE: remove the cap check entirely → this whole test goes red (no
// throw; every one of the 600 paths gets stamped).
// ===========================================================================
test('[R9-15a] a reconcile_needed item naming an implausibly large number of file_keys is refused WHOLE, before any mutation', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  const N = 600;
  try {
    const files: { path: string }[] = [];
    for (let i = 0; i < N; i++) {
      const p = `src/gen/f${i}.ts`;
      const abs = join(dir, ...p.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, `export const v = ${i};`);
      files.push({ path: p });
    }
    git('add', '-A');
    git('commit', '-qm', `seed ${N} files`);
    const article = mkArticle(tools, 'cap-count', files);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'cap-count'`,
      file_keys: files.map((f) => f.path),
      feature_link: article.id as string,
    });

    assert.throws(() => tools.maintenanceRemove(item.id as string), /cap|limit|exceed|too many/i);
    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.equal(Object.keys(attestationsOf(after)).length, 0, 'refused WHOLE — not even a partial stamp of the first under-cap paths');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-15b] — a total-byte cap: a claimed path whose content is
// implausibly large is refused WHOLE, before any mutation. Same disclosed
// caveat as [R9-15a]: 20MB is a stress value, not a probed boundary.
// SABOTAGE: remove the byte-size cap check entirely → this test goes red.
// ===========================================================================
test('[R9-15b] a reconcile_needed item naming a path whose content is implausibly large is refused WHOLE, before any mutation', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    const big = Buffer.alloc(20 * 1024 * 1024, 'a');
    commitFile(dir, git, 'src/huge.bin', big);
    const article = mkArticle(tools, 'cap-bytes', [{ path: 'src/huge.bin' }]);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'cap-bytes'`,
      file_keys: ['src/huge.bin'],
      feature_link: article.id as string,
    });

    assert.throws(() => tools.maintenanceRemove(item.id as string), /cap|limit|exceed|too large|size/i);
    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.equal(Object.keys(attestationsOf(after)).length, 0);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// [R9-17-race] — reviewer item 17 (final live re-verification before the
// CAS). NOT DRIVEN: the described bug ("path 1 could change while paths
// 2-64 were processed") is a mutate-DURING-processing race between two hash
// passes that occur back-to-back inside ONE synchronous call. There is no
// I/O yield point a black-box test can interleave with; genuinely reaching
// it needs either (a) a real concurrent OS process racing a sub-millisecond
// window (a timing race — forbidden by this suite's own determinism rubric,
// and flaky by construction, since the very fix under test narrows that
// window), or (b) monkeypatching whichever exact low-level fs primitive the
// implementation reads through — unknown to this suite under H4, and a wrong
// guess silently no-ops the mock rather than failing loud. Both are refused
// rather than faked, per the same written-out-sabotage precedent as
// [R9-16-race] above. Reported to the coordinator as a genuine harness gap:
// this specific guarantee is verifiable by an implementer who knows the
// exact syscall, but not by a blind test-writer under the read wall.
// ===========================================================================

// ===========================================================================
// PIN [R9-18a] — generated-projection admission, arm A (pre-lock
// fall-through): an item whose file_keys are ALL generated-projection paths
// falls through to ordinary removal, even when the worktree is DIRTY (which
// would otherwise refuse under [R9-9]) — proving it never even attempts
// attestation, rather than merely happening to satisfy it.
// SABOTAGE: attempt attestation unconditionally, ignoring
// config.generated_projections → this call now throws on the dirty
// worktree, and the assert.doesNotThrow-shaped success path below fails.
// ===========================================================================
test('[R9-18a] an item whose file_keys are ALL generated-projection paths falls through to ordinary removal — no attestation attempted, even against a dirty worktree', () => {
  const { dir, tools, git, cleanup } = gitFixture({ config: parseConfig({ generated_projections: ['architecture.md'] }) });
  try {
    commitFile(dir, git, 'architecture.md', 'gen-v1');
    const article = mkArticle(tools, 'projection-fallthrough', [{ path: 'architecture.md' }]);
    const versionBefore = (tools.knowledgeGet(article.id as string) as unknown as { version: number }).version;
    // dirty the worktree — if attestation were attempted at all, [R9-9] shows this refuses.
    writeFileSync(join(dir, 'architecture.md'), 'gen-v2-uncommitted-dirty');

    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'projection-fallthrough'`,
      file_keys: ['architecture.md'],
      feature_link: article.id as string,
    });
    const result = tools.maintenanceRemove(item.id as string);
    assert.equal(idOf(result), item.id, 'the fall-through removal succeeds despite the dirty worktree');

    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.equal(after.version, versionBefore, 'the article was never touched — a true fall-through, not a silent successful attestation');
    assert.equal(Object.keys(attestationsOf(after)).length, 0, 'no attestation entry was ever written');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-18b] — generated-projection admission, arm B: an item whose
// file_keys MIX one generated-projection path with one real path is refused
// WHOLE, naming the projection key — it never silently attests just the real
// path either.
// SABOTAGE: treat a mixed item like arm A whenever ANY key is exempt (fall
// through, ignoring the non-exempt sibling) → the assert.throws below fails
// and the item is silently closed instead.
// ===========================================================================
test('[R9-18b] an item whose file_keys MIX one generated-projection path with one real path is refused WHOLE, naming the projection key', () => {
  const { dir, tools, git, cleanup } = gitFixture({ config: parseConfig({ generated_projections: ['architecture.md'] }) });
  try {
    commitFile(dir, git, 'architecture.md', 'gen-v1');
    commitFile(dir, git, 'src/real.ts', 'real-v1');
    const article = mkArticle(tools, 'projection-mixed', [{ path: 'architecture.md' }, { path: 'src/real.ts' }]);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'projection-mixed'`,
      file_keys: ['architecture.md', 'src/real.ts'],
      feature_link: article.id as string,
    });

    assert.throws(
      () => tools.maintenanceRemove(item.id as string),
      (err: Error) => {
        assert.match(err.message, /architecture\.md/);
        return true;
      }
    );
    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.equal(Object.keys(attestationsOf(after)).length, 0, 'refused whole — src/real.ts is not silently attested on its own either');
    assert.ok(tools.maintenanceQuery({ cap: 1000 }).some((t) => (t as unknown as { id: string }).id === item.id), 'the item stays open');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-19] — a SHA-256 git repo (64-char HEAD) is accepted, not treated
// as HEAD-unavailable. Dynamically SKIPPED (t.skip), never faked, if this
// host's git build lacks --object-format=sha256 support — mirrors the
// platform-gated skip precedent (h15-structured-write.test.mjs S15b/S21b).
// UNVERIFIED EXECUTION: this test-writer has no Bash/execute access and
// could not confirm at authoring time whether this host's git supports
// --object-format=sha256; the dynamic skip is the safety valve for that.
// SABOTAGE: validate HEAD with a fixed /^[0-9a-f]{40}$/ check → the init
// succeeds, the fixture precondition (64-char HEAD) passes, and the actual
// close call throws "HEAD unavailable" instead of succeeding.
// ===========================================================================
test('[R9-19] a repo using git\'s SHA-256 object format (64-char HEAD) is accepted, not treated as HEAD-unavailable', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-attested-close-sha256-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  const rawGit = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  try {
    const init = rawGit('init', '-q', '-b', 'main', '--object-format=sha256');
    if (init.status !== 0) {
      (t as unknown as { skip: (msg: string) => void }).skip(
        `this host's git build does not support --object-format=sha256 (${(init.stderr || '').trim() || 'unknown error'}) — cannot drive this pin here; see report`
      );
      return;
    }
    rawGit('config', 'user.email', 't@t.t');
    rawGit('config', 'user.name', 't');
    writeFileSync(join(dir, 'src', 'a.ts'), 'a-v1');
    rawGit('add', '-A');
    rawGit('commit', '-qm', 'seed');
    const head = rawGit('rev-parse', 'HEAD').stdout.trim();
    assert.equal(head.length, 64, 'fixture precondition: this really is a sha256-format repo (64-hex HEAD), or this pin tests nothing');

    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
    try {
      const article = mkArticle(tools, 'sha256-repo', [{ path: 'src/a.ts' }]);
      const { record: item } = tools.maintenanceEnqueue({
        reason: 'reconcile_needed',
        text: `reconcile 'sha256-repo'`,
        file_keys: ['src/a.ts'],
        feature_link: article.id as string,
      });
      const result = tools.maintenanceRemove(item.id as string);
      assert.equal(idOf(result), item.id, 'the close succeeds against a 64-char HEAD — not refused as HEAD-unavailable');
      const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
      const attest = attestationsOf(after)['src/a.ts'] as { head_commit?: string } | undefined;
      assert.ok(attest, 'attestation was written');
      assert.equal(attest!.head_commit, head, 'the 64-char HEAD is recorded verbatim, not truncated or rejected');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN [R9-20a] — tree membership, not filesystem existence, is the name
// authority (decision `attested-close-proves-buffer-equality-through-git-
// not-path-resolution`, 2026-09-06): the close-time proof is made from ONE
// batched `git ls-tree` read of HEAD's tree, matched by literal exact name —
// so a file_key that resolves to a real file ON DISK but is NOT the
// byte-for-byte name of a regular-file entry in HEAD's tree is refused AT
// CLOSE. The probe here is a TRAILING-DOT alias (`src/a.ts.`) — a distinct,
// legal file on Linux, and (per board 0099fc55) a filesystem-level alias of
// `src/a.ts` on Windows. Only `src/a.ts` is ever committed; `src/a.ts.`
// exists solely as an untracked file with DIFFERENT content.
//
// Article/item creation are NOT expected to refuse here: per the same
// decision, the create-time baseline (`computeBaselines`) is an unrelated
// mechanism (lstat-regular → hash whatever is on disk) with no tree check of
// its own — confirmed by the sibling suite's STALE3 pin, where an article
// legitimately owns a path absent at creation with simply no baseline
// recorded, never a throw. So this pin targets `maintenanceRemove` itself,
// matching this file's own [R9-14a]/[R9-14b]/[R9-14c] convention (creation
// succeeds; the attested-close call is where a shape refusal lives), and
// checks that the pre-close baseline (whatever create-time computed from the
// alias's own on-disk bytes — a separate, unrelated fact) is left untouched
// by the refused attempt, exactly as [R9-9] checks for a dirty worktree.
//
// SABOTAGE: decide close-time membership by `fs.existsSync(path)` instead of
// the batched HEAD `ls-tree` lookup → `src/a.ts.` exists on disk, so
// `maintenanceRemove` no longer throws, `assert.throws` fails ("Missing
// expected exception"), and this whole test goes red.
// ===========================================================================
test('[R9-20a] a TRAILING-DOT alias key that exists on disk but is not the tree\'s own name for any entry is refused at close — the item stays open, nothing is stamped, and the pre-close baseline is untouched', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    // untracked, on-disk-only alias with content distinct from the committed file.
    writeFileSync(join(dir, 'src', 'a.ts.'), 'ALIAS_CONTENT_DIFFERENT');

    const article = mkArticle(tools, 'trailing-dot-alias', [{ path: 'src/a.ts.' }]);
    const baselineBefore = baselinesOf(article)['src/a.ts.'];
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'trailing-dot-alias'`,
      file_keys: ['src/a.ts.'],
      feature_link: article.id as string,
    });

    assert.throws(
      () => tools.maintenanceRemove(item.id as string),
      (err: Error) => {
        assert.match(err.message, /src\/a\.ts\./, 'names the offending trailing-dot alias key');
        return true;
      }
    );
    assert.ok(
      tools.maintenanceQuery({ cap: 1000 }).some((t) => (t as unknown as { id: string }).id === item.id),
      'the item is still open — the refused close removed nothing'
    );
    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.ok(!('src/a.ts.' in attestationsOf(after)), 'no attestation entry was written for the alias key');
    assert.equal(baselinesOf(after)['src/a.ts.'], baselineBefore, 'the pre-close baseline is exactly as it was — the refused attempt stamped nothing');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-20b] — same invariant as [R9-20a] (decision `attested-close-
// proves-buffer-equality-through-git-not-path-resolution`), probed by CASE
// instead of a trailing dot: `src/Alpha.ts` is committed; the claimed key is
// `src/alpha.ts`. On this suite's Linux host that lowercase name is absent
// from BOTH the tree and the working directory (case-sensitive filesystem),
// so this pin proves the tree-membership refusal fires even for a key that
// resolves to nothing at all on disk — not only for a key that happens to
// collide with a real file, as [R9-20a] probes. (On a case-insensitive
// filesystem — or Windows, board 77421deb territory — the same key would
// resolve to `Alpha.ts` on disk while still failing an exact tree-name
// membership check; this harness cannot drive that shape from Linux, so only
// the reachable half is pinned here, matching the file's own precedent for
// disclosing an unreachable variant rather than faking it.) As in [R9-20a],
// article/item creation are expected to succeed (STALE3 precedent: an owned,
// currently-absent path simply gets no baseline, never a throw) — only
// `maintenanceRemove` is expected to refuse.
//
// SABOTAGE: same as [R9-20a] — decide close-time membership by filesystem
// existence (case-insensitively, or via a normalize-then-existsSync path)
// instead of the batched HEAD `ls-tree` exact-name lookup.
// ===========================================================================
test('[R9-20b] a file_key differing from the tree\'s own entry only by CASE is refused at close — the tree name is authoritative, not a case-insensitive match', () => {
  const { dir, tools, git, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/Alpha.ts', 'alpha-v1');
    // 'src/alpha.ts' is absent from both the tree and this (case-sensitive,
    // Linux) filesystem.
    const article = mkArticle(tools, 'case-alias', [{ path: 'src/alpha.ts' }]);
    assert.ok(!baselinesOf(article)['src/alpha.ts'], 'precondition: no baseline exists for the case-mismatched key — nothing on disk to hash at creation');

    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'case-alias'`,
      file_keys: ['src/alpha.ts'],
      feature_link: article.id as string,
    });

    assert.throws(
      () => tools.maintenanceRemove(item.id as string),
      (err: Error) => {
        assert.match(err.message, /src\/alpha\.ts/, 'names the offending case-mismatched key');
        return true;
      }
    );
    assert.ok(
      tools.maintenanceQuery({ cap: 1000 }).some((t) => (t as unknown as { id: string }).id === item.id),
      'the item is still open — the refused close removed nothing'
    );
    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.ok(!('src/alpha.ts' in attestationsOf(after)), 'no attestation entry was written for the case-mismatched key');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-21] — a proof about BYTES, not stat metadata (decision `attested-
// close-proves-buffer-equality-through-git-not-path-resolution`: the proof
// is clean-side `hash-object` equality against a buffer this process itself
// read, with no separate dirty-worktree/stat check beside it): a post-enqueue
// rewrite of the claimed path with content IDENTICAL to the committed bytes,
// but a future mtime/atime, is NOT treated as drift. The close succeeds,
// removes the item, and stamps an attestation naming the real HEAD and the
// sha256 of the (unchanged) committed content.
//
// CONTROL, already in this file: [R9-9] above is this pin's control arm,
// placed earlier in the suite rather than duplicated here — it proves a
// worktree edit with genuinely DIFFERENT bytes on the same path refuses.
// Together the pair rules out "the guard never actually fires" as an
// alternative explanation for this pin's green: [R9-9] shows the guard does
// fire on real content drift, so this pin's success can only be explained by
// byte-identity, not by an absent or no-op check.
//
// SABOTAGE: decide cleanliness by comparing stat/mtime (e.g. "worktree mtime
// newer than the last known-clean read, therefore dirty") instead of
// comparing bytes → the future mtime alone trips the guard, `maintenanceRemove`
// throws, and this test's first assertion (`idOf(result) === item.id`) is
// never reached — the whole test goes red.
// ===========================================================================
test('[R9-21] a rewrite with IDENTICAL bytes but a FUTURE mtime is not drift — the close succeeds by byte comparison, not by stat', () => {
  const { dir, tools, git, headSha, cleanup } = gitFixture();
  try {
    commitFile(dir, git, 'src/a.ts', 'a-v1');
    const article = mkArticle(tools, 'mtime-only-touch', [{ path: 'src/a.ts' }]);
    const head = headSha();
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'mtime-only-touch'`,
      file_keys: ['src/a.ts'],
      feature_link: article.id as string,
    });

    // rewrite with IDENTICAL bytes; push mtime/atime a year into the future.
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    writeFileSync(join(dir, 'src', 'a.ts'), 'a-v1');
    utimesSync(join(dir, 'src', 'a.ts'), future, future);

    const result = tools.maintenanceRemove(item.id as string);
    assert.equal(idOf(result), item.id, 'the close SUCCEEDS despite the future mtime — the bytes are identical to HEAD');

    const after = tools.knowledgeGet(article.id as string) as unknown as Loose;
    const attest = attestationsOf(after)['src/a.ts'] as { head_commit?: string; sha256?: string } | undefined;
    assert.ok(attest, 'an attestation entry was written');
    assert.equal(attest!.sha256, sha256('a-v1'), 'the sha256 recorded is that of the committed bytes, unaffected by the mtime change');
    assert.equal(attest!.head_commit, head, 'names the real HEAD');
    assert.equal(baselinesOf(after)['src/a.ts'], sha256('a-v1'), 'the baseline is (re)stamped to the actual content hash');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN [R9-22] — owner-type parity: an attested close applies to a
// reconcile_needed item whose owner is a `reference_material`, not only a
// `feature_article`. Settlement mints reconcile_needed items for BOTH owner
// types (they both carry `file_baselines`) — a reference_material-owned item
// was previously UNCLOSABLE: a HIGH review finding recorded both
// `board_remove` and `maintenance_remove` refusing with "does not resolve to
// a LIVE feature_article", leaving the item permanently stuck with no path
// to close it.
// SABOTAGE: resolve the item's owner by requiring `type === 'feature_article'`
// rather than accepting any live record that legitimately carries
// `file_baselines` for the claimed path → both arms below throw on the very
// first call, and every assert.equal beneath each `maintenanceRemove`/
// `boardRemove` invocation goes red (starting with the first `idOf(...)`
// equality in each arm).
// ===========================================================================
test('[R9-22] an attested close applies to a reconcile_needed item OWNED BY A reference_material, not only a feature_article — both maintenance_remove and board_remove succeed and stamp it', () => {
  const { dir, tools, git, headSha, cleanup } = gitFixture();
  try {
    // -- arm A: maintenance_remove ---------------------------------------
    commitFile(dir, git, 'docs/guide.md', 'guide-v1');
    const headA = headSha();
    const refA = mkRefMaterial(tools, 'docs/guide.md');
    const { record: itemA } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'docs/guide.md'`,
      file_keys: ['docs/guide.md'],
      feature_link: refA.id as string,
    });

    const resultA = tools.maintenanceRemove(itemA.id as string);
    assert.equal(idOf(resultA), itemA.id, 'maintenance_remove closes an item owned by a reference_material');

    const afterA = tools.knowledgeGet(refA.id as string) as unknown as Loose;
    const attestA = attestationsOf(afterA)['docs/guide.md'] as { item_id?: string; head_commit?: string; sha256?: string } | undefined;
    assert.ok(attestA, 'the reference_material now carries an attestation for the closed path');
    assert.equal(attestA!.sha256, sha256('guide-v1'), 'sha256 of the actually-committed bytes');
    assert.equal(attestA!.head_commit, headA, 'names the real repo HEAD at close time');
    assert.equal(attestA!.item_id, itemA.id, 'names the item that closed it');
    assert.equal(baselinesOf(afterA)['docs/guide.md'], sha256('guide-v1'), 'file_baselines is re-stamped to the same sha256');

    // -- arm B: board_remove (parity with [R9-5]) ------------------------
    commitFile(dir, git, 'docs/other.md', 'other-v1');
    const headB = headSha();
    const refB = mkRefMaterial(tools, 'docs/other.md');
    const { record: itemB } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'docs/other.md'`,
      file_keys: ['docs/other.md'],
      feature_link: refB.id as string,
    });

    const resultB = tools.boardRemove(itemB.id as string);
    assert.equal(idOf(resultB), itemB.id, 'board_remove closes an item owned by a reference_material too — no owner-type restriction blocks it');

    const afterB = tools.knowledgeGet(refB.id as string) as unknown as Loose;
    const attestB = attestationsOf(afterB)['docs/other.md'] as { item_id?: string; head_commit?: string; sha256?: string } | undefined;
    assert.ok(attestB, 'board_remove produced the same attested close as maintenance_remove would have');
    assert.equal(attestB!.sha256, sha256('other-v1'), 'sha256 of the actually-committed bytes');
    assert.equal(attestB!.head_commit, headB, 'names the real repo HEAD at close time');
    assert.equal(attestB!.item_id, itemB.id, 'names the item that closed it');
    assert.equal(baselinesOf(afterB)['docs/other.md'], sha256('other-v1'), 'file_baselines is re-stamped to the same sha256');
  } finally {
    cleanup();
  }
});
