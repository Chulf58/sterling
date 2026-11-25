// Sterling's generated layer lives as a marked section of the project's AGENTS.md; init and
// update write no CLAUDE.md or GEMINI.md (decisions
// project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer, GitHub #329).
// This module owns the markers, the in-place regeneration, the Claude Code session block and the
// cleanup of CLAUDE.md / GEMINI.md files that earlier versions wrote.
//
// Safety rules (reviews of #329; simplified in review loop 3, "rebuild over patch"): when in doubt,
// keep the file and warn.
// - Markers: exactly one exact begin line and one exact end line, begin first, neither inside a
//   fenced code block, and no other line in the file names `sterling:begin` or `sterling:end`.
//   Anything else refuses the file. The splice keeps every byte outside the block.
// - AGENTS.md is read and written only as a regular, singly linked file inside the project whose
//   bytes decode as UTF-8 without loss, and every writer checks the exact bytes it writes against
//   agy's 24,000-byte cap.
// - A host file is deleted only when it is a regular file whose whole text, with all-LF or
//   all-CRLF line endings, equals the CURRENT template's render for its host filled with the project's own values, or the
//   one-line `@AGENTS.md` stub; and only by retireAfterWriters, which callers run after every
//   AGENTS.md writer of their sequence, on a layer verified on disk. Older renders are kept.
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderAgyText, renderClaudeText } from './agent-fences.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { ContainmentError, containedPath } from './contained-fs.mjs';

export const LAYER_TEMPLATE_REL = 'templates/sterling-layer-agents.md';
export const CLAUDE_BLOCK_REL = 'templates/claude-session-block.md';
export const HOST_TEMPLATE_REL = 'templates/target-claude-md.md';
/** The shipped pre-split heads of the host template, which init reads to carry a pre-split CLAUDE.md tail (build:bin writes it). */
export const HOST_FILE_HISTORY_REL = 'bin/host-file-history.json';

export const LAYER_BEGIN_PREFIX = '<!-- sterling:begin generated';
export const LAYER_END = '<!-- sterling:end generated -->';
const LAYER_BEGIN = /^<!-- sterling:begin generated(?: \([^()]*\))? -->$/;
const MARKER_LIKE = /^\s*<!--\s*sterling:(?:begin|end)\b/;

/** agy cuts AGENTS.md past this many bytes: the hard limit every planned write is checked against. */
export const AGENTS_MD_AGY_CAP_BYTES = 24_000;
/** The stock render's budget with a typical project name, leaving about 3,000 bytes for project rules. Approximate: long names and stack tags use part of that room; only the 24,000 cap is enforced. */
export const AGENTS_MD_MAX_BYTES = AGENTS_MD_AGY_CAP_BYTES - 3_000;
export const CLAUDE_BLOCK_MAX_BYTES = 2_000;

const normalize = (text) => text.replace(/\r\n/g, '\n');
/** The UTF-8 text of `buf`, or null when decoding would lose or change a byte. */
export function decodeExact(buf) {
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : null;
}
const fwd = (p) => String(p).replace(/\\/g, '/');
const bytes = (s) => Buffer.byteLength(s, 'utf8');

export class LayerMarkerError extends Error {}

/** The generated section, markers included, as shipped. */
export function readLayerSection(pluginRoot) {
  const text = normalize(readFileSync(join(pluginRoot, LAYER_TEMPLATE_REL), 'utf8')).trimEnd();
  const lines = text.split('\n');
  if (!LAYER_BEGIN.test(lines[0]) || lines[lines.length - 1] !== LAYER_END || lines.slice(1, -1).some((l) => MARKER_LIKE.test(l))) {
    throw new LayerMarkerError(`${LAYER_TEMPLATE_REL} must start with the sterling:begin marker line, end with the sterling:end marker line and hold no other marker line`);
  }
  return text;
}

/** The Claude Code block H1 delivers at session start. */
export function readClaudeSessionBlock(pluginRoot) {
  return normalize(readFileSync(join(pluginRoot, CLAUDE_BLOCK_REL), 'utf8')).trimEnd();
}

