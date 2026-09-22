// H10 — direct-path capture check + review (spec §6 H10). Stop, soft.
// Artifact-produced-but-no-capture → first Stop prompts the
// conductor to capture inline (exit 2, soft block); still missing on the next
// Stop → maintenance queue (capture_owed) and the session may end. Reviewer
// advice is NOT this hook's business (board cac61a95) — that lives in H2's
// selection-inject surface. Test-touching work names modified/deleted tests
// vs git HEAD in the capture nag (check_skipped {test-integrity} without git).
// Touched set (slice 4): H7's tool-call register UNION the paths git reports
// changed since the persisted settled snapshot (lib/settlement.mjs
// gitTouches) — a hand or Bash edit arms the same duties an Edit does.
// Article demand (§6 H10, adjudicated 2026-06-11): touched files no
// feature_article owns, at threshold or any new unowned file (vs git HEAD;
// no-git degrades loud) → the nag demands the OWNING ARTICLE inline; still
// missing at session end → article_missing maintenance item. General capture
// does NOT satisfy the demand — only ownership does (the unowned set
// recomputes per Stop, so creating the article clears it mechanically).
// Session-event register (run r-a6cf): H10 also reads session-events.json
// (written by H16/debug-scope/concept-designed/no-capture). Dual-register entry:
// proceeds if touches OR events are non-empty. Capture duty: touches ∪
// debug_scope events, MINUS any covered by a no_capture declaration (board
// 7bbec3bd) — an explicit "nothing durable" event satisfies the duty for every
// touch/debug_scope event EARLIER than it; work arriving after re-arms it.
// Research duty: research_tool ∪ configured agent_dispatch events, MINUS any
// covered by a no_capture declaration (same cutoff as the capture lane above —
// item 353416a9), not followed by a durable capture → nag once (shared
// marker), then research_owed on release.
// Concept duty (decision foreign_7208729b): concept_designed events (detail
// = family slug) not followed by that family's concept article
// (feature_article.concept_family) → shared nag, then one
// concept_article_missing item per family on release.
// All terminal paths clear both registers + the nag marker together (P4).
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, writeSync, rmSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readStdin, deny, allow, exitAfterWrite, openStore, loadConfig, warnNonBlocking, gitIgnored, withRetry } from './lib/common.mjs';
import { withRegisterLock, classifyRegister, readRegister, formatDispatchRef, registerPath as ownerRegisterPath } from '../lib/dispatch-register.mjs';
import { disclosure, render } from '../lib/review-errors.mjs';
import { mintSettlementReconcile, withFileLock, parseTouchesContent, gitTouches, gitTrackedSubset, writeGitSettled } from './lib/settlement.mjs';
import { latestUsage, fillPct } from './lib/transcript.mjs';
import { isOrphan, probeDirtyPaths, formatResidueLine } from './lib/dispatch-residue.mjs';
import { gitTestIntegrity } from '../lib/test-integrity.mjs';
import { matchesGlob, parseConfig } from '@sterling/schemas';
import { publishNotice } from './lib/delivery.mjs';

/**
 * DEAD-DISPATCH RESIDUE (SPEC A, boards 03ed9d35/31565253; shared lib
 * scripts/hooks/lib/dispatch-residue.mjs). A pure filesystem+git fact about
 * the H22 register — deliberately independent of the knowledge store (a
 * register + config can exist before/without a store, and the residue must
 * still surface, SPEC A item 7's fail-loud posture applied to the STORE gate
 * itself, not only the git probe): computed once, up front, before the
 * `if (!store) allow()` bail below, so a store-less cwd still reports and
 * stamps. When a store IS present the caller folds the returned lines into
 * the normal disclosure surface instead of printing them standalone.
 * Print-once via a truthy residue_reported_at persisted directly onto the
 * matching register entries — additive only (never removes/reorders), so the
 * existing "H10 never mutates the register" deferral pin (a LIVE entry, never
 * an orphan) stays true.
 */
async function computeDeadDispatchResidue(cwd, sessionId) {
  const registerPath = ownerRegisterPath(cwd);
  const nowIso = new Date().toISOString();
  // ONE READER: parseRegisterEntry (scripts/lib/dispatch-register.mjs) now
  // spreads every unvalidated field through unchanged (residue_reported_at
  // included), so the print-once guard below reads it off the PARSED entry
  // instead of a second raw JSON read — readRegister is the same authority
  // the duty-deferral tri-state above already uses.
  const { availability, entries: registerEntries } = readRegister(cwd);
  if (availability !== 'ok' || !registerEntries.length) return [];
  let staleMinutes = 60; // schema default (decision foreign_ec9eacaa) when config cannot be read
  try {
    staleMinutes = parseConfig(loadConfig(cwd) ?? {}).dispatch_register.stale_minutes;
  } catch {
    // fall back to the schema default rather than skipping the residue check
  }
  const nowMs = Date.parse(nowIso);
  const lines = [];
  const stampIds = new Set();
  for (const entry of registerEntries) {
    if (!entry || entry.session_id !== sessionId) continue;
    // A1: Stop MARKS `ended` rather than deleting — an ended entry's Stop DID
    // fire, so it is inactive-confirmed, never "stopped by timeout" residue,
    // however stale its `at` reads.
    if (entry.ended) continue;
    if (!isOrphan(entry, staleMinutes, nowMs)) continue;
    if (entry.residue_reported_at) continue; // print-once
    const probe = probeDirtyPaths(cwd, entry.files);
    const dirty = Array.isArray(probe.dirty) ? probe.dirty : [];
    if (probe.verified && dirty.length === 0) continue; // clean — nothing to report
    lines.push(render(disclosure('dispatch_residue', {}, formatResidueLine(entry, dirty, { verified: probe.verified, reason: probe.reason }))));
    stampIds.add(entry.agent_id);
  }
  if (stampIds.size) {
    // FRESH-READ MERGE UNDER THE COOPERATING REGISTER LOCK (decision
    // register-writers-cooperating-lock, 1e0ba0d0) — H10 is a register writer
    // like H22's Start/Stop/prune and H1's session-boundary delete, so it
    // takes the SAME kernel-held register lock (scripts/lib/dispatch-register.mjs withRegisterLock, R1)
    // rather than a second divergent cross-hook lock. TIMEOUT POSTURE: SKIP
    // THE STAMP, LOUD, never an unlocked write — an unlocked whole-array
    // rewrite here could erase a concurrent H22 SubagentStart/Stop's
    // mutation, while skipping only costs this print-once stamp (the residue
    // line may then print again on a later Stop — bounded, disclosed, and
    // accepted per the decision). Re-reading immediately before persisting
    // and stamping ONLY entries still present (by agent_id) means an entry a
    // concurrent H22 SubagentStop removed between our first read and now is
    // simply left unstamped, never resurrected by writing back a stale copy
    // of it — and a torn concurrent read degrading to [] here costs only
    // this stamp, never the live register (we write back the FRESH read, not
    // our own stale snapshot).
    //
    // ONE READER for this fresh re-read too (readRegister, not a second raw
    // JSON.parse): parseRegisterEntry's full-spread parse means a VALID entry
    // round-trips byte-identical through it, so this changes nothing for the
    // ordinary case. DISCLOSED TRADE: an entry so malformed it fails to parse
    // at all (missing agent_id/session_id/files/at — never produced by
    // registerStart itself, only by external corruption) is dropped from this
    // rewrite rather than preserved verbatim, the same bounded cost the
    // comment above already accepts for a concurrently-removed entry.
    try {
      mkdirSync(join(cwd, '.sterling', 'transient'), { recursive: true });
      await withRegisterLock(
        cwd,
        () => {
          const freshRead = readRegister(cwd);
          const fresh = freshRead.availability === 'ok' ? freshRead.entries : [];
          for (const entry of fresh) {
            if (entry && stampIds.has(entry.agent_id) && !entry.residue_reported_at) {
              entry.residue_reported_at = nowIso;
            }
          }
          const transient = join(cwd, '.sterling', 'transient');
          mkdirSync(transient, { recursive: true });
          const tmpPath = join(transient, `${basename(registerPath)}.tmp-${process.pid}`);
          writeFileSync(tmpPath, JSON.stringify(fresh));
          renameSync(tmpPath, registerPath);
        },
        { retryMs: 1000, timeoutMs: 10_000 }
      );
    } catch (e) {
      if (e?.code === 'register_lock_held') {
        process.stderr.write(
          `${render(e)} — SKIPPING residue_reported_at stamp (never writing the register unlocked); the residue line may print again on a later Stop\n`
        );
      }
      // any other failure is best-effort — a failed stamp costs only print-once across Stops, never this report
    }
  }
  return lines;
}

const input = readStdin();
const residueLines = await (async () => {
  try {
    return await computeDeadDispatchResidue(input.cwd, input.session_id);
  } catch {
    return [];
  }
})();
const store = openStore(input.cwd);
if (!store) {
  if (residueLines.length) process.stderr.write(residueLines.join('\n\n'));
  allow();
}

const touchesPath = join(input.cwd, '.sterling', 'transient', 'touches.json');
const eventsPath = join(input.cwd, '.sterling', 'transient', 'session-events.json');
const nagMarker = join(input.cwd, '.sterling', 'transient', 'capture-nagged.json');

// R0 CONTROL-FLOW SENTINEL: this script's body is bare top-level code (no
// wrapping main()), so a real `return` is illegal at every one of
// releaseWithPressure()'s seven call sites below. allow()/deny() still exit
// synchronously (process.exit() never returns to the caller), so they need
// nothing extra; but the non-empty-payload branch of exitAfterWrite settles
// its process.exit() ASYNCHRONOUSLY, in the write's own callback — so a bare
// `return` there only exits releaseWithPressure() itself, and the top-level
// `if` block that called it falls through to whatever duty logic follows,
// which can reach a LATER deny()/write while the first one is still in
// flight (measured: truncates the correct payload, wrong exit code). Throwing
// a TAGGED error from inside the guarded region instead unwinds all the way
// to the founding catch below, which recognizes the tag and does nothing
// further — the in-flight write's own callback owns the exit, exactly as R0
// requires. No module-scope sentinel (check-failclosed-boundary review): a
// plain top-level statement outside the guarded try is itself a fail-closed
// finding, so the tag lives on the thrown Error, created only at the throw
// site inside the try.

