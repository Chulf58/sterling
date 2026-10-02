// The session context handler: the rendered layer, the status line, H1's operating-state
// lines, the rotation restore and pending notices, pushed into the system prompt of every
// request, plus H19's dispatch staging for a child (subagent) session.
import { join } from 'node:path';
import { SUPPORTED_SCHEMA_VERSION } from '@sterling/store';
import { probeSchemaVersion } from '../../../scripts/lib/update.mjs';
import { opencodeHostTail, renderSterlingLayer, sterlingRoot } from './layer.mjs';
import { errText, logLine } from './log.mjs';
import { takeNotices } from './notices.mjs';
import { operatingStateLines, undeclaredSourceBlock } from './operating-state.mjs';
import { briefOf, notStagedLine, stageBrief } from './staging.mjs';

const STATUS_TTL_MS = 10_000;

/**
 * `getSession()` returns the plugin context's session domain, as restore.mjs and sync.mjs take it; without it no session is known to be a child and none is staged.
 * `rotationRestore(root, sessionID)` is restore.mjs's gate; `sessionSync(root, sessionID)` is sync.mjs's once-per-process step; `pluginRoot` is the
 * test override for the resolved Sterling root. Returns the handler and
 * `resetStatus(root)`, which drops the cached status line.
 */
export function createContextHandler({ openStore, now, rootOf, fenced, rotationRestore, sessionSync, pluginRoot: pluginRootOverride, getSession }) {
  const statusCache = new Map();
  // The undeclared-source scan spawns git, so it runs once per session (H1 runs it once per session start).
  const undeclaredCache = new Map();

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

  /** H19's staging for a child session: the records governing its own brief, a not-staged line, or ''. */
  async function childStaging(root, input) {
    const session = getSession?.();
    if (typeof input.sessionID !== 'string' || !input.sessionID || typeof session?.get !== 'function') return '';
    let info;
    try {
      info = await session.get({ sessionID: input.sessionID });
    } catch (e) {
      logLine(root, `context: child staging skipped for ${input.sessionID}, session lookup failed: ${errText(e)}`);
      return '';
    }
    if (!info?.parentID) return '';
    const brief = briefOf(input.messages);
    if (!brief) return notStagedLine('brief-unavailable');
    try {
      const store = openStore(join(root, '.sterling', 'sterling.db'));
      try {
        return stageBrief(store, root, input.sessionID, brief);
      } finally {
        store.close();
      }
    } catch (e) {
      logLine(root, `context: child staging failed for ${input.sessionID}: ${errText(e)}`);
      return notStagedLine('staging-failed');
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
      const state = operatingStateLines(root, pluginRoot);
      blocks.push(...state.lines);
      const undeclaredKey = `${root}\0${input.sessionID}`;
      if (!undeclaredCache.has(undeclaredKey)) undeclaredCache.set(undeclaredKey, undeclaredSourceBlock(root, state.config));
      if (undeclaredCache.get(undeclaredKey)) blocks.push(undeclaredCache.get(undeclaredKey));
      const staged = await childStaging(root, input);
      if (staged) blocks.push(staged);
      if (restore) blocks.push(restore);
      const notices = takeNotices(root, now());
      if (notices.length) blocks.push(`STERLING NOTICES (from the end of the last turn):\n${notices.map((n) => `- ${n.text}`).join('\n')}`);
      input.system.push({ type: 'text', text: blocks.join('\n\n') });
    });
  }

  return { onContext, resetStatus: (root) => statusCache.delete(root) };
}
