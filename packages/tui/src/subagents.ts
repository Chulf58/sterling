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
// The current session: H1 writes .sterling/transient/session.json at every
// SessionStart. A second session started in the same worktree overwrites that
// file, and the session that wrote it last is not necessarily the one doing
// the work, so session.json cannot be trusted to hide a live agent: a live row
// is listed whatever its session (a row from a session other than session.json's
// is counted in `foreignLive`, which the Agents tab announces). The session
// filter stays for ended rows: in the current session an ended agent stays
// listed as `resumable` for as long as the session lasts (the host resumes a
// subagent only inside the session that started it), with its idle time and
// the context a resume would re-send; an ended row from another session is not
// listed. Without a readable session.json nothing can be told apart by
// session, so the old rule holds: ended rows linger DONE_LINGER_MS as `done`.
//
// Live means a register row with no `ended`. An H10 residue stamp is only a
// guess that the agent is gone (it stamps any row older than an hour with no
// file touches, and a long read-only agent touches nothing), so a stamped row
// with no `ended` is unconfirmed and its own transcript decides: it is ended
// at the stamp when the transcript ends on the agent's handback (the
// tool_result Claude Code writes with toolEndsTurn: true), running while the
// transcript was written within TRANSCRIPT_ALIVE_MS, and `quiet` otherwise.
// Quiet means unknown: a live agent inside one long tool call writes nothing,
// and an agent that ended with a plain reply or was killed leaves no marker,
// so a quiet row is listed and counted as quiet, apart from the running
// count (the tab header shows both), and never dropped as done. H1 deletes the register at every SessionStart, which bounds how long
// a dead agent can sit there as quiet. A resumed agent keeps its
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
import { deriveAgentTranscript, fillPct, latestUsage, readTail } from '../../../scripts/hooks/lib/transcript.mjs';
import { sterlingRootFrom } from '../../../scripts/lib/opencode-install.mjs';
import { assign, frameAt, phaseFor, tileCells, POOL_SIZE, SPRITE_ROWS, TILE_COLS, DONE_FADE, fadeToTile, type AssignState } from './avatars/index.js';
import { NEON_EDGE } from './theme.js';

/** How long a missing subagent transcript is left unsearched before the next look. */
const TRANSCRIPT_RETRY_MS = 10_000;

/** How recently a subagent's transcript must have been written for an H10
 *  residue-stamped row to count as still running. A working agent writes a
 *  transcript line per tool call and per reply; past this window with no end
 *  marker the row is quiet, not done. */
export const TRANSCRIPT_ALIVE_MS = 10 * 60_000;

/** How much of a transcript's end is read first for the handback marker: the
 *  marker line is small, and only hook attachments follow it. A hook
 *  attachment can itself be longer than this, so a window holding no whole
 *  user or assistant entry is read again at the shared 1 MiB tail. */
const END_MARKER_TAIL_BYTES = 64 * 1024;

/** How long an ended agent stays in the block, shown as done, when the current session is unknown. */
export const DONE_LINGER_MS = 5 * 60_000;

export type RegisterAvailability = 'ok' | 'absent' | 'corrupt';

export interface SubagentRow {
  agentId: string;
  /** the latest round's session, which names the transcript directory */
  sessionId: string;
  agentType: string | null;
  /** done is the fallback for an ended row when the current session is unknown;
   *  quiet is a residue-stamped row whose transcript neither ended nor was written lately */
  status: 'running' | 'quiet' | 'resumable' | 'done';
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
  /** listed running or quiet rows whose session is not the one session.json names; always 0 when session.json is unreadable */
  foreignLive: number;
}

function roundOf(e: RegisterEntry): number {
  return typeof e.round === 'number' ? e.round : 1;
}

/** The current session id from H1's session.json; null when the file is
 *  missing, unreadable or names no session. scripts/ cannot be imported here
 *  for this one function's sake (readSessionId in dispatch-register.mjs reads
 *  the same file the same way), and a degraded read is announced by the
 *  fallback rule in readSubagents, not hidden. */
export function readCurrentSessionId(projectRoot: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(projectRoot, '.sterling', 'transient', 'session.json'), 'utf8')) as { session_id?: unknown };
    return typeof parsed?.session_id === 'string' && parsed.session_id ? parsed.session_id : null;
  } catch {
    return null;
  }
}

