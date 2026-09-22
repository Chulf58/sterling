// ---------------------------------------------------------------------------
// FROZEN PINS — the TOOL-LAYER write-boundary refusal, decision
// `path-claims-are-leaf-or-absent-directory-claims-refused-at-the-tool-write-
// boundary` (knowledge_get 7933e3a8-2c50-40bb-a6f6-0e37c788a43b). This file
// pins the DECISION, never today's tools.ts behaviour: every arm below is
// written from the record's own "CONTRACT" / "WHERE" / "FAIL-CLOSED SHAPES"
// clauses, not from reading tools.ts (H4 forbids it for this role).
//
// SPEC SUMMARY PINNED HERE:
//   - every repo-relative path a knowledge record claims (feature_article
//     files[].path, live_test_refs[].test_paths, decision/anti_pattern/
//     research_finding/todo file_keys[], reference_material.location when
//     repo-located) must be a NON-DIRECTORY LEAF or ABSENT;
//   - the check runs against the FULLY MERGED CANDIDATE, so an update/append/
//     edit of a record already carrying a stale directory claim refuses too,
//     even touching an unrelated field;
//   - no repoRoot -> ADMITTED, receipt carries claims_check:'unavailable:
//     no_repo_root';
//   - EACCES/ELOOP/unreadable component on ONE claim -> REFUSED naming the
//     errno (the asymmetry: an absent CAPABILITY is disclosed, an
//     unclassifiable CLAIM is not admitted);
//   - reads never refuse; computeBaselineDrift gains unverifiable_detail
//     alongside the legacy unverifiable[] string list.
//
// AMBIGUITIES DISCLOSED UP FRONT (not resolved by reading tools.ts — flagged
// per this role's mandate instead):
//   (a) the decision does not specify the EXACT wording of the refusal
//       message beyond "naming the path, the record and the remedy" — every
//       assertion below on message text uses permissive regexes on the path
//       (exact) and loose alternation on "record"/"remedy" phrasing, never a
//       verbatim string;
//   (b) the decision does not specify WHERE `claims_check` lives on each
//       tool's receipt shape. knowledge_update's own established receipt
//       shape (tools.test.ts) returns the record DIRECTLY with no wrapper,
//       while knowledge_create/_append/_edit/board_add all return a wrapper
//       object. This file therefore checks `claims_check` as a SIBLING
//       property on whatever the call already returns (the record itself for
//       update, the wrapper object for the other four) — if the real
//       implementation instead nests it (e.g. under a `receipt` key), these
//       specific assertions are the ones to revisit, not the write-admission
//       behaviour they sit beside;
//   (c) which specific field reference_material's "repo-located" clause
//       means is inferred as `kind !== 'url'` with `location` set to a
//       repo-relative path — the decision does not enumerate reference_material
//       `kind` values it excludes, so this file tests the `doc` kind only.
//
// EXECUTION DISCLOSURE: this agent holds no shell and cannot run these tests;
// the conductor's red/mutation gate executes them. Every arm states its
// EXPECTED FAILURE SHAPE and NAMED SABOTAGE beside it.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-09-06T12:00:00.000Z';

type Loose = Record<string, unknown>;

