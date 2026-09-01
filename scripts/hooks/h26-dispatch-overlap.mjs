// H26 — dispatch-time overlap advisory (board b6a355f4-e5a6-4819-8e3f-a3ed8a175fc3).
// PreToolUse Task|Agent, joins the existing entry (after h8-dispatch-cap,
// h20-mechanism-axis, h25-dispatch-capability). NEVER a denial — no code path
// exits 2; internal failures (e.g. unparseable stdin) exit 1 via
// warnNonBlocking, every graceful degradation (missing/corrupt register, no
// candidates, no overlap, non-Sterling cwd) is a silent allow (exit 0).
// Governing decision: knowledge_get 6de73875-75b5-4182-8c1c-ca4841c993fa
// (slug lane-concept-first-slice-scope) is the authority on semantics — the
// first lane slice scoped the mechanism half to exactly this: reuse H22's
// in-flight dispatch register rather than build the heavier claimable-slots /
// knowledge_claim lease machinery ahead of measured collisions (P3).
//
// WHAT IT DOES: extracts path-like candidates from the OUTGOING dispatch's
// own tool_input.prompt (the same extractor H22 uses, lib/dispatch-prompt.mjs
// — PreToolUse sees only this call's tool_input, there is no transcript
// recovery to do here), normalizes them repo-relative POSIX and drops the
// same governed-exclusion prefixes H22 drops (.git/, .sterling/, sterling/,
// git/) so an excluded path never enters the candidate set on either side of
// the comparison. It then reads H22's register (.sterling/transient/
// dispatch-register.json) via the shared TTL reader (scripts/lib/
// dispatch-register.mjs liveDispatches — config dispatch_register.stale_minutes,
// default 60; corrupt/missing register degrades to []), additionally
// restricted to entries from THIS session (liveDispatches has no session
// context; only the hook does). When any live same-session entry's declared
// `files` exactly matches (repo-relative string equality) a candidate from
// the outgoing prompt, it emits a warn-only advisory naming the overlapping
// path(s), each overlapping dispatch as `agent_type:agent_id`, and the remedy
// (keep lanes file-disjoint: await the in-flight agent, or re-scope this
// dispatch's territory). A malformed register entry (missing `files` or
// missing agent_id) is skipped outright — it never fabricates an
// 'undefined:undefined' identity; a null agent_type (a shape H22 writes by
// design) is labeled with the 'agent' fallback, never dropped.
//
// KNOWN IMPRECISION (disclosed, not fixed here): the prompt extraction only
// APPROXIMATES write territory (free-form prose, not a declared file list).
// This hook compares only dispatches ALREADY PRESENT IN THE LIVE REGISTER
// when this PreToolUse fires — it never claims parallel dispatches fired in
// one message can't see each other; per-block attribution (decision
// 5d3747c1, slug h22-per-block-attribution) is what makes that comparison
// safe: an imprecise ('union'-attributed, or legacy entries with no
// `attribution` field at all) register entry is suppressed below rather than
// surfaced as a caveated warning that would cry wolf on every batch.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking, repoRel, loadConfig } from './lib/common.mjs';
import { recordAdvisoryFire } from './lib/advisory-counter.mjs';
import { extractPathCandidates, parseReviewTerritory } from './lib/dispatch-prompt.mjs';
import { liveDispatches } from '../lib/dispatch-register.mjs';
import { hasUnsuppressedMatch, escapeRe, isReadOnlyDispatchType } from './lib/dispatch-advisory.mjs';
import { claimedResources } from './lib/dispatch-residue.mjs';

