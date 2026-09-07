// R1 GROUP B — H22 SubagentStop: promoteAtStop -> a ReceiptV2 appended to the
// durable ledger at .sterling/review-ledger.json (store root, never wiped).
//
// Contract source: decision `review-receipt-rebuild-invariant-three-owner-
// modules-tri-state-liveness-receipt-bound-supersession` + contract sheet
// §1.2 / §2.1, amendments A1 (Stop MARKS ended, never deletes), A4 (every
// round has its own Start and its own receipt; a Stop with no UNENDED register
// entry produces NO receipt), A5 (one owner-mkdir lock, no age takeover, no
// force) and A6 (every advisory line carries a [code] token).
//
// WHAT SURVIVES HERE, and why: the promotion boundary (who is promoted, what
// is appended, what is left alone), the accumulate/append-never-clobber
// contract, the byte-identical guarantees on every refusal path, the ledger
// lock behaviour, and the observed-evidence field split. Every refusal is
// pinned by its CODE token and by the bytes on disk, never by a sentence.
//
// RETIRED (the rebuild removes the behaviour; named so the review sees what
// was dropped rather than losing it silently):
//   RETIRED: 'a malformed (corrupt JSON) pre-existing ledger is tolerated —
//     treated as empty, promotion still succeeds' — INVERTED by the rebuild:
//     a corrupt ledger is availability 'corrupt' and H22 does NOT write. The
//     old pin licensed discarding durable evidence to make room for a receipt.
//   RETIRED: RESUME-1a / RESUME-1a-EARLIER / RESUME-1a-NO-TIMESTAMP /
//     RESUME-1b / RESUME-1c / ZERO-READ-ROUND / WRONG-TERRITORY REFRESH /
//     TERRITORY GUARD (undeclared path) / TERRITORY GUARD (omitted path) /
//     GATE 3b (SESSION-MISMATCH) / GATE 3b (CONTROL absent-null) —
//     the whole refresh-in-place mechanism (rebaseline_refused, round-scoped
//     read sets, refresh-time identity gates) is gone: A4 measured that a
//     resumed reviewer FIRES SubagentStart again, so round n+1 has its own
//     register entry and mints its own receipt. Nothing refreshes anything.
//   RETIRED: RESUME_COUNT (absent -> 1) / (2 -> 3) / (UNUSABLE arms) —
//     resume_count is GONE from the receipt shape (A4).
//   RETIRED: RESUME-DISCHARGED / RESUME-LEGACY-V1 — both were fail-closed arms
//     OF the refresh path; the surviving contract is stronger and is pinned by
//     R1-B10 (a Stop with no unended register entry never touches ANY existing
//     entry, whatever its status or schema).
//   RETIRED: every `assert.deepEqual(readRegister(dir), [])` — A1: the entry is
//     MARKED ended at Stop, never deleted.
//   RETIRED: the two-candidate lock-directory planting ('review-ledger.json.lock'
//     OR 'review-ledger.lock') — the sheet names the dir, so the pin names it too.
//   RETIRED: 'NEVER written unlocked' / 'REFUSED TO REBASELINE' /
//     "does not bind the receipt's DECLARED territory" prose matches — refusals
//     are asserted by [code] token and by the bytes on disk.
//
// WHERE THE `attestation_rebaseline_refused` PIN WENT (A13 homes it in this
// file; it is not here, deliberately). This file's three REFUSED TO REBASELINE
// assertions (RESUME-1a-EARLIER, RESUME-1a-NO-TIMESTAMP, RESUME-1b) drove the
// H22 HOOK and belonged to the Stop-side REFRESH rebaseline — the mechanism A4
// deletes outright, since each round now has its own Start and its own
// receipt, so there is no prior sha to decline to move. Converting them would
// have re-frozen a mechanism the rebuild removes.
// The CODE survives for a DIFFERENT mechanism: A11 defines
// `attestation_rebaseline_refused` as "commit-reviewed's attestation-inspection
// refusal, unchanged behaviour" — a spend-side refusal whose live pins are in
// scripts/tests/attestation-disclosure-wiring.test.mjs (where the pin inventory
// §3 also located the banner). Its trigger is nowhere stated in the sheet, so
// authoring a fixture for it here would invent a mechanism rather than pin one.
// CONDUCTOR: the code's pin belongs with the mechanism, in the commit-reviewed
// group's territory — A13's homing of it to this file predates this file losing
// the refresh path.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

