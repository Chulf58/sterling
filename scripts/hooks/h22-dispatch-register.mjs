// H22 — in-flight dispatch register (decision ec9eacaa, boards 54c451b4 /
// 570832d4). ONE hook file registered on BOTH SubagentStart and SubagentStop,
// switching on stdin.hook_event_name: Start appends {agent_id, agent_type,
// session_id, files, at} to .sterling/transient/dispatch-register.json, Stop
// removes the entry whose agent_id matches — EXCEPT for a reviewer-class
// entry (agent_type starting with the literal prefix 'reviewer-'), which is
// first PROMOTED as {agent_type, files, at, session_id, branch, base_sha}
// — plus an OPTIONAL reviewed_state {completed_at, blobs, truncated?,
// truncated_of?} carrying the review-END instant and the git blob sha of each
// reviewed file as it stood at Stop, and — only past REVIEWED_BLOBS_CAP files
// — disclosing that the binding covers just the first 64 rather than the
// whole territory (board 0f448efb; see reviewEndState below) —
// into the durable review ledger
// at .sterling/review-ledger.json (STORE ROOT, not transient/, so it
// survives H1's session wipe — decision 12a26ca6-a301-466d-a45c-5e1eeff36694,
// slug review-receipt-ledger) and then removed from the register exactly as
// before. The last three fields are the receipt's IDENTITY (decision
// review-ledger-receipt-expiry, 0408b295): they are what lets
// scripts/commit-reviewed.mjs refuse to stamp a receipt that outlived the
// session/branch that earned it, instead of spending it on an unrelated later
// commit — the measured stale-spend leak (board 09e03d76). The register is what makes live fan-out a DISCLOSED FACT rather
// than conductor memory — H10 reads it at Stop and defers file duties owned
// by a live dispatch, instead of reading an agent's work-in-progress as
// conductor negligence (570832d4: the same capture_pending minted three
// times in one hour).
//
// LIVE-PROBED, not inferred: SubagentStart (research_finding 35a89a0f, CC
// 2.1.220) and SubagentStop (research_finding 20b44518, CC 2.1.237 — fires for
// background agents; agent_id is byte-stable across start→stop). NEITHER event
// carries a prompt field, so `files` is recovered from the PARENT transcript at
// transcript_path via the shared lib/dispatch-prompt.mjs extractor — the union
// across a message's parallel dispatch blocks is an accepted, disclosed
// imprecision (it can over-attribute a sibling's files, which over-defers; the
// staleness TTL in H10 bounds that).
//
// NEVER A GATE (h19-dispatch-staging posture): this hook must never deny a
// spawn or a stop. Internal failure is loud but non-blocking (warnNonBlocking,
// exit 1); a corrupt register on disk degrades to empty and is rewritten valid.
//
// CONCURRENCY, stated honestly — REGISTER vs LEDGER are NOT the same case.
// The register's write is ATOMIC (tmp file + rename), so a concurrent READER
// — H10 at Stop, a sibling fire — never sees a torn file: a torn read
// degrades the WHOLE register to empty, which would drop every live entry at
// exactly the moment fan-out traffic makes that most likely. The register's
// read-modify-write LOST UPDATE is NOT solved and is accepted: two fires
// overlapping between read and rename means the loser's change vanishes. It
// cuts BOTH ways — a lost Start under-defers (a duty fires that could have
// waited), and a Start that re-writes an entry a concurrent Stop had just
// removed OVER-defers (a duty waits that was already owed). Both are bounded,
// never permanent: H10's staleness TTL stops honoring an orphan entry, and H1
// deletes the register outright at the next session start.
//
// THE DURABLE REVIEW LEDGER IS THE OPPOSITE CASE — the register's acceptance
// above does NOT transfer to it. The ledger has no TTL and H1 never wipes it
// (that survival is the whole point), so a lost update there is bounded by
// NOTHING: it is a permanent loss of reviewer evidence that
// scripts/commit-reviewed.mjs can never recover. That asymmetry is exactly
// why the ledger's read-modify-write (here, and in commit-reviewed's consume
// step) is LOCK-GUARDED (withLedgerLock below) — the register's
// "accept the lost update" posture would be the wrong call applied to a file
// with no self-healing mechanism.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking, repoRel, loadConfig } from './lib/common.mjs';
import { lastDispatchBlocks, extractPathCandidates, parseReviewTerritory } from './lib/dispatch-prompt.mjs';
import { probeDirtyPaths, formatResidueLine, claimedResources } from './lib/dispatch-residue.mjs';
import { hasUnsuppressedMatch, escapeRe, extractGlobPrefixCandidates } from './lib/dispatch-advisory.mjs';
import { acquireLock, registerLockDir } from './lib/dispatch-register-lock.mjs';

// REGISTER LOCK (decision register-writers-cooperating-lock, 1e0ba0d0, board
// 673ca3f6) — guards the register's whole-array read-modify-write on BOTH
// SubagentStart (append) and SubagentStop (remove + the prune pass). Unlike
// the ledger lock above, TIMEOUT POSTURE HERE IS SKIP, NEVER UNLOCKED: an
// unlocked whole-array rewrite can erase every concurrent sibling's
// mutation, while skipping loses at most THIS ONE fire's mutation, bounded
// and disclosed. The lock PATH comes from the shared registerLockDir()
// (review-fix round) — every writer (this hook, H10, H1) derives it from the
// ONE spelling in lib/dispatch-register-lock.mjs, never a locally respelled
// literal a typo could silently unlock. It is never blindly deleted —
// stale-steal (10s) is the only recovery for a crashed holder.
const REGISTER_RETRY_MS = 1000;
const REGISTER_STALE_MS = 10_000;
async function acquireRegisterLock(cwd) {
  mkdirSync(join(cwd, '.sterling', 'transient'), { recursive: true });
  return acquireLock(registerLockDir(cwd), { retryMs: REGISTER_RETRY_MS, staleMs: REGISTER_STALE_MS });
}

