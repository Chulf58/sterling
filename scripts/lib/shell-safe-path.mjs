// The one shell-safe path rule. A path that lands in an OpenCode shell permission
// pattern and in the command the agent runs must read the same in both without
// quoting, and must not hold a glob character (the Plan agent, opencode-install.mjs).
// /sterling:init applies the same rule to the project folder before it writes
// anything, so a new project can never sit at a path the Plan agent refuses.
// It imports only node builtins.
import { posix } from 'node:path';

const SAFE_CHAR_CLASS = '[A-Za-z0-9_@%+=:,./-]';
export const SHELL_SAFE_PATH_RE = new RegExp(`^${SAFE_CHAR_CLASS}+$`);
const SAFE_CHAR_RE = new RegExp(`^${SAFE_CHAR_CLASS}$`);
export const SHELL_SAFE_CHARS_TEXT = 'letters, digits and _@%+=:,./-';

export function isShellSafePath(path) {
  return SHELL_SAFE_PATH_RE.test(path);
}

/** The distinct characters of `text` the rule does not allow, in first-seen order. */
export function unsafeChars(text) {
  return [...new Set([...text].filter((c) => !SAFE_CHAR_RE.test(c)))];
}

/**
 * A safe folder name for `name`, case kept: a whitespace run becomes '-', an accented
 * letter loses its accent (é -> e), any other unsafe character is dropped, and runs of
 * '-' collapse to one with none left at either end. Null when nothing safe is left.
 */
export function safeFolderName(name) {
  const out = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/\s+/g, '-')
    .split('')
    .filter((c) => SAFE_CHAR_RE.test(c))
    .join('')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return out && out !== '.' && out !== '..' ? out : null;
}

// POSIX double quotes keep everything literal except " $ ` and \, which get a backslash.
const dquote = (s) => `"${s.replace(/["$`\\]/g, '\\$&')}"`;

/**
 * Why `path` (forward slashes, absolute) breaks the rule, and how to fix it; null when
 * it is safe. `folder` and `mv` are set only when the folder's own name is unsafe and
 * a safe name exists; `mv` only when that rename alone makes the whole path safe.
 * Parent directories are named, never renamed: `unsafeParent` is the deepest parent
 * path whose own name breaks the rule.
 */
export function shellUnsafePathFix(path) {
  if (isShellSafePath(path)) return null;
  const parent = posix.dirname(path);
  const name = posix.basename(path);
  const nameUnsafe = unsafeChars(name).length > 0;
  const newName = nameUnsafe ? safeFolderName(name) : null;
  const unsafeParent = isShellSafePath(parent) ? null : deepestUnsafeDir(parent);
  const target = newName === null ? null : posix.join(parent, newName);
  return {
    path,
    chars: unsafeChars(path),
    nameUnsafe,
    unsafeParent,
    folder: target,
    mv: target !== null && unsafeParent === null ? `mv ${dquote(path)} ${dquote(target)}` : null,
  };
}

function deepestUnsafeDir(dir) {
  let d = dir;
  while (isShellSafePath(posix.basename(d)) && posix.dirname(d) !== d) d = posix.dirname(d);
  return d;
}

/**
 * The refusal text for an unsafe path: which path, the characters found, the safe
 * folder to use and the mv command, or a plain statement that a parent directory is
 * the problem. `label` names the path ('the project path'); `rerun` is what to run
 * from the new location.
 */
export function describeShellUnsafePath(path, { label, rerun }) {
  const fix = shellUnsafePathFix(path);
  if (!fix) return null;
  const lines = [
    `${label} '${path}' has ${fix.chars.length === 1 ? 'a character' : 'characters'} that ${fix.chars.length === 1 ? 'is' : 'are'} not shell-safe: ${fix.chars.map((c) => JSON.stringify(c)).join(' ')}. ` +
      `Sterling writes this path into OpenCode shell permission rules, and a space, quote, glob or non-ASCII character there cannot be matched reliably. ` +
      `A path may use only ${SHELL_SAFE_CHARS_TEXT}.`,
  ];
  if (fix.nameUnsafe) {
    lines.push(
      fix.folder === null
        ? `No safe name can be made from '${posix.basename(path)}': rename the folder to one made of ${SHELL_SAFE_CHARS_TEXT}.`
        : `Use the folder name '${posix.basename(fix.folder)}' (a space becomes a hyphen, case is kept).`
    );
  }
  if (fix.unsafeParent !== null) {
    lines.push(
      `The parent directory '${fix.unsafeParent}' breaks the rule${fix.nameUnsafe ? ' too' : ''}; Sterling does not rename parent directories. ` +
        `Move the folder to a location whose whole path uses only ${SHELL_SAFE_CHARS_TEXT}, then ${rerun} from there.`
    );
  }
  if (fix.mv !== null) lines.push(`  ${fix.mv}`, `then ${rerun} from ${fix.folder}.`);
  return lines.join('\n');
}
