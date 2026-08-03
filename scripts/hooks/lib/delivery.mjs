// H19 knowledge-delivery plumbing (decision 6dfbe675, concept family
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

// ---------------------------------------------------------------------------
// MECHANISM-AXIS MATCHING (H20, board 62806222). Path-scoped delivery is
// STRUCTURALLY blind to recurrence: an anti_pattern is filed against the file
// where the incident HAPPENED, not against every file where the mistake can
// recur, so no file-key join can ever surface it. The only thing that finds
// these is a query on the MECHANISM — and the prose rule to run one was missed
// twice in one session by the person who wrote it. This matches the outgoing
// dispatch prompt's own vocabulary against stored triggers and titles instead.
//
// TWO STAGES, because one is not enough. Stage 1 is the store's FTS: rank_terms
// genuinely NARROW (index.ts builds `... AND records_fts MATCH ?`), so zero
// hits is a real zero and the hook can stay silent. But that index spans
// rationale/right_way/guidance too (records.ts:394,400) — far too much surface
// to inject from. Stage 2 (axisHits) re-checks against the NARROW fields only,
// which is what the board item actually asked for: triggers and titles.
// ---------------------------------------------------------------------------

/** Ordinary function words PLUS the boilerplate that appears in essentially
 *  every Sterling dispatch prompt. The second group is the load-bearing half: a
 *  term present in EVERY prompt cannot discriminate BETWEEN prompts, so keeping
 *  it guarantees false positives (every anti_pattern mentions 'record'). */
const AXIS_STOPWORDS = new Set([
  // function words
  'this', 'that', 'these', 'those', 'with', 'from', 'have', 'has', 'had', 'will', 'would', 'could',
  'should', 'must', 'your', 'you', 'into', 'then', 'than', 'when', 'what', 'which', 'there', 'their',
  'them', 'they', 'been', 'being', 'does', 'make', 'made', 'used', 'using', 'also', 'only', 'each',
  'more', 'most', 'some', 'such', 'very', 'just', 'like', 'over', 'after', 'before', 'because',
  'about', 'under', 'above', 'below', 'where', 'while', 'since', 'until', 'unless', 'either',
  'neither', 'both', 'every', 'not', 'but', 'and', 'the', 'for', 'are', 'was', 'were', 'its',
  'here', 'how', 'why', 'who', 'whom', 'whose', 'any', 'all', 'can', 'may', 'might', 'shall',
  // Sterling dispatch boilerplate — present in ~every prompt, so pure noise
  'sterling', 'conductor', 'agent', 'agents', 'subagent', 'dispatch', 'report', 'return',
  'verify', 'verified', 'evidence', 'record', 'records', 'store', 'knowledge', 'query',
  'knowledge_get', 'knowledge_query', 'read', 'reads', 'grep', 'file', 'files', 'code',
  'first', 'second', 'third', 'task', 'work', 'please', 'note', 'notes', 'deliverable',
  'claim', 'claims', 'absence', 'cite', 'cites', 'citing', 'exactly', 'nothing', 'else',
]);

/** The OUTGOING text H20 scans, PER SURFACE — the two do not share an input
 *  shape, and assuming they do yields a hook that silently never fires.
 *  Task/Agent puts the whole brief in tool_input.prompt; AskUserQuestion has NO
 *  prompt field at all, only questions[{question, header, options[{label,
 *  description}]}]. Option text is included deliberately and is arguably the
 *  most important part: board 4e6eb510's incident was a MOCKUP inside an
 *  AskUserQuestion option which the user then picked, nearly overturning a
 *  ruling whose own alternatives_rejected already contained that exact
 *  proposal. Returns '' for any other tool, so an unrecognised surface is
 *  INERT rather than half-scanned. */
