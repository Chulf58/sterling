// Shared hook plumbing. Hooks import workspace packages at AUTHOR time; the
// ship step esbuild-bundles them so the runtime is standalone (invariant 4).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeRepoPath, toRepoRelative } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';

/**
 * WHICH LINES an Edit/MultiEdit changed, as merged 1-based [start, end] ranges
 * (board b7269100). PURE — takes the post-edit CONTENT, so the caller owns the
 * file read and this stays unit-testable.
 *
 * Why it exists: a reconcile item said only that a file changed. On a 2717-line
 * file that fires against every article owning the path regardless of whether the
 * changed lines are anywhere near what those articles assert, and a consuming
 * project audited 27 items to find that only FOUR needed a prose change. Naming
 * the lines lets a reader dismiss an irrelevant item in seconds instead of
 * re-reading an article.
 *
 * The material was always there and always discarded: PostToolUse carries the
 * tool_input of the very call that fired the hook, so new_string (or edits[]) is
 * in hand, and locating it in the post-edit file gives the range.
 *
 * APPROXIMATE BY CONSTRUCTION, and that is acceptable for a hint that only has to
 * be good enough to triage: a new_string occurring more than once resolves to the
 * FIRST occurrence, and a Write (whole-file replace) carries no new_string at all
 * so it yields nothing rather than a guess. An empty new_string (a pure deletion)
 * is skipped — indexOf('') is 0 and would report a bogus range at line 1.
 */
