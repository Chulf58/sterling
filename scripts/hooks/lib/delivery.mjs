// H19 knowledge-delivery plumbing (decision fe62546f, concept family
// knowledge-delivery): guard ledger, pending queue, payload rendering.
// Transient, session-lifecycle-bound (P4): everything under
// .sterling/transient/delivery/ is cleared by h19-clear-session at SessionStart
// — the delivered-guard's TTL is the whole session by design (grill answer:
// whole session, no expiry; re-arm rides per-file/per-record keying).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function deliveryDir(cwd) {
  return join(cwd, '.sterling', 'transient', 'delivery');
}

/** Per-agent guard: which record ids / frontier files were already delivered
 *  this session. The conductor (no agent_id) and every subagent get their own
 *  file — delivery is per-context, mirroring H13's per-agent read ledgers. */
export function guardPath(cwd, agentId) {
  return join(deliveryDir(cwd), agentId ? `guard-agent-${agentId}.json` : 'guard-conductor.json');
}

/** Pending-injection queue for the 'prompt' rung: file-touch hooks enqueue,
 *  h19-delivery-drain injects at the next UserPromptSubmit (the platform-proven
 *  additionalContext surface — H2 precedent). */
export function pendingPath(cwd) {
  return join(deliveryDir(cwd), 'pending.json');
}

export function readGuard(path) {
  // Self-healing: a torn/corrupt guard resets to empty (worst case a duplicate
  // delivery) instead of disabling delivery for the rest of the session.
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { records: [], frontier_files: [] };
  } catch {
    process.stderr.write(`H19: corrupt delivery guard at ${path} — reset to empty\n`);
    return { records: [], frontier_files: [] };
  }
}

export function writeGuard(path, guard) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(guard));
}

export function enqueuePending(path, entry) {
  const entries = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  entries.push(entry);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries));
}

/** Read-and-remove: the queue is one-shot (P4 — consumed by the event that
 *  ends its life, the next prompt's drain). Self-healing: a corrupt queue is
 *  removed LOUDLY (stderr) and drains empty — one lost delivery beats a queue
 *  wedged until session restart (delivery is an aid, never a gate). */
export function drainPending(path) {
  if (!existsSync(path)) return [];
  let entries;
  try {
    entries = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    process.stderr.write(`H19: corrupt pending-delivery queue at ${path} — discarded\n`);
    rmSync(path);
    return [];
  }
  rmSync(path);
  return entries;
}

function clip(text, cap) {
  const s = String(text ?? '');
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

/** One-hop pointer line for a sibling slug: resolved from the store when the
 *  slug matches exactly, marked absent otherwise — never invented. */
function pointerLine(store, kind, slug) {
  let head = '(not in store)';
  try {
    const match = store
      .query({ types: ['feature_article'], rank_terms: [slug], cap: 5 })
      .find((r) => r.slug === slug && !r.working_tree);
    if (match) head = clip(match.what_it_does, 140);
  } catch {
    head = '(lookup failed)';
  }
  return `  → ${kind} [[${slug}]]: ${head}`;
}

/** Render the delivery payload for one owning feature_article: its substance
 *  (what_it_does, intended_behavior, current ACs) plus one-hop POINTERS —
 *  slugs with one-liners, never full neighbor bodies (grill answer: article +
 *  one-hop pointers; P6 filter-first-capped). */
export function renderArticle(store, article, charCap) {
  const lines = [
    `▸ article '${article.slug}' (${article.state}${article.concept_family ? `, concept family '${article.concept_family}'` : ''})`,
    `WHAT IT DOES: ${clip(article.what_it_does, charCap)}`,
    `INTENDED BEHAVIOR: ${clip(article.intended_behavior, charCap)}`,
  ];
  if (article.current_ac?.length) {
    lines.push(`ACCEPTANCE CRITERIA: ${article.current_ac.map((a) => `${a.ac_id}: ${a.text}`).join(' | ')}`);
  }
  const relies = article.dependencies?.relies_on ?? [];
  const relied = article.dependencies?.relied_by ?? [];
  if (relies.length || relied.length) {
    lines.push('ONE-HOP (follow with knowledge_get/knowledge_query when it matters):');
    for (const slug of relies) lines.push(pointerLine(store, 'relies_on', slug));
    for (const slug of relied) lines.push(pointerLine(store, 'relied_by', slug));
  }
  return lines.join('\n');
}

/** Pointer-only line for a repo-located reference doc owner — its presence
 *  means the territory is OWNED (no frontier signal), but docs carry no
 *  article substance to render. */
export function renderReference(ref) {
  return `▸ reference '${ref.title}' (${ref.location}): ${clip(ref.summary ?? '', 200)} — refresh via knowledge_get ${ref.id}`;
}

export function renderPayload(rel, blocks) {
  return [
    `STERLING KNOWLEDGE DELIVERY (H19) — owning knowledge for '${rel}'. Consult before designing or editing in this territory; the store is current reality AND rationale, the code is only the implementation.`,
    ...blocks,
  ].join('\n\n');
}

export function renderFrontier(rel) {
  return (
    `STERLING FRONTIER SIGNAL (H19): territory '${rel}' is UNOWNED — no owning article exists in the store. ` +
    `There is no knowledge to deliver; H10 will demand the owning article at session end if this work lands here. ` +
    `Query adjacent knowledge (knowledge_query) before designing in unmapped territory.`
  );
}
