// sterling-launch.sh rendering (templates/launcher-tmux.sh) — one place for the two
// shapes (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-
// clone, ruling point 3):
//
//   AUTHORING CLONE (a .git at the plugin root): claude starts with
//   `--plugin-dir <clone>` and the TUI is the clone's committed bundle,
//   <clone>/tui/sterling-tui.mjs.
//
//   INSTALLED COPY (no .git): nothing may name a versioned cache directory, because
//   the next plugin update moves it. So NO `--plugin-dir` (the installed plugin is
//   already active) and the TUI bundle is resolved at RUN time as the highest-version
//   ~/.claude/plugins/cache/*/sterling/*/tui/sterling-tui.mjs (GNU `sort -V`, keyed on
//   the version directory name, so the marketplace directory never decides the order).
//   Known limit: `sort -V` is not full semver for pre-release tags (1.0.0-rc1 sorts
//   after 1.0.0).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInstalledCopy } from './installed-copy.mjs';

const fwd = (p) => p.replace(/\\/g, '/');

const AUTHORING_PATHS = (pluginRoot) =>
  [`PLUGIN_DIR="${fwd(pluginRoot)}"`, `TUI_BUNDLE="${fwd(pluginRoot)}/tui/sterling-tui.mjs"`].join('\n');

const INSTALLED_PATHS = [
  '# installed plugin copy: nothing below names a versioned cache directory',
  'PLUGIN_CACHE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache"',
  'TUI_BUNDLE="$(',
  '  for f in "$PLUGIN_CACHE"/*/sterling/*/tui/sterling-tui.mjs; do',
  '    [ -f "$f" ] || continue',
  '    v="${f%/tui/sterling-tui.mjs}"',
  '    printf \'%s\\t%s\\n\' "${v##*/}" "$f"',
  '  done | sort -t "$(printf \'\\t\')" -k1,1V | tail -n 1 | cut -f2',
  ')"',
].join('\n');

/**
 * @param {string} pluginRoot
 * @param {{session: string, splitPercent: number, installed?: boolean}} opts
 *   `installed` defaults to isInstalledCopy(pluginRoot); tests pass it explicitly.
 */
export function renderTmuxLauncher(pluginRoot, { session, splitPercent, installed = isInstalledCopy(pluginRoot) }) {
  return readFileSync(join(pluginRoot, 'templates', 'launcher-tmux.sh'), 'utf8')
    .replaceAll('{{SESSION}}', () => session)
    .replaceAll('{{PLUGIN_PATHS}}', () => (installed ? INSTALLED_PATHS : AUTHORING_PATHS(pluginRoot)))
    .replaceAll('{{CLAUDE_PLUGIN_FLAG}}', () => (installed ? '' : ' --plugin-dir "$PLUGIN_DIR"'))
    .replaceAll('{{SPLIT_RATIO}}', () => String(splitPercent));
}
