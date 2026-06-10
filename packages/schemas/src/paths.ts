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
        re += '(?:.*)';
        i++;
        if (g[i + 1] === '/') i++;
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

/** Helper for callers holding an absolute path plus repo-root context. */
export function toRepoRelative(absolutePath: string, repoRoot: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const abs = norm(absolutePath);
  const root = norm(repoRoot);
  if (!(abs === root || abs.toLowerCase().startsWith(root.toLowerCase() + '/'))) {
    throw new Error(`path invariant violation: '${absolutePath}' is not under repo root '${repoRoot}'`);
  }
  return normalizeRepoPath(abs.slice(root.length + 1));
}
