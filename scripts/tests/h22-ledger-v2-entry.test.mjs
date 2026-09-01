// H22 REVIEW-LEDGER ENTRY v2 — WRITE SIDE (campaign slice S2b-1).
//
// Governing decision: knowledge_get 57984926-3bdc-4824-908e-b6ab2546be52
// (slug review-ledger-v2-lifecycle-refuse-flip-and-external-review-design).
// BINDING FOR THIS FILE: statement section (1) ONLY — the entry v2 shape +
// model provenance + family mapping + absent-path sentinels + v1
// non-migration, all on the H22 write side (SubagentStart snapshot,
// SubagentStop promotion). Sections (2)-(5) of that decision (the
// reviewed-bytes refuse flip, discharge verb, external_review recording,
// merge-reader trailer validation) are LATER slices and are deliberately NOT
// pinned here.
//
// Related shipped context relied on, never re-derived: decision 8f137474
// (review-territory-structured-receipt-files) already ships flat
// `files_source`/`attribution` fields on register entries and copies them
// unchanged into promoted ledger receipts (scripts/tests/
// h22-review-territory.test.mjs, tests T5/T5b/T6a/T6b) — this file reads
// v2's `territory.source`/`territory.attribution` as the nested home of
// those SAME already-shipped fields, per the launching brief's framing
// ("v2's territory.source extends it, it is not new").
//
// H4 BLINDNESS HONORED: scripts/hooks/h22-dispatch-register.mjs and
// scripts/hooks/lib/* were never opened. This file's harness idioms
// (spawnSync + JSON stdin, register/ledger path+read+write helpers, the
// makeProject/makeGitProject split) are adapted, without importing or
// modifying, from scripts/tests/h22-dispatch-register.test.mjs,
// scripts/tests/h22-review-ledger.test.mjs, scripts/tests/
// h22-review-territory.test.mjs, and scripts/tests/h22-receipt-expiry.test.mjs
// (all confirmed to exist via Glob/Read before writing). Standalone file: its
// own fixtures, no shared imports from any sibling test file, mirroring the
// established one-file-per-decision-slice convention for H22 ledger specs.
//
// ===========================================================================
// ASSUMPTIONS DISCLOSED (low-risk, named explicitly — not resolutions of an
// open ambiguity; flagged the same way scripts/tests/h22-receipt-expiry.test.mjs
// discloses its own):
//
//   (a) MODEL OBSERVATION CHANNEL: "H6-style transcript observation at Stop"
//       is read as: the DEPARTING SUBAGENT'S OWN transcript, supplied via
//       stdin.transcript_path on the SubagentStop call, carrying assistant
//       lines shaped `{type:'assistant', message:{model:'<id>', ...}}` — the
//       exact convention this suite ALREADY uses to signal a transcript's
//       active model (scripts/tests/h10-delegation-watch.test.mjs:125,144,332,356).
//       This is the established in-repo convention for "what model produced
//       this transcript line", not an invention.
//   (b) CONFIG.MODELS KEY NAMING — RESOLVED 2026-08-31 (Codex outside-family
//       review, thread 01a0586b; conductor-verified against
//       packages/schemas/src/config.ts:171-175): the real, single shared key
//       for every reviewer-* agent_type is `config.models.reviewers`. The
//       earlier hedge-across-five-invented-keys fixture MASKED a real defect
//       (it never proved the implementation reads the correct key at all) and
//       has been replaced below with the verified real shape. An explicit
//       ANTI-PIN (V2-3b-ANTI) now asserts the negative: a config carrying
//       ONLY an invented per-role key must never be read as configured.
//   (c) STARTED_AT PROVENANCE: decision 57984926 says "started_at, finished_at
//       (captured unconditionally at the START of Stop handling...)" — read
//       as: started_at is the pre-existing SubagentStart instant (today's
//       flat `at` field on the register entry, unchanged), finished_at is the
//       new field captured when Stop handling begins. Pinned by seeding a
//       known `at` on the register entry and asserting started_at echoes it.
//   (d) CONTENT_EVIDENCE.STATUS is read literally off the three-value enum
//       the decision itself names ('complete'|'partial'|'unavailable'):
//       every declared file present -> 'complete'; some present, some absent
//       -> 'partial'; every declared file absent -> 'unavailable'. This is a
//       direct reading of the named enum against the two shapes the "WHAT TO
//       PIN" brief explicitly describes, not an invention beyond it.
//
// ===========================================================================
// CONTRACT AMBIGUITY FLAGGED, NOT RESOLVED — reported loudly to the launching
// agent, not silently decided here:
//
//   Decision 57984926 states the v2 entry shape as NESTED objects
//   ({reviewer:{agent_type,...}, identity:{session_id,branch,base_sha},
//   territory:{files,...}}) replacing what were flat top-level fields on v1
//   entries. But TWO ALREADY-GREEN sibling pins assert an EXACT, flat,
//   six-key shape on every newly-promoted entry:
//     - scripts/tests/h22-review-ledger.test.mjs:157 —
//       `assert.deepEqual(Object.keys(entry).sort(), ['agent_type','at',
//       'base_sha','branch','files','session_id'])`
//     - scripts/tests/h22-receipt-expiry.test.mjs:231-235 — the same
//       exact-six-key assertion (test "A1").
//   If ALL new reviewer-* promotions become v2 (nested) as pin 1 of this
//   brief requires, those two exact-key-count assertions will go RED as a
//   DIRECT, unavoidable structural consequence — not from a defect in the
//   implementation of THIS slice, and not from a weakening of those tests
//   (which this role never does). This file pins the v2 shape LITERALLY as
//   decision 57984926 states it (nested), per the anti-invention constraint
//   against fabricating an unstated dual-shape/flat-mirroring compromise.
//   Whether v2 entries should ALSO carry flat legacy-shaped duplicate fields
//   (satisfying those two old pins) is a planning-level question this role
//   does not have standing to resolve — reported here for the conductor.
// ===========================================================================

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H22_HOOK = join(HOOKS, 'h22-dispatch-register.mjs');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// ---------------------------------------------------------------------------
// shared fixture plumbing
// ---------------------------------------------------------------------------