// A PATH NAMED AS A THING TO RUN IS NOT A PATH THE LANE WILL WRITE (board
// 8f43e6b5, the EXTRACTION half only — the larger redesign toward a declared
// territory field on the dispatch is explicitly NOT built here). Measured at
// ~100% false-positive across two consumer sessions: every brief must spell
// its gate command out verbatim (H14 matches literal command prefixes), so
// every brief names the gate binary and the gate runner, and every concurrent
// pair "overlapped" on them — real firings named
// 'tools/godot/Godot_v4.6.3-stable_win64_console.exe' and
// 'addons/gdUnit4/bin/GdUnitCmdTool.gd'. The cost was not the noise but the
// MISS: a genuine overlap on a source file was nearly buried, and one consumer
// stopped reading H26 entirely.
//
// LOCAL TO H26, NOT THE SHARED MODULES. lib/dispatch-prompt.mjs must stay
// permissive (h19-dispatch-staging deliberately wants over-capture —
// research_finding 289cd172's standing constraint), and lib/dispatch-advisory
// is shared with H22's write side and H25's capability check, neither of which
// is in this fix's scope. This is a READ-side territory filter on the OUTGOING
// dispatch's own candidates only.
//
// (1) EXECUTABLES ARE EXCLUDED UNCONDITIONALLY — in a command line or in
// prose alike: no lane contends over an invoked/linked artifact as write
// territory, and the measured briefs name the binary in both shapes. The
// family is EXTENSION-matched, never a substring ('scripts/executor.mjs' is
// ordinary source). The family is COMPILED/LINKED ARTIFACTS ONLY — never
// hand-edited source on any platform.
// '.sh', '.bat' and '.cmd' are deliberately NOT members (user-ruled 2026-08-29):
// a shell script is editable repo source, and a `.bat`/`.cmd` is editable repo
// source on WINDOWS exactly as `.sh` is on Linux. Dropping them unconditionally
// made the hook silently omit a genuinely-written `.bat` from overlap warnings
// on Windows while warning correctly for the same file role on Linux — a 1:1
// Windows/Linux parity violation, in the silent-under-warn direction this board
// item calls worse than the noise it replaces. All three are suppressed by the
// COMMAND-CONTEXT rule (2) when they are invoked, and stay territory when a lane
// rewrites them.
const EXECUTABLE_EXT_RE = /\.(?:exe|dll|so|dylib)$/i;

// (2) NON-EXECUTABLES ARE EXCLUDED PER MENTION, NOT PER PATH. A gate runner
// passed as an argument ('… -s addons/gdUnit4/bin/GdUnitCmdTool.gd', 'node
// --test scripts/tests/x.test.mjs') is invoked, not written; but the SAME path
// named anywhere else in the brief as an edit target ('then rewrite
// tools/bin/report_writer.gd') is territory again. Under-reporting is the
// expensive failure for this advisory, so any non-command mention keeps the
// path. The test is USAGE, never path shape — a 'bin/' or 'tools/' blanket
// would drop source files the lane genuinely writes.
//
// A mention is command-shaped when walking back through the tokens BEFORE it
// on its own line reaches a COMMAND HEAD (an executable-extension token, or an
// interpreter/runner word) across nothing but flags — the first prose word, or
// a shell separator, ends the walk and the mention stays territory. That
// bound is what keeps the two mentions in "First run X … then rewrite X"
// distinguishable: an unbounded reach from 'run' would swallow the second one.
// EVERY MEMBER MUST BE A WORD THAT IS NOT ALSO AN ORDINARY ENGLISH VERB IN THIS
// POSITION. 'make' and 'go' were members and are REMOVED (review, 2026-08-29):
// a brief line "- make src/parser.mjs handle CRLF" — often the ONLY mention of
// that path — walked back onto 'make', classified the mention as a command
// argument, and dropped a genuine live-lane overlap SILENTLY; same for "go
// through src/x.mjs". Under-warning is the expensive failure for this advisory,
// so a runner word that doubles as a verb costs more than the build-tool
// invocations it suppresses (those name their target as a TASK, not a path).
const RUNNER_HEAD_RE = /^(?:node|npm|npx|pnpm|yarn|deno|bun|python3?|bash|sh|zsh|pwsh|powershell|dotnet|cargo)$/i;
const COMMAND_SEPARATOR_RE = /^(?:&&|\|\||[|;])$/;

