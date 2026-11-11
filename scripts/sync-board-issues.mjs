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
// A real run holds a kernel-held lock per repo (the cooperating
// lock of scripts/hooks/lib/session-events.mjs), so a second run at the same
// time exits 1 instead of writing beside it. --dry-run reads, plans and
// prints, takes no lock and writes nothing.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProjectIdentity } from '@sterling/schemas';
import { readBoardSnapshot, BoardSnapshotError } from '@sterling/store';
import { resolveGhPath } from './lib/gh-path.mjs';
import { parseOriginRepo } from './lib/work-pr.mjs';
import { resolveStoreRoot } from './lib/worktree-root.mjs';
import { SESSION_EVENTS_LOCK_HELD, withSessionEventsLock } from './hooks/lib/session-events.mjs';

/** Default cap on genuine issues per repo (pull requests excluded): no new issue is created past it. config.issue_mirror.ceiling overrides it. */
export const ISSUE_CEILING = 200;
/** A config.issue_mirror value (ceiling or exclude_prefixes) its judge refuses. The CLI exits 2 on it before anything is written. */
export class CeilingSettingError extends Error {
  name = 'CeilingSettingError';
}

/**
 * The per-project ceiling, config.issue_mirror.ceiling. `cfg` is the parsed
 * .sterling/config.json object (undefined when there is no file). Returns
 * { limit, source }: limit is a positive safe integer or null for unlimited;
 * source is 'default' (the key is absent, ISSUE_CEILING) or 'config'. 0 and
 * null both mean unlimited. Anything else that is present (a string, a
 * boolean, a negative or fractional number, an unsafe integer, an issue_mirror
 * that is not an object) throws: it is never coerced and never replaced by the
 * default. config.ts keeps the key permissive and without a default so this
 * judge can tell absent from set.
 */
export function ceilingOf(cfg) {
  const block = mirrorBlockOf(cfg);
  if (block === undefined || !Object.hasOwn(block, 'ceiling')) return { limit: ISSUE_CEILING, source: 'default' };
  const v = block.ceiling;
  if (v === null || v === 0) return { limit: null, source: 'config' };
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new CeilingSettingError(`config issue_mirror.ceiling must be a positive integer, or 0 or null for unlimited, got ${JSON.stringify(v)}`);
  }
  return { limit: v, source: 'config' };
}

/** config.issue_mirror as an object, undefined when absent; anything else that is present throws. */
function mirrorBlockOf(cfg) {
  if (cfg === undefined) return undefined;
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) throw new CeilingSettingError(`config root must be an object, got ${JSON.stringify(cfg)}`);
  const block = cfg.issue_mirror;
  if (block === undefined) return undefined;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) throw new CeilingSettingError(`config issue_mirror must be an object, got ${JSON.stringify(block)}`);
  return block;
}

/**
 * config.issue_mirror.exclude_prefixes: an array of non-empty strings, default
 * []. A task whose text, after leading whitespace, starts with one of them is
 * not mirrored (see plan). The prefixes are used exactly as written, never
 * trimmed or case-folded. A non-array, a non-string or an empty string throws:
 * an empty prefix would exclude every task.
 */
export function excludePrefixesOf(cfg) {
  const block = mirrorBlockOf(cfg);
  if (block === undefined || !Object.hasOwn(block, 'exclude_prefixes')) return [];
  const v = block.exclude_prefixes;
  if (!Array.isArray(v)) throw new CeilingSettingError(`config issue_mirror.exclude_prefixes must be an array of non-empty strings, got ${JSON.stringify(v)}`);
  for (const p of v) {
    if (typeof p !== 'string' || p === '') throw new CeilingSettingError(`config issue_mirror.exclude_prefixes must hold only non-empty strings, got ${JSON.stringify(p)}`);
  }
  return [...v];
}

