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
        const windowSize = (model && cw.windows[model]) || cw.windows.default;
        const fill = fillPct(usage, windowSize);
        const level = fill >= cw.conductor.hard_pct ? 'hard' : fill >= cw.conductor.soft_pct ? 'soft' : 'below_soft';
        sample = { session_id: input.session_id, level, fill_pct: fill, model: model ?? null, window: windowSize, at: now };
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
  const pressurePart = () =>
    pressure.level === 'hard'
      ? `H10 conductor context pressure: fill ${pressure.fill_pct.toFixed(1)}% ≥ hard threshold ${config.context_watch.conductor.hard_pct}% of the ${pressure.window}-token window. Do not open substantial new work in this window: finish and commit what is open, and DELEGATE remaining reads and mechanical work to subagents — the conductor's context is the scarce resource (P1). This notice fires once per session.`
      : `Conductor context pressure: fill ${pressure.fill_pct.toFixed(1)}% ≥ soft threshold ${config.context_watch.conductor.soft_pct}% — prefer finishing open work over opening large new areas; delegate reads to subagents.`;
  const spendPressureMarker = () => writeFileSync(pressureMarker, JSON.stringify({ session_id: input.session_id, at: now }));
  const pressureMarkerSpent = () => {
    try {
      return JSON.parse(readFileSync(pressureMarker, 'utf8')).session_id === input.session_id;
    } catch {
      return false;
    }
  };
  /** Every direct-mode release path exits through here: hard pressure soft-blocks ONCE per session. */
  const releaseWithPressure = () => {
    if (pressure.level === 'hard' && !input.stop_hook_active && !pressureMarkerSpent()) {
      spendPressureMarker();
      deny(pressurePart());
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

  // Widened captured set: decision|anti_pattern|note|feature_article|research_finding|disconfirmed_hypothesis
  const captured = store
    .query({ types: ['decision', 'anti_pattern', 'note', 'feature_article', 'research_finding', 'disconfirmed_hypothesis'], cap: 1000, include_unconfirmed: true })
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
          `H10: direct-mode work included debug investigation but nothing was captured (no decision/note/article since ${earliest}).\n` +
          `Capture what was learned inline — expected types include disconfirmed_hypothesis (for disproven theories) and anti_pattern (for identified bad patterns).\n` +
          declareLine;
        capturePart += integrityNote;
        parts.push(capturePart);
      } else {
        parts.push(
          `H10: direct-mode work touched ${activePaths.length} file(s) but nothing was captured (no decision/note/article since ${earliest}).\n` +
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

    // Conductor pressure rides the same deny (one block per Stop, P1): soft advises,
    // hard advises AND spends the once-per-session marker so no second block follows.
    if (pressure.level === 'soft' || pressure.level === 'hard') {
      parts.push(pressurePart());
      if (pressure.level === 'hard') spendPressureMarker();
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
