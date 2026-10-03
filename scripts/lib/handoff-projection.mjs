// Handoff projection core (decision
// init-prepares-opencode-portable-agents-and-target-handoff-projections, refinements
// (a), (e), (f), (g)). Pure rendering plus the file-set planning the CLI
// (scripts/handoff-projection.mjs) applies. For a TARGET project, never for the
// Sterling clone, whose own architecture.md / rulings.md are produced by
// scripts/architecture-projection.mjs and scripts/rulings-projection.mjs.
//
// Output, all committed in the target for engineers who do not have Sterling:
//   architecture.md                       index of feature articles (title, paths, link)
//   rulings.md                            index of decisions and anti-patterns
//   docs/sterling/articles/<slug>.md      complete text, one file per record
//   docs/sterling/decisions/<slug>.md
//   docs/sterling/anti-patterns/<slug>.md
// The root files stay INDEXES, so the AGENTS.md bullet every initialized target
// already carries ("architecture.md says what each area does…") is true without a
// migration, and nothing is clipped: each index line links the full record
// (AGENTS.md: "a summary is a lookup, never a source").
// Deterministic: no timestamps, stable filenames and ordering, so an unchanged
// store reproduces the same bytes and the CLI writes nothing.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { existsContained, readContained, readdirContained } from './contained-fs.mjs';

const fwd = (p) => p.replace(/\\/g, '/');

// The Sterling clone is never a handoff target: it has its own projections and
// its own engineers have Sterling. Identity: the same one init uses
// (STERLING_PLUGIN_ROOT_MATCH, else the running plugin root), plus any other clone
// recognized by its manifest — a worktree or second checkout of Sterling included.
// The manifest probe reads TARGET paths, so it goes through contained-fs: a
// symlinked plugin.json (or directory on the way) throws ContainmentError rather
// than spoofing a silent "clone, skipped" (Sol re-check). Callers turn that into
// an actionable refusal.
export function isSterlingClone(root, pluginRoot) {
  if (fwd(resolve(root)) === fwd(resolve(process.env.STERLING_PLUGIN_ROOT_MATCH || pluginRoot))) return true;
  const manifest = '.claude-plugin/plugin.json';
  if (!existsContained(root, manifest, 'file') || !existsContained(root, 'scripts/architecture-projection.mjs', 'file')) return false;
  return JSON.parse(readContained(root, manifest)).name === 'sterling';
}

