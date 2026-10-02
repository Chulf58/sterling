// The Sterling OpenCode 2 server plugin (decision
// sterling-on-opencode-2-is-the-knowledge-loop-in-one-small-plugin): four
// handlers driven through a stubbed plugin context. The opt-in live smoke at
// the bottom runs only with STERLING_OC_LIVE=1 against a real OpenCode 2.0.21.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
function stubCtx(directory) {
  const hooks = { session: {}, tool: {} };
  const queue = [];
  let wake = null;
  return {
    hooks,
    location: { directory },
    session: { hook: async (name, fn) => void (hooks.session[name] = fn) },
    tool: { hook: async (name, fn) => void (hooks.tool[name] = fn) },
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

async function setupPlugin(dir, deps = {}) {
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, ...deps });
  const ctx = stubCtx(dir);
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

test('the host tail maps every Claude-only name the layer uses', () => {
  const tail = server.OPENCODE_HOST_TAIL;
  for (const term of ['AskUserQuestion', '`question` tool', '/plugin', '--plugin-dir', '.claude/agents', 'codex', 'stop block', 'conductor', 'next turn']) {
    assert.ok(tail.includes(term), `host tail names ${term}`);
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

    const shell = { tool: 'shell', sessionID: 'ses_3', id: 'c4', input: { command: 'cat src/a.mjs' } };
    await ctx.hooks.tool['execute.before'](shell);
    const after4 = { ...shell, status: 'completed', result: { content: [{ type: 'text', text: 'x' }] } };
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

// Opt-in live smoke against the scratch OpenCode 2.0.21 install. Set
// STERLING_OC_LIVE=1 and STERLING_OC_DIR to the dir holding env.sh and node_modules/@opencode/cli.
test('live: OpenCode 2.0.21 shows the model the injected layer and an edit delivery', { skip: process.env.STERLING_OC_LIVE !== '1' }, async () => {
  const ocDir = process.env.STERLING_OC_DIR;
  assert.ok(ocDir && existsSync(join(ocDir, 'node_modules', '@opencode', 'cli')), 'STERLING_OC_DIR must point at the OpenCode 2.0.21 scratch install');
  const r = spawnSync('bash', [join(repo, 'scripts', 'tests', 'lib', 'opencode-live-smoke.sh'), ocDir, join(repo, 'opencode', 'sterling-server.mjs')], { encoding: 'utf8', timeout: 400_000 });
  assert.equal(r.status, 0, `live smoke failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /LAYER-SEEN: yes/);
  assert.match(r.stdout, /DELIVERY-SEEN: yes/);
});
