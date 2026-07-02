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
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout ?? '';
}

// Parse a unified diff (-U0) into { path -> [added content lines] }. Only added
// (`+`) content lines are kept, keyed by the new-file path (`+++ b/<path>`);
// removed (`-`) lines and headers are ignored; a pure deletion (`+++ /dev/null`)
// contributes no path. A `+++ ` line is treated as a FILE HEADER only when the
// previous line is its `--- ` pair — git always emits the two together and never
// inside a hunk, so an ADDED content line whose text starts with `++ ` (emitted
// as `+++ …`) is not mistaken for a header.
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
function fileLines(cwd, rel) {
  let text;
  try {
    text = readFileSync(join(cwd, rel), 'utf8');
  } catch {
    return []; // unreadable (e.g. a dangling symlink) — path only, no content
  }
  if (text.includes('\0')) return [];
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // drop trailing-newline empty
  return lines;
}

/**
 * Build the diff-json for reviewer selection against `base`.
 *   tracked changes: `git diff <base> -U0` (base-tree vs WORKING TREE — captures
 *     committed-since-base + staged + unstaged in one shot; NOT untracked files);
 *   untracked new files: `git ls-files --others --exclude-standard`, every line
 *     counted as added (a brand-new file is entirely a diff).
 * The two sets are disjoint (a staged-new file shows in the diff; `--others`
 * lists only unstaged-untracked), but if a path somehow appears in both its lines
 * are merged. `core.quotepath=false` keeps non-ASCII paths literal.
 * `--end-of-options` sits before `base` so a `base` that looks like an option
 * (e.g. `--output=<path>`, an arbitrary-write sink) can never be parsed as one —
 * it is forced into the revision position and, if malformed, fails loud.
 */
export function buildDiffJson({ cwd = process.cwd(), base }) {
  if (!base) throw new Error('buildDiffJson requires a base ref');
  const files = parseUnifiedDiff(git(cwd, ['-c', 'core.quotepath=false', 'diff', '-U0', '--no-color', '--end-of-options', base]));
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  for (const rel of untracked) {
    (files[rel] ??= []).push(...fileLines(cwd, rel));
  }
  return Object.entries(files).map(([path, added_lines]) => ({ path, added_lines }));
}
