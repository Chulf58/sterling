// System tab: the project's custom agents (user ruling 2026-11-18, "Installed roles +
// custom", GitHub issue #307). Read-only discovery of agent files Sterling did not write,
// in the Claude, OpenCode and Antigravity agent folders. Never writes, never throws: a
// file or folder that cannot be read becomes a row with an error marker.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AGENT_MODEL_KEY } from '@sterling/schemas';
import { AGY_AGENTS_DIR, AGY_ROSTER } from '../../../scripts/lib/agy-setup.mjs';

export interface CustomAgent {
  name: string;
  /** Host folder the file was found in. */
  source: 'claude' | 'opencode' | 'agy';
  /** The model from the file's own frontmatter; absent when it names none. */
  model?: string;
  /** Why the file could not be read or parsed; the row shows it instead of a model. */
  error?: string;
}

const STERLING_ROLES = new Set<string>([...Object.keys(AGENT_MODEL_KEY), ...AGY_ROSTER]);
const STERLING_STAMP_RE = /<!--\s*sterling-(?:full|agy|generated)\b/;

function walk(dir: string, found: string[], errors: CustomAgent[], source: CustomAgent['source']): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    errors.push({ name: dir, source, error: `cannot read folder: ${(err as Error).message}` });
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, found, errors, source);
    else if (e.isFile()) found.push(p);
  }
}

function parse(path: string, fallbackName: string, source: CustomAgent['source']): CustomAgent | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { name: fallbackName, source, error: `cannot read file: ${(err as Error).message}` };
  }
  if (STERLING_STAMP_RE.test(text)) return null;
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { name: fallbackName, source };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { name: fallbackName, source, error: 'frontmatter is not closed' };
  const block = normalized.slice(4, end);
  const unquote = (v: string | undefined): string | undefined => v?.trim().replace(/^(["'])(.*)\1$/, '$2') || undefined;
  const name = unquote(block.match(/^name:[ \t]*(.*)$/m)?.[1]) ?? fallbackName;
  const model = unquote(block.match(/^model:[ \t]*(.*)$/m)?.[1]);
  return model === undefined ? { name, source } : { name, source, model };
}

/** Custom agents under projectRoot: every agent file in .claude/agents and .opencode/agents
 *  (subfolders included) and .agents/agents/<name>/agent.md that is not a Sterling role or
 *  stamped by Sterling. Sorted by name, then source. */
export function discoverCustomAgents(projectRoot: string): CustomAgent[] {
  const out: CustomAgent[] = [];
  const hosts: Array<[CustomAgent['source'], string, (p: string) => string | null]> = [
    ['claude', join(projectRoot, '.claude', 'agents'), (p) => (p.endsWith('.md') ? basename(p, '.md') : null)],
    ['opencode', join(projectRoot, '.opencode', 'agents'), (p) => (p.endsWith('.md') ? basename(p, '.md') : null)],
    ['agy', join(projectRoot, ...AGY_AGENTS_DIR.split('/')), (p) => (basename(p) === 'agent.md' ? basename(join(p, '..')) : null)],
  ];
  for (const [source, dir, nameOf] of hosts) {
    if (!existsSync(dir)) continue;
    const files: string[] = [];
    walk(dir, files, out, source);
    for (const f of files) {
      const fallback = nameOf(f);
      if (fallback === null || STERLING_ROLES.has(fallback)) continue;
      const agent = parse(f, fallback, source);
      if (agent !== null && !STERLING_ROLES.has(agent.name)) out.push(agent);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}
