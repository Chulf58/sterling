// H1 — conventions + banner (spec §6 H1). SessionStart, non-blocking.
// Conventions go to Claude as additionalContext; board/maintenance counts go
// to the human as systemMessage — the queue is event-drained and otherwise
// invisible; this is its visibility pressure. Banner art goes to stderr
// (adjudicated 2026-06-12): a SessionStart hook sees no CLI flags or pipe
// state, so suppression is env-only (STERLING_NO_BANNER=1).
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdin, allow, exitAfterWrite, openStore, loadConfig } from './lib/common.mjs';
// Plan-lock primitives — ONE implementation, shared with h31-plan-lock.mjs,
// h19-dispatch-staging.mjs and scripts/plan-lock.mjs. Aliased on import so the
// PLAN LOCK section's names read locally while the definitions stay shared.
import {
  PATH_MAX as PLAN_LOCK_PATH_MAX,
  REASON_MAX as PLAN_LOCK_REASON_MAX,
  TITLE_MAX as PLAN_LOCK_TITLE_MAX,
  claimMarker as claimPlanLockMarker,
  computeStatus as computePlanStatus,
  readLock as readPlanLock,
  sanitizeForContext as planLockClean,
} from './lib/plan-lock.mjs';
import { probeDirtyPaths, formatResidueLine } from './lib/dispatch-residue.mjs';
import { withRegisterLock, readRegister, registerPath, sessionBoundarySweep } from '../lib/dispatch-register.mjs';
import { disclosure, render } from '../lib/review-errors.mjs';
import { renderUnavailable } from './lib/undeclared-source.mjs';
import { computeUndeclaredSourceDisclosure } from './lib/undeclared-source-scan.mjs';
import { ProjectRegistry, registryPath } from '@sterling/store';
import { buildIdPath, runtimeMarkerPath, runtimeMarkerSchema, stalenessVerdict } from '@sterling/schemas';
import { parseInstalledHeader, extractBakedCommandPaths, isLocallyModified, loadRegistry, sha256 } from '../lib/agent-distribution.mjs';
import { gitTouches, writeInitialGitSettled } from './lib/settlement.mjs';

// IN-FLIGHT DISPATCH REGISTER DELETION — COOPERATING WRITER (decision
// register-writers-cooperating-lock, 1e0ba0d0). H1 is a register writer like
// H22's Start/Stop/prune and H10's residue stamp, so its unconditional
// session-boundary delete takes the SAME mkdir-mutex lock rather than a
// blind rmSync race against a concurrent H22/H10 fire. TIMEOUT POSTURE
// DIFFERS FROM H22/H10's skip-loud: on timeout this WARNS and LEAVES THE
// REGISTER INTACT — never blindly deletes the lock directory itself, and
// never deletes the register unlocked either — because the next locked H22
// fire prunes this (by now foreign-session) register's entries anyway, so
// over-deferral here is bounded exactly the way the decision describes.
// R1 CONTRACT NOTE (reported, not silently resolved): the sheet's A11 says H1
// should WRITE `[]` under the lock rather than deleting the register, so a
// corrupt-vs-absent distinction stays meaningful for later readers this
// session. The FROZEN pins in scripts/tests/h22-dispatch-register.test.mjs
// ("H1 (source=startup/resume): ... is deleted") assert the file is GONE
// (existsSync === false) after H1 runs, which a `[]`-write would fail (the
// file would still exist). Frozen tests win: deletion is kept, unchanged in
// substance from before this rebuild — only the LOCK primitive moves to the
// owner module. See this coder's handoff report for the sheet/test conflict.
async function deleteRegisterUnderLock(cwd) {
  const transientDir = join(cwd, '.sterling', 'transient');
  try {
    mkdirSync(transientDir, { recursive: true });
    await withRegisterLock(
      cwd,
      () => {
        // DISPATCH-STATE SESSION-BOUNDARY SWEEP RUNS FIRST (X3, Codex review;
        // decision dispatch-state-machine-pre-slot-post-binding-locked-start-
        // resolution-replaces-transcript-attribution §4b), inside this SAME
        // lock hold — one lock for register AND dispatch state. ORDER is
        // load-bearing: a crash AFTER the sweep but before the register
        // delete leaves only the sweep's conservative, already-terminalized
        // state on disk (harmless); the REVERSE order would leave the
        // register gone but dispatch-state records still looking live with no
        // register evidence to explain them. Every non-terminal record
        // becomes terminal {reason:'session-boundary'}; tombstones older than
        // 7 days are pruned. A lock failure (caught below) leaves this
        // unattempted too — the existing posture, unchanged.
        const sweep = sessionBoundarySweep(cwd, { now: Date.now() });
        if (sweep.refused) {
          process.stderr.write(`${sweep.refused}\n`);
        }
        rmSync(registerPath(cwd), { force: true });
        // Orphaned atomic-write staging files (a crash between write and rename
        // in H22/H10) die at the same boundary (P4). Derived from the SAME
        // basename the owner names, not a second literal.
        const registerBasename = basename(registerPath(cwd));
        for (const f of readdirSync(transientDir)) {
          if (f.startsWith(`${registerBasename}.tmp-`)) rmSync(join(transientDir, f), { force: true });
        }
      },
      { retryMs: 1000, timeoutMs: 10_000 }
    );
  } catch (e) {
    if (e?.code === 'register_lock_held') {
      // Names BOTH skipped effects (LOW, review-fix round): the register
      // delete AND the orphaned .tmp-* staging-file sweep that would
      // otherwise have run in the same critical section — a reader of this
      // line should not have to infer the tmp-file cleanup was skipped too.
      process.stderr.write(
        `${render(e)} — LEAVING the dispatch register intact and SKIPPING its orphaned .tmp-* staging-file cleanup (never deleting unlocked); the next locked H22 fire prunes this session's foreign entries\n`
      );
    }
    // any other failure is fail-open — a failed delete costs deferral precision, never this hook (P1)
  }
}

// swappable art slot (§6 H1): fixed-width ≤40 cols, fits the 35% split pane
const BANNER_ROWS = [
  '▄▀▀ ▀█▀ █▀▀ █▀▄ █   ▀█▀ █▄ █ ▄▀▀▄',
  '▀▀▄  █  █▀▀ █▀▄ █    █  █ ▀█ █ ▄▄',
  '▀▀▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ ▀▀▀ ▀  ▀ ▀▀▀▀',
];

// sterling-silver gradient, lerped per column: white → silver → steel blue
const GRADIENT = [
  [255, 255, 255],
  [192, 192, 200],
  [70, 100, 130],
];

function colorAt(t) {
  const [from, to, u] = t <= 0.5 ? [GRADIENT[0], GRADIENT[1], t * 2] : [GRADIENT[1], GRADIENT[2], (t - 0.5) * 2];
  return from.map((v, i) => Math.round(v + (to[i] - v) * u));
}

function paint(rows) {
  if (process.env.NO_COLOR) return rows.join('\n');
  const width = Math.max(...rows.map((r) => r.length));
  return rows
    .map(
      (row) =>
        [...row]
          .map((ch, x) => {
            if (ch === ' ') return ch;
            const [r, g, b] = colorAt(width <= 1 ? 0 : x / (width - 1));
            return `\x1b[38;2;${r};${g};${b}m${ch}`;
          })
          .join('') + '\x1b[0m'
    )
    .join('\n');
}

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
function pluginRoot() {
  const walked = walkUpPluginRoot();
  if (walked) return walked;
  return process.env.STERLING_PLUGIN_ROOT || null;
}
/** The walk-up alone — never the env seam, not even as a last resort. Used
 *  where the root is about to be PRINTED AS A COMMAND (the receipt remedy
 *  below): an env-supplied value is agent-influenceable under the threat model
 *  decision foreign_95c2c109 F2 closed in H15, so the paste-ready line must come from
 *  the running hook's own location only, and an unresolvable walk-up prints the
 *  placeholder rather than falling back to anything. */
function walkUpPluginRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

/** POSIX-ish path equality for the self-hosted-clone check below: strips a
 *  trailing slash and normalizes backslashes, but does NOT resolve symlinks —
 *  both sides already come from path.resolve/dirname/join in this process. */
function samePath(a, b) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/** Plugin version, fail-open (no version, no line). */
function pluginVersion() {
  try {
    const root = pluginRoot();
    if (!root) return null;
    const v = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    return typeof v === 'string' && v.length ? v : null;
  } catch {
    // fail-open — the banner prints without a version line
  }
  return null;
}

/**
 * DEAD-DISPATCH RESIDUE AT THE SESSION BOUNDARY (SPEC A items 2/3b, boards
 * 03ed9d35/31565253; shared lib scripts/hooks/lib/dispatch-residue.mjs). A
 * pure filesystem+git fact about the H22 register — computed BEFORE the
 * `if (!store) allow()` bail below so it still fires for a cwd carrying a
 * register + config but no initialized knowledge store yet (mirrors H10's
 * same store-independent placement). Age-independent by design: at H1 the
 * register belongs to a DEAD session by construction (its SubagentStop never
 * fired), so no TTL wait is needed, unlike H10's Stop-time check. Only on
 * source startup|clear — resume/compact continue the same logical session and
 * keep their registers, same gating as the residue-conversion block further
 * down. Read-side print-once only (a truthy residue_reported_at, however it
 * got there — H10's Stop-side stamp included — suppresses); H1 never needs to
 * write the stamp itself since the register is deleted unconditionally right
 * after this runs.
 */
function computeH1DeadDispatchResidue(cwd, source) {
  if (source !== 'startup' && source !== 'clear') return [];
  // ONE READER: parseRegisterEntry (scripts/lib/dispatch-register.mjs) now
  // spreads every unvalidated field through unchanged (residue_reported_at
  // included), so this print-once guard reads it off the PARSED entry
  // instead of a second raw JSON read. H1 never writes the stamp itself
  // (H10 owns that under the lock) — this is read-only.
  const { availability, entries } = readRegister(cwd);
  if (availability !== 'ok' || !entries.length) return [];
  const lines = [];
  for (const entry of entries) {
    if (!entry || entry.residue_reported_at) continue; // print-once, cross-surface with H10
    // A1: an `ended` entry's Stop DID fire — it is inactive-confirmed, never
    // residue from a dispatch that never completed.
    if (entry.ended) continue;
    const probe = probeDirtyPaths(cwd, entry.files);
    const dirty = Array.isArray(probe.dirty) ? probe.dirty : [];
    if (probe.verified && dirty.length === 0) continue; // clean — nothing to report
    lines.push(render(disclosure('dispatch_residue', {}, formatResidueLine(entry, dirty, { verified: probe.verified, reason: probe.reason }))));
  }
  return lines;
}

const input = readStdin();

// H10's missing-snapshot policy intentionally yields no git candidates. Seed
// before startup/clear work begins, so only post-start edits reach first Stop.
// The exclusive writer makes an existing (or racing) snapshot immutable here.
if (input.source === 'startup' || input.source === 'clear') {
  try {
    const git = gitTouches(input.cwd, new Date().toISOString());
    if (git.ok) writeInitialGitSettled(input.cwd, git.next);
  } catch {
    // Non-git projects and failed probes are silently skipped by design.
  }
}

