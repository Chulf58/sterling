// Sterling on Antigravity CLI (agy): project setup (decision
// antigravity-cli-agy-sterling-mcp-server-is-declared-per-agen; measured facts in
// research_finding c588c43d). /sterling:init and sync-agents (so /sterling:update's fan-out
// and the post-update sync too) call setupAgy once per project, from whichever host runs
// them. Every step is idempotent. agy not installed: one loud skip line, nothing written.
//
// 1. .agents/agents/<name>/agent.md for each Sterling role (AGY_ROSTER, the OpenCode
//    roster and names), rendered from agent-templates/<name>.md through renderAgyText.
//    The frontmatter is agy's: model inherit; the conductor mainAgent: true and
//    subagent: false, the workers the reverse; tools: a list of agy built-in registry
//    names per role (AGY_TOOLS); and mcpServers with ONE entry: `sterling` on the writing
//    roles, `sterling-ro` on the read-only ones (AGY_READ_ONLY_ROLES). The server is
//    <process.execPath> <root>/mcp/sterling-mcp.mjs --project . (agyMcpRoot picks the root),
//    plus --read-only for `sterling-ro`, where every store-write tool refuses (decision
//    antigravity-cli-agy-read-only-role-guard-read-the-agent-role). Measured on agy 1.5.11:
//    an agent reaches only the servers it declares, and agent-scoped servers are deduplicated
//    by entry NAME and start with cwd = the workspace, so the two entries need distinct names
//    and a session runs at most one of each. The Sterling stamp is the first body line.
//    A file Sterling did not write, one edited since, or one git tracks is refused.
// 2. GEMINI.md at the project root: the agy render of templates/target-claude-md.md, with
//    no @AGENTS.md import (agy loads AGENTS.md on its own) and under agy's 24,000-byte
//    per-file cap. It is written only when absent, like CLAUDE.md: a differing GEMINI.md
//    is left alone, and stamp-contract inserts new contract bullets into it.
// 3. A managed block in .git/info/exclude keeps both out of git. Unlike CLAUDE.md,
//    GEMINI.md carries this machine's absolute Sterling path ({{STERLING_ROOT}}), so it is
//    per-user; a GEMINI.md that git tracks, or one Sterling did not write, is not listed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { renderAgyText } from './agent-fences.mjs';
import { findDeadTerms } from './agent-distribution.mjs';
import { isInstalledCopy } from './installed-copy.mjs';
import { installRoots } from './sterling-roots.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { storeRootFor } from './worktree-root.mjs';

export const AGY_AGENTS_DIR = '.agents/agents';
export const GEMINI_MD = 'GEMINI.md';
export const AGY_CONDUCTOR = 'conductor';
// agy reads at most this many bytes of a workspace AGENTS.md or GEMINI.md (finding c588c43d, from the docs).
export const GEMINI_MD_MAX_BYTES = 24_000;
export const AGY_MCP_SERVER_NAME = 'sterling';
/** The MCP entry the read-only roles declare: the same server started with --read-only. */
export const AGY_MCP_READ_ONLY_SERVER_NAME = 'sterling-ro';
/** The roles that never write the store; on agy they declare AGY_MCP_READ_ONLY_SERVER_NAME. */
export const AGY_READ_ONLY_ROLES = new Set(['reviewer', 'researcher', 'scout', 'sparring', 'preflight']);
const EXCLUDE_BEGIN = '# >>> sterling agy (managed by Sterling init/update; per-user files, never committed)';
const EXCLUDE_END = '# <<< sterling agy';
const HEADER_RE = /^<!-- sterling-agy renderer=agy\/1 template=(\S+) template_hash=([0-9a-f]{64}) content_hash=([0-9a-f]{64}) -->$/m;

