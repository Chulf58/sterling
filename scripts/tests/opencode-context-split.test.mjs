// The OpenCode session context split (user-ruled 2026-10-12, "Move live lines out"; finding
// why-is-the-prompt-cache-hit-rate-lower-on-opencode-codeburn): the system prompt carries only
// stable Sterling text, and the lines that change (status, board readiness, notices, ...) are
// appended to the session's next prompt when they changed since that session last got them.
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

/** A context handler for `dir` whose sessions are ses_root (a root) and ses_child (its child). */
function handler(dir, extra = {}) {
  const sessions = { ses_root: {}, ses_other: {}, ses_child: { parentID: 'ses_root' } };
  return contextMod.createContextHandler({
    openStore: (p) => new SterlingStore(p),
    now: () => NOW,
    rootOf: () => dir,
    fenced: async (_name, _root, fn) => fn(),
    rotationRestore: async () => '',
    sessionSync: async () => {},
    pluginRoot: repo,
    getSession: () => ({ get: async ({ sessionID }) => ({ id: sessionID, ...sessions[sessionID] }) }),
    ...extra,
  });
}

const contextInput = (sessionID) => ({ sessionID, agent: 'build', system: [{ type: 'text', text: 'base' }], messages: [], tools: {} });
const systemOf = (i) => i.system.map((p) => p.text).join('\n');

/** The text onPrompt appended to a prompt of `sessionID` ('' when nothing). */
async function appended(h, sessionID) {
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

/** A completed `tool` call of `sessionID` after onToolResult ran; returns what was appended ('' when nothing). */
async function toolAppended(h, sessionID, tool = 'read') {
  const input = { tool, sessionID, id: `call_${randomUUID()}`, input: { path: 'x' }, status: 'completed', result: { content: [{ type: 'text', text: 'tool output' }] } };
  await h.onToolResult(input);
  return input.result.content.slice(1).map((p) => p.text).join('\n');
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

    // A failed append puts a claimed line back: the next prompt gets it.
    const h2 = handler(dir, { sweepStale: async () => 'SWEEP-LINE-RETRY' });
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
      getSession: () => ({ get: async ({ sessionID }) => {
        if (sessionID === 'ses_other') await gateKindB; // call B is paused before it holds line B
        return { id: sessionID };
      } }),
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
