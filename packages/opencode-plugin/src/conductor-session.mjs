// The conductor session record (GitHub issue #187): the id of the root session the
// user last prompted in this project, written to .sterling/transient/ so the OpenCode
// launcher (templates/launcher-tmux.sh) can reopen that session with --session after a
// crash or service restart. `opencode --continue` is not used because it picks the
// most recently UPDATED root session in the directory, which can be a maintenance
// worker's session. Only a prompt counts: the user's own prompts reach the root
// session through this hook, the worker runs in its own `opencode run` child (skipped
// on its env flag) and subagents run in child sessions (skipped on parentID).
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../../../scripts/lib/opencode-install.mjs';
import { sessionKind } from './dispatch.mjs';
import { inWorkerChild } from './worker.mjs';

export const CONDUCTOR_SESSION_REL = '.sterling/transient/opencode-conductor-session';

// Process-wide, keyed by project root: the sequence number of the latest prompt seen.
// Several locations (a project root and a subdirectory) share one project and so one
// record; a prompt whose root-session check finishes after a newer prompt of the same
// project started (a slow lookup, or one the fence already timed out) writes nothing.
const latest = new Map();
let counter = 0;

/** Returns onPrompt(input): records input.sessionID when it is a root session of this project. */
export function createConductorSessionRecorder({ rootOf, fenced, getSession, parents, env = process.env }) {
  return async function onPrompt(input) {
    if (inWorkerChild(env)) return;
    const root = rootOf();
    if (!root) return;
    const sessionID = input?.sessionID;
    if (typeof sessionID !== 'string' || !sessionID) return;
    const seq = ++counter;
    latest.set(root, seq);
    await fenced('conductor-session', root, async () => {
      const kind = await sessionKind(getSession?.(), sessionID, parents);
      if (latest.get(root) !== seq) return;
      if (kind.why) throw new Error(`conductor session not recorded: could not tell whether session ${sessionID} is a root session (${kind.why})`);
      if (kind.kind !== 'root') return;
      const path = join(root, CONDUCTOR_SESSION_REL);
      const text = `${sessionID}\n`;
      let current = null;
      try {
        current = readFileSync(path, 'utf8');
      } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
      }
      if (current === text) return;
      mkdirSync(dirname(path), { recursive: true });
      writeFileAtomic(path, text);
    });
  };
}