// A REAL FLAG, not a bullet or a dash of punctuation: '--headless', '-a'. Used
// only by the command-HEAD rule below, so a list item ('- src/x.mjs …') and an
// em dash never read as a command argument.
const FLAG_TOKEN_RE = /^-{1,2}[A-Za-z0-9]/;

/** True when the mention at `index` sits in the argument position of a command
 *  line, OR is itself the HEAD of one — see (2) above. Never throws: every token
 *  is coerced and the walk terminates at the line start (this hook may not fail
 *  internally). */
function isRunMention(text, index) {
  const lineStart = text.lastIndexOf('\n', Math.max(index - 1, 0)) + 1;
  const tokens = text.slice(lineStart, index).split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    // Strip shell/prose decoration so a backticked or quoted command head is
    // still recognized ('`node' -> 'node').
    const token = tokens[i].replace(/^[`'"([]+/, '').replace(/[`'")\]]+$/, '');
    if (!token || token === '.') continue; // decoration only, or '--path .'
    if (COMMAND_SEPARATOR_RE.test(token)) return false; // a previous command does not govern this one
    if (EXECUTABLE_EXT_RE.test(token) || RUNNER_HEAD_RE.test(token)) return true;
    if (token.startsWith('-')) continue; // a flag — keep walking toward the head
    return false; // prose: this mention is not an argument of anything
  }
  // COMMAND-HEAD POSITION. The walk reached the line start across nothing but
  // decoration and flags, so this mention is the FIRST word of its line — it is
  // not an argument of anything, but it may BE the command. A script is invoked
  // by naming it directly ('tools/bin/gate.bat --headless', './gate.sh -a x'):
  // no interpreter precedes it, so the argument rule above can never see it, and
  // before this the whole shape was classified as write territory. That was
  // invisible while `.bat`/`.cmd` rode the unconditional executable family and
  // `.sh` was the lone (silently mis-suppressed) case; with the family narrowed
  // to compiled artifacts (user ruling 2026-08-29) it governs all three
  // editable script extensions, which is what makes 'suppressed by the
  // COMMAND-CONTEXT rule when invoked' true rather than aspirational.
  // NARROW ON PURPOSE: only a following REAL FLAG counts as evidence of
  // invocation. 'src/parser.mjs needs a CRLF fix' and '- src/parser.mjs — do X'
  // both stay territory, because under-warning is this advisory's expensive
  // failure; a head mention followed by prose is a sentence, not a command.
  const rest = text.slice(index).split('\n', 1)[0];
  const nextToken = rest.split(/\s+/).filter(Boolean)[1];
  return Boolean(nextToken) && FLAG_TOKEN_RE.test(nextToken);
}

/** True when at least ONE mention of `raw` in the prompt is not command-shaped
 *  — the mention-level unit of exclusion from (2). */
function hasNonRunMention(prompt, raw) {
  const text = String(prompt ?? '');
  const re = new RegExp(escapeRe(raw), 'g');
  let m;
  while ((m = re.exec(text))) {
    if (!isRunMention(text, m.index)) return true;
    if (m.index === re.lastIndex) re.lastIndex++; // guard a zero-width match
  }
  return false;
}

/**
 * SPEC B advisory text for a claimed resource already held by a live
 * dispatch — flat, uncaveated (no hedging tokens; SPEC B (5)), names every
 * contested resource and every distinct holder identity `type:id`.
 */
function buildResourceAdvisory(contested) {
  const resourceList = [...new Set(contested.map((c) => c.name))].map((n) => `'${n}'`).join(', ');
  const holderList = [...new Set(contested.map((c) => `${c.agentType}:${c.agentId}`))].join(', ');
  return (
    `H26 RESOURCE OVERLAP ADVISORY — this dispatch's brief claims exclusive resource(s) ${resourceList}, ` +
    `already held by live in-flight dispatch(es): ${holderList}. This is warn-only, never a block (decision ` +
    `6de73875-75b5-4182-8c1c-ca4841c993fa). It may repeat on further dispatches while the holding dispatch stays ` +
    `live, since the prompt extraction only approximates territory. Remedy: ` +
    `coordinate with the holder before proceeding, or drop the resource claim.`
  );
}

let input;
try {
  input = readStdin();
} catch (e) {
  // Internal failure — the stdin contract itself is broken, not a dispatch to
  // evaluate. Loud but non-blocking (P5 without a denial).
  warnNonBlocking(`H26: failed to parse stdin: ${(e && e.message) || e}`);
}

function emit(additionalContext) {
  recordAdvisoryFire(input.cwd, 'h26', input.session_id); // expiring campaign scaffolding — see lib/advisory-counter.mjs
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext },
    })
  );
}

