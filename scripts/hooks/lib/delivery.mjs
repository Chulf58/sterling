// H19 knowledge-delivery plumbing (decision 6dfbe675, concept family
// knowledge-delivery): guard ledger, pending queue, payload rendering.
// Transient, session-lifecycle-bound (P4): everything under
// .sterling/transient/delivery/ is cleared by h19-clear-session at SessionStart
// — the delivered-guard's TTL is the whole session by design (grill answer:
// whole session, no expiry; re-arm rides per-file/per-record keying).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function deliveryDir(cwd) {
  return join(cwd, '.sterling', 'transient', 'delivery');
}

// ---------------------------------------------------------------------------
// MECHANISM-AXIS MATCHING (H20, board 62806222; relevance slices 2-4). The
// matcher/extractor CORE moved to @sterling/store (packages/store/src/axis.ts)
// so the MCP server's knowledge_preflight and the hooks import ONE definition
// (the f5638a84 one-mechanism constraint). Re-exported here so every hook
// consumer keeps its import path; esbuild resolves the workspace import at
// bundle time exactly as h20's MAX_RANK_TERMS import always has — the old
// "stays free of workspace imports" note predates that proof.
// ---------------------------------------------------------------------------
export {
  AXIS_MIN_TERM_LEN,
  AXIS_MIN_HITS,
  extractAxisTerms,
  axisNarrowText,
  axisHits,
  GENERIC_DEV_TERMS,
  hasDiscriminatingHit,
  AXIS_RECORD_TOP_K,
  AXIS_MIN_RECORD_TERMS,
  recordCentralityHits,
  hasRecordCentralityHit,
} from '@sterling/store';
// Also bound locally (not just re-exported) so this file's OWN deny-once
// constants below can be defined in terms of it.
import { AXIS_RECORD_TOP_K as _AXIS_RECORD_TOP_K } from '@sterling/store';

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
  return { records: [], frontier_files: [], pointer_files: [], slugs: [] };
}

/** The lineage key for a record: its slug when it has one (feature_article,
 *  reference_material — stable across a knowledge_update supersede, which
 *  mints a NEW id for the SAME slug), else its id (decision/anti_pattern have
 *  no slug, so id-churn IS lineage-churn for them — a genuinely different
 *  record, not a reconcile of the same one). */
export function lineageKey(record) {
  return record?.slug ?? record?.id;
}

/** Delivered if EITHER the exact id was guarded (today's behavior, still
 *  correct for slug-less types) OR the record's lineage was already delivered
 *  under a since-superseded id (board 5a807e68 — an edited record must not
 *  re-deliver as "fresh"). */
export function isDelivered(guard, record) {
  return guard.records.includes(record.id) || guard.slugs.includes(lineageKey(record));
}

/** Mark a batch of records delivered: both the exact id (today's key, kept for
 *  slug-less types and as a fast id-based check) and the lineage key (so a
 *  later supersede of the same slug is recognised as already-seen), each
 *  deduped against what is already guarded. */
