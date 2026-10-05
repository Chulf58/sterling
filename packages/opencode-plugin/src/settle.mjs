// Settlement at the end of an execution: mint reconcile duties for the files the
// last turn changed, weigh H10's other duties (below), advance the settled
// snapshot, and notify. The maintenance worker launch that follows is worker.mjs.
//
// H10's other session-end duties on OpenCode: capture_owed, article_missing,
// concept_article_missing and research_owed. OpenCode has no stop block, so
// each settlement does what H10's two Stops do (decision
// sterling-is-fully-standalone-on-opencode-2-full-parity-with-claude-code):
// a duty first found unpaid is a NEXT-TURN NOTICE (H10's nag); a duty still
// unpaid at the next settlement is queued as its maintenance item (H10's second
// pass). The rules and the item texts are H10's, from
// scripts/hooks/lib/session-duties.mjs.
//
// Inputs: the files the turn changed are settlement's git candidates (H7's
// touches register is Claude-only); concept_designed, no_capture and research
// events come from .sterling/transient/session-events.json, which the MCP
// tools write on both hosts. An event is weighed once: its key is remembered
// in DUTIES_REL until it leaves the register.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { gitIgnored, loadConfig } from '../../../scripts/hooks/lib/common.mjs';
import { agentRole } from './agent-name.mjs';
import {
  IMAGE_BINARY_EXT,
  articleMissingText,
  capturedSince,
  captureOwedText,
  conceptArticleMissingText,
  conceptFamiliesFrom,
  demandExemption,
  dischargedByCutoff,
  hasOpenSystemTodo,
  isValidAt,
  noCaptureCutoffs,
  openDutyRecords,
  ownershipJoin,
  researchCapturedSince,
  researchOwedText,
  systemTodo,
  unmetConceptFamilies,
} from '../../../scripts/hooks/lib/session-duties.mjs';
import { gitTouches, loadGeneratedProjections, mintSettlementReconcile, writeGitSettled, writeInitialGitSettled } from '../../../scripts/hooks/lib/settlement.mjs';
import { dispatchState, readDispatchState, readRegister } from '../../../scripts/lib/dispatch-register.mjs';
import { errText, logLine } from './log.mjs';
import { addNotice, pruneShownNotices } from './notices.mjs';

export const DUTIES_REL = '.sterling/transient/opencode-duties.json';
const EVENTS_REL = '.sterling/transient/session-events.json';
const WEIGHED_KINDS = new Set(['concept_designed', 'research_tool', 'agent_dispatch']);

const eventKey = (e) => `${e.kind}|${e.detail ?? ''}|${e.at ?? ''}`;

function readDutyState(root) {
  const p = join(root, DUTIES_REL);
  if (!existsSync(p)) return { owed: [], weighed: [] };
  const parsed = JSON.parse(readFileSync(p, 'utf8'));
  if (!parsed || !Array.isArray(parsed.owed) || !Array.isArray(parsed.weighed)) throw new Error(`${DUTIES_REL} is not a {owed, weighed} object`);
  return parsed;
}

/** The session-event register, or { error } when it cannot be read; an absent register is empty. */
function readSessionEvents(root) {
  const p = join(root, EVENTS_REL);
  if (!existsSync(p)) return { events: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) return { events: [], error: 'it is not a JSON array' };
    return { events: parsed.filter((e) => e && typeof e === 'object') };
  } catch (e) {
    return { events: [], error: String((e && e.message) || e) };
  }
}

/** Paths among `paths` absent from `base`'s tree (git ls-tree), or null when git cannot answer. */
function newSince(root, base, paths) {
  if (!paths.length) return [];
  const r = spawnSync('git', ['ls-tree', '-r', base, '--name-only', '--', ...paths], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) return null;
  const inBase = new Set(r.stdout.split('\n').filter(Boolean));
  return paths.filter((p) => !inBase.has(p));
}

/**
 * The article demand over `paths`: { unowned, newly } when it fires, else null.
 * `degraded` collects what could not be checked (the demand then leans toward
 * signaling, as H10's does).
 */
function articleDemand(store, root, config, paths, base, degraded) {
  const exempt = demandExemption(config, loadGeneratedProjections(root));
  const { isUnowned } = ownershipJoin(store, root);
  let unowned = paths.filter((p) => existsSync(join(root, p)) && !exempt(p) && isUnowned(p));
  if (unowned.length) {
    const ignored = gitIgnored(unowned, root);
    if (ignored === null) degraded.push('git check-ignore failed, so ignored files may be named');
    else unowned = unowned.filter((p) => !ignored.has(p));
  }
  let newly = newSince(root, base, unowned);
  if (newly === null) {
    degraded.push(`git ls-tree ${base} failed, so newly created files were not told apart`);
    newly = [];
  }
  return unowned.length && (unowned.length >= config.article_demand.min_unowned_files || newly.length > 0) ? { unowned, newly } : null;
}

