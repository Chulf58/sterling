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
// the same git walk (launcherHistorySnapshot). A renderer version that cannot run in
// isolation is skipped like a missing closure and reported once (replayFailures), never
// thrown: one bad commit must not crash init, the update ensure pass or build:bin. The snapshot leaves out the current texts,
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

/**
 * The one loud line for renderer versions that could not be replayed; `consequence` says
 * what that costs. When every version failed for the same reason (the whole child died),
 * the reason is stated once, not once per version.
 */
export const replayFailureLine = (failures, consequence) => {
  const reasons = failures.map((f) => f.slice(f.indexOf(': ') + 2));
  const detail = failures.length > 1 && reasons.every((r) => r === reasons[0]) ? `all: ${reasons[0]}` : failures.join('; ');
  return `launcher history: ${failures.length} earlier renderer version(s) could not be replayed (${detail}); ${consequence}`;
};

const currentText = (repoRoot, name) => lf(readFileSync(join(repoRoot, 'templates', name), 'utf8'));
// A git runner: (args, {input?, encoding?}) -> {status, stdout, stderr}. `input` is stdin (a Buffer with encoding buffer);
// `encoding: 'buffer'` returns stdout as a Buffer (cat-file sizes are in bytes).
const defaultGit = (repoRoot) => (args, { input, encoding = 'utf8' } = {}) =>
  spawnSync('git', args, { cwd: repoRoot, encoding, input, maxBuffer: 256 * 1024 * 1024 });

function gitLog(git, repoRoot, rels) {
  const log = git(['log', '--full-history', '--format=%H', '--', ...rels]);
  if (log.status !== 0) throw new Error(`launcher history: git log failed for ${rels.join(', ')} in ${repoRoot}: ${log.stderr}`);
  return log.stdout.split('\n').filter(Boolean);
}

// Blob contents by `<sha>:<path>` spec, read through `git cat-file --batch`: one process
// for any number of blobs, where one `git show` each cost ~100 ms apiece on a WSL2 /mnt/c
// clone (the whole replay took 4.4 s). `fetch(specs)` reads the specs not yet held in one
// call; `get(spec)` is the text, or null when the path is absent at that commit.
function gitBlobs(git) {
  const held = new Map();
  const fetch = (specs) => {
    const need = [...new Set(specs)].filter((spec) => !held.has(spec));
    if (!need.length) return;
    const run = git(['cat-file', '--batch'], { input: Buffer.from(`${need.join('\n')}\n`), encoding: 'buffer' });
    if (run.status !== 0) throw new Error(`launcher history: git cat-file --batch failed: ${run.stderr}`);
    const out = run.stdout;
    let pos = 0;
    for (const spec of need) {
      const eol = out.indexOf(0x0a, pos);
      if (eol === -1) throw new Error(`launcher history: git cat-file --batch ended before ${spec}`);
      const header = out.subarray(pos, eol).toString('utf8');
      pos = eol + 1;
      if (header.endsWith(' missing')) {
        held.set(spec, null);
        continue;
      }
      const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (!m || m[1] !== 'blob') throw new Error(`launcher history: unexpected git cat-file --batch header for ${spec}: ${header}`);
      const size = Number(m[2]);
      held.set(spec, out.subarray(pos, pos + size).toString('utf8'));
      pos += size + 1;
    }
  };
  return { fetch, get: (spec) => { fetch([spec]); return held.get(spec); } };
}

const RENDERER_REL = 'scripts/lib/launcher-tmux.mjs';
// Relative `import ... from` and `export ... from` specifiers, single or double quoted.
const RELATIVE_SPECIFIER = /^(?:import|export) [^;]*? from (['"])(\.{1,2}\/[^'"]+)\1;/gm;
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
    for (const m of src.matchAll(RELATIVE_SPECIFIER)) {
      pending.push(join(dirname(rel), m[2]).split('\\').join('/'));
    }
  }
  return files;
}

// rendererClosure for many commits at once, one batched read per LEVEL of the import
// graph: every spec any pending closure still needs goes into one `blobs.fetch`, then the
// next level's imports are collected, until no new specs appear. So the number of git
// calls follows the import depth, not the number of commits or of files only an older
// renderer imported. Commits whose closure has an absent file are left out (see
// rendererClosure). Returns Map sha -> {rel: source}.
function rendererClosures(blobs, shas) {
  const states = shas.map((sha) => ({ sha, files: {}, next: [RENDERER_REL], dead: false }));
  for (let live = states; live.length; live = live.filter((s) => !s.dead && s.next.length)) {
    blobs.fetch(live.flatMap((s) => s.next.map((rel) => `${s.sha}:${rel}`)));
    for (const s of live) {
      const level = s.next;
      s.next = [];
      for (const rel of level) {
        if (Object.hasOwn(s.files, rel)) continue;
        const src = blobs.get(`${s.sha}:${rel}`);
        if (src === null) {
          s.dead = true;
          break;
        }
        s.files[rel] = src;
        for (const m of src.matchAll(RELATIVE_SPECIFIER)) s.next.push(join(dirname(rel), m[2]).split('\\').join('/'));
      }
    }
  }
  return new Map(states.filter((s) => !s.dead).map((s) => [s.sha, s.files]));
}