export function markDelivered(guard, records) {
  for (const r of records) {
    if (!guard.records.includes(r.id)) guard.records.push(r.id);
    const key = lineageKey(r);
    if (!guard.slugs.includes(key)) guard.slugs.push(key);
  }
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
  // tmp+rename (torn-guard prevention, board 5e3d6ff4 fixer pass): NOT locked —
  // a lost update here costs at most one duplicate pointer/guard entry, and
  // readGuard already self-heals a torn file, so the cheaper fix is enough.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(guard));
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// DENY-ONCE PRE-STEP (H20, decision 68332e4b). A first-attempt AskUserQuestion
// whose subject strongly matches a store RULING (decision/anti_pattern) is
// DENIED before it ever reaches the user — see h20-mechanism-axis.mjs for the
// orchestration. This section is only the mechanical plumbing: which record
// types count as a "ruling", the stricter floors that gate a deny (tuned
// tighter than the existing loose audit floors so the deny classifier, never
// retrieval recall, absorbs the tuning — decision amendment 4), the ledger
// that makes suppression/override STATEFUL across a retry, and the render.
//
// LEDGER, not the session delivery guard: the guard (above) answers "was this
// record already shown this session" and is irrelevant here — a denied
// question must stay denied on an identical re-ask even if the record was
// never delivered, and an overridden question must stay allowed on a further
// resubmission of the SAME still-open sub-question. Same transient directory,
// same P4 lifecycle (cleared at SessionStart), separate file so a corrupt
// ledger cannot also wipe the unrelated delivery guard.
// ---------------------------------------------------------------------------

/** Record types the deny-once floor treats as a "ruling" — decision is the
 *  measured case (recorded in the dome-farmer project's own store — that id is
 *  deliberately not cited here, where it cannot resolve), anti_pattern is included
 *  because it is equally prescriptive ("do not do X") and carries the same
 *  status/scope/supersession fields the denial must disclose. feature_article/
 *  research_finding/disconfirmed_hypothesis stay OUT: they describe or answer,
 *  they do not rule, so denying a question because it merely OVERLAPS one is
 *  not what this decision asks for. (Decision 68332e4b does not enumerate the
 *  type set explicitly — this scoping is this build's choice, flagged here.) */
export const DENY_RULING_TYPES = ['decision', 'anti_pattern'];

/** STRICT floors (deny eligibility) vs the existing LOOSE floors (AXIS_MIN_HITS
 *  / AXIS_MIN_RECORD_TERMS, unchanged, still driving the post-answer audit).
 *  Both draw from the SAME stage-1 candidate pool built with the canonical
 *  extractAxisTerms/query — amendment 4 tunes the classifier, never recall.
 *  HONEST NOTE, same caveat AXIS_MIN_HITS itself carries: chosen on the
 *  motivating case, not measured data — tune on observed deny/override rates. */
export const STRICT_MIN_HITS = 3;
/** The deny floor requires FULL coverage of the record's own top-K central
 *  terms (every one of hasRecordCentralityHit's own extracted terms present),
 *  not merely AXIS_MIN_RECORD_TERMS (>=2, the loose audit's bar). Raw distinct
 *  hit COUNT alone does not discriminate a genuinely governing ruling from a
 *  topically-adjacent one: a short decision record and a prompt built around
 *  it both tend to land in the same 5-8 hit range regardless of how
 *  thoroughly the prompt actually covers the ruling's own vocabulary — what
 *  discriminates is whether EVERY one of the record's own dominant terms is
 *  present, not just most of them. Passing AXIS_RECORD_TOP_K itself as
 *  `minTerms` composes with hasRecordCentralityHit's own degenerate-scaling
 *  (`Math.min(minTerms, central.length)`), so a terse record's smaller central
 *  set still demands FULL coverage of what it has, never a fixed count larger
 *  than the record can offer. */
export const STRICT_MIN_RECORD_TERMS = _AXIS_RECORD_TOP_K;

/** How many newly-introduced axis terms a retry must add over the FIRST
 *  denied attempt (same intent key) before its citation counts as stating an
 *  "unresolved delta" rather than a bare re-ask with an id pasted in. Set
 *  well above the ~2 incidental new words a bare citation itself contributes
 *  ("override(ing)", "decision") — a real stated delta (what is unresolved,
 *  and why) reads as substantially more new vocabulary than the citation
 *  phrasing alone, so the gap between "id pasted in" and "id + explanation"
 *  is wide enough that this floor does not need to be exact, only clearly
 *  above the citation's own incidental contribution. */
export const DELTA_MIN_NEW_TERMS = 5;

/** The text one AskUserQuestion sub-question contributes — mirrors
 *  outgoingProposalText's questions[] branch, but for exactly one entry, so
 *  per-sub-question scoring (amendment 2, form handling) can run independently
 *  of the combined multi-question blob. */
export function subQuestionText(q) {
  return [
    q?.question,
    q?.header,
    ...(Array.isArray(q?.options) ? q.options.flatMap((o) => [o?.label, o?.description]) : []),
  ]
    .filter((s) => typeof s === 'string' && s.trim())
    .join('\n');
}

export function denyLedgerPath(cwd, agentId) {
  return join(deliveryDir(cwd), agentId ? `deny-ledger-agent-${agentId}.json` : 'deny-ledger-conductor.json');
}

function emptyDenyLedger() {
  return { entries: {}, overrides: [] };
}

/** Self-healing like readGuard: a torn ledger resets to empty (worst case one
 *  re-denied question) instead of wedging the pre-step for the rest of the
 *  session. */
export function readDenyLedger(path) {
  try {
    if (!existsSync(path)) return emptyDenyLedger();
    return { ...emptyDenyLedger(), ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    process.stderr.write(`H20: corrupt deny-once ledger at ${path} — reset to empty\n`);
    return emptyDenyLedger();
  }
}

export function writeDenyLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(ledger));
  renameSync(tmp, path);
}