const describe = (d) => {
  if (d.duty === 'capture') return `capture owed: ${d.paths.length} changed file(s) and no knowledge record written since ${d.since} (${d.paths.slice(0, 5).join(', ')}${d.paths.length > 5 ? ', ...' : ''}). Capture what the turn learned (knowledge_create or knowledge_update), or declare no_capture if nothing durable was learned.`;
  if (d.duty === 'article') return `article missing: ${d.paths.length} changed file(s) nothing owns${d.newly.length ? ` (${d.newly.length} newly created)` : ''}: ${d.paths.join(', ')}. Create the owning feature_article, or add the files to an existing one (knowledge_append files[]).`;
  if (d.duty === 'concept') return `concept article missing: concept_designed was registered for concept_family '${d.family}' and no feature_article with that concept_family was written. Create or update it.`;
  return `research owed: research ran (${d.details.join('; ')}) and no research_finding, decision or anti_pattern was written since ${d.since}. Capture the finding, or declare no_capture with lane research.`;
};

/**
 * Weigh this settlement's duties: queue last settlement's still-unpaid ones,
 * then find this turn's. Returns { notices } for the caller to raise, and
 * writes the duty state. `git` is settlement's gitTouches result.
 *
 * The capture and research reads cover the project store plus every mounted
 * domain store that exists on disk (openDutyRecords, shared with H10), opened
 * with `opener` and closed before this returns. A domain store that cannot be
 * read pays nothing and gets its own notice.
 *
 * A domain record pays only when this project's MCP server logged a write of
 * it inside the window, in the domain-write ledger under `root`
 * (one file per server process, read by readKnowledgeWrites; decision
 * domain-record-duty-credit-comes-from-a-per-project-write-ledger). Settlement
 * reads the ledger and never writes or clears it. A ledger file that cannot be
 * read pays nothing and is named in a notice; the other ledger files still
 * count. The maintenance-worker child runs
 * under the same root, so a domain record it writes pays like any other.
 */
export function settleDuties(store, root, git, at, { opener } = {}) {
  const config = parseConfig(loadConfig(root) ?? {});
  const unreadable = [];
  const ledgerErrors = [];
  const records = openDutyRecords(store, config, {
    ...(opener ? { opener } : {}),
    onUnreadable: (name, error) => unreadable.push(`'${name}' (${error})`),
    root,
    onLedgerUnreadable: (error, file) => ledgerErrors.push(`${file} (${error})`),
  });
  try {
    const { notices } = weighDuties(store, records, config, root, at, git);
    if (ledgerErrors.length) notices.push(`Sterling settlement: domain-write ledger file(s) could not be read: ${ledgerErrors.join('; ')}. A domain-scoped record logged only there was not counted toward the capture and research duties; entries in this project's other ledger files still counted. Fix or remove the file(s).`);
    if (unreadable.length) notices.push(`Sterling settlement: domain store(s) ${unreadable.join(', ')} could not be read; a record written there was not counted toward the capture and research duties.`);
    return { notices };
  } finally {
    for (const c of records.close()) logLine(root, `settle: domain store '${c.name}' did not close cleanly (${c.error})`);
  }
}

