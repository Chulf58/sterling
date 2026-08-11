// H10 — direct-path capture check + review (spec §6 H10). Stop, soft.
// Direct mode only: artifact-produced-but-no-capture → first Stop prompts the
// conductor to capture inline (exit 2, soft block); still missing on the next
// Stop → maintenance queue (capture_owed) and the session may end. Reviewer
// advice is NOT this hook's business (board cac61a95) — that lives in H2's
// selection-inject surface. Test-touching work records check_skipped
// {test-integrity} (script lands at step 8 with the pipeline baseline
// machinery).
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
// Research duty: research_tool ∪ configured agent_dispatch events not followed
// by a durable capture → nag once (shared marker), then research_owed on
// release. Concept duty (decision 7208729b): concept_designed events (detail
// = family slug) not followed by that family's concept article
// (feature_article.concept_family) → shared nag, then one
// concept_article_missing item per family on release.
// All terminal paths clear both registers + the nag marker together (P4).
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, deny, allow, openStore, loadConfig, warnNonBlocking } from './lib/common.mjs';
import { latestUsage, fillPct } from './lib/transcript.mjs';
import { gitTestIntegrity } from '../lib/test-integrity.mjs';
import { matchesGlob, parseConfig } from '@sterling/schemas';

const input = readStdin();
const store = openStore(input.cwd);
if (!store) allow();

const touchesPath = join(input.cwd, '.sterling', 'transient', 'touches.json');
const eventsPath = join(input.cwd, '.sterling', 'transient', 'session-events.json');
const nagMarker = join(input.cwd, '.sterling', 'transient', 'capture-nagged.json');

