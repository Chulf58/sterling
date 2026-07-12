// TUI view models (spec §11): pure projections over the durable stores —
// every tab is a live view; nothing here mutates anything.
import { DRAIN_VERBS, RECORD_TYPES } from '@sterling/schemas';
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
}

// ---------------------------------------------------------------------------
// Knowledge category registry (AC3) — the ordered set of knowledge types the
// TUI surfaces. note has its own tab; disconfirmed_hypothesis is niche.
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
}

interface DecisionRec {
  id: string; title: string; statement: string; rationale: string;
  alternatives_rejected: { option: string; reason: string }[];
}

interface AntiPatternRec {
  id: string; title: string; trigger: string; guidance: string;
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

export function toCard(rec: unknown): Card {
  const r = rec as { id: string; type: string };
  switch (r.type) {
    case 'feature_article': {
      const a = rec as FeatureArticleRec;
      return {
        id: a.id,
        type: 'feature_article',
        title: a.title,
        body: `What it does:\n${a.what_it_does}\n\nIntended behaviour:\n${a.intended_behavior}`,
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
        detail: d.title,
      };
    }
    case 'anti_pattern': {
      const ap = rec as AntiPatternRec;
      return {
        id: ap.id,
        type: 'anti_pattern',
        title: ap.title,
        body: `Trigger:\n${ap.trigger}\n\nDon't:\n${ap.wrong_way}\n\nDo:\n${ap.right_way}\n\nGuidance:\n${ap.guidance}`,
        detail: [ap.severity, ap.title].filter(Boolean).join(' · '),
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

/** Records with no file keys (research_finding, note, url/pdf references, empty
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

export function todoCards(store: SterlingStore): Card[] {
  return store
    .query({ types: ['todo'], source: 'user', cap: 200 })
    .map((t) => {
      const todo = t as unknown as { id: string; text: string; priority?: string; file_keys?: string[] };
      return {
        id: todo.id,
        type: 'todo',
        title: todo.text.split('\n')[0],
        body: todo.text,
        detail: [todo.priority && `priority: ${todo.priority}`, todo.file_keys?.length && `files: ${todo.file_keys.join(', ')}`]
          .filter(Boolean)
          .join(' · '),
      };
    });
}

export function queueCards(store: SterlingStore): Card[] {
  return store
    .query({ types: ['todo'], source: 'system', cap: 200 })
    .map((t) => {
      const item = t as unknown as { id: string; text: string; system_reason?: string; file_keys?: string[] };
      return {
        id: item.id,
        type: 'todo',
        title: item.text.split('\n')[0],
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

export function noteCards(store: SterlingStore): Card[] {
  return store.query({ types: ['note'], cap: 200 }).map((n) => {
    const note = n as unknown as { id: string; raw_text: string; captured_at: string; derived: string[] };
    return {
      id: note.id,
      type: 'note',
      title: note.raw_text.split('\n')[0].slice(0, 80),
      body: note.raw_text,
      detail: `captured ${note.captured_at}${note.derived.length ? ` · ${note.derived.length} extraction(s)` : ''}`,
    };
  });
}

export interface RunView {
  id: string;
  machine_state: string;
  phaseLabel: string;
  lastSignal: string;
  warnFlags: number;
  pendingJudgment?: string;
}

export function runView(store: SterlingStore): RunView | undefined {
  const run = store.getRun();
  if (!run) return undefined;
  const idx = run.phases.findIndex((p) => p.status === 'in_progress');
  const signals = run.phases.flatMap((p) => p.signals as { signal?: string }[]);
  const last = signals[signals.length - 1];
  const escalations = run.escalations as { kind?: string; reason?: string; fill_pct?: number }[];
  const judgment = [...escalations].reverse().find((e) => e.kind === 'judgment_needed' || e.kind === 'halt');
  return {
    id: run.id,
    machine_state: run.machine_state,
    phaseLabel: `phase ${idx === -1 ? run.phases.length : idx + 1} of ${run.phases.length}`,
    lastSignal: last?.signal ?? '(none)',
    warnFlags: escalations.filter((e) => e.kind === 'context_warn').length,
    pendingJudgment: judgment?.reason,
  };
}
