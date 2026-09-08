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
//   deriveExpected(store, { repoRoot, outputAxisProbes }) -> Entry[]
//     outputAxisProbes (optional, default []): the H23 output-axis probe
//     extension (GROUP J-N below) — { rel, tool, tool_response, agent_id? }[].
//     agent_id is optional; when present the case is silenced with
//     expected_reason 'agent_id_present' (GROUP R below).
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
//                   reason: 'gitignored'|'working_tree_article'|
//                           'descends_from_file_claim'|'real_directory'|
//                           'ancestor_of_claim',
//                   record_ids: string[],  // ALL claimants, deduped;
//                                           // record_id === record_ids[0]
//                   raw?: string }         // the FIRST claim's original
//                                           // (pre-normalization) spelling,
//                                           // e.g. 'a/' when rel is 'a'
//     (GROUP T below, conductor follow-up after the coder's review pass.)
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
//   loadGoldenFixtures(dir) -> Fixture[]   // GROUP S below (board ab288113);
//                       Fixture = { file, event, payload, expected_ids,
//                       expected_absent_ids, source_incident }; throws,
//                       naming the file and the reason, on: a missing
//                       required field (S4); expected_ids AND
//                       expected_absent_ids both empty (S6); a non-UUID
//                       entry in expected_ids (S7); an (event, tool_name)
//                       pair with no hook route (S8).
//   goldenManifest(fixtures) -> { version:1, fixtures:[{file, expected_ids,
//                       expected_absent_ids}] }  // sorted by file; each id
//                       set sorted; independent of input order.
//   goldenManifestDigest(fixtures) -> string  // SHA-256 hex over the
//                       canonical manifest above; stimulus fields
//                       (event/payload/source_incident) are NOT hashed.
//   runGoldenFixtures(...) -> report          // replays the golden corpus
//                       through the bundled hooks; not unit-tested here (see
//                       GROUP S's header) — the CLI gate covers it.
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
    file: 'probe-004-agent-positive-h15-cluster.json',
    id: 'probe-004-agent-positive-h15-cluster',
    kind: 'agent',
    // probe-001 was REPLACED (not repointed) by probe-004 per the probe README's
    // replace-don't-repoint contract — decision
    // h20-specificity-rebuild-not-fourth-patch-structural-fixes-now-red-probes-frozen
    // (knowledge_get 80d897b2). The seven ids are the adjudicated H15 realpath /
    // clone-provenance cluster, each opened and verified on-subject.
    expected_ids: [
      '5b82e94f-3f42-415b-b8d1-983b78e50095',
      'a206a529-28fe-4271-b7a1-dd40593e2401',
      'caecf8a6-b520-49fd-9b8b-ed41660a9fab',
      '43bebe5c-87ae-4ff4-af60-afc351f895d9',
      '1434cd54-04d9-42de-b7f2-2e7a3fda288d',
      '95c2c109-ea95-4be3-921b-92cbda6cc9b8',
      '37e588fb-95ca-43a5-b325-669c42fb1ac0',
    ],
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

// ===========================================================================
// GROUP J–N — H23 OUTPUT-AXIS ARM (board 5d462868, slice 3D of objective
// dome-farmer-issues-2026-09-05). Layer 1 previously did not audit H23 at all
// (article 79d2a189 v6: "H23 is NOT audited"); a Codex review (thread
// 01a07249) additionally found the output_axis payload arm already present as
// DEAD CODE while the header still claimed the same limit — these groups pin
// the arm that closes both gaps at once. Written BLIND to
// scripts/delivery-oracle.mjs and scripts/hooks/h23-output-axis.mjs (H4); the
// H23 predicate facts below come from decisions b266d6b7 and 284fc4b0 (both
// standing) and from scripts/tests/h23-output-axis.test.mjs — h23's OWN
// frozen suite, itself a TEST file, not implementation, and the source of the
// AXIS_MIN_HITS(2) / three-floor / domain-vocabulary idiom reused verbatim
// below so these fixtures clear or miss the real floors regardless of the
// exact internal scoring this suite was never allowed to read.
//
// SCOPE FENCE (mirrors this file's own header, line 5): H23's own dedup,
// centrality and cap-rendering correctness are ALREADY pinned at
// scripts/tests/h23-output-axis.test.mjs (AC1/AC5/AC7) — re-asserting those
// here would violate this file's stated charter. What belongs here is only
// the ORACLE'S OWN mirroring/scoring/reporting of that arm.
//
// INTERFACE EXTENSION (ambiguity resolved here, not silently decided — same
// convention as the AMBIGUITIES block at the top of this file; FLAGGED to the
// conductor/coder in the handoff, since it was authored without implementation
// read access):
//   deriveExpected(store, { repoRoot, outputAxisProbes }) — outputAxisProbes
//   is a NEW, backward-compatible optional array (default []); every existing
//   Group A call site omits it and is UNCHANGED — deriveExpected cannot
//   invent tool_response content from a repo walk alone, unlike H19/H10
//   which are pure path-owner lookups. Each probe is
//     { rel: string|null, tool: 'Bash'|'Read', tool_response: string|object }.
//   For each probe, deriveExpected mirrors h23-output-axis.mjs's OWN
//   predicate and emits ONE Case using the contract's EXISTING optional
//   `tool` override field (already declared at the top of this file) plus a
//   NEW `tool_response` field:
//     { kind:'case', hook:'h23-output-axis.mjs', payload_kind:'output_axis',
//       rel: probe.rel, tool: probe.tool, tool_response: probe.tool_response,
//       expected: { owners: [], hazards: [...], rationale: [...] },
//         // owners is ALWAYS empty — output-axis content matching confers
//         // no ownership (decision b266d6b7)
//       expected_ids: <deduped union of hazards+rationale>,
//       expected_reason?: 'owned_suppressed' | 'below_axis_floor' }
//         // present ONLY when expected_ids is empty, naming WHICH of the
//         // two STORE-DERIVABLE silence reasons applies. Dedup and
//         // subagent-silence are RUNTIME/session facts, not store-derivable
//         // from (store, repoRoot) alone, and stay h23-output-axis.mjs's
//         // own frozen suite's job (per the scope fence above) — Group N
//         // below covers only the piece that IS the oracle's: the sandbox
//         // reset must not let one case's guard state leak into the next.
//   'below_axis_floor' fires when the content simply fails the three-floor
//   axis match (tool==='Bash' never has an ownership concept at all).
//   'owned_suppressed' fires when tool==='Read' names a path owned by a
//   non-working_tree feature_article/reference_material, REGARDLESS of
//   content match — ownership is checked before, and independently of,
//   content matching (mirrors h23-output-axis.test.mjs AC2).
//
//   parseDelivery's pending-queue entries for this arm carry
//   { kind: 'output_axis_pointers', rel, payload } — the REAL name the shipped
//   hook emits (scripts/hooks/h23-output-axis.mjs:236, conductor-verified;
//   corrected here from this test-writer's earlier blind assumption
//   'output_axis', which nothing produces and is now removed, not aliased —
//   joining h19-bash-delivery's 'bash_pointers' and h19-knowledge-delivery's
//   'delivery' kinds in the same pending.json (decision b266d6b7: "the same
//   pending queue h19-bash-delivery uses"). parseDelivery additionally
//   extracts a numeric `suppressed_count` per
//   queued_by_kind.output_axis_pointers entry from the
//   "(+N more matched)" tail decision 284fc4b0 mandates — the SAME regex
//   scripts/tests/h23-output-axis.test.mjs already pins at the hook level
//   (/\(\+(\d+) more matched\)/), reused verbatim below rather than
//   re-derived, so a rename of the tail format breaks both suites identically
//   instead of silently diverging.
// ===========================================================================

const DOMAIN_TRIGGER =
  'breach countdown breach countdown widget flywheel widget flywheel ballast klaxon ballast klaxon ' +
  'recur constantly though this bug rarely touches a game field cell during setup work';
const DOMAIN_STATEMENT =
  'No surface may ever silence the breach countdown alarm: breach countdown widget flywheel widget flywheel ' +
  'ballast klaxon ballast klaxon must remain audible regardless of setup context.';
const CONTENT_SENTENCE =
  'The reactor log shows the breach alarm firing while the widget assembly and the flywheel governor both spike past nominal load.';
const UNRELATED_CONTENT =
  'The invoice export pipeline now writes a CSV header row before every batch of billing rows.';

function axisAntiPattern(marker, extra = {}) {
  return {
    ...envelope('anti_pattern'),
    title: `${marker} breach countdown widget flywheel ballast klaxon failure`,
    trigger: DOMAIN_TRIGGER,
    guidance: 'guidance prose',
    wrong_way: 'wrong way',
    right_way: 'right way',
    source_evidence: 'fixture',
    basis: 'codebase',
    severity: 'warn',
    file_keys: [],
    ...extra,
  };
}