// CURRENT-SESSION MARKER. SessionStart is the ONE moment the platform hands
// Sterling a session_id at a known point in a session's life. This latest-
// value cell is read by scripts/lib/dispatch-register.mjs's readSessionId
// (the shape H10's pressure/gauge/delegation markers already use): P4 by
// supersession, never by a remembered cleanup step. Originally written for
// scripts/commit-reviewed.mjs's now-deleted receipt-expiry check; it survives
// because dispatch-register.mjs's inFlightAdvisory (consumed by the surviving
// build-hooks.mjs / check-projection-fresh.mjs) still reads it as the
// session_id for its own in-flight-dispatch filtering when the caller has no
// session of its own — removing the writer would silently widen those two
// scripts from session-scoped to NO-SESSION-JOIN mode. Gated on
// .sterling/config.json's EXISTENCE, the same gate H22 uses, so H1 never
// creates a store directory in a non-Sterling project (P1). Fail-open: a
// failed write costs only that advisory's session precision.
//
// PUBLISHED ATOMICALLY (tmp + rename). A bare writeFileSync can be read TORN
// by a concurrent reader; rename() on the same filesystem is atomic, so a
// reader sees either the previous marker or this one, never half of one. The
// pid in the staging name keeps two concurrent SessionStarts from clobbering
// each other's tmp file.
const sessionMarkerPath = join(input.cwd, '.sterling', 'transient', 'session.json');
const sessionMarkerTmp = join(input.cwd, '.sterling', 'transient', `session.json.tmp-${process.pid}`);
try {
  if (existsSync(join(input.cwd, '.sterling', 'config.json'))) {
    mkdirSync(join(input.cwd, '.sterling', 'transient'), { recursive: true });
    writeFileSync(
      sessionMarkerTmp,
      JSON.stringify({ session_id: input.session_id ?? null, source: input.source ?? null, at: new Date().toISOString() })
    );
    renameSync(sessionMarkerTmp, sessionMarkerPath);
  }
} catch {
  // fail-open — never break SessionStart for a marker (P1). A PREVIOUS
  // session's marker surviving a failed write is stale positive evidence, so
  // absence is the honest state on any failure.
  // recursive AS WELL AS force: `force` suppresses ENOENT only, so a marker
  // path occupied by a non-empty DIRECTORY (a corrupted tree, a botched manual
  // fix) would survive every cleanup AND block every future write — permanently
  // stale evidence, which is the precise state this catch exists to prevent.
  // The path is Sterling-owned transient state, so removing whatever shape sits
  // there is unambiguous: nothing else can legitimately own
  // .sterling/transient/session.json.
  try {
    rmSync(sessionMarkerPath, { recursive: true, force: true });
    // A staging file orphaned between write and rename dies with the attempt
    // that created it (P4) — no later sweep is relied on to notice it.
    rmSync(sessionMarkerTmp, { recursive: true, force: true });
  } catch {
    // even the removal is best-effort — never break SessionStart (P1)
  }
}

const dispatchResidueLines = (() => {
  try {
    return computeH1DeadDispatchResidue(input.cwd, input.source);
  } catch {
    return [];
  }
})();

// PLAN LOCK — RUN BEFORE EVERY EARLY RETURN, and this position is the whole
// point (review F2). The section is the authority over what this session may
// take on, and it CONSUMES three one-shot markers; running it after the
// storeless bail below would mean a project with .sterling/config.json but no
// sterling.db yet never gets the section AND never consumes its markers, so a
// stale unresolved/released/previous disclosure would sit there forever. Called
// on every SessionStart source (startup, resume, clear, compact); the parsed
// lock rides on to the ROTATION RESTORE block. Fail-open like every H1 read.
let planLockContext = '';
let planLock = null;
let planLockMalformed = false;
try {
  const section = planLockSection({ cwd: input.cwd, source: input.source });
  planLockContext = section.context;
  planLock = section.lock;
  planLockMalformed = section.malformed === true;
} catch {
  // fail-open — a broken plan lock costs its own section, never the rest of H1
}

const store = openStore(input.cwd);
if (!store) {
  // The receipt report rides this early exit too: H22's ledger gate is
  // .sterling/config.json (not sterling.db), so a project with a config but no
  // The PLAN LOCK section rides this early exit too, leading as it does on the
  // main path: a project can hold an approved plan before its store exists, and
  // a section computed but never emitted would consume its one-shot markers
  // silently — disclosing nothing while spending the disclosure.
  if (planLockContext || dispatchResidueLines.length) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: planLockContext + dispatchResidueLines.join('\n\n'),
        },
      })
    );
  }
  // FIXER ADDENDUM A (2026-08-25): the register wipe below is pure
  // filesystem — it needs no open store — so a project with .sterling/
  // (config.json present, per H22's widened gate) but no sterling.db yet
  // must still get it HERE, on this early exit, or its register accumulates
  // forever and every startup re-reports the same residue without ever
  // wiping. UNCONDITIONAL (C6, correctness review) — this now matches the
  // store-present call site below EXACTLY: decision foreign_ec9eacaa deletes the
  // in-flight dispatch register on EVERY source, resume included (an entry
  // can only ever defer a duty on behalf of an agent this NEW session cannot
  // observe), so a source-gated call here disagreed with that same-file
  // ruling for a project whose store had not been initialized yet.
  await deleteRegisterUnderLock(input.cwd);
  allow(); // not a Sterling project — no further ceremony (P1)
}

// H1 is SOFT (banner + conventions + counts): a malformed config must cost the
// deep-queue threshold, never the conventions injection, so this read is guarded
// and falls back to the schema default rather than throwing. Contrast the gates
// (H3/H5/H14/H15), which fail CLOSED on exactly this input — a hook that cannot
// evaluate must deny only where denying is its job (anti_pattern foreign_e13f0fb5).
let config = null;
let configUnreadable = false;
try {
  config = loadConfig(input.cwd);
} catch {
  config = null;
  configUnreadable = true;
}
// A config that PARSES but is not an object (`[]`, `true`, `false`, `0`, `""`,
// `"x"`, `5`) is unusable in exactly the way a throw is: every `config?.x?.y`
// read below optional-chains to undefined, which the posture line would
// otherwise render as the documented default. That is the same false-posture
// defect the UNKNOWN branch closes, reached through a JSON-LEGAL corruption
// instead of a malformed one, so it takes the same branch (review 2026-09-06).
//
// `null` IS DELIBERATELY EXCLUDED: loadConfig returns null for an ABSENT file,
// which must keep rendering the documented default; a file whose content is
// literally `null` parses to that same value and is therefore indistinguishable
// from absent, so it shares that outcome as an accepted limitation (pinned as
// such in h1-tdd-posture-line.test.mjs).
//
// THE COMPARISON MUST STAY A NULL TEST, NOT A TRUTHINESS TEST. Rewriting it as
// `if (config && ...)` swallows `false`, `0` and `""` — three JSON-legal
// non-object configs that would silently return to a confident ON/ON — and the
// four truthy non-object arms (`[]`, `true`, `"x"`, `5`) plus the null-trap arm all
// stay GREEN under that rewrite, which is why those three falsy shapes are
// pinned explicitly. Measured, not assumed: the truthiness rewrite reddens
// exactly those three arms and nothing else. `!=` vs `!==` here is NOT the
// hazard — they differ only for `undefined`, which loadConfig never returns, so
// that swap is behaviourally inert and correctly leaves the suite green.
//
// It does NOT change any other consumer: `config` stays null-or-as-parsed and
// roleContext / the queue threshold / the concurrency ceiling all keep
// degrading to their own defaults as before.
if (config !== null && (typeof config !== 'object' || Array.isArray(config))) {
  configUnreadable = true;
}

// MACHINE ROLE (todo cabbc10f, decision foreign_a9b98b7d): stated ONLY when this
// session's project IS a Sterling clone itself — comparing the normalized
// input.cwd to pluginRoot(). Every OTHER Sterling project (a consumer of the
// plugin, not a clone of it) never sees this line; it exists because the
// committed CLAUDE.md's "this machine authors" prose travels with every
// clone and misleads a session opened inside one. Guarded exactly like the
// config read above — H1 is soft, so a malformed config costs this line, never
// the conventions injection.
let roleContext = '';
try {
  const root = pluginRoot();
  if (root && samePath(input.cwd, root)) {
    const role = config?.machine_role;
    if (role === 'authoring') {
      roleContext =
        '\n\nMACHINE ROLE: AUTHORING (declared in .sterling/config.json machine_role) — Sterling work lands and merges here; CLAUDE.md\'s authoring contract applies.';
    } else if (role === 'consumer') {
      roleContext =
        '\n\nMACHINE ROLE: CONSUMER — this clone consumes via /sterling:update. The committed CLAUDE.md\'s "this machine authors" language does NOT apply on this machine: never commit here, never hand-reconcile drift; a dirty generated file is discarded (git checkout -- <path>); currency comes only from /sterling:update.';
    } else {
      roleContext =
        '\n\nMACHINE ROLE: UNDECLARED — treat as CONSUMER (the safe posture) until declared. The authoring machine declares machine_role:"authoring" in .sterling/config.json once; a successful /sterling:update stamps "consumer" automatically.';
    }
  }
} catch {
  // fail-open — a malformed config or unresolved plugin root costs only this line
}

// TDD / MUTATION-VERIFICATION POSTURE (decision foreign_752caf98
// tdd-and-mutation-toggles-in-system-tab, board 7e7279c4 slice 3C): mechanizes
// the "check what this machine is set to" instruction CLAUDE.md states in
// prose by reading the LIVE per-project toggles at every SessionStart, rather
// than leaving the conductor to consult a value it cannot see. loadConfig
// (above) returns the raw parsed .sterling/config.json with NO zod defaults
// applied (unlike the MCP server's parseConfig) — a project whose config
// predates this toggle, or config === null on a malformed read, leaves
// config?.tdd?.enabled undefined here. Undefined is treated as the
// DOCUMENTED SCHEMA DEFAULT (both fields default true, decision foreign_752caf98)
// rather than invented: only an explicit `false` reads as OFF. Positioned
// immediately after roleContext in the output concatenation below. Guarded
// like every other H1 read — H1 is soft, so a malformed config costs only
// this one line, never the conventions injection.
//
// AN UNREADABLE CONFIG REPORTS UNKNOWN, NEVER THE DEFAULT (external review
// 2026-09-06, Codex thread 01a075e9, which caught this where two roster
// reviewers did not). ABSENT and UNREADABLE are different facts and this line
// must not collapse them: an absent key genuinely IS the schema default, but a
// config that could not be PARSED tells us nothing about either toggle, and
// rendering that as "ON / ON" asserts a posture the hook never read. That is
// the worst failure available here — worse than printing nothing — because
// this line exists precisely to stop the conductor assuming a posture, and in
// a project where both toggles are OFF (this clone, today) a corrupt config
// would confidently state the exact opposite of the truth. loadConfig returns
// null for an ABSENT file and THROWS on a malformed one, which is what makes
// the two distinguishable at all.
let tddPostureContext = '';
try {
  if (configUnreadable) {
    tddPostureContext =
      '\n\nTDD posture: UNKNOWN — the project config could not be read, so neither ' +
      'config.tdd.enabled nor config.mutation_verification.enabled could be determined. ' +
      'This is NOT the default posture: repair the config, or state your posture explicitly.';
  } else {
    const tddOn = config?.tdd?.enabled !== false;
    const mutationOn = config?.mutation_verification?.enabled !== false;
    tddPostureContext =
      `\n\nTDD posture: tests-first ${tddOn ? 'ON' : 'OFF'} · mutation verification ${mutationOn ? 'ON' : 'OFF'} ` +
      `(config.tdd.enabled / config.mutation_verification.enabled — TUI System tab; explicit asks still work)`;
  }
} catch {
  // fail-open — a malformed config costs only this line
}

