// The Antigravity CLI (agy) hook adapter in scripts/hooks/lib/common.mjs and
// the agy plugin surface (root hooks.json, .antigravity-plugin/plugin.json),
// board 792619d3. Stdin fixtures follow the samples measured on agy 1.5.11 in
// research_finding how-does-an-antigravity-cli-agy-plugin-load-manifest-hooks-j
// (phase B): every event carries hookEventName, cwd (the workspace),
// conversationId, transcriptPath, workspacePaths, artifactDirectoryPath,
// modelName and lastUserInput; tool events add stepIdx and toolCall{id,name,args}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAgyInput, normalizeAgyInput, agyEnvelope } from '../hooks/lib/common.mjs';
import { agyHooksShapeViolations, versionParityViolations } from '../lib/agy-plugin-surface.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const COMMON = pathToFileURL(join(HOOKS, 'lib', 'common.mjs')).href;

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'agy-adapter-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}\n');
  return dir;
}

function agy(event, cwd, extra = {}) {
  const id = 'c0ffee00-0000-4000-8000-000000000001';
  return {
    hookEventName: event,
    cwd,
    conversationId: id,
    workspacePaths: [cwd],
    transcriptPath: `/home/u/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`,
    artifactDirectoryPath: `/home/u/.gemini/antigravity-cli/brain/${id}`,
    modelName: 'gemini-3.6-flash-medium',
    lastUserInput: 'fix the failing test',
    ...extra,
  };
}

const tool = (name, args) => ({ stepIdx: 3, toolCall: { id: 'toolu_agy_1', name, args } });

function run(script, input, cwd) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A throwaway hook that reads stdin through common.mjs and then runs `body`. */
function harness(dir, body) {
  const p = join(dir, 'harness.mjs');
  writeFileSync(p, `import { readStdin, allow, deny, exitAfterWrite } from ${JSON.stringify(COMMON)};\nconst input = readStdin();\n${body}\n`);
  return p;
}

// ── detection and normalisation ────────────────────────────────────────────

test('detection: agy camelCase payloads only; a Claude Code payload is never taken for agy', () => {
  assert.equal(isAgyInput(agy('PreToolUse', '/w')), true);
  assert.equal(isAgyInput({ hook_event_name: 'PreToolUse', cwd: '/w' }), false);
  assert.equal(isAgyInput({ hook_event_name: 'PreToolUse', hookEventName: 'PreToolUse' }), false);
  assert.equal(isAgyInput(null), false);
});

test('tool calls map onto the Claude Code tool_name/tool_input the hooks read', () => {
  const n = (name, args) => normalizeAgyInput(agy('PreToolUse', '/w', tool(name, args))).input;
  assert.deepEqual(
    [n('run_command', { CommandLine: 'ls', WaitMsBeforeAsync: 0 }).tool_name, n('run_command', { CommandLine: 'ls' }).tool_input],
    ['Bash', { command: 'ls' }]
  );
  assert.deepEqual(n('write_file', { Path: '/w/a.txt', Content: 'x' }).tool_input, { file_path: '/w/a.txt', content: 'x' });
  assert.equal(n('write_file', { Path: '/w/a.txt' }).tool_name, 'Write');
  const edit = n('edit_file', { Path: '/w/a', Target: 'o', Replacement: 'n' });
  assert.equal(edit.tool_name, 'Edit');
  assert.deepEqual(edit.tool_input, { file_path: '/w/a', old_string: 'o', new_string: 'n' });
  assert.equal(n('read_file', { Path: '/w/a' }).tool_input.file_path, '/w/a');
  assert.deepEqual(n('invoke_subagent', { Prompt: 'p', Role: 'r', TypeName: 't' }).tool_input, { prompt: 'p', description: 'r', subagent_type: 't' });
  assert.equal(n('invoke_subagent', {}).tool_name, 'Task');
  const mcp = n('call_mcp_tool', { ServerName: 'sterling_sterling', ToolName: 'knowledge_get', Arguments: '{"id":"abc"}' });
  assert.equal(mcp.tool_name, 'mcp__sterling_sterling__knowledge_get');
  assert.deepEqual(mcp.tool_input, { id: 'abc' });
  const i = n('run_command', { CommandLine: 'ls' });
  assert.equal(i.hook_event_name, 'PreToolUse');
  assert.equal(i.session_id, 'c0ffee00-0000-4000-8000-000000000001');
  assert.equal(i.tool_use_id, 'toolu_agy_1');
  assert.equal(i.cwd, '/w');
});

