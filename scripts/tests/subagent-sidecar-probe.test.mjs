// THROWAWAY live-probe harness tests — decision
// h22-start-attribution-joins-through-subagent-meta-sidecar-after-a-live-probe
// (knowledge_get e2fcc4c0), point (1). Feeds synthetic hook payloads and
// fixture sidecars to scripts/probes/subagent-sidecar-probe.mjs, then checks
// the jsonl lines it appends and the verdicts
// scripts/probes/subagent-sidecar-probe-report.mjs derives from them. These
// tests are the "simulated" half of the probe protocol: missing, malformed,
// late and stale-from-resume sidecars are fed here, not in the live batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE = join(root, 'scripts', 'probes', 'subagent-sidecar-probe.mjs');
const REPORT = join(root, 'scripts', 'probes', 'subagent-sidecar-probe-report.mjs');

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-probe-'));
  const projects = join(dir, 'projects', '-proj');
  const session = 'sess-1';
  mkdirSync(join(projects, session, 'subagents'), { recursive: true });
  const out = join(dir, 'out', 'sidecar-probe.jsonl');
  return {
    dir,
    out,
    session,
    transcript: join(projects, `${session}.jsonl`),
    sidecar: (agentId) => join(projects, session, 'subagents', `agent-${agentId}.meta.json`),
    childJsonl: (agentId) => join(projects, session, 'subagents', `agent-${agentId}.jsonl`),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function env(fx, extra = {}) {
  return { ...process.env, SIDECAR_PROBE_OUT: fx.out, SIDECAR_PROBE_POLL_BUDGET_MS: '300', ...extra };
}

function runProbe(fx, payload, extraEnv) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return spawnSync(process.execPath, [PROBE], { input, env: env(fx, extraEnv), encoding: 'utf8' });
}

