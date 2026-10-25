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
import { resolveLinkedWorktree, resolveProjectRoots, storeRootFor } from '../lib/worktree-root.mjs';
import { checkoutRoot, loadConfig, projectRoot } from '../hooks/lib/common.mjs';
import { applyClaimIdentity, claimToolOf, classifyTool } from '../../packages/opencode-plugin/src/claim-identity.mjs';
import { renderServerShim } from '../lib/opencode-install.mjs';
import { createPrLoopNotice } from '../../packages/opencode-plugin/src/pr-loop.mjs';
import { armPrLoop } from '../lib/work-pr.mjs';
import { writeSelectionFile } from '../hooks/lib/selection-file.mjs';
import { postUpdateApplies } from '../lib/post-update-sync.mjs';

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

test('Claude Code hooks: readStdin keeps the old walk; a worktree outside the main checkout is marked inert', () => {
  const probe = `import { readStdin } from ${JSON.stringify(pathToFileURL(join(repo, 'scripts', 'hooks', 'lib', 'common.mjs')).href)}; const i = readStdin(JSON.parse(process.argv[1])); process.stdout.write(JSON.stringify({ cwd: i.cwd, inert: i.inertWorktree ?? null }));`;
  const run = (cwd, opts = { reportInertWorktree: true }) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify(opts)], { input: JSON.stringify({ cwd }), encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(run(join(outside, 'src')), { cwd: join(outside, 'src'), inert: { storeRoot: main, checkoutRoot: outside } });
  const plainRead = spawnSync(process.execPath, ['--input-type=module', '-e', probe, '{}'], { input: JSON.stringify({ cwd: outside }), encoding: 'utf8', env });
  assert.equal(plainRead.status, 0, plainRead.stderr);
  assert.equal(plainRead.stdout, '', 'every other hook allows and exits inside readStdin, before touching anything');
  assert.deepEqual(run(join(main, 'src')), { cwd: main, inert: null });
  assert.deepEqual(run(nested), { cwd: main, inert: null }, 'a nested worktree resolves to the main root, as before this branch');
  const none = join(base, 'not-a-project');
  mkdirSync(none, { recursive: true });
  assert.deepEqual(run(none), { cwd: none, inert: null });
});

/** Runs a BUNDLED hook (hooks/<name>) with `input` on stdin. */
function runHook(name, input) {
  return spawnSync(process.execPath, [join(repo, 'hooks', name)], { input: JSON.stringify(input), encoding: 'utf8', env });
}

