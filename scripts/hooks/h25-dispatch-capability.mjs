// H25 — dispatch-time tool-capability advisory (board f42e5313). PreToolUse
// Task|Agent, joins the existing entry (after h8-dispatch-cap and
// h20-mechanism-axis). NEVER a denial — no path exits 2; internal failures
// exit 1 via warnNonBlocking (loud, non-blocking), all others exit 0. Governing
// decision: knowledge_get dc6c1afb-2fdf-4fa1-a303-f9bc476d086e (slug
// dispatch-capability-advisory-h25) is the authority on semantics; the frozen
// suite (scripts/tests/h25-dispatch-capability.test.mjs) is authoritative
// where more specific.
//
// WHAT IT DOES: resolves tool_input.subagent_type to the INSTALLED agent
// definition (<project>/.claude/agents/<type>.md frontmatter `tools:` line —
// the live per-machine truth, not the shipped template), scans the outgoing
// tool_input.prompt for KNOWN TOOL-NAME TOKENS (the platform tools plus the
// Sterling MCP short names, matched as WHOLE TOKENS — word-boundary, and
// case-insensitive for platform names so a lowercase 'bash' still counts),
// and when the brief names a tool the agent's grant does not hold, emits a
// LOUD WARNING via hookSpecificOutput.additionalContext naming each missing
// tool, the agent type, the agent's actual grant (the literal frontmatter
// value), and a remedy (re-target the dispatch, re-scope the brief, or state
// why the mention is not a requirement). A short MCP name is GRANTED when the
// frontmatter holds the bare name OR any mcp-prefixed form ending in
// `__<name>` (mcp__sterling__X / mcp__plugin_sterling_sterling__X). An
// unknown subagent_type (no installed file) gets a DIFFERENT, distinct notice
// — capability cannot be checked at all — never phrased like the missing-tool
// warning. A frontmatter with no `tools:` line means all-tools (the platform
// default) and stays silent. Malformed stdin / a missing prompt or
// subagent_type all allow silently, no crash.
//
// WHY: measured misdispatches (board f42e5313) — five-plus across four
// retros/assessments (2026-08-15-1520, 08-17-1820, 08-19-1145, 08-20), plus
// this same-day session's two coder-for-test-authoring dispatches that H5
// blocked (~166k subagent tokens) after a frontmatter-vs-brief check would
// have flagged the mismatch before the spawn. Warn-only, never deny (P1): a
// brief may mention a tool in a prohibition ('do NOT run Bash') or as
// context rather than a requirement, so a hard block would false-positive —
// the dispatcher sees the warning at the moment it can still cancel.
import { readStdin, allow, warnNonBlocking } from './lib/common.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Platform tools + Sterling MCP short names (decision dc6c1abf6...: derive
// from the repo's own tool surface, hardcoded here as the current set).
// ENGLISH-HOMOGRAPH EXCLUSION (review D3, 2026-08-21): Read, Write, Edit,
// Task and Agent are deliberately NOT scanned — they are ordinary brief prose
// ("read the decision", "Write your findings as your final message", "your
// task is"), and no roster agent grants Task/Agent at all, so scanning them
// fires the warning on prohibitions and common verbs — the cry-wolf class
// that trains the dispatcher to ignore the advisory (P1). Every MEASURED
// misdispatch involved the unambiguous class below (Bash, MCP short names).
const PLATFORM_TOOLS = [
  'Bash', 'PowerShell', 'MultiEdit', 'Grep', 'Glob',
  'WebSearch', 'WebFetch', 'ToolSearch',
];
const MCP_SHORT_NAMES = [
  'knowledge_query', 'knowledge_get', 'knowledge_create', 'knowledge_update',
  'knowledge_append', 'knowledge_edit', 'knowledge_link', 'knowledge_retire',
  'knowledge_supersede', 'knowledge_promote', 'knowledge_schema',
  'knowledge_stats', 'knowledge_preflight', 'board_add', 'board_edit',
  'board_get', 'board_query', 'board_remove', 'board_update',
  'maintenance_query', 'maintenance_remove', 'handoff_read', 'handoff_write',
  'agent_exit', 'run_state', 'run_signal', 'run_escalate', 'capture_pending',
  'concept_designed', 'no_capture',
];
const KNOWN_TOOLS = [...PLATFORM_TOOLS, ...MCP_SHORT_NAMES];
const MCP_SET = new Set(MCP_SHORT_NAMES);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-token, case-insensitive (platform names are matched case-insensitive
// per the frozen suite's lowercase-'bash' case; MCP short names are already
// lowercase snake_case, so case-insensitivity is harmless there too).
// PREFIX-AWARE SCAN (review D2): '_' is a word character, so \b<tok>\b alone
// can never see the token inside mcp__plugin_sterling_sterling__<tok> — yet a
// brief naming only the prefixed form is naming the same capability. The
// optional mcp__...__ branch closes that without loosening the whole-token
// boundary for bare mentions.
function wholeTokenRe(tok) {
  return new RegExp(`(?:^|[^\\w])(?:mcp__\\w+__)?${escapeRe(tok)}\\b`, 'i');
}

function findMentionedTools(text) {
  const t = String(text ?? '');
  if (!t) return [];
  return KNOWN_TOOLS.filter((tok) => wholeTokenRe(tok).test(t));
}

// A short MCP name is granted by the bare name OR any mcp-prefixed form
// ending in `__<name>`. A platform tool is granted by an exact (case-
// insensitive) match in the frontmatter grant list.
function isGranted(tool, grantList) {
  if (MCP_SET.has(tool)) {
    return grantList.includes(tool) || grantList.some((g) => g.endsWith(`__${tool}`));
  }
  const lower = tool.toLowerCase();
  return grantList.some((g) => g.toLowerCase() === lower);
}

// Raw value of the frontmatter `tools:` line, or undefined when the line (or
// the frontmatter block itself) is absent — both mean all-tools default.
function parseToolsLine(content) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return undefined;
  const line = fm[1].match(/^tools:[ \t]*(.*)$/m);
  if (!line) return undefined;
  return line[1].trim();
}

