/** @jsxImportSource @opentui/solid */
// Sterling's dashboard inside OpenCode 2 (decision
// sterling-dashboard-in-opencode-2-is-sidebar-summary-plus-full-view): a
// compact summary in the session sidebar, plus a full-screen route with the
// terminal TUI's four tabs. The route drives the same controller the terminal
// TUI does (packages/tui/src/controller.ts), so reads, the board-item edit and
// the System-tab toggles run the same store and config code in both hosts.
//
// Entry: the `sterling.open` command — <leader>k (ctrl+x then k by default),
// `/sterling`, or the command palette. Its keymap layer is mode "global" and is
// owned by a component in the always-mounted `app` slot. A layer left at the
// default "base" mode did not fire from a physical key or the slash command in
// OpenCode 2.0.21; the built-in stats, diff and plugins commands use this same
// shape. ctrl+g is not used: OpenCode binds it to "Navigate to first message"
// on the session route, where it wins.
import { createSignal, For, Index, Show, untrack } from 'solid-js';
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { openDashboard, type DashboardController } from '@sterling/tui/dist/controller.js';
import { TASKS_TAB, type DashboardState } from '@sterling/tui/dist/state.js';
import { ANIMATION_MS } from '@sterling/tui/dist/avatars/index.js';
import { SIDEBAR_WIDTH, bodyLinesFor, emptyAvatars, escapeLeavesView, findStorePath, guarded, keyToUiEvent, readSidebarSummary, readSubagents, sidebarLines, stepAvatars, subagentSpanLines, type AvatarState, type Guarded, type KeyLike, type ModelRefLike, type Span, type SpanLine, type SubagentRow, type SubagentSession, type TokenUsageLike } from './view.ts';

const ROUTE = 'sterling';
/** OpenCode events that change a sub-agent row: a child appears, starts or ends a run, finishes a step. */
const SUBAGENT_EVENTS = ['session.created', 'session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.step.ended'];
const COMMAND = 'sterling.open';

type Route = { type: string; [k: string]: unknown };
/** The slice of the OpenCode 2 TUI plugin context (@opencode/plugin/tui
 *  Context) this file uses; that package is not a dependency of this repo. */
interface Api {
  /** OpenCode 2's project location; undefined outside a project. */
  location?: { directory: string };
  theme?: { text?: { base?: string; muted?: string }; background?: { base?: string; raised?: { base?: string; high?: string } } };
  keymap: {
    layer(input: () => unknown): void;
    shortcuts(id: string): readonly string[];
    mode: { current(): string };
  };
  ui: {
    dialog: { clear(): void };
    router: { register(page: { name: string; render: () => unknown }): () => void; navigate(to: Route): void; current(): Route };
    slot(claim: { append: string; render: (input: { sessionID: string }) => unknown }): () => void;
  };
  /** OpenCode 2's reactive data layer (context.d.ts Data), the slice the sub-agent rows read. */
  data: {
    on(type: string, handler: () => void): () => void;
    session: {
      list(): SubagentSession[];
      root(sessionID: string): string;
      status(sessionID: string): 'idle' | 'running';
      message: {
        list(sessionID: string): { type: string; model?: ModelRefLike; tokens?: TokenUsageLike }[];
        sync(sessionID: string): Promise<void>;
      };
    };
    location: { model: { list(): { providerID: string; modelID: string; limit: { context: number } }[] } };
  };
}

const [tick, setTick] = createSignal(0);
/** portrait animation clock; advances only while a sub-agent is running (idle portraits sit at frame 0) */
const [frame, setFrame] = createSignal(0);
let anyRunning = false;
const [syncFailure, setSyncFailure] = createSignal<string | undefined>();
/** sub-agent sessions whose messages were requested; a failed request is retried on the next read */
const synced = new Set<string>();
let dashboard: Guarded<DashboardController> | undefined;
/** The project directory setup() resolved: api.location.directory, else process.cwd(). */
let projectDir = process.cwd();

/** The shared controller, opened on first use. A failed open is retried on the
 *  next read, so a store created after OpenCode started is picked up. */
function controller(): Guarded<DashboardController> {
  if (dashboard?.ok) return dashboard;
  const storePath = findStorePath(projectDir, process.env);
  dashboard = storePath
    ? guarded('Sterling store', () => openDashboard(storePath))
    : { ok: false, error: `no .sterling/sterling.db at or above ${projectDir}` };
  return dashboard;
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…';
}

