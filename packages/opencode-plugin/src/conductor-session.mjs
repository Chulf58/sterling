// The conductor session record (GitHub issue #187): the id of the root session the
// user last prompted in this project, written to .sterling/transient/ so the OpenCode
// launcher (templates/launcher-tmux.sh) can reopen that session with --session after a
// crash or service restart. `opencode --continue` is not used because it picks the
// most recently UPDATED root session in the directory, which can be a maintenance
// worker's session. The worker runs in its own `opencode run` child (skipped on its
// env flag) and subagents run in child sessions (skipped on parentID).
//
// INVARIANT: the record names the root session of the most recently ARRIVED user
// prompt in this project. A prompt's place in that order is fixed synchronously at
// prompt-hook entry, before any await (takePromptSeq, called first thing in
// server.mjs's onPrompt). Only an eligible root prompt can change or block the
// record: a worker or child prompt touches no state. A root prompt writes only when
// its seq is above the project's last written seq, so a late finisher (a slow lookup,
// or one the fence already timed out) never replaces a newer prompt's record.
// NOT guaranteed: ordering across processes (two OpenCode services on one project),
// and a root prompt whose classification fails is not recorded at all.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../../../scripts/lib/opencode-install.mjs';
import { sessionKind } from './dispatch.mjs';
import { inWorkerChild } from './worker.mjs';

export const CONDUCTOR_SESSION_REL = '.sterling/transient/opencode-conductor-session';

// One process-wide arrival counter, shared by every location of every project.
let counter = 0;
/** The arrival seq of a prompt; take it before the prompt hook's first await. */
export const takePromptSeq = () => ++counter;

// Per project root, the seq of the prompt the record was last written for. One integer
// per root the process has served, never removed: bounded by the projects of one service.
const lastWritten = new Map();

/** Returns onPrompt(input, seq): records input.sessionID when it is a root session of this project. */
export function createConductorSessionRecorder({ rootOf, fenced, getSession, parents, env = process.env }) {
  return async function onPrompt(input, seq) {
    if (inWorkerChild(env)) return;
    const root = rootOf();
    if (!root) return;
    const sessionID = input?.sessionID;
    if (typeof sessionID !== 'string' || !sessionID) return;
    await fenced('conductor-session', root, async () => {
      if (!Number.isInteger(seq)) throw new Error(`conductor session not recorded: no arrival seq for session ${sessionID}`);
      const kind = await sessionKind(getSession?.(), sessionID, parents);
      if (kind.why) throw new Error(`conductor session not recorded: could not tell whether session ${sessionID} is a root session (${kind.why})`);
      if (kind.kind !== 'root') return;
      if (seq <= (lastWritten.get(root) ?? 0)) return;
      const path = join(root, CONDUCTOR_SESSION_REL);
      const text = `${sessionID}\n`;
      let current = null;
      try {
        current = readFileSync(path, 'utf8');
      } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
      }
      if (current !== text) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileAtomic(path, text);
      }
      lastWritten.set(root, seq);
    });
  };
}
