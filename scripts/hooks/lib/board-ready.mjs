// BOARD READINESS LINES (decision
// board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start, as
// amended after the Fable sparring pass). The intake rule told the conductor to
// run every unblocked item in parallel, but nothing triggered it; these lines
// put the ready list in front of it where it plans work:
//   - H1 at session start and after a clear (renderBoardReadiness),
//   - H20 at PreToolUse:Agent, once per session per READY + RESEARCH set (boardReadyNotice),
//   - the OpenCode plugin's root-session context (renderBoardReadiness).
// Readiness itself is computed in ONE place, store.boardReadiness(); this file
// only groups, orders, caps and words it. Names are `name (id8)`, never bare
// slugs (the former ruling 'board-item-label-comes-from-current-text-the-slug-stays-an-immutable-address' (not in the current store)). No new hook and no new config key: the ceiling is
// the existing delegation.max_concurrent (a ceiling, never a quota).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardWaitAge as waitAge, boardWriteOverlaps, compareBoardReadiness, DEFAULT_CLAIM_LEASE_MINUTES } from '@sterling/store';
import { configSchema } from '@sterling/schemas';
import { presumedActiveEntries, readDispatchState } from '../../lib/dispatch-register.mjs';
import { deliverySessionDir } from './delivery.mjs';

/** Items shown per group; the rest are counted, never dropped silently. */
export const BOARD_GROUP_CAP = 8;
const DECISION = 'decision board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start';

/**
 * The printed groups, each in the one listing order (priority, then most
 * recently updated). Blocked items are counted apart. Delegated items are
 * trackers for tasks handed to another project (GitHub issue #105): never
 * READY, never WAITING ON YOU, listed apart with their remote status.
 */
export function boardGroups(readiness) {
  const all = [...readiness].sort(compareBoardReadiness);
  // A claimed item is in progress in some session (decision
  // board-task-claims-for-parallel-sessions-claim-generation-ren): never READY,
  // whoever holds it, and an expired claim waits for a takeover. A delegated
  // tracker stays delegated; its work runs in the other project.
  const inProgress = all.filter((r) => r.claim && r.state !== 'delegated');
  const sorted = all.filter((r) => !r.claim || r.state === 'delegated');
  return {
    inProgress,
    ready: sorted.filter((r) => r.state === 'ready'),
    research: sorted.filter((r) => r.state === 'research'),
    waiting: sorted.filter((r) => r.state === 'waiting'),
    // WAITING ON YOU (needs user or grill) and WAITING ON OTHERS (needs external, GitHub issue #175).
    waitingOnYou: sorted.filter((r) => r.state === 'waiting' && r.needs !== 'external'),
    waitingOnOthers: sorted.filter((r) => r.state === 'waiting' && r.needs === 'external'),
    blocked: sorted.filter((r) => r.state === 'blocked').length,
    delegated: sorted.filter((r) => r.state === 'delegated'),
  };
}

/** board_claims.lease_minutes with the schema's own default; {error} when the configured value is invalid. */
export function claimLease(config) {
  // Only an ABSENT key takes the default: null or any other bad value is
  // reported as unreadable, never read as "not set".
  const raw = config?.board_claims;
  const parsed = configSchema.shape.board_claims.safeParse(raw === undefined ? {} : raw);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join('; ') };
  return { value: parsed.data.lease_minutes };
}

/**
 * The lease the readiness read judges claims by. An unreadable value is not
 * replaced silently: the default is used and the block says so (claimLeaseNote).
 */
export function claimLeaseMinutes(lease) {
  return lease?.error ? DEFAULT_CLAIM_LEASE_MINUTES : lease.value;
}

/** One IN PROGRESS line's claim text; ages are measured from renewed_at at `now`. */
function claimText(claim, session, now) {
  if (claim.state === 'unreadable') return 'claim unreadable by this Sterling (read it with board_get)';
  const t = Date.parse(claim.renewed_at);
  const mins = Number.isNaN(t) ? '?' : String(Math.max(0, Math.floor((now - t) / 60_000)));
  const who = `session ${claim.holder_session}${claim.holder_session === session ? ' (this session)' : ''} in ${claim.checkout}`;
  if (claim.state === 'expired') {
    return `⚠ check owner: ${who}, no renewal for ${mins}m (any session may take it over: board_takeover expected_holder ${claim.holder_session}, expected_generation ${claim.generation})`;
  }
  return `${who}, renewed ${mins}m ago`;
}

/** delegation.max_concurrent with the schema's own default; {error} when the configured value is invalid. */
export function laneCeiling(config) {
  const parsed = configSchema.shape.delegation.safeParse(config?.delegation ?? {});
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join('; ') };
  return { value: parsed.data.max_concurrent };
}

