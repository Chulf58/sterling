// The session context, in two parts. STABLE: the rendered layer, plus H19's dispatch
// staging for a child (subagent) session, pushed into the system prompt of every request
// and the same bytes on each. VOLATILE: the status line, H1's operating-state and
// maintenance lines, the plan lock, the dispatch sweep, board readiness, the rotation
// restore and pending notices, appended to the session's next prompt text, or to the
// next read/edit/write/patch/shell result mid-turn, when they changed since they were
// last delivered there (user-ruled 2026-10-12, "Move live lines
// out": a system prompt that changed every turn re-wrote the whole conversation to the
// provider's prompt cache; finding why-is-the-prompt-cache-hit-rate-lower-on-opencode-codeburn).
import { join } from 'node:path';
import { SUPPORTED_SCHEMA_VERSION } from '@sterling/store';
import { probeSchemaVersion } from '../../../scripts/lib/update.mjs';
import { opencodeHostTail, renderSterlingLayer, sterlingRoot } from './layer.mjs';
import { errText, logLine } from './log.mjs';
import { NOTICES_REL, takeNotices } from './notices.mjs';
import { readMaintenanceState } from '../../../scripts/hooks/lib/maintenance-state.mjs';
import { laneCeiling, liveLanes, renderBoardReadiness } from '../../../scripts/hooks/lib/board-ready.mjs';
import { maintenanceLines, operatingStateLines, undeclaredSourceBlock } from './operating-state.mjs';
import { composeContext, dispatchChrome } from '../../../scripts/hooks/lib/stage-brief.mjs';
import { VOLATILE_HEADER, briefOf, notStagedLine, stageChild } from './staging.mjs';
import { createDeliveryPolicy } from './delivery-policy.mjs';
import { deliveryPolicyNotice } from '../../../scripts/hooks/lib/dispatch-prompt.mjs';
import { appendToResult, isDeliveryTool } from './delivery.mjs';
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
 * `deliveryPolicy` is the location's STERLING-DELIVERY tracker (delivery-policy.mjs); a child whose policy is not
 * 'on' is staged no records. It defaults to one built on `getSession` and `parents`.
 */
