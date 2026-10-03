// sterling-launch.sh rendering (templates/launcher-tmux.sh) — one place for the two
// shapes (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-
// clone, ruling point 3):
//
//   AUTHORING CLONE (a .git at the plugin root): claude starts with
//   `--plugin-dir <clone>` and the TUI is the clone's committed bundle,
//   <clone>/tui/sterling-tui.mjs.
//
//   INSTALLED COPY (no .git): nothing may name a versioned install directory, because
//   the next update moves it. So NO `--plugin-dir` (the installed plugin is already
//   active) and the TUI bundle is <newest copy>/tui/sterling-tui.mjs, resolved at RUN
//   time by the shared resolver (scripts/lib/sterling-roots.mjs: Claude Code's plugin
//   cache and OpenCode's npm cache, semver order). The resolver is inlined into a quoted
//   heredoc run by node, because the launcher cannot import from a versioned directory.
//   node is looked up the same way the template looks it up further down (NODE_BIN,
//   PATH, then the ~/.local tarball), since PLUGIN_PATHS comes before that lookup. When
//   nothing is installed the resolver prints the roots searched and the Claude Code
//   install command, and the template's TUI-bundle check then stops the launcher.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInstalledCopy } from './installed-copy.mjs';
import { RESOLVER_IMPORTS, RESOLVER_SOURCE } from './sterling-roots.mjs';

const fwd = (p) => p.replace(/\\/g, '/');

const AUTHORING_PATHS = (pluginRoot) =>
  [`PLUGIN_DIR="${fwd(pluginRoot)}"`, `TUI_BUNDLE="${fwd(pluginRoot)}/tui/sterling-tui.mjs"`].join('\n');

const INSTALLED_PATHS = [
  '# installed copy: nothing below names a versioned install directory; the newest',
  '# installed Sterling (Claude Code or OpenCode) is resolved when this runs',
  'RESOLVER_NODE="${NODE_BIN:-$(command -v node || true)}"',
  '[ -n "$RESOLVER_NODE" ] || RESOLVER_NODE="$(ls -d "$HOME"/.local/node-v*-linux-x64/bin/node 2>/dev/null | head -1)"',
  'TUI_BUNDLE=""',
  '[ -z "$RESOLVER_NODE" ] || TUI_BUNDLE="$("$RESOLVER_NODE" --input-type=module <<\'STERLING_RESOLVER\'',
  RESOLVER_IMPORTS,
  RESOLVER_SOURCE.trim(),
  'const found = newestInstalledSterling();',
  "if (found) process.stdout.write(join(found.root, 'tui', 'sterling-tui.mjs'));",
  "else console.error('sterling-launch: ' + sterlingNotFoundMessage('claude-code'));",
  'STERLING_RESOLVER',
  ')"',
].join('\n');
// Exported for scripts/lib/launcher-history.mjs: today's installed block is always a
// known {{PLUGIN_PATHS}} value when matching an older launcher.
export { INSTALLED_PATHS };

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
