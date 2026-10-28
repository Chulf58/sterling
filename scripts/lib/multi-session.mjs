// Reader for the per-project multi-session opt-in (config.multi_session; decision
// sterling-ports-ch-hub-s-whole-multi-session-toolkit-session). Defaults and
// validation belong to configSchema.shape.multi_session in @sterling/schemas, which
// this file imports as board-ready.mjs does (bin/ scripts are esbuild-bundled, so
// there is no runtime workspace import there).
//
// Only a MISSING config file or a MISSING multi_session key reads as the default
// "off" (hazard e0d280ee: a posture line must not collapse absent into unusable). A
// config that is not a JSON object, or a multi_session value the schema refuses,
// throws: the author believes they set something.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configSchema } from '@sterling/schemas';
import { resolveStoreRoot } from './worktree-root.mjs';

/** Returns { enabled, max_sessions, source: 'default' | 'config' }. */
export function readMultiSession(projectRoot) {
  // A linked worktree has no .sterling/ of its own: the main checkout's config wins.
  const configPath = join(resolveStoreRoot(projectRoot), '.sterling', 'config.json');
  const schema = configSchema.shape.multi_session;
  if (!existsSync(configPath)) return { ...schema.parse({}), source: 'default' };
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${configPath} is not a JSON object — multi_session cannot be read`);
  }
  if (raw.multi_session === undefined) return { ...schema.parse({}), source: 'default' };
  const parsed = schema.safeParse(raw.multi_session);
  if (!parsed.success) {
    throw new Error(`config multi_session in ${configPath} is invalid: ${parsed.error.issues.map((i) => `${['multi_session', ...i.path].join('.')}: ${i.message}`).join('; ')}`);
  }
  return { ...parsed.data, source: 'config' };
}

/** Refusal text for a NEW launch or delivery while the toolkit is off. */
export function multiSessionRefusal(action) {
  return (
    `refused: ${action} needs the multi-session toolkit, which is off for this project ` +
    '(multi_session.enabled is false by default). Turn it on with config_set path "multi_session.enabled" value true, ' +
    'or by editing .sterling/config.json (set multi_session.max_sessions for more than 1 session).'
  );
}

/** Returns the settings when enabled; otherwise prints the refusal to stderr and exits 2. */
export function requireMultiSession(projectRoot, action) {
  const settings = readMultiSession(projectRoot);
  if (!settings.enabled) {
    process.stderr.write(multiSessionRefusal(action) + '\n');
    process.exit(2);
  }
  return settings;
}
