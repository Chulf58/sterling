// The session-move guard on the OpenCode plugin (packages/opencode-plugin/src/session-move.mjs,
// wired in server.mjs execute.before). OpenCode 2.1.2 looks up a session's agent in the
// session's current directory on every turn, and Sterling's agents live in the
// git-excluded .opencode/agents/sterling/, so a lane that session_moves into a git worktree
// outside the project fails every later turn and resume with 'Agent not found:
// "sterling/implementor"' (GitHub #189, #192, #193, #197). The guard refuses that move
// loudly instead. Every fixture is a fresh temp directory; nothing reads this repo's .sterling/.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
let server;
let move;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  server = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'server.mjs')).href);
  move = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'session-move.mjs')).href);
});

const AGENT = 'sterling/implementor';

/** A temp tree: a Sterling project with the agent installed, a sibling worktree without it, an empty global config dir. */
function makeTree() {
  const base = mkdtempSync(join(tmpdir(), 'sterling-oc-move-'));
  const project = join(base, 'project');
  mkdirSync(join(project, '.sterling'), { recursive: true });
  writeFileSync(join(project, '.sterling', 'config.json'), JSON.stringify({ project_name: 'fixture-proj' }));
  new SterlingStore(join(project, '.sterling', 'sterling.db')).close();
  installAgent(project);
  const worktree = join(base, 'worktree');
  mkdirSync(worktree);
  const xdg = join(base, 'xdg');
  mkdirSync(xdg);
  return { base, project, worktree, xdg, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
function installAgent(dir, sub = '.opencode/agents') {
  mkdirSync(join(dir, sub, 'sterling'), { recursive: true });
  writeFileSync(join(dir, sub, 'sterling', 'implementor.md'), '---\ndescription: fixture\nmode: subagent\n---\nbody\n');
}

/** The plugin set up at `directory`; `sessions` maps a session id to its session.get result (a function value throws). */
async function setup(t, sessions, env = { XDG_CONFIG_HOME: t.xdg }) {
  const hooks = { session: {}, tool: {}, permission: {} };
  const transform = async () => ({ dispose: async () => {} });
  const ctx = {
    location: { directory: t.project },
    session: {
      hook: async (name, fn) => void (hooks.session[name] = fn),
      get: async ({ sessionID }) => {
        const s = sessions[sessionID];
        if (typeof s === 'function') return s();
        return { id: sessionID, ...s };
      },
    },
    tool: { hook: async (name, fn) => void (hooks.tool[name] = fn) },
    permission: { hook: async (name, fn) => void (hooks.permission[name] = fn) },
    command: { transform },
    skill: { transform },
    mcp: { transform },
    model: { list: async () => [] },
    event: { subscribe: ({ signal } = {}) => ({ async *[Symbol.asyncIterator]() { await new Promise((r) => signal?.addEventListener('abort', r)); } }) },
  };
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async () => {}, env });
  const cleanup = await plugin.setup(ctx);
  const before = (input) => hooks.tool['execute.before']({ id: 'call_1', messageID: 'msg_1', ...input });
  return { before, cleanup };
}
const own = (t) => ({ ses_lane: { agent: AGENT, location: { directory: t.project } } });

