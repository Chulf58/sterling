// System tab: installed governed roles and the project's custom agents (user ruling
// 2026-11-18 "Installed roles + custom", GitHub issue #307). Read-only discovery; it never
// writes and never throws: a file or folder that cannot be read or parsed becomes a row
// with an error marker.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CORE_SCHEMA, load } from 'js-yaml';
import { AGENT_MODEL_KEY } from '@sterling/schemas';
import { AGY_AGENTS_DIR, AGY_ROSTER } from '../../../scripts/lib/agy-setup.mjs';

export interface CustomAgent {
  /** The agent's identity: its path under the host folder without the extension
   *  (`team/scout`), or the folder name for agy's `<name>/agent.md`. */
  name: string;
  /** Host folder the file was found in. */
  source: 'claude' | 'opencode' | 'agy';
  /** The scalar `model` from the file's own frontmatter; absent when it names none. */
  model?: string;
  /** Why the file could not be read or parsed; the row shows it instead of a model. */
  error?: string;
}

/** Where Sterling installs its own agents, relative to the project root. A file of a Sterling
 *  role anywhere else (`.opencode/agents/team/scout.md`) is the user's own agent. */
const CLAUDE_DIR = ['.claude', 'agents'];
const OPENCODE_DIR = ['.opencode', 'agents'];
const OPENCODE_STERLING_DIR = ['.opencode', 'agents', 'sterling'];
const AGY_DIR = AGY_AGENTS_DIR.split('/');

const STERLING_ROLES = new Set<string>([...Object.keys(AGENT_MODEL_KEY), ...AGY_ROSTER]);
const STERLING_STAMP_RE = /<!--\s*sterling-(?:full|agy|generated)\b/;

/** The governed agent names (AGENT_MODEL_KEY) installed at Sterling's managed location in each
 *  host: .claude/agents/<name>.md, .opencode/agents/sterling/<name>.md, and
 *  .agents/agents/<name>/agent.md. */
export function installedGovernedAgents(projectRoot: string): { claude: string[]; opencode: string[]; agy: string[] } {
  const governed = Object.keys(AGENT_MODEL_KEY);
  return {
    claude: governed.filter((n) => existsSync(join(projectRoot, ...CLAUDE_DIR, `${n}.md`))),
    opencode: governed.filter((n) => existsSync(join(projectRoot, ...OPENCODE_STERLING_DIR, `${n}.md`))),
    agy: governed.filter((n) => existsSync(join(projectRoot, ...AGY_DIR, n, 'agent.md'))),
  };
}

function walk(dir: string, found: string[], errors: CustomAgent[], source: CustomAgent['source'], projectRoot: string): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    errors.push({ name: relative(projectRoot, dir).split(sep).join('/'), source, error: `cannot read folder: ${(err as Error).message}` });
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, found, errors, source, projectRoot);
    else if (e.isFile()) found.push(p);
  }
}

function parse(path: string, name: string, source: CustomAgent['source']): CustomAgent | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { name, source, error: `cannot read file: ${(err as Error).message}` };
  }
  if (STERLING_STAMP_RE.test(text)) return null;
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { name, source };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { name, source, error: 'frontmatter is not closed' };
  let data: unknown;
  try {
    data = load(normalized.slice(4, end), { schema: CORE_SCHEMA });
  } catch (err) {
    return { name, source, error: `frontmatter is not valid YAML: ${(err as Error).message.split('\n')[0]}` };
  }
  if (data === null || data === undefined) return { name, source };
  if (typeof data !== 'object' || Array.isArray(data)) return { name, source, error: 'frontmatter is not a mapping' };
  const model = (data as Record<string, unknown>).model;
  if (model === undefined || model === null) return { name, source };
  if (typeof model !== 'string' && typeof model !== 'number' && typeof model !== 'boolean') return { name, source, error: 'frontmatter model is not a scalar' };
  return { name, source, model: String(model) };
}

/** Custom agents under projectRoot: every agent file in .claude/agents and .opencode/agents
 *  (subfolders included) and .agents/agents/<name>/agent.md except Sterling's own, which are a
 *  Sterling role at its managed location (installedGovernedAgents) or carry a Sterling stamp.
 *  A role's name elsewhere is a custom agent, listed under its path. Sorted by name, then source. */
export function discoverCustomAgents(projectRoot: string): CustomAgent[] {
  const out: CustomAgent[] = [];
  const hosts: Array<{ source: CustomAgent['source']; dir: string[]; id: (rel: string) => string | null; managed: (rel: string) => boolean }> = [
    { source: 'claude', dir: CLAUDE_DIR, id: (rel) => (rel.endsWith('.md') ? rel.slice(0, -3) : null), managed: (rel) => STERLING_ROLES.has(rel.slice(0, -3)) },
    {
      source: 'opencode',
      dir: OPENCODE_DIR,
      id: (rel) => (rel.endsWith('.md') ? rel.slice(0, -3) : null),
      managed: (rel) => rel.startsWith('sterling/') && STERLING_ROLES.has(rel.slice('sterling/'.length, -3)),
    },
    {
      source: 'agy',
      dir: AGY_DIR,
      id: (rel) => (rel.endsWith('/agent.md') ? rel.slice(0, -'/agent.md'.length) : null),
      managed: (rel) => STERLING_ROLES.has(rel.slice(0, -'/agent.md'.length)),
    },
  ];
  for (const host of hosts) {
    const dir = join(projectRoot, ...host.dir);
    if (!existsSync(dir)) continue;
    const files: string[] = [];
    walk(dir, files, out, host.source, projectRoot);
    for (const f of files) {
      const rel = relative(dir, f).split(sep).join('/');
      const id = host.id(rel);
      if (id === null || host.managed(rel)) continue;
      const agent = parse(f, id, host.source);
      if (agent !== null) out.push(agent);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}
