// H19's dispatch staging, host-neutral: the knowledge-delivery payload for the
// territory a DISPATCH BRIEF names, plus the per-dispatch chrome (active plan,
// TDD posture, the default return contract). Extracted from
// h19-dispatch-staging.mjs so the OpenCode context hook stages a child session
// from the same code (board cbee2b3d, audit f2ba68c2 row 24). What stays in each
// host is only how the brief is obtained: Claude resolves it through the
// dispatch-state machine at SubagentStart, OpenCode reads the child session's
// first user message. Attribution is the caller's, per decision
// h22-start-staging-only-when-attribution-is-unambiguous-no-sidecar.
//
// Hooks bundle this module: builtins, sibling libs and @sterling/store only.
import { MAX_RANK_TERMS } from '@sterling/store';
import { loadConfig, repoRel } from './common.mjs';
import { extractPathCandidates } from './dispatch-prompt.mjs';
import { readLock as readPlanLock, sanitizeForContext, sterlingDirOf } from './plan-lock.mjs';
import { isForeignTree } from './working-tree.mjs';
import { readProjectConfig, tddPostureLine as renderTddPostureLine } from './operating-state.mjs';
import {
  AXIS_MIN_DISCRIMINATING_HITS,
  AXIS_MIN_HITS,
  HAZARD_CAP,
  assembleDelivery,
  axisHits,
  boundedTermClause,
  cappedHazards,
  decisionPointerPart,
  extractAxisTerms,
  guardPath,
  hasDiscriminatingHit,
  hasRecordCentralityHit,
  hazardParts,
  isDiscoveryDelivered,
  isKnownDelivered,
  isOwnerDiscoveryOnly,
  isSubstanceDelivered,
  markDiscoveryDelivered,
  markSubstanceDelivered,
  ownerPointer,
  ownerSuffix,
  payloadHeaderLine,
  rankFileDecisionPointers,
  withInboundSupersedes,
  readGuard,
  recordCentralityHits,
  recordRevision,
  renderArticle,
  renderReference,
  resolveTotalCap,
  stripReviewTerritoryLine,
  writeGuard,
} from './delivery.mjs';

// Subject-channel decision ceiling — mirrors H20's MAX_DECISIONS: a keyword
// match is weaker evidence than a file_keys join, so it earns less attention.
const SUBJECT_MAX_DECISIONS = 5;

// True platform-internal agents whose output configures the harness rather
// than being a human-facing work product (h28 fold) — kept deliberately
// NARROW: only agents whose report a return contract would be noise for.
export const EXEMPT_AGENT_TYPES = new Set(['statusline-setup']);

// STATIC and SELF-SUBORDINATING (h28 fold) — the first clause cedes
// precedence to any explicit brief/role output contract, so combining it
// with the knowledge payload is always harmless.
export const RETURN_CONTRACT =
  'STERLING DEFAULT RETURN CONTRACT — Explicit output requirements in your ' +
  'agent definition or dispatch brief take precedence. Otherwise, return the ' +
  'conclusion, not a work transcript: maximum ~250 words; no pasted diffs, raw ' +
  'logs, or step-by-step narration. Report only the outcome, decisive evidence, ' +
  'relevant files/tests, and unresolved risks.';

// Implementor dispatches (the roster's one writing role) get the live TDD posture
// (decision foreign_752caf98) and the active plan line; a researcher, scout or
// reviewer judges against the store and the brief, not the plan's ordering.
const CHROME_AGENT_TYPES = new Set(['implementor']);
const PLAN_TITLE_MAX = 120;
const PLAN_PATH_MAX = 320;

/**
 * The per-dispatch chrome lines for `agentType`: the TDD posture (the SAME line
 * H1 injects, read fresh from the config so a mid-session toggle reaches a fresh
 * agent; an unreadable config reads UNKNOWN exactly as in H1) and the ACTIVE PLAN
 * line (decision plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry).
 * Each is '' when it does not apply. Fail-open: a malformed config or lock costs
 * only its own line, never the knowledge payload.
 */
