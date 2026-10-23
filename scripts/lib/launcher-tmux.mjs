// sterling-launch.sh rendering (templates/launcher-tmux.sh) — one place for the two
// shapes
// (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone, ruling point 3):
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
//
//   OPENCODE PANE, both shapes (decision
//   in-an-opencode-project-the-tmux-side-pane-runs-the-dashboard): an OpenCode session's
//   pane runs the dashboard of the copy the OpenCode server plugin loads, never the clone
//   and never a Claude Code copy, so pane and plugin are one version (GitHub #202: a
//   0.19.116 clone pane wrote overpass.roles keys a 0.19.113 plugin refused). That copy is
//   the one OpenCode's own rule picks for the Sterling spec in its global config
//   (openCodeLoadedSterling, OPENCODE_LOADED_SOURCE in sterling-roots.mjs: that spec's
//   cache directory, its newest numeric install generation), NOT the highest version in
//   the cache, which a rollback or an older configured spec leaves newer than the plugin.
//   It is resolved when the pane opens, before or after the plugin has loaded, rather than
//   baked: `opencode plugin update` adds a new generation, so a baked path would pin the
//   pane to the copy of the day init ran. With no Sterling spec configured, init installed
//   its own OpenCode server shim (installGlobal in opencode-install.mjs), which loads the
//   clone (authoring) or the newest installed copy (installed): the root TUI_BUNDLE already
//   names, so the pane keeps TUI_BUNDLE. Both shapes append the same block to
//   {{PLUGIN_PATHS}}; it starts with OPENCODE_PANE_MARKER, which launcher-history.mjs
//   uses to recognise it after an authoring pair.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInstalledCopy } from './installed-copy.mjs';
import { JSONC_SOURCE } from './jsonc.mjs';
import { OPENCODE_LOADED_SOURCE, RESOLVER_IMPORTS, RESOLVER_SOURCE, SPECS_SOURCE } from './sterling-roots.mjs';

const fwd = (p) => p.replace(/\\/g, '/');

/** The first line of the OpenCode pane block; kept stable so launcher-history.mjs can find the block. */
export const OPENCODE_PANE_MARKER = '# OpenCode pane: the dashboard of the Sterling copy the OpenCode plugin loads';

// opencode_tui_bundle is only called by the template's use_opencode_tui, after NODE_BIN is
// set. It prints the bundle of the copy OpenCode loads, or nothing (the pane keeps
// TUI_BUNDLE) with a line on stderr saying why, unless no Sterling spec is configured.
const OPENCODE_PANE_PATHS = [
  OPENCODE_PANE_MARKER,
  "# (the newest install of the Sterling spec in OpenCode's global config), resolved when the pane opens",
  'opencode_tui_bundle() {',
  '  "$NODE_BIN" --input-type=module <<\'STERLING_OPENCODE_RESOLVER\'',
  "import { createHash } from 'node:crypto';",
  RESOLVER_IMPORTS,
  RESOLVER_SOURCE.trim(),
  JSONC_SOURCE.trim(),
  SPECS_SOURCE.trim(),
  OPENCODE_LOADED_SOURCE.trim(),
  "const keep = 'so the OpenCode pane runs the launcher\\'s own dashboard, which may be another Sterling version than the plugin';",
  'const loaded = openCodeLoadedSterling();',
  "if (loaded.error) console.error('sterling-launch: could not read ' + loaded.configPath + ' (' + loaded.error + '), so which Sterling OpenCode loads is unknown, ' + keep);",
  'else if (loaded.copies.length) {',
  '  const [first] = loaded.copies;',
  "  if (new Set(loaded.copies.map((c) => c.root)).size > 1) console.error('sterling-launch: ' + loaded.configPath + ' lists Sterling ' + loaded.copies.length + ' times (' + loaded.copies.map((c) => c.spec).join(', ') + '); the OpenCode pane follows the first, ' + first.spec);",
  "  if (first.root === null) console.error('sterling-launch: OpenCode has not installed ' + first.spec + ' yet (nothing in ' + first.dir + '), ' + keep);",
  "  else process.stdout.write(join(first.root, 'tui', 'sterling-tui.mjs'));",
  '}',
  'STERLING_OPENCODE_RESOLVER',
  '}',
].join('\n');

const AUTHORING_PATHS = (pluginRoot) =>
  [`PLUGIN_DIR="${fwd(pluginRoot)}"`, `TUI_BUNDLE="${fwd(pluginRoot)}/tui/sterling-tui.mjs"`, OPENCODE_PANE_PATHS].join('\n');

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
  OPENCODE_PANE_PATHS,
].join('\n');
// Exported for scripts/lib/launcher-history.mjs: today's installed block is always a
// known {{PLUGIN_PATHS}} value when matching an older launcher.
export { INSTALLED_PATHS };

/**
 * @param {string} pluginRoot
 * @param {{session: string, legacySession?: string, splitPercent: number, installed?: boolean}} opts
 *   `legacySession` is the pre-hash name the engine still attaches to (default: `session`).
 *   `installed` defaults to isInstalledCopy(pluginRoot); tests pass it explicitly.
 */
export function renderTmuxLauncher(pluginRoot, { session, legacySession = session, splitPercent, installed = isInstalledCopy(pluginRoot) }) {
  return readFileSync(join(pluginRoot, 'templates', 'launcher-tmux.sh'), 'utf8')
    .replaceAll('{{SESSION}}', () => session)
    .replaceAll('{{LEGACY_SESSION}}', () => legacySession)
    .replaceAll('{{PLUGIN_PATHS}}', () => (installed ? INSTALLED_PATHS : AUTHORING_PATHS(pluginRoot)))
    .replaceAll('{{CLAUDE_PLUGIN_FLAG}}', () => (installed ? '' : ' --plugin-dir "$PLUGIN_DIR"'))
    .replaceAll('{{SPLIT_RATIO}}', () => String(splitPercent));
}
