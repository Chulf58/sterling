// Recognising an older generated launcher (decision init-and-update-refresh-an-older-
// generated-launcher). init rewrites sterling-launch.sh, sterling.bat or tui.bat when the
// file on disk is a pristine render of an EARLIER version of its template, and leaves
// anything else alone as a hand edit.
//
// MATCHING: each historical template is split into literal segments at its {{TOKEN}}
// placeholders (the headSegments approach in scripts/init-impl.mjs; never one big
// wildcard regex, anti-pattern wildcard-regex-over-multi-kb-legacy-text-hits-v8-regexp-
// too-large). The file must start with the first segment, end with the last, and hold
// every middle segment in order. The text between two segments is that placeholder's
// value and must pass the placeholder's validator in PLACEHOLDER_VALUES, which accepts
// only what some version of init could have rendered there. A placeholder with no
// validator fails closed (no match). So an old render with any machine paths, session
// name or split ratio matches; a line added, removed or changed outside a placeholder,
// or text appended to a value (flags after "$CLAUDE_BIN"), does not. Both sides are
// CR-stripped first.
//
// WHERE THE VERSIONS COME FROM: on a clone, git. The templates' own log gives the earlier
// template texts. The {{PLUGIN_PATHS}} installed-copy block is rendered by
// scripts/lib/launcher-tmux.mjs from scripts/lib/sterling-roots.mjs, so its earlier values
// come from running each committed version of those modules (installedBlockAt). An
// installed copy (no git, decision sterling-ships-as-a-marketplace-plugin-authoring-
// machine-keeps-its-clone) reads bin/launcher-history.json, which build:bin writes from
// the same git walk (launcherHistorySnapshot). The snapshot leaves out the current texts,
// so committing a template edit does not make bin/ stale; editing it does, and the bundle
// freshness check then asks for a rebuild, which adds the version just replaced. With the
// snapshot missing or unparseable an installed copy knows no older versions: `degraded`
// says why, and every differing launcher is left alone.
//
// Builtins only (bundled into bin/init.mjs).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isInstalledCopy } from './installed-copy.mjs';
import { INSTALLED_PATHS } from './launcher-tmux.mjs';

/** The launcher templates init renders, by file name under templates/. */
export const LAUNCHER_TEMPLATES = ['launcher-tmux.sh', 'launcher-win.bat', 'tui-win.bat'];
export const LAUNCHER_HISTORY_REL = 'bin/launcher-history.json';
/** Snapshot key for the earlier installed-copy {{PLUGIN_PATHS}} blocks. */
export const INSTALLED_BLOCKS_KEY = 'installed-plugin-paths';

const lf = (s) => s.replace(/\r\n/g, '\n');

const BARE_PATH = /^[^"\n]+$/;
const QUOTED_PATH = /^"[^"\n]+"$/;
/**
 * Every placeholder any version of the three launcher templates carries, with what any
 * version of init rendered into it (scripts/init-impl.mjs and scripts/init.mjs history):
 *   SESSION            sterling-<basename lower-cased, non [a-z0-9] runs as '-'>
 *   SPLIT_RATIO        a percent (tmux, today's bats) or the 0..1 fraction (2026-06 bats)
 *   PLUGIN_DIR, TUI_BUNDLE, WIN_PROJECT_DIR   a path inside "..." in the template
 *   WT, NODE           a path, quoted by init itself
 *   CLAUDE             "<claude>" --plugin-dir "<clone>"
 *   CLAUDE_PLUGIN_FLAG '' (installed copy) or the authoring flag, unchanged since 43232a67
 *   PLUGIN_PATHS       the authoring PLUGIN_DIR/TUI_BUNDLE pair, or a known installed block
 * scripts/tests/launcher-refresh.test.mjs checks every historical placeholder is listed.
 */
export const PLACEHOLDER_VALUES = {
  SESSION: (v) => /^[a-z0-9-]+$/.test(v),
  SPLIT_RATIO: (v) => /^(?:\d+|\d*\.\d+)$/.test(v),
  PLUGIN_DIR: (v) => BARE_PATH.test(v),
  TUI_BUNDLE: (v) => BARE_PATH.test(v),
  WIN_PROJECT_DIR: (v) => BARE_PATH.test(v),
  WT: (v) => QUOTED_PATH.test(v),
  NODE: (v) => QUOTED_PATH.test(v),
  CLAUDE: (v) => /^"[^"\n]+" --plugin-dir "[^"\n]+"$/.test(v),
  CLAUDE_PLUGIN_FLAG: (v) => v === '' || v === ' --plugin-dir "$PLUGIN_DIR"',
  PLUGIN_PATHS: (v, { installedBlocks }) =>
    /^PLUGIN_DIR="[^"\n]+"\nTUI_BUNDLE="[^"\n]+"$/.test(v) || installedBlocks.has(v),
};

