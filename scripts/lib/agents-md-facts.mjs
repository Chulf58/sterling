// The two AGENTS.md project-facts lines that follow a project's stack tags: "Stack tags" and
// "Domain stores" (templates/target-agents-md.md). init renders them when it creates AGENTS.md;
// refreshAgentsMdFacts rewrites them in an existing AGENTS.md after the tags change (GitHub #158).
//
// Refresh boundary: AGENTS.md is project-editable and carries no markers, so a line is rewritten
// only when its value still has a shape init itself rendered (any template revision, any tag
// list). A line with prose, markup or anything else init never wrote is the project's and is
// kept; so is a duplicated line. Each kept line is returned with its reason so the caller can
// warn (P5). A line that is not there at all is never added: the project removed it or never had
// it, so it is listed in `absent` for the report and is not a warning. What this does NOT guarantee: a hand edit that itself looks like a
// generated value (a plain tag list) cannot be told apart and is brought back in line with
// .sterling/config.json, which is the authority for both lines. A domain path is recognised with
// spaces or punctuation only while config.domain_paths still holds it; one removed from config
// since the line was rendered must be whitespace- and markup-free to count as generated.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const STACK_TAGS_LABEL = '- Stack tags (= domain mount manifest): ';
export const DOMAINS_LABEL = '- Domain stores (one shared store per stack tag): ';

const DOMAINS_SUFFIX = ' — each created by init with a description of what belongs in it (§2.3)';
const DOMAINS_NONE = '(none — declare stack tags to mount domain stores)';
// Earlier init revisions rendered the Domain stores line with these; they are still generated.
const HISTORICAL_DOMAINS_SUFFIXES = [DOMAINS_SUFFIX, ' — created lazily on first need (§2.3)'];
const HISTORICAL_DOMAINS_NONE = [DOMAINS_NONE, '(none mounted yet — created lazily on first need)'];

export const renderStackTags = (stackTags) => stackTags.join(', ');
export const renderDomains = (stackTags, domainPaths = {}) => (stackTags.length
  ? stackTags.map((t) => domainPaths[t] ?? `~/.sterling/domains/${t}/`).join(', ') + DOMAINS_SUFFIX
  : DOMAINS_NONE);

