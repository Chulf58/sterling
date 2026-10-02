// The maintenance-worker launch that follows a settlement, when `claude` is on PATH.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { loadConfig } from '../../../scripts/hooks/lib/common.mjs';
import { maybeLaunchMaintenanceWorker } from '../../../scripts/hooks/lib/maintenance-worker.mjs';
import { errText, logLine } from './log.mjs';
import { addNotice } from './notices.mjs';

export function claudeOnPathDefault() {
  return (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'claude')));
}

/** `launchWorkerFor(root, at)`: launch the worker for `root`. `claudeOnPath` and `launchWorker` default to the real ones. */
export function createWorkerLaunch({ openStore, claudeOnPath = claudeOnPathDefault, launchWorker = maybeLaunchMaintenanceWorker }) {
  return function launchWorkerFor(root, at) {
    if (!claudeOnPath()) return;
    let workerStore;
    try {
      workerStore = openStore(join(root, '.sterling', 'sterling.db'));
      launchWorker({ root, config: loadConfig(root), store: workerStore, trigger: 'stop', spawn });
    } catch (e) {
      logLine(root, `maintenance worker launch failed: ${errText(e)}`);
      addNotice(root, `Sterling: the maintenance worker could not be launched (${errText(e)}).`, at);
    } finally {
      workerStore?.close();
    }
  };
}