/**
 * Live lanes for this session from the dispatch register; availability is passed
 * through so a corrupt register never reads as zero. `descriptions` are the
 * Agent descriptions and prompts of the live lanes (a brief can name its board
 * item in either), joined from the dispatch-state record
 * each live entry's tool_use_id names (register entries carry no description of
 * their own); a lane with no state record contributes none.
 */
export function liveLanes(root, sessionId) {
  const { availability, entries } = presumedActiveEntries(root, { sessionId });
  // No register file yet means nothing was ever dispatched here: zero lanes, measured.
  if (availability === 'absent') return { availability: 'ok', count: 0, descriptions: [] };
  const toolUseIds = new Set(entries.map((e) => e.tool_use_id).filter((t) => typeof t === 'string' && t));
  const descriptions = [];
  if (toolUseIds.size) {
    for (const { record } of readDispatchState(root).records) {
      if (!toolUseIds.has(record.tool_use_id)) continue;
      // The prompt is null when oversize or cleared at Stop; the description alone then stands.
      for (const text of [record.description, record.prompt]) if (typeof text === 'string' && text) descriptions.push(text);
    }
  }
  return { availability, count: entries.length, descriptions };
}

export function lanesText(live, ceiling, { showCount = true } = {}) {
  const n = ceiling.error ? `? (delegation.max_concurrent unreadable: ${ceiling.error})` : String(ceiling.value);
  if (!showCount) return `lane ceiling ${n}`;
  const k = live.availability === 'ok' ? String(live.count) : `? (dispatch register ${live.availability})`;
  return `live lanes ${k}/${n}`;
}

function groupLines(title, items, cap, render, moreNote = () => '') {
  if (!items.length) return [];
  const out = [`${title.replace('{n}', String(items.length))}:`, ...items.slice(0, cap).map(render)];
  if (items.length > cap) out.push(`  … ${items.length - cap} more ${title.split(' (')[0]}${moreNote(items.slice(cap))} (board_query)`);
  return out;
}

/** The omitted external waits' oldest age, so a capped list never hides a stale wait. */
function oldestOmittedWait(omitted, now) {
  const stamped = omitted.map((r) => r.needs_set_at).filter((v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)));
  if (!stamped.length) return ', oldest since unknown';
  const oldest = stamped.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
  const unknown = stamped.length < omitted.length ? ` (${omitted.length - stamped.length} since unknown)` : '';
  return `, oldest ${waitAge(oldest, now)}${unknown}`;
}

/**
 * The H1 / OpenCode block, or '' when no user item is ready, waiting, blocked
 * or delegated. `live` is {count, availability}; `ceiling` is laneCeiling's
 * result. `handoffStatus` maps a delegated item's id to the store's
 * resolveSentHandoffs status; a caller that did not read the other projects
 * passes none, and each delegated line says its status was not read.
 * `showLaneCount: false` (the OpenCode plugin) names only the ceiling: the live
 * count goes stale in a block that is not re-sent, so the plugin sends it as its
 * own `live lanes k/n` line when it changes (GitHub #174).
 */
export function renderBoardReadiness({ readiness, live, ceiling, cap = BOARD_GROUP_CAP, handoffStatus, showLaneCount = true, now = Date.now(), session, lease }) {
  const g = boardGroups(readiness);
  if (!g.ready.length && !g.research.length && !g.waiting.length && !g.blocked && !g.delegated.length && !g.inProgress.length) return '';
  const marks = boardWriteOverlaps(g.ready);
  const blockedNote = g.blocked ? `; ${g.blocked} blocked` : '';
  const header =
    `BOARD READINESS (${DECISION}) — ${lanesText(live, ceiling, { showCount: showLaneCount })}${blockedNote}. ` +
    `At session start and each time a lane lands, fill free lanes from READY and READY FOR RESEARCH up to the ceiling (a ceiling, never a quota). ` +
    `READY FOR RESEARCH items take researcher lanes only, never an implementor; WAITING ON YOU items wait for the user (needs user or grill); WAITING ON OTHERS items wait on an outside party (needs external): recheck one when its evidence arrives, never clear it because time passed. ` +
    `Items marked ⚠ share a write path: their implementation lanes run one at a time.` +
    (g.inProgress.length
      ? ` IN PROGRESS items are claimed by a session (board_claim) and are never started here; one marked check owner has had no renewal for the claim lease, so any session may take it over with board_takeover.`
      : '') +
    (lease?.error ? ` CLAIM LEASE UNREADABLE (board_claims.lease_minutes: ${lease.error}): claims are judged at the ${DEFAULT_CLAIM_LEASE_MINUTES}-minute default, which may not be this project's setting.` : '');
  const lines = [
    header,
    ...groupLines('READY ({n})', g.ready, cap, (r) => {
      const pri = r.priority && r.priority !== 'normal' ? ` [${r.priority}]` : '';
      const mark = marks.get(r.id);
      return `- ${r.name}${pri}${mark ? ` ⚠ shares a write path with ${mark.join(', ')}` : ''}`;
    }),
    ...groupLines('READY FOR RESEARCH ({n}, researcher lanes only)', g.research, cap, (r) => `- ${r.name}${r.priority && r.priority !== 'normal' ? ` [${r.priority}]` : ''}`),
    ...groupLines('WAITING ON YOU ({n})', g.waitingOnYou, cap, (r) => `- ${r.name} — needs ${r.needs}${r.blockers_open?.length ? ` (also blocked by ${r.blockers_open.join(', ')})` : ''}`),
    ...groupLines(
      'WAITING ON OTHERS ({n})',
      g.waitingOnOthers,
      cap,
      (r) => `- ${r.name} — ${r.needs_reason ?? 'no reason recorded'} (${waitAge(r.needs_set_at, now)})${r.blockers_open?.length ? ` (also blocked by ${r.blockers_open.join(', ')})` : ''}`,
      (omitted) => oldestOmittedWait(omitted, now)
    ),
    ...groupLines('DELEGATED TO OTHER PROJECTS ({n}, not run here)', g.delegated, cap, (r) => `- ${r.name} — ${delegatedStatus(r, handoffStatus)}`),
    ...groupLines('IN PROGRESS ({n}, claimed; not READY)', g.inProgress, cap, (r) => `- ${r.name} — ${claimText(r.claim, session, now)}`),
  ];
  return lines.join('\n');
}

