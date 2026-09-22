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
// together via finishDispatchAndRegisterEnd (A1: marked, never deleted); a
// PostToolUse on the "TaskStop" matcher does the same for a local_agent task
// killed by TaskStop (decision `h22-observes-taskstop-to-end-a-killed-dispatch`),
// joined on tool_response.task_id — the RESOLVED task id, which for a
// local_agent is its agentId (tool_input.task_id may be a name). This
// hook provides minimal dispatch bookkeeping for child-agent knowledge staging:
// the register and its Start-time attribution advisory.
// Every refusal/disclosure this file renders is built through
// scripts/lib/review-errors.mjs and carries a `[code]` token.
// DOES NOT GUARANTEE: that an unattributed/unbound territory reflects
// anything the agent actually touched — `files` is EXAMINED territory (a
// free-prose extraction over the attributed prompt), never a claim or a
// record of what was touched; that concurrent writers never lose a register
// append under a timed-out lock
// (bounded — see the owner module's own contract); that a Pre-denied dispatch
// (H8/H27) ever clears its orphaned pending dispatch-state record before the
// session boundary. NEVER A GATE: this hook is advisory and must never call
// deny().
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking, repoRel, loadConfig } from './lib/common.mjs';
import { extractPathCandidates } from './lib/dispatch-prompt.mjs';
import { isReviewerClass } from './lib/dispatch-advisory.mjs';
import { probeDirtyPaths, formatResidueLine, claimedResources } from './lib/dispatch-residue.mjs';
import {
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
//
// `files` is free-prose extraction ONLY — the REVIEW-TERRITORY structured
// declaration override (parseReviewTerritory) and the claimed_files/
// claimed_glob_prefixes write-side negation guard it fed are DELETED (no
// non-test reader ever consumed them: research_finding
// h22-dispatch-register-consumer-map-which-parts-have-a-reader-september-2026).
// This hook now writes `files` (territory EXAMINED — the field h10/h1 read)
// and nothing else on the territory axis.
// ---------------------------------------------------------------------------

function candidatesFromBlocks(blocks) {
  return [...new Set(blocks.flatMap((b) => extractPathCandidates(b.prompt)))];
}

function normalizeRegisterPaths(cands, cwd) {
  return [...new Set(cands.map((c) => repoRel(c, cwd)).filter(Boolean))].filter(
    (r) => r !== '.git' && !r.startsWith('.git/') && !r.startsWith('.sterling/') && !r.startsWith('sterling/') && !r.startsWith('git/')
  );
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

// KILL-DETECTION RESIDUE for a departing round: dirty declared files are
// disclosed unless the probe VERIFIED the round left none.
function residueLines(cwd, departing) {
  const probe = probeDirtyPaths(cwd, departing.files);
  const dirty = Array.isArray(probe.dirty) ? probe.dirty : [];
  if (probe.verified && dirty.length === 0) return [];
  return [render(disclosure('dispatch_residue', {}, formatResidueLine(departing, dirty, { verified: probe.verified, reason: probe.reason })))];
}

// A TaskStop kill of a local_agent task ends that dispatch's round. Any other
// task_type (a background shell, a monitor) is not a dispatch: nothing to do.
// An unreadable tool_response is an unknown shape — disclosed, never guessed.
async function endTaskStoppedDispatch(input, lines) {
  const resp = input.tool_response;
  if (!resp || typeof resp !== 'object' || typeof resp.task_type !== 'string') {
    warnNonBlocking(`H22: TaskStop's tool_response has no readable task_type (${JSON.stringify(resp)?.slice(0, 200)}) — nothing was ended; a stopped dispatch stays presumed-active until its lease expires`);
    return;
  }
  if (resp.task_type !== 'local_agent') return;
  if (typeof resp.task_id !== 'string' || resp.task_id === '') {
    warnNonBlocking(`H22: TaskStop stopped a local_agent task but tool_response.task_id is missing — nothing was ended; the dispatch stays presumed-active until its lease expires`);
    return;
  }
  try {
    const finished = await finishDispatchAndRegisterEnd(input.cwd, { session_id: input.session_id, agent_id: resp.task_id, event: 'task-stop' });
    // A killed agent never writes a final message, so the residue probe runs
    // unconditionally — the same signature a message-less SubagentStop gets.
    if (finished.found) lines.push(...residueLines(input.cwd, finished.entry));
  } catch (e) {
    if (e?.code !== 'register_lock_held') throw e;
    lines.push(
      render(
        disclosure(
          'register_lock_held',
          e.facts ?? {},
          `H22: could not mark the TaskStop-killed round '${resp.task_id}' ended — the register lock at ${e.facts?.lock_path ?? '(unknown)'} is held by another live writer; the round stays presumed-active until its lease expires`
        )
      )
    );
  }
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
  if (event === 'PostToolUse' && input.tool_name === 'TaskStop') {
    await endTaskStoppedDispatch(input, lines);
    if (lines.length) process.stderr.write(lines.join('\n') + '\n');
    allow();
  } else if (event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure') {
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
      // positionalSafe mirrors the old positional.safe test one seam over:
      // 'post' and 'derived-type-unique' are the two sources the state
      // machine PROVES rather than guesses (§5); every other source
      // (resume, unattributable) is exactly as untrustworthy as the old
      // walk-back/union fallbacks were.
      const positionalSafe = res.source === 'post' || res.source === 'derived-type-unique';

      if (reviewerStart && !positionalSafe) {
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

      let files, attribution, filesSource;
      if (matchedBlocks.length && positionalSafe) {
        files = normalizeRegisterPaths(candidatesFromBlocks(matchedBlocks), input.cwd);
        attribution = 'block';
        filesSource = 'free-prose-fallback';
      } else {
        files = [];
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
              `H22: could not mark this round ended — the register lock at ${e.facts?.lock_path ?? '(unknown)'} is held by another live writer (kernel-held: released when that writer finishes or dies, so there is nothing to remove by hand). This Stop writes nothing (no receipt, no register change) so no round is ever promoted twice; the mark and any promotion happen on the next Stop of this round, or re-run the round if none follows.`
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
      if (lastMsg === '') lines.push(...residueLines(input.cwd, departing));
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