// Each line of `raw` with its byte offsets: `content` holds no line ending, `end` is past it.
function scanLines(raw) {
  const out = [];
  let start = 0;
  while (start < raw.length) {
    const nl = raw.indexOf('\n', start);
    const end = nl === -1 ? raw.length : nl + 1;
    let contentEnd = nl === -1 ? raw.length : nl;
    if (nl !== -1 && contentEnd > start && raw[contentEnd - 1] === '\r') contentEnd--;
    out.push({ start, contentEnd, end, content: raw.slice(start, contentEnd) });
    start = end;
  }
  return out;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

// The marker lines outside fenced code: { begin, end } line indexes (null when absent), or
// { error } when the file cannot be trusted: a line naming a sterling marker that is not one exact
// marker line outside code, a repeated or unpaired marker, an end before its begin, or a fence left
// open (its text would hide markers, and an appended section would land in it).
const MARKER_WORD = /sterling:(?:begin|end)/;
function findMarkers(lines) {
  const begins = [];
  const ends = [];
  const other = [];
  let fence = null;
  lines.forEach(({ content }, i) => {
    if (fence) {
      if (MARKER_WORD.test(content)) other.push(i);
      const close = FENCE_CLOSE.exec(content);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      return;
    }
    const open = FENCE_OPEN.exec(content);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { ch: open[1][0], len: open[1].length, line: i };
      if (MARKER_WORD.test(content)) other.push(i);
      return;
    }
    if (LAYER_BEGIN.test(content)) begins.push(i);
    else if (content === LAYER_END) ends.push(i);
    else if (MARKER_WORD.test(content)) other.push(i);
  });
  if (fence) return { error: `AGENTS.md has a code fence opened at line ${fence.line + 1} that is never closed, so its marker lines cannot be told from code` };
  if (other.length) return { error: `AGENTS.md line ${other.map((i) => i + 1).join(', ')} names a sterling marker but is not one exact marker line outside code` };
  if (!begins.length && !ends.length) return { begin: null, end: null };
  if (begins.length === 1 && ends.length === 1 && begins[0] < ends[0]) return { begin: begins[0], end: ends[0] };
  return { error: `AGENTS.md has ${begins.length} sterling:begin and ${ends.length} sterling:end marker lines outside code (one of each, begin first, is required)` };
}

const lastEol = (raw) => {
  const at = raw.lastIndexOf('\n');
  return at > 0 && raw[at - 1] === '\r' ? '\r\n' : '\n';
};

/**
 * AGENTS.md text with the generated section regenerated in place. Every byte outside the markers
 * is kept as it was, line endings included; the block takes the begin line's ending. No markers:
 * the section is appended after the file as written. Untrusted markers throw (P5).
 */
export function applyLayer(agentsText, section) {
  const lines = scanLines(agentsText);
  const found = findMarkers(lines);
  if (found.error) throw new LayerMarkerError(`${found.error}; fix the markers by hand, then rerun`);
  if (found.begin === null) {
    const eol = lastEol(agentsText);
    const block = section.split('\n').join(eol);
    if (agentsText === '') return `${block}${eol}`;
    return `${agentsText}${agentsText.endsWith('\n') ? eol : eol + eol}${block}${eol}`;
  }
  const begin = lines[found.begin];
  const end = lines[found.end];
  const eol = agentsText.slice(begin.contentEnd, begin.end) || lastEol(agentsText);
  return agentsText.slice(0, begin.start) + section.split('\n').join(eol) + agentsText.slice(end.contentEnd);
}

/** The marker line range of a LF-normalized text: { begin, end } (null when absent); throws LayerMarkerError. */
export function layerLineRange(text) {
  const found = findMarkers(scanLines(text));
  if (found.error) throw new LayerMarkerError(found.error);
  return { begin: found.begin, end: found.end };
}

/**
 * AGENTS.md of `projectDir` as { exists, text } for a writer, or throws LayerMarkerError when it
 * is not safe to read or replace: a symbolic link or other non-regular file on the path
 * (contained-fs), a file with more than one hard link (it would alias another file), or bytes
 * that are not lossless UTF-8.
 */
