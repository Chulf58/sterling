// Adopting a custom agent into a tracked source folder (decision
// custom-agents-are-adopted-into-a-source-folder-host-files-are-generated-projections,
// GitHub #312). planAdoption is pure; adopt performs one plan on disk. Neither is called
// except by an explicit user action (the System tab confirms once, item 5 of the redesign).
//
// SOURCE FOLDER: `agent-sources/`, at the project root, one `<key>.md` per adopted agent.
// No host serves it: Claude Code serves .claude/agents and, for a plugin, a root `agents/`;
// OpenCode serves .opencode/agents (and agent/); agy serves .agents/agents. A folder named
// agents/ would be auto-served by a plugin with its hooks stripped, which is why Sterling's
// own templates are in agent-templates/ (AGENTS.md, repo layout). The file is named by the
// stable key (`custom-team-scout.md`), not the original path, so the key, the file and the
// config.models entry are one name.
//
// ORIGIN. The source is the original file with one line added as the first frontmatter line,
// `sterling-origin: <host>` (ORIGIN_FIELD in custom-agent-render.mjs), so the renderer reads its
// restrictions in the format they were written in; everything else is byte-for-byte the original.
//
// FILES. adopt() lstat-walks every component of the original and the new source path below the
// project root (contained-fs.mjs) before it reads, writes or removes anything, so a symlinked
// .claude/agents, .opencode/agents, .agents/agents or agent-sources is refused, never followed.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { customAgentKey, customAgentSlug } from '@sterling/schemas';
import { writeFileAtomic } from './atomic-write.mjs';
import { containedPath, mkdirContained, unlinkContained } from './contained-fs.mjs';
import { ORIGIN_FIELD, hostRestrictionRefusal, parseSource } from './custom-agent-render.mjs';

export const AGENT_SOURCE_DIR = 'agent-sources';

// Where each host keeps agent files, relative to the project root (custom-agents.ts).
const HOST_DIRS = {
  claude: '.claude/agents/',
  opencode: '.opencode/agents/',
  agy: '.agents/agents/',
};
const STERLING_STAMP_RE = /<!--\s*sterling-(?:full|agy|generated)\b/;

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The tracked path an agent with this key is adopted to. */
export const sourcePathOf = (key) => `${AGENT_SOURCE_DIR}/${key}.md`;

const refuse = (code, message) => ({ code, message });

/**
 * Plan the adoption of one discovered agent.
 *
 * discovered: { host: 'claude'|'opencode'|'agy', name, file, content } where `file` is the
 *   project-relative POSIX path and `content` the file's text (an unreadable file has no
 *   content and is refused).
 * state: {
 *   sourceFiles: string[]            file names already in agent-sources/,
 *   configKeys: string[]             every key of config.models,
 *   others: [{host, name, content}]  every OTHER discovered agent,
 *   hosts?: string[]                 the installed hosts; each must be able to carry the agent's
 *                                    restrictions without broadening them, or adoption is refused
 * }
 * Returns { ok, refusals, key?, move?: {from, to}, contentHash?, sourceContent?, origin?, duplicates? }.
 * `sourceContent` is what adopt() writes (the original plus the origin line). `duplicates` lists
 * same-slug agents on other hosts whose content is byte-identical: they stay where they are
 * (host copies are regenerated from the source by the rendering step, which owns them).
 */