// CLONE-CURRENCY SIGNAL (closes the gap decision foreign_be9168e8 surfaced and parked:
// "a machine that never runs /sterling:update has no passive signal that it is
// behind"). Probes the CLONE at pluginRoot() — not this project — so every
// session on the machine states whether Sterling is current. Throttle: the one
// networked step (git fetch) runs at most once per TTL (default 24h), stamped
// in .git/sterling-update-check.json; the behind-count is computed LOCALLY
// against the last-fetched ref on every session start, so an applied update
// goes silent immediately without waiting out the TTL. checked_at is stamped
// even when the fetch fails — an offline machine must not pay the timeout on
// every session start. Skipped entirely on a declared-authoring clone (it
// lives on branches and ahead-of-origin states, where "behind" is noise) and
// off the default branch. Fail-open and silent on any error (P1); the
// definitive probe stays /sterling:update --check.
// STERLING_CURRENCY_DISABLE=1 skips the probe entirely (test hermeticity: the
// hook test battery must never fetch — it RUNS during /sterling:update itself).
let currencyWarning = '';
let currencyContext = '';
try {
  const root = process.env.STERLING_CURRENCY_DISABLE === '1' ? null : pluginRoot();
  const gitDir = root ? join(root, '.git') : null;
  // .git as a FILE is a worktree — an authoring-machine shape; skip (fail-open).
  if (gitDir && existsSync(gitDir) && statSync(gitDir).isDirectory()) {
    let role = null;
    try {
      role = JSON.parse(readFileSync(join(root, '.sterling', 'config.json'), 'utf8')).machine_role;
    } catch {
      // no config or malformed — the safe posture is consumer (mirrors the role line above)
    }
    if (role !== 'authoring') {
      const git = (args, timeout = 5_000) => {
        const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout });
        return r.status === 0 ? (r.stdout ?? '').trim() : null;
      };
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
      const hasOrigin = (git(['remote']) ?? '').split('\n').includes('origin');
      const defaultBranch = hasOrigin
        ? (git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']) ?? '').replace(/^origin\//, '') || 'main'
        : null;
      if (hasOrigin && branch && branch === defaultBranch) {
        const cachePath = join(gitDir, 'sterling-update-check.json');
        const ttl = Number(process.env.STERLING_CURRENCY_TTL_MS ?? 24 * 60 * 60 * 1000);
        let fresh = false;
        try {
          fresh = Date.now() - Date.parse(JSON.parse(readFileSync(cachePath, 'utf8')).checked_at) < ttl;
        } catch {
          // no cache yet — probe
        }
        if (!fresh) {
          // GIT_TERMINAL_PROMPT=0: a fetch that would prompt for credentials
          // must fail immediately, not hang SessionStart until the timeout.
          spawnSync('git', ['fetch', 'origin', '--quiet'], { cwd: root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
          try {
            writeFileSync(cachePath, JSON.stringify({ checked_at: new Date().toISOString() }) + '\n');
          } catch {
            // unwritable cache costs only the throttle, never the signal
          }
        }
        const behind = Number.parseInt(git(['rev-list', '--count', `HEAD..origin/${defaultBranch}`]) ?? '', 10);
        if (Number.isFinite(behind) && behind > 0) {
          currencyWarning = `⚠ Sterling is ${behind} update(s) behind — double-click sterling-update.bat (or run /sterling:update), then restart the session. A /clear is NOT enough — MCP servers survive it, so EXIT AND RELAUNCH the Claude Code CLI. `;
          currencyContext =
            `\n\nSTERLING CLONE IS BEHIND (H1): the Sterling clone at ${root} is ${behind} commit(s) behind origin's default branch. ` +
            `Tell the user; on their word run /sterling:update (never hand-reconcile or git-pull around it — fast-forward-or-refuse), ` +
            `and remind them a session RESTART follows a successful update — that means EXIT AND RELAUNCH the Claude Code CLI, since a /clear alone does not reload the server/hook code.`;
        }
      }
    }
  }
} catch {
  // fail-open — the currency probe must never break or delay SessionStart beyond its timeouts
}

// PLAN LOCK (decision `plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry`).
// ONE SELF-CONTAINED FUNCTION, deliberately: H1 is scheduled for a from-blank
// registry rebuild, which lifts this unchanged. It takes only {cwd, source} and
// touches nothing else in this file.
//
// WHY IT IS FIRST, AND WHY IT IS NOT A GATE: measured 2026-09-06 — after a
// /clear the conductor re-entered through the rotation note and the board, never
// re-read the approved plan, and dispatched three lanes that patched mechanisms
// the plan had homed in from-blank rebuild slices. The plan is the only surface
// carrying ORDER and the user's written rulings. This puts it back in front of
// the conductor at every re-entry; whether the plan is FOLLOWED stays the
// conductor's judgement, and nothing here denies anything.
//
// The lock is parsed ONCE, here, and the parsed snapshot is handed to the
// ROTATION RESTORE block below, which never re-reads it.
//
// Every primitive it uses — the sanitiser, the validated lock read, the bounded
// status computation, the marker claim — is imported from lib/plan-lock.mjs and
// shared with H31, H19 and the CLI. The ROTATION RESTORE block renders a plan
// path too (the note's own captured value) and passes it through the SAME
// imported sanitiser: two sanitisers on one payload is how one ends up weaker.
function planLockSection(ctx) {
  const TITLE_MAX = PLAN_LOCK_TITLE_MAX;
  const PATH_MAX = PLAN_LOCK_PATH_MAX;
  const REASON_MAX = PLAN_LOCK_REASON_MAX;
  const STALE_DAYS = 14;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Everything below reaches additionalContext and originates in an approved
  // plan's own text, so it is control-stripped and bounded at the read too —
  // H31 bounds at the write, this bounds a lock written by anything else.
  const clean = planLockClean;

  const sterlingDir = join(ctx.cwd, '.sterling');
  const transientDir = join(sterlingDir, 'transient');
  const blocks = [];

  // ONE-SHOT MARKERS, on EVERY source. claimPlanLockMarker RENAMES the file out
  // of its published name before reading it, so deletion-before-parse holds AND
  // a marker rewritten mid-consume is not silently swallowed.
  const MARKERS = [
    {
      file: 'plan-lock-unresolved.json',
      render: (body) =>
        `PLAN LOCK NOT BOUND (one-shot): an ExitPlanMode approval could not be bound to a plan file — ${clean(body?.reason, REASON_MAX) || 'no reason recorded'}. ` +
        `Any earlier lock was preserved unchanged. Re-bind by hand with plan-lock.mjs --plan <absolute path> if this objective still has an approved plan.`,
    },
    {
      file: 'plan-lock-released.json',
      render: (body) =>
        `PLAN LOCK RELEASED (one-shot): the plan lock was released — ${clean(body?.reason, REASON_MAX) || 'no reason recorded'}. ` +
        `No plan governs this objective's scope and ordering until a new plan is approved.`,
    },
    {
      file: 'plan-lock-previous.json',
      render: (body) =>
        `PLAN LOCK SUPERSEDED (one-shot): the previous plan was "${clean(body?.title, TITLE_MAX) || 'untitled'}" (${clean(body?.plan_path, PATH_MAX) || 'no path recorded'}). ` +
        `The lock above replaced it — work planned under the old plan is no longer governed by it.`,
    },
  ];
  const markerLines = [];
  for (const marker of MARKERS) {
    let raw = null;
    try {
      raw = claimPlanLockMarker(join(transientDir, marker.file));
    } catch {
      raw = null; // fail-open: a failed claim costs one disclosure, never this hook
    }
    if (raw === null) continue;
    // Three claim outcomes: null (nothing there), a string (its text), or an
    // {unreadable} sentinel for a marker that was consumed but could not be
    // read (a FIFO or oversize file planted at its path). The last two both
    // render the body-less disclosure — the marker is spent either way, and
    // saying nothing about a consumed marker is the one thing that must not
    // happen.
    let body = null;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
    markerLines.push(marker.render(body && typeof body === 'object' ? body : null));
  }

  // THE LOCK ITSELF, read through the shared VALIDATING reader: a record that
  // is JSON but not a lock is MALFORMED, never half-trusted. MALFORMED is
  // reserved for the lock RECORD (never for the plan file, whose four states
  // are below) and suppresses no other section.
  let read = { absent: true };
  try {
    read = readPlanLock(sterlingDir);
  } catch (e) {
    read = { malformed: `could not be read (${(e && e.message) || e})` };
  }
  const lock = read.lock ?? null;
  const malformed = Boolean(read.malformed);

  if (malformed) {
    blocks.push(
      `PLAN LOCK MALFORMED: .sterling/plan-lock.json exists but ${clean(read.malformed, REASON_MAX)}, so it is not a usable lock record. ` +
        `Inspect it with \`plan-lock.mjs --show\`, or clear it with \`plan-lock.mjs --release --reason "<why>"\`. ` +
        `Nothing else in this session start is affected.`
    );
  } else if (lock) {
    // RENDERED copy: sanitised and bounded. The lock's own plan_path stays raw,
    // and it is the raw one computeStatus reads from disk.
    const planPath = clean(lock.plan_path, PATH_MAX);
    // FOUR STATES for the plan FILE, compared against file_sha256_at_approval —
    // NEVER approved_sha256, or a lock whose approved text legitimately differed
    // from the file at approval would read as permanently MODIFIED. A non-regular
    // file, an oversize one, or one this process cannot read is UNREADABLE.
    // WHY A PLANTED FIFO CANNOT STALL SESSIONSTART (the mechanism is the OPEN,
    // not a stat): computePlanStatus opens the recorded path ONCE with
    // O_RDONLY|O_NOFOLLOW|O_NONBLOCK, so a direct FIFO returns immediately
    // instead of blocking inside the open, and fstat on that descriptor then
    // rejects it as non-regular. On Windows neither flag exists — accepted,
    // because a Win32 named pipe is a \\.\pipe\ object openSync does not reach
    // through these paths; the fstat classification still applies there.
    let status = 'MISSING';
    try {
      const live = computePlanStatus(lock);
      status = live.status === 'MODIFIED' ? 'MODIFIED since approval' : live.status;
    } catch {
      status = 'UNREADABLE';
    }
    let branchNow = 'unknown';
    try {
      const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.cwd, encoding: 'utf8', timeout: 5_000 });
      const current = r.status === 0 ? (r.stdout ?? '').trim() : '';
      const approved = clean(lock.approved_branch, 120);
      if (current && approved) branchNow = current === approved ? 'same' : `DIFFERENT (now ${current}, approved on ${approved})`;
    } catch {
      branchNow = 'unknown';
    }
    const source = lock.source === 'manual' ? 'manual' : 'exit_plan_mode';
    blocks.push(
      `PLAN LOCK: ${clean(lock.title, TITLE_MAX) || '(untitled plan)'} — ${planPath || '(no path recorded)'} ` +
        `(approved ${clean(lock.approved_at, 40).slice(0, 10) || 'unknown date'} on ${clean(lock.approved_branch, 120) || 'no branch recorded'}, ${source}) ` +
        `· plan file ${status} · branch now ${branchNow}`
    );
    // THE AUTHORITY BOUNDARY, with its own justification attached: a ruling
    // delivered without its reason gets re-litigated at the delivery surface.
    blocks.push(
      `THE APPROVED PLAN GOVERNS THIS OBJECTIVE'S SCOPE, ORDERING AND SLICES; STANDING STORE DECISIONS STILL GOVERN MECHANISMS ` +
        `UNLESS THE PLAN RECORDS A LATER USER RULING; THE BOARD IS INVENTORY; READ THE PLAN BEFORE THE FIRST DISPATCH. ` +
        `(The plan is the only surface carrying ORDER and the user's written rulings — the board holds inventory, the store holds design.)`
    );
    if (source === 'manual') {
      blocks.push(`This lock was written by hand (plan-lock.mjs --plan) — approval provenance is the operator's word, not an ExitPlanMode approval.`);
    }
    if (lock.text_file_mismatch === true) {
      blocks.push(
        `At approval the approved text and the file on disk already differed (text_file_mismatch) — the live status above is judged against the FILE's bytes at that moment, which is the only honest baseline.`
      );
    }
    if (status === 'MODIFIED since approval') {
      blocks.push(
        `The plan file has changed since it was approved. Approval provenance is never re-stamped: record the change with plan-lock.mjs --observe, or have the user approve a new plan.`
      );
    }
    const ageMs = Date.now() - Date.parse(clean(lock.approved_at, 40));
    if (Number.isFinite(ageMs) && ageMs > STALE_DAYS * DAY_MS) {
      blocks.push(
        `STALE: approved ~${Math.round(ageMs / DAY_MS)} days ago. Staleness is a DISCLOSURE, never a clear — only a later approval or plan-lock.mjs --release clears a lock.`
      );
    }
  }

  blocks.push(...markerLines);
  // `malformed` rides the snapshot: a lock that EXISTS but cannot be parsed is
  // not the same fact as no lock at all, and a consumer told only `lock: null`
  // would report "no plan lock is live" for a lock sitting right there.
  return { context: blocks.length ? blocks.join('\n') + '\n\n' : '', lock: malformed ? null : lock, malformed };
}

