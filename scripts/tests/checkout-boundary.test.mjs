// The store-root / checkout-root split (board 4da6582b): a session in a linked git
// worktree of a Sterling project uses the project's one store, config and board,
// while its transient state, HEAD and files are its own checkout's. Covers the
// resolver (scripts/lib/worktree-root.mjs), the hook helpers built on it
// (scripts/hooks/lib/common.mjs), and the OpenCode plugin: its MCP entry, its
// transient writes and the claim identity it fills into the board claim tools.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveProjectRoots, storeRootFor } from '../lib/worktree-root.mjs';
import { checkoutRoot, loadConfig, projectRoot } from '../hooks/lib/common.mjs';
import { applyClaimIdentity, claimToolOf } from '../../packages/opencode-plugin/src/claim-identity.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Spawned git must not see a host session (anti_pattern test-spawning-host-detecting-script-must-clear-opencode-env).
const env = { ...process.env };
delete env.OPENCODE;
delete env.OPENCODE_SESSION_ID;
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let base, main, outside, nested, plain, foreign, foreignWt, SterlingStore, server;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  server = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'server.mjs')).href);
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-checkout-boundary-')));
  main = join(base, 'main');
  mkdirSync(join(main, '.sterling'), { recursive: true });
  mkdirSync(join(main, 'src'), { recursive: true });
  writeFileSync(join(main, '.sterling', 'config.json'), JSON.stringify({ project_name: 'boundary-fixture' }));
  writeFileSync(join(main, '.gitignore'), '.sterling/\n.claude/\n');
  writeFileSync(join(main, 'src', 'a.mjs'), 'export const a = 1;\n');
  const store = new SterlingStore(join(main, '.sterling', 'sterling.db'));
  store.close();
  git(main, ['init', '-q']);
  git(main, ['config', 'user.email', 't@example.com']);
  git(main, ['config', 'user.name', 't']);
  git(main, ['add', '-A']);
  git(main, ['commit', '-q', '-m', 'main']);
  outside = join(base, 'outside');
  git(main, ['worktree', 'add', '-q', '-b', 'outside-branch', outside]);
  writeFileSync(join(outside, 'src', 'b.mjs'), 'export const b = 2;\n');
  git(outside, ['add', '-A']);
  git(outside, ['commit', '-q', '-m', 'outside']);
  nested = join(main, '.claude', 'worktrees', 'nested');
  git(main, ['worktree', 'add', '-q', '-b', 'nested-branch', nested]);
  plain = join(base, 'plain');
  mkdirSync(join(plain, '.sterling'), { recursive: true });
  writeFileSync(join(plain, '.sterling', 'config.json'), '{}');
  foreign = join(base, 'foreign');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'x'), 'x\n');
  git(foreign, ['init', '-q']);
  git(foreign, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A']);
  git(foreign, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'f']);
  foreignWt = join(base, 'foreign-wt');
  git(foreign, ['worktree', 'add', '-q', '-b', 'fw', foreignWt]);
});
after(() => rmSync(base, { recursive: true, force: true }));

test('the resolver: main checkout and plain project have one root; a linked worktree, outside or nested, splits store from checkout', () => {
  assert.deepEqual(resolveProjectRoots(main), { storeRoot: main, checkoutRoot: main });
  assert.deepEqual(resolveProjectRoots(join(main, 'src')), { storeRoot: main, checkoutRoot: main });
  assert.deepEqual(resolveProjectRoots(plain), { storeRoot: plain, checkoutRoot: plain }, 'a non-git project behaves as before');
  assert.deepEqual(resolveProjectRoots(outside), { storeRoot: main, checkoutRoot: outside });
  assert.deepEqual(resolveProjectRoots(join(outside, 'src')), { storeRoot: main, checkoutRoot: outside });
  assert.deepEqual(resolveProjectRoots(nested), { storeRoot: main, checkoutRoot: nested }, 'a nested worktree is its own checkout, not the main root');
  assert.equal(resolveProjectRoots(foreignWt), null, 'a worktree of a non-Sterling repo is not a project');
});

test('storeRootFor maps only a linked worktree toplevel; anything else answers for itself', () => {
  assert.equal(storeRootFor(outside), main);
  assert.equal(storeRootFor(nested), main);
  assert.equal(storeRootFor(main), main);
  assert.equal(storeRootFor(plain), plain);
  assert.equal(storeRootFor(join(outside, 'src')), join(outside, 'src'), 'not a toplevel: unchanged');
  assert.equal(storeRootFor(foreignWt), foreignWt);
});

test('the hook helpers: projectRoot is the store root, checkoutRoot the worktree, and loadConfig reads the shared config', () => {
  assert.equal(projectRoot(outside), main, 'a worktree outside the tree is no longer "not a project"');
  assert.equal(checkoutRoot(outside), outside);
  assert.equal(projectRoot(nested), main);
  assert.equal(checkoutRoot(nested), nested);
  assert.equal(projectRoot(main), main);
  assert.equal(checkoutRoot(main), main);
  assert.equal(loadConfig(outside)?.project_name, 'boundary-fixture');
});

