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
// REVIEWER TERRITORY IS PROVISIONAL AT START AND BINDS AT STOP (decision
// edbaa38d, 2026-09-06). The paragraph above is still true for every
// NON-reviewer class, but a reviewer-class register entry is a HINT only: its
// `files`/`files_source` come from a positional match that the parent
// transcript is sometimes too slow to support (the spawning record is not
// always on disk when SubagentStart fires), so a receipt built by copying it
// can attest another dispatch's territory — measured live. At SubagentStop the
// receipt's territory is therefore RE-DERIVED from the brief this agent
// provably received (bindReviewerTerritoryAtStop below) and fails closed to
// 'unattributable' when it cannot be bound. The register entry itself is
// unchanged: H10 and H26 keep reading exactly what they read before.
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
import { readTail, readFromStart } from './lib/transcript.mjs';
// isEvidenceObject / isUsableBlobSha are IMPORTED, never re-spelled here: the
// refresh's per-path sha comparison (below) has to read a receipt's recorded
// evidence with exactly the predicates commit-reviewed's byte gate reads it
// with, or the two surfaces disagree about what "a recorded sha" is.
import { normalizeLedgerEntry, isEvidenceObject, isUsableBlobSha } from './lib/review-ledger-entry.mjs';
import { observedToolPaths, observedToolPathsSince } from './lib/observed-territory.mjs';

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