// A refusal/disclosure is asserted by its code token, never by its sentence.
const token = (c) => new RegExp('\\[' + c + '\\]');
// A6: every advisory line H22 emits carries SOME [snake_code] token. Pinned
// generically where the sheet's closed CODES set does not yet name the code.
const ANY_CODE = /\[[a-z][a-z0-9_]*\]/;

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-ledger-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h22-dispatch-register.mjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const output = (r) => `${r.stdout}\n${r.stderr}`;

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
function readRegister(dir) {
  return existsSync(registerPath(dir)) ? JSON.parse(readFileSync(registerPath(dir), 'utf8')) : null;
}
function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

// Store-ROOT ledger — deliberately NOT under .sterling/transient/, so H1's
// SessionStart wipe of the transient tree never touches durable evidence.
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
const ledgerLockDir = (dir) => join(dir, '.sterling', 'review-ledger.lock');

const registerEntry = (agentId, agentType, files, at = new Date().toISOString(), over = {}) => ({
  agent_id: agentId,
  agent_type: agentType,
  session_id: 's1',
  files,
  at,
  ...over,
});
// A1: Stop MARKS the entry ended. A round that has already ended is not a
// candidate for promotion (A4) — this is the shape a second Stop faces.
const endedEntry = (agentId, agentType, files, at, endedAt = '2026-08-22T00:05:00.000Z') =>
  registerEntry(agentId, agentType, files, at, { ended: { at: endedAt, event: 'subagent-stop' } });

// §1.2 ReceiptV2, with A11's section ruling: `disposition` is PRESENT as null
// on every non-discharged receipt; reservation/consumption are ABSENT unless
// the status requires them.
const RECEIPT_REQUIRED = ['content_evidence', 'disposition', 'entry_id', 'finished_at', 'identity', 'kind', 'reviewer', 'schema_version', 'started_at', 'status', 'territory'];
const RECEIPT_OPTIONAL = ['observed_files', 'observed_reads', 'observed_source', 'observed_truncated', 'reservation', 'consumption'];

function assertReceiptShape(entry) {
  for (const key of RECEIPT_REQUIRED) {
    assert.ok(key in entry, `a promoted receipt carries the required v2 key '${key}'`);
  }
  const allowed = new Set([...RECEIPT_REQUIRED, ...RECEIPT_OPTIONAL]);
  const extra = Object.keys(entry).filter((k) => !allowed.has(k));
  assert.deepEqual(extra, [], 'a promoted receipt carries no key outside the ReceiptV2 shape (resume_count and refresh residue are GONE — A4)');
  assert.equal(entry.schema_version, 2);
  assert.equal(entry.kind, 'roster_receipt');
  assert.equal(entry.status, 'active', 'a freshly promoted receipt is active — reserved/consumed/discharged are lifecycle transitions, never a promotion output');
  assert.equal(entry.disposition, null, 'A11: disposition is present as null until a discharge fills it');
  assert.ok(!('reservation' in entry) && !('consumption' in entry), 'A11: the lifecycle sections are ABSENT until a status requires them');
}

// ===========================================================================
// R1-B01 — the promotion boundary itself: a reviewer-class Stop appends a
// ReceiptV2 and (A1) MARKS its register entry ended rather than deleting it.
// SABOTAGE: delete the register entry at Stop instead of setting `ended` —
// the ended assertions go red while every ledger assertion stays green, which
// is exactly why the two halves are pinned separately (inactive-confirmed is a
// real classifier output only if the entry survives).
// ===========================================================================

