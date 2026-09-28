// HAZARD LANE MODE — does this hook invocation run inside a READ-ONLY subagent
// lane, whose anti-pattern hazards render as one-line pointers instead of
// whole TRIGGER/RIGHT WAY blocks? User ruling 2026-09-28 ("Revisit for
// read-only lanes"), amending decision delivery-total-cap-and-axis-generic-floor
// and the "each whole" clause of knowledge-delivery-target-design-no-delayed-
// delivery: a lane that cannot edit cannot commit the mistake a hazard warns
// against, so it gets the pointer; a write-capable lane and the main session
// keep hazards whole. Design map: finding hazard-delivery-call-sites-lane-
// identity-and-substance-only-freshness-trap-september-2026.
//
// FAIL WHOLE. 'pointer' requires every link of the chain to hold; any missing
// field, unresolvable type, unreadable file or thrown error answers 'whole' —
// the pre-ruling behavior — so an uncertain case can only ever over-deliver.
// Read-only-ness follows the INSTALLED `tools:` line, never the template name,
// and is an ALLOWLIST: any tool not known read-only — a per-project
// extra_tools grant of Edit included — flips the lane back to whole.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRegister } from '../../lib/dispatch-register.mjs';

// THE READ-ONLY ALLOWLIST (fix round, pre-commit review 2026-09-28). A
// write-tool DENYLIST failed OPEN on every line the parser misread — a
// trailing comment, a continuation line, a wildcard, a scoped `Edit(...)`, a
// foreign MCP writer — so only tools KNOWN to be read-only earn a pointer.
// Bash is read-only BY DESIGN here (the researcher holds it). Any Sterling MCP
// tool outside the read suffixes (the librarian's store writes) is whole.
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch', 'ToolSearch']);
const STERLING_READ_SUFFIXES = ['knowledge_query', 'knowledge_get', 'knowledge_schema', 'knowledge_preflight', 'board_query', 'board_get', 'maintenance_query'];
for (const prefix of ['mcp__sterling__', 'mcp__plugin_sterling_sterling__']) {
  for (const suffix of STERLING_READ_SUFFIXES) READ_ONLY_TOOLS.add(`${prefix}${suffix}`);
}
const TOOL_TOKEN = /^(?:[A-Z][A-Za-z]*|mcp__[A-Za-z0-9_]+)$/;
const PLAIN_AGENT_NAME = /^[A-Za-z0-9_-]+$/;

/** The lane's agent type: stdin's `agent_type`, else the H22 register's entry
 *  for this agent_id (the ONE register reader). Several entries naming
 *  different types is ambiguous and resolves to nothing. */
function laneAgentType(input, root) {
  if (typeof input.agent_type === 'string' && input.agent_type) return input.agent_type;
  const { availability, entries } = readRegister(root);
  if (availability !== 'ok') return null;
  const types = new Set(
    entries.filter((e) => e.agent_id === input.agent_id && typeof e.agent_type === 'string' && e.agent_type).map((e) => e.agent_type)
  );
  return types.size === 1 ? [...types][0] : null;
}

/** The `tools:` tokens from the agent file's frontmatter, or null unless the
 *  line is UNAMBIGUOUS: exactly one `tools:` key, its value whole on that one
 *  line (the next line is not indented), no `#`, `*`, `(`, `[` or quote, and
 *  every comma-separated token a plain tool name. Every other shape — a flow
 *  list, a quoted value, a block list, a comment — is null, and null is whole. */
function frontmatterTools(text) {
  // Every YAML line break (a lone CR included) splits, so no key can hide on
  // a line the scan never sees.
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  const at = [];
  for (let i = 1; i < end; i++) if (/^tools\s*:/.test(lines[i])) at.push(i);
  if (at.length !== 1) return null;
  const i = at[0];
  // A SECOND `tools` key in any other spelling — quoted (`"tools":`), or a
  // YAML complex key (`? tools`) — is ambiguity, so it is whole. Belt and
  // braces: any line opening with `?`, `"` or `'` is whole too.
  for (let j = 1; j < end; j++) {
    if (j === i) continue;
    if (/^\s*(?:\?|["']?tools["']?\s*:)/.test(lines[j]) || /^[?"']/.test(lines[j])) return null;
  }
  if (i + 1 < end && /^\s/.test(lines[i + 1])) return null;
  const value = lines[i].replace(/^tools\s*:/, '').trim();
  if (!value || /[#*(\['"]/.test(value)) return null;
  const tokens = value.split(',').map((t) => t.trim());
  return tokens.every((t) => TOOL_TOKEN.test(t)) ? tokens : null;
}

/** 'pointer' for a subagent lane whose installed agent file carries exactly
 *  one unambiguous `tools:` line whose every tool is on the read-only
 *  ALLOWLIST (READ_ONLY_TOOLS); 'whole' for everything else. Never throws. */
export function hazardLaneMode(input, root) {
  try {
    if (!input || typeof input.agent_id !== 'string' || !input.agent_id) return 'whole';
    const type = laneAgentType(input, root);
    if (!type || !PLAIN_AGENT_NAME.test(type)) return 'whole';
    const tools = frontmatterTools(readFileSync(join(root, '.claude', 'agents', `${type}.md`), 'utf8'));
    if (!tools) return 'whole';
    return tools.every((t) => READ_ONLY_TOOLS.has(t)) ? 'pointer' : 'whole';
  } catch {
    // Fail whole by design (see header): a missing agent file (ENOENT) or any
    // other read/parse failure only restores the pre-ruling whole rendering.
    return 'whole';
  }
}