/** Read the register and reduce it to one row per agent_id, the latest round
 *  deciding. With the current session known: every live row, whatever its
 *  session (counted in foreignLive when it is not the current one), and an
 *  ended row only from that session; a round with a real `ended` is resumable
 *  with no time limit. With it unknown: every
 *  row, an ended one done for lingerMs. H10 stamps residue_reported_at on a row
 *  it guesses is gone, with no stop event: the stamp is unconfirmed, so the
 *  row's transcript decides (transcriptState). A handback marker makes the
 *  stamp the end (done, lingering lingerMs, never resumable, since nothing
 *  shows such a subagent can be resumed); a recent write keeps it running;
 *  anything else is quiet, listed with no time limit like a running row but
 *  left out of the running count. A real `ended` always ends the row. */
export function readSubagents(projectRoot: string, now: number, lingerMs = DONE_LINGER_MS, claudeConfigDir = defaultClaudeConfigDir()): SubagentSource {
  const reg = readRegister(projectRoot);
  if (reg.availability !== 'ok') return { availability: reg.availability, rows: [], foreignLive: 0 };
  const currentSession = readCurrentSessionId(projectRoot);
  const byAgent = new Map<string, RegisterEntry[]>();
  for (const e of reg.entries) {
    const list = byAgent.get(e.agent_id) ?? [];
    list.push(e);
    byAgent.set(e.agent_id, list);
  }
  const rows: SubagentRow[] = [];
  let foreignLive = 0;
  for (const [agentId, rounds] of byAgent) {
    rounds.sort((a, b) => roundOf(b) - roundOf(a) || Date.parse(b.at) - Date.parse(a.at));
    const latest = rounds[0]!;
    const transcript = !latest.ended && latest.residue_reported_at ? transcriptState(projectRoot, latest.session_id, latest.agent_id, now, claudeConfigDir) : null;
    const foreign = currentSession !== null && latest.session_id !== currentSession;
    if (foreign && (latest.ended || transcript === 'finished')) continue;
    const startedAt = Date.parse(latest.at);
    if (Number.isNaN(startedAt)) continue;
    const endStamp = latest.ended ? latest.ended.at : transcript === 'finished' ? String(latest.residue_reported_at) : null;
    const endedAt = endStamp === null ? null : Date.parse(endStamp);
    // only a real stop event shows a subagent can be resumed; a residue stamp does not
    const resumable = currentSession !== null && Boolean(latest.ended);
    if (endedAt !== null && (Number.isNaN(endedAt) || (!resumable && now - endedAt > lingerMs))) continue;
    const withId = rounds.find((r) => typeof r.tool_use_id === 'string' && r.tool_use_id !== '');
    if (foreign && endedAt === null) foreignLive++;
    rows.push({
      agentId,
      sessionId: latest.session_id,
      agentType: typeof latest.agent_type === 'string' && latest.agent_type ? latest.agent_type : null,
      status: transcript === 'quiet' ? 'quiet' : endedAt === null ? 'running' : resumable ? 'resumable' : 'done',
      startedAt,
      endedAt,
      elapsedMs: Math.max(0, (endedAt ?? now) - startedAt),
      toolUseId: (withId?.tool_use_id as string | undefined) ?? null,
    });
  }
  // running, then quiet (both oldest start first), then ended rows, newest ended first
  const rank = (r: SubagentRow): number => (r.status === 'running' ? 0 : r.status === 'quiet' ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || (rank(a) < 2 ? a.startedAt - b.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0)));
  return { availability: 'ok', rows, foreignLive };
}

/** What a residue-stamped row's own transcript shows: finished when it ends
 *  on the agent's handback, fresh when it was written within
 *  TRANSCRIPT_ALIVE_MS of now, quiet otherwise (a missing or unreadable
 *  transcript included, since it proves nothing either way). */
function transcriptState(projectRoot: string, sessionId: string, agentId: string, now: number, claudeConfigDir: string): 'finished' | 'fresh' | 'quiet' {
  const path = subagentTranscriptPath(projectRoot, sessionId, agentId, claudeConfigDir);
  if (!path) return 'quiet';
  try {
    if (endsOnHandback(path)) return 'finished';
    return now - statSync(path).mtimeMs <= TRANSCRIPT_ALIVE_MS ? 'fresh' : 'quiet';
  } catch {
    return 'quiet';
  }
}