try {
  if (store.getRun()) allow(); // pipeline runs are H9's territory; do NOT clear registers

  const config = parseConfig(loadConfig(input.cwd) ?? {});
  const now = new Date().toISOString();

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
        // A model with no windows entry falls back to the default — and a wrong
        // denominator that still yields a BELIEVABLE percentage is the dangerous
        // case (2026-08-11 consuming-project retrospective: 48% accepted at ~10%
        // of real capacity). The unmapped model rides the sample so the release
        // path can warn ONCE per session at ANY fill level, not only above 100%.
        const mapped = Boolean(model && cw.windows[model]);
        const windowSize = mapped ? cw.windows[model] : cw.windows.default;
        const unmapped = !mapped && model ? { unmapped_model: model } : {};
        const fill = fillPct(usage, windowSize);
        if (fill > 100) {
          // Impossible with a correct denominator — the windows map lacks this model's true
          // window (observed live 2026-08-09: 129.3% on a fable session vs the 200k default).
          // Evidence of MISCONFIGURATION, not pressure: classify unknown + check_skipped
          // (loud, fail-open) instead of false-hard-blocking every session on this machine.
          store.recordCheckSkipped('conductor-pressure', `window_mismatch:${model ?? 'unknown-model'}:${fill.toFixed(1)}pct`, undefined, now);
          sample = { session_id: input.session_id, level: 'unknown', fill_pct: fill, model: model ?? null, window: windowSize, reason: 'window_mismatch', ...unmapped, at: now };
        } else {
          const level = fill >= cw.conductor.hard_pct ? 'hard' : fill >= cw.conductor.soft_pct ? 'soft' : 'below_soft';
          sample = { session_id: input.session_id, level, fill_pct: fill, model: model ?? null, window: windowSize, ...unmapped, at: now };
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
    dirtyPaths > 0
      ? ` Working tree: ${dirtyPaths} uncommitted path(s) — finish the open slice to a COMMIT BOUNDARY (branch-local commit) before opening new work.`
      : '';
  // The rotation writer lives in the plugin clone, not the target project (same
  // resolution as the no-capture remedy below): print the absolute path when the
  // platform provides it, so the command works from any project's shell cwd.
  const rotationCmd = process.env.CLAUDE_PLUGIN_ROOT
    ? `node "${join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts', 'rotation-note.mjs')}"`
    : 'node scripts/rotation-note.mjs';
  const pressurePart = () =>
    pressure.level === 'hard'
      ? `H10 conductor context pressure: fill ${pressure.fill_pct.toFixed(1)}% ≥ hard threshold ${config.context_watch.conductor.hard_pct}% of the ${pressure.window}-token window. Do not open substantial new work in this window: finish and commit what is open, and DELEGATE remaining reads and mechanical work to subagents — the conductor's context is the scarce resource (P1).${boundaryLine()} Once the open slice is committed and captures are settled, prepare ROTATION: ${rotationCmd} --next-slice "<the exact next slice>" (--objective/--risks/--pointers optional), then tell the user READY TO CLEAR — H1 restores and consumes the note automatically in the fresh session. This notice fires once per session.`
      : `Conductor context pressure: fill ${pressure.fill_pct.toFixed(1)}% ≥ soft threshold ${config.context_watch.conductor.soft_pct}% — prefer finishing open work over opening large new areas; delegate reads to subagents.${boundaryLine()}`;
  const pressureMarkerState = () => {
    try {
      const m = JSON.parse(readFileSync(pressureMarker, 'utf8'));
      return m.session_id === input.session_id ? m : null;
    } catch {
      return null;
    }
  };
  const spendPressureMarker = (level) => writeFileSync(pressureMarker, JSON.stringify({ session_id: input.session_id, level, at: now }));
  // WINDOW-GAUGE WARNING (retro slice 2): an unmapped model means every fill %
  // this session is measured against the default window — say so loudly once,
  // at any fill level, until the config gains the entry. Same marker pattern as
  // pressure (latest-value cell keyed by session_id; P4 by supersession).
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
    `H10 window gauge: transcript model '${pressure.unmapped_model}' has NO entry in config.context_watch.windows — pressure is measured against the ${pressure.window}-token DEFAULT, so every fill % this session may be wrong in either direction, and a plausible-looking number is the dangerous case. Fix: add context_watch.windows["${pressure.unmapped_model}"] with the model's true window to .sterling/config.json. This notice fires once per session.`;
  // DELEGATION WATCH (decision 8b00e77a — the mechanical half of 677f1639): measure
  // hand-work vs dispatches from the conductor's OWN transcript. Reads are recorded
  // nowhere else (touches.json = edits, session-events.json = research/dispatch), and
  // the transcript is a complete, already-present record — zero new recorders. This
  // needs the WHOLE session, so it scans the full file, not latestUsage's 1MB tail
  // (fine at Stop: one pass, once per session end). Advisory and FAIL-OPEN in its own
  // try — any failure records check_skipped {delegation-watch} and never costs a duty.
  const delegationMarker = join(input.cwd, '.sterling', 'transient', 'delegation-nagged.json');
  const delegationSpent = () => {
    try {
      return !!input.session_id && JSON.parse(readFileSync(delegationMarker, 'utf8')).session_id === input.session_id;
    } catch {
      return false;
    }
  };
  // H21 companion (decision 9042abeb): the mid-session watch's whole-session
  // article-write tally lives in its own transient file — read-only here, 0
  // when absent or when it belongs to a different session (a leftover from a
  // prior session must never be folded into this one's count).
  const articleWritesPath = join(input.cwd, '.sterling', 'transient', 'article-writes.json');
  const readArticleWrites = () => {
    try {
      const raw = JSON.parse(readFileSync(articleWritesPath, 'utf8'));
      return raw.session_id === input.session_id && Number.isFinite(raw.count) ? raw.count : 0;
    } catch {
      return 0;
    }
  };
  const statsPath = join(input.cwd, '.sterling', 'transient', 'delegation-stats.json');
  const writeDelegationStats = (stats) => {
    try {
      mkdirSync(join(input.cwd, '.sterling', 'transient'), { recursive: true });
      writeFileSync(statsPath, JSON.stringify(stats));
    } catch {
      // the observation cell is best-effort — a write failure here must not
      // cost the advisory itself, which already computed its own text
    }
  };
  const delegation = (() => {
    try {
      // A spent marker means the advisory can never fire again this session — skip the
      // whole-file scan (Stop fires per turn boundary, not once per session; without
      // this guard a long session re-reads its own transcript on every Stop).
      if (delegationSpent()) return null;
      const dw = config.delegation_watch;
      const tPath = input.transcript_path ?? '';
      if (!tPath || !existsSync(tPath)) {
        store.recordCheckSkipped('delegation-watch', 'transcript_missing', undefined, now);
        return null;
      }
      const readFiles = new Set();
      let searches = 0;
      let dispatches = 0;
      let maxBatch = 0;
      let soloDispatches = 0;
      let assistantEntries = 0;
      let contentArrays = 0;
      for (const line of readFileSync(tPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue; // individual malformed lines are skipped, never fatal
        }
        if (entry.type !== 'assistant') continue;
        // Defensive: subagent turns live in separate agent-*.jsonl files today
        // (verified 2026-08-10), but the sidechain flag exists — never count a
        // sidechain's tool calls as conductor hand-work.
        if (entry.isSidechain === true) continue;
        assistantEntries++;
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;
        contentArrays++;
        // H21 companion (decision 9042abeb): max_batch is the largest number of
        // Task/Agent blocks inside ONE assistant message; solo_dispatches counts
        // messages carrying exactly one such block — both computed per-message,
        // not from the running dispatch total.
        let batchCount = 0;
        for (const b of content) {
          if (!b || b.type !== 'tool_use') continue;
          if (b.name === 'Read') {
            if (b.input?.file_path) readFiles.add(b.input.file_path);
          } else if (b.name === 'Grep' || b.name === 'Glob') {
            searches++;
          } else if (b.name === 'Task' || b.name === 'Agent') {
            dispatches++;
            batchCount++;
          }
        }
        if (batchCount > maxBatch) maxBatch = batchCount;
        if (batchCount === 1) soloDispatches++;
      }
      if (assistantEntries > 0 && contentArrays === 0) {
        // Assistant entries exist but none carried a content array — the transcript
        // shape has drifted. A silent null here would leave the watch permanently
        // dead with no trail (P5); mirror the pressure path's format_unparseable.
        store.recordCheckSkipped('delegation-watch', 'format_unparseable', undefined, now);
        return null;
      }
      // Report-only observation cell (decision 9042abeb, C): a latest-value
      // snapshot written on EVERY successful scan, fired or not — the next
      // user report is a number, not an impression.
      const articleWrites = readArticleWrites();
      writeDelegationStats({
        session_id: input.session_id,
        hand_reads: readFiles.size,
        searches,
        dispatches,
        max_batch: maxBatch,
        solo_dispatches: soloDispatches,
        article_writes: articleWrites,
        at: now,
      });
      if (readFiles.size + searches >= dw.min_hand_work && dispatches <= dw.max_dispatches) {
        return { hand_reads: readFiles.size, searches, dispatches, max_batch: maxBatch, solo_dispatches: soloDispatches, article_writes: articleWrites };
      }
      return null;
    } catch (e) {
      try {
        store.recordCheckSkipped('delegation-watch', String((e && e.message) || e), undefined, now);
      } catch {
        // store is the casualty — the watch stays advisory
      }
      return null;
    }
  })();
  const spendDelegationMarker = () => writeFileSync(delegationMarker, JSON.stringify({ session_id: input.session_id, at: now }));
  const delegationPart = () =>
    `H10 delegation watch: this session the conductor hand-read ${delegation.hand_reads} distinct file(s) and ran ${delegation.searches} search(es), with ${delegation.dispatches} subagent dispatch(es) (largest single-message batch: ${delegation.max_batch}, solo dispatches: ${delegation.solo_dispatches}) and ${delegation.article_writes} hand-run article write(s) this session. Hand-work that needed only its CONCLUSION was a dispatch (decision 677f1639, moment 3) — delegate remaining reads, sweeps and mechanical work to subagents (opus for judgment, sonnet for mechanical). This notice fires once per session.`;
  /**
   * Every direct-mode release path exits through here. At most TWO pressure blocks per
   * session, strictly escalating: soft+dirty fires the slice-boundary nudge once; hard
   * fires once more (even after a soft block — escalation is new information). A spent
   * hard marker ends all pressure blocking for the session. The delegation-watch
   * advisory joins the SAME standalone deny when due (one block per Stop, P1);
   * stop_hook_active suppresses without spending, so a suppressed advisory can still
   * fire on a later Stop of the same session.
   */
  const releaseWithPressure = () => {
    if (!input.stop_hook_active) {
      const parts = [];
      const spent = pressureMarkerState();
      if (pressure.level === 'hard' && (!spent || spent.level !== 'hard')) {
        spendPressureMarker('hard');
        parts.push(pressurePart());
      } else if (pressure.level === 'soft' && dirtyPaths > 0 && !spent) {
        spendPressureMarker('soft');
        parts.push(`H10 slice boundary: ${pressurePart()} This notice fires once per session.`);
      }
      if (delegation && !delegationSpent()) {
        spendDelegationMarker();
        parts.push(delegationPart());
      }
      if (pressure.unmapped_model && !gaugeSpent()) {
        spendGaugeMarker();
        parts.push(gaugePart());
      }
      if (parts.length) deny(parts.join('\n\n'));
    }
    allow();
  };

  // Read touches
  let touches = [];
  if (existsSync(touchesPath)) {
    touches = JSON.parse(readFileSync(touchesPath, 'utf8'));
  }

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

  // Clear all three transient registers together (P4 — every terminal path).
  const clearRegisters = () => {
    rmSync(touchesPath, { force: true });
    rmSync(eventsPath, { force: true });
    rmSync(nagMarker, { force: true });
  };

  // Dual-register entry: proceed only if either register has content.
  if (!touches.length && !sessionEvents.length) {
    clearRegisters();
    releaseWithPressure();
  }

  // §6 H10: only files that STILL EXIST drive a demand — a file created and then
  // deleted within the session (e.g. a throwaway) leaves a stale H7 touch entry
  // but needs no owner and no capture. (raw rm leaves the H7 entry stale;
  // fs-remove does — that asymmetry is the gap this guards.)
  const paths = [...new Set(touches.map((t) => t.path))].filter((p) => existsSync(join(input.cwd, p)));

  // Classify session events.
  const debugEvents = sessionEvents.filter((e) => e.kind === 'debug_scope');
  const researchAgents = new Set(config.session_events?.research_agents ?? ['researcher', 'claude-code-guide']);
  const researchEvents = sessionEvents.filter(
    (e) => e.kind === 'research_tool' || (e.kind === 'agent_dispatch' && researchAgents.has(e.detail))
  );
  // Concept duty (decision 7208729b): concept_designed events, deduped to the
  // EARLIEST event per family — detail is the concept FAMILY slug.
  const conceptEvents = sessionEvents.filter((e) => e.kind === 'concept_designed' && e.detail);
  const conceptFamilies = new Map(); // family -> earliest at
  for (const e of conceptEvents) {
    const at = e.at ?? now;
    if (!conceptFamilies.has(e.detail) || at < conceptFamilies.get(e.detail)) conceptFamilies.set(e.detail, at);
  }

  // No-capture declaration (board 7bbec3bd): scripts/no-capture.mjs appends a
  // no_capture event the moment the conductor judges a Stop produced nothing
  // durable. It SATISFIES the capture duty for every touch/debug_scope event
  // EARLIER than the LATEST such declaration; work arriving AFTER it re-arms
  // the duty (a declaration cannot cover work that hasn't happened yet). A
  // missing/malformed `at` is treated as arriving AFTER the cutoff — the safe
  // direction, since it keeps the duty armed rather than silently clearing it.
  const noCaptureEvents = sessionEvents.filter((e) => e.kind === 'no_capture');
  const latestNoCapture = noCaptureEvents.length
    ? noCaptureEvents.map((e) => e.at).filter(Boolean).sort().at(-1)
    : null;

  // Capture-pending declaration (board 1af5d630, decision follows e23f38f8):
  // the capture EXISTS and its write is in flight on a named target (detail =
  // "<target> — <reason>"). Unlike no_capture it covers LATER work too — the
  // whole point is that wave work keeps arriving while the capture rides a
  // pending commit, and per-batch re-declaration is the boilerplate loop that
  // trains false declarations (six in ~90 minutes, measured 2026-08-09).
  // Safe because the debt cannot evaporate: the deferral below either settles
  // on a landed write or converts to a deduped capture_owed item.
  const capturePendingEvents = sessionEvents.filter((e) => e.kind === 'capture_pending' && e.detail);
  const pendingDetail = capturePendingEvents.length ? capturePendingEvents.map((e) => e.detail).at(-1) : null;
  const activeTouches = latestNoCapture ? touches.filter((t) => t.at && t.at > latestNoCapture) : touches;
  const activePaths = [...new Set(activeTouches.map((t) => t.path))].filter((p) => existsSync(join(input.cwd, p)));
  const activeDebugEvents = latestNoCapture ? debugEvents.filter((e) => e.at && e.at > latestNoCapture) : debugEvents;

  // Capture duty: triggered by file-touching work OR debug-scope events not
  // already covered by a no-capture declaration.
  const hasCaptureDuty = activePaths.length > 0 || activeDebugEvents.length > 0;
  // Research duty: triggered by research events (research_tool or configured agent).
  const hasResearchDuty = researchEvents.length > 0;
  // Concept duty: a settled design must produce/refresh its concept article.
  const hasConceptDuty = conceptFamilies.size > 0;

  if (!hasCaptureDuty && !hasResearchDuty && !hasConceptDuty) {
    // No duties to enforce (e.g. only non-research dispatches recorded, or a
    // no-capture declaration covered every touch/debug event) — clear and release.
    clearRegisters();
    releaseWithPressure();
  }

  // Earliest timestamp across the ACTIVE touches ∪ debug events (the
  // captured-set window anchor) — a no-capture declaration moves this forward.
  const allTimestamps = [...activeTouches.map((t) => t.at), ...activeDebugEvents.map((e) => e.at)].filter(Boolean).sort();
  const earliest = allTimestamps.length ? allTimestamps[0] : now;

  // Widened captured set: decision|anti_pattern|feature_article|research_finding|disconfirmed_hypothesis
  const captured = store
    .query({ types: ['decision', 'anti_pattern', 'feature_article', 'research_finding', 'disconfirmed_hypothesis'], cap: 1000, include_unconfirmed: true })
    .some((r) => r.created_at >= earliest || r.updated_at >= earliest);

  // Research duty satisfaction: research_finding|decision|anti_pattern since earliest research event.
  let researchSatisfied = true;
  let earliestResearch = null;
  if (hasResearchDuty) {
    const rts = researchEvents.map((e) => e.at).filter(Boolean).sort();
    earliestResearch = rts.length ? rts[0] : now;
    researchSatisfied = store
      .query({ types: ['research_finding', 'decision', 'anti_pattern'], cap: 1000 })
      .some((r) => r.created_at >= earliestResearch || r.updated_at >= earliestResearch);
  }

  // Concept duty satisfaction (decision 7208729b): per FAMILY, a feature_article
  // carrying concept_family === family created/updated since that family's
  // earliest concept_designed event. General capture does NOT satisfy it — only
  // the family's concept article does (mirrors the article-demand semantics).
  let unmetFamilies = [];
  if (hasConceptDuty) {
    const articles = store.query({ types: ['feature_article'], cap: 1000, include_unconfirmed: true });
    unmetFamilies = [...conceptFamilies.entries()]
      .filter(
        ([family, since]) =>
          !articles.some((a) => a.concept_family === family && (a.created_at >= since || a.updated_at >= since))
      )
      .map(([family]) => family);
  }
  const conceptSatisfied = unmetFamilies.length === 0;

  // §6 H10 article demand: touched files nothing owns, at threshold or any new
  // unowned file (vs git HEAD; no-git degrades loud to threshold-only).
  // Ownership joins feature_article AND repo-located reference docs (§3.2.5) —
  // same join as H7; a governing document's owner is its reference_material
  // record, never a forced feature article (adjudicated 2026-06-12).
  // A record declaring a working_tree owns files in a DIFFERENT tree — it never
  // grants ownership of this root's same-named path (comsoft-juiced 2026-07-17).
  const unowned = paths.filter(
    (p) => !store.query({ types: ['feature_article', 'reference_material'], file_keys: [p], cap: 25 }).some((r) => !r.working_tree)
  );
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
      store.recordCheckSkipped('article-demand-newfile', 'no_git', undefined, now);
    }
  }
  const articleDemand = unowned.length >= config.article_demand.min_unowned_files || newUnowned.length > 0;

  // All duties satisfied → clear registers and release.
  const captureSatisfied = !hasCaptureDuty || captured;
  if (captureSatisfied && (!hasResearchDuty || researchSatisfied) && conceptSatisfied && !articleDemand) {
    clearRegisters();
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
      releaseWithPressure(); // registers deliberately NOT cleared — see above
    }
    const openPending = store
      .query({ types: ['todo'], cap: 1000 })
      .some((t) => t.source === 'system' && t.system_reason === 'capture_owed');
    if (!openPending) {
      store.create({
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
        text: `capture owed: declared pending (${pendingDetail}) but no durable write had landed by session release — verify the target landed its capture against HEAD, then close`,
        source: 'system',
        system_reason: 'capture_owed',
        file_keys: activePaths.slice(0, 20),
      });
    }
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
      integrityNote = `\nTest-integrity vs git HEAD: modified ${JSON.stringify(ti.modified)}, deleted ${JSON.stringify(ti.deleted)} — review these before capture.`;
    }
  }

  if (!input.stop_hook_active && !existsSync(nagMarker)) {
    writeFileSync(nagMarker, JSON.stringify({ at: now }));
    const parts = [];

    // The conductor's shell cwd is the TARGET project, where scripts/no-capture.mjs
    // does not exist — it lives in the plugin clone. The platform sets
    // CLAUDE_PLUGIN_ROOT for hook processes, so resolve the ABSOLUTE path here
    // and print THAT; a relative fallback only when the env var is absent
    // (2026-08-09 consuming project: the relative path cost two failed node
    // invocations and a Glob hunt for the real location).
    const noCaptureCmd = process.env.CLAUDE_PLUGIN_ROOT
      ? `node "${join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts', 'no-capture.mjs')}"`
      : 'node scripts/no-capture.mjs';

    // Capture duty nag (touches or debug events present, nothing captured).
    // Reviewer advice is NOT this hook's business (board cac61a95): it repeated
    // identically on every firing and had gone unread; H2's selection-inject
    // surface is the place for that, not a capture-demand message.
    // A capture_pending declaration suppresses the capture nag — the deferral
    // block above owns that lane end-to-end (other unmet duties still nag).
    if (hasCaptureDuty && !captured && !pendingDetail) {
      const hasDebug = activeDebugEvents.length > 0;
      const declareLine =
        `Or declare: nothing durable → the no_capture MCP tool (or ${noCaptureCmd} --reason "<why>"); ` +
        `capture drafted and riding an in-flight commit/agent → the capture_pending MCP tool. A false declaration is drift.`;
      if (hasDebug) {
        let capturePart =
          `H10: direct-mode work included debug investigation but nothing was captured (no decision/article since ${earliest}).\n` +
          `Capture what was learned inline — expected types include disconfirmed_hypothesis (for disproven theories) and anti_pattern (for identified bad patterns).\n` +
          declareLine;
        capturePart += integrityNote;
        parts.push(capturePart);
      } else {
        parts.push(
          `H10: direct-mode work touched ${activePaths.length} file(s) but nothing was captured (no decision/article since ${earliest}).\n` +
            `Capture what was learned inline (knowledge_create). ${declareLine}` +
            integrityNote
        );
      }
    }

    // Research duty nag: cite queries/agents verbatim (interface slice 2).
    if (hasResearchDuty && !researchSatisfied) {
      const queryTexts = researchEvents.map((e) => e.detail).filter(Boolean).join(', ');
      parts.push(
        `H10: research in this session was not followed by a durable capture (no research_finding/decision/anti_pattern since ${earliestResearch}).\n` +
          `Queries/agents: ${queryTexts}\n` +
          `Capture the research findings now (knowledge_create type research_finding), or state explicitly that nothing durable was learned.`
      );
    }

    // Concept demand nag (decision 7208729b): design settled, article owed NOW.
    if (!conceptSatisfied) {
      parts.push(
        `H10 concept demand: design settled this session for concept famil${unmetFamilies.length === 1 ? 'y' : 'ies'} ${JSON.stringify(unmetFamilies)} but no concept article was created or updated since.\n` +
          `Create/update the family article(s) NOW (knowledge_create/knowledge_update type feature_article with concept_family set) — what the concept IS + members, INTENT + INTERACTIONS cross-referenced by sibling slug, owning code files; general capture does not satisfy this.`
      );
    }

    // Article demand nag.
    if (articleDemand) {
      parts.push(
        `H10 article demand (§6): ${unowned.length} touched file(s) have no owner (feature_article or repo-located reference doc)` +
          `${newUnowned.length ? ` (${newUnowned.length} newly created)` : ''}: ${JSON.stringify(unowned.slice(0, 20))}.\n` +
          `Create or extend the owning article(s) NOW (knowledge_create type feature_article; for a governing document, reference_material kind doc) — the knowledge is freshest before this session ends; general capture does not satisfy this.`
      );
    }

    // Conductor pressure rides the same deny (one block per Stop, P1) and spends the
    // once-per-session marker at its level so no separate pressure block follows.
    if (pressure.level === 'soft' || pressure.level === 'hard') {
      parts.push(pressurePart());
      spendPressureMarker(pressure.level);
    }

    // The delegation-watch advisory rides the same deny and spends its marker, so
    // no standalone delegation block follows (decision 8b00e77a).
    if (delegation && !delegationSpent()) {
      spendDelegationMarker();
      parts.push(delegationPart());
    }

    deny(parts.join('\n\n'));
  }

  // Second pass: still owed — queue items and let the session end (P1: don't trap the human).
  if (hasCaptureDuty && !captured) {
    const open = store
      .query({ types: ['todo'], cap: 1000 })
      .some((t) => t.source === 'system' && t.system_reason === 'capture_owed');
    if (!open) {
      store.create({
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
        text: pendingDetail
          ? `capture owed: declared pending (${pendingDetail}) but no durable write had landed by session release — verify the target landed its capture against HEAD, then close`
          : `capture owed: direct-mode session touched ${activePaths.length} file(s) and ended without capture`,
        source: 'system',
        system_reason: 'capture_owed',
        file_keys: activePaths.slice(0, 20),
      });
    }
  }
  if (articleDemand) {
    const openArticle = store
      .query({ types: ['todo'], cap: 1000 })
      .some((t) => t.source === 'system' && t.system_reason === 'article_missing' && (t.file_keys ?? []).some((k) => unowned.includes(k)));
    if (!openArticle) {
      store.create({
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
        text: `article missing: direct-mode work touched ${unowned.length} file(s) nothing owns (feature_article or repo-located reference doc)${newUnowned.length ? ` (${newUnowned.length} newly created)` : ''} — create the owning article(s) (§6 H10 / §12 accretion)`,
        source: 'system',
        system_reason: 'article_missing',
        file_keys: unowned.slice(0, 20),
      });
    }
  }
  if (!conceptSatisfied) {
    // One item PER family, deduped on an open item naming the same family — a
    // family's article is one drain action ('created'), independent per family.
    const openConcept = store
      .query({ types: ['todo'], cap: 1000 })
      .filter((t) => t.source === 'system' && t.system_reason === 'concept_article_missing');
    for (const family of unmetFamilies) {
      if (openConcept.some((t) => t.text.includes(`'${family}'`))) continue;
      store.create({
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
        text: `concept article missing: design settled for concept family '${family}' and the session ended without its concept article — create/update the feature_article with concept_family '${family}' (decision 7208729b)`,
        source: 'system',
        system_reason: 'concept_article_missing',
      });
    }
  }
  if (hasResearchDuty && !researchSatisfied) {
    const open = store
      .query({ types: ['todo'], cap: 1000 })
      .some((t) => t.source === 'system' && t.system_reason === 'research_owed');
    if (!open) {
      const queryTexts = researchEvents.map((e) => e.detail).filter(Boolean).join('; ');
      store.create({
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
  clearRegisters();
  releaseWithPressure();
} catch (e) {
  // A throw here (config parse, store read) would otherwise skip every session-end
  // duty silently on a non-blocking exit-1. Degrade LOUD instead (AC4): record a
  // check_skipped trail best-effort, then warn. deny()/allow() exit the process,
  // so reaching this catch means an UNEXPECTED failure, not a duty nag.
  try {
    store.recordCheckSkipped('h10-stop-duties', String((e && e.message) || e), undefined, new Date().toISOString());
  } catch {
    // store itself is the casualty — the warn below is the remaining loud signal
  }
  warnNonBlocking(`H10: session-end duties skipped — ${(e && e.message) || e} (recorded check_skipped h10-stop-duties; fix and re-run before relying on capture/article demand)`);
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
