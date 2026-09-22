// DISPATCH STATE MACHINE — OWNER-MODULE PINS (scripts/lib/dispatch-register.mjs)
//
// CONTRACT SOURCE (opened, not paraphrased): decision
// `dispatch-state-machine-pre-slot-post-binding-locked-start-resolution-replaces-transcript-attribution`
// (knowledge_get 7c515e52-19a8-41cf-8c2d-6da61f1c8425) §1-§7, and its §8
// FROZEN PINS list; board 5445066b; platform stdin shapes from
// research_finding foreign_2bad782a (PostToolUse Task carries tool_response.agentId
// synchronously; Post and the child's SubagentStart fire within 0.1-9.3 ms in
// EITHER order).
//
// H4 READ WALL HONORED: scripts/lib/dispatch-register.mjs and every
// scripts/hooks/*.mjs were NEVER opened by this file's author. The whole
// surface pinned below comes from the decision plus the contract sheet handed
// to this dispatch. The harness idioms (project()/refusalOf()/deadPid()/
// forgeLock()) are adapted from scripts/tests/dispatch-register-owner.test.mjs
// (a TEST, not a subject), reused without modifying it.
//
// NEW FILE — nothing is RETIRED here.
//
// EXPECTED FAILURE SHAPE TODAY (all pins in this file are RED): the module
// exists and imports cleanly, but exports NONE of the state-machine surface.
// requireOwner() therefore fails each test on an ASSERTION naming the missing
// export ("scripts/lib/dispatch-register.mjs must export <name>") — never a
// crash-red import error, which would prove nothing.
//
// SHAPE AGNOSTICISM (stated, not silently assumed): the decision settles the
// BEHAVIOUR and the CASE tokens, not whether these functions are sync or
// async. Every call is `await`ed (correct for both).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync,
  rmSync, statSync, lstatSync, symlinkSync, chmodSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import * as DS from '../lib/dispatch-register.mjs';

const IS_WIN = process.platform === 'win32';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dispatch-state-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Fails on an ASSERTION (never a crash) when the owner surface is absent —
// that is what makes every pin in this file red-on-its-assertion today.
function requireOwner(...names) {
  for (const name of names) {
    if (typeof DS[name] !== 'function') {
      assert.fail(`scripts/lib/dispatch-register.mjs must export ${name}() — decision 7c515e52 §1/§2/§5 makes this module the ONE owner of dispatch state`); // not-a-citation: fixture id
    }
  }
}

async function refusalOf(fn) {
  try {
    return { value: await fn(), threw: false };
  } catch (err) {
    return { err, code: err?.code, threw: true };
  }
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function stateDir(dir) {
  return DS.dispatchStateDir(dir);
}
function stateFiles(dir) {
  const d = stateDir(dir);
  return existsSync(d) ? readdirSync(d).sort() : [];
}
function writeStateRaw(dir, fileName, content) {
  mkdirSync(stateDir(dir), { recursive: true });
  const p = join(stateDir(dir), fileName);
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}
function readStateRaw(dir, fileName) {
  return JSON.parse(readFileSync(join(stateDir(dir), fileName), 'utf8'));
}
async function recordsOf(dir) {
  const r = await DS.readDispatchState(dir);
  return r;
}
async function soleRecord(dir) {
  const r = await DS.readDispatchState(dir);
  assert.equal(r.availability, 'ok', `expected a readable state dir, got ${JSON.stringify(r.availability)}`);
  assert.equal(r.records.length, 1, `expected exactly one state record, got ${r.records.length}`);
  return r.records[0].record;
}
async function recordFor(dir, toolUseId) {
  const key = DS.dispatchStateKey(toolUseId);
  const r = await DS.readDispatchState(dir);
  const hit = r.records.find((x) => x.key === key);
  return hit?.record ?? null;
}

// --- stdin shapes, verbatim from research_finding foreign_2bad782a -----------------

const PRE = (over = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Task',
  tool_use_id: 'toolu_pre_1',
  tool_input: { subagent_type: 'coder', prompt: 'work on src/a.mjs', description: 'coder lane' },
  session_id: 's1',
  cwd: '/unused',
  transcript_path: '/unused/parent.jsonl',
  prompt_id: 'pr-1',
  ...over,
});

const POST = (over = {}) => {
  const prompt = over.prompt ?? 'work on src/a.mjs';
  const responsePrompt = over.responsePrompt ?? prompt;
  const base = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Task',
    tool_use_id: 'toolu_pre_1',
    tool_input: { subagent_type: 'coder', prompt, description: 'coder lane' },
    tool_response: {
      isAsync: true,
      status: 'async_launched',
      agentId: 'agent-1',
      description: 'coder lane',
      resolvedModel: 'claude-x',
      prompt: responsePrompt,
      outputFile: '/unused/out.txt',
      canReadOutputFile: true,
    },
    session_id: 's1',
    cwd: '/unused',
    transcript_path: '/unused/parent.jsonl',
    prompt_id: 'pr-1',
  };
  const { prompt: _p, responsePrompt: _rp, agentId, tool_response, ...rest } = over;
  if (agentId !== undefined) base.tool_response.agentId = agentId;
  if (tool_response !== undefined) base.tool_response = tool_response;
  return { ...base, ...rest };
};

const FAIL = (over = {}) => ({
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Task',
  tool_use_id: 'toolu_pre_1',
  tool_input: { subagent_type: 'coder', prompt: 'work on src/a.mjs', description: 'coder lane' },
  error: 'the tool call failed',
  session_id: 's1',
  cwd: '/unused',
  ...over,
});

const START = (over = {}) => ({ session_id: 's1', agent_id: 'agent-1', agent_type: 'coder', ...over });

const disclosureText = (r) => (Array.isArray(r?.disclosures) ? r.disclosures.join('\n') : String(r?.disclosures ?? ''));

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  assert.ok(r.pid, 'harness: the probe child must report a pid');
  return r.pid;
}
function forgeLiveLock(dir) {
  const lockDir = DS.registerLockDir(dir);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, 'owner.json'),
    JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), nonce: 'forged' })
  );
  return lockDir;
}

// A deterministic injected clock: every read advances 10 ms, so the resolver's
// 150 ms budget is spent in at most 15 sleeps and NO real time passes.
function fakeClock(startMs = 1_800_000_000_000, stepMs = 10) {
  let t = startMs;
  return { now: () => (t += stepMs) - stepMs, at: () => t };
}

// ===========================================================================
// §1 — KEY NAMESPACING AND STATE DERIVATION
// ===========================================================================

test('DS-K01: dispatchStateDir is <root>/.sterling/transient/dispatch-state', () => {
  requireOwner('dispatchStateDir');
  const { dir, cleanup } = project();
  try {
    assert.equal(DS.dispatchStateDir(dir), join(dir, '.sterling', 'transient', 'dispatch-state'));
  } finally {
    cleanup();
  }
});
// SABOTAGE: home the state dir anywhere else (e.g. .sterling/dispatch-state,
// outside transient/) — this goes red, and with it the P4 lifecycle claim
// that a SessionStart sweep of transient/ reaches this state.

test('DS-K02: a tool_use_id matching /^[A-Za-z0-9_-]{1,80}$/ keys as raw-<id>; every other shape keys as sha256-<hex>', () => {
  requireOwner('dispatchStateKey');
  assert.equal(DS.dispatchStateKey('toolu_abc-123_XYZ'), 'raw-toolu_abc-123_XYZ');
  assert.equal(DS.dispatchStateKey('a'.repeat(80)), `raw-${'a'.repeat(80)}`);
  for (const bad of ['', 'has/slash', 'has:colon', 'has space', '..', 'a'.repeat(81), 'dot.dot']) {
    assert.equal(DS.dispatchStateKey(bad), `sha256-${sha256(bad)}`, `an unsafe id must be hashed, not used raw: ${JSON.stringify(bad)}`);
  }
});
// SABOTAGE: widen the safe charset to include '/' or '.' (or drop the 80-char
// bound) — the 'has/slash'/'dot.dot'/81-char arms go red, and a raw key could
// then escape the state directory or collide with a sibling's file name.

test('DS-K03: the two key forms CANNOT COLLIDE — a VALID id that literally spells another id\'s hashed key stays distinct', () => {
  requireOwner('dispatchStateKey');
  const invalid = 'bad/id';                       // hashed
  const hashed = sha256(invalid);
  const valid = `sha256-${hashed}`;               // 71 chars, all in the safe charset -> raw
  assert.notEqual(
    DS.dispatchStateKey(valid),
    DS.dispatchStateKey(invalid),
    'the raw and hashed namespaces must be disjoint — an id that spells "sha256-<hex>" must not land on the file the hash of a DIFFERENT id owns'
  );
  assert.equal(DS.dispatchStateKey(valid), `raw-sha256-${hashed}`);
  assert.equal(DS.dispatchStateKey(invalid), `sha256-${hashed}`);
});
// SABOTAGE: drop the 'raw-' prefix (key = id when safe, else 'sha256-'+hex) —
// the notEqual goes red: the valid id `sha256-<hex(bad/id)>` and the invalid
// id `bad/id` land on ONE file, so one dispatch's prompt is served to the
// other's child. This is the pin §8 names as "namespaced keys cannot collide".

test('DS-K04: the two colliding-by-name ids keep SEPARATE records, each carrying its own prompt', async () => {
  requireOwner('dispatchStateKey', 'recordDispatchPre', 'readDispatchState');
  const { dir, cleanup } = project();
  try {
    const invalid = 'bad/id';
    const valid = `sha256-${sha256(invalid)}`;
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: invalid, tool_input: { subagent_type: 'coder', prompt: 'HASHED-ONE', description: 'd' } }));
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: valid, tool_input: { subagent_type: 'coder', prompt: 'RAW-ONE', description: 'd' } }));
    const st = await DS.readDispatchState(dir);
    assert.equal(st.availability, 'ok');
    assert.equal(st.records.length, 2, 'two dispatches, two files — never one overwritten by the other');
    assert.equal((await recordFor(dir, invalid)).prompt, 'HASHED-ONE');
    assert.equal((await recordFor(dir, valid)).prompt, 'RAW-ONE');
  } finally {
    cleanup();
  }
});
// SABOTAGE: same as DS-K03 — a non-namespaced key makes the second Pre either
// overwrite the first or be refused as a collision; either way one of the two
// prompt assertions goes red.

test('DS-S01: dispatchState is DERIVED, in the order terminal > started > bound > pending', () => {
  requireOwner('dispatchState');
  const base = { schema: 1, tool_use_id: 't', session_id: 's1', subagent_type: 'coder', prompt: 'p' };
  assert.equal(DS.dispatchState({ ...base }), 'pending');
  assert.equal(DS.dispatchState({ ...base, derived_binding: { agent_id: 'a', at: 'x', by: 'h22' } }), 'bound');
  assert.equal(DS.dispatchState({ ...base, post_binding: { agent_id: 'a', at: 'x' } }), 'bound');
  assert.equal(DS.dispatchState({ ...base, post_binding: { agent_id: 'a', at: 'x' }, started: { agent_id: 'a', at: 'x', by: ['h22'] } }), 'started');
  assert.equal(
    DS.dispatchState({ ...base, post_binding: { agent_id: 'a', at: 'x' }, started: { agent_id: 'a', at: 'x', by: ['h22'] }, terminal: { at: 'x', reason: 'stop' } }),
    'terminal',
    'terminal is ABSORBING — it outranks a started record and both bindings'
  );
});
// SABOTAGE: store state as a mutable FIELD and return it (record.state)
// instead of deriving — a record carrying {state:'pending', terminal:{...}}
// would then read 'pending' and become a derivation candidate again; the
// terminal-precedence assertion goes red.

// ===========================================================================
// §2 — recordDispatchPre
// ===========================================================================

test('DS-P01: Pre on an absent key writes ONE pending record with origin "pre", the prompt, its byte length and its sha256', async () => {
  requireOwner('recordDispatchPre', 'readDispatchState', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    const prompt = 'please work on src/a.mjs and report back';
    const r = await DS.recordDispatchPre(dir, PRE({ tool_input: { subagent_type: 'coder', prompt, description: 'coder lane' } }));
    assert.equal(r.ok, true, `Pre must succeed: ${JSON.stringify(r)}`);
    const rec = await soleRecord(dir);
    assert.equal(DS.dispatchState(rec), 'pending');
    assert.equal(rec.schema, 1);
    assert.equal(rec.origin, 'pre');
    assert.equal(rec.tool_use_id, 'toolu_pre_1');
    assert.equal(rec.session_id, 's1');
    assert.equal(rec.subagent_type, 'coder');
    assert.equal(rec.description, 'coder lane');
    assert.equal(rec.prompt, prompt);
    assert.equal(rec.prompt_bytes, Buffer.byteLength(prompt, 'utf8'));
    assert.equal(rec.prompt_sha256, sha256(prompt));
    assert.ok(!('terminal' in rec) && !('post_binding' in rec) && !('started' in rec), 'a fresh Pre is pending and nothing else');
  } finally {
    cleanup();
  }
});
// SABOTAGE: write the prompt without prompt_sha256/prompt_bytes — the two
// hash/length assertions go red, and §6's bad-hash POISON check loses the
// only evidence it can test against.