// agy built-in tool names, measured on agy 1.5.11 (2026-11-18) by starting an agent whose
// tools: list held them: each starts cleanly, and an unknown name fails at startup with
// "tool ... not found in registry". view_file, write_to_file and replace_file_content are
// aliases of read_file, write_file and edit_file (listing both fails with "tool name
// conflict"), so only the names agy emits are used. A tools: list removes every built-in it
// does not name; it cannot limit MCP tools, which stay reachable through call_mcp_tool.
const READ = ['read_file', 'grep_search', 'find_by_name', 'list_dir'];
const SHELL = ['run_command', 'command_status'];
const EDIT = ['write_file', 'edit_file', 'multi_replace_file_content'];
const WEB = ['search_web', 'read_url_content'];
const DISPATCH = ['invoke_subagent', 'send_message'];

/** Each role's agy tools, mirroring its Claude tools: grant and OpenCode permissions. */
export const AGY_TOOLS = {
  conductor: [...READ, ...SHELL, ...EDIT, ...WEB, ...DISPATCH, 'ask_question'],
  implementor: [...READ, ...SHELL, ...EDIT, ...WEB],
  'implementor-hard': [...READ, ...SHELL, ...EDIT, ...WEB],
  researcher: [...READ, ...SHELL, ...WEB],
  scout: [...READ],
  reviewer: [...READ, ...SHELL],
  sparring: [...READ, ...SHELL],
  librarian: ['read_file', 'grep_search'],
  preflight: [...READ],
};
export const AGY_ROSTER = Object.keys(AGY_TOOLS);

const CONDUCTOR_DESCRIPTION = "Sterling's orchestrating main-session agent. Briefs, synthesizes, verifies, decides and commits; hands-on reading, implementing and reviewing go to subagents. Started with `agy --agent conductor` from .agents/agents/conductor/agent.md (written by /sterling:init and sync-agents); never invoked as a subagent.";

const fwd = (p) => p.replace(/\\/g, '/');
const normalize = (s) => s.replace(/\r\n/g, '\n');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The directory agy copies an installed Sterling to: <home>/.gemini/config/plugins/sterling. */
export function agyPluginCopy({ env = process.env, home = homedir() } = {}) {
  return join(installRoots(env, home).find((r) => r.host === 'agy').dir, 'sterling');
}

/**
 * `agy --version` → { installed, version } or { installed: false, reason }. Looks on PATH,
 * then at ~/.local/bin/agy, where agy's installer puts it. STERLING_AGY_PROBE is the test
 * seam: 'ok' forces present, 'absent' forces absent, unset or '' runs the real probe, and
 * any other value throws (P5).
 */
export function probeAgy({ env = process.env, home = homedir() } = {}) {
  const forced = env.STERLING_AGY_PROBE;
  if (forced === 'ok') return { installed: true, version: 'forced' };
  if (forced === 'absent') return { installed: false, reason: 'STERLING_AGY_PROBE=absent' };
  if (forced) throw new Error(`STERLING_AGY_PROBE must be 'ok' or 'absent' (got '${forced}')`);
  let r = spawnSync('agy', ['--version'], { encoding: 'utf8', env, timeout: 20_000 });
  const homeBin = join(home, '.local', 'bin', 'agy');
  if (r.error?.code === 'ENOENT' && existsSync(homeBin)) r = spawnSync(homeBin, ['--version'], { encoding: 'utf8', env, timeout: 20_000 });
  if (r.error) return { installed: false, reason: r.error.code === 'ENOENT' ? 'no `agy` on PATH or in ~/.local/bin' : `agy --version could not run (${r.error.message})` };
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(`${r.stdout}${r.stderr}`);
  if (r.status !== 0 || !m) return { installed: false, reason: `agy --version exited ${r.status} without a version: ${`${r.stdout}${r.stderr}`.trim().slice(0, 200)}` };
  return { installed: true, version: m[0] };
}

/**
 * The Sterling root whose mcp/sterling-mcp.mjs the agents start, by the rule the OpenCode
 * shims follow: a git clone (the authoring machine) bakes its own path, because a clone does
 * not move on update; an installed copy names agy's own copy when agy has one with the
 * server entry, else the copy running this. Returns { root, why }.
 */