/** Every issue_mirror setting of one parsed config: { ceiling: { limit, source }, excludePrefixes }. */
export function mirrorSettingsOf(cfg) {
  return { ceiling: ceilingOf(cfg), excludePrefixes: excludePrefixesOf(cfg) };
}

/** The issue_mirror settings of the project at storeRoot: its .sterling/config.json, or the defaults when there is no file. */
export function mirrorSettingsAt(storeRoot) {
  const path = join(storeRoot, '.sterling', 'config.json');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return mirrorSettingsOf(undefined);
    throw new Error(`${path} could not be read (${e.message})`);
  }
  try {
    return mirrorSettingsOf(JSON.parse(text));
  } catch (e) {
    if (e instanceof CeilingSettingError) throw e;
    throw new Error(`${path} is not valid JSON (${e.message})`);
  }
}

/** True when the task text, after leading whitespace, starts with one of the prefixes (case-sensitive, as written). */
export const isExcluded = (text, prefixes) => {
  const t = String(text ?? '').trimStart();
  return prefixes.some((p) => t.startsWith(p));
};
export const LABEL_IN_PROGRESS = 'in-progress';
export const LABEL_BLOCKED = 'blocked';
export const FROM_LABEL_PREFIX = 'from:';
export const OBJECTIVE_LABEL_PREFIX = 'objective:';
/** GitHub refuses a label name longer than this. */
export const LABEL_NAME_MAX = 50;
export const TITLE_MAX = 120;
/** GitHub's issue body limit is 65536 characters; the text is cut below it to leave room for the markers. */
export const BODY_TEXT_MAX = 60_000;

const LABEL_STYLE = {
  [LABEL_IN_PROGRESS]: { color: 'fbca04', description: 'Sterling board: a session holds this task' },
  [LABEL_BLOCKED]: { color: 'b60205', description: 'Sterling board: blocked or waiting' },
};
const OBJECTIVE_LABEL_STYLE = { color: 'bfd4f2', description: 'Sterling board: the objective this task belongs to' };
const FROM_LABEL_STYLE = { color: 'c5def5', description: 'Sterling board: task handed over from another project' };

export const keyMarker = (id) => `<!-- sterling-key: board:${id} -->`;
export const projectMarker = (identity) => `<!-- sterling-project: ${identity} -->`;
export const closeReceipt = (id) => `<!-- sterling-close: board:${id} -->`;
export const textHash = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
export const textMarker = (text) => `<!-- sterling-text: sha256:${textHash(text)} -->`;
const KEY_RE = /<!-- sterling-key: board:([^\s>]+) -->/;
// The generated footer: the key, project and text-hash markers on three
// consecutive lines, as bodyOf writes them. Metadata is read only from the last
// such footer in a body, never from a marker standing anywhere else, and the
// copied task text has its marker sequences broken (escapeMarkers), so text
// that quotes a marker can neither claim, disown nor duplicate an issue.
export const FOOTER_RE = /<!-- sterling-key: board:([^\s>]+) -->\r?\n<!-- sterling-project: ([^\r\n]+?) -->\r?\n<!-- sterling-text: sha256:([0-9a-f]{16}) -->/g;

/** The last generated footer in a body as { key, project, hash }, or null. */
export function footerOf(body) {
  let last = null;
  for (const m of String(body ?? '').matchAll(FOOTER_RE)) last = { key: m[1], project: m[2], hash: m[3] };
  return last;
}

/**
 * Task text with every `<!--` + `sterling-` sequence broken by a zero-width
 * space after 'sterling', so no copied text forms a marker. Inside an HTML
 * comment the change is hidden; in visible text the zero-width space does not show.
 */
export const escapeMarkers = (text) => String(text ?? '').replace(/(<!--\s*sterling)-/gi, '$1\u200B-');

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

