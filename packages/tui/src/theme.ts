// The dashboard's synthwave theme (decision
// tui-synthwave-theme-sunset-banner-project-name-on-horizon): a black
// background the TUI paints itself (the deep violet it first had read badly,
// user 2026-10-09), white body text, hot pink and cyan accents, an explicit
// muted colour instead of the terminal's dim, amber bold warnings and a bold
// cyan selected title on the page black instead of inverse video.
//
// Four capability levels. The body is drawn through terminal-kit's regular
// ScreenBuffer, which takes 256-palette indexes only (decisions f509a5b7 and
// c2f48469: ScreenBufferHD has no terminal-default colour), so truecolour and
// 256 share the body attributes below; they differ in the pixel overlay
// (render.ts paintPixels), where truecolour writes 24-bit SGR for the banner
// scene and the avatar tiles. 16 keeps the terminal's own background and uses
// the named colours. plain is the look from before the theme: bold, dim and
// inverse, no colour; NO_COLOR selects it.
//
// Pure: the level is detected from the env and terminal support passed in.
import type { AttrLike } from './render.js';

export type ThemeLevel = 'truecolor' | '256' | '16' | 'plain';
export const THEME_LEVELS: readonly ThemeLevel[] = ['truecolor', '256', '16', 'plain'];

/** Set to one of THEME_LEVELS to override detection, NO_COLOR included. */
export const THEME_ENV = 'STERLING_TUI_COLOR';

/** The truecolour palette the banner scene and the avatar edges use. */
export const PALETTE = {
  /** xterm 16: the colour the ScreenBuffer paints as background, so the overlay meets the body without a seam */
  night: '#000000',
  text: '#ffffff',
  pink: '#ff2bd6',
  cyan: '#00e5ff',
  muted: '#8787af',
  /** xterm 220, the warning amber */
  amber: '#ffd319',
} as const;

/** The 256-palette indexes the ScreenBuffer draws the body with (truecolour and 256 levels). */
export const XTERM = {
  /** #000000, the 256 palette's explicit black; not the terminal default, which ScreenBuffer cannot draw and which may be any colour */
  background: 16,
  /** #ffffff */
  text: 231,
  /** #8787af */
  muted: 103,
  /** #ff00d7 */
  pink: 200,
  /** #00d7ff */
  cyan: 45,
  /** #ffd700 */
  amber: 220,
  /** #ff5f5f */
  error: 203,
  /** #00ffaf */
  success: 49,
  /** #ffffff */
  bright: 231,
} as const;

/** The status colour of an avatar tile's neon edge. */
export const NEON_EDGE = {
  running: PALETTE.cyan,
  resumable: PALETTE.pink,
  /** amber, like the quiet status line's yellow: unknown, neither running nor done */
  quiet: PALETTE.amber,
  done: PALETTE.muted,
} as const;

export interface Theme {
  level: ThemeLevel;
  /** what screen.fill paints every cell with */
  fill: AttrLike;
  /** the project-name header row, drawn when the banner scene is not */
  name: AttrLike;
  tab: AttrLike;
  tabActive: AttrLike;
  /** the search bar on the spacer row */
  search: AttrLike;
  /** a card's body line */
  text: AttrLike;
  /** meta lines, the empty-list message, log lines and the footer */
  muted: AttrLike;
  /** the Queue tab's section headers */
  heading: AttrLike;
  title(selected: boolean, expanded: boolean): AttrLike;
  /** a '⚠ ' line: amber bold over whatever the line would have been */
  warn(attr: AttrLike): AttrLike;
  /** a host-neutral attr (the Agents tab's puts: bold, dim, a named colour) in this theme */
  map(attr: { bold?: boolean; dim?: boolean; color?: string | number }): AttrLike;
  /** pad a selected title to the full width so the selection is a bar */
  fullWidthSelection: boolean;
  /** draw the banner scene as overlay pixels (else as text through the ScreenBuffer, with the three attrs below) */
  bannerOverlay: boolean;
  sceneArt: AttrLike;
  sceneHorizon: AttrLike;
  sceneGrid: AttrLike;
  /** the SGR the overlay writes before a cell with no background; '' leaves the terminal's own */
  blankSgr: string;
}

/** The level for this env and terminal. THEME_ENV wins, then NO_COLOR, then the
 *  truecolour signals main.ts used before the theme (COLORTERM, tmux, terminal-kit
 *  support), then 256-colour support. An unknown THEME_ENV value throws. */
