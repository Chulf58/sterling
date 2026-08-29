// TUI view models (spec §11): pure projections over the durable stores —
// every tab is a live view; nothing here mutates anything.
import { DRAIN_VERBS, RECORD_TYPES, displayHandle } from '@sterling/schemas';
import type { SterlingStore, MountedStores } from '@sterling/store';

export interface Card {
  id: string;
  type: string;
  /** one-line summary shown collapsed (clipped by the state layer) */
  title: string;
  /** full text shown expanded, wrapped by the state layer */
  body: string;
  /** metadata line shown under the expanded body */
  detail: string;
  /** physical store this card came from: 'project' or a domain name */
  source?: string;
  /** indentation depth for grouped rows (objective children sit at 1); absent = 0 */
  depth?: number;
}

// ---------------------------------------------------------------------------
// Knowledge category registry (AC3) — the ordered set of knowledge types the
// TUI surfaces. disconfirmed_hypothesis is niche.
// ---------------------------------------------------------------------------
export const KNOWLEDGE_CATEGORIES: { type: string; label: string }[] = [
  { type: 'feature_article',   label: 'Features' },
  { type: 'decision',          label: 'Decisions' },
  { type: 'anti_pattern',      label: 'Anti-patterns' },
  { type: 'research_finding',  label: 'Research' },
  { type: 'reference_material', label: 'References' },
];

// ---------------------------------------------------------------------------
// toCard: type-dispatched mapper — structured, blank-line-separated bodies.
// ---------------------------------------------------------------------------

interface FeatureArticleRec {
  id: string; slug: string; title: string; state: string;
  what_it_does: string; intended_behavior: string;
  files: { path: string }[];
  dependencies: { relies_on: string[] };
  version: number;
  current_ac?: { ac_id: string; text: string; untestable_because?: { reason: string; blocking_record_id: string } }[];
}

interface DecisionRec {
  id: string; slug?: string; title: string; statement: string; rationale: string;
  alternatives_rejected: { option: string; reason: string }[];
  authority?: string;
}

interface AntiPatternRec {
  id: string; slug?: string; title: string; trigger: string; guidance: string;
  wrong_way: string; right_way: string; severity?: string;
}

interface ResearchFindingRec {
  id: string; question: string; answer: string;
  source_date: string; capture_date: string;
}

interface ReferenceMaterialRec {
  id: string; title: string; kind: string; location: string;
  summary: string; source_date: string; capture_date: string;
}

/** board c6e3561f disclosure-carry: one inbound-superseder entry as surfaced by
 *  knowledge_get / knowledge_query-full / knowledge_preflight — records
 *  elsewhere holding a rel:'supersedes' edge onto this one. */
export interface InboundSupersedesEntryView {
  id: string;
  slug?: string;
  title?: string;
  status: string;
  superseded_by?: string;
}

/**
 * Board c6e3561f part (2): hydrate raw holder records (as returned by
 * SterlingStore.inboundSupersedes / MountedStores.inboundSupersedes) into the
 * {id, slug?, title?, status, superseded_by?} entry shape
 * inboundSupersedesSection reads. Mirrors SterlingTools.inboundSupersedesEntry
 * (packages/mcp-server/src/tools.ts) field-for-field — the TUI has no
 * dependency on @sterling/mcp-server, so the mapping is re-declared here
 * rather than imported. superseded_by rides only when the holder itself is
 * not active, same as the tool-surface original.
 */
export function toInboundSupersedesEntries(records: unknown[]): InboundSupersedesEntryView[] {
  return records.map((rec) => {
    const r = rec as { id: string; slug?: string; title?: string; question?: string; status: string; superseded_by?: string | null };
    const title = r.title ?? r.question ?? r.slug ?? '';
    return {
      id: r.id,
      ...(r.slug ? { slug: r.slug } : {}),
      ...(title ? { title } : {}),
      status: r.status,
      ...(r.status !== 'active' && r.superseded_by ? { superseded_by: r.superseded_by } : {}),
    };
  });
}

/** Gated body section for the `inbound_supersedes` disclosure — matches the
 *  marked-AC section pattern in toCard: absent or empty → '' (no section), so a
 *  record with no inbound superseders renders byte-identical to before. The
 *  field is COMPUTED upstream (the tool read surface); a raw store record that
 *  never carries it simply renders no section. */