// Project mode (decision project-mode-hobby-work-toggle-decides-flow, narrowed by
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
// config.mode decides only how work ships, a direct merge (hobby) or a pull
// request with the review loop (work). Every surface that acts on it reads the
// TARGET project's own config through this one function, never the caller's. A
// missing config or a missing key is hobby, the schema default. An invalid
// value, or a config that is not a JSON object, throws: the mode is never
// guessed. Reads go through contained-fs like every other target read.
export const PROJECT_MODES = ['hobby', 'work'];
export class ProjectModeError extends Error {}
const CONFIG_REL = '.sterling/config.json';
// The target's raw config object (undefined when the file is absent) and its
// path for messages. A file that is not a JSON object throws `ErrorClass`,
// naming the `subject` that could not be read.
function readRawConfig(root, ErrorClass, subject) {
  const where = `${fwd(resolve(root))}/${CONFIG_REL}`;
  if (!existsContained(root, CONFIG_REL, 'file')) return { where, parsed: undefined };
  let parsed;
  try {
    parsed = JSON.parse(readContained(root, CONFIG_REL));
  } catch (err) {
    throw new ErrorClass(`${where} is not valid JSON (${err.message}) — ${subject} cannot be read`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ErrorClass(`${where} is not a JSON object — ${subject} cannot be read`);
  }
  return { where, parsed };
}
export function readProjectMode(root) {
  const { where, parsed } = readRawConfig(root, ProjectModeError, 'the project mode');
  if (parsed === undefined || parsed.mode === undefined) return 'hobby';
  if (!PROJECT_MODES.includes(parsed.mode)) {
    throw new ProjectModeError(`config.mode is ${JSON.stringify(parsed.mode)} in ${where} — it must be 'hobby' or 'work'; switch it in the TUI System tab or fix the file`);
  }
  return parsed.mode;
}

// The handoff setting (decision
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
// config.handoff.enabled decides whether Sterling writes the files for
// colleagues who do not have Sterling, the portable OpenCode agents and this
// projection. It is independent of the mode and off by default. Every surface
// that writes those files (init, sync-agents, the /sterling:update fan-out, the
// projection CLI, the git exclude block) reads the TARGET's own config through
// readHandoffEnabled.
// An absent key is off, with one exception: when handoff files are already
// tracked in git the answer is on, so a project that committed these files
// before the setting existed keeps having them maintained. An explicit false
// always wins. A value that is not a boolean throws: it is never guessed. An
// absent key with a git that could not say what is tracked throws too
// (HandoffGitError): a failed git read is never read as "nothing tracked".
export const PORTABLE_AGENT_PATHS = ['.opencode/agents/implementor.md', '.opencode/agents/researcher.md', '.opencode/agents/scout.md'];
export const HANDOFF_OFF_DETAIL = 'handoff files are off (config.handoff.enabled is not true: the portable OpenCode agents and the handoff projection are not written; existing files are no longer maintained, and nothing is deleted)';
export class HandoffSettingError extends Error {}
// The key is absent and git could not answer. A HandoffSettingError, so every
// writer that refuses an invalid setting refuses this too; `reason` is the git
// error alone, for the banner and the System tab row.
export class HandoffGitError extends HandoffSettingError {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}
// The same timeout gitIgnored (scripts/hooks/lib/common.mjs) gives git.
const GIT_TIMEOUT_MS = 30_000;
// The handoff files git tracks in `root`, three-state like gitIgnored:
// { files, unknown }. `files` holds the tracked portable agents, anything under
// docs/sterling/, and a root architecture.md or rulings.md that carries the
// handoff marker (a project's own hand-written root file is not a handoff file).
// `unknown` is null when git answered, and "not a git work tree" is an answer:
// nothing is tracked. Any other failure (no git binary, a timeout, a corrupt
// index, a dubious-ownership refusal, a .git that git cannot use, a tracked root
// file that cannot be read) is `unknown: <reason>` with no files. The caller
// owns the degrade and must never read it as "nothing tracked".
export function trackedHandoffFiles(root, { spawn = spawnSync } = {}) {
  const run = (args) => {
    // LC_ALL=C: the "not a git repository" test below reads git's own message.
    const r = spawn('git', args, { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } });
    const name = `git ${args[0]}`;
    if (r.error) return { failed: r.error.code === 'ETIMEDOUT' ? `${name} timed out after ${GIT_TIMEOUT_MS / 1000}s` : `${name} did not run (${r.error.message})` };
    if (r.status !== 0) {
      const stderr = (r.stderr || '').trim().split('\n')[0];
      return { failed: `${name} exited ${r.status ?? `on signal ${r.signal}`}: ${stderr || 'no error output'}`, notARepo: r.status === 128 && /not a git repository/i.test(stderr) };
    }
    return { stdout: r.stdout || '' };
  };
  // A directory that does not exist holds nothing; asked there, git fails to
  // start with the same ENOENT a missing git binary gives.
  if (!existsSync(root)) return { files: [], unknown: null };
  const inside = run(['rev-parse', '--is-inside-work-tree']);
  if (inside.failed) {
    // "No repository" is trusted only when there is no .git here to be broken.
    if (inside.notARepo && !existsSync(join(root, '.git'))) return { files: [], unknown: null };
    return { files: [], unknown: inside.failed };
  }
  if (inside.stdout.trim() !== 'true') return { files: [], unknown: null };
  const ls = run(['ls-files', '-z', '--', ...PORTABLE_AGENT_PATHS, HANDOFF_DOCS_DIR, ...HANDOFF_ROOT_FILES]);
  if (ls.failed) return { files: [], unknown: ls.failed };
  const files = [];
  for (const rel of ls.stdout.split('\0').filter(Boolean)) {
    if (!HANDOFF_ROOT_FILES.includes(rel)) {
      files.push(rel);
      continue;
    }
    try {
      if (existsContained(root, rel, 'file') && readContained(root, rel).startsWith(HANDOFF_MARKER)) files.push(rel);
    } catch (err) {
      return { files: [], unknown: `${rel} is tracked but could not be read (${err.message})` };
    }
  }
  return { files, unknown: null };
}
// The handoff files present on disk in `root`, tracked or not: the portable
// agents, docs/sterling/ (named as the directory) and a marked root index.
export function handoffFilesOnDisk(root) {
  const found = PORTABLE_AGENT_PATHS.filter((rel) => existsContained(root, rel, 'file'));
  if (existsContained(root, HANDOFF_DOCS_DIR, 'dir')) found.push(`${HANDOFF_DOCS_DIR}/`);
  for (const rel of HANDOFF_ROOT_FILES) {
    if (existsContained(root, rel, 'file') && readContained(root, rel).startsWith(HANDOFF_MARKER)) found.push(rel);
  }
  return found;
}
// The setting for an already-parsed raw config object (undefined or null when
// the project has none): { enabled, source }. source is 'config' (the key is
// set), 'tracked' (no key, handoff files tracked in git) or 'default' (no key,
// nothing tracked).
export function handoffSettingOf(parsed, root, where = CONFIG_REL) {
  const block = parsed?.handoff;
  if (block !== undefined && (block === null || typeof block !== 'object' || Array.isArray(block))) {
    throw new HandoffSettingError(`config.handoff is ${JSON.stringify(block)} in ${where} — it must be an object like {"enabled": true}; switch it in the TUI System tab or fix the file`);
  }
  const value = block?.enabled;
  if (value === undefined) {
    const tracked = trackedHandoffFiles(root);
    if (tracked.unknown !== null) {
      throw new HandoffGitError(`config.handoff.enabled is not set in ${where} and git could not say whether handoff files are committed (${tracked.unknown}) — the setting is not guessed; repair the repository, or set config.handoff.enabled to true or false (TUI System tab)`, tracked.unknown);
    }
    return tracked.files.length ? { enabled: true, source: 'tracked' } : { enabled: false, source: 'default' };
  }
  if (typeof value !== 'boolean') {
    throw new HandoffSettingError(`config.handoff.enabled is ${JSON.stringify(value)} in ${where} — it must be true or false; switch it in the TUI System tab or fix the file`);
  }
  return { enabled: value, source: 'config' };
}
// The strict read of the TARGET's own config: { enabled, source, unmaintained }.
// `unmaintained` lists the handoff files on disk that nothing maintains any
// more: the key is absent and git tracks none of them, so the setting reads off
// while the files a previous version wrote are still there. Empty in every
// other state. Writers say so in one line (handoffUnmaintainedNotice) instead
// of dropping maintenance silently.
export function readHandoffSetting(root) {
  const { where, parsed } = readRawConfig(root, HandoffSettingError, 'the handoff setting');
  const setting = handoffSettingOf(parsed, root, where);
  return { ...setting, unmaintained: setting.source === 'default' ? handoffFilesOnDisk(root) : [] };
}
export function readHandoffEnabled(root) {
  return readHandoffSetting(root).enabled;
}
export function handoffUnmaintainedNotice(files) {
  return `handoff files NOT MAINTAINED — ${files.join(', ')} ${files.length === 1 ? 'exists' : 'exist'} on disk, not tracked in git, and config.handoff.enabled is not set: Sterling no longer maintains them and deletes nothing. Turn on the Handoff files row in the TUI System tab to keep them maintained.`;
}

