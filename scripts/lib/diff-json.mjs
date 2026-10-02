// Build the reviewer-selection diff-json — [{ path, added_lines: [<content>] }] —
// from git, so the conductor no longer hand-parses a diff each time (P3: script
// over remembered procedure). Two real failures motivate it (board todo 09c237d6):
//   (1) `git diff <base>` does NOT see UNTRACKED new files, so a change that adds
//       files under-counts its diff and under-selects reviewers (r-1417 p2: 602
//       added lines seen as 2, skeptic skipped). We add every untracked file's
//       lines explicitly.
//   (2) added_lines must be line CONTENT, not line numbers: the selector regex-
//       tests each line for security/perf signals and counts `export` lines
//       (scripts/lib/reviewer-selection.mjs). A numbers array silences every
//       content signal (observed 2026-07-02: a `spawn(`-bearing diff skipped the
//       security reviewer).
//
// ONE SNAPSHOT, TWO VIEWS (board f24d42b2). captureDiffSnapshot performs the
// single coherent read of the working tree; the SELECTION view
// (diffJsonFromSnapshot, added content only) and the REVIEWABLE PATCH
// (scripts/lib/review-patch.mjs, complete unified diff) are both derived from
// that same snapshot, so the reviewers can never be selected against one state
// of the tree and handed a patch of another.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout ?? '';
}

// A git query whose ABSENCE is a legitimate answer: `git config` exits 1 when
// the key is unset, and `rev-parse --show-object-format` does not exist before
// git 2.29. Both callers below have a correct default, so a failure returns
// null rather than aborting the capture.
function gitOptional(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

// Parse a unified diff into { path -> [added content lines] }. Only added
// (`+`) content lines are kept, keyed by the new-file path (`+++ b/<path>`);
// removed (`-`) lines, context lines (` `) and headers are ignored; a pure
// deletion (`+++ /dev/null`) contributes no path. A `+++ ` line is treated as a
// FILE HEADER only when the previous line is its `--- ` pair — git always emits
// the two together and never inside a hunk, so an ADDED content line whose text
// starts with `++ ` (emitted as `+++ …`) is not mistaken for a header.
function parseUnifiedDiff(out) {
  const files = {};
  let cur = null;
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('+++ ') && i > 0 && lines[i - 1].startsWith('--- ')) {
      const p = line.slice(4);
      cur = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (cur) files[cur] ??= [];
      continue;
    }
    if (cur && line.startsWith('+')) files[cur].push(line.slice(1));
  }
  return files;
}

// A NUL byte marks binary content: keep the path (so path-based signals still
// fire) but contribute no scannable lines rather than garbage.
function textLines(text) {
  if (text.includes('\0')) return [];
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // drop trailing-newline empty
  return lines;
}

// Read ONE untracked path exactly once, classified by lstat.
// lstat, NEVER readFileSync-through-the-link: an untracked SYMLINK is captured
// as a symlink (its target STRING is the blob content git would store), so
// neither the selection view nor the patch ever persists the bytes of whatever
// out-of-repo file the link points at.
function captureUntracked(cwd, path, fileMode) {
  const abs = join(cwd, path);
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    return { path, kind: 'unrepresentable', reason: `not statable (${e.code ?? e.message})` };
  }
  if (st.isSymbolicLink()) {
    try {
      return { path, kind: 'symlink', target: readlinkSync(abs) };
    } catch (e) {
      return { path, kind: 'unrepresentable', reason: `symlink unreadable (${e.code ?? e.message})` };
    }
  }
  if (!st.isFile()) return { path, kind: 'unrepresentable', reason: 'not a regular file or symlink' };
  let bytes;
  try {
    bytes = readFileSync(abs);
  } catch (e) {
    return { path, kind: 'unrepresentable', reason: `unreadable (${e.code ?? e.message})` };
  }
  return {
    path,
    kind: 'file',
    // The only mode bit git records for a regular file is the executable bit,
    // and it records it ONLY when core.filemode says the filesystem reports
    // that bit truthfully. lstat alone is not enough: on a WSL DrvFs mount
    // (/mnt/c) EVERY file reports 0o111, so a stanza derived from lstat claims
    // `new file mode 100755` for ordinary .mjs/.ts sources that git will store
    // as 100644 — measured on a real artifact where all six untracked stanzas
    // rendered 100755. That is the misleads-a-reviewer class: a security
    // reviewer either chases a phantom executable bit or learns something
    // false about the change.
    mode: fileMode && st.mode & 0o111 ? '100755' : '100644',
    binary: bytes.includes(0),
    bytes,
  };
}