function inboundSupersedesSection(rec: unknown): string {
  const entries = (rec as { inbound_supersedes?: InboundSupersedesEntryView[] }).inbound_supersedes;
  if (!entries || entries.length === 0) return '';
  const lines = entries.map((e) => {
    const handle = e.slug ?? e.id.slice(0, 8);
    const via = e.superseded_by ? ` → ${String(e.superseded_by).slice(0, 8)}` : '';
    return `  - ${handle}${e.title ? `: ${e.title}` : ''} [${e.status}${via}]`;
  });
  return `\n\nSuperseded by (inbound):\n${lines.join('\n')}`;
}

export function toCard(rec: unknown): Card {
  const card = baseCard(rec);
  const section = inboundSupersedesSection(rec);
  return section ? { ...card, body: card.body + section } : card;
}

/**
 * Append the `inbound_supersedes` disclosure to an ALREADY-BUILT card — the
 * card-level counterpart of the record-level gate inside toCard, for callers
 * that only learn the entries AFTER the card exists (state.ts hydrates the
 * disclosure at the point a card is known to be RENDERED and EXPANDED, which
 * is downstream of toCard; review finding, lane A2). Empty entries return the
 * card untouched, so a record with no inbound superseders renders
 * byte-identical to before by both routes. The section text is produced by the
 * one builder above, so the two routes can never drift.
 */
export function withInboundSupersedes(card: Card, entries: InboundSupersedesEntryView[]): Card {
  const section = inboundSupersedesSection({ inbound_supersedes: entries });
  return section ? { ...card, body: card.body + section } : card;
}

function baseCard(rec: unknown): Card {
  const r = rec as { id: string; type: string };
  switch (r.type) {
    case 'feature_article': {
      const a = rec as FeatureArticleRec;
      // Gated: an article whose ACs carry no untestable_because renders
      // byte-identical to before (no section at all) — only MARKED ACs ever
      // appear here, never the full current_ac list, so an ordinary article's
      // body is unaffected by this addition (review finding, S4b fixer pass).
      const markedAcLines = (a.current_ac ?? [])
        .filter((ac) => ac.untestable_because)
        .map((ac) => {
          const u = ac.untestable_because!;
          return `  - ${ac.ac_id}: ${ac.text} [untestable: ${u.reason} — blocking ${String(u.blocking_record_id).slice(0, 8)}]`;
        });
      const AC_SECTION_CAP = 12;
      const shownAcLines = markedAcLines.slice(0, AC_SECTION_CAP);
      const acRemainder = markedAcLines.length - shownAcLines.length;
      const acSection = shownAcLines.length
        ? `\n\nAcceptance criteria (untestable):\n${shownAcLines.join('\n')}${
            acRemainder > 0 ? `\n  … +${acRemainder} more (cap ${AC_SECTION_CAP})` : ''
          }`
        : '';
      return {
        id: a.id,
        type: 'feature_article',
        title: a.title,
        body: `What it does:\n${a.what_it_does}\n\nIntended behaviour:\n${a.intended_behavior}${acSection}`,
        detail: `${a.slug} · ${a.state} · v${a.version} · ${a.files.length} file(s) · relies on ${a.dependencies.relies_on.length}`,
      };
    }
    case 'decision': {
      const d = rec as DecisionRec;
      const alts = d.alternatives_rejected.map((alt) => `  - ${alt.option}: ${alt.reason}`).join('\n');
      const altSection = d.alternatives_rejected.length
        ? `\n\nRejected alternatives:\n${alts}`
        : '';
      return {
        id: d.id,
        type: 'decision',
        title: d.title,
        body: `${d.statement}\n\nWhy:\n${d.rationale}${altSection}`,
        detail: [d.authority ? `[${d.authority}]` : '', d.slug, d.title].filter(Boolean).join(' · '),
      };
    }
    case 'anti_pattern': {
      const ap = rec as AntiPatternRec;
      return {
        id: ap.id,
        type: 'anti_pattern',
        title: ap.title,
        body: `Trigger:\n${ap.trigger}\n\nDon't:\n${ap.wrong_way}\n\nDo:\n${ap.right_way}\n\nGuidance:\n${ap.guidance}`,
        detail: [ap.slug, ap.severity, ap.title].filter(Boolean).join(' · '),
      };
    }
    case 'research_finding': {
      const rf = rec as ResearchFindingRec;
      return {
        id: rf.id,
        type: 'research_finding',
        title: rf.question,
        body: `Q: ${rf.question}\n\nA:\n${rf.answer}`,
        detail: `source: ${rf.source_date} · captured: ${rf.capture_date}`,
      };
    }
    case 'reference_material': {
      const rm = rec as ReferenceMaterialRec;
      return {
        id: rm.id,
        type: 'reference_material',
        title: rm.title,
        body: `${rm.summary}\n\nLocation:\n${rm.location}`,
        detail: `${rm.kind} · source: ${rm.source_date}`,
      };
    }
    default:
      return {
        id: r.id,
        type: r.type,
        title: r.type,
        body: JSON.stringify(rec),
        detail: '',
      };
  }
}

