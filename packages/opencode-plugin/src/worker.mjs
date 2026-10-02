// The maintenance-worker launch that follows a settlement. The runner host is
// `claude -p` when `claude` is on PATH; otherwise it is `opencode run` through
// the OpenCode binary this plugin runs inside (board item Parity P8). With
// neither the skip is loud (decision
// sterling-is-fully-standalone-on-opencode-2-full-parity-with-claude-code: "a
// skip is never silent"): one notice and one log line per plugin process.
// The worker lib spawns its runner with process.execPath, which inside
// OpenCode is the compiled OpenCode binary, not node; the launch swaps in
// `node` from PATH, and with no node the skip is loud the same way.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { loadConfig } from '../../../scripts/hooks/lib/common.mjs';
import { maybeLaunchMaintenanceWorker, OPENCODE_MODEL_UNSET, opencodeModelOf } from '../../../scripts/hooks/lib/maintenance-worker.mjs';
import { errText, logLine } from './log.mjs';
import { addNotice } from './notices.mjs';

const onPath = (name) => (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, name)));

export function claudeOnPathDefault() {
  return onPath('claude');
}

export function nodeOnPathDefault() {
  return onPath('node') || (process.platform === 'win32' && onPath('node.exe'));
}

/** Whether `execPath` is a node binary (so the lib's process.execPath spawn runs the runner as written). */
export const isNodeBinary = (execPath) => /^node(\.exe)?$/i.test(String(execPath ?? '').split(/[\\/]/).pop());

/** The OpenCode binary to run `opencode run` with: the host binary itself
 *  (process.execPath inside OpenCode is the OpenCode binary, finding
 *  opencode-2-0-21-tool-shapes-execpath-and-shell-store-guard-october-2026),
 *  or null. Not `opencode` from PATH: it can be another OpenCode version than
 *  the one running this plugin (this machine's PATH has 1.18.31). */
export function opencodeBinDefault(execPath = process.execPath) {
  return !isNodeBinary(execPath) && /opencode/i.test(String(execPath ?? '').split(/[\\/]/).pop()) ? execPath : null;
}

export const NO_RUNNER_TEXT =
  'Sterling: the maintenance worker did not run. No maintenance runner exists on this machine: the worker runs `claude -p` or `opencode run`, and neither `claude` nor an OpenCode binary was found (this plugin is not running inside an OpenCode binary). The maintenance queue drains only by hand (/sterling:drain) until one is installed.';

/**
 * `launchWorkerFor(root, at)`: launch the worker for `root`. `claudeOnPath`,
 * `opencodeBin`, `launchWorker`, `nodeOnPath`, `execPath` and `spawnImpl`
 * default to the real ones (tests inject them).
 */
export function createWorkerLaunch({
  openStore,
  claudeOnPath = claudeOnPathDefault,
  opencodeBin = null,
  launchWorker = maybeLaunchMaintenanceWorker,
  nodeOnPath = nodeOnPathDefault,
  execPath = process.execPath,
  spawnImpl = spawn,
}) {
  const skipReported = new Set();
  function skipOnce(root, at, logText, noticeText) {
    if (skipReported.has(root)) return;
    skipReported.add(root);
    logLine(root, logText);
    addNotice(root, noticeText, at);
  }
  const findOpencode = opencodeBin ?? (() => opencodeBinDefault(execPath));
  return function launchWorkerFor(root, at) {
    const ocBin = claudeOnPath() ? null : findOpencode();
    // No host field means 'claude', the lib's default.
    const runnerHost = ocBin ? { host: 'opencode', opencodeBin: ocBin } : {};
    if (!ocBin && !claudeOnPath()) {
      skipOnce(root, at, 'maintenance worker skipped: no maintenance runner on this machine (`claude` is not on PATH and no OpenCode binary was found)', NO_RUNNER_TEXT);
      return;
    }
    const config = loadConfig(root);
    // No model, no OpenCode run (decision
    // opencode-maintenance-worker-refuses-without-a-configured-model): one loud
    // notice per process, like the no-runner skip, never OpenCode's default model.
    if (ocBin && opencodeModelOf(config) === null) {
      skipOnce(root, at, `maintenance worker skipped: ${OPENCODE_MODEL_UNSET}`, `Sterling: the maintenance worker did not run. ${OPENCODE_MODEL_UNSET}.`);
      return;
    }
    const nodeCmd = isNodeBinary(execPath) ? execPath : nodeOnPath() ? 'node' : null;
    if (!nodeCmd) {
      skipOnce(
        root,
        at,
        `maintenance worker skipped: the plugin runs in ${execPath}, not node, and no node is on PATH to run the worker`,
        `Sterling: the maintenance worker did not run. This plugin runs inside ${execPath}, which is not node, and no \`node\` is on PATH to run the worker's runner script. Install Node.js on PATH, or drain the maintenance queue by hand (/sterling:drain).`
      );
      return;
    }
    // The lib spawns its runner as process.execPath; run that with nodeCmd.
    const spawnNode = (cmd, args, opts) => spawnImpl(cmd === process.execPath ? nodeCmd : cmd, args, opts);
    let workerStore;
    try {
      workerStore = openStore(join(root, '.sterling', 'sterling.db'));
      const result = launchWorker({ root, config, store: workerStore, trigger: 'stop', spawn: spawnNode, ...runnerHost });
      if (result?.reason === 'error') {
        logLine(root, `maintenance worker launch failed: ${result.detail ?? 'no detail'}`);
        addNotice(root, `Sterling: the maintenance worker could not be launched (${result.detail ?? 'no detail'}).`, at);
      }
    } catch (e) {
      logLine(root, `maintenance worker launch failed: ${errText(e)}`);
      addNotice(root, `Sterling: the maintenance worker could not be launched (${errText(e)}).`, at);
    } finally {
      workerStore?.close();
    }
  };
}
