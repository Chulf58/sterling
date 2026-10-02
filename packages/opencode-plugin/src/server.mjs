// Sterling's OpenCode 2 server plugin: the knowledge loop in one small plugin
// (decision sterling-on-opencode-2-is-the-knowledge-loop-in-one-small-plugin).
// It reuses the libraries Claude Code's hooks run on and changes none of them:
//   1. session context: the Sterling layer (templates/target-claude-md.md, the
//      file init renders into CLAUDE.md) with its Claude-only phrases mapped
//      to OpenCode, an OpenCode host tail naming the resolved Sterling root, a
//      status line and pending notices;
//   2. execute.before/after on read, edit and write: H19-style knowledge
//      delivery appended to the tool result;
//   3. session.execution.succeeded: settlement (mint reconcile duties, then
//      advance the settled snapshot), the maintenance worker, and a notice the
//      model sees at the next turn;
//   4. the prompt hook: a record selected in the dashboard is taken once from
//      the store and appended to the next prompt, as H2 does on Claude Code;
//   5. the compaction hook: the session's delivery receipts are removed, so
//      delivery fires again after compaction drops context.
// The store guard (edit deny on .sterling/sterling.db) is not here: the
// installer writes it into .opencode/opencode.json (scripts/lib/opencode-install.mjs).
// Every handler is fenced: a throw is logged to .sterling/transient and turned
// into a notice, never raised into OpenCode. Outside a Sterling project (no
// .sterling/sterling.db above the session directory) every handler is a no-op.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { SterlingStore, SUPPORTED_SCHEMA_VERSION } from '@sterling/store';
import { gitIgnored, loadConfig, projectRoot, repoRel } from '../../../scripts/hooks/lib/common.mjs';
import { isForeignTree } from '../../../scripts/hooks/lib/working-tree.mjs';
import {
  assembleDelivery,
  budgetKnownGaps,
  decisionPointerPart,
  deliverySessionDir,
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
import { sterlingRootFrom } from '../../../scripts/lib/opencode-install.mjs';
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
export const BUDGET_MS = { context: 4000, delivery: 4000, settle: 30000, prompt: 4000, compaction: 4000 };

export const NOTICES_REL = '.sterling/transient/opencode-notices.json';
export const LOG_REL = '.sterling/transient/opencode-plugin.log';
const DELIVERY_TOOLS = new Set(['read', 'edit', 'write']);
const PENDING_CAP = 200;
const STATUS_TTL_MS = 10_000;

/**
 * The OpenCode host section appended after the host-mapped layer. `pluginRoot`
 * is the resolved Sterling root, or null when it could not be resolved.
 */
export function opencodeHostTail(pluginRoot) {
  const install = pluginRoot
    ? `- **Sterling is installed at \`${pluginRoot}\`.** Its scripts are \`${pluginRoot}/bin/*.mjs\` (run one with \`node "${pluginRoot}/bin/<name>.mjs"\`), its commands are \`${pluginRoot}/commands/*.md\`, its skills are \`${pluginRoot}/skills/*/SKILL.md\` and its agent templates are under \`${pluginRoot}/agent-templates/\`. Those files are written for Claude Code: where one says CLAUDE_PLUGIN_ROOT, use \`${pluginRoot}\`, and read the rest with the substitutions this layer makes.`
    : "- **Sterling's install root could not be resolved** (the error is above), so its scripts, commands and skills are unreachable this session. Tell the user before relying on any of them.";
  return [
    '## OpenCode host',
    '',
    "This session runs on OpenCode, not Claude Code. The layer above is Sterling's Claude Code layer with its Claude-only phrases rewritten for OpenCode. The other differences:",
    '',
    install,
    '- **/plugin, --plugin-dir and the marketplace** do not apply. OpenCode loads Sterling through the plugin shim in its config dir. Slash commands, .claude/agents and .claude/settings.json are Claude Code surfaces and are absent here; to run a Sterling command this layer names, read its file under the commands directory and follow it.',
    '- **There is no stop block.** When a turn ends, Sterling settles the files it changed. Capture and reconcile duties it finds arrive as a STERLING NOTICE in the next turn; act on them before new work.',
    `- **The conductor role** (${pluginRoot ? `\`${pluginRoot}/agent-templates/conductor.md\`` : 'agent-templates/conductor.md'}) is yours in the main session. Dispatch subagents with the \`subagent\` tool.`,
  ].join('\n');
}

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

/**
 * The Sterling plugin root above this module. The source
 * (packages/opencode-plugin/src) and the committed bundle (opencode/) both sit
 * under it, so this is the root of whichever Sterling the shim loaded. It
 * delegates to the installer's sterlingRootFrom, the one root resolver the
 * OpenCode side and the dashboard share; the default URL is this module's own.
 */
export function sterlingRoot(moduleUrl = import.meta.url) {
  return sterlingRootFrom(moduleUrl);
}

export function defaultTemplatePath(moduleUrl = import.meta.url) {
  return join(sterlingRoot(moduleUrl), 'templates', 'target-claude-md.md');
}

