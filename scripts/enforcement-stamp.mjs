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
// NO-FOLLOW (board 128fedb7 site 4, 2026-08-25): every read this CLI performs
// and the stamp write itself are now lstat-guarded component by component. The
// stamp is the conductor's ATTESTATION INPUT — H17 exempts a dirty enforcement
// path whose current bytes match a stamp entry — so a link the CLI follows
// poisons an exemption: `existsSync`/`readFileSync` FOLLOW, so a symlink at a
// dirty path had its TARGET's bytes stamped as that path's own, and a symlinked
// `.sterling` ancestor sent `mkdirSync -p` + the stamp write outside the repo.
// The disposition matches H17's: on ANY type ambiguity the CLI REFUSES loudly
// and stamps nothing (never a partial stamp, never a followed link) — the
// conductor resolves the anomaly, which is exactly the audience that can.
// Deliberately DUPLICATED, not shared, with H17's own classifyPathComponents:
// the hook is an esbuild-bundled standalone (invariant 4) and a new shared
// module under scripts/lib/ is outside this change's contract. The duplication
// is real and is surfaced rather than hidden — the two must stay in step.
import { readFileSync, writeFileSync, mkdirSync, lstatSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fail } from './lib/project.mjs';

const target = process.cwd();

// What a path IS, never following a link. 'absent' stays distinct from 'error'
// so a genuine ENOENT can be stamped as a deletion while an EACCES cannot.
function lstatKind(abs) {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isFile()) return 'file';
    if (st.isDirectory()) return 'dir';
    return 'other'; // fifo, socket, device — never attestable
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'absent' : 'error';
  }
}

// Classify EVERY component of a repo-relative path from the repo root down,
// extending the path only after the PRIOR segment is confirmed a real
// directory: by induction every path handed to lstat has zero symlinks in its
// verified prefix, so the OS cannot follow one on the way to the segment being
// checked (lstat refuses to follow only the LAST component). `cwd` is the trust
// anchor and is never itself lstat'd. Returns the final segment's kind; FAILS
// LOUDLY on a non-directory intermediate component.
function classifyPathComponents(cwd, rel, what) {
  const segments = rel.replace(/\/+$/, '').split('/');
  let abs = cwd;
  let soFar = '';
  for (let i = 0; i < segments.length; i++) {
    abs = join(abs, segments[i]);
    soFar = soFar ? `${soFar}/${segments[i]}` : segments[i];
    const kind = lstatKind(abs);
    if (kind === 'absent') return 'absent';
    if (i === segments.length - 1) return kind;
    if (kind !== 'dir') {
      fail(
        `enforcement-stamp: ${what} — path component '${soFar}' (an ancestor of '${rel}') is not a directory (lstat kind: ${kind}); refusing to ` +
          `read/walk/write through a symlink or other non-regular ancestor. Nothing was stamped. Resolve the anomaly at '${soFar}' and re-run.`
      );
    }
  }
  return 'absent';
}

// Recursively list the files beneath a repo-relative directory as
// repo-relative POSIX paths — never hash a directory (FIX L1). The Dirent
// classification is lstat-shaped, and this walk keeps it that way: a symlink is
// never recursed into and never counted as an attestable file, so the walk
// cannot leave the repository and no child's bytes are ever hashed through a
// link. The directory's own components are classified BEFORE it is listed.
function listFilesUnder(cwd, rel) {
  const out = [];
  const walk = (dirRel) => {
    for (const entry of readdirSync(join(cwd, dirRel), { withFileTypes: true })) {
      const childRel = `${dirRel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        fail(
          `enforcement-stamp: dirty path '${childRel}' is a symlink — refusing to attest it or read through it (it may point outside the repository). ` +
            `Nothing was stamped. Remove or resolve the link and re-run.`
        );
      }
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) out.push(childRel);
      else {
        fail(
          `enforcement-stamp: dirty path '${childRel}' is neither a regular file nor a directory — it cannot be attested by a byte hash. ` +
            `Nothing was stamped.`
        );
      }
    }
  };
  const kind = classifyPathComponents(cwd, rel, `refusing to expand the dirty directory '${rel}'`);
  if (kind === 'absent') return out; // vanished between git status and here — nothing to expand
  if (kind !== 'dir') {
    fail(
      `enforcement-stamp: git reported '${rel}' as a dirty DIRECTORY but it is not one (lstat kind: ${kind}) — refusing to walk it. Nothing was stamped.`
    );
  }
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
  // EVERY COMPONENT lstat-classified before the file is read (board 128fedb7
  // site 4): the old `existsSync` + `readFileSync` pair followed a link at the
  // path ITSELF *and* at any ancestor, so a symlinked `.sterling`, `hooks/`, or
  // a linked subdirectory inside a dirty untracked tree got out-of-repo bytes
  // stamped as that repo path's own — and H17 would then exempt whatever the
  // link pointed at.
  const kind = classifyPathComponents(target, path, `refusing to attest the dirty path '${path}'`);
  // FIX L1: a deleted dirty path has no bytes to hash — stamp it as a
  // deletion rather than crashing readFileSync on an absent file. H17's
  // verifyStampAttestation accepts a listed deleted:true entry iff the path
  // is STILL absent; the path reappearing, or a hash expectation going
  // unmet, still denies exactly as today (no partial credit).
  if (kind === 'absent') {
    return { path, deleted: true, at };
  }
  if (kind !== 'file') {
    // A stamp entry is only {path, sha256} or {path, deleted:true} — it cannot
    // express a link target, a directory or a device, so a non-regular dirty
    // path is UNATTESTABLE by construction. Refuse the whole stamp rather than
    // emit an entry that means something other than it says (P5, and never
    // partial credit).
    fail(
      `enforcement-stamp: dirty path '${path}' is not a regular file (lstat kind: ${kind}) — a {path, sha256} stamp cannot attest a symlink, ` +
        `directory or device, and its bytes are never read through a link. Nothing was stamped. Resolve '${path}' and re-run.`
    );
  }
  const bytes = readFileSync(abs);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), at };
});

// The stamp WRITE takes the same walk (board 128fedb7 site 4): mkdirSync
// {recursive:true} traverses every ancestor, so a symlinked `.sterling` or
// `.sterling/transient` planted the conductor's attestation outside the
// repository — where H1's SessionStart delete (P4) would never reach it either.
const stampPath = join(target, '.sterling', 'transient', 'enforcement-stamp.json');
const stampDirKind = classifyPathComponents(target, '.sterling/transient', 'refusing to write the stamp');
if (stampDirKind !== 'dir' && stampDirKind !== 'absent') {
  fail(
    `enforcement-stamp: '.sterling/transient' is not a directory (lstat kind: ${stampDirKind}) — refusing to create or write the stamp through it. ` +
      `Nothing was stamped.`
  );
}
const stampFileKind = classifyPathComponents(target, '.sterling/transient/enforcement-stamp.json', 'refusing to write the stamp');
if (stampFileKind !== 'file' && stampFileKind !== 'absent') {
  fail(
    `enforcement-stamp: the stamp path is not a regular file (lstat kind: ${stampFileKind}) — refusing to write through it. Nothing was stamped.`
  );
}
mkdirSync(dirname(stampPath), { recursive: true });
writeFileSync(stampPath, JSON.stringify(stamp));
console.log(JSON.stringify({ stamped: dirty, at }));
