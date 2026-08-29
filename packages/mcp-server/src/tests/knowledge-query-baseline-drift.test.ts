// ------------- DERIVED STALENESS on knowledge_query: baseline_drift + provenance -------------
// knowledge_query gains a read-time DERIVED staleness verdict computed by
// computeBaselineDrift() beside the existing contentChanged wire: each record with
// owned files is annotated `baseline_drift {changed[], unverifiable?[], note}`, and the
// result envelope carries a REQUIRED `provenance` field with one of four values:
//   'checked' | 'unavailable:no_repo_root' | 'unavailable:no_baselines' | 'unavailable:count_projection'
//
// THE TWO PROPERTIES THAT ARE CONTRACT, not incidental (STALE4 and STALE2 below):
//   (a) NO RAW BASELINE HASHES LEAK. knowledge_query deliberately strips
//       `file_baselines`; knowledge_get stays the full-fidelity read. The DERIVED
//       verdict is served, the internals never are.
//   (b) AN ABSENT OR UNDETERMINED VERDICT MUST NOT READ AS A POSITIVE FRESHNESS
//       CLAIM. That is why `provenance` is REQUIRED (a caller can always tell
//       "checked and clean" from "could not check") and why `unverifiable[]` is a
//       separate list from `changed[]` (a path whose verdict is unknown is never
//       reported as unchanged, and never as changed either). A record with no
//       checkable owned files is reported as UNAVAILABILITY, never as fresh.
//
// WHY IT IS NOT verify_before_use. The existing drift wire is mtime-GATED: mtime is a
// cheap pre-filter and only then is the sha256 baseline consulted. That misses the
// git-checkout shape entirely — content moved, mtime reset to the past — and
// contentChanged additionally collapses "unreadable" into `false`. computeBaselineDrift
// catches strictly more; STALE1 pins exactly that difference with an arm where
// verify_before_use is silent and baseline_drift is not.
//
// IT MINTS NOTHING. H7 already owns invalidation; a second minting path would double
// the maintenance queue for one fact. STALE4 pins the absence of new items.
//
// SEAM CHOICE (read before adding an arm). SterlingTools has TWO knowledge read seams
// and they are not interchangeable: knowledgeQuery() returns the bare flagged record
// array and applies NO projection and NO envelope; knowledgeQueryResult() is the seam
// that projects and returns {matched_filter, returned, cap, capped, note?, records}.
// `provenance` lives on the ENVELOPE and `baseline_drift` must survive the DIGEST
// projection, so every arm below targets knowledgeQueryResult() — the seam that
// actually projects. An arm aimed at knowledgeQuery() with projection:'digest' would
// pass trivially against full records and pin nothing.
//
// Envelope and annotation are read through `unknown` casts so a missing field fails on
// an AssertionError rather than a build error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;
type Drift = { changed?: string[]; unverifiable?: string[]; note?: string };
type Envelope = { provenance?: string; records: Loose[]; matched_filter: number; returned: number };

const OLD = new Date('2026-01-01T00:00:00Z');
const future = () => new Date(Date.now() + 3_600_000);

function repoHarness(opts: { repoRoot?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-baseline-drift-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  // opts.repoRoot === false constructs the tools with NO repo root at all — the
  // shape that must report 'unavailable:no_repo_root' rather than a freshness claim.
  const tools = opts.repoRoot === false ? new SterlingTools({ store }) : new SterlingTools({ store, repoRoot: dir });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, tools, cleanup };
}

const article = (tools: SterlingTools, slug: string, paths: string[]): Loose =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: paths.map((path) => ({ path, role: 'impl' })),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: '2026-06-01T00:00:00.000Z', event: 'originating brief' }],
    live_test_refs: [],
  }).record as unknown as Loose;

// the PROJECTING seam — see SEAM CHOICE above
const read = (tools: SterlingTools, args: Loose): Envelope =>
  tools.knowledgeQueryResult(args as unknown as Parameters<SterlingTools['knowledgeQueryResult']>[0]) as unknown as Envelope;