// SPEC B: .sterling/config.json's top-level `exclusive_resources: string[]`
// (absent/malformed -> none, soft posture — this hook never gates on config).
function loadExclusiveResourceNames(cwd) {
  try {
    const names = loadConfig(cwd)?.exclusive_resources;
    return Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.trim().length > 0) : [];
  } catch {
    return [];
  }
}

// RECEIPT IDENTITY (decision review-ledger-receipt-expiry, 0408b295) — the git
// half of what a promoted receipt records about WHERE it was earned.
//
// BRANCH: `git symbolic-ref --quiet --short HEAD`, deliberately not
// `rev-parse --abbrev-ref HEAD`. Under a DETACHED HEAD (a case neither the
// decision nor board 09e03d76 defines) rev-parse invents the literal string
// 'HEAD', which two unrelated detached states would SHARE — a receipt earned in
// one would then read as same-branch in the other. symbolic-ref returns nothing
// there, so this records null: "this receipt has no branch identity", which is
// the honest statement and degrades to unjudgeable-hence-eligible downstream
// rather than to a false match.
//
// BASE_SHA: HEAD AT PROMOTION TIME — the commit the reviewed working tree was
// based on. Deliberately NOT a merge-base with a default branch: that needs an
// origin/HEAD (or a guessed 'main') probe which simply does not resolve in a
// repo without a remote, so it would record NOTHING in exactly the cases a
// plain HEAD records the right thing; and what the receipt needs to state is
// WHAT WAS REVIEWED, which HEAD-at-review names exactly.
//
// Both degrade to null and NEVER throw: a cwd with no git repository at all
// must still promote the receipt, because this hook never denies a stop.
function gitReceiptIdentity(cwd) {
  const git = (args) => {
    try {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000 });
      return r.status === 0 ? normIdentity(r.stdout) : null;
    } catch {
      return null;
    }
  };
  return {
    branch: git(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    base_sha: git(['rev-parse', 'HEAD']),
  };
}

// REVIEW-END CONTENT EVIDENCE (board 0f448efb). THE DEFECT THIS CLOSES, in two
// halves that are really one: (1) a receipt was never checked against THE BYTES
// IT REVIEWED — commit-reviewed's eligibility was session + branch + FILENAME
// intersection, never content — and (2) the receipt's only timestamp, `at`, is
// copied from the register entry, which stamps it at SubagentSTART (see the
// Start branch below). So `at` marks when the review BEGAN, and a long review of
// early bytes reads as FRESHER than it is. Both halves have the same root cause:
// nothing was recorded at the moment the review ENDED.
//
// WHAT IS RECORDED: the git blob sha of each reviewed file AS IT STANDS AT STOP,
// plus the Stop instant. base_sha (HEAD) does not answer this — a reviewer reads
// the UNCOMMITTED working tree, which moves freely while HEAD stands still, so a
// receipt can already carry the right base_sha for bytes that changed after it
// was earned.
//
// WHY BLOB SHAS AND NOT MTIMES: the reporter's cheap version (compare `at`
// against the newest staged mtime) is defeated by a `touch` and by any checkout
// that rewrites mtimes without changing content; a content hash is not.
// `git hash-object` rather than a hand-rolled sha1 of the raw bytes, because it
// applies the SAME clean/eol filters `git add` applies — so the value is
// directly comparable to the INDEX blob sha commit-reviewed reads at spend time,
// including on Windows checkouts with autocrlf on, where raw-content hashing
// would mismatch on every single file.
//
// POSITIVE EVIDENCE ONLY, and that is why this is ONE optional key rather than
// two required ones. When no reviewed path resolves to a readable file there is
// no content evidence — and nothing to anchor a completion time TO — so the key
// is omitted entirely and every downstream check degrades to exactly today's
// behavior (unjudgeable → eligible), the same failure direction the whole
// receipt-expiry design already takes. Omission also matches the
// copy-if-present, never-fabricated posture `files_source`/`attribution` already
// use on this receipt: JSON.stringify drops an undefined-valued key, so the
// promoted entry genuinely lacks it rather than carrying an empty default.
//
// NEVER THROWS, NEVER GATES: every failure path (no git, a non-zero exit, an
// output shape that does not line up 1:1 with the inputs) returns undefined. A
// PARTIAL result is deliberately discarded rather than recorded — a blob map
// missing entries it should have had would read downstream as "these files were
// not reviewed" and manufacture a false disclosure out of a tooling failure.
const REVIEWED_BLOBS_CAP = 64; // far above any real review territory; bounds the argv this builds
function reviewEndState(cwd, files) {
  try {
    const uniqueFiles = Array.isArray(files) ? [...new Set(files.filter((f) => typeof f === 'string' && f !== ''))] : [];
    // TRUNCATION IS A CAP, NOT A FAILURE — recorded, never silent (review
    // finding, MEDIUM). Slicing to the cap before hashing is deliberate (it
    // bounds the argv `git hash-object` is spawned with), but for a review
    // territory past the cap the receipt must not read as fully bound just
    // because the shape it produces is identical to a complete one.
    // `truncated`/`truncated_of` name exactly how partial the binding is, so a
    // reader can tell "bound" from "bound as far as the cap" — this never
    // refuses anything (the user ruled WARN, not REFUSE, for this whole
    // mechanism); it only makes the cap's effect visible instead of silent.
    const truncated = uniqueFiles.length > REVIEWED_BLOBS_CAP;
    const paths = uniqueFiles.slice(0, REVIEWED_BLOBS_CAP);
    // Only regular files can be hashed. Filtering FIRST matters: `git
    // hash-object` fails as a whole when any one argument is missing, so a
    // single deleted path would otherwise cost the evidence for every other
    // file in the same receipt.
    const present = paths.filter((p) => {
      try {
        return statSync(join(cwd, p)).isFile();
      } catch {
        return false;
      }
    });
    if (present.length === 0) return undefined;
    // `--` terminates options, so a path beginning with '-' is a path.
    const r = spawnSync('git', ['hash-object', '--', ...present], { cwd, encoding: 'utf8', timeout: 10_000 });
    if (!r || r.error || r.status !== 0) return undefined;
    const shas = (r.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f]{40}$/i.test(l));
    // 1:1 or nothing — see the PARTIAL note above. git emits one sha per input
    // in argument order, so any other count means the output cannot be aligned
    // with the paths and must not be guessed at.
    if (shas.length !== present.length) return undefined;
    const blobs = {};
    present.forEach((p, i) => {
      blobs[p] = shas[i];
    });
    return {
      completed_at: new Date().toISOString(),
      blobs,
      // Present only when true — same copy-if-present, never-fabricated
      // posture as the other optional receipt fields (JSON.stringify drops an
      // undefined-valued key, so an untruncated receipt genuinely lacks it).
      ...(truncated ? { truncated: true, truncated_of: uniqueFiles.length } : {}),
    };
  } catch {
    return undefined;
  }
}

