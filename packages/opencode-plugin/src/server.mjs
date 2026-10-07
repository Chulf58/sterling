// Sterling's OpenCode 2 server plugin: the knowledge loop in one small plugin
// (decision sterling-on-opencode-2-is-the-knowledge-loop-in-one-small-plugin).
// It reuses the libraries Claude Code's hooks run on and changes none of them:
//   1. session context: the Sterling layer (templates/target-claude-md.md, the
//      file init renders into CLAUDE.md) with each template claude-only block
//      swapped for its opencode-only partner (layer.mjs), an OpenCode host tail
//      naming the resolved Sterling root, a
//      status line, pending notices, and the rotation restore in the first new
//      root session after a rotation note (scripts/hooks/lib/rotation-restore.mjs,
//      shared with H1);
//   2. execute.before/after on read, edit, write and patch: H19-style knowledge
//      delivery appended to the tool result; on shell, H19's Bash pointers for
//      the paths the command names; after a completed webfetch or websearch, a
//      research_tool event in the session-event register, as H16 records; on
//      the subagent, question and codex tools, H20's mechanism-axis delivery
//      (and the codex model pin); on the subagent tool, H22's dispatch register
//      arms and H16's agent_dispatch event; after read and shell, H23's
//      output-axis pointer;
//   3. session.execution.succeeded of a ROOT session: settlement (mint
//      reconcile duties, then advance the settled snapshot), the maintenance
//      worker, and a notice the model sees at the next turn. A child session's
//      execution end (succeeded, failed or interrupted) settles nothing; it
//      ends a background subagent's dispatch;
//   4. the prompt hook: a record selected in the dashboard is taken once from
//      the store and appended to the next prompt, as H2 does on Claude Code;
//   5. the compaction hook: the session's delivery receipts are removed, so
//      delivery fires again after compaction drops context.
//   6. the store guard: a permission evaluate hook that denies edit, write and patch
//      requests on .sterling/sterling.db, and shell requests with a write shape aimed
//      at it, whatever the agent's rules say (store-guard.mjs). It is registered at every location, outside a Sterling
//      project too (a project init'd while OpenCode runs is guarded at once) and in
//      the maintenance worker's child. The installer's config guard in
//      .opencode/opencode.json (scripts/lib/opencode-install.mjs) stays as a second layer
//      for edit, write and patch; it carries no shell rule.
// Every handler is fenced: a throw is logged to .sterling/transient and turned
// into a notice, never raised into OpenCode. Outside a Sterling project (no
// .sterling/sterling.db above the session directory) every handler is a no-op, and
// setup registers only the bootstrap commands (config.mjs BOOTSTRAP_COMMANDS), so a
// new user has /sterling:init; nothing is written into such a project.
// The handlers live in one module each beside this file; this file wires them
// (deps injection, the fence, the event chain) and re-exports what tests import:
//   layer.mjs (render, host blocks, host tail) restore.mjs (rotation restore)
//   context.mjs (the context handler)         delivery.mjs (tool delivery)
//   settle.mjs (settlement)                   worker.mjs (maintenance worker)
//   selection.mjs (prompt hook)               compaction.mjs (receipt reset)
//   research.mjs (research_tool and agent_dispatch events)  pr-loop.mjs (the PR review loop owed notice)
//   axis.mjs (H20 and H23)                    dispatch.mjs (H22 and the root-session gate)
//   config.mjs (registration), sync.mjs (post-update sync), store-guard.mjs (the store guard)
//   notices.mjs, log.mjs, store.mjs (shared plumbing)
import { createAxisHandlers } from './axis.mjs';
import { createCompactionHandler } from './compaction.mjs';
import { createBootstrapHandler, createConfigHandler } from './config.mjs';
import { createContextHandler } from './context.mjs';
import { createDeliveryHandlers } from './delivery.mjs';
import { createDispatchHandlers, liveChildInRegister, rootSessionGate, sweepStaleDispatches } from './dispatch.mjs';
import { LOG_REL, errText, logLine } from './log.mjs';
import { NOTICES_REL, addNotice } from './notices.mjs';
import { createPrLoopNotice } from './pr-loop.mjs';
import { createRotationRestore } from './restore.mjs';
import { createResearchRecorder } from './research.mjs';
import { createPromptHandler } from './selection.mjs';
import { remember } from './bounded.mjs';
import { createSettle, liveDispatch } from './settle.mjs';
import { onEvaluate as storeGuard } from './store-guard.mjs';
import { BUSY_TIMEOUT_MS, createProjectStores, openProjectStore } from './store.mjs';
import { createSessionSync } from './sync.mjs';
import { createWorkerLaunch, inWorkerChild } from './worker.mjs';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from '../../../scripts/hooks/lib/common.mjs';