const driftOf = (rec: Loose | undefined): Drift | undefined => rec?.baseline_drift as Drift | undefined;
const changedOf = (rec: Loose | undefined): string[] => driftOf(rec)?.changed ?? [];

// A file that exists on disk with content, aged so its mtime is far BEHIND the
// record's updated_at — the git-checkout shape the mtime pre-filter cannot see.
function writeAged(path: string, content: string, when: Date = OLD) {
  writeFileSync(path, content);
  utimesSync(path, when, when);
}

// ---------------------------------------------------------------------------
// STALE0 — CONTROL, FIRST. Passes for the OPPOSITE reason to every arm below:
// a genuinely clean, genuinely checkable record is reported as CHECKED and is NOT
// annotated as drifted. Without this, "changed[] names the file" has a second
// possible cause — a mode that annotates everything it sees.
// ---------------------------------------------------------------------------
test('STALE0 (control): an unchanged owned file reads provenance:"checked" and is NOT reported as drifted — the annotation is a verdict, not a decoration', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    const path = join(dir, 'src', 'a.mjs');
    writeAged(path, 'v1');
    const a = article(tools, 'feat-clean', ['src/a.mjs']);
    assert.ok(
      (a as { file_baselines?: Record<string, string> }).file_baselines?.['src/a.mjs'],
      'precondition: the article recorded a content baseline at create, so there IS something to check against'
    );

    const env = read(tools, { types: ['feature_article'] });
    assert.ok('provenance' in env, 'provenance is a REQUIRED envelope field — a caller must never have to infer whether a check happened');
    assert.equal(env.provenance, 'checked', 'the baselines are present and the repo root is known: this read genuinely checked');

    const rec = env.records.find((r) => r.id === a.id);
    assert.ok(rec, 'the article is in the window');
    assert.deepEqual(changedOf(rec), [], 'a file matching its baseline is NOT reported as changed');
    assert.deepEqual(driftOf(rec)?.unverifiable ?? [], [], 'and a readable, baselined file is not undetermined either');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// STALE1 — the `changed` arm, pinned on the shape verify_before_use CANNOT see.
// ---------------------------------------------------------------------------
test('STALE1: content changed with the mtime RESET to the past (the git-checkout shape) lands in baseline_drift.changed — on full AND digest — while verify_before_use stays silent', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    const path = join(dir, 'src', 'a.mjs');
    writeAged(path, 'v1');
    const a = article(tools, 'feat-a', ['src/a.mjs']); // baseline = sha256('v1')

    // Content moves, mtime goes BACKWARDS (a checkout, a restored file, a merge that
    // rewrote the blob). The mtime pre-filter never fires, so the existing wire abstains.
    writeAged(path, 'v2-genuinely-different-bytes');

    const env = read(tools, { types: ['feature_article'] });
    assert.equal(env.provenance, 'checked', 'the read could and did check');
    const rec = env.records.find((r) => r.id === a.id);
    assert.ok(rec, 'the article is in the window');
    assert.deepEqual(changedOf(rec), ['src/a.mjs'], 'the changed content is named — content, not mtime, is what decides');
    assert.ok((driftOf(rec)?.note ?? '').trim().length > 0, 'the verdict carries a note a reader can act on, never a bare flag');

    // THE VALUE CLAIM, asserted head-on: the mtime-gated wire is silent on exactly
    // this shape. If verify_before_use also fired here, baseline_drift would be
    // redundant rather than strictly stronger.
    assert.equal(
      rec!.verify_before_use,
      undefined,
      'the mtime-gated wire cannot see a backwards-dated content change — this is what the derived verdict adds'
    );

    // DIGEST half. The `!('what_it_does' in rec)` assertion is the anti-trap control:
    // it proves the DIGEST PROJECTION actually ran, so "baseline_drift survived the
    // digest" cannot be explained by a seam that ignored `projection` and handed back
    // full records (the measured trap on the board side: boardQuery() never reads it).
    const digest = read(tools, { types: ['feature_article'], projection: 'digest' });
    assert.equal(digest.provenance, 'checked', 'the envelope discloses provenance on the digest read too');
    const digestRec = digest.records.find((r) => r.id === a.id);
    assert.ok(digestRec, 'the article is in the digest window');
    assert.ok(!('what_it_does' in digestRec!), 'control: the digest projection genuinely ran — the body is gone');
    assert.deepEqual(
      changedOf(digestRec),
      ['src/a.mjs'],
      'the derived verdict survives the projection that drops the bodies — the triage read is exactly where staleness matters'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// STALE2 — an UNCHECKABLE read is reported as unavailability, never as freshness.
// ---------------------------------------------------------------------------
test('STALE2: with nothing baselined to check against, provenance is "unavailable:no_baselines" and NO record is annotated — absence must never read as a freshness claim', () => {
  const { tools, cleanup } = repoHarness();
  try {
    // Decisions own no files, so no baseline exists anywhere in this result set.
    const d1 = tools.knowledgeCreate('decision', { title: 'D1', statement: 'S', alternatives_rejected: [], rationale: 'R' }).record;
    tools.knowledgeCreate('decision', { title: 'D2', statement: 'S', alternatives_rejected: [], rationale: 'R' });

    const env = read(tools, { types: ['decision'] });
    // control assertion, first: the read DID return records, so the verdict below is
    // about uncheckability rather than about an empty result.
    assert.equal(env.records.length, 2, 'the read returned both records — this is not an empty-result artifact');

    assert.notEqual(env.provenance, 'checked', 'a read with nothing to check against must NEVER claim it checked');
    assert.equal(env.provenance, 'unavailable:no_baselines', 'and it names WHY it could not check, specifically');

    for (const rec of env.records) {
      assert.ok(
        !('baseline_drift' in rec),
        'a record that can never be annotated carries NO verdict — an empty verdict on an uncheckable record is exactly the false freshness claim provenance exists to prevent'
      );
    }
    assert.ok(env.records.some((r) => r.id === d1.id), 'sanity: the records really are the ones created');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// STALE2b — the unavailability reasons are DISTINCT, never collapsed into one
// blanket "unknown". A caller must be able to tell WHICH capability was missing.
// ---------------------------------------------------------------------------
test('STALE2b: "no_repo_root" and "count_projection" are reported as their OWN reasons — the four provenance values are distinguishable, never collapsed', () => {
  // (a) no repo root at all: the files cannot even be located, let alone hashed.
  const noRoot = repoHarness({ repoRoot: false });
  try {
    article(noRoot.tools, 'feat-rootless', ['src/a.mjs']);
    const env = read(noRoot.tools, { types: ['feature_article'] });
    assert.ok('provenance' in env, 'provenance is required on EVERY read, including the ones that could not check');
    assert.equal(env.provenance, 'unavailable:no_repo_root', 'no repo root is its own named reason, not a generic unknown');
    assert.notEqual(env.provenance, 'checked', 'and never a freshness claim');
  } finally {
    noRoot.cleanup();
  }

  // (b) a count projection serves no record bodies, so there is nothing to annotate —
  // reported as such rather than silently omitted.
  const counted = repoHarness();
  try {
    const path = join(counted.dir, 'src', 'a.mjs');
    writeAged(path, 'v1');
    article(counted.tools, 'feat-counted', ['src/a.mjs']);
    writeAged(path, 'v2-different'); // genuinely drifted, and still not annotatable in a count

    const env = read(counted.tools, { types: ['feature_article'], projection: 'count' });
    assert.equal(env.provenance, 'unavailable:count_projection', 'a count carries no records, so it carries no verdict — and it says so');
    assert.deepEqual(env.records ?? [], [], 'control: a count projection genuinely served no bodies');
    assert.equal(env.matched_filter, 1, 'and it still answered the question it was asked');
  } finally {
    counted.cleanup();
  }
});

// ---------------------------------------------------------------------------
// STALE3 — `unverifiable[]` is a SEPARATE list from `changed[]`.
// ---------------------------------------------------------------------------
test('STALE3: an owned path with no baseline to compare against is reported in unverifiable[], never in changed[] and never silently as fine', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    const onePath = join(dir, 'src', 'one.ts');
    writeAged(onePath, 'v1');
    // ghost.ts is ABSENT at create, so the article baselines one.ts only.
    const mixed = article(tools, 'feat-mixed', ['src/one.ts', 'src/ghost.ts']);
    const baselines = (mixed as { file_baselines?: Record<string, string> }).file_baselines ?? {};
    assert.ok(baselines['src/one.ts'], 'precondition: one.ts is baselined');
    assert.ok(!baselines['src/ghost.ts'], 'precondition: ghost.ts has NO baseline — nothing to compare a hash against');

    // ghost.ts appears later (the legacy/migration shape). It exists, it is readable,
    // and its verdict is nonetheless UNDETERMINED.
    writeAged(join(dir, 'src', 'ghost.ts'), 'arrived later');

    const env = read(tools, { types: ['feature_article'] });
    // control assertion, first: this read CAN check (one.ts is baselined), so the
    // undetermined verdict below is about the path, not about the whole read.
    assert.equal(env.provenance, 'checked', 'the read is a checking read — the unavailability envelope is not what is speaking here');

    const rec = env.records.find((r) => r.id === mixed.id);
    assert.ok(rec, 'the article is in the window');
    const drift = driftOf(rec);
    assert.ok(drift, 'a record with an undetermined owned path IS annotated — silence would read as "fine"');
    assert.ok(
      (drift!.unverifiable ?? []).includes('src/ghost.ts'),
      'the path whose verdict cannot be determined is named in unverifiable[] — the list that exists so "unknown" is never rendered as "unchanged"'
    );
    assert.ok(
      !(drift!.changed ?? []).includes('src/ghost.ts'),
      'and it is NOT reported as changed — an undetermined path is not a positive drift claim either'
    );
    assert.deepEqual(
      drift!.changed ?? [],
      [],
      'the baselined sibling matched, so nothing is changed here: unverifiable and changed are independent lists, not one flag'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// STALE4 — the two boundary properties: no internals leak, and no second minting
// path. Same drifted fixture as STALE1, so the verdict is unambiguous.
// ---------------------------------------------------------------------------
test('STALE4: the DERIVED verdict is served but the raw file_baselines never are, and the drift annotation mints NO maintenance items (H7 owns invalidation)', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    const path = join(dir, 'src', 'a.mjs');
    writeAged(path, 'v1');
    const a = article(tools, 'feat-a', ['src/a.mjs']);
    // CONTROL, first: the hashes DO exist on the stored record. So their absence from
    // the query projection below is a deliberate STRIP, not an absence of data —
    // without this the "no hashes" assertion could pass on a record that never had any.
    const hash = (a as { file_baselines?: Record<string, string> }).file_baselines?.['src/a.mjs'];
    assert.ok(hash, 'control: knowledge_create records the baseline; knowledge_get stays the full-fidelity read');

    writeAged(path, 'v2-genuinely-different-bytes'); // drifted, mtime still in the past

    for (const projection of [undefined, 'digest'] as const) {
      const env = read(tools, projection ? { types: ['feature_article'], projection } : { types: ['feature_article'] });
      const rec = env.records.find((r) => r.id === a.id);
      assert.ok(rec, `the article is in the ${projection ?? 'full'} window`);
      assert.ok(
        !('file_baselines' in rec!),
        `${projection ?? 'full'} projection: the raw baseline map is stripped — the derived verdict is served, never the internals`
      );
      assert.ok(
        !JSON.stringify(env).includes(hash!),
        `${projection ?? 'full'} projection: the baseline hash appears NOWHERE in the payload, not under any other key`
      );
      assert.ok(changedOf(rec).length > 0, `sanity: the ${projection ?? 'full'} read did compute a verdict — the strip is not "nothing was computed"`);
    }

    // NO SECOND MINTING PATH. In this fixture the mtime pre-filter never fires, so the
    // existing H7/verify_before_use wire enqueues nothing — which makes an empty queue
    // here mean exactly one thing: the derived verdict minted nothing of its own.
    assert.deepEqual(
      tools.boardQuery({ source: 'system' }),
      [],
      'a read-time derived verdict adds NO maintenance items — H7 already owns invalidation, and a duplicate minting path would double the queue for one fact'
    );
  } finally {
    cleanup();
  }
});