// ROTATION RESTORE (context-rotation slice 3): a rotation note written by
// scripts/rotation-note.mjs before a /clear is injected into the FRESH session
// and CONSUMED by that injection — source=clear ONLY (startup/resume have their
// own truths and must not eat a note prepared for a rotation that hasn't
// happened). Single-shot by deletion-before-build (P4): even a later failure in
// this block cannot leave a note that re-injects forever. Disclosures over
// refusals: a moved HEAD or an old note still injects, loudly qualified — the
// store/board stay the authorities; the note is only the non-reconstructable
// residue. Fail-open like every H1 read.
// Per-field render bounds for the note: prose fields carry the substance the
// note exists for, path/sha-shaped ones can never legitimately be longer than a
// path. Every one of them is rendered through planLockClean (the shared
// sanitizer) below — see the note comment in the block.
const NOTE_PROSE_MAX = 2000;
// Enumeration bounds for the note's live_dispatches block. Per-element
// sanitisation bounds each string; these bound the ARRAY, which is the other
// half of "a note cannot dominate the injection".
const LIVE_DISPATCH_MAX = 20;
const LIVE_TERRITORY_MAX = 40;
const LIVE_TERRITORY_LINE_MAX = PLAN_LOCK_PATH_MAX * 4;
const NOTE_FIELD_MAX = {
  objective: NOTE_PROSE_MAX,
  next_slice: NOTE_PROSE_MAX,
  risks: NOTE_PROSE_MAX,
  pointers: NOTE_PROSE_MAX,
  branch: PLAN_LOCK_PATH_MAX,
  head_sha: PLAN_LOCK_PATH_MAX,
  at: PLAN_LOCK_PATH_MAX,
};
let rotationContext = '';
try {
  if (input.source === 'clear') {
    const notePath = join(input.cwd, '.sterling', 'transient', 'rotation-note.json');
    if (existsSync(notePath)) {
      const note = JSON.parse(readFileSync(notePath, 'utf8'));
      rmSync(notePath, { force: true }); // consume FIRST — a note serves exactly one restore
      const head = (() => {
        try {
          const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: input.cwd, encoding: 'utf8', timeout: 5_000 });
          return r.status === 0 ? (r.stdout ?? '').trim() : null;
        } catch {
          return null;
        }
      })();
      const cautions = [];
      if (note.head_sha && head && head !== note.head_sha) {
        cautions.push(`HEAD has MOVED since the note (${planLockClean(String(note.head_sha), PLAN_LOCK_PATH_MAX).slice(0, 8)} → ${head.slice(0, 8)}) — re-verify repository state before acting on it`);
      }
      // COMMITS-AHEAD DRIFT (N15, docs/feedback/sterling-plugin-*2026-08-24*):
      // the note's commits_ahead is a number the writer computed, not prose —
      // recompute it the same way at restore time and disclose any mismatch
      // exactly like the head_sha check above, rather than trusting a stamp
      // that may already be stale (a note written, then more commits landed
      // before the /clear actually happened). UNVERIFIABLE IS ITS OWN STATE
      // (Codex P2-B), distinct from both "matches" and "drifted": when the
      // base is missing or the recount itself fails (e.g. a --base ref that
      // no longer resolves), the stamped count is printed with an explicit
      // "(unverified — base unavailable)" marker rather than silently
      // presented as though it had been confirmed — and, just as important,
      // never asserted as DRIFT either, since a failed recount is not
      // evidence the number is wrong.
      // THE NOTE IS AN ON-DISK FILE WRITTEN FROM A PREVIOUS SESSION'S CLI
      // ARGUMENTS, so every field of it that reaches additionalContext is
      // control-stripped and bounded by the SAME sanitizer the PLAN LOCK
      // section uses — prose fields generously (they are the point of the
      // note), path- and sha-shaped ones at the path bound. Only plan_path was
      // covered before; a control character in `objective` could fabricate a line.
      const noteBaseBranch = planLockClean(note.base_branch, PLAN_LOCK_PATH_MAX);
      let commitsAheadUnverified = false;
      if (typeof note.commits_ahead === 'number') {
        if (!note.base_branch) {
          commitsAheadUnverified = true;
        } else {
          try {
            const countR = spawnSync('git', ['rev-list', '--count', `${note.base_branch}..HEAD`], { cwd: input.cwd, encoding: 'utf8', timeout: 5_000 });
            const actual = countR.status === 0 ? Number((countR.stdout ?? '').trim()) : null;
            if (Number.isFinite(actual)) {
              if (actual !== note.commits_ahead) {
                cautions.push(`commits_ahead drift — note says ${note.commits_ahead}, actual is ${actual} (vs ${noteBaseBranch || 'unknown base'})`);
              }
            } else {
              commitsAheadUnverified = true;
            }
          } catch {
            commitsAheadUnverified = true; // fail-open — a failed recount costs only the verification, never the restore
          }
        }
      }
      const ageMs = Date.now() - Date.parse(note.at ?? '');
      if (Number.isFinite(ageMs) && ageMs > 60 * 60 * 1000) {
        cautions.push(`the note is ~${Math.round(ageMs / 3_600_000)}h old`);
      }
      // PLAN DRIFT (decision plan-lock-...): note.plan_path is a SNAPSHOT taken
      // at write time, and a new plan can be approved between the note and the
      // /clear that consumes it. Disclose the divergence — never silently
      // substitute either value — using the lock this hook already parsed once.
      // Both paths reach additionalContext, so both go through the SAME
      // sanitizer the PLAN LOCK section uses — the note is an on-disk file a
      // previous session wrote, not a trusted in-memory value.
      // COMPARE THE RAW STRINGS, DISPLAY THE SANITIZED ONES. Sanitizing before
      // comparing would make two genuinely different paths compare EQUAL once
      // their differences are stripped or truncated away — the mismatch this
      // exists to disclose would then be silently suppressed. Presence is
      // judged on the raw value too, so a path made entirely of stripped
      // characters is still a path the note names.
      const notePlanRaw = typeof note.plan_path === 'string' && note.plan_path ? note.plan_path : null;
      const livePlanRaw = typeof planLock?.plan_path === 'string' && planLock.plan_path ? planLock.plan_path : null;
      const notePlan = notePlanRaw ? planLockClean(notePlanRaw, PLAN_LOCK_PATH_MAX) : null;
      const livePlan = livePlanRaw ? planLockClean(livePlanRaw, PLAN_LOCK_PATH_MAX) : null;
      // THREE ARMS, and the third is the one a two-arm version gets wrong: a
      // MALFORMED lock is not an absent one, and saying "no plan lock is live"
      // for a lock sitting on disk would send the reader looking for the wrong
      // repair.
      if (notePlanRaw && planLockMalformed) {
        cautions.push(`the note names a plan (${notePlan}) but the live plan lock is MALFORMED and could not be compared against it — inspect it with \`plan-lock.mjs --show\``);
      } else if (notePlanRaw && livePlanRaw && notePlanRaw !== livePlanRaw) {
        cautions.push(`the note's plan_path DIFFERS from the current plan lock (note: ${notePlan}; lock now: ${livePlan}) — a new plan was approved after the note was written, and the PLAN LOCK section above is the authority`);
      } else if (notePlanRaw && !livePlanRaw) {
        cautions.push(`the note names a plan (${notePlan}) but no plan lock is live now — it was released, or .sterling/ was recreated`);
      }
      // The plan leads the note's fields: it names the AUTHORITY over the next
      // slice, where every other field describes the residue.
      const planField = notePlanRaw ? [`- plan: ${notePlan}`] : [];
      const fields = planField
        .concat(
          ['objective', 'next_slice', 'risks', 'pointers', 'branch', 'head_sha', 'at']
            .filter((k) => note[k])
            .map((k) => `- ${k}: ${planLockClean(String(note[k]), NOTE_FIELD_MAX[k])}`)
        )
        .concat(
          typeof note.commits_ahead === 'number'
            ? [`- commits_ahead: ${note.commits_ahead} (vs ${noteBaseBranch || 'unknown base'})${commitsAheadUnverified ? ' (unverified — base unavailable)' : ''}`]
            : []
        )
        .join('\n');
      // LIVE DISPATCHES AT ROTATION (board efbddf09): the note's live_dispatches
      // is the only trace a fresh session has of a subagent that kept running
      // across the /clear — re-print it so the conductor checks ListAgents
      // instead of dispatching a second agent at the same slice (measured
      // 2026-09-04). THREE STATES, deliberately distinct: a non-empty array is
      // counted and enumerated; a CONFIRMED-EMPTY array prints NOTHING at all,
      // not even a "0 dispatch(es)" line (P1 — no ceremony for a checked-clear);
      // null is UNKNOWN (the writer found a register it could not read) and is
      // disclosed as uncertainty, never as a fabricated count. An ABSENT field
      // (a note from a writer predating this) is treated as the silent case —
      // it is not evidence of uncertainty, and manufacturing a warning from it
      // would fire on every legacy note.
      const liveDispatches = note.live_dispatches;
      let liveLine = '';
      if (Array.isArray(liveDispatches) && liveDispatches.length) {
        // BOUNDED RENDER. Per-element sanitisation bounds each STRING but not
        // the ARRAY, so a note carrying thousands of dispatches (or one
        // dispatch with thousands of territory entries) could still dominate
        // the whole injection. The COUNT stays exact and unclipped — it is the
        // number the conductor acts on; only the enumeration is clipped, and
        // every clip says how much it dropped rather than trailing off.
        const rendered = liveDispatches
          .slice(0, LIVE_DISPATCH_MAX)
          .map((d) => {
            // Same treatment as the note's scalar fields above — these strings
            // come from the same on-disk file and reach the same payload.
            const entries = Array.isArray(d?.territory) ? d.territory : [];
            let territory = 'no declared territory';
            if (entries.length) {
              const shown = entries.slice(0, LIVE_TERRITORY_MAX).map((t) => planLockClean(String(t), PLAN_LOCK_PATH_MAX));
              const dropped = entries.length - shown.length;
              let joined = shown.join(', ');
              if (joined.length > LIVE_TERRITORY_LINE_MAX) joined = `${joined.slice(0, LIVE_TERRITORY_LINE_MAX)}…`;
              territory = dropped > 0 ? `${joined}… (+${dropped} more)` : joined;
            }
            return `- ${planLockClean(String(d?.agent_type ?? 'agent'), PLAN_LOCK_PATH_MAX) || 'agent'} (${planLockClean(String(d?.agent_id ?? 'unknown id'), PLAN_LOCK_PATH_MAX) || 'unknown id'}) — ${territory}`;
          })
          .join('\n');
        const omitted = liveDispatches.length - Math.min(liveDispatches.length, LIVE_DISPATCH_MAX);
        liveLine =
          `\n${liveDispatches.length} dispatch(es) were live at rotation — check ListAgents before re-dispatching:\n${rendered}` +
          (omitted > 0 ? `\n… (+${omitted} more)` : '');
      } else if (liveDispatches === null) {
        liveLine = `\n${render(
          disclosure(
            'register_unavailable',
            {},
            'dispatch register unavailable — the register existed but could not be read when the note was written, so whether any subagent was still running cannot be stated here: check ListAgents before re-dispatching.'
          )
        )}`;
      }
      // UNCERTAIN DISPATCHES (tri-state, R1): an out-of-lease entry is carried
      // by the note (rotation-note.mjs's uncertain_dispatches) but is NEVER
      // folded into the live count above — an expired lease is not a death
      // certificate, so it is surfaced separately with its own code rather
      // than silently dropped or counted as live.
      const uncertainDispatches = Array.isArray(note.uncertain_dispatches) ? note.uncertain_dispatches : [];
      let uncertainLine = '';
      if (uncertainDispatches.length) {
        const renderedUncertain = uncertainDispatches
          .slice(0, LIVE_DISPATCH_MAX)
          .map((d) => {
            const type = planLockClean(String(d?.agent_type ?? 'agent'), PLAN_LOCK_PATH_MAX) || 'agent';
            const id = planLockClean(String(d?.agent_id ?? 'unknown id'), PLAN_LOCK_PATH_MAX) || 'unknown id';
            const reason = planLockClean(String(d?.reason ?? 'unknown'), PLAN_LOCK_PATH_MAX) || 'unknown';
            return render(
              disclosure('dispatch_status_unknown', {}, `${type}:${id} — ownership uncertain (${reason}); settle with ListAgents before re-dispatching`)
            );
          })
          .join('\n');
        const omittedUncertain = uncertainDispatches.length - Math.min(uncertainDispatches.length, LIVE_DISPATCH_MAX);
        uncertainLine =
          `\n${uncertainDispatches.length} dispatch(es) UNCERTAIN at rotation (lease expired, not confirmed dead — never counted as live):\n${renderedUncertain}` +
          (omittedUncertain > 0 ? `\n… (+${omittedUncertain} more)` : '');
      }
      rotationContext =
        `\n\nROTATION RESTORE (H1, source=clear): a rotation note was prepared before this /clear; this injection CONSUMES it (single-shot).` +
        (cautions.length ? ` CAUTION: ${cautions.join('; ')}.` : '') +
        `\n${fields}${liveLine}${uncertainLine}\nResume from next_slice. The board and knowledge store remain the authorities for remaining work and decisions — the note carries only the residue they cannot hold. ` +
        (note.reason === 'code-reload'
          ? `CODE RELOAD WAS REQUIRED (note reason: code-reload) — the correct sequence was: 1. exit and relaunch the Claude Code CLI, 2. THEN this /clear. If step 1 was skipped, this session's MCP server/hooks may still be stale: exit and relaunch the CLI now, then /clear again.`
          : `If next_slice depends on a server/hook code change (migration, update, rebuild), that requires having EXITED AND RELAUNCHED the Claude Code CLI BEFORE this /clear — a /clear alone never reloads code, so relaunch now if that didn't happen yet.`);
    }
  }
} catch {
  // fail-open — a malformed note costs the restore, never the conventions injection
}

