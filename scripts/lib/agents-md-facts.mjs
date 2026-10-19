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

// One sentence for a report: which lines were rewritten and which were left, with the fix.
export function describeAgentsMdRefresh({ refreshed, kept }, { stackTags, domainPaths = {} }) {
  const parts = [];
  if (refreshed.length) parts.push(`rewrote the ${refreshed.join(' and ')} line${refreshed.length > 1 ? 's' : ''} from .sterling/config.json`);
  for (const k of kept) {
    const want = k.name === 'Stack tags' ? renderStackTags(stackTags) : renderDomains(stackTags, domainPaths);
    parts.push(`left the ${k.name} line alone (${k.reason}); config says: ${want}`);
  }
  return parts.join('; ');
}
