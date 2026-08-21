// H22 — in-flight dispatch register (decision ec9eacaa, boards 54c451b4 /
// 570832d4). ONE hook file registered on BOTH SubagentStart and SubagentStop,
// switching on stdin.hook_event_name: Start appends {agent_id, agent_type,
// session_id, files, at} to .sterling/transient/dispatch-register.json, Stop
// removes the entry whose agent_id matches. The register is what makes live
// fan-out a DISCLOSED FACT rather than conductor memory — H10 reads it at Stop
// and defers file duties owned by a live dispatch, instead of reading an
// agent's work-in-progress as conductor negligence (570832d4: the same
// capture_pending minted three times in one hour).
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
// CONCURRENCY, stated honestly. The write is ATOMIC (tmp file + rename), so a
// concurrent READER — H10 at Stop, a sibling fire — never sees a torn file: a
// torn read degrades the WHOLE register to empty, which would drop every live
// entry at exactly the moment fan-out traffic makes that most likely. The
// read-modify-write LOST UPDATE is NOT solved and is accepted: two fires
// overlapping between read and rename means the loser's change vanishes. It
// cuts BOTH ways — a lost Start under-defers (a duty fires that could have
// waited), and a Start that re-writes an entry a concurrent Stop had just
// removed OVER-defers (a duty waits that was already owed). Both are bounded,
// never permanent: H10's staleness TTL stops honoring an orphan entry, and H1
// deletes the register outright at the next session start.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking, repoRel } from './lib/common.mjs';
import { lastDispatchPrompts, extractPathCandidates } from './lib/dispatch-prompt.mjs';

const input = readStdin();

try {
  // Not a Sterling project — no ceremony, and above all nothing created (P1).
  // Same key as projectRoot/openStore: the DB FILE, never a bare .sterling dir.
  if (!existsSync(join(input.cwd, '.sterling', 'sterling.db'))) allow();

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
  let entries = [];
  try {
    if (existsSync(registerPath)) {
      const raw = JSON.parse(readFileSync(registerPath, 'utf8'));
      if (Array.isArray(raw)) entries = raw;
    }
  } catch {
    entries = []; // corrupt bytes degrade to empty (session-events posture) and
    // are replaced by the valid register written below
  }

  // Foreign-session entries are pruned on EVERY fire, start or stop: a dispatch
  // cannot outlive its own session, so another session_id's entry is residue
  // that would otherwise defer this session's duties forever.
  entries = entries.filter((e) => e && e.session_id === input.session_id);

  if (event === 'SubagentStart') {
    const prompts = lastDispatchPrompts(input.transcript_path);
    const candidates = [...new Set(prompts.flatMap(extractPathCandidates))];
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
    const files = [...new Set(candidates.map((c) => repoRel(c, input.cwd)).filter(Boolean))].filter(
      (r) =>
        r !== '.git' &&
        !r.startsWith('.git/') &&
        !r.startsWith('.sterling/') &&
        !r.startsWith('sterling/') &&
        !r.startsWith('git/')
    );
    entries.push({
      agent_id: input.agent_id,
      agent_type: input.agent_type ?? null,
      session_id: input.session_id,
      files,
      at: new Date().toISOString(),
    });
  } else {
    // Stop: remove the matching entry. No match is a clean no-op (the pruning
    // above still lands) — a stop for an entry H1 already swept, or for a
    // dispatch started before this register existed, is not a defect.
    entries = entries.filter((e) => e.agent_id !== input.agent_id);
  }

  // ATOMIC publish: a reader (H10 at Stop, or a sibling fire) either sees the
  // previous register or this one, never a half-written file — a torn read
  // degrades to EMPTY, which would drop every live entry precisely when fan-out
  // traffic makes a concurrent read most likely. The tmp name carries the pid so
  // two simultaneous fires cannot clobber each other's staging file.
  const transient = join(input.cwd, '.sterling', 'transient');
  mkdirSync(transient, { recursive: true });
  const tmpPath = join(transient, `dispatch-register.json.tmp-${process.pid}`);
  writeFileSync(tmpPath, JSON.stringify(entries));
  renameSync(tmpPath, registerPath);
  allow();
} catch (e) {
  // The register is an aid to H10's deferral, never a gate: a failure here
  // costs deferral precision, never a dispatch (P5 visibility without a
  // blocking exit). The cost is NOT symmetric, so name the one that applies.
  const consequence =
    input.hook_event_name === 'SubagentStop'
      ? `the entry for '${input.agent_id}' STAYS LIVE and OVER-DEFERS H10's file duties for the files it claims, until H10's staleness TTL expires or H1 deletes the register at the next session start`
      : `this dispatch is absent from the register, so H10 will NOT defer the duties for the files it owns (under-defer: a duty fires that could have waited)`;
  warnNonBlocking(`H22: dispatch register update failed: ${(e && e.message) || e} — ${consequence}`);
}
