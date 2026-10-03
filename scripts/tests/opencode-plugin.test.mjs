// The Sterling OpenCode 2 server plugin (decision
// sterling-on-opencode-2-is-the-knowledge-loop-in-one-small-plugin): four
// handlers driven through a stubbed plugin context. The opt-in live smoke at
// the bottom runs only with STERLING_OC_LIVE=1 against a real OpenCode 2.0.21.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-10-02T12:00:00.000Z';

let SterlingStore;
let server;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  server = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'server.mjs')).href);
});

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const git = (dir, args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function envelope(type) {
  return { id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
}

function addArticle(store, slug, files) {
  return store.create({
    ...envelope('feature_article'),
    slug,
    title: `${slug} title`,
    what_it_does: `${slug} does the thing`,
    intended_behavior: 'x',
    files: files.map((f) => ({ path: f.path, role: 'impl' })),
    file_baselines: Object.fromEntries(files.map((f) => [f.path, sha(f.content)])),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
  });
}

/** A git repo with a Sterling store, one committed file owned by one article. */
function makeProject({ withGit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-plugin-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'fixture-proj' }));
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const article = addArticle(store, 'alpha-feature', [{ path: 'src/a.mjs', content: 'export const a = 1;\n' }]);
  store.create({ ...envelope('todo'), text: 'a user board item', source: 'user' });
  store.close();
  if (withGit) {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 't@example.com']);
    git(dir, ['config', 'user.name', 't']);
    git(dir, ['config', 'core.autocrlf', 'false']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'init']);
  }
  return { dir, article, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A stub of the OpenCode 2 plugin context: records hook registrations and feeds events. */
function stubCtx(directory, sessions = {}) {
  const hooks = { session: {}, tool: {}, transforms: { command: [], skill: [], mcp: [] } };
  const queue = [];
  let wake = null;
  return {
    hooks,
    location: { directory },
    session: {
      hook: async (name, fn) => void (hooks.session[name] = fn),
      // OpenCode 2.0.21: session.get({ sessionID }) -> SessionInfo { id, parentID?, time: { created } }.
      get: async ({ sessionID }) => {
        const s = sessions[sessionID];
        if (s instanceof Error) throw s;
        if (!s) throw new Error(`no session ${sessionID}`);
        return { id: sessionID, ...s };
      },
    },
    tool: { hook: async (name, fn) => void (hooks.tool[name] = fn) },
    // Registration surfaces (config.mjs): each transform callback is kept; tests run them when they need to.
    command: { transform: async (cb) => (hooks.transforms.command.push(cb), { dispose: async () => {} }) },
    skill: { transform: async (cb) => (hooks.transforms.skill.push(cb), { dispose: async () => {} }) },
    mcp: { transform: async (cb) => (hooks.transforms.mcp.push(cb), { dispose: async () => {} }) },
    event: {
      subscribe: ({ signal } = {}) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) {
            if (queue.length) yield queue.shift();
            else await new Promise((r) => (wake = r));
          }
        },
      }),
    },
    emit(ev) {
      queue.push(ev);
      wake?.();
    },
  };
}

// The default knows ses_1 as a root session (no parentID): only a root session settles (dispatch.mjs rootSessionGate).
async function setupPlugin(dir, deps = {}, sessions = { ses_1: {} }) {
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, ...deps });
  const ctx = stubCtx(dir, sessions);
  const cleanup = await plugin.setup(ctx);
  return { plugin, ctx, cleanup };
}

const contextInput = () => ({ sessionID: 'ses_1', agent: 'build', system: [{ type: 'text', text: 'base system' }], messages: [], tools: {} });
const systemText = (i) => i.system.map((p) => p.text).join('\n');

test('outside a Sterling project every handler is silent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-none-'));
  try {
    const { ctx, plugin, cleanup } = await setupPlugin(dir);
    const ci = contextInput();
    await ctx.hooks.session.context(ci);
    assert.deepEqual(ci.system, [{ type: 'text', text: 'base system' }]);
    const call = { tool: 'edit', sessionID: 'ses_1', id: 'c1', input: { path: join(dir, 'x.mjs') } };
    await ctx.hooks.tool['execute.before'](call);
    const after = { ...call, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } };
    await ctx.hooks.tool['execute.after'](after);
    assert.deepEqual(after.result.content, [{ type: 'text', text: 'ok' }]);
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    assert.equal(existsSync(join(dir, '.sterling')), false, 'nothing written outside a Sterling project');
    await cleanup?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a Sterling project setup runs the bootstrap registration, not configure, and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-none-'));
  try {
    const configured = [];
    const bootstrapped = [];
    const { ctx, cleanup } = await setupPlugin(dir, { configure: async (c) => void configured.push(c), bootstrap: async (c) => void bootstrapped.push(c) });
    assert.deepEqual(configured, [], 'configure needs a store and is not called');
    assert.deepEqual(bootstrapped, [ctx], 'the bootstrap registration ran once, at setup');
    await cleanup?.();
    const plain = await setupPlugin(dir);
    const t = plain.ctx.hooks.transforms;
    assert.deepEqual([t.command.length, t.skill.length, t.mcp.length], [1, 0, 0], 'the default bootstrap registers commands only');
    const names = [];
    t.command[0]({ add: (d) => names.push(d.name) });
    assert.deepEqual(names.sort(), ['sterling:init', 'sterling:projects'], '/sterling:init exists before init');
    assert.equal(existsSync(join(dir, '.sterling')), false, 'nothing written outside a Sterling project');
    await plain.cleanup?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Every file under dir (but .git), as relative path -> content hash: a write anywhere changes it. */
function treeSnapshot(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out[r] = sha(readFileSync(join(d, e.name), 'latin1'));
    }
  };
  walk(dir, '');
  return out;
}

/** Project A seeded so any sweep, settlement or notice read would change its tree: a register file and a pending notice. */
function seedBoundaryState(dir, marker) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), '[]');
  writeFileSync(join(dir, server.NOTICES_REL), JSON.stringify([{ id: `n-${marker}`, at: NOW, text: `NOTICE-${marker}` }]));
}

// Board item opencode-plugin-acted-on-the-wrong-project-measured-2026-10: OpenCode 2 loads the plugin
// module once per process and calls the one exported object's setup once per location (directory).
// The service's own location (its cwd) was set up after the session's, and every handler then
// acted on the service cwd's project.
test('a service whose cwd is project A acts only on the session\'s project B: nothing is written under A', async () => {
  const a = makeProject();
  const b = makeProject();
  const cwd = process.cwd();
  try {
    seedBoundaryState(a.dir, 'A');
    seedBoundaryState(b.dir, 'B');
    process.chdir(a.dir);
    const synced = [];
    const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async (root, sid) => void synced.push([root, sid]) });
    const ctxB = stubCtx(b.dir, { ses_b: {} });
    const ctxA = stubCtx(a.dir, { ses_a: {} });
    const before = treeSnapshot(a.dir);
    // The session's location is set up first, the service cwd's location after it (the measured order).
    const cleanB = await plugin.setup(ctxB);
    const cleanA = await plugin.setup(ctxA);

    const ci = { ...contextInput(), sessionID: 'ses_b' };
    await ctxB.hooks.session.context(ci);
    await ctxB.hooks.tool['execute.before']({ tool: 'edit', sessionID: 'ses_b', id: 'c1', input: { path: 'src/a.mjs' } });
    await ctxB.hooks.tool['execute.after']({ tool: 'edit', sessionID: 'ses_b', id: 'c1', input: { path: 'src/a.mjs' }, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } });
    // The event names its location; a location-wide or process-wide subscription delivers it to both.
    const ended = { type: 'session.execution.succeeded', location: { directory: b.dir }, data: { sessionID: 'ses_b' } };
    ctxA.emit(ended);
    ctxB.emit(ended);
    await plugin.idle();

    assert.deepEqual(treeSnapshot(a.dir), before, 'nothing under the service cwd project A is written');
    assert.match(systemText(ci), /NOTICE-B/, 'the session context shows B\'s notices');
    assert.doesNotMatch(systemText(ci), /NOTICE-A/, 'and never A\'s');
    assert.deepEqual(synced, [[b.dir.replace(/\\/g, '/'), 'ses_b']], 'the post-update sync runs for B only');
    assert.equal(existsSync(join(b.dir, '.sterling', 'transient', 'dispatch-register.json')), false, 'B\'s startup sweep ran');
    assert.ok(existsSync(settledPath(b.dir)), 'B\'s session end settled B');
    await cleanA?.();
    await cleanB?.();
  } finally {
    process.chdir(cwd);
    a.cleanup();
    b.cleanup();
  }
});

