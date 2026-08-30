// H17 — dual-mode Bash write-sweep (v6.0: detect-deny-latch tripwire; born v3.1
// as a restore-and-deny boundary, decision 2422e76a).
// Registered on the coder frontmatter's Bash PreToolUse (baseline snapshot) AND
// PostToolUse (verify: detect + deny + latch — nothing restores since v6.0).
// Closes the H14 `node --test <writer>` arbitrary
// -write bypass (decision f404dfb4): after an agent Bash command it detects any
// write to
//   (A) TRACKED files — via `git status --porcelain -z` (compared against the
//       per-call Pre-state snapshot; violations denied + latched, bytes left);
//       a VIOLATION iff isEnforcementSurface(rel) || matchesGlob(rel,'hooks/**')
//       OR (run+brief resolvable AND scopeCheck({brief,rel}).deny);
//   (B) the gitignored BASELINE set — `.claude/agents/**` + `.sterling/config.json`
//       + `.claude/settings*.json` (v3.1; NOT sterling.db), snapshotted Pre to
//       os.tmpdir()/sterling-enforce-<runId>.json and diffed Post.
// v3.1 UNIVERSAL FAIL-CLOSED: during an active agent run ANY unexpected error
// (missing/corrupt baseline, fs-error, store/git throw, brief-unresolvable)
// DENIES (exit 2), NEVER a non-blocking exit 1. Non-deny only: no agent_id
// (conductor) → allow; no active run (L2) → baseline + always-set (surface|hooks/**).
// v3.2 (decision h17-stamp-honor-loud-restore, 4d9b76e8): FIX-A — before an
// (A) tracked restore for a path NOT dirty at Pre, a FRESH stamp match on the
// file's CURRENT bytes exempts it (no restore, no deny). FIX-B — every ACTUAL
// (A) restore mints one deduped restore_performed maintenance item per path,
// fail-open, only after the restore succeeded. A store that cannot be opened/
// resolved no longer skips the (A) restore sweep entirely — it is deferred
// (captured, not thrown) so the tracked-restore + mint attempt still run on
// what git alone can tell it, and the original deny still fires after.
// v3.3 (decision h17-pre-state-snapshot-closes-false-denial-not-the-restore-
// hole, 7021526c): Pre also snapshots per-path STATE for everything git reports
// dirty, into a PER-CALL record keyed by sha256(tool_use_id), and Post COMPARES
// it. A pre-dirty path therefore no longer denies merely for being dirty —
// (1) state UNCHANGED -> allow, verified by OBSERVATION, no stamp consulted;
// (2) CHANGED -> the fresh stamp is consulted per path against the CURRENT
// state (4d9b76e8's rule is general) -> exact match allows; (3) otherwise deny.
// NEITHER arm restores: a pre-image restore across overlapping Bash windows
// would clobber a concurrent lane's legitimate write (board 0b848342 finding 1,
// deliberately deferred). No usable tool_use_id -> DEGRADED-LOUD: today's
// blanket pre-existing denial, naming tool_use_id as the reason, never a
// silent per-run key (which would let one lane adopt another's tampered bytes).
// v3.4 (two independent reviews of v3.3, all five findings adjudicated REAL):
// (1) FAIL-CLOSED HOLE — Post iterated only the CURRENT git status, so a path
// dirty at Pre and CLEAN at Post was never visited (`git checkout HEAD -- <hook>`
// destroyed conductor work and exited 0); the sweep set is now the UNION of the
// current status and the RECORDED pre-dirty set, in both the compared and the
// degraded path (whose blanket denial a command could otherwise empty by
// cleaning files). (2) A STAMP ATTESTS BYTES, NOT STATE — a {path, sha256} /
// {path, deleted:true} entry cannot express a mode, a type, a link target or an
// index entry, so the stamp is consulted on a changed pre-dirty path ONLY when
// the difference is confined to bytes (or the absent state). (3) NO STAMP-SIDE
// LINK FOLLOWING — every stamp read is lstat-guarded; a path that is not a
// regular file is unattested, and a symlink is never a directory. (4) RECORD
// VALUES are shape-validated and the lookup is a Map (a missing `children` key
// no longer compares equal to an empty directory; a `__proto__` key cannot
// install an inherited state). (5) RESOURCE SHAPE — the record stores a
// per-path raw-byte sha256 instead of base64 bytes (717 KB measured live), and
// the index query is chunked and --literal-pathspecs.
// v3.5 (board 128fedb7): EVERY write/create/delete/restore primitive guards its
// ANCESTOR path components (assertRealAncestors), not just its final one —
// guarding the leaf is not enough when a PARENT can be a link, because mkdir
// -p, a recursive rmSync and `git checkout -- <path>` all resolve the whole
// string first. The (B) delete arm and the (A) tracked restore, previously
// unguarded, now take the same walk the (B) read/write side already took; the
// (B) delete also lost its `recursive` flag (its keys are only ever regular
// files). Disposition on ANY ancestor/type ambiguity: DENY WITHOUT RESTORING.
// Still racing by construction (lstat-then-act); that residual is accepted and
// tracked at board 6c1e0890, not closed here.
// v3.6 (board 11609d1f): the (B) CONTENT BASELINE is keyed PER BASH CALL —
// sterling-enforce-<tag>-<runId>-call-<sha256(tool_use_id)>.baseline.json — the
// same laundering fix 7021526c applied to the (A) STATE record, because a
// run-keyed baseline is one file every concurrent lane overwrites: lane B's Pre
// landing after lane A's tamper made both Posts compare the tamper against
// itself, and on the (B) side the adopted pre-image is then WRITTEN back. Post
// consumes and unlinks the per-call baseline (P4). No usable tool_use_id keeps
// the legacy per-run file — the only way today's no-tool_use_id platforms keep
// working — and the fallback is DISCLOSED ON EVERY PATH (reviewer F1): a
// non-fatal stderr line fires the moment the shared baseline is used, allow path
// included, because the laundering it admits compares EQUAL and would otherwise
// pass silently; the deny path additionally names the (B) writes it applied to.
// Never a silent fallback to a per-run key.
// v3.7 (board 55fcccac): the BOUNDED-RESOURCE layer. Every read/walk this hook
// performs used to be unbounded — the dirty-set hash read whole files into
// memory, the untracked-dir walks materialized a full directory listing before
// charging anything, and the temp records + stamp were readFileSync+JSON.parse
// with no size guard. An OOM or a hook-runner TIMEOUT mid-check kills the
// process, and a killed process exits NON-2, which the platform treats as
// NON-BLOCKING: a fail-OPEN reachable BY ACCIDENT (a big dirty tree, no
// attacker). The fix is NOT a byte cap on the dirty set — that shape was tried
// and reverted, because ONE legitimate >16MiB dirty file (build artifact,
// dataset, video) would then deny EVERY subsequent Bash command. Instead:
// (1) STREAMING hashes (constant memory, NO size cap anywhere on the hashing
// path, so a large legit file can never deny by itself); (2) INCREMENTAL
// directory iteration (opendirSync) that charges a walk budget per entry as it
// goes, instead of readdirSync materializing a million-entry listing before the
// first charge; (3) STRUCTURAL walk budgets (nodes + depth) whose overflow is
// the hook's own BLOCKING deny naming the tripped budget, never an OOM/timeout;
// (4) BOUNDED, size-prechecked JSON reads for the stamp and the temp records.
// v3.8 SLICE 1 of the secure-I/O / (B) baseline-integrity redesign (decision
// 532a4383 h17-baseline-integrity-redesign-rulings-abcd; design f2bc631f;
// platform posture 2a69a8d7): the shared READ + CLASSIFY layer. (1) RULING C —
// the Linux arm's /proc/self/fd anchor is PREFLIGHTED at the top of the agent
// path and its absence — or its PRESENCE WITHOUT FUNCTION — is a HARD DENY
// ('secure I/O unavailable: ...'), never an automatic degrade to detection. (2) RULING B — a SYMLINK's
// state is UNATTESTABLE: pathState no longer readlinks it, and the recorded
// marker is NEVER equal and NEVER stamp-attestable, so an untouched link is
// denied rather than reported "unchanged" on the strength of a racy read.
// (3) The component walk (classifyPathComponents) resolves each component
// through a PINNED PARENT DESCRIPTOR on Linux and the byte-read primitives open
// their leaf O_NOFOLLOW / identity-verified.
// v3.9 SLICE 2 of the same redesign — DESCRIPTOR-PINNED WRITE/DELETE/READ
// PRIMITIVES, closing residuals 1 and 3 of decision dfe70090. (1) The parent
// DESCRIPTOR IS HELD ACROSS classify→read/hash/write/delete: `withPinnedParent`
// is the one walk every secure operation shares, a leaf is classified BY BEING
// OPENED and hashed from that same descriptor, directory recursion descends
// through the descriptor it just classified, and the write/delete/recursive-
// delete primitives operate through the held parent — so nothing re-resolves by
// pathname mid-operation (residual 3). (2) The procfs preflight AUTHENTICATES
// THE FILESYSTEM with statfs PROC_SUPER_MAGIC before its fd round-trip, and
// compares dev/ino as bigint: a decoy directory pre-seeded with numeric symlinks
// can emulate any fd number a probe samples, but it cannot fabricate a kernel
// filesystem magic (residual 1). (3) Residual 2 — repo-root authentication — is
// OUT OF THE THREAT MODEL and closed by disclosure, not mechanism (decision
// h17-repo-root-authentication-is-out-of-scope). S4 ((B) detect-and-deny) and S5
// (Pre-snapshot atomicity) were the remaining slices when this was written; S4
// landed as v5.0 below.
// v3.10 SLICE 3 of the same redesign — THE LOCK-FREE READ-BLOB RESTORE (Ruling A
// of 532a4383, plus the index-consequence arm of decision fd549420). The LAST
// primitive still resolved by pathname is gone: `restoreTracked`'s in-HEAD arm no
// longer invokes `git checkout HEAD -- <rel>`. It resolves the HEAD tree entry
// NUL-safely (`ls-tree -z` + `--literal-pathspecs`), ACCEPTS ONLY regular-file
// modes (a symlink/gitlink/tree entry refuses loudly and materializes nothing),
// reads the raw blob (`cat-file blob <oid>`) and writes it through the Slice 2
// descriptor-pinned primitives, restoring the executable bit BY FD. Every git
// call on the path is READ-ONLY, so nothing takes `.git/index.lock` — which was
// the SECOND, measured motivation (fan-out contention was making a correct gate
// fail closed on an unrelated lock). THE INDEX IS THEREFORE NOT REPAIRED, and is
// NOT misreported: a path whose index entry still differs from HEAD after the
// worktree restore is DENIED with that disposition NAMED (`indexUnrepaired`), and
// index repair stays a conductor-controlled serialized operation. Full reasoning,
// the `git checkout` gravestone and the disclosed .gitattributes caveat sit at
// the Slice 3 block above `restoreTracked`.
// v3.10a — INDEPENDENT SECURITY REVIEW OF THE ABOVE, same day, four findings
// folded in before the slice was committed. The HIGH was an S3 REGRESSION and is
// the one to remember: replacing `git checkout` with a truncate-in-place write
// reopened a content-safety hole that checkout had closed by accident of shape,
// because checkout UNLINKED AND RECREATED and truncate-in-place does not — a
// HARDLINK planted at a tracked enforcement path made the restore overwrite an
// arbitrary out-of-repo file. THE LESSON, recorded because it generalises past
// this file: the whole S1-S3 threat model is about NAME RESOLUTION (symlinks,
// ancestor swaps, pathspec magic), and a hardlink defeats it by not using a name
// — descriptor pinning constrains which NAME resolves to which object, and says
// nothing about how many names an object has. The (A) restore now unlinks before
// it creates; the residual claim that overstated this is corrected at its own
// site in the Slice 2 residual list; and the (B) restore's `writeUnder` path
// still truncates in place, which is a PRE-EXISTING exposure this slice neither
// introduced nor closed, named there and reported to the conductor.
// THAT LAST CLAUSE IS HISTORICAL AS OF S4 (2026-08-29) — read the v5.0 paragraph
// below before trusting it: the (B) truncate-in-place exposure was REPRODUCED LIVE
// and is now closed by DELETING the primitive, not by hardening it.
// v4.0 (USER RULING 2026-08-27) — THE (B) ADDITION ARM NO LONGER DELETES. A file
// that appears in protected (B) territory with no entry in this call's Pre
// baseline is DENIED and REPORTED, and it SURVIVES ON DISK BYTE-IDENTICAL.
// Deleting is IRREVERSIBLE and H17 cannot distinguish a malicious plant from a
// legitimate file the conductor just created; the sweep is a DETECTOR, and a
// detector that deletes can destroy real work on a false positive. Accepted
// cost: a real plant stays on disk until a human takes it off. Everything the
// v3.5 paragraph above says about "the (B) delete arm" is therefore HISTORICAL —
// `removeUnder`/`removeFileAt` are deleted, not merely uncalled (gravestones at
// their old sites), and the only delete primitive left in this file was
// `removeTreeAt`, reachable ONLY from `restoreTracked` (both deleted at v6.0 —
// no delete primitive remains at all). THE (B) RESTORE ARMS ARE
// UNCHANGED BY *THIS* RULING: a modified/deleted baselined file still has its bytes
// put back, because a recorded pre-image (and, on the (A) side, HEAD) is a
// recoverable source of truth that an ADDITION by definition lacks. Additions are
// reported through their own `unauthorizedAdditions` list with their own wording —
// never through `violations`, whose text says "reverted" and would be a false
// action claim (anti-pattern 586bccdc).
// THE SENTENCE ABOVE ABOUT THE (B) RESTORE ARMS IS SUPERSEDED — see v5.0. It is
// left standing rather than rewritten because it records what v4.0 decided and WHY
// it stopped where it did; only v5.0 changed that verdict, and on evidence v4.0
// did not have.
// v5.0 (S4, 2026-08-29) — THE (B) SURFACE IS NOW DETECT-AND-DENY IN FULL, so the
// restore/addition ASYMMETRY v4.0 preserved is gone: RULING D of decision
// h17-baseline-integrity-redesign-rulings-abcd (532a4383), refined by
// h17-ruling-d-needs-a-b-enumerating-stamp-producer-and-stamp-invalidation
// (fac9a69b). A changed (B) path is ALLOWED only where a TRUSTED conductor stamp
// entry attests its CURRENT bytes; otherwise it is DENIED and LEFT EXACTLY AS THE
// COMMAND LEFT IT. WHAT CHANGED THE VERDICT, because v4.0's asymmetry argument was
// sound on its own terms: the (B) pre-image is NOT the recoverable source of truth
// that sentence assumes — it lives in an os.tmpdir() record the audited command can
// itself write, unlike HEAD on the (A) side — and the restore primitive wrote by
// TRUNCATING IN PLACE, so a (B) path replaced by a hardlink to an outside file made
// the "restore" land baseline bytes on a file outside the repository (reproduced
// live by the S4 red bar, board 59765a46). `writeUnder` is DELETED, not merely
// uncalled (gravestone at its old site), so the (B) stage now holds NO write and NO
// delete primitive at all. (B) modify/delete findings are reported through their own
// `baselineDenied` list with "denied, left in place" wording, for exactly the reason
// additions are — `violations` claims a rollback that no longer happens.
// THE STAMP ITSELF IS NOW PROTECTED, which it previously was not by anything: it is
// witnessed at Pre and re-witnessed at Post, an in-window change DENIES, and the
// stamp is DELETED (invalidated) so a forgery cannot be adopted by the next Pre.
// The integrity check is ORDERED BEFORE every exemption consult in the same Post.
// v4.1 (2026-08-27, outside-family review of v4.0 — CONFIRMED HIGH): DELETING
// THE (B) ADDITION ARM'S UNLINK WAS NOT STRUCTURALLY SUFFICIENT. The (B) surface
// has a SECOND route into this hook, and it runs EARLIER. `git add -f
// .claude/agents/x.md` puts a gitignored (B) file in the INDEX, so
// `git status --porcelain` reports it as an ADDITION; it enters the (A) TRACKED
// sweep, `isEnforcementSurface` makes it an (A) violation, `restoreTracked` finds
// it is NOT IN HEAD, and the not-in-HEAD arm DELETED it — before the (B)
// collection (which runs after the whole (A) sweep) could record the addition or
// emit the "left on disk" disposition. Same ruling violated, opposite surface.
// WHY THE ORIGINAL REVIEW MISSED IT, recorded so the reasoning is not repeated:
// it verified that `removeTreeAt`'s only callers are its own recursion and
// `restoreTracked`'s not-in-HEAD arm, and treated that arm as safe because it is
// "git-recoverable". IT IS NOT — not-in-HEAD is precisely the arm with no blob to
// recover from, and for a force-added file it is the deletion path.
// THE REPAIR IS TWO INDEPENDENT LAYERS, both keyed on the SAME `isEnforcementSurface`
// predicate (no second notion of "protected"): (1) `restoreTracked`'s not-in-HEAD
// arm returns a DISPOSITION for a (B) path instead of entering any delete
// primitive; (2) `removeTreeAt` itself refuses to unlink a (B) path — in its
// recursion too, so a protected DESCENDANT of a deletable directory survives and
// its parents are not rmdir'd. The (A) sweep then routes the survivor into the
// SAME `unauthorizedAdditions` list the (B) arm uses (deduped, since both
// surfaces can now name one path). THE (A) RESTORE FOR A MODIFIED TRACKED FILE
// IS UNTOUCHED: in-HEAD means git holds the bytes, so reverting is recoverable
// and stays. The dangerous intersection is NOT-IN-HEAD ∧ (B)-SURFACE, and that
// is exactly what the two layers cut out.
// v6.0 (S3 of the de-complication campaign, 2026-08-30) — THE (A) RESTORE IS
// DELETED. Decisions dc616f69 (the (A) arm stops restoring) and 78dc9bd6 (H17
// demotes from security boundary to TRIPWIRE), user-ruled 2026-08-30. Authorship
// is UNPROVABLE in a same-UID shared worktree — `agent_id` labels the hook
// EVENT, never the filesystem bytes written while it was open — so a destructive
// rollback on unprovable attribution could always clobber a conductor's
// concurrent uncommitted work; no heuristic narrowing fixes possibility, only
// probability. An in-window change on a clean-at-Pre path is now DETECTED,
// DENIED and LATCHED (the same eager latch the (B) triggers use, so the next Pre
// blocks before it can adopt the surviving bytes), and the bytes are LEFT ON
// DISK exactly as the command wrote them. GONE, not uncalled: `restoreTracked`,
// `materializeHeadBlob`, `headTreeEntry`, `assertRestorableHeadEntry`,
// `headBlobBytes`, `indexDispositionAgainstHead`, `removeTreeAt`,
// `writeRegularAt`, `mintRestorePerformed` (the `restore_performed` maintenance
// lane is no longer minted; its schema enum survives so existing records stay
// readable, dc616f69 R12). The (A)-side stamp exemptions died with the restore
// (dc616f69 R11: a same-UID-forgeable stamp may explain a finding, never exempt
// one); the remaining (B)/pre-existing stamp apparatus follows in S4. This file
// now holds NO primitive that writes, deletes or restores a repo path — its only
// in-repo mutations are the create-only taint latch and the best-effort stamp
// invalidation. Every earlier paragraph's present-tense "restore"/"revert"
// language is HISTORICAL as of this version.
import {
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
  opendirSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  fstatSync,
  lstatSync,
  statSync,
  statfsSync,
  realpathSync,
  constants as FS,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { matchesGlob } from '@sterling/schemas';
import { readStdin, allow, deny, openStore, withRetry, environmentDefectDenial } from './lib/common.mjs';
import { scopeCheck, isEnforcementSurface } from './lib/contract.mjs';

// The (B) gitignored baseline set (v3.1: settings*.json added — the gitignored
// settings.local.json is enforcement surface but git is blind to it).
const BASELINE_GLOBS = ['.claude/agents/**', '.sterling/config.json', '.claude/settings*.json'];
const NO_RUN = 'no-run'; // L2 baseline-file discriminator when no active run
// The conductor's attestation input (scripts/enforcement-stamp.mjs writes it).
// NAMED ONCE, because since S4 it is read, witnessed AND invalidated from
// several different places, and copies of a security-relevant path string are
// chances for one of them to drift out of step with the others.
//
// A FUNCTION, NOT A `const`, AND THAT PLACEMENT IS LOAD-BEARING RATHER THAN
// STYLISTIC. A module-scope STATEMENT runs at IMPORT — before the deny decision
// and outside any try whose catch reaches deny() — so
// scripts/check-failclosed-boundary.mjs counts it as a hole: if it threw, the
// hook would exit 1, the runner reads non-2 as NON-BLOCKING, and the gate is
// voided. A string literal cannot realistically throw, but that baseline is a
// RATCHET THAT ONLY SHRINKS, and its two growth doors are deliberately narrow:
// raise the exact, test-pinned founding total (reserved for UNJUSTIFIED
// entries), or add an `admitted` entry REPRINTED ON EVERY RUN FOREVER.
//
// The sibling fix in a5a8e81 moved two constants into their sole consuming
// functions, but THAT REMEDY IS WRONG HERE: this one has five consumers across
// distant functions, so inlining it would reintroduce exactly the multi-copy
// drift the single naming exists to prevent. A hoisted function declaration
// keeps ONE definition, stays visible everywhere, and is not a top-level
// statement — so the ratchet stays at 107 and no permanent-noise entry is added.
function stampRel() {
  return '.sterling/transient/enforcement-stamp.json';
}

// ---------------------------------------------------------------------------
// THE SHARED SECURE-I/O LAYER — SLICE 1: READ + CLASSIFY (decision 532a4383
// h17-baseline-integrity-redesign-rulings-abcd, design f2bc631f, platform
// posture 2a69a8d7). Everything below exists so that a path this hook reads or
// classifies cannot be REDIRECTED by a symlink swapped in under the gate. The
// S2 write/delete primitives and the S3 read-blob restore are DELETED as of
// v6.0 (dc616f69) — only the READ side below survives; the (B) detect-and-deny
// stamp manifest (S4) is a separate slice and is NOT here.
//
// TWO ARMS, ONE FLOW (2a69a8d7):
//   * LINUX — PREVENTION. Every component is resolved RELATIVE TO A PINNED
//     PARENT DESCRIPTOR through /proc/self/fd/<fd>/<name>, and every open on
//     the walk is O_DIRECTORY|O_NOFOLLOW. Once a directory fd is held, the
//     NAME it was opened under is irrelevant: swapping `hooks` for a symlink
//     afterwards cannot re-aim a resolution that starts from the descriptor.
//   * NATIVE WINDOWS — DETECTION, NOT PREVENTION (named accepted residual,
//     2a69a8d7). libuv silently ignores O_NOFOLLOW on win32, there is no
//     openat, and Node cannot open a directory as a descriptor at all — so the
//     ancestor walk stays path-addressed (lstat per component, as before) and
//     the LEAF is identity-verified with lstat/fstat {bigint:true} dev/ino/type
//     equality across the open. An adversary racing path resolution itself can
//     evade that; the residual is disclosed, not silently closed.
//
// WHAT THE WIN32 DETECTION ARM REACHES — FILES YES, DIRECTORIES NO (board
// 7c120461 route (c); stated here rather than left to be inferred, because a
// comment claiming a protection the code does not have is worse than the gap
// itself — anti-pattern security-comment-asserts-protection-the-code-does-not-have).
// IDENTITY VERIFICATION is what makes the Windows arm robust to libuv's
// reparse-tag mapping: `openLeafNoFollow` compares bigint dev/ino AND kind
// across the open, so a leaf whose NAME redirects is caught whatever lstat
// chose to call it. Every win32 path that reads BYTES goes through it — the (A)
// state hash (hashClassifiedLeaf -> sha256OfFileStreamed), the (B) baseline
// bytes, the enforcement stamp — so the FILE-shaped state escapes (a regular
// file swapped for a link to identical bytes) are DETECTED on Windows by
// identity, not by kind.
// DIRECTORIES GET NO SUCH CHECK. Node cannot open a directory as a descriptor
// on win32, so `classifyLeafAt`'s win32 arm decides 'dir' from the lstat KIND
// ALONE, `dirHandleOf` hands the recursion the PATH, and `withPinnedParent`
// classifies each ancestor component with `lstatKind` and re-resolves it by
// name. A directory-shaped redirect therefore rests entirely on lstat reporting
// it as a symlink. For a POSIX symlink that is certain; for an NTFS JUNCTION —
// which, unlike a symlink, needs no privilege to create — it was a libuv
// reparse-tag detail this repo had not measured.
// NOW MEASURED, AND THE ANSWER IS THE GOOD ONE (2026-08-27, native-Windows
// session; research_finding native-windows-platform-measurements-2026-08-27):
// for a `mklink /J` junction Node's lstat reports isSymbolicLink() === TRUE and
// isDirectory() === FALSE. So lstat DOES call a junction a symlink, and the
// feared escape does not exist. NAME THE MECHANISM PRECISELY, because the first
// draft of this comment named the WRONG one and both reviewers caught it:
// detection does NOT come from `sameKind` in `openLeafNoFollow` — that is the
// lstat/fstat identity check on the BYTE-READ path, which a 'file' leaf always
// reaches and a 'dir' leaf NEVER does (see the note at `classifyLeafAt` below;
// Node cannot open a directory as an fd on win32). The junction is caught
// EARLIER and in two different places. LEAF: `classifyLeafAt`'s win32 arm tests
// isSymbolicLink() BEFORE isDirectory(), so a junction classifies 'symlink',
// not 'dir'; the (A) state it records is therefore type 'symlink' where the
// baseline held type 'dir'. THREE layers of `sameState` then refuse it, and the
// FIRST to fire is the hoisted `a.unattestable || b.unattestable` guard — the
// recorded symlink state carries UNATTESTABLE_SYMLINK — so the TYPE term
// (`a.type !== b.type`) and the outright `a.type === 'symlink'` refusal behind
// it are defence-in-depth here, not the operative check. Symlinks are
// unattestable by construction (Ruling B). ANCESTOR:
// `withPinnedParent` classifies each component with `lstatKind` and THROWS on
// `kind !== 'dir'`, so a junction swapped over an ancestor refuses the walk
// rather than being compared at all. This is platform SAMENESS for the junction
// CLASSIFICATION case; no code change follows.
// CORRECTION OF THE COMMENT THAT STOOD HERE: it claimed "THE SETTLEMENT IS A
// TEST, NOT AN ASSUMPTION: PIN-WIN32-JUNCTION-ANCESTOR / PIN-WIN32-JUNCTION-LEAF
// in h17-pre-state-snapshot.test.mjs". NO TEST OF EITHER NAME HAS EVER EXISTED
// in this repo — `PIN-WIN32-JUNCTION-ANCESTOR` and `PIN-WIN32-JUNCTION-LEAF`
// appear nowhere but in that claim (anti_pattern
// security-comment-asserts-protection-the-code-does-not-have; board 54047620).
// SCOPED HONESTLY, because the first draft of this correction overclaimed here
// too and a reviewer caught it: the word `junction` DOES occur elsewhere in
// scripts/ — scripts/tests/enforcement.test.mjs:265 and :305 pass it as the
// symlinkSync TYPE argument — so the true claim is about those two PIN names,
// not about the word. Do not re-add such a pin on the strength of this measurement
// either: the h17 suite currently reports 0 pass / 36 SKIP on native Windows,
// so a pin added there would never run and would be hollow by construction.
// STILL BINDING: do NOT close anything here by weakening the comparison so both
// platforms behave alike (that reopens escapes live on Linux), and do NOT add a
// bigint lstat/stat divergence check on the strength of reasoning alone — it
// sits on the ancestor walk, so a false deny there denies EVERY agent Bash call
// on the majority platform, which 2a69a8d7 already ruled unshippable.
//
// THE PROTECTION BOUNDARY STARTS AT THE WORKSPACE ROOT — NAMED, NOT ASSUMED
// (decision h17-repo-root-authentication-is-out-of-scope, ruling on residual 2
// of dfe70090). THE RULING'S MANDATED DISCLOSURE, VERBATIM:
//   "H17 assumes the workspace root selected by the hook runner is the trusted
//    namespace anchor. It prevents or detects redirection below that root, but
//    does not authenticate root identity across hook processes. An actor able to
//    rename or replace the workspace root, its .git, or the parent namespace is
//    outside H17's protection boundary."
// WHICH HALF IS WHICH ON THIS PLATFORM, since "prevents or detects" is not one
// guarantee: BELOW the root it is PREVENTION on Linux (O_NOFOLLOW + pinned
// descriptors) and DETECTION ONLY on native Windows (2a69a8d7). AND WHY THE ROOT
// ITSELF IS NEITHER: a per-process descriptor authenticates only its own
// invocation, while the exposure spans the separate Pre and Post hook processes;
// persisting the root's dev/ino into the temp records would authenticate nothing,
// because those records are themselves agent-writable and so forgeable by the
// very actor they would guard against; and an actor who can rename the root can
// equally replace the store, the config and the enforcement surface, so there is
// nothing left for this hook to protect. Closing it soundly would need a trusted
// runner-provided handle, which does not exist; the honest disposition is this
// disclosure, not a sixth mechanism that looks like a guarantee.
//
// RULING C — /proc/self/fd ABSENT IS A HARD DENY, NEVER AN AUTO-DEGRADE. The
// whole Linux arm is built on procfs being mounted; a hardened container may
// not mount it. Falling back to the Windows detect-and-abort arm there was
// EXPLICITLY REJECTED (532a4383, on P5 grounds): losing the prevention
// mechanism must HALT, because a silent drop to defeatable detection is
// indistinguishable, from the outside, from the guarantee it replaced.
// Degradation may only ever be an explicit operator opt-in, and none exists.
//
// THE ENV SEAM IS A TEST SEAM, NOT A LOOSENING. Unset — the production case —
// this is byte-identical to hardcoding '/proc/self/fd'. Pointed anywhere else,
// the anchor is FUNCTIONALLY VERIFIED fail-closed (see
// `secureIoUnavailableReason`) and every anchored resolution goes through that
// same path, so a wrong value denies rather than degrades. It exists because
// genuine procfs absence cannot be constructed in a test without root and a
// mount-namespace change.
const PROCFS_FD_DIR = process.env.STERLING_H17_PROCFS_FD_DIR || '/proc/self/fd';
const IS_WIN32 = process.platform === 'win32';

// The marker a state carries when the snapshot could not KNOW it (Ruling B).
// One shared constant so the record's shape, its validator and its comparison
// can never drift apart.
const UNATTESTABLE_SYMLINK = 'symlink-target';

// The marker a FILE's state carries when the snapshot could not attest its BYTES
// because the file was being written throughout every bounded read attempt
// (board fabf21d8). Modelled on `walk_budget_exceeded`: an honest record that
// this path was NOT attested, which `sameState` and `stampCouldAttest` treat as
// NEVER equal and NEVER attestable — so it can only ever make a verdict
// STRICTER, never launder a change. One shared literal constant, checked by the
// validator by VALUE (the same repair Ruling B's marker took), so the record's
// shape, its validator and its comparison cannot drift apart.
const UNATTESTABLE_FILE_BYTES = 'file-bytes-unstable';

// Ruling C's preflight, as a pure probe: null when secure I/O is available on
// this platform, else the EXACT operator-facing reason. Called once, at the top
// of the agent path, before any store/git/baseline touch — a prevention
// mechanism that is missing must stop the command, not be discovered halfway
// through a sweep that has already read something.
//
// PRESENCE IS NOT FUNCTION — the fail-open this repair closes (found
// independently by both reviewers of the first Slice 1 landing). The probe used
// to be `existsSync(PROCFS_FD_DIR)` alone, so an anchor that was PRESENT BUT
// WRONG (any existing directory: a hardened container's stub, a stale bind
// mount, the seam pointed at /tmp) passed as "available". Every anchored path
// then resolved to `<wrongdir>/<fd>/<name>`, which does not exist; every
// component classified 'absent'; 'absent' is explicitly NOT a violation; and the
// ancestor guard judged every path freshly creatable — the whole mechanism
// DEGRADED TO ALLOW. That is precisely the auto-degrade Ruling C rejected by
// name (532a4383), reached silently and by accident. The old comment claiming
// "a wrong value denies rather than degrades" documented the opposite of the
// behavior; this function is what makes it true.
//
// WHAT "WORKING" IS ESTABLISHED BY, and why a weaker test would not do. A
// non-empty listing proves nothing (any populated directory passes), and a
// string comparison against '/proc/self/fd' verifies nothing about the anchor at
// all — it only agrees with the two obvious tests by coincidence, and would
// refuse a genuinely working alternative such as /proc/thread-self/fd. So the
// probe performs THE VERY OPERATION the layer depends on: it pins a real
// directory descriptor, then requires that `<ANCHOR>/<fd>` (a) lstats as a magic
// SYMLINK, as every procfs fd entry is — which a directory of numeric-named
// regular-file decoys fails — and (b) RESOLVES, through stat, to the exact
// object that descriptor holds, compared by dev+ino against the descriptor's own
// fstat. An anchor that satisfies both is a working descriptor directory
// whatever it is called; anything else is unavailable and hard-denies.
// `probeDir` is the repo root — the same trust anchor the component walk starts
// from — so the preflight exercises the real path, not a synthetic one.
//
// SLICE 2 REPAIR — AUTHENTICATE THE FILESYSTEM, NOT ONE ENTRY (residual 1 of
// decision dfe70090, external-model finding adopted by the conductor). The
// round-trip below proves that ONE numeric entry resolves to the object its
// descriptor holds. It does NOT prove the anchor dynamically maps ARBITRARY fd
// numbers, and NO finite set of numeric-entry probes can: a decoy directory
// pre-seeded with numeric symlinks over a plausible fd range emulates every
// number the probe samples, passes, and then fails to resolve the CHILD fds the
// component walk opens later — `<decoy>/<childFd>/<name>` resolves wrong or
// absent, every component classifies 'absent', and the whole mechanism degrades
// to ALLOW. That is exactly the silent auto-degrade Ruling C rejected by name.
// The closure is to authenticate the FILESYSTEM instead of counting entries:
// `statfs` reports the mounted filesystem's magic, and PROC_SUPER_MAGIC
// (0x9fa0) is a KERNEL fact no unprivileged directory of decoy symlinks can
// fabricate — arbitrary-fd mapping is a property of procfs semantics, not of any
// entry we could sample. The two checks are complementary and BOTH are needed:
// the magic establishes "this is procfs" (so fd mapping is dynamic), the
// round-trip establishes "this particular procfs location is an FD DIRECTORY"
// and not some other procfs node that would also carry the magic.
// /proc/thread-self/fd still passes both, so the anti-hardcode pin holds.
// BIGINT dev/ino (same repair): number-valued fs.Stats truncate a 64-bit file
// id, and a truncated ino makes the identity comparison unsound on exotic
// filesystems — the same reason openLeafNoFollow's win32 arm is bigint.
const PROC_SUPER_MAGIC = 0x9fa0n;

function secureIoUnavailableReason(probeDir) {
  if (IS_WIN32) return null; // the detect-and-abort arm needs no procfs (2a69a8d7)
  if (!existsSync(PROCFS_FD_DIR)) return 'secure I/O unavailable: /proc/self/fd absent';
  let vfs;
  try {
    vfs = statfsSync(PROCFS_FD_DIR, { bigint: true });
  } catch (e) {
    return `secure I/O unavailable: '${PROCFS_FD_DIR}' could not be statfs'd to confirm it is procfs (${(e && e.code) || (e && e.message) || e})`;
  }
  if (vfs.type !== PROC_SUPER_MAGIC) {
    return (
      `secure I/O unavailable: '${PROCFS_FD_DIR}' is not on procfs (filesystem magic 0x${vfs.type.toString(16)}, expected 0x${PROC_SUPER_MAGIC.toString(16)}) — ` +
      `only the kernel's procfs maps ARBITRARY descriptor numbers, and an ordinary directory of numeric-named entries cannot, however many of them it pre-seeds`
    );
  }
  let fd = null;
  try {
    fd = openRootAnchorDir(probeDir);
    const anchored = `${PROCFS_FD_DIR}/${fd}`;
    const entry = lstatSync(anchored, { bigint: true }); // the fd entry ITSELF, unfollowed
    const through = statSync(anchored, { bigint: true }); // ... and what it resolves to
    const direct = fstatSync(fd, { bigint: true }); // ... versus what the descriptor actually holds
    closeSync(fd);
    fd = null;
    if (!entry.isSymbolicLink()) {
      return `secure I/O unavailable: '${PROCFS_FD_DIR}' exists but its descriptor entries are not the magic symlinks a /proc/self/fd directory is made of`;
    }
    if (through.dev !== direct.dev || through.ino !== direct.ino) {
      return (
        `secure I/O unavailable: '${PROCFS_FD_DIR}/<fd>' does not resolve to the object that descriptor holds ` +
        `(resolved dev/ino ${through.dev}/${through.ino}, descriptor ${direct.dev}/${direct.ino}) — it is present but is not a working descriptor directory`
      );
    }
    return null;
  } catch (e) {
    return `secure I/O unavailable: '${PROCFS_FD_DIR}' could not be verified as a working descriptor directory (${(e && e.code) || (e && e.message) || e})`;
  } finally {
    // Only reachable with fd still open when an exception is already driving the
    // verdict, so a close failure must not displace it (same rule as closePinned).
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

// Open a DIRECTORY as a pinned descriptor, no-follow. Linux only — Node cannot
// open a directory descriptor on win32, which is precisely why the Windows arm
// classifies by path (Fork 2 of f2bc631f, option (b): a weaker, disclosed
// ancestor guarantee rather than a native addon that breaks invariant 4).
// O_NONBLOCK so a fifo/device swapped in cannot BLOCK the open itself — a
// blocked hook is timeout-killed into a non-2 exit, which the platform treats
// as ALLOW (the same fail-open shape Codex F2 closed on the byte-read path).
function openPinnedDir(path) {
  return openSync(path, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
}

// The REPO ROOT anchor — the ONE directory opened WITHOUT O_NOFOLLOW, and the
// distinction is deliberate, not an oversight (repair of an availability
// regression the first Slice 1 landing introduced: `~/proj -> /mnt/data/proj` is
// an entirely ordinary arrangement, and a no-follow open of a symlinked project
// root throws ENOTDIR/ELOOP into the fail-closed catch, DENYING EVERY agent Bash
// call. The pre-slice code never lstat'd cwd itself, so nothing was lost by
// following here; this cluster has been reverted twice over exactly this class
// of false deny.)
//
// THE CONFLATION TO AVOID: Ruling B (532a4383) makes a symlink's TARGET STATE
// unattestable — H17 never reads through a link to decide whether a protected
// path changed, and every pin of that behavior is untouched by this function.
// Ruling B says nothing about the PATH ONE REACHES THE REPO THROUGH. The root is
// the TRUST ANCHOR handed to this hook by the platform (input.cwd, normalized to
// the project root): it is never a component under test, never classified and
// never attested — it is the origin the classification is relative TO. Once this
// descriptor is held, every component BELOW it is still resolved through the
// anchor with O_NOFOLLOW, so the prevention guarantee is unchanged: following
// the root link once, at the start, cannot re-aim anything inside the repo.
//
// WHAT THIS ANCHOR IS NOT — the named limit (decision
// h17-repo-root-authentication-is-out-of-scope, residual 2 of dfe70090). "Trust
// anchor" is an ASSUMPTION this hook inherits from its runner, not a property it
// verifies. THE RULING'S MANDATED DISCLOSURE, VERBATIM:
//   "H17 assumes the workspace root selected by the hook runner is the trusted
//    namespace anchor. It prevents or detects redirection below that root, but
//    does not authenticate root identity across hook processes. An actor able to
//    rename or replace the workspace root, its .git, or the parent namespace is
//    outside H17's protection boundary."
// That is a ruled scope boundary — see the platform-envelope block at the top of
// this layer for why authenticating it cross-process is unsound rather than
// merely unbuilt.
// Still O_DIRECTORY, so a root symlink pointing at a NON-directory fails
// (ENOTDIR) rather than being accepted; still O_NONBLOCK, same reason as above.
function openRootAnchorDir(path) {
  return openSync(path, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NONBLOCK);
}

// (`anchoredPath(fd, name)` used to live here — the path that resolves `name`
// RELATIVE TO a pinned descriptor, Node's stand-in for openat/fstatat. Slice 2
// made every caller hold a pinned directory HANDLE (`/proc/self/fd/<fd>` on
// Linux, the plain directory path on win32) rather than a bare fd, so the
// composition is `${handle}/${name}` at the one place it is needed and the
// helper had no callers left.)

// A component name safe to resolve through an anchor. '', '.' and '..' would
// each re-aim the walk at a directory the anchor was chosen to exclude (the
// repo root, or above it), and a NUL or embedded separator would smuggle a
// second component past the per-component check. Lexical validation before any
// resolution is the Linux design's first step (f2bc631f).
function assertResolvableComponent(component, rel, what) {
  if (component === '' || component === '.' || component === '..' || component.includes('\0') || component.includes('/')) {
    throw new Error(
      `${what}: refusing to resolve '${rel}' — its component ${JSON.stringify(component)} is not a plain path segment; ` +
        `an empty, '.', '..', NUL-bearing or separator-bearing component cannot be anchored and is denied on sight, never resolved`
    );
  }
}

// Close a descriptor on a path that is already unwinding. A close failure with
// no primary exception pending IS the failure (a leaked fd marches toward an
// EMFILE fail-open, Codex F5) and propagates; with one pending it must not
// displace the verdict already being carried.
function closePinned(fd, primary) {
  if (fd === null) return;
  try {
    closeSync(fd);
  } catch (closeErr) {
    if (!primary) throw closeErr;
  }
}

// Open a LEAF for reading with the platform's strongest available no-follow
// guarantee. LINUX: O_NOFOLLOW makes a symlink at the leaf fail the open
// outright (ELOOP) instead of being read through. WIN32: O_NOFOLLOW is
// silently ignored by libuv, so identity is VERIFIED instead — lstat before,
// fstat after, both {bigint:true} because number-valued fs.Stats truncate the
// 64-bit file id and a truncated ino makes the check unsound (2a69a8d7). A
// mismatch ABORTS (throws → the caller's fail-closed catch → deny), which is
// detection, not prevention: an adversary racing the resolution itself, before
// the lstat and back after, evades it. That residual is the disclosed,
// accepted Windows envelope.
function openLeafNoFollow(abs, extraFlags = 0) {
  if (!IS_WIN32) return openSync(abs, FS.O_RDONLY | FS.O_NONBLOCK | FS.O_NOFOLLOW | extraFlags);
  const before = lstatSync(abs, { bigint: true });
  const fd = openSync(abs, FS.O_RDONLY | FS.O_NONBLOCK | extraFlags);
  try {
    const after = fstatSync(fd, { bigint: true });
    const sameKind = before.isFile() === after.isFile() && before.isDirectory() === after.isDirectory() && before.isSymbolicLink() === after.isSymbolicLink();
    if (before.dev !== after.dev || before.ino !== after.ino || !sameKind) {
      throw new Error(
        `'${abs}' is not the same object across its own open (lstat dev/ino ${before.dev}/${before.ino}, fstat ${after.dev}/${after.ino}) — ` +
          `refusing to read it. On this platform H17 verifies identity across the open (detection) rather than preventing the swap ` +
          `(decision h17-windows-detect-and-abort): a mismatch aborts the check, it never reads whatever was substituted.`
      );
    }
    return fd;
  } catch (e) {
    closePinned(fd, e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// SLICE 2 — DESCRIPTOR-PINNED WRITE / DELETE / READ PRIMITIVES (decision
// 532a4383's build plan, closing residual 3 of dfe70090).
//
// WHAT SLICE 1 LEFT OPEN. Slice 1 made CLASSIFICATION descriptor-pinned, then
// dropped every descriptor before the operation it had authorized: the walk
// released its pins and the lstat/hash/write/delete that followed RE-RESOLVED
// `cwd/rel` from the root by pathname. An ancestor swapped after a successful
// classification was then followed by the operation — the classify→use window
// this whole redesign exists to close, one call frame wide instead of one hook
// invocation wide. S2's contract is the fix, and it is exactly one sentence:
// THE PARENT DESCRIPTOR IS HELD ACROSS classify→read/hash/write/delete, so
// nothing re-resolves by pathname mid-operation.
//
// THE SHAPE — a pinned directory expressed as a PATH STRING. `withPinnedParent`
// walks a repo-relative path component by component, holding each confirmed
// directory open, and hands the callback the PARENT's pinned handle plus the
// bare LEAF NAME. On Linux the handle is `/proc/self/fd/<fd>` for a descriptor
// this process holds, so `<handle>/<leaf>` is Node's stand-in for openat: the
// prefix cannot be re-aimed by any swap, because it is a descriptor, not a name.
// On native Windows the handle is the plain absolute directory path —
// `withPinnedDir` just returns it (`if (IS_WIN32) return fn(dirPath);`), with NO
// identity check of its own. This is the SAME disclosed envelope 2a69a8d7
// accepted (detection, not prevention), but it is NOT the same MECHANISM as the
// leaf's lstat/fstat bigint identity check: that check lives in
// `openLeafNoFollow` and fires only on the byte-read path a 'file' leaf reaches.
// A DIRECTORY handed through `withPinnedDir` gets no such re-verification —
// `classifyLeafAt`'s win32 arm decides 'dir' from the lstat KIND alone, and
// nothing downstream re-checks that the directory this walk descends into is
// the object lstat classified. One code path, two DIFFERENT guarantees by kind
// (file: identity-verified; directory: kind-only), stated rather than blurred.
//
// WHY /proc/self/fd/<fd>/<name> IS ALLOWED TO CARRY MUTATIONS. Node exposes no
// openat/unlinkat/renameat and invariant 4 forbids a native addon (already
// refused twice for this file). Ruling C ALREADY makes functional procfs a hard
// requirement on Linux — the hook denies every agent Bash without it — so
// resolving mkdir/unlink/rmdir/open through the anchor adds no new dependency;
// it spends a requirement that is already paid for.
//
// NAMED RESIDUALS THIS LAYER DOES NOT CLOSE, disclosed rather than buried:
//   * mkdir / unlink / rmdir REMAIN NAME OPERATIONS. They cannot follow an
//     ancestor and cannot follow a symlink (the parent is a descriptor, the leaf
//     is unlinked as a NAME and never dereferenced), but a racer can still
//     exchange WHICH ENTRY lives under that leaf name between the classification
//     and the mutation. The blast radius is bounded to the pinned parent
//     directory — never outside the repo — but it is not zero.
//     CORRECTED 2026-08-29 (independent security review of Slice 3): the
//     "never outside the repo" half was stated too widely and was FALSE OF THE
//     WRITE SIDE. Descriptor pinning constrains NAME RESOLUTION; a HARDLINK
//     bypasses names entirely, so a `writeRegularAt` that TRUNCATES AN EXISTING
//     ENTRY IN PLACE writes to an inode that may be linked anywhere the user can
//     read — outside the repo included, with no symlink and no ancestor swap
//     involved. Scoped honestly rather than softened: it is true of mkdir /
//     unlink / rmdir (they operate on the NAME, so an exchanged entry costs at
//     most the wrong entry in THIS directory), and it is NOT true of an in-place
//     write. The (A) restore closes it by unlinking before it creates (see
//     `materializeHeadBlob`); the (B) restore's `writeUnder` -> `writeRegularAt`
//     path STILL truncates in place and so still carries it — a pre-existing
//     exposure this slice did not introduce and does not close, named here
//     because a residual list that omits it is the false-claim failure again.
//     [CLOSED by S4, 2026-08-29 — the (B) half only.] The exposure was REPRODUCED
//     LIVE (a (B) path hardlinked to an outside victim had the victim's bytes
//     overwritten by the "restore"), and it is closed by DELETING the aiming site
//     rather than hardening the primitive: `writeUnder` is gone and the (B) surface
//     is detect-and-deny, so no (B) path reaches a write at all.
//     [CLOSED IN FULL by v6.0, 2026-08-30.] `writeRegularAt` itself is now
//     deleted with the (A) restore (dc616f69), so NO path of any class reaches an
//     in-place write — this file no longer holds a file-writing primitive.
//   * [MOOT as of v6.0 — no recursive delete exists any more.] A RECURSIVE
//     DELETE PINS EVERY DIRECTORY IT DESCENDS, so it can never be re-aimed out
//     of the tree; but if a racer RENAMES that directory elsewhere mid-delete,
//     the pinned descriptor still names the same directory OBJECT and the
//     delete proceeds against it. Descriptor identity was preserved; namespace
//     containment was not. Resolved by deletion: `removeTreeAt` went with the
//     restore family (dc616f69).
//   * [MOOT as of v6.0 — no write primitive exists any more.] There is NO
//     renameat, so there was no atomic replace: `writeRegularAt` truncated and
//     rewrote in place. Resolved by deletion, not by hardening.
//   * [CLOSED by SLICE 3, kept so the residual's history is legible] This bullet
//     used to read: "restoreTracked's in-HEAD arm still shells out to
//     `git checkout HEAD -- <rel>`, which resolves the path itself, outside every
//     descriptor this layer holds." Ruling A removed that call — the in-HEAD arm
//     now materializes a HEAD blob through `withPinnedParent`/`writeRegularAt`
//     like every other write here. No primitive in this file resolves a write
//     target by pathname any more.
//   * THE CLASSIFY→USE PAIR IS CLOSED FOR READS, AND ONLY FOR READS — stated
//     precisely because the loose version of this claim ("the lstat/open pair is
//     gone") was WRONG when first written and a review caught it. Every path that
//     READS bytes now classifies BY OPENING and reads from that same descriptor:
//     the (A) state hash, the (B) baseline bytes, the enforcement stamp. What is
//     NOT closed is the pair on the MUTATING side — since v6.0 that means only
//     the surviving pinned-ancestor walks (`withPinnedParent`, used by the taint
//     latch and the S4 stamp invalidation — `removeTreeAt` and the restore's
//     walks are gone with the restore family), which lstat each component before
//     pinning it. That is the same bounded exposure the first bullet describes
//     and cannot be closed without unlinkat/renameat, which Node does not expose.
//   * A DIRENT IS A PRE-FILTER, NEVER THE VERDICT. The (B) walk still reads
//     Dirent kinds to decide what to descend or read, but every decision is
//     RE-ESTABLISHED by the open that follows (O_NOFOLLOW + fstat), so a stale or
//     raced Dirent can only cost a denial, never a wrong read.
// ---------------------------------------------------------------------------

// THE ONE ROOT ANCHOR PER INVOCATION. Slice 1 reopened `cwd` inside every
// classifier and closed it again before the operation; each reopen was a fresh
// pathname resolution of the root and a fresh chance to land on a different
// object. One process, one anchor: opened lazily on first use, retained for the
// life of the hook (a hook invocation is short and single-purpose, so there is
// no fd to reclaim), and never closed — so the `/proc/self/fd/<fd>` prefix
// embedded in every anchored path can never be invalidated by a close, nor
// re-pointed by fd-number reuse.
// THE CACHE IS KEYED BY cwd, AND A MISMATCH THROWS RATHER THAN RESOLVING
// (review finding C). One hook invocation only ever has one root, so the key can
// never differ in production — which is exactly why an unkeyed cache was easy to
// write and impossible to notice. Its failure mode is the one this whole slice
// exists to prevent: a second caller passing a DIFFERENT root would silently
// resolve every path against the FIRST one, i.e. a wrong-namespace resolution
// that no descriptor pin can catch, because the descriptor is faithfully pinned
// to the wrong repository. Fail LOUD instead of returning a stale anchor: a
// caller that genuinely needs two roots must say so and get a second anchor,
// never inherit one by accident.
let rootAnchorFd = null;
let rootAnchorDir = null;
let rootAnchorCwd = null;

function repoRootDir(cwd) {
  if (IS_WIN32) return cwd; // no directory descriptors on win32 (2a69a8d7)
  if (rootAnchorDir === null) {
    rootAnchorCwd = cwd;
    rootAnchorFd = openRootAnchorDir(cwd);
    rootAnchorDir = `${PROCFS_FD_DIR}/${rootAnchorFd}`;
    return rootAnchorDir;
  }
  if (cwd !== rootAnchorCwd) {
    throw new Error(
      `refusing to resolve '${cwd}' through the root anchor pinned for '${rootAnchorCwd}': this process holds ONE repo-root descriptor and a second root ` +
        `would silently resolve against the first, which is a wrong-namespace resolution no descriptor pin can detect. A hook invocation has exactly one root; ` +
        `two means the caller is not the hook, and it must open its own anchor rather than inherit this one.`
    );
  }
  return rootAnchorDir;
}

// Hold `dirPath` open as a pinned directory for the duration of `fn`, and hand
// `fn` the pinned handle. O_NOFOLLOW is the race-closer: a component swapped for
// a symlink between its classification and this open FAILS (ELOOP) rather than
// opening the link's target — the swap becomes a deny, never a redirect.
function withPinnedDir(dirPath, fn) {
  if (IS_WIN32) return fn(dirPath); // DISCLOSED win32 arm: path-addressed, detection not prevention
  let fd = null;
  let primary;
  try {
    fd = openPinnedDir(dirPath);
    return fn(`${PROCFS_FD_DIR}/${fd}`);
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    closePinned(fd, primary);
  }
}

// THE PRIMITIVE EVERY SECURE OPERATION IS BUILT FROM. Walks `rel`'s ancestors
// from the retained root anchor, pinning each confirmed directory, and calls
// `fn(parentHandle, leaf)` WHILE THE PARENT IS STILL PINNED — which is the whole
// point: the callback's operation resolves through a descriptor this process
// holds, not through a path string the OS re-walks.
// A MISSING ancestor is not a violation: `fn` is called with a NULL handle,
// meaning "nothing to resolve" — the same disposition the Slice 1 component
// walk expressed as its 'absent' return.
// v6.0 (Codex review of the S3 excision): the `opts.createParents` mode — a
// per-component `mkdirSync` through the pinned parent — is DELETED with the
// restore family; its last caller was `materializeHeadBlob`, and a dormant
// directory-creation arm would falsify the no-write-primitive claim the
// restore gravestone makes (dc616f69 R11/R17). `opts` is retained in the
// signature so the many call sites keep their shape; no option is currently
// read from it.
function withPinnedParent(cwd, rel, what, opts, fn) {
  const segments = rel.replace(/\/+$/, '').split('/');
  for (const s of segments) assertResolvableComponent(s, rel, what);
  const leaf = segments[segments.length - 1];
  const step = (dirHandle, i, soFar) => {
    if (i === segments.length - 1) return fn(dirHandle, leaf);
    const name = segments[i];
    const nextRel = soFar ? `${soFar}/${name}` : name;
    const anchored = `${dirHandle}/${name}`;
    // lstat THROUGH the pinned parent, never openSync: an lstat cannot block, so
    // a fifo/socket/device component is classified ('other') instead of hanging
    // the hook, and only a component confirmed a real directory is ever opened.
    const kind = lstatKind(anchored);
    if (kind === 'absent') return fn(null, leaf);
    if (kind !== 'dir') {
      throw new Error(
        `${what} path component '${nextRel}' (an ancestor of '${rel}') is not a directory (lstat kind: ${kind}) — refusing to read/walk/write ` +
          `through it; a symlink or other non-regular ancestor is denied on sight, never followed`
      );
    }
    return withPinnedDir(anchored, (childHandle) => step(childHandle, i + 1, nextRel));
  };
  return step(repoRootDir(cwd), 0, '');
}

// CLASSIFY A LEAF BY OPENING IT, not by lstat-then-open (Linux). The lstat/open
// pair is itself a classify→use window: an lstat says "regular file", a racer
// swaps in a DIFFERENT regular file, and the open that follows reads bytes the
// classification never saw. Opening FIRST and deciding from the descriptor's own
// fstat removes the window entirely — whatever the fd holds is what gets read,
// and O_NOFOLLOW means the fd can never be a symlink's target.
// O_NONBLOCK for the reason sha256OfFileStreamed already documents: a fifo or
// device swapped in under the gate would BLOCK in open() itself, and a blocked
// hook is timeout-killed into a non-2 (fail-OPEN) exit. With O_NONBLOCK the open
// returns and the fstat rejects the type — the same trade this file already
// settled ("a prior lstat cannot substitute — it leaves the swap race").
// ELOOP is the symlink verdict (Ruling B: unattestable, never read through);
// ENXIO/ENODEV/EOPNOTSUPP are types the open itself refuses, classified 'other'
// exactly as an lstat would have classified them.
// NATIVE WINDOWS keeps the lstat arm: libuv ignores O_NOFOLLOW there and Node
// cannot open a directory as a descriptor at all, so the disclosed
// detection-not-prevention envelope (2a69a8d7) applies unchanged. PRECISELY
// WHAT THAT MEANS HERE, because "detection" overstates it for one branch: the
// win32 detection is delivered by `openLeafNoFollow`'s bigint dev/ino + kind
// check on the BYTE-READ path, which a 'file' leaf always reaches and a 'dir'
// leaf never does. So a win32 'file' verdict is re-established by identity
// before its bytes are used, while a win32 'dir' verdict is a KIND VERDICT ONLY
// — nothing here or downstream re-checks that the directory this walk descends
// into is the object lstat classified. See "FILES YES, DIRECTORIES NO" in the
// platform-envelope block above for the escape that rests on it (board
// 7c120461) and for the 2026-08-27 native-Windows MEASUREMENT that settles it.
// There is no test that settles it: the h17 suite reports 0 pass / 36 SKIP on
// native Windows, so a pin added there would be hollow by construction.
// The returned `fd` (Linux, file or directory) is the CALLER's to close.
function classifyLeafAt(parentHandle, leaf) {
  const anchored = `${parentHandle}/${leaf}`;
  if (IS_WIN32) {
    let st;
    try {
      st = lstatSync(anchored);
    } catch (e) {
      if (e && e.code === 'ENOENT') return { kind: 'absent', fd: null, st: null, anchored };
      throw e;
    }
    if (st.isSymbolicLink()) return { kind: 'symlink', fd: null, st, anchored };
    if (st.isDirectory()) return { kind: 'dir', fd: null, st, anchored };
    if (st.isFile()) return { kind: 'file', fd: null, st, anchored };
    return { kind: 'other', fd: null, st, anchored };
  }
  let fd;
  try {
    fd = openSync(anchored, FS.O_RDONLY | FS.O_NONBLOCK | FS.O_NOFOLLOW);
  } catch (e) {
    const code = e && e.code;
    if (code === 'ENOENT') return { kind: 'absent', fd: null, st: null, anchored };
    if (code === 'ELOOP') return { kind: 'symlink', fd: null, st: null, anchored };
    if (code === 'ENXIO' || code === 'ENODEV' || code === 'EOPNOTSUPP') return { kind: 'other', fd: null, st: null, anchored };
    throw e;
  }
  try {
    const st = fstatSync(fd);
    const kind = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
    return { kind, fd, st, anchored };
  } catch (e) {
    closePinned(fd, e);
    throw e;
  }
}

// The pinned handle for a directory we have ALREADY classified and still hold.
// On Linux this is the very descriptor `classifyLeafAt` opened — no reopen, so
// not even a one-instruction window between the classification and the walk.
function dirHandleOf(h) {
  return IS_WIN32 ? h.anchored : `${PROCFS_FD_DIR}/${h.fd}`;
}

// A leaf's own lstat kind, resolved through its PINNED parent. Replaces
// `lstatKind(join(cwd, rel))`, which re-walked the whole string from the root
// and so could be re-aimed by an ancestor swap. A missing ancestor is 'absent'
// (nothing to classify); a non-directory ancestor THROWS into the caller's
// fail-closed catch, which is the settled disposition for ancestor ambiguity.
function lstatKindUnder(cwd, rel, what = 'path classification') {
  return withPinnedParent(cwd, rel, what, {}, (parentHandle, leaf) => (parentHandle === null ? 'absent' : lstatKind(`${parentHandle}/${leaf}`)));
}

// GRAVESTONE — `writeRegularAt(parentHandle, leaf, buf, rel, opts)` stood here:
// the descriptor-pinned regular-file write primitive (existing-entry
// open→fstat→ftruncate arm, plus a `createOnly` O_CREAT|O_EXCL security mode).
// DELETED 2026-08-30 (v6.0, dc616f69 R11): its last caller was the (A) restore's
// `materializeHeadBlob`, and the restore is gone — see the restore-family
// gravestone further down. With it gone this file holds NO primitive that writes
// a repo path.

// [DELETED 2026-08-27, user ruling — see the `removeUnder` gravestone further
// down.] `removeFileAt(parentHandle, leaf, rel)` used to unlink a single regular
// file through a pinned parent. Its ONLY caller was `removeUnder`, the (B)
// addition arm's delete, and the ruling took that arm out: an unexpected
// addition is DENIED and REPORTED and the file SURVIVES on disk. With no caller
// left, keeping the primitive would leave an unlink sitting in the file that a
// later edit could re-aim at the addition path — the structural point of the
// ruling is that this file no longer HOLDS a single-file delete for baseline
// diffing to reach.
// CORRECTION (v4.1, 2026-08-27): the parenthetical that used to end the sentence
// above — "(git-recoverable)" — WAS FALSE, AND BELIEVING IT WAS THE DEFECT.
// NOT-IN-HEAD is precisely the arm with NO blob to recover from, and a
// `git add -f`'d (B) file lands there via the (A) sweep.
// v6.0 (2026-08-30): `removeTreeAt` — the recursive-delete primitive that was
// "the only delete primitive here", reachable only from `restoreTracked`'s
// not-in-HEAD arm — is deleted with the restore family (dc616f69 R11). This
// file now holds NO delete primitive of any shape.


// ---------------------------------------------------------------------------
// THE BOUNDED-RESOURCE LAYER (board 55fcccac). Everything below exists so that
// no input this hook reads — a file, a directory tree, a temp record — can put
// the PROCESS outside its own fail-closed control flow, where AC9 cannot reach
// it. Two different bounding shapes, deliberately, because the two hazards are
// different:
//   * BYTES ARE STREAMED, NEVER CAPPED. A dirty file's size is the USER's, not
//     the attacker's: a size cap on the hashing path denies a legitimate
//     workflow (the disqualified fix), while streaming makes the memory cost
//     constant no matter how large the file is. There is deliberately NO
//     per-file and NO total-bytes budget anywhere on the hashing path.
//   * STRUCTURE IS BUDGETED, AND OVERFLOW DENIES. A walk's node count and depth
//     are unbounded WORK, not bounded memory — streaming cannot fix them, and
//     the honest disposition for "this tree is too large to attest inside a
//     hook's time" is the hook's own BLOCKING deny (exit 2) naming the budget,
//     which is strictly better than the OOM/timeout kill it replaces (that kill
//     exits non-2 and the platform ALLOWS the write).
// ---------------------------------------------------------------------------

// Fixed read buffer for every streamed hash — constant memory, reused per file.
const HASH_CHUNK_BYTES = 64 * 1024;

// How many times the hashing core may re-read a file that moved under it before
// it gives up and declares the bytes UNATTESTABLE (board fabf21d8). A FIXED
// COUNT, not a deadline and not a condition: the loop is `for (attempt = 1;
// attempt <= HASH_STABILITY_ATTEMPTS; attempt++)` over a constant, each attempt
// reads at most the size ITS OWN fstat reported (so a file being appended to
// faster than the hash advances cannot extend an attempt), and there is no
// sleep, no wait and no recursion — so the retry TERMINATES in at most three
// bounded passes whatever the file does. Three because the failure it answers is
// a write window closing (one retry is often enough) while every additional pass
// is work a security gate pays on its critical path.
const HASH_STABILITY_ATTEMPTS = 3;

// Structural walk budgets. Sized far above ordinary use and far below the
// pathological shapes that kill the process: a normal dirty untracked tree is
// tens to hundreds of entries and a handful of levels deep, while the shapes
// that OOM/timeout a hook are tens of thousands of entries or hundreds of
// levels. CUMULATIVE PER HOOK INVOCATION (not per path): 100k files spread over
// many small dirty directories is the same unbounded work as 100k in one, so
// the counter is charged across the whole sweep — the cumulative TIME bound the
// board asks for, expressed as node count rather than a wall clock (a clock
// makes the verdict depend on machine speed, i.e. non-deterministic denials).
const MAX_WALK_NODES = 10_000;
const MAX_WALK_DEPTH = 64;

// Per-CLASS size budgets for the small JSON metadata this hook reads back.
// Unlike the dirty set, these are records H17 WRITES ITSELF (the (A) state +
// attribution records, the (B) content baseline) or that a conductor CLI writes
// (the stamp), so a cap here cannot false-deny a user's legitimate large file —
// it can only refuse a record that is not the shape H17 produced. The (B)
// baseline is the largest by construction (base64 of the small enforcement set;
// 717 KB measured live), so 16 MiB is ~20x headroom, while the stamp is a list
// of {path, sha256} entries and never approaches 8 MiB.
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_STAMP_BYTES = 8 * 1024 * 1024;

// A tripped structural budget, distinguishable from every other throw so the
// two call sites can dispose of it differently: PRE records it as an
// unattestable snapshot and lets the command run (a snapshot stage must never
// deny for the SIZE of the tree it found — that is the false-deny class this
// redesign exists to avoid); POST lets it reach the fail-closed catch, which
// DENIES (exit 2) naming the budget. `budget` names which one tripped.
class WalkBudgetError extends Error {
  constructor(message, budget) {
    super(message);
    this.name = 'WalkBudgetError';
    this.budget = budget;
  }
}

// A file whose bytes could NOT be attested because the file was being written
// THROUGHOUT the snapshot — distinguishable from every other throw for the same
// reason WalkBudgetError is: the (A) STATE snapshot converts it into an explicit
// `file_unattested` state (never equal, never stamp-attestable), while every
// OTHER caller of the hashing core lets it reach a fail-closed catch and DENY.
// Board fabf21d8: the exact-size + re-fstat stability check (Codex F3) denies the
// guarded command whenever ANOTHER legitimate process is appending to a dirty
// file while PRE takes its snapshot — but at PRE the command has not run yet, so
// a mutation there cannot be its doing and "violation signal" is too strong.
// A BOUNDED RETRY answers the common case (a brief write window closes and the
// second or third attempt is stable); persistent instability is recorded, not
// laundered.
class FileUnstableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FileUnstableError';
  }
}

// ONE budget object threaded through every walk of a single hook invocation.
function newWalkBudget() {
  return {
    nodes: 0,
    // Charged PER ENTRY as the entry is produced — which is why the walks use
    // opendirSync's incremental iteration rather than readdirSync: readdirSync
    // materializes the WHOLE listing (and every Dirent) before a single charge
    // could happen, so a million-entry flat directory OOMs before the budget is
    // ever consulted. The budget must be able to stop a walk MID-DIRECTORY.
    chargeNode(rel) {
      if (++this.nodes > MAX_WALK_NODES) {
        throw new WalkBudgetError(
          `walk-node budget exceeded (limit ${MAX_WALK_NODES} entries) while walking '${rel}' — refusing to enumerate an unbounded tree inside a hook. ` +
            `An unbounded walk that OOMs or times out kills this process, and a killed guard exits non-2, which the platform treats as NON-BLOCKING (the write would be ALLOWED). ` +
            `This denial is the bounded alternative: commit, clean or ignore the oversized untracked tree, then rerun.`,
          'node'
        );
      }
    },
    chargeDepth(depth, rel) {
      if (depth > MAX_WALK_DEPTH) {
        throw new WalkBudgetError(
          `walk-depth budget exceeded (limit ${MAX_WALK_DEPTH} levels) at '${rel}' — refusing to recurse into an unbounded directory chain inside a hook. ` +
            `Unbounded recursion that overflows or times out kills this process, and a killed guard exits non-2, which the platform treats as NON-BLOCKING (the write would be ALLOWED). ` +
            `This denial is the bounded alternative: commit, clean or ignore the oversized untracked tree, then rerun.`,
          'depth'
        );
      }
    },
  };
}

// sha256 of a file's RAW bytes, STREAMED (board 55fcccac clause 1). Replaces
// createHash().update(readFileSync(abs)) — which allocated the WHOLE file
// (twice, counting the digest's own copy) and so made the guard's memory a
// function of the user's dirty tree. Memory here is HASH_CHUNK_BYTES flat, for
// a 20 MiB file and a 20 GiB one alike, so there is no size at which this path
// needs a cap and no size at which it can false-deny.
// The open is O_RDONLY | O_NONBLOCK and the fstat is on the OPEN DESCRIPTOR
// (Codex F2): openSync(path,'r') on a fifo/socket that was swapped in under the
// gate BLOCKS in the open() call itself — before any fstat could reject it —
// and a blocked hook is killed by the host timeout into a non-2 (fail-OPEN)
// exit. O_NONBLOCK makes the open return immediately for those types so the
// fstat regular-file check can reject them; a regular file ignores O_NONBLOCK,
// so its reads behave exactly as before. A prior lstat cannot substitute — it
// leaves the fifo-swap race between the lstat and the open. (SLICE 1, decision
// 532a4383: the open now goes through `openLeafNoFollow`, which adds
// O_NOFOLLOW on Linux and lstat/fstat bigint identity verification on native
// Windows — the layer decision h17-windows-detect-and-abort called its own
// slice. The ANCESTOR chain of `abs` is still classified by the caller rather
// than descriptor-anchored here, because this function is addressed by an
// absolute path; anchoring the read itself belongs to the S2 write/read
// primitives that take (cwd, rel).)
// BOUNDED READ, NOT A SIZE CAP (Codex F3): the read is bounded to the INITIAL
// fstat size and re-fstats afterward, throwing on any size/mtime/ctime change.
// An unbounded read-until-EOF loop chases a file appended-to faster than the
// hash advances FOREVER (timeout -> non-2 -> fail-open); reading exactly the
// bytes present at open, then confirming the file did not change, bounds the
// work WITHOUT capping the size (memory stays HASH_CHUNK_BYTES flat for a file
// of any size, so a large legit dirty file still can never deny by itself).
// A file mutating mid-hash is itself a violation signal, so the throw (-> deny)
// is correct on both counts. Throws on any I/O error, as the readFileSync it
// replaces did.
function sha256OfFileStreamed(abs) {
  const fd = openLeafNoFollow(abs); // SLICE 1: no-follow (Linux) / identity-verified (win32)
  let primary;
  try {
    return sha256OfOpenFd(fd, abs);
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    try {
      closeSync(fd);
    } catch (closeErr) {
      // A leaked descriptor marches toward EMFILE, and an EMFILE mid-check is
      // itself a non-2 fail-open (Codex F5). Swallow the close error ONLY while
      // a primary exception is already driving a deny; with no primary pending,
      // the leaked fd IS the failure and must propagate to the fail-closed catch.
      if (!primary) throw closeErr;
    }
  }
}

// SLICE 2: the hashing core, addressed by an ALREADY-OPEN DESCRIPTOR rather than
// a path. This is what lets a caller that has just CLASSIFIED a leaf hash the
// very object it classified — no second resolution, so no window between the
// two. The descriptor stays the caller's to close.
// BOUNDED RETRY FOR A STABLE SNAPSHOT (board fabf21d8). The single-attempt shape
// treated ANY size/mtime/ctime movement as a hard throw, and PRE's per-path loop
// turns a throw into a DENY of the still-unexecuted command — so a dirty file
// being written by another legitimate process during the snapshot window denied
// the guarded Bash call. That is fail-closed but WRONG: at Pre the mutation
// cannot be the command's doing. Retry a bounded number of times for a stable
// pass; only PERSISTENT instability is unattestable, and it is RECORDED as such
// (FileUnstableError -> `file_unattested`) rather than laundered into a digest.
// The retry cannot weaken any verdict: an attempt still returns a digest ONLY
// when its own read covered exactly the bytes its fstat promised AND size/mtime/
// ctime did not move across it, which is the identical acceptance test as before.
// TERMINATION: a fixed attempt count over bounded work — see HASH_STABILITY_ATTEMPTS.
// EXPLICIT READ POSITIONS, not the fd's own offset: a retry must re-read from
// byte 0, and the shared descriptor's offset is left wherever the previous
// attempt stopped. Positional reads make each attempt independent of the last
// (and of any other reader of the same descriptor).
function sha256OfOpenFd(fd, label) {
  if (!fstatSync(fd).isFile()) {
    throw new Error(`'${label}' is not a regular file (fstat) — refusing to stream-hash it; only a regular file's bytes are hashable`);
  }
  let lastReason = null;
  for (let attempt = 1; attempt <= HASH_STABILITY_ATTEMPTS; attempt++) {
    const st = fstatSync(fd);
    const expectedSize = st.size;
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let total = 0;
    while (total < expectedSize) {
      const want = Math.min(HASH_CHUNK_BYTES, expectedSize - total);
      const n = readSync(fd, buf, 0, want, total); // EXPLICIT position: this attempt owns its offsets
      if (n <= 0) break; // shrank/EOF-early → caught by the size re-check below
      hash.update(n === HASH_CHUNK_BYTES ? buf : buf.subarray(0, n)); // update COPIES into the digest, so the buffer is safe to reuse
      total += n;
    }
    const st2 = fstatSync(fd);
    if (total === expectedSize && st2.size === expectedSize && st2.mtimeMs === st.mtimeMs && st2.ctimeMs === st.ctimeMs) {
      return hash.digest('hex');
    }
    lastReason = `attempt ${attempt}/${HASH_STABILITY_ATTEMPTS} read ${total} of ${expectedSize} bytes; size ${st.size}->${st2.size}, mtime ${st.mtimeMs}->${st2.mtimeMs}, ctime ${st.ctimeMs}->${st2.ctimeMs}`;
  }
  throw new FileUnstableError(
    `'${label}' changed under every one of ${HASH_STABILITY_ATTEMPTS} bounded stream-hash attempts (${lastReason}) — refusing a torn hash; its bytes are UNATTESTABLE for this snapshot`
  );
}

// A SIZE-PRECHECKED read for the small JSON records this hook reads back (board
// 55fcccac clause 4). The order is load-bearing: fstat FIRST, refuse an
// over-budget size BEFORE any buffer is allocated — a guard that allocates and
// then measures has already paid the cost it was meant to refuse. Reads at most
// size+1 bytes and requires the read to land EXACTLY on the fstat size, then
// re-fstats to confirm size/mtime/ctime did not move, so a record swapped under
// the gate produces a refusal rather than a torn parse. Every caller already
// wraps its read in a fail-closed catch, so a throw here lands on the SAME deny
// the corrupt-record path has always produced.
// O_NONBLOCK + fstat-on-descriptor (Codex F2): openSync(path,'r') on a
// fifo/device swapped in under the gate blocks in the open() itself, before any
// fstat could reject it, and a blocked hook is timeout-killed into a non-2
// fail-open. O_NONBLOCK returns immediately for those types so the regular-file
// check can reject them; a regular file ignores the flag. A prior lstat cannot
// substitute — it leaves the swap race between the lstat and the open.
// EXACT-SIZE, NOT just NOT-GREW (Codex F4): the old check accepted total < size
// — a record TRUNCATED after the fstat to a shorter-but-valid JSON (`{}`/`[]`)
// read as authoritative, and an empty baseline makes every current (B) file
// look like an unauthorized addition and get REMOVED. Requiring total === size
// AND an unchanged re-fstat rejects a truncation as loudly as a growth.
function readBoundedFile(abs, maxBytes, what) {
  return readBoundedBuffer(abs, maxBytes, what).toString('utf8');
}

// The same read, returning RAW BYTES. The (B) content baseline stores base64 of
// the raw bytes (never a decoded utf8 string — two different invalid-UTF-8
// sequences decode to the same U+FFFD, which is lossy exactly where tampering
// hides), so it needs the buffer, not the string. `maxBytes` may be Infinity for
// a surface whose size bound is enforced elsewhere.
function readBoundedBuffer(abs, maxBytes, what) {
  const fd = openLeafNoFollow(abs); // SLICE 1: no-follow (Linux) / identity-verified (win32)
  let primary;
  try {
    return readBoundedFromFd(fd, maxBytes, what, abs);
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    try {
      closeSync(fd);
    } catch (closeErr) {
      // Codex F5: propagate a close failure only when no primary exception is
      // already driving a deny — a leaked fd marches toward an EMFILE fail-open.
      if (!primary) throw closeErr;
    }
  }
}

// SLICE 2 (review finding B): the bounded read addressed by an ALREADY-OPEN
// DESCRIPTOR. This is what lets a caller that has just CLASSIFIED a leaf read the
// very object it classified, instead of reopening the same NAME and hoping the
// two resolutions agree. The descriptor stays the caller's to close.
function readBoundedFromFd(fd, maxBytes, what, abs) {
  {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${what} '${abs}' is not a regular file (fstat) — refusing to read it`);
    if (st.size > maxBytes) {
      throw new Error(`${what} '${abs}' is ${st.size} bytes, over the ${maxBytes}-byte budget for this record class — refusing to allocate or parse it`);
    }
    const cap = st.size + 1; // +1 so a file that grew is DETECTED rather than silently truncated
    const buf = Buffer.allocUnsafe(cap);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, total, cap - total, null);
      if (n <= 0) break;
      total += n;
      if (total >= cap) break;
    }
    if (total !== st.size) {
      throw new Error(`${what} '${abs}' read ${total} bytes but its fstat size was ${st.size} — refusing a torn read (the record grew or was truncated under the gate)`);
    }
    const st2 = fstatSync(fd);
    if (st2.size !== st.size || st2.mtimeMs !== st.mtimeMs || st2.ctimeMs !== st.ctimeMs) {
      throw new Error(`${what} '${abs}' changed while being read (size ${st.size}->${st2.size}, mtime ${st.mtimeMs}->${st2.mtimeMs}, ctime ${st.ctimeMs}->${st2.ctimeMs}) — refusing to trust a record mutated under the gate`);
    }
    return buf.subarray(0, total);
  }
}

function readBoundedJsonFile(abs, maxBytes, what) {
  return JSON.parse(readBoundedFile(abs, maxBytes, what));
}

// THE invocation's walk budget. One hook call is one process, so a module-level
// object is exactly "cumulative across this invocation" — every walk in this
// process charges the same counter, which is the point: the work that kills a
// hook is the SUM of its walks, not the largest one.
const WALK_BUDGET = newWalkBudget();

// The baseline path is PROJECT-UNIQUE (audit finding 7/43): two concurrent
// Sterling sessions in different projects previously shared os.tmpdir()/
// sterling-enforce-<runId>.json — and with runId='no-run' (a machine-wide
// constant outside runs) project B's Pre snapshot could overwrite project A's,
// so A's Post restored A's enforcement files from B's bytes. A sha256 prefix of
// the realpath'd cwd discriminates projects; realpath so WSL/symlink aliasing
// can't split a Pre/Post pair (both hooks pass the same input.cwd).
function projectTag(cwd) {
  let root = cwd;
  try {
    root = realpathSync(cwd);
  } catch {
    /* cwd unreadable — fall back to the raw path (still project-distinguishing) */
  }
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

// KEYED PER BASH CALL when the platform gives us a usable tool_use_id (board
// 11609d1f), for exactly the reason the (A) STATE record already is (7021526c
// binding 2, AC14): a run-keyed baseline is ONE FILE SHARED BY EVERY CONCURRENT
// LANE and each Pre OVERWRITES it, so lane A's Pre snapshots a clean file, lane
// A's command tampers, lane B's Pre lands before lane A's Post and overwrites
// the shared baseline with the TAMPERED state, and both Posts then compare the
// tamper against itself and allow it. On the (B) side that is worse than a
// missed denial: this is the branch that RESTORES BY WRITING FILE CONTENT, so
// an adopted-tamper baseline turns the guard into a writer of
// attacker-influenced bytes.
// THE FILENAME DELIBERATELY DOES NOT COLLIDE WITH THE (A) STATE RECORD'S
// (`…-<runId>-call-<hex>.json`): two files cannot share one path, and the (A)
// record is identified BY that exact shape, so the (B) baseline carries a
// further `.baseline` token — `…-<runId>-call-<hex>.baseline.json`.
// A NULL KEY IS NOT A SILENT FALL BACK: it returns the legacy per-run name, and
// the fallback is disclosed on EVERY path — a non-fatal stderr line the moment
// the shared baseline is used, allow path included, plus a named part in any
// denial the (B) writes compose (see `baselineShared` at Post). Keeping the legacy name for the degraded case —
// rather than refusing to verify (B) at all — is what preserves today's
// behaviour for a platform that does not carry tool_use_id, and the disclosure
// is what stops that fallback from being invisible.
function baselineFile(cwd, runId, key) {
  const tag = projectTag(cwd);
  return join(tmpdir(), key ? `sterling-enforce-${tag}-${runId}-call-${key}.baseline.json` : `sterling-enforce-${tag}-${runId}.json`);
}

// The (A) attribution record (decision f76d7c5c): which TRACKED paths were
// already dirty before this command ran. A SEPARATE file rather than a field on
// the (B) baseline, deliberately — the baseline's key-validation loop is the most
// security-critical code in this hook and adding a field would force a change to
// it (smallest safe implementation).
// KEYED PER BASH CALL when the platform gives us a usable tool_use_id (board
// 489554d4), for exactly the reason the (A) STATE record (7021526c) and the (B)
// content baseline (11609d1f) already are: a run-keyed attribution record is ONE
// FILE SHARED BY EVERY CONCURRENT LANE and each Pre OVERWRITES it. The DESTRUCTIVE
// laundering direction here is worse than a missed denial — if lane B's Pre lands
// after lane A's Pre and OMITS a path that was genuinely dirty at lane A's Pre
// (because B's command already cleaned or reverted it, or simply raced), lane A's
// Post reads the overwritten record, finds NO covering pre-dirty entry, falls to
// the clean-at-Pre arm and HEAD-restores (DELETES) that pre-existing dirty path:
// real conductor work destroyed, the harm class of board 7dd39b85.
// THE FILENAME DELIBERATELY DOES NOT COLLIDE WITH EITHER OTHER PER-CALL RECORD:
// the (A) STATE record is `…-<runId>-call-<hex>.json` and the (B) baseline is
// `…-<runId>-call-<hex>.baseline.json`, so this attribution record carries its
// own `.dirty` token — `…-<runId>-call-<hex>.dirty.json`. Two files cannot share
// one path, and a `-call-<hex>.dirty` middle segment is not all-hex, so it can
// never be mistaken for the STATE record's `-call-<hex>.json` name.
// A NULL KEY IS NOT A SILENT FALL BACK: it returns the legacy per-run name (the
// only way today's no-tool_use_id platforms keep working), and Post discloses the
// shared-record exposure LOUDLY on every path (see `attributionShared`). Never a
// silent fallback to a per-run key.
function dirtyFile(cwd, runId, key) {
  const tag = projectTag(cwd);
  return join(tmpdir(), key ? `sterling-enforce-${tag}-${runId}-call-${key}.dirty.json` : `sterling-enforce-${tag}-${runId}.dirty.json`);
}

/** Repo-relative paths of everything git reports as changed, Pre-snapshot shape. */
function dirtyTrackedRels(cwd) {
  const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '-z'], { encoding: 'utf8' });
  if (status.error || status.status !== 0) {
    throw new Error(`git status --porcelain -z failed (status ${status.status}: ${status.stderr || status.error})`);
  }
  const rels = [];
  for (const entry of parsePorcelainZ(status.stdout)) {
    for (const p of entry.paths) {
      const rel = p.replace(/\/+$/, '');
      if (rel) rels.push(rel);
    }
  }
  return rels;
}

// ---------------------------------------------------------------------------
// The (A) PER-CALL Pre-STATE record (decision h17-pre-state-snapshot-closes-
// false-denial-not-the-restore-hole, 7021526c). The paths-only record above let
// Post see only THAT a path was dirty at Pre, never whether the audited command
// touched it — which is the whole (and only) warrant for the blanket
// pre-existing denial. This record carries each dirty path's STATE so Post can
// compare, and the denial's warrant dissolves for a path it can verify itself.
// ---------------------------------------------------------------------------

// KEYED PER BASH CALL, never per run: if lane B's Pre lands after lane A's
// command already tampered, a shared per-run record adopts the tampered bytes
// as B's baseline and Post A then compares them against themselves and ALLOWS a
// real tamper. sha256 of the platform's tool_use_id is the per-call
// discriminator. Returns null when the id is UNUSABLE — absent, not a string,
// or empty/whitespace (a presence check would hash a constant, i.e. a per-run
// key under another name, reopening exactly that false allow). A null key is a
// degraded-LOUD fallback at the call site, never a silent per-run key.
function callKey(toolUseId) {
  if (typeof toolUseId !== 'string') return null;
  const trimmed = toolUseId.trim();
  if (!trimmed) return null;
  return createHash('sha256').update(trimmed).digest('hex').slice(0, 32);
}

function stateFile(cwd, runId, key) {
  return join(tmpdir(), `sterling-enforce-${projectTag(cwd)}-${runId}-call-${key}.json`);
}

// THE PER-CALL STAMP WITNESS RECORD (Ruling 2 of fac9a69b): the stamp's own state
// as Pre observed it, so Post can tell an in-window stamp write from a legitimate
// conductor rewrite made BETWEEN windows. A SEPARATE FILE rather than a field on
// the (B) content baseline, for the same reason the (A) attribution record is one:
// the baseline's key-validation loop is the most security-critical code in this
// hook, every key it accepts must match a (B) glob, and the stamp is not in that
// set — smuggling a witness through it would force a change to exactly the loop
// that must not change (smallest safe implementation).
// THE FILENAME CANNOT COLLIDE WITH ANY OTHER PER-CALL RECORD: the (A) STATE record
// is `…-<runId>-call-<hex>.json`, the (B) baseline is `…-call-<hex>.baseline.json`
// and the attribution record is `…-call-<hex>.dirty.json`, so this one carries its
// own `.stamp` token. A `-call-<hex>.stamp` middle segment is not all-hex, so it
// can never be mistaken for the STATE record's name.
// A NULL KEY RETURNS THE LEGACY PER-RUN NAME, never a silent per-call fabrication,
// matching every other record here; the degraded exposure is disclosed at Post
// through the existing `baselineShared` / `attributionShared` notices. The per-call
// record is unlinked by the Post that reads it; the legacy per-run one is left for
// concurrent lanes, exactly as the (B) baseline's is.
// ACCEPTED, DISCLOSED RESIDUAL — LIKE EVERY OTHER RECORD THIS HOOK WRITES, THIS
// ONE IS AGENT-WRITABLE. os.tmpdir() is writable by the audited command, the
// filename is derived from values the command can compute (project tag, run id,
// tool_use_id), and no gate covers that path — the (B) denial already says exactly
// this about the content baseline ("these records live in os.tmpdir() and are
// writable by the audited command"). So the stamp-integrity comparison is
// DETECTION resting on an attacker-writable input, not prevention: an agent that
// overwrites its own witness to describe a stamp it is about to counterfeit defeats it.
// Unfixable at this layer — hook and command share a UID with no privilege
// boundary (research_finding 79942bda) — so it is named here rather than implied.
function stampWitnessFile(cwd, runId, key) {
  const tag = projectTag(cwd);
  return join(tmpdir(), key ? `sterling-enforce-${tag}-${runId}-call-${key}.stamp.json` : `sterling-enforce-${tag}-${runId}.stamp.json`);
}

// Current INDEX entries (`mode:oid:stage`, conflict stages joined) for the given
// repo-relative paths, as a Map path -> string. Its own term in the comparison
// because a staged-index-only change (`git add`) moves nothing in the worktree:
// bytes, type and mode all still compare equal, and the porcelain XY code can be
// held constant, so without this term the change is invisible. Any git failure
// throws -> AC9 fail-closed.
function indexEntriesFor(cwd, rels) {
  const map = new Map();
  if (!rels.length) return map;
  const staged = new Map();
  // CHUNKED + --literal-pathspecs (review finding 5, resource shape): one
  // spawn carrying every dirty path can exceed the OS argument limit (E2BIG)
  // on a large dirty set, and a guard that dies of E2BIG dies OUTSIDE its own
  // fail-closed control flow, where AC9 cannot reach it. --literal-pathspecs
  // so a dirty filename containing pathspec magic (a leading ':' or a glob
  // metacharacter) is treated as a PATH and cannot widen or narrow what the
  // index query reports. A git failure in ANY chunk still throws -> AC9 deny.
  const CHUNK_ARGS = 256;
  const CHUNK_CHARS = 32 * 1024;
  for (let i = 0; i < rels.length; ) {
    const chunk = [];
    let chars = 0;
    while (i < rels.length && chunk.length < CHUNK_ARGS && chars < CHUNK_CHARS) {
      chars += rels[i].length + 1;
      chunk.push(rels[i++]); // at least one per chunk — a single huge path still progresses
    }
    const r = spawnSync('git', ['-C', cwd, '--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...chunk], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) {
      throw new Error(`git ls-files --stage -z failed (status ${r.status}: ${r.stderr || r.error})`);
    }
    for (const tok of (r.stdout || '').split('\0')) {
      if (!tok) continue;
      const tab = tok.indexOf('\t');
      if (tab < 0) throw new Error(`git ls-files --stage -z produced an unparseable entry ('${tok.slice(0, 60)}')`);
      const p = tok.slice(tab + 1);
      const list = staged.get(p) ?? [];
      list.push(tok.slice(0, tab).trim().replace(/\s+/g, ':')); // "<mode> <oid> <stage>" -> "mode:oid:stage"
      staged.set(p, list);
    }
  }
  for (const [p, list] of staged) map.set(p, list.sort().join(','));
  return map;
}

// One path's STATE. "State" is deliberately NOT bytes alone: each term below is
// an escape a bytes-only comparison would miss and today's blanket denial does
// catch — a mode flip with identical bytes; a regular file replaced by a symlink
// whose target holds identical bytes; a symlink re-pointed at another
// identical-content target; a staged-index-only change. BYTES ARE CARRIED AS A
// RAW-BYTE SHA-256, never as base64 and never as a UTF-8 string (review finding
// 5): the comparison only ever needs EQUALITY, and the bytes themselves existed
// solely for a pre-image restore that decision 7021526c puts explicitly out of
// scope — while base64 made the record grow with the size of the dirt (717 KB
// measured live, ~5.6 MB for one 4 MiB dirty file), so a big enough dirty tree
// could OOM or time out the guard OUTSIDE its own fail-closed control flow. The
// digest is over the WHOLE file's RAW bytes, never a prefix and never a decoded
// string: two different invalid-UTF-8 sequences decode to the same U+FFFD, so a
// text snapshot is lossy exactly where tampering hides, and a raw-byte digest
// keeps that escape visible. A symlink's target is NEVER read at all (Ruling B,
// 532a4383): the state records only the mode bits plus the UNATTESTABLE_SYMLINK
// marker, so the target itself never enters this comparison — see
// pathStateAt's symlink arm and symlinkModeAt below, which says the same thing
// at the call site. An unsupported file type (fifo, socket, device) throws ->
// AC9 fail-closed, never a silent "unchanged".
// BOUNDED (board 55fcccac): the BYTES term is STREAMED (constant memory, no
// size cap — a legitimately huge dirty file must never deny by itself) and the
// DIRECTORY term is walked INCREMENTALLY against a cumulative structural budget
// (`budget`, `depth`), because a collapsed untracked directory is an
// attacker-or-accident-controlled amount of WORK that streaming cannot bound.
// SLICE 2 (residual 3 of dfe70090) — THE DESCRIPTOR IS HELD FROM CLASSIFY TO
// HASH. Slice 1 classified the ancestor chain with pinned descriptors and then
// RELEASED them, after which the lstat and the stream-hash each re-resolved
// `cwd/rel` from the root by pathname: an ancestor swapped after a successful
// classification was followed by BOTH, and the guard reported "unchanged" about
// a file it had never read. The recursion had the same shape one level down
// (children reopened as `cwd/childRel`), plus a leaf regular-file swap race
// between the lstat and the open. All three are closed here:
//   * the ANCESTOR chain is pinned by `withPinnedParent` and STAYS pinned for
//     the whole of the state snapshot, so nothing below it can be re-aimed;
//   * the LEAF is classified BY OPENING IT (`classifyLeafAt`) and hashed from
//     THAT SAME DESCRIPTOR, so there is no second resolution to race;
//   * each CHILD is resolved through the descriptor its parent directory is
//     already held open on — no `cwd/childRel` reconstruction anywhere.
function pathState(cwd, rel, idx, budget = WALK_BUDGET, depth = 0) {
  return withPinnedParent(cwd, rel, `(A) state snapshot of '${rel}'`, {}, (parentHandle, leaf) => {
    // A missing ancestor means the path itself cannot exist — absence, which is
    // explicitly NOT a violation (the same disposition Slice 1's 'absent' had).
    if (parentHandle === null) return { exists: false, index: idx.get(rel) ?? null };
    return pathStateAt(parentHandle, leaf, rel, idx, budget, depth);
  });
}

function pathStateAt(parentHandle, leaf, rel, idx, budget, depth) {
  const index = idx.get(rel) ?? null;
  const h = classifyLeafAt(parentHandle, leaf);
  let primary;
  try {
    if (h.kind === 'absent') return { exists: false, index };
    // RULING B (decision 532a4383, h17-baseline-integrity-redesign-rulings-abcd):
    // A SYMLINK'S STATE IS UNATTESTABLE. The old term here was `target:
    // readlinkSync(abs)` — a value this hook cannot securely obtain: pinning a
    // symlink ITSELF (to read its target without following it) needs
    // O_PATH|O_NOFOLLOW + readlinkat, which pure Node does not expose and which a
    // native addon would only buy at the cost of the dependency-light-hooks
    // invariant (invariant 4, already refused once by 2a69a8d7). A path-addressed
    // readlink races the very swap this layer exists to stop, so the value it
    // returns is evidence of nothing. The honest disposition is fail-closed:
    // record that the state was UNKNOWABLE, never a target to compare. `sameState`
    // and `stampCouldAttest` treat this exactly as `walk_budget_exceeded` is
    // treated — NEVER equal, NEVER attestable — so a symlink is denied on the (A)
    // state surface even when it demonstrably did not move, rather than reported
    // "unchanged" on the strength of a racy read.
    // The MODE comes from a follow-up lstat on Linux, because O_NOFOLLOW gives
    // ELOOP rather than a descriptor for a link. That read is resolved through
    // the SAME pinned parent (so it can never leave this directory) and its value
    // cannot change a verdict: an unattestable state is never equal and never
    // attestable, whatever mode it carries. It is recorded only so the record's
    // shape stays uniform.
    if (h.kind === 'symlink') {
      return { exists: true, type: 'symlink', mode: symlinkModeAt(h), index, unattestable: UNATTESTABLE_SYMLINK };
    }
    // BEFORE the mode read, not after: a fifo/socket/device leaf may have been
    // refused by the OPEN itself (ENXIO and friends), in which case there is no
    // stat to read mode from. Reading it first would turn this deliberate,
    // message-bearing refusal into a TypeError — still a deny, but one that says
    // nothing about what was wrong.
    if (h.kind !== 'file' && h.kind !== 'dir') {
      throw new Error(`unsupported file type at '${rel}' — cannot snapshot its state, so this command's writes are unverifiable`);
    }
    const mode = h.st.mode & 0o7777; // PERMISSION bits only; the type is its own term
    if (h.kind === 'file') {
      // BOARD fabf21d8: a file being written throughout the snapshot is not a
      // violation — at PRE the command has not run — but neither is it
      // attestable. Record the honest "not attested" state, exactly as an
      // over-budget walk does, instead of throwing a deny at a snapshot stage.
      // ONLY FileUnstableError is converted: every other hashing failure (a
      // vanished leaf, an unreadable descriptor, a non-regular file) still
      // propagates and still denies, unchanged.
      let sha256;
      try {
        sha256 = hashClassifiedLeaf(h, rel);
      } catch (e) {
        if (!(e instanceof FileUnstableError)) throw e;
        return { exists: true, type: 'file', mode, index, file_unattested: UNATTESTABLE_FILE_BYTES };
      }
      return { exists: true, type: 'file', mode, index, sha256 };
    }
    if (h.kind === 'dir') {
      // An untracked directory reaches the sweep as its COLLAPSED path (`?? dir/`),
      // so comparing the directory alone would let a write to a file inside it pass
      // as unchanged. Recurse: every child is a state of its own. NULL-PROTOTYPE:
      // a child literally named `__proto__` must be an ordinary key here, never a
      // prototype write (the same hazard review finding 4(b) names on the record's
      // own lookup).
      budget.chargeDepth(depth, rel);
      const children = Object.create(null);
      // THE DIRECTORY WE ALREADY HOLD is what gets walked — `dirHandleOf` returns
      // the descriptor `classifyLeafAt` just opened, so there is not even a
      // one-instruction window between classifying this directory and enumerating
      // it, and every child below resolves through that descriptor.
      const dirHandle = dirHandleOf(h);
      // opendirSync + readSync, NOT readdirSync (board 55fcccac clause 3): the
      // materializing form builds the entire listing — every Dirent of a
      // million-entry flat directory — before the first budget charge could fire,
      // so the process dies before its own bound is consulted. The incremental
      // form charges as each entry arrives, which is what lets the budget stop a
      // walk MID-DIRECTORY. The handle is closed in `finally`, including on the
      // budget throw, so a tripped budget leaks no descriptor.
      const dir = opendirSync(dirHandle);
      let dirPrimary;
      try {
        for (;;) {
          const de = dir.readSync();
          if (de === null) break;
          budget.chargeNode(rel);
          const childRel = `${rel}/${de.name}`;
          children[childRel] = pathStateAt(dirHandle, de.name, childRel, idx, budget, depth + 1);
        }
      } catch (e) {
        dirPrimary = e;
        throw e;
      } finally {
        try {
          dir.closeSync();
        } catch (closeErr) {
          // Codex F5: a swallowed close error leaks the dir handle toward an
          // EMFILE fail-open. Propagate it ONLY when no primary exception (a
          // tripped budget, an unattestable entry) is already driving the verdict.
          if (!dirPrimary) throw closeErr;
        }
      }
      return { exists: true, type: 'dir', mode, index, children };
    }
    // Unreachable — the kind guard above already refused everything else. Kept
    // as a fail-closed backstop rather than a fall-through returning undefined.
    throw new Error(`unsupported file type at '${rel}' — cannot snapshot its state, so this command's writes are unverifiable`);
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    closePinned(h.fd, primary);
  }
}

// The mode bits of a leaf already classified as a SYMLINK. On win32 the lstat
// that classified it is already in hand; on Linux O_NOFOLLOW refused to open it,
// so one lstat through the pinned parent supplies the bits. Never a readlink
// (Ruling B), and never a value any verdict depends on.
function symlinkModeAt(h) {
  if (h.st) return h.st.mode & 0o7777;
  try {
    return lstatSync(h.anchored).mode & 0o7777;
  } catch {
    return 0o777; // it raced away between the failed open and here; the state is unattestable either way
  }
}

// Hash a leaf THROUGH THE DESCRIPTOR IT WAS CLASSIFIED BY. On Linux that
// descriptor is the object itself, so classify→hash is one resolution, not two.
// On win32 there is no such descriptor (the leaf was classified by lstat), so
// the hash goes through `openLeafNoFollow`'s identity-verified open — detection,
// not prevention, the disclosed envelope of 2a69a8d7.
function hashClassifiedLeaf(h, label) {
  if (h.fd !== null) return sha256OfOpenFd(h.fd, label);
  return sha256OfFileStreamed(h.anchored);
}

// The state PRE records for a directory whose walk tripped a structural budget
// (board 55fcccac clause 3). PRE deliberately does NOT deny here: the snapshot
// stage denying for the SIZE of a tree it merely FOUND is the false-deny class
// this redesign exists to avoid, and at Pre the command has not run yet, so
// there is nothing to verify and nothing to protect. What Pre owes instead is
// an honest record that this path was NOT attested — hence the explicit
// `walk_budget_exceeded` marker, which `sameState` and `stampCouldAttest` treat
// as NEVER equal and NEVER attestable. The marker is what makes the empty
// `children` map safe: without it, a command that DELETED every entry of an
// over-budget dirty enforcement directory would compare EQUAL to this snapshot
// and launder a mass deletion as "unchanged".
// A path whose walk overflows is a directory by construction (only the
// directory branch recurses), but that is re-checked rather than assumed — if
// it is not one now, the original budget error is rethrown unchanged.
function walkBudgetExceededState(cwd, rel, idx, err) {
  // SLICE 2: resolved through the pinned parent like every other classification
  // here, so the re-check cannot itself be aimed by an ancestor swap.
  const st = withPinnedParent(cwd, rel, `(A) budget-exceeded snapshot of '${rel}'`, {}, (parentHandle, leaf) =>
    parentHandle === null ? null : lstatSync(`${parentHandle}/${leaf}`)
  );
  if (!st || !st.isDirectory()) throw err;
  return {
    exists: true,
    type: 'dir',
    mode: st.mode & 0o7777,
    index: idx.get(rel) ?? null,
    children: Object.create(null),
    walk_budget_exceeded: err.budget,
  };
}

// Term-by-term equality. Each term is checked SEPARATELY and observably (never
// folded into one opaque digest) so that a defect in any single term is
// diagnosable — and so the mutation battery this slice is verified by can tell
// the terms apart. Anything unrecognized is NOT equal (fail-closed).
function sameState(a, b) {
  if (!isStateObject(a) || !isStateObject(b)) return false;
  if (a.exists !== b.exists) return false; // EXISTENCE
  if (a.index !== b.index) return false; // INDEX ENTRY (stage, mode, blob OID)
  // RULING B / UNATTESTABLE (532a4383): an endpoint whose state was UNKNOWABLE
  // can never be reported "unchanged" — there is nothing to compare it against.
  // Checked BEFORE the absent-state return AND before the type terms, so it
  // covers every shape a marker can ever land on. (Repair of an outside-family
  // review finding: it used to sit AFTER `if (!a.exists) return true`, so a
  // recorded ABSENT state carrying a marker compared EQUAL before the marker was
  // ever consulted — the guard described itself as universal and was not. No
  // well-formed record reaches that combination, since pathState emits absence
  // as {exists,index} alone and stateShapeError refuses a stray field on it, so
  // hoisting the check only ever makes a CRAFTED record stricter.)
  // Defense in depth with the explicit symlink arm below: BOTH must be stripped
  // for a link to compare equal again.
  if (a.unattestable || b.unattestable) return false;
  // CONCURRENT-MUTATION MARKER (board fabf21d8), same disposition and hoisted for
  // the same reason: a file whose bytes could not be attested carries NO digest,
  // so the file arm below would compare `undefined === undefined` and report a
  // file that was mutating throughout the snapshot as "unchanged" — the exact
  // laundering the marker exists to prevent.
  if (a.file_unattested || b.file_unattested) return false;
  if (!a.exists) return true;
  if (a.type !== b.type) return false; // FILE TYPE
  if (a.mode !== b.mode) return false; // MODE
  if (a.type === 'symlink') return false; // SYMLINK: unattestable by construction (Ruling B) — never equal, target never read
  if (a.type === 'file') {
    // Defense in depth with the hoisted marker check above, on the symlink arm's
    // precedent: BOTH must be stripped before an unattested file can compare
    // equal again.
    if (a.file_unattested || b.file_unattested) return false;
    return a.sha256 === b.sha256; // BYTES (raw-byte sha256, whole file)
  }
  if (a.type === 'dir') {
    // AN UNATTESTED WALK IS NEVER "UNCHANGED" (board 55fcccac clause 3): a
    // recorded state carrying `walk_budget_exceeded` says the tree was too
    // large to enumerate at Pre, so its (empty) children map is not evidence of
    // anything and must never compare equal — least of all to a directory the
    // command has since emptied.
    if (a.walk_budget_exceeded || b.walk_budget_exceeded) return false;
    // NO `?? {}` FALLBACK (review finding 4(a)): reading a missing children map
    // as an empty object made a recorded directory state that OMITS `children`
    // compare EQUAL to a really-empty directory, so emptying a dirty untracked
    // enforcement directory passed as "unchanged". A shape that cannot be
    // compared is NOT equal (fail-closed); the record loader rejects it outright.
    if (!isStateObject(a.children) || !isStateObject(b.children)) return false;
    const ak = ownKeys(a.children).sort();
    const bk = ownKeys(b.children).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
      if (!sameState(a.children[ak[i]], b.children[bk[i]])) return false;
    }
    return true;
  }
  return false;
}

function isStateObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function ownKeys(o) {
  return Object.keys(o).filter((k) => Object.prototype.hasOwnProperty.call(o, k));
}

// The EXACT field set a per-path state carries, per shape (board 1f4b7af0 item
// 3). pathState emits precisely these and nothing else, so any own field
// outside the set is a crafted shape — an absent state carrying a type/mode/
// digest, a file carrying stray `children`/`target`, a directory carrying a
// `sha256`. An unexpected field is refused so validation is EXACT rather than
// merely "the required fields are present" (AC12/AC14: an unexpected shape
// denies).
const STATE_FIELDS = {
  absent: ['exists', 'index'],
  file: ['exists', 'type', 'mode', 'index', 'sha256'],
  // BOARD fabf21d8: a file whose bytes were UNATTESTABLE carries the marker
  // INSTEAD of a digest — never both, which is why it is its own shape rather
  // than an optional extra field on `file`. Admitting it opens nothing: its only
  // effect anywhere is to make a state NEVER equal and NEVER stamp-attestable,
  // so a crafted record that adds it can only make the comparison stricter.
  file_unattested: ['exists', 'type', 'mode', 'index', 'file_unattested'],
  // RULING B (532a4383): a symlink carries an `unattestable` MARKER, never a
  // `target` — the target was the racy read-through this ruling removed. A
  // record that still carries `target` (an older snapshot, or a crafted one)
  // is a stray field and DENIES, which is the fail-closed direction.
  symlink: ['exists', 'type', 'mode', 'index', 'unattestable'],
  // `walk_budget_exceeded` is OPTIONAL and appears only on a Pre snapshot whose
  // walk tripped a structural budget (board 55fcccac). Admitting it to the
  // allowed set opens nothing: its only effect anywhere is to make a state
  // NEVER equal and NEVER stamp-attestable, so a crafted record that adds it
  // can only make the comparison stricter.
  dir: ['exists', 'type', 'mode', 'index', 'children', 'walk_budget_exceeded'],
};

// Returns a reason when `v` carries any OWN field outside `allowed`, else null.
function strayFieldError(v, allowed, where) {
  for (const k of ownKeys(v)) {
    if (!allowed.includes(k)) return `'${where}' carries an unexpected field '${k}' (allowed for this shape: ${allowed.join(', ')})`;
  }
  return null;
}

// Per-path VALUE validation for the Pre-STATE record (review finding 4). The
// loader used to validate only the top-level object and its KEYS, so any value
// shape at all was trusted by the comparison — and two shapes then compared
// EQUAL that must not: a directory state with no `children` key (read as `{}`)
// matched a really-empty directory. Returns null when the value is a state this
// comparison can speak for, or a human-readable reason when it is not; an
// unexpected shape DENIES (AC12: "an absent or unparseable record denies
// fail-closed" — a per-path value that is malformed is unparseable in every
// sense that matters). Child keys are validated for containment exactly like
// top-level keys, so a crafted child path cannot smuggle a traversal in.
function stateShapeError(cwd, v, where) {
  if (!isStateObject(v)) return `'${where}' is not a state object`;
  if (typeof v.exists !== 'boolean') return `'${where}' has no boolean 'exists'`;
  if (!(v.index === null || typeof v.index === 'string')) return `'${where}' has a non-string, non-null 'index'`;
  if (!v.exists) return strayFieldError(v, STATE_FIELDS.absent, where); // absence carries existence + index and NOTHING else
  if (v.type !== 'file' && v.type !== 'symlink' && v.type !== 'dir') return `'${where}' has an unrecognized 'type' (${JSON.stringify(v.type)})`;
  if (!Number.isInteger(v.mode) || v.mode < 0 || v.mode > 0o7777) return `'${where}' has an invalid 'mode' (${JSON.stringify(v.mode)})`;
  if (v.type === 'file') {
    // THE UNATTESTED SHAPE FIRST, and by the LITERAL marker (the same repair
    // Ruling B's marker took): a validator that accepts "some non-empty string"
    // accepts a crafted record whose marker is a value nothing else in this file
    // recognizes. A record carrying the marker must carry NO digest — the two
    // together would be a shape neither arm speaks for.
    if (v.file_unattested !== undefined) {
      if (v.file_unattested !== UNATTESTABLE_FILE_BYTES) {
        return `'${where}' is a file whose 'file_unattested' marker is not the literal ${JSON.stringify(UNATTESTABLE_FILE_BYTES)} (${JSON.stringify(v.file_unattested)})`;
      }
      if (v.sha256 !== undefined) return `'${where}' is a file carrying BOTH a sha256 digest and the 'file_unattested' marker — a state no comparison can speak for`;
      return strayFieldError(v, STATE_FIELDS.file_unattested, where);
    }
    if (typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256)) return `'${where}' is a file with no sha256 digest`;
    return strayFieldError(v, STATE_FIELDS.file, where);
  }
  if (v.type === 'symlink') {
    // RULING B: the ONLY thing a recorded symlink may carry is the
    // unattestable marker. A recorded link with no marker cannot be spoken for
    // by this comparison at all (it would fall through the marker check and be
    // judged on type/mode alone), so it is refused here — unparseable in every
    // sense that matters, exactly like a directory with no `children`.
    // THE LITERAL MARKER, not merely "some non-empty string" (repair of an
    // outside-family review finding): a validator that accepts any string
    // accepts a crafted record whose marker is a value nothing else in this file
    // recognizes, and the shared constant exists precisely so the record's
    // shape, its validator and its comparison cannot drift apart. Checking the
    // exact value is what makes that guarantee real.
    if (v.unattestable !== UNATTESTABLE_SYMLINK) {
      return `'${where}' is a symlink whose 'unattestable' marker is not the literal ${JSON.stringify(UNATTESTABLE_SYMLINK)} (${JSON.stringify(v.unattestable)})`;
    }
    return strayFieldError(v, STATE_FIELDS.symlink, where);
  }
  // NOTE: an EMPTY `children` map is deliberately NOT rejected here. A gitlink /
  // submodule (index mode 160000) whose worktree directory is dirty produces a
  // genuine `{exists:true,type:'dir',...,children:{}}` at the top level, so a
  // non-empty requirement would false-DENY a real snapshot. The crafted
  // empty-children pair stays in the forged-record class accepted by 2422e76a.
  if (!isStateObject(v.children)) return `'${where}' is a directory with no explicit 'children' object`;
  if (v.walk_budget_exceeded !== undefined && typeof v.walk_budget_exceeded !== 'string') {
    return `'${where}' carries a non-string 'walk_budget_exceeded' (${JSON.stringify(v.walk_budget_exceeded)})`;
  }
  const stray = strayFieldError(v, STATE_FIELDS.dir, where);
  if (stray) return stray;
  for (const k of ownKeys(v.children)) {
    if (!validateStateKey(cwd, k)) return `'${where}' carries a child key that is not a repo-relative path inside the project ('${k}')`;
    const bad = stateShapeError(cwd, v.children[k], k);
    if (bad) return bad;
  }
  return null;
}

// WHAT A STAMP CAN ATTEST (review finding 2). A stamp entry is only
// {path, sha256} or {path, deleted:true} (decision 4d9b76e8) — it structurally
// cannot express a MODE, a file TYPE, a symlink TARGET or the git INDEX entry.
// Decision 7021526c step 2 says the stamp is consulted against the CURRENT
// STATE, so a state difference the stamp cannot speak for falls to step 3 and
// DENIES without any consult: otherwise a chmod-only change, or a `git add`
// that moves only the index, or a regular file swapped for a symlink leaves the
// bytes identical, matches the stamp, and is wrongly allowed. Returns true only
// when the difference between the recorded and current state is confined to
// what a byte hash (or a {deleted:true} entry) can attest.
// v6.0: UNCALLED since the changed-pre-dirty stamp consult died with the restore
// branch (dc616f69 R11) — its recursion below is its only reference. Pure
// read-side predicate, retained one slice: S4 deletes the stamp apparatus whole
// (78dc9bd6), and this goes with it.
function stampCouldAttest(recorded, current) {
  if (!isStateObject(recorded) || !isStateObject(current)) return false;
  // RULING B / UNATTESTABLE (532a4383): a state the snapshot could not know is
  // not a difference a byte hash can speak for — same disposition the
  // walk_budget_exceeded marker already gets below, hoisted so it covers every
  // shape carrying a marker (a symlink today).
  if (recorded.unattestable || current.unattestable) return false;
  // BOARD fabf21d8: bytes that could not be attested are not a difference a BYTE
  // HASH can speak for — the marker must be NON-LAUNDERABLE through the stamp
  // exactly as `walk_budget_exceeded` is. Hoisted so it covers every shape the
  // marker can land on, and repeated on the file arm below (defense in depth).
  if (recorded.file_unattested || current.file_unattested) return false;
  if (recorded.index !== current.index) return false; // INDEX: unattestable
  if (!current.exists) return recorded.exists === true; // present -> absent: {path, deleted:true}
  if (!recorded.exists) return false; // absent -> present: an existence flip, unattestable
  if (recorded.type !== current.type) return false; // TYPE: unattestable
  if (recorded.mode !== current.mode) return false; // MODE: unattestable
  if (current.type === 'file') {
    if (recorded.file_unattested || current.file_unattested) return false; // defense in depth with the hoisted check above
    return true; // only the bytes can still differ
  }
  if (current.type === 'symlink') return false; // link TARGET: unattestable
  if (current.type === 'dir') {
    // An over-budget Pre walk (board 55fcccac) recorded NO children, so there
    // is no per-child difference for a stamp to speak for — unattestable, the
    // same disposition an added/removed child already gets below.
    if (recorded.walk_budget_exceeded || current.walk_budget_exceeded) return false;
    // A directory attests through its child FILES (stampAttestsDirectory walks
    // what is there NOW), so a child that was ADDED or REMOVED leaves nothing
    // for the walk to attest — fail closed on any change to the child key set,
    // and require every differing child to be bytes-only in the same sense.
    if (!isStateObject(recorded.children) || !isStateObject(current.children)) return false;
    const ak = ownKeys(recorded.children);
    const bk = ownKeys(current.children);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(current.children, k)) return false;
      const a = recorded.children[k];
      const b = current.children[k];
      if (sameState(a, b)) continue;
      if (!stampCouldAttest(a, b)) return false;
    }
    return true;
  }
  return false;
}

// Validate a per-call record key BEFORE the record is trusted: repo-relative
// POSIX only, no absolute path, no drive prefix, no NUL, no `..` traversal, and
// containment under the project root PROVEN by resolution. The record is not a
// restore source in this slice and must never become one by accident — same
// posture as validateBaselineKey (AC10), and the same reasoning: the audited
// agent can write arbitrary bytes into os.tmpdir(), so a crafted record is
// conduct, not environment.
function validateStateKey(cwd, key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  if (key.includes('\0')) return null;
  // POSIX: a literal '\' is a legal filename byte, NOT a separator — normalizing
  // it below would collapse two distinct paths (`a\b` and `a/b`) onto one key, so
  // a stored Pre-state record could re-key onto a colliding sibling and a Post
  // comparison read the wrong pre-image (silent tamper). Refuse fail-closed here;
  // Windows still normalizes below, where '\' really is the separator.
  // DEFENSE-IN-DEPTH, verified by reasoning not by an interface test (debugger
  // 2026-08-26): at HEAD the (A) collision is MASKED — a recorded backslash path
  // can't populate the normalized preState slot without also tripping the
  // fail-closed "no pre-state entry" throw, so both HEAD and fixed deny and no
  // red-on-HEAD/green-on-fixed pin is authorable. Kept anyway because these
  // records live in os.tmpdir() (attacker-writable) and a future refactor that
  // normalized preDirty, or softened that throw, would UNMASK a real silent-tamper
  // false-ALLOW; this reject survives it. PIN-B in
  // h17-backslash-non-injectivity.test.mjs carries the teeth for the (B)
  // collectBaseline throws; this key-validator does not.
  if (process.platform !== 'win32' && key.includes('\\')) return null;
  const fwd = key.replace(/\\/g, '/');
  if (fwd.startsWith('/') || /^[A-Za-z]:/.test(fwd)) return null; // absolute / drive prefix
  if (fwd.split('/').includes('..')) return null; // traversal
  const root = resolve(cwd);
  const abs = resolve(root, fwd);
  if (abs !== root && !abs.startsWith(root + sep)) return null; // containment
  return fwd;
}

// ANCESTOR-AWARE MEMBERSHIP in the recorded pre-dirty set (board 7dd39b85).
// `git status --porcelain` COLLAPSES an untracked directory into ONE entry
// (`?? hooks/newdir/`), so the recorded set holds `hooks/newdir` and never a
// single one of its children. An EXACT-match membership test therefore read a
// child that the audited command merely STAGED (`git add -A` gives the child
// its own `A  hooks/newdir/a.mjs` porcelain entry) as a write BY this command:
// it took the clean-at-Pre arm and — the child not being in HEAD — was DELETED,
// destroying the conductor's brand-new untracked enforcement file and blaming
// the agent for it. Coverage is computed HERE, per swept path, and deliberately
// NOT by expanding the recorded set into every child at Pre: that unbounded
// enumeration is the resource shape review finding 5 removed, and bringing it
// back would let a big dirty tree kill the guard OUTSIDE its own fail-closed
// control flow, where AC9 cannot reach it. Returns the recorded path COVERING
// `rel` (`rel` itself when it is recorded), or null when nothing covers it.
function coveringPreDirtyPath(preDirty, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  if (preDirty.has(rel)) return rel; // exact match first — today's test, unchanged
  // Only a well-formed repo-relative POSIX path may be climbed: '', '.', a
  // leading or trailing '/', or an empty segment would produce prefixes that
  // mean the REPO ROOT, and a "recorded root" would cover — i.e. exempt from
  // restore — every path in the tree. Refuse them rather than give them root
  // semantics. (`split('/').includes('')` catches all four at once.)
  if (rel === '.' || rel.split('/').includes('')) return null;
  // Walk up on '/' BOUNDARIES only. A bare `startsWith` is precisely the bug to
  // avoid: `hooks/newdir2/x` must NOT be covered by a recorded `hooks/newdir`.
  // `i > 0` so the loop can never manufacture '' (the repo root) as a candidate.
  for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) {
    const candidate = rel.slice(0, i);
    if (preDirty.has(candidate)) return candidate;
  }
  return null;
}

