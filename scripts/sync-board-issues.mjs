#!/usr/bin/env node
// sync-board-issues: mirror a project's user board tasks one way to GitHub
// issues in the project's own repo (origin), so a dashboard that reads issues
// (Nemlig's Clear View) shows tasks moving from to-do to done. Decisions
// board-to-github-issues-one-way-mirror-first-shared-board-later,
// board-issue-mirror-design-required-outcome-snapshot-read-single-writer,
// board-issue-mirror-skips-trackers-labels-origin-and-label-lifecycle and
// board-remove-records-outcome-and-evidence-in-a-removal-journal.
//
// One way: GitHub is never read back into Sterling. Each issue carries the
// hidden key <!-- sterling-key: board:<board item uuid> -->, its title and body
// are written once and never edited, and labels (in-progress, blocked,
// from:<project>) are the only thing a rerun changes on an open issue. A task
// that left the board closes its issue: journal outcome done as completed,
// any other outcome and a task gone with no journal row as not_planned, each
// after one comment carrying the receipt <!-- sterling-close: board:<uuid> -->
// that a rerun looks for first, so an interrupted run never comments twice.
// It never reopens an issue.
//
// The planner (plan) is pure: board snapshot plus GitHub inventory in, actions
// out. The executor runs the actions through gh in order and stops at the
// first failure; a rerun plans from what GitHub then holds, so it resumes.
// A real run holds a kernel-held lock per project and repo (the cooperating
// lock of scripts/hooks/lib/session-events.mjs), so a second run at the same
// time exits 1 instead of writing beside it. --dry-run reads, plans and
// prints, takes no lock and writes nothing.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProjectIdentity } from '@sterling/schemas';
import { readBoardSnapshot, BoardSnapshotError } from '@sterling/store';
import { resolveGhPath } from './lib/gh-path.mjs';
import { parseOriginRepo } from './lib/work-pr.mjs';
import { resolveStoreRoot } from './lib/worktree-root.mjs';
import { SESSION_EVENTS_LOCK_HELD, withSessionEventsLock } from './hooks/lib/session-events.mjs';

/** Clear View's lifetime cap on genuine issues per repo (pull requests excluded): no new issue is created past it. */
export const ISSUE_CEILING = 200;
export const LABEL_IN_PROGRESS = 'in-progress';
export const LABEL_BLOCKED = 'blocked';
export const FROM_LABEL_PREFIX = 'from:';
/** GitHub refuses a label name longer than this. */
export const LABEL_NAME_MAX = 50;
export const TITLE_MAX = 120;
/** GitHub's issue body limit is 65536 characters; the text is cut below it to leave room for the markers. */
export const BODY_TEXT_MAX = 60_000;

const LABEL_STYLE = {
  [LABEL_IN_PROGRESS]: { color: 'fbca04', description: 'Sterling board: a session holds this task' },
  [LABEL_BLOCKED]: { color: 'b60205', description: 'Sterling board: blocked or waiting' },
};
const FROM_LABEL_STYLE = { color: 'c5def5', description: 'Sterling board: task handed over from another project' };

export const keyMarker = (id) => `<!-- sterling-key: board:${id} -->`;
export const projectMarker = (identity) => `<!-- sterling-project: ${identity} -->`;
export const closeReceipt = (id) => `<!-- sterling-close: board:${id} -->`;
export const textHash = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
export const textMarker = (text) => `<!-- sterling-text: sha256:${textHash(text)} -->`;
const KEY_RE = /<!-- sterling-key: board:([^\s>]+) -->/g;
const TEXT_RE = /<!-- sterling-text: sha256:([0-9a-f]{16}) -->/;
const PROJECT_RE = /<!-- sterling-project: (.+?) -->/g;

