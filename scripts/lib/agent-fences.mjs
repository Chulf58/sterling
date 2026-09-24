// Agent-template fences (decision
// init-prepares-opencode-portable-agents-and-target-handoff-projections, refinement (c)).
// One agent source renders two ways:
//   - the Claude render (.claude/agents/) drops the sterling-only MARKER LINES and
//     keeps their content, and drops every portable-only BLOCK whole — so fencing
//     a template leaves the Claude agent byte-identical;
//   - the portable render (.opencode/agents/) drops every sterling-only BLOCK whole
//     and keeps the portable-only content without its marker lines.
// A rewritten line is therefore a sterling-only original plus a portable-only
// replacement. A marker is a whole line, exactly as written below; fences are
// balanced and never nested. Anything else is refused loudly (P5), never guessed.
// Dependency-free on purpose: agent-distribution.mjs and opencode-agents.mjs
// both import it.

export const FENCE_KINDS = {
  'sterling-only': { open: '<!-- sterling-only -->', close: '<!-- /sterling-only -->' },
  'portable-only': { open: '<!-- portable-only -->', close: '<!-- /portable-only -->' },
};

// Any line that mentions a fence name inside an HTML comment is meant as a
// marker; one that is not byte-exact is malformed rather than silently prose.
const MARKER_LIKE_RE = /<!--.*\b(?:sterling|portable)-only\b/;

function classify(line) {
  for (const [kind, { open, close }] of Object.entries(FENCE_KINDS)) {
    if (line === open) return { kind, role: 'open' };
    if (line === close) return { kind, role: 'close' };
  }
  return MARKER_LIKE_RE.test(line) ? { role: 'malformed' } : null;
}

const splitLines = (text) => text.replace(/\r\n/g, '\n').split('\n');

export function validateFences(text, label) {
  const violations = [];
  let openFence = null;
  splitLines(text).forEach((line, index) => {
    const at = `${label}:${index + 1}`;
    const marker = classify(line);
    if (!marker) return;
    if (marker.role === 'malformed') {
      violations.push({ kind: 'fence_malformed', detail: `${at}: '${line}' names a fence but is not exactly a marker line (${Object.values(FENCE_KINDS).map((f) => `'${f.open}'/'${f.close}'`).join(', ')})` });
    } else if (marker.role === 'open') {
      if (openFence) {
        violations.push({ kind: 'fence_nested', detail: `${at}: '${line}' opens inside the ${openFence.kind} fence opened at line ${openFence.line} — fences never nest` });
      } else {
        openFence = { kind: marker.kind, line: index + 1 };
      }
    } else if (!openFence) {
      violations.push({ kind: 'fence_unopened', detail: `${at}: '${line}' closes a fence that was never opened` });
    } else if (openFence.kind !== marker.kind) {
      violations.push({ kind: 'fence_mismatched', detail: `${at}: '${line}' closes a ${marker.kind} fence, but the open one is ${openFence.kind} (line ${openFence.line})` });
    } else {
      openFence = null;
    }
  });
  if (openFence) {
    violations.push({ kind: 'fence_unclosed', detail: `${label}:${openFence.line}: the ${openFence.kind} fence is never closed` });
  }
  return violations;
}

// keepKind: the fence whose CONTENT survives (markers dropped); the other kind's
// blocks are dropped whole. Line endings are normalized to LF, like every other
// render in agent-distribution.
function render(text, label, keepKind) {
  const violations = validateFences(text, label);
  if (violations.length) {
    throw new Error(`agent fences invalid in ${label} — refusing to render (P5):\n  ${violations.map((v) => `[${v.kind}] ${v.detail}`).join('\n  ')}`);
  }
  const out = [];
  let inside = null;
  for (const line of splitLines(text)) {
    const marker = classify(line);
    if (marker) {
      inside = marker.role === 'open' ? marker.kind : null;
      continue;
    }
    if (inside && inside !== keepKind) continue;
    out.push(line);
  }
  return out.join('\n');
}

export function renderClaudeText(text, label) {
  return render(text, label, 'sterling-only');
}

export function renderPortableText(text, label) {
  return render(text, label, 'portable-only');
}

// What a reader with no Sterling installed cannot act on (decision 161e2972's
// rule: a line stays only if such an engineer can follow it). Checked over the
// portable BODY, never the provenance header.
export const PORTABLE_VOCABULARY = [
  { term: 'knowledge_ tool', re: /knowledge_/ },
  { term: 'board_ tool', re: /board_/ },
  { term: 'maintenance_ tool', re: /maintenance_/ },
  { term: 'mcp__ tool name', re: /mcp__/ },
  { term: 'H<n> hook name', re: /\bH\d+\b/ },
  { term: 'Sterling', re: /sterling/i },
  { term: 'conductor', re: /\bconductor\b/i },
  { term: 'required-inputs manifest', re: /required[-_ ]inputs/i },
];

export function findPortableVocabulary(text) {
  const hits = [];
  splitLines(text).forEach((line, index) => {
    for (const { term, re } of PORTABLE_VOCABULARY) {
      const m = line.match(re);
      if (m) hits.push({ term, line: index + 1, match: m[0], text: line });
    }
  });
  return hits;
}
