// The conductor session record (GitHub issue #187): the id of the root session the
// user last prompted in this project, written to .sterling/transient/ so the OpenCode
// launcher (templates/launcher-tmux.sh) can reopen that session with --session after a
// crash or service restart. `opencode --continue` is not used because it picks the
// most recently UPDATED root session in the directory, which can be a maintenance
// worker's session. Only a prompt counts: the user's own prompts reach the root
// session through this hook, the worker runs in its own `opencode run` child (skipped
// on its env flag) and subagents run in child sessions (skipped on parentID).
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { sessionKind } from './dispatch.mjs';
import { inWorkerChild } from './worker.mjs';

export const CONDUCTOR_SESSION_REL = '.sterling/transient/opencode-conductor-session';

/** Returns onPrompt(input): records input.sessionID when it is a root session of this project. */
export function createConductorSessionRecorder({ rootOf, fenced, getSession, parents, env = process.env }) {
  let last = null;
  return async function onPrompt(input) {
    if (inWorkerChild(env)) return;
    const root = rootOf();
    if (!root) return;
    const sessionID = input?.sessionID;
    if (typeof sessionID !== 'string' || !sessionID || `${root}\0${sessionID}` === last) return;
    await fenced('conductor-session', root, async () => {
      const kind = await sessionKind(getSession?.(), sessionID, parents);
      if (kind.why) throw new Error(`conductor session not recorded: could not tell whether session ${sessionID} is a root session (${kind.why})`);
      if (kind.kind !== 'root') return;
      const path = join(root, CONDUCTOR_SESSION_REL);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, `${sessionID}\n`);
        renameSync(tmp, path);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
      last = `${root}\0${sessionID}`;
    });
  };
}