function axisDecision(marker, extra = {}) {
  return {
    ...envelope('decision'),
    title: `${marker} breach countdown widget flywheel ballast klaxon ruling`,
    statement: DOMAIN_STATEMENT,
    alternatives_rejected: [],
    rationale: 'rationale prose',
    file_keys: [],
    ...extra,
  };
}

function makeAxisFixtureRepo() {
  assert.ok(SterlingStore, 'packages/store/dist must be built for the oracle fixture (npm run build)');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-axis-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'src', 'owned.mjs'), '// owned\n');
  writeFileSync(join(dir, 'logs', 'unowned.log'), '// unowned\n');
  const init = git(dir, ['init', '-q']);
  assert.equal(init.status, 0, 'git is required to build the oracle fixture');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'axis fixture']);
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const owner = store.create(articleRecord('axis-owner', ['src/owned.mjs']));
  const cleanup = () => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, ids: { owner: owner.id }, cleanup };
}

const h23CaseOf = (entries, tool) =>
  entries.find((e) => e.kind === 'case' && e.hook === 'h23-output-axis.mjs' && e.tool === tool);

// ===========================================================================
// GROUP J — deriveExpected: the H23 output-axis arm (store-side mirror).
// ===========================================================================

test('J0 CONTROL: the SAME content via Bash gets matched hazards, while via Read on an OWNED path it is suppressed for the OPPOSITE reason (ownership, not absence of a match)', () => {
  // SABOTAGE: make the output_axis arm always return empty expected_ids (a do-nothing stub standing in for the "dead code" this arm replaces).
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    const ap = store.create(axisAntiPattern('AP-ALPHA'));
    const probes = [
      { rel: null, tool: 'Bash', tool_response: CONTENT_SENTENCE },
      { rel: 'src/owned.mjs', tool: 'Read', tool_response: CONTENT_SENTENCE },
    ];
    const entries = deriveExpected(store, { repoRoot: dir, outputAxisProbes: probes });
    const bashCase = h23CaseOf(entries, 'Bash');
    const readCase = h23CaseOf(entries, 'Read');
    assert.ok(bashCase, 'the Bash probe produces an H23 case');
    assert.deepEqual(bashCase.expected.hazards, [ap.id], 'matching content over Bash gets the pointer');
    assert.ok(readCase, 'the Read probe also produces an H23 case (never silently dropped)');
    assert.deepEqual(readCase.expected_ids, [], 'the owned path is suppressed');
    assert.equal(readCase.expected_reason, 'owned_suppressed', 'suppressed FOR OWNERSHIP, not because the content failed to match — the Bash arm proves the same content DOES match');
  } finally {
    cleanup();
  }
});

test('J1: content sharing no axis vocabulary with any store record is silent on an UNOWNED path, distinguished as below_axis_floor', () => {
  // SABOTAGE: collapse expected_reason to a single constant regardless of cause, so 'owned_suppressed' and 'below_axis_floor' become indistinguishable.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    store.create(axisAntiPattern('AP-ALPHA'));
    const probes = [{ rel: 'logs/unowned.log', tool: 'Read', tool_response: UNRELATED_CONTENT }];
    const entries = deriveExpected(store, { repoRoot: dir, outputAxisProbes: probes });
    const c = h23CaseOf(entries, 'Read');
    assert.ok(c, 'an unowned, non-matching path still gets a case, never silently dropped');
    assert.deepEqual(c.expected_ids, []);
    assert.equal(c.expected_reason, 'below_axis_floor', 'unowned + no vocabulary overlap is the OTHER silence reason — must read differently from J0\'s owned_suppressed');
  } finally {
    cleanup();
  }
});

test('J2: matches classify into hazards (anti_pattern) vs rationale (decision), NEVER owners, and expected_ids is their deduped union', () => {
  // SABOTAGE: push output-axis matches into expected.owners (output-axis content matching confers no ownership).
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    const ap = store.create(axisAntiPattern('AP-ALPHA'));
    const dec = store.create(axisDecision('DEC-GAMMA'));
    const entries = deriveExpected(store, {
      repoRoot: dir,
      outputAxisProbes: [{ rel: null, tool: 'Bash', tool_response: CONTENT_SENTENCE }],
    });
    const c = h23CaseOf(entries, 'Bash');
    assert.deepEqual(c.expected.hazards, [ap.id]);
    assert.deepEqual(c.expected.rationale, [dec.id]);
    assert.deepEqual(c.expected.owners, [], 'output-axis content matching is never ownership');
    assert.deepEqual(sorted(c.expected_ids), sorted([ap.id, dec.id]));
  } finally {
    cleanup();
  }
});

test('J3: expected_ids names EVERY matching candidate, unbounded by OUTPUT_AXIS_POINTER_CAP — the cap is a delivery-time concern, not an expectation-time one', () => {
  // SABOTAGE: truncate expected.hazards to 1 entry inside deriveExpected, pre-empting the cap check that belongs at parse/metrics time.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    const a = store.create(axisAntiPattern('AP-ALPHA'));
    const b = store.create(axisAntiPattern('AP-BETA'));
    const g = store.create(axisAntiPattern('AP-GAMMA'));
    const d = store.create(axisAntiPattern('AP-DELTA'));
    const entries = deriveExpected(store, {
      repoRoot: dir,
      outputAxisProbes: [{ rel: null, tool: 'Bash', tool_response: CONTENT_SENTENCE }],
    });
    const c = h23CaseOf(entries, 'Bash');
    assert.deepEqual(sorted(c.expected.hazards), sorted([a.id, b.id, g.id, d.id]), 'all 4 matches are named — capping to the real 1-line payload happens later, at parse/metrics time');
  } finally {
    cleanup();
  }
});