export function agyMcpRoot({ pluginRoot, env = process.env, home = homedir(), installed }) {
  const isInstalled = installed ?? isInstalledCopy(pluginRoot, { env, home });
  if (!isInstalled) return { root: resolve(pluginRoot), why: 'the Sterling clone running this' };
  const agyCopy = agyPluginCopy({ env, home });
  if (existsSync(join(agyCopy, 'mcp', 'sterling-mcp.mjs'))) return { root: agyCopy, why: "agy's installed Sterling" };
  return { root: resolve(pluginRoot), why: `the installed Sterling running this (agy has no Sterling copy at ${fwd(agyCopy)})` };
}

const yamlString = (s) => JSON.stringify(s);

function templateDescription(frontmatter, label) {
  const line = frontmatter.match(/^description:\s*(.+)$/m)?.[1];
  if (!line) throw new Error(`agy agent ${label}: no description in the template frontmatter (P5)`);
  return /^(["']).*\1$/.test(line) ? line.slice(1, -1) : line;
}

/**
 * One agy agent file: agy frontmatter, the Sterling stamp and the template's agy render.
 * Pure; `nodePath` and `root` are absolute.
 */
export function renderAgyAgent(templateContent, label, name, { root, nodePath = process.execPath }) {
  const tools = AGY_TOOLS[name];
  if (!tools) throw new Error(`agy agent ${label}: '${name}' is not in the agy roster (P5)`);
  const rendered = normalize(renderAgyText(templateContent, label));
  const m = rendered.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`agy agent ${label}: missing frontmatter block (P5)`);
  const [, frontmatter, body] = m;
  const leftover = body.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`agy agent ${label}: the body keeps the token ${leftover[0]}, which nothing fills on agy (P5)`);
  const conductor = name === AGY_CONDUCTOR;
  const description = conductor ? CONDUCTOR_DESCRIPTION : templateDescription(frontmatter, label);
  const readOnly = AGY_READ_ONLY_ROLES.has(name);
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    'model: inherit',
    `mainAgent: ${conductor}`,
    `subagent: ${!conductor}`,
    'tools:',
    ...tools.map((t) => `  - ${t}`),
    '# agy cannot limit MCP tools per agent: every tool of a declared server is reachable through call_mcp_tool.',
    ...(readOnly ? ['# A read-only role declares sterling-ro, the Sterling server started with --read-only, which refuses every store-write tool.'] : []),
    'mcpServers:',
    `  - name: ${readOnly ? AGY_MCP_READ_ONLY_SERVER_NAME : AGY_MCP_SERVER_NAME}`,
    `    command: ${yamlString(fwd(nodePath))}`,
    '    args:',
    `      - ${yamlString(fwd(join(root, 'mcp', 'sterling-mcp.mjs')))}`,
    `      - ${yamlString('--project')}`,
    `      - ${yamlString('.')}`,
    ...(readOnly ? [`      - ${yamlString('--read-only')}`] : []),
    '---',
  ].join('\n');
  const content = `${fm}\n${body}`;
  const header = `<!-- sterling-agy renderer=agy/1 template=${name} template_hash=${sha256(templateContent)} content_hash=${sha256(content)} -->`;
  return `${fm}\n${header}\n${body}`;
}

/** The content an agy agent file had before its stamp line was added, for the edited-since check. */
function unstamped(disk, headerLine) {
  return disk.replace(`${headerLine}\n`, '');
}

function refusal(item, what, remedy) {
  return { item, status: 'refused', refused: true, detail: what, instruction: `REFUSED: ${what}. Sterling will not overwrite it. Remedy: ${remedy}.` };
}

function git(projectDir, args) {
  return spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
}