/**
 * Capture the ONE coherent view of the working tree against `base`:
 *   tracked changes: `git diff <base>` (base-tree vs WORKING TREE — captures
 *     committed-since-base + staged + unstaged in one shot; NOT untracked
 *     files), full context so the same text serves as a reviewable patch:
 *     deletions with context, file modes, renames, binary indication;
 *   untracked new files: `git ls-files --others --exclude-standard`, each read
 *     once and classified (regular file / symlink / unrepresentable).
 * The two sets are disjoint (a staged-new file shows in the diff; `--others`
 * lists only unstaged-untracked). `core.quotepath=false` keeps non-ASCII paths
 * literal. The `-c` settings pin the git config knobs KNOWN to move the diff
 * bytes — prefixes, ext-diff, textconv, diff algorithm, the indent heuristic
 * and abbreviation length — which is what the content-addressed artifact needs
 * from a local repo. It is deliberately NOT the claim this comment used to
 * make ("byte-deterministic under any local git config"): git's config surface
 * is open-ended and an exhaustive claim would be one the code cannot keep.
 * `--end-of-options` sits before `base` so a `base` that looks like an option
 * (e.g. `--output=<path>`, an arbitrary-write sink) can never be parsed as one —
 * it is forced into the revision position and, if malformed, fails loud.
 * ONE CAPTURE READS GIT, and it reads core.filemode and the object format here
 * too, so every derived view stays git-free (P3: the derivation is pure).
 */
export function captureDiffSnapshot({ cwd = process.cwd(), base }) {
  if (!base) throw new Error('captureDiffSnapshot requires a base ref');
  const tracked = git(cwd, [
    '-c',
    'core.quotepath=false',
    '-c',
    'diff.noprefix=false',
    '-c',
    'diff.mnemonicPrefix=false',
    '-c',
    'diff.algorithm=myers',
    '-c',
    'diff.indentHeuristic=true',
    // 7 is also the abbreviation the synthesized untracked `index` lines use
    // (scripts/lib/review-patch.mjs), so both halves of the patch read alike.
    '-c',
    'core.abbrev=7',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    '--unified=3',
    '--end-of-options',
    base,
  ]);
  // Unset means git's own default: true everywhere except Windows, where git
  // init writes the key explicitly.
  const fileModeRaw = gitOptional(cwd, ['config', '--bool', 'core.filemode']);
  const fileMode = fileModeRaw === null ? process.platform !== 'win32' : fileModeRaw === 'true';
  // sha1 unless the repository was created with --object-format=sha256; the
  // synthesized `index` lines hash with whichever git would.
  const objectFormat = gitOptional(cwd, ['rev-parse', '--show-object-format']) === 'sha256' ? 'sha256' : 'sha1';
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((rel) => captureUntracked(cwd, rel, fileMode));
  return { cwd, base, tracked, untracked, fileMode, objectFormat };
}

/**
 * The SELECTION view: [{ path, added_lines: [<content>] }].
 * Every untracked line counts as added (a brand-new file is entirely a diff);
 * a symlink contributes its target string, which is what git stores as the
 * blob. If a path somehow appears in both sets its lines are merged.
 */
export function diffJsonFromSnapshot(snapshot) {
  const files = parseUnifiedDiff(snapshot.tracked);
  for (const entry of snapshot.untracked) {
    const lines =
      entry.kind === 'symlink'
        ? [entry.target]
        : entry.kind === 'file' && !entry.binary
          ? textLines(entry.bytes.toString('utf8'))
          : []; // binary or unrepresentable — path only, no scannable content
    (files[entry.path] ??= []).push(...lines);
  }
  return Object.entries(files).map(([path, added_lines]) => ({ path, added_lines }));
}

/** Build the diff-json for reviewer selection against `base` (capture + view). */
export function buildDiffJson({ cwd = process.cwd(), base }) {
  if (!base) throw new Error('buildDiffJson requires a base ref');
  return diffJsonFromSnapshot(captureDiffSnapshot({ cwd, base }));
}