test('a session in a non-Sterling directory writes nothing anywhere, even with a Sterling project as the service cwd', async () => {
  const a = makeProject();
  const none = mkdtempSync(join(tmpdir(), 'sterling-oc-none-'));
  const cwd = process.cwd();
  try {
    seedBoundaryState(a.dir, 'A');
    process.chdir(a.dir);
    const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, bootstrap: async () => {} });
    const ctxN = stubCtx(none, { ses_n: {} });
    const ctxA = stubCtx(a.dir, { ses_a: {} });
    const before = treeSnapshot(a.dir);
    const cleanN = await plugin.setup(ctxN);
    const cleanA = await plugin.setup(ctxA);
    const ci = { ...contextInput(), sessionID: 'ses_n' };
    await ctxN.hooks.session.context(ci);
    await ctxN.hooks.tool['execute.before']({ tool: 'edit', sessionID: 'ses_n', id: 'c1', input: { path: join(none, 'x.mjs') } });
    const ended = { type: 'session.execution.succeeded', location: { directory: none }, data: { sessionID: 'ses_n' } };
    ctxA.emit(ended);
    ctxN.emit(ended);
    await plugin.idle();
    assert.deepEqual(ci.system, [{ type: 'text', text: 'base system' }], 'the non-Sterling session gets no Sterling context');
    assert.deepEqual(treeSnapshot(a.dir), before, 'nothing under the service cwd project is written');
    assert.deepEqual(treeSnapshot(none), {}, 'nothing is written into the non-Sterling directory');
    await cleanA?.();
    await cleanN?.();
  } finally {
    process.chdir(cwd);
    a.cleanup();
    rmSync(none, { recursive: true, force: true });
  }
});

test('a setup without ctx.location.directory registers nothing and says so on stderr; it never falls back to the cwd', async () => {
  const a = makeProject();
  const cwd = process.cwd();
  const writes = [];
  const realWrite = process.stderr.write;
  try {
    seedBoundaryState(a.dir, 'A');
    process.chdir(a.dir);
    const before = treeSnapshot(a.dir);
    const configured = [];
    const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async (c) => void configured.push(c), bootstrap: async (c) => void configured.push(c) });
    const ctx = stubCtx(undefined, { ses_1: {} });
    process.stderr.write = (s) => (writes.push(String(s)), true);
    try {
      await plugin.setup({ ...ctx, location: undefined });
    } finally {
      process.stderr.write = realWrite;
    }
    assert.deepEqual(ctx.hooks.session, {}, 'no session hook is registered');
    assert.deepEqual(ctx.hooks.tool, {}, 'no tool hook is registered');
    assert.deepEqual(configured, [], 'neither configure nor bootstrap runs');
    assert.ok(writes.some((w) => /ctx\.location\.directory/.test(w)), 'the skip is reported on stderr');
    assert.deepEqual(treeSnapshot(a.dir), before, 'the cwd project is untouched');
  } finally {
    process.stderr.write = realWrite;
    process.chdir(cwd);
    a.cleanup();
  }
});

test('the startup sweep runs once per project per process, across locations of the same project', async () => {
  const a = makeProject();
  try {
    const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async () => {} });
    const ctx1 = stubCtx(a.dir, { ses_1: {} });
    mkdirSync(join(a.dir, 'src', 'sub'), { recursive: true });
    const ctx2 = stubCtx(join(a.dir, 'src', 'sub'), { ses_2: {} });
    await plugin.setup(ctx1);
    await plugin.setup(ctx2);
    await ctx1.hooks.session.context({ ...contextInput(), sessionID: 'ses_1' });
    // A dispatch armed after the first sweep must survive the second location's first root context.
    seedBoundaryState(a.dir, 'A');
    await ctx2.hooks.session.context({ ...contextInput(), sessionID: 'ses_2' });
    assert.ok(existsSync(join(a.dir, '.sterling', 'transient', 'dispatch-register.json')), 'the second location does not sweep the same project again');
  } finally {
    a.cleanup();
  }
});

