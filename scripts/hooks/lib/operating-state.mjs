// The host-neutral operating-state lines H1 states at SessionStart: the project
// config read with its three states, MACHINE ROLE, TDD posture, Workflow,
// Handoff files and the pending Sterling issue-report count, and the mounted domain lines.
// Extracted from h1-session-start.mjs so the OpenCode context hook
// (packages/opencode-plugin/src/context.mjs) renders the SAME text from the SAME
// code (board cbee2b3d, audit the former finding 'OpenCode parity audit' (not in the current store) row 2). Each line function returns the
// bare line, or '' when the line is not stated; the caller adds its own
// separator. Builtins, sibling libs and @sterling/store only: hooks bundle this module.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeRootFor } from '../../lib/worktree-root.mjs';
import { ProjectWorkflowError, opencodeModelRef, parseConfig, unsupportedAgents, workflowOfConfig } from '@sterling/schemas';
import { missingDomainWarning } from '@sterling/store';
import { loadConfig } from './common.mjs';
import { handoffSettingOf, HandoffGitError, HandoffSettingError } from '../../lib/handoff-projection.mjs';
import { noOriginRemote } from '../../lib/work-pr.mjs';
import { describeMountedDomains } from './subject-fan.mjs';

/**
 * H1 is SOFT (banner + conventions + counts): a malformed config must cost the
 * lines that read it, never the conventions injection, so this read never throws.
 * ABSENT and UNREADABLE are different facts: loadConfig returns null for an
 * absent file (the documented schema defaults apply) and THROWS on a malformed
 * one (`configUnreadable`, rendered UNKNOWN, never the default).
 *
 * A config that PARSES but is not an object (`[]`, `true`, `false`, `0`, `""`,
 * `"x"`, `5`) is unusable in exactly the way a throw is: every `config?.x?.y`
 * read optional-chains to undefined, which a posture line would otherwise render
 * as the documented default (review 2026-09-06). `null` is deliberately excluded:
 * it is an ABSENT file, and a file whose content is literally `null` is
 * indistinguishable from it (an accepted limitation pinned in
 * h1-tdd-posture-line.test.mjs). THE COMPARISON MUST STAY A NULL TEST, NOT A
 * TRUTHINESS TEST: `if (config && ...)` swallows `false`, `0` and `""` back into
 * a confident default.
 */
export function readProjectConfig(cwd) {
  let config = null;
  let configUnreadable = false;
  try {
    config = loadConfig(cwd);
  } catch {
    config = null;
    configUnreadable = true;
  }
  if (config !== null && (typeof config !== 'object' || Array.isArray(config))) {
    configUnreadable = true;
  }
  return { config, configUnreadable };
}

/**
 * STERLING ROOT (decision session-start-prints-the-sterling-root-plain-text-instructions-use-it,
 * GitHub issue #16): the absolute plugin root, printed at every session start so a plain-text
 * instruction can run `node "<Sterling root>/bin/<name>.mjs"`. ${CLAUDE_PLUGIN_ROOT} is not in the
 * Bash tool's environment, so the model has no other way to learn it. `root` must come from the
 * running hook's own location (walkUpPluginRoot), never from an env value; an unresolved root
 * (null) is stated loudly instead of printing a wrong path or nothing.
 */
export function sterlingRootLine(root) {
  if (root) return `STERLING ROOT: ${root}`;
  return 'STERLING ROOT: UNRESOLVED — this hook could not find the Sterling plugin root above its own location, so no script path can be given; scripts named as node "<Sterling root>/bin/<name>.mjs" cannot be run until the root is known (report it with /sterling:report-issue).';
}

/**
 * MACHINE ROLE (todo cabbc10f, decision foreign_a9b98b7d): stated ONLY when this
 * session's project IS a Sterling clone itself (`atClone`), or, for an installed
 * copy, in every project (`installedCopy`, the only place a session learns that
 * /plugin, not /sterling:update, moves the machine). Every other Sterling project
 * never sees the line; it exists because the committed CLAUDE.md's "this machine
 * authors" prose travels with every clone and misleads a session opened inside one.
 */
