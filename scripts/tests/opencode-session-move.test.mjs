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
  const system = join(base, 'system');
  return { base, project, worktree, xdg, system, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
function installAgent(dir, sub = '.opencode/agents') {
  mkdirSync(join(dir, sub, 'sterling'), { recursive: true });
  writeFileSync(join(dir, sub, 'sterling', 'implementor.md'), '---\ndescription: fixture\nmode: subagent\n---\nbody\n');
}

/** The plugin set up at `directory`; `sessions` maps a session id to its session.get result (a function value throws). */
async function setup(t, sessions, env = { XDG_CONFIG_HOME: t.xdg }, extra = {}) {
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
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async () => {}, env, opencodeSystemDir: t.system, opencodeManagedPrefs: [], ...extra });
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

// Sol re-check findings (board 95a6b0eb): the V2 `agents` key defines an agent, and a
// `disabled` / `disable` entry removes it, in the config order opencode.ai/v2/docs/config
// documents (direct opencode.json files before .opencode/opencode.json files, farthest
// ancestor first); where the docs give no order the move is refused, not guessed.
const move1 = (s, t) => s.before({ tool: 'opencode_session_move', sessionID: 'ses_lane', agent: AGENT, input: { directory: t.worktree } });

test('V2 native agents: an agent defined under `agents` in OPENCODE_CONFIG_CONTENT is visible (Sol repro 1)', async () => {
  const t = makeTree();
  const s = await setup(t, own(t), { XDG_CONFIG_HOME: t.xdg, OPENCODE_CONFIG_CONTENT: JSON.stringify({ agents: { [AGENT]: { mode: 'subagent', system: 'fixture' } } }) });
  try {
    await move1(s, t);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('V2 native agents in the destination opencode.json are visible', async () => {
  const t = makeTree();
  writeFileSync(join(t.worktree, 'opencode.json'), JSON.stringify({ agents: { [AGENT]: { mode: 'subagent' } } }));
  const s = await setup(t, own(t));
  try {
    await move1(s, t);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('a legacy `agent` entry with disable: true is not an available agent: the move is refused (Sol repro 2)', async () => {
  const t = makeTree();
  writeFileSync(join(t.worktree, 'opencode.json'), JSON.stringify({ agent: { [AGENT]: { disable: true } } }));
  const s = await setup(t, own(t));
  try {
    await assert.rejects(move1(s, t), /would not see sterling\/implementor/);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('a native `disabled: true` entry is not an available agent either', async () => {
  const t = makeTree();
  writeFileSync(join(t.worktree, 'opencode.json'), JSON.stringify({ agents: { [AGENT]: { disabled: true } } }));
  const s = await setup(t, own(t));
  try {
    await assert.rejects(move1(s, t), /would not see sterling\/implementor/);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('a disable in a lower-precedence source is overridden by a later definition: direct opencode.json disables, .opencode/opencode.json defines', async () => {
  const t = makeTree();
  writeFileSync(join(t.worktree, 'opencode.json'), JSON.stringify({ agent: { [AGENT]: { disable: true } } }));
  mkdirSync(join(t.worktree, '.opencode'));
  writeFileSync(join(t.worktree, '.opencode', 'opencode.json'), JSON.stringify({ agents: { [AGENT]: { mode: 'subagent', system: 'x' } } }));
  const s = await setup(t, own(t));
  try {
    await move1(s, t);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('a disable in a higher-precedence source wins: an ancestor definition, then the closer .opencode/opencode.json disables', async () => {
  const t = makeTree();
  const dest = join(t.worktree, 'pkg');
  mkdirSync(join(dest, '.opencode'), { recursive: true });
  writeFileSync(join(t.worktree, 'opencode.json'), JSON.stringify({ agents: { [AGENT]: { mode: 'subagent' } } }));
  writeFileSync(join(dest, '.opencode', 'opencode.json'), JSON.stringify({ agents: { [AGENT]: { disabled: true } } }));
  const s = await setup(t, own(t));
  try {
    await assert.rejects(s.before({ tool: 'opencode_session_move', sessionID: 'ses_lane', agent: AGENT, input: { directory: dest } }), /would not see sterling\/implementor/);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('within one document the native V2 entry wins over the legacy one', async () => {
  const t = makeTree();
  writeFileSync(join(t.worktree, 'opencode.json'), JSON.stringify({ agent: { [AGENT]: { mode: 'subagent' } }, agents: { [AGENT]: { disabled: true } } }));
  const s = await setup(t, own(t));
  try {
    await assert.rejects(move1(s, t), /would not see sterling\/implementor/);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('fail closed: a disable plus a definition from a source the docs give no order for (an agent file) refuses with the retry message', async () => {
  const t = makeTree();
  installAgent(t.worktree);
  writeFileSync(join(t.worktree, 'opencode.json'), JSON.stringify({ agents: { [AGENT]: { disabled: true } } }));
  const s = await setup(t, own(t));
  try {
    await assert.rejects(move1(s, t), (e) => {
      assert.match(e.message, /could not check whether the moved session's agent would still be found/);
      assert.match(e.message, /both defined and disabled, and the OpenCode V2 docs give no load order for /);
      assert.match(e.message, /Try the move again/);
      return true;
    });
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

// The system config dir (/etc/opencode on Linux; injected here) outranks every other
// config document (opencode.ai/v2/docs/config, "Locations").
test('a disable in the system config dir outranks a definition in the destination .opencode/opencode.json', async () => {
  const t = makeTree();
  mkdirSync(join(t.worktree, '.opencode'));
  writeFileSync(join(t.worktree, '.opencode', 'opencode.json'), JSON.stringify({ agent: { [AGENT]: { mode: 'subagent' } } }));
  mkdirSync(t.system);
  writeFileSync(join(t.system, 'opencode.json'), JSON.stringify({ agents: { [AGENT]: { disabled: true } } }));
  const s = await setup(t, own(t));
  try {
    await assert.rejects(move1(s, t), /would not see sterling\/implementor/);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('an agent file in the system config dir makes the agent visible', async () => {
  const t = makeTree();
  installAgent(t.system, 'agents');
  const s = await setup(t, own(t));
  try {
    await move1(s, t);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('present macOS managed preferences make the answer unknown, so the move is refused with the retry message', async () => {
  const t = makeTree();
  installAgent(t.worktree);
  const plist = join(t.base, 'ai.opencode.managed.plist');
  writeFileSync(plist, '<plist/>');
  const s = await setup(t, own(t), undefined, { opencodeManagedPrefs: [plist, join(t.base, 'absent.plist')] });
  try {
    await assert.rejects(move1(s, t), /could not check .*managed preferences \(.*ai\.opencode\.managed\.plist\)/);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

// Sol review of sterling/agent-discovery-v2-agents (d8ccaf32), findings (a) and (b).
const disabledAgentFile = (dir) => {
  mkdirSync(join(dir, '.opencode', 'agents', 'sterling'), { recursive: true });
  writeFileSync(join(dir, '.opencode', 'agents', 'sterling', 'implementor.md'), '---\ndescription: fixture\nmode: subagent\ndisabled: true\n---\nbody\n');
};

test('(a) a Markdown agent file with disabled: true frontmatter is not an available agent: the move is refused', async () => {
  const t = makeTree();
  disabledAgentFile(t.worktree);
  const s = await setup(t, own(t));
  try {
    await assert.rejects(move1(s, t), /would not see sterling\/implementor/);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

test('(a) a disabled Markdown agent plus a config definition has no documented order: refused with the retry message', async () => {
  const t = makeTree();
  disabledAgentFile(t.worktree);
  writeFileSync(join(t.worktree, 'opencode.json'), JSON.stringify({ agents: { [AGENT]: { mode: 'subagent' } } }));
  const s = await setup(t, own(t));
  try {
    await assert.rejects(move1(s, t), /could not check .*both defined and disabled/);
  } finally {
    await s.cleanup?.();
    t.cleanup();
  }
});

for (const [label, inDir, inDest] of [
  ['disables, the destination .opencode/opencode.json defines', { disabled: true }, { mode: 'subagent' }],
  ['defines, the destination .opencode/opencode.json disables', { mode: 'subagent' }, { disabled: true }],
]) {
  test(`(b) a replaced OPENCODE_CONFIG_DIR has no documented rank: its opencode.json ${label}, refused with the retry message`, async () => {
    const t = makeTree();
    const ocdir = join(t.base, 'ocdir');
    mkdirSync(ocdir);
    writeFileSync(join(ocdir, 'opencode.json'), JSON.stringify({ agents: { [AGENT]: inDir } }));
    mkdirSync(join(t.worktree, '.opencode'));
    writeFileSync(join(t.worktree, '.opencode', 'opencode.json'), JSON.stringify({ agents: { [AGENT]: inDest } }));
    const s = await setup(t, own(t), { XDG_CONFIG_HOME: t.xdg, OPENCODE_CONFIG_DIR: ocdir });
    try {
      await assert.rejects(move1(s, t), /could not check .*both defined and disabled, and the OpenCode V2 docs give no load order for .*ocdir\/opencode\.json/);
    } finally {
      await s.cleanup?.();
      t.cleanup();
    }
  });
}

test('moveTarget expands ~ and resolves a relative path against the base', () => {
  assert.equal(move.moveTarget('~/wt', '/a/b', '/home/u'), '/home/u/wt');
  assert.equal(move.moveTarget('~', '/a/b', '/home/u'), '/home/u');
  assert.equal(move.moveTarget('../wt', '/a/b', '/home/u'), '/a/wt');
  assert.equal(move.moveTarget('/x/y/', '/a/b', '/home/u'), '/x/y');
});

test('opencodeSystemDir gives the documented path per platform, and null where the docs give none', async () => {
  const install = await import(pathToFileURL(join(repo, 'scripts', 'lib', 'opencode-install.mjs')).href);
  assert.equal(install.opencodeSystemDir({ platform: 'linux', env: {} }), '/etc/opencode');
  assert.equal(install.opencodeSystemDir({ platform: 'darwin', env: {} }), '/Library/Application Support/opencode');
  assert.equal(install.opencodeSystemDir({ platform: 'win32', env: { ProgramData: 'C:\\ProgramData' } }), join('C:\\ProgramData', 'opencode'));
  assert.equal(install.opencodeSystemDir({ platform: 'win32', env: {} }), null);
  assert.equal(install.opencodeSystemDir({ platform: 'freebsd', env: {} }), null);
  assert.deepEqual(install.opencodeManagedPrefs({ platform: 'linux', env: { USER: 'u' } }), []);
  assert.deepEqual(install.opencodeManagedPrefs({ platform: 'darwin', env: { USER: 'u' } }), ['/Library/Managed Preferences/u/ai.opencode.managed.plist', '/Library/Managed Preferences/ai.opencode.managed.plist']);
});
