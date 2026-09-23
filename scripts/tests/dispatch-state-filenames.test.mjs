// DISPATCH STATE — STATUS IN THE FILENAME (decision
// `dispatch-state-status-in-filename-live-scan-parses-only-live-records`,
// knowledge_get 8b9d19de). Pins, against the owner module
// scripts/lib/dispatch-register.mjs:
//   (1) a live record is `live-<key>.json`; a terminal record is
//       `done-<key>~<ids>.json`, <ids> the sorted, de-duplicated SHA-256
//       base64url of EVERY agent id it carries (started, derived_binding,
//       post_binding), joined by '.', or the empty-set marker `none`;
//   (2) the locked hot scan parses live-* files ONLY;
//   (3) keyed reads (Pre, Post, Stop sidecar) and resumeHit match on NAMES,
//       then parse and validate — a name alone is never evidence;
//   (4) terminalization replaces the live body first, then renames; a crash
//       between the two is excluded from candidates, kept as resume evidence
//       and finished on the next locked scan; a failed rename is loud and
//       keeps the source;
//   (5) retention is by terminal.at, never mtime;
//   (6) legacy `<key>.json` files migrate at the session boundary only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as DS from '../lib/dispatch-register.mjs';

const DAY = 86_400_000;

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dispatch-names-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const stateDir = (dir) => DS.dispatchStateDir(dir);
const stateFiles = (dir) => (existsSync(stateDir(dir)) ? readdirSync(stateDir(dir)).sort() : []);
function writeStateRaw(dir, name, content) {
  mkdirSync(stateDir(dir), { recursive: true });
  writeFileSync(join(stateDir(dir), name), typeof content === 'string' ? content : JSON.stringify(content));
  return join(stateDir(dir), name);
}
const readStateRaw = (dir, name) => JSON.parse(readFileSync(join(stateDir(dir), name), 'utf8'));

// The spec's name grammar, computed HERE independently of the module.
const idHash = (id) => createHash('sha256').update(id, 'utf8').digest('base64url');
const key = (toolUseId) => DS.dispatchStateKey(toolUseId);
const liveName = (toolUseId) => `live-${key(toolUseId)}.json`;
function doneName(toolUseId, ids) {
  const hashes = [...new Set(ids.map(idHash))].sort();
  return `done-${key(toolUseId)}~${hashes.length ? hashes.join('.') : 'none'}.json`;
}

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
function terminalRecord(toolUseId, extra = {}, at = new Date().toISOString()) {
  return {
    schema: 1,
    tool_use_id: toolUseId,
    session_id: 's1',
    prompt_id: null,
    subagent_type: 'coder',
    description: 'd',
    prompt: null,
    prompt_bytes: 0,
    prompt_sha256: sha(''),
    origin: 'pre',
    pre_at: at,
    terminal: { at, reason: 'stop' },
    ...extra,
  };
}
function pendingRecord(toolUseId, subagentType = 'coder') {
  const prompt = `prompt for ${toolUseId}`;
  return {
    schema: 1,
    tool_use_id: toolUseId,
    session_id: 's1',
    prompt_id: null,
    subagent_type: subagentType,
    description: 'd',
    prompt,
    prompt_bytes: Buffer.byteLength(prompt, 'utf8'),
    prompt_sha256: sha(prompt),
    origin: 'pre',
    pre_at: new Date().toISOString(),
  };
}

const PRE = (over = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Task',
  tool_use_id: 'toolu_pre_1',
  tool_input: { subagent_type: 'coder', prompt: 'work on src/a.mjs', description: 'coder lane' },
  session_id: 's1',
  prompt_id: 'pr-1',
  ...over,
});
const POST = ({ tool_use_id = 'toolu_pre_1', prompt = 'work on src/a.mjs', agentId = 'agent-1', session_id = 's1' } = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Task',
  tool_use_id,
  tool_input: { subagent_type: 'coder', prompt, description: 'coder lane' },
  tool_response: { isAsync: true, status: 'async_launched', agentId, description: 'coder lane', prompt },
  session_id,
  prompt_id: 'pr-1',
});
const FAIL = (over = {}) => ({
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Task',
  tool_use_id: 'toolu_pre_1',
  tool_input: { subagent_type: 'coder', prompt: 'work on src/a.mjs', description: 'coder lane' },
  session_id: 's1',
  ...over,
});
const START = (over = {}) => ({ session_id: 's1', agent_id: 'agent-1', agent_type: 'coder', ...over });

