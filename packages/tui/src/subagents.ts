// The terminal dashboard's Agents tab: a read-only view of H22's
// dispatch register (.sterling/transient/dispatch-register.json) and the
// composition of the Agents tab's cards: an animated portrait on a tinted tile per subagent.
//
// The register is read WITHOUT its lock: readRegister is a plain file read,
// and the register is rewritten by an atomic rename, so the dashboard never
// competes with H22 for the kernel-held lock (decision
// dispatch-register-lock-reclaims-an-ownerless-lock-and-releases-only-its-own).
// A file that does not parse is "corrupt" and is shown as unknown, never as an
// empty list.
//
// Live means a register row with no `ended`. A resumed agent keeps its
// agent_id across rounds, so rows are grouped by agent_id and the latest round
// decides the status; the portrait assignment is keyed by agent_id as well.
//
// Context fill: Claude Code reports no per-subagent percentage, so it is
// computed the way H10 computes the main session's: the latest assistant
// usage in the subagent's own transcript (latestUsage, a bounded tail read)
// over the model's window from the shared table templates/context-windows.json
// with the project's context_watch.windows as override.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_MODEL_KEY, parseConfig } from '@sterling/schemas';
import { readRegister, dispatchStateDir, dispatchStateKey, type RegisterEntry } from '../../../scripts/lib/dispatch-register.mjs';
import { deriveAgentTranscript, fillPct, latestUsage } from '../../../scripts/hooks/lib/transcript.mjs';
import { sterlingRootFrom } from '../../../scripts/lib/opencode-install.mjs';
import { assign, frameAt, phaseFor, tileCells, POOL_SIZE, SPRITE_ROWS, TILE_BG, type AssignState } from './avatars/index.js';

/** How long a missing subagent transcript is left unsearched before the next look. */
const TRANSCRIPT_RETRY_MS = 10_000;

/** How long an ended agent stays in the block, shown as done. */
export const DONE_LINGER_MS = 5 * 60_000;

export type RegisterAvailability = 'ok' | 'absent' | 'corrupt';

export interface SubagentRow {
  agentId: string;
  /** the latest round's session, which names the transcript directory */
  sessionId: string;
  agentType: string | null;
  status: 'running' | 'done';
  /** the latest round's start */
  startedAt: number;
  endedAt: number | null;
  elapsedMs: number;
  /** the tool_use_id of the latest round that has one; a resumed round has none */
  toolUseId: string | null;
}

export interface SubagentSource {
  availability: RegisterAvailability;
  rows: SubagentRow[];
}

function roundOf(e: RegisterEntry): number {
  return typeof e.round === 'number' ? e.round : 1;
}

/** Read the register and reduce it to one row per agent_id: running when its
 *  latest round has neither `ended` nor `residue_reported_at`, done when that
 *  round ended within lingerMs. H10 stamps residue_reported_at on a row whose
 *  subagent is gone without a stop event, so the stamp counts as the end. */
export function readSubagents(projectRoot: string, now: number, lingerMs = DONE_LINGER_MS): SubagentSource {
  const reg = readRegister(projectRoot);
  if (reg.availability !== 'ok') return { availability: reg.availability, rows: [] };
  const byAgent = new Map<string, RegisterEntry[]>();
  for (const e of reg.entries) {
    const list = byAgent.get(e.agent_id) ?? [];
    list.push(e);
    byAgent.set(e.agent_id, list);
  }
  const rows: SubagentRow[] = [];
  for (const [agentId, rounds] of byAgent) {
    rounds.sort((a, b) => roundOf(b) - roundOf(a) || Date.parse(b.at) - Date.parse(a.at));
    const latest = rounds[0]!;
    const startedAt = Date.parse(latest.at);
    if (Number.isNaN(startedAt)) continue;
    const endStamp = latest.ended ? latest.ended.at : latest.residue_reported_at ? String(latest.residue_reported_at) : null;
    const endedAt = endStamp === null ? null : Date.parse(endStamp);
    if (endedAt !== null && (Number.isNaN(endedAt) || now - endedAt > lingerMs)) continue;
    const withId = rounds.find((r) => typeof r.tool_use_id === 'string' && r.tool_use_id !== '');
    rows.push({
      agentId,
      sessionId: latest.session_id,
      agentType: typeof latest.agent_type === 'string' && latest.agent_type ? latest.agent_type : null,
      status: endedAt === null ? 'running' : 'done',
      startedAt,
      endedAt,
      elapsedMs: Math.max(0, (endedAt ?? now) - startedAt),
      toolUseId: (withId?.tool_use_id as string | undefined) ?? null,
    });
  }
  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
    return a.status === 'running' ? a.startedAt - b.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0);
  });
  return { availability: 'ok', rows };
}