// ---------------------------------------------------------------------------
// knowledgeCountBySource: per-source COUNT(*), project first, empty sources
// dropped. The collapsed Knowledge-tree badges read from this — NO record body
// is fetched or parsed (the perf path; full records load only when a source is
// expanded, via MountedStores.querySource). Counts are EXACT, not cap-limited.
// ---------------------------------------------------------------------------
export function knowledgeCountBySource(stores: MountedStores, type: string): { source: string; count: number }[] {
  return stores.countBySource({ types: [type] }).filter((g) => g.count > 0);
}

// ---------------------------------------------------------------------------
// knowledgeSearch: flat, source-tagged, BM25-ranked across ALL categories.
// Uses match_all:true (AND semantics) per AC5.
// ---------------------------------------------------------------------------
export function knowledgeSearch(stores: MountedStores, rankTerms: string[]): Card[] {
  const types = KNOWLEDGE_CATEGORIES.map((c) => c.type);
  const cap = 500;
  const cards: Card[] = [];
  for (const g of stores.bySource({ types, rank_terms: rankTerms, match_all: true, cap })) {
    for (const r of g.records) {
      cards.push({ ...toCard(r), source: g.source });
    }
  }
  return cards;
}

// ---------------------------------------------------------------------------
// Sub-category grouping — the Knowledge tree's 4th level (category → source →
// SUB-CATEGORY → record). Records under an expanded source are bucketed by code
// COMPONENT (derived from their file keys) so a long flat list becomes
// scannable. Pure + testable; computed from the records ALREADY fetched on
// source-expand (no new query — the COUNT-then-fetch perf model is untouched).
// SINGLE-BUCKET: each record lands under its DOMINANT component, so a source's
// COUNT(*) badge equals the sum of its sub-category counts.
// ---------------------------------------------------------------------------

/** Folder key for an owned path: two segments deep where the tree has them
 *  (packages/tui, scripts/hooks), one otherwise (scripts), '(root)' for root
 *  files. Re-implements the pre-P3 groupOf. Grouping AND expand-ids key off this
 *  RAW folder key — prettifying before grouping could merge distinct components
 *  and collide expand-ids. */
export function subgroupKey(path: string): string {
  const seg = path.split('/');
  if (seg.length >= 3) return seg.slice(0, 2).join('/');
  if (seg.length === 2) return seg[0];
  return '(root)';
}

/** Records with no file keys (research_finding, url/pdf references, empty
 *  articles) cluster here; the state layer SKIPS the sub-category level when a
 *  source resolves to only this one bucket (collapse-single-bucket, P1). */
export const SUBCAT_GENERAL = '(general)';

/** Friendly DISPLAY labels for the common raw folder keys — display only;
 *  grouping/expand-ids always use the raw key. Unmapped keys fall back to the
 *  raw key (never a silent 'Other'); '(general)'/'(root)' show verbatim. The
 *  key order here is also the tree's sub-category display order. */
const SUBCAT_LABELS: Record<string, string> = {
  'packages/tui': 'TUI',
  'packages/store': 'Store',
  'packages/mcp-server': 'MCP server',
  'packages/schemas': 'Schemas',
  'scripts/hooks': 'Hooks',
  'scripts/adapters': 'Adapters',
  'scripts/lib': 'Script lib',
  'scripts/tests': 'Script tests',
  scripts: 'Scripts',
  'agent-templates': 'Agent templates',
  skills: 'Skills',
  templates: 'Templates',
  docs: 'Docs',
};

export function subcatLabel(key: string): string {
  return SUBCAT_LABELS[key] ?? key;
}

/** Raw folder key of a record's DOMINANT component: the key owning the most of
 *  its file paths, ties broken LEXICOGRAPHICALLY on the key (never by the
 *  author-controlled files[] order, so the tree is stable frame-to-frame). No
 *  file keys → SUBCAT_GENERAL. */
