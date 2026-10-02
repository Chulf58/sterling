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
import { createSignal, For, Show } from 'solid-js';
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { openDashboard, type DashboardController } from '@sterling/tui/dist/controller.js';
import type { DashboardState } from '@sterling/tui/dist/state.js';
import { SIDEBAR_WIDTH, escapeLeavesView, findStorePath, guarded, keyToUiEvent, readSidebarSummary, sidebarLines, type Guarded, type KeyLike } from './view.ts';

const ROUTE = 'sterling';
const COMMAND = 'sterling.open';

type Route = { type: string; [k: string]: unknown };
/** The slice of the OpenCode 2 TUI plugin context (@opencode/plugin/tui
 *  Context) this file uses; that package is not a dependency of this repo. */
interface Api {
  theme?: { text?: { muted?: string }; background?: { raised?: { high?: string } } };
  keymap: {
    layer(input: () => unknown): void;
    shortcuts(id: string): readonly string[];
    mode: { current(): string };
  };
  ui: {
    dialog: { clear(): void };
    router: { register(page: { name: string; render: () => unknown }): () => void; navigate(to: Route): void; current(): Route };
    slot(claim: { append: string; render: (input: unknown) => unknown }): () => void;
  };
}

const [tick, setTick] = createSignal(0);
let dashboard: Guarded<DashboardController> | undefined;

/** The shared controller, opened on first use. A failed open is retried on the
 *  next read, so a store created after OpenCode started is picked up. */
function controller(): Guarded<DashboardController> {
  if (dashboard?.ok) return dashboard;
  const storePath = findStorePath(process.cwd(), process.env);
  dashboard = storePath
    ? guarded('Sterling store', () => openDashboard(storePath))
    : { ok: false, error: `no .sterling/sterling.db at or above ${process.cwd()}` };
  return dashboard;
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…';
}

function Commands(props: { api: Api; open: () => void }) {
  props.api.keymap.layer(() => ({
    mode: 'global',
    commands: [{ id: COMMAND, title: 'Open Sterling dashboard', group: 'Sterling', bind: '<leader>k', palette: true, slash: { name: 'sterling' }, run: props.open }],
  }));
  return null;
}

function Sidebar(props: { api: Api }) {
  const muted = () => props.api.theme?.text?.muted;
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
      <text fg={muted()}>{hint()}</text>
    </box>
  );
}

interface Painted {
  text: string;
  selected?: boolean;
  dim?: boolean;
}

/** Flatten a DashboardState into display lines the way render.ts paints it:
 *  header, tab bar, search/spacer, the scrolled body window, the queue tab's
 *  completed and activity sections, the footer. */
function paint(st: DashboardState, maxBodyLines: number): { header: string; tabs: { label: string; active: boolean }[]; lines: Painted[] } {
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
  lines.push({ text: '' }, { text: st.footer, dim: true });
  return { header: st.projectName, tabs: st.tabs, lines };
}

function FullView(props: { api: Api; close: () => void }) {
  const dims = useTerminalDimensions();
  const [version, setVersion] = createSignal(0);
  const [failure, setFailure] = createSignal<string | undefined>();
  const muted = () => props.api.theme?.text?.muted;
  const highlight = () => props.api.theme?.background?.raised?.high;
  // header, tab bar, spacer, then the body; three lines below it: blank, footer, Esc hint
  const viewport = () => ({ width: Math.max(20, dims().width - 2), maxBodyLines: Math.max(3, dims().height - 8), showBanner: false });
  const view = () => {
    tick();
    version();
    const c = controller();
    if (!c.ok) return { ok: false as const, error: c.error };
    const st = guarded('dashboard', () => c.value.state(viewport()));
    return st.ok ? { ok: true as const, ...paint(st.value, viewport().maxBodyLines) } : { ok: false as const, error: st.error };
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
      api.ui.slot({ append: 'sidebar.content', render: () => <Sidebar api={api} /> }),
      api.ui.router.register({ name: ROUTE, render: () => <FullView api={api} close={() => api.ui.router.navigate(back)} /> }),
    ];
    // a live view over the durable store, like the terminal TUI's 1 Hz redraw
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      clearInterval(timer);
      for (const dispose of disposers) dispose();
      if (dashboard?.ok) dashboard.value.close();
      dashboard = undefined;
    };
  },
};