// The state RECORDED at Pre for a path covered by (but not equal to) a recorded
// pre-dirty ancestor. `pathState` keys a directory's `children` map by FULL
// repo-relative child paths at EVERY level (`${rel}/${name}`, see pathState),
// so this descends from the ancestor's recorded state along the successive path
// PREFIXES of `rel` — `hooks/newdir/sub`, then `hooks/newdir/sub/deep.mjs`.
// Returns the recorded state; returns null when the recorded children map has
// NO ENTRY for the path (the caller treats that as RECORDED-ABSENT, never as
// "this command created it"); THROWS when the recorded topology disagrees with
// the path being resolved — a non-directory node en route means the record
// cannot speak for this path at all, which is unverifiable -> AC9 fail-closed,
// the same posture as the record-disagreement throw in the sweep below.
function recordedDescendantState(ancestorState, ancestor, rel) {
  let node = ancestorState;
  let at = ancestor;
  let i = ancestor.length; // rel[i] is the '/' boundary right after the ancestor
  while (i < rel.length) {
    if (!isStateObject(node) || node.type !== 'dir' || !isStateObject(node.children)) {
      throw new Error(
        `per-call Pre-STATE record has '${at}' as a NON-DIRECTORY while resolving '${rel}' under the recorded pre-dirty path '${ancestor}' — ` +
          `the recorded topology and the swept path disagree, so this command's writes cannot be told from pre-existing ones`
      );
    }
    const next = rel.indexOf('/', i + 1);
    const childKey = next === -1 ? rel : rel.slice(0, next);
    // hasOwnProperty, never a bare `in` or a truthiness test: the record is
    // JSON-parsed agent-writable data, and an INHERITED entry must never
    // satisfy the lookup (finding 4(b), the same hazard the top-level Map
    // closes). An absent OWN entry returns null — a distinct outcome from a
    // recorded state, decided by the caller, never silently "unchanged".
    if (!Object.prototype.hasOwnProperty.call(node.children, childKey)) return null;
    node = node.children[childKey];
    at = childKey;
    i = next === -1 ? rel.length : next;
  }
  return node;
}

