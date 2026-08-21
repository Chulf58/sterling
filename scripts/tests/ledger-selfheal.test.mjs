// H13 reads-ledger self-heal — RED FIRST. Caught live 2026-08-20: two
// concurrent PostToolUse:Read hook invocations raced appendRead's non-atomic
// read-modify-write on a DrvFs mount and TORE the per-agent ledger (a valid
// JSON array followed by trailing fragment bytes). readLedger had no
// try/catch, so H3's hasFreshRead threw on every subsequent Edit — the agent
// was bricked repo-wide, and the write path that could have repaired the file
// (appendRead) died on the same throw before writing. The ledger is
// re-derivable evidence (worst case: a re-Read), so the correct degrade is
// salvage-or-reset, never a crash — mirroring lib/delivery.mjs's readGuard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLedger, appendRead, hasFreshRead, isLedgerTorn } from '../hooks/lib/ledger.mjs';

const TORN =
  '[{"agent_id":"a1","path":"src/a.mjs","at":"2026-08-20T16:00:00.000Z","sha256":"aaaa"},' +
  '{"agent_id":"a1","path":"src/b.mjs","at":"2026-08-20T16:00:01.000Z","sha256":"bbbb"}]6489d18"}]';

function tornFile() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-heal-'));
  const p = join(dir, 'agent-a1.json');
  writeFileSync(p, TORN);
  return { dir, p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('readLedger on a torn file salvages the leading valid array — never throws', () => {
  const { p, cleanup } = tornFile();
  try {
    let entries;
    assert.doesNotThrow(() => {
      entries = readLedger(p);
    }, 'a torn ledger must degrade, not crash every downstream gate');
    assert.ok(Array.isArray(entries), 'always an array');
    assert.equal(entries.length, 2, 'the leading valid entries are salvaged, not discarded');
    assert.equal(entries[0].path, 'src/a.mjs');
  } finally {
    cleanup();
  }
});

test('readLedger on irrecoverable garbage resets to empty — never throws', () => {
  const { dir, cleanup } = tornFile();
  try {
    const p = join(dir, 'agent-a2.json');
    writeFileSync(p, '{not json at all');
    assert.doesNotThrow(() => assert.deepEqual(readLedger(p), []));
  } finally {
    cleanup();
  }
});

test('appendRead on a torn file REPAIRS it: the write lands and the file parses clean afterward', () => {
  const { p, cleanup } = tornFile();
  try {
    assert.doesNotThrow(() =>
      appendRead(p, { agent_id: 'a1', path: 'src/c.mjs', at: '2026-08-20T16:01:00.000Z', sha256: 'cccc' })
    );
    const raw = readFileSync(p, 'utf8');
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(raw);
    }, 'after one append the file is valid JSON again — self-heal, not perpetuated tear');
    assert.equal(parsed.length, 3, 'salvaged entries + the new one');
    assert.equal(parsed[2].path, 'src/c.mjs');
  } finally {
    cleanup();
  }
});

test('hasFreshRead on a torn ledger answers false for an unread path — a clean deny, never a thrown gate-crash', () => {
  const { p, cleanup } = tornFile();
  try {
    let fresh;
    assert.doesNotThrow(() => {
      fresh = hasFreshRead(p, 'src/never-read.mjs', join(tmpdir(), 'nope'));
    }, "H3's evidence check must produce its normal worded denial, not 'contract evaluation failed'");
    assert.equal(fresh, false);
  } finally {
    cleanup();
  }
});

test('isLedgerTorn: true on torn bytes (including irrecoverable garbage), false on absent/empty/well-formed', () => {
  const { p, dir, cleanup } = tornFile();
  try {
    assert.equal(isLedgerTorn(p), true, 'present, non-empty, invalid JSON — the exact race shape');
    assert.equal(isLedgerTorn(join(dir, 'does-not-exist.json')), false, 'absent is not torn');
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, '');
    assert.equal(isLedgerTorn(empty), false, 'empty is not torn — never written yet');
    const wellFormed = join(dir, 'ok.json');
    writeFileSync(wellFormed, JSON.stringify([{ agent_id: 'a1', path: 'src/a.mjs', at: '2026-08-20T16:00:00.000Z' }]));
    assert.equal(isLedgerTorn(wellFormed), false, 'valid JSON is not torn');
    const garbage = join(dir, 'garbage.json');
    writeFileSync(garbage, '{not json at all');
    assert.equal(isLedgerTorn(garbage), true, 'irrecoverable garbage is still torn bytes');
  } finally {
    cleanup();
  }
});
