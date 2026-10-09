// The synthwave theme (decision tui-synthwave-theme-sunset-banner-project-name-on-horizon):
// level detection, the plain level keeping the attributes from before the theme,
// the coloured levels' attributes, the sunset banner's layout with the project
// name on its horizon, and the overlay's page background.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectThemeLevel, themeFor, PLAIN_THEME, THEME_ENV, XTERM, PALETTE, NEON_EDGE, type Theme } from '../theme.js';
import { scenePixels, sceneText, sceneLayout, horizonLabel, bannerLines, FULL_SCENE_ROWS, COMPACT_SCENE_ROWS, ART_WIDTH, BANNER_ROWS } from '../banner.js';
import { draw, paintPixels, clearPixels, type AttrLike } from '../render.js';
import { composeSubagentBlock, type SubagentView } from '../subagents.js';
import { tileCells, TILE_BG, TILE_COLS, fadeToTile, DONE_FADE } from '../avatars/index.js';
import type { DashboardState } from '../state.js';

test('detectThemeLevel: the env override wins, then NO_COLOR, then truecolour signals, then 256, else 16', () => {
  assert.equal(detectThemeLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' }), 'plain', 'NO_COLOR beats truecolour support');
  assert.equal(detectThemeLevel({ NO_COLOR: '' , TERM: 'xterm' }), '16', 'an empty NO_COLOR is not set');
  assert.equal(detectThemeLevel({ [THEME_ENV]: '256', NO_COLOR: '1' }), '256', 'the override beats NO_COLOR');
  for (const level of ['truecolor', '256', '16', 'plain'] as const) assert.equal(detectThemeLevel({ [THEME_ENV]: level }), level);
  assert.throws(() => detectThemeLevel({ [THEME_ENV]: 'neon' }), /STERLING_TUI_COLOR=neon is not one of truecolor, 256, 16, plain/);
  assert.equal(detectThemeLevel({ COLORTERM: 'truecolor' }), 'truecolor');
  assert.equal(detectThemeLevel({ COLORTERM: '24bit' }), 'truecolor');
  assert.equal(detectThemeLevel({ TERM_PROGRAM: 'tmux', TERM: 'screen' }), 'truecolor', 'tmux takes 24-bit SGR');
  assert.equal(detectThemeLevel({}, { trueColor: true }), 'truecolor');
  assert.equal(detectThemeLevel({ TERM: 'xterm-256color' }), '256');
  assert.equal(detectThemeLevel({}, { '256colors': true }), '256');
  assert.equal(detectThemeLevel({ TERM: 'xterm' }), '16');
});

// ---------------------------------------------------------------------------
// draw() over a hand-built state that exercises every kind of row
// ---------------------------------------------------------------------------

interface Put {
  x: number;
  y: number;
  attr: AttrLike;
  str: string;
}
function capture(width = 60, height = 40) {
  const puts: Put[] = [];
  const fills: AttrLike[] = [];
  const screen = {
    width,
    height,
    fill(o: { attr: AttrLike }) {
      fills.push(o.attr);
    },
    put(o: { x: number; y: number; attr: AttrLike }, str: string) {
      puts.push({ ...o, str });
    },
    draw() {},
  };
  return { screen, puts, fills };
}

function sampleState(banner: string[] = []): DashboardState {
  const top = banner.length;
  return {
    banner,
    projectName: 'demo',
    bodyTop: top + 3,
    tabs: [
      { label: 'Tasks', active: true, index: 0 },
      { label: 'Knowledge', active: false, index: 1 },
    ],
    searchLine: '/ query',
    emptyMessage: undefined,
    rows: [
      { id: 'a', type: 'todo', selected: true, expanded: true, screenRow: 0, lines: [{ text: 'Selected title', kind: 'title' }, { text: 'body text', kind: 'body' }, { text: 'meta line', kind: 'meta' }] },
      { id: 'b', type: 'todo', selected: false, expanded: false, screenRow: 3, lines: [{ text: 'Other title', kind: 'title' }] },
      { id: 'w', type: 'system-banner', selected: false, expanded: false, screenRow: 4, lines: [{ text: '⚠ a notice', kind: 'meta' }] },
    ],
    scroll: 0,
    queueCompleted: { startRow: 6, header: 'Completed', lines: ['12:00 drained · x'] },
    footer: 'q quit',
  } as unknown as DashboardState;
}

const find = (puts: Put[], str: string): Put => {
  const p = puts.find((q) => q.str === str || q.str.trimEnd() === str);
  assert.ok(p, `a put drew ${JSON.stringify(str)}`);
  return p!;
};

test('plain level: the attributes from before the theme (bold name, inverse tab and selection, dim meta/search/footer/queue), no colour anywhere', () => {
  const { screen, puts, fills } = capture();
  draw(screen, sampleState(), { theme: themeFor('plain') });
  assert.deepEqual(fills, [{}]);
  assert.deepEqual(find(puts, 'demo').attr, { bold: true });
  assert.deepEqual(find(puts, ' Tasks ').attr, { inverse: true });
  assert.deepEqual(find(puts, ' Knowledge ').attr, {});
  assert.deepEqual(find(puts, '/ query').attr, { dim: true });
  assert.deepEqual(find(puts, 'Selected title').attr, { inverse: true, bold: true });
  assert.equal(find(puts, 'Selected title').str, 'Selected title', 'no full-width padding at plain');
  assert.deepEqual(find(puts, 'Other title').attr, { inverse: false, bold: false });
  assert.deepEqual(find(puts, 'body text').attr, {});
  assert.deepEqual(find(puts, 'meta line').attr, { dim: true });
  assert.deepEqual(find(puts, '⚠ a notice').attr, { dim: true }, 'a warning keeps its kind\'s attr');
  assert.deepEqual(find(puts, 'Completed').attr, { dim: true });
  assert.deepEqual(find(puts, '12:00 drained · x').attr, { dim: true });
  assert.deepEqual(find(puts, 'q quit').attr, { dim: true });
  assert.ok(puts.every((p) => p.attr.color === undefined && p.attr.bgColor === undefined), 'no colour at plain');

  // draw() without a theme is the plain level
  const again = capture();
  draw(again.screen, sampleState());
  assert.deepEqual(again.puts, puts);
});

for (const level of ['truecolor', '256'] as const) {
  test(`${level} level: the page is painted black, explicit colours replace dim and inverse, the selected title is bold cyan on black, amber bold warnings`, () => {
    const { screen, puts, fills } = capture(60);
    draw(screen, sampleState(), { theme: themeFor(level) });
    assert.deepEqual(fills, [{ bgColor: XTERM.background }]);
    for (const p of puts) {
      assert.notEqual(p.attr.dim, true, `no dim on ${JSON.stringify(p.str)}`);
      assert.notEqual(p.attr.inverse, true, `no inverse on ${JSON.stringify(p.str)}`);
      assert.equal(typeof p.attr.bgColor, 'number', `every put carries a background: ${JSON.stringify(p.str)}`);
      assert.equal(typeof p.attr.color, 'number', `every put carries a colour: ${JSON.stringify(p.str)}`);
    }
    assert.deepEqual(puts.filter((p) => p.attr.bgColor !== XTERM.background), [], 'no put has a non-black background, the selection included');
    const sel = find(puts, 'Selected title');
    assert.equal(sel.str, 'Selected title', 'no full-width padding: the selection is not a bar');
    assert.deepEqual(sel.attr, { bgColor: XTERM.background, color: XTERM.cyan, bold: true });
    // the selection must differ visibly from an unselected row: colour and bold
    const other = find(puts, 'Other title');
    assert.deepEqual(other.attr, { bgColor: XTERM.background, color: XTERM.text, bold: false });
    assert.notEqual(sel.attr.color, other.attr.color, 'selected colour differs');
    assert.equal(sel.attr.bold, true);
    assert.notEqual(other.attr.bold, true, 'an unselected, collapsed title is not bold');
    const t = themeFor(level);
    assert.deepEqual(t.title(true, false), { bgColor: XTERM.background, color: XTERM.cyan, bold: true }, 'selected is bold cyan even when collapsed');
    assert.notDeepEqual(t.title(true, true), t.title(false, true), 'a selected expanded title still differs from an unselected expanded one');
    assert.deepEqual(find(puts, ' Tasks ').attr, { bgColor: XTERM.background, color: XTERM.pink, bold: true, underline: true });
    assert.equal(find(puts, ' Knowledge ').attr.color, XTERM.muted);
    assert.equal(find(puts, ' Knowledge ').attr.bgColor, XTERM.background, 'inactive tabs sit on the page black');
    assert.equal(find(puts, 'meta line').attr.color, XTERM.muted);
    assert.equal(find(puts, '/ query').attr.color, XTERM.cyan);
    assert.deepEqual(find(puts, '⚠ a notice').attr, { bgColor: XTERM.background, color: XTERM.amber, bold: true });
    assert.deepEqual(find(puts, 'Completed').attr, { bgColor: XTERM.background, color: XTERM.pink, bold: true });
  });
}

test('16 level: the terminal background stays, named colours, a magenta selection bar', () => {
  const t = themeFor('16');
  const { screen, puts, fills } = capture(40);
  draw(screen, sampleState(), { theme: t });
  assert.deepEqual(fills, [{}]);
  const sel = find(puts, 'Selected title');
  assert.equal(sel.str.length, 40);
  assert.deepEqual(sel.attr, { color: 'brightWhite', bgColor: 'magenta', bold: true });
  assert.deepEqual(find(puts, '⚠ a notice').attr, { dim: false, color: 'yellow', bold: true });
  assert.equal(t.bannerOverlay, false, 'the scene is drawn as text at 16 colours');
});

// xterm-256 index → RGB, for the contrast check
function xtermRgb(i: number): [number, number, number] {
  if (i >= 232) {
    const v = 8 + (i - 232) * 10;
    return [v, v, v];
  }
  const c = i - 16;
  const level = (n: number): number => (n === 0 ? 0 : 55 + n * 40);
  return [level(Math.floor(c / 36)), level(Math.floor(c / 6) % 6), level(c % 6)];
}
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const contrast = (a: number, b: number): number => {
  const [la, lb] = [luminance(xtermRgb(a)), luminance(xtermRgb(b))];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

test('256 palette: every text colour reads at 4.5:1 or better on its background', () => {
  assert.deepEqual(xtermRgb(XTERM.background), [0, 0, 0], 'index 16 is the black the scene meets');
  assert.equal(PALETTE.night, '#000000');
  assert.equal(PALETTE.text, '#ffffff');
  assert.deepEqual(xtermRgb(XTERM.text), [255, 255, 255], 'body text is white');
  for (const [name, fg] of Object.entries(XTERM)) {
    if (name === 'background') continue;
    assert.ok(contrast(fg, XTERM.background) >= 4.5, `${name} (${fg}) on the background: ${contrast(fg, XTERM.background).toFixed(2)}`);
  }
  assert.ok(contrast(XTERM.cyan, XTERM.background) >= 4.5, 'selected text (bold cyan) on the page black');
});

// ---------------------------------------------------------------------------
// the sunset scene
// ---------------------------------------------------------------------------

test('scene layout: 8 rows = 4 sun rows, the horizon, 3 grid rows; 4 rows = 2 sun rows, the horizon, 1 grid row', () => {
  assert.deepEqual(sceneLayout(FULL_SCENE_ROWS), { sunRows: 4, horizon: 4, gridRows: 3 });
  assert.deepEqual(sceneLayout(COMPACT_SCENE_ROWS), { sunRows: 2, horizon: 2, gridRows: 1 });
});

test('scenePixels: every cell of the scene has a background; the project name sits centred on the cyan horizon', () => {
  for (const [w, rows] of [[60, FULL_SCENE_ROWS], [40, COMPACT_SCENE_ROWS]] as const) {
    const px = scenePixels(w, rows, 'myproj');
    assert.equal(px.length, w * rows, `${w}x${rows}: one cell each`);
    assert.ok(px.every((p) => p.bg !== undefined && p.x >= 0 && p.x < w && p.y >= 0 && p.y < rows), 'all cells in range with a bg');
    assert.equal(new Set(px.map((p) => `${p.x},${p.y}`)).size, px.length, 'no cell twice');
    const { horizon } = sceneLayout(rows);
    const line = px.filter((p) => p.y === horizon).sort((a, b) => a.x - b.x);
    const text = line.map((p) => p.ch).join('');
    const label = ' myproj ';
    const x0 = Math.floor((w - label.length) / 2);
    assert.equal(text, '━'.repeat(x0) + label + '━'.repeat(w - x0 - label.length));
    assert.ok(line.filter((p) => p.ch === '━').every((p) => p.fg === PALETTE.cyan), 'the horizon line is cyan');
  }
});

test('scenePixels: a striped sun (warm colours, dark bands in its lower half) behind the chrome wordmark', () => {
  const w = 60;
  const px = scenePixels(w, FULL_SCENE_ROWS, 'x');
  const at = (x: number, y: number) => px.find((p) => p.x === x && p.y === y)!;
  const cx = Math.floor(w / 2);
  // above the wordmark, row 0 at the centre is sun (top pixel warm), while the corner is night sky
  const warm = (hex: string | undefined): boolean => hex !== undefined && Number.parseInt(hex.slice(1, 3), 16) >= 0xf0;
  assert.ok(warm(at(cx, 0).fg ?? at(cx, 0).bg), 'the sun shows at the top centre');
  assert.ok(!warm(at(0, 0).bg) && !warm(at(0, 0).fg), 'the top corner is night sky, not sun');
  // a lower-half sun cell next to the wordmark: top pixel sun, bottom pixel a dark band (row 3 = pixel rows 6, 7)
  const x0 = Math.floor((w - ART_WIDTH) / 2);
  const bandCell = at(x0 + 15, 3); // a space column near the centre of the art's last row
  assert.equal(BANNER_ROWS[2][15], ' ');
  assert.equal(bandCell.ch, '▀');
  assert.ok(warm(bandCell.fg), 'upper pixel: the sun');
  assert.ok(!warm(bandCell.bg), 'lower pixel: a dark band');
});

test('sceneText (16-colour and plain levels): the wordmark, the horizon with the name, the grid rays; bannerLines is the scene minus its last row', () => {
  const t = sceneText(60, FULL_SCENE_ROWS, 'myproj');
  assert.equal(t.length, FULL_SCENE_ROWS);
  const x0 = Math.floor((60 - ART_WIDTH) / 2);
  assert.deepEqual(t.slice(1, 4), BANNER_ROWS.map((r) => (' '.repeat(x0) + r).trimEnd()));
  assert.match(t[4]!, /^─+ myproj ─+$/);
  assert.ok(t.slice(5).every((row) => /^[ ╱│╲]+$/.test(row) && row.includes('│')), 'grid rows are rays around a centre line');
  assert.deepEqual(bannerLines(60, true), sceneText(60, FULL_SCENE_ROWS, '').slice(0, FULL_SCENE_ROWS - 1));
  const c = sceneText(24, COMPACT_SCENE_ROWS, 'myproj');
  assert.equal(c[1]!.trim(), 'S T E R L I N G');
  assert.match(c[2]!, /^─+ myproj ─+$/);
  assert.equal(sceneText(12, COMPACT_SCENE_ROWS, '')[1]!.trim(), 'STERLING', 'too narrow for the spaced wordmark');
});

test('horizonLabel: centred with a space each side; a name wider than the pane is clipped from the left edge, never dropped', () => {
  assert.deepEqual(horizonLabel(20, 'abc'), { x: 7, text: ' abc ' });
  assert.deepEqual(horizonLabel(8, 'sterling — domains unavailable'), { x: 0, text: 'sterling' });
  assert.deepEqual(horizonLabel(20, ''), { x: 0, text: '' });
});

test('draw with the banner shown: the scene covers the banner rows and the header row, the name on its horizon; the tabs follow', () => {
  const banner = bannerLines(60, true);
  const top = banner.length;
  // text levels: the scene is drawn through the buffer, the name in the name attr on the horizon
  const plain = capture(60);
  draw(plain.screen, sampleState(banner), { theme: PLAIN_THEME });
  const name = find(plain.puts, ' demo');
  assert.equal(name.y, sceneLayout(top + 1).horizon);
  assert.deepEqual(name.attr, { bold: true });
  assert.ok(!plain.puts.some((p) => p.y === top && p.str.includes('demo')), 'no separate name row');
  assert.ok(plain.puts.some((p) => p.y === top && /│/.test(p.str)), 'the header row is the scene\'s last grid row');
  assert.equal(find(plain.puts, ' Tasks ').y, top + 1);
  // overlay levels: the buffer leaves the scene's cells blank for the pixel overlay
  const tc = capture(60);
  draw(tc.screen, sampleState(banner), { theme: themeFor('truecolor') });
  assert.ok(!tc.puts.some((p) => p.y <= top), 'nothing drawn in the scene rows');
  assert.equal(find(tc.puts, ' Tasks ').y, top + 1);
});

// ---------------------------------------------------------------------------
// the overlay's page background and the avatar tiles' neon edge
// ---------------------------------------------------------------------------

test('paintPixels / clearPixels: a cell with no bg, and a blanked cell, are written on the theme\'s page background', () => {
  const calls: string[] = [];
  const term = {
    moveTo: (x: number, y: number) => calls.push(`move ${x},${y}`),
    colorRgbHex: (h: string) => calls.push(`fg ${h}`),
    bgColorRgbHex: (h: string) => calls.push(`bg ${h}`),
    styleReset: () => calls.push('reset'),
    noFormat: (s: string) => calls.push(`put ${s}`),
  };
  const sgr = themeFor('truecolor').blankSgr;
  assert.equal(sgr, '\x1b[48;5;16m');
  const prev = paintPixels(term, [{ x: 0, y: 0, ch: '▄', fg: '#ffffff' }, { x: 1, y: 0, ch: ' ', bg: '#000000' }], undefined, false, sgr);
  assert.deepEqual(calls, ['reset', 'move 1,1', `put ${sgr}`, 'fg #ffffff', 'put ▄', 'reset', 'move 2,1', 'bg #000000', 'put  ', 'reset']);
  calls.length = 0;
  clearPixels(term, prev, [], sgr);
  assert.deepEqual(calls, ['reset', `put ${sgr}`, 'move 1,1', 'put  ', 'move 2,1', 'put  ']);
  assert.equal(PLAIN_THEME.blankSgr, '', 'plain leaves the terminal background');
});

test('tileCells with an edge: thin neon bars in the padding columns; without one, the tile is unchanged', () => {
  const plain = tileCells(0, 0);
  const edged = tileCells(0, 0, '#00e5ff');
  edged.forEach((row, r) => {
    assert.equal(row.length, TILE_COLS);
    assert.deepEqual(row[0], { ch: '▌', fg: '#00e5ff', bg: TILE_BG });
    assert.deepEqual(row[TILE_COLS - 1], { ch: '▐', fg: '#00e5ff', bg: TILE_BG });
    assert.deepEqual(row.slice(1, -1), plain[r]!.slice(1, -1), 'the portrait is untouched');
  });
  assert.deepEqual(plain[0]![0], { ch: ' ', bg: TILE_BG });
});

function agentView(status: 'running' | 'quiet' | 'resumable' | 'done'): SubagentView {
  return {
    availability: 'ok',
    active: status === 'running' ? 1 : 0,
    agents: [{ agentId: 'a1', avatar: 0, type: 'implementor', description: null, model: 'm', status, elapsedMs: 1000, contextPct: 10, contextTokens: 1000, idleMs: status === 'running' ? null : 1000 }],
  };
}

test('composeSubagentBlock neonEdge: the tile edge is the status colour (cyan running, amber quiet, pink resumable, faded muted done); off by default', () => {
  const edge = (status: 'running' | 'quiet' | 'resumable' | 'done', neonEdge?: boolean) =>
    composeSubagentBlock(agentView(status), 80, 20, 0, neonEdge === undefined ? undefined : { neonEdge }).pixels.find((p) => p.x === 0 && p.y === 0)!;
  assert.deepEqual(edge('running', true), { x: 0, y: 0, ch: '▌', fg: NEON_EDGE.running, bg: TILE_BG });
  assert.equal(edge('resumable', true).fg, fadeToTile(NEON_EDGE.resumable, DONE_FADE), 'a resumable agent is not running, so its tile is faded');
  assert.equal(edge('done', true).fg, fadeToTile(NEON_EDGE.done, DONE_FADE));
  assert.equal(NEON_EDGE.quiet, PALETTE.amber);
  assert.equal(edge('quiet', true).fg, fadeToTile(NEON_EDGE.quiet, DONE_FADE), 'a quiet agent has its own edge colour');
  assert.deepEqual(edge('running'), { x: 0, y: 0, ch: ' ', bg: TILE_BG }, 'no edge unless asked (the OpenCode host and the plain level)');
});

test('themeFor: one theme object per level; map() turns the Agents tab\'s host-neutral attrs into theme colours', () => {
  const t: Theme = themeFor('256');
  assert.equal(themeFor('256'), t);
  assert.deepEqual(t.map({ color: 'green' }), { bgColor: XTERM.background, color: XTERM.success });
  assert.deepEqual(t.map({ dim: true }), { bgColor: XTERM.background, color: XTERM.muted });
  assert.deepEqual(t.map({ bold: true, dim: true }), { bgColor: XTERM.background, color: XTERM.muted, bold: true });
  assert.deepEqual(PLAIN_THEME.map({ color: 'green' }), { color: 'green' });
});

test('scene meets the page: the sky starts on the page black, and the body and the overlay blanks use it', () => {
  assert.deepEqual(xtermRgb(XTERM.background), [0, 0, 0]);
  const px = scenePixels(60, FULL_SCENE_ROWS, 'x');
  assert.equal(px.find((p) => p.x === 0 && p.y === 0)!.fg, PALETTE.night, 'the top pixel of the corner is the page colour');
  assert.equal(themeFor('truecolor').blankSgr, `\x1b[48;5;${XTERM.background}m`);
});