/**
 * The placeholder values when `text` is a render of `templateText`, else null.
 * @param {string} text
 * @param {string} templateText
 * @param {{installedBlocks?: Set<string>}} [ctx] the known installed {{PLUGIN_PATHS}} blocks
 * @returns {Record<string, string> | null}
 */
export function matchTemplateRender(text, templateText, { installedBlocks = new Set([INSTALLED_PATHS]) } = {}) {
  const parts = lf(templateText).split(/\{\{([A-Z_]+)\}\}/);
  const literals = parts.filter((_, i) => i % 2 === 0);
  const names = parts.filter((_, i) => i % 2 === 1);
  if (names.some((n) => !Object.hasOwn(PLACEHOLDER_VALUES, n))) return null;
  const body = lf(text);
  if (!literals[0].length || !body.startsWith(literals[0])) return null;
  if (!names.length) return body === literals[0] ? {} : null;
  return matchFrom(body, literals, names, 1, literals[0].length, { installedBlocks }, {});
}

// Places literals[i] after `pos` so the value before it passes names[i - 1]'s validator,
// then recurses. Backtracks over later occurrences of the same literal.
function matchFrom(body, literals, names, i, pos, ctx, values) {
  const lit = literals[i];
  const name = names[i - 1];
  const accepts = (value) => PLACEHOLDER_VALUES[name](value, ctx) && (!Object.hasOwn(values, name) || values[name] === value);
  if (i === literals.length - 1) {
    const at = body.length - lit.length;
    if (at < pos || !body.endsWith(lit)) return null;
    const value = body.slice(pos, at);
    return accepts(value) ? { ...values, [name]: value } : null;
  }
  for (let at = body.indexOf(lit, pos); at !== -1; at = body.indexOf(lit, at + 1)) {
    const value = body.slice(pos, at);
    if (accepts(value)) {
      const found = matchFrom(body, literals, names, i + 1, at + lit.length, ctx, { ...values, [name]: value });
      if (found) return found;
    }
    if (at >= body.length) break;
  }
  return null;
}

const currentText = (repoRoot, name) => lf(readFileSync(join(repoRoot, 'templates', name), 'utf8'));
const defaultGit = (repoRoot) => (args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

function gitLog(git, repoRoot, rels) {
  const log = git(['log', '--format=%H', '--', ...rels]);
  if (log.status !== 0) throw new Error(`launcher history: git log failed for ${rels.join(', ')} in ${repoRoot}: ${log.stderr}`);
  return log.stdout.split('\n').filter(Boolean);
}

const RENDERER_REL = 'scripts/lib/launcher-tmux.mjs';
// The renderer's relative-import closure as {rel: source}, read through `read(rel)`
// (null when the file is absent). Null when any file of it is absent: that commit could
// not run the renderer, so it never rendered a launcher (43232a67 is one, a lane commit
// that imports installed-copy.mjs before its own branch had it).
function rendererClosure(read) {
  const files = {};
  const pending = [RENDERER_REL];
  while (pending.length) {
    const rel = pending.pop();
    if (Object.hasOwn(files, rel)) continue;
    const src = read(rel);
    if (src === null) return null;
    files[rel] = src;
    for (const m of src.matchAll(/^import [^;]*? from '(\.{1,2}\/[^']+)';/gm)) {
      pending.push(join(dirname(rel), m[1]).split('\\').join('/'));
    }
  }
  return files;
}