/** Suppression key: "normalized question intent + matched record ids", never
 *  exact text (decision 68332e4b). Keyed on the matched record ids ALONE —
 *  NOT on the prompt's own hit terms, even though those are the record's fixed
 *  vocabulary rather than raw prompt text. Tried hit-terms-in-the-key first and
 *  rejected it here: a retry's hit SET still shifts with paraphrase (a
 *  rephrased sub-question can pick up or drop a matched word — e.g. "shown"
 *  vs "displayed" — even while targeting the exact same ruling), so a key that
 *  includes the hit set can silently mint a NEW key on a legitimate retry and
 *  the override contract (which requires a PRIOR ledger entry under the SAME
 *  key) would never fire. The record ids a sub-question strongly matches are
 *  the stable signal: the same underlying question about the same ruling(s)
 *  matches the same records across a reasonable paraphrase, while a question
 *  that drifts far enough to match different records is arguably a different
 *  question anyway — so it is right for it to get its own key. */
export function denyIntentKey(recordIds) {
  return [...new Set(recordIds ?? [])].sort().join('|');
}

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `text` cites `id` — the full id, or its unambiguous 8-char prefix
 *  (the same prefix convention the id-resolution ladder already resolves
 *  through elsewhere in the store), case-insensitively, WORD-BOUNDARIED
 *  (post-commit follow-up review): a bare substring test let an 8-char prefix
 *  embedded inside a LARGER token count as a citation (e.g. a longer id or an
 *  unrelated alphanumeric string that merely happens to contain those 8
 *  characters) — the match must not be immediately preceded or followed by
 *  another alphanumeric character. */
export function idCitedIn(text, id) {
  if (!id) return false;
  const hay = String(text ?? '').toLowerCase();
  const full = String(id).toLowerCase();
  const boundaried = (needle) => new RegExp(`(?<![a-z0-9])${escapeForRegex(needle)}(?![a-z0-9])`, 'i').test(hay);
  if (boundaried(full)) return true;
  const prefix = full.split('-')[0];
  return prefix.length >= 8 && boundaried(prefix);
}

/** The denial payload: substance (not a bare sentence) for every SETTLED
 *  sub-question, naming which are settled and NAMING (not just counting) the
 *  open ones so only they need resubmission on a multi-question form
 *  (amendment 2), plus the override contract (amendment 1). `ruled` is
 *  `{index, label, decisions}[]` — `decisions` the matched ruling records
 *  themselves (status/superseded_by/scope disclosed, never just their title,
 *  so a laundered re-ask cannot hide behind a summary that dropped the
 *  ruling's status). `open` is `{index, label}[]` — the sub-questions that did
 *  NOT strongly match anything; naming them (not merely their count) is what
 *  lets the reader resubmit exactly the right slice of a form instead of
 *  re-deriving it. */