export const HANDOFF_DOCS_DIR = 'docs/sterling';
export const HANDOFF_ROOT_FILES = ['architecture.md', 'rulings.md'];
export const HANDOFF_MARKER = '<!-- GENERATED by Sterling handoff projection';
// Root files written by the Sterling clone's own projection scripts, if someone
// ever ran them inside a target: Sterling-generated too, so replaceable.
const LEGACY_ROOT_MARKERS = ['<!-- GENERATED by scripts/architecture-projection.mjs', '<!-- GENERATED by scripts/rulings-projection.mjs'];

const HEADER = `${HANDOFF_MARKER} from this project's knowledge store — DO NOT EDIT.
     Regenerated by /sterling:init and /sterling:update. If it is wrong, say so in
     your commit message rather than editing it. -->`;

const TYPE_DIRS = { feature_article: 'articles', decision: 'decisions', anti_pattern: 'anti-patterns' };
// Every directory the projection may create — init's destructive-conflict preflight checks them.
export const HANDOFF_DIRS = [HANDOFF_DOCS_DIR, ...Object.values(TYPE_DIRS).map((d) => `${HANDOFF_DOCS_DIR}/${d}`)];
const TYPE_LABELS = { feature_article: 'Feature article', decision: 'Decision', anti_pattern: 'Anti-pattern' };
const NO_PATHS = 'No file paths';
const ROOT_AREA = '(repository root)';

export function isHandoffOwned(content, rel) {
  if (content.startsWith(HANDOFF_MARKER)) return true;
  return HANDOFF_ROOT_FILES.includes(rel) && LEGACY_ROOT_MARKERS.some((m) => content.startsWith(m));
}

export const isHandoffPath = (rel) => HANDOFF_ROOT_FILES.includes(rel) || rel.startsWith(`${HANDOFF_DOCS_DIR}/`);

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function pathsOf(r) {
  if (r.type === 'feature_article') return (r.files ?? []).map((f) => f.path);
  return r.file_keys ?? [];
}

