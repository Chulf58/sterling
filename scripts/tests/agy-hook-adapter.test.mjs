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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAgyInput, normalizeAgyInput, agyExitEnvelope, agyInjectEnvelope, AGY_PRETOOLUSE_KEYS } from '../hooks/lib/common.mjs';
import { agyRoleVerdict, rolesInConversationBytes, CONVERSATIONS_DIR_ENV } from '../hooks/lib/agy-role-guard.mjs';
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

function run(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A throwaway hook that reads stdin through common.mjs and then runs `body`. */
function harness(dir, body) {
  const p = join(dir, 'harness.mjs');
  writeFileSync(p, `import { writeFileSync } from 'node:fs';\nimport { readStdin, allow, deny, exitAfterWrite } from ${JSON.stringify(COMMON)};\nconst input = readStdin();\n${body}\n`);
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
    // The queue drain reads every invocation, as queue-only past the first.
    const drain = normalizeAgyInput(agy('PreInvocation', '/w', { invocationNum }), { agyEveryInvocation: true });
    assert.equal(drain.skip, null);
    assert.equal(drain.input.agy_queue_only, true);
  }
  assert.equal(normalizeAgyInput(agy('PreInvocation', '/w', { invocationNum: 0 }), { agyEveryInvocation: true }).input.agy_queue_only, undefined);
});