export { BUSY_TIMEOUT_MS, LOG_REL, NOTICES_REL, addNotice, createProjectStores, liveDispatch, openProjectStore };
export { defaultTemplatePath, hostBlockPairs, opencodeHostTail, renderSterlingLayer, sterlingRoot } from './layer.mjs';

export const PLUGIN_ID = 'sterling.server';

// The events that end a session's execution. Each ends a background child's dispatch; only succeeded settles.
const EXECUTION_END_EVENTS = new Set(['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']);

// Per-handler budgets. The store calls are synchronous and cannot be cut off
// mid-call; the budget bounds the awaited part and logs any overrun.
export const BUDGET_MS = { context: 4000, delivery: 4000, axis: 4000, dispatch: 10000, research: 4000, settle: 30000, prompt: 4000, compaction: 4000, config: 4000 };


/**
 * Whether two directories are the same place: realpaths when both resolve (so a symlinked
 * checkout matches), else the lexically resolved paths. `unresolved` names the path whose
 * realpath could not be read, so the caller can tell a plain mismatch from a blind one.
 */
function sameDirectory(a, b) {
  let unresolved = '';
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch (e) {
      unresolved ||= `${p}: ${errText(e)}`;
      return resolve(p);
    }
  };
  const equal = real(a) === real(b);
  return { equal, unresolved };
}

/**
 * The plugin factory. `deps` exists for tests: openStore(dbPath) (replaces the
 * project stores outright) or projectStores (a createProjectStores() result), now(),
 * claudeOnPath(), launchWorker(opts), sterlingRoot (a path), renderRestore(note, opts),
 * configure(ctx), bootstrap(ctx) and syncSession(root, sessionID) (replace the config.mjs and sync.mjs handlers),
 * and env (process.env for the worker-child check and sync.mjs).
 *
 * OpenCode 2 imports the plugin module once per process and calls the one exported
 * object's setup once per location (a directory the service serves), each with that
 * location's ctx; the session and tool hook inputs carry no directory. So each
 * location gets its own instance, bound to ctx.location.directory and kept across a
 * re-setup of the same directory, and nothing reads process.cwd(), which is only the
 * directory the service was started in (board item
 * opencode-plugin-acted-on-the-wrong-project-measured-2026-10). The startup sweep and
 * the post-update sync run once per project per process, whichever location reaches
 * the project first.
 */
