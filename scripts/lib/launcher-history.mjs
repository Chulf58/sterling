// Recognising an older generated launcher (decision init-and-update-refresh-an-older-
// generated-launcher). init rewrites sterling-launch.sh, sterling.bat or tui.bat when the
// file on disk is a pristine render of an EARLIER version of its template, and leaves
// anything else alone as a hand edit.
//
// MATCHING: each historical template is split into literal segments at its {{TOKEN}}
// placeholders (the headSegments approach in scripts/init-impl.mjs; never one big
// wildcard regex, anti-pattern wildcard-regex-over-multi-kb-legacy-text-hits-v8-regexp-
// too-large). The file must start with the first segment, end with the last, and hold
// every middle segment in order. The text between two segments is a placeholder's value
// and must fit on one line, except {{PLUGIN_PATHS}}, whose value must be one of the two
// blocks scripts/lib/launcher-tmux.mjs renders (isPluginPathsBlock). So any old set of
// machine paths, session name or split ratio still matches; an added, removed or changed
// line outside a placeholder value does not. Both sides are CR-stripped first.
//
// WHERE THE VERSIONS COME FROM: on a clone, the templates' git log. An installed copy
// (no git, decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-
// clone) reads bin/launcher-history.json, which build:bin writes from the same git walk
// (launcherHistorySnapshot). The snapshot leaves out each template's current text, so
// committing a template edit does not make bin/ stale; editing the template does, and
// the bundle freshness check then asks for a rebuild, which adds the version just
// replaced. With the snapshot missing or unparseable an installed copy knows no older
// versions: every differing launcher is left alone, and that degraded path is said once.
//
// Builtins only (bundled into bin/init.mjs).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInstalledCopy } from './installed-copy.mjs';
import { isPluginPathsBlock } from './launcher-tmux.mjs';

/** The launcher templates init renders, by file name under templates/. */
export const LAUNCHER_TEMPLATES = ['launcher-tmux.sh', 'launcher-win.bat', 'tui-win.bat'];
export const LAUNCHER_HISTORY_REL = 'bin/launcher-history.json';

const lf = (s) => s.replace(/\r\n/g, '\n');

const gapFits = (name, gap) => (name === 'PLUGIN_PATHS' ? isPluginPathsBlock(gap) : !gap.includes('\n'));

/**
 * True when `text` is a render of `templateText` with some value in each placeholder.
 * @param {string} text
 * @param {string} templateText
 */
export function matchesTemplateRender(text, templateText) {
  const parts = lf(templateText).split(/\{\{([A-Z_]+)\}\}/);
  const literals = parts.filter((_, i) => i % 2 === 0);
  const names = parts.filter((_, i) => i % 2 === 1);
  const body = lf(text);
  if (!literals[0].length || !body.startsWith(literals[0])) return false;
  if (literals.length === 1) return body === literals[0];
  return matchFrom(body, literals, names, 1, literals[0].length);
}

// Places literals[i] after `pos` so the gap before it fits names[i - 1], then recurses.
// A gap that fails the one-line rule only grows as the search moves right, so the scan
// stops there; a {{PLUGIN_PATHS}} gap keeps searching, since it spans lines by design.
function matchFrom(body, literals, names, i, pos) {
  const lit = literals[i];
  const name = names[i - 1];
  if (i === literals.length - 1) {
    const at = body.length - lit.length;
    return at >= pos && body.endsWith(lit) && gapFits(name, body.slice(pos, at));
  }
  for (let at = body.indexOf(lit, pos); at !== -1 && at <= body.length; at = body.indexOf(lit, at + 1)) {
    const gap = body.slice(pos, at);
    if (gapFits(name, gap)) {
      if (matchFrom(body, literals, names, i + 1, at + lit.length)) return true;
    } else if (name !== 'PLUGIN_PATHS') {
      return false;
    }
    if (at === body.length) break;
  }
  return false;
}

