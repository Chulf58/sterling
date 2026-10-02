// The maintenance-worker launch that follows a settlement, when `claude` is on PATH.
// With no `claude` the skip is loud (decision
// sterling-is-fully-standalone-on-opencode-2-full-parity-with-claude-code: "a
// skip is never silent"): one notice and one log line per plugin process.
// The worker lib spawns its runner with process.execPath, which inside
// OpenCode is the compiled OpenCode binary, not node; the launch swaps in
// `node` from PATH, and with no node the skip is loud the same way.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { loadConfig } from '../../../scripts/hooks/lib/common.mjs';
import { maybeLaunchMaintenanceWorker } from '../../../scripts/hooks/lib/maintenance-worker.mjs';
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

export const NO_RUNNER_TEXT =
  'Sterling: the maintenance worker did not run. No maintenance runner exists on this machine: the only runner today is `claude -p`, and `claude` is not on PATH. Board item Parity P8 (the maintenance worker runs without Claude Code) adds an OpenCode-based runner; until then the maintenance queue drains only by hand (/sterling:drain).';

/**
 * `launchWorkerFor(root, at)`: launch the worker for `root`. `claudeOnPath`,
 * `launchWorker`, `nodeOnPath`, `execPath` and `spawnImpl` default to the real
 * ones (tests inject them).
 */
export function createWorkerLaunch({
  openStore,
  claudeOnPath = claudeOnPathDefault,
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
  return function launchWorkerFor(root, at) {
    if (!claudeOnPath()) {
      skipOnce(root, at, 'maintenance worker skipped: no maintenance runner on this machine (`claude` is not on PATH; board item Parity P8 adds an OpenCode runner)', NO_RUNNER_TEXT);
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
      const result = launchWorker({ root, config: loadConfig(root), store: workerStore, trigger: 'stop', spawn: spawnNode });
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
