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
//
// SECOND ADVISORY (board 2f57ec84): test-authoring dispatch-time lint (spec
// scripts/tests/h25-test-authoring-lint.test.mjs). Same entry, same
// warn-only posture, independent trigger: a PIPELINE_AGENT_TYPES agent that
// is NOT test-writer, briefed to author tests either by a VERB TRIGGER
// (write/author/add/create tests, or TDD-first phrasing — negation-guarded so
// a prohibition never fires) or a PATH TRIGGER (a concrete path in the brief
// matching a declared toolchain test_glob). Doer/checker separation: test
// authoring belongs to the test-writer role, and H5 will deny a test-path
// edit mid-work if the dispatch proceeds anyway — this catches the
// misdispatch before the spawn, exactly like the capability advisory above.
import { readStdin, allow, warnNonBlocking, loadConfig } from './lib/common.mjs';
import { recordAdvisoryFire } from './lib/advisory-counter.mjs';
import { hasUnsuppressedMatch, isReviewerClass, escapeRe as escapeReShared } from './lib/dispatch-advisory.mjs';
import { PIPELINE_AGENT_TYPES, matchesGlob } from '@sterling/schemas';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Harness BUILT-IN subagent types (board a6b76e8c item 2, 2026-08-24 feedback batch: 11
// of 12 firings in one session): the platform ships these with NO
// per-project .claude/agents/<type>.md definition file at all — that absence
// is by design, not a capability gap, so they must never trigger the
// "capability cannot be checked" advisory below.
const BUILTIN_AGENT_TYPES = new Set([
  'general-purpose',
  'claude',
  'Explore',
  'Plan',
  'fork',
  'claude-code-guide',
  'statusline-setup',
]);

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
  'knowledge_append', 'knowledge_edit', 'knowledge_split',
  'knowledge_extract', 'knowledge_array_remove', 'knowledge_link', 'knowledge_retire',
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

// SHARED NEGATION/PROHIBITION CHECK (board a6b76e8c item 1): a tool mention
// inside a prohibition ("do NOT run Bash"), a subject-of-change verb ("You
// hold no Bash by design", "implement board_remove in TypeScript"), or a
// quoted denial ("H14 denies...") must not count as a requirement — see
// scripts/hooks/lib/dispatch-advisory.mjs for the exact clause-scoped shape.
function findMentionedTools(text) {
  const t = String(text ?? '');
  if (!t) return [];
  return KNOWN_TOOLS.filter((tok) => hasUnsuppressedMatch(t, wholeTokenRe(tok)));
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

// ---------------------------------------------------------------------------
// SECOND ADVISORY: test-authoring dispatch-time lint (board 2f57ec84).
// ---------------------------------------------------------------------------

// Authoring verbs that, together with a NOUN-FORM test mention in the same
// clause, instruct test authoring. The noun form is deliberately narrower
// than bare \btests?\b (review fix C2): the plural 'tests', 'test
// case(s)/file(s)/suite(s)', or an articled singular ('a (failing) test').
// A bare singular 'test' used as a VERB ("then test the endpoint manually")
// satisfies none of these, so it never combines with a preceding trigger
// verb to fire — the false-positive class this guards against. 'testing' — a
// homograph of 'test' — still never matches, since it fails every branch.
const TEST_NOUN_RE_SRC = String.raw`(?:\btests\b|\btest\s+(?:cases?|files?|suites?)\b|\ba\s+(?:failing\s+)?test\b)`;
const VERB_TRIGGER_RE = new RegExp(String.raw`\b(?:write|author|add|create)\b[^.!?\n]{0,40}` + TEST_NOUN_RE_SRC, 'i');
// TDD trigger requires test-FIRST phrasing (review fix C3), not a bare
// mention: 'TDD-first'/'TDD first' (the {0,20} gap already covers the single
// hyphen-or-space between the two words), or TDD within a short bounded
// distance of an authoring-context word (start/begin/first) or the phrase
// 'with the test(s)'. Deliberately NOT a bare \btest\b proximity check: that
// would let 'TDD: the test-writer already froze the suite' false-fire on the
// 'test' fragment inside the compound 'test-writer' — requiring the fuller
// 'with the test(s)' phrase (or start/begin/first) means that fragment alone
// can never satisfy it.
const TDD_TRIGGER_RE = /\bTDD\b[^.!?\n]{0,20}\b(?:start(?:ing)?|begin(?:ning)?|first|with\s+the\s+tests?)\b/i;

// Negation guard: a prohibition aimed at the tests must never fire the verb
// trigger, even when it names a trigger verb ('do not write tests') or the
// enforcing hook itself ('never edit the tests — H5 will deny you' is
// already the warning, said by the dispatcher — this hook must stay silent).
const NEGATION_RE = /\b(?:do\s*not|don't|don’t|never)\b[^.!?\n]{0,40}\btests?\b/i;
const LEAVE_ALONE_RE = /\bleave\b[^.!?\n]{0,40}\btests?\b[^.!?\n]{0,20}\balone\b/i;

// Clause-scoped negation (review fix C1): a whole-brief negation match used
// to silence every trigger in the ENTIRE prompt, even a later, unrelated
// instruction in the same brief ("Don't touch the existing tests; write new
// tests for the new module" wrongly stayed silent). Splitting on sentence/
// segment boundaries — '.', '!', '?', ';', newline, and em/en dash — and
// evaluating the negation guard PER CLAUSE means only the clause actually
// containing the prohibition is silenced; any other clause with its own verb
// or TDD trigger still warns. A comma is deliberately NOT a boundary here —
// "don't touch the tests, just fix the bug" is one prohibition spanning a
// comma, not two independent clauses.
const CLAUSE_SPLIT_RE = /[.!?;\n–—]/;

function hasVerbOrTddTrigger(text) {
  const clauses = String(text ?? '').split(CLAUSE_SPLIT_RE);
  for (const clause of clauses) {
    if (NEGATION_RE.test(clause) || LEAVE_ALONE_RE.test(clause)) continue; // this clause is a prohibition — silent
    if (VERB_TRIGGER_RE.test(clause) || TDD_TRIGGER_RE.test(clause)) return true;
  }
  return false;
}

// Concrete path tokens in the brief: word/dot/dash/slash runs ending in an
// extension, trimmed of trailing sentence punctuation prose tends to leave
// attached ('tests/export.test.mjs;', 'tests/export.test.mjs.').
function extractPathCandidates(text) {
  const matches = String(text ?? '').match(/[A-Za-z0-9_][A-Za-z0-9_.\-/]*\.[A-Za-z0-9]+/g) ?? [];
  return matches.map((m) => m.replace(/[.,;:]+$/, ''));
}

// A concrete path matching any declared toolchain test_glob — the same
// classification loop H5/H18 use (config.toolchains[].test_globs, matchesGlob).
// The loadConfig call is guarded (review fix C4): a present-but-malformed
// .sterling/config.json throws, and this function's caller sits inside the
// SAME outer try as the pre-existing capability advisory below it — an
// unguarded throw here would be caught by the outer catch and lose that
// unrelated, already-working advisory too. A corrupt config degrades only
// the path trigger (falls back to 'no path trigger'), never the rest of the
// hook.
function hasPathTrigger(text, cwd) {
  let config;
  try {
    config = loadConfig(cwd);
  } catch {
    return false;
  }
  const globs = (config?.toolchains ?? []).flatMap((tc) => tc.test_globs ?? []);
  if (!globs.length) return false;
  const candidates = extractPathCandidates(text).filter((path) => globs.some((glob) => matchesGlob(path, glob)));
  // SHARED NEGATION CHECK (board a6b76e8c item 1): a test path named only to
  // FORBID touching it ("DO NOT EDIT tests/export.test.mjs — it is frozen")
  // must not count as a path trigger. checkSubjectVerb:false — this is a
  // FILE candidate, not a tool/capability mention (same split as H26).
  return candidates.some((path) => hasUnsuppressedMatch(text, new RegExp(escapeReShared(path)), { checkSubjectVerb: false }));
}

// Null when this lint does not apply or does not trigger: non-pipeline types,
// test-writer itself (exempt — it IS the doer), and briefs with neither
// trigger all fall through silently, matching the capability advisory's own
// posture (never a claim it cannot support).
function testAuthoringAdvisory(subagentType, prompt, cwd) {
  if (
    !subagentType ||
    !PIPELINE_AGENT_TYPES.has(subagentType) ||
    subagentType === 'test-writer' ||
    // board a6b76e8c item 4: a reviewer-class dispatch REVIEWS tests, it
    // does not author them — never fires the test-authoring advisory.
    isReviewerClass(subagentType)
  )
    return null;
  const text = String(prompt ?? '');
  if (!text) return null;
  if (!hasVerbOrTddTrigger(text) && !hasPathTrigger(text, cwd)) return null;
  return (
    `H25 TEST-AUTHORING ADVISORY — this is the warn-only doer/checker role lint: you are about to dispatch ` +
      `'${subagentType}', and the brief appears to instruct test authoring, inferred from verbs/paths in the prompt text — ` +
      `not a claim that a test edit has occurred. Test authoring belongs to the test-writer role (doer/checker separation); if this dispatch ` +
      `proceeds and it edits a test path, H5 will deny that edit mid-work. This is a warning, not a denial — ` +
      `re-target the dispatch to test-writer, or state explicitly why this agent needs to touch tests.`
  );
}

let input;
try {
  input = readStdin();
} catch {
  allow(); // malformed (non-JSON) stdin — nothing to check, never a crash
}

function emit(additionalContext) {
  recordAdvisoryFire(input.cwd, 'h25', input.session_id); // expiring campaign scaffolding — see lib/advisory-counter.mjs
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext },
    })
  );
}