test('DS-P02 (POSIX): the state file is 0o600', { skip: IS_WIN ? 'POSIX modes only' : false }, async () => {
  requireOwner('recordDispatchPre');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    const [file] = stateFiles(dir);
    assert.ok(file, 'a state file was written');
    assert.equal(statSync(join(stateDir(dir), file)).mode & 0o777, 0o600, 'a dispatch prompt is private to its owner — 0o600, never 0o644');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the mode argument from the write (defaulting to 0o644) —
// this goes red; every other Pre pin stays green, which is exactly why the
// mode needs its own arm.

test('DS-P03: an IDENTICAL second Pre is idempotent — the file is byte-identical and nothing is duplicated', async () => {
  requireOwner('recordDispatchPre');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    const [file] = stateFiles(dir);
    const before = readFileSync(join(stateDir(dir), file), 'utf8');
    const r = await DS.recordDispatchPre(dir, PRE());
    assert.equal(r.ok, true, `an identical re-fire must not be an error: ${JSON.stringify(r)}`);
    assert.deepEqual(stateFiles(dir), [file], 'no second file');
    assert.equal(readFileSync(join(stateDir(dir), file), 'utf8'), before, 'identical facts -> byte-identical file (no re-stamped pre_at, no churn)');
  } finally {
    cleanup();
  }
});
// SABOTAGE: re-write the record unconditionally on every Pre (re-stamping
// pre_at) — the byte-identical assertion goes red, and a hook re-fired by the
// platform would silently move the record's own clock.

test('DS-P04: a CONFLICTING Pre on the same key never overwrites — the original prompt survives and the collision is disclosed', async () => {
  requireOwner('recordDispatchPre');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ tool_input: { subagent_type: 'coder', prompt: 'ORIGINAL', description: 'd' } }));
    const r = await DS.recordDispatchPre(dir, PRE({ tool_input: { subagent_type: 'test-writer', prompt: 'IMPOSTOR', description: 'other' } }));
    const rec = await soleRecord(dir);
    assert.equal(rec.prompt, 'ORIGINAL', 'the first Pre owns the key; a different-facts Pre never rewrites it');
    assert.equal(rec.subagent_type, 'coder');
    // CODE SPELLING (corrected by the coordinator, 2026-09-08): the closed-set
    // code in scripts/lib/review-errors.mjs is `dispatch_state_collision` —
    // underscores, like every other member of that set. Decision foreign_7c515e52's
    // prose spelled it with hyphens ('dispatch-state-collision') and is being
    // fixed forward; the CODE is the authority, not the prose.
    assert.match(disclosureText(r), /dispatch_state_collision/, 'the refusal to overwrite is disclosed by its closed-set code, never silent');
  } finally {
    cleanup();
  }
});
// SABOTAGE: last-write-wins on the key (overwrite when facts differ) — the
// ORIGINAL assertions go red, and a replayed/forged Pre could swap the prompt
// a pending child is about to be handed.

test('DS-P05: a Pre with NO tool_use_id writes nothing at all and discloses', async () => {
  requireOwner('recordDispatchPre', 'readDispatchState');
  const { dir, cleanup } = project();
  try {
    const stdin = PRE();
    delete stdin.tool_use_id;
    const r = await DS.recordDispatchPre(dir, stdin);
    assert.deepEqual(stateFiles(dir), [], 'no key -> no file: an unkeyed record could never be found again, so it is never written');
    assert.ok(disclosureText(r).length > 0, 'the skipped write is disclosed (P5 fail loud)');
  } finally {
    cleanup();
  }
});
// SABOTAGE: fall back to a synthesized key (a uuid, or the prompt hash) when
// tool_use_id is missing — the "no file" assertion goes red and an unbindable
// orphan record poisons same-type derivation for the rest of the session.

test('DS-P06: an OVERSIZE prompt (>512 KiB) is stored as prompt:null + oversize:true, with its true byte length and hash kept', async () => {
  requireOwner('recordDispatchPre');
  const { dir, cleanup } = project();
  try {
    const big = 'x'.repeat(512 * 1024 + 1);
    await DS.recordDispatchPre(dir, PRE({ tool_input: { subagent_type: 'coder', prompt: big, description: 'd' } }));
    const rec = await soleRecord(dir);
    assert.equal(rec.prompt, null, 'the body is dropped past the cap, never truncated into a half-prompt');
    assert.equal(rec.oversize, true);
    assert.equal(rec.prompt_bytes, Buffer.byteLength(big, 'utf8'), 'the real size is still recorded');
  } finally {
    cleanup();
  }
});
// SABOTAGE: store the oversize prompt anyway (no cap) — the prompt:null and
// oversize:true assertions go red; a 5 MB brief then rides in a hook's state
// file and into a child's context.

test('DS-P07 CONTROL: a prompt exactly AT the 512 KiB cap is kept in full — the cap is not a general prompt-dropper', async () => {
  requireOwner('recordDispatchPre');
  const { dir, cleanup } = project();
  try {
    const atCap = 'y'.repeat(512 * 1024);
    await DS.recordDispatchPre(dir, PRE({ tool_input: { subagent_type: 'coder', prompt: atCap, description: 'd' } }));
    const rec = await soleRecord(dir);
    assert.equal(rec.prompt, atCap, 'at the cap is not over the cap');
    assert.ok(!('oversize' in rec) || rec.oversize !== true, 'no oversize flag for an at-cap prompt');
  } finally {
    cleanup();
  }
});
// SABOTAGE: compare with >= instead of > (or cap at 512 KB = 512000) — this
// control goes red while DS-P06 stays green, which is why the pair exists.

// ===========================================================================
// §2 — recordDispatchPost
// ===========================================================================

test('DS-PO01: Post on a PENDING record writes post_binding{agent_id} and the state becomes bound', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    const r = await DS.recordDispatchPost(dir, POST({ agentId: 'agent-42' }));
    assert.equal(r.ok, true, `the Post binding must succeed: ${JSON.stringify(r)}`);
    const rec = await soleRecord(dir);
    assert.equal(rec.post_binding?.agent_id, 'agent-42', "the platform's own tool_response.agentId is the authoritative binding");
    assert.equal(DS.dispatchState(rec), 'bound');
    assert.equal(rec.prompt, 'work on src/a.mjs', "Pre's prompt is untouched by the binding");
  } finally {
    cleanup();
  }
});
// SABOTAGE: read the agent id from anywhere but tool_response.agentId (e.g.
// tool_response.description, or a uuid) — the post_binding assertion goes red
// and no Start could ever resolve through §5(i).

test('DS-PO02: Post with NO existing record CREATES a bound record (origin "post-only") — stronger evidence is never refused for want of the weaker', async () => {
  requireOwner('recordDispatchPost');
  const { dir, cleanup } = project();
  try {
    const r = await DS.recordDispatchPost(dir, POST({ agentId: 'agent-po' }));
    const rec = await soleRecord(dir);
    assert.equal(rec.origin, 'post-only');
    assert.equal(rec.post_binding?.agent_id, 'agent-po');
    assert.equal(rec.subagent_type, 'coder', "Post's own tool_input carries the type");
    assert.equal(rec.prompt, 'work on src/a.mjs', "Post's own tool_input carries the prompt");
    assert.ok(disclosureText(r).length > 0, 'the Pre-less creation is disclosed');
    if (!IS_WIN) {
      const [file] = stateFiles(dir);
      assert.equal(statSync(join(stateDir(dir), file)).mode & 0o777, 0o600, 'a post-only record obeys the SAME 0o600 rule');
    }
  } finally {
    cleanup();
  }
});
// SABOTAGE: require an existing record and no-op otherwise ("no Pre, no
// binding") — every assertion here goes red, and a dispatch whose Pre hook
// was not yet registered loses its attribution entirely.

test('DS-PO03: a post-only record obeys the SAME 512 KiB cap', async () => {
  requireOwner('recordDispatchPost');
  const { dir, cleanup } = project();
  try {
    const big = 'z'.repeat(512 * 1024 + 1);
    await DS.recordDispatchPost(dir, POST({ prompt: big, responsePrompt: big, agentId: 'agent-po2' }));
    const rec = await soleRecord(dir);
    assert.equal(rec.origin, 'post-only');
    assert.equal(rec.prompt, null, 'the cap applies on the Post creation path too');
    assert.equal(rec.oversize, true);
    assert.equal(rec.post_binding?.agent_id, 'agent-po2', 'identity still binds — only the body is dropped');
  } finally {
    cleanup();
  }
});
// SABOTAGE: apply the cap only on the Pre path — this goes red while DS-P06
// stays green, which is why the cap is pinned on BOTH creation paths.

test('DS-PO04: Post whose tool_input.prompt and tool_response.prompt DISAGREE refuses to bind, and discloses', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ tool_input: { subagent_type: 'coder', prompt: 'THE BRIEF', description: 'd' } }));
    const r = await DS.recordDispatchPost(dir, POST({ prompt: 'THE BRIEF', responsePrompt: 'A DIFFERENT BRIEF', agentId: 'agent-x' }));
    const rec = await soleRecord(dir);
    assert.equal(rec.post_binding, undefined, 'two prompts that disagree are not one dispatch — no binding is written');
    assert.equal(DS.dispatchState(rec), 'pending', 'the record stays a pending slot; it is not condemned either');
    assert.ok(disclosureText(r).length > 0, 'the refusal is disclosed');
  } finally {
    cleanup();
  }
});
// SABOTAGE: skip the prompt-equality check and bind on tool_use_id alone —
// the post_binding assertion goes red; a Post belonging to a re-keyed or
// replayed call would then bind an agent to somebody else's brief.

test('DS-PO05 CONTROL: when both prompts AGREE the binding is written — the equality check is not a way of never binding', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ tool_input: { subagent_type: 'coder', prompt: 'THE BRIEF', description: 'd' } }));
    await DS.recordDispatchPost(dir, POST({ prompt: 'THE BRIEF', responsePrompt: 'THE BRIEF', agentId: 'agent-ok' }));
    assert.equal((await soleRecord(dir)).post_binding?.agent_id, 'agent-ok');
  } finally {
    cleanup();
  }
});
// SABOTAGE: invert the comparison (bind only when they differ) — this control
// goes red while DS-PO04 stays green. Placed as the opposite-reason arm for
// the whole refusal battery below.

test('DS-PO06: ONE-TO-ONE — an agentId already bound on another key is refused, and NOTHING changes on either record', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_A' }));
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_B' }));
    await DS.recordDispatchPost(dir, POST({ tool_use_id: 'toolu_A', agentId: 'agent-shared' }));
    const r = await DS.recordDispatchPost(dir, POST({ tool_use_id: 'toolu_B', agentId: 'agent-shared' }));
    const a = await recordFor(dir, 'toolu_A');
    const b = await recordFor(dir, 'toolu_B');
    assert.equal(a.post_binding?.agent_id, 'agent-shared', 'the first binding stands');
    assert.equal(b.post_binding, undefined, 'one agent_id can bind exactly one dispatch');
    assert.ok(disclosureText(r).length > 0, 'the refusal is disclosed');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the one-to-one scan — the b.post_binding assertion goes red,
// and §5(i) could then match TWO records for one Start, making the choice
// order-of-readdir dependent.

test('DS-PO07: a Post whose session_id differs from the record\'s condemns the record (terminal "post-collision") and binds NOTHING', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ session_id: 's1' }));
    const r = await DS.recordDispatchPost(dir, POST({ session_id: 's2', agentId: 'agent-foreign' }));
    const rec = await soleRecord(dir);
    assert.equal(rec.post_binding, undefined, 'a cross-session key reuse is not a binding');
    assert.equal(DS.dispatchState(rec), 'terminal');
    assert.equal(rec.terminal?.reason, 'post-collision');
    assert.ok(disclosureText(r).length > 0);
  } finally {
    cleanup();
  }
});
// SABOTAGE: ignore session_id on the Post path — the terminal/post-collision
// assertions go red and a recycled tool_use_id from another session would bind
// a live agent to a stale prompt.

test('DS-PO08: a Post with no usable tool_response (absent / non-object / no string agentId) binds nothing and leaves the record pending', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'dispatchState');
  for (const bad of [undefined, 'a string', 42, {}, { agentId: 42 }, { agentId: '' }]) {
    const { dir, cleanup } = project();
    try {
      await DS.recordDispatchPre(dir, PRE());
      const stdin = POST();
      if (bad === undefined) delete stdin.tool_response;
      else stdin.tool_response = bad;
      // eslint-disable-next-line no-await-in-loop
      await DS.recordDispatchPost(dir, stdin);
      // eslint-disable-next-line no-await-in-loop
      const rec = await soleRecord(dir);
      assert.equal(rec.post_binding, undefined, `tool_response ${JSON.stringify(bad)} must never yield a binding`);
      assert.equal(DS.dispatchState(rec), 'pending', 'the slot stays derivable — an unusable Post is not evidence against it');
    } finally {
      cleanup();
    }
  }
});
// SABOTAGE: bind on String(tool_response?.agentId) without a type/emptiness
// check — the empty-string and 42 arms go red and 'undefined' becomes a
// legitimate-looking agent id.