// TERRITORY BINDING — THE ONE PREDICATE, ASKED OF TWO DIFFERENT EVIDENCE
// OBJECTS (fix round, board c9f92090). A receipt's content_evidence is only
// meaningful as a statement ABOUT ITS DECLARED TERRITORY, so the question
// "does this evidence bind that territory?" gets ONE definition rather than a
// copy per call site — the two sites differ in WHICH object they ask about,
// never in what the answer means:
//   (a) the evidence the receipt ALREADY CARRIES, as found on disk — a receipt
//       corrupted by an earlier round (exactly what the live 2026-09-05 defect
//       produced: two foreign paths bound, five declared paths unbound, status
//       'complete') must never be silently rebound into a fresh-looking one.
//       Its remedy is a discharge or a fresh review, not a quiet fix-up.
//   (b) the evidence this Stop just BUILT, before it is written — structurally
//       correct by construction now that the refresh hashes the receipt's own
//       territory, and checked anyway because the failure it guards is silent
//       and its cost is a receipt claiming coverage it never had.
//
// THE PREDICATE: the evidence may name no path the receipt does not declare,
// and — unless it DISCLOSES why, via failure_reason — must name every declared
// path within the hashing cap. `failure_reason` is the ONLY disclosure
// accepted: it is the field buildContentEvidence sets whenever a present file
// could not be hashed (the V2-HASH-FAIL shape), and a status string is not a
// substitute — 'unavailable'/'partial' are DERIVED verdicts, satisfiable by any
// hand-written entry, and every legitimate producer that omits a declared path
// records a failure_reason beside them. A declared file that is merely ABSENT
// on disk is named in absent_paths, so it binds normally and needs no excuse.
// TRUNCATION: compared against the CAPPED expectation, since evidence past
// REVIEWED_BLOBS_CAP was never hashed by design (and says so via truncated).
function territoryBindingFault(evidence, declaredFiles) {
  const declared = Array.isArray(declaredFiles) ? [...new Set(declaredFiles.filter((f) => typeof f === 'string' && f !== ''))] : [];
  const expected = declared.slice(0, REVIEWED_BLOBS_CAP);
  const ev = isEvidenceObject(evidence) ? evidence : {};
  const named = [
    ...(isEvidenceObject(ev.blobs) ? Object.keys(ev.blobs) : []),
    ...(Array.isArray(ev.absent_paths) ? ev.absent_paths.filter((p) => typeof p === 'string' && p !== '') : []),
  ];
  const expectedSet = new Set(expected);
  const namedSet = new Set(named);
  const foreign = [...new Set(named.filter((p) => !expectedSet.has(p)))];
  const missing = ev.failure_reason ? [] : expected.filter((p) => !namedSet.has(p));
  return { expected, foreign, missing, faulty: foreign.length > 0 || missing.length > 0 };
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

// TERRITORY BY POSITION — THE POSITIONAL-SAFETY VERDICT (board c9f92090 part
// (a)). SubagentStart carries {session_id, transcript_path, cwd, prompt_id,
// agent_id, agent_type} and NO tool_use_id (research_finding ffa6219c, four
// fixtures checked), so NOTHING binds this Start to the Agent block that
// spawned it: the match below is POSITIONAL, and it is only structurally
// sound when exactly one same-type block sits in the CURRENT dispatching
// message. Every other shape is a guess that has already been measured wrong
// (decision c91b351d: a sequential fresh same-type reviewer dispatch had its
// territory stamped OFF BY ONE through the walk-back). `attribution`
// ('block'|'union') is the pre-existing H26 label and is NOT that verdict —
// a walk-back single match is marked 'block' yet is exactly the unsafe shape
// — so the verdict rides its OWN field rather than being inferred from the
// label, and the label stays byte-identical for every existing consumer.
// The CASE is carried, not just a boolean, because the reviewer-class
// disclosure at SubagentStart names which of the three unsafe shapes fired.
const SAFE_ATTRIBUTION_CASE = 'current-message-unique';
function attributeBlocks(transcriptPath, agentType) {
  const lastBlocks = lastDispatchBlocks(transcriptPath, 0);
  // A missing/empty stdin.agent_type must never be matched against a block
  // whose own subagent_type is also missing — undefined === undefined would
  // mint a false 'block' attribution (the label H26 warns on). Require a real
  // string on BOTH sides before treating it as a match.
  if (typeof agentType !== 'string' || agentType === '') {
    return {
      blocks: lastBlocks,
      attribution: 'union',
      positional: { safe: false, case: 'no-agent-type', detail: 'this SubagentStart carried no usable agent_type, so no block could be type-matched at all' },
    };
  }
  let matched = lastBlocks.filter((b) => typeof b.subagent_type === 'string' && b.subagent_type === agentType);
  if (matched.length === 1) {
    return {
      blocks: matched,
      attribution: 'block',
      positional: { safe: true, case: SAFE_ATTRIBUTION_CASE, detail: `exactly one '${agentType}' block in the current dispatching message` },
    };
  }
  if (matched.length > 1) {
    return {
      blocks: matched,
      attribution: 'union',
      positional: {
        safe: false,
        case: 'same-type-siblings',
        detail: `${matched.length} same-type ('${agentType}') blocks sit in the current dispatching message and no stdin field says WHICH one this spawn is`,
      },
    };
  }
  for (let skip = 1; skip <= MAX_WALK_BACK; skip++) {
    const blocks = lastDispatchBlocks(transcriptPath, skip);
    if (!blocks.length) continue; // this dispatching message had no blocks with a string prompt — keep walking, the loop is still bounded by MAX_WALK_BACK
    matched = blocks.filter((b) => typeof b.subagent_type === 'string' && b.subagent_type === agentType);
    // ANY walk-back result is positionally unsafe, INCLUDING a single match:
    // the walk-back exists for the cross-batch race, and the measured
    // off-by-one (decision c91b351d) took exactly this branch — a fresh
    // same-type dispatch was attributed an EARLIER message's block. The
    // 'block' label is preserved for H26 (unchanged behavior); the verdict is
    // not.
    if (matched.length === 1) {
      return {
        blocks: matched,
        attribution: 'block',
        positional: {
          safe: false,
          case: 'walk-back',
          detail: `no '${agentType}' block in the current dispatching message; the bounded backward walk matched one ${skip} dispatching message(s) earlier, which is the measured off-by-one shape (decision c91b351d)`,
        },
      };
    }
    if (matched.length > 1) {
      return {
        blocks: matched,
        attribution: 'union',
        positional: {
          safe: false,
          case: 'walk-back',
          detail: `no '${agentType}' block in the current dispatching message; the bounded backward walk matched ${matched.length} same-type blocks ${skip} dispatching message(s) earlier`,
        },
      };
    }
  }
  // Bounded walk found no type-match anywhere: fall back to the union of the
  // last dispatching message's blocks, same as the pre-fix behavior, but now
  // explicitly marked imprecise.
  return {
    blocks: lastBlocks,
    attribution: 'union',
    positional: {
      safe: false,
      case: 'terminal-union',
      detail: `no '${agentType}' block was found in the current dispatching message or anywhere in the bounded backward walk, so territory fell back to the union of the last message's blocks`,
    },
  };
}

function candidatesFromBlocks(blocks) {
  return [...new Set(blocks.flatMap((b) => extractPathCandidates(b.prompt)))];
}

// PATH NORMALIZATION FOR EVERY TERRITORY THIS FILE RECORDS — hoisted out of
// the SubagentStart branch (where it was a `toRegisterPaths` closure) when the
// Stop-time reviewer binding became a SECOND producer of territory (decision
// edbaa38d). It is hoisted rather than copied for the reason this file's
// header already gives about shared detectors: two spellings of "which paths
// may be recorded" drift, and a rebound receipt territory that normalized
// differently from a Start-attributed one would be a second path shape on the
// same field. The Start branch keeps a one-line alias so its call sites are
// byte-identical; the semantics below are unchanged from that closure.
//
// (Original rationale, verbatim in substance: the extractor's permissiveness
// costs more here than in H19 — a false candidate enters the register, so it
// SUPPRESSES a real duty and holds H10's releases non-terminal for the whole
// life of the dispatch. Under-defer is the safe direction, so this filter
// drops anything doubtful. Repo-relative POSIX only (§3.2 path invariant at
// the hook boundary); .git/.sterling are never governed territory, so they can
// never own a duty. 'sterling/…' and 'git/…' are dropped too: the extractor's
// directory segments exclude '.', so '.sterling/transient/x.json' in prompt
// prose arrives dot-stripped as 'sterling/transient/x.json' and would
// otherwise walk straight past the .sterling/ guard.)
function normalizeRegisterPaths(cands, cwd) {
  return [...new Set(cands.map((c) => repoRel(c, cwd)).filter(Boolean))].filter(
    (r) =>
      r !== '.git' &&
      !r.startsWith('.git/') &&
      !r.startsWith('.sterling/') &&
      !r.startsWith('sterling/') &&
      !r.startsWith('git/')
  );
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

// ===========================================================================
// STOP-TIME REVIEWER TERRITORY BINDING (decision edbaa38d, slug
// reviewer-attribution-binds-at-stop-from-child-transcript-and-meta-sidecar,
// user-decided 2026-09-06). THE ONE THING TO UNDERSTAND BEFORE CHANGING ANY OF
// THIS: the defect it closes is TRANSCRIPT LAG, not mis-ordering. At
// SubagentStart the parent's spawning assistant record is sometimes NOT YET ON
// DISK, so attributeBlocks above walks back to an older block or unions across
// types — measured live in session 2d57d164 on 2026-09-06, where a reviewer
// receipt recorded a CODER's territory. It is a nondeterministic
// write-visibility race, so NO Start-time positional scheme can be made safe,
// and FIFO-across-messages was explicitly REJECTED as institutionalising the
// guess. Do not "improve" the Start-side attribution to fix an unattributable
// receipt; the fix is here, at Stop, where the artifacts are complete.
//
// WHAT BINDS, in two halves that must BOTH hold:
//   PRIMARY — the FIRST record of the child transcript (stdin.agent_transcript_path)
//   is the brief as DELIVERED to this agent, verbatim. That is the brief which
//   provably reached THIS agent, so no join is needed to establish it, and
//   REVIEW-TERRITORY is parsed out of it with the SAME parseReviewTerritory the
//   Start side uses — never a second parser.
//   CORROBORATION/BINDING — the .meta.json sidecar beside that transcript
//   carries the spawning tool_use's id, so the block is located in the parent by
//   a KNOWN ID rather than by position. Byte-identical briefs on two concurrent
//   dispatches — the case where prompt-matching and positional schemes alike
//   fail — are unambiguous under this, which is the reason the sidecar is the
//   binding key and the prompt equality is only the cross-check.
//
// VERIFY-AT-BUILD — PLATFORM ASSUMPTIONS, all UNDOCUMENTED SURFACES (register:
// decision 19678617; same standing as research_finding ffa6219c "SubagentStart
// carries no tool_use_id" and 20b44518 "agent_transcript_path arrives on Stop"):
//   (1) the child transcript's FIRST record is
//       {parentUuid:null, isSidechain:true, type:'user', message:{role:'user',
//       content:<string>}} and that content is the delivered brief byte-for-byte
//       (measured 15/15 this session, foreground and background alike);
//   (2) a sidecar exists at <agent_transcript_path minus .jsonl>.meta.json
//       carrying {agentType, description, toolUseId, spawnDepth, model}
//       (measured present 1753/1754 child transcripts across all sessions;
//       toolUseId matches the originating tool_use.id 15/15). It is REWRITTEN on
//       every SendMessage delivery, but toolUseId keeps the ORIGINAL spawn's
//       value — which is what makes it usable on a continuation round;
//   (3) that first record ALSO carries a TOP-LEVEL `agentId` equal to the
//       stopping agent's stdin `agent_id` — the bare `a380392b87af09bd1` form,
//       which is also the `agent-<agentId>.jsonl` filename token (measured
//       29/29 child transcripts of session 2d57d164 on 2026-09-06, CC as
//       installed on this machine; corroborated against the live dispatch
//       register's own agent_id values);
//   (4) each SendMessage continuation round appends ANOTHER user record whose
//       message.content is a STRING to the SAME child transcript, so the count
//       of string-content user records IS the round number (measured 2026-09-06
//       over the same 29 transcripts: 26 never-resumed children carry exactly
//       one, and the three resumed ones carry 2, 3 and 7). Keyed on that
//       STRUCTURE, never on the English wording of the coordinator envelope,
//       which is not a contract.
// Every one of those assumptions is checked here rather than trusted: if the
// platform changes any of them, this fails CLOSED to 'unattributable' and says
// which check failed, instead of recording a guess.
//
// WHY THESE SHAPES REFUSE: the decision's own fail-closed list is exhaustive
// for the shapes IT names, and parentUuid/isSidechain are deliberately still
// NOT checked, because the prompt-equality cross-check already subsumes them —
// a first record that is not this agent's brief cannot equal the spawning
// block's prompt. Assumptions (3) and (4) are ADDITIONS to that list, each
// closing a measured hole an external review found in the shipped derivation,
// and each derived from data this function already reads:
//   • (3) closes THE BIND IS NOT TIED TO THIS AGENT. Without it the checks
//     prove only that the transcript agrees with its sidecar, the sidecar with
//     stdin.agent_type, and the prompt with a parent block — never that the
//     transcript belongs to THIS agent_id. Two sibling reviewers of the SAME
//     class have interchangeable, self-consistent triples, so a wrong
//     agent_transcript_path would bind a FOREIGN territory onto this agent's
//     receipt with a spendable source. An ABSENT agentId refuses too: a record
//     that does not name an agent proves nothing about which one it belongs to.
//   • (4) closes A RESUMED REVIEWER MINTING A SECOND SPENDABLE RECEIPT. The
//     Stop-side gate below reads `!existingReceipt` as "first Stop", which is
//     false once commit-reviewed has SPENT and deleted the first receipt: a
//     later round would then re-bind the ORIGINAL brief's territory, hash the
//     CURRENT bytes, and mint a fresh spendable receipt for bytes nobody
//     reviewed. The refusal is named for what is OBSERVED (this is not the
//     first Stop), never for a cause — the same state also arises from a crash
//     between mint and ledger write, and nothing here can tell the two apart.
const CHILD_SCAN_BYTES = 64 * 1024 * 1024; // whole-child scan: assumption (4) counts rounds across the FILE, not just the first line (largest child measured on this machine 2026-09-06: ~1.3MB; same headroom posture as PARENT_SCAN_BYTES)
const PARENT_SCAN_BYTES = 64 * 1024 * 1024; // ~5x the largest parent transcript measured on this machine (~12MB, 2026-09-06)

/** The child transcript's first record content (the delivered brief) plus the
 *  two other facts the bind needs from the SAME read — the record's own
 *  `agentId` (assumption (3)) and the number of string-content user records,
 *  i.e. the round count (assumption (4)) — or a named refusal. Reads FORWARD
 *  (readFromStart) — readTail's window is at the wrong end of the file for
 *  this. `complete` is returned rather than acted on here: a round count is an
 *  ABSENCE claim ("no further rounds") and is only valid over a COMPLETE read,
 *  which is the caller's ordering decision. */
function childBriefFromTranscript(childPath) {
  const read = readFromStart(childPath, CHILD_SCAN_BYTES);
  if (read === null) return { ok: false, reason: 'child-transcript-missing', detail: `no file at '${childPath}'` };
  const nl = read.text.indexOf('\n');
  if (nl === -1 && !read.complete) {
    return {
      ok: false,
      reason: 'child-first-record-truncated',
      detail: `the child transcript's first line exceeds the ${CHILD_SCAN_BYTES}-byte read window, so the delivered brief could not be read whole`,
    };
  }
  const firstLine = (nl === -1 ? read.text : read.text.slice(0, nl)).trim();
  if (firstLine === '') return { ok: false, reason: 'child-transcript-empty', detail: `'${childPath}' has no first record` };
  let record;
  try {
    record = JSON.parse(firstLine);
  } catch {
    return { ok: false, reason: 'child-first-record-unparseable', detail: 'the first line of the child transcript is not JSON' };
  }
  // The KNOWN GAP the decision names: a resumed/split session shape whose child
  // transcript begins with an ASSISTANT record (observed
  // 6fd7cc7d/subagents/agent-a3b2de11b9b6de9ff.jsonl). Refused here by name.
  if (!record || record.type !== 'user') {
    return { ok: false, reason: 'child-first-record-not-user', detail: `first record type is ${JSON.stringify(record?.type)}, not 'user' (the resumed/split-session shape the decision refuses)` };
  }
  const content = record.message?.content;
  if (typeof content !== 'string') {
    return { ok: false, reason: 'child-first-record-content-not-string', detail: `first record message.content is ${typeof content}, not the delivered brief string` };
  }
  // ROUND COUNT (assumption (4)): every SendMessage continuation appends one
  // more string-content user record to this same file, so counting that SHAPE
  // — never the envelope's prose — tells the caller whether this is round one.
  // The first record itself is one of them.
  //
  // AN UNPARSEABLE LINE IS COUNTED, NOT SKIPPED — the opposite of the parent
  // scan's posture, and deliberately so. The parent scan searches for a KNOWN
  // id (a positive find), so skipping a partial line at worst delays a find;
  // here the conclusion is an ABSENCE ("no further round exists"), and a record
  // cut off mid-write is exactly where the round this check exists to catch
  // would be hiding. So the caller is told, and refuses rather than concluding.
  let userStringRecords = 0;
  let unparseableLines = 0;
  for (const line of read.text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      unparseableLines++;
      continue;
    }
    if (entry?.type === 'user' && typeof entry?.message?.content === 'string') userStringRecords++;
  }
  return { ok: true, brief: content, agentId: record.agentId, userStringRecords, unparseableLines, complete: read.complete };
}

/** The .meta.json sidecar beside a child transcript, or a named refusal. */
function sidecarForChildTranscript(childPath) {
  if (!childPath.endsWith('.jsonl')) {
    return { ok: false, reason: 'sidecar-path-underivable', detail: `agent_transcript_path '${childPath}' does not end in .jsonl, so the sidecar path cannot be derived` };
  }
  const sidecarPath = `${childPath.slice(0, -'.jsonl'.length)}.meta.json`;
  if (!existsSync(sidecarPath)) return { ok: false, reason: 'sidecar-missing', detail: `no file at '${sidecarPath}'` };
  let meta;
  try {
    meta = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  } catch {
    return { ok: false, reason: 'sidecar-unparseable', detail: `'${sidecarPath}' is not readable JSON` };
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { ok: false, reason: 'sidecar-malformed', detail: `'${sidecarPath}' does not hold a JSON object` };
  }
  if (typeof meta.toolUseId !== 'string' || meta.toolUseId === '') {
    return { ok: false, reason: 'sidecar-tool-use-id-missing', detail: `sidecar toolUseId is ${JSON.stringify(meta.toolUseId)}` };
  }
  // NESTED AGENTS ARE REFUSED (decision edbaa38d's named gap): a spawnDepth
  // above 1 means the spawning block does not live in the parent transcript
  // this Stop was handed, so the binding below could not be completed honestly.
  // A MISSING depth is refused too — an unstated depth is not a stated 1.
  if (meta.spawnDepth !== 1) {
    return { ok: false, reason: 'sidecar-spawn-depth', detail: `sidecar spawnDepth is ${JSON.stringify(meta.spawnDepth)}, not 1 (nested agents are refused for reviewer receipts)` };
  }
  return { ok: true, meta, sidecarPath };
}

/** The parent's tool_use block with this id. A search for a KNOWN id cannot
 *  false-match, which is why it may scan the whole parent rather than
 *  readTail's window (decision edbaa38d point 6). An INCOMPLETE scan can never
 *  report absence — it refuses instead. */
function findParentToolUseBlock(parentPath, toolUseId) {
  if (typeof parentPath !== 'string' || parentPath === '') {
    return { ok: false, reason: 'parent-transcript-path-absent', detail: 'stdin carried no transcript_path to locate the spawning block in' };
  }
  const read = readFromStart(parentPath, PARENT_SCAN_BYTES);
  if (read === null) return { ok: false, reason: 'parent-transcript-missing', detail: `no file at '${parentPath}'` };
  for (const line of read.text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // a partial trailing line while the platform is mid-append
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    const block = content.find((b) => b?.type === 'tool_use' && b.id === toolUseId);
    if (block) return { ok: true, block };
  }
  if (!read.complete) {
    return {
      ok: false,
      reason: 'parent-scan-truncated',
      detail: `the parent transcript exceeds the ${PARENT_SCAN_BYTES}-byte scan window, so '${toolUseId}' being unfound proves nothing`,
    };
  }
  return { ok: false, reason: 'tool-use-id-absent-from-parent', detail: `no tool_use block with id '${toolUseId}' anywhere in the parent transcript` };
}

/**
 * Binds THIS reviewer dispatch's territory from artifacts that are complete at
 * Stop. Returns either
 *   { bound: true, files, files_source, warnings, tool_use_id }  — authoritative
 *   { bound: false, reason, detail }                            — fail closed
 * and never throws for a shape it does not recognise.
 *
 * WHAT A SUCCESSFUL BIND YIELDS is still decided by the DECLARED line, exactly
 * as decision 9500cce1 requires (declared REVIEW-TERRITORY is authoritative;
 * observed paths only corroborate and never gate). All this changes is WHICH
 * COPY of the brief the declaration is read from: the one that provably reached
 * this agent, instead of a positionally-guessed block. A bound brief carrying
 * NO valid declaration is therefore NOT a refusal — it is the ordinary
 * free-prose fallback, now computed over the right prompt, which is strictly
 * better evidence than the same fallback over a possibly-foreign block. The
 * decision's fail-closed list names unbindable SHAPES, not undeclared briefs.
 */
function bindReviewerTerritoryAtStop(input) {
  const childPath = input.agent_transcript_path;
  if (typeof childPath !== 'string' || childPath === '') {
    return { bound: false, reason: 'agent-transcript-path-absent', detail: 'stdin carried no agent_transcript_path, so there is no delivered brief to bind against' };
  }
  const brief = childBriefFromTranscript(childPath);
  if (!brief.ok) return { bound: false, reason: brief.reason, detail: brief.detail };
  // AGENT IDENTITY, assumption (3): the transcript must belong to THIS agent.
  // Nothing else in this function establishes that — the sidecar/agent_type/
  // prompt chain is satisfiable by ANY sibling of the same class, so without
  // this a wrong agent_transcript_path binds a foreign territory onto this
  // agent's receipt with a spendable source. Absent refuses exactly like a
  // mismatch: a record naming no agent proves nothing.
  if (typeof input.agent_id !== 'string' || input.agent_id === '' || typeof brief.agentId !== 'string' || brief.agentId !== input.agent_id) {
    return {
      bound: false,
      reason: 'child-transcript-agent-mismatch',
      detail: `the child transcript's first record carries agentId ${JSON.stringify(brief.agentId)}, which is not the stopping agent's stdin agent_id ${JSON.stringify(input.agent_id)}, so '${childPath}' is not provably this agent's transcript`,
    };
  }
  // FIRST STOP ONLY, assumption (4). A second-or-later Stop reaching the bind
  // means the receipt this dispatch already minted is GONE — spent by
  // scripts/commit-reviewed.mjs, or lost between mint and ledger write — and
  // re-binding would mint a FRESH spendable receipt attesting the CURRENT bytes
  // under the ORIGINAL brief's territory: bytes nobody reviewed. Checked before
  // the truncation refusal below because finding extra rounds is a POSITIVE
  // observation that a partial read cannot invalidate.
  if (brief.userStringRecords > 1) {
    return {
      bound: false,
      reason: 'not-first-stop-no-existing-receipt',
      detail: `the child transcript carries ${brief.userStringRecords} string-content user records, so this is continuation round ${brief.userStringRecords}, not the first Stop — yet no receipt exists for this dispatch to refresh. Territory is bound at the FIRST Stop only; what happened to the earlier receipt (spent by a commit, or lost) is not knowable from here`,
    };
  }
  // ...and the "exactly one round" conclusion is an ABSENCE claim, so it is
  // only honest over a COMPLETE read. INCOMPLETE HAS TWO SHAPES and both
  // refuse: the scan window cut the file short, or a line was cut off mid-write
  // so its record could not be read at all. Neither can prove that no further
  // continuation record exists.
  if (!brief.complete || brief.unparseableLines > 0) {
    return {
      bound: false,
      reason: 'child-scan-truncated',
      detail: brief.complete
        ? `the child transcript holds ${brief.unparseableLines} unreadable line(s) — a record cut off mid-write — so 'exactly one round' cannot be concluded: an unreadable record could itself be the continuation this check exists to catch`
        : `the child transcript exceeds the ${CHILD_SCAN_BYTES}-byte scan window, so 'exactly one round' cannot be concluded — an unread tail could hold further continuation records`,
    };
  }
  const sidecar = sidecarForChildTranscript(childPath);
  if (!sidecar.ok) return { bound: false, reason: sidecar.reason, detail: sidecar.detail };
  // AGENT-TYPE CORROBORATION: the sidecar must agree with the stdin this hook
  // was invoked for. A disagreement means the sidecar does not describe this
  // Stop, and everything downstream of it would be another dispatch's evidence.
  if (sidecar.meta.agentType !== input.agent_type) {
    return {
      bound: false,
      reason: 'agent-type-mismatch',
      detail: `sidecar agentType ${JSON.stringify(sidecar.meta.agentType)} does not equal stdin agent_type ${JSON.stringify(input.agent_type)}`,
    };
  }
  const located = findParentToolUseBlock(input.transcript_path, sidecar.meta.toolUseId);
  if (!located.ok) return { bound: false, reason: located.reason, detail: located.detail };
  // PROMPT EQUALITY, byte-for-byte: the spawning block's prompt and the brief
  // the child actually received must be the same string. This is what proves
  // the id, the sidecar and the delivered brief all describe ONE dispatch.
  if (located.block.input?.prompt !== brief.brief) {
    return {
      bound: false,
      reason: 'prompt-mismatch',
      detail: `the parent block '${sidecar.meta.toolUseId}' prompt is not byte-identical to the child's first record, so the sidecar and the delivered brief do not describe one dispatch`,
    };
  }
  // ONE SYNTHETIC BLOCK, run through the SAME resolveTerritory the Start side
  // uses — declared-wins-over-prose, malformed declarations warned about, never
  // a second parser and never a second aggregation rule.
  const { candidates, files_source, warnings } = resolveTerritory([{ subagent_type: sidecar.meta.agentType, prompt: brief.brief }]);
  return {
    bound: true,
    files: normalizeRegisterPaths(candidates, input.cwd),
    files_source,
    warnings,
    tool_use_id: sidecar.meta.toolUseId,
  };
}
// ===========================================================================

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
    // `acquired` is handed to the body (board c9f92090 part (b)) so a caller
    // that must NOT take the unlocked route can refuse it for its own path
    // without changing this posture for the append path, which has taken it
    // since the ledger shipped. The RESUME REFRESH is such a path: it rewrites
    // an EXISTING entry, so an unlocked whole-array write there can clobber a
    // concurrent commit-reviewed consume — skipping loses one refresh, the
    // unlocked route can lose a whole receipt.
    return run(false);
  }
  try {
    return run(true);
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
    const { blocks: matchedBlocks, attribution, positional } = attributeBlocks(input.transcript_path, input.agent_type);
    const { candidates, files_source: declaredFilesSource, warnings: territoryWarnings } = resolveTerritory(matchedBlocks);
    let filesSource = declaredFilesSource;
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
    const reviewerClassStart = typeof input.agent_type === 'string' && input.agent_type.startsWith('reviewer-');
    // Judged against the DECLARED source, before the unattributable override
    // below can rewrite it: a reviewer brief that DID carry a valid
    // REVIEW-TERRITORY line must never also be told it carried none, whatever
    // the positional verdict turns out to be. Two different defects, two
    // different messages.
    if (reviewerClassStart && declaredFilesSource !== 'review-territory') {
      process.stderr.write(
        `H22: reviewer-class dispatch '${input.agent_id}' (${input.agent_type}) has no valid REVIEW-TERRITORY declaration in its attributed dispatch block(s) — territory falls back to free-prose extraction, which measurably over-captures context-mentioned files (board f60ff6d8). Every code-touching reviewer dispatch should carry an explicit REVIEW-TERRITORY: [...] line in its prompt.\n`
      );
    }
    // TERRITORY BY POSITION (board c9f92090 part (a)) — REVIEWER-CLASS ONLY.
    // A positionally-unsafe attribution (see attributeBlocks above) means the
    // block this territory came from may belong to a DIFFERENT dispatch, and a
    // reviewer entry becomes a DURABLE RECEIPT that the merge gate reads as an
    // attestation. Recording a guessed territory there is a false attestation
    // waiting to be stamped (measured: decision c91b351d), so the source is
    // marked 'unattributable' and scripts/commit-reviewed.mjs refuses to spend
    // it — the receipt survives with its observed_files (bound to THIS agent's
    // own transcript at Stop), which is the only territory evidence actually
    // tied to this dispatch.
    //
    // NON-REVIEWER CLASSES ARE UNCHANGED ('union' / 'block' as before): their
    // only consumers are H10's deferral and H26's advisory, where an imprecise
    // attribution costs a bounded over-defer or one advisory line — H10's
    // asymmetry deliberately prefers bounded over-defer (decision 5a9fd5ac),
    // and there is no durable artifact to falsify.
    //
    // AN EXPLICIT DECLARATION DOES NOT RESCUE AN UNSAFE POSITION: the
    // declaration is read out of the SAME possibly-wrong block. What it does
    // rescue is the opposite reading — an explicitly declared
    // 'REVIEW-TERRITORY: []' under a SAFE attribution stays
    // files_source:'review-territory' (pin T2), because emptiness is not
    // unattributability.
    //
    // KNOWN, ACCEPTED CONSEQUENCE (H26, advisory-only): h26-dispatch-overlap
    // exempts files_source:'review-territory' entries from its claimed_files
    // fallback, so a reviewer entry re-labelled here compares against
    // claimed_files like every free-prose entry. That is the correct direction
    // — a declaration read off a possibly-wrong block is not authoritative
    // territory — and it can only change advisory wording, never a duty.
    if (reviewerClassStart && !positional.safe) {
      filesSource = 'unattributable';
      process.stderr.write(
        `H22: UNATTRIBUTABLE TERRITORY — reviewer-class dispatch '${input.agent_id}' (${input.agent_type}) could not be bound to a dispatch block by position [${positional.case}]: ${positional.detail}. SubagentStart carries no tool_use_id (research_finding ffa6219c), so the attributed territory may belong to a DIFFERENT dispatch. Its receipt records territory.source 'unattributable': scripts/commit-reviewed.mjs will NEVER stamp or consume it, and it stays in the ledger for a human to judge. observed_files (read from this agent's OWN transcript at Stop) remains the receipt's only trustworthy territory.\n`
      );
    }
    const claimedCandidates = claimedFromBlocks(matchedBlocks);
    const globPrefixCandidates = globPrefixesFromBlocks(matchedBlocks);
    // THE EXTRACTOR'S PERMISSIVENESS COSTS MORE HERE THAN IN H19, and the
    // normalization/exclusion filter that answers it now lives in ONE place,
    // shared with the Stop-time reviewer binding — its full rationale is on
    // normalizeRegisterPaths above. This alias keeps every call site below
    // byte-identical.
    const toRegisterPaths = (cands) => normalizeRegisterPaths(cands, input.cwd);
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

    // RESUMED REVIEWER (board c9f92090 part (b)). The register entry is
    // REMOVED at the FIRST Stop (the removal block further down), so when a
    // reviewer is resumed — a follow-up message to an agent that already
    // stopped — its SECOND Stop finds NO `departing` at all and today's hook
    // takes the "unmatched agent_id → clean no-op" path: the second round of
    // review work leaves NO trace, and the receipt still claims the FIRST
    // round's finish time and bytes. So the refresh is keyed on agent_id
    // against the LEDGER, which is the durable side and is present in BOTH
    // shapes — whether or not the register entry survived. This unlocked read
    // is only a DECISION read (it decides which shape this Stop is and what
    // territory to hash); the authoritative match is re-made inside the lock.
    const sterlingRoot = join(input.cwd, '.sterling');
    const readLedgerArray = () => {
      try {
        const p = join(sterlingRoot, 'review-ledger.json');
        if (existsSync(p)) {
          const raw = JSON.parse(readFileSync(p, 'utf8'));
          if (Array.isArray(raw)) return raw;
        }
      } catch {
        // malformed ledger degrades to empty, same posture as everywhere else
      }
      return [];
    };
    // Matches THIS dispatch. agent_id is the register's own unique key and is
    // stamped into identity.agent_id on every v2 promotion; a v1 entry (and a
    // pre-identity v2 one) never carries it and so can never false-match — the
    // agent_type+at fallback below is reachable only when a register entry is
    // in hand to compare against (finding HIGH-2's discrimination is preserved:
    // two distinct dispatches sharing agent_type+at each carry their own real
    // agent_id and always take the agent_id branch).
    const matchesThisDispatch = (e) => {
      const normalized = normalizeLedgerEntry(e);
      if (!normalized) return false;
      if (typeof normalized.agent_id === 'string' && typeof input.agent_id === 'string') {
        return normalized.agent_id === input.agent_id;
      }
      return !!departing && normalized.agent_type === departing.agent_type && normalized.at === departing.at;
    };
    const departingIsReviewer = !!departing && typeof departing.agent_type === 'string' && departing.agent_type.startsWith('reviewer-');
    // THIS DISPATCH'S EXISTING RECEIPT, CONSULTED UNCONDITIONALLY (fix round,
    // HIGH — measured live 2026-09-05 on the real ledger). This read used to be
    // skipped whenever a register entry was in hand ("reading it twice would
    // just widen the window"), and that assumption is FALSE for a resumed
    // reviewer: a follow-up message to an already-stopped agent can produce a
    // FRESH SubagentStart, so the resumed dispatch DOES have a register entry
    // again — and that entry's `files` are re-attributed from the NEWEST
    // dispatching message, which under a concurrent same-batch dispatch is
    // ANOTHER agent's territory. The Stop then hashed those foreign paths and
    // the refresh wrote them into a receipt whose territory.files was never
    // rewritten: receipt 27024ff2 (reviewer-security, five H15 paths) came out
    // with content_evidence bound to two h22/commit-reviewed paths and
    // status:'complete', and commit-reviewed correctly refused the commit with
    // NO RECORDED BYTES for all five declared paths. So the ledger is asked
    // FIRST, always, and the RECEIPT — not any register entry — decides what a
    // refresh hashes (decision 9500cce1: declared territory is authoritative
    // and is never re-derived; on a refresh the receipt's own territory.files IS
    // that declaration).
    // Matched on the RAW entry and normalized afterwards — normalizeLedgerEntry
    // maps a v2 entry's NESTED shape to flat fields, so feeding it its own
    // output would find nothing to read and report an empty receipt.
    const existingReceiptRaw = readLedgerArray().find(matchesThisDispatch);
    const existingReceipt = existingReceiptRaw ? normalizeLedgerEntry(existingReceiptRaw) : null;
    // The RESUME candidate keeps its narrower meaning — "no register entry at
    // all, so this Stop can only be a resume" — because the consumed-receipt
    // branch further down is keyed on exactly that shape.
    const resumeCandidate = departing ? null : existingReceipt;
    const resumeIsReviewer = !!resumeCandidate && typeof resumeCandidate.agent_type === 'string' && resumeCandidate.agent_type.startsWith('reviewer-');
    if (departingIsReviewer || resumeIsReviewer) {
      // The reviewer identity for this Stop, from whichever side actually
      // carries it. A resumed reviewer has no register entry, so the receipt
      // it is refreshing is the only record of its agent_type and its DECLARED
      // territory — which the refresh reads but NEVER rewrites (decision
      // 9500cce1: declared territory is authoritative and is not re-derived).
      const stopAgentType = departingIsReviewer ? departing.agent_type : resumeCandidate.agent_type;
      // STOP-TIME TERRITORY BINDING, FRESH MINTS ONLY (decision edbaa38d — see
      // bindReviewerTerritoryAtStop above for the mechanism and the measured
      // race it closes).
      //
      // WHY `!existingReceipt` GATES IT: a receipt already in hand means this
      // Stop can only REFRESH, and a refresh NEVER re-derives territory
      // (decision 9500cce1; the refresh path below rewrites finished_at,
      // evidence, observed_* and resume_count and nothing else). A continuation
      // round matters here specifically: SendMessage appends a
      // coordinator-message record to the SAME child transcript, so only the
      // FIRST record is the delivered brief — binding on a later round would
      // still read record one, but the receipt it would write to is not this
      // mechanism's to rewrite. So round >= 2 does not bind at all.
      //
      // `!existingReceipt` IS NOT PROOF OF A FIRST STOP, and is no longer
      // trusted as one: once commit-reviewed has SPENT and deleted the first
      // receipt, a resumed reviewer's second Stop also finds no receipt, and
      // binding here would mint a FRESH spendable receipt over the current
      // bytes. This gate therefore only decides whether binding is ATTEMPTED;
      // bindReviewerTerritoryAtStop itself decides whether this really is round
      // one, from the child transcript's own round count (assumption (4)), and
      // refuses 'not-first-stop-no-existing-receipt' when it is not.
      //
      // NON-REVIEWER CLASSES NEVER REACH THIS: `departingIsReviewer` is the
      // 'reviewer-' prefix check, and every other class keeps the Start-side
      // block/union attribution untouched (decision 5d3747c1). Their only
      // consumers are H10's deferral and H26's advisory, where an imprecise
      // attribution costs a bounded over-defer or one advisory line — there is
      // no durable artifact to falsify.
      const stopBinding = departingIsReviewer && !existingReceipt ? bindReviewerTerritoryAtStop(input) : null;
      if (stopBinding) {
        for (const w of stopBinding.warnings ?? []) process.stderr.write(w + '\n');
        if (stopBinding.bound) {
          process.stderr.write(
            `H22: reviewer territory BOUND AT STOP for '${input.agent_id}' (agent_type '${stopAgentType}') from the brief this agent actually received — child transcript first record, corroborated by sidecar toolUseId '${stopBinding.tool_use_id}' and a byte-identical parent prompt. Receipt territory records ${stopBinding.files.length} file(s) with source '${stopBinding.files_source}'; the SubagentStart register attribution (files_source '${departing.files_source}') was provisional and is NOT what this receipt attests.\n`
          );
        } else {
          process.stderr.write(
            `H22: UNATTRIBUTABLE TERRITORY AT STOP — reviewer '${input.agent_id}' (agent_type '${stopAgentType}') could not be bound to its dispatch block [${stopBinding.reason}]: ${stopBinding.detail}. The Start-side attribution is a positional GUESS (SubagentStart carries no tool_use_id, research_finding ffa6219c, and the parent's spawning record is sometimes not yet on disk when it fires — decision edbaa38d), so it is recorded as territory.source 'unattributable': scripts/commit-reviewed.mjs will NEVER stamp or consume this receipt, and it stays in the ledger for a human to judge. observed_files (read from this agent's OWN transcript) remains its only trustworthy territory.\n`
          );
        }
      }
      // What the fresh mint below will actually record. Fail-closed by
      // construction: territory is the BOUND territory or nothing, and any
      // shape that did not bind is labelled 'unattributable' whatever the
      // register entry claimed.
      const boundTerritory = stopBinding && stopBinding.bound ? stopBinding : null;
      const mintFiles = boundTerritory ? boundTerritory.files : departing?.files;
      const mintFilesSource = boundTerritory ? boundTerritory.files_source : 'unattributable';
      // THE TERRITORY TO HASH COMES FROM THE RECEIPT WHENEVER ONE EXISTS, and
      // from the register entry ONLY for a genuinely fresh mint (see the
      // unconditional ledger read above for the measured defect). A receipt in
      // hand means this Stop can only REFRESH it, and a refresh's evidence must
      // describe the territory that receipt DECLARES — never a register entry's
      // re-scraped guess about it.
      // For a FRESH MINT this is now the STOP-BOUND territory (mintFiles above)
      // rather than the register entry's Start-time guess — the precompute must
      // hash the territory the receipt will actually declare, or the memo below
      // misses and the evidence is rebuilt under the lock for no reason.
      const stopTerritoryFiles = existingReceipt ? existingReceipt.files : mintFiles;
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
      //
      // MEMOIZED BY TERRITORY, so the object that gets WRITTEN can never
      // describe a different path set than the entry it is written onto. The
      // authoritative entry is re-matched INSIDE the lock, and the ledger can
      // change in between (a concurrent consume deletes the receipt this Stop
      // meant to refresh, so the same Stop must now MINT from the register
      // entry instead) — with a single precomputed object, that swap silently
      // recorded one territory's bytes under another territory's declaration,
      // which is the defect above in its second form. The normal path is a
      // cache HIT on the precompute below (same posture as before: hashed
      // outside the lock, at the review-END bytes); only the rare swap pays a
      // git spawn under the lock, which is the correct price for evidence that
      // matches what it is filed against.
      const evidenceByTerritory = new Map();
      const territoryKey = (files) =>
        (Array.isArray(files) ? [...new Set(files.filter((f) => typeof f === 'string' && f !== ''))] : []).sort().join('\n');
      const evidenceFor = (files) => {
        const key = territoryKey(files);
        if (!evidenceByTerritory.has(key)) evidenceByTerritory.set(key, buildContentEvidence(input.cwd, files));
        return evidenceByTerritory.get(key);
      };
      const contentEvidence = evidenceFor(stopTerritoryFiles);
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
          `H22: no observed evidence for reviewer '${input.agent_id}' (agent_type '${stopAgentType}') — agent transcript unobservable (agent_transcript_path is ${shape}); this receipt promotes without observed_files/observed_source.\n`
        );
      }
      withLedgerLock(sterlingDir, (lockAcquired) => {
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
        //
        // THE MATCH IS NOW THE REFRESH SELECTOR TOO (board c9f92090 part (b)):
        // the same identity that says "do not promote this twice" says "this is
        // the receipt THIS resumed reviewer already owns". matchesThisDispatch
        // is defined once, above the lock, so the decision read and this
        // authoritative one can never diverge.
        const existingIndex = ledger.findIndex(matchesThisDispatch);
        if (existingIndex !== -1) {
          // RESUME REFRESH (board c9f92090 part (b)) — replaces the old
          // unconditional "skipping duplicate promotion". The old behavior was
          // right about the COUNT (one dispatch, one receipt — the
          // LEDGER-IDEMPOTENCY pin still holds) and wrong about the CONTENT: a
          // second Stop for the same agent_id is a SECOND ROUND OF REVIEW, and
          // leaving the receipt frozen at the first round's finish time and
          // first round's bytes attests to a review that is no longer the one
          // that happened.
          //
          // WHAT A REFRESH MAY TOUCH, and nothing else: finished_at (the new
          // review-END instant), content_evidence (the bytes as they stand
          // NOW), observed_* (UNION with what was already observed — the first
          // round's evidence is not erased by the second), and resume_count.
          // NEVER entry_id (its identity on the merge-gate surface, and the
          // key --waive-bytes names), NEVER identity.* (session/branch/base_sha
          // /agent_id — the expiry axes, decision 0408b295), NEVER the
          // reviewer{} snapshot (model provenance is taken at dispatch, pin
          // V2-3b), and NEVER territory.files (declared territory is
          // authoritative and is never re-derived, decision 9500cce1).
          const raw = ledger[existingIndex];
          const existing = normalizeLedgerEntry(raw);
          const label = `agent_id '${input.agent_id}' (agent_type '${stopAgentType}')`;
          // FAIL-CLOSED GATE 1 — LEGACY SHAPE. A v1 (or pre-identity v2) entry
          // matched through the agent_type+at fallback has no finished_at,
          // content_evidence or observed_* to refresh; rewriting it would
          // MIGRATE it in place, which pin V2-6 forbids. Old behavior verbatim:
          // skip, disclosed.
          if (!existing || existing.schema_version !== 2) {
            process.stderr.write(
              `H22: a review receipt for ${label} is already present in .sterling/review-ledger.json and is a LEGACY (pre-v2) entry — skipping duplicate promotion; a legacy receipt is never refreshed in place and never migrated (pin V2-6)\n`
            );
            return;
          }
          // FAIL-CLOSED GATE 2 — DISCHARGED. A discharged receipt was
          // explicitly ruled unspendable and PRESERVED (decision 57984926 §3).
          // Refreshing it would make a settled adjudication look live again.
          if (existing.status === 'discharged') {
            process.stderr.write(
              `H22: NOT REFRESHING a DISCHARGED review receipt for ${label} — it was explicitly ruled unspendable and is preserved as it stands (decision 57984926 §3). This Stop's finish time and content evidence are NOT recorded; dispatch a fresh reviewer if this work needs a live receipt.\n`
            );
            return;
          }
          // FAIL-CLOSED GATE 3 — DIFFERENT BRANCH. A receipt's life is bound to
          // the session and branch that earned it (decision 0408b295);
          // refreshing one from another branch would relabel evidence earned
          // elsewhere as current. POSITIVE EVIDENCE ONLY, the same rule
          // commit-reviewed applies: both sides must carry a usable identity
          // before a mismatch can refuse.
          const receiptBranch = normIdentity(existing.branch);
          const hereBranch = normIdentity(identity.branch);
          if (receiptBranch !== null && hereBranch !== null && receiptBranch !== hereBranch) {
            process.stderr.write(
              `H22: REFUSING to refresh the review receipt for ${label} — it was earned on branch '${receiptBranch}' and this Stop fired on '${hereBranch}'. A receipt's evidence is bound to the branch that earned it (decision 0408b295), so it is left byte-identical: nothing about this Stop is recorded on it.\n`
            );
            return;
          }
          // FAIL-CLOSED GATE 3b — DIFFERENT SESSION (fix round, MEDIUM). Decision
          // 0408b295 binds a receipt to BOTH expiry axes — "a receipt from a
          // different session or branch" — and gate 3 above mirrored only the
          // branch half. A receipt earned by an EARLIER session could therefore be
          // refreshed (new finish instant, re-hashed bytes) by a Stop belonging to
          // a different session, which is the same relabelling of foreign evidence
          // as current that the branch gate refuses, on the axis that has no
          // checkout to blame. POSITIVE EVIDENCE ONLY, identical in form to the
          // branch gate and to commit-reviewed's own partition rule: both sides
          // must carry a usable session identity before a mismatch can refuse, so
          // a receipt with no recorded session_id (legacy/pre-expiry) and a Stop
          // with no session_id on stdin both stay refreshable exactly as before.
          // ORDER IS DELIBERATE — this sits AFTER the branch gate so a Stop that
          // is foreign on BOTH axes is still reported as the BRANCH mismatch: that
          // is the axis whose remedy a reader can act on (check the branch out),
          // whereas a foreign session's only remedy is a fresh dispatch.
          const receiptSession = normIdentity(existing.session_id);
          const hereSession = normIdentity(input.session_id);
          if (receiptSession !== null && hereSession !== null && receiptSession !== hereSession) {
            process.stderr.write(
              `H22: REFUSING to refresh the review receipt for ${label} — it was earned in session '${receiptSession}' and this Stop fired in session '${hereSession}'. A receipt's evidence is bound to the session that earned it (decision 0408b295), so it is left byte-identical: nothing about this Stop is recorded on it. Dispatch a fresh reviewer if this round of work needs its own receipt.\n`
            );
            return;
          }
          // THE REFUSAL BOTH TERRITORY-BINDING ARMS PRINT — one wording, so the
          // two arms cannot drift into saying different things about the same
          // violation, and one remedy, because a receipt that cannot describe
          // its own territory is not repairable by another refresh.
          const bindingRefusal = (subject, fault) =>
            `H22: REFUSING to refresh the review receipt for ${label} — ${subject} does not bind the receipt's DECLARED territory` +
            (fault.foreign.length > 0 ? `; it names ${fault.foreign.length} path(s) the receipt never declared: ${fault.foreign.join(', ')}` : '') +
            (fault.missing.length > 0 ? `; it silently omits ${fault.missing.length} declared path(s) with no failure_reason to account for them: ${fault.missing.join(', ')}` : '') +
            `. Declared territory (${fault.expected.length} path(s)): ${fault.expected.join(', ') || '<none>'}. The receipt is left EXACTLY as it stands: evidence that describes another territory would make it claim coverage of bytes nobody hashed, and the reviewed-bytes gate would then refuse the commit for every declared path. This receipt is not repairable by a further refresh — DISCHARGE it (scripts/review-ledger.mjs discharge) or dispatch a FRESH review of this territory.\n`;

          // FAIL-CLOSED GATE 3c — THE RECEIPT'S OWN EVIDENCE IS ALREADY
          // MALFORMED (board c9f92090 pins TERRITORY GUARD). Checked on the
          // entry AS FOUND ON DISK, before anything about this Stop is applied,
          // and BEFORE the lock gate — a receipt whose recorded evidence
          // already violates its own declared territory is unsound whether or
          // not this Stop could have won the lock, and refreshing it would
          // launder a corrupted round into a fresh-looking one (finished_at
          // moved forward, resume_count incremented, the malformed evidence
          // replaced as though nothing had happened). That is precisely the
          // shape the live defect wrote onto receipt 27024ff2, and its honest
          // remedies are discharge or a fresh review.
          const carriedFault = territoryBindingFault(raw.content_evidence, existing.files);
          if (carriedFault.faulty) {
            process.stderr.write(bindingRefusal('the content evidence it already carries', carriedFault));
            return;
          }
          // FAIL-CLOSED GATE 4 — UNLOCKED. withLedgerLock proceeds UNLOCKED on
          // timeout, which the APPEND path has always accepted. A refresh must
          // not take that route: it rewrites an EXISTING entry, so an unlocked
          // whole-array write can clobber a concurrent commit-reviewed consume
          // — losing a whole receipt to save one refresh. Skip loudly instead
          // (same posture as the register lock's skip-never-unlocked rule,
          // decision 1e0ba0d0).
          if (!lockAcquired) {
            process.stderr.write(
              `H22: SKIPPING the review-receipt refresh for ${label} — the review-ledger lock timed out and a refresh is NEVER written unlocked (an unlocked whole-array rewrite can clobber a concurrent consume). The receipt keeps its previous finished_at, content evidence and observed files; this Stop's evidence is lost, which is bounded, rather than risking the receipt itself.\n`
            );
            return;
          }
          // TERRITORY-BINDING GUARD (fix round, HIGH — the measured live
          // defect's backstop). The evidence written by a refresh is built HERE
          // from `existing.files`, the receipt's own declared territory, so by
          // construction it describes the right path set. This checks that
          // construction instead of trusting it, because the failure it guards
          // is SILENT and its cost is a receipt that claims complete coverage of
          // a territory it never hashed — which is exactly what shipped: two
          // foreign paths bound, five declared paths unbound, status 'complete'.
          // THE PREDICATE, in one sentence: the evidence may name no path the
          // receipt does not declare, and — unless it discloses why (a
          // failure_reason, the V2-HASH-FAIL shape) — must name every declared
          // path within the hashing cap. A refusal here leaves the receipt
          // EXACTLY as it stands: no finished_at, no evidence, no resume_count,
          // because a refresh that cannot describe its own territory has nothing
          // trustworthy to contribute.
          const refreshEvidence = evidenceFor(existing.files);
          const builtFault = territoryBindingFault(refreshEvidence, existing.files);
          if (builtFault.faulty) {
            process.stderr.write(bindingRefusal('the content evidence built for this Stop', builtFault));
            return;
          }

          // RESUME COUNT — PRESERVE-AND-INCREMENT ONLY FROM A NON-NEGATIVE
          // INTEGER (fix round, LOW). The old expression folded EVERY unusable
          // value ('3', -1, 1.5, null, {}) into 0 and then wrote 1, silently
          // RESETTING a counter whose whole job is to say how many rounds this
          // receipt has accumulated. A value this hook never wrote is a fact
          // about the ledger worth one line, not something to swallow.
          // ABSENT IS NOT "ANYTHING ELSE": a receipt promoted before any resume
          // legitimately carries no resume_count at all, and that first refresh
          // is the ORDINARY path — silent, and 1 is the honest count. Only a
          // PRESENT-but-unusable value is disclosed, because only that is a
          // reset.
          const priorResume = raw.resume_count;
          const priorResumeUsable = Number.isInteger(priorResume) && priorResume >= 0;
          if (priorResume !== undefined && !priorResumeUsable) {
            process.stderr.write(
              `H22: the review receipt for ${label} carries an UNUSABLE resume_count (${JSON.stringify(priorResume)}) — this hook only ever writes a non-negative integer, so that value was not written by a refresh. It is RESET to 1 for this round rather than incremented from a value that means nothing; how many rounds preceded this one is unrecoverable from the receipt.\n`
            );
          }
          const nextResumeCount = priorResumeUsable ? priorResume + 1 : 1;

          // NEVER SILENTLY REBASELINE (fix round, HIGH). buildContentEvidence
          // hashes the DECLARED territory at CURRENT bytes, which on a FIRST
          // promotion is exactly right — the reviewer just finished reading that
          // territory. On a REFRESH it is not: the territory was hashed once
          // already, and any path whose bytes MOVED since then would be rebound
          // to the new sha with nothing whatsoever showing that this round looked
          // at it. commit-reviewed then finds receipt sha == index sha and stamps
          // a Reviewed-By-Agent trailer over bytes no review ever saw — the
          // resume path laundering unreviewed content through a real receipt.
          //
          // THE RULE AS IMPLEMENTED, stated at exactly the strength it holds: a
          // refresh may REBIND a path only on POSITIVE EVIDENCE that THIS AGENT
          // READ IT IN *THIS* ROUND — the path appears in the read set
          // observedToolPathsSince extracts from stdin.agent_transcript_path,
          // restricted to transcript entries stamped strictly AFTER the
          // receipt's PRIOR finished_at (read below, before this refresh
          // overwrites it) — that instant is when the PREVIOUS round ended, so
          // an entry sharing it belongs to that round, not this one.
          // Otherwise the PRIOR sha stands: the receipt keeps attesting the bytes
          // it actually reviewed, so the byte gate compares the index against
          // those and refuses, which is the outcome an unreviewed change must
          // produce. Unchanged paths keep their sha either way (rebinding a path
          // to the value it already has is not a rebaseline and is never
          // reported).
          //
          // THE ROUND BOUNDARY IS WHAT CLOSES THE LAUNDERING ROUTE (board
          // 181d11e7; the residual the previous round disclosed here). Scoped to
          // the whole transcript, this guard bit only when the reviewer had NEVER
          // read the path — so the common shape survived it: round one
          // legitimately reads P, P is edited afterwards by anyone, and a no-op
          // follow-up Stop finds P in the transcript's read set and rebinds it to
          // the edited bytes. With the boundary applied, that round-one read is
          // no longer evidence about round two, and the rebind is refused.
          // FAIL CLOSED ON AN UNUSABLE BOUNDARY: an unreadable transcript, a
          // missing/unparseable prior finished_at, or an entry carrying no usable
          // timestamp all yield NO round-scoped reads — never a permissive
          // fallback to the whole-transcript set (that set is exactly the claim
          // this fix stopped accepting).
          //
          // READS ONLY, NOT WRITES: a path the agent WROTE is a path whose bytes
          // it authored, and self-authored bytes are the one thing an independent
          // review receipt must never vouch for.
          // NO OBSERVED EVIDENCE AT ALL (observed === null — the transcript was
          // absent or unreadable, already disclosed above) is NOT permission: it
          // is the absence of the only proof this gate accepts, so every changed
          // path keeps its prior sha. That is bounded — the receipt stays exactly
          // as trustworthy as it was — where the alternative is unbounded.
          //
          // A PATH WITH NO PRIOR RECORDED SHA is treated the same way and its
          // fresh binding is DROPPED rather than kept: round one recorded no
          // claim about it (the file was absent then, or hashing failed), so
          // binding it now would turn a receipt the byte gate refuses for
          // incomplete coverage into one it accepts, on the strength of a round
          // that read nothing. prior_sha is recorded as null for that shape.
          //
          // SCOPE, stated so the next reader does not assume more: this compares
          // the BLOB MAP only. A path that was bound and is now ABSENT keeps the
          // fresh probe's absence, and status/absent_paths/truncation/
          // failure_reason are the fresh probe's throughout — an unbound path
          // already fails commit-reviewed's coverage rule, so no rebaseline can
          // buy a PASS through that door.
          const priorEvidence = isEvidenceObject(raw.content_evidence) ? raw.content_evidence : null;
          const priorBlobs = priorEvidence && isEvidenceObject(priorEvidence.blobs) ? priorEvidence.blobs : null;
          // THE PRIOR REVIEW-END INSTANT — read HERE, before the refresh
          // overwrites raw.finished_at below. It is the ONLY round boundary
          // available: everything this agent recorded after it belongs to the
          // round that is finishing now. A receipt with no usable finished_at
          // (hand-edited, or a v2 entry truncated in the ledger) yields no
          // boundary, so observedToolPathsSince returns null and NOTHING counts
          // as read this round — the fail-closed direction.
          const priorFinishedAt = typeof raw.finished_at === 'string' ? raw.finished_at : null;
          const observedThisRound = observedToolPathsSince(input.agent_transcript_path, input.cwd, priorFinishedAt);
          const observedReadsThisRound = new Set(observedThisRound ? observedThisRound.reads : []);
          const rebaselineRefused = [];
          const droppedUnbound = [];
          const nextEvidence = { ...refreshEvidence };
          if (isEvidenceObject(nextEvidence.blobs)) {
            const mergedBlobs = { ...nextEvidence.blobs };
            for (const [p, freshSha] of Object.entries(nextEvidence.blobs)) {
              const prior = priorBlobs ? priorBlobs[p] : undefined;
              const priorUsable = isUsableBlobSha(prior);
              // Hex spelling is not evidence — compare case-insensitively, the
              // same way receiptBlobEvidence compares two recorded shas.
              if (priorUsable && isUsableBlobSha(freshSha) && prior.toLowerCase() === freshSha.toLowerCase()) continue;
              if (observedReadsThisRound.has(p)) continue;
              rebaselineRefused.push({ path: p, prior_sha: priorUsable ? prior : null, current_sha: freshSha, round: nextResumeCount });
              if (priorUsable) mergedBlobs[p] = prior;
              else {
                delete mergedBlobs[p];
                droppedUnbound.push(p);
              }
            }
            nextEvidence.blobs = mergedBlobs;
          }
          // A DROPPED BINDING IS STILL A DECLARED PATH, AND MUST STAY NAMED
          // (security round 2, reviewer-correctness R2). The drop above removes a
          // fresh binding for a path the probe found PRESENT, so that path lands
          // in NEITHER blobs nor absent_paths — and evidence that silently omits a
          // declared path is exactly what GATE 3c above calls unrepairably
          // corrupt. Left unfixed, this hook would mint, one line earlier, the
          // very corruption it refuses to touch on the next Stop: the receipt
          // would be frozen out of every future refresh for a defect H22 itself
          // wrote. So the omission is DISCLOSED instead of silent —
          // failure_reason is the field the whole codebase already reads as "this
          // evidence does not cover everything, and here is why", and it is what
          // the binding predicate accepts as an account for a missing path.
          // NOT absent_paths: the file IS on disk, and an absence sentinel means
          // a reviewed DELETION to commit-reviewed — a false statement about the
          // tree, traded for a true one about the evidence.
          // STATUS FOLLOWS THE MERGED FACTS, by buildContentEvidence's OWN rule
          // (bound == declared -> complete; nothing bound -> unavailable; else
          // partial), so the receipt can never claim 'complete' coverage while a
          // declared path sits deliberately unbound. Downstream this reads as
          // partial/incomplete evidence: commit-reviewed refuses any commit that
          // touches the unbound path, which is the correct verdict for bytes no
          // review round is known to have seen.
          if (droppedUnbound.length > 0) {
            const note =
              `refused to rebaseline ${droppedUnbound.length} declared path(s) recording no prior sha, so they are deliberately left UNBOUND rather than bound to bytes this reviewer is not known to have read: ${droppedUnbound.join(', ')}`;
            nextEvidence.failure_reason = nextEvidence.failure_reason ? `${nextEvidence.failure_reason}; ${note}` : note;
            const boundCount = isEvidenceObject(nextEvidence.blobs) ? Object.keys(nextEvidence.blobs).length : 0;
            // builtFault.expected is the DECLARED, cap-sliced path set the
            // binding guard just checked this evidence against — one spelling of
            // "the declared territory" for both the guard and this verdict.
            nextEvidence.status = boundCount === builtFault.expected.length ? 'complete' : boundCount === 0 ? 'unavailable' : 'partial';
          }

          // FINISHED_AT IS NOT RENEWED FOR A ZERO-EVIDENCE RECEIPT (security
          // round 2, LOW). Every guard above is a statement ABOUT DECLARED PATHS
          // — the territory-binding predicate, the per-path rebaseline check, the
          // sha comparison — so on a receipt whose declared territory is EMPTY
          // they are all vacuously satisfied, and a bare no-op Stop could walk
          // finished_at forward forever. That timestamp is not decoration: it is
          // the horizon commit-reviewed's staleness advisory measures against
          // (12h), so an empty-territory receipt could be kept permanently
          // "fresh" while attesting precisely nothing, and the one signal a
          // reader has that it is old would never fire.
          // The rest of the refresh still lands (resume_count, observed_*,
          // content_evidence), so the resume is recorded — what is withheld is
          // only the claim that a review ENDED again just now.
          // EMPTINESS IS READ OFF THE SAME DECLARED SET the guards used, never a
          // second spelling of it.
          // THE ZERO-READ ROUND RULE (board 181d11e7). A follow-up Stop whose
          // ROUND-SCOPED read set is EMPTY reviewed nothing: no path in the
          // declared territory can be shown to have been looked at between the
          // receipt's prior finished_at and now. Such a Stop preserves the
          // receipt EXACTLY — every prior content_evidence entry AND the prior
          // finished_at — and records only that a resume was attempted
          // (resume_count, observed_*, any rebaseline refusals).
          // WHY BOTH HALVES: the per-path guard above already keeps the prior
          // SHAS, but the rest of nextEvidence (status, absent_paths,
          // failure_reason, truncated_of) comes from THIS Stop's fresh probe, so
          // writing it would still restate the round-one attestation in
          // round-two's words; and finished_at is the horizon commit-reviewed's
          // staleness advisory measures against (12h), so advancing it would let
          // a "thanks, done" Stop renew a receipt's freshness with nothing
          // reviewed. That renewal is the laundering route this rule closes.
          // EMPTY IS EMPTY WHATEVER THE CAUSE — an unobservable transcript, an
          // unusable prior finished_at, and a genuinely idle round are all "no
          // positive evidence", and this path never distinguishes them in the
          // permissive direction.
          //
          // THE PREDICATE IS TERRITORY-SCOPED, NOT "DID THIS AGENT READ ANY FILE
          // AT ALL" (security round 3, MEDIUM). Measured against the whole
          // round-scoped read set, the rule was satisfiable by ANY read the
          // reviewer happened to make: a receipt declaring ["src/pay.mjs"] whose
          // follow-up Stop opened README.md, or its own handoff draft, counted as
          // a round that "reviewed something" — finished_at advanced and the
          // evidence was replaced wholesale, renewing the 12h staleness horizon
          // on a round in which nothing in territory was looked at. That is
          // exactly the freshness renewal the paragraph above says this rule
          // exists to prevent, so the question it asks is the narrow one: did
          // this round read any DECLARED path? builtFault.expected is that set —
          // the same declared, cap-sliced territory the binding guard checked the
          // evidence against and the droppedUnbound verdict counts against, so
          // there is ONE spelling of "the declared territory" on this whole path.
          // (Cap-sliced cuts the safe way: a declared path beyond the hashing cap
          // is not in `expected`, so a read of it does not license a refresh.)
          // The per-path rebaseline guard above is unaffected and still decides
          // each blob individually — this predicate governs only finished_at and
          // the wholesale evidence replacement.
          const territoryReadThisRound = builtFault.expected.filter((p) => observedReadsThisRound.has(p));
          const zeroReadRound = territoryReadThisRound.length === 0;
          if (builtFault.expected.length === 0) {
            // An EMPTY declared territory makes zeroReadRound vacuously true
            // (nothing to intersect), so this branch withholds the content
            // evidence too — and must say so. The older wording promised
            // "content evidence recorded as usual" on a path that has never
            // written it since the zero-read rule landed, which is a false
            // action claim in the one place a reader checks what happened.
            process.stderr.write(
              `H22: NOT advancing finished_at on the review receipt for ${label} — its declared territory is EMPTY, so this refresh verified nothing about any file and there is no review-end instant to record. Renewing the timestamp would keep a zero-evidence receipt permanently inside commit-reviewed's staleness horizon while attesting nothing. The content evidence is left exactly as it stands for the same reason; what IS recorded is the attempted resume (resume_count now ${nextResumeCount}, observed files unioned).\n`
            );
          } else if (zeroReadRound) {
            process.stderr.write(
              `H22: NOT advancing finished_at and NOT replacing the content evidence on the review receipt for ${label} — NOTHING in this round's observed reads (transcript entries stamped after the receipt's previous finish time ${priorFinishedAt ?? '<none recorded>'}) shows this reviewer read any of its ${builtFault.expected.length} DECLARED path(s), so this Stop reviewed nothing in territory — reads OUTSIDE the declared territory are not evidence of a review round and never renew this receipt. The receipt keeps the evidence and the review-end instant it earned; only the attempted resume is recorded (resume_count now ${nextResumeCount}, observed files unioned). Re-dispatch a reviewer if this round of work needs a receipt.\n`
            );
          } else {
            raw.finished_at = finishedAt;
          }
          // LOAD-BEARING AND CURRENTLY UNTESTED — do not remove it as "dead".
          // Removing it leaves the ZERO-READ-ROUND pin green, but that is a TEST
          // GAP, not redundancy: an earlier conductor mutation read the green as
          // proof this guard was covered by the per-path rebaseline above, and
          // that reading was WRONG (caught in review, 2026-09-06).
          // WHY the per-path guard does not cover it: that loop iterates
          // Object.entries(nextEvidence.blobs) — only the paths the FRESH probe
          // found PRESENT. Everything else in nextEvidence is the fresh probe's,
          // unrepaired. So when a declared path's PRESENCE changed since the last
          // round, the per-path loop never sees it and this guard is the only
          // thing preserving the receipt. Concretely: declared path reviewed in
          // round 1, then DELETED by someone, then a no-op Stop fires. The fresh
          // probe returns blobs:{} and absent_paths:[that path], status
          // 'unavailable'. Without this guard the receipt is rewritten to attest
          // a reviewed DELETION (the exact shape review-ledger-entry.mjs:78-88
          // documents) and commit-reviewed's NO CONTENT EVIDENCE advisory is
          // suppressed — a no-op Stop laundering an unreviewed deletion into a
          // real receipt. Same shape for a path that REAPPEARS after being
          // absent, and for a transient hash failure downgrading status.
          // THE PIN THAT WOULD COVER THIS: zero-read round + declared path
          // deleted -> blobs keeps the prior sha AND absent_paths does not gain
          // the path. It does not exist yet; until it does, this line is
          // protected by review and by this comment alone.
          if (!zeroReadRound) raw.content_evidence = nextEvidence;
          if (observed) {
            const priorObserved = Array.isArray(raw.observed_files) ? raw.observed_files.filter((f) => typeof f === 'string' && f !== '') : [];
            raw.observed_files = [...new Set([...priorObserved, ...observed.reads, ...observed.writes])];
            // READS-ONLY SIBLING (board 4b59e6ff / review-ledger.mjs's
            // 'superseded' discharge class) — accumulated the same way
            // observed_files is, and from the SAME whole-transcript observation:
            // this field answers "what has this agent been observed to READ",
            // which is a fact about the agent, not about one round. The
            // round-scoped set above is the rebaseline gate's evidence and is
            // deliberately NOT what this records.
            const priorReads = Array.isArray(raw.observed_reads) ? raw.observed_reads.filter((f) => typeof f === 'string' && f !== '') : [];
            raw.observed_reads = [...new Set([...priorReads, ...observed.reads])];
            raw.observed_source = 'subagent-transcript';
            // Absent-unless-true, never flipped back to false: a truncated
            // first round stays truncated evidence even if the second round's
            // tail window happened to cover everything.
            if (observed.truncated) raw.observed_truncated = true;
          }
          raw.resume_count = nextResumeCount;
          // ACCUMULATED, never overwritten, and TOP-LEVEL beside observed_* /
          // resume_count rather than inside content_evidence: this is a fact
          // about the REFRESH, and content_evidence is replaced wholesale every
          // round, so a refusal recorded inside it would erase the previous
          // round's. Absent-unless-true, like observed_truncated — a refresh with
          // nothing refused never adds the key.
          if (rebaselineRefused.length > 0) {
            const priorRefused = Array.isArray(raw.rebaseline_refused) ? raw.rebaseline_refused : [];
            raw.rebaseline_refused = [...priorRefused, ...rebaselineRefused];
            process.stderr.write(
              `H22: REFUSED TO REBASELINE ${rebaselineRefused.length} path(s) on the review receipt for ${label} — their bytes moved since the recorded evidence and NOTHING in this round's observed reads shows this reviewer looked at them, so the receipt keeps the sha it actually reviewed: ${rebaselineRefused
                .map((r) => `${r.path} (recorded ${r.prior_sha ? r.prior_sha.slice(0, 12) : 'nothing'}, on disk ${String(r.current_sha).slice(0, 12)})`)
                .join(', ')}. The reviewed-bytes gate will refuse a commit carrying those bytes — re-dispatch a reviewer over them rather than waiving, unless the change is genuinely outside what was reviewed.\n`
            );
          }
          // NO FALSE ACTION CLAIM IN THE SUMMARY: the zero-read round above
          // withholds exactly the two things this sentence names first, so it
          // says what actually happened rather than restating the ordinary path.
          // The ordinary wording is unchanged.
          const refreshedWhat = zeroReadRound
            ? 'finished_at and content evidence PRESERVED (nothing was read this round), observed files updated'
            : 'finished_at, content evidence and observed files updated';
          process.stderr.write(
            `H22: REFRESHED the existing review receipt for ${label} in .sterling/review-ledger.json instead of promoting a duplicate — ${refreshedWhat} (observed files UNIONED with the earlier round's), resume_count now ${raw.resume_count}. entry_id, identity, reviewer model provenance and declared territory are unchanged.\n`
          );
        } else if (!departingIsReviewer) {
          // RESUME PATH ONLY: the decision read above found this dispatch's
          // receipt, and it is gone now — commit-reviewed consumed it between
          // the two reads (it DELETES a stamped receipt). There is no register
          // entry to promote from, and minting a fresh receipt from nothing
          // would manufacture evidence for a review whose receipt was already
          // legitimately spent. Skip, disclosed.
          process.stderr.write(
            `H22: the review receipt for agent_id '${input.agent_id}' (agent_type '${stopAgentType}') is no longer in .sterling/review-ledger.json — it was consumed (stamped onto a commit) between this Stop's lookup and its ledger write, and there is no register entry left to promote from. Nothing is written: a spent receipt is never re-minted. Dispatch a reviewer if this round of work needs its own receipt.\n`
          );
          return;
        } else {
          // THE ONE FRESH-MINT SHAPE THAT NEVER ATTEMPTED A STOP BINDING: a
          // receipt for this dispatch existed at the unlocked decision read (so
          // the binding was correctly skipped as a refresh) and was CONSUMED
          // before this lock was acquired, leaving a mint to perform with no
          // bound territory in hand. mintFilesSource is already 'unattributable'
          // by construction there — this says so out loud rather than letting a
          // receipt appear with an unspendable source and no reason given.
          if (departingIsReviewer && !stopBinding) {
            process.stderr.write(
              `H22: UNATTRIBUTABLE TERRITORY AT STOP — reviewer '${input.agent_id}' (agent_type '${stopAgentType}') is being minted fresh because its existing receipt was consumed (stamped onto a commit) while this ledger lock was being acquired, so no Stop-time territory binding was performed for it (decision edbaa38d binds only on a fresh mint). Its territory records the SubagentStart guess with source 'unattributable': scripts/commit-reviewed.mjs will never stamp or consume it.\n`
            );
          }
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
              // BOUND AT STOP, NOT COPIED FROM THE REGISTER (decision edbaa38d)
              // — see bindReviewerTerritoryAtStop and the mintFiles/
              // mintFilesSource computation above. The register entry's
              // Start-time attribution is PROVISIONAL for a reviewer, so what
              // this receipt attests is the territory declared in the brief this
              // agent provably received; every shape that could not be bound is
              // 'unattributable' and unspendable, never a copied guess.
              files: mintFiles,
              source: mintFilesSource,
              // Decision 8f137474's attribution label is UNCHANGED and still
              // copied verbatim from the register entry: it names which
              // Start-side positional case fired ('block'/'union') and is read
              // by nothing that judges spendability — territory.source carries
              // that verdict. Rewriting it here would silently restate the
              // Stop binding in a field whose existing meaning is the Start one.
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
            // OBSERVED_READS — THE READS-ONLY HALF, its OWN field beside
            // observed_files (board 181d11e7 / 4b59e6ff). observed_files above
            // is reads UNION WRITES and stays byte-identical for the consumers
            // that already read it; it cannot answer "what did this reviewer
            // READ", because a path the agent WROTE is a path whose bytes it
            // authored. scripts/review-ledger.mjs's 'superseded' discharge class
            // requires exactly this split and refuses to fall back to
            // observed_files for that reason. Same absent-when-unobserved
            // posture as its siblings, and covered by the SAME
            // `observed_truncated: true` marker (one transcript, one tail
            // window, one truncation fact — review-ledger.mjs already refuses a
            // superseded discharge on that exact key, so it is never spelled a
            // second way here).
            ...(observed
              ? {
                  observed_files: [...new Set([...observed.reads, ...observed.writes])],
                  observed_reads: [...new Set(observed.reads)],
                  observed_source: 'subagent-transcript',
                  ...(observed.truncated ? { observed_truncated: true } : {}),
                }
              : {}),
            // BUILT FOR THE TERRITORY THIS ENTRY RECORDS (`mintFiles`, the
            // Stop-bound territory a few lines above — no longer
            // `departing.files`, which is the provisional Start-time guess),
            // not for whatever territory the outside-the-lock
            // precompute happened to use: this branch is reachable when the
            // receipt found at decision time was consumed while the lock was
            // being acquired, and the precompute would then describe THAT
            // receipt's territory rather than this fresh mint's. A cache HIT in
            // every ordinary mint (the precompute used exactly these files).
            content_evidence: evidenceFor(mintFiles),
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
