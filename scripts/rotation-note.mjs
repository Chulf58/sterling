// rotation-note.mjs — write the single-slot ROTATION NOTE (context-rotation slice 3,
// no-capture.mjs precedent: a small sanctioned CLI for a conductor-declared transient).
//
// The note carries ONLY what a fresh session cannot reconstruct from the store, the
// board, or git: the exact next slice, in-flight risks, and pointers. Everything else
// (decisions, remaining work, validation state) already lives in durable surfaces —
// a fat note is a capture-duty failure upstream, not a reason to widen this schema.
//
// Lifecycle (P4): single slot at .sterling/transient/rotation-note.json — a rewrite
// supersedes; H1 CONSUMES it on SessionStart source=clear (single-shot injection).
// Anchored to git HEAD + branch at write time so the restore can disclose drift.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : null;
}

function fail(msg) {
  process.stderr.write(`rotation-note: ${msg}\n`);
  process.exit(2);
}

const cwd = process.cwd();
if (!existsSync(join(cwd, '.sterling'))) {
  fail(`${cwd} is not a Sterling project (.sterling/ missing) — run from the project root`);
}

const nextSlice = (arg('next-slice') ?? '').trim();
if (!nextSlice) {
  fail('--next-slice "<the exact next execution slice>" is required and must be non-empty — a note without a next slice restores nothing actionable');
}

const git = (args) => {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000 });
    return r.status === 0 ? (r.stdout ?? '').trim() : null;
  } catch {
    return null;
  }
};

// BASE BRANCH (N15 + Codex P1-B): mirrors scripts/lib/branch-manager.mjs's
// defaultBranch() resolution order (origin/HEAD symbolic ref, else main,
// else master) rather than importing it, so a base that cannot be
// determined here degrades to "commits_ahead unavailable" instead of
// throwing and refusing the whole note write — the note's other fields are
// still worth saving. TWO CAVEATS this resolution does NOT fix, closed
// instead by the explicit override below: (1) it names the REPO's default
// branch, not the current branch's actual fork point — a feature branch cut
// from a non-default base (e.g. off `release`) mis-counts against `main`;
// (2) origin/HEAD names the REPO default only as a REMOTE-TRACKING ref —
// unconditionally stripping the `origin/` prefix can produce a bare local
// name (`main`) that does not exist as a local branch in a plain clone,
// silently turning `main..HEAD` into a git error and commits_ahead into a
// false null. --base/--into names the ref to diff against directly,
// bypassing resolution entirely — pass it whenever the branch's real base
// differs from the repo default.
function resolveBaseBranch() {
  const explicit = arg('base') ?? arg('into');
  if (explicit) return explicit;
  const sym = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']); // e.g. 'origin/main'
  if (sym) {
    const local = sym.replace(/^origin\//, '');
    // Prefer the identically-named LOCAL branch when it exists (matches
    // what direct-merge.mjs would actually merge into), but when it does
    // NOT — a plain clone with no local `main`, only `origin/main` — use
    // the remote-tracking ref directly rather than stripping it to a name
    // that fails to resolve.
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${local}`])) return local;
    return sym;
  }
  for (const b of ['main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) return b;
  }
  return null;
}

const baseBranch = resolveBaseBranch();
// COUNTS RECOMPUTE, NEVER GET TYPED (N15, docs/feedback/sterling-plugin-*
// 2026-08-24*): the prose fields (objective/risks/pointers) are free text a
// conductor can misstate ("FOURTEEN commits" when the real count was 39) —
// stamping the actual number at write time, the same way head_sha is
// stamped rather than described, gives H1 something it can mechanically
// verify against reality at restore time instead of trusting the prose.
const commitsAheadRaw = baseBranch ? git(['rev-list', '--count', `${baseBranch}..HEAD`]) : null;
const commitsAhead = commitsAheadRaw !== null && /^\d+$/.test(commitsAheadRaw) ? Number(commitsAheadRaw) : null;

const note = {
  next_slice: nextSlice,
  objective: (arg('objective') ?? '').trim() || null,
  risks: (arg('risks') ?? '').trim() || null,
  pointers: (arg('pointers') ?? '').trim() || null,
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  head_sha: git(['rev-parse', 'HEAD']),
  base_branch: baseBranch,
  commits_ahead: commitsAhead,
  at: new Date().toISOString(),
};

const dir = join(cwd, '.sterling', 'transient');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'rotation-note.json'), JSON.stringify(note, null, 2) + '\n');
process.stdout.write(
  `rotation note written (single slot — this supersedes any prior note).\n` +
    `next_slice: ${note.next_slice}\n` +
    (note.branch ? `anchored: ${note.branch} @ ${note.head_sha?.slice(0, 8) ?? '?'}\n` : 'anchored: no git (drift disclosure unavailable)\n') +
    (note.commits_ahead !== null
      ? `commits_ahead: ${note.commits_ahead} (vs ${note.base_branch})\n`
      : 'commits_ahead: unavailable (no origin/HEAD, main, or master to diff against — pass --into to a future version if this recurs)\n') +
    `Tell the user READY TO CLEAR — on /clear, H1 restores and consumes this note automatically.\n` +
    `If server/hook CODE changed since this session started (migration, update, rebuild), /clear alone will not reload it — EXIT AND RELAUNCH the Claude Code CLI first, THEN /clear.\n`
);