// The Claude-only phrases of templates/target-claude-md.md and their OpenCode
// equivalents. A `phrase` is a literal the template must contain; a `lead`
// replaces the whole bullet that starts with it. One that matches nothing means
// the template drifted, and the render throws. `r` is the resolved Sterling root.
const LAYER_HOST_MAP = [
  { id: 'agents-import', phrase: '@AGENTS.md\n', to: () => '' },
  {
    id: 'conductor-install',
    phrase: "installed to this project's `.claude/agents/conductor.md` by install-agents/sync-agents and activated as the main-session agent through `\"agent\": \"conductor\"` in `.claude/settings.json`",
    to: () => "installed on OpenCode to this project's `.opencode/agents/sterling/conductor.md` by Sterling's init and update and made the default agent through `default_agent: \"sterling/conductor\"` in `.opencode/opencode.json` (on Claude Code: `.claude/agents/conductor.md`, activated in `.claude/settings.json`)",
  },
  {
    id: 'delivery-h19',
    phrase: 'H19 delivery helps here but does not excuse you:',
    to: () => 'Knowledge delivery (H19 on Claude Code; on OpenCode the Sterling plugin appends it to read, edit and write tool results, not yet to shell or patch) helps here but does not excuse you:',
  },
  {
    id: 'concept-designed-h10',
    phrase: 'so H10 holds the demand at session end',
    to: () => 'so the demand is held at session end (H10 does this on Claude Code; OpenCode does not mint it yet, so write the concept article before the turn ends)',
  },
  {
    id: 'wired-h7-h10',
    lead: '- **Wired, not just asked:**',
    to: () =>
      '- **Wired, not just asked:** on Claude Code H7 and H10 do this. On OpenCode the Sterling plugin settles each finished turn: the owning article of a changed file gets a maintenance item (`reconcile_needed`) and a STERLING NOTICE in the next turn. The demand for an owning article of unowned territory (`article_missing`) and for the concept article of a registered `concept_designed` event (`concept_article_missing`) are not minted on OpenCode yet, so meet them yourself before the work is done.',
  },
  { id: 'ask-question-tool', phrase: 'through the AskUserQuestion tool.**', to: () => "through OpenCode's `question` tool (AskUserQuestion on Claude Code).**" },
  { id: 'ask-question-form', phrase: 'goes through the AskUserQuestion tool form', to: () => 'goes through the `question` tool form' },
  {
    id: 'de-ai-skill',
    phrase: 'Run `sterling:de-ai-writing` on prose deliverables before they ship.**',
    to: (r) => `Run the de-ai-writing skill (\`${r}/skills/de-ai-writing/SKILL.md\`) on prose deliverables before they ship.**`,
  },
  {
    id: 'de-ai-scanner',
    phrase: "(the skill's scanner plus a read)",
    to: (r) => `(its scanner, \`node "${r}/skills/de-ai-writing/scripts/check-ai-signs.mjs" <file>\`, plus a read)`,
  },
  {
    id: 'review-territory-h22',
    phrase: 'Without it H22 falls back to prose-scraping the brief; H22 warns on a reviewer dispatch missing the line.',
    to: () => 'On Claude Code H22 reads the line, falls back to prose-scraping the brief without it and warns on a reviewer dispatch that lacks it. OpenCode has no H22; the line is still required, so a brief reads the same on both hosts.',
  },
  {
    id: 'store-guard-h15',
    phrase: '(Enforced: H15 — one rule:',
    to: () => '(Enforced on Claude Code by H15, and on OpenCode by the edit deny on `.sterling/sterling.db*` in `.opencode/opencode.json`, which covers the edit and write tools but not the shell — one rule:',
  },
  {
    id: 'platform-mechanics',
    phrase: "Claude Code's hook, frontmatter and transcript mechanics move between versions.",
    to: () => "OpenCode's plugin hooks, agent files and config move between versions, as Claude Code's hooks, frontmatter and transcripts do.",
  },
  {
    id: 'codex-availability',
    phrase: 'uses the `codex` MCP tool, with the lane',
    to: () => 'uses the `codex` MCP tool (on OpenCode only when a `codex` MCP server is configured for it; if the tool is absent, say so and skip the Codex lane), with the lane',
  },
  {
    id: 'codex-background',
    phrase: 'A call still running after 120s backgrounds itself and returns its result as a notification — normal, not a hang.',
    to: () => 'On Claude Code a call still running after 120s moves to the background and reports back as a notification. How OpenCode handles a long Codex call is unmeasured, so a slow call is not by itself a hang.',
  },
  {
    id: 'ready-for-new-session',
    lead: '- **Say `READY TO CLEAR` plainly when it is time.**',
    to: (r) =>
      `- **Say \`READY FOR NEW SESSION\` plainly when it is time.** At a clean boundary (the slice is committed, the rotation note is written by \`node "${r}/bin/rotation-note.mjs"\`, and nothing is in flight: no running lane, no uncommitted change, no pending capture), end the reply with the literal line \`READY FOR NEW SESSION\` in capitals, on its own line; the user then starts a new session with /new. If the session changed plugin or MCP-server code, write \`EXIT AND RELAUNCH\` instead, so OpenCode restarts on the new code. Never use a soft variant such as "fine to start over whenever you like". If something is still in flight, name it and do not print the line. User-stated 2026-09-26 for this line's Claude Code form, and user-ruled for OpenCode as this new-session wording: a hedged phrase buried in a summary gets missed, and the user is the one who starts the new session. OpenCode does not restore the rotation note into the new session yet, so put its path (\`.sterling/transient/rotation-note.json\`) under the line for the user to hand over.`,
  },
  { id: 'version-banner', phrase: '(the same value the session-start banner prints)', to: (r) => `(on OpenCode, read it from \`${r}/.claude-plugin/plugin.json\`)` },
  {
    id: 'agent-currency',
    phrase: ', and whether the session-start banner reported an AGENT CURRENCY warning',
    to: () => ', and whether the session-start banner reported an AGENT CURRENCY warning (that banner is Claude Code only; on OpenCode say that no agent-currency check ran)',
  },
  {
    id: 'strict-mcp-config',
    phrase: '- **A user-scope MCP server entry can be silently dropped under `--strict-mcp-config`.**',
    to: () => "- **On Claude Code, a user-scope MCP server entry can be silently dropped under `--strict-mcp-config`.** (OpenCode reads its MCP servers from its own config and the project's `.opencode/opencode.json`.)",
  },
];

