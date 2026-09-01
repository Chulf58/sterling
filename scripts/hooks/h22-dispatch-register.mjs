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
// whole territory (board 0f448efb; see buildContentEvidence below, campaign
// slice S2b-1's v2 content_evidence{} envelope) —
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
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking, repoRel, loadConfig } from './lib/common.mjs';
import { lastDispatchBlocks, extractPathCandidates, parseReviewTerritory } from './lib/dispatch-prompt.mjs';
import { probeDirtyPaths, formatResidueLine, claimedResources } from './lib/dispatch-residue.mjs';
import { hasUnsuppressedMatch, escapeRe, extractGlobPrefixCandidates } from './lib/dispatch-advisory.mjs';
import { acquireLock, registerLockDir } from './lib/dispatch-register-lock.mjs';
import { readTail } from './lib/transcript.mjs';
import { normalizeLedgerEntry } from './lib/review-ledger-entry.mjs';
import { observedToolPaths } from './lib/observed-territory.mjs';

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

// CONTENT EVIDENCE — v2's content_evidence{} (decision 57984926, campaign
// slice S2b-1). Supersedes the old optional `reviewed_state` shape (board
// 0f448efb): every v2 promotion carries this key UNCONDITIONALLY (status is
// always one of 'complete'|'partial'|'unavailable', never omitted), whereas
// the old shape recorded nothing at all when no reviewed path resolved to a
// readable file. The scripts/hooks/lib/review-ledger-entry.mjs read adapter
// maps this back to the legacy `reviewed_state` shape for existing readers
// (scripts/commit-reviewed.mjs), so this is a WRITE-side-only reshaping.
//
// THE DEFECT THIS CLOSES, in two halves that are really one (unchanged from
// the prior design): (1) a receipt was never checked against THE BYTES IT
// REVIEWED — commit-reviewed's eligibility was session + branch + FILENAME
// intersection, never content — and (2) the receipt's only timestamp, `at`
// (now `started_at`), is copied from the register entry, stamped at
// SubagentSTART. `finished_at` (captured unconditionally, see the Stop branch
// below) is the review-END instant this was always missing.
//
// WHAT IS RECORDED: the git blob sha of each reviewed file AS IT STANDS AT
// STOP. base_sha (HEAD) does not answer this — a reviewer reads the
// UNCOMMITTED working tree, which moves freely while HEAD stands still.
//
// WHY BLOB SHAS AND NOT MTIMES: a `touch`, or any checkout that rewrites
// mtimes without changing content, defeats a timestamp comparison; a content
// hash does not. `git hash-object` applies the SAME clean/eol filters `git
// add` applies, so the value is directly comparable to the INDEX blob sha
// commit-reviewed reads at spend time, including under autocrlf.
//
// A DECLARED FILE ABSENT ON DISK (decision 57984926's absent-path sentinel,
// pins V2-5a/V2-5b) is recorded in `absent_paths`, never silently dropped —
// a reviewed DELETION is legitimately reviewable, so its absence is evidence,
// not noise. `status` is the vacuous/every-present/some-absent/every-absent
// enum read literally off the three named values: no declared files at all is
// read as vacuously 'complete' (nothing to contradict completeness — not
// pinned either way, disclosed here as the chosen degenerate-case reading).
//
// NEVER THROWS, NEVER GATES: every git failure path (no git, a non-zero exit,
// an output shape that does not line up 1:1 with the inputs) records
// `failure_reason` and leaves `blobs` at whatever was already gathered (`{}`
// when nothing hashed) rather than fabricating or discarding partial evidence
// — `status` is still derived purely from PRESENCE ON DISK, independent of
// whether the hashing step itself succeeded.
const REVIEWED_BLOBS_CAP = 64; // far above any real review territory; bounds the argv this builds
function buildContentEvidence(cwd, files) {
  const uniqueFiles = Array.isArray(files) ? [...new Set(files.filter((f) => typeof f === 'string' && f !== ''))] : [];
  if (uniqueFiles.length === 0) {
    // Vacuous case, not pinned: no declared territory to check at all.
    return { status: 'complete', blobs: {}, absent_paths: [] };
  }
  // TRUNCATION IS A CAP, NOT A FAILURE — recorded, never silent (unchanged
  // from the prior design). Slicing to the cap before hashing bounds the argv
  // `git hash-object` is spawned with; `truncated_of` names how many files the
  // receipt DECLARED versus how many this evidence actually bound.
  const truncated = uniqueFiles.length > REVIEWED_BLOBS_CAP;
  const paths = uniqueFiles.slice(0, REVIEWED_BLOBS_CAP);
  const present = [];
  const absent = [];
  for (const p of paths) {
    try {
      if (statSync(join(cwd, p)).isFile()) present.push(p);
      else absent.push(p);
    } catch {
      absent.push(p); // ENOENT and every other stat failure read as absent
    }
  }
  let blobs = {};
  let failureReason;
  // UNHASHED, NOT JUST ABSENT (decision 57984926 fix round, finding MED-3): a
  // PRESENT file whose hash could not be produced (permission denied, a
  // vanish-between-stat-and-hash race, a malformed git output) is A THIRD
  // OUTCOME, distinct from "present and bound" and from "absent" — pin
  // V2-HASH-FAIL. Starting this as a copy of `present` and narrowing it to
  // "still unhashed" after the attempt means `status` below can honestly
  // reflect what was ACTUALLY recovered, never what was merely attempted.
  let presentUnhashed = [...present];
  if (present.length > 0) {
    try {
      // `--` terminates options, so a path beginning with '-' is a path.
      const r = spawnSync('git', ['hash-object', '--', ...present], { cwd, encoding: 'utf8', timeout: 10_000 });
      if (r && !r.error && r.status === 0) {
        const shas = (r.stdout ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /^[0-9a-f]{40}$/i.test(l));
        // 1:1 or nothing: git emits one sha per input in argument order, so any
        // other count cannot be aligned with the paths and must not be guessed.
        if (shas.length === present.length) {
          present.forEach((p, i) => {
            blobs[p] = shas[i];
          });
          presentUnhashed = [];
        } else {
          failureReason = 'git hash-object output did not align 1:1 with the reviewed paths';
        }
      } else {
        failureReason = 'git hash-object failed or git is unavailable';
      }
    } catch {
      failureReason = 'git hash-object threw';
    }
  }
  // STATUS REFLECTS HASHES RECOVERED, NOT MERELY FILES DECLARED PRESENT (pin
  // V2-HASH-FAIL): a present-but-unhashed file counts the same as an absent
  // one for this verdict — 'complete' claims every declared file is BOTH
  // present AND bound, never "present, but we never actually got its bytes".
  // 'unavailable' when NOTHING at all was recovered (every declared path is
  // either absent or unhashed); 'partial' otherwise.
  const noEvidenceCount = absent.length + presentUnhashed.length;
  const status = noEvidenceCount === 0 ? 'complete' : noEvidenceCount === paths.length ? 'unavailable' : 'partial';
  const result = { status, blobs, absent_paths: absent };
  // EXPLICIT BOOLEAN, not just truncated_of (decision 57984926 fix round,
  // finding F3): truncation is DECIDED here, at write time, from `truncated`
  // (uniqueFiles.length > REVIEWED_BLOBS_CAP) — the ONLY authority for whether
  // this receipt's binding is partial-by-cap. scripts/hooks/lib/
  // review-ledger-entry.mjs's read adapter PREFERS this flag over inferring it
  // from `truncated_of` being a positive integer, because inference is a
  // SECOND, weaker copy of the same decision (a `truncated_of` written by hand
  // or by a future producer with a different convention could satisfy the
  // "positive integer" test without ever having been the write side's actual
  // truncation verdict). Both fields are still written together — truncated_of
  // is the COUNT this flag names, never emitted alone.
  if (truncated) {
    result.truncated = true;
    result.truncated_of = uniqueFiles.length;
  }
  if (failureReason) result.failure_reason = failureReason;
  return result;
}

