import { z } from 'zod';

// Path invariant (spec §3.2, global): every path anywhere in the system is
// stored and compared as a repo-relative POSIX path — forward slashes, no
// drive prefix. Normalized HERE, at the schema boundary, so no caller can
// write a backslash path; without one normalization point, file-key joins
// silently return nothing (the silent decay P5 forbids).

/** Normalize to repo-relative POSIX form, or throw on what cannot be made repo-relative. */
export function normalizeRepoPath(input: string): string {
  const fwd = input.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(fwd)) {
    throw new Error(`path invariant violation: drive-prefixed path is not repo-relative: '${input}'`);
  }
  if (fwd.startsWith('/')) {
    throw new Error(`path invariant violation: absolute path is not repo-relative: '${input}'`);
  }
  const parts: string[] = [];
  for (const seg of fwd.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      throw new Error(`path invariant violation: parent-escaping path: '${input}'`);
    }
    parts.push(seg);
  }
  if (parts.length === 0) {
    throw new Error(`path invariant violation: empty path: '${input}'`);
  }
  return parts.join('/');
}

/** zod boundary schema: accepts mixed separators, emits normalized repo-relative POSIX. */
export const repoPath = z.string().transform((value, ctx) => {
  try {
    return normalizeRepoPath(value);
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
    return z.NEVER;
  }
});

/**
 * Minimal POSIX glob matcher for the path machinery (H3 out_of_scope, H5 test
 * freeze, H4 read wall): '**' crosses segments, '*' within a segment, '?' one
 * char. One definition — hooks and checks import this, never reimplement.
 */
export function matchesGlob(path: string, glob: string): boolean {
  const g = glob.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++; // consume the second '*'
        // '**/' matches zero or more COMPLETE segments; a bare/trailing '**'
        // matches anything. The prior '(?:.*)' was unanchored, so '**/foo.ts'
        // wrongly matched inside a segment ('barfoo.ts') — audit finding 10/43.
        if (g[i + 1] === '/') {
          re += '(?:[^/]*/)*';
          i++; // consume the '/'
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$').test(path.replace(/\\/g, '/'));
}

const normSep = (p: string) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * THE canonical case-folding rule for comparing two filesystem paths, in ONE
 * place so no caller re-derives it. Containment/equality is CASE-SENSITIVE
 * except for genuinely case-insensitive drive-prefixed (NTFS) paths:
 * whole-path case-folding wrongly relativized a differently-cased SIBLING
 * directory on a case-sensitive FS — audit finding 32/43 (the company runs
 * WSL-primary, ext4 case-sensitive), and unconditional folding makes /Repo and
 * /repo — genuinely distinct directories on Linux — compare equal.
 *
 * Folding is decided by the PAIR, not by either path alone: a drive prefix on
 * EITHER side means both sides are NTFS-cased.
 */
function foldPairForCompare(a: string, b: string): [string, string] {
  const drivePrefixed = /^[A-Za-z]:/.test(a) || /^[A-Za-z]:/.test(b);
  return drivePrefixed ? [a.toLowerCase(), b.toLowerCase()] : [a, b];
}

/**
 * Do two paths name the SAME location? Separator- and trailing-slash-
 * insensitive; case-sensitive per foldPairForCompare's drive-aware rule.
 *
 * Exported so callers needing only the comparison (H4's repo-root check) reuse
 * the rule instead of copying an unconditional toLowerCase, which is correct on
 * NTFS and WRONG on a case-sensitive filesystem.
 */
export function samePath(a: string, b: string): boolean {
  const [x, y] = foldPairForCompare(normSep(a), normSep(b));
  return x === y;
}

/**
 * Is `p` absolute on EITHER host? node:path's isAbsolute is HOST-NATIVE, so it
 * answers a different question depending on which OS runs Node — 'C:\\tree' and
 * '\\tree' are absolute under win32 and relative under POSIX. Any path that
 * crosses hosts (config values, stored records) must be classified with this
 * host-independent predicate instead (decision windows-linux-parity).
 *
 * Absolute means: a drive prefix FOLLOWED BY a separator ('C:/x', 'C:\\x' — but
 * not the drive-relative 'C:x', which win32 also calls relative), a POSIX root
 * ('/x'), or a Windows root-relative / UNC path ('\\x', '\\\\server\\share').
 */
export function isAbsolutePathAnyHost(p: string): boolean {
  const s = String(p ?? '');
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\');
}

/** Helper for callers holding an absolute path plus repo-root context. */
export function toRepoRelative(absolutePath: string, repoRoot: string): string {
  const abs = normSep(absolutePath);
  const root = normSep(repoRoot);
  const [a, r] = foldPairForCompare(abs, root);
  if (!(a === r || a.startsWith(r + '/'))) {
    throw new Error(`path invariant violation: '${absolutePath}' is not under repo root '${repoRoot}'`);
  }
  return normalizeRepoPath(abs.slice(root.length + 1));
}