/** Portrait assignment per session tree, kept for the plugin's lifetime: a
 *  sub-agent keeps its portrait while it is in the family and frees it on leaving. */
const avatarStates = new Map<string, AvatarState>();
/** sub-agent rows and portraits per session, computed once per 1 Hz tick however many views draw them */
const blockCache = new Map<string, { at: number; value: Guarded<{ rows: SubagentRow[]; avatars: AvatarState }> }>();

/** The sub-agent rows and portrait assignment for the tree under `sessionID`.
 *  Message history is not loaded until asked for, so each new child's is
 *  requested once; the rows then follow OpenCode's own events. */
function subagentData(api: Api, sessionID: string): Guarded<{ rows: SubagentRow[]; avatars: AvatarState }> {
  const at = tick();
  const hit = blockCache.get(sessionID);
  if (hit && hit.at === at) return hit.value;
  const value = guarded('sub-agents', () => {
    const d = api.data;
    const rootID = d.session.root(sessionID);
    const rows = readSubagents({
      sessions: d.session.list(),
      rootID,
      isRunning: (id) => d.session.status(id) === 'running',
      lastTurn: (id) => {
        if (!synced.has(id)) {
          synced.add(id);
          d.session.message.sync(id).then(
            () => setSyncFailure(undefined),
            (err: unknown) => {
              synced.delete(id);
              setSyncFailure(`messages unavailable — ${(err as Error)?.message ?? String(err)}`);
            },
          );
        }
        const turn = d.session.message.list(id).findLast((m) => m.type === 'assistant' && m.tokens);
        return turn && { tokens: turn.tokens, model: turn.model };
      },
      contextLimit: (m) => d.location.model.list().find((x) => x.providerID === m.providerID && x.modelID === m.id)?.limit.context,
    });
    const avatars = stepAvatars(avatarStates.get(rootID) ?? emptyAvatars(), rows.map((r) => r.id), Math.random);
    avatarStates.set(rootID, avatars);
    return { rows, avatars };
  });
  blockCache.set(sessionID, { at, value });
  return value;
}

/** The sub-agent block as styled lines. Reading `frame` makes the caller
 *  redraw at the portrait rate, and only this composition reruns then. */
function subagentBlock(api: Api, sessionID: string, width: number): SpanLine[] {
  const frameNow = frame();
  const block = subagentData(api, sessionID);
  anyRunning = block.ok && block.value.rows.some((r) => r.status === 'active');
  const lines: SpanLine[] = block.ok ? subagentSpanLines(block.value.rows, block.value.avatars.current, frameNow, width) : [[{ text: clip(`! ${block.error}`, width) }]];
  const failure = syncFailure();
  return failure ? [...lines, [{ text: clip(`! ${failure}`, width) }]] : lines;
}

/** The colours a styled line resolves its unset and muted spans to. A span
 *  that leaves fg or bg undefined kept the previous frame's colour in
 *  OpenCode 2.0.21 (a portrait left stray tinted cells), so every span is
 *  drawn with explicit colours: unset means the surface the line sits on. */
interface Palette {
  text: string | undefined;
  muted: string | undefined;
  surface: string | undefined;
}

/** One styled line: a text node with a span per colour run. */
function StyledLine(props: { spans: Span[]; palette: Palette }) {
  return (
    <text>
      <Index each={props.spans.length ? props.spans : [{ text: ' ' }]}>
        {(sp) => <span style={{ fg: sp().dim ? props.palette.muted : (sp().fg ?? props.palette.text), bg: sp().bg ?? props.palette.surface }}>{sp().text}</span>}
      </Index>
    </text>
  );
}

function Commands(props: { api: Api; open: () => void }) {
  props.api.keymap.layer(() => ({
    mode: 'global',
    commands: [{ id: COMMAND, title: 'Open Sterling dashboard', group: 'Sterling', bind: '<leader>k', palette: true, slash: { name: 'sterling' }, run: props.open }],
  }));
  return null;
}