test('PreInvocation maps to UserPromptSubmit and acts only on invocationNum 0', () => {
  const first = normalizeAgyInput(agy('PreInvocation', '/w', { invocationNum: 0, initialNumSteps: 1 }));
  assert.equal(first.skip, null);
  assert.equal(first.input.hook_event_name, 'UserPromptSubmit');
  assert.equal(first.input.prompt, 'fix the failing test');
  for (const invocationNum of [1, 2, 15, undefined]) {
    assert.notEqual(normalizeAgyInput(agy('PreInvocation', '/w', { invocationNum })).skip, null, `invocationNum ${invocationNum}`);
  }
});

test('a subagent conversation (lastUserInput "") skips SessionStart, PreInvocation and Stop, but not its tool events', () => {
  for (const event of ['SessionStart', 'PreInvocation', 'Stop']) {
    assert.equal(normalizeAgyInput(agy(event, '/w', { lastUserInput: '', invocationNum: 0 })).skip, 'subagent conversation', event);
  }
  assert.equal(normalizeAgyInput(agy('PreToolUse', '/w', { lastUserInput: '', ...tool('run_command', { CommandLine: 'ls' }) })).skip, null);
});

test('Stop carries continuationActive as stop_hook_active; a failed PostToolUse is skipped unless it is a subagent call', () => {
  assert.equal(normalizeAgyInput(agy('Stop', '/w', { continuationActive: true, fullyIdle: true })).input.stop_hook_active, true);
  assert.equal(normalizeAgyInput(agy('Stop', '/w', { continuationActive: false })).input.stop_hook_active, false);
  assert.equal(normalizeAgyInput(agy('PostToolUse', '/w', { error: '', ...tool('write_file', { Path: '/w/a' }) })).skip, null);
  assert.notEqual(normalizeAgyInput(agy('PostToolUse', '/w', { error: 'exit status 1', ...tool('run_command', { CommandLine: 'x' }) })).skip, null);
  const failedTask = normalizeAgyInput(agy('PostToolUse', '/w', { error: 'boom', ...tool('invoke_subagent', { Prompt: 'p' }) }));
  assert.equal(failedTask.skip, null);
  assert.equal(failedTask.input.hook_event_name, 'PostToolUseFailure');
});

// ── output envelopes ───────────────────────────────────────────────────────

test('envelopes: a block becomes a JSON deny or continue with exit 0; context rides injectSteps', () => {
  assert.deepEqual(agyEnvelope({ event: 'PreToolUse', err: 'H15: no\n', code: 2 }), { text: '{"decision":"deny","reason":"H15: no"}', code: 0 });
  assert.deepEqual(agyEnvelope({ event: 'PreToolUse', code: 0 }), { text: '{"decision":"allow"}', code: 0 });
  assert.deepEqual(agyEnvelope({ event: 'Stop', err: 'duty', code: 2 }), { text: '{"decision":"continue","reason":"duty"}', code: 0 });
  assert.deepEqual(agyEnvelope({ event: 'Stop', err: 'duty', code: 2, continuationActive: true }), { text: '{"decision":"allow"}', code: 0 });
  assert.deepEqual(JSON.parse(agyEnvelope({ event: 'SessionStart', out: JSON.stringify({ systemMessage: 'S', hookSpecificOutput: { additionalContext: 'C' } }) }).text), {
    injectSteps: [{ systemMessage: { systemMessage: 'C' } }, { systemMessage: { systemMessage: 'S' } }],
  });
  assert.deepEqual(JSON.parse(agyEnvelope({ event: 'PreInvocation', out: 'plain line\n' }).text), { injectSteps: [{ systemMessage: { systemMessage: 'plain line' } }] });
  assert.equal(agyEnvelope({ event: 'SessionStart', out: '' }).text, '{}');
  assert.equal(agyEnvelope({ event: 'PostToolUse', out: JSON.stringify({ hookSpecificOutput: { additionalContext: 'C' } }) }).text, '{}');
  assert.deepEqual(agyEnvelope({ event: 'PostToolUse', code: 1 }), { text: '', code: 1 });
});

