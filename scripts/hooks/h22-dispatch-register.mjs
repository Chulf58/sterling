// scripts/hooks/h22-dispatch-register.mjs — R1 REBUILD FROM BLANK.
//
// INVARIANT: ONE hook, registered on SubagentStart and SubagentStop, switching
// on stdin.hook_event_name. SubagentStart derives this dispatch's territory
// from the brief the conductor's transcript shows it was given (declared
// REVIEW-TERRITORY wins over free-prose extraction) and appends a RegisterEntry
// via the owner module's registerStart (scripts/lib/dispatch-register.mjs) —
// the owner module is the ONE authority for the persisted shape, the lock and
// the duplicate rule; this file never re-implements any of that. SubagentStop
// marks the matching UNENDED entry ended via registerEnd (A1: marked, never
// deleted) and, for a reviewer-class agent_type, promotes ONE ReceiptV2 into
// the durable ledger (.sterling/review-ledger.json) under the ledger's own
// lock — a Stop whose agent_id has no unended entry mints nothing (A4: each
// review round has its own Start and its own receipt; nothing is ever
// refreshed in place). Every refusal/disclosure this file renders is built
// through scripts/lib/review-errors.mjs and carries a `[code]` token.
// DOES NOT GUARANTEE: that a positionally-attributed Start-time territory is
// safe for a reviewer-class receipt (see the Stop-time rebind below, which is
// what makes that safe); that an unattributed/unbound territory reflects
// anything the agent actually touched (observed_reads is corroboration only);
// that concurrent writers never lose a register append under a timed-out lock
// (bounded — see the owner module's own contract). NEVER A GATE: this hook is
// class 'advisory' in check-failclosed-boundary and must never call deny().
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readStdin, allow, warnNonBlocking, repoRel, loadConfig } from './lib/common.mjs';
import { lastDispatchBlocks, extractPathCandidates, parseReviewTerritory } from './lib/dispatch-prompt.mjs';
import { hasUnsuppressedMatch, escapeRe, extractGlobPrefixCandidates, isReviewerClass } from './lib/dispatch-advisory.mjs';
import { probeDirtyPaths, formatResidueLine, claimedResources } from './lib/dispatch-residue.mjs';
import { readFromStart } from './lib/transcript.mjs';
import { registerStart, registerEnd, readRegister, registerPath } from '../lib/dispatch-register.mjs';
import { withLedgerLock, readLedger, writeLedger } from './lib/review-ledger-entry.mjs';
import { refusal, disclosure, render } from '../lib/review-errors.mjs';
import { observedToolPaths } from './lib/observed-territory.mjs';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function loadExclusiveResourceNames(cwd) {
  try {
    const names = loadConfig(cwd)?.exclusive_resources;
    return Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function configuredReviewerModel(cwd) {
  try {
    const model = loadConfig(cwd)?.models?.reviewers?.model;
    return typeof model === 'string' && model !== '' ? model : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Identity + model provenance
// ---------------------------------------------------------------------------

function normIdentity(v) {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  return null;
}

function gitReceiptIdentity(cwd) {
  const git = (args) => {
    try {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000 });
      return r.status === 0 ? normIdentity(r.stdout) : null;
    } catch {
      return null;
    }
  };
  return { branch: git(['symbolic-ref', '--quiet', '--short', 'HEAD']), base_sha: git(['rev-parse', 'HEAD']) };
}

function familyFromModel(model) {
  if (typeof model !== 'string' || model === '') return 'unknown';
  if (/^claude-/.test(model)) return 'anthropic';
  if (/^gpt-/.test(model) || /^codex/.test(model)) return 'openai';
  return 'unknown';
}

function observedModelFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return null;
  let tail;
  try {
    tail = readFromStart(transcriptPath, 1024 * 1024);
  } catch {
    return null;
  }
  if (tail === null) return null;
  const lines = tail.text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== 'assistant') continue;
    const model = parsed.message?.model;
    if (typeof model === 'string' && model !== '') return model;
  }
  return null;
}