// EMPTY IS NULL AT THE WRITING END TOO (Codex review, MEDIUM). A promoted
// receipt must never carry `session_id: ''` or `branch: ''`: an empty string is
// PRESENT evidence that means nothing, and it invites every reader to disagree
// about whether it is an identity or an absence. Normalizing here means the
// only two states that ever reach the ledger are "a usable identity" and null,
// so scripts/commit-reviewed.mjs's matching normalization (its own normIdentity)
// has nothing left to disambiguate. Trimming matches what that CLI already did
// to STERLING_SESSION_ID, so a session_id arriving with stray whitespace cannot
// read as foreign against its own session.
function normIdentity(v) {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null; // null/undefined/object/array → no usable identity, recorded as absence
}

// PER-BLOCK ATTRIBUTION (decision 5d3747c1, slug h22-per-block-attribution) —
// replaces the old union-of-every-block-regardless-of-type extraction. Match
// this SubagentStart's stdin.agent_type against each Task/Agent block's
// declared subagent_type in the LAST dispatching assistant message: exactly
// one match is a precise 'block' attribution; several same-type siblings are
// a 'union' of just that type (H10's deferral asymmetry prefers bounded
// over-defer to under-defer, never unrelated types); zero matches walks
// BACKWARD through recent dispatching messages (bounded — the cross-batch
// race where a later batch's message lands before an earlier batch's
// SubagentStarts fire) for a type-match, and only once that bounded walk
// finds nothing does it fall back to a 'union' of the last message's blocks.
const MAX_WALK_BACK = 20;

function attributeBlocks(transcriptPath, agentType) {
  const lastBlocks = lastDispatchBlocks(transcriptPath, 0);
  // A missing/empty stdin.agent_type must never be matched against a block
  // whose own subagent_type is also missing — undefined === undefined would
  // mint a false 'block' attribution (the label H26 warns on). Require a real
  // string on BOTH sides before treating it as a match.
  if (typeof agentType !== 'string' || agentType === '') {
    return { blocks: lastBlocks, attribution: 'union' };
  }
  let matched = lastBlocks.filter((b) => typeof b.subagent_type === 'string' && b.subagent_type === agentType);
  if (matched.length === 1) return { blocks: matched, attribution: 'block' };
  if (matched.length > 1) return { blocks: matched, attribution: 'union' };
  for (let skip = 1; skip <= MAX_WALK_BACK; skip++) {
    const blocks = lastDispatchBlocks(transcriptPath, skip);
    if (!blocks.length) continue; // this dispatching message had no blocks with a string prompt — keep walking, the loop is still bounded by MAX_WALK_BACK
    matched = blocks.filter((b) => typeof b.subagent_type === 'string' && b.subagent_type === agentType);
    if (matched.length === 1) return { blocks: matched, attribution: 'block' };
    if (matched.length > 1) return { blocks: matched, attribution: 'union' };
  }
  // Bounded walk found no type-match anywhere: fall back to the union of the
  // last dispatching message's blocks, same as the pre-fix behavior, but now
  // explicitly marked imprecise.
  return { blocks: lastBlocks, attribution: 'union' };
}

function candidatesFromBlocks(blocks) {
  return [...new Set(blocks.flatMap((b) => extractPathCandidates(b.prompt)))];
}

// REVIEW-TERRITORY resolution (decision 8f137474,
// review-territory-structured-receipt-files) — the entry-level `files`
// source, replacing a bare candidatesFromBlocks() call at SubagentStart.
// Per attributed block, a REVIEW-TERRITORY line (parseReviewTerritory,
// lib/dispatch-prompt.mjs) is parsed and PREFERRED over free-prose
// extraction for that block; a malformed declaration is never silently
// swallowed (H22 never denies, but it never stays quiet about broken input
// either).
//
// AGGREGATION ACROSS BLOCKS: any block with a WELL-FORMED declaration
// contributes its declared array, never its free-prose extraction —
// whether every matched block declared (the common case) or only some did
// (mixed declared/undeclared or declared/malformed): once at least one
// block declares, the union of declared arrays is authoritative and
// files_source is 'review-territory'. Only when NO matched block declares
// (all absent and/or malformed) does this fall through to the union of
// free-prose extraction over every block's prompt, files_source
// 'free-prose-fallback' — identical to pre-fix behavior.
//
// STDERR TRUTH (review-fix round): the warning states what ACTUALLY happens
// to the malformed block's content, which depends on whether a sibling
// declared — computed AFTER `declaredWins` is known, not before. When a
// sibling block declared, this block's free-prose is DROPPED entirely (the
// declared array is exclusively authoritative, per T7b) — saying "falls
// back to free-prose for this block" there would be a lie, since no
// free-prose from this block ever reaches `files`. When nothing declared,
// this block's own prose DOES contribute to the free-prose union that wins.
function resolveTerritory(blocks) {
  const parsed = blocks.map((b) => ({ block: b, decl: parseReviewTerritory(b.prompt) }));
  const declared = parsed.filter((p) => p.decl.present && p.decl.valid);
  const declaredWins = declared.length > 0;
  const warnings = parsed
    .filter((p) => p.decl.present && !p.decl.valid)
    .map((p) =>
      declaredWins
        ? `H22: malformed REVIEW-TERRITORY declaration ignored — a sibling block's valid declaration is authoritative for this dispatch, so this block's prose (including this line) is DROPPED entirely, not free-prose-extracted: ${p.decl.raw}`
        : `H22: malformed REVIEW-TERRITORY declaration ignored, falling back to free-prose extraction across all attributed blocks: ${p.decl.raw}`
    );
  if (declaredWins) {
    return { candidates: [...new Set(declared.flatMap((p) => p.decl.files))], files_source: 'review-territory', warnings };
  }
  return { candidates: candidatesFromBlocks(blocks), files_source: 'free-prose-fallback', warnings };
}

