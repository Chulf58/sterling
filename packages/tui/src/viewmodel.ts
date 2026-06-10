// TUI view models (spec §11): pure projections over the durable stores —
// every tab is a live view; nothing here mutates anything.
import type { SterlingStore } from '@sterling/store';

export interface Card {
  id: string;
  type: string;
  title: string;
  detail: string;
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
        title: todo.text,
        detail: [todo.priority && `priority: ${todo.priority}`, todo.file_keys?.length && `files: ${todo.file_keys.join(', ')}`]
          .filter(Boolean)
          .join(' · '),
      };
    });
}

export function noteCards(store: SterlingStore): Card[] {
  return store.query({ types: ['note'], cap: 200 }).map((n) => {
    const note = n as unknown as { id: string; raw_text: string; captured_at: string; derived: string[] };
    return {
      id: note.id,
      type: 'note',
      title: note.raw_text.split('\n')[0].slice(0, 80),
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