/** The issue body: the task text (marker sequences broken), then the generated footer of key, project and text-hash markers. */
export function bodyOf(id, text, identity) {
  const t = String(text ?? '');
  const cut = t.length > BODY_TEXT_MAX ? `${t.slice(0, BODY_TEXT_MAX)}\n\n(The board text is longer; it was cut here.)` : t;
  const shown = escapeMarkers(cut);
  return `${shown.trimEnd()}\n\n${keyMarker(id)}\n${projectMarker(identity)}\n${textMarker(t)}\n`;
}

/**
 * The project's one marker identity: the work-project id from
 * .sterling/project.json when present, else config.project_name, else the
 * folder name. Only that value is accepted as this project's, so another
 * project with the same name never adopts its issues. `identity` is
 * { project_id } or null (readProjectIdentity), `name` the configured or folder name.
 */
export function projectIdentityOf(identity, name) {
  const marker = identity?.project_id ?? name;
  if (typeof marker !== 'string' || !marker.trim() || marker !== marker.trim() || /[<>\n\r]|-->/.test(marker)) {
    throw new PlanError(`the project identity ${JSON.stringify(marker)} cannot go into an issue marker (it must be non-blank, without surrounding spaces, '<', '>', line breaks or '-->'); set config.project_name. Nothing was written.`);
  }
  return { marker };
}

