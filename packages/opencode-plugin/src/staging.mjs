// Child-session dispatch staging: H19's SubagentStart delivery for OpenCode
// (board cbee2b3d, audit f2ba68c2 row 24). A subagent's brief is the first user
// message of its own session, so attribution is exact by construction: no
// pending-dispatch register, no sidecar file, no guess between same-type
// siblings (decision h22-start-staging-only-when-attribution-is-unambiguous-no-sidecar).
// A child whose brief cannot be read is told its knowledge was not staged and
// to rely on its brief, the same loud degrade H19 prints.
//
// The records are the ones H19's dispatch staging delivers for a brief: the owners,
// hazards and decisions of the paths the brief names (path channel) and the
// hazards and decisions matching the brief's subject (subject channel, all three
// stage-2 floors). Both channels, the guard ledger and the assembler are
// scripts/hooks/lib/delivery.mjs; only the brief's source differs.
import { MAX_RANK_TERMS } from '@sterling/store';
import { repoRel } from '../../../scripts/hooks/lib/common.mjs';
import { extractPathCandidates } from '../../../scripts/hooks/lib/dispatch-prompt.mjs';
import { isForeignTree } from '../../../scripts/hooks/lib/working-tree.mjs';
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
  isOwnerDiscoveryOnly,
  isSubstanceDelivered,
  markDiscoveryDelivered,
  markSubstanceDelivered,
  ownerPointer,
  ownerSuffix,
  payloadHeaderLine,
  rankFileDecisionPointers,
  readGuard,
  recordCentralityHits,
  recordRevision,
  renderArticle,
  renderReference,
  resolveTotalCap,
  stripReviewTerritoryLine,
  writeGuard,
} from '../../../scripts/hooks/lib/delivery.mjs';

// Subject-channel decision ceiling, as H19's dispatch staging and H20 use it.
const SUBJECT_MAX_DECISIONS = 5;
// A brief is a prompt, not a document: bound what is scanned.
const BRIEF_SCAN_CAP = 20_000;

/** The disclosure line a child gets when its brief could not be staged from. */
export function notStagedLine(kase) {
  return `STERLING DISPATCH STAGING (H19): this session's brief could not be staged from [${kase}] — YOUR KNOWLEDGE WAS NOT STAGED: no owning articles, hazards or decisions were delivered for your task. Do not assume the store is silent on it: rely on your dispatch brief for knowledge pointers and query the store for the area before acting. File-touch delivery still fires on your first read or edit.`;
}

/** The text of the session's first user message (its brief), or '' when there is none. */
export function briefOf(messages) {
  const first = Array.isArray(messages) ? messages.find((m) => m?.role === 'user') : null;
  if (!first) return '';
  const content = first.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n') : '';
  return text.slice(0, BRIEF_SCAN_CAP);
}

/**
 * The staging payload for `brief`, or '' when nothing governs it or every
 * governing record was already delivered to this session. Marks the guard
 * ledger only after the payload is assembled, so a throw leaves the records
 * eligible for the child's own first file touch.
 */
