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

export function liveDispatches(root) {
  const path = join(root, '.sterling', 'transient', 'dispatch-register.json');
  if (!existsSync(path)) return [];
  let entries;
  try {
    entries = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
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