// Where the Sterling layer lives, per host: CLAUDE.md on Claude Code, the
// injected layer on OpenCode (as axis-compose's HOST_TEXT varies its wording).
const MACHINE_ROLE_LAYER = { claude: "Sterling layer in CLAUDE.md's", opencode: "Sterling layer's" };

export function machineRoleLine({ atClone, installedCopy, config, host = 'claude' }) {
  if (!Object.hasOwn(MACHINE_ROLE_LAYER, host)) throw new Error(`machineRoleLine: unknown host '${host}'`);
  const layer = MACHINE_ROLE_LAYER[host];
  if (installedCopy) {
    return 'MACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.';
  }
  if (!atClone) return '';
  const role = config?.machine_role;
  if (role === 'authoring') {
    return `MACHINE ROLE: AUTHORING (declared in .sterling/config.json machine_role) — Sterling work lands and merges here; the ${layer} authoring contract applies.`;
  }
  if (role === 'consumer') {
    return `MACHINE ROLE: CONSUMER — this clone consumes via /sterling:update. The ${layer} "this machine authors" language does NOT apply on this machine: never commit here, never hand-reconcile drift; a dirty generated file is discarded (git checkout -- <path>); currency comes only from /sterling:update.`;
  }
  return 'MACHINE ROLE: UNDECLARED — treat as CONSUMER (the safe posture) until declared. The authoring machine declares machine_role:"authoring" in .sterling/config.json once; a successful /sterling:update stamps "consumer" automatically.';
}

/**
 * TDD POSTURE (decision foreign_752caf98 tdd-and-mutation-toggles-in-system-tab):
 * the live per-project toggle. An absent key IS the documented schema default
 * (true); only an explicit `false` reads OFF. An unreadable config reports
 * UNKNOWN, never the default: rendering "ON" for a config that was never read
 * would state the exact opposite of the truth in a project where the toggle is OFF.
 */
export function tddPostureLine({ config, configUnreadable }) {
  if (configUnreadable) {
    return (
      'TDD posture: UNKNOWN — the project config could not be read, so ' +
      'config.tdd.enabled could not be determined. ' +
      'This is NOT the default posture: repair the config, or state your posture explicitly.'
    );
  }
  const tddOn = config?.tdd?.enabled !== false;
  return `TDD posture: tests-first ${tddOn ? 'ON' : 'OFF'} ` + `(config.tdd.enabled — TUI System tab; explicit asks still work)`;
}

/**
 * WORKFLOW (decisions settings-that-replace-project-mode-merge-path-reviewer-count and
 * settings-redesign-build-shape-one-legacy-to-canonical-config; the line that replaced
 * "Project mode"): the merge path, the Reviewers count and the Copilot review loop,
 * read through workflowOfConfig (a legacy mode is carried by the one transform). Three
 * states, as the TDD line: an absent config IS the schema default (direct, 1, loop
 * off); an unreadable config is UNKNOWN, never the default (anti-pattern
 * config-derived-posture-line-collapses-absent-into-unusable); a value the reader
 * refuses is INVALID, never either path. On the pull-request path with no 'origin'
 * remote (GitHub issue #39) the line says the merge is local. `root` makes the line
 * probe the remote itself, only on the pull-request path; a caller that passes no
 * root passes `noOrigin` instead. The line is informational: whether the handoff files
 * are written is its own setting (handoffFilesLine below).
 */
