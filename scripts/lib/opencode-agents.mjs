// Portable OpenCode agents (decision
// init-prepares-opencode-portable-agents-and-target-handoff-projections).
// Init and the /sterling:update fan-out (through sync-agents) write
// <target>/.opencode/agents/<name>.md for every registry entry that carries an
// `opencode` block — the registry is the one place that declares the portable set
// (implementor, researcher, scout; librarian and conductor have no block).
//
// The files are COMMITTED in the target, for engineers who do not have Sterling:
//   - frontmatter is translated: description (verbatim), mode: subagent, and the
//     registry's permission map; no model pin (refinement (b)) and none of the
//     Claude-only keys (name, model, effort, tools, disallowedTools, required_inputs);
//   - the body is the portable render of the fenced template (agent-fences.mjs);
//   - the provenance header is deterministic (refinement (e)): renderer, template,
//     template hash and content hash — no plugin version and no timestamp, so an
//     unchanged render never rewrites a committed file.
// Ownership mirrors syncAgents: a file without our header is foreign and never
// overwritten; a locally edited file is never overwritten. Staleness compares the
// header's content hash with a fresh render's, so a renderer or permission-map
// change invalidates exactly like a template change.

import { readFileSync } from 'node:fs';
import { ContainmentError, existsContained, readContained, writeContained } from './contained-fs.mjs';
import { join } from 'node:path';
import { sha256, loadRegistry, OPENCODE_PERMISSION_KEYS, OPENCODE_PERMISSION_VALUES } from './agent-distribution.mjs';
import { renderPortableText } from './agent-fences.mjs';

export const OPENCODE_RENDERER = 'opencode/1';
export const OPENCODE_AGENTS_DIR = '.opencode/agents';
export const OPENCODE_HEADER_RE =
  /^<!-- sterling-portable renderer=(\S+) template=(\S+) template_hash=([0-9a-f]{64}) content_hash=([0-9a-f]{64}) -->$/m;

const normalize = (s) => s.replace(/\r\n/g, '\n');

export function portableAgentEntries(registry) {
  return registry.agents.filter((entry) => entry.opencode !== undefined);
}

function permissionLines(permission, label) {
  if (permission === undefined) return [];
  const lines = ['permission:'];
  for (const [key, value] of Object.entries(permission)) {
    if (!OPENCODE_PERMISSION_KEYS.includes(key) || !OPENCODE_PERMISSION_VALUES.includes(value)) {
      throw new Error(`opencode permission for ${label}: '${key}: ${value}' — keys are ${OPENCODE_PERMISSION_KEYS.join('/')}, values ${OPENCODE_PERMISSION_VALUES.join('/')} (P5)`);
    }
    lines.push(`  ${key}: ${value}`);
  }
  return lines;
}

export function renderOpenCodeAgent(templateContent, label, { permission, description: portableDescription } = {}, renderer = OPENCODE_RENDERER) {
  const m = normalize(templateContent).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`template ${label}: missing frontmatter block`);
  const [, templateFrontmatter, templateBody] = m;
  const name = templateFrontmatter.match(/^name:\s*(\S+)\s*$/m)?.[1];
  const description = templateFrontmatter.match(/^description:\s*(.+)$/m)?.[1];
  if (!name || !description) throw new Error(`template ${label}: a portable agent needs name and description in its frontmatter`);
  // The registry's override is emitted as a JSON string, which is a valid YAML
  // double-quoted scalar whatever it contains; the template line is verbatim.
  const descriptionLine = portableDescription !== undefined ? `description: ${JSON.stringify(portableDescription)}` : `description: ${description}`;
  const frontmatter = ['---', descriptionLine, 'mode: subagent', ...permissionLines(permission, label), '---'].join('\n');
  const body = renderPortableText(templateBody, label);
  const unsubstituted = body.match(/\{\{[A-Z_]+\}\}/);
  if (unsubstituted) {
    throw new Error(`portable render of ${label}: '${unsubstituted[0]}' is a machine token and cannot ship in a committed file — fence it sterling-only (P5)`);
  }
  const withoutHeader = `${frontmatter}\n${body}`;
  const contentHash = sha256(withoutHeader);
  const header = `<!-- sterling-portable renderer=${renderer} template=${name} template_hash=${sha256(templateContent)} content_hash=${contentHash} -->`;
  return { name, content: `${frontmatter}\n${header}\n${body}`, contentHash };
}