/** True when `dir` or a directory above it holds a `.git` (a directory, or a worktree's file). */
function insideGitCheckout(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

/**
 * The tracked files among `paths`: { tracked } or { failed: <git's error> }. Outside any git
 * checkout nothing can be tracked, so a failing git is { tracked: [] }; inside one, a failing
 * `git ls-files` (a broken index, exit 128) is a failure, never an empty list.
 */
export function trackedFiles(projectDir, paths, runGit = git) {
  const ls = runGit(projectDir, ['ls-files', '--', ...paths]);
  if (!ls.error && ls.status === 0) return { tracked: ls.stdout.split('\n').filter(Boolean) };
  if (!insideGitCheckout(projectDir)) return { tracked: [] };
  const why = ls.error ? ls.error.message : `exit ${ls.status}: ${(ls.stderr || '').trim().split('\n')[0] || 'no message'}`;
  return { failed: why };
}

/** Write or check every agy agent file. Rows: created | matches | refreshed | refused. */
export function ensureAgyAgents({ projectDir, pluginRoot, root, tracked, nodePath = process.execPath }) {
  const rows = [];
  for (const name of AGY_ROSTER) {
    const rel = `${AGY_AGENTS_DIR}/${name}/agent.md`;
    const path = join(projectDir, rel);
    if (tracked.includes(rel)) {
      rows.push(refusal(rel, `${rel} is tracked by git, and the Sterling agy agents are per-user`, `untrack it (git rm --cached ${rel} and commit), then rerun /sterling:update`));
      continue;
    }
    const templatePath = join(pluginRoot, 'agent-templates', `${name}.md`);
    const content = renderAgyAgent(readFileSync(templatePath, 'utf8'), `agent-templates/${name}.md`, name, { root, nodePath });
    let disk = null;
    if (existsSync(path)) {
      if (!statSync(path).isFile()) {
        rows.push(refusal(rel, `${rel} exists and is not a file`, 'move it aside, then rerun /sterling:update'));
        continue;
      }
      disk = normalize(readFileSync(path, 'utf8'));
      const h = disk.match(HEADER_RE);
      if (!h || h[1] !== name) {
        rows.push(refusal(rel, `${rel} carries no Sterling agy header (a file Sterling did not write)`, 'rename or remove it, then rerun /sterling:update'));
        continue;
      }
      if (sha256(unstamped(disk, h[0])) !== h[3]) {
        rows.push(refusal(rel, `${rel} was edited after Sterling wrote it`, 'move your edits elsewhere and delete it so Sterling can regenerate it, then rerun /sterling:update'));
        continue;
      }
    }
    if (disk === content) {
      rows.push({ item: rel, status: 'matches' });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, content);
    rows.push({ item: rel, status: disk === null ? 'created' : 'refreshed' });
  }
  return rows;
}

/** The project name GEMINI.md's heading carries: config.project_name, else the folder name. */
function projectNameOf(projectDir) {
  const configPath = join(storeRootFor(projectDir), '.sterling', 'config.json');
  if (!existsSync(configPath)) return basename(projectDir);
  const name = JSON.parse(readFileSync(configPath, 'utf8')).project_name;
  return typeof name === 'string' && name ? name : basename(projectDir);
}

/**
 * GEMINI.md as init writes it: the agy render of templates/target-claude-md.md with the
 * project name and Sterling root filled in. Throws (P5) when it imports AGENTS.md, keeps a
 * token, carries a dead term or exceeds agy's per-file cap.
 */
export function renderGeminiMd({ pluginRoot, root, projectName }) {
  const rel = 'templates/target-claude-md.md';
  const text = renderAgyText(readFileSync(join(pluginRoot, rel), 'utf8'), rel)
    .replaceAll('{{PROJECT_NAME}}', () => projectName)
    .replaceAll('{{STERLING_ROOT}}', () => fwd(root));
  if (/^@AGENTS\.md\s*$/m.test(text)) throw new Error(`${GEMINI_MD}: the agy render of ${rel} imports @AGENTS.md; agy loads AGENTS.md itself (P5)`);
  const leftover = text.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`${GEMINI_MD}: the agy render of ${rel} keeps the token ${leftover[0]} (P5)`);
  const dead = findDeadTerms(text);
  if (dead.length) throw new Error(`${GEMINI_MD}: dead term(s) in the agy render of ${rel}: ${dead.map((h) => h.match).join(', ')} (P5)`);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > GEMINI_MD_MAX_BYTES) throw Object.assign(new Error(`${GEMINI_MD}: the agy render of ${rel} is ${bytes} bytes, over agy's ${GEMINI_MD_MAX_BYTES}-byte cap, so agy would cut it (P5)`), { overCap: true });
  return text;
}

