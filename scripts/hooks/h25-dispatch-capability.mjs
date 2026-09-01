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
import { readStdin, allow, warnNonBlocking, loadConfig, repoRel } from './lib/common.mjs';
import { recordAdvisoryFire } from './lib/advisory-counter.mjs';
import {
  hasUnsuppressedMatch,
  isReviewerClass,
  escapeRe as escapeReShared,
  scanClauses,
  isSuppressedContext,
} from './lib/dispatch-advisory.mjs';
import { PATH_CANDIDATE_RE } from './lib/dispatch-prompt.mjs';
import { readLedger, ledgerPath, fileHash } from './lib/ledger.mjs';
import { PIPELINE_AGENT_TYPES, matchesGlob } from '@sterling/schemas';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  'concept_designed', 'no_capture', 'knowledge_render',
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
// COMMAND-SHAPE ADVISORY (board 07deffab gap (3)): the KNOWN_TOOLS scan above
// matches TOOL-NAME VOCABULARY only, so a brief that tells a shell-less agent
// to run `gdlint`/`gdformat` fires nothing — H25 catches the word "Bash", not
// the intent "go run a command". This is a SEPARATE, bounded grammar over the
// raw prompt text, independent of KNOWN_TOOLS, and it fires only when the
// target agent's grant holds NEITHER shell-execution tool — Bash nor
// PowerShell, the only two in this ecosystem (h15-store-guard.mjs,
// h23-output-axis.mjs and h24-gate-exit-lint.mjs all gate on exactly this
// pair; there is no third).
//
// FOUR STRONG SHAPES ONLY (P1 — bounded under-warning beats a flood of
// "run the tests"/"run through this list" false positives on ordinary
// prose):
//   1. `run <token>` / `execute <token>` — a command-shaped token right
//      after the verb, EXCLUDING a short list of common English function
//      words (the/a/an/it/this/via/without/...) that would otherwise turn
//      "run the tests manually" into a false positive.
//   2. `npm run ...` — unambiguous idiom, no stopword gate needed.
//   3. `node <path>` — 'node' followed by a path- or script-extension-shaped
//      token (optionally past `--flag` tokens), so the English noun "node"
//      ("a graph node") never matches on its own.
//   4. Fenced (```...```) or inline (`...`) text containing WHITESPACE or a
//      shell metacharacter — a command with arguments or an operator. A BARE
//      SINGLE-TOKEN backtick (`gdlint` alone) is explicitly NOT a trigger —
//      that shape is at least as often a name reference in prose as an
//      instruction to run it.
const SHELL_TOOLS = new Set(['bash', 'powershell']);

function hasShellCapability(grantList) {
  return grantList.some((g) => SHELL_TOOLS.has(String(g).toLowerCase()));
}

