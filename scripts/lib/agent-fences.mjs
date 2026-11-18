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
// A second axis is the HOST: a claude-only block reaches only the Claude render,
// an opencode-only block only the OpenCode renders (the Sterling-full render of
// scripts/lib/opencode-install.mjs and the portable render), so a host-specific
// instruction is a claude-only original plus an opencode-only replacement and the
// Claude render stays byte-identical to the unfenced template.
// A claude-only block must be paired: the next non-blank line after its close
// marker opens an opencode-only block, so a host-specific instruction cannot be
// left with no OpenCode text by accident (the OpenCode render would silently go
// without it). A claude-only block that really has no OpenCode counterpart says so
// with the whole-line marker `<!-- no-opencode-counterpart -->` as the first line
// inside the block; the marker is dropped from every render, so the Claude render
// stays identical to the same template without it.
// Dependency-free on purpose: agent-distribution.mjs and opencode-agents.mjs
// both import it.

export const FENCE_KINDS = {
  'sterling-only': { open: '<!-- sterling-only -->', close: '<!-- /sterling-only -->' },
  'portable-only': { open: '<!-- portable-only -->', close: '<!-- /portable-only -->' },
  'claude-only': { open: '<!-- claude-only -->', close: '<!-- /claude-only -->' },
  'opencode-only': { open: '<!-- opencode-only -->', close: '<!-- /opencode-only -->' },
  'agy-only': { open: '<!-- agy-only -->', close: '<!-- /agy-only -->' },
};

// Any HTML comment that NAMES a fence (any case, any separator, on one line or
// spread over several) is meant as a marker. Only the four byte-exact marker
// lines are markers; every other spelling is malformed and refused, never read
// as prose — prose would leak its block into the portable render (Sol review).
const FENCE_WORD_RE = /(?:sterling|portable|claude|opencode|agy)[\s_-]*only/i;
const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
const EXACT_MARKERS = new Set(Object.values(FENCE_KINDS).flatMap(({ open, close }) => [open, close]));

function classify(line) {
  for (const [kind, { open, close }] of Object.entries(FENCE_KINDS)) {
    if (line === open) return { kind, role: 'open' };
    if (line === close) return { kind, role: 'close' };
  }
  return null;
}

// Every fence-naming comment that is not a byte-exact marker occupying its whole line.
function malformedMarkers(text, label) {
  const lines = text.split('\n');
  const out = [];
  for (const m of text.matchAll(COMMENT_RE)) {
    if (!FENCE_WORD_RE.test(m[0])) continue;
    const lineIndex = text.slice(0, m.index).split('\n').length - 1;
    if (EXACT_MARKERS.has(m[0]) && lines[lineIndex] === m[0]) continue;
    out.push({
      kind: 'fence_malformed',
      detail: `${label}:${lineIndex + 1}: ${JSON.stringify(m[0].slice(0, 80))} names a fence but is not exactly a marker line (${Object.values(FENCE_KINDS).map((f) => `'${f.open}'/'${f.close}'`).join(', ')}) — case, spacing and line breaks must match`,
    });
  }
  return out;
}

export const NO_COUNTERPART_MARKER = '<!-- no-opencode-counterpart -->';

// Generalized form: `<!-- no-counterpart: opencode, agy -->` as the first line inside a
// host block names every host that has no counterpart for it. The legacy marker above
// stays valid and means exactly `<!-- no-counterpart: opencode -->`.
export const COUNTERPART_HOSTS = ['claude', 'opencode', 'agy'];
const HOST_OF_KIND = { 'claude-only': 'claude', 'opencode-only': 'opencode', 'agy-only': 'agy' };
const GENERAL_MARKER_RE = /^<!-- no-counterpart: ([a-z]+(?:, [a-z]+)*) -->$/;
const COUNTERPART_COMMENT_RE = /<!--\s*no[-_ ][\s\S]*?counterpart[\s\S]*?(?:-->|$)/gi;

