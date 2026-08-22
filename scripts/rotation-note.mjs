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

const note = {
  next_slice: nextSlice,
  objective: (arg('objective') ?? '').trim() || null,
  risks: (arg('risks') ?? '').trim() || null,
  pointers: (arg('pointers') ?? '').trim() || null,
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  head_sha: git(['rev-parse', 'HEAD']),
  at: new Date().toISOString(),
};

const dir = join(cwd, '.sterling', 'transient');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'rotation-note.json'), JSON.stringify(note, null, 2) + '\n');
process.stdout.write(
  `rotation note written (single slot — this supersedes any prior note).\n` +
    `next_slice: ${note.next_slice}\n` +
    (note.branch ? `anchored: ${note.branch} @ ${note.head_sha?.slice(0, 8) ?? '?'}\n` : 'anchored: no git (drift disclosure unavailable)\n') +
    `Tell the user READY TO CLEAR — on /clear, H1 restores and consumes this note automatically.\n` +
    `If server/hook CODE changed since this session started (migration, update, rebuild), /clear alone will not reload it — EXIT AND RELAUNCH the Claude Code CLI first, THEN /clear.\n`
);
