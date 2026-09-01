// REVIEW-LEDGER `record-external` — EXPLICIT-ONLY EXTERNAL REVIEW RECORDING
// (campaign slice S2b-4; decision 57984926, slug
// review-ledger-v2-lifecycle-refuse-flip-and-external-review-design, §4
// "EXTERNAL REVIEW").
//
// SPEC-ONLY, RED-FIRST. The `record-external` verb DOES NOT EXIST YET — the
// review-ledger CLI ships exactly one verb today (`discharge`, per the owning
// article 'review-ledger-cli'). Every pin below therefore fails on an
// ASSERTION (an unknown verb exits non-zero with a usage/refusal on stderr, or
// exits 0 writing nothing), never on a harness crash: spawnSync always returns.
//
// Authored from the decision record (opened via knowledge_get; §4 quoted
// verbatim below) and the launching brief — NOT from any implementation. H4
// read wall honored: this file's author never Read nor content-Grepped
// scripts/review-ledger.mjs, scripts/commit-reviewed.mjs or
// scripts/direct-merge.mjs; only sibling TEST files were read, for harness
// conventions (review-ledger-discharge.test.mjs, commit-reviewed.test.mjs,
// commit-reviewed-file-scoping.test.mjs).
//
// SPEC UNDER TEST (decision 57984926 §4, verbatim):
//   "(4) EXTERNAL REVIEW: minted ONLY by an explicit conductor-run
//    scripts/review-ledger.mjs record-external (repeatable --file args,
//    --provider, --model-or-null, --thread-id, round/consult id for idempotency
//    — one thread can hold several review rounds — --note sanitized and
//    bounded); this is conductor-attested evidence of a completed consult, not
//    proof; H29 stays untouched, no keyword inference; external entries carry
//    NO agent_type, are never spendable, never stamped, never counted by roster
//    eligibility (kind gate + agent-type regex, belt and braces), and if
//    external provenance ever reaches commits it uses a distinct
//    External-Review: trailer, never Reviewed-By-Agent."
// And, from §1 (entry v2), the fields an entry of ANY kind carries:
//   "{schema_version:2, entry_id (uuid), kind:'roster_receipt'|'external_review',
//    status:'active'|'discharged', started_at, finished_at, reviewer{...},
//    identity{...}, territory{files[], source, attribution}, content_evidence{...},
//    disposition:null}"
//
// ===========================================================================
// ASSUMED INTERFACE — STATED SO THE CONDUCTOR CAN ADJUDICATE BEFORE THE CODER
// LOCKS IT. §4 fixes the SEMANTICS (repeatable files, provider, nullable model,
// thread id, round for idempotency, bounded sanitized note) but names no flag
// spellings and no field PATHS inside the entry. This file assumes:
//
//     node scripts/review-ledger.mjs record-external \
//       --file <repo-relative path>   # repeatable, >=1 required
//       --provider <openai|...>       # required
//       --model <id>                  # OPTIONAL — omitted means null, never invented
//       --thread-id <id>              # required
//       --round <n>                   # the within-thread consult round
//       --note "<single-line text>"   # sanitized + bounded
//
//   * cwd is the project root; the ledger is .sterling/review-ledger.json
//     (the path every sibling commit-reviewed/review-ledger suite uses).
//   * exit 0 = recorded; non-zero = refused. Refusals speak on stderr.
//   * STERLING_SESSION_ID is the current-session seam (documented in
//     commit-reviewed-file-scoping.test.mjs's runCommitReviewedEnv).
//   IF THE CODER PICKS DIFFERENT SPELLINGS, THIS FILE'S FLAG NAMES ARE THE
//   THING TO CHANGE — the assertions inside each test are the spec and stand
//   unchanged. Every flag-name red is a naming adjudication, not a defect.
//
// WHY THE ASSERTIONS ARE SHAPE-AGNOSTIC WHERE THE SPEC IS SILENT: §4 requires
// provider / model / thread / round / note / files to be RECORDED but does not
// say under which keys (reviewer.provider? external.thread_id? consult.round?).
// Pinning invented field paths would test the coder's naming, not the spec, and
// would go red for the wrong reason. So this file asserts:
//   - STRUCTURALLY, only what §1/§4 fix by name: schema_version, kind, status,
//     entry_id, the ABSENCE of agent_type, and (for the nullable model) that no
//     key literally named `model` holds a fabricated string;
//   - SUBSTANTIVELY, that each supplied value appears somewhere in the entry
//     (a leaf-value scan) — "recorded" is the spec's word, and a value absent
//     from every leaf is not recorded under ANY naming.
//
// AMBIGUITIES FLAGGED, NOT RESOLVED (reported to the launching agent):
//   (a) CONCURRENCY TOKEN: `discharge` requires --digest (§3). §4 does not say
//       whether record-external does. This file passes NO digest — an append is
//       not a state flip on an existing entry. If the coder requires one, every
//       command here needs a --digest and that is a naming/design adjudication.
//   (b) FIELD PATHS for provider/model/thread/round/note (see above).
//   (c) IDEMPOTENCY VERDICT: §4 says the round/consult id exists "for
//       idempotency" but not whether a repeat exits 0 as a no-op or refuses.
//       X2b pins the INVARIANT that holds under either (never two entries, the
//       first entry never rewritten, the duplicate always disclosed).
//   (d) EMPTY --note: neither §4 nor the brief rules. X4c pins only that the
//       CLI neither crashes nor writes a malformed entry, under either reading.
//   (e) --round REQUIREDNESS is not stated; no pin asserts it missing/refused.
//   (f) EXACT BOUND on note length is not stated. X4b pins 5000 chars as
//       "clearly overlong" per the brief; the real bound is the coder's to pick
//       and only a bound ABOVE 5000 would contradict this pin.
//   (g) TERRITORY SOURCE for an external entry (§1's 'review-territory' vs
//       'free-prose-fallback') is unspecified — no pin constrains it.
// ===========================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER_CLI = join(root, 'scripts', 'review-ledger.mjs');
const COMMIT_CLI = join(root, 'scripts', 'commit-reviewed.mjs');

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };

