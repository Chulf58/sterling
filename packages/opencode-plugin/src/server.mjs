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
//      event settles nothing; it ends a background subagent's dispatch;
//   4. the prompt hook: a record selected in the dashboard is taken once from
//      the store and appended to the next prompt, as H2 does on Claude Code;
//   5. the compaction hook: the session's delivery receipts are removed, so
//      delivery fires again after compaction drops context.
// The store guard (edit and shell deny on .sterling/sterling.db) is not here: the
// installer writes it into .opencode/opencode.json (scripts/lib/opencode-install.mjs).
// Every handler is fenced: a throw is logged to .sterling/transient and turned
// into a notice, never raised into OpenCode. Outside a Sterling project (no
// .sterling/sterling.db above the session directory) every handler is a no-op.
// The handlers live in one module each beside this file; this file wires them
// (deps injection, the fence, the event chain) and re-exports what tests import:
//   layer.mjs (render, host blocks, host tail) restore.mjs (rotation restore)
//   context.mjs (the context handler)         delivery.mjs (tool delivery)
//   settle.mjs (settlement)                   worker.mjs (maintenance worker)
//   selection.mjs (prompt hook)               compaction.mjs (receipt reset)
//   research.mjs (research_tool and agent_dispatch events)  pr-loop.mjs (the PR review loop owed notice)
//   axis.mjs (H20 and H23)                    dispatch.mjs (H22 and the root-session gate)
//   config.mjs (registration), sync.mjs (post-update sync)
//   notices.mjs, log.mjs, store.mjs (shared plumbing)
import { createAxisHandlers } from './axis.mjs';
import { createCompactionHandler } from './compaction.mjs';
import { createConfigHandler } from './config.mjs';
import { createContextHandler } from './context.mjs';
import { createDeliveryHandlers } from './delivery.mjs';
import { createDispatchHandlers, rootSessionGate } from './dispatch.mjs';
import { LOG_REL, errText, logLine } from './log.mjs';
import { NOTICES_REL, addNotice } from './notices.mjs';
import { createPrLoopNotice } from './pr-loop.mjs';
import { createRotationRestore } from './restore.mjs';
import { createResearchRecorder } from './research.mjs';
import { createPromptHandler } from './selection.mjs';
import { createSettle, liveDispatch } from './settle.mjs';
import { BUSY_TIMEOUT_MS, openProjectStore } from './store.mjs';
import { createSessionSync } from './sync.mjs';
import { createWorkerLaunch } from './worker.mjs';
import { projectRoot } from '../../../scripts/hooks/lib/common.mjs';
import { WORKER_ENV_FLAG } from '../../../scripts/hooks/lib/maintenance-worker.mjs';

export { BUSY_TIMEOUT_MS, LOG_REL, NOTICES_REL, addNotice, liveDispatch, openProjectStore };
export { defaultTemplatePath, hostBlockPairs, opencodeHostTail, renderSterlingLayer, sterlingRoot } from './layer.mjs';

export const PLUGIN_ID = 'sterling.server';

// Per-handler budgets. The store calls are synchronous and cannot be cut off
// mid-call; the budget bounds the awaited part and logs any overrun.
export const BUDGET_MS = { context: 4000, delivery: 4000, axis: 4000, dispatch: 10000, research: 4000, settle: 30000, prompt: 4000, compaction: 4000, config: 4000 };

/**
 * The plugin factory. `deps` exists for tests: openStore(dbPath), now(),
 * claudeOnPath(), launchWorker(opts), sterlingRoot (a path), renderRestore(note, opts),
 * configure(ctx) and syncSession(root, sessionID) (replace the config.mjs and sync.mjs handlers),
 * and env (process.env for the worker-child check and sync.mjs).
 */
export function createSterlingServer(deps = {}) {
  const openStore = deps.openStore ?? openProjectStore;
  const now = deps.now ?? (() => new Date().toISOString());
  let session = null;
  let directory = process.cwd();
  let chain = Promise.resolve();
  const parents = new Map();

  const rootOf = () => projectRoot(directory);

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

  const rotationRestore = createRotationRestore({ getSession: () => session, now, renderRestore: deps.renderRestore });
  const { onContext, resetStatus } = createContextHandler({ openStore, now, rootOf, fenced, rotationRestore, getSession: () => session, sessionSync: deps.syncSession ?? createSessionSync({ ...deps, getSession: () => session, now }), pluginRoot: deps.sterlingRoot });
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
  const launchWorkerFor = createWorkerLaunch({ openStore, claudeOnPath: deps.claudeOnPath, launchWorker: deps.launchWorker });
  const settle = createSettle({ openStore, now, launchWorkerFor });
  const prLoopNotice = createPrLoopNotice({ now, pluginRoot: deps.sterlingRoot });
  const onPrompt = createPromptHandler({ openStore, rootOf, fenced });
  const onCompaction = createCompactionHandler({ rootOf, fenced });
  const configure = deps.configure ?? createConfigHandler(deps);

  async function onEvent(ev) {
    if (ev?.type !== 'session.execution.succeeded') return;
    // Inside the maintenance worker's own `opencode run` child (the runner sets
    // the flag), this globally installed plugin must not settle or launch a
    // worker: it would race the parent's settlement on the same store.
    if ((deps.env ?? process.env)[WORKER_ENV_FLAG] === '1') return;
    const root = rootOf();
    if (!root) return;
    // Settle only on the root session (dispatch.mjs rootSessionGate): a child's
    // execution end is not the end of the user's turn.
    let gate = { settle: false };
    await fenced('settle', root, async () => {
      gate = await rootSessionGate(root, { session, sessionID: ev.data?.sessionID, parents });
    });
    if (gate.why) {
      logLine(root, `settle skipped: could not check whether session ${ev.data?.sessionID} is a child (${gate.why})`);
      addNotice(root, `Sterling settlement skipped: could not check whether session ${ev.data?.sessionID} is a child session (${gate.why}); only a root session settles, and the next root settlement covers this range.`, now());
    }
    if (!gate.settle) return;
    resetStatus(root);
    await fenced('settle', root, () => settle(root));
    await fenced('settle', root, () => prLoopNotice(root));
  }

  const handlers = { context: onContext, prompt: onPrompt, compaction: onCompaction, before: onBefore, after: onAfter, event: onEvent };

  return {
    id: PLUGIN_ID,
    handlers,
    /** Resolves once every event received so far has been handled (tests). */
    async idle() {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await chain;
    },
    async setup(ctx) {
      directory = ctx?.location?.directory ?? process.cwd();
      session = ctx.session;
      const root = rootOf();
      if (root) await fenced('config', root, () => configure(ctx));
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
          const root = rootOf();
          if (root && !abort.signal.aborted) {
            try {
              logLine(root, `event subscription ended: ${errText(e)}`);
              addNotice(root, `Sterling plugin: the event subscription ended (${errText(e)}); settlement stops until OpenCode restarts.`);
            } catch (reportError) {
              process.stderr.write(`[sterling] event subscription ended (${errText(e)}) and could not be reported (${errText(reportError)})\n`);
            }
          }
        }
      })();
      return () => abort.abort();
    },
  };
}

export default createSterlingServer();