/** The hosts a whole line declares as having no counterpart, or null if the line is not such a marker. Unknown host names are returned as-is so validation can refuse them. */
export function noCounterpartHosts(line) {
  if (line === NO_COUNTERPART_MARKER) return ['opencode'];
  const m = GENERAL_MARKER_RE.exec(line);
  return m ? m[1].split(', ') : null;
}

const splitLines = (text) => text.replace(/\r\n/g, '\n').split('\n');

function counterpartViolations(text, lines, label) {
  const out = [];
  for (const m of text.matchAll(COUNTERPART_COMMENT_RE)) {
    const lineIndex = text.slice(0, m.index).split('\n').length - 1;
    const hosts = lines[lineIndex] === m[0] ? noCounterpartHosts(m[0]) : null;
    if (!hosts) {
      out.push({ kind: 'fence_counterpart_malformed', detail: `${label}:${lineIndex + 1}: ${JSON.stringify(m[0].slice(0, 80))} is not '${NO_COUNTERPART_MARKER}' or '<!-- no-counterpart: host, host -->' on a line of its own` });
      continue;
    }
    const bad = hosts.filter((h) => !COUNTERPART_HOSTS.includes(h));
    if (bad.length || new Set(hosts).size !== hosts.length) {
      out.push({ kind: 'fence_counterpart_host', detail: `${label}:${lineIndex + 1}: no-counterpart hosts must be distinct names from ${COUNTERPART_HOSTS.join(', ')}; got ${hosts.join(', ')}` });
    }
  }
  return out;
}

// A run is host blocks separated only by blank lines. Every run accounts for all three hosts:
// each host either has a block in the run or is named by a no-counterpart marker in one of them,
// so a host-specific instruction never reaches one host's render and silently misses another's.
function unaccountedHosts(hostBlocks, lines, label) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const covered = new Set(run.flatMap((b) => [b.host, ...b.noCounterpart]));
    const missing = COUNTERPART_HOSTS.filter((h) => !covered.has(h));
    if (missing.length) {
      out.push({ kind: 'fence_host_unaccounted', detail: `${label}:${run[0].start}: this host block has no counterpart for ${missing.join(', ')}; add a ${missing.map((h) => `${h}-only`).join(' / ')} block, or '<!-- no-counterpart: ${missing.join(', ')} -->' as the first line inside one of the run's blocks` });
    }
    run = [];
  };
  for (const block of hostBlocks) {
    const prev = run[run.length - 1];
    if (prev && !lines.slice(prev.end, block.start - 1).every((l) => l.trim() === '')) flush();
    run.push(block);
  }
  flush();
  return out;
}

