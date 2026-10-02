// Tool delivery: H19-style knowledge delivery built before read, edit and write
// run and appended to the tool result after.
import { isAbsolute, join, resolve } from 'node:path';
import { gitIgnored, repoRel } from '../../../scripts/hooks/lib/common.mjs';
import { isForeignTree } from '../../../scripts/hooks/lib/working-tree.mjs';
import {
  assembleDelivery,
  budgetKnownGaps,
  decisionPointerPart,
  guardPath,
  hazardParts,
  isDiscoveryDelivered,
  isOwnerDiscoveryOnly,
  isSubstanceDelivered,
  markDiscoveryDelivered,
  markSubstanceDelivered,
  ownerPointer,
  ownerSuffix,
  rankFileDecisionPointers,
  readGuard,
  recordRevision,
  renderArticle,
  renderPayload,
  renderReference,
  resolveTotalCap,
  writeGuard,
} from '../../../scripts/hooks/lib/delivery.mjs';

const DELIVERY_TOOLS = new Set(['read', 'edit', 'write']);
const PENDING_CAP = 200;

/** H19's file-touch payload for `rel`, or null when nothing is fresh. `commit()` marks it delivered and must run only after the text reached the result. */
function buildDelivery(store, root, rel, sessionID) {
  const owners = store.query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 }).filter((r) => !isForeignTree(r, root));
  const hazards = store.query({ types: ['anti_pattern'], file_keys: [rel], cap: 100 });
  const decisions = store.query({ types: ['decision'], file_keys: [rel], cap: 100 });
  const gPath = guardPath(root, undefined, sessionID);
  const guard = readGuard(gPath);
  const freshHazards = hazards.filter((r) => !isSubstanceDelivered(guard, r));
  const freshOwners = owners.filter((r) => (isOwnerDiscoveryOnly(r) ? !isDiscoveryDelivered(guard, r) : !isSubstanceDelivered(guard, r)));
  const freshDecisions = rankFileDecisionPointers(decisions.filter((r) => !isDiscoveryDelivered(guard, r)));
  const unowned = owners.length === 0 && !(gitIgnored([rel], root)?.has(rel) ?? false);
  const frontierFresh = unowned && !guard.frontier_files.includes(rel);
  if (!freshOwners.length && !freshHazards.length && !freshDecisions.length && !frontierFresh) return null;

  const gapsByOwner = budgetKnownGaps(freshOwners);
  const ownerParts = freshOwners.map((r) => {
    const text = r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r, { gaps: gapsByOwner.get(r.id), root });
    return { kind: 'ordinary', contentClass: isOwnerDiscoveryOnly(r) ? 'discovery' : 'substance', identity: r.id, revision: recordRevision(r), text, pointer: ownerPointer(text, r), suffix: ownerSuffix(r) };
  });
  const widen = `knowledge_query types:["decision"] file_keys:["${rel}"] cap:${freshDecisions.length}`;
  const decisionParts = freshDecisions.length ? [decisionPointerPart(rel, freshDecisions, { widen })] : [];
  const parts = [
    { kind: 'ordinary', contentClass: 'chrome', text: renderPayload(rel, [], { unowned, substantiveCount: freshOwners.length + freshHazards.length + freshDecisions.length }) },
    ...hazardParts(freshHazards, { fileKeys: [rel], mode: 'whole' }),
    ...ownerParts,
    ...decisionParts,
  ];
  const assembled = assembleDelivery(parts, resolveTotalCap(root));
  return {
    text: assembled.text,
    commit: () => {
      if (!gPath) return;
      markSubstanceDelivered(guard, assembled.emittedSubstance);
      markDiscoveryDelivered(guard, assembled.emittedDiscovery);
      if (frontierFresh) guard.frontier_files.push(rel);
      writeGuard(gPath, guard);
    },
  };
}

function appendToResult(result, text) {
  if (Array.isArray(result?.content)) result.content.push({ type: 'text', text });
  else if (typeof result?.content === 'string') result.content = `${result.content}\n\n${text}`;
  else throw new Error(`unrecognized tool result content shape (${typeof result?.content})`);
}

/**
 * The execute.before / execute.after handlers. `pending` holds each built
 * delivery between the two, keyed by tool call id.
 */
export function createDeliveryHandlers({ openStore, rootOf, directory, fenced }) {
  const pending = new Map();

  async function onBefore(input) {
    if (!DELIVERY_TOOLS.has(input?.tool)) return;
    const root = rootOf();
    if (!root) return;
    await fenced('delivery', root, () => {
      const raw = input.input?.path;
      if (typeof raw !== 'string' || !raw) return;
      const rel = repoRel(isAbsolute(raw) ? raw : resolve(directory(), raw), root);
      if (!rel || rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.sterling/')) return;
      const store = openStore(join(root, '.sterling', 'sterling.db'));
      try {
        const delivery = buildDelivery(store, root, rel, input.sessionID);
        if (!delivery) return;
        pending.set(input.id, delivery);
        while (pending.size > PENDING_CAP) pending.delete(pending.keys().next().value);
      } finally {
        store.close();
      }
    });
  }

  async function onAfter(input) {
    const delivery = pending.get(input?.id);
    if (!delivery) return;
    pending.delete(input.id);
    const root = rootOf();
    if (!root || input.status !== 'completed') return;
    await fenced('delivery', root, () => {
      appendToResult(input.result, delivery.text);
      delivery.commit();
    });
  }

  return { onBefore, onAfter };
}