export function createSterlingServer(deps = {}) {
  // On Postgres storage the project stores hold one routed store per project for the
  // process's life (store.mjs); a location's cleanup closes its project's.
  const projectStores = deps.openStore ? null : (deps.projectStores ?? createProjectStores());
  const openStore = deps.openStore ?? projectStores.open;
  const now = deps.now ?? (() => new Date().toISOString());
  const env = deps.env ?? process.env;
  // Process-wide, keyed by project root: the roots whose startup sweep ran, and whose post-update sync started.
  const swept = new Set();
  const syncStarted = new Set();
  // One instance per location directory; `last` is the latest set up, which `handlers` exposes to tests.
  const locations = new Map();
  let last = null;

  /** Run fn inside the handler fence: budgeted, and a throw is logged and becomes a notice. */
  async function fenced(name, root, fn) {
    const started = Date.now();
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${name} exceeded its ${BUDGET_MS[name]} ms budget`)), BUDGET_MS[name]);
        }),
      ]);
      const took = Date.now() - started;
      if (took > BUDGET_MS[name]) logLine(root, `${name}: over budget (${took} ms, synchronous)`);
    } catch (e) {
      try {
        logLine(root, `${name} failed: ${errText(e)}`);
        addNotice(root, `Sterling plugin: ${name} failed (${errText(e)}). See ${LOG_REL}.`, now());
      } catch (reportError) {
        // The log and notice files are unwritable: stderr is the last place left.
        process.stderr.write(`[sterling] ${name} failed (${errText(e)}) and could not be reported (${errText(reportError)})\n`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const launchWorkerFor = createWorkerLaunch({ openStore, claudeOnPath: deps.claudeOnPath, launchWorker: deps.launchWorker });
  const settle = createSettle({ openStore, now, launchWorkerFor });
  const prLoopNotice = createPrLoopNotice({ now, pluginRoot: deps.sterlingRoot });
  const configure = deps.configure ?? createConfigHandler(deps);
  const bootstrap = deps.bootstrap ?? createBootstrapHandler(deps);

  /** The handlers of one location: each resolves the project root from `directory`, the location's own. */
  function createLocation(directory) {
    let session = null;
    let chain = Promise.resolve();
    // Each session's parentID, shared by the context handler and the settlement gate (bounded, bounded.mjs).
    const parents = new Map();
    const rootOf = () => projectRoot(directory);
    // Each session's directory (session.get -> location.directory), and the sessions whose
    // failed lookup is already logged; both bounded (bounded.mjs). A failure is not cached,
    // so the next execution end of that session looks it up again.
    const sessionDirs = new Map();
    const lookupLogged = new Map();

    /** The directory session `sessionID` lives in, as { dir }, or { why } when it cannot be read. */
    async function sessionDirectory(sessionID) {
      if (sessionDirs.has(sessionID)) return { dir: sessionDirs.get(sessionID) };
      let info;
      try {
        if (typeof session?.get !== 'function') throw new Error('ctx.session.get is unavailable');
        info = await session.get({ sessionID });
      } catch (e) {
        return { why: errText(e) };
      }
      const dir = info?.location?.directory;
      if (info?.id !== sessionID || typeof dir !== 'string' || !dir) return { why: `session.get gave no location.directory for session ${sessionID}` };
      return { dir: remember(sessionDirs, sessionID, dir) };
    }

    const rotationRestore = createRotationRestore({ getSession: () => session, now, renderRestore: deps.renderRestore, env });
    const sessionSync = deps.syncSession ?? createSessionSync({ ...deps, getSession: () => session, now, started: syncStarted });
    const { onContext, resetStatus } = createContextHandler({ openStore, now, rootOf, fenced, rotationRestore, getSession: () => session, parents, sweepStale: sweepStaleDispatches, swept, env, sessionSync, pluginRoot: deps.sterlingRoot });
    const delivery = createDeliveryHandlers({ openStore, rootOf, directory: () => directory, fenced });
    const axis = createAxisHandlers({ openStore, rootOf, directory: () => directory, fenced });
    const dispatch = createDispatchHandlers({ rootOf, fenced });
    const recordResearch = createResearchRecorder({ rootOf, fenced, now });
    // Every handler is fenced, so none of them throws: Sterling never denies a tool call.
    async function onBefore(input) {
      await delivery.onBefore(input);
      await axis.onBefore(input);
      await dispatch.onBefore(input);
    }
    // H23 matches only the tool's own output, taken before anything is appended,
    // and runs after the file delivery has written the session guard.
    async function onAfter(input) {
      const output = axis.outputOf(input);
      await delivery.onAfter(input);
      await axis.onOutput(input, output);
      await axis.onAfter(input);
      await dispatch.onAfter(input);
      await recordResearch(input);
    }
    const onPrompt = createPromptHandler({ openStore, rootOf, fenced, env });
    const onCompaction = createCompactionHandler({ rootOf, fenced });

    async function onEvent(ev) {
      if (!EXECUTION_END_EVENTS.has(ev?.type)) return;
      // An event that names another location's directory is that location's to handle.
      const evDir = ev.location?.directory;
      if (evDir !== undefined && resolve(String(evDir)) !== resolve(directory)) return;
      // Inside the maintenance worker's own `opencode run` child (the runner sets
      // the flag), this globally installed plugin must not settle or launch a
      // worker: it would race the parent's settlement on the same store.
      if (inWorkerChild(env)) return;
      const root = rootOf();
      if (!root) return;
      const sessionID = ev.data?.sessionID;
      // Noted before the gate reads the register, so a background child that ends
      // before its subagent call binds it is ended at that bind (dispatch.mjs). The map
      // is per location and keyed by this location's own children, so a foreign id is harmless.
      dispatch.noteExecutionEnd(sessionID);
      // OpenCode 2.0.22 execution events carry no location and reach every location's
      // subscription (finding opencode-execution-events-carry-no-location-cross-project-settlement-october-2026),
      // so the session's own directory decides: only that location handles the event.
      // A child bound in THIS project's dispatch register is this location's by construction,
      // so it needs no directory lookup (a failed lookup must not leave its dispatch live).
      // Any other session whose directory cannot be read is not handled here, and is logged once.
      if (typeof sessionID === 'string' && sessionID) {
        let mine = false;
        await fenced('dispatch', root, async () => {
          if (liveChildInRegister(root, sessionID)) {
            mine = true;
            return;
          }
          const owner = await sessionDirectory(sessionID);
          if (owner.why) {
            if (!lookupLogged.has(sessionID)) {
              remember(lookupLogged, sessionID, true);
              logLine(root, `settle skipped: ${ev.type} of session ${sessionID} not handled at ${directory}: could not read which directory the session belongs to (${owner.why})`);
              addNotice(root, `Sterling settlement skipped: could not read which project session ${sessionID} belongs to (${owner.why}); only the session's own project settles, and the next settlement there covers this range.`, now());
            }
            return;
          }
          const same = sameDirectory(owner.dir, directory);
          mine = same.equal;
          // A foreign session is the normal case and stays quiet; only a path that could not be
          // resolved to its real location is worth one line, since it may hide a symlink mismatch.
          if (!mine && same.unresolved && !lookupLogged.has(sessionID)) {
            remember(lookupLogged, sessionID, true);
            logLine(root, `settle skipped: ${ev.type} of session ${sessionID} not handled at ${directory}: its directory ${owner.dir} differs after normalisation and a real path could not be read (${same.unresolved})`);
          }
        });
        if (!mine) return;
      }
      // Any execution end of a child ends its background dispatch; only a root
      // session's successful end settles (dispatch.mjs rootSessionGate): a child's
      // execution end is not the end of the user's turn.
      const succeeded = ev.type === 'session.execution.succeeded';
      let gate = { settle: false };
      await fenced(succeeded ? 'settle' : 'dispatch', root, async () => {
        gate = await rootSessionGate(root, { session, sessionID, parents });
        if (!gate.why) return;
        if (!succeeded) {
          logLine(root, `dispatch end skipped on ${ev.type}: could not check whether session ${sessionID} is a child (${gate.why})`);
          return;
        }
        // Inside the fence: a torn notices file must not reject onEvent and end the subscription loop.
        logLine(root, `settle skipped: could not check whether session ${sessionID} is a child (${gate.why})`);
        addNotice(root, `Sterling settlement skipped: could not check whether session ${sessionID} is a child session (${gate.why}); only a root session settles, and the next root settlement covers this range.`, now());
      });
      if (!gate.settle || !succeeded) return;
      resetStatus(root);
      await fenced('settle', root, () => settle(root));
      await fenced('settle', root, () => prLoopNotice(root));
    }

    const handlers = { context: onContext, prompt: onPrompt, compaction: onCompaction, before: onBefore, after: onAfter, event: onEvent };

    /** Registers this location's hooks on its ctx and starts its event subscription; returns the cleanup. */
    async function bind(ctx, guarded) {
      session = ctx.session;
      const root = rootOf();
      if (!guarded) {
        const why = `this OpenCode has no ctx.permission.hook (it needs 2.0.22 or later), so the Sterling store guard (deny on .sterling/sterling.db) is NOT registered at ${directory}; shell commands are NOT guarded at all, only the edit, write and patch deny in .opencode/opencode.json holds, and project agent files in .opencode/agents/ with their own edit rules are unguarded`;
        process.stderr.write(`[sterling] ${why}\n`);
        if (root) {
          logLine(root, `store guard: ${why}`);
          addNotice(root, `Sterling plugin: ${why}.`, now());
        }
      }
      if (root) await fenced('config', root, () => configure(ctx));
      else {
        // No store yet: register only what works without one (/sterling:init first),
        // and report a failure on stderr, since there is no .sterling/ to log into.
        try {
          await bootstrap(ctx);
        } catch (e) {
          process.stderr.write(`[sterling] the bootstrap commands could not be registered (${errText(e)})\n`);
        }
      }
      await ctx.session.hook('context', onContext);
      await ctx.session.hook('prompt', onPrompt);
      await ctx.session.hook('compaction', onCompaction);
      await ctx.tool.hook('execute.before', onBefore);
      await ctx.tool.hook('execute.after', onAfter);
      const abort = new AbortController();
      (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
            chain = chain.then(() => onEvent(ev));
            await chain;
          }
        } catch (e) {
          const subRoot = rootOf();
          if (subRoot && !abort.signal.aborted) {
            try {
              logLine(subRoot, `event subscription ended: ${errText(e)}`);
              addNotice(subRoot, `Sterling plugin: the event subscription ended (${errText(e)}); settlement stops until OpenCode restarts.`);
            } catch (reportError) {
              process.stderr.write(`[sterling] event subscription ended (${errText(e)}) and could not be reported (${errText(reportError)})\n`);
            }
          }
        }
      })();
      return () => {
        abort.abort();
        // The root found at bind, plus the one found now: a project renamed or
        // removed since bind has no root now but may still hold a store, and one
        // initialized since bind has a root only now.
        for (const held of new Set([root, rootOf()])) if (held) projectStores?.release(held);
      };
    }

    return { handlers, bind, idle: () => chain };
  }

  return {
    id: PLUGIN_ID,
    /** The handlers of the latest location set up; tests drive a single location through it. */
    get handlers() {
      return last?.handlers;
    },
    /** Resolves once every event received so far, at every location, has been handled (tests). */
    async idle() {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await Promise.all([...locations.values()].map((l) => l.idle()));
    },
    async setup(ctx) {
      // The store guard comes first, before anything that can return early: a location
      // whose directory is unknown still runs tools. Not fenced: the fence turns a throw
      // into a notice and lets the call through, which would fail open.
      const guarded = typeof ctx?.permission?.hook === 'function';
      if (guarded) await ctx.permission.hook('evaluate', storeGuard);
      const directory = ctx?.location?.directory;
      if (typeof directory !== 'string' || !directory) {
        if (!guarded) process.stderr.write('[sterling] this OpenCode has no ctx.permission.hook (it needs 2.0.22 or later), so the Sterling store guard is NOT registered\n');
        // No handler could tell which project it is in. The service cwd is not the
        // session's project, so nothing is registered rather than guessed.
        process.stderr.write('[sterling] setup received no ctx.location.directory, so this location cannot be tied to a project; no Sterling hook is registered for it\n');
        return undefined;
      }
      const key = resolve(directory);
      let loc = locations.get(key);
      if (!loc) {
        loc = createLocation(directory);
        locations.set(key, loc);
      }
      last = loc;
      return loc.bind(ctx, guarded);
    },
  };
}

export default createSterlingServer();