export function renderDenyOnceMessage(ruled, totalQuestions, open = []) {
  const lines = [
    'STERLING DENY-ONCE (H20, decision 68332e4b) — this question is DENIED before it reaches the user: its subject strongly matches a settled store ruling.',
    'The store already decides this; asking again spends the user\'s attention on a resolved question and risks minting a competing ruling.',
  ];
  if (totalQuestions > 1) {
    lines.push(
      `This form has ${totalQuestions} sub-question(s); ${ruled.length} of them are SETTLED by the store below — resubmit ONLY the open sub-question(s) named here:`
    );
  }
  for (const r of ruled) {
    lines.push(`— Sub-question ${r.index + 1}${r.label ? ` ("${clip(r.label, 80)}")` : ''} is SETTLED:`);
    for (const d of r.decisions) {
      const kind = d.type === 'anti_pattern' ? 'anti_pattern' : 'decision';
      const substance = d.type === 'anti_pattern' ? `${d.trigger ?? ''} — ${d.right_way ?? ''}` : d.statement ?? '';
      lines.push(
        `  ▸ ${kind} [${d.id}] (status: ${d.status ?? 'unknown'}${d.superseded_by ? `, superseded_by: ${d.superseded_by}` : ''}, scope: ${d.scope ?? 'unknown'}): ${clip(substance, 300)}`
      );
    }
  }
  if (totalQuestions > 1) {
    if (open.length) {
      lines.push('— OPEN (resubmit only these):');
      for (const o of open) {
        lines.push(`  ▸ Sub-question ${o.index + 1}${o.label ? ` ("${clip(o.label, 80)}")` : ''}`);
      }
    } else {
      lines.push('— OPEN (resubmit only these): none — every sub-question in this form is settled.');
    }
  }
  lines.push(
    'TO OVERRIDE: resubmit this exact sub-question citing one of the ruling ids above AND stating the UNRESOLVED DELTA — what this ask needs that the cited ruling does not already settle. A resubmission that neither cites an id nor introduces new substance beyond the first attempt is denied again; repeated overrides are logged.'
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// COOPERATING-WRITER LOCK (board 5e3d6ff4 fixer pass). hooks.json runs more
// than one PostToolUse hook per event (h19-knowledge-delivery + h23-output-
// axis on Read; h19-bash-delivery + h23-output-axis on Bash), and every one of
// them can call enqueuePending against the SAME pending.json in the SAME
// event. Measured precedent for what an unguarded read-modify-write does under
// that: ledger.mjs:27-34 — two concurrent PostToolUse:Read processes tore a
// JSON file on a DrvFs mount. A torn pending.json is worse than a torn ledger:
// drainPending's JSON.parse failure rmSyncs the WHOLE queue while the
// producers' guards already marked their records delivered — permanent silent
// loss, not "ask for a re-Read".
//
// mkdirSync is atomic (EEXIST on contention) on every platform Node supports,
// so it doubles as a lock with no extra dependency. Age-based staleness ONLY —
// a lock whose mtime is older than LOCK_STALE_MS is reclaimed as abandoned by
// a crashed holder; never PID-liveness (anti_pattern 8e603e23: a recycled PID
// gives a false lock identity). On deadline expiry this PROCEEDS WITHOUT THE
// LOCK rather than blocking the hook forever — delivery is an aid, never a
// gate, so degraded beats blocked. A caller that never acquired the lock also
// never releases it, so a slow/expired waiter can't rip an active holder's
// lock out from under it.
// ---------------------------------------------------------------------------
const LOCK_DEADLINE_MS = 2000;
const LOCK_STALE_MS = 5000;
const LOCK_POLL_MS = 5;

function withFileLock(targetPath, fn) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue; // retake immediately — no need to sleep first
        }
      } catch {
        continue; // lock vanished between the EEXIST and the stat — retry now
      }
      // Bounded synchronous wait between attempts, never a busy CPU spin.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // best-effort release; a leftover lock self-heals via the staleness check
      }
    }
  }
}

export function enqueuePending(path, entry) {
  withFileLock(path, () => {
    const entries = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    entries.push(entry);
    // tmp+rename: a crash mid-write can never leave a torn file behind.
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(entries));
    renameSync(tmp, path);
  });
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

/** Budget for the untestable_because reason clip, same class as
 *  DECISION_REJECTED_CLIP: a beneath-the-headline annotation, not the primary
 *  field — an unbounded reason would land uncapped in H19's injected payload
 *  (S4b fixer pass). */
export const UNTESTABLE_REASON_CLIP = 140;

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
    lines.push(
      `ACCEPTANCE CRITERIA: ${article.current_ac
        .map((a) => {
          const u = a.untestable_because;
          const suffix = u
            ? ` [untestable: ${clip(u.reason, UNTESTABLE_REASON_CLIP)} — blocking ${String(u.blocking_record_id).slice(0, 8)}]`
            : '';
          return `${a.ac_id}: ${a.text}${suffix}`;
        })
        .join(' | ')}`
    );
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

/** How many hazard blocks render before the rest are disclosed as dropped.
 *  ONE definition (invariant 1) — H20's dispatch ceiling reuses it. Added
 *  2026-08-09 (board a470046d slice 1): ca23c811's no-cap clause was premised on
 *  measured volume ('0-1 per file'); a hub file then delivered ~25 records for a
 *  one-block edit, falsifying the premise — capping now HONORS the ruling's own
 *  anti-flood reasoning (P1/P6). Distinct from payload_char_cap, which clips per
 *  FIELD and bounds no payload. */