function stubCtx(directory, sessions) {
  const hooks = { session: {}, tool: {}, permission: {}, transforms: { command: [], skill: [], mcp: [] } };
  return {
    hooks,
    location: { directory },
    session: {
      hook: async (name, fn) => void (hooks.session[name] = fn),
      get: async ({ sessionID }) => {
        const s = sessions[sessionID];
        if (!s) throw new Error(`no session ${sessionID}`);
        return { id: sessionID, location: { directory }, ...s };
      },
    },
    tool: { hook: async (name, fn) => void (hooks.tool[name] = fn) },
    permission: { hook: async (name, fn) => void (hooks.permission[name] = fn) },
    command: { transform: async (cb) => (hooks.transforms.command.push(cb), { dispose: async () => {} }) },
    skill: { transform: async (cb) => (hooks.transforms.skill.push(cb), { dispose: async () => {} }) },
    mcp: { transform: async (cb) => (hooks.transforms.mcp.push(cb), { dispose: async () => {} }) },
    event: { subscribe: ({ signal } = {}) => ({ async *[Symbol.asyncIterator]() { await new Promise((r) => signal?.addEventListener('abort', r)); } }) },
  };
}

async function mcpCommand(directory) {
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, env: {} });
  const ctx = stubCtx(directory, { ses_1: {} });
  const cleanup = await plugin.setup(ctx);
  let entry;
  for (const cb of ctx.hooks.transforms.mcp) await cb({ get: () => undefined, set: (_k, v) => void (entry = v) });
  return { entry, ctx, cleanup };
}

test('the plugin starts the MCP server on the store root with --checkout for a worktree, and without it for the main checkout', async () => {
  const wt = await mcpCommand(outside);
  try {
    const c = wt.entry.command;
    assert.equal(c[c.indexOf('--project') + 1], main);
    assert.equal(c[c.indexOf('--checkout') + 1], outside);
  } finally {
    await wt.cleanup?.();
  }
  const m = await mcpCommand(main);
  try {
    assert.equal(m.entry.command[m.entry.command.indexOf('--project') + 1], main);
    assert.equal(m.entry.command.includes('--checkout'), false, 'a plain project gets the same entry as before');
  } finally {
    await m.cleanup?.();
  }
});

test('the plugin writes a worktree session\'s transient state into the worktree and reads the board from the main store', async () => {
  const transientWt = join(outside, '.sterling', 'transient');
  rmSync(transientWt, { recursive: true, force: true });
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, env: {}, configure: async () => {} });
  const ctx = stubCtx(outside, { ses_1: {} });
  const cleanup = await plugin.setup(ctx);
  try {
    // A bad claim call is refused and the refusal is not fenced, so nothing else is written for it.
    await assert.rejects(ctx.hooks.tool['execute.before']({ tool: 'sterling_board_claim', sessionID: 'ses_1', input: { id: 'x', session: 'ses_other' } }), /comes from session ses_1/);
    mkdirSync(transientWt, { recursive: true });
    writeFileSync(join(transientWt, 'opencode-notices.json'), JSON.stringify([{ id: 'n1', at: '2026-10-25T12:00:00.000Z', text: 'WORKTREE-NOTICE-1' }]));
    mkdirSync(join(main, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(main, '.sterling', 'transient', 'opencode-notices.json'), JSON.stringify([{ id: 'n2', at: '2026-10-25T12:00:00.000Z', text: 'MAIN-NOTICE-2' }]));
    const input = { sessionID: 'ses_1', agent: 'build', system: [{ type: 'text', text: 'base' }], messages: [], tools: {} };
    const p = { sessionID: 'ses_1', messageID: 'msg_turn', prompt: { text: '' }, delivery: 'immediate' };
    await ctx.hooks.session.prompt(p);
    await ctx.hooks.session.context(input);
    const text = [...input.system.map((x) => x.text), p.prompt?.text ?? ''].join('\n');
    assert.match(text, /# CLAUDE\.md — boundary-fixture \(Sterling layer\)/, 'the config is the main checkout\'s');
    assert.match(text, /STERLING STATUS: board 0 open, maintenance queue 0/, 'the board is the main store\'s');
    assert.match(text, /WORKTREE-NOTICE-1/, 'the worktree session reads its own notices');
    assert.doesNotMatch(text, /MAIN-NOTICE-2/, 'and never drains the main checkout\'s');
    assert.equal(JSON.parse(readFileSync(join(main, '.sterling', 'transient', 'opencode-notices.json'), 'utf8'))[0].shown_at, undefined);
    assert.equal(existsSync(join(outside, '.sterling', 'sterling.db')), false, 'no store is created in the worktree');
  } finally {
    await cleanup?.();
  }
});

