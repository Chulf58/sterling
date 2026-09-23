#!/usr/bin/env node
// THROWAWAY live probe — decision
// h22-start-attribution-joins-through-subagent-meta-sidecar-after-a-live-probe
// (knowledge_get e2fcc4c0), point (1). Measures whether Claude Code's
// undocumented sidecar ~/.claude/projects/<proj>/<session>/subagents/
// agent-<agent_id>.meta.json (with toolUseId) is readable and correct when
// SubagentStart fires. Registered by hand as a hook command for
// PreToolUse(Agent), SubagentStart and PostToolUse(Agent); see
// README-sidecar-probe.md. Dependency-free on purpose.
//
// Appends one JSON line per event to $SIDECAR_PROBE_OUT, else
// $CLAUDE_PROJECT_DIR/.sterling/transient/sidecar-probe.jsonl (payload cwd if
// CLAUDE_PROJECT_DIR is unset; the line records which). It ALWAYS exits 0 with
// empty stdout: any failure is recorded in the line's `error` field, and only a
// failed append itself reaches stderr. It must never affect the session.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const entryHr = process.hrtime.bigint();
const entryWall = Date.now();
const sinceEntry = () => Number(process.hrtime.bigint() - entryHr) / 1e6;

const POLL_INTERVAL_MS = 10;
const envBudget = Number(process.env.SIDECAR_PROBE_POLL_BUDGET_MS);
const POLL_BUDGET_MS = Number.isFinite(envBudget) && envBudget >= 0 ? envBudget : 2000;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleepCell, 0, 0, ms);

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const str = (v) => (typeof v === 'string' ? v : null);

function classifySidecar(path) {
  if (!existsSync(path)) return { state: 'missing' };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { state: 'invalid', reason: `read: ${e.code ?? e.message}` };
  }
  let meta;
  try {
    meta = JSON.parse(text);
  } catch {
    return { state: 'invalid', reason: 'unparseable', bytes: text.length };
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { state: 'invalid', reason: 'not-an-object' };
  if (typeof meta.toolUseId !== 'string' || meta.toolUseId === '') return { state: 'invalid', reason: 'no-toolUseId', meta };
  return { state: 'valid', meta };
}

// Sidecar path candidates derived from the Start payload. The first is the
// layout measured on disk (transcript_path = <proj>/<session>.jsonl); the
// others cover a transcript_path that is session-dir-shaped or the child's own.
function derivations(payload) {
  const tp = str(payload.transcript_path);
  const sid = str(payload.session_id);
  const aid = str(payload.agent_id);
  if (!tp || !aid) return [];
  const file = `agent-${aid}.meta.json`;
  const out = [];
  if (sid) out.push({ name: 'transcript-dir/session/subagents', path: join(dirname(tp), sid, 'subagents', file) });
  if (tp.endsWith('.jsonl')) out.push({ name: 'transcript-stem/subagents', path: join(tp.slice(0, -'.jsonl'.length), 'subagents', file) });
  out.push({ name: 'transcript-dir', path: join(dirname(tp), file) });
  const seen = new Set();
  return out
    .filter((d) => (seen.has(d.path) ? false : seen.add(d.path)))
    .map((d) => ({ ...d, exists_on_entry: existsSync(d.path) }));
}

function line1Facts(jsonlPath) {
  if (!existsSync(jsonlPath)) return { child_jsonl_exists: false, child_line1_kind: null, child_line1_sha256: null };
  const text = readFileSync(jsonlPath, 'utf8');
  const first = text.split('\n', 1)[0];
  let content;
  try {
    content = JSON.parse(first)?.message?.content;
  } catch {
    return { child_jsonl_exists: true, child_line1_kind: 'unparseable', child_line1_sha256: null };
  }
  if (typeof content === 'string') return { child_jsonl_exists: true, child_line1_kind: 'string', child_line1_sha256: sha256(content) };
  if (Array.isArray(content)) {
    const joined = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    return { child_jsonl_exists: true, child_line1_kind: 'array', child_line1_sha256: sha256(joined) };
  }
  return { child_jsonl_exists: true, child_line1_kind: content === undefined ? 'absent' : typeof content, child_line1_sha256: null };
}

