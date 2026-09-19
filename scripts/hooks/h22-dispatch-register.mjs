// scripts/hooks/h22-dispatch-register.mjs — R1 REBUILD, THEN EXTENDED with the
// dispatch STATE MACHINE (decision `dispatch-state-machine-pre-slot-post-
// binding-locked-start-resolution-replaces-transcript-attribution`).
//
// INVARIANT: ONE hook, registered on PreToolUse/PostToolUse/PostToolUseFailure
// (matcher Task|Agent — recording dispatch-state only, never gating) and on
// SubagentStart/SubagentStop, switching on stdin.hook_event_name. The Pre/Post/
// Failure branches delegate entirely to scripts/lib/dispatch-register.mjs's
// recordDispatchPre/Post/Failure. SubagentStart resolves ITS OWN territory
// through that module's resolveAndRegisterStart (own binding, else resume,
// else exact-by-construction derivation, else unattributable — NEVER the
// parent transcript, which is measurably lagged) and appends a RegisterEntry
// in the same call; the owner module is the ONE authority for the persisted
// shape, the lock and the duplicate rule; this file never re-implements any of
// that. SubagentStop closes the register round and the dispatch-state record
// together via finishDispatchAndRegisterEnd (A1: marked, never deleted). The
// review-ledger receipt promotion this hook used to perform at Stop (Reviewed-
// By-Agent trailer / commit-review mechanism) was DELETED under decision
// `sterling-claude-code-scale-down-boundary` (2ad87dd1) — this hook now stays
// minimal dispatch bookkeeping for child-agent knowledge staging: the
// register and its Start-time territory declaration/attribution advisories
// survive, the Stop-time ledger write does not.
// Every refusal/disclosure this file renders is built through
// scripts/lib/review-errors.mjs and carries a `[code]` token.
// DOES NOT GUARANTEE: that an unattributed/unbound territory reflects
// anything the agent actually touched (observed_reads is corroboration only);
// that concurrent writers never lose a register append under a timed-out lock
// (bounded — see the owner module's own contract); that a Pre-denied dispatch
// (H8/H27) ever clears its orphaned pending dispatch-state record before the
// session boundary. NEVER A GATE: this hook is advisory and must never call
// deny().
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking, repoRel, loadConfig } from './lib/common.mjs';
import { extractPathCandidates, parseReviewTerritory } from './lib/dispatch-prompt.mjs';
import { hasUnsuppressedMatch, escapeRe, extractGlobPrefixCandidates, isReviewerClass } from './lib/dispatch-advisory.mjs';
import { probeDirtyPaths, formatResidueLine, claimedResources } from './lib/dispatch-residue.mjs';
import {
  registerStart,
  registerEnd,
  readRegister,
  registerPath,
  recordDispatchPre,
  recordDispatchPost,
  recordDispatchFailure,
  resolveAndRegisterStart,
  finishDispatchAndRegisterEnd,
} from '../lib/dispatch-register.mjs';
import { refusal, disclosure, render } from '../lib/review-errors.mjs';

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

// ---------------------------------------------------------------------------
// Territory helpers — operate on the SINGLE {subagent_type, prompt} block (if
// any) the dispatch-state resolution attributes to this Start. The Start-side
// POSITIONAL WALK-BACK FUNCTION that used to read the parent transcript is
// DELETED — resolveAndRegisterStart's resolution is now the sole source of
// "which prompt is mine" (decision dispatch-state-machine-pre-slot-post-
// binding-locked-start-resolution-replaces-transcript-attribution).
// ---------------------------------------------------------------------------

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

