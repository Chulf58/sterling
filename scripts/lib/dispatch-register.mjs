// In-flight dispatch register — the SCRIPT-SIDE read (board 54c451b4, decision
// ec9eacaa). The register itself is owned by the H22 hook (written on
// SubagentStart, removed on SubagentStop, deleted by H1 at SessionStart);
// scripts consult it so "N writers in flight" is a disclosed fact instead of
// conductor memory before trusting a regeneration or a bundle rebuild.
//
// BEST-EFFORT by design: a script has no session_id, so it cannot tell this
// session's dispatches from a concurrent sibling session's — it applies only
// the same staleness TTL H10 uses (config dispatch_register.stale_minutes,
// default 60). Consumers are ADVISORY-ONLY: they print, they never gate — a
// missing or corrupt register reads as empty, never a throw (the h22 posture).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The same TTL read as liveDispatches(), but keeping the two NEGATIVE cases
 * apart: a register that is genuinely ABSENT (nothing was ever dispatched —
 * confirmed zero) versus one that EXISTS but cannot be read (corrupt JSON, or
 * a shape that is not the register's array) — which is UNKNOWN, not zero.
 * Returns {status:'ok'|'unknown', entries} — the null-vs-empty convention the
 * observed-territory lib already uses. Added for the rotation note (board
 * efbddf09): a note that silently claims "nothing was running" because the
 * register was unreadable is exactly the false all-clear that cost ~330k
 * tokens on 2026-09-04, so the writer needs the distinction the advisory
 * consumers deliberately collapse.
 */
export function liveDispatchesOrUnknown(root) {
  const path = join(root, '.sterling', 'transient', 'dispatch-register.json');
  if (!existsSync(path)) return { status: 'ok', entries: [] };
  let entries;
  try {
    entries = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { status: 'unknown', entries: [] };
  }
  if (!Array.isArray(entries)) return { status: 'unknown', entries: [] };
  return { status: 'ok', entries: filterLive(root, entries) };
}

/** Advisory read: both negative cases degrade to empty (the h22 posture). */
export function liveDispatches(root) {
  return liveDispatchesOrUnknown(root).entries;
}

function filterLive(root, entries) {
  let staleMinutes = 60;
  try {
    const cfg = JSON.parse(readFileSync(join(root, '.sterling', 'config.json'), 'utf8'));
    if (Number.isInteger(cfg?.dispatch_register?.stale_minutes) && cfg.dispatch_register.stale_minutes > 0) {
      staleMinutes = cfg.dispatch_register.stale_minutes;
    }
  } catch {
    // no config or unreadable — the shipped default stands
  }
  const now = Date.now();
  return entries.filter((e) => {
    const age = now - Date.parse(e?.at ?? '');
    return Number.isFinite(age) && age >= 0 && age < staleMinutes * 60_000;
  });
}

/** One advisory line, or null when nothing is in flight. */
export function inFlightAdvisory(root, consequence) {
  const live = liveDispatches(root);
  if (!live.length) return null;
  const agents = [...new Set(live.map((e) => `${e.agent_type ?? 'agent'}:${e.agent_id ?? '?'}`))].join(', ');
  return `${live.length} dispatch(es) in flight (dispatch-register: ${agents}) — ${consequence}`;
}
