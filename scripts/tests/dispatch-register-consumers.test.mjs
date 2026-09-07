// R1 PIN RE-CUT — the SCRIPT-SIDE register consumers: classifyRegister and the
// one advisory line check-projection-fresh / build-hooks print (inFlightAdvisory).
//
// CONTRACT SOURCE: decision `review-receipt-rebuild-invariant-three-owner-modules-tri-state-liveness-receipt-bound-supersession`
// + contract sheet §1.1 / §6 A6, A9. Advisory-only — nothing here gates.
//
// RETIRED: 'liveDispatches: fresh entries count, stale and future-stamped entries do not, TTL comes from config'
//   — liveDispatches is deleted with every TTL predicate outside dispatchStatus; a
//     binary live/dead verdict from age is the exact claim the rebuild forbids
//     (an expired lease is 'unknown', never 'dead'). Re-cut as R1-A60/A61.
// RETIRED: 'liveDispatches: missing register, corrupt JSON, and non-array shapes all read as empty — never a throw'
//   — collapsing absent/corrupt/ok-and-empty into one empty array IS the all-clear
//     the decision forbids. Re-cut as R1-A62/A63 over readRegister's availability.
// RETIRED: the prose assertion /^2 dispatch\(es\) in flight/ as the advisory's identity
//   — converted to a [code]-token + facts assertion per §4.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRegister, inFlightAdvisory, readRegister } from '../lib/dispatch-register.mjs';

const token = (c) => new RegExp('\\[' + c + '\\]');
const MIN = 60_000;

function project(entries, config) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-reg-consumers-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  if (entries !== undefined) {
    writeFileSync(
      join(dir, '.sterling', 'transient', 'dispatch-register.json'),
      typeof entries === 'string' ? entries : JSON.stringify(entries)
    );
  }
  if (config) writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const entry = (id, agoMs, over = {}) => ({
  agent_id: id,
  agent_type: 'coder',
  session_id: 's1',
  files: ['src/x.mjs'],
  attribution: 'block',
  at: new Date(Date.now() - agoMs).toISOString(),
  ...over,
});

const ctx = (over = {}) => ({ now: Date.now(), sessionId: 's1', staleMinutes: 5, ...over });

// ===========================================================================
// R1-A60/A61 — the TTL is a LEASE, not a death certificate.
// ===========================================================================

test('R1-A60: classifyRegister sorts the same register into presumed-active / unknown / inactive-confirmed — an out-of-lease entry is UNKNOWN, never dropped', async () => {
  const { dir, cleanup } = project(
    [
      entry('fresh', MIN),
      entry('expired', 10 * MIN),
      entry('future', -2 * MIN),
      entry('stopped', MIN, { ended: { at: new Date().toISOString(), event: 'subagent-stop' } }),
    ],
    { dispatch_register: { stale_minutes: 5 } }
  );
  try {
    const c = await classifyRegister(dir, ctx());
    assert.equal(c.availability, 'ok');
    const by = Object.fromEntries(c.entries.map((r) => [r.entry.agent_id, r]));
    assert.equal(Object.keys(by).length, 4, 'no entry is silently filtered out of the classification');
    assert.equal(by.fresh.status, 'presumed-active');
    assert.equal(by.expired.status, 'unknown', 'an expired lease is unknown — the platform emits no death signal');
    assert.equal(by.expired.reason, 'lease-expired');
    assert.equal(by.future.status, 'unknown', 'a future-stamped entry is unknown, never presumed active');
    assert.equal(by.stopped.status, 'inactive-confirmed', 'only a terminal EVENT confirms inactivity');
  } finally {
    cleanup();
  }
});

