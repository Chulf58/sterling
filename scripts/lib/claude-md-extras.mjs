// CLAUDE.md holds only Sterling's generated layer; every rule a project adds goes into AGENTS.md
// (decision project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer,
// user-ruled 2026-11-19; GitHub issue #319). This finds the top-level bullets of a project's
// CLAUDE.md whose bold lead appears nowhere in templates/target-claude-md.md, so sync can warn.
// It never edits the file. A bullet the project reworded or re-punctuated passes (leads compare by their first three
// words); one with a different lead is named, which is the loud side of the error.
//
// Builtins only: bundled into bin/sync-agents.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LEAD_RE = /^- (\*\*.+?\*\*)/;

const leadOf = (line) => LEAD_RE.exec(line)?.[1] ?? null;
// A project may reword or re-punctuate a template lead, so leads compare by their first three words.
const key = (lead) => lead.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 3).join(' ');

/** [{ line, lead }] for each CLAUDE.md bullet whose bold lead the template does not carry. */
export function foreignClaudeMdBullets(pluginRoot, projectDir) {
  const claudePath = join(projectDir, 'CLAUDE.md');
  const templatePath = join(pluginRoot, 'templates', 'target-claude-md.md');
  if (!existsSync(claudePath) || !existsSync(templatePath)) return [];
  const known = new Set(readFileSync(templatePath, 'utf8').split('\n').map(leadOf).filter(Boolean).map(key));
  const out = [];
  readFileSync(claudePath, 'utf8').split('\n').forEach((text, i) => {
    const lead = leadOf(text);
    if (lead && !known.has(key(lead))) out.push({ line: i + 1, lead });
  });
  return out;
}

/** The one warning line for a foreign bullet. */
export function foreignBulletWarning({ line, lead }) {
  return `⚠ CLAUDE.md:${line} holds a bullet that is not part of Sterling's layer: ${lead}. Move it to AGENTS.md: every host reads AGENTS.md, while CLAUDE.md and GEMINI.md hold only Sterling's generated layer (decision project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer). Sterling does not edit your file.`;
}