export const HAZARD_CAP = 3;

/** The severity-sorted survivors the cap keeps — exported so callers guard
 *  exactly what RENDERED (AC8): a hazard capped out of a payload is never marked
 *  delivered, so it surfaces on a later touch instead of being lost silently. */
export function cappedHazards(hazards, cap = HAZARD_CAP) {
  return [...hazards]
    .sort((a, b) => (HAZARD_RANK[a.severity ?? 'warn'] ?? 1) - (HAZARD_RANK[b.severity ?? 'warn'] ?? 1))
    .slice(0, cap);
}

/** Hazard blocks for the anti_patterns whose file_keys name this path, most
 *  severe first, capped at HAZARD_CAP with the overflow STATED (never silent —
 *  a silent cap reads as 'that is all there is', the same failure the decision
 *  pointer cap discloses against). The cap applies AFTER the severity sort, so
 *  the dropped hazards are always the least severe.
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
export function renderHazards(hazards, charCap, { cap = HAZARD_CAP, fileKeys = [], remedy } = {}) {
  const shown = cappedHazards(hazards, cap);
  const blocks = shown.map((ap) =>
    [
      `⚠ ANTI-PATTERN [${(ap.severity ?? 'warn').toUpperCase()}] for this path — '${ap.title}'${ap.slug ? ` [${ap.slug}]` : ''} (full record: knowledge_get ${ap.id})`,
      `TRIGGER: ${clip(ap.trigger, charCap)}`,
      `RIGHT WAY: ${clip(ap.right_way, charCap)}`,
    ].join('\n')
  );
  if (hazards.length > shown.length) {
    // `remedy` overrides the widening query for callers whose match was not a
    // file_keys join (the subject channel has no file answer at all — a
    // file_keys:[] query would be unrunnable; review finding 4, 2026-08-10).
    const keys = fileKeys.map((k) => `"${k}"`).join(',');
    const widen = remedy ?? `knowledge_query types:["anti_pattern"] file_keys:[${keys}] cap:${hazards.length}`;
    blocks.push(`… ${hazards.length - shown.length} more hazard(s) NOT shown (cap ${cap}) — ${widen} for the full set`);
  }
  return blocks;
}

/** How many feature_article pointers render per dispatch (H20 subject-axis
 *  delivery, board 62806222 follow-up / consuming-project retro
 *  2026-08-17-2111). Tighter than DECISION_POINTER_CAP: a pointer is the
 *  cheapest unit this mechanism renders (one line, no body at all — see
 *  renderArticlePointers below), but the dispatch payload as a whole must
 *  still stay small (P1), so the cap is deliberately small and the overflow
 *  is DISCLOSED rather than silently dropped, matching renderHazards/
 *  renderDecisionPointers' own cap-and-disclose shape. */
export const ARTICLE_POINTER_CAP = 3;

/** feature_articles matching a dispatch's SUBJECT, as POINTER lines ONLY —
 *  slug, title, and a knowledge_get reference to the full record. NEVER the
 *  article's what_it_does/intended_behavior prose: unlike renderArticle
 *  (file-touch delivery, where the article IS the owning knowledge for a
 *  path the reader is about to edit), a subject match here is weaker
 *  evidence of relevance — the same reasoning that keeps decisions and
 *  hazards capped tighter on this channel than on H19's file-touch channel
 *  (see the MAX_DECISIONS comment in h20-mechanism-axis.mjs). The reader
 *  decides whether to spend a knowledge_get, not have the body pushed at
 *  them. */
