// gh-rate-limit.mjs — tell an exhausted GitHub REST rate limit apart from a
// real failure (GitHub issues #278, #294). Store-free on purpose: small bin
// scripts import it without bundling the Sterling store (anti-pattern: a bin
// script importing scripts/lib/project.mjs).

/** True when gh's output says a GitHub rate limit was hit (primary
 * "API rate limit exceeded", or a secondary/abuse limit). */
export function isRateLimitText(text) {
  return /rate limit/i.test(String(text ?? ''));
}

/** Read the core REST budget with `gh api rate_limit` (that endpoint is not
 * counted against the limit). `runGh(args)` runs gh and returns a spawnSync
 * result; `host` is the GitHub host. Returns `{ exhausted, resetMs }` where
 * resetMs is the epoch ms the core budget resets (null when unreadable), or
 * null when gh could not answer (a bad token answers 401). */
export function readCoreRateLimit(runGh, host) {
  const r = runGh(['api', '--hostname', host, 'rate_limit']);
  if (r.error || r.status !== 0) return null;
  try {
    const core = JSON.parse(r.stdout)?.resources?.core;
    if (typeof core?.remaining !== 'number') return null;
    return { exhausted: core.remaining <= 0, resetMs: typeof core.reset === 'number' ? core.reset * 1000 : null };
  } catch {
    return null;
  }
}

/** "at 2026-11-17T21:30:00.000Z (in 12 min)" for a reset time. */
export function describeReset(resetMs, now = Date.now()) {
  const mins = Math.max(0, Math.ceil((resetMs - now) / 60_000));
  return `at ${new Date(resetMs).toISOString()} (in ${mins} min)`;
}