export function detectThemeLevel(env: Readonly<Record<string, string | undefined>>, support: { trueColor?: boolean; '256colors'?: boolean } = {}): ThemeLevel {
  const forced = env[THEME_ENV];
  if (forced !== undefined && forced !== '') {
    if ((THEME_LEVELS as readonly string[]).includes(forced)) return forced as ThemeLevel;
    throw new Error(`${THEME_ENV}=${forced} is not one of ${THEME_LEVELS.join(', ')}`);
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'plain';
  // terminal-kit takes colour support from TERM_PROGRAM first and maps tmux to
  // 16 colours, yet tmux accepts 24-bit SGR and converts it for the outer terminal
  if (/^(truecolor|24bits?)$/.test(env.COLORTERM ?? '') || env.TERM_PROGRAM === 'tmux' || support.trueColor === true) return 'truecolor';
  if (support['256colors'] === true || /256color/.test(env.TERM ?? '')) return '256';
  return '16';
}

/** The look from before the theme, and render.draw's default. */
export const PLAIN_THEME: Theme = {
  level: 'plain',
  fill: {},
  name: { bold: true },
  tab: {},
  tabActive: { inverse: true },
  search: { dim: true },
  text: {},
  muted: { dim: true },
  heading: { dim: true },
  title: (selected, expanded) => ({ inverse: selected, bold: expanded }),
  warn: (attr) => attr,
  map: (attr) => attr,
  fullWidthSelection: false,
  bannerOverlay: false,
  sceneArt: {},
  sceneHorizon: {},
  sceneGrid: {},
  blankSgr: '',
};

function xtermTheme(level: 'truecolor' | '256'): Theme {
  const bg = XTERM.background;
  const on = (attr: AttrLike): AttrLike => ({ bgColor: bg, ...attr });
  const muted = on({ color: XTERM.muted });
  return {
    level,
    fill: { bgColor: bg },
    name: on({ color: XTERM.pink, bold: true }),
    tab: muted,
    // bold underlined pink on the page black: the active tab needs no coloured block
    tabActive: on({ color: XTERM.pink, bold: true, underline: true }),
    search: on({ color: XTERM.cyan }),
    text: on({ color: XTERM.text }),
    muted,
    heading: on({ color: XTERM.pink, bold: true }),
    // the selected title is bold cyan on the page black; no coloured bar
    title: (selected, expanded) => (selected ? on({ color: XTERM.cyan, bold: true }) : on({ color: XTERM.text, bold: expanded })),
    warn: (attr) => ({ ...attr, color: XTERM.amber, bold: true }),
    map: (attr) => {
      const color = attr.color === 'green' ? XTERM.success : attr.color === 'red' ? XTERM.error : attr.dim ? XTERM.muted : XTERM.text;
      return attr.bold ? on({ color, bold: true }) : on({ color });
    },
    fullWidthSelection: false,
    bannerOverlay: true,
    sceneArt: on({ color: XTERM.bright, bold: true }),
    sceneHorizon: on({ color: XTERM.cyan }),
    sceneGrid: on({ color: XTERM.pink }),
    blankSgr: `\x1b[48;5;${bg}m`,
  };
}

// 16 colours: the terminal's own background stays, so dim stays the muted
// colour; brightBlack, the usual grey, is the background colour in Solarized Dark.
const SIXTEEN: Theme = {
  level: '16',
  fill: {},
  name: { color: 'magenta', bold: true },
  tab: { dim: true },
  tabActive: { color: 'brightWhite', bgColor: 'magenta', bold: true },
  search: { color: 'cyan' },
  text: {},
  muted: { dim: true },
  heading: { color: 'magenta', bold: true },
  title: (selected, expanded) => (selected ? { color: 'brightWhite', bgColor: 'magenta', bold: expanded } : { bold: expanded }),
  warn: (attr) => ({ ...attr, dim: false, color: 'yellow', bold: true }),
  map: (attr) => attr,
  fullWidthSelection: true,
  bannerOverlay: false,
  sceneArt: { color: 'brightWhite', bold: true },
  sceneHorizon: { color: 'cyan' },
  sceneGrid: { color: 'magenta' },
  blankSgr: '',
};

const TRUECOLOR = xtermTheme('truecolor');
const XTERM256 = xtermTheme('256');

export function themeFor(level: ThemeLevel): Theme {
  if (level === 'plain') return PLAIN_THEME;
  if (level === '16') return SIXTEEN;
  return level === 'truecolor' ? TRUECOLOR : XTERM256;
}