const labelNames = (issue) => (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter((n) => typeof n === 'string');
const hasLabel = (names, label) => names.some((n) => n.toLowerCase() === label.toLowerCase());
const isTrackerItem = (item) => item.record?.handoff?.role === 'sent' || item.readiness?.state === 'delegated';
const receivedFrom = (item) => (item.record?.handoff?.role === 'received' ? item.record.handoff.from_name : undefined);

/** A journal row's hand-off: its columns ('none' for a plain task), or, only for a row journaled before the columns existed (role absent), the text lines. */
function journalHandoff(entry) {
  if (entry.handoff_role !== undefined) return { tracker: entry.handoff_role === 'sent', from: entry.handoff_role === 'received' ? entry.handoff_from_name : undefined };
  return { tracker: TRACKER_TEXT_RE.test(entry.text), from: receivedFromText(entry.text) };
}

function receivedFromText(text) {
  let name;
  for (const m of String(text ?? '').matchAll(RECEIVED_TEXT_RE)) name = m[1];
  return name;
}

/**
 * The label for a board objective, or null when the task has none:
 * `objective:<objective>`. GitHub allows 50 characters, counted in code points;
 * a longer name is the
 * first 33 characters (code points) of the objective, then '~', then the first
 * 6 hex digits of the SHA-256 of the whole objective (UTF-8), 50 in all.
 */
export function objectiveLabel(objective) {
  if (typeof objective !== 'string' || !objective.trim()) return null;
  const name = `${OBJECTIVE_LABEL_PREFIX}${objective}`;
  if (Array.from(name).length <= LABEL_NAME_MAX) return name;
  const hash = createHash('sha256').update(objective, 'utf8').digest('hex').slice(0, 6);
  return `${OBJECTIVE_LABEL_PREFIX}${Array.from(objective).slice(0, 33).join('')}~${hash}`;
}

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const priorityRank = (p) => PRIORITY_RANK[p] ?? PRIORITY_RANK.normal;

function fromLabel(project) {
  const name = `${FROM_LABEL_PREFIX}${project}`;
  if (name.length > LABEL_NAME_MAX) {
    throw new PlanError(`the label '${name}' is ${name.length} characters and GitHub allows ${LABEL_NAME_MAX}; shorten that project's name. Nothing was written.`);
  }
  return name;
}

/**
 * Genuine issues (pull requests excluded) with a generated footer, split by its
 * project marker: `ours` (key -> issue) holds the issues whose footer names this
 * project; `foreign` (key -> issues) holds those whose footer names another,
 * which the mirror never changes and never creates a second issue beside. An
 * issue that shows a sterling-key outside any footer is only warned about.
 * `warnings` names both kinds, grouped. Two of our issues with one key refuse the plan.
 */
export function indexByKey(issues, project) {
  const holders = new Map();
  const foreign = new Map();
  const foreignBy = new Map();
  const bare = [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const footer = footerOf(issue.body);
    if (!footer) {
      if (KEY_RE.test(String(issue.body ?? ''))) bare.push(issue.number);
      continue;
    }
    if (footer.project !== project.marker) {
      foreign.set(footer.key, [...(foreign.get(footer.key) ?? []), issue]);
      foreignBy.set(footer.project, [...(foreignBy.get(footer.project) ?? []), issue.number]);
      continue;
    }
    holders.set(footer.key, [...(holders.get(footer.key) ?? []), issue]);
  }
  const dupes = [...holders].filter(([, list]) => list.length > 1);
  if (dupes.length) {
    const lines = dupes.map(([key, list]) => `board:${key} on issues ${list.map((i) => `#${i.number} (${i.state})`).join(', ')}`);
    throw new PlanError(`more than one issue carries the same sterling-key marker, and the mirror will not pick one: ${lines.join('; ')}. Remove the marker from all but one of them by hand, then rerun. Nothing was written.`);
  }
  const list = (numbers) => numbers.map((n) => `#${n}`).join(', ');
  const warnings = [...foreignBy].map(
    ([other, numbers]) => `${numbers.length} issue(s) carry project marker '${other}', not this project's ('${project.marker}'): ${list(numbers)}. They belong to another project; the mirror leaves them alone.`
  );
  if (bare.length) warnings.push(`${bare.length} issue(s) show a sterling-key marker outside a generated footer: ${list(bare)}. The mirror did not write them that way and leaves them alone.`);
  return { ours: new Map([...holders].map(([key, l]) => [key, l[0]])), foreign, warnings };
}

/** This project's open mirrored issues whose task left the board or is excluded by prefix: the issues whose comments the executor reads for a close receipt before planning. */
export function closeCandidates(snapshot, issues, project, excludePrefixes = []) {
  const { ours } = indexByKey(issues, project);
  const present = new Set([...snapshot.items.filter((i) => !isExcluded(i.record.text, excludePrefixes) || isTrackerItem(i)).map((i) => String(i.record.id)), ...snapshot.unreadable.map((u) => u.id)]);
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

/** The closing comment for an open issue whose task is now excluded by config issue_mirror.exclude_prefixes. */
export const excludedComment = (id) => ['Closed as not planned: the task is excluded from the mirror by config issue_mirror.exclude_prefixes.', '', closeReceipt(id)].join('\n');

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
 * receipt), ceiling (default ISSUE_CEILING; null is unlimited), excludePrefixes
 * (default []: a live or journal-only task whose text, after leading whitespace,
 * starts with one is never a create candidate, and an open issue of an excluded
 * live task is closed as not planned with outcome 'excluded'. Trackers keep
 * their precedence. Issues of excluded tasks still count toward the ceiling,
 * and a task that was never created costs nothing).
 * Returns { actions, warnings, drift, ceiling: { limit, count, skipped, skipped_items } },
 * where skipped_items lists { key, title } of each task that got no issue.
 */
export function plan({ snapshot, issues, project, labels = [], receipts = new Set(), ceiling = ISSUE_CEILING, excludePrefixes = [] }) {
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
  // Labels the run needs, by lowercase name (GitHub compares names without case):
  // the first spelling seen is the canonical one every action then uses.
  const wanted = new Map();
  const want = (name) => {
    const k = name.toLowerCase();
    if (!wanted.has(k)) wanted.set(k, name);
    return wanted.get(k);
  };
  /** True when an issue outside this project's markers already carries the key: no second issue is made beside it. */
  const heldElsewhere = (key) => {
    const list = foreign.get(key);
    if (!list) return false;
    warnings.push(`board:${key} gets no issue, because ${list.map((i) => `#${i.number}`).join(', ')} already carries its key without this project's marker; fix that issue's markers by hand.`);
    return true;
  };

  /** An open issue of an excluded task, live or removed: the one exclusion comment (unless its receipt is there), labels off, close as not planned. */
  const closeExcluded = (issue, key) => {
    if (!receipts.has(issue.number)) closes.push({ kind: 'comment', number: issue.number, key, body: excludedComment(key) });
    for (const label of [LABEL_IN_PROGRESS, LABEL_BLOCKED]) {
      const held = labelNames(issue).find((n) => n.toLowerCase() === label.toLowerCase());
      if (held) closes.push({ kind: 'remove_label', number: issue.number, label: held });
    }
    closes.push({ kind: 'close', number: issue.number, key, state_reason: 'not_planned', outcome: 'excluded' });
  };

  for (const [key, issue] of byKey) {
    const item = live.get(key);
    if (item) {
      if (isTrackerItem(item)) {
        warnings.push(`#${issue.number} carries the key of board item ${key}, a hand-off tracker; trackers are not mirrored, so it is left as it is.`);
        continue;
      }
      if (isExcluded(item.record.text, excludePrefixes)) {
        if (issue.state === 'open') closeExcluded(issue, key);
        continue;
      }
      if (issue.state !== 'open') {
        warnings.push(`#${issue.number} is closed on GitHub while board item ${key} is still open; the mirror never reopens an issue.`);
        continue;
      }
      const written = footerOf(issue.body)?.hash;
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
      const objective = objectiveLabel(item.record.objective);
      if (objective !== null && !hasLabel(names, objective)) add.push(objective);
      for (const held of names) {
        if (held.toLowerCase().startsWith(OBJECTIVE_LABEL_PREFIX) && held.toLowerCase() !== objective?.toLowerCase()) {
          labelActions.push({ kind: 'remove_label', number: issue.number, label: held });
        }
      }
      if (add.length) {
        labelActions.push({ kind: 'add_labels', number: issue.number, labels: add.map(want) });
      }
      continue;
    }
    if (unreadable.has(key)) {
      warnings.push(`#${issue.number}: board item ${key} is on the board but this Sterling cannot read it; its issue is left as it is.`);
      continue;
    }
    if (issue.state !== 'open') continue;
    const entry = journal.get(key);
    if (entry && journalHandoff(entry).tracker) {
      warnings.push(`#${issue.number} carries the key of removed board item ${key}, a hand-off tracker; trackers are not mirrored, so it is left as it is.`);
      continue;
    }
    if (entry && isExcluded(entry.text, excludePrefixes)) {
      closeExcluded(issue, key);
      continue;
    }
    if (!receipts.has(issue.number)) closes.push({ kind: 'comment', number: issue.number, key, body: closeComment(key, entry) });
    const names = labelNames(issue);
    for (const label of [LABEL_IN_PROGRESS, LABEL_BLOCKED]) {
      const held = names.find((n) => n.toLowerCase() === label.toLowerCase());
      if (held) closes.push({ kind: 'remove_label', number: issue.number, label: held });
    }
    closes.push({ kind: 'close', number: issue.number, key, state_reason: stateReasonOf(entry), outcome: entry?.outcome ?? 'vanished' });
  }

  let room = ceiling === null ? Infinity : ceiling - genuine.length;
  const skipped = [];
  const take = (key, text) => {
    if (room <= 0) {
      skipped.push({ key, title: titleOf(text, key) });
      return false;
    }
    room--;
    return true;
  };
  // Candidates for a new issue, live tasks then journal-only ones, ordered for
  // the ceiling: priority (high, normal, low; none counts as normal), then
  // oldest first. A live task's age is its created_at; a journal row keeps no
  // creation time, so its removed_at stands in for it. A missing time sorts
  // last. The sort is stable, so ties keep board order, then journal order.
  const candidates = [];
  for (const item of snapshot.items) {
    const id = String(item.record.id);
    if (isTrackerItem(item) || byKey.has(id) || isExcluded(item.record.text, excludePrefixes) || heldElsewhere(id)) continue;
    const text = String(item.record.text ?? '');
    // Labels are built, and so validated, only for an admitted create: a task the ceiling leaves out never blocks the plan.
    const labelsOf = () => {
      const labelsFor = [];
      if (item.readiness?.claim?.state === 'held') labelsFor.push(LABEL_IN_PROGRESS);
      if (item.readiness?.state === 'blocked' || item.readiness?.state === 'waiting') labelsFor.push(LABEL_BLOCKED);
      const from = receivedFrom(item);
      if (from !== undefined) labelsFor.push(fromLabel(from));
      const objective = objectiveLabel(item.record.objective);
      if (objective !== null) labelsFor.push(objective);
      return labelsFor;
    };
    candidates.push({ key: id, text, priority: item.record.priority, at: item.record.created_at, labelsOf, action: { kind: 'create', key: id, title: titleOf(text, id), body: bodyOf(id, text, project.marker) } });
  }
  for (const entry of snapshot.journal) {
    if (entry.source !== 'user' || byKey.has(entry.item_id) || live.has(entry.item_id)) continue;
    const handoff = journalHandoff(entry);
    if (handoff.tracker || isExcluded(entry.text, excludePrefixes) || heldElsewhere(entry.item_id)) continue;
    const labelsOf = () => {
      const labelsFor = handoff.from !== undefined ? [fromLabel(handoff.from)] : [];
      const objective = objectiveLabel(entry.objective);
      if (objective !== null) labelsFor.push(objective);
      return labelsFor;
    };
    candidates.push({
      key: entry.item_id,
      text: entry.text,
      priority: entry.priority,
      at: entry.removed_at,
      labelsOf,
      action: {
        kind: 'create',
        key: entry.item_id,
        title: titleOf(entry.text, entry.item_id),
        body: bodyOf(entry.item_id, entry.text, project.marker),
        then: { comment: closeComment(entry.item_id, entry), state_reason: stateReasonOf(entry), outcome: entry.outcome },
      },
    });
  }
  const atOf = (c) => (typeof c.at === 'string' && c.at ? Date.parse(c.at) : Infinity);
  candidates.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || (atOf(a) === atOf(b) ? 0 : atOf(a) < atOf(b) ? -1 : 1));
  for (const c of candidates) {
    if (!take(c.key, c.text)) continue;
    creates.push({ ...c.action, labels: c.labelsOf().map(want) });
  }

  const ensure = [...wanted.values()]
    .filter((name) => !labels.some((l) => l.toLowerCase() === name.toLowerCase()))
    .sort()
    .map((name) => ({ kind: 'ensure_label', name, ...(LABEL_STYLE[name] ?? (name.startsWith(OBJECTIVE_LABEL_PREFIX) ? OBJECTIVE_LABEL_STYLE : FROM_LABEL_STYLE)) }));
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
  /** `details.kind` is 'rate_limit', 'auth' or 'http'; `details.status` is the HTTP status when gh printed one. */
  constructor(message, details = {}) {
    super(message);
    Object.assign(this, details);
  }
}

const DETAIL_LIMIT = 600;
const ERRORS_SHOWN = 5;

const scrub = (s) => s.replace(/\b(?:gh[pousr]_|github_pat_)\w+/g, '[redacted]').replace(/\b(Bearer|token)\s+\S+/gi, '$1 [redacted]');
const flat = (s) => s.trim().replace(/\s*\n\s*/g, ' | ');

/** Both output streams of a failed gh call, with GitHub's JSON error body when stdout is one (an object with a string message). */
function streams(r) {
  const stderr = (r.stderr ?? '').trim();
  const stdout = (r.stdout ?? '').trim();
  let body = null;
  try {
    body = stdout ? JSON.parse(stdout) : null;
  } catch {
    body = null;
  }
  return { stderr, stdout, body: body && typeof body === 'object' && typeof body.message === 'string' ? body : null };
}

/** The complete raw text a failure is classified from: stderr, GitHub's message (or the raw stdout) and the spawn error. Never truncated. */
function failureCause(r) {
  const { stderr, stdout, body } = streams(r);
  return [stderr, body ? body.message : stdout, r.error?.message ?? ''].join('\n');
}

/** One validation entry in GitHub's words: "Label name invalid (name is too long)". */
function errorEntry(e) {
  if (typeof e === 'string') return e;
  const where = [e?.resource, e?.field, e?.code].filter((x) => typeof x === 'string').join(' ');
  return typeof e?.message === 'string' ? `${where} (${e.message})`.trim() : where;
}

/** Split `room` characters across fields: a short field keeps all of its text, the long ones share what is left evenly. */
function fairShares(lengths, room) {
  const shares = [];
  let left = Math.max(0, room);
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b]);
  order.forEach((i, k) => {
    shares[i] = Math.min(lengths[i], Math.floor(left / (order.length - k)));
    left -= shares[i];
  });
  return shares;
}