test('J4: an OBJECT-shaped tool_response computes the IDENTICAL expected set as its STRING equivalent', () => {
  // SABOTAGE: only match against string tool_response, treating an object as automatically non-matching (or throwing).
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    const ap = store.create(axisAntiPattern('AP-ALPHA'));
    const stringEntries = deriveExpected(store, {
      repoRoot: dir,
      outputAxisProbes: [{ rel: null, tool: 'Bash', tool_response: CONTENT_SENTENCE }],
    });
    const objectEntries = deriveExpected(store, {
      repoRoot: dir,
      outputAxisProbes: [{ rel: null, tool: 'Bash', tool_response: { stdout: CONTENT_SENTENCE, stderr: '', exitCode: 0 } }],
    });
    const stringCase = h23CaseOf(stringEntries, 'Bash');
    const objectCase = h23CaseOf(objectEntries, 'Bash');
    assert.deepEqual(objectCase.expected.hazards, stringCase.expected.hazards);
    assert.deepEqual(objectCase.expected.hazards, [ap.id]);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// GROUP K — synthesizePayload: the H23 output-axis payload (both tool_response forms).
// ===========================================================================

test('K0 CONTROL: an output_axis case carries stdin.tool_response; an ordinary H19 "bash" case with the SAME tool/rel does NOT — inclusion keys on payload_kind, not tool name', () => {
  // SABOTAGE: attach tool_response to every Bash-tooled case regardless of payload_kind.
  const synthesizePayload = fn('synthesizePayload');
  const outputAxis = synthesizePayload(
    { kind: 'case', payload_kind: 'output_axis', tool: 'Bash', rel: null, tool_response: CONTENT_SENTENCE },
    { cwd: SANDBOX }
  );
  const bashH19 = synthesizePayload({ kind: 'case', payload_kind: 'bash', rel: 'src/shared.mjs' }, { cwd: SANDBOX });
  assert.equal(outputAxis.stdin.tool_response, CONTENT_SENTENCE);
  assert.equal(Object.hasOwn(bashH19.stdin, 'tool_response'), false, 'H19\'s bash-pointer arm never carries content — only output_axis does');
});

test('K1: a STRING tool_response passes through byte-for-byte', () => {
  // SABOTAGE: JSON.stringify the string tool_response, corrupting it with quotes.
  const synthesizePayload = fn('synthesizePayload');
  const { stdin } = synthesizePayload(
    { kind: 'case', payload_kind: 'output_axis', tool: 'Bash', rel: null, tool_response: CONTENT_SENTENCE },
    { cwd: SANDBOX }
  );
  assert.equal(stdin.tool_response, CONTENT_SENTENCE);
  assert.equal(stdin.tool_name, 'Bash');
  assert.equal(stdin.hook_event_name, 'PostToolUse');
});

test('K2: an OBJECT tool_response is sent UNSTRINGIFIED — the real hook does its own stringification, so a pre-stringified payload would test a shape the platform never sends', () => {
  // SABOTAGE: JSON.stringify the object tool_response before putting it on stdin.
  const synthesizePayload = fn('synthesizePayload');
  const obj = { stdout: CONTENT_SENTENCE, stderr: '', exitCode: 0 };
  const { stdin } = synthesizePayload(
    { kind: 'case', payload_kind: 'output_axis', tool: 'Bash', rel: null, tool_response: obj },
    { cwd: SANDBOX }
  );
  assert.deepEqual(stdin.tool_response, obj);
  assert.equal(typeof stdin.tool_response, 'object');
});

test('K3: tool "Read" synthesizes an ABSOLUTE file_path under the sandbox cwd; tool "Bash" synthesizes a non-empty command — same rule B3/B2 already pin, extended to output_axis', () => {
  // SABOTAGE: emit case.rel unresolved (relative) for the Read arm, or omit tool_input.command for the Bash arm.
  const synthesizePayload = fn('synthesizePayload');
  const read = synthesizePayload(
    { kind: 'case', payload_kind: 'output_axis', tool: 'Read', rel: 'src/owned.mjs', tool_response: CONTENT_SENTENCE },
    { cwd: SANDBOX }
  );
  assert.equal(read.stdin.tool_input.file_path, join(SANDBOX, 'src/owned.mjs'));
  assert.equal(read.stdin.tool_name, 'Read');
  const bash = synthesizePayload(
    { kind: 'case', payload_kind: 'output_axis', tool: 'Bash', rel: null, tool_response: CONTENT_SENTENCE },
    { cwd: SANDBOX }
  );
  assert.equal(typeof bash.stdin.tool_input.command, 'string');
  assert.ok(bash.stdin.tool_input.command.length > 0);
  assert.equal(bash.stdin.tool_name, 'Bash');
});

// ===========================================================================
// GROUP L — parseDelivery: the H23 'output_axis_pointers' queue kind + disclosure tail.
// (Re-cut: this test-writer's first pass asserted 'output_axis', named as an
// explicit blind assumption — WRONG. Conductor-verified against the shipped
// hook at scripts/hooks/h23-output-axis.mjs:236: the real kind is
// 'output_axis_pointers'. Per anti_pattern 1b141d1f, a kind nothing emits is
// HOLLOW BY CONSTRUCTION — it would pass forever while auditing nothing, so
// this is a correctness fix, not a rename for style. No compatibility arm for
// the old name: that name is fiction and pinning it would be pinning fiction.)
// ===========================================================================

test('L0 CONTROL: a queue holding BOTH "output_axis_pointers" and "bash_pointers" entries partitions them into separate buckets — a fixture with only one kind could pass by accident, this one cannot', () => {
  // SABOTAGE: merge every kind into one bucket keyed by the first kind seen.
  const parseDelivery = fn('parseDelivery');
  const dir = makeSandbox();
  const oa = randomUUID();
  const bp = randomUUID();
  try {
    writePending(dir, [
      { kind: 'output_axis_pointers', rel: null, payload: `hazard (knowledge_get ${oa})` },
      { kind: 'bash_pointers', rel: 'src/b.mjs', payload: `owner (knowledge_get ${bp})` },
    ]);
    const p = parseDelivery({ code: 0, stdout: '', stderr: '' }, dir);
    assert.deepEqual(sorted(p.queued_by_kind.output_axis_pointers.flatMap((e) => e.ids)), [oa]);
    assert.deepEqual(sorted(p.queued_by_kind.bash_pointers.flatMap((e) => e.ids)), [bp]);
    assert.deepEqual(sorted(p.queued_ids), sorted([oa, bp]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L1: the "(+N more matched)" tail is parsed into a numeric suppressed_count per entry, using the SAME regex the hook\'s own frozen suite pins — a payload with no tail reports 0, never undefined or a hardcoded positive', () => {
  // SABOTAGE: hardcode suppressed_count to a fixed positive number, or read a different tail format than /\(\+(\d+) more matched\)/.
  const parseDelivery = fn('parseDelivery');
  const dir = makeSandbox();
  const shown = randomUUID();
  const untailed = randomUUID();
  try {
    writePending(dir, [
      { kind: 'output_axis_pointers', rel: null, payload: `hazard (knowledge_get ${shown}) (+3 more matched)` },
      { kind: 'output_axis_pointers', rel: null, payload: `hazard (knowledge_get ${untailed})` },
    ]);
    const p = parseDelivery({ code: 0, stdout: '', stderr: '' }, dir);
    const entries = p.queued_by_kind.output_axis_pointers;
    const withTail = entries.find((e) => e.ids.includes(shown));
    const withoutTail = entries.find((e) => e.ids.includes(untailed));
    assert.equal(withTail.suppressed_count, 3, 'AC7\'s own fixture proves 4 matched minus 1 shown leaves 3 suppressed — reusing that exact number here');
    assert.equal(withoutTail.suppressed_count, 0, 'no tail means nothing was suppressed, not "unmeasured"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// GROUP M — metrics/report: H23 joins the audited set; the stale disclosure is gone.
// ===========================================================================

test('M0 CONTROL: metrics().per_hook carries the "h23-output-axis.mjs" key ONLY when a case for it is present — presence is data-driven, not a hardcoded hook list', () => {
  // SABOTAGE: hardcode the per_hook key set to the four pre-existing hooks, ignoring what cases were actually passed in.
  const metrics = fn('metrics');
  const withH23 = metrics([mcase({ hook: 'h23-output-axis.mjs' })]).per_hook;
  const withoutH23 = metrics([mcase({ hook: 'h19-knowledge-delivery.mjs' })]).per_hook;
  assert.ok(Object.hasOwn(withH23, 'h23-output-axis.mjs'), 'a case for h23 produces its metrics bucket');
  assert.equal(Object.hasOwn(withoutH23, 'h23-output-axis.mjs'), false, 'no h23 case, no h23 bucket — nothing is special-cased into existing regardless of input');
});

test('M1: a capped H23 delivery (expected 3 hazards, only 1 delivered because OUTPUT_AXIS_POINTER_CAP=1) still scores a full per-case rendered_recall — the missing 2 are the disclosure tail\'s job (parseDelivery.suppressed_count), not a metrics-level partial miss', () => {
  // SABOTAGE: compute rendered_recall as delivered_ids.length / expected_ids.length per case instead of the boolean "rendered" flag — this must still read 1.0 for a capped-but-delivered case.
  const metrics = fn('metrics');
  const m = metrics([
    mcase({ hook: 'h23-output-axis.mjs', expected_ids: ['x', 'y', 'z'], delivered_ids: ['x'], rendered: true }),
  ]).per_hook['h23-output-axis.mjs'];
  assert.equal(m.rendered_recall, 1, 'case-level pass/fail, not an id-level fraction inside one payload');
  assert.equal(m.precision, 1, 'the one delivered id is a correct member of expected — capping does not manufacture noise');
});

test('M2: the module\'s own disclosure no longer claims H23 is unaudited, and still names the hook it now covers', () => {
  // SABOTAGE: wire the arm but leave the stale "H23 is NOT audited" comment/string in place (the exact Codex-review finding this arm exists to fix).
  const src = readFileSync(ORACLE, 'utf8');
  assert.doesNotMatch(src, /H23[\s\S]{0,120}not\s+audited/i, 'the stale disclosure must be removed once the arm is wired, not just left beside working code');
  assert.match(src, /h23-output-axis/i, 'the header must still name the hook, so the disclosure states what IS covered');
});

test('M3: a report containing an h23-output-axis.mjs case round-trips through writeRunReport unchanged — no hook is filtered out of the persisted report', () => {
  // SABOTAGE: filter cases to a fixed allow-list of hook names before writing the report.
  const writeRunReport = fn('writeRunReport');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-report-h23-'));
  try {
    const report = { ...REPORT(), cases: [...REPORT().cases, { fixture_id: 'f-h23', hook: 'h23-output-axis.mjs', expected_hash: 'h9', rendered: true }] };
    const { run_path } = writeRunReport(dir, report);
    const written = JSON.parse(readFileSync(run_path, 'utf8'));
    assert.ok(written.cases.some((cc) => cc.hook === 'h23-output-axis.mjs'), 'the h23 case survives the write untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// GROUP N — sandbox reset: the H23 output-axis guard joins the wholesale wipe
// (spec point: "a repeat within one guard window expects dedup"). The DEDUP
// BEHAVIOR ITSELF is h23-output-axis.mjs's own concern, already frozen at
// scripts/tests/h23-output-axis.test.mjs AC5 — re-pinning it here would
// violate this file's own charter (line 5: "They do NOT re-test H19/H20/
// H23/H10 themselves"). What the ORACLE must get right is the piece that IS
// its own: stale output-axis guard state surviving a reset would let ONE
// case's dedup state silently suppress the NEXT case's pointer, misreporting
// a real hook regression as a correct dedup — the exact G0/G1 failure mode,
// extended to this arm's own guard state. TIGHTENED (coder-reported, real
// shape): H23's guard state is NOT a separate file — it lives inside the SAME
// guard-conductor.json H19/H20 already use, as an `output_axis` field beside
// H19's `records`. Both pins below now seed and assert that exact field,
// byte-for-byte (G1's own style), instead of a fictional separate file.
// ===========================================================================

test('N0 CONTROL: an ordinary reset wipes guard-conductor.json\'s output_axis field along with everything else — no dedup state survives into the next case', () => {
  // SABOTAGE: resetSandbox preserves the output_axis key specifically while clearing/rewriting the rest of guard-conductor.json (a field-level wipe instead of the wholesale directory wipe G0 already requires).
  const resetSandbox = fn('resetSandbox');
  const dir = seededSandbox();
  const guardPath = join(dir, '.sterling', 'transient', 'delivery', 'guard-conductor.json');
  const guard = JSON.parse(readFileSync(guardPath, 'utf8'));
  writeFileSync(guardPath, JSON.stringify({ ...guard, output_axis: ['id-2'] }));
  try {
    resetSandbox(dir, { kind: 'case', fixture_id: 'f1' });
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'delivery')), false, 'the WHOLE delivery dir is wiped (G0\'s existing rule) — a surviving output_axis field would silently dedup the next case\'s otherwise-correct pointer into an apparent miss');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('N1: a case marked seed_output_axis_guard keeps guard-conductor.json — INCLUDING its output_axis field — byte-identical across reset, mirroring G1\'s seed_ledger contract for this arm\'s own guard field', () => {
  // SABOTAGE: ignore case.seed_output_axis_guard and always wipe wholesale, OR honour the flag for the file but strip the output_axis key specifically while preserving H19's records.
  const resetSandbox = fn('resetSandbox');
  const dir = seededSandbox();
  const guardPath = join(dir, '.sterling', 'transient', 'delivery', 'guard-conductor.json');
  const guard = JSON.parse(readFileSync(guardPath, 'utf8'));
  writeFileSync(guardPath, JSON.stringify({ ...guard, output_axis: ['id-2'] }));
  const before = readFileSync(guardPath, 'utf8');
  try {
    resetSandbox(dir, { kind: 'case', fixture_id: 'f1', seed_output_axis_guard: true });
    assert.equal(existsSync(guardPath), true, 'seeded guard-conductor.json survives so a dedup-suppression case can be exercised deliberately');
    assert.equal(readFileSync(guardPath, 'utf8'), before, 'the output_axis field survives byte-for-byte alongside H19\'s records field — a partial-field wipe is not a pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// GROUP O — H23 DEFECT 1 (independent review of slice 3D, board 5d462868):
// PATH EXCLUSIONS missing from the mirror. The real hook applies THREE gates
// in order on a Read: a `.git` / `.git/`-prefixed path is allowed (silent);
// a `.sterling/`-prefixed path is allowed (silent); only THEN ownership. The
// oracle's mirror implemented only the ownership gate, so a Read of a
// `.sterling/` path whose content matched a stored record made the oracle
// EXPECT a pointer and score H23's deliberate silence as a regression. Fix
// adds both guards with a new expected_reason value: 'path_excluded'.
//
// Per anti_pattern 1b141d1f (silence is multiply-caused), every arm below
// asserts the REASON, not just emptiness — an arm checking only
// "expected_ids is empty" would have passed under the OLD buggy mirror for
// the WRONG reason (it would read as a correct-but-coincidental match-miss,
// not as path exclusion), and is worthless as a regression pin for THIS
// defect. Reviewer's own proof this was unpinned: "Add a .git/.sterling
// early-allow to the mirror -> NOTHING goes red" against the pre-existing
// suite. O1-O3 below are built to go red under exactly that add (i.e. under
// its removal from a fixed mirror).
// ===========================================================================

test('O0 CONTROL: matching content on an ORDINARY unowned, non-excluded Read path DOES get the hazard pointer — proves the content clears the axis floor on its own, so O1-O3\'s silence below is provably about the PATH, not a content miss', () => {
  // SABOTAGE: remove the store record entirely (nothing could ever match) — would make O1-O3 vacuous rather than discriminating.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    const ap = store.create(axisAntiPattern('AP-ALPHA'));
    const entries = deriveExpected(store, {
      repoRoot: dir,
      outputAxisProbes: [{ rel: 'logs/unowned.log', tool: 'Read', tool_response: CONTENT_SENTENCE }],
    });
    const c = entries.find((e) => e.kind === 'case' && e.hook === 'h23-output-axis.mjs' && e.rel === 'logs/unowned.log');
    assert.ok(c, 'an ordinary unowned Read path gets a case');
    assert.deepEqual(c.expected_ids, [ap.id], 'the content matches on a plain, non-excluded path');
    assert.equal(c.expected_reason, undefined, 'a non-empty expected_ids carries no silence reason at all');
  } finally {
    cleanup();
  }
});

test('O1: a .sterling/-prefixed Read path with the SAME matching content is silently excluded — expected_reason "path_excluded", never "below_axis_floor"', () => {
  // SABOTAGE: delete the .sterling/-prefix early-allow gate from the mirror (fall through to ownership-only checking).
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    store.create(axisAntiPattern('AP-ALPHA'));
    const rel = '.sterling/transient/delivery/pending.json';
    const entries = deriveExpected(store, {
      repoRoot: dir,
      outputAxisProbes: [{ rel, tool: 'Read', tool_response: CONTENT_SENTENCE }],
    });
    const c = entries.find((e) => e.kind === 'case' && e.hook === 'h23-output-axis.mjs' && e.rel === rel);
    assert.ok(c, 'the excluded path still gets a case, never silently dropped');
    assert.deepEqual(c.expected_ids, [], 'excluded before content matching is ever consulted');
    assert.equal(c.expected_reason, 'path_excluded', 'silence here is a PATH gate, not a content-floor miss — O0 proves the identical content matches elsewhere');
  } finally {
    cleanup();
  }
});

test('O2: a .git/-prefixed Read path with the SAME matching content is silently excluded the same way', () => {
  // SABOTAGE: delete the .git/-prefix early-allow gate from the mirror.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    store.create(axisAntiPattern('AP-ALPHA'));
    const rel = '.git/HEAD';
    const entries = deriveExpected(store, {
      repoRoot: dir,
      outputAxisProbes: [{ rel, tool: 'Read', tool_response: CONTENT_SENTENCE }],
    });
    const c = entries.find((e) => e.kind === 'case' && e.hook === 'h23-output-axis.mjs' && e.rel === rel);
    assert.ok(c, 'the excluded path still gets a case');
    assert.deepEqual(c.expected_ids, []);
    assert.equal(c.expected_reason, 'path_excluded');
  } finally {
    cleanup();
  }
});

test('O3: the BARE ".git" path (no trailing slash, no prefix to match against) is ALSO excluded — a startsWith(".git/") check alone would miss this exact-equality case', () => {
  // SABOTAGE: implement the .git gate as rel.startsWith('.git/') only, never the exact-equality '.git' form.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    store.create(axisAntiPattern('AP-ALPHA'));
    const entries = deriveExpected(store, {
      repoRoot: dir,
      outputAxisProbes: [{ rel: '.git', tool: 'Read', tool_response: CONTENT_SENTENCE }],
    });
    const c = entries.find((e) => e.kind === 'case' && e.hook === 'h23-output-axis.mjs' && e.rel === '.git');
    assert.ok(c, 'the bare .git path still gets a case');
    assert.deepEqual(c.expected_ids, []);
    assert.equal(c.expected_reason, 'path_excluded');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// GROUP P — H23 DEFECT 2 (same review): an ABSENT tool_response THREW.
// `probe.tool_response === undefined` reached `JSON.stringify(undefined)` ->
// `undefined`, then `.slice()` threw a TypeError that aborted the WHOLE
// derivation — every H19 and H10 case built in the SAME deriveExpected call,
// not merely the one H23 case. The fix adds an explicit `raw == null` arm
// with its own NAMED reason, distinct from 'below_axis_floor' (which would
// mislabel "there was no response at all" as "the content did not match").
//
// The coder chooses the name for that reason; per this dispatch's
// instruction it is NOT guessed here — P1/P2 assert only that it is a
// non-empty string distinct from the two known reasons, and P1/P2's own
// comments flag that the exact value needs tightening once named.
// ===========================================================================

test('P0 CONTROL: an ORDINARY H19 case for an unrelated owned file is present in a derivation that ALSO carries an H23 probe — establishes the baseline P3 must not disturb', () => {
  // SABOTAGE: as a smoke check only — remove the axis-owner article, which would leave P3 unable to prove anything survived.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, ids, cleanup } = makeAxisFixtureRepo();
  try {
    const entries = deriveExpected(store, {
      repoRoot: dir,
      outputAxisProbes: [{ rel: null, tool: 'Bash', tool_response: CONTENT_SENTENCE }],
    });
    const h19 = caseFor(entries, 'src/owned.mjs', 'h19-knowledge-delivery.mjs');
    assert.ok(h19, 'the ordinary owned-file case is present alongside an H23 probe');
    assert.deepEqual(h19.expected.owners, [ids.owner]);
  } finally {
    cleanup();
  }
});

test('P1: a probe with tool_response ABSENT ENTIRELY does not throw, and gets its own case with the exact named reason \'no_tool_response\' (distinct from group O\'s \'path_excluded\')', () => {
  // SABOTAGE: revert to `JSON.stringify(probe.tool_response).slice(0, N)` with no `raw == null` guard — this must throw again on an absent field.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    const probes = [{ rel: null, tool: 'Bash' }]; // tool_response key entirely omitted
    let entries;
    assert.doesNotThrow(() => { entries = deriveExpected(store, { repoRoot: dir, outputAxisProbes: probes }); },
      'an absent tool_response must never abort the derivation');
    const c = h23CaseOf(entries, 'Bash');
    assert.ok(c, 'the probe still gets a case, never silently dropped');
    assert.deepEqual(c.expected_ids, []);
    assert.equal(c.expected_reason, 'no_tool_response', 'the coder-named reason for "there was no response at all" — must never be conflated with below_axis_floor, owned_suppressed, or group O\'s path_excluded');
  } finally {
    cleanup();
  }
});

test('P2: a probe with tool_response EXPLICITLY null behaves identically to one where the field is absent', () => {
  // SABOTAGE: guard only `probe.tool_response === undefined`, missing the `=== null` case (an explicit null still reaches JSON.stringify/.slice and throws).
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    const probes = [{ rel: null, tool: 'Bash', tool_response: null }];
    let entries;
    assert.doesNotThrow(() => { entries = deriveExpected(store, { repoRoot: dir, outputAxisProbes: probes }); });
    const c = h23CaseOf(entries, 'Bash');
    assert.ok(c);
    assert.deepEqual(c.expected_ids, []);
    assert.equal(c.expected_reason, 'no_tool_response');
  } finally {
    cleanup();
  }
});

test('P3 (THE ARM THAT MATTERS MOST): a case list containing an absent-tool_response H23 probe ALONGSIDE ordinary H19/H10 cases still returns the FULL expected set for those other cases — the real damage was the ABORT, not this one case\'s own reason', () => {
  // SABOTAGE: revert the raw==null guard so the H23 arm throws mid-loop, losing every H19/H10/H23 entry from the SAME deriveExpected call, not only this one probe's case.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, ids, cleanup } = makeAxisFixtureRepo();
  try {
    const probes = [{ rel: null, tool: 'Bash' }]; // tool_response absent
    const entries = deriveExpected(store, { repoRoot: dir, outputAxisProbes: probes });
    const h19 = caseFor(entries, 'src/owned.mjs', 'h19-knowledge-delivery.mjs');
    const h10 = caseFor(entries, 'src/owned.mjs', 'h10-direct-capture.mjs');
    assert.ok(h19, 'the unrelated H19 case for the owned file must survive a throw inside the H23 arm');
    assert.deepEqual(h19.expected.owners, [ids.owner]);
    assert.ok(h10, 'the unrelated H10 ownership case must also survive');
    assert.deepEqual(sorted(h10.expected_ids), [ids.owner]);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// GROUP Q — CENTRALITY ISOLATION. The reviewer flagged one of this
// test-writer's OWN prior sabotages as possibly unpinned: "replace
// hasRecordCentralityHit(x.record, clipped) with `true` -> J1 may stay
// GREEN, because the unrelated content likely fails at the term-overlap
// stage before centrality matters." If so, the mirror's OWN centrality
// scoring is unpinned by every existing arm in this file.
//
// This group isolates it with content that clears AXIS_MIN_HITS and the
// discriminating floor while sharing NONE of the record's own dominant
// (top-6) terms — the exact fixture shape scripts/tests/h20-centrality.test.mjs
// (a TEST file, not implementation) already proved clears term-overlap /
// discriminating while failing centrality, for the identical false-positive
// class (the 2026-08-09 Blender case) H20's own centrality floor exists to
// close. H23 mirrors H20's three floors verbatim per
// scripts/tests/h23-output-axis.test.mjs's own header comment ("the same
// three-floor axis discipline H20 already proved"), so the same fixture
// shape isolates the same floor here.
// ===========================================================================

const CENTRAL_TITLE = 'Boolean modifier mesh manifold topology solver stability failure';
const CENTRAL_TRIGGER =
  'boolean modifier boolean modifier mesh manifold mesh manifold topology solver topology solver ' +
  'recur constantly though this bug rarely touches a game field cell during setup work';
const CENTRAL_TERMS_CONTENT =
  'Investigate why the boolean operation corrupts the mesh: check whether the modifier stack introduces non-manifold geometry.';
const PERIPHERAL_ONLY_CONTENT =
  'Write tests for the game field cell logic: cover the game field cell grid, ' +
  'the field cell adjacency rules, and the game field cell lifecycle events.';

function centralityAntiPattern() {
  return {
    ...envelope('anti_pattern'),
    title: CENTRAL_TITLE,
    trigger: CENTRAL_TRIGGER,
    guidance: 'guidance prose',
    wrong_way: 'wrong way',
    right_way: 'right way',
    source_evidence: 'fixture',
    basis: 'codebase',
    severity: 'warn',
    file_keys: [],
  };
}

test('Q0 CONTROL: the SAME record fires when its own CENTRAL terms (boolean/mesh/modifier) appear in the content — proves the record IS reachable at all, so Q1\'s silence is provably about centrality, not a record that can never match', () => {
  // SABOTAGE: neuter the record (wrong title/trigger) so nothing could ever fire — would make Q1 vacuous rather than discriminating.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    const ap = store.create(centralityAntiPattern());
    const entries = deriveExpected(store, {
      repoRoot: dir,
      outputAxisProbes: [{ rel: null, tool: 'Bash', tool_response: CENTRAL_TERMS_CONTENT }],
    });
    const c = h23CaseOf(entries, 'Bash');
    assert.ok(c, 'a case is produced');
    assert.deepEqual(c.expected_ids, [ap.id], 'central-term content matches — the record is reachable at all');
  } finally {
    cleanup();
  }
});

test('Q1: content clearing term-overlap + the discriminating floor via ONLY the record\'s PERIPHERAL words (game/field/cell) stays silent — the mirror must independently score CENTRALITY, not merely count distinct hits', () => {
  // SABOTAGE: replace the mirror's own centrality check with an unconditional true (equivalent to deleting the call) — this content clears every OTHER floor on its own, so unlike J1's off-topic content (which fails earlier floors regardless of centrality), THIS input is the one that exposes a stubbed-true centrality check.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    const ap = store.create(centralityAntiPattern());
    const entries = deriveExpected(store, {
      repoRoot: dir,
      outputAxisProbes: [{ rel: null, tool: 'Bash', tool_response: PERIPHERAL_ONLY_CONTENT }],
    });
    const c = h23CaseOf(entries, 'Bash');
    assert.ok(c, 'a case is produced even though it is silent');
    assert.deepEqual(c.expected_ids, [], 'peripheral-only overlap (game/field/cell) is not centrality — the record must not be named');
    assert.ok(!c.expected.hazards.includes(ap.id), 'the record must not surface via its peripheral words alone');
    assert.equal(c.expected_reason, 'below_axis_floor', 'silent for a three-floor axis reason — centrality is one of the three, per this article\'s own contract');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// GROUP R — H23's two SILENT gates ahead of everything else (board f1e056bd
// item 3): deriveExpected's output-axis arm now mirrors h23-output-axis.mjs
// :134 (an unsupported tool — anything but Read/Bash/PowerShell — silences
// the arm with expected_reason 'unsupported_tool') and :137 (agent_id
// present, the conductor-only gate, silences it with 'agent_id_present'),
// CHECKED FIRST and in that exact order — ahead of the path-exclusion
// (Group O), no-tool-response (Group P) and ownership/content (Groups J/Q)
// gates already pinned above. Written blind (H4), from this dispatch's brief
// alone. outputAxisProbes entries gain an optional `agent_id` field
// alongside the existing rel/tool/tool_response (documented in the top
// contract comment above).
// ===========================================================================

test('R0 CONTROL: the SAME content over a SUPPORTED tool (Bash) matches the anti_pattern, while over an UNSUPPORTED tool (Grep) the case still exists but is silenced as "unsupported_tool" — proves the silence is about the TOOL, not a content miss', () => {
  // SABOTAGE: delete the tool-allowlist gate from the mirror.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    const ap = store.create(axisAntiPattern('AP-ALPHA'));
    const probes = [
      { rel: null, tool: 'Bash', tool_response: CONTENT_SENTENCE },
      { rel: null, tool: 'Grep', tool_response: CONTENT_SENTENCE },
    ];
    const entries = deriveExpected(store, { repoRoot: dir, outputAxisProbes: probes });
    const bashCase = h23CaseOf(entries, 'Bash');
    const grepCase = h23CaseOf(entries, 'Grep');
    assert.ok(bashCase, 'the supported-tool probe produces a case');
    assert.deepEqual(bashCase.expected.hazards, [ap.id], 'matching content over a supported tool gets the pointer');
    assert.ok(grepCase, 'the unsupported-tool probe still gets a case, never silently dropped');
    assert.deepEqual(grepCase.expected_ids, [], 'an unsupported tool is silent regardless of content match');
    assert.equal(grepCase.expected_reason, 'unsupported_tool', 'silent because the TOOL is unsupported — the Bash arm above proves the identical content DOES match');
  } finally {
    cleanup();
  }
});

test('R1: an agent_id present on the probe silences the arm even over a supported tool with matching content — expected_reason "agent_id_present" (the conductor-only gate; H23 stays silent for subagent-attributed touches)', () => {
  // SABOTAGE: delete the agent_id gate entirely, or move its check to AFTER content matching has already produced a match.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    store.create(axisAntiPattern('AP-ALPHA'));
    const probes = [{ rel: null, tool: 'Bash', tool_response: CONTENT_SENTENCE, agent_id: 'agent-123' }];
    const entries = deriveExpected(store, { repoRoot: dir, outputAxisProbes: probes });
    const c = h23CaseOf(entries, 'Bash');
    assert.ok(c, 'the probe still gets a case, never silently dropped');
    assert.deepEqual(c.expected_ids, [], 'a subagent-attributed touch is silent for H23 regardless of a content match');
    assert.equal(c.expected_reason, 'agent_id_present');
  } finally {
    cleanup();
  }
});

test('R2: an UNSUPPORTED tool WITH agent_id present reads as "unsupported_tool", not "agent_id_present" — the tool-allowlist gate runs FIRST, per h23-output-axis.mjs\'s own gate order', () => {
  // SABOTAGE: swap the gate order (check agent_id before the tool allowlist).
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    store.create(axisAntiPattern('AP-ALPHA'));
    const probes = [{ rel: null, tool: 'Grep', tool_response: CONTENT_SENTENCE, agent_id: 'agent-123' }];
    const entries = deriveExpected(store, { repoRoot: dir, outputAxisProbes: probes });
    const c = h23CaseOf(entries, 'Grep');
    assert.ok(c);
    assert.deepEqual(c.expected_ids, []);
    assert.equal(c.expected_reason, 'unsupported_tool', 'the tool gate is checked before the agent_id gate — R0 establishes what "unsupported_tool" alone looks like, R1 establishes what "agent_id_present" alone looks like, this is their combination');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// GROUP S — golden delivery scenarios (board ab288113, decision 08872881:
// "Golden delivery-scenario expectations stay IN the fixture JSON, guarded
// by a SHA-256 digest pin inside the frozen test file"). Fixtures live at
// scripts/tests/fixtures/delivery-golden/*.json, one whole scenario per
// file: { event, payload, expected_ids, expected_absent_ids, source_incident }.
// GOLDEN_DIGEST below is a LITERAL, minted over the canonical manifest of
// ONLY the expectations — {version:1, fixtures:[{file, expected_ids:[sorted],
// expected_absent_ids:[sorted]}]}, fixtures sorted by filename, canonical
// UTF-8 JSON — so a coder facing a red golden scenario cannot turn it green
// by editing expected_ids without ALSO producing a second, independent red
// right here inside the frozen test file (the exact bypass H5's wall exists
// to prevent). Stimulus fields (event/payload/source_incident) are
// deliberately NOT hashed — they would create churn without buying
// protection.
//
// AMBIGUITY RESOLVED HERE (flagged, not silently decided, per this file's
// own convention): loadGoldenFixtures is assumed to annotate each returned
// fixture with its source `file` (basename) alongside the four JSON fields —
// goldenManifest's {file, expected_ids, expected_absent_ids} contract needs
// it from somewhere, and nothing else in the declared interface supplies it.
//
// NOTE: no unit test here for runGoldenFixtures per this dispatch's
// instruction — it spawns real hook subprocesses over a sandbox project,
// which is exactly what the CLI-level gate (running the oracle for real)
// already covers; a mocked-subprocess unit test of it would pin the mock,
// not the wiring.
// ===========================================================================

const GOLDEN_DIR = join(root, 'scripts', 'tests', 'fixtures', 'delivery-golden');
const GOLDEN_DIGEST = '58d6cc2e892e1da16d896e2a2e38f81bcd09ac4064679c3bdd63c93c2fc68505';

test('S0: the five real golden scenarios load, and goldenManifestDigest matches the frozen literal — this ALSO serves as S1/S2\'s control: matching an exact, independently-minted 64-hex literal on real data rules out a stub/constant digest function', () => {
  // SABOTAGE: edit any one fixture's expected_ids in scripts/tests/fixtures/delivery-golden/ without re-minting GOLDEN_DIGEST above.
  const loadGoldenFixtures = fn('loadGoldenFixtures');
  const goldenManifestDigest = fn('goldenManifestDigest');
  const fixtures = loadGoldenFixtures(GOLDEN_DIR);
  assert.equal(fixtures.length, 5, 'all five seeded incident fixtures load');
  assert.equal(goldenManifestDigest(fixtures), GOLDEN_DIGEST, 'the frozen digest guards the fixture corpus\'s EXPECTATIONS');
});

test('S1: mutating source_incident on every fixture leaves the digest UNCHANGED — the digest covers only expectations, never stimulus/provenance (relies on S0 above as its control: S0 already proves the digest is a real, data-sensitive computation, not a constant)', () => {
  // SABOTAGE: fold source_incident (or event/payload) into the hashed manifest instead of only {file, expected_ids, expected_absent_ids}.
  const loadGoldenFixtures = fn('loadGoldenFixtures');
  const goldenManifestDigest = fn('goldenManifestDigest');
  const fixtures = loadGoldenFixtures(GOLDEN_DIR);
  const mutated = fixtures.map((f) => ({ ...f, source_incident: `mutated-for-S1-${f.file}` }));
  assert.equal(goldenManifestDigest(mutated), goldenManifestDigest(fixtures));
});

test('S2: appending a bogus id to ONE fixture\'s expected_ids MOVES the digest', () => {
  // SABOTAGE: build the canonical manifest from only {file} per fixture (or otherwise exclude expected_ids/expected_absent_ids from what gets hashed) — this must go red, because appending an id would no longer move the digest.
  const loadGoldenFixtures = fn('loadGoldenFixtures');
  const goldenManifestDigest = fn('goldenManifestDigest');
  const fixtures = loadGoldenFixtures(GOLDEN_DIR);
  const before = goldenManifestDigest(fixtures);
  const mutated = fixtures.map((f, i) => (i === 0 ? { ...f, expected_ids: [...f.expected_ids, 'bogus-id-added-for-s2'] } : f));
  assert.notEqual(goldenManifestDigest(mutated), before);
});

// AMBIGUITY RESOLVED HERE: every synthetic fixture from here on carries
// payload.tool_name and a real (event, tool_name) route — 'PostToolUse' +
// 'Read' (H23's own allowed-tool set per Group R above, and B3's file_touch
// convention already in this file: every synthesized stdin carries
// tool_name alongside tool_input) — so that S3/S5/S6/S7, which are NOT
// testing route validity, don't collide with S8's new route check below.
// Likewise every expected_ids/expected_absent_ids entry from here on is a
// syntactically valid UUID (matching this file's own UUID_RE shape) unless
// the test is S7 itself, and no fixture below leaves BOTH id arrays empty
// unless the test is S6 itself — both are now independent load-time
// refusals per the conductor's follow-up.
const ROUTABLE_PAYLOAD = { tool_name: 'Read' };
const UUID_A = '00000000-0000-0000-0000-000000000001';
const UUID_B = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

test('S3: goldenManifest sorts fixtures by FILENAME and sorts each fixture\'s id sets — synthetic fixtures, deliberately out of order, so the pin does not depend on the real corpus happening to already be sorted', () => {
  // SABOTAGE: emit the manifest in directory/load order instead of sorting by file, or emit id sets unsorted.
  const loadGoldenFixtures = fn('loadGoldenFixtures');
  const goldenManifest = fn('goldenManifest');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-golden-order-'));
  try {
    writeFileSync(join(dir, 'z-second.json'), JSON.stringify({ event: 'PostToolUse', payload: ROUTABLE_PAYLOAD, expected_ids: [UUID_B, UUID_A], expected_absent_ids: [UUID_B, UUID_A], source_incident: 'x' }));
    writeFileSync(join(dir, 'a-first.json'), JSON.stringify({ event: 'PostToolUse', payload: ROUTABLE_PAYLOAD, expected_ids: [UUID_A], expected_absent_ids: [], source_incident: 'y' }));
    const fixtures = loadGoldenFixtures(dir);
    const m = goldenManifest(fixtures);
    assert.deepEqual(m.fixtures.map((f) => f.file), ['a-first.json', 'z-second.json'], 'fixtures are ordered by FILENAME, not directory/load order');
    const second = m.fixtures.find((f) => f.file === 'z-second.json');
    assert.deepEqual(second.expected_ids, [UUID_A, UUID_B], 'each fixture\'s own id set is sorted');
    assert.deepEqual(second.expected_absent_ids, [UUID_A, UUID_B]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4: loadGoldenFixtures REFUSES a fixture missing `event`, naming the offending file', () => {
  // SABOTAGE: default a missing `event` to '' (or some other fallback) instead of throwing.
  const loadGoldenFixtures = fn('loadGoldenFixtures');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-golden-bad-'));
  try {
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ payload: {}, expected_ids: [], source_incident: 'x' }));
    let thrown = null;
    try {
      loadGoldenFixtures(dir);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'loadGoldenFixtures must throw on a fixture missing `event`');
    assert.match(thrown.message, /bad\.json/, 'the error names the offending file');
    assert.match(thrown.message, /event/, 'the error names the missing field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S5: expected_absent_ids defaults to [] when the fixture omits it entirely', () => {
  // SABOTAGE: leave expected_absent_ids undefined (rather than defaulting to []) when the field is absent.
  const loadGoldenFixtures = fn('loadGoldenFixtures');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-golden-noabsent-'));
  try {
    writeFileSync(join(dir, 'ok.json'), JSON.stringify({ event: 'PostToolUse', payload: ROUTABLE_PAYLOAD, expected_ids: [UUID_A], source_incident: 'x' }));
    const fixtures = loadGoldenFixtures(dir);
    assert.equal(fixtures.length, 1);
    assert.deepEqual(fixtures[0].expected_absent_ids, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// S6-S8 — three load-time refusals added after review (conductor follow-up,
// same dispatch). Same mkdtemp shape as S4/S5.
// ---------------------------------------------------------------------------

test('S6: a fixture whose expected_ids AND expected_absent_ids are BOTH empty is REFUSED, naming the file', () => {
  // SABOTAGE: drop the both-empty guard (accept a fixture that asserts nothing at all).
  const loadGoldenFixtures = fn('loadGoldenFixtures');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-golden-empty-'));
  try {
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ event: 'PostToolUse', payload: ROUTABLE_PAYLOAD, expected_ids: [], expected_absent_ids: [], source_incident: 'x' }));
    let thrown = null;
    try {
      loadGoldenFixtures(dir);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'a fixture with nothing to assert must be refused, not silently accepted as a vacuous pass');
    assert.match(thrown.message, /empty\.json/, 'the error names the offending file');
    assert.match(thrown.message, /empty/, 'the error names WHY: both id sets are empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S7: a non-UUID entry in expected_ids is REFUSED, naming the file and the field', () => {
  // SABOTAGE: drop UUID-shape validation on expected_ids entries (accept any string as a record id).
  const loadGoldenFixtures = fn('loadGoldenFixtures');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-golden-badid-'));
  try {
    writeFileSync(join(dir, 'badid.json'), JSON.stringify({ event: 'PostToolUse', payload: ROUTABLE_PAYLOAD, expected_ids: ['not-a-uuid'], expected_absent_ids: [], source_incident: 'x' }));
    let thrown = null;
    try {
      loadGoldenFixtures(dir);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'a malformed record id must be refused at load time, not silently carried into a run that can never match it');
    assert.match(thrown.message, /badid\.json/, 'the error names the offending file');
    assert.match(thrown.message, /expected_ids/, 'the error names the offending field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S8: an (event, tool_name) pair with no hook route — PostToolUse + Grep — is REFUSED at load time, naming the file, with a valid UUID present so only the route check can be at fault', () => {
  // SABOTAGE: drop the route-existence check (accept any event/tool_name pair, routing it nowhere at run time instead of refusing it up front).
  const loadGoldenFixtures = fn('loadGoldenFixtures');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-golden-noroute-'));
  try {
    writeFileSync(join(dir, 'noroute.json'), JSON.stringify({ event: 'PostToolUse', payload: { tool_name: 'Grep' }, expected_ids: [UUID_A], expected_absent_ids: [], source_incident: 'x' }));
    let thrown = null;
    try {
      loadGoldenFixtures(dir);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'a valid id and a valid event alone are not enough — the (event, tool_name) pair itself must resolve to a real hook route');
    assert.match(thrown.message, /noroute\.json/, 'the error names the offending file');
    assert.match(thrown.message, /hook route/, 'the error names WHY: no hook is registered for this event/tool_name pair');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// GROUP T — runGoldenFixtures miss-reason reporting (T0/T1) + deriveExpected's
// new exclusion classes and fields (T2-T5). Conductor follow-up, same
// dispatch, after the oracle coder applied the review follow-ups. Written
// blind (H4).
//
// T0/T1 EXERCISE runGoldenFixtures DIRECTLY — GROUP S's own header
// deliberately declined to unit-test it (real hook subprocesses; the CLI
// gate covers the wiring). This follow-up asks for it anyway, scoped
// narrowly to the MISS-REASON computation the conductor named, not the
// subprocess plumbing.
//
// AMBIGUITY DISCLOSED, NOT SILENTLY DECIDED (H4 blocks confirming any of
// this against scripts/delivery-oracle.mjs or the coder's own probe):
//  - RESOLVED by conductor follow-up (the coder fixed three real defects
//    behind T0/T1), TWICE — the return shape is a per-FIXTURE array of
//    result entries (`report` itself, or `report.results`/`report.fixtures`
//    when not a bare array); the miss dict lives on the entry, present only
//    when that fixture has missing_ids: `entry.misses[id] -> {miss_reason,
//    ...}` (delivery-oracle.mjs:1453-1468). firstGoldenResult() below reads
//    entry[0] defensively and asserts its shape, naming the actual keys on
//    failure, rather than a bare property-access crash. runGoldenFixtures no
//    longer takes a `repoRoot` option (dropped below — sandboxDir/snapshotDb
//    alone are the real surface).
//  - sandboxDir is passed as the SAME directory as repoRoot was — every
//    sandbox builder already in this file (makeFixtureRepo,
//    makeAxisFixtureRepo) uses exactly one project directory, never a
//    second one for the project root itself. Still unconfirmed by direct
//    read (H4).
//  - snapshotDb is produced via `store.snapshot(path)`, an INSTANCE method,
//    per article 79d2a189's own wording: "snapshots the WAL store via
//    SterlingStore.snapshot (VACUUM INTO)". Still unconfirmed by direct
//    read (H4).
//  - the fixture's `payload` field is shaped as an ordinary hook stdin body
//    (tool_name / tool_input.file_path / cwd), mirroring synthesizePayload's
//    own established shape (Group B) rather than a new one invented here.
// If either remaining assumption is wrong, T0/T1 fail at SETUP with a
// thrown error naming the missing method/shape — report that back to the
// conductor/coder rather than silently reshaping the test to match whatever
// the code actually does (that would anchor the oracle to the
// implementation, exactly what H4 exists to prevent).
//
// T2-T5 carry NO such risk — they call ONLY the already-proven, already-
// exported deriveExpected, through the same makeAxisFixtureRepo fixture and
// caseFor/exclusionFor helpers Groups A/J-R already use.
// ===========================================================================

const DECISION_POINTER_CAP = 8;

function firstGoldenResult(report) {
  const entry = Array.isArray(report) ? report[0] : (report.results ?? report.fixtures ?? [])[0];
  assert.ok(entry, `runGoldenFixtures must return at least one per-fixture result entry — got: ${JSON.stringify(report)}`);
  assert.equal(typeof entry.misses, 'object', `entry.misses must be an object naming the missing ids — entry keys were: ${Object.keys(entry).join(', ')}`);
  return entry;
}

function buildGoldenSandbox(files) {
  assert.ok(SterlingStore, 'packages/store/dist must be built for the oracle fixture (npm run build)');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oracle-golden-run-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  const init = git(dir, ['init', '-q']);
  assert.equal(init.status, 0, 'git is required to build the golden-run sandbox');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'golden-run fixture']);
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

test('T0: a golden MISS on an id genuinely eligible for the touched path, evicted by DECISION_POINTER_CAP\'s rendering tail, reports miss_reason "cap_evicted" with {rendered, suppressed_count, cap}', () => {
  // SABOTAGE: report a bare 'not_delivered' for every miss, never distinguishing a cap eviction from a true non-candidate.
  const runGoldenFixtures = fn('runGoldenFixtures');
  const { dir, store, cleanup } = buildGoldenSandbox({ 'src/hot.mjs': '// hot\n' });
  try {
    const decisions = [];
    for (let i = 0; i < DECISION_POINTER_CAP + 1; i++) {
      const extra = i === 0
        ? { file_keys: ['src/hot.mjs'], created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z' }
        : { file_keys: ['src/hot.mjs'] };
      decisions.push(store.create(axisDecision(`HOT-${i}`, extra)));
    }
    const oldest = decisions[0];
    const snapshotDb = join(dir, '.sterling', 'snapshot.db');
    store.snapshot(snapshotDb);
    const fixture = {
      file: 't0-cap-evicted.json',
      event: 'PostToolUse',
      payload: { tool_name: 'Read', tool_input: { file_path: join(dir, 'src', 'hot.mjs') }, cwd: dir },
      expected_ids: [oldest.id],
      expected_absent_ids: [],
      source_incident: 'T0 synthetic (conductor follow-up)',
    };
    const report = runGoldenFixtures([fixture], { sandboxDir: dir, snapshotDb });
    const entry = firstGoldenResult(report);
    const miss = entry.misses[oldest.id];
    assert.ok(miss, 'the evicted decision is reported as a miss, never silently absent from the report');
    assert.equal(miss.miss_reason, 'cap_evicted');
    assert.equal(miss.rendered, DECISION_POINTER_CAP);
    assert.equal(miss.suppressed_count, 1);
    assert.equal(miss.cap, DECISION_POINTER_CAP);
  } finally {
    cleanup();
  }
});

test('T1: a MISS on an id that was never a candidate for the touched path reports "not_delivered", with none of rendered/suppressed_count/cap present', () => {
  // SABOTAGE: attach rendered/suppressed_count/cap to every miss regardless of reason, collapsing the two miss classes into one shape.
  const runGoldenFixtures = fn('runGoldenFixtures');
  const { dir, store, cleanup } = buildGoldenSandbox({ 'src/hot.mjs': '// hot\n', 'src/cold.mjs': '// cold\n' });
  try {
    const stranger = store.create(axisDecision('STRANGER', { file_keys: ['src/cold.mjs'] }));
    const snapshotDb = join(dir, '.sterling', 'snapshot.db');
    store.snapshot(snapshotDb);
    const fixture = {
      file: 't1-not-delivered.json',
      event: 'PostToolUse',
      payload: { tool_name: 'Read', tool_input: { file_path: join(dir, 'src', 'hot.mjs') }, cwd: dir },
      expected_ids: [stranger.id],
      expected_absent_ids: [],
      source_incident: 'T1 synthetic (conductor follow-up)',
    };
    const report = runGoldenFixtures([fixture], { sandboxDir: dir, snapshotDb });
    const entry = firstGoldenResult(report);
    const miss = entry.misses[stranger.id];
    assert.ok(miss, 'the never-a-candidate id is still reported, never silently dropped');
    assert.equal(miss.miss_reason, 'not_delivered');
    assert.equal(Object.hasOwn(miss, 'rendered'), false, 'not_delivered carries no rendered field — that belongs to the cap_evicted shape only');
    assert.equal(Object.hasOwn(miss, 'suppressed_count'), false);
    assert.equal(Object.hasOwn(miss, 'cap'), false);
  } finally {
    cleanup();
  }
});

test('T2: a real FILE claim survives as an ordinary case when a DIFFERENT record claims a bogus path nested under it', () => {
  // SABOTAGE: once any record's file_keys names a path nested under a real file, treat the real file itself as excluded too (instead of excluding only the bogus nested claim).
  const deriveExpected = fn('deriveExpected');
  const { dir, store, ids, cleanup } = makeAxisFixtureRepo();
  try {
    const bogus = store.create(axisDecision('BOGUS-NESTED', { file_keys: ['src/owned.mjs/nested.mjs'] }));
    const entries = deriveExpected(store, { repoRoot: dir });
    const c = caseFor(entries, 'src/owned.mjs', 'h19-knowledge-delivery.mjs');
    assert.ok(c, 'the real file keeps its ordinary case');
    assert.deepEqual(sorted(c.expected.owners), [ids.owner], 'the bogus nested claim confers no ownership on the real file');
    const x = exclusionFor(entries, 'src/owned.mjs/nested.mjs');
    assert.ok(x, 'the bogus nested path is accounted for by name, not silently dropped');
    assert.equal(x.reason, 'descends_from_file_claim');
    assert.equal(x.record_id, bogus.id);
  } finally {
    cleanup();
  }
});

test('T3: a path that stats as a real DIRECTORY is excluded with reason "real_directory"', () => {
  // SABOTAGE: drop the is-directory check, letting a directory path fall through to an ordinary case.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    const dec = store.create(axisDecision('DIR-CLAIM', { file_keys: ['src'] }));
    const entries = deriveExpected(store, { repoRoot: dir });
    const x = exclusionFor(entries, 'src');
    assert.ok(x, 'a directory claim is accounted for by name, not silently dropped');
    assert.equal(x.reason, 'real_directory');
    assert.equal(x.record_id, dec.id);
    assert.equal(casesFor(entries, 'src').length, 0, 'a real directory never gets an ordinary case');
  } finally {
    cleanup();
  }
});

test('T4: an ABSENT path that is merely a STRING ancestor of another claim is excluded with reason "ancestor_of_claim" — distinct from T3\'s real_directory (this ancestor does not exist on disk at all)', () => {
  // SABOTAGE: collapse ancestor_of_claim into real_directory, or drop the ancestor check entirely, leaving the absent ancestor as an ordinary (nonexistent-but-claimed) case.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    const deep = store.create(axisDecision('DEEP-CLAIM', { file_keys: ['src/nested/deep.mjs'] }));
    const ancestor = store.create(axisDecision('ANCESTOR-CLAIM', { file_keys: ['src/nested'] }));
    const entries = deriveExpected(store, { repoRoot: dir });
    const deepCase = caseFor(entries, 'src/nested/deep.mjs', 'h19-knowledge-delivery.mjs');
    assert.ok(deepCase, 'the deeper, real claim still gets its ordinary case');
    assert.deepEqual(deepCase.expected.rationale, [deep.id], 'a decision confers RATIONALE, never ownership (A2b)');
    assert.deepEqual(deepCase.expected.owners, [], 'a decision never confers ownership (A2b)');
    const x = exclusionFor(entries, 'src/nested');
    assert.ok(x, 'the absent ancestor path is accounted for by name, not silently dropped');
    assert.equal(x.reason, 'ancestor_of_claim');
    assert.equal(x.record_id, ancestor.id);
  } finally {
    cleanup();
  }
});

test('T5: every exclusion carries record_ids (ALL claimants, deduped, record_id === record_ids[0]) plus `raw` — the STORED (post-normalization) spelling; record_ids is compared as a SET, since order follows the store\'s own query tiebreak, not creation order', () => {
  // SABOTAGE: report only the LAST claimant instead of the deduped full set, or drop the `raw` field entirely.
  const deriveExpected = fn('deriveExpected');
  const { dir, store, cleanup } = makeAxisFixtureRepo();
  try {
    mkdirSync(join(dir, 'a'));
    // CORRECTED per conductor follow-up: packages/schemas normalizeRepoPath
    // strips trailing slashes at store.create() TIME, so 'a/' can never
    // reach the oracle as 'a/' — both claims below are stored as the
    // identical normalized rel 'a', and `raw` reports that stored spelling,
    // not an unrecoverable pre-normalization one.
    const first = store.create(axisDecision('FIRST-CLAIM', { file_keys: ['a/'] }));
    const second = store.create(axisDecision('SECOND-CLAIM', { file_keys: ['a'] }));
    const entries = deriveExpected(store, { repoRoot: dir });
    const x = exclusionFor(entries, 'a');
    assert.ok(x, 'the shared directory claim is excluded and accounted for');
    assert.equal(x.reason, 'real_directory');
    assert.deepEqual([...x.record_ids].sort(), [first.id, second.id].sort(), 'every claimant is named, deduped — compared as a SET since the store\'s own query tiebreak decides order, not creation order');
    assert.equal(x.record_id, x.record_ids[0], 'record_id is the first of the full set, never an arbitrary pick independent of it');
    assert.equal(x.raw, 'a', 'raw is the STORED (already-normalized) spelling — normalizeRepoPath strips the trailing slash before the oracle ever sees it');
  } finally {
    cleanup();
  }
});