// Area = the first path's directory, at most two segments deep ('src/importer',
// 'scripts'); a file at the top level is the repository root.
function areaOf(r) {
  const first = pathsOf(r)[0];
  if (!first) return NO_PATHS;
  const dirs = first.split('/').slice(0, -1);
  return dirs.length ? dirs.slice(0, 2).join('/') : ROOT_AREA;
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'record';
}

// Stable, unconditionally unique filenames: `<slug>-<id prefix>` (the slugified
// title when a record has no slug), lowercase. The id prefix starts at 8
// characters and grows while a case-folded collision persists — duplicate slugs,
// two ids sharing 8 characters, or two long slugs that truncate alike — up to the
// full id, which is unique. Assigned in id order, so input order never matters.
function assignFiles(records) {
  const taken = new Set();
  const sorted = [...records].sort((a, b) => byText(a.id, b.id));
  const fileOf = new Map();
  for (const r of sorted) {
    const dir = `${HANDOFF_DOCS_DIR}/${TYPE_DIRS[r.type]}`;
    const stem = slugify(r.slug ?? r.title);
    const id = String(r.id).toLowerCase();
    // prefix lengths: 8, then each later id group boundary (a uuid's dashes), then the full id
    const lengths = [8, ...[...id.matchAll(/-/g)].map((m) => m.index).filter((i) => i > 8), id.length].filter((n) => n <= id.length);
    let rel;
    for (const n of lengths) {
      rel = `${dir}/${stem}-${slugify(id.slice(0, n))}.md`;
      if (!taken.has(rel.toLowerCase())) break;
    }
    if (taken.has(rel.toLowerCase())) throw new Error(`handoff projection: two records resolve to ${rel} even with their full ids — refusing (P5)`);
    taken.add(rel.toLowerCase());
    fileOf.set(r.id, rel);
  }
  return fileOf;
}

const bullets = (items) => items.map((i) => `- ${i}`).join('\n');
const section = (heading, body) => (body && String(body).trim() ? `## ${heading}\n\n${String(body).trim()}\n` : null);
const pathList = (r) => {
  const paths = pathsOf(r);
  return paths.length ? bullets(paths.map((p) => `\`${p}\``)) : '_none_';
};

function renderRecord(r) {
  const handle = r.slug ? ` \`${r.slug}\`` : '';
  const facts = [`${TYPE_LABELS[r.type]}${handle}`, `status: ${r.status}`];
  if (r.type === 'anti_pattern') facts.push(`severity: ${r.severity ?? 'warn'}`);
  const parts = [HEADER, '', `# ${oneLine(r.title)}`, '', facts.join(' · '), ''];
  const sections = [];
  if (r.type === 'feature_article') {
    sections.push(section('What it does', r.what_it_does), section('Intended behavior', r.intended_behavior));
    // current_ac is a union (packages/schemas/src/records.ts): a list of
    // criteria, or { not_applicable: { reason } } for an article kind that has none.
    if (Array.isArray(r.current_ac)) {
      const acs = r.current_ac.map((ac) => `**${ac.ac_id}** — ${ac.text}`);
      if (acs.length) sections.push(section('Acceptance criteria', bullets(acs)));
    } else if (r.current_ac?.not_applicable) {
      sections.push(section('Acceptance criteria', `Not applicable: ${oneLine(r.current_ac.not_applicable.reason)}`));
    }
    const files = (r.files ?? []).map((f) => `\`${f.path}\` — ${f.role}`);
    sections.push(section('Files', files.length ? bullets(files) : '_none_'));
  } else if (r.type === 'decision') {
    sections.push(section('Statement', r.statement), section('Rationale', r.rationale));
    const alts = (r.alternatives_rejected ?? []).map((a) => `**${oneLine(a.option)}** — ${a.reason}`);
    if (alts.length) sections.push(section('Rejected alternatives', bullets(alts)));
    sections.push(section('Paths', pathList(r)));
  } else {
    sections.push(
      section('Trigger', r.trigger),
      section('Guidance', r.guidance),
      section('Wrong way', r.wrong_way),
      section('Right way', r.right_way),
      section('Paths', pathList(r))
    );
  }
  return `${parts.join('\n')}\n${sections.filter(Boolean).join('\n')}`;
}

