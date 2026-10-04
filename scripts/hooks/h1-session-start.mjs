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
import { pluginRoot as sharedPluginRoot, walkUpPluginRoot as sharedWalkUpPluginRoot } from './lib/plugin-root-walk.mjs';
import { readStdin, allow, exitAfterWrite, openStore } from './lib/common.mjs';
import { codexRegistrationLine, userScopeCodexServer } from '../lib/codex-mcp.mjs';
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
import { probeDirtyPaths, formatResidueLine, fileEntriesOf } from './lib/dispatch-residue.mjs';
import { withRegisterLock, readRegister, registerPath, sessionBoundarySweep } from '../lib/dispatch-register.mjs';
import { disclosure, render } from '../lib/review-errors.mjs';
import { consumeRotationNote, renderRotationRestore } from './lib/rotation-restore.mjs';
import { renderUnavailable } from './lib/undeclared-source.mjs';
import { handoffFilesLine, machineRoleLine, mountedDomainLines, pendingIssueReportsLine, projectModeLine, readProjectConfig, sterlingRootLine, tddPostureLine } from './lib/operating-state.mjs';
import { computeUndeclaredSourceDisclosure } from './lib/undeclared-source-scan.mjs';
import { SUPPORTED_SCHEMA_VERSION } from '@sterling/store';
import { buildIdPath, runtimeMarkerPath, runtimeMarkerSchema, stalenessVerdict } from '@sterling/schemas';
import { parseInstalledHeader, extractBakedCommandPaths, isLocallyModified, loadRegistry, sha256 } from '../lib/agent-distribution.mjs';
import { gitTouches, writeInitialGitSettled } from './lib/settlement.mjs';
import { isInstalledCopy } from '../lib/installed-copy.mjs';
import { pluginScript, postUpdateSync, samePath } from '../lib/post-update-sync.mjs';
import { DOMAIN_MAP_PENDING_REL, machineStores, probeSchemaVersion } from '../lib/update.mjs';
import { domainMapDue, domainNotice, pendingFileNote, runDomainMap } from './lib/domain-notice.mjs';
import { refreshRegistryRow } from './lib/registry-refresh.mjs';
import { queueDepthLine, readMaintenanceState, reconcileBacklog } from './lib/maintenance-state.mjs';
import { laneCeiling, liveLanes, renderBoardReadiness } from './lib/board-ready.mjs';

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
        // unattempted too — the existing posture, unchanged. The same sweep
        // first MIGRATES legacy flat `<key>.json` records onto their
        // live-/done- names: this boundary, never mid-burst (decision
        // dispatch-state-status-in-filename-live-scan-parses-only-live-records).
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

// The plugin root resolvers live in lib/plugin-root-walk.mjs (shared with H10's
// shared context-window table); H1 binds them to its own module URL.
const pluginRoot = () => sharedPluginRoot(import.meta.url);
const walkUpPluginRoot = () => sharedWalkUpPluginRoot(import.meta.url);

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

