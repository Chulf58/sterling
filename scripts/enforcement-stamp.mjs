// scripts/enforcement-stamp.mjs — CONDUCTOR-run CLI for decision
// h17-enforcement-stamp-conductor-attested-dirt (knowledge_get
// 6e132e19-0da1-47c2-9fa5-710bc7365014).
//
// WIDENED (upgrade-polish review, FIX M3, 2026-08-21): H17's preExisting set
// covers every tracked-and-dirty-or-untracked path that is enforcement
// surface, under hooks/, OR out of the run's brief scope — not only
// hooks/*.mjs / hooks/hooks.json. A CLI that stamped hooks/** alone made the
// exemption unreachable the moment a SINGLE non-hooks brief-scope path was
// also dirty pre-existing, with no remedy that could work. The CLI's contract
// is now: attest EVERY dirty path `git status --porcelain -z` reports —
// tracked modified/renamed AND untracked, files and (expanded) directories —
// 'the conductor's in-flight dirt, bytes pinned', not just the hooks/ subset.
// Written to .sterling/transient/enforcement-stamp.json, OVERWRITING any
// prior stamp (never merged/appended): the stamp is only ever a snapshot of
// "what the conductor has just attested", not an accumulating log.
//
// This is a CONDUCTOR act, deliberately: an agent Bash command cannot run this
// script and self-attest its own tamper (decision alternatives_rejected).
// H1 deletes the stamp unconditionally at every SessionStart (P4) — a new
// session's conductor re-attests deliberately, and the CLI is cheap to re-run.
//   node scripts/enforcement-stamp.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fail } from './lib/project.mjs';

const target = process.cwd();

// Recursively list the files beneath a repo-relative directory as
// repo-relative POSIX paths — never hash a directory (FIX L1).
function listFilesUnder(cwd, rel) {
  const out = [];
  const walk = (dirRel) => {
    for (const entry of readdirSync(join(cwd, dirRel), { withFileTypes: true })) {
      const childRel = `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) walk(childRel);
      else out.push(childRel);
    }
  };
  walk(rel);
  return out;
}

// Same detection H17's (A) tracked branch performs: `git status --porcelain -z`,
// NUL-separated `XY <path>` entries; a rename/copy (R/C) consumes a SECOND
// field `XY NEW\0OLD` — both paths are candidates. Untracked directories
// collapse to `?? dir/` in git's own output — expanded to the files beneath
// (FIX L1), never stamped as a directory.
function allDirtyPaths(cwd) {
  const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '-z'], { encoding: 'utf8' });
  if (status.error || status.status !== 0) {
    fail(`enforcement-stamp: git status --porcelain -z failed (status ${status.status}: ${status.stderr || status.error})`);
  }
  const tokens = status.stdout.split('\0');
  const rels = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const xy = tok.slice(0, 2);
    const candidates = [tok.slice(3)];
    if (xy[0] === 'R' || xy[0] === 'C') candidates.push(tokens[++i]); // OLD path follows
    for (const c of candidates) {
      const isDir = c.endsWith('/');
      const rel = c.replace(/\/+$/, '');
      if (!rel) continue;
      if (isDir) {
        for (const child of listFilesUnder(cwd, rel)) rels.add(child);
      } else {
        rels.add(rel);
      }
    }
  }
  return [...rels];
}

const dirty = allDirtyPaths(target);
if (dirty.length === 0) {
  fail('enforcement-stamp: nothing to attest — the working tree is fully clean against HEAD (no dirty path to stamp)');
}

const at = new Date().toISOString();
const stamp = dirty.map((path) => {
  const abs = join(target, path);
  // FIX L1: a deleted dirty path has no bytes to hash — stamp it as a
  // deletion rather than crashing readFileSync on an absent file. H17's
  // verifyStampAttestation accepts a listed deleted:true entry iff the path
  // is STILL absent; the path reappearing, or a hash expectation going
  // unmet, still denies exactly as today (no partial credit).
  if (!existsSync(abs)) {
    return { path, deleted: true, at };
  }
  const bytes = readFileSync(abs);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), at };
});

const stampPath = join(target, '.sterling', 'transient', 'enforcement-stamp.json');
mkdirSync(dirname(stampPath), { recursive: true });
writeFileSync(stampPath, JSON.stringify(stamp));
console.log(JSON.stringify({ stamped: dirty, at }));