export function projectModeLine({ config, configUnreadable, noOrigin = false, root = null }) {
  if (configUnreadable) {
    return (
      'Workflow: UNKNOWN — the project config could not be read, so config.workflow (merge path, Reviewers, Copilot loop) could not be determined. ' +
      'This is NOT the default (direct merge, 1 reviewer, loop off): repair the config.'
    );
  }
  let wf;
  try {
    wf = workflowOfConfig(config ?? undefined, '.sterling/config.json');
  } catch (e) {
    if (!(e instanceof ProjectWorkflowError)) throw e;
    return `Workflow: INVALID — ${e.message}. /sterling:merge refuses to act on it until it is fixed (TUI System tab).`;
  }
  const pr = wf.merge === 'pr';
  const localPr = pr && (root ? noOriginRemote(root) : noOrigin);
  const loop = !wf.copilot_loop ? 'OFF' : pr ? 'ON' : 'ON but inactive (needs the pull-request merge path)';
  const head =
    `Workflow: merge path ${pr ? 'PULL REQUEST' : 'DIRECT'} · Reviewers: ${wf.reviewers} · Copilot loop: ${loop}` +
    (pr ? ` · auto-merge on clean: ${wf.auto_merge_on_clean ? 'ON' : 'OFF'}` : '') +
    ' (config.workflow — TUI System tab) — ';
  const ships = localPr
    ? "this repository has no 'origin' remote, so /sterling:merge merges locally like the direct merge path: no pull request and no Copilot review will happen."
    : pr
    ? `work ships as a pull request through /sterling:merge; nothing is merged directly${wf.copilot_loop ? ', and the Copilot review loop follows' : ''}.`
    : 'work ships by direct merge through /sterling:merge.';
  return `${head}${ships} Run ${wf.reviewers} task-end ${wf.reviewers === 1 ? 'reviewer' : 'reviewers in parallel'}, then one fix round and one re-check.`;
}

// The agents whose one model is an Overpass tier, grouped by model and effort in key order:
// "overpass/agentic-auto at effort high (implementor, scout), overpass/agentic-high (reviewer)".
const routeLabel = ({ model, effort }) => (effort ? `${model} at effort ${effort}` : model);

function overpassAgentRoutes(entries) {
  const groups = new Map();
  for (const [agent, route] of entries) {
    const label = routeLabel(route);
    groups.set(label, [...(groups.get(label) ?? []), agent]);
  }
  return [...groups].map(([label, names]) => `${label} (${names.join(', ')})`).join(', ');
}

/**
 * OVERPASS (decisions overpass-tiers-are-ordinary-model-choices-in-each-agent-s-pi and
 * settings-that-replace-project-mode-merge-path-reviewer-count): Overpass is no setting of its
 * own; an agent is routed through it when its one model is an overpass/<tier> (read through the
 * canonical transform, so a legacy config reads as it migrates). States: ON (OpenCode, provider
 * and each routed agent's model); NOT IN EFFECT (an agent holds an Overpass tier but the host is
 * not OpenCode, which Claude Code and agy cannot run); INVALID with the reader's error; UNKNOWN
 * for an unreadable config, never the off default (anti-pattern
 * config-derived-posture-line-collapses-absent-into-unusable); and silent when no agent is routed.
 */
export function overpassLine({ config, configUnreadable, host }) {
  if (configUnreadable) {
    return (
      'Overpass: UNKNOWN — the project config could not be read, so which agents run on Overpass tiers could not be determined. ' +
      'This is NOT the off default: repair the config.'
    );
  }
  let canon;
  try {
    canon = parseConfig(config ?? {});
  } catch (e) {
    return `Overpass: INVALID — ${(e && e.message) || e}. Fix .sterling/config.json (TUI System tab).`;
  }
  const routed = Object.entries(canon.models).filter(([, entry]) => typeof entry?.model === 'string' && entry.model.startsWith('overpass/'));
  if (routed.length === 0) return '';
  const routes = overpassAgentRoutes(routed.map(([agent, entry]) => [agent, { model: opencodeModelRef(entry.model, canon.overpass.provider), effort: entry.effort }]));
  if (host === 'opencode') return `Overpass: ON (provider '${canon.overpass.provider}', config.models — TUI System tab) — ${routes}.`;
  return `Overpass: NOT IN EFFECT — ${routes} are set to Overpass tiers, which only OpenCode can run; this host gets no copy of them.`;
}