async function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let text = '';
  process.stderr.write = (chunk, ...rest) => {
    text += String(chunk);
    return true;
  };
  try {
    const value = await fn();
    return { value, text };
  } finally {
    process.stderr.write = orig;
  }
}

// ===========================================================================
// (1) NAMES
// ===========================================================================

test('DSN-01: Pre writes live-<key>.json and nothing else', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    assert.deepEqual(stateFiles(dir), [liveName('toolu_pre_1')]);
  } finally {
    cleanup();
  }
});

test('DSN-02: Stop terminalizes into done-<key>~<sorted id hashes>.json, prompt cleared, the live name gone', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-derived' }), { consumer: 'h22' });
    assert.equal(res.source, 'derived-type-unique');
    // A Post naming a DIFFERENT agent: the derived/Post mismatch keeps both ids.
    await DS.recordDispatchPost(dir, POST({ agentId: 'agent-post' }));
    const fin = await DS.finishDispatchAndRegisterEnd(dir, { session_id: 's1', agent_id: 'agent-post', event: 'subagent-stop' });
    assert.ok(fin.record?.terminal, 'the Stop terminalized the record');
    const expected = doneName('toolu_pre_1', ['agent-derived', 'agent-post']);
    assert.deepEqual(stateFiles(dir), [expected]);
    assert.equal(readStateRaw(dir, expected).prompt, null);
  } finally {
    cleanup();
  }
});

test('DSN-03: a born-terminal Failure record with no agent id carries the empty-set marker', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchFailure(dir, FAIL());
    assert.deepEqual(stateFiles(dir), [doneName('toolu_pre_1', [])]);
    assert.match(stateFiles(dir)[0], /~none\.json$/);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (2) THE HOT SCAN PARSES LIVE-* ONLY
// ===========================================================================

test('DSN-04: 300 done-* files with UNPARSEABLE bodies are never parsed by the hot scan — no poison, derivation still works', async () => {
  const { dir, cleanup } = project();
  try {
    for (let i = 0; i < 300; i++) writeStateRaw(dir, doneName(`toolu_hist${i}`, [`agent-h${i}`]), '{ garbage that would poison any parse');
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_live' }));
    const scan = DS.readDispatchState(dir);
    assert.equal(scan.availability, 'ok');
    assert.deepEqual(scan.poisoned, [], 'a parsed done-* body would have been reported poisoned — it was never read');
    assert.deepEqual(scan.records.map((r) => r.record.tool_use_id), ['toolu_live']);
    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-new' }), { consumer: 'h22' });
    assert.equal(res.source, 'derived-type-unique', 'history bodies never condemn the live scan');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (3) KEYED READS LOCATE BY NAME, VALIDATE BY PARSE
// ===========================================================================

test('DSN-05: Pre after a terminal record finds it BY NAME and absorbs (never a second live record)', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchFailure(dir, FAIL({ session_id: undefined }));
    const r = await DS.recordDispatchPre(dir, PRE());
    assert.equal(r.action, 'terminal-absorbed');
    assert.deepEqual(stateFiles(dir), [doneName('toolu_pre_1', [])], 'no live-* record was minted beside the terminal one');
    assert.equal(readStateRaw(dir, stateFiles(dir)[0]).session_id, 's1', 'the missing Pre field was filled on the done-* record');
  } finally {
    cleanup();
  }
});

test('DSN-06: a Post after Stop finds the terminal record BY NAME — late-post-noop', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-1' }), { consumer: 'h22' });
    await DS.finishDispatchAndRegisterEnd(dir, { session_id: 's1', agent_id: 'agent-1', event: 'subagent-stop' });
    const r = await DS.recordDispatchPost(dir, POST({ agentId: 'agent-1' }));
    assert.equal(r.action, 'late-post-noop');
    assert.deepEqual(stateFiles(dir), [doneName('toolu_pre_1', ['agent-1'])]);
  } finally {
    cleanup();
  }
});

test('DSN-07: the Stop sidecar lookup finds a terminal record by its key', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchFailure(dir, FAIL());
    const fin = await DS.finishDispatchAndRegisterEnd(dir, { session_id: 's1', agent_id: 'agent-unknown', sidecarToolUseId: 'toolu_pre_1', event: 'subagent-stop' });
    assert.equal(fin.record?.tool_use_id, 'toolu_pre_1');
    assert.equal(fin.record?.terminal?.reason, 'tool-failure', 'already terminal — returned as found, never re-stamped');
  } finally {
    cleanup();
  }
});