// What a path IS, WITHOUT ever following a link (review finding 3). 'absent' is
// kept distinct from 'error' so a stamped deletion attests only on a genuine
// ENOENT — an EACCES must never read as "gone, as attested".
function lstatKind(abs) {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isFile()) return 'file';
    if (st.isDirectory()) return 'dir';
    return 'other'; // fifo, socket, device: never attestable, never a directory
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'absent' : 'error';
  }
}

// LSTAT, not stat (review finding 3): a symlink is NEVER a directory for this
// purpose, so a link pointing at a directory can never route the stamp consult
// into a recursive walk outside the repo.
// SLICE 2: resolved through the pinned parent, so a linked ancestor can no
// longer re-aim the question at a directory outside the repo (it throws into the
// caller's fail-closed catch instead).
function isDirectoryAt(cwd, rel) {
  return lstatKindUnder(cwd, rel, `(A) directory classification of '${rel}'`) === 'dir';
}

// THE STAMP, READ EXACTLY ONCE PER SWEEP, as { kind, sha256, present, entries }.
// `entries` is null whenever the stamp cannot be used (absent, not a JSON array,
// unreadable/oversize, or — review finding 3 — not a REGULAR FILE: the stamp is
// classified by the open, so .sterling/transient/enforcement-stamp.json cannot be
// a symlink pointing the consult at bytes outside the repo). `present` keeps the
// message distinction between "no stamp at all" and "a stamp that attests
// nothing". SLICE 2: the stamp's own ancestors ('.sterling', 'transient') are
// pinned across the classify→read, so a '.sterling' swapped for a symlink cannot
// route the consult at a stamp outside the repo.
//
// ONE READ IS THE SECURITY PROPERTY, NOT AN OPTIMIZATION (S4 review, MEDIUM —
// a genuine TOCTOU). The first S4 shape hashed the stamp for the integrity
// witness and then let EVERY consult re-open and re-read the file. The audited
// command can BACKGROUND a child that outlives the command itself
// (`(sleep 0.3; cp forged <stamp>) &`), so a forgery landing AFTER the witness
// read but BEFORE a consult was invisible to the comparison and authoritative for
// the consult — the witness saw no change, `stampTrusted` stayed true, and the
// consults read the forged bytes. Reading once and serving every consult from
// these same in-memory bytes removes the window entirely: the bytes that are
// WITNESSED are, by construction, the identical bytes that are CONSULTED, because
// there is only ever one read of the file in a sweep.
// THE HASH IS COMPUTED FROM THE BYTES THIS READ RETURNED, never by a second
// streamed pass over the path — a separate hashing read would reintroduce the
// same window one level down.
// EVERY FAILURE IS A NON-'file' KIND, NEVER A THROW, so a caller can always
// compare one snapshot against another: an unreadable/oversize/unparseable stamp
// yields a stable kind with `entries: null`, which is unusable for attestation
// while still comparing equal to itself across a window (so it is never
// misreported as tampering). That costs an attacker nothing — a stamp this cannot
// read is a stamp no consult can read either, and it exempts nothing.
function readStampSnapshot(cwd) {
  try {
    return withPinnedParent(cwd, stampRel(), 'enforcement stamp', {}, (parentHandle, leaf) =>
      parentHandle === null ? { kind: 'absent', sha256: null, present: false, entries: null } : readStampAt(parentHandle, leaf)
    );
  } catch {
    // A non-directory/unresolvable ancestor threw. Unusable for attestation, and
    // stable across the window (both ends observe the same anomaly).
    return { kind: 'unwitnessable', sha256: null, present: false, entries: null };
  }
}

