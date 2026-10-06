// Project mode and project identity, read from a TARGET project's own
// .sterling/ files. This is the one definition (invariant 1): the strict mode
// judge scripts used to carry in scripts/lib/handoff-projection.mjs (which now
// re-exports it) and the reader for .sterling/project.json (decision
// work-project-identity-file-sterling-project-json).
//
// Mode (decision project-mode-hobby-work-toggle-decides-flow, narrowed by
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
// config.mode decides only how work ships, a direct merge (hobby) or a pull
// request with the review loop (work). Every surface that acts on it reads the
// TARGET project's own config through readProjectMode, never the caller's. A
// missing config or a missing key is hobby, the schema default. An invalid
// value, or a config that is not a JSON object, throws: the mode is never
// guessed. config.ts keeps `mode` permissive on purpose; this is the strict judge.
//
// Reads are contained like every other target read: a symlink anywhere under the
// project root on the path to the file (root itself excluded) is refused, never
// followed. The refusal is a ProjectModeError / ProjectIdentityError, so a caller
// has one class to catch per reader. The race between the check and the read is
// not defended (the same accepted risk as scripts/lib/contained-fs.mjs).
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PROJECT_MODES = ['hobby', 'work'] as const;
export type ProjectMode = (typeof PROJECT_MODES)[number];

export class ProjectModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectModeError';
  }
}
export class ProjectIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectIdentityError';
  }
}

export const CONFIG_REL = '.sterling/config.json';
export const PROJECT_IDENTITY_REL = '.sterling/project.json';

const fwd = (p: string): string => p.replace(/\\/g, '/');

// The UUID v4 shape: version nibble 4, variant nibble 8, 9, a or b.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isProjectId = (value: unknown): value is string => typeof value === 'string' && UUID_V4_RE.test(value);

type ErrorClass = new (message: string) => Error;

// The file's text, or null when it does not exist. Every existing component of
// root/rel is lstat-checked: a symlink, a directory-where-a-file-belongs or a
// file-where-a-directory-belongs throws `ErrorClass`.
function readContainedText(root: string, rel: string, ErrorClass: ErrorClass, subject: string): string | null {
  const segments = rel.split('/');
  let cursor = resolve(root);
  for (const [index, part] of segments.entries()) {
    cursor = join(cursor, part);
    let st;
    try {
      st = lstatSync(cursor);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    }
    const shown = segments.slice(0, index + 1).join('/');
    const isLeaf = index === segments.length - 1;
    if (st.isSymbolicLink()) throw new ErrorClass(`${shown} is a symlink — refusing to follow it out of the project; ${subject} cannot be read`);
    if (isLeaf ? !st.isFile() : !st.isDirectory()) {
      throw new ErrorClass(`${shown} exists but is not a ${isLeaf ? 'regular file' : 'directory'} — ${subject} cannot be read`);
    }
  }
  return readFileSync(cursor, 'utf8');
}

// The target's parsed JSON object (undefined when the file is absent) and its
// path for messages. A file that is not a JSON object throws `ErrorClass`,
// naming the `subject` that could not be read.
function readJsonObject(root: string, rel: string, ErrorClass: ErrorClass, subject: string): { where: string; parsed: Record<string, unknown> | undefined } {
  const where = `${fwd(resolve(root))}/${rel}`;
  const text = readContainedText(root, rel, ErrorClass, subject);
  if (text === null) return { where, parsed: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ErrorClass(`${where} is not valid JSON (${(err as Error).message}) — ${subject} cannot be read`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ErrorClass(`${where} is not a JSON object — ${subject} cannot be read`);
  }
  return { where, parsed: parsed as Record<string, unknown> };
}

export function readProjectMode(root: string): ProjectMode {
  const { where, parsed } = readJsonObject(root, CONFIG_REL, ProjectModeError, 'the project mode');
  if (parsed === undefined || parsed.mode === undefined) return 'hobby';
  if (!(PROJECT_MODES as readonly unknown[]).includes(parsed.mode)) {
    throw new ProjectModeError(`config.mode is ${JSON.stringify(parsed.mode)} in ${where} — it must be 'hobby' or 'work'; switch it in the TUI System tab or fix the file`);
  }
  return parsed.mode as ProjectMode;
}

// The project's durable identity: `{ project_id }` from .sterling/project.json,
// null when the file is absent, a ProjectIdentityError when it exists but is not
// a JSON object holding a UUID v4 `project_id`. Other keys are ignored, never
// returned. Absent is not an error here: whether it matters is the caller's
// (a work-mode project needs it; a hobby project never reads it).
export function readProjectIdentity(root: string): { project_id: string } | null {
  const { where, parsed } = readJsonObject(root, PROJECT_IDENTITY_REL, ProjectIdentityError, 'the project identity');
  if (parsed === undefined) return null;
  if (!isProjectId(parsed.project_id)) {
    throw new ProjectIdentityError(`project_id is ${JSON.stringify(parsed.project_id)} in ${where} — it must be a UUID v4 string; fix the file by hand (init never overwrites it) or restore it from git`);
  }
  return { project_id: parsed.project_id };
}