// REAL config shape (thread 01a0586b, decision 57984926, verified against
// packages/schemas/src/config.ts:171-175): `reviewers` is the ONE shared
// config.models key for every reviewer-* agent_type. Do NOT reintroduce
// invented per-role keys here — that shape previously masked a real defect.
function modelsConfig(model, effort = 'low') {
  return { reviewers: { model, effort } };
}

// ANTI-PIN fixture (V2-3b-ANTI): a config carrying ONLY an invented per-role
// key, deliberately omitting the real `reviewers` key — the implementation
// must never fall back to guessing a per-role key.
function invalidRoleKeyedModelsConfig(model, effort = 'low') {
  return { 'reviewer-correctness': { model, effort } };
}

const CONFIG_BASE = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function writeConfig(dir, overrides = {}) {
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ ...CONFIG_BASE, ...overrides }));
}

function makeProject(configOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-v2-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeConfig(dir, configOverrides);
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeGitProject(branchName = 'main', configOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-v2-git-'));
  git(dir, ['init', '-b', branchName]);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeConfig(dir, configOverrides);
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'seed']);
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [H22_HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function h22Input(dir, over = {}) {
  return {
    session_id: 's1',
    transcript_path: join(dir, 't', 'parent.jsonl'),
    cwd: dir,
    prompt_id: 'pr-1',
    agent_id: 'agent-1',
    agent_type: 'coder',
    hook_event_name: 'SubagentStop',
    ...over,
  };
}

function registerPath(dir) {
  return join(dir, '.sterling', 'transient', 'dispatch-register.json');
}
function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

function ledgerPath(dir) {
  return join(dir, '.sterling', 'review-ledger.json');
}
function ledgerExists(dir) {
  return existsSync(ledgerPath(dir));
}
function readLedgerRaw(dir) {
  return readFileSync(ledgerPath(dir), 'utf8');
}
function readLedger(dir) {
  return JSON.parse(readLedgerRaw(dir));
}
function writeLedgerRaw(dir, content) {
  writeFileSync(ledgerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

const registerEntry = (over = {}) => ({
  agent_id: 'rev-1',
  agent_type: 'reviewer-correctness',
  session_id: 's1',
  files: [],
  at: new Date().toISOString(),
  ...over,
});

function touchFile(dir, relPath, content = '// content\n') {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// Child-transcript convention (assumption (a)): the departing subagent's own
// transcript, carrying `message.model` on assistant lines when a model was
// observed. `observedModel` omitted -> a transcript with assistant content
// but NO model field at all (the "does not yield" case).
function writeChildTranscript(dir, name, observedModel) {
  const p = join(dir, 't', name);
  mkdirSync(dirname(p), { recursive: true });
  const message = observedModel ? { model: observedModel, content: [{ type: 'text', text: 'work done' }] } : { content: [{ type: 'text', text: 'work done, no model field' }] };
  writeFileSync(p, JSON.stringify({ type: 'assistant', message }) + '\n');
  return p;
}

// Parent-transcript helper, needed only for the one pin (V2-3b) that must
// exercise a REAL SubagentStart to prove the config snapshot is taken at
// Start time, not read lazily at Stop.
function writeParentTranscript(dir, prompt, subagentType, name = 'parent.jsonl') {
  const p = join(dir, 't', name);
  mkdirSync(dirname(p), { recursive: true });
  const line = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: subagentType, prompt } }] } };
  writeFileSync(p, JSON.stringify(line) + '\n');
  return p;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function findEntryByFile(ledger, file) {
  return ledger.find((e) => {
    const files = e?.territory?.files ?? e?.files;
    return Array.isArray(files) && files.includes(file);
  });
}

