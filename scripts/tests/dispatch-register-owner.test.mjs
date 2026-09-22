// R1 PIN RE-CUT — scripts/lib/dispatch-register.mjs, THE register owner module.
//
// CONTRACT SOURCE: decision `review-receipt-rebuild-invariant-three-owner-modules-tri-state-liveness-receipt-bound-supersession`
// + the R1 contract sheet §1.1 / §6 A1, A2, A4, A5, A6, A9. This file pins the
// MODULE surface: one parser, one availability reader, one tri-state
// classifier, one kernel-held register lock. Consumer POLICY lives in the consumer
// files (h26-dispatch-overlap, h10-dispatch-status-policy, rotation-note-live-
// dispatches, dispatch-register-consumers).
//
// SHAPE AGNOSTICISM (deliberate, stated rather than silently assumed): the
// sheet settles the CODES and the BEHAVIOUR of every refusal, not whether a
// refusal is thrown or returned, and not whether these functions are sync or
// async. Every call below is `await`ed (correct for both) and every refusal is
// read through refusalOf(), which accepts a throw OR a {ok:false, code}
// return. The pin is the CODE and the observable effect, never the calling
// convention.
//
// NEW FILE — nothing is RETIRED here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as REG from '../lib/dispatch-register.mjs';

const LEASE = 60; // staleMinutes used by every status pin below
const MIN = 60_000;

function project(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-reg-owner-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  if (entries !== undefined) {
    writeFileSync(
      join(dir, '.sterling', 'transient', 'dispatch-register.json'),
      typeof entries === 'string' ? entries : JSON.stringify(entries)
    );
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const entry = (over = {}) => ({
  agent_id: 'a1',
  agent_type: 'coder',
  session_id: 's1',
  files: ['src/x.mjs'],
  files_source: 'review-territory',
  claimed_files: [],
  claimed_glob_prefixes: [],
  attribution: 'block',
  at: new Date(Date.now() - MIN).toISOString(),
  ...over,
});

const ctx = (over = {}) => ({ now: Date.now(), sessionId: 's1', staleMinutes: LEASE, ...over });

// Accepts a refusal delivered as a throw OR as a {ok:false, code} return.
async function refusalOf(fn) {
  let value;
  try {
    value = await fn();
  } catch (err) {
    return { code: err?.code, facts: err?.facts, threw: true, err };
  }
  return { code: value?.code, facts: value?.facts, threw: false, value };
}

function readRaw(dir) {
  return JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), 'utf8'));
}

// A pid that is provably not running: a child that has already exited.

// ===========================================================================
// MODULE SURFACE — one owner, and the removed names are GONE
// ===========================================================================

test('R1-A01: scripts/lib/dispatch-register.mjs exports the whole owner surface', () => {
  for (const name of [
    'registerPath',
    'registerLockPath',
    'legacyRegisterLockDir',
    'parseRegisterEntry',
    'readRegister',
    'withRegisterLock',
    'registerStart',
    'registerEnd',
    'dispatchStatus',
    'statusReason',
    'classifyRegister',
    'formatDispatchRef',
    'inFlightAdvisory',
  ]) {
    assert.equal(typeof REG[name], 'function', `missing owner export '${name}'`);
  }
});

// The removed-name pin is the other half of "one owner module": a consumer that
// can still import a second liveness notion has not been re-pointed, it has been
// left beside the owner.
test('R1-A02: the retired liveness/lock names are NOT exported — importing one is a defect, not a fallback', () => {
  for (const name of ['liveDispatches', 'liveDispatchesOrUnknown', 'acquireLock', 'filterLive', 'withLedgerLock', 'resolveSessionIdentity', 'withOwnerMkdirLock', 'registerLockDir']) {
    assert.equal(REG[name], undefined, `'${name}' must not survive the rebuild — every TTL predicate lives in dispatchStatus, withLedgerLock/resolveSessionIdentity had no non-test caller (H22 slim-down), and withOwnerMkdirLock/registerLockDir were the retired mkdir lock`);
  }
});

