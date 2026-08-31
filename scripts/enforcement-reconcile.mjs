// scripts/enforcement-reconcile.mjs — THE RECONCILIATION CLEARER for H17's (B)
// surface taint latch. SLICE S4r, PART B (board 13d5f6e3).
//
// RULING 5 of decision b-surface-adoption-point-closes-with-an-incident-bound-
// taint-latch-not-a-persisted-manifest (knowledge_get bcd2cc09), refined by
// Rulings R2/R3 of h17-global-registration-is-gated-on-a-live-subagent-delivery-
// probe-and-the-clearer-ships-first (knowledge_get b3cfdbc5).
//
// ===========================================================================
// S4 REWORK (decision b-baseline-hash-list-concrete-design, knowledge_get
// fe861066) — THE ENFORCEMENT STAMP IS DELETED AND A PERSISTENT BASELINE HASH
// LIST IS THE (B) COMPARATOR. Decision h17-demotes-to-tripwire-with-minimal-b-
// hash-list (78dc9bd6) demotes H17 from security boundary to TRIPWIRE and
// deletes `scripts/enforcement-stamp.mjs` outright. THIS FILE IS THE ONLY
// SANCTIONED MINTER of the replacement (fe861066 D2) and its only reader.
//
//   .sterling/enforcement-baseline.json   (gitignored; DIRECTLY under
//     `.sterling/`, NOT under `.sterling/transient/` — persistent evidence does
//     not belong in a lifecycle-bound directory, which is what let H1's
//     SessionStart sweep destroy the stamp's cross-session value)
//   { version: 1,                          EXACTLY 1; anything else is malformed
//     minted_at: <ISO string>,             DIAGNOSTIC ONLY — never freshness and
//                                          never authority: an ancient minted_at
//                                          with an exact match still verifies
//     entries: [ {path, sha256}, ... ] }   a SORTED ARRAY, strictly ascending by
//                                          path (an ARRAY so a duplicate is
//                                          detectable without a raw JSON parser;
//                                          ties/dupes are a SHAPE defect), path
//                                          repo-relative POSIX inside
//                                          BASELINE_GLOBS, sha256 lowercase
//                                          64-hex. NO per-entry `deleted` and no
//                                          `at`: a path that is gone simply has
//                                          no entry.
//
// TWO MODES (fe861066 D5), and the difference is who accepts the surface:
//   VERIFY (default) — read the list, compare it to the current (B) surface for
//     EXACT set equality in both directions, ALSO prove the (A) tracked
//     enforcement surface clean, then discharge the latch. NO LIST AT ALL
//     REFUSES: there is nothing to verify against, and "looks self-consistent"
//     is not "was attested".
//   ADOPT (`adopt: true`) — the explicitly-named HUMAN-ACCEPTANCE operation.
//     It MINTS the list from the surface as it now is. With no latch it
//     initialises and removes nothing; with a latch it installs the list, binds
//     the INSTALLED file, and only then removes the latch. It PROCEEDS on (A)
//     dirt but names it LOUDLY, because accepting is what ADOPT is for.
//
// WHY MINTING AND CLEARING STAY ONE DELIBERATE ACT RATHER THAN TWO PROGRAMS.
// The deleted producer/clearer split existed to stop a BACKGROUND CHILD THAT
// OUTLIVES THE AUDITED BASH CALL from laundering a tamper: call N tampers the
// (B) surface and spawns a waiting child; H17's Post denies and sets the latch;
// the child runs the producer, stamps the TAMPERED bytes, and call N+1 accepts
// them forever. That property survives the rework and is why the list is minted
// ONLY here, ONLY under the conductor gate, and ONLY by an explicit `adopt`
// flag: a list appearing on disk NEVER clears a latch by itself (AC-R1's
// laundering pin), and default VERIFY never writes.
//
// THE CONSEQUENCE FOR THIS FILE'S PREDICATE, stated because it killed the first
// design and is easy to re-introduce: A LIST THAT EXACTLY EQUALS THE CURRENT
// (B) SURFACE IS NOT SUFFICIENT ON ITS OWN. "Self-consistent with whatever is on
// disk right now" is exactly what the laundering child manufactures. Exact
// equality is a NECESSARY condition this function checks; the SUFFICIENT part
// would have to come from the protocol around it — and per fe861066's HONESTY
// CLAUSE nothing in this repository supplies that half: `callerRole` is
// self-asserted and a same-UID actor can forge or adopt its own inputs. That is
// why AC-R2 refuses a MISSING list even though the surface is untouched and
// looks perfect: "looks fine" is not "was attested". Read the next paragraph
// before treating the missing half as a mere gap in wiring.
//
// THE (A)/(B) LATCH DOMAIN (fe861066 D5). ONE latch spans BOTH an (A)
// tracked-git-surface incident and a (B) list incident, so a (B)-only
// verification must not discharge an (A) one. Default VERIFY therefore ALSO
// requires the (A) surface — git-reported dirt on `hooks/**` UNION the shared
// `ENFORCEMENT_SURFACE` export (imported, never re-spelled) — to be clean, and
// REFUSES when it is not, however exactly the (B) list matches. Dirt on tracked
// paths OUTSIDE that union is NOT an (A) incident: a clearer that refused on any
// dirty working tree would be unusable mid-branch.
//
// `callerRole` IS A CALLER-SUPPLIED ASSERTION, NOT AN AUTHORITY BOUNDARY
// (decision 4b3183b8 R6). NOT a "pure function" argument either — this module
// reads the filesystem and UNLINKS the latch; the point is only that the value
// is supplied BY THE CALLER and checked against nothing. This is stated plainly because THIS FILE HAS
// TWICE BEEN CAUGHT CLAIMING MORE THAN IT DELIVERS: an earlier version of this
// very paragraph asserted that neither the stamp nor the clear "is reachable
// from an ordinary agent tool call". THAT WAS FALSE AS WRITTEN. The only export
// takes `callerRole` as an ORDINARY ARGUMENT and compares it to a string, and
// there is no authenticating wrapper anywhere in this repository. ANYONE ABLE TO
// RUN NODE UNDER THIS UID CAN `import` THIS MODULE AND PASS
// `callerRole: 'conductor'` — the same same-UID threat model the rest of this
// file assumes, which explicitly includes the background child that outlives an
// audited tool call, i.e. the exact actor the producer/clearer split exists to
// stop. The absence of a CLI arm does NOT prevent this; it removes a convenient,
// discoverable front door and nothing else. Hard-coding the assertion inside a
// publicly reachable wrapper would prove exactly as little.
//   WHY THE COMPARISON STAYS ANYWAY: it is fail-closed defence in depth. It
//   stops an unthreaded or careless caller inheriting the privilege by omission
//   (F2) and it makes the intended caller explicit at every call site. Defence
//   in depth is not authentication, and an assertion is not an identity.
//   WHAT A REAL BOUNDARY WOULD REQUIRE: a wrapper that INJECTS authorization
//   from SERVER-OWNED INVOCATION CONTEXT (the MCP server's own view of who is
//   calling), and `callerRole`/`callerAgentId` MUST NEVER APPEAR IN A PUBLIC
//   TOOL SCHEMA — a caller-supplied field only relabels the same self-assertion.
//   Until that wrapper exists the conductor-only property is INTENDED AND
//   UNENFORCED. Do not let a later reader upgrade it by reading this header.
//
// ACCEPTED RESIDUAL — WIDENED 2026-08-30 BY DECISION 4b3183b8 R2/R4. NOT A
// DEFECT TO SOLVE, AND NOT AN OVERSIGHT. READ THE WIDTH CAREFULLY: the residual
// is ANY PROCESS CAPABLE OF CONCURRENT MODIFICATION of the protected surface,
// its manifest, or their directory namespaces — NOT merely a prepared child that
// can rerun this protocol. The earlier, narrower wording was checked and
// REFUTED: WRITE CAPABILITY AND INVOCATION CAPABILITY ARE DISTINCT. A confined
// or already-running helper holding an inherited writable descriptor, or a
// narrowly brokered "save this file" capability, can modify a leaf after its
// final hash yet CANNOT spawn Node, import this module, or forge callerRole —
// so it exploits the race without being able to reproduce the protocol.
// ACCIDENTAL concurrent writers raise the identical correctness problem with no
// adversarial intent at all.
//
// THIS CLEARER IS A FAIL-CLOSED TRIPWIRE AND RECONCILIATION AID, NOT AN ATOMIC
// SECURITY BOUNDARY. It establishes that the surface MATCHES ITS BASELINE LIST
// AT THE MOMENT OF CHECKING. It does NOT establish that nothing capable of modifying
// the surface ran concurrently, and no sequence of userspace observations can:
// leaf A is confirmed, then rewritten while B..N are checked, and the retained
// descriptor still sees the same inode (decision 0ac7be95 R1). What the split
// buys is tripwire ECONOMICS, not a boundary — an ordinary single denial no
// longer launders itself for free. Codex is explicit (bcd2cc09) that under a
// same-UID threat model NO file latch and NO SQLite table can do better without
// an external authority or a secret the agent process cannot read.
//
// THE MECHANISM ONCE SCOPED TO CLOSE THIS — the all-tool latch gate, which was
// to supply enforced quiescence — DOES NOT SHIP AND DOES NOT CLOSE IT. Decision
// 4b3183b8: a PreToolUse gate is ADMISSION CONTROL, not quiescence; it cannot
// revoke already-approved calls, stop surviving children, or freeze an external
// editor. Do not let a future session quietly re-narrow this residual, and do
// not let one assume the gate fixed it.
//
// ORDER IS LIST FIRST, CLEAR LAST (fe861066 D5), and NO ATOMICITY IS REQUIRED
// PRECISELY BECAUSE EVERY INTERMEDIATE STATE STILL DENIES:
//   * valid list + surviving latch + crash = CONTINUED DENIAL, recoverable by
//     re-running this function. That is the LEGAL CRASH STATE for ADOPT, whose
//     install happens strictly before the removal walk.
//   * latch absent + crash before the list = SILENT ADOPTION. Unreachable,
//     because this file never removes a latch it has not just verified a list
//     against, and ADOPT installs before it unlinks.
// THE DURABILITY CLAIM, STATED HONESTLY (fe861066 D5): any crash before the
// confirmed latch removal leaves the latch logically authoritative, and a
// subsequent run recovers even if the rename was not durable.
// THE LATCH ALWAYS WINS over the list: an exact match is evidence that
// reconciliation MAY proceed, never proof that the outstanding incident was
// discharged.
//
// EXPOSURE. The board prefers a CONDUCTOR-ONLY MCP operation (`enforcement_
// reconcile`) over a CLI, and `scripts/tests/enforcement-reconcile.test.mjs`
// AC-R11 pins that no agent template ever grants that tool name. This file is
// therefore a PURE MODULE with no CLI arm and no top-level side effects: it is
// the core logic an MCP tool wrapper calls into. A bare CLI here would add an
// argv-driven, discoverable front door to a function whose only "gate" is a
// string its caller supplies — BUT DO NOT READ THE ABSENCE OF ONE AS A GATE: as
// the identity paragraph above states, `import`ing this module already reaches
// the same code path with the same self-asserted `callerRole`. Not shipping a
// CLI removes convenience and discoverability, NOT capability. AC-R10 holds a
// narrower property than "only the conductor can clear": it holds that a caller
// which DECLARES an agent identity is refused.
//
// ===========================================================================
// S4r REPAIR PASS — THE FIVE THINGS THIS FILE NOW DOES THAT IT DID NOT.
//
// F1 (CRITICAL, AC-R18/AC-R19) — THE VERDICT IS BOUND TO THE EVIDENCE IT WAS
//   COMPUTED FROM. The previous shape re-read the comparator, re-enumerated the
//   surface, recomputed a verdict — and then RELEASED EVERY DESCRIPTOR AND PIN
//   from those checks before starting a fresh latch-removal walk that validated
//   only the LATCH's own identity. Nothing bound the list or the (B) surface
//   across that interval, so an attacker who won the window substituted
//   TAMPERED bytes TOGETHER WITH A MATCHING ATTACKER LIST: self-consistent, so
//   a naive "verify once more" sees nothing, and the call returned cleared:true
//   for bytes nobody ever verified.
//   RE-VERIFYING MORE TIMES IS NOT THE FIX AND WAS NOT ADOPTED. The final
//   verification pass now RETAINS, for the rest of the call: the pinned
//   directory chain, an open descriptor on EVERY (B) leaf it hashed, and an
//   open descriptor on the baseline list it parsed (in ADOPT mode, on the
//   NEWLY INSTALLED list re-opened after the rename — retaining the OLD
//   descriptor across an atomic replacement would bind nothing). Immediately
//   before the unlink —
//   after the removal walk has already pinned `.sterling` and confirmed the
//   latch's identity, so the confirmation is the LAST thing that happens before
//   the irreversible act — `confirmBoundEvidence` proves, for each of those
//   retained descriptors:
//     (a) BYTES: re-hashing THE SAME DESCRIPTOR still yields the verdict's
//         sha256. A truncate-and-rewrite (which is what `writeFileSync` does —
//         it keeps the inode) changes those bytes and is caught here.
//     (b) IDENTITY: lstat of the leaf NAME through the RETAINED PINNED PARENT
//         still yields the dev/ino of the retained descriptor. A rename- or
//         replace-substitution leaves the descriptor holding the old (matching)
//         bytes, so only this half catches it. Neither half is redundant.
//     (c) MEMBERSHIP: re-listing each RETAINED DIRECTORY DESCRIPTOR still
//         yields the same (B)-relevant entry names. (a) and (b) are per-member
//         and cannot see a member APPEARING or DISAPPEARING; this half can.
//     (d) the same three properties for the BASELINE LIST itself.
//   The comparison target is the IN-MEMORY VERDICT, never the on-disk list —
//   which is exactly why a self-consistent substitution cannot satisfy it.
//
// F2 (HIGH, AC-R24) — THE IDENTITY GATE IS INVERTED AND FAILS CLOSED. It
//   formerly defaulted an ABSENT `callerAgentId` to "the conductor", mirroring
//   H17's hook convention where the payload is produced by the PLATFORM and
//   absence is genuinely meaningful. Here there is no MCP wrapper and no
//   production caller yet, so every clearance ran with the argument absent, and
//   any future wrapper that forgot to thread `agent_id` silently granted every
//   agent the clear. A clear now requires an EXPLICIT POSITIVE ASSERTION:
//   `callerRole === 'conductor'` (exact string) AND an ABSENT `callerAgentId`.
//   THE TWO ARGUMENTS HAVE OPPOSITE CONTRACTS, so read this as two rules, not
//   one: for `callerRole`, omitted, nullish, and truthy-but-wrong ALL REFUSE —
//   only the exact string clears. For `callerAgentId`, ABSENT MEANS EXACTLY
//   `null`, `undefined` or `''` — the three shapes a wrapper with no identity
//   to thread produces — and ONLY those three are accepted. NOT "falsy": the
//   check is an explicit three-way comparison, so `false`, `0` and `NaN` REFUSE
//   like any other supplied value. Anything else refuses because carrying an
//   agent identity while claiming the conductor role is the AC-R10 spoof.
//
// F3 (AC-R20) — THE (B) ENUMERATION IS BOUNDED. It formerly had no depth, entry
//   count, per-file or total-byte limit and read every file whole into memory,
//   twice per call. Every bound below is a LOUD REFUSAL, never a truncation or
//   a skip, and files are hashed in chunks from their own descriptor rather
//   than slurped. An UNENUMERABLE directory REFUSES; it is never swallowed as
//   empty, because an unknown surface is not an empty one.
//
// F4 (AC-R21) — A DIRECTORY THAT VANISHES BETWEEN readdir AND open REFUSES. It
//   was formerly treated as an empty listing, so a populated agents
//   subdirectory could be renamed out across both enumeration passes and
//   restored afterwards while the surviving visible set matched the baseline.
//
// F5 (AC-R5/AC-R7 + hardening) — EVERY REFUSAL IS ATTRIBUTABLE. Three different
//   conditions formerly returned `{cleared:false}` in wording no test could
//   tell apart, which is how AC-R15 was measured HOLLOW and AC-R16 was found to
//   be resolving to AC-R14's guard. The refusal families are now a CONTRACT
//   (see the test file's REASON VOCABULARY), and the paired families deliberately
//   do not share wording: widening one until it swallows its sibling re-opens
//   the hollowness the pins exist to close.
//
// ===========================================================================
// S4r SECOND REPAIR PASS — RULINGS R3, R4, R6 and R7 of decision
// the-clearer-is-a-tripwire-not-a-boundary-and-the-all-tool-latch-gate-is-what-
// makes-its-precondition-true (knowledge_get 0ac7be95).
//
// F6 (CRITICAL, R3) — THE RETAINED DIRECTORIES ARE NOW REBOUND TO THE LIVE
//   NAMESPACE. F1 retained descriptors; `pinChain` checked each component's
//   identity ONLY AT ACQUISITION and kept NO chain metadata for a second check,
//   so the final directory checks proved the contents of the OLD DIRECTORY
//   INODE — never that the live repository path still reaches it.
//   THE ATTACK: after the final verdict, rename `.claude` aside to
//   `.claude.verified` and install a NEW `.claude` holding tampered agent and
//   settings files. Every retained descriptor resolves through the DETACHED
//   verified tree, so identities and hashes match and the list is untouched —
//   and the latch is removed although the LIVE tree was never verified. The
//   identical trick on `.sterling` — the directory that DIRECTLY contains the
//   baseline list since fe861066 D1 — substitutes the manifest.
//   THE ABSENT-ROOT VARIANT IS WORSE BECAUSE IT NEEDS NO RENAME: when `.claude`
//   did not exist at verification, NO directory evidence was recorded at all, so
//   CREATING `.claude/settings.json` after the verdict was invisible to all
//   three binding properties.
//   THE FIX: EVERY DIRECTORY EDGE this call walks is retained as
//   {PARENT DESCRIPTOR, CHILD NAME, CHILD dev/ino} — root->`.claude`,
//   `.claude`->`agents`, every recursive agents edge, and root->`.sterling`
//   (which is now the edge DIRECTLY containing the baseline list AND the latch:
//   the old `.sterling`->`transient` edge died with the stamp's location, and
//   `transient/` is walked by nothing here) — plus the ANCHOR's own dev/ino; and
//   `confirmBoundEdges` requires, as part of the pre-unlink confirmation, that
//   `lstat(parent-fd/name)` STILL yields the retained child. An edge that was
//   ABSENT at verification retains EXPECTED ABSENCE and must still return
//   ENOENT, so a root CREATED after the verdict refuses instead of being
//   invisible.
//   RE-WALKING THE CHAIN BY NAME AT CONFIRMATION TIME WAS CONSIDERED AND
//   REJECTED (0ac7be95): the chain can be swapped DURING the re-walk, or the
//   expected name briefly restored for the check and swapped again afterwards.
//   Per-edge retention is both stronger and cheaper.
//   WHAT THIS DOES NOT DO, stated so nobody reads more into it: it does NOT
//   close R1, the general sequential-observation race, and is not meant to. No
//   sequence of userspace observations establishes an immutable global instant.
//   It converts PERSISTENT NAMESPACE SUBSTITUTION — which should never pass —
//   into that general limit. Adding further verification passes or awaiting
//   differently does not touch R1 and must not be attempted here.
//
// F7 (R4) — NATIVE WINDOWS REFUSES; IT NO LONGER DEGRADES. The win32 arms
//   address parents BY PATH, which retains the original TOCTOU and permits path
//   substitution between checks — a silently weaker guarantee on the platform
//   most Sterling users are on (decision windows-linux-parity). The entry point
//   now REFUSES on win32 and LEAVES THE LATCH PRESENT. The win32 arms below are
//   therefore UNREACHABLE from the only export; they are kept, not deleted, so
//   that a future native handle-relative implementation has the shape to fill
//   in, and they are marked at each site.
//
// F8 (R6) — THE PRE-UNLINK CONFIRMATION IS ASSERTED SYNCHRONOUS, NOT ASSUMED SO.
//   `confirmBoundEvidence` is deliberately NOT awaited (an await inserts a
//   microtask turn into the very window it closes). That is sound for a
//   synchronous callback that throws synchronously, and becomes a TOTAL BYPASS
//   the day someone makes it async — the ignored promise would reject into the
//   void while the unlink proceeded. `removeLatch` now REFUSES if `beforeUnlink`
//   returns a thenable. A comment alone was not enough; this is the assertion.
//
// F9 (R7) — EVERY BOUND IS ENFORCED BEFORE THE ALLOCATION IT BOUNDS. Four
//   bounds were checked only after the memory had already been committed, so the
//   advertised refusal arrived after the damage: `readdirSync` materialized a
//   whole directory before the 4096-entry count (now `opendirSync` + `readSync`,
//   counted per entry as it arrives); the confirmation re-listing had no count
//   check at all (now it has its own budget); the win32 hashing path read a file
//   whole before the 8 MiB per-file bound (now fstat-then-chunk like POSIX); and
//   the comparator read used `readFileSync(fd)` after an `fstat` size check, so
//   growth between the two allowed an arbitrary allocation (now a chunked read
//   that refuses the moment it passes the bound). EMFILE handling is UNCHANGED and
//   stays fail-closed — every required open happens before the unlink and an open
//   failure is a refusal.
// ===========================================================================
//
// TEST-ONLY SEAMS — THERE ARE SIX, and they are numbered here exactly as the
// test file numbers them (SEAM 1, 2, 3, 4, 4b, 5), because two different
// numbering schemes across two files is how a seam gets omitted from a count:
//   SEAM 1  `_testHookAfterEnumeration`    after the FIRST verdict, before the
//                                          final pass.
//   SEAM 2  `_testHookBeforeRemoval`       after the FINAL verdict, strictly
//                                          before the first syscall of the
//                                          removal walk.
//   SEAM 3  `_testHookBeforeDirectoryOpen` immediately before each discovered
//                                          (B) subdirectory is opened, receiving
//                                          its repo-relative forward-slash path.
//   SEAM 4  `_testHookBeforeConfirm`       inside the removal walk, immediately
//                                          before the bound confirmation.
//   SEAM 4b `_testHookInsideConfirm`       INSIDE `confirmBoundEvidence`.
//   SEAM 5  `_testForcePlatform`           the monotone platform override.
// The full contract for each is at the entry point. PRODUCTION CALLERS MUST
// NEVER PASS ANY OF THEM.
// ===========================================================================
//
// I/O DISCIPLINE. Every classification, read, the ADOPT install and the removal
// itself resolve through DESCRIPTOR-PINNED, NO-FOLLOW I/O, following the
// `withPinnedParent` / `classifyLeafAt` idiom of
// scripts/hooks/h17-bash-write-sweep.mjs (the reviewed one in this repo — the
// other former copy, scripts/enforcement-stamp.mjs, is DELETED by 78dc9bd6).
// THE PIN IS ACQUIRED BY WALKING, NEVER BY AN ABSOLUTE-PATH OPEN — anti-pattern
// descriptor-pin-defeated-at-acquisition-when-the-directory-fd-is-opened-by-
// absolute-path (knowledge_get 7760c328, severity BLOCK): O_NOFOLLOW guards only
// the FINAL component, so opening `<cwd>/.sterling` by pathname after a
// classification would let an intermediate swap re-aim the whole pinned
// sequence. Only the repo ROOT is resolved by name, and it deliberately FOLLOWS
// (`~/proj -> /mnt/data/proj` is an ordinary arrangement); that is the
// pre-existing, separately-ruled limit h17-repo-root-authentication-is-out-of-
// scope (knowledge_get f36eb854) covers, cited because this file shares the
// anchor SHAPE and the same reasoning.
//
// DELIBERATELY DUPLICATED, NOT SHARED: H17 is an esbuild-bundled standalone
// (invariant 4) and a new shared module under scripts/lib/ is outside this
// change's contract, so `pinChain` / `classifyLeafAt` / `assertSecureIoAvailable`
// exist here in H17's shape. The duplication is real and is SURFACED rather than
// hidden — the two files must stay in step. TWO THINGS ARE NOT DUPLICATED, and
// both are load-bearing: `matchesGlob` (imported from @sterling/schemas) and
// `ENFORCEMENT_SURFACE` (imported from scripts/hooks/lib/contract.mjs), so that
// "is this an enforcement path?" has exactly ONE definition here, in H17 and in
// H3. A second glob notion is precisely how an exact-set comparison rots into a
// subset one.
//
// TEST COMMAND: node --test scripts/tests/enforcement-reconcile.test.mjs