export function readAgentsMd(projectDir, { readFile = readFileSync } = {}) {
  let path;
  try {
    path = containedPath(projectDir, 'AGENTS.md', 'file');
  } catch (err) {
    if (err instanceof ContainmentError) throw new LayerMarkerError(`AGENTS.md is not a plain file in the project (${err.message}), so Sterling neither reads nor writes it`);
    throw err;
  }
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return { exists: false, path, text: null };
    throw err;
  }
  if (st.nlink > 1) throw new LayerMarkerError(`AGENTS.md has ${st.nlink} hard links, so writing it could change another file; Sterling neither reads nor writes it`);
  const text = decodeExact(readFile(path));
  if (text === null) throw new LayerMarkerError('AGENTS.md is not valid UTF-8 text, so rewriting it would change bytes Sterling cannot read; Sterling leaves it alone');
  return { exists: true, path, text };
}

/** Why exactly `text` may not be written as AGENTS.md (untrusted markers, or over agy's cap as written), else null. */
export function plannedAgentsMdRefusal(text) {
  const found = findMarkers(scanLines(text));
  if (found.error) return found.error;
  return capRefusal(text);
}

/** { ok: true } when AGENTS.md on disk holds exactly `section` between trusted markers, else { ok: false, reason }. */
export function verifyLayerOnDisk(projectDir, section) {
  let agents;
  try {
    agents = readAgentsMd(projectDir);
  } catch (err) {
    if (err instanceof LayerMarkerError) return { ok: false, reason: err.message };
    return { ok: false, reason: `AGENTS.md could not be read back (${err?.code ?? err?.message ?? err})` };
  }
  if (!agents.exists) return { ok: false, reason: 'AGENTS.md does not exist' };
  const lines = scanLines(agents.text);
  const found = findMarkers(lines);
  if (found.error) return { ok: false, reason: found.error };
  if (found.begin === null) return { ok: false, reason: 'AGENTS.md has no Sterling layer section' };
  const onDisk = lines.slice(found.begin, found.end + 1).map((l) => l.content).join('\n');
  if (onDisk !== section) return { ok: false, reason: 'the Sterling layer section in AGENTS.md differs from the shipped one' };
  const overCap = capRefusal(agents.text);
  return overCap ? { ok: false, reason: overCap } : { ok: true };
}

/** Refusal text when `text` is over agy's cap, else null. */
export function capRefusal(text) {
  const n = bytes(text);
  if (n <= AGENTS_MD_AGY_CAP_BYTES) return null;
  return `AGENTS.md would be ${n.toLocaleString('en-US')} bytes with the Sterling layer, over agy's ${AGENTS_MD_AGY_CAP_BYTES.toLocaleString('en-US')}-byte cap, so nothing was written and no CLAUDE.md or GEMINI.md was removed. Shorten the project's own text in AGENTS.md by at least ${(n - AGENTS_MD_AGY_CAP_BYTES).toLocaleString('en-US')} bytes (move detail into a linked doc), then rerun`;
}

// ---- CLAUDE.md / GEMINI.md written by earlier versions ----

const RENDERERS = { claude: renderClaudeText, agy: renderAgyText };
const TOKEN = /\{\{([A-Z_]+)\}\}/g;

// The current template as that host's file holds it before the values are filled in.
function tokenRender(templateText, host) {
  return normalize(RENDERERS[host](normalize(templateText), HOST_TEMPLATE_REL));
}

// The values put in at the token positions of `tokenText` (CLAUDE.md: the project name; GEMINI.md:
// the name and the Sterling root); the candidate file is never rewritten.
function fill(tokenText, { name, root }) {
  return tokenText.replace(TOKEN, (whole, key) => (key === 'PROJECT_NAME' ? name : key === 'STERLING_ROOT' && root !== null ? root : whole));
}

/**
 * The bin/host-file-history.json content: every distinct pre-split head of the host template (the
 * text above {{CONVENTIONS_SECTION}}), newest first, which init reads only to carry a pre-split
 * CLAUDE.md's project tail into AGENTS.md. It authorises no deletion. Throws without git history.
 */