// MODEL PROVENANCE (decision 57984926) — the reviewer{} envelope's model,
// model_family, model_source. RECORDING, not a mismatch guard: decision
// f5802025's rejection of an actual-vs-pinned escalation backstop stands
// untouched; this only names what ran.
//
// OBSERVED (preferred): the DEPARTING SUBAGENT'S OWN transcript — at Stop,
// this is stdin.agent_transcript_path (preferred by resolveReviewerModel's
// caller below whenever it is a usable path); stdin.transcript_path is the
// PARENT (conductor) transcript and is used here only as the pre-existing
// LEGACY FALLBACK when agent_transcript_path is absent (adjudicated: dormant
// on a live CLI, kept only so the shipped h22-ledger-v2-entry pins — which
// supply just transcript_path — stay green). Scanned tail-backward (same 1MB
// tail window H6 uses via lib/transcript.mjs's readTail) for the most recent
// assistant entry carrying a `message.model` string. Unlike
// lib/transcript.mjs's own `latestUsage`, this does NOT require a `usage`
// field on that entry — a model id can be observed on an entry that never
// reports usage.
function observedModelFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return null;
  let tail;
  try {
    tail = readTail(transcriptPath);
  } catch {
    // readTail's existsSync guard does not stop an EISDIR/EACCES throw from
    // openSync/readSync (a directory-valued or unreadable transcript path) —
    // degrade to null so the model ladder falls to configured/unknown rather
    // than losing the whole ledger promotion to an uncaught throw.
    return null;
  }
  if (tail === null) return null;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // the tail window's first line may be truncated mid-record
    }
    if (parsed.type !== 'assistant') continue;
    const model = parsed.message?.model;
    if (typeof model === 'string' && model !== '') return model;
  }
  return null;
}

