// Layer 1 — STORE-TO-HOOK CONFORMANCE AUDIT (board a6b118e4, objective
// knowledge-delivery-oracle). These tests pin the ORACLE'S OWN behaviour: the
// thing that derives what delivery SHOULD have happened from the store, drives
// the hook bundles with synthetic payloads, and scores what came back. They do
// NOT re-test H19/H20/H23/H10 themselves — those have their own frozen suites
// (h19-delivery, h19-drain-claim-safety, h20-deny-once, h23-output-axis, …).
//
// Written blind, from board a6b118e4's nine numbered mechanism points plus
// decisions 1a5b91ae (Bash pointers always queue), db3392db (drain re-resolve),
// 6f3e334c (hazards as substance / decisions as capped pointers) and
// anti_pattern 1b141d1f (a deduping notifier's SILENCE is multiply-caused —
// which is exactly why every verdict group below opens with a control arm).
//
// ===========================================================================
// THE CONTRACT — scripts/delivery-oracle.mjs must export exactly these.
// ===========================================================================
//
//   deriveExpected(store, { repoRoot }) -> Entry[]
//     Entry is a Case or an Exclusion.
//     Case = {
//       kind: 'case',
//       fixture_id: string,               // stable, derived from hook+payload_kind+rel
//       hook: string,                     // BUNDLE basename, e.g. 'h19-knowledge-delivery.mjs'
//       payload_kind: 'file_touch'|'bash'|'h10_ownership'|'agent'|'ask'|'consult'|'output_axis',
//       rel: string|null,                 // repo-relative POSIX path
//       expected: { owners: string[], hazards: string[], rationale: string[] },
//       expected_ids: string[],           // deduped union of the three above
//       gitignore_check: 'checked'|'unavailable',
//       event?: string, tool?: string,    // optional payload overrides
//     }
//     Exclusion = { kind:'exclusion', rel: string, record_id: string|null,
//                   reason: 'gitignored'|'working_tree_article' }
//
//   synthesizePayload(caseOrProbe, { cwd, agent_id, session_id })
//       -> { stdin: object, sandbox_writes: {rel, json}[] }
//     (the brief says "-> stdin JSON"; H10 takes its touched set from DISK, not
//      from stdin, so the return carries the sandbox side-effects beside it.)
//
//   parseDelivery(hookResult, sandboxDir)
//       -> { rendered_ids, queued_ids, queued_by_kind, exit_code, channel,
//            denied, denied_ids, harness_error? }
//
//   runIdentity({ snapshotDigest, bundleHash, rung, oracleVersion }) -> string
//   caseIdentity(caseObj) -> string
//   compareRuns(prev, next) -> { pass_to_miss, miss_to_pass, expectation_changed }
//   metrics(cases) -> { per_hook: { [hook]: {eligible_recall, rendered_recall,
//                       eventual_recall, drained_recall, precision} } }
//   resetSandbox(sandboxDir, caseObj) -> { removed: boolean }
//   loadProbes(dir) -> Probe[]            (throws, naming the file, on a bad probe)
//   auditDir(projectRoot) -> string
//   writeRunReport(projectRoot, report) -> { run_path, history_path }
//
// AMBIGUITIES RESOLVED HERE (flagged in the handoff, not silently decided):
//  - synthesizePayload's return shape (above) — H10 has no stdin touch field.
//  - the run-report FILENAME: the spec says `<iso>-<identity>.json`, but a raw
//    ISO string contains ':' which is illegal in a Windows filename and the
//    Windows/Linux parity requirement is standing. Pinned: no ':' in the
//    basename, still lexicographically sortable by time.
//  - metrics denominators are stated per assertion below; division by zero is
//    null, never NaN and never 0 (0 reads as "measured, and it was terrible").
//  - loadProbes accepts a human `note` field (a frozen probe explains itself);
//    it refuses expect_deny:true with no expect_deny_ids (an unfalsifiable
//    deny expectation is worse than none).
//  - metrics/compareRuns treat a case as PASSED when rendered || drained.
//
// Every pin below carries a one-line SABOTAGE comment: the single-line change
// to scripts/delivery-oracle.mjs that must turn that test red. A pin whose
// sabotage leaves it green is hollow and must be rewritten, not accepted.
//
// Tests are kept SMALL on purpose: anti_pattern f1d66bef — an early assertion
// failure aborts its test and hides every later assertion in the same body.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORACLE = join(root, 'scripts', 'delivery-oracle.mjs');
const PROBE_DIR = join(root, 'scripts', 'tests', 'fixtures', 'delivery-probes');
const NOW = '2026-09-05T12:00:00.000Z';

// The oracle is imported LAZILY and its failure recorded, so a missing module
// fails each test ON ITS ASSERTION with a readable message instead of crashing
// the file at load (a crash-red proves nothing about the specification).
let oracle = null;
let loadError = null;
let SterlingStore = null;
before(async () => {
  try {
    oracle = await import(pathToFileURL(ORACLE).href);
  } catch (e) {
    loadError = e;
  }
  try {
    ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  } catch { /* pinned by the fixture builder's own assert */ }
});

function fn(name) {
  assert.ok(oracle, `scripts/delivery-oracle.mjs must load — import failed: ${loadError && loadError.message}`);
  assert.equal(typeof oracle[name], 'function', `scripts/delivery-oracle.mjs must export ${name}()`);
  return oracle[name];
}

const sorted = (a) => [...(a ?? [])].sort();
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// --------------------------------------------------------------------------
// Fixture repo: 2 articles owning 3 files (one SHARED) + a decision and an
// anti_pattern by file_keys + a reference_material at a repo location + a
// working_tree-marked article + a gitignored owned path + an UNGOVERNED path.
// --------------------------------------------------------------------------

const CONFIG = {
  delivery: { injection_rung: 'prompt', payload_char_cap: 2400 },
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000 } },
};

function envelope(type) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function articleRecord(slug, paths, extra = {}) {
  return {
    ...envelope('feature_article'),
    slug,
    title: slug,
    what_it_does: `${slug} does the ${slug} thing`,
    intended_behavior: `${slug} intends`,
    files: paths.map((p) => ({ path: p, role: 'owner' })),
    current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    history: [{ date: NOW, event: 'fixture' }],
    live_test_refs: [],
    ...extra,
  };
}

function git(dir, args) {
  return spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
}