// THE STAMP'S OWN OBSERVABLE STATE, as a comparable witness (Ruling 2 of decision
// h17-ruling-d-needs-a-b-enumerating-stamp-producer-and-stamp-invalidation,
// fac9a69b). Until S4 the stamp path was protected by NOTHING: it is in neither
// the (A) ENFORCEMENT_SURFACE nor the (B) BASELINE_GLOBS, so an agent Bash command
// could write it freely and self-attest its own tamper. Pre records this witness
// and Post recomputes it; a DIFFERENCE across one call window is the attack.
// DELIBERATELY A HASH, NOT THE BYTES. The stamp lives in gitignored
// .sterling/transient/ where no gate bounds its size, so carrying its CONTENT in
// the per-call record would let an oversize stamp blow the record's own byte
// budget and turn every Post for that call into a false deny — a self-DoS on the
// guard. Only {kind, sha256} is retained, which is constant-size for any stamp.
// DERIVED FROM `readStampSnapshot`, never from a second pass over the path: the
// witness and the entries a sweep consults must come from ONE read, or a
// backgrounded child can substitute the file between them (see that function).
//
// ACCEPTED, DISCLOSED RESIDUAL — THE WITNESS RECORD IS ITSELF AGENT-WRITABLE.
// This detection rests on a record in os.tmpdir() (`stampWitnessFile`), under a
// name the audited command can compute and overwrite, exactly like the (B)
// content baseline and the (A) attribution/state records — and the (B) denial
// already says so in as many words ("these records live in os.tmpdir() and are
// writable by the audited command, so a crafted baseline is conduct, not
// environment"). An agent that rewrites its own witness to match a stamp it plans
// to counterfeit defeats this comparison. NOT FIXABLE HERE: hook and command run as the
// SAME UID with no privilege boundary between them (research_finding 79942bda),
// so there is no location this process can write that the command cannot. Named
// rather than silently implied, because a detection mechanism whose own input is
// attacker-writable must never be described as prevention. The residual is
// bounded by the same-UID assumption every other record in this file already
// carries, and by fail-closed handling everywhere else: a MISSING or CORRUPT
// witness yields no exemption at all rather than a false pass.
function stampWitness(cwd) {
  const snap = readStampSnapshot(cwd);
  return { kind: snap.kind, sha256: snap.sha256 };
}