export function dispatchChrome(cwd, agentType) {
  let tddPostureLine = '';
  let activePlanLine = '';
  if (!CHROME_AGENT_TYPES.has(agentType)) return { tddPostureLine, activePlanLine };
  try {
    tddPostureLine = renderTddPostureLine(readProjectConfig(cwd));
  } catch {
    // fail-open — a malformed config costs only this line
  }
  try {
    // The shared VALIDATING reader: a record that is JSON but not a lock stages
    // no line at all, rather than a confident line built from junk fields.
    const read = readPlanLock(sterlingDirOf(cwd));
    if (read.lock) {
      // RENDERED copy — sanitised and bounded tighter than the store bound,
      // because this rides inside another agent's context window.
      const title = sanitizeForContext(read.lock.title, PLAN_TITLE_MAX);
      const path = sanitizeForContext(read.lock.plan_path, PLAN_PATH_MAX);
      if (title || path) {
        activePlanLine = `ACTIVE PLAN: ${title || '(untitled plan)'} (${path || 'no path recorded'}) — this lane belongs to one of its slices; the plan governs the objective's scope and ordering, standing store decisions still govern mechanisms.`;
      }
    }
  } catch {
    // fail-open — a malformed lock costs only this line
  }
  return { tddPostureLine, activePlanLine };
}

/**
 * The combined context when no knowledge is staged: plan line, payload (may be
 * ''), TDD posture, the unattributable-start disclosure and the return contract
 * (omitted only for EXEMPT_AGENT_TYPES), joined into one string.
 */
export function composeContext({ agentType, activePlanLine = '', payload = '', tddPostureLine = '', unattributableLine = '' }) {
  const out = [];
  if (activePlanLine) out.push(activePlanLine);
  if (payload) out.push(payload);
  if (tddPostureLine) out.push(tddPostureLine);
  if (unattributableLine) out.push(unattributableLine);
  if (!EXEMPT_AGENT_TYPES.has(agentType)) out.push(RETURN_CONTRACT);
  return out.join('\n\n');
}

const chromePart = (text) => ({ kind: 'ordinary', pinned: true, contentClass: 'chrome', text });

/**
 * The staging payload for the brief(s) `prompts`, or null when nothing governs
 * them or every governing record was already delivered under `guardId`.
 * `leadingChrome` / `trailingChrome` are chrome lines folded into the SAME
 * assembleDelivery call as pinned-but-charged parts: the per-delivery cap is
 * charged on the FINAL composed context, never the knowledge payload alone.
 * Returns `{ text, record }`; `record()` marks the delivered records in the
 * guard ledger and must run only after `text` reached its destination, so a
 * failed write leaves every record eligible for the next delivery.
 */