// ===========================================================================
// V2-1 — full v2 entry shape on a reviewer-* promotion (pin 1)
//
// EXPECTED RED today: today's promotion writes the flat six-key
// {agent_type, files, at, base_sha, branch, session_id} shape (per
// scripts/tests/h22-review-ledger.test.mjs / h22-receipt-expiry.test.mjs).
// `entry.schema_version` is undefined -> fails the FIRST assertion.
// SABOTAGE: implement every OTHER v2 field correctly but hardcode
// `schema_version: 1` (or omit it) on the promoted object literal — this
// single assertion alone must go red while every other v2-1 assertion could
// stay green, proving schema_version is independently load-bearing.
// ===========================================================================

test('V2-1: a reviewer-* SubagentStop promotion writes a full v2 entry (schema_version, entry_id, kind, status, timestamps, reviewer, identity, territory, disposition)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject('sterling/v2-entry-slice');
  try {
    touchFile(dir, 'src/a.mjs');
    touchFile(dir, 'src/b.mjs');
    const startedAt = '2026-08-30T10:00:00.000Z';
    writeRegisterRaw(dir, [
      registerEntry({
        agent_id: 'rev-v2-1',
        agent_type: 'reviewer-correctness',
        files: ['src/a.mjs', 'src/b.mjs'],
        files_source: 'review-territory',
        attribution: 'block',
        at: startedAt,
      }),
    ]);
    writeChildTranscript(dir, 'child-v2-1.jsonl'); // no observed model — irrelevant to this pin

    const r = runHook(h22Input(dir, { agent_id: 'rev-v2-1', transcript_path: join(dir, 't', 'child-v2-1.jsonl') }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(ledgerExists(dir), 'a review ledger receipt was promoted');

    const ledger = readLedger(dir);
    assert.equal(ledger.length, 1);
    const entry = ledger[0];

    assert.equal(entry.schema_version, 2, 'new entries are v2');
    assert.match(entry.entry_id, UUID_RE, 'entry_id is a uuid');
    assert.equal(entry.kind, 'roster_receipt');
    assert.equal(entry.status, 'active');

    assert.equal(entry.started_at, startedAt, "started_at echoes the pre-existing Start instant (the register entry's `at`)");
    assert.ok(entry.finished_at && !Number.isNaN(Date.parse(entry.finished_at)), 'finished_at is a parseable timestamp');
    assert.ok(Date.parse(entry.finished_at) >= Date.parse(entry.started_at), 'finished_at is at or after started_at');

    assert.equal(entry.reviewer?.agent_type, 'reviewer-correctness');
    assert.ok(['observed', 'configured', 'unknown'].includes(entry.reviewer?.model_source), 'model_source is one of the three named provenance states');

    assert.equal(entry.identity?.session_id, 's1');
    assert.equal(entry.identity?.branch, 'sterling/v2-entry-slice');
    assert.match(entry.identity?.base_sha ?? '', SHA_RE);

    assert.deepEqual([...(entry.territory?.files ?? [])].sort(), ['src/a.mjs', 'src/b.mjs']);
    assert.equal(entry.territory?.source, 'review-territory', "territory.source is the nested home of the already-shipped files_source field");
    assert.equal(entry.territory?.attribution, 'block', 'territory.attribution is the nested home of the already-shipped attribution field');

    assert.equal(entry.content_evidence?.status, 'complete', 'both declared files exist on disk — content evidence is complete');
    assert.deepEqual(entry.content_evidence?.absent_paths, [], 'nothing absent — the sentinel array is present but empty');
    assert.notEqual(entry.content_evidence?.blobs, undefined, 'some blob evidence was recorded for the present files');

    assert.equal(entry.disposition, null);

    // entry_id uniqueness across two promotions in the same ledger.
    writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-v2-1b', agent_type: 'reviewer-security', files: [], at: startedAt })]);
    writeChildTranscript(dir, 'child-v2-1b.jsonl');
    const r2 = runHook(h22Input(dir, { agent_id: 'rev-v2-1b', transcript_path: join(dir, 't', 'child-v2-1b.jsonl') }), dir);
    assert.equal(r2.code, 0, r2.stderr);
    const ledger2 = readLedger(dir);
    assert.equal(ledger2.length, 2);
    assert.notEqual(ledger2[0].entry_id, ledger2[1].entry_id, 'two promotions mint two distinct entry_ids');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// V2-2 — finished_at is captured UNCONDITIONALLY, even when no file could be
// hashed at all (pin 2).
//
// EXPECTED RED today: today's flat entry has no finished_at field at all —
// `entry.finished_at` is undefined, failing the `assert.ok` below.
// SABOTAGE: move the `finished_at = new Date().toISOString()` capture to
// INSIDE the content-evidence hashing block (e.g. only set it after a
// successful file read/hash) — with the sole declared file absent, that
// block never successfully hashes anything, so finished_at is never set and
// this test goes red while V2-1 (whose files DO exist) stays green.
// ===========================================================================

test('V2-2: finished_at is present even when the sole declared file cannot be hashed at all (absent on disk)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-v2-2', files: ['src/does-not-exist.mjs'] })]);
    writeChildTranscript(dir, 'child-v2-2.jsonl');

    const r = runHook(h22Input(dir, { agent_id: 'rev-v2-2', transcript_path: join(dir, 't', 'child-v2-2.jsonl') }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ledger = readLedger(dir);
    assert.equal(ledger.length, 1);
    const entry = ledger[0];
    assert.ok(entry.finished_at && !Number.isNaN(Date.parse(entry.finished_at)), 'finished_at is captured unconditionally, independent of whether any content evidence was recoverable');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// V2-3a — observed model wins: model_source:'observed', model = the
// transcript-observed id (pin 3a).
//
// EXPECTED RED today: `entry.reviewer` does not exist at all today (flat v1
// shape) — fails the FIRST assertion (`entry.reviewer?.model_source`
// resolves to `undefined`, not `'observed'`).
// SABOTAGE: after landing model provenance, always report model_source:
// 'configured' (never check the transcript for an observed model) — this
// test goes red while a config-fixture-only pin (V2-3c) could stay green.
// ===========================================================================

test('V2-3a: an observed model in the departing transcript wins — model_source:"observed", model = the observed id', () => {
  const { dir, cleanup } = makeProject({ models: modelsConfig('claude-configured-should-lose') });
  try {
    writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-v2-3a', files: [] })]);
    writeChildTranscript(dir, 'child-v2-3a.jsonl', 'claude-observed-winner');

    const r = runHook(h22Input(dir, { agent_id: 'rev-v2-3a', transcript_path: join(dir, 't', 'child-v2-3a.jsonl') }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = readLedger(dir)[0];
    assert.equal(entry.reviewer?.model_source, 'observed');
    assert.equal(entry.reviewer?.model, 'claude-observed-winner');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// V2-3b — configured snapshot is taken at SubagentSTART, not read lazily at
// Stop (pin 3b). Config is mutated to a DIFFERENT model value between the
// real Start call and the real Stop call; the promoted entry must carry the
// Start-time value.
//
// EXPECTED RED today: `entry.reviewer` does not exist at all today — fails
// the model equality assertion (`undefined !== 'claude-t1-snapshot'`).
// SABOTAGE: read config.models fresh at Stop time instead of snapshotting it
// at Start (e.g. re-parse .sterling/config.json inside the SubagentStop
// handler with no Start-time carrier) — the promoted entry would then carry
// 'claude-t2-changed' (the post-mutation value), flipping this assertion
// red while V2-3a (which never depends on timing) stays green.
// ===========================================================================

test('V2-3b: no observed model, config.models CHANGES between Start and Stop — the entry carries the START-time configured snapshot, model_source:"configured"', () => {
  const { dir, cleanup } = makeProject({ models: modelsConfig('claude-t1-snapshot') });
  try {
    touchFile(dir, 'src/snap.mjs');
    writeParentTranscript(dir, 'REVIEW-TERRITORY: ["src/snap.mjs"]\nplease review', 'reviewer-correctness');

    const start = runHook(
      h22Input(dir, { agent_id: 'rev-v2-3b', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStart', transcript_path: join(dir, 't', 'parent.jsonl') }),
      dir
    );
    assert.equal(start.code, 0, start.stderr);

    // Mutate config AFTER Start, BEFORE Stop — a lazy Stop-time read would
    // now see a different model than what Start observed.
    writeConfig(dir, { models: modelsConfig('claude-t2-changed') });
    writeChildTranscript(dir, 'child-v2-3b.jsonl'); // no observed model — forces the configured fallback

    const stop = runHook(h22Input(dir, { agent_id: 'rev-v2-3b', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', transcript_path: join(dir, 't', 'child-v2-3b.jsonl') }), dir);
    assert.equal(stop.code, 0, stop.stderr);

    const entry = readLedger(dir)[0];
    assert.equal(entry.reviewer?.model_source, 'configured');
    assert.equal(entry.reviewer?.model, 'claude-t1-snapshot', 'the START-time configured snapshot is used, never a live re-read at Stop');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// V2-3b-ANTI — Codex outside-family review, thread 01a0586b + decision 57984926
// (cited 2026-08-31): an ANTI-PIN against guessing a per-role config.models
// key. A config carrying ONLY an invented key (e.g. `reviewer-correctness`)
// and NOT the real shared `reviewers` key must never be read as a configured
// snapshot — it must degrade to model_source:'unknown', exactly as if no
// `models` config existed at all.
//
// EXPECTED RED today: `entry.reviewer` does not exist at all today — fails
// the model_source equality assertion.
// SABOTAGE: read `config.models[agent_type]` (or any other per-role lookup)
// as a fallback when `config.models.reviewers` is absent — this test would
// then observe model_source:'configured' and model:'claude-should-never-be-read',
// flipping both assertions red while V2-3b (which supplies the REAL key)
// stays green — that asymmetry is exactly why this is its own test.
// ===========================================================================

test('V2-3b-ANTI: a config carrying ONLY an invented per-role key (no real "reviewers" key) never yields model_source:"configured" — the implementation must not guess per-role keys', () => {
  const { dir, cleanup } = makeProject({ models: invalidRoleKeyedModelsConfig('claude-should-never-be-read') });
  try {
    touchFile(dir, 'src/snap-anti.mjs');
    writeParentTranscript(dir, 'REVIEW-TERRITORY: ["src/snap-anti.mjs"]\nplease review', 'reviewer-correctness');

    const start = runHook(
      h22Input(dir, { agent_id: 'rev-v2-3b-anti', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStart', transcript_path: join(dir, 't', 'parent.jsonl') }),
      dir
    );
    assert.equal(start.code, 0, start.stderr);

    writeChildTranscript(dir, 'child-v2-3b-anti.jsonl'); // no observed model — forces the configured/unknown fallback

    const stop = runHook(
      h22Input(dir, { agent_id: 'rev-v2-3b-anti', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', transcript_path: join(dir, 't', 'child-v2-3b-anti.jsonl') }),
      dir
    );
    assert.equal(stop.code, 0, stop.stderr);

    const entry = readLedger(dir)[0];
    assert.equal(entry.reviewer?.model_source, 'unknown', 'an invented per-role key must never be read as the configured reviewer model');
    assert.equal(entry.reviewer?.model, null);
    assert.equal(entry.reviewer?.model_family, 'unknown');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// V2-3c — neither observed nor configured available: model:null,
// model_family:'unknown', model_source:'unknown' — never a guess (pin 3c).
//
// EXPECTED RED today: `entry.reviewer` does not exist at all today — fails
// the model_source equality assertion (`undefined !== 'unknown'`).
// SABOTAGE: when no model can be resolved, default model_family to
// 'anthropic' (or any non-'unknown' guess) instead of 'unknown' — this
// assertion alone flips red while V2-3a/3b (which both resolve a real model)
// stay green, proving the "never a guess" branch is independently pinned.
// ===========================================================================

test('V2-3c: no observed model and no configured model available — model:null, model_family:"unknown", model_source:"unknown"', () => {
  const { dir, cleanup } = makeProject({}); // no `models` key at all
  try {
    writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-v2-3c', files: [] })]);
    writeChildTranscript(dir, 'child-v2-3c.jsonl'); // no observed model

    const r = runHook(h22Input(dir, { agent_id: 'rev-v2-3c', transcript_path: join(dir, 't', 'child-v2-3c.jsonl') }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = readLedger(dir)[0];
    assert.equal(entry.reviewer?.model, null);
    assert.equal(entry.reviewer?.model_family, 'unknown');
    assert.equal(entry.reviewer?.model_source, 'unknown');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// V2-4 — anchored model-family mapping, including the explicit anti-pin
// against a broad `o*` -> openai rule (pin 4).
//
// EXPECTED RED today: `entry.reviewer` does not exist at all today — every
// sub-case fails on the model_family equality assertion.
// SABOTAGE (the anti-pin, most important): implement family mapping as
// `/^o/i.test(model) ? 'openai' : ...` (or any other broad "starts with o"
// heuristic) instead of the anchored `^claude-`/`^gpt-`/`^codex` patterns —
// the 'other-model' case (which also starts with 'o') would then be
// misclassified as 'openai' instead of 'unknown', flipping ONLY that
// sub-assertion red while 'claude-opus-5'/'gpt-5.2'/'codex-something' all
// stay green (a broad rule still gets the real vendor prefixes right,
// which is exactly why this case is the one that catches it).
// ===========================================================================

test('V2-4: model-family mapping is anchored-prefix only — an "o*" model NOT matching a real vendor prefix maps to "unknown", never "openai"', () => {
  const cases = [
    ['claude-opus-5', 'anthropic'],
    ['gpt-5.2', 'openai'],
    ['codex-something', 'openai'],
    ['other-model', 'unknown'], // THE ANTI-PIN: starts with 'o', must NOT fall into openai
    ['zzz-mystery-9', 'unknown'],
  ];
  for (const [model, expectedFamily] of cases) {
    const { dir, cleanup } = makeProject();
    try {
      writeRegisterRaw(dir, [registerEntry({ agent_id: `rev-v2-4-${model}`, files: [] })]);
      writeChildTranscript(dir, 'child.jsonl', model);
      const r = runHook(h22Input(dir, { agent_id: `rev-v2-4-${model}`, transcript_path: join(dir, 't', 'child.jsonl') }), dir);
      assert.equal(r.code, 0, r.stderr);
      const entry = readLedger(dir)[0];
      assert.equal(entry.reviewer?.model, model);
      assert.equal(entry.reviewer?.model_family, expectedFamily, `model "${model}" must map to family "${expectedFamily}"`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// V2-5a — a declared file absent at Stop (a reviewed deletion) records an
// absence sentinel while the remaining present file is still evidenced
// (pin 5, partial case).
//
// EXPECTED RED today: `entry.content_evidence` does not exist at all
// today — fails the FIRST assertion.
// SABOTAGE: on encountering an absent declared path, DROP it from the
// receipt entirely (silently shrink territory.files / skip it) instead of
// recording it in absent_paths[] — this test's absent_paths assertion goes
// red while the present-file evidence assertion could stay green, proving
// the sentinel recording is independently pinned from the evidence-gathering
// of the files that DO exist.
// ===========================================================================

test('V2-5a: a declared file absent on disk (reviewed deletion) records an absence sentinel; the present sibling is still evidenced (status:"partial")', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchFile(dir, 'src/present.mjs');
    writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-v2-5a', files: ['src/present.mjs', 'src/deleted.mjs'] })]);
    writeChildTranscript(dir, 'child-v2-5a.jsonl');

    const r = runHook(h22Input(dir, { agent_id: 'rev-v2-5a', transcript_path: join(dir, 't', 'child-v2-5a.jsonl') }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = readLedger(dir)[0];

    assert.ok(entry.finished_at, 'still promotes with finished_at, despite one absent file');
    assert.ok(Array.isArray(entry.content_evidence?.absent_paths), 'absent_paths is an array');
    assert.deepEqual(entry.content_evidence.absent_paths, ['src/deleted.mjs'], 'the absent declared file is recorded as a sentinel, not silently dropped');
    assert.equal(entry.content_evidence.status, 'partial', 'one present + one absent file yields partial content evidence');
    assert.notEqual(entry.content_evidence?.blobs, undefined, 'the present sibling still contributes recorded content evidence');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// V2-5b — every declared file is absent: the receipt STILL promotes (never
// omits evidence entirely), finished_at present, absent_paths fully
// populated (pin 5, all-absent case).
//
// EXPECTED RED today: `entry.content_evidence` does not exist at all
// today — fails the FIRST assertion.
// SABOTAGE: when every declared file is absent, skip the promotion entirely
// (treat it as "nothing to promote" and leave the register entry deleted
// with no ledger write) instead of still appending a receipt with sentinel
// evidence — `ledgerExists(dir)` goes false, failing the very first
// assertion in this test while V2-5a (which has one present file) stays
// green, proving the ALL-absent path is independently exercised.
// ===========================================================================

test('V2-5b: EVERY declared file is absent — the receipt still promotes with finished_at and a fully-populated absent_paths, never omitted', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-v2-5b', files: ['src/gone-a.mjs', 'src/gone-b.mjs'] })]);
    writeChildTranscript(dir, 'child-v2-5b.jsonl');

    const r = runHook(h22Input(dir, { agent_id: 'rev-v2-5b', transcript_path: join(dir, 't', 'child-v2-5b.jsonl') }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(ledgerExists(dir), 'a receipt is promoted even though every declared file is absent');
    const entry = readLedger(dir)[0];

    assert.ok(entry.finished_at && !Number.isNaN(Date.parse(entry.finished_at)), 'finished_at is present unconditionally');
    assert.deepEqual([...entry.content_evidence.absent_paths].sort(), ['src/gone-a.mjs', 'src/gone-b.mjs']);
    assert.equal(entry.content_evidence.status, 'unavailable', 'no content evidence is recoverable at all when every declared file is absent');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// V2-HASH-FAIL (MED-3, Codex outside-family review thread 01a0586b + decision
// 57984926, cited 2026-08-31): a declared file that IS present on disk but
// whose hash cannot be produced (permission denied) must not be reported as
// 'complete' evidence with nothing actually recovered — that would be a
// FALSE ASSURANCE (status says success, no blob backs it).
//
// HARNESS CHOICE, DISCLOSED: of the three failure modes the launching brief
// named (vanish-between-check-and-hash, unreadable path, fixture-injected
// failing git), only the UNREADABLE-PATH form is reliably driveable from this
// fixture set without inventing a new git/process-mocking seam this role has
// no standing to add. `chmodSync(path, 0o000)` is the established convention
// for this in this exact suite (scripts/tests/h22-receipt-expiry.test.mjs
// already imports chmodSync for a permission-failure fixture; restore-before-
// cleanup mirrors that file's pattern). CAVEAT, matching that same file's own
// disclosed caveat: chmod 0o000 does not block a ROOT-executed test process,
// so this test SKIPS with a stated reason when running as uid 0, rather than
// silently passing for the wrong reason.
//
// EXPECTED: RED if the write-side is reachable and honest reporting is not
// yet implemented; GREEN if it already is. Per the brief: "if reachable, pin
// it" — this fixture IS reachable on a normal (non-root) host.
// SABOTAGE: on a hash-read exception, still report content_evidence.status
// 'complete' (e.g. catch-and-ignore, leaving blobs empty/undefined) instead
// of 'partial'/'unavailable' with a failure_reason — the status/failure_reason
// assertions below go red while V2-1 (whose declared files ARE readable)
// stays green.
// ===========================================================================

test(
  'V2-HASH-FAIL: a declared, PRESENT file whose hash cannot be produced (permission denied) is never reported as "complete" evidence',
  { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'running as root — chmod 0o000 does not block root reads, so this fixture cannot drive a hash failure on this host' : false },
  () => {
    const { dir, cleanup } = makeProject();
    const target = join(dir, 'src', 'unreadable.mjs');
    try {
      touchFile(dir, 'src/unreadable.mjs');
      chmodSync(target, 0o000);
      writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-v2-hashfail', files: ['src/unreadable.mjs'] })]);
      writeChildTranscript(dir, 'child-v2-hashfail.jsonl');

      let r;
      try {
        r = runHook(h22Input(dir, { agent_id: 'rev-v2-hashfail', transcript_path: join(dir, 't', 'child-v2-hashfail.jsonl') }), dir);
      } finally {
        // restore BEFORE cleanup's rmSync, or the temp-dir removal itself can EACCES.
        try {
          chmodSync(target, 0o644);
        } catch {
          // already gone or already writable — fine either way.
        }
      }
      assert.equal(r.code, 0, r.stderr);
      const entry = readLedger(dir)[0];
      assert.ok(entry.finished_at, 'still promotes with finished_at, despite the unreadable file');
      assert.notEqual(entry.content_evidence?.status, 'complete', 'a file that exists but cannot be hashed must never report complete evidence with nothing actually recovered');
      assert.ok(
        ['partial', 'unavailable'].includes(entry.content_evidence?.status),
        `status must honestly reflect the hash failure (partial or unavailable), got ${JSON.stringify(entry.content_evidence?.status)}`
      );
      assert.ok(entry.content_evidence?.failure_reason, 'a failure_reason is recorded naming why the hash could not be produced');
      assert.ok(
        !(entry.content_evidence?.absent_paths ?? []).includes('src/unreadable.mjs'),
        'the file EXISTS on disk — an unreadable file must never be misreported as an ABSENT path, a different failure class'
      );
    } finally {
      cleanup();
    }
  }
);

// ===========================================================================
// V2-6 — pre-existing v1 entries in the ledger file are structurally
// byte-identical after a new v2 promotion appends beside them; no in-place
// migration (pin 6).
//
// EXPECTED STATE: LIKELY GREEN TRIVIALLY even today, since today's hook has
// no v2 concept at all and simply appends the (today-shaped) promoted object
// after whatever was already in the file — flagged explicitly per the
// brief's "flag any pin that is unexpectedly green" instruction. It remains
// a necessary regression pin once v2 promotion ships (an implementation that
// "upgrades" every entry it touches on write would break it).
// SABOTAGE: on ANY promotion, rewrite every existing ledger entry to add
// `schema_version: 1` (or any other field) for consistency/migration
// purposes — the v1 entry's key set changes, flipping the
// `assert.deepEqual(Object.keys(v1After).sort(), Object.keys(v1Before).sort())`
// assertion red while the NEW entry's own v2-shape assertions (covered by
// V2-1) are completely unaffected either way.
// ===========================================================================

test('V2-6: a pre-existing v1 ledger entry is structurally untouched after a new v2 promotion appends beside it (no in-place migration)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const v1Entry = { agent_type: 'reviewer-skeptic', files: ['src/prior.mjs'], at: '2026-08-20T00:00:00.000Z', base_sha: 'a'.repeat(40), branch: 'main', session_id: 's0' };
    writeLedgerRaw(dir, [v1Entry]);

    writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-v2-6', files: ['src/new.mjs'] })]);
    writeChildTranscript(dir, 'child-v2-6.jsonl');
    const r = runHook(h22Input(dir, { agent_id: 'rev-v2-6', transcript_path: join(dir, 't', 'child-v2-6.jsonl') }), dir);
    assert.equal(r.code, 0, r.stderr);

    const ledger = readLedger(dir);
    assert.equal(ledger.length, 2, 'the new v2 entry is appended beside the v1 entry, never replacing it');
    const v1After = ledger.find((e) => Array.isArray(e.files) && e.files.includes('src/prior.mjs'));
    assert.ok(v1After, 'the original v1 entry is still findable by its files');
    assert.deepEqual(v1After, v1Entry, 'the pre-existing v1 entry is structurally byte-identical — no field added, removed, or changed');
    assert.equal(JSON.stringify(v1After), JSON.stringify(v1Entry), 'stringified form matches too (no key-order drift from an in-place rewrite)');

    const v2After = findEntryByFile(ledger, 'src/new.mjs');
    assert.ok(v2After, 'the newly-promoted entry is present');
    assert.equal(v2After.schema_version, 2, 'the newly-promoted entry is v2, independent of the v1 entry sitting beside it');
  } finally {
    cleanup();
  }
});
