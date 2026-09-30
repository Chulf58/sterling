// DISPATCH OVERLAP — H20's advisory for a write-capable dispatch whose brief
// names files a live dispatch already owns (decision
// h20-warns-on-dispatch-file-overlap-with-live-agents). It restores a slim
// form of the deleted H26 inside an existing hook. It never denies and never
// throws: the caller gets a text block, a degraded line, or null.
//
// THE RULES, carried over from H26's false-positive history (commits 358c3bb
// and 260d656, and the claimed_files fix for seven measured false positives):
//   1. Read-only lanes are skipped: researcher, scout, reviewer and reviewer-*,
//      Explore/explorer, Plan, librarian, and any lane whose brief states it
//      is read-only.
//   2. The brief's files come from its REVIEW-TERRITORY declaration when that
//      is valid, else from its prose. Prose paths are kept only when at least
//      one mention is neither negated ("do not touch X", "X ... do not edit
//      those", via the shared hasUnsuppressedMatch) nor an argument of a
//      command line ("node --test scripts/tests/x.test.mjs"). Compiled
//      executables are never territory. Paths inside an "Out of scope:" or
//      "Do not touch:" section are subtracted.
//   3. A brief path and a live row path overlap when they are equal, or when
//      one is a directory containing the other and that directory has at
//      least TWO segments ("scripts/hooks" yes, "scripts" never). Directories
//      reach this comparison only from a REVIEW-TERRITORY declaration or a
//      "dir/sub/**" glob, so two sibling files never overlap each other.
//   4. Live rows are presumed-active only (this session, inside the lease,
//      not ended). A read-only-class row never contributes.
//
// NOT GUARANTEED: a live row's `files` is whatever H22 recorded, which for a
// prose brief includes paths that brief told its own agent not to touch, so a
// warning can name an owner that was told to keep off the path. Dispatches
// sent in one message cannot see each other (H22 registers at SubagentStart).
import { repoRel } from './common.mjs';
import { extractPathCandidates, parseReviewTerritory } from './dispatch-prompt.mjs';
import { hasUnsuppressedMatch, escapeRe, extractGlobPrefixCandidates, isReviewerClass } from './dispatch-advisory.mjs';
import { presumedActiveEntries } from '../../lib/dispatch-register.mjs';

export const OVERLAP_HEAD = 'DISPATCH OVERLAP (advisory)';
export const OVERLAP_DISPLAY_CAP = 5;

// Agent types whose write-set is empty for repo files. H26's list (explorer,
// Explore, Plan, librarian, reviewer-*) plus this project's researcher, scout
// and a plain 'reviewer'.
const READ_ONLY_TYPES = new Set(['researcher', 'scout', 'reviewer', 'explore', 'explorer', 'plan', 'librarian']);

export function isReadOnlyDispatchType(type) {
  if (typeof type !== 'string' || !type) return false;
  if (isReviewerClass(type)) return true;
  return READ_ONLY_TYPES.has(type.toLowerCase());
}

