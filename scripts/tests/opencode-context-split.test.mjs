// The OpenCode session context split (user-ruled 2026-10-12, "Move live lines out"; finding
// why-is-the-prompt-cache-hit-rate-lower-on-opencode-codeburn): the system prompt carries only
// stable Sterling text, and the lines that change (status, board readiness, notices, ...) are
// sent to the session as a hidden synthetic message (GitHub #93) when they changed since that
// session last got them; without ctx.session.synthetic they are appended to the prompt.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-10-12T12:00:00.000Z';

let SterlingStore;
let contextMod;
let notices;
let staging;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  contextMod = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'context.mjs')).href);
  notices = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'notices.mjs')).href);
  staging = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'staging.mjs')).href);
});

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-split-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'fixture-proj' }));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  return dir;
}

function addTodo(dir, text) {
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    store.create({ id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], text, source: 'user' });
  } finally {
    store.close();
  }
}

/**
 * A context handler for `dir` whose sessions are ses_root (a root) and ses_child (its child).
 * Its ctx.session.synthetic records each call in `h.synthetic` (OpenCode 2.0.23's hidden
 * message route); `opts.synthetic: null` leaves it out (an older OpenCode) and a function
 * replaces it.
 */
function handler(dir, extra = {}, { synthetic } = {}) {
  const sessions = { ses_root: {}, ses_other: {}, ses_child: { parentID: 'ses_root' } };
  const calls = [];
  const session = { get: async ({ sessionID }) => ({ id: sessionID, ...sessions[sessionID] }) };
  if (synthetic !== null) session.synthetic = async (arg) => (synthetic ? synthetic(arg) : void calls.push(arg));
  const h = contextMod.createContextHandler({
    openStore: (p) => new SterlingStore(p),
    now: () => NOW,
    rootOf: () => dir,
    fenced: async (_name, _root, fn) => fn(),
    rotationRestore: async () => '',
    sessionSync: async () => {},
    pluginRoot: repo,
    getSession: () => session,
    ...extra,
  });
  h.synthetic = calls;
  return h;
}

const contextInput = (sessionID) => ({ sessionID, agent: 'build', system: [{ type: 'text', text: 'base' }], messages: [], tools: {} });
const systemOf = (i) => i.system.map((p) => p.text).join('\n');

/**
 * What onPrompt delivered for a prompt of `sessionID` ('' when nothing): the text of the synthetic
 * messages it sent. The user's prompt text must come out untouched, and a synthetic call carries
 * no description and metadata.source 'sterling' (hidden in the TUI and the web app, GitHub #93).
 */
async function appended(h, sessionID) {
  const before = h.synthetic.length;
  const input = { sessionID, messageID: 'msg_u', prompt: { text: 'go' }, delivery: 'immediate' };
  await h.onPrompt(input);
  assert.equal(input.prompt.text, 'go', 'the user\'s prompt text is untouched');
  const sent = h.synthetic.slice(before).filter((c) => c.sessionID === sessionID);
  for (const c of sent) {
    assert.deepEqual(c.metadata, { source: 'sterling' });
    assert.equal('description' in c, false, 'no description, or the message is shown');
    assert.equal(c.delivery, undefined, 'the prompt route sends no delivery');
  }
  return sent.map((c) => c.text).join('\n');
}

/** The old route, for a handler without ctx.session.synthetic: the text onPrompt appended to the prompt ('' when nothing). */
async function appendedToPrompt(h, sessionID) {
  const input = { sessionID, messageID: 'msg_u', prompt: { text: 'go' }, delivery: 'immediate' };
  await h.onPrompt(input);
  return input.prompt.text === 'go' ? '' : input.prompt.text.slice('go\n\n'.length);
}