// The installed {{PLUGIN_PATHS}} block each renderer version rendered, in ONE child node.
// Every version's import closure is written to its own temp dir as committed, and the
// child imports each and renders against a template that is only {{PLUGIN_PATHS}}. A
// version that cannot run in isolation (a throw, a missing module) is a failure of that
// version alone: {block: null, error}, never an exception, so one bad commit cannot take
// down init, the update ensure pass or build:bin. A child that dies as a whole fails
// every version with its stderr.
// @param {{files: Record<string, string>}[]} versions
// @returns {{block: string|null, error: string|null}[]} one per version, in order
function replayRenderers(versions, spawn) {
  if (!versions.length) return [];
  const root = mkdtempSync(join(tmpdir(), 'sterling-launcher-history-'));
  try {
    const dirs = versions.map(({ files }, i) => {
      const dir = join(root, String(i));
      for (const [rel, src] of Object.entries(files)) {
        mkdirSync(join(dir, dirname(rel)), { recursive: true });
        writeFileSync(join(dir, rel), src);
      }
      mkdirSync(join(dir, 'templates'));
      writeFileSync(join(dir, 'templates', 'launcher-tmux.sh'), '{{PLUGIN_PATHS}}');
      return dir;
    });
    const urls = dirs.map((dir) => pathToFileURL(join(dir, RENDERER_REL)).href);
    const program = `const dirs = ${JSON.stringify(dirs)};
const urls = ${JSON.stringify(urls)};
const out = [];
for (const [i, dir] of dirs.entries()) {
  try {
    const mod = await import(urls[i]);
    out.push({ block: mod.renderTmuxLauncher(dir, { session: 's', splitPercent: 1, installed: true }), error: null });
  } catch (err) {
    out.push({ block: null, error: String(err?.message ?? err).split('\\n')[0] });
  }
}
process.stdout.write(JSON.stringify(out));`;
    const run = spawn(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' });
    const died = (why) => versions.map(() => ({ block: null, error: why }));
    if (run.status !== 0) {
      const exit = run.status === null ? 'did not exit normally' : `exited ${run.status}`;
      const detail = [(run.stderr ?? '').trim().split('\n')[0], run.error?.message, run.signal && `signal ${run.signal}`].filter(Boolean).join('; ');
      return died(`the replay process ${exit}${detail ? `: ${detail}` : ''}`);
    }
    let results;
    try {
      results = JSON.parse(run.stdout);
    } catch (err) {
      return died(`the replay process printed unparseable output (${err.message})`);
    }
    if (!Array.isArray(results) || results.length !== versions.length) {
      return died(`the replay process printed unexpected output (expected ${versions.length} results)`);
    }
    return results.map((r) => (typeof r?.block === 'string' ? r : { block: null, error: r?.error ?? 'the renderer returned no text' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// {templates: name → Set of committed texts, installedBlocks: Set, replayFailures:
// string[]} from git, or null when repoRoot is an installed copy. An installed copy
// returns null before git runs: nested inside an unrelated repo, `git log -- <rel>` would
// exit 0 with no commits.
function gitHistory(repoRoot, git, spawn) {
  if (isInstalledCopy(repoRoot)) return null;
  const blobs = gitBlobs(git);
  // Only commits that touched a file the renderer imports today can change the block. A
  // file only an older version imported is not followed: a block missed that way just
  // fails to match, and the launcher is left alone. Commits whose closures are
  // byte-identical render the same block, so each distinct closure is replayed once.
  const closure = Object.keys(rendererClosure((rel) => readFileSync(join(repoRoot, rel), 'utf8')));
  const templateRels = LAUNCHER_TEMPLATES.map((name) => `templates/${name}`);
  // One log for the templates and the closure together (one history walk, not four, each
  // ~0.5 s on a WSL2 /mnt/c clone). A commit that touched only some of those files is read
  // for all of them, which only adds commits whose texts are already listed. --full-history
  // is required: with several paths, default merge simplification follows only the side
  // of a merge that matches the result for ALL of them, and drops the versions that
  // existed only on the other side (a mainline v1 -> v1.5 -> v1 revert vanishes behind a
  // merge of a branch that touched just the renderer).
  const shas = gitLog(git, repoRoot, [...templateRels, ...closure]);
  // Every blob the walk needs that is known up front, in one cat-file call. A file only an
  // older renderer imports is read in rendererClosures, one batched call per import level.
  blobs.fetch(shas.flatMap((sha) => [...templateRels, ...closure].map((rel) => `${sha}:${rel}`)));
  const templates = new Map();
  for (const name of LAUNCHER_TEMPLATES) {
    const set = new Set();
    for (const sha of shas) {
      const text = blobs.get(`${sha}:templates/${name}`);
      if (text !== null) set.add(lf(text));
    }
    templates.set(name, set);
  }
  const versions = new Map();
  for (const [sha, files] of rendererClosures(blobs, shas)) {
    const key = JSON.stringify(Object.entries(files).sort(([x], [y]) => (x < y ? -1 : 1)));
    if (!versions.has(key)) versions.set(key, { sha, files });
  }
  const replayed = [...versions.values()];
  const installedBlocks = new Set();
  const replayFailures = [];
  replayRenderers(replayed, spawn).forEach(({ block, error }, i) => {
    if (block === null) replayFailures.push(`${replayed[i].sha.slice(0, 8)}: ${error}`);
    else if (block !== INSTALLED_PATHS) installedBlocks.add(block);
  });
  return { templates, installedBlocks, replayFailures };
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
 * @property {string[]} replayFailures one "<sha8>: <reason>" per renderer version that could not be replayed; the blocks only it rendered are unknown, so launchers rendered by it are left untouched
 */

/**
 * @param {object} o
 * @param {string} o.repoRoot the plugin root
 * @param {(args: string[], opts?: {input?: Buffer, encoding?: string}) => {status: number|null, stdout: string|Buffer, stderr: string}} [o.git]
 * @param {typeof spawnSync} [o.spawn] runs the one child node that replays the renderer versions
 * @returns {LauncherHistory}
 */
export function historicalLauncherTemplates({ repoRoot, git = defaultGit(repoRoot), spawn = spawnSync }) {
  const fromGit = gitHistory(repoRoot, git, spawn);
  const templates = new Map();
  if (fromGit) {
    for (const name of LAUNCHER_TEMPLATES) {
      const current = currentText(repoRoot, name);
      templates.set(name, [...fromGit.templates.get(name)].filter((t) => t !== current));
    }
    return { templates, installedBlocks: new Set([INSTALLED_PATHS, ...fromGit.installedBlocks]), degraded: null, replayFailures: fromGit.replayFailures };
  }
  const path = join(repoRoot, LAUNCHER_HISTORY_REL);
  const snapshot = loadSnapshot(path);
  for (const name of LAUNCHER_TEMPLATES) templates.set(name, snapshot.ok ? (snapshot.data[name] ?? []).map(lf) : []);
  const installedBlocks = new Set([INSTALLED_PATHS, ...(snapshot.ok ? snapshot.data[INSTALLED_BLOCKS_KEY] ?? [] : [])]);
  const degraded = snapshot.ok ? null : `no git history at ${repoRoot} (installed plugin copy) and ${snapshot.reason}`;
  return { templates, installedBlocks, degraded, replayFailures: [] };
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
 * A renderer version that cannot be replayed is left out and reported once through `warn`
 * (default: stderr), so the build still completes.
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {(args: string[], opts?: {input?: Buffer, encoding?: string}) => {status: number|null, stdout: string|Buffer, stderr: string}} [o.git]
 * @param {typeof spawnSync} [o.spawn]
 * @param {(line: string) => void} [o.warn]
 */
export function launcherHistorySnapshot({ repoRoot, git = defaultGit(repoRoot), spawn = spawnSync, warn = (line) => process.stderr.write(`${line}\n`) }) {
  const history = gitHistory(repoRoot, git, spawn);
  if (!history) throw new Error(`launcher history: no git history at ${repoRoot} — ${LAUNCHER_HISTORY_REL} can only be built from a clone`);
  if (history.replayFailures.length) warn(replayFailureLine(history.replayFailures, `${LAUNCHER_HISTORY_REL} was built without them`));
  const out = { [INSTALLED_BLOCKS_KEY]: [...history.installedBlocks].sort() };
  for (const name of LAUNCHER_TEMPLATES) {
    const current = currentText(repoRoot, name);
    out[name] = [...history.templates.get(name)].filter((t) => t !== current).sort();
  }
  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}