// ROSTER REVIEW M2 FIX (two Mediums): (a) the run/execute/npm/node shape
// checks now go through the SAME shared prohibition detector the sibling
// arms use (hasUnsuppressedMatch, {checkSubjectVerb:false} — a COMMAND/shape
// mention, not a subject-of-change verb window, matching the path-trigger
// arm's own posture) so "do NOT run `npm test`" suppresses exactly like
// "do NOT run Bash" does one section up — this was checking the RAW prompt
// before, bypassing hasUnsuppressedMatch entirely. (b) a backticked/fenced
// span whose FIRST TOKEN is a known MCP short name (the MCP_SET already in
// scope) is now EXCLUDED from the shape grammar outright — a store call like
// `knowledge_get <id>`/`board_remove <id>` is not a shell command, and
// SHELL_ARG_OR_OP_RE's bare "any whitespace" test could not tell the two
// apart, so briefs routinely backticking store calls to shell-less roster
// agents (reviewer-*/librarian/test-writer) fired constantly (cry-wolf).
// The run/execute/npm/node shapes route through hasUnsuppressedMatch
// directly (the MCP/stopword exclusion is a safe negative lookahead there —
// no delimiter-pairing to break). The backtick/fence shapes do NOT route
// through hasUnsuppressedMatch — see the note further down for the two
// concrete, measured reasons (delimiter pairing + multi-line clauses) — they
// use the SAME underlying isSuppressedContext primitive via a dedicated loop
// instead.
const STRONG_SHAPE_STOPWORDS = [
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'them',
  'some', 'any', 'all', 'your', 'my', 'our', 'their', 'through',
  'again', 'once', 'more', 'here', 'there', 'now', 'later', 'first',
  'next', 'before', 'after', 'via', 'using', 'with', 'without', 'over',
  'away', 'so',
];
// A 'run <token>'/'execute <token>' whose token IS a stopword or an MCP
// short name is never even captured — excluded via negative lookahead right
// where the token would start, so hasUnsuppressedMatch never sees it as a
// candidate mention in the first place.
const RUN_TOKEN_EXCLUDED_ALT = [...STRONG_SHAPE_STOPWORDS, ...MCP_SHORT_NAMES].map(escapeRe).join('|');
// The prefixed MCP form (`run mcp__sterling__board_remove`) is excluded too —
// a `mcp__<server>__` prefix before a short name is the same store call, and
// warning on it is the cry-wolf class this arm's exclusions exist to prevent
// (final roster review L1, board 07deffab).
const RUN_TOKEN_RE = new RegExp(
  `\\b(?:run|execute)\\s+\`?(?!(?:mcp__\\w+__)?(?:${RUN_TOKEN_EXCLUDED_ALT})\\b)([A-Za-z][\\w.-]*)\`?`,
  'gi'
);
const NPM_RUN_RE = /\bnpm\s+run\b/gi;
const NODE_PATH_RE = /\bnode\b\s+(?:--[\w-]+\s+)*(?:[\w.-]*\/[\w.-]+|[\w-]+\.(?:mjs|cjs|js|ts|py))\b/gi;