test('bundled H16 and H7 are inert in a worktree outside the main checkout, and H1 says so once', () => {
  const eventsMain = join(main, '.sterling', 'transient', 'session-events.json');
  const touchesMain = join(main, '.sterling', 'transient', 'touches.json');
  rmSync(join(main, '.sterling', 'transient'), { recursive: true, force: true });
  rmSync(join(outside, '.sterling', 'transient'), { recursive: true, force: true });
  const h16 = (cwd) => runHook('h16-event-register.mjs', { cwd, session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'WebSearch', tool_input: { query: 'q' }, tool_response: {} });
  const h7 = (cwd, file) => runHook('h7-file-touch.mjs', { cwd, session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' }, tool_response: {} });
  let r = h16(outside);
  assert.equal(r.status, 0, r.stderr);
  r = h7(outside, join(outside, 'src', 'b.mjs'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(eventsMain), false, 'H16 from the worktree wrote nothing under main');
  assert.equal(existsSync(touchesMain), false, 'H7 from the worktree wrote nothing under main');
  assert.equal(existsSync(join(outside, '.sterling', 'transient')), false, 'nor anything in the worktree');
  // Control: the same calls in the main checkout do write, so the inert result is not a broken probe.
  assert.equal(h16(main).status, 0);
  assert.equal(h7(main, join(main, 'src', 'a.mjs')).status, 0);
  assert.ok(existsSync(eventsMain), 'H16 writes in the main checkout');
  assert.ok(existsSync(touchesMain), 'H7 writes in the main checkout');
  const h1 = runHook('h1-session-start.mjs', { cwd: outside, session_id: 's-wt', source: 'startup', hook_event_name: 'SessionStart' });
  assert.equal(h1.status, 0, h1.stderr);
  assert.match(h1.stdout, /STERLING HOOKS INERT: this session runs in the linked git worktree/);
  assert.equal(h1.stdout.trim().split('\n').length, 1, 'one line');
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

test('the generated OpenCode server shim loads Sterling in a linked worktree and nothing outside a project', async () => {
  const dir = join(base, 'shim');
  mkdirSync(dir, { recursive: true });
  const shimPath = join(dir, 'sterling.js');
  writeFileSync(shimPath, renderServerShim(repo, false, shimPath));
  const shim = (await import(`${pathToFileURL(shimPath).href}?t=${Date.now()}`)).default;
  const wt = stubCtx(outside, { ses_1: {} });
  const cleanup = await shim.setup(wt);
  try {
    assert.equal(typeof wt.hooks.permission.evaluate, 'function', 'the plugin loaded and registered its store guard in the worktree');
    assert.equal(typeof wt.hooks.tool['execute.before'], 'function');
  } finally {
    await cleanup?.();
  }
  const away = stubCtx(foreignWt, {});
  assert.equal(await shim.setup(away), undefined);
  assert.deepEqual(away.hooks.permission, {}, 'a worktree of a non-Sterling repo loads nothing');
});

test('the PR-loop notice reads the work mode and the owed loop at the store root and publishes to the checkout', () => {
  const cfg = join(main, '.sterling', 'config.json');
  const before = readFileSync(cfg, 'utf8');
  writeFileSync(cfg, JSON.stringify({ project_name: 'boundary-fixture', mode: 'work' }));
  try {
    armPrLoop(main, { pr_url: 'https://github.com/o/r/pull/7', pr_number: 7, repo: 'o/r', head_sha: 'a'.repeat(40) });
    rmSync(join(outside, '.sterling', 'transient', 'opencode-notices.json'), { force: true });
    createPrLoopNotice({ pluginRoot: repo })(outside);
    const notices = JSON.parse(readFileSync(join(outside, '.sterling', 'transient', 'opencode-notices.json'), 'utf8'));
    assert.ok(notices.some((n) => /7/.test(n.text) && /review/i.test(n.text)), JSON.stringify(notices));
    assert.equal(existsSync(join(main, '.sterling', 'transient', 'opencode-notices.json')) && JSON.parse(readFileSync(join(main, '.sterling', 'transient', 'opencode-notices.json'), 'utf8')).some((n) => /pull\/7|#7/.test(n.text)), false);
  } finally {
    writeFileSync(cfg, before);
    rmSync(join(main, '.sterling', 'transient', 'pr-loops'), { recursive: true, force: true });
    rmSync(join(main, '.sterling', 'transient', 'pr-loop.json'), { force: true });
  }
});

test('a worktree prompt takes only its own checkout\'s selection, never the shared store row', async () => {
  const store = new SterlingStore(join(main, '.sterling', 'sterling.db'));
  store.writeSelection('decision', 'main-selection-id', '2026-10-25T12:00:00.000Z');
  store.close();
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, env: {}, configure: async () => {} });
  const ctx = stubCtx(outside, { ses_1: {} });
  const cleanup = await plugin.setup(ctx);
  try {
    const p1 = { sessionID: 'ses_1', messageID: 'm1', prompt: { text: 'hi' }, delivery: 'immediate' };
    await ctx.hooks.session.prompt(p1);
    assert.doesNotMatch(p1.prompt.text, /main-selection-id/, 'the main checkout\'s selection stays for the main checkout');
    writeSelectionFile(outside, 'decision', 'wt-selection-id', '2026-10-25T12:00:00.000Z');
    const p2 = { sessionID: 'ses_1', messageID: 'm2', prompt: { text: 'hi' }, delivery: 'immediate' };
    await ctx.hooks.session.prompt(p2);
    assert.match(p2.prompt.text, /wt-selection-id/);
  } finally {
    await cleanup?.();
  }
  const again = new SterlingStore(join(main, '.sterling', 'sterling.db'));
  try {
    assert.equal(again.takeSelection()?.record_id, 'main-selection-id', 'still there for the main checkout');
  } finally {
    again.close();
  }
});

test('post-update sync applies in a linked worktree: the shared config decides, the checkout keeps the sync', () => {
  const copy = join(base, 'installed-copy');
  mkdirSync(copy, { recursive: true }); // no .git: an installed copy (installed-copy.mjs)
  assert.equal(postUpdateApplies(copy, outside), true);
  assert.equal(postUpdateApplies(copy, main), true);
  assert.equal(postUpdateApplies(copy, foreignWt), false);
});

test('a claim after the session moves records the new checkout, not the cached one', async () => {
  const sessions = { ses_m: { location: { directory: main } } };
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, env: {}, configure: async () => {} });
  const ctx = stubCtx(main, sessions);
  const cleanup = await plugin.setup(ctx);
  try {
    const first = { tool: 'mcp__sterling__board_claim', sessionID: 'ses_m', input: { id: 'i1' } };
    await ctx.hooks.tool['execute.before'](first);
    assert.equal(first.input.checkout, main);
    sessions.ses_m.location = { directory: outside };
    const second = { tool: 'mcp__sterling__board_claim', sessionID: 'ses_m', input: { id: 'i1' } };
    await ctx.hooks.tool['execute.before'](second);
    assert.equal(second.input.checkout, outside);
  } finally {
    await cleanup?.();
  }
});

test('claim tools are recognised by their Sterling suffix under any prefix; an unknown Sterling board tool is refused', async () => {
  for (const t of ['mcp__sterling__board_claim', 'sterling_board_claim', 'acme-gw_board_claim', 'board_claim']) assert.equal(claimToolOf(t), 'board_claim', t);
  assert.equal(claimToolOf('mcp__sterling__board_get'), null);
  assert.equal(claimToolOf('github_board_list'), null);
  assert.deepEqual(classifyTool('sterling_board_frobnicate'), { unknown: true });
  await assert.rejects(applyClaimIdentity({ tool: 'mcp__sterling__board_frobnicate', sessionID: 's', input: {} }, { checkoutOfSession: async () => ({ checkout: main }) }), /does not know/);
  const call = { tool: 'acme-gw_board_takeover', sessionID: 's', input: { id: 'i' } };
  await applyClaimIdentity(call, { checkoutOfSession: async () => ({ checkout: main }) });
  assert.deepEqual(call.input, { id: 'i', session: 's', checkout: main });
});

test('a linked worktree of a Sterling git submodule resolves to the submodule checkout; a bare-repo worktree does not', () => {
  const src = join(base, 'subsrc');
  mkdirSync(src);
  writeFileSync(join(src, 'f'), 'f\n');
  writeFileSync(join(src, '.gitignore'), '.sterling/\n');
  git(src, ['init', '-q']);
  git(src, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A']);
  git(src, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 's']);
  const sup = join(base, 'super');
  mkdirSync(sup);
  git(sup, ['init', '-q']);
  git(sup, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, 'sub']);
  const sub = join(sup, 'sub');
  mkdirSync(join(sub, '.sterling'), { recursive: true });
  writeFileSync(join(sub, '.sterling', 'config.json'), '{}');
  const subWt = join(base, 'sub-wt');
  git(sub, ['worktree', 'add', '-q', '-b', 'sw', subWt]);
  assert.deepEqual(resolveLinkedWorktree(subWt), { worktree: subWt, mainRoot: sub });
  assert.deepEqual(resolveProjectRoots(subWt), { storeRoot: sub, checkoutRoot: subWt });
  assert.equal(resolveLinkedWorktree(sub), null, 'the submodule checkout itself is not a linked worktree');
  const bare = join(base, 'bare.git');
  git(base, ['clone', '-q', '--bare', main, bare]);
  const bareWt = join(base, 'bare-wt');
  git(bare, ['worktree', 'add', '-q', bareWt, 'outside-branch']);
  assert.equal(resolveLinkedWorktree(bareWt), null, 'a bare main repo has no main checkout');
});
