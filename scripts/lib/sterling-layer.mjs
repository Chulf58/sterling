// Sterling's generated layer lives as a marked section of the project's AGENTS.md; init and
// update write no CLAUDE.md or GEMINI.md (decisions
// project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer, GitHub #329).
// This module owns the markers, the in-place regeneration, the Claude Code session block and the
// cleanup of CLAUDE.md / GEMINI.md files that earlier versions wrote.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderAgyText, renderClaudeText } from './agent-fences.mjs';

export const LAYER_TEMPLATE_REL = 'templates/sterling-layer-agents.md';
export const CLAUDE_BLOCK_REL = 'templates/claude-session-block.md';
const HOST_TEMPLATE_REL = 'templates/target-claude-md.md';

export const LAYER_BEGIN_PREFIX = '<!-- sterling:begin generated';
export const LAYER_END = '<!-- sterling:end generated -->';

/** agy cuts AGENTS.md past this many bytes; init keeps 3,000 of them free for project rules. */
export const AGENTS_MD_AGY_CAP_BYTES = 24_000;
export const AGENTS_MD_MAX_BYTES = AGENTS_MD_AGY_CAP_BYTES - 3_000;
export const CLAUDE_BLOCK_MAX_BYTES = 2_000;

const normalize = (text) => text.replace(/\r\n/g, '\n');

export class LayerMarkerError extends Error {}

/** The generated section, markers included, as shipped. */
export function readLayerSection(pluginRoot) {
  const text = normalize(readFileSync(join(pluginRoot, LAYER_TEMPLATE_REL), 'utf8')).trimEnd();
  const lines = text.split('\n');
  if (!lines[0].startsWith(LAYER_BEGIN_PREFIX) || lines[lines.length - 1] !== LAYER_END) {
    throw new LayerMarkerError(`${LAYER_TEMPLATE_REL} must start with the sterling:begin marker line and end with the sterling:end marker line`);
  }
  return text;
}

/** The Claude Code block H1 delivers at session start. */
export function readClaudeSessionBlock(pluginRoot) {
  return normalize(readFileSync(join(pluginRoot, CLAUDE_BLOCK_REL), 'utf8')).trimEnd();
}

function markerLines(lines) {
  const begins = [];
  const ends = [];
  lines.forEach((line, i) => {
    if (line.startsWith(LAYER_BEGIN_PREFIX)) begins.push(i);
    if (line === LAYER_END) ends.push(i);
  });
  return { begins, ends };
}

/**
 * AGENTS.md text with the generated section regenerated in place; everything outside the markers
 * is kept byte for byte. No markers: the section is appended. A begin without its end, an end
 * before its begin, or a repeated marker throws (P5): the file is never guessed at.
 */
export function applyLayer(agentsText, section) {
  const eol = agentsText.includes('\r\n') ? '\r\n' : '\n';
  const text = normalize(agentsText);
  const lines = text.split('\n');
  const { begins, ends } = markerLines(lines);
  let out;
  if (begins.length === 0 && ends.length === 0) {
    const body = text.replace(/\s+$/, '');
    out = `${body}${body ? '\n\n' : ''}${section}\n`;
  } else if (begins.length === 1 && ends.length === 1 && begins[0] < ends[0]) {
    out = [...lines.slice(0, begins[0]), ...section.split('\n'), ...lines.slice(ends[0] + 1)].join('\n');
  } else {
    throw new LayerMarkerError(`AGENTS.md has ${begins.length} sterling:begin and ${ends.length} sterling:end marker lines (one of each, begin first, is required); fix the markers by hand, then rerun`);
  }
  return eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
}

// ---- CLAUDE.md / GEMINI.md written by earlier versions ----

// A template's tokens split it into literal segments; a file matches when the segments appear in
// order, each token standing for one line of text. The whole file must be covered, so a file with
// any extra line does not match.
function matchesWhole(fileText, templateText) {
  const segments = templateText.split(/\{\{[A-Z_]+\}\}/);
  const file = normalize(fileText).trim();
  const first = segments.length === 1 ? segments[0].trim() : segments[0].trimStart();
  if (!file.startsWith(first)) return false;
  let pos = first.length;
  for (let i = 1; i < segments.length; i++) {
    const last = i === segments.length - 1;
    const seg = last ? segments[i].trimEnd() : segments[i];
    if (!seg.length) continue;
    if (last) {
      if (!file.endsWith(seg) || file.length - seg.length < pos) return false;
      return !file.slice(pos, file.length - seg.length).includes('\n');
    }
    let idx = file.indexOf(seg, pos);
    while (idx !== -1 && file.slice(pos, idx).includes('\n')) idx = file.indexOf(seg, idx + 1);
    if (idx === -1) return false;
    pos = idx + seg.length;
  }
  return pos === file.length;
}

const DEFAULT_CONVENTIONS = '(grows only via architecture-altering decision records — nothing yet)';