/** The dispatch description from the dispatch-state record of a tool_use_id
 *  (live-<key>.json, or done-<key>~<ids>.json once terminal). The record's
 *  own tool_use_id must match: a filename alone is never evidence. The
 *  description is optional decoration, so an unreadable record yields null. */
export function readDispatchDescription(projectRoot: string, toolUseId: string): string | null {
  const dir = dispatchStateDir(projectRoot);
  const key = dispatchStateKey(toolUseId);
  let file = join(dir, `live-${key}.json`);
  try {
    if (!existsSync(file)) {
      const done = readdirSync(dir).find((n) => n.startsWith(`done-${key}~`) && n.endsWith('.json'));
      if (!done) return null;
      file = join(dir, done);
    }
    const rec = JSON.parse(readFileSync(file, 'utf8')) as { tool_use_id?: unknown; description?: unknown };
    return rec.tool_use_id === toolUseId && typeof rec.description === 'string' && rec.description ? rec.description : null;
  } catch {
    return null;
  }
}

/** An agent type's model: the installed .claude/agents/<type>.md frontmatter
 *  (the copy that governs dispatch), else config.models for its key, else
 *  null. Built-in types (Explore, general-purpose) have neither. */
export function readAgentModel(projectRoot: string, type: string): string | null {
  try {
    const content = readFileSync(join(projectRoot, '.claude', 'agents', `${type}.md`), 'utf8');
    const model = content.match(/^---\n([\s\S]*?)\n---\n/)?.[1]?.match(/^model:\s*(\S+)/m)?.[1];
    if (model) return model;
  } catch {
    // not installed: fall through to config.models
  }
  const key = AGENT_MODEL_KEY[type];
  if (!key) return null;
  try {
    const raw = JSON.parse(readFileSync(join(projectRoot, '.sterling', 'config.json'), 'utf8')) as { models?: Record<string, { model?: unknown }> };
    const model = raw.models?.[key]?.model;
    return typeof model === 'string' && model ? model : null;
  } catch {
    return null;
  }
}

/** The subagent's own transcript: <claude config dir>/projects/<slug>/<session>/subagents/agent-<id>.jsonl.
 *  The slug is the session's launch directory with every non-alphanumeric
 *  character turned into '-'. The project root's slug is tried first; a
 *  session started elsewhere (a worktree, a subdirectory) is found by its
 *  session id under the other slugs. Null when no such session exists. */
export function subagentTranscriptPath(projectRoot: string, sessionId: string, agentId: string, claudeConfigDir = defaultClaudeConfigDir()): string | null {
  const projects = join(claudeConfigDir, 'projects');
  const slug = projectRoot.replace(/[^A-Za-z0-9]/g, '-');
  const sessionUnder = (dir: string) => existsSync(join(projects, dir, sessionId));
  let dir: string | undefined = sessionUnder(slug) ? slug : undefined;
  if (!dir) {
    let all: string[];
    try {
      all = readdirSync(projects);
    } catch {
      return null;
    }
    dir = all.find((d) => d !== slug && sessionUnder(d));
  }
  return dir ? deriveAgentTranscript(join(projects, dir, `${sessionId}.jsonl`), agentId) : null;
}

function defaultClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** Tokens in context at the transcript's latest assistant turn (input plus
 *  both cache fields, H10's rule through the shared fillPct) and the model
 *  that turn ran on. Null for a missing file or before the first usage. */