/** The short stable path GEMINI.md uses for a Sterling root too long to fit agy's cap: a per-user link to the root. */
export function geminiRootAlias(home) {
  return join(home, '.gemini', 'sterling-root');
}

/** Point the alias at root (replacing a stale link). Throws (P5) when something that is not a link sits there. */
function ensureRootAlias(alias, root) {
  let st = null;
  try { st = lstatSync(alias); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (st) {
    if (!st.isSymbolicLink()) throw new Error(`${fwd(alias)} exists and is not a link Sterling made; move it, then rerun /sterling:update`);
    if (resolve(dirname(alias), readlinkSync(alias)) === resolve(root)) return;
    unlinkSync(alias);
  }
  mkdirSync(dirname(alias), { recursive: true });
  symlinkSync(root, alias, 'junction');
}

/** GEMINI.md, written only when absent (the CLAUDE.md rule). Row status: created | matches | differs | refused. */
export function ensureGeminiMd({ projectDir, pluginRoot, root, home = homedir() }) {
  const path = join(projectDir, GEMINI_MD);
  const projectName = projectNameOf(projectDir);
  let want;
  let aliased = false;
  try {
    try {
      want = renderGeminiMd({ pluginRoot, root, projectName });
    } catch (err) {
      if (!err.overCap) throw err;
      // agy cuts GEMINI.md past its cap and the root is filled in 13 times: a long root goes through a short per-user link.
      want = renderGeminiMd({ pluginRoot, root: geminiRootAlias(home), projectName });
      aliased = true;
    }
  } catch (err) {
    return refusal(GEMINI_MD, `${GEMINI_MD} could not be rendered: ${err.message}`, 'fix the cause named, then rerun /sterling:update');
  }
  if (aliased && !existsSync(path) || aliased && normalize(readFileSync(path, 'utf8')) === want) {
    try {
      ensureRootAlias(geminiRootAlias(home), root);
    } catch (err) {
      return refusal(GEMINI_MD, `${GEMINI_MD} needs the short root link ${fwd(geminiRootAlias(home))} because the Sterling root is too long: ${err.message}`, 'fix the cause named, then rerun /sterling:update');
    }
  }
  if (!existsSync(path)) {
    writeFileAtomic(path, want);
    return { item: GEMINI_MD, status: 'created', detail: 'from templates/target-claude-md.md (agy render)' };
  }
  if (normalize(readFileSync(path, 'utf8')) === want) return { item: GEMINI_MD, status: 'matches', detail: 'generated content, unmodified' };
  return { item: GEMINI_MD, status: 'differs', detail: 'left untouched — merge the Sterling layer by hand (template: templates/target-claude-md.md, agy render)' };
}

/**
 * Keep the agy agents and GEMINI.md out of git through a managed block in .git/info/exclude.
 * gemini: 'exclude' lists /GEMINI.md; 'keep' lists it only when the block already does (a
 * GEMINI.md Sterling wrote that now differs from the template stays hidden, so git status
 * does not flip with each template change); 'no' never lists it (git tracks it).
 */
export function ensureAgyExcluded({ projectDir, gemini }) {
  const label = '.git/info/exclude (agy)';
  const gp = git(projectDir, ['rev-parse', '--git-path', 'info/exclude']);
  if (gp.status !== 0) return { item: label, status: 'skipped', detail: `not a git work tree (${(gp.stderr || '').trim().split('\n')[0]}) — nothing to keep untracked` };
  const excludePath = resolve(projectDir, gp.stdout.trim());
  const current = existsSync(excludePath) ? normalize(readFileSync(excludePath, 'utf8')) : '';
  const begin = current.indexOf(EXCLUDE_BEGIN);
  const end = current.indexOf(EXCLUDE_END);
  const listed = begin !== -1 && end > begin && current.slice(begin, end).split('\n').includes(`/${GEMINI_MD}`);
  const excludeGemini = gemini === 'exclude' || (gemini === 'keep' && listed);
  const lines = [...AGY_ROSTER.map((n) => `/${AGY_AGENTS_DIR}/${n}/`), ...(excludeGemini ? [`/${GEMINI_MD}`] : [])];
  const want = [EXCLUDE_BEGIN, ...lines, EXCLUDE_END].join('\n');
  if (begin !== -1 && end > begin) {
    if (current.slice(begin, end + EXCLUDE_END.length) === want) return { item: label, status: 'matches', detail: lines.join(' ') };
    writeFileSync(excludePath, current.slice(0, begin) + want + current.slice(end + EXCLUDE_END.length));
    return { item: label, status: 'refreshed', detail: lines.join(' ') };
  }
  mkdirSync(dirname(excludePath), { recursive: true });
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  writeFileSync(excludePath, `${current}${sep}${want}\n`);
  return { item: label, status: 'created', detail: lines.join(' ') };
}

/**
 * Steps 1-3 for one project. Returns { skipped } when agy is absent, else { root, rows }
 * with every row { item, status, detail?, refused?, instruction? }.
 */
export function setupAgy({ projectDir, pluginRoot, env = process.env, home = homedir(), installed, probe = probeAgy, nodePath = process.execPath, runGit = git }) {
  if (!isAbsolute(projectDir)) throw new TypeError(`setupAgy: projectDir must be absolute, got ${projectDir}`);
  // The test preload sets this so a test run never writes agy files into a fixture by accident.
  if (env.STERLING_AGY_SETUP_DISABLE === '1') return { skipped: 'Sterling on Antigravity CLI SKIPPED (STERLING_AGY_SETUP_DISABLE=1)' };
  const found = probe({ env, home });
  if (!found.installed) return { skipped: `agy not installed (${found.reason}) — Sterling on Antigravity CLI SKIPPED: no ${AGY_AGENTS_DIR}/, ${GEMINI_MD} or exclude block written; install agy, then run /sterling:update` };
  const { root, why } = agyMcpRoot({ pluginRoot, env, home, installed });
  const rows = [{ item: 'Sterling MCP server', status: 'matches', detail: `${fwd(join(root, 'mcp', 'sterling-mcp.mjs'))} (${why})` }];
  const inventory = trackedFiles(projectDir, [AGY_AGENTS_DIR, GEMINI_MD], runGit);
  if (inventory.failed) {
    // Inside a checkout, an unknown tracked set could refresh a file the project commits: nothing is written.
    rows.push(refusal(`${AGY_AGENTS_DIR}/, ${GEMINI_MD}, .git/info/exclude (agy)`, `git ls-files failed in ${fwd(projectDir)}, so which agy files git tracks is unknown (${inventory.failed})`, 'fix the repository (git status shows the same error), then rerun /sterling:update'));
    return { root, rows };
  }
  const { tracked } = inventory;
  rows.push(...ensureAgyAgents({ projectDir, pluginRoot, root, tracked, nodePath }));
  const gemini = tracked.includes(GEMINI_MD)
    ? { item: GEMINI_MD, status: 'matches', detail: 'tracked by git — the project keeps its own; left untouched' }
    : ensureGeminiMd({ projectDir, pluginRoot, root, home });
  rows.push(gemini);
  const geminiRule = tracked.includes(GEMINI_MD) ? 'no' : ['created', 'matches'].includes(gemini.status) ? 'exclude' : 'keep';
  rows.push(ensureAgyExcluded({ projectDir, gemini: geminiRule }));
  return { root, rows };
}

/** One printable line per row. The prefix keeps /sterling:update's agent-status parser (/^[a-z_]+: /) from counting them. */
export function formatAgyRows(result) {
  if (result.skipped) return [`Antigravity CLI (agy): ${result.skipped}`];
  return result.rows.map((r) => `Antigravity CLI (agy) ${r.status}: ${r.item}${r.detail ? ` — ${r.detail}` : ''}`);
}