/** POSIX single-quoted shell argument, so a printed path with a space pastes as ONE argument. */
function shellQuote(value) {
  return `'${String(value).split("'").join(`'\\''`)}'`;
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
    const probe = probeDirtyPaths(cwd, entry.files, [...fileEntriesOf(entry)]);
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

// STERLING ROOT (decision session-start-prints-the-sterling-root-plain-text-instructions-use-it):
// printed on every source, from the hook's own location only (the walk-up, never the
// STERLING_PLUGIN_ROOT env seam, because the model runs scripts from this path). Unresolved is
// stated loudly by sterlingRootLine, never silenced. Computed above the `if (!store)` exit so a
// Sterling project with a blocked or missing store gets it too.
let rootLocation = null;
try {
  rootLocation = walkUpPluginRoot();
} catch {
  // an unresolvable root is stated by sterlingRootLine as UNRESOLVED
}
const rootContext = `\n\n${sterlingRootLine(rootLocation)}`;

// STORE-VERSION PROBE (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
// ruling point 1 'Explicit command'): read the SQLite header user_version of the project
// store and every ~/.sterling/domains/*/sterling.db — no connection opened — and on a
// mismatch print the paste-ready migrate command. It NEVER migrates: a migration is the
// one irreversible step and runs only on the human's word. Runs BEFORE openStore because
// opening a NEWER-schema (or unreadable) store throws: such a PROJECT store takes the
// no-store exit below with this line instead of crashing SessionStart. An OLDER store
// opens read-only (packages/store's refuse-until-migrated), so H1 carries on with it.
let storeVersionWarning = '';
let storeVersionContext = '';
let projectStoreBlocked = false;
try {
  const projectDb = join(input.cwd, '.sterling', 'sterling.db');
  const behind = [];
  const other = [];
  for (const db of machineStores(input.cwd)) {
    let found;
    try {
      found = probeSchemaVersion(db);
    } catch (err) {
      other.push(`${db} (header unreadable: ${err?.message ?? err})`);
      if (db === projectDb) projectStoreBlocked = true;
      continue;
    }
    if (found === SUPPORTED_SCHEMA_VERSION) continue;
    if (found < SUPPORTED_SCHEMA_VERSION) {
      behind.push({ db, found });
      continue;
    }
    if (db === projectDb) projectStoreBlocked = true;
    other.push(`${db} (v${found}, NEWER than this Sterling's v${SUPPORTED_SCHEMA_VERSION} — update the plugin)`);
  }
  if (behind.length || other.length) {
    const root = pluginRoot();
    const migrate = root ? pluginScript(root, 'migrate-stores.mjs') : '<sterling>/scripts/migrate-stores.mjs';
    const parts = [];
    if (behind.length) {
      parts.push(
        `${behind.map((b) => `${b.db} is v${b.found}`).join(', ')}; this Sterling expects v${SUPPORTED_SCHEMA_VERSION} — run: ` +
          behind.map((b) => `node ${shellQuote(migrate)} --db ${shellQuote(b.db)}`).join(' && ')
      );
    }
    if (other.length) parts.push(`also: ${other.join(', ')}`);
    storeVersionWarning = `⚠ Sterling store schema mismatch: ${parts.join('; ')} — then EXIT AND RELAUNCH. `;
    storeVersionContext = `\n\nSTORE SCHEMA MISMATCH (H1): ${parts.join('; ')}. Nothing was migrated — a migration runs only on the user's word; tell them, then EXIT AND RELAUNCH after it.`;
  }
} catch (err) {
  storeVersionWarning = `⚠ Sterling store schema probe FAILED (${err?.message ?? err}) — store versions unknown. `;
}

// POST-UPDATE SYNC (decisions sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
// design B, and dual-host-post-update-sync-newest-copy-wins). /plugin updates the plugin but
// runs none of Sterling's post-update steps, so the first session in which this installed
// copy is NEWER than <project>/.sterling/synced-version syncs THIS project's agents and checks
// its contract; an OLDER copy refuses loudly. The rule, the steps and their text live in
// scripts/lib/post-update-sync.mjs, shared with the OpenCode server plugin. INSTALLED COPIES
// ONLY: on a clone /sterling:update owns these steps. Runs before the agent-currency block,
// which then sees the synced agents.
//
// DOMAIN MAP NOTICE (scripts/hooks/lib/domain-notice.mjs): the first session start after an
// update runs the domain map and prints one line when it proposes a mount. The map runs
// BEFORE the sync, because its report run registers a project the registry lacks and the
// sync's contract check needs that row. It never applies a mount.
let domainMapDueBy = null;
let domainMapResult = null;
try {
  domainMapDueBy = domainMapDue(pluginRoot(), input.cwd);
  if (domainMapDueBy) domainMapResult = runDomainMap(pluginRoot(), input.cwd);
} catch (err) {
  domainMapResult = { error: String(err?.message ?? err) };
}
let postUpdateWarning = '';
let postUpdateContext = '';
let postUpdateOutcome = null;
try {
  const result = await postUpdateSync({ root: pluginRoot(), project: input.cwd, host: 'claude' });
  if (result) {
    postUpdateWarning = result.warning;
    postUpdateContext = result.context;
    postUpdateOutcome = result.outcome;
  }
} catch (err) {
  postUpdateWarning = `✗ Sterling post-update sync FAILED (${err?.message ?? err}) — no marker written; it retries at the next session start. `;
}
// The notice rides the post-update strings, so both exits below print it. The update's
// pending file dies in the session start that read it (P4); with no such file the line
// waits for the session whose sync succeeded, which is the one that writes the sync marker.
if (domainMapResult) {
  let unremoved = '';
  if (domainMapDueBy === 'marker') {
    try {
      rmSync(join(input.cwd, DOMAIN_MAP_PENDING_REL), { force: true });
    } catch (err) {
      unremoved = pendingFileNote(join(input.cwd, DOMAIN_MAP_PENDING_REL), err);
    }
  }
  const notice = domainMapDueBy === 'marker' || postUpdateOutcome === 'synced' ? domainNotice(domainMapResult, { note: unremoved }) : null;
  if (notice) {
    postUpdateWarning += notice.warning;
    postUpdateContext += notice.context;
  }
}

