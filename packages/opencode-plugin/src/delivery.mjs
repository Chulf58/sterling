// Tool delivery: H19-style knowledge delivery built before a tool runs and
// appended to its result after. read, edit and write get the file-touch
// delivery for their `path`; patch gets it for every file its patchText names;
// shell gets H19's Bash pointers for the paths its command names
// (extractCommandPathCandidates, the same extraction h19-bash-delivery.mjs runs).
// Tool names and argument shapes measured on OpenCode 2.0.21: shell {command},
// patch {patchText} in the '*** Begin Patch' format, with paths relative to the
// session directory.
import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { gitIgnored, repoRel } from '../../../scripts/hooks/lib/common.mjs';
import { isForeignTree } from '../../../scripts/hooks/lib/working-tree.mjs';
import {
  BASH_POINTER_PATH_CAP,
  assembleDelivery,
  bashPointerBlock,
  budgetKnownGaps,
  decisionPointerPart,
  extractCommandPathCandidates,
  guardPath,
  hazardParts,
  isDiscoveryDelivered,
  isGapDelivered,
  isKnownDelivered,
  isOwnerDiscoveryOnly,
  isSubstanceDelivered,
  markDiscoveryDelivered,
  markGapDelivered,
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

const PATH_TOOLS = new Set(['read', 'edit', 'write']);
const PENDING_CAP = 200;

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

/** The files a patch tool call touches, in order and deduped: every Add, Update, Delete and Move-to header. */
export function patchPaths(patchText) {
  const out = [];
  for (const m of String(patchText ?? '').matchAll(PATCH_HEADER)) {
    const p = m[1].trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Repo-relative path for a tool argument, or null when it is outside the repo or Sterling/git machinery. */
function governedRel(raw, root, directory) {
  if (typeof raw !== 'string' || !raw) return null;
  const rel = repoRel(isAbsolute(raw) ? raw : resolve(directory, raw), root);
  if (!rel || rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.sterling/')) return null;
  return rel;
}

/**
 * H19's file-touch payload for `rel`, or null when nothing is fresh. `commit()`
 * marks it delivered and must run only after the text reached the result.
 * `mark()` applies the same marks to `guard` in memory without writing it, so a
 * multi-file build can share one guard (buildPatchDelivery).
 */
function buildDelivery(store, root, rel, sessionID, guard = readGuard(guardPath(root, undefined, sessionID))) {
  const owners = store.query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 }).filter((r) => !isForeignTree(r, root));
  const hazards = store.query({ types: ['anti_pattern'], file_keys: [rel], cap: 100 });
  const decisions = store.query({ types: ['decision'], file_keys: [rel], cap: 100 });
  const gPath = guardPath(root, undefined, sessionID);
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
  const mark = () => {
    markSubstanceDelivered(guard, assembled.emittedSubstance);
    markDiscoveryDelivered(guard, assembled.emittedDiscovery);
    if (frontierFresh) guard.frontier_files.push(rel);
  };
  return {
    text: assembled.text,
    mark,
    commit: () => {
      if (!gPath) return;
      mark();
      writeGuard(gPath, guard);
    },
  };
}

/**
 * H19's Bash pointer delivery for a shell command: owners and hazards of the
 * existing repo files the command names, each path pointed at once per
 * session. Mirrors scripts/hooks/h19-bash-delivery.mjs with the hazard lane in
 * 'whole' mode, as the file-touch delivery above uses.
 */
function buildShellDelivery(store, root, command, directory, sessionID) {
  const gPath = guardPath(root, undefined, sessionID);
  const guard = readGuard(gPath);
  const entries = [];
  for (const candidate of extractCommandPathCandidates(command)) {
    if (entries.length >= BASH_POINTER_PATH_CAP) break;
    if (candidate.length > 255 || candidate.includes('\n')) continue;
    const rel = governedRel(candidate, root, directory);
    if (!rel || guard.pointer_files.includes(rel) || entries.some((e) => e.rel === rel)) continue;
    let isFile;
    try {
      isFile = statSync(join(root, rel)).isFile();
    } catch (e) {
      if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR' || e?.code === 'ENAMETOOLONG') continue;
      throw e;
    }
    if (!isFile) continue;
    const owners = store.query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 }).filter((r) => !isForeignTree(r, root));
    const hazards = store.query({ types: ['anti_pattern'], file_keys: [rel], cap: 100 });
    if (owners.length || hazards.length) entries.push({ rel, owners, hazards });
  }
  if (!entries.length) return null;

  const gapOwners = [...new Map(entries.flatMap((e) => e.owners).filter((o) => Array.isArray(o.known_gaps) && o.known_gaps.length && !isGapDelivered(guard, o)).map((o) => [o.id, o])).values()];
  const gapsByOwner = budgetKnownGaps(gapOwners);
  const alreadyDelivered = (r) => (r.type === 'anti_pattern' ? isSubstanceDelivered(guard, r) : isKnownDelivered(guard, r));
  const ownerById = new Map(entries.flatMap((e) => e.owners).map((o) => [o.id, o]));
  const hazardById = new Map(entries.flatMap((e) => e.hazards).map((h) => [h.id, h]));
  const seen = new Set();
  const ownerParts = [];
  for (const l of bashPointerBlock(entries, { gapsByOwner, includeHazardLines: false }).lines) {
    if (!l?.id || seen.has(l.id)) continue;
    seen.add(l.id);
    const rec = ownerById.get(l.id);
    if (!rec || alreadyDelivered(rec)) continue;
    ownerParts.push({ kind: 'ordinary', contentClass: 'discovery', identity: rec.id, revision: recordRevision(rec), text: [l.line, ...(l.gapLines ?? [])].join('\n'), pointer: l.line });
  }
  const hzParts = hazardParts([...hazardById.values()].filter((h) => !alreadyDelivered(h)), { fileKeys: entries.map((e) => e.rel), mode: 'whole' });
  if (!ownerParts.length && !hzParts.length) return null;

  const totalCap = resolveTotalCap(root);
  const headerPart = { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: bashPointerBlock([]).header };
  const assembled = assembleDelivery([headerPart, ...hzParts, ...ownerParts], totalCap, {
    aggregateLabel: (n) => `  (+${n} more pointer line(s) held back by the ${totalCap}-byte delivery cap — knowledge_query the command's governed paths)`,
  });
  const shownIds = new Set([...assembled.emittedSubstance, ...assembled.emittedDiscovery].map((e) => e.identity));
  const deliveredGapOwners = gapOwners.filter((o) => shownIds.has(o.id) && (gapsByOwner.get(o.id)?.shown?.length ?? 0) > 0);
  const emittedPaths = entries
    .filter((e) => {
      const eligible = [...e.owners, ...e.hazards].filter((r) => !alreadyDelivered(r));
      return eligible.length && eligible.every((r) => shownIds.has(r.id));
    })
    .map((e) => e.rel);
  return {
    text: assembled.text,
    commit: () => {
      if (!gPath) return;
      guard.pointer_files.push(...emittedPaths);
      if (deliveredGapOwners.length) markGapDelivered(guard, deliveredGapOwners);
      markSubstanceDelivered(guard, assembled.emittedSubstance);
      markDiscoveryDelivered(guard, assembled.emittedDiscovery);
      writeGuard(gPath, guard);
    },
  };
}