import {
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  statSync,
  statfsSync,
  opendirSync,
  readFileSync,
  readSync,
  writeSync,
  fsyncSync,
  renameSync,
  existsSync,
  unlinkSync,
  constants as FS,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { matchesGlob } from '@sterling/schemas';
import { ENFORCEMENT_SURFACE } from './hooks/lib/contract.mjs';

const REAL_WIN32 = process.platform === 'win32';

// ---------------------------------------------------------------------------
// F12 (SEAM 5) — THE PLATFORM ACCESSOR. `REAL_WIN32` IS READ IN EXACTLY ONE
// PLACE: HERE. Every platform arm in this file — the procfs preflight, the
// `pinChain` win32 branch, `classifyLeafAt`, `devOf`/`inoOf`, the two bounded
// readers, the backslash guards, the agents-walk handle, `openBaselineChildDir`,
// all three `bigint` lstat/stat options and the entry point's R4 refusal — asks
// `isWin32()`. That uniformity IS the guard: a seam that overrode the constant
// at ONE site while the others still read it directly would make the R4 refusal
// LOOK pinned while the arms it protects ran on the host's real platform, which
// is strictly worse than no seam at all.
//
// THE OVERRIDE IS MONOTONE — IT CAN ONLY EVER ADD WIN32-NESS, NEVER REMOVE IT.
// `_testForcePlatform` exists so decision 0ac7be95 R4 ("Windows refuses rather
// than degrades") is reachable from a POSIX host, and a test seam on a
// SECURITY module must be incapable of relaxing anything. So the accessor is an
// OR, not a substitution: on a real win32 host `REAL_WIN32` is true and NO value
// of the seam can make this function return false, so no test — and no future
// caller that stumbles onto the argument — can turn the R4 refusal into a clear
// on the platform it protects. The only direction the seam can move behaviour is
// TOWARD refusing, on a host where the refusal is not otherwise reachable.
// (This narrows the seam's advertised "used in place of process.platform"
// contract in exactly one direction, deliberately and disclosed here: forcing a
// NON-win32 platform on a native Windows host is a NO-OP rather than a
// degradation. Every arm the suite exercises — force the host's own platform,
// force 'win32' from POSIX — behaves as the contract states.)
//
// A DEPTH COUNTER, NOT A BOOLEAN, so that overlapping in-flight calls cannot
// leave the flag stuck or clear it early: it is set for exactly as long as at
// least one forcing call is running, and every increment has its decrement in a
// `finally`. The interleaving failure mode is therefore a SPURIOUS REFUSAL for a
// concurrent non-forcing call — fail-closed, like everything else here — and
// never a spurious clear.
// ---------------------------------------------------------------------------
let FORCED_WIN32_DEPTH = 0;
function isWin32() {
  return REAL_WIN32 || FORCED_WIN32_DEPTH > 0;
}

const PROCFS_FD_DIR = '/proc/self/fd';
const PROC_SUPER_MAGIC = 0x9fa0n;

// THE (B) SET — THE SHARED `ENFORCEMENT_SURFACE` EXPORT ITSELF, not a copy of
// its globs (fe861066 D1: dynamic membership under a FIXED surface definition;
// invariant 1: one definition, imported). The taint latch and the baseline list
// are DELIBERATELY NOT members: neither the incident marker nor the evidence may
// become part of the surface whose incident it records.
const BASELINE_GLOBS = ENFORCEMENT_SURFACE;

// THE (A) SET — the git-visible half of the ONE latch's domain (fe861066 D5
// LATCH DOMAIN). `hooks/**` is added HERE rather than in contract.mjs because
// that export deliberately excludes it (see its own comment: H3 self-protects
// the bundled hooks dir by absolute path and H17 pins `hooks/**` separately), so
// this union is the (A) scope stated once, in one place, on top of the shared
// definition rather than beside a re-spelled copy of it.
const A_SURFACE_GLOBS = Object.freeze(['hooks/**', ...ENFORCEMENT_SURFACE]);

const STERLING_DIR = '.sterling';
const DB_LEAF = 'sterling.db';
const LATCH_LEAF = 'enforcement-taint.json';
const LATCH_REL = `${STERLING_DIR}/${LATCH_LEAF}`;
// fe861066 D1 — DIRECTLY under `.sterling/`, never under `.sterling/transient/`:
// persistent evidence does not live in a lifecycle-bound directory, and the name
// deliberately shares nothing with the dead stamp's.
const LIST_LEAF = 'enforcement-baseline.json';
const LIST_REL = `${STERLING_DIR}/${LIST_LEAF}`;
const LIST_WHAT = `the baseline list '${LIST_REL}'`;
const LIST_VERSION = 1;
const CLAUDE_DIR = '.claude';
const AGENTS_LEAF = 'agents';
const AGENTS_REL = `${CLAUDE_DIR}/${AGENTS_LEAF}`;
const CONFIG_LEAF = 'config.json';
const CONFIG_REL = `${STERLING_DIR}/${CONFIG_LEAF}`;
const SETTINGS_GLOB = `${CLAUDE_DIR}/settings*.json`;

const CONDUCTOR_ROLE = 'conductor';

// A baseline list large enough to blow this process's memory is not a list worth
// trusting. Bounded like every other record H17 reads (board 55fcccac clause 4);
// over-budget is a REFUSAL, never a truncated parse.
const MAX_LIST_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// F3 — THE (B) ENUMERATION BOUNDS. Every one of these is a LOUD REFUSAL naming
// the bound it hit, never a truncation, a skip or a partial verdict: a surface
// this walk could not fully see is an UNKNOWN surface, and an unknown surface
// never discharges an incident.
//
// WHY THESE NUMBERS. The (B) surface is agent definitions plus two settings
// files — on this repo, eleven files totalling a few tens of kilobytes. The
// caps are two orders of magnitude above any legitimate shape, so hitting one
// means either a planted denial-of-service (millions of entries, a deeply
// nested tree, a multi-gigabyte file under `.claude/agents`) or a genuinely
// novel layout that deserves a human decision rather than a silent 30-minute
// hash of an attacker's payload.
//
// THE DISCLOSED COST, stated rather than buried: a bound makes some states
// UNRECONCILABLE. A project that legitimately grew past `MAX_BASELINE_FILES`
// cannot clear its latch until the bound is raised. That is the intended
// direction of failure — the alternative is an unbounded read loop an agent can
// aim at this process at will — but it is a real limit, not a free win.
//
// MAX_BASELINE_FILES IS ALSO AN FD BUDGET, and that coupling is deliberate: the
// F1 binding holds one descriptor open per (B) leaf plus one per directory for
// the life of the call, so the cap must stay comfortably under a default 1024
// soft `RLIMIT_NOFILE`. Raising it means checking that budget, not just the
// number. (An fd exhaustion would itself fail closed — the open refuses — so
// the failure mode is loud either way.)
// ---------------------------------------------------------------------------
const MAX_BASELINE_DEPTH = 16;
const MAX_BASELINE_DIRS = 32;
const MAX_BASELINE_FILES = 256;
const MAX_BASELINE_DIR_ENTRIES = 4096;
const MAX_BASELINE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BASELINE_TOTAL_BYTES = 64 * 1024 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;

// EVERY EXPECTED REFUSAL IS A RESOLVED VALUE, NOT A REJECTION. The one thing
// that must never happen is a CLAIMED SUCCESS, so this class exists to keep
// "refused for a reason we understand" distinct from "something unexpected blew
// up" in the code, while both land as `{cleared:false, reason}` at the boundary
// (item 5 of the contract: the latch stays and it fails LOUDLY).
class ReconcileRefusal extends Error {}
function refuse(reason) {
  return new ReconcileRefusal(reason);
}

function errText(e) {
  return (e && (e.code || e.message)) || String(e);
}

// ---------------------------------------------------------------------------
// SECURE I/O PREFLIGHT — a HARD REFUSAL, never an incidental filesystem error.
// Descriptor-relative resolution on Linux is spelled `/proc/self/fd/<fd>/<name>`,
// so WITHOUT a working procfs the pinned-chain design silently stops being what
// it claims. AUTHENTICATE THE FILESYSTEM, NOT ONE ENTRY: PROC_SUPER_MAGIC is a
// kernel fact a directory of decoy numeric symlinks cannot fabricate, and only
// procfs maps ARBITRARY descriptor numbers — which is the property the chain
// walk depends on, since it opens CHILD fds no finite probe could have
// pre-seeded. The fd round-trip is the complement: the magic says "this is
// procfs", the round-trip says "this particular node is an FD DIRECTORY".
// BIGINT dev/ino because a number-valued 64-bit file id truncates, and a
// truncated ino makes the identity comparison unsound.
// ---------------------------------------------------------------------------
function assertSecureIoAvailable(cwd) {
  if (isWin32()) return; // no procfs arm on win32 — see the disclosed residual at pinChain
  if (!existsSync(PROCFS_FD_DIR)) {
    throw refuse(
      `secure I/O unavailable: '${PROCFS_FD_DIR}' is absent, so the taint latch cannot be verified or removed through a pinned directory chain. ` +
        `The latch is LEFT IN PLACE and nothing was changed.`
    );
  }
  let vfs;
  try {
    vfs = statfsSync(PROCFS_FD_DIR, { bigint: true });
  } catch (e) {
    throw refuse(`secure I/O unavailable: '${PROCFS_FD_DIR}' could not be statfs'd to confirm it is procfs (${errText(e)}). The latch is LEFT IN PLACE.`);
  }
  if (vfs.type !== PROC_SUPER_MAGIC) {
    throw refuse(
      `secure I/O unavailable: '${PROCFS_FD_DIR}' is not on procfs (filesystem magic 0x${vfs.type.toString(16)}, expected 0x${PROC_SUPER_MAGIC.toString(16)}) — ` +
        `only the kernel's procfs maps ARBITRARY descriptor numbers, and an ordinary directory of numeric-named entries cannot, however many it pre-seeds. ` +
        `The latch is LEFT IN PLACE.`
    );
  }
  let fd = null;
  try {
    fd = openSync(cwd, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NONBLOCK);
    const anchored = `${PROCFS_FD_DIR}/${fd}`;
    const entry = lstatSync(anchored, { bigint: true }); // the fd entry ITSELF, unfollowed
    const through = statSync(anchored, { bigint: true }); // ... and what it resolves to
    const direct = fstatSync(fd, { bigint: true }); // ... versus what the descriptor actually holds
    if (!entry.isSymbolicLink()) {
      throw refuse(`secure I/O unavailable: '${PROCFS_FD_DIR}' exists but its descriptor entries are not the magic symlinks an fd directory is made of. The latch is LEFT IN PLACE.`);
    }
    if (through.dev !== direct.dev || through.ino !== direct.ino) {
      throw refuse(
        `secure I/O unavailable: '${PROCFS_FD_DIR}/<fd>' does not resolve to the object that descriptor holds (resolved dev/ino ${through.dev}/${through.ino}, ` +
          `descriptor ${direct.dev}/${direct.ino}) — present, but not a working descriptor directory. The latch is LEFT IN PLACE.`
      );
    }
  } catch (e) {
    if (e instanceof ReconcileRefusal) throw e;
    throw refuse(`secure I/O unavailable: '${PROCFS_FD_DIR}' could not be verified as a working descriptor directory (${errText(e)}). The latch is LEFT IN PLACE.`);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

// Close a descriptor on a path that may already be unwinding. A close failure
// with no primary exception pending IS the failure (a leaked fd marches toward
// an EMFILE fail-open); with one pending it must not displace the verdict.
function closePinned(fd, primary) {
  if (fd === null || fd === undefined) return;
  try {
    closeSync(fd);
  } catch (closeErr) {
    if (!primary) throw closeErr;
  }
}

// ---------------------------------------------------------------------------
// F1's LIFETIME PRIMITIVE. Descriptors this call must KEEP — the pinned chain,
// every (B) leaf, every walked (B) directory, the baseline list — live in a scope that
// is closed by the mechanical end of the operation, never by a remembered step
// (P4). A scope is what lets "the bytes I verified" stay reachable across the
// verdict, the test seam and the removal instead of being released the instant
// a helper returned.
// ---------------------------------------------------------------------------
class FdScope {
  constructor() {
    this.fds = [];
  }
  keep(fd) {
    if (fd !== null && fd !== undefined) this.fds.push(fd);
    return fd;
  }
  // EVERY DESCRIPTOR GETS ITS CLOSE ATTEMPT. Throwing from inside the loop
  // abandoned the remaining fds AND left `this.fds` untruncated, so ONE close
  // failure became a multi-fd leak — the opposite of what the throw is for
  // (a leaked fd marches toward an EMFILE fail-open). The first failure is
  // remembered and rethrown after the sweep, so the loud signal survives.
  closeAll(primary) {
    let firstFailure;
    for (let i = this.fds.length - 1; i >= 0; i--) {
      try {
        closeSync(this.fds[i]);
      } catch (closeErr) {
        if (firstFailure === undefined) firstFailure = closeErr;
      }
    }
    this.fds.length = 0;
    if (!primary && firstFailure !== undefined) throw firstFailure;
  }
}

async function withScope(fn) {
  const scope = new FdScope();
  let primary;
  try {
    return await fn(scope);
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    scope.closeAll(primary);
  }
}

// Open ONE child directory RELATIVE to an already-pinned parent. Returns null
// for 'absent'; every other non-directory verdict is a loud refusal, never a
// fallback that keeps walking.
function openChildDir(anchored, soFar, what) {
  try {
    return openSync(anchored, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (e) {
    const code = e && e.code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENXIO' || code === 'ENODEV' || code === 'EOPNOTSUPP') {
      throw refuse(
        `path component '${soFar}' (an ancestor of ${what}) is not a real directory (no-follow open failed: ${code}) — refusing to resolve through a ` +
          `symlink or other non-regular ancestor. The latch is LEFT IN PLACE.`
      );
    }
    throw refuse(`path component '${soFar}' (an ancestor of ${what}) could not be opened (${code || errText(e)}) — refusing to resolve through it. The latch is LEFT IN PLACE.`);
  }
}

// ---------------------------------------------------------------------------
// THE PRIMITIVE EVERY OPERATION HERE IS BUILT FROM. Walks `relDir` from a FRESH
// repo-root anchor, pinning each confirmed directory INTO `scope`, and returns
// the handle for the leaf directory. `{ handle: null, absentAt }` reports a
// vanished component — a reader must never CREATE anything, so there is no
// createParents arm at all: this file only verifies and unlinks.
//
// THE FDS ARE RETAINED IN THE CALLER'S SCOPE, not closed on return. That is the
// F1 repair: a chain released the moment the walk finished is a chain that
// binds nothing, and the whole CRITICAL was the gap between "verified" and
// "removed" that such a release opens.
//
// A FRESH ANCHOR PER WALK, DELIBERATELY, and this differs from H17 on purpose.
// H17 retains ONE root anchor for the life of a hook invocation and THROWS if a
// second cwd is offered, which is right for a one-shot process handling exactly
// one project. This function is a library entry point that may be called many
// times, for different projects, inside one long-lived process (an MCP server) —
// a cached anchor there would resolve a later project's paths through an earlier
// project's descriptor, which is a wrong-namespace resolution no descriptor pin
// can detect.
//
// WHAT THE WALK DOES *NOT* GUARANTEE, stated rather than implied: O_NOFOLLOW
// rejects redirection THROUGH A LINK; it says nothing about DIRECTORY-FOR-
// DIRECTORY substitution. The identity pass below closes the PERSISTENT form of
// that (rename `.sterling` away, put a different real directory at the name) by
// re-resolving every component through its own pinned parent and requiring the
// same dev/ino as `fstat` on the descriptor this walk holds. It PROVES that at
// verification time every component name still denotes the very inode this
// process pinned; it does NOT prove continuity, because a swap-and-swap-back
// before the check is invisible. Copied in shape from `withPinnedParent` /
// `openPinnedDir` in scripts/hooks/h17-bash-write-sweep.mjs, which is the
// reviewed idiom in this repo (anti-pattern 7760c328's RIGHT WAY names it) —
// copying the weaker of two available idioms into a clearer would be a defect,
// not a simplification.
//
// F6 — WHAT THIS WALK NOW RETAINS, and why acquisition-time identity alone was a
// CRITICAL. `edges` carries one record per DIRECTORY EDGE — the PARENT's pinned
// handle, the CHILD's name, and the child's dev/ino — and `root` carries the
// anchor's own dev/ino. Held for the life of the call, they are what lets
// `confirmBoundEdges` prove, immediately before the unlink, that the LIVE
// repository path still reaches the very inodes this walk pinned. Without them a
// retained descriptor keeps resolving through a tree that has been RENAMED OUT
// OF THE NAMESPACE, and every content check passes against a detached ghost.
// AN ABSENT COMPONENT IS EVIDENCE TOO: the walk records the edge it could not
// take as EXPECTED ABSENCE rather than recording nothing, because "nothing" is
// exactly what made the absent-root variant of the attack invisible.
// The chain's acquisition-time identity pass below is UNCHANGED and still runs
// on the absent path as well — an absence is only meaningful if the parent chain
// that observed it was itself confirmed.
//
// NATIVE WINDOWS HAS NO PARENT BINDING AT ALL (decision
// h17-windows-detect-and-abort, 2a69a8d7): Node cannot open a directory as a
// descriptor there and libuv ignores O_NOFOLLOW, so the win32 arm addresses the
// parent by path and the F1/F6 bindings would degrade to a path-addressed
// re-read. Under R4 of 0ac7be95 that degradation is NO LONGER ACCEPTED and the
// entry point REFUSES on win32, so this arm is unreachable from the only export;
// it is kept as the shape a native handle-relative implementation would fill in.
// ---------------------------------------------------------------------------
function pinChain(cwd, relDir, scope, what = `'${relDir}'`) {
  const segments = relDir.split('/').filter(Boolean);
  for (const name of segments) {
    if (name === '.' || name === '..' || name.includes('\0') || name === '') {
      throw refuse(`refusing to walk to ${what} — the component ${JSON.stringify(name)} of '${relDir}' is not a plain resolvable name. The latch is LEFT IN PLACE.`);
    }
  }
  if (isWin32()) {
    // UNREACHABLE win32 arm (F7): path-addressed throughout, no parent binding,
    // so it can retain no edges. The entry point refuses on win32 before any of
    // this runs.
    const dirAbs = segments.length === 0 ? cwd : join(cwd, ...segments);
    let kind;
    try {
      kind = lstatSync(dirAbs).isDirectory() ? 'dir' : 'other';
    } catch (e) {
      if (e && e.code === 'ENOENT') return { handle: null, fd: null, absentAt: relDir, edges: [], root: null };
      throw refuse(`${what} could not be classified (${errText(e)}). The latch is LEFT IN PLACE.`);
    }
    if (kind !== 'dir') throw refuse(`${what} is not a directory — refusing to resolve through it. The latch is LEFT IN PLACE.`);
    return { handle: dirAbs, fd: null, absentAt: null, edges: [], root: null };
  }
  assertSecureIoAvailable(cwd);
  // The ROOT is the one open that FOLLOWS (see the header): it is the trust
  // anchor handed to this function, never a component under test. O_DIRECTORY so
  // a root symlink pointing at a NON-directory still fails; O_NONBLOCK so a
  // fifo/device cannot BLOCK the open and hang the caller.
  let rootFd;
  try {
    rootFd = scope.keep(openSync(cwd, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NONBLOCK));
  } catch (e) {
    throw refuse(`the project root '${cwd}' could not be opened as a directory (${errText(e)}) — nothing was read or changed. The latch is LEFT IN PLACE.`);
  }
  // F6 — THE ANCHOR'S OWN IDENTITY. `cwd` is resolved BY NAME (the one open that
  // follows), so the root is exactly as substitutable as any component below it:
  // rename the project root aside, put another directory at the name, and every
  // retained descriptor in this call keeps resolving through the detached tree.
  // Retaining its dev/ino is what lets the confirmation compare a FRESH
  // resolution of the same name against the anchor this call actually walked.
  let root;
  try {
    const rootSt = fstatSync(rootFd, { bigint: true });
    root = { cwd, dev: devOf(rootSt), ino: inoOf(rootSt) };
  } catch (e) {
    throw refuse(`the project root '${cwd}' could not be identified after it was opened (${errText(e)}). The latch is LEFT IN PLACE.`);
  }
  let handle = `${PROCFS_FD_DIR}/${rootFd}`;
  let soFar = '';
  const chain = [];
  const edges = [];
  let absentEdge = null;
  let absentAt = null;
  for (const name of segments) {
    soFar = soFar ? `${soFar}/${name}` : name;
    const fd = openChildDir(`${handle}/${name}`, soFar, what);
    if (fd === null) {
      // F6 — AN ABSENCE IS EVIDENCE. Recorded as an edge that must STILL be
      // ENOENT at confirmation, not as a silent early return that records
      // nothing (which is what let a root created after the verdict pass).
      absentEdge = { parentHandle: handle, name, rel: soFar, expect: 'absent', dev: null, ino: null };
      absentAt = soFar;
      break;
    }
    scope.keep(fd);
    chain.push({ parentHandle: handle, name, fd, soFar });
    handle = `${PROCFS_FD_DIR}/${fd}`;
  }
  // THE IDENTITY PASS. lstat, not stat, so a symlink planted at the name
  // reports its OWN identity and mismatches rather than being resolved away.
  // It runs on the ABSENT path too: an absence observed through an unconfirmed
  // parent chain attests nothing.
  for (const link of chain) {
    let byName;
    try {
      byName = lstatSync(`${link.parentHandle}/${link.name}`, { bigint: true });
    } catch (e) {
      throw refuse(
        `path component '${link.soFar}' could not be re-resolved through its pinned parent to confirm it still denotes the directory this call pinned ` +
          `(${errText(e)}) — refusing to reconcile against a tree that is changing underneath it. The latch is LEFT IN PLACE.`
      );
    }
    const byFd = fstatSync(link.fd, { bigint: true });
    if (byName.dev !== byFd.dev || byName.ino !== byFd.ino) {
      throw refuse(
        `path component '${link.soFar}' NO LONGER DENOTES the directory this call pinned (name now dev/ino ${byName.dev}/${byName.ino}, pinned descriptor ` +
          `${byFd.dev}/${byFd.ino}) — a directory was substituted for another underneath the walk, which O_NOFOLLOW cannot reject because it is not a link. ` +
          `The latch is LEFT IN PLACE.`
      );
    }
    // F6 — retained AFTER the identity pass agreed, so an edge only ever carries
    // an identity this call has already confirmed twice-resolved.
    edges.push({ parentHandle: link.parentHandle, name: link.name, rel: link.soFar, expect: 'dir', dev: devOf(byFd), ino: inoOf(byFd) });
  }
  if (absentEdge) edges.push(absentEdge);
  if (absentAt !== null) return { handle: null, fd: null, absentAt, edges, root };
  // THE LEAF DIRECTORY'S OWN DESCRIPTOR, returned alongside its procfs handle so
  // the ADOPT install can `fsync` the DIRECTORY it renamed into. Deriving it by
  // parsing the handle string back into a number would be a second, unchecked
  // notion of the same fact.
  return { handle, fd: chain.length > 0 ? chain[chain.length - 1].fd : rootFd, absentAt: null, edges, root };
}

// CLASSIFY A LEAF BY OPENING IT, not by lstat-then-open. The lstat/open pair is
// itself a classify->use window: an lstat says "regular file", a racer swaps in
// a DIFFERENT regular file, and the open that follows acts on an object the
// classification never saw. Opening FIRST and deciding from the descriptor's own
// fstat removes the window — whatever the fd holds is what gets read, and
// O_NOFOLLOW means the fd can never be a symlink's target.
// EACCES IS NOT ABSENCE and is not silently swallowed here: it propagates as a
// refusal, because "cannot establish" is fail-closed (AC-R15). Only ENOENT is
// absence. The returned `fd` is the CALLER's to close or retain.
function classifyLeafAt(parentHandle, leaf) {
  const anchored = `${parentHandle}/${leaf}`;
  if (isWin32()) {
    let st;
    try {
      st = lstatSync(anchored);
    } catch (e) {
      if (e && e.code === 'ENOENT') return { kind: 'absent', fd: null, st: null, anchored };
      throw refuse(`'${anchored}' could not be classified (${errText(e)}) — an unclassifiable path is never treated as absent. The latch is LEFT IN PLACE.`);
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
    // EACCES, EPERM, EIO, ... — "cannot establish" is not "not there".
    throw refuse(`'${anchored}' exists in some shape but could not be opened for classification (${code || errText(e)}) — an unreadable path is NEVER an absent one. The latch is LEFT IN PLACE.`);
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    const kind = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
    return { kind, fd, st, anchored };
  } catch (e) {
    closePinned(fd, e);
    throw e;
  }
}

// A leaf's own lstat kind through an ALREADY-PINNED parent. Used only where an
// open would be the wrong tool (the `sterling.db` presence probe), never as the
// authority for anything this file acts on.
function lstatKindAt(parentHandle, leaf) {
  try {
    const st = lstatSync(`${parentHandle}/${leaf}`);
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isFile()) return 'file';
    if (st.isDirectory()) return 'dir';
    return 'other';
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'absent' : 'error';
  }
}

function devOf(st) {
  return isWin32() ? String(st.dev) : st.dev.toString();
}
function inoOf(st) {
  return isWin32() ? String(st.ino) : st.ino.toString();
}

// Read a classified regular file's bytes FROM THE DESCRIPTOR THAT CLASSIFIED IT,
// never from a name resolved a second time.
function readClassifiedBytes(h, maxBytes, what) {
  if (h.kind !== 'file') {
    throw refuse(`${what} is ${h.kind}, not a regular file — refusing to read it. The latch is LEFT IN PLACE.`);
  }
  if (!isWin32() && typeof h.st?.size === 'bigint' && h.st.size > BigInt(maxBytes)) {
    throw refuse(`${what} is ${h.st.size} bytes, over the ${maxBytes}-byte bound — refusing to read it rather than parse a truncated prefix. The latch is LEFT IN PLACE.`);
  }
  try {
    // F9 — THE SIZE CHECK ABOVE IS NOT THE BOUND, it is only a fast refusal: the
    // file can GROW between that `fstat` and the read, and `readFileSync(fd)`
    // would then allocate whatever is there before the post-read comparison ever
    // ran. The read is therefore chunked and refuses the instant it PASSES the
    // bound, so the largest allocation an attacker can force is the bound plus
    // one chunk. (The win32 arm is unreachable — F7.)
    const bytes = isWin32() ? readFileSync(h.anchored) : readBoundedFromDescriptor(h.fd, maxBytes, what);
    if (bytes.length > maxBytes) {
      throw refuse(`${what} is ${bytes.length} bytes, over the ${maxBytes}-byte bound — refusing to parse it. The latch is LEFT IN PLACE.`);
    }
    return bytes;
  } catch (e) {
    if (e instanceof ReconcileRefusal) throw e;
    throw refuse(`${what} could not be read (${errText(e)}). The latch is LEFT IN PLACE.`);
  }
}

// F9 — read a descriptor's bytes at EXPLICIT positions in bounded chunks,
// refusing as soon as the total passes `maxBytes` rather than after the whole
// file has been committed to memory.
function readBoundedFromDescriptor(fd, maxBytes, what) {
  const chunks = [];
  const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let pos = 0;
  for (;;) {
    let n;
    try {
      n = readSync(fd, buf, 0, HASH_CHUNK_BYTES, pos);
    } catch (e) {
      throw refuse(`${what} could not be read from the descriptor that classified it (${errText(e)}). The latch is LEFT IN PLACE.`);
    }
    if (n === 0) break;
    pos += n;
    if (pos > maxBytes) {
      throw refuse(
        `${what} exceeds the ${maxBytes}-byte bound — refusing part-way through the read rather than allocating an unbounded record first and complaining ` +
          `about its size afterwards. The latch is LEFT IN PLACE.`
      );
    }
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks, pos);
}

// ---------------------------------------------------------------------------
// F3 — HASH A DESCRIPTOR IN BOUNDED CHUNKS, at an EXPLICIT position, so the
// read never depends on (or disturbs) the descriptor's file offset. That is
// what makes the same descriptor re-hashable later, which is the mechanism F1's
// binding rests on: `confirmBoundEvidence` re-hashes THE SAME fd and must get
// the same answer.
// The per-file bound is enforced against BYTES ACTUALLY READ, not against the
// size fstat reported, because a file can grow between the two.
// ---------------------------------------------------------------------------
function hashDescriptorBounded({ fd, anchored }, what) {
  if (isWin32() || fd === null || fd === undefined) {
    // UNREACHABLE win32 arm (F7). F9 nonetheless removes the read-before-bound:
    // it formerly called `readFileSync` and only then compared the length, so the
    // advertised per-file refusal arrived AFTER a planted multi-gigabyte file had
    // already been allocated. Size is now established from the descriptor's own
    // fstat before anything is read, and the read itself is chunked, so the bound
    // holds even if the file grows between the two.
    let ownFd = null;
    let primary;
    try {
      ownFd = openSync(anchored, FS.O_RDONLY);
      const st = fstatSync(ownFd, { bigint: true });
      if (st.size > BigInt(MAX_BASELINE_FILE_BYTES)) {
        throw refuse(
          `${what} is ${st.size} bytes, over the ${MAX_BASELINE_FILE_BYTES}-byte per-file bound for the (B) surface — refusing BEFORE reading it, never ` +
            `after allocating it. The latch is LEFT IN PLACE.`
        );
      }
      return hashFdChunked(ownFd, what);
    } catch (e) {
      primary = e;
      if (e instanceof ReconcileRefusal) throw e;
      throw refuse(`${what} could not be read (${errText(e)}). The latch is LEFT IN PLACE.`);
    } finally {
      closePinned(ownFd, primary);
    }
  }
  return hashFdChunked(fd, what);
}

function hashFdChunked(fd, what) {
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let pos = 0;
  for (;;) {
    let n;
    try {
      n = readSync(fd, buf, 0, HASH_CHUNK_BYTES, pos);
    } catch (e) {
      throw refuse(`${what} could not be read from the descriptor that classified it (${errText(e)}). The latch is LEFT IN PLACE.`);
    }
    if (n === 0) break;
    pos += n;
    if (pos > MAX_BASELINE_FILE_BYTES) {
      throw refuse(
        `${what} exceeds the ${MAX_BASELINE_FILE_BYTES}-byte per-file bound for the (B) surface — refusing to read it rather than letting one planted file ` +
          `exhaust this process. The latch is LEFT IN PLACE.`
      );
    }
    hash.update(buf.subarray(0, n));
  }
  return { sha256: hash.digest('hex'), bytes: pos };
}

// ---------------------------------------------------------------------------
// IS THIS A (B) PATH? Copied from H17's `validateBaselineKey` and using the SAME
// `matchesGlob` and the SAME glob list, so the two cannot drift into disagreeing
// about set membership — which is exactly how an exact-set comparison decays
// into a subset one.
// POSIX: '\' is a legal filename byte, not a separator, so a key carrying one is
// refused rather than normalized (normalizing collapses distinct siblings onto
// one key, and last-writer-wins on that key hides a tampered file behind its
// colliding sibling).
// ---------------------------------------------------------------------------
function validateBaselineKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  if (!isWin32() && key.includes('\\')) return null;
  const fwd = key.replace(/\\/g, '/');
  if (fwd.startsWith('/') || /^[A-Za-z]:/.test(fwd)) return null; // absolute
  if (fwd.split('/').includes('..')) return null; // traversal
  if (!BASELINE_GLOBS.some((g) => matchesGlob(fwd, g))) return null;
  return fwd;
}

// The (B)-RELEVANT names of one directory listing, per directory role. This is
// the membership half of F1's binding (property (c)): re-deriving it from a
// re-listing of the SAME retained descriptor is how a member APPEARING or
// DISAPPEARING after the verdict is caught, which no per-member byte or
// identity check can see.
function relevantNames(kind, entries) {
  const names = new Set();
  for (const de of entries) {
    if (kind === 'agents') {
      names.add(de.name);
    } else if (kind === 'claude') {
      if (de.name === AGENTS_LEAF || matchesGlob(`${CLAUDE_DIR}/${de.name}`, SETTINGS_GLOB)) names.add(de.name);
    } else if (kind === 'sterling') {
      if (de.name === CONFIG_LEAF) names.add(de.name);
    }
  }
  return names;
}

function sameNameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const n of a) if (!b.has(n)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// F9 — LIST A DIRECTORY WITH THE ENTRY BOUND ENFORCED *DURING* THE LISTING.
// This was `readdirSync`, which MATERIALIZES THE WHOLE DIRECTORY before any
// count could be checked: a planted directory with millions of entries exhausted
// this process before the advertised 4096-entry refusal was ever reached, which
// makes the bound a comment rather than a control. `opendirSync` + `readSync`
// pulls at most `DIR_READ_BUFFER_ENTRIES` dirents from the kernel at a time and
// `countEntry` is called on each ONE BEFORE it is retained, so the refusal
// arrives at entry 4097 instead of after the machine has been filled.
// `countEntry` is REQUIRED, not optional: a listing with no budget is exactly
// the hole the confirmation re-listing had.
// ---------------------------------------------------------------------------
const DIR_READ_BUFFER_ENTRIES = 64;

function listDirBound(handle, relDir, countEntry) {
  if (typeof countEntry !== 'function') {
    throw refuse(`internal: the (B) directory '${relDir}' was listed without an entry budget — an unbounded listing is never performed. The latch is LEFT IN PLACE.`);
  }
  let dir;
  try {
    dir = opendirSync(handle, { bufferSize: DIR_READ_BUFFER_ENTRIES });
  } catch (e) {
    throw refuse(
      `could not enumerate the (B) directory '${relDir}' (${errText(e)}) — an unenumerable directory is an UNKNOWN surface, never an empty one, and an ` +
        `unknown surface never discharges an incident. The latch is LEFT IN PLACE.`
    );
  }
  const entries = [];
  let primary;
  try {
    for (;;) {
      let de;
      try {
        de = dir.readSync();
      } catch (e) {
        throw refuse(
          `could not enumerate the (B) directory '${relDir}' (${errText(e)}) — an unenumerable directory is an UNKNOWN surface, never an empty one, and an ` +
            `unknown surface never discharges an incident. The latch is LEFT IN PLACE.`
        );
      }
      if (de === null || de === undefined) break;
      countEntry(relDir); // THROWS BEFORE the entry is retained.
      entries.push(de);
    }
    return entries;
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    try {
      dir.closeSync();
    } catch (closeErr) {
      if (!primary) throw closeErr;
    }
  }
}

// ---------------------------------------------------------------------------
// ENUMERATE AND HASH THE CURRENT (B) SURFACE. Mirrors H17's `collectBaseline`
// in WHAT it covers — `.claude/agents/**` RECURSIVELY, `.claude/settings*.json`
// TOP LEVEL ONLY, `.sterling/config.json` — and differs only in carrying sha256
// rather than bytes, because this function never restores anything. The three
// globs are not spelled here at all: `BASELINE_GLOBS` IS the shared
// `ENFORCEMENT_SURFACE` export, and this walk's shape is what "dynamic
// membership under a fixed surface definition" means in code.
// A Dirent is a PRE-FILTER, NEVER THE VERDICT: every decision is re-established
// by the open that follows (O_NOFOLLOW + fstat), so a stale or raced Dirent can
// only cost a refusal, never a wrong hash.
// A SYMLINK OR NON-REGULAR ENTRY ANYWHERE UNDER THE (B) SURFACE REFUSES THE
// WHOLE RECONCILIATION rather than being skipped: skipping the anomalous path
// and comparing the rest would verify a set while silently omitting the one
// member an attacker had tampered with.
//
// RETURNS `{ map, leaves, dirs }`. `map` is Map<repoRelPosixPath, sha256hex> —
// the verdict input. `leaves`/`dirs` are the F1 BINDING: when `retain` is true
// every leaf descriptor and every walked directory descriptor stays open in
// `scope` for the rest of the call, so `confirmBoundEvidence` can prove, right
// before the unlink, that the bytes being cleared against are the bytes that
// were verified. When `retain` is false (the FIRST pass) leaf descriptors are
// closed as soon as they are hashed.
// ---------------------------------------------------------------------------
async function collectBaseline(cwd, scope, { retain = false, onBeforeDirectoryOpen = null } = {}) {
  const map = new Map();
  const leaves = [];
  const dirs = [];
  const edges = [];
  const budget = { files: 0, dirs: 0, entries: 0, bytes: 0 };

  // F9 — called PER ENTRY as the kernel hands it over, so the bound refuses
  // before the entries are accumulated rather than after the whole directory has
  // been materialized.
  const countEntry = (relDir) => {
    budget.entries += 1;
    if (budget.entries > MAX_BASELINE_DIR_ENTRIES) {
      throw refuse(
        `the (B) surface enumeration passed ${budget.entries} directory entries at '${relDir}', over the ${MAX_BASELINE_DIR_ENTRIES}-entry bound — refusing ` +
          `to walk a surface this large rather than grinding through a planted one. The latch is LEFT IN PLACE.`
      );
    }
  };

  const addLeaf = (parentHandle, leaf, rel) => {
    const h = classifyLeafAt(parentHandle, leaf);
    let primary;
    let closed = false;
    try {
      if (h.kind !== 'file') {
        throw refuse(
          `(B) surface path '${rel}' is not a regular file (kind: ${h.kind}) — a symlink or other non-regular entry standing where the enumeration saw a ` +
            `file is denied on sight, never followed. The latch is LEFT IN PLACE.`
        );
      }
      budget.files += 1;
      if (budget.files > MAX_BASELINE_FILES) {
        throw refuse(
          `the (B) surface holds more than ${MAX_BASELINE_FILES} files (at '${rel}') — over the bound this clearer will attest. Refusing rather than ` +
            `reading an unbounded set. The latch is LEFT IN PLACE.`
        );
      }
      const { sha256, bytes } = hashDescriptorBounded(h, `(B) surface path '${rel}'`);
      budget.bytes += bytes;
      if (budget.bytes > MAX_BASELINE_TOTAL_BYTES) {
        throw refuse(
          `the (B) surface exceeds the ${MAX_BASELINE_TOTAL_BYTES}-byte total bound (reached at '${rel}') — refusing to hash an unbounded surface. ` +
            `The latch is LEFT IN PLACE.`
        );
      }
      map.set(rel, sha256);
      if (retain) {
        scope.keep(h.fd);
        closed = true; // ownership transferred to the scope; the finally must not close it
        leaves.push({ rel, parentHandle, leaf, fd: h.fd, anchored: h.anchored, dev: devOf(h.st), ino: inoOf(h.st), sha256 });
      }
    } catch (e) {
      primary = e;
      if (e instanceof ReconcileRefusal) throw e;
      throw refuse(`(B) surface path '${rel}' could not be hashed (${errText(e)}). The latch is LEFT IN PLACE.`);
    } finally {
      if (!closed) closePinned(h.fd, primary);
    }
  };

  // `.claude/agents/**` — RECURSIVE, and every directory below the root is
  // opened through its pinned parent with O_NOFOLLOW.
  const walkAgents = async (dirHandle, relDir, depth) => {
    if (depth > MAX_BASELINE_DEPTH) {
      throw refuse(
        `the (B) directory '${relDir}' is nested deeper than the ${MAX_BASELINE_DEPTH}-level bound — refusing to descend further rather than following a ` +
          `planted tree without end. The latch is LEFT IN PLACE.`
      );
    }
    const entries = listDirBound(dirHandle, relDir, countEntry);
    dirs.push({ relDir, handle: dirHandle, kind: 'agents', names: relevantNames('agents', entries) });

    for (const de of entries) {
      // POSIX non-injectivity guard, BEFORE the key is built: a literal backslash
      // is a legal POSIX filename byte but collapses to '/' in a path key, so
      // `.claude/agents/a\b.md` and `.claude/agents/a/b.md` would share one slot.
      if (!isWin32() && de.name.includes('\\')) {
        throw refuse(
          `(B) surface entry '${relDir}/${de.name}' contains a backslash — refused on POSIX: it is a legal filename byte here but collapses to '/' in the ` +
            `comparison key, so a distinct sibling would share one slot. Denied fail-closed, never normalized. The latch is LEFT IN PLACE.`
        );
      }
      const rel = `${relDir}/${de.name}`;
      if (de.isSymbolicLink()) {
        throw refuse(`(B) surface path '${rel}' is a symlink — refusing to read through it (it may point outside the repository). The latch is LEFT IN PLACE.`);
      }
      if (de.isDirectory()) {
        budget.dirs += 1;
        if (budget.dirs > MAX_BASELINE_DIRS) {
          throw refuse(
            `the (B) surface holds more than ${MAX_BASELINE_DIRS} directories (at '${rel}') — over the bound this clearer will walk. Refusing rather than ` +
              `enumerating an unbounded tree. The latch is LEFT IN PLACE.`
          );
        }
        // SEAM 3 — TEST-ONLY, and the ONLY thing between the parent's readdir
        // and this child's open. Production callers never pass it.
        if (typeof onBeforeDirectoryOpen === 'function') await onBeforeDirectoryOpen(rel);
        const child = openBaselineChildDir(dirHandle, de.name, rel, scope);
        // F6 — every recursive agents edge is retained, not just the two roots:
        // a subdirectory renamed aside and replaced after the verdict is the same
        // attack one level down.
        edges.push({ parentHandle: dirHandle, name: de.name, rel, expect: 'dir', dev: child.dev, ino: child.ino });
        await walkAgents(child.handle, rel, depth + 1);
      } else if (de.isFile()) {
        addLeaf(dirHandle, de.name, rel);
      } else {
        throw refuse(`(B) surface path '${rel}' is neither a regular file nor a directory — it cannot be attested by a byte hash. The latch is LEFT IN PLACE.`);
      }
    }
  };

  // `.claude` is classified ONCE and both families are enumerated through that
  // single pinned handle — `agents` must never be walked before `.claude` itself
  // is classified.
  const claude = pinChain(cwd, CLAUDE_DIR, scope, `the (B) surface root '${CLAUDE_DIR}'`);
  edges.push(...claude.edges); // F6 — including the EXPECTED-ABSENCE edge when '.claude' is not there.
  if (claude.handle !== null) {
    const agents = classifyLeafAt(claude.handle, AGENTS_LEAF);
    let primary;
    let agentsRetained = false;
    try {
      if (agents.kind === 'dir') {
        edges.push({ parentHandle: claude.handle, name: AGENTS_LEAF, rel: AGENTS_REL, expect: 'dir', dev: devOf(agents.st), ino: inoOf(agents.st) });
        if (retain) {
          scope.keep(agents.fd);
          agentsRetained = true;
        }
        await walkAgents(isWin32() ? agents.anchored : `${PROCFS_FD_DIR}/${agents.fd}`, AGENTS_REL, 1);
      } else if (agents.kind === 'absent') {
        // F6 — an absent agents directory is retained as EXPECTED ABSENCE, so
        // creating '.claude/agents/tampered.md' after the verdict refuses instead
        // of being invisible to every binding property.
        edges.push({ parentHandle: claude.handle, name: AGENTS_LEAF, rel: AGENTS_REL, expect: 'absent', dev: null, ino: null });
      } else {
        throw refuse(`'${AGENTS_REL}' is not a directory (kind: ${agents.kind}) — refusing to read/walk through it. The latch is LEFT IN PLACE.`);
      }
    } catch (e) {
      primary = e;
      throw e;
    } finally {
      if (!agentsRetained) closePinned(agents.fd, primary);
    }

    // .claude/settings*.json — TOP LEVEL ONLY.
    const entries = listDirBound(claude.handle, CLAUDE_DIR, countEntry);
    dirs.push({ relDir: CLAUDE_DIR, handle: claude.handle, kind: 'claude', names: relevantNames('claude', entries) });
    for (const de of entries) {
      const rel = `${CLAUDE_DIR}/${de.name}`;
      // matchesGlob normalizes '\'->'/', so a settings-shaped POSIX name carrying
      // a backslash would be rewritten, FAIL the glob and be silently skipped —
      // leaving tampering on it invisible. Refuse before the normalizing glob can
      // hide it.
      if (!isWin32() && de.name.includes('\\') && de.name.startsWith('settings') && de.name.endsWith('.json')) {
        throw refuse(
          `(B) settings entry '${rel}' contains a backslash — refused on POSIX: the glob would normalize it away and silently skip this settings-shaped ` +
            `file from the comparison. The latch is LEFT IN PLACE.`
        );
      }
      if (!matchesGlob(rel, SETTINGS_GLOB)) continue;
      if (!de.isFile()) {
        throw refuse(
          `(B) surface path '${rel}' is not a regular file (${de.isSymbolicLink() ? 'symlink' : 'other'}) — refusing to read through it. The latch is LEFT IN PLACE.`
        );
      }
      addLeaf(claude.handle, de.name, rel);
    }
  }

  // `.sterling/config.json` — one fixed path.
  const sterling = pinChain(cwd, STERLING_DIR, scope, `the (B) surface root '${STERLING_DIR}'`);
  edges.push(...sterling.edges); // F6 — expected-absence included, as for '.claude'.
  if (sterling.handle !== null) {
    const entries = listDirBound(sterling.handle, STERLING_DIR, countEntry);
    dirs.push({ relDir: STERLING_DIR, handle: sterling.handle, kind: 'sterling', names: relevantNames('sterling', entries) });
    const configDe = entries.find((de) => de.name === CONFIG_LEAF);
    if (configDe) {
      if (!configDe.isFile()) {
        throw refuse(`(B) surface path '${CONFIG_REL}' is not a regular file (${configDe.isSymbolicLink() ? 'symlink' : 'other'}) — refusing to read through it. The latch is LEFT IN PLACE.`);
      }
      addLeaf(sterling.handle, CONFIG_LEAF, CONFIG_REL);
    }
  }

  // `roots` is a LIST, not a single value: each `pinChain` call takes a FRESH
  // anchor, so a root substituted mid-call yields two different anchor identities
  // and the confirmation — which requires EVERY retained anchor to still be what
  // `cwd` resolves to — refuses.
  const roots = [claude.root, sterling.root].filter(Boolean);
  return { map, leaves, dirs, edges, roots };
}

// F4 — open a DISCOVERED (B) subdirectory through its pinned parent, retaining
// the descriptor. THE TWO FAILURE FACES THAT WERE PREVIOUSLY SWALLOWED:
//   ENOENT — the directory its parent LISTED is gone before it can be opened.
//     Formerly `return undefined`, i.e. enumerated as EMPTY, which let a
//     populated agents subdirectory be renamed out across both enumeration
//     passes and restored afterwards while the surviving visible set matched
//     the baseline exactly. It now REFUSES (AC-R21).
//   EACCES — the directory cannot be enumerated at all, so a tampered grant can
//     hide inside it while the visible set matches the baseline. It now REFUSES,
//     naming the directory (AC-R20).
// O_NOFOLLOW remains the third face: a child swapped for a symlink between its
// Dirent and this open FAILS rather than being descended into.
// F6 — it also returns the child's dev/ino, so the caller can retain the EDGE
// (parent + name + child identity) and not merely the descriptor.
function openBaselineChildDir(parentHandle, name, rel, scope) {
  if (isWin32()) return { handle: join(parentHandle, name), dev: null, ino: null }; // unreachable (F7)
  let fd;
  try {
    fd = openSync(`${parentHandle}/${name}`, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (e) {
    const code = e && e.code;
    if (code === 'ENOENT') {
      throw refuse(
        `the (B) directory '${rel}' vanished during enumeration — its parent listed it and it was gone before this walk could open it, which leaves the (B) ` +
          `surface UNKNOWN rather than empty. A directory renamed out mid-enumeration is never enumerated as empty. The latch is LEFT IN PLACE.`
      );
    }
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw refuse(
        `the (B) directory '${rel}' was listed as a directory but a no-follow open of it failed (${code}) — a symlink or non-directory swapped in between the ` +
          `listing and the open is denied on sight, never descended into. The latch is LEFT IN PLACE.`
      );
    }
    throw refuse(
      `could not enumerate the (B) directory '${rel}' (${code || errText(e)}) — an unenumerable directory is an UNKNOWN surface, never an empty one, and a ` +
        `tampered agent definition hiding inside one is exactly what treating it as empty would discharge the latch over. The latch is LEFT IN PLACE.`
    );
  }
  scope.keep(fd);
  let st;
  try {
    st = fstatSync(fd, { bigint: true });
  } catch (e) {
    throw refuse(`the (B) directory '${rel}' could not be identified after it was opened (${errText(e)}) — an unidentifiable directory cannot be bound to the verdict. The latch is LEFT IN PLACE.`);
  }
  return { handle: `${PROCFS_FD_DIR}/${fd}`, dev: devOf(st), ino: inoOf(st) };
}

// ---------------------------------------------------------------------------
// THE BASELINE LIST, read ONCE per pass through a pinned parent and classified
// BY THE OPEN. Returns `{ present, kind, sha256, doc, bound, edges, roots }`.
// `sha256` is computed from THE BYTES THIS READ RETURNED, never by a second
// streamed pass over the path — a separate hashing read would reintroduce a
// substitution window one level down.
// When `retain` is true the list's descriptor and its pinned parent stay open in
// `scope`, and `bound` carries what `confirmBoundEvidence` needs to prove, right
// before the unlink, that the list the verdict was computed against is still the
// list on disk (F1, property (d)).
//
// SAME PIN-CHAIN AND RETAINED-BOUND-DESCRIPTOR SEMANTICS AS THE DEAD STAMP READ
// IT REPLACES — retargeted path, one fewer directory edge. The list's OWN chain
// (root->'.sterling') is retained as edges exactly like the (B) surface's:
// substituting `.sterling` after the verdict swaps the MANIFEST the NEXT call
// will trust, which is the same attack aimed at the other half of the
// comparison (AC-R32).
// ---------------------------------------------------------------------------
function readBaselineList(cwd, scope, { retain = false } = {}) {
  const parent = pinChain(cwd, STERLING_DIR, scope, LIST_WHAT);
  const edges = parent.edges;
  const roots = parent.root ? [parent.root] : [];
  const absent = { present: false, kind: 'absent', sha256: null, doc: null, parsed: false, bound: null, edges, roots };
  if (parent.handle === null) return absent;
  const h = classifyLeafAt(parent.handle, LIST_LEAF);
  let primary;
  let retained = false;
  try {
    if (h.kind === 'absent') return absent;
    if (h.kind !== 'file') return { present: true, kind: h.kind, sha256: null, doc: null, parsed: false, bound: null, edges, roots };
    const bytes = readClassifiedBytes(h, MAX_LIST_BYTES, LIST_WHAT);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let doc = null;
    let parsed = false;
    try {
      doc = JSON.parse(bytes.toString('utf8'));
      parsed = true;
    } catch {
      doc = null; // malformed — the caller refuses; the hash still compares across the window
      parsed = false;
    }
    let bound = null;
    if (retain) {
      scope.keep(h.fd);
      retained = true;
      bound = { parentHandle: parent.handle, leaf: LIST_LEAF, fd: h.fd, anchored: h.anchored, dev: devOf(h.st), ino: inoOf(h.st), sha256 };
    }
    return { present: true, kind: 'file', sha256, doc, parsed, bound, edges, roots };
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    if (!retained) closePinned(h.fd, primary);
  }
}

// ---------------------------------------------------------------------------
// LIST SHAPE VALIDATION (fe861066 D1), RUN BEFORE ANY CONTENT IS COMPARED. The
// list's SHAPE must be valid before its CONTENT means anything, and each defect
// gets its OWN attribution: version, sortedness, duplication and hash format are
// SHAPE questions, not delta-from-current questions, and collapsing them into
// one "malformed" family is how a shape guard goes hollow (a bare
// `try { … } catch { entries = [] }` refuses down the INCOMPLETE path instead
// and satisfies a test that only checks `cleared:false`).
//
// THE ENTRIES ARE AN ARRAY, NOT AN OBJECT, PRECISELY SO DUPLICATION IS VISIBLE:
// a JSON object silently keeps the last of two colliding keys, so a list
// carrying `[{p, good}, {p, forged}]` would read as attesting whichever survived
// the parse. Refused WHOLE instead.
//
// Returns the parsed entries array; throws a discriminated refusal otherwise.
//
// PARITY CONTRACT (Codex delta review, S4): `parseBaselineList` in
// scripts/hooks/h17-bash-write-sweep.mjs must accept EXACTLY the lists this
// function accepts — closed {path, sha256} entry shape, byte-canonical paths
// (validateBaselineKey(p) === p, never normalized into validity), sorted,
// duplicate-free, lowercase-64-hex. The two readers share one definition of a
// valid list or the mechanism splits: hook-looser is a laundering route (a
// list the clearer refuses still pacifies the hook); hook-stricter is a
// self-wedge (a correct ADOPT mints a list the hook then denies every call).
// Editing either validator means re-checking the other.
// ---------------------------------------------------------------------------
function validateListShape(list) {
  if (!list.present) {
    throw refuse(
      `no baseline present at '${LIST_REL}' — there is nothing the current (B) surface can be verified AGAINST. A surface that merely LOOKS ` +
        `self-consistent is not an attested one; the whole point of the list is that it records what a conductor DELIBERATELY accepted (decision ` +
        `fe861066 D2/D5). Run reconciliation in ADOPT mode to initialise it, then verify. The latch is LEFT IN PLACE.`
    );
  }
  if (list.kind !== 'file') {
    throw refuse(`${LIST_WHAT} is ${list.kind}, not a regular file — it attests nothing and is never read through. The latch is LEFT IN PLACE.`);
  }
  if (!list.parsed) {
    throw refuse(`${LIST_WHAT} is malformed: it does not parse as JSON — a baseline that cannot be read attests nothing. The latch is LEFT IN PLACE.`);
  }
  const doc = list.doc;
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw refuse(`${LIST_WHAT} is malformed: it does not parse to a JSON OBJECT — refusing it whole. The latch is LEFT IN PLACE.`);
  }
  if (doc.version !== LIST_VERSION) {
    throw refuse(
      `the baseline version is not ${LIST_VERSION} — ${LIST_WHAT} declares ${doc.version === undefined ? 'no version at all' : JSON.stringify(doc.version)}, ` +
        `and a baseline whose version this clearer does not understand is refused WHOLE rather than interpreted on a guess. The latch is LEFT IN PLACE.`
    );
  }
  if (!Array.isArray(doc.entries)) {
    throw refuse(`${LIST_WHAT} is malformed: 'entries' is not a JSON ARRAY — refusing it whole. The latch is LEFT IN PLACE.`);
  }
  // `minted_at` IS READ BY NOTHING. fe861066 D1: DIAGNOSTIC ONLY — never
  // freshness, never authority. An ancient minted_at with an exact match
  // verifies (AC-R58); a fresh one buys nothing.
  const entries = doc.entries;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e === null || typeof e !== 'object' || Array.isArray(e) || typeof e.path !== 'string' || typeof e.sha256 !== 'string') {
      throw refuse(
        `${LIST_WHAT} is malformed: entry #${i} is not an object carrying a string 'path' and a string 'sha256' — the entry shape is fixed at ` +
          `{path, sha256} (no 'deleted', no 'at'), and an entry that is not that shape attests nothing. The latch is LEFT IN PLACE.`
      );
    }
    // THE ENTRY SHAPE IS CLOSED, NOT MERELY REQUIRED. An entry carrying a key
    // beyond {path, sha256} is refused rather than ignored, because the field
    // most likely to appear there is `deleted: true` — the dead stamp's deletion
    // attestation, whose whole meaning was "this path is legitimately absent".
    // Silently dropping it would accept a list written against a MEANING THIS
    // CLEARER NO LONGER IMPLEMENTS, and a reader of that list would believe an
    // absence was attested when nothing here would ever honour it. Same argument
    // for any future field: an unknown key means the writer believed something
    // about this list that the reader does not.
    const keys = Object.keys(e);
    const unknown = keys.filter((k) => k !== 'path' && k !== 'sha256').sort();
    if (unknown.length > 0) {
      throw refuse(
        `${LIST_WHAT} is malformed: entry #${i} (${JSON.stringify(e.path)}) carries unknown entry key${unknown.length === 1 ? '' : 's'} ` +
          `(${unknown.join(', ')}) — the entry shape is EXACTLY {path, sha256} (fe861066 D1), and an entry carrying more than that was written against a ` +
          `meaning this clearer does not implement. Refused WHOLE rather than partly honoured. The latch is LEFT IN PLACE.`
      );
    }
    if (validateBaselineKey(e.path) !== e.path) {
      throw refuse(
        `${LIST_WHAT} is malformed: the entry path ${JSON.stringify(e.path)} is not a repo-relative POSIX path inside the fixed (B) surface definition ` +
          `(${BASELINE_GLOBS.join(', ')}) — a foreign or non-normalized key cannot stand in an exact-set comparison. The latch is LEFT IN PLACE.`
      );
    }
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) {
      throw refuse(
        `the baseline hash for '${e.path}' is not a valid lowercase 64-hex sha256 (found ${JSON.stringify(e.sha256)}) — an unreadable hash cannot be ` +
          `compared, and a comparison that silently fails is worse than one that refuses. The latch is LEFT IN PLACE.`
      );
    }
  }
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1].path;
    const cur = entries[i].path;
    if (cur === prev) {
      throw refuse(
        `duplicate baseline entry for '${cur}' — the baseline carries more than one entry claiming that (B) path, a duplicated claim has no single meaning, ` +
          `and a first-match lookup would silently honour whichever was emitted first. The baseline is refused WHOLE. The latch is LEFT IN PLACE.`
      );
    }
    if (cur < prev) {
      throw refuse(
        `the baseline entries are not sorted in strictly ascending path order ('${cur}' is listed after '${prev}') — sortedness is what makes duplication ` +
          `and completeness checkable by inspection rather than by trusting a parser. The baseline is refused WHOLE. The latch is LEFT IN PLACE.`
      );
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// THE EXACT-LIST COMPARISON (fe861066 D3/D5, and AC-R4/AC-R5/AC-R7).
// THREE PROPERTIES, ALL REQUIRED:
//   * EXACT SET EQUALITY IN BOTH DIRECTIONS. A listed subset is not enough
//     (AC-R4), and a list claiming a (B) path the current surface does not have
//     is not enough either (AC-R7). A one-directional check is a defect.
//   * EXACT BYTES. Path presence alone attests nothing (AC-R5).
//   * NO AMBIGUITY. Duplication and ordering are already refused WHOLE by
//     `validateListShape` above, so this comparison never sees an ambiguous key
//     and never resolves one by a first-match `find()`.
// THERE IS NO DELETION ATTESTATION. fe861066 D1 fixes the entry shape at exactly
// `{path, sha256}`: a path that no longer exists simply has NO ENTRY, and a list
// still carrying one for it is the ordinary STALE-ENTRY case below. The old
// `deleted:true` arm died with the stamp that produced it — do not reintroduce a
// field the concrete design does not define.
// EVERY ENTRY IS A (B) PATH, enforced by `validateListShape`; the list does not
// cover the (A) surface (that half of the latch's domain is proven by git, in
// `trackedSurfaceDirt`), so there is nothing here to skip.
//
// F5 — EVERY REFUSAL BELOW NAMES ITS OWN GUARD, in the vocabulary the test file
// pins. The paired families (stale-entry vs incomplete) deliberately do not
// share wording: an unattributable `{cleared:false}` is what let one pin go
// hollow and another resolve to a different test's guard.
// ---------------------------------------------------------------------------
function verifyExactBaseline(list, current) {
  const entries = validateListShape(list);

  const byPath = new Map();
  for (const entry of entries) byPath.set(entry.path, entry);

  // DIRECTION 1 — every listed (B) claim must hold against the current surface.
  for (const [rel, entry] of byPath) {
    if (!current.has(rel)) {
      throw refuse(
        `'${rel}' is attested by the baseline but no longer exists on the current (B) surface — exactness runs BOTH directions, so a baseline that claims ` +
          `MORE than the surface has is refused exactly like one that claims less. Re-adopt and reconcile again. The latch is LEFT IN PLACE.`
      );
    }
    if (current.get(rel) !== entry.sha256) {
      throw refuse(
        `hash mismatch for '${rel}' — the baseline sha256 (${entry.sha256}) is not the sha256 of the bytes now on disk (${current.get(rel)}). The attested ` +
          `bytes are not the bytes there. The latch is LEFT IN PLACE.`
      );
    }
  }

  // DIRECTION 2 — every current (B) path must be attested. A subset is not exact.
  for (const rel of current.keys()) {
    if (!byPath.has(rel)) {
      throw refuse(
        `no baseline entry for '${rel}' (unattested) — an INCOMPLETE baseline cannot discharge the incident, because the unattested member is exactly where ` +
          `a tamper would hide. Re-adopt and reconcile again. The latch is LEFT IN PLACE.`
      );
    }
  }

  return byPath.size;
}

// ---------------------------------------------------------------------------
// THE MINT (fe861066 D2/D5) — the list this clearer would write for the surface
// verdict it is holding. Sorted strictly ascending by path, entries exactly
// `{path, sha256}`, `minted_at` recorded but NEVER read back as authority.
// ---------------------------------------------------------------------------
function mintBaselineEntries(map) {
  return [...map.entries()].map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function sameEntryList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].sha256 !== b[i].sha256) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// ADOPT'S INSTALL (fe861066 D5). The ONLY write this file performs, and it is