function Sidebar(props: { api: Api; sessionID: string }) {
  const muted = () => props.api.theme?.text?.muted;
  const palette = (): Palette => ({ text: props.api.theme?.text?.base, muted: muted(), surface: props.api.theme?.background?.raised?.base });
  const lines = () => {
    tick();
    const c = controller();
    if (!c.ok) return { title: 'Sterling', body: [clip(`! ${c.error}`, SIDEBAR_WIDTH)] };
    const s = guarded('board', () => readSidebarSummary(c.value.store));
    if (!s.ok) return { title: clip(`Sterling · ${c.value.projectName}`, SIDEBAR_WIDTH), body: [clip(`! ${s.error}`, SIDEBAR_WIDTH)] };
    return { title: clip(`Sterling · ${c.value.projectName}`, SIDEBAR_WIDTH), body: sidebarLines(s.value, SIDEBAR_WIDTH) };
  };
  const hint = () => clip(`${props.api.keymap.shortcuts(COMMAND)[0] ?? '<leader>k'} or /sterling: full view`, SIDEBAR_WIDTH);
  return (
    <box flexDirection="column" paddingTop={1}>
      <text>{lines().title}</text>
      <For each={lines().body}>{(l) => <text>{l}</text>}</For>
      <Index each={subagentBlock(props.api, props.sessionID, SIDEBAR_WIDTH)}>{(l) => <StyledLine spans={l()} palette={palette()} />}</Index>
      <text fg={muted()}>{hint()}</text>
    </box>
  );
}

interface Painted {
  text: string;
  selected?: boolean;
  dim?: boolean;
}

/** What the full view draws below the board body and the sub-agent block: the notice row (blank when there is none), the footer. */
const footerLines = (st: DashboardState): Painted[] => [{ text: st.notice ?? '' }, { text: st.footer, dim: true }];

/** Flatten a DashboardState into display lines the way render.ts paints it:
 *  header, tab bar, search/spacer, the scrolled body window, the queue tab's
 *  completed and activity sections, the footer. */
function paint(st: DashboardState, maxBodyLines: number): { header: string; tabs: { label: string; active: boolean }[]; lines: Painted[]; footer: Painted[] } {
  const lines: Painted[] = [{ text: st.searchLine ?? '', dim: true }];
  if (st.emptyMessage) lines.push({ text: st.emptyMessage, dim: true });
  const body: Painted[] = [];
  let idx = 0;
  for (const row of st.rows) {
    for (const line of row.lines) {
      if (idx++ < st.scroll) continue;
      body.push({ text: line.text, selected: line.kind === 'title' && row.selected, dim: line.kind === 'meta' });
    }
  }
  const qc = st.queueCompleted;
  if (qc) {
    const pending = body.slice(0, qc.startRow);
    while (pending.length < qc.startRow) pending.push({ text: '' });
    if (qc.overflow) pending[pending.length - 1] = { text: qc.overflow, dim: true };
    lines.push(...pending, { text: qc.header, dim: true }, ...qc.lines.map((text) => ({ text, dim: true })));
    if (st.queueActivity) lines.push({ text: st.queueActivity.header, dim: true }, ...st.queueActivity.lines.map((text) => ({ text, dim: true })));
  } else {
    lines.push(...body.slice(0, maxBodyLines));
  }
  return { header: st.projectName, tabs: st.tabs, lines, footer: footerLines(st) };
}