function repoHarness(opts: { repoRoot?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-directory-claims-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = opts.repoRoot === false ? new SterlingTools({ store, now: () => NOW }) : new SterlingTools({ store, repoRoot: dir, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, tools, cleanup };
}

const isRoot = typeof process.getuid === 'function' && process.getuid!() === 0;

function articleFields(overrides: Loose = {}): Loose {
  return {
    slug: `art-${randomUUID().slice(0, 8)}`,
    title: 'an article',
    what_it_does: 'x',
    intended_behavior: 'x',
    files: [{ path: 'src/a.mjs', role: 'impl' }],
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
    ...overrides,
  };
}

function decisionFields(overrides: Loose = {}): Loose {
  return {
    title: 'a decision',
    statement: 's',
    alternatives_rejected: [],
    rationale: 'r',
    ...overrides,
  };
}

/** A raw feature_article ENVELOPE — bypasses knowledge_create/the write-boundary
 *  check entirely, the only way to construct a record ALREADY carrying a
 *  directory claim (the guard refuses it at every legitimate write). Mirrors
 *  resolves-append-join.test.ts's own `rawArticleEnvelope` field-for-field. */
function rawArticleEnvelope(id: string, filePaths: string[]): Loose {
  return {
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
    slug: `raw-${id.slice(0, 8)}`,
    title: 'raw article',
    what_it_does: 'does',
    intended_behavior: 'b',
    files: filePaths.map((path) => ({ path, role: 'impl' })),
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  };
}

// A generic assertion helper: "the message names this path, and reads as a
// refusal naming a record and a remedy" — loose per ambiguity (a) above.
function assertDirectoryRefusal(err: Error, path: string) {
  assert.match(err.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the refusal names the offending path');
  assert.match(err.message, /director/i, 'names the reason: this is a directory');
  assert.match(err.message, /file|drop|beneath|remove|specific/i, 'names a remedy: name specific files beneath, or drop the claim');
}

// ---------------------------------------------------------------------------
// CONTROL, FIRST: an ABSENT path and a symlink-to-file path are BOTH admitted.
// Without this, every refusal arm below could be explained by an
// implementation that refuses EVERY write with any files[]/file_keys entry,
// which would satisfy every "refuses" assertion for the wrong reason.
// ---------------------------------------------------------------------------

test('CONTROL: an ABSENT claimed path is admitted at knowledge_create — the guard fires on an existing directory only, never on "does not exist yet"', () => {
  const { tools, cleanup } = repoHarness();
  try {
    const { record } = tools.knowledgeCreate('feature_article', articleFields({ files: [{ path: 'src/not-written-yet.mjs', role: 'impl' }] }));
    assert.ok(record, 'an absent path is a legitimate forward-looking claim, admitted without complaint');
  } finally {
    cleanup();
  }
});
// EXPECTED SHAPE TODAY: GREEN — this is already today's behaviour (no
// existing guard refuses absent paths). Placed first so the refusal arms
// below carry evidence: an "always refuse" mutant would fail THIS test.
// SABOTAGE: refuse any files[] entry that does not exist on disk at write
// time -> this control goes red while the real-directory arms below stay
// green for the wrong reason.

// ---------------------------------------------------------------------------
// (1) knowledge_create refuses a feature_article whose files[].path is an
// existing directory.
// ---------------------------------------------------------------------------

test('(1) knowledge_create refuses a feature_article whose files[].path is an existing directory, naming the path, the record and the remedy', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    mkdirSync(join(dir, 'src', 'widgets'));
    assert.throws(
      () => tools.knowledgeCreate('feature_article', articleFields({ files: [{ path: 'src/widgets', role: 'impl' }] })),
      (err: Error) => {
        assertDirectoryRefusal(err, 'src/widgets');
        return true;
      },
      'a directory-shaped files[].path is refused at write, not admitted as a territory claim'
    );
    assert.equal(tools.knowledgeQuery({ types: ['feature_article'] }).length, 0, 'nothing was created by the refused call');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): "Missing expected exception" —
// knowledge_create has no directory-claim guard yet, so the write succeeds.
// SABOTAGE (once built): check only the FIRST files[] entry instead of every
// entry in the fully merged candidate -> undetected here (only one entry) but
// caught by test (5)'s multi-field precondition; SECOND SABOTAGE unique to
// THIS arm: refuse based on a hardcoded path substring ("widgets") instead of
// an actual directory stat -> a differently-named real directory (e.g. this
// arm renamed to "src/gizmos") would then be silently admitted, which the
// CONTROL above cannot catch (it only proves absent paths are NOT refused,
// not that real directories genuinely ARE).

// ---------------------------------------------------------------------------
// (2) the same class of claim, on every OTHER path-bearing field the decision
// enumerates: decision.file_keys, todo.file_keys (user AND system item),
// feature_article.live_test_refs[].test_paths, reference_material.location.
// ---------------------------------------------------------------------------

test('(2a) knowledge_create refuses a decision whose file_keys[] entry is an existing directory', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    mkdirSync(join(dir, 'src', 'decision-dir'));
    assert.throws(
      () => tools.knowledgeCreate('decision', decisionFields({ file_keys: ['src/decision-dir'] })),
      (err: Error) => {
        assertDirectoryRefusal(err, 'src/decision-dir');
        return true;
      },
      'decision.file_keys is under the same leaf-or-absent contract'
    );
    assert.equal(tools.knowledgeQuery({ types: ['decision'] }).length, 0);
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): "Missing expected exception".
// SABOTAGE: implement the guard ONLY for feature_article.files[], forgetting
// the "one enumerator reused by every mutation surface" requirement -> this
// goes red while (1) stays green, proving the enumerator is per-type
// hand-listed rather than shared.

test('(2b) board_add (source: user, a todo) refuses a file_keys[] entry that is an existing directory', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    mkdirSync(join(dir, 'src', 'todo-dir'));
    assert.throws(
      () => tools.boardAdd({ text: 'fix the widget', source: 'user', file_keys: ['src/todo-dir'] }),
      (err: Error) => {
        assertDirectoryRefusal(err, 'src/todo-dir');
        return true;
      },
      'a user todo claiming a directory via file_keys is refused, the same as any other record'
    );
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'nothing was added by the refused call');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): "Missing expected exception".
// SABOTAGE: gate the directory check on record TYPE being one of the
// knowledge_* types only, skipping board_add's todo path entirely (the
// decision explicitly calls out "board AND maintenance items") -> red here
// while (2a)/(1) stay green.

test('(2c) board_add (source: system, a maintenance item) refuses a file_keys[] entry that is an existing directory', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    mkdirSync(join(dir, 'src', 'queue-dir'));
    assert.throws(
      () => tools.boardAdd({ text: 'reconcile the widget', source: 'system', system_reason: 'reconcile_needed', file_keys: ['src/queue-dir'] }),
      (err: Error) => {
        assertDirectoryRefusal(err, 'src/queue-dir');
        return true;
      },
      'a SYSTEM maintenance item claiming a directory via file_keys is refused identically to a user todo'
    );
    assert.equal(tools.boardQuery({ source: 'system' }).length, 0);
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): "Missing expected exception".
// SABOTAGE: apply the guard to source:'user' todos only (matching (2b)) but
// exempt source:'system' maintenance items on the theory that they are
// server-minted -> this arm goes red while (2b) stays green, exposing the
// exemption.

test('(2d) knowledge_create refuses a feature_article whose live_test_refs[].test_paths entry is an existing directory', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    mkdirSync(join(dir, 'src', 'test-dir'));
    assert.throws(
      () =>
        tools.knowledgeCreate(
          'feature_article',
          articleFields({ live_test_refs: [{ ac_id: 'AC1', test_paths: ['src/test-dir'] }] })
        ),
      (err: Error) => {
        assertDirectoryRefusal(err, 'src/test-dir');
        return true;
      },
      'live_test_refs[].test_paths is under the same contract as files[].path'
    );
    assert.equal(tools.knowledgeQuery({ types: ['feature_article'] }).length, 0);
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): "Missing expected exception".
// SABOTAGE: enumerate files[] and file_keys[] but omit live_test_refs from the
// per-type path enumerator -> red here while (1)/(2a) stay green.

test('(2e) knowledge_create refuses a repo-located reference_material whose location is an existing directory', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    mkdirSync(join(dir, 'docs', 'guide'), { recursive: true });
    assert.throws(
      () =>
        tools.knowledgeCreate('reference_material', {
          title: 'a guide',
          kind: 'doc',
          location: 'docs/guide',
          summary: 's',
          source_date: '2026-01-01',
          capture_date: '2026-01-01',
        }),
      (err: Error) => {
        assertDirectoryRefusal(err, 'docs/guide');
        return true;
      },
      'reference_material.location is under the same contract when repo-located'
    );
    assert.equal(tools.knowledgeQuery({ types: ['reference_material'] }).length, 0);
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): "Missing expected exception".
// SABOTAGE: apply the guard to every type EXCEPT reference_material, on the
// mistaken theory that `location` might be a URL and is therefore exempt
// wholesale -> red here (this arm's `kind:'doc'` fixture is unambiguously
// repo-located) while (2a)/(2d) stay green.

// ---------------------------------------------------------------------------
// (3)/(4) already covered by the CONTROL above (absent) and by the symlink
// arm below (a symlink-to-file claim admitted).
// ---------------------------------------------------------------------------

test('(4) a symlink-to-file claim is admitted at knowledge_create — the guard follows the link and refuses only a directory TARGET, matching the classifier oracle', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    writeFileSync(join(dir, 'src', 'real.mjs'), 'x');
    symlinkSync(join(dir, 'src', 'real.mjs'), join(dir, 'src', 'linked.mjs'));
    const { record } = tools.knowledgeCreate('feature_article', articleFields({ files: [{ path: 'src/linked.mjs', role: 'impl' }] }));
    assert.ok(record, 'a symlink whose target is a file is a leaf claim, admitted like any other file');
  } finally {
    cleanup();
  }
});
// EXPECTED SHAPE TODAY: GREEN (no existing guard refuses anything). Once the
// guard exists it must STAY green.
// SABOTAGE: implement the guard via lstat (never resolving symlinks) and
// refuse ANY symlink outright regardless of target -> this goes red while
// arm (1)'s plain-directory refusal stays green — the split that proves the
// guard follows the link rather than blanket-refusing symlinks.