function weighDuties(store, records, config, root, at, git) {
  const state = readDutyState(root);
  const register = readSessionEvents(root);
  const events = register.events;
  const cutoffs = noCaptureCutoffs(events);
  const notices = [];
  const degraded = [];
  if (register.error) notices.push(`Sterling settlement: ${EVENTS_REL} could not be read (${register.error}); the concept and research duties were not weighed this settlement. Fix or remove the file.`);
  const base = git.base_lost ? 'HEAD' : git.settled.sha;

  // Second pass: last settlement's nagged duties, re-checked against their own anchors.
  const queued = [];
  for (const d of state.owed) {
    if (d.duty === 'capture') {
      if (capturedSince(records, d.since) || dischargedByCutoff(d.last, cutoffs.capture)) continue;
      if (!hasOpenSystemTodo(store, 'capture_owed')) {
        const keys = d.paths.slice(0, 20);
        const clipped = d.paths.length > keys.length ? ` (file list truncated: naming ${keys.length} of ${d.paths.length} touched path(s))` : '';
        store.enqueueSystemTodo(systemTodo(at, { text: captureOwedText(d.paths.length, clipped), system_reason: 'capture_owed', file_keys: keys }));
      }
      queued.push('capture_owed');
    } else if (d.duty === 'article') {
      const still = articleDemand(store, root, config, d.paths, base, degraded);
      if (!still) continue;
      const overlapping = store.query({ types: ['todo'], cap: 1000 }).some((t) => t.source === 'system' && t.system_reason === 'article_missing' && (t.file_keys ?? []).some((k) => still.unowned.includes(k)));
      if (!overlapping) store.enqueueSystemTodo(systemTodo(at, { text: articleMissingText(still.unowned, { newlyCreated: still.newly.length }), system_reason: 'article_missing', file_keys: still.unowned }));
      queued.push('article_missing');
    } else if (d.duty === 'concept') {
      if (!unmetConceptFamilies(store, new Map([[d.family, d.since]]), d.window_start).length) continue;
      store.enqueueSystemTodo(systemTodo(at, { text: conceptArticleMissingText(d.family), system_reason: 'concept_article_missing' }));
      queued.push(`concept_article_missing (${d.family})`);
    } else if (d.duty === 'research') {
      if (researchCapturedSince(records, d.since) || dischargedByCutoff(d.last, cutoffs.research)) continue;
      if (!hasOpenSystemTodo(store, 'research_owed')) store.enqueueSystemTodo(systemTodo(at, { text: researchOwedText(d.details.join('; ')), system_reason: 'research_owed' }));
      queued.push('research_owed');
    } else {
      throw new Error(`${DUTIES_REL} holds an unknown duty '${d.duty}'`);
    }
  }
  if (queued.length) notices.push(`Sterling settlement: duties the previous turn left unpaid are now queued as maintenance items: ${queued.join(', ')}. Pay them, or drain them with /sterling:drain.`);

  // First pass: this turn's duties.
  const owed = [];
  const windowStart = isValidAt(git.settled.at) ? git.settled.at : at;
  const changed = git.candidates.filter((c) => existsSync(join(root, c.path)));
  const generated = loadGeneratedProjections(root);
  const touched = changed.filter((c) => !IMAGE_BINARY_EXT.test(c.path) && !generated.has(c.path) && !dischargedByCutoff(c.at, cutoffs.capture));
  if (touched.length && !capturedSince(records, windowStart)) {
    const ats = touched.map((c) => c.at).filter(isValidAt).sort();
    owed.push({ duty: 'capture', since: windowStart, last: ats.at(-1) ?? at, paths: touched.map((c) => c.path) });
  }
  const demand = articleDemand(store, root, config, changed.map((c) => c.path), base, degraded);
  if (demand) owed.push({ duty: 'article', paths: demand.unowned, newly: demand.newly });

  const weighed = new Set(state.weighed);
  const fresh = events.filter((e) => WEIGHED_KINDS.has(e.kind) && !weighed.has(eventKey(e)));
  const sessionAts = fresh.map((e) => e.at).filter(isValidAt).sort();
  const earliestSessionAt = sessionAts[0] ?? at;
  const families = conceptFamiliesFrom(fresh);
  for (const family of unmetConceptFamilies(store, families, earliestSessionAt)) owed.push({ duty: 'concept', family, since: families.get(family), window_start: earliestSessionAt });
  const researchAgents = new Set(config.session_events.research_agents);
  // OpenCode names the installed roles sterling/<role>; the role is what research_agents lists.
  const isResearchAgent = (d) => researchAgents.has(d) || researchAgents.has(agentRole(String(d ?? '')));
  const research = fresh.filter((e) => (e.kind === 'research_tool' || (e.kind === 'agent_dispatch' && isResearchAgent(e.detail))) && !dischargedByCutoff(e.at, cutoffs.research));
  if (research.length) {
    const ats = research.map((e) => e.at).filter(isValidAt).sort();
    const since = ats[0] ?? at;
    if (!researchCapturedSince(records, since)) owed.push({ duty: 'research', since, last: ats.at(-1) ?? at, details: research.map((e) => e.detail).filter(Boolean) });
  }
  if (owed.length) notices.push(`Sterling settlement: the last turn left ${owed.length} duty(ies) unpaid (OpenCode has no stop block, so this is the reminder; still unpaid at the next settlement, each is queued as a maintenance item):\n${owed.map((d) => `- ${describe(d)}`).join('\n')}`);
  if (degraded.length) notices.push(`Sterling settlement: the article demand was checked with a degraded probe: ${degraded.join('; ')}.`);

  const present = new Set(events.map(eventKey));
  const nextWeighed = [...new Set([...state.weighed.filter((k) => present.has(k)), ...fresh.map(eventKey)])];
  writeJsonAtomic(join(root, DUTIES_REL), { owed, weighed: nextWeighed });
  return { notices };
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * A live dispatch means paths are still being changed under it, so the snapshot
 * must not advance past them. Two sources: the dispatch register (any row
 * without `ended`: a Claude Code round, which H10 settles itself, or an OpenCode
 * subagent's round, registered when its call binds the child) and the dispatch
 * state, where an OpenCode subagent is bound to its child session until it ends
 * (dispatch.mjs).
 * A pending record (no binding yet) does not count: its call has not returned, so
 * the root execution has not ended either, and an orphan left by a denied call
 * must not hold the snapshot forever. Anything that cannot be read counts as
 * live (fail closed).
 */
export function liveDispatch(root) {
  const reg = readRegister(root);
  if (reg.availability !== 'absent' && reg.availability !== 'ok') return { live: true, why: `the dispatch register is ${reg.availability}` };
  const rows = reg.availability === 'ok' ? reg.entries.filter((e) => !e.ended) : [];
  if (rows.length) return { live: true, why: `${rows.length} dispatch(es) still registered (${rows.map((r) => r.agent_id).join(', ')})` };
  const state = readDispatchState(root);
  if (state.availability !== 'absent' && state.availability !== 'ok') return { live: true, why: `the dispatch state is ${state.availability}${state.reason ? ` (${state.reason})` : ''}` };
  if (state.poisoned.length) return { live: true, why: `the dispatch state holds ${state.poisoned.length} unreadable record(s) (${state.poisoned.map((p) => p.file).join(', ')})` };
  const bound = state.records.map((r) => r.record).filter((r) => ['bound', 'started'].includes(dispatchState(r)));
  if (bound.length) {
    const child = (r) => r.post_binding?.agent_id ?? r.derived_binding?.agent_id ?? r.started?.agent_id;
    return { live: true, why: `${bound.length} subagent dispatch(es) still running (${bound.map((r) => `${r.subagent_type ?? 'agent'} in child session ${child(r)}`).join(', ')})` };
  }
  return { live: false };
}

/** The settle step for one execution; `launchWorkerFor(root, at)` runs after a settlement that did not fail. */
export function createSettle({ openStore, now, launchWorkerFor }) {
  async function settle(root) {
    pruneShownNotices(root);
    const at = now();
    const git = gitTouches(root, at);
    if (!git.ok) {
      if (git.reason !== 'no_git') addNotice(root, `Sterling settlement skipped: git could not answer (${git.reason}).`, at);
      return;
    }
    if (!git.settled) {
      writeInitialGitSettled(root, git.next);
      return;
    }
    const dispatch = liveDispatch(root);
    let store;
    try {
      store = openStore(join(root, '.sterling', 'sterling.db'));
      const minted = mintSettlementReconcile(store, root, git.candidates.map((c) => c.path), at);
      const duties = settleDuties(store, root, git, at, { opener: openStore });
      if (!dispatch.live) writeGitSettled(root, git.next);
      if (minted.length) {
        const lines = minted.map((m) => {
          const a = store.get(m.article_id);
          return `${a?.slug ?? m.article_id} (${m.paths.join(', ')})`;
        });
        addNotice(root, `Sterling settlement: the last turn changed files owned by ${minted.length} article(s) and queued reconcile duties: ${lines.join('; ')}. Bring each article in line with the change (knowledge_update), or confirm it already is.`, at);
      }
      for (const text of duties.notices) addNotice(root, text, at);
      if (git.base_lost) addNotice(root, `Sterling settlement: the settled commit ${git.settled.sha} is no longer reachable from HEAD ${git.next.sha}; duties for the commits between them were not derived. Reconcile them by hand from git log.`, at);
      if (dispatch.live) addNotice(root, `Sterling settlement: the settled snapshot was not advanced because ${dispatch.why}; the first settlement after the dispatch ends advances it. If no subagent is still running (OpenCode exited or crashed mid-dispatch), restart OpenCode: its first root request sweeps the dispatch records a dead process left live.`, at);
    } catch (e) {
      logLine(root, `settle failed: ${errText(e)}`);
      addNotice(root, `Sterling settlement failed (${errText(e)}); the settled snapshot was not advanced, so the next turn retries the same range.`, at);
      return;
    } finally {
      store?.close();
    }
    launchWorkerFor(root, at);
  }

  return settle;
}