export function hostFileHistorySnapshot({ repoRoot, git = (args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }) }) {
  const log = git(['log', '--format=%H', '--', HOST_TEMPLATE_REL]);
  if (log.error || log.status !== 0) throw new Error(`host file history: git log failed in ${repoRoot} (${log.error?.message ?? log.stderr}) — ${HOST_FILE_HISTORY_REL} can only be built from a clone`);
  const shas = log.stdout.split('\n').filter(Boolean);
  if (!shas.length) throw new Error(`host file history: ${HOST_TEMPLATE_REL} has no git history in ${repoRoot}`);
  const lineIndex = new Map();
  const lines = [];
  const heads = [];
  const seenHeads = new Set();
  for (const sha of shas) {
    const show = git(['show', `${sha}:${HOST_TEMPLATE_REL}`]);
    if (show.status !== 0) throw new Error(`host file history: git show ${sha}:${HOST_TEMPLATE_REL} failed (${show.stderr})`);
    const text = normalize(show.stdout);
    const at = text.indexOf('{{CONVENTIONS_SECTION}}');
    if (at === -1) continue;
    const head = text.slice(0, at);
    if (seenHeads.has(head)) continue;
    seenHeads.add(head);
    heads.push(head.split('\n').map((line) => {
      if (!lineIndex.has(line)) {
        lineIndex.set(line, lines.length);
        lines.push(line);
      }
      return lineIndex.get(line);
    }));
  }
  return `${JSON.stringify({ version: 3, lines, presplit_heads: heads })}\n`;
}

/** The shipped pre-split heads: { ok: true, heads: string[] } or { ok: false, reason } when missing or malformed. Other read errors throw. */
export function loadHostFileHistory(pluginRoot) {
  const path = join(pluginRoot, HOST_FILE_HISTORY_REL);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, reason: `${fwd(path)} is missing` };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `${fwd(path)} is unparseable (${err.message})` };
  }
  const lines = parsed?.lines;
  const isText = (t) => Array.isArray(t) && t.every((i) => Number.isInteger(i) && i >= 0 && i < lines.length);
  const valid = parsed?.version === 3 && Array.isArray(lines) && lines.every((l) => typeof l === 'string') &&
    Array.isArray(parsed.presplit_heads) && parsed.presplit_heads.every(isText);
  if (!valid) return { ok: false, reason: `${fwd(path)} does not have the expected shape` };
  return { ok: true, heads: parsed.presplit_heads.map((t) => t.map((i) => lines[i]).join('\n')) };
}

/**
 * Values a host file was filled with, known without reading it: the project's recorded name and
 * its directory name, and the Sterling roots GEMINI.md could name (this plugin root, the
 * per-user link ~/.gemini/sterling-root, and any `roots` the caller adds, such as agy's copy).
 */
export function knownHostValues({ projectDir, pluginRoot, projectNames = [], roots = [], home = homedir() }) {
  const names = [...projectNames];
  const configPath = join(projectDir, '.sterling', 'config.json');
  if (existsSync(configPath)) {
    // A config that cannot be parsed only leaves the directory name as a candidate: fewer
    // candidates can keep a file Sterling wrote, never delete one it did not.
    try {
      const recorded = JSON.parse(readFileSync(configPath, 'utf8'))?.project_name;
      if (typeof recorded === 'string') names.push(recorded);
    } catch {
      // see above
    }
  }
  names.push(basename(resolve(projectDir)));
  const allRoots = [resolve(pluginRoot), join(home, '.gemini', 'sterling-root'), ...roots].map(fwd);
  return { names: [...new Set(names.filter(Boolean))], roots: [...new Set(allRoots.filter(Boolean))] };
}

/**
 * How `fileText`, a CLAUDE.md (host 'claude') or GEMINI.md (host 'agy'), relates to Sterling's
 * render: { pure: true } only when its whole text is exactly, with all-LF or all-CRLF line
 * endings, the current template's render for that host filled at its token positions with `known`
 * values, or (claude) the one-line `@AGENTS.md` stub. An older render is not pure: it is kept, and
 * the warning says so.
 */
export function classifyHostFile(fileText, host, { pluginRoot, known }) {
  if (host === 'claude' && ['@AGENTS.md', ...authorizedEols('@AGENTS.md\n')].includes(fileText)) return { pure: true };
  const combos = known.names.flatMap((name) => (host === 'agy' ? known.roots.map((root) => ({ name, root })) : [{ name, root: null }]));
  const current = tokenRender(readFileSync(join(pluginRoot, HOST_TEMPLATE_REL), 'utf8'), host);
  return { pure: combos.some((v) => authorizedEols(fill(current, v)).includes(fileText)) };
}