// A journal row carries the removed todo's hand-off role and sending project
// (handoff_role, handoff_from_name). Rows journaled before the store kept them
// (Sterling 0.19.130) have neither, and only for those the hand-off is read
// from the lines the MCP server writes into a hand-off's text
// (packages/mcp-server/src/tools.ts, board_add target_project). A newer row
// without a role is a plain task, and those server-written lines are not in
// its text, so the fallback finds nothing there.
const TRACKER_TEXT_RE = /^Handed to project '[^']+': /;
const RECEIVED_TEXT_RE = /\nHanded over from project '([^']+)' \(/g;

/** The plan cannot be made: the inventory is ambiguous or a label cannot exist. Nothing was written. */
export class PlanError extends Error {
  name = 'PlanError';
}

/** The issue title: the text's first non-blank line, trimmed and capped. */
export function titleOf(text, id) {
  const first = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return `Board task ${String(id).slice(0, 8)}`;
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
}

/** The issue body: the task text, then the key, project and text-hash markers. */
export function bodyOf(id, text, identity) {
  const t = String(text ?? '');
  const shown = t.length > BODY_TEXT_MAX ? `${t.slice(0, BODY_TEXT_MAX)}\n\n(The board text is longer; it was cut here.)` : t;
  return `${shown.trimEnd()}\n\n${keyMarker(id)}\n${projectMarker(identity)}\n${textMarker(t)}\n`;
}

/**
 * The project's marker identity and the identities it accepts as its own:
 * the work-project id from .sterling/project.json when present, else
 * config.project_name, else the folder name. The name is accepted too, so
 * issues written before a hobby project gained a project.json stay its own.
 * `identity` is { project_id } or null (readProjectIdentity), `name` the
 * configured or folder name.
 */
export function projectIdentityOf(identity, name) {
  const marker = identity?.project_id ?? name;
  for (const value of [marker, name]) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[<>\n\r]|-->/.test(value)) {
      throw new PlanError(`the project identity ${JSON.stringify(value)} cannot go into an issue marker (it must be non-blank, without surrounding spaces, '<', '>', line breaks or '-->'); set config.project_name. Nothing was written.`);
    }
  }
  return { marker, accepts: [...new Set([marker, name])] };
}