export function outgoingProposalText(toolInput) {
  const ti = toolInput ?? {};
  if (typeof ti.prompt === 'string' && ti.prompt.trim()) return ti.prompt;
  if (Array.isArray(ti.questions)) {
    return ti.questions
      .flatMap((q) => [
        q?.question,
        q?.header,
        ...(Array.isArray(q?.options) ? q.options.flatMap((o) => [o?.label, o?.description]) : []),
      ])
      .filter((s) => typeof s === 'string' && s.trim())
      .join('\n');
  }
  return '';
}

/** A term shorter than this is too generic to carry a mechanism. */
export const AXIS_MIN_TERM_LEN = 4;

/** How many DISTINCT extracted terms must land in a record's narrow fields
 *  before it is worth injecting. One shared word is coincidence; two is signal.
 *  HONEST NOTE: 2 is a starting threshold chosen on the two motivating cases
 *  (see the hook header), NOT on measured data — tune it on hit rates, the way
 *  board 8390f8fa says size thresholds should be set. */
export const AXIS_MIN_HITS = 2;

/** Extract candidate mechanism terms from outgoing prompt text, most
 *  discriminating first. Ranked by TERM FREQUENCY: a dispatch prompt repeats
 *  what it is ABOUT, so a term used three times beats a one-off mention. Ties
 *  break by length (longer is more specific) then lexicographically, so the
 *  result is fully deterministic for a given prompt — the same prompt must
 *  always produce the same query.
 *
 *  `maxTerms` is supplied by the CALLER rather than hardcoded here: the real
 *  ceiling is the store's MAX_RANK_TERMS, and writing 16 in a second place is
 *  the exact drift decision b47889b7 removed. This module also stays free of
 *  workspace imports on purpose (it is bundled into several hooks). */
export function extractAxisTerms(text, maxTerms) {
  const counts = new Map();
  for (const raw of String(text ?? '').toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < AXIS_MIN_TERM_LEN) continue;
    if (AXIS_STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue; // bare numbers carry no mechanism
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.max(0, maxTerms))
    .map(([term]) => term);
}

/** The NARROW fields a mechanism match is allowed to consider — deliberately
 *  not the whole FTS surface. An anti_pattern's trigger is its statement of WHEN
 *  it recurs, which is precisely the axis; a decision's title and statement are
 *  its ruling. rationale/right_way/guidance are excluded: they are long, they
 *  discuss context rather than assert the rule, and matching them is what would
 *  turn this into noise. */
export function axisNarrowText(record) {
  if (!record || typeof record !== 'object') return '';
  if (record.type === 'anti_pattern') return `${record.title ?? ''}\n${record.trigger ?? ''}`;
  if (record.type === 'decision') return `${record.title ?? ''}\n${record.statement ?? ''}`;
  return '';
}

/** How many DISTINCT terms appear in the record's narrow fields. Substring
 *  match on a word-ish boundary so 'latch' hits 'latches' and 'one-way-latch'
 *  but not an unrelated token that merely contains the letters. */