// ===========================================================================
// §2 — recordDispatchFailure + TERMINAL IS ABSORBING
// ===========================================================================

test('DS-F01: a Failure with NO Pre creates a minimal absorbing tombstone (origin "failure-only", reason "tool-failure")', async () => {
  requireOwner('recordDispatchFailure', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchFailure(dir, FAIL());
    const rec = await soleRecord(dir);
    assert.equal(rec.origin, 'failure-only');
    assert.equal(DS.dispatchState(rec), 'terminal');
    assert.equal(rec.terminal?.reason, 'tool-failure');
  } finally {
    cleanup();
  }
});
// SABOTAGE: no-op when there is no record to condemn — this goes red, and a
// Failure arriving before its own Pre (or with the Pre hook unregistered)
// leaves the key open for a later Pre to make derivable.

test('DS-F02: TERMINAL ABSORBS every later event — a Pre fills only MISSING fields, a Post binds nothing, a Failure changes no reason', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'recordDispatchFailure', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchFailure(dir, FAIL({ tool_input: undefined }));
    const first = await soleRecord(dir);
    assert.equal(DS.dispatchState(first), 'terminal');
    const terminalAt = first.terminal.at;

    await DS.recordDispatchPre(dir, PRE({ tool_input: { subagent_type: 'coder', prompt: 'LATE PRE', description: 'd' } }));
    const afterPre = await soleRecord(dir);
    assert.equal(DS.dispatchState(afterPre), 'terminal', 'a later Pre never resurrects a tombstone');
    assert.equal(afterPre.terminal.at, terminalAt, 'the terminal instant is never re-stamped');

    const postR = await DS.recordDispatchPost(dir, POST({ agentId: 'agent-late' }));
    const afterPost = await soleRecord(dir);
    assert.equal(afterPost.post_binding, undefined, 'a Post after terminal binds nothing');
    assert.equal(DS.dispatchState(afterPost), 'terminal');
    assert.ok(disclosureText(postR).length > 0, 'the late Post is disclosed');

    await DS.recordDispatchFailure(dir, FAIL());
    assert.equal((await soleRecord(dir)).terminal.at, terminalAt, 'a second Failure does not move the tombstone');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the terminal check from any one of the three writers — the
// corresponding assertion goes red. Each writer needs its own guard: this arm
// is deliberately a sequence so no single guard can carry all three.
// (Which guard carries the verdict: three independent ones, one per writer.)

test('DS-F03: a LATE Post after a Stop tombstone is a disclosed no-op — the round is over, not re-opened', async () => {
  requireOwner('recordDispatchPre', 'resolveDispatchStart', 'finishDispatchAndRegisterEnd', 'recordDispatchPost', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    await DS.resolveDispatchStart(dir, START(), { consumer: 'h22' });
    await DS.finishDispatchAndRegisterEnd(dir, { session_id: 's1', agent_id: 'agent-1', event: 'subagent-stop' });
    const stopped = await soleRecord(dir);
    assert.equal(DS.dispatchState(stopped), 'terminal');
    assert.equal(stopped.terminal.reason, 'stop');

    const r = await DS.recordDispatchPost(dir, POST({ agentId: 'agent-1' }));
    const after = await soleRecord(dir);
    assert.equal(after.post_binding, undefined, 'the foreground-launch case (Post lands after the child finished) must not re-open a closed round');
    assert.ok(disclosureText(r).length > 0, 'the late Post is disclosed, not swallowed');
  } finally {
    cleanup();
  }
});
// SABOTAGE: let Post write post_binding regardless of terminal — the
// post_binding assertion goes red; measured decision foreign_edbaa38d says a
// FOREGROUND Task's Post lands after the child's Stop, so this is the common
// path, not a corner.

// ===========================================================================
// §5 — THE RESOLVER
// ===========================================================================

test('DS-R01: a record whose post_binding is MINE resolves source "post" and records started{by:[consumer]}', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'resolveDispatchStart', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ tool_input: { subagent_type: 'coder', prompt: 'MY BRIEF names src/a.mjs', description: 'd' } }));
    await DS.recordDispatchPost(dir, POST({ prompt: 'MY BRIEF names src/a.mjs', responsePrompt: 'MY BRIEF names src/a.mjs', agentId: 'agent-1' }));
    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-1' }), { consumer: 'h22' });
    assert.equal(res.source, 'post');
    assert.equal(res.prompt, 'MY BRIEF names src/a.mjs');
    assert.equal(res.subagent_type, 'coder');
    assert.equal(res.tool_use_id, 'toolu_pre_1');
    const rec = await soleRecord(dir);
    assert.equal(DS.dispatchState(rec), 'started');
    assert.equal(rec.started.agent_id, 'agent-1');
    assert.deepEqual(rec.started.by, ['h22']);
  } finally {
    cleanup();
  }
});
// SABOTAGE: resolve by scanning for a pending record FIRST (before the
// my-binding branch) — with a bound record present the resolver would report
// 'derived-type-unique' or 'no-slot'; the source assertion goes red.

test('DS-R02: two consumers resolving the SAME post-bound record converge on ONE started, with both consumers in started.by (idempotent)', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'resolveDispatchStart');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    await DS.recordDispatchPost(dir, POST({ agentId: 'agent-1' }));
    const a = await DS.resolveDispatchStart(dir, START(), { consumer: 'h19' });
    const b = await DS.resolveDispatchStart(dir, START(), { consumer: 'h22' });
    assert.equal(a.source, 'post');
    assert.equal(b.source, 'post');
    const rec = await soleRecord(dir);
    assert.deepEqual([...rec.started.by].sort(), ['h19', 'h22'], 'each consumer appends itself once');
    assert.equal(rec.started.agent_id, 'agent-1', 'started.agent_id is set once and is immutable forensic evidence');
  } finally {
    cleanup();
  }
});
// SABOTAGE: overwrite started (rather than appending to started.by) on the
// second consumer — the deepEqual goes red and the record loses the evidence
// that BOTH hooks consumed this prompt.

test('DS-R03: a record whose derived_binding is MINE resolves source "derived-type-unique", not "post"', async () => {
  requireOwner('resolveDispatchStart');
  const { dir, cleanup } = project();
  try {
    const prompt = 'derived brief';
    writeStateRaw(dir, `${DS.dispatchStateKey('toolu_d')}.json`, {
      schema: 1,
      tool_use_id: 'toolu_d',
      session_id: 's1',
      prompt_id: 'pr-1',
      subagent_type: 'coder',
      description: 'd',
      prompt,
      prompt_bytes: Buffer.byteLength(prompt, 'utf8'),
      prompt_sha256: sha256(prompt),
      origin: 'pre',
      derived_binding: { agent_id: 'agent-1', at: new Date().toISOString(), by: 'h19' },
    });
    const res = await DS.resolveDispatchStart(dir, START(), { consumer: 'h22' });
    assert.equal(res.source, 'derived-type-unique', 'the SOURCE distinguishes a platform binding from a derivation — a consumer must be able to tell them apart');
    assert.equal(res.prompt, prompt);
  } finally {
    cleanup();
  }
});
// SABOTAGE: report 'post' for any resolved binding — this goes red while
// DS-R01 stays green, which is why the two arms are separate: 'post' is proof,
// 'derived-type-unique' is an inference, and the register records which.

test('DS-R04: RESUME GUARD — a record from ANOTHER session_id carrying my agent_id makes me a resume, and a fresh same-type pending slot is NOT consumed', async () => {
  requireOwner('recordDispatchPre', 'resolveDispatchStart', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    const old = 'the previous session brief';
    writeStateRaw(dir, `${DS.dispatchStateKey('toolu_old')}.json`, {
      schema: 1,
      tool_use_id: 'toolu_old',
      session_id: 's0',
      subagent_type: 'coder',
      prompt: null,
      prompt_bytes: Buffer.byteLength(old, 'utf8'),
      prompt_sha256: sha256(old),
      origin: 'pre',
      post_binding: { agent_id: 'agent-1', at: '2026-09-07T00:00:00.000Z' },
      started: { agent_id: 'agent-1', at: '2026-09-07T00:00:01.000Z', by: ['h22'] },
      terminal: { at: '2026-09-07T00:10:00.000Z', reason: 'session-boundary' },
    });
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_fresh', session_id: 's1' }));

    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-1' }), { consumer: 'h19' });
    assert.equal(res.source, 'resume', 'a surviving tombstone naming my agent_id is proof I have started before');
    const fresh = await recordFor(dir, 'toolu_fresh');
    assert.equal(DS.dispatchState(fresh), 'pending', "the innocent sibling's slot is still pending — a resume consumes nothing");
    assert.equal(fresh.derived_binding, undefined);
  } finally {
    cleanup();
  }
});
// SABOTAGE: run derivation BEFORE the resume guard (or scope the guard to the
// current session) — the resumed agent consumes the fresh slot, so the
// 'resume' assertion and the still-pending assertion both go red. This is the
// round-2 fatal case Codex named: H19's delivery guard makes that
// misattribution PERMANENT.

test('DS-R05: RESUME GUARD via the REGISTER alone — an existing (session_id, agent_id) round is resume evidence even with no state record naming me', async () => {
  requireOwner('recordDispatchPre', 'resolveDispatchStart', 'registerStart', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.registerStart(dir, {
      agent_id: 'agent-1', agent_type: 'coder', session_id: 's1', files: [], at: new Date().toISOString(), attribution: 'none',
    });
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_fresh2' }));
    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-1' }), { consumer: 'h22' });
    assert.equal(res.source, 'resume');
    assert.equal(DS.dispatchState(await recordFor(dir, 'toolu_fresh2')), 'pending', 'no slot consumed');
  } finally {
    cleanup();
  }
});
// SABOTAGE: check only the state records for resume evidence — this goes red
// while DS-R04 stays green; a round-2 Start whose round-1 state was pruned
// (7-day sweep) would silently derive a stranger's pending slot.

test('DS-R06: exactly ONE pending record of my type derives — derived_binding AND started are committed', async () => {
  requireOwner('recordDispatchPre', 'resolveDispatchStart', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_mine', tool_input: { subagent_type: 'coder', prompt: 'MINE', description: 'd' } }));
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_other', tool_input: { subagent_type: 'test-writer', prompt: 'NOT MINE', description: 'd' } }));
    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-1', agent_type: 'coder' }), { consumer: 'h22' });
    assert.equal(res.source, 'derived-type-unique');
    assert.equal(res.prompt, 'MINE', 'the other-TYPE sibling is never a candidate');
    const mine = await recordFor(dir, 'toolu_mine');
    assert.equal(mine.derived_binding?.agent_id, 'agent-1');
    assert.equal(mine.derived_binding?.by, 'h22');
    assert.equal(DS.dispatchState(mine), 'started');
    assert.equal(DS.dispatchState(await recordFor(dir, 'toolu_other')), 'pending', "the other type's slot is untouched");
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the subagent_type === agent_type filter (derive from any
// single pending record) — with two pending records of different types the
// resolver would find two candidates and report
// 'same-type-siblings-in-flight', so the source and prompt assertions go red.

test('DS-R07: ZERO pending records of my type is "unattributable" with case "no-slot" — never a guess', async () => {
  requireOwner('resolveDispatchStart');
  const { dir, cleanup } = project();
  try {
    const res = await DS.resolveDispatchStart(dir, START(), { consumer: 'h19' });
    assert.equal(res.source, 'unattributable');
    assert.equal(res.case, 'no-slot');
    assert.equal(res.prompt, null, 'no prompt is invented for an unattributable Start');
  } finally {
    cleanup();
  }
});
// SABOTAGE: fall back to the parent transcript's last dispatch block (the
// DELETED mechanism) — res.prompt would be a real string and both assertions
// go red. This is the 4-of-6-wrong-territory defect the decision exists to
// remove.

test('DS-R08: two pending same-type slots + a Post landing DURING the bounded wait resolves "post" inside the 150 ms budget', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'resolveDispatchStart');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_twinA', tool_input: { subagent_type: 'coder', prompt: 'TWIN A', description: 'a' } }));
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_twinB', tool_input: { subagent_type: 'coder', prompt: 'TWIN B', description: 'b' } }));

    const clock = fakeClock();
    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      if (sleeps === 2) {
        // The measured race: Post lands 1.1 ms after the child's Start.
        await DS.recordDispatchPost(dir, POST({ tool_use_id: 'toolu_twinB', prompt: 'TWIN B', responsePrompt: 'TWIN B', agentId: 'agent-1' }));
      }
    };
    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-1' }), { consumer: 'h19', now: clock.now, sleep });

    assert.equal(res.source, 'post', 'the bounded wait exists precisely so a Post landing microseconds after Start still attributes');
    assert.equal(res.prompt, 'TWIN B');
    assert.ok(sleeps >= 1, 'the ambiguous case genuinely went through the wait path');
    assert.ok(sleeps <= 15, `the wait is bounded at 150 ms of the INJECTED clock (10 ms/tick) — ${sleeps} sleeps is past the budget`);
    assert.equal(DS.dispatchState(await recordFor(dir, 'toolu_twinA')), 'pending', "the twin's slot is never consumed by my Start");
  } finally {
    cleanup();
  }
});
// SABOTAGE: resolve the two-candidate case immediately as
// 'same-type-siblings-in-flight' with no retry — the source assertion goes
// red. Inverse sabotage: retry forever (no budget) — the sleeps<=15 assertion
// goes red and a SubagentStart hook hangs the spawn.