let input;
try {
  input = readStdin();
} catch {
  allow(); // malformed (non-JSON) stdin — nothing to check, never a crash
}

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext },
    })
  );
}

try {
  const subagentType = input.tool_input?.subagent_type;
  if (!subagentType) allow(); // nothing to resolve capability against

  const agentPath = join(input.cwd ?? '.', '.claude', 'agents', `${subagentType}.md`);
  if (!existsSync(agentPath)) {
    // DISTINCT shape from the missing-tool warning: capability cannot be
    // checked at all, and this must not read like a claim about a specific
    // grant it has no way to know.
    emit(
      `H25: dispatch capability for subagent_type '${subagentType}' cannot be checked — no installed agent ` +
        `definition was found at .claude/agents/${subagentType}.md on this machine. Confirm the type is correct ` +
        `before relying on this dispatch, or install the agent definition.`
    );
    allow();
  }

  let content;
  try {
    content = readFileSync(agentPath, 'utf8');
  } catch (e) {
    warnNonBlocking(`H25: dispatch-capability advisory failed reading '${agentPath}': ${(e && e.message) || e}`);
  }

  const toolsRaw = parseToolsLine(content);
  if (toolsRaw === undefined) allow(); // no tools: line — all-tools default, silent

  // Grant parsing (review D1): strip a flow-style [ ... ] wrapper so
  // `tools: [Read, Bash]` grants Read and Bash rather than '[read'/'bash]'.
  // A tools: value that parses to ZERO tokens (e.g. a YAML block list on the
  // following lines, which this line-scoped parser cannot read) is
  // UNEVALUABLE, not an empty grant — an advisory must never assert a grant
  // it did not actually read, so it stays silent.
  const grantList = toolsRaw
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!grantList.length) allow();

  const mentioned = findMentionedTools(input.tool_input?.prompt);
  if (!mentioned.length) allow();

  const missing = mentioned.filter((tool) => !isGranted(tool, grantList));
  if (!missing.length) allow();

  const missingLines = missing.map((tool) => `  - '${tool}' — not held by this agent's grant`).join('\n');
  emit(
    `H25 DISPATCH CAPABILITY ADVISORY — you are about to dispatch '${subagentType}', and the brief mentions ` +
      `tool(s) its installed grant does not hold:\n${missingLines}\n` +
      `Agent '${subagentType}' actual grant (frontmatter tools:): ${toolsRaw}\n` +
      `This is advisory only, never a block — a mention is not proof of a requirement (a prohibition or passing ` +
      `context can read identically). Remedy: re-target the dispatch to an agent holding ${missing.join(', ')}, ` +
      `re-scope the brief so it is not needed, or state explicitly why the mention is not a requirement.`
  );
  allow();
} catch (e) {
  // Advisory only, never a gate: loud but non-blocking (P5 without AC7 harm).
  warnNonBlocking(`H25: dispatch-capability advisory failed: ${(e && e.message) || e}`);
}
// no close: every path above exits the process, releasing the handle (board f81b1987)