export function axisHits(record, terms) {
  const hay = axisNarrowText(record).toLowerCase();
  if (!hay) return [];
  return terms.filter((t) => new RegExp(`(^|[^a-z0-9_])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(hay));
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

/** The guard's declared shape. `pointer_files` is a SEPARATE namespace from
 *  `records` on purpose: a Bash pointer must never consume the record's
 *  full-article guard entry, or pointing at a path would silently suppress the
 *  real delivery on a later Read of it — a pointer would then COST knowledge
 *  instead of adding it. Pointers dedupe per FILE; articles dedupe per RECORD. */
function emptyGuard() {
  return { records: [], frontier_files: [], pointer_files: [] };
}

export function readGuard(path) {
  // Self-healing: a torn/corrupt guard resets to empty (worst case a duplicate
  // delivery) instead of disabling delivery for the rest of the session.
  try {
    if (!existsSync(path)) return emptyGuard();
    // Tolerate a guard written before a field existed (mid-session upgrade):
    // a missing array must read as empty, never as undefined.
    return { ...emptyGuard(), ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    process.stderr.write(`H19: corrupt delivery guard at ${path} — reset to empty\n`);
    return emptyGuard();
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
 *  slug matches exactly, marked absent otherwise — never invented.
 *
 *  Resolution is a DETERMINISTIC store lookup, not a ranked query (decision
 *  3db7095f). It used to be query({rank_terms:[slug], cap:5}) plus an exact match
 *  among those five, which printed '(not in store)' for articles that were
 *  demonstrably live: bm25 ranks by term frequency, so a slug cited heavily in
 *  OTHER articles' prose loses its own top-5 to them (caught live against
 *  'hooks-suite' at v46). That mattered because these pointers are how a reader
 *  learns which siblings bear on the territory — a false '(not in store)' tells
 *  them the neighbour does not exist, so they neither read it nor reconcile it. */
function pointerLine(store, kind, slug) {
  let head = '(not in store)';
  try {
    const match = store.articlesBySlug(slug).find((r) => !r.working_tree);
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

// Severity ordering for hazard blocks: a 'block' hazard must not sit below an
// 'info' one just because it was written first. Absent severity reads as 'warn'
// (the schema leaves it optional, and most records omit it).
const HAZARD_RANK = { block: 0, warn: 1, info: 2 };

/** Hazard blocks for the anti_patterns whose file_keys name this path, most
 *  severe first. ALL matches render — measured before choosing the shape
 *  (2026-07-30): anti-patterns are low-volume per file, unlike decisions.
 *
 *  WHY THIS EXISTS (defect reported from a consuming project 2026-07-30,
 *  decision ca23c811): delivery's owner query was articles-only, so an
 *  anti_pattern naming the EXACT file being edited was never delivered, while
 *  H10 asked at Stop whether a hazard had been RECORDED. The two directions were
 *  asymmetric, and anti_pattern is precisely the type whose whole value is being
 *  seen BEFORE the mistake is repeated — the reporting project shipped a
 *  one-way-latch bug in territory that had a stored one-way-latch anti_pattern.
 *  Substance (trigger + right_way), not a pointer: a pointer to a hazard the
 *  reader must choose to follow reproduces the skippable step delivery deletes. */
export function renderHazards(hazards, charCap) {
  return [...hazards]
    .sort((a, b) => (HAZARD_RANK[a.severity ?? 'warn'] ?? 1) - (HAZARD_RANK[b.severity ?? 'warn'] ?? 1))
    .map((ap) =>
      [
        `⚠ ANTI-PATTERN [${(ap.severity ?? 'warn').toUpperCase()}] for this path — '${ap.title}' (full record: knowledge_get ${ap.id})`,
        `TRIGGER: ${clip(ap.trigger, charCap)}`,
        `RIGHT WAY: ${clip(ap.right_way, charCap)}`,
      ].join('\n')
    );
}

/** How many decision pointers render before the rest are disclosed as dropped. */
export const DECISION_POINTER_CAP = 8;

/** Per-pointer clip budgets (decision 6a3b1a46). The statement ORIENTS — what was
 *  decided; the rejected options STOP — what you may be about to propose. */
export const DECISION_STATEMENT_CLIP = 120;
export const DECISION_REJECTED_CLIP = 140;

/** Decisions whose file_keys name this path, as POINTER lines — never bodies.
 *  Measured before choosing this shape (2026-07-30): packages/mcp-server/src/
 *  tools.ts carries 17 matching decisions against 0 anti-patterns, so inlining
 *  decision substance would flood the payload and train the reader to skip it —
 *  the flood half of P6 is as much a failure as starvation. The cap's overflow
 *  is STATED with the query that widens it: a silent cap reads as 'that is all
 *  there is', which is the failure mode knowledge_query's own capped envelope
 *  exists to prevent.
 *
 *  SECOND LINE ADDED 2026-08-03 (decision 6a3b1a46, board 82e2969a): the header
 *  below has promised 'and what was rejected' since 2026-07-30 while the body
 *  carried only the statement clip — delivery advertising a field it does not
 *  deliver, the same defect class as the frontier notice claiming 'there is no
 *  knowledge to deliver' above a hazard block. The rejected OPTION texts render
 *  beneath the statement (not their reasons — recognising the thing you were
 *  about to propose is what stops you; the id is there for the reasoning).
 *  This stays a POINTER change, so ca23c811's substance-vs-pointer asymmetry is
 *  untouched: it ruled on rendering decision BODIES, not on which field is
 *  clipped. alternatives_rejected needs no wider read — SterlingStore.query
 *  rehydrates whole bodies (packages/store/src/index.ts:289). */
export function renderDecisionPointers(rel, decisions, cap = DECISION_POINTER_CAP) {
  const shown = decisions.slice(0, cap);
  const lines = [
    `▸ DECISIONS for this path (${decisions.length}) — why it is this way and what was rejected. Pointers only; follow one before contradicting it:`,
  ];
  for (const d of shown) {
    lines.push(`  → ${clip(d.statement, DECISION_STATEMENT_CLIP)} (knowledge_get ${d.id})`);
    const rejected = (Array.isArray(d.alternatives_rejected) ? d.alternatives_rejected : [])
      .map((a) => (typeof a?.option === 'string' ? a.option.trim() : ''))
      .filter(Boolean)
      .join('; ');
    if (rejected) lines.push(`    ✗ ALREADY REJECTED: ${clip(rejected, DECISION_REJECTED_CLIP)}`);
  }
  if (decisions.length > shown.length) {
    lines.push(
      `  … ${decisions.length - shown.length} more NOT shown (cap ${cap}) — knowledge_query types:["decision"] file_keys:["${rel}"] cap:${decisions.length} for the full set`
    );
  }
  return lines.join('\n');
}

/** The delivery envelope. `unowned` swaps the header for the frontier signal:
 *  hazards and decisions can attach to territory NO article owns, and claiming
 *  'owning knowledge for X' above them would be false. With no blocks at all the
 *  unowned payload is exactly the frontier notice — the pre-hazard behavior. */
export function renderPayload(rel, blocks, { unowned = false } = {}) {
  return [
    unowned
      ? renderFrontier(rel, { hasOtherKnowledge: blocks.length > 0 })
      : `STERLING KNOWLEDGE DELIVERY (H19) — owning knowledge for '${rel}'. Consult before designing or editing in this territory; the store is current reality AND rationale, the code is only the implementation.`,
    ...blocks,
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// BASH POINTER DELIVERY (board 841195b1). Delivery rode Edit|Write|MultiEdit
// and Read only, while the surveying that decides what to change happens
// through grep/wc/git log — so the safety net under retrieval-first had its
// hole exactly where the traffic is, and the hole is INVISIBLE: nothing tells
// you an injection did not happen. Four consuming-project reports named this
// independently; the fourth measured ~a dozen Bash investigations with zero
// deliveries.
//
// WHY A POINTER AND NOT THE ARTICLE. Measured on this machine 2026-08-03: real
// H19 payloads ran 13,010 and 17,078 bytes (payload_char_cap is applied PER
// FIELD, so one delivery has no total ceiling). A Bash-heavy pass issues far
// more calls than it does Reads — and issues them precisely to AVOID the cost
// of reading the file — so full-article delivery here could cost more context
// than the reads it exists to protect. One line per owned path is ~90% of the
// value at ~5% of the tokens, and being cheap is what lets the extractor below
// tolerate the occasional false positive instead of needing to be exact.
// ---------------------------------------------------------------------------

/** Max distinct owned paths a single command may deliver pointers for. A
 *  `git log --stat` or a wide grep can name dozens; the cap keeps one command's
 *  delivery bounded and is why precision below can stay cheap. */
export const BASH_POINTER_PATH_CAP = 8;

/** Tokens that are never a path but survive the shape tests below. */
const COMMAND_PATH_SKIP = new Set(['--', '-', '.', './', '..', '../']);

/**
 * Candidate file paths named in a shell/PowerShell command string. PURE and
 * deliberately SHAPE-ONLY: it does not touch the filesystem, so it is unit
 * testable, and the caller applies the real filter (exists + is a file +
 * governed). That split is the whole precision strategy — a search PATTERN
 * that looks like a path (`grep -rn "tools.ts" .`) is cheap to let through
 * here because it dies at the existence check, and a pattern that happens to
 * name a real file costs one pointer line, not an article.
 *
 * Globs are dropped rather than expanded: `*`/`?` cannot be resolved without
 * the filesystem, and a half-expanded glob would deliver for the wrong file.
 */
export function extractCommandPathCandidates(command) {
  const text = String(command ?? '');
  // Quote-aware split: a quoted argument is one token even with spaces in it.
  const tokens = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const out = [];
  const seen = new Set();
  for (const raw of tokens) {
    let t = raw;
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
    // Shell punctuation that clings to an argument in real commands.
    t = t.replace(/^[(<]+/, '').replace(/[),;:'"]+$/, '');
    // `path:12` / `path:12:5` — grep -n output pasted back into a command.
    t = t.replace(/:\d+(:\d+)?$/, '');
    if (!t || COMMAND_PATH_SKIP.has(t)) continue;
    if (t.startsWith('-')) continue; // a flag, or a flag=value
    if (/[*?$`!]/.test(t)) continue; // glob or shell expansion — unresolvable here
    // Must LOOK like a path: contain a separator, or carry a file extension.
    if (!(t.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(t))) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * One line per governed path: what owns it, and the id to read it with. Kept to
 * a single line per record on purpose — this is a signpost telling the reader
 * an article EXISTS, not a substitute for reading it. Hazards lead each path's
 * list for the same reason they lead renderArticle's payload: "do not do this
 * here" outranks "here is what this is".
 */
export function renderBashPointers(entries) {
  const lines = [
    'STERLING KNOWLEDGE POINTERS (H19) — governed paths named in a Bash command.',
    'This is a POINTER, not the article: the store owns these paths, so read the record before you design or edit here.',
  ];
  for (const e of entries) {
    for (const h of e.hazards) {
      lines.push(`  • ${e.rel} — ⚠ HAZARD anti_pattern '${h.title ?? h.slug ?? h.id}' · knowledge_get ${h.id}`);
    }
    for (const o of e.owners) {
      const kind = o.type === 'reference_material' ? 'reference' : 'article';
      const label = o.slug ?? o.title ?? o.id;
      const state = o.state ? ` (${o.state})` : '';
      lines.push(`  • ${e.rel} — ${kind} '${label}'${state} · knowledge_get ${o.id}`);
    }
  }
  return lines.join('\n');
}

/** The unowned-territory notice. `hasOtherKnowledge` is load-bearing, not
 *  cosmetic: since ca23c811 this notice is the HEADER above any hazard and
 *  decision blocks, and the old unconditional "there is no knowledge to deliver"
 *  became FALSE in exactly the case the change exists to fix — a reader who
 *  trusts that sentence stops before the BLOCK-severity hazard printed beneath
 *  it, which rebuilds the skippable step delivery deletes (correctness review
 *  2026-07-30). */
export function renderFrontier(rel, { hasOtherKnowledge = false } = {}) {
  return (
    `STERLING FRONTIER SIGNAL (H19): territory '${rel}' is UNOWNED — no owning article exists in the store. ` +
    (hasOtherKnowledge
      ? `KEEP READING: no article describes this territory, but the store DOES hold the hazards and/or decisions below for this exact path — they are all it has here. `
      : `There is no knowledge to deliver; `) +
    `H10 will demand the owning article at session end if this work lands here. ` +
    `Query adjacent knowledge (knowledge_query) before designing in unmapped territory.`
  );
}