/**
 * HOST FIT (decision one-model-per-agent-an-agent-has-a-single-model-not-a-claude): the agents
 * this session's host gets no copy of because it cannot run their one model, and the roles whose two
 * legacy models are not chosen yet. Read through unsupportedAgents (the canonical transform), so a
 * legacy config reads as it migrates. Silent when every agent runs here; an unreadable config is
 * UNKNOWN, never silence; a config unsupportedAgents cannot read says so (INVALID).
 */
export function unsupportedAgentsLine({ config, configUnreadable, host, root }) {
  if (configUnreadable) return 'Agents on this host: UNKNOWN — the project config could not be read, so which agents have no copy here could not be determined. Repair the config.';
  let rows;
  try {
    rows = unsupportedAgents(config ?? {}, [host]);
  } catch (e) {
    return `Agents on this host: INVALID — ${(e && e.message) || e}. Fix .sterling/config.json (TUI System tab).`;
  }
  if (rows.length === 0) return '';
  const named = (r) => (r.host === '*' ? `${r.agent} (two models; run /sterling:update to choose)` : `${r.agent} (${r.model})`);
  const conflicts = rows.filter((r) => r.host === '*');
  let noCopy = rows.filter((r) => r.host !== '*');
  const parts = [];
  // The conductor is the main session itself, not a dispatch, so its line says what THIS session runs on.
  // The selection being unsupported is one fact; the file on disk is another: an edited copy Sterling would
  // have removed is kept (unsupported_but_modified), and the session then runs that copy. `root` is the
  // checkout the agent files live in; without it the file state is not claimed either way.
  const conductor = noCopy.find((r) => r.agent === 'conductor');
  if (conductor && (host === 'claude' || host === 'opencode')) {
    noCopy = noCopy.filter((r) => r !== conductor);
    const rel = host === 'claude' ? '.claude/agents/conductor.md' : '.opencode/agents/sterling/conductor.md';
    const hostName = host === 'claude' ? 'Claude Code' : 'OpenCode';
    const fix = `pick a model ${hostName} can run for the conductor in the TUI System tab`;
    const present = root ? existsSync(join(root, rel)) : null;
    if (present === true) parts.push(`the conductor's model ${conductor.model} cannot run on ${hostName}; Sterling kept your edited ${rel} but no longer maintains it, so this session runs that edited copy on whatever model it names, not the configured one; ${fix}`);
    else if (host === 'claude') parts.push(`the conductor's model ${conductor.model} cannot run on Claude Code${present === false ? `, so it has no copy (${rel} is absent) and` : ', so'} this session does NOT run as Sterling's conductor even if .claude/settings.json names it; ${fix}`);
    else parts.push(`this session runs on OpenCode's default agent, not on Sterling's conductor, because the conductor's model ${conductor.model} cannot run on OpenCode${present === false ? ` (${rel} is absent; default_agent is left as it is)` : ''}; ${fix}`);
  }
  if (noCopy.length) parts.push(`no ${host === 'claude' ? 'Claude Code' : host === 'opencode' ? 'OpenCode' : 'agy'} copy of ${noCopy.map(named).join(', ')}: ${host} cannot run their model, so a dispatch to them fails loudly; change the agent's model in the TUI System tab`);
  if (conflicts.length) parts.push(`${conflicts.map(named).join(', ')}: dispatch refuses until you choose`);
  return `Agents on this host: ${parts.join('; ')}.`;
}

const STORAGE_TAIL = 'TUI System tab; switch with the move-store skill';