function lines(fx) {
  return readFileSync(fx.out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

function report(fx) {
  const r = spawnSync(process.execPath, [REPORT, fx.out, '--json'], { encoding: 'utf8' });
  assert.equal(r.stderr, '', `report stderr: ${r.stderr}`);
  return { status: r.status, result: JSON.parse(r.stdout) };
}

const pre = (fx, id, prompt, type = 'implementor', extra = {}) => ({
  hook_event_name: 'PreToolUse',
  session_id: fx.session,
  transcript_path: fx.transcript,
  cwd: fx.dir,
  tool_name: 'Agent',
  tool_use_id: id,
  tool_input: { subagent_type: type, description: 'd', prompt, ...extra },
});
const start = (fx, agentId, type = 'implementor') => ({
  hook_event_name: 'SubagentStart',
  session_id: fx.session,
  transcript_path: fx.transcript,
  cwd: fx.dir,
  prompt_id: 'p1',
  agent_id: agentId,
  agent_type: type,
});
const post = (fx, id, agentId) => ({
  hook_event_name: 'PostToolUse',
  session_id: fx.session,
  transcript_path: fx.transcript,
  cwd: fx.dir,
  tool_name: 'Agent',
  tool_use_id: id,
  tool_response: { agentId, status: 'completed' },
});
const writeSidecar = (fx, agentId, toolUseId, type = 'implementor') =>
  writeFileSync(fx.sidecar(agentId), JSON.stringify({ agentType: type, description: 'd', toolUseId }));
const writeChild = (fx, agentId, content) =>
  writeFileSync(fx.childJsonl(agentId), `${JSON.stringify({ type: 'user', agentId, message: { role: 'user', content } })}\n`);

test('Pre records tool_use_id, type, prompt sha256 and run_in_background; exit 0, empty stdout', (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const r = runProbe(fx, pre(fx, 'toolu_A', 'do the thing', 'implementor', { run_in_background: true }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const [l] = lines(fx);
  assert.equal(l.event, 'PreToolUse');
  assert.equal(l.tool_use_id, 'toolu_A');
  assert.equal(l.subagent_type, 'implementor');
  assert.equal(l.prompt_sha256, sha('do the thing'));
  assert.equal(l.run_in_background, true);
  assert.equal(l.session_id, fx.session);
  assert.equal(typeof l.entry_wall_ms, 'number');
  assert.equal(l.error, null);
});

test('valid sidecar present at Start: state valid on entry, derivations recorded, line-1 hash; report PASS', (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  runProbe(fx, pre(fx, 'toolu_A', 'prompt A'));
  writeSidecar(fx, 'a1', 'toolu_A');
  writeChild(fx, 'a1', 'prompt A');
  const r = runProbe(fx, start(fx, 'a1'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  runProbe(fx, post(fx, 'toolu_A', 'a1'));
  const [, s, p] = lines(fx);
  assert.equal(s.event, 'SubagentStart');
  assert.equal(s.sidecar_state_on_entry, 'valid');
  assert.equal(s.sidecar_state_final, 'valid');
  assert.equal(s.sidecar_tool_use_id, 'toolu_A');
  assert.equal(s.sidecar_path, fx.sidecar('a1'));
  const d = s.derivations.find((x) => x.name === 'transcript-dir/session/subagents');
  assert.ok(d, 'the dirname(transcript_path)/<session_id>/subagents derivation is recorded');
  assert.equal(d.path, fx.sidecar('a1'));
  assert.equal(d.exists_on_entry, true);
  assert.equal(typeof s.first_valid_ms, 'number');
  assert.equal(s.child_jsonl_exists, true);
  assert.equal(s.child_line1_sha256, sha('prompt A'));
  assert.equal(p.event, 'PostToolUse');
  assert.equal(p.tool_use_id, 'toolu_A');
  assert.equal(p.agent_id, 'a1');

  const { status, result } = report(fx);
  assert.equal(result.verdict, 'PASS');
  assert.equal(status, 0);
  const [row] = result.rows;
  assert.equal(row.pre_match, 'match');
  assert.equal(row.post_match, 'match');
  assert.equal(row.line1_vs_pre, 'equal');
  assert.equal(result.aggregate.by_entry_state.valid, 1);
});

test('array-shaped line-1 content hashes its joined text parts', (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  writeSidecar(fx, 'a1', 'toolu_A');
  writeChild(fx, 'a1', [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }]);
  runProbe(fx, start(fx, 'a1'));
  const [s] = lines(fx);
  assert.equal(s.child_line1_kind, 'array');
  assert.equal(s.child_line1_sha256, sha('part one part two'));
});

test('missing sidecar: polled to the budget, never valid; report FAIL', (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  runProbe(fx, pre(fx, 'toolu_A', 'prompt A'));
  const r = runProbe(fx, start(fx, 'a1'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const s = lines(fx)[1];
  assert.equal(s.sidecar_state_on_entry, 'missing');
  assert.equal(s.sidecar_state_final, 'missing');
  assert.equal(s.first_valid_ms, null);
  assert.ok(s.polls > 1, `polled ${s.polls} times`);
  assert.ok(s.exit_ms >= 250, `hook lived ${s.exit_ms} ms, budget 300`);
  assert.equal(s.child_jsonl_exists, false);
  const { status, result } = report(fx);
  assert.equal(result.verdict, 'FAIL');
  assert.notEqual(status, 0);
  assert.equal(result.aggregate.by_entry_state.missing, 1);
});

test('malformed sidecar is classified invalid, not valid; report FAIL', (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  runProbe(fx, pre(fx, 'toolu_A', 'prompt A'));
  writeFileSync(fx.sidecar('a1'), '{"agentType":"implementor", "toolUse');
  runProbe(fx, start(fx, 'a1'));
  const s = lines(fx)[1];
  assert.equal(s.sidecar_state_on_entry, 'invalid');
  assert.equal(s.sidecar_state_final, 'invalid');
  assert.equal(s.first_valid_ms, null);
  const { result } = report(fx);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.aggregate.by_entry_state.invalid, 1);
});

test('a sidecar without a toolUseId string is invalid', (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  writeFileSync(fx.sidecar('a1'), JSON.stringify({ agentType: 'implementor' }));
  runProbe(fx, start(fx, 'a1'));
  assert.equal(lines(fx)[0].sidecar_state_on_entry, 'invalid');
});

test('sidecar created 50 ms late: missing on entry, first valid read recorded after re-poll', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  runProbe(fx, pre(fx, 'toolu_A', 'prompt A'));
  const child = spawn(process.execPath, [PROBE], { env: env(fx, { SIDECAR_PROBE_POLL_BUDGET_MS: '2000' }) });
  const exited = once(child, 'exit');
  child.stdin.on('error', () => {});
  let stdout = '';
  child.stdout.on('data', (b) => { stdout += b; });
  // Hold stdin until the process is certainly up, then release the payload and
  // create the sidecar 50 ms later, so "missing on entry" is deterministic.
  await new Promise((r) => setTimeout(r, 400));
  child.stdin.end(JSON.stringify(start(fx, 'a1')));
  await new Promise((r) => setTimeout(r, 50));
  writeSidecar(fx, 'a1', 'toolu_A');
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(stdout, '');
  const s = lines(fx)[1];
  assert.equal(s.sidecar_state_on_entry, 'missing');
  assert.equal(s.sidecar_state_final, 'valid');
  assert.ok(s.first_valid_after_first_check_ms >= 20, `first valid ${s.first_valid_after_first_check_ms} ms after first check`);
  assert.ok(s.first_valid_after_first_check_ms < 1500, `first valid ${s.first_valid_after_first_check_ms} ms after first check`);
  assert.ok(s.first_valid_ms >= s.first_valid_after_first_check_ms);
  const { result } = report(fx);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.aggregate.by_entry_state.missing, 1);
  assert.equal(result.aggregate.by_final_state.valid, 1);
  assert.equal(typeof result.aggregate.latency_to_valid_ms.p50, 'number');
});

test('stale-from-resume: a reused agent_id whose sidecar still names the OLD Pre is flagged; report FAIL', (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  runProbe(fx, pre(fx, 'toolu_OLD', 'first prompt'));
  writeSidecar(fx, 'a1', 'toolu_OLD');
  runProbe(fx, start(fx, 'a1'));
  runProbe(fx, post(fx, 'toolu_OLD', 'a1'));
  // Resume: a new Pre, the same agent_id starts again, the sidecar was not rewritten.
  runProbe(fx, pre(fx, 'toolu_NEW', 'resume prompt'));
  runProbe(fx, start(fx, 'a1'));
  const { result } = report(fx);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].stale_resume, false);
  assert.equal(result.rows[1].reused_agent_id, true);
  assert.equal(result.rows[1].stale_resume, true);
  assert.ok(result.reasons.some((r) => /stale/i.test(r)), result.reasons.join('; '));
});

test('toolUseId naming a Pre of another type, or contradicting Post, is not a match', (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  runProbe(fx, pre(fx, 'toolu_A', 'prompt A', 'researcher'));
  writeSidecar(fx, 'a1', 'toolu_A');
  runProbe(fx, start(fx, 'a1', 'implementor'));
  runProbe(fx, pre(fx, 'toolu_B', 'prompt B'));
  writeSidecar(fx, 'b1', 'toolu_B');
  runProbe(fx, start(fx, 'b1'));
  runProbe(fx, post(fx, 'toolu_B', 'someone-else'));
  const { result } = report(fx);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.rows[0].pre_match, 'type-mismatch');
  assert.equal(result.rows[1].pre_match, 'match');
  assert.equal(result.rows[1].post_match, 'MISMATCH');
});

test('six-way same-type batch, every sidecar valid and distinct: PASS with aggregate counts', (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  for (let i = 0; i < 6; i++) runProbe(fx, pre(fx, `toolu_${i}`, 'same prompt', 'implementor', { run_in_background: true }));
  for (let i = 0; i < 6; i++) {
    writeSidecar(fx, `a${i}`, `toolu_${i}`);
    runProbe(fx, start(fx, `a${i}`));
  }
  const { result } = report(fx);
  assert.equal(result.verdict, 'PASS', result.reasons.join('; '));
  assert.equal(result.aggregate.starts, 6);
  assert.equal(result.aggregate.by_entry_state.valid, 6);
  assert.ok(result.rows.every((r) => r.post_match === 'no-post'));
});

test('garbage stdin and an unwritable out path still exit 0 with empty stdout', (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const r1 = runProbe(fx, 'not json {');
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout, '');
  const [l] = lines(fx);
  assert.equal(typeof l.error, 'string');
  assert.ok(l.error.length > 0);

  writeFileSync(join(fx.dir, 'blocker'), 'x');
  const r2 = runProbe(fx, pre(fx, 'toolu_A', 'p'), { SIDECAR_PROBE_OUT: join(fx.dir, 'blocker', 'nested', 'out.jsonl') });
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, '');
});

test('out path defaults to $CLAUDE_PROJECT_DIR/.sterling/transient/sidecar-probe.jsonl', (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const e = env(fx, { CLAUDE_PROJECT_DIR: fx.dir });
  delete e.SIDECAR_PROBE_OUT;
  const r = spawnSync(process.execPath, [PROBE], { input: JSON.stringify(pre(fx, 'toolu_A', 'p')), env: e, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(existsSync(join(fx.dir, '.sterling', 'transient', 'sidecar-probe.jsonl')));
});

test('report with no Start events is NO-DATA, never PASS', (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  runProbe(fx, pre(fx, 'toolu_A', 'p'));
  const { status, result } = report(fx);
  assert.equal(result.verdict, 'NO-DATA');
  assert.notEqual(status, 0);
});