test('DSN-08: a done-* name whose body carries a DIFFERENT tool_use_id is rejected (key-mismatch), never read as that key', async () => {
  const { dir, cleanup } = project();
  try {
    writeStateRaw(dir, doneName('toolu_victim', []), terminalRecord('toolu_other'));
    const r = await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_victim' }));
    assert.equal(r.action, 'poisoned');
    assert.match(r.disclosures.join('\n'), /key-mismatch/);
  } finally {
    cleanup();
  }
});

test('DSN-09: a done-* name whose id hashes disagree with the parsed ids is NOT resume evidence', async () => {
  const { dir, cleanup } = project();
  try {
    // The NAME claims agent-x; the body carries agent-y.
    writeStateRaw(dir, doneName('toolu_liar', ['agent-x']), terminalRecord('toolu_liar', { started: { agent_id: 'agent-y', at: new Date().toISOString(), by: ['h22'] } }));
    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-x' }), { consumer: 'h22' });
    assert.notEqual(res.source, 'resume', 'a name alone is never evidence');
    assert.equal(res.case, 'no-slot');
  } finally {
    cleanup();
  }
});

test('DSN-10: resumeHit finds a terminal record by EACH of its three id kinds, incl. both sides of a derived/Post mismatch', async () => {
  const { dir, cleanup } = project();
  try {
    const at = new Date().toISOString();
    writeStateRaw(dir, doneName('toolu_s', ['agent-started']), terminalRecord('toolu_s', { started: { agent_id: 'agent-started', at, by: ['h22'] } }));
    writeStateRaw(dir, doneName('toolu_p', ['agent-post']), terminalRecord('toolu_p', { post_binding: { agent_id: 'agent-post', at } }));
    writeStateRaw(dir, doneName('toolu_d', ['agent-derived-only']), terminalRecord('toolu_d', { derived_binding: { agent_id: 'agent-derived-only', at, by: 'h22' } }));
    writeStateRaw(
      dir,
      doneName('toolu_mm', ['agent-mm-derived', 'agent-mm-post']),
      terminalRecord('toolu_mm', {
        started: { agent_id: 'agent-mm-derived', at, by: ['h22'] },
        derived_binding: { agent_id: 'agent-mm-derived', at, by: 'h22' },
        post_binding: { agent_id: 'agent-mm-post', at },
        derived_post_mismatch: { derived_agent_id: 'agent-mm-derived', post_agent_id: 'agent-mm-post', at },
      })
    );
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_fresh' }));
    for (const agent of ['agent-started', 'agent-post', 'agent-derived-only', 'agent-mm-derived', 'agent-mm-post']) {
      const res = await DS.resolveDispatchStart(dir, START({ agent_id: agent }), { consumer: 'h22' });
      assert.equal(res.source, 'resume', `${agent} is a resumed agent`);
    }
    const fresh = DS.readDispatchState(dir).records.find((r) => r.record.tool_use_id === 'toolu_fresh');
    assert.equal(DS.dispatchState(fresh.record), 'pending', 'no resume consumed the fresh slot');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (4) TERMINALIZATION ORDER AND THE CRASH WINDOW
// ===========================================================================

test('DSN-11: a terminal body under a live- name (crash window) is excluded from candidates, kept as resume evidence, and renamed on the next locked scan', async () => {
  const { dir, cleanup } = project();
  try {
    const at = new Date().toISOString();
    const crashed = terminalRecord('toolu_crash', { started: { agent_id: 'agent-z', at, by: ['h22'] } });
    writeStateRaw(dir, liveName('toolu_crash'), crashed);
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_open' }));

    const other = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-w' }), { consumer: 'h22' });
    assert.equal(other.source, 'derived-type-unique', 'the crash-window record is not a candidate, so exactly one remains');
    assert.equal(other.tool_use_id, 'toolu_open');
    assert.ok(!stateFiles(dir).includes(liveName('toolu_crash')), 'the locked scan finished the rename');
    assert.ok(stateFiles(dir).includes(doneName('toolu_crash', ['agent-z'])));

    const resumed = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-z' }), { consumer: 'h22' });
    assert.equal(resumed.source, 'resume', 'its resume evidence survives the repair');
  } finally {
    cleanup();
  }
});

test('DSN-12: in the crash window itself (before any repair) the terminal body under live- is still resume evidence', async () => {
  const { dir, cleanup } = project();
  try {
    writeStateRaw(dir, liveName('toolu_crash'), terminalRecord('toolu_crash', { post_binding: { agent_id: 'agent-z', at: new Date().toISOString() } }));
    // Block the done destination so the locked repair CANNOT run: the Start
    // below sees the terminal body while it is still under its live- name.
    mkdirSync(join(stateDir(dir), doneName('toolu_crash', ['agent-z'])));
    const { value: res } = await captureStderr(() => DS.resolveDispatchStart(dir, START({ agent_id: 'agent-z' }), { consumer: 'h22' }));
    assert.equal(res.source, 'resume');
    assert.ok(stateFiles(dir).includes(liveName('toolu_crash')), 'the evidence was read BEFORE any repair — the body is still under its live name');
  } finally {
    cleanup();
  }
});

test('DSN-13: an OCCUPIED destination refuses the crash-window rename loudly and keeps the terminal body under its live name; once cleared, the next locked scan finishes it', async () => {
  const { dir, cleanup } = project();
  try {
    const at = new Date().toISOString();
    writeStateRaw(dir, liveName('toolu_pre_1'), terminalRecord('toolu_pre_1', { started: { agent_id: 'agent-1', at, by: ['h22'] } }));
    const target = join(stateDir(dir), doneName('toolu_pre_1', ['agent-1']));
    mkdirSync(join(target, 'block'), { recursive: true }); // something non-record occupies the done name
    const { text } = await captureStderr(() => DS.resolveDispatchStart(dir, START({ agent_id: 'agent-other', agent_type: 'nobody' }), { consumer: 'h22' }));
    assert.match(text, /dispatch_state_poisoned/, 'the refused rename is disclosed');
    const kept = readStateRaw(dir, liveName('toolu_pre_1'));
    assert.ok(kept.terminal && kept.prompt === null, 'the source is kept: terminal body under the live name, no copy-and-delete');
    rmSync(target, { recursive: true, force: true });
    await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-other', agent_type: 'nobody' }), { consumer: 'h22' });
    assert.deepEqual(stateFiles(dir), [doneName('toolu_pre_1', ['agent-1'])]);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// MALFORMED NAMES
// ===========================================================================

test('DSN-14: malformed filenames never crash the scan — a malformed live- name fails closed, malformed done-/unknown names are ignored LOUDLY', async () => {
  const { dir, cleanup } = project();
  try {
    writeStateRaw(dir, 'done-garbage.json', '{}');
    writeStateRaw(dir, `done-${key('toolu_q')}~not-a-hash.json`, '{}');
    writeStateRaw(dir, 'notes.json', '{}');
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_ok' }));
    const quiet = await captureStderr(() => DS.readDispatchState(dir));
    assert.equal(quiet.value.availability, 'ok');
    assert.deepEqual(quiet.value.poisoned, [], 'history-side junk never condemns derivation');
    assert.match(quiet.text, /done-garbage\.json/);
    assert.match(quiet.text, /not-a-hash/);
    assert.match(quiet.text, /notes\.json/);

    writeStateRaw(dir, 'live-!!bad.json', '{}');
    const scan = DS.readDispatchState(dir);
    assert.ok(scan.poisoned.some((p) => p.file === 'live-!!bad.json' && p.reason === 'malformed-filename'), 'an unkeyable live- name may be a live record — it fails closed');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (5) RETENTION BY terminal.at
// ===========================================================================

test('DSN-15: the boundary sweep prunes by terminal.at, never by mtime', async () => {
  const { dir, cleanup } = project();
  try {
    const now = Date.parse('2026-09-23T12:00:00.000Z');
    const oldAt = new Date(now - 8 * DAY).toISOString();
    const freshAt = new Date(now - 1 * DAY).toISOString();
    const oldName = doneName('toolu_old', []);
    const freshName = doneName('toolu_fresh', []);
    writeStateRaw(dir, oldName, terminalRecord('toolu_old', {}, oldAt)); // fresh mtime, old terminal.at
    const freshPath = writeStateRaw(dir, freshName, terminalRecord('toolu_fresh', {}, freshAt));
    const ancient = new Date(now - 30 * DAY);
    utimesSync(freshPath, ancient, ancient); // ancient mtime, fresh terminal.at
    const r = DS.sessionBoundarySweep(dir, { now });
    assert.equal(r.pruned, 1);
    assert.deepEqual(stateFiles(dir), [freshName]);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (6) LEGACY MIGRATION AT THE BOUNDARY
// ===========================================================================

test('DSN-16: a legacy <key>.json is NOT migrated mid-burst — the hot scan fails closed on it — and the boundary sweep migrates it', async () => {
  const { dir, cleanup } = project();
  try {
    const now = Date.parse('2026-09-23T12:00:00.000Z');
    writeStateRaw(dir, `${key('toolu_legacy_live')}.json`, pendingRecord('toolu_legacy_live'));
    const at = new Date(now - DAY).toISOString();
    writeStateRaw(dir, `${key('toolu_legacy_done')}.json`, terminalRecord('toolu_legacy_done', { started: { agent_id: 'agent-old', at, by: ['h22'] } }, at));

    const scan = DS.readDispatchState(dir);
    assert.ok(scan.poisoned.some((p) => p.reason === 'legacy-unmigrated'), 'an unmigrated legacy record may be live — never silently skipped');
    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-new' }), { consumer: 'h22' });
    assert.equal(res.case, 'state-poisoned', 'no guess while a legacy record is unmigrated');
    assert.ok(stateFiles(dir).includes(`${key('toolu_legacy_live')}.json`), 'the hot path never migrates');
    const pre = await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_legacy_live' }));
    assert.equal(pre.action, 'poisoned', 'a keyed write never goes around an unmigrated legacy record for its key');
    assert.ok(!stateFiles(dir).includes(liveName('toolu_legacy_live')));

    const r = DS.sessionBoundarySweep(dir, { now });
    assert.equal(r.migrated, 2);
    const live = DS.dispatchStateKey('toolu_legacy_live');
    assert.deepEqual(
      stateFiles(dir),
      [doneName('toolu_legacy_done', ['agent-old']), `done-${live}~none.json`].sort(),
      'the terminal legacy record lands on its done- name; the live one migrates and is then boundary-terminalized'
    );
    assert.equal(readStateRaw(dir, `done-${live}~none.json`).terminal.reason, 'session-boundary');
    const again = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-old' }), { consumer: 'h22' });
    assert.equal(again.source, 'resume', 'migrated history is still resume evidence');
  } finally {
    cleanup();
  }
});

test('DSN-17: migration never overwrites — a legacy file whose target name already exists is left in place and disclosed', async () => {
  const { dir, cleanup } = project();
  try {
    const now = Date.now();
    const rec = terminalRecord('toolu_dup');
    writeStateRaw(dir, `${key('toolu_dup')}.json`, rec);
    writeStateRaw(dir, doneName('toolu_dup', []), rec);
    const { value: r, text } = await captureStderr(() => DS.sessionBoundarySweep(dir, { now }));
    assert.equal(r.migrated, 0);
    assert.ok(stateFiles(dir).includes(`${key('toolu_dup')}.json`), 'the legacy source is kept');
    assert.match(text, /already exists/);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// FIX ROUND (Sol review, thread 01a0ce05)
// ===========================================================================

test('DSN-18: a MALFORMED done- name that still carries a valid key poisons keyed reads for that key — a late Pre never mints a live record for a finished dispatch', async () => {
  const { dir, cleanup } = project();
  try {
    const bad = `done-${key('toolu_q')}~not-a-hash.json`;
    assert.equal(bad, 'done-raw-toolu_q~not-a-hash.json');
    writeStateRaw(dir, bad, terminalRecord('toolu_q'));
    const { value: scan } = await captureStderr(() => DS.readDispatchState(dir));
    assert.deepEqual(scan.poisoned, [], 'the hot scan keeps warn-and-ignore for malformed history names');
    const r = await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_q' }));
    assert.equal(r.action, 'poisoned');
    assert.ok(!stateFiles(dir).includes(liveName('toolu_q')), 'no live record was created beside the malformed terminal one');
  } finally {
    cleanup();
  }
});

test('DSN-19: a crash-window repair never OVERWRITES an existing regular done file of the same name — source kept, tombstone byte-identical, disclosed', async () => {
  const { dir, cleanup } = project();
  try {
    const at = new Date().toISOString();
    const started = { started: { agent_id: 'agent-z', at, by: ['h22'] } };
    const tombName = doneName('toolu_dup', ['agent-z']);
    const tombPath = writeStateRaw(dir, tombName, terminalRecord('toolu_dup', { ...started, description: 'ORIGINAL TOMBSTONE' }, at));
    const tombBytes = readFileSync(tombPath, 'utf8');
    writeStateRaw(dir, liveName('toolu_dup'), terminalRecord('toolu_dup', { ...started, description: 'crash-window body' }, at));
    const { text } = await captureStderr(() => DS.resolveDispatchStart(dir, START({ agent_id: 'agent-other', agent_type: 'nobody' }), { consumer: 'h22' }));
    assert.equal(readFileSync(tombPath, 'utf8'), tombBytes, 'the existing tombstone is never overwritten');
    assert.ok(stateFiles(dir).includes(liveName('toolu_dup')), 'the live source is kept');
    assert.match(text, /already exists/);
  } finally {
    cleanup();
  }
});

test('DSN-20: Stop and the boundary sweep never overwrite an existing regular done file, and a live record duplicating a done key is never selected', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-1' }), { consumer: 'h22' });
    const tombName = doneName('toolu_pre_1', ['agent-1']);
    const tombPath = writeStateRaw(
      dir,
      tombName,
      terminalRecord('toolu_pre_1', { started: { agent_id: 'agent-1', at: new Date().toISOString(), by: ['h22'] }, description: 'ORIGINAL TOMBSTONE' })
    );
    const tombBytes = readFileSync(tombPath, 'utf8');
    const { value: fin } = await captureStderr(() => DS.finishDispatchAndRegisterEnd(dir, { session_id: 's1', agent_id: 'agent-1', event: 'subagent-stop' }));
    assert.equal(fin.record, null, 'a live record whose key already has a done file is excluded from Stop selection');
    assert.match((fin.disclosures ?? []).join('\n'), /duplicate-key/, 'the skipped duplicate is disclosed, never silent');
    assert.equal(readFileSync(tombPath, 'utf8'), tombBytes);
    const live = readStateRaw(dir, liveName('toolu_pre_1'));
    assert.equal(live.terminal, undefined, 'the live record was not terminalized onto the occupied name');

    const { text } = await captureStderr(() => DS.sessionBoundarySweep(dir, { now: Date.now() }));
    assert.equal(readFileSync(tombPath, 'utf8'), tombBytes, 'the boundary sweep never overwrites it either');
    assert.ok(stateFiles(dir).includes(liveName('toolu_pre_1')), 'the live source is kept (never deleted)');
    // Since the sweep's duplicate-key skip (fix round 2) the duplicate is left
    // BEFORE any write: not even a terminal body lands on it.
    assert.equal(readStateRaw(dir, liveName('toolu_pre_1')).terminal, undefined, 'the sweep did not terminalize the duplicate');
    assert.match(text, /duplicate-key/);
  } finally {
    cleanup();
  }
});

test('DSN-21: a live record duplicating a done key is excluded from Start derivation — no guess around it', async () => {
  const { dir, cleanup } = project();
  try {
    writeStateRaw(dir, liveName('toolu_x'), pendingRecord('toolu_x'));
    writeStateRaw(dir, doneName('toolu_x', []), terminalRecord('toolu_x'));
    // The duplicate is the ONLY same-type pending record: were it selectable
    // it would derive type-unique.
    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-new' }), { consumer: 'h22' });
    assert.notEqual(res.tool_use_id, 'toolu_x', 'the duplicate is never selected');
    assert.equal(res.source, 'unattributable', 'no guess while the state is inconsistent');
    assert.equal(readStateRaw(dir, liveName('toolu_x')).started, undefined, 'nothing was written onto the duplicate');
  } finally {
    cleanup();
  }
});

test('DSN-22: a POISONED sidecar lookup at Stop is returned as a disclosure, never silently dropped after the round is ended', async () => {
  const { dir, cleanup } = project();
  try {
    writeStateRaw(dir, doneName('toolu_side', []), terminalRecord('toolu_other')); // key-mismatch under the sidecar key
    const fin = await DS.finishDispatchAndRegisterEnd(dir, { session_id: 's1', agent_id: 'agent-unknown', sidecarToolUseId: 'toolu_side', event: 'subagent-stop' });
    assert.equal(fin.record, null);
    const text = (fin.disclosures ?? []).join('\n');
    assert.match(text, /dispatch_state_poisoned/);
    assert.match(text, /key-mismatch/);
  } finally {
    cleanup();
  }
});

test('DSN-23: the boundary sweep DISCLOSES a corrupt terminal file instead of skipping it silently', async () => {
  const { dir, cleanup } = project();
  try {
    const name = doneName('toolu_corrupt', []);
    writeStateRaw(dir, name, '{ corrupt');
    const { text } = await captureStderr(() => DS.sessionBoundarySweep(dir, { now: Date.now() }));
    assert.ok(text.includes(name), 'the corrupt file is named on stderr');
    assert.match(text, /unparseable-json/);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// FIX ROUND 2 (Opus re-check): poison is NAMED, and the sweep never mints a
// second done- file for a key
// ===========================================================================

test('DSN-24: a stray live-!!bad.json is NAMED by the sweep, by the state-poisoned Start result, and by the Post refusal — never silently poisoning forever', async () => {
  const { dir, cleanup } = project();
  try {
    writeStateRaw(dir, 'live-!!bad.json', '{}');
    const { text } = await captureStderr(() => DS.sessionBoundarySweep(dir, { now: Date.now() }));
    assert.ok(text.includes('live-!!bad.json'), 'the sweep names the malformed live file');
    assert.ok(stateFiles(dir).includes('live-!!bad.json'), 'it is never auto-deleted — it could be a live record');

    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-n' }), { consumer: 'h22' });
    assert.equal(res.case, 'state-poisoned');
    assert.ok((res.poisoned_files ?? []).some((f) => f.includes('live-!!bad.json')), `the Start result names the file: ${JSON.stringify(res.poisoned_files)}`);

    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_n' }));
    const post = await DS.recordDispatchPost(dir, POST({ tool_use_id: 'toolu_n', agentId: 'agent-n' }));
    assert.equal(post.action, 'refused-poisoned-scan');
    assert.match(post.disclosures.join('\n'), /live-!!bad\.json/, 'the Post refusal names the file');
  } finally {
    cleanup();
  }
});

test('DSN-25: the sweep names an unknown .json file', async () => {
  const { dir, cleanup } = project();
  try {
    writeStateRaw(dir, 'stray-notes.json', '{}');
    const { text } = await captureStderr(() => DS.sessionBoundarySweep(dir, { now: Date.now() }));
    assert.ok(text.includes('stray-notes.json'));
  } finally {
    cleanup();
  }
});

test('DSN-26: keyed Pre/Post/Failure refusals NAME the poisoned file', async () => {
  const { dir, cleanup } = project();
  try {
    const planted = liveName('toolu_mis');
    writeStateRaw(dir, planted, pendingRecord('toolu_someone_else'));
    const pre = await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_mis' }));
    const post = await DS.recordDispatchPost(dir, POST({ tool_use_id: 'toolu_mis' }));
    const fail = await DS.recordDispatchFailure(dir, FAIL({ tool_use_id: 'toolu_mis' }));
    for (const [label, r] of [['Pre', pre], ['Post', post], ['Failure', fail]]) {
      assert.equal(r.action, 'poisoned', label);
      assert.ok(r.disclosures.join('\n').includes(planted), `${label} names ${planted}`);
    }
  } finally {
    cleanup();
  }
});

test('DSN-27: the boundary sweep SKIPS a live record whose key already has a done- file under different ids — one done- file, live untouched, both named', async () => {
  const { dir, cleanup } = project();
  try {
    const at = new Date().toISOString();
    const tombName = doneName('toolu_a', ['agent-old']);
    const tombPath = writeStateRaw(dir, tombName, terminalRecord('toolu_a', { started: { agent_id: 'agent-old', at, by: ['h22'] } }, at));
    const tombBytes = readFileSync(tombPath, 'utf8');
    const livePath = writeStateRaw(dir, liveName('toolu_a'), pendingRecord('toolu_a'));
    const liveBytes = readFileSync(livePath, 'utf8');
    const { value: r, text } = await captureStderr(() => DS.sessionBoundarySweep(dir, { now: Date.now() }));
    assert.equal(r.terminated, 0, 'the duplicate is NOT terminalized');
    assert.deepEqual(stateFiles(dir).filter((f) => f.startsWith('done-')), [tombName], 'no second done- file for the key');
    assert.equal(readFileSync(tombPath, 'utf8'), tombBytes);
    assert.equal(readFileSync(livePath, 'utf8'), liveBytes, 'the live record is left untouched for an operator');
    assert.ok(text.includes(liveName('toolu_a')) && text.includes(tombName), 'the warning names BOTH files');
  } finally {
    cleanup();
  }
});