export function stageBrief({ store, cwd, prompts, guardId, hazardMode, leadingChrome = [], trailingChrome = [] }) {
  const candidates = [...new Set(prompts.flatMap(extractPathCandidates))];

  const rels = [...new Set(candidates.map((c) => repoRel(c, cwd)).filter(Boolean))].filter(
    (r) => r !== '.git' && !r.startsWith('.git/') && !r.startsWith('.sterling/')
  );

  // PATH CHANNEL (AC5's original contract): declared file_keys get the payload
  // staged. No candidates is not an early exit — the SUBJECT channel below
  // (relevance slice 3, board 8f3141d4) can deliver on a pathless brief, which
  // is exactly the case path-scoping is structurally blind to.
  const owners = rels.length ? store.query({ types: ['feature_article', 'reference_material'], file_keys: rels, cap: 100 }).filter((r) => !isForeignTree(r, cwd)) : [];
  const hazards = rels.length ? store.query({ types: ['anti_pattern'], file_keys: rels, cap: 100 }) : [];
  // Each decision carries its inbound supersedes edges (board 7e4850cf (c)),
  // so a record another one supersedes is never rendered as [standing]. The
  // subject channel below does the same for its decision candidates.
  const decisions = rels.length ? store.query({ types: ['decision'], file_keys: rels, cap: 100 }).map((r) => withInboundSupersedes(store, r)) : [];

  // SUBJECT CHANNEL (relevance slice 3): the same mechanism-axis match H20
  // applies at the conductor's dispatch seam, run over the brief text and
  // delivered to the spawned agent — one mechanism, imported never reimplemented.
  // All three stage-2 floors apply (AXIS_MIN_HITS, discriminating hit, record
  // centrality). Records the path channel already carries are excluded — one
  // payload, one mention. Matched PER PROMPT, not over the union: a union lets
  // the longest prompt's vocabulary dominate extraction and attributes one
  // task's subject to another's agent.
  const pathIds = new Set([...owners, ...hazards, ...decisions].map((r) => r.id));
  const subjectMatches = [];
  const seenSubject = new Set();
  for (const p of prompts) {
    // STRIP THE REVIEW-TERRITORY RECEIPT LINE before axis-term extraction, the
    // SAME helper H20's outgoingProposalText applies (decision
    // h20-specificity-rebuild-not-fourth-patch-structural-fixes-now-red-probes-frozen,
    // fix 1). Path extraction above deliberately still reads the RAW prompt.
    const subjectText = stripReviewTerritoryLine(p);
    const terms = extractAxisTerms(subjectText, MAX_RANK_TERMS);
    if (terms.length < AXIS_MIN_HITS) continue;
    const candidatesBySubject = [...store.query({ types: ['anti_pattern'], rank_terms: terms, cap: 40 }), ...store.query({ types: ['decision'], rank_terms: terms, cap: 40 }).map((r) => withInboundSupersedes(store, r))];
    for (const r of candidatesBySubject) {
      if (pathIds.has(r.id) || seenSubject.has(r.id)) continue;
      const hits = axisHits(r, terms);
      if (hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(hits, AXIS_MIN_DISCRIMINATING_HITS) && hasRecordCentralityHit(r, subjectText)) {
        seenSubject.add(r.id);
        subjectMatches.push({ record: r, hits, prompt: subjectText });
      }
    }
  }
  subjectMatches.sort((a, b) => b.hits.length - a.hits.length);

  // Nothing on either channel: no frontier notice here (that signal belongs to
  // the file-touch hook, which fires once the agent actually touches the path).
  if (!owners.length && !hazards.length && !decisions.length && !subjectMatches.length) return null;

  const gPath = guardPath(cwd, guardId.agentId, guardId.sessionId);
  const guard = readGuard(gPath);

  // Hazards render as SUBSTANCE (whole hazard block); a read-only lane
  // (hazardMode 'pointer', user ruling 2026-09-28) gets them as discovery
  // POINTERS, fresh against either ledger.
  const hazardFresh = (r) => (hazardMode === 'pointer' ? !isKnownDelivered(guard, r) : !isSubstanceDelivered(guard, r));
  const freshHazards = hazards.filter(hazardFresh);
  // OWNERS SPLIT BY WHAT THEY WILL ACTUALLY RENDER AS: a reference_material or
  // oversize (digested) article never renders as substance, so filtering it
  // against `isSubstanceDelivered` alone left it permanently "fresh".
  const freshOwners = owners.filter((r) => (isOwnerDiscoveryOnly(r) ? !isDiscoveryDelivered(guard, r) : !isSubstanceDelivered(guard, r)));
  // RANKED ONCE, AT THE BIRTH POINT: the store's file_keys join degenerates to
  // newest-first, so capping in the renderer evicted the older standing rulings
  // on any file carrying more decisions than the cap. Ranking here keeps the
  // guard slice, the render call and this array in ONE order. NOT applied to the
  // subject channel, whose order is axis-hit strength against the brief.
  const freshDecisions = rankFileDecisionPointers(decisions.filter((r) => !isDiscoveryDelivered(guard, r)));
  // subjectMatches is anti_pattern or decision only — route each to the SAME
  // ledger its rendered contentClass will spend.
  const freshSubject = subjectMatches.filter((x) => (x.record.type === 'anti_pattern' ? hazardFresh(x.record) : !isDiscoveryDelivered(guard, x.record)));
  if (!freshOwners.length && !freshHazards.length && !freshDecisions.length && !freshSubject.length) return null;

  // LOAD-BEARING, deliberately uncaught: a corrupt config.json must fail the
  // staging payload shut under the shared-fate ruling pinned by
  // h19-dispatch-staging.test.mjs:533 ("H19+H28 shared-fate"). Do not wrap this
  // or replace it with an unused binding; the caller's catch preserves the
  // return contract while withholding knowledge delivery.
  loadConfig(cwd);

  const subjectHazards = freshSubject.filter((x) => x.record.type === 'anti_pattern').map((x) => x.record);
  const subjectDecisions = freshSubject.filter((x) => x.record.type === 'decision').map((x) => x.record);

  // PER-DELIVERY TOTAL CAP (scale-down Slice 3c, assembleDelivery in
  // lib/delivery.mjs — decision 92088a62's ONE ASSEMBLER). Hazards are complete
  // unbudgeted substance; article bodies, decisions and every other ordinary line
  // share the cap and degrade to `knowledge_get <id>` pointers. CHROME IS CHARGED
  // TOO: leading and trailing chrome are folded in as pinned-but-charged parts in
  // the SAME assembleDelivery call, so a smaller cap cannot be escaped by text
  // appended after capping.
  const totalCap = resolveTotalCap(cwd);
  const leadingChromeParts = leadingChrome.map(chromePart);
  const trailingChromeParts = trailingChrome.map(chromePart);
  // ONE HAZARD CAP PER PACKAGE (decision 92088a62: "HAZARDS: at most 3 per
  // package"). The union is ranked ONCE by cappedHazards (severity first; the path
  // channel is listed first, so it wins ties) and the top HAZARD_CAP are split
  // back into the two labelled channels. Read-only lanes keep per-channel pointer
  // caps (decision 21e3637e): a pointer line is not a whole hazard.
  const packageHazards = hazardMode === 'whole' ? cappedHazards([...freshHazards, ...subjectHazards]) : null;
  const channelCap = (list) => (packageHazards ? packageHazards.filter((r) => list.includes(r)).length : HAZARD_CAP);
  const channelCapLabel = (cap) => (cap < HAZARD_CAP ? `cap ${HAZARD_CAP} per package, shared across the path and subject channels` : undefined);
  const pathHazardCap = channelCap(freshHazards);
  const subjectHazardCap = channelCap(subjectHazards);

  const parts = [];
  if (freshOwners.length || freshHazards.length || freshDecisions.length) {
    const decisionWiden = `knowledge_query types:["decision"] file_keys:[${rels.map((r) => `"${r}"`).join(',')}] cap:${freshDecisions.length}`;
    const ownerParts = freshOwners.map((r) => {
      const text = r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r, { root: cwd });
      const contentClass = isOwnerDiscoveryOnly(r) ? 'discovery' : 'substance';
      return { kind: 'ordinary', contentClass, identity: r.id, revision: recordRevision(r), text, pointer: ownerPointer(text, r), suffix: ownerSuffix(r) };
    });
    const decisionParts = freshDecisions.length ? [decisionPointerPart(rels.join(', '), freshDecisions, { widen: decisionWiden })] : [];
    parts.push(
      // PINNED (P5), like H20's header: under disclosure pressure at the
      // transport ceiling a whole hazard falls to its pointer before a pinned
      // header is evicted, so the lane never gets unattributed hazards.
      chromePart(payloadHeaderLine(rels.join(', '))),
      ...hazardParts(freshHazards, { fileKeys: rels, mode: hazardMode, cap: pathHazardCap, capLabel: channelCapLabel(pathHazardCap) }),
      ...ownerParts,
      ...decisionParts
    );
  }
  if (subjectHazards.length || subjectDecisions.length) {
    // BOUNDED like H20's header (boundedTermClause): this header is PINNED, so an
    // uncapped union of the subject records' terms is charged to the ordinary cap
    // ahead of the owner article body.
    const matched = boundedTermClause(freshSubject.flatMap((x) => x.hits));
    const central = boundedTermClause(freshSubject.flatMap((x) => recordCentralityHits(x.record, x.prompt)));
    const subjectLabel = `your task's SUBJECT`;
    const subjectTerms = [...new Set(freshSubject.flatMap((x) => x.hits))];
    const remedy = `knowledge_query types:["anti_pattern"] rank_terms:[${subjectTerms.map((t) => `"${t}"`).join(',')}] cap:${subjectHazards.length || 1}`;
    const decisionRemedy = `knowledge_query types:["decision"] rank_terms:[${subjectTerms.map((t) => `"${t}"`).join(',')}] cap:${subjectDecisions.length || 1}`;
    parts.push(
      chromePart(
        `STERLING MECHANISM-AXIS STAGING (H19) — the store holds records matching ${subjectLabel} ` +
          `(matched on: ${matched}; central to the record: ${central}), beyond any file the task names. ` +
          `Path-scoped delivery cannot find these — consult them before acting on the premise they govern.`
      ),
      // Matched on the task's SUBJECT, not a file path.
      ...hazardParts(subjectHazards, { remedy, matchLabel: 'for this subject', mode: hazardMode, cap: subjectHazardCap, capLabel: channelCapLabel(subjectHazardCap) }),
      ...(subjectDecisions.length
        ? [decisionPointerPart('(subject match)', subjectDecisions, { widen: decisionRemedy, cap: SUBJECT_MAX_DECISIONS, remedy: decisionRemedy, matchLabel: 'for this subject' })]
        : [])
    );
  }
  const assembled = assembleDelivery([...leadingChromeParts, ...parts, ...trailingChromeParts], totalCap);
  return {
    text: assembled.text,
    // Guard only what the assembler says it actually emitted — never a re-scan
    // of the composed text (decision 92088a62's ONE ASSEMBLER CONTRACT).
    record: () => {
      markSubstanceDelivered(guard, assembled.emittedSubstance);
      markDiscoveryDelivered(guard, assembled.emittedDiscovery);
      writeGuard(gPath, guard);
    },
  };
}