// The exact texts a render `lf` may have been written as: LF, or every line CRLF (a CRLF checkout
// of the template on Windows). The candidate is never folded, so mixed line endings match neither.
const authorizedEols = (lf) => [lf, lf.replace(/\n/g, '\r\n')];

const HOSTS = [
  { file: 'CLAUDE.md', host: 'claude', consequence: 'Claude Code ignores AGENTS.md (including the Sterling layer) while a CLAUDE.md exists' },
  { file: 'GEMINI.md', host: 'agy', consequence: 'agy loads it next to AGENTS.md, so its text is read twice and counts against agy\'s 24,000-byte limit' },
];

/**
 * Remove the CLAUDE.md and GEMINI.md that earlier versions wrote, only when `layer` says the
 * Sterling section is verified in AGENTS.md and the file is a regular file holding nothing but
 * Sterling's render; it is re-read just before the unlink and kept if it changed. Every other
 * case keeps the file. Rows: { item, status: 'removed' | 'kept', detail }; a kept row also
 * carries `warning`, the sentence the user needs; a `failed` row is a pure file whose unlink failed.
 * `readFile` and `unlink` are test seams.
 */
export function retireHostFiles({ projectDir, pluginRoot, known, layer, readFile = readFileSync, unlink = unlinkSync }) {
  const rows = [];
  for (const { file, host, consequence } of HOSTS) {
    const path = join(projectDir, file);
    const keep = (why, remedy = `Move your rules into AGENTS.md outside the sterling:begin/sterling:end markers, then delete ${file}`) => {
      rows.push({ item: file, status: 'kept', detail: why, warning: `${file} ${why}, so it was kept. ${consequence}. ${remedy}.` });
    };
    let st;
    try {
      st = lstatSync(path);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      keep(`could not be checked (${err?.code ?? err?.message ?? err})`);
      continue;
    }
    if (!layer.ok) {
      keep(`was not checked for removal because the Sterling layer is not verified in AGENTS.md (${layer.reason})`, 'Fix AGENTS.md as reported, then rerun');
      continue;
    }
    if (!st.isFile()) {
      keep(`is not a regular file (${st.isSymbolicLink() ? 'a symbolic link' : st.isDirectory() ? 'a directory' : 'a special file'}), and Sterling only removes files it wrote`);
      continue;
    }
    let content;
    try {
      content = readFile(path);
    } catch (err) {
      keep(`could not be read (${err?.code ?? err?.message ?? err})`);
      continue;
    }
    const text = decodeExact(content);
    if (text === null) {
      keep('is not valid UTF-8 text, so it cannot be Sterling\'s render');
      continue;
    }
    let verdict;
    try {
      verdict = classifyHostFile(text, host, { pluginRoot, known });
    } catch (err) {
      keep(`could not be compared with Sterling's render (${HOST_TEMPLATE_REL}: ${err?.message ?? err})`);
      continue;
    }
    if (!verdict.pure) {
      keep("holds text that is not Sterling's generated layer", `It may be an older Sterling render: if it holds no rules of your own, delete ${file}; otherwise move your rules into AGENTS.md outside the sterling:begin/sterling:end markers, then delete ${file}`);
      continue;
    }
    let again;
    let againStat;
    try {
      againStat = lstatSync(path);
      again = againStat.isFile() ? readFile(path) : null;
    } catch (err) {
      keep(`changed while it was being checked (${err?.code ?? err?.message ?? err})`, 'Rerun to check it again');
      continue;
    }
    if (!again || againStat.ino !== st.ino || !again.equals(content)) {
      keep('changed while it was being checked', 'Rerun to check it again');
      continue;
    }
    // A failed unlink is recorded and the loop goes on, so the receipt of a file already removed
    // is never lost; the row is `failed`, and callers exit non-zero on it.
    try {
      unlink(path);
    } catch (err) {
      rows.push({ item: file, status: 'failed', detail: `could not be removed (${err?.code ?? err?.message ?? err})`, warning: `${file} holds only Sterling's generated text but could not be removed (${err?.code ?? err?.message ?? err}), so it was kept. ${consequence}. Delete ${file} by hand.` });
      continue;
    }
    rows.push({ item: file, status: 'removed', detail: "held only Sterling's generated text; the layer now lives in AGENTS.md" });
  }
  return { rows };
}