/** Whether the transcript's last user or assistant entry carries
 *  toolEndsTurn: true. Claude Code writes that field on the tool_result of a
 *  tool that ends the agent's turn (SubagentHandback), and only hook
 *  attachments follow it; a resumed round appends a new user entry after it.
 *  An agent that ends with a plain reply has no such entry. */
export function endsOnHandback(path: string): boolean {
  const entry = lastTurnEntry(readTail(path, END_MARKER_TAIL_BYTES)) ?? lastTurnEntry(readTail(path));
  return entry?.toolEndsTurn === true;
}

/** The last whole user or assistant entry in a tail window, or undefined when
 *  the window holds none. */
function lastTurnEntry(tail: string | null): { toolEndsTurn?: unknown } | undefined {
  const lines = (tail ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: unknown; toolEndsTurn?: unknown } | null;
    try {
      entry = JSON.parse(lines[i]!) as typeof entry;
    } catch {
      continue; // a blank line, or the tail window's truncated first line
    }
    if (entry?.type === 'user' || entry?.type === 'assistant') return entry;
  }
  return undefined;
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
  status: SubagentRow['status'];
  elapsedMs: number;
  /** context fill, or null while unknown */
  contextPct: number | null;
  /** tokens in context at the transcript's latest turn (what a resume re-sends), or null while unknown */
  contextTokens: number | null;
  /** time since the agent ended; null while it runs */
  idleMs: number | null;
}

export interface SubagentView {
  availability: RegisterAvailability;
  /** running agents: the transcript was written within TRANSCRIPT_ALIVE_MS, or the row is unstamped */
  active: number;
  /** quiet agents: listed and maybe live, but silent with no handback; unset reads as 0 */
  quiet?: number;
  agents: SubagentAgentView[];
  /** listed live agents from a session other than the one session.json names; unset reads as 0 */
  foreignLive?: number;
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
  let source: SubagentSource = { availability: 'absent', rows: [], foreignLive: 0 };
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
  let context = new Map<string, { model: string | null; pct: number | null; tokens: number | null }>();

  const keyOf = (r: SubagentRow): string => `${r.sessionId}\0${r.agentId}`;

  function contextOf(r: SubagentRow, windows: Record<string, number>, now: number): { model: string | null; pct: number | null; tokens: number | null } {
    const key = keyOf(r);
    let path = transcripts.get(key);
    if (!path && now >= (missing.get(key) ?? -Infinity)) {
      path = subagentTranscriptPath(projectRoot, r.sessionId, r.agentId, claudeConfigDir) ?? undefined;
      if (path) {
        transcripts.set(key, path);
        missing.delete(key);
      } else missing.set(key, now + TRANSCRIPT_RETRY_MS);
    }
    if (!path) return { model: null, pct: null, tokens: null };
    let stamp: string;
    try {
      const st = statSync(path);
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      return { model: null, pct: null, tokens: null };
    }
    let cached = usage.get(r.agentId);
    if (cached?.stamp !== stamp) {
      cached = { stamp, value: readContextUsage(path) };
      usage.set(r.agentId, cached);
    }
    const u = cached.value;
    if (!u) return { model: null, pct: null, tokens: null };
    const model = u.model ?? (r.agentType ? models.get(r.agentType) ?? null : null);
    const window = model ? contextWindowFor(model, windows, sharedWindows) : null;
    return { model: u.model, pct: window ? contextPercent(u.tokens, window) : null, tokens: u.tokens };
  }