test('R1-A61: the lease length comes from config.dispatch_register.stale_minutes — the same entry flips presumed-active under a longer lease', async () => {
  const { dir, cleanup } = project([entry('a1', 10 * MIN)], { dispatch_register: { stale_minutes: 5 } });
  try {
    const short = await classifyRegister(dir, ctx({ staleMinutes: 5 }));
    assert.equal(short.entries[0].status, 'unknown');
    const long = await classifyRegister(dir, ctx({ staleMinutes: 60 }));
    assert.equal(long.entries[0].status, 'presumed-active', 'the lease is configuration, not a constant');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-A62/A63 — availability is not emptiness.
// ===========================================================================

test('R1-A62: absent, corrupt and non-array registers each report their availability and enumerate nothing — never a throw', async () => {
  const none = project(undefined);
  const corrupt = project('{not json');
  const wrongShape = project({ agent_id: 'x' });
  try {
    for (const [label, p, expected] of [
      ['absent', none, 'absent'],
      ['corrupt', corrupt, 'corrupt'],
      ['non-array', wrongShape, 'corrupt'],
    ]) {
      const r = await readRegister(p.dir);
      assert.equal(r.availability, expected, `${label} must report availability '${expected}'`);
      assert.deepEqual(r.entries, [], `${label} enumerates nothing`);
    }
  } finally {
    none.cleanup();
    corrupt.cleanup();
    wrongShape.cleanup();
  }
});

// CONTROL for A62: a READABLE register that happens to be empty is 'ok'. Without
// this arm, "availability is reported" is satisfiable by a reader that calls
// everything unavailable.
test('R1-A63 CONTROL: an empty array on disk is availability "ok" — readable-and-empty is the only legitimate all-clear', async () => {
  const { dir, cleanup } = project([]);
  try {
    const r = await readRegister(dir);
    assert.equal(r.availability, 'ok');
    assert.deepEqual(r.entries, []);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// inFlightAdvisory — the one line the CLIs print.
// ===========================================================================

test('R1-A64: inFlightAdvisory names the in-flight dispatches, their STATUS, and the consumer-supplied consequence', async () => {
  const { dir, cleanup } = project([entry('a1', 1000), entry('a2', 2000), entry('a3', 10 * MIN)], { dispatch_register: { stale_minutes: 5 } });
  try {
    const line = await inFlightAdvisory(dir, 'the consequence clause.', ctx());
    assert.ok(line, 'a non-empty register yields a line');
    assert.match(line, /coder:a1/);
    assert.match(line, /coder:a2/);
    assert.match(line, /coder:a3/, 'an unknown-status dispatch is disclosed, not filtered away');
    assert.match(line, /presumed-active/, 'the line names what it actually knows');
    assert.match(line, /unknown/, 'and names what it does not');
    assert.match(line, /the consequence clause\.$/, 'the caller-supplied consequence closes the line');
    assert.doesNotMatch(line, /NaN/);
  } finally {
    cleanup();
  }
});

// CONTROL, and the one legitimate silence: readable AND empty.
test('R1-A65 CONTROL: inFlightAdvisory returns null for a readable, EMPTY register — the all-clear it is allowed to give', async () => {
  const { dir, cleanup } = project([]);
  try {
    assert.equal(await inFlightAdvisory(dir, 'x', ctx()), null);
  } finally {
    cleanup();
  }
});

test('R1-A66: an UNAVAILABLE register yields the single unavailability line carrying [register_unavailable] — never null, never an enumeration', async () => {
  const corrupt = project('{not json');
  const absent = project(undefined);
  try {
    for (const [label, p, availability] of [
      ['corrupt', corrupt, 'corrupt'],
      ['absent', absent, 'absent'],
    ]) {
      const line = await inFlightAdvisory(p.dir, 'the consequence clause.', ctx());
      assert.ok(line, `${label}: an unreadable register is never a silent all-clear`);
      assert.equal(line.split('\n').length, 1, `${label}: exactly one line`);
      assert.match(line, token('register_unavailable'), `${label}: the line carries its code`);
      assert.match(line, new RegExp(availability), `${label}: the line names WHICH unavailability it is`);
      assert.doesNotMatch(line, /coder:/, `${label}: an unreadable register never enumerates individually-unknown agents`);
    }
  } finally {
    corrupt.cleanup();
    absent.cleanup();
  }
});

// A6 — every advisory line carries its code token.
test('R1-A67: every inFlightAdvisory line carries a [snake_case] code token', async () => {
  const busy = project([entry('a1', 1000)], { dispatch_register: { stale_minutes: 5 } });
  const corrupt = project('{not json');
  try {
    for (const p of [busy, corrupt]) {
      const line = await inFlightAdvisory(p.dir, 'consequence.', ctx());
      assert.ok(line);
      assert.match(line, /\[[a-z][a-z0-9_]*\]/, `advisory line must carry its code: ${line}`);
    }
  } finally {
    busy.cleanup();
    corrupt.cleanup();
  }
});