function historicalTemplateTexts(pluginRoot) {
  const log = spawnSync('git', ['log', '--format=%H', '-n', '300', '--', HOST_TEMPLATE_REL], { cwd: pluginRoot, encoding: 'utf8' });
  if (log.error || log.status !== 0) return [];
  const out = [];
  for (const sha of log.stdout.split('\n').filter(Boolean)) {
    const show = spawnSync('git', ['show', `${sha}:${HOST_TEMPLATE_REL}`], { cwd: pluginRoot, encoding: 'utf8' });
    if (show.status === 0) out.push(show.stdout);
  }
  return out;
}

function renders(templateText, host) {
  try {
    const text = host === 'claude' ? renderClaudeText(templateText, HOST_TEMPLATE_REL) : renderAgyText(templateText, HOST_TEMPLATE_REL);
    return [text.replaceAll('{{CONVENTIONS_SECTION}}', DEFAULT_CONVENTIONS)];
  } catch {
    return [];
  }
}

/**
 * True when `fileText` is a CLAUDE.md (host 'claude') or GEMINI.md (host 'agy') that holds only
 * Sterling's generated text: the current template's render, or, where the git history of the
 * template is readable, a render of an earlier revision. A one-line `@AGENTS.md` file counts for
 * claude. The history is absent on an installed copy, so an older render there is not
 * recognized and the file is kept.
 */
export function isPureSterlingHostFile(fileText, host, pluginRoot) {
  const text = normalize(fileText).trim();
  if (host === 'claude' && text === '@AGENTS.md') return true;
  const current = readFileSync(join(pluginRoot, HOST_TEMPLATE_REL), 'utf8');
  if (renders(current, host).some((t) => matchesWhole(text, t))) return true;
  return historicalTemplateTexts(pluginRoot).some((old) => renders(old, host).some((t) => matchesWhole(text, t)));
}

const HOSTS = [
  { file: 'CLAUDE.md', host: 'claude', consequence: 'Claude Code ignores AGENTS.md (including the Sterling layer) while a CLAUDE.md exists' },
  { file: 'GEMINI.md', host: 'agy', consequence: 'agy loads it next to AGENTS.md, so its text is read twice and counts against agy\'s 24,000-byte limit' },
];

/**
 * Remove the CLAUDE.md and GEMINI.md that earlier versions wrote, only when they hold nothing but
 * Sterling's generated text. Any other content is the project's: the file is kept and a warning
 * names it. Rows: { item, status, detail }; warns: printable lines.
 */
export function retireHostFiles({ projectDir, pluginRoot }) {
  const rows = [];
  const warns = [];
  for (const { file, host, consequence } of HOSTS) {
    const path = join(projectDir, file);
    if (!existsSync(path)) continue;
    let pure;
    try {
      pure = isPureSterlingHostFile(readFileSync(path, 'utf8'), host, pluginRoot);
    } catch (err) {
      rows.push({ item: file, status: 'kept', detail: `could not be checked (${err?.message ?? err})` });
      warns.push(`\n⚠ ${file} could not be checked against Sterling's generated text (${err?.message ?? err}), so it was kept. ${consequence}.`);
      continue;
    }
    if (pure) {
      unlinkSync(path);
      rows.push({ item: file, status: 'removed', detail: "held only Sterling's generated text; the layer now lives in AGENTS.md" });
    } else {
      rows.push({ item: file, status: 'kept', detail: "holds text that is not Sterling's generated layer" });
      warns.push(`\n⚠ ${file} holds text that is not Sterling's generated layer, so it was kept. ${consequence}. Move your rules into AGENTS.md outside the sterling:begin/sterling:end markers, then delete ${file}.`);
    }
  }
  return { rows, warns };
}

/**
 * The update-time pass for one project: regenerate the layer section in its AGENTS.md (a project
 * without AGENTS.md is left to init), then retire the host files. Returns printable lines.
 */
export function syncLayer({ projectDir, pluginRoot }) {
  const lines = [];
  const agentsPath = join(projectDir, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    try {
      const before = readFileSync(agentsPath, 'utf8');
      const after = applyLayer(before, readLayerSection(pluginRoot));
      if (after === before) {
        lines.push('Sterling layer in AGENTS.md: up to date');
      } else {
        const tmp = `${agentsPath}.tmp-${process.pid}`;
        writeFileSync(tmp, after);
        renameSync(tmp, agentsPath);
        lines.push('Sterling layer in AGENTS.md: regenerated');
      }
    } catch (err) {
      if (!(err instanceof LayerMarkerError)) throw err;
      lines.push(`\n⚠ ${err.message}`);
    }
  } else {
    lines.push('Sterling layer in AGENTS.md: skipped (no AGENTS.md; run /sterling:init)');
  }
  const retired = retireHostFiles({ projectDir, pluginRoot });
  lines.push(...retired.rows.map((r) => `${r.item} ${r.status}: ${r.detail}`), ...retired.warns);
  return lines;
}