/** `s` cut to `n` characters by removing its middle, so both its start and its last line survive; the cut is marked. */
function clip(s, n) {
  if (s.length <= n) return s;
  const note = ` [... cut from ${s.length} chars ...] `;
  const keep = n - note.length;
  if (keep <= 0) return s.slice(0, n);
  const head = Math.ceil(keep / 2);
  return `${s.slice(0, head)}${note}${s.slice(s.length - (keep - head))}`;
}

/**
 * What a failed gh call said, from both streams: stderr, then GitHub's message and up to 5 validation errors
 * (or the raw stdout when it is not a JSON error body), then the spawn error. Each piece is scrubbed of tokens,
 * then the pieces share DETAIL_LIMIT characters so no single piece can push the others out.
 */
const oneLine = (r) => {
  const { stderr, stdout, body } = streams(r);
  const parts = [];
  const field = (text) => parts.push({ text: flat(scrub(text)) });
  const next = () => parts.length && parts.push(' | ');
  if (stderr) field(stderr);
  if (body) {
    next();
    field(body.message);
    const errors = Array.isArray(body.errors) ? body.errors : [];
    errors.slice(0, ERRORS_SHOWN).forEach((e, i) => {
      parts.push(i === 0 ? ': ' : '; ');
      field(errorEntry(e));
    });
    if (errors.length > ERRORS_SHOWN) parts.push(` (and ${errors.length - ERRORS_SHOWN} more errors not shown)`);
  } else if (stdout) {
    next();
    field(stdout);
  }
  if (r.error?.message) {
    next();
    field(String(r.error.message));
  }
  if (!parts.length) return `exit ${r.status}`;
  const fields = parts.filter((p) => typeof p !== 'string');
  const fixed = parts.reduce((n, p) => n + (typeof p === 'string' ? p.length : 0), 0);
  const shares = fairShares(fields.map((f) => f.text.length), DETAIL_LIMIT - fixed);
  return parts.map((p) => (typeof p === 'string' ? p : clip(p.text, shares[fields.indexOf(p)]))).join('');
};

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
        const cause = failureCause(r);
        if (status === 429 || (status === 403 && /rate limit|abuse|secondary/i.test(cause))) {
          throw new GhError(`gh at ${ghPath}: ${method} ${apiPath} was rate limited by ${host} (${said}). Nothing is retried; run again later. Work done before this call stays done, and a rerun picks up from it.`, { kind: 'rate_limit', status });
        }
        if (status === 401 || /bad credentials|authentication|not logged in/i.test(cause)) {
          throw new GhError(`gh at ${ghPath}: ${method} ${apiPath} was refused as unauthenticated by ${host} (${said}); run gh auth login --hostname ${host}. On WSL with a Windows gh.exe, a GH_TOKEN set in WSL reaches it only through WSLENV.`, { kind: 'auth', status });
        }
        throw new GhError(`gh at ${ghPath}: ${method} ${apiPath} failed (${said})`, { kind: 'http', status });
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
export function readInventory(gh, ownerRepo, snapshot, project, excludePrefixes = []) {
  const issues = gh.list(`repos/${ownerRepo}/issues?state=all`);
  const labels = gh.list(`repos/${ownerRepo}/labels`).map((l) => l.name);
  const receipts = new Set();
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  for (const number of closeCandidates(snapshot, issues, project, excludePrefixes)) {
    const key = footerOf(byNumber.get(number).body).key;
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
          const advice =
            e.kind === 'http' && (e.status === 403 || e.status === 404)
              ? `The label '${a.name}' is missing and could not be created; the account needs triage or write access to ${ownerRepo}, or a maintainer creates the label by hand.`
              : e.kind === 'http' && e.status === 422
                ? `The label '${a.name}' could not be created: GitHub refused the request with HTTP 422, which is not an access refusal; the reason is only what GitHub said above.`
                : `The label '${a.name}' is missing and could not be created.`;
          throw new GhError(`${e.message}. ${advice}`, { kind: e.kind, status: e.status });
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

/**
 * The lock file for one repo (host/owner/repo, lowercased as GitHub compares
 * them), under a private per-user directory in the OS temp dir. It is per repo,
 * not per project: every project mirroring into one repo shares its issue
 * count, so their runs take turns. Not guaranteed across machines or WSL distros.
 */
export function lockPathFor(repo) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const dir = join(tmpdir(), `sterling-locks-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw new Error(`sync-board-issues: ${dir} is not a private directory of this user; refusing to take the run lock through it`);
  }
  const hash = createHash('sha256').update(String(repo).toLowerCase()).digest('hex').slice(0, 32);
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
Exit codes: 0 done, 1 refused or failed, 2 usage error or an invalid
config issue_mirror setting, 3 done but new issues
were not created because the repo reached the issue ceiling (default ${ISSUE_CEILING}; config issue_mirror.ceiling sets it, 0 or null for unlimited).`;

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
  let ceiling;
  let excludePrefixes;
  try {
    ({ ceiling, excludePrefixes } = mirrorSettingsAt(storeRoot));
  } catch (e) {
    if (e instanceof CeilingSettingError) {
      process.stderr.write(`sync-board-issues: ${e.message}. Nothing was written.\n`);
      process.exit(2);
    }
    refuse(`the issue_mirror settings could not be read: ${e.message}`);
  }
  const ceilingText = `${ceiling.limit === null ? 'unlimited' : ceiling.limit} (${ceiling.source === 'default' ? 'default' : 'config issue_mirror.ceiling'})`;
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
    const inventory = readInventory(gh, ownerRepo, snapshot, project, excludePrefixes);
    const result = plan({ snapshot, project, ceiling: ceiling.limit, excludePrefixes, ...inventory });
    if (args.dryRun) process.stdout.write(`sync-board-issues: CEILING limit ${ceilingText}; ${result.ceiling.count} genuine issue(s) (open and closed, pull requests excluded) in the repo.\n`);
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
        `sync-board-issues: CEILING ${origin.repo} holds ${result.ceiling.count} issues (pull requests excluded) and the limit is ${result.ceiling.limit} (${ceiling.source === 'default' ? 'default mirror ceiling' : 'config issue_mirror.ceiling'}): ${result.ceiling.skipped} board task(s) got NO issue. Closing and labelling ${args.dryRun ? 'are still planned' : 'still ran'}.\n`
      );
      return 3;
    }
    return 0;
  };

  let code;
  try {
    if (args.dryRun) code = run();
    else {
      const lockPath = lockPathFor(origin.repo);
      try {
        code = withSessionEventsLock(lockPath, run, { timeoutMs: 0 });
      } catch (e) {
        if (e?.code !== SESSION_EVENTS_LOCK_HELD) throw e;
        refuse(`another sync-board-issues run holds the lock for ${origin.repo} (${lockPath}.lock.db), from this project or another one mirroring into that repo. Nothing was written; run again after it finishes.`);
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
