// Is the session a hook runs for a Claude Code DAEMON SPARE? (decision
// `h1-skips-a-claude-code-daemon-spare-session`, finding
// `claude-code-daemon-spare-session-fires-sessionstart-in-the-project-october-2026`.)
//
// Claude Code's background supervisor keeps an idle, pre-warmed session beside
// the real one. A named spare runs the project's SessionStart hook while idle,
// under its own session id. Measured on Claude Code 2.1.289: each session
// process has one file at <claude dir>/sessions/<pid>.json, and a spare's file
// carries `"spare": true` next to its `sessionId`; a real session's file has no
// `spare` key. When a spare is claimed, SessionStart fires again and the key is
// gone by then, so skipping the spare's own SessionStart loses nothing.
//
// The file and the key are UNDOCUMENTED. Every doubt therefore answers "not a
// spare", which is the behaviour from before this module existed: a missing
// directory, an unreadable or non-JSON file, an absent key, a value that is not
// the boolean true, a missing session id. If Claude Code renames either, the
// guard stops firing; it never starts skipping real sessions.
//
// ONE DISSENTING FILE WINS. The files are named by pid, so a file left behind
// by a dead spare can sit beside the real session's own file for the same id.
// Every file for the id is therefore read before answering: a file whose pid
// names a process that no longer exists is ignored, and of the rest a single
// one without `spare === true` answers "not a spare".
//
// Dependency-light: node builtins only, no workspace imports, never throws.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The whole stdout of a skipped session start. */
export const SPARE_SKIP_LINE = 'Sterling: session start skipped for a Claude Code daemon spare session.';

/** At most this many `.json` files are read, in name order. One file exists per session process, so a real directory holds a handful. */
export const SESSION_FILE_CAP = 256;

// A measured session file is a few hundred bytes; anything this large is not one.
const SESSION_FILE_MAX_BYTES = 64 * 1024;

/**
 * <CLAUDE_CONFIG_DIR, else <home>/.claude>/sessions, the directory Claude Code
 * writes its per-process session files to. `home` is a path or a function
 * returning one; it is resolved only when CLAUDE_CONFIG_DIR is empty. Throws
 * when that lookup throws.
 */
export function claudeSessionsDir({ env = process.env, home = homedir } = {}) {
  return join(env.CLAUDE_CONFIG_DIR || join(typeof home === 'function' ? home() : home, '.claude'), 'sessions');
}

// A file's pid is usable when it is a positive integer. Only ESRCH proves the
// process is gone; EPERM means it exists under another user, and any other
// failure is doubt, which keeps the file in the count.
function pidIsDead(pid, kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return false;
  } catch (e) {
    return e?.code === 'ESRCH';
  }
}

/**
 * True only when at least one regular file `<sessions dir>/*.json` has
 * `sessionId === sessionId` and a pid that is not dead, and EVERY such file has
 * `spare === true`. Names that do not end in `.json` (the `<pid>.<hex>.key`
 * files) are never opened. False for everything else, including every error.
 */
export function isSpareSession(sessionId, { env = process.env, home = homedir, cap = SESSION_FILE_CAP, kill = process.kill.bind(process) } = {}) {
  try {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const dir = claudeSessionsDir({ env, home });
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name)
      .sort()
      .slice(0, cap);
    let spares = 0;
    for (const name of names) {
      let entry;
      try {
        const file = join(dir, name);
        if (statSync(file).size > SESSION_FILE_MAX_BYTES) continue;
        entry = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue; // an unreadable or non-JSON file says nothing about this session
      }
      if (!entry || typeof entry !== 'object' || entry.sessionId !== sessionId) continue;
      if (pidIsDead(entry.pid, kill)) continue;
      if (entry.spare !== true) return false;
      spares += 1;
    }
    return spares > 0;
  } catch {
    return false;
  }
}