/**
 * STORAGE (decision storage-backend-is-its-own-config-key-written-only-by-store-move;
 * board 6ca1a3c5): informational and read-only, it says where this project's
 * stores live. Four separate states, resolved by the rule store routing uses
 * (packages/store/src/routing.ts): an absent key IS SQLite, 'sqlite' is SQLite
 * stated explicitly, 'postgres' is Served Postgres, and any other value is
 * UNRECOGNIZED, shown with its raw value and never as SQLite (routing refuses it
 * by name). An unreadable config is UNKNOWN, never the SQLite default. Reads no
 * database and the project identity file: the schema name is not shown.
 */
export function storageLine({ config, configUnreadable, root }) {
  // readProjectConfig reads a config.json whose content is literally `null` as an ABSENT
  // file (loadConfig returns null for both). Store routing rejects that file as malformed
  // (routing.ts readConfig: parseConfig(null) throws), so this line, which states what
  // routing will do, checks the file itself and keeps the null-content case UNKNOWN.
  // Storage-specific on purpose: the other lines keep their accepted behaviour for it
  // (pinned in h1-tdd-posture-line.test.mjs).
  const presentButNull = !configUnreadable && config === null && Boolean(root) && existsSync(join(storeRootFor(root), '.sterling', 'config.json'));
  if (configUnreadable || presentButNull) {
    return (
      'Storage: UNKNOWN — the project config could not be read, so config.storage could not be determined. ' +
      'This is NOT the SQLite default: repair the config.'
    );
  }
  const storage = config?.storage;
  if (storage === undefined) return `Storage: SQLITE (config.storage not set, so SQLite — ${STORAGE_TAIL})`;
  if (storage === 'sqlite') return `Storage: SQLITE (config.storage — ${STORAGE_TAIL})`;
  if (storage === 'postgres') return `Storage: SERVED POSTGRES (config.storage — ${STORAGE_TAIL})`;
  return (
    `Storage: UNRECOGNIZED (${JSON.stringify(storage)}) — config.storage must be 'sqlite' or 'postgres'; ` +
    'every store open refuses until it is fixed (TUI System tab shows it; only the move-store skill writes it).'
  );
}

const HANDOFF_SET ='the portable OpenCode agents and the handoff projection for colleagues without Sterling';

/**
 * HANDOFF FILES (decision
 * project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
 * informational only. States the EFFECTIVE setting, through the same resolver
 * the writers use (handoffSettingOf): config.handoff.enabled when it is set;
 * otherwise ON when handoff files are already tracked in git in `root`, else
 * OFF (not set), worded apart from an explicit false. An unreadable config is
 * UNKNOWN, never the default, and so is an absent key when git could not say
 * what is tracked (the line carries the git error); a value that is not a
 * boolean reads INVALID, never as on or off.
 */
export function handoffFilesLine({ config, configUnreadable, root }) {
  if (configUnreadable) {
    return (
      'Handoff files: UNKNOWN — the project config could not be read, so config.handoff.enabled could not be determined. ' +
      'This is NOT the off default: repair the config.'
    );
  }
  let setting;
  try {
    setting = handoffSettingOf(config, root);
  } catch (err) {
    if (err instanceof HandoffGitError) {
      return (
        `Handoff files: UNKNOWN — config.handoff.enabled is not set and git could not say whether handoff files are committed (${err.reason}). ` +
        'This is NOT the off default: init, sync-agents, /sterling:update and the handoff projection refuse to act until git answers or the setting is set (TUI System tab).'
      );
    }
    if (!(err instanceof HandoffSettingError)) throw err;
    const block = config.handoff;
    const raw = block !== null && typeof block === 'object' && !Array.isArray(block) ? block.enabled : block;
    return (
      `Handoff files: INVALID (${JSON.stringify(raw).replace(/^"|"$/g, "'")}) — config.handoff.enabled must be true or false; ` +
      'init, sync-agents, /sterling:update and the handoff projection refuse to act on it until it is fixed (TUI System tab).'
    );
  }
  const where = {
    config: 'config.handoff.enabled',
    tracked: 'config.handoff.enabled is not set; handoff files are tracked in git',
    default: 'not set: config.handoff.enabled is absent and no handoff files are tracked in git',
  }[setting.source];
  return (
    `Handoff files: ${setting.enabled ? 'ON' : 'OFF'} (${where} — TUI System tab) — ` +
    (setting.enabled ? `${HANDOFF_SET} are written and maintained.` : `${HANDOFF_SET} are not written; existing ones are left in place.`)
  );
}