try {
  const config = parseConfig(loadConfig(input.cwd) ?? {});
  const now = new Date().toISOString();

  // ── CONTAINMENT PRIMITIVES (board da8dcd27, extended by the 2026-08-29 review) ──
  //
  // H10's founding catch calls warnNonBlocking, never deny() — the baselined F5
  // debt this hook carries (see scripts/check-failclosed-boundary.mjs). So ANY
  // throw that escapes to it exits 1, the runner reads non-2 as NON-BLOCKING,
  // and EVERY remaining Stop duty is voided: no nag, no capture_owed, no
  // article_missing, and — for a throw placed upstream of the terminal release —
  // no runSettlement()/clearRegisters() either, which leaks this session's
  // registers into the next one (a P4 lifecycle violation on top of the
  // fail-open). da8dcd27 contained the recompute TRANSACTION; the review found
  // three more store calls sitting outside it, one of them (the newfile
  // check_skipped) newly hoisted UPSTREAM of the release.
  //
  // The reachable failure needs nothing exotic: a store that READS but cannot
  // be WRITTEN (read-only FS, disk full, the store's schema-drift write guard)
  // makes every recordCheckSkipped below throw on its first try, and the arms
  // that inject a store failure one layer deeper never see it.
  //
  // TWO primitives, used everywhere a degrade is RECORDED in this file's
  // article/demand lanes, so the pattern exists once (P3) rather than being
  // re-derived per site:
  //   disclose(line) — stderr is the LAST-RESORT signal, and it is exactly the
  //     channel used when the store cannot record. An EPIPE on it (a closed
  //     runner pipe) would re-open the hole the catch closes, so it is guarded
  //     too; there is nothing left to fall back to, hence the empty catch.
  //   skipRow(name, detail) — a check_skipped row that can NEVER escape: when
  //     recording the skip is itself the casualty, the degrade is disclosed on
  //     stderr instead and control CONTINUES to the duties.
  const disclose = (line) => {
    try {
      process.stderr.write(line);
    } catch {
      // the last-resort channel is gone (EPIPE / closed pipe). Throwing here
      // would void every remaining duty — silence is the lesser failure.
    }
  };
  const skipRow = (name, detail) => {
    try {
      store.recordCheckSkipped(name, detail, undefined, now);
    } catch (e) {
      disclose(`H10: check_skipped '${name}' could not be recorded — ${String((e && e.message) || e)} (degrade detail: ${detail})\n`);
    }
  };

  // CONDUCTOR CONTEXT PRESSURE (context-rotation slice 1): H6's transcript machinery
  // (latestUsage/fillPct) pointed at the conductor's OWN transcript — Stop payloads carry
  // transcript_path natively, no deriveAgentTranscript. Advisory and FAIL-OPEN in its own
  // try: a pressure failure records check_skipped {conductor-pressure} and must never cost
  // a session-end duty. The persisted sample is a latest-value cell keyed by session_id;
  // the once-per-session hard nag marker is spent-by-session_id, so a stale marker from a
  // prior session never suppresses and needs no clearing event (P4 by supersession).
  const pressureMarker = join(input.cwd, '.sterling', 'transient', 'pressure-nagged.json');
  const pressure = (() => {
    try {
      const cw = config.context_watch;
      const { usage, model, reason } = latestUsage(input.transcript_path ?? '');
      let sample;
      if (!usage) {
        store.recordCheckSkipped('conductor-pressure', reason ?? 'format_unparseable', undefined, now);
        sample = { session_id: input.session_id, level: 'unknown', fill_pct: null, reason, at: now };
      } else {
        // WINDOW = windows[model] ?? windows[baseModel] ?? windows.default (decision
        // context-window-default-is-a-real-fallback, user-ruled 2026-09-22, reversing
        // slice 4's "never a default"): a per-model entry always wins when present —
        // the wrong-denominator-with-a-believable-percentage risk that motivated slice 4
        // (2026-08-11: 48% accepted at ~10% of real capacity; 2026-09-19: 66.2% reported
        // for a claude-opus-5[1m] session at ~13%) is real, but the user ruled the
        // fallback worth having; a degraded path must still announce itself (P5), so a
        // sample resolved through the default carries window_source: 'default' and the
        // pressure line names it. A context-variant suffix ("claude-opus-5[1m]") falls
        // back to its base entry; the transcript usually carries the BASE id for both
        // variants, so the base entry must hold the window this project's sessions run.
        // No entry AND no default → the fill is UNRELIABLE: no percentage, no level, and
        // the unmapped model rides the sample so the release path says so once.
        const baseModel = model ? String(model).replace(/\[[^\]]*\]$/, '') : null;
        const perModelWindow = model ? cw.windows[model] ?? cw.windows[baseModel] : undefined;
        const windowSize = model ? perModelWindow ?? cw.windows.default : undefined;
        const usedDefault = Boolean(model && perModelWindow === undefined && cw.windows.default !== undefined);
        const fill = windowSize ? fillPct(usage, windowSize) : null;
        if (!windowSize) {
          store.recordCheckSkipped('conductor-pressure', `window_unmapped:${model ?? 'no-model-id'}`, undefined, now);
          sample = { session_id: input.session_id, level: 'unknown', fill_pct: null, model: model ?? null, reason: 'window_unmapped', ...(model ? { unmapped_model: model } : {}), at: now };
        } else if (fill > 100) {
          // Impossible with a correct denominator — the windows map lacks this model's true
          // window (observed live 2026-08-09: 129.3% on a fable session vs the 200k default).
          // Evidence of MISCONFIGURATION, not pressure: classify unknown + check_skipped
          // (loud, fail-open) instead of false-hard-blocking every session on this machine.
          store.recordCheckSkipped('conductor-pressure', `window_mismatch:${model ?? 'unknown-model'}:${fill.toFixed(1)}pct`, undefined, now);
          sample = { session_id: input.session_id, level: 'unknown', fill_pct: fill, model: model ?? null, window: windowSize, reason: 'window_mismatch', ...(usedDefault ? { window_source: 'default' } : {}), at: now };
        } else {
          const level = fill >= cw.conductor.hard_pct ? 'hard' : fill >= cw.conductor.soft_pct ? 'soft' : 'below_soft';
          sample = { session_id: input.session_id, level, fill_pct: fill, model: model ?? null, window: windowSize, ...(usedDefault ? { window_source: 'default' } : {}), at: now };
        }
      }
      mkdirSync(join(input.cwd, '.sterling', 'transient'), { recursive: true });
      writeFileSync(join(input.cwd, '.sterling', 'transient', 'conductor-pressure.json'), JSON.stringify(sample));
      return sample;
    } catch (e) {
      try {
        store.recordCheckSkipped('conductor-pressure', String((e && e.message) || e), undefined, new Date().toISOString());
      } catch {
        // store is the casualty — pressure stays advisory, the duty gate below still runs
      }
      return { session_id: input.session_id, level: 'unknown', fill_pct: null, reason: 'pressure_failed', at: now };
    }
  })();
  // SLICE-BOUNDARY ADVISORY (context-rotation slice 2): at elevated pressure a DIRTY
  // working tree means the open slice has not reached its commit boundary — the safe
  // state every direct-mode slice ends in (branch-local commit; the merge gates stay
  // human). Checked only at soft/hard so a quiet session never pays the git spawn;
  // fail-open with check_skipped on no-git or a failed probe (advisory, never a gate).
  const dirtyPaths = (() => {
    if (pressure.level !== 'soft' && pressure.level !== 'hard') return 0;
    try {
      const st = spawnSync('git', ['status', '--porcelain'], { cwd: input.cwd, encoding: 'utf8', timeout: 15_000 });
      if (st.status !== 0) {
        store.recordCheckSkipped('conductor-pressure', 'boundary_no_git', undefined, now);
        return 0;
      }
      return st.stdout.split('\n').filter(Boolean).length;
    } catch (e) {
      try {
        store.recordCheckSkipped('conductor-pressure', `boundary_check_failed:${String((e && e.message) || e)}`, undefined, now);
      } catch {
        // store is the casualty — stay advisory
      }
      return 0;
    }
  })();
  const boundaryLine = () =>
    dirtyPaths > 0 ? ` Tree: ${dirtyPaths} uncommitted path(s) → commit boundary before new work.` : '';
  // The hard threshold is the 50% TARGET (slice 4): a WARNING to finish the
  // open work and commit it — never a demand to clear. Fill is OCCUPIED
  // context: the latest assistant turn's input + cache tokens (lib/transcript
  // fillPct), which already reflects compaction — not a cumulative sum.
  // P5: a window resolved through context_watch.windows.default is a guessed
  // denominator, not a mapped one — the pressure line says so briefly so a
  // reader can tell the two apart (decision context-window-default-is-a-real-
  // fallback, user-ruled 2026-09-22).
  const defaultWindowNote = () => (pressure.window_source === 'default' ? ' (window from context_watch.windows.default)' : '');
  const pressurePart = () =>
    pressure.level === 'hard'
      ? `H10 context warning: fill ${pressure.fill_pct.toFixed(1)}% of the ${pressure.window}-tok window is past the ${config.context_watch.conductor.hard_pct}% target → finish the open work and commit it; delegate reads & mechanical work to subagents (P1).${defaultWindowNote()}${boundaryLine()}`
      : `H10 pressure: fill ${pressure.fill_pct.toFixed(1)}% ≥ soft threshold ${config.context_watch.conductor.soft_pct}% → prefer finishing open work, delegate reads to subagents.${defaultWindowNote()}${boundaryLine()}`;
  const pressureMarkerState = () => {
    try {
      const m = JSON.parse(readFileSync(pressureMarker, 'utf8'));
      return m.session_id === input.session_id ? m : null;
    } catch {
      return null;
    }
  };
  const spendPressureMarker = (level) => writeFileSync(pressureMarker, JSON.stringify({ session_id: input.session_id, level, at: now }));
  // WINDOW-GAUGE WARNING (retro slice 2; slice 4; reversed by decision
  // context-window-default-is-a-real-fallback, user-ruled 2026-09-22): fires
  // only when a model has NEITHER a per-model entry NOR context_watch.windows.default
  // — the fill truly cannot be measured. Say so loudly once, until the config
  // gains an entry or a default. Same marker pattern as pressure (latest-value
  // cell keyed by session_id; P4 by supersession).
  const gaugeMarker = join(input.cwd, '.sterling', 'transient', 'gauge-warned.json');
  const gaugeSpent = () => {
    try {
      return JSON.parse(readFileSync(gaugeMarker, 'utf8')).session_id === input.session_id;
    } catch {
      return false;
    }
  };
  const spendGaugeMarker = () => writeFileSync(gaugeMarker, JSON.stringify({ session_id: input.session_id, at: now }));
  const gaugePart = () =>
    `H10 window gauge: model '${pressure.unmapped_model}' has no entry in context_watch.windows — context fill is UNRELIABLE and is not reported. Add context_watch.windows["${pressure.unmapped_model}"] = <window tokens> to .sterling/config.json. (once per session)`;
  /**
   * Every direct-mode release path exits through here. At most TWO pressure blocks per
   * session, strictly escalating: soft+dirty fires the slice-boundary nudge once; hard
   * fires once more (even after a soft block — escalation is new information). A spent
   * hard marker ends all pressure blocking for the session. The window-gauge
   * warning joins the SAME standalone deny when due (one block per Stop, P1);
   * stop_hook_active suppresses without spending, so a suppressed advisory can still
   * fire on a later Stop of the same session.
   *
   * Fan-out deferral/staleness disclosures (decision foreign_ec9eacaa) ride this release
   * whichever way it goes: prefixed to the block when one is due, and otherwise
   * emitted as a systemMessage on the exit-0 release — a deferral is a fact to
   * disclose, never a reason to block (P5).
   */
  // SPEND AFTER DELIVERY, shared (point D, decision foreign_ee8ab1f5; Fix 1 review
  // round): write stderr synchronously; ONLY on a successful write run the
  // given spend callbacks, each independently try/caught (a marker WRITE
  // failure is caught and ignored, point E) — then exit 2 either way. A
  // throw off the write itself spends nothing. This is the ONE sequence
  // both blocking `[dispatch_status_unknown]` delivery paths use: the
  // pressure/gauge advisory below (spends only the unknown-note
  // keys — no duty rendered there, so capture-nagged/duty-nagged are never
  // touched) and the duty-nag deny further down (spends all three).
  const writeThenSpend = (text, spends) => {
    let delivered = false;
    try {
      // FIX 3 (Codex review, verified against Node semantics): Claude Code
      // gives hooks a PIPE for stderr, and on a pipe process.stderr.write's
      // failure (EPIPE/EBADF) surfaces through the write callback or the
      // stream's 'error' event — NEVER as a synchronous throw — so a plain
      // try/catch around it never actually catches anything and "delivered"
      // would always read true. writeSync(2, ...) is the synchronous
      // syscall and DOES throw synchronously on those errors, which is what
      // makes this catch real.
      const buf = Buffer.from(text, 'utf8');
      let off = 0;
      while (off < buf.length) {
        // FIX (Codex, review round): a zero-length write is a legal return
        // from writeSync — looping on it would spin forever instead of
        // failing loud, so treat it exactly like a throw.
        const n = writeSync(2, buf, off, buf.length - off);
        if (!(n > 0)) throw new Error('fd 2 wrote nothing');
        off += n;
      }
      delivered = true;
    } catch {
      // nothing is spent — the next Stop repeats the same text, louder, never silent
    }
    if (delivered) {
      for (const spend of spends) {
        try {
          spend();
        } catch {
          // best-effort — a marker write failure costs only itself
        }
      }
    }
    process.exit(2);
  };

  const releaseWithPressure = () => {
    let advisoryText = '';
    const advisorySpends = [];
    if (!input.stop_hook_active) {
      const parts = [];
      const spent = pressureMarkerState();
      if (pressure.level === 'hard' && (!spent || spent.level !== 'hard')) {
        parts.push(pressurePart());
        advisorySpends.push(() => spendPressureMarker('hard'));
      } else if (pressure.level === 'soft' && dirtyPaths > 0 && !spent) {
        parts.push(`${pressurePart()} (once per session)`);
        advisorySpends.push(() => spendPressureMarker('soft'));
      }
      if (pressure.unmapped_model && !gaugeSpent()) {
        parts.push(gaugePart());
        advisorySpends.push(spendGaugeMarker);
      }
      // Disclosures never CAUSE a block — they only ride one that is already due.
      // FIX 1 (review round): this is a THIRD `[dispatch_status_unknown]`
      // delivery path — a pressure/gauge block can carry the same
      // disclosureParts the duty-nag and exit-0 releases carry, so it must
      // spend the unknown-note keys too (never duty-nagged/capture-nagged —
      // no duty is rendered on this path).
      advisoryText = parts.join('\n\n');
    }
    if (advisoryText) {
      try {
        publishNotice(input.cwd, advisoryText);
        for (const spend of advisorySpends) spend();
      } catch (e) {
        disclose(`H10: context advisory publish failed — ${String((e && e.message) || e)}; it will retry on the next Stop\n`);
      }
    }
    // R0: the payload and the exit are ONE state machine — a bare
    // process.stdout.write() followed by a separate allow() can exit before
    // the pipe drains (decision hook-stdout-exit-after-write-callback-bound-
    // exit-deny-stays-synchronous).
    if (disclosureParts.length || advisoryText) {
      // dispatch-unknown-noted.json is spent here too (point C, decision
      // ee8ab1f5): these rows ride disclosureParts, which leaves through BOTH
      // this exit-0 systemMessage release AND the duty-nag deny below — a
      // deny-only spend cannot guarantee once-per-session (Codex round 2,
      // adopted). Spent only inside onWritten, i.e. after the payload is
      // actually handed off.
      exitAfterWrite(JSON.stringify({ systemMessage: [...disclosureParts, advisoryText].filter(Boolean).join('\n\n') }), 0, {
        onWritten: spendDispatchUnknownKeys,
      });
      // This write's exit is async, so a bare `return` here would let the
      // top-level caller fall through into later duty code. Throw a TAGGED
      // error to unwind past every enclosing top-level `if` to the founding
      // catch, which recognizes the tag and treats it as a normal, already-
      // handled completion — no module-scope sentinel (see the note above the
      // guarded try).
      throw Object.assign(new Error('h10-release-in-flight'), { h10ReleaseInFlight: true });
    }
    allow();
  };

  // parseTouchesContent (shared with H7, scripts/hooks/lib/settlement.mjs —
  // micro-round fixer): touches.json is always the whole-array shape H7
  // writes and test fixtures hand-build it as; a stray JSONL-shaped line is
  // tolerated too, never fatal.

  // CLAIM the touch register atomically (F4/R4, board c198866d fixer round):
  // renaming touches.json to a claim path is one atomic filesystem op — an H7
  // append after the rename lands in a FRESH touches.json (H7 never reads
  // before it appends), never in the claim. R4(a): a claim already sitting at
  // the claim path (a prior Stop that DIED between the rename and its own
  // release, or one that deliberately left it in place — see
  // releaseTouchesClaim below) must be ADOPTED, never silently discarded or
  // overwritten — read it FIRST, before this rename risks REPLACING it
  // (POSIX rename() atomically replaces an existing destination file; reading
  // after would find only the fresh half, with the orphaned half gone
  // without a trace).
  // R3 ROUND 2 (board c198866d round-4 fixer): the claim rename and the
  // release rename-back both take the SAME lock H7's append now takes
  // (withFileLock, scripts/hooks/lib/settlement.mjs) — "H7's append AND
  // H10's claim/union writes" share ONE lock around touches.json, so an H7
  // appending mid-claim serializes instead of racing the rename. A lock that
  // cannot be acquired within its short deadline degrades to the pre-lock
  // unlocked behavior (never hangs the Stop, P1) and records check_skipped.
  const touchesClaimPath = `${touchesPath}.claim`;
  let touches = [];
  withFileLock(
    touchesPath,
    () => {
      // R4(a): a claim already sitting at the claim path (a prior Stop that
      // DIED between the rename and its own release, or one that
      // deliberately left it in place — see releaseTouchesClaim below) must
      // be ADOPTED, never silently discarded or overwritten — read it FIRST,
      // before this rename risks REPLACING it (POSIX rename() atomically
      // replaces an existing destination file; reading after would find only
      // the fresh half, with the orphaned half gone without a trace).
      let orphanedTouches = [];
      if (existsSync(touchesClaimPath)) {
        try {
          orphanedTouches = parseTouchesContent(readFileSync(touchesClaimPath, 'utf8'));
        } catch {
          orphanedTouches = [];
        }
      }
      let freshTouches = [];
      try {
        renameSync(touchesPath, touchesClaimPath);
        freshTouches = parseTouchesContent(readFileSync(touchesClaimPath, 'utf8'));
      } catch (e) {
        if (e && e.code !== 'ENOENT') throw e; // a real fs failure escapes to the outer catch (fail loud)
      }
      touches = [...orphanedTouches, ...freshTouches];
      // Persist the UNION back to the claim file immediately when there was
      // anything to adopt: a crash right after this point must find the
      // WHOLE set, not just whichever half the rename happened to leave on
      // disk (the rename above just overwrote any on-disk orphaned bytes
      // with the fresh half alone).
      if (orphanedTouches.length) writeFileSync(touchesClaimPath, JSON.stringify(touches));
    },
    { onTimeout: () => store.recordCheckSkipped('h10-touches-lock', 'lock_timeout', undefined, now) }
  );
  // TOUCHES FROM GIT (slice 4, board 400f578b): union the register with the
  // paths git reports changed since the persisted settled snapshot, so a hand
  // or Bash edit arms the same duties and settlement candidates an Edit does
  // (state, first-run baseline and advancement rules: lib/settlement.mjs
  // gitTouches). A register path git TRACKS and reports unchanged since the
  // snapshot is dropped — an Edit that left the bytes as settled owes
  // nothing. Git candidates live only in memory: they are re-derived every
  // Stop until writeGitSettled (runSettlement, below) advances the snapshot,
  // so the claim file still carries exactly what H7 wrote. No git degrades
  // loud to the register alone (the pre-slice behaviour).
  const git = gitTouches(input.cwd, now);
  let lostSettlementMessage = '';
  if (!git.ok) {
    skipRow('h10-git-touches', git.reason);
  } else if (git.settled) {
    if (git.base_lost) {
      skipRow('h10-git-touches', `settled_sha_unreachable:${git.settled.sha}`);
      lostSettlementMessage = `⚠ H10 SETTLEMENT HISTORY REWRITTEN: persisted SHA ${git.settled.sha} is unreachable from HEAD ${git.next.sha}. Duties for commits between them could not be derived; reconcile them by hand from git log.`;
    }
    const unchanged = [...new Set(touches.map((t) => t?.path).filter(Boolean))].filter((p) => !git.changed.has(p));
    const tracked = gitTrackedSubset(input.cwd, unchanged) ?? new Set();
    touches = touches.filter((t) => !tracked.has(t?.path));
    const registered = new Set(touches.map((t) => t?.path));
    touches = [...touches, ...git.candidates.filter((c) => !registered.has(c.path))];
  }
  // Disposes the claimed copy once its debt is settled/nagged. Locked (micro-
  // round fixer): a concurrent Stop's claim/union write must not race a
  // delete of the SAME claim file — without the lock, one Stop could rename
  // a fresh touch onto touchesClaimPath (widening the union) while another
  // Stop's discard deletes that exact file out from under it, losing the
  // widened union with no trace.
  const discardTouchesClaim = () => {
    withFileLock(
      touchesPath,
      () => rmSync(touchesClaimPath, { force: true }),
      { onTimeout: () => store.recordCheckSkipped('h10-touches-lock', 'lock_timeout', undefined, now) }
    );
  };
  // R4(b): gives the claim back for the next Stop to retry WITHOUT a
  // read-modify-write against the live touchesPath — the prior version read
  // whatever a racing H7 had already written there, merged it with the
  // claim, and wrote the merge back, which could itself clobber an H7 append
  // landing in THAT window. When nothing currently sits at the live path
  // (the common case), a bare RENAME back is a pure metadata op: no bytes
  // are read or computed, so nothing can be clobbered, and the claimed
  // content lands back under its original filename byte-for-byte. When a
  // racing H7 HAS recreated the live path, renaming onto it would destroy
  // that fresh append instead — so in that case this does nothing at all:
  // the claim stays exactly where it is, and the NEXT Stop's claim step
  // above (R4(a)) unions it with whatever is live then. Locked (same lock as
  // the claim above) since this is also a live-path write.
  const releaseTouchesClaim = () => {
    withFileLock(
      touchesPath,
      () => {
        // Nothing was ever claimed (no touches this Stop at all): a no-op,
        // never a rename of a file that does not exist.
        if (existsSync(touchesClaimPath) && !existsSync(touchesPath)) renameSync(touchesClaimPath, touchesPath);
      },
      { onTimeout: () => store.recordCheckSkipped('h10-touches-lock', 'lock_timeout', undefined, now) }
    );
  };
  // F3 (board c198866d fixer round): a settlement failure must PRESERVE the
  // claimed touches for a retry at the next Stop, not silently discard them —
  // set by runSettlement() below, consumed by clearRegisters().
  let settlementFailed = false;

  // Read session events; degrade to empty on parse failure (phase-1 advisory:
  // H16 appends without schema-validating, so malformed bytes are possible).
  let sessionEvents = [];
  try {
    if (existsSync(eventsPath)) {
      const raw = JSON.parse(readFileSync(eventsPath, 'utf8'));
      if (Array.isArray(raw)) sessionEvents = raw;
    }
  } catch {
    sessionEvents = [];
  }

  // FAN-OUT-AWARE DUTY DEFERRAL (decision foreign_ec9eacaa; register maintained by H22
  // on SubagentStart/SubagentStop). A live dispatch OWNS the files it is
  // mid-writing: demanding their capture or their owning article at the
  // conductor's Stop reads agent work-in-progress as conductor negligence
  // (board 570832d4 — the same capture_pending minted three times in one hour).
  // An entry is LIVE iff it belongs to THIS session and its age is under
  // config.dispatch_register.stale_minutes; a STALE entry defers nothing and
  // says so loudly (P5): SubagentStop was never probed for killed/aborted
  // subagents (research_finding foreign_20b44518), so the TTL is what stops an orphan
  // entry deferring a duty forever. Absent/malformed register degrades to empty
  // — byte-identical to the behavior before this block existed (the same
  // posture session-events.json takes above).
  // §6 H10 existence filter, hoisted here because both partitions need it: only
  // files that STILL EXIST drive a duty — a file created and then deleted within
  // the session (e.g. a throwaway) leaves a stale H7 touch entry but needs no
  // owner and no capture. (raw rm leaves the H7 entry stale; fs-remove does not —
  // that asymmetry is the gap this guards.)
  // The Array.isArray guard keeps this hoist behavior-neutral: an object-shaped
  // touches.json used to reach the entry gate (and release cleanly) before any
  // .map() ran, and it still does.
  const touchedExisting = [...new Set((Array.isArray(touches) ? touches : []).map((t) => t?.path).filter(Boolean))].filter((p) =>
    existsSync(join(input.cwd, p))
  );
  // ONE source of truth for the threshold: the zod default (60) lives in
  // config.dispatch_register, so a missing field is a real defect that fails
  // loud into the catch below rather than silently reverting policy to a second
  // literal maintained here.
  const staleMinutes = config.dispatch_register.stale_minutes;
  const nowMs = Date.parse(now);

  // TRI-STATE CONSUMER POLICY (contract sheet §1.1; R1 rebuild). classifyRegister
  // is the ONE owner classifier: presumed-active | unknown | inactive-confirmed.
  // presumed-active EXCLUDES its declared files from this duty; unknown NEVER
  // excludes (an expired lease is not a licence to defer) and is disclosed
  // per-entry with [dispatch_status_unknown]; inactive-confirmed is IGNORED
  // entirely (the round is over, nothing to settle, P1: no ceremony). A
  // corrupt register excludes nothing and is disclosed once with
  // [register_unavailable]; an ABSENT register stays silent — H10 never
  // enumerates a register that plainly does not exist.
  const classified = classifyRegister(input.cwd, { now: nowMs, sessionId: input.session_id, staleMinutes });
  // Flat presumed-active entry list — consumed further down by the
  // capture_pending "does the declared target name a live dispatch"
  // heuristic (namesLiveTarget/pendingTargetLive), a SEPARATE question from
  // the file-deferral join above (who owns THIS touched path).
  const liveDispatches = classified.availability === 'ok' ? classified.entries.filter((r) => r.status === 'presumed-active').map((r) => r.entry) : [];

  // Research-event classification, hoisted here (ahead of clearRegisters()'s
  // definition below, which consumes hasDeferredResearchEvents) so every
  // reference to it executes after this `const` initializes — a call to
  // clearRegisters() can fire before touch/debug classification below runs.
  const researchAgents = new Set(config.session_events?.research_agents ?? ['researcher', 'claude-code-guide']);
  const researchEvents = sessionEvents.filter(
    (e) => e.kind === 'research_tool' || (e.kind === 'agent_dispatch' && researchAgents.has(e.detail))
  );
  // RESEARCH RETURN GATE (user-ruled 2026-09-22, "wait for return"): H10 must not
  // raise the research duty for a DISPATCHED research/scout agent while that
  // agent is still running — demanding a research_finding/no_capture before the
  // agent has reported asks for a write-up of work that does not exist yet.
  // `agent_dispatch` events in session-events.json carry only {kind, detail, at}
  // (H16, out of this fix's scope) — no agent_id — so an event cannot be joined
  // to the ONE register entry it came from. The gate is therefore lane-wide
  // rather than per-dispatch: while ANY presumed-active H22 register entry
  // (same session, age < config.dispatch_register.stale_minutes) names a
  // CONFIGURED research agent type, every `agent_dispatch` research event
  // defers as a block, exactly as though it had not fired yet — with two
  // outstanding research dispatches, one returned and one still running, the
  // whole lane stays quiet until BOTH leave presumed-active (chosen semantics;
  // disclosed because no join key exists to release the returned one alone).
  // `research_tool` events (WebSearch/WebFetch) are NEVER gated — those calls
  // are synchronous conductor actions, already complete by construction.
  // NARROWER than decision foreign_ec9eacaa's rejected "defer research/concept
  // duties when ANY dispatch is live": that alternative was rejected because a
  // live FILE-owning dispatch has nothing to do with a file-less research debt;
  // this gate fires only for a dispatch that IS ITSELF a configured research
  // agent — the actual source of the pending duty, not an unrelated one. Bounded
  // exactly like the file deferral: once the lease expires (default 60m) with no
  // SubagentStop, the entry drops out of presumed-active and the duty re-arms
  // rather than deferring forever (P5) — an unattributed agent_id (H22
  // 'unattributable') still lands in the register with a null agent_type, which
  // never matches `researchAgents.has(...)`, so it can never gate this lane.
  const researchDispatchLive = liveDispatches.some((e) => researchAgents.has(e.agent_type));
  // A gated agent_dispatch event's debt cannot evaporate (P5 / decision
  // b2474b26 stop-consumes-settled-and-queued-work-never-live-declarations):
  // session-events.json must survive a quiet Stop it deferred, exactly as
  // touches.json survives one deferred by a live file-owning dispatch, or the
  // event that would re-arm the duty on the agent's return is lost the moment
  // this Stop clears the register. Consumed by clearRegisters() below.
  const hasDeferredResearchEvents = researchDispatchLive && researchEvents.some((e) => e.kind === 'agent_dispatch');

  // Worktree subagents record their touches under
  // .claude/worktrees/<name>/<repo-relative path> (anti_pattern foreign_b3972717) while
  // the dispatch prompt names the plain repo-relative path — an exact-string
  // join would therefore miss the heaviest fan-out shape there is. The prefix is
  // stripped for COMPARISON ONLY: touches.json keeps exactly what H7 wrote.
  const WORKTREE_PREFIX_RE = /^\.claude\/worktrees\/[^/]+\//;
  const joinKey = (p) => String(p ?? '').replace(WORKTREE_PREFIX_RE, '');
  const deferredOwners = new Map(); // repo-relative path -> Set(owning agent_id)
  const unknownRows = [];
  if (classified.availability === 'ok') {
    for (const row of classified.entries) {
      if (row.status === 'presumed-active') {
        for (const f of Array.isArray(row.entry.files) ? row.entry.files : []) {
          const k = joinKey(f);
          if (!deferredOwners.has(k)) deferredOwners.set(k, new Set());
          deferredOwners.get(k).add(row.entry.agent_id);
        }
      } else if (row.status === 'unknown') {
        unknownRows.push(row);
      }
      // inactive-confirmed: ignored entirely — no exclusion, no disclosure.
    }
  }
  const isDeferred = (p) => deferredOwners.has(joinKey(p));
  // R5(a) (board c198866d round-3 fixer): the FULL, UNFILTERED touch set —
  // deliberately NOT touchedExisting (which is existsSync-filtered). Both
  // deferredPaths and settlementCandidates below derive from this, because a
  // DELETED path a live dispatch still owns must count as deferred: if
  // deferredPaths were existence-filtered, that same deleted+deferred path
  // would vanish from BOTH deferredPaths (so clearRegisters() sees "nothing
  // deferred" and discards the claim) AND settlementCandidates (correctly
  // excluded from minting because it IS still deferred) — losing its debt
  // with no trace, settled nowhere and preserved nowhere.
  const allTouchedPaths = [...new Set((Array.isArray(touches) ? touches : []).map((t) => t?.path).filter(Boolean))];
  const deferredPaths = allTouchedPaths.filter(isDeferred);
  // SETTLEMENT CANDIDATE SET (F1, board c198866d fixer round): unlike `paths`
  // below (used for the capture/article-demand duties, which correctly
  // ignore a deleted throwaway per AC10), a DELETED governed file is itself
  // DRIFT — its deletion is the reconcile debt — and must still reach the
  // settlement predicate so it can mint. No existsSync filter here; only a
  // path a live dispatch still owns (isDeferred) is excluded, matching the
  // duty set's own exclusion.
  const settlementCandidates = allTouchedPaths.filter((p) => !isDeferred(p));
  const deferredAgents = [...new Set(deferredPaths.flatMap((p) => [...deferredOwners.get(joinKey(p))]))];
  // Disclosure, not a demand: rides whatever release/deny the duties below
  // produce. Deliberately avoids the article-demand and capture-nag wording —
  // a deferred duty is not owed to the conductor right now.
  const disclosureParts = [];
  if (lostSettlementMessage) disclosureParts.push(lostSettlementMessage);
  if (residueLines.length) disclosureParts.push(...residueLines);
  if (deferredPaths.length) {
    // Board cdaf2824 (residual build, 2026-08-31): a count-only disclosure
    // beside a path-specific article demand asserts no identity between the
    // two, which manufactured false defect reports in two unrelated projects
    // — the reader could see a file was deferred and a file was demanded, but
    // not whether they were the same file. Name the deferred PATHS themselves
    // (repo-relative, comma-separated), capped so a wide fan-out cannot flood
    // the Stop message: past PATH_DISPLAY_CAP, show the first N and "+K more".
    const PATH_DISPLAY_CAP = 8;
    const pathsDisplay =
      deferredPaths.length > PATH_DISPLAY_CAP
        ? `${deferredPaths.slice(0, PATH_DISPLAY_CAP).join(', ')} +${deferredPaths.length - PATH_DISPLAY_CAP} more`
        : deferredPaths.join(', ');
    disclosureParts.push(
      `• deferred: ${deferredPaths.length} file(s) owned by live dispatch(es) [${deferredAgents.join(', ')}]: ${pathsDisplay} — duty re-arms when they land ` +
        `(repeats by design while the dispatch(es) stay live — fan-out-aware duty deferral; not a stuck nag)`
    );
  }
  // UNKNOWN — disclosed WITHOUT excluding. Only named when it actually bites
  // something this Stop touched: an unknown owner of an untouched file changes
  // no outcome and would repeat byte-identically every Stop (board cac61a95
  // noise shape, P1) — decision foreign_ee8ab1f5 governs FREQUENCY and WORDING only,
  // never which entries qualify, so this qualification is unchanged. The
  // once-per-session key dedup (point C) applies ON TOP of biting: a note
  // fires only when the row bites AND its key is not yet spent this session.
  const touchedKeys = new Set(touchedExisting.map(joinKey));
  const bitingUnknown = unknownRows.filter((row) => (Array.isArray(row.entry.files) ? row.entry.files : []).some((f) => touchedKeys.has(joinKey(f))));
  // FIX 2 (review round, re-applied): `raw.session_id !== input.session_id`
  // passes when BOTH are undefined, so an absent session_id was never
  // actually excluded — hasSession gates the reader, the writer AND the
  // duty-nagged spend callback below, all off this ONE check.
  const hasSession = typeof input.session_id === 'string' && input.session_id.length > 0;
  const dispatchUnknownNotedPath = join(input.cwd, '.sterling', 'transient', 'dispatch-unknown-noted.json');
  const dispatchUnknownNotedKeys = (() => {
    if (!hasSession) return new Set(); // absent session_id: never salvaged (point E), read skipped entirely
    try {
      const raw = JSON.parse(readFileSync(dispatchUnknownNotedPath, 'utf8'));
      if (raw.session_id !== input.session_id) return new Set(); // foreign session: never salvaged (point E)
      if (!Array.isArray(raw.keys) || !raw.keys.every((k) => typeof k === 'string')) return new Set();
      return new Set(raw.keys);
    } catch {
      return new Set();
    }
  })();
  // key = sha256([agent_id, round, registered_at]) — never a raw '|' concatenation.
  const dispatchUnknownKey = (row) =>
    createHash('sha256')
      .update(JSON.stringify([row.entry.agent_id, row.entry.round ?? null, row.entry.at ?? null]))
      .digest('hex');
  const pendingDispatchUnknownKeys = [];
  for (const row of bitingUnknown) {
    const key = dispatchUnknownKey(row);
    if (dispatchUnknownNotedKeys.has(key)) continue;
    pendingDispatchUnknownKeys.push(key);
    disclosureParts.push(
      render(
        disclosure(
          'dispatch_status_unknown',
          { agent_id: row.entry.agent_id, reason: row.reason },
          `${formatDispatchRef(row)} — settle via SubagentStop/TaskStop (unknown ownership excludes nothing)`
        )
      )
    );
  }
  // Spent only AFTER the disclosure has actually been delivered (point D) —
  // called from the exit-0 systemMessage release above and the duty-nag deny
  // below, never before either write. Self-catching: a marker WRITE failure
  // is caught and ignored (point E), never escalated.
  const spendDispatchUnknownKeys = () => {
    if (!hasSession) return; // FIX 2: never persist a sessionless note
    if (!pendingDispatchUnknownKeys.length) return;
    try {
      const merged = new Set(dispatchUnknownNotedKeys);
      for (const k of pendingDispatchUnknownKeys) merged.add(k);
      writeFileSync(dispatchUnknownNotedPath, JSON.stringify({ session_id: input.session_id, keys: [...merged] }));
    } catch {
      // best-effort — the next Stop simply re-notes the same key
    }
  };
  // A11: 'absent' is anomalous only after H1 has run (which now writes `[]`
  // instead of deleting) and today's un-rebuilt fixtures still exercise a
  // genuinely-missing file — silence is the byte-identical posture; only
  // 'corrupt' is worth a line (an all-clear would be a false claim).
  if (classified.availability === 'corrupt') {
    disclosureParts.push(
      render(
        disclosure(
          'register_unavailable',
          { availability: classified.availability },
          `dispatch register unavailable (${classified.availability}) — nothing excluded, no holder can be judged`
        )
      )
    );
  }

  // Clear the transient registers at the end of the work they represent (P4).
  // INVARIANT: at a Stop, settled work may be consumed, durably queued work may
  // be consumed, and outstanding work plus still-effective declarations MUST
  // survive; `capture_pending` is still effective because it covers later
  // capture work, whereas no_capture only discharges earlier work and
  // research/dispatch events are work evidence. This does not guarantee that a
  // later work item is satisfied by an earlier durable record, nor that a
  // declaration survives a real session boundary, which H1 owns.
  // FAN-OUT DEFERRAL EXCEPTION (decision foreign_ec9eacaa, on the capture_pending
  // precedent bd594c03): while a live dispatch owns any touched file this
  // release is NOT terminal — clearing would delete the very touch entries
  // whose duty has to re-arm once the dispatch lands. The debt cannot
  // evaporate: the entry leaves via H22's SubagentStop, goes stale on the TTL,
  // or is swept into queue debt by H1's session-boundary residue pass.
  //
  // The exception covers the two WORK registers ONLY — the NAG MARKER clears on
  // every release exactly as it did before the deferral existed. Preserving it
  // would permanently spend the once-per-session inline-demand stage: every
  // later genuine duty (a new unowned file, a new concept design — none of them
  // deferred) would land silently as queue debt, and a capture_pending declared
  // afterwards would see the stale marker and mint capture_owed on its FIRST
  // pending Stop, destroying the grace bd594c03 deliberately built. Repeat nags
  // while a deferral is live are bounded by enqueueSystemTodo's dedup — noise is
  // acceptable, silence is not.
  const clearRegisters = ({ preservePendingDeclaration = false } = {}) => {
    // F3/F4/R4 (board c198866d fixer round): the touches claim is RELEASED
    // (see releaseTouchesClaim above) rather than discarded whenever a live
    // dispatch still owns work OR this Stop's own settlement attempt failed —
    // a settlement failure must never silently lose the candidates it could
    // not settle (F3). The events register and nag marker are UNAFFECTED by
    // settlementFailed — only touches.json gets the preservation exception
    // (F3: "not the other registers").
    if (deferredPaths.length || settlementFailed) {
      releaseTouchesClaim();
    } else {
      discardTouchesClaim();
    }
    // RESEARCH RETURN GATE EXTENSION: a live research-agent dispatch defers
    // its OWN agent_dispatch event(s) the same way deferredPaths defers a
    // touch — session-events.json must survive UNTOUCHED, not just reduced to
    // any surviving capture_pending declaration, or the event that re-arms the
    // research duty once the agent returns is destroyed by this very release.
    if (!deferredPaths.length && !hasDeferredResearchEvents) {
      // A quiet Stop has consumed no capture work, so a capture_pending
      // declaration remains live for work that arrives later in this session.
      // Do not retain settled work evidence: research satisfaction anchors to
      // the earliest remaining event, so that would let an earlier capture
      // silently satisfy later research.
      const pendingDeclarations = preservePendingDeclaration
        ? sessionEvents.filter((e) => e.kind === 'capture_pending' && e.detail)
        : [];
      if (pendingDeclarations.length) {
        writeFileSync(eventsPath, JSON.stringify(pendingDeclarations));
      } else {
        rmSync(eventsPath, { force: true });
      }
    }
    rmSync(nagMarker, { force: true });
  };

  // SETTLEMENT BOUNDARY (a) (board c198866d, H7 CANDIDATE-ONLY + SETTLEMENT-TIME
  // MINTING): H7's direct-mode Arm 1 only registers CANDIDATE paths now — this
  // is where reconcile_needed actually mints, hashing each candidate's CURRENT
  // content (or its ABSENCE — F1: a deleted governed file is drift too)
  // against its owning article's CURRENT baseline, so anything this turn's
  // capture/reconcile knowledge_update calls (or an attested close, R9)
  // already rebaselined, or an edit-then-revert, never mints. F6: called
  // ONLY from the three
  // duties-satisfied release sites below — settlement is the design's "Stop
  // AFTER capture/reconcile writes", so a Stop that is about to NAG or queue
  // an owed/missing item (duties still outstanding) never mints here; its
  // candidates simply ride the claim through to the next Stop (or, if the
  // session ends, to direct-merge's pre-merge backstop / H7's Arm 2 read-time
  // drift as the residual net — the design's NAMED HOLE). Advisory in its own
  // try (F3): a settlement failure records check_skipped (itself guarded — a
  // store failure recording the skip must never escape to the outer catch and
  // cost every other session-end duty) and marks settlementFailed so
  // clearRegisters() preserves the claim for a retry, instead of costing the
  // duty checks below or losing the candidates.
  const runSettlement = () => {
    try {
      mintSettlementReconcile(store, input.cwd, settlementCandidates, now);
      // A rewritten range has no trustworthy commit delta.  We deliberately
      // use capture_owed, the established settlement queue path, and key its
      // text to the lost/current SHAs so retries do not mint duplicates.
      if (git.ok && git.base_lost) {
        const text = `capture owed: settlement history rewritten — persisted SHA ${git.settled.sha} is unreachable from HEAD ${git.next.sha}; duties for commits between them could not be derived. Reconcile them by hand from git log.`;
        const exists = store.query({ types: ['todo'], cap: 1000 }).some((t) => t.source === 'system' && t.system_reason === 'capture_owed' && t.text === text);
        if (!exists) store.enqueueSystemTodo({ id: randomUUID(), type: 'todo', created_at: now, updated_at: now, author: 'system', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], text, source: 'system', system_reason: 'capture_owed', file_keys: [] });
      }
      // Advance the git snapshot ONLY after the range's duties minted, and
      // never past a path a live dispatch still owns (its debt must re-derive
      // once the dispatch lands). A throw here marks settlementFailed like a
      // mint failure — the snapshot stays put and the next Stop retries.
      if (git.ok && !deferredPaths.length) writeGitSettled(input.cwd, git.next);
    } catch (e) {
      settlementFailed = true;
      try {
        store.recordCheckSkipped('h10-settlement-mint', String((e && e.message) || e), undefined, now);
      } catch {
        // recording the skip is itself best-effort — see the comment above
      }
    }
  };

  // Dual-register entry: proceed only if either register has content.
  if (!touches.length && !sessionEvents.length) {
    runSettlement();
    clearRegisters();
    releaseWithPressure();
  }

  // Article-demand input set: existing touched files MINUS the ones a live
  // dispatch owns (the existence filter itself is applied above, where the
  // deferral partition needs it too).
  const paths = touchedExisting.filter((p) => !isDeferred(p));

  // Canonical-timestamp guard, shared by EVERY register-`at` comparison below —
  // the no_capture cutoff, the test-repair cutoff, the capture/research window
  // anchors and the concept window (FIX L2, upgrade-polish review 2026-08-21;
  // extended 2026-08-22). (The dispatch register's `at` above is the one
  // exception by design: ageMs compares it NUMERICALLY through Date.parse and
  // already treats an unparseable value as stale, i.e. defers nothing.)
  //
  // Register timestamps are compared LEXICALLY, so a non-ISO value is not merely
  // unparseable — it sorts arbitrarily against real stamps ('n/a' above every ISO
  // stamp, '0' below every one of them). Date.parse alone is NOT the right
  // validity test — V8 parses '0' as year 2000 (finite!) while the string '0'
  // still sorts below every ISO stamp.
  //
  // The shape is therefore the FULL canonical `Date#toISOString()` form, not a
  // loose ISO prefix (outside re-review 2026-08-22): a prefix test admits values
  // whose lexical order is NOT chronological order, which every comparison here
  // silently assumes. Two concrete inversions it let through — an offset stamp
  // '2026-08-22T08:00:00.000-05:00' happened at 13:00Z, i.e. AFTER
  // '2026-08-22T12:00:00.000Z', yet sorts before it; and variable precision puts
  // '…T12:00:00.500Z' BELOW '…T12:00:00Z' ('.' < 'Z'). Pinning UTC + fixed
  // milliseconds makes lexical order chronological BY CONSTRUCTION.
  //
  // Verified 2026-08-22 that this rejects no live data: every writer of both
  // registers stamps `new Date().toISOString()` — scripts/hooks/h7-file-touch.mjs
  // (touches), scripts/hooks/h16-event-register.mjs, scripts/debug-scope.mjs,
  // scripts/no-capture.mjs, scripts/concept-designed.mjs, scripts/test-repair.mjs,
  // and the MCP tool surface's own appender (packages/mcp-server/src/tools.ts,
  // whose injectable `now` defaults to the same call).
  const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const isValidAt = (a) => typeof a === 'string' && ISO_AT.test(a) && Number.isFinite(Date.parse(a));

  // Classify session events.
  const debugEvents = sessionEvents.filter((e) => e.kind === 'debug_scope');
  // Concept duty (decision foreign_7208729b): concept_designed events, deduped to the
  // EARLIEST event per family — detail is the concept FAMILY slug.
  // FAIL-CLOSED on a missing/malformed `at` (2026-08-22): the old `e.at ?? now`
  // invented an anchor. A literal '0' sank the family's window below every
  // article timestamp, so an article written months earlier satisfied the duty;
  // and `?? now` handed a MISSING `at` the 15-minute pre-event grace window
  // below, letting an article written minutes before an event of unknown time
  // satisfy it. An event whose time is unknown anchors NOTHING: it is ignored in
  // favour of the family's earliest VALID `at` (ignoring it can only move the
  // window LATER — the strict direction), and a family with no valid `at` at all
  // carries a null anchor and is demanded unconditionally below.
  const conceptEvents = sessionEvents.filter((e) => e.kind === 'concept_designed' && e.detail);
  const conceptFamilies = new Map(); // family -> earliest VALID at, or null when the family has none
  for (const e of conceptEvents) {
    const at = isValidAt(e.at) ? e.at : null;
    if (!conceptFamilies.has(e.detail)) {
      conceptFamilies.set(e.detail, at);
      continue;
    }
    const prior = conceptFamilies.get(e.detail);
    if (at !== null && (prior === null || at < prior)) conceptFamilies.set(e.detail, at);
  }

  // No-capture declaration (board 7bbec3bd): scripts/no-capture.mjs and the
  // no_capture MCP tool append a no_capture event the moment the conductor
  // judges a Stop produced nothing durable. It SATISFIES the duty for every
  // touch/debug_scope/research event EARLIER than the LATEST such declaration
  // ON THAT EVENT'S LANE; work arriving AFTER it re-arms the duty (a
  // declaration cannot cover work that hasn't happened yet). A missing/malformed
  // `at` is treated as arriving AFTER the cutoff — the safe direction, since it
  // keeps the duty armed rather than silently clearing it. That promise binds
  // all THREE registers uniformly (touches, debug events, research events):
  // each one is tested through the lane-scoped discharge helpers below, which
  // share ONE comparison, so none of them can discharge itself on a timestamp
  // it cannot compare.
  //
  // LANE SCOPING (decision no-capture-discharge-is-lane-scoped,
  // 51ebe0dd-099e-40a9-abc5-d3c8cc767883; USER-RULED 2026-08-22, superseding the
  // single global cutoff item 353416a9's first fix introduced). A declaration's
  // `lane` says WHICH duty it claims: 'capture' covers touches + debug events,
  // 'research' covers research events, 'all' covers both. There are therefore
  // TWO cutoffs, one per lane, each the latest declaration COVERING that lane.
  // WHY: one global cutoff made a locally-TRUE declaration a globally-FALSE one
  // — genuine research at 10:00 whose write-up is deferred, a trivial touch at
  // 11:00, then a truthful `--reason "typo fix, nothing durable"` at 11:05
  // silently cleared the 10:00 research duty, dropped the research_owed enqueue
  // and lost the knowledge with no trace (P5 fail-loud, P2 the KB is the
  // product: silent knowledge loss is the severe direction, so an ambiguous
  // scope leaves the duty ARMED).
  //
  // A no-lane event reads as 'capture' — the bare declaration's pre-2026-08-22
  // behavior, and the ONLY safe reading of a LEGACY event written before the
  // field existed: it must not silently gain research-clearing power it never
  // had. An event carrying an UNRECOGNIZED lane covers NOTHING (null): both
  // producers refuse an invalid lane before writing, so such a value on disk is
  // corruption, and the same fail-closed rule that governs an uncomparable `at`
  // governs an unreadable scope — never widen a discharge on data you cannot
  // read.
  const NO_CAPTURE_LANES = ['research', 'capture', 'all'];
  const laneOf = (e) => {
    if (e.lane === undefined || e.lane === null) return 'capture';
    return NO_CAPTURE_LANES.includes(e.lane) ? e.lane : null;
  };
  //
  // The CUTOFF itself must be a canonical stamp before it can discharge anything
  // (2026-08-22): a declaration carrying 'n/a' sorts ABOVE every ISO stamp
  // ('n' > '2') and, taken as the cutoff, discharged every event in the session.
  // With no VALID declaration covering a lane its cutoff is null and nothing on
  // that lane is discharged.
  const noCaptureEvents = sessionEvents.filter((e) => e.kind === 'no_capture');
  const cutoffForLane = (lane) =>
    noCaptureEvents
      .filter((e) => {
        const declared = laneOf(e);
        return declared === lane || declared === 'all';
      })
      .map((e) => e.at)
      .filter(isValidAt)
      .sort()
      .at(-1) ?? null;
  const captureLaneCutoff = cutoffForLane('capture');
  const researchLaneCutoff = cutoffForLane('research');
  // The discharge test, applied per touch and per event AGAINST ITS OWN LANE'S
  // cutoff: covered only when its OWN `at` is a canonical stamp at or before
  // that cutoff. A missing or malformed `at` is therefore NOT covered — it
  // arrives after every cutoff by construction, which is what the paragraph
  // above promises (the earlier `x.at && x.at > latestNoCapture` idiom filtered
  // such a record OUT, i.e. silently treated the duty it carried as discharged).
  // ONE comparison, two bound helpers: lane scoping changes WHICH cutoff a duty
  // is measured against, never HOW the stamps are compared.
  const dischargedByCutoff = (at, cutoff) => cutoff !== null && isValidAt(at) && at <= cutoff;
  const dischargedOnCaptureLane = (at) => dischargedByCutoff(at, captureLaneCutoff);
  const dischargedOnResearchLane = (at) => dischargedByCutoff(at, researchLaneCutoff);

  // Capture-pending declaration (board 1af5d630, decision follows foreign_e23f38f8):
  // the capture EXISTS and its write is in flight on a named target (detail =
  // "<target> — <reason>"). Unlike no_capture it covers LATER work too — the
  // whole point is that new work keeps arriving while the capture rides a
  // pending commit, and per-batch re-declaration is the boilerplate loop that
  // trains false declarations (six in ~90 minutes, measured 2026-08-09).
  // Safe because the debt cannot evaporate: the deferral below either settles
  // on a landed write or converts to a deduped capture_owed item.
  const capturePendingEvents = sessionEvents.filter((e) => e.kind === 'capture_pending' && e.detail);
  const pendingDetail = capturePendingEvents.length ? capturePendingEvents.map((e) => e.detail).at(-1) : null;

  // IS THE NAMED TARGET STILL A LIVE DISPATCH? (board cb457cbd, built on the
  // fan-out-aware deferral ec9eacaa.) The declaration names a target, and whether
  // that target is still running is a fact THIS hook already holds in the H22
  // register — so the conductor was hand-supplying it, re-typing an unchanged
  // declaration on every Stop (measured twice: three declarations in one session,
  // the last two restating the same in-flight lanes with no new substance). A
  // declaration that must be repeated verbatim is a declaration that stops being
  // read. The file lanes already re-arm on liveness; the capture lane never
  // inherited it. Consumed by the deferral block below.
  //
  // The detail is conductor FREE TEXT ('<target> — <reason>'), not a structured
  // reference, so the carry is decided by IDENTITY MATCHED EXACTLY, never by text
  // search. THE DETAIL IS TOKENIZED ONCE (whitespace split, surrounding shell/prose
  // decoration stripped) and an entry counts as the named target only when its
  // AGENT_ID — the one value that identifies a dispatch and nothing else — EQUALS
  // a whole token of the declaration.
  //
  // TWO REVIEWERS, 2026-08-29, one of them outside-family: the previous
  // `haystack.includes(t)` form over {agent_id, agent_type, declared files} was an
  // UNANCHORED SUBSTRING test on free text — the exact shape of the block-severity
  // anti-pattern `unanchored-substring-allowlist-in-command-guard` (a suppression
  // granted because a name APPEARS IN text rather than IS the referent). All three
  // keys were broken, each in its own way:
  //   - AGENT_TYPE names a CLASS, not a target, so ANY live same-type entry
  //     impersonated the landed one ('coder' also matching 'encoder'/'decoder',
  //     which no length floor can help with — the false positives are ordinary
  //     5-9 character words). REMOVED: no matching form turns a class into an
  //     identity.
  //   - AGENT_ID matched by substring, so unrelated sequential lane ids collide
  //     in both directions (sub-lane-1 and sub-lane-104 vs sub-lane-10). KEPT,
  //     but compared as a WHOLE TOKEN: a prefix relation is not identity.
  //   - A DECLARED FILE matched when its path merely appeared in the reason —
  //     and a capture_pending reason routinely names the file the capture is
  //     about while an unrelated lane legitimately holds it open. REMOVED: a
  //     file named in a reason is SUBJECT MATTER, not an owner. (The file
  //     deferral above still joins touched paths to live entries; that is a
  //     different question — who owns this file — asked of the register, not of
  //     conductor prose.)
  // THE KILL SCENARIO that made this silent knowledge loss: detail
  // 'coder sub-target — capture auth findings'; sub-target LANDS and H22 removes
  // its entry; an unrelated live {agent_id:'sub-other', agent_type:'coder'}
  // remains; the substring 'coder' still matched, pendingTargetLive stayed true,
  // the carry branch released non-terminally, and NO capture_owed was ever minted.
  // Rolling replacement lanes defeat the TTL indefinitely — there is no background
  // sweep — so the declaration was carried forever and the debt never recorded.
  // A declaration that names no live agent_id simply falls back to the prior
  // two-Stop cadence: a missed match costs one queue item (the safe direction),
  // a false match MUTES a real duty. Tokens under 3 chars are ignored so a
  // degenerate agent_id cannot match an ordinary short word.
  const pendingTokens = new Set(
    String(pendingDetail ?? '')
      .split(/\s+/)
      .map((t) => t.replace(/^[`'"([{<]+/, '').replace(/[`'")\]}>,;:.]+$/, '').trim().toLowerCase())
      .filter(Boolean)
  );
  const namesLiveTarget = (e) =>
    typeof e.agent_id === 'string' &&
    e.agent_id.trim().length >= 3 &&
    pendingTokens.has(e.agent_id.trim().toLowerCase());
  const pendingTargetLive = Boolean(pendingDetail) && liveDispatches.some(namesLiveTarget);

  // Test-repair evidence (decision frozen-test-repair-signatures-plus-visible-repair):
  // scripts/test-repair.mjs records that the conductor repaired a demonstrably
  // buggy frozen test, with evidence, at a named path. The event SATISFIES the
  // capture duty for that path's touches EARLIER than the event — PER PATH,
  // unlike no_capture's global cutoff — so the sanctioned route H5's denial
  // now names actually quiets the duty it discharges (a satisfier the gate
  // ignores would be a false affordance). A later touch of the same path
  // re-arms the duty as usual.
  // The declared path is the detail's leading segment (test-repair.mjs writes
  // `<path> — <evidence>`) and must match the touch EXACTLY — a substring
  // match would let the free-text evidence, or a longer sibling path, silently
  // discharge the wrong file's duty (review finding 2026-08-21).
  // Both sides of the `>` go through isValidAt (outside re-review 2026-08-22).
  // This is a DISCHARGE cutoff exactly like no_capture's, so it inherits the same
  // fail-closed rule: a truthy-but-uncomparable stamp was accepted and compared
  // raw, and a corrupted event {at:'n/a'} sorts above EVERY ISO stamp ('n' > '2')
  // — it removed the touch from activeTouches and silently discharged its capture
  // duty. A repair event whose time cannot be read covers nothing, and a touch
  // whose own time cannot be read is never covered (it arrives after every
  // cutoff by construction) — both keep the duty ARMED.
  const testRepairEvents = sessionEvents.filter((e) => e.kind === 'test_repair' && e.detail && isValidAt(e.at));
  const coveredByTestRepair = (t) =>
    isValidAt(t.at) && testRepairEvents.some((e) => String(e.detail).split(' — ')[0].trim() === t.path && e.at > t.at);
  // Touch-noise precision (board 05e298f0): reading an image/binary file is
  // inspection, not knowledge-producing work — excluded from the CAPTURE
  // duty's touch set only (never the article-demand `paths` below, which
  // stays unfiltered per §6 H10's ownership join — an image in a MIXED session
  // still counts toward the article demand, AC2 of h10-touch-noise.test.mjs).
  // The one place this regex reaches the article lane is the `imageBinaryOnly`
  // exemption on the no-duty terminal release, which fires only when EVERY
  // touched path is an image — see the block there.
  const IMAGE_BINARY_EXT = /\.(png|jpe?g|gif|webp|pdf)$/i;
  // A file a LIVE dispatch owns leaves the capture trigger set too (decision
  // ec9eacaa) — dropped here rather than at activePaths so it cannot backdate
  // `earliest` either, which would anchor the captured-set window to work whose
  // duty is not owed yet.
  const activeTouches = touches
    .filter((t) => !dischargedOnCaptureLane(t.at))
    .filter((t) => !IMAGE_BINARY_EXT.test(t.path) && !isDeferred(t.path) && !coveredByTestRepair(t));
  const activePaths = [...new Set(activeTouches.map((t) => t.path))].filter((p) => existsSync(join(input.cwd, p)));
  const activeDebugEvents = debugEvents.filter((e) => !dischargedOnCaptureLane(e.at));
  // Item 353416a9 (measured 2026-08-22): research events had NO discharge route at
  // all, so a no_capture declared after them still left them re-nagging on the next
  // Stop — the nag's own "state nothing durable was learned" route was never wired
  // to the research check. The route now exists, but on the RESEARCH lane only
  // (decision no-capture-discharge-is-lane-scoped): a research event at or before
  // the latest `--lane research`/`--lane all` declaration is discharged; one
  // arriving AFTER it, one whose `at` is missing or malformed (never trusted as
  // comparable), or one facing only a capture-lane declaration keeps the duty armed.
  const activeResearchEvents = researchEvents.filter((e) => {
    // RESEARCH RETURN GATE (see the `researchDispatchLive` comment above): a
    // dispatched research agent's own event waits for its return before it can
    // arm the duty at all; a research_tool event is never gated.
    if (e.kind === 'agent_dispatch' && researchDispatchLive) return false;
    return !dischargedOnResearchLane(e.at);
  });

  // Capture duty: triggered by file-touching work OR debug-scope events not
  // already covered by a no-capture declaration.
  const hasCaptureDuty = activePaths.length > 0 || activeDebugEvents.length > 0;
  // capture_owed file_keys: CONTEXT, not the debt (item 40b378e8, classification
  // settled 2026-08-29). Unlike article_missing — where the file list IS what is
  // owed, which is why the cap was removed there — a capture_owed item's subject
  // is "this session ended without capture": the mint is gated on whether ANY
  // capture_owed is open, the lane sits outside UPDATE_RESOLVABLE_LANES, and a
  // `resolves` claim naming it is refused. The keys only tell the reader where to
  // look, so a cap on them costs no debt and the cap STAYS. It also has to stay
  // for now regardless: the second mint site (scripts/hooks/h1-session-start.mjs)
  // carries the identical cap, and two sites disagreeing about how much they
  // persist is worse than one disclosed cap on both.
  // What was actually wrong is that the truncation was SILENT (P5): 25 touched
  // paths became 20 keys with nothing said, and the capture_pending branch
  // carried no count at all. Both texts now state it when it bites.
  const owedKeys = activePaths.slice(0, 20);
  const clipped =
    activePaths.length > owedKeys.length
      ? ` (file list truncated: naming ${owedKeys.length} of ${activePaths.length} touched path(s))`
      : '';
  // Research duty: triggered by research events not covered by a no-capture
  // declaration (research_tool or configured agent).
  const hasResearchDuty = activeResearchEvents.length > 0;
  // Concept duty: a settled design must produce/refresh its concept article.
  const hasConceptDuty = conceptFamilies.size > 0;

  // §6 H10 ownership predicate — hoisted ABOVE the no-duty terminal release
  // below, because the live recompute that follows it must run on that release
  // too (review finding D, 2026-08-29). The release is reached whenever every
  // capture touch was discharged (a valid no_capture) with no research/concept
  // duty outstanding — a Stop that still TOUCHED files an open article_missing
  // item names. Recomputing below that release left exactly those Stops
  // re-stamping a stale item, so the earlier rationale comment ("reaches a
  // non-firing Stop") was describing a placement it did not have.
  // SCOPE: the ef206eca change moved only the RECOMPUTE up and left the DEMAND
  // muted on that release. That residual mute was item f4616312 hole 1 and is
  // CLOSED as of 2026-08-29 — `newUnowned`/`articleDemand` are now computed
  // just above the release too, and the release requires `!articleDemand`
  // (except for a genuinely image/binary-only session). See the block there.
  //
  // Ownership joins feature_article AND repo-located reference docs (§3.2.5) —
  // same join as H7; a governing document's owner is its reference_material
  // record, never a forced feature article (adjudicated 2026-06-12).
  // A record declaring a working_tree owns files in a DIFFERENT tree — it never
  // grants ownership of this root's same-named path (comsoft-juiced 2026-07-17).
  // ONE predicate, named because the live recompute below re-asks the SAME
  // question of an already-persisted item's file keys (board ef206eca): the
  // demand and the item it leaves behind must never be able to disagree about
  // what "owned" means.
  //
  // THE JOIN IS NO LONGER A WINDOW (issues log 2026-09-01: "demanded an article
  // for an OWNED file"). It used to run at cap: 25, so a path named by more than
  // 25 feature_article/reference_material records could have its owner ordered
  // out of the window and read as UNOWNED — a false demand whose remedy ("create
  // the owning article") writes a duplicate of the article that already owned it.
  // count() runs the SAME base filter query() does (types + file_keys, no
  // rank_terms here), so cap: total is the whole matched set by construction
  // rather than a bigger guess; total 0 skips the second call entirely. Store
  // failures still propagate exactly as before — the duty gate's own catch owns
  // the fail-loud direction, and the cap was never what made it safe.
  const ownersSeen = new Map();
  const ownerRows = (p) => {
    if (ownersSeen.has(p)) return ownersSeen.get(p);
    const filter = { types: ['feature_article', 'reference_material'], file_keys: [p] };
    const total = store.count(filter);
    const rows = total === 0 ? [] : store.query({ ...filter, cap: total });
    ownersSeen.set(p, rows);
    return rows;
  };
  const isUnowned = (p) => !ownerRows(p).some((r) => !r.working_tree);
  // What the join actually SAW for one demanded path — so a false demand is
  // diagnosable from the deny text alone instead of by re-running the query by
  // hand. "none" is the ordinary case; a row listed here was matched and then
  // EXCLUDED (it declares a working_tree, i.e. it owns another tree's copy of
  // this path), which is precisely the shape that looks like a hook defect.
  const ownerRowsNote = (p) => {
    const rows = ownerRows(p);
    if (!rows.length) return 'none';
    return rows
      .map((r) => `${r.slug ?? r.title ?? r.type} (${String(r.id).slice(0, 8)}${r.working_tree ? `, working_tree=${r.working_tree}` : ''})`)
      .join('; ');
  };
  /** Which of `list` git KNOWS RIGHT NOW — present in the INDEX (ls-files) or
   *  in HEAD (ls-tree). Two probes because either one alone answers a narrower
   *  question: a working-tree delete leaves the path in the index, while a
   *  `git rm` (staged or committed) leaves it only in HEAD, and either one means
   *  the path is still live territory.
   *
   *  THE CONTRACT IS "KNOWN NOW", NOT "EVER TRACKED" — HISTORY IS DELIBERATELY
   *  NOT CONSULTED (Codex review, 2026-09-06). A file tracked in an earlier
   *  commit, deleted, and that deletion COMMITTED mid-session is absent from
   *  disk, from the index and from HEAD, so this reports it as unknown and the
   *  caller drops it. That is the RIGHT outcome and the reason the cheaper probe
   *  is correct: the article_missing lane's remedy is "create the owning
   *  article", and an article owning a path that exists nowhere in the current
   *  tree is drift by construction — exactly the duplicate-article failure the
   *  live recompute above exists to prevent. Reaching for `git log --` or
   *  `rev-list` would answer "was this ever real", which is a question this lane
   *  has no use for; do not widen it to that without a ruling.
   *
   *  Returns null when EITHER probe fails, so the caller degrades toward
   *  signaling rather than silently treating an unanswerable path as unknown —
   *  the same contract gitIgnored has. NOTE a repo with no commits has no HEAD,
   *  so ls-tree fails and this returns null: a fixture without an initial commit
   *  keeps every name rather than exercising the guard. Shape mirrors the
   *  `newUnowned` ls-tree probe below (batched, one spawn per ref surface, 30s
   *  timeout); it is only ever called for paths already gone from disk, which is
   *  normally the empty set. */
  const gitKnowsNow = (list, cwd) => {
    const clean = (list ?? []).filter(Boolean);
    if (!clean.length) return new Set();
    const seen = new Set();
    for (const argv of [
      ['ls-files', '-z', '--', ...clean],
      ['ls-tree', '-r', '-z', 'HEAD', '--name-only', '--', ...clean],
    ]) {
      const res = spawnSync('git', argv, { cwd, encoding: 'utf8', timeout: 30_000 });
      if (res.status !== 0) return null;
      for (const p of (res.stdout || '').split('\0').filter(Boolean)) seen.add(p);
    }
    return seen;
  };
  let unowned = paths.filter(isUnowned);
  // A gitignored path is never governed territory (board 1de3653b) — it cannot
  // be owned, so demanding an article for it is a false demand. A failed ignore
  // check degrades to the unfiltered list (toward signaling), recorded loudly.
  if (unowned.length) {
    const ignored = gitIgnored(unowned, input.cwd);
    // skipRow, not a bare recordCheckSkipped: this is the FIRST store WRITE the
    // article lane performs and it sits upstream of the terminal release, so on
    // a store that reads but cannot write it is reached before either of the
    // sites the review named — guarding those two while leaving this one bare
    // would not close the scenario at all.
    if (ignored === null) skipRow('article-demand-gitignore', 'no_git');
    else unowned = unowned.filter((p) => !ignored.has(p));
  }

  // LIVE RECOMPUTE of the open article_missing item(s) this session's territory
  // covers (board ef206eca, reported by a consuming project). The ownership
  // question above is answered LIVE and flips the instant an owning article
  // lands — but the persisted ITEM did not follow: the mint below re-supplied
  // the matched item's OWN file_keys forward, and nothing else ever re-verified
  // them (article_missing sits outside UPDATE_RESOLVABLE_LANES, never
  // auto-drains, and H1 only COUNTS open items per lane). A stale snapshot was
  // therefore actively re-stamped, and it failed in BOTH directions off that one
  // line:
  //   OVER-REPORT — a file that has since gained an owning article kept being
  //     named, and this lane's prescribed remedy is "create the owning article":
  //     acting on it writes exactly the duplicate the reconcile discipline
  //     exists to prevent (a colliding SLUG is refused at knowledge_create; a
  //     DIFFERENT slug describing the same file is what a believing session
  //     would naturally write, and nothing refuses that).
  //   UNDER-REPORT — a genuinely unowned file that surfaced after the mint was
  //     silently dropped. This is the WORSE half: an over-report costs
  //     attention, an under-report costs the debt itself, because no other
  //     mechanism will ever raise that file again. A shrink-only fix passes the
  //     reported half and is a suppression, not a fix.
  //
  // UNION, NOT REPLACE (the semantics the frozen spec deliberately left open —
  // decided here): a file this item already names that is STILL unowned but was
  // NOT touched this session is KEPT. Replace would drop it the moment a session
  // touched only its neighbours — the under-report direction, the one that loses
  // the record for good.
  //
  // NO CAP ON THE PERSISTED SET (review finding A, 2026-08-29 — the fix's own
  // regression). A `.slice(0, 20)` over union(live, carried) EVICTS still-unowned
  // CARRIED names: an item carrying c1..c20 that a later session reaches with
  // live-unowned [c1, n1] heals to [c1, n1, c2..c19] and c20 vanishes while still
  // unowned, outside that session's paths, in the one lane that never auto-drains.
  // Ordering the live keys first does not fix it — it only chooses WHICH debt to
  // destroy. The cap's original purpose was mint-time NOISE control, and noise is
  // capped where it belongs: at the RENDERED list (capList, in the nag below),
  // never in what is persisted. The schema puts no cap on file_keys.
  // A name therefore leaves this item for exactly three RULING-BACKED reasons,
  // each of which means the debt is gone rather than lost — never for want of room:
  //   1. it gained an owning article/reference doc (isUnowned flips — the point);
  //   2. it is gitignored, i.e. never governed territory by ruling (board
  //      1de3653b), so demanding an article for it is a FALSE demand whose
  //      remedy is a bogus article (review finding E — the earlier "a drop can
  //      only push toward under-report" justification was right about the
  //      under-report axis and wrong about this lane's over-report axis);
  //   3. it no longer exists on disk — a deleted/renamed path cannot be given an
  //      owning article, and this is also the only thing bounding union growth.
  // When the gitignore probe itself fails, reasons 2 is skipped and the name is
  // KEPT (toward signaling), recorded loudly — the same degradation the demand uses.
  //
  // CONSOLIDATION, not per-item healing (review finding B, 2026-08-29). Healing
  // each reached item against its own keys MANUFACTURES overlap: I1=[a,b] and
  // I2=[c] with session paths [a,c] leave I1 healed to [a,c] beside a standing
  // I2=[c]; A=[x] and B=[x,y] with y newly owned leave A and B on the IDENTICAL
  // key set, which IS enqueueSystemTodo's dedup key — the choke breaks at the
  // first match and the second stands open forever, and store.updateTodo runs no
  // key-collision check of its own. Every open item this session's paths reach is
  // therefore merged into ONE survivor carrying the union, the rest removed. The
  // outsider guard below extends that to an item OUTSIDE this session's reach
  // that already carries the healed set. This is what ENFORCES the invariant the
  // prior comment merely asserted: two items are never left on one key set.
  //
  // READ AND ACT UNDER ONE WRITE LOCK (review finding C, 2026-08-29). Emptiness
  // was computed from a snapshot read outside any transaction and acted on with
  // a hard `store.remove` — a concurrent Stop or board_update adding a genuinely
  // unowned key between the read and the remove had its item deleted, and the
  // UPDATE branch had the same stale-overwrite shape. store.withTransaction opens
  // BEGIN IMMEDIATE and every store write primitive joins it reentrantly, so the
  // re-read below cannot be overtaken; expected_version rides the update as the
  // documented CAS backstop. The gitignore/existence probes deliberately run
  // BEFORE the transaction — they spawn git and hit the filesystem, and neither
  // may run while the store's write lock is held. A key that appears only in the
  // re-read (added concurrently) was never probed, so it is KEPT if unowned:
  // conservative, toward signaling.
  // A QUERY RESULT IS A WINDOW, NOT AN INVENTORY (review finding 3, 2026-08-29).
  // Both this recompute and the mint below rest a CORRECTNESS invariant on this
  // read — AC9's "two items are never left on one file_keys set" (the
  // consolidation/outsider sweep) and enqueueSystemTodo's dedup (the mint's
  // overlap match). Past the cap an already-open item becomes INVISIBLE and both
  // fail SILENTLY: the sweep leaves a duplicate standing, the mint inserts a
  // second item beside one it could not see. `capped` was never inspected.
  //
  // TWO CHANGES, both cheap:
  //  1. FILTER BY SOURCE. QueryOptions.source is applied in the store's BASE
  //     FILTER, before the cap (packages/store baseFilter, "audit finding
  //     38/43"), so board items — which share this lane's todo type and are the
  //     bulk of the rows in a busy project — no longer consume the window at
  //     all. That is a real narrowing, not a re-sort.
  //  2. INSPECT THE CAP AND DEGRADE LOUD (P5). store.query returns a bare array
  //     with no `capped` flag, so a full window (returned === cap) IS the
  //     capped signal, exactly as the tool surface defines it; store.count over
  //     the same base filter supplies the true total for the disclosure and is
  //     itself guarded, since the count is a nicety and the cap hit is the
  //     finding.
  // WE STILL PROCEED on a partial window, deliberately: every consequence of a
  // short window is an OVER-report (a missed removal, a duplicate mint), while
  // suppressing the demand would be an UNDER-report — the loss direction this
  // whole lane exists to prevent. Disclosed once per Stop, never per call.
  const SYSTEM_TODO_CAP = 1000;
  let todoWindowCapped = false;
  const systemTodoWindow = () => {
    const rows = store.query({ types: ['todo'], source: 'system', cap: SYSTEM_TODO_CAP });
    if (rows.length >= SYSTEM_TODO_CAP && !todoWindowCapped) {
      todoWindowCapped = true;
      let total = null;
      try {
        total = store.count({ types: ['todo'], source: 'system' });
      } catch {
        // the exact total is a nicety — reaching the cap is the finding
      }
      const detail = `window_capped:${rows.length}_of_${total ?? 'unknown'}`;
      skipRow('h10-todo-window-capped', detail);
      disclose(
        `H10: the open-maintenance-item read hit its cap (${detail}) — article_missing consolidation and mint dedup are evaluating a PARTIAL window this Stop, so a duplicate demand may be left standing or minted; drain the maintenance queue\n`
      );
    }
    return rows;
  };
  const articleMissingOpen = () => systemTodoWindow().filter((t) => t.system_reason === 'article_missing');
  // ONE DEGRADE for every containment point in this recompute (board da8dcd27,
  // widened by review finding 1, 2026-08-29): record best-effort, DISCLOSE, and
  // CONTINUE to the duties. Both primitives it calls are throw-proof, so the
  // degrade itself can never become the thing that escapes.
  const recomputeDegraded = (e) => {
    const detail = String((e && e.message) || e);
    // The check_skipped trail is best-effort BY NECESSITY, not by convenience:
    // the likeliest cause of the failure is that the store cannot be written at
    // all, in which case recording the skip throws too — and a throw HERE would
    // reopen the exact hole this closes. skipRow contains that, and falls back
    // to stderr so a failed row is still visible.
    skipRow('h10-article-missing-recompute', detail);
    // ...which is why the disclosure is not the check_skipped row alone (P5).
    // In the store-unwritable case that row never lands, and a silently skipped
    // heal is indistinguishable from a healthy Stop. article_missing sits
    // outside UPDATE_RESOLVABLE_LANES and never auto-drains, so the stale item
    // left behind keeps prescribing "create the owning article" for files that
    // may already have one — a demand that misleads in the corrupting direction
    // is worth one line of stderr. The write is guarded too (review LOW(a)): an
    // EPIPE on the last-resort channel would re-open the very hole this closes.
    disclose(
      `H10: article_missing recompute skipped — ${detail} (check_skipped h10-article-missing-recompute; the open demand may be stale until the next Stop)\n`
    );
  };
  // THE READ IS CONTAINED TOO, not merely the transaction (review finding 1,
  // 2026-08-29, extending board da8dcd27). da8dcd27 wrapped the write
  // transaction; the store READS that feed it sat OUTSIDE, and so did the
  // carried-gitignore degrade row below. On a store that READS but cannot be
  // WRITTEN with git also unavailable, that row threw straight to the founding
  // catch — warnNonBlocking, exit 1, read as NON-BLOCKING, every remaining duty
  // voided: the da8dcd27 defect reached one layer above where its arms inject.
  // A failed read degrades to "no items reached", which skips the heal for one
  // Stop (bounded staleness on an item that stays open) instead of costing the
  // capture nag, the mints, and the settlement/clear below.
  const reachedMissing = (() => {
    try {
      return articleMissingOpen()
        .filter((t) => (t.file_keys ?? []).some((k) => paths.includes(k)))
        .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
    } catch (e) {
      recomputeDegraded(e);
      return [];
    }
  })();
  if (reachedMissing.length) {
    const carriedAll = [...new Set(reachedMissing.flatMap((t) => t.file_keys ?? []))];
    const carriedIgnored = gitIgnored(carriedAll, input.cwd);
    if (carriedIgnored === null) skipRow('article-demand-carried-gitignore', 'no_git');
    const prunable = new Set(carriedAll.filter((p) => (carriedIgnored ? carriedIgnored.has(p) : false) || !existsSync(join(input.cwd, p))));
    const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const subsetOf = (a, b) => {
      const big = new Set(b);
      return [...a].every((k) => big.has(k));
    };
    // THE TRANSACTION ITSELF (board da8dcd27). Everything below is a BEGIN
    // IMMEDIATE *write* transaction with a retry budget, and it sits UPSTREAM of
    // the capture duty's blocking deny(). H10's founding catch calls
    // warnNonBlocking, never deny() — the baselined F5 debt this hook carries
    // (see its entry in scripts/check-failclosed-boundary.mjs) — so a throw that
    // escapes here exits 1, the runner reads non-2 as NON-BLOCKING, and EVERY
    // remaining Stop duty is voided, the capture nag included: the session ends
    // with no nag shown and no capture_owed minted, which is the exact failure
    // the capture lane exists to prevent. Nothing exotic is needed to reach it —
    // withRetry gives up after 5 tries (~375ms) and rethrows, so a concurrent
    // MCP board_add holding the write lock is enough, and a non-BUSY refusal
    // (the store's live schema-drift write guard, a schema rejection) rethrows
    // on the FIRST try.
    //
    // The recompute is ADVISORY *relative to the duties below it*: it heals an
    // item that is already open and stays open, so its failure costs one Stop's
    // worth of staleness, whereas escaping costs every duty. Same shape and same
    // reasoning as runSettlement's own try above.
    //
    // WHAT THIS DOES NOT DO: it does not make H10 fail-closed. The founding try
    // still warns rather than denying, that hole is pre-existing and baselined,
    // and retiring it is its own adjudicated change. This only stops the
    // recompute from WIDENING it.
    try {
      withRetry(() =>
        store.withTransaction(() => {
          // Re-read under the write lock — a concurrently removed item simply
          // vanishes from the set rather than being written back into existence.
          const fresh = reachedMissing.map((t) => store.get(t.id)).filter(Boolean);
          if (!fresh.length) return;
          const stillOwed = (p) => !prunable.has(p) && isUnowned(p);
          const healed = [...new Set([...unowned, ...fresh.flatMap((t) => (t.file_keys ?? []).filter(stillOwed))])].sort();
          if (!healed.length) {
            // Every file these demands named now has an owner (or is no longer
            // demandable territory): the debt is PAID, so the items leave by the
            // artifact-write that fulfilled them (P4). Removed, never left open
            // with an empty file_keys list — that would be undrainable debt H1
            // counts forever. This is AC9's "creating the owning article clears it
            // mechanically on the next Stop", now reached even on a Stop where the
            // demand does not fire at all.
            for (const t of fresh) store.remove(t.id, now);
            return;
          }
          const freshIds = new Set(fresh.map((t) => t.id));
          // STRICT-SUBSET OUTSIDERS (item f4616312 hole 2, reproduced 2026-08-29
          // as arm B-4). The equality guard BELOW only ever fires under
          // CONCURRENCY: healed ⊇ unowned and unowned ⊆ paths, so an outsider
          // carrying EXACTLY healed would itself have been reached by this
          // session's paths unless `unowned` is empty or the item was written
          // between the two reads. A STRICT SUBSET needs no concurrency at all —
          // it can be built entirely from the CARRIED half of the union, whose
          // names are by construction outside this session's paths. Measured
          // leak: an outsider [c1] beside our healed [a, c1] survived, leaving
          // TWO open demands whose key sets are one a subset of the other, in
          // the lane that never auto-drains.
          //
          // THE DIRECTION IS THE OPPOSITE OF THE EQUALITY BRANCH BELOW, and
          // deliberately so. At EQUALITY the two key sets are identical, so
          // either item carries the whole debt losslessly and keeping the
          // outsider is free — it avoids a write to an item outside this
          // session's reach. At STRICT SUBSET only OURS carries every still-owed
          // name (healed ⊃ theirs); deferring to theirs would DROP the names
          // healed holds and theirs lacks — silent knowledge loss in the one
          // lane with no other mechanism to re-raise them. So here we absorb
          // THEIRS into OURS: remove the contained outsiders, keep our survivor.
          //
          // An outsider naming NOTHING is left alone: an empty key set is a
          // trivial subset of everything, and removing it would discard a demand
          // whose scope our union cannot be shown to cover (toward signaling,
          // the same conservative direction the probes above take).
          //
          // A FUNCTION, AND IT RUNS ON BOTH BRANCHES (review finding 2,
          // 2026-08-29). This sweep used to sit BELOW the equality branch, which
          // `return`s — so the moment a concurrent write produced an outsider
          // carrying exactly `healed`, the sweep never ran and hole 2 leaked
          // again one branch over: fresh=[a] + still-owed carried c1 heals to
          // [a,c1]; outsider X=[a,c1] fires equality; outsider Y=[c1] SURVIVES
          // beside X, one a strict subset of the other, in the lane that never
          // auto-drains. Sweeping on the equality branch is lossless for the
          // same reason the branch itself is: the item KEPT there carries
          // exactly `healed`, which is a superset of every key set this sweep
          // removes, so no name leaves the store that the survivor does not
          // already name. `keepIds` is what makes the two calls differ — on the
          // equality branch the kept outsider must be exempt from its own
          // (non-strict) subset test.
          const sweepContainedOutsiders = (keepIds) => {
            for (const t of articleMissingOpen()) {
              if (keepIds.has(t.id)) continue;
              const keys = t.file_keys ?? [];
              if (!keys.length || !subsetOf(keys, healed)) continue;
              store.remove(t.id, now);
            }
          };
          const outsider = articleMissingOpen().find((t) => !freshIds.has(t.id) && sameSet(t.file_keys ?? [], healed));
          if (outsider) {
            // An item this session's paths do NOT reach already carries exactly
            // this set — healing onto it would put two items on one dedup key.
            // Keep theirs, drop ours: the union is preserved intact either way.
            // The sweep still runs (see above), so a subset outsider is not
            // spared merely because an EQUAL one happened to exist as well.
            sweepContainedOutsiders(new Set([...freshIds, outsider.id]));
            for (const t of fresh) store.remove(t.id, now);
            return;
          }
          sweepContainedOutsiders(freshIds);
          const [survivor, ...others] = fresh;
          for (const t of others) store.remove(t.id, now);
          const prior = [...(survivor.file_keys ?? [])].sort();
          if (JSON.stringify(prior) === JSON.stringify(healed)) return; // nothing moved — no version churn
          // Healed IN PLACE (versioned update, same id — feature_link/H1 references
          // survive). Writing the live set HERE is also what keeps the mint below
          // able to match this same item: the choke keys on {system_reason, sorted
          // file_keys}, so a corrected set supplied only at the mint would miss the
          // stale item and insert a second one beside it.
          store.updateTodo(survivor.id, { ...survivor, file_keys: healed, updated_at: now }, { expected_version: survivor.version });
        })
      );
    } catch (e) {
      // Same degrade as the contained READ above — one handler, one pattern.
      recomputeDegraded(e);
    }
  }

  // §6 H10 article demand: touched files nothing owns, at threshold or any new
  // unowned file (vs git HEAD; no-git degrades loud to threshold-only).
  //
  // HOISTED ABOVE THE NO-DUTY TERMINAL RELEASE (item f4616312 hole 1,
  // 2026-08-29), completing what board ef206eca started. That fix moved the
  // live RECOMPUTE up and deliberately left the DEMAND muted here; the mute is
  // the defect. `paths` (the article-demand input set) is NOT filtered by
  // no_capture or test_repair — only `activeTouches`/`activePaths` are — so a
  // Stop whose every capture touch was discharged on the CAPTURE lane reached
  // the release below with `hasCaptureDuty === false` and never evaluated the
  // article lane at all. Because that release CLEARS THE REGISTERS, a file that
  // became unowned during such a Stop was lost permanently: no soft-block, no
  // article_missing item, and no later mechanism that re-raises it. That is a
  // CAPTURE-lane declaration silently discharging the ARTICLE-DEMAND lane —
  // exactly the shape decision no-capture-discharge-is-lane-scoped forbids, and
  // `test_repair` (a per-path capture discharge) had the identical escape.
  // NOT a threshold question: newUnowned.length > 0 triggers the demand on its
  // own, so ONE newly created unowned file is enough — min_unowned_files never
  // enters it.
  let newUnowned = [];
  if (unowned.length) {
    const head = spawnSync('git', ['ls-tree', '-r', 'HEAD', '--name-only', '--', ...unowned], {
      cwd: input.cwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (head.status === 0) {
      const inHead = new Set(head.stdout.split('\n').filter(Boolean));
      newUnowned = unowned.filter((p) => !inHead.has(p));
    } else {
      // skipRow, not a bare recordCheckSkipped (review finding 1, 2026-08-29):
      // the hole-1 hoist moved this store WRITE upstream of the terminal
      // release, so on a store that reads-but-cannot-write with git also
      // unavailable a throw here escapes to the founding catch and skips not
      // only every duty but runSettlement()/clearRegisters() as well — leaking
      // this session's registers into the next one (P4). Guarded, the degrade
      // costs at most its own row.
      skipRow('article-demand-newfile', 'no_git');
    }
  }
  const articleDemand = unowned.length >= config.article_demand.min_unowned_files || newUnowned.length > 0;

  // IMAGE/BINARY-ONLY SESSIONS (board 05e298f0) — the ONE case that still
  // releases clean through the no-duty branch below with an article demand
  // standing. Reading images is inspection, not knowledge-producing work, and
  // that ruling says such a session ends clean; nothing is being "discharged"
  // here because image-only activity never TRIGGERS an article duty in the
  // first place. The two cases share one physical branch but are separable BY
  // CAUSE, and the cause is what is tested: image-only means EVERY `paths`
  // entry is an image, whereas a no_capture/test_repair discharge always leaves
  // at least one NON-image entry in `paths` that was removed from
  // `activeTouches`. Merely asking whether a no_capture event exists would not
  // distinguish them.
  //
  // SCOPE — this flag is applied to the no-other-duty TERMINAL release below
  // and NOWHERE ELSE. Images stay in `unowned`/`newUnowned`/`articleDemand` for
  // MIXED sessions by design (AC2 of scripts/tests/h10-touch-noise.test.mjs:
  // an image neither adds to nor shields a real file's duty), so globally
  // weakening `articleDemand` by this flag would silently break that ruling.
  const imageBinaryOnly = paths.length > 0 && paths.every((p) => IMAGE_BINARY_EXT.test(p));

  if (!hasCaptureDuty && !hasResearchDuty && !hasConceptDuty && (!articleDemand || imageBinaryOnly)) {
    // No duties to enforce (e.g. only non-research dispatches recorded, or a
    // no-capture declaration covered every touch/debug event). A pending
    // capture declaration has forward scope, so retain it for later work.
    runSettlement();
    clearRegisters({ preservePendingDeclaration: Boolean(pendingDetail) });
    releaseWithPressure();
  }

  // Earliest timestamp across the ACTIVE touches ∪ debug events (the
  // captured-set window anchor) — a no-capture declaration moves this forward.
  // Only VALID stamps anchor it (outside re-review 2026-08-22): the old
  // `.filter(Boolean)` kept truthy-but-uncomparable values, so a single touch or
  // debug event stamped '0' — which correctly SURVIVES dischargedByNoCapture,
  // staying active — then became the earliest anchor, and every knowledge record
  // ever written compares >= '0'. That flipped `captured` true and cleared the
  // duty one layer below the guard it had just passed.
  // FALLBACK DIRECTION, when an active item has no usable stamp: `now`, the
  // LATEST anchor available at this Stop. It is the conservative choice —
  // no pre-existing record can satisfy a window that opens at the Stop itself,
  // so the duty stays ARMED, which is the whole point of failing closed here.
  // (An invented EARLY anchor is the failure being fixed; an early anchor is
  // exactly what lets any historical record discharge the duty.) It is also
  // byte-identical to what this line already did when the list was empty.
  // Dropping an invalid stamp while OTHER valid ones remain can only move the
  // anchor LATER — the strict direction, same rule the concept lane states.
  const allTimestamps = [...activeTouches.map((t) => t.at), ...activeDebugEvents.map((e) => e.at)].filter(isValidAt).sort();
  const earliest = allTimestamps.length ? allTimestamps[0] : now;

  // Widened captured set: decision|anti_pattern|feature_article|research_finding|disconfirmed_hypothesis|open_question
  // open_question added board a9be48f2: an evidenced question with live
  // hypotheses IS a durable capture — the session's knowledge landed in the
  // store even though it landed as a question rather than an answer, so nagging
  // for capture after one is a false demand.
  const captured = store
    .query({ types: ['decision', 'anti_pattern', 'feature_article', 'research_finding', 'disconfirmed_hypothesis', 'open_question'], cap: 1000 })
    .some((r) => r.created_at >= earliest || r.updated_at >= earliest);

  // Research duty satisfaction: research_finding|decision|anti_pattern since earliest
  // ACTIVE research event (no_capture-discharged events excluded — item 353416a9).
  let researchSatisfied = true;
  let earliestResearch = null;
  if (hasResearchDuty) {
    // Same valid-stamps-only anchor and same `now` fallback as `earliest` above,
    // for the same reason: a research event stamped '0' survives the no_capture
    // guard and would otherwise anchor this window below every record in the
    // store, satisfying the duty with knowledge written months ago.
    const rts = activeResearchEvents.map((e) => e.at).filter(isValidAt).sort();
    earliestResearch = rts.length ? rts[0] : now;
    researchSatisfied = store
      .query({ types: ['research_finding', 'decision', 'anti_pattern'], cap: 1000 })
      .some((r) => r.created_at >= earliestResearch || r.updated_at >= earliestResearch);
  }

  // Concept duty satisfaction (decision foreign_7208729b): per FAMILY, a feature_article
  // carrying concept_family === family created/updated since the SESSION WINDOW
  // START for that family — min(that family's earliest concept_designed event
  // `at`, the earliest valid `at` across ALL session-register events of any
  // kind this session). This lets the legitimate write-article-THEN-register
  // flow satisfy in either order: an article written any time within the
  // session window (from the session's earliest event onward) satisfies, even
  // when it lands before its own family's concept_designed registration; an
  // article predating the WHOLE session still demands. General capture does
  // NOT satisfy it — only the family's concept article does (mirrors the
  // article-demand semantics).
  //
  // PRE-EVENT WINDOW (item c520be20, adjudicated 2026-08-22): the natural
  // ordering is write the article, THEN register concept_designed — so a lone
  // registration with no other earlier session event anchors windowStart to
  // the event's OWN timestamp, making the article that preceded it by seconds
  // look like it predates the window and raising a FALSE demand (measured:
  // article 08:19:30, event registered 08:19:57). Strictly additive on top of
  // the since-the-event path above: an article created/updated within
  // CONCEPT_PRE_EVENT_WINDOW_MS BEFORE the family's own event `at` also
  // satisfies.
  const CONCEPT_PRE_EVENT_WINDOW_MS = 15 * 60_000;
  let unmetFamilies = [];
  if (hasConceptDuty) {
    // FIX L2 (upgrade-polish review, 2026-08-21): a non-canonical `at` sorts
    // ARBITRARILY against real timestamps — '0' below every one of them (which
    // drags windowStart back until any stale article satisfies), 'n/a' above
    // every one of them — so it is excluded here, not merely parsed. Shares the
    // isValidAt guard above.
    const sessionAts = sessionEvents.map((e) => e.at).filter(isValidAt).sort();
    const earliestSessionAt = sessionAts.length ? sessionAts[0] : now;
    const articles = store.query({ types: ['feature_article'], cap: 1000 });
    unmetFamilies = [...conceptFamilies.entries()]
      .filter(([family, since]) => {
        // No valid `at` anywhere in the family's events: the window is
        // unresolvable, so the duty stays demanded rather than being measured
        // against an invented anchor (fail-closed).
        if (since === null) return true;
        const windowStart = since < earliestSessionAt ? since : earliestSessionAt;
        const sinceMs = Date.parse(since);
        const preStart = Number.isFinite(sinceMs) ? sinceMs - CONCEPT_PRE_EVENT_WINDOW_MS : null;
        return !articles.some((a) => {
          if (a.concept_family !== family) return false;
          if (a.created_at >= windowStart || a.updated_at >= windowStart) return true;
          if (preStart === null) return false;
          const created = Date.parse(a.created_at);
          const updated = Date.parse(a.updated_at);
          return (
            (Number.isFinite(created) && created >= preStart && created <= sinceMs) ||
            (Number.isFinite(updated) && updated >= preStart && updated <= sinceMs)
          );
        });
      })
      .map(([family]) => family);
  }
  const conceptSatisfied = unmetFamilies.length === 0;

  // `isUnowned` / `unowned`, the live recompute that shares them, AND the
  // article demand itself (`newUnowned` / `articleDemand`) are all computed
  // ABOVE the no-duty terminal release — see the block there for why the demand
  // had to move up too (item f4616312 hole 1). Every use below reads those
  // hoisted values unchanged.

  // All duties satisfied → settle (F6: this IS the "Stop after capture/reconcile
  // writes" boundary), clear registers, release.
  const captureSatisfied = !hasCaptureDuty || captured;
  if (captureSatisfied && (!hasResearchDuty || researchSatisfied) && conceptSatisfied && !articleDemand) {
    // `captured` spends a pending declaration, but a vacuous capture
    // satisfaction has consumed no capture work. Keep that declaration's
    // forward scope while this independent duty settles.
    const preservePendingDeclaration = Boolean(pendingDetail) && !hasCaptureDuty;
    runSettlement();
    clearRegisters({ preservePendingDeclaration });
    releaseWithPressure();
  }

  // CAPTURE-PENDING DEFERRAL (board 1af5d630). Only the CAPTURE duty is
  // deferrable, and only when every other duty is satisfied — a pending
  // declaration must never mute a research/concept/article demand it says
  // nothing about. First pending Stop: allow WITHOUT clearing the registers —
  // a deliberate, narrow exception to the clear-on-terminal rule, because this
  // release is NOT terminal: the duty stays armed so a write that lands before
  // the next Stop settles it cleanly with zero queue noise. Second pending
  // Stop: the write still has not landed — convert the debt to ONE deduped
  // capture_owed item citing the target, then clear (P5: pending work defers
  // or lands on the queue, never evaporates). The shared nag marker doubles as
  // the once-only counter, exactly as it does for the soft-block.
  if (pendingDetail && hasCaptureDuty && !captured && (!hasResearchDuty || researchSatisfied) && conceptSatisfied && !articleDemand) {
    // The marker ALONE is the once-only counter here — deliberately no
    // stop_hook_active clause (review finding 1, 2026-08-09): that clause
    // guards against re-BLOCKING in a deny loop, and this branch ALLOWS. With
    // it, a pending declaration whose first Stop happened to follow some other
    // hook's deny would lose its whole grace period and mint a false debt.
    if (!existsSync(nagMarker)) {
      writeFileSync(nagMarker, JSON.stringify({ at: now, capture_pending: pendingDetail }));
      // Registers deliberately NOT cleared — see above. F4/R4: the claim
      // must still be released (see releaseTouchesClaim above), or it would
      // dangle in the claim file forever with no next-Stop adoption ever
      // triggered. F6: duties are outstanding here (capture still pending),
      // so settlement itself does not run.
      releaseTouchesClaim();
      releaseWithPressure();
    }
    // CARRY WHILE THE NAMED TARGET IS STILL LIVE (board cb457cbd). The bound on
    // this grace is the TARGET's liveness, not a Stop count: while the register
    // still holds the dispatch the declaration names, converting to debt would
    // file mid-flight agent work as conductor negligence — the exact misreading
    // decision foreign_ec9eacaa fixed for the file lanes, which this lane never
    // inherited. Non-terminal in exactly the shape of the first pending Stop
    // above: BOTH work registers survive, so a write landing before any later
    // Stop still settles the duty terminally with zero queue noise (the
    // all-duties-satisfied branch above), and the Stop after the entry leaves the
    // register falls straight through to the conversion below — the debt is
    // CARRIED, never dropped (P5), and never minted twice (the open-capture_owed
    // choke). Settlement stays unrun here for the same reason it does above (F6):
    // the capture duty is outstanding, so the candidates ride the claim onward.
    // The nag marker is left exactly as the first pending Stop left it (spent),
    // which is what makes the fall-through convert immediately once the target
    // lands; the clear-on-every-release rule documented at clearRegisters()
    // governs the paths that CALL it, and this path, like the first pending Stop
    // above, deliberately does not.
    if (pendingTargetLive) {
      releaseTouchesClaim();
      releaseWithPressure();
    }
    // "any capture_owed open" gates more than the choke's exact-key match (its
    // file_keys vary with activePaths) — kept deliberately; only the write
    // itself routes through enqueueSystemTodo (decision foreign_194f43e4).
    const openPending = store
      .query({ types: ['todo'], cap: 1000 })
      .some((t) => t.source === 'system' && t.system_reason === 'capture_owed');
    if (!openPending) {
      store.enqueueSystemTodo({
        id: randomUUID(),
        type: 'todo',
        created_at: now,
        updated_at: now,
        author: 'system',
        status: 'active',
        superseded_by: null,
        links: [],
        scope: 'project',
        stack_tags: [],
        text: `capture owed: declared pending (${pendingDetail}) but no durable write had landed by session release — verify the target landed its capture against HEAD, then close${clipped}`,
        source: 'system',
        system_reason: 'capture_owed',
        file_keys: owedKeys,
      });
    }
    // R2 (board c198866d round-3 fixer, BLOCKING): this IS a terminal
    // release — the session ends here, so there is no "next Stop" for
    // settlement to defer to the way F6's nag/deny paths can. Settling here,
    // even though the capture duty itself is still outstanding, is the last
    // chance before clearRegisters() below discards the claim for good.
    runSettlement();
    clearRegisters();
    releaseWithPressure();
  }

  // test-touching → test-integrity vs git HEAD (§8.2); non-git degrades loud.
  const testGlobs = (config.toolchains ?? []).flatMap((tc) => tc.test_globs ?? []);
  let integrityNote = '';
  if (hasCaptureDuty && !captured && activePaths.some((p) => testGlobs.some((g) => matchesGlob(p, g)))) {
    const ti = gitTestIntegrity({ cwd: input.cwd, testGlobs });
    if (ti.no_git) store.recordCheckSkipped('test-integrity', 'no_git', undefined, now);
    else if (ti.modified.length || ti.deleted.length) {
      integrityNote = ` Test-integrity vs HEAD: modified ${JSON.stringify(ti.modified)}, deleted ${JSON.stringify(ti.deleted)} — review before capture.`;
    }
  }

  // Presentation only (decision h10-stop-flood-shorter-and-fewer-repeat-
  // compaction-once-per-session-unknown-note, ee8ab1f5): a short header, one
  // line per open duty carrying only its executable remedy tokens (points
  // A/B) — and, on the NEXT nag cycle carrying the identical semantic shape,
  // ONE compacted line instead of the full bullets. The prose this replaces
  // (why a false declaration matters, why a bare declaration is capture-only)
  // is dropped — CLAUDE.md and H1 carry it; only the lane/count/remedy is
  // outcome-changing here (P1).
  const H10_HEADER = 'H10 ▸ act, then Stop again:';

  if (!input.stop_hook_active && !existsSync(nagMarker)) {
    // capture-nagged.json's write MOVED below, behind a SUCCESSFUL stderr
    // delivery (point D) — writing it here, before the text is shown, was the
    // pre-existing hazard: a failed write would convert an unseen duty
    // straight into queued debt with the nag never having been shown.
    // Any fan-out deferral/staleness leads the block: the demands that follow are
    // exactly the ones the deferral did NOT cover (decision foreign_ec9eacaa).
    const parts = [...disclosureParts];

    const hasDebug = activeDebugEvents.length > 0;
    const captureLaneOpen = hasCaptureDuty && !captured && !pendingDetail;
    const researchLaneOpen = hasResearchDuty && !researchSatisfied;

    const hhmm = (iso) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '??:??' : d.toISOString().slice(11, 16);
    };

    // CANONICAL SEMANTIC FINGERPRINT (point B): the open lane SET, each lane's
    // qualitative variant, the concept-family set, article-demand presence,
    // the deferral owner set, and a version constant — deliberately NEVER
    // counts, paths or rendered text (those would make compaction inert
    // during active work, defeating the flood reduction it exists for).
    const REMEDY_VERSION = 1;
    const conceptLaneOpen = !conceptSatisfied;
    const articleLaneOpen = Boolean(articleDemand);
    const openLanes = [];
    if (captureLaneOpen) openLanes.push('capture');
    if (researchLaneOpen) openLanes.push('research');
    if (conceptLaneOpen) openLanes.push('concept');
    if (articleLaneOpen) openLanes.push('articles');
    openLanes.sort();
    // FIX 4 (review round): concept/article compact too — only DEFERRAL lines
    // (disclosureParts, already outside this compact/full decision) stay as
    // full lines beside the one-liner; they carry live ownership evidence
    // (decision foreign_ee8ab1f5 (2)) that a token can't stand in for.
    const laneVariant = (lane) => {
      if (lane === 'capture') return hasDebug ? 'debug_scope' : integrityNote ? 'test-integrity' : 'touch';
      if (lane === 'research') return 'research';
      if (lane === 'concept') return 'concept_family';
      return 'article_demand';
    };
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          remedy_version: REMEDY_VERSION,
          lanes: openLanes,
          lane_variants: openLanes.map(laneVariant),
          concept_families: [...unmetFamilies].sort(),
          article_demand: Boolean(articleDemand),
          deferral_owners: [...deferredAgents].sort(),
        })
      )
      .digest('hex');

    const dutyNaggedMarker = join(input.cwd, '.sterling', 'transient', 'duty-nagged.json');
    const priorDutyNag = (() => {
      if (!input.session_id) return null; // absent session_id: never compact (points B/E)
      try {
        const raw = JSON.parse(readFileSync(dutyNaggedMarker, 'utf8'));
        if (raw.session_id !== input.session_id) return null;
        if (typeof raw.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(raw.fingerprint)) return null;
        return raw;
      } catch {
        return null; // unreadable/malformed marker is never salvaged (point E)
      }
    })();
    const compact = openLanes.length > 0 && !!priorDutyNag && priorDutyNag.fingerprint === fingerprint;
    const dutyNagAt = compact ? priorDutyNag.at : now;

    const captureToken = 'knowledge_create | no_capture --reason | capture_pending';
    const researchToken = 'research_finding | no_capture --lane research';
    const conceptToken = 'knowledge_create feature_article (concept_family)';
    const articleToken = 'knowledge_create feature_article | reference_material';
    const tokenFor = (lane) => {
      if (lane === 'capture') return captureToken;
      if (lane === 'research') return researchToken;
      if (lane === 'concept') return conceptToken;
      return articleToken;
    };

    if (compact) {
      // ONE line replaces the duty bullets below (capture/research AND, since
      // FIX 4, concept/article) — tokens stay executable in the repeat
      // (context compaction can evict CLAUDE.md mid-session).
      const segs = openLanes.map((lane) => `${lane}→${tokenFor(lane)}`);
      parts.push(`H10 ▸ ${openLanes.length} duty(ies) unchanged since ${hhmm(dutyNagAt)}: ${segs.join('; ')}`);
    } else {
      // Capture duty nag (touches or debug events present, nothing captured).
      // A capture_pending declaration suppresses the capture nag — the
      // deferral block above owns that lane end-to-end.
      if (captureLaneOpen) {
        const count = hasDebug ? activeDebugEvents.length : activePaths.length;
        const unit = hasDebug ? 'debug event(s)' : 'file(s)';
        // The debug variant names its two capture TYPES (disconfirmed_hypothesis
        // for disproven theories, anti_pattern for bad patterns) — narrower than
        // the touch variant's plain knowledge_create, so it stays a distinct
        // token string rather than folding into the shared constant above.
        const token = hasDebug ? `knowledge_create (disconfirmed_hypothesis/anti_pattern) | no_capture --reason | capture_pending` : captureToken;
        parts.push(`• capture · ${count} ${unit} · since ${hhmm(earliest)} · nothing was captured → ${token}${integrityNote}`);
      }

      // Research duty nag: cite queries/agents verbatim (interface slice 2;
      // item 353416a9) — the route is LANE-SCOPED (decision
      // no-capture-discharge-is-lane-scoped), hence '--lane research' stays.
      if (researchLaneOpen) {
        const queryTexts = activeResearchEvents.map((e) => e.detail).filter(Boolean).join(', ');
        parts.push(
          `• research · ${activeResearchEvents.length} querie(s)/agent(s) (${queryTexts}) · since ${hhmm(earliestResearch)} · ${researchToken}`
        );
      }
    }

    // Concept demand nag (decision foreign_7208729b): design settled, article owed NOW.
    // FIX 4: full detail only when NOT compacted — the compact one-liner
    // above already carries this lane's token.
    if (!compact && conceptLaneOpen) {
      parts.push(
        `• concept: famil${unmetFamilies.length === 1 ? 'y' : 'ies'} ${JSON.stringify(unmetFamilies)} settled, no concept article since → knowledge_create/knowledge_update type feature_article with concept_family set (intent + interactions; members inside the family article)`
      );
    }

    // Article demand nag. FIX 4: full detail only when NOT compacted.
    if (!compact && articleLaneOpen) {
      const capList = (arr) => (arr.length > 5 ? `${arr.slice(0, 5).join(', ')} +${arr.length - 5} more` : arr.join(', '));
      // OWNER ROWS THE JOIN SAW, per named path (issues log 2026-09-01): a demand
      // for a file the reader believes is owned is unfalsifiable without this —
      // "none" says the join found nothing at all, while a listed row says it
      // found an owner and EXCLUDED it (working_tree), which is a different bug
      // with a different fix.
      const ownerEvidence = unowned.slice(0, 5).map((p) => `${p} → owners seen: ${ownerRowsNote(p)}`);
      parts.push(
        `• articles: article demand — ${unowned.length} touched file(s) no owner (feature_article or repo-located reference doc)` +
          `${newUnowned.length ? ` (${newUnowned.length} new)` : ''}: ${capList(unowned)} → knowledge_create type feature_article (reference_material kind doc for a governing document)` +
          `\n  ownership join (uncapped, types feature_article+reference_material, excluding records that declare a working_tree): ${ownerEvidence.join(' | ')}` +
          `${unowned.length > 5 ? ` | +${unowned.length - 5} more path(s) not detailed` : ''}`
      );
    }

    // Conductor pressure rides the same deny (one block per Stop, P1) and spends the
    // once-per-session marker at its level so no separate pressure block follows.
    if (pressure.level === 'soft' || pressure.level === 'hard') {
      parts.push(pressurePart());
      spendPressureMarker(pressure.level);
    }

    // F4/F6/R4: this is a non-terminal, retry-next-Stop release — duties are
    // outstanding (that is why it is nagging), so settlement does not run,
    // but the claim must still be released (see releaseTouchesClaim above)
    // or it would dangle forever with no next-Stop adoption ever triggered.
    releaseTouchesClaim();

    // SPEND AFTER DELIVERY (point D, decision foreign_ee8ab1f5): this deliberately
    // does NOT call deny() — deny() writes stderr and exits unconditionally,
    // which is exactly the ordering hazard being closed (capture-nagged used
    // to be written at :1841, before the text was ever shown). Every marker
    // is written only once stderr has actually taken the payload; a throw
    // spends nothing, and the next Stop repeats the nag, louder, never
    // silent (point E). deny() itself is untouched — every OTHER call site
    // in this file still uses it unchanged. Shares writeThenSpend with the
    // pressure/gauge deny above (Fix 1) — this site alone also
    // spends capture-nagged and duty-nagged, since only here is a duty
    // actually rendered.
    const dutyText = compact ? parts.join('\n\n') : `${H10_HEADER}\n${parts.join('\n\n')}`;
    writeThenSpend(dutyText, [
      () => writeFileSync(nagMarker, JSON.stringify({ at: now })),
      // FIX 2: never persist a sessionless duty-nagged marker — the reader
      // above (priorDutyNag) already refuses to compact without a session;
      // this is the matching guard on the WRITE side.
      () => {
        if (!hasSession) return;
        writeFileSync(dutyNaggedMarker, JSON.stringify({ session_id: input.session_id, fingerprint, at: dutyNagAt }));
      },
      spendDispatchUnknownKeys,
    ]);
  }

  // Second pass: still owed — queue items and let the session end (P1: don't trap the human).
  if (hasCaptureDuty && !captured) {
    // Same "any open" broader gate as the pending-deferral site above; keep it,
    // route only the write through enqueueSystemTodo.
    const open = store
      .query({ types: ['todo'], cap: 1000 })
      .some((t) => t.source === 'system' && t.system_reason === 'capture_owed');
    if (!open) {
      store.enqueueSystemTodo({
        id: randomUUID(),
        type: 'todo',
        created_at: now,
        updated_at: now,
        author: 'system',
        status: 'active',
        superseded_by: null,
        links: [],
        scope: 'project',
        stack_tags: [],
        text:
          (pendingDetail
            ? `capture owed: declared pending (${pendingDetail}) but no durable write had landed by session release — verify the target landed its capture against HEAD, then close`
            : `capture owed: direct-mode session touched ${activePaths.length} file(s) and ended without capture`) + clipped,
        source: 'system',
        system_reason: 'capture_owed',
        file_keys: owedKeys,
      });
    }
  }
  if (articleDemand) {
    // Overlap match (not exact-set): this duty's subject can ESCALATE (more
    // unowned files surface on a later encounter) while remaining the same
    // open demand, which an exact sorted-file_keys match would treat as a
    // different key. Find the existing item overlapping the current unowned
    // set and, when found, re-supply ITS OWN file_keys so the choke's key
    // matches exactly and only the text (which does carry the escalated
    // count) updates in place — moving updated_at (AC2) instead of being
    // silently suppressed with nothing refreshed.
    // Those file_keys are no longer a persisted snapshot: the live recompute
    // above already healed this item to union(live unowned, still-unowned
    // carried names) — so re-supplying them keeps the dedup key stable AND
    // writes the live set (board ef206eca). The overlap match is the dedup
    // IDENTITY only; it is never the answer to what is owed.
    // NO `.slice(0, 20)` on a FIRST mint either (review finding A, 2026-08-29):
    // capping here drops the 21st genuinely unowned file the moment it is
    // measured, in the one lane that never auto-drains — an under-report, the
    // failure this whole lane exists to prevent. The nag above already caps what
    // a HUMAN reads (capList); the persisted list is the debt itself.
    // THE SAME WINDOW THE RECOMPUTE READS (review finding 3, 2026-08-29): this
    // dedup match rests on SEEING the open item, so past the cap it mints a
    // second item beside one it could not see. systemTodoWindow filters by
    // source before the cap and discloses a capped read once per Stop — see its
    // definition above.
    const overlapping = articleMissingOpen().find((t) => (t.file_keys ?? []).some((k) => unowned.includes(k)));
    // ONE list drives both the count in the text and the persisted keys, so the
    // item can never say "4 file(s)" while naming 7 — which it could once the
    // healed union (⊇ this session's unowned set) started backing file_keys.
    const demandKeysRaw = overlapping ? overlapping.file_keys ?? [] : unowned;
    // VANISHED-PROBE GUARD, AT MINT TIME (board 97ddfcc6, measured twice —
    // 2026-09-05 and 2026-09-06). Two open items name throwaway in-repo probe
    // scripts (scripts/zz-*.mjs) that no longer exist and were NEVER tracked:
    // a coder dispatch created one at a non-test path, executed it, removed it
    // with scripts/fs-remove.mjs. Such an item is PERMANENTLY UNCLOSABLE by
    // design — the append-join admission closes article_missing ONLY on a
    // knowledge_append to an existing feature_article's files[] naming one of
    // the item's own keys, so paying it would require an article to OWN a file
    // that does not exist, which is drift by construction; maintenance_remove
    // is then the only disposition and it needs a human to notice.
    //
    // The demand fires on the TOUCH and nothing re-asked at the MINT, so the
    // window between the existence filter that builds `touchedExisting` and
    // this write was unguarded — including the route where the live recompute
    // above degraded and `overlapping` therefore still carries an unpruned key.
    //
    // ABSENT FROM DISK IS NOT THE WHOLE TEST. A path git still knows STILL
    // MINTS: a working-tree delete leaves it in the index and a `git rm` leaves
    // it in HEAD, so either way it is live governed territory and a real removal
    // is a different case the board names explicitly. The skip therefore demands
    // BOTH "gone from disk" AND "gone from index and HEAD".
    //
    // THE TEST IS "GIT KNOWS IT NOW", NOT "GIT EVER KNEW IT", and the difference
    // is deliberate (Codex review, 2026-09-06): a path tracked in an earlier
    // commit whose DELETION was also committed this session is gone from all
    // three surfaces and is dropped here. That is intended — an article owning a
    // path that exists nowhere in the current tree is drift by construction, and
    // minting a demand whose only remedy is that article is the duplicate-article
    // failure the live recompute above exists to prevent. History is not
    // consulted; see gitKnowsNow's contract note above before widening this.
    //
    // A failed git probe KEEPS the name (toward signaling, recorded loudly) —
    // the same degradation direction the demand's own gitignore probe takes.
    const vanished = demandKeysRaw.filter((p) => !existsSync(join(input.cwd, p)));
    let demandKeys = demandKeysRaw;
    if (vanished.length) {
      const known = gitKnowsNow(vanished, input.cwd);
      if (known === null) skipRow('article-demand-vanished-tracked', 'no_git');
      else demandKeys = demandKeysRaw.filter((p) => !vanished.includes(p) || known.has(p));
    }
    // Every named path vanished untracked: nothing demandable is left, so no
    // item is minted. Deliberately NOT an item with an empty file_keys list —
    // that is undrainable debt H1 counts forever (the same reasoning the live
    // recompute above gives for REMOVING an item it heals to empty).
    if (demandKeys.length) {
      store.enqueueSystemTodo({
        id: randomUUID(),
        type: 'todo',
        created_at: now,
        updated_at: now,
        author: 'system',
        status: 'active',
        superseded_by: null,
        links: [],
        scope: 'project',
        stack_tags: [],
        text: `article missing: ${demandKeys.length} file(s) nothing owns (feature_article or repo-located reference doc)${newUnowned.length ? ` (${newUnowned.length} newly created)` : ''} — create the owning article(s) (§6 H10 / §12 accretion)`,
        source: 'system',
        system_reason: 'article_missing',
        file_keys: demandKeys,
      });
    }
  }
  if (!conceptSatisfied) {
    // One item PER family. No feature_link/file_keys on this item, so
    // enqueueSystemTodo's own fallback key (system_reason + exact text) already
    // dedupes it — the text is deterministic per family, so the old
    // text.includes() pre-check duplicated exactly what the choke does; removed.
    for (const family of unmetFamilies) {
      store.enqueueSystemTodo({
        id: randomUUID(),
        type: 'todo',
        created_at: now,
        updated_at: now,
        author: 'system',
        status: 'active',
        superseded_by: null,
        links: [],
        scope: 'project',
        stack_tags: [],
        text: `concept article missing: design settled for concept family '${family}' and the session ended without its concept article — create/update the feature_article with concept_family '${family}'`,
        source: 'system',
        system_reason: 'concept_article_missing',
      });
    }
  }
  if (hasResearchDuty && !researchSatisfied) {
    // "any research_owed open" gates more than the choke's exact-key match
    // (its text carries session-specific query details) — kept deliberately.
    const open = store
      .query({ types: ['todo'], cap: 1000 })
      .some((t) => t.source === 'system' && t.system_reason === 'research_owed');
    if (!open) {
      const queryTexts = activeResearchEvents.map((e) => e.detail).filter(Boolean).join('; ');
      store.enqueueSystemTodo({
        id: randomUUID(),
        type: 'todo',
        created_at: now,
        updated_at: now,
        author: 'system',
        status: 'active',
        superseded_by: null,
        links: [],
        scope: 'project',
        stack_tags: [],
        text: `research owed: session research not captured (queries/agents: ${queryTexts})`,
        source: 'system',
        system_reason: 'research_owed',
      });
    }
  }
  // R2 (board c198866d round-3 fixer, BLOCKING): the final terminal release —
  // whatever duties are still outstanding are already queued as owed/missing
  // items above; this is the last chance to settle before clearRegisters()
  // discards the claim, since no next Stop exists once the session ends here.
  runSettlement();
  // Queueing a non-capture duty does not spend a pending declaration's forward
  // scope; queueing capture work does, and `hasCaptureDuty` distinguishes them.
  clearRegisters({ preservePendingDeclaration: Boolean(pendingDetail) && !hasCaptureDuty });
  releaseWithPressure();
} catch (e) {
  if (e?.h10ReleaseInFlight === true) {
    // Normal completion: releaseWithPressure() already handed a non-empty
    // payload to exitAfterWrite and threw to unwind past the duty code that
    // would otherwise run behind it. That write's own callback owns the
    // process exit (R0) — there is nothing left to do here.
  } else {
  // A throw here (config parse, store read) would otherwise skip every session-end
  // duty silently on a non-blocking exit-1. Degrade LOUD instead (AC4): record a
  // check_skipped trail best-effort, then warn. deny()/allow() exit the process,
  // so reaching this catch means an UNEXPECTED failure, not a duty nag.
  try {
    store.recordCheckSkipped('h10-stop-duties', String((e && e.message) || e), undefined, new Date().toISOString());
  } catch {
    // store itself is the casualty — the warn below is the remaining loud signal
  }
  warnNonBlocking(`H10: session-end duties skipped — ${(e && e.message) || e} (check_skipped h10-stop-duties; fix & re-run)`);
  }
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