test('R1-A03: registerPath names the register in .sterling/transient; the lock is OUTSIDE the project (registerLockPath); legacyRegisterLockDir names the retired mkdir lock', () => {
  const { dir, cleanup } = project([]);
  try {
    assert.equal(REG.registerPath(dir), join(dir, '.sterling', 'transient', 'dispatch-register.json'));
    const lockPath = REG.registerLockPath(dir);
    assert.ok(!lockPath.startsWith(dir), `the lock is outside the project tree: ${lockPath}`);
    assert.match(lockPath, /\/sterling-locks(-\d+)?\/[0-9a-f]{64}\.db$/, `a per-user lock root (layout pinned in dispatch-register-kernel-lock KL-0/KL-0b): ${lockPath}`);
    assert.equal(REG.legacyRegisterLockDir(dir), join(dir, '.sterling', 'transient', 'dispatch-register.lock'));
  } finally {
    cleanup();
  }
});

// ===========================================================================
// readRegister — availability, never a throw
// ===========================================================================

test('R1-A04: readRegister on a MISSING file is availability "absent" with no entries — never a throw', async () => {
  const { dir, cleanup } = project(undefined);
  try {
    const r = await REG.readRegister(dir);
    assert.equal(r.availability, 'absent');
    assert.deepEqual(r.entries, []);
  } finally {
    cleanup();
  }
});

test('R1-A05: readRegister on unparseable JSON is availability "corrupt" with entries [] — never a throw', async () => {
  const { dir, cleanup } = project('{not json,,,');
  try {
    const r = await REG.readRegister(dir);
    assert.equal(r.availability, 'corrupt');
    assert.deepEqual(r.entries, []);
  } finally {
    cleanup();
  }
});

test('R1-A06: readRegister on valid JSON that is NOT an array is "corrupt" — a shape that parses is not a register', async () => {
  const { dir, cleanup } = project({ agent_id: 'not-an-array' });
  try {
    const r = await REG.readRegister(dir);
    assert.equal(r.availability, 'corrupt');
    assert.deepEqual(r.entries, []);
  } finally {
    cleanup();
  }
});

// CONTROL for A04-A06: a readable register is 'ok' even when it is EMPTY.
// Without this arm every "availability" assertion above could be satisfied by a
// reader that never returns 'ok' at all.
test('R1-A07 CONTROL: an empty array on disk is availability "ok" with zero entries — readable-and-empty is NOT unavailable', async () => {
  const { dir, cleanup } = project([]);
  try {
    const r = await REG.readRegister(dir);
    assert.equal(r.availability, 'ok');
    assert.deepEqual(r.entries, []);
    assert.equal(r.dropped, 0);
  } finally {
    cleanup();
  }
});