function FullView(props: { api: Api; sessionID: () => string | undefined; close: () => void }) {
  const dims = useTerminalDimensions();
  const [version, setVersion] = createSignal(0);
  const [failure, setFailure] = createSignal<string | undefined>();
  const muted = () => props.api.theme?.text?.muted;
  const highlight = () => props.api.theme?.background?.raised?.high;
  const palette = (): Palette => ({ text: props.api.theme?.text?.base, muted: muted(), surface: props.api.theme?.background?.base });
  const width = () => Math.max(20, dims().width - 2);
  /** the sub-agent block sits under the Tasks tab's board rows, for the session the view was opened from */
  const subagentSession = () => {
    const c = controller();
    const sid = props.sessionID();
    return sid && c.ok && c.value.ui().tab === TASKS_TAB ? sid : undefined;
  };
  /** the block's lines under the body: a blank line, then the block (its height does not change with the animation frame) */
  const extraHeight = () => {
    const sid = subagentSession();
    return sid ? 1 + untrack(() => subagentBlock(props.api, sid, width()).length) : 0;
  };
  // header, tab bar, spacer, then the body; three lines below it: blank, footer, Esc hint.
  // The controller's scroll window must be as short as the body really is, or the cursor can fall below it.
  const viewport = () => ({ width: width(), maxBodyLines: bodyLinesFor(dims().height, extraHeight()), showBanner: false });
  const extra = () => {
    tick();
    version();
    const sid = subagentSession();
    return sid ? subagentBlock(props.api, sid, width()) : [];
  };
  const view = () => {
    tick();
    version();
    const c = controller();
    if (!c.ok) return { ok: false as const, error: c.error };
    const st = guarded('dashboard', () => c.value.state(viewport()));
    if (!st.ok) return { ok: false as const, error: st.error };
    return { ok: true as const, ...paint(st.value, viewport().maxBodyLines) };
  };

  useKeyboard((key: KeyLike & { eventType?: string; defaultPrevented?: boolean; preventDefault?: () => void }) => {
    // a dialog or the command palette owns the keys while it is open
    if (props.api.keymap.mode.current() !== 'base') return;
    // One press, one event: in 2.0.21 each key reached this handler twice (a
    // Right arrow moved two tabs), so a key already handled is skipped.
    if (key.eventType === 'release' || key.defaultPrevented) return;
    key.preventDefault?.();
    const c = controller();
    if (key.name === 'escape' && (!c.ok || escapeLeavesView(c.value.ui()))) {
      props.close();
      return;
    }
    if (!c.ok) return;
    const event = keyToUiEvent(key);
    if (!event) return;
    c.value.handle(event, viewport()).then(
      (quit) => {
        setFailure(undefined);
        if (quit) props.close();
        setVersion((v) => v + 1);
      },
      (err: unknown) => {
        // P5: a write that throws (a lost-update race, a locked store) is shown, never swallowed
        setFailure(`! ${(err as Error)?.message ?? String(err)}`);
        setVersion((v) => v + 1);
      },
    );
  });
  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1}>
      <Show when={view().ok} fallback={<text>{`Sterling: ${(view() as { error: string }).error}`}</text>}>
        <text>{(view() as { header: string }).header}</text>
        <box flexDirection="row">
          <For each={(view() as { tabs: { label: string; active: boolean }[] }).tabs}>
            {(t) => <text bg={t.active ? highlight() : undefined}>{` ${t.active ? '▸' : ' '}${t.label} `}</text>}
          </For>
        </box>
        <For each={(view() as { lines: Painted[] }).lines}>
          {(l) => <text fg={l.dim ? muted() : undefined} bg={l.selected ? highlight() : undefined}>{l.text || ' '}</text>}
        </For>
        <Show when={extra().length}>
          <text> </text>
          <Index each={extra()}>{(l) => <StyledLine spans={l()} palette={palette()} />}</Index>
        </Show>
        <For each={(view() as { footer: Painted[] }).footer}>
          {(l) => <text fg={l.dim ? muted() : undefined}>{l.text || ' '}</text>}
        </For>
      </Show>
      <Show when={failure()}>
        <text>{failure()}</text>
      </Show>
      <text fg={muted()}>Esc: back</text>
    </box>
  );
}

export default {
  id: 'sterling.dashboard',
  setup(api: Api) {
    // Outside a Sterling project the plugin is a no-op: no slot, command or route.
    const dir = api.location?.directory ?? process.cwd();
    if (!findStorePath(dir, process.env)) return () => {};
    projectDir = dir;
    let back: Route = { type: 'home' };
    const open = () => {
      const current = api.ui.router.current();
      if (current.type === 'plugin' && current.name === ROUTE) return;
      back = { ...current };
      api.ui.dialog.clear();
      api.ui.router.navigate({ type: 'plugin', name: ROUTE });
    };
    const disposers = [
      api.ui.slot({ append: 'app', render: () => <Commands api={api} open={open} /> }),
      api.ui.slot({ append: 'sidebar.content', render: (input) => <Sidebar api={api} sessionID={input.sessionID} /> }),
      api.ui.router.register({
        name: ROUTE,
        render: () => <FullView api={api} sessionID={() => (back.type === 'session' ? (back.sessionID as string) : undefined)} close={() => api.ui.router.navigate(back)} />,
      }),
      ...SUBAGENT_EVENTS.map((type) => api.data.on(type, () => setTick((n) => n + 1))),
    ];
    // a live view over the durable store, like the terminal TUI's 1 Hz redraw
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    // the portraits move at about 3 Hz, and only while a sub-agent is running
    const animation = setInterval(() => {
      if (anyRunning) setFrame((n) => n + 1);
    }, ANIMATION_MS);
    return () => {
      clearInterval(timer);
      clearInterval(animation);
      for (const dispose of disposers) dispose();
      if (dashboard?.ok) dashboard.value.close();
      dashboard = undefined;
    };
  },
};