// SubagentStop dispatch-state fallback lookup key: when the primary agent_id
// match inside finishDispatchAndRegisterEnd misses, it falls back to the
// child transcript's .meta.json sidecar's toolUseId (survives the deleted
// reviewer-territory Stop-bind — this is a GENERAL dispatch-state matching
// aid, not receipt-specific). Best-effort: any abnormal shape (missing/
// unparseable sidecar, non-.jsonl path) degrades to {ok:false} and the caller
// falls through to the primary match having found nothing extra.
function sidecarForChildTranscript(childPath) {
  if (!childPath.endsWith('.jsonl')) return { ok: false };
  const sidecarPath = `${childPath.slice(0, -'.jsonl'.length)}.meta.json`;
  if (!existsSync(sidecarPath)) return { ok: false };
  let meta;
  try {
    meta = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  } catch {
    return { ok: false };
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { ok: false };
  if (typeof meta.toolUseId !== 'string' || meta.toolUseId === '') return { ok: false };
  return { ok: true, meta };
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
  const KNOWN_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop']);
  if (!KNOWN_EVENTS.has(event)) {
    warnNonBlocking(`H22: unexpected hook_event_name '${event}' — no entry was added or removed; the register cannot track dispatches until this event name is handled`);
  }
  if ((event === 'SubagentStart' || event === 'SubagentStop') && !input.agent_id) {
    warnNonBlocking(`H22: ${event} carried no agent_id (entries are keyed by agent_id) — ${consequence}`);
  }

  const lines = [];

  // PreToolUse / PostToolUse / PostToolUseFailure — dispatch-state recording
  // only, on the Task|Agent matcher (decision dispatch-state-machine-...).
  // Anything else reaching this hook on these events is a matcher mismatch:
  // allow and disclose, never gate (this hook is advisory-class).
  if (event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure') {
    if (input.tool_name !== 'Task' && input.tool_name !== 'Agent') {
      warnNonBlocking(`H22: unexpected ${event} tool_name '${input.tool_name}' on the Task|Agent matcher — allowing, nothing tracked`);
    } else {
      const recorder = event === 'PreToolUse' ? recordDispatchPre : event === 'PostToolUse' ? recordDispatchPost : recordDispatchFailure;
      const result = await recorder(input.cwd, input);
      if (result.disclosures?.length) lines.push(...result.disclosures);
    }
    if (lines.length) process.stderr.write(lines.join('\n') + '\n');
    allow();
  } else if (event === 'SubagentStart' && (typeof input.agent_id !== 'string' || input.agent_id === '')) {
    // X2 (Codex review): a Start with no usable agent_id must not proceed
    // into resolveAndRegisterStart at all — parseRegisterEntry would refuse
    // the round anyway (agent_id is one of its four required fields), so
    // reaching the resolver first only risks a derivation committed for an
    // identity nobody can ever match. The generic missing-agent_id warn above
    // already fired; this is a pure skip.
  } else if (event === 'SubagentStart') {
    const reviewerStart = typeof input.agent_type === 'string' && isReviewerClass(input.agent_type);

    const { entry: registeredEntry, refusal: startRefusal } = await resolveAndRegisterStart(input.cwd, input, (res) => {
      const matchedBlocks = typeof res.prompt === 'string' ? [{ subagent_type: res.subagent_type, prompt: res.prompt }] : [];
      const territory = resolveTerritory(matchedBlocks);
      const territoryFilesSource = territory.files_source;
      // positionalSafe mirrors the old positional.safe test one seam over:
      // 'post' and 'derived-type-unique' are the two sources the state
      // machine PROVES rather than guesses (§5); every other source
      // (resume, unattributable) is exactly as untrustworthy as the old
      // walk-back/union fallbacks were.
      const positionalSafe = res.source === 'post' || res.source === 'derived-type-unique';

      // A11: a PRESENT-but-unusable declaration is disclosed for EVERY class
      // (decision 8f137474 §5); only the NO-DECLARATION-AT-ALL absence
      // warning below is reviewer-only (receipt risk, reviewer-class only).
      for (const m of territory.malformed) {
        lines.push(render(disclosure('territory_declaration_malformed', { line: m.decl.raw }, `H22: malformed REVIEW-TERRITORY declaration ignored, falling back to free-prose: ${m.decl.raw}`)));
      }
      if (reviewerStart) {
        if (territoryFilesSource !== 'review-territory') {
          lines.push(
            render(disclosure('territory_declaration_missing', {}, `H22: reviewer-class dispatch '${input.agent_id}' (${input.agent_type}) has no valid REVIEW-TERRITORY declaration in its attributed dispatch block(s)`))
          );
        }
        if (!positionalSafe) {
          lines.push(
            render(
              disclosure(
                'receipt_unattributable',
                { case: res.case },
                `H22: UNATTRIBUTABLE TERRITORY — reviewer-class dispatch '${input.agent_id}' (${input.agent_type}) could not be bound to its own dispatch by the state-machine resolver [${res.case}]`
              )
            )
          );
        }
      }

      let files, claimedFiles, claimedGlobPrefixes, attribution, filesSource;
      if (matchedBlocks.length && positionalSafe) {
        files = normalizeRegisterPaths(territory.candidates, input.cwd);
        claimedFiles = normalizeRegisterPaths(claimedFromBlocks(matchedBlocks), input.cwd);
        claimedGlobPrefixes = normalizeRegisterPaths(globPrefixesFromBlocks(matchedBlocks), input.cwd);
        attribution = 'block';
        filesSource = territoryFilesSource;
      } else {
        files = [];
        claimedFiles = [];
        claimedGlobPrefixes = [];
        attribution = 'none';
        filesSource = 'unattributable';
      }

      const configuredResourceNames = loadExclusiveResourceNames(input.cwd);
      const claimed =
        attribution === 'block' && configuredResourceNames.length
          ? claimedResources(matchedBlocks.map((b) => b.prompt).join('\n'), configuredResourceNames)
          : [];

      // SPEC B (6): "you do not hold <resource>" — read BEFORE this spawn's
      // own entry exists, so a sole/first claimant never sees itself.
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
        attribution_case: res.case,
        at: new Date().toISOString(),
      };
      if (claimed.length) entry.exclusive_resources = claimed;
      return entry;
    });

    if (startRefusal) {
      if (startRefusal.code === 'register_unavailable') {
        // A24 (pin review MEDIUM), preserved verbatim in substance: a CORRUPT
        // register is read-only — registerStart's own refusal writes nothing
        // and never resets it to a fresh array, which would silently destroy
        // the corruption signal every availability pin depends on.
        lines.push(
          render(
            disclosure(
              'register_unavailable',
              startRefusal.facts ?? {},
              `H22: dispatch register unavailable (${startRefusal.facts?.reason ?? 'unknown'}) at ${startRefusal.facts?.path ?? registerPath(input.cwd)} — this Start writes nothing; resetting it would destroy the corruption signal every availability pin depends on and silently discard any unended round the file held`
            )
          )
        );
      } else {
        lines.push(render(startRefusal));
      }
    }
    void registeredEntry; // observed via `lines`/the register write itself; not otherwise needed here
  } else if (event === 'SubagentStop') {
    // SELECT + MARK UNDER THE SAME COMPOSITE OPERATION: finishDispatchAndRegisterEnd
    // ends the register round FIRST, then terminalizes the matching dispatch-
    // state record — the ORDER a crash cannot make unsafe (§4a). Codex
    // round-2 HIGH (kept from the prior shape): there is no lock-held
    // fallback — a Stop that cannot take the lock writes NOTHING (no receipt,
    // no register mutation) and disclosed-degrades instead; promotion happens
    // ONLY from the composite's own returned {found:true}.
    let departing;
    let sidecarToolUseId;
    if (typeof input.agent_transcript_path === 'string' && input.agent_transcript_path !== '') {
      const sidecar = sidecarForChildTranscript(input.agent_transcript_path);
      if (sidecar.ok) sidecarToolUseId = sidecar.meta.toolUseId;
    }
    try {
      const finished = await finishDispatchAndRegisterEnd(input.cwd, {
        session_id: input.session_id,
        agent_id: input.agent_id,
        sidecarToolUseId,
        event: 'subagent-stop',
      });
      departing = finished.found ? finished.entry : undefined;
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
