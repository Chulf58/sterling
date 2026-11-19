// CLAUDE.md and GEMINI.md hold only Sterling's generated layer; every rule a project adds goes into
// AGENTS.md (decision project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer,
// user-ruled 2026-11-19; GitHub issue #319). This finds the top-level bullets of a project's CLAUDE.md
// (and GEMINI.md) whose lead appears nowhere in the matching Sterling template, so sync can warn.
// It never edits a file. Both bold-lead bullets (`- **Lead.** text`) and plain ones (`- text`) are
// inspected; nested bullets and bullets inside fenced code are not. A bullet the project reworded or
// re-punctuated passes (leads compare by their first three words); one with a different lead is named,
// which is the loud side of the error.
//
// Builtins only: bundled into bin/sync-agents.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BOLD_RE = /^- \*\*(.+?)\*\*/;
const PLAIN_RE = /^- (.+)$/;
const FENCE_LINE = /^\s*(```|~~~)/;

// A project may reword or re-punctuate a template lead, so leads compare by their first three words.
const key = (lead) => lead.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 3).join(' ');

/** [{ line, lead }] for each top-level bullet of `text` outside fenced code; the lead is the bold lead or the plain text. */
function topLevelBullets(text) {
  const out = [];
  let inFence = false;
  text.split('\n').forEach((raw, i) => {
    if (FENCE_LINE.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const bold = BOLD_RE.exec(raw);
    const lead = bold ? `**${bold[1]}**` : PLAIN_RE.exec(raw)?.[1].trim();
    if (lead) out.push({ line: i + 1, lead });
  });
  return out;
}

/** The bullets of `fileText` whose lead the reference template text does not carry. */
export function foreignBulletsIn(referenceText, fileText) {
  const known = new Set(topLevelBullets(referenceText).map((b) => key(b.lead)));
  return topLevelBullets(fileText).filter((b) => !known.has(key(b.lead)));
}

/** [{ file, line, lead }] for CLAUDE.md bullets the template does not carry. Throws on an unreadable file. */
export function foreignClaudeMdBullets(pluginRoot, projectDir) {
  const claudePath = join(projectDir, 'CLAUDE.md');
  const templatePath = join(pluginRoot, 'templates', 'target-claude-md.md');
  if (!existsSync(claudePath) || !existsSync(templatePath)) return [];
  return foreignBulletsIn(readFileSync(templatePath, 'utf8'), readFileSync(claudePath, 'utf8')).map((b) => ({ file: 'CLAUDE.md', ...b }));
}

/** The same for GEMINI.md against `referenceText`, the agy render of the template. */
export function foreignGeminiMdBullets(referenceText, projectDir) {
  const geminiPath = join(projectDir, 'GEMINI.md');
  if (!existsSync(geminiPath)) return [];
  return foreignBulletsIn(referenceText, readFileSync(geminiPath, 'utf8')).map((b) => ({ file: 'GEMINI.md', ...b }));
}

/** The one warning line for a foreign bullet. */
export function foreignBulletWarning({ file = 'CLAUDE.md', line, lead }) {
  const shown = lead.length > 80 ? `${lead.slice(0, 77)}...` : lead;
  return `⚠ ${file}:${line} holds a bullet that is not part of Sterling's layer: ${shown}. Move it to AGENTS.md: every host reads AGENTS.md, while CLAUDE.md and GEMINI.md hold only Sterling's generated layer (decision project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer). Sterling does not edit your file.`;
}

const oneLine = (err) => String(err?.message ?? err).replace(/\s+/g, ' ').trim();

/**
 * The warning lines for a project's CLAUDE.md and GEMINI.md. A scanner failure (an unreadable file,
 * a directory at the path, a render error) becomes one diagnostic line for that file and never throws,
 * so a finished sync keeps its exit status. `geminiReference` is a function returning the agy render
 * of the template; it is called only when GEMINI.md exists.
 */
export function claudeMdWarnings(pluginRoot, projectDir, geminiReference) {
  const lines = [];
  try {
    for (const b of foreignClaudeMdBullets(pluginRoot, projectDir)) lines.push(foreignBulletWarning(b));
  } catch (err) {
    lines.push(`⚠ CLAUDE.md check skipped: ${oneLine(err)}`);
  }
  if (geminiReference) {
    try {
      if (existsSync(join(projectDir, 'GEMINI.md'))) {
        for (const b of foreignGeminiMdBullets(geminiReference(), projectDir)) lines.push(foreignBulletWarning(b));
      }
    } catch (err) {
      lines.push(`⚠ GEMINI.md check skipped: ${oneLine(err)}`);
    }
  }
  return lines;
}