export function parseOpenCodeHeader(content) {
  const m = normalize(content).match(OPENCODE_HEADER_RE);
  if (!m) return null;
  const [headerLine, renderer, template, templateHash, contentHash] = m;
  return { headerLine, renderer, template, templateHash, contentHash };
}

const stripHeader = (content, header) => normalize(content).replace(header.headerLine + '\n', '');

export function opencodeRefuseInstruction(name, reason) {
  const path = `${OPENCODE_AGENTS_DIR}/${name}.md`;
  return [
    `REFUSED: ${path} ${reason}.`,
    'Sterling will not overwrite it. To resolve, either:',
    `  1) keep it — merge the fresh portable render into ${path} by hand, then delete its`,
    '     sterling-portable header line so Sterling treats the file as yours from now on, or',
    `  2) discard it — delete ${path} and re-run /sterling:sync-agents (or /sterling:init).`,
  ].join('\n');
}

// One agent, every filesystem access through contained-fs: a symlinked
// .opencode, .opencode/agents or agent file is refused (ContainmentError),
// never followed out of the project (Sol review HIGH).
function syncOne(targetDir, candidate) {
  const { name } = candidate;
  const rel = `${OPENCODE_AGENTS_DIR}/${name}.md`;
  if (!existsContained(targetDir, rel, 'file')) {
    writeContained(targetDir, rel, candidate.content);
    return { name, status: 'installed' };
  }
  const installed = readContained(targetDir, rel);
  const header = parseOpenCodeHeader(installed);
  if (!header || header.template !== name) {
    return { name, status: 'foreign_file', refused: true, instruction: opencodeRefuseInstruction(name, 'carries no Sterling portable-agent header (a file Sterling did not write)') };
  }
  if (normalize(installed) === candidate.content) return { name, status: 'up_to_date' };
  const modified = sha256(stripHeader(installed, header)) !== header.contentHash;
  if (!modified) {
    writeContained(targetDir, rel, candidate.content);
    return { name, status: 'refreshed' };
  }
  if (stripHeader(installed, header) === stripHeader(candidate.content, parseOpenCodeHeader(candidate.content))) {
    writeContained(targetDir, rel, candidate.content);
    return { name, status: 'header_repaired' };
  }
  if (header.contentHash === candidate.contentHash) return { name, status: 'locally_modified_up_to_date' };
  return { name, status: 'refused_local_modification', refused: true, instruction: opencodeRefuseInstruction(name, 'was edited locally AND its fresh render changed') };
}

// Statuses: installed | up_to_date | refreshed | header_repaired |
// locally_modified_up_to_date | refused_local_modification (refused) | foreign_file (refused) |
// refused_unsafe_path (refused: a symlink or non-directory on the way).
export function syncOpenCodeAgents({ registryPath, templatesDir, targetDir, renderer = OPENCODE_RENDERER }) {
  const entries = portableAgentEntries(loadRegistry(registryPath));
  // Render everything before writing anything: a bad template refuses the whole set.
  const rendered = entries.map((entry) => {
    const out = renderOpenCodeAgent(readFileSync(join(templatesDir, entry.file), 'utf8'), entry.file, entry.opencode, renderer);
    if (out.name !== entry.name) throw new Error(`registry/template name mismatch: registry says '${entry.name}', template says '${out.name}'`);
    return out;
  });
  const report = [];
  for (const candidate of rendered) {
    try {
      report.push(syncOne(targetDir, candidate));
    } catch (err) {
      if (!(err instanceof ContainmentError)) throw err;
      report.push({ name: candidate.name, status: 'refused_unsafe_path', refused: true, instruction: opencodeRefuseInstruction(candidate.name, `cannot be written safely: ${err.message}`) });
    }
  }
  return { report };
}