try {
  const prompt = input.tool_input?.prompt;

  // Session-scoped live register, shared by the resource check below and the
  // file-overlap check further down (same liveness/TTL semantics either way).
  // liveDispatches reads only the register/config JSON files — no store
  // dependency — so this is safe to compute even outside a Sterling project.
  const live = liveDispatches(input.cwd).filter((e) => e && e.session_id === input.session_id);

  // SPEC B — EXCLUSIVE NON-FILE RESOURCE CLAIM. This runs BEFORE both (a) the
  // sterling.db project-marker gate just below and (b) the read-only-
  // dispatch-class early return further down: a reviewer/explorer-class
  // dispatch's FILE overlap stays suppressed (unchanged), but a resource it
  // claims that a live entry already holds must still warn — resources are
  // not write-territory, and the check needs only config.json + the register
  // (never the store), so it never needed the sterling.db gate to begin with.
  // A directory with no .sterling/config.json at all yields configuredNames
  // === [] and stays silent regardless (the non-Sterling control case).
  const cfg = loadConfig(input.cwd);
  const configuredNames = Array.isArray(cfg?.exclusive_resources)
    ? cfg.exclusive_resources.filter((n) => typeof n === 'string' && n.trim())
    : [];
  let resourceAdvisory = '';
  if (configuredNames.length) {
    const claimed = claimedResources(prompt, configuredNames);
    if (claimed.length) {
      const contested = [];
      for (const e of live) {
        // Same pruning semantics as the file-overlap comparison below: a
        // malformed entry (no agent_id) or an imprecisely-attributed one
        // (not a provable single-block claim) never contributes a warning.
        if (!e || !e.agent_id || e.attribution !== 'block' || !Array.isArray(e.exclusive_resources)) continue;
        for (const name of claimed) {
          if (e.exclusive_resources.includes(name)) {
            contested.push({ name, agentType: e.agent_type ?? 'agent', agentId: e.agent_id });
          }
        }
      }
      if (contested.length) resourceAdvisory = buildResourceAdvisory(contested);
    }
  }

  // Combine whichever advisories fired (file overlap, resource overlap, both,
  // or neither) into one emission and exit — every early return below routes
  // through this so the resource advisory is never lost when the file-overlap
  // check bails out earlier (non-Sterling cwd, no candidates, no live
  // entries, no overlap).
  function finish(fileAdvisory) {
    const parts = [fileAdvisory, resourceAdvisory].filter(Boolean);
    if (parts.length) emit(parts.join('\n\n'));
    allow();
  }

  // Not a Sterling project — no ceremony for FILE overlap (P1), same DB-file
  // marker every other hook in this layer keys on. The resource advisory
  // computed above still surfaces (it never touched the store).
  if (!existsSync(join(input.cwd ?? '.', '.sterling', 'sterling.db'))) finish();

  // READ-ONLY incoming dispatch (board a6b76e8c item 3): a reviewer/explorer/
  // Explore/Plan class cannot write, so it can never enter a live write lane
  // — never warn FILE overlap for one, regardless of prompt content. The
  // resource advisory computed above is unaffected by this exemption.
  if (isReadOnlyDispatchType(input.tool_input?.subagent_type)) finish();

  // Repo-relative POSIX only, with H22's exact exclusion filter mirrored
  // verbatim: .git/.sterling are never governed territory, and the dot-
  // stripped 'sterling/…'/'git/…' forms the extractor can produce are
  // dropped too, so an excluded path never enters the candidate set at all.
  // Named so both branches below (structured declaration and prose
  // extraction) apply the exact same exclusion rather than two copies.
  const dropGoverned = (norm) =>
    norm !== '.git' && !norm.startsWith('.git/') && !norm.startsWith('.sterling/') && !norm.startsWith('sterling/') && !norm.startsWith('git/');

  // STRUCTURED TERRITORY WINS OVER PROSE-SCRAPING (board 7632586d item 2,
  // decision 8f137474 review-territory-structured-receipt-files). Reuses the
  // SAME REVIEW-TERRITORY line h22-dispatch-register.mjs already parses
  // (lib/dispatch-prompt.mjs's parseReviewTerritory — one parser, not a
  // second one drifting from it). A well-formed declaration is an EXPLICIT
  // positive territory claim the dispatcher wrote on purpose, so none of the
  // prose-extraction ambiguity below (negation, run-vs-write, subject-of-
  // change) applies to it — the measured false positives this board item
  // fixes were exactly prose heuristics misreading a FORBIDDEN block as
  // claimed territory, which a structured declaration cannot do. A missing or
  // malformed declaration falls through to the prose extractor, mirroring
  // h22's own fallback for the same shape.
  const territoryDecl = parseReviewTerritory(prompt);
  let files;
  if (territoryDecl.present && territoryDecl.valid) {
    files = [...new Set(territoryDecl.files.map((raw) => repoRel(raw, input.cwd)).filter((norm) => norm && dropGoverned(norm)))];
  } else {
    const candidates = extractPathCandidates(prompt);
    // KEEP THE PRE-NORMALIZATION STRING for the suppression check (review
    // finding, board a6b76e8c fixer pass): a Windows-style mention
    // ('src\util.mjs') normalizes to 'src/util.mjs', which never literally
    // appears in the RAW prompt — searching the normalized form there silently
    // dropped every such candidate as "not found" rather than warning on it.
    // The normalized form is still what feeds the register comparison below.
    const normalized = candidates.map((raw) => ({ raw, norm: repoRel(raw, input.cwd) })).filter((p) => p.norm && dropGoverned(p.norm));
    // Then the SHARED PROHIBITION/NEGATION CHECK (board a6b76e8c item 1): a
    // path named only inside a prohibition ("DO NOT TOUCH: <paths> (another
    // lane owns those)") is a NEGATIVE territory declaration, not a positive
    // claim on this dispatch's own lane — it must never count as a candidate.
    // checkSubjectVerb:false — "implement the feature in <path>" is a
    // legitimate territory declaration for a FILE candidate, not a
    // subject-of-change mention to discount (that guard is for H25's tool
    // mentions only); only an actual negation suppresses a path here.
    // Then RUN-NOT-WRITE (board 8f43e6b5, see the two rules at the top of this
    // file): the executable family drops unconditionally, and a non-executable
    // whose every mention is an argument of a command line drops too. DISCLOSED
    // RESIDUAL: this filter and the negation check above are independent
    // any-occurrence tests, so a path whose only unsuppressed mention is
    // command-shaped and whose only non-command mention is negated survives both
    // — over-warning, the direction this family already accepts (P1), never a
    // silently dropped lane.
    files = [
      ...new Set(
        normalized
          .filter((p) => hasUnsuppressedMatch(prompt, new RegExp(escapeRe(p.raw)), { checkSubjectVerb: false }))
          .filter((p) => !EXECUTABLE_EXT_RE.test(p.norm))
          .filter((p) => hasNonRunMention(prompt, p.raw))
          .map((p) => p.norm)
      ),
    ];
  }
  if (!files.length) finish();

  const candidateSet = new Set(files);

  if (!live.length) finish();

  const overlaps = [];
  const overlapPaths = new Set();
  for (const e of live) {
    // A malformed entry (no `files` array, no agent_id — the entry key) is
    // skipped outright: it can never contribute an overlap, and it must never
    // surface as a bogus 'undefined:undefined' dispatch identity. agent_type
    // is NOT required — H22 writes `agent_type ?? null` by design, so a null
    // type gets the same 'agent' fallback label the script-side reader uses
    // (scripts/lib/dispatch-register.mjs inFlightAdvisory).
    if (!e || !Array.isArray(e.files) || !e.agent_id) continue;
    // A READ-ONLY-CLASS live entry (board 7632586d item 1) can never
    // CONTRIBUTE an overlap warning either — its write-set is structurally
    // empty, so a path it merely mentioned (reviewed, explored, or updated
    // in the knowledge store) was never really held territory to begin with.
    // Symmetric with the incoming-dispatch exemption above.
    if (isReadOnlyDispatchType(e.agent_type)) continue;
    // IMPRECISE ATTRIBUTION IS SUPPRESSED, NOT CAVEATED (decision 5d3747c1):
    // an entry H22 could only union across several/zero type-matching blocks
    // (attribution:'union') may not actually name this dispatch's territory,
    // and a legacy entry with no `attribution` field at all predates this
    // mechanism and carries the same old union-of-everything imprecision —
    // both are skipped outright so a warning never fires on files that may
    // not belong to the sibling it names. Only attribution:'block' entries
    // (a provable single type-matching source block) still warn.
    if (e.attribution !== 'block') continue;
    // TERRITORY CLAIMED, NOT TERRITORY EXAMINED (board c56862a9,
    // research_finding 289cd172). H22's `files` is multiplexed — review
    // receipts, residue probes and H10's deferral all need every path the
    // brief MENTIONED, including the ones it forbade — so H22 keeps writing
    // that breadth and adds `claimed_files`, the same paths minus those named
    // only inside a prohibition ("DO NOT TOUCH: <path>"). An overlap warning
    // is about WRITE territory, so it reads the claimed subset: warning a new
    // lane off a path its neighbour was explicitly told NOT to touch is the
    // measured false positive (seven in one session), and it punished exactly
    // the briefs that named their do-not-touch lists most carefully.
    // A pre-field entry has no `claimed_files` and falls back to `files` —
    // today's behavior, never a silently empty lane.
    //
    // DECLARED-TERRITORY ENTRIES ARE EXEMPT FROM THE claimed_files FALLBACK
    // TOO (board 7632586d, Codex review HIGH, thread 01a05b8c). H22 writes
    // `claimed_files`/`claimed_glob_prefixes` from a PROSE re-scan of the
    // SAME attributed blocks (claimedFromBlocks/globPrefixesFromBlocks in
    // h22-dispatch-register.mjs) regardless of files_source — so a live
    // entry whose OWN `files` already came from a REVIEW-TERRITORY
    // declaration (files_source === 'review-territory') still carries a
    // claimed_files/claimed_glob_prefixes computed from its brief's free
    // prose, including any FORBIDDEN-block mention. Comparing against that
    // reintroduces exactly the false positive step 2 exists to remove, just
    // on the LIVE side instead of the outgoing side: a live coder that
    // declared REVIEW-TERRITORY: ["src/a.mjs"] but mentioned forbidden
    // src/b.mjs in prose would still conflict with a later dispatch on
    // src/b.mjs. A declared entry's `files` IS its structured declaration
    // (resolveTerritory's declared branch, h22-dispatch-register.mjs) — the
    // authoritative, exclusive territory — so a declared entry compares
    // against `files` alone, never claimed_files, and never
    // claimed_glob_prefixes (glob claims are prose-only; a REVIEW-TERRITORY
    // array cannot contain a glob token, since parseReviewTerritory requires
    // each element to already be a canonical repo-relative POSIX path).
    // Every other files_source ('free-prose-fallback', or absent on a
    // pre-migration entry) keeps today's behavior byte-identical.
    const isDeclaredTerritory = e.files_source === 'review-territory';
    const entryFiles = isDeclaredTerritory ? e.files : Array.isArray(e.claimed_files) ? e.claimed_files : e.files;
    const matchedExact = entryFiles.filter((f) => candidateSet.has(f));
    // GLOB LITERAL-PREFIX OVERLAP (board a63b226d) — PREFIX-AWARE (startsWith)
    // matching, and ONLY for this field: `claimed_glob_prefixes` (absent on a
    // pre-field entry -> [], same degrade-to-nothing posture as claimed_files
    // above) holds directory prefixes a brief claimed via a literal-prefix
    // "**" glob ("YOUR FILES: scripts/hooks/**"). `claimed_files`/`files`
    // stay EXACT-STRING-EQUALITY ONLY, completely unchanged — prefix
    // matching never applies to them, so this cannot widen today's behavior
    // for any brief that never used the glob idiom. A candidate file overlaps
    // a claimed prefix when it IS that prefix or sits anywhere under it
    // ('/' boundary, so "packages/mcp-server-utils/x.ts" can never falsely
    // match a "packages/mcp-server" prefix — the boundary check requires the
    // '/' itself, not just a shared string prefix).
    //
    // DISCLOSED, NOT A DEFECT (board a63b226d follow-up review, MEDIUM,
    // CONFIRMED): EXTRACTION of glob-prefix claims is bidirectional — a
    // glob is suppressed as a prohibition and registered as a claim on
    // EITHER side (h22's globPrefixesFromBlocks runs on every SubagentStart,
    // regardless of which lane is starting) — but COMPARISON here is NOT.
    // This block only prefix-matches THIS outgoing dispatch's own LITERAL
    // candidates (`files`, extracted above via extractPathCandidates) against
    // a live entry's `claimed_glob_prefixes`. It never calls
    // extractGlobPrefixCandidates on the OUTGOING prompt, so two shapes stay
    // silent: (1) an outgoing brief itself claiming a glob ("YOUR FILES:
    // scripts/hooks/**") against a live entry's LITERAL claim on a file
    // under it (e.g. "scripts/hooks/h10-....mjs") — the reverse of what this
    // block checks; and (2) prefix-vs-prefix, two glob claims on overlapping
    // subtrees with no literal file named by either side. Deliberately
    // unbuilt (not merely unnoticed): nobody's reproduction needed it, and
    // this family prefers bounded under-warning over the added surface a
    // second extraction+comparison pass would add (P1).
    const entryPrefixes = isDeclaredTerritory ? [] : Array.isArray(e.claimed_glob_prefixes) ? e.claimed_glob_prefixes : [];
    const matchedPrefix = entryPrefixes.length
      ? files.filter((f) => entryPrefixes.some((p) => f === p || f.startsWith(`${p}/`)))
      : [];
    const matched = [...new Set([...matchedExact, ...matchedPrefix])];
    if (matched.length) {
      overlaps.push({ agentType: e.agent_type ?? 'agent', agentId: e.agent_id, files: matched });
      matched.forEach((f) => overlapPaths.add(f));
    }
  }
  if (!overlaps.length) finish();

  const pathList = [...overlapPaths].map((p) => `'${p}'`).join(', ');
  const entryList = overlaps.map((o) => `${o.agentType}:${o.agentId} (${o.files.join(', ')})`).join('; ');
  finish(
    `H26 DISPATCH OVERLAP ADVISORY — this dispatch's brief names file(s) that overlap a LIVE in-flight ` +
      `dispatch's declared territory: ${pathList}. Overlapping live dispatch(es): ${entryList}. This is ` +
      `warn-only, never a block (decision 6de73875-75b5-4182-8c1c-ca4841c993fa) — the prompt extraction only approximates write territory, and this hook ` +
      `compares only dispatches already present in the live register when this PreToolUse fires. It may repeat ` +
      `on further dispatches while the holding dispatch stays live, for the same reason. Remedy: ` +
      `keep lanes file-disjoint — await the in-flight agent, or re-scope this dispatch's territory so it does ` +
      `not overlap.`
  );
} catch (e) {
  // Advisory only, never a gate: loud but non-blocking (P5 without AC7 harm).
  warnNonBlocking(`H26: dispatch-overlap advisory failed: ${(e && e.message) || e}`);
}
// no close: every path above exits the process, releasing the handle (board f81b1987)