// ── H15 through the real hook ──────────────────────────────────────────────

test('H15 under agy: a store write by run_command, write_file or edit_file is a JSON deny with exit 0', () => {
  const dir = project();
  try {
    const h15 = join(HOOKS, 'h15-store-guard.mjs');
    const cases = [
      tool('run_command', { CommandLine: 'rm -f .sterling/sterling.db', WaitMsBeforeAsync: 0, toolSummary: 'rm' }),
      tool('run_command', { CommandLine: 'echo x > .sterling/sterling.db-wal' }),
      tool('write_file', { Path: join(dir, '.sterling', 'sterling.db'), Content: 'x' }),
      tool('edit_file', { Path: join(dir, '.sterling', 'sterling.db'), Target: 'a', Replacement: 'b' }),
    ];
    for (const c of cases) {
      const r = run(h15, agy('PreToolUse', dir, c), dir);
      assert.equal(r.code, 0, `${c.toolCall.name}: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'deny', `${c.toolCall.name}: ${r.stdout}`);
      assert.match(out.reason, /^H15: /);
    }
    for (const c of [tool('run_command', { CommandLine: 'cat .sterling/sterling.db | wc -c' }), tool('write_file', { Path: join(dir, '.sterling', 'config.json'), Content: '{}' })]) {
      const r = run(h15, agy('PreToolUse', dir, c), dir);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { decision: 'allow' });
    }
    // A write_file with no Path cannot be shown safe: still a deny (fail closed).
    const noPath = run(h15, agy('PreToolUse', dir, tool('write_file', { Content: 'x' })), dir);
    assert.equal(JSON.parse(noPath.stdout).decision, 'deny');
    // The Claude Code path is unchanged: exit 2, reason on stderr, nothing on stdout.
    const cc = run(h15, { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command: 'rm -f .sterling/sterling.db' } }, dir);
    assert.equal(cc.code, 2);
    assert.equal(cc.stdout, '');
    assert.match(cc.stderr, /^H15: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── H1 SessionStart through the real hook ──────────────────────────────────

test('H1 under agy: SessionStart context arrives as injectSteps; a subagent conversation gets nothing', () => {
  const dir = project();
  try {
    const h1 = join(HOOKS, 'h1-session-start.mjs');
    const r = run(h1, agy('SessionStart', dir), dir);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(Array.isArray(out.injectSteps) && out.injectSteps.length > 0, r.stdout.slice(0, 400));
    for (const step of out.injectSteps) assert.equal(typeof step.systemMessage.systemMessage, 'string');
    assert.ok(!('hookSpecificOutput' in out) && !('systemMessage' in out), 'no Claude Code envelope leaks through');
    const sub = run(h1, agy('SessionStart', dir, { lastUserInput: '' }), dir);
    assert.equal(sub.code, 0, sub.stderr);
    assert.equal(sub.stdout, '{}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the invocationNum gate through the real notice drain ───────────────────

test('PreInvocation past invocationNum 0 never reaches the hook; invocationNum 0 drains the notice once', () => {
  const dir = project();
  try {
    const notices = join(dir, '.sterling', 'transient', 'notices');
    mkdirSync(notices, { recursive: true });
    const notice = join(notices, '0001.json');
    writeFileSync(notice, JSON.stringify({ text: 'NOTICE-FOR-AGY' }));
    const drain = join(HOOKS, 'h19-delivery-drain.mjs');
    const later = run(drain, agy('PreInvocation', dir, { invocationNum: 1, initialNumSteps: 4 }), dir);
    assert.equal(later.code, 0, later.stderr);
    assert.equal(later.stdout, '{}');
    assert.ok(existsSync(notice), 'a later model call must not consume the notice');
    const first = run(drain, agy('PreInvocation', dir, { invocationNum: 0, initialNumSteps: 1 }), dir);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { injectSteps: [{ systemMessage: { systemMessage: 'NOTICE-FOR-AGY' } }] });
    assert.ok(!existsSync(notice));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Stop's continuationActive guard and large envelopes, through common.mjs ─

test('Stop: a blocking hook continues the loop once; with continuationActive it lets agy stop', () => {
  const dir = project();
  try {
    const h = harness(dir, `deny('STERLING: capture duties are owed.\\n');`);
    const owed = run(h, agy('Stop', dir, { executionNum: 1, terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, continuationActive: false }), dir);
    assert.equal(owed.code, 0, owed.stderr);
    assert.deepEqual(JSON.parse(owed.stdout), { decision: 'continue', reason: 'STERLING: capture duties are owed.' });
    const again = run(h, agy('Stop', dir, { executionNum: 2, terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, continuationActive: true }), dir);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout), { decision: 'allow' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a SessionStart envelope far above the pipe buffer arrives whole', () => {
  const dir = project();
  try {
    const big = 'x'.repeat(1024 * 1024);
    const h = harness(dir, `exitAfterWrite(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ${JSON.stringify(big)} } }), 0);`);
    const r = run(h, agy('SessionStart', dir), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).injectSteps[0].systemMessage.systemMessage.length, big.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the plugin surface ─────────────────────────────────────────────────────

test('root hooks.json has the measured agy shape: flat non-tool events, {matcher, hooks} tool events, real bundles', () => {
  const doc = JSON.parse(readFileSync(join(root, 'hooks.json'), 'utf8'));
  assert.deepEqual(agyHooksShapeViolations(doc, { bundleExists: (b) => existsSync(join(root, 'hooks', b)) }), []);
  for (const events of Object.values(doc)) {
    for (const event of ['SessionStart', 'PreInvocation', 'Stop']) {
      assert.ok(Array.isArray(events[event]) && events[event].length > 0, event);
      for (const h of events[event]) assert.deepEqual(Object.keys(h).filter((k) => k === 'hooks' || k === 'matcher'), [], `${event} must be flat`);
    }
    for (const event of ['PreToolUse', 'PostToolUse']) for (const g of events[event]) assert.ok(typeof g.matcher === 'string' && Array.isArray(g.hooks), event);
  }
  // H15 guards every agy write channel.
  const h15Matchers = Object.values(doc).flatMap((e) => e.PreToolUse.filter((g) => g.hooks.some((h) => h.command.includes('h15-store-guard'))).map((g) => g.matcher));
  for (const name of ['run_command', 'write_file', 'edit_file']) assert.ok(h15Matchers.some((m) => m.split('|').includes(name)), name);
  // A wrapped non-tool event is the shape that makes agy skip the whole file.
  assert.notDeepEqual(agyHooksShapeViolations({ g: { SessionStart: [{ hooks: [{ type: 'command', command: 'node ./hooks/h1-session-start.mjs' }] }] } }), []);
});

test('version parity: package.json and both plugin manifests agree, and a divergence is named', () => {
  assert.deepEqual(versionParityViolations(root), []);
  const agyManifest = JSON.parse(readFileSync(join(root, '.antigravity-plugin', 'plugin.json'), 'utf8'));
  assert.equal(agyManifest.name, 'sterling');
  const dir = mkdtempSync(join(tmpdir(), 'agy-parity-'));
  try {
    mkdirSync(join(dir, '.claude-plugin'));
    mkdirSync(join(dir, '.antigravity-plugin'));
    writeFileSync(join(dir, 'package.json'), '{"version":"1.0.1"}');
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{"version":"1.0.1"}');
    writeFileSync(join(dir, '.antigravity-plugin', 'plugin.json'), '{"version":"1.0.0"}');
    const v = versionParityViolations(dir);
    assert.equal(v.length, 1);
    assert.match(v[0], /\.antigravity-plugin\/plugin\.json 1\.0\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