export function renderArticlePointers(articles, cap = ARTICLE_POINTER_CAP, { remedy } = {}) {
  const shown = articles.slice(0, cap);
  const lines = [
    `▸ ARTICLES matching this prompt's SUBJECT (${articles.length}) — pointers only, follow knowledge_get before assuming the answer:`,
  ];
  for (const a of shown) {
    lines.push(`  → '${a.slug}': ${clip(a.title, 140)} (knowledge_get ${a.id})`);
  }
  if (articles.length > shown.length) {
    const widen = remedy ?? `knowledge_query types:["feature_article"] cap:${articles.length}`;
    lines.push(`  … ${articles.length - shown.length} more matched but NOT shown (cap ${cap}) — ${widen} for the full set`);
  }
  return lines.join('\n');
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
export function renderDecisionPointers(rel, decisions, cap = DECISION_POINTER_CAP, { remedy } = {}) {
  const shown = decisions.slice(0, cap);
  const lines = [
    `▸ DECISIONS for this path (${decisions.length}) — why it is this way and what was rejected. Pointers only; follow one before contradicting it:`,
  ];
  for (const d of shown) {
    const authorityMarker = d.authority ? `[${d.authority}] ` : '';
    lines.push(`  → ${authorityMarker}${clip(d.statement, DECISION_STATEMENT_CLIP)}${d.slug ? ` [${d.slug}]` : ''} (knowledge_get ${d.id})`);
    const rejected = (Array.isArray(d.alternatives_rejected) ? d.alternatives_rejected : [])
      .map((a) => (typeof a?.option === 'string' ? a.option.trim() : ''))
      .filter(Boolean)
      .join('; ');
    if (rejected) lines.push(`    ✗ ALREADY REJECTED: ${clip(rejected, DECISION_REJECTED_CLIP)}`);
  }
  if (decisions.length > shown.length) {
    // Same remedy override as renderHazards: a subject match has no file_keys
    // answer, so the widening query must come from the caller there.
    const widen = remedy ?? `knowledge_query types:["decision"] file_keys:["${rel}"] cap:${decisions.length}`;
    lines.push(`  … ${decisions.length - shown.length} more NOT shown (cap ${cap}) — ${widen} for the full set`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// LINE-SUSPECT ADVISORY (board 04ccecb1-a338-4b4e-91f0-c99588c1cdce). Warn-only
// (P1 advisory): this renderer only ever ADDS a trailing block to the payload,
// never changes what else renders or the hook's exit code. The SCAN (regex
// match against `rel`'s `<rel>:digits[-digits]` tokens, plus the record's
// updated_at vs the file's current mtime) lives at the hook's own assembly
// seam, beside freshOwners/freshHazards/freshDecisions — this is only the
// renderer, matching renderHazards/renderDecisionPointers' own shape.
// ---------------------------------------------------------------------------

/** How the payload already names a record's type: slug for an owning article
 *  or reference doc, title for a hazard anti_pattern, id for a decision
 *  (decisions carry no slug at all — renderDecisionPointers only ever shows
 *  one when a record happens to have it). Mirrors each render* function's own
 *  naming rather than inventing a new one for this block. */
function suspectLabel(record) {
  if (record.type === 'anti_pattern') return `anti-pattern '${record.title}'`;
  if (record.type === 'decision') return `decision ${record.id}`;
  if (record.slug) return `article '${record.slug}'`;
  return record.title ?? record.id;
}

/** One trailing block naming every stale-citing record and the token(s) it
 *  cites. `suspects` is `{record, tokens}[]`, already filtered to the stale
 *  ones by the caller's scan — this only renders what it is handed. Returns
 *  `[]` (no block at all) when nothing is suspect, matching the other
 *  render* helpers' empty-array-means-nothing-to-add convention. */
export function renderLineSuspects(suspects, charCap) {
  if (!suspects?.length) return [];
  const lines = [
    "⚠ LINE-SUSPECT (H19 advisory) — cited line position(s) below may have rotted: the citing record predates this file's current version.",
  ];
  for (const { record, tokens } of suspects) {
    lines.push(`  → ${suspectLabel(record)} cites ${clip(tokens.join(', '), charCap)} — this position may no longer be accurate.`);
  }
  lines.push('  Line numbers rot as a file changes — cite an anchor (function/slug/passage) instead where possible.');
  return [lines.join('\n')];
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
      const hazardLabel = h.title && h.slug ? `${h.title} [${h.slug}]` : (h.title ?? h.slug ?? h.id);
      lines.push(`  • ${e.rel} — ⚠ HAZARD anti_pattern '${hazardLabel}' · knowledge_get ${h.id}`);
    }
    for (const o of e.owners) {
      const kind = o.type === 'reference_material' ? 'reference' : 'article';
      const label = o.title && o.slug ? `${o.title} [${o.slug}]` : (o.slug ?? o.title ?? o.id);
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