function resolveReviewerModel(departing, transcriptPath, agentTranscriptPath) {
  const preferred = typeof agentTranscriptPath === 'string' && agentTranscriptPath !== '' ? agentTranscriptPath : transcriptPath;
  const observed = observedModelFromTranscript(preferred);
  if (observed) return { model: observed, model_source: 'observed' };
  const configured = typeof departing?.configured_model === 'string' && departing.configured_model !== '' ? departing.configured_model : null;
  if (configured) return { model: configured, model_source: 'configured' };
  return { model: null, model_source: 'unknown' };
}

// ---------------------------------------------------------------------------
// Content evidence — Stop-time WORKTREE blobs for every declared path
// ---------------------------------------------------------------------------

const REVIEWED_BLOBS_CAP = 64;
function buildContentEvidence(cwd, files) {
  const uniqueFiles = Array.isArray(files) ? [...new Set(files.filter((f) => typeof f === 'string' && f !== ''))] : [];
  if (uniqueFiles.length === 0) return { basis: 'stop-time-worktree-snapshot', status: 'complete', blobs: {}, absent_paths: [] };
  const truncated = uniqueFiles.length > REVIEWED_BLOBS_CAP;
  const paths = uniqueFiles.slice(0, REVIEWED_BLOBS_CAP);
  const present = [];
  const absent = [];
  for (const p of paths) {
    try {
      if (statSync(`${cwd}/${p}`).isFile()) present.push(p);
      else absent.push(p);
    } catch {
      absent.push(p);
    }
  }
  let blobs = {};
  let failureReason;
  let presentUnhashed = [...present];
  if (present.length > 0) {
    try {
      const r = spawnSync('git', ['hash-object', '--', ...present], { cwd, encoding: 'utf8', timeout: 10_000 });
      if (r && !r.error && r.status === 0) {
        const shas = (r.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/i.test(l));
        if (shas.length === present.length) {
          present.forEach((p, i) => { blobs[p] = shas[i]; });
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
  // INDEX_BLOBS (A8): DIAGNOSTIC ONLY — spend compares the staged INDEX
  // against `blobs` (the worktree at Stop), never the reverse. Recorded ONLY
  // for a path where `git ls-files -s` (the index) disagrees with the
  // worktree blob already hashed above; an untracked path or one where index
  // and worktree agree gets no entry at all — recording it everywhere would
  // make the diagnostic indistinguishable from the evidence it exists beside.
  let indexBlobs;
  if (Object.keys(blobs).length > 0) {
    try {
      const r = spawnSync('git', ['ls-files', '-s', '--', ...Object.keys(blobs)], { cwd, encoding: 'utf8', timeout: 10_000 });
      if (r && !r.error && r.status === 0) {
        for (const line of (r.stdout ?? '').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const tab = trimmed.indexOf('\t');
          if (tab === -1) continue;
          const meta = trimmed.slice(0, tab).split(/\s+/);
          const path = trimmed.slice(tab + 1);
          const sha = meta[1];
          if (isUsableIndexSha(sha) && blobs[path] && blobs[path] !== sha) {
            if (!indexBlobs) indexBlobs = {};
            indexBlobs[path] = sha;
          }
        }
      }
    } catch {
      // best-effort — a failed index probe leaves index_blobs absent; blobs (the evidence) is unaffected
    }
  }
  const noEvidenceCount = absent.length + presentUnhashed.length;
  const status = noEvidenceCount === 0 ? 'complete' : noEvidenceCount === paths.length ? 'unavailable' : 'partial';
  const result = { basis: 'stop-time-worktree-snapshot', status, blobs, absent_paths: absent };
  if (indexBlobs) result.index_blobs = indexBlobs;
  if (truncated) {
    result.truncated = true;
    result.truncated_of = uniqueFiles.length;
  }
  if (failureReason) result.failure_reason = failureReason;
  return result;
}

function isUsableIndexSha(v) {
  return typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);
}

// ---------------------------------------------------------------------------
// Per-block attribution (Start-side; unchanged positional rules)
// ---------------------------------------------------------------------------

const MAX_WALK_BACK = 20;
const SAFE_ATTRIBUTION_CASE = 'current-message-unique';

function attributeBlocks(transcriptPath, agentType) {
  const lastBlocks = lastDispatchBlocks(transcriptPath, 0);
  if (typeof agentType !== 'string' || agentType === '') {
    return {
      blocks: lastBlocks,
      attribution: 'union',
      positional: { safe: false, case: 'no-agent-type', detail: 'this SubagentStart carried no usable agent_type, so no block could be type-matched at all' },
    };
  }
  let matched = lastBlocks.filter((b) => typeof b.subagent_type === 'string' && b.subagent_type === agentType);
  if (matched.length === 1) {
    return { blocks: matched, attribution: 'block', positional: { safe: true, case: SAFE_ATTRIBUTION_CASE, detail: `exactly one '${agentType}' block in the current dispatching message` } };
  }
  if (matched.length > 1) {
    return {
      blocks: matched,
      attribution: 'union',
      positional: { safe: false, case: 'same-type-siblings', detail: `${matched.length} same-type ('${agentType}') blocks sit in the current dispatching message and no stdin field says WHICH one this spawn is` },
    };
  }
  for (let skip = 1; skip <= MAX_WALK_BACK; skip++) {
    const blocks = lastDispatchBlocks(transcriptPath, skip);
    if (!blocks.length) continue;
    matched = blocks.filter((b) => typeof b.subagent_type === 'string' && b.subagent_type === agentType);
    if (matched.length === 1) {
      return {
        blocks: matched,
        attribution: 'block',
        positional: { safe: false, case: 'walk-back', detail: `no '${agentType}' block in the current dispatching message; the bounded backward walk matched one ${skip} dispatching message(s) earlier` },
      };
    }
    if (matched.length > 1) {
      return {
        blocks: matched,
        attribution: 'union',
        positional: { safe: false, case: 'walk-back', detail: `no '${agentType}' block in the current dispatching message; the bounded backward walk matched ${matched.length} same-type blocks ${skip} dispatching message(s) earlier` },
      };
    }
  }
  return {
    blocks: lastBlocks,
    attribution: 'union',
    positional: { safe: false, case: 'terminal-union', detail: `no '${agentType}' block was found in the current dispatching message or anywhere in the bounded backward walk, so territory fell back to the union of the last message's blocks` },
  };
}

function candidatesFromBlocks(blocks) {
  return [...new Set(blocks.flatMap((b) => extractPathCandidates(b.prompt)))];
}

function normalizeRegisterPaths(cands, cwd) {
  return [...new Set(cands.map((c) => repoRel(c, cwd)).filter(Boolean))].filter(
    (r) => r !== '.git' && !r.startsWith('.git/') && !r.startsWith('.sterling/') && !r.startsWith('sterling/') && !r.startsWith('git/')
  );
}

// Aggregates declared-territory across the attributed blocks. `malformed`
// carries every present-but-invalid declaration (for the Start-side advisory);
// `anyPresent` says whether ANY block carried a REVIEW-TERRITORY line at all
// (missing vs malformed are different codes, A11).
function resolveTerritory(blocks) {
  const parsed = blocks.map((b) => ({ block: b, decl: parseReviewTerritory(b.prompt) }));
  const declared = parsed.filter((p) => p.decl.present && p.decl.valid);
  const malformed = parsed.filter((p) => p.decl.present && !p.decl.valid);
  const anyPresent = parsed.some((p) => p.decl.present);
  if (declared.length > 0) {
    return { candidates: [...new Set(declared.flatMap((p) => p.decl.files))], files_source: 'review-territory', malformed, anyPresent };
  }
  return { candidates: candidatesFromBlocks(blocks), files_source: 'free-prose-fallback', malformed, anyPresent };
}

// ---------------------------------------------------------------------------
// Claimed territory (write-side negation guard; territory EXAMINED vs CLAIMED)
// ---------------------------------------------------------------------------

function claimedFromBlocks(blocks) {
  return [
    ...new Set(
      blocks.flatMap((b) =>
        extractPathCandidates(b.prompt).filter((raw) => hasUnsuppressedMatch(b.prompt, new RegExp(escapeRe(raw)), { checkSubjectVerb: false }))
      )
    ),
  ];
}

function globPrefixesFromBlocks(blocks) {
  return [
    ...new Set(
      blocks.flatMap((b) =>
        extractGlobPrefixCandidates(b.prompt).filter((prefix) => hasUnsuppressedMatch(b.prompt, new RegExp(escapeRe(`${prefix}**`)), { checkSubjectVerb: false }))
      )
    ),
  ];
}

// ===========================================================================
// STOP-TIME REVIEWER TERRITORY BINDING (decision edbaa38d) — kept from the
// pre-rebuild mechanism verbatim in substance: the FIRST record of the child
// transcript is the brief AS DELIVERED; the .meta.json sidecar's toolUseId
// locates the spawning block in the parent BY KNOWN ID; agentId on that first
// record ties the transcript to THIS agent (not a same-typed sibling); every
// abnormal shape fails closed to unattributable. Attempted ONLY when
// input.agent_transcript_path is a non-empty string — its absence means no
// Stop-bind was attempted at all (the caller falls back to the register's own
// Start-time territory), never a fail-closed verdict about a check that never
// ran.
// ===========================================================================

const CHILD_SCAN_BYTES = 64 * 1024 * 1024;
const PARENT_SCAN_BYTES = 64 * 1024 * 1024;

function childBriefFromTranscript(childPath) {
  const read = readFromStart(childPath, CHILD_SCAN_BYTES);
  if (read === null) return { ok: false, reason: 'child-transcript-missing', detail: `no file at '${childPath}'` };
  const nl = read.text.indexOf('\n');
  if (nl === -1 && !read.complete) {
    return { ok: false, reason: 'child-first-record-truncated', detail: `the child transcript's first line exceeds the ${CHILD_SCAN_BYTES}-byte read window` };
  }
  const firstLine = (nl === -1 ? read.text : read.text.slice(0, nl)).trim();
  if (firstLine === '') return { ok: false, reason: 'child-transcript-empty', detail: `'${childPath}' has no first record` };
  let record;
  try {
    record = JSON.parse(firstLine);
  } catch {
    return { ok: false, reason: 'child-first-record-unparseable', detail: 'the first line of the child transcript is not JSON' };
  }
  if (!record || record.type !== 'user') {
    return { ok: false, reason: 'child-first-record-not-user', detail: `first record type is ${JSON.stringify(record?.type)}, not 'user'` };
  }
  const content = record.message?.content;
  if (typeof content !== 'string') {
    return { ok: false, reason: 'child-first-record-content-not-string', detail: `first record message.content is ${typeof content}` };
  }
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

function sidecarForChildTranscript(childPath) {
  if (!childPath.endsWith('.jsonl')) {
    return { ok: false, reason: 'sidecar-path-underivable', detail: `agent_transcript_path '${childPath}' does not end in .jsonl` };
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
  if (meta.spawnDepth !== 1) {
    return { ok: false, reason: 'sidecar-spawn-depth', detail: `sidecar spawnDepth is ${JSON.stringify(meta.spawnDepth)}, not 1` };
  }
  return { ok: true, meta, sidecarPath };
}

function findParentToolUseBlock(parentPath, toolUseId) {
  if (typeof parentPath !== 'string' || parentPath === '') {
    return { ok: false, reason: 'parent-transcript-path-absent', detail: 'stdin carried no transcript_path' };
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
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    const block = content.find((b) => b?.type === 'tool_use' && b.id === toolUseId);
    if (block) return { ok: true, block };
  }
  if (!read.complete) {
    return { ok: false, reason: 'parent-scan-truncated', detail: `the parent transcript exceeds the ${PARENT_SCAN_BYTES}-byte scan window` };
  }
  return { ok: false, reason: 'tool-use-id-absent-from-parent', detail: `no tool_use block with id '${toolUseId}' anywhere in the parent transcript` };
}

function bindReviewerTerritoryAtStop(input) {
  const childPath = input.agent_transcript_path;
  const brief = childBriefFromTranscript(childPath);
  if (!brief.ok) return { bound: false, reason: brief.reason, detail: brief.detail };
  if (typeof input.agent_id !== 'string' || input.agent_id === '' || typeof brief.agentId !== 'string' || brief.agentId !== input.agent_id) {
    return {
      bound: false,
      reason: 'child-transcript-agent-mismatch',
      detail: `the child transcript's first record carries agentId ${JSON.stringify(brief.agentId)}, which is not the stopping agent's stdin agent_id ${JSON.stringify(input.agent_id)}`,
    };
  }
  // A4 (measured 2026-09-07): resuming a reviewer FIRES SubagentStart again,
  // so a round-2-or-later child transcript carrying an appended continuation
  // record is not itself a fail-closed shape — the register's unended-entry
  // gate (this function's only caller) is what decides whether THIS round
  // may mint at all. Only the FIRST record is ever read as the brief
  // (childBriefFromTranscript above), so a later continuation record can
  // never re-derive territory, with no need to count or refuse on it here.
  const sidecar = sidecarForChildTranscript(childPath);
  if (!sidecar.ok) return { bound: false, reason: sidecar.reason, detail: sidecar.detail };
  if (sidecar.meta.agentType !== input.agent_type) {
    return { bound: false, reason: 'agent-type-mismatch', detail: `sidecar agentType ${JSON.stringify(sidecar.meta.agentType)} does not equal stdin agent_type ${JSON.stringify(input.agent_type)}` };
  }
  const located = findParentToolUseBlock(input.transcript_path, sidecar.meta.toolUseId);
  if (!located.ok) return { bound: false, reason: located.reason, detail: located.detail };
  if (located.block.input?.prompt !== brief.brief) {
    return { bound: false, reason: 'prompt-mismatch', detail: `the parent block '${sidecar.meta.toolUseId}' prompt is not byte-identical to the child's first record` };
  }
  const { candidates, files_source, malformed } = resolveTerritory([{ subagent_type: sidecar.meta.agentType, prompt: brief.brief }]);
  return { bound: true, files: normalizeRegisterPaths(candidates, input.cwd), files_source, malformed };
}

// ---------------------------------------------------------------------------
// promoteAtStop — builds ONE ReceiptV2 for the departing (unended) entry.
// ---------------------------------------------------------------------------

function promoteAtStop(departing, input) {
  const lines = [];
  // TERRITORY EXAMINED (departing.files, the register's own declared/examined
  // set) is ALWAYS what `territory.files` carries — 'unattributable' is a
  // statement about TRUST in the POSITIONAL BINDING, never an erasure of what
  // was examined (mirrors the Start-side REVIEWER-R1/R2/R3 unattributable
  // entries, which likewise keep real `files`). Only a SUCCESSFUL Stop-bind
  // replaces it with the child-transcript-derived set.
  let territoryFiles = Array.isArray(departing.files) ? departing.files : [];
  let territorySource = departing.files_source ?? 'free-prose-fallback';
  if (typeof input.agent_transcript_path !== 'string' || input.agent_transcript_path === '') {
    // No Stop-bind attempt was possible at all — the register's Start-time
    // positional guess is provisional only (decision edbaa38d) and is never
    // promoted as though it were bound evidence.
    territorySource = 'unattributable';
  } else {
    const bind = bindReviewerTerritoryAtStop(input);
    if (bind.bound) {
      territoryFiles = bind.files;
      territorySource = bind.files_source;
    } else {
      territorySource = 'unattributable';
      lines.push(
        render(
          disclosure(
            'receipt_unattributable',
            { reason: bind.reason },
            `H22: reviewer-class Stop for '${input.agent_id}' bound closed to unattributable (${bind.reason}): ${bind.detail}`
          )
        )
      );
    }
  }

  const contentEvidence = buildContentEvidence(input.cwd, territoryFiles);
  const observed = observedToolPaths(input.agent_transcript_path, input.cwd);
  const { branch, base_sha } = gitReceiptIdentity(input.cwd);
  const { model, model_source } = resolveReviewerModel(departing, input.transcript_path, input.agent_transcript_path);

  // REFUSE RATHER THAN WRITE AN UNPARSEABLE RECEIPT (correctness review): the
  // shape owner's parseReceipt (scripts/hooks/lib/review-ledger-entry.mjs)
  // REQUIRES reviewer.agent_type to be a trailer-safe string — it is stamped
  // verbatim into the Reviewed-By-Agent commit trailer — and refuses the
  // WHOLE entry as ledger_entry_malformed otherwise. A null/invalid
  // agent_type here must never reach writeLedger as a receipt that would
  // come back unparseable on the very next read.
  const AGENT_TYPE_PATTERN = /^[A-Za-z0-9_-]+$/; // mirrors the owner's own (un-exported) pattern
  const reviewerAgentType = departing.agent_type ?? input.agent_type ?? null;
  if (typeof reviewerAgentType !== 'string' || !AGENT_TYPE_PATTERN.test(reviewerAgentType)) {
    return {
      receipt: null,
      lines: [
        ...lines,
        render(
          disclosure(
            'ledger_entry_malformed',
            { field: 'reviewer.agent_type', agent_id: input.agent_id },
            `H22: refused to promote a receipt for '${input.agent_id}' — reviewer.agent_type is ${JSON.stringify(reviewerAgentType)}, not a trailer-safe token; the entry would parse as ledger_entry_malformed on the very next read`
          )
        ),
      ],
    };
  }

  const receipt = {
    schema_version: 2,
    entry_id: randomUUID(),
    kind: 'roster_receipt',
    status: 'active',
    started_at: typeof departing.at === 'string' ? departing.at : new Date().toISOString(),
    finished_at: new Date().toISOString(),
    reviewer: { agent_type: reviewerAgentType, model, model_family: familyFromModel(model), model_source },
    identity: { session_id: normIdentity(input.session_id), branch, base_sha, agent_id: input.agent_id },
    // A legacy register entry with NO attribution key promotes to a receipt
    // with NO attribution key either — the field is copied, never fabricated
    // (scripts/tests/h22-review-territory.test.mjs T6a/T6b CONTROL pair).
    territory: {
      files: territoryFiles,
      source: territorySource,
      ...(typeof departing.attribution === 'string' ? { attribution: departing.attribution } : {}),
    },
    content_evidence: contentEvidence,
    disposition: null,
  };
  if (observed) {
    receipt.observed_files = [...new Set([...(observed.reads ?? []), ...(observed.writes ?? [])])];
    receipt.observed_reads = observed.reads ?? [];
    receipt.observed_source = 'subagent-transcript';
    if (observed.truncated) receipt.observed_truncated = true;
  }
  return { receipt, lines };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const input = readStdin();

try {
  if (!existsSync(`${input.cwd}/.sterling/config.json`)) allow();
  // The owner-mkdir lock's directory sits under .sterling/transient/, whose
  // own mkdir is deliberately NON-recursive (mkdir-exclusivity IS the lock
  // primitive) — its parent must already exist before any registerStart/
  // registerEnd call, which a fresh project (no register written yet) cannot
  // guarantee on its own.
  mkdirSync(join(input.cwd, '.sterling', 'transient'), { recursive: true });

  const event = input.hook_event_name;
  const consequence =
    event === 'SubagentStop'
      ? `the entry for '${input.agent_id}' stays live and over-defers H10's file duties until the lease expires or H1's next session-boundary wipe`
      : `this dispatch is absent from the register, so H10 will not defer the duties for the files it owns`;
  if (event !== 'SubagentStart' && event !== 'SubagentStop') {
    warnNonBlocking(`H22: unexpected hook_event_name '${event}' — no entry was added or removed; the register cannot track dispatches until this event name is handled`);
  }
  if (!input.agent_id) {
    warnNonBlocking(`H22: ${event} carried no agent_id (entries are keyed by agent_id) — ${consequence}`);
  }

  const lines = [];

  if (event === 'SubagentStart') {
    const { blocks: matchedBlocks, attribution, positional } = attributeBlocks(input.transcript_path, input.agent_type);
    const territory = resolveTerritory(matchedBlocks);
    let filesSource = territory.files_source;
    const reviewerStart = typeof input.agent_type === 'string' && isReviewerClass(input.agent_type);

    // A11: a PRESENT-but-unusable declaration is disclosed for EVERY class
    // (decision 8f137474 §5 — the malformed-fallback warning was never
    // reviewer-scoped); only the NO-DECLARATION-AT-ALL absence warning below
    // is reviewer-only (it is about receipt risk, which only a reviewer-class
    // dispatch carries).
    for (const m of territory.malformed) {
      lines.push(render(disclosure('territory_declaration_malformed', { line: m.decl.raw }, `H22: malformed REVIEW-TERRITORY declaration ignored, falling back to free-prose: ${m.decl.raw}`)));
    }
    if (reviewerStart) {
      // Fires whenever the AGGREGATE result is not review-territory —
      // whether NOTHING was declared at all, or something was declared but
      // fell back after failing to parse (h22-observed-territory.test.mjs
      // P2-malformed-marker): either way this reviewer-class dispatch is
      // relying on free-prose extraction, which is the receipt risk this
      // warning names. The per-line territory_declaration_malformed above
      // already named the specific bad content; this is the separate
      // "so now what" statement about the dispatch as a whole.
      if (territory.files_source !== 'review-territory') {
        lines.push(
          render(disclosure('territory_declaration_missing', {}, `H22: reviewer-class dispatch '${input.agent_id}' (${input.agent_type}) has no valid REVIEW-TERRITORY declaration in its attributed dispatch block(s)`))
        );
      }
      if (!positional.safe) {
        filesSource = 'unattributable';
        lines.push(
          render(
            disclosure(
              'receipt_unattributable',
              { case: positional.case },
              `H22: UNATTRIBUTABLE TERRITORY — reviewer-class dispatch '${input.agent_id}' (${input.agent_type}) could not be bound to a dispatch block by position [${positional.case}]: ${positional.detail}`
            )
          )
        );
      }
    }

    const files = normalizeRegisterPaths(territory.candidates, input.cwd);
    const claimedFiles = normalizeRegisterPaths(claimedFromBlocks(matchedBlocks), input.cwd);
    const claimedGlobPrefixes = normalizeRegisterPaths(globPrefixesFromBlocks(matchedBlocks), input.cwd);

    const configuredResourceNames = loadExclusiveResourceNames(input.cwd);
    const claimed =
      attribution === 'block' && configuredResourceNames.length
        ? claimedResources(matchedBlocks.map((b) => b.prompt).join('\n'), configuredResourceNames)
        : [];

    // SPEC B (6): "you do not hold <resource>" — read BEFORE this spawn's own
    // entry exists, so a sole/first claimant never sees itself.
    if (configuredResourceNames.length) {
      const existing = readRegister(input.cwd);
      if (existing.availability === 'ok') {
        for (const name of configuredResourceNames) {
          const holder = existing.entries.find((e) => !e.ended && Array.isArray(e.exclusive_resources) && e.exclusive_resources.includes(name));
          if (holder) lines.push(`You do not hold '${name}' — it is currently held by ${holder.agent_type}:${holder.agent_id}.`);
        }
      }
    }

    const entry = {
      agent_id: input.agent_id,
      agent_type: typeof input.agent_type === 'string' ? input.agent_type : null,
      session_id: input.session_id,
      files,
      files_source: filesSource,
      claimed_files: claimedFiles,
      claimed_glob_prefixes: claimedGlobPrefixes,
      attribution,
      at: new Date().toISOString(),
    };
    if (claimed.length) entry.exclusive_resources = claimed;
    if (reviewerStart) entry.configured_model = configuredReviewerModel(input.cwd);

    // A24 (pin review MEDIUM): a CORRUPT register is read-only — this Start
    // writes NOTHING and never resets it to a fresh array. The owner's
    // registerStart (scripts/lib/dispatch-register.mjs) treats any
    // non-'ok' availability as an empty list and writes THAT back, which
    // would silently destroy the corruption signal every availability pin
    // depends on (R1-A49/A85/A86/A66 all read 'corrupt' straight off the
    // bytes on disk) and discard whatever unended rounds the file held — so
    // this hook never calls registerStart at all when the register is
    // already corrupt, checked here rather than relying on the owner to
    // refuse internally.
    if (readRegister(input.cwd).availability === 'corrupt') {
      lines.push(
        render(
          disclosure(
            'register_unavailable',
            { path: registerPath(input.cwd), reason: 'corrupt' },
            `H22: dispatch register unavailable (corrupt) at ${registerPath(input.cwd)} — this Start writes nothing; resetting it would destroy the corruption signal every availability pin depends on and silently discard any unended round the file held`
          )
        )
      );
    } else {
      try {
        await registerStart(input.cwd, entry);
      } catch (e) {
        if (e?.code === 'register_agent_id_duplicate' || e?.code === 'register_lock_held') {
          lines.push(render(e));
        } else {
          throw e;
        }
      }
    }
  } else if (event === 'SubagentStop') {
    // SELECT + MARK UNDER THE SAME LOCK HOLD: registerEnd returns {found,
    // entry} — the exact entry it just ended, through the ONE parser — so
    // this hook never re-reads the register outside the lock and promotes a
    // snapshot that may already have moved on. Codex round-2 HIGH: the prior
    // shape fell back to an UNLOCKED read on register_lock_held and still
    // promoted from it — the register stayed unended, so a LATER Stop could
    // end and promote the SAME round again (two receipts for one review).
    // There is no lock-held fallback anymore: this Stop writes NOTHING (no
    // receipt, no register mutation) and disclosed-degrades instead —
    // promotion happens ONLY from registerEnd's own returned {found:true}.
    let departing;
    try {
      const ended = await registerEnd(input.cwd, input.agent_id, 'subagent-stop', { sessionId: input.session_id });
      departing = ended.found ? ended.entry : undefined;
    } catch (e) {
      if (e?.code === 'register_lock_held') {
        lines.push(
          render(
            disclosure(
              'register_lock_held',
              e.facts ?? {},
              `H22: could not mark this round ended — the register lock is held at ${e.facts?.lock_dir ?? '(unknown)'}: coordination, not evidence — remove by hand only once no writer runs. This Stop writes nothing (no receipt, no register change) so no round is ever promoted twice; the mark and any promotion happen on the next Stop of this round, or re-run the round if none follows.`
            )
          )
        );
        departing = undefined;
      } else {
        throw e;
      }
    }

    // KILL-DETECTION RESIDUE — detectable immediately at Stop, no TTL wait:
    // dirty declared files + an empty/absent last_assistant_message.
    if (departing) {
      const lastMsg = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
      if (lastMsg === '') {
        const probe = probeDirtyPaths(input.cwd, departing.files);
        const dirty = Array.isArray(probe.dirty) ? probe.dirty : [];
        if (!(probe.verified && dirty.length === 0)) {
          lines.push(render(disclosure('dispatch_residue', {}, formatResidueLine(departing, dirty, { verified: probe.verified, reason: probe.reason }))));
        }
      }
    }

    // The REGISTER ENTRY's own agent_type is the identity of record for "is
    // this dispatch reviewer-class" — it was captured at Start, when the
    // platform reliably supplies it; stdin.agent_type at Stop is used only for
    // the Stop-bind sidecar consistency check inside promoteAtStop, never for
    // this gate (scripts/tests/h22-review-territory.test.mjs T5/T5b omit it
    // from stdin entirely and still expect promotion to fire).
    if (departing && typeof departing.agent_type === 'string' && isReviewerClass(departing.agent_type)) {
      const { receipt, lines: promotionLines } = promoteAtStop(departing, input);
      lines.push(...promotionLines);
      if (receipt) {
        try {
          await withLedgerLock(input.cwd, () => {
            const ledgerState = readLedger(input.cwd);
            if (ledgerState.availability === 'corrupt') {
              lines.push(render(disclosure('ledger_corrupt', {}, 'H22: a corrupt review ledger stops this promotion — no write, bytes left untouched')));
              return;
            }
            // rawEntries (the shape owner's exact on-disk array) — never a
            // second JSON.parse(ledgerState.raw): ONE reader for the ledger,
            // and rawEntries already preserves every legacy/malformed entry's
            // original bytes untouched.
            const rawArr = ledgerState.rawEntries;
            rawArr.push(receipt);
            writeLedger(input.cwd, rawArr);
          });
        } catch (e) {
          if (e?.code === 'ledger_lock_held') lines.push(render(e));
          else throw e;
        }
      }
    }
  }

  // Advisory lines go to stderr (this hook's established channel for the
  // conductor/agent-facing disclosures pinned by the territory/attribution
  // suites) — never the stdout envelope, which stays reserved for a future
  // structured payload. allow() always follows: this hook never denies.
  if (lines.length) process.stderr.write(lines.join('\n') + '\n');
  allow();
} catch (e) {
  warnNonBlocking(`H22: internal failure (${(e && e.message) || e}) — this fire tracked nothing; the register/ledger are left exactly as they were`);
}
