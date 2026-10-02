// Sterling's OpenCode 2 server plugin: the knowledge loop in one small plugin
// (decision sterling-on-opencode-2-is-the-knowledge-loop-in-one-small-plugin).
// It reuses the libraries Claude Code's hooks run on and changes none of them:
//   1. session context: the Sterling layer (templates/target-claude-md.md, the
//      file init renders into CLAUDE.md) plus an OpenCode host tail, a status
//      line and pending notices;
//   2. execute.before/after on read, edit and write: H19-style knowledge
//      delivery appended to the tool result;
//   3. session.execution.succeeded: settlement (mint reconcile duties, then
//      advance the settled snapshot), the maintenance worker, and a notice the
//      model sees at the next turn;
//   4. the prompt hook: a record selected in the dashboard is taken once from
//      the store and appended to the next prompt, as H2 does on Claude Code.
// The store guard (edit deny on .sterling/sterling.db) is not here: the
// installer writes it into .opencode/opencode.json (scripts/lib/opencode-install.mjs).
// Every handler is fenced: a throw is logged to .sterling/transient and turned
// into a notice, never raised into OpenCode. Outside a Sterling project (no
// .sterling/sterling.db above the session directory) every handler is a no-op.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SterlingStore, SUPPORTED_SCHEMA_VERSION } from '@sterling/store';
import { gitIgnored, loadConfig, projectRoot, repoRel } from '../../../scripts/hooks/lib/common.mjs';
import { isForeignTree } from '../../../scripts/hooks/lib/working-tree.mjs';
import {
  assembleDelivery,
  budgetKnownGaps,
  decisionPointerPart,
  guardPath,
  hazardParts,
  isDiscoveryDelivered,
  isOwnerDiscoveryOnly,
  isSubstanceDelivered,
  markDiscoveryDelivered,
  markSubstanceDelivered,
  ownerPointer,
  ownerSuffix,
  rankFileDecisionPointers,
  readGuard,
  recordRevision,
  renderArticle,
  renderPayload,
  renderReference,
  resolveTotalCap,
  writeGuard,
} from '../../../scripts/hooks/lib/delivery.mjs';
import { gitTouches, mintSettlementReconcile, writeGitSettled, writeInitialGitSettled } from '../../../scripts/hooks/lib/settlement.mjs';
import { maybeLaunchMaintenanceWorker } from '../../../scripts/hooks/lib/maintenance-worker.mjs';
import { readRegister } from '../../../scripts/lib/dispatch-register.mjs';
import { probeSchemaVersion } from '../../../scripts/lib/update.mjs';

export const PLUGIN_ID = 'sterling.server';

// node:sqlite is synchronous, so a write that waits on another process's lock
// freezes OpenCode's whole event loop for the wait (measured 2026-10-02 in
// OpenCode 2.0.21's Bun 1.4.2: 5056 ms at the store's default 5000, zero timer
// ticks). A store write measured 37-73 ms, so 1000 ms still waits out an
// ordinary concurrent commit; a write that loses the race throws, and
// settlement retries the same range at the next execution.
export const BUSY_TIMEOUT_MS = 1000;

// Per-handler budgets. The store calls are synchronous and cannot be cut off
// mid-call; the budget bounds the awaited part and logs any overrun.
export const BUDGET_MS = { context: 4000, delivery: 4000, settle: 30000, prompt: 4000 };

export const NOTICES_REL = '.sterling/transient/opencode-notices.json';
export const LOG_REL = '.sterling/transient/opencode-plugin.log';
const DELIVERY_TOOLS = new Set(['read', 'edit', 'write']);
const PENDING_CAP = 200;
const STATUS_TTL_MS = 10_000;

export const OPENCODE_HOST_TAIL = [
  '## OpenCode host',
  '',
  'This session runs on OpenCode, not Claude Code. The layer above is written for Claude Code; read it with these substitutions:',
  '',
  "- **AskUserQuestion** is OpenCode's `question` tool. A ruling still exists only if it came through that form.",
  '- **/plugin, --plugin-dir and the marketplace** do not apply. OpenCode loads Sterling from its plugin config; /sterling:* slash commands, .claude/agents and .claude/settings.json are Claude Code surfaces and are absent here.',
  '- **There is no stop block.** When a turn ends, Sterling settles the files it changed. Capture and reconcile duties it finds arrive as a STERLING NOTICE in the next turn; act on them before new work.',
  '- **The conductor role** (agent-templates/conductor.md) is yours in the main session. Dispatch subagents with the `subagent` tool.',
  '- **The codex MCP tool** is available only if it is configured in OpenCode\'s MCP settings; otherwise skip the Codex lanes and say so.',
].join('\n');

