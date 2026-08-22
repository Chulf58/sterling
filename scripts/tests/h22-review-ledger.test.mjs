// H22 REVIEW-RECEIPT LEDGER PROMOTION (part A of decision
// 12a26ca6-a301-466d-a45c-5e1eeff36694, slug review-receipt-ledger; board
// 7814acc3-bb22-4cc5-abd7-789d6396743f) — SPEC ONLY, red-first.
//
// Spec under test (given by the launching agent, verified against the
// decision record above — not inferred from any implementation):
//
//   At SubagentStop, when the departing register entry's agent_type starts
//   with the literal prefix 'reviewer-' (roster: reviewer-correctness,
//   reviewer-security, reviewer-skeptic, reviewer-performance), the entry is
//   PROMOTED — appended as exactly {agent_type, files, at} (three fields,
//   NOT the register's agent_id/session_id) to a durable ledger at
//   .sterling/review-ledger.json (STORE ROOT — deliberately NOT under
//   .sterling/transient/, so H1's session wipe of the transient tree never
//   touches it) — and THEN removed from the register exactly as today.
//   Non-reviewer entries keep the delete-only path: the register entry is
//   removed, and the ledger file is left completely alone — never created
//   if it did not already exist, never appended to if it did. Ledger reads
//   tolerate a malformed/missing ledger (treated as empty, never a crash;
//   the hook must not exit 2 for this).
//
// scripts/hooks/h22-dispatch-register.mjs ALREADY EXISTS (it implements the
// register append/delete/prune behavior covered by
// scripts/tests/h22-dispatch-register.test.mjs) but, as of this writing, has
// NO notion of a review ledger at all — every promotion-shaped assertion
// below is expected to fail red against today's delete-only SubagentStop
// path: the ledger file this spec expects is never created/appended, so
// existsSync(ledgerPath) or its parsed contents come back false/empty where
// a promoted entry is expected. Confirmed by reading (not modifying)
// scripts/tests/h22-dispatch-register.test.mjs, whose own header states the
// register's SubagentStop is "removes the entry ... ; no match is a clean
// no-op" — no ledger promotion is described there.
//
// Harness idiom (spawnSync + JSON stdin + temp project dir) is adapted from
// scripts/tests/h22-dispatch-register.test.mjs's runHook/h22Input/
// registerPath/writeRegisterRaw helpers WITHOUT importing or modifying that
// file (mirrors the standalone-file convention used by
// scripts/tests/merge-review-receipts-hardening.test.mjs relative to
// scripts/tests/merge-review-receipts.test.mjs). This file seeds the
// register directly via writeRegisterRaw rather than re-deriving the
// transcript-extraction path (that extraction behavior is already covered
// by scripts/tests/h22-dispatch-register.test.mjs and is out of scope here
// — this file is scoped to the NEW ledger-promotion behavior only).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

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

// Store-ROOT ledger — deliberately NOT under .sterling/transient/.
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

const registerEntry = (agentId, agentType, files, at = new Date().toISOString()) => ({
  agent_id: agentId,
  agent_type: agentType,
  session_id: 's1',
  files,
  at,
});

// ===========================================================================
// (1) A single reviewer-class SubagentStop promotes {agent_type, files, at}
//     into the ledger and removes the register entry.
// ===========================================================================

