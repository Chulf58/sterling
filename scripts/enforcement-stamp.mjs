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
// WIDENED AGAIN (Ruling 1 of decision h17-ruling-d-needs-a-b-enumerating-stamp-
// producer-and-stamp-invalidation, fac9a69b): git-reported dirt is no longer the
// whole set. H17's (B) baseline families are GITIGNORED and so are invisible to
// `git status` at any flag setting used here — they are now enumerated EXPLICITLY
// by `baselineSetPaths` and emitted in the SAME entry shape. See the full
// reasoning, and the disclosed deleted-(B)-path residual, at that function.
// SECOND DISCLOSED RESIDUAL OF THAT WIDENING, named because it is AGENT-REACHABLE:
// the (B) families are now enumerated on EVERY run, and this CLI's standing rule is
// that a non-regular dirty path REFUSES THE WHOLE STAMP (never a partial stamp,
// never a followed link). So a single symlink, fifo or device planted anywhere
// under `.claude/agents/**` — or a non-regular `.claude/settings*.json` — now makes
// the producer refuse to stamp ANYTHING, denying the conductor all attestation
// until a human clears it. That is a denial-of-attestation an agent can trigger,
// and before the widening it could only be triggered by git-visible dirt.
// ACCEPTED, NOT FIXED: the failure is FAIL-CLOSED and LOUD (nonzero exit naming the
// offending path, nothing written), which is the correct direction — the opposite
// design, skipping the anomalous path and stamping the rest, would attest a (B) set
// while silently omitting the one member an attacker had tampered with. The remedy
// is in the message and is a human action; the cost is a refusal, never a false
// attestation.
// Written to .sterling/transient/enforcement-stamp.json, OVERWRITING any
// prior stamp (never merged/appended): the stamp is only ever a snapshot of
// "what the conductor has just attested", not an accumulating log.
//
// This is a CONDUCTOR act, deliberately: an agent Bash command cannot run this
// script and self-attest its own tamper (decision alternatives_rejected).
// H1 deletes the stamp unconditionally at every SessionStart (P4) — a new
// session's conductor re-attests deliberately, and the CLI is cheap to re-run.
//   node scripts/enforcement-stamp.mjs
// NO-FOLLOW (board 128fedb7 site 4, 2026-08-25), STATED PER PATH BECAUSE THE
// TWO PATHS DIFFER (the single "every read this CLI performs" claim that stood
// here was FALSE, and a false statement about a security property is worse than
// no statement — re-review FIX 8/10d, 2026-08-29). WHY ANY OF IT MATTERS: the
// stamp is the conductor's ATTESTATION INPUT — H17 exempts a dirty enforcement
// path whose current bytes match a stamp entry — so a link the CLI follows
// poisons an exemption. `existsSync`/`readFileSync` FOLLOW, so a symlink at a
// dirty path had its TARGET's bytes stamped as that path's own, and a symlinked
// `.sterling` ancestor sent `mkdirSync -p` + the stamp write outside the repo.
//   * THE WRITE PATH IS DESCRIPTOR-PINNED (`withPinnedStampParent` +
//     `writeStampAt`): the parent is acquired by walking components relative to
//     held descriptors, and the stamp is published by temp-file-plus-rename. Its
//     named residuals — root-anchor authentication, component-identity
//     non-continuity, detached-directory publication, unauthenticated published
//     CONTENT, and the native-Windows arm — are stated at those two functions and
//     are NOT covered by the paragraph below.
//   * THE BYTE-READING PATH IS DESCRIPTOR-PINNED TOO (board 19c43670, 2026-08-29).
//     It USED TO BE lstat-classification only: the emission loop called
//     `classifyPathComponents` and then `readFileSync(abs)` as TWO independent
//     absolute-pathname resolutions, so a component or the leaf could be replaced
//     between them — including with a symlink `readFileSync` then followed, which
//     is exactly the poisoned-exemption shape above. The bytes are now read from a
//     descriptor opened RELATIVE to the same walked, pinned parent chain the write
//     path uses (`withPinnedStampParent` + `readRegularAt`), never from a
//     re-resolved absolute pathname. It therefore INHERITS the residuals named at
//     `withPinnedStampParent` — root-anchor authentication, component-identity
//     non-continuity, and the native-Windows arm — and repairs none of them.
//   * PATH DISCOVERY IS STILL ABSOLUTE-PATHNAME WALKED, and that is a REMAINING
//     residual, named rather than covered by the bullet above: `listFilesUnder`
//     and `baselineSetPaths` enumerate with `readdirSync(join(cwd, rel))`. It is
//     NAME discovery only — every discovered name's BYTES are then read through
//     the pinned walk against the real tree — so a steered enumeration can produce
//     a `deleted:true` entry for a name that is absent, or omit a name entirely.
//     Both directions are fail-CLOSED (H17 honours `deleted:true` only while the
//     path is STILL absent, and an omitted entry grants no exemption at all), so
//     it cannot attribute attacker-chosen bytes to a path — which is why it is
//     disclosed here rather than fixed in the same change (one concern).
// THE DISPOSITION ON ANY TYPE AMBIGUITY IS UNCHANGED AND APPLIES TO BOTH: the CLI
// REFUSES loudly and stamps nothing (never a partial stamp, never a followed
// link) — the conductor resolves the anomaly, which is exactly the audience that
// can.
// Deliberately DUPLICATED, not shared, with H17's own classifyPathComponents:
// the hook is an esbuild-bundled standalone (invariant 4) and a new shared
// module under scripts/lib/ is outside this change's contract. The duplication
// is real and is surfaced rather than hidden — the two must stay in step.
import {
  readFileSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  rmSync,
  openSync,
  closeSync,
  fstatSync,
  statSync,
  statfsSync,
  existsSync,
  writeSync,
  renameSync,
  constants as FS,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
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
  // NO TRAILING RETURN: the loop is TOTAL (review F3). `String.split('/')` always
  // yields at least one element — `''` included — so `i === segments.length - 1`
  // is always reached unless an earlier branch already returned or failed.
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

// RULING 1 of decision h17-ruling-d-needs-a-b-enumerating-stamp-producer-and-
// stamp-invalidation (fac9a69b): THE (B) SET IS ENUMERATED EXPLICITLY, because
// git can never report it. Every member of H17's (B) baseline set —
// `.claude/agents/**`, `.claude/settings*.json`, `.sterling/config.json` — is
// GITIGNORED, so `allDirtyPaths` above (plain `git status --porcelain -z`, no
// `--ignored`) never lists one. No stamp entry for a (B) path could therefore
// ever be produced, and H17's (B) detect-and-deny predicate — "the current bytes
// match a stamp entry" — was UNSATISFIABLE BY CONSTRUCTION: a (B) arm that denies
// every conductor change with no attestation route at all. MEASURED, NOT REASONED:
// with only a (B) path modified, this CLI reported a fully clean tree and refused
// to stamp anything ("nothing to attest"), while the (B) file was demonstrably
// changed on disk.
// THE STAMP FORMAT IS UNCHANGED. These paths flow into the SAME emission loop
// below and produce the SAME `{path, sha256}` / `{path, deleted:true}` entries as
// git-visible dirt; only PATH DISCOVERY widens. That is what keeps Ruling D's
// "no source bytes carried, no stamp-format change" exact — its rejected
// alternative (c-full) refused to carry SOURCE BYTES and said nothing about which
// paths are enumerated.
// ONLY PATHS THAT EXIST ARE ENUMERATED, and the residual is DISCLOSED rather than
// buried: a (B) file the conductor DELETED cannot be enumerated by any means (git
// is blind to it and no name is left to walk to), so it is never emitted as a
// `deleted:true` entry. That residual is narrow because H17 compares each Bash
// call against ITS OWN Pre snapshot — a conductor deletion landing BETWEEN windows
// is absent from both sides and needs no attestation. Only a deletion landing
// INSIDE an audited window is unattestable, which is exactly the "conductor
// stamping must happen BETWEEN audited Bash windows" boundary fac9a69b already
// accepts and states as a policy consequence.
// LSTAT SAFETY IS UNCHANGED AND STILL CARRIED PER PATH: this function only
// DISCOVERS names (`readdirSync` Dirents are lstat-shaped and are never followed,
// and `listFilesUnder` refuses a symlink or non-regular entry at any depth). Every
// discovered path is then classified component by component by the emission loop's
// `classifyPathComponents`, which REFUSES THE WHOLE STAMP on a non-regular member
// rather than emitting an entry that means something other than it says.
function baselineSetPaths(cwd) {
  const out = [];
  // `.claude/agents/**` — recursive. listFilesUnder classifies every ancestor
  // before walking, fails loudly on a symlink/non-regular entry at any depth, and
  // returns [] when the directory is absent.
  for (const rel of listFilesUnder(cwd, '.claude/agents')) out.push(rel);
  // `.claude/settings*.json` — TOP LEVEL ONLY, mirroring H17's own (B) collection.
  // The prefix/suffix test below is a faithful expansion of the case-sensitive
  // glob `settings*.json` (`entry.name` is a single path component, so `*` has no
  // `/` to avoid) — no glob dependency is introduced into a standalone CLI.
  // IT IS A SUPERSET OF THE TWO FILES THAT EXIST IN PRACTICE, deliberately, and
  // the comment that stood here claiming it matches "exactly this pair" was WRONG
  // (review F4): `settings.json` and `settings.local.json` are what a project
  // normally has, but `settingsfoo.json` matches the glob and is enumerated too.
  // NOT TIGHTENED, because the glob is the contract H17 collects by — narrowing it
  // to the known pair would silently drop a (B) member H17 still checks, which is
  // the more dangerous direction. An extra enumerated entry costs one stamp line.
  const claudeKind = classifyPathComponents(cwd, '.claude', "refusing to enumerate the (B) settings family under '.claude'");
  if (claudeKind === 'dir') {
    for (const entry of readdirSync(join(cwd, '.claude'), { withFileTypes: true })) {
      if (!entry.name.startsWith('settings') || !entry.name.endsWith('.json')) continue;
      out.push(`.claude/${entry.name}`); // a non-regular entry is refused, loudly, by the emission loop
    }
  } else if (claudeKind !== 'absent') {
    fail(
      `enforcement-stamp: '.claude' is not a directory (lstat kind: ${claudeKind}) — refusing to enumerate the (B) enforcement set through it. Nothing was stamped.`
    );
  }
  // `.sterling/config.json` — one fixed path, emitted only when it EXISTS (see the
  // deletion residual above). Classified here purely to decide presence; the
  // emission loop classifies it again before reading a byte.
  if (classifyPathComponents(cwd, '.sterling/config.json', "refusing to enumerate the (B) path '.sterling/config.json'") !== 'absent') {
    out.push('.sterling/config.json');
  }
  return out;
}

// The attested set is the UNION of git-visible dirt and the explicitly enumerated
// (B) set. DEDUPED, because the two overlap: a (B) file `git add -f`'d into the
// index is reported by `git status` AND enumerated here, and one path must never
// produce two entries.
const dirty = [...new Set([...allDirtyPaths(target), ...baselineSetPaths(target)])];
if (dirty.length === 0) {
  fail(
    'enforcement-stamp: nothing to attest — the working tree is fully clean against HEAD and the (B) enforcement set ' +
      '(.claude/agents/**, .claude/settings*.json, .sterling/config.json) holds no file to attest (no dirty path to stamp)'
  );
}

// THE EMISSION LOOP IS FURTHER DOWN THE FILE NOW (board 19c43670). It hashes
// bytes read through the pinned component walk, so it must run AFTER the
// module-scope constants that walk depends on (`IS_WIN32`, `PROCFS_FD_DIR`) have
// been evaluated — a `const` is in its temporal dead zone until then, and a loop
// left here would die with a ReferenceError on its first attested path. Function
// declarations hoist; consts do not.

const IS_WIN32 = process.platform === 'win32';
const PROCFS_FD_DIR = '/proc/self/fd';
const PROC_SUPER_MAGIC = 0x9fa0n;

// SECURE I/O PREFLIGHT — Ruling C of decision 532a4383 makes this a HARD DENY,
// never an incidental filesystem error (review FIX 3). Descriptor-relative
// resolution on Linux is spelled `/proc/self/fd/<fd>/<name>`, so WITHOUT a
// working procfs the whole pinned-chain design silently stops being what it
// claims: `openSync` on the anchored path throws a raw ENOENT that is NOT the
// EEXIST the racing-writer handler catches, and the CLI would die with an
// uncaught stack trace instead of the named refusal. Fail closed AND LEGIBLY.
// AUTHENTICATE THE FILESYSTEM, NOT ONE ENTRY, exactly as H17 does
// (h17-bash-write-sweep.mjs:455-502, Slice 2 repair of residual 1 of dfe70090):
// PROC_SUPER_MAGIC is a kernel fact that a directory of decoy numeric symlinks
// cannot fabricate, and only procfs maps ARBITRARY descriptor numbers — which is
// the property the chain walk below depends on, since it opens CHILD fds whose
// numbers no finite probe could have pre-seeded. The fd round-trip is the
// complement: the magic says "this is procfs", the round-trip says "this
// particular procfs node is an FD DIRECTORY". BIGINT dev/ino for the same reason
// H17 uses it — a number-valued 64-bit file id truncates, and a truncated ino
// makes the identity comparison unsound.
// DELIBERATELY DUPLICATED rather than shared, on the same grounds this file's
// header already states for `classifyPathComponents`: H17 is an esbuild-bundled
// standalone (invariant 4) and a new shared module under scripts/lib/ is outside
// this change's contract. The duplication is surfaced, not hidden.
function assertSecureIoAvailable(cwd) {
  if (IS_WIN32) return; // no procfs arm on win32 — see the disclosed residual below
  if (!existsSync(PROCFS_FD_DIR)) {
    fail(`enforcement-stamp: secure I/O unavailable: '${PROCFS_FD_DIR}' is absent, so the stamp cannot be written through a pinned directory chain. Nothing was stamped.`);
  }
  let vfs;
  try {
    vfs = statfsSync(PROCFS_FD_DIR, { bigint: true });
  } catch (e) {
    fail(`enforcement-stamp: secure I/O unavailable: '${PROCFS_FD_DIR}' could not be statfs'd to confirm it is procfs (${(e && e.code) || (e && e.message) || e}). Nothing was stamped.`);
  }
  if (vfs.type !== PROC_SUPER_MAGIC) {
    fail(
      `enforcement-stamp: secure I/O unavailable: '${PROCFS_FD_DIR}' is not on procfs (filesystem magic 0x${vfs.type.toString(16)}, expected ` +
        `0x${PROC_SUPER_MAGIC.toString(16)}) — only the kernel's procfs maps ARBITRARY descriptor numbers, and an ordinary directory of numeric-named ` +
        `entries cannot, however many it pre-seeds. Nothing was stamped.`
    );
  }
  let fd = null;
  try {
    fd = openSync(cwd, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NONBLOCK); // the repo root, the same anchor the walk starts from
    const anchored = `${PROCFS_FD_DIR}/${fd}`;
    const entry = lstatSync(anchored, { bigint: true }); // the fd entry ITSELF, unfollowed
    const through = statSync(anchored, { bigint: true }); // ... and what it resolves to
    const direct = fstatSync(fd, { bigint: true }); // ... versus what the descriptor actually holds
    if (!entry.isSymbolicLink()) {
      fail(`enforcement-stamp: secure I/O unavailable: '${PROCFS_FD_DIR}' exists but its descriptor entries are not the magic symlinks an fd directory is made of. Nothing was stamped.`);
    }
    if (through.dev !== direct.dev || through.ino !== direct.ino) {
      fail(
        `enforcement-stamp: secure I/O unavailable: '${PROCFS_FD_DIR}/<fd>' does not resolve to the object that descriptor holds ` +
          `(resolved dev/ino ${through.dev}/${through.ino}, descriptor ${direct.dev}/${direct.ino}) — present, but not a working descriptor directory. Nothing was stamped.`
      );
    }
  } catch (e) {
    fail(`enforcement-stamp: secure I/O unavailable: '${PROCFS_FD_DIR}' could not be verified as a working descriptor directory (${(e && e.code) || (e && e.message) || e}). Nothing was stamped.`);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

// PIN THE PARENT DIRECTORY BY WALKING THE COMPONENT CHAIN — the fix for the
// review's HIGH finding (FIX 1). The first version of this function opened
// `.sterling/transient` by ABSOLUTE PATHNAME after `classifyPathComponents` had
// walked it, and claimed the parent "cannot be swapped between the
// classification and the write". THAT CLAIM WAS FALSE: `O_NOFOLLOW` constrains
// only the FINAL component, so an attacker replacing the INTERMEDIATE
// `.sterling` with a symlink after the classification and before the open made
// this process pin an attacker-selected directory OUTSIDE the repo, unlink its
// leaf, write there, and print success. The classification and the open were two
// independent resolutions of the same string, which is the very window the pin
// exists to remove.
// WHAT ACTUALLY PROTECTS, STATED PRECISELY (FIX 4a): protection does NOT begin
// at the classification. It begins only once this walk has successfully pinned
// the intended directory — every open below resolves ONE component relative to a
// descriptor this process already holds (`/proc/self/fd/<parentFd>/<name>`),
// never an absolute pathname the kernel re-walks from `/`. The idiom is H17's
// `withPinnedParent` (h17-bash-write-sweep.mjs:793) and its `openPinnedDir`
// (:511), followed rather than reinvented.
// WHAT THE WALK DOES *NOT* GUARANTEE — corrected after re-review (FIX 6). An
// earlier version of this comment said "a component swapped between two steps
// fails the NEXT open". THAT WAS FALSE. `O_NOFOLLOW` rejects redirection THROUGH
// A LINK; it says nothing about DIRECTORY-FOR-DIRECTORY substitution. Rename
// `.sterling` away, put a different REAL directory at that name, and the open
// below succeeds and pins the replacement — as it also can between the
// `mkdirSync` of a missing component and the re-open that follows it. The walk
// therefore preserves NO component identity by itself.
// WHAT THE IDENTITY PASS BELOW ADDS, AND EXACTLY WHAT IT PROVES. After the whole
// chain is pinned, every component is re-resolved ONE MORE TIME through its own
// pinned parent (`lstat` on `<parentHandle>/<name>`) and required to report the
// same dev/ino as `fstat` on the descriptor this walk holds for it. lstat, not
// stat, so a symlink planted at the name reports its OWN identity and mismatches
// rather than being resolved away.
//   PROVES: at verification time, every component name still denotes the very
//   inode this process holds pinned. A substitution that PERSISTS — the realistic
//   attack, since the attacker wants the write to land in their directory — is
//   detected and refused loudly, and the write never happens.
//   DOES NOT PROVE: continuity. The sequence is not atomic, so a substitution
//   that is reverted before the check (swap, swap back) is invisible.
//   WHAT A POST-CHECK SUBSTITUTION DOES AND DOES NOT DO — corrected, because the
//   text here previously claimed it "still redirects the write", and THAT WAS AN
//   OVERCLAIM AGAINST OURSELVES (re-review 10c). It cannot redirect anything: the
//   write goes through the ALREADY-HELD `transient` descriptor, and renaming or
//   replacing a NAME can never re-aim a descriptor this process holds open. The
//   real residual is the opposite shape — the write still lands in the directory
//   we verified, but that directory can by then have been DETACHED from the
//   canonical path (renamed away, or orphaned by a replacement at an ancestor
//   name), so the stamp is written correctly into a directory no longer reachable
//   at `.sterling/transient/`, and this CLI reports SUCCESS. The conductor
//   believes it has attested; H17 later finds no stamp where it looks. That is a
//   real failure mode and it is fail-CLOSED (a missing stamp grants no exemption),
//   but it is a false success report and is named as one.
//   ALSO NOT COVERED: the ROOT anchor, which is resolved by absolute pathname and
//   is the pre-existing, separately-ruled limit named below.
// THE ROOT IS THE ONE OPEN THAT FOLLOWS, deliberately, for the reason H17's
// `openRootAnchorDir` (:515-534) records: `~/proj -> /mnt/data/proj` is an
// entirely ordinary arrangement, and a no-follow open of a symlinked project
// root would refuse every legitimate run. `cwd` is the trust anchor handed to
// this CLI, never a component under test; once held, everything below it is
// resolved through the anchor with O_NOFOLLOW.
// MISSING COMPONENTS ARE CREATED ONE AT A TIME THROUGH THE PINNED PARENT, which
// is why `mkdirSync(dirname(stampPath), {recursive: true})` is gone from the
// call site: `{recursive: true}` resolves and traverses the whole absolute
// string, so it would create — and traverse — directories THROUGH a linked
// ancestor, reintroducing the same defect one line above the fix.
// NATIVE WINDOWS HAS NO PARENT BINDING AT ALL, and this is a DISCLOSED RESIDUAL,
// not a parity claim (FIX 4b; decision h17-windows-detect-and-abort, 2a69a8d7).
// Node cannot open a directory as a descriptor there and libuv ignores
// O_NOFOLLOW, so the win32 arm addresses the parent by path. Concretely, on
// native Windows an ancestor or `transient` JUNCTION swap can still make the
// temp-file create and the rename land in an OUTSIDE directory, and the CLI will
// print success. A standing cross-platform parity requirement is in force on
// this project, so this is named rather than implied away. What IS still true on
// Windows: the HARDLINK-THROUGH-THE-LEAF truncation is genuinely not
// reintroduced — nothing opens the existing leaf for writing at all; a planted
// hardlink is replaced by the rename, never truncated through.
// TWO CALLERS, ONE WALK (board 19c43670). The byte-READING path uses this same
// function rather than a second component walk of its own: two walks in one file
// is how one of them rots out of step with the other, and the reader needs
// EXACTLY the guarantee the writer needs — every component below the anchor
// resolved through a held descriptor. The read caller differs in two ways only,
// both expressed as options rather than as a fork:
//   * `createMissing: false` — a reader must never CREATE a component it was only
//     asked to read through. The `mkdirSync` branch below is the writer's alone.
//   * `onAbsent` — for a reader an absent component is a legitimate ANSWER ('the
//     path is gone', stamped as a deletion), not an error, so it needs a way to
//     say so that is distinct from `fn`'s own return. It is REQUIRED whenever
//     `createMissing` is false; a missing handler is a programming error and is
//     refused loudly rather than defaulted, because defaulting it would silently
//     turn a vanished component into whatever `undefined` means downstream.
// The reader inherits every residual documented above WITHOUT EXCEPTION, and adds
// none: the anchor is still resolved by name, component identity is still not
// continuous, and the win32 arm below is still path-addressed.
function withPinnedStampParent(cwd, relDir, fn, options = {}) {
  const createMissing = options.createMissing !== false;
  const onAbsent = options.onAbsent;
  // The refusals below name WHAT the walk was heading for. It defaults to the
  // stamp file because the writer was the only caller when they were written, and
  // the reader overrides it: a message telling the conductor an ancestor of "the
  // stamp file" is bad, when the offending ancestor is actually above an attested
  // path, sends them to inspect the wrong directory.
  const what = options.what || 'the stamp file';
  if (!createMissing && typeof onAbsent !== 'function') {
    fail('enforcement-stamp: internal error — a non-creating pinned walk was requested without an onAbsent handler, so a vanished component could not be reported. Nothing was stamped.');
  }
  if (IS_WIN32) {
    // DISCLOSED win32 arm: path-addressed throughout, no parent binding — the
    // `{recursive: true}` create is part of the same residual named above, not an
    // oversight, because there is no descriptor to create relative to.
    // A READER creates nothing here either: it is handed the absolute directory
    // path whether or not it exists, and the ENOENT its own leaf open then raises
    // is what reports the absence — the same disposition the Linux arm reaches
    // through `onAbsent`, by a different route.
    const dirAbs = join(cwd, relDir);
    if (createMissing) mkdirSync(dirAbs, { recursive: true });
    return fn(dirAbs);
  }
  assertSecureIoAvailable(cwd);
  const segments = relDir.split('/').filter(Boolean);
  for (const name of segments) {
    if (name === '.' || name === '..' || name.includes('\0')) {
      fail(`enforcement-stamp: refusing to walk to ${what} — the component '${name}' of '${relDir}' is not a plain resolvable name. Nothing was stamped.`);
    }
  }
  // Open ONE child directory relative to an already-pinned parent. Returns null
  // for 'absent' so the caller can create exactly that component; every other
  // non-directory verdict is a loud refusal, never a fallback.
  const openChild = (anchored, soFar) => {
    try {
      return openSync(anchored, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    } catch (e) {
      const code = e && e.code;
      if (code === 'ENOENT') return null;
      if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENXIO' || code === 'ENODEV' || code === 'EOPNOTSUPP') {
        fail(
          `enforcement-stamp: path component '${soFar}' (an ancestor of ${what}) is not a real directory (no-follow open failed: ${code}) — ` +
            `refusing to resolve through a symlink or other non-regular ancestor. Nothing was stamped. Resolve '${soFar}' and re-run.`
        );
      }
      throw e;
    }
  };
  const fds = [];
  const chain = []; // {parentHandle, name, fd, soFar} per component, for the identity pass
  try {
    // O_NONBLOCK, as H17's openers document: a fifo/device swapped in must not
    // BLOCK the open itself and hang a CLI the conductor is waiting on.
    fds.push(openSync(cwd, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NONBLOCK));
    let handle = `${PROCFS_FD_DIR}/${fds[0]}`;
    let soFar = '';
    for (const name of segments) {
      soFar = soFar ? `${soFar}/${name}` : name;
      const anchored = `${handle}/${name}`;
      let fd = openChild(anchored, soFar);
      if (fd === null) {
        // READER: the component is absent, so nothing below it can exist either —
        // report absence and stop walking. Inside the `try`, so the `finally`
        // still closes every descriptor pinned up to this point.
        if (!createMissing) return onAbsent();
        try {
          mkdirSync(anchored); // ONE component, through the pinned parent — never {recursive: true}
        } catch (e) {
          if (!e || e.code !== 'EEXIST') throw e; // a racing create is fine; the re-open below is the authority
        }
        fd = openChild(anchored, soFar);
        if (fd === null) {
          fail(`enforcement-stamp: path component '${soFar}' vanished immediately after it was created — refusing to write the stamp into a racing tree. Nothing was stamped.`);
        }
      }
      chain.push({ parentHandle: handle, name, fd, soFar });
      fds.push(fd);
      handle = `${PROCFS_FD_DIR}/${fd}`;
    }
    // THE IDENTITY PASS (FIX 6). Read the block comment above this function for
    // exactly what this proves and what it deliberately does not. BIGINT dev/ino
    // for the reason H17's procfs repair records: a number-valued 64-bit file id
    // truncates, and a truncated ino makes an identity comparison unsound.
    for (const link of chain) {
      let byName;
      try {
        byName = lstatSync(`${link.parentHandle}/${link.name}`, { bigint: true });
      } catch (e) {
        fail(
          `enforcement-stamp: path component '${link.soFar}' could not be re-resolved through its pinned parent to confirm it still denotes the ` +
            `directory this run pinned (${(e && e.code) || (e && e.message) || e}) — refusing to write the stamp into a tree that is changing underneath it. Nothing was stamped.`
        );
      }
      const byFd = fstatSync(link.fd, { bigint: true });
      if (byName.dev !== byFd.dev || byName.ino !== byFd.ino) {
        fail(
          `enforcement-stamp: path component '${link.soFar}' NO LONGER DENOTES the directory this run pinned (name now dev/ino ` +
            `${byName.dev}/${byName.ino}, pinned descriptor ${byFd.dev}/${byFd.ino}) — a directory was substituted for another underneath the walk, ` +
            `which O_NOFOLLOW cannot reject because it is not a link. Refusing to write the conductor's attestation into it. Nothing was stamped. ` +
            `Resolve '${link.soFar}' and re-run.`
        );
      }
    }
    return fn(handle);
  } finally {
    for (let i = fds.length - 1; i >= 0; i--) {
      try {
        closeSync(fds[i]);
      } catch {}
    }
  }
}

// READ THE ATTESTED BYTES THROUGH THE PINNED PARENT (board 19c43670) — the fix
// for the read-side half of the acquisition class anti_pattern 7760c328 records.
// WHAT WAS WRONG. The emission loop ran `classifyPathComponents(target, path)`
// and then `readFileSync(join(target, path))`. Those are TWO INDEPENDENT
// RESOLUTIONS of the same absolute string, and nothing carries the first one's
// verdict into the second: an actor who replaces an intermediate component
// between them makes the producer hash bytes from a directory of their choosing
// and write them into the stamp UNDER THE ORIGINAL PATH'S NAME. That matters more
// than an ordinary TOCTOU because the stamp is H17's ATTESTATION INPUT — H17
// exempts a changed enforcement path whose current bytes match a stamp entry — so
// a poisoned read buys an exemption for bytes that were never at that path.
// WHAT PROTECTS NOW, STATED AS BEHAVIOUR: the leaf is opened
// `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` RELATIVE to a directory descriptor
// `withPinnedStampParent` walked component by component, and the bytes are read
// FROM THAT DESCRIPTOR (`readFileSync(fd)`), never from a name resolved again.
// The classification that still runs at the call site is an EARLY LEGIBLE
// REFUSAL, exactly as it is on the write side — nothing here trusts its verdict.
// WHAT IS DELIBERATELY NOT CLAIMED. Every residual of the walk is inherited
// unrepaired (no component-identity continuity, no parent binding on native
// Windows), and the enumeration that DISCOVERED this path is still
// absolute-pathname walked — both are named in the file header.
// THE ANCHOR IS THE ONE COMPONENT STILL RESOLVED BY NAME, and it deliberately
// FOLLOWS: `~/proj -> /mnt/data/proj` is an ordinary arrangement and a no-follow
// open of a symlinked project root would refuse every legitimate run. THIS IS THE
// PRE-EXISTING ACCEPTED LIMIT, not a new one laundered through a citation, and the
// check was made rather than asserted: the reader anchors on `target`
// (`process.cwd()`) — the SAME anchor, in the SAME process, through the SAME
// `withPinnedStampParent` the write path already used — and what it REPLACES
// resolved every component from `/` on every read. So the change strictly NARROWS
// what is resolved by name and makes no path reachable that was not reachable
// before. The governing ruling is decision h17-repo-root-authentication-is-out-of-
// scope (knowledge_get f36eb854): root identity is out of the threat model and
// discharged by disclosure, on the grounds that an actor who can replace the
// workspace root already owns `.git`, the store and the config. That ruling was
// written for H17's own anchor; it is cited here because this CLI shares the anchor
// SHAPE and the same reasoning, not because the record names this file.
// O_NONBLOCK is carried for the reason the writer's openers state: a fifo or
// device swapped in must not BLOCK the open and hang a CLI the conductor waits on.
// NOT PROVEN BY THE SUITE, AND SAID PLAINLY (anti_pattern 7760c328's own closing
// paragraph): the defect needs a component swapped MID-FLIGHT, and the
// deterministic stand-in — statically planting a symlink at an intermediate
// component — is refused by `classifyPathComponents` too, so it passes against the
// BROKEN code as well and pins nothing. This guard ships verified by reading and
// independent review, not by a green bar that cannot see it.
function readRegularAt(parentHandle, leaf, rel) {
  let fd;
  try {
    fd = openSync(`${parentHandle}/${leaf}`, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (e) {
    const code = e && e.code;
    // Gone between discovery and the read. The caller stamps a deletion — the same
    // disposition the old `classifyPathComponents(...) === 'absent'` arm reached.
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENXIO' || code === 'ENODEV' || code === 'EOPNOTSUPP') {
      fail(
        `enforcement-stamp: dirty path '${rel}' is not a regular file (no-follow open through its pinned parent failed: ${code}) — a {path, sha256} ` +
          `stamp cannot attest a symlink, directory or device, and its bytes are never read through a link. Nothing was stamped. Resolve '${rel}' and re-run.`
      );
    }
    throw e;
  }
  try {
    // THE TYPE VERDICT COMES FROM THE DESCRIPTOR THIS CALL HOLDS, not from an
    // lstat of a name that could since have changed. `O_NOFOLLOW` already refused
    // a symlink AT THE LEAF; this rejects the shapes it cannot see — a directory,
    // fifo, socket or device — before any of their bytes reach the hash.
    const st = fstatSync(fd);
    if (!st.isFile()) {
      fail(
        `enforcement-stamp: dirty path '${rel}' is not a regular file (the descriptor this run opened for it is not one) — a {path, sha256} stamp ` +
          `cannot attest a directory, fifo or device. Nothing was stamped. Resolve '${rel}' and re-run.`
      );
    }
    return readFileSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

// Read one repo-relative attested path's bytes through the pinned walk. Returns
// the bytes, or null when the path (or any component of it) is ABSENT — which the
// caller stamps as a deletion rather than a hash.
function readAttestedFile(cwd, rel) {
  const segments = rel.split('/').filter(Boolean);
  const leaf = segments[segments.length - 1];
  if (!leaf || leaf === '.' || leaf === '..' || leaf.includes('\0')) {
    fail(`enforcement-stamp: refusing to attest '${rel}' — its final component is not a plain resolvable name. Nothing was stamped.`);
  }
  return withPinnedStampParent(cwd, segments.slice(0, -1).join('/'), (parentHandle) => readRegularAt(parentHandle, leaf, rel), {
    createMissing: false,
    onAbsent: () => null, // a component above the leaf is gone — the path is absent
    what: `the attested path '${rel}'`,
  });
}

// THE STAMP WRITE IS CREATE-ONLY (defect (i) / Ruling 5 of decision
// b-surface-adoption-point-closes-with-an-incident-bound-taint-latch-not-a-persisted-manifest,
// knowledge_get bcd2cc09). The old write was `writeFileSync(stampPath, ...)` — a
// TRUNCATE IN PLACE — guarded only by the lstat classification below. A HARDLINK
// IS A REGULAR FILE TO lstat, so that guard caught SYMLINKS and not HARDLINKS: an
// agent planting a hardlink at the stamp path made THE CONDUCTOR'S OWN PRODUCER
// overwrite an arbitrary victim inode, and exit 0 while doing it. Identical class
// to the (B)-restore primitive `writeUnder`, deleted for exactly this; the
// no-follow work (board 128fedb7 site 4) closed symlinks, not hardlinks. The
// producer cannot become the recovery authority for the taint latch until this is
// temp-file-plus-rename through a pinned parent, which is what this is.
//
// THE IDIOM IS THE ESTABLISHED ONE, mirroring H17's `materializeHeadBlob` +
// `writeRegularAt({createOnly:true})` (h17-bash-write-sweep.mjs:3449/:956):
//   * CREATE A FRESH INODE EXCLUSIVELY. `O_CREAT|O_EXCL|O_NOFOLLOW` on a
//     freshly-randomized TEMPORARY name inside the pinned directory. Nothing ever
//     opens the existing stamp leaf for writing, so there is no descriptor a
//     planted hardlink could be reached through: the bytes THIS CALL WRITES land
//     on an inode THIS CALL CREATED. O_EXCL is what makes that true — an entry
//     that appears in the gap resolves to EEXIST → a loud refusal, never an open.
//   * PUBLISH BY RENAME. `renameSync` within the SAME pinned directory replaces
//     the DIRECTORY ENTRY; it never writes through the entry it replaces, so a
//     hardlink standing at the stamp path is simply unlinked and the victim's
//     bytes are untouched.
// WHY RENAME AND NOT unlink-then-create (review FIX 2). A create-in-place leaves
// TWO holes a rename closes by construction: (1) if `writeSync` throws part-way,
// a PARTIAL file is already sitting at the AUTHORITATIVE name, so a consumer
// racing the write can read an incomplete stamp — with a temp file the partial is
// never published; (2) the unlink destroys the previous stamp BEFORE the new one
// exists, so any later failure leaves the conductor with NO attestation at all.
// Rename has no such window: the name holds the old stamp until the instant it
// holds the new one.
//
// PUBLICATION IS NOT IDENTITY-BOUND, AND NODE CANNOT MAKE IT SO — MEASURED, NOT
// ASSUMED (re-review FIX 5). `renameSync(tmpAnchored, ...)` RE-RESOLVES THE
// TEMPORARY NAME. An actor with mutation authority over the pinned directory can
// enumerate that name, unlink it and put their own regular file or hardlink
// there; the rename then publishes THEIR object. `O_EXCL` proves which inode was
// INITIALLY OPENED, never which inode the source name denotes at rename time, and
// randomness only prevents PRE-planting, not post-creation substitution.
// THE FIX THAT WOULD CLOSE IT is a link/linkat-style publish addressing the OPEN
// DESCRIPTOR instead of a name. IT IS NOT REACHABLE FROM NODE HERE. Node exposes
// only `fs.linkSync(existingPath, newPath)` → `uv_fs_link` → `link(2)`, with no
// `AT_SYMLINK_FOLLOW` and no `AT_EMPTY_PATH` linkat flag, so the only candidate
// source is the `/proc/self/fd/<fd>` magic symlink — and `link(2)` does not
// follow symlinks. PROBED DIRECTLY on this host (Linux, Node v24.14.0):
// `linkSync('/proc/self/fd/<fd>', dst)` fails **EXDEV**, both while the temp name
// still exists and after it has been unlinked; no destination entry is created in
// either case. So the rename stands, and the honest claim is stated here rather
// than implied away:
//   ATOMIC: the NAMESPACE TRANSITION. The stamp path holds the old stamp or the
//   new object, never a partial file and never nothing.
//   NOT AUTHENTICATED: the IDENTITY of the published object. Between this call's
//   `O_EXCL` create and its rename, the source name can be re-pointed, and the
//   rename would publish whatever it then denotes.
// WHAT IS DONE INSTEAD, and it is DETECTION OF ONE SHAPE ONLY, NOT PREVENTION
// AND NOT VERIFICATION: this call holds its write descriptor OPEN across the
// rename and then compares `fstat` on that descriptor against `lstat` of the
// published leaf. Read the next two paragraphs before relying on it — the check
// is considerably weaker than "the published object is verified", which it must
// never be read as.
//   CATCHES: SUBSTITUTION OF A DIFFERENT INODE. The leaf now denotes some other
//   object than the one this call wrote.
//   MISSES ENTIRELY: CONTENT TAMPERING OF THE *SAME* INODE — and on this machine
//   that is the EASIER attack, not the exotic one (re-review 10a). Agent and
//   conductor run as the SAME UID, so `0o600` isolates the temp from nobody. Once
//   the randomized temp name is observed, an attacker can open that very inode and
//   rewrite its bytes; or hardlink it, then unlink and reinstall the temp name
//   from the hardlink. Inode A is published either way, `lstat` and `fstat` both
//   report A, THIS CHECK PASSES, and the stamp the conductor believes it made
//   carries attacker-chosen bytes. Nothing in this CLI detects that.
//   IS A SNAPSHOT, NOT A STATEMENT ABOUT THE PRESENT (re-review 10b). The `lstat`
//   happens strictly before the `fstat` it is compared against, and both happen
//   before the process exits. A leaf replaced immediately after that `lstat`
//   matches, and the CLI prints SUCCESS while the leaf no longer denotes what was
//   written. The failure text is worded to describe the OBSERVED INSTANT for this
//   reason, never "the file now at the stamp path".
//   CANNOT DISTINGUISH a substitution from a genuinely concurrent second producer
//   run — this CLI's standing rule is to refuse loudly on ambiguity, so both
//   refuse, and both clear the leaf (see FIX 9 at the check itself for why
//   clearing is the fail-closed direction in both cases).
// WINDOWS: THE CHECK IS SKIPPED, AND THAT COMPOUNDS AN EXISTING GAP RATHER THAN
// MITIGATING IT (re-review 10e, disclosure only — not fixed here). The win32 arm
// closes before renaming and runs no identity check, because there is no parent
// binding there to make the comparison meaningful and an open handle across a
// rename is platform behaviour this change cannot test. So native Windows now
// lacks pinned-parent acquisition, descriptor-relative resolution, junction-swap
// resistance AND the one detector Linux has. A standing cross-platform parity
// requirement is in force on this project: this WIDENS that gap, and the Windows
// arm must not be read as merely "slightly weaker".
// THE PINNED PARENT IS SUPPLIED BY `withPinnedStampParent` ABOVE, and every claim
// about what cannot be swapped underneath this function lives there — including
// its identity pass, its named non-continuity and detached-directory residuals,
// and the DISCLOSED native-Windows residual, all of which this function inherits
// and none of which it repairs.
//
// MODE: the temp is created 0o600, where the previous in-place `writeFileSync`
// produced 0o666-filtered-by-umask (typically 0o644). A deliberate tightening
// carried by the temp-file shape, recorded rather than silent. Nothing reads the
// stamp as another user: H17 reads it in-process as the same UID that ran this
// CLI. NOTE WHAT 0o600 DOES NOT BUY, since it is easy to over-read: the threat
// actor here is SAME-UID, so the mode stops nobody who matters — see the
// same-inode tampering paragraph above.
//
// TEMP-FILE LIFECYCLE, STATED AS IT ACTUALLY IS (re-review FIX 7/10d). The temp
// is removed on EVERY non-publishing exit path this process controls, from a
// `finally` that also covers a throwing `closeSync` — but the removal is
// BEST-EFFORT: an `rmSync` failure is swallowed so it cannot displace the error
// already driving the exit. THE ONE CASE THAT LEAVES TEMP LITTER is a CRASH or
// kill between the exclusive create and the rename, which leaves
// `.sterling/transient/enforcement-stamp.json.tmp-<pid>-<rand>` behind. (A
// `fail()` AFTER publication does NOT: the rename has already consumed the temp
// name. The serious post-publication residue was always the possibly-forged
// AUTHORITATIVE leaf, and FIX 9 below now removes that.) The temp litter is inert
// — never read by anything, never the authoritative name — but NOTHING SWEEPS IT:
// H1's SessionStart deletion (P4) targets the authoritative stamp path, not
// randomized temp names, so this is genuinely new residue this shape introduces.
// A SEPARATE AND DIFFERENT CLAIM: no `fsync` is issued before the rename, so a
// power loss can publish an empty or short stamp. That one IS covered by H1's
// SessionStart deletion, because it lands at the authoritative name.
function writeStampAt(parentHandle, leaf, buf) {
  const tmpLeaf = `${leaf}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const tmpAnchored = `${parentHandle}/${tmpLeaf}`;
  let fd = null;
  try {
    fd = openSync(tmpAnchored, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW | FS.O_NONBLOCK, 0o600);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      // TWO CAUSES THIS CODE CANNOT DISTINGUISH, so neither is asserted (FIX 4c):
      // something raced an entry into a name randomized microseconds earlier, or —
      // on native Windows, where the parent is addressed by path — the create
      // resolved into a DIFFERENT directory that already held this name. Note what
      // is NOT at risk: the existing stamp has not been touched, because the
      // replacement is published by rename and nothing has been renamed yet.
      fail(
        `enforcement-stamp: an entry already exists at the freshly-randomized temporary stamp name (EEXIST on O_CREAT|O_EXCL) — refusing to open ` +
          `whatever arrived rather than write through it. This is either a racing writer or, on native Windows only, a create that resolved into a ` +
          `different directory; the CLI cannot tell which. Nothing was stamped and any PREVIOUS stamp is untouched (publication is by rename, and no ` +
          `rename happened). Inspect '.sterling/transient/' and re-run.`
      );
    }
    throw e;
  }
  const leafAnchored = `${parentHandle}/${leaf}`;
  let published = false;
  try {
    let written = 0;
    while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written, null);
    if (IS_WIN32) {
      // No parent binding and no testable open-handle-across-rename behaviour on
      // win32: close first, publish, and skip the identity check below.
      closeSync(fd);
      fd = null;
      renameSync(tmpAnchored, leafAnchored);
      published = true;
      return;
    }
    // THE DESCRIPTOR STAYS OPEN ACROSS THE RENAME so the object this call wrote
    // can still be identified AFTER publication — see FIX 5 above for why this is
    // detection and not prevention, and why Node cannot express the prevention.
    renameSync(tmpAnchored, leafAnchored);
    published = true;
    // A FAILED VERIFICATION MUST DESTROY WHAT IT CANNOT VOUCH FOR (re-review
    // FIX 9). Exiting nonzero while leaving the published leaf standing makes
    // this detection WORSE THAN NONE: the operator reads "failed", but H17 is not
    // an operator — it reads `.sterling/transient/enforcement-stamp.json` later
    // and HONOURS matching entries as a conductor attestation. A substituted
    // file's contents are attacker-chosen, so "announce the attack, leave the
    // forgery to be believed" is a route to an exemption for tampered (B) bytes.
    // WHY REMOVAL IS RIGHT EVEN THOUGH SUBSTITUTION AND A CONCURRENT SECOND
    // PRODUCER ARE INDISTINGUISHABLE HERE — the ambiguity reads like an argument
    // for leaving the file, and it is not: NO STAMP IS SAFE (H17 grants no
    // exemption and the enforcement surface simply stays protected), while a
    // WRONG STAMP IS NOT (H17 grants an exemption it should not). The fail-closed
    // direction is therefore removal in BOTH cases. Being wrong about a
    // legitimate concurrent producer costs one re-run of this CLI; being wrong
    // the other way leaves a live forged attestation. Same reasoning already
    // settled for `invalidateStamp` in decision bcd2cc09 Ruling 2 — a denial with
    // no consequence for the ARTEFACT turns the next read into an adoption point.
    // THIS CLEANUP IS NOT BEST-EFFORT, unlike the temp-file removal in the
    // `finally` below: if it fails, the failure text says so and tells the
    // operator to remove the file by hand BEFORE any agent runs. Addressed
    // through the PINNED directory handle, like every other operation here.
    const clearPublished = () => {
      try {
        rmSync(leafAnchored, { force: true });
        return null;
      } catch (e) {
        return `${(e && e.code) || (e && e.message) || e}`;
      }
    };
    const clearedNote = (clearErr) =>
      clearErr === null
        ? `THE STAMP PATH HAS BEEN CLEARED: nothing now stands at '.sterling/transient/enforcement-stamp.json', which is the SAFE state — H17 grants no ` +
          `exemption without a stamp. Note the PREVIOUS stamp is gone too (the rename had already replaced it). Re-run 'node scripts/enforcement-stamp.mjs'.`
        : `COULD NOT CLEAR THE STAMP PATH (${clearErr}) — REMOVE '.sterling/transient/enforcement-stamp.json' BY HAND BEFORE ANY AGENT RUNS. A file this ` +
          `CLI cannot vouch for is sitting at the attestation path, and H17 will honour it if its entries happen to match current bytes.`;
    let byName;
    try {
      byName = lstatSync(leafAnchored, { bigint: true });
    } catch (e) {
      // Cannot confirm what was just published — so it does not get to stand
      // either. Unverifiable and substituted are handled identically.
      const clearErr = clearPublished();
      fail(
        `enforcement-stamp: the stamp was published but could not then be re-read to confirm it is the object this run wrote ` +
          `(${(e && e.code) || (e && e.message) || e}) — TREAT THE ATTESTATION AS INVALID. ${clearedNote(clearErr)}`
      );
    }
    // WRAPPED FOR THE SAME REASON ITS SIBLING `lstat` IS (review F1). This is the
    // OTHER HALF of one verification pair, and an unwrapped throw here (EBADF,
    // EIO) would leave as an uncaught exception: `clearPublished` would never run,
    // and the JUST-PUBLISHED, UNVERIFIED leaf would be left standing — precisely
    // the state the FIX 9 block above says must never exist. The two halves fail
    // identically because they mean the same thing: we could not confirm what we
    // published, so it does not get to stand.
    let byFd;
    try {
      byFd = fstatSync(fd, { bigint: true });
    } catch (e) {
      const clearErr = clearPublished();
      fail(
        `enforcement-stamp: the stamp was published but this run's own write descriptor could not be stat'd to confirm the published file is the ` +
          `object it wrote (${(e && e.code) || (e && e.message) || e}) — TREAT THE ATTESTATION AS INVALID. ${clearedNote(clearErr)}`
      );
    }
    if (byName.dev !== byFd.dev || byName.ino !== byFd.ino) {
      const clearErr = clearPublished();
      fail(
        `enforcement-stamp: the file OBSERVED at the stamp path immediately after publication was NOT the object this run wrote (observed dev/ino ` +
          `${byName.dev}/${byName.ino}, this run's descriptor ${byFd.dev}/${byFd.ino}; both readings are snapshots, not a statement about now). ` +
          `Publication is by rename, which re-resolves the temporary NAME, so the source entry was re-pointed ` +
          `between the exclusive create and the rename — or a second producer ran concurrently; this CLI cannot tell which and refuses on either. ` +
          `TREAT THE ATTESTATION AS INVALID. ${clearedNote(clearErr)}`
      );
    }
  } finally {
    // COVERS THE CLOSE-THROW BRANCH TOO (FIX 7). Best-effort by design: a cleanup
    // failure is swallowed so it cannot displace the error already driving the
    // exit. A `fail()` (process.exit) or a crash bypasses this entirely — that
    // litter is disclosed above, not claimed away.
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    if (!published) {
      try {
        rmSync(tmpAnchored, { force: true });
      } catch {}
    }
  }
}

const at = new Date().toISOString();
const stamp = dirty.map((path) => {
  // AN EARLY, LEGIBLE REFUSAL — NOT THE GUARANTEE (board 19c43670, matching what
  // the write path's two classifications below already say about themselves).
  // This turns the ordinary "someone left a symlink, directory or device on a
  // dirty path" case into a message naming the offending path and its kind,
  // instead of an ELOOP surfacing from inside the reader. NOTHING BELOW TRUSTS
  // ITS VERDICT: a classification is a snapshot of one resolution, and the read
  // resolves again. What actually binds the bytes is `readAttestedFile`, which
  // opens the leaf through a walked, pinned parent chain and hashes the
  // descriptor's contents.
  const kind = classifyPathComponents(target, path, `refusing to attest the dirty path '${path}'`);
  if (kind !== 'file' && kind !== 'absent') {
    // A stamp entry is only {path, sha256} or {path, deleted:true} — it cannot
    // express a link target, a directory or a device, so a non-regular dirty
    // path is UNATTESTABLE by construction. Refuse the whole stamp rather than
    // emit an entry that means something other than it says (P5, and never
    // partial credit). `readRegularAt` refuses the same shapes again, from the
    // descriptor, for the paths that get past this snapshot.
    fail(
      `enforcement-stamp: dirty path '${path}' is not a regular file (lstat kind: ${kind}) — a {path, sha256} stamp cannot attest a symlink, ` +
        `directory or device, and its bytes are never read through a link. Nothing was stamped. Resolve '${path}' and re-run.`
    );
  }
  const bytes = readAttestedFile(target, path);
  // FIX L1: a deleted dirty path has no bytes to hash — stamp it as a deletion
  // rather than crashing the read on an absent file. H17's
  // verifyStampAttestation accepts a listed deleted:true entry iff the path is
  // STILL absent; the path reappearing, or a hash expectation going unmet, still
  // denies exactly as today (no partial credit). THE ABSENCE VERDICT IS THE
  // READ'S, not the classification's: the two can disagree (a path can vanish, or
  // reappear, between them) and the resolution that actually produced — or failed
  // to produce — the bytes is the one that gets to say.
  if (bytes === null) {
    return { path, deleted: true, at };
  }
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), at };
});

// The stamp WRITE takes the same walk (board 128fedb7 site 4): mkdirSync
// {recursive:true} traverses every ancestor, so a symlinked `.sterling` or
// `.sterling/transient` planted the conductor's attestation outside the
// repository — where H1's SessionStart delete (P4) would never reach it either.
// THE TWO CLASSIFICATIONS BELOW ARE EARLY, LEGIBLE REFUSALS, NOT THE GUARANTEE
// (FIX 4a): they turn the ordinary "someone left a symlink/directory/device
// here" case into a message naming the offending path, instead of an ELOOP or an
// EEXIST from deep inside the writer. Nothing downstream TRUSTS their verdict —
// `withPinnedStampParent` re-establishes every component through pinned
// descriptors, because a classification is a snapshot and the pin is the only
// thing that survives a swap.
const STAMP_DIR_REL = '.sterling/transient';
const STAMP_LEAF = 'enforcement-stamp.json';
const stampDirKind = classifyPathComponents(target, STAMP_DIR_REL, 'refusing to write the stamp');
if (stampDirKind !== 'dir' && stampDirKind !== 'absent') {
  fail(
    `enforcement-stamp: '.sterling/transient' is not a directory (lstat kind: ${stampDirKind}) — refusing to create or write the stamp through it. ` +
      `Nothing was stamped.`
  );
}
// KEPT, AND KNOWN INSUFFICIENT ON ITS OWN. This refuses a symlink, directory or
// device standing at the stamp path — a distinct and still-wanted refusal, since
// the writer would otherwise only ever have reported a rename error about it.
// What it CANNOT do is spot a hardlink, which is a regular file to lstat; that is
// the temp-file-plus-rename writer's job, not this check's.
const stampFileKind = classifyPathComponents(target, `${STAMP_DIR_REL}/${STAMP_LEAF}`, 'refusing to write the stamp');
if (stampFileKind !== 'file' && stampFileKind !== 'absent') {
  fail(
    `enforcement-stamp: the stamp path is not a regular file (lstat kind: ${stampFileKind}) — refusing to write through it. Nothing was stamped.`
  );
}
// NO `mkdirSync(dirname(stampPath), {recursive: true})` HERE ANY MORE (FIX 1):
// it resolved the whole absolute string, so it created and traversed directories
// THROUGH a linked ancestor one line before the pinned write. Missing components
// are now created one at a time through the pinned chain.
withPinnedStampParent(target, STAMP_DIR_REL, (parentHandle) => writeStampAt(parentHandle, STAMP_LEAF, Buffer.from(JSON.stringify(stamp))));
console.log(JSON.stringify({ stamped: dirty, at }));
