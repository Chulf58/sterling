// The plugin's error text and its log file under .sterling/transient.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LOG_REL = '.sterling/transient/opencode-plugin.log';

export const errText = (e) => String((e && e.message) || e);

export function logLine(root, line) {
  const p = join(root, LOG_REL);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
}