// A brief STATES it is read-only only in these shapes. Deliberately narrow: a
// write brief mentioning "the read-only classification" or "a read-only
// review lane" must still be checked, since under-warning a real writer is
// the expensive miss.
const READ_ONLY_BRIEF_RES = [
  /\b(?:you are|you're|this is|this lane is|this task is|as)\s+an?\s+read[- ]only\s+(?:lane|task|dispatch|review|investigation|research|audit|pass|agent)\b/i,
  /\b(?:you are|you're|this lane is|this task is|this dispatch is|stay|remain)\s+(?:strictly\s+|entirely\s+)?read[- ]only\b/i,
  /^[\s>*_#-]*read[- ]only\b[\s*_]*[:.—–]/im,
  /\b(?:do not|don['’]t|never)\s+(?:edit|modify|write|change)\s+any\s+(?:files?|code)\s*(?:[.;,)\n]|$|at all)/i,
  /\bmake no (?:edits|changes|file changes)\b/i,
];

export function briefStatesReadOnly(prompt) {
  const text = String(prompt ?? '');
  return READ_ONLY_BRIEF_RES.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Run-not-write (H26, board 8f43e6b5): a path named as a thing to RUN is not a
// path the lane will write. Every brief spells out its gate command, so
// without this every pair of concurrent briefs "overlaps" on the test runner.
// ---------------------------------------------------------------------------
const EXECUTABLE_EXT_RE = /\.(?:exe|dll|so|dylib)$/i;
// Runner words that are not also ordinary English verbs in this position
// ('make' and 'go' were removed from H26's list for dropping real edits).
const RUNNER_HEAD_RE = /^(?:node|npm|npx|pnpm|yarn|deno|bun|python3?|bash|sh|zsh|pwsh|powershell|dotnet|cargo)$/i;
const COMMAND_SEPARATOR_RE = /^(?:&&|\|\||[|;])$/;
const FLAG_TOKEN_RE = /^-{1,2}[A-Za-z0-9]/;

function isRunMention(text, index) {
  const lineStart = text.lastIndexOf('\n', Math.max(index - 1, 0)) + 1;
  const tokens = text.slice(lineStart, index).split(/\s+/).filter(Boolean);
  // Text glued to the mention ('./' in './scripts/x.mjs', a backtick) is part
  // of the mention's own token, not a word before it.
  if (index > lineStart && !/\s/.test(text[index - 1])) tokens.pop();
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i].replace(/^[`'"([]+/, '').replace(/[`'")\]]+$/, '');
    if (!token || token === '.') continue;
    if (COMMAND_SEPARATOR_RE.test(token)) return false;
    if (EXECUTABLE_EXT_RE.test(token) || RUNNER_HEAD_RE.test(token)) return true;
    if (token.startsWith('-')) continue;
    return false;
  }
  // First word of its line: a command only when a real flag follows it.
  const rest = text.slice(index).split('\n', 1)[0];
  const nextToken = rest.split(/\s+/).filter(Boolean)[1];
  return Boolean(nextToken) && FLAG_TOKEN_RE.test(nextToken);
}

function hasNonRunMention(text, raw) {
  const re = new RegExp(escapeRe(raw), 'g');
  let m;
  while ((m = re.exec(text))) {
    if (!isRunMention(text, m.index)) return true;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Out-of-scope / do-not-touch sections. A marker followed by a colon opens a
// span: at the start of a line the span runs over the following lines until
// a blank line or the next "Label:" line; mid-line it runs to the next
// ". Label:" or the end of the line. A bare heading line ("## Out of scope")
// opens a multi-line span too. Negated sentences without a colon ("Do NOT
// touch those three files.") are the shared negation detector's job.
// ---------------------------------------------------------------------------
const EXCLUSION_MARKER = String.raw`(?:out[- ]of[- ]scope|do\s+not\s+(?:touch|edit|modify|write)|don['’]t\s+(?:touch|edit|modify|write)|never\s+(?:touch|edit|modify|write))`;
const EXCLUSION_INLINE_RE = new RegExp(`${EXCLUSION_MARKER}[^:\\n]{0,40}:`, 'gi');
const EXCLUSION_LINE_START_RE = new RegExp(`^[\\s>*_#-]*${EXCLUSION_MARKER}`, 'i');
const EXCLUSION_HEADING_RE = new RegExp(`^[\\s>*_#-]*${EXCLUSION_MARKER}[\\s*_]*$`, 'i');
const LABEL_LINE_RE = /^[\s>*_#-]*[A-Z][\w /'()-]{0,40}:(?:\s|$)/;
const NEXT_LABEL_RE = /\.\s+[A-Z][\w /'()-]{0,30}:(?:\s|$)/;

export function exclusionSpans(prompt) {
  const lines = String(prompt ?? '').split(/\r?\n/);
  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = EXCLUSION_HEADING_RE.test(line);
    if (heading || EXCLUSION_LINE_START_RE.test(line)) {
      const colon = line.indexOf(':');
      if (!heading && colon === -1) continue; // a sentence, not a section
      const body = [heading ? '' : line.slice(colon + 1)];
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim() || LABEL_LINE_RE.test(lines[j])) break;
        body.push(lines[j]);
        i = j;
      }
      spans.push(body.join('\n'));
      continue;
    }
    EXCLUSION_INLINE_RE.lastIndex = 0;
    let m;
    while ((m = EXCLUSION_INLINE_RE.exec(line))) {
      const rest = line.slice(m.index + m[0].length);
      const stop = rest.search(NEXT_LABEL_RE);
      spans.push(stop === -1 ? rest : rest.slice(0, stop + 1));
    }
  }
  return spans;
}

const dropGoverned = (norm) =>
  norm !== '.git' && !norm.startsWith('.git/') && !norm.startsWith('.sterling/') && !norm.startsWith('sterling/') && !norm.startsWith('git/');

/** The paths this brief claims as write territory, repo-relative POSIX (a
 *  directory entry carries no trailing '/'). */
export function briefTerritory(prompt, cwd) {
  const text = String(prompt ?? '');
  const norm = (raw) => {
    const n = repoRel(String(raw).replace(/\/+$/, ''), cwd);
    return n && dropGoverned(n) ? n : null;
  };
  const declared = parseReviewTerritory(text);
  if (declared.present && declared.valid) return [...new Set(declared.files.map(norm).filter(Boolean))];

  const excludedFiles = new Set();
  const excludedDirs = new Set();
  for (const span of exclusionSpans(text)) {
    for (const raw of extractPathCandidates(span)) {
      const n = norm(raw);
      if (n) excludedFiles.add(n);
    }
    for (const raw of extractGlobPrefixCandidates(span)) {
      const n = norm(raw);
      if (n) excludedDirs.add(n);
    }
  }
  const excluded = (p) => excludedFiles.has(p) || excludedDirs.has(p) || [...excludedDirs].some((d) => p.startsWith(`${d}/`));
  const unsuppressed = (raw) => hasUnsuppressedMatch(text, new RegExp(escapeRe(raw)), { checkSubjectVerb: false });

  const out = new Set();
  for (const raw of extractPathCandidates(text)) {
    const n = norm(raw);
    if (!n || EXECUTABLE_EXT_RE.test(n) || excluded(n)) continue;
    if (unsuppressed(raw) && hasNonRunMention(text, raw)) out.add(n);
  }
  for (const raw of extractGlobPrefixCandidates(text)) {
    const n = norm(raw);
    if (!n || excluded(n)) continue;
    if (unsuppressed(`${raw}**`)) out.add(n);
  }
  return [...out];
}

/** Rule 3: equal, or one contains the other and the container has >= 2 segments. */
export function pathsOverlap(a, b) {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.split('/').length >= 2 && long.startsWith(`${short}/`);
}

/**
 * The advisory block for this dispatch, or null. `input` is the PreToolUse
 * stdin (tool_input.subagent_type/prompt, cwd, session_id). Never throws: a
 * register that cannot be read yields one degraded line instead.
 */
export function dispatchOverlapNotice(input, { now = Date.now() } = {}) {
  try {
    const type = input?.tool_input?.subagent_type;
    const prompt = input?.tool_input?.prompt;
    if (typeof prompt !== 'string' || !prompt) return null;
    if (isReadOnlyDispatchType(type) || briefStatesReadOnly(prompt)) return null;
    const files = briefTerritory(prompt, input.cwd);
    if (!files.length) return null;

    const live = presumedActiveEntries(input.cwd, { now, sessionId: input.session_id });
    if (live.availability === 'corrupt') {
      return `${OVERLAP_HEAD} — degraded: the dispatch register could not be read, so this brief's files were not checked against running agents.`;
    }
    const hits = [];
    for (const e of live.entries) {
      if (isReadOnlyDispatchType(e.agent_type)) continue;
      for (const owned of e.files) {
        if (typeof owned !== 'string' || !owned) continue;
        for (const f of files) {
          if (!pathsOverlap(f, owned)) continue;
          const shown = f.length >= owned.length ? f : owned;
          hits.push(`${shown} ← ${e.agent_type ?? 'agent'}:${String(e.agent_id).slice(0, 8)}`);
        }
      }
    }
    const unique = [...new Set(hits)];
    if (!unique.length) return null;
    const shown = unique.slice(0, OVERLAP_DISPLAY_CAP);
    const more = unique.length > shown.length ? ` (+${unique.length - shown.length} more)` : '';
    return (
      `${OVERLAP_HEAD} — this brief names files a running agent owns: ${shown.join(', ')}${more}. ` +
      `Resume that agent, or wait for it and serialize — never two writers on one file.`
    );
  } catch (e) {
    return `${OVERLAP_HEAD} — degraded: the overlap check failed (${String((e && e.message) || e).slice(0, 160)}), so this brief's files were not checked against running agents.`;
  }
}
