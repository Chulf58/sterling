// Project identity file and its gitignore entry (decision
// work-project-identity-file-sterling-project-json). Each project carries a
// durable identity in .sterling/project.json, {"project_id": "<uuid v4>"},
// committed to git. init writes it only when absent and never overwrites it;
// update and sync-agents fail loud in a WORK project when it is missing or
// invalid; a hobby project is never checked. The reader and its validation are
// in @sterling/schemas (readProjectIdentity); this file holds the scripts-side
// pieces: the writer, the work-mode verdict and the .gitignore repair.
import { randomUUID } from 'node:crypto';
import { readProjectIdentity, ProjectIdentityError, PROJECT_IDENTITY_REL } from '@sterling/schemas';
import { writeContained } from './contained-fs.mjs';

// Creates .sterling/project.json with a fresh UUID v4 when it is absent. Never
// overwrites: an existing file, valid or not, is left exactly as it is. Returns
// { status: 'created' | 'exists', project_id } or, for an invalid existing file,
// { status: 'invalid', error } — the caller says so loudly.
export function ensureProjectIdentity(root) {
  let identity;
  try {
    identity = readProjectIdentity(root);
  } catch (err) {
    if (!(err instanceof ProjectIdentityError)) throw err;
    return { status: 'invalid', error: err.message };
  }
  if (identity) return { status: 'exists', project_id: identity.project_id };
  const project_id = randomUUID();
  writeContained(root, PROJECT_IDENTITY_REL, `${JSON.stringify({ project_id }, null, 2)}\n`);
  return { status: 'created', project_id };
}

// The refusal text for a WORK project whose identity is missing or invalid, or
// null when the project may proceed. `mode` is what readProjectMode said; a
// hobby project is never checked. An unreadable file (a symlink in the way) is
// the same refusal as an invalid one.
export function workIdentityRefusal(root, mode) {
  if (mode !== 'work') return null;
  try {
    if (readProjectIdentity(root)) return null;
  } catch (err) {
    if (!(err instanceof ProjectIdentityError)) throw err;
    return `work-mode project has an invalid ${PROJECT_IDENTITY_REL}: ${err.message}`;
  }
  return `work-mode project has no ${PROJECT_IDENTITY_REL}: run /sterling:init in the project to create its identity (init never overwrites an existing file), then commit the file`;
}

// .gitignore lines. A directory ignore (`.sterling/`) cannot be re-included
// from, so the identity file needs the `.sterling/*` form plus a negation.
export const IGNORE_DIR = '.sterling/';
export const IGNORE_ALL = '.sterling/*';
export const IGNORE_KEEP_IDENTITY = `!${PROJECT_IDENTITY_REL}`;

// Pure: the .gitignore text with the Sterling directory entry in its identity
// form. `.sterling/` (or an existing `.sterling/*`) becomes `.sterling/*`
// followed by `!.sterling/project.json`, in place; with neither present, the
// pair is appended only when `addIfAbsent` (init) and left out otherwise
// (update never adds an ignore a project did not have). Idempotent. Returns
// { text, changed }; the original line ending and final newline are kept.
export function withIdentityIgnore(text, { addIfAbsent }) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const hadFinalNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (hadFinalNewline) lines.pop();
  const out = [];
  let placed = false;
  for (const line of lines) {
    if (line === IGNORE_DIR || line === IGNORE_ALL) {
      if (!placed) out.push(IGNORE_ALL, IGNORE_KEEP_IDENTITY);
      placed = true;
    } else if (line !== IGNORE_KEEP_IDENTITY) {
      out.push(line);
    }
  }
  if (!placed && addIfAbsent) out.push(IGNORE_ALL, IGNORE_KEEP_IDENTITY);
  const changed = out.length !== lines.length || out.some((line, i) => line !== lines[i]);
  if (!changed) return { text, changed: false };
  return { text: out.length ? `${out.join(eol)}${eol}` : '', changed: true };
}