test('claim identity: the plugin fills the real session and checkout into claim tools and refuses another session', async () => {
  assert.equal(claimToolOf('sterling_board_claim'), 'board_claim');
  assert.equal(claimToolOf('sterling_sterling__board_takeover'), 'board_takeover');
  assert.equal(claimToolOf('board_claim'), null, 'only the Sterling server\'s tools');
  assert.equal(claimToolOf('sterling_board_get'), null);
  const checkoutOfSession = async () => ({ checkout: outside });
  const claim = { tool: 'sterling_board_claim', sessionID: 'ses_real', input: { id: 'i1', checkout: '/somewhere/else' } };
  await applyClaimIdentity(claim, { checkoutOfSession });
  assert.deepEqual(claim.input, { id: 'i1', session: 'ses_real', checkout: outside });
  const reaffirm = { tool: 'sterling_board_reaffirm', sessionID: 'ses_real', input: { id: 'i1', session: 'ses_real', generation: 2 } };
  await applyClaimIdentity(reaffirm, { checkoutOfSession });
  assert.deepEqual(reaffirm.input, { id: 'i1', session: 'ses_real', generation: 2 }, 'reaffirm carries no checkout');
  await assert.rejects(applyClaimIdentity({ tool: 'sterling_board_release', sessionID: 'ses_real', input: { id: 'i1', session: 'ses_fake', generation: 1 } }, { checkoutOfSession }), /names session 'ses_fake'/);
  await assert.rejects(applyClaimIdentity({ tool: 'sterling_board_claim', sessionID: '', input: { id: 'i1' } }, { checkoutOfSession }), /no session id/);
  await assert.rejects(applyClaimIdentity({ tool: 'sterling_board_takeover', sessionID: 'ses_real', input: { id: 'i1' } }, { checkoutOfSession: async () => ({ why: 'session.get failed' }) }), /could not be read \(session.get failed\)/);
  const update = { tool: 'sterling_board_update', sessionID: 'ses_real', input: { id: 'i1', patch: {} } };
  await applyClaimIdentity(update, { checkoutOfSession });
  assert.deepEqual(update.input, { id: 'i1', patch: {} }, 'a board_update naming no session is left alone');
  await assert.rejects(applyClaimIdentity({ tool: 'sterling_board_update', sessionID: 'ses_real', input: { id: 'i1', session: 'ses_old' } }, { checkoutOfSession }), /names session 'ses_old'/);
});

test('the plugin\'s execute.before fills the claim from the session\'s own directory', async () => {
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, env: {}, configure: async () => {} });
  const ctx = stubCtx(main, { ses_wt: { location: { directory: join(outside, 'src') } } });
  const cleanup = await plugin.setup(ctx);
  try {
    const call = { tool: 'sterling_board_takeover', sessionID: 'ses_wt', input: { id: 'i1', expected_holder: 'ses_a', expected_generation: 1 } };
    await ctx.hooks.tool['execute.before'](call);
    assert.equal(call.input.session, 'ses_wt');
    assert.equal(call.input.checkout, outside, 'the checkout of the session\'s directory, not the location\'s');
  } finally {
    await cleanup?.();
  }
});

test('the hook stdin normalisation gives cwd = store root and checkout = worktree', () => {
  const probe = `import { readStdin } from ${JSON.stringify(pathToFileURL(join(repo, 'scripts', 'hooks', 'lib', 'common.mjs')).href)}; const i = readStdin(); process.stdout.write(JSON.stringify({ cwd: i.cwd, checkout: i.checkout }));`;
  const run = (cwd) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { input: JSON.stringify({ cwd }), encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(run(join(outside, 'src')), { cwd: main, checkout: outside });
  assert.deepEqual(run(join(main, 'src')), { cwd: main, checkout: main });
  const none = join(base, 'not-a-project');
  mkdirSync(none, { recursive: true });
  assert.deepEqual(run(none), { cwd: none, checkout: none }, 'outside a project both stay as given');
});

test('a worktree session\'s settlement baseline is its own checkout\'s HEAD', () => {
  // The settle step runs on the plugin's root, the checkout; gitTouches/writeInitialGitSettled are pure on that root.
  const head = git(outside, ['rev-parse', 'HEAD']);
  assert.notEqual(head, git(main, ['rev-parse', 'HEAD']));
  return import(pathToFileURL(join(repo, 'scripts', 'hooks', 'lib', 'settlement.mjs')).href).then(({ gitTouches, writeInitialGitSettled, GIT_SETTLED_REL }) => {
    const g = gitTouches(checkoutRoot(outside), new Date().toISOString());
    assert.equal(g.ok, true);
    writeInitialGitSettled(checkoutRoot(outside), g.next);
    assert.equal(JSON.parse(readFileSync(join(outside, GIT_SETTLED_REL), 'utf8')).sha, head);
    assert.equal(existsSync(join(main, GIT_SETTLED_REL)), false);
  });
});
