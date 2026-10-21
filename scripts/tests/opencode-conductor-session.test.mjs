// GitHub issue #187: the Sterling OpenCode plugin records the root session the user last
// prompted (packages/opencode-plugin/src/conductor-session.mjs), so the launcher reopens THAT
// session after a crash or service restart, never a newer maintenance-worker or subagent session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'conductor-session.mjs')).href);
const { createConductorSessionRecorder, CONDUCTOR_SESSION_REL } = mod;
// The arrival seq server.mjs takes at prompt-hook entry.
const takePromptSeq = mod.takePromptSeq ?? (() => undefined);

function setup({ env = {}, sessions = {}, root } = {}) {
  const dir = root === undefined ? mkdtempSync(join(tmpdir(), 'sterling-oc-conductor-')) : root;
  if (dir) mkdirSync(join(dir, '.sterling'), { recursive: true });
  const failures = [];
  const fenced = async (name, r, fn) => {
    try {
      await fn();
    } catch (e) {
      failures.push(`${name}: ${e.message}`);
    }
  };
  const session = {
    get: async ({ sessionID }) => {
      const s = sessions[sessionID];
      if (s?.hold) await s.hold;
      if (s instanceof Error) throw s;
      if (!s) throw new Error(`no session ${sessionID}`);
      return { id: sessionID, ...s };
    },
  };
  const onPrompt = createConductorSessionRecorder({ rootOf: () => dir, fenced, getSession: () => session, parents: new Map(), env });
  const recorded = () => (dir && existsSync(join(dir, CONDUCTOR_SESSION_REL)) ? readFileSync(join(dir, CONDUCTOR_SESSION_REL), 'utf8') : null);
  return { dir, onPrompt, recorded, failures, cleanup: () => dir && rmSync(dir, { recursive: true, force: true }) };
}

const prompt = (sessionID) => ({ sessionID, messageID: 'msg_1', prompt: { text: 'hi' }, delivery: 'immediate' });

test('a prompt in a root session records its id; a later root prompt replaces it', async () => {
  const t = setup({ sessions: { ses_conductorA: {}, ses_newB: {} } });
  try {
    await t.onPrompt(prompt('ses_conductorA'), takePromptSeq());
    assert.equal(t.recorded(), 'ses_conductorA\n');
    await t.onPrompt(prompt('ses_newB'), takePromptSeq());
    assert.equal(t.recorded(), 'ses_newB\n', 'a /new session the user prompts becomes the conductor');
    assert.deepEqual(t.failures, []);
  } finally {
    t.cleanup();
  }
});

test('two locations of one project (root and a subdirectory) keep one coherent record: A, B, A ends on A', async () => {
  const a = setup({ sessions: { ses_rootA: {} } });
  try {
    const b = setup({ root: a.dir, sessions: { ses_subB: {} } });
    await a.onPrompt(prompt('ses_rootA'), takePromptSeq());
    await b.onPrompt(prompt('ses_subB'), takePromptSeq());
    assert.equal(a.recorded(), 'ses_subB\n');
    await a.onPrompt(prompt('ses_rootA'), takePromptSeq());
    assert.equal(a.recorded(), 'ses_rootA\n', "the root location's instance writes again: the skip compares with the file, not its own last write");
    assert.deepEqual([...a.failures, ...b.failures], []);
  } finally {
    a.cleanup();
  }
});

test('a child prompt processed while a newer root lookup is held cannot block that root: the record becomes the new root', async () => {
  let release;
  const hold = new Promise((r) => (release = r));
  const t = setup({ sessions: { ses_oldConductor: {}, ses_newRoot: { hold }, ses_child: { parentID: 'ses_newRoot' } } });
  try {
    await t.onPrompt(prompt('ses_oldConductor'), takePromptSeq());
    const pending = t.onPrompt(prompt('ses_newRoot'), takePromptSeq());
    await t.onPrompt(prompt('ses_child'), takePromptSeq());
    release();
    await pending;
    assert.equal(t.recorded(), 'ses_newRoot\n');
    assert.deepEqual(t.failures, []);
  } finally {
    t.cleanup();
  }
});

test('a subagent (child) session prompt never replaces the conductor', async () => {
  const t = setup({ sessions: { ses_conductorA: {}, ses_child: { parentID: 'ses_conductorA' } } });
  try {
    await t.onPrompt(prompt('ses_conductorA'), takePromptSeq());
    await t.onPrompt(prompt('ses_child'), takePromptSeq());
    assert.equal(t.recorded(), 'ses_conductorA\n');
    assert.deepEqual(t.failures, []);
  } finally {
    t.cleanup();
  }
});

test('inside the maintenance worker child nothing is recorded, so a newer worker session never wins', async () => {
  const user = setup({ sessions: { ses_conductorA: {} } });
  try {
    await user.onPrompt(prompt('ses_conductorA'), takePromptSeq());
    const worker = setup({ root: user.dir, env: { STERLING_MAINTENANCE_WORKER: '1' }, sessions: { ses_worker: {} } });
    await worker.onPrompt(prompt('ses_worker'), takePromptSeq());
    assert.equal(user.recorded(), 'ses_conductorA\n');
    assert.deepEqual(worker.failures, []);
  } finally {
    user.cleanup();
  }
});

test('a session that cannot be checked is not recorded and the failure goes through the fence', async () => {
  const t = setup({ sessions: { ses_conductorA: {}, ses_broken: new Error('boom') } });
  try {
    await t.onPrompt(prompt('ses_conductorA'), takePromptSeq());
    await t.onPrompt(prompt('ses_broken'), takePromptSeq());
    assert.equal(t.recorded(), 'ses_conductorA\n');
    assert.equal(t.failures.length, 1);
    assert.match(t.failures[0], /^conductor-session: .*ses_broken.*boom/);
  } finally {
    t.cleanup();
  }
});

test('outside a Sterling project nothing is written', async () => {
  const t = setup({ root: null, sessions: { ses_conductorA: {} } });
  await t.onPrompt(prompt('ses_conductorA'), takePromptSeq());
  assert.equal(t.recorded(), null);
  assert.deepEqual(t.failures, []);
});