// CONFIGURED (fallback): the reviewer model SNAPSHOT taken at SubagentStart
// (never a live re-read at Stop — pin V2-3b) from config.models, never
// installed frontmatter (rendered output can be stale).
//
// FIX ROUND HIGH-1 (Codex outside-family review, thread 01a0586b;
// conductor-verified against packages/schemas/src/config.ts:171-175): the
// REAL, single shared key for every reviewer-* agent_type is
// `config.models.reviewers` — there is no per-role key (the schema names
// test_writer/coder/researcher/etc. as SEPARATE roles, but every reviewer-*
// agent_type folds to this one shared entry). The earlier per-agent-type-then-
// 'reviewer'-fallback lookup was an invented convention that never matched the
// real schema and masked the defect: it always silently missed and fell
// through to model_source:'unknown'. NEVER GUESS A PER-ROLE KEY (pin
// V2-3b-ANTI: a config carrying only an invented key like
// `models['reviewer-correctness']` must still yield 'unknown', not a false
// 'configured' read of a value that was never the real source of truth).
function configuredReviewerModel(cwd) {
  try {
    const model = loadConfig(cwd)?.models?.reviewers?.model;
    return typeof model === 'string' && model !== '' ? model : null;
  } catch {
    return null;
  }
}

// FAMILY — ANCHORED patterns only (decision 57984926's explicit anti-pin:
// no broad `o*` -> openai rule, which would misclassify 'other-model').
function familyFromModel(model) {
  if (typeof model !== 'string' || model === '') return 'unknown';
  if (/^claude-/.test(model)) return 'anthropic';
  if (/^gpt-/.test(model) || /^codex/.test(model)) return 'openai';
  return 'unknown';
}