export function createContextHandler({ openStore, now, rootOf, fenced, rotationRestore, sessionSync, pluginRoot: pluginRootOverride, getSession, parents = new Map(), sweepStale, swept = new Set(), env = process.env, deliveryPolicy = createDeliveryPolicy({ getSession, parents }) }) {
  const statusCache = new Map();
  // The undeclared-source scan, per project root: root sessions only, refreshed on UNDECLARED_TTL_MS.
  const undeclaredCache = new Map();
  // The system-queue summary, refreshed on the status line's TTL: it reads every system todo.
  const maintenanceCache = new Map();
  // Per session, the system block its first request got, re-sent byte for byte on every later
  // request until a compaction (resetSession) or a new process (bounded, bounded.mjs).
  const frozenSystem = new Map();
  // H1's board readiness block, per project root, refreshed on the status line's TTL.
  const boardCache = new Map();
  // Per session, the text of each volatile block last delivered to it (bounded, bounded.mjs).
  const delivered = new Map();
  // The last root session whose start refreshed each project's registry row.
  const registrySeen = new Map();
  // One-shot lines produced but not yet delivered, by `${root}\0${name}`. Their guards
  // (`swept`, `registrySeen`) advance when the line is produced, and the sweep cannot
  // produce its line twice, so the line itself is kept here until it is delivered. A call
  // claims it (removes it) synchronously when it selects it and puts it back when its
  // append does not happen, so a read of the notices file that throws between production
  // and delivery loses nothing and two overlapping calls never both deliver it.
  const heldLines = new Map();
  // The newest generation held for each key, never deleted when a line is claimed or
  // delivered. A claim puts its line back only while its generation is still the newest,
  // so a failed older delivery cannot bring back a line a newer one has replaced, even
  // when that newer line has already been claimed by another call.
  const latestGeneration = new Map();
  function holdLine(key, line) {
    latestGeneration.set(key, (latestGeneration.get(key) ?? 0) + 1);
    heldLines.set(key, line);
  }

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
    // STERLING-DELIVERY: off (or a policy that cannot be established) stages no records:
    // the chrome alone, with the notice where the not-staged line would go.
    const policy = await deliveryPolicy.resolve(root, input.sessionID, input.messages);
    if (policy !== 'on') {
      const role = agentRole(input.agent);
      deliveryPolicy.markDisclosed(input.sessionID, policy);
      return composeContext({ agentType: role, ...dispatchChrome(root, role), unattributableLine: deliveryPolicyNotice(policy) });
    }
    const brief = briefOf(input.messages);
    try {
      const store = openStore(join(root, '.sterling', 'sterling.db'));
      try {
        // Staged once, at the child's first request: onContext freezes the result, so records the
        // guard ledger now holds as delivered ride every later request of this child.
        return stageChild({ store, root, sessionID: input.sessionID, agent: input.agent, brief, disclosure: brief ? '' : notStagedLine('brief-unavailable') }).text;
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
   * full-parity ruling the former ruling 'sterling-is-fully-standalone-on-opencode-2-full-parity-with-claude-code' (not in the current store)), from the same shared lib and the store's one
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
   * rendered once, at the session's first request, and those exact bytes are re-sent on
   * every later request, whatever changes meanwhile (a plan lock, the board, a degraded
   * render), so the provider's prompt cache keeps the conversation behind it. Only a
   * compaction (resetSession), which replaces the conversation anyway, or a new OpenCode
   * process renders it again (finding
   * why-is-the-prompt-cache-hit-rate-lower-on-opencode-codeburn; user-ruled 2026-10-12,
   * "Move live lines out"). What changes during a session is delivered by onPrompt.
   */
  async function onContext(input) {
    const root = rootOf();
    if (!root) return;
    await fenced('context', root, async () => {
      await sessionSync(root, input.sessionID);
      const frozen = frozenSystem.get(input.sessionID);
      if (frozen !== undefined) {
        input.system.push({ type: 'text', text: frozen });
        return;
      }
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
      const text = remember(frozenSystem, input.sessionID, blocks.join('\n\n'));
      input.system.push({ type: 'text', text });
    });
  }

  /**
   * The VOLATILE context of `sessionID`, as [{ key, text, cleared? }]. A keyed block is
   * delivered when its text differs from the one last delivered in the session; a block
   * with no key (a one-shot line: the sweep, a registry failure) until it is delivered (claimed from
   * `heldLines` when selected, put back by dueText's release when the append fails).
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
          holdLine(`${root}\0sweep`, line);
          logLine(root, `context: ${line}`);
        }
      }
      // H1's registry step, once per root session: last-seen and the row's stack tags
      // (scripts/hooks/lib/registry-refresh.mjs). Never in the worker child, whose
      // session is not the user's (the former ruling 'opencode-session-boundary-code-runs-in-the-maintenance-worker-child' (not in the current store)).
      if (!inWorkerChild(env) && registrySeen.get(root) !== sessionID) {
        registrySeen.set(root, sessionID);
        try {
          refreshRegistryRow(root, { config: state.config, at: now() });
        } catch (e) {
          holdLine(`${root}\0registry`, `STERLING PROJECT REGISTRY REFRESH FAILED (${errText(e)}): this project's last-seen time and stack tags in the shared registry were not updated, so other projects may list its old mounts.`);
          logLine(root, `context: project registry refresh failed: ${errText(e)}`);
        }
      }
      out.push({ key: 'undeclared', text: undeclaredBlock(root, state.config), cleared: 'UNDECLARED SOURCE: the undeclared-source finding shown earlier no longer applies.' });
      // Root sessions only, and never inside the maintenance worker's own child
      // (the former ruling 'opencode-session-boundary-code-runs-in-the-maintenance-worker-child' (not in the current store)): the worker is not the conductor filling lanes.
      if (!inWorkerChild(env)) out.push({ key: 'board', text: boardBlock(root, state.config, sessionID), cleared: 'BOARD READINESS: no user item is ready, waiting or blocked now; the lists shown earlier no longer apply.' });
    }
    out.push({ key: 'restore', text: await rotationRestore(root, sessionID) });
    // Held one-shot lines are claimed here, synchronously after the last await, so two
    // overlapping calls cannot both select one. dueText puts a claim back (`restore`)
    // when the append does not happen.
    if (kind === 'root' && !inWorkerChild(env)) {
      for (const [key, text] of [...heldLines]) {
        if (!key.startsWith(`${root}\0`)) continue;
        heldLines.delete(key);
        const generation = latestGeneration.get(key);
        out.push({ text, restore: () => { if (latestGeneration.get(key) === generation && !heldLines.has(key)) heldLines.set(key, text); } });
      }
    }
    return out;
  }

  /**
   * What to append for `sessionID` now, as { text, commit }: text is the STERLING CONTEXT
   * header and the volatile blocks that changed since they were last delivered in that
   * session, plus, in a root session, the notices not shown yet (each taken once,
   * notices.mjs), or '' when nothing changed. Nothing is marked delivered until the caller
   * has appended the text and calls commit(), so a failure on the way loses no line. When
   * the notices cannot be read, text is only a line saying so and commit is a no-op: the
   * other lines stay due for the next prompt or tool call. One record per session serves the prompt and the tool-result routes, so a
   * line goes out once by whichever route comes first. A session this process has not
   * delivered to (a new or resumed session, any session after an OpenCode restart or a
   * compaction) gets the whole current set once.
   */
  async function dueText(root, sessionID, where) {
    const kind = await sessionKind(getSession?.(), sessionID, parents);
    if (kind.why) logLine(root, `context: session ${sessionID} could not be told root or child at its ${where} (${kind.why}); only the lines every session gets are delivered`);
    const blocks = await volatileBlocks(root, sessionID, kind.why ? 'unknown' : kind.kind);
    const seen = delivered.get(sessionID) ?? new Map();
    const marks = new Map();
    const due = [];
    const claimed = [];
    const release = () => { for (const fn of claimed) fn(); };
    for (const b of blocks) {
      if (!b.key) {
        if (b.text) {
          due.push(b.text);
          if (b.restore) claimed.push(b.restore);
        }
        continue;
      }
      const last = seen.get(b.key) ?? '';
      if (b.text === last) continue;
      if (b.text) due.push(b.text);
      else if (b.cleared) due.push(b.cleared);
      marks.set(b.key, b.text);
    }
    // Notices go to the conductor's (root) session only: a child that took them would
    // leave the conductor never seeing them. The worker child must not stamp the user's
    // notices shown, or settlement would prune them unseen. Both callers check their
    // target's shape before calling, so nothing after this take can fail and lose them.
    if (!kind.why && kind.kind === 'root' && !inWorkerChild(env)) {
      let notices;
      try {
        notices = takeNotices(root, now());
      } catch (e) {
        // P5: said in-band and logged. The other lines are held back, unmarked, until it reads again.
        // The claims go back first: the log write can throw, and a claim neither restored nor committed is lost.
        release();
        logLine(root, `context: pending notices unreadable at the ${where}: ${errText(e)}`);
        return {
          text: `${VOLATILE_HEADER}\n\nSTERLING NOTICES UNREADABLE (${errText(e)}): the pending notices in ${NOTICES_REL} could not be read, so Sterling's other session lines are held back until they can; fix or delete that file.`,
          commit: () => {},
          release: () => {},
        };
      }
      if (notices.length) due.push(`STERLING NOTICES (new since the last ones you were shown):\n${notices.map((n) => `- ${n.text}`).join('\n')}`);
    }
    return {
      text: due.length ? `${VOLATILE_HEADER}\n\n${due.join('\n\n')}` : '',
      release,
      commit: () => {
        claimed.length = 0;
        if (!marks.size) return;
        const record = delivered.get(sessionID) ?? remember(delivered, sessionID, new Map());
        for (const [key, text] of marks) record.set(key, text);
      },
    };
  }

  /** The prompt hook: the due lines are appended to the session's next prompt text. */
  async function onPrompt(input) {
    const root = rootOf();
    if (!root) return;
    await fenced('context', root, async () => {
      if (typeof input?.prompt?.text !== 'string') throw new Error(`unrecognized prompt shape (prompt.text is ${typeof input?.prompt?.text})`);
      const due = await dueText(root, input.sessionID, 'prompt');
      try {
        if (due.text) input.prompt.text = `${input.prompt.text}\n\n${due.text}`;
      } catch (e) {
        due.release();
        throw e;
      }
      due.commit();
    });
  }

  /**
   * execute.after: lines that changed mid-turn are appended once to the result of a
   * completed read, edit, write, patch or shell call, the tools delivery.mjs appends to
   * (never the subagent tool, whose call carries a lane's brief), so the conductor sees
   * board, status and notice changes during a long turn without a new prompt
   * (user-ruled 2026-10-12, "Also deliver via tool results"). Computed once per call;
   * the store reads behind it are the status, maintenance and board caches (10 s).
   */
  async function onToolResult(input) {
    if (!isDeliveryTool(input?.tool) || input.status !== 'completed') return;
    const root = rootOf();
    if (!root) return;
    await fenced('context', root, async () => {
      // Checked before anything is marked delivered or a notice taken, so an unknown shape loses nothing.
      const content = input.result?.content;
      if (!Array.isArray(content) && typeof content !== 'string') throw new Error(`unrecognized tool result content shape (${typeof content}); the changed session lines wait for the next prompt or tool call`);
      const due = await dueText(root, input.sessionID, 'tool call');
      try {
        if (due.text) appendToResult(input.result, due.text);
      } catch (e) {
        due.release();
        throw e;
      }
      due.commit();
    });
  }

  return {
    onContext,
    onPrompt,
    onToolResult,
    resetStatus: (root) => (statusCache.delete(root), maintenanceCache.delete(root), boardCache.delete(root)),
    // Compaction replaces the conversation, so the cached prefix starts over anyway: the system block
    // is rendered again at the next request (picking up a template change or recovering a degraded
    // render), and the session's next prompt gets the whole set of lines again.
    resetSession: (sessionID) => void (delivered.delete(sessionID), frozenSystem.delete(sessionID)),
  };
}