// reached ONLY through the explicit `adopt` flag behind the conductor gate.
//
// ATOMIC PUBLICATION THROUGH THE PINNED PARENT, in the order the anti-pattern
// descriptor-pin-defeated-at-acquisition... (7760c328) prescribes: a uniquely
// named temp created O_CREAT|O_EXCL|O_NOFOLLOW INSIDE the pinned `.sterling`
// descriptor, written in full, fsynced, then renamed onto the authoritative name
// THROUGH THE SAME PINNED PARENT. A write failure therefore cannot leave a
// partial file at the name a later call will trust, and no step addresses
// `.sterling` by pathname.
//
// THEN THE INSTALLED FILE IS RE-OPENED AND RETAINED, and its parsed entries are
// required to equal the verdict this call is holding. RETAINING THE OLD
// DESCRIPTOR ACROSS AN ATOMIC REPLACEMENT WOULD BIND NOTHING — it would keep
// proving things about the inode the rename just unlinked — so the evidence must
// bind the INSTALLED inode or it is not evidence at all.
//
// THE TEMP AND THE LIST ARE BOTH INVISIBLE TO THE (c) MEMBERSHIP PROOF by
// construction: `relevantNames('sterling')` counts only `config.json`, so
// publishing here cannot perturb the name set the verdict recorded. That is not
// a lucky accident and it is checked here rather than assumed elsewhere — if a
// future edit makes `.sterling`'s relevant name set wider, this install must
// move before the enumeration that records it.
// ---------------------------------------------------------------------------
function installBaselineList(cwd, scope, entries) {
  const parent = pinChain(cwd, STERLING_DIR, scope, LIST_WHAT);
  if (parent.handle === null) {
    throw refuse(
      `'${parent.absentAt || STERLING_DIR}' is absent, so ${LIST_WHAT} cannot be installed — this file never CREATES a project directory, it only ` +
        `publishes into one that already exists. Nothing was written. The latch is LEFT IN PLACE.`
    );
  }
  const payload = Buffer.from(`${JSON.stringify({ version: LIST_VERSION, minted_at: new Date().toISOString(), entries })}\n`, 'utf8');
  const tmpLeaf = `.enforcement-baseline.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const tmpAnchored = `${parent.handle}/${tmpLeaf}`;

  let fd = null;
  let primary;
  try {
    fd = openSync(tmpAnchored, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
    let off = 0;
    while (off < payload.length) {
      const n = writeSync(fd, payload, off, payload.length - off);
      if (!(n > 0)) {
        throw refuse(`${LIST_WHAT} could not be written in full (the write returned ${n} at offset ${off}) — a partial baseline is never published. The latch is LEFT IN PLACE.`);
      }
      off += n;
    }
    fsyncSync(fd);
  } catch (e) {
    primary = e;
    if (!(e instanceof ReconcileRefusal)) {
      primary = refuse(`${LIST_WHAT} could not be written (${errText(e)}) — nothing was published and the latch is LEFT IN PLACE.`);
    }
  } finally {
    closePinned(fd, primary);
  }
  if (primary) {
    try {
      unlinkSync(tmpAnchored);
    } catch {}
    throw primary;
  }

  try {
    renameSync(tmpAnchored, `${parent.handle}/${LIST_LEAF}`);
  } catch (e) {
    try {
      unlinkSync(tmpAnchored);
    } catch {}
    throw refuse(`${LIST_WHAT} could not be installed at its authoritative name (${errText(e)}) — the temporary file was removed and nothing was published. The latch is LEFT IN PLACE.`);
  }
  // THE DIRECTORY fsync IS BEST-EFFORT AND SAYS SO. fe861066 D5 states the
  // durability claim honestly: any crash before the confirmed latch removal
  // leaves the latch logically authoritative, and a subsequent run recovers even
  // if the rename was not durable — so a filesystem that refuses to fsync a
  // directory costs durability, never correctness, and must not turn a
  // successful publication into a refusal.
  if (parent.fd !== null && parent.fd !== undefined) {
    try {
      fsyncSync(parent.fd);
    } catch {}
  }

  const h = classifyLeafAt(parent.handle, LIST_LEAF);
  let retained = false;
  let readErr;
  try {
    if (h.kind !== 'file') {
      throw refuse(`${LIST_WHAT} is ${h.kind} immediately after being installed — something replaced it inside the publication window. The latch is LEFT IN PLACE.`);
    }
    const bytes = readClassifiedBytes(h, MAX_LIST_BYTES, LIST_WHAT);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let doc = null;
    let parsed = false;
    try {
      doc = JSON.parse(bytes.toString('utf8'));
      parsed = true;
    } catch {
      parsed = false;
    }
    const installed = validateListShape({ present: true, kind: 'file', doc, parsed });
    if (!sameEntryList(installed, entries)) {
      throw refuse(
        `${LIST_WHAT} was installed but does NOT read back as the surface verdict this call computed (${installed.length} entries on disk, ${entries.length} ` +
          `minted) — the evidence must bind the INSTALLED file, so a list that is not the one this call authored discharges nothing. The latch is LEFT IN PLACE.`
      );
    }
    scope.keep(h.fd);
    retained = true;
    return {
      bound: { parentHandle: parent.handle, leaf: LIST_LEAF, fd: h.fd, anchored: h.anchored, dev: devOf(h.st), ino: inoOf(h.st), sha256 },
      edges: parent.edges,
      roots: parent.root ? [parent.root] : [],
    };
  } catch (e) {
    readErr = e;
    throw e;
  } finally {
    if (!retained) closePinned(h.fd, readErr);
  }
}

// ---------------------------------------------------------------------------
// THE (A) HALF OF THE LATCH'S DOMAIN (fe861066 D5 LATCH DOMAIN). The ONE latch
// records BOTH an (A) tracked-git-surface incident and a (B) list incident, so a
// (B)-only verification must not discharge an (A) one.
//
// SCOPE IS THE UNION `hooks/**` + `ENFORCEMENT_SURFACE`, AND NOTHING WIDER. A
// clearer that refused on ANY dirty tracked file would be unusable mid-branch —
// an operator with an unrelated uncommitted edit anywhere in the repository
// could never reconcile — so the pathspecs below are the scope, expressed once,
// and git does the matching rather than a second glob notion here.
//
// FAIL-CLOSED ON AN UNANSWERABLE QUESTION: if git cannot answer (absent, not a
// repository, non-zero exit) the (A) surface is UNKNOWN, and unknown is not
// clean. VERIFY refuses; ADOPT — the deliberate human-acceptance operation that
// proceeds even on KNOWN dirt — reports it loudly and continues, because
// refusing there would make an unanswerable git the one thing that can never be
// accepted.
//
// THE SPAWN IS HARDENED BECAUSE GIT EXECUTES REPO-LOCAL CONFIG. `git status`
// honours `core.fsmonitor` — an arbitrary command — out of `.git/config`, which
// a write-only actor can plant and which would then run UNDER THE CONDUCTOR'S
// UID at exactly the moment reconciliation is trusted. `-c core.fsmonitor=`
// overrides the repository value on the command line (command-line config beats
// repo config), and `--no-optional-locks` keeps this read-only observation from
// taking the index lock or refreshing state it has no business writing. Both are
// argv elements, never a shell string.
//
// `-uno` — TRACKED/INDEX STATE ONLY, AND THAT SCOPE IS DELIBERATE. The (A) half
// of the latch's domain is the GIT-VISIBLE surface: tracked modifications,
// deletions and staged force-adds, ALL of which still appear under `-uno`.
// Untracked bytes under the (B) globs are already governed EXACTLY by the
// baseline list (that is the (B) half's whole job), and an untracked file under
// `hooks/**` is inert unless something references it, with in-window creation
// caught by the sweep. `-uall` bought nothing there and cost everything: any
// target project holding an untracked `.claude/settings.json` — the normal
// state, since those paths are gitignored — would make VERIFY refuse FOREVER,
// eroding VERIFY into ADOPT-always in precisely the projects where the clearer
// runs most.
// ---------------------------------------------------------------------------
function trackedSurfaceDirt(cwd) {
  const args = ['--no-optional-locks', '-c', 'core.fsmonitor=', 'status', '--porcelain', '-z', '-uno', '--', ...A_SURFACE_GLOBS.map((g) => `:(glob)${g}`)];
  let r;
  try {
    r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    return { known: false, why: errText(e), paths: [] };
  }
  if (r.error) return { known: false, why: errText(r.error), paths: [] };
  if (r.status !== 0) {
    return { known: false, why: `git status exited ${r.status === null ? `on signal ${r.signal}` : `with status ${r.status}`}: ${flatten(r.stderr)}`, paths: [] };
  }
  // `-z` output is NUL-terminated with NO quoting, so a path containing spaces,
  // quotes or newlines survives intact. Each record is `XY <path>`; a rename or
  // copy is followed by ONE MORE NUL-terminated field carrying the ORIGINAL
  // path, which must be consumed as part of the same record rather than read as
  // a status line of its own.
  const fields = String(r.stdout || '').split('\0');
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    paths.push(`${x}${y} ${rec.slice(3)}`);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i += 1;
      if (fields[i]) paths.push(`${x}${y} ${fields[i]} (original name)`);
    }
  }
  return { known: true, why: null, paths };
}

function flatten(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

// THE (A) REFUSAL, ONE WORDING, TWO MOMENTS. VERIFY consults the (A) surface
// BEFORE the (B) passes and AGAIN inside the pre-unlink confirmation, and both
// consultations refuse through here so the two cannot drift into differently
// attributable verdicts. `when` names the moment, because a verdict that cannot
// say WHEN it observed is not much better than one that cannot say WHAT.
//
// WHY THE SECOND MOMENT EXISTS: the first consultation happens before every (B)
// enumeration and hash — hundreds of milliseconds of window on a large surface —
// so a `hooks/**` file modified during it would otherwise be discharged by a
// call that had already looked and moved on. This does NOT close 0ac7be95 R1
// (nothing can), and it is deliberately NOT a claim of quiescence; it shrinks
// the (A) window to the same moment-of-check floor the (B) binding already runs
// at, immediately before the irreversible act.
function requireCleanTrackedSurface(dirt, when) {
  if (!dirt.known) {
    throw refuse(
      `the tracked (A) enforcement surface could not be established ${when} (${dirt.why}) — the one latch spans BOTH an (A) tracked-git-surface incident ` +
        `and a (B) baseline incident, and an (A) surface this call cannot observe is UNKNOWN, never clean. The latch is LEFT IN PLACE.`
    );
  }
  if (dirt.paths.length > 0) {
    throw refuse(
      `the tracked (A) enforcement surface has changed since HEAD (observed ${when}) — git reports ${dirt.paths.join('; ')} inside the (A) scope ` +
        `(${A_SURFACE_GLOBS.join(', ')}). The one latch spans BOTH incident classes, so a (B)-only verification cannot discharge it however exactly the ` +
        `(B) baseline agrees with the surface. Commit or revert those paths and reconcile again, or ADOPT them deliberately. The latch is LEFT IN PLACE.`
    );
  }
}

// ADOPT NEVER SWALLOWS (A) DIRT — it accepts it OUT LOUD, in the very string
// that reports success (fe861066 D5). An empty note is only ever produced by a
// (A) surface this call OBSERVED to be clean; an unanswerable git produces its
// own note rather than silence, because "could not look" and "looked and found
// nothing" must never read the same.
function adoptDirtNote(dirt) {
  if (!dirt.known) {
    return (
      ` LOUD: the tracked (A) enforcement surface could NOT be established (${dirt.why}), and ADOPT proceeded anyway because it is the deliberate ` +
      `human-acceptance operation — but nothing in this call proves the (A) surface matches HEAD.`
    );
  }
  if (dirt.paths.length === 0) return '';
  return (
    ` LOUD: the tracked (A) enforcement surface has changed since HEAD and was ADOPTED DELIBERATELY rather than verified — git reports ` +
    `${dirt.paths.join('; ')} inside the (A) scope (${A_SURFACE_GLOBS.join(', ')}). Default VERIFY would have REFUSED this.`
  );
}

function sameHashMap(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

// ---------------------------------------------------------------------------
// F1 — THE BINDING CONFIRMATION. Called as the LAST thing before the unlink,
// after the removal walk has already pinned `.sterling` and re-confirmed the
// latch's identity, so the window between "the evidence was proven current" and
// "the incident was discharged" is as small as this process can make it.
//
// IT COMPARES AGAINST THE IN-MEMORY VERDICT, NEVER AGAINST THE ON-DISK LIST.
// That is the whole repair: an attacker who substitutes tampered bytes TOGETHER
// WITH A MATCHING ATTACKER LIST produces a perfectly self-consistent disk, so
// any check that re-derives its expectation from disk passes. These checks
// cannot, because their expectation is the sha256 and the dev/ino this call
// computed and has been holding open ever since.
//
// FIVE INDEPENDENT PROPERTIES, none redundant (see the file header for which
// attack each one alone would miss).
//
// PROPERTY (e) RUNS FIRST *AND* LAST, AND BOTH POSITIONS ARE LOAD-BEARING.
// (a)-(d) all resolve through RETAINED DESCRIPTORS, which keep working after
// their directories have been renamed out of the live namespace — so on their
// own they attest THE CONTENTS OF A GHOST TREE. Rebinding the namespace edges
// BEFORE reading anything is what makes the content proofs that follow proofs
// about the tree the repository path actually reaches; rebinding them AGAIN
// AFTER is what stops an attacker who sized the hashing phase (F10, see the
// closing block of this function) from swapping the namespace inside it. Neither
// call substitutes for the other. THIS CALLBACK MUST STAY SYNCHRONOUS AND MUST THROW SYNCHRONOUSLY: it
// is deliberately not awaited (see `removeLatch`), and `removeLatch` REFUSES if
// it ever returns a thenable rather than letting an ignored promise decide
// nothing while the unlink proceeds (F8).
// ---------------------------------------------------------------------------
function confirmBoundEvidence(bound, { insideConfirm } = {}) {
  const { leaves, dirs, baseline, edges, roots } = bound;

  // (e) THE LIVE NAMESPACE, before anything is read through a retained fd.
  confirmBoundRoots(roots);
  confirmBoundEdges(edges);

  // SEAM 4b (`_testHookInsideConfirm`) — THE ONLY POINT FROM
  // WHICH THE LAST-POSITION (e) RE-CHECK CAN BE PINNED AT ALL, and it is here
  // rather than anywhere else because HERE IS WHERE THE WINDOW IS. Every other
  // seam in this file injects its tamper BEFORE `confirmBoundEvidence` is
  // entered, so the FIRST-position edge proof above catches it and the
  // last-position one is never the deciding guard — which is exactly why
  // stripping either position alone left the suite unchanged and only stripping
  // BOTH turned it red. The attack the last position exists to stop starts
  // AFTER the first-position proof has already returned: the (a)/(b)/(c)/(d)
  // proofs that follow are ALL descriptor-addressed and therefore survive a
  // namespace swap, and an attacker SIZES that window by inflating the attested
  // surface toward MAX_BASELINE_TOTAL_BYTES so the re-hashing runs long enough
  // to swap `.claude` inside it.
  //
  // IT IS CALLED, NOT AWAITED, AND A THENABLE REFUSES. This whole function must
  // stay synchronous and throw synchronously (`removeLatch` refuses a thenable
  // confirmation for exactly that reason — F8), so a seam that returned a
  // promise here would smuggle a microtask turn into the window the confirmation
  // exists to close, and its own tamper would land in an unobserved order.
  if (typeof insideConfirm === 'function') {
    const injected = insideConfirm();
    if (injected !== null && injected !== undefined && typeof injected.then === 'function') {
      throw refuse(
        `internal: the in-confirmation test seam returned a THENABLE. The bound confirmation is deliberately synchronous and is not awaited, so an ` +
          `asynchronous seam would run its body AFTER the confirmation had already finished — pinning nothing while appearing to. The latch is LEFT IN PLACE.`
      );
    }
  }

  // (a)+(b) PER-MEMBER: the retained descriptor still holds the verified bytes,
  // and the leaf NAME still denotes that very descriptor's object.
  for (const leaf of leaves) {
    confirmBoundFile(leaf, `the (B) path '${leaf.rel}'`);
  }

  // (c) MEMBERSHIP: re-list each RETAINED directory descriptor. No path is
  // re-resolved by name here — the listing is of the very inode that was
  // walked — so a member appearing or disappearing after the verdict is visible
  // even though the per-member checks above cannot see it.
  // F9 — the re-listing carries its own entry budget; it previously had NO count
  // check at all, so the one enumeration an attacker could still aim at this
  // process was the unbounded one.
  const confirmBudget = { entries: 0 };
  const countConfirmEntry = (relDir) => {
    confirmBudget.entries += 1;
    if (confirmBudget.entries > MAX_BASELINE_DIR_ENTRIES) {
      throw refuse(
        `the pre-removal re-listing of the (B) directory '${relDir}' passed ${confirmBudget.entries} entries, over the ${MAX_BASELINE_DIR_ENTRIES}-entry ` +
          `bound — a surface that GREW past the bound between the verdict and the removal is refused, never enumerated to the end. The latch is LEFT IN PLACE.`
      );
    }
  };
  for (const d of dirs) {
    const entries = listDirBound(d.handle, d.relDir, countConfirmEntry);
    const now = relevantNames(d.kind, entries);
    if (!sameNameSet(d.names, now)) {
      const appeared = [...now].filter((n) => !d.names.has(n));
      const gone = [...d.names].filter((n) => !now.has(n));
      throw refuse(
        `the (B) directory '${d.relDir}' CHANGED SINCE THE VERDICT was computed — its members are no longer the members that were verified` +
          `${appeared.length ? ` (appeared: ${appeared.join(', ')})` : ''}${gone.length ? ` (gone: ${gone.join(', ')})` : ''}. The latch is discharged only ` +
          `for a surface this call verified in full. The latch is LEFT IN PLACE.`
      );
    }
  }

  // (d) THE BASELINE LIST ITSELF, held open across the verdict for exactly the
  // same reason as every (B) leaf. In ADOPT mode this is the descriptor on the
  // file the rename INSTALLED, never the one it replaced.
  if (baseline) confirmBoundFile(baseline, LIST_WHAT);

  // (e) AGAIN, AND LAST — F10. THE FIRST-POSITION CALL IS NOT THE DEFECT; BEING
  // ONLY FIRST IS. Running the namespace rebinding first is what makes (a)-(d)
  // proofs about the tree the repository path actually reaches, so it stays.
  // But EVERYTHING AFTER IT IS DESCRIPTOR-ADDRESSED — `confirmBoundFile` resolves
  // through retained parent fds and the membership pass re-lists retained
  // directory fds — so all of it SURVIVES A NAMESPACE SWAP performed after the
  // edge proof returned.
  //
  // AND THE ATTACKER SIZES THAT WINDOW. A (B) surface legitimately inflated to
  // just under the bounds (255 files, ~64 MiB, all within MAX_BASELINE_FILES /
  // MAX_BASELINE_TOTAL_BYTES) makes the re-hashing above run for hundreds of
  // milliseconds AFTER the edges were proven; `mv .claude .claude.verified &&
  // mv .claude.tampered .claude` inside it left every retained descriptor
  // agreeing with the verdict against a DETACHED GHOST TREE, and the latch was
  // discharged for a live `.claude` that was never verified.
  //
  // THIS IS NOT THE ACCEPTED R1 RESIDUAL (0ac7be95). R1 is the IRREDUCIBLE
  // instant between the last observation and the act. This gap was neither
  // irreducible nor bounded by anything this process controls, and re-proving
  // the edges here shrinks it back to R1's floor: the namespace binding is now
  // ADJACENT to the unlink, with only `removeLatch`'s `unlinkSync` after it.
  confirmBoundRoots(roots);
  confirmBoundEdges(edges);
}

// ---------------------------------------------------------------------------
// F6, PROPERTY (e) — THE NAMESPACE EDGES. For every directory edge this call
// walked, require that `lstat(RETAINED PARENT DESCRIPTOR / CHILD NAME)` still
// yields the child this call pinned.
//
// WHY A NAME RE-WALK FROM THE ROOT WOULD NOT DO (rejected in 0ac7be95): the
// chain can be swapped DURING the re-walk, or the expected name briefly restored
// for the check and swapped again after. Resolving each edge THROUGH ITS OWN
// PINNED PARENT is one lstat per edge with no window between components, and it
// is the only form that ties the LIVE path to the SPECIFIC inodes already
// verified.
//
// AN EXPECTED ABSENCE IS A FULL MEMBER OF THIS SET, not an omission. When
// `.claude` (or `.claude/agents`) did not exist at verification time the walk
// recorded no descriptor, no leaf and no directory listing — so CREATING
// `.claude/settings.json` afterwards was invisible to every other property here.
// The edge now says "this name was ENOENT and must still be ENOENT".
// ---------------------------------------------------------------------------
function confirmBoundEdges(edges) {
  for (const edge of edges || []) {
    let st = null;
    try {
      st = lstatSync(`${edge.parentHandle}/${edge.name}`, isWin32() ? undefined : { bigint: true });
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        if (edge.expect === 'absent') continue; // verified absent, still absent.
        throw refuse(
          `the (B) namespace edge '${edge.rel}' NO LONGER EXISTS in the live tree (it was verified as dev/ino ${edge.dev}/${edge.ino}) — the descriptors ` +
            `this call held open would still resolve to the verified directory, which is exactly why the LIVE PATH is checked separately. The latch is ` +
            `LEFT IN PLACE.`
        );
      }
      throw refuse(
        `the (B) namespace edge '${edge.rel}' could not be re-resolved through the parent descriptor this call held open (${errText(e)}) — refusing to ` +
          `discharge an incident against a tree whose path cannot be re-established. The latch is LEFT IN PLACE.`
      );
    }
    if (edge.expect === 'absent') {
      throw refuse(
        `the (B) namespace edge '${edge.rel}' WAS ABSENT WHEN THE VERDICT WAS COMPUTED AND NOW EXISTS (dev/ino ${devOf(st)}/${inoOf(st)}) — a (B) root ` +
          `created after the verdict is attested by nothing at all: no descriptor, no hash and no directory listing covers it. The latch is LEFT IN PLACE.`
      );
    }
    if (st.isSymbolicLink() || devOf(st) !== edge.dev || inoOf(st) !== edge.ino) {
      throw refuse(
        `the (B) namespace edge '${edge.rel}' NO LONGER REACHES the directory this call verified (verified dev/ino ${edge.dev}/${edge.ino}, the live path ` +
          `now denotes ${devOf(st)}/${inoOf(st)}${st.isSymbolicLink() ? ', and it is now a symlink' : ''}) — a directory RENAMED ASIDE and replaced leaves ` +
          `every retained descriptor pointing at the DETACHED verified tree, where all bytes, identities and memberships still agree while the live tree was ` +
          `never verified at all. The latch is LEFT IN PLACE.`
      );
    }
  }
}

// F6 — THE ANCHOR. Every walk resolves `cwd` BY NAME, so the root is as
// substitutable as anything below it; a root renamed aside after the verdict
// detaches every retained descriptor in one move and no per-edge check would see
// it, because each edge is resolved through a parent that is itself inside the
// detached tree. Re-resolving the name and requiring the same identity is what
// binds the whole chain to the live filesystem. `statSync` (following) matches
// the root open's own follow semantics, which are the separately-ruled limit
// h17-repo-root-authentication-is-out-of-scope (f36eb854) — this check does not
// authenticate the root, it only proves it did not CHANGE mid-call.
function confirmBoundRoots(roots) {
  for (const r of roots || []) {
    let st;
    try {
      st = statSync(r.cwd, isWin32() ? undefined : { bigint: true });
    } catch (e) {
      throw refuse(
        `the project root '${r.cwd}' could not be re-resolved before the removal (${errText(e)}) — every descriptor this call retained resolves relative to ` +
          `an anchor that no longer answers. The latch is LEFT IN PLACE.`
      );
    }
    if (devOf(st) !== r.dev || inoOf(st) !== r.ino) {
      throw refuse(
        `the project root '${r.cwd}' NO LONGER DENOTES the directory this call walked (verified dev/ino ${r.dev}/${r.ino}, now ${devOf(st)}/${inoOf(st)}) — ` +
          `the entire verified tree has been detached from the live namespace in one move. The latch is LEFT IN PLACE.`
      );
    }
  }
}

function confirmBoundFile(bound, what) {
  let byName;
  try {
    byName = lstatSync(`${bound.parentHandle}/${bound.leaf}`, isWin32() ? undefined : { bigint: true });
  } catch (e) {
    throw refuse(
      `${what} CHANGED SINCE THE VERDICT was computed — it could no longer be re-resolved through the directory descriptor this call held open ` +
        `(${errText(e)}). The latch is LEFT IN PLACE.`
    );
  }
  if (byName.isSymbolicLink() || devOf(byName) !== bound.dev || inoOf(byName) !== bound.ino) {
    throw refuse(
      `${what} CHANGED SINCE THE VERDICT was computed — the name no longer denotes the object that was verified (verified dev/ino ${bound.dev}/${bound.ino}, ` +
        `now ${devOf(byName)}/${inoOf(byName)}${byName.isSymbolicLink() ? ', and it is now a symlink' : ''}). A substitution performed after the verdict is ` +
        `refused whether or not what replaced it agrees with the baseline. The latch is LEFT IN PLACE.`
    );
  }
  const { sha256 } = hashDescriptorBounded(bound, what);
  if (sha256 !== bound.sha256) {
    throw refuse(
      `${what} CHANGED SINCE THE VERDICT was computed — the bytes behind the descriptor this call held open across the verdict are no longer the bytes that ` +
        `were verified (verified sha256 ${bound.sha256}, now ${sha256}). A SELF-CONSISTENT substitution — tampered bytes written together with a baseline ` +
        `that attests them — is exactly what this binding exists to refuse: an incident is discharged only for bytes THIS call verified, never for bytes that ` +
        `merely agree with a manifest found on disk afterwards. The latch is LEFT IN PLACE.`
    );
  }
}

// ---------------------------------------------------------------------------
// THE LATCH, classified through a pinned `.sterling`. Returns
// `{ state, dev, ino }` where state is 'absent' | 'present'. Every abnormal
// shape REFUSES (Ruling 11's shape table): a directory, a symlink, a FIFO, an
// unreadable file, a classification error. `.sterling` itself missing or not a
// directory refuses; `.sterling` present without `sterling.db` is BROKEN STATE
// and refuses, and is never worded "not a Sterling project".
// THE IDENTITY (dev/ino) IS CAPTURED HERE so the removal can re-confirm it is
// still acting on the SAME OBJECT that passed verification (AC-R16).
// ---------------------------------------------------------------------------
async function classifyLatch(cwd) {
  return withScope(async (scope) => {
    const { handle, absentAt } = pinChain(cwd, STERLING_DIR, scope, `the (B) surface taint latch '${LATCH_REL}'`);
    if (handle === null) {
      throw refuse(
        `'${absentAt || STERLING_DIR}' is absent, so the (B) surface taint latch at '${LATCH_REL}' cannot be read at all. Refusing to report a clear that ` +
          `cannot be established. NAMED, UNSOLVED LIMIT: a wholly absent '${STERLING_DIR}/' cannot be mechanically distinguished from a directory that ` +
          `was never a Sterling project.`
      );
    }
    const dbKind = lstatKindAt(handle, DB_LEAF);
    if (dbKind !== 'file') {
      throw refuse(
        `'${STERLING_DIR}/' exists but '${STERLING_DIR}/${DB_LEAF}' is ${dbKind} — BROKEN STATE, not "not a Sterling project". Refusing to reconcile an ` +
          `enforcement incident in a half-present installation. The latch is LEFT IN PLACE.`
      );
    }
    const h = classifyLeafAt(handle, LATCH_LEAF);
    let primary;
    try {
      if (h.kind === 'absent') return { state: 'absent', dev: null, ino: null };
      if (h.kind !== 'file') {
        throw refuse(
          `'${LATCH_REL}' exists but is ${h.kind}, not a regular file — an abnormal shape at the latch path is never clearable, and nothing was read ` +
            `through it, replaced or removed. The latch path is LEFT EXACTLY AS FOUND.`
        );
      }
      return { state: 'present', dev: devOf(h.st), ino: inoOf(h.st) };
    } catch (e) {
      primary = e;
      throw e;
    } finally {
      closePinned(h.fd, primary);
    }
  });
}

// ---------------------------------------------------------------------------
// THE REMOVAL. Re-classifies the latch through a FRESHLY PINNED `.sterling`,
// requires it to still be a REGULAR FILE WITH THE SAME dev/ino that passed
// verification, runs `beforeUnlink` (F1's binding confirmation) as the last act
// before the syscall, and only then unlinks THROUGH THE PINNED PARENT.
//
// WHY `beforeUnlink` LIVES HERE rather than at the call site: the binding
// confirmation is only as good as its distance from the irreversible act, and
// putting it inside the removal walk means nothing but the unlink itself
// happens after it.
//
// WHAT THE PIN BUYS AND WHAT IT DOES NOT, stated rather than implied. `unlink`
// is a NAME operation — Node exposes no `unlinkat` — so a racer can still
// exchange WHICH ENTRY lives under the leaf name between the re-classification
// and the unlink. The blast radius is bounded to the pinned parent directory
// (`.sterling/`), never outside the repository and never through a link: unlink
// removes the LINK ITSELF, so even a symlink swapped in at the last instant
// costs a removed symlink, never a truncated or deleted victim. That is the same
// bounded, disclosed residual H17's own delete primitive carries and it cannot
// be closed without `unlinkat`.
// A FAILED REMOVAL IS A REFUSAL, NEVER A CLAIMED CLEAR, and NOTHING DESTRUCTIVE
// IS ATTEMPTED AS A WORKAROUND (no truncate-then-retry, no chmod "repair"): the
// latch must be left byte-identical so a re-run can still verify it.
// ---------------------------------------------------------------------------
async function removeLatch(cwd, verified, { beforeUnlink, beforeConfirm } = {}) {
  // F11 — THE BINDING IS NOT OPT-IN. `beforeUnlink` used to be guarded by
  // `if (typeof beforeUnlink === 'function')`, so a caller that simply omitted it
  // unlinked the latch with NO binding confirmation at all — a FAIL-OPEN DEFAULT
  // on the only irreversible act in this file, and the one argument that carries
  // properties (a)-(e). This mirrors `listDirBound`'s required-`countEntry`
  // refusal for exactly the same reason: an operation whose safety argument rests
  // on a callback must never run when the callback is absent.
  if (typeof beforeUnlink !== 'function') {
    throw refuse(
      `internal: the latch removal was invoked without a pre-unlink binding confirmation — the removal is authorized ONLY by evidence bound to the ` +
        `descriptors this call verified, so an absent confirmation is a REFUSAL and never an unconfirmed unlink. The latch is LEFT IN PLACE.`
    );
  }
  return withScope(async (scope) => {
    const { handle, absentAt } = pinChain(cwd, STERLING_DIR, scope, `the (B) surface taint latch '${LATCH_REL}'`);
    if (handle === null) {
      throw refuse(
        `'${absentAt || STERLING_DIR}' vanished BETWEEN VERIFICATION AND REMOVAL — refusing to act on a tree that is changing underneath the reconciliation. ` +
          `Nothing was removed.`
      );
    }
    const h = classifyLeafAt(handle, LATCH_LEAF);
    let primary;
    try {
      if (h.kind === 'absent') {
        throw refuse(
          `the latch at '${LATCH_REL}' vanished BETWEEN VERIFICATION AND REMOVAL — SOMETHING ELSE removed it, so this call cannot claim to have discharged ` +
            `the incident. Nothing was removed by this call.`
        );
      }
      if (h.kind !== 'file') {
        throw refuse(
          `the latch at '${LATCH_REL}' was a regular file when it was verified and is now ${h.kind} — it CHANGED BETWEEN VERIFICATION AND REMOVAL ` +
            `(mid-flight swap), which ABORTS the clear. Nothing at that path was read through, replaced or removed.`
        );
      }
      const dev = devOf(h.st);
      const ino = inoOf(h.st);
      if (dev !== verified.dev || ino !== verified.ino) {
        throw refuse(
          `the object at '${LATCH_REL}' is no longer the one that passed verification (verified dev/ino ${verified.dev}/${verified.ino}, now ${dev}/${ino}) — ` +
            `a file swapped in BETWEEN VERIFICATION AND REMOVAL ABORTS the clear. Nothing was removed.`
        );
      }
    } catch (e) {
      primary = e;
      throw e;
    } finally {
      closePinned(h.fd, primary);
    }

    // F1 — the LAST thing before the irreversible act.
    // DELIBERATELY SYNCHRONOUS AND NOT AWAITED: an `await` here would insert a
    // microtask turn between "the evidence was proven current" and the unlink,
    // widening by scheduling the very window this confirmation exists to close.
    //
    // F8 (R6) — AND THAT SOUNDNESS IS ASSERTED, NOT ASSUMED. Not awaiting is
    // correct only while the callback is synchronous and throws synchronously.
    // The day someone makes it `async` the promise would be DROPPED, every
    // refusal inside it would reject into the void, and the unlink would proceed
    // regardless — a total, silent bypass of the entire binding, introduced by an
    // edit that looks like a harmless modernisation. A comment cannot stop that;
    // this check can. It is fail-closed: a thenable REFUSES rather than being
    // awaited, because awaiting it here would reintroduce the scheduling window
    // the design deliberately excludes, and the caller must fix the callback.
    // SEAM 4 (`_testHookBeforeConfirm`) — the last point at which a tamper can
    // still be injected, because AFTER it nothing runs but the bound confirmation
    // and the unlink. It is what makes properties (b), (c), (d) and (e) pinnable
    // at all: a tamper injected at `_testHookBeforeRemoval` is still followed by a
    // full re-read/re-enumeration pass, so an ORDINARY re-verification catches it
    // and the binding never carries the verdict. It receives the EXACT function
    // value that runs as the confirmation, so a test can inspect its synchrony.
    if (typeof beforeConfirm === 'function') {
      await beforeConfirm(beforeUnlink);
    }

    const confirmation = beforeUnlink();
    if (confirmation !== null && confirmation !== undefined && typeof confirmation.then === 'function') {
      throw refuse(
        `internal: the pre-unlink binding confirmation returned a THENABLE. It is deliberately NOT awaited — awaiting it would schedule a microtask turn ` +
          `into the exact window between "the evidence was proven current" and the removal — so an asynchronous confirmation would decide NOTHING while ` +
          `the latch was removed anyway. Refusing rather than clearing on an unobserved verdict. The latch is LEFT IN PLACE.`
      );
    }

    try {
      unlinkSync(`${handle}/${LATCH_LEAF}`);
    } catch (e) {
      throw refuse(
        `the (B) surface taint latch at '${LATCH_REL}' passed verification but COULD NOT BE REMOVED (${errText(e)}) — the incident is NOT discharged and ` +
          `enforcement remains in force. The latch is LEFT BYTE-IDENTICAL; no destructive workaround was attempted. Resolve the filesystem condition ` +
          `(most often permissions on '${STERLING_DIR}/') and reconcile again.`
      );
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// SEAM VALIDATION — THE GUARD THAT KEEPS EVERY OTHER PIN HONEST (AC-R48).
//
// A seam this function does not accept, or accepts but can never call, fires
// NEVER — and a test wired to it injects no tamper while reporting success. That
// is the hollow class this whole pass exists to end (seven tests here were once
// hollow for exactly this reason), so BOTH shapes REFUSE BY NAME.
//
// (1) UNKNOWN NAMES ARE COLLECTED FROM THE CALLER'S OWN OBJECT, OWN AND
//     INHERITED. The earlier check read `Object.keys(...rest)`, which sees only
//     OWN ENUMERABLE string keys of a COPY. Three shapes walked straight past
//     it, each silently dropping the seam it named:
//       * a NON-ENUMERABLE own `_testBad` — never copied by the rest element;
//       * an INHERITED `_testBad` — likewise never copied;
//       * and worst, a RECOGNISED seam name inherited through the argument's
//         PROTOTYPE: the destructuring's [[Get]] DOES traverse the chain, so
//         that hook is fetched AND RUNS while the unknown-seam net, reading a
//         copy that never received it, reports nothing at all.
//     So the walk is `Reflect.ownKeys` over the object AND ITS PROTOTYPE CHAIN,
//     which covers enumerable and non-enumerable at every level.
//     WHAT THIS DELIBERATELY DOES NOT DO, so nobody adds ceremony for it:
//       * SYMBOL KEYS ARE IGNORED. A symbol cannot collide with a string seam
//         name and cannot be destructured as one, so it is not a bypass.
//       * An OWN `__proto__` DATA property is a string key that does not
//         prefix-match `_test`; it is not a case either.
//       * A non-object argument (string, number) has no keys to walk; the walk
//         simply does not start and the `cwd` refusal above already covers it.
//     NONE OF THESE SHAPES EVER LET A HOOK SKIP `confirmBoundEvidence` OR TURN A
//     BAD SURFACE INTO A CLEAR — the verdict path does not consult them. What
//     they defeat is the FAIL-LOUD SEAM VALIDATION ITSELF, which is a guard on
//     the suite's honesty rather than on the clearance decision.
//
// (2) A RECOGNISED HOOK SEAM SUPPLIED AS A NON-FUNCTION REFUSES. Every call site
//     guards with `typeof … === 'function'`, so `_testHookBeforeConfirm: null`,
//     `: true`, or an accidentally-invoked `: fn()` was accepted and then
//     silently never called — indistinguishable, from the test's side, from a
//     seam that fired and found nothing. `undefined` still means NOT SUPPLIED
//     (that is how every omitted seam arrives). `_testForcePlatform` is excluded
//     here because it is a STRING seam with its own stricter validation below.
//
// Returns a refusal string, or null when the seams are acceptable. It performs
// NO I/O and mutates nothing, so it is safe to run after the identity gate.
// ---------------------------------------------------------------------------
const RECOGNISED_TEST_SEAMS = Object.freeze([
  '_testHookAfterEnumeration',
  '_testHookBeforeRemoval',
  '_testHookBeforeDirectoryOpen',
  '_testHookBeforeConfirm',
  '_testHookInsideConfirm',
  '_testForcePlatform',
]);
const RECOGNISED_HOOK_SEAMS = Object.freeze(RECOGNISED_TEST_SEAMS.filter((name) => name !== '_testForcePlatform'));

function validateTestSeams(options) {
  const supplied = new Set();
  for (let o = options; o !== null && o !== undefined && (typeof o === 'object' || typeof o === 'function'); o = Reflect.getPrototypeOf(o)) {
    for (const key of Reflect.ownKeys(o)) {
      if (typeof key === 'string') supplied.add(key);
    }
  }

  const unknown = [...supplied].filter((k) => k.startsWith('_test') && !RECOGNISED_TEST_SEAMS.includes(k)).sort();
  if (unknown.length > 0) {
    return (
      `REFUSED — unrecognised test seam${unknown.length === 1 ? '' : 's'} supplied (${unknown.join(', ')}). A seam this function does not accept is ` +
      `DROPPED by the destructuring and never fires, so a test wired to it asserts nothing while reporting success. Recognised seams are ` +
      `${RECOGNISED_TEST_SEAMS.join(', ')}. Own and inherited properties are both checked, enumerable or not. Nothing was read or changed.`
    );
  }

  const uncallable = RECOGNISED_HOOK_SEAMS.filter((name) => options[name] !== undefined && typeof options[name] !== 'function').sort();
  if (uncallable.length > 0) {
    const detail = uncallable.map((name) => `${name} (${options[name] === null ? 'null' : typeof options[name]})`).join(', ');
    return (
      `REFUSED — recognised test seam${uncallable.length === 1 ? '' : 's'} supplied as a NON-FUNCTION (${detail}). Every seam call site guards with ` +
      `typeof === 'function', so a non-callable seam is accepted and then NEVER CALLED — which from the test's side is indistinguishable from a seam that ` +
      `fired and found nothing, and is the same silent hollowness an unrecognised name produces. Pass a function or omit the property entirely ` +
      `(undefined means NOT SUPPLIED). Nothing was read or changed.`
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// THE ENTRY POINT.
//
//   reconcileEnforcementTaint({ cwd, callerRole, callerAgentId, ...testHooks })
//     -> Promise<{ cleared: boolean, reason: string }>
//
// `cleared` is true ONLY IF the latch was removed BY THIS CALL. The converse
// does NOT hold, and the contract is stated in the direction that is actually
// true rather than the flattering one:
//   * EVERY DECISION PATH THAT DECLINES TO CLEAR leaves the latch exactly as
//     found. Every verdict, bound, classification, identity and confirmation
//     refusal resolves `{cleared:false, reason}` with nothing removed. This is
//     the property that matters, and it is the one that holds.
//   * A FAILURE AFTER A SUCCESSFUL `unlinkSync` IS REPORTED AS A FAILURE WHILE
//     THE LATCH IS ALREADY GONE. The `unlinkSync` is the last act of the removal
//     walk, but not the last act of the CALL: `removeLatch`'s own scope closes
//     its pinned `.sterling` chain immediately afterwards, and this function's
//     scope then closes every descriptor F1 retained.
//     A `closeSync` that throws there (EIO, or a descriptor already reaped)
//     rethrows because no primary error is in flight, so the call reports
//     `{cleared:false, reason: '...unexpected error...'}` — or rejects, if the
//     failure comes from the OUTERMOST scope, which closes after this function's
//     own catch has already returned — for an operation that DID discharge the
//     incident. Both roster reviewers found this independently; it is disclosed,
//     not fixed, because the alternative — swallowing a close failure to protect
//     the return shape — trades a loud, rare, RECOVERABLE misreport for a silent
//     descriptor leak marching toward EMFILE.
//   * THE MISREPORT IS FAIL-CLOSED AND SELF-CORRECTING: it under-claims, never
//     over-claims. Re-running is safe and refuses cleanly with AC-R12's
//     "no latch, nothing to discharge" once the latch is genuinely gone. THE ONE
//     OUTCOME THAT MUST NEVER OCCUR — `cleared:true` while the latch survives or
//     while unverified bytes were attested — is unaffected.
//
// THE IDENTITY GATE (F2), INVERTED AND FAIL-CLOSED — AND NOT AUTHENTICATION.
// READ THE FILE HEADER'S `callerRole` PARAGRAPH BEFORE RELYING ON ANY OF IT:
// both arguments below are CALLER-SUPPLIED ASSERTIONS, checked against nothing
// (and this module is not a pure function — it reads the tree and unlinks). They
// are fail-closed defence in depth against an unthreaded or careless caller;
// they stop nobody who can run Node under this UID. A wrapper must INJECT
// authorization from server-owned invocation context, and MUST NOT expose
// `callerRole`/`callerAgentId` in a public tool schema.
//   * `callerAgentId` SUPPLIED AS ANYTHING OTHER THAN `null`/`undefined`/`''`
//     => an AGENT is calling => REFUSED, however exact everything else is and
//     even when it also asserts conductorhood. NOT a truthiness test: `false`,
//     `0` and `NaN` refuse too, while an explicitly supplied `null` or `''`
//     passes — the check is a three-way comparison, not a `!callerAgentId`
//     (AC-R10 — an agent claiming to be the conductor while carrying its own
//     identity is the spoof this belt-and-braces ordering exists for).
//   * `callerRole` must be the EXACT string 'conductor'. Omitted, undefined,
//     null, '' and any other value REFUSE (AC-R24). ABSENCE IS NOT EVIDENCE OF
//     CONDUCTOR: there is no MCP wrapper and no production caller in this repo
//     yet, so the old absent-means-conductor default meant every clearance path
//     ran unidentified, and any wrapper that forgot to thread `agent_id` handed
//     every spawned agent the conductor-only privilege. THIS GATE MUST NOT BE
//     MISTAKEN FOR SECURITY — IT CARRIES NONE. `callerRole` is an assertion
//     supplied BY THE CALLER and checked against nothing: anyone able to run
//     Node under this UID can import this module and pass 'conductor'. It is
//     fail-closed defence in depth against a caller that supplies no
//     `callerRole` or the wrong one — NOT against a wrapper that forgets to
//     thread IDENTITY, since an absent `callerAgentId` is explicitly accepted.
//     Nor is it the last obstacle before a clear: the latch must exist, the
//     baseline list must match, both verification passes must agree, the (A)
//     tracked surface must be clean, and the bound confirmation must hold, all
//     independently of this argument. A real boundary requires authorization
//     INJECTED from server-owned invocation context, and
//     `callerRole`/`callerAgentId` must never appear in a public tool schema.
//
// `adopt` (default FALSE) SELECTS THE MODE, and it is deliberately an EXPLICIT
// FLAG rather than a fallback the absence of a list could trigger (fe861066 D5):
//   * FALSE — VERIFY. Reads the existing list, refuses if there is none, refuses
//     on any (B) delta and on (A) dirt, writes NOTHING.
//   * TRUE  — ADOPT. MINTS the list from the surface as it now is, which is an
//     acceptance and not a verification. With no latch it initialises and
//     removes nothing; with a latch it installs, binds the INSTALLED file, and
//     then removes the latch LAST. It proceeds on (A) dirt and names it loudly.
//   The gate above applies to BOTH modes: fe861066 D5 says ADOPT is
//   conductor-gated too, and it is the mode that WRITES.
//
// TEST-ONLY SEAMS — production callers MUST NEVER pass any of them:
//   `_testHookAfterEnumeration`   after the FIRST verdict, before the final pass.
//   `_testHookBeforeRemoval`      after the FINAL verdict, strictly before the
//                                 first syscall of the removal walk.
//   `_testHookBeforeDirectoryOpen` immediately before each discovered (B)
//                                 subdirectory is opened, with its repo-relative
//                                 forward-slash path; may fire many times.
//   `_testHookBeforeConfirm`      INSIDE the removal walk, after `.sterling` is
//                                 pinned and the latch's kind + dev/ino are
//                                 re-confirmed, and immediately before the bound
//                                 confirmation; receives that confirmation's
//                                 exact function value. NOTHING but the
//                                 confirmation and the `unlinkSync` follows it.
//   `_testHookInsideConfirm`      INSIDE `confirmBoundEvidence`, AFTER the
//                                 first-position `confirmBoundRoots`/
//                                 `confirmBoundEdges` and BEFORE the (a)/(b)/
//                                 (c)/(d) content proofs. SYNCHRONOUS — a
//                                 thenable REFUSES. It is the only point from
//                                 which the LAST-position (e) re-check is
//                                 individually pinnable, because every other
//                                 seam fires before this function is entered
//                                 and is therefore caught by the first position.
//   `_testForcePlatform`          a `process.platform` string, consulted by
//                                 `isWin32()` in place of the host's platform.
//                                 MONOTONE: only 'win32' has any effect and it
//                                 can only ADD the R4 refusal, never remove it,
//                                 so a real win32 host is unaffected by any
//                                 value. Exists so R4 is reachable from POSIX.
//
// AND AN UNKNOWN `_test*` PROPERTY IS A REFUSAL, NOT A SHRUG — AS IS A
// RECOGNISED SEAM SUPPLIED AS A NON-FUNCTION. A destructuring pattern DROPS a
// property it does not name, and every seam call site guards with
// `typeof … === 'function'`, so BOTH a misspelled name and a seam handed a
// non-callable produce a hook that never fires and a suite of tests that assert
// nothing while passing. That is not hypothetical: roughly seven tests here were
// wired to `_testHookBeforeConfirm` while this signature did not accept it, and
// every one of them was hollow. Both shapes now fail loudly and BY NAME (P5).
// `validateTestSeams` (immediately above) holds the exact semantics, including
// what the enumeration does and does not see.
// ---------------------------------------------------------------------------
export async function reconcileEnforcementTaint(options = {}) {
  // DESTRUCTURED FROM A NAMED OBJECT, NOT IN THE PARAMETER LIST, so that
  // `validateTestSeams` can inspect the CALLER'S OWN OBJECT. A rest element
  // (`...unknownOptions`) copies only OWN ENUMERABLE properties into a fresh
  // plain object, which is precisely why it could not see the shapes documented
  // at `validateTestSeams`. Behaviour for a non-object argument is unchanged:
  // `undefined` defaults to `{}`, `null` still throws on destructuring.
  const {
    cwd,
    callerRole,
    callerAgentId = null,
    adopt = false,
    _testHookAfterEnumeration,
    _testHookBeforeRemoval,
    _testHookBeforeDirectoryOpen,
    _testHookBeforeConfirm,
    _testHookInsideConfirm,
    _testForcePlatform,
  } = options;
  return withScope(async (scope) => {
    // F12 — the forcing depth is released by the mechanical end of this call
    // (P4), never by a remembered step, and never on a path that returned early.
    let forcedWin32 = false;
    try {
      // (1) THE IDENTITY GATE, FIRST AND BEFORE ANY I/O. Conductor-only is not a
      // late check to be reached after a happy path: refusing before touching the
      // filesystem keeps a caller that supplies no `callerRole` from using this
      // function as an oracle for the surface's state. It does NOT stop an
      // unauthorized one — anyone able to run Node under this UID self-asserts
      // 'conductor' and passes this gate (see the header).
      //
      // THE AGENT-IDENTITY ARM COMES FIRST so that a caller carrying BOTH an
      // agent identity and a conductor claim is attributed to the SPOOF it is,
      // not to a missing assertion.
      // THE CONDITION BELOW REFUSES ANY DECLARED IDENTITY AND TREATS THE EMPTY
      // STRING AS ABSENT — `null`, `undefined` and `''` all fall through to the
      // positive assertion. That is deliberate and is the documented contract
      // (F2 above: ABSENT means EXACTLY `null`/`undefined`/`''` and only those
      // three — NOT "falsy", since `false`/`0`/`NaN` refuse here like any other
      // supplied value; the test file's own seam contract: "absent/null/empty"). `''` is not a claim of agenthood — it is the shape
      // a wrapper produces when it has NO identity to thread — and it is not a
      // bypass either, because refusing it would change nothing on its own: the
      // caller must STILL supply the exact `callerRole` string on the next line,
      // and per the header that assertion is defence in depth rather than
      // authentication in the first place.
      if (callerAgentId !== null && callerAgentId !== undefined && callerAgentId !== '') {
        return {
          cleared: false,
          reason:
            `REFUSED — reconciliation is CONDUCTOR-ONLY and this call presented an agent identity (${JSON.stringify(String(callerAgentId))}). Clearing the ` +
            `(B) surface taint latch is a deliberate conductor act; no spawned agent is authorized to discharge an enforcement incident, however exactly the ` +
            `manifest matches the current surface. The latch is LEFT IN PLACE.`,
        };
      }

      // THE POSITIVE ASSERTION. Only the exact string clears — not any truthy
      // value, not a differently-cased one, not one with stray whitespace.
      if (callerRole !== CONDUCTOR_ROLE) {
        return {
          cleared: false,
          reason:
            `REFUSED — no explicit conductor assertion (callerRole) — an unidentified caller is not a conductor. This call supplied ` +
            `${callerRole === undefined ? 'nothing at all' : JSON.stringify(callerRole)}, and only the exact value ${JSON.stringify(CONDUCTOR_ROLE)} ` +
            `authorizes discharging an enforcement incident. ABSENCE IS NOT EVIDENCE OF CONDUCTOR: a caller that simply omits the argument — which every ` +
            `caller does until a wrapper threads it deliberately — must never inherit the conductor-only privilege by default. The latch is LEFT IN PLACE.`,
        };
      }

      // WHAT IS ACTUALLY CHECKED IS NON-EMPTY STRING — NOT ABSOLUTENESS. The
      // refusal text says exactly that, because a message promising a check the
      // code does not perform is how a caller comes to believe a relative `cwd`
      // was rejected. It is not: a relative path resolves against the process's
      // own working directory when `pinChain` opens the repo root by name. That
      // is the pre-existing, separately-ruled repo-root anchoring limit
      // (h17-repo-root-authentication-is-out-of-scope, knowledge_get f36eb854) —
      // an absoluteness test would not close it, so none is claimed here.
      if (typeof cwd !== 'string' || cwd.length === 0) {
        return {
          cleared: false,
          reason:
            'REFUSED — no project root was supplied (cwd must be a non-empty string; an absolute path is expected, and a relative one resolves against the ' +
            "calling process's working directory rather than being rejected). Nothing was read or changed.",
        };
      }

      // A SEAM THIS FUNCTION DOES NOT RECOGNISE — OR CANNOT CALL — IS A LOUD
      // FAILURE. Silently dropping either is how a hook that never fires reads as
      // a test that passed. The prefix is `_test`, not `_testHook`, so that a
      // misspelled `_testForcePlatform` is caught by the same net: it is a seam
      // exactly like the hooks, and a dropped one is the same silent hollowness.
      // The semantics — own AND inherited keys, symbols deliberately excluded,
      // non-function recognised seams refused — are documented at
      // `validateTestSeams`, which is where they must stay in one place.
      const seamRefusal = validateTestSeams(options);
      if (seamRefusal !== null) {
        return { cleared: false, reason: seamRefusal };
      }

      // (1a) F12 (SEAM 5) — THE PLATFORM OVERRIDE, APPLIED BEFORE THE R4 ARM AND
      // AFTER THE IDENTITY GATE. It is MONOTONE by construction (see `isWin32`):
      // only the exact string 'win32' changes anything, and it can only ever
      // ADD the refusal, never remove it, so on a native Windows host this
      // argument cannot influence the verdict at all. A non-string or empty
      // value REFUSES rather than being coerced or ignored — a seam whose
      // argument is silently dropped is the hollowness this whole pass exists to
      // end.
      if (_testForcePlatform !== undefined) {
        if (typeof _testForcePlatform !== 'string' || _testForcePlatform.length === 0) {
          return {
            cleared: false,
            reason:
              `REFUSED — the test seam _testForcePlatform was supplied with ${_testForcePlatform === null ? 'null' : `a ${typeof _testForcePlatform}`}, not a ` +
              `non-empty process.platform string. A seam given a value it cannot interpret is REFUSED, never silently ignored, because an ignored seam makes ` +
              `the platform arm it selects look pinned while the host's real platform decides. Nothing was read or changed.`,
          };
        }
        if (_testForcePlatform === 'win32') {
          FORCED_WIN32_DEPTH += 1;
          forcedWin32 = true;
        }
      }

      // (1b) F7 (R4) — NATIVE WINDOWS REFUSES RATHER THAN DEGRADING, and does so
      // before ANY filesystem access. Node cannot open a directory as a
      // descriptor on win32 and libuv ignores O_NOFOLLOW, so every pin here would
      // fall back to addressing parents BY PATH: the F1 evidence binding and the
      // F6 namespace rebinding both collapse into path-addressed re-reads, which
      // is precisely the TOCTOU shape this file exists to refuse. A silently
      // weaker guarantee on the platform most Sterling users run is not
      // acceptable under the standing parity requirement, and a clear granted on
      // it would be a claimed success this file must never produce. The latch
      // STAYS, so enforcement remains in force until reconciliation can be done
      // where it can be proven.
      if (isWin32()) {
        return {
          cleared: false,
          reason:
            `REFUSED — reconciliation is UNAVAILABLE on native Windows (platform 'win32'). This clearer discharges an enforcement incident only on evidence ` +
            `bound through descriptor-pinned, no-follow I/O; win32 offers neither directory descriptors nor O_NOFOLLOW, so both the evidence binding and the ` +
            `namespace rebinding would degrade to path-addressed re-reads that a substitution between checks defeats. REFUSING IS THE SAFE BEHAVIOUR AND THE ` +
            `DELIBERATE ONE: the (B) surface taint latch is LEFT IN PLACE and enforcement remains in force. Reconcile from a POSIX environment (WSL on this ` +
            `machine) until a native handle-relative implementation exists.`,
        };
      }

      // (2) THE LATCH FIRST — EXCEPT IN ADOPT MODE, WHOSE ORDERING fe861066 D2
      // DELIBERATELY OVERTURNS. Under VERIFY, no latch means no incident, and
      // reporting a clear that did not happen would tell a caller an incident was
      // resolved when none existed (AC-R12). Under ADOPT the absence of a latch
      // is the BOOTSTRAP case: there is a list to initialise even though there is
      // nothing to discharge, so the mode must be consulted before the latch is
      // allowed to end the call.
      const latch = await classifyLatch(cwd);
      if (latch.state === 'absent' && !adopt) {
        return {
          cleared: false,
          reason:
            `NO-OP — there is no (B) surface taint latch at '${LATCH_REL}', so there is no incident to discharge. Nothing was verified, created or removed. ` +
            `This is NOT a clear: no latch was removed by this call.`,
        };
      }

      // (2a) THE (A) HALF OF THE LATCH'S DOMAIN. Consulted in BOTH modes and
      // acted on differently in each: VERIFY refuses on dirt (a (B)-only
      // verification cannot discharge an (A) incident), ADOPT proceeds and says
      // so LOUDLY, because deliberate acceptance is exactly what ADOPT is.
      const dirt = trackedSurfaceDirt(cwd);
      if (!adopt) requireCleanTrackedSurface(dirt, 'before verification');

      // (3) THE SURFACE VERDICT. The two modes differ ONLY in where the (B)
      // comparator comes from — read in VERIFY, MINTED in ADOPT — and share every
      // binding, seam and removal step after it.
      let attested;
      let listBound;
      let listEdges;
      let listRoots;
      let final;

      if (adopt) {
        // ADOPT — ONE retained pass IS the verdict (fe861066 D5: "enumerate/hash
        // the surface via retained descriptors"). There is no prior list to
        // disagree with, so a second unretained pass would compare the surface to
        // itself and prove nothing the bound confirmation does not already prove.
        final = await collectBaseline(cwd, scope, { retain: true, onBeforeDirectoryOpen: _testHookBeforeDirectoryOpen });
        const minted = mintBaselineEntries(final.map);

        // SEAM 1 — after the surface verdict, before anything is mutated.
        if (typeof _testHookAfterEnumeration === 'function') {
          await _testHookAfterEnumeration();
        }

        // LIST BEFORE LATCH. The install happens strictly before the removal
        // walk, so the only crash state it can produce is "a fresh list plus a
        // present latch" — continued denial, discharged by a subsequent VERIFY.
        const installed = installBaselineList(cwd, scope, minted);
        attested = minted.length;
        listBound = installed.bound;
        listEdges = installed.edges;
        listRoots = installed.roots;

        if (latch.state === 'absent') {
          return {
            cleared: false,
            reason:
              `baseline initialized; no latch removed — ${LIST_WHAT} now attests the current (B) surface (${attested} path${attested === 1 ? '' : 's'}, ` +
              `exact set equality in both directions by construction). There was no (B) surface taint latch at '${LATCH_REL}', so nothing was discharged ` +
              `and no latch was created.${adoptDirtNote(dirt)}`,
          };
        }
      } else {
        // (3a) FIRST PASS — the baseline list and the current (B) surface, in a
        // scope of their own: nothing from this pass is carried into the verdict
        // that authorizes the removal, it exists to establish a reading the
        // second pass must still agree with.
        const first = await withScope(async (firstScope) => {
          const list = readBaselineList(cwd, firstScope);
          const { map } = await collectBaseline(cwd, firstScope, { retain: false, onBeforeDirectoryOpen: _testHookBeforeDirectoryOpen });
          return { list, map };
        });

        // (3b) THE FIRST VERDICT. Throws a refusal on anything less than exact.
        verifyExactBaseline(first.list, first.map);

        // (3c) SEAM 1 (`_testHookAfterEnumeration`) — after this verdict, before the final pass.
        if (typeof _testHookAfterEnumeration === 'function') {
          await _testHookAfterEnumeration();
        }

        // (3d) THE FINAL, BOUND PASS. Everything it opens — the pinned chains,
        // every (B) leaf, every walked (B) directory, the baseline list — is
        // RETAINED in this call's scope, so the verdict below is bound to
        // descriptors that stay reachable through the removal. This is F1: a
        // verdict whose evidence is released is a verdict that can be acted on
        // for bytes nobody verified.
        const listFinal = readBaselineList(cwd, scope, { retain: true });
        if (listFinal.kind !== first.list.kind || listFinal.present !== first.list.present || listFinal.sha256 !== first.list.sha256) {
          throw refuse(
            `${LIST_WHAT} CHANGED DURING VERIFICATION (was ${first.list.kind}/${first.list.sha256 ?? 'n/a'}, now ` +
              `${listFinal.kind}/${listFinal.sha256 ?? 'n/a'}) — a baseline that moves while it is being verified attests nothing, and the clear is ABORTED ` +
              `rather than completed on a stale verdict. The latch is LEFT IN PLACE.`
          );
        }
        final = await collectBaseline(cwd, scope, { retain: true, onBeforeDirectoryOpen: _testHookBeforeDirectoryOpen });
        if (!sameHashMap(first.map, final.map)) {
          throw refuse(
            `the (B) enforcement surface CHANGED DURING VERIFICATION — the set or bytes enumerated before the verdict differ from the set or bytes ` +
              `enumerated immediately before removal. The clear is ABORTED rather than completed on a stale verdict. The latch is LEFT IN PLACE.`
          );
        }

        // (3e) THE VERDICT THAT AUTHORIZES THE REMOVAL, computed from the BOUND
        // evidence rather than inherited from the first pass.
        attested = verifyExactBaseline(listFinal, final.map);
        listBound = listFinal.bound;
        listEdges = listFinal.edges;
        listRoots = listFinal.roots;
      }

      // F6 — the binding carries the NAMESPACE as well as the contents: every
      // directory edge walked by BOTH the (B) enumeration and the list read/
      // install, plus every anchor either of them resolved. Retained descriptors
      // alone attest a tree that may have been renamed out from under the
      // repository.
      const bound = {
        leaves: final.leaves,
        dirs: final.dirs,
        baseline: listBound,
        edges: [...final.edges, ...(listEdges || [])],
        roots: [...final.roots, ...(listRoots || [])],
      };

      // (4) SEAM 2 (`_testHookBeforeRemoval`) — the verdict is settled, the list
      // is on disk, and nothing aimed at the latch has happened yet. It fires on
      // the ADOPT path too, in the same window.
      if (typeof _testHookBeforeRemoval === 'function') {
        await _testHookBeforeRemoval();
      }

      // (5) CLEAR LAST. The removal walk pins `.sterling`, re-confirms the
      // latch's identity, then — as its last act before the unlink — proves
      // through the RETAINED descriptors that the surface and the baseline list
      // are still the exact bytes and objects this call verified. No atomicity is
      // required, because every intermediate state still denies.
      await removeLatch(cwd, latch, {
        // BOTH HALVES OF THE LATCH'S DOMAIN ARE RE-PROVEN HERE, and this callback
        // stays SYNCHRONOUS AND THROWS SYNCHRONOUSLY (F8/R6): `trackedSurfaceDirt`
        // is `spawnSync` and `requireCleanTrackedSurface` throws, so nothing here
        // schedules a microtask into the window it exists to close. The (A)
        // re-check runs FIRST so that `confirmBoundEvidence` keeps its F10
        // property of being ADJACENT to the unlink. ADOPT skips it: it already
        // accepted the (A) surface deliberately and said so out loud.
        beforeUnlink: () => {
          // UNPINNED DEFENCE IN DEPTH, MEASURED AND DISCLOSED RATHER THAN
          // ASSUMED (2026-08-30): disabling this line leaves the suite 55/55
          // GREEN, because no fixture dirties a TRACKED `hooks/**` path inside
          // the enumeration window — a pin would need a SEAM 2/SEAM 4 hook that
          // writes one. It is kept because the window it closes is real (the
          // first consultation precedes every hash), not because a test holds
          // it; treat it as regressible until such a pin exists.
          if (!adopt) requireCleanTrackedSurface(trackedSurfaceDirt(cwd), 'immediately before the removal');
          confirmBoundEvidence(bound, { insideConfirm: _testHookInsideConfirm });
        },
        beforeConfirm: _testHookBeforeConfirm,
      });

      return {
        cleared: true,
        reason: adopt
          ? `CLEARED (ADOPT) — ${LIST_WHAT} was minted from the current (B) surface (${attested} path${attested === 1 ? '' : 's'}), installed atomically, ` +
            `re-opened and re-verified against the surface verdict, and only then was the (B) surface taint latch at '${LATCH_REL}' removed — after the ` +
            `descriptors that produced that verdict were re-confirmed (bytes, identity, directory membership and namespace edges) as the last act before ` +
            `the removal.${adoptDirtNote(dirt)}`
          : `CLEARED — the (B) surface taint latch at '${LATCH_REL}' was removed after the current (B) surface was enumerated and hashed twice and found to ` +
            `agree with ${LIST_WHAT} EXACTLY (${attested} attested (B) path${attested === 1 ? '' : 's'}, exact set equality in both directions), and after ` +
            `the descriptors that produced that verdict were re-confirmed — bytes, identity and directory membership — as the last act before the removal. ` +
            `The tracked (A) enforcement surface was OBSERVED to match HEAD at two moments — before verification and again immediately before the removal — ` +
            `which is a moment-of-check observation on both halves, not a proof that nothing changed between or after them (0ac7be95 R1).`,
      };
    } catch (e) {
      if (e instanceof ReconcileRefusal) return { cleared: false, reason: `REFUSED — ${e.message}` };
      // A genuinely unexpected internal failure. It is still a REFUSAL, never a
      // claimed clear: "cannot establish" is fail-closed everywhere in this file.
      // THE WORDING IS DELIBERATELY "THIS CALL DOES NOT CLAIM TO HAVE CLEARED",
      // NOT "THE LATCH IS STILL THERE": one path reaches here AFTER a successful
      // removal — a descriptor-close failure inside `removeLatch`'s scope, which
      // throws once the unlink has already happened (see the entry-point
      // contract). Asserting the latch survives would be the same overclaim this
      // file has twice been caught making; under-claiming is the fail-closed
      // direction, and a re-run resolves the ambiguity by itself.
      return {
        cleared: false,
        reason:
          `REFUSED — reconciliation failed with an unexpected error (${errText(e)}). This call does NOT claim to have discharged the incident: treat ` +
          `enforcement as still in force, and CHECK '${LATCH_REL}' rather than assuming either way, because a failure raised AFTER the removal itself ` +
          `succeeded also reports here. This is a loud failure, not a silent one: investigate, then re-run — a re-run refuses cleanly if the latch is gone.`,
      };
    } finally {
      // F12 — released on EVERY exit: the entitled path, every early refusal
      // return above it, and any throw. A leaked increment would only ever make
      // a later call MORE refusing (`isWin32` is an OR), so even this failing
      // would fail closed — but it is still lifecycle-bound rather than left to
      // the happy path.
      if (forcedWin32) FORCED_WIN32_DEPTH -= 1;
    }
  });
}