/**
 * PENDING ISSUE REPORTS (decision
 * projects-file-sterling-issues-as-scrubbed-github-issues-automatically): when
 * report-issue.mjs cannot reach GitHub (gh missing, not logged in, or a failed
 * call) it queues the report in .sterling/pending-issue-reports.jsonl. This line
 * states the count from that local file only; it makes no network call. Each
 * non-blank line is one queued report (report-issue.mjs validates the entries when
 * it flushes, so a malformed line still counts here as one report waiting). No file
 * or no report means no line. A file that exists but cannot be read is a loud
 * UNKNOWN line, never silence. `pluginRoot` is the resolved Sterling root, or null
 * when it could not be resolved; the flush command is then named plugin-relative.
 */
export const PENDING_ISSUE_REPORTS = 'pending-issue-reports.jsonl';

export function pendingIssueReportsLine({ cwd, pluginRoot }) {
  const path = join(cwd, '.sterling', PENDING_ISSUE_REPORTS);
  if (!existsSync(path)) return '';
  let count;
  try {
    count = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch (e) {
    return `Sterling issue reports: UNKNOWN — .sterling/${PENDING_ISSUE_REPORTS} could not be read (${(e && e.message) || e}), so the number of queued reports is not known.`;
  }
  if (count === 0) return '';
  const flush = pluginRoot ? `\`node "${join(pluginRoot, 'bin', 'report-issue.mjs')}" --flush\`` : "Sterling's bin/report-issue.mjs --flush";
  return (
    `Sterling issue reports: ${count} queued in .sterling/${PENDING_ISSUE_REPORTS}, not yet filed on GitHub. ` +
    `Send them with ${flush} once gh is installed and logged in; the next report sends them too.`
  );
}

/**
 * MOUNTED DOMAINS (decision projects-mount-domains-and-sibling-projects: each
 * domain's description is shown at session start, and a missing one fails loud):
 * one line per domain in config.stack_tags, in manifest order. A described domain
 * states its description; a store with no description, a configured domain with
 * no store (the shared missingDomainWarning text) and a store that cannot be read
 * are each a ⚠ line. No domain configured means no line. An unreadable config, or
 * malformed domain fields, is one UNKNOWN line, never silence. `opener(dbPath)`
 * opens a domain store (the OpenCode plugin passes its own); a store is opened
 * only when it already exists, never created. `root` is the project root, which
 * Postgres storage needs to reach its domains. Never throws.
 */
export function mountedDomainLines({ config, configUnreadable, opener, root }) {
  if (configUnreadable) {
    return ['⚠ Mounted domains: UNKNOWN — the project config could not be read, so config.stack_tags (the domain list) could not be determined.'];
  }
  let domains;
  try {
    domains = describeMountedDomains(config, opener ? { opener, root } : { root });
  } catch (e) {
    return [`⚠ Mounted domains: UNKNOWN — config.stack_tags or config.domain_paths is malformed (${(e && e.message) || e}).`];
  }
  return domains.map((d) => {
    if (d.state === 'described') return `Mounted domain '${d.name}': ${d.description}`;
    if (d.state === 'missing') return `⚠ ${missingDomainWarning(d)}`;
    if (d.state === 'undescribed') {
      return `⚠ Mounted domain '${d.name}' has NO description: its store at '${d.dbPath}' has no store_meta 'description', so nothing says which knowledge belongs in it. Give it one before writing knowledge to it.`;
    }
    return `⚠ Mounted domain '${d.name}': UNKNOWN — its store at '${d.dbPath}' could not be read (${d.error}), so its description is not known this session.`;
  });
}