function onStart(payload, rec) {
  rec.agent_id = str(payload.agent_id);
  rec.agent_type = str(payload.agent_type);
  rec.prompt_id = str(payload.prompt_id);
  rec.transcript_path = str(payload.transcript_path);
  rec.agent_transcript_path = str(payload.agent_transcript_path);
  const ds = derivations(payload);
  rec.derivations = ds;
  if (ds.length === 0) {
    rec.sidecar_state_on_entry = 'underivable';
    rec.sidecar_state_final = 'underivable';
    rec.first_valid_ms = null;
    rec.first_valid_after_first_check_ms = null;
    return;
  }
  const firstCheck = sinceEntry();
  rec.first_check_ms = firstCheck;
  let polls = 0;
  let found = null;
  let last = null;
  let onEntry = null;
  for (;;) {
    polls += 1;
    const tick = ds.map((d) => ({ d, c: classifySidecar(d.path) }));
    const valid = tick.find((x) => x.c.state === 'valid');
    // Reported per tick: a valid candidate, else an invalid one, else the primary derivation.
    last = valid ?? tick.find((x) => x.c.state === 'invalid') ?? tick[0];
    if (onEntry === null) onEntry = last.c.state;
    if (valid) { found = { ...valid, at: sinceEntry() }; break; }
    if (sinceEntry() - firstCheck >= POLL_BUDGET_MS) break;
    sleep(POLL_INTERVAL_MS);
  }
  rec.polls = polls;
  rec.sidecar_state_on_entry = onEntry;
  const final = found ?? last;
  rec.sidecar_state_final = final.c.state;
  rec.sidecar_invalid_reason = final.c.reason ?? null;
  rec.sidecar_path = final.d.path;
  rec.sidecar_derivation = final.d.name;
  rec.first_valid_ms = found ? found.at : null;
  rec.first_valid_after_first_check_ms = found ? found.at - firstCheck : null;
  rec.sidecar_tool_use_id = found ? found.c.meta.toolUseId : null;
  rec.sidecar_agent_type = found ? str(found.c.meta.agentType) : null;
  rec.sidecar_meta = found ? found.c.meta : null;
  const jsonl = final.d.path.slice(0, -'.meta.json'.length) + '.jsonl';
  rec.child_jsonl_path = jsonl;
  Object.assign(rec, line1Facts(jsonl));
}

function onPre(payload, rec) {
  const ti = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  rec.tool_name = str(payload.tool_name);
  rec.tool_use_id = str(payload.tool_use_id);
  rec.subagent_type = str(ti.subagent_type);
  rec.description = str(ti.description);
  rec.prompt_is_string = typeof ti.prompt === 'string';
  // Same hashing as scripts/lib/dispatch-register.mjs promptFacts: a non-string prompt hashes as ''.
  rec.prompt_sha256 = sha256(typeof ti.prompt === 'string' ? ti.prompt : '');
  rec.run_in_background = typeof ti.run_in_background === 'boolean' ? ti.run_in_background : null;
}

function onPost(payload, rec) {
  const tr = payload.tool_response;
  rec.tool_name = str(payload.tool_name);
  rec.tool_use_id = str(payload.tool_use_id);
  rec.agent_id = tr && typeof tr === 'object' && !Array.isArray(tr) ? str(tr.agentId) : null;
  rec.tool_response_type = Array.isArray(tr) ? 'array' : typeof tr;
  rec.tool_response_keys = tr && typeof tr === 'object' && !Array.isArray(tr) ? Object.keys(tr) : null;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function outPath(payload) {
  if (process.env.SIDECAR_PROBE_OUT) return { path: process.env.SIDECAR_PROBE_OUT, source: 'SIDECAR_PROBE_OUT' };
  const base = process.env.CLAUDE_PROJECT_DIR || (payload && str(payload.cwd));
  if (!base) return { path: null, source: 'none' };
  return {
    path: join(base, '.sterling', 'transient', 'sidecar-probe.jsonl'),
    source: process.env.CLAUDE_PROJECT_DIR ? 'CLAUDE_PROJECT_DIR' : 'payload-cwd',
  };
}

async function main() {
  const rec = { probe: 'subagent-sidecar', pid: process.pid, entry_wall_ms: entryWall, entry_iso: new Date(entryWall).toISOString(), error: null };
  let payload = null;
  try {
    const raw = await readStdin();
    rec.stdin_read_ms = sinceEntry();
    payload = JSON.parse(raw);
    rec.event = str(payload.hook_event_name);
    rec.session_id = str(payload.session_id);
    rec.cwd = str(payload.cwd);
    rec.payload_keys = Object.keys(payload);
    if (rec.event === 'SubagentStart') onStart(payload, rec);
    else if (rec.event === 'PreToolUse') onPre(payload, rec);
    else if (rec.event === 'PostToolUse') onPost(payload, rec);
    else rec.error = `unhandled event ${JSON.stringify(rec.event)}`;
  } catch (e) {
    rec.error = `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`;
  }
  rec.exit_ms = sinceEntry();
  const out = outPath(payload);
  rec.out_source = out.source;
  if (!out.path) {
    process.stderr.write(`subagent-sidecar-probe: no output path (SIDECAR_PROBE_OUT, CLAUDE_PROJECT_DIR and payload cwd all absent); line dropped\n`);
    return;
  }
  try {
    mkdirSync(dirname(out.path), { recursive: true });
    appendFileSync(out.path, `${JSON.stringify(rec)}\n`);
  } catch (e) {
    process.stderr.write(`subagent-sidecar-probe: append to ${basename(out.path)} failed: ${e?.message ?? e}\n`);
  }
}

main()
  .catch((e) => process.stderr.write(`subagent-sidecar-probe: ${e?.message ?? e}\n`))
  .finally(() => process.exit(0));
