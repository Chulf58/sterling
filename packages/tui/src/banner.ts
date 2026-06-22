// The §11 banner slot: TUI-local glyph data in a swappable data slot. The art
// is the same STERLING wordmark the H1 SessionStart hook prints
// (scripts/hooks/h1-session-start.mjs BANNER_ROWS) — deliberately duplicated,
// not imported: the hook is a standalone bundled .mjs with no workspace imports
// (invariant 4), and it paints raw ANSI truecolor to stderr while the TUI
// paints through terminal-kit's ScreenBuffer. If the wordmark changes, change
// both. Real/seasonal art stays deferred — drop new rows in here.
//
// Geometry is pure: bannerLines(width, show) is the single source the state
// layer reads to derive bodyTop, so hit-testing, the queue divider, and the
// tab-bar click row all follow the banner height by construction. Color is a
// render concern (bannerPaletteIndex) — the state layer stays env- and
// color-free; suppression arrives as the pure `show` flag.

/** Full 3-row block-letter wordmark (fixed-width; fits the 35% split pane). */
export const BANNER_ROWS = [
  '▄▀▀ ▀█▀ █▀▀ █▀▄ █   ▀█▀ █▄ █ ▄▀▀▄',
  '▀▀▄  █  █▀▀ █▀▄ █    █  █ ▀█ █ ▄▄',
  '▀▀▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ ▀▀▀ ▀  ▀ ▀▀▀▀',
] as const;

/** 1-line fallback when the art will not fit. */
export const WORDMARK = 'STERLING';

/** Columns the full art needs (≈33); below this it cannot render without
 *  clipping mid-glyph, so we fall back to the wordmark. */
export const ART_WIDTH = Math.max(...BANNER_ROWS.map((r) => r.length));

/**
 * The banner's display rows for a given pane width, width-aware:
 *   show=false           → []                       (suppressed; layout = no banner)
 *   width ≥ ART_WIDTH     → the full 3-row art
 *   1 ≤ width < ART_WIDTH → [wordmark] clipped to width
 *   width < 1            → []                       (no room for anything)
 * Returns plain strings — the state layer derives bodyTop from .length; the
 * renderer applies the gradient.
 */
export function bannerLines(width: number, show: boolean): string[] {
  if (!show) return [];
  if (!Number.isFinite(width)) return [...BANNER_ROWS];
  if (width >= ART_WIDTH) return [...BANNER_ROWS];
  if (width < 1) return [];
  return [WORDMARK.slice(0, width)];
}

// xterm-256 silver ramp: white → silver greys → steel blue, approximating the
// H1 hook's truecolor gradient (255,255,255 → 192,192,200 → 70,100,130) within
// the 256-color palette (a regular ScreenBuffer cannot do truecolor — that
// lives in ScreenBufferHD; see decision on banner color).
const RAMP = [231, 255, 253, 251, 249, 103, 66, 60] as const;

/** Palette index for a normalized column position t ∈ [0,1] across the banner
 *  width — light at the left, steel blue at the right. */
export function bannerPaletteIndex(t: number): number {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return RAMP[Math.round(u * (RAMP.length - 1))];
}
