// sterling-update.bat ensure [S] — the per-project double-click updater entry.
//
// Shared by TWO producers: init's launcher manifest (item 5) and runUpdate's
// per-project fan-out. The fan-out matters because the updater is how a machine
// RECEIVES new artifacts: a project init'd before this launcher existed would
// otherwise never get one until someone remembered to re-run /sterling:init
// there (P4 — bind the delivery to the update event, not to memory).
//
// BOOTSTRAP INDEPENDENCE: imported by scripts/lib/update.mjs at load time, so
// this file must import node builtins ONLY — it has to load on a clone where
// nothing is built (see the consumer-update-path article).
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { stampBody, verifyStamp } from './generated-marker.mjs';

export const UPDATE_LAUNCHER_NAME = 'sterling-update.bat';

// TWO TEMPLATES, ONE GENERATED FILENAME. The WSL template shells to
// wsl.exe + bash scripts/update-console.sh; a 100%-Windows machine has no WSL,
// and the clone update is the ONLY way a consuming machine ever receives
// Sterling changes — so on a win32 HOST the native template is rendered
// instead, driving the same scripts/update.mjs directly through node
// (decision ffe7c416 host-native-init-with-dev-machine-escape-hatch; parity
// decision 1fe2a5e3; distribution model e6240afe). The discriminator is the
// RENDERING host's platform, which is exactly the host-native derivation the
// ruling asks for: a WSL/Linux session keeps emitting the WSL chain (the
// authoring machine's dual-context escape hatch), a native-Windows session
// emits a chain with no wsl.exe in it. The filename, ensure semantics,
// generated marker and .gitignore entry are identical either way, so no
// caller (init's manifest, runUpdate's fan-out) changes.
export const UPDATE_TEMPLATE_WSL = 'update-win.bat';
export const UPDATE_TEMPLATE_NATIVE = 'update-win-native.bat';
export const updateTemplateName = (platform = process.platform) =>
  platform === 'win32' ? UPDATE_TEMPLATE_NATIVE : UPDATE_TEMPLATE_WSL;

// /mnt/c/Users/cuj/X -> C:\Users\cuj\X (WSL drvfs); else just backslash-ize.
// Mirrors init's toWindowsPath — duplicated (5 lines) rather than imported:
// init pulls in workspace packages at load time, which this file must not.
const toWindowsPath = (p) => {
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? '/').replace(/\//g, '\\')}` : p.replace(/\//g, '\\');
};
const crlf = (s) => s.replace(/\r?\n/g, '\r\n'); // cmd.exe misparses LF-only batch files
const normalize = (s) => s.replace(/\r\n/g, '\n');

export function renderUpdateLauncher(pluginRoot, { platform = process.platform, nodeExe = process.execPath } = {}) {
  const template = readFileSync(join(pluginRoot, 'templates', updateTemplateName(platform)), 'utf8');
  // `wsl.exe --cd` accepts an absolute Windows path OR an absolute Linux path.
  // A drvfs clone (/mnt/<d>/...) bakes its Windows form; an ext4 clone has NO
  // Windows form (backslashifying yields a path valid nowhere — the window
  // would flash-and-close), so its POSIX path passes through unchanged.
  // The native template needs the same value for `cd /d`, and gets a correct
  // one from the same rule: rendering on win32 the root is already drive-form.
  const posix = pluginRoot.replace(/\\/g, '/');
  const cdPath = /^\/mnt\/[a-z](\/|$)/.test(posix) || !posix.startsWith('/') ? toWindowsPath(posix) : posix;
  // BAKE THE RENDERING RUNTIME, never a PATH lookup: node is measurably not on
  // the PATH a double-clicked .bat inherits on a native-Windows host
  // (ffe7c416 defect 1), while process.execPath is a runtime already proven to
  // run. The generated file still falls back to a PATH `node` if the baked one
  // is gone (an upgrade moved it), and refuses loudly if neither resolves.
  // The node path gets the SAME treatment as cdPath above, and for the same
  // reason. A bare `.replace(/\//g,'\\')` backslashified unconditionally, so a
  // POSIX process.execPath rendered as `\home\u\...\node` — the leading slash
  // became a backslash and the absolute root was LOST, producing a launcher
  // that could never find its interpreter. Caught by the updater render pins
  // added under ffe7c416, which is precisely what they were written for: the
  // defect predates them and no earlier test rendered this template at all.
  const posixNode = nodeExe.replace(/\\/g, '/');
  const bakedNode = /^\/mnt\/[a-z](\/|$)/.test(posixNode) || !posixNode.startsWith('/')
    ? toWindowsPath(posixNode)
    : posixNode;
  const body = template
    .replaceAll('{{WIN_PLUGIN_DIR}}', cdPath)
    .replaceAll('{{WIN_NODE_EXE}}', bakedNode);
  return crlf(stampBody(body, 'rem'));
}

/**
 * Ensure semantics (§12): created / matches / refreshed / differs / skipped —
 * never overwrites content it cannot prove it generated. Also ensures the
 * target's .gitignore carries the entry (per-entry append, non-destructive):
 * the fan-out reaches projects whose init predates this launcher, and a
 * generated machine artifact must never surface as untracked noise in a
 * sibling repo.
 *
 * REFRESH (board bb3aa162): a mismatch against the freshly rendered expected
 * no longer means "leave it, might be hand-edited" — the on-disk file's own
 * embedded content-hash marker (generated-marker.mjs) proves whether it was
 * touched since ITS generation. Unmodified-but-stale (a clone move, a
 * template edit) refreshes freely; a marker mismatch (or no marker at all —
 * a legacy or foreign file) still leaves it untouched as 'differs'.
 */
export function ensureUpdateLauncher(target, pluginRoot, opts = {}) {
  if (!existsSync(target)) {
    return { status: 'skipped', detail: `target missing: ${target}` };
  }
  // Guard the template this HOST will actually render (a win32 host needs the
  // native one), so a clone missing it skips loudly instead of throwing.
  const templateName = updateTemplateName(opts.platform ?? process.platform);
  if (!existsSync(join(pluginRoot, 'templates', templateName))) {
    return { status: 'skipped', detail: `templates/${templateName} missing in the clone` };
  }
  const expected = renderUpdateLauncher(pluginRoot, opts);
  const launcherPath = join(target, UPDATE_LAUNCHER_NAME);

  let result;
  if (!existsSync(launcherPath)) {
    writeFileSync(launcherPath, expected);
    result = { status: 'created', detail: 'double-click -> update the Sterling clone (no session in the loop)' };
  } else {
    const diskNorm = normalize(readFileSync(launcherPath, 'utf8'));
    if (diskNorm === normalize(expected)) {
      result = { status: 'matches', detail: 'unchanged' };
    } else {
      const stamp = verifyStamp(diskNorm, 'rem');
      if (stamp && stamp.unmodified) {
        writeFileSync(launcherPath, expected);
        result = { status: 'refreshed', detail: 'regenerated: unmodified since last generation, but this machine now renders it differently (clone moved or template changed)' };
      } else {
        result = { status: 'differs', detail: 'left untouched (hand-edited or other machine) — delete and re-run init to regenerate' };
      }
    }
  }

  const gitignorePath = join(target, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (!existing.split(/\r?\n/).includes(UPDATE_LAUNCHER_NAME)) {
    appendFileSync(gitignorePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${UPDATE_LAUNCHER_NAME}\n`);
  }
  return result;
}