function renderIndex({ title, intro, records, fileOf, empty }) {
  const head = `${HEADER}\n\n# ${title}\n\n${intro}\n`;
  if (!records.length) return `${head}\n_No records yet — ${empty}_\n`;
  const areas = new Map();
  for (const r of records) {
    const a = areaOf(r);
    if (!areas.has(a)) areas.set(a, []);
    areas.get(a).push(r);
  }
  const keys = [...areas.keys()].filter((k) => k !== NO_PATHS).sort(byText);
  if (areas.has(NO_PATHS)) keys.push(NO_PATHS);
  const sections = keys.map((key) => {
    const lines = areas
      .get(key)
      .sort((a, b) => byText(oneLine(a.title), oneLine(b.title)) || byText(a.id, b.id))
      .map((r) => {
        const kind = r.type === 'anti_pattern' ? `[anti-pattern, ${r.severity ?? 'warn'}] ` : r.type === 'decision' ? '[decision] ' : '';
        const paths = pathsOf(r);
        return `- ${kind}[${oneLine(r.title)}](${fileOf.get(r.id)})${paths.length ? ` — ${paths.map((p) => `\`${p}\``).join(', ')}` : ''}`;
      });
    return `## ${key}\n\n${lines.join('\n')}\n`;
  });
  return `${head}\n${sections.join('\n')}`;
}

// records: the live feature_article, decision and anti_pattern records.
// Returns Map<repo-relative path, content>, deterministic for a given record set.
export function buildHandoffFiles(records) {
  const live = records.filter((r) => TYPE_DIRS[r.type] && r.status !== 'superseded' && r.status !== 'retired');
  const fileOf = assignFiles(live);
  const files = new Map();
  files.set(
    'architecture.md',
    renderIndex({
      title: 'Architecture (generated)',
      intro: 'What each area of this project does and which files it owns, one line per feature article, grouped by area. Each line links the complete article.',
      records: live.filter((r) => r.type === 'feature_article'),
      fileOf,
      empty: 'the knowledge store holds no feature articles.',
    })
  );
  files.set(
    'rulings.md',
    renderIndex({
      title: 'Rulings (generated)',
      intro: 'Every active decision and anti-pattern that governs this code, grouped by area. Each line links the complete record: the statement, its rationale and the rejected alternatives, or the trigger and the right way.',
      records: live.filter((r) => r.type !== 'feature_article'),
      fileOf,
      empty: 'the knowledge store holds no active decisions or anti-patterns.',
    })
  );
  for (const r of [...live].sort((a, b) => byText(fileOf.get(a.id), fileOf.get(b.id)))) files.set(fileOf.get(r.id), renderRecord(r));
  return { files, recordCount: live.length };
}

const normalize = (s) => s.replace(/\r\n/g, '\n');

// Every Sterling-generated record file already on disk under docs/sterling/.
// All filesystem access goes through contained-fs: a symlinked or non-directory
// component throws ContainmentError instead of being followed.
export function existingRecordFiles(root) {
  const out = [];
  for (const dir of Object.values(TYPE_DIRS)) {
    const relDir = `${HANDOFF_DOCS_DIR}/${dir}`;
    for (const name of readdirContained(root, relDir).filter((n) => n.endsWith('.md')).sort(byText)) {
      const rel = `${relDir}/${name}`;
      if (isHandoffOwned(readContained(root, rel), rel)) out.push(rel);
    }
  }
  return out;
}

// What applying `files` would do: nothing is written by this function.
export function planHandoff(root, files) {
  const plan = { write: [], unchanged: [], remove: [], foreign: [] };
  for (const [rel, content] of files) {
    if (!existsContained(root, rel, 'file')) {
      plan.write.push(rel);
      continue;
    }
    const current = readContained(root, rel);
    if (!isHandoffOwned(current, rel)) plan.foreign.push(rel);
    else if (normalize(current) === content) plan.unchanged.push(rel);
    else plan.write.push(rel);
  }
  plan.remove = existingRecordFiles(root).filter((rel) => !files.has(rel));
  return plan;
}

// config.generated_projections holds exact FILES (every consumer — H7's
// settlement, check-record-citations, the MCP drift check, direct-merge — tests
// membership, never a glob). Only this producer's own entries change: the files
// it generates now (re-appended in sorted order) and the marker-verified stale
// files it removed. Every other entry — another producer's, even one under
// docs/sterling/ — is kept in place.
export function registeredProjections(existing, files, removed = []) {
  const ours = new Set([...files.keys(), ...removed]);
  const kept = (existing ?? []).filter((p) => !ours.has(p));
  return [...kept, ...[...files.keys()].sort(byText)];
}

// Is `rel` a file this producer generated (for callers comparing a recorded
// config against defaults): the two root indexes or a marker-carrying file.
export function isOwnedExport(root, rel) {
  if (HANDOFF_ROOT_FILES.includes(rel)) return true;
  if (!isHandoffPath(rel)) return false;
  return existsContained(root, rel, 'file') && isHandoffOwned(readContained(root, rel), rel);
}