/** A delegated item's status line: the resolved remote status, or a statement that it was not read. */
function delegatedStatus(r, handoffStatus) {
  const status = handoffStatus?.get?.(r.id);
  // The receiver's current registry name when the status carries one (GitHub issue #120), else the stored label.
  const name = status?.to_name ?? r.handoff?.to_name;
  const to = name ? `project '${name}'` : 'another project';
  return status ? `${to}: ${status.text}` : `${to}: status not read here (board_query shows it)`;
}

/** True when `id` (as its 8-char prefix or full form) or `slug` appears in the brief as a whole token. */
function namedIn(text, r) {
  const hay = String(text ?? '').toLowerCase();
  const esc = (t) => t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // An id8 may be followed by the rest of a full uuid; a slug must end where the kebab word ends.
  const id8 = new RegExp(`(^|[^a-z0-9-])${esc(r.id.slice(0, 8))}(?![a-z0-9])`);
  const slug = r.slug ? new RegExp(`(^|[^a-z0-9-])${esc(r.slug)}(?![a-z0-9-])`) : null;
  return id8.test(hay) || (slug !== null && slug.test(hay));
}

/**
 * H20's one line: the READY and READY FOR RESEARCH items that are neither named
 * by the outgoing brief (an item the brief cites by id8 or slug is the one being
 * dispatched now) nor named in a live lane's description (already in flight).
 * Returns {line, hash} or null when nothing is left. The hash covers the full
 * READY + RESEARCH id set taken BEFORE either filter, so it changes only when
 * the board's ready set changes and the line fires once per set per session,
 * whatever the briefs say. The two filters shape the display only.
 */
export function boardReadyNotice(readiness, outgoing, live, ceiling, cap = BOARD_GROUP_CAP) {
  const g = boardGroups(readiness);
  const all = [...g.ready.map((r) => ({ r, tag: '' })), ...g.research.map((r) => ({ r, tag: ' [research]' }))];
  if (!all.length) return null;
  const inFlight = Array.isArray(live?.descriptions) ? live.descriptions : [];
  const pending = all.filter(({ r }) => !namedIn(outgoing, r) && !inFlight.some((d) => namedIn(d, r)));
  if (!pending.length) return null;
  const shown = pending.slice(0, cap).map(({ r, tag }) => `${r.name}${tag}`);
  const more = pending.length > cap ? `, … ${pending.length - cap} more` : '';
  const hash = createHash('sha256').update(all.map(({ r }) => r.id).sort().join('\n')).digest('hex').slice(0, 16);
  return {
    line: `BOARD READY: ${shown.join(', ')}${more} — ${lanesText(live, ceiling)}; fill free lanes up to the ceiling (a ceiling, never a quota).`,
    hash,
  };
}

function noticePath(root, sessionId) {
  const dir = deliverySessionDir(root, sessionId);
  return dir ? join(dir, 'board-ready.json') : null;
}

/** False only when this session already showed the line for this exact ready set. No session identity: due (never silently suppressed). */
export function boardReadyNoticeDue(root, sessionId, hash) {
  const p = noticePath(root, sessionId);
  if (!p || !existsSync(p)) return true;
  try {
    return JSON.parse(readFileSync(p, 'utf8')).hash !== hash;
  } catch {
    // An unreadable marker repeats the line rather than hiding it.
    return true;
  }
}

/** Record that the line for `hash` reached this session. Called only after the envelope was written. */
export function markBoardReadyNoticed(root, sessionId, hash) {
  const p = noticePath(root, sessionId);
  if (!p) return;
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify({ hash }));
}
