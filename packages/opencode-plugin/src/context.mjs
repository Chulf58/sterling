// The session context handler: the rendered layer, the status line, H1's operating-state
// lines, the rotation restore and pending notices, pushed into the system prompt of every
// request, plus H19's dispatch staging for a child (subagent) session.
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
import { briefOf, notStagedLine, stageChild } from './staging.mjs';
import { agentRole } from './agent-name.mjs';
import { remember } from './bounded.mjs';
import { sessionKind } from './dispatch.mjs';
import { inWorkerChild } from './worker.mjs';

const STATUS_TTL_MS = 10_000;
// The undeclared-source scan spawns git twice, so a process reuses its answer for this long.
const UNDECLARED_TTL_MS = 5 * 60_000;

/**
 * `getSession()` returns the plugin context's session domain, as restore.mjs and sync.mjs take it; a session it cannot classify gets the loud not-staged line.
 * `parents` is the session-to-parentID cache shared with the settlement gate. `sweepStale(root)` (dispatch.mjs sweepStaleDispatches)
 * runs once per project root per process at the first root request and returns a line to show, or ''; never when `env` (process.env)
 * carries the maintenance worker flag. `swept` holds the roots already swept; the server passes one set to every location's handler.
 * `rotationRestore(root, sessionID)` is restore.mjs's gate; `sessionSync(root, sessionID)` is sync.mjs's once-per-process step; `pluginRoot` is the
 * test override for the resolved Sterling root. Returns the handler and
 * `resetStatus(root)`, which drops the cached status line and maintenance summary.
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
   * readiness function. The system prompt is rebuilt per request, so this also
   * covers what H20's mid-session line does on Claude Code.
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

  async function onContext(input) {
    const root = rootOf();
    if (!root) return;
    await fenced('context', root, async () => {
      await sessionSync(root, input.sessionID);
      const restore = await rotationRestore(root, input.sessionID);
      let pluginRoot = null;
      let layer;
      try {
        pluginRoot = pluginRootOverride ?? sterlingRoot();
        layer = renderSterlingLayer(root, pluginRoot);
      } catch (e) {
        logLine(root, `context: layer render failed: ${errText(e)}`);
        layer = `STERLING LAYER UNAVAILABLE: ${errText(e)}\n\n${opencodeHostTail(pluginRoot)}`;
      }
      const blocks = [layer, statusLine(root)];
      const state = operatingStateLines(root, pluginRoot, { opener: openStore });
      blocks.push(...state.lines);
      blocks.push(...maintenanceBlocks(root, state.config));
      const kind = await sessionKind(getSession?.(), input.sessionID, parents);
      if (kind.why) {
        // Neither root nor child can be assumed: no staging guess, and the loud line H19 prints.
        logLine(root, `context: child staging skipped for ${input.sessionID}, session lookup failed: ${kind.why}`);
        blocks.push(notStagedLine('session-lookup-failed'));
      } else if (kind.kind === 'root') {
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
            blocks.push(line);
          }
        }
        const undeclared = undeclaredBlock(root, state.config);
        if (undeclared) blocks.push(undeclared);
        // Root sessions only, and never inside the maintenance worker's own child
        // (anti-pattern e40bf982): the worker is not the conductor filling lanes.
        if (!inWorkerChild(env)) {
          const board = boardBlock(root, state.config, input.sessionID);
          if (board) blocks.push(board);
        }
      } else {
        const staged = await childStaging(root, input);
        if (staged) blocks.push(staged);
      }
      if (restore) blocks.push(restore);
      // The worker child must not stamp the user's notices shown: settlement would then prune them unseen.
      const notices = inWorkerChild(env) ? [] : takeNotices(root, now());
      if (notices.length) blocks.push(`STERLING NOTICES (from the end of the last turn):\n${notices.map((n) => `- ${n.text}`).join('\n')}`);
      input.system.push({ type: 'text', text: blocks.join('\n\n') });
    });
  }

  return { onContext, resetStatus: (root) => (statusCache.delete(root), maintenanceCache.delete(root), boardCache.delete(root)) };
}