test('DS-R09: two pending same-type slots and NO Post is "same-type-siblings-in-flight" with count 2, inside the budget, mutating NOTHING', async () => {
  requireOwner('recordDispatchPre', 'resolveDispatchStart', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_t1', tool_input: { subagent_type: 'coder', prompt: 'T1', description: 'a' } }));
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_t2', tool_input: { subagent_type: 'coder', prompt: 'T2', description: 'b' } }));
    const before = stateFiles(dir).map((f) => readFileSync(join(stateDir(dir), f), 'utf8'));

    const clock = fakeClock();
    let sleeps = 0;
    const wall = Date.now();
    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-1' }), { consumer: 'h22', now: clock.now, sleep: async () => { sleeps += 1; } });
    const elapsed = Date.now() - wall;

    assert.equal(res.source, 'unattributable');
    assert.equal(res.case, 'same-type-siblings-in-flight');
    assert.equal(res.count, 2, 'the case CARRIES the count — this is the instrumentation §7(a) requires before the deny hooks are coupled');
    assert.equal(res.prompt, null);
    assert.ok(sleeps <= 15, `bounded by the injected clock: ${sleeps} sleeps`);
    assert.ok(elapsed < 1000, `an injected sleep must not spend real time: ${elapsed}ms`);
    assert.deepEqual(stateFiles(dir).map((f) => readFileSync(join(stateDir(dir), f), 'utf8')), before, 'an ambiguous Start writes NOTHING — both slots stay byte-identical and derivable');
  } finally {
    cleanup();
  }
});
// SABOTAGE: pick the first/oldest candidate when several match ("close
// enough") — the case and count assertions go red and 4-of-6-wrong-territory
// returns under a new name. Second sabotage: mark the candidates consumed
// while ambiguous — the byte-identical assertion goes red.

test('DS-R10: a DERIVED commit never overwrites an existing post_binding — a post-bound record is not a derivation candidate', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'resolveDispatchStart', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    // Slot A is already bound to somebody else by the platform.
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_bound', tool_input: { subagent_type: 'coder', prompt: 'BOUND TO OTHER', description: 'a' } }));
    await DS.recordDispatchPost(dir, POST({ tool_use_id: 'toolu_bound', prompt: 'BOUND TO OTHER', responsePrompt: 'BOUND TO OTHER', agentId: 'agent-other' }));
    // Slot B is genuinely pending.
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_free', tool_input: { subagent_type: 'coder', prompt: 'FREE', description: 'b' } }));

    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-me' }), { consumer: 'h22' });
    assert.equal(res.source, 'derived-type-unique', 'exactly ONE candidate exists, because a bound record is not a candidate');
    assert.equal(res.prompt, 'FREE');
    const bound = await recordFor(dir, 'toolu_bound');
    assert.equal(bound.post_binding.agent_id, 'agent-other', "the authoritative Post binding is never rewritten by another agent's derivation");
    assert.equal(bound.derived_binding, undefined);
  } finally {
    cleanup();
  }
});
// SABOTAGE: treat "no derived_binding yet" as pending (ignoring post_binding)
// — two candidates appear, so the source/prompt assertions go red; and in the
// enumerate-then-rename shape Codex called fatal, the derived write would
// clobber agent-other's binding and destroy the mismatch evidence.

test('DS-R11 CONTROL: with ONLY the post-bound record present, another agent gets "no-slot" — a bound record is never borrowed', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'resolveDispatchStart');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    await DS.recordDispatchPost(dir, POST({ agentId: 'agent-other' }));
    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-me' }), { consumer: 'h22' });
    assert.equal(res.source, 'unattributable');
    assert.equal(res.case, 'no-slot');
  } finally {
    cleanup();
  }
});
// SABOTAGE: same as DS-R10 — but this arm proves the exclusion is a real
// filter rather than an artefact of there being a second candidate.

test('DS-R12: derived/Post MISMATCH keeps started IMMUTABLE, sets the authoritative post_binding, and records derived_post_mismatch', async () => {
  requireOwner('recordDispatchPre', 'resolveDispatchStart', 'recordDispatchPost');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-derived' }), { consumer: 'h19' });
    assert.equal(res.source, 'derived-type-unique');

    const r = await DS.recordDispatchPost(dir, POST({ agentId: 'agent-real' }));
    const rec = await soleRecord(dir);
    assert.equal(rec.post_binding?.agent_id, 'agent-real', 'the platform binding is authoritative for LATER consumers');
    assert.equal(rec.started.agent_id, 'agent-derived', 'started.agent_id is who ACTUALLY consumed the prompt — forensic, never rewritten');
    assert.equal(rec.derived_post_mismatch?.derived_agent_id, 'agent-derived');
    assert.equal(rec.derived_post_mismatch?.post_agent_id, 'agent-real');
    assert.ok(disclosureText(r).length > 0, 'the mismatch is disclosed LOUDLY — H19 may already have staged the wrong knowledge');
  } finally {
    cleanup();
  }
});
// SABOTAGE: on a mismatch, rewrite started.agent_id to the Post's agent (or
// skip post_binding to "protect" the derivation) — either flips one of the two
// identity assertions red. The decision does NOT promise repair; it promises
// both facts survive.

test('DS-R13 CONTROL: a Post CONFIRMING its own derivation records confirmed_derived and NO mismatch', async () => {
  requireOwner('recordDispatchPre', 'resolveDispatchStart', 'recordDispatchPost');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-1' }), { consumer: 'h19' });
    await DS.recordDispatchPost(dir, POST({ agentId: 'agent-1' }));
    const rec = await soleRecord(dir);
    assert.equal(rec.post_binding?.agent_id, 'agent-1');
    assert.equal(rec.post_binding?.confirmed_derived, true, 'a derivation the platform later confirms is marked as confirmed, not as a mismatch');
    assert.equal(rec.derived_post_mismatch, undefined);
    assert.equal(rec.started.agent_id, 'agent-1');
  } finally {
    cleanup();
  }
});
// SABOTAGE: record derived_post_mismatch whenever a started record receives a
// Post (without comparing the agent ids) — this control goes red while DS-R12
// stays green: the pair is what proves the comparison is real.

// --- §6 POISON -------------------------------------------------------------

const POISON_SHAPES = [
  {
    name: 'unparseable JSON',
    plant: (dir) => writeStateRaw(dir, `${DS.dispatchStateKey('toolu_bad')}.json`, '{ this is not json'),
  },
  {
    name: 'unknown schema version',
    plant: (dir) => writeStateRaw(dir, `${DS.dispatchStateKey('toolu_v9')}.json`, { schema: 99, tool_use_id: 'toolu_v9', session_id: 's1', subagent_type: 'coder', prompt: 'x' }),
  },
  {
    name: 'prompt_sha256 disagreeing with prompt',
    plant: (dir) => writeStateRaw(dir, `${DS.dispatchStateKey('toolu_hash')}.json`, {
      schema: 1, tool_use_id: 'toolu_hash', session_id: 's1', subagent_type: 'coder', origin: 'pre',
      prompt: 'the real prompt', prompt_bytes: Buffer.byteLength('the real prompt', 'utf8'), prompt_sha256: sha256('SOMETHING ELSE'),
    }),
  },
  {
    name: 'orphan .tmp-* from a failed atomic write',
    plant: (dir) => writeStateRaw(dir, `${DS.dispatchStateKey('toolu_tmp')}.json.tmp-deadbeef`, { schema: 1, tool_use_id: 'toolu_tmp', session_id: 's1', subagent_type: 'coder', prompt: 'half-written' }),
  },
  {
    name: 'a non-regular entry (a directory where a record belongs)',
    plant: (dir) => {
      mkdirSync(join(stateDir(dir), `${DS.dispatchStateKey('toolu_dir')}.json`), { recursive: true });
    },
  },
];

for (const shape of POISON_SHAPES) {
  test(`DS-R14 (${shape.name}): readDispatchState NAMES the poisoned file and every Start becomes unattributable "state-poisoned"`, async () => {
    requireOwner('recordDispatchPre', 'readDispatchState', 'resolveDispatchStart', 'dispatchState');
    const { dir, cleanup } = project();
    try {
      // A perfectly good, uniquely-typed pending slot sits beside the poison:
      // without the poison this Start would derive it (see DS-R06), so a green
      // result here can only be explained by the poison.
      await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_good' }));
      shape.plant(dir);

      const st = await DS.readDispatchState(dir);
      assert.ok(Array.isArray(st.poisoned) && st.poisoned.length >= 1, 'the poisoned entry is enumerated, never silently skipped');
      assert.ok(st.poisoned.some((p) => typeof p.file === 'string' && p.file.length > 0), 'each poisoned entry names the FILE an operator must inspect');
      assert.ok(st.poisoned.every((p) => typeof p.reason === 'string' && p.reason.length > 0), 'and why it is unusable');

      const res = await DS.resolveDispatchStart(dir, START(), { consumer: 'h22' });
      assert.equal(res.source, 'unattributable');
      assert.equal(res.case, 'state-poisoned', 'a record that cannot be read has unknowable type and session, so it MAY be my same-type sibling');
      assert.equal(DS.dispatchState(await recordFor(dir, 'toolu_good')), 'pending', 'nothing is consumed while the directory is poisoned');
    } finally {
      cleanup();
    }
  });
}
// SABOTAGE (all five arms): skip unreadable entries and derive from the
// readable remainder — every arm's case assertion goes red (it would read
// 'derived-type-unique'), and an unreadable sibling's Start would be handed
// this agent's prompt. Which guard carries the verdict: ONE — the poisoned[]
// check ahead of derivation; the five arms differ only in the DETECTOR that
// must classify each shape as poison.

test('DS-R15 (POSIX): a SYMLINK entry in the state dir is poison — it is never followed', { skip: IS_WIN ? 'symlinks need admin on win32' : false }, async () => {
  requireOwner('recordDispatchPre', 'readDispatchState', 'resolveDispatchStart');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_good' }));
    const target = join(dir, 'outside-target.json');
    writeFileSync(target, JSON.stringify({ schema: 1, tool_use_id: 'toolu_link', session_id: 's1', subagent_type: 'coder', prompt: 'PLANTED' }));
    symlinkSync(target, join(stateDir(dir), `${DS.dispatchStateKey('toolu_link')}.json`));

    const st = await DS.readDispatchState(dir);
    assert.ok(st.poisoned.some((p) => /link/i.test(p.file) || /symlink/i.test(p.reason ?? '')), 'the symlink is reported as poison');
    const res = await DS.resolveDispatchStart(dir, START(), { consumer: 'h22' });
    assert.equal(res.case, 'state-poisoned');
    assert.notEqual(res.prompt, 'PLANTED', 'a planted symlink must never deliver its target as a dispatch prompt');
  } finally {
    cleanup();
  }
});
// SABOTAGE: stat instead of lstat when classifying entries — the symlink
// reads as a regular file, so its planted content becomes a live record: the
// case assertion goes red and an attacker-writable path is read as a brief.

test('DS-R16 (POSIX): an UNLISTABLE state directory is "state-unavailable", distinct from absent', { skip: IS_WIN || IS_ROOT ? 'chmod 000 does not block win32/root' : false }, async () => {
  requireOwner('recordDispatchPre', 'readDispatchState', 'resolveDispatchStart');
  const { dir, cleanup } = project();
  const d = stateDir(dir);
  try {
    await DS.recordDispatchPre(dir, PRE());
    chmodSync(d, 0o000);
    const st = await DS.readDispatchState(dir);
    assert.equal(st.availability, 'unavailable', 'unreadable is NOT the same fact as absent (anti-pattern config-derived-posture-line-collapses-absent-into-unusable)');
    const res = await DS.resolveDispatchStart(dir, START(), { consumer: 'h19' });
    assert.equal(res.source, 'unattributable');
    assert.equal(res.case, 'state-unavailable');
  } finally {
    try { chmodSync(d, 0o700); } catch { /* already gone */ }
    cleanup();
  }
});
// SABOTAGE: catch the readdir error and return {availability:'absent'} — the
// availability and case assertions go red and an unreadable directory is
// reported as "there were no dispatches", which is a confident lie.

test('DS-R17 CONTROL: an ABSENT state directory is availability "absent" and case "no-slot" — never "unavailable"', async () => {
  requireOwner('readDispatchState', 'resolveDispatchStart');
  const { dir, cleanup } = project();
  try {
    const st = await DS.readDispatchState(dir);
    assert.equal(st.availability, 'absent');
    assert.deepEqual(st.records, []);
    assert.deepEqual(st.poisoned, []);
    const res = await DS.resolveDispatchStart(dir, START(), { consumer: 'h19' });
    assert.equal(res.case, 'no-slot');
  } finally {
    cleanup();
  }
});
// SABOTAGE: collapse absent into unavailable — this control goes red while
// DS-R16 stays green; a first-ever session would then report a fault.

