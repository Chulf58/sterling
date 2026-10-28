// Reader for the per-project multi-session opt-in (config.multi_session; decision
// sterling-ports-ch-hub-s-whole-multi-session-toolkit-session). Dependency-light on
// purpose: no workspace imports, so any script can use it.
//
// An ABSENT key (or absent config file) is the shipped default "off", never an error
// (hazard e0d280ee: a posture line must not collapse absent into unusable). A key that
// is PRESENT but malformed throws: the author believes they set something.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_SESSIONS = 1;

/** Returns { enabled, max_sessions, source: 'default' | 'config' }. */
export function readMultiSession(projectRoot) {
  const configPath = join(projectRoot, '.sterling', 'config.json');
  if (!existsSync(configPath)) return { enabled: false, max_sessions: DEFAULT_MAX_SESSIONS, source: 'default' };
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  const declared = raw && typeof raw === 'object' ? raw.multi_session : undefined;
  if (declared === undefined) return { enabled: false, max_sessions: DEFAULT_MAX_SESSIONS, source: 'default' };
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new Error('config multi_session must be an object {enabled, max_sessions}');
  }
  const enabled = declared.enabled === undefined ? false : declared.enabled;
  const max = declared.max_sessions === undefined ? DEFAULT_MAX_SESSIONS : declared.max_sessions;
  if (typeof enabled !== 'boolean') throw new Error('config multi_session.enabled must be true or false');
  if (!Number.isInteger(max) || max < 1) throw new Error('config multi_session.max_sessions must be a positive integer');
  return { enabled, max_sessions: max, source: 'config' };
}

/** Refusal text for a NEW launch or delivery while the toolkit is off. */
export function multiSessionRefusal(action) {
  return (
    `refused: ${action} needs the multi-session toolkit, which is off for this project ` +
    '(multi_session.enabled is false by default). Set multi_session.enabled to true in the TUI System tab, ' +
    'or with config_set path "multi_session.enabled" value true (set multi_session.max_sessions for more than 1 session).'
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