// TERRITORY EXAMINED vs TERRITORY CLAIMED — the write-side half of the
// negation guard (board c56862a9, research_finding 289cd172
// h26-registers-do-not-touch-paths-as-held-territory).
//
// THE MEASURED DEFECT WAS AN ASYMMETRY, NOT AN ABSENCE. H26 already suppresses
// a prohibition-clause path on READ (h26-dispatch-overlap.mjs, the same
// hasUnsuppressedMatch call with checkSubjectVerb:false), but H22 wrote the
// register with a BARE extractPathCandidates — so a brief's "DO NOT TOUCH:
// <path> (another lane owns it)" was STORED as territory this dispatch holds,
// and the next dispatch that legitimately owned that path was warned against a
// lane that would never write it. Seven measured false positives in one
// session, every one from a do-not-touch brief line: the more careful the
// brief, the more false warnings — exactly inverted incentives.
//
// WHY THIS IS AN ADDITIONAL FIELD AND NOT A FILTER ON `files`. `files` is
// MULTIPLEXED across four consumers and means TERRITORY EXAMINED, not only
// territory claimed: durable review receipts (promoted at Stop below, read by
// scripts/commit-reviewed.mjs where an EMPTY files[] is the STRONGEST
// unverifiable-territory signal), the kill-signature residue probe, and H10's
// capture-duty deferral. Filtering `files` in place would make the reviewer
// brief "do not modify X, only review it" promote a receipt naming NO files —
// trading four cosmetic warn-only false positives for a silent degradation of
// merge-gate review evidence. So `files` is left byte-identical and the
// negation-aware subset is written BESIDE it as `claimed_files`, which H26
// (write territory) prefers; every other consumer keeps reading `files`.
//
// ALWAYS WRITTEN, EVEN EMPTY — deliberately unlike `exclusive_resources` (which
// is absent when unclaimed). Absence here MEANS "legacy entry, written before
// this field existed", and H26 falls back to `files` for those; an omitted
// empty array would read as legacy and resurrect the very false positive.
//
// SUPPRESSION IS PER BLOCK: a path negated in one block's prompt but claimed in
// a sibling's is claimed. (Under attribution:'block' there is only one block.)
//
// DISCLOSED MISS (accepted, under-warning direction, board c56862a9 item 2):
// no polarity reset exists — neither "but", "instead", nor a comma ends a
// prohibition clause — so "Do not edit tests/x.test.mjs, instead implement the
// fix in src/auth.mjs" loses src/auth.mjs from claimed_files too. That costs a
// MISSED overlap warning, which is the direction this advisory family already
// accepts over crying wolf (P1, parallel-lanes "bounded under-warning"), and
// `files` still records it for the receipt/residue/H10 consumers.
function claimedFromBlocks(blocks) {
  return [
    ...new Set(
      blocks.flatMap((b) =>
        extractPathCandidates(b.prompt).filter((raw) =>
          // The SAME call the read side makes (h26-dispatch-overlap.mjs): one
          // shared detector, never a second divergent heuristic — that
          // divergence WAS the defect. checkSubjectVerb:false because
          // "implement the feature in <path>" is a legitimate territory
          // declaration for a FILE candidate (that guard is for H25's tool
          // mentions). Matched against the RAW extracted substring, which
          // PATH_CANDIDATE_RE guarantees appears literally in the prompt.
          hasUnsuppressedMatch(b.prompt, new RegExp(escapeRe(raw)), { checkSubjectVerb: false })
        )
      )
    ),
  ];
}

// GLOB LITERAL-PREFIX CLAIMS (board a63b226d) — the sibling of
// claimedFromBlocks above, for the SEPARATE blind spot research_finding
// 289cd172 flagged: a brief writing territory as a literal-prefix "**" glob
// ("YOUR FILES: scripts/hooks/**") registered NOTHING via bare
// extractPathCandidates (PATH_CANDIDATE_RE requires a literal '.', which no
// glob token carries). ONE SHARED DETECTOR for suppression, same as above
// (board a63b226d point 3) — a glob named only inside a prohibition
// ("DO NOT TOUCH: scripts/hooks/**") must not register as held, checked
// against the RAW glob token (`${prefix}**`), which is what literally
// appears in the prompt (extractGlobPrefixCandidates strips the trailing
// '**' from its return value; hasUnsuppressedMatch needs it back to find
// the literal substring).
//
// WRITTEN TO ITS OWN FIELD, NOT FOLDED INTO claimed_files — see the
// GLOB_PREFIX_RE comment in lib/dispatch-advisory.mjs for why: claimed_files
// is a flat FILE-path list compared by exact string equality by its one
// reader (H26), and repoRel/normalizeRepoPath legitimately strips a
// trailing '/', so a trailing-slash marker could not survive the same
// toRegisterPaths() normalization every candidate here already goes
// through. A dedicated field means claimed_files keeps its existing shape,
// semantics and every existing consumer byte-identical.
function globPrefixesFromBlocks(blocks) {
  return [
    ...new Set(
      blocks.flatMap((b) =>
        extractGlobPrefixCandidates(b.prompt).filter((prefix) =>
          hasUnsuppressedMatch(b.prompt, new RegExp(escapeRe(`${prefix}**`)), { checkSubjectVerb: false })
        )
      )
    ),
  ];
}