function makeFixtureRepo({ withGit = true } = {}) {
  assert.ok(SterlingStore, 'packages/store/dist must be built for the oracle fixture (npm run build)');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  for (const sub of ['src', 'docs', 'build', 'wt']) mkdirSync(join(dir, sub), { recursive: true });
  const files = ['src/shared.mjs', 'src/alpha-only.mjs', 'src/beta-only.mjs', 'src/ungoverned.mjs', 'docs/notes.md', 'build/generated.mjs', 'build/unowned-ignored.mjs', 'wt/copy.mjs'];
  for (const rel of files) writeFileSync(join(dir, rel), `// ${rel}\n`);
  writeFileSync(join(dir, '.gitignore'), 'build/\n');
  if (withGit) {
    const init = git(dir, ['init', '-q']);
    assert.equal(init.status, 0, 'git is required to build the oracle fixture (check-ignore is part of the predicate)');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'fixture']);
  }
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  // alpha also owns the GITIGNORED path, so the exclusion has something to bite on.
  const alpha = store.create(articleRecord('alpha', ['src/shared.mjs', 'src/alpha-only.mjs', 'build/generated.mjs']));
  const beta = store.create(articleRecord('beta', ['src/shared.mjs', 'src/beta-only.mjs']));
  const gamma = store.create(articleRecord('gamma', ['wt/copy.mjs'], { working_tree: 'wt-copy' }));
  const hazard = store.create({
    ...envelope('anti_pattern'),
    title: 'shared-file hazard',
    trigger: 'shared-file hazard trigger',
    guidance: 'shared-file hazard guidance',
    wrong_way: 'shared-file hazard wrong way',
    right_way: 'shared-file hazard right way',
    source_evidence: 'fixture',
    basis: 'codebase',
    severity: 'warn',
    file_keys: ['src/shared.mjs'],
  });
  const rationale = store.create({
    ...envelope('decision'),
    title: 'shared-file decision',
    statement: 'shared-file decision statement',
    alternatives_rejected: [],
    rationale: 'shared-file decision rationale',
    file_keys: ['src/shared.mjs'],
  });
  const reference = store.create({
    ...envelope('reference_material'),
    title: 'Design notes',
    kind: 'doc',
    location: 'docs/notes.md',
    summary: 'notes about things',
    source_date: '2026-07-01',
    capture_date: '2026-07-01',
  });
  const cleanup = () => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, ids: { alpha: alpha.id, beta: beta.id, gamma: gamma.id, hazard: hazard.id, rationale: rationale.id, reference: reference.id }, cleanup };
}

const casesFor = (entries, rel) => entries.filter((e) => e.kind === 'case' && e.rel === rel);
const caseFor = (entries, rel, hook) => entries.find((e) => e.kind === 'case' && e.rel === rel && e.hook === hook);
const exclusionFor = (entries, rel) => entries.find((e) => e.kind === 'exclusion' && e.rel === rel);

// ===========================================================================
// GROUP A — deriveExpected: the store-side half of the oracle.
// ===========================================================================

// CONTROL ARM, FIRST: a "case exists for the owned path" verdict has two
// possible causes — ownership resolution, or an enumerator that emits a case
// for every path it walks. This arm must pass for the OPPOSITE reason (an
// ungoverned path present in the fixture yields NOTHING), so every A-test
// below carries its own evidence.
test('A0 CONTROL: an ungoverned path in the same fixture yields no case at all, while an owned path does', () => {
  // SABOTAGE: emit a case for every enumerated path regardless of owner matches.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeFixtureRepo();
  try {
    const entries = deriveExpected(store, { repoRoot: dir });
    assert.equal(casesFor(entries, 'src/ungoverned.mjs').length, 0, 'an ungoverned path is not an expectation');
    assert.ok(casesFor(entries, 'src/shared.mjs').length > 0, 'an owned path is');
  } finally {
    cleanup();
  }
});

test('A1: a SHARED owned path names EXACTLY its two owners — not the first one, not every article in the store', () => {
  // SABOTAGE: return owners[0] instead of the whole owner set.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, ids, cleanup } = makeFixtureRepo();
  try {
    const entries = deriveExpected(store, { repoRoot: dir });
    const c = caseFor(entries, 'src/shared.mjs', 'h19-knowledge-delivery.mjs');
    assert.ok(c, 'the shared path gets an H19 file-touch case');
    assert.deepEqual(sorted(c.expected.owners), sorted([ids.alpha, ids.beta]));
  } finally {
    cleanup();
  }
});

test('A1b: a singly-owned path names only its own owner', () => {
  // SABOTAGE: union every article that shares ANY file with an owner (transitive ownership).
  const deriveExpected = fn('deriveExpected');
  const { dir, store, ids, cleanup } = makeFixtureRepo();
  try {
    const entries = deriveExpected(store, { repoRoot: dir });
    const c = caseFor(entries, 'src/beta-only.mjs', 'h19-knowledge-delivery.mjs');
    assert.deepEqual(sorted(c.expected.owners), [ids.beta]);
  } finally {
    cleanup();
  }
});

test('A2: an anti_pattern and a decision whose file_keys name the path become HAZARD and RATIONALE expectations (the ca23c811 regression)', () => {
  // SABOTAGE: restrict the expectation query to types ['feature_article','reference_material'].
  const deriveExpected = fn('deriveExpected');
  const { dir, store, ids, cleanup } = makeFixtureRepo();
  try {
    const c = caseFor(deriveExpected(store, { repoRoot: dir }), 'src/shared.mjs', 'h19-knowledge-delivery.mjs');
    assert.deepEqual(sorted(c.expected.hazards), [ids.hazard], 'anti_pattern -> hazards');
    assert.deepEqual(sorted(c.expected.rationale), [ids.rationale], 'decision -> rationale');
  } finally {
    cleanup();
  }
});

test('A2b: hazards and rationale are NOT counted as owners — a hazard never confers ownership (decision 6f3e334c)', () => {
  // SABOTAGE: push the hazard/decision ids into expected.owners as well.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, ids, cleanup } = makeFixtureRepo();
  try {
    const c = caseFor(deriveExpected(store, { repoRoot: dir }), 'src/shared.mjs', 'h19-knowledge-delivery.mjs');
    assert.ok(!c.expected.owners.includes(ids.hazard), 'anti_pattern is not an owner');
    assert.ok(!c.expected.owners.includes(ids.rationale), 'decision is not an owner');
  } finally {
    cleanup();
  }
});

test('A2c: expected_ids is the deduped union of owners + hazards + rationale', () => {
  // SABOTAGE: set expected_ids = expected.owners only.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeFixtureRepo();
  try {
    const c = caseFor(deriveExpected(store, { repoRoot: dir }), 'src/shared.mjs', 'h19-knowledge-delivery.mjs');
    const union = new Set([...c.expected.owners, ...c.expected.hazards, ...c.expected.rationale]);
    assert.deepEqual(sorted(c.expected_ids), sorted([...union]));
    assert.equal(c.expected_ids.length, new Set(c.expected_ids).size, 'no duplicates');
  } finally {
    cleanup();
  }
});

test('A3: a repo-located reference_material owns its location path (owner, not hazard)', () => {
  // SABOTAGE: drop 'reference_material' from the owner types.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, ids, cleanup } = makeFixtureRepo();
  try {
    const c = caseFor(deriveExpected(store, { repoRoot: dir }), 'docs/notes.md', 'h19-knowledge-delivery.mjs');
    assert.ok(c, 'docs/notes.md is governed by its reference_material location');
    assert.deepEqual(sorted(c.expected.owners), [ids.reference]);
  } finally {
    cleanup();
  }
});

