// Project identity file and its gitignore entry (decision
// work-project-identity-file-sterling-project-json). Each project carries a
// durable identity in .sterling/project.json, {"project_id": "<uuid v4>"},
// committed to git. init writes it only when absent and never overwrites it;
// update and sync-agents fail loud in a WORK project, or a project whose
// config.storage is 'postgres', when it is missing or invalid; any other
// project is not checked. The reader and its validation are
// in @sterling/schemas (readProjectIdentity); this file holds the scripts-side
// pieces: the writer, the work-mode verdict and the .gitignore repair.
import { randomUUID } from 'node:crypto';
import { readProjectIdentity, ProjectIdentityError, PROJECT_IDENTITY_REL } from '@sterling/schemas';
import { writeContained } from './contained-fs.mjs';
import { readProjectStorage } from './handoff-projection.mjs';

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

// The refusal text for a project that needs an identity and whose identity is
// missing or invalid, or null when the project may proceed. A project needs one
// when `mode` (what readProjectMode said) is 'work' OR its config.storage is
// 'postgres' (the Postgres schema is named by the project_id, and mode does not
// decide storage). A hobby project on SQLite is never checked. A config.storage
// that cannot be read is itself a refusal, never a guess. An unreadable
// identity file (a symlink in the way) is the same refusal as an invalid one.
export function workIdentityRefusal(root, mode) {
  let onPostgres;
  try {
    onPostgres = readProjectStorage(root) === 'postgres';
  } catch (err) {
    return `project storage cannot be read: ${err.message}`;
  }
  if (mode !== 'work' && !onPostgres) return null;
  const subject = mode === 'work' ? 'work-mode project' : 'project with storage postgres';
  try {
    if (readProjectIdentity(root)) return null;
  } catch (err) {
    if (!(err instanceof ProjectIdentityError)) throw err;
    return `${subject} has an invalid ${PROJECT_IDENTITY_REL}: ${err.message}`;
  }
  return `${subject} has no ${PROJECT_IDENTITY_REL}: run /sterling:init in the project to create its identity (init never overwrites an existing file), then commit the file`;
}

// .gitignore lines. A directory ignore (`.sterling/`) cannot be re-included
// from, so the identity file needs the `.sterling/*` form plus a negation.
export const IGNORE_DIR = '.sterling/';
export const IGNORE_ALL = '.sterling/*';
export const IGNORE_KEEP_IDENTITY = `!${PROJECT_IDENTITY_REL}`;
// A pattern with a slash is anchored to the repo root, so `.sterling/*` leaves a
// nested .sterling/ (a stray transient dir under scripts/, say) untracked.
// `*/**/.sterling/` ignores one at any depth below the root and not the root's own,
// so `!.sterling/project.json` keeps working (`**/.sterling/` would hit the root too).
export const IGNORE_NESTED = '*/**/.sterling/';

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

// Pure: the .gitignore text with IGNORE_NESTED present once whenever a
// `.sterling/*` line exists (the form that anchors to the repo root). Without
// that line the file is left alone, as update never adds an ignore a project did
// not have; init appends the line itself with the rest of its entries.
// Idempotent. Returns { text, changed }; line ending and final newline are kept.
export function withNestedIgnore(text) {
  const present = text.split(/\r?\n/);
  if (!present.includes(IGNORE_ALL) || present.includes(IGNORE_NESTED)) return { text, changed: false };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { text: `${text}${text.endsWith('\n') ? '' : eol}${IGNORE_NESTED}${eol}`, changed: true };
}