test('the system prompt is the same bytes on every request while the board, status and notices change', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir);
    const first = contextInput('ses_root');
    await h.onContext(first);
    assert.match(systemOf(first), /Sterling layer\)/, 'the layer is in the system prompt');
    assert.doesNotMatch(systemOf(first), /STERLING STATUS|BOARD READINESS|STERLING NOTICES|TDD posture/, 'no live line is in the system prompt');

    addTodo(dir, 'a new user ask');
    notices.addNotice(dir, 'NOTICE-SPLIT-1', NOW);
    h.resetStatus(dir);
    const delivered = await appended(h, 'ses_root');
    assert.match(delivered, /STERLING STATUS: board 1 open/);
    assert.match(delivered, /BOARD READINESS/);
    assert.match(delivered, /NOTICE-SPLIT-1/);

    const second = contextInput('ses_root');
    await h.onContext(second);
    assert.equal(systemOf(second), systemOf(first), 'byte-identical across requests');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed line reaches the next prompt exactly once, and an unchanged state appends nothing', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir);
    const opening = await appended(h, 'ses_root');
    assert.ok(opening.startsWith(`${staging.VOLATILE_HEADER}\n\n`), 'the appended block is marked as the plugin\'s, not the user\'s');
    assert.match(opening, /STERLING STATUS: board 0 open/, 'the first prompt of a session gets the current set');
    assert.match(opening, /TDD posture/);
    assert.equal(await appended(h, 'ses_root'), '', 'nothing changed: nothing appended');

    addTodo(dir, 'first ask');
    h.resetStatus(dir);
    const changed = await appended(h, 'ses_root');
    assert.match(changed, /STERLING STATUS: board 1 open/);
    assert.match(changed, /READY \(1\):\n- first ask/);
    assert.doesNotMatch(changed, /TDD posture/, 'an unchanged line is not repeated beside a changed one');
    h.resetStatus(dir);
    assert.equal(await appended(h, 'ses_root'), '', 'the same change is not delivered twice');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a line that goes empty after it was shown is said to be cleared, once', async () => {
  const dir = makeProject();
  try {
    addTodo(dir, 'only ask');
    const h = handler(dir);
    assert.match(await appended(h, 'ses_root'), /READY \(1\)/);
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    try {
      for (const r of store.query({ types: ['todo'] })) store.remove(r.id, NOW);
    } finally {
      store.close();
    }
    h.resetStatus(dir);
    const cleared = await appended(h, 'ses_root');
    assert.match(cleared, /BOARD READINESS: no user item is ready, waiting or blocked now/);
    h.resetStatus(dir);
    assert.equal(await appended(h, 'ses_root'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// GitHub #93: a block whose meaningful content did not change is not sent again.
test('the board block is not re-delivered when only the live-lane count changed, and is when the READY list changes', async () => {
  const dir = makeProject();
  try {
    addTodo(dir, 'first ask');
    const reg = await import(pathToFileURL(join(repo, 'scripts', 'lib', 'dispatch-register.mjs')).href);
    const h = handler(dir);
    assert.match(await appended(h, 'ses_root'), /live lanes 0\/\d+.*\n[\s\S]*READY \(1\):\n- first ask/);
    await reg.registerStart(dir, { agent_id: 'lane-a', agent_type: 'implementor', session_id: 'ses_root', files: [], tool_use_id: null, at: new Date().toISOString() });
    h.resetStatus(dir);
    assert.doesNotMatch(await appended(h, 'ses_root'), /BOARD READINESS/, 'a lane start alone sends no board block');
    addTodo(dir, 'second ask');
    h.resetStatus(dir);
    const changed = await appended(h, 'ses_root');
    assert.match(changed, /live lanes 1\/\d+/, 'a changed list is sent with the current lane count');
    assert.match(changed, /READY \(2\):/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the maintenance block is not re-delivered when only its age changed, and is when the backlog changes', async (t) => {
  const dir = makeProject();
  try {
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const sysItem = (reason) => store.create({
      id: randomUUID(), type: 'todo', created_at: '2026-10-01T12:00:00.000Z', updated_at: NOW, author: 'system', status: 'active', superseded_by: null,
      links: [], scope: 'project', stack_tags: [], text: `item ${reason}`, source: 'system', system_reason: reason, file_keys: ['src/a.mjs'],
    });
    sysItem('reconcile_needed');
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-12T12:00:00.000Z') });
    const h = handler(dir);
    const first = await appended(h, 'ses_root');
    assert.match(first, /RECONCILE BACKLOG: 1 item in lane reconcile_needed.*\(11d 0h\)/);
    t.mock.timers.tick(5 * 3600 * 1000);
    h.resetStatus(dir);
    assert.doesNotMatch(await appended(h, 'ses_root'), /RECONCILE BACKLOG/, 'five hours older: not sent again');
    sysItem('reconcile_needed');
    h.resetStatus(dir);
    const changed = await appended(h, 'ses_root');
    assert.match(changed, /RECONCILE BACKLOG: 2 items in lane reconcile_needed.*\(11d 5h\)/, 'a count change is sent with the current age');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a keyed notice is shown once per session however its wording changes, and again after a compaction', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir);
    const settle = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'settle.mjs')).href);
    const held = (why) => notices.addNotice(dir, `Sterling settlement: the settled snapshot was not advanced because ${why}; the first settlement after the dispatch ends advances it.`, NOW, settle.heldKey(why));
    held('1 dispatch(es) still registered (agent-a)');
    assert.match(await appended(h, 'ses_root'), /not advanced because 1 dispatch\(es\) still registered \(agent-a\)/);
    notices.pruneShownNotices(dir);
    held('2 dispatch(es) still registered (agent-a, agent-b)');
    assert.doesNotMatch(await appended(h, 'ses_root'), /not advanced/, 'the same notice with another count and ids is not shown again');
    notices.pruneShownNotices(dir);
    held('the dispatch register is corrupt');
    assert.match(await appended(h, 'ses_root'), /not advanced because the dispatch register is corrupt/, 'a different cause is a different notice');

    const prKey = (armed) => `pr-loop-owed:7:${armed}`;
    notices.addNotice(dir, '• PR review loop owed (work mode): PR #7 full text', NOW, prKey('2026-09-26T10:00:00.000Z'));
    assert.match(await appended(h, 'ses_root'), /PR review loop owed \(work mode\)/);
    notices.pruneShownNotices(dir);
    notices.addNotice(dir, 'PR review loop owed: PR #7 reminder', NOW, prKey('2026-09-26T10:00:00.000Z'));
    assert.doesNotMatch(await appended(h, 'ses_root'), /PR review loop owed/, 'the reminder of the same arming is not shown again');
    notices.pruneShownNotices(dir);
    notices.addNotice(dir, 'PR review loop owed: PR #7 re-armed', NOW, prKey('2026-09-27T10:00:00.000Z'));
    assert.match(await appended(h, 'ses_root'), /PR #7 re-armed/, 'a re-arm is a new notice');

    h.resetSession('ses_root');
    notices.pruneShownNotices(dir);
    held('1 dispatch(es) still registered (agent-a)');
    assert.match(await appended(h, 'ses_root'), /not advanced because 1 dispatch/, 'after a compaction the conversation is new, so it is shown again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the lines go out as one hidden synthetic message: no description, source sterling, header kept, user text untouched', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir);
    const input = { sessionID: 'ses_root', messageID: 'msg_u', prompt: { text: 'go' }, delivery: 'immediate' };
    await h.onPrompt(input);
    assert.equal(input.prompt.text, 'go');
    assert.equal(h.synthetic.length, 1);
    const [call] = h.synthetic;
    assert.deepEqual(Object.keys(call).sort(), ['metadata', 'sessionID', 'text']);
    assert.deepEqual(call.metadata, { source: 'sterling' });
    assert.ok(call.text.startsWith(`${staging.VOLATILE_HEADER}\n\n`));
    assert.match(call.text, /STERLING STATUS: board 0 open/);
    assert.doesNotMatch(call.text, /STERLING DELIVERY DEGRADED/);
    addTodo(dir, 'mid-turn ask');
    h.resetStatus(dir);
    await toolAppended(h, 'ses_root');
    assert.deepEqual(h.synthetic.at(-1).delivery, 'steer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a synthetic call that throws falls back to the old append with a degraded note once per session, and the lines are delivered once', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir, {}, { synthetic: async () => { throw new Error('synthetic refused'); } });
    const first = await appendedToPrompt(h, 'ses_root');
    assert.match(first, /STERLING STATUS: board 0 open/, 'nothing is lost');
    assert.match(first, /STERLING DELIVERY DEGRADED \(synthetic refused\)/, 'the degraded path says so');
    assert.equal(await appendedToPrompt(h, 'ses_root'), '', 'the fallback append delivered the lines, so they are not due again');
    addTodo(dir, 'next ask');
    h.resetStatus(dir);
    const next = await appendedToPrompt(h, 'ses_root');
    assert.match(next, /READY \(1\):\n- next ask/);
    assert.doesNotMatch(next, /DEGRADED/, 'the note is said once per session');
    // The tool route falls back the same way, appending to the result.
    addTodo(dir, 'third ask');
    h.resetStatus(dir);
    const input = { tool: 'read', sessionID: 'ses_other', id: 'call_1', input: { path: 'x' }, status: 'completed', result: { content: [{ type: 'text', text: 'tool output' }] } };
    await h.onToolResult(input);
    assert.deepEqual(input.result.content[0], { type: 'text', text: 'tool output' });
    const text = input.result.content.slice(1).map((p) => p.text).join('\n');
    assert.match(text, /STERLING STATUS: board 2 open/);
    assert.match(text, /STERLING DELIVERY DEGRADED \(synthetic refused\)/, 'a session of its own is told once too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after a compaction a working synthetic call sends the set again, without the degraded note', async () => {
  const dir = makeProject();
  try {
    let fail = true;
    const sent = [];
    const h = handler(dir, {}, { synthetic: async (c) => { if (fail) throw new Error('boom'); sent.push(c); } });
    assert.match(await appendedToPrompt(h, 'ses_root'), /STERLING STATUS/);
    fail = false;
    h.resetSession('ses_root');
    await h.onPrompt({ sessionID: 'ses_root', messageID: 'msg_u', prompt: { text: 'go' }, delivery: 'immediate' });
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].text, /DEGRADED/, 'the note lives in the conversation that was replaced');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without ctx.session.synthetic (an older OpenCode) the lines are appended, with the degraded note once per session', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir, {}, { synthetic: null });
    const first = await appendedToPrompt(h, 'ses_root');
    assert.match(first, /STERLING STATUS: board 0 open/);
    assert.match(first, /STERLING DELIVERY DEGRADED \(ctx\.session\.synthetic is unavailable/);
    addTodo(dir, 'another ask');
    h.resetStatus(dir);
    const second = await appendedToPrompt(h, 'ses_root');
    assert.match(second, /READY \(1\)/);
    assert.doesNotMatch(second, /DEGRADED/);
    const tool = { tool: 'edit', sessionID: 'ses_root', id: 'call_2', input: { path: 'x' }, status: 'completed', result: { content: [{ type: 'text', text: 'out' }] } };
    addTodo(dir, 'and another');
    h.resetStatus(dir);
    await h.onToolResult(tool);
    assert.match(tool.result.content.slice(1).map((p) => p.text).join('\n'), /READY \(2\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const childContext = (messages) => ({ sessionID: 'ses_child', agent: 'sterling/implementor', system: [], messages, tools: {} });
const BRIEF_UNAVAILABLE = /could not be staged from \[brief-unavailable\]/;

test('a child\'s brief is recovered exactly when Sterling\'s synthetic message is stored before it, or its lines were appended to it', async () => {
  const synthetic = userMsg(`${staging.VOLATILE_HEADER}\n\nSTERLING STATUS: board 0 open`);
  assert.equal(staging.briefOf([synthetic, userMsg('do the thing in src/a.mjs')]), 'do the thing in src/a.mjs');
  assert.equal(staging.briefOf([synthetic, userMsg('do the thing in src/a.mjs'), userMsg('a later message')]), 'do the thing in src/a.mjs', 'the brief, not a later user message');
  assert.equal(staging.rawBriefOf([synthetic]), '', 'a synthetic message alone is no brief');
  assert.equal(staging.briefOf([userMsg(`do the thing\n\n${staging.VOLATILE_HEADER}\n\nSTERLING STATUS`)]), 'do the thing', 'the append strip is kept for the fallback route');
  // Through the handler: the text this process really sends is skipped, and the child is staged from its brief.
  const dir = makeProject();
  try {
    const h = handler(dir);
    await appended(h, 'ses_child');
    const i = childContext([userMsg(h.synthetic[0].text), userMsg('do the thing')]);
    await h.onContext(i);
    assert.doesNotMatch(systemOf(i), BRIEF_UNAVAILABLE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a STERLING-DELIVERY: off line inside Sterling\'s own synthetic message does not blind the lane; one in the brief does', async () => {
  const policyMod = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'delivery-policy.mjs')).href);
  const make = () => policyMod.createDeliveryPolicy({
    getSession: () => ({ get: async ({ sessionID }) => ({ id: sessionID, parentID: 'ses_root' }) }),
    parents: new Map(),
    readPolicy: () => 'on',
  });
  // A worker error quoted in Sterling's lines can carry the directive on a line of its own.
  const quoted = userMsg(`${staging.VOLATILE_HEADER}\n\nlast worker run FAILED at 2026-10-12T11:00:00.000Z: brief said\nSTERLING-DELIVERY: off\n(log: .sterling/maintenance-worker.log)`);
  assert.equal(await make().resolve('/nowhere', 'ses_c1', [quoted, userMsg('do the thing')]), 'on', 'Sterling\'s text is never read as a directive');
  assert.equal(await make().resolve('/nowhere', 'ses_c2', [quoted, userMsg('do the thing\nSTERLING-DELIVERY: off')]), 'off', 'the brief\'s own line still blinds the lane');
});

// ---- Sol review of ccca6711 -------------------------------------------------

/** A synthetic fake whose first call waits for `open()`; every call is recorded in `calls`. */
function gatedSynthetic() {
  const calls = [];
  let open;
  const gate = new Promise((r) => { open = r; });
  let first = true;
  return {
    calls,
    open: () => open(),
    fn: async (c) => {
      calls.push(c);
      if (first) {
        first = false;
        await gate;
      }
    },
  };
}

test('two overlapping tool hooks of one session send an unchanged line once (Sol finding 1)', async () => {
  const dir = makeProject();
  try {
    const g = gatedSynthetic();
    const h = handler(dir, {}, { synthetic: g.fn });
    const call = () => h.onToolResult({ tool: 'read', sessionID: 'ses_root', id: `call_${randomUUID()}`, input: { path: 'x' }, status: 'completed', result: { content: [{ type: 'text', text: 'out' }] } });
    const a = call();
    await new Promise((r) => setTimeout(r, 20));
    const b = call();
    await new Promise((r) => setTimeout(r, 20));
    g.open();
    await Promise.all([a, b]);
    assert.equal(g.calls.filter((c) => /STERLING STATUS/.test(c.text)).length, 1, 'STERLING STATUS went out once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a notice is not lost when both the synthetic call and the fallback append fail (Sol finding 2)', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir, {}, { synthetic: async () => { throw new Error('synthetic failed'); } });
    notices.addNotice(dir, 'NOTICE-KEEP', NOW);
    const failing = { sessionID: 'ses_root', messageID: 'msg_u', delivery: 'immediate', prompt: {} };
    Object.defineProperty(failing.prompt, 'text', { get: () => 'go', set: () => { throw new Error('append failed'); }, enumerable: true });
    await assert.rejects(h.onPrompt(failing), /append failed/);
    const left = JSON.parse(readFileSync(join(dir, notices.NOTICES_REL), 'utf8'));
    assert.deepEqual(left.map((n) => [n.text, n.shown_at, n.claim]), [['NOTICE-KEEP', undefined, undefined]], 'not stamped shown, and the claim was released');
    notices.pruneShownNotices(dir);
    const next = handler(dir);
    assert.match(await appended(next, 'ses_root'), /NOTICE-KEEP/, 'settlement kept it and the next delivery shows it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a notice claimed by a delivery in flight is not offered to another, and a claim from a dead delivery expires', () => {
  const dir = makeProject();
  try {
    notices.addNotice(dir, 'NOTICE-C', NOW);
    const a = notices.claimNotices(dir, NOW);
    assert.deepEqual(a.notices.map((n) => n.text), ['NOTICE-C']);
    assert.deepEqual(notices.claimNotices(dir, NOW).notices, [], 'claimed: not offered twice');
    const later = new Date(Date.parse(NOW) + notices.NOTICE_CLAIM_TTL_MS).toISOString();
    assert.deepEqual(notices.claimNotices(dir, later).notices.map((n) => n.text), ['NOTICE-C'], 'a stale claim is offered again: a repeat, never a loss');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a delivery in flight across a compaction does not mark the new conversation delivered (Sol finding 3)', async () => {
  const dir = makeProject();
  try {
    const g = gatedSynthetic();
    const h = handler(dir, {}, { synthetic: g.fn });
    const pending = h.onPrompt({ sessionID: 'ses_root', messageID: 'msg_u', prompt: { text: 'go' }, delivery: 'immediate' });
    await new Promise((r) => setTimeout(r, 20));
    h.resetSession('ses_root');
    g.open();
    await pending;
    await h.onPrompt({ sessionID: 'ses_root', messageID: 'msg_v', prompt: { text: 'go' }, delivery: 'immediate' });
    assert.equal(g.calls.length, 2, 'the prompt after the compaction got the set again');
    assert.match(g.calls[1].text, /STERLING STATUS: board 0 open/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the board block is re-delivered when the dispatch register turns unreadable or the lane ceiling changes (Sol finding 4)', async () => {
  const dir = makeProject();
  try {
    addTodo(dir, 'an ask');
    const reg = await import(pathToFileURL(join(repo, 'scripts', 'lib', 'dispatch-register.mjs')).href);
    const h = handler(dir);
    assert.match(await appended(h, 'ses_root'), /live lanes 0\/\d+/);
    mkdirSync(dirname(reg.registerPath(dir)), { recursive: true });
    writeFileSync(reg.registerPath(dir), '{ not json');
    h.resetStatus(dir);
    assert.match(await appended(h, 'ses_root'), /live lanes \? \(dispatch register [a-z]+\)/, 'an unreadable register is said');
    rmSync(reg.registerPath(dir));
    h.resetStatus(dir);
    assert.match(await appended(h, 'ses_root'), /live lanes 0\/\d+/, 'and so is its recovery');
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'fixture-proj', delegation: { max_concurrent: 7 } }));
    h.resetStatus(dir);
    assert.match(await appended(h, 'ses_root'), /live lanes 0\/7/, 'a new ceiling is said');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the maintenance block is re-delivered when the last worker run failed, and when it recovers (Sol finding 5)', async () => {
  const dir = makeProject();
  try {
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    store.create({
      id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'system', status: 'active', superseded_by: null,
      links: [], scope: 'project', stack_tags: [], text: 'item', source: 'system', system_reason: 'reconcile_needed', file_keys: ['src/a.mjs'],
    });
    store.close();
    const h = handler(dir);
    assert.match(await appended(h, 'ses_root'), /RECONCILE BACKLOG/);
    const statePath = join(dir, '.sterling', 'transient', 'maintenance-worker.state.json');
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ last_run: { ok: false, at: '2026-10-12T11:00:00.000Z', error: 'mcp not connected' } }));
    h.resetStatus(dir);
    assert.match(await appended(h, 'ses_root'), /last worker run FAILED at 2026-10-12T11:00:00\.000Z: mcp not connected/);
    writeFileSync(statePath, JSON.stringify({ last_run: { ok: true, at: '2026-10-12T11:30:00.000Z', verdicts: 1 } }));
    h.resetStatus(dir);
    const recovered = await appended(h, 'ses_root');
    assert.match(recovered, /RECONCILE BACKLOG/, 'the recovery is said');
    assert.doesNotMatch(recovered, /FAILED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Sol re-check of fee7d5f0 ------------------------------------------------

/** Lets pending microtasks and immediates run: a delivery that is not stuck settles within these rounds. */
async function settled(p) {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let n = 0; n < 20 && !done; n++) await new Promise((r) => setImmediate(r));
  return done;
}

test('a synthetic call that never settles times out: nothing is appended or committed, and the next prompt delivers with a note (ruling B)', async (t) => {
  const dir = makeProject();
  try {
    const sent = [];
    let first = true;
    let called;
    const reached = new Promise((r) => { called = r; });
    const h = handler(dir, {}, {
      synthetic: (c) => {
        if (first) {
          first = false;
          called();
          return new Promise(() => {});
        }
        sent.push(c);
        return Promise.resolve();
      },
    });
    notices.addNotice(dir, 'NOTICE-AFTER-TIMEOUT', NOW);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const input = { sessionID: 'ses_root', messageID: 'msg_u', prompt: { text: 'go' }, delivery: 'immediate' };
    const stuck = h.onPrompt(input);
    await reached;
    t.mock.timers.tick(contextMod.SYNTHETIC_TIMEOUT_MS);
    assert.equal(await settled(stuck), true, 'the hook returns once the call times out');
    assert.equal(input.prompt.text, 'go', 'no append fallback on an uncertain delivery');
    const left = JSON.parse(readFileSync(join(dir, notices.NOTICES_REL), 'utf8'));
    assert.deepEqual(left.map((n) => [n.text, n.shown_at, n.claim]), [['NOTICE-AFTER-TIMEOUT', undefined, undefined]], 'the notice claim was released, not committed');

    const next = { sessionID: 'ses_root', messageID: 'msg_v', prompt: { text: 'go' }, delivery: 'immediate' };
    assert.equal(await settled(h.onPrompt(next)), true, 'the session chain was not held by the stuck call');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /STERLING STATUS: board 0 open/, 'the released lines are sent again');
    assert.match(sent[0].text, /NOTICE-AFTER-TIMEOUT/);
    assert.match(sent[0].text, new RegExp(`STERLING DELIVERY DEGRADED \\(ctx\\.session\\.synthetic did not settle within ${contextMod.SYNTHETIC_TIMEOUT_MS} ms\\)`));

    addTodo(dir, 'later ask');
    h.resetStatus(dir);
    assert.equal(await settled(h.onPrompt({ sessionID: 'ses_root', messageID: 'msg_w', prompt: { text: 'go' }, delivery: 'immediate' })), true);
    assert.equal(sent.length, 2);
    assert.doesNotMatch(sent[1].text, /DEGRADED/, 'the timeout note is said once per session');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a multi-line worker failure reason is in the maintenance key: it is delivered, and a change in its second line is too (ruling C)', async () => {
  const dir = makeProject();
  try {
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    store.create({
      id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'system', status: 'active', superseded_by: null,
      links: [], scope: 'project', stack_tags: [], text: 'item', source: 'system', system_reason: 'reconcile_needed', file_keys: ['src/a.mjs'],
    });
    store.close();
    const h = handler(dir);
    assert.match(await appended(h, 'ses_root'), /RECONCILE BACKLOG/);
    const statePath = join(dir, '.sterling', 'transient', 'maintenance-worker.state.json');
    mkdirSync(dirname(statePath), { recursive: true });
    const fail = (error) => writeFileSync(statePath, JSON.stringify({ last_run: { ok: false, at: '2026-10-12T11:00:00.000Z', error } }));
    fail('process failed\npermission denied');
    h.resetStatus(dir);
    assert.match(await appended(h, 'ses_root'), /last worker run FAILED at 2026-10-12T11:00:00\.000Z: process failed\npermission denied/);
    fail('process failed\nmcp not connected');
    h.resetStatus(dir);
    assert.match(await appended(h, 'ses_root'), /process failed\nmcp not connected/, 'the second line is part of the failure identity');
    h.resetStatus(dir);
    assert.equal(await appended(h, 'ses_root'), '', 'an unchanged failure is not sent again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a notice reaches the conductor once: a child does not take it, a shown one is not repeated, and one added later is not dropped by the prune', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir);
    notices.addNotice(dir, 'NOTICE-A', NOW);
    assert.doesNotMatch(await appended(h, 'ses_child'), /NOTICE-A/, 'a child session never takes the conductor\'s notices');
    assert.match(await appended(h, 'ses_root'), /STERLING NOTICES \(new since the last ones you were shown\):\n- NOTICE-A/);
    assert.doesNotMatch(await appended(h, 'ses_root'), /NOTICE-A/, 'shown once');
    notices.addNotice(dir, 'NOTICE-B', NOW);
    // Settlement at the end of the execution prunes the shown notices only (settle.mjs).
    notices.pruneShownNotices(dir);
    const kept = JSON.parse(readFileSync(join(dir, notices.NOTICES_REL), 'utf8')).map((n) => n.text);
    assert.deepEqual(kept, ['NOTICE-B'], 'the unshown notice survives the prune');
    const next = await appended(h, 'ses_root');
    assert.match(next, /NOTICE-B/);
    assert.doesNotMatch(next, /NOTICE-A/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a child gets the session lines on its own prompt, and its staging brief ignores them', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir);
    const lines = await appended(h, 'ses_child');
    assert.match(lines, /STERLING STATUS/);
    assert.doesNotMatch(lines, /BOARD READINESS|PLAN LOCK/, 'root-only lines stay root-only');
    const brief = staging.briefOf([{ role: 'user', content: [{ type: 'text', text: `do the thing\n\n${staging.VOLATILE_HEADER}\n\n${lines}` }] }]);
    assert.equal(brief, 'do the thing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after an OpenCode restart or a compaction, the next prompt gets the whole current set once', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir);
    assert.match(await appended(h, 'ses_root'), /STERLING STATUS/);
    assert.equal(await appended(h, 'ses_root'), '');
    h.resetSession('ses_root');
    assert.match(await appended(h, 'ses_root'), /STERLING STATUS: board 0 open/, 'after a compaction');
    const restarted = handler(dir);
    assert.match(await appended(restarted, 'ses_root'), /STERLING STATUS: board 0 open/, 'a resumed session in a new process');
    assert.equal(await appended(restarted, 'ses_root'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A completed `tool` call of `sessionID` after onToolResult ran; returns the synthetic text sent ('' when nothing). The result stays as the tool made it, and the call steers into the current turn. */
async function toolAppended(h, sessionID, tool = 'read') {
  const before = h.synthetic.length;
  const input = { tool, sessionID, id: `call_${randomUUID()}`, input: { path: 'x' }, status: 'completed', result: { content: [{ type: 'text', text: 'tool output' }] } };
  await h.onToolResult(input);
  assert.deepEqual(input.result.content, [{ type: 'text', text: 'tool output' }], 'the tool output is untouched');
  const sent = h.synthetic.slice(before);
  for (const c of sent) {
    assert.equal(c.delivery, 'steer', 'never queue: it adds a model turn');
    assert.deepEqual(c.metadata, { source: 'sterling' });
    assert.equal('description' in c, false);
  }
  return sent.map((c) => c.text).join('\n');
}

test('mid-turn: a change between two tool calls is appended once to the next tool result, and the next prompt does not repeat it', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir);
    const first = contextInput('ses_root');
    await h.onContext(first);
    assert.match(await appended(h, 'ses_root'), /STERLING STATUS: board 0 open/, 'the turn starts with the current set');
    assert.equal(await toolAppended(h, 'ses_root'), '', 'an unchanged state adds nothing to a tool result');

    addTodo(dir, 'raised mid-turn');
    notices.addNotice(dir, 'NOTICE-MID', NOW);
    h.resetStatus(dir);
    const mid = await toolAppended(h, 'ses_root', 'shell');
    assert.ok(mid.startsWith(`${staging.VOLATILE_HEADER}\n\n`), 'the STERLING CONTEXT header is kept');
    assert.match(mid, /STERLING STATUS: board 1 open/);
    assert.match(mid, /READY \(1\):\n- raised mid-turn/);
    assert.match(mid, /NOTICE-MID/);
    assert.doesNotMatch(mid, /TDD posture/, 'only what changed');
    assert.equal(await toolAppended(h, 'ses_root', 'edit'), '', 'once: the next tool result does not repeat it');
    assert.equal(await appended(h, 'ses_root'), '', 'and neither does the next prompt');

    const second = contextInput('ses_root');
    await h.onContext(second);
    assert.equal(systemOf(second), systemOf(first), 'the system prompt is untouched by either route');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mid-turn lines ride only the tools delivery.mjs appends to: never the subagent tool, never a failed call', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir);
    await appended(h, 'ses_root');
    addTodo(dir, 'another ask');
    h.resetStatus(dir);
    for (const tool of ['subagent', 'question', 'webfetch']) assert.equal(await toolAppended(h, 'ses_root', tool), '', tool);
    const failed = { tool: 'read', sessionID: 'ses_root', id: 'call_failed', input: { path: 'x' }, status: 'error', error: new Error('nope') };
    await h.onToolResult(failed);
    assert.equal(failed.result, undefined);
    assert.match(await toolAppended(h, 'ses_root', 'write'), /STERLING STATUS: board 1 open/, 'the change waits for a delivery tool');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PLAN_LOCK = {
  schema_version: 1,
  plan_path: 'plans/fixture.md',
  title: 'Fixture Plan',
  approved_at: '2026-10-01T09:00:00.000Z',
  approved_sha256: 'a'.repeat(64),
  file_sha256_at_approval: 'a'.repeat(64),
  approved_session_id: 's0',
  approved_branch: 'main',
  approved_head: 'deadbeef',
  source: 'manual',
};

test('the system block is frozen at a session\'s first request: an unstaged child and a root keep the same bytes while the plan lock and config change', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir);
    const childInput = () => ({ sessionID: 'ses_child', agent: 'sterling/implementor', system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'do the thing' }] }], tools: {} });
    const child1 = childInput();
    await h.onContext(child1);
    assert.match(systemOf(child1), /STERLING DEFAULT RETURN CONTRACT/, 'the child got its dispatch chrome');
    assert.match(systemOf(child1), /TDD posture: tests-first ON/, 'the implementor chrome carries the TDD posture read now');
    const root1 = contextInput('ses_root');
    await h.onContext(root1);
    assert.match(systemOf(root1), /fixture-proj/);

    writeFileSync(join(dir, '.sterling', 'plan-lock.json'), JSON.stringify(PLAN_LOCK));
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'renamed-proj', tdd: { enabled: false } }));
    const child2 = childInput();
    await h.onContext(child2);
    assert.equal(systemOf(child2), systemOf(child1), 'the unstaged child keeps its first block, byte for byte');
    const root2 = contextInput('ses_root');
    await h.onContext(root2);
    assert.equal(systemOf(root2), systemOf(root1), 'the root keeps its first layer, byte for byte');

    // A session that starts now renders the current state, and a compaction renders again.
    const other = contextInput('ses_other');
    await h.onContext(other);
    assert.match(systemOf(other), /renamed-proj/);
    h.resetSession('ses_child');
    const child3 = childInput();
    await h.onContext(child3);
    assert.match(systemOf(child3), /TDD posture: tests-first OFF/, 'after a compaction the child block is rendered again from the current config');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a notice added by another process while a prune is between its read and its write survives the prune', async () => {
  const { spawn } = await import('node:child_process');
  const dir = makeProject();
  try {
    notices.addNotice(dir, 'NOTICE-SHOWN', NOW);
    notices.takeNotices(dir, NOW);
    let child;
    notices.pruneShownNotices(dir, {
      afterRead: () => {
        // Another process adds a notice while this prune holds its snapshot of the file.
        const script = `import(${JSON.stringify(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'notices.mjs')).href)}).then((m) => m.addNotice(${JSON.stringify(dir)}, 'NOTICE-FRESH', ${JSON.stringify(NOW)}))`;
        child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
        // Hold the snapshot long enough for an unlocked writer to land inside the window.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
      },
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0, `the other process added its notice: ${stderr}`);
    const left = JSON.parse(readFileSync(join(dir, notices.NOTICES_REL), 'utf8')).map((n) => n.text);
    assert.deepEqual(left, ['NOTICE-FRESH'], 'the shown notice is pruned and the fresh one is kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable notices file is said in-band and logged, and the other lines stay due for the next prompt', async () => {
  const dir = makeProject();
  try {
    const h = handler(dir);
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, notices.NOTICES_REL), '{ not json');
    const broken = await appended(h, 'ses_root');
    assert.match(broken, /STERLING NOTICES UNREADABLE/);
    assert.doesNotMatch(broken, /STERLING STATUS/, 'the other lines are held back');
    assert.match(readFileSync(join(dir, '.sterling', 'transient', 'opencode-plugin.log'), 'utf8'), /pending notices unreadable/);
    writeFileSync(join(dir, notices.NOTICES_REL), JSON.stringify([{ id: 'n1', at: NOW, text: 'NOTICE-AFTER-FIX' }]));
    const fixed = await appended(h, 'ses_root');
    assert.match(fixed, /STERLING STATUS: board 0 open/, 'still due: nothing was marked delivered');
    assert.match(fixed, /TDD posture/);
    assert.match(fixed, /NOTICE-AFTER-FIX/);
    assert.equal(await appended(h, 'ses_root'), '', 'and delivered once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dispatch-sweep line held back by an unreadable notices file is delivered once the file reads again, then not repeated', async () => {
  const dir = makeProject();
  try {
    let sweeps = 0;
    const h = handler(dir, { sweepStale: async () => (++sweeps === 1 ? 'SWEEP-LINE-ONE-SHOT' : '') });
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, notices.NOTICES_REL), '{ not json');
    assert.doesNotMatch(await appended(h, 'ses_root'), /SWEEP-LINE-ONE-SHOT/, 'held back while the notices file is unreadable');
    writeFileSync(join(dir, notices.NOTICES_REL), '[]');
    assert.match(await appended(h, 'ses_root'), /SWEEP-LINE-ONE-SHOT/, 'the sweep line is not lost with the failed append');
    assert.doesNotMatch(await appended(h, 'ses_other'), /SWEEP-LINE-ONE-SHOT/, 'and it is delivered once');
    assert.equal(sweeps, 1, 'the sweep ran once: its line was held, not produced again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a registry refresh failure line held back by an unreadable notices file is delivered once the file reads again', async () => {
  const dir = makeProject();
  const registryDb = join(dir, 'registry.db');
  const prior = process.env.STERLING_REGISTRY_DB;
  try {
    writeFileSync(registryDb, 'this is not a sqlite database, so opening the registry throws');
    process.env.STERLING_REGISTRY_DB = registryDb;
    const h = handler(dir);
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, notices.NOTICES_REL), '{ not json');
    assert.doesNotMatch(await appended(h, 'ses_root'), /PROJECT REGISTRY REFRESH FAILED/, 'held back while the notices file is unreadable');
    writeFileSync(join(dir, notices.NOTICES_REL), '[]');
    assert.match(await appended(h, 'ses_root'), /PROJECT REGISTRY REFRESH FAILED/, 'the failure line is not lost with the failed append');
    assert.doesNotMatch(await appended(h, 'ses_root'), /PROJECT REGISTRY REFRESH FAILED/, 'and it is delivered once');
  } finally {
    if (prior === undefined) delete process.env.STERLING_REGISTRY_DB;
    else process.env.STERLING_REGISTRY_DB = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a held one-shot line is delivered exactly once when two prompts overlap, and is put back when its append fails', async () => {
  const dir = makeProject();
  try {
    let sweeps = 0;
    let pause = null;
    const h = handler(dir, {
      sweepStale: async () => (++sweeps === 1 ? 'SWEEP-LINE-OVERLAP' : ''),
      rotationRestore: async () => {
        if (pause) await pause.gate;
        return '';
      },
    });
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, notices.NOTICES_REL), '{ not json');
    await appended(h, 'ses_root');
    writeFileSync(join(dir, notices.NOTICES_REL), '[]');
    // The first prompt is paused mid-computation (as a slow rotation restore would), the second runs to the end, then the first resumes.
    let resume;
    pause = { gate: new Promise((r) => { resume = r; }) };
    const first = appended(h, 'ses_root');
    await new Promise((r) => setTimeout(r, 20));
    pause = null;
    const second = await appended(h, 'ses_other');
    resume();
    const both = [await first, second].filter((t) => t.includes('SWEEP-LINE-OVERLAP'));
    assert.equal(both.length, 1, 'the held line is delivered exactly once across both prompts');

    // A failed delivery puts a claimed line back: the next prompt gets it. The delivery fails when the synthetic
    // call throws and the fallback append throws too (the hidden route replaced the append as the first attempt).
    let syntheticCalls = 0;
    const h2 = handler(dir, { sweepStale: async () => 'SWEEP-LINE-RETRY' }, { synthetic: async (c) => { if (syntheticCalls++ === 0) throw new Error('synthetic failed'); h2.synthetic.push(c); } });
    const failing = { sessionID: 'ses_root', messageID: 'msg_u', delivery: 'immediate', prompt: {} };
    let writes = 0;
    Object.defineProperty(failing.prompt, 'text', { get: () => 'go', set: () => { if (writes++ === 0) throw new Error('append failed'); }, enumerable: true });
    await assert.doesNotReject(h2.onPrompt(failing).catch(() => {}));
    assert.match(await appended(h2, 'ses_other'), /SWEEP-LINE-RETRY/, 'the line survives a failed append');
    assert.doesNotMatch(await appended(h2, 'ses_root'), /SWEEP-LINE-RETRY/, 'and is delivered once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a claimed one-shot line is restored even when the log write that reports an unreadable notices file throws', async () => {
  const dir = makeProject();
  try {
    let sweeps = 0;
    const h = handler(dir, { sweepStale: async () => (++sweeps === 1 ? 'SWEEP-LINE-LOGFAIL' : '') });
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, notices.NOTICES_REL), '{ not json');
    await appended(h, 'ses_root'); // the sweep line is produced and held while the notices cannot be read
    const log = join(dir, '.sterling', 'transient', 'opencode-plugin.log');
    rmSync(log, { force: true });
    mkdirSync(log); // appending to a directory throws, so logLine throws
    await assert.rejects(appended(h, 'ses_root'), 'the failing log write surfaces');
    rmSync(log, { recursive: true });
    writeFileSync(join(dir, notices.NOTICES_REL), '[]');
    const fixed = [await appended(h, 'ses_root'), await appended(h, 'ses_other')].filter((t) => t.includes('SWEEP-LINE-LOGFAIL'));
    assert.equal(fixed.length, 1, 'the claimed line was not lost with the failed log write, and is delivered once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed older delivery does not restore a registry failure line after a newer failure line was claimed and delivered', async () => {
  const dir = makeProject();
  const registryDb = join(dir, 'registry.db');
  const prior = process.env.STERLING_REGISTRY_DB;
  try {
    process.env.STERLING_REGISTRY_DB = registryDb;
    // Failure A: the registry file is not a database. Failure B: a directory sits at its path. Their error texts differ, so each line is told apart.
    writeFileSync(registryDb, 'this is not a sqlite database, so opening the registry throws');
    let releaseRestoreA;
    let releaseKindB;
    const gateRestoreA = new Promise((r) => { releaseRestoreA = r; });
    const gateKindB = new Promise((r) => { releaseKindB = r; });
    let restores = 0;
    const h = handler(dir, {
      rotationRestore: async () => {
        if (restores++ === 0) await gateRestoreA; // call A is paused after it held line A and before it claims it
        return '';
      },
      getSession: () => ({
        get: async ({ sessionID }) => {
          if (sessionID === 'ses_other') await gateKindB; // call B is paused before it holds line B
          return { id: sessionID };
        },
        // Call A's delivery fails: its synthetic call throws and so does its fallback append. Call B's goes through.
        synthetic: async (c) => {
          if (c.sessionID === 'ses_root') throw new Error('synthetic failed late');
          h.synthetic.push(c);
        },
      }),
    });
    const lineA = /REGISTRY REFRESH FAILED \(.*not a database/;
    const lineB = /REGISTRY REFRESH FAILED \((?!.*not a database)/;

    // Call A (ses_root) holds line A, then claims it once its restore step resumes; its append fails after B has been delivered.
    const attemptsA = [];
    const promptA = { sessionID: 'ses_root', messageID: 'msg_a', delivery: 'immediate', prompt: {} };
    Object.defineProperty(promptA.prompt, 'text', { get: () => 'go', set: (v) => { attemptsA.push(v); throw new Error('append failed late'); }, enumerable: true });
    const callA = h.onPrompt(promptA).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    // Call B (ses_other) is another root session: its registry refresh fails again, so it holds a newer line B.
    rmSync(registryDb);
    mkdirSync(registryDb);
    const callB = appended(h, 'ses_other');
    await new Promise((r) => setTimeout(r, 20));

    // A claims line A, then B holds, claims and delivers line B, all before A's failed append is released: the calls run in microtask lockstep.
    // B is released first because its path to the hold is longer than A's path to the claim; released back to back they interleave as
    // claim A, hold B, claim B, release A (the preconditions below fail if that order ever changes).
    releaseKindB();
    releaseRestoreA();
    const deliveredB = await callB;
    await callA;
    assert.equal(attemptsA.length, 1);
    assert.match(attemptsA[0], lineA, 'call A claimed line A');
    assert.match(deliveredB, lineB, 'call B delivered the newer line B');
    assert.doesNotMatch(deliveredB, lineA);

    // Only ses_other prompts follow: a prompt of ses_root would refresh the registry again (the last root session seen was ses_other) and hold a fresh line.
    const later = [await appended(h, 'ses_other'), await appended(h, 'ses_other'), await appended(h, 'ses_other')];
    assert.ok(!later.some((t) => lineA.test(t)), 'the older line A is not redelivered after the newer line B');
    assert.ok(!later.some((t) => lineB.test(t)), 'the newer line B is delivered exactly once');
  } finally {
    if (prior === undefined) delete process.env.STERLING_REGISTRY_DB;
    else process.env.STERLING_REGISTRY_DB = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