test('DS-R18: a HELD register lock returns case "lock-held" within the budget and mutates nothing', async () => {
  requireOwner('recordDispatchPre', 'resolveDispatchStart', 'registerLockDir');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    const before = stateFiles(dir).map((f) => readFileSync(join(stateDir(dir), f), 'utf8'));
    forgeLiveLock(dir);

    const wall = Date.now();
    const res = await DS.resolveDispatchStart(dir, START(), { consumer: 'h22', lockTimeoutMs: 200, retryMs: 10 });
    const elapsed = Date.now() - wall;

    assert.equal(res.source, 'unattributable');
    assert.equal(res.case, 'lock-held', 'a lock a live-looking owner holds fails CLOSED — it never proceeds unlocked');
    // TIGHTENED (review, 2026-09-08): the bound is the budget PASSED IN, not a
    // generous ceiling. 200 ms of budget plus process slack must land well
    // under 1 s; a 5 s bound was satisfiable by an implementation that ignored
    // lockTimeoutMs entirely, which is exactly the hole a weak bound leaves.
    assert.ok(elapsed < 1000, `resolveDispatchStart must HONOUR {lockTimeoutMs:200}: took ${elapsed}ms`);
    assert.deepEqual(stateFiles(dir).map((f) => readFileSync(join(stateDir(dir), f), 'utf8')), before, 'nothing was written outside the lock');
  } finally {
    cleanup();
  }
});
// SABOTAGE: on lock timeout, proceed without the lock ("advisory anyway") —
// the case assertion goes red, and the enumerate-then-choose race Codex
// called fatal in round 1 is reachable again.

test('DS-R19: a Start with NO agent_type never derives (case "no-agent-type"), but a post_binding STILL resolves', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'resolveDispatchStart', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_nt' }));
    const start = START({ agent_id: 'agent-1' });
    delete start.agent_type;

    const res = await DS.resolveDispatchStart(dir, start, { consumer: 'h22' });
    assert.equal(res.source, 'unattributable');
    assert.equal(res.case, 'no-agent-type', 'derivation is exact BY CONSTRUCTION over the type; with no type there is no construction');
    assert.equal(DS.dispatchState(await recordFor(dir, 'toolu_nt')), 'pending');

    await DS.recordDispatchPost(dir, POST({ tool_use_id: 'toolu_nt', agentId: 'agent-1' }));
    const res2 = await DS.resolveDispatchStart(dir, start, { consumer: 'h22' });
    assert.equal(res2.source, 'post', 'an authoritative binding needs no type at all');
  } finally {
    cleanup();
  }
});
// SABOTAGE: treat a missing agent_type as a wildcard matching every pending
// record — the case assertion goes red and a type-less Start silently eats the
// first slot it finds. Second sabotage: return early on a missing agent_type
// BEFORE the my-binding branch — the res2 assertion goes red.

// ===========================================================================
// §5 — resolveAndRegisterStart (composite: state write FIRST, register second)
// ===========================================================================

const startEntry = (resolution, over = {}) => ({
  agent_id: 'agent-1',
  agent_type: 'coder',
  session_id: 's1',
  at: new Date().toISOString(),
  files: [],
  files_source: resolution?.source === 'unattributable' || resolution?.source === 'resume' ? 'unattributable' : 'review-territory',
  attribution: resolution?.source === 'unattributable' || resolution?.source === 'resume' ? 'none' : 'block',
  ...over,
});

test('DS-RS01: resolveAndRegisterStart writes the STATE record BEFORE the register round — an entryBuilder that throws leaves a started record and NO round', async () => {
  requireOwner('recordDispatchPre', 'resolveAndRegisterStart', 'dispatchState', 'registerPath');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    const boom = () => { throw new Error('entryBuilder exploded'); };
    await refusalOf(() => DS.resolveAndRegisterStart(dir, START(), boom));

    const rec = await soleRecord(dir);
    assert.equal(DS.dispatchState(rec), 'started', 'the state write landed first, so the slot is consumed and can never be derived by a same-type sibling');
    const regPath = DS.registerPath(dir);
    const rounds = existsSync(regPath) ? JSON.parse(readFileSync(regPath, 'utf8')) : [];
    assert.equal(rounds.length, 0, 'no register round was appended — the crash-between-the-two leaves the HARMLESS half (bounded under-deferral)');
  } finally {
    cleanup();
  }
});
// SABOTAGE: register first, then write state — the started assertion goes red
// (state stays pending) and a crash in between leaves a PENDING slot a
// same-type sibling can derive, which is confident misattribution rather than
// bounded under-deferral. The write ORDER is the pin, not the pair.

test('DS-RS02: resolveAndRegisterStart hands the RESOLUTION to entryBuilder and appends exactly the entry it returns', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'resolveAndRegisterStart', 'registerPath');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ tool_input: { subagent_type: 'coder', prompt: 'BRIEF names src/a.mjs', description: 'd' } }));
    await DS.recordDispatchPost(dir, POST({ prompt: 'BRIEF names src/a.mjs', responsePrompt: 'BRIEF names src/a.mjs', agentId: 'agent-1' }));

    let seen = null;
    const r = await DS.resolveAndRegisterStart(dir, START(), (resolution) => {
      seen = resolution;
      return startEntry(resolution, { files: ['src/a.mjs'], attribution: 'block', attribution_case: 'post' });
    });
    assert.ok(seen, 'the builder is called with the resolution — the caller cannot re-derive it');
    assert.equal(seen.source, 'post');
    assert.equal(seen.prompt, 'BRIEF names src/a.mjs');
    assert.equal(r.resolution.source, 'post');
    const rounds = JSON.parse(readFileSync(DS.registerPath(dir), 'utf8'));
    assert.equal(rounds.length, 1);
    assert.deepEqual(rounds[0].files, ['src/a.mjs']);
    assert.equal(rounds[0].attribution, 'block');
    assert.equal(rounds[0].attribution_case, 'post');
  } finally {
    cleanup();
  }
});
// SABOTAGE: ignore the builder's return and append a hardcoded entry — the
// files/attribution_case assertions go red. (H22's own field POLICY is pinned
// end-to-end in scripts/tests/dispatch-state-hooks.test.mjs; this arm pins
// only that the composite passes the resolution through and writes what it is
// given.)

test('DS-RS03: a RESUME still appends a fresh UNENDED round (each Start is its own round, decision foreign_24dc4c63) and consumes no slot', async () => {
  requireOwner('recordDispatchPre', 'registerStart', 'registerEnd', 'resolveAndRegisterStart', 'registerPath', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.registerStart(dir, startEntry({ source: 'post' }, { files: ['src/round1.mjs'] }));
    await DS.registerEnd(dir, 'agent-1', 'subagent-stop', { sessionId: 's1' });
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_fresh3' }));

    const r = await DS.resolveAndRegisterStart(dir, START(), (resolution) => startEntry(resolution));
    assert.equal(r.resolution.source, 'resume');
    const rounds = JSON.parse(readFileSync(DS.registerPath(dir), 'utf8'));
    assert.equal(rounds.length, 2, 'round 2 is appended beside the ended round 1');
    const unended = rounds.filter((e) => !e.ended);
    assert.equal(unended.length, 1);
    assert.deepEqual(unended[0].files, [], 'a resume stages nothing, so its round declares no territory');
    assert.equal(unended[0].files_source, 'unattributable');
    assert.equal(unended[0].attribution, 'none');
    assert.equal(DS.dispatchState(await recordFor(dir, 'toolu_fresh3')), 'pending', "the fresh slot belongs to somebody else and stays pending");
  } finally {
    cleanup();
  }
});
// SABOTAGE: skip the register append when the resolution is 'resume' — the
// rounds.length assertion goes red, and the resumed round's Stop then has no
// unended round, so its reviewer receipt is never minted (R1-A25/B18).

// ===========================================================================
// §4(a) — finishDispatchAndRegisterEnd
// ===========================================================================

test('DS-FE01: Stop ends the round AND tombstones the record with prompt:null, located by the agent BINDING', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'resolveAndRegisterStart', 'finishDispatchAndRegisterEnd', 'dispatchState', 'registerPath');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE());
    await DS.recordDispatchPost(dir, POST({ agentId: 'agent-1' }));
    await DS.resolveAndRegisterStart(dir, START(), (resolution) => startEntry(resolution));

    const r = await DS.finishDispatchAndRegisterEnd(dir, { session_id: 's1', agent_id: 'agent-1', event: 'subagent-stop' });
    assert.notEqual(r?.found, false, 'the unended round for this agent is found');
    const rounds = JSON.parse(readFileSync(DS.registerPath(dir), 'utf8'));
    assert.equal(rounds.length, 1, 'Stop MARKS the round; it never deletes it');
    assert.equal(rounds[0].ended?.event, 'subagent-stop');
    const rec = await soleRecord(dir);
    assert.equal(DS.dispatchState(rec), 'terminal');
    assert.equal(rec.terminal.reason, 'stop');
    assert.equal(rec.prompt, null, 'the prompt is dropped at Stop — the record survives as identity/forensics, not as a brief store');
    assert.equal(rec.started?.agent_id, 'agent-1', 'the forensic evidence of who consumed the prompt survives the tombstone');
  } finally {
    cleanup();
  }
});
// SABOTAGE: delete the register entry at Stop (pre-A1 behaviour) — the
// rounds.length/ended assertions go red. Second sabotage: keep the prompt on
// the tombstone — the prompt:null assertion goes red and a 7-day-old brief
// stays readable in transient state.

test('DS-FE02: Stop locates the record by the supplied sidecarToolUseId when no binding carries this agent_id', async () => {
  requireOwner('recordDispatchPre', 'registerStart', 'finishDispatchAndRegisterEnd', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_sidecar' }));
    await DS.registerStart(dir, startEntry({ source: 'unattributable' }));
    const r = await DS.finishDispatchAndRegisterEnd(dir, {
      session_id: 's1', agent_id: 'agent-1', sidecarToolUseId: 'toolu_sidecar', event: 'subagent-stop',
    });
    assert.notEqual(r?.found, false);
    const rec = await recordFor(dir, 'toolu_sidecar');
    assert.equal(DS.dispatchState(rec), 'terminal', 'the sidecar id is the fallback locator for an unattributable round');
    assert.equal(rec.terminal.reason, 'stop');
    assert.equal(rec.prompt, null);
  } finally {
    cleanup();
  }
});
// SABOTAGE: ignore sidecarToolUseId and locate only by binding — the terminal
// assertion goes red, so an unattributable dispatch's slot stays PENDING for
// the rest of the session and poisons every same-type derivation after it.

test('DS-FE03 (POSIX): the register round is ended even when the state write cannot land — registerEnd is write ONE', { skip: IS_WIN || IS_ROOT ? 'chmod 000 does not block win32/root' : false }, async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'resolveAndRegisterStart', 'finishDispatchAndRegisterEnd', 'registerPath');
  const { dir, cleanup } = project();
  const d = stateDir(dir);
  try {
    await DS.recordDispatchPre(dir, PRE());
    await DS.recordDispatchPost(dir, POST({ agentId: 'agent-1' }));
    await DS.resolveAndRegisterStart(dir, START(), (resolution) => startEntry(resolution));
    chmodSync(d, 0o500); // readable (so the record is found) but not writable

    await refusalOf(() => DS.finishDispatchAndRegisterEnd(dir, { session_id: 's1', agent_id: 'agent-1', event: 'subagent-stop' }));
    const rounds = JSON.parse(readFileSync(DS.registerPath(dir), 'utf8'));
    assert.equal(rounds[0].ended?.event, 'subagent-stop', 'the round is ended FIRST, so a failure on write 2 never leaves a live round deferring H10 duties for a dead agent');
  } finally {
    try { chmodSync(d, 0o700); } catch { /* already gone */ }
    cleanup();
  }
});
// SABOTAGE: tombstone the state record first and end the round second — this
// goes red (the round stays unended when the state write fails), which is the
// exact harm §4(a)'s stated ORDER rationale exists to avoid.

// ===========================================================================
// §4(b) — sessionBoundarySweep
// ===========================================================================

test('DS-SW01: the sweep terminates every NON-TERMINAL record with reason "session-boundary" and prompt:null', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'resolveDispatchStart', 'sessionBoundarySweep', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_pending' }));
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_started' }));
    await DS.recordDispatchPost(dir, POST({ tool_use_id: 'toolu_started', agentId: 'agent-1' }));
    await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-1' }), { consumer: 'h22' });

    const r = await DS.sessionBoundarySweep(dir, {});
    assert.ok((r?.terminated ?? 0) >= 2, `both records are terminated: ${JSON.stringify(r)}`);
    for (const id of ['toolu_pending', 'toolu_started']) {
      const rec = await recordFor(dir, id); // eslint-disable-line no-await-in-loop
      assert.equal(DS.dispatchState(rec), 'terminal', `${id} is terminal after the boundary — the pending set is EMPTIED so nothing from a previous session is derivable`);
      assert.equal(rec.terminal.reason, 'session-boundary');
      assert.equal(rec.prompt, null);
    }
  } finally {
    cleanup();
  }
});
// SABOTAGE: rm -rf the directory at the boundary instead of tombstoning
// (round-2's FATAL alternative) — recordFor() finds nothing and both
// assertions go red; a resumed pre-/clear agent would then match a fresh
// same-type pending slot and consume it.

