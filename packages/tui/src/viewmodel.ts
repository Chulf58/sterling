// TUI view models (spec §11): pure projections over the durable stores —
// every tab is a live view; nothing here mutates anything.
import { DRAIN_VERBS } from '@sterling/schemas';
import type { SterlingStore } from '@sterling/store';

export interface Card {
  id: string;
  type: string;
  /** one-line summary shown collapsed (clipped by the state layer) */
  title: string;
  /** full text shown expanded, wrapped by the state layer */
  body: string;
  /** metadata line shown under the expanded body */
  detail: string;
  /** folder keys this card files under (articles: derived from owned paths) */
  groups?: string[];
}

export function todoCards(store: SterlingStore): Card[] {
  return store
    .query({ types: ['todo'], cap: 200 })
    .filter((t) => (t as { source: string }).source === 'user')
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
    .query({ types: ['todo'], cap: 200 })
    .filter((t) => (t as { source: string }).source === 'system')
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

/** Folder key for an owned path: two segments deep where the tree has them
 *  (packages/store, scripts/hooks), one otherwise; root files group as (root). */
const groupOf = (path: string): string => {
  const seg = path.split('/');
  if (seg.length >= 3) return seg.slice(0, 2).join('/');
  if (seg.length === 2) return seg[0];
  return '(root)';
};

interface ArticleRecord {
  id: string;
  slug: string;
  title: string;
  state: string;
  what_it_does: string;
  intended_behavior: string;
  files: { path: string }[];
  dependencies: { relies_on: string[] };
  version: number;
}

const toArticleCard = (a: unknown): Card => {
  const art = a as ArticleRecord;
  return {
    id: art.id,
    type: 'feature_article',
    title: art.title,
    body: `${art.what_it_does}\n\n→ intended: ${art.intended_behavior}`,
    detail: `${art.slug} · ${art.state} · v${art.version} · ${art.files.length} file(s) · relies on ${art.dependencies.relies_on.length}`,
    groups: [...new Set(art.files.map((f) => groupOf(f.path)))],
  };
};

export function articleCards(store: SterlingStore): Card[] {
  return store.query({ types: ['feature_article'], cap: 200 }).map(toArticleCard);
}

/** FTS search over articles via the same §3.4 rank machinery agents use. */
export function articleSearch(store: SterlingStore, rankTerms: string[]): Card[] {
  return store.query({ types: ['feature_article'], rank_terms: rankTerms, cap: 200 }).map(toArticleCard);
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