// INVALIDATE the stamp by DELETING it (Ruling 2 of fac9a69b). This is what closes
// the TWO-CALL LAUNDERING BYPASS, and the bypass is the reason a bare in-window
// deny is not enough: call N writes ONLY a forged stamp and is denied, but the
// forged file SURVIVES; Pre of call N+1 then snapshots that forgery as its
// legitimate starting state, call N+1 changes a (B) file to the forged hash, the
// stamp does not move WITHIN N+1, and the modification is exempted. Once call N
// has ended, an agent-written stamp on disk is indistinguishable from a conductor
// stamp legitimately written between calls — so the denial must have a CROSS-CALL
// consequence or the next Pre becomes an adoption point.
// DELETION, NOT RESTORATION, and that is the ruling's choice rather than an
// omission: the stamp is explicitly TRANSIENT AND REPRODUCIBLE (H1 already deletes
// it at every SessionStart, P4), deleting forces deliberate re-attestation, and a
// restore-instead would reintroduce a WRITE PRIMITIVE AIMED AT A PROTECTED PATH —
// the exact class S4 deletes `writeUnder` to remove.
// PINNED, like every other resolution in this file: the unlink runs through the
// parent descriptor `withPinnedParent` holds, so a `.sterling` swapped for a
// symlink cannot re-aim it at a file outside the repository. `rmSync` never
// follows a symlink at the LEAF (it unlinks the link itself), so the leaf needs no
// separate guard. Best-effort by construction: it returns whether the stamp is
// gone, and a failure to remove it never changes the denial that is already owed.
function invalidateStamp(cwd) {
  try {
    return withPinnedParent(cwd, stampRel(), 'enforcement stamp invalidation', {}, (parentHandle, leaf) => {
      if (parentHandle === null) return true; // no '.sterling/transient' at all — nothing to invalidate
      rmSync(`${parentHandle}/${leaf}`, { force: true });
      return true;
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// THE ENFORCEMENT TAINT LATCH — born as the (B) SURFACE latch, decision
// b-surface-adoption-point-closes-with-an-incident-bound-taint-latch-not-a-
// persisted-manifest (bcd2cc09), RULINGS 7-11, refining fac9a69b and Ruling D
// of 532a4383. Since v6.0 (dc616f69 R15) the (A) sweep's in-window violations
// latch here too, through the same eager `latchOnDetection` producer path: with
// the restore deleted, their bytes also survive on disk, and the same
// next-Pre-adoption argument below applies to them verbatim (a clean-at-Pre
// violation left on disk is pre-existing dirt to the NEXT call's snapshot, and
// an unchanged pre-dirty path verifies by observation).
//
// WHAT IT CLOSES, stated here because a mechanism stripped of its reason gets
// re-opened: Pre re-collects the (B) baseline from CURRENT DISK STATE on every
// call (`collectBaseline` at the Pre arm below), so an unattested (B) change is
// denied EXACTLY ONCE — the bytes are deliberately LEFT ON DISK (fac9a69b) —
// and the NEXT call's Pre adopts those tampered bytes as its own legitimate
// baseline, sees no difference, and ALLOWS. Forever, silently. ONE DENIAL BOUGHT
// A PERMANENT EDIT TO LIVE ENFORCEMENT CONFIG, and `.claude/agents/**` IS the
// agent GRANT DEFINITIONS. The irony that names the bug: this file already
// applied exactly this reasoning to the STAMP (`invalidateStamp` above: "a
// denial with no cross-call consequence turns the next Pre into an adoption
// point") and never applied it to the SURFACE the stamp exists to protect.
//
// WHAT IS PERSISTED IS THE UNRESOLVED INCIDENT, NEVER A SOURCE OF TRUTH
// (RULING 2), AND THE ASYMMETRY IS THE WHOLE DESIGN. A persisted last-known-good
// (B) manifest — the conductor's own first proposal — would AUTHORIZE, so on a
// same-UID machine (research_finding 79942bda) it would have to be defended
// exactly like the stamp, reproducing the forgeable-plain-file problem it was
// meant to solve. THE LATCH AUTHORIZES NOTHING: forging it can only produce a
// LOUD DENIAL (a self-inflicted DoS), never a false allow. That is why PRESENCE
// ALONE IS THE VERDICT and why NO FIELD INSIDE THE FILE MAY REDUCE ENFORCEMENT
// (RULING 7) — no `cleared`, no `trusted`, no expiry, no session key, no boolean
// of any kind. The JSON body is DIAGNOSTIC ONLY and is parsed strictly AFTER
// presence has already decided the verdict.
//
// DELIBERATELY NOT IN `BASELINE_GLOBS` (RULING 7): the incident marker must not
// become part of the surface whose incident it records.
// DELIBERATELY NOT IN THE SQLITE STORE (RULING 7): the latch must be readable
// BEFORE this hook trusts the store, and `openStore()` returns null on an absent
// DB (lib/common.mjs:241) — so making the DB both the protected object AND the
// sole record that protecting it failed is circular. A hook writing the DB would
// also violate the MCP-only store-write rule and invariant 4, and SQLite is
// same-UID forgeable anyway.
// NOTHING HERE CLEARS IT (RULING 5, which overturned the conductor's own round-1
// answer as fatal): clearance is a SEPARATE, EXPLICIT conductor action that
// re-enumerates and re-hashes the whole (B) set. `scripts/enforcement-stamp.mjs`
// must NEVER clear it either — that hands a laundering route to a background
// child that outlives the audited Bash call (a threat this file already
// recognises at `readStampSnapshot`). There is no clearer in this file by design.
//
// THE PATHS ARE NAMED ONCE, and named by a FUNCTION rather than module-scope
// consts, for a mechanical reason: a top-level `const` WITH AN INITIALIZER in a
// blocking hook is a fail-closed-boundary finding (scripts/check-failclosed-
// boundary.mjs), and its ratchet only shrinks. Same disposition the other S3
// constants already took.
function taintLatchPaths() {
  return {
    sterlingDir: '.sterling',
    dbLeaf: 'sterling.db',
    leaf: 'enforcement-taint.json',
    rel: '.sterling/enforcement-taint.json',
    // The diagnostic body is bounded like every other record this hook reads
    // (board 55fcccac clause 4). It is never allowed to change a verdict, so the
    // bound can be small: an oversize or torn read simply yields no explanation.
    maxDiagnosticBytes: 64 * 1024,
  };
}

// RULING 11 — FAIL-CLOSED READ, DECIDED BY SHAPE BEFORE CONTENTS, classified
// through a PINNED PARENT. Returns `{ tainted, environmentDefect, reason }`.
//
// THE SHAPE TABLE, verbatim from the ruling:
//   * regular file at the latch path        -> TAINTED, regardless of contents
//   * symlink / directory / FIFO / device /
//     socket / unreadable / classify error  -> TAINTED (environment defect)
//   * absent leaf under a VERIFIED REAL
//     `.sterling` directory                 -> UNLATCHED
//   * `.sterling` itself a symlink, a
//     non-directory, or unreadable          -> FAIL CLOSED
//   * `.sterling` present but `sterling.db`
//     ABSENT                                -> BROKEN STATE, fail closed, and
//                                              NEVER worded "not a Sterling
//                                              project" — `.sterling` exists,
//                                              only the DB is missing.
//
// NAMED LIMIT, NOT SOLVED (the ruling requires this be disclosed rather than
// papered over): a WHOLLY ABSENT `.sterling/` cannot be mechanically told apart
// from a genuine non-Sterling project, because project discovery itself defines
// non-Sterling as "no ancestor containing .sterling/sterling.db"
// (lib/common.mjs:62). For H17's PER-AGENT invocation the disposition is FAIL
// CLOSED: this hook only ever runs from a spawned agent's frontmatter inside a
// Sterling project, so an absent `.sterling` here is broken state, not a
// neighbouring repository. A future GLOBAL `PreToolUse "*"` registration needs
// an explicit project-recognition rule, and this reader must not be claimed to
// supply one.
//
// THE PIN IS ACQUIRED BY WALKING, NEVER BY AN ABSOLUTE-PATH OPEN (anti-pattern
// descriptor-pin-defeated-at-acquisition-when-the-directory-fd-is-opened-by-
// absolute-path, severity BLOCK): `withClassifiedDir` -> `withPinnedParent`
// starts at the one retained root anchor and resolves `.sterling` THROUGH it,
// then both leaves are addressed as `<pinnedHandle>/<leaf>`. No pathname in this
// function is ever re-resolved from the root, and a prior lstat is never treated
// as though it still binds across a later open.
function readTaintLatch(cwd) {
  const P = taintLatchPaths();
  try {
    return withClassifiedDir(cwd, P.sterlingDir, (kind, dirHandle) => {
      if (kind === 'absent') {
        return {
          tainted: true,
          environmentDefect: true,
          reason:
            `'${P.sterlingDir}/' is absent, so the enforcement taint latch at '${P.rel}' cannot be read at all. This hook runs only from a spawned ` +
            `agent's frontmatter INSIDE a Sterling project, so an absent '${P.sterlingDir}/' here is broken state — and it is a NAMED, UNSOLVED LIMIT that ` +
            `it cannot be mechanically distinguished from a directory that was never a Sterling project (project discovery defines non-Sterling as "no ` +
            `ancestor holding ${P.sterlingDir}/${P.dbLeaf}"). Failing closed rather than guessing`,
        };
      }
      if (kind !== 'dir') {
        return {
          tainted: true,
          environmentDefect: true,
          reason:
            `'${P.sterlingDir}' is not a directory (kind: ${kind}) — the enforcement taint latch at '${P.rel}' cannot be classified through it. A symlink or ` +
            `other non-regular entry standing in for '${P.sterlingDir}' is denied on sight, never followed`,
        };
      }
      // BROKEN STATE, AND SPECIFICALLY NOT "not a Sterling project": the
      // directory the latch lives in exists, so the project IS one — only its
      // store is gone. Wording the two the same way would tell a human to ignore
      // a gate that is in fact reporting a damaged installation.
      const dbKind = lstatKind(`${dirHandle}/${P.dbLeaf}`);
      if (dbKind !== 'file') {
        return {
          tainted: true,
          environmentDefect: true,
          reason:
            `'${P.sterlingDir}/' exists but '${P.sterlingDir}/${P.dbLeaf}' is ${dbKind} — BROKEN STATE. The enforcement taint latch is read before this hook ` +
            `trusts the store precisely so a damaged store cannot silence it, and a half-present '${P.sterlingDir}/' is exactly the state in which the ` +
            `enforcement surface is least verifiable. Failing closed`,
        };
      }
      const h = classifyLeafAt(dirHandle, P.leaf);
      let primary;
      try {
        // ABSENT UNDER A VERIFIED REAL DIRECTORY IS THE ONLY UNLATCHED VERDICT.
        if (h.kind === 'absent') return { tainted: false, environmentDefect: false, reason: null };
        if (h.kind !== 'file') {
          return {
            tainted: true,
            environmentDefect: true,
            reason:
              `'${P.rel}' exists but is ${h.kind}, not a regular file — an abnormal shape at the latch path is TAINTED, exactly as a normal one is. ` +
              `H17 took no action on it: it was neither read through, replaced, nor removed`,
          };
        }
        // PRESENCE HAS NOW DECIDED. The body is read ONLY to enrich the
        // explanation, and every failure inside `taintLatchDiagnostic` yields
        // null — malformed content changes the EXPLANATION, never the DENIAL.
        const diagnostic = taintLatchDiagnostic(h, P);
        return {
          tainted: true,
          environmentDefect: false,
          reason: `'${P.rel}' is present${diagnostic ? ` (diagnostic body: ${diagnostic})` : ' (its body carries no readable diagnostic, which changes nothing)'}`,
        };
      } catch (e) {
        primary = e;
        throw e;
      } finally {
        closePinned(h.fd, primary);
      }
    });
  } catch (e) {
    // A CLASSIFICATION ERROR IS TAINTED, never "no latch". An unreadable leaf
    // (EACCES), an unresolvable ancestor, a walk refusal — every one of them is a
    // state in which this gate cannot establish that the surface is clean, and
    // "cannot establish" is fail-closed here (P5).
    return {
      tainted: true,
      environmentDefect: true,
      reason: `the enforcement taint latch at '${P.rel}' could not be classified (${(e && e.message) || e}) — an unclassifiable latch path is TAINTED, never "unlatched"`,
    };
  }
}

// The latch's diagnostic body, read THROUGH THE DESCRIPTOR IT WAS CLASSIFIED BY
// and strictly AFTER the verdict is already fixed. Returns a short clipped
// string, or null. It can only ever change the WORDING of a denial that is
// already owed — there is no path from this function to an allow, which is what
// makes "no field inside the file may reduce enforcement" (RULING 7) structural
// rather than a promise.
function taintLatchDiagnostic(h, P) {
  try {
    const bytes = readClassifiedBytes(h, P.maxDiagnosticBytes, 'enforcement taint latch', h.anchored);
    if (bytes.length === 0) return null;
    const parsed = JSON.parse(bytes.toString('utf8'));
    const text = JSON.stringify(parsed);
    return typeof text === 'string' ? text.slice(0, 400) : null;
  } catch {
    return null; // unreadable, oversize, torn, or unparseable — the verdict stands
  }
}

// RULING 8 — THE SET PRIMITIVE IS CREATE-ONLY, or latching becomes its own
// truncate primitive: the very class S1 removed from the producer and the S4
// slice removed from the (B) restore (`writeUnder`'s gravestone). ONE
// `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` open through a PINNED parent is the whole
// gate — there is no pre-open, no lstat screen and no truncate arm to reach, so
// a hardlink planted at the latch name resolves to EEXIST rather than to a write
// through a shared inode at a victim outside the repository.
// IF THE LEAF EXISTS IN ANY SHAPE THE LATCH IS ALREADY SET. EEXIST covers a
// regular file, a directory, a FIFO and a hardlink; ELOOP covers a symlink
// (O_NOFOLLOW refuses to follow it). Both mean "an object already stands at the
// incident marker's name", which is exactly what `readTaintLatch` calls TAINTED —
// so returning `set: true` here is not optimism, it is the same verdict the
// reader will reach.
// A CRASH AFTER CREATION BUT BEFORE THE BODY FINISHES leaves a partial file that
// still reads as PRESENT, hence still TAINTED: fail-safe by construction, which
// is why the write failure below is deliberately not an error.
// THE PIN IS ACQUIRED BY WALKING (`withPinnedParent` from the retained root
// anchor), never by `openSync` on an absolute pathname and never by
// `mkdirSync(abs, {recursive:true})` — see the BLOCK-severity anti-pattern cited
// at `readTaintLatch`.
function setTaintLatch(cwd, incidents) {
  const P = taintLatchPaths();
  try {
    const payload = Buffer.from(
      JSON.stringify(
        {
          // A NOTE, NOT A CONTROL. Nothing in this object is ever read back as
          // authority — `readTaintLatch` decides on PRESENCE and parses this
          // only to quote it.
          note: 'DIAGNOSTIC ONLY. Presence of this file is the verdict; no field in it can reduce enforcement, and H17 never clears it.',
          at: new Date().toISOString(),
          incident: incidents,
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    return withPinnedParent(cwd, P.rel, 'enforcement taint latch', {}, (parentHandle, leaf) => {
      if (parentHandle === null) {
        return { set: false, error: `'${P.sterlingDir}' is absent, so there is no pinned directory to create '${P.rel}' in` };
      }
      let fd = null;
      try {
        fd = openSync(`${parentHandle}/${leaf}`, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW | FS.O_NONBLOCK, 0o600);
      } catch (e) {
        const code = e && e.code;
        if (code === 'EEXIST' || code === 'ELOOP') return { set: true, error: null }; // already latched, in whatever shape
        return { set: false, error: `${code || 'error'} — ${(e && e.message) || e}` };
      }
      try {
        writeSync(fd, payload);
      } catch {
        /* the leaf EXISTS and therefore already reads as TAINTED; a missing body only costs the explanation */
      } finally {
        try {
          closeSync(fd);
        } catch {
          /* a leaked fd in a process that is about to exit(2) cannot change the verdict already owed */
        }
      }
      return { set: true, error: null };
    });
  } catch (e) {
    return { set: false, error: `${(e && e.message) || e}` };
  }
}

// THE GATE. RULING 10: THE LATCH ALWAYS WINS, WITH NO EXCEPTION — it is
// consulted before the store, before git, before the baseline and before the
// stamp, and a matching exact stamp is evidence that reconciliation MAY proceed,
// never proof that the outstanding incident was discharged. Called from BOTH
// arms, because Post is where the incident is detected and PRE is where the
// adoption used to happen: denying at Pre is what makes "the adoption point is
// closed" true rather than merely claimed.
// THE CONDUCTOR IS ALREADY EXEMPT — this hook short-circuits to `allow()` on an
// absent `agent_id` before either call site — which is what keeps the recovery
// path open: the conductor can run the producer and the reconciler while every
// spawned agent stays denied, and is never required to hand-edit the latch.
function denyIfTainted(cwd, agentId) {
  const P = taintLatchPaths();
  const verdict = readTaintLatch(cwd);
  if (!verdict.tainted) return;
  if (verdict.environmentDefect) {
    deny(
      environmentDefectDenial(
        'H17',
        `ENFORCEMENT TAINT LATCH — FAIL-CLOSED READ: ${verdict.reason}. The latch is decided by SHAPE before contents, and every abnormal shape is TAINTED ` +
          `(decision b-surface-adoption-point-closes-with-an-incident-bound-taint-latch-not-a-persisted-manifest, RULING 11). Nothing at '${P.rel}' was ` +
          `written, replaced or removed by this hook.`,
        { agentId }
      )
    );
  }
  // SCOPE STATED EXACTLY, NOT OVERSTATED (fd9d24af, security review). This used
  // to say "and so is every spawned-agent call", which is false today: H17 rides
  // the agent's OWN FRONTMATTER on Bash and is absent from hooks/hooks.json, so
  // while latched it denies spawned-agent BASH and not an agent's Edit, Write or
  // Task calls. The global PreToolUse '*' registration that would make the wider
  // claim true is a later slice and has not landed. A security surface that
  // claims a protection it does not implement is anti-pattern 586bccdc — the
  // false claim is worse than the gap, because it stops the next reader looking.
  deny(
    `H17: THE ENFORCEMENT SURFACE IS TAINTED — this tool call is DENIED BEFORE EXECUTION, and so is every spawned-agent BASH call that H17 gates ` +
      `(it is registered on Bash in agent frontmatter, not globally in hooks/hooks.json, so it does not gate an agent's Edit, Write or Task calls), ` +
      `until the taint is cleared by a conductor. ${verdict.reason}. An earlier audited command changed the protected (B) enforcement surface (\`.claude/agents/**\`, ` +
      `\`.claude/settings*.json\`, \`.sterling/config.json\`) with no conductor attestation, wrote the enforcement stamp inside its own window, or made an ` +
      `in-window write to tracked enforcement territory (an (A) audit incident, v6.0) — and the ` +
      `bytes were deliberately LEFT ON DISK. Without this latch the very next PreToolUse would re-collect those tampered bytes as its own legitimate ` +
      `baseline and allow them forever — one denial would buy a permanent edit to the agent GRANT DEFINITIONS. PRESENCE OF THE LATCH IS THE VERDICT: no ` +
      `field inside it can reduce enforcement, and H17 never clears it. IT IS NOT YOURS TO CLEAR AND NOT YOURS TO DIAGNOSE — exit \`blocked\`, citing this ` +
      `message VERBATIM. A CONDUCTOR clears it with a deliberate reconciliation that re-verifies the current enforcement surface, ` +
      `and only then removes '${P.rel}'. Re-running the command will not help; routing around it is never sanctioned.`
  );
}

// SLICE 2 (review finding B): CLASSIFIED BY THE OPEN, not by an lstat followed
// by a reopen of the same name. The pair this replaces left a window in which a
// racer could swap one regular file for another between the classification and
// the read, so bytes were attested that had never been classified. Now the
// descriptor that answered "is this a regular file?" is the descriptor the JSON
// is read from.
function readStampAt(parentHandle, leaf) {
  const stampPath = `${parentHandle}/${leaf}`;
  const h = classifyLeafAt(parentHandle, leaf);
  let primary;
  try {
    if (h.kind !== 'file') return { kind: h.kind, sha256: null, present: h.kind !== 'absent', entries: null };
    return readStampFromFd(h, stampPath);
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    closePinned(h.fd, primary);
  }
}

function readStampFromFd(h, stampPath) {
  // BOUNDED (board 55fcccac clause 4): the stamp lives in gitignored
  // .sterling/transient/, which no gate protects, so an oversize file there
  // could OOM the readFileSync+JSON.parse this replaces — killing the guard
  // outside its own control flow. Size-prechecked and refused before
  // allocation; the throw joins the parse error's existing route (every caller
  // catches it and treats the stamp as attesting NOTHING). That is what makes
  // an unreadable stamp fail closed exactly WHERE IT MATTERS and nowhere else:
  // "no attestation available" only bites on a path that needs attestation, so
  // a garbage stamp for a window with nothing to attest changes no verdict.
  // THE READ, THE WITNESS HASH AND THE PARSE ALL COME FROM ONE `bytes` BUFFER
  // (S4 review, TOCTOU fix): hashing the path a second time — or re-reading it at
  // consult time — would let a backgrounded child substitute the file between the
  // two observations. There is exactly one read, so witnessed bytes and consulted
  // bytes cannot differ.
  // A READ FAILURE (oversize, torn, EACCES) IS A KIND, NOT A THROW, so the caller
  // can still compare this snapshot against the Pre witness; a PARSE failure or a
  // non-array shape leaves `entries` null while the witness hash stays real, so an
  // unparseable stamp is still detected if it CHANGES mid-window.
  let bytes;
  try {
    bytes = readClassifiedBytes(h, MAX_STAMP_BYTES, 'enforcement stamp', stampPath);
  } catch {
    return { kind: 'unreadable', sha256: null, present: true, entries: null };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let parsed = null;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { kind: 'file', sha256, present: true, entries: null };
  }
  return { kind: 'file', sha256, present: true, entries: Array.isArray(parsed) ? parsed : null };
}

// Read a leaf's bytes THROUGH THE DESCRIPTOR IT WAS CLASSIFIED BY. On Linux that
// descriptor is the object itself, so classify→read is one resolution, not two.
// On win32 there is no such descriptor (the leaf was classified by lstat), so the
// read goes through `openLeafNoFollow`'s identity-verified open — detection, not
// prevention, the disclosed envelope of 2a69a8d7. Mirrors `hashClassifiedLeaf`.
function readClassifiedBytes(h, maxBytes, what, label) {
  if (h.fd !== null) return readBoundedFromFd(h.fd, maxBytes, what, label);
  return readBoundedBuffer(h.anchored, maxBytes, what);
}

// One path's CURRENT bytes hashed for a stamp comparison — only ever for a
// REGULAR FILE (review finding 3). Returns null for anything else, so the
// consult can never hash THROUGH a symlink: the attack that closes is replacing
// a stamped enforcement file with a link to an out-of-repo file holding the
// stamped bytes, which the hook loader would then execute from outside every
// sweep's reach.
// STREAMED (board 55fcccac clause 1): constant memory, no size cap — a stamped
// enforcement file of any size is hashable without the guard's heap tracking
// it.
// SLICE 2: addressed by (cwd, rel) and resolved through a PINNED parent, and the
// classification is the OPEN itself — so the bytes hashed are the bytes of the
// object that was classified, not of whatever a racer put under the name
// afterwards. Returns null for anything that is not a regular file.
function sha256OfRegularFile(cwd, rel, what = `stamp attestation of '${rel}'`) {
  return withPinnedParent(cwd, rel, what, {}, (parentHandle, leaf) => {
    if (parentHandle === null) return null;
    const h = classifyLeafAt(parentHandle, leaf);
    let primary;
    try {
      if (h.kind !== 'file') return null;
      return hashClassifiedLeaf(h, rel);
    } catch (e) {
      primary = e;
      throw e;
    } finally {
      closePinned(h.fd, primary);
    }
  });
}

// (`toRel(cwd, abs)` used to live here. It existed because collectBaseline built
// ABSOLUTE child paths and then derived the (B) record's key back from them.
// Slice 2's walk carries the repo-relative path down the recursion directly —
// there is no absolute path to convert back, and one fewer place where a '\'
// could collapse into the key.)

// Classify EVERY path COMPONENT of a (B)-relative path, from the repo root
// down, by lstat — before any read, walk, or write touches it (board 8b53dc84,
// round 2 outside-family review). Checking only the final joined path (or only
// the entries a readdirSync happens to enumerate) is NOT enough: path
// resolution still FOLLOWS an INTERMEDIATE symlink component when the OS
// resolves the rest of the string — lstat refuses to follow only the LAST
// component. A `.sterling` replaced by a symlink to an outside directory still
// let `.sterling/config.json` resolve THROUGH it, on both the read and the
// restore write, when only the final component was ever lstat-checked.
// This walks segment-by-segment, extending the path ONLY after the PRIOR
// segment is confirmed a real directory (never a symlink): by induction, every
// path this function ever hands to lstat has zero symlinks in its
// already-verified prefix, so the OS cannot follow one on the way to the
// segment being checked. `cwd` (the repo root) is the TRUST ANCHOR and is
// never itself lstat'd — the walk starts at its first-level children.
// Returns the FINAL segment's lstat kind ('file' | 'dir' | 'absent'); throws
// on the first symlink or other non-regular kind found at ANY component,
// intermediate or final — so a directory is always classified BEFORE it is
// walked or listed, never interleaved with the walk itself.
// `what` names the surface in the refusal so one walk can serve the (B) read,
// the (B) restore write and the (A) tracked restore without three copies of the
// most security-critical loop in this hook. (It also served the (B) DELETE arm
// until the 2026-08-27 ruling deleted that arm — see the `removeUnder`
// gravestone; no caller of this walk deletes an unexpected addition any more.)
//
// SLICE 1 (decision 532a4383) MOVED THIS WALK ONTO THE SECURE-I/O LAYER. The
// induction above ("every path handed to lstat has zero symlinks in its
// verified prefix") was only ever true AT THE INSTANT each lstat ran: the walk
// re-resolved the whole path STRING from the root on every component, so a
// swap landing between component i and component i+1 re-aimed everything after
// it (board 6c1e0890, the check/use TOCTOU this layer closes). On LINUX the
// walk now carries a PINNED DIRECTORY DESCRIPTOR: each component is resolved
// as /proc/self/fd/<parentFd>/<name>, so the prefix cannot be re-aimed once
// pinned — a swapped ancestor changes what the NAME means, not what the
// descriptor IS. On NATIVE WINDOWS the walk stays path-addressed exactly as
// before (Node cannot hold a directory descriptor there; Fork 2 of f2bc631f,
// option (b)) — a DISCLOSED weaker ancestor guarantee, not a silent one.
// SLICE 2 folded this onto `withPinnedParent`, the ONE walk every secure
// operation now shares. Two things changed and nothing else did: the root anchor
// is the invocation's single retained descriptor rather than a fresh open-and-
// close per classifier (each reopen was another pathname resolution of the root),
// and the native-Windows arm — formerly a duplicated path-addressed loop — is
// now the same walk with a path-shaped handle. The win32 guarantee is unchanged
// and still disclosed: detection at the leaf, best-effort above it, because pure
// Node on Windows offers no descriptor to pin against a racing ancestor swap
// (2a69a8d7).
function classifyPathComponents(cwd, rel, what = '(B) baseline') {
  return withPinnedParent(cwd, rel, what, {}, (parentHandle, leaf) => (parentHandle === null ? 'absent' : lstatKind(`${parentHandle}/${leaf}`)));
}

// THE ANCESTOR GUARD EVERY WRITE, CREATE, DELETE AND RESTORE PRIMITIVE TAKES
// FIRST (board 128fedb7). Guarding the FINAL component is not enough when a
// PARENT can be a link: `mkdirSync(dirname(abs), {recursive:true})` traverses
// every ancestor, `rmSync(abs, {recursive:true})` resolves the whole string
// before it starts deleting, and `git checkout HEAD -- <rel>` writes wherever
// the resolved path lands — so a symlink planted at `.claude`, `.sterling`, or
// any directory inside a normal `hooks/`/`.claude/agents` tree re-aims the
// primitive OUTSIDE the repository even when the leaf lstat is clean.
// THE DISPOSITION IS THE SETTLED CHEAP ONE, not descriptor-based no-follow I/O:
// on ANY type ambiguity in the ancestor chain this THROWS, which reaches the
// caller's fail-closed catch and DENIES WITHOUT RESTORING — the same answer the
// (A) side already settled on for attribution ambiguity (decision
// h17-coverage-is-ancestor-aware-and-an-ambiguous-descendant-denies-without-
// restoring): removing the write from the ambiguous case entirely rather than
// trying to make it safe. SLICE 1 (532a4383) hardened the CLASSIFICATION this
// calls — on Linux the component walk is descriptor-anchored, so the ancestor
// chain can no longer be re-aimed DURING the walk.
//
// SLICE 2 RETIRED MOST OF THIS FUNCTION'S CALLERS, and that is the point: a
// classify-then-act pair is not atomic however good the classification is, so
// the (B) write, the (B) delete, the (A) state snapshot and the untracked-restore
// delete all moved onto `withPinnedParent`, which keeps the parent descriptor
// HELD while the operation runs. ONE caller remained — restoreTracked's in-HEAD
// arm, which shelled out to `git checkout HEAD -- <rel>`, where git resolved the
// path itself in another process and classification was the only guard available.
// SLICE 3 CLOSED THAT (Ruling A): the in-HEAD arm materialized the HEAD blob
// through `withPinnedParent` too, so its containment became STRUCTURAL.
// v6.0 (2026-08-30): the restore itself is now DELETED (dc616f69), which took
// this function's LAST caller with it. It is retained UNCALLED, deliberately:
// S4 (the tripwire + minimal (B) hash-list slice, 78dc9bd6) owns the judgment on
// how much of the shared descriptor-pinning depth a detect-only tripwire still
// needs, and deleting it here would pre-empt that adjudicated boundary. A pure
// read-side refusal helper, it can aim nothing — keeping it dormant one slice
// is not the "dormant destructive helper" dc616f69 R17 forbids.
// Returns the IMMEDIATE PARENT's own kind ('dir' when it is already there,
// 'absent' when the primitive may create it fresh — nothing to follow yet);
// throws on anything else, and on the first non-directory component above it.
function assertRealAncestors(cwd, rel, what) {
  const segments = rel.replace(/\/+$/, '').split('/');
  const ancestorRel = segments.slice(0, -1).join('/');
  if (!ancestorRel) return 'dir'; // a repo-root child: the root is the trust anchor, never lstat'd
  const kind = classifyPathComponents(cwd, ancestorRel, what);
  if (kind !== 'dir' && kind !== 'absent') {
    throw new Error(
      `${what}: refusing to act on '${rel}' — its ancestor '${ancestorRel}' is not a directory (lstat kind: ${kind}); a symlink or other ` +
        `non-regular ancestor is never created through, written through, deleted through or restored through`
    );
  }
  return kind;
}

// Snapshot every existing (B)-set file as { repoRelPath -> raw bytes, base64 }.
// LSTAT-GUARDED AT EVERY LEVEL, ancestors included (board 8b53dc84): the old
// walk used existsSync/statSync/readFileSync, which all FOLLOW a symlink — a
// symlink planted at a (B) path was read through at Pre (baseline capture
// out-of-repo content as the file's own) and a symlink to a DIRECTORY under
// .claude/agents/** was walked into (readdirSync/statSync following it),
// enumerating a tree outside the repository. This function is called from
// BOTH Pre (whose caller denies immediately on throw, PHASE: PRE — a
// non-regular (B) path predates the command and is an environment defect)
// and Post-as-"current" (whose throw reaches the same fail-closed catch
// BEFORE any restore write is attempted, PHASE: POST — a kind transition
// across the window is conduct) — one code path governs both instead of two
// guards that could drift apart. `classifyPathComponents` is consulted for
// EVERY (B) surface root — '.claude/agents', '.claude', '.sterling/config.json'
// — BEFORE that root is walked or listed (round-2 finding: '.claude/agents'
// must never be walked before '.claude' itself is classified). Descendants
// beneath an already-classified root are still classified per-entry via
// readdirSync's Dirent (which reflects the entry's own lstat kind, never a
// symlink target's), so a symlink is denied on sight and never opened at any
// depth. Bytes are stored as base64 of the RAW file bytes (never a decoded
// utf8 string): two different invalid-UTF-8 sequences can decode to the same
// U+FFFD text, so a string snapshot is lossy exactly where tampering hides.
// SLICE 2: every level of this walk now runs against a PINNED DIRECTORY
// DESCRIPTOR. The Slice 1 shape classified a root, released it, and then
// re-resolved `join(cwd, ...)` for the readdir and again for each file's
// readFileSync — three separate pathname resolutions of a chain that had been
// verified once. The recursion reached its children the same way. Now the
// classification hands the walk the descriptor it classified (`dirHandleOf`),
// every child directory is pinned with O_NOFOLLOW before it is listed, and every
// file's bytes are read through the pinned parent. The belt-and-suspenders
// per-recursion re-lstat that Slice 1 added to SHRINK that window is gone with
// the window itself — on Linux there is nothing left to re-check, because the
// descriptor IS the directory; on win32 (no descriptors, disclosed detection-only
// arm) the re-lstat is kept exactly as it was.
function collectBaseline(cwd) {
  const map = {};
  const walkDir = (dirHandle, relDir) => {
    if (IS_WIN32) {
      // WIN32 ONLY: the handle is a path, so the Slice 1 narrowing still applies.
      const kind = lstatKind(dirHandle);
      if (kind === 'absent') return; // raced away between classification and here — nothing to snapshot, not a violation
      if (kind !== 'dir') {
        throw new Error(
          `(B) baseline path '${relDir}' is not a directory (lstat kind: ${kind}) — refusing to read through it; a symlink or other non-regular ` +
            `entry standing in for a (B) directory is denied on sight, never followed`
        );
      }
    }
    for (const de of readdirSync(dirHandle, { withFileTypes: true })) {
      // POSIX non-injectivity guard (files AND directories), BEFORE join/rel/
      // recursion: a literal backslash in de.name is a legal POSIX filename byte
      // but collapses to '/' when toRel keys the (B) content map below, so
      // `.claude/agents/a\b.md` and `.claude/agents/a/b.md` would share one key —
      // last readdir wins the slot and a tampered file compares "unchanged"
      // against its colliding sibling. Refuse fail-closed; never normalized. A
      // backslash-bearing directory is refused too, or its name would propagate
      // through relDir into every descendant key.
      if (process.platform !== 'win32' && de.name.includes('\\')) {
        throw new Error(
          `(B) baseline entry '${relDir ? relDir + '/' : ''}${de.name}' contains a backslash — refused on POSIX: '\\' is a legal filename byte here but collapses to '/' in the authorization key, so a distinct sibling would share one key and a restore could land on the wrong path; denied fail-closed, never normalized`
        );
      }
      const rel = relDir ? `${relDir}/${de.name}` : de.name;
      if (de.isSymbolicLink()) {
        throw new Error(
          `(B) baseline path '${rel}' is a symlink — refusing to read through it (it may point outside the repository); denied on sight, never followed`
        );
      }
      if (de.isDirectory()) {
        // Pinned with O_NOFOLLOW: a child swapped for a symlink between this
        // Dirent and the open FAILS (ELOOP) rather than being descended into.
        withPinnedDir(`${dirHandle}/${de.name}`, (childHandle) => walkDir(childHandle, rel));
      } else if (de.isFile()) {
        map[rel] = readBaselineBytesAt(dirHandle, de.name, rel);
      } else {
        throw new Error(`(B) baseline path '${rel}' is not a regular file or directory (unsupported type) — refusing to read it`);
      }
    }
  };

  // .claude/agents/** (recursive) — '.claude' AND '.claude/agents' are BOTH
  // classified, component by component, BEFORE any readdirSync ever touches
  // either of them (round-2 finding (b): walking 'agents' before classifying
  // '.claude' let an out-of-repo traversal happen before the denial). SLICE 2:
  // the classification now HANDS the walk the descriptor it classified, instead
  // of naming a path for the walk to resolve again.
  withClassifiedDir(cwd, '.claude/agents', (kind, dirHandle) => {
    if (kind === 'dir') walkDir(dirHandle, '.claude/agents');
    else if (kind !== 'absent') throw new Error(`'.claude/agents' is not a directory (lstat kind: ${kind}) — refusing to read/walk through it; denied on sight, never followed`);
  });

  // .claude/settings*.json (top level only) — '.claude' classified before it
  // is listed.
  withClassifiedDir(cwd, '.claude', (claudeKind, claudeHandle) => {
    if (claudeKind !== 'dir') {
      if (claudeKind !== 'absent') throw new Error(`'.claude' is not a directory (lstat kind: ${claudeKind}) — refusing to read the (B) baseline surface through it`);
      return;
    }
    for (const de of readdirSync(claudeHandle, { withFileTypes: true })) {
      const rel = '.claude/' + de.name;
      // matchesGlob normalizes '\'->'/' internally, so a POSIX settings-shaped
      // name carrying a backslash (`settings\evil.json`) would be rewritten to
      // `settings/evil.json`, FAIL the glob, and be silently skipped from the
      // baseline — leaving tampering on it invisible to both Pre and Post. de.name
      // is a single path component, so the case-sensitive `settings*.json` shape
      // is exactly startsWith('settings') && endsWith('.json'); refuse it
      // fail-closed BEFORE the normalizing glob can hide it.
      if (
        process.platform !== 'win32' &&
        de.name.includes('\\') &&
        de.name.startsWith('settings') &&
        de.name.endsWith('.json')
      ) {
        throw new Error(
          `(B) baseline settings entry '${rel}' contains a backslash — refused on POSIX: matchesGlob would normalize '\\'->'/' and silently skip this settings-shaped file from the baseline, leaving tampering on it invisible; denied fail-closed`
        );
      }
      if (!matchesGlob(rel, '.claude/settings*.json')) continue;
      if (!de.isFile()) {
        throw new Error(
          `(B) baseline path '${rel}' is not a regular file (lstat kind: ${de.isSymbolicLink() ? 'symlink' : 'other'}) — refusing to read through it; ` +
            `denied on sight, never followed`
        );
      }
      map[rel] = readBaselineBytesAt(claudeHandle, de.name, rel);
    }
  });

  // .sterling/config.json — every component ('.sterling' AND 'config.json')
  // classified before the file is read (round-2 finding (a): a '.sterling'
  // symlink to an outside directory previously resolved straight through to
  // whatever 'config.json' sat there).
  const cfgRel = '.sterling/config.json';
  withPinnedParent(cwd, cfgRel, '(B) baseline', {}, (parentHandle, leaf) => {
    if (parentHandle === null) return; // '.sterling' absent — nothing to snapshot
    // SLICE 2 (review finding B): classify by OPENING, then read from that same
    // descriptor — the lstat-then-reopen pair this replaces left a window in
    // which one regular file could be exchanged for another under the name.
    const h = classifyLeafAt(parentHandle, leaf);
    let primary;
    try {
      if (h.kind === 'absent') return;
      if (h.kind !== 'file') {
        throw new Error(`(B) baseline path '${cfgRel}' is not a regular file (lstat kind: ${h.kind}) — refusing to read through it; denied on sight, never followed`);
      }
      map[cfgRel] = readClassifiedBytes(h, Number.POSITIVE_INFINITY, `(B) baseline path '${cfgRel}'`, h.anchored).toString('base64');
    } catch (e) {
      primary = e;
      throw e;
    } finally {
      closePinned(h.fd, primary);
    }
  });
  return map;
}

// Read one (B) file's RAW bytes through its PINNED parent, base64-encoded for
// the record. Replaces `readFileSync(join(cwd, rel))`, which re-resolved the
// whole chain the classification had just verified. `openLeafNoFollow` inside
// the bounded reader refuses a symlink at the leaf (ELOOP on Linux; identity
// verification on win32) and the exact-size / re-fstat discipline refuses a file
// swapped or truncated under the gate.
// NO SIZE CAP HERE, deliberately: the aggregate (B) record is already bounded
// where that bound belongs (Pre refuses to write an over-budget baseline, and
// Post refuses to read one), and a per-file cap invented here could only add a
// new false-deny class to a surface that never had one.
// SLICE 2 (review finding B): CLASSIFIED BY THE OPEN. The Dirent that got us
// here reflects the entry's kind at the moment the directory was READ, and the
// read that follows is a second resolution of the same NAME — so a racer could
// swap one regular file for another in between and have bytes recorded into the
// baseline that were never classified. The open IS the classification now: the
// descriptor that proves "regular file" is the descriptor the bytes come from.
// The kind check is therefore authoritative rather than advisory, and the Dirent
// is only a cheap pre-filter.
function readBaselineBytesAt(parentHandle, leaf, rel) {
  const h = classifyLeafAt(parentHandle, leaf);
  let primary;
  try {
    if (h.kind !== 'file') {
      throw new Error(
        `(B) baseline path '${rel}' is not a regular file (kind: ${h.kind}) — refusing to read it; a symlink or other non-regular entry standing where ` +
          `the baseline walk saw a file is denied on sight, never followed`
      );
    }
    return readClassifiedBytes(h, Number.POSITIVE_INFINITY, `(B) baseline path '${rel}'`, h.anchored).toString('base64');
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    closePinned(h.fd, primary);
  }
}

// Classify a (B) SURFACE ROOT and hand its walk the descriptor that
// classification opened — never a path for the walk to resolve again. The
// callback receives (kind, dirHandle); `dirHandle` is null for anything that is
// not a directory.
function withClassifiedDir(cwd, rel, fn) {
  return withPinnedParent(cwd, rel, '(B) baseline', {}, (parentHandle, leaf) => {
    if (parentHandle === null) return fn('absent', null);
    const h = classifyLeafAt(parentHandle, leaf);
    let primary;
    try {
      return fn(h.kind, h.kind === 'dir' ? dirHandleOf(h) : null);
    } catch (e) {
      primary = e;
      throw e;
    } finally {
      closePinned(h.fd, primary);
    }
  });
}

// Validate a baseline key: repo-relative POSIX + matches a (B) glob; reject
// traversal / absolute. Returns the normalized rel or null (a bad key → no write).
function validateBaselineKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  // POSIX: '\' is a legal filename byte, not a separator — normalizing it below
  // would collapse distinct paths onto one baseline key (same non-injectivity as
  // validateStateKey). Refuse fail-closed; Windows keeps normalizing below.
  // DEFENSE-IN-DEPTH, reasoning-verified not interface-tested: on the COLLECTED
  // (B) flow toRel collapses '\' before this validator ever runs, so this guards
  // only a hand-crafted stored baseline record (also os.tmpdir()-writable). The
  // collected flow's teeth live in the collectBaseline readdir throw (PIN-B); this
  // reject is the fail-closed backstop for the crafted-record path.
  if (process.platform !== 'win32' && key.includes('\\')) return null;
  const fwd = key.replace(/\\/g, '/');
  if (fwd.startsWith('/') || /^[A-Za-z]:/.test(fwd)) return null; // absolute
  if (fwd.split('/').includes('..')) return null; // traversal
  if (!BASELINE_GLOBS.some((g) => matchesGlob(fwd, g))) return null;
  return fwd;
}

// GRAVESTONE — `writeUnder(cwd, rel, content)` WAS the (B) sweep's RESTORE
// primitive: the modify arm called it to put a changed (B) file's pre-image bytes
// back, and the delete arm called it to recreate a (B) file that had vanished.
// DELETED 2026-08-29 by RULING D of decision h17-baseline-integrity-redesign-
// rulings-abcd (532a4383), as refined by h17-ruling-d-needs-a-b-enumerating-stamp-
// producer-and-stamp-invalidation (fac9a69b): the (B) surface moved to
// DETECT-AND-DENY, so a changed (B) path is DENIED and LEFT EXACTLY AS THE COMMAND
// LEFT IT.
// WHY, kept here because the reason IS the ruling and a ruling stripped of its
// justification gets re-opened:
//   (1) THE HARDLINK CLOBBER. This primitive wrote through `writeRegularAt`'s
//       truncate-in-place arm, and truncate-in-place does not care how many names
//       an object has. A (B) path replaced by a HARDLINK to a file OUTSIDE the
//       repository made the "restore" write baseline bytes straight through the
//       shared inode onto that outside file. Descriptor pinning cannot close it:
//       the whole S1–S3 threat model is about NAME RESOLUTION, and pinning
//       constrains which NAME resolves to which object while saying nothing about
//       how many names an object has. REPRODUCED LIVE, not reasoned — the S4 red
//       bar caught the victim's bytes coming back as the restored baseline content.
//   (2) THE PRE-IMAGE IS NOT A TRUSTWORTHY SOURCE. The (A) restore is justified by
//       an asymmetry that does NOT hold here: (A) reverts to HEAD, which git can
//       always hand back, whereas the (B) pre-image lives only in an os.tmpdir()
//       record that the audited command can itself write. Restoring from it makes
//       the guard a writer of attacker-influenceable bytes.
// STRUCTURAL, NOT ADVISORY: the function is GONE, not merely uncalled, so the (B)
// stage now holds NO write primitive and NO delete primitive at all — there is
// nothing left in that scope for a future edit to re-aim, and no comment standing
// in for a guard (anti-pattern 586bccdc). Its two callers were the modify and
// delete arms it served, and both are now `noteBaselineDenied(rel)` (which
// records the finding and latches; it is the ONLY writer of `baselineDenied`).
// `writeRegularAt` survived this ruling for its one legitimate (A) caller — the
// read-blob restore of a TRACKED path. v6.0 (2026-08-30) then deleted the (A)
// restore itself (dc616f69), and `writeRegularAt` went with it: the WHOLE FILE
// now holds no write primitive, not just the (B) stage.
// SABOTAGE TABLE for this ruling (specified, never run in-place — mutation runs are
// conductor-only, decision 02e03ed8, and in-place mutation of scripts/hooks/** is
// anti-pattern 37b3cb0a):
//   S1: restore `writeUnder` and call it where `noteBaselineDenied(rel)` now sits.
//       REAL CARRIER: the BYTE-IDENTITY assertions in AC1/AC6-DENY of
//       scripts/tests/h17-b-detect-and-deny.test.mjs (`deepEqual(readFileSync(coder),
//       newBytes)`). NOT the exit code — the same trap the `removeUnder` gravestone
//       records: the old code restored FIRST and denied (exit 2) anyway, so an
//       exit-code assertion stays GREEN while the disk outcome is inverted.
//   S2: recreate a DELETED (B) path from the Pre baseline. CARRIER: AC2's
//       `existsSync(coder) === false`, which `assert.equal(r.code, 2)` cannot see.
//   S3: push (B) modify/delete findings back into `violations`. CARRIER: AC3's
//       `doesNotMatch(/reverted|rolled\s*back/i)` — the `violations` wording claims
//       a rollback that no longer happens.
//   S4: drop the disposition wording from the (B) denial (generic "denied").
//       CARRIER: AC3's `match(/left (in place|on disk|untouched|as[- ]is)/i)`.
//   S5: drop `baselineDenied.length` from the deny condition below. CARRIER: the
//       exit-code assertions — this is the ONE sabotage here the exit code does
//       catch, because it is the one that stops the denial firing at all.
//   S6: keep the restore but unlink-and-recreate instead of truncating in place.
//       CARRIER: AC11's shared-inode + `nlink >= 2` assertions — the victim's bytes
//       survive, so the byte assertions alone would stay green, and only the link
//       relationship reveals that H17 still took a write action.

// GRAVESTONE — `removeUnder(cwd, rel)` WAS the (B) sweep's DELETE primitive
// (board 128fedb7 site 2): the addition arm called it on every live (B) file
// absent from the Pre baseline, so an unexpected file in protected territory was
// unlinked and then denied. DELETED 2026-08-27 by user ruling: an unexpected
// ADDITION is DENIED and REPORTED, and the FILE SURVIVES ON DISK.
// WHY, kept here because the reason is the ruling and a ruling stripped of its
// justification gets re-opened: deleting is IRREVERSIBLE, and H17 cannot
// distinguish a malicious plant from a legitimate file the conductor just
// created. The sweep is a DETECTOR, and a detector that deletes can destroy real
// work on a single false positive. ACCEPTED COST, stated so nobody "fixes" it
// back: a real plant stays on disk until a human takes it off — the denial keeps
// firing meanwhile, so the plant buys the attacker nothing but a red gate.
// STRUCTURAL, NOT ADVISORY: the function is GONE, not merely uncalled, and so is
// its only helper `removeFileAt` (gravestone at its old site above). The (B)
// addition path therefore holds NO delete primitive at all — there is nothing
// for a future edit to re-aim, and no comment standing in for a guard
// (anti-pattern 586bccdc: a security surface must never claim a protection that
// only prose implements). The one delete primitive that remained after this
// ruling — `removeTreeAt`, reachable only from `restoreTracked`'s NOT-IN-HEAD
// arm — was itself deleted with the restore family in v6.0 (dc616f69): the file
// now holds no delete primitive anywhere.
// AND THAT WAS NOT ENOUGH — read this before trusting the paragraph above (v4.1,
// 2026-08-27, outside-family review, CONFIRMED). Removing the (B) arm's delete
// closed the (B) ROUTE to the (B) surface; it left the (A) ROUTE open. A (B) file
// `git add -f`'d into the index is reported by `git status` as an ADDITION, is an
// (A) violation by `isEnforcementSurface`, is NOT IN HEAD, and so was DELETED by
// `restoreTracked`'s not-in-HEAD arm — while the (B) collection, which runs after
// the entire (A) sweep, never saw it and never emitted the "left on disk"
// disposition. THE PROTECTION IS A PROPERTY OF THE PATH, NOT OF THE SURFACE THAT
// NOTICED IT. Both `restoreTracked`'s not-in-HEAD arm and `removeTreeAt` itself
// (recursion included) now refuse `isEnforcementSurface` paths, and the (A) sweep
// routes the survivor into `unauthorizedAdditions`.
// THE RESTORE PATH WAS DELIBERATELY UNCHANGED BY THIS RULING and the asymmetry
// was the point: a MODIFIED TRACKED file has a recoverable source of truth (its
// committed bytes), so reverting it destroys nothing that git cannot hand back.
// An ADDITION has no such source — the bytes exist nowhere else — which is
// exactly why detection, not deletion, was the correct disposition for it.
// v6.0 (2026-08-30) then removed the asymmetry from the other side: recoverable
// BYTES were never the whole question, because AUTHORSHIP is unprovable in a
// shared worktree — restoring recoverable bytes still destroys a conductor's
// uncommitted replacement bytes (dc616f69). Detection is now the disposition for
// EVERY (A) finding, additions and modifications alike.
// SABOTAGE TABLE for this ruling (specified, never run in-place — mutation runs
// are conductor-only, decision 02e03ed8, and in-place mutation of
// scripts/hooks/** is anti-pattern 37b3cb0a):
//   S1: reintroduce an unlink on the addition arm (restore removeUnder and call
//       it where `noteUnauthorizedAddition(rel)` now sits — that helper is the
//       ONLY writer of `unauthorizedAdditions`, and it latches).
//       REAL CARRIER: enforcement.test.mjs AC8's SURVIVAL + BYTE-IDENTITY
//       assertions (`existsSync(evilAgent)` + `deepEqual(readFileSync(...),
//       plantedBytes)`). NOT the exit code — MEASURED ON THIS EXACT FILE: an
//       exit-code assertion stayed GREEN with the survive guard absent, because
//       the old code deleted the file FIRST and denied (exit 2) anyway. Same
//       exit code, opposite disk outcome. Never "simplify" an addition pin down
//       to `assert.equal(r.code, 2)` — that pins nothing about the disk.
//   S2: truncate/rewrite the addition in place instead of leaving it untouched
//       (e.g. write an empty placeholder). CARRIER: the BYTE-IDENTITY assertion
//       alone — `existsSync` still passes, so presence is not the verdict either.
//   S3: push additions back into `violations`. CARRIER: the
//       `doesNotMatch(/reverted|removed/i)` assertion, because the `violations`
//       wording claims the bytes were rolled back — an action that no longer
//       happens.
//   S4: drop the disposition wording from the addition denial (generic "denied").
//       CARRIER: the `match(/detect/i)` + `match(/left/i)` assertions.
//   S5: drop `unauthorizedAdditions.length` from the deny condition below.
//       CARRIER: the exit-code assertion — this is the ONE addition-arm sabotage
//       the exit code does catch, precisely because it is the one that stops the
//       denial from firing at all.
// SABOTAGE TABLE, v4.1 (A)-ROUTE ADDENDUM — HISTORICAL AS OF v6.0: rows S6-S10
// name `restoreTracked`/`removeTreeAt` layers that are now DELETED with the
// restore family (dc616f69), so those sabotages have nothing to strip any more —
// the (A) route cannot delete a file because it holds no delete primitive at
// all. S11's wording carrier survives in spirit (the `violations` denial must
// never claim a removal). Kept because the two-layer lesson — strip every layer
// to tell a hollow pin from a defended one — is what the table teaches.
// Original rules: specified, never run in-place. The scenario for every row:
// Pre baseline has no `.claude/agents/evil.md`; the audited command creates it
// and runs `git add -f` on it.
//   S6: remove LAYER 1 only (the `isEnforcementSurface` early return in
//       `restoreTracked`'s not-in-HEAD arm).
//       EXPECTED: STILL GREEN. Layer 2 catches the same exact-path hit inside
//       `removeTreeAt` and produces the same `leftOnDisk` disposition. This row
//       exists so nobody reads a green suite after a one-layer strip as proof
//       the pin is hollow — the layers are genuine defence in depth with
//       DIFFERENT REACH, and the verdict for THIS scenario is carried by either
//       one alone (measured-lesson discipline: strip every layer to tell a
//       hollow pin from a defended one).
//   S7: remove LAYER 2 only (the `isEnforcementSurface` refusal at the top of
//       `removeTreeAt`). EXPECTED: STILL GREEN for this scenario, for the mirror
//       reason. It goes RED for the DESCENDANT scenario (a not-in-HEAD directory
//       whose child is (B) surface), which layer 1's exact-path test cannot see.
//   S8: remove BOTH layers (i.e. restore the pre-v4.1 code).
//       REAL CARRIER: SURVIVAL + BYTE-IDENTITY of `.claude/agents/evil.md` after
//       the Post hook. NOT THE EXIT CODE — measured on this exact file, the deny
//       fires either way (the file is an (A) violation before and after), so an
//       exit-code assertion stays GREEN while the file is destroyed. This is the
//       same trap S1 records, and it is why the v4.0 pin did not catch v4.1's
//       defect: the (A) route denied, so only a disk assertion could see it.
//   S9: gate the survival on the (B) collection instead — e.g. re-order the (B)
//       stage before the (A) sweep and drop the path-level guards. CARRIER: the
//       `storeErr` variant, where the (B) stage is skipped entirely and the file
//       is deleted again. Ordering is not a guard; the guard belongs on the path.
//   S10: un-gate the `rmdirSync` in `removeTreeAt` (delete the directory even
//       when a protected descendant was kept). CARRIER: the DESCENDANT
//       scenario's survival assertion — the leaf refusal is worthless if its
//       parent is removed out from under it (and the rmdir would throw
//       ENOTEMPTY, denying with a misattributed environment-defect message).
//   S11: push the (A)-detected survivor into `violations` instead of
//       `unauthorizedAdditions`. CARRIER: the `doesNotMatch(/reverted/i)` +
//       `match(/left/i)` wording assertions — S3's carrier, on the (A) route.

// Parse `git status --porcelain -z`: NUL-separated entries `XY <path>`; a
// rename/copy (R/C) consumes a SECOND field `XY NEW\0OLD` — evaluate BOTH.
function parsePorcelainZ(out) {
  const tokens = out.split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const xy = tok.slice(0, 2);
    const paths = [tok.slice(3)];
    if (xy[0] === 'R' || xy[0] === 'C') paths.push(tokens[++i]); // OLD path follows
    entries.push({ xy, paths });
  }
  return entries;
}

// Decision h17-enforcement-stamp-conductor-attested-dirt (6e132e19): a
// CONDUCTOR-written stamp (.sterling/transient/enforcement-stamp.json, written
// by scripts/enforcement-stamp.mjs — never by an agent, which cannot self-
// attest its own tamper) lists each dirty enforcement path with the sha256 of
// its bytes at stamp time. When EVERY path in `preExistingRels` is listed with
// a hash matching its CURRENT bytes, the pre-existing dirt is conductor-
// attested work-in-flight rather than an unverifiable defect. FAIL-CLOSED:
// any error reading/parsing the stamp, any unlisted path, or any hash mismatch
// yields no exemption — never partial credit for a subset that DID match.
// NARROWED by decision 7021526c: `preExistingRels` is now populated ONLY on the
// degraded fallback (no per-call Pre-STATE record to compare against), so this
// all-or-nothing consult governs the degraded path alone. A pre-dirty path whose
// state genuinely CHANGED is attested PER PATH by stampAttestsCurrentBytes /
// stampAttestsDirectory in the sweep, because one unstamped unchanged path must
// never collapse attestation for a changed stamped one.
// `stamp` IS THE SWEEP'S SINGLE SNAPSHOT (S4 review, TOCTOU fix), passed in
// rather than re-read here: a consult that re-opened the file could be served
// bytes a backgrounded child substituted after the integrity witness was taken.
function verifyStampAttestation(cwd, preExistingRels, stamp) {
  try {
    const { present, entries } = stamp;
    if (!present) return { attested: false, stampPresent: false, failedPath: null };
    if (!entries) return { attested: false, stampPresent: true, failedPath: null };
    const byPath = new Map();
    for (const entry of entries) {
      if (entry && typeof entry.path === 'string') byPath.set(entry.path, entry);
    }
    for (const rel of preExistingRels) {
      const entry = byPath.get(rel);
      if (!entry) return { attested: false, stampPresent: true, failedPath: rel };
      // FIX L1 (upgrade-polish, 2026-08-21): a stamped DELETION attests iff the
      // path is STILL absent — the path reappearing is not the attested state,
      // so no exemption (fail-closed, no partial credit). LSTAT-guarded (review
      // finding 3): a dangling symlink is present, not absent, so it can never
      // pass as an attested deletion. SLICE 2: resolved through the pinned
      // parent, so a linked ancestor cannot answer the question from outside.
      if (entry.deleted === true) {
        if (lstatKindUnder(cwd, rel, `stamp attestation of '${rel}'`) !== 'absent') return { attested: false, stampPresent: true, failedPath: rel };
        continue;
      }
      if (typeof entry.sha256 !== 'string') return { attested: false, stampPresent: true, failedPath: rel };
      // Only a REGULAR FILE can be hashed for attestation — never a symlink
      // (whose bytes may live outside the repo), a directory, or a device.
      const current = sha256OfRegularFile(cwd, rel);
      if (current === null) return { attested: false, stampPresent: true, failedPath: rel };
      if (current !== entry.sha256) return { attested: false, stampPresent: true, failedPath: rel };
    }
    return { attested: true, stampPresent: true, failedPath: null };
  } catch {
    // Fail-closed (P5): an unreadable/corrupt stamp exempts nothing.
    return { attested: false, stampPresent: true, failedPath: null };
  }
}

// FIX-A (decision h17-stamp-honor-loud-restore, 4d9b76e8): a fresh conductor
// attestation for a SINGLE in-window path — consult the stamp and hash the
// file's CURRENT bytes. Deliberately separate from verifyStampAttestation
// above (FIX C): that one attests a whole preExisting SET at once, all-or-
// nothing; this one gates a single restore decision for a path that was NOT
// dirty at Pre. FAIL-CLOSED: any error (missing/corrupt stamp, unlisted path,
// hash mismatch, deleted-entry shape) attests nothing.
// `stamp` IS THE SWEEP'S SINGLE SNAPSHOT (S4 review, TOCTOU fix). This function
// was the hot spot: it is called once per candidate path AND once per child file
// from `stampAttestsDirectory`, so the old `readStamp(cwd)` here re-opened the
// stamp file many times in one sweep, giving a backgrounded child that many
// chances to substitute it after the integrity witness had already been taken.
// The TARGET path's bytes are still hashed live below — that is required and
// correct, since the question is whether the target's CURRENT bytes match — but
// the ATTESTATION it is compared against is now fixed for the whole sweep.
function stampAttestsCurrentBytes(cwd, rel, stamp) {
  try {
    const { entries } = stamp;
    if (!entries) return false;
    const entry = entries.find((e) => e && e.path === rel);
    if (!entry) return false;
    // Review fix 5: a stamped DELETION (enforcement-stamp.mjs writes
    // {path, deleted:true} for a dirty path with no bytes) attests iff the
    // path is STILL absent — mirrors verifyStampAttestation's deleted arm.
    // Without this, an attested in-window deletion was silently resurrected.
    // SLICE 2: resolved through the pinned parent, like the hash below it.
    const kind = lstatKindUnder(cwd, rel, `stamp attestation of '${rel}'`);
    if (kind === 'absent') return entry.deleted === true;
    // Review finding 3: a path that is not a REGULAR FILE is UNATTESTED, full
    // stop. The old existsSync/readFileSync pair FOLLOWED a link, so a stamped
    // file replaced by a symlink to an out-of-repo file holding the stamped
    // bytes was attested and allowed — and the hook loader would then execute
    // content from outside the repo that no sweep covers.
    if (kind !== 'file') return false;
    if (typeof entry.sha256 !== 'string') return false;
    const current = sha256OfRegularFile(cwd, rel);
    return current !== null && current === entry.sha256;
  } catch {
    return false;
  }
}

// RULING 4 of decision bcd2cc09 — WHERE A STAMP EXISTS, ITS (B) ENTRIES ARE AN
// EXACT MANIFEST. TIGHTENED CONSUMER VALIDATION FIRST, which the ruling requires
// BEFORE the comparison: validate the (B) paths, the entry shape and duplicates
// rather than relying on `stampAttestsCurrentBytes`'s `entries.find()`. A
// `find()` lookup silently takes the FIRST of two entries claiming one path, so
// a stamp carrying `[{p, goodHash}, {p, forgedHash}]` reads as attesting
// whichever happened to be emitted first — an ambiguity no exact-set comparison
// can be built on.
//
// Returns `{ usable, byPath, reason }`. NON-(B) ENTRIES ARE SKIPPED, NOT
// REJECTED: the same stamp legitimately attests the (A) tracked surface, whose
// paths are not (B) paths and are validated by `verifyStampAttestation` /
// `stampAttestsCurrentBytes` on their own terms. `validateBaselineKey` is reused
// as the ONE definition of "is a (B) path" so a second notion cannot drift from
// the first.
// A MALFORMED (B) ENTRY OR A DUPLICATED (B) PATH IS `usable: false`, which the
// caller turns into a DENIAL — fail-closed, never "skip the bad entry and trust
// the rest", because the rest is what the bad entry would be written to launder.
function stampBaselineManifest(entries) {
  if (!Array.isArray(entries)) return { usable: false, byPath: null, reason: 'the stamp does not parse to a JSON array of entries' };
  const byPath = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue; // not an entry at all; (A) validation owns its own refusals
    if (typeof entry.path !== 'string') continue;
    const rel = validateBaselineKey(entry.path);
    if (!rel) continue; // not a (B) path — the (A) surface's business, not this manifest's
    if (byPath.has(rel)) {
      return { usable: false, byPath: null, reason: `two entries claim the (B) path '${rel}' — a duplicated claim has no single meaning, so the stamp is refused whole` };
    }
    if (entry.deleted !== true && typeof entry.sha256 !== 'string') {
      return {
        usable: false,
        byPath: null,
        reason: `the entry for the (B) path '${rel}' carries neither a string sha256 nor deleted:true — it attests nothing and cannot stand in an exact manifest`,
      };
    }
    byPath.set(rel, entry);
  }
  return { usable: true, byPath, reason: null };
}

// Review fix 6 (h17-stamp-honor-loud-restore adjudication): an untracked
// DIRECTORY reaches the (A) sweep as its bare collapsed path (`?? dir/`
// → `dir`), while the stamp CLI expands a dirty dir into its child FILES — so
// a per-path lookup can never match. Attest the dir by walking its child files:
// EVERY child stamp-attested → the dir is conductor work-in-flight. Empty dir,
// any unattested or mismatched child, or any fs error → false (fail-closed —
// since v6.0 the caller then denies + latches; nothing restores). Since v6.0
// only the (B) manifest consult reaches this; the (A) consults died with the
// restore branch. S4 deletes the stamp apparatus whole (78dc9bd6).
// `stamp` IS THE SWEEP'S SINGLE SNAPSHOT (S4 review, TOCTOU fix) and is threaded
// straight through to the per-child consult below — this function is exactly the
// amplifier that made the old re-read dangerous, since one directory could drive
// an unbounded number of stamp re-opens in a single sweep.
function stampAttestsDirectory(cwd, relDir, stamp) {
  try {
    const files = [];
    // INCREMENTAL + BUDGETED (board 55fcccac clause 3), for the same reason
    // pathState's walk is: this walk runs on an agent-influenced dirty
    // directory, so its size is not ours to assume. A tripped budget throws
    // into the catch below and the directory simply attests NOTHING — the
    // fail-closed answer this function already gives for every other walk
    // failure (the caller then denies; nothing restores since v6.0).
    // SLICE 2: the enumeration walks PINNED directory descriptors instead of
    // re-resolving `join(cwd, rel)` at every level — a linked ancestor can no
    // longer route this walk out of the repository between one level and the
    // next. (The per-file hash below is a SEPARATE pinned resolution per path;
    // that is a deliberate boundary, not an oversight — each hash re-walks from
    // the root under its own pin, and a swap between the two can only ever make
    // this consult attest LESS, never more, since every failure is fail-closed.)
    const walk = (dirHandle, rel, depth) => {
      WALK_BUDGET.chargeDepth(depth, rel);
      const dir = opendirSync(dirHandle);
      let primary;
      try {
        for (;;) {
          const de = dir.readSync();
          if (de === null) break;
          WALK_BUDGET.chargeNode(rel);
          const childRel = `${rel}/${de.name}`;
          // Review finding 3: Dirent classification is lstat-shaped, and this
          // walk keeps it that way — a symlink is never recursed into and never
          // counted as an attestable file, so the recursion cannot leave the repo
          // and no child's bytes are ever hashed through a link. Anything that is
          // neither a real directory nor a regular file aborts the walk into the
          // catch below (fail-closed: the directory attests nothing).
          if (de.isDirectory()) withPinnedDir(`${dirHandle}/${de.name}`, (childHandle) => walk(childHandle, childRel, depth + 1));
          else if (de.isFile()) files.push(childRel);
          else throw new Error(`unattestable entry '${childRel}' (not a regular file or directory)`);
        }
      } catch (e) {
        primary = e;
        throw e;
      } finally {
        try {
          dir.closeSync();
        } catch (closeErr) {
          // Codex F5: propagate a leaked-handle close error only when no primary
          // exception is already driving the verdict; a swallowed leak marches
          // toward an EMFILE fail-open. (The outer catch here turns any throw
          // into an unattested `return false`, so this stays fail-safe.)
          if (!primary) throw closeErr;
        }
      }
    };
    withClassifiedDir(cwd, relDir, (kind, dirHandle) => {
      if (kind !== 'dir') throw new Error(`'${relDir}' is not a directory (kind: ${kind}) — it attests nothing`);
      walk(dirHandle, relDir, 0);
    });
    if (!files.length) return false;
    return files.every((f) => stampAttestsCurrentBytes(cwd, f, stamp));
  } catch {
    return false;
  }
}

// GRAVESTONE — THE (A) RESTORE FAMILY LIVED HERE: `restoreTracked` (the
// executor), `materializeHeadBlob`, `headTreeEntry`, `assertRestorableHeadEntry`,
// `headBlobBytes`, `indexDispositionAgainstHead`, `mintRestorePerformed`, plus
// `writeRegularAt` and `removeTreeAt` further up — the write and recursive-delete
// primitives whose only remaining caller was the restore. DELETED 2026-08-30
// (v6.0) by decisions dc616f69 (the (A) arm stops restoring) and 78dc9bd6 (H17
// demotes to tripwire). WHY, kept because a ruling stripped of its justification
// gets re-opened: no signal available to a same-UID hook in a shared worktree
// can prove which PROCESS authored a write — `agent_id` labels the hook EVENT,
// not the filesystem bytes written while it was open — so every automatic
// rollback carried the POSSIBILITY (not merely the probability) of destroying a
// conductor's concurrent uncommitted work, and no heuristic narrowing fixes
// that: narrowing changes the odds, never the possibility. The disposition for
// an in-window (A) violation is now the same one the (B) surface already uses —
// DETECT, DENY, LATCH, leave the bytes on disk for a human. If rollback is ever
// genuinely required it belongs UPSTREAM (per-agent worktrees, a copy-on-write
// sandbox, a separate authority), never in this hook. STRUCTURAL, NOT ADVISORY:
// the functions are GONE, not uncalled — this file no longer holds ANY primitive
// that writes, deletes or restores a repo path (its only in-repo mutations are
// the create-only taint latch and the best-effort stamp invalidation), so there
// is nothing left for a future edit to re-aim (anti-pattern 586bccdc).
// `restore_performed` maintenance items are no longer minted; the schema lane
// survives so existing records stay readable (dc616f69 R12).






// THE INPUT BOUNDARY IS ITSELF A GATE (repair of an outside-family review
// finding). `readStdin()` reads fd 0 and JSON.parses it, both unguarded. Called
// bare at the top level — as it was — a truncated or non-JSON stdin threw OUT of
// the hook, Node exited 1, and exit 1 is the platform's NON-BLOCKING code: the
// runner reads it as ALLOW. Everything downstream — the Ruling C preflight, the
// whole sweep, every line of the classify layer — was skipped and the command
// ran unexamined. A gate that cannot read its own input has verified NOTHING and
// must fail CLOSED (exit 2, P5), which is what this catch guarantees. It is
// deliberately the FIRST statement of the agent path, ahead of even the
// conductor short-circuit, because that short-circuit reads `input.agent_id` and
// so cannot run until there is an input to read.
let input;
try {
  input = readStdin();
} catch (e) {
  deny(
    environmentDefectDenial(
      'H17',
      `[stdin] hook input could not be read or parsed (${(e && e.message) || e}) — a gate that cannot read its own input has verified nothing, so it fails CLOSED (P5). ` +
        `An uncaught throw here would exit non-2, which the hook runner treats as NON-BLOCKING (the command would be ALLOWED unexamined).`
    )
  );
}
const cwd = input.cwd;

// (conductor) — legitimately edits the enforcement surface. Short-circuit BEFORE
// any store/git/baseline touch (AC5).
if (!input.agent_id) allow();

// RULING C PREFLIGHT (decision 532a4383) — placed HERE deliberately: AFTER the
// conductor short-circuit, so a missing prevention mechanism never denies the
// conductor's own Bash (this hook exempts the conductor entirely, c8ccb06e),
// and BEFORE any store/git/baseline/read touch, so the first thing an agent
// command meets in an environment without secure I/O is the refusal — not a
// sweep that has already read something through an unprotected path. HARD-DENY,
// NEVER AUTO-DEGRADE: falling back to the Windows detect-and-abort arm when
// procfs is absent was explicitly rejected on P5 grounds — silently trading
// prevention for defeatable detection is invisible from the outside, and an
// unexpected environment that removes a guarantee must halt. Framed as an
// ENVIRONMENT DEFECT because it is broken state, not the agent's conduct.
const secureIoReason = secureIoUnavailableReason(cwd);
if (secureIoReason) {
  deny(
    environmentDefectDenial(
      'H17',
      `${secureIoReason} — this hook's descriptor-pinned no-follow I/O layer resolves every path component through '${PROCFS_FD_DIR}', ` +
        `and without it H17 cannot prevent a symlink swap from redirecting its own reads. Denying every agent Bash command until it is ` +
        `available (decision h17-baseline-integrity-redesign-rulings-abcd, Ruling C): degrading to detection-only would silently weaken ` +
        `the guarantee instead of halting, and that degrade was rejected.`,
      { agentId: input.agent_id }
    )
  );
}

const event = input.hook_event_name;

// ---------------------------------------------------------------------------
// PreToolUse — snapshot the (B) baseline to os.tmpdir()/sterling-enforce-<runId>.json
// ---------------------------------------------------------------------------
if (event === 'PreToolUse') {
  try {
    // THE TAINT LATCH IS CONSULTED FIRST — before the store, before git, before
    // the baseline, before the stamp (decision bcd2cc09, RULING 10: the latch
    // ALWAYS wins). THIS POSITION IS THE MECHANISM, not tidiness: PRE IS THE
    // ADOPTION POINT. `collectBaseline` two dozen lines below reads CURRENT DISK
    // STATE as the pre-image, so a Pre that runs at all over a tainted surface
    // records the tamper as legitimate and every later call compares equal. The
    // deny has to land BEFORE that snapshot or the latch closes nothing.
    denyIfTainted(cwd, input.agent_id);
    const store = openStore(cwd);
    let runId = NO_RUN;
    try {
      const run = store ? withRetry(() => store.getRun()) : undefined;
      if (run) runId = run.id;
    } finally {
      store?.close();
    }
    // ONE key for this Bash call, used by BOTH per-call records below (board
    // 11609d1f): the (B) content baseline and the (A) Pre-STATE snapshot are
    // keyed identically, so they can never disagree about which call they
    // belong to. A null key writes the legacy per-run baseline and NO state
    // record — degraded, and Post says so on both counts.
    const key = callKey(input.tool_use_id);
    // The (B) baseline is written ONCE, under the per-call key when there is
    // one: writing the legacy per-run copy as well would leave a shared file
    // behind after the per-call one is consumed, which is precisely the shared
    // transient state this keying removes (P4).
    // SIZE INVARIANT ENFORCED AT PRE, SYMMETRICALLY WITH POST (Codex F-REGRESSION):
    // Post reads this baseline back through readBoundedJsonFile(..., MAX_RECORD_BYTES)
    // and DENIES an over-budget record. base64 expands the (B) bytes ~4/3, so a
    // large legit protected file (e.g. a ~12MiB file under .claude/agents/**)
    // could push the serialized baseline past MAX_RECORD_BYTES — and if Pre wrote
    // it anyway, EVERY Post for that call would false-deny H17's own enforcement
    // set (a self-DoS). Enforce the IDENTICAL bound HERE so an oversize (B)
    // enforcement set fails LOUDLY at Pre, before the command runs, rather than as
    // a silent Post false-deny after. This bounds ONLY the retained (B) baseline
    // content — NOT the dirty-set hashing path (which is streamed, uncapped by
    // construction, board 55fcccac clause 1). The (B) set is the small enforcement
    // surface (.claude/agents/**, settings, config; 717 KB measured live), so
    // MAX_RECORD_BYTES is ~20x headroom and tripping it is a genuine anomaly.
    const baselineJson = JSON.stringify(collectBaseline(cwd));
    const baselineBytes = Buffer.byteLength(baselineJson, 'utf8');
    if (baselineBytes > MAX_RECORD_BYTES) {
      throw new Error(
        `(B) content baseline serialized to ${baselineBytes} bytes, over the ${MAX_RECORD_BYTES}-byte budget the Post consumer enforces — refusing at Pre so an oversize (B) enforcement set denies LOUDLY and SYMMETRICALLY before the command runs, never as a silent Post false-deny after`
      );
    }
    writeFileSync(baselineFile(cwd, runId, key), baselineJson);
    // Attribution record for the (A) branch: without it, Post can only see that a
    // tracked path is dirty NOW, not whether this command made it so. KEYED PER
    // CALL under the SAME `key` as the (B) baseline and the (A) STATE record
    // (board 489554d4): a run-keyed record is one file every concurrent lane
    // overwrites, and an overwrite that OMITS a genuinely pre-dirty path makes
    // Post restore-delete it. Written ONCE — per-call when there is a key, the
    // legacy per-run name (degraded, disclosed LOUDLY at Post) when there is not;
    // writing the legacy copy as well would leave a shared file behind after the
    // per-call one is consumed, exactly the shared transient state this keying
    // removes (P4).
    const dirtyRels = dirtyTrackedRels(cwd);
    writeFileSync(dirtyFile(cwd, runId, key), JSON.stringify(dirtyRels));
    // THE STAMP WITNESS (Ruling 2 of fac9a69b): the conductor's attestation input
    // is itself unprotected — it sits in neither the (A) enforcement surface nor
    // the (B) glob set — so without this record an agent could write a stamp
    // attesting its own tamper and have it honoured in the very same Post. Record
    // what the stamp looks like BEFORE the command runs; Post recomputes and any
    // difference is an in-window stamp write. Written on EVERY path, per-call key
    // or legacy per-run name, so Post always has something to compare against.
    // NEVER THROWS: `stampWitness` returns a non-'file' kind for every failure, so
    // an absent, oversize, corrupt or unreadable stamp cannot turn this snapshot
    // into a Pre-time deny — an unusable stamp is a normal, common state (H1
    // deletes the stamp at every SessionStart), not an anomaly.
    // ACCEPTED, DISCLOSED RESIDUAL: this record lands in os.tmpdir() under a name
    // the audited command can compute and OVERWRITE — the same same-UID exposure
    // the (B) content baseline and the (A) attribution/state records carry, and
    // which the (B) denial states outright. An agent that rewrites its own witness
    // to match a stamp it intends to counterfeit defeats the comparison at Post. There is
    // no location this hook can write that the command cannot (79942bda), so the
    // residual is NAMED, not closed — see `stampWitness` for the full statement.
    writeFileSync(stampWitnessFile(cwd, runId, key), JSON.stringify(stampWitness(cwd)));
    // PER-CALL Pre-STATE record (7021526c): the STATE of every dirty path, so
    // Post can compare rather than deny the whole result for being unable to.
    // Written ONLY when tool_use_id is usable — a null key degrades LOUDLY at
    // Post (the blanket pre-existing denial, naming the reason), never silently
    // to a per-run key. Derived from the SAME git status as the attribution
    // record above, so the two records can never disagree about which paths
    // were dirty.
    if (key) {
      const idx = indexEntriesFor(cwd, dirtyRels);
      const states = {};
      for (const rel of dirtyRels) {
        try {
          states[rel] = pathState(cwd, rel, idx, WALK_BUDGET, 0);
        } catch (e) {
          // A STRUCTURAL BUDGET is the one snapshot failure Pre does not deny
          // on (board 55fcccac clause 3): the tree's size is the user's, the
          // command has not run yet, and a Pre that denies every Bash call
          // because some untracked directory is large is the workflow-breaking
          // false-deny that got the previous attempt reverted. Record the
          // honest "not attested" state instead and let POST — which is where
          // verification actually happens — deny naming the budget. Every
          // OTHER snapshot failure still denies here, unchanged.
          if (!(e instanceof WalkBudgetError)) throw e;
          states[rel] = walkBudgetExceededState(cwd, rel, idx, e);
        }
      }
      writeFileSync(stateFile(cwd, runId, key), JSON.stringify(states));
    }
    allow();
  } catch (e) {
    // A snapshot failure during an active agent run cannot be verified later —
    // fail closed (P5).
    deny(environmentDefectDenial('H17', `[pre] Baseline snapshot failed (${(e && e.message) || e}) — failing closed (P5).`, { agentId: input.agent_id }));
  }
}

// ---------------------------------------------------------------------------
// PostToolUse — verify: detect + deny + latch (v6.0 — nothing restores). The
// ENTIRE body is fail-closed: ANY unexpected error during an active agent run
// denies (exit 2), NEVER a non-blocking exit 1.
// ---------------------------------------------------------------------------
try {
  // PIN5 (born as FIX-B, 4d9b76e8; restated at v6.0): an unopenable/throwing
  // store must never suppress the (A) detect sweep below —
  // captured here, not thrown, so section (A) still runs on what git alone can
  // tell it (glob-only violations, denied AND latched; no brief, no
  // pre-existing attribution, both
  // of which need a working store to resolve). The original deny still fires,
  // but only AFTER the restore (and its mint attempt) had their chance —
  // denying immediately here is exactly what silently dropped the restore.
  // ONE key for this Bash call, resolved before anything reads a record: BOTH
  // per-call records (the (A) Pre-STATE snapshot and the (B) content baseline,
  // board 11609d1f) are addressed by it, and both degrade LOUDLY — never
  // silently — when it is unusable.
  // THE TAINT LATCH IS CONSULTED FIRST HERE TOO (decision bcd2cc09, RULING 10 —
  // the latch ALWAYS wins over the stamp, with no exception). A surface with an
  // outstanding, undischarged incident is not verifiable by this sweep, and a
  // matching exact stamp is evidence that reconciliation MAY proceed, never
  // proof that the incident was discharged.
  denyIfTainted(cwd, input.agent_id);
  const callId = callKey(input.tool_use_id);
  let storeErr = null;
  let store = null;
  try {
    store = openStore(cwd);
  } catch (e) {
    storeErr = new Error(`store/resolveRun threw (${(e && e.message) || e})`);
  }

  let run;
  if (store) {
    try {
      run = withRetry(() => store.getRun());
    } catch (e) {
      storeErr = new Error(`store/resolveRun threw (${(e && e.message) || e})`);
      store.close();
      store = null;
    }
  }
  const runId = run ? run.id : NO_RUN;

  let brief = null;
  if (run && store) {
    try {
      brief = withRetry(() => store.get(run.brief_ref));
    } catch (e) {
      storeErr = new Error(`brief resolve threw (${(e && e.message) || e})`);
      store.close();
      store = null;
    }
    if (store && (!brief || brief.type !== 'brief')) {
      store.close();
      // run active but brief unresolvable → fail CLOSED (unlike H3), P5 (AC9f).
      // Unchanged: this is an invalid brief_ref, not a broken store, and no
      // restore has been attempted yet — it stays an immediate deny exactly as
      // before (only the store/resolveRun-throw path below is deferred).
      deny(
        environmentDefectDenial(
          'H17',
          `Run '${runId}' active but brief '${run.brief_ref}' unresolvable — cannot verify contract; failing closed (P5).`,
          { agentId: input.agent_id }
        )
      );
    }
  }
  store?.close();

  // In-window (A) violations — clean at Pre, changed inside this command's
  // window, on enforcement surface / hooks/** / off-brief. Since v6.0 each one
  // is DENIED, LATCHED (eagerly, at its detection site — see
  // `noteTrackedViolation` below) and LEFT ON DISK; nothing restores.
  const violations = [];
  // Dirty BEFORE this command — reported, never reverted, never blamed on the
  // agent (decision f76d7c5c). An agent cannot produce this state silently ON
  // THE ATTRIBUTED PATH: H3's self-protection denies spawned agents every
  // Edit/Write inside the bundled hooks dir or matching ENFORCEMENT_SURFACE,
  // and its only other write vector is Bash — whose in-window writes this very
  // sweep denies AND latches, so there a previous command's surviving dirt sits
  // behind a standing latch (v6.0: the old wording said the branch "reverts",
  // which it no longer does). DISCLOSED RESIDUAL (v6.0 security review): the
  // DEGRADED route carries no such guarantee — with an unusable tool_use_id a
  // concurrent lane's Pre can overwrite the SHARED per-run attribution record,
  // an agent-written path is then recorded pre-dirty, lands in THIS arm
  // (denied, deliberately NOT latched — no state change was observed), and the
  // next Pre baselines the surviving bytes. That is the shared-record
  // laundering class the per-call key (board 489554d4) closed for the normal
  // path; the degraded arm keeps the old exposure, and the degraded-loud
  // stderr disclosure is its only trace.
  const preExisting = [];
  // Pre-dirty paths whose recorded STATE CHANGED inside this command's window
  // (7021526c step 3): denied and NAMED, and deliberately NOT restored.
  const changedPreDirty = [];

  // -------------------------------------------------------------------------
  // THE (B) TAINT LATCH IS SET EAGERLY, AT EACH DETECTION SITE — decision
  // taint-latch-persists-eagerly-at-detection-because-deny-is-a-hard-exit
  // (fd9d24af), RULING A, correcting RULING 9 of bcd2cc09.
  //
  // WHY, and the reason travels with the rule because the previous placement
  // carried a comment claiming it saw every trigger while it did not
  // (anti-pattern 886cc903): `deny()` is `process.stderr.write(message);
  // process.exit(2)` (scripts/hooks/lib/common.mjs:108) — A HARD EXIT, NOT A
  // THROW. Fourteen unconditional `deny()` sites and two throws sit between the
  // earliest detection (the stamp integrity check below) and the end of the (B)
  // stage, so ANY of them could end the process with the incident detected and
  // NOTHING on disk. Call N+1's Pre then re-collected the tampered bytes as its
  // own legitimate baseline — one denial bought a permanent edit to the agent
  // GRANT DEFINITIONS, which is the adoption point the latch exists to close.
  // WHAT EAGER LATCHING DOES **NOT** CLOSE — STATED HERE BECAUSE AN EARLIER
  // VERSION OF THIS COMMENT CLAIMED OTHERWISE AND A REVIEWER CAUGHT IT
  // (anti-pattern 886cc903, the third instance in this objective). The
  // motivating exploit — append to an agent template, then `rm` the
  // os.tmpdir() records — IS NOT FIXED BY EAGER PLACEMENT. It does not evade
  // the latch; it DESTROYS THE EVIDENCE THE DETECTION DEPENDS ON, and a latch
  // at the detection site cannot fire for a detection that never happens. All
  // four Pre record classes share one `sterling-enforce-<tag>` prefix, so one
  // glob removes the attribution record AND the `.stamp.json` witness, and
  // `stampTampered` is only ever set when a usable witness survives to compare
  // against. Post then exits at the "nothing attributable" deny, ~540 lines
  // before the (B) stage below. THAT IS THE STILL-OPEN `baselineAuditUnavailable`
  // FOURTH-TRIGGER FAMILY, ruled in decision
  // an-a-audit-failure-must-not-abort-the-b-audit-unverifiable-b-latches and
  // assigned to SLICE S2, not here — the fix is that an (A)-audit failure must
  // not ABORT the (B) audit, plus latching an unverifiable (B) baseline.
  //
  // SO WHAT EAGER PLACEMENT ACTUALLY BUYS, precisely: a detection that DID
  // occur survives an unrelated later hard exit. Pinned by AC-L12, whose
  // fixture corrupts ONLY the `.dirty.json` attribution record so the
  // `.stamp.json` witness lives and the stamp tamper is still detected.
  //
  // THE PRINCIPLE: the latch records THAT AN INCIDENT WAS OBSERVED, so the
  // OBSERVATION SITE is the only correct persistence point — nothing downstream
  // may un-observe it. `observeStampTamper`, `noteUnauthorizedAddition` and
  // `noteBaselineDenied` below are therefore the ONLY producers of
  // `stampTampered`, `unauthorizedAdditions` and `baselineDenied`; a direct write
  // to any of the three would reintroduce exactly this loss.
  //
  // NO LATCH-AWARE `deny()` WRAPPER (RULING C — considered and REJECTED): it
  // would duplicate the invariant across every existing and future exit, still
  // miss a direct `process.exit` and fatal termination, and make ordinary
  // environment-denial plumbing responsible for incident persistence.
  //
  // NO LOCAL "already latched?" CACHE, deliberately: RULING 8's set primitive is
  // create-only (`O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`) and treats an existing
  // leaf in ANY shape as already-set, so a repeat call is a cheap EEXIST no-op.
  // A cache here would be a second source of truth that can itself be wrong.
  // -------------------------------------------------------------------------
  let latchOutcome = null; // the FIRST meaningful set/failure outcome, kept for the composed denial below
  const latchOnDetection = (why) => {
    // NEVER THROWS (RULING A). A helper that threw would convert a detection into
    // an exception and reintroduce the same class of loss this design closes.
    let outcome;
    try {
      outcome = setTaintLatch(cwd, [why]);
    } catch (e) {
      outcome = { set: false, error: `${(e && e.message) || e}` };
    }
    // FIRST MEANINGFUL OUTCOME WINS, IN BOTH DIRECTIONS: a later successful set
    // must not erase an earlier failure, and a later failure must not erase an
    // earlier success. The first call is the one that decided what is on disk.
    if (latchOutcome === null) latchOutcome = outcome;
    if (!outcome.set) {
      // IMMEDIATE, BEST-EFFORT WARNING. A hard exit further down can mean the
      // composed final message is never printed at all, and a conductor told only
      // "attribution record missing" would never learn that cross-call protection
      // was not established. Deliberately avoids the SET path's vocabulary —
      // nothing here may read as "repeated denial established".
      try {
        process.stderr.write(
          `H17: THE CROSS-CALL ENFORCEMENT TAINT LATCH COULD NOT BE PERSISTED (${taintLatchPaths().rel}: ${outcome.error}) at the moment the incident was ` +
            `observed (${why}). Whatever denial this call ends with is therefore a ONE-CALL denial only: without the latch on disk, the next ` +
            `PreToolUse re-collects the bytes this command left behind as its own legitimate baseline and allows them from then on. THE (B) SURFACE ` +
            `MUST BE TREATED AS TAINTED BY HAND until a conductor has inspected it and re-attested it.\n`
        );
      } catch {
        /* best-effort trace — a failed stderr write must never change the verdict already owed */
      }
    }
  };

  // UNEXPECTED ADDITIONS in the (B) enforcement surface — live files with no
  // entry in this call's Pre baseline (user ruling 2026-08-27; see the
  // `removeUnder` gravestone). DELIBERATELY A SEPARATE LIST FROM `violations`,
  // and this is not cosmetics: the two arms carry DIFFERENT dispositions — an
  // addition has no Pre-image entry at all, while a `violations` path is an
  // in-window change to something the baseline knows — and folding them would
  // let one arm's wording assert facts about the other (historically the
  // `violations` text said "reverted", which was the 586bccdc false-action-claim
  // hazard; since v6.0 both arms truthfully say left-on-disk).
  // These paths are DENIED, REPORTED, and LEFT ON DISK BYTE-IDENTICAL.
  // v6.0: STILL TWO PRODUCERS — the (B) collection AND the (A) sweep, which
  // routes a clean-at-Pre `isEnforcementSurface` path here directly (the
  // deleted restoreTracked's leftOnDisk refusal used to do the same), so one
  // path stays one finding and, under a broken store, the (A) route's latch and
  // denial carry the finding the skipped (B) stage cannot. The dedup guard is
  // what makes the two producers compose. The addition wording states the
  // force-add ambiguity honestly (new file vs pre-existing ignored file — v6.0
  // review fix; it used to assert baseline-absence this sweep never checked).
  // KNOWN IMPRECISION, pre-existing at HEAD and deferred to S4's wording
  // rework (Codex delta review, MEDIUM): a bytes-changed force-added file is
  // ALSO named by baselineDenied — two dispositions for one path, deduped only
  // within each list. Disposition (deny + latch + leave on disk) is correct for
  // every shape either way.
  const unauthorizedAdditions = [];
  // THE ONLY PRODUCER OF `unauthorizedAdditions` (fd9d24af RULING A): it records
  // the finding and IMMEDIATELY persists the incident, before any caller can
  // reach a `deny()` that would exit the process. The dedup guard also skips the
  // latch call for a path already met — the first sighting already latched, and
  // the set primitive is create-only anyway.
  const noteUnauthorizedAddition = (rel) => {
    if (unauthorizedAdditions.includes(rel)) return;
    unauthorizedAdditions.push(rel);
    latchOnDetection(`unauthorized (B) addition: ${rel}`);
  };
  // (B) paths MODIFIED or DELETED in-window with no attesting stamp entry (S4,
  // RULING D of 532a4383 as refined by fac9a69b). A SEPARATE LIST FROM
  // `violations` because the two surfaces are different claims — (B) is the
  // gitignored baseline set compared against this call's Pre image, (A) is
  // git-visible state — and each denial must assert only what its own surface
  // established (the historical reason was sharper: `violations` used to say
  // "reverted", a 586bccdc false action claim for a (B) path nothing wrote;
  // since v6.0 neither arm claims any write action).
  // These paths are DENIED, REPORTED, and LEFT EXACTLY AS OBSERVED.
  const baselineDenied = [];
  // THE ONLY PRODUCER OF `baselineDenied` (fd9d24af RULING A + RULING B). No
  // `deny()` sits between this list's push and the composed denial TODAY, and it
  // latches eagerly anyway: excluding it because of the current control flow
  // would make a security invariant depend on the shape of the code below it,
  // which is the dependency the eager design exists to remove.
  const noteBaselineDenied = (rel) => {
    baselineDenied.push(rel);
    latchOnDetection(`unattested (B) change: ${rel}`);
  };
  // THE ONLY PRODUCER OF `violations` (v6.0 — dc616f69 R10/R15). The (A) arm's
  // restore is DELETED, so a clean-at-Pre in-window violation follows the exact
  // pattern of the two (B) producers above: record the finding, then IMMEDIATELY
  // persist the incident, before any downstream `deny()` can hard-exit the
  // process. The latch is load-bearing here, not decoration — the denied bytes
  // stay ON DISK, so without it the very next Pre would record them as
  // pre-existing dirt and the state comparison would verify them BY OBSERVATION
  // from then on: one denial would buy a permanent adoption of the write. R15's
  // split rule exists for exactly this: the restore's deletion and the (A) latch
  // land in the SAME commit, never a state that merely leaves bytes and words.
  const noteTrackedViolation = (rel) => {
    if (violations.includes(rel)) return;
    violations.push(rel);
    latchOnDetection(`in-window (A) enforcement write: ${rel}`);
  };
  // THE ONLY PRODUCER OF `changedPreDirty` (v6.0, Codex review HIGH on the S3
  // excision — EXTERNAL-MODEL finding, adopted): a pre-dirty path whose recorded
  // state CHANGED inside this window is an OBSERVED (A) incident with its bytes
  // left on disk, so without a latch the NEXT call's Pre snapshots the changed
  // state and, unchanged thereafter, verifies it BY OBSERVATION — the same
  // adoption hole the clean-at-Pre latch closes, one arm over. Same eager
  // pattern; deny-without-latch here would satisfy R15's letter and leak its
  // point. (The blanket `preExisting` denial deliberately does NOT latch: no
  // state CHANGE was observed there — it is unverifiable pre-existing dirt, and
  // latching it would turn every degraded call over ordinary conductor dirt
  // into a conductor-reconciliation stop. The audit-failure deny paths that
  // exit before any producer runs are the ruled `baselineAuditUnavailable`
  // family — their own slice, not this one.)
  const noteChangedPreDirty = (rel) => {
    if (changedPreDirty.includes(rel)) return;
    changedPreDirty.push(rel);
    latchOnDetection(`in-window state change on pre-dirty path: ${rel}`);
  };
  // EXACT-MANIFEST violations (RULING 4 of decision bcd2cc09), each already a
  // full sentence naming the path AND what was wrong with it. A SEPARATE LIST
  // FROM `baselineDenied` for the same reason `baselineDenied` is separate from
  // `violations`, and the reason is truthfulness, not tidiness: the
  // `baselineDenied` denial says the named paths "CHANGED IN THIS COMMAND'S
  // WINDOW", which is exactly what a manifest violation typically is NOT — the
  // whole point of Ruling 4 is that it fires on a call in which nothing changed
  // at all. Borrowing that wording would assert an in-window change that did not
  // happen (anti-pattern 586bccdc).
  // DELIBERATELY NOT A LATCH TRIGGER: RULING 9 names exactly three
  // (`baselineDenied`, `unauthorizedAdditions`, `stampTampered`), and that
  // enumeration is unchanged — a manifest-only mismatch commonly PREDATES this
  // window and may be a legitimate conductor or automatic writer, so latching it
  // would turn every stale stamp into a persistent, reconciliation-required DoS.
  // WHAT THIS COMMENT USED TO CLAIM AND WHICH WAS FALSE (fd9d24af RULING F):
  // that a manifest violation "needs no latch because it is already durable by
  // construction". It is not durable. This arm re-fires only while all three of
  // these hold — the SESSION lives (H1 deletes the stamp at every SessionStart),
  // the STAMP is still on disk, and the STORE is healthy (the whole (B) stage
  // sits inside `if (!storeErr)` below). It is session-bound, stamp-present,
  // store-healthy protection, which is strictly weaker than the cross-call
  // persistence the latch supplies for the other three. Whether an observed
  // manifest contradiction should latch anyway is boarded as its own design
  // question, with its legitimate-writer DoS cost stated.
  const manifestDenied = [];

  // -------------------------------------------------------------------------
  // STAMP INTEGRITY — RULING 2 of decision h17-ruling-d-needs-a-b-enumerating-
  // stamp-producer-and-stamp-invalidation (fac9a69b).
  //
  // ORDERING IS LOAD-BEARING, AND THIS POSITION IS THE MECHANISM. It runs BEFORE
  // the (A) sweep's two exemption consults below and before the (B) stage's, so a
  // stamp forged INSIDE this window is ineligible for EVERY exemption in this same
  // Post. Consulting first and noticing afterwards would honour the forgery once —
  // which is the whole of the one-call self-attestation attack: change a (B) file
  // and write a matching stamp in the same command.
  //
  // FAIL-CLOSED HERE MEANS "NO EXEMPTION", NEVER "DENY EVERYTHING". A missing or
  // unparseable witness record makes the stamp UNTRUSTED (`stampTrusted = false`)
  // and nothing more: no tampering is claimed, no stamp is deleted, and an
  // UNCHANGED surface still allows without the stamp ever being consulted. Only a
  // witnessed DIFFERENCE is treated as tampering — an in-window stamp write — and
  // only that path deletes.
  //
  // WHY DELETION AND NOT MERELY A DENY: see `invalidateStamp`. A denial with no
  // cross-call consequence turns the next Pre into an adoption point.
  //
  // ACCEPTED CONSEQUENCE, DISCLOSED NOT BURIED: conductor stamping must happen
  // BETWEEN audited Bash windows. A conductor stamp written INSIDE an active agent
  // window is observationally identical to the agent attack and will be denied and
  // invalidated. That matches the standing posture (quiesce agent Bash across a
  // build), and preserving concurrent mid-window stamping would need a trusted
  // coordination channel that does not exist on a same-UID machine (79942bda).
  // -------------------------------------------------------------------------
  let stampTrusted = true;
  let stampTampered = false;
  let stampInvalidated = false;
  // THE ONLY PRODUCER OF `stampTampered` (fd9d24af RULING A), and THE ORDER
  // INSIDE IT IS THE WHOLE POINT: the incident is persisted BEFORE
  // `invalidateStamp` runs, so there is no reachable window between "tamper
  // observed" and "latch set" for a crash, a throw or a downstream `deny()` to
  // fall into. Invalidation stays best-effort AFTERWARDS, exactly as before —
  // it returns a boolean and never throws (its own try/catch returns false), so
  // this helper does not throw either.
  // THE INCIDENT SENTENCE OMITS THE INVALIDATION RESULT, and that omission is
  // deliberate rather than an oversight: at the moment the latch is written the
  // deletion has not been attempted yet, so naming its outcome here would assert
  // something not yet known (anti-pattern 886cc903). The composed denial below
  // still reports it, because by then it IS known.
  const observeStampTamper = () => {
    stampTampered = true;
    stampTrusted = false;
    latchOnDetection(`the enforcement stamp (${stampRel()}) was written inside this command's window`);
    stampInvalidated = invalidateStamp(cwd);
  };
  // THE SWEEP'S ONE AND ONLY READ OF THE STAMP FILE (S4 review, TOCTOU fix).
  // Everything downstream — the integrity comparison AND every exemption consult —
  // is served from this object. Nothing below re-opens the path, which is what
  // makes "witnessed bytes == consulted bytes" true by construction rather than by
  // timing: the audited command can background a child that outlives it, so any
  // second read would be a fresh opportunity to substitute the file.
  const stampSnapshot = readStampSnapshot(cwd);
  {
    const witnessPath = stampWitnessFile(cwd, runId, callId);
    let preWitness = null;
    try {
      preWitness = readBoundedJsonFile(witnessPath, MAX_RECORD_BYTES, 'enforcement stamp witness'); // BOUNDED, board 55fcccac clause 4
    } catch {
      preWitness = null; // absent/corrupt/oversize -> untrusted stamp, NOT a tampering claim
    }
    // LIFECYCLE-BOUND (P4), exactly like the (B) content baseline, INCLUDING its
    // per-call/legacy asymmetry: a PER-CALL record's life ends with the Post that
    // read it, so it is unlinked here (best-effort — the bytes are already in
    // memory, so a failed unlink leaks a temp record and can never change a
    // verdict). The LEGACY PER-RUN witness is deliberately LEFT ALONE for the same
    // reason the per-run baseline is: it is not this call's to consume, a
    // concurrent lane in the same run may still need it, and the next Pre
    // overwrites it anyway.
    if (callId) {
      try {
        rmSync(witnessPath, { force: true });
      } catch {
        /* leaked temp record only; the comparison already happened in memory */
      }
    }
    const nowWitness = { kind: stampSnapshot.kind, sha256: stampSnapshot.sha256 };
    if (!preWitness || typeof preWitness.kind !== 'string') {
      stampTrusted = false;
    } else if (preWitness.kind !== nowWitness.kind || (preWitness.sha256 ?? null) !== (nowWitness.sha256 ?? null)) {
      observeStampTamper(); // records the finding, LATCHES, then invalidates — in that order
    }
  }

  // THE ONE PLACE A STAMP EXEMPTION IS DECIDED, so `stampTrusted` cannot be
  // honoured at one consult and forgotten at another, and so every consult is
  // served the SAME `stampSnapshot` the integrity check just judged. Keeps the
  // existing directory-vs-file split (an untracked dirty DIRECTORY reaches the
  // consult as its collapsed path while the CLI expands it into child files, so a
  // per-path lookup could never match one).
  const stampAttestsPath = (rel) =>
    stampTrusted && (isDirectoryAt(cwd, rel) ? stampAttestsDirectory(cwd, rel, stampSnapshot) : stampAttestsCurrentBytes(cwd, rel, stampSnapshot));

  // No working store → no runId to key the attribution record on, so
  // `preDirty` stays empty: unverifiable attribution is never treated as
  // pre-existing (P5) — every glob-matched tracked violation is denied and
  // latched as in-window.
  let preDirty = new Set();
  // The per-call Pre-STATE map (7021526c), or null when this command has no
  // comparable record — in which case the pre-dirty branch keeps the OLD blanket
  // denial and `degradedReason` says why (degraded LOUD, never silent).
  let preState = null;
  let degradedReason = null;
  // Set when the (B) stage had to fall back to the SHARED per-run baseline
  // because this call carries no usable tool_use_id (board 11609d1f). Disclosed
  // NON-FATALLY on stderr on EVERY path the moment the fallback is taken
  // (reviewer F1 — the laundering it admits compares EQUAL and allows, so a
  // disclosure gated on a violation is silent when it matters), and ADDITIONALLY
  // named in the denial alongside the (B) paths it acted on. A degraded key that
  // changes what the guard trusts and says nothing is the defect, not the
  // degradation.
  let baselineShared = null;
  // The (B) paths this Post found a DIFFERENCE on — modified, deleted, or added —
  // kept beside `violations` (which is now purely (A)) so the shared-baseline
  // disclosure can name exactly the paths that disclosure applies to.
  // "restored/removed" was accurate while the (B) arm wrote and unlinked. Since S4
  // it neither writes nor deletes ANY (B) path, so the noun is now COMPARISONS, not
  // writes — and the degraded-(B) notice composed from this list says "compared",
  // which is what is true of every member (anti-pattern 586bccdc: never let a name
  // or a comment assert an action the code stopped taking).
  const baselineViolations = [];
  // Set when the (A) ATTRIBUTION record had to fall back to the SHARED per-run
  // file because this call carries no usable tool_use_id (board 489554d4), the
  // mirror of `baselineShared` on the (B) side. Disclosed NON-FATALLY on stderr
  // the moment the fallback is taken, ALLOW path included: the destructive
  // laundering it admits (a genuinely pre-dirty path missing from an overwritten
  // shared record is HEAD-restored as this command's write) produces a DENY, but
  // a clean-allow degraded call must still say the pre-dirty set it trusted was
  // not this call's own. A degraded key that changes what the guard trusts and
  // says nothing is the defect, not the degradation.
  let attributionShared = null;
  if (!storeErr) {
    const dPath = dirtyFile(cwd, runId, callId);
    if (!callId) {
      attributionShared =
        'this hook call carries no usable `tool_use_id` (absent, empty/whitespace, or not a string), so the (A) ATTRIBUTION record in play is the ' +
        'legacy PER-RUN, RUN-KEYED file SHARED by every concurrent Bash lane in this run instead of one keyed to this call — while it is shared, a ' +
        "second lane's Pre can OVERWRITE it after this lane's Pre ran, and a path that was genuinely dirty at this lane's Pre but MISSING from the " +
        "overwritten record is then treated as clean-at-Pre and DENIED + LATCHED as this command's write — a false attribution, though no longer a " +
        'destructive one since v6.0 (that is exactly why the per-call key exists, board 489554d4, and why this fallback is reported rather than assumed harmless)';
    }
    // The two early-deny paths just below (a MISSING or CORRUPT attribution
    // record) return BEFORE the "on every path" stderr disclosure at the end of
    // this block would fire, so without this they would omit that the record
    // consulted was the legacy SHARED per-run file (Codex review, the mirror of
    // the (B) F1 lesson: degraded-loud on EVERY path, deny paths included). When
    // the key was unusable, the record's very absence or corruption IS a
    // degraded-mode observation, so the deny says so. Verdict-safe: text only, on
    // an already-DENY path.
    const sharedNote = attributionShared
      ? ` DEGRADED MODE — the record consulted here is the legacy SHARED per-run attribution file, not one keyed to this call: ${attributionShared}. Its absence or corruption is itself a degraded-mode observation, not necessarily a Pre that never ran.`
      : '';
    if (!existsSync(dPath)) {
      // Same posture as the missing (B) baseline: unverifiable attribution denies.
      // Reached when Pre did not run, when a run boundary moved the runId between
      // Pre and Post, or when a Pre written by an OLDER bundle predates this file.
      deny(
        environmentDefectDenial(
          'H17',
          `attribution record '${dPath}' absent at Post — cannot tell this command's writes from pre-existing ones; failing closed (P5). ` +
            `If a run started or completed between Pre and Post, the runId in the filename moved; rerun the command.` +
            sharedNote,
          { agentId: input.agent_id }
        )
      );
    }
    let recordedDirty;
    try {
      // BOUNDED (board 55fcccac clause 4): os.tmpdir() is writable by the very
      // command being audited, so an oversize record here could OOM the guard
      // outside its own control flow. Size-refused before allocation; the throw
      // lands on the SAME corrupt-record deny below, unchanged.
      recordedDirty = readBoundedJsonFile(dPath, MAX_RECORD_BYTES, 'attribution record');
    } catch {
      deny(
        environmentDefectDenial('H17', `attribution record '${dPath}' corrupt/unparseable — cannot attribute writes; failing closed (P5).` + sharedNote, {
          agentId: input.agent_id,
        })
      );
    }
    // LIFECYCLE-BOUND (P4, board 489554d4): a PER-CALL attribution record's life
    // ends with the Post that read it — the paths are already in memory, so the
    // unlink is best-effort and can never change the verdict, and the validation
    // below runs on `recordedDirty` in memory, not on the file. The legacy per-run
    // file is deliberately left alone: it is not this call's to consume (a
    // concurrent lane may still need it) and the next Pre overwrites it as before.
    if (callId) {
      try {
        rmSync(dPath, { force: true });
      } catch {
        /* leaked temp record only; the attribution already happened in memory */
      }
    }
    // DEGRADED-LOUD ON EVERY PATH (board 489554d4), the (A) mirror of
    // `baselineShared`'s stderr disclosure: the moment the attribution record fell
    // back to the SHARED per-run file, say so — allow path included — because the
    // laundering a shared record admits (a genuinely pre-dirty path missing
    // from an overwritten record denied + latched as this command's write)
    // must never be inferred from silence. Best-effort/wrapped so a throwing
    // stderr can never flip the verdict.
    if (attributionShared) {
      try {
        process.stderr.write(
          `H17: DEGRADED (A) ATTRIBUTION — this Bash call carries no usable \`tool_use_id\`, so the attribution record it compared against was the ` +
            `legacy PER-RUN, RUN-KEYED file SHARED by every concurrent lane in this run, not one keyed to this call. A concurrent lane's Pre could have ` +
            `OVERWRITTEN it after this lane's Pre ran — in which case a genuinely pre-dirty path MISSING from it is treated as this command's write and ` +
            `denied + latched (nothing restores since v6.0). The verdict stands; what is unverifiable is that the pre-dirty set it trusted belonged to this call. (board 489554d4)\n`
        );
      } catch {
        /* best-effort trace — a failed write must never change the verdict */
      }
    }
    // VALIDATE AND NORMALIZE EVERY ENTRY before the set is trusted — the same
    // posture the per-call STATE record's keys already get (validateStateKey),
    // and it became load-bearing when coverage went ancestor-aware (board
    // 7dd39b85): the recorded set no longer answers only "is this exact path
    // dirty" but "does a recorded ancestor PROTECT this path from restore", so
    // an entry that fails to match is no longer inert — it is a conductor's
    // file DELETED. A trailing slash is the measured shape: `hooks/newdir/`
    // does not cover `hooks/newdir/a.mjs`, because every candidate the walk
    // builds is a boundary slice with no trailing slash. Pre always strips
    // (dirtyTrackedRels), so a divergent entry means a corrupt or tampered
    // record, and a record that cannot be trusted denies rather than quietly
    // protecting less than it claims to (P5).
    if (!Array.isArray(recordedDirty)) {
      deny(
        environmentDefectDenial('H17', `attribution record '${dPath}' is not an array of paths — cannot attribute writes; failing closed (P5).`, {
          agentId: input.agent_id,
        })
      );
    }
    for (const entry of recordedDirty) {
      const norm = typeof entry === 'string' ? entry.replace(/\/+$/, '') : '';
      // EVERY SEGMENT, not just the trailing slash. `hooks/newdir/.` and
      // `hooks//newdir` are non-empty strings that survive the strip and then
      // match nothing the boundary walk builds, which withdraws coverage just
      // as silently as the trailing-slash shape did — and the deny that the
      // unmatched entry eventually triggers arrives AFTER the sweep has already
      // deleted the child, because the sweep visits current porcelain entries
      // first. Refusing HERE is what makes the refusal safe: it lands before
      // the sweep runs, so nothing has been restored yet. `..` is rejected for
      // the ordinary traversal reason. NOT rejected: a backslash — on POSIX it
      // is an ordinary filename character, and normalizing it (as
      // validateStateKey does for the state record's keys) would produce a key
      // that no longer matches preState's and wedge every sweep touching such
      // a file.
      const segments = norm ? norm.split('/') : [];
      const malformed = !norm || segments.some((s) => s === '' || s === '.' || s === '..');
      if (malformed) {
        deny(
          `H17: crafted attribution record entry rejected (${JSON.stringify(entry)} — not a well-formed repo-relative path: empty, '.', '..' or an empty segment). ` +
            `An entry that cannot be matched silently withdraws restore protection from everything under it, so it is refused BEFORE the sweep runs; ` +
            `no write performed, failing closed (P5). NOTE the limit of this check: it rejects malformed SHAPES, and cannot detect a tampered entry that ` +
            `names a different WELL-FORMED path — that residual is the forged-record class decision 2422e76a already accepts.`
        );
      }
      // Beyond the malformed-SHAPE check above, mirror the per-call STATE
      // record's key posture (validateStateKey, AC10/AC14) on this loaded entry:
      // it must be a repo-relative POSIX path CONTAINED under the project root —
      // no absolute path, no drive prefix, no NUL, no traversal resolving out
      // (board 1f4b7af0 item 2). The attribution record became a PROTECTIVE input
      // when coverage went ancestor-aware (board 7dd39b85): a recorded ancestor
      // EXEMPTS its descendants from restore, so an entry that fails validation
      // must DENY — the stated invariant "a recorded path failing key validation
      // denies" — never be silently added to a set where it matches no
      // enforcement predicate and is quietly ignored. validateStateKey is used
      // here ONLY as a validator: its backslash-normalized RESULT is discarded and
      // the original backslash-preserved `norm` is what enters preDirty, because
      // preDirty keys are matched against raw porcelain paths and normalizing a
      // POSIX backslash would wedge every sweep touching such a file (the same
      // reason stated above for not normalizing backslashes here).
      if (!validateStateKey(cwd, norm)) {
        deny(
          `H17: crafted attribution record entry rejected (${JSON.stringify(entry)} — not a repo-relative path contained within the project root: ` +
            `absolute, drive-prefixed, NUL-bearing, or escaping the root). A recorded path that fails key validation is a PROTECTIVE input that cannot be ` +
            `trusted, so it is refused BEFORE the sweep runs rather than silently ignored (board 1f4b7af0 item 2); no write performed, failing closed (P5).`
        );
      }
      preDirty.add(norm);
    }

    // The PER-CALL Pre-STATE record (7021526c). Present and valid -> the
    // pre-dirty branch below COMPARES instead of denying blindly. Absent or
    // corrupt -> AC9 fail-closed (a pre-dirty path whose Pre state cannot be
    // read is exactly as unverifiable as it ever was). No usable tool_use_id ->
    // the record was never written, so the OLD blanket denial stands and says so.
    const key = callId;
    if (!key) {
      degradedReason =
        'this hook call carries no usable `tool_use_id` (absent, empty, or not a string), so there is no per-call Pre-STATE record to compare against — ' +
        'and H17 will NOT fall back to a per-run key, because one shared record lets a second lane adopt the first lane\'s tampered bytes as its own baseline';
    } else {
      const sPath = stateFile(cwd, runId, key);
      if (!existsSync(sPath)) {
        deny(
          environmentDefectDenial(
            'H17',
            `per-call Pre-STATE record '${sPath}' absent at Post — the pre-existing dirt cannot be compared against its state at Pre; failing closed (P5). ` +
              `Same causes as a missing attribution record, plus one more: the tool_use_id carried at Pre and at Post must be the SAME Bash call's.`,
            { agentId: input.agent_id }
          )
        );
      }
      let recorded;
      try {
        recorded = readBoundedJsonFile(sPath, MAX_RECORD_BYTES, 'per-call Pre-STATE record'); // BOUNDED, board 55fcccac clause 4
      } catch {
        deny(
          environmentDefectDenial('H17', `per-call Pre-STATE record '${sPath}' corrupt/unparseable — cannot compare pre-existing dirt; failing closed (P5).`, {
            agentId: input.agent_id,
          })
        );
      }
      if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) {
        deny(
          environmentDefectDenial('H17', `per-call Pre-STATE record '${sPath}' is not a path->state object — cannot compare pre-existing dirt; failing closed (P5).`, {
            agentId: input.agent_id,
          })
        );
      }
      // Validate EVERY key AND EVERY VALUE before the record is trusted (AC10
      // posture + review finding 4): the audited agent can write arbitrary
      // bytes into os.tmpdir(), so a crafted record is conduct, not
      // environment. A MAP, never a plain object (finding 4(b)): copying parsed
      // keys into an object routes an own `__proto__` key through [[Set]] and
      // really does change the lookup's prototype, after which a real pre-dirty
      // path resolves an INHERITED state, compares "unchanged", and defeats the
      // absent-entry check. A Map has no prototype chain to poison.
      preState = new Map();
      for (const k of ownKeys(recorded)) {
        const norm = validateStateKey(cwd, k);
        if (!norm) {
          deny(
            `H17: crafted per-call Pre-STATE record key rejected ('${k}' — not a repo-relative path inside the project); no write performed, failing closed (P5).`
          );
        }
        const shapeError = stateShapeError(cwd, recorded[k], norm);
        if (shapeError) {
          deny(
            `H17: per-call Pre-STATE record '${sPath}' carries an unexpected per-path state shape (${shapeError}) — an unvalidated state can compare EQUAL to a tampered path, so it is refused; no write performed, failing closed (P5).`
          );
        }
        preState.set(norm, recorded[k]);
      }
      // Lifecycle-bound (P4): the record's life ends with the Post that consumed
      // it. Best-effort — a failed unlink must never change the verdict.
      try {
        rmSync(sPath, { force: true });
      } catch {
        /* leaked temp record only; the comparison already happened in memory */
      }
    }
  }

  // --- (A) TRACKED writes via git ---
  const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '-z'], { encoding: 'utf8' });
  if (status.error || status.status !== 0) {
    throw new Error(`git status --porcelain -z failed (status ${status.status}: ${status.stderr || status.error})`);
  }
  const postEntries = parsePorcelainZ(status.stdout);
  // THE SWEEP SET = the UNION of what git reports dirty NOW and what the record
  // says was dirty at Pre (review finding 1, CRITICAL — a fail-closed
  // violation). Iterating only the CURRENT status skipped every path that was
  // dirty at Pre and is CLEAN at Post, so it was never compared and never
  // denied: a command running
  // `git checkout HEAD -- hooks/h3-contract-gate.mjs` destroyed the conductor's
  // uncommitted enforcement work and exited 0. Dirty-at-Pre + clean-at-Post is
  // a STATE CHANGE like any other — it lands on the ordinary comparison below
  // (the bytes moved from the in-flight image to HEAD's) and reaches the deny,
  // so ONE code path governs and there is no special-cased unconditional
  // denial to keep in sync.
  // Keyed by the normalized rel (trailing slashes stripped) — nothing downstream
  // needs the raw porcelain form since the restore's deletion (v6.0).
  const sweep = new Set();
  for (const entry of postEntries) {
    for (const p of entry.paths) {
      const rel = p.replace(/\/+$/, '');
      if (rel) sweep.add(rel);
    }
  }
  for (const rel of preDirty) {
    if (typeof rel === 'string' && rel) sweep.add(rel);
  }
  // Current INDEX entries for the whole sweep set, in ONE chunked call — the
  // index term of the state comparison. Skipped entirely when there is no
  // record to compare against, so the degraded path keeps exactly today's
  // behaviour and gains no new failure mode. A git failure throws -> deny (AC9).
  let postIndex = new Map();
  if (preState) postIndex = indexEntriesFor(cwd, [...sweep]);
  for (const rel of sweep) {
    const isViolation =
      isEnforcementSurface(rel) ||
      matchesGlob(rel, 'hooks/**') ||
      (brief && !!scopeCheck({ brief, rel, amendments: (run.scope_amendments ?? []).map((a) => a.path) }).deny);
    if (isViolation) {
      // MEMBERSHIP IS ANCESTOR-AWARE (board 7dd39b85): the recorded set holds a
      // dirty untracked DIRECTORY as one collapsed path, so a swept path may be
      // covered by a recorded ANCESTOR rather than recorded itself. See
      // coveringPreDirtyPath for why coverage is computed per swept path here
      // and never expanded into the record at Pre.
      //
      // v6.0: the ORDERING HAZARD that used to be documented here — a covered
      // descendant destructively restored before its ancestor's comparison ran —
      // is gone WITH the restore. Coverage now decides only which DENIAL a path
      // gets (pre-dirty comparison vs in-window violation), never whether
      // anything is mutated, because nothing is.
      //
      // COVERAGE IS CONDITIONAL ON A WORKING STORE, stated because a reader
      // will otherwise take it as absolute. Under `storeErr` there is no runId
      // to key the attribution record on, so `preDirty` stays EMPTY by design
      // (see the comment above it): nothing is covered, and every
      // enforcement-surface dirty path — a covered descendant included — is
      // denied and latched as in-window. Coverage protects attribution only as
      // far as the record can be read at all.
      const coveringPre = coveringPreDirtyPath(preDirty, rel);
      if (coveringPre) {
          // Already dirty at Pre — not this command's write, and never reverted:
          // reverting here is what destroyed a conductor's uncommitted
          // enforcement-surface work and reported it as the agent's (f76d7c5c).
          //
        // Decision 7021526c: it is no longer DENIED merely for being dirty
        // either. The order is exactly (1) compare the recorded Pre STATE with
        // the CURRENT state — unchanged means the surface is verified BY
        // OBSERVATION and no stamp is consulted or needed; (2) changed ->
        // consult the stamp FRESH against the CURRENT state, PER PATH
        // (4d9b76e8's rule is general, not confined to the clean-at-Pre arm:
        // a stamp can only be written by a deliberate conductor-run CLI,
        // 6e132e19, so a match means the change is conductor-attested);
        // (3) otherwise deny. No arm restores — a pre-image restore across
        // overlapping Bash windows would clobber a concurrent lane's
        // legitimate write (board 0b848342 finding 1, deferred by decision).
        if (!preState) {
          // DEGRADED-LOUD: nothing to compare against, so the old blanket
          // pre-existing denial stands and names its reason below. Reached for
          // every RECORDED pre-dirty path, whether or not git still reports it
          // dirty (review finding 1, second half): populating this set only
          // while walking the current status let a command that CLEANED every
          // pre-dirty enforcement path leave it empty, so the safety net that
          // backs up the whole comparison failed OPEN.
          preExisting.push(rel);
          continue;
        }
        if (!preState.has(coveringPre)) {
          // The attribution record says this path (or the ancestor covering it)
          // was dirty at Pre and the state record has no entry for it — the two
          // disagree, so the write is unattributable. Fail closed (AC9); an
          // absent entry must NEVER read as "unchanged", and must never be
          // satisfiable through a prototype (finding 4(b): the lookup is a Map
          // for exactly that).
          throw new Error(
            `per-call Pre-STATE record has no entry for the pre-dirty path '${coveringPre}'` +
              (coveringPre === rel ? '' : ` (the recorded ancestor covering the swept path '${rel}')`) +
              ` — the attribution record and the state record disagree, so this command's writes cannot be told from pre-existing ones`
          );
        }
        let wasState = preState.get(coveringPre);
        if (coveringPre !== rel) {
          // Covered by a recorded ancestor: resolve the child's OWN recorded
          // state out of the ancestor's recursive children map (throws when the
          // recorded topology disagrees — AC9).
          const recordedChild = recordedDescendantState(wasState, coveringPre, rel);
          // RECORDED-ABSENT, not "created by this command". An absent entry in
          // the children map does NOT prove the audited command created the
          // path: pathState recurses but is not ATOMIC, so a conductor's
          // concurrent creation can predate the command and still be missing
          // from the map; and an agent that edits the temp record can delete a
          // child entry while leaving a structurally valid record. Restoring
          // under that ambiguity is exactly what this branch's overlapping-
          // window rule forbids (see the comment above). So synthesize the
          // absent state and run the SAME comparison: it compares CHANGED, and
          // stampCouldAttest refuses an absent -> present flip, so it lands in
          // `changedPreDirty` — DENIED and NOT restored.
          wasState = recordedChild ?? { exists: false, index: null };
        }
        // POST is where a tripped structural budget DENIES (board 55fcccac
        // clause 3), unlike Pre: here the command has already run and this walk
        // is the verification itself, so a tree too large to enumerate means
        // the writes are unverifiable. The WalkBudgetError is deliberately NOT
        // caught — it reaches the outer fail-closed catch, which denies (exit
        // 2) with the tripped budget named. That is strictly better than the
        // OOM/timeout it replaces: a killed hook exits non-2 and the platform
        // ALLOWS the write.
        const nowState = pathState(cwd, rel, postIndex, WALK_BUDGET, 0);
        if (sameState(wasState, nowState)) continue; // (1) verified by observation
        // (2) — THE STAMP CONSULT THAT STOOD HERE IS GONE (v6.0, dc616f69 R11 /
        // 78dc9bd6): a same-UID-forgeable stamp may explain a finding, never
        // exempt one, so a changed pre-dirty path now always lands on the deny.
        noteChangedPreDirty(rel); // (3) denied, LATCHED, and still not restored
        continue;
      }
      // v6.0 (dc616f69 R10/R15): an IN-WINDOW change on a clean-at-Pre path is
      // DETECTED, DENIED and LATCHED — the bytes are LEFT ON DISK exactly as the
      // command wrote them. The restore that stood here is DELETED, not narrowed:
      // no signal available to a same-UID hook in a shared worktree can prove
      // AUTHORSHIP, so a destructive rollback here could always clobber a
      // conductor's concurrent legitimate write (the measured f76d7c5c failure
      // class). The eager latch is what replaces the restore's cross-call
      // guarantee: without it the next Pre would record the surviving bytes as
      // pre-existing dirt and verify them BY OBSERVATION forever after — one
      // denial would buy a permanent adoption. FIX-A's fresh-stamp exemption
      // died with the restore for the same reason as the consult above.
      //
      // ONE FINDING PER PATH (AC17's force-add route, re-pinned by
      // h17-b-surface PIN 3 and caught red on this exact excision): a
      // (B)-surface path reaches this sweep only via `git add -f` (the trio is
      // gitignored, and none is tracked in HEAD), and the (B) collection will
      // meet the same path again. Route it to the ADDITION disposition — the
      // deduped producer both surfaces share — exactly as restoreTracked's
      // (B)-refusal arm used to, so the composed denial names it ONCE with the
      // human-facing plant wording, and the finding still survives a broken
      // store (where the (B) stage never runs). Were a (B)-trio path ever
      // COMMITTED, the (B) baselineDenied arm would carry that modification —
      // this route stays the addition route.
      if (isEnforcementSurface(rel)) {
        noteUnauthorizedAddition(rel);
        continue;
      }
      noteTrackedViolation(rel);
    }
  }

  // --- (B) gitignored BASELINE set via the Pre snapshot ---
  // Guarded on a working store (PIN5): the baseline file is keyed on the
  // store-resolved runId, so with no runId there is no honest baseline file to
  // consult — skipped rather than misread against the wrong run's snapshot.
  // The storeErr deny below still fires; only the (A) detect sweep above
  // (which needs no runId for its glob-only violations) runs regardless.
  if (!storeErr) {
    // PER-CALL when this call carries a usable tool_use_id (board 11609d1f);
    // the legacy per-run file only when it does not — and that fallback is
    // DISCLOSED ON EVERY PATH (a non-fatal stderr line at the end of the (B)
    // sweep, allow path included, plus a named part in any denial the (B) writes
    // compose — `baselineShared` below), never silent, because a shared baseline
    // is the laundering hole itself: one lane's Pre overwrites another's and a
    // tamper is adopted as the legitimate pre-image, and that tamper compares
    // EQUAL — so a disclosure gated on a violation would be silent when it matters.
    const bPath = baselineFile(cwd, runId, callId);
    if (!callId) {
      baselineShared =
        'this hook call carries no usable `tool_use_id` (absent, empty/whitespace, or not a string), so the (B) content baseline in play is the ' +
        'legacy PER-RUN, RUN-KEYED file SHARED by every concurrent Bash lane in this run instead of one keyed to this call — while it is shared, a ' +
        'second lane\'s Pre can overwrite it after this lane\'s command has already written, and the overwritten state would be adopted as this ' +
        'lane\'s legitimate pre-image (that is exactly why the per-call key exists, and why this fallback is reported rather than assumed harmless)';
    }
    if (!existsSync(bPath)) {
      deny(
        environmentDefectDenial(
          'H17',
          `Baseline '${bPath}' absent at Post (no Pre snapshot) — cannot verify the enforcement surface; failing closed (P5). ` +
            `Same three causes as a missing attribution record: Pre genuinely did not run, a run started or completed between Pre and ` +
            `Post so the runId in the filename moved, or realpathSync succeeded at one end and threw at the other (two project tags); ` +
            `plus one more since the baseline became per-call: the tool_use_id carried at Pre and at Post must be the SAME Bash call's. Rerun the command.`,
          { agentId: input.agent_id }
        )
      );
    }
    let baseline;
    try {
      baseline = readBoundedJsonFile(bPath, MAX_RECORD_BYTES, '(B) content baseline'); // BOUNDED, board 55fcccac clause 4
    } catch {
      deny(
        environmentDefectDenial('H17', `Baseline '${bPath}' corrupt/unparseable — cannot verify the enforcement surface; failing closed (P5).`, {
          agentId: input.agent_id,
        })
      );
    }
    // LIFECYCLE-BOUND (P4, board 11609d1f): a PER-CALL baseline's life ends with
    // the Post that read it — the bytes are already in memory, so the unlink is
    // best-effort and can never change the verdict. The legacy per-run file is
    // deliberately left alone: it is not this call's to consume (a concurrent
    // lane may still need it), and the next Pre overwrites it exactly as before.
    if (callId) {
      try {
        rmSync(bPath, { force: true });
      } catch {
        /* leaked temp record only; the comparison already happened in memory */
      }
    }

    // Validate EVERY key BEFORE any restore write — a bad key (traversal/absolute/
    // off-glob) is a crafted baseline; deny with NO out-of-tree write (AC10).
    // UNWRAPPED, deliberately (review finding F4), unlike the corrupt-baseline
    // branch one line up: a CORRUPT baseline (unparseable JSON) can only arise
    // from something damaging the file out from under the gate — an environment
    // defect. A CRAFTED key (well-formed JSON, but a key that is absolute, a
    // traversal, or off the (B) glob set) implies an AUTHOR: the same agent
    // whose Bash command this hook is auditing can itself write arbitrary bytes
    // to os.tmpdir() (no store/enforcement-surface guard covers that path), so
    // a hand-shaped payload here is conduct, not environment — the misconduct
    // framing (and its fail-closed-with-no-write remedy) stays correct.
    const valid = {};
    for (const key of Object.keys(baseline)) {
      const norm = validateBaselineKey(key);
      if (!norm) {
        deny(`H17: crafted baseline key rejected ('${key}' — not a repo-relative (B)-set path); no write performed, failing closed (P5).`);
      }
      valid[norm] = baseline[key];
    }

    const current = collectBaseline(cwd); // reading a swapped dir throws → outer catch → deny (AC9c)

    // EMPTY-AT-REST BASELINE IS UNVERIFIABLE, NOT "THE SET WAS EMPTY" (board
    // 880e0d7a). The audited agent can write arbitrary bytes to its OWN
    // os.tmpdir() records, so a well-formed, stable `{}` sitting there at Post is
    // reachable by CRAFT — and every current (B) file then reads as an
    // "unauthorized addition" and is deleted by the removal arm below, turning
    // this hook into the mass-delete of the very surface it protects. Cross-check
    // against the PRE PRODUCER (`collectBaseline`, the same function that just
    // built `current`): an initialized project always has `.claude/agents/**`, so
    // a validated key set that is EMPTY while the live surface is NOT is proof
    // the record does not describe this project — deny WITHOUT entering the
    // destructive arm, removing nothing.
    // DISTINCT FROM THE MID-READ TRUNCATION GUARD in readBoundedFromFd (exact-size
    // + re-fstat, Codex F4): that one catches a record torn WHILE it is being
    // read. This one catches a record that is already, stably, empty when the read
    // begins — the read succeeds and reports `{}` faithfully. Neither covers the
    // other.
    // GATED ON `current` BEING NON-EMPTY so it can never false-deny a project
    // that genuinely has no (B) surface: with nothing live there is nothing for
    // the removal arm to take, so there is no damage to prevent and no verdict to
    // change (P1).
    // READ THIS BEFORE THE PARAGRAPH ABOVE (added 2026-08-27 with the addition
    // ruling): the "mass-delete" the guard's prose and its denial string describe
    // is HISTORICAL — the addition arm no longer deletes anything, so a crafted
    // empty baseline can no longer erase the enforcement surface. The guard is
    // NOT redundant: without it every live (B) file is REPORTED as an
    // unauthorized addition and the call denies on a fabricated finding, which is
    // a mass FALSE REPORT and an unattributable denial. Both the prose and the
    // denial text below are left VERBATIM on purpose — the string is pinned by
    // scripts/tests/h17-baseline-integrity-redo.test.mjs (frozen), and it is
    // still true as written: nothing is removed.
    if (Object.keys(valid).length === 0 && Object.keys(current).length > 0) {
      deny(
        `H17: the (B) content baseline for this call records ZERO enforcement files while ${Object.keys(current).length} exist now ` +
          `(${Object.keys(current).slice(0, 8).join(', ')}${Object.keys(current).length > 8 ? ', …' : ''}). An initialized project always has a non-empty (B) set, ` +
          `so an empty baseline does not describe this project: it is UNVERIFIABLE, not evidence that the enforcement surface was empty at Pre. ` +
          `NOTHING WAS REMOVED — the removal arm is not entered on an unverifiable baseline, because trusting one would delete every enforcement file ` +
          `as an "unauthorized addition". These records live in os.tmpdir() and are writable by the audited command, so a crafted baseline is conduct, ` +
          `not environment; failing closed (P5). Exit contract-violated, never route around.`
      );
    }

    // (B) DETECT-AND-DENY — RULING D of decision 532a4383, as refined by fac9a69b.
    // A (B) path whose state differs from this call's Pre baseline is ALLOWED only
    // where a TRUSTED stamp entry attests its CURRENT bytes (or its continued
    // ABSENCE). Otherwise it is DENIED and THE BYTES ARE LEFT EXACTLY AS THE
    // COMMAND WROTE THEM — never restored, never recreated, never truncated or
    // rewritten by H17 itself.
    // WHY THE RESTORE WENT, kept here because a ruling stripped of its reason gets
    // re-opened: the (B) restore's only write primitive truncated IN PLACE, so a
    // (B) path replaced by a HARDLINK to a file outside the repository made the
    // "restore" write baseline bytes straight through the shared inode onto an
    // arbitrary outside file. That is not a name-resolution bug descriptor pinning
    // can close — a hardlink defeats pinning by not using a name at all — and the
    // asymmetry that justifies the (A) restore does not hold here: (A) reverts to
    // HEAD, a recoverable source of truth git can hand back, while a (B) pre-image
    // lives only in an os.tmpdir() record the audited command can itself write.
    // Detection is therefore the correct disposition for the whole (B) surface,
    // which is why the modify/delete arms now join the ADDITION arm rather than
    // keeping a delete-free write primitive alive beside it.
    // ORDERING NOTE: `stampAttestsPath` already carries the `stampTrusted` gate, so
    // a stamp forged inside this window exempts nothing here either.
    for (const rel of Object.keys(valid)) {
      const changed = !(rel in current) || current[rel] !== valid[rel];
      if (!changed) continue; // (1) verified by observation — the stamp is never consulted
      // (2) conductor-attested. `stampAttestsCurrentBytes` resolves the DELETED case
      // too: an absent path attests iff the stamp carries `deleted:true` for it.
      if (stampAttestsPath(rel)) continue;
      noteBaselineDenied(rel); // (3) denied, deliberately NOT restored, and latched at this detection site
      baselineViolations.push(rel);
    }
    for (const rel of Object.keys(current)) {
      if (!(rel in valid)) {
        // NEW → DETECT AND REPORT, never delete (user ruling 2026-08-27). The
        // file is not read, not written, not truncated and not unlinked by this
        // arm: the ONLY thing that happens to an unexpected addition here is
        // that its path is recorded for the denial below. There is no delete
        // primitive in this scope to call — see the `removeUnder` gravestone for
        // the ruling, its justification, and the sabotage table.
        noteUnauthorizedAddition(rel); // deduped: the (A) sweep may have met it first
        baselineViolations.push(rel);
      }
    }

    // ---------------------------------------------------------------------
    // RULING 4 of decision bcd2cc09 — WHERE A STAMP EXISTS, TREAT ITS (B)
    // ENTRIES AS AN EXACT MANIFEST, ON EVERY CALL.
    //
    // WHAT WAS WRONG BEFORE, and it is one line up from here: the loop above
    // takes an early `continue` the moment `current[rel] === valid[rel]`, so the
    // stamp is consulted ONLY AFTER an in-window difference is detected. A stamp
    // that survives across a quiet call boundary was therefore never re-checked
    // against the surface it claims to describe, and a claim nobody re-checks is
    // not an attestation. The comparison below is SET-EXACT and runs regardless
    // of whether this window changed anything:
    //   * a stamped (B) path MISSING from the live surface           -> DENY
    //   * a stamped (B) path whose CURRENT BYTES differ from its hash -> DENY
    //   * a live (B) path with NO entry in the stamp                  -> DENY
    //   * exact match                                                 -> attested
    // ITS DURABILITY, STATED EXACTLY (corrected per fd9d24af RULING F — the
    // previous wording, "re-fires indefinitely while the stamp survives", was
    // false in two ways and both are checkable one screen from here): this arm
    // lives inside `if (!storeErr)` above, so a broken store SUSPENDS it
    // entirely; and the stamp is transient — H1 deletes it at every
    // SessionStart. So the re-firing is SESSION-BOUND, STAMP-PRESENT and
    // STORE-HEALTHY, not unconditional, and it persists no new state of its own.
    // That is exactly why it is weaker than the taint latch and why the latch
    // was needed for the other three triggers.
    //
    // THE HASH COMES FROM `current`, NOT FROM A FRESH DISK READ. `current` is
    // this sweep's own `collectBaseline` result — base64 of bytes already read
    // through a pinned, no-follow, classified-by-the-open descriptor. Hashing it
    // here reuses that single read instead of opening every (B) path a second
    // time, which would reintroduce exactly the classify->use window the S2 layer
    // exists to close (and, at consult time, the TOCTOU the single stamp read
    // closes on the other side).
    //
    // GATED ON `stampTrusted`: a stamp written inside this window attests
    // nothing anywhere in this sweep (the integrity check runs before every
    // consult), and it must not be promoted into a manifest either — it is
    // already denied and invalidated on its own terms.
    //
    // DELIBERATE NARROWING, DISCLOSED RATHER THAN BURIED: a stamp whose (B)
    // SUBSET IS EMPTY makes no (B) claim at all and is skipped instead of
    // denying every live (B) path. The producer enumerates every existing (B)
    // member, so a genuine stamp is never in this state; an (A)-only stamp is,
    // and treating "attests no (B) path" as "contradicts every (B) path" would
    // deny on a claim that was never made. This is a narrowing of the DENY
    // surface, and the cost is bounded: it exempts nothing, because a (B) path
    // that actually changed is still caught by the in-window arm above.
    {
      const entries = stampSnapshot.entries;
      if (stampTrusted && stampSnapshot.present && Array.isArray(entries)) {
        const manifest = stampBaselineManifest(entries);
        if (!manifest.usable) {
          manifestDenied.push(`the stamp's (B) manifest is unusable — ${manifest.reason}`);
        } else if (manifest.byPath.size > 0) {
          for (const [rel, entry] of manifest.byPath) {
            if (entry.deleted === true) {
              // A stamped DELETION attests iff the path is STILL absent —
              // mirrors both existing deleted arms; a resurrected path is not
              // the attested state and gets no partial credit.
              if (rel in current) manifestDenied.push(`the stamp attests '${rel}' as DELETED, but it exists on the live (B) surface now`);
              continue;
            }
            if (!(rel in current)) {
              manifestDenied.push(`the stamp attests '${rel}', but that path is MISSING from the live (B) surface`);
              continue;
            }
            const currentHash = createHash('sha256').update(Buffer.from(current[rel], 'base64')).digest('hex');
            if (currentHash !== entry.sha256) {
              manifestDenied.push(`the stamp attests '${rel}' as ${entry.sha256}, but its CURRENT bytes hash to ${currentHash}`);
            }
          }
          for (const rel of Object.keys(current)) {
            if (!manifest.byPath.has(rel)) {
              manifestDenied.push(`'${rel}' exists on the live (B) surface but has NO entry in the stamp — the stamp is not an exact manifest of the surface it claims to attest`);
            }
          }
        }
      }
    }
    // DEGRADED-LOUD ON EVERY PATH (board 11609d1f, reviewer F1). The deny-path
    // notice below fires only when the (B) comparison found a DIFFERENCE — but
    // the laundering failure the per-call key exists to close produces NO
    // difference (a shared baseline overwritten with already-tampered bytes
    // compares EQUAL and the call ALLOWs), so a disclosure gated on a violation
    // stays silent exactly when the shared baseline was most dangerous. Emit a
    // NON-FATAL stderr line the moment the fallback was taken — allow path
    // included — fire-and-continue: it changes no verdict, no allow/deny
    // outcome, and no key. This is the ONLY audible trace on a clean-allow
    // degraded call.
    if (baselineShared) {
      // WRAPPED (delta-review LOW): this write is UNGUARDED inside the outer
      // fail-closed try, so a throwing stderr (EPIPE/EBADF) on the clean-ALLOW
      // path would reach the outer catch and flip allow -> deny — a verdict
      // change. Wrapped so a best-effort trace can never alter the outcome.
      try {
        process.stderr.write(
          `H17: DEGRADED (B) VERIFICATION — this Bash call carries no usable \`tool_use_id\`, so the (B) content baseline it verified against was the ` +
            `legacy PER-RUN, RUN-KEYED file SHARED by every concurrent lane in this run, not one keyed to this call. A concurrent lane's Pre could have ` +
            `OVERWRITTEN it after this lane's command already wrote — in which case a tamper would compare EQUAL and be adopted as this call's legitimate ` +
            `pre-image. The verdict stands; what is unverifiable is that the pre-image belonged to this call. (board 11609d1f)\n`
        );
      } catch {
        /* best-effort trace — a failed write must never change the verdict */
      }
    }
  }

  // -------------------------------------------------------------------------
  // COMPOSE THE (B) TAINT LATCH CLAUSE — decision bcd2cc09 RULING 9, as
  // corrected by fd9d24af RULING A.
  //
  // THIS BLOCK PERSISTS NOTHING. By the time control reaches here the latch is
  // already on disk (or its failure is already recorded AND already on stderr):
  // every trigger latches at its own detection site through
  // `observeStampTamper`, `noteUnauthorizedAddition` and `noteBaselineDenied`.
  // All that is left is to turn the FIRST recorded outcome into the clause the
  // composed denial carries, so a denial that exits below still tells the reader
  // what the cross-call consequence is. THE OLD SINGLE-BLOCK PLACEMENT WAS THE
  // DEFECT: `deny()` is a hard `process.exit(2)`, so any of the fourteen earlier
  // denial sites discarded a detection that had already happened. The comment
  // that used to stand here asserted this position "sees every trigger"; it did
  // not, and the assertion is what made the placement feel checked.
  //
  // THE THREE TRIGGERS ARE NAMED BY THE RULING AND ARE NOT INTERCHANGEABLE:
  // `baselineDenied` OR `unauthorizedAdditions` OR `stampTampered`. Explicitly
  // NOT `baselineViolations`, which is populated ONLY inside the normal (B)
  // stage above and so misses the earlier force-added route — the (A) sweep's
  // `noteUnauthorizedAddition` for a protected path it met first, which is the
  // only route that survives a broken store (the whole (B) stage is skipped
  // under `storeErr`).
  //
  // EVERY `stampTampered` LATCHES, not only a failed invalidation.
  // `invalidateStamp` is best-effort by construction and says so, so a FAILED
  // deletion leaves a forged stamp standing for the next Pre to adopt — the same
  // adoption defect one level over. And on SUCCESS it still latches, because a
  // command that tried to manufacture its own attestation IS an incident whether
  // or not the cleanup worked.
  //
  // THE CLAUSE IS STILL COMPOSED BEFORE the `storeErr` deny below, so a broken
  // store cannot swallow the REPORT of an incident the (A) sweep already
  // detected and already latched.
  let latchNote = null;
  if (latchOutcome !== null) {
    latchNote = latchOutcome.set
      ? // SCOPE STATED EXACTLY, NOT OVERSTATED (fd9d24af, security review): this
        // used to say "every spawned-agent tool call is now denied BEFORE
        // EXECUTION", which is false today. H17 is registered in AGENT
        // FRONTMATTER on Bash only and is absent from hooks/hooks.json, so while
        // the latch stands it denies the agent's BASH calls and nothing else —
        // an agent's Edit, Write and Task calls are not gated by it. The global
        // PreToolUse '*' registration that would make the broader claim true is
        // a later slice and has not landed. Claiming coverage the code does not
        // have is anti-pattern 586bccdc at the user-facing surface: it stops the
        // next reader from looking.
        `H17: THE ENFORCEMENT TAINT LATCH IS SET (${taintLatchPaths().rel}). Repeated denial is established: every spawned-agent BASH call that H17 ` +
        `gates is now denied BEFORE EXECUTION until a CONDUCTOR clears it deliberately, because the bytes this sweep denied are still on disk and the ` +
        `next PreToolUse would otherwise adopt them as its own legitimate baseline. SCOPE, STATED EXACTLY SO IT IS NOT MISREAD AS MORE: H17 is ` +
        `registered on Bash in agent frontmatter and is NOT in hooks/hooks.json, so this latch gates spawned-agent Bash — it does not gate an agent's ` +
        `Edit, Write or Task calls. Presence of that file is the whole verdict — no field inside it can reduce enforcement, and H17 never clears it. ` +
        `Clearing is a separate conductor action that re-verifies the current enforcement surface deliberately.`
      : environmentDefectDenial(
          'H17',
          `THE CROSS-CALL ENFORCEMENT TAINT LATCH COULD NOT BE PERSISTED (${taintLatchPaths().rel}: ${latchOutcome.error}). The denial above stands and is ` +
            `UNCHANGED — but it is now a ONE-CALL denial only: without the latch on disk, the next PreToolUse re-collects the bytes this command left ` +
            `behind as its own legitimate baseline and allows them from then on. THE (B) SURFACE MUST BE TREATED AS TAINTED BY HAND until a conductor ` +
            `has inspected every path named above and re-attested the surface.`,
          { agentId: input.agent_id }
        );
  }

  // A store that failed to open/resolve earlier still owes its original deny
  // — but only now, AFTER the (A) detect sweep ran on whatever git alone
  // could tell it (so its detections are already recorded AND latched).
  // Denying any earlier is exactly the class that once silently dropped the
  // (A) findings on a broken store (PIN5). Wording is
  // HEAD's original outer-catch shape, class label preserved (review fix 3);
  // any restore performed under the broken store is named — a restore must
  // never be invisible (review fix 1).
  if (storeErr) {
    // The latch clause rides ALONG this denial rather than replacing it (RULING
    // 9: keep the original denial and ADD the clause). A broken store is the one
    // route on which an incident is detected and the (B) stage never runs, so
    // dropping the clause here would make exactly that case silent.
    const latchTail = latchNote ? `\n${latchNote}` : '';
    deny(
      environmentDefectDenial(
        'H17',
        `Enforcement verification failed (${(storeErr && storeErr.message) || storeErr}) — failing closed (P5).${latchTail}`,
        {
          agentId: input.agent_id,
        }
      )
    );
  }

  // Decision h17-enforcement-stamp-conductor-attested-dirt (6e132e19): before
  // firing the enforcement-surface-dirty denial for the PRE-EXISTING set (which
  // since 7021526c only fills on the degraded fallback — see above), give
  // a conductor-written stamp its one sanctioned exemption chance. Attested in
  // full → the pre-existing dirt is conductor-work-in-flight, not an
  // unverifiable defect; drop it from `preExisting` entirely so it composes no
  // denial. Anything short of full attestation (unlisted path, hash mismatch,
  // missing/corrupt stamp) changes nothing — the existing denial fires exactly
  // as before, optionally naming which path failed attestation when a stamp
  // was present but did not fully cover the dirt.
  let stampFailedPath = null;
  if (preExisting.length && stampTrusted) {
    const verdict = verifyStampAttestation(cwd, preExisting, stampSnapshot);
    if (verdict.attested) {
      preExisting.length = 0;
    } else if (verdict.stampPresent) {
      stampFailedPath = verdict.failedPath;
    }
  }

  // `unauthorizedAdditions.length` is a FIRST-CLASS deny trigger, not a rider on
  // `violations`: since the addition arm no longer mutates anything, this list is
  // the ONLY trace an unexpected addition leaves — drop it from this condition
  // and a planted file allows silently (sabotage S5 at the gravestone).
  // `baselineDenied.length` and `stampTampered` are FIRST-CLASS deny triggers, not
  // riders on `violations`: since the (B) arm stopped restoring, `baselineDenied`
  // is the ONLY trace a (B) modify/delete leaves, and an in-window stamp write
  // frequently changes nothing else on disk at all (that is exactly the two-call
  // laundering setup — call N plants ONLY a stamp). Drop either from this condition
  // and the corresponding attack allows silently.
  // `manifestDenied.length` is a FIRST-CLASS deny trigger for the same reason
  // the three above it are: a stamp that has stopped describing the surface it
  // claims to attest typically changes NOTHING in this window, so it leaves no
  // other trace at all. Drop it from this condition and the exact-manifest check
  // computes a finding nobody ever sees.
  if (
    violations.length ||
    unauthorizedAdditions.length ||
    baselineDenied.length ||
    manifestDenied.length ||
    stampTampered ||
    preExisting.length ||
    changedPreDirty.length
  ) {
    const parts = [];
    if (changedPreDirty.length) {
      // Decision 7021526c step 3, rewritten at v6.0: the stamp consult this
      // wording used to cite is DELETED (dc616f69 R11), so the denial may no
      // longer claim a stamp was checked — and the observed change now LATCHES
      // (Codex review HIGH), so the cross-call consequence is stated.
      parts.push(
        `H17: PRE-EXISTING dirty path(s) whose state CHANGED inside this command's window, and which are therefore NOT verifiable as untouched: ${changedPreDirty.join(
          ', '
        )}. ` +
          `The state recorded at PreToolUse (existence, file type, mode, symlink target, index entry, bytes) differs from the state now. The change was OBSERVED ` +
          `inside this command's window — which does not prove this command authored it, and that is exactly why nothing is reverted: restoring a pre-image could ` +
          `clobber a concurrent lane's legitimate write. The bytes stand as they are, the incident is LATCHED, and a conductor must inspect and clear it; ` +
          `exit contract-violated, never route around.`
      );
    }
    if (violations.length) {
      // WORDING IS LOAD-BEARING (v6.0, dc616f69 R13): the only true vocabulary
      // after the restore's deletion is observed / denied / latched / left on
      // disk. Never "reverted", "rolled back" or "neutralized" — describing an
      // action that no longer happens is anti-pattern 586bccdc at the
      // user-facing surface, and it would tell a human the write is gone while
      // it sits in their working tree.
      parts.push(
        `H17: write(s) OBSERVED INSIDE THIS COMMAND'S WINDOW outside its contract — DENIED, LATCHED, and LEFT ON DISK exactly as observed: ${violations.join(', ')} ` +
          `— exit contract-violated, never route around. NOTHING WAS REVERTED: H17 detects and denies, it does not restore (decision dc616f69 — in a shared ` +
          `worktree no hook can prove which PROCESS authored a write, and "observed in this window" is not proof this command wrote it; a rollback on that ` +
          `evidence could destroy a conductor's concurrent legitimate work). The bytes ` +
          `stand for a HUMAN to inspect; the taint latch keeps denying agent Bash until a conductor clears it, so the surviving write buys nothing but a red gate. ` +
          `A path may be here for any of three reasons: it is enforcement surface, it is under hooks/, or it failed the brief's scope check — ` +
          `only the last is amendable by scope (the first two are denied unconditionally, before the brief is consulted).`
      );
    }
    if (unauthorizedAdditions.length) {
      // WORDING IS LOAD-BEARING (user ruling 2026-08-27). It must state the
      // DISPOSITION: the gate denied and the file is still there. Since v6.0
      // that disposition is no longer unusual — every arm leaves bytes on disk —
      // but the rule stands: never describe an action the code did not take
      // (586bccdc), and never tell a human a plant is gone while it sits on
      // their disk.
      parts.push(
        `H17: UNAUTHORIZED ADDITION(S) DETECTED in the protected (B) enforcement surface, and LEFT IN PLACE ON DISK: ${unauthorizedAdditions.join(', ')} ` +
          `— exit contract-violated, never route around. Each path surfaced inside this command's window as newly git-visible (B)-surface material: a genuinely ` +
          `new file with no entry in this call's Pre-image baseline, or a pre-existing gitignored file force-added to the index (this sweep cannot tell the two ` +
          `apart; where the file existed at Pre, the (B) baseline comparison carries the byte-level verdict). ` +
          `The command is DENIED; the file(s) still sit on disk, BYTE-IDENTICAL to what was written there. H17 DETECTED the finding, it did not delete or rewrite anything: ` +
          `deleting is IRREVERSIBLE, and this sweep cannot tell a malicious plant from a legitimate file the conductor just created — a detector that deletes ` +
          `destroys real work on one false positive. A HUMAN must inspect each path above — take a plant off disk, or restore a tampered pre-existing file ` +
          `deliberately; H17 keeps denying agent Bash while it stands, so a finding left in place buys nothing but a red gate. Nothing of yours was undone.`
      );
    }
    if (baselineDenied.length) {
      // WORDING IS LOAD-BEARING, exactly as it is for the addition arm above,
      // and for the same reason: the gate denied and the change is still on
      // disk, so the message may assert detection only — never a write action
      // (586bccdc). The "reverted" vocabulary this comment used to warn against
      // borrowing is itself gone from `violations` since v6.0.
      parts.push(
        `H17: PROTECTED (B) ENFORCEMENT PATH(S) CHANGED IN THIS COMMAND'S WINDOW WITH NO CONDUCTOR ATTESTATION — DENIED, AND LEFT IN PLACE EXACTLY AS ` +
          `THE COMMAND LEFT THEM: ${baselineDenied.join(', ')} — exit contract-violated, never route around. These path(s) are gitignored enforcement ` +
          `surface (.claude/agents/**, .claude/settings*.json, .sterling/config.json); their state differs from this call's Pre-image baseline and no ` +
          `trusted conductor stamp attests the CURRENT state. H17 DETECTED the change and took NO WRITE ACTION on it: nothing was restored, recreated, ` +
          `truncated or rewritten, and whatever is on disk now is what your command put there. Restoring was REMOVED deliberately — the (B) pre-image ` +
          `lives only in a temp record the audited command can itself write, so restoring from it made this gate a writer of attacker-influenceable ` +
          `bytes, and its truncate-in-place write could be aimed THROUGH a hardlink at a file outside the repository. The sanctioned route is a ` +
          `conductor-run \`node scripts/enforcement-stamp.mjs\` BETWEEN Bash calls, never inside one. A HUMAN must inspect each path above.`
      );
    }
    if (manifestDenied.length) {
      // WORDING IS LOAD-BEARING, and it deliberately does NOT borrow the
      // in-window vocabulary of the two arms above: the ordinary case for this
      // arm is a call in which NOTHING changed, so "changed in this command's
      // window" would be a plain falsehood about the agent's own command
      // (anti-pattern 586bccdc). What is wrong here is the STAMP's claim, not
      // (necessarily) anything this command did.
      parts.push(
        `H17: THE ENFORCEMENT STAMP (${stampRel()}) IS NOT AN EXACT MANIFEST OF THE LIVE (B) SURFACE — DENIED, AND NOTHING WAS WRITTEN, RESTORED OR ` +
          `REMOVED: ${manifestDenied.join('; ')}. — exit contract-violated, never route around. Where a stamp exists, its (B) entries are compared against ` +
          `the whole current (B) set on EVERY call, not only when this window changed something (decision b-surface-adoption-point-closes-with-an-incident-` +
          `bound-taint-latch-not-a-persisted-manifest, RULING 4): a stamped path missing or hash-different denies, a live (B) path absent from the stamp ` +
          `denies, and only an exact match attests. THIS DENIAL RE-FIRES ON EVERY CALL WHILE THE STAMP SURVIVES, THE STORE IS HEALTHY AND THE SESSION ` +
          `LASTS — three real limits, stated rather than glossed: the comparison sits behind the store check, so a broken store suspends it; and H1 ` +
          `DELETES the stamp at every SessionStart, so this protection is session-bound and does NOT persist an unexplained mismatch past that point ` +
          `(decision taint-latch-persists-eagerly-at-detection-because-deny-is-a-hard-exit, RULING F). Within those bounds re-firing is the point — an ` +
          `attestation nobody re-checks is not an attestation. The sanctioned route is a conductor-run \`node scripts/enforcement-stamp.mjs\` BETWEEN Bash ` +
          `calls, which re-enumerates and re-hashes the entire (B) set; the agent must not write, repair or delete the stamp.`
      );
    }
    if (stampTampered) {
      // The stamp is the conductor's ATTESTATION INPUT, so a command that writes it
      // is trying to authorize itself. Stated plainly, including the one action H17
      // DID take here — the deletion — because an invalidation the reader does not
      // know about looks like a vanished file next time they go to use it.
      parts.push(
        `H17: THE ENFORCEMENT STAMP (${stampRel()}) CHANGED INSIDE THIS COMMAND'S WINDOW — DENIED, and the stamp has been ` +
          `${stampInvalidated ? 'INVALIDATED (DELETED)' : 'left in place ONLY because deleting it FAILED — treat it as untrusted and remove it by hand'}` +
          `. — exit contract-violated, never route around. The stamp is the CONDUCTOR'S ATTESTATION INPUT: H17 exempts a changed enforcement path whose ` +
          `current bytes match a stamp entry, so a command that writes the stamp is authorizing its own tamper. It was recorded at PreToolUse and ` +
          `recomputed now, and it moved in between. NO EXEMPTION FROM IT WAS HONOURED ANYWHERE IN THIS SWEEP — the integrity check runs BEFORE every ` +
          `consult, so a stamp forged in this window cannot excuse a single path in the same result. It is DELETED rather than merely refused because a ` +
          `denial with no cross-call consequence turns the NEXT PreToolUse into an adoption point: the forged file would survive, be snapshotted as a ` +
          `legitimate starting state, and attest a matching change one call later. The stamp is transient and reproducible (H1 deletes it at every ` +
          `SessionStart), so nothing durable was lost — the CONDUCTOR re-attests deliberately with \`node scripts/enforcement-stamp.mjs\` BETWEEN Bash ` +
          `calls. A conductor stamp written INSIDE an active agent window is observationally identical to this attack and is denied the same way.`
      );
    }
    // DEGRADED-LOUD ON THE (B) SIDE (board 11609d1f), the mirror of
    // `degradedReason` on the (A) side: the verdict above stands, but it was
    // reached against a baseline SHARED with every other lane in this run, so
    // the exposure is stated rather than left for a reader to infer. Composed
    // only when the (B) stage actually acted — a call that touched no (B) path
    // gains nothing from the notice (P1).
    if (baselineShared && baselineViolations.length) {
      parts.push(
        // "compared and restored" was accurate while every (B) difference ended
        // in a write or an unlink. Since the addition arm only DETECTS (user
        // ruling 2026-08-27), `baselineViolations` mixes restored paths with
        // additions nothing touched, so the verb narrows to what is true of all
        // of them: they were COMPARED against the shared baseline.
        `H17: DEGRADED (B) VERIFICATION — the (B)-set path(s) above (${baselineViolations.join(', ')}) were compared against a SHARED ` +
          `PER-RUN baseline, not one keyed to this Bash call: ${baselineShared}. The verdict stands; what is degraded is the confidence that the ` +
          `pre-image compared against was this call's own.`
      );
    }
    // DEGRADED-LOUD ON THE (A) SIDE (board 489554d4), the mirror of the (B) block
    // above: a path attributed to this command while the attribution record was
    // the shared per-run file may have been PRE-EXISTING dirt missing from an
    // overwritten record rather than this command's write. Composed only when the
    // (A) stage actually attributed something (P1). Since v6.0 the exposure is a
    // FALSE ATTRIBUTION (a wrongly denied + latched path), no longer data
    // destruction — nothing restores.
    if (attributionShared && violations.length) {
      parts.push(
        `H17: DEGRADED (A) ATTRIBUTION — the tracked path(s) denied above (${violations.join(', ')}) were attributed to this command against a ` +
          `SHARED PER-RUN attribution record, not one keyed to this Bash call: ${attributionShared}. The verdict stands; what is degraded is the ` +
          `confidence that a denied path was this command's own write rather than pre-existing dirt missing from an overwritten shared record.`
      );
    }
    if (preExisting.length) {
      // ENVIRONMENT DEFECT, not misconduct (decision f76d7c5c, review finding
      // F3): this state existed BEFORE the command ran, by construction never
      // the calling agent's doing — yet the old wording read as misconduct
      // and prescribed remedies (commit/revert) the agent cannot perform (no
      // Bash path to the enforcement surface, H15/H3 deny it). h17 always
      // short-circuits to allow() when input.agent_id is absent (line ~155),
      // so the audience here is unconditionally an agent — no conductor case
      // to compose with F2.
      parts.push(
        environmentDefectDenial(
          'H17',
          // "or inside one that was" is load-bearing since coverage became
          // ancestor-aware (board 7dd39b85): a path here may be a DESCENDANT of
          // a recorded dirty directory rather than recorded itself, and for a
          // file the command genuinely created inside such a directory the bare
          // claim "already dirty before this command" is false. The disposition
          // is unchanged and still correct — not attributed, not reverted —
          // but a denial that states a falsehood about the agent's own write is
          // exactly the misdirection the discriminator rule forbids.
          `PRE-EXISTING change(s), already dirty before this command (or inside a directory that was) and therefore NOT attributed to it and NOT reverted: ${preExisting.join(', ')}. ` +
            `Nothing of yours was undone. The command is still denied because the enforcement surface cannot be verified while it is dirty from outside ` +
            `(the conductor's own work, e.g. a mid-run bundle rebuild). This disposition — not attributed, not reverted — is governed by decision f76d7c5c.` +
            // DEGRADED-LOUD (7021526c): since the per-call Pre-STATE record
            // landed, this blanket denial fires ONLY when there is no record to
            // compare against — so it must say which input it lacked, or the
            // degrade is silent and indistinguishable from the old behaviour.
            (degradedReason ? ` This blanket denial is a DEGRADED FALLBACK: ${degradedReason}.` : '') +
            (stampFailedPath ? ` A conductor-attested stamp exists but does not attest '${stampFailedPath}' — no exemption.` : ''),
          { agentId: input.agent_id }
        )
      );
    }
    // THE LATCH CLAUSE IS LAST AND IS NEVER OMITTED WHEN IT EXISTS (RULING 9).
    // On the SET path it tells the reader that the denial now has a cross-call
    // consequence; on the FAILED-SET path it is an environment-defect clause
    // saying the latch could NOT be persisted and the surface must be treated as
    // tainted by hand. Never the reverse — claiming repeated denial was
    // established when it was not is precisely the false-action-claim the ruling
    // forbids here.
    if (latchNote) parts.push(latchNote);
    deny(parts.join('\n'));
  }
  allow();
} catch (e) {
  // Universal fail-closed catch-all: anything unforeseen during an active agent
  // run denies (exit 2), never a non-blocking exit 1. This branch is reached
  // only by UNEXPECTED internal failures (git errors, fs errors, a corrupt
  // store) — never by an actual verified contract violation, which denies
  // explicitly above with its own contract-violated wording untouched.
  deny(
    environmentDefectDenial('H17', `Enforcement verification failed (${(e && e.message) || e}) — failing closed (P5).`, {
      agentId: input.agent_id,
    })
  );
}