export function planAdoption(discovered, state) {
  const refusals = [];
  const { host, name, file, content } = discovered ?? {};
  const prefix = HOST_DIRS[host];
  if (prefix === undefined || typeof name !== 'string' || typeof file !== 'string') {
    return { ok: false, refusals: [refuse('invalid-input', 'the agent needs a host, a name and a project-relative file')] };
  }
  if (isAbsolute(file) || file.split('/').includes('..') || file.includes('\\') || !file.startsWith(prefix)) {
    refusals.push(refuse('outside-project', `${file} is not a file under ${prefix} in this project; only a project's own agent folders are adopted`));
  }
  if (typeof content !== 'string') {
    refusals.push(refuse('unreadable', `${file} could not be read, so it cannot be adopted`));
  } else if (STERLING_STAMP_RE.test(content)) {
    refusals.push(refuse('generated', `${file} carries a Sterling stamp: it is a generated copy, never an agent to adopt`));
  }
  let sourceContent;
  if (typeof content === 'string' && !STERLING_STAMP_RE.test(content)) {
    const parsed = parseSource(content);
    if (parsed.error) {
      refusals.push(refuse(/no frontmatter/.test(parsed.error) ? 'no-frontmatter' : 'invalid-frontmatter', `${file}: ${parsed.error}; Sterling renders an agent from its frontmatter`));
    } else if (ORIGIN_FIELD in parsed.data) {
      refusals.push(refuse('origin-present', `${file} already has a ${ORIGIN_FIELD} line, which Sterling writes itself; remove it, then adopt`));
    } else {
      sourceContent = content.replace(/^---(\r?\n)/, `---$1${ORIGIN_FIELD}: ${host}$1`);
      const blocked = (state?.hosts ?? [])
        .map((h) => [h, hostRestrictionRefusal(h, host, parsed.data)])
        .filter(([, reason]) => reason !== null);
      if (blocked.length) {
        refusals.push(refuse('permission-unrepresentable', `the installed host(s) could only get a broader agent than ${file} allows — ${blocked.map(([h, r]) => `${h}: ${r}`).join('; ')}`));
      }
    }
  }
  const slug = customAgentSlug(name);
  const key = customAgentKey(name);
  if (key === null) {
    refusals.push(refuse('invalid-name', `${host}:${name} has no usable slug (letters and digits, at most 64 characters)`));
    return { ok: false, refusals };
  }
  const configKeys = new Set(state?.configKeys ?? []);
  if (configKeys.has(key)) {
    refusals.push(refuse('key-in-use', `config.models already has ${key}; adopting ${host}:${name} would take over that entry`));
  }
  if ((state?.sourceFiles ?? []).includes(`${key}.md`)) {
    refusals.push(refuse('source-exists', `${sourcePathOf(key)} already exists; it is never overwritten`));
  }
  const duplicates = [];
  for (const other of state?.others ?? []) {
    if (customAgentSlug(other.name) !== slug) continue;
    if (other.host === host && other.name === name) continue;
    if (other.host === host) {
      refusals.push(refuse('key-collision', `${host}:${name} and ${other.host}:${other.name} both become ${key}; rename one of them first`));
    } else if (typeof content === 'string' && other.content === content && other.name === name) {
      duplicates.push({ host: other.host, name: other.name });
    } else {
      refusals.push(
        refuse(
          'ambiguous-duplicate',
          `${other.host}:${other.name} would also become ${key} and its content ${other.name === name ? 'differs from' : 'is not the same agent as'} ${host}:${name}; keep one, or make them identical, then adopt`,
        ),
      );
    }
  }
  if (refusals.length > 0) return { ok: false, key, refusals };
  return { ok: true, key, refusals, move: { from: file, to: sourcePathOf(key) }, contentHash: sha256(content), sourceContent, origin: host, duplicates };
}

/** The sourceFiles and the file text a plan needs from disk: the one reader the caller uses. */
export function readSourceFiles(projectRoot) {
  const dir = join(projectRoot, AGENT_SOURCE_DIR);
  return existsSync(dir) ? readdirSync(dir) : [];
}

/**
 * Perform an ok plan: write the source file (the original plus its origin line) atomically, read
 * it back and compare, then remove the original (and agy's now-empty <name>/ folder). Refuses when
 * the plan is not ok, when a path component of the original or the target is a symlink or leaves
 * the project (checked before anything is read or written), when the original changed since it was
 * planned (hash), or when the target exists. A failed verification removes the new file and leaves
 * the original untouched.
 */
export function adopt(projectRoot, plan) {
  if (!plan?.ok || !plan.move || typeof plan.sourceContent !== 'string') throw new Error(`adopt: the plan is not adoptable (${(plan?.refusals ?? []).map((r) => r.code).join(', ') || 'no move'})`);
  let from;
  let to;
  try {
    from = containedPath(projectRoot, plan.move.from, 'file');
    to = containedPath(projectRoot, plan.move.to, 'file');
  } catch (err) {
    throw new Error(`adopt: ${err.message}; nothing was written or removed`, { cause: err });
  }
  if (!existsSync(from)) throw new Error(`adopt: ${plan.move.from} is gone; nothing was written`);
  const original = readFileSync(from, 'utf8');
  if (sha256(original) !== plan.contentHash) throw new Error(`adopt: ${plan.move.from} changed since it was planned; nothing was written`);
  if (existsSync(to)) throw new Error(`adopt: ${plan.move.to} already exists; it is never overwritten`);
  mkdirContained(projectRoot, dirname(plan.move.to));
  writeFileAtomic(to, plan.sourceContent);
  let written;
  try {
    written = readFileSync(to, 'utf8');
  } catch (err) {
    rmSync(to, { force: true });
    throw new Error(`adopt: the new file could not be read back (${err.message}); the original is untouched`);
  }
  if (written !== plan.sourceContent) {
    rmSync(to, { force: true });
    throw new Error(`adopt: the new file differs from what was planned; it was removed and the original is untouched`);
  }
  unlinkContained(projectRoot, plan.move.from);
  if (plan.move.from.startsWith(HOST_DIRS.agy)) {
    const folder = containedPath(projectRoot, dirname(plan.move.from), 'dir');
    if (lstatSync(folder).isDirectory() && readdirSync(folder).length === 0) rmdirSync(folder);
  }
  return { from: plan.move.from, to: plan.move.to, key: plan.key };
}
