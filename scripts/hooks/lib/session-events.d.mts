// Type declarations for the parts of session-events.mjs that TypeScript packages
// import statically (packages/mcp-server/src/tools.ts, the no_capture,
// concept_designed and capture_pending writers).
export const SESSION_EVENTS_REL: string;
export const SESSION_EVENTS_LOCK_HELD: 'session_events_lock_held';

export interface SessionEventsLockOptions {
  timeoutMs?: number;
}

export function appendSessionEventsAt(eventsPath: string, newEvents: unknown[], lockOptions?: SessionEventsLockOptions): void;
export function withSessionEventsLock<T>(path: string, fn: () => T, options?: SessionEventsLockOptions): T;
