// The session context, in two parts. STABLE: the rendered layer, plus H19's dispatch
// staging for a child (subagent) session, pushed into the system prompt of every request
// and the same bytes on each. VOLATILE: the status line, H1's operating-state and
// maintenance lines, the plan lock, the dispatch sweep, board readiness, the rotation
// restore and pending notices, appended to the session's next prompt text when they
// changed since they were last delivered there (user-ruled 2026-10-12, "Move live lines
// out": a system prompt that changed every turn re-wrote the whole conversation to the
// provider's prompt cache; finding why-is-the-prompt-cache-hit-rate-lower-on-opencode-codeburn).
import { join } from 'node:path';
import { SUPPORTED_SCHEMA_VERSION } from '@sterling/store';
import { probeSchemaVersion } from '../../../scripts/lib/update.mjs';
import { opencodeHostTail, renderSterlingLayer, sterlingRoot } from './layer.mjs';
import { errText, logLine } from './log.mjs';
import { takeNotices } from './notices.mjs';
import { readMaintenanceState } from '../../../scripts/hooks/lib/maintenance-state.mjs';
import { laneCeiling, liveLanes, renderBoardReadiness } from '../../../scripts/hooks/lib/board-ready.mjs';
import { maintenanceLines, operatingStateLines, undeclaredSourceBlock } from './operating-state.mjs';
import { composeContext, dispatchChrome } from '../../../scripts/hooks/lib/stage-brief.mjs';
import { VOLATILE_HEADER, briefOf, notStagedLine, stageChild } from './staging.mjs';
import { agentRole } from './agent-name.mjs';
import { remember } from './bounded.mjs';
import { sessionKind } from './dispatch.mjs';
import { inWorkerChild } from './worker.mjs';
import { refreshRegistryRow } from '../../../scripts/hooks/lib/registry-refresh.mjs';
import { planLockSection } from '../../../scripts/hooks/lib/plan-lock-section.mjs';

const STATUS_TTL_MS = 10_000;
// The undeclared-source scan spawns git twice, so a process reuses its answer for this long.
const UNDECLARED_TTL_MS = 5 * 60_000;

/**
 * `getSession()` returns the plugin context's session domain, as restore.mjs and sync.mjs take it; a session it cannot classify gets the loud not-staged line.
 * `parents` is the session-to-parentID cache shared with the settlement gate. `sweepStale(root)` (dispatch.mjs sweepStaleDispatches)
 * runs once per project root per process at the first root request and returns a line to show, or ''; never when `env` (process.env)
 * carries the maintenance worker flag. `swept` holds the roots already swept; the server passes one set to every location's handler.
 * `rotationRestore(root, sessionID)` is restore.mjs's gate; `sessionSync(root, sessionID)` is sync.mjs's once-per-process step; `pluginRoot` is the
 * test override for the resolved Sterling root. Returns onContext (the stable system part), onPrompt (the volatile
 * part, appended to the prompt), `resetStatus(root)`, which drops the cached status line, maintenance summary and
 * board readiness, and `resetSession(sessionID)`, which forgets what that session was delivered.
 */