test('a subagent conversation (lastUserInput "") skips SessionStart, PreInvocation and Stop, but not its tool events or its queue drain', () => {
  for (const event of ['SessionStart', 'PreInvocation', 'Stop']) {
    assert.equal(normalizeAgyInput(agy(event, '/w', { lastUserInput: '', invocationNum: 0 })).skip, 'subagent conversation', event);
  }
  assert.equal(normalizeAgyInput(agy('PreInvocation', '/w', { lastUserInput: '', invocationNum: 0 }), { agyEveryInvocation: true }).input.agy_queue_only, true);
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

test('envelopes: a block becomes a JSON deny or continue with exit 0; PreToolUse only ever carries the keys agy accepts', () => {
  assert.deepEqual(agyExitEnvelope({ event: 'PreToolUse', err: 'H15: no\n', code: 2 }), { text: '{"decision":"deny","reason":"H15: no"}', code: 0 });
  assert.deepEqual(agyExitEnvelope({ event: 'PreToolUse', code: 0 }), { text: '{"decision":"allow"}', code: 0 });
  assert.deepEqual(agyExitEnvelope({ event: 'Stop', err: 'duty', code: 2 }), { text: '{"decision":"continue","reason":"duty"}', code: 0 });
  assert.deepEqual(agyExitEnvelope({ event: 'Stop', err: 'duty', code: 2, stopContinue: false }), { text: '{"decision":"allow"}', code: 0 });
  assert.deepEqual(agyExitEnvelope({ event: 'Stop', code: 0 }), { text: '{"decision":"allow"}', code: 0 });
  assert.deepEqual(agyExitEnvelope({ event: 'SessionStart', code: 0, emitted: true }), { text: '', code: 0 });
  assert.equal(agyExitEnvelope({ event: 'SessionStart', code: 0 }).text, '{}');
  assert.equal(agyExitEnvelope({ event: 'PostToolUse', code: 0 }).text, '{}');
  assert.deepEqual(agyExitEnvelope({ event: 'PostToolUse', code: 1 }), { text: '', code: 1 });
  for (const args of [{ code: 0 }, { code: 2, err: 'x' }, { code: 0, emitted: true }]) {
    const { text } = agyExitEnvelope({ event: 'PreToolUse', ...args });
    for (const key of Object.keys(JSON.parse(text))) assert.ok(AGY_PRETOOLUSE_KEYS.includes(key), key);
  }
  assert.deepEqual(JSON.parse(agyInjectEnvelope(['C', 'S'])), { injectSteps: [{ systemMessage: { systemMessage: 'C' } }, { systemMessage: { systemMessage: 'S' } }] });
  assert.equal(agyInjectEnvelope([]), '{}');
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

// ── the agy context queue and the invocationNum gate, through the real drain ─

const CONV = 'c0ffee00-0000-4000-8000-000000000001';
const OTHER = 'c0ffee00-0000-4000-8000-0000000000ff';
const agyNotices = (dir) => (existsSync(join(dir, '.sterling', 'transient', 'notices')) ? readdirSync(join(dir, '.sterling', 'transient', 'notices')).filter((n) => n.startsWith('agy-')) : []);

test('PreInvocation: H10 notices drain only on invocationNum 0; this conversation\'s agy queue drains on any call; another conversation\'s queue stays', () => {
  const dir = project();
  try {
    const notices = join(dir, '.sterling', 'transient', 'notices');
    mkdirSync(notices, { recursive: true });
    const h10Notice = join(notices, '0001.json');
    writeFileSync(h10Notice, JSON.stringify({ text: 'NOTICE-FOR-AGY' }));
    const mine = join(notices, `agy-${CONV}-1.json`);
    writeFileSync(mine, JSON.stringify({ text: 'QUEUED-DELIVERY', session_id: CONV }));
    const theirs = join(notices, `agy-${OTHER}-1.json`);
    writeFileSync(theirs, JSON.stringify({ text: 'SUBAGENT-DELIVERY', session_id: OTHER }));
    const drain = join(HOOKS, 'h19-delivery-drain.mjs');
    const later = run(drain, agy('PreInvocation', dir, { invocationNum: 3, initialNumSteps: 9 }), dir);
    assert.equal(later.code, 0, later.stderr);
    assert.deepEqual(JSON.parse(later.stdout), { injectSteps: [{ systemMessage: { systemMessage: 'QUEUED-DELIVERY' } }] });
    assert.ok(!existsSync(mine), 'the drained queue entry is removed');
    assert.ok(existsSync(h10Notice), 'a later model call must not consume the H10 notice');
    const empty = run(drain, agy('PreInvocation', dir, { invocationNum: 4 }), dir);
    assert.equal(empty.stdout, '{}', 'the queue drains once');
    const first = run(drain, agy('PreInvocation', dir, { invocationNum: 0, initialNumSteps: 1 }), dir);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { injectSteps: [{ systemMessage: { systemMessage: 'NOTICE-FOR-AGY' } }] });
    assert.ok(!existsSync(h10Notice));
    assert.ok(existsSync(theirs), "another conversation's live queue is left for it to drain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queued delivery: PreToolUse and PostToolUse context is queued, the envelope stays bare, and bookkeeping runs only once the entry is queued', () => {
  const dir = project();
  try {
    const marker = join(dir, 'marked');
    const h = harness(
      dir,
      `exitAfterWrite(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: 'CTX-' + input.hook_event_name } }), 0, { onWritten: () => writeFileSync(${JSON.stringify(marker)}, 'x') });`
    );
    const pre = run(h, agy('PreToolUse', dir, tool('edit_file', { Path: join(dir, 'a.txt'), Target: 'a', Replacement: 'b' })), dir);
    assert.equal(pre.code, 0, pre.stderr);
    assert.equal(pre.stdout, '{"decision":"allow"}', 'no key outside decision/reason/overwrite/permissionOverrides, and no reason');
    assert.ok(existsSync(marker));
    rmSync(marker);
    const post = run(h, agy('PostToolUse', dir, { error: '', ...tool('read_file', { Path: join(dir, 'a.txt') }) }), dir);
    assert.equal(post.code, 0, post.stderr);
    assert.equal(post.stdout, '{}');
    assert.ok(existsSync(marker));
    const queued = agyNotices(dir).map((n) => JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'notices', n), 'utf8')));
    assert.deepEqual(queued.map((q) => q.text).sort(), ['CTX-PostToolUse', 'CTX-PreToolUse']);
    assert.ok(queued.every((q) => q.session_id === CONV));
    // A queue that cannot be written: no bookkeeping, a non-zero exit (logged by agy).
    rmSync(marker);
    rmSync(join(dir, '.sterling', 'transient', 'notices'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'notices'), 'not a directory');
    const failed = run(h, agy('PostToolUse', dir, { error: '', ...tool('read_file', { Path: join(dir, 'a.txt') }) }), dir);
    assert.notEqual(failed.code, 0);
    assert.ok(!existsSync(marker), 'nothing is marked delivered when the queue write failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Stop's loop guard ───────────────────────────────────────────────────────

test('Stop: a blocking hook continues once per user turn; the next Stop of that turn with the same duties lets agy stop', () => {
  const dir = project();
  try {
    const h = harness(dir, `if (input.stop_hook_active) allow(); deny('STERLING: capture duties are owed.\\n');`);
    const stop = (extra) => agy('Stop', dir, { executionNum: 1, terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, continuationActive: false, ...extra });
    const owed = run(h, stop(), dir);
    assert.equal(owed.code, 0, owed.stderr);
    assert.deepEqual(JSON.parse(owed.stdout), { decision: 'continue', reason: 'STERLING: capture duties are owed.' });
    // continuationActive stays false on the continued Stop (measured), so the guard is the adapter's own.
    const again = run(h, stop({ executionNum: 2 }), dir);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout), { decision: 'allow' });
    // Even a hook that ignores stop_hook_active is released on the repeat.
    const stubborn = harness(dir, `deny('STERLING: capture duties are owed.\\n');`);
    assert.deepEqual(JSON.parse(run(stubborn, stop({ executionNum: 3 }), dir).stdout), { decision: 'allow' });
    // A new user turn may be continued again.
    const next = run(h, stop({ lastUserInput: 'now do the next thing' }), dir);
    assert.deepEqual(JSON.parse(next.stdout), { decision: 'continue', reason: 'STERLING: capture duties are owed.' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the read-only role guard (H15 on call_mcp_tool) ────────────────────────

/** A conversation db shaped like the measured record: ...\x0dSystem Prompt\x12 <varint length> <agent.md body>... */
function conversationBytes(body) {
  const b = Buffer.from(body, 'utf8');
  const len = [];
  let n = b.length;
  while (n > 0x7f) {
    len.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  len.push(n);
  return Buffer.concat([Buffer.from('SQLite format 3\0junk\x0a\x08Assistant', 'latin1'), Buffer.from('\x0dSystem Prompt\x12', 'latin1'), Buffer.from(len), b, Buffer.from('\x1a\x04tail', 'latin1')]);
}
const agentBody = (role) => `STERLING-ROLE: ${role}\n\n# Role & owned judgment\n\n${'You review a finished diff. '.repeat(20)}`;

test('role marker parsing: anchored on the System Prompt record, with one- and two-byte lengths', () => {
  assert.deepEqual(rolesInConversationBytes(conversationBytes(agentBody('reviewer'))), ['reviewer']);
  assert.deepEqual(rolesInConversationBytes(conversationBytes('STERLING-ROLE: scout\nshort')), ['scout']);
  // A role merely quoted in the conversation does not count.
  assert.deepEqual(rolesInConversationBytes(Buffer.from('the user said STERLING-ROLE: reviewer here', 'latin1')), []);
  assert.deepEqual(rolesInConversationBytes(conversationBytes('You are an agent.\nSTERLING-ROLE: reviewer')), []);
});

test('H15 under agy denies a store write by a read-only role, allows a writing role, and fails open with one warning per conversation', () => {
  const dir = project();
  const convs = mkdtempSync(join(tmpdir(), 'agy-convs-'));
  try {
    const h15 = join(HOOKS, 'h15-store-guard.mjs');
    const env = { [CONVERSATIONS_DIR_ENV]: convs };
    const call = (conv, toolName = 'knowledge_create', server = 'sterling') =>
      agy('PreToolUse', dir, { conversationId: conv, lastUserInput: '', ...tool('call_mcp_tool', { ServerName: server, ToolName: toolName, Arguments: { type: 'decision' } }) });
    const ids = { reviewer: 'aaaaaaaa-0000-4000-8000-000000000001', implementor: 'aaaaaaaa-0000-4000-8000-000000000002', librarian: 'aaaaaaaa-0000-4000-8000-000000000003', nomarker: 'aaaaaaaa-0000-4000-8000-000000000004', missing: 'aaaaaaaa-0000-4000-8000-000000000005' };
    for (const role of ['reviewer', 'implementor', 'librarian']) writeFileSync(join(convs, `${ids[role]}.db`), conversationBytes(agentBody(role)));
    writeFileSync(join(convs, `${ids.nomarker}.db`), conversationBytes('# An agent body without the marker\n'));

    const denied = run(h15, call(ids.reviewer), dir, env);
    assert.equal(denied.code, 0, denied.stderr);
    assert.equal(JSON.parse(denied.stdout).decision, 'deny');
    assert.match(JSON.parse(denied.stdout).reason, /reviewer agent is read-only/);
    for (const role of ['implementor', 'librarian']) assert.deepEqual(JSON.parse(run(h15, call(ids[role]), dir, env).stdout), { decision: 'allow' }, role);
    // A read by a read-only role, and a non-Sterling server, are not its business.
    assert.deepEqual(JSON.parse(run(h15, call(ids.reviewer, 'knowledge_get'), dir, env).stdout), { decision: 'allow' });
    assert.deepEqual(JSON.parse(run(h15, call(ids.reviewer, 'knowledge_create', 'other'), dir, env).stdout), { decision: 'allow' });

    for (const key of ['missing', 'nomarker']) {
      const first = run(h15, call(ids[key]), dir, env);
      assert.deepEqual(JSON.parse(first.stdout), { decision: 'allow' }, key);
      const second = run(h15, call(ids[key]), dir, env);
      assert.deepEqual(JSON.parse(second.stdout), { decision: 'allow' }, key);
      const warnings = agyNotices(dir)
        .map((n) => JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'notices', n), 'utf8')))
        .filter((q) => q.session_id === ids[key]);
      assert.equal(warnings.length, 1, `${key}: one warning per conversation`);
      assert.match(warnings[0].text, /read-only roles are unenforced on agy: /);
    }
    assert.match(agyRoleVerdict({ toolName: 'mcp__sterling__knowledge_create', conversationId: ids.missing, dir: convs, writeTools: () => new Set(['knowledge_create']) }).cause, /could not be read \(ENOENT\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(convs, { recursive: true, force: true });
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