/** Open the project store with the short in-process busy timeout. */
export function openProjectStore(dbPath) {
  const store = new SterlingStore(dbPath);
  // SterlingStore sets busy_timeout=5000 in its constructor and exposes no
  // option for it; `db` is TypeScript-private only. A missing handle is a
  // store change this plugin must hear about, so it throws.
  const db = store['db'];
  if (!db || typeof db.exec !== 'function') {
    store.close();
    throw new Error('SterlingStore no longer exposes its database handle; cannot set the in-process busy_timeout');
  }
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  return store;
}

/** templates/target-claude-md.md above this module: the source (packages/opencode-plugin/src) and the bundle (opencode/) both sit under the plugin root. */
export function defaultTemplatePath(moduleUrl = import.meta.url) {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'templates', 'target-claude-md.md');
    if (existsSync(p)) return p;
    dir = dirname(dir);
  }
  throw new Error(`templates/target-claude-md.md not found above ${dirname(fileURLToPath(moduleUrl))}`);
}

/** The Sterling layer as init renders it into CLAUDE.md, plus the OpenCode host tail. */
export function renderSterlingLayer(root, templatePath = defaultTemplatePath()) {
  const projectName = loadConfig(root)?.project_name ?? basename(root);
  return `${readFileSync(templatePath, 'utf8').replaceAll('{{PROJECT_NAME}}', projectName).trimEnd()}\n\n${OPENCODE_HOST_TAIL}`;
}

