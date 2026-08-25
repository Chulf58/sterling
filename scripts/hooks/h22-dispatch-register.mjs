// H22 — in-flight dispatch register (decision ec9eacaa, boards 54c451b4 /
// 570832d4). ONE hook file registered on BOTH SubagentStart and SubagentStop,
// switching on stdin.hook_event_name: Start appends {agent_id, agent_type,
// session_id, files, at} to .sterling/transient/dispatch-register.json, Stop
// removes the entry whose agent_id matches — EXCEPT for a reviewer-class
// entry (agent_type starting with the literal prefix 'reviewer-'), which is
// first PROMOTED as {agent_type, files, at} into the durable review ledger
// at .sterling/review-ledger.json (STORE ROOT, not transient/, so it
// survives H1's session wipe — decision 12a26ca6-a301-466d-a45c-5e1eeff36694,
// slug review-receipt-ledger) and then removed from the register exactly as
// before. The register is what makes live fan-out a DISCLOSED FACT rather
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
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking, repoRel, loadConfig } from './lib/common.mjs';
import { lastDispatchBlocks, extractPathCandidates } from './lib/dispatch-prompt.mjs';
import { probeDirtyPaths, formatResidueLine, claimedResources } from './lib/dispatch-residue.mjs';

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
    const { blocks: matchedBlocks, attribution } = attributeBlocks(input.transcript_path, input.agent_type);
    const candidates = candidatesFromBlocks(matchedBlocks);
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

    // SPEC B (6): "you do not hold <resource>" notice — computed against
    // `entries` BEFORE this spawn's own entry is appended below, so a
    // sole/first claimant structurally never sees itself (self-exclusion is
    // not a filter to get wrong, it is simply not in the list yet).
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
    // spawned agent at all. Nothing else on this event path writes
    // hookSpecificOutput today, so there is nothing to merge with yet — but the
    // shape is built so a future addition here joins into ONE payload/one write,
    // never a second competing hookSpecificOutput write.
    if (notices.length) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: notices.join('\n') } })
      );
    }

    const newEntry = {
      agent_id: input.agent_id,
      agent_type: input.agent_type ?? null,
      session_id: input.session_id,
      files,
      at: new Date().toISOString(),
      attribution,
    };
    if (claimed.length) newEntry.exclusive_resources = claimed;
    entries.push(newEntry);
  } else {
    // Stop: promote a reviewer-class entry into the durable review ledger
    // (decision 12a26ca6-a301-466d-a45c-5e1eeff36694, slug
    // review-receipt-ledger) BEFORE removing it from the register — the
    // in-flight register is transient (H1 wipes it every SessionStart), but a
    // reviewer's evidence must survive to be stamped into a later commit by
    // scripts/commit-reviewed.mjs. Non-reviewer entries keep the exact
    // delete-only path from before: the ledger is never created or touched.
    const departing = entries.find((e) => e.agent_id === input.agent_id);

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
        ledger.push({ agent_type: departing.agent_type, files: departing.files, at: departing.at });
        const ledgerTmpPath = join(sterlingDir, `review-ledger.json.tmp-${process.pid}`);
        writeFileSync(ledgerTmpPath, JSON.stringify(ledger));
        renameSync(ledgerTmpPath, ledgerPath);
      });
    }
    // Remove the matching entry. No match is a clean no-op (the pruning
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
      ? `the entry for '${input.agent_id}' STAYS LIVE and OVER-DEFERS H10's file duties for the files it claims, until H10's staleness TTL expires or H1 deletes the register at the next session start — and if this was a reviewer-class dispatch, its receipt may never have reached the durable review ledger, so a later scripts/commit-reviewed.mjs invocation may wrongly refuse for lack of review evidence`
      : `this dispatch is absent from the register, so H10 will NOT defer the duties for the files it owns (under-defer: a duty fires that could have waited)`;
  warnNonBlocking(`H22: dispatch register update failed: ${(e && e.message) || e} — ${consequence}`);
}