// name → Set of every committed version (LF), or null when repoRoot is an installed copy.
// An installed copy returns null before git runs: nested inside an unrelated repo,
// `git log -- <rel>` would exit 0 with no commits and hide the missing history.
function gitVersions(repoRoot, git) {
  if (isInstalledCopy(repoRoot)) return null;
  const versions = new Map();
  for (const name of LAUNCHER_TEMPLATES) {
    const rel = `templates/${name}`;
    const log = git(['log', '--format=%H', '--', rel]);
    if (log.status !== 0) throw new Error(`launcher history: git log failed for ${rel} in ${repoRoot}: ${log.stderr}`);
    const set = new Set();
    for (const sha of log.stdout.split('\n').filter(Boolean)) {
      const show = git(['show', `${sha}:${rel}`]);
      if (show.status === 0) set.add(lf(show.stdout));
    }
    versions.set(name, set);
  }
  return versions;
}

const currentText = (repoRoot, name) => lf(readFileSync(join(repoRoot, 'templates', name), 'utf8'));
const defaultGit = (repoRoot) => (args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

// {ok: true, versions} or {ok: false, reason}. Only a missing file or bad content
// degrades; any other read error throws.
function loadSnapshot(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, reason: `${path} is missing` };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `${path} is unparseable (${err.message})` };
  }
  const valid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    && Object.values(parsed).every((v) => Array.isArray(v) && v.every((t) => typeof t === 'string'));
  if (!valid) return { ok: false, reason: `${path} is unparseable (expected an object of template name → string[])` };
  return { ok: true, versions: parsed };
}

/**
 * Every EARLIER version of each launcher template (LF text, the current one left out).
 * @param {object} o
 * @param {string} o.repoRoot the plugin root
 * @param {(line: string) => void} [o.warn] receives the one DEGRADED line
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string}} [o.git]
 * @returns {Map<string, string[]>}
 */
export function historicalLauncherTemplates({ repoRoot, warn = (line) => console.error(line), git = defaultGit(repoRoot) }) {
  const fromGit = gitVersions(repoRoot, git);
  const out = new Map();
  if (fromGit) {
    for (const name of LAUNCHER_TEMPLATES) {
      const current = currentText(repoRoot, name);
      out.set(name, [...fromGit.get(name)].filter((t) => t !== current));
    }
    return out;
  }
  const path = join(repoRoot, LAUNCHER_HISTORY_REL);
  const snapshot = loadSnapshot(path);
  if (!snapshot.ok) {
    warn(`⚠ launcher history DEGRADED — no git history at ${repoRoot} (installed plugin copy) and ${snapshot.reason}; an older generated launcher cannot be recognised, so every differing launcher is left untouched`);
  }
  for (const name of LAUNCHER_TEMPLATES) out.set(name, snapshot.ok ? (snapshot.versions[name] ?? []).map(lf) : []);
  return out;
}

/**
 * True when `text` is a render of an earlier version of templates/<templateName>.
 * @param {string} text
 * @param {string} templateName one of LAUNCHER_TEMPLATES
 * @param {Map<string, string[]>} history from historicalLauncherTemplates
 */
export function isOlderGeneratedLauncher(text, templateName, history) {
  return (history.get(templateName) ?? []).some((t) => matchesTemplateRender(text, t));
}

/**
 * The bin/launcher-history.json content: for each launcher template, every distinct
 * committed version minus the current working-tree text. Sorted keys and arrays,
 * trailing newline. Throws when there is no git history (a snapshot of nothing would
 * ship silently).
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string}} [o.git]
 */
export function launcherHistorySnapshot({ repoRoot, git = defaultGit(repoRoot) }) {
  const versions = gitVersions(repoRoot, git);
  if (!versions) throw new Error(`launcher history: no git history at ${repoRoot} — ${LAUNCHER_HISTORY_REL} can only be built from a clone`);
  const out = {};
  for (const name of [...LAUNCHER_TEMPLATES].sort()) {
    const current = currentText(repoRoot, name);
    out[name] = [...versions.get(name)].filter((t) => t !== current).sort();
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}