const store = projectStoreBlocked ? null : openStore(input.cwd);
if (!store) {
  // The store-version probe and the post-update sync ride this exit too: a project
  // whose store is at another schema version lands here, and its migrate line is
  // the one thing the human must see.
  const earlyWarning = storeVersionWarning + postUpdateWarning;
  // The receipt report rides this early exit too: H22's ledger gate is
  // .sterling/config.json (not sterling.db), so a project with a config but no
  // The PLAN LOCK section rides this early exit too, leading as it does on the
  // main path: a project can hold an approved plan before its store exists, and
  // a section computed but never emitted would consume its one-shot markers
  // silently — disclosing nothing while spending the disclosure.
  // A project with a Sterling config or a blocked store is a Sterling project: its instructions
  // name <Sterling root>, so this exit prints the STERLING ROOT line too. A directory with no
  // Sterling state prints nothing.
  const sterlingProject = projectStoreBlocked || existsSync(join(input.cwd, '.sterling', 'config.json'));
  if (planLockContext || dispatchResidueLines.length || earlyWarning || sterlingProject) {
    process.stdout.write(
      JSON.stringify({
        ...(earlyWarning ? { systemMessage: earlyWarning.trim() } : {}),
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: planLockContext + dispatchResidueLines.join('\n\n') + (sterlingProject ? rootContext : '') + storeVersionContext + postUpdateContext,
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
// The three-state read (absent / unreadable / non-object) and the MACHINE ROLE,
// TDD posture and Project mode lines below live in lib/operating-state.mjs, shared
// with the OpenCode context hook; the rationale for each travels with its function.
const { config, configUnreadable } = readProjectConfig(input.cwd);
// `config` stays null-or-as-parsed, so the queue threshold and the concurrency
// ceiling keep degrading to their own defaults. Each line below is guarded like
// every other H1 read: a malformed config or unresolved plugin root costs only
// that line (fail-open).
let roleContext = '';
try {
  const root = pluginRoot();
  const installedCopy = Boolean(root && !samePath(input.cwd, root) && isInstalledCopy(root));
  const atClone = Boolean(root && samePath(input.cwd, root));
  const line = machineRoleLine({ atClone, installedCopy, config });
  if (line) roleContext = `\n\n${line}`;
} catch {
  // fail-open — a malformed config or unresolved plugin root costs only this line
}

let tddPostureContext = '';
try {
  tddPostureContext = `\n\n${tddPostureLine({ config, configUnreadable })}`;
} catch {
  // fail-open — a malformed config costs only this line
}

let modeContext = '';
try {
  modeContext = `\n\n${projectModeLine({ config, configUnreadable })}`;
} catch {
  // fail-open — a malformed config costs only this line
}

let handoffContext = '';
try {
  handoffContext = `\n\n${handoffFilesLine({ config, configUnreadable, root: input.cwd })}`;
} catch {
  // fail-open — a malformed config costs only this line
}

// MOUNTED DOMAINS (lib/operating-state.mjs): one line per configured domain with
// its description, and a loud line for a missing store or a missing description.
// It never throws: every failure is its own UNKNOWN line.
const domainLines = mountedDomainLines({ config, configUnreadable });
const domainsContext = domainLines.length ? `\n\n${domainLines.join('\n')}` : '';

// PENDING ISSUE REPORTS: the count of Sterling issue reports report-issue.mjs
// queued locally because gh could not file them (lib/operating-state.mjs). A local
// file read only, never a network call.
let issueReportsContext = '';
let issueReportsRoot = null;
try {
  issueReportsRoot = pluginRoot();
} catch {
  // a root that cannot be resolved stays null: the line then names the bin by
  // its plugin-relative path instead of being dropped
}
const issueReportsLine = pendingIssueReportsLine({ cwd: input.cwd, pluginRoot: issueReportsRoot });
if (issueReportsLine) issueReportsContext = `\n\n${issueReportsLine}`;

// CODEX REGISTRATION (decision codex-route-stays-the-pinned-0-153-4-mcp-server): one line
// when the user-level Claude config registers no `codex` MCP server. It reads
// <CLAUDE_CONFIG_DIR or home>/.claude.json and never spawns codex (anti_pattern
// codex-mcp-probe-by-exit-status). userScopeCodexServer reports an unreadable config as
// `unreadable`, which the line states, so this has no failure to swallow.
const codexLine = codexRegistrationLine(userScopeCodexServer(), { nodeBinDir: dirname(process.execPath) });
const codexContext = codexLine ? `\n\n${codexLine}` : '';

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

// ROTATION RESTORE: the note is read, consumed and rendered by
// scripts/hooks/lib/rotation-restore.mjs (shared with the OpenCode server
// plugin); its comment carries the rationale. H1 consumes on source=startup OR
// source=clear only (resume/compact must not eat a note prepared for a rotation
// that hasn't happened).
let rotationContext = '';
try {
  if (input.source === 'startup' || input.source === 'clear') {
    const note = consumeRotationNote(input.cwd);
    if (note) rotationContext = renderRotationRestore(note, { cwd: input.cwd, source: input.source, host: 'claude', planLock, planLockMalformed });
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
      ? ` NOT PROOF THAT THESE DISPATCHES ENDED: a dispatch may still be RUNNING across a /clear — cross-check the LIVE DISPATCHES line in the rotation restore above and git status before acting on these files. Those agents belong to the previous session and cannot be resumed from this one: re-dispatch fresh if the work is still needed.`
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
let reconcile = { count: 0, owesProse: 0, oldest: null };
let boardReadiness = [];
let boardReadinessError = null;
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

  const m = readMaintenanceState(store, input.cwd);
  counts.maintenance = m.total;
  reconcile = m.reconcile;
  drainable = m.drainable;
  parked = m.parked;
  queueReasonEntries = m.queueReasonEntries;
  queueReasons = m.queueReasons;
  // READY / READY FOR RESEARCH / WAITING ON YOU (decision
  // board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start):
  // the store's one readiness function; a failure is its own loud line below,
  // never a silently missing list.
  try {
    boardReadiness = store.boardReadiness();
  } catch (e) {
    boardReadinessError = (e && e.message) || String(e);
  }
} finally {
  store.close();
}

// The board readiness block: what the conductor fills free lanes from, up to the
// existing delegation.max_concurrent ceiling (lib/board-ready.mjs).
const boardReadinessText = boardReadinessError
  ? `BOARD READINESS UNAVAILABLE (${boardReadinessError}): the READY / READY FOR RESEARCH / WAITING ON YOU lists are not stated this session; read the board with board_query.`
  : renderBoardReadiness({ readiness: boardReadiness, live: liveLanes(input.cwd, input.session_id), ceiling: laneCeiling(config) });
const boardReadinessContext = boardReadinessText ? `\n\n${boardReadinessText}` : '';

// DEEP-QUEUE SIGNAL TO THE CONDUCTOR (config.maintenance_queue.deep_threshold): the
// two-tier text and its rationale live in lib/maintenance-state.mjs queueDepthLine.
const queueLine = queueDepthLine({ drainable, parked, queueReasons, queueReasonEntries, deepThreshold: config?.maintenance_queue?.deep_threshold });
const queueContext = queueLine ? `\n\n${queueLine}` : '';


// RECONCILE BACKLOG: the banner segment and the conductor line come from the shared
// lib (lib/maintenance-state.mjs reconcileBacklog), which carries the rationale.
const backlog = reconcileBacklog({ reconcile, cwd: input.cwd });
const reconcileBanner = backlog.banner;
const reconcileContext = backlog.line ? `\n\n${backlog.line}` : '';

// shared project registry (decision foreign_8f9e6db2): touch THIS project's last_seen
// for the session, and make the CONDUCTOR aware of sibling projects via
// additionalContext (NOT systemMessage — this is conductor awareness, not a
// human banner). Only if the registry exists (init creates it) — H1 never
// creates it, and touchLastSeen no-ops for a project that was never registered.
// Missing (stale) siblings are excluded — irrelevant to the conductor; the
// /sterling:projects peek surfaces them for human pruning.
// The row's stack tags are refreshed from the project's config too, so a mount added by
// a config edit reaches other projects' sibling lists by this project's next session
// start. The touch and the refresh live in scripts/hooks/lib/registry-refresh.mjs, which
// the OpenCode server plugin calls for its root sessions too.
let registryContext = '';
{
  const refreshed = refreshRegistryRow(input.cwd, { config, configUnreadable });
  const siblings = (refreshed?.siblings ?? []).filter((p) => existsSync(p.repo_path));
  if (siblings.length) {
    registryContext =
      '\n\nSibling Sterling projects on this machine (shared project registry) — other initialized projects; ' +
      'knowledge in any domain you both declare (stack_tags) is shared through the per-user domain stores:\n' +
      siblings.map((p) => `- ${p.name}: ${p.stack_tags.join(', ') || '(no domains)'}`).join('\n');
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
// The server ships as the bundle mcp/sterling-mcp.mjs with its .build-id beside it
// (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
// design A); a tree without mcp/ still runs packages/mcp-server/dist.
let staleWarning = '';
try {
  const root = pluginRoot();
  const serverDist =
    process.env.STERLING_SERVER_DIST ?? (root ? (existsSync(join(root, 'mcp')) ? join(root, 'mcp') : join(root, 'packages', 'mcp-server', 'dist')) : null);
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
    const root = pluginRoot();
    const clone = root ?? '<clone>';
    // The bundled bin/ entry on a plugin that ships one (an installed copy has no
    // scripts/ sources to run), else the clone's scripts/ source.
    const syncScript = root && existsSync(join(root, 'bin', 'sync-agents.mjs')) ? 'bin/sync-agents.mjs' : 'scripts/sync-agents.mjs';
    // POSIX single-quoted shell arguments (same idiom as scripts/lib/update.mjs's
    // shellQuote / packages/store's shellQuoteSingle): a clone or project path
    // containing a space must still paste as ONE argument, copy-paste safe.
    const shq = (value) => `'${String(value).split("'").join(`'\\''`)}'`;
    conductorActivationContext = `\n\nCONDUCTOR NOT ACTIVE: ${reason} — run \`node ${shq(clone)}/${syncScript} --target ${shq(input.cwd)}\` then EXIT AND RELAUNCH`;
  }
} catch {
  // fail-open (P1): this diagnostic must never break SessionStart
}

// The HUMAN sees the conductor diagnostic too (decision gap-hunt-2026-09-28-rulings
// item 3): additionalContext reaches only the model, so a session running without
// the conductor was invisible to the one person who can run the remedy. Same
// text, leading the banner, and the counts still close it.
const conductorActivationWarning = conductorActivationContext ? `⚠ ${conductorActivationContext.trim()}. ` : '';

const output = {
  systemMessage: `${conductorActivationWarning}${storeVersionWarning}${postUpdateWarning}${staleWarning}${machineWarning}${agentCurrencyWarning}${currencyWarning}${counts.todos} task${counts.todos === 1 ? '' : 's'}${counts.objectives > 0 ? ` (${counts.groupedTodos} in ${counts.objectives} objective${counts.objectives === 1 ? '' : 's'})` : ''} · ${counts.maintenance} maintenance item${counts.maintenance === 1 ? '' : 's'} pending${reconcileBanner}`,
  // PLAN LOCK LEADS (decision plan-lock-...): it is the authority over what this
  // session may take on, so it is read before everything else.
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: planLockContext + conductorActivationContext + storeVersionContext + postUpdateContext + rotationContext + dispatchResidueContext + residueContext + rootContext + roleContext + tddPostureContext + modeContext + handoffContext + domainsContext + issueReportsContext + codexContext + currencyContext + registryContext + machineContext + agentCurrencyContext + queueContext + reconcileContext + boardReadinessContext + undeclaredSourceContext },
};
// R0: the payload and the exit are ONE state machine — a bare
// process.stdout.write() followed by a separate allow() can exit before the
// pipe drains (decision hook-stdout-exit-after-write-callback-bound-exit-
// deny-stays-synchronous). This is the true end of the script — nothing
// follows, so exitAfterWrite's async settle can never race a later statement.
exitAfterWrite(JSON.stringify(output), 0);