test('R1-A08: individually malformed entries are DROPPED and COUNTED, the readable remainder survives as "ok"', async () => {
  const { dir, cleanup } = project([entry({ agent_id: 'good-1' }), { agent_type: 'coder', session_id: 's1' }, 'not-an-object']);
  try {
    const r = await REG.readRegister(dir);
    assert.equal(r.availability, 'ok', 'one bad entry does not condemn the file');
    assert.deepEqual(r.entries.map((e) => e.agent_id), ['good-1']);
    assert.equal(r.dropped, 2, 'both malformed entries are counted, not silently swallowed');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// parseRegisterEntry — ONE parser authority
// ===========================================================================

test('R1-A09: parseRegisterEntry accepts a full entry and returns it', () => {
  const r = REG.parseRegisterEntry(entry());
  assert.equal(r.ok, true, `expected ok:true, got ${JSON.stringify(r)}`);
  assert.equal(r.entry.agent_id, 'a1');
});

// A LEGACY-shaped entry (no files_source / claimed_files / claimed_glob_prefixes)
// is what every pre-rebuild register on disk actually contains, and what
// dispatch-advisory-glob-prefix (C3) pins the read side against. It must parse.
test('R1-A10: parseRegisterEntry accepts the minimal legacy shape — a missing claimed_* / files_source field is not malformed', () => {
  const r = REG.parseRegisterEntry({
    agent_id: 'legacy-1',
    agent_type: 'coder',
    session_id: 's1',
    files: ['src/x.mjs'],
    at: new Date().toISOString(),
    attribution: 'block',
  });
  assert.equal(r.ok, true, `the legacy on-disk shape must survive the one parser, got ${JSON.stringify(r)}`);
});

test('R1-A11: parseRegisterEntry refuses non-objects, a missing agent_id, and a non-array files — all with register_entry_malformed', () => {
  for (const bad of [
    'not-an-object',
    null,
    entry({ agent_id: undefined }),
    entry({ files: 'src/x.mjs' }),
    entry({ session_id: undefined }),
  ]) {
    const r = REG.parseRegisterEntry(bad);
    assert.equal(r.ok, false, `expected a refusal for ${JSON.stringify(bad)}`);
    assert.equal(r.code, 'register_entry_malformed', `expected register_entry_malformed for ${JSON.stringify(bad)}`);
  }
});

// ===========================================================================
// dispatchStatus — the TRI-STATE. Age NEVER means dead.
// ===========================================================================

test('R1-A12: an ended entry is inactive-confirmed — the terminal EVENT is the only thing that confirms death', () => {
  const e = entry({ at: new Date().toISOString(), ended: { at: new Date().toISOString(), event: 'subagent-stop' } });
  assert.equal(REG.dispatchStatus(e, ctx()), 'inactive-confirmed');
});

test('R1-A13: same session, inside the lease, no ended marker — presumed-active', () => {
  assert.equal(REG.dispatchStatus(entry({ at: new Date(Date.now() - 5 * MIN).toISOString() }), ctx()), 'presumed-active');
});

// THE CENTRAL PIN of the rebuild: the platform emits no death signal for a
// killed subagent, so an expired lease can only ever mean "unknown".
test('R1-A14: AGE NEVER YIELDS INACTIVE-CONFIRMED — an entry 10x the lease old in the SAME session is unknown/lease-expired, not dead', () => {
  const old = entry({ at: new Date(Date.now() - 10 * LEASE * MIN).toISOString() });
  assert.equal(REG.dispatchStatus(old, ctx()), 'unknown');
  assert.equal(REG.statusReason(old, ctx()), 'lease-expired');
});

// A2: other-session entries are no longer pruned on write; they classify.
test('R1-A15: a foreign-session entry is unknown/other-session — never pruned into non-existence, never presumed active', () => {
  const foreign = entry({ session_id: 's2', at: new Date().toISOString() });
  assert.equal(REG.dispatchStatus(foreign, ctx({ sessionId: 's1' })), 'unknown');
  assert.equal(REG.statusReason(foreign, ctx({ sessionId: 's1' })), 'other-session');
});

test('R1-A16: an unparseable `at` is unknown/clock-unreadable — never a fabricated age, never inactive-confirmed', () => {
  const bad = entry({ at: 'whenever' });
  assert.equal(REG.dispatchStatus(bad, ctx()), 'unknown');
  assert.equal(REG.statusReason(bad, ctx()), 'clock-unreadable');
});

test('R1-A17: a FUTURE-stamped entry (negative age) is unknown, not presumed-active — 0 <= age < lease is the whole window', () => {
  assert.equal(REG.dispatchStatus(entry({ at: new Date(Date.now() + 10 * MIN).toISOString() }), ctx()), 'unknown');
});

// The ended marker OUTRANKS every other axis: a foreign-session ended entry is
// still confirmed dead. Without this arm, "inactive-confirmed" could be an
// artefact of the session join rather than of the terminal event.
test('R1-A18 CONTROL: ended outranks session and age — a foreign-session, lease-expired, ENDED entry is still inactive-confirmed', () => {
  const e = entry({
    session_id: 's2',
    at: new Date(Date.now() - 10 * LEASE * MIN).toISOString(),
    ended: { at: new Date().toISOString(), event: 'subagent-stop' },
  });
  assert.equal(REG.dispatchStatus(e, ctx({ sessionId: 's1' })), 'inactive-confirmed');
});

// ===========================================================================
// classifyRegister + formatDispatchRef
// ===========================================================================

test('R1-A19: classifyRegister returns availability plus one {entry, status, reason, ageMs} row per entry', async () => {
  const { dir, cleanup } = project([
    entry({ agent_id: 'fresh', at: new Date(Date.now() - MIN).toISOString() }),
    entry({ agent_id: 'expired', at: new Date(Date.now() - 10 * LEASE * MIN).toISOString() }),
    entry({ agent_id: 'stopped', ended: { at: new Date().toISOString(), event: 'subagent-stop' } }),
    entry({ agent_id: 'badclock', at: 'whenever' }),
  ]);
  try {
    const c = await REG.classifyRegister(dir, ctx());
    assert.equal(c.availability, 'ok');
    const by = Object.fromEntries(c.entries.map((row) => [row.entry.agent_id, row]));
    assert.equal(by.fresh.status, 'presumed-active');
    assert.equal(by.expired.status, 'unknown');
    assert.equal(by.expired.reason, 'lease-expired');
    assert.equal(by.stopped.status, 'inactive-confirmed');
    assert.equal(by.badclock.status, 'unknown');
    assert.equal(by.badclock.reason, 'clock-unreadable');
    assert.equal(by.badclock.ageMs, null, 'an unreadable clock yields a null age, never NaN');
    assert.ok(by.fresh.ageMs > 0, 'a readable clock yields a real measured age');
  } finally {
    cleanup();
  }
});

test('R1-A20: classifyRegister on a corrupt register reports the availability and enumerates NOTHING', async () => {
  const { dir, cleanup } = project('{not json');
  try {
    const c = await REG.classifyRegister(dir, ctx());
    assert.equal(c.availability, 'corrupt');
    assert.deepEqual(c.entries, [], 'an unreadable register never yields a per-agent enumeration');
  } finally {
    cleanup();
  }
});

test('R1-A21: formatDispatchRef names the dispatch, its MEASURED age and its status', async () => {
  const { dir, cleanup } = project([
    entry({ agent_id: 'fresh1', agent_type: 'coder', at: new Date().toISOString() }),
    entry({ agent_id: 'mid1', agent_type: 'test-writer', at: new Date(Date.now() - 12 * MIN).toISOString() }),
    entry({ agent_id: 'old1', agent_type: 'reviewer-x', at: new Date(Date.now() - 125 * MIN).toISOString() }),
  ]);
  try {
    const rows = (await REG.classifyRegister(dir, ctx())).entries;
    const ref = (id) => REG.formatDispatchRef(rows.find((r) => r.entry.agent_id === id));
    assert.match(ref('fresh1'), /coder:fresh1 \(registered <1m/);
    assert.match(ref('mid1'), /test-writer:mid1 \(registered 12m/, 'the age is measured, not a fixed label');
    assert.match(ref('old1'), /reviewer-x:old1 \(registered 2h5m/, 'hours+minutes for an age past the hour');
    for (const id of ['fresh1', 'mid1', 'old1']) assert.doesNotMatch(ref(id), /NaN/);
  } finally {
    cleanup();
  }
});

test('R1-A22: formatDispatchRef prints "age unreadable" for an unparseable `at` — never NaN, never a fabricated age', async () => {
  const { dir, cleanup } = project([entry({ agent_id: 'badclock', agent_type: 'coder', at: 'whenever' })]);
  try {
    const [row] = (await REG.classifyRegister(dir, ctx())).entries;
    const ref = REG.formatDispatchRef(row);
    assert.match(ref, /coder:badclock/);
    assert.match(ref, /age unreadable/);
    assert.doesNotMatch(ref, /NaN/);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// registerStart / registerEnd — A1 (Stop MARKS) + A4 (rounds)
// ===========================================================================

test('R1-A23: registerStart appends the entry (round 1) under the lock', async () => {
  const { dir, cleanup } = project([]);
  try {
    await REG.registerStart(dir, entry({ agent_id: 'r1' }));
    const reg = readRaw(dir);
    assert.equal(reg.length, 1);
    assert.equal(reg[0].agent_id, 'r1');
    assert.equal(reg[0].round, 1, 'rounds are 1-based');
  } finally {
    cleanup();
  }
});

test('R1-A24: registerStart REFUSES a duplicate agent_id while an UNENDED same-session entry exists (register_agent_id_duplicate), appending nothing', async () => {
  const { dir, cleanup } = project([entry({ agent_id: 'dup' })]);
  try {
    const r = await refusalOf(() => REG.registerStart(dir, entry({ agent_id: 'dup' })));
    assert.equal(r.code, 'register_agent_id_duplicate');
    assert.equal(readRaw(dir).length, 1, 'the refusal appends nothing');
  } finally {
    cleanup();
  }
});

// A4, measured 2026-09-07: resuming an agent fires SubagentStart again with the
// SAME agent_id, so the duplicate refusal must be scoped to UNENDED entries or
// every resumed review round loses its receipt.
test('R1-A25: after an ENDED entry, the same agent_id is ADMITTED as round n+1 — a resumed round is not a duplicate', async () => {
  const { dir, cleanup } = project([entry({ agent_id: 'resumed', round: 1, ended: { at: new Date().toISOString(), event: 'subagent-stop' } })]);
  try {
    const r = await refusalOf(() => REG.registerStart(dir, entry({ agent_id: 'resumed' })));
    assert.equal(r.code, undefined, `an ended predecessor must not refuse the next round: ${JSON.stringify(r)}`);
    const reg = readRaw(dir);
    assert.equal(reg.length, 2, 'the new round is appended beside the ended one, never overwriting it');
    const unended = reg.filter((e) => !e.ended);
    assert.equal(unended.length, 1);
    assert.equal(unended[0].round, 2, 'round n+1');
  } finally {
    cleanup();
  }
});

test('R1-A26: a duplicate agent_id in a DIFFERENT session is not a duplicate — the refusal is (session_id, agent_id)-scoped', async () => {
  const { dir, cleanup } = project([entry({ agent_id: 'x', session_id: 's2' })]);
  try {
    const r = await refusalOf(() => REG.registerStart(dir, entry({ agent_id: 'x', session_id: 's1' })));
    assert.equal(r.code, undefined, `a foreign-session holder must not block a local Start: ${JSON.stringify(r)}`);
    assert.equal(readRaw(dir).length, 2);
  } finally {
    cleanup();
  }
});

// A1: the entry STAYS. inactive-confirmed is only a real classifier output
// because the evidence for it survives on disk.
test('R1-A27: registerEnd MARKS ended {at, event} and the entry REMAINS — it is never deleted at Stop', async () => {
  const { dir, cleanup } = project([entry({ agent_id: 'e1' }), entry({ agent_id: 'e2' })]);
  try {
    const r = await REG.registerEnd(dir, 'e1', 'subagent-stop');
    assert.notEqual(r?.found, false, 'a matching agent_id is found');
    const reg = readRaw(dir);
    assert.equal(reg.length, 2, 'Stop marks, it does not remove');
    const ended = reg.find((e) => e.agent_id === 'e1');
    assert.equal(ended.ended.event, 'subagent-stop');
    assert.ok(!Number.isNaN(Date.parse(ended.ended.at)), 'ended.at is a parseable instant');
    assert.equal(REG.dispatchStatus(ended, ctx()), 'inactive-confirmed');
    assert.equal(reg.find((e) => e.agent_id === 'e2').ended, undefined, 'the sibling is untouched');
  } finally {
    cleanup();
  }
});

test('R1-A28: registerEnd on an unknown agent_id returns {found:false} and mutates nothing — no throw', async () => {
  const { dir, cleanup } = project([entry({ agent_id: 'e1' })]);
  try {
    const before = readFileSync(REG.registerPath(dir), 'utf8');
    const r = await REG.registerEnd(dir, 'nobody', 'subagent-stop');
    assert.equal(r.found, false);
    assert.equal(readFileSync(REG.registerPath(dir), 'utf8'), before, 'byte-identical after a no-match');
  } finally {
    cleanup();
  }
});

test('R1-A29: registerEnd selects the single UNENDED (session_id, agent_id) entry, leaving an earlier ended round alone', async () => {
  const { dir, cleanup } = project([
    entry({ agent_id: 'multi', round: 1, ended: { at: '2026-09-07T00:00:00.000Z', event: 'subagent-stop' } }),
    entry({ agent_id: 'multi', round: 2 }),
  ]);
  try {
    await REG.registerEnd(dir, 'multi', 'subagent-stop');
    const reg = readRaw(dir);
    assert.equal(reg.length, 2);
    assert.equal(reg[0].ended.at, '2026-09-07T00:00:00.000Z', 'the earlier round keeps its own terminal instant');
    assert.equal(reg[1].ended.event, 'subagent-stop');
    assert.notEqual(reg[1].ended.at, '2026-09-07T00:00:00.000Z');
  } finally {
    cleanup();
  }
});

test('R1-A30: registerEnd with ZERO unended entries for that agent_id returns {found:false} — a Stop without a live round binds nothing', async () => {
  const { dir, cleanup } = project([entry({ agent_id: 'done', ended: { at: '2026-09-07T00:00:00.000Z', event: 'subagent-stop' } })]);
  try {
    const r = await REG.registerEnd(dir, 'done', 'subagent-stop');
    assert.equal(r.found, false, 'an already-ended round is not re-ended, and never refreshed');
    assert.equal(readRaw(dir)[0].ended.at, '2026-09-07T00:00:00.000Z');
  } finally {
    cleanup();
  }
});

// R1-A39 (review of the rebuilt owner): the unended round is selected by the
// PAIR (session_id, agent_id), never by agent_id alone — the same agent_id can
// legitimately be unended in two sessions at once (A2 stopped pruning
// other-session entries on write), and marking the wrong one ends a round that
// is still running while leaving the real one open forever.
//
// SIGNATURE, PINNED NOT ASSUMED (read wall: scripts/lib/dispatch-register.mjs
// was not read): the sheet's registerEnd(root, agent_id, event) carries no
// session, so this pins the caller passing one as a trailing options argument,
// `{ sessionId }` — additive, so the 3-arg calls in R1-A27..A30 above keep
// working against a register holding one session. The coder adopts it.
// SABOTAGE: select the unended entry by agent_id alone -> whichever entry comes
// first is marked, so either the 's1' assertion or the 's2'-stays-unended
// assertion goes red, while the CONTROL below stays green either way.
test('R1-A39: registerEnd selects by (session_id, agent_id) — ending in one session leaves the other session\'s unended round alone', async () => {
  const { dir, cleanup } = project([
    entry({ agent_id: 'multi', session_id: 's2', at: new Date(Date.now() - 2 * MIN).toISOString() }),
    entry({ agent_id: 'multi', session_id: 's1' }),
  ]);
  try {
    const r = await REG.registerEnd(dir, 'multi', 'subagent-stop', { sessionId: 's1' });
    assert.notEqual(r?.found, false, "session s1's round is found");
    const reg = readRaw(dir);
    assert.equal(reg.length, 2, 'both rounds survive — Stop marks, it never deletes');
    const s1 = reg.find((e) => e.session_id === 's1');
    const s2 = reg.find((e) => e.session_id === 's2');
    assert.equal(s1.ended?.event, 'subagent-stop', "the ending session's round is the one marked");
    assert.equal(s2.ended, undefined, "the OTHER session's round is still running and must stay unended");
  } finally {
    cleanup();
  }
});

test('R1-A39 CONTROL: with the sole unended round in the NAMED session, that round is ended — the pair select is not a way of never matching', async () => {
  const { dir, cleanup } = project([entry({ agent_id: 'multi', session_id: 's1' })]);
  try {
    const r = await REG.registerEnd(dir, 'multi', 'subagent-stop', { sessionId: 's1' });
    assert.notEqual(r?.found, false);
    assert.equal(readRaw(dir)[0].ended?.event, 'subagent-stop');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// withRegisterLock — the KERNEL-HELD register lock (decision
// `dispatch-register-lock-reclaims-an-ownerless-lock-and-releases-only-its-own`,
// REVISED block). The cross-process scenarios (a dead holder, N contending
// processes, a paused holder) are pinned in
// scripts/tests/dispatch-register-kernel-lock.test.mjs; what stays HERE is the
// module-level contract every register writer relies on.
//
// REMOVED 2026-09-22 with the mkdir protocol they pinned (each asserted an
// internal of a mechanism that no longer exists):
//   R1-A33 (a dead-pid owner.json is taken over) — there is no owner file and
//     no takeover; "a dead holder frees the lock" is now KL-a (process.exit and
//     SIGKILL, real processes).
//   R1-A34 (a foreign-host owner is never taken) — no owner, no host; a kernel
//     lock cannot be held from another host at all.
//   R1-A35 (a fresh live-pid owner refuses) — folded into R1-A32 below, which
//     now holds the lock for real instead of forging an owner.json.
//   LK-1, LK-2 (an OWNERLESS / unreadable-owner lock dir older than 60s is
//     reclaimed) — no reclaim exists. The surviving behaviour, "a leftover
//     empty lock dir never jams the register", is ported to KL-L1 (removed as
//     residue, said once) and KL-L2 (non-empty: never blocks, left, warned).
//   LK-3 (a YOUNG ownerless dir still holds) — inverted by design: the legacy
//     dir holds nothing at any age (KL-L1/KL-L2).
//   LK-4 (a live-pid owner is never reclaimed however old) — the surviving
//     property, "a live holder is never displaced", is KL-c (a paused holder
//     keeps the lock; the contender refuses at its bound).
//   LK-5, LK-8 (release never deletes a successor's lock dir) — release is the
//     holder's own COMMIT/close on its own connection; there is no path it
//     could delete. Exclusion across a release is KL-b / KL-b2 and R1-A36.
//   LK-6, LK-7 (a creator paused/displaced between mkdir and its owner write
//     never enters fn) — there is no mkdir/owner-write window; acquisition is
//     the single BEGIN IMMEDIATE. "Never two writers" is KL-b / KL-b2.
// ===========================================================================

// Holds the register lock from THIS process through a separate connection —
// a genuine hold, exactly what another writer would take.
function holdLock(dir) {
  mkdirSync(dirname(REG.registerLockPath(dir)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(REG.registerLockPath(dir));
  db.exec('BEGIN IMMEDIATE');
  return () => {
    db.exec('ROLLBACK');
    db.close();
  };
}

test('R1-A31: withRegisterLock runs fn holding the lock, returns its result, and releases after — nothing is written under .sterling/transient', async () => {
  const { dir, cleanup } = project([]);
  try {
    let heldInside = null;
    const value = await REG.withRegisterLock(dir, async () => {
      heldInside = await refusalOf(() => REG.withRegisterLock(dir, () => 'nested', { retryMs: 10, timeoutMs: 0 }));
      return 'result';
    }, { retryMs: 20, timeoutMs: 500 });
    assert.equal(value, 'result', "the wrapper returns fn's result");
    assert.equal(heldInside.code, 'register_lock_held', 'the lock is really held while fn runs (and it is not reentrant)');
    assert.equal(await REG.withRegisterLock(dir, () => 'next', { timeoutMs: 0 }), 'next', 'released when fn returns — the next single attempt enters');
    assert.equal(existsSync(REG.legacyRegisterLockDir(dir)), false, 'no mkdir lock dir is created');
  } finally {
    rmSync(REG.registerLockPath(dir), { force: true });
    cleanup();
  }
});

test('R1-A32: a HELD lock refuses a second entrant with register_lock_held naming facts.lock_path — fn never runs and the holder keeps the lock', async () => {
  const { dir, cleanup } = project([]);
  const release = holdLock(dir);
  try {
    let ran = false;
    const r = await refusalOf(() => REG.withRegisterLock(dir, () => { ran = true; }, { retryMs: 10, timeoutMs: 120 }));
    assert.equal(r.code, 'register_lock_held', `expected register_lock_held, got ${JSON.stringify(r)}`);
    assert.equal(ran, false, 'the critical section never ran');
    assert.equal(r.facts?.lock_path, REG.registerLockPath(dir), 'the refusal names the lock database');
    const again = await refusalOf(() => REG.withRegisterLock(dir, () => { ran = true; }, { timeoutMs: 0 }));
    assert.equal(again.code, 'register_lock_held', 'the holder was not displaced by the refused contender');
  } finally {
    release();
    rmSync(REG.registerLockPath(dir), { force: true });
    cleanup();
  }
});

// MUTUAL EXCLUSION, in-process and deterministic: this is the property the
// whole primitive exists for, and a no-op lock fails it immediately.
test('R1-A36: two concurrent withRegisterLock calls never overlap their critical sections, and the lock is free afterwards', async () => {
  const { dir, cleanup } = project([]);
  try {
    let inside = 0;
    let maxInside = 0;
    const body = async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((res) => setTimeout(res, 40));
      inside -= 1;
      return 'ok';
    };
    const results = await Promise.all([
      refusalOf(() => REG.withRegisterLock(dir, body, { retryMs: 10, timeoutMs: 3000 })),
      refusalOf(() => REG.withRegisterLock(dir, body, { retryMs: 10, timeoutMs: 3000 })),
    ]);
    assert.equal(maxInside, 1, 'the two critical sections must never be inside the lock at once');
    assert.ok(results.some((r) => r.code === undefined), 'at least one contender must get in');
    for (const r of results) {
      if (r.code !== undefined) assert.equal(r.code, 'register_lock_held', 'the only legitimate loss is a held-lock refusal');
    }
    assert.equal(await REG.withRegisterLock(dir, () => 'free', { timeoutMs: 0 }), 'free', 'no leftover state jams the next writer');
  } finally {
    rmSync(REG.registerLockPath(dir), { force: true });
    cleanup();
  }
});
