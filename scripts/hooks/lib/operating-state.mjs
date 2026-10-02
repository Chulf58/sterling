// The host-neutral operating-state lines H1 states at SessionStart: the project
// config read with its three states, MACHINE ROLE, TDD posture, Project mode and
// the pending Sterling issue-report count.
// Extracted from h1-session-start.mjs so the OpenCode context hook
// (packages/opencode-plugin/src/context.mjs) renders the SAME text from the SAME
// code (board cbee2b3d, audit f2ba68c2 row 2). Each line function returns the
// bare line, or '' when the line is not stated; the caller adds its own
// separator. Builtins and ./common.mjs only: hooks bundle this module.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './common.mjs';

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
 * PROJECT MODE (decision project-mode-hobby-work-toggle-decides-flow, slice S1):
 * informational only. Same three states as the TDD line: an absent key IS the
 * schema default (hobby); an unreadable config is UNKNOWN, never the default; a
 * value outside hobby/work reads INVALID, never as either flow.
 */
export function projectModeLine({ config, configUnreadable }) {
  if (configUnreadable) {
    return (
      'Project mode: UNKNOWN — the project config could not be read, so config.mode could not be determined. ' +
      'This is NOT the hobby default: repair the config.'
    );
  }
  const mode = config?.mode;
  if (mode === undefined || mode === 'hobby' || mode === 'work') {
    return (
      `Project mode: ${mode === 'work' ? 'WORK' : 'HOBBY'} (config.mode — TUI System tab) — ` +
      (mode === 'work'
        ? 'the OpenCode agents and handoff files are written and maintained.'
        : 'the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.')
    );
  }
  return (
    `Project mode: INVALID (${JSON.stringify(mode).replace(/^"|"$/g, "'")}) — config.mode must be 'hobby' or 'work'; ` +
    'init, sync-agents and /sterling:update refuse to act on it until it is fixed (TUI System tab).'
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