// NOTE ON BACKTICK/FENCE HANDLING — deliberately NOT routed through
// hasUnsuppressedMatch, for two DIFFERENT, both load-bearing reasons (fixed
// during M2 verification, not part of the original review ask, but required
// to make the ask correct):
//
//   (i) PAIRING. A negative lookahead planted at the OPENING delimiter
//   (`` ` ``/```` ``` ````) to exclude an MCP-first-token span breaks the
//   regex engine's normal greedy left-to-right PAIRING of delimiters: when
//   the match attempt at a REAL opening backtick fails (because its content
//   starts with an MCP name), the engine does not skip the whole span — it
//   retries at the NEXT character, including the real span's OWN CLOSING
//   backtick, which it then happily pairs with the NEXT real span's opening
//   backtick, treating the PROSE BETWEEN two genuine code spans as a bogus
//   third "command". Measured live during M2 verification: "call
//   `knowledge_get <id>` to retrieve the spec, then `board_remove <id>`"
//   matched " to retrieve the spec, then " as if it were backticked command
//   text. The fix is structural, not a tighter lookahead: find every REAL
//   pair first (plain, non-filtering regexes — the same greedy pairing that
//   already worked before any exclusion existed), then apply BOTH the
//   MCP-first-token exclusion and the shell-arg-or-op requirement as
//   POST-HOC content predicates on each already-correctly-paired span.
//
//   (ii) MULTI-LINE. hasUnsuppressedMatch clause-scans its pattern argument
//   PER CLAUSE (scanClauses splits on sentence/newline boundaries) — exactly
//   wrong for a fenced block, whose own internal newlines would fragment it
//   across clauses before the pattern ever gets to match the whole span.
//
// Both reasons point the same way: find matches against the FULL original
// text with plain delimiter-pairing regexes, filter by content, then check
// suppression SEPARATELY via the shared isSuppressedContext primitive (the
// SAME clause-scoped negation logic hasUnsuppressedMatch itself uses),
// keyed off each surviving match's absolute index via locateClause below.
const FENCE_RE = /```[\w-]*\n([\s\S]*?)```/g;
const INLINE_BACKTICK_RE = /`([^`\n]+)`/g;
const SHELL_ARG_OR_OP_RE = /[\s|&;<>$(){}]/;

function firstToken(s) {
  const m = String(s ?? '').trim().match(/^\w+/);
  if (!m) return '';
  // A `mcp__<server>__`-prefixed name is the same store call as its short
  // name — strip the prefix so MCP_SET recognizes both spellings (final
  // roster review L1, board 07deffab: `_` is a word character, so the
  // prefixed form otherwise reads as one unknown token and fires the
  // command-shape advisory on a plain store-call mention).
  return m[0].toLowerCase().replace(/^mcp__\w+?__/, '');
}

// A bare single-token backtick ('`gdlint`' alone) is deliberately NOT a
// trigger (requires SHELL_ARG_OR_OP_RE somewhere in the span). A span whose
// FIRST TOKEN is a known MCP short name is a store call, never a shell
// command, and is excluded outright regardless of what follows it.
function isCommandShapedSpan(content) {
  return SHELL_ARG_OR_OP_RE.test(content) && !MCP_SET.has(firstToken(content));
}

function locateClause(clauses, text, absIndex) {
  let cursor = 0;
  for (const c of clauses) {
    const idx = text.indexOf(c.text, cursor);
    if (idx === -1) continue; // defensive; scanClauses' slices are always literal substrings in order
    if (absIndex >= idx && absIndex < idx + c.text.length) {
      return { clauseText: c.text, localIndex: absIndex - idx };
    }
    cursor = idx + c.text.length;
  }
  return null; // match starts inside boundary punctuation itself — an unlikely edge case; treated as NOT suppressed below (fail toward the advisory, not toward silence, since this is the rare case a real prohibition genuinely could not be located)
}

function hasUnsuppressedFenceOrBacktick(text) {
  const clauses = scanClauses(text);

  FENCE_RE.lastIndex = 0;
  let fm;
  while ((fm = FENCE_RE.exec(text))) {
    if (!isCommandShapedSpan(fm[1])) continue;
    const loc = locateClause(clauses, text, fm.index);
    if (!loc || !isSuppressedContext(loc.clauseText, loc.localIndex, false)) return true;
  }

  // Fenced spans are stripped before the inline scan so a fence's own
  // triple-backtick delimiters are never mistaken for an inline `...` span.
  const stripped = text.replace(FENCE_RE, ' ');
  const strippedClauses = scanClauses(stripped);
  INLINE_BACKTICK_RE.lastIndex = 0;
  let im;
  while ((im = INLINE_BACKTICK_RE.exec(stripped))) {
    if (!isCommandShapedSpan(im[1])) continue;
    const loc = locateClause(strippedClauses, stripped, im.index);
    if (!loc || !isSuppressedContext(loc.clauseText, loc.localIndex, false)) return true;
  }
  return false;
}

function hasCommandShapeMention(text) {
  const t = String(text ?? '');
  if (!t) return false;
  if (hasUnsuppressedMatch(t, RUN_TOKEN_RE, { checkSubjectVerb: false })) return true;
  if (hasUnsuppressedMatch(t, NPM_RUN_RE, { checkSubjectVerb: false })) return true;
  if (hasUnsuppressedMatch(t, NODE_PATH_RE, { checkSubjectVerb: false })) return true;
  return hasUnsuppressedFenceOrBacktick(t);
}

// Computed only once the target agent's real, evaluable grant is known to
// hold NEITHER shell tool (callers only invoke this after that check) — an
// unknown agent, an all-tools-default (no `tools:` line) or an unevaluable
// grant can never assert this, matching the missing-tool advisory's own
// posture of never claiming a grant it did not actually read.
function commandShapeAdvisory(prompt) {
  if (!hasCommandShapeMention(prompt)) return null;
  return (
    `H25 COMMAND-SHAPE ADVISORY — the brief instructs running commands but the agent holds no shell execution tool ` +
      `(no Bash, no PowerShell in its installed grant). This is a SHAPE match — run/execute <token>, npm run, ` +
      `node <path>, or fenced/backticked command text — independent of the tool-NAME scan above, so it catches a ` +
      `brief that names a concrete command (e.g. a linter/formatter) without ever naming a platform tool. Warn-only, ` +
      `never a block: re-target the dispatch to an agent holding shell access, re-scope the brief, or confirm the ` +
      `command is not actually required.`
  );
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

// Negation guard (board 07deffab gap (2)): a prohibition aimed at the tests
// must never fire the verb trigger, even when it names a trigger verb ('do
// not write tests') or the enforcing hook itself ('never edit the tests — H5
// will deny you' is already the warning, said by the dispatcher — this hook
// must stay silent). FORMERLY a private clause-splitter/negation pair
// (CLAUSE_SPLIT_RE + NEGATION_RE, a whole-string, non-shared heuristic) —
// REPLACED with the SAME shared, clause-scoped detector the path-trigger arm
// below already uses (hasUnsuppressedMatch, checkSubjectVerb:false — this is
// a TEST-authoring mention, not a tool/capability one, so the
// subject-of-change verb window must stay off exactly as it does for
// hasPathTrigger; see hasUnsuppressedMatch's own doc comment). One shared
// detector, not two independently-drifting heuristics — the same rationale
// board a6b76e8c gave for the tool-capability/H26 unification applies here
// unchanged. PROHIBITION_RE's reach already covers every shape the old
// NEGATION_RE covered (do not/don't/don't/never) plus forbid*/denies/denied/⛔
// and the apostrophe-optional/curly-apostrophe forms NEGATION_RE special-
// cased by hand.
//
// LEAVE_ALONE_RE ('leave the tests alone') was checked and DROPPED, not kept:
// every pinned 'leave...alone' case (H25-TAL NEGATION (18)) pairs the phrase
// with a non-trigger verb ('update the implementation'), so VERB_TRIGGER_RE
// never matches that clause in the first place — the guard was defending a
// combination ('leave...alone' co-occurring with a genuine write/author/add/
// create + tests match in the SAME clause) that no pinned test exercises and
// that grepping the suites for 'alone' turns up nowhere else. Confirmed by
// running the full h25-test-authoring-lint(-hardening) suites after removal
// (still green).
function hasVerbOrTddTrigger(text) {
  const t = String(text ?? '');
  return (
    hasUnsuppressedMatch(t, VERB_TRIGGER_RE, { checkSubjectVerb: false }) ||
    hasUnsuppressedMatch(t, TDD_TRIGGER_RE, { checkSubjectVerb: false })
  );
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

// ---------------------------------------------------------------------------
// THIRD ADVISORY: citation-staleness (board c1945057, warn-only, rides this
// same PreToolUse Task|Agent entry — no new hook). A brief that cites
// `path:line` may have been drafted against bytes that have since moved: the
// measured incident (board c1945057) had every line number in one brief
// drift within twenty minutes because the lane reporting them kept editing.
// This never re-derives whether the CITED LINE is still correct (that needs
// content diffing this hook does not attempt) — it only tells the dispatcher
// the file's bytes changed since the CONDUCTOR's own last Read of it, the
// cheap, honest signal: "go remeasure", never "the line is wrong".
//
// SILENT BY DEFAULT, not measured against absence: the ledger only ever
// carries a HASHED entry for a path the conductor actually Read (board
// 776d2b65's freshness design) — no entry, or only a legacy HASHLESS entry,
// means UNVERIFIED, not stale, and this stays silent. Firing on absence would
// be false staleness on every citation the conductor never happened to Read
// via the hashed path, killing the advisory's signal — the same cry-wolf
// risk the two advisories above are built to avoid. NEVER mtime — content
// hash only (board c1945057 names mtime as a candidate; this deliberately
// does not use it, since a touch with no content change is not staleness).
//
// LATEST entry, never hasFreshRead(): hasFreshRead() (lib/ledger.mjs) some()s
// across EVERY entry for a path, so a stale early Read could vouch for a
// citation alongside a later, mismatched one. A citation is measured against
// the conductor's most RECENT knowledge of the file, not any historical
// snapshot of it.
const CITATION_RE = new RegExp(`(${PATH_CANDIDATE_RE.source}):(\\d+)(?:-\\d+)?`, 'g');

function extractCitedPaths(text) {
  const found = String(text ?? '').match(CITATION_RE) ?? [];
  return [...new Set(found.map((m) => m.replace(/:\d+(?:-\d+)?$/, '')))];
}

function latestHashedEntry(entries, relPath) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.path === relPath && e.sha256) return e;
  }
  return null;
}

// Wrapped in its own top-level try/catch (never just the ledger read): an
// unexpected failure here must never take down the two advisories above it —
// same posture as hasPathTrigger's guarded loadConfig call.
function citationStalenessAdvisory(prompt, cwd) {
  try {
    const text = String(prompt ?? '');
    if (!text || !cwd) return null;
    const cited = extractCitedPaths(text);
    if (!cited.length) return null;
    let entries;
    try {
      entries = readLedger(ledgerPath(cwd));
    } catch {
      return null; // a torn/unreadable ledger must not crash this advisory
    }
    if (!entries.length) return null;
    const stale = [];
    for (const citedPath of cited) {
      const rel = repoRel(citedPath, cwd); // confines to the repo; null when outside it
      if (!rel) continue;
      const abs = join(cwd, rel);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue; // does not exist on disk — nothing to compare
      }
      if (!stat.isFile()) continue;
      const entry = latestHashedEntry(entries, rel);
      if (!entry) continue; // no hashed evidence — unverified, not stale
      const currentHash = fileHash(abs);
      if (currentHash && currentHash !== entry.sha256) stale.push(rel);
    }
    if (!stale.length) return null;
    const lines = stale.map((p) => `  - ${p}`).join('\n');
    return (
      `H25 CITATION-STALENESS ADVISORY — file changed since your last Read; remeasure these line citations:\n${lines}\n` +
        `This does not claim the cited lines are wrong — only that the file's bytes moved since your last Read of it.`
    );
  } catch {
    return null; // advisory-only: never take down the other H25 advisories
  }
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

  // Computed once, independent of the capability checks below (neither needs
  // an installed agent file nor a parsed grant) — combined with whichever
  // capability-advisory text (if any) `finish` is called with, so no two of
  // the (up to) four advisories ever clobber each other when several apply.
  const taAdvisory = testAuthoringAdvisory(subagentType, input.tool_input?.prompt, input.cwd);
  const citeAdvisory = citationStalenessAdvisory(input.tool_input?.prompt, input.cwd);
  // Assigned later, once the target agent's real grant is known to hold
  // NEITHER shell tool — stays undefined on every branch that cannot know
  // that (unknown agent, all-tools default, unevaluable grant), read by
  // `finish` at call time via closure so every finish() call after that
  // point picks it up automatically, exactly like taAdvisory/citeAdvisory.
  let commandShapeMsg;
  function finish(capabilityMessage) {
    const parts = [];
    if (capabilityMessage) parts.push(capabilityMessage);
    if (commandShapeMsg) parts.push(commandShapeMsg);
    if (taAdvisory) parts.push(taAdvisory);
    if (citeAdvisory) parts.push(citeAdvisory);
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

  // COMMAND-SHAPE ADVISORY (board 07deffab gap (3)): only evaluable now that
  // a real, non-empty grant is known — fires only when it holds NEITHER
  // shell-execution tool.
  if (!hasShellCapability(grantList)) commandShapeMsg = commandShapeAdvisory(input.tool_input?.prompt);

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
