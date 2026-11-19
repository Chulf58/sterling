// Post-update sync on OpenCode: the first ROOT session of each project in the plugin
// process runs the shared post-update sync (scripts/lib/post-update-sync.mjs, shared
// with H1) for that project, under the newest-copy-wins rule (decision
// dual-host-post-update-sync-newest-copy-wins). The result reaches the model as a
// notice: synced, refused-older or failed; equal versions say nothing. The sync
// runs in the background, so the context request that starts it never waits for
// it, and its notice shows on the next request.
//
// A root session has no parentID key in ctx.session.get's result (finding
// opencode-2-0-21-session-get-shape-and-rotation-restore-live-october-2026). The
// verdict is cached per session id, and once the sync has started for a project
// nothing is looked up again for it. On a clone the sync does not apply, and no session is
// looked up unless /sterling:update left a pending domain-map file (below).
//
// When the Sterling in use is the npm copy (`opencode plugin add`), a sync for a
// newer copy also copies that copy's dashboard out of node_modules (materializeTui,
// scripts/lib/opencode-install.mjs), so the TUI shim loads the updated dashboard;
// its rows are added to the sync notice.
//
// THE DOMAIN MAP LINE (scripts/hooks/lib/domain-notice.mjs, the rule H1 uses): the map
// runs before a due sync and its one line joins the notice of the session whose sync
// succeeds. On a clone no sync applies, but the pending file /sterling:update left
// (.sterling/domain-map-pending) is read the same way: the first root session runs the
// map, prints the line and removes the file. Nothing is applied.
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { domainMapDue, domainNotice, pendingFileNote, runDomainMapAsync } from '../../../scripts/hooks/lib/domain-notice.mjs';
import { DOMAIN_MAP_PENDING_REL } from '../../../scripts/lib/update.mjs';
import { formatOpenCodeRows, materializeTui } from '../../../scripts/lib/opencode-install.mjs';
import { createAutoUpdater, newerInstalledRoot } from '../../../scripts/lib/plugin-auto-update.mjs';
import { postUpdateApplies, postUpdateSync, runStepAsync } from '../../../scripts/lib/post-update-sync.mjs';
import { sterlingRoot } from './layer.mjs';
import { LOG_REL, errText, logLine } from './log.mjs';
import { addNotice } from './notices.mjs';
import { inWorkerChild } from './worker.mjs';
import { installHostOf } from '../../../scripts/lib/sterling-roots.mjs';

/**
 * What every location's sync in one plugin process shares (server.mjs builds one and hands
 * it to each location's createSessionSync, as it does the `started` set): started, the
 * project roots whose sync has started or been ruled out, so a project reached from two
 * locations syncs once; updater, the one daily update coordinator; state, what an update in
 * this process changed (the newest installed root, a generation count, and the generation
 * each project last synced from); lanes, one promise chain per project, so two syncs of one
 * project never overlap and a sync queued from a newer root always runs after an older one;
 * updateRun, the update handling in flight, so one result is handled once.
 * deps: started, updater, env, home, nowMs (tests).
 */
export function createSyncShared(deps = {}) {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  return {
    started: deps.started ?? new Set(),
    updater: deps.updater ?? createAutoUpdater({ env, home, nowMs: deps.nowMs }),
    state: { root: null, gen: 0, synced: new Map() },
    lanes: new Map(),
    updateRun: null,
  };
}

/**
 * Returns `syncOnce(root, sessionID)` and `syncOnce.idle()` (resolves when a started
 * sync has finished; tests). deps: getSession() returns ctx.session (null before
 * setup); now(); sterlingRoot overrides the resolved Sterling root; nodeBin is the
 * node used to run the steps (default 'node' on PATH, as the installer's MCP
 * launcher assumes: the plugin runs inside the compiled OpenCode binary,
 * @opencode/cli's bin/opencode.exe, so process.execPath is not known to be node);
 * env and home locate the npm cache and the materialized dashboard (tests). shared is
 * the process-wide state (createSyncShared); without it the instance builds its own from
 * deps (started, updater, nowMs).
 */
