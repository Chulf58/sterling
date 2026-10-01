// The plugin root for hooks that READ FILES SHIPPED IN THE PLUGIN (H1's version
// and agent registry, H10's shared context-window table): the dir holding
// .claude-plugin/plugin.json, found by a bounded walk-up. Moved here from
// h1-session-start.mjs so H10 shares the one copy; H15's fail-closed resolver
// is the separate lib/plugin-root.mjs.
//
// `moduleUrl` is the RUNNING hook's own import.meta.url, passed in so the walk
// starts from scripts/hooks/ (source, tests) or hooks/ (bundle) exactly as it
// did when the function lived in H1.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The plugin root — the dir holding .claude-plugin/plugin.json — by a bounded
 *  walk-up that works from scripts/hooks/ (source, tests) and hooks/ (bundle).
 *
 *  WALK-UP FIRST; THE ENV SEAM IS CONSULTED ONLY WHEN THE WALK-UP FINDS NO
 *  PLUGIN TREE (decision foreign_95c2c109 F2's shape, extended from H15 to H1 by board
 *  fb7c43fb N-3). This ordering is the security property, not a preference:
 *  every consumer of this root READS CODE from it (plugin.json, the agent
 *  template registry), RESOLVES THE SERVER against it, and — sharpest —
 *  SPAWNS GIT WITH cwd INSIDE IT, so an env-first value would let anything able
 *  to set this process's environment redirect all three at session start, and a
 *  planted `.git/config` in the named tree (core.fsmonitor, an `ext::` remote
 *  url) is CODE EXECUTION on that git spawn. STERLING_PLUGIN_ROOT survives as
 *  the TEST SEAM it was always documented to be: reachable only from a spawn
 *  location with no plugin tree above it (the bundle-into-a-temp-dir shape of
 *  scripts/tests/lib/seam-hook.mjs). Wherever a real plugin tree sits above the
 *  running hook — everywhere in production — the variable is INERT. */
export function pluginRoot(moduleUrl) {
  const walked = walkUpPluginRoot(moduleUrl);
  if (walked) return walked;
  return process.env.STERLING_PLUGIN_ROOT || null;
}

/** The walk-up alone — never the env seam, not even as a last resort. Used
 *  where the root is about to be PRINTED AS A COMMAND (the receipt remedy
 *  in H1): an env-supplied value is agent-influenceable under the threat model
 *  decision foreign_95c2c109 F2 closed in H15, so the paste-ready line must come from
 *  the running hook's own location only, and an unresolvable walk-up prints the
 *  placeholder rather than falling back to anything. */
export function walkUpPluginRoot(moduleUrl) {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}