test('R1-B01: a reviewer-* SubagentStop appends a ReceiptV2 to .sterling/review-ledger.json and MARKS the register entry ended (A1)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-1', 'reviewer-correctness', ['src/a.mjs', 'src/b.mjs'], '2026-08-22T00:00:00.000Z')]);

    const r = runHook(h22Input(dir, { agent_id: 'rev-1', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(ledgerExists(dir), 'a durable review ledger is created at .sterling/review-ledger.json (store root)');

    const ledger = readLedger(dir);
    assert.equal(ledger.length, 1);
    const entry = ledger[0];
    assertReceiptShape(entry);
    assert.equal(entry.reviewer.agent_type, 'reviewer-correctness');
    assert.deepEqual(entry.territory.files, ['src/a.mjs', 'src/b.mjs']);
    assert.equal(entry.started_at, '2026-08-22T00:00:00.000Z');
    assert.equal(entry.identity.agent_id, 'rev-1');

    const reg = readRegister(dir);
    assert.equal(reg.length, 1, 'A1: the register entry is NOT deleted at Stop');
    assert.equal(reg[0].agent_id, 'rev-1');
    assert.equal(reg[0].ended?.event, 'subagent-stop', 'A1: Stop marks the entry ended with the terminal event that was actually observed');
    assert.ok(reg[0].ended?.at && !Number.isNaN(Date.parse(reg[0].ended.at)), 'the terminal marker carries a parseable instant');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B02 — two reviewer stops accumulate, in order; the second never clobbers
// the first.
// SABOTAGE: write the ledger as [receipt] instead of [...existing, receipt] —
// the length assertion goes red.
// ===========================================================================

test('R1-B02: two reviewer-* SubagentStop events accumulate two receipts in stop order', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      registerEntry('rev-1', 'reviewer-security', ['src/a.mjs'], '2026-08-22T00:00:00.000Z'),
      registerEntry('rev-2', 'reviewer-performance', ['src/b.mjs'], '2026-08-22T00:01:00.000Z'),
    ]);

    let r = runHook(h22Input(dir, { agent_id: 'rev-1', agent_type: 'reviewer-security' }), dir);
    assert.equal(r.code, 0, r.stderr);
    r = runHook(h22Input(dir, { agent_id: 'rev-2', agent_type: 'reviewer-performance' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const ledger = readLedger(dir);
    assert.equal(ledger.length, 2, 'both reviewer stops accumulate — the second promotion never clobbers the first');
    assert.deepEqual(
      ledger.map((e) => e.reviewer.agent_type),
      ['reviewer-security', 'reviewer-performance'],
      'append order matches stop order'
    );
    assert.notEqual(ledger[0].entry_id, ledger[1].entry_id, 'two promotions mint two distinct entry_ids');

    const reg = readRegister(dir);
    assert.deepEqual(
      reg.map((e) => e.ended?.event).sort(),
      ['subagent-stop', 'subagent-stop'],
      'both register entries are marked ended (A1), neither removed'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B03/R1-B04 — the non-reviewer boundary. Promotion is gated on the
// literal 'reviewer-' prefix, and a non-reviewer Stop must not so much as
// touch the ledger file.
// SABOTAGE: promote on `agent_type.startsWith('reviewer')` (no hyphen) — R1-B05
// goes red alone. SABOTAGE: append on every Stop regardless of class — R1-B03
// and R1-B04 both go red.
// ===========================================================================

test('R1-B03: a non-reviewer SubagentStop ("coder") creates no ledger at all, and still marks its register entry ended', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('c-1', 'coder', ['src/x.mjs'])]);
    assert.equal(ledgerExists(dir), false, 'precondition: no ledger exists yet');

    const r = runHook(h22Input(dir, { agent_id: 'c-1', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);

    assert.equal(ledgerExists(dir), false, 'a non-reviewer stop must never fabricate a ledger file');
    const reg = readRegister(dir);
    assert.equal(reg.length, 1, 'A1: still present');
    assert.equal(reg[0].ended?.event, 'subagent-stop');
  } finally {
    cleanup();
  }
});

test('R1-B04: a non-reviewer SubagentStop leaves a PRE-EXISTING ledger byte-identical', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeLedgerRaw(dir, [{ agent_type: 'reviewer-skeptic', files: ['src/prior.mjs'], at: '2026-08-21T00:00:00.000Z' }]);
    const before = readLedgerRaw(dir);

    writeRegisterRaw(dir, [registerEntry('c-2', 'coder', ['src/y.mjs'])]);
    const r = runHook(h22Input(dir, { agent_id: 'c-2', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);

    assert.equal(readLedgerRaw(dir), before, 'byte-identical — a non-reviewer stop must not rewrite an existing ledger at all');
  } finally {
    cleanup();
  }
});

test('R1-B05: agent_type "reviewer" (no trailing hyphen) is not reviewer-class — no ledger created', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('r-bare', 'reviewer', ['src/z.mjs'])]);
    const r = runHook(h22Input(dir, { agent_id: 'r-bare', agent_type: 'reviewer' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(ledgerExists(dir), false, "'reviewer' alone is not a member of the reviewer-* roster prefix");
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B06 — appending beside pre-existing entries, including a legacy v1 one:
// reading a v1 entry NEVER rewrites it (adaptLegacyEntry is a read).
// SABOTAGE: normalize every entry to v2 while writing the array back — the
// byte-for-byte assertion on the v1 entry goes red while the new receipt's own
// shape assertions stay green.
// ===========================================================================

test('R1-B06: a promotion APPENDS beside a pre-existing legacy v1 entry, which survives byte-for-byte (never migrated by being read)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const priorEntry = { agent_type: 'reviewer-correctness', files: ['src/prior.mjs'], at: '2026-08-20T00:00:00.000Z' };
    writeLedgerRaw(dir, [priorEntry]);

    writeRegisterRaw(dir, [registerEntry('rev-new', 'reviewer-security', ['src/new.mjs'], '2026-08-22T00:00:00.000Z')]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-new', agent_type: 'reviewer-security' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const ledger = readLedger(dir);
    assert.equal(ledger.length, 2, 'append, not overwrite');
    assert.deepEqual(ledger[0], priorEntry, 'the pre-existing v1 entry is byte-for-byte preserved');
    assert.equal(JSON.stringify(ledger[0]), JSON.stringify(priorEntry), 'no key-order drift from an in-place rewrite either');
    assert.equal(ledger[1].reviewer.agent_type, 'reviewer-security');
    assert.deepEqual(ledger[1].territory.files, ['src/new.mjs']);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B07 — CORRUPT LEDGER, INVERTED. The retired pin let a corrupt ledger be
// "treated as empty" and overwritten by the new receipt — i.e. durable review
// evidence discarded to make room for one. The rebuild refuses: availability
// 'corrupt' means H22 does NOT write, discloses [ledger_corrupt], and leaves
// the bytes exactly as they were.
// CONTROL: R1-B01/R1-B08 (a healthy and an absent ledger both promote) prove
// this is not "promotion is broken".
// SABOTAGE: restore `catch { entries = [] }` around the ledger read — the
// byte-identical assertion goes red (the corrupt bytes are replaced by a
// one-element array) and the [ledger_corrupt] disclosure never fires.
// ===========================================================================

test('R1-B07: a CORRUPT ledger stops the promotion — no write, bytes untouched, [ledger_corrupt] disclosed, exit 0', () => {
  for (const corruptBytes of ['{ this is not valid json at all', '{"not":"an array"}']) {
    const { dir, cleanup } = makeProject();
    try {
      writeLedgerRaw(dir, corruptBytes);
      writeRegisterRaw(dir, [registerEntry('rev-corrupt', 'reviewer-performance', ['src/heal.mjs'], '2026-08-22T00:00:00.000Z')]);

      const r = runHook(h22Input(dir, { agent_id: 'rev-corrupt', agent_type: 'reviewer-performance' }), dir);
      assert.notEqual(r.code, 2, 'a corrupt ledger must never deny the SubagentStop boundary');
      assert.equal(r.code, 0, r.stderr);

      assert.equal(readLedgerRaw(dir), corruptBytes, `the corrupt ledger is left byte-identical — never truncated, repaired or replaced (${corruptBytes})`);
      assert.match(output(r), token('ledger_corrupt'), 'the withheld promotion is disclosed by its code');
    } finally {
      cleanup();
    }
  }
});

test('R1-B08: a MISSING ledger is the ordinary first-promotion case — the file is created from nothing', () => {
  const { dir, cleanup } = makeProject();
  try {
    assert.equal(ledgerExists(dir), false);
    writeRegisterRaw(dir, [registerEntry('rev-first', 'reviewer-skeptic', ['src/first.mjs'], '2026-08-22T00:00:00.000Z')]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-first', agent_type: 'reviewer-skeptic' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(ledgerExists(dir), 'a first promotion creates the ledger file');
    const ledger = readLedger(dir);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].reviewer.agent_type, 'reviewer-skeptic');
    assert.doesNotMatch(output(r), token('ledger_corrupt'), 'an ABSENT ledger is not a CORRUPT one — the two availabilities are never conflated');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B09 / R1-B10 — A4's fail-closed half: promoteAtStop selects the single
// UNENDED (session_id, agent_id) register entry. Zero unended entries -> NO
// receipt, and NOTHING existing is touched.
//
// R1-B10 is the pin that replaces the entire retired refresh family: the
// dangerous sequence it closes is a second Stop with no Start of its own
// re-binding an old brief onto today's bytes.
// SABOTAGE: select the register entry by agent_id WITHOUT the unended filter
// — R1-B10 goes red (a second receipt appears, or the first is mutated) while
// R1-B11 (which has a genuine second Start) stays green either way. That
// asymmetry is why the two are pinned as a pair.
// ===========================================================================

test('R1-B09: a Stop whose agent_id has NO register entry at all mints no receipt and leaves the register untouched', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-x', 'reviewer-correctness', ['src/x.mjs'], '2026-08-22T00:00:00.000Z')]);
    const before = readFileSync(registerPath(dir), 'utf8');

    const r = runHook(h22Input(dir, { agent_id: 'nonexistent', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);

    assert.equal(ledgerExists(dir), false, 'no unended entry for this agent_id — no receipt');
    assert.equal(readFileSync(registerPath(dir), 'utf8'), before, "the unmatched Stop leaves the other agent's entry exactly as it was, still unended");
  } finally {
    cleanup();
  }
});

test('R1-B10 (A4): a second Stop whose only matching register entry is already ENDED produces NO receipt and never touches the existing one', () => {
  const { dir, cleanup } = makeProject();
  try {
    // Round 1: a genuine Start/Stop pair mints exactly one receipt.
    writeRegisterRaw(dir, [registerEntry('rev-round1', 'reviewer-correctness', ['src/r.mjs'], '2026-08-22T00:00:00.000Z')]);
    let r = runHook(h22Input(dir, { agent_id: 'rev-round1', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ledgerBefore = readLedgerRaw(dir);
    assert.equal(JSON.parse(ledgerBefore).length, 1, 'fixture guard: round 1 minted exactly one receipt');

    // A second Stop arrives with no new Start behind it: the only entry for
    // this agent_id is the ended round-1 one.
    r = runHook(h22Input(dir, { agent_id: 'rev-round1', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);

    assert.equal(readLedgerRaw(dir), ledgerBefore, 'byte-identical: no second receipt, and the first is not refreshed, re-hashed or re-dated');
  } finally {
    cleanup();
  }
});

test('R1-B11 (A4): a genuine round 2 — its OWN Start, same agent_id — mints its OWN second receipt; the first is untouched', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-two-rounds', 'reviewer-correctness', ['src/a.mjs'], '2026-08-22T00:00:00.000Z')]);
    let r = runHook(h22Input(dir, { agent_id: 'rev-two-rounds', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const first = readLedger(dir)[0];
    const firstSnapshot = JSON.stringify(first);

    // Round 2's Start: the ended round-1 entry stays, a fresh UNENDED entry is
    // appended for the same agent_id (A4's register rule).
    writeRegisterRaw(dir, [
      endedEntry('rev-two-rounds', 'reviewer-correctness', ['src/a.mjs'], '2026-08-22T00:00:00.000Z'),
      registerEntry('rev-two-rounds', 'reviewer-correctness', ['src/a.mjs'], '2026-08-22T00:10:00.000Z', { round: 2 }),
    ]);
    r = runHook(h22Input(dir, { agent_id: 'rev-two-rounds', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const ledger = readLedger(dir);
    assert.equal(ledger.length, 2, 'each round has its own receipt — never a refresh in place');
    const stillFirst = ledger.find((e) => e.entry_id === first.entry_id);
    assert.ok(stillFirst, "round 1's receipt is still present under its own entry_id");
    assert.equal(JSON.stringify(stillFirst), firstSnapshot, "round 1's receipt is byte-identical — round 2 never edits it");
    const second = ledger.find((e) => e.entry_id !== first.entry_id);
    assert.ok(second, 'round 2 minted a distinct receipt');
    assertReceiptShape(second);
    assert.equal(second.started_at, '2026-08-22T00:10:00.000Z', "round 2's receipt carries ROUND 2's Start instant, not round 1's");
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B12 — CONTROL for every "never touched" assertion above: a Stop for a
// DIFFERENT agent_id must not touch an unrelated existing receipt.
// SABOTAGE: key promotion/lookup on agent_type (or on "the most recent entry")
// instead of on the agent_id — A's receipt is mutated by B's Stop and the
// byte-identical assertion goes red.
// ===========================================================================

test('R1-B12 (CONTROL): a Stop for a different agent_id never touches an unrelated receipt — identity, never recency', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-ctrl-a', 'reviewer-correctness', ['src/a.mjs'], '2026-08-22T00:00:00.000Z')]);
    let r = runHook(h22Input(dir, { agent_id: 'rev-ctrl-a', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const aSnapshot = JSON.stringify(readLedger(dir)[0]);

    writeRegisterRaw(dir, [registerEntry('rev-ctrl-b', 'reviewer-security', ['src/b.mjs'], '2026-08-22T00:05:00.000Z')]);
    r = runHook(h22Input(dir, { agent_id: 'rev-ctrl-b', agent_type: 'reviewer-security' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const after = readLedger(dir);
    assert.equal(after.length, 2, 'two distinct receipts');
    const aAfter = after.find((e) => e.identity?.agent_id === 'rev-ctrl-a');
    assert.ok(aAfter, "A's receipt is still present");
    assert.equal(JSON.stringify(aAfter), aSnapshot, "A's receipt is byte-identical");
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B13 — content evidence is bound to the STOPPING entry's own declared
// territory. A second, unrelated live register entry must never leak a path
// into this receipt's evidence (the measured cross-attribution defect).
// SABOTAGE: hash the union of every live register entry's files — the
// evidence-path assertion goes red with 'src/unrelated.mjs' present.
// ===========================================================================

test('R1-B13: content_evidence covers exactly the stopping entry\'s declared territory — a co-live register entry never leaks a path in', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'a\n');
    writeFileSync(join(dir, 'src', 'b.mjs'), 'b\n');
    writeFileSync(join(dir, 'src', 'unrelated.mjs'), 'zz\n');

    writeRegisterRaw(dir, [
      registerEntry('rev-terr', 'reviewer-correctness', ['src/a.mjs', 'src/b.mjs'], '2026-08-22T00:00:00.000Z'),
      registerEntry('agent-other', 'coder', ['src/unrelated.mjs'], '2026-08-22T00:00:00.000Z'),
    ]);

    const r = runHook(h22Input(dir, { agent_id: 'rev-terr', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const entry = readLedger(dir)[0];
    assert.deepEqual([...entry.territory.files].sort(), ['src/a.mjs', 'src/b.mjs']);
    const evidencePaths = [...Object.keys(entry.content_evidence.blobs ?? {}), ...(entry.content_evidence.absent_paths ?? [])].sort();
    assert.deepEqual(evidencePaths, ['src/a.mjs', 'src/b.mjs'], "evidence is hashed against THIS receipt's declared territory only");
    assert.ok(!('src/unrelated.mjs' in (entry.content_evidence.blobs ?? {})), "the co-live coder entry's file never appears in this receipt's evidence");
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B14 — observed_reads is READS ONLY; observed_files keeps the
// reads-UNION-writes meaning. Supersession coverage consumes observed_reads,
// so a write-only path leaking in would let an unread file count as reviewed.
// SABOTAGE: populate observed_reads from the reads+writes union (or alias it
// to observed_files) — both assertions below go red while observed_files stays
// green.
// ===========================================================================

test('R1-B14: observed_reads excludes a write-only path while observed_files still includes it', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'read-only.mjs'), 'r\n');
    writeFileSync(join(dir, 'src', 'write-only.mjs'), 'w\n');

    writeRegisterRaw(dir, [registerEntry('rev-reads', 'reviewer-correctness', ['src/read-only.mjs', 'src/write-only.mjs'], '2026-08-22T00:00:00.000Z')]);

    const agentTranscript = join(dir, 't', 'agent-reads.jsonl');
    mkdirSync(dirname(agentTranscript), { recursive: true });
    writeFileSync(
      agentTranscript,
      [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(dir, 'src', 'read-only.mjs') } }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(dir, 'src', 'write-only.mjs') } }] } }),
      ].join('\n') + '\n'
    );

    const r = runHook(h22Input(dir, { agent_id: 'rev-reads', agent_type: 'reviewer-correctness', agent_transcript_path: agentTranscript }), dir);
    assert.equal(r.code, 0, r.stderr);

    const entry = readLedger(dir)[0];
    assert.deepEqual([...entry.observed_files].sort(), ['src/read-only.mjs', 'src/write-only.mjs'], 'observed_files keeps the reads-UNION-writes meaning');
    assert.deepEqual(entry.observed_reads, ['src/read-only.mjs'], 'observed_reads is READS ONLY');
    assert.ok(!entry.observed_reads.includes('src/write-only.mjs'), 'the write-only path never leaks into observed_reads');
    assert.equal(entry.observed_source, 'subagent-transcript');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B15 — A5: the ledger lock is coordination, and a held lock is a REFUSAL,
// never an unlocked write and never a steal. The lock directory is the one the
// sheet names (.sterling/review-ledger.lock).
// SABOTAGE: on lock contention fall through to writing unlocked ("write
// anyway, disclose") — the byte-identical assertion goes red. SABOTAGE:
// restore an age-based takeover — the lock-still-present assertion goes red.
// ===========================================================================

test('R1-B15 (A5): while the ledger lock is held, the Stop writes nothing — ledger byte-identical, lock never stolen, [ledger_lock_held] disclosed', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeLedgerRaw(dir, []);
    const before = readLedgerRaw(dir);

    const lockDir = ledgerLockDir(dir);
    mkdirSync(lockDir, { recursive: true });
    // Alive on this host and deliberately old: age alone must never authorise
    // a takeover (A5 — no age takeover, no --force-lock).
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), at: '2025-08-22T00:00:00.000Z', nonce: 'held' }));

    writeRegisterRaw(dir, [registerEntry('rev-locked', 'reviewer-correctness', ['src/locked.mjs'], '2026-08-22T00:00:00.000Z')]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-locked', agent_type: 'reviewer-correctness' }), dir);

    assert.equal(r.code, 0, `a held ledger lock is disclosed, never a denial — stderr: ${r.stderr}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical — the promotion was withheld, never written unlocked');
    assert.match(output(r), token('ledger_lock_held'), 'the withheld promotion is disclosed by its code');
    assert.ok(existsSync(lockDir), 'the foreign lock is left untouched, never stolen');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B16 — A6: every advisory line H22 emits carries a [snake_code] token, so
// no consumer ever has to scrape a sentence.
// SABOTAGE: emit the disclosure through a bare string instead of render() —
// this goes red while R1-B07's own code assertion may still pass if the code
// happens to be interpolated by hand somewhere else, which is why the generic
// shape is pinned as well as the specific codes.
// ===========================================================================

test('R1-B16 (A6): a disclosing Stop emits an advisory carrying a [snake_code] token', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeLedgerRaw(dir, '{ not json');
    writeRegisterRaw(dir, [registerEntry('rev-a6', 'reviewer-correctness', ['src/a6.mjs'], '2026-08-22T00:00:00.000Z')]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-a6', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(output(r), ANY_CODE, 'the advisory is rendered through the shared errors module, code first');
  } finally {
    cleanup();
  }
});