export function createSessionSync(deps = {}) {
  const getSession = deps.getSession ?? (() => null);
  const now = deps.now ?? (() => new Date().toISOString());
  const nodeBin = deps.nodeBin ?? 'node';
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const verdicts = new Map();
  const shared = deps.shared ?? createSyncShared(deps);
  const { started, updater, state, lanes } = shared;
  const runs = [];

  /** Runs fn after every sync of `root` queued before it, in any location of this process. */
  function serial(root, fn) {
    const prev = lanes.get(root) ?? Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    lanes.set(root, next);
    const clear = () => {
      if (lanes.get(root) === next) lanes.delete(root);
    };
    next.then(clear, clear);
    return next;
  }

  /** Queues a sync of `root` from the newest root known when it starts, and records that generation. */
  function queueSync(root, fallbackRoot, applies) {
    return serial(root, () => {
      if (applies) state.synced.set(root, state.gen);
      return run(root, state.root ?? fallbackRoot, applies);
    });
  }

  function report(root, text) {
    try {
      addNotice(root, text, now());
    } catch (e) {
      // The notice file is unwritable: stderr is the last place left.
      process.stderr.write(`[sterling] ${text} (notice not recorded: ${errText(e)})\n`);
    }
  }

  async function run(root, pluginRoot, applies) {
    // The map first: its report run registers a project the registry lacks, and the
    // sync's contract check needs that row.
    let due = null;
    let map = null;
    let unremoved = '';
    try {
      due = domainMapDue(pluginRoot, root, env);
      if (due) map = await runDomainMapAsync(pluginRoot, root, { nodeBin });
    } catch (e) {
      map = { error: errText(e) };
    }
    if (map && due === 'marker') {
      try {
        rmSync(join(root, DOMAIN_MAP_PENDING_REL), { force: true });
      } catch (e) {
        unremoved = pendingFileNote(join(root, DOMAIN_MAP_PENDING_REL), e);
        // The file is still there, so every later request would find the map due again:
        // this process says it once and leaves the retry to the next OpenCode start.
        started.add(root);
      }
    }
    const lines = [];
    let outcome = null;
    try {
      const result = applies ? await postUpdateSync({ root: pluginRoot, project: root, host: 'opencode', env, home, runStep: (r, name, args) => runStepAsync(r, name, args, { nodeBin }) }) : null;
      if (result) {
        outcome = result.outcome;
        logLine(root, `post-update sync: ${result.outcome}`);
        const tui = result.outcome === 'synced' || result.outcome === 'failed' ? dashboardLines(root, pluginRoot) : [];
        lines.push(result.context.replace(/^\n+/, ''), ...tui);
      }
    } catch (e) {
      try {
        logLine(root, `post-update sync failed: ${errText(e)}`);
      } finally {
        lines.push(`Sterling: post-update sync FAILED (${errText(e)}); no marker was written, so it retries the next time OpenCode starts. See ${LOG_REL}.`);
      }
    }
    const notice = map && (due === 'marker' || outcome === 'synced') ? domainNotice(map, { label: 'OpenCode plugin', note: unremoved }) : null;
    if (notice) lines.push(notice.context.replace(/^\n+/, ''));
    if (lines.length) report(root, lines.join('\n'));
    return outcome;
  }

  /** The npm copy's dashboard, re-materialized after an update: one line per row, or one FAILED line. */
  function dashboardLines(root, pluginRoot) {
    try {
      if (installHostOf(pluginRoot, { env, home }) !== 'opencode') return [];
      return formatOpenCodeRows({ rows: materializeTui({ pluginRoot, env, home }) });
    } catch (e) {
      logLine(root, `post-update sync: dashboard materialization failed: ${errText(e)}`);
      return [`Sterling: copying the updated dashboard out of the npm cache FAILED (${errText(e)}); the dashboard stays on the previous version until /sterling:update runs. See ${LOG_REL}.`];
    }
  }

  async function isRootSession(root, sessionID) {
    try {
      if (typeof sessionID !== 'string' || !sessionID) throw new Error('the context request carries no session id');
      const session = getSession();
      if (!session || typeof session.get !== 'function') throw new Error('ctx.session.get is unavailable');
      const info = await session.get({ sessionID });
      return !info?.parentID;
    } catch (e) {
      logLine(root, `post-update sync: session check failed for ${sessionID}: ${errText(e)}`);
      report(root, `Sterling: the post-update sync could not check whether session ${sessionID} is a root session (${errText(e)}); it waits for the next session. See ${LOG_REL}.`);
      return false;
    }
  }

  /**
   * The daily update (scripts/lib/plugin-auto-update.mjs), run in the background from the
   * first root session of a project once a day is up; it never rides the `started` latch,
   * so a long-running shared service checks again the next day. A newer generation, installed
   * by this check or already installed by another OpenCode process (newerInstalledRoot),
   * becomes the process's sync root (`state`) for every location; this project is re-synced
   * from it at once, and every other project converges at its next request.
   */
  async function updateOnce(root, runningRoot) {
    let res;
    try {
      res = await updater.check({ pluginRoot: runningRoot });
    } catch (e) {
      logLine(root, `plugin auto-update check failed: ${errText(e)}`);
      report(root, `Sterling: the daily plugin update check FAILED (${errText(e)}); it retries within the hour. See ${LOG_REL}.`);
      return;
    }
    if (res.status === 'interrupted' || res.interrupted) {
      const at = res.status === 'interrupted' ? res.at : res.interrupted;
      logLine(root, `plugin auto-update: the attempt started ${at} recorded no outcome`);
      report(root, `Sterling: the plugin update attempt started ${at} never recorded an outcome; the process running it ended first.${res.status === 'interrupted' ? ' Sterling tries again tomorrow.' : ''} See ${LOG_REL}.`);
    }
    if (res.status === 'error') {
      logLine(root, `plugin auto-update did not run (${res.kind}): ${res.reason}`);
      if (res.notify) report(root, `Sterling: the daily plugin update did not run: ${res.reason}. Sterling retries within the hour and says this once a day. See ${LOG_REL}.`);
    }
    if (res.status === 'failed') {
      logLine(root, `plugin auto-update failed: ${res.reason}`);
      report(root, `Sterling: the daily plugin update FAILED: ${res.reason}. Sterling stays on its installed version and tries again tomorrow. See ${LOG_REL}.`);
    }
    let landed = res.status === 'updated' ? { from: res.from, to: res.to, root: res.root } : null;
    if (!landed && res.status !== 'skipped') {
      try {
        const newer = newerInstalledRoot({ pluginRoot: state.root ?? runningRoot, env, home });
        if (newer) landed = { ...newer, adopted: true };
      } catch (e) {
        logLine(root, `plugin auto-update: reading the installed generation failed: ${errText(e)}`);
        report(root, `Sterling: reading which Sterling generation is installed FAILED (${errText(e)}); this process stays on its current one. See ${LOG_REL}.`);
      }
    }
    if (!landed || (state.root && resolve(state.root) === resolve(landed.root))) return;
    state.root = landed.root;
    state.gen += 1;
    logLine(root, `plugin auto-update: ${landed.from ?? '(unknown)'}→${landed.to}${landed.adopted ? ' (installed by another OpenCode process)' : ''}`);
    started.add(root);
    const outcome = await queueSync(root, landed.root, true);
    const resynced = outcome === 'synced' ? 'agents re-synced' : outcome === 'failed' ? 'the agent re-sync FAILED (see the notice above)' : 'agents re-sync when this project\'s next session starts';
    const by = landed.adopted ? ' (another OpenCode process on this machine installed it)' : '';
    report(root, `Sterling updated ${landed.from ?? '(unknown)'}→${landed.to}${by}; ${resynced}. Run /reload when no project on this shared service has in-flight tools or background work.`);
  }

  async function syncOnce(root, sessionID) {
    // The maintenance worker child leaves the sync to the user's process (worker.mjs inWorkerChild).
    if (inWorkerChild(env)) return;
    // After an update in this process, a project whose sync ran from an older generation converges again.
    const converge = () => state.gen > 0 && state.synced.get(root) !== state.gen;
    if (started.has(root) && !converge() && !updater.due()) return;
    const updateRoot = deps.sterlingRoot ?? sterlingRoot();
    const pluginRoot = state.root ?? updateRoot;
    let applies;
    let pending;
    try {
      applies = postUpdateApplies(pluginRoot, root);
      pending = domainMapDue(pluginRoot, root, env) === 'marker';
    } catch (e) {
      // Latched first, so a predicate that throws is reported once (by the fence), not per request.
      started.add(root);
      throw e;
    }
    // Where no sync applies (a clone) the root is never latched: /sterling:update can leave
    // its pending file while OpenCode runs, and the next root session has to read it.
    if (!applies && !pending) return;
    if (!verdicts.has(sessionID)) verdicts.set(sessionID, isRootSession(root, sessionID));
    if (!(await verdicts.get(sessionID))) return;
    if (applies && updater.due() && !shared.updateRun) {
      shared.updateRun = updateOnce(root, updateRoot).finally(() => { shared.updateRun = null; });
      runs.push(shared.updateRun);
    }
    if ((started.has(root) && !converge()) || lanes.has(root)) return;
    if (applies) started.add(root);
    runs.push(queueSync(root, pluginRoot, applies));
  }

  syncOnce.idle = () => Promise.all(runs).then(() => undefined);
  return syncOnce;
}