// Anti-pattern ee89c3fd guard: flatten before interpolating into a message.
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-record-external-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  writeFileSync(join(dir, 'src', 'laneA.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'laneB.mjs'), 'export const b = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function ledgerPath(dir) {
  return join(dir, '.sterling', 'review-ledger.json');
}
function writeLedger(dir, entries) {
  writeFileSync(ledgerPath(dir), JSON.stringify(entries));
}
function readLedger(dir) {
  return existsSync(ledgerPath(dir)) ? JSON.parse(readFileSync(ledgerPath(dir), 'utf8')) : null;
}
function readLedgerRaw(dir) {
  return existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null;
}

function stageChange(dir, relPath, content) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}
function stagedBlob(dir, relPath) {
  return git(dir, ['hash-object', relPath]);
}

function runLedger(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [LEDGER_CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runCommitReviewed(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [COMMIT_CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function reviewedByTrailers(dir, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)', sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}

// ---- shape-agnostic readers (see "WHY THE ASSERTIONS ARE SHAPE-AGNOSTIC") ----

// Every primitive leaf of the entry, stringified. "Recorded" under ANY naming.
function leaves(v, out = []) {
  if (v === null || v === undefined) return out;
  if (Array.isArray(v)) {
    for (const x of v) leaves(x, out);
    return out;
  }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) leaves(v[k], out);
    return out;
  }
  out.push(String(v));
  return out;
}

// Values held under a key of EXACTLY this name, at any depth (so `model` never
// collides with `model_family` / `model_source`).
function valuesAtKey(v, name, out = []) {
  if (v === null || typeof v !== 'object') return out;
  if (Array.isArray(v)) {
    for (const x of v) valuesAtKey(x, name, out);
    return out;
  }
  for (const k of Object.keys(v)) {
    if (k === name) out.push(v[k]);
    valuesAtKey(v[k], name, out);
  }
  return out;
}

// True if `wanted` is recorded somewhere in the entry, whatever the field name.
function records(entry, wanted) {
  return leaves(entry).includes(String(wanted));
}

// A v2 ROSTER receipt (decision 57984926 §1) — the same helper shape
// review-ledger-discharge.test.mjs uses, kept local so this file is
// independently runnable.
function rosterV2({
  entry_id,
  agent_type,
  files,
  blobs = {},
  base_sha,
  session_id = SESSION,
  branch = 'main',
  at = isoAgo(60_000),
}) {
  return {
    schema_version: 2,
    entry_id,
    kind: 'roster_receipt',
    status: 'active',
    started_at: at,
    finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id, branch, base_sha },
    territory: { files, source: 'review-territory', attribution: 'block' },
    content_evidence: { status: 'complete', blobs, absent_paths: [], truncated_of: null, failure_reason: null },
    disposition: null,
  };
}

const ROSTER_ID = 'e0000000-0000-4000-8000-00000000000b';
const PROVIDER = 'openai';
const MODEL = 'gpt-5.2';
const THREAD = 'thread-01a057ee';
const NOTE = 'round 2 review of the ledger lifecycle slice; two HIGH findings adjudicated';

function recordExternalArgs({
  files = ['src/laneA.mjs', 'src/laneB.mjs'],
  provider = PROVIDER,
  model = MODEL,
  threadId = THREAD,
  round = 4,
  note = NOTE,
} = {}) {
  const args = ['record-external'];
  for (const f of files) args.push('--file', f);
  if (provider !== null) args.push('--provider', provider);
  if (model !== null) args.push('--model', model);
  if (threadId !== null) args.push('--thread-id', threadId);
  if (round !== null) args.push('--round', String(round));
  if (note !== null) args.push('--note', note);
  return args;
}

const externals = (ledger) => (ledger ?? []).filter((e) => e && e.kind === 'external_review');

// ===========================================================================
// X0 — THE HAPPY PATH (CONTROL, PLACED FIRST).
// Every refusal pin in this file (X4a, X4b, X5a-c) and every "exactly one
// entry" pin (X2b) would be satisfied identically by a `record-external` that
// refuses EVERYTHING — including the verb not existing at all, which is today's
// state. This pin is the evidence that they are not: without X0 green, no
// refusal pin in this file carries a verdict.
// ===========================================================================

// EXPECTED STATE: RED today — `record-external` is not a verb, so the spawn
// exits non-zero and the FIRST assertion (`r.code === 0`) fails, with
// stdout/stderr embedded in the message.
// SABOTAGE (kind half): mint the entry with kind:'roster_receipt' (or omit
// `kind`) -> the kind assertion and `externals(after).length === 1` go red.
// That is the ONE field the whole never-spendable design keys on (§4's "kind
// gate"), so an entry minted without it is a forged roster receipt.
// SABOTAGE (agent_type half): copy the roster entry builder and leave
// reviewer.agent_type in place (e.g. 'codex' or 'external') -> the
// no-agent_type assertion goes red while kind stays green. Two INDEPENDENT
// guards, and §4 demands both ("kind gate + agent-type regex, belt and
// braces") — that is why both are asserted here rather than one standing in
// for the other.
// SABOTAGE (append half): write the ledger as [external] instead of appending
// -> `after.length === 2` and the bystander deepEqual go red; a recording verb
// that destroys live roster evidence is the worst outcome in this file.
test('record-external X0 (CONTROL, first): a consult is recorded as ONE v2 external_review entry — provider/model/thread/round/note/files recorded, NO agent_type anywhere, existing roster evidence untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const roster = rosterV2({ entry_id: ROSTER_ID, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], base_sha: head });
    writeLedger(dir, [roster]);

    const r = runLedger(dir, recordExternalArgs());
    assert.equal(r.code, 0, `a well-formed record-external must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    const after = readLedger(dir);
    assert.ok(Array.isArray(after), `the ledger is still valid JSON holding an array — raw=${flat(readLedgerRaw(dir))}`);
    assert.equal(after.length, 2, `exactly ONE entry is APPENDED — the existing roster receipt is neither replaced nor dropped — got ${JSON.stringify(after)}`);
    assert.deepEqual(
      after.find((e) => e.entry_id === ROSTER_ID),
      roster,
      'the pre-existing roster receipt is byte-for-byte untouched — recording a consult never rewrites review evidence'
    );

    const ext = externals(after);
    assert.equal(ext.length, 1, `exactly one entry carries kind:'external_review' — got ${JSON.stringify(ext)}`);
    const e = ext[0];

    // §1's named fields for ANY v2 entry.
    assert.equal(e.schema_version, 2, 'an external entry is a v2 entry — legacy readers must never mistake it for a v1 roster receipt');
    assert.equal(e.kind, 'external_review', "kind is the gate the never-spendable rule keys on");
    assert.equal(e.status, 'active', "§1's status enum is 'active'|'discharged'; a freshly recorded entry is active");
    assert.equal(typeof e.entry_id, 'string', `entry_id is a string — got ${JSON.stringify(e.entry_id)}`);
    assert.notEqual(e.entry_id.trim(), '', 'entry_id is non-empty — it is the addressing handle every v2 lifecycle operation uses');
    assert.notEqual(e.entry_id, ROSTER_ID, 'and it is its own id, never the neighbouring entry’s');

    // §4 verbatim: "external entries carry NO agent_type".
    assert.deepEqual(
      valuesAtKey(e, 'agent_type'),
      [],
      `NO agent_type anywhere in an external entry — an agent_type is what roster eligibility matches on, so carrying one is how this entry would become spendable: ${JSON.stringify(e)}`
    );

    // §4: the consult's provenance is RECORDED (field naming is the coder's —
    // see ambiguity (b); "recorded" is asserted shape-agnostically).
    assert.ok(records(e, PROVIDER), `the PROVIDER is recorded — got ${JSON.stringify(e)}`);
    assert.ok(records(e, MODEL), `the MODEL is recorded — got ${JSON.stringify(e)}`);
    assert.ok(records(e, THREAD), `the THREAD ID is recorded — got ${JSON.stringify(e)}`);
    assert.ok(records(e, 4), `the ROUND is recorded — one thread holds several review rounds, so the round is the only thing distinguishing them — got ${JSON.stringify(e)}`);
    assert.ok(records(e, NOTE), `the NOTE is recorded verbatim — it is the conductor's attestation of what the consult was — got ${JSON.stringify(e)}`);
    assert.ok(records(e, 'src/laneA.mjs'), `the first --file is recorded — got ${JSON.stringify(e)}`);
    assert.ok(records(e, 'src/laneB.mjs'), `the second --file is recorded — --file is REPEATABLE, so dropping all but one is a real defect — got ${JSON.stringify(e)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (the verb does not exist; `r.code === 0` fires).
// SABOTAGE: default a missing --model to the provider's flagship, to the
// literal string 'unknown', or to the configured reviewer model -> the
// valuesAtKey('model') assertion (every value null) and the no-fabricated-model
// leaf scan go red. §4 spells the parameter "--model-or-null" precisely because
// a consult whose model the conductor cannot observe must record ABSENCE; an
// invented model turns conductor-attested evidence into a false provenance
// claim, which is the one thing §4 says this entry is NOT ("evidence of a
// completed consult, not proof").
test('record-external X1: --model is optional — omitting it records null/absent, never a fabricated model, and the entry is otherwise well-formed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeLedger(dir, []);
    const r = runLedger(dir, recordExternalArgs({ model: null }));
    assert.equal(r.code, 0, `an unknown model must not block recording the consult — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    const ext = externals(readLedger(dir));
    assert.equal(ext.length, 1, `the entry is still recorded — got ${JSON.stringify(readLedger(dir))}`);
    const e = ext[0];
    assert.equal(e.kind, 'external_review', 'still an external_review entry');
    assert.ok(records(e, PROVIDER), 'the provider is still recorded — only the model was unknown');

    for (const v of valuesAtKey(e, 'model')) {
      assert.equal(v, null, `every field literally named 'model' is null when --model was omitted — got ${JSON.stringify(v)} in ${JSON.stringify(e)}`);
    }
    assert.ok(
      !leaves(e).some((l) => /gpt|claude|opus|sonnet|haiku|codex/i.test(l)),
      `no model identifier is invented anywhere in the entry — got ${JSON.stringify(e)}`
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// X2 — IDEMPOTENCY ON (thread-id, round). CONTROL FIRST.
// ===========================================================================

// EXPECTED STATE: RED today (the verb does not exist; the first `code === 0`
// fires).
// PLACED BEFORE X2b as its control: X2b's verdict ("one entry") has a second
// possible cause — a CLI that keys idempotency on the THREAD alone, or one that
// simply never appends twice for any reason. This arm must pass for the
// OPPOSITE reason: same thread, different round -> TWO entries.
// SABOTAGE: key the duplicate check on --thread-id only (dropping round) ->
// this arm collapses to one entry and goes red, while X2b stays green. §4 is
// explicit: "one thread can hold several review rounds".
test('record-external X2a (CONTROL): the SAME thread at a DIFFERENT round records a SECOND entry — one thread holds several review rounds', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeLedger(dir, []);
    const first = runLedger(dir, recordExternalArgs({ round: 1, note: 'round 1: shape' }));
    assert.equal(first.code, 0, `round 1 records — stdout=${first.stdout} stderr=${flat(first.stderr)}`);
    const second = runLedger(dir, recordExternalArgs({ round: 2, note: 'round 2: the concrete mechanism' }));
    assert.equal(second.code, 0, `round 2 of the SAME thread is a distinct consult and records too — stdout=${second.stdout} stderr=${flat(second.stderr)}`);

    const ext = externals(readLedger(dir));
    assert.equal(ext.length, 2, `two rounds of one thread are two entries — got ${JSON.stringify(ext)}`);
    assert.notEqual(ext[0].entry_id, ext[1].entry_id, 'each round gets its own entry_id');
    assert.ok(ext.some((e) => records(e, 1)) && ext.some((e) => records(e, 2)), `both rounds are recorded — got ${JSON.stringify(ext)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (the verb does not exist; the first `code === 0`
// fires).
// SABOTAGE: append unconditionally (no (thread, round) duplicate check) -> the
// `length === 1` assertion goes red with two entries. A re-run of a recorded
// consult is the natural conductor mistake (the command is hand-typed), and a
// ledger that doubles its own evidence on a re-run cannot be counted — the
// count is exactly what a reader of external review evidence wants.
// EITHER-READING (ambiguity (c)): the exit code is asserted only as "not a
// crash"; what is pinned is that the SECOND run adds nothing, rewrites nothing,
// and DISCLOSES the duplicate rather than passing silently (P5).
test('record-external X2b: re-running the IDENTICAL command (same thread-id + round) never yields two entries — the first entry is preserved verbatim and the duplicate is disclosed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeLedger(dir, []);
    const args = recordExternalArgs({ round: 1 });

    const first = runLedger(dir, args);
    assert.equal(first.code, 0, `the first recording succeeds — stdout=${first.stdout} stderr=${flat(first.stderr)}`);
    const afterFirst = readLedger(dir);
    assert.equal(externals(afterFirst).length, 1, 'precondition: exactly one external entry after the first run');

    const second = runLedger(dir, args);
    assert.doesNotMatch(second.stderr, /TypeError|ReferenceError/, `a repeat recording must never crash — stderr=${flat(second.stderr)}`);

    const afterSecond = readLedger(dir);
    assert.equal(
      externals(afterSecond).length,
      1,
      `a repeated (thread-id, round) is ONE consult and stays ONE entry, whether the CLI no-ops or refuses — got ${JSON.stringify(afterSecond)}`
    );
    assert.deepEqual(afterSecond, afterFirst, 'and the recorded entry is preserved verbatim — a repeat never rewrites the first attestation');

    const combined = `${second.stdout}\n${second.stderr}`;
    assert.match(
      combined,
      /duplicate|already|idempot|exists|recorded|no-?op|same (thread|round|consult)/i,
      `the duplicate is DISCLOSED, never silently swallowed — the conductor must learn the second run did nothing — got: ${flat(combined)}`
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// X3 — NEVER SPENDABLE (§4: external entries "are never spendable, never
// stamped, never counted by roster eligibility"). CONTROL FIRST.
// ===========================================================================

// EXPECTED STATE: GREEN today — this is the ordinary v2 roster spend path
// (the same fixture shape review-ledger-discharge.test.mjs's D4 control uses).
// PLACED FIRST in this family: X3b's verdict ("the commit refuses") and X3c's
// ("only the roster receipt is stamped") both have a second possible cause —
// the commit surface refusing/stamping-nothing for an unrelated reason (a v2
// adapter defect, a bytes-evidence refusal, a broken fixture). This arm is
// X3b/X3c's fixture MINUS the external entry, and must pass for the opposite
// reason.
// SABOTAGE: break the v2 roster spend path at all (e.g. require content
// evidence this fixture does not carry) -> this control goes red, and X3b's
// refusal is exposed as meaningless.
test('record-external X3a (CONTROL): a plain v2 roster receipt covering the staged file still stamps and consumes normally — the spend path works in this fixture', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', 'export const a = 2;\n');
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      rosterV2({
        entry_id: ROSTER_ID,
        agent_type: 'reviewer-correctness',
        files: ['src/laneA.mjs'],
        blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') },
        base_sha: head,
      }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'X3a control: roster receipt spends']);
    assert.equal(r.code, 0, `a covering roster receipt must commit — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'the roster receipt is stamped');
    assert.deepEqual(readLedger(dir), [], 'and consumed');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today. `record-external` does not exist, so the FIRST
// assertion (`rec.code === 0`) fires. (Once the verb ships but the spending
// gate does not, the red moves to `r.code === 1`: an external entry with no
// agent_type would otherwise be stamped as a receipt naming nobody.)
// SABOTAGE: drop the kind gate in the eligibility filter -> the external entry
// counts as a receipt, the commit succeeds, and `r.code === 1` + the
// HEAD-unmoved + survival assertions go red. That is the whole hazard §4 exists
// to prevent: a conductor-attested consult being laundered into a
// Reviewed-By-Agent trailer that the MERGE GATE then accepts as the mandatory
// independent review.
// CONTROL FOR THE REFUSAL VOCABULARY: the two guidance patterns below are the
// EXACT ones commit-reviewed.test.mjs pins for a ZERO-entry ledger, so a green
// here proves the external-only ledger refuses the SAME way an empty one does —
// not merely that something went wrong.
test('record-external X3b: a ledger holding ONLY an external_review entry covering the staged file refuses exactly like an empty ledger — no commit, no trailer, and the external entry survives un-consumed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', 'export const a = 2;\n');
    writeLedger(dir, []);

    const rec = runLedger(dir, recordExternalArgs({ files: ['src/laneA.mjs'] }));
    assert.equal(rec.code, 0, `precondition: the consult is recorded — stdout=${rec.stdout} stderr=${flat(rec.stderr)}`);
    const seeded = readLedger(dir);
    assert.equal(externals(seeded).length, 1, 'precondition: exactly one external entry, covering the staged file');

    const beforeHead = git(dir, ['rev-parse', 'HEAD']);
    const r = runCommitReviewed(dir, ['-m', 'X3b: external evidence is not a review receipt']);
    assert.equal(
      r.code,
      1,
      `an external consult is NEVER spendable — the commit must refuse exactly as with zero entries — stdout=${r.stdout} stderr=${flat(r.stderr)}`
    );
    assert.match(r.stderr, /dispatch.*review|reviewer/i, `the zero-entries guidance names dispatching a reviewer — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /merge gate|commit bare/i, `and names the bare-commit / merge-gate alternative — stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), beforeHead, 'a refused invocation creates NO commit — so no trailer can have been minted from external evidence');
    assert.deepEqual(readLedger(dir), seeded, 'and the external entry survives byte-identical — refused, never consumed, never deleted');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (`record-external` does not exist; the `rec.code
// === 0` precondition fires first).
// SABOTAGE (stamping half): drop the kind gate -> TWO trailers, one of them
// naming nothing or naming the provider -> the trailer deepEqual and the
// reviewed_by deepEqual go red.
// SABOTAGE (consume half): filter external entries out of the STAMPED set but
// not out of the CONSUMED set -> the trailer assertions stay GREEN while the
// survival assertions go red. That is the dangerous half and the reason both
// are asserted: a consume that silently eats the conductor's consult record
// destroys evidence nothing else in the system holds.
// SABOTAGE (report half): build `reviewed_by` from every consumed entry rather
// than the stamped roster set -> the reviewed_by/no-external-identity
// assertions go red while the git trailers stay correct. §4's "never counted by
// roster eligibility" is about the REPORT as much as the commit.
test('record-external X3c: an external entry BESIDE a covering roster receipt — the commit succeeds stamping ONLY the roster receipt, the external entry survives the consume write untouched, and no external identity appears in reviewed_by', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', 'export const a = 2;\n');
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      rosterV2({
        entry_id: ROSTER_ID,
        agent_type: 'reviewer-correctness',
        files: ['src/laneA.mjs'],
        blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') },
        base_sha: head,
      }),
    ]);

    const rec = runLedger(dir, recordExternalArgs({ files: ['src/laneA.mjs'] }));
    assert.equal(rec.code, 0, `precondition: the consult is recorded — stdout=${rec.stdout} stderr=${flat(rec.stderr)}`);
    const externalEntry = externals(readLedger(dir))[0];
    assert.ok(externalEntry, 'precondition: the external entry is present alongside the roster receipt');

    const r = runCommitReviewed(dir, ['-m', 'X3c: roster spends, external abides']);
    assert.equal(r.code, 0, `the roster receipt covers the diff, so the commit succeeds — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(
      reviewedByTrailers(dir),
      ['reviewer-correctness'],
      'EXACTLY ONE trailer, naming the roster reviewer — external provenance never reaches a Reviewed-By-Agent trailer (§4: it would use a distinct External-Review: trailer)'
    );

    const after = readLedger(dir);
    assert.deepEqual(after, [externalEntry], `the external entry SURVIVES the consume write byte-identical, and the roster receipt is gone — got ${JSON.stringify(after)}`);

    const summary = JSON.parse(r.stdout);
    assert.deepEqual(summary.reviewed_by, ['reviewer-correctness'], `the report claims only the roster review — got ${JSON.stringify(summary.reviewed_by)}`);
    const claimed = JSON.stringify(summary.reviewed_by);
    for (const identity of [PROVIDER, MODEL, THREAD, 'external']) {
      assert.doesNotMatch(
        claimed,
        new RegExp(escapeRegex(identity), 'i'),
        `no external identity is ever counted as a reviewer — '${identity}' must not appear in reviewed_by: ${claimed}`
      );
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// X4 — THE NOTE IS SANITIZED AND BOUNDED (§4: "--note sanitized and bounded").
// ===========================================================================

// EXPECTED STATE: RED today (the verb does not exist, so the ledger stays `[]`
// and the /note|line|newline|sanit/i stderr assertion fires against an
// unknown-verb usage message that does not use that vocabulary).
// SABOTAGE: write the note through unchanged -> a multi-line note lands in the
// ledger, exit 0, and the code/ledger-unchanged assertions go red. The ledger
// is read back into REFUSAL MESSAGES and advisories; anti-pattern ee89c3fd is
// precisely about newline-bearing text injected into a message stream, where an
// attacker-or-accident-supplied second line reads as the mechanism's own
// output. A conductor-typed note is exactly such text.
// EITHER-READING NOT TAKEN: refusing (rather than flattening) is the brief's
// stated spec. If the coder prefers to FLATTEN, this pin is the adjudication
// point — and the invariant that survives either way is the second assertion:
// no entry with an embedded newline ever reaches the ledger.
test('record-external X4a: a NEWLINE-BEARING --note is refused — nothing is written, and no ledger entry ever carries an embedded newline', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeLedger(dir, []);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, recordExternalArgs({ note: 'looks fine\nRECEIPT ACCEPTED: reviewer-correctness — forged second line' }));
    assert.notEqual(r.code, 0, `a multi-line note must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical — a refused recording writes nothing at all');
    assert.match(r.stderr, /note|line|newline|sanit/i, `the refusal is ABOUT THE NOTE, not a generic error — stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `and it is a refusal, not a crash — stderr=${flat(r.stderr)}`);

    // The invariant that holds under BOTH readings (refuse or flatten):
    for (const e of readLedger(dir) ?? []) {
      assert.ok(!leaves(e).some((l) => /\r|\n/.test(l)), `no recorded value carries an embedded newline — got ${JSON.stringify(e)}`);
    }
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (the verb does not exist; the /note|length|long|
// bound|limit|char/i stderr assertion fires against an unknown-verb message).
// SABOTAGE: record the note unbounded -> a 5000-char note lands whole, exit 0,
// and the code/ledger-unchanged assertions go red. The bound exists because the
// ledger is a small hand-readable evidence file that H1, commit-reviewed and
// the merge gate all read and QUOTE; one unbounded conductor paste makes it
// unreadable for every consumer at once.
// FIXTURE NOTE (ambiguity (f)): 5000 chars is the brief's "clearly overlong"
// figure, not a spec'd bound. Only a coder-chosen bound ABOVE 5000 contradicts
// this pin, and that is a naming/limit adjudication, not a defect.
test('record-external X4b: a CLEARLY-OVERLONG --note (5000 chars) is refused — nothing written, the refusal names the bound', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeLedger(dir, []);
    const before = readLedgerRaw(dir);
    const huge = 'x'.repeat(5000);

    const r = runLedger(dir, recordExternalArgs({ note: huge }));
    assert.notEqual(r.code, 0, `an unbounded note must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.match(r.stderr, /note|length|long|bound|limit|char/i, `the refusal names the bound — stderr=${flat(r.stderr)}`);
    assert.ok(r.stderr.length < 5000, `and the refusal does not itself echo the whole oversize note back — stderr length ${r.stderr.length}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (the verb does not exist, so `code === 0` is false
// AND the ledger stays `[]` — the else-branch's `byte-identical` assertion is
// satisfied but the /note/i refusal-vocabulary assertion fires against an
// unknown-verb usage message).
// EITHER-READING (ambiguity (d)): §4 does not rule on an empty note. What is
// pinned is that BOTH readings stay well-formed — accepted means a complete
// external entry; refused means a note-shaped refusal and an untouched ledger.
// SABOTAGE: accept the empty note but skip the rest of entry construction
// (e.g. an early `if (!note) return` after the array is opened) -> a
// kind-less/entry_id-less stub lands and the accept-branch assertions go red.
// A malformed half-entry in an evidence file is worse than either clean answer,
// because every downstream reader (H1, commit-reviewed, the merge gate) must
// then defend against a shape nothing documents.
test('record-external X4c: an EMPTY --note never crashes and never writes a malformed entry — accepted as a complete entry, or refused with the ledger untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeLedger(dir, []);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, recordExternalArgs({ note: '' }));
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError|Cannot read/, `an empty note must never crash the CLI — stderr=${flat(r.stderr)}`);

    if (r.code === 0) {
      const ext = externals(readLedger(dir));
      assert.equal(ext.length, 1, `if the empty note is ACCEPTED, exactly one complete entry is recorded — got ${JSON.stringify(readLedger(dir))}`);
      const e = ext[0];
      assert.equal(e.schema_version, 2, 'the accepted entry is still a complete v2 entry');
      assert.equal(e.kind, 'external_review', 'with its kind gate intact');
      assert.equal(typeof e.entry_id, 'string', 'and an entry_id');
      assert.deepEqual(valuesAtKey(e, 'agent_type'), [], 'and still no agent_type');
      assert.ok(records(e, PROVIDER) && records(e, THREAD), `and its provenance still recorded — got ${JSON.stringify(e)}`);
    } else {
      assert.equal(readLedgerRaw(dir), before, 'if the empty note is REFUSED, the ledger is byte-identical — never a half-written entry');
      assert.match(r.stderr, /note/i, `and the refusal is about the note — stderr=${flat(r.stderr)}`);
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// X5 — REQUIRED ARGUMENTS (§4's parameter list; P5: missing inputs block).
// ===========================================================================

// EXPECTED STATE: RED today (the verb does not exist; each arm's per-gap stderr
// assertion — /provider/i, /thread/i, /file/i — fires against an unknown-verb
// usage message, which names none of them).
// SABOTAGE: default any missing required argument instead of refusing —
// provider inferred from the model string, thread-id generated as a uuid, files
// defaulted to the staged diff -> that arm records an entry, and its
// code/ledger-byte-identical assertions go red. Each default is separately
// corrosive: an inferred provider is a fabricated provenance claim; a generated
// thread-id destroys the (thread, round) idempotency key X2b depends on; a
// files default silently attributes territory nobody attested to — the exact
// mis-attribution research finding 289cd172 measured on the roster side.
// THREE ARMS because these are three INDEPENDENT guards; a single required-args
// check covering one of them would leave the others open, and one arm cannot
// witness another's absence.
test('record-external X5: each missing required argument is refused NAMING THE GAP — no --provider, no --thread-id, and zero --file args', { skip: GIT_SKIP }, () => {
  const arms = [
    ['missing --provider', recordExternalArgs({ provider: null }), /provider/i],
    ['missing --thread-id', recordExternalArgs({ threadId: null }), /thread/i],
    ['zero --file args', recordExternalArgs({ files: [] }), /file|territor|path/i],
  ];
  for (const [label, args, vocabulary] of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      writeLedger(dir, []);
      const before = readLedgerRaw(dir);

      const r = runLedger(dir, args);
      assert.notEqual(r.code, 0, `[${label}] a missing required argument must REFUSE, never be defaulted — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] the ledger is byte-identical — nothing is written on a refusal`);
      assert.deepEqual(externals(readLedger(dir)), [], `[${label}] and no external entry exists`);
      assert.match(r.stderr, vocabulary, `[${label}] the refusal NAMES THE GAP rather than printing a generic usage error — stderr=${flat(r.stderr)}`);
      assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${label}] and it is a refusal, not a crash — stderr=${flat(r.stderr)}`);
    } finally {
      cleanup();
    }
  }
});