test('A4: a working_tree-marked article is EXCLUDED with that named reason, and produces no case', () => {
  // SABOTAGE: delete the `.filter(a => !a.working_tree)` on the owner set.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, ids, cleanup } = makeFixtureRepo();
  try {
    const entries = deriveExpected(store, { repoRoot: dir });
    const x = exclusionFor(entries, 'wt/copy.mjs');
    assert.ok(x, 'the working-tree path is accounted for, not silently dropped');
    assert.equal(x.reason, 'working_tree_article');
    assert.equal(x.record_id, ids.gamma);
    assert.equal(casesFor(entries, 'wt/copy.mjs').length, 0);
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// A5 / A5b / A5c — RE-CUT (decision 77c5b85a: re-cut discipline). Board
// a6b118e4 objective knowledge-delivery-oracle; PREMISE overturned by an
// outside-family (Codex) review reading the hook sources directly.
//
// OLD PREMISE (WRONG): gitignored paths are excluded from every case before
// generation — an ignored owned path produced only an
// {kind:'exclusion', reason:'gitignored'} and no case at all.
//
// NEW PREMISE (mirrors each hook's OWN predicate — never an independent
// "exclude everything ignored" rule): scripts/hooks/h19-knowledge-delivery.mjs
// applies its gitIgnored check ONLY to the unowned-FRONTIER decision
// (~line 115) — it still resolves and delivers owners/hazards/decisions for
// an ignored path that a record claims. scripts/hooks/h19-bash-delivery.mjs
// performs NO ignore check AT ALL (~line 81) — the Bash pointer surface is
// never gated by gitignore. An oracle that excludes ignored paths wholesale
// therefore generated NO case for exactly the territory where those two
// hooks can silently regress (an ignored owned path stops delivering its
// owners/hazards and nobody notices, because the oracle never asked).
//
// CLAIM (three arms, one per pin):
//   A5  — an ignored OWNED path still produces the ordinary
//         h19-knowledge-delivery.mjs CASE naming its real owner, identical
//         in shape to a non-ignored sibling path owned by the same article
//         (the CONTROL) — and is never recorded as an exclusion at all.
//   A5b — that same ignored OWNED path ALSO produces the h19-bash-delivery.mjs
//         CASE (decision 1a5b91ae is unconditional; that hook has no ignore
//         check to trigger), and gitignore_check still reads 'checked' — the
//         check ran and found it ignored, that fact is RECORDED, it does not
//         SUPPRESS delivery.
//   A5c — gitignore suppression stays scoped to the FRONTIER arm: an ignored
//         UNOWNED path still yields no owner-delivery case for any hook (an
//         unowned path never gets one, ignored or not — A0's rule already
//         covers this), and the frontier-suppression exclusion the oracle
//         records for it is scoped to that path alone (reason 'gitignored',
//         record_id null) — it must never appear for the OWNED ignored path.
// --------------------------------------------------------------------------

test('A5: a gitignored OWNED path still produces the H19 knowledge-delivery case, naming the same owner an equivalent non-ignored path would', () => {
  // SABOTAGE: keep the old short-circuit — `if (gitIgnored(rel)) return exclusion`
  // BEFORE owner resolution. This must now go RED: today's implementation excludes
  // build/generated.mjs entirely instead of delivering alpha's ownership.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, ids, cleanup } = makeFixtureRepo();
  try {
    const entries = deriveExpected(store, { repoRoot: dir });
    const ignored = caseFor(entries, 'build/generated.mjs', 'h19-knowledge-delivery.mjs');
    const control = caseFor(entries, 'src/alpha-only.mjs', 'h19-knowledge-delivery.mjs'); // CONTROL: non-ignored, same owner
    assert.ok(ignored, 'an ignored OWNED path still gets a knowledge-delivery case — gitignore does not suppress owner delivery');
    assert.ok(control, 'control: the non-ignored sibling path gets one too');
    assert.deepEqual(sorted(ignored.expected.owners), [ids.alpha]);
    assert.deepEqual(ignored.expected.hazards, [], 'no hazard targets this path — the fixture is not muddying the arm being tested');
    assert.deepEqual(ignored.expected.rationale, [], 'no decision targets this path either');
    assert.deepEqual(sorted(ignored.expected.owners), sorted(control.expected.owners), 'ignored-ness changes nothing about WHO owns the path');
    assert.equal(exclusionFor(entries, 'build/generated.mjs'), undefined, 'an owned path is never recorded as excluded — exclusion is a frontier-only concept now');
  } finally {
    cleanup();
  }
});

test('A5b: the ignored owned path ALSO gets its h19-bash-delivery case (decision 1a5b91ae) — that hook has no ignore check to trigger, and the case still reports gitignore_check "checked"', () => {
  // SABOTAGE: gate h19-bash-delivery.mjs's case derivation on the same (now-removed)
  // gitIgnored short-circuit used for knowledge-delivery. This must go RED, because
  // the real hook (scripts/hooks/h19-bash-delivery.mjs) performs no ignore check at all
  // — the oracle's bash arm must never depend on the knowledge-delivery arm's gate.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, ids, cleanup } = makeFixtureRepo();
  try {
    const entries = deriveExpected(store, { repoRoot: dir });
    const c = caseFor(entries, 'build/generated.mjs', 'h19-bash-delivery.mjs');
    assert.ok(c, 'the Bash pointer surface is audited for the ignored path too — decision 1a5b91ae is unconditional');
    assert.equal(c.payload_kind, 'bash');
    assert.deepEqual(sorted(c.expected.owners), [ids.alpha]);
    assert.equal(c.gitignore_check, 'checked', 'the check ran and found it ignored — that fact is recorded, it does not suppress delivery');
    // CONTROL, carried over from the pre-re-cut A5b: a plain non-ignored owned path is
    // ALSO marked 'checked' — 'checked' means "the check ran", never "and excluded it".
    const nonIgnored = caseFor(entries, 'src/shared.mjs', 'h19-knowledge-delivery.mjs');
    assert.equal(nonIgnored.gitignore_check, 'checked');
  } finally {
    cleanup();
  }
});

test('A5c: gitignore suppression stays scoped to the FRONTIER arm — an ignored UNOWNED path still yields no owner-delivery case, and its suppression-exclusion never leaks onto an owned path', () => {
  // SABOTAGE: skip the git check-ignore call and treat every path as tracked. Under the
  // FIXED oracle this must redden ONLY this frontier-scoped assertion (no exclusion
  // minted for build/unowned-ignored.mjs, since it is never detected as ignored) —
  // A5's and A5b's owner-delivery assertions above must stay GREEN under the identical
  // sabotage, because owner delivery no longer depends on the ignore check at all.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeFixtureRepo();
  try {
    const entries = deriveExpected(store, { repoRoot: dir });
    assert.equal(casesFor(entries, 'build/unowned-ignored.mjs').length, 0, 'an unowned path never gets an owner-delivery case, ignored or not (A0\'s rule)');
    const x = exclusionFor(entries, 'build/unowned-ignored.mjs');
    assert.ok(x, 'the frontier-suppression is accounted for by name, not silently dropped');
    assert.equal(x.reason, 'gitignored');
    assert.equal(x.record_id, null, 'no article claims this path');
    assert.equal(exclusionFor(entries, 'build/generated.mjs'), undefined, 'the OWNED ignored path from A5 never carries this exclusion — frontier-scoped, not owner-scoped');
  } finally {
    cleanup();
  }
});

// A5d — UNCHANGED pin, carried over verbatim from the pre-re-cut A5c (renamed only,
// to free the A5c slot for the frontier-scope pin above). This behavior was never
// part of the overturned premise — a degraded (no-git) check already favored
// inclusion, which is the same direction the new premise reinforces — so it is
// preserved rather than dropped (never weaken or delete an existing test).
test('A5d: with NO git repo the ignore check degrades TOWARD SIGNALLING — the path stays a case, marked gitignore_check "unavailable"', () => {
  // SABOTAGE: on a check-ignore failure, exclude the path instead of including it.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeFixtureRepo({ withGit: false });
  try {
    const entries = deriveExpected(store, { repoRoot: dir });
    assert.equal(exclusionFor(entries, 'build/generated.mjs'), undefined, 'no repo is not evidence of ignoring');
    const c = caseFor(entries, 'build/generated.mjs', 'h19-knowledge-delivery.mjs');
    assert.ok(c, 'a path we cannot prove is ignored is expected, not silently dropped');
    assert.equal(c.gitignore_check, 'unavailable');
  } finally {
    cleanup();
  }
});

test('A6: each eligible path also gets an h19-bash-delivery case (the pointer surface, decision 1a5b91ae)', () => {
  // SABOTAGE: derive file_touch cases only.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, ids, cleanup } = makeFixtureRepo();
  try {
    const c = caseFor(deriveExpected(store, { repoRoot: dir }), 'src/shared.mjs', 'h19-bash-delivery.mjs');
    assert.ok(c, 'the Bash surveying seam is audited too');
    assert.equal(c.payload_kind, 'bash');
    assert.deepEqual(sorted(c.expected.owners), sorted([ids.alpha, ids.beta]));
  } finally {
    cleanup();
  }
});

test('A7: H10 ownership expectations are derived for the SAME paths, so an H19-vs-H10 disagreement is a first-class case', () => {
  // SABOTAGE: derive no h10-direct-capture cases (drop the ownership-agreement arm).
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeFixtureRepo();
  try {
    const entries = deriveExpected(store, { repoRoot: dir });
    const h10 = caseFor(entries, 'src/shared.mjs', 'h10-direct-capture.mjs');
    const h19 = caseFor(entries, 'src/shared.mjs', 'h19-knowledge-delivery.mjs');
    assert.ok(h10, 'H10 gets its own case for the shared path');
    assert.equal(h10.payload_kind, 'h10_ownership');
    assert.deepEqual(sorted(h10.expected_ids), sorted(h19.expected.owners), 'the two hooks must agree on OWNERSHIP — only owners, no hazards');
  } finally {
    cleanup();
  }
});

test('A8: fixture_id is stable across two derivations of the same store (a run diff keys on it)', () => {
  // SABOTAGE: mint fixture_id from randomUUID() / a timestamp.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeFixtureRepo();
  try {
    const a = deriveExpected(store, { repoRoot: dir }).filter((e) => e.kind === 'case').map((e) => e.fixture_id);
    const b = deriveExpected(store, { repoRoot: dir }).filter((e) => e.kind === 'case').map((e) => e.fixture_id);
    assert.deepEqual(sorted(a), sorted(b));
    assert.equal(new Set(a).size, a.length, 'fixture_ids are unique within a run');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// GROUP B — synthesizePayload: exact field presence per hook (spec point 2).
// ===========================================================================

const SANDBOX = '/tmp/sterling-oracle-sandbox';

// CONTROL ARM, FIRST: "the ask payload has no prompt field" is satisfiable by
// a synthesizer that never emits a prompt for anything. This arm must pass for
// the opposite reason.
test('B0 CONTROL: an AGENT payload DOES carry tool_input.prompt', () => {
  // SABOTAGE: stop setting tool_input.prompt on the agent arm.
  const synthesizePayload = fn('synthesizePayload');
  const { stdin } = synthesizePayload(
    { kind: 'agent', tool_input: { prompt: 'rework the store guard', subagent_type: 'coder' } },
    { cwd: SANDBOX, session_id: 's1' }
  );
  assert.equal(stdin.tool_input.prompt, 'rework the store guard');
  assert.equal(stdin.tool_name, 'Task');
});

test('B1: an ASK payload carries questions[] with option label/description and NO prompt key at all (decision f5638a84)', () => {
  // SABOTAGE: add `prompt: questions[0].question` to the ask arm "for convenience".
  const synthesizePayload = fn('synthesizePayload');
  const probe = {
    kind: 'ask',
    tool_input: { questions: [{ question: 'q?', header: 'h', options: [{ label: 'L', description: 'D' }] }] },
  };
  const { stdin } = synthesizePayload(probe, { cwd: SANDBOX, session_id: 's1' });
  assert.equal(Object.hasOwn(stdin.tool_input, 'prompt'), false, 'AskUserQuestion has no prompt field — a synthesized one is a lie about the surface');
  assert.equal(stdin.tool_input.questions[0].options[0].description, 'D');
  assert.equal(stdin.tool_name, 'AskUserQuestion');
});

test('B1b: the ask payload carries session_id and a PreToolUse event (H20 keys the deny ledger on it)', () => {
  // SABOTAGE: drop session_id from the synthesized envelope.
  const synthesizePayload = fn('synthesizePayload');
  const { stdin } = synthesizePayload(
    { kind: 'ask', tool_input: { questions: [{ question: 'q?', header: 'h', options: [] }] } },
    { cwd: SANDBOX, session_id: 'sess-42' }
  );
  assert.equal(stdin.session_id, 'sess-42');
  assert.equal(stdin.hook_event_name, 'PreToolUse');
});

test('B2: a BASH case carries tool_input.command naming the path, on PostToolUse Bash', () => {
  // SABOTAGE: emit tool_input.file_path for the bash arm instead of .command.
  const synthesizePayload = fn('synthesizePayload');
  const { stdin } = synthesizePayload(
    { kind: 'case', payload_kind: 'bash', rel: 'src/shared.mjs' },
    { cwd: SANDBOX }
  );
  assert.equal(Object.hasOwn(stdin.tool_input, 'command'), true);
  assert.ok(stdin.tool_input.command.includes('src/shared.mjs'), 'the governed path is in the command string');
  assert.equal(stdin.tool_name, 'Bash');
  assert.equal(stdin.hook_event_name, 'PostToolUse');
});

test('B3: a FILE_TOUCH case carries an ABSOLUTE tool_input.file_path under the sandbox cwd, defaulting to PostToolUse Read', () => {
  // SABOTAGE: pass case.rel through as tool_input.file_path without joining cwd.
  const synthesizePayload = fn('synthesizePayload');
  const { stdin } = synthesizePayload(
    { kind: 'case', payload_kind: 'file_touch', rel: 'src/shared.mjs' },
    { cwd: SANDBOX }
  );
  assert.equal(stdin.tool_input.file_path, join(SANDBOX, 'src/shared.mjs'));
  assert.equal(stdin.hook_event_name, 'PostToolUse');
  assert.equal(stdin.tool_name, 'Read');
  assert.equal(stdin.cwd, SANDBOX);
});

test('B3b: an explicit event/tool override is honoured (the PreToolUse Edit rung is a different cell)', () => {
  // SABOTAGE: hardcode PostToolUse/Read and ignore case.event / case.tool.
  const synthesizePayload = fn('synthesizePayload');
  const { stdin } = synthesizePayload(
    { kind: 'case', payload_kind: 'file_touch', rel: 'src/shared.mjs', event: 'PreToolUse', tool: 'Edit' },
    { cwd: SANDBOX }
  );
  assert.equal(stdin.hook_event_name, 'PreToolUse');
  assert.equal(stdin.tool_name, 'Edit');
});

test('B4 CONTROL: agent_id is present when the case is an AGENT touch', () => {
  // SABOTAGE: never emit agent_id.
  const synthesizePayload = fn('synthesizePayload');
  const { stdin } = synthesizePayload(
    { kind: 'case', payload_kind: 'file_touch', rel: 'src/shared.mjs' },
    { cwd: SANDBOX, agent_id: 'agent-7' }
  );
  assert.equal(stdin.agent_id, 'agent-7');
});

test('B4b: agent_id is ABSENT (not empty, not null) for a conductor touch — AC6 silences agents, so a stray key changes the verdict', () => {
  // SABOTAGE: always emit `agent_id: opts.agent_id ?? ''`.
  const synthesizePayload = fn('synthesizePayload');
  const { stdin } = synthesizePayload(
    { kind: 'case', payload_kind: 'file_touch', rel: 'src/shared.mjs' },
    { cwd: SANDBOX }
  );
  assert.equal(Object.hasOwn(stdin, 'agent_id'), false);
});

test('B5: an H10 case writes .sterling/transient/touches.json as [{path,at}] and puts NO touched set in stdin', () => {
  // SABOTAGE: put the touched paths in stdin (e.g. stdin.touched_files) instead of sandbox_writes.
  const synthesizePayload = fn('synthesizePayload');
  const out = synthesizePayload(
    { kind: 'case', payload_kind: 'h10_ownership', rel: 'src/shared.mjs' },
    { cwd: SANDBOX }
  );
  const write = out.sandbox_writes.find((w) => w.rel === '.sterling/transient/touches.json');
  assert.ok(write, 'H10 takes its touched set from DISK');
  assert.deepEqual(write.json.map((t) => t.path), ['src/shared.mjs']);
  assert.equal(typeof write.json[0].at, 'string', 'each touch carries its timestamp');
  assert.equal(JSON.stringify(out.stdin).includes('src/shared.mjs'), false, 'the path must not also arrive by stdin — that would test a channel the hook does not use');
});

test('B6: a CONSULT probe targets the codex consult seam with a prompt', () => {
  // SABOTAGE: route kind 'consult' through the ask arm (questions[], no prompt).
  const synthesizePayload = fn('synthesizePayload');
  const { stdin } = synthesizePayload(
    { kind: 'consult', tool_input: { prompt: 'second opinion on the guard' } },
    { cwd: SANDBOX, session_id: 's1' }
  );
  assert.equal(stdin.tool_input.prompt, 'second opinion on the guard');
  assert.match(stdin.tool_name, /codex/i);
});

// ===========================================================================
// GROUP C — parseDelivery: the three channels (spec point 3).
// ===========================================================================

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-sbx-'));
  mkdirSync(join(dir, '.sterling', 'transient', 'delivery'), { recursive: true });
  return dir;
}
const writePending = (dir, entries) =>
  writeFileSync(join(dir, '.sterling', 'transient', 'delivery', 'pending.json'), JSON.stringify(entries));

// CONTROL ARM, FIRST: "this result parsed as silent / as a harness error" has
// more than one cause. This arm must pass for the opposite reason — a genuinely
// EMPTY, well-formed result is silence, and silence is not an error.
test('C0 CONTROL: exit 0 with empty stdout and an empty queue is channel "silent" with no harness_error', () => {
  // SABOTAGE: treat empty stdout as a harness_error.
  const parseDelivery = fn('parseDelivery');
  const dir = makeSandbox();
  try {
    const p = parseDelivery({ code: 0, stdout: '', stderr: '' }, dir);
    assert.equal(p.channel, 'silent');
    assert.equal(p.harness_error, undefined);
    assert.deepEqual(p.rendered_ids, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C1: additionalContext ids parse as rendered, channel "inject"', () => {
  // SABOTAGE: read stdout.additionalContext (the wrong nesting) instead of hookSpecificOutput.additionalContext.
  const parseDelivery = fn('parseDelivery');
  const dir = makeSandbox();
  const id = randomUUID();
  try {
    const stdout = JSON.stringify({ hookSpecificOutput: { additionalContext: `article 'alpha' (knowledge_get ${id})` } });
    const p = parseDelivery({ code: 0, stdout, stderr: '' }, dir);
    assert.deepEqual(p.rendered_ids, [id]);
    assert.equal(p.channel, 'inject');
    assert.equal(p.exit_code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C2: pending.json parses per KIND, and queued_ids is the union', () => {
  // SABOTAGE: flatten every queue entry into one bucket, dropping `kind`.
  const parseDelivery = fn('parseDelivery');
  const dir = makeSandbox();
  const a = randomUUID();
  const b = randomUUID();
  try {
    writePending(dir, [
      { kind: 'delivery', rel: 'src/a.mjs', payload: `article 'alpha' (knowledge_get ${a})` },
      { kind: 'bash_pointers', rel: 'src/b.mjs', payload: `owner (knowledge_get ${b})` },
    ]);
    const p = parseDelivery({ code: 0, stdout: '', stderr: '' }, dir);
    assert.equal(p.channel, 'queue');
    assert.deepEqual(sorted(p.queued_by_kind.delivery.flatMap((e) => e.ids)), [a]);
    assert.deepEqual(sorted(p.queued_by_kind.bash_pointers.flatMap((e) => e.ids)), [b]);
    assert.deepEqual(sorted(p.queued_ids), sorted([a, b]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C2b: a FRONTIER entry carries a rel and no ids — a non-article entry must not be assumed article-shaped (decision db3392db)', () => {
  // SABOTAGE: assume every queue entry has a record id and throw/skip when it does not.
  const parseDelivery = fn('parseDelivery');
  const dir = makeSandbox();
  try {
    writePending(dir, [{ kind: 'frontier', rel: 'src/new.mjs', payload: 'territory unowned' }]);
    const p = parseDelivery({ code: 0, stdout: '', stderr: '' }, dir);
    assert.deepEqual(p.queued_by_kind.frontier.map((e) => e.rel), ['src/new.mjs']);
    assert.deepEqual(p.queued_by_kind.frontier[0].ids, []);
    assert.deepEqual(p.queued_ids, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C3: exit 2 with stderr is a DENY — channel "deny", denied true, ids taken from the denial text', () => {
  // SABOTAGE: classify exit 2 as a harness_error / a non-blocking warning.
  const parseDelivery = fn('parseDelivery');
  const dir = makeSandbox();
  const id = randomUUID();
  try {
    const p = parseDelivery({ code: 2, stdout: '', stderr: `STERLING: this is already ruled (knowledge_get ${id})` }, dir);
    assert.equal(p.channel, 'deny');
    assert.equal(p.denied, true);
    assert.equal(p.exit_code, 2);
    assert.deepEqual(p.denied_ids, [id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C3b: deny OUTRANKS inject — an exit-2 result that also printed context is still scored as a denial', () => {
  // SABOTAGE: check additionalContext before the exit code when picking the channel.
  const parseDelivery = fn('parseDelivery');
  const dir = makeSandbox();
  const id = randomUUID();
  try {
    const stdout = JSON.stringify({ hookSpecificOutput: { additionalContext: `ruling (knowledge_get ${id})` } });
    const p = parseDelivery({ code: 2, stdout, stderr: `denied (knowledge_get ${id})` }, dir);
    assert.equal(p.channel, 'deny');
    assert.equal(p.denied, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C4: non-empty stdout that is not valid JSON is a HARNESS_ERROR — rendered_ids is null, never a silent empty array', () => {
  // SABOTAGE: wrap the JSON.parse in try/catch and return rendered_ids: [] on failure.
  const parseDelivery = fn('parseDelivery');
  const dir = makeSandbox();
  try {
    const p = parseDelivery({ code: 0, stdout: 'Debugger attached.\n{oops', stderr: '' }, dir);
    assert.equal(typeof p.harness_error, 'string');
    assert.ok(p.harness_error.length > 0);
    assert.equal(p.rendered_ids, null, 'null means "not measured"; [] would score as a real MISS and blame the hook for a harness fault');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C5: exit 1 with stderr is a non-blocking warning, NOT a deny (AC7 floor)', () => {
  // SABOTAGE: treat any non-zero exit as denied.
  const parseDelivery = fn('parseDelivery');
  const dir = makeSandbox();
  try {
    const p = parseDelivery({ code: 1, stdout: '', stderr: 'STERLING: delivery failed loudly' }, dir);
    assert.equal(p.denied, false);
    assert.equal(p.exit_code, 1);
    assert.notEqual(p.channel, 'deny');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// GROUP D — identity (spec point 8).
// ===========================================================================

const IDENT = { snapshotDigest: 'aaaa', bundleHash: 'bbbb', rung: 'prompt', oracleVersion: 1 };

test('D0 CONTROL: runIdentity is DETERMINISTIC — identical inputs give the identical string', () => {
  // SABOTAGE: mix Date.now() or randomUUID() into the identity digest.
  const runIdentity = fn('runIdentity');
  assert.equal(runIdentity({ ...IDENT }), runIdentity({ ...IDENT }));
  assert.ok(runIdentity(IDENT).length >= 8);
});

test('D1: changing ANY of the four identity components changes the identity', () => {
  // SABOTAGE: drop `rung` from the digest input (the subtlest of the four).
  const runIdentity = fn('runIdentity');
  const variants = [
    runIdentity(IDENT),
    runIdentity({ ...IDENT, snapshotDigest: 'zzzz' }),
    runIdentity({ ...IDENT, bundleHash: 'zzzz' }),
    runIdentity({ ...IDENT, rung: 'read' }),
    runIdentity({ ...IDENT, oracleVersion: 2 }),
  ];
  assert.equal(new Set(variants).size, 5, 'each component is load-bearing');
});

test('D2: caseIdentity is stable for an unchanged case and moves when its expectation moves', () => {
  // SABOTAGE: build caseIdentity from fixture_id alone, ignoring expected_ids.
  const caseIdentity = fn('caseIdentity');
  const base = { fixture_id: 'h19:file_touch:src/a.mjs', hook: 'h19-knowledge-delivery.mjs', expected_ids: ['id-1'] };
  assert.equal(caseIdentity({ ...base }), caseIdentity({ ...base }));
  assert.notEqual(caseIdentity(base), caseIdentity({ ...base, expected_ids: ['id-1', 'id-2'] }));
});

// ===========================================================================
// GROUP E — compareRuns (spec point 8: a changed expectation is never a regression).
// ===========================================================================

const runOf = (identity, cases) => ({ identity, cases });
const c = (fixture_id, expected_hash, rendered, extra = {}) => ({ fixture_id, expected_hash, rendered, drained: false, ...extra });

// CONTROL ARM, FIRST: "no pass_to_miss was reported" is satisfiable by a
// comparator that can never report one. This arm must pass for the opposite
// reason — a REAL regression under an UNCHANGED expectation is reported.
test('E0 CONTROL: same expected_hash, rendered -> not rendered IS reported as pass_to_miss', () => {
  // SABOTAGE: return pass_to_miss: [] unconditionally.
  const compareRuns = fn('compareRuns');
  const prev = runOf('i1', [c('f1', 'h1', true)]);
  const next = runOf('i1', [c('f1', 'h1', false)]);
  assert.deepEqual(compareRuns(prev, next).pass_to_miss, ['f1']);
});

test('E1: a case whose expected_hash CHANGED is expectation_changed and NEVER pass_to_miss', () => {
  // SABOTAGE: compare rendered flags without first comparing expected_hash.
  const compareRuns = fn('compareRuns');
  const prev = runOf('i1', [c('f1', 'h1', true)]);
  const next = runOf('i1', [c('f1', 'h2', false)]);
  const d = compareRuns(prev, next);
  assert.deepEqual(d.expectation_changed, ['f1']);
  assert.deepEqual(d.pass_to_miss, [], 'a moved goalpost is not a regression');
});

test('E1b: a changed expected_hash is not laundered into miss_to_pass either', () => {
  // SABOTAGE: report any not-rendered -> rendered flip as miss_to_pass regardless of the hash.
  const compareRuns = fn('compareRuns');
  const prev = runOf('i1', [c('f1', 'h1', false)]);
  const next = runOf('i1', [c('f1', 'h2', true)]);
  const d = compareRuns(prev, next);
  assert.deepEqual(d.expectation_changed, ['f1']);
  assert.deepEqual(d.miss_to_pass, []);
});

test('E2: a prior run with a DIFFERENT run identity is still compared, per case, by fixture_id + expected_hash', () => {
  // SABOTAGE: bail out (return empty transitions) when prev.identity !== next.identity.
  const compareRuns = fn('compareRuns');
  const prev = runOf('identity-A', [c('f1', 'h1', true)]);
  const next = runOf('identity-B', [c('f1', 'h1', false)]);
  assert.deepEqual(compareRuns(prev, next).pass_to_miss, ['f1'], 'a rebuilt bundle must not erase a regression');
});

test('E3: a genuine recovery is miss_to_pass, and a drained-only pass counts as passed', () => {
  // SABOTAGE: count only `rendered` as passed, ignoring `drained`.
  const compareRuns = fn('compareRuns');
  const prev = runOf('i1', [c('f1', 'h1', false)]);
  const next = runOf('i1', [c('f1', 'h1', false, { drained: true })]);
  assert.deepEqual(compareRuns(prev, next).miss_to_pass, ['f1']);
});

test('E4: a case absent from the prior run is not reported as any transition', () => {
  // SABOTAGE: default a missing prior case to "passed", turning every new case into a regression.
  const compareRuns = fn('compareRuns');
  const prev = runOf('i1', []);
  const next = runOf('i1', [c('f-new', 'h1', false)]);
  const d = compareRuns(prev, next);
  assert.deepEqual(d.pass_to_miss, []);
  assert.deepEqual(d.miss_to_pass, []);
});

// ===========================================================================
// GROUP F — metrics arithmetic (spec point 6).
//   eligible_recall = |eligible| / |cases|                   (null if no cases)
//   rendered_recall = |eligible & rendered| / |eligible|     (null if none eligible)
//   eventual_recall = |eligible & (rendered||drained)| / |eligible|
//   drained_recall  = |queued & drained| / |queued|          (null if none queued)
//   precision       = sum|delivered ∩ expected| / sum|delivered|  (null if none delivered)
// ===========================================================================

const mcase = (over = {}) => ({
  hook: 'h19-knowledge-delivery.mjs',
  eligible: true,
  rendered: true,
  drained: false,
  queued: false,
  expected_ids: ['x'],
  delivered_ids: ['x'],
  ...over,
});

test('F0 CONTROL: a fully-delivered set scores 1 on recall and 1 on precision', () => {
  // SABOTAGE: return a fixed 0 (or null) for every metric.
  const metrics = fn('metrics');
  const m = metrics([mcase(), mcase()]).per_hook['h19-knowledge-delivery.mjs'];
  assert.equal(m.eligible_recall, 1);
  assert.equal(m.rendered_recall, 1);
  assert.equal(m.precision, 1);
});

test('F1: a CAPPED-but-disclosed case counts as eligible-and-NOT-rendered — a disclosure is not a delivery', () => {
  // SABOTAGE: treat capped_disclosed as rendered ("we told them it was capped, close enough").
  const metrics = fn('metrics');
  const m = metrics([
    mcase(),
    mcase({ rendered: false, delivered_ids: [], capped_disclosed: true }),
  ]).per_hook['h19-knowledge-delivery.mjs'];
  assert.equal(m.eligible_recall, 1, 'both were eligible');
  assert.equal(m.rendered_recall, 0.5, 'only one was actually rendered');
});

test('F2: division by zero is null — never NaN, never 0', () => {
  // SABOTAGE: return the raw hits/total division without the zero guard.
  const metrics = fn('metrics');
  const m = metrics([mcase({ eligible: false, rendered: false, delivered_ids: [] })]).per_hook['h19-knowledge-delivery.mjs'];
  assert.equal(m.rendered_recall, null, 'nothing eligible: unmeasured, not "0% delivered"');
  assert.equal(m.drained_recall, null, 'nothing queued: unmeasured');
  assert.equal(m.precision, null, 'nothing delivered: unmeasured');
  assert.equal(Number.isNaN(m.rendered_recall), false);
});

test('F3: eventual_recall credits a DRAINED case that was never injected (the prompt rung lands one turn late)', () => {
  // SABOTAGE: define eventual_recall as a copy of rendered_recall.
  const metrics = fn('metrics');
  const m = metrics([
    mcase({ rendered: false, drained: true, queued: true }),
    mcase({ rendered: false, drained: false, queued: true, delivered_ids: [] }),
  ]).per_hook['h19-knowledge-delivery.mjs'];
  assert.equal(m.rendered_recall, 0);
  assert.equal(m.eventual_recall, 0.5);
  assert.equal(m.drained_recall, 0.5);
});

test('F4: precision falls when an UNEXPECTED id is delivered', () => {
  // SABOTAGE: compute precision as |expected ∩ delivered| / |expected| (recall in disguise).
  const metrics = fn('metrics');
  const m = metrics([mcase({ expected_ids: ['x'], delivered_ids: ['x', 'noise'] })]).per_hook['h19-knowledge-delivery.mjs'];
  assert.equal(m.precision, 0.5);
  assert.equal(m.rendered_recall, 1, 'the expected id still arrived — recall is unharmed');
});

test('F5: metrics are keyed PER HOOK — one hook\'s miss never dilutes another\'s score', () => {
  // SABOTAGE: aggregate every case into a single bucket.
  const metrics = fn('metrics');
  const m = metrics([
    mcase({ hook: 'h19-knowledge-delivery.mjs' }),
    mcase({ hook: 'h20-mechanism-axis.mjs', rendered: false, delivered_ids: [] }),
  ]).per_hook;
  assert.equal(m['h19-knowledge-delivery.mjs'].rendered_recall, 1);
  assert.equal(m['h20-mechanism-axis.mjs'].rendered_recall, 0);
});

// ===========================================================================
// GROUP G — sandbox reset (spec point 5: a stale deny ledger converts a
// first-attempt DENY into an ALLOW — the likeliest false-recall source).
// ===========================================================================

function seededSandbox() {
  const dir = makeSandbox();
  const d = join(dir, '.sterling', 'transient', 'delivery');
  writeFileSync(join(d, 'guard-conductor.json'), JSON.stringify({ records: ['id-1'] }));
  writeFileSync(join(d, 'deny-ledger-conductor.json'), JSON.stringify({ overrides: [], denied: ['id-1'] }));
  writeFileSync(join(d, 'pending.json'), JSON.stringify([{ kind: 'delivery', rel: 'x', payload: 'p' }]));
  return dir;
}

test('G0 CONTROL: an ordinary case wipes .sterling/transient/delivery ENTIRELY — guard AND deny ledger AND queue', () => {
  // SABOTAGE: delete only pending.json and leave the guard/deny ledger in place.
  const resetSandbox = fn('resetSandbox');
  const dir = seededSandbox();
  try {
    resetSandbox(dir, { kind: 'case', fixture_id: 'f1' });
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'delivery')), false, 'a surviving guard file silently converts a real delivery into a dedup silence');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G1: a seed_ledger case KEEPS the ledger untouched (override cases need the prior denial to exist)', () => {
  // SABOTAGE: ignore case.seed_ledger and always wipe.
  const resetSandbox = fn('resetSandbox');
  const dir = seededSandbox();
  const ledger = join(dir, '.sterling', 'transient', 'delivery', 'deny-ledger-conductor.json');
  const before = readFileSync(ledger, 'utf8');
  try {
    resetSandbox(dir, { kind: 'case', fixture_id: 'f1', seed_ledger: true });
    assert.equal(existsSync(ledger), true);
    assert.equal(readFileSync(ledger, 'utf8'), before, 'seeded state survives byte-for-byte');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G2: reset on a sandbox with no delivery dir is a no-op, not a throw', () => {
  // SABOTAGE: rmSync without { force: true } / without an existence check.
  const resetSandbox = fn('resetSandbox');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-bare-'));
  try {
    resetSandbox(dir, { kind: 'case', fixture_id: 'f1' });
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'delivery')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// GROUP H — the frozen probe fixtures (spec point 7).
// H-pre reads the shipped files DIRECTLY (no oracle import): it is the one
// test here that pins the fixtures themselves rather than the loader.
// ===========================================================================

const PROBES = [
  {
    file: 'probe-001-agent-positive.json',
    id: 'probe-001-agent-positive',
    kind: 'agent',
    expected_ids: ['5b82e94f-3f42-415b-b8d1-983b78e50095', 'a206a529-28fe-4271-b7a1-dd40593e2401'],
    expect_deny: false,
  },
  {
    file: 'probe-002-ask-deny.json',
    id: 'probe-002-ask-deny',
    kind: 'ask',
    expected_ids: ['68332e4b-da25-474e-a973-7cb53a0da40b'],
    expect_deny: true,
  },
  {
    file: 'probe-003-near-miss-negative.json',
    id: 'probe-003-near-miss-negative',
    kind: 'agent',
    expected_ids: [],
    expect_deny: false,
  },
];

test('H-pre: the three shipped probes exist, carry their human-written expectations, and the ASK probe has NO prompt field', () => {
  // SABOTAGE: regenerate a probe from a record title / add a prompt field to the ask probe.
  for (const p of PROBES) {
    const path = join(PROBE_DIR, p.file);
    assert.equal(existsSync(path), true, `${p.file} must exist — probes are frozen files, not generated at run time`);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(json.id, p.id);
    assert.equal(json.kind, p.kind);
    assert.deepEqual(sorted(json.expected_ids), sorted(p.expected_ids), `${p.file}: expected_ids are full uuids of live records`);
    assert.equal(Boolean(json.expect_deny), p.expect_deny);
    if (p.kind === 'ask') {
      assert.equal(Object.hasOwn(json.tool_input, 'prompt'), false, 'AskUserQuestion carries no prompt field (decision f5638a84)');
      assert.ok(Array.isArray(json.tool_input.questions) && json.tool_input.questions.length > 0);
      assert.ok(json.tool_input.questions[0].options.some((o) => o.description && o.description.length > 40), 'option TEXT carries the governed subject — that is the measured incident (AC11)');
    } else {
      assert.equal(typeof json.tool_input.prompt, 'string');
    }
    if (json.expect_deny) assert.ok(json.expect_deny_ids.length > 0, 'a deny expectation names the ids it expects in the denial');
  }
});

test('H-pre-b: the near-miss NEGATIVE expects nothing and names the records that must NOT be delivered', () => {
  // SABOTAGE: give the near-miss a non-empty expected_ids (turning the negative arm into another positive).
  const json = JSON.parse(readFileSync(join(PROBE_DIR, 'probe-003-near-miss-negative.json'), 'utf8'));
  assert.deepEqual(json.expected_ids, []);
  assert.ok(json.expected_absent_ids.length > 0, 'a negative probe is only falsifiable if it names what absence means');
  for (const id of json.expected_absent_ids) assert.match(id, UUID_RE);
});

test('H0 CONTROL: loadProbes ACCEPTS the three shipped fixtures and returns them by id', () => {
  // SABOTAGE: make loadProbes throw on any probe carrying a `note` field.
  const loadProbes = fn('loadProbes');
  const probes = loadProbes(PROBE_DIR);
  assert.deepEqual(sorted(probes.map((p) => p.id)), sorted(PROBES.map((p) => p.id)));
});

function probeDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-probes-'));
  for (const [name, json] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(json));
  return dir;
}

test('H1: a kind "ask" probe carrying a prompt field is REFUSED, naming the file', () => {
  // SABOTAGE: validate only that tool_input exists, never its per-kind shape.
  const loadProbes = fn('loadProbes');
  const dir = probeDir({
    'bad-ask.json': { id: 'bad-ask', kind: 'ask', expected_ids: [], tool_input: { prompt: 'q?', questions: [] } },
  });
  try {
    assert.throws(() => loadProbes(dir), (e) => /bad-ask/.test(e.message) && /prompt/.test(e.message),
      'a probe that fakes a field the real surface never sends measures nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H2: a probe missing expected_ids is REFUSED (an expectation-free probe can never fail)', () => {
  // SABOTAGE: default a missing expected_ids to [].
  const loadProbes = fn('loadProbes');
  const dir = probeDir({
    'no-expect.json': { id: 'no-expect', kind: 'agent', tool_input: { prompt: 'x' } },
  });
  try {
    assert.throws(() => loadProbes(dir), (e) => /no-expect/.test(e.message) && /expected_ids/.test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H3: expect_deny with expect_deny_ids is ACCEPTED and both survive the load', () => {
  // SABOTAGE: drop expect_deny/expect_deny_ids from the returned probe object.
  const loadProbes = fn('loadProbes');
  const dir = probeDir({
    'deny.json': {
      id: 'deny', kind: 'ask', expected_ids: ['id-1'],
      tool_input: { questions: [{ question: 'q?', header: 'h', options: [] }] },
      expect_deny: true, expect_deny_ids: ['id-1'],
    },
  });
  try {
    const [p] = loadProbes(dir);
    assert.equal(p.expect_deny, true);
    assert.deepEqual(p.expect_deny_ids, ['id-1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H4: expect_deny true with NO expect_deny_ids is REFUSED — an unfalsifiable deny expectation', () => {
  // SABOTAGE: accept expect_deny without ids ("a deny is a deny").
  const loadProbes = fn('loadProbes');
  const dir = probeDir({
    'deny-blind.json': {
      id: 'deny-blind', kind: 'ask', expected_ids: ['id-1'],
      tool_input: { questions: [{ question: 'q?', header: 'h', options: [] }] },
      expect_deny: true,
    },
  });
  try {
    assert.throws(() => loadProbes(dir), (e) => /deny-blind/.test(e.message) && /expect_deny_ids/.test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H5: an unknown kind is REFUSED, never half-scanned (a tool carrying neither shape is inert, AC11)', () => {
  // SABOTAGE: fall through to the agent arm for any unrecognised kind.
  const loadProbes = fn('loadProbes');
  const dir = probeDir({
    'weird.json': { id: 'weird', kind: 'telepathy', expected_ids: [], tool_input: {} },
  });
  try {
    assert.throws(() => loadProbes(dir), (e) => /weird/.test(e.message) && /telepathy|kind/.test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// GROUP I — the report writer (spec point 8).
// ===========================================================================

const REPORT = () => ({
  schema: 1,
  at: '2026-09-05T12:00:00.000Z',
  identity: { snapshot_digest: 'aaaa', bundle_hash: 'bbbb', rung: 'prompt', oracle_version: 1 },
  cases: [{ fixture_id: 'f1', hook: 'h19-knowledge-delivery.mjs', expected_hash: 'h1', rendered: true }],
  metrics: { per_hook: {} },
  golden: [],
});

test('I0: the audit dir is .sterling/delivery-audit/ and is NOT under transient/ (h19-clear-session wipes transient at SessionStart)', () => {
  // SABOTAGE: point auditDir at .sterling/transient/delivery-audit.
  const auditDir = fn('auditDir');
  const d = auditDir('/proj');
  assert.equal(d, join('/proj', '.sterling', 'delivery-audit'));
  assert.equal(d.includes(`${join('.sterling', 'transient')}`), false, 'a run history inside transient is erased by the next session start');
});

test('I1: writeRunReport writes runs/<timestamp>-<identity>.json under the audit dir, with a Windows-legal basename', () => {
  // SABOTAGE: name the file with the raw ISO string (':' is illegal on Windows — parity is standing).
  const writeRunReport = fn('writeRunReport');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-report-'));
  try {
    const { run_path } = writeRunReport(dir, REPORT());
    assert.ok(run_path.startsWith(join(dir, '.sterling', 'delivery-audit', 'runs')), run_path);
    const base = basename(run_path);
    assert.equal(base.includes(':'), false, 'a colon makes the report unwritable on Windows');
    assert.match(base, /\.json$/);
    assert.equal(JSON.parse(readFileSync(run_path, 'utf8')).schema, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('I2 CONTROL: one run appends exactly ONE line to history.jsonl, and it parses', () => {
  // SABOTAGE: append one line per CASE instead of one per run.
  const writeRunReport = fn('writeRunReport');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-report-'));
  try {
    const { history_path } = writeRunReport(dir, REPORT());
    const lines = readFileSync(history_path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(typeof entry.at, 'string');
    assert.ok(entry.identity && entry.totals && entry.transitions, 'each history line carries at/identity/totals/transitions');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('I3: a SECOND run appends a second line and leaves the first byte-identical (history is append-only)', () => {
  // SABOTAGE: writeFileSync the history line instead of appendFileSync.
  const writeRunReport = fn('writeRunReport');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-report-'));
  try {
    const first = writeRunReport(dir, REPORT());
    const firstLine = readFileSync(first.history_path, 'utf8').trim().split('\n')[0];
    const second = writeRunReport(dir, { ...REPORT(), at: '2026-09-05T13:00:00.000Z' });
    const lines = readFileSync(second.history_path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], firstLine, 'the prior run is history, not a scratch buffer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('I4: two runs write two DISTINCT run files — a rerun never clobbers the previous report', () => {
  // SABOTAGE: name the run file from the identity alone, dropping the timestamp.
  const writeRunReport = fn('writeRunReport');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-report-'));
  try {
    const a = writeRunReport(dir, REPORT());
    const b = writeRunReport(dir, { ...REPORT(), at: '2026-09-05T13:00:00.000Z' });
    assert.notEqual(a.run_path, b.run_path);
    assert.equal(existsSync(a.run_path), true);
    assert.equal(existsSync(b.run_path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