// Resolves {model, model_source} for a departing reviewer entry: OBSERVED
// (this Stop's transcript) wins over CONFIGURED (the register entry's
// Start-time snapshot, see `configured_model` on newEntryBase below); neither
// available yields null/'unknown' rather than a guess.
//
// CONSOLIDATION FIX (review, same premise-correction round as the
// observed-territory field fix below): at SubagentStop, stdin.transcript_path
// is the PARENT (conductor) transcript, not the departing subagent's own —
// observedModelFromTranscript was reading the CONDUCTOR's model as though it
// were the reviewer's. `agentTranscriptPath` (stdin.agent_transcript_path,
// the real per-subagent transcript) is now preferred whenever it is a usable
// (non-empty string) path; the pre-existing transcript_path behavior is kept
// as the fallback ONLY when agent_transcript_path is absent — every
// h22-ledger-v2-entry pin supplies just transcript_path and stays green
// unchanged. Unlike the territory fix, this fallback is deliberate and
// pre-existing: no other model-ladder semantics change here.
function resolveReviewerModel(departing, transcriptPath, agentTranscriptPath) {
  const preferredTranscriptPath = typeof agentTranscriptPath === 'string' && agentTranscriptPath !== '' ? agentTranscriptPath : transcriptPath;
  const observed = observedModelFromTranscript(preferredTranscriptPath);
  if (observed) return { model: observed, model_source: 'observed' };
  const configured = typeof departing?.configured_model === 'string' && departing.configured_model !== '' ? departing.configured_model : null;
  if (configured) return { model: configured, model_source: 'configured' };
  return { model: null, model_source: 'unknown' };
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
    // OBSERVED-EVIDENCE UPGRADE, PART (1) (decision review-territory-observed-evidence,
    // 9500cce1) — warn-only, never a gate (h19-dispatch-staging posture: this
    // hook never denies a spawn). filesSource is 'review-territory' ONLY when
    // at least one attributed block carried a well-formed REVIEW-TERRITORY
    // declaration (resolveTerritory above) — anything else (no marker at all,
    // or a malformed marker that fell back to free-prose) is "no valid
    // declaration" and gets this loud absence warning for a reviewer-class
    // dispatch. Exact 'reviewer-' prefix (not a bare 'reviewer' substring) —
    // matches every other reviewer-class check in this file.
    if (typeof input.agent_type === 'string' && input.agent_type.startsWith('reviewer-') && filesSource !== 'review-territory') {
      process.stderr.write(
        `H22: reviewer-class dispatch '${input.agent_id}' (${input.agent_type}) has no valid REVIEW-TERRITORY declaration in its attributed dispatch block(s) — territory falls back to free-prose extraction, which measurably over-captures context-mentioned files (board f60ff6d8). Every code-touching reviewer dispatch should carry an explicit REVIEW-TERRITORY: [...] line in its prompt.\n`
      );
    }
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
    // MODEL PROVENANCE SNAPSHOT (decision 57984926, pin V2-3b) — taken HERE,
    // at Start, never re-read lazily at Stop: config.models can change between
    // the two events (a config edit mid-dispatch), and the entry must carry
    // what was CONFIGURED when the reviewer was DISPATCHED, not whatever is
    // live when it happens to finish. Only computed for reviewer-* dispatches
    // (the only ones ever promoted); null when nothing resolves, consumed by
    // resolveReviewerModel at Stop as the fallback behind an OBSERVED model.
    if (typeof input.agent_type === 'string' && input.agent_type.startsWith('reviewer-')) {
      newEntryBase.configured_model = configuredReviewerModel(input.cwd);
    }

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
        // hookSpecificOutput object and the platform composes them — h19-dispatch-staging.mjs
        // is the other independent SubagentStart writer on this path (measured
        // 2026-08-26, research_finding 2b67ba97; it now also carries the return
        // contract folded in from h28-return-contract.mjs, decision 04982f45) —
        // so the shape here is built so this hook's own addition joins into one
        // payload, never a second competing write within THIS hook.
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
    // FINISHED_AT — captured as the FIRST ACT of Stop handling (decision
    // 57984926: "captured unconditionally at the START of Stop handling"),
    // strictly BEFORE the register lookup and the killed-reviewer residue
    // probe below — both can run slow git work (probeDirtyPaths spawns git),
    // and the earlier placement (top of the reviewer-class branch only) still
    // let that work shift the recorded review-END instant. Captured once,
    // unconditionally, regardless of whether this Stop turns out to be
    // reviewer-class at all; only used later, in the reviewer branch.
    const finishedAt = new Date().toISOString();
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
      // finishedAt is captured at the TOP of Stop handling, above (before the
      // register lookup and residue probe) — reused here unconditionally, not
      // re-captured, so nothing after Stop entry (git identity, content-
      // evidence hashing, the residue probe) can shift the review-END instant.
      // Probed OUTSIDE the lock: two git spawns are the slowest thing on this
      // path, and holding the ledger mutex across them would push concurrent
      // reviewer stops toward the unlocked-timeout fallback for no reason.
      const identity = gitReceiptIdentity(input.cwd);
      // Also read here rather than inside the lock — it names the bytes as
      // they stood when the review ENDED, and the lock wait is time in which
      // they could move.
      const contentEvidence = buildContentEvidence(input.cwd, departing.files);
      const resolvedModel = resolveReviewerModel(departing, input.transcript_path, input.agent_transcript_path);
      // OBSERVED-EVIDENCE UPGRADE, PART (2) (decision review-territory-observed-evidence,
      // 9500cce1) — CORROBORATION ONLY, computed from the DEPARTING SUBAGENT'S
      // OWN transcript. CORRECTED (review CRITICAL, verified against
      // research_finding 20b44518's byte-exact stdin probe): at SubagentStop,
      // stdin.transcript_path is the PARENT (conductor) transcript, NOT the
      // departing subagent's own — the subagent's transcript arrives at
      // stdin.agent_transcript_path instead. Reading transcript_path here
      // would record the CONDUCTOR's tool paths as reviewer evidence under a
      // false 'subagent-transcript' label. NEVER fall back to
      // input.transcript_path when agent_transcript_path is
      // absent/non-string/unreadable — parent content is false corroboration
      // by definition, so that degrades to null exactly like any other
      // unobservable transcript. Never gates, never touches declared
      // files/files_source above — null means "could not observe" and the
      // caller (below) leaves observed_files/observed_source ABSENT entirely,
      // never an empty placeholder that would look like "observed and found
      // nothing".
      const observed = observedToolPaths(input.agent_transcript_path, input.cwd);
      // SILENT-ABSENCE DISCLOSURE (roster LOW, P5) — warn-only, exit
      // unchanged: a reviewer-class promotion with no usable
      // agent_transcript_path (the field absent, or present but
      // unobservable) is otherwise INDISTINGUISHABLE from ordinary
      // "observed and found nothing" once it silently omits
      // observed_files/observed_source. Naming it here makes a platform
      // that stops delivering the field (or a broken transcript) visible on
      // stderr instead of quietly degrading the evidence this decision adds.
      if (observed === null) {
        const shape =
          typeof input.agent_transcript_path === 'string' && input.agent_transcript_path !== ''
            ? `present but unobservable ('${input.agent_transcript_path}')`
            : 'absent from stdin';
        process.stderr.write(
          `H22: no observed evidence for reviewer '${departing.agent_id}' (agent_type '${departing.agent_type}') — agent transcript unobservable (agent_transcript_path is ${shape}); this receipt promotes without observed_files/observed_source.\n`
        );
      }
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
        // LEDGER IDEMPOTENCY (review-fix round, MEDIUM; STRENGTHENED — decision
        // 57984926 fix round, findings HIGH-2 + HIGH-3). The register-lock
        // timeout path (D3) means a Stop whose register removal was skipped
        // leaves the entry behind for a LATER Stop-shaped fire to find again —
        // this closes that double-promotion window.
        //
        // HIGH-2: keys on the register entry's DISPATCH IDENTITY (agent_id),
        // never on agent_type+at. Two DISTINCT reviewer dispatches sharing
        // agent_type AND the same Start-millisecond `at` are NOT duplicates of
        // each other (pin DISPATCH-IDENTITY control) — a dedupe keyed on
        // agent_type+at would silently discard the second one's evidence, a
        // permanent data loss the idempotency check exists to prevent, not
        // cause. agent_id is the register's own unique key for a dispatch, so
        // it is stamped into `identity.agent_id` on every new v2 promotion
        // (below) specifically so a LATER retry of the SAME dispatch can be
        // recognized by the one field that actually identifies it.
        //
        // HIGH-3: routed through the SAME normalizeLedgerEntry adapter every
        // other reader uses, rather than an inline schema_version branch —
        // this file no longer hand-rolls its own v1/v2 shape switch for
        // reading an existing ledger entry. A v1 entry never carried agent_id,
        // so it normalizes to an entry with no `agent_id` field and can never
        // false-match a real dispatch identity.
        // LEGACY FALLBACK (roster review, LOW): a v1 entry, or a pre-fix v2
        // entry promoted before identity.agent_id existed, never carries a
        // usable agent_id — falling straight to "not a duplicate" there would
        // reopen the re-promotion window this check exists to close for those
        // prior receipts. So: match on agent_id when BOTH sides carry a
        // string; otherwise fall back to the old agent_type+at key. This never
        // reintroduces the false-dedupe HIGH-2 fixed — DISPATCH-IDENTITY's two
        // dispatches each carry their own real, distinct agent_id, so they
        // always take the agent_id branch and are correctly told apart.
        const ledgerEntryMatchesDeparting = (e) => {
          const normalized = normalizeLedgerEntry(e);
          if (!normalized) return false;
          if (typeof normalized.agent_id === 'string' && typeof departing.agent_id === 'string') {
            return normalized.agent_id === departing.agent_id;
          }
          return normalized.agent_type === departing.agent_type && normalized.at === departing.at;
        };
        if (ledger.some(ledgerEntryMatchesDeparting)) {
          // Names the actual duplicate IDENTITY (agent_id), not a stock phrase
          // (strengthened LEDGER-IDEMPOTENCY pin) — proving this reasons about
          // identity, not merely agent_type+at coincidence.
          process.stderr.write(
            `H22: a review receipt for agent_id '${departing.agent_id}' (agent_type '${departing.agent_type}', at '${departing.at}') is already present in .sterling/review-ledger.json — skipping duplicate promotion\n`
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
          //
          // V2 ENVELOPE (decision 57984926, campaign slice S2b-1) — EVERY new
          // promotion writes exactly these eleven top-level keys (pins V2-1,
          // h22-review-ledger.test.mjs test (1), h22-receipt-expiry.test.mjs
          // A1). Pre-existing v1 entries already in `ledger` are NEVER
          // migrated in place (pin V2-6) — this object is only ever APPENDED
          // beside them.
          ledger.push({
            schema_version: 2,
            entry_id: randomUUID(),
            kind: 'roster_receipt',
            status: 'active',
            started_at: departing.at,
            finished_at: finishedAt,
            reviewer: {
              agent_type: departing.agent_type,
              model: resolvedModel.model,
              model_family: familyFromModel(resolvedModel.model),
              model_source: resolvedModel.model_source,
            },
            identity: {
              session_id: normIdentity(departing.session_id) ?? normIdentity(input.session_id),
              branch: identity.branch,
              base_sha: identity.base_sha,
              // DISPATCH IDENTITY (finding HIGH-2) — the register's own unique
              // key for this dispatch, stamped so a later duplicate-promotion
              // attempt for the SAME dispatch can be recognized by identity
              // rather than by the coincidence of sharing agent_type+at with
              // an unrelated dispatch. Not part of decision 57984926's original
              // named identity fields (session_id/branch/base_sha), but no pin
              // asserts an exact key set on this nested object.
              agent_id: departing.agent_id,
            },
            territory: {
              files: departing.files,
              // Nested home of decision 8f137474's already-shipped
              // files_source/attribution fields — copied unchanged from the
              // register entry, same copy-if-present posture as before.
              source: departing.files_source,
              attribution: departing.attribution,
            },
            // OBSERVED-EVIDENCE UPGRADE, PART (2) (decision
            // review-territory-observed-evidence, 9500cce1) — TOP-LEVEL
            // fields (not nested under `territory`, unlike the declared
            // files/source above): the decision names "the ledger entry
            // additionally carries observed_files", corroboration
            // deliberately siblings-not-nests the declared territory it
            // corroborates. Spread-conditional so a null `observed` (the
            // transcript could not be observed at all) omits BOTH keys
            // entirely, never writing an empty placeholder that would read
            // as "observed and found nothing". `observed_truncated:true`
            // (review MEDIUM) is a THIRD top-level sibling, present only when
            // the lib's own `truncated` flag says the 1MB tail window did not
            // cover the whole departing transcript — absent (never `false`)
            // otherwise, same absent-unless-true convention as observed_files.
            ...(observed
              ? {
                  observed_files: [...new Set([...observed.reads, ...observed.writes])],
                  observed_source: 'subagent-transcript',
                  ...(observed.truncated ? { observed_truncated: true } : {}),
                }
              : {}),
            content_evidence: contentEvidence,
            disposition: null,
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