  function refresh(now: number): void {
    lastRead = now;
    source = readSubagents(projectRoot, now, lingerMs, claudeConfigDir);
    // a corrupt read leaves the assignment alone, so faces do not reshuffle
    if (source.availability === 'corrupt') return;
    avatars = assign(source.rows.map((r) => r.agentId), avatars.current, rng, { poolSize: POOL_SIZE, freed: avatars.freed });
    models = new Map();
    for (const r of source.rows) {
      // a cached miss is final for an ended row; a running row's record may not have its new name yet,
      // and a resumed agent running again drops the miss cached while it was resumable
      if (r.toolUseId && (!descriptions.has(r.toolUseId) || (r.status === 'running' && descriptions.get(r.toolUseId) === null))) {
        const d = readDispatchDescription(projectRoot, r.toolUseId);
        if (d !== null || r.status !== 'running') descriptions.set(r.toolUseId, d);
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
        elapsedMs: r.endedAt === null ? Math.max(0, now - r.startedAt) : r.elapsedMs,
        contextPct: context.get(r.agentId)?.pct ?? null,
        contextTokens: context.get(r.agentId)?.tokens ?? null,
        idleMs: r.endedAt === null ? null : Math.max(0, now - r.endedAt),
      }));
      return {
        availability: source.availability,
        active: agents.filter((a) => a.status === 'running').length,
        quiet: agents.filter((a) => a.status === 'quiet').length,
        agents,
        foreignLive: source.foreignLive,
      };
    },
  };
}