export function subcategoryOf(record: unknown): string {
  const r = record as { type: string };
  const extract = RECORD_TYPES[r.type]?.fileKeys;
  const paths = extract ? extract(record as Record<string, unknown>) : [];
  if (!paths.length) return SUBCAT_GENERAL;
  const counts = new Map<string, number>();
  for (const p of paths) {
    const k = subgroupKey(p);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = '';
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN || (n === bestN && k < best)) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/** Group raw records into ordered sub-category buckets (single-bucket: each
 *  record under its dominant component). Order: SUBCAT_LABELS registry order
 *  first, then any other raw keys lexicographically, with SUBCAT_GENERAL last.
 *  Empty buckets are dropped. Cards are mapped via toCard so the state layer
 *  renders them directly (it adds Card.source). */
export function knowledgeSubgroups(records: unknown[]): { key: string; label: string; cards: Card[] }[] {
  const buckets = new Map<string, Card[]>();
  for (const r of records) {
    const key = subcategoryOf(r);
    const list = buckets.get(key) ?? [];
    list.push(toCard(r));
    buckets.set(key, list);
  }
  const order = Object.keys(SUBCAT_LABELS);
  const sortKey = (k: string): string => {
    if (k === SUBCAT_GENERAL) return '2';
    const i = order.indexOf(k);
    return i === -1 ? `1${k}` : `0${String(i).padStart(4, '0')}`;
  };
  return [...buckets.entries()]
    .sort((a, b) => (sortKey(a[0]) < sortKey(b[0]) ? -1 : sortKey(a[0]) > sortKey(b[0]) ? 1 : 0))
    .map(([key, cards]) => ({ key, label: subcatLabel(key), cards }));
}

/**
 * Tasks-tab cards. Items sharing an `objective` (decision a8d2ce6c) collapse
 * under one `obj:<name>` header entry — children are emitted only when the
 * header id is in `expanded` (the same fold mechanism the Knowledge tree
 * uses), so the board reads as N objectives, not N×slices. Standalone items
 * stay flat cards. A group with zero open members never renders (its items
 * were removed, so the map never sees the name).
 *
 * CAP 500 (user-raised 2026-08-27 from 200). It bounds the LISTING, not the
 * Tasks tab's count, which is an uncapped COUNT(*) — so a board above 500 shows
 * a number larger than the rows listed, and the tail is silently absent rather
 * than truncated-with-a-notice.
 *
 * THE COST IS THE CAP, because the fold does not reduce it: the loop below
 * builds a full Card for EVERY fetched row, and `expanded` is consulted only at
 * row-EMISSION time. Collapsing an objective hides rows; it never skips
 * construction. Dominant work is O(total text bytes) twice over — store.query
 * JSON.parses all 500 record bodies, then `text.split('\n')` materialises each
 * whole text as substrings to keep only the first line. `body` is a reference,
 * not a copy, and nothing is memoised: the array is rebuilt per call.
 *
 * BUDGET AGAINST THE EVENT PATH, NOT THE 1 Hz TICK — the tick is the CHEAPEST
 * consumer at one call/s. A single keypress reaches this ~3× (reduce, then
 * revealAt→buildSelf, then main.ts's redraw), and held key-repeat can reach
 * ~90 calls/s. Reviewed 2026-08-27: at 500 items and this repo's text sizes
 * (1.4k–9.2k chars) that is comfortably safe for the tick and for discrete
 * keypresses, and NOT comfortably safe for sustained key-repeat scrolling.
 * Those figures are ESTIMATED from allocation volume, not measured.
 *
 * IF IT EVER NEEDS RAISING AGAIN, in this order — the cheap wins first, and
 * count-then-fetch is NOT the first fix: (1) memoise the projection per
 * (store-version, expanded) so one input event projects once instead of ~3×;
 * (2) replace the split with an indexOf('\n') slice; both keep this shape and
 * move the ceiling several-fold. Only past roughly 1,500–2,000 items on this
 * text profile does the Knowledge tree's count-then-fetch-per-source pattern
 * (decision 5f8419c5) become genuinely required.
 */
export function todoCards(store: SterlingStore, expanded: string[] = []): Card[] {
  const groups = new Map<string, Card[]>();
  const flat: Card[] = [];
  for (const t of store.query({ types: ['todo'], source: 'user', cap: 500 })) {
    const todo = t as unknown as { id: string; text: string; slug?: string; priority?: string; file_keys?: string[]; objective?: string };
    const card: Card = {
      id: todo.id,
      type: 'todo',
      // `name (id8)` where a handle EXISTS (decision 2e8c30e4) — the row a
      // reader scans leads with the name and keeps a citable id. Where none was
      // minted nothing is composed: a legacy item keeps its bare text line
      // rather than gaining a hex fragment dressed as a name (df361a0f).
      // The card `id` stays the FULL uuid — the id8 is a display abbreviation,
      // and selection effects plus every destroying call need the whole thing.
      title: todo.slug ? displayHandle(todo.slug, todo.id) : todo.text.split('\n')[0],
      body: todo.text,
      detail: [todo.priority && `priority: ${todo.priority}`, todo.file_keys?.length && `files: ${todo.file_keys.join(', ')}`]
        .filter(Boolean)
        .join(' · '),
    };
    if (todo.objective) {
      const list = groups.get(todo.objective) ?? [];
      list.push(card);
      groups.set(todo.objective, list);
    } else {
      flat.push(card);
    }
  }
  const out: Card[] = [];
  for (const [name, cards] of groups) {
    const id = `obj:${name}`;
    const open = expanded.includes(id);
    out.push({
      id,
      type: 'objective',
      title: `${open ? '▾' : '▸'} ${name} (${cards.length} open)`,
      body: `${cards.length} open task${cards.length === 1 ? '' : 's'} under this objective`,
      detail: 'objective',
    });
    if (open) out.push(...cards.map((c) => ({ ...c, depth: 1 })));
  }
  out.push(...flat);
  return out;
}

export function queueCards(store: SterlingStore): Card[] {
  return store
    .query({ types: ['todo'], source: 'system', cap: 200 })
    .map((t) => {
      const item = t as unknown as { id: string; text: string; slug?: string; system_reason?: string; file_keys?: string[] };
      return {
        id: item.id,
        type: 'todo',
        // Same rule as the board rows above: compose only where a handle exists.
        title: item.slug ? displayHandle(item.slug, item.id) : item.text.split('\n')[0],
        body: item.text,
        detail: [item.system_reason, item.file_keys?.length && `files: ${item.file_keys.join(', ')}`].filter(Boolean).join(' · '),
      };
    });
}

/** Completed-section lines (§3.2.7 drain log / §11 format): `HH:mm <action> · <target>`
 *  (MM-dd HH:mm when older than today). The verb derives from system_reason via
 *  DRAIN_VERBS (draining = the fulfilling artifact was written); the target is
 *  the quoted name in the item text, else the first file key (+N). Ordering is
 *  the log's seq (newest first) — the stamp is cosmetic, never a sort key.
 *  Log lines, not records. */
export function completedQueueLines(store: SterlingStore, now: () => Date = () => new Date()): string[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = now();
  return store.listQueueDrain(15).map((e) => {
    const at = new Date(e.drained_at);
    const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
    const stamp = `${sameDay ? '' : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} `}${pad(at.getHours())}:${pad(at.getMinutes())}`;
    const verb = (DRAIN_VERBS as Record<string, string>)[e.system_reason] ?? e.system_reason; // unknown lanes stay visible, never blank
    const quoted = e.text.match(/'([^']+)'/);
    const target = quoted
      ? quoted[1]
      : e.file_keys.length
        ? `${e.file_keys[0]}${e.file_keys.length > 1 ? ` (+${e.file_keys.length - 1})` : ''}`
        : e.text.split('\n')[0];
    return `${stamp} ${verb} · ${target}`;
  });
}

/** Activity-section lines (board 39d6462d, §11 format): `HH:mm <verb> · <target>`
 *  (MM-dd HH:mm when older than today) — the same stamp convention as
 *  completedQueueLines, over the store's activity_log instead of the drain
 *  log. verb/target are already the plain human-readable values logActivity
 *  wrote (no DRAIN_VERBS translation needed here). Ordering is the log's seq
 *  (newest first) — the stamp is cosmetic, never a sort key. Log lines, not
 *  records: never selectable, mirroring the completed section exactly. */
export function activityLines(store: SterlingStore, now: () => Date = () => new Date()): string[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = now();
  return store.listActivityLog(15).map((e) => {
    const at = new Date(e.at);
    const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
    const stamp = `${sameDay ? '' : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} `}${pad(at.getHours())}:${pad(at.getMinutes())}`;
    return `${stamp} ${e.verb} · ${e.title}`;
  });
}