const errText = (e) => String((e && e.message) || e);

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function readNotices(root) {
  const p = join(root, NOTICES_REL);
  if (!existsSync(p)) return [];
  const parsed = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${NOTICES_REL} is not a JSON array`);
  return parsed;
}

export function addNotice(root, text, now = new Date().toISOString()) {
  const notices = readNotices(root);
  if (notices.some((n) => n.text === text && !n.shown_at)) return;
  notices.push({ id: randomUUID(), at: now, text });
  writeJsonAtomic(join(root, NOTICES_REL), notices);
}

/** Notices to show now. Each is stamped shown_at the first time; it stays visible for the rest of that execution and is pruned at its end. */
function takeNotices(root, now) {
  const notices = readNotices(root);
  if (!notices.length) return [];
  let changed = false;
  for (const n of notices) {
    if (!n.shown_at) {
      n.shown_at = now;
      changed = true;
    }
  }
  if (changed) writeJsonAtomic(join(root, NOTICES_REL), notices);
  return notices;
}

function pruneShownNotices(root) {
  const notices = readNotices(root);
  const left = notices.filter((n) => !n.shown_at);
  if (left.length === notices.length) return;
  if (left.length) writeJsonAtomic(join(root, NOTICES_REL), left);
  else rmSync(join(root, NOTICES_REL), { force: true });
}

function logLine(root, line) {
  const p = join(root, LOG_REL);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
}

function claudeOnPathDefault() {
  return (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'claude')));
}

/**
 * A live Claude Code dispatch means H10 is holding paths it will settle
 * itself, so the snapshot must not advance past them. Any row without
 * `ended` counts; a register that cannot be read counts as live (fail closed).
 */
export function liveDispatch(root) {
  const reg = readRegister(root);
  if (reg.availability === 'absent') return { live: false };
  if (reg.availability !== 'ok') return { live: true, why: `the dispatch register is ${reg.availability}` };
  const rows = reg.entries.filter((e) => !e.ended);
  return rows.length ? { live: true, why: `${rows.length} Claude dispatch(es) still registered (${rows.map((r) => r.agent_id).join(', ')})` } : { live: false };
}

/** H19's file-touch payload for `rel`, or null when nothing is fresh. `commit()` marks it delivered and must run only after the text reached the result. */
function buildDelivery(store, root, rel, sessionID) {
  const owners = store.query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 }).filter((r) => !isForeignTree(r, root));
  const hazards = store.query({ types: ['anti_pattern'], file_keys: [rel], cap: 100 });
  const decisions = store.query({ types: ['decision'], file_keys: [rel], cap: 100 });
  const gPath = guardPath(root, undefined, sessionID);
  const guard = readGuard(gPath);
  const freshHazards = hazards.filter((r) => !isSubstanceDelivered(guard, r));
  const freshOwners = owners.filter((r) => (isOwnerDiscoveryOnly(r) ? !isDiscoveryDelivered(guard, r) : !isSubstanceDelivered(guard, r)));
  const freshDecisions = rankFileDecisionPointers(decisions.filter((r) => !isDiscoveryDelivered(guard, r)));
  const unowned = owners.length === 0 && !(gitIgnored([rel], root)?.has(rel) ?? false);
  const frontierFresh = unowned && !guard.frontier_files.includes(rel);
  if (!freshOwners.length && !freshHazards.length && !freshDecisions.length && !frontierFresh) return null;

  const gapsByOwner = budgetKnownGaps(freshOwners);
  const ownerParts = freshOwners.map((r) => {
    const text = r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r, { gaps: gapsByOwner.get(r.id), root });
    return { kind: 'ordinary', contentClass: isOwnerDiscoveryOnly(r) ? 'discovery' : 'substance', identity: r.id, revision: recordRevision(r), text, pointer: ownerPointer(text, r), suffix: ownerSuffix(r) };
  });
  const widen = `knowledge_query types:["decision"] file_keys:["${rel}"] cap:${freshDecisions.length}`;
  const decisionParts = freshDecisions.length ? [decisionPointerPart(rel, freshDecisions, { widen })] : [];
  const parts = [
    { kind: 'ordinary', contentClass: 'chrome', text: renderPayload(rel, [], { unowned, substantiveCount: freshOwners.length + freshHazards.length + freshDecisions.length }) },
    ...hazardParts(freshHazards, { fileKeys: [rel], mode: 'whole' }),
    ...ownerParts,
    ...decisionParts,
  ];
  const assembled = assembleDelivery(parts, resolveTotalCap(root));
  return {
    text: assembled.text,
    commit: () => {
      if (!gPath) return;
      markSubstanceDelivered(guard, assembled.emittedSubstance);
      markDiscoveryDelivered(guard, assembled.emittedDiscovery);
      if (frontierFresh) guard.frontier_files.push(rel);
      writeGuard(gPath, guard);
    },
  };
}

function appendToResult(result, text) {
  if (Array.isArray(result?.content)) result.content.push({ type: 'text', text });
  else if (typeof result?.content === 'string') result.content = `${result.content}\n\n${text}`;
  else throw new Error(`unrecognized tool result content shape (${typeof result?.content})`);
}

/**
 * The plugin factory. `deps` exists for tests: openStore(dbPath), now(),
 * claudeOnPath(), launchWorker(opts), templatePath.
 */
export function createSterlingServer(deps = {}) {
  const openStore = deps.openStore ?? openProjectStore;
  const now = deps.now ?? (() => new Date().toISOString());
  const claudeOnPath = deps.claudeOnPath ?? claudeOnPathDefault;
  const launchWorker = deps.launchWorker ?? maybeLaunchMaintenanceWorker;
  const pending = new Map();
  const statusCache = new Map();
  let directory = process.cwd();
  let chain = Promise.resolve();

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

  async function onContext(input) {
    const root = rootOf();
    if (!root) return;
    await fenced('context', root, () => {
      let layer;
      try {
        layer = renderSterlingLayer(root, deps.templatePath ?? defaultTemplatePath());
      } catch (e) {
        logLine(root, `context: layer render failed: ${errText(e)}`);
        layer = `STERLING LAYER UNAVAILABLE: ${errText(e)}\n\n${OPENCODE_HOST_TAIL}`;
      }
      const blocks = [layer, statusLine(root)];
      const notices = takeNotices(root, now());
      if (notices.length) blocks.push(`STERLING NOTICES (from the end of the last turn):\n${notices.map((n) => `- ${n.text}`).join('\n')}`);
      input.system.push({ type: 'text', text: blocks.join('\n\n') });
    });
  }

  async function onBefore(input) {
    if (!DELIVERY_TOOLS.has(input?.tool)) return;
    const root = rootOf();
    if (!root) return;
    await fenced('delivery', root, () => {
      const raw = input.input?.path;
      if (typeof raw !== 'string' || !raw) return;
      const rel = repoRel(isAbsolute(raw) ? raw : resolve(directory, raw), root);
      if (!rel || rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.sterling/')) return;
      const store = openStore(join(root, '.sterling', 'sterling.db'));
      try {
        const delivery = buildDelivery(store, root, rel, input.sessionID);
        if (!delivery) return;
        pending.set(input.id, delivery);
        while (pending.size > PENDING_CAP) pending.delete(pending.keys().next().value);
      } finally {
        store.close();
      }
    });
  }

  async function onAfter(input) {
    const delivery = pending.get(input?.id);
    if (!delivery) return;
    pending.delete(input.id);
    const root = rootOf();
    if (!root || input.status !== 'completed') return;
    await fenced('delivery', root, () => {
      appendToResult(input.result, delivery.text);
      delivery.commit();
    });
  }

  async function settle(root) {
    pruneShownNotices(root);
    const at = now();
    const git = gitTouches(root, at);
    if (!git.ok) {
      if (git.reason !== 'no_git') addNotice(root, `Sterling settlement skipped: git could not answer (${git.reason}).`, at);
      return;
    }
    if (!git.settled) {
      writeInitialGitSettled(root, git.next);
      return;
    }
    const dispatch = liveDispatch(root);
    let store;
    try {
      store = openStore(join(root, '.sterling', 'sterling.db'));
      const minted = mintSettlementReconcile(store, root, git.candidates.map((c) => c.path), at);
      if (!dispatch.live) writeGitSettled(root, git.next);
      if (minted.length) {
        const lines = minted.map((m) => {
          const a = store.get(m.article_id);
          return `${a?.slug ?? m.article_id} (${m.paths.join(', ')})`;
        });
        addNotice(root, `Sterling settlement: the last turn changed files owned by ${minted.length} article(s) and queued reconcile duties: ${lines.join('; ')}. Bring each article in line with the change (knowledge_update), or confirm it already is.`, at);
      }
      if (git.base_lost) addNotice(root, `Sterling settlement: the settled commit ${git.settled.sha} is no longer reachable from HEAD ${git.next.sha}; duties for the commits between them were not derived. Reconcile them by hand from git log.`, at);
      if (dispatch.live) addNotice(root, `Sterling settlement: the settled snapshot was not advanced because ${dispatch.why}; Claude Code settles those paths when the dispatch ends.`, at);
    } catch (e) {
      logLine(root, `settle failed: ${errText(e)}`);
      addNotice(root, `Sterling settlement failed (${errText(e)}); the settled snapshot was not advanced, so the next turn retries the same range.`, at);
      return;
    } finally {
      store?.close();
    }
    if (!claudeOnPath()) return;
    let workerStore;
    try {
      workerStore = openStore(join(root, '.sterling', 'sterling.db'));
      launchWorker({ root, config: loadConfig(root), store: workerStore, trigger: 'stop', spawn });
    } catch (e) {
      logLine(root, `maintenance worker launch failed: ${errText(e)}`);
      addNotice(root, `Sterling: the maintenance worker could not be launched (${errText(e)}).`, at);
    } finally {
      workerStore?.close();
    }
  }

  /** H2's one-shot selection handoff: the pending selection row is consumed and added to the prompt text. */
  async function onPrompt(input) {
    const root = rootOf();
    if (!root) return;
    await fenced('prompt', root, () => {
      // Checked before the take, so an unknown shape never consumes the selection.
      if (typeof input?.prompt?.text !== 'string') throw new Error(`unrecognized prompt shape (prompt.text is ${typeof input?.prompt?.text})`);
      const store = openStore(join(root, '.sterling', 'sterling.db'));
      let selection;
      try {
        selection = store.takeSelection();
      } finally {
        store.close();
      }
      if (!selection) return;
      input.prompt.text = `${input.prompt.text}\n\nTUI selection (one-shot): the user has selected ${selection.type} '${selection.record_id}'. Resolve the selected record via knowledge_get before answering.`;
    });
  }

  async function onEvent(ev) {
    if (ev?.type !== 'session.execution.succeeded') return;
    const root = rootOf();
    if (!root) return;
    statusCache.delete(root);
    await fenced('settle', root, () => settle(root));
  }

  const handlers = { context: onContext, prompt: onPrompt, before: onBefore, after: onAfter, event: onEvent };

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
      await ctx.session.hook('context', onContext);
      await ctx.session.hook('prompt', onPrompt);
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