// The installed {{PLUGIN_PATHS}} block launcher-tmux.mjs rendered at `sha`, or null when
// that version has no renderer. Its import closure is written to a temp dir as committed,
// then run in a child node against a template that is only {{PLUGIN_PATHS}}.
function installedBlockAt(git, sha) {
  const files = rendererClosure((rel) => {
    const show = git(['show', `${sha}:${rel}`]);
    return show.status === 0 ? show.stdout : null;
  });
  if (!files) return null;
  const dir = mkdtempSync(join(tmpdir(), 'sterling-launcher-history-'));
  try {
    for (const [rel, src] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), src);
    }
    mkdirSync(join(dir, 'templates'));
    writeFileSync(join(dir, 'templates', 'launcher-tmux.sh'), '{{PLUGIN_PATHS}}');
    const program = `import { renderTmuxLauncher } from ${JSON.stringify(pathToFileURL(join(dir, RENDERER_REL)).href)};
process.stdout.write(renderTmuxLauncher(${JSON.stringify(dir)}, { session: 's', splitPercent: 1, installed: true }));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`launcher history: rendering ${RENDERER_REL} at ${sha} failed: ${run.stderr}`);
    return run.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// {templates: name → Set of committed texts, installedBlocks: Set} from git, or null when
// repoRoot is an installed copy. An installed copy returns null before git runs: nested
// inside an unrelated repo, `git log -- <rel>` would exit 0 with no commits.
function gitHistory(repoRoot, git) {
  if (isInstalledCopy(repoRoot)) return null;
  const templates = new Map();
  for (const name of LAUNCHER_TEMPLATES) {
    const rel = `templates/${name}`;
    const set = new Set();
    for (const sha of gitLog(git, repoRoot, [rel])) {
      const show = git(['show', `${sha}:${rel}`]);
      if (show.status === 0) set.add(lf(show.stdout));
    }
    templates.set(name, set);
  }
  // Only commits that touched a file the renderer imports today can change the block. A
  // file only an older version imported is not followed: a block missed that way just
  // fails to match, and the launcher is left alone.
  const closure = Object.keys(rendererClosure((rel) => readFileSync(join(repoRoot, rel), 'utf8')));
  const installedBlocks = new Set();
  for (const sha of gitLog(git, repoRoot, closure)) {
    const block = installedBlockAt(git, sha);
    if (block !== null && block !== INSTALLED_PATHS) installedBlocks.add(block);
  }
  return { templates, installedBlocks };
}

// {ok: true, data} or {ok: false, reason}. Only a missing file or bad content degrades;
// any other read error throws.
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
  if (!valid) return { ok: false, reason: `${path} is unparseable (expected an object of name → string[])` };
  return { ok: true, data: parsed };
}

/**
 * @typedef {object} LauncherHistory
 * @property {Map<string, string[]>} templates every EARLIER version of each template (LF)
 * @property {Set<string>} installedBlocks every installed {{PLUGIN_PATHS}} block, current included
 * @property {string|null} degraded why there is no history (installed copy, no snapshot), else null
 */

/**
 * @param {object} o
 * @param {string} o.repoRoot the plugin root
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string}} [o.git]
 * @returns {LauncherHistory}
 */
export function historicalLauncherTemplates({ repoRoot, git = defaultGit(repoRoot) }) {
  const fromGit = gitHistory(repoRoot, git);
  const templates = new Map();
  if (fromGit) {
    for (const name of LAUNCHER_TEMPLATES) {
      const current = currentText(repoRoot, name);
      templates.set(name, [...fromGit.templates.get(name)].filter((t) => t !== current));
    }
    return { templates, installedBlocks: new Set([INSTALLED_PATHS, ...fromGit.installedBlocks]), degraded: null };
  }
  const path = join(repoRoot, LAUNCHER_HISTORY_REL);
  const snapshot = loadSnapshot(path);
  for (const name of LAUNCHER_TEMPLATES) templates.set(name, snapshot.ok ? (snapshot.data[name] ?? []).map(lf) : []);
  const installedBlocks = new Set([INSTALLED_PATHS, ...(snapshot.ok ? snapshot.data[INSTALLED_BLOCKS_KEY] ?? [] : [])]);
  const degraded = snapshot.ok ? null : `no git history at ${repoRoot} (installed plugin copy) and ${snapshot.reason}`;
  return { templates, installedBlocks, degraded };
}

/**
 * The placeholder values of the earlier version of templates/<templateName> that `text`
 * renders, or null when it renders none.
 * @param {string} text
 * @param {string} templateName one of LAUNCHER_TEMPLATES
 * @param {LauncherHistory} history
 * @returns {Record<string, string> | null}
 */
export function olderGeneratedLauncher(text, templateName, history) {
  for (const t of history.templates.get(templateName) ?? []) {
    const values = matchTemplateRender(text, t, { installedBlocks: history.installedBlocks });
    if (values) return values;
  }
  return null;
}

/**
 * The bin/launcher-history.json content: for each launcher template, every distinct
 * committed version minus the current working-tree text, and the earlier installed
 * {{PLUGIN_PATHS}} blocks minus the current one. Sorted keys and arrays, trailing
 * newline. Throws when there is no git history (a snapshot of nothing would ship silently).
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string}} [o.git]
 */
export function launcherHistorySnapshot({ repoRoot, git = defaultGit(repoRoot) }) {
  const history = gitHistory(repoRoot, git);
  if (!history) throw new Error(`launcher history: no git history at ${repoRoot} — ${LAUNCHER_HISTORY_REL} can only be built from a clone`);
  const out = { [INSTALLED_BLOCKS_KEY]: [...history.installedBlocks].sort() };
  for (const name of LAUNCHER_TEMPLATES) {
    const current = currentText(repoRoot, name);
    out[name] = [...history.templates.get(name)].filter((t) => t !== current).sort();
  }
  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}
