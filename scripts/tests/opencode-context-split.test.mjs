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
function handler(dir) {
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
    assert.match(await appended(h, 'ses_root'), /STERLING NOTICES \(from the end of the last turn\):\n- NOTICE-A/);
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