test('DS-SW02: the sweep PRUNES tombstones older than 7 days and KEEPS younger ones (injected now)', async () => {
  requireOwner('sessionBoundarySweep', 'dispatchStateKey');
  const { dir, cleanup } = project();
  try {
    const now = Date.parse('2026-09-08T12:00:00.000Z');
    const tomb = (id, at) => writeStateRaw(dir, `${DS.dispatchStateKey(id)}.json`, {
      schema: 1, tool_use_id: id, session_id: 's0', subagent_type: 'coder', origin: 'pre',
      prompt: null, prompt_bytes: 3, prompt_sha256: sha256('old'),
      post_binding: { agent_id: `a-${id}`, at: new Date(at).toISOString() },
      started: { agent_id: `a-${id}`, at: new Date(at).toISOString(), by: ['h22'] },
      terminal: { at: new Date(at).toISOString(), reason: 'session-boundary' },
    });
    tomb('toolu_ancient', now - 8 * DAY);
    tomb('toolu_recent', now - 6 * DAY);

    const r = await DS.sessionBoundarySweep(dir, { now });
    assert.ok((r?.pruned ?? 0) >= 1, `the ancient tombstone is pruned: ${JSON.stringify(r)}`);
    assert.equal(await recordFor(dir, 'toolu_ancient'), null, 'past 7 days the tombstone is garbage');
    assert.ok(await recordFor(dir, 'toolu_recent'), 'a 6-day-old tombstone SURVIVES — it is the resume evidence in §5(ii), not garbage');
  } finally {
    cleanup();
  }
});
// SABOTAGE: prune every tombstone at the boundary (or use the TTL as an
// ELIGIBILITY rule) — the surviving-tombstone assertion goes red and a
// resumed agent stops being recognisable as a resume. Inverse sabotage: never
// prune — the pruned assertion goes red and transient state grows forever.

test('DS-SW03 (POSIX): the sweep REFUSES when dispatch-state is a SYMLINK — nothing is removed through it', { skip: IS_WIN ? 'symlinks need admin on win32' : false }, async () => {
  requireOwner('sessionBoundarySweep', 'dispatchStateDir');
  const { dir, cleanup } = project();
  try {
    const real = join(dir, 'elsewhere');
    mkdirSync(real, { recursive: true });
    const victim = join(real, 'precious.json');
    writeFileSync(victim, '{"do":"not delete me"}');
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    symlinkSync(real, stateDir(dir));

    const r = await refusalOf(() => DS.sessionBoundarySweep(dir, { now: Date.parse('2026-09-08T12:00:00.000Z') }));
    assert.equal(existsSync(victim), true, 'a planted symlink must never be a delete-anywhere primitive');
    assert.equal(lstatSync(stateDir(dir)).isSymbolicLink(), true, 'the symlink itself is left for an operator to see');
    const refused = r.threw ? true : (r.value?.refused ?? false);
    assert.ok(refused, `the refusal is explicit and disclosed, never a silent skip: ${JSON.stringify(r.value ?? r.err?.message)}`);
  } finally {
    cleanup();
  }
});
// SABOTAGE: sweep by readdir on the path without an lstat check (or rm -rf
// the path) — the precious-file assertion goes red: a planted symlink turns
// the boundary sweep into an arbitrary-file clobber (the same defect class
// round 2 of the Codex sparring found in the truncate-in-place stamp write).

// ===========================================================================
// REVIEW ROUND 2 — holes two independent reviews found that the pins above did
// not cover (coordinator, 2026-09-08). Same style, one named sabotage each.
// Every arm here is RED BY CONSTRUCTION where the fix is not in yet: the
// owner surface does not exist at all today, so requireOwner() fails each on
// its own assertion.
// ===========================================================================

// --- (1) EVERY terminal path drops the prompt, not just Stop ---------------
//
// §4(a) states prompt:null explicitly for the STOP tombstone and §4(b) for the
// session boundary. DS-FE01/DS-SW01 pinned those two. Nothing pinned the other
// two ways a record becomes terminal — recordDispatchFailure and the
// post-collision terminal — nor the case where the sweep meets a record that is
// ALREADY terminal but still carries a prompt (written by an older build, or by
// a terminal path that forgot to null it). A tombstone is identity and
// forensics; a 7-day-retained brief is not.

test('DS-T01: a recordDispatchFailure tombstone carries prompt === null — the brief does not survive the failure', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchFailure', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    const prompt = 'SECRET BRIEF that must not outlive the dispatch';
    await DS.recordDispatchPre(dir, PRE({ tool_input: { subagent_type: 'coder', prompt, description: 'd' } }));
    assert.equal((await soleRecord(dir)).prompt, prompt, 'sanity: the prompt was genuinely stored first, so null below is a DROP, not an absence');

    await DS.recordDispatchFailure(dir, FAIL());
    const rec = await soleRecord(dir);
    assert.equal(DS.dispatchState(rec), 'terminal');
    assert.equal(rec.terminal.reason, 'tool-failure');
    assert.equal(rec.prompt, null, 'a failed dispatch is over — its brief is dropped exactly as at Stop');
    assert.equal(rec.prompt_sha256, sha256(prompt), 'the HASH survives: identity and forensics are kept, only the body goes');
  } finally {
    cleanup();
  }
});
// SABOTAGE: set only `terminal` on the failure path and leave `prompt`
// untouched — the prompt:null assertion goes red while DS-F01 (which checks
// only origin/reason) stays green, which is why this arm is separate.

test('DS-T02: the POST-COLLISION terminal also carries prompt === null', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    const prompt = 'SECRET BRIEF for session one';
    await DS.recordDispatchPre(dir, PRE({ session_id: 's1', tool_input: { subagent_type: 'coder', prompt, description: 'd' } }));
    await DS.recordDispatchPost(dir, POST({ session_id: 's2', prompt, responsePrompt: prompt, agentId: 'agent-foreign' }));
    const rec = await soleRecord(dir);
    assert.equal(DS.dispatchState(rec), 'terminal');
    assert.equal(rec.terminal.reason, 'post-collision');
    assert.equal(rec.post_binding, undefined, 'still no binding (DS-PO07)');
    assert.equal(rec.prompt, null, 'a key collided across sessions — the record is condemned, so its brief is dropped like any other tombstone');
  } finally {
    cleanup();
  }
});
// SABOTAGE: write the post-collision terminal by merging `{terminal}` into the
// existing record without nulling the prompt — this goes red while DS-PO07
// stays green.

test('DS-T03: the sweep NULLS the prompt of an ALREADY-terminal record that still carries one', async () => {
  requireOwner('sessionBoundarySweep', 'dispatchStateKey', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    const prompt = 'a brief left behind on an older tombstone';
    const now = Date.parse('2026-09-08T12:00:00.000Z');
    writeStateRaw(dir, `${DS.dispatchStateKey('toolu_stale')}.json`, {
      schema: 1,
      tool_use_id: 'toolu_stale',
      session_id: 's0',
      subagent_type: 'coder',
      origin: 'pre',
      prompt,
      prompt_bytes: Buffer.byteLength(prompt, 'utf8'),
      prompt_sha256: sha256(prompt),
      started: { agent_id: 'agent-old', at: '2026-09-08T09:00:00.000Z', by: ['h22'] },
      terminal: { at: '2026-09-08T09:30:00.000Z', reason: 'stop' }, // terminal, but the prompt was never dropped
    });

    await DS.sessionBoundarySweep(dir, { now });
    const rec = await recordFor(dir, 'toolu_stale');
    assert.ok(rec, 'a 2.5-hour-old tombstone is far inside the 7-day window and must SURVIVE (it is resume evidence, §5(ii))');
    assert.equal(rec.prompt, null, 'the boundary is the last chance to drop a brief a terminal path failed to null — otherwise it lingers for 7 days');
    assert.equal(rec.terminal.at, '2026-09-08T09:30:00.000Z', 'the original terminal instant is NOT re-stamped by the nulling');
    assert.equal(rec.terminal.reason, 'stop', 'nor is its reason rewritten to session-boundary');
  } finally {
    cleanup();
  }
});
// SABOTAGE: skip already-terminal records entirely in the sweep ("nothing to
// do") — the prompt:null assertion goes red. Second sabotage: handle them by
// re-terminalizing (writing a fresh session-boundary terminal) — the two
// terminal.* assertions go red instead, so the two mistakes are
// distinguishable.

// --- (2) the STATE DIRECTORY itself replaced by a symlink -----------------
//
// DS-R15 covers a symlinked ENTRY and DS-SW03 a symlinked DIRECTORY at sweep
// time. Neither covers the WRITE path: if dispatch-state/ is a symlink to a
// directory the attacker controls, an unguarded recordDispatchPre writes a
// 0o600 file full of the conductor's brief into it, and readDispatchState
// happily serves records planted there.