export function readContextUsage(path: string): { tokens: number; model: string | null } | null {
  try {
    const { usage, model } = latestUsage(path);
    if (!usage) return null;
    // fillPct over a window of 100 is the token count itself, so the one formula stays in transcript.mjs
    return { tokens: Math.round(fillPct(usage, 100)), model: typeof model === 'string' && model ? model : null };
  } catch {
    return null;
  }
}

/** H10's window order: project [model] ?? [base model], then the shared table
 *  [model] ?? [base model], then the project default, then the shared default.
 *  A context-variant suffix ("claude-opus-5[1m]") falls back to its base id. */
export function contextWindowFor(model: string, project: Readonly<Record<string, number>>, shared: Readonly<Record<string, number>> | null): number | null {
  const base = model.replace(/\[[^\]]*\]$/, '');
  return project[model] ?? project[base] ?? shared?.[model] ?? shared?.[base] ?? project.default ?? shared?.default ?? null;
}

/** Whole-number fill; over 100% means the window is wrong, so it is unknown. */
export function contextPercent(tokens: number, window: number): number | null {
  const pct = (100 * tokens) / window;
  return pct > 100 ? null : Math.round(pct);
}

function readSharedWindows(): Record<string, number> | null {
  try {
    const raw = JSON.parse(readFileSync(join(sterlingRootFrom(import.meta.url), 'templates', 'context-windows.json'), 'utf8')) as { windows?: unknown };
    return parseConfig({ context_watch: { windows: raw.windows } }).context_watch.windows as Record<string, number>;
  } catch {
    return null;
  }
}

function readProjectWindows(projectRoot: string): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(join(projectRoot, '.sterling', 'config.json'), 'utf8'));
    return parseConfig(raw).context_watch.windows as Record<string, number>;
  } catch {
    return {};
  }
}

export interface SubagentAgentView {
  agentId: string;
  avatar: number;
  type: string;
  description: string | null;
  model: string | null;
  status: 'running' | 'done';
  elapsedMs: number;
  /** context fill, or null while unknown */
  contextPct: number | null;
}

export interface SubagentView {
  availability: RegisterAvailability;
  /** running agents */
  active: number;
  agents: SubagentAgentView[];
}

export interface SubagentTracker {
  view(now: number): SubagentView;
}

/** The dashboard's subagent state for the TUI's lifetime: the portrait
 *  assignment (current plus freed), a description cache per tool_use_id, and
 *  the last register read. The register is read at most once per
 *  readIntervalMs, so the 3 Hz animation does not add file reads. */