try {
  const subagentType = input.tool_input?.subagent_type;
  if (!subagentType) allow(); // nothing to resolve capability against

  // Computed once, independent of the capability checks below (it needs
  // neither an installed agent file nor a parsed grant) — combined with
  // whichever capability-advisory text (if any) `finish` is called with, so
  // the two advisories never clobber each other when both apply.
  const taAdvisory = testAuthoringAdvisory(subagentType, input.tool_input?.prompt, input.cwd);
  function finish(capabilityMessage) {
    const parts = [];
    if (capabilityMessage) parts.push(capabilityMessage);
    if (taAdvisory) parts.push(taAdvisory);
    if (parts.length) emit(parts.join('\n\n'));
    allow();
  }

  const agentPath = join(input.cwd ?? '.', '.claude', 'agents', `${subagentType}.md`);
  if (!existsSync(agentPath)) {
    // Harness built-in (board a6b76e8c item 2): no definition file by
    // design, not a capability gap — never fires the no-definition advisory.
    if (BUILTIN_AGENT_TYPES.has(subagentType)) finish();
    // DISTINCT shape from the missing-tool warning: capability cannot be
    // checked at all, and this must not read like a claim about a specific
    // grant it has no way to know.
    finish(
      `H25: dispatch capability for subagent_type '${subagentType}' cannot be checked — no installed agent ` +
        `definition was found at .claude/agents/${subagentType}.md on this machine. Confirm the type is correct ` +
        `before relying on this dispatch, or install the agent definition.`
    );
  }

  let content;
  try {
    content = readFileSync(agentPath, 'utf8');
  } catch (e) {
    warnNonBlocking(`H25: dispatch-capability advisory failed reading '${agentPath}': ${(e && e.message) || e}`);
  }

  const toolsRaw = parseToolsLine(content);
  if (toolsRaw === undefined) finish(); // no tools: line — all-tools default, capability-silent

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
  if (!grantList.length) finish();

  const mentioned = findMentionedTools(input.tool_input?.prompt);
  if (!mentioned.length) finish();

  const missing = mentioned.filter((tool) => !isGranted(tool, grantList));
  if (!missing.length) finish();

  const missingLines = missing.map((tool) => `  - '${tool}' — not held by this agent's grant`).join('\n');
  finish(
    `H25 DISPATCH CAPABILITY ADVISORY — you are about to dispatch '${subagentType}', and the brief mentions ` +
      `tool(s) its installed grant does not hold:\n${missingLines}\n` +
      `Agent '${subagentType}' actual grant (frontmatter tools:): ${toolsRaw}\n` +
      `This is the warn-only dispatch-capability preflight (decision dc6c1afb) — never a block, and it intentionally reports ` +
      `ungranted mentions even though a mention is not proof of a requirement (a prohibition or passing ` +
      `context can read identically). Remedy: re-target the dispatch to an agent holding ${missing.join(', ')}, ` +
      `re-scope the brief so it is not needed, or state explicitly why the mention is not a requirement.`
  );
} catch (e) {
  // Advisory only, never a gate: loud but non-blocking (P5 without AC7 harm).
  warnNonBlocking(`H25: dispatch-capability advisory failed: ${(e && e.message) || e}`);
}
// no close: every path above exits the process, releasing the handle (board f81b1987)