// Tiny shared-convention lock guarding the review-ledger read-modify-write
// (duplicated here and in scripts/commit-reviewed.mjs — hooks stay
// dependency-light, so this is ~15 lines copied rather than a shared import;
// see the mirror copy there). mkdirSync is the atomic primitive: two
// processes racing to create the same directory, exactly one wins and the
// other gets EEXIST — no extra library needed. A lock dir older than 10s is
// treated as abandoned (a crashed holder) and removed. On timeout this
// proceeds UNLOCKED with a loud stderr note rather than crashing — the hook
// still never exits 2 for this (h19-dispatch-staging posture).
function withLedgerLock(sterlingDir, run) {
  const lockPath = join(sterlingDir, 'review-ledger.lock');
  let acquired = false;
  for (let i = 0; i < 200 && !acquired; i++) {
    try {
      mkdirSync(lockPath);
      acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 10_000) {
          rmSync(lockPath, { recursive: true, force: true }); // stale — remove and retry immediately
          continue;
        }
      } catch {
        continue; // lock vanished under us (released concurrently) — retry immediately
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // ~5ms, no async available here
    }
  }
  if (!acquired) {
    process.stderr.write('H22: review-ledger lock timed out — proceeding UNLOCKED (degraded-loud); a concurrent writer may lose this update\n');
    return run();
  }
  try {
    return run();
  } finally {
    rmdirSync(lockPath);
  }
}

const input = readStdin();