// READ-EVIDENCE DOES NOT SURVIVE A SESSION BOUNDARY OR COMPACTION (board
// 776d2b65): the conductor ledger's entries now expire by FILE CONTENT HASH
// rather than per prompt, so the two cases a hash cannot vouch for get an
// explicit clear here. (1) source=compact — compaction can drop a read from
// the model's window while the file's bytes are unchanged; the old per-prompt
// clear never covered this either, since compaction does not fire
// UserPromptSubmit. (2) source=startup|clear — a genuinely NEW session has
// read nothing, and a dead session's hashed entries would otherwise vouch for
// unchanged files this model never saw. resume continues the same logical
// session and keeps its ledger. Fail-open like every H1 read.
try {
  if (input.source === 'compact' || input.source === 'startup' || input.source === 'clear') {
    const conductorLedger = join(input.cwd, '.sterling', 'transient', 'conductor-reads.json');
    rmSync(conductorLedger, { force: true });
  }
} catch {
  // fail-open — a failed clear costs freshness, never the conventions injection
}

// DEAD-DISPATCH RESIDUE AT THE SESSION BOUNDARY (SPEC A items 2/3b): the lines
// were already computed store-independently, above the `if (!store) allow()`
// bail (computeH1DeadDispatchResidue) — folded into additionalContext here for
// the normal (store-present) path.
// ON source=clear THE WORD "DEAD" IS NOT EARNED (board efbddf09, measured
// 2026-09-04): a subagent DID outlive a /clear and kept writing files while the
// fresh session dispatched a second agent at the same slice. A missing
// SubagentStop is evidence the register was never cleaned up, NOT evidence the
// process ended — so the residue is still reported (its dirty-file list is the
// useful part) but on a /clear it stops asserting death and points at the two
// surfaces that can actually answer the question.
const dispatchResidueContext = dispatchResidueLines.length
  ? `\n\nDEAD-DISPATCH RESIDUE (H1, source=${input.source}): the in-flight dispatch register survived to this session boundary — its SubagentStop(s) never fired, so the register is about to be wiped (P4).` +
    (input.source === 'clear'
      ? ` NOT PROOF THAT THESE DISPATCHES ENDED: a dispatch may still be RUNNING across a /clear — cross-check the LIVE DISPATCHES line in the rotation restore above, and ListAgents, before acting on these files or re-dispatching at them.`
      : '') +
    `\n` +
    dispatchResidueLines.join('\n')
  : '';

// IN-FLIGHT DISPATCH REGISTER (decision foreign_ec9eacaa): deleted UNCONDITIONALLY —
// every source, resume included. Unlike H10's other three registers there is no
// debt to VERIFY and no source to gate on: an entry can only ever defer a duty
// on behalf of an agent this NEW session cannot observe, which is exactly the
// silent duty hole the staleness TTL exists to bound — so the register goes,
// whatever the entries' processes are doing.
// THE ORIGINAL JUSTIFICATION ("a subagent process cannot survive a session
// boundary, so at ANY SessionStart every entry is dead by definition") WAS
// WRONG and is corrected here, not merely softened (board efbddf09, measured
// 2026-09-04): a dispatch DID outlive a /clear, kept writing files, and was
// invisible to the fresh session precisely because this deletion left no trace.
// The deletion behavior is unchanged and still correct; what changed is that
// the note now carries the live set across the boundary (see ROTATION RESTORE
// above) instead of the register being treated as worthless. COOPERATING WRITER (decision
// register-writers-cooperating-lock, 1e0ba0d0): see deleteRegisterUnderLock
// above — on a lock timeout this warns and leaves the register intact rather
// than deleting it unlocked; the next locked H22 fire prunes this session's
// foreign entries anyway. Fail-open like every H1 read.
await deleteRegisterUnderLock(input.cwd);

// GRAVESTONE — an unconditional `rmSync` of the conductor-attested enforcement
// stamp (`.sterling/transient/enforcement-stamp.json`, decision foreign_6e132e19) stood
// here. DELETED 2026-08-30 (S4) by decisions h17-demotes-to-tripwire-with-
// minimal-b-hash-list (78dc9bd6) and b-baseline-hash-list-concrete-design
// (fe861066): the stamp/attestation apparatus is gone whole, so there is nothing
// left at that path for H1 to reclaim.
// UPDATED 2026-09-19 (scale-down, decision sterling-claude-code-scale-down-
// boundary): the stamp's would-be successor — the persistent (B) baseline hash
// list at `.sterling/enforcement-baseline.json` — and its ONLY writer,
// `scripts/enforcement-reconcile.mjs`, are BOTH deleted whole (commit a83f5be,
// "delete ... enforcement self-protection"). Nothing in this codebase mints,
// reads or clears that path any more. H1 STILL never touches it if it happens
// to exist on disk (a leftover from before this cut, or hand-planted) — not
// because anything still depends on it, but because a SessionStart hook has no
// business deleting a file it does not own the meaning of; pinned as a no-op
// invariant by scripts/tests/h1-session-residue.test.mjs.