// Left in the layer after mapping, any of these would give the OpenCode model a
// Claude Code instruction it cannot carry out.
const CLAUDE_ONLY_RESIDUE = ['${CLAUDE_PLUGIN_ROOT}', 'READY TO CLEAR', '/clear'];

/** Rewrite the Claude-only phrases of the layer for OpenCode; throws on template drift or an unmapped phrase. */
export function hostMapLayer(text, pluginRoot) {
  let out = text;
  for (const m of LAYER_HOST_MAP) {
    if (m.lead) {
      const lines = out.split('\n');
      const i = lines.findIndex((l) => l.startsWith(m.lead));
      if (i < 0) throw new Error(`Sterling layer host mapping '${m.id}': the bullet "${m.lead}" was not found in the template`);
      lines[i] = m.to(pluginRoot);
      out = lines.join('\n');
    } else {
      if (!out.includes(m.phrase)) throw new Error(`Sterling layer host mapping '${m.id}': "${m.phrase}" was not found in the template`);
      out = out.replaceAll(m.phrase, () => m.to(pluginRoot));
    }
  }
  out = out.replaceAll('${CLAUDE_PLUGIN_ROOT}', () => pluginRoot);
  out = out.replace(/`?\/sterling:([a-z][a-z-]*)`?/g, (whole, name) => {
    const file = join(pluginRoot, 'commands', `${name}.md`);
    if (!existsSync(file)) throw new Error(`Sterling layer host mapping: the template names /sterling:${name}, but ${file} does not exist`);
    return `${whole} (on OpenCode: follow \`${file}\`)`;
  });
  const left = CLAUDE_ONLY_RESIDUE.filter((t) => out.includes(t));
  if (left.length) throw new Error(`Sterling layer has unmapped Claude-only phrase(s) for OpenCode: ${left.join(', ')}`);
  return out;
}

/** The Sterling layer as init renders it into CLAUDE.md, host-mapped for OpenCode, plus the OpenCode host tail. */
export function renderSterlingLayer(projectDir, pluginRoot = sterlingRoot(), templatePath = join(pluginRoot, 'templates', 'target-claude-md.md')) {
  const projectName = loadConfig(projectDir)?.project_name ?? basename(projectDir);
  const mapped = hostMapLayer(readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n'), pluginRoot);
  return `${mapped.replaceAll('{{PROJECT_NAME}}', () => projectName).trimEnd()}\n\n${opencodeHostTail(pluginRoot)}`;
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
 * claudeOnPath(), launchWorker(opts), sterlingRoot (a path).
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
      let pluginRoot = null;
      let layer;
      try {
        pluginRoot = deps.sterlingRoot ?? sterlingRoot();
        layer = renderSterlingLayer(root, pluginRoot);
      } catch (e) {
        logLine(root, `context: layer render failed: ${errText(e)}`);
        layer = `STERLING LAYER UNAVAILABLE: ${errText(e)}\n\n${opencodeHostTail(pluginRoot)}`;
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

  /**
   * Compaction can drop a delivered article from the model's window, so the
   * session's delivery receipts go with it and delivery fires again, as
   * h19-clear-session does on Claude Code. Never sets input.result.
   */
  async function onCompaction(input) {
    const root = rootOf();
    if (!root) return;
    await fenced('compaction', root, () => {
      const dir = deliverySessionDir(root, input?.sessionID);
      if (!dir) throw new Error(`compaction input has no usable sessionID (${typeof input?.sessionID}); delivery receipts were not reset`);
      rmSync(dir, { recursive: true, force: true });
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