export function stageBrief(store, root, sessionID, brief) {
  const candidates = extractPathCandidates(brief);
  const rels = [...new Set(candidates.map((c) => repoRel(c, root)).filter(Boolean))].filter((r) => r !== '.git' && !r.startsWith('.git/') && !r.startsWith('.sterling/'));

  const owners = rels.length ? store.query({ types: ['feature_article', 'reference_material'], file_keys: rels, cap: 100 }).filter((r) => !isForeignTree(r, root)) : [];
  const hazards = rels.length ? store.query({ types: ['anti_pattern'], file_keys: rels, cap: 100 }) : [];
  const decisions = rels.length ? store.query({ types: ['decision'], file_keys: rels, cap: 100 }) : [];

  // SUBJECT CHANNEL: H20's mechanism-axis match over the brief, all three floors.
  // Records the path channel already carries are excluded: one payload, one mention.
  const pathIds = new Set([...owners, ...hazards, ...decisions].map((r) => r.id));
  const subjectText = stripReviewTerritoryLine(brief);
  const terms = extractAxisTerms(subjectText, MAX_RANK_TERMS);
  const subjectMatches = [];
  if (terms.length >= AXIS_MIN_HITS) {
    const seen = new Set();
    for (const r of [...store.query({ types: ['anti_pattern'], rank_terms: terms, cap: 40 }), ...store.query({ types: ['decision'], rank_terms: terms, cap: 40 })]) {
      if (pathIds.has(r.id) || seen.has(r.id)) continue;
      const hits = axisHits(r, terms);
      if (hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(hits, AXIS_MIN_DISCRIMINATING_HITS) && hasRecordCentralityHit(r, subjectText)) {
        seen.add(r.id);
        subjectMatches.push({ record: r, hits });
      }
    }
    subjectMatches.sort((a, b) => b.hits.length - a.hits.length);
  }
  if (!owners.length && !hazards.length && !decisions.length && !subjectMatches.length) return '';

  const gPath = guardPath(root, undefined, sessionID);
  const guard = readGuard(gPath);
  const freshHazards = hazards.filter((r) => !isSubstanceDelivered(guard, r));
  const freshOwners = owners.filter((r) => (isOwnerDiscoveryOnly(r) ? !isDiscoveryDelivered(guard, r) : !isSubstanceDelivered(guard, r)));
  const freshDecisions = rankFileDecisionPointers(decisions.filter((r) => !isDiscoveryDelivered(guard, r)));
  const freshSubject = subjectMatches.filter((x) => (x.record.type === 'anti_pattern' ? !isSubstanceDelivered(guard, x.record) : !isDiscoveryDelivered(guard, x.record)));
  if (!freshOwners.length && !freshHazards.length && !freshDecisions.length && !freshSubject.length) return '';

  const subjectHazards = freshSubject.filter((x) => x.record.type === 'anti_pattern').map((x) => x.record);
  const subjectDecisions = freshSubject.filter((x) => x.record.type === 'decision').map((x) => x.record);

  // ONE HAZARD CAP PER PACKAGE: the union is ranked once and split back into the two channels.
  const packageHazards = cappedHazards([...freshHazards, ...subjectHazards]);
  const channelCap = (list) => packageHazards.filter((r) => list.includes(r)).length;
  const channelCapLabel = (cap) => (cap < HAZARD_CAP ? `cap ${HAZARD_CAP} per package, shared across the path and subject channels` : undefined);
  const pathHazardCap = channelCap(freshHazards);
  const subjectHazardCap = channelCap(subjectHazards);

  const parts = [];
  if (freshOwners.length || freshHazards.length || freshDecisions.length) {
    const widen = `knowledge_query types:["decision"] file_keys:[${rels.map((r) => `"${r}"`).join(',')}] cap:${freshDecisions.length}`;
    const ownerParts = freshOwners.map((r) => {
      const text = r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r, { root });
      return { kind: 'ordinary', contentClass: isOwnerDiscoveryOnly(r) ? 'discovery' : 'substance', identity: r.id, revision: recordRevision(r), text, pointer: ownerPointer(text, r), suffix: ownerSuffix(r) };
    });
    parts.push(
      { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: payloadHeaderLine(rels.join(', ')) },
      ...hazardParts(freshHazards, { fileKeys: rels, mode: 'whole', cap: pathHazardCap, capLabel: channelCapLabel(pathHazardCap) }),
      ...ownerParts,
      ...(freshDecisions.length ? [decisionPointerPart(rels.join(', '), freshDecisions, { widen })] : [])
    );
  }
  if (subjectHazards.length || subjectDecisions.length) {
    const matched = boundedTermClause(freshSubject.flatMap((x) => x.hits));
    const central = boundedTermClause(freshSubject.flatMap((x) => recordCentralityHits(x.record, subjectText)));
    const subjectTerms = [...new Set(freshSubject.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',');
    const remedy = `knowledge_query types:["anti_pattern"] rank_terms:[${subjectTerms}] cap:${subjectHazards.length || 1}`;
    const decisionRemedy = `knowledge_query types:["decision"] rank_terms:[${subjectTerms}] cap:${subjectDecisions.length || 1}`;
    parts.push(
      {
        text:
          `STERLING MECHANISM-AXIS STAGING (H19) — the store holds records matching your task's SUBJECT ` +
          `(matched on: ${matched}; central to the record: ${central}), beyond any file the task names. ` +
          `Path-scoped delivery cannot find these — consult them before acting on the premise they govern.`,
        kind: 'ordinary',
        pinned: true,
        contentClass: 'chrome',
      },
      ...hazardParts(subjectHazards, { remedy, matchLabel: 'for this subject', mode: 'whole', cap: subjectHazardCap, capLabel: channelCapLabel(subjectHazardCap) }),
      ...(subjectDecisions.length ? [decisionPointerPart('(subject match)', subjectDecisions, { widen: decisionRemedy, cap: SUBJECT_MAX_DECISIONS, remedy: decisionRemedy, matchLabel: 'for this subject' })] : [])
    );
  }

  const assembled = assembleDelivery(parts, resolveTotalCap(root));
  markSubstanceDelivered(guard, assembled.emittedSubstance);
  markDiscoveryDelivered(guard, assembled.emittedDiscovery);
  writeGuard(gPath, guard);
  return assembled.text;
}