// SESSION-BOUNDARY REGISTER RESIDUE (board f474df56): H10's transient registers
// (touches / session-events / capture-nagged) are cleared by H10's terminal Stop
// paths — but a session that dies without one (kill, deny-then-close, or the
// capture-pending deferral's deliberate allow-without-clear, decision foreign_bd594c03)
// leaks them into the NEXT session: a stale nag marker silently downgrades every
// duty's soft-block to queue items, a stale capture_pending suppresses the capture
// nag for unrelated new work, and stale touches backdate `earliest` and pollute
// item file_keys and the unowned set. At a NEW session (source startup|clear ONLY —
// resume/compact continue the same logical session and keep their registers) the
// residue belongs to a DEAD session: verify its debt against the store (the same
// captured-set query H10 runs) and either clear silently (paid) or convert to ONE
// deduped capture_owed item, then clear (P5: dead-session debt lands on the queue
// or is verified paid — it never evaporates and never pollutes the new session's
// duty cycle). A malformed register is UNVERIFIABLE debt and converts regardless —
// conservative and loud, never silently trusted. Fail-open like every H1 read.
let residueContext = '';
try {
  if (input.source === 'startup' || input.source === 'clear') {
    const transient = join(input.cwd, '.sterling', 'transient');
    const regPaths = [join(transient, 'touches.json'), join(transient, 'session-events.json'), join(transient, 'capture-nagged.json')];
    const [touchesPath, eventsPath] = regPaths;
    if (regPaths.some((p) => existsSync(p))) {
      let touches = [];
      let events = [];
      let malformed = false;
      try {
        if (existsSync(touchesPath)) {
          const raw = JSON.parse(readFileSync(touchesPath, 'utf8'));
          if (Array.isArray(raw)) touches = raw;
          else malformed = true;
        }
      } catch {
        malformed = true;
      }
      try {
        if (existsSync(eventsPath)) {
          const raw = JSON.parse(readFileSync(eventsPath, 'utf8'));
          if (Array.isArray(raw)) events = raw;
          else malformed = true;
        }
      } catch {
        malformed = true;
      }
      // A lone nag marker with no work evidence is not debt — deleted silently below.
      if (touches.length || events.length || malformed) {
        const stamps = [...touches.map((t) => t?.at), ...events.map((e) => e?.at)].filter(Boolean).sort();
        const earliest = stamps.length ? stamps[0] : null;
        // Same captured-set semantics as H10's duty check: any durable record at or
        // after the residue's earliest timestamp means the dead session paid its debt.
        const paid =
          !malformed &&
          earliest !== null &&
          store
            .query({
              // open_question joins the set (board a9be48f2) — kept
              // BYTE-FOR-BYTE the same list H10's duty check uses, since the
              // comment above binds the two: a dead session that captured an
              // evidenced open question paid its debt exactly as one that
              // captured an answer did.
              types: ['decision', 'anti_pattern', 'feature_article', 'research_finding', 'disconfirmed_hypothesis', 'open_question'],
              cap: 1000,
            })
            .some((r) => r.created_at >= earliest || r.updated_at >= earliest);
        if (!paid) {
          const paths = [...new Set(touches.map((t) => t?.path).filter(Boolean))];
          const pending = events
            .filter((e) => e?.kind === 'capture_pending' && e?.detail)
            .map((e) => e.detail)
            .at(-1);
          // "any capture_owed open" gates more than the choke's exact-key match
          // (its file_keys vary with the residue's paths) — kept deliberately;
          // only the write itself routes through enqueueSystemTodo (decision
          // 194f43e4).
          const open = store
            .query({ types: ['todo'], cap: 1000 })
            .some((t) => t.source === 'system' && t.system_reason === 'capture_owed');
          if (!open) {
            const now = new Date().toISOString();
            store.enqueueSystemTodo({
              id: randomUUID(),
              type: 'todo',
              created_at: now,
              updated_at: now,
              author: 'system',
              status: 'active',
              superseded_by: null,
              links: [],
              scope: 'project',
              stack_tags: [],
              text:
                `capture owed (session-boundary residue): a previous session ended without settling its transient registers — ` +
                (malformed
                  ? `register content was malformed, so the debt is unverifiable and stays loud` +
                    (paths.length ? `; ${paths.length} touched file(s) were recoverable` : '') +
                    ` — `
                  : `${paths.length} touched file(s), ${events.length} session event(s)` +
                    (pending ? `, declared pending (${pending})` : '') +
                    ` and no durable record since ${earliest} — `) +
                `verify the work landed its capture against HEAD, then close`,
              source: 'system',
              system_reason: 'capture_owed',
              file_keys: paths.slice(0, 20),
            });
            residueContext =
              `\n\nSESSION-BOUNDARY RESIDUE (H1): a previous session left unsettled transient registers` +
              (pending ? ` (including a capture_pending declaration: ${pending})` : '') +
              `; no durable capture covers this session-boundary residue, so ONE capture_owed item now carries the debt — verify it against HEAD when draining. The registers were cleared so they cannot pollute this session's duty cycle.`;
          }
        }
      }
      for (const p of regPaths) rmSync(p, { force: true });
    }
  }
} catch {
  // fail-open — residue conversion must never break SessionStart
}

let counts = { todos: 0, maintenance: 0, groupedTodos: 0, objectives: 0 };
let queueReasons = [];
let queueReasonEntries = [];
let drainable = 0;
let parked = 0;
try {
  // TRUE totals (AC1): store.count() runs the same §3.4 base filter as
  // query() with no rank/cap applied — it is the count-capable surface, never
  // a capped read (a fixed query cap, however generous, silently truncates a
  // queue that outgrows it; the historical instance under-reported 60 against
  // a true 102). The per-lane/objective breakdown still needs the actual
  // records (system_reason/objective aren't count()-filterable), so each
  // query below is capped at its own already-known true total — it can never
  // truncate, because the cap IS the count.
  const userTotal = store.count({ types: ['todo'], source: 'user' });
  counts.todos = userTotal;
  const userTodos = userTotal > 0 ? store.query({ types: ['todo'], source: 'user', cap: userTotal }) : [];
  // Objective grouping (decision foreign_a8d2ce6c): the banner discloses how many of
  // the open tasks are slices of larger objectives, so a sliced board reads
  // as N objectives to the human too — not only in the TUI's grouped view.
  const grouped = userTodos.filter((t) => t.objective);
  counts.groupedTodos = grouped.length;
  counts.objectives = new Set(grouped.map((t) => t.objective)).size;

  const systemTotal = store.count({ types: ['todo'], source: 'system' });
  counts.maintenance = systemTotal;
  const system = systemTotal > 0 ? store.query({ types: ['todo'], source: 'system', cap: systemTotal }) : [];
  // file_parked closes at branch merge (direct-merge sweeps it), never by
  // draining — counting it toward the deep-queue threshold makes H1 cry wolf
  // about items no drain can touch, and a standing warning about undrainable
  // items trains the operator to ignore the warning (2026-08-09 consuming
  // project: 15 by-design-open file_parked items tripped this every session
  // start). It stays in counts.maintenance (the human's banner shows the true
  // total); only the DRAIN signal excludes it.
  const drainableItems = system.filter((t) => t.system_reason !== 'file_parked');
  drainable = drainableItems.length;
  parked = system.length - drainable;
  // Lane breakdown for the deep-queue signal below: a bare total says "drain",
  // a per-lane split says WHAT is owed, which is what decides how to drain it.
  // Phrased as "N item(s) in lane <reason>" (not "<reason> ×N"): a lane
  // legitimately landing on a round number (e.g. 100) must read unambiguously
  // as a per-lane count, never as evidence of a silent truncation to some
  // common cap literal.
  const byReason = new Map();
  for (const t of drainableItems) byReason.set(t.system_reason, (byReason.get(t.system_reason) ?? 0) + 1);
  queueReasonEntries = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  queueReasons = queueReasonEntries.map(([r, n]) => `${n} item${n === 1 ? '' : 's'} in lane ${r}`);
} finally {
  store.close();
}

// DEEP-QUEUE SIGNAL TO THE CONDUCTOR (config.maintenance_queue.deep_threshold).
// The counts above go to the human as a systemMessage, which the MODEL never
// sees — correct while the queue is shallow and event-drained, wrong once it is
// deep, because the human is not the one who drains it. A consuming project
// reached 63 items, most of them work finished days earlier and never closed,
// with nothing anywhere prompting a drain (reported 2026-07-29). Silent below the
// threshold (P1); above it, states the depth, the lanes, and the remedy.
//
// TWO TIERS (board 91fc3d6f): "drain it before taking new work" is an honest ask
// at a few dozen items, but not at hundreds — a consuming project measured 247
// drainable items against 5 closed in one drain pass, i.e. an instruction whose
// only honest response was to ignore it ("is not a drain, it is evaporation").
// TOO_DEEP_MULTIPLIER anchors the second tier off the SAME deep_threshold that
// gates the first: at 10x threshold (default 150), naming every lane is no
// longer readable and a blanket "drain it" is no longer actionable, so the
// message switches to naming the top few lanes by count with a BOUNDED ask
// (drain the biggest lane, or board a dedicated drain slice for the rest)
// instead of repeating the same unattainable instruction at a larger number.
const TOO_DEEP_MULTIPLIER = 10;
let queueContext = '';
// Clamped to >= 1 (reviewer F1): a corrupt/hostile deep_threshold <= 0 would
// otherwise make BOTH tier conditions true even on an EMPTY drainable queue —
// queueReasonEntries[0] would then be undefined and the destructure below
// would throw OUTSIDE this try/finally, crashing H1 non-zero and losing the
// whole injection (including an already-consumed rotation note — unrecoverable).
const deepThreshold = Math.max(1, config?.maintenance_queue?.deep_threshold ?? 15);
if (drainable >= deepThreshold) {
  const parkedNote =
    parked > 0 ? ` plus ${parked} file_parked (close at branch merge, not by drain — excluded from this count)` : '';
  // Second guard (reviewer F1, belt-and-suspenders alongside the clamp above):
  // never take the very-deep branch with an empty lane breakdown — fall back
  // to the modest-tier wording instead of destructuring an undefined entry.
  if (drainable >= deepThreshold * TOO_DEEP_MULTIPLIER && queueReasonEntries.length) {
    // Every count named below stays in the "N item(s) in lane X" shape (never a
    // bare number) — the same phrasing the moderate tier already uses — so a
    // lane count can never be misread as a truncated/capped total.
    const topLanes = queueReasons.slice(0, 3);
    const [topReason, topCount] = queueReasonEntries[0];
    const topPhrase = `${topCount} item${topCount === 1 ? '' : 's'} in lane ${topReason}`;
    // "too many to name in full" is only true past the top-3 we actually show
    // (reviewer cosmetic note: it read as false with exactly 2 lanes).
    const laneLead =
      queueReasonEntries.length > topLanes.length
        ? `Too many lanes to name in full, and "drain it all before new work" is not a workable ask at this size. The biggest lanes: ${topLanes.join(', ')}. `
        : `"Drain it all before new work" is not a workable ask at this size. The lane split: ${topLanes.join(', ')}. `;
    queueContext =
      `\n\nMAINTENANCE QUEUE IS VERY DEEP — ${drainable} drainable items across ${queueReasonEntries.length} lane(s)${parkedNote}.\n` +
      laneLead +
      `Drain the biggest lane now (${topPhrase}), or board a dedicated drain slice for the rest — don't try to clear the whole queue in one pass. ` +
      `Expect much of it to be ALREADY DONE work never closed, so verify each item against HEAD before writing anything back ` +
      `(an already-paid item closes with board_remove and NO knowledge_update). ` +
      `A queue this deep is itself a signal: items are arriving faster than anyone is closing them.`;
  } else {
    queueContext =
      `\n\nMAINTENANCE QUEUE IS DEEP — ${drainable} drainable items (${queueReasons.join(', ')})${parkedNote}.\n` +
      `Drain it with /sterling:drain before taking new work, and expect much of it to be ALREADY DONE: ` +
      `the queue records debt the mechanism detected, not debt that is necessarily still owed, so each item is verified against HEAD first ` +
      `(an already-paid item closes with board_remove and NO knowledge_update — a version bump claiming a reconcile that added nothing is itself drift). ` +
      `A deep queue is also a signal in its own right: items that keep arriving faster than they close mean either the drain is being skipped or a hook is over-firing.`;
  }
  // The maintenance-item COUNT itself (in the systemMessage banner above) is a
  // persistent visibility count by design: items close only at their
  // lane-specific events (e.g. file_parked only at merge), so a stable count
  // is not a failed drain — that attribution belongs here, on the surface
  // that carries prose, not on the banner's pinned counts-only contract.
  queueContext +=
    ' This is a persistent visibility count by design — items close only at their lane-specific events, e.g. file_parked only at merge, so a stable count is not a failed drain.';
}

// shared project registry (decision foreign_8f9e6db2): touch THIS project's last_seen
// for the session, and make the CONDUCTOR aware of sibling projects via
// additionalContext (NOT systemMessage — this is conductor awareness, not a
// human banner). Only if the registry exists (init creates it) — H1 never
// creates it, and touchLastSeen no-ops for a project that was never registered.
// Missing (stale) siblings are excluded — irrelevant to the conductor; the
// /sterling:projects peek surfaces them for human pruning.
let registryContext = '';
if (existsSync(registryPath())) {
  const cwdPosix = input.cwd.replace(/\\/g, '/');
  const registry = new ProjectRegistry(registryPath());
  try {
    registry.touchLastSeen(cwdPosix, new Date().toISOString());
    const siblings = registry.list().filter((p) => p.repo_path !== cwdPosix && existsSync(p.repo_path));
    if (siblings.length) {
      registryContext =
        '\n\nSibling Sterling projects on this machine (shared project registry) — other initialized projects; ' +
        'knowledge in any domain you both declare (stack_tags) is shared through the per-user domain stores:\n' +
        siblings.map((p) => `- ${p.name}: ${p.stack_tags.join(', ') || '(no domains)'}`).join('\n');
    }
  } finally {
    registry.close();
  }
}

