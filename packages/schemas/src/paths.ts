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

/**
 * Do two ABSOLUTE paths name the same location across the Windows/WSL host
 * boundary? A drive path ('C:/x', 'C:\\x') is read as its WSL DrvFs spelling
 * ('/mnt/c/x'), so a record written from a Windows-side session and a project
 * root seen under WSL2 compare equal (Dome Farmer issue entry 454: working_tree
 * 'C:/Users/chulf/Dome Farmer' against root '/mnt/c/Users/chulf/Dome Farmer').
 * Separator- and trailing-slash-insensitive. Case-insensitive only when BOTH
 * sides land on DrvFs (/mnt/<drive>), whose default is case-insensitive NTFS;
 * everywhere else case is significant, as in samePath.
 *
 * Does NOT resolve symlinks, '..' segments or the filesystem — a pure string
 * question. A relative or empty value is never a location and never matches
 * (a symbolic working_tree name such as a branch is foreign by construction).
 */
export function sameLocationAnyHost(a: string, b: string): boolean {
  const x = drvfsForm(a);
  const y = drvfsForm(b);
  if (x === undefined || y === undefined) return false;
  const [fx, fy] = foldDrvfs(x, y);
  return fx === fy;
}

/**
 * Is `child` STRICTLY inside `parent` (a segment-boundary descendant, never the same
 * location)? Same folding as sameLocationAnyHost: separators, trailing slashes, drive
 * versus /mnt/<drive> spelling, case-insensitive only when both land on DrvFs. '/a/clone2'
 * is not under '/a/clone'. A pure string question, like sameLocationAnyHost: no symlinks,
 * no '..'. A relative or empty value is never a location and never matches.
 */
export function isUnderLocationAnyHost(child: string, parent: string): boolean {
  const x = drvfsForm(child);
  const y = drvfsForm(parent);
  if (x === undefined || y === undefined) return false;
  const [c, p] = foldDrvfs(x, y);
  return c.startsWith(p + '/');
}

// An absolute path in its WSL DrvFs spelling, slashes forward, no trailing slash; undefined
// for a relative or empty value.
function drvfsForm(p: string): string | undefined {
  const s = String(p ?? '').replace(/\\/g, '/');
  if (!isAbsolutePathAnyHost(s)) return undefined;
  const drive = /^([A-Za-z]):\/(.*)$/.exec(s);
  return (drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2]}` : s).replace(/\/+$/, '');
}

// Lower-case both sides only when both are on DrvFs (case-insensitive NTFS by default).
function foldDrvfs(x: string, y: string): [string, string] {
  const onDrvfs = (p: string) => /^\/mnt\/[A-Za-z](\/|$)/.test(p);
  return onDrvfs(x) && onDrvfs(y) ? [x.toLowerCase(), y.toLowerCase()] : [x, y];
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

// reference_material.location — ONE classifier (invariant 1), imported by the
// schema's write transform, the file_key extractor and the server's read-time
// refresh_reference check. A location is free text that is only SOMETIMES a
// repo path: treating every one as a path collapsed 'https://' to 'https:/' on
// write (issue #14) and called URLs and prose "no longer exists on disk"
// (issue #13).

/**
 * A scheme of two or more characters and ':' with the rest attached: 'https://…',
 * 'mailto:a@b.com', 'urn:isbn:1', 'jira:ABC-12', 's3:/bucket/key'. One character
 * is a Windows drive ('c:/docs'), never a scheme; 'Note: ask the team' has a
 * space after the colon and is prose.
 */
const SCHEME_LOCATION = /^[a-z][a-z0-9+.-]+:(\S|$)/i;
/**
 * A web URL whose '//' an earlier write collapsed to '/' (issue #14 damage).
 * Only http, https and ftp: 'file:/tmp/x' and 's3:/bucket/key' are legitimate
 * single-slash forms, not damage.
 */
const COLLAPSED_URL_LOCATION = /^(https?|ftp):\/[^/]/i;
/** With whitespace, a path has a separator and ends in a file extension. */
const HAS_SEPARATOR = /[\\/]/;
const ENDS_IN_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

export type LocationKind = 'url' | 'prose' | 'path';

/** Is this location a web URL whose scheme separator was collapsed to a single slash? */
export function isCollapsedUrlLocation(location: string): boolean {
  return COLLAPSED_URL_LOCATION.test(location.trim());
}

/**
 * THE rule for what a reference_material location is, decided on the trimmed
 * text alone (no filesystem, no network), first match wins:
 *   1. 'url'   — it starts with a scheme of two or more characters and ':'
 *                (SCHEME_LOCATION); a collapsed 'https:/host' is one too.
 *   2. 'path'  — it has no whitespace; or it has whitespace, contains '/' or
 *                '\', ends in a file extension and mentions no '://'
 *                ('docs/Design Notes/spec.md').
 *   3. 'prose' — everything else with whitespace ("See the vendor portal,
 *                section 4").
 * Two limits, both accepted: a sentence that ends in a file path ("see
 * docs/foo.md") reads as a path, and one prose word with no whitespace
 * ("Confluence") reads as a path. A file whose own name starts 'word:'
 * reads as a url. 'path' does NOT mean repo-relative — an absolute or
 * parent-escaping one is still a path; repoPathOfLocation answers that.
 */
export function classifyLocation(location: string): LocationKind {
  const text = location.trim();
  if (SCHEME_LOCATION.test(text)) return 'url';
  if (!/\s/.test(text)) return 'path';
  return HAS_SEPARATOR.test(text) && ENDS_IN_EXTENSION.test(text) && !text.includes('://') ? 'path' : 'prose';
}

/**
 * The normalized repo-relative path a location names, or undefined when it
 * names none: a URL, prose, or a path that is absolute, drive-prefixed or
 * parent-escaping (an external document, never repo-located).
 */
export function repoPathOfLocation(location: string): string | undefined {
  if (classifyLocation(location) !== 'path') return undefined;
  try {
    return normalizeRepoPath(location.trim());
  } catch {
    return undefined;
  }
}

/**
 * The stored form of a location: a repo-relative path is normalized (invariant
 * 2); a URL, prose and an external path are kept exactly as given.
 */
export function normalizeLocation(location: string): string {
  return repoPathOfLocation(location) ?? location;
}