/** Compact time since an agent ended: 45s, 12m, 2h 05m. */
export function formatIdle(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function formatTokens(tokens: number | null): string {
  if (tokens === null) return '?';
  return tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000)}k`;
}

/** The status line of a resumable card: the fullest of these that fits the text block. */
function resumableStatus(a: SubagentView['agents'][number], width: number): string {
  const idle = formatIdle(a.idleMs ?? 0);
  const tokens = formatTokens(a.contextTokens);
  const pct = a.contextPct === null ? [] : [`resumable · idle ${idle} · ${tokens} ctx (${a.contextPct}%)`];
  const forms = [...pct, `resumable · idle ${idle} · ${tokens} ctx`, `resumable ${idle} · ${tokens} ctx`, `resumable ${idle} · ${tokens}`, `resumable ${idle}`];
  return forms.find((f) => [...f].length <= width) ?? forms[forms.length - 1]!;
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
// the renderer puts at the top of the Agents tab's body. Each card is the 8x3
// portrait tile with the text lines (type, `status · N% ctx` or, resumable, `resumable · idle 12m · 78k ctx`, model,
// description) to its right, one column apart, so a card is 3-4 rows tall.
// The pane's width is shared evenly by as many cards as fit side by side at
// SIDE_MIN_W columns each, wrapping to the next band when there are more; the
// text is clipped to its own block only. A pane narrower than SIDE_MIN_W falls
// back to the stacked card: the tile with the text lines below it, 24 columns.
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
/** the stacked card's width, and the narrowest text block a side-by-side card gets */
const CARD_W = 24;
/** a stacked card: the tile, then four text lines */
const CARD_H = TILE_H + 4;
/** columns between the tile and its text */
const TILE_GAP = 1;
/** the narrowest side-by-side card: the tile, the gap and CARD_W columns of text */
const SIDE_MIN_W = TILE_COLS + TILE_GAP + CARD_W;
const CARD_GAP = 2;
const ROW_GAP = 1;

function clip(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  return width <= 1 ? chars.slice(0, width).join('') : chars.slice(0, width - 1).join('') + '…';
}

/** The cards, then, when running or quiet agents come from a session other than the one
 *  session.json names, one dim line under them saying so (dropped when there
 *  is no room: the cards win). neonEdge draws each tile's status edge
 *  (theme.ts NEON_EDGE: running cyan, quiet amber, resumable pink, done muted). */
export function composeSubagentBlock(view: SubagentView, width: number, maxHeight: number, tick: number, opts: { neonEdge?: boolean } = {}): SubagentBlock {
  const cards = composeCards(view, width, maxHeight, tick, opts.neonEdge === true);
  if (!view.foreignLive || cards.height + 1 > maxHeight) return cards;
  if (cards.height === 0 && width < 1) return cards;
  const put: BlockPut = { x: 0, y: cards.height, attr: { dim: true }, text: clip(FOREIGN_SESSION_NOTE, width) };
  return { ...cards, height: cards.height + 1, puts: [...cards.puts, put] };
}

const FOREIGN_SESSION_NOTE = 'session.json names another session; running and quiet agents from the other one are listed';

/** Lay the cards out in at most maxHeight rows of a width-column area. A readable
 *  register with no agents draws one dim line, so the tab is never blank. */
function composeCards(view: SubagentView, width: number, maxHeight: number, tick: number, neonEdge: boolean): SubagentBlock {
  const empty: SubagentBlock = { height: 0, puts: [], pixels: [] };
  if (maxHeight < 1 || width < 1) return empty;
  const note = (text: string): SubagentBlock => ({ height: 1, puts: [{ x: 0, y: 0, attr: { dim: true }, text: clip(text, width) }], pixels: [] });
  if (view.availability === 'corrupt') return note('Sub-agents: unknown — the dispatch register could not be read');
  if (view.agents.length === 0) return note('(no sub-agents)');

  // side by side when a pane holds one card at SIDE_MIN_W; the cards then share the row evenly
  const side = width >= SIDE_MIN_W;
  const perRow = side
    ? Math.min(view.agents.length, Math.floor((width + CARD_GAP) / (SIDE_MIN_W + CARD_GAP)))
    : 1;
  const cardW = side ? Math.floor((width - (perRow - 1) * CARD_GAP) / perRow) : Math.min(CARD_W, width);
  const textW = side ? cardW - TILE_COLS - TILE_GAP : cardW;
  const textLines = (a: SubagentView['agents'][number]): number => (a.description ? 4 : 3);
  // a band is a row of cards: as tall as its tallest card
  const bandH = (first: number): number =>
    side ? Math.max(...view.agents.slice(first, first + perRow).map((a) => Math.max(TILE_H, textLines(a)))) : CARD_H;
  const bandY: number[] = [];
  let used = 0;
  for (let first = 0; first < view.agents.length; first += perRow) {
    const y = bandY.length === 0 ? 0 : used + ROW_GAP;
    if (y + bandH(first) > maxHeight) break;
    bandY.push(y);
    used = y + bandH(first);
  }
  const cardRows = bandY.length;
  if (cardRows === 0) return note(`${view.agents.length} sub-agents, no room to show them`);
  const shown = Math.min(view.agents.length, cardRows * perRow);
  const hidden = view.agents.length - shown;

  const puts: BlockPut[] = [];
  const pixels: BlockPixel[] = [];
  for (let i = 0; i < shown; i++) {
    const a = view.agents[i]!;
    const done = a.status !== 'running';
    const x0 = (i % perRow) * (cardW + CARD_GAP);
    const y0 = bandY[Math.floor(i / perRow)]!;
    // the tile: every cell carries a bg, so the tint covers the padding and the transparent pixels.
    // A done agent rests on frame 0 and its portrait is faded, its edge with it.
    tileCells(a.avatar, frameAt(tick, phaseFor(a.avatar), !done), neonEdge ? NEON_EDGE[a.status] : undefined).forEach((line, r) =>
      line.forEach((cell, c) => {
        const px: BlockPixel = { x: x0 + c, y: y0 + r, ch: cell.ch };
        if (cell.fg !== undefined) px.fg = done ? fadeToTile(cell.fg, DONE_FADE) : cell.fg;
        if (cell.bg !== undefined) px.bg = done ? fadeToTile(cell.bg, DONE_FADE) : cell.bg;
        pixels.push(px);
      }),
    );
    // side by side the text starts right of the tile on the tile's top row; stacked it starts under the tile
    const tx = side ? x0 + TILE_COLS + TILE_GAP : x0;
    const ty = side ? y0 : y0 + TILE_H;
    puts.push({ x: tx, y: ty, attr: done ? { bold: true, dim: true } : { bold: true }, text: clip(a.type, textW) });
    const status = a.status === 'resumable' ? resumableStatus(a, textW) : `${a.status} · ${a.contextPct === null ? '?' : `${a.contextPct}%`} ctx`;
    // quiet is unknown, not done: its status line is yellow, apart from both green and dim
    puts.push({ x: tx, y: ty + 1, attr: a.status === 'quiet' ? { color: 'yellow' } : done ? { dim: true } : { color: 'green' }, text: clip(status, textW) });
    puts.push({ x: tx, y: ty + 2, attr: { dim: true }, text: clip(a.model ?? 'model unknown', textW) });
    if (a.description) puts.push({ x: tx, y: ty + 3, attr: { dim: true }, text: clip(a.description, textW) });
  }
  const height = used;
  if (hidden > 0 && height + 1 <= maxHeight) {
    puts.push({ x: 0, y: height, attr: { dim: true }, text: clip(`${hidden} more not shown`, width) });
    return { height: height + 1, puts, pixels };
  }
  return { height, puts, pixels };
}
