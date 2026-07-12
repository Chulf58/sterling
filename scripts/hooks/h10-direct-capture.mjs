// H10 — direct-path capture check + review (spec §6 H10). Stop, soft.
// Direct mode only: artifact-produced-but-no-capture → first Stop prompts the
// conductor to capture inline (exit 2, soft block); still missing on the next
// Stop → maintenance queue (capture_owed) and the session may end. Code-
// touching work also gets the deterministic reviewer-selection result;
// test-touching work records check_skipped {test-integrity} (script lands at
// step 8 with the pipeline baseline machinery).
// Article demand (§6 H10, adjudicated 2026-06-11): touched files no
// feature_article owns, at threshold or any new unowned file (vs git HEAD;
// no-git degrades loud) → the nag demands the OWNING ARTICLE inline; still
// missing at session end → article_missing maintenance item. General capture
// does NOT satisfy the demand — only ownership does (the unowned set
// recomputes per Stop, so creating the article clears it mechanically).
// Session-event register (run r-a6cf): H10 also reads session-events.json
// (written by H16/debug-scope). Dual-register entry: proceeds if touches OR
// events are non-empty. Capture duty: touches ∪ debug_scope events. Research
// duty: research_tool ∪ configured agent_dispatch events not followed by a
// durable capture → nag once (shared marker), then research_owed on release.
// All terminal paths clear both registers + the nag marker together (P4).
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, deny, allow, openStore, loadConfig, warnNonBlocking } from './lib/common.mjs';
import { selectReviewers } from '../lib/reviewer-selection.mjs';
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
    allow();
  }

  const config = parseConfig(loadConfig(input.cwd) ?? {});
  const now = new Date().toISOString();

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

  // Capture duty: triggered by file-touching work OR debug-scope events.
  const hasCaptureDuty = paths.length > 0 || debugEvents.length > 0;
  // Research duty: triggered by research events (research_tool or configured agent).
  const hasResearchDuty = researchEvents.length > 0;

  if (!hasCaptureDuty && !hasResearchDuty) {
    // No duties to enforce (e.g. only non-research dispatches recorded) — clear and release.
    clearRegisters();
    allow();
  }

  // Earliest timestamp across touches ∪ events (the captured-set window anchor).
  const allTimestamps = [...touches.map((t) => t.at), ...sessionEvents.map((e) => e.at)].filter(Boolean).sort();
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

  // §6 H10 article demand: touched files nothing owns, at threshold or any new
  // unowned file (vs git HEAD; no-git degrades loud to threshold-only).
  // Ownership joins feature_article AND repo-located reference docs (§3.2.5) —
  // same join as H7; a governing document's owner is its reference_material
  // record, never a forced feature article (adjudicated 2026-06-12).
  const unowned = paths.filter(
    (p) => store.query({ types: ['feature_article', 'reference_material'], file_keys: [p], cap: 1 }).length === 0
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
  if (captureSatisfied && (!hasResearchDuty || researchSatisfied) && !articleDemand) {
    clearRegisters();
    allow();
  }

  // test-touching → test-integrity vs git HEAD (§8.2); non-git degrades loud.
  const testGlobs = (config.toolchains ?? []).flatMap((tc) => tc.test_globs ?? []);
  let integrityNote = '';
  if (hasCaptureDuty && !captured && paths.some((p) => testGlobs.some((g) => matchesGlob(p, g)))) {
    const ti = gitTestIntegrity({ cwd: input.cwd, testGlobs });
    if (ti.no_git) store.recordCheckSkipped('test-integrity', 'no_git', undefined, now);
    else if (ti.modified.length || ti.deleted.length) {
      integrityNote = `\nTest-integrity vs git HEAD: modified ${JSON.stringify(ti.modified)}, deleted ${JSON.stringify(ti.deleted)} — review these before capture.`;
    }
  }

  if (!input.stop_hook_active && !existsSync(nagMarker)) {
    writeFileSync(nagMarker, JSON.stringify({ at: now }));
    const parts = [];

    // Capture duty nag (touches or debug events present, nothing captured).
    if (hasCaptureDuty && !captured) {
      const hasDebug = debugEvents.length > 0;
      const diff = paths.map((path) => ({ path, added_lines: [] }));
      if (hasDebug) {
        let capturePart =
          `H10: direct-mode work included debug investigation but nothing was captured (no decision/note/article since ${earliest}).\n` +
          `Capture what was learned inline — expected types include disconfirmed_hypothesis (for disproven theories) and anti_pattern (for identified bad patterns).`;
        if (paths.length > 0) {
          const selection = selectReviewers({ config, diff });
          capturePart += `\nReviewer selection for this diff: dispatch ${JSON.stringify(selection.dispatch)}; skipped ${JSON.stringify(selection.skipped)}.`;
        }
        capturePart += integrityNote;
        parts.push(capturePart);
      } else {
        const selection = selectReviewers({ config, diff });
        parts.push(
          `H10: direct-mode work touched ${paths.length} file(s) but nothing was captured (no decision/note/article since ${earliest}).\n` +
            `Capture what was learned inline (knowledge_create), or state explicitly that nothing durable was learned.\n` +
            `Reviewer selection for this diff: dispatch ${JSON.stringify(selection.dispatch)}; skipped ${JSON.stringify(selection.skipped)}.` +
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

    // Article demand nag.
    if (articleDemand) {
      parts.push(
        `H10 article demand (§6): ${unowned.length} touched file(s) have no owner (feature_article or repo-located reference doc)` +
          `${newUnowned.length ? ` (${newUnowned.length} newly created)` : ''}: ${JSON.stringify(unowned.slice(0, 20))}.\n` +
          `Create or extend the owning article(s) NOW (knowledge_create type feature_article; for a governing document, reference_material kind doc) — the knowledge is freshest before this session ends; general capture does not satisfy this.`
      );
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
        text: `capture owed: direct-mode session touched ${paths.length} file(s) and ended without capture`,
        source: 'system',
        system_reason: 'capture_owed',
        file_keys: paths.slice(0, 20),
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
  allow();
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
} finally {
  store.close();
}