// options.allHosts turns on the host-accounting rule above. It is opt-in because the fences also
// reach files this repo does not own (a consumer project's CLAUDE.md) and files not yet ported to
// agy (commands, skills); the agent templates and the target-CLAUDE.md template pass it.
export function validateFences(text, label, { allHosts = false } = {}) {
  const violations = malformedMarkers(text.replace(/\r\n/g, '\n'), label);
  violations.push(...counterpartViolations(text.replace(/\r\n/g, '\n'), splitLines(text), label));
  let openFence = null;
  const hostBlocks = [];
  const lines = splitLines(text);
  lines.forEach((line, index) => {
    const at = `${label}:${index + 1}`;
    const marker = classify(line);
    if (!marker) return;
    if (marker.role === 'open') {
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
      // An empty claude-only or opencode-only block has nothing to swap: the OpenCode layer's
      // whole-line swap of an empty claude block matches at every index and never ends, and an
      // empty opencode block deletes its claude text without saying so.
      const host = HOST_OF_KIND[marker.kind];
      if (host) {
        const body = lines.slice(openFence.line, index).filter((l) => !noCounterpartHosts(l));
        if (!body.some((l) => l.trim() !== '')) {
          violations.push({ kind: 'fence_empty_block', detail: `${label}:${openFence.line}: the ${marker.kind} block is empty; give it the text that replaces its partner, or remove the pair` });
        }
        hostBlocks.push({ host, start: openFence.line, end: index + 1, noCounterpart: noCounterpartHosts(lines[openFence.line]) ?? [] });
        lines.slice(openFence.line, index).forEach((l, i) => {
          const hosts = noCounterpartHosts(l);
          if (!hosts) return;
          if (i !== 0) {
            violations.push({ kind: 'fence_counterpart_misplaced', detail: `${label}:${openFence.line + i + 1}: a no-counterpart marker must be the first line inside its ${marker.kind} block` });
          } else if (hosts.includes(host)) {
            violations.push({ kind: 'fence_counterpart_self', detail: `${label}:${openFence.line + 1}: a ${marker.kind} block cannot declare that ${host} has no counterpart for itself` });
          }
        });
      }
      if (marker.kind === 'claude-only') {
        const first = lines[openFence.line]; // openFence.line is 1-based, so this is the line after the open marker
        const next = lines.slice(index + 1).find((l) => l.trim() !== '');
        if (!(noCounterpartHosts(first) ?? []).includes('opencode') && next !== FENCE_KINDS['opencode-only'].open) {
          violations.push({ kind: 'fence_claude_only_unpaired', detail: `${label}:${openFence.line}: the claude-only block is not followed by an opencode-only block; add one, or put '${NO_COUNTERPART_MARKER}' as the first line inside the block if OpenCode has no counterpart` });
        }
      }
      openFence = null;
    }
  });
  if (openFence) {
    violations.push({ kind: 'fence_unclosed', detail: `${label}:${openFence.line}: the ${openFence.kind} fence is never closed` });
  }
  if (allHosts) violations.push(...unaccountedHosts(hostBlocks, lines, label));
  return violations;
}

// keepKinds: the fences whose CONTENT survives (markers dropped); every other
// kind's blocks are dropped whole. Line endings are normalized to LF, like every
// other render in agent-distribution.
function render(text, label, keepKinds) {
  const violations = validateFences(text, label);
  if (violations.length) {
    throw new Error(`agent fences invalid in ${label} — refusing to render (P5):\n  ${violations.map((v) => `[${v.kind}] ${v.detail}`).join('\n  ')}`);
  }
  const out = [];
  let inside = null;
  for (const line of splitLines(text)) {
    const marker = classify(line);
    if (noCounterpartHosts(line)) continue;
    if (marker) {
      inside = marker.role === 'open' ? marker.kind : null;
      continue;
    }
    if (inside && !keepKinds.includes(inside)) continue;
    out.push(line);
  }
  return out.join('\n');
}

export function renderClaudeText(text, label) {
  return render(text, label, ['sterling-only', 'claude-only']);
}

export function renderPortableText(text, label) {
  return render(text, label, ['portable-only', 'opencode-only']);
}

/** The Sterling-full OpenCode render: Sterling lines kept, as on Claude, with the OpenCode host's text. */
export function renderOpenCodeFullText(text, label) {
  return render(text, label, ['sterling-only', 'opencode-only']);
}

/** The Antigravity CLI (agy) render: Sterling lines kept, with the agy host's text. */
export function renderAgyText(text, label) {
  return render(text, label, ['sterling-only', 'agy-only']);
}

// What a reader with no Sterling installed cannot act on (the former ruling 'agents-md-is-the-instructions-file-claude-md-is-a-one-line-import' (not in the current store)'s
// rule: a line stays only if such an engineer can follow it). Checked over the
// portable BODY, never the provenance header.
export const PORTABLE_VOCABULARY = [
  { term: 'knowledge_ tool', re: /knowledge_/ },
  { term: 'board_ tool', re: /board_/ },
  { term: 'maintenance_ tool', re: /maintenance_/ },
  { term: 'mcp__ tool name', re: /mcp__/ },
  { term: 'H<n> hook name', re: /\bH\d+\b/ },
  { term: 'Sterling', re: /sterling/i },
  { term: 'knowledge store', re: /knowledge[- ]store|store-write/i },
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