// ---------------------------------------------------------------------------
// (5) update of a record ALREADY carrying a stale directory claim refuses
// even when the changed field is unrelated — the FULLY MERGED CANDIDATE rule.
// ---------------------------------------------------------------------------

test('(5) knowledge_update REFUSES on the MERGED CANDIDATE when the record already carries a stale directory claim, even though the patch touches an unrelated field', () => {
  const { dir, store, tools, cleanup } = repoHarness();
  try {
    mkdirSync(join(dir, 'src', 'stale-dir'));
    const id = randomUUID();
    // Forged directly — the write-boundary guard refuses this shape at every
    // legitimate create, so this precondition is only reachable by bypassing
    // the tool surface entirely, exactly as the decision anticipates
    // ("measured offenders are migrated by hand before activation").
    store.create(rawArticleEnvelope(id, ['src/stale-dir']) as never);
    const before = tools.knowledgeGet(id) as unknown as { version: number };

    assert.throws(
      () => tools.knowledgeUpdate(id, { what_it_does: 'a wholly unrelated change' }),
      (err: Error) => {
        assertDirectoryRefusal(err, 'src/stale-dir');
        return true;
      },
      'the update is refused because the MERGED candidate still carries the stale directory claim, not because the patch introduced one'
    );
    const after = tools.knowledgeGet(id) as unknown as { version: number; what_it_does: string };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
    assert.notEqual(after.what_it_does, 'a wholly unrelated change', 'the unrelated field was never written either — the refusal is on the whole candidate, not a partial write');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): "Missing expected exception" — no guard
// exists, so the unrelated-field update simply succeeds.
// SABOTAGE (once built): check only the FIELDS PRESENT IN THE INCOMING PATCH
// rather than the fully merged candidate (i.e. only re-validate files[] if
// the caller's patch itself touched files[]) -> this is precisely the
// "unrelated update... refuses it too — by design" clause the decision states
// explicitly; that mutation makes this exact arm go red while arm (1) (which
// patches the offending field directly) stays green — the discrimination this
// arm uniquely provides.

// ---------------------------------------------------------------------------
// (5b) a record carrying TWO stale directory claims is repaired ATOMICALLY by
// one knowledge_update supplying the complete corrected leaf-path files[]
// array — assertClaimedPaths validates the FULLY MERGED CANDIDATE, and
// knowledgeUpdate builds that candidate as `{...old, ...overrides}`, so a
// supplied `files` array REPLACES the stale one wholesale BEFORE validation
// (board b0bb9d96, group (b) I-36).
// ---------------------------------------------------------------------------

test('(5b) knowledge_update repairs a record carrying TWO stale directory claims atomically: one update supplying the complete corrected leaf files[] array succeeds, and the stored files[] equals exactly the supplied array', () => {
  const { dir, store, tools, cleanup } = repoHarness();
  try {
    mkdirSync(join(dir, 'src', 'stale-dir-one'));
    mkdirSync(join(dir, 'src', 'stale-dir-two'));
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x');
    const id = randomUUID();
    // Forged directly, same mechanism as test (5) above — the write-boundary
    // guard refuses this shape at every legitimate create/update, so a record
    // already carrying TWO directory claims is only reachable by bypassing the
    // tool surface entirely.
    store.create(rawArticleEnvelope(id, ['src/stale-dir-one', 'src/stale-dir-two', 'src/a.mjs']) as never);
    const before = tools.knowledgeGet(id) as unknown as { version: number };

    const correctedFiles = [{ path: 'src/a.mjs', role: 'impl' }];
    const updated = tools.knowledgeUpdate(id, { files: correctedFiles }, undefined, before.version) as unknown as {
      version: number;
      files: { path: string; role: string }[];
    };

    assert.deepEqual(
      updated.files,
      correctedFiles,
      'the stored files[] equals EXACTLY the supplied leaf array — no directory entry survives and nothing merged back in'
    );
    assert.equal(updated.version, before.version + 1, 'the version advanced by exactly one');

    const after = tools.knowledgeGet(id) as unknown as { files: { path: string; role: string }[]; version: number };
    assert.deepEqual(after.files, correctedFiles, 're-reading the record confirms the same repaired array was actually persisted');
    assert.equal(after.version, before.version + 1);
  } finally {
    cleanup();
  }
});
// EXPECTED SHAPE TODAY: GREEN per the claim above — assertClaimedPaths
// validates the merged candidate `next = {...old, ...overrides}` (tools.ts,
// symbol assertClaimedPaths / knowledgeUpdate), and a caller-supplied `files`
// array is a whole-field override, so the stale directory entries are gone
// from the candidate BEFORE the guard ever runs. If this test is instead RED,
// the merge-then-validate claim in board b0bb9d96 group (b) I-36 is false.
// SABOTAGE: merge `files[]` by path union with the OLD array instead of a
// whole-field replace -> the stale directory entries would survive in the
// candidate and this call would wrongly refuse, going red while test (5)
// (which never touches files[]) stays green.

test('(5c) with the SAME two-directory-claim seed, knowledge_array_remove of ONE directory claim is still refused, naming the OTHER surviving directory path — incremental repair stays refused while a full-array replace succeeds', () => {
  const { dir, store, tools, cleanup } = repoHarness();
  try {
    mkdirSync(join(dir, 'src', 'stale-dir-one'));
    mkdirSync(join(dir, 'src', 'stale-dir-two'));
    const id = randomUUID();
    store.create(rawArticleEnvelope(id, ['src/stale-dir-one', 'src/stale-dir-two']) as never);
    const before = tools.knowledgeGet(id) as unknown as { version: number };

    assert.throws(
      () => tools.knowledgeArrayRemove(id, 'files[path=src/stale-dir-one]', before.version),
      (err: Error) => {
        assertDirectoryRefusal(err, 'src/stale-dir-two');
        return true;
      },
      'removing one directory claim still leaves the OTHER in the merged candidate, so the removal is refused rather than admitted as a partial repair'
    );
    const after = tools.knowledgeGet(id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused removal — this is policy, not a bug: incremental removal stays refused while another directory claim survives');
  } finally {
    cleanup();
  }
});
// EXPECTED SHAPE TODAY: this call reaches assertClaimedPaths the same way
// knowledge_update's merged-candidate check does (knowledgeArrayRemove
// delegates through the same knowledgeUpdate merge path), so the SURVIVING
// stale-dir-two claim refuses the write exactly like test (5)'s unrelated-
// field case. SABOTAGE: validate array_remove's candidate against only the
// REMOVED element rather than the fully merged remainder -> this call would
// wrongly succeed, going red while (5b) (which supplies a fully clean array)
// still passes for an unrelated reason.

// ---------------------------------------------------------------------------
// (6) knowledge_append to files[] with a directory path refuses.
// ---------------------------------------------------------------------------

test('(6) knowledge_append to files[] with a directory-shaped entry refuses', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    const { record } = tools.knowledgeCreate('feature_article', articleFields());
    mkdirSync(join(dir, 'src', 'appended-dir'));
    const before = tools.knowledgeGet(record.id as string) as unknown as { version: number };

    assert.throws(
      () => tools.knowledgeAppend(record.id as string, 'files', [{ path: 'src/appended-dir', role: 'impl' }]),
      (err: Error) => {
        assertDirectoryRefusal(err, 'src/appended-dir');
        return true;
      },
      'an appended directory-shaped files[] entry is refused, same as at create'
    );
    const after = tools.knowledgeGet(record.id as string) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused append');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): "Missing expected exception".
// SABOTAGE: validate directory claims only on knowledge_create and
// knowledge_update, omitting knowledge_append from the shared check ->
// red here while (1)/(5) stay green.

// ---------------------------------------------------------------------------
// (7) knowledge_edit of files[path=…].path to a directory path refuses.
// ---------------------------------------------------------------------------

test('(7) knowledge_edit that rewrites files[path=…].path INTO a directory-shaped value refuses', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    const { record } = tools.knowledgeCreate('feature_article', articleFields({ files: [{ path: 'src/a.mjs', role: 'impl' }] }));
    mkdirSync(join(dir, 'src', 'edited-dir'));
    const before = tools.knowledgeGet(record.id as string) as unknown as { version: number };

    assert.throws(
      () => tools.knowledgeEdit(record.id as string, 'files[path=src/a.mjs].path', 'src/a.mjs', 'src/edited-dir'),
      (err: Error) => {
        assertDirectoryRefusal(err, 'src/edited-dir');
        return true;
      },
      'an edit that rewrites a files[] path into a directory is refused on the RESULT of the edit, not admitted because the edit itself is a string replace'
    );
    const after = tools.knowledgeGet(record.id as string) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused edit');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): "Missing expected exception".
// SABOTAGE: validate the field.replace() OUTPUT only for whole-field edits
// (e.g. `what_it_does`) but skip re-validation for the array-element-selector
// edit form (`files[path=…].path`) on the theory it is a "different code
// path" -> red here while (1)/(6) stay green.

// ---------------------------------------------------------------------------
// (8) knowledge_extract new_record with a directory claim refuses.
// ---------------------------------------------------------------------------

test('(8) knowledge_extract refuses when new_record.fields carries a directory-shaped file_keys entry', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    const find = 'the extractable clause';
    const source = tools.knowledgeCreate(
      'decision',
      decisionFields({ statement: `Context before. ${find}. Context after.` })
    ).record as unknown as Loose;
    mkdirSync(join(dir, 'src', 'extract-dir'));

    type ExtractCapable = { knowledgeExtract(input: Loose): unknown };
    const runExtract = (input: Loose): unknown => (tools as unknown as ExtractCapable).knowledgeExtract(input);

    assert.throws(
      () =>
        runExtract({
          id: source.id,
          field: 'statement',
          find,
          new_record: { type: 'decision', fields: decisionFields({ title: 'extracted', file_keys: ['src/extract-dir'] }) },
        }),
      (err: Error) => {
        assertDirectoryRefusal(err, 'src/extract-dir');
        return true;
      },
      'a directory-shaped claim inside new_record.fields is refused — extract is creation-shaped for that record, and creation is under the same contract'
    );

    const afterSource = tools.knowledgeGet(source.id as string) as unknown as Loose;
    assert.equal(afterSource.statement, source.statement, 'the source is untouched — the whole extract rolled back, not just the new-record half');
    assert.equal(tools.knowledgeQuery({ types: ['decision'], cap: 1000 }).length, 1, 'no extracted record was created');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): "Missing expected exception" if
// knowledgeExtract exists and ignores the directory shape; if knowledgeExtract
// itself does not exist yet on this build, the call throws
// `TypeError: tools.knowledgeExtract is not a function` instead, and
// `assert.throws(..., predicateFn)` DOES accept that as a thrown error but
// the predicate's `assertDirectoryRefusal` check then fails on that message
// text — red on the predicate either way, never a silent pass.
// SABOTAGE: validate new_record.fields' path-bearing fields against the
// CURRENT record types' create guard but skip it specifically for extract's
// synthesized creation (treating it as "not really a knowledge_create call")
// -> red here while (2a) stays green.

// ---------------------------------------------------------------------------
// (9) no repoRoot -> write ADMITTED, receipt carries
// claims_check:'unavailable:no_repo_root' — asserted on create, update,
// append, edit and board_add.
// ---------------------------------------------------------------------------

test('(9) with NO repoRoot, a directory-shaped claim is ADMITTED on every one of create/update/append/edit/board_add, and each receipt carries claims_check:"unavailable:no_repo_root"', () => {
  const h = repoHarness({ repoRoot: false });
  try {
    // create — directory-shaped path is meaningless without a repo root to
    // resolve it against, so the capability is simply absent, disclosed.
    const created = h.tools.knowledgeCreate('feature_article', articleFields({ files: [{ path: 'src/anything', role: 'impl' }] })) as unknown as Loose;
    assert.ok(created.record, 'the create is admitted with no repo root — there is nothing to classify against');
    assert.equal(created.claims_check, 'unavailable:no_repo_root', 'the create receipt discloses the capability is absent, per the shared disclosure shape the drift provenance also uses');

    const id = (created.record as Loose).id as string;

    // update
    const updated = h.tools.knowledgeUpdate(id, { what_it_does: 'changed with no repo root' }) as unknown as Loose;
    assert.equal(updated.claims_check, 'unavailable:no_repo_root', 'knowledge_update receipt discloses the same absence');

    // append
    const appended = h.tools.knowledgeAppend(id, 'history', [{ date: NOW, event: 'appended with no repo root' }]) as unknown as Loose;
    assert.equal(appended.claims_check, 'unavailable:no_repo_root', 'knowledge_append receipt discloses the same absence');

    // edit
    const edited = h.tools.knowledgeEdit(id, 'what_it_does', 'changed with no repo root', 'edited with no repo root') as unknown as Loose;
    assert.equal(edited.claims_check, 'unavailable:no_repo_root', 'knowledge_edit receipt discloses the same absence');

    // board_add
    const added = h.tools.boardAdd({ text: 'do a thing', source: 'user', file_keys: ['src/anything-else'] }) as unknown as Loose;
    assert.equal(added.claims_check, 'unavailable:no_repo_root', 'board_add receipt discloses the same absence');
  } finally {
    h.cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): none of these receipts carry a
// `claims_check` property at all today, so every `assert.equal(..., 'unavail
// able:no_repo_root')` fails with `undefined !== 'unavailable:no_repo_root'`
// — an assertion failure, not a crash, on each of the five checks in turn.
// AMBIGUITY (disclosed, see file header note b): `knowledge_update`'s
// established receipt shape returns the record directly with no wrapper, so
// this test reads `claims_check` as a SIBLING property of the returned
// object rather than nested under a `record`/`receipt` key. If the real
// shape differs, THIS assertion (not the admission behaviour) is what needs
// revisiting.
// SABOTAGE: disclose `claims_check` on knowledge_create only, since it is the
// "obvious" write, and omit it from update/append/edit/board_add -> the
// create assertion stays green while the other four go red one at a time —
// proving the disclosure is not uniformly wired across every write receipt
// the decision names.

// ---------------------------------------------------------------------------
// (10) EACCES on one claim -> REFUSED naming the errno.
// ---------------------------------------------------------------------------

test('(10) a claim behind an unreadable ancestor directory (EACCES) is REFUSED, naming the errno — an unclassifiable claim is not silently admitted as absent', { skip: isRoot ? 'running as root: permission bits do not restrict root, EACCES is unreachable' : false }, () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    mkdirSync(join(dir, 'src', 'blocked'));
    writeFileSync(join(dir, 'src', 'blocked', 'secret.mjs'), 'x');
    chmodSync(join(dir, 'src', 'blocked'), 0o000);
    try {
      assert.throws(
        () => tools.knowledgeCreate('feature_article', articleFields({ files: [{ path: 'src/blocked/secret.mjs', role: 'impl' }] })),
        (err: Error) => {
          assert.match(err.message, /src\/blocked\/secret\.mjs/, 'names the offending path');
          assert.match(err.message, /EACCES/, 'names the specific errno — the asymmetry with the no-repo-root case: this capability EXISTS but this one claim could not be classified');
          return true;
        },
        'an unclassifiable claim is refused, not silently treated as absent'
      );
      assert.equal(tools.knowledgeQuery({ types: ['feature_article'] }).length, 0, 'nothing was created by the refused call');
    } finally {
      chmodSync(join(dir, 'src', 'blocked'), 0o700);
    }
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): "Missing expected exception" — no guard
// exists yet, so the EACCES is never even encountered (nothing stats the
// claimed path at write time today).
// SABOTAGE: catch the stat error internally and fall back to treating an
// unclassifiable claim as 'absent' (admit it) rather than refusing -> "Missing
// expected exception" here while the CONTROL absent-path arm stays green for
// an unrelated reason — exactly the confusion the decision's asymmetry
// clause exists to prevent.

// ---------------------------------------------------------------------------
// (11) computeBaselineDrift / knowledge_query annotation: a claim that BECOMES
// a directory after write reports unverifiable + unverifiable_detail; reads
// never refuse.
// ---------------------------------------------------------------------------

test('(11) a claim that was a LEAF at write and becomes a directory afterward is reported via knowledge_query as unverifiable, with unverifiable_detail naming {path, reason:"directory"} — and the read itself never refuses', () => {
  const { dir, tools, cleanup } = repoHarness();
  try {
    const filePath = join(dir, 'src', 'a.mjs');
    writeFileSync(filePath, 'v1');
    const { record } = tools.knowledgeCreate('feature_article', articleFields({ files: [{ path: 'src/a.mjs', role: 'impl' }] }));
    assert.ok((record as unknown as { file_baselines?: Loose }).file_baselines?.['src/a.mjs'], 'precondition: a baseline was recorded while the claim was still a genuine leaf');

    // The claim MUTATES into a directory after write — the read-time report
    // path, never re-checked at write time until the NEXT write.
    rmSync(filePath);
    mkdirSync(filePath);

    // The read itself must never throw.
    const env = tools.knowledgeQueryResult({ types: ['feature_article'] }) as unknown as {
      records: (Loose & { baseline_drift?: { changed?: string[]; unverifiable?: string[]; unverifiable_detail?: { path: string; reason: string }[] } })[];
    };
    const rec = env.records.find((r) => r.id === record.id);
    assert.ok(rec, 'the read succeeded and returned the record — reads never refuse on a claim that has drifted into a directory');

    const drift = rec!.baseline_drift;
    assert.ok(drift, 'a claim whose verdict cannot be determined is annotated, not silently omitted');
    assert.ok((drift!.unverifiable ?? []).includes('src/a.mjs'), 'the LEGACY unverifiable[] string list still names the path — read-side compatibility is preserved');
    assert.ok(Array.isArray(drift!.unverifiable_detail), 'the NEW typed detail array exists');
    assert.ok(
      drift!.unverifiable_detail!.some((d) => d.path === 'src/a.mjs' && d.reason === 'directory'),
      'the typed detail names the SAME path with reason "directory" — a reader can now tell WHY without re-deriving it'
    );
    assert.ok(!(drift!.changed ?? []).includes('src/a.mjs'), 'a directory-shaped claim is not reported as merely "changed" — it is a different failure class entirely');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): the `unverifiable_detail` array does not
// exist on the drift annotation at all today (only the legacy `unverifiable`
// string[] does, per knowledge-query-baseline-drift.test.ts's STALE3 arm) —
// `Array.isArray(undefined)` is false, failing that assertion. If the legacy
// `unverifiable[]` string entry ALSO does not yet include a directory-shaped
// path today (only "no baseline to compare against" paths, per STALE3), the
// preceding assertion fails first instead — either is the correct RED for
// this new annotation shape.
// SABOTAGE: report a directory-shaped claim in `changed[]` instead of
// `unverifiable[]` (treating "it changed to a directory" as ordinary content
// drift) -> the `changed` exclusion assertion goes red while the earlier
// `unverifiable` assertion might stay green if BOTH lists happen to include
// it — which is exactly why both are checked independently rather than
// inferring one from the other.