/** Is the process that wrote the marker still alive — and actually the WRITER?
 *  signal 0 probes existence without delivering a signal: success or EPERM
 *  (exists, not ours to signal) = a live process; ESRCH = confirmed dead; any
 *  other error = null (indeterminate — caller must not suppress a real warning
 *  on it). Existence alone over-warns: pid numbering resets on reboot (WSL
 *  restarts routinely), so an orphan marker's pid is often REUSED by an
 *  unrelated process and the dead-writer suppression (decision foreign_132177d2) fails
 *  — observed 2026-07-02. On Linux, confirm identity via /proc/<pid>/cmdline:
 *  the writer is always the MCP server, launched from .../packages/mcp-server/
 *  dist, so a live cmdline WITHOUT 'mcp-server' is a reused pid = confirmed
 *  not-the-writer = dead. An empty/unreadable cmdline or a non-Linux platform
 *  keeps the existence verdict (err loud: a missed real warning is worse than
 *  a rare false one). */
function markerWriterAlive(pid) {
  if (!Number.isInteger(pid)) return null;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code !== 'EPERM') return null;
  }
  if (process.platform !== 'linux') return true;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
    if (cmdline && !cmdline.includes('mcp-server')) return false; // reused pid — not the writer
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ESRCH') return false; // exited between probe and read
    // other read errors: identity indeterminate — keep the existence verdict
  }
  return true;
}

// stale-server guard (P5/P7): a running MCP server older than the current built
// server silently serves OLD behavior (the domain-stores incident). Compare the
// build-id the server recorded at boot to the current built id; warn the human
// loudly to restart. Fail-open: a missing marker or build-id is 'unknown', never
// a false alarm (P1). STERLING_SERVER_DIST overrides the dist lookup for tests.
let staleWarning = '';
try {
  const root = pluginRoot();
  const serverDist = process.env.STERLING_SERVER_DIST ?? (root ? join(root, 'packages', 'mcp-server', 'dist') : null);
  const currentBuildId = serverDist && existsSync(buildIdPath(serverDist)) ? readFileSync(buildIdPath(serverDist), 'utf8').trim() || null : null;
  let marker = null;
  const markerPath = runtimeMarkerPath(join(input.cwd, '.sterling', 'sterling.db'));
  if (existsSync(markerPath)) {
    const parsed = runtimeMarkerSchema.safeParse(JSON.parse(readFileSync(markerPath, 'utf8')));
    if (parsed.success) marker = parsed.data;
  }
  // Is the process that wrote the marker still alive AND the writer? A confirmed-
  // dead (or confirmed-reused-pid) writer is an ORPHANED marker from a server we
  // have since replaced (the restart-after-rebuild race — no platform ordering
  // guarantee between this hook and the new server's boot write). Dead → suppress;
  // indeterminate (null) → still warn.
  const verdict = stalenessVerdict(currentBuildId, marker, marker ? markerWriterAlive(marker.pid) : null);
  if (verdict.state === 'stale') {
    staleWarning = `⚠ Sterling MCP server is STALE — running build ${verdict.running}, current ${verdict.current}. RESTART THE SESSION to load the current server (a stale server silently mis-stores domain writes) — that means EXIT AND RELAUNCH the Claude Code CLI; a /clear is NOT enough, the MCP server survives it. `;
  }
} catch {
  // fail-open — the staleness guard must never break SessionStart
}

// Machine-activation guard (todo 8789eccf, anti_pattern foreign_60e8463d): installed
// agents bake node paths per machine context (d53dc92c); a WSL↔Windows context
// flip leaves every agent hook failing non-blocking — the enforcement floor is
// silently absent while sync-agents' hash bookkeeping reads up_to_date. Probe
// the baked node paths of Sterling-generated installs at session start and
// warn BOTH surfaces: the human (systemMessage) and the conductor
// (additionalContext, with the recovery duty). Fail-open — the probe must
// never break SessionStart.
//
// DEGRADE LOUD, NEVER SILENT (board 4fa477f2) — the same repair the agent-
// currency block below carries, not a second shape. The enumeration and every
// per-file read used to sit under the single outer catch behind an existsSync
// gate, so ONE subdirectory named `x.md` (EISDIR), ONE EACCES file or ONE race
// deletion discarded the whole check and the dead-hooks warning never rendered —
// for ANY agent, including the perfectly readable ones. A partial failure
// reported as a total absence, in the guard whose entire purpose is to refuse to
// be silent about absent enforcement (02a1ed39: nine consecutive `up_to_date`
// while every agent hook was dead). Only the outermost catch stays silent.
let machineWarning = '';
let machineContext = '';
try {
  const agentsDir = join(input.cwd, '.claude', 'agents');
  const dead = [];
  const unknown = [];
  let dirEntries = null;
  try {
    dirEntries = readdirSync(agentsDir);
  } catch (err) {
    // ENOENT/ENOTDIR: the project simply has no installed agents — nothing to
    // activate and nothing to report. Anything else (EACCES, ELOOP, EIO) means we
    // COULD NOT LOOK, and the existsSync() this replaced answered `false` to
    // exactly that, silently.
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
      unknown.push(
        `- .claude/agents/ — activation UNKNOWN for EVERY agent in this project: the installed-agent directory could not be enumerated (${err?.code ?? err?.message ?? err})`
      );
    }
  }
  for (const f of (dirEntries ?? []).filter((n) => n.endsWith('.md'))) {
    let content = null;
    try {
      content = readFileSync(join(agentsDir, f), 'utf8');
    } catch (err) {
      unknown.push(`- ${f} — activation UNKNOWN: the installed file could not be read (${err?.code ?? err?.message ?? err})`);
      continue;
    }
    if (!parseInstalledHeader(content)) {
      // A genuinely FOREIGN file is not Sterling's to judge and stays silent —
      // but "unparseable" must never be read as "not ours": a file still carrying
      // the generated marker, or one that is empty/truncated, is a DAMAGED
      // Sterling install whose hooks may well be dead, and filing it under
      // foreign retires it from this check permanently and silently.
      if (content.includes('sterling-generated') || content.trim() === '') {
        unknown.push(
          `- ${f} — activation UNKNOWN: no readable sterling-generated header (damaged, truncated or empty), so whether its hook commands resolve on this machine cannot be determined — delete it and re-install rather than assume it is active`
        );
      }
      continue;
    }
    const unresolved = extractBakedCommandPaths(content).find((p) => !existsSync(p));
    if (unresolved) dead.push({ agent: f, node: unresolved });
  }
  if (dead.length || unknown.length) {
    machineWarning =
      (dead.length
        ? `⚠ ${dead.length} installed agent(s) carry hook commands baked for ANOTHER machine context ` +
          `(e.g. ${dead[0].agent} → ${dead[0].node}) — their hooks fail silently. `
        : '') +
      (unknown.length
        ? `⚠ ${unknown.length} installed agent file(s) could not be checked at all — whether their hooks run on this machine is UNKNOWN. `
        : '') +
      `Run /sterling:sync-agents from this context, then restart. `;
    machineContext =
      `\n\nMACHINE-CONTEXT DRIFT (H1): ` +
      (dead.length ? `${dead.length} inactive (${dead.map((d) => d.agent).join(', ')}); ` : '') +
      (unknown.length ? `${unknown.length} UNKNOWN (${unknown.map((x) => x.match(/- ([^ —]+)/)?.[1] ?? 'agent').join(', ')}). ` : '') +
      `Hooks for inactive agents fail non-blocking. Run /sterling:sync-agents, restart, then pass scripts/check-agents-visible.mjs before dispatching.`;
  }
} catch {
  // fail-open — never break SessionStart (P1); the check-agents-visible gate
  // still blocks subagent dispatch on the same condition. LAST RESORT only: the
  // enumeration, every per-file read and every damaged header each carry their
  // own catch and each degrades LOUD, so nothing routine reaches here (02a1ed39).
}