test('regression #189: a Sterling lane moving its own session to a worktree without the agent is refused, naming the agent and the fix', async () => {
  const t = makeTree();
  const s = await setup(t, own(t));
  try {
    await assert.rejects(
      s.before({ tool: 'opencode_session_move', sessionID: 'ses_lane', agent: AGENT, input: { directory: t.worktree } }),
      (e) => {
        assert.match(e.message, /^Sterling refused this session_move: session ses_lane runs agent sterling\/implementor/);
        assert.ok(e.message.includes(`OpenCode started in ${t.worktree} would not see sterling/implementor (no .opencode/agents/sterling/implementor.md there or in a parent, and no config entry for it`), e.message);
        assert.match(e.message, /Agent not found: "sterling\/implementor"/);
        assert.match(e.message, /copy the project's \.opencode\/agents\/sterling\/ into/);
        return true;
      },
    );
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('a move of another session (input.sessionID) is judged by that session\'s agent from session.get', async () => {
  const t = makeTree();
  const s = await setup(t, { ...own(t), ses_root: { agent: 'sterling/conductor', location: { directory: t.project } } });
  try {
    await assert.rejects(s.before({ tool: 'opencode_session_move', sessionID: 'ses_root', agent: 'sterling/conductor', input: { sessionID: 'ses_lane', directory: t.worktree } }), /session ses_lane runs agent sterling\/implementor/);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('a relative destination resolves against the moved session\'s directory', async () => {
  const t = makeTree();
  const s = await setup(t, own(t));
  try {
    await assert.rejects(s.before({ tool: 'opencode_session_move', sessionID: 'ses_lane', agent: AGENT, input: { directory: '../worktree' } }), /Sterling refused this session_move/);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('the move passes when the destination resolves the agent: its own .opencode/agents, a parent\'s, or the global config dir', async () => {
  for (const arrange of ['own', 'agent-dir', 'nested', 'global']) {
    const t = makeTree();
    let dest = t.worktree;
    if (arrange === 'own') installAgent(t.worktree);
    if (arrange === 'agent-dir') installAgent(t.worktree, '.opencode/agent');
    if (arrange === 'nested') {
      dest = join(t.project, '.worktrees', 'inner');
      mkdirSync(dest, { recursive: true });
    }
    if (arrange === 'global') installAgent(join(t.xdg, 'opencode'), 'agents');
    const s = await setup(t, own(t));
    try {
      await s.before({ tool: 'opencode_session_move', sessionID: 'ses_lane', agent: AGENT, input: { directory: dest } });
    } finally {
      await s.cleanup?.();
      t.cleanup();
    }
  }
});

test('a non-Sterling agent, another tool, or a destination that does not exist is left to OpenCode', async () => {
  const t = makeTree();
  const s = await setup(t, { ses_gen: { agent: 'general', location: { directory: t.project } }, ...own(t) });
  try {
    await s.before({ tool: 'opencode_session_move', sessionID: 'ses_gen', agent: 'general', input: { directory: t.worktree } });
    await s.before({ tool: 'opencode_session_rename', sessionID: 'ses_lane', agent: AGENT, input: { title: 'x' } });
    await s.before({ tool: 'opencode_session_move', sessionID: 'ses_lane', agent: AGENT, input: { directory: join(t.base, 'missing') } });
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

// Changed after the Sol review of this guard (finding: a failed session.get let the move
// through): the guard fails closed, so a move whose agent cannot be established is refused
// with a retry message, and only an own-session move to an absolute path, whose agent the
// hook metadata names, is decided without session.get.
const failing = () => ({
  ses_lane: () => {
    throw new Error('fixture lookup failure');
  },
});

test('fail closed: a failed session.get refuses a move of another session with a retry message', async () => {
  const t = makeTree();
  const s = await setup(t, failing());
  try {
    await assert.rejects(s.before({ tool: 'opencode_session_move', sessionID: 'ses_root', agent: 'sterling/conductor', input: { sessionID: 'ses_lane', directory: t.worktree } }), (e) => {
      assert.match(e.message, /^Sterling refused this session_move: it could not check whether the moved session's agent would still be found at the destination \(session\.get for session ses_lane failed: fixture lookup failure\)/);
      assert.match(e.message, /Try the move again/);
      return true;
    });
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('fail closed: a failed session.get refuses an own-session move to a relative path (its base is unknown)', async () => {
  const t = makeTree();
  const s = await setup(t, failing());
  try {
    await assert.rejects(s.before({ tool: 'opencode_session_move', sessionID: 'ses_lane', agent: AGENT, input: { directory: '../worktree' } }), /could not check whether the moved session's agent/);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('an own-session move to an absolute path is decided from the hook agent without session.get', async () => {
  const t = makeTree();
  const s = await setup(t, failing());
  try {
    await assert.rejects(s.before({ tool: 'opencode_session_move', sessionID: 'ses_lane', agent: AGENT, input: { directory: t.worktree } }), /session ses_lane runs agent sterling\/implementor/);
    installAgent(t.worktree);
    await s.before({ tool: 'opencode_session_move', sessionID: 'ses_lane', agent: AGENT, input: { directory: t.worktree } });
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('fail closed: a session.get that hangs past the budget refuses the move', { timeout: 15000 }, async () => {
  const t = makeTree();
  const s = await setup(t, { ses_lane: () => new Promise(() => {}) });
  try {
    await assert.rejects(s.before({ tool: 'opencode_session_move', sessionID: 'ses_root', agent: 'sterling/conductor', input: { sessionID: 'ses_lane', directory: t.worktree } }), /could not check .*exceeded its \d+ ms budget/);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('an agent defined in config is visible at the destination: OPENCODE_CONFIG_CONTENT, opencode.json, OPENCODE_CONFIG_DIR', async () => {
  for (const arrange of ['content', 'dest-json', 'dest-dot-json', 'config-dir']) {
    const t = makeTree();
    const env = { XDG_CONFIG_HOME: t.xdg };
    if (arrange === 'content') env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ agent: { [AGENT]: { mode: 'subagent', prompt: 'x' } } });
    if (arrange === 'dest-json') writeFileSync(join(t.worktree, 'opencode.json'), JSON.stringify({ agent: { [AGENT]: { mode: 'subagent' } } }));
    if (arrange === 'dest-dot-json') {
      mkdirSync(join(t.worktree, '.opencode'));
      writeFileSync(join(t.worktree, '.opencode', 'opencode.json'), JSON.stringify({ agent: { [AGENT]: { mode: 'subagent' } } }));
    }
    if (arrange === 'config-dir') {
      env.OPENCODE_CONFIG_DIR = join(t.base, 'ocdir');
      installAgent(env.OPENCODE_CONFIG_DIR, 'agents');
    }
    const s = await setup(t, own(t), env);
    try {
      await s.before({ tool: 'opencode_session_move', sessionID: 'ses_lane', agent: AGENT, input: { directory: t.worktree } });
    } finally {
      await s.cleanup?.();
      t.cleanup();
    }
  }
});

test('moveTarget expands ~ and resolves a relative path against the base', () => {
  assert.equal(move.moveTarget('~/wt', '/a/b', '/home/u'), '/home/u/wt');
  assert.equal(move.moveTarget('~', '/a/b', '/home/u'), '/home/u');
  assert.equal(move.moveTarget('../wt', '/a/b', '/home/u'), '/a/wt');
  assert.equal(move.moveTarget('/x/y/', '/a/b', '/home/u'), '/x/y');
});