export function changedLineRanges(toolInput, content) {
  if (typeof content !== 'string') return [];
  const pieces = [];
  if (typeof toolInput?.new_string === 'string') pieces.push(toolInput.new_string);
  for (const e of Array.isArray(toolInput?.edits) ? toolInput.edits : []) {
    if (typeof e?.new_string === 'string') pieces.push(e.new_string);
  }
  const ranges = [];
  for (const p of pieces) {
    if (!p) continue;
    const idx = content.indexOf(p);
    if (idx === -1) continue; // a later edit moved it; no honest range to report
    const start = content.slice(0, idx).split('\n').length;
    ranges.push([start, start + p.split('\n').length - 1]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    // Adjacent ranges join: "12-14, 15-18" is noise where "12-18" is a fact.
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** "12" for a single line, "12-18" for a span, comma-joined. */
export function formatLineRanges(ranges) {
  return (ranges ?? []).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/**
 * Nearest ancestor of `from` holding .sterling/sterling.db, or null when the walk
 * reaches the filesystem root without finding one (= not a Sterling project, so
 * hooks stay silent — P1, no ceremony outside Sterling repos).
 *
 * Keyed on the DB FILE, deliberately NOT on a bare .sterling DIRECTORY: ~/.sterling
 * exists on every machine (it holds the domain stores + registry.db) and is
 * emphatically not a project root — a walk that stopped at the directory would
 * resolve the entire enforcement surface against a store that isn't there.
 */
export function projectRoot(from) {
  if (!from) return null;
  let dir = resolve(String(from));
  for (;;) {
    if (existsSync(join(dir, '.sterling', 'sterling.db'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root — bounded, never walks forever
    dir = parent;
  }
}

/**
 * Hook stdin, with cwd NORMALIZED TO THE PROJECT ROOT.
 *
 * Every consumer in this layer already treats input.cwd as the project root: it
 * joins .sterling/ onto it (store, config, read-ledger, transient markers, debug
 * scope, delivery guard) and resolves repo-relative tool paths against it. The
 * platform, however, hands the hook the SHELL's working directory, which follows a
 * Bash `cd` — confirmed deterministic 2026-07-27 (board 51b1e2c0): a `cd` into any
 * subdirectory made H3 fail CLOSED on 'no Sterling store' while H7/H9/H13/H15/H16/H19
 * took their no-store branch and went SILENTLY inert, disarming the whole
 * knowledge-duty layer with no throw, no residue and no detector.
 *
 * Normalizing once at this boundary fixes every consumer instead of eleven call
 * sites. When no project is found above, cwd is left EXACTLY as given — absent and
 * unevaluable stay distinct (hooks-suite AC1), so a non-Sterling project is still
 * silently allowed rather than gated against someone else's store.
 */
export function readStdin() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const root = projectRoot(input.cwd);
  if (root) input.cwd = root;
  return input;
}

/** Block: exit 2 with the rule named on stderr (§6 — exit 1 is non-blocking by platform semantics). */
export function deny(message) {
  process.stderr.write(message);
  process.exit(2);
}

export function allow() {
  process.exit(0);
}

/**
 * Standardized wrapper for a gate denial caused by BROKEN INTERNAL STATE (a
 * torn ledger, a corrupt config/store, a missing transient file) rather than
 * by anything the calling agent did (board c7b81456). Motivating incident: a
 * coder burned ~205k tokens diagnosing H3's fail-closed denial over a torn
 * reads-ledger — the denial read exactly like ordinary "you never read it"
 * misconduct, so the agent tried to fix its own behavior (re-reading,
 * re-diagnosing, retrying the gate) instead of exiting blocked and letting
 * the conductor repair the environment.
 *
 * Every blocking gate that denies because it CANNOT EVALUATE (as opposed to
 * evaluating the agent's action and finding a genuine scope/contract
 * violation, which stays exactly as worded — those denials teach a fix the
 * agent can make and typically resolve via contract-violated / tests-invalid,
 * never this helper) routes its message through this ONE wrapper, so the two
 * failure classes are never visually confusable. `detail` carries the gate's
 * ORIGINAL wording verbatim (path, error text, counts) — this only wraps it,
 * it never replaces or trims it, so every existing substring assertion on a
 * wrapped message's detail keeps matching.
 *
 * AUDIENCE-AWARE (review finding F2): H3 and H15 are globally registered, so
 * they fire for the CONDUCTOR too (no `input.agent_id`) — telling the
 * conductor to "exit `blocked` and let the conductor fix the environment" is
 * self-referential nonsense. Passing an `agentId` key in `opts` (even
 * `undefined`) OPTS IN to audience-awareness: present/truthy -> the
 * agent-facing blocked-exit instruction (unchanged wording); absent/falsy ->
 * repair-facing wording that says so explicitly (there is no conductor above
 * the conductor to exit `blocked` to), since there is no one else to hand
 * the defect to. A caller that never had an audience question — every OTHER
 * hook's environmentDefectDenial calls fire only under agent-scoped
 * registration (frontmatter, never the global hooks.json), so `input.agent_id`
 * is always present there — keeps calling this with no third argument at all,
 * and gets EXACTLY the original unconditional agent-facing text: opting a
 * caller in requires naming `agentId`, never an implicit default switch, so
 * this shared-lib change carries zero blast radius into hooks this fixer
 * pass never touched (H4/H5/H14/H18).
 *
 * SELF-HEALING STATES (review finding F1): some broken states heal on the
 * very next successful action (a torn read-evidence ledger is rebuilt by the
 * next appendRead, e.g. after a Read) — "do not retry" is exactly wrong
 * there. `opts.selfHeal = { action, onRepeat }` swaps in `action` (what to do
 * now, which doubles as the repair) followed by `onRepeat` (the repeat
 * condition, e.g. "If this same TORN denial repeats after that Read") whose
 * resolution still varies by audience.
 */
export function environmentDefectDenial(gateName, detail, opts = {}) {
  const audienceAware = 'agentId' in opts;
  const { agentId, selfHeal } = opts;
  const repair = 'repair it (or restart the session) before proceeding';
  const noConductorAbove = `there is no conductor above you to exit \`blocked\` to — ${repair}.`;
  const agentFacing = `Do not diagnose, repair, or retry ${gateName} yourself — exit \`blocked\`, citing this message VERBATIM, and let the conductor fix the environment.`;
  let instruction;
  if (selfHeal) {
    const resolution = !audienceAware || agentId ? 'exit `blocked` citing it.' : noConductorAbove;
    instruction = `${selfHeal.action} ${selfHeal.onRepeat}, ${resolution}`;
  } else if (audienceAware && !agentId) {
    instruction = `This is broken state, and ${noConductorAbove}`;
  } else {
    instruction = agentFacing;
  }
  return `⚠ ENVIRONMENT DEFECT (${gateName}): this denial is about BROKEN STATE, not your conduct. ${detail} ${instruction}`;
}

/** Non-blocking internal failure: loud on stderr, exit 1 (P5: visible, never a silent gate-void). */
export function warnNonBlocking(message) {
  process.stderr.write(message);
  process.exit(1);
}

export function loadConfig(cwd) {
  const p = join(cwd, '.sterling', 'config.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/**
 * Which of the given repo-relative paths git ignores, as a Set (board 1de3653b:
 * an ignored path is never governed territory, so the H19 frontier signal and
 * the H10 article demand must not fire on it — measured at ~20 false
 * firings/session on render output across the 2026-08-14→20 feedback batch).
 *
 * Returns null when git cannot answer (no repo, no git, timeout) — the CALLER
 * owns the degrade, and it must degrade TOWARD signaling (treat nothing as
 * ignored), never toward silence. Exit 0 = some ignored, 1 = none ignored;
 * both are answers. Anything else is a failure.
 */
export function gitIgnored(paths, cwd) {
  const list = (paths ?? []).filter(Boolean);
  if (!list.length) return new Set();
  const res = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
    cwd,
    input: list.join('\0') + '\0',
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.status !== 0 && res.status !== 1) return null;
  return new Set((res.stdout || '').split('\0').filter(Boolean));
}

/** Synchronous sleep for the store busy-retry (no async in a hook body). */
export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Retry a store op past a transient SQLITE_BUSY (the live MCP server can hold a
 * brief lock); a persistent / non-busy throw (corrupt db) propagates — the
 * caller decides the terminal state (blocking gates deny, P5).
 */
export function withRetry(fn) {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      return fn();
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!/SQLITE_BUSY|database is locked|is locked|busy/i.test(msg)) throw e;
      last = e;
      sleepMs(25 * (i + 1));
    }
  }
  throw last;
}

/** Open the project store if the project is Sterling-initialized; null otherwise. */
export function openStore(cwd) {
  const p = join(cwd, '.sterling', 'sterling.db');
  return existsSync(p) ? new SterlingStore(p) : null;
}

/**
 * Repo-relative POSIX form of a tool path (absolute or relative), or null when
 * the path is outside the repository (§3.2 path invariant at the hook boundary).
 */
export function repoRel(toolPath, cwd) {
  if (!toolPath) return null;
  const fwd = String(toolPath).replace(/\\/g, '/');
  try {
    if (/^[A-Za-z]:/.test(fwd) || fwd.startsWith('/')) return toRepoRelative(fwd, cwd);
    return normalizeRepoPath(fwd);
  } catch {
    return null;
  }
}