// AGENT CURRENCY (board 6ce18724, research_finding foreign_0038af7c). The machine-
// activation guard above asks "do these agents' hooks RUN here?"; this asks
// "are these agents the CURRENT ones?" — a different silent failure, measured
// 2026-08-28: /sterling:update's agent sync only visits projects in the SHARED
// PROJECT REGISTRY, so a project absent from it keeps its installed agents
// frozen at install date forever while its clone updates perfectly (two
// projects on this machine at 43 and 80 days, state `stale` and never
// REFUSED — never VISITED). H1 already reads the project at SessionStart, so
// the detection lands where the failure actually lives, registry membership or
// not. Distinct from the CLONE-currency signal further up (decision foreign_558895a9),
// which is correctly SILENT in the failing case because the clone is not
// behind — another clone-currency banner would close nothing.
//
// WARN ONLY, on BOTH surfaces, exactly as the 946125ff (c) precedent does:
// never a block, never a dispatch gate, and never a rewrite of an installed
// file (user-ruled 2026-08-29 — fixes (a) and (c) only).
//
// DEGRADE LOUD, NEVER SILENT: a clone template that cannot be read is reported
// as UNKNOWN currency, never omitted. anti_pattern foreign_02a1ed39 is precisely this
// check's failure mode — a staleness check that answered `up_to_date` NINE
// times while the agents were dead — so a per-agent `catch` that swallows an
// unreadable template is the defect here, not the safety net. Only the
// outermost catch stays silent, because without an installed set there is
// nothing to report on at all.
let agentCurrencyWarning = '';
let agentCurrencyContext = '';
try {
  const agentsDir = join(input.cwd, '.claude', 'agents');
  const installed = [];
  // UNKNOWN lines are seeded HERE, before any classification: a per-file failure
  // must degrade loud and must never suppress the agents that WERE readable. The
  // enumeration and the per-file read used to sit inside the outer catch alone,
  // so one subdirectory named `x.md` (EISDIR), one EACCES file or one race
  // deletion turned "nine agents 80 days stale" into COMPLETE SILENCE — a partial
  // failure reported as a total absence, which is 02a1ed39 exactly.
  const unknown = [];
  let dirEntries = null;
  try {
    dirEntries = readdirSync(agentsDir);
  } catch (err) {
    // ENOENT/ENOTDIR: the project simply has no installed agents — nothing to
    // report. Anything else (EACCES, ELOOP, EIO) means we COULD NOT LOOK, and
    // existsSync would have answered `false` to exactly that, silently.
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
      unknown.push(
        `- .claude/agents/ — currency UNKNOWN for EVERY agent in this project: the installed-agent directory could not be enumerated (${err?.code ?? err?.message ?? err})`
      );
    }
  }
  for (const n of (dirEntries ?? []).filter((x) => x.endsWith('.md'))) {
    let content = null;
    try {
      content = readFileSync(join(agentsDir, n), 'utf8');
    } catch (err) {
      unknown.push(`- ${n} — currency UNKNOWN: the installed file could not be read (${err?.code ?? err?.message ?? err})`);
      continue;
    }
    const header = parseInstalledHeader(content);
    if (header) {
      installed.push({ file: n, content, header });
      continue;
    }
    // No parseable header. A genuinely FOREIGN file is not Sterling's to judge
    // (syncAgents' foreign_file rule) and stays silent — but "unparseable" must
    // never be read as "not ours": a file that still CARRIES the generated
    // marker, or one that is empty/truncated, is a DAMAGED Sterling install and
    // is reported UNKNOWN rather than vanishing into the foreign bucket.
    if (content.includes('sterling-generated') || content.trim() === '') {
      unknown.push(
        `- ${n} — currency UNKNOWN: no readable sterling-generated header (damaged, truncated or empty), so its currency cannot be determined — delete it and re-install rather than assume it is current`
      );
    }
  }
  const unreadableBeforeClassification = unknown.length;
  if (installed.length || unknown.length) {
    const root = pluginRoot();
    const templatesDir = root ? join(root, 'agent-templates') : null;
    // The clone's roster IS its registry (the same one installAgents/syncAgents
    // read). A registry that cannot be loaded — a half-updated or broken clone —
    // cannot certify anything, so every installed agent becomes UNKNOWN rather
    // than silently current.
    let templateFor = null;
    let cloneProblem = null;
    try {
      templateFor = new Map(loadRegistry(join(templatesDir, 'registry.json')).agents.map((a) => [a.name, a.file]));
    } catch (err) {
      cloneProblem = `the clone's agent templates at ${templatesDir ?? '(plugin root unresolved)'} could not be read: ${err?.message ?? err}`;
    }
    const stale = [];
    const modified = [];
    const refusedModified = [];
    for (const { file, content, header } of installed) {
      if (!templateFor) {
        unknown.push(`- ${file} — currency UNKNOWN: ${cloneProblem}`);
        continue;
      }
      const templateFile = templateFor.get(header.template);
      if (!templateFile) {
        // The old fallback read `<template>.md` when the roster did not name the
        // agent. An ORPHAN template left behind by a roster change would then
        // match its own old hash and certify a RETIRED agent as current — silence
        // about an agent sync no longer visits at all.
        unknown.push(
          `- ${file} — currency UNKNOWN: '${header.template}' is not in the clone's current agent roster (agent-templates/registry.json), so sync never visits it — it is unmaintained here, which is not the same as current`
        );
        continue;
      }
      // CONTAINMENT before the read: neither the header's `template` nor the
      // registry's `file` is constrained to a basename, so a value like
      // '../some-file' would escape agent-templates/ and let unrelated clone
      // bytes certify an install as CURRENT. Refuse loudly instead of certifying.
      if (templateFile !== basename(templateFile) || templateFile.includes('/') || templateFile.includes('\\') || !templateFile.endsWith('.md')) {
        unknown.push(
          `- ${file} — currency UNKNOWN: its template '${templateFile}' does not name a plain .md file inside agent-templates/, so nothing outside that directory is allowed to certify it`
        );
        continue;
      }
      let templateContent = null;
      try {
        templateContent = readFileSync(join(templatesDir, templateFile), 'utf8');
      } catch (err) {
        unknown.push(`- ${file} — currency UNKNOWN: the clone template ${templateFile} could not be read (${err?.code ?? err?.message ?? err})`);
        continue;
      }
      // BOTH questions, independently. The template-hash equality used to `continue`
      // before local modification was ever consulted, so a CURRENT-but-hand-edited
      // agent was invisible while a STALE-and-edited one was reported. The two arms
      // that must stay silent (machine_rebaked, config/model divergence) are both
      // isLocallyModified === false, so they are untouched by asking.
      const templateCurrent = header.templateHash === sha256(templateContent);
      const locallyModified = isLocallyModified(content, header);
      if (templateCurrent && !locallyModified) continue; // current and untouched — say nothing (P1)
      if (locallyModified) {
        // Word it as sync actually behaves: an edited install that is template-
        // current is left alone (locally_modified_up_to_date); an edited install
        // that is ALSO behind is re-rendered when its body byte-matches the fresh
        // template (header_repaired) and refused otherwise. "sync REFUSES it" was
        // true of only one of those three outcomes.
        (templateCurrent ? modified : refusedModified).push(file);
      } else {
        stale.push(`- ${file} — STALE: installed ${String(header.installedAt).slice(0, 10)}, the clone template has changed since (an unmodified install refreshes on sight)`);
      }
    }
    if (stale.length || modified.length || refusedModified.length || unknown.length) {
      const inspected = installed.length + unreadableBeforeClassification;
      const parts = [
        stale.length ? `${stale.length} stale` : null,
        modified.length ? `${modified.length} locally modified (current template)` : null,
        refusedModified.length ? `${refusedModified.length} refused_local_modification (behind template)` : null,
        unknown.length ? `${unknown.length} of UNKNOWN currency` : null,
      ].filter(Boolean);
      const named = [...stale, ...unknown];
      const stateLines = [
        stale.length ? `stale: ${stale.map((x) => x.match(/- ([^ —]+)/)?.[1] ?? 'agent').join(', ')}` : null,
        modified.length ? `locally modified (current template): ${modified.join(', ')}` : null,
        refusedModified.length ? `refused_local_modification (behind template): ${refusedModified.join(', ')}` : null,
        unknown.length ? `unknown: ${unknown.map((x) => x.match(/- ([^ —]+)/)?.[1] ?? 'agent').join(', ')}` : null,
      ].filter(Boolean);
      agentCurrencyWarning =
        `⚠ AGENT CURRENCY: ${parts.join(', ')} of ${inspected} installed Sterling agent file(s) — ` +
        `run /sterling:sync-agents in this project, then restart. `;
      agentCurrencyContext =
        `\n\nAGENT CURRENCY (H1): ${parts.join(', ')} of ${inspected} generated agent file(s): ` +
        stateLines.join('; ') +
        `. Run /sterling:sync-agents, restart (agents load at session start), and check /sterling:projects; an unregistered project is not refreshed.`;
    }
  }
} catch {
  // fail-open — never break SessionStart (P1). This is now a LAST RESORT only:
  // the directory enumeration, every per-file read, every damaged header, every
  // per-agent template read and the clone-registry load each carry their own
  // catch and each degrades LOUD. Nothing routine reaches here (02a1ed39).
}

// UNDECLARED-SOURCE DISCLOSURE (decision undeclared-source-disclosure-per-
// file-coverage-live-h1-scan, board 44ef6838). Per-FILE live coverage scan
// against config.toolchains[].path_globs, computed FRESH every session start —
// NO cache (a stale cached scan under-reports silently, the exact silence
// this feature exists to close). DISCLOSURE ONLY: never denies, never gates,
// never boards. ABNORMAL SHAPES RENDER, never vanish (P5): git absent, spawn
// failure, timeout, output cap, or unparseable/malformed config (including a
// malformed per-entry toolchain shape — fix-round MED-1) each render ONE
// bounded 'UNDECLARED SOURCE CHECK UNAVAILABLE: <reason>' line. The ENTIRE
// ladder (config validation, git-spawn glue, classification, rendering) is
// scripts/hooks/lib/undeclared-source-scan.mjs's computeUndeclaredSourceDisclosure
// — the SAME function scripts/init-impl.mjs calls (fix-round MED-2/MED-3: one
// ladder, one semantics, so this comment is no longer an aspiration).
let undeclaredSourceContext = '';
try {
  // `config` was read ABOVE under its own guarded try/catch — null there IS
  // the malformed/missing-config case, and computeUndeclaredSourceDisclosure
  // treats it as UNAVAILABLE, never as "zero toolchains" (decision foreign_b128f79c).
  const report = computeUndeclaredSourceDisclosure({ cwd: input.cwd, config });
  if (report) undeclaredSourceContext = `\n\n${report}`;
} catch (err) {
  // Last-resort fail-open (P1): never break SessionStart. Still disclose,
  // never silence — an uncaught exception here is itself an abnormal shape.
  // computeUndeclaredSourceDisclosure already catches internally, so this is
  // truly last-resort (e.g. renderUnavailable itself throwing).
  try {
    undeclaredSourceContext = `\n\n${renderUnavailable(`unexpected error: ${err?.message ?? err}`)}`;
  } catch {
    // even rendering failed — truly last resort, stay silent rather than throw
  }
}

if (process.env.STERLING_NO_BANNER !== '1') {
  const width = Math.max(...BANNER_ROWS.map((r) => r.length));
  const version = pluginVersion();
  const versionLine = version ? `v${version}`.padStart(width) + '\n' : '';
  process.stderr.write(`${paint(BANNER_ROWS)}\n${versionLine}`);
}

// CONDUCTOR ACTIVATION MIGRATION DIAGNOSTIC (route A, decision
// conductor-instructions-via-main-session-agent-route-a): H1 no longer injects
// the contract text — .claude/agents/conductor.md IS the conductor's system
// prompt now, activated by the "agent" key in .claude/settings.json
// (install-agents/sync-agents write both). A project that has not yet run
// either since the migration has neither, so this checks both and says so
// loudly (P5) rather than leaving the conductor silently running the default
// harness prompt with no Sterling posture at all. Absent/malformed
// settings.json is tolerated — that IS the finding, not a crash. Only the
// outermost catch stays silent (same discipline as the machine-context block
// above): a failed check here must never break SessionStart.
let conductorActivationContext = '';
try {
  const settingsPath = join(input.cwd, '.claude', 'settings.json');
  let settingsAgent; // stays undefined on: file absent, malformed JSON, non-object
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settingsAgent = parsed.agent;
    } catch {
      // malformed settings.json reads the same as an absent 'agent' key below
    }
  }
  const conductorFileMissing = !existsSync(join(input.cwd, '.claude', 'agents', 'conductor.md'));
  let reason = null;
  if (settingsAgent !== 'conductor') {
    // JSON.stringify, not manual quoting: an "agent" value containing a quote or a
    // newline (however unlikely a hand-edited settings.json makes it) must never be
    // able to break this diagnostic across lines (Sol review MEDIUM finding).
    reason = settingsAgent === undefined ? 'settings key missing' : `settings key is ${JSON.stringify(settingsAgent)}`;
  } else if (conductorFileMissing) {
    reason = '.claude/agents/conductor.md missing';
  }
  if (reason !== null) {
    const clone = pluginRoot() ?? '<clone>';
    // POSIX single-quoted shell arguments (same idiom as scripts/lib/update.mjs's
    // shellQuote / packages/store's shellQuoteSingle): a clone or project path
    // containing a space must still paste as ONE argument, copy-paste safe.
    const shq = (value) => `'${String(value).split("'").join(`'\\''`)}'`;
    conductorActivationContext = `\n\nCONDUCTOR NOT ACTIVE: ${reason} — run \`node ${shq(clone)}/scripts/sync-agents.mjs --target ${shq(input.cwd)}\` then EXIT AND RELAUNCH`;
  }
} catch {
  // fail-open (P1): this diagnostic must never break SessionStart
}

const output = {
  systemMessage: `${staleWarning}${machineWarning}${agentCurrencyWarning}${currencyWarning}${counts.todos} task${counts.todos === 1 ? '' : 's'}${counts.objectives > 0 ? ` (${counts.groupedTodos} in ${counts.objectives} objective${counts.objectives === 1 ? '' : 's'})` : ''} · ${counts.maintenance} maintenance item${counts.maintenance === 1 ? '' : 's'} pending`,
  // PLAN LOCK LEADS (decision plan-lock-...): it is the authority over what this
  // session may take on, so it is read before everything else.
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: planLockContext + conductorActivationContext + rotationContext + dispatchResidueContext + residueContext + roleContext + tddPostureContext + currencyContext + registryContext + machineContext + agentCurrencyContext + queueContext + undeclaredSourceContext },
};
// R0: the payload and the exit are ONE state machine — a bare
// process.stdout.write() followed by a separate allow() can exit before the
// pipe drains (decision hook-stdout-exit-after-write-callback-bound-exit-
// deny-stays-synchronous). This is the true end of the script — nothing
// follows, so exitAfterWrite's async settle can never race a later statement.
exitAfterWrite(JSON.stringify(output), 0);