test('session context injects the Sterling layer, the OpenCode host tail, a status line and pending notices', async () => {
  const p = makeProject();
  try {
    mkdirSync(join(p.dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(p.dir, server.NOTICES_REL), JSON.stringify([{ id: 'n1', at: NOW, text: 'NOTICE-MARKER-7 owed reconcile' }]));
    const { ctx, cleanup } = await setupPlugin(p.dir);
    const ci = contextInput();
    await ctx.hooks.session.context(ci);
    const text = systemText(ci);
    assert.match(text, /# CLAUDE\.md — fixture-proj \(Sterling layer\)/, 'template rendered with the project name');
    assert.match(text, /## Authority \(the knowledge base is the source of truth\)/);
    assert.doesNotMatch(text, /\{\{PROJECT_NAME\}\}/);
    assert.match(text, /OpenCode host/);
    assert.match(text, /`question` tool/);
    assert.ok(text.includes(`Sterling is installed at \`${server.sterlingRoot()}\``), 'the layer names the resolved Sterling root');
    assert.match(text, /no stop block/i);
    assert.match(text, /conductor/);
    assert.match(text, /STERLING STATUS: board 1 open, maintenance queue 0, store schema v\d+ \(current\)/);
    assert.match(text, /NOTICE-MARKER-7 owed reconcile/);
    assert.equal(ci.system[0].text, 'base system', 'the host system prompt is kept first');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('the host tail names the Sterling root and the Claude Code surfaces OpenCode lacks', () => {
  const tail = server.opencodeHostTail('/opt/sterling-x');
  for (const term of ['`/opt/sterling-x`', '/opt/sterling-x/bin/', '/opt/sterling-x/commands/', '/opt/sterling-x/skills/', 'CLAUDE_PLUGIN_ROOT', '/plugin', '--plugin-dir', '.claude/agents', 'stop block', 'conductor', '`subagent` tool', 'next turn']) {
    assert.ok(tail.includes(term), `host tail names ${term}`);
  }
  assert.ok(!tail.includes('${CLAUDE_PLUGIN_ROOT}'), 'the tail names the variable without the shell form, so the layer greps clean');
  assert.match(tail, /Sterling's commands are registered as OpenCode slash commands under the same names/, 'config.mjs registers the commands, so the tail says so');
  assert.doesNotMatch(tail, /Slash commands[^.]*absent/, 'slash commands are not described as absent');
  assert.match(server.opencodeHostTail(null), /could not be resolved/, 'an unresolved root is said out loud');
});

test('the Sterling root comes from one function: the plugin root above the module, which holds the template and bin/', () => {
  const root = server.sterlingRoot();
  assert.equal(root, repo.replace(/\/$/, ''));
  assert.equal(server.defaultTemplatePath(), join(root, 'templates', 'target-claude-md.md'));
  assert.ok(existsSync(join(root, 'bin', 'concept-designed.mjs')));
  // The committed bundle sits one level below the root and resolves the same root.
  assert.equal(server.sterlingRoot(pathToFileURL(join(repo, 'opencode', 'sterling-server.mjs')).href), root);
  assert.throws(() => server.sterlingRoot(pathToFileURL(join(tmpdir(), 'nowhere', 'x.mjs')).href), /no Sterling plugin root/);
});

test('the injected layer is fully host-mapped: no unmapped Claude-only phrase, every named Sterling file exists', () => {
  const p = makeProject({ withGit: false });
  try {
    const root = server.sterlingRoot();
    const layer = server.renderSterlingLayer(p.dir, root);
    for (const claudeOnly of ['${CLAUDE_PLUGIN_ROOT}', 'READY TO CLEAR', '/clear', 'AskUserQuestion', '@AGENTS.md', 'sterling:de-ai-writing', 'H22 warns', 'H10 holds the demand', 'H19 delivery helps', '(Enforced: H15', 'session-start banner prints', 'backgrounds itself and returns', "Claude Code's hook, frontmatter and transcript mechanics move"]) {
      assert.ok(!layer.includes(claudeOnly), `layer still carries the Claude-only phrase ${claudeOnly}`);
    }
    assert.match(layer, /^- \*\*Say `READY FOR NEW SESSION` plainly when it is time\.\*\*.*\/new/m, 'the clear line is the ruled new-session line');
    assert.match(layer, /through OpenCode's `question` tool\.\*\*/);
    assert.match(layer, /\.opencode\/agents\/sterling\/conductor\.md/);
    assert.match(layer, /default_agent/);
    assert.match(layer, /reconcile_needed.*STERLING NOTICE/s, 'H7 is mapped to settlement notices');
    // Settlement mints all four H10 duties on this branch (settle.mjs), so the layer says so
    // instead of disclosing them as missing (the old expectation encoded the earlier gap).
    assert.match(layer, /capture_owed.*article_missing.*concept_article_missing.*research_owed/s, 'the four H10 duties are named as minted');
    assert.doesNotMatch(layer, /not minted on OpenCode yet|OpenCode does not mint it yet/, 'no stale disclosure of missing H10 duties');
    assert.doesNotMatch(layer, /not yet to shell or patch|but not the shell/, 'no stale disclosure of shell and patch gaps');
    assert.match(layer, /codex.*MCP server is configured/s);
    // Every /sterling:<command> named in the layer carries its OpenCode equivalent.
    for (const m of layer.matchAll(/\/sterling:([a-z][a-z-]*)/g)) {
      const after = layer.slice(m.index, m.index + 200);
      assert.ok(after.includes(`${root}/commands/${m[1]}.md`), `/sterling:${m[1]} is mapped to its command file`);
    }
    // Every Sterling path the layer names resolves on disk.
    const named = [...layer.matchAll(new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[\\w./-]*[\\w]`, 'g'))].map((m) => m[0]);
    for (const want of ['bin/concept-designed.mjs', 'bin/rotation-note.mjs', 'skills/de-ai-writing/SKILL.md', 'skills/de-ai-writing/scripts/check-ai-signs.mjs', '.claude-plugin/plugin.json']) {
      assert.ok(named.includes(`${root}/${want}`), `layer names ${want} under the root`);
    }
    for (const path of named) assert.ok(existsSync(path), `${path} named in the layer exists`);
  } finally {
    p.cleanup();
  }
});

test('template drift is loud: invalid host blocks fail the render; an unmapped Claude-only phrase or command is flagged at the top of the layer', () => {
  const p = makeProject({ withGit: false });
  const fake = mkdtempSync(join(tmpdir(), 'sterling-oc-fake-root-'));
  try {
    const root = server.sterlingRoot();
    const real = readFileSync(join(root, 'templates', 'target-claude-md.md'), 'utf8');
    mkdirSync(join(fake, 'templates'));
    mkdirSync(join(fake, 'commands'));
    for (const c of ['task', 'drain']) writeFileSync(join(fake, 'commands', `${c}.md`), 'x');
    const tpl = join(fake, 'templates', 'target-claude-md.md');
    writeFileSync(tpl, real.replace('<!-- /opencode-only -->', ''));
    assert.throws(() => server.renderSterlingLayer(p.dir, fake), /host blocks invalid.*fence/s);
    writeFileSync(tpl, `${real}\n- run \`node "\${CLAUDE_PLUGIN_ROOT}/bin/new-thing.mjs"\`\n`);
    const rooted = server.renderSterlingLayer(p.dir, fake);
    assert.ok(rooted.includes(`\`node "${fake}/bin/new-thing.mjs"\``), 'any plugin-root reference becomes the resolved root');
    assert.doesNotMatch(rooted, /STERLING LAYER HOST CHECK/);
    writeFileSync(tpl, `${real}\n- then print READY TO CLEAR and run /clear\n`);
    assert.match(server.renderSterlingLayer(p.dir, fake), /^STERLING LAYER HOST CHECK.*Claude-only phrase\(s\) left in the text: READY TO CLEAR, \/clear\./s);
    writeFileSync(tpl, `${real}\n- drained by \`/sterling:nosuch\`\n`);
    assert.match(server.renderSterlingLayer(p.dir, fake), /^STERLING LAYER HOST CHECK.*\/sterling:nosuch.*commands\/nosuch\.md/s);
  } finally {
    p.cleanup();
    rmSync(fake, { recursive: true, force: true });
  }
});

test('a store that fails to open degrades the context loudly instead of taking the plugin down', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setupPlugin(p.dir, {
      openStore: () => {
        throw new Error('simulated open failure');
      },
    });
    const ci = contextInput();
    await ctx.hooks.session.context(ci);
    const text = systemText(ci);
    assert.match(text, /Sterling layer\)/, 'the layer is still injected');
    assert.match(text, /STERLING STATUS: store unavailable \(simulated open failure\)/);
    assert.match(readFileSync(join(p.dir, server.LOG_REL), 'utf8'), /simulated open failure/);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('an internal error in a tool hook is swallowed, logged and surfaced as a notice', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setupPlugin(p.dir, {
      openStore: () => {
        throw new Error('boom in delivery');
      },
    });
    const call = { tool: 'edit', sessionID: 'ses_1', id: 'c9', input: { path: join(p.dir, 'src', 'a.mjs') } };
    await ctx.hooks.tool['execute.before'](call);
    const after = { ...call, status: 'completed', result: { content: [{ type: 'text', text: 'edited' }] } };
    await ctx.hooks.tool['execute.after'](after);
    assert.deepEqual(after.result.content, [{ type: 'text', text: 'edited' }], 'the tool result is untouched');
    assert.match(readFileSync(join(p.dir, server.LOG_REL), 'utf8'), /delivery.*boom in delivery/);
    const notices = JSON.parse(readFileSync(join(p.dir, server.NOTICES_REL), 'utf8'));
    assert.ok(notices.some((n) => /boom in delivery/.test(n.text)), 'the failure becomes a notice the next context shows');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

const NOTE_AT = '2026-10-02T10:00:00.000Z';
const writeNote = (dir, extra = {}) => {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'transient', 'rotation-note.json'), JSON.stringify({ next_slice: 'ROTATION-SLICE-42', session_id: 'ses_old', session_host: 'opencode', lanes: ['lane x'], at: NOTE_AT, ...extra }));
};
const noteExists = (dir) => existsSync(join(dir, '.sterling', 'transient', 'rotation-note.json'));
const after = Date.parse(NOTE_AT) + 60_000;
const contextFor = async (ctx, sessionID) => {
  const ci = { ...contextInput(), sessionID };
  await ctx.hooks.session.context(ci);
  return systemText(ci);
};

test('rotation restore: the first new root session gets the note once and consumes it; it stays for that session; the next new session does not get it', async () => {
  const p = makeProject();
  try {
    writeNote(p.dir);
    const { ctx, cleanup } = await setupPlugin(p.dir, {}, { ses_new: { time: { created: after } }, ses_next: { time: { created: after + 1 } } });
    const first = await contextFor(ctx, 'ses_new');
    assert.match(first, /ROTATION RESTORE \(Sterling OpenCode plugin\)/);
    assert.match(first, /ROTATION-SLICE-42/);
    assert.match(first, /`opencode --session ses_old`/);
    assert.equal(noteExists(p.dir), false, 'consumed');
    assert.equal((first.match(/ROTATION RESTORE/g) ?? []).length, 1);
    assert.match(await contextFor(ctx, 'ses_new'), /ROTATION-SLICE-42/, 'the restore stays in that session\'s later turns');
    assert.doesNotMatch(await contextFor(ctx, 'ses_next'), /ROTATION RESTORE/, 'a second new session does not get it');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('the maintenance worker child (STERLING_MAINTENANCE_WORKER=1) leaves the rotation note, the pending notices and the TUI selection for the user\'s session', async () => {
  const p = makeProject();
  try {
    writeNote(p.dir);
    server.addNotice(p.dir, 'A NOTICE FOR THE USER', NOW);
    const s = new SterlingStore(join(p.dir, '.sterling', 'sterling.db'));
    s.writeSelection('feature_article', p.article.id, NOW);
    s.close();
    const worker = await setupPlugin(p.dir, { env: { STERLING_MAINTENANCE_WORKER: '1' } }, { ses_worker: { time: { created: after } } });
    const text = await contextFor(worker.ctx, 'ses_worker');
    assert.match(text, /STERLING STATUS/, 'the worker child still gets its context');
    assert.doesNotMatch(text, /ROTATION RESTORE|A NOTICE FOR THE USER/);
    assert.equal(noteExists(p.dir), true, 'the rotation note is not consumed');
    const pi = promptInput('judge the queue');
    await worker.ctx.hooks.session.prompt(pi);
    assert.equal(pi.prompt.text, 'judge the queue', 'the selection is not appended');
    await worker.cleanup?.();

    const user = await setupPlugin(p.dir, {}, { ses_user: { time: { created: after } } });
    const userText = await contextFor(user.ctx, 'ses_user');
    assert.match(userText, /ROTATION-SLICE-42/, "the user's new session gets the restore");
    assert.match(userText, /A NOTICE FOR THE USER/, 'and the notice, still unshown');
    const up = promptInput('next');
    await user.ctx.hooks.session.prompt(up);
    assert.match(up.prompt.text, /TUI selection \(one-shot\)/, 'and the selection');
    await user.cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('rotation restore: the note stays in place for the old session, a child session, a session older than the note, and when the session cannot be read', async () => {
  const p = makeProject();
  try {
    writeNote(p.dir);
    const { ctx, cleanup } = await setupPlugin(p.dir, {}, {
      ses_old: { time: { created: after } },
      ses_child: { parentID: 'ses_new', time: { created: after } },
      ses_early: { time: { created: Date.parse(NOTE_AT) - 1 } },
      ses_broken: new Error('server said no'),
      ses_notime: {},
    });
    for (const sid of ['ses_old', 'ses_child', 'ses_early']) {
      assert.doesNotMatch(await contextFor(ctx, sid), /ROTATION RESTORE/, sid);
      assert.equal(noteExists(p.dir), true, `${sid} leaves the note`);
    }
    const broken = await contextFor(ctx, 'ses_broken');
    assert.doesNotMatch(broken, /ROTATION RESTORE/);
    assert.match(broken, /Sterling layer\)/, 'a failed session lookup costs only the restore');
    assert.equal(noteExists(p.dir), true);
    assert.match(readFileSync(join(p.dir, server.LOG_REL), 'utf8'), /server said no/);
    assert.match(await contextFor(ctx, 'ses_notime'), /ROTATION RESTORE/, 'an unreadable created time does not block a root session with a different id');
    assert.equal(noteExists(p.dir), false);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('rotation restore: a malformed note gets its own notice naming the cause and the remedy, shown once per note file, and the layer survives', async () => {
  const p = makeProject();
  try {
    mkdirSync(join(p.dir, '.sterling', 'transient'), { recursive: true });
    const notePath = join(p.dir, '.sterling', 'transient', 'rotation-note.json');
    writeFileSync(notePath, '{ not json');
    const { ctx, cleanup } = await setupPlugin(p.dir, {}, { ses_new: { time: { created: after } } });
    const first = await contextFor(ctx, 'ses_new');
    assert.match(first, /Sterling layer\)/, 'a malformed note costs only the restore');
    const noticeTexts = () => JSON.parse(readFileSync(join(p.dir, server.NOTICES_REL), 'utf8')).map((n) => n.text);
    const malformed = noticeTexts().filter((t) => /malformed/.test(t));
    assert.equal(malformed.length, 1);
    assert.ok(malformed[0].includes(`delete ${notePath}`), malformed[0]);
    assert.ok(!noticeTexts().some((t) => /could not be checked/.test(t)), 'not the session-check notice');
    assert.match(readFileSync(join(p.dir, server.LOG_REL), 'utf8'), /rotation note malformed/);
    for (let i = 0; i < 3; i++) await contextFor(ctx, 'ses_new');
    assert.equal(noticeTexts().filter((t) => /malformed/.test(t)).length, 1, 'later requests do not repeat it');
    assert.equal(existsSync(notePath), true, 'the note is left in place');
    // a rewritten malformed note is a new note file and is announced again
    const later = new Date(Date.now() + 5000);
    writeFileSync(notePath, '[');
    utimesSync(notePath, later, later);
    await contextFor(ctx, 'ses_new');
    assert.equal(JSON.parse(readFileSync(join(p.dir, server.NOTICES_REL), 'utf8')).filter((n) => /malformed/.test(n.text)).length, 2);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('rotation restore: a root session skipped for its creation time logs the raw time.created and note.at', async () => {
  const p = makeProject();
  try {
    writeNote(p.dir);
    const { ctx, cleanup } = await setupPlugin(p.dir, {}, { ses_early: { time: { created: 1759399000 } } });
    await contextFor(ctx, 'ses_early');
    const log = readFileSync(join(p.dir, server.LOG_REL), 'utf8');
    assert.match(log, /rotation restore skipped for ses_early: created before the note \(time\.created=1759399000, note\.at="2026-10-02T10:00:00\.000Z"/);
    assert.equal(noteExists(p.dir), true);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('rotation restore: a render failure after the note was consumed is logged and costs only the restore', async () => {
  const p = makeProject();
  try {
    writeNote(p.dir);
    const { ctx, cleanup } = await setupPlugin(p.dir, { renderRestore: () => { throw new Error('render boom'); } }, { ses_new: { time: { created: after } } });
    const text = await contextFor(ctx, 'ses_new');
    assert.doesNotMatch(text, /ROTATION RESTORE/);
    assert.match(text, /Sterling layer\)/, 'the layer survives the render failure');
    assert.equal(noteExists(p.dir), false, 'consumed by design');
    assert.match(readFileSync(join(p.dir, server.LOG_REL), 'utf8'), /render failed after the note was consumed: render boom/);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('the layer says the new session restores the note', () => {
  const p = makeProject({ withGit: false });
  try {
    const layer = server.renderSterlingLayer(p.dir, server.sterlingRoot());
    assert.match(layer, /the Sterling plugin restores and consumes it in the new session's first turn/);
    assert.doesNotMatch(layer, /does not restore the rotation note/);
  } finally {
    p.cleanup();
  }
});

test('compaction resets that session\'s delivery receipts, so delivery fires again after context loss; other sessions keep theirs', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setupPlugin(p.dir);
    assert.equal(typeof ctx.hooks.session.compaction, 'function', 'the compaction hook is registered');
    const deliver = async (sessionID, id) => {
      const call = { tool: 'read', sessionID, id, input: { path: 'src/a.mjs' } };
      await ctx.hooks.tool['execute.before'](call);
      const after = { ...call, status: 'completed', result: { content: [{ type: 'text', text: 'read' }] } };
      await ctx.hooks.tool['execute.after'](after);
      return after.result.content.length === 2;
    };
    assert.equal(await deliver('ses_1', 'k1'), true);
    assert.equal(await deliver('ses_2', 'k2'), true);
    assert.equal(await deliver('ses_1', 'k3'), false, 'delivered once per session');
    const compaction = { sessionID: 'ses_1', agent: 'build', system: [], messages: [], tools: {}, options: {} };
    await ctx.hooks.session.compaction(compaction);
    assert.equal(compaction.result, undefined, 'the hook never supplies a compaction result');
    assert.equal(await deliver('ses_1', 'k4'), true, 'after compaction the article is delivered again');
    assert.equal(await deliver('ses_2', 'k5'), false, 'another session keeps its receipts');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('edit, write and read deliver the owning knowledge onto the tool result once per session', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setupPlugin(p.dir);
    const call = { tool: 'edit', sessionID: 'ses_1', id: 'c1', input: { path: join(p.dir, 'src', 'a.mjs') } };
    await ctx.hooks.tool['execute.before'](call);
    const after = { ...call, status: 'completed', result: { content: [{ type: 'text', text: 'edited' }] } };
    await ctx.hooks.tool['execute.after'](after);
    assert.equal(after.result.content.length, 2);
    assert.match(after.result.content[1].text, /STERLING KNOWLEDGE DELIVERY/);
    assert.match(after.result.content[1].text, /alpha-feature/);

    const again = { tool: 'read', sessionID: 'ses_1', id: 'c2', input: { path: 'src/a.mjs' } };
    await ctx.hooks.tool['execute.before'](again);
    const after2 = { ...again, status: 'completed', result: { content: [{ type: 'text', text: 'read' }] } };
    await ctx.hooks.tool['execute.after'](after2);
    assert.equal(after2.result.content.length, 1, 'an article already delivered this session is not repeated');

    const other = { tool: 'write', sessionID: 'ses_2', id: 'c3', input: { path: join(p.dir, 'src', 'a.mjs') } };
    await ctx.hooks.tool['execute.before'](other);
    const after3 = { ...other, status: 'completed', result: { content: 'written' } };
    await ctx.hooks.tool['execute.after'](after3);
    assert.match(String(after3.result.content), /^written[\s\S]*alpha-feature/, 'a string result is appended to');

    const glob = { tool: 'glob', sessionID: 'ses_3', id: 'c4', input: { path: 'src/a.mjs' } };
    await ctx.hooks.tool['execute.before'](glob);
    const after4 = { ...glob, status: 'completed', result: { content: [{ type: 'text', text: 'x' }] } };
    await ctx.hooks.tool['execute.after'](after4);
    assert.equal(after4.result.content.length, 1, 'other tools get no delivery');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('a failed tool call delivers nothing and does not spend the once-per-session guard', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setupPlugin(p.dir);
    const call = { tool: 'edit', sessionID: 'ses_1', id: 'c1', input: { path: join(p.dir, 'src', 'a.mjs') } };
    await ctx.hooks.tool['execute.before'](call);
    await ctx.hooks.tool['execute.after']({ ...call, status: 'error', error: { message: 'no match' } });
    const retry = { ...call, id: 'c2' };
    await ctx.hooks.tool['execute.before'](retry);
    const after = { ...retry, status: 'completed', result: { content: [{ type: 'text', text: 'edited' }] } };
    await ctx.hooks.tool['execute.after'](after);
    assert.match(after.result.content[1]?.text ?? '', /alpha-feature/);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

const settledPath = (dir) => join(dir, '.sterling', 'transient', 'git-settled.json');
const readSettled = (dir) => JSON.parse(readFileSync(settledPath(dir), 'utf8'));
const reconcileItems = (dir) => {
  const s = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    return s.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'reconcile_needed');
  } finally {
    s.close();
  }
};
const succeeded = { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } };

test('settlement mints reconcile duties, then advances the settled snapshot, then leaves a notice', async () => {
  const p = makeProject();
  try {
    const launches = [];
    const { plugin, ctx, cleanup } = await setupPlugin(p.dir, { claudeOnPath: () => true, launchWorker: (o) => launches.push(o.trigger) });
    await plugin.handlers.event(succeeded);
    assert.ok(existsSync(settledPath(p.dir)), 'the first settlement records the tree as it stands');
    assert.deepEqual(reconcileItems(p.dir), []);

    writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 2;\n');
    await plugin.handlers.event(succeeded);
    const items = reconcileItems(p.dir);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].file_keys, ['src/a.mjs']);
    assert.ok(Object.hasOwn(readSettled(p.dir).dirty, 'src/a.mjs'), 'the snapshot advanced past the minted change');
    const notices = JSON.parse(readFileSync(join(p.dir, server.NOTICES_REL), 'utf8'));
    assert.ok(notices.some((n) => /alpha-feature/.test(n.text) && /src\/a\.mjs/.test(n.text)));
    assert.ok(launches.length >= 1, 'the maintenance worker launch is attempted when claude is on PATH');

    const ci = contextInput();
    await ctx.hooks.session.context(ci);
    assert.match(systemText(ci), /alpha-feature/, 'the next context shows the settlement notice');
    await plugin.handlers.event(succeeded);
    const left = existsSync(join(p.dir, server.NOTICES_REL)) ? JSON.parse(readFileSync(join(p.dir, server.NOTICES_REL), 'utf8')) : [];
    assert.ok(!left.some((n) => /alpha-feature/.test(n.text)), 'a notice shown for a whole execution is cleared at its end');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('settlement does not launch the maintenance worker when claude is not on PATH', async () => {
  const p = makeProject();
  try {
    const launches = [];
    const { plugin, cleanup } = await setupPlugin(p.dir, { claudeOnPath: () => false, launchWorker: (o) => launches.push(o) });
    await plugin.handlers.event(succeeded);
    writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 3;\n');
    await plugin.handlers.event(succeeded);
    assert.equal(reconcileItems(p.dir).length, 1);
    assert.deepEqual(launches, []);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('inside the maintenance worker child (STERLING_MAINTENANCE_WORKER=1) the plugin never settles or launches a worker, so it cannot race the parent on the store', async () => {
  const p = makeProject();
  try {
    const launches = [];
    const { plugin, cleanup } = await setupPlugin(p.dir, { claudeOnPath: () => true, launchWorker: (o) => launches.push(o), env: { STERLING_MAINTENANCE_WORKER: '1' } });
    await plugin.handlers.event(succeeded);
    writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 4;\n');
    await plugin.handlers.event(succeeded);
    assert.equal(existsSync(settledPath(p.dir)), false, 'no settled snapshot is written');
    assert.deepEqual(reconcileItems(p.dir), [], 'no reconcile duty is minted');
    assert.deepEqual(launches, []);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('settlement mints but does not advance while a Claude dispatch register has a live row', async () => {
  const p = makeProject();
  try {
    const { plugin, cleanup } = await setupPlugin(p.dir);
    await plugin.handlers.event(succeeded);
    const before = readFileSync(settledPath(p.dir), 'utf8');
    writeFileSync(
      join(p.dir, '.sterling', 'transient', 'dispatch-register.json'),
      JSON.stringify([{ agent_id: 'ag1', session_id: 'claude-s', files: ['src/a.mjs'], at: NOW }])
    );
    writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 4;\n');
    await plugin.handlers.event(succeeded);
    assert.equal(reconcileItems(p.dir).length, 1, 'duties still mint');
    assert.equal(readFileSync(settledPath(p.dir), 'utf8'), before, 'the snapshot stays put while the dispatch is live');
    const notices = JSON.parse(readFileSync(join(p.dir, server.NOTICES_REL), 'utf8'));
    assert.ok(notices.some((n) => /dispatch/.test(n.text)));

    writeFileSync(
      join(p.dir, '.sterling', 'transient', 'dispatch-register.json'),
      JSON.stringify([{ agent_id: 'ag1', session_id: 'claude-s', files: ['src/a.mjs'], at: NOW, ended: { at: NOW, event: 'SubagentStop' } }])
    );
    await plugin.handlers.event(succeeded);
    assert.notEqual(readFileSync(settledPath(p.dir), 'utf8'), before, 'an ended row no longer holds the snapshot');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('a failed mint leaves the settled snapshot where it was', async () => {
  const p = makeProject();
  try {
    let fail = false;
    const { plugin, cleanup } = await setupPlugin(p.dir, {
      openStore: (path) => {
        if (fail) throw new Error('database is locked');
        return new SterlingStore(path);
      },
    });
    await plugin.handlers.event(succeeded);
    const before = readFileSync(settledPath(p.dir), 'utf8');
    writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 5;\n');
    fail = true;
    await plugin.handlers.event(succeeded);
    assert.equal(readFileSync(settledPath(p.dir), 'utf8'), before);
    const notices = JSON.parse(readFileSync(join(p.dir, server.NOTICES_REL), 'utf8'));
    assert.ok(notices.some((n) => /settlement failed.*database is locked/i.test(n.text)));
    fail = false;
    await plugin.handlers.event(succeeded);
    assert.equal(reconcileItems(p.dir).length, 1, 'the next execution retries the same range');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('events reach the settle handler through ctx.event.subscribe', async () => {
  const p = makeProject();
  try {
    const { ctx, plugin, cleanup } = await setupPlugin(p.dir);
    ctx.emit({ type: 'session.updated', data: { sessionID: 'ses_1' } });
    ctx.emit(succeeded);
    await plugin.idle();
    assert.ok(existsSync(settledPath(p.dir)));
    await cleanup();
  } finally {
    p.cleanup();
  }
});

test('in-process store opens use the short busy timeout', () => {
  const p = makeProject();
  try {
    const store = server.openProjectStore(join(p.dir, '.sterling', 'sterling.db'));
    try {
      assert.equal(server.BUSY_TIMEOUT_MS, 1000);
      assert.equal(store['db'].prepare('PRAGMA busy_timeout').get().timeout, 1000);
    } finally {
      store.close();
    }
  } finally {
    p.cleanup();
  }
});

test('the store guard has one source: the installer writes it, the server plugin exports no permission config', async () => {
  assert.equal(server.sterlingPermissionConfig, undefined);
  const { STORE_GUARD_PATTERNS } = await import(pathToFileURL(join(repo, 'scripts', 'lib', 'opencode-install.mjs')).href);
  assert.ok(STORE_GUARD_PATTERNS.includes('.sterling/sterling.db*'));
});

const promptInput = (text) => ({ sessionID: 'ses_1', messageID: 'msg_1', prompt: { text }, delivery: 'immediate' });

test('prompt hook: a pending TUI selection is taken once and appended to the next prompt', async () => {
  const p = makeProject();
  try {
    const s = new SterlingStore(join(p.dir, '.sterling', 'sterling.db'));
    s.writeSelection('feature_article', p.article.id, NOW);
    s.close();
    const { ctx, cleanup } = await setupPlugin(p.dir);
    assert.equal(typeof ctx.hooks.session.prompt, 'function', 'the prompt hook is registered');
    const first = promptInput('what does this do?');
    await ctx.hooks.session.prompt(first);
    assert.match(first.prompt.text, /^what does this do\?\n\n/);
    assert.match(first.prompt.text, new RegExp(`TUI selection \\(one-shot\\): the user has selected feature_article '${p.article.id}'\\. Resolve the selected record via knowledge_get before answering\\.`));
    const second = promptInput('and now?');
    await ctx.hooks.session.prompt(second);
    assert.equal(second.prompt.text, 'and now?', 'one-shot: the selection row was consumed');
    const s2 = new SterlingStore(join(p.dir, '.sterling', 'sterling.db'));
    try {
      assert.equal(s2.takeSelection(), undefined);
    } finally {
      s2.close();
    }
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('prompt hook: no selection leaves the prompt untouched; a store failure becomes a notice, never a throw', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setupPlugin(p.dir);
    const plain = promptInput('hello');
    await ctx.hooks.session.prompt(plain);
    assert.equal(plain.prompt.text, 'hello');
    await cleanup?.();
    const broken = await setupPlugin(p.dir, { openStore: () => { throw new Error('PROMPT-STORE-DOWN'); } });
    const pi = promptInput('hi');
    await broken.ctx.hooks.session.prompt(pi);
    assert.equal(pi.prompt.text, 'hi');
    assert.match(readFileSync(join(p.dir, server.NOTICES_REL), 'utf8'), /prompt failed \(PROMPT-STORE-DOWN\)/);
    await broken.cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('config and session-sync seams are wired: configure runs once at setup, syncSession on every context request', async () => {
  const p = makeProject();
  try {
    const configured = [];
    const synced = [];
    const { ctx, cleanup } = await setupPlugin(p.dir, {
      configure: async (c) => void configured.push(c),
      syncSession: async (root, sessionID) => void synced.push([root, sessionID]),
    });
    assert.deepEqual(configured, [ctx], 'configure received the plugin context once, at setup');
    await contextFor(ctx, 'ses_a');
    await contextFor(ctx, 'ses_b');
    assert.deepEqual(synced.map(([, sid]) => sid), ['ses_a', 'ses_b'], 'the context handler calls syncSession with the session id');
    assert.equal(synced[0][0], p.dir.replace(/\\/g, '/'), 'syncSession receives the project root');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('the default config registers through the three transforms and the session-sync default is a no-op; neither changes the context', async () => {
  const p = makeProject();
  try {
    const { createSessionSync } = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'sync.mjs')).href);
    const syncOnce = createSessionSync();
    assert.equal(await syncOnce(p.dir, 'ses_1'), undefined);
    assert.equal(await syncOnce(p.dir, 'ses_2'), undefined);
    const plain = await setupPlugin(p.dir);
    const noop = await setupPlugin(p.dir, { configure: async () => {}, syncSession: async () => {} });
    const a = await contextFor(plain.ctx, 'ses_1');
    const b = await contextFor(noop.ctx, 'ses_1');
    assert.equal(a, b, 'the default seams add nothing to the context');
    const t = plain.ctx.hooks.transforms;
    assert.deepEqual([t.command.length, t.skill.length, t.mcp.length], [1, 1, 1], 'the default configure registered commands, skills and the MCP entry once each');
    assert.equal(existsSync(join(p.dir, server.NOTICES_REL)), false, 'no notice was raised');
    assert.equal(existsSync(join(p.dir, server.LOG_REL)), false, 'nothing was logged');
    await plain.cleanup?.();
    await noop.cleanup?.();
  } finally {
    p.cleanup();
  }
});

// Opt-in live smoke against the scratch OpenCode 2.0.21 install. Set
// STERLING_OC_LIVE=1 and STERLING_OC_DIR to the dir holding env.sh and node_modules/@opencode/cli.
// --- Parity P6: H10's other duties as next-turn notices, shell and patch delivery, a loud worker skip.

// The fixture's records are stamped NOW; this clock runs strictly after it, so a
// record a test writes, and every settlement window, are later than the fixture.
let tick = 0;
const isoNow = () => new Date(Math.max(Date.now(), Date.parse(NOW) + 60_000) + tick++).toISOString();
const systemItems = (dir, reason) => {
  const s = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    return s.query({ types: ['todo'], cap: 100 }).filter((t) => t.source === 'system' && t.system_reason === reason);
  } finally {
    s.close();
  }
};
const noticeTexts = (dir) => (existsSync(join(dir, server.NOTICES_REL)) ? JSON.parse(readFileSync(join(dir, server.NOTICES_REL), 'utf8')).map((n) => n.text) : []);
const writeEvents = (dir, events) => {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'transient', 'session-events.json'), JSON.stringify(events));
};
const withStoreAt = (dir, fn) => {
  const s = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    return fn(s);
  } finally {
    s.close();
  }
};
const liveEnvelope = (type) => ({ ...envelope(type), created_at: isoNow(), updated_at: isoNow() });
const addFinding = (dir) =>
  withStoreAt(dir, (s) => s.create({ ...liveEnvelope('research_finding'), question: 'q?', answer: 'a', source_urls: [], source_date: '2026-09-01', capture_date: '2026-09-02' }));

test('settlement nags unpaid capture and article duties as a next-turn notice, then queues them when the next settlement finds them still unpaid', async () => {
  const p = makeProject();
  try {
    const { plugin, ctx, cleanup } = await setupPlugin(p.dir, { now: isoNow });
    await plugin.handlers.event(succeeded);
    for (const n of ['n1', 'n2']) writeFileSync(join(p.dir, 'src', `${n}.mjs`), `export const ${n} = 1;\n`);
    await plugin.handlers.event(succeeded);
    const nag = noticeTexts(p.dir).join('\n');
    assert.match(nag, /capture owed/i, 'the capture duty is raised');
    assert.match(nag, /2 changed file\(s\) nothing owns.*src\/n1\.mjs/s, 'the article duty names the new unowned files');
    assert.deepEqual(systemItems(p.dir, 'capture_owed'), [], 'nothing is queued on the nag');
    assert.deepEqual(systemItems(p.dir, 'article_missing'), []);

    const ci = contextInput();
    await ctx.hooks.session.context(ci);
    assert.match(systemText(ci), /capture owed/i, 'the next context shows the nag');

    await plugin.handlers.event(succeeded);
    const owed = systemItems(p.dir, 'capture_owed');
    assert.equal(owed.length, 1);
    assert.equal(owed[0].text, 'capture owed: direct-mode session touched 2 file(s) and ended without capture', 'the text is the H10 text');
    const missing = systemItems(p.dir, 'article_missing');
    assert.equal(missing.length, 1);
    assert.deepEqual([...missing[0].file_keys].sort(), ['src/n1.mjs', 'src/n2.mjs']);
    assert.match(missing[0].text, /^article missing: 2 file\(s\) nothing owns .*\(2 newly created\)/);
    assert.ok(noticeTexts(p.dir).some((t) => /queued/i.test(t) && /capture_owed/.test(t) && /article_missing/.test(t)), 'the queueing is announced');

    await plugin.handlers.event(succeeded);
    assert.equal(systemItems(p.dir, 'capture_owed').length, 1, 'a duty is queued once');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('a capture written during the turn pays the capture duty, and a no_capture declaration after the nag discharges it', async () => {
  const p = makeProject();
  try {
    const { plugin, cleanup } = await setupPlugin(p.dir, { now: isoNow });
    await plugin.handlers.event(succeeded);
    writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 5;\n');
    addFinding(p.dir);
    await plugin.handlers.event(succeeded);
    assert.ok(!noticeTexts(p.dir).some((t) => /capture owed/i.test(t)), 'no nag: the turn wrote a record');

    writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 6;\n');
    await plugin.handlers.event(succeeded);
    assert.ok(noticeTexts(p.dir).some((t) => /capture owed/i.test(t)), 'the next uncaptured change nags');
    writeEvents(p.dir, [{ kind: 'no_capture', lane: 'capture', detail: 'nothing durable', at: isoNow() }]);
    await plugin.handlers.event(succeeded);
    assert.deepEqual(systemItems(p.dir, 'capture_owed'), [], 'a later no_capture declaration discharges it');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

// research_owed needs research_tool events; on Claude Code only H16 writes them. The plugin
// records the same shape when OpenCode's web tools complete. Tool names measured in the
// OpenCode 2.0.21 binary: webfetch {url} and websearch {query}.
test('a completed webfetch or websearch call is recorded as a research_tool event, and the research duty then fires', async () => {
  const p = makeProject();
  try {
    const { ctx, plugin, cleanup } = await setupPlugin(p.dir, { now: isoNow });
    await plugin.handlers.event(succeeded); // the first settlement sets the baseline, as in the register test below
    const after = (tool, input, status = 'completed') =>
      ctx.hooks.tool['execute.after']({ tool, sessionID: 'ses_1', agent: 'build', messageID: 'm1', id: `c-${tool}-${status}`, input, status, ...(status === 'completed' ? { result: { content: [{ type: 'text', text: 'ok' }] } } : { error: { message: 'x' } }) });
    await after('webfetch', { url: 'https://example.com/spec' });
    await after('websearch', { query: 'opencode plugin hooks' });
    await after('webfetch', { url: 'https://example.com/failed' }, 'error');
    await after('read', { path: join(p.dir, 'src', 'a.mjs') });
    const events = JSON.parse(readFileSync(join(p.dir, '.sterling', 'transient', 'session-events.json'), 'utf8'));
    assert.deepEqual(events.map(({ kind, detail }) => ({ kind, detail })), [
      { kind: 'research_tool', detail: 'https://example.com/spec' },
      { kind: 'research_tool', detail: 'opencode plugin hooks' },
    ], 'completed web calls only, in order, with url and query as detail');
    for (const e of events) assert.deepEqual(Object.keys(e), ['kind', 'detail', 'at'], 'the H16 shape, untagged');
    await plugin.handlers.event(succeeded);
    assert.match(noticeTexts(p.dir).join('\n'), /research.*https:\/\/example\.com\/spec/s, 'the research duty is raised from the recorded events');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('concept and research duties come from the session-event register; each event is weighed once', async () => {
  const p = makeProject();
  try {
    const { plugin, cleanup } = await setupPlugin(p.dir, { now: isoNow });
    await plugin.handlers.event(succeeded);
    writeEvents(p.dir, [
      { kind: 'concept_designed', detail: 'fam-x', at: isoNow() },
      { kind: 'research_tool', detail: 'https://example.com/doc', at: isoNow() },
    ]);
    await plugin.handlers.event(succeeded);
    const nag = noticeTexts(p.dir).join('\n');
    assert.match(nag, /concept_family 'fam-x'/);
    assert.match(nag, /research.*https:\/\/example\.com\/doc/s);

    addFinding(p.dir);
    await plugin.handlers.event(succeeded);
    const concept = systemItems(p.dir, 'concept_article_missing');
    assert.equal(concept.length, 1);
    assert.equal(concept[0].text, "concept article missing: design settled for concept family 'fam-x' and the session ended without its concept article — create/update the feature_article with concept_family 'fam-x'");
    assert.deepEqual(systemItems(p.dir, 'research_owed'), [], 'the finding written after the nag pays the research duty');

    await plugin.handlers.event(succeeded);
    assert.ok(!noticeTexts(p.dir).some((t) => /fam-x/.test(t) && /owed|nag|duties/i.test(t) && !/queued/i.test(t)), 'a weighed event is not raised again');
    assert.equal(systemItems(p.dir, 'concept_article_missing').length, 1);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('a malformed session-event register is a loud notice, and the file duties still settle', async () => {
  const p = makeProject();
  try {
    const { plugin, cleanup } = await setupPlugin(p.dir, { now: isoNow });
    await plugin.handlers.event(succeeded);
    mkdirSync(join(p.dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(p.dir, '.sterling', 'transient', 'session-events.json'), '{not json');
    writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 7;\n');
    await plugin.handlers.event(succeeded);
    const texts = noticeTexts(p.dir);
    assert.ok(texts.some((t) => /session-events\.json/.test(t) && /concept and research duties/.test(t)));
    assert.ok(texts.some((t) => /capture owed/i.test(t)));
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('shell delivery: paths a command names get H19 pointers on the result, once per session', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setupPlugin(p.dir);
    const call = { tool: 'shell', sessionID: 'ses_1', id: 's1', input: { command: 'cat src/a.mjs | head -3' } };
    await ctx.hooks.tool['execute.before'](call);
    const after = { ...call, status: 'completed', result: { content: [{ type: 'text', text: 'out' }] } };
    await ctx.hooks.tool['execute.after'](after);
    assert.equal(after.result.content.length, 2);
    assert.match(after.result.content[1].text, /STERLING KNOWLEDGE POINTERS \(H19\)/);
    assert.match(after.result.content[1].text, /src\/a\.mjs — article 'alpha-feature title \[alpha-feature\]'/);

    const again = { tool: 'shell', sessionID: 'ses_1', id: 's2', input: { command: `wc -l ${join(p.dir, 'src', 'a.mjs')}` } };
    await ctx.hooks.tool['execute.before'](again);
    const after2 = { ...again, status: 'completed', result: { content: [{ type: 'text', text: 'out' }] } };
    await ctx.hooks.tool['execute.after'](after2);
    assert.equal(after2.result.content.length, 1, 'a path pointed at once this session is not repeated');

    const none = { tool: 'shell', sessionID: 'ses_1', id: 's3', input: { command: 'echo hello' } };
    await ctx.hooks.tool['execute.before'](none);
    const after3 = { ...none, status: 'completed', result: { content: [{ type: 'text', text: 'hello' }] } };
    await ctx.hooks.tool['execute.after'](after3);
    assert.equal(after3.result.content.length, 1, 'a command naming no governed path gets nothing');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('patch delivery: every file a patch adds, updates, deletes or moves to gets the edit delivery', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setupPlugin(p.dir);
    const patchText = ['*** Begin Patch', '*** Update File: src/a.mjs', '@@', '-export const a = 1;', '+export const a = 2;', '*** Add File: src/new.mjs', '+export const n = 1;', '*** End Patch'].join('\n');
    const call = { tool: 'patch', sessionID: 'ses_1', id: 'p1', input: { patchText } };
    await ctx.hooks.tool['execute.before'](call);
    const after = { ...call, status: 'completed', result: { content: [{ type: 'text', text: 'patched' }] } };
    await ctx.hooks.tool['execute.after'](after);
    assert.equal(after.result.content.length, 2);
    const text = after.result.content[1].text;
    assert.match(text, /STERLING KNOWLEDGE DELIVERY/);
    assert.match(text, /alpha-feature/);
    assert.match(text, /src\/new\.mjs/, 'the added file gets the unowned-territory notice');

    const failed = { tool: 'patch', sessionID: 'ses_2', id: 'p2', input: { patchText } };
    await ctx.hooks.tool['execute.before'](failed);
    const afterFail = { ...failed, status: 'error', result: { content: [{ type: 'text', text: 'bad' }] } };
    await ctx.hooks.tool['execute.after'](afterFail);
    assert.equal(afterFail.result.content.length, 1, 'a failed patch delivers nothing');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('with no claude on PATH the worker skip is loud: one notice per process and a log line', async () => {
  const p = makeProject();
  try {
    const { plugin, ctx, cleanup } = await setupPlugin(p.dir, { claudeOnPath: () => false });
    await plugin.handlers.event(succeeded);
    writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 8;\n');
    await plugin.handlers.event(succeeded);
    const skip = noticeTexts(p.dir).filter((t) => /maintenance worker/i.test(t));
    assert.equal(skip.length, 1);
    assert.match(skip[0], /no maintenance runner/i);
    assert.match(skip[0], /neither `claude` nor an OpenCode binary/);
    const log = readFileSync(join(p.dir, server.LOG_REL), 'utf8');
    assert.match(log, /no maintenance runner/i);
    await ctx.hooks.session.context(contextInput());
    await plugin.handlers.event(succeeded);
    await plugin.handlers.event(succeeded);
    assert.equal(noticeTexts(p.dir).filter((t) => /maintenance worker/i.test(t)).length, 0, 'the notice is not raised again in this process');
    assert.equal(readFileSync(join(p.dir, server.LOG_REL), 'utf8').match(/no maintenance runner/gi).length, 1, 'nor logged again');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('inside a non-node host the worker runner is spawned with node from PATH; no node is a loud skip; a failed launch is a notice', async () => {
  const worker = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'worker.mjs')).href);
  assert.equal(worker.isNodeBinary('/usr/bin/node'), true);
  assert.equal(worker.isNodeBinary('C:\\Program Files\\nodejs\\node.exe'), true);
  assert.equal(worker.isNodeBinary('/home/u/.opencode/bin/opencode'), false);
  const p = makeProject();
  try {
    const openStore = (dbPath) => new SterlingStore(dbPath);
    const spawned = [];
    const spawnImpl = (cmd, args) => {
      spawned.push({ cmd, args });
      return { on() {}, unref() {}, pid: 1 };
    };
    // The lib spawns its runner as process.execPath (scripts/hooks/lib/maintenance-worker.mjs).
    const launchWorker = (o) => {
      o.spawn(process.execPath, ['runner.mjs'], {});
      return { launched: true, reason: 'launched' };
    };
    const inOpencode = worker.createWorkerLaunch({ openStore, claudeOnPath: () => true, launchWorker, execPath: '/x/opencode', nodeOnPath: () => true, spawnImpl });
    inOpencode(p.dir, isoNow());
    assert.deepEqual(spawned, [{ cmd: 'node', args: ['runner.mjs'] }], 'the runner runs on node, not the host binary');

    const onNode = worker.createWorkerLaunch({ openStore, claudeOnPath: () => true, launchWorker, execPath: '/usr/bin/node', nodeOnPath: () => false, spawnImpl });
    onNode(p.dir, isoNow());
    assert.equal(spawned[1].cmd, '/usr/bin/node', 'a node host keeps its own binary');

    const noNode = worker.createWorkerLaunch({ openStore, claudeOnPath: () => true, launchWorker, execPath: '/x/opencode', nodeOnPath: () => false, spawnImpl });
    noNode(p.dir, isoNow());
    noNode(p.dir, isoNow());
    assert.equal(spawned.length, 2, 'nothing is spawned without node');
    assert.equal(noticeTexts(p.dir).filter((t) => /not node, and no `node` is on PATH/.test(t)).length, 1, 'one notice per process');
    assert.match(readFileSync(join(p.dir, server.LOG_REL), 'utf8'), /\/x\/opencode, not node/);

    const failing = worker.createWorkerLaunch({ openStore, claudeOnPath: () => true, launchWorker: () => ({ launched: false, reason: 'error', detail: 'spawn: EACCES' }), execPath: '/usr/bin/node', spawnImpl });
    failing(p.dir, isoNow());
    assert.ok(noticeTexts(p.dir).some((t) => /could not be launched \(spawn: EACCES\)/.test(t)), 'a launch the lib reports as failed is a notice');
  } finally {
    p.cleanup();
  }
});

test('live: OpenCode 2.0.21 shows the model the injected layer and an edit delivery', { skip: process.env.STERLING_OC_LIVE !== '1' }, async () => {
  const ocDir = process.env.STERLING_OC_DIR;
  assert.ok(ocDir && existsSync(join(ocDir, 'node_modules', '@opencode', 'cli')), 'STERLING_OC_DIR must point at the OpenCode 2.0.21 scratch install');
  const r = spawnSync('bash', [join(repo, 'scripts', 'tests', 'lib', 'opencode-live-smoke.sh'), ocDir, join(repo, 'opencode', 'sterling-server.mjs')], { encoding: 'utf8', timeout: 400_000 });
  assert.equal(r.status, 0, `live smoke failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /LAYER-SEEN: yes/);
  assert.match(r.stdout, /DELIVERY-SEEN: yes/);
  assert.match(r.stdout, /BIN-CALLED-BY-ROOT: yes/, 'the model ran a bin script by the root the layer names');
});