export function createSubagentTracker(
  projectRoot: string,
  {
    rng = Math.random,
    readIntervalMs = 1000,
    lingerMs = DONE_LINGER_MS,
    claudeConfigDir = defaultClaudeConfigDir(),
  }: { rng?: () => number; readIntervalMs?: number; lingerMs?: number; claudeConfigDir?: string } = {},
): SubagentTracker {
  let avatars: AssignState = { current: new Map(), freed: [] };
  const descriptions = new Map<string, string | null>();
  let lastRead = -Infinity;
  let source: SubagentSource = { availability: 'absent', rows: [] };
  let models = new Map<string, string | null>();
  // the shipped window table, read once; the project override on every refresh
  const sharedWindows = readSharedWindows();
  // transcript paths per (session, agent); a miss is remembered until its retry time, so a
  // transcript that does not exist yet does not cost a directory scan on every refresh
  const transcripts = new Map<string, string>();
  const missing = new Map<string, number>();
  // per agent: the transcript's size and mtime at the last tail read, so an
  // unchanged transcript is not read again
  const usage = new Map<string, { stamp: string; value: { tokens: number; model: string | null } | null }>();
  let context = new Map<string, { model: string | null; pct: number | null }>();

  const keyOf = (r: SubagentRow): string => `${r.sessionId}\0${r.agentId}`;

  function contextOf(r: SubagentRow, windows: Record<string, number>, now: number): { model: string | null; pct: number | null } {
    const key = keyOf(r);
    let path = transcripts.get(key);
    if (!path && now >= (missing.get(key) ?? -Infinity)) {
      path = subagentTranscriptPath(projectRoot, r.sessionId, r.agentId, claudeConfigDir) ?? undefined;
      if (path) {
        transcripts.set(key, path);
        missing.delete(key);
      } else missing.set(key, now + TRANSCRIPT_RETRY_MS);
    }
    if (!path) return { model: null, pct: null };
    let stamp: string;
    try {
      const st = statSync(path);
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      return { model: null, pct: null };
    }
    let cached = usage.get(r.agentId);
    if (cached?.stamp !== stamp) {
      cached = { stamp, value: readContextUsage(path) };
      usage.set(r.agentId, cached);
    }
    const u = cached.value;
    if (!u) return { model: null, pct: null };
    const model = u.model ?? (r.agentType ? models.get(r.agentType) ?? null : null);
    const window = model ? contextWindowFor(model, windows, sharedWindows) : null;
    return { model: u.model, pct: window ? contextPercent(u.tokens, window) : null };
  }

  function refresh(now: number): void {
    lastRead = now;
    source = readSubagents(projectRoot, now, lingerMs);
    // a corrupt read leaves the assignment alone, so faces do not reshuffle
    if (source.availability === 'corrupt') return;
    avatars = assign(source.rows.map((r) => r.agentId), avatars.current, rng, { poolSize: POOL_SIZE, freed: avatars.freed });
    models = new Map();
    for (const r of source.rows) {
      if (r.toolUseId && !descriptions.has(r.toolUseId)) {
        // a null is final only for a done row: a running row's record may not have its new name yet
        const d = readDispatchDescription(projectRoot, r.toolUseId);
        if (d !== null || r.status === 'done') descriptions.set(r.toolUseId, d);
      }
      if (r.agentType && !models.has(r.agentType)) models.set(r.agentType, readAgentModel(projectRoot, r.agentType));
    }
    const windows = source.rows.length ? readProjectWindows(projectRoot) : {};
    context = new Map(source.rows.map((r) => [r.agentId, contextOf(r, windows, now)]));
    // forget what belongs to agents that left the register
    const keys = new Set(source.rows.map(keyOf));
    for (const k of [...transcripts.keys()]) if (!keys.has(k)) transcripts.delete(k);
    for (const k of [...missing.keys()]) if (!keys.has(k)) missing.delete(k);
    const agents = new Set(source.rows.map((r) => r.agentId));
    for (const k of [...usage.keys()]) if (!agents.has(k)) usage.delete(k);
    const tools = new Set(source.rows.map((r) => r.toolUseId));
    for (const k of [...descriptions.keys()]) if (!tools.has(k)) descriptions.delete(k);
  }

  return {
    view(now) {
      if (now - lastRead >= readIntervalMs) refresh(now);
      const agents = source.rows.map((r) => ({
        agentId: r.agentId,
        avatar: avatars.current.get(r.agentId) ?? 0,
        type: r.agentType ?? 'agent',
        description: r.toolUseId ? descriptions.get(r.toolUseId) ?? null : null,
        model: context.get(r.agentId)?.model ?? (r.agentType ? models.get(r.agentType) ?? null : null),
        status: r.status,
        elapsedMs: r.status === 'running' ? Math.max(0, now - r.startedAt) : r.elapsedMs,
        contextPct: context.get(r.agentId)?.pct ?? null,
      }));
      return { availability: source.availability, active: agents.filter((a) => a.status === 'running').length, agents };
    },
  };
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

// ---------------------------------------------------------------------------
// Composition. Coordinates are relative to the block's top-left corner, which
// the renderer puts at the top of the Agents tab's body. The agents are cards
// side by side in one row, wrapping to the next row only when the pane is too
// narrow: each card is the 8x3 portrait tile with four text lines below it
// (type, `status · N% ctx`, model, description), clipped to the card.
// ---------------------------------------------------------------------------

export interface BlockAttr {
  bold?: boolean;
  dim?: boolean;
  color?: string;
}
export interface BlockPut {
  x: number;
  y: number;
  attr: BlockAttr;
  text: string;
}
/** One portrait cell: a quadrant block character; no fg/bg means the default background. */
export interface BlockPixel {
  x: number;
  y: number;
  ch: string;
  fg?: string;
  bg?: string;
}
export interface SubagentBlock {
  height: number;
  puts: BlockPut[];
  pixels: BlockPixel[];
}

const TILE_H = SPRITE_ROWS;
const CARD_W = 24;
const CARD_H = TILE_H + 4;
const CARD_GAP = 2;
const ROW_GAP = 1;
/** a done card's portrait is blended this far toward the tile colour */
const DONE_FADE = 0.55;

function clip(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  return width <= 1 ? chars.slice(0, width).join('') : chars.slice(0, width - 1).join('') + '…';
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `hex` blended toward the tile colour by `amount` (0 keeps it, 1 is the tile colour). */
function fadeToTile(hex: string, amount: number): string {
  const [a, b] = [rgb(hex), rgb(TILE_BG)];
  const mix = a.map((v, i) => Math.round(v + (b[i]! - v) * amount));
  return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Lay the cards out in at most maxHeight rows of a width-column area. A readable
 *  register with no agents draws one dim line, so the tab is never blank. */
export function composeSubagentBlock(view: SubagentView, width: number, maxHeight: number, tick: number): SubagentBlock {
  const empty: SubagentBlock = { height: 0, puts: [], pixels: [] };
  if (maxHeight < 1 || width < 1) return empty;
  const note = (text: string): SubagentBlock => ({ height: 1, puts: [{ x: 0, y: 0, attr: { dim: true }, text: clip(text, width) }], pixels: [] });
  if (view.availability === 'corrupt') return note('Sub-agents: unknown — the dispatch register could not be read');
  if (view.agents.length === 0) return note('(no sub-agents)');

  const cardW = Math.min(CARD_W, width);
  const perRow = Math.max(1, Math.floor((width + CARD_GAP) / (cardW + CARD_GAP)));
  const rowsFit = Math.floor((maxHeight + ROW_GAP) / (CARD_H + ROW_GAP));
  const cardRows = Math.max(0, Math.min(Math.ceil(view.agents.length / perRow), rowsFit));
  if (cardRows === 0) return note(`${view.agents.length} sub-agents, no room to show them`);
  const shown = Math.min(view.agents.length, cardRows * perRow);
  const hidden = view.agents.length - shown;

  const puts: BlockPut[] = [];
  const pixels: BlockPixel[] = [];
  for (let i = 0; i < shown; i++) {
    const a = view.agents[i]!;
    const done = a.status === 'done';
    const x0 = (i % perRow) * (cardW + CARD_GAP);
    const y0 = Math.floor(i / perRow) * (CARD_H + ROW_GAP);
    // the tile: every cell carries a bg, so the tint covers the padding and the transparent pixels.
    // A done agent rests on frame 0 and its portrait is faded.
    tileCells(a.avatar, frameAt(tick, phaseFor(a.avatar), !done)).forEach((line, r) =>
      line.forEach((cell, c) => {
        const px: BlockPixel = { x: x0 + c, y: y0 + r, ch: cell.ch };
        if (cell.fg !== undefined) px.fg = done ? fadeToTile(cell.fg, DONE_FADE) : cell.fg;
        if (cell.bg !== undefined) px.bg = done ? fadeToTile(cell.bg, DONE_FADE) : cell.bg;
        pixels.push(px);
      }),
    );
    const ty = y0 + TILE_H;
    puts.push({ x: x0, y: ty, attr: done ? { bold: true, dim: true } : { bold: true }, text: clip(a.type, cardW) });
    const status = `${a.status} · ${a.contextPct === null ? '?' : `${a.contextPct}%`} ctx`;
    puts.push({ x: x0, y: ty + 1, attr: done ? { dim: true } : { color: 'green' }, text: clip(status, cardW) });
    puts.push({ x: x0, y: ty + 2, attr: { dim: true }, text: clip(a.model ?? 'model unknown', cardW) });
    if (a.description) puts.push({ x: x0, y: ty + 3, attr: { dim: true }, text: clip(a.description, cardW) });
  }
  const height = cardRows * CARD_H + (cardRows - 1) * ROW_GAP;
  if (hidden > 0 && height + 1 <= maxHeight) {
    puts.push({ x: 0, y: height, attr: { dim: true }, text: clip(`${hidden} more not shown`, width) });
    return { height: height + 1, puts, pixels };
  }
  return { height, puts, pixels };
}
