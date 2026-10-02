// The terminal dashboard's Sub-agents block: a read-only view of H22's
// dispatch register (.sterling/transient/dispatch-register.json) and the
// composition of one animated portrait on a tinted tile per subagent.
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
import { assign, frameAt, phaseFor, tileCells, POOL_SIZE, SPRITE_ROWS, TILE_COLS, type AssignState } from './avatars/index.js';

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
 *  latest round has no `ended`, done when that round ended within lingerMs. */
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
    const endedAt = latest.ended ? Date.parse(latest.ended.at) : null;
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
  const transcripts = new Map<string, string>();
  // per agent: the transcript's size and mtime at the last tail read, so an
  // unchanged transcript is not read again
  const usage = new Map<string, { stamp: string; value: { tokens: number; model: string | null } | null }>();
  let context = new Map<string, { model: string | null; pct: number | null }>();

  function contextOf(r: SubagentRow, windows: Record<string, number>): { model: string | null; pct: number | null } {
    let path = transcripts.get(r.agentId);
    if (!path) {
      path = subagentTranscriptPath(projectRoot, r.sessionId, r.agentId, claudeConfigDir) ?? undefined;
      if (path) transcripts.set(r.agentId, path);
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
      if (r.toolUseId && !descriptions.has(r.toolUseId)) descriptions.set(r.toolUseId, readDispatchDescription(projectRoot, r.toolUseId));
      if (r.agentType && !models.has(r.agentType)) models.set(r.agentType, readAgentModel(projectRoot, r.agentType));
    }
    const windows = source.rows.length ? readProjectWindows(projectRoot) : {};
    context = new Map(source.rows.map((r) => [r.agentId, contextOf(r, windows)]));
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
// Composition. Coordinates are relative to the block's top-left corner; the
// renderer offsets them. Row 0 is a blank separator, row 1 the header, then
// tile rows (SPRITE_ROWS high, a blank row between them) with three text
// lines beside each tile: type, `status · N% ctx · model`, description.
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
/** One half-block portrait cell; no fg/bg means the default background. */
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
const ROW_GAP = 1;
const TEXT_GAP = 1;
const TEXT_MAX = 36;
const TEXT_MIN = 8;
const TILE_GAP = 2;
const HEAD_ROWS = 2;

function clip(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  return width <= 1 ? chars.slice(0, width).join('') : chars.slice(0, width - 1).join('') + '…';
}

/** Lay out the block in at most maxHeight rows of a width-column area.
 *  Nothing is drawn for a readable register with no agents. */
export function composeSubagentBlock(view: SubagentView, width: number, maxHeight: number, tick: number): SubagentBlock {
  const empty: SubagentBlock = { height: 0, puts: [], pixels: [] };
  if (maxHeight < HEAD_ROWS || width < 1) return empty;
  if (view.availability === 'corrupt') {
    return { height: HEAD_ROWS, puts: [{ x: 0, y: 1, attr: { dim: true }, text: clip('Sub-agents: unknown — the dispatch register could not be read', width) }], pixels: [] };
  }
  if (view.agents.length === 0) return empty;

  const textW = Math.min(TEXT_MAX, width - TILE_COLS - TEXT_GAP);
  const fitsTile = textW >= TEXT_MIN;
  const tileW = TILE_COLS + TEXT_GAP + textW;
  const perRow = fitsTile ? Math.max(1, Math.floor((width + TILE_GAP) / (tileW + TILE_GAP))) : 0;
  const tileRows = fitsTile ? Math.min(Math.ceil(view.agents.length / perRow), Math.floor((maxHeight - HEAD_ROWS + ROW_GAP) / (TILE_H + ROW_GAP))) : 0;
  const shown = Math.min(view.agents.length, tileRows * perRow);
  const hidden = view.agents.length - shown;

  const puts: BlockPut[] = [];
  const pixels: BlockPixel[] = [];
  const header = `Sub-agents (${view.active} active)` + (hidden > 0 ? ` · ${hidden} more not shown` : '');
  puts.push({ x: 0, y: 1, attr: { bold: true }, text: clip(header, width) });

  for (let i = 0; i < shown; i++) {
    const a = view.agents[i]!;
    const x0 = (i % perRow) * (tileW + TILE_GAP);
    const y0 = HEAD_ROWS + Math.floor(i / perRow) * (TILE_H + ROW_GAP);

    // the tile: every cell carries a bg, so the tint covers the padding and the transparent pixels
    tileCells(a.avatar, frameAt(tick, phaseFor(a.avatar), a.status === 'running')).forEach((line, r) =>
      line.forEach((cell, c) => {
        const px: BlockPixel = { x: x0 + c, y: y0 + r, ch: cell.ch };
        if (cell.fg !== undefined) px.fg = cell.fg;
        if (cell.bg !== undefined) px.bg = cell.bg;
        pixels.push(px);
      }),
    );

    const tx = x0 + TILE_COLS + TEXT_GAP;
    puts.push({ x: tx, y: y0, attr: { bold: true }, text: clip(a.type, textW) });
    // status and context in the status colour, the model dim after them
    const status = `${a.status} · ${a.contextPct === null ? '?' : `${a.contextPct}%`} ctx`;
    const line = [...clip(`${status} · ${a.model ?? 'model unknown'}`, textW)];
    const statusLen = Math.min(line.length, [...status].length);
    puts.push({ x: tx, y: y0 + 1, attr: a.status === 'running' ? { color: 'green' } : { dim: true }, text: line.slice(0, statusLen).join('') });
    if (line.length > statusLen) puts.push({ x: tx + statusLen, y: y0 + 1, attr: { dim: true }, text: line.slice(statusLen).join('') });
    if (a.description) puts.push({ x: tx, y: y0 + 2, attr: { dim: true }, text: clip(a.description, textW) });
  }
  return { height: HEAD_ROWS + tileRows * TILE_H + Math.max(0, tileRows - 1) * ROW_GAP, puts, pixels };
}