try {
  // Not a Sterling project — no ceremony, and above all nothing created (P1).
  // Keyed on `.sterling/config.json`'s EXISTENCE, not the sterling.db FILE
  // (board 03ed9d461/31565253 fixer note) and not the bare `.sterling/`
  // directory (fixer round, 2026-08-25 addendum): this hook never opens the
  // store — it only ever reads/writes config.json, the transient register,
  // the durable review ledger, and a git probe — so a project with
  // .sterling/config.json but no sterling.db yet (a project mid-init, or
  // SPEC A/B's dispatch-residue-and-resources fixtures) is still a Sterling
  // project for every duty this hook performs. Gating on config.json rather
  // than the bare directory is STRICTER: a mid-init bare `.sterling/` (no
  // config.json written yet) no longer accumulates a register or, worse, a
  // durable review-ledger.json. Sibling h26-dispatch-overlap.mjs reached the
  // same conclusion for its resource check ("it never needed the sterling.db
  // gate to begin with"). The pinned non-Sterling control (h22-dispatch-
  // register.test.mjs) uses a bare dir with NO .sterling/ at all, so this
  // stays exactly as strict for that case; every frozen fixture writes
  // config.json, so this stays green everywhere else too.
  if (!existsSync(join(input.cwd, '.sterling', 'config.json'))) allow();

  const event = input.hook_event_name;
  // What a skipped update actually COSTS, named per event so the warning can
  // never read as harmless: a missed Start under-defers, a missed Stop leaves a
  // dead agent's entry deferring real duties until the TTL or H1's sweep.
  const consequence =
    event === 'SubagentStop'
      ? `the entry for '${input.agent_id}' STAYS LIVE and OVER-DEFERS H10's file duties for the files it claims, until H10's staleness TTL expires or H1 deletes the register at the next session start`
      : `this dispatch is absent from the register, so H10 will NOT defer the duties for the files it owns (under-defer: a duty fires that could have waited)`;
  if (event !== 'SubagentStart' && event !== 'SubagentStop') {
    // Unknown signals halt loudly rather than silently mutating the register
    // (P5) — but never with an exit that could deny the spawn. If the platform
    // RENAMED these events, nothing adds and nothing removes: the register goes
    // permanently empty (every duty fires, nothing defers) rather than wrong.
    warnNonBlocking(`H22: unexpected hook_event_name '${event}' — no entry was added or removed; the register cannot track dispatches until this event name is handled`);
  }
  if (!input.agent_id) {
    warnNonBlocking(`H22: ${event} carried no agent_id (entries are keyed by agent_id) — ${consequence}`);
  }

  const registerPath = join(input.cwd, '.sterling', 'transient', 'dispatch-register.json');

  // Plain, unlocked READ helper — reads never need the lock (H22's own header
  // comment: the register's atomic tmp+rename publish means a reader sees the
  // previous register or the current one, never a torn file). Only the
  // read-MODIFY-write below is lock-guarded.
  function readEntriesRaw() {
    try {
      if (existsSync(registerPath)) {
        const raw = JSON.parse(readFileSync(registerPath, 'utf8'));
        if (Array.isArray(raw)) return raw;
      }
    } catch {
      // corrupt bytes degrade to empty (session-events posture) and are
      // replaced by the valid register written by whichever writer next
      // acquires the lock
    }
    return [];
  }

  // Foreign-session entries are pruned on EVERY fire, start or stop: a dispatch
  // cannot outlive its own session, so another session_id's entry is residue
  // that would otherwise defer this session's duties forever. Applied to
  // whichever read feeds the LOCKED write below, never to a read used only
  // for the unlocked, non-mutating lookups (residue/ledger) above it.
  const pruneForeign = (raw) => raw.filter((e) => e && e.session_id === input.session_id);

  if (event === 'SubagentStart') {
    const { blocks: matchedBlocks, attribution } = attributeBlocks(input.transcript_path, input.agent_type);
    const { candidates, files_source: filesSource, warnings: territoryWarnings } = resolveTerritory(matchedBlocks);
    for (const w of territoryWarnings) process.stderr.write(w + '\n');
    const claimedCandidates = claimedFromBlocks(matchedBlocks);
    const globPrefixCandidates = globPrefixesFromBlocks(matchedBlocks);
    // THE EXTRACTOR'S PERMISSIVENESS COSTS MORE HERE THAN IN H19. There a false
    // candidate cost one store query that found nothing; here it enters the
    // register, so it SUPPRESSES a real duty and holds H10's releases
    // non-terminal for the whole life of the dispatch. Under-defer is the safe
    // direction, so this filter drops anything doubtful.
    // Repo-relative POSIX only (§3.2 path invariant at the hook boundary);
    // .git/.sterling are never governed territory, so they can never own a duty.
    // 'sterling/…' and 'git/…' are dropped too: the extractor's directory
    // segments exclude '.', so '.sterling/transient/x.json' in prompt prose
    // arrives dot-stripped as 'sterling/transient/x.json' and would otherwise
    // walk straight past the .sterling/ guard.
    const toRegisterPaths = (cands) =>
      [...new Set(cands.map((c) => repoRel(c, input.cwd)).filter(Boolean))].filter(
        (r) =>
          r !== '.git' &&
          !r.startsWith('.git/') &&
          !r.startsWith('.sterling/') &&
          !r.startsWith('sterling/') &&
          !r.startsWith('git/')
      );
    const files = toRegisterPaths(candidates);
    // The negation-aware subset (see claimedFromBlocks above) goes through the
    // IDENTICAL normalization and exclusion filter — one expression, so
    // `claimed_files` can never drift into a different path shape than `files`.
    const claimedFiles = toRegisterPaths(claimedCandidates);
    // Glob-prefix claims (see globPrefixesFromBlocks above) — SAME
    // toRegisterPaths normalization, which is exactly why they cannot share
    // claimed_files's shape: normalizeRepoPath strips a trailing '/'
    // (join(split('/').filter(seg => seg !== '')) drops the empty trailing
    // segment), so "packages/mcp-server/" comes out as "packages/mcp-server"
    // — indistinguishable from a FILE path with no extension by string shape
    // alone. Keeping this in its own field is what lets h26 apply prefix
    // (startsWith) matching ONLY here, never accidentally against
    // claimed_files/files.
    const claimedGlobPrefixes = toRegisterPaths(globPrefixCandidates);
    // SPEC B (1)/(2): exclusive non-file resource claim, scanned from the SAME
    // matched blocks' prompt text the file attribution above came from — the
    // shared negation-aware scanner means a negated mention ("No
    // windowed-godot run for this dispatch") never claims. No configured
    // names (absent/malformed config) -> nothing to claim.
    // ATTRIBUTION-GATED (fixer round, 2026-08-25 addendum C): minted ONLY
    // from a 'block' attribution (the single string-matched block's own
    // prompt) — under 'union' attribution several same-type siblings share
    // ONE register entry per spawn, and a claim found in just one sibling's
    // prompt would otherwise mint exclusive_resources onto EVERY same-type
    // spawn this fires for, producing false holders and false "you do not
    // hold" notices. Under 'union' no claim field is written at all, matching
    // the advisory-precision posture elsewhere (noise is the measured failure
    // mode, not under-claiming — a missed claim here costs only a missed
    // "you hold X" disclosure, never a duty).
    const configuredResources = loadExclusiveResourceNames(input.cwd);
    const claimed =
      attribution === 'block' && configuredResources.length
        ? claimedResources(matchedBlocks.map((b) => b.prompt).join('\n'), configuredResources)
        : [];

    const newEntryBase = {
      agent_id: input.agent_id,
      agent_type: input.agent_type ?? null,
      session_id: input.session_id,
      files,
      // Provenance of `files` above (decision 8f137474): 'review-territory'
      // when at least one attributed block carried a well-formed
      // REVIEW-TERRITORY declaration, 'free-prose-fallback' otherwise —
      // copied unchanged into the promoted review-ledger receipt at Stop.
      files_source: filesSource,
      // Always present, even empty — its ABSENCE is the legacy-entry signal
      // H26 falls back on (see claimedFromBlocks above).
      claimed_files: claimedFiles,
      // Same always-present-even-empty posture, same reason: an absent field
      // means a pre-migration entry (H26 treats it as "no prefix claims",
      // not "unknown" — safe, since the pre-existing exact-match comparison
      // on claimed_files/files is completely unaffected either way).
      claimed_glob_prefixes: claimedGlobPrefixes,
      at: new Date().toISOString(),
      attribution,
    };
    if (claimed.length) newEntryBase.exclusive_resources = claimed;

    // REGISTER LOCK, APPEND SIDE (decision register-writers-cooperating-lock,
    // 1e0ba0d0). Everything above (transcript reads, prompt parsing, git-free
    // candidate extraction) is the "expensive work" the decision keeps OUTSIDE
    // the critical section; only the read-modify-write below is guarded.
    // TIMEOUT POSTURE: SKIP-LOUD, never an unlocked write — an unlocked
    // whole-array rewrite can erase every concurrent sibling's mutation,
    // while skipping loses at most this one fire's append, bounded and
    // disclosed (D2).
    const registerLock = await acquireRegisterLock(input.cwd);
    if (!registerLock) {
      // A raw stderr write, NOT warnNonBlocking — this timeout is disclosed
      // but never denies the spawn (exit 0), whereas warnNonBlocking exits 1.
      // Names the exclusive-resource "you do not hold X" notice too (LOW,
      // review-fix round): that notice is computed from the locked read
      // below, so a timeout silently drops it as well — a reader must not
      // have to infer that from the append-only framing.
      process.stderr.write(
        `H22: register lock timed out — SKIPPING SubagentStart append for '${input.agent_id}' (never writing the register unlocked), including any "you do not hold <resource>" exclusive-resource notice this spawn would have received — ${consequence}\n`
      );
    } else {
      try {
        // Fresh read, taken only now that the lock is held — never the
        // pre-lock snapshot, so a sibling's mutation that landed while we
        // were waiting is never clobbered.
        const entries = pruneForeign(readEntriesRaw());

        // SPEC B (6): "you do not hold <resource>" notice — computed against
        // the freshly-read `entries` BEFORE this spawn's own entry is
        // appended below, so a sole/first claimant structurally never sees
        // itself (self-exclusion is not a filter to get wrong, it is simply
        // not in the list yet).
        const notices = [];
        for (const name of configuredResources) {
          const holder = entries.find((e) => Array.isArray(e.exclusive_resources) && e.exclusive_resources.includes(name));
          if (holder) {
            notices.push(`You do not hold '${name}' — it is currently held by ${holder.agent_type}:${holder.agent_id}.`);
          }
        }
        // Emitted through the documented SubagentStart injection channel
        // (hookSpecificOutput.additionalContext — same shape h19-dispatch-staging.mjs
        // uses), not a raw stdout write: a raw write is not guaranteed to reach the
        // spawned agent at all. Each hook on this event path writes its OWN
        // hookSpecificOutput object and the platform composes them — h28-return-contract.mjs
        // is a second, independent SubagentStart writer (measured 2026-08-26,
        // research_finding 2b67ba97) — so the shape here is built so this hook's own
        // addition joins into one payload, never a second competing write within
        // THIS hook.
        if (notices.length) {
          process.stdout.write(
            JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: notices.join('\n') } })
          );
        }

        entries.push(newEntryBase);

        // ATOMIC publish: a reader (H10 at Stop, or a sibling fire) either
        // sees the previous register or this one, never a half-written file.
        // The tmp name carries the pid so two simultaneous fires cannot
        // clobber each other's staging file.
        const transient = join(input.cwd, '.sterling', 'transient');
        mkdirSync(transient, { recursive: true });
        const tmpPath = join(transient, `dispatch-register.json.tmp-${process.pid}`);
        writeFileSync(tmpPath, JSON.stringify(entries));
        renameSync(tmpPath, registerPath);
      } finally {
        registerLock.release();
      }
    }
    allow();
  } else {
    // Stop: promote a reviewer-class entry into the durable review ledger
    // (decision 12a26ca6-a301-466d-a45c-5e1eeff36694, slug
    // review-receipt-ledger) BEFORE removing it from the register — the
    // in-flight register is transient (H1 wipes it every SessionStart), but a
    // reviewer's evidence must survive to be stamped into a later commit by
    // scripts/commit-reviewed.mjs. Non-reviewer entries keep the exact
    // delete-only path from before: the ledger is never created or touched.
    //
    // LOOKED UP VIA A PLAIN, UNLOCKED READ (decision point: "read the entry
    // before/without the register lock if needed") — deliberately NOT behind
    // the register lock, because the residue probe and the ledger promotion
    // below are exactly the "expensive work (transcript reads, git probes)"
    // the decision keeps OUTSIDE the critical section. This is what makes D3
    // possible: even when the register lock is held elsewhere and the
    // removal below has to be skipped, the receipt still gets promoted.
    const departing = pruneForeign(readEntriesRaw()).find((e) => e.agent_id === input.agent_id);

    // SPEC A (6): kill-detection at H22's own SubagentStop — no TTL wait
    // needed, since a kill is detectable immediately via the real stdin field
    // `last_assistant_message` (research_finding 20b44518): an EMPTY string OR
    // an ABSENT field (both forms) is the kill signature; a normal agent
    // completion always produces a non-empty final message. A git-probe
    // failure must never silently drop the residue (SPEC A item 7) — it still
    // prints, marked tree-state-unverified, via probeDirtyPaths's disclosed
    // { verified: false, dirty: <all declared>, reason } shape.
    // Print-once (fixer round, 2026-08-25 addendum B): an entry already
    // carrying a truthy residue_reported_at may have been reported by H10 at
    // a Stop that fired before this SubagentStop finally landed — mirrors
    // H10/H1's own read-side suppression so the same incident is never
    // reported twice across surfaces.
    if (departing && !departing.residue_reported_at) {
      const lastMsg = input.last_assistant_message;
      const noFinalMessage = typeof lastMsg !== 'string' || lastMsg === '';
      if (noFinalMessage) {
        const probe = probeDirtyPaths(input.cwd, departing.files);
        if (probe.dirty.length > 0) {
          process.stdout.write(formatResidueLine(departing, probe.dirty, { verified: probe.verified, reason: probe.reason }) + '\n');
        }
      }
    }

    if (departing && typeof departing.agent_type === 'string' && departing.agent_type.startsWith('reviewer-')) {
      // Lock-guarded (see withLedgerLock above) — this durable ledger has no
      // TTL/H1-wipe safety net, unlike the register below, so a lost update
      // here would be a permanent loss of reviewer evidence rather than a
      // bounded, self-healing one.
      const sterlingDir = join(input.cwd, '.sterling');
      // Probed OUTSIDE the lock: two git spawns are the slowest thing on this
      // path, and holding the ledger mutex across them would push concurrent
      // reviewer stops toward the unlocked-timeout fallback for no reason.
      const identity = gitReceiptIdentity(input.cwd);
      // Probed OUTSIDE the lock for the same reason `identity` is: it is a stat
      // sweep plus one git spawn. It must also be read HERE, at Stop, and not
      // inside the lock — the whole point of the field is that it names the
      // bytes as they stood when the review ENDED, and the lock wait is time in
      // which they could move.
      const reviewedState = reviewEndState(input.cwd, departing.files);
      withLedgerLock(sterlingDir, () => {
        const ledgerPath = join(sterlingDir, 'review-ledger.json');
        let ledger = [];
        try {
          if (existsSync(ledgerPath)) {
            const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
            if (Array.isArray(raw)) ledger = raw;
          }
        } catch {
          ledger = []; // malformed ledger degrades to empty (same posture as the
          // register above) and is rewritten valid below — never exit 2 for this
        }
        // LEDGER IDEMPOTENCY (review-fix round, MEDIUM). The register-lock
        // timeout path (D3) means a Stop whose register removal was skipped
        // leaves the entry behind for a LATER Stop-shaped fire to find again
        // — this closes that double-promotion window. DELIBERATELY NOT a new
        // `agent_id` field on the receipt: h22-review-ledger.test.mjs and
        // h22-receipt-expiry.test.mjs both pin the promoted entry's key set
        // to EXACTLY ['agent_type','at','base_sha','branch','files',
        // 'session_id'] via Object.keys(entry).sort() — a 7th key (agent_id
        // is always a defined string, so it always survives the JSON
        // round-trip unlike the conditionally-undefined files_source/
        // attribution fields) fails that frozen pin outright. `agent_type` +
        // `at` are ALREADY two of the six pinned keys, both copied verbatim
        // from the register entry and therefore stable across repeated
        // promotion attempts for the SAME dispatch (the same convention the
        // concurrency pin file's own C2 arm uses to identify a receipt: `key
        // = (e) => \`${e.agent_type}::${e.at}\``) — a lightweight, no-new-field
        // idempotency key. Never touches commit-reviewed's OWN consume
        // identity (agent_type/at/session_id/branch/base_sha/files, per its
        // sameIdentity()) — this is a read-before-push guard on the SAME
        // ledger-locked append, not a new field for that matcher to see.
        if (ledger.some((e) => e && e.agent_type === departing.agent_type && e.at === departing.at)) {
          process.stderr.write(
            `H22: a review receipt for agent_type '${departing.agent_type}' at '${departing.at}' is already present in .sterling/review-ledger.json — skipping duplicate promotion\n`
          );
        } else {
          // session_id comes from the REGISTER entry, not from stdin: it is the
          // session that dispatched the reviewer. (The prune above already
          // guarantees the two are equal — the fallback exists so a hand-written
          // or pre-expiry register entry still yields a total shape rather than
          // a missing key, since commit-reviewed treats a MISSING identity as
          // unjudgeable and an identity that is merely null as the same.)
          // Both candidates go through normIdentity, so an empty-string session_id
          // on the register entry falls through to stdin's rather than being
          // written as a meaningless '' the reader must then interpret.
          ledger.push({
            agent_type: departing.agent_type,
            files: departing.files,
            // Copied unchanged from the register entry (decision 8f137474):
            // absent on a pre-migration register entry, same posture as the
            // other always-attempted-never-required fields on this receipt.
            files_source: departing.files_source,
            // Same copy-if-present, never-fabricated posture as files_source
            // above (review-fix round, pins T6a/T6b): a legacy register entry
            // written before per-block attribution existed carries no
            // `attribution` key, and `departing.attribution` is then
            // `undefined` here — JSON.stringify drops an undefined-valued key
            // entirely, so the promoted receipt genuinely lacks the key rather
            // than carrying a fabricated default.
            attribution: departing.attribution,
            // THE DISPATCH INSTANT, kept verbatim and deliberately NOT
            // corrected in place (board 0f448efb): it is half of this hook's own
            // duplicate-promotion key just above, and half of commit-reviewed's
            // consume identity, so rewriting its meaning would break both. The
            // review-END instant lives in reviewed_state.completed_at instead,
            // which is what the staleness advisory now prefers.
            at: departing.at,
            session_id: normIdentity(departing.session_id) ?? normIdentity(input.session_id),
            branch: identity.branch,
            base_sha: identity.base_sha,
            // Optional by construction — undefined when no reviewed path
            // resolved to a readable file, and then dropped entirely by
            // JSON.stringify (same posture as files_source/attribution above).
            reviewed_state: reviewedState,
          });
        }
        const ledgerTmpPath = join(sterlingDir, `review-ledger.json.tmp-${process.pid}`);
        writeFileSync(ledgerTmpPath, JSON.stringify(ledger));
        renameSync(ledgerTmpPath, ledgerPath);
      });
    }
    // REGISTER LOCK, REMOVE SIDE (decision register-writers-cooperating-lock,
    // 1e0ba0d0). Everything expensive (the residue probe, the git-backed
    // ledger promotion above) already ran OUTSIDE this critical section — the
    // lock below guards only the read-modify-write that removes the matching
    // entry and applies the foreign-session prune pass.
    // TIMEOUT POSTURE: SKIP-LOUD — the register is left exactly as read
    // above (D3): the entry stays behind, a bounded over-deferral, never a
    // lost promotion (that already happened, unconditionally, above).
    const registerLock = await acquireRegisterLock(input.cwd);
    if (!registerLock) {
      // A raw stderr write, NOT warnNonBlocking — this timeout is disclosed
      // but never denies the spawn/stop (exit 0), whereas warnNonBlocking
      // exits 1. The ledger promotion above already happened unconditionally
      // (D3) — this skip costs only the register removal.
      process.stderr.write(
        `H22: register lock timed out — SKIPPING SubagentStop removal for '${input.agent_id}' (never writing the register unlocked) — ${consequence}\n`
      );
    } else {
      try {
        // Fresh read, taken only now that the lock is held.
        let entries = pruneForeign(readEntriesRaw());
        // Remove the matching entry. No match is a clean no-op (the pruning
        // above still lands) — a stop for an entry H1 already swept, or for a
        // dispatch started before this register existed, is not a defect.
        entries = entries.filter((e) => e.agent_id !== input.agent_id);

        // ATOMIC publish: a reader (H10 at Stop, or a sibling fire) either
        // sees the previous register or this one, never a half-written file.
        // The tmp name carries the pid so two simultaneous fires cannot
        // clobber each other's staging file.
        const transient = join(input.cwd, '.sterling', 'transient');
        mkdirSync(transient, { recursive: true });
        const tmpPath = join(transient, `dispatch-register.json.tmp-${process.pid}`);
        writeFileSync(tmpPath, JSON.stringify(entries));
        renameSync(tmpPath, registerPath);
      } finally {
        registerLock.release();
      }
    }
  }
  allow();
} catch (e) {
  // The register is an aid to H10's deferral, never a gate: a failure here
  // costs deferral precision, never a dispatch (P5 visibility without a
  // blocking exit). The cost is NOT symmetric, so name the one that applies.
  const consequence =
    input.hook_event_name === 'SubagentStop'
      ? `the entry for '${input.agent_id}' STAYS LIVE and OVER-DEFERS H10's file duties for the files it claims, until H10's staleness TTL expires or H1 deletes the register at the next session start — and if this was a reviewer-class dispatch, its receipt may never have reached the durable review ledger, so a later scripts/commit-reviewed.mjs invocation may wrongly refuse for lack of review evidence`
      : `this dispatch is absent from the register, so H10 will NOT defer the duties for the files it owns (under-defer: a duty fires that could have waited)`;
  warnNonBlocking(`H22: dispatch register update failed: ${(e && e.message) || e} — ${consequence}`);
}