export function createContextHandler({ openStore, now, rootOf, fenced, rotationRestore, sessionSync, pluginRoot: pluginRootOverride, getSession, parents = new Map(), sweepStale, swept = new Set(), env = process.env }) {
  const statusCache = new Map();
  // The undeclared-source scan, per project root: root sessions only, refreshed on UNDECLARED_TTL_MS.
  const undeclaredCache = new Map();
  // The system-queue summary, refreshed on the status line's TTL: it reads every system todo.
  const maintenanceCache = new Map();
  // A child session's staged text, kept for its later requests (bounded, bounded.mjs).
  const stagedCache = new Map();
  // H1's board readiness block, per project root, refreshed on the status line's TTL.
  const boardCache = new Map();
  // Per session, the text of each volatile block last delivered to it (bounded, bounded.mjs).
  const delivered = new Map();
  // The last root session whose start refreshed each project's registry row.
  const registrySeen = new Map();

  function statusLine(root) {
    const hit = statusCache.get(root);
    if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.text;
    const dbPath = join(root, '.sterling', 'sterling.db');
    let schema;
    try {
      const found = probeSchemaVersion(dbPath);
      schema = found === SUPPORTED_SCHEMA_VERSION ? `store schema v${found} (current)` : `store schema v${found}, this Sterling expects v${SUPPORTED_SCHEMA_VERSION}: run migrate-stores, then restart OpenCode`;
    } catch (e) {
      schema = `store schema probe failed (${errText(e)})`;
    }
    let text;
    try {
      const store = openStore(dbPath);
      try {
        text = `STERLING STATUS: board ${store.count({ types: ['todo'], source: 'user' })} open, maintenance queue ${store.count({ types: ['todo'], source: 'system' })}, ${schema}`;
      } finally {
        store.close();
      }
    } catch (e) {
      logLine(root, `context: store unavailable: ${errText(e)}`);
      text = `STERLING STATUS: store unavailable (${errText(e)}), ${schema}`;
    }
    statusCache.set(root, { at: Date.now(), text });
    return text;
  }

  /** H19's staging for a child session: the records governing its own brief with the plan, TDD and return-contract chrome. */
  async function childStaging(root, input) {
    const cached = stagedCache.get(input.sessionID);
    if (cached) return cached;
    const brief = briefOf(input.messages);
    try {
      const store = openStore(join(root, '.sterling', 'sterling.db'));
      try {
        const out = stageChild({ store, root, sessionID: input.sessionID, agent: input.agent, brief, disclosure: brief ? '' : notStagedLine('brief-unavailable') });
        // The system prompt is rebuilt per request, so records the guard ledger now holds as delivered must ride every later request of this child.
        if (out.staged) remember(stagedCache, input.sessionID, out.text);
        return out.text;
      } finally {
        store.close();
      }
    } catch (e) {
      logLine(root, `context: child staging failed for ${input.sessionID}: ${errText(e)}`);
      const role = agentRole(input.agent);
      return composeContext({ agentType: role, ...dispatchChrome(root, role), unattributableLine: notStagedLine('staging-failed') });
    }
  }

  /** The undeclared-source block for `root`, scanned at most once per UNDECLARED_TTL_MS in this process. */
  function undeclaredBlock(root, config) {
    const hit = undeclaredCache.get(root);
    if (hit && Date.now() - hit.at < UNDECLARED_TTL_MS) return hit.text;
    const text = undeclaredSourceBlock(root, config);
    undeclaredCache.set(root, { at: Date.now(), text });
    return text;
  }

  function maintenanceBlocks(root, config) {
    let hit = maintenanceCache.get(root);
    if (!hit || Date.now() - hit.at >= STATUS_TTL_MS) {
      let state = null;
      let error = null;
      try {
        const store = openStore(join(root, '.sterling', 'sterling.db'));
        try {
          state = readMaintenanceState(store, root);
        } finally {
          store.close();
        }
      } catch (e) {
        logLine(root, `context: maintenance queue unreadable: ${errText(e)}`);
        error = errText(e);
      }
      hit = { at: Date.now(), state, error };
      maintenanceCache.set(root, hit);
    }
    if (hit.error) return [`MAINTENANCE QUEUE UNREADABLE (${hit.error}) — the deep-queue signal and the reconcile backlog are not stated this turn.`];
    return hit.state ? maintenanceLines(hit.state, config, root) : [];
  }

  /**
   * H1's READY / READY FOR RESEARCH / WAITING ON YOU block (decision
   * board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start;
   * full-parity ruling 7f83f57e), from the same shared lib and the store's one
   * readiness function. onPrompt delivers it again whenever it changed, which
   * covers what H20's mid-session line does on Claude Code at the next prompt.
   */
  function boardBlock(root, config, sessionID) {
    // The cache holds the readiness read per ROOT; the live-lane count is per
    // SESSION, so it is computed on every call and never cached with the text.
    let hit = boardCache.get(root);
    if (!hit || Date.now() - hit.at >= STATUS_TTL_MS) {
      try {
        const store = openStore(join(root, '.sterling', 'sterling.db'));
        let readiness;
        try {
          readiness = store.boardReadiness();
        } finally {
          store.close();
        }
        hit = { at: Date.now(), readiness };
      } catch (e) {
        logLine(root, `context: board readiness unreadable: ${errText(e)}`);
        hit = {
          at: Date.now(),
          unavailable: `BOARD READINESS UNAVAILABLE (${errText(e)}): the READY / READY FOR RESEARCH / WAITING ON YOU lists are not stated this turn; read the board with board_query.`,
        };
      }
      boardCache.set(root, hit);
    }
    if (hit.unavailable) return hit.unavailable;
    try {
      return renderBoardReadiness({ readiness: hit.readiness, live: liveLanes(root, sessionID), ceiling: laneCeiling(config) });
    } catch (e) {
      logLine(root, `context: board readiness unreadable: ${errText(e)}`);
      return `BOARD READINESS UNAVAILABLE (${errText(e)}): the READY / READY FOR RESEARCH / WAITING ON YOU lists are not stated this turn; read the board with board_query.`;
    }
  }

  /** The resolved Sterling root as { pluginRoot }, or { pluginRoot: null, error } when it cannot be found. */
  function resolvePluginRoot() {
    try {
      return { pluginRoot: pluginRootOverride ?? sterlingRoot() };
    } catch (e) {
      return { pluginRoot: null, error: e };
    }
  }

  /**
   * The STABLE context, pushed into the system prompt of every request: the rendered
   * layer, plus a child session's dispatch staging (or the loud not-staged line). It is
   * the same bytes on every request of a session, so the provider's prompt cache keeps
   * the conversation behind it (finding
   * why-is-the-prompt-cache-hit-rate-lower-on-opencode-codeburn; user-ruled 2026-10-12,
   * "Move live lines out"). What changes during a session is delivered by onPrompt.
   */
  async function onContext(input) {
    const root = rootOf();
    if (!root) return;
    await fenced('context', root, async () => {
      await sessionSync(root, input.sessionID);
      const { pluginRoot, error } = resolvePluginRoot();
      let layer;
      try {
        if (error) throw error;
        layer = renderSterlingLayer(root, pluginRoot);
      } catch (e) {
        logLine(root, `context: layer render failed: ${errText(e)}`);
        layer = `STERLING LAYER UNAVAILABLE: ${errText(e)}\n\n${opencodeHostTail(pluginRoot)}`;
      }
      const blocks = [layer];
      const kind = await sessionKind(getSession?.(), input.sessionID, parents);
      if (kind.why) {
        // Neither root nor child can be assumed: no staging guess, and the loud line H19 prints.
        logLine(root, `context: child staging skipped for ${input.sessionID}, session lookup failed: ${kind.why}`);
        blocks.push(notStagedLine('session-lookup-failed'));
      } else if (kind.kind === 'child') {
        const staged = await childStaging(root, input);
        if (staged) blocks.push(staged);
      }
      input.system.push({ type: 'text', text: blocks.join('\n\n') });
    });
  }

  /**
   * The VOLATILE context of `sessionID`, as [{ key, text, cleared? }]. A keyed block is
   * delivered when its text differs from the one last delivered in the session; a block
   * with no key (a one-shot line: the sweep, a registry failure) whenever it is produced.
   * `cleared` is said once when a delivered keyed block becomes empty, so a stale READY
   * list or plan lock is not left standing as current in the conversation.
   */
  async function volatileBlocks(root, sessionID, kind) {
    // An unresolved root is reported by the layer in the system prompt; the lines read it as null.
    const { pluginRoot } = resolvePluginRoot();
    const state = operatingStateLines(root, pluginRoot, { opener: openStore });
    const out = [
      { key: 'status', text: statusLine(root) },
      { key: 'operating-state', text: state.lines.join('\n\n') },
      { key: 'maintenance', text: maintenanceBlocks(root, state.config).join('\n\n') },
    ];
    if (kind === 'root') {
      // H1's PLAN LOCK section (scripts/hooks/lib/plan-lock-section.mjs), each time it
      // changes while a lock exists: the plan is the surface carrying ORDER and the
      // user's written rulings, and delivery never gates (decision
      // plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry).
      // Not in the worker child: the section claims the one-shot markers, which the
      // conductor's own session must see.
      if (!inWorkerChild(env)) {
        let planLock;
        try {
          planLock = planLockSection({ cwd: root, source: 'opencode' }).context.trim();
        } catch (e) {
          logLine(root, `context: plan lock section failed: ${errText(e)}`);
          planLock = `PLAN LOCK UNAVAILABLE (${errText(e)}): the plan lock section is not stated this turn; check it with plan-lock.mjs --show.`;
        }
        out.push({ key: 'plan-lock', text: planLock, cleared: 'PLAN LOCK: no plan lock is active now; the one shown earlier no longer applies.' });
      }
      // Never inside the maintenance worker's own `opencode run` child: its root
      // context is not a new process boundary for the project, and a sweep there
      // would end the parent's live background dispatches (settle.mjs skips it too).
      if (sweepStale && !inWorkerChild(env) && !swept.has(root)) {
        swept.add(root);
        let line;
        try {
          line = await sweepStale(root);
        } catch (e) {
          // A failed sweep costs its own line, not the rest of the context.
          line = `STERLING DISPATCH SWEEP FAILED (${errText(e)}): dispatch records a dead OpenCode process left live were not swept, so they can hold the settled snapshot; restart OpenCode to retry the sweep.`;
        }
        if (line) {
          logLine(root, `context: ${line}`);
          out.push({ text: line });
        }
      }
      // H1's registry step, once per root session: last-seen and the row's stack tags
      // (scripts/hooks/lib/registry-refresh.mjs). Never in the worker child, whose
      // session is not the user's (anti-pattern e40bf982).
      if (!inWorkerChild(env) && registrySeen.get(root) !== sessionID) {
        registrySeen.set(root, sessionID);
        try {
          refreshRegistryRow(root, { config: state.config, at: now() });
        } catch (e) {
          logLine(root, `context: project registry refresh failed: ${errText(e)}`);
          out.push({ text: `STERLING PROJECT REGISTRY REFRESH FAILED (${errText(e)}): this project's last-seen time and stack tags in the shared registry were not updated, so other projects may list its old mounts.` });
        }
      }
      out.push({ key: 'undeclared', text: undeclaredBlock(root, state.config), cleared: 'UNDECLARED SOURCE: the undeclared-source finding shown earlier no longer applies.' });
      // Root sessions only, and never inside the maintenance worker's own child
      // (anti-pattern e40bf982): the worker is not the conductor filling lanes.
      if (!inWorkerChild(env)) out.push({ key: 'board', text: boardBlock(root, state.config, sessionID), cleared: 'BOARD READINESS: no user item is ready, waiting or blocked now; the lists shown earlier no longer apply.' });
    }
    out.push({ key: 'restore', text: await rotationRestore(root, sessionID) });
    return out;
  }

  /**
   * The prompt hook: appends to the session's next prompt text the volatile blocks that
   * changed since they were last delivered in that session and, in a root session, the
   * notices not shown yet (each taken once, notices.mjs). The first prompt a session has
   * in this process (a new or resumed session, or any session after an OpenCode restart
   * or a compaction) gets the whole current set once.
   */
  async function onPrompt(input) {
    const root = rootOf();
    if (!root) return;
    await fenced('context', root, async () => {
      if (typeof input?.prompt?.text !== 'string') throw new Error(`unrecognized prompt shape (prompt.text is ${typeof input?.prompt?.text})`);
      const sessionID = input.sessionID;
      const kind = await sessionKind(getSession?.(), sessionID, parents);
      if (kind.why) logLine(root, `context: session ${sessionID} could not be told root or child at its prompt (${kind.why}); only the lines every session gets are delivered`);
      const blocks = await volatileBlocks(root, sessionID, kind.why ? 'unknown' : kind.kind);
      const seen = delivered.get(sessionID) ?? remember(delivered, sessionID, new Map());
      const due = [];
      for (const b of blocks) {
        if (!b.key) {
          if (b.text) due.push(b.text);
          continue;
        }
        const last = seen.get(b.key) ?? '';
        if (b.text === last) continue;
        if (b.text) due.push(b.text);
        else if (b.cleared) due.push(b.cleared);
        seen.set(b.key, b.text);
      }
      // Notices go to the conductor's (root) session only: a child that took them would
      // leave the conductor never seeing them. The worker child must not stamp the user's
      // notices shown, or settlement would prune them unseen. The take is the last step
      // before the append, so nothing after it can fail and lose them.
      if (!kind.why && kind.kind === 'root' && !inWorkerChild(env)) {
        const notices = takeNotices(root, now());
        if (notices.length) due.push(`STERLING NOTICES (from the end of the last turn):\n${notices.map((n) => `- ${n.text}`).join('\n')}`);
      }
      if (due.length) input.prompt.text = `${input.prompt.text}\n\n${VOLATILE_HEADER}\n\n${due.join('\n\n')}`;
    });
  }

  return {
    onContext,
    onPrompt,
    resetStatus: (root) => (statusCache.delete(root), maintenanceCache.delete(root), boardCache.delete(root)),
    // Compaction can summarize away what was delivered: the session's next prompt gets the whole set again.
    resetSession: (sessionID) => void delivered.delete(sessionID),
  };
}
