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
// slugs (decision 11b8b08c). No new hook and no new config key: the ceiling is
// the existing delegation.max_concurrent (a ceiling, never a quota).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareBoardReadiness } from '@sterling/store';
import { configSchema } from '@sterling/schemas';
import { presumedActiveEntries, readDispatchState } from '../../lib/dispatch-register.mjs';
import { deliverySessionDir } from './delivery.mjs';

/** Items shown per group; the rest are counted, never dropped silently. */
export const BOARD_GROUP_CAP = 8;
const DECISION = 'decision board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start';

/** The three printed groups, each in the one listing order (priority, then most recently updated). Blocked items are counted apart. */
export function boardGroups(readiness) {
  const sorted = [...readiness].sort(compareBoardReadiness);
  return {
    ready: sorted.filter((r) => r.state === 'ready'),
    research: sorted.filter((r) => r.state === 'research'),
    waiting: sorted.filter((r) => r.state === 'waiting'),
    blocked: sorted.filter((r) => r.state === 'blocked').length,
  };
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
 * Agent descriptions of the live lanes, joined from the dispatch-state record
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
      if (toolUseIds.has(record.tool_use_id) && typeof record.description === 'string' && record.description) descriptions.push(record.description);
    }
  }
  return { availability, count: entries.length, descriptions };
}

function lanesText(live, ceiling) {
  const k = live.availability === 'ok' ? String(live.count) : `? (dispatch register ${live.availability})`;
  const n = ceiling.error ? `? (delegation.max_concurrent unreadable: ${ceiling.error})` : String(ceiling.value);
  return `live lanes ${k}/${n}`;
}

/** For each READY item, the other READY items that declare a file_keys path in common (the lane_advisory proxy for a write-set). */
function overlapMarks(ready) {
  const marks = new Map();
  for (const a of ready) {
    const keys = new Set(a.file_keys);
    const others = ready.filter((b) => b.id !== a.id && b.file_keys.some((k) => keys.has(k))).map((b) => b.name);
    if (others.length) marks.set(a.id, others);
  }
  return marks;
}

function groupLines(title, items, cap, render) {
  if (!items.length) return [];
  const out = [`${title.replace('{n}', String(items.length))}:`, ...items.slice(0, cap).map(render)];
  if (items.length > cap) out.push(`  … ${items.length - cap} more ${title.split(' (')[0]} (board_query)`);
  return out;
}

/**
 * The H1 / OpenCode block, or '' when no user item is ready, waiting or
 * blocked. `live` is {count, availability}; `ceiling` is laneCeiling's result.
 */
export function renderBoardReadiness({ readiness, live, ceiling, cap = BOARD_GROUP_CAP }) {
  const g = boardGroups(readiness);
  if (!g.ready.length && !g.research.length && !g.waiting.length && !g.blocked) return '';
  const marks = overlapMarks(g.ready);
  const blockedNote = g.blocked ? `; ${g.blocked} blocked` : '';
  const header =
    `BOARD READINESS (${DECISION}) — ${lanesText(live, ceiling)}${blockedNote}. ` +
    `At session start and each time a lane lands, fill free lanes from READY and READY FOR RESEARCH up to the ceiling (a ceiling, never a quota). ` +
    `READY FOR RESEARCH items take researcher lanes only, never an implementor; WAITING ON YOU items wait for the user (needs user or grill). ` +
    `Items marked ⚠ share a write path: their implementation lanes run one at a time.`;
  const lines = [
    header,
    ...groupLines('READY ({n})', g.ready, cap, (r) => {
      const pri = r.priority && r.priority !== 'normal' ? ` [${r.priority}]` : '';
      const mark = marks.get(r.id);
      return `- ${r.name}${pri}${mark ? ` ⚠ shares a write path with ${mark.join(', ')}` : ''}`;
    }),
    ...groupLines('READY FOR RESEARCH ({n}, researcher lanes only)', g.research, cap, (r) => `- ${r.name}${r.priority && r.priority !== 'normal' ? ` [${r.priority}]` : ''}`),
    ...groupLines('WAITING ON YOU ({n})', g.waiting, cap, (r) => `- ${r.name} — needs ${r.needs}${r.blockers_open?.length ? ` (also blocked by ${r.blockers_open.join(', ')})` : ''}`),
  ];
  return lines.join('\n');
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