test('DS-T04 (POSIX): dispatch-state/ replaced by a SYMLINK — Pre refuses and writes NOTHING through it; the reader never lists through it', { skip: IS_WIN ? 'symlinks need admin on win32' : false }, async () => {
  requireOwner('recordDispatchPre', 'readDispatchState', 'dispatchStateDir');
  const { dir, cleanup } = project();
  try {
    const outside = join(dir, 'attacker-controlled');
    mkdirSync(outside, { recursive: true });
    // A plausible-looking record planted in the outside directory: if the
    // reader lists THROUGH the link, this prompt becomes a live dispatch brief.
    writeFileSync(
      join(outside, `${DS.dispatchStateKey('toolu_planted')}.json`),
      JSON.stringify({ schema: 1, tool_use_id: 'toolu_planted', session_id: 's1', subagent_type: 'coder', origin: 'pre', prompt: 'PLANTED BRIEF' })
    );
    symlinkSync(outside, stateDir(dir));

    const r = await DS.recordDispatchPre(dir, PRE({ tool_input: { subagent_type: 'coder', prompt: 'REAL BRIEF', description: 'd' } }));
    assert.match(
      disclosureText(r),
      /dispatch_state_poisoned/,
      'the refusal is disclosed by its closed-set code — a silently-skipped write leaves the caller believing a slot exists'
    );
    assert.deepEqual(
      readdirSync(outside).sort(),
      [`${DS.dispatchStateKey('toolu_planted')}.json`],
      'NOTHING was written through the link: the outside directory holds exactly what it held before, and the conductor\'s brief never left the project'
    );
    assert.equal(lstatSync(stateDir(dir)).isSymbolicLink(), true, 'the link itself is left in place for an operator to see, never silently replaced');

    const st = await DS.readDispatchState(dir);
    assert.notEqual(st.availability, 'ok', 'a symlinked state directory is never a healthy state directory');
    assert.ok(
      (st.poisoned?.length ?? 0) > 0 || st.availability === 'unavailable',
      `the reader reports the condition instead of serving what it found: ${JSON.stringify({ availability: st.availability, poisoned: st.poisoned })}`
    );
    assert.ok(
      !(st.records ?? []).some((x) => x.record?.tool_use_id === 'toolu_planted'),
      'the planted record is NEVER served as a real dispatch — that is the whole point of refusing to list through the link'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: mkdir -p the state dir and write with no lstat check on the
// directory entry (today's ordinary shape) — the readdir(outside) assertion
// goes red: the brief is exfiltrated into an attacker-controlled directory and
// the planted record is then served back as this session's own dispatch.

// --- (3) the ATOMIC-WRITE tmp file is not a reuse target -----------------
//
// The tmp suffix is random (`<key>.json.tmp-<hex>`), so a symlink planted at
// the exact tmp path cannot be constructed deterministically. The contract is
// pinned INDIRECTLY instead: a pre-planted regular file that LOOKS like a tmp
// file for this very key is neither reused nor truncated by the write, and the
// real record still lands with the private mode.

test('DS-T05: a pre-planted `<key>.json.tmp-deadbeef` is left completely untouched by a write for that same key, and the real record still lands 0o600', async () => {
  requireOwner('recordDispatchPre', 'dispatchStateKey');
  const { dir, cleanup } = project();
  try {
    const key = DS.dispatchStateKey('toolu_pre_1');
    const orphanName = `${key}.json.tmp-deadbeef`;
    const orphanBytes = '{"planted":"a decoy tmp file from a crashed write"}';
    writeStateRaw(dir, orphanName, orphanBytes);

    await DS.recordDispatchPre(dir, PRE({ tool_input: { subagent_type: 'coder', prompt: 'REAL BRIEF', description: 'd' } }));

    assert.equal(
      readFileSync(join(stateDir(dir), orphanName), 'utf8'),
      orphanBytes,
      'the writer mints its OWN random tmp name — it never reuses or truncates a name that already exists'
    );
    const real = join(stateDir(dir), `${key}.json`);
    assert.equal(existsSync(real), true, 'the real record landed at <key>.json');
    if (!IS_WIN) {
      assert.equal(statSync(real).mode & 0o777, 0o600, 'and it is private: 0o600, so a planted-file reuse could not have widened it either');
    }
    assert.ok(
      !readdirSync(stateDir(dir)).some((f) => f.endsWith('.tmp-deadbeef') && f !== orphanName),
      'no second decoy-named file appears'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: write to a FIXED tmp name (`<key>.json.tmp`) or to a name derived
// from the key alone, then rename — with a planted file at that path the write
// truncates somebody else's file (and, if it is a symlink, an arbitrary file);
// the orphanBytes assertion goes red. Which guard carries the verdict: the
// random suffix — the 0o600 arm is DS-P02's guard and stays green under this
// sabotage, which is why both are asserted here.

// --- (4) the sweep collects tmp ORPHANS, and not through a symlink --------

test('DS-T06: the sweep REMOVES orphan `*.json.tmp-*` regular files and REPORTS them', async () => {
  requireOwner('sessionBoundarySweep', 'dispatchStateKey', 'recordDispatchPre');
  const { dir, cleanup } = project();
  try {
    const now = Date.parse('2026-09-08T12:00:00.000Z');
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_live' })); // a real record, to prove the sweep is selective
    writeStateRaw(dir, `${DS.dispatchStateKey('toolu_a')}.json.tmp-0011aabb`, '{"half":"written"}');
    writeStateRaw(dir, `${DS.dispatchStateKey('toolu_b')}.json.tmp-ffee9988`, '{"half":"written too"}');

    const r = await DS.sessionBoundarySweep(dir, { now });
    const files = readdirSync(stateDir(dir));
    assert.ok(!files.some((f) => /\.tmp-/.test(f)), `every orphan tmp file is gone: ${JSON.stringify(files)}`);
    assert.ok(
      files.includes(`${DS.dispatchStateKey('toolu_live')}.json`),
      'the real record is NOT swept away with them — it is terminated in place (DS-SW01)'
    );
    // FIELD NAME DISCLOSED, NOT INVENTED: the contract sheet's return shape is
    // {terminated, pruned, refused?} and names no orphan counter, so this
    // accepts EITHER a tmp/orphan-named key OR the two removals folded into
    // `pruned` (>= 2). What is pinned unambiguously is that the sweep does not
    // delete files silently. Tighten to the real field once it lands.
    const reported = JSON.stringify(r ?? {});
    assert.ok(
      /tmp|orphan/i.test(reported) || (typeof r?.pruned === 'number' && r.pruned >= 2),
      `the sweep REPORTS what it removed rather than deleting silently: ${reported}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: leave tmp orphans in place ("harmless clutter") — the no-.tmp-
// assertion goes red, and every subsequent Start in the session is poisoned
// (§6 makes an orphan tmp POISON, so derivation refuses until the next
// boundary — the availability cost §7(a) says must be instrumented, not
// assumed away). Second sabotage: sweep the directory with a glob that also
// matches `<key>.json` — the real-record assertion goes red instead.

test('DS-T07 (POSIX): a SYMLINK named like a tmp orphan is NOT removed through — the target survives and the condition is reported', { skip: IS_WIN ? 'symlinks need admin on win32' : false }, async () => {
  requireOwner('sessionBoundarySweep', 'dispatchStateKey');
  const { dir, cleanup } = project();
  try {
    const now = Date.parse('2026-09-08T12:00:00.000Z');
    const victim = join(dir, 'precious-outside.json');
    writeFileSync(victim, '{"do":"not delete me"}');
    mkdirSync(stateDir(dir), { recursive: true });
    const linkName = `${DS.dispatchStateKey('toolu_link')}.json.tmp-cafebabe`;
    symlinkSync(victim, join(stateDir(dir), linkName));

    const r = await DS.sessionBoundarySweep(dir, { now });
    assert.equal(existsSync(victim), true, 'the tmp-orphan cleanup is for REGULAR FILES only — following a link makes it an arbitrary-file delete primitive');
    assert.equal(
      lstatSync(join(stateDir(dir), linkName)).isSymbolicLink(),
      true,
      'the link is left for an operator to see; removing the link itself would erase the evidence'
    );
    // FIELD NAME DISCLOSED, NOT INVENTED (same reasoning as DS-T06): §6 gives
    // no counter for a refused anomaly, so this accepts any report naming the
    // condition — `refused`, a poisoned entry, or a link/skip word. The
    // load-bearing assertions are the two above (the victim survives, the link
    // survives); this one only forbids a SILENT skip.
    const reported = JSON.stringify(r ?? {});
    assert.ok(
      /link|refus|poison|skip/i.test(reported),
      `the anomaly is reported, never a silent skip: ${reported}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: implement the tmp cleanup as `unlinkSync` on every name matching
// `.tmp-` without an lstat isFile() check — the victim assertion goes red, and
// the boundary sweep becomes a delete-anything primitive for whoever can plant
// a name in that directory. DS-T06 stays green under this sabotage, which is
// why the pair exists.

// --- (5) ONE-TO-ONE is scoped to LIVE, SAME-SESSION records ---------------
//
// DS-PO06 pins that an agentId already bound elsewhere refuses. Nothing pinned
// its SCOPE, and an over-broad scope is the worse failure: a 7-day tombstone or
// a foreign session carrying the same agent id would block a real, live
// dispatch from ever binding — a permanent unattributable, from a record that
// is by definition finished.

test('DS-T08: a TERMINAL tombstone carrying agent X does not block a fresh pending record from binding X', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'dispatchStateKey');
  const { dir, cleanup } = project();
  try {
    writeStateRaw(dir, `${DS.dispatchStateKey('toolu_tomb')}.json`, {
      schema: 1,
      tool_use_id: 'toolu_tomb',
      session_id: 's1',
      subagent_type: 'coder',
      origin: 'pre',
      prompt: null,
      prompt_bytes: 3,
      prompt_sha256: sha256('old'),
      post_binding: { agent_id: 'agent-X', at: '2026-09-01T00:00:00.000Z' },
      started: { agent_id: 'agent-X', at: '2026-09-01T00:00:01.000Z', by: ['h22'] },
      terminal: { at: '2026-09-01T00:10:00.000Z', reason: 'stop' },
    });
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_fresh' }));

    const r = await DS.recordDispatchPost(dir, POST({ tool_use_id: 'toolu_fresh', agentId: 'agent-X' }));
    const fresh = await recordFor(dir, 'toolu_fresh');
    assert.equal(
      fresh.post_binding?.agent_id,
      'agent-X',
      'the one-to-one rule protects LIVE uniqueness; a finished round cannot hold an agent id hostage (an agent id is reused across rounds by design — A4/§5(ii))'
    );
    assert.equal(r.ok, true, `the binding is not refused: ${JSON.stringify(r)}`);
    const tomb = await recordFor(dir, 'toolu_tomb');
    assert.equal(tomb.terminal.reason, 'stop', 'and the tombstone is not touched by the new binding');
  } finally {
    cleanup();
  }
});
// SABOTAGE: scan EVERY record (terminal included) for the agentId in the
// one-to-one check — the post_binding assertion goes red and every resumed
// agent's second round becomes permanently unattributable. DS-PO06 (two LIVE
// records) stays green under this sabotage, which is why the scope needs its
// own arm.

test('DS-T09: a record from ANOTHER session_id carrying agent X does not block either — one-to-one is session-scoped', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'dispatchStateKey');
  const { dir, cleanup } = project();
  try {
    writeStateRaw(dir, `${DS.dispatchStateKey('toolu_foreign')}.json`, {
      schema: 1,
      tool_use_id: 'toolu_foreign',
      session_id: 's0', // a DIFFERENT session, still non-terminal
      subagent_type: 'coder',
      origin: 'pre',
      prompt: null,
      prompt_bytes: 3,
      prompt_sha256: sha256('old'),
      post_binding: { agent_id: 'agent-X', at: '2026-09-07T00:00:00.000Z' },
    });
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_mine', session_id: 's1' }));

    const r = await DS.recordDispatchPost(dir, POST({ tool_use_id: 'toolu_mine', session_id: 's1', agentId: 'agent-X' }));
    assert.equal((await recordFor(dir, 'toolu_mine')).post_binding?.agent_id, 'agent-X', 'a foreign session is a different world — its bindings never constrain mine');
    assert.equal(r.ok, true, `the binding is not refused: ${JSON.stringify(r)}`);
    assert.equal((await recordFor(dir, 'toolu_foreign')).post_binding.agent_id, 'agent-X', "and the foreign record is left exactly as it was");
  } finally {
    cleanup();
  }
});
// SABOTAGE: run the one-to-one scan without the session_id filter — this goes
// red while DS-PO06 (same session) stays green. Note the SEPARATION from
// DS-PO07: a cross-session collision on the SAME KEY is condemned, while the
// same AGENT ID in two sessions is not a collision at all.

// --- (6) Stop must end the LIVE round, not the tombstone -----------------

test('DS-T10: with a terminal tombstone naming X AND a live started record for X, Stop tombstones the LIVE one and never reports the old tombstone as the hit', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'resolveAndRegisterStart', 'finishDispatchAndRegisterEnd', 'dispatchState', 'dispatchStateKey');
  const { dir, cleanup } = project();
  try {
    // The LIVE round first, so the resume guard cannot see the tombstone yet
    // (this is the honest ordering: the tombstone is round 1, already closed,
    // and it is present on disk by the time round 2 STOPS).
    const livePrompt = 'the live round brief';
    await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_live', tool_input: { subagent_type: 'coder', prompt: livePrompt, description: 'd' } }));
    await DS.recordDispatchPost(dir, POST({ tool_use_id: 'toolu_live', prompt: livePrompt, responsePrompt: livePrompt, agentId: 'agent-X' }));
    await DS.resolveAndRegisterStart(dir, START({ agent_id: 'agent-X' }), (resolution) => startEntry(resolution, { agent_id: 'agent-X' }));
    assert.equal(DS.dispatchState(await recordFor(dir, 'toolu_live')), 'started', 'sanity: the live round is started');

    writeStateRaw(dir, `${DS.dispatchStateKey('toolu_old')}.json`, {
      schema: 1,
      tool_use_id: 'toolu_old',
      session_id: 's1',
      subagent_type: 'coder',
      origin: 'pre',
      prompt: null,
      prompt_bytes: 3,
      prompt_sha256: sha256('old'),
      post_binding: { agent_id: 'agent-X', at: '2026-09-08T09:00:00.000Z' },
      started: { agent_id: 'agent-X', at: '2026-09-08T09:00:01.000Z', by: ['h22'] },
      terminal: { at: '2026-09-08T09:30:00.000Z', reason: 'stop' },
    });

    const r = await DS.finishDispatchAndRegisterEnd(dir, { session_id: 's1', agent_id: 'agent-X', event: 'subagent-stop' });

    const live = await recordFor(dir, 'toolu_live');
    assert.equal(DS.dispatchState(live), 'terminal', 'the LIVE record is the one closed');
    assert.equal(live.terminal.reason, 'stop');
    assert.equal(live.prompt, null, 'and its brief is dropped');
    const old = await recordFor(dir, 'toolu_old');
    assert.equal(old.terminal.at, '2026-09-08T09:30:00.000Z', 'the earlier tombstone is not re-stamped');
    assert.notEqual(
      r?.record?.tool_use_id,
      'toolu_old',
      'the operation must not RETURN the tombstone as its hit — a caller acting on that id would report the wrong dispatch as just-finished'
    );
    if (r?.record) assert.equal(r.record.tool_use_id, 'toolu_live', 'the hit is the live record');
  } finally {
    cleanup();
  }
});
// SABOTAGE: locate the record at Stop by scanning for the agent id and taking
// the FIRST match (readdir order) without excluding terminal records — the
// live record stays 'started' with its prompt readable for 7 days, so the
// terminal/prompt assertions go red; and DS-FE01 (a single record, no
// tombstone) stays green under that sabotage, which is why this arm exists.

// ===========================================================================
// REVIEW ROUND 3 — holes the Codex review added (coordinator, 2026-09-08).
// Same style, named sabotage each; RED by construction while the surface is
// absent (requireOwner fails each on its own assertion).
// ===========================================================================

// --- (7) an unusable agent_id is its own fail-closed case -----------------
//
// §6 fences a missing agent_TYPE ('no-agent-type'). Nothing fenced a missing
// or non-string agent_ID, and that is the more dangerous half: the id is what
// a binding is WRITTEN WITH, so a derivation committed for `undefined` would
// mint a record bound to nobody, permanently consuming a real dispatch's slot.

for (const [label, agentId] of [['undefined', undefined], ['empty string', ''], ['non-string', 42]]) {
  test(`DS-T11 (agent_id ${label}): a Start with an unusable agent_id is unattributable 'no-agent-id', and the pending record is BYTE-IDENTICAL afterwards`, async () => {
    requireOwner('recordDispatchPre', 'resolveDispatchStart');
    const { dir, cleanup } = project();
    try {
      // Exactly ONE pending record of this type: without the guard this Start
      // would derive it (DS-R06), so a green here can only be the guard.
      await DS.recordDispatchPre(dir, PRE({ tool_use_id: 'toolu_only' }));
      const before = stateFiles(dir).map((f) => readFileSync(join(stateDir(dir), f), 'utf8'));

      const start = START({ agent_id: agentId, agent_type: 'coder' });
      if (agentId === undefined) delete start.agent_id;
      const res = await DS.resolveDispatchStart(dir, start, { consumer: 'h22' });

      assert.equal(res.source, 'unattributable');
      assert.equal(res.case, 'no-agent-id', `an unusable agent_id (${label}) is its OWN case — never silently folded into no-slot, and never a derivation`);
      assert.equal(res.prompt, null, 'no prompt is handed to an unidentifiable spawn');
      assert.deepEqual(
        stateFiles(dir).map((f) => readFileSync(join(stateDir(dir), f), 'utf8')),
        before,
        'nothing is consumed: the slot stays derivable for the spawn that really owns it'
      );
    } finally {
      cleanup();
    }
  });
}
// SABOTAGE: derive first and write `derived_binding.agent_id = stdin.agent_id`
// without validating it — the byte-identical assertion goes red and the slot
// is burned on a binding no later Start can ever match (`undefined`,
// `''` or `42` never equals a real agent id), which is a permanent
// unattributable for the real child. DS-R19 (no agent_TYPE) stays green under
// this sabotage: the two guards are independent.

// --- (8) a STRUCTURALLY BROKEN sub-object is poison, not a state ----------
//
// dispatchState() derives from the PRESENCE of `post_binding`/`started`/
// `terminal`. A presence check alone reads `post_binding: {}` as BOUND and
// `terminal: 'yes'` as TERMINAL — so a half-written or hand-edited record
// silently removes a live slot from derivation (or, worse, resolves as
// somebody's binding with `agent_id === undefined`). Each shape gets its own
// arm because each is a different missing validation.

const BROKEN_SHAPES = [
  ['post_binding is an empty object', { post_binding: {} }],
  ['started is an empty object', { started: {} }],
  ['terminal is a string, not an object', { terminal: 'yes' }],
  ['derived_binding carries no agent_id', { derived_binding: { at: '2026-09-08T09:00:00.000Z', by: 'h22' } }],
];

for (const [label, broken] of BROKEN_SHAPES) {
  test(`DS-T12 (${label}): the record is reported POISONED — never read as bound/started/terminal, and never a derivation candidate`, async () => {
    requireOwner('readDispatchState', 'resolveDispatchStart', 'dispatchStateKey', 'recordDispatchPre');
    const { dir, cleanup } = project();
    try {
      const prompt = 'a structurally broken record';
      writeStateRaw(dir, `${DS.dispatchStateKey('toolu_broken')}.json`, {
        schema: 1,
        tool_use_id: 'toolu_broken',
        session_id: 's1',
        subagent_type: 'coder',
        origin: 'pre',
        prompt,
        prompt_bytes: Buffer.byteLength(prompt, 'utf8'),
        prompt_sha256: sha256(prompt),
        ...broken,
      });

      const st = await DS.readDispatchState(dir);
      assert.ok(
        (st.poisoned ?? []).some((p) => typeof p.file === 'string' && p.file.includes('toolu_broken')),
        `the broken record is enumerated as poison, naming its file: ${JSON.stringify(st.poisoned)}`
      );
      assert.ok(
        !(st.records ?? []).some((x) => x.record?.tool_use_id === 'toolu_broken'),
        'a record that cannot be validated is NOT served as a readable record — that is what "poisoned" means'
      );

      const res = await DS.resolveDispatchStart(dir, START(), { consumer: 'h22' });
      assert.equal(res.source, 'unattributable');
      assert.equal(res.case, 'state-poisoned', 'and derivation refuses for the whole session, because an unvalidatable record may be my own same-type sibling');
    } finally {
      cleanup();
    }
  });
}
// SABOTAGE: derive state by presence alone (`if (record.terminal) return
// 'terminal'` / `if (record.post_binding) return 'bound'`) with no shape
// validation — every arm's poisoned assertion goes red, and the empty-object
// arms additionally become resolvable bindings for `agent_id === undefined`.
// Which guard carries the verdict: ONE — validateRecordShape ahead of
// dispatchState; the four arms differ only in the field it must reject.

// --- (9) a FOREIGN-SESSION binding for my agent_id is a RESUME, not a hit --
//
// §5(i) matches a record whose post_binding.agent_id is mine; §5(ii) says the
// resume guard runs BEFORE any derivation. Nothing pinned the ORDER of (i)
// against (ii) for a NON-TERMINAL foreign-session record — which is exactly
// what a resumed agent from a previous session looks like before that session's
// sweep ever ran (an aborted process, a crashed session). Read as a 'post' hit,
// the resumed agent would be handed a DEAD session's brief and H19's delivery
// guard would make it permanent.

test('DS-T13: a NON-TERMINAL record from ANOTHER session carrying my agent_id in post_binding resolves as RESUME, never as a post hit, and mutates nothing', async () => {
  requireOwner('resolveDispatchStart', 'dispatchStateKey', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    const foreignPrompt = 'a brief from a session that never swept';
    writeStateRaw(dir, `${DS.dispatchStateKey('toolu_prev')}.json`, {
      schema: 1,
      tool_use_id: 'toolu_prev',
      session_id: 's0', // NOT my session, and NOT terminal
      subagent_type: 'coder',
      origin: 'pre',
      prompt: foreignPrompt,
      prompt_bytes: Buffer.byteLength(foreignPrompt, 'utf8'),
      prompt_sha256: sha256(foreignPrompt),
      post_binding: { agent_id: 'agent-1', at: '2026-09-07T00:00:00.000Z' },
    });
    const before = stateFiles(dir).map((f) => readFileSync(join(stateDir(dir), f), 'utf8'));

    const res = await DS.resolveDispatchStart(dir, START({ agent_id: 'agent-1' }), { consumer: 'h19' });
    assert.equal(res.source, 'resume', "§5(i) is scoped to MY session; a foreign session's binding for my agent_id is resume evidence, not my dispatch");
    assert.notEqual(res.prompt, foreignPrompt, "a dead session's brief is never staged into this spawn");
    assert.deepEqual(
      stateFiles(dir).map((f) => readFileSync(join(stateDir(dir), f), 'utf8')),
      before,
      'a resume consumes nothing and rewrites nothing — the foreign record is left exactly as found'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: run §5(i)'s my-binding scan without a session_id filter (or before
// the resume guard) — source reads 'post', the prompt assertion goes red, and
// the record gains a `started` entry so the byte-identical assertion goes red
// too. DS-R01 (same session) stays green under this sabotage.

// --- (10) the Post binding needs BOTH prompts and a session --------------
//
// DS-PO04 pins a prompt DISAGREEMENT. Nothing pinned an ABSENT or non-string
// tool_response.prompt: §2 requires `tool_input.prompt === tool_response.prompt`
// "when both are strings", and a naive `a === b` over two undefineds is TRUE —
// so a malformed Post would bind on a comparison that verified nothing.

for (const [label, over] of [
  ['tool_response.prompt absent', { responsePrompt: undefined, dropResponsePrompt: true }],
  ['tool_response.prompt a non-string', { responsePrompt: 42 }],
]) {
  test(`DS-T14 (${label}): the Post refuses to bind, the record stays pending, and the refusal names dispatch_post_refused`, async () => {
    requireOwner('recordDispatchPre', 'recordDispatchPost', 'dispatchState');
    const { dir, cleanup } = project();
    try {
      await DS.recordDispatchPre(dir, PRE());
      const stdin = POST({ agentId: 'agent-1' });
      if (over.dropResponsePrompt) delete stdin.tool_response.prompt;
      else stdin.tool_response.prompt = over.responsePrompt;

      const r = await DS.recordDispatchPost(dir, stdin);
      const rec = await soleRecord(dir);
      assert.equal(rec.post_binding, undefined, 'an unverifiable prompt is not a verified prompt — undefined === undefined must not read as agreement');
      assert.equal(DS.dispatchState(rec), 'pending', 'the slot stays derivable; a malformed Post is not evidence against it');
      assert.match(disclosureText(r), /dispatch_post_refused/, 'the refusal carries its closed-set code, never a silent skip');
    } finally {
      cleanup();
    }
  });
}
// SABOTAGE: compare the two prompts with a bare `===` and no string check —
// the absent-prompt arm binds (post_binding assertion red) while DS-PO04's
// disagreeing-strings arm stays green, which is why the absent case needs its
// own arm.

test('DS-T15: a Post with NO session_id refuses to bind — a binding that cannot be session-scoped is not a binding', async () => {
  requireOwner('recordDispatchPre', 'recordDispatchPost', 'dispatchState');
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE({ session_id: 's1' }));
    const stdin = POST({ agentId: 'agent-1' });
    delete stdin.session_id;

    const r = await DS.recordDispatchPost(dir, stdin);
    const rec = await soleRecord(dir);
    assert.equal(rec.post_binding, undefined, 'DS-PO07 condemns a MISMATCHED session; an ABSENT one cannot even be compared, so it fails closed too');
    assert.equal(DS.dispatchState(rec), 'pending', 'and it is not condemned either — an unusable Post says nothing about the slot');
    assert.match(disclosureText(r), /dispatch_post_refused/, 'disclosed by code');
  } finally {
    cleanup();
  }
});
// SABOTAGE: treat a missing session_id as "no mismatch found" and bind — the
// post_binding assertion goes red, and the cross-session key-reuse defence
// DS-PO07 exists for is bypassed simply by omitting a field.

// --- (11) the FILE NAME must agree with the record it holds --------------
//
// The key IS the index: resolution, the one-to-one scan and the Stop lookup all
// address records by their key. A file whose name does not derive from its own
// tool_use_id means two writers can disagree about where a dispatch lives — and
// a hand-planted `raw-victim.json` would be served as a real slot while the
// writer for `victim` writes elsewhere.

test('DS-T16: a file whose NAME does not match its record\'s tool_use_id is poisoned and is never a derivation candidate', async () => {
  requireOwner('readDispatchState', 'resolveDispatchStart', 'dispatchStateKey');
  const { dir, cleanup } = project();
  try {
    const prompt = 'a planted record under the wrong name';
    // Name says `victim`; the record inside says `toolu_other`.
    writeStateRaw(dir, 'raw-victim.json', {
      schema: 1,
      tool_use_id: 'toolu_other',
      session_id: 's1',
      subagent_type: 'coder',
      origin: 'pre',
      prompt,
      prompt_bytes: Buffer.byteLength(prompt, 'utf8'),
      prompt_sha256: sha256(prompt),
    });

    const st = await DS.readDispatchState(dir);
    assert.ok(
      (st.poisoned ?? []).some((p) => typeof p.file === 'string' && p.file.includes('raw-victim')),
      `the name/id disagreement is reported as poison: ${JSON.stringify(st.poisoned)}`
    );
    const res = await DS.resolveDispatchStart(dir, START(), { consumer: 'h22' });
    assert.equal(res.case, 'state-poisoned');
    assert.notEqual(res.prompt, prompt, 'a record found under a name it does not own is never handed to a spawn');
  } finally {
    cleanup();
  }
});

test('DS-T17: a sha256-named file whose hash does not match its own tool_use_id is poisoned too', async () => {
  requireOwner('readDispatchState', 'resolveDispatchStart');
  const { dir, cleanup } = project();
  try {
    const prompt = 'a planted record under a wrong hashed name';
    // 'toolu_ok' is a SAFE id, so its key would be `raw-toolu_ok` — a
    // sha256-named file claiming it is doubly wrong: wrong namespace AND a
    // hash of nothing.
    writeStateRaw(dir, `sha256-${'0'.repeat(64)}.json`, {
      schema: 1,
      tool_use_id: 'toolu_ok',
      session_id: 's1',
      subagent_type: 'coder',
      origin: 'pre',
      prompt,
      prompt_bytes: Buffer.byteLength(prompt, 'utf8'),
      prompt_sha256: sha256(prompt),
    });

    const st = await DS.readDispatchState(dir);
    assert.ok((st.poisoned ?? []).length > 0, `the mis-hashed name is reported as poison: ${JSON.stringify(st.poisoned)}`);
    const res = await DS.resolveDispatchStart(dir, START(), { consumer: 'h22' });
    assert.equal(res.case, 'state-poisoned');
    assert.notEqual(res.prompt, prompt);
  } finally {
    cleanup();
  }
});
// SABOTAGE (DS-T16/DS-T17 as a pair): read every `*.json` in the directory and
// trust its CONTENT, deriving the key only when WRITING — both arms' poisoned
// assertions go red. A single arm would not distinguish "the name is not
// re-derived at all" from "only the raw namespace is checked", which is why
// both namespaces are exercised. DS-K04 (two correctly-named records) stays
// green under this sabotage.