/**
 * One delivery for several files (a patch): each file's delivery in turn over
 * one in-memory guard, so a record owning two patched files is delivered once.
 * Nothing is written until commit().
 */
function buildPatchDelivery(store, root, rels, sessionID) {
  const gPath = guardPath(root, undefined, sessionID);
  const guard = readGuard(gPath);
  const texts = [];
  for (const rel of rels) {
    const d = buildDelivery(store, root, rel, sessionID, guard);
    if (!d) continue;
    texts.push(d.text);
    d.mark();
  }
  if (!texts.length) return null;
  return {
    text: texts.join('\n\n'),
    commit: () => {
      if (gPath) writeGuard(gPath, guard);
    },
  };
}

export function appendToResult(result, text) {
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

  /** The delivery builder for this call, or null when the tool or its arguments give nothing to deliver for. */
  function builderFor(input, root) {
    const tool = input?.tool;
    if (PATH_TOOLS.has(tool)) {
      const rel = governedRel(input.input?.path, root, directory());
      return rel && ((store) => buildDelivery(store, root, rel, input.sessionID));
    }
    if (tool === 'patch') {
      const rels = patchPaths(input.input?.patchText).map((p) => governedRel(p, root, directory())).filter(Boolean);
      return rels.length > 0 && ((store) => buildPatchDelivery(store, root, rels, input.sessionID));
    }
    if (tool === 'shell') {
      const command = input.input?.command;
      return typeof command === 'string' && command && ((store) => buildShellDelivery(store, root, command, directory(), input.sessionID));
    }
    return null;
  }

  async function onBefore(input) {
    if (!PATH_TOOLS.has(input?.tool) && input?.tool !== 'patch' && input?.tool !== 'shell') return;
    const root = rootOf();
    if (!root) return;
    await fenced('delivery', root, () => {
      const build = builderFor(input, root);
      if (!build) return;
      const store = openStore(join(root, '.sterling', 'sterling.db'));
      try {
        const delivery = build(store);
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