const labelNames = (issue) => (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter((n) => typeof n === 'string');
const hasLabel = (names, label) => names.some((n) => n.toLowerCase() === label.toLowerCase());
const isTrackerItem = (item) => item.record?.handoff?.role === 'sent' || item.readiness?.state === 'delegated';
const receivedFrom = (item) => (item.record?.handoff?.role === 'received' ? item.record.handoff.from_name : undefined);

/** A journal row's hand-off: its columns, or the text lines for a row written before them. */
function journalHandoff(entry) {
  if (entry.handoff_role !== undefined) return { tracker: entry.handoff_role === 'sent', from: entry.handoff_role === 'received' ? entry.handoff_from_name : undefined };
  return { tracker: TRACKER_TEXT_RE.test(entry.text), from: receivedFromText(entry.text) };
}

function receivedFromText(text) {
  let name;
  for (const m of String(text ?? '').matchAll(RECEIVED_TEXT_RE)) name = m[1];
  return name;
}

function fromLabel(project) {
  const name = `${FROM_LABEL_PREFIX}${project}`;
  if (name.length > LABEL_NAME_MAX) {
    throw new PlanError(`the label '${name}' is ${name.length} characters and GitHub allows ${LABEL_NAME_MAX}; shorten that project's name. Nothing was written.`);
  }
  return name;
}

/**
 * Genuine issues (pull requests excluded) that carry a sterling key, split by
 * project marker: `ours` (key -> issue) holds the issues whose one project
 * marker is one of `project.accepts`; `foreign` (key -> issues) holds every
 * other keyed issue (another project's marker, several, or none), which the
 * mirror never changes. `warnings` names the foreign ones, grouped by marker.
 * Among ours, two issues with one key, or one issue with two keys, refuse the plan.
 */
export function indexByKey(issues, project) {
  const accepts = new Set(project.accepts);
  const holders = new Map();
  const foreign = new Map();
  const foreignBy = new Map();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const body = String(issue.body ?? '');
    const keys = [...new Set([...body.matchAll(KEY_RE)].map((m) => m[1]))];
    if (keys.length === 0) continue;
    const projects = [...new Set([...body.matchAll(PROJECT_RE)].map((m) => m[1]))];
    if (projects.length !== 1 || !accepts.has(projects[0])) {
      for (const key of keys) foreign.set(key, [...(foreign.get(key) ?? []), issue]);
      const label = projects.length === 0 ? 'no project marker' : `project marker ${projects.map((v) => `'${v}'`).join(' and ')}`;
      foreignBy.set(label, [...(foreignBy.get(label) ?? []), issue.number]);
      continue;
    }
    if (keys.length > 1) {
      throw new PlanError(`issue #${issue.number} carries ${keys.length} sterling-key markers (${keys.join(', ')}); fix its body by hand so it carries one. Nothing was written.`);
    }
    holders.set(keys[0], [...(holders.get(keys[0]) ?? []), issue]);
  }
  const dupes = [...holders].filter(([, list]) => list.length > 1);
  if (dupes.length) {
    const lines = dupes.map(([key, list]) => `board:${key} on issues ${list.map((i) => `#${i.number} (${i.state})`).join(', ')}`);
    throw new PlanError(`more than one issue carries the same sterling-key marker, and the mirror will not pick one: ${lines.join('; ')}. Remove the marker from all but one of them by hand, then rerun. Nothing was written.`);
  }
  const warnings = [...foreignBy].map(
    ([label, numbers]) => `${numbers.length} issue(s) carry a sterling-key with ${label}, not this project's (${[...accepts].map((v) => `'${v}'`).join(' or ')}): ${numbers.map((n) => `#${n}`).join(', ')}. They belong to another project or were made by hand; the mirror leaves them alone.`
  );
  return { ours: new Map([...holders].map(([key, list]) => [key, list[0]])), foreign, warnings };
}

/** This project's open mirrored issues whose task left the board: the issues whose comments the executor reads for a close receipt before planning. */
export function closeCandidates(snapshot, issues, project) {
  const { ours } = indexByKey(issues, project);
  const present = new Set([...snapshot.items.map((i) => String(i.record.id)), ...snapshot.unreadable.map((u) => u.id)]);
  return [...ours].filter(([key, issue]) => issue.state === 'open' && !present.has(key)).map(([, issue]) => issue.number);
}

/** The closing comment for a task, by how it left the board (journal row, or none). */
export function closeComment(id, entry) {
  const lines = [];
  if (!entry) {
    lines.push('Closed as not planned: the task left the Sterling board without a recorded outcome.');
  } else if (entry.outcome === 'done') {
    lines.push('Done on the Sterling board.');
    const ev = entry.evidence ?? {};
    const evLines = ['commit', 'pr', 'deploy', 'url'].filter((k) => typeof ev[k] === 'string' && ev[k].trim()).map((k) => `- ${k}: ${ev[k].trim()}`);
    lines.push('', ...(evLines.length ? ['Evidence:', ...evLines] : ['No evidence was recorded.']));
  } else {
    lines.push(`Closed as not planned: the task was marked ${entry.outcome} on the Sterling board.`);
  }
  if (entry?.note) lines.push('', `Note: ${entry.note}`);
  lines.push('', closeReceipt(id));
  return lines.join('\n');
}

const stateReasonOf = (entry) => (entry?.outcome === 'done' ? 'completed' : 'not_planned');

/**
 * The actions that bring GitHub in line with the board, in run order: missing
 * labels first, then closes (comment, label removals, close), then label
 * changes on open issues, then creates. Pure: nothing is read or written.
 *
 * input: snapshot (readBoardSnapshot's shape), issues (every issue in the repo,
 * state all, as GitHub returns them; pull requests are dropped here), project
 * (projectIdentityOf: the marker new issues carry and the markers this project
 * owns; any other keyed issue is left alone), labels (the repo's label names),
 * receipts (numbers of the issues whose comments already carry their close
 * receipt), ceiling (default ISSUE_CEILING).
 * Returns { actions, warnings, drift, ceiling: { limit, count, skipped, skipped_items } },
 * where skipped_items lists { key, title } of each task that got no issue.
 */
export function plan({ snapshot, issues, project, labels = [], receipts = new Set(), ceiling = ISSUE_CEILING }) {
  const genuine = issues.filter((i) => !i.pull_request);
  const { ours: byKey, foreign, warnings: foreignWarnings } = indexByKey(genuine, project);
  const live = new Map(snapshot.items.map((item) => [String(item.record.id), item]));
  const unreadable = new Set(snapshot.unreadable.map((u) => u.id));
  const journal = new Map(snapshot.journal.filter((j) => j.source === 'user').map((j) => [j.item_id, j]));
  const closes = [];
  const labelActions = [];
  const creates = [];
  const warnings = [...foreignWarnings];
  const drift = [];
  const wanted = new Set();
  /** True when an issue outside this project's markers already carries the key: no second issue is made beside it. */
  const heldElsewhere = (key) => {
    const list = foreign.get(key);
    if (!list) return false;
    warnings.push(`board:${key} gets no issue, because ${list.map((i) => `#${i.number}`).join(', ')} already carries its key without this project's marker; fix that issue's markers by hand.`);
    return true;
  };

  for (const [key, issue] of byKey) {
    const item = live.get(key);
    if (item) {
      if (isTrackerItem(item)) {
        warnings.push(`#${issue.number} carries the key of board item ${key}, a hand-off tracker; trackers are not mirrored, so it is left as it is.`);
        continue;
      }
      if (issue.state !== 'open') {
        warnings.push(`#${issue.number} is closed on GitHub while board item ${key} is still open; the mirror never reopens an issue.`);
        continue;
      }
      const written = TEXT_RE.exec(String(issue.body ?? ''))?.[1];
      const text = String(item.record.text ?? '');
      if (written && written !== textHash(text)) drift.push({ number: issue.number, key, title: titleOf(text, key) });
      const names = labelNames(issue);
      const add = [];
      const claim = item.readiness?.claim?.state;
      if (claim === 'unreadable') {
        warnings.push(`board item ${key} (#${issue.number}) has a claim this Sterling cannot read; its in-progress label is left as it is.`);
      } else if (claim === 'held' && !hasLabel(names, LABEL_IN_PROGRESS)) add.push(LABEL_IN_PROGRESS);
      else if (claim !== 'held' && hasLabel(names, LABEL_IN_PROGRESS)) labelActions.push({ kind: 'remove_label', number: issue.number, label: LABEL_IN_PROGRESS });
      const blocked = item.readiness?.state === 'blocked' || item.readiness?.state === 'waiting';
      if (blocked && !hasLabel(names, LABEL_BLOCKED)) add.push(LABEL_BLOCKED);
      else if (!blocked && hasLabel(names, LABEL_BLOCKED)) labelActions.push({ kind: 'remove_label', number: issue.number, label: LABEL_BLOCKED });
      const from = receivedFrom(item);
      if (from !== undefined) {
        const label = fromLabel(from);
        if (!hasLabel(names, label)) add.push(label);
      }
      if (add.length) {
        add.forEach((l) => wanted.add(l));
        labelActions.push({ kind: 'add_labels', number: issue.number, labels: add });
      }
      continue;
    }
    if (unreadable.has(key)) {
      warnings.push(`#${issue.number}: board item ${key} is on the board but this Sterling cannot read it; its issue is left as it is.`);
      continue;
    }
    if (issue.state !== 'open') continue;
    const entry = journal.get(key);
    if (!receipts.has(issue.number)) closes.push({ kind: 'comment', number: issue.number, key, body: closeComment(key, entry) });
    const names = labelNames(issue);
    for (const label of [LABEL_IN_PROGRESS, LABEL_BLOCKED]) {
      const held = names.find((n) => n.toLowerCase() === label.toLowerCase());
      if (held) closes.push({ kind: 'remove_label', number: issue.number, label: held });
    }
    closes.push({ kind: 'close', number: issue.number, key, state_reason: stateReasonOf(entry), outcome: entry?.outcome ?? 'vanished' });
  }

  let room = ceiling - genuine.length;
  const skipped = [];
  const take = (key, text) => {
    if (room <= 0) {
      skipped.push({ key, title: titleOf(text, key) });
      return false;
    }
    room--;
    return true;
  };
  for (const item of snapshot.items) {
    const id = String(item.record.id);
    if (isTrackerItem(item) || byKey.has(id) || heldElsewhere(id)) continue;
    const text = String(item.record.text ?? '');
    if (!take(id, text)) continue;
    const labelsFor = [];
    if (item.readiness?.claim?.state === 'held') labelsFor.push(LABEL_IN_PROGRESS);
    if (item.readiness?.state === 'blocked' || item.readiness?.state === 'waiting') labelsFor.push(LABEL_BLOCKED);
    const from = receivedFrom(item);
    if (from !== undefined) labelsFor.push(fromLabel(from));
    labelsFor.forEach((l) => wanted.add(l));
    creates.push({ kind: 'create', key: id, title: titleOf(text, id), body: bodyOf(id, text, project.marker), labels: labelsFor });
  }
  for (const entry of snapshot.journal) {
    if (entry.source !== 'user' || byKey.has(entry.item_id) || live.has(entry.item_id)) continue;
    const handoff = journalHandoff(entry);
    if (handoff.tracker || heldElsewhere(entry.item_id)) continue;
    if (!take(entry.item_id, entry.text)) continue;
    const labelsFor = handoff.from !== undefined ? [fromLabel(handoff.from)] : [];
    labelsFor.forEach((l) => wanted.add(l));
    creates.push({
      kind: 'create',
      key: entry.item_id,
      title: titleOf(entry.text, entry.item_id),
      body: bodyOf(entry.item_id, entry.text, project.marker),
      labels: labelsFor,
      then: { comment: closeComment(entry.item_id, entry), state_reason: stateReasonOf(entry), outcome: entry.outcome },
    });
  }

  const ensure = [...wanted]
    .filter((name) => !labels.some((l) => l.toLowerCase() === name.toLowerCase()))
    .sort()
    .map((name) => ({ kind: 'ensure_label', name, ...(LABEL_STYLE[name] ?? FROM_LABEL_STYLE) }));
  return { actions: [...ensure, ...closes, ...labelActions, ...creates], warnings, drift, ceiling: { limit: ceiling, count: genuine.length, skipped: skipped.length, skipped_items: skipped } };
}

/** One action as a line for the run log. */
export function describe(action) {
  switch (action.kind) {
    case 'ensure_label':
      return `create label '${action.name}'`;
    case 'comment':
      return `comment on #${action.number} with the close receipt for board:${action.key}`;
    case 'remove_label':
      return `remove label '${action.label}' from #${action.number}`;
    case 'add_labels':
      return `add label${action.labels.length > 1 ? 's' : ''} ${action.labels.map((l) => `'${l}'`).join(', ')} to #${action.number}`;
    case 'close':
      return `close #${action.number} as ${action.state_reason} (${action.outcome})`;
    case 'create': {
      const labels = action.labels.length ? ` with ${action.labels.map((l) => `'${l}'`).join(', ')}` : '';
      const then = action.then ? `, then comment and close it as ${action.then.state_reason} (${action.then.outcome})` : '';
      return `create issue "${action.title}"${labels} for board:${action.key}${then}`;
    }
    default:
      throw new Error(`sync-board-issues: unknown action kind '${action.kind}'`);
  }
}

// ---------- gh ----------

/** A gh call failed; the message names the gh binary, the call and what GitHub said. */
export class GhError extends Error {
  name = 'GhError';
}

const oneLine = (r) => (r.stderr || r.stdout || String(r.error?.message ?? '') || `exit ${r.status}`).trim().replace(/\s*\n\s*/g, ' | ');

function httpStatus(r) {
  const m = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.match(/\(HTTP (\d{3})\)/);
  return m ? Number(m[1]) : null;
}

/** gh bound to one host; every call is `gh api --hostname <host> --method <m> <path>`, a JSON body on stdin. */
export function makeGh(host, ghPath = resolveGhPath()) {
  const run = (args, input) =>
    spawnSync(ghPath, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' }, ...(input !== undefined ? { input } : {}) });
  const gh = {
    path: ghPath,
    /** null when gh runs and is logged in to the host, else the reason. */
    preflight() {
      if (!ghPath) return 'gh was not found on PATH; install the GitHub CLI and log in with gh auth login';
      const version = run(['--version']);
      if (version.error || version.status !== 0) return `gh at ${ghPath} could not run (${oneLine(version)})`;
      const auth = run(['auth', 'status', '--hostname', host]);
      if (auth.error || auth.status !== 0) return `gh at ${ghPath} is not logged in to ${host} (${oneLine(auth)}); run: gh auth login --hostname ${host}`;
      return null;
    },
    api(method, apiPath, body) {
      const args = ['api', '--hostname', host, '--method', method, apiPath, ...(body !== undefined ? ['--input', '-'] : [])];
      const r = run(args, body !== undefined ? JSON.stringify(body) : undefined);
      if (r.error || r.status !== 0) {
        const status = r.error ? null : httpStatus(r);
        const said = oneLine(r);
        if (status === 429 || (status === 403 && /rate limit|abuse|secondary/i.test(said))) {
          throw new GhError(`gh at ${ghPath}: ${method} ${apiPath} was rate limited by ${host} (${said}). Nothing is retried; run again later. Work done before this call stays done, and a rerun picks up from it.`);
        }
        if (status === 401 || /bad credentials|authentication|not logged in/i.test(said)) {
          throw new GhError(`gh at ${ghPath}: ${method} ${apiPath} was refused as unauthenticated by ${host} (${said}); run gh auth login --hostname ${host}. On WSL with a Windows gh.exe, a GH_TOKEN set in WSL reaches it only through WSLENV.`);
        }
        throw new GhError(`gh at ${ghPath}: ${method} ${apiPath} failed (${said})`);
      }
      if (!r.stdout.trim()) return null;
      try {
        return JSON.parse(r.stdout);
      } catch (e) {
        throw new GhError(`gh at ${ghPath}: ${method} ${apiPath} returned unparseable JSON (${e.message})`);
      }
    },
    /** Every row of a list endpoint, 100 a page. */
    list(apiPath) {
      const all = [];
      for (let page = 1; ; page++) {
        const rows = gh.api('GET', `${apiPath}${apiPath.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        if (!Array.isArray(rows)) throw new GhError(`gh at ${ghPath}: GET ${apiPath} page ${page} did not return a list`);
        all.push(...rows);
        if (rows.length < 100) return all;
      }
    },
  };
  return gh;
}

/** Everything the planner needs from GitHub: every issue (state all), the label names and the close receipts. */
export function readInventory(gh, ownerRepo, snapshot, project) {
  const issues = gh.list(`repos/${ownerRepo}/issues?state=all`);
  const labels = gh.list(`repos/${ownerRepo}/labels`).map((l) => l.name);
  const receipts = new Set();
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  for (const number of closeCandidates(snapshot, issues, project)) {
    const key = [...String(byNumber.get(number).body ?? '').matchAll(KEY_RE)][0][1];
    const comments = gh.list(`repos/${ownerRepo}/issues/${number}/comments`);
    if (comments.some((c) => String(c.body ?? '').includes(closeReceipt(key)))) receipts.add(number);
  }
  return { issues, labels, receipts };
}

/** Run the actions in order through gh, logging each before it runs. Stops at the first failure (the GhError propagates). */
export function execute(actions, gh, ownerRepo, log) {
  for (const a of actions) {
    log(describe(a));
    switch (a.kind) {
      case 'ensure_label':
        try {
          gh.api('POST', `repos/${ownerRepo}/labels`, { name: a.name, color: a.color, description: a.description });
        } catch (e) {
          throw new GhError(`${e.message}. The label '${a.name}' is missing and could not be created; the account needs triage or write access to ${ownerRepo}, or a maintainer creates the label by hand.`);
        }
        break;
      case 'comment':
        gh.api('POST', `repos/${ownerRepo}/issues/${a.number}/comments`, { body: a.body });
        break;
      case 'remove_label':
        gh.api('DELETE', `repos/${ownerRepo}/issues/${a.number}/labels/${encodeURIComponent(a.label)}`);
        break;
      case 'add_labels':
        gh.api('POST', `repos/${ownerRepo}/issues/${a.number}/labels`, { labels: a.labels });
        break;
      case 'close':
        gh.api('PATCH', `repos/${ownerRepo}/issues/${a.number}`, { state: 'closed', state_reason: a.state_reason });
        break;
      case 'create': {
        const made = gh.api('POST', `repos/${ownerRepo}/issues`, { title: a.title, body: a.body, ...(a.labels.length ? { labels: a.labels } : {}) });
        const number = made?.number;
        if (!Number.isInteger(number)) throw new GhError(`gh at ${gh.path}: creating the issue for board:${a.key} returned no issue number`);
        log(`  created #${number}`);
        if (a.then) {
          gh.api('POST', `repos/${ownerRepo}/issues/${number}/comments`, { body: a.then.comment });
          gh.api('PATCH', `repos/${ownerRepo}/issues/${number}`, { state: 'closed', state_reason: a.then.state_reason });
        }
        break;
      }
      default:
        throw new Error(`sync-board-issues: unknown action kind '${a.kind}'`);
    }
  }
}

// ---------- lock ----------

/** The lock file for one project and repo, under a private per-user directory in the OS temp dir. */
export function lockPathFor(storeRoot, repo) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const dir = join(tmpdir(), `sterling-locks-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw new Error(`sync-board-issues: ${dir} is not a private directory of this user; refusing to take the run lock through it`);
  }
  const hash = createHash('sha256').update(`${realpathSync(storeRoot)}\n${repo}`).digest('hex').slice(0, 32);
  return join(dir, `sync-board-issues-${hash}`);
}

/** config.project_name of the project at storeRoot, else its folder name. A config that cannot be read or parsed throws. */
export function projectNameAt(storeRoot) {
  const path = join(storeRoot, '.sterling', 'config.json');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return basename(storeRoot);
    throw new Error(`${path} could not be read (${e.message})`);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${e.message})`);
  }
  const name = config?.project_name;
  return typeof name === 'string' && name.trim() ? name.trim() : basename(storeRoot);
}

// ---------- CLI ----------

export const USAGE = `usage: sync-board-issues [--dry-run] [--project <dir>]

Mirrors the project's user board tasks one way to GitHub issues in the repo of
its 'origin' remote. --dry-run prints what it would do and writes nothing.
--project names the project directory (default: the current directory); a
linked git worktree reads its main checkout's board.
Exit codes: 0 done, 1 refused or failed, 2 usage error, 3 done but new issues
were not created because the repo reached ${ISSUE_CEILING} issues.`;

export function parseArgs(argv) {
  const out = { dryRun: false, project: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--project') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: '--project needs a directory' };
      out.project = v;
    } else if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else return { error: `unknown argument '${a}'` };
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`sync-board-issues: ${args.error}\n${USAGE}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const refuse = (msg) => {
    process.stderr.write(`sync-board-issues: ${msg}\n`);
    process.exit(1);
  };
  const dir = resolve(args.project ?? process.cwd());
  if (!existsSync(dir)) refuse(`${dir} does not exist.`);
  const storeRoot = resolveStoreRoot(dir);
  let project;
  try {
    project = projectIdentityOf(readProjectIdentity(storeRoot), projectNameAt(storeRoot));
  } catch (e) {
    refuse(`the project's identity for the issue marker could not be read: ${e.message}`);
  }
  const url = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  if (url.error || url.status !== 0) refuse(`${dir} has no 'origin' remote (git remote get-url origin: ${oneLine(url)}); the mirror writes to origin's GitHub repo and will not guess one. Nothing was written.`);
  const origin = parseOriginRepo(url.stdout);
  if (!origin) refuse(`origin's URL '${url.stdout.trim()}' is not a GitHub repository URL, so the repo cannot be identified. Nothing was written.`);
  const ownerRepo = origin.repo.slice(origin.host.length + 1);
  const gh = makeGh(origin.host);
  const pre = gh.preflight();
  if (pre) refuse(`${pre}. Nothing was written.`);

  const run = () => {
    let snapshot;
    try {
      snapshot = readBoardSnapshot(storeRoot);
    } catch (e) {
      if (e instanceof BoardSnapshotError) refuse(`${e.message}`);
      throw e;
    }
    for (const u of snapshot.unreadable) process.stderr.write(`sync-board-issues: WARNING board item ${u.id} cannot be read (${u.reason}); it is not mirrored and its issue, if any, is left as it is.\n`);
    const inventory = readInventory(gh, ownerRepo, snapshot, project);
    const result = plan({ snapshot, project, ...inventory });
    for (const w of result.warnings) process.stderr.write(`sync-board-issues: WARNING ${w}\n`);
    for (const d of result.drift) process.stdout.write(`text drift: #${d.number} ("${d.title}") — the board text changed after the issue was written; the mirror never edits an issue.\n`);
    const log = (line) => process.stdout.write(`${args.dryRun ? 'would ' : ''}${line}\n`);
    if (args.dryRun) result.actions.forEach((a) => log(describe(a)));
    else execute(result.actions, gh, ownerRepo, log);
    const counts = {};
    for (const a of result.actions) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
    const summary = Object.keys(counts).length ? Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') : 'nothing to do';
    process.stdout.write(`sync-board-issues: ${origin.repo}: ${summary}${args.dryRun ? ' (dry run: nothing was written)' : ''}; ${result.ceiling.count} issue(s) in the repo before this run.\n`);
    if (result.ceiling.skipped > 0) {
      for (const s of result.ceiling.skipped_items) process.stdout.write(`${args.dryRun ? 'would skip' : 'skipped'} (ceiling): "${s.title}" for board:${s.key}\n`);
      process.stderr.write(
        `sync-board-issues: CEILING ${origin.repo} holds ${result.ceiling.count} issues (pull requests excluded) and the limit is ${result.ceiling.limit} (Clear View's cap): ${result.ceiling.skipped} board task(s) got NO issue. Closing and labelling ${args.dryRun ? 'are still planned' : 'still ran'}.\n`
      );
      return 3;
    }
    return 0;
  };

  let code;
  try {
    if (args.dryRun) code = run();
    else {
      const lockPath = lockPathFor(storeRoot, origin.repo);
      try {
        code = withSessionEventsLock(lockPath, run, { timeoutMs: 0 });
      } catch (e) {
        if (e?.code !== SESSION_EVENTS_LOCK_HELD) throw e;
        refuse(`another sync-board-issues run holds the lock for ${storeRoot} and ${origin.repo} (${lockPath}.lock.db). Nothing was written; run again after it finishes.`);
      }
    }
  } catch (e) {
    if (e instanceof GhError || e instanceof PlanError) refuse(e.message);
    throw e;
  }
  process.exit(code);
}

// Run as the source or as bin/sync-board-issues.mjs. Bundled into bin/, this
// module's import.meta.url is rewritten to name this scripts/ source
// (source-location identity, scripts/lib/bundled-artifacts.mjs), so the bin
// path is named too.
const launchedAs = process.argv[1] && resolve(process.argv[1]);
if (launchedAs === fileURLToPath(import.meta.url) || launchedAs === fileURLToPath(new URL('../bin/sync-board-issues.mjs', import.meta.url))) main();
