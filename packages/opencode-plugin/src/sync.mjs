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
// nothing is looked up again for it. On a clone the sync does not apply, and no session is looked up.
//
// When the Sterling in use is the npm copy (`opencode plugin add`), a sync for a
// newer copy also copies that copy's dashboard out of node_modules (materializeTui,
// scripts/lib/opencode-install.mjs), so the TUI shim loads the updated dashboard;
// its rows are added to the sync notice.
import { homedir } from 'node:os';
import { formatOpenCodeRows, materializeTui } from '../../../scripts/lib/opencode-install.mjs';
import { postUpdateApplies, postUpdateSync, runStepAsync } from '../../../scripts/lib/post-update-sync.mjs';
import { sterlingRoot } from './layer.mjs';
import { LOG_REL, errText, logLine } from './log.mjs';
import { addNotice } from './notices.mjs';
import { inWorkerChild } from './worker.mjs';
import { installHostOf } from '../../../scripts/lib/sterling-roots.mjs';

/**
 * Returns `syncOnce(root, sessionID)` and `syncOnce.idle()` (resolves when a started
 * sync has finished; tests). deps: getSession() returns ctx.session (null before
 * setup); now(); sterlingRoot overrides the resolved Sterling root; nodeBin is the
 * node used to run the steps (default 'node' on PATH, as the installer's MCP
 * launcher assumes: the plugin runs inside the compiled OpenCode binary,
 * @opencode/cli's bin/opencode.exe, so process.execPath is not known to be node);
 * env and home locate the npm cache and the materialized dashboard (tests). started is
 * the set of project roots whose sync has started or been ruled out; the server passes
 * one set to every location's sync, so a project reached from two locations syncs once.
 */
export function createSessionSync(deps = {}) {
  const getSession = deps.getSession ?? (() => null);
  const now = deps.now ?? (() => new Date().toISOString());
  const nodeBin = deps.nodeBin ?? 'node';
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const verdicts = new Map();
  const started = deps.started ?? new Set();
  const runs = [];

  function report(root, text) {
    try {
      addNotice(root, text, now());
    } catch (e) {
      // The notice file is unwritable: stderr is the last place left.
      process.stderr.write(`[sterling] ${text} (notice not recorded: ${errText(e)})\n`);
    }
  }

  async function run(root, pluginRoot) {
    try {
      const result = await postUpdateSync({ root: pluginRoot, project: root, host: 'opencode', env, home, runStep: (r, name, args) => runStepAsync(r, name, args, { nodeBin }) });
      if (!result) return;
      logLine(root, `post-update sync: ${result.outcome}`);
      const tui = result.outcome === 'synced' || result.outcome === 'failed' ? dashboardLines(root, pluginRoot) : [];
      report(root, [result.context.replace(/^\n+/, ''), ...tui].join('\n'));
    } catch (e) {
      try {
        logLine(root, `post-update sync failed: ${errText(e)}`);
      } finally {
        report(root, `Sterling: post-update sync FAILED (${errText(e)}); no marker was written, so it retries the next time OpenCode starts. See ${LOG_REL}.`);
      }
    }
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

  async function syncOnce(root, sessionID) {
    // The maintenance worker child leaves the sync to the user's process (worker.mjs inWorkerChild).
    if (started.has(root) || inWorkerChild(env)) return;
    const pluginRoot = deps.sterlingRoot ?? sterlingRoot();
    let applies;
    try {
      applies = postUpdateApplies(pluginRoot, root);
    } catch (e) {
      // Latched first, so a predicate that throws is reported once (by the fence), not per request.
      started.add(root);
      throw e;
    }
    if (!applies) {
      started.add(root);
      return;
    }
    if (!verdicts.has(sessionID)) verdicts.set(sessionID, isRootSession(root, sessionID));
    if (!(await verdicts.get(sessionID)) || started.has(root)) return;
    started.add(root);
    runs.push(run(root, pluginRoot));
  }

  syncOnce.idle = () => Promise.all(runs).then(() => undefined);
  return syncOnce;
}