// One generated entry: a tag or a path, never whitespace, a comma or Markdown markup.
const ENTRY = /^[^\s,`*[\]()<>]+$/;
const isEntryList = (value) => value.length > 0 && value.split(', ').every((e) => ENTRY.test(e));
const isGeneratedStackTags = (value) => value === '' || isEntryList(value);
// A Domain stores entry is a default path (no whitespace or markup) or, verbatim, a path from
// config.domain_paths, which init renders as written, spaces and punctuation included. The list
// is parsed entry by entry so a configured path holding ', ' still matches as one entry.
// Memoized by position, so each suffix is judged once even when a configured path also has the
// default shape and both branches reach the same position.
function isDomainEntryList(value, configuredPaths) {
  const memo = new Map();
  const from = (pos) => {
    if (!memo.has(pos)) memo.set(pos, judge(pos));
    return memo.get(pos);
  };
  const judge = (pos) => {
    for (const p of configuredPaths) {
      if (!p || !value.startsWith(p, pos)) continue;
      const end = pos + p.length;
      if (end === value.length || (value.startsWith(', ', end) && from(end + 2))) return true;
    }
    const comma = value.indexOf(', ', pos);
    const entry = value.slice(pos, comma === -1 ? undefined : comma);
    if (!ENTRY.test(entry)) return false;
    return comma === -1 || from(comma + 2);
  };
  return value.length > 0 && from(0);
}
const isGeneratedDomains = (value, configuredPaths) => HISTORICAL_DOMAINS_NONE.includes(value)
  || HISTORICAL_DOMAINS_SUFFIXES.some((s) => value.endsWith(s) && isDomainEntryList(value.slice(0, -s.length), configuredPaths));

// Returns { text, refreshed: [name], kept: [{ name, reason }], absent: [name] }. `text` keeps every other byte,
// line endings included.
export function refreshAgentsMdFacts(text, { stackTags, domainPaths = {} }) {
  const lines = [];
  const re = /\r\n|\n/g;
  let start = 0;
  let m;
  while ((m = re.exec(text))) {
    lines.push({ content: text.slice(start, m.index), eol: m[0] });
    start = re.lastIndex;
  }
  lines.push({ content: text.slice(start), eol: '' });

  const refreshed = [];
  const kept = [];
  const absent = [];
  const facts = [
    { name: 'Stack tags', label: STACK_TAGS_LABEL, want: renderStackTags(stackTags), generated: isGeneratedStackTags },
    { name: 'Domain stores', label: DOMAINS_LABEL, want: renderDomains(stackTags, domainPaths), generated: (v) => isGeneratedDomains(v, Object.values(domainPaths)) },
  ];
  for (const f of facts) {
    const hits = lines.filter((l) => l.content.startsWith(f.label));
    if (!hits.length) {
      absent.push(f.name);
      continue;
    }
    if (hits.length > 1) {
      kept.push({ name: f.name, reason: `the line appears ${hits.length} times` });
      continue;
    }
    const value = hits[0].content.slice(f.label.length);
    if (value === f.want) continue;
    if (!f.generated(value)) {
      kept.push({ name: f.name, reason: 'the line was edited by hand' });
      continue;
    }
    hits[0].content = f.label + f.want;
    refreshed.push(f.name);
  }
  return { text: lines.map((l) => l.content + l.eol).join(''), refreshed, kept, absent };
}

// The "Knowledge" section (templates/target-agents-md.md): which way it reads depends on the
// handoff setting. With handoff on, architecture.md and rulings.md exist, so the section points
// at them; with it off nothing is projected and the section points at the Sterling store instead
// (GitHub #218). The template carries the projection variant; init swaps in the store variant
// when handoff is off, and refreshAgentsMdKnowledge flips an existing section either way.
// Refresh boundary: a section is rewritten only when its heading and body are exactly one of the
// two shipped variants; anything else is the project's and is kept, with a reason.
export const KNOWLEDGE_VARIANTS = {
  projected: {
    heading: '## Knowledge (generated projections)',
    body: '- **The knowledge base is projected into the repo.** `architecture.md` says what each area does and which files it owns; `rulings.md` lists every decision and anti-pattern that governs the code. Read the entries for an area before touching it. Both are generated by the Sterling operator and never hand-edited; if you find them wrong, say so in your commit message rather than editing them.',
  },
  store: {
    heading: '## Knowledge',
    body: '- **The knowledge base is the Sterling store.** Read it through the Sterling MCP tools before touching an area: `knowledge_query` finds the records for the area, `knowledge_get` reads one record in full.',
  },
};
const renderKnowledge = (v) => `${v.heading}\n\n${v.body}`;

// Applies the store variant to a freshly rendered template (which carries the projected one).
export const renderKnowledgeSection = (templateText, projected) => (projected
  ? templateText
  : templateText.replace(renderKnowledge(KNOWLEDGE_VARIANTS.projected), renderKnowledge(KNOWLEDGE_VARIANTS.store)));

// Returns { text, refreshed, kept: reason|null, absent }. `projected` is whether the handoff
// projection is on (or the project is the Sterling clone, which has its own projections).
export function refreshAgentsMdKnowledge(text, projected) {
  const lines = [];
  const re = /\r\n|\n/g;
  let start = 0;
  let m;
  while ((m = re.exec(text))) {
    lines.push({ content: text.slice(start, m.index), eol: m[0] });
    start = re.lastIndex;
  }
  lines.push({ content: text.slice(start), eol: '' });

  const headings = Object.values(KNOWLEDGE_VARIANTS).map((v) => v.heading);
  const at = lines.map((l, i) => (headings.includes(l.content) ? i : -1)).filter((i) => i !== -1);
  if (!at.length) return { text, refreshed: false, kept: null, absent: true };
  if (at.length > 1) return { text, refreshed: false, kept: 'the heading appears more than once', absent: false };
  const h = at[0];
  let end = lines.findIndex((l, i) => i > h && l.content.startsWith('## '));
  if (end === -1) end = lines.length;
  const body = lines.slice(h + 1, end).map((l) => l.content);
  while (body.length && body[0] === '') body.shift();
  while (body.length && body[body.length - 1] === '') body.pop();

  const want = KNOWLEDGE_VARIANTS[projected ? 'projected' : 'store'];
  const current = Object.values(KNOWLEDGE_VARIANTS).find((v) => v.heading === lines[h].content);
  if (current === want && body.length === 1 && body[0] === want.body) return { text, refreshed: false, kept: null, absent: false };
  const shipped = Object.values(KNOWLEDGE_VARIANTS).some((v) => v.heading === lines[h].content && body.length === 1 && body[0] === v.body);
  if (!shipped) return { text, refreshed: false, kept: 'the section was edited by hand', absent: false };

  const eol = lines[h].eol || '\n';
  const lastBody = lines.slice(h + 1, end).reduce((last, l, i) => (l.content === '' ? last : h + 1 + i), h);
  lines.splice(h, lastBody - h + 1, { content: want.heading, eol }, { content: '', eol }, { content: want.body, eol: lines[lastBody].eol });
  return { text: lines.map((l) => l.content + l.eol).join(''), refreshed: true, kept: null, absent: false };
}

// Refreshes the Knowledge section of the AGENTS.md at `path`, if there is one. Returns the
// refreshAgentsMdKnowledge result, or null when the file is absent.
export function refreshAgentsMdKnowledgeFile(path, projected) {
  if (!existsSync(path)) return null;
  const r = refreshAgentsMdKnowledge(readFileSync(path, 'utf8'), projected);
  if (r.refreshed) writeFileSync(path, r.text);
  return r;
}

// One sentence for a report: which lines were rewritten and which were left, with the fix.
export function describeAgentsMdRefresh({ refreshed, kept }, { stackTags, domainPaths = {} }) {
  const parts = [];
  const lineNames = refreshed.filter((n) => n !== 'Knowledge section');
  if (lineNames.length) parts.push(`rewrote the ${lineNames.join(' and ')} line${lineNames.length > 1 ? 's' : ''} from .sterling/config.json`);
  if (refreshed.includes('Knowledge section')) parts.push('rewrote the Knowledge section to match the handoff setting');
  for (const k of kept) {
    if (k.name === 'Knowledge section') {
      parts.push(`left the Knowledge section alone (${k.reason}); with handoff files on it points at architecture.md and rulings.md, with them off at the Sterling store`);
      continue;
    }
    const want = k.name === 'Stack tags' ? renderStackTags(stackTags) : renderDomains(stackTags, domainPaths);
    parts.push(`left the ${k.name} line alone (${k.reason}); config says: ${want}`);
  }
  return parts.join('; ');
}