/** One line per outcome, prefixed so /sterling:update and the post-update sync can relay them. */
export const LAYER_LINE = 'Sterling layer:';
export const LAYER_WARN = '⚠ Sterling layer:';
export const LAYER_REFUSED = '✗ Sterling layer REFUSED:';

/**
 * The update-time layer pass for one project: regenerate the layer section in its AGENTS.md and
 * write it, or refuse (write nothing) on an unsafe AGENTS.md, untrusted markers or a result over
 * agy's cap. It removes no host file: callers run retireAfterWriters once every AGENTS.md writer of
 * their sequence is done. Returns { lines, refused }; a project without AGENTS.md is left to init.
 */
export function syncLayer({ projectDir, pluginRoot }) {
  const lines = [];
  let refused = 0;
  const refuse = (msg) => {
    lines.push(`${LAYER_REFUSED} ${msg}`);
    refused++;
  };
  const section = readLayerSection(pluginRoot);
  let agents = null;
  try {
    agents = readAgentsMd(projectDir);
  } catch (err) {
    if (!(err instanceof LayerMarkerError)) throw err;
    refuse(`${err.message}. Nothing was written.`);
  }
  if (agents && !agents.exists) {
    lines.push(`${LAYER_WARN} skipped — this project has no AGENTS.md; run /sterling:init`);
  } else if (agents) {
    let after = null;
    try {
      after = applyLayer(agents.text, section);
    } catch (err) {
      if (!(err instanceof LayerMarkerError)) throw err;
      refuse(`${err.message}. Nothing was written.`);
    }
    const why = after === null ? null : capRefusal(after);
    if (why) refuse(`${why}. Fix it, then rerun /sterling:update.`);
    else if (after === agents.text) lines.push(`${LAYER_LINE} AGENTS.md up to date`);
    else if (after !== null) {
      writeFileAtomic(agents.path, after);
      lines.push(`${LAYER_LINE} AGENTS.md regenerated`);
    }
  }
  return { lines, refused };
}

/**
 * The last step of an update for one project, run only after every AGENTS.md writer of the
 * caller's sequence (layer, Knowledge section, contract inserts) has finished without a refusal:
 * verify the layer in AGENTS.md as it now is on disk (exact section, trusted markers, within agy's
 * cap) and only then retire CLAUDE.md / GEMINI.md that hold Sterling's current render.
 * Returns printable lines with the LAYER_* prefixes.
 */
export function retireAfterWriters({ projectDir, pluginRoot, roots = [], unlink }) {
  const layer = verifyLayerOnDisk(projectDir, readLayerSection(pluginRoot));
  const known = knownHostValues({ projectDir, pluginRoot, roots });
  const rows = retireHostFiles({ projectDir, pluginRoot, known, layer, ...(unlink ? { unlink } : {}) }).rows;
  return {
    lines: rows.map((row) => (row.status === 'removed' ? `${LAYER_LINE} ${row.item} removed — ${row.detail}` : `${LAYER_WARN} ${row.warning}`)),
    failed: rows.filter((row) => row.status === 'failed').length,
  };
}

/** The CLAUDE.md / GEMINI.md present in `projectDir` (a symlink or directory counts). */
export function retainedHostFiles(projectDir) {
  return HOSTS.map((h) => h.file).filter((file) => {
    try {
      lstatSync(join(projectDir, file));
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Replace AGENTS.md of `projectDir` with `text` only when it is still safe to (readAgentsMd's
 * checks) and the planned text passes plannedAgentsMdRefusal. Returns null when written, else the
 * refusal reason; nothing is written on a refusal. The exact bytes written are checked. For writers
 * other than the layer pass (the Knowledge refresh).
 */
export function writeAgentsMdChecked(projectDir, text) {
  let agents;
  try {
    agents = readAgentsMd(projectDir);
  } catch (err) {
    if (err instanceof LayerMarkerError) return err.message;
    throw err;
  }
  const why = plannedAgentsMdRefusal(text);
  if (why) return why;
  writeFileAtomic(agents.path, text);
  return null;
}