test('H22 ledger: SubagentStop for a reviewer-* entry PROMOTES it into .sterling/review-ledger.json (exactly agent_type/files/at) and removes the register entry', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-1', 'reviewer-correctness', ['src/a.mjs', 'src/b.mjs'], '2026-08-22T00:00:00.000Z')]);

    const r = runHook(h22Input(dir, { agent_id: 'rev-1', hook_event_name: 'SubagentStop' }), dir);
    // EXPECTED FAILURE SHAPE (today): the hook has no ledger-promotion logic,
    // so it exits 0 exactly as before but ledgerExists(dir) stays false —
    // this assert.ok fires first.
    assert.equal(r.code, 0, r.stderr);
    assert.ok(ledgerExists(dir), 'a durable review ledger is created at .sterling/review-ledger.json (store root)');

    const ledger = readLedger(dir);
    assert.equal(ledger.length, 1);
    const entry = ledger[0];
    assert.deepEqual(Object.keys(entry).sort(), ['agent_type', 'at', 'files'], 'the promoted entry carries EXACTLY these three fields — no agent_id, no session_id');
    assert.equal(entry.agent_type, 'reviewer-correctness');
    assert.deepEqual(entry.files, ['src/a.mjs', 'src/b.mjs']);
    assert.equal(entry.at, '2026-08-22T00:00:00.000Z');

    const reg = readRegister(dir);
    assert.deepEqual(reg, [], 'the promoted entry is also removed from the in-flight register, exactly as the pre-existing delete-only path did');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (2) Multiple reviewer stops accumulate in the ledger (append, in order).
// ===========================================================================

test('H22 ledger: two reviewer-* SubagentStop events accumulate two ledger entries in order', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      registerEntry('rev-1', 'reviewer-security', ['src/a.mjs'], '2026-08-22T00:00:00.000Z'),
      registerEntry('rev-2', 'reviewer-performance', ['src/b.mjs'], '2026-08-22T00:01:00.000Z'),
    ]);

    let r = runHook(h22Input(dir, { agent_id: 'rev-1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    r = runHook(h22Input(dir, { agent_id: 'rev-2', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    // EXPECTED FAILURE SHAPE (today): readLedger throws (file never created)
    // or, once a partial fix lands, comes back with fewer than 2 entries.
    const ledger = readLedger(dir);
    assert.equal(ledger.length, 2, 'both reviewer stops accumulate — the second promotion never clobbers the first');
    assert.deepEqual(ledger.map((e) => e.agent_type), ['reviewer-security', 'reviewer-performance'], 'append order matches stop order');

    assert.deepEqual(readRegister(dir), [], 'both entries removed from the register');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (3) Non-reviewer entries keep the delete-only path: no ledger is ever
//     created for them.
// ===========================================================================

test('H22 ledger: a non-reviewer SubagentStop (agent_type "coder") is delete-only — no ledger file is created at all', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('c-1', 'coder', ['src/x.mjs'])]);
    assert.equal(ledgerExists(dir), false, 'precondition: no ledger exists yet');

    const r = runHook(h22Input(dir, { agent_id: 'c-1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    // EXPECTED FAILURE SHAPE (today): this assertion already holds today
    // (the current hook never creates a ledger for anyone) — it is a
    // regression pin, not a red-today assertion, and must keep holding once
    // the promotion path ships.
    assert.equal(ledgerExists(dir), false, 'a non-reviewer promotion must never fabricate a ledger file');
    assert.deepEqual(readRegister(dir), [], 'the register entry is still removed exactly as today');
  } finally {
    cleanup();
  }
});

test('H22 ledger: a non-reviewer SubagentStop leaves a PRE-EXISTING ledger completely untouched (byte-identical)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const preExisting = [{ agent_type: 'reviewer-skeptic', files: ['src/prior.mjs'], at: '2026-08-21T00:00:00.000Z' }];
    writeLedgerRaw(dir, preExisting);
    const before = readLedgerRaw(dir);

    writeRegisterRaw(dir, [registerEntry('c-2', 'coder', ['src/y.mjs'])]);
    const r = runHook(h22Input(dir, { agent_id: 'c-2', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    // EXPECTED FAILURE SHAPE: today's hook does not touch the ledger for any
    // agent_type, so this already holds — a regression pin against an
    // over-eager implementation that appends/rewrites on EVERY stop
    // regardless of agent_type.
    assert.equal(readLedgerRaw(dir), before, 'byte-identical — a non-reviewer stop must not rewrite an existing ledger at all');
    assert.deepEqual(readRegister(dir), [], 'the register entry is still removed');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (4) Prefix boundary: "reviewer" without the trailing hyphen is NOT
//     promoted — the spec's prefix is the literal string 'reviewer-'.
// ===========================================================================

test('H22 ledger: agent_type "reviewer" (no trailing hyphen) does NOT match the reviewer-* prefix — delete-only, no ledger created', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('r-bare', 'reviewer', ['src/z.mjs'])]);
    const r = runHook(h22Input(dir, { agent_id: 'r-bare', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    // EXPECTED FAILURE SHAPE: only fails red if a naive implementation uses a
    // loose "includes/startsWith('reviewer')" match instead of the exact
    // 'reviewer-' prefix; asserted here as a precise boundary pin regardless.
    assert.equal(ledgerExists(dir), false, "'reviewer' alone is not a member of the reviewer-* roster prefix");
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (5) Ledger append never clobbers what was already there.
// ===========================================================================

test('H22 ledger: promoting a new reviewer entry APPENDS to a pre-populated ledger — the prior entry survives untouched', () => {
  const { dir, cleanup } = makeProject();
  try {
    const priorEntry = { agent_type: 'reviewer-correctness', files: ['src/prior.mjs'], at: '2026-08-20T00:00:00.000Z' };
    writeLedgerRaw(dir, [priorEntry]);

    writeRegisterRaw(dir, [registerEntry('rev-new', 'reviewer-security', ['src/new.mjs'], '2026-08-22T00:00:00.000Z')]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-new', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    // EXPECTED FAILURE SHAPE: today's hook has no ledger at all, so
    // readLedger(dir) either throws (no file) — the promotion path does not
    // exist yet to have produced one.
    const ledger = readLedger(dir);
    assert.equal(ledger.length, 2, 'append, not overwrite');
    assert.deepEqual(ledger[0], priorEntry, 'the pre-existing entry is byte-for-byte preserved');
    assert.equal(ledger[1].agent_type, 'reviewer-security');
    assert.deepEqual(ledger[1].files, ['src/new.mjs']);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (6) Malformed ledger degrades to empty — never a crash, never exit 2.
// ===========================================================================

test('H22 ledger: a malformed (corrupt JSON) pre-existing ledger is tolerated — treated as empty, promotion still succeeds, hook never exits 2', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeLedgerRaw(dir, '{ this is not valid json at all');
    writeRegisterRaw(dir, [registerEntry('rev-heal', 'reviewer-performance', ['src/heal.mjs'], '2026-08-22T00:00:00.000Z')]);

    const r = runHook(h22Input(dir, { agent_id: 'rev-heal', hook_event_name: 'SubagentStop' }), dir);
    // EXPECTED FAILURE SHAPE: today's hook does not read/write the ledger at
    // all, so this exit-code assertion trivially holds (0) but the
    // downstream ledger-shape assertions below fail red (no promotion logic
    // exists to recover from the corruption and append).
    assert.notEqual(r.code, 2, 'a corrupt ledger must never cause the hook to deny/crash the spawn boundary');
    assert.equal(r.code, 0, r.stderr);

    let ledger;
    assert.doesNotThrow(() => {
      ledger = JSON.parse(readLedgerRaw(dir));
    }, 'the ledger left behind after recovery must itself be valid JSON');
    assert.ok(Array.isArray(ledger));
    assert.equal(ledger.length, 1, 'the corrupt prior content is discarded (treated as empty), not salvaged into a longer array');
    assert.equal(ledger[0].agent_type, 'reviewer-performance');
    assert.deepEqual(ledger[0].files, ['src/heal.mjs']);
  } finally {
    cleanup();
  }
});

test('H22 ledger: a MISSING ledger file is tolerated identically to an empty one on first promotion', () => {
  const { dir, cleanup } = makeProject();
  try {
    assert.equal(ledgerExists(dir), false);
    writeRegisterRaw(dir, [registerEntry('rev-first', 'reviewer-skeptic', ['src/first.mjs'], '2026-08-22T00:00:00.000Z')]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-first', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    // EXPECTED FAILURE SHAPE: ledgerExists(dir) stays false today — no
    // promotion logic exists yet to create the file on a missing-ledger first run.
    assert.ok(ledgerExists(dir), 'a first promotion creates the ledger file from nothing');
    const ledger = readLedger(dir);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].agent_type, 'reviewer-skeptic');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (7) An unmatched agent_id at SubagentStop remains a clean no-op for the
//     ledger too (regression pin against the pre-existing no-op contract).
// ===========================================================================

test('H22 ledger: SubagentStop with an unmatched agent_id is a clean no-op — no ledger created, register unchanged', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-x', 'reviewer-correctness', ['src/x.mjs'])]);
    const r = runHook(h22Input(dir, { agent_id: 'nonexistent', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(ledgerExists(dir), false, 'no match, no promotion');
    const reg = readRegister(dir);
    assert.equal(reg.length, 1);
    assert.equal(reg[0].agent_id, 'rev-x', 'the unmatched stop leaves the real reviewer entry live, still eligible for a later, matching stop');
  } finally {
    cleanup();
  }
});
