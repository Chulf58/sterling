#!/usr/bin/env node
// THROWAWAY — verdict table for subagent-sidecar-probe.mjs output (decision
// h22-start-attribution-joins-through-subagent-meta-sidecar-after-a-live-probe,
// knowledge_get e2fcc4c0, point (1)).
//
//   node scripts/probes/subagent-sidecar-probe-report.mjs [probe.jsonl] [--json]
//
// Default input: $CLAUDE_PROJECT_DIR (else cwd)/.sterling/transient/sidecar-probe.jsonl.
// Exit 0 = PASS, 1 = FAIL, 2 = NO-DATA (no SubagentStart recorded), 3 = unreadable input.
// PASS only if EVERY SubagentStart read a valid sidecar within the hook's
// lifetime whose toolUseId names a Pre of the same session and type, no Post
// contradicts it, and no toolUseId is claimed by two Starts (a resumed
// agent_id surfacing its OLD key counts as stale).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// UNVERIFIED: a Pre that omits subagent_type is assumed to start as 'general-purpose'.
const DEFAULT_AGENT_TYPE = 'general-purpose';

function parseLines(text) {
  const events = [];
  let unparseable = 0;
  for (const l of text.split('\n')) {
    if (l.trim() === '') continue;
    try {
      events.push(JSON.parse(l));
    } catch {
      unparseable += 1;
    }
  }
  return { events, unparseable };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function analyze(events, { unparseable = 0 } = {}) {
  const preById = new Map();
  const postById = new Map();
  for (const e of events) {
    if (e.event === 'PreToolUse' && e.tool_use_id) preById.set(e.tool_use_id, e);
    if (e.event === 'PostToolUse' && e.tool_use_id) postById.set(e.tool_use_id, e);
  }
  const claimedBy = new Map();
  const seenAgents = new Set();
  const rows = [];
  for (const s of events.filter((e) => e.event === 'SubagentStart')) {
    const key = s.sidecar_tool_use_id ?? null;
    const row = {
      agent_id: s.agent_id ?? null,
      agent_type: s.agent_type ?? null,
      session_id: s.session_id ?? null,
      entry_state: s.sidecar_state_on_entry ?? null,
      final_state: s.sidecar_state_final ?? null,
      invalid_reason: s.sidecar_invalid_reason ?? null,
      derivation: s.sidecar_derivation ?? null,
      first_valid_ms: s.first_valid_ms ?? null,
      hook_exit_ms: s.exit_ms ?? null,
      tool_use_id: key,
      pre_match: 'no-sidecar',
      post_match: 'no-sidecar',
      post_after_start_ms: null,
      line1_vs_pre: 'no-sidecar',
      reused_agent_id: seenAgents.has(s.agent_id),
      stale_resume: false,
      duplicate_key: false,
      error: s.error ?? null,
    };
    seenAgents.add(s.agent_id);
    if (key) {
      const pre = preById.get(key);
      if (!pre) row.pre_match = 'no-pre';
      else if (pre.session_id !== s.session_id) row.pre_match = 'session-mismatch';
      else if ((pre.subagent_type ?? DEFAULT_AGENT_TYPE) !== s.agent_type) row.pre_match = 'type-mismatch';
      else row.pre_match = 'match';

      const post = postById.get(key);
      if (!post) row.post_match = 'no-post';
      else {
        row.post_match = post.agent_id === s.agent_id ? 'match' : 'MISMATCH';
        row.post_after_start_ms = post.entry_wall_ms - s.entry_wall_ms;
      }

      if (!pre) row.line1_vs_pre = 'no-pre';
      else if (!s.child_jsonl_exists) row.line1_vs_pre = 'no-jsonl';
      else if (!s.child_line1_sha256) row.line1_vs_pre = `no-hash(${s.child_line1_kind})`;
      else row.line1_vs_pre = s.child_line1_sha256 === pre.prompt_sha256 ? 'equal' : 'DIFFERS';

      const prior = claimedBy.get(key);
      if (prior !== undefined) {
        if (prior === s.agent_id) row.stale_resume = true;
        else row.duplicate_key = true;
      } else claimedBy.set(key, s.agent_id);
    }
    rows.push(row);
  }

  const count = (field) => rows.reduce((acc, r) => ({ ...acc, [r[field]]: (acc[r[field]] ?? 0) + 1 }), {});
  const lat = rows.map((r) => r.first_valid_ms).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const aggregate = {
    starts: rows.length,
    pres: events.filter((e) => e.event === 'PreToolUse').length,
    posts: events.filter((e) => e.event === 'PostToolUse').length,
    by_entry_state: count('entry_state'),
    by_final_state: count('final_state'),
    latency_to_valid_ms: { n: lat.length, p50: percentile(lat, 0.5), max: lat.length ? lat[lat.length - 1] : null },
    error_lines: events.filter((e) => e.error).length,
    unparseable_lines: unparseable,
  };

  const reasons = [];
  rows.forEach((r, i) => {
    const tag = `start #${i + 1} agent ${r.agent_id}`;
    if (r.final_state !== 'valid' || r.first_valid_ms === null) reasons.push(`${tag}: sidecar ${r.final_state} at hook exit${r.invalid_reason ? ` (${r.invalid_reason})` : ''}`);
    if (r.tool_use_id && r.pre_match !== 'match') reasons.push(`${tag}: toolUseId ${r.tool_use_id} ${r.pre_match}`);
    if (r.post_match === 'MISMATCH') reasons.push(`${tag}: Post for ${r.tool_use_id} bound a different agentId`);
    if (r.stale_resume) reasons.push(`${tag}: stale resume — reused agent_id surfaced OLD key ${r.tool_use_id}`);
    if (r.duplicate_key) reasons.push(`${tag}: toolUseId ${r.tool_use_id} already claimed by another agent`);
    if (r.error) reasons.push(`${tag}: probe error ${r.error}`);
  });
  const verdict = rows.length === 0 ? 'NO-DATA' : reasons.length === 0 ? 'PASS' : 'FAIL';
  return { verdict, reasons, aggregate, rows };
}

function renderTable(result) {
  const cols = ['#', 'agent_id', 'type', 'entry', 'final', 'valid_ms', 'exit_ms', 'pre', 'post', 'line1', 'resume'];
  const fmt = (v) => (typeof v === 'number' ? v.toFixed(1) : v === null || v === undefined ? '-' : String(v));
  const body = result.rows.map((r, i) => [
    String(i + 1), r.agent_id, r.agent_type, r.entry_state, r.final_state, r.first_valid_ms, r.hook_exit_ms,
    r.pre_match, r.post_match, r.line1_vs_pre, r.stale_resume ? 'STALE' : r.duplicate_key ? 'DUP-KEY' : r.reused_agent_id ? 'reused' : '',
  ].map(fmt));
  const widths = cols.map((c, i) => Math.max(c.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const out = [line(cols), line(widths.map((w) => '-'.repeat(w))), ...body.map(line), ''];
  const a = result.aggregate;
  out.push(`starts ${a.starts}, pres ${a.pres}, posts ${a.posts}, error lines ${a.error_lines}, unparseable lines ${a.unparseable_lines}`);
  out.push(`entry states: ${JSON.stringify(a.by_entry_state)}  final states: ${JSON.stringify(a.by_final_state)}`);
  out.push(`latency to valid (ms from hook entry): n=${a.latency_to_valid_ms.n} p50=${fmt(a.latency_to_valid_ms.p50)} max=${fmt(a.latency_to_valid_ms.max)}`);
  out.push(`VERDICT: ${result.verdict}`);
  for (const r of result.reasons) out.push(`  - ${r}`);
  return `${out.join('\n')}\n`;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const file = args.find((a) => a !== '--json') ?? join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.sterling', 'transient', 'sidecar-probe.jsonl');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`cannot read ${file}: ${e.message}\n`);
    process.exit(3);
  }
  const { events, unparseable } = parseLines(text);
  const result = analyze(events, { unparseable });
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderTable(result));
  process.exit(result.verdict === 'PASS' ? 0 : result.verdict === 'FAIL' ? 1 : 2);
}
