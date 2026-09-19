// H19 knowledge-delivery plumbing (decision 6dfbe675, concept family
// knowledge-delivery): guard ledger, notice state, payload rendering.
// Transient, session-lifecycle-bound (P4): everything under
// .sterling/transient/delivery/ is cleared by h19-clear-session at SessionStart
// — the delivered-guard's TTL is the whole session by design (grill answer:
// whole session, no expiry; re-arm rides per-file/per-record keying).
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConfig } from './common.mjs';

export function deliveryDir(cwd) {
  return join(cwd, '.sterling', 'transient', 'delivery');
}

/** H10 notices are independent immutable files: producers never share RMW
 * state, and a prompt deletes only files it actually emitted. */
export function noticesDir(cwd) {
  return join(cwd, '.sterling', 'transient', 'notices');
}

/** Claim the Step 2 compatibility notice exactly once per session.  The marker
 * is created exclusively, so concurrent hook processes have one winner. */
export function claimLegacyInjectionRungNotice(cwd, rawRung) {
  if (rawRung === 'read') return null;
  const transient = join(cwd, '.sterling', 'transient');
  const marker = join(transient, 'legacy-injection-rung-noticed');
  mkdirSync(transient, { recursive: true });
  try {
    const fd = openSync(marker, 'wx');
    closeSync(fd);
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
  const configured = rawRung == null ? 'missing' : `'${rawRung}'`;
  return `ⓘ STERLING: delivery.injection_rung ${configured} is obsolete and now behaves as 'read'.`;
}

export function publishNotice(cwd, text) {
  const dir = noticesDir(cwd);
  mkdirSync(dir, { recursive: true });
  const name = `h10-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  const target = join(dir, name);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify({ text: String(text) }), { flag: 'wx' });
  renameSync(tmp, target);
  return target;
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
  extractAxisTermsUncapped,
  axisNarrowText,
  axisHits,
  GENERIC_DEV_TERMS,
  hasDiscriminatingHit,
  AXIS_MIN_DISCRIMINATING_HITS,
  AXIS_RECORD_TOP_K,
  AXIS_MIN_RECORD_TERMS,
  recordCentralityHits,
  hasRecordCentralityHit,
  hasFullNarrowCentralityCoverage,
} from '@sterling/store';

/** THE CANONICAL REVIEW-TERRITORY TERMINAL-LINE SHAPE (decision
 *  h20-specificity-rebuild-not-fourth-patch-structural-fixes-now-red-probes-frozen,
 *  fix 1). A code-touching dispatch brief carries a machine-readable
 *  `REVIEW-TERRITORY: ["path", ...]` line by convention (decision
 *  review-territory-structured-receipt-files) — a RECEIPT field, not the
 *  prompt's SUBJECT, and left in axis-term extraction it makes any record
 *  about reviewer territory fire on EVERY code-touching dispatch (measured:
 *  b60b5cc5 on probe-001). Matches ONLY the canonical terminal-line shape — a
 *  line that begins with `REVIEW-TERRITORY:` immediately followed by a JSON
 *  array, to end of line — so a PROSE mention ("the REVIEW-TERRITORY
 *  convention", or the line quoted mid-sentence with no bare array after the
 *  colon) SURVIVES untouched: stripping is structural (this exact generated
 *  field shape), never lexical (the words "review" or "territory" anywhere in
 *  the text). Rejected alternative (Codex, adopted): adding review/reviewer/
 *  territory to AXIS_STOPWORDS instead — that would globally erase legitimate
 *  reviewer-territory SUBJECTS the store genuinely rules on. */
const REVIEW_TERRITORY_LINE_RE = /^[ \t]*REVIEW-TERRITORY:[ \t]*\[[^\n]*\][ \t]*\r?$/gm;

/** Remove every REVIEW-TERRITORY terminal line from `text`, leaving everything
 *  else — including a prose mention of the convention — untouched. Pure: no
 *  I/O, no mutation of the input. */
export function stripReviewTerritoryLine(text) {
  return String(text ?? '').replace(REVIEW_TERRITORY_LINE_RE, '');
}

/** The OUTGOING text H20 scans, PER SURFACE — the two do not share an input
 *  shape, and assuming they do yields a hook that silently never fires.
 *  Task/Agent (and codex consult) puts the whole brief in tool_input.prompt;
 *  AskUserQuestion has NO prompt field at all, only questions[{question,
 *  header, options[{label, description}]}]. Option text is included
 *  deliberately and is arguably the most important part: board 4e6eb510's
 *  incident was a MOCKUP inside an AskUserQuestion option which the user then
 *  picked, nearly overturning a ruling whose own alternatives_rejected already
 *  contained that exact proposal. Returns '' for any other tool, so an
 *  unrecognised surface is INERT rather than half-scanned.
 *
 *  The `prompt` branch strips the REVIEW-TERRITORY receipt line before axis
 *  matching ever sees the text (fix 1 above) — the `questions[]` branch is
 *  deliberately NEVER stripped, because AskUserQuestion never carries that
 *  convention's line and a real "REVIEW-TERRITORY" mention typed by a human
 *  into an option/label must survive verbatim. */
export function outgoingProposalText(toolInput) {
  const ti = toolInput ?? {};
  if (typeof ti.prompt === 'string' && ti.prompt.trim()) return stripReviewTerritoryLine(ti.prompt);
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

/** The guard's declared shape. `pointer_files` is a SEPARATE namespace from
 *  `records` on purpose: a Bash pointer must never consume the record's
 *  full-article guard entry, or pointing at a path would silently suppress the
 *  real delivery on a later Read of it — a pointer would then COST knowledge
 *  instead of adding it. Pointers dedupe per FILE; articles dedupe per RECORD.
 *  `gap_articles` (board f1489964) is a THIRD, independent namespace: the
 *  bash/probe-output seam's own known_gaps re-emission dedup, keyed per
 *  ARTICLE (mirrors `slugs`' lineage keying) and deliberately separate from
 *  both `pointer_files` (would starve the pointer line itself) and
 *  `records`/`slugs` (the full-article Read-path guard — riding it would
 *  either silently suppress the bash re-emission after an unrelated Read, or
 *  vice versa; the board asks for this seam's OWN bounded dedup). */
export function emptyDeliveryGuard() {
  return { records: [], frontier_files: [], pointer_files: [], slugs: [], gap_articles: [] };
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

/** Bash/probe-output-seam known_gaps dedup (board f1489964) — its OWN bounded
 *  register, mirroring isDelivered/markDelivered's lineage-keyed mechanism but
 *  reading/writing the separate `gap_articles` namespace above. Never consult
 *  or populate `records`/`slugs` here: this seam re-emits gap substance
 *  independently of whether the article's full body was ever delivered via
 *  the Read/Edit path (the high-signal exception the board item names). */
export function isGapDelivered(guard, record) {
  return guard.gap_articles.includes(lineageKey(record));
}

export function markGapDelivered(guard, records) {
  for (const r of records) {
    const key = lineageKey(r);
    if (!guard.gap_articles.includes(key)) guard.gap_articles.push(key);
  }
}

export function readGuard(path) {
  // Self-healing: a torn/corrupt guard resets to empty (worst case a duplicate
  // delivery) instead of disabling delivery for the rest of the session.
  try {
    if (!existsSync(path)) return emptyDeliveryGuard();
    // Tolerate a guard written before a field existed (mid-session upgrade):
    // a missing array must read as empty, never as undefined.
    return { ...emptyDeliveryGuard(), ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    process.stderr.write(`H19: corrupt delivery guard at ${path} — reset to empty\n`);
    return emptyDeliveryGuard();
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
/** The deny floor's centrality bar is `hasFullNarrowCentralityCoverage`
 *  (re-exported above), NOT hasRecordCentralityHit with a raised `minTerms`.
 *  It requires FULL coverage of the record's PRE-UNION narrow top-K — every one
 *  of the record's own dominant narrow terms present — rather than merely
 *  AXIS_MIN_RECORD_TERMS (>=2, the loose audit's bar). Raw distinct hit COUNT
 *  alone does not discriminate a genuinely governing ruling from a topically-
 *  adjacent one: a short decision record and a prompt built around it both tend
 *  to land in the same 5-8 hit range regardless of how thoroughly the prompt
 *  actually covers the ruling's own vocabulary — what discriminates is whether
 *  EVERY one of the record's own dominant terms is present, not just most of
 *  them. A terse record's smaller central set still demands full coverage of
 *  what it has, never a fixed count larger than the record can offer.
 *
 *  WHY A DEDICATED FUNCTION AND NOT A CONSTANT: this file used to export
 *  STRICT_MIN_RECORD_TERMS = AXIS_RECORD_TOP_K and pass it as `minTerms`,
 *  relying on `Math.min(minTerms, central.length)` collapsing to full coverage
 *  because central.length could never exceed topK. The title union (decision
 *  00b23915) broke that invariant — the central set can now reach 2*topK, so
 *  the same call silently became "ANY six of up to twelve". This rung EXITS 2
 *  and blocks a question from reaching the user, so a weaker per-term demand is
 *  fail-CLOSED toward the user: more false denials. The constant is gone rather
 *  than corrected, so no future caller can re-derive the trick. */

/** How many newly-introduced axis terms a retry must add over the FIRST
 *  denied attempt (same intent key) before its citation counts as stating an
 *  "unresolved delta" rather than a bare re-ask with an id pasted in.
 *
 *  THE OLD JUSTIFICATION HERE WAS FALSE, AND MEASURED SO (board 98ce3925,
 *  2026-09-05, twice and independently). It read: "set well above the ~2
 *  incidental new words a bare citation itself contributes ('override(ing)',
 *  'decision')". A bare citation contributed FOUR OR FIVE terms, not two:
 *  extractAxisTerms splits on non-alphanumerics and keeps every token >= 4
 *  chars, so a v4 uuid decomposes into its hex groups and each one counts as
 *  novel vocabulary (Codex, over 1,000 random uuids: 975 yielded 4 terms, and
 *  adding just TWO nonsense tokens reached 5 in 981 cases). The floor of 5 was
 *  therefore ~1 above the citation's own contribution, not well above it, and
 *  the gate could be cleared by the mandatory citation plus filler.
 *
 *  THE NUMBER IS UNCHANGED; WHAT IT COUNTS IS NOT (decision
 *  h20-novelty-counted-over-citation-stripped-uncapped-terms). Novelty is now
 *  measured over CITATION-STRIPPED (stripCitations below) and UNCAPPED
 *  (extractAxisTermsUncapped) term sets on both sides, so a citation
 *  contributes ZERO by construction and the count is monotone in what the user
 *  actually added — which is what the printed remedy ("add >= 5 new terms")
 *  promises. 5 stays a heuristic evidence-of-explanation bar, deliberately not
 *  coupled to store vocabulary.
 *
 *  RESIDUAL, ACCEPTED AND STATED: five unique nonsense tokens of >= 4 chars
 *  still clear this floor. Extraction recognises lexical novelty, not
 *  sincerity; this is a deny-ONCE rung with a post-answer audit behind it, not
 *  a hard gate. */
export const DELTA_MIN_NEW_TERMS = 5;

/** WHICH REPRESENTATION a deny-ledger entry's `terms` are in. Version 1 is the
 *  implicit pre-2026-09-06 shape: CAPPED at MAX_RANK_TERMS and NOT
 *  citation-stripped. Version 2 is uncapped + stripped (deltaTermsFor in
 *  h20-mechanism-axis.mjs).
 *
 *  WHY IT EXISTS (Codex review, 2026-09-06): the ledger is SESSION-scoped
 *  transient state, but the hook can be upgraded WHILE a session holds entries —
 *  a first attempt denied before the upgrade leaves v1 terms that a post-upgrade
 *  re-ask would diff against v2 terms. Comparing unlike sides is exactly the
 *  defect this whole change removes, and here it would fail in the DANGEROUS
 *  direction: the v1 side carries at most 16 terms and still holds the
 *  citation's hex fragments, so a bare re-ask can show a large spurious novelty
 *  count and be waved through as an override. An entry below this version is
 *  therefore RE-SEEDED from the current attempt and its override check is
 *  skipped for that attempt — the question is denied once more, and the next
 *  re-ask is measured against a comparable side.
 *
 *  RESIDUAL, ACCEPTED AND NOT CHASED (Codex round 3, conductor-ruled): for a
 *  GENUINE v1 entry the original attempt's terms beyond the old 16-slot cap were
 *  never recorded and are unrecoverable, so the union re-seed cannot restore
 *  them and an attempt after the re-seed can reintroduce up to five of those
 *  lost words as "new". Exposure is bounded to the single session that spans a
 *  hook upgrade — the deny ledger is session-transient, cleared at SessionStart
 *  — and every entry seeded at v2 carries its full uncapped baseline, so the
 *  path is closed going forward; chasing the historical remainder would cost
 *  more machinery than the one-session window is worth. Related and likewise
 *  accepted: a HAND-FRAGMENTED citation — the 8-char prefix plus the id's
 *  remaining hex groups written loose — still satisfies idCitedIn on the prefix
 *  while the loose groups survive stripCitations (they are neither a canonical
 *  full uuid nor a known prefix), contributing roughly three terms; that is
 *  strictly weaker than, and subsumed by, the five-nonsense-tokens residual
 *  named on DELTA_MIN_NEW_TERMS above. */
export const DELTA_TERMS_VERSION = 2;

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

/** One ledger entry's REQUIRED shape. Anything else is not "an entry with an
 *  odd field" — it is a value the deny rung would dereference. */
function isWellFormedDenyEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (!Array.isArray(entry.recordIds) || !entry.recordIds.every((id) => typeof id === 'string' && id)) return false;
  if (!Array.isArray(entry.terms) || !entry.terms.every((t) => typeof t === 'string')) return false;
  if (entry.terms_version !== undefined && !Number.isFinite(entry.terms_version)) return false;
  return true;
}

/** Self-healing like readGuard: a torn ledger resets to empty (worst case one
 *  re-denied question) instead of wedging the pre-step for the rest of the
 *  session.
 *
 *  SHAPE VALIDATION, NOT ONLY PARSE VALIDATION (reviewer-security S2). The old
 *  form self-healed a JSON PARSE failure and nothing else, so a file that parsed
 *  but held a malformed ENTRY — `entries: {k: null}`, `entries` as a string,
 *  `terms` as a number — threw at the consumer's `entry.recordIds.some(...)` or
 *  `entry.terms.includes(...)`. In H20 that throw lands in the outer catch,
 *  which calls warnNonBlocking and exits 1; the runner reads any non-2 exit as
 *  NON-BLOCKING, so the question is ALLOWED. That is fail-OPEN on the one rung
 *  that blocks a user's question, reached by writing a two-character value into
 *  a file that lives in agent-writable `.sterling/transient/`. Every
 *  non-conforming entry is therefore DROPPED here — at the boundary, where the
 *  data is still inert — with a stderr disclosure naming the keys, exactly as
 *  the parse arm discloses its own reset. Dropping an entry costs at most one
 *  re-denied question (the same worst case the parse arm accepts); keeping it
 *  costs the gate. */
export function readDenyLedger(path) {
  try {
    if (!existsSync(path)) return emptyDenyLedger();
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const ledger = emptyDenyLedger();
    const rawEntries = raw?.entries;
    if (rawEntries && typeof rawEntries === 'object' && !Array.isArray(rawEntries)) {
      const dropped = [];
      for (const [key, entry] of Object.entries(rawEntries)) {
        if (isWellFormedDenyEntry(entry)) ledger.entries[key] = entry;
        else dropped.push(key);
      }
      if (dropped.length) {
        process.stderr.write(
          `H20: dropped ${dropped.length} malformed deny-once ledger entry(ies) at ${path} — ${dropped.join(', ')}\n`
        );
      }
    } else if (rawEntries !== undefined) {
      process.stderr.write(`H20: deny-once ledger at ${path} has a non-object 'entries' — treated as empty\n`);
    }
    if (Array.isArray(raw?.overrides)) ledger.overrides = raw.overrides;
    else if (raw?.overrides !== undefined) {
      process.stderr.write(`H20: deny-once ledger at ${path} has a non-array 'overrides' — treated as empty\n`);
    }
    return ledger;
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

/** THE ONE CITATION MATCHER, factored out so DETECTION (idCitedIn) and
 *  STRIPPING (stripCitations) cannot drift — a term the detector counts as a
 *  citation but the stripper leaves behind is precisely the free novelty board
 *  98ce3925 measured (decision
 *  h20-novelty-counted-over-citation-stripped-uncapped-terms, ruling 1).
 *  WORD-BOUNDARIED on ALPHANUMERICS, not \b: an 8-char prefix embedded inside a
 *  LARGER token (a longer id, or an unrelated alphanumeric string that merely
 *  contains those 8 characters) is not a citation, while a `-` or `(` beside it
 *  is an ordinary boundary. */
function citationPattern(needle) {
  return `(?<![a-z0-9])${escapeForRegex(needle)}(?![a-z0-9])`;
}

/** Whether `text` cites `id` — the full id, or its unambiguous 8-char prefix
 *  (the same prefix convention the id-resolution ladder already resolves
 *  through elsewhere in the store), case-insensitively, WORD-BOUNDARIED via the
 *  shared matcher above. */
export function idCitedIn(text, id) {
  if (!id) return false;
  const hay = String(text ?? '').toLowerCase();
  const full = String(id).toLowerCase();
  const boundaried = (needle) => new RegExp(citationPattern(needle), 'i').test(hay);
  if (boundaried(full)) return true;
  const prefix = full.split('-')[0];
  return prefix.length >= 8 && boundaried(prefix);
}

/** A CANONICAL full uuid, 8-4-4-4-12 hex, under the same alphanumeric boundary
 *  rule as citationPattern. Deliberately the canonical SHAPE and nothing looser:
 *  stripping any 8-hex token generically was rejected because it would eat real
 *  words like "deadbeef" out of the novelty count. */
const FULL_UUID_PATTERN = '(?<![a-z0-9])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![a-z0-9])';

/** THE CITATION BOILERPLATE — a small EXPLICIT list, never a broad regex, and
 *  stripped ONLY where it sits immediately beside a removed id (separated by
 *  nothing but whitespace or the punctuation below). These are the words H20's
 *  own override contract instructs a user to write around the id ("Cite <id> +
 *  the unresolved delta"), so they are supplied by the MECHANISM and cannot be
 *  evidence that the user explained anything. Most of what a citation says is
 *  already inert — 'per'/'id' are under AXIS_MIN_TERM_LEN, 'cite'/'citing'/
 *  'knowledge_get' are AXIS_STOPWORDS — so this list is the short remainder
 *  that would otherwise count as novel vocabulary. Anything NOT on it survives:
 *  a word next to an id is stripped because it is boilerplate, never because it
 *  is next to an id. */
const CITATION_BOILERPLATE_WORDS = [
  'knowledge_get',
  'anti_pattern',
  'decisions',
  'decision',
  'rulings',
  'ruling',
  'overriding',
  'overrides',
  'override',
  'ids',
  'id',
];

/** Separators allowed BETWEEN a boilerplate word and the id it decorates —
 *  whitespace and the punctuation that ordinarily wraps a citation. */
const CITATION_SEP = '[\\s(),.:;\\[\\]]*';
const CITATION_BOILERPLATE_RUN = `(?:\\b(?:${CITATION_BOILERPLATE_WORDS.join('|')})\\b${CITATION_SEP})*`;

/** One id-shaped needle plus any adjacent boilerplate run on either side. The
 *  needle is MANDATORY in the middle, so this can never match (and erase) a
 *  bare "decision" that is not decorating an id. */
function citationStripRegex(needlePattern) {
  return new RegExp(`${CITATION_BOILERPLATE_RUN}${needlePattern}${CITATION_SEP}${CITATION_BOILERPLATE_RUN}`, 'gi');
}

/** Remove every CITATION from `text` before novelty is measured over it
 *  (decision h20-novelty-counted-over-citation-stripped-uncapped-terms).
 *  Removes, in order:
 *    1. every canonical full uuid in the text — not merely the cited record's
 *       own id. Stripping only the cited id recreates the exploit at zero cost:
 *       cite the required id, append ONE unrelated uuid, collect its four or
 *       five hex fragments as "new vocabulary";
 *    2. the KNOWN 8-char prefixes of `recordIds` and nothing else — an
 *       arbitrary 8-hex token is a word until some record answers to it;
 *    3. the narrowly listed boilerplate immediately adjacent to either.
 *  Each removal leaves a space, so stripping can never fuse two neighbouring
 *  words into a token that was never written. */
export function stripCitations(text, recordIds = []) {
  let out = String(text ?? '');
  out = out.replace(citationStripRegex(FULL_UUID_PATTERN), ' ');
  for (const id of recordIds ?? []) {
    if (!id) continue;
    const prefix = String(id).toLowerCase().split('-')[0];
    if (prefix.length < 8) continue;
    out = out.replace(citationStripRegex(citationPattern(prefix)), ' ');
  }
  return out;
}

/** The denial payload, COMPACTED per decision 80d0ab62 (deny-once-message-
 *  compaction, amending PRESENTATION ONLY of decision 68332e4b — eligibility,
 *  the ledger/override mechanics and whole-form denial are untouched). One
 *  header line names the mechanism, decision 68332e4b, and instructs
 *  read-then-act, disclosing that the question was withheld from the user
 *  (the old second "lecture" line is gone). Each SETTLED sub-question renders
 *  as ONE row starting with an em-dash: label → kind + full ruling id +
 *  compact bracketed [status·scope] disclosure (", superseded_by: <id>"
 *  folded into the bracket only when the record carries one) + substance
 *  clipped to ~160 chars — still substance, never a bare sentence, so
 *  68332e4b's applicability-laundering guard is preserved. A multi-question
 *  form's preamble/OPEN block folds into ONE line (open sub-question labels
 *  inline, clipped). The override contract compresses to ONE line citing the
 *  matched ruling id(s), the unresolved-delta requirement, and the
 *  denied-again/logged consequence. `ruled` is `{index, label, decisions}[]`
 *  — `decisions` the matched ruling records themselves (status/superseded_by/
 *  scope disclosed, never just their title). `open` is `{index, label}[]` —
 *  the sub-questions that did NOT strongly match anything; naming them (not
 *  merely their count) is what lets the reader resubmit exactly the right
 *  slice of a form instead of re-deriving it. */
/** Resolved substance for one matched ruling, never silently empty (fix 1,
 *  dual-review HIGH finding): a decision with no statement, or an anti_pattern
 *  with neither trigger nor right_way, used to render as a bare/empty clip —
 *  indistinguishable from "nothing to disclose" and exactly the applicability-
 *  laundering shape 68332e4b's guard exists to prevent. Falls back to a loud
 *  explicit marker naming the record id as the read target instead.
 *
 *  Returns `{text, marker}` rather than one pre-joined string (fix 7,
 *  outside-family review MED finding): the marker is RENDERER CHROME, not
 *  record content, so it must survive clipping regardless of how long the
 *  present free-text half is. The old single-string return concatenated
 *  `presentText + marker` and let the CALLER's `clip(substance, 160)` cut the
 *  combined result — a 200+ char trigger with a missing right_way pushed the
 *  whole incompleteness marker (knowledge_get + id + which-half-missing) past
 *  the clip window, silently reproducing the applicability-laundering shape
 *  fix 1 exists to prevent, just triggered by length instead of absence. The
 *  caller now clips ONLY `text` and appends `marker` (never clipped) after. */
function substanceFor(d) {
  if (d.type === 'anti_pattern') {
    const trigger = typeof d.trigger === 'string' ? d.trigger.trim() : '';
    const rightWay = typeof d.right_way === 'string' ? d.right_way.trim() : '';
    // Both present: the original "trigger — right_way" pairing, all of it
    // clippable free text, no marker. Exactly ONE present (fix 6, dual-review
    // MED finding): the present half is the clippable text; the incompleteness
    // marker naming which half is missing and where to read it rides outside
    // the clip window. Neither present: no free text at all, only the marker.
    if (trigger && rightWay) return { text: `${trigger} — ${rightWay}`, marker: '' };
    if (trigger) return { text: trigger, marker: `⟨right_way missing — knowledge_get ${d.id}⟩` };
    if (rightWay) return { text: rightWay, marker: `⟨trigger missing — knowledge_get ${d.id}⟩` };
    return { text: '', marker: `⟨no substance recorded — knowledge_get ${d.id}⟩` };
  }
  const statement = typeof d.statement === 'string' ? d.statement.trim() : '';
  return statement ? { text: statement, marker: '' } : { text: '', marker: `⟨no substance recorded — knowledge_get ${d.id}⟩` };
}

/** The override line, ONE line regardless of matched-ruling count (fix 4,
 *  dual-review LOW finding): interpolating every matched id unconditionally
 *  can run past 220 chars once 3+ rulings match one sub-question. At most the
 *  first two ids render explicit; the rest fold into a "+N more" remainder.
 *  Carries no "OVERRIDE:" line-start token — nothing here is derived from
 *  caller-controlled text, so there is nothing for a spoofed label/substance
 *  to spoof by starting its own line. */
function renderOverrideLine(ids) {
  // Trivial guard (fix 4c): unreachable via renderDenyOnceMessage today (there
  // is always at least one matched ruling on the deny path), but a defensive
  // caller-facing function should never emit a double-space "Cite  +" for an
  // empty list — render the generic single-ruling phrasing instead.
  if (!ids.length) {
    return 'Cite the ruling id + the unresolved delta or it stays denied — a re-ask with no delta is denied again, and every override is logged.';
  }
  const EXPLICIT_CAP = 2;
  const shown = ids.slice(0, EXPLICIT_CAP);
  const rest = ids.length - shown.length;
  // "one of" whenever MORE THAN ONE ruling matched (fix 3c) — not gated at 3+:
  // at exactly two matches the gate still accepts citing either one, so the
  // phrasing must say so even though both ids fit explicit with no "+N more"
  // remainder. The single-ruling case (ids.length === 1) never says "one of".
  const idsText =
    ids.length > 1 ? `one of ${shown.join(', ')}${rest > 0 ? ` +${rest} more` : ''}` : shown.join(', ');
  return `Cite ${idsText} + the unresolved delta or it stays denied — a re-ask with no delta is denied again, and every override is logged.`;
}

/** THE ONE LIFECYCLE-STATUS SPELLING (decision db3392db, part 1). The bracket
 *  CONTENT `status·scope[, superseded_by: <id>]` was born inline in
 *  renderDenyOnceMessage below and is now shared verbatim with every pointer
 *  surface, so a reader never has to learn a second spelling for the same fact.
 *  Absent status/scope render as 'unknown' rather than being dropped: a pointer
 *  that cannot say what a record's lifecycle is must say THAT, not stay silent
 *  (P5). Never conflate this with a feature_article's own `state` field —
 *  'built'/'active' there describes the TERRITORY's build state, this describes
 *  the RECORD's lifecycle, and renderArticle prints both. */
export function statusBracket(record) {
  const status = record?.status ?? 'unknown';
  const scope = record?.scope ?? 'unknown';
  return `${status}·${scope}${record?.superseded_by ? `, superseded_by: ${record.superseded_by}` : ''}`;
}

/** The same bracket as a POINTER-SURFACE suffix (leading space included, or ''):
 *  SUPPRESSED for status 'active' because an [active] tag on every pointer line
 *  is noise on the one channel that fires constantly (P1) — the deny-once
 *  renderer keeps annotating unconditionally, where scope is material to the
 *  denial itself. Anything NOT exactly 'active' annotates, including an absent
 *  or unrecognised status: suppressing an unknown lifecycle would hide exactly
 *  the case the annotation exists for. */
export function statusAnnotation(record) {
  return record?.status === 'active' ? '' : ` [${statusBracket(record)}]`;
}

export function renderDenyOnceMessage(ruled, totalQuestions, open = []) {
  const lines = [
    'STERLING DENY-ONCE (H20, decision 68332e4b) — this question was NOT shown to the user; read the settled ruling(s) below, then act on them before resubmitting.',
  ];
  if (totalQuestions > 1) {
    const openLabel = open.length
      ? open.map((o) => `"${clip(normalizeWs(o.label) || `Sub-question ${o.index + 1}`, 40)}"`).join(', ')
      : 'none — every sub-question is settled';
    lines.push(
      `${totalQuestions} sub-question(s) total, ${ruled.length} settled by the store below — resubmit only the open sub-question(s): ${openLabel}`
    );
  }
  const citedIds = [];
  for (const r of ruled) {
    // Normalize BEFORE clipping (fix 2): whitespace runs (incl. embedded
    // newlines) collapse to one space, so a spoofed "\n— fake row" or
    // "\nOVERRIDE: fake" cannot split off its own rendered line.
    const label = clip(normalizeWs(r.label) || `Sub-question ${r.index + 1}`, 80);
    for (const d of r.decisions) {
      citedIds.push(d.id);
      const kind = d.type === 'anti_pattern' ? 'anti_pattern' : 'decision';
      // Composition site for fix 7: clip the free TEXT alone, then append the
      // marker (renderer chrome) OUTSIDE the clip window — clipping the
      // already-joined text+marker string (the old shape) can cut the marker
      // off entirely when the free text alone exceeds the clip budget.
      const { text, marker } = substanceFor(d);
      const clippedText = clip(normalizeWs(text), 160);
      const normalizedMarker = normalizeWs(marker);
      const substance = normalizedMarker ? `${clippedText}${clippedText ? ' ' : ''}${normalizedMarker}` : clippedText;
      // UNCONDITIONAL here (decision db3392db part 1): the pointer surfaces
      // suppress the bracket for an active record, this one never does — scope
      // is material to the denial, and a denied question's reader must be able
      // to see the ruling's lifecycle without a second lookup.
      lines.push(`— "${label}" → ${kind} [${d.id}] [${statusBracket(d)}]: ${substance}`);
    }
    // THE DELTA FLOOR IS A COUNT, AND THE DENIAL NOW SAYS SO (board fb7c43fb):
    // present only when THIS attempt cited a denied ruling and still fell short,
    // so a first attempt's message is byte-identical to before. The required
    // count is INTERPOLATED from DELTA_MIN_NEW_TERMS, never written into the
    // string — a message quoting a stale literal is worse than no number at all.
    if (r.delta && typeof r.delta.new_terms === 'number') {
      lines.push(
        `  re-ask delta: your re-ask added ${r.delta.new_terms} of the ≥${DELTA_MIN_NEW_TERMS} new terms required to override — ` +
          `state what is UNRESOLVED and why, in words the prior attempt did not use; repeating the same question with the id pasted in is denied again.`
      );
    }
  }
  const idList = [...new Set(citedIds)];
  lines.push(renderOverrideLine(idList));
  return lines.join('\n');
}


function clip(text, cap) {
  const s = String(text ?? '');
  // Code-point safe AND early-stopping (fix 5b, deny-once compaction round 2,
  // decision 80d0ab62): the old `Array.from(s)` splits by code point (so a
  // surrogate pair is never cut) but still MATERIALIZES THE ENTIRE INPUT as an
  // array before applying a small cap — shared consumers here pass unbounded
  // record fields (an oversized article body can be hundreds of KB), so that
  // allocation cost scaled with the full input, not the cap. This walks the
  // string by code point via the string iterator protocol (which yields whole
  // code points one at a time, same surrogate-pair safety as Array.from) and
  // stops the instant it has collected `cap` of them plus confirmed there is
  // at least one more — so it never reads past `cap + 1` code points in, no
  // matter how long `s` is. Cap semantics unchanged: cap counts code points;
  // ellipsis appended only when the input actually exceeds it.
  let out = '';
  let count = 0;
  for (const ch of s) {
    if (count === cap) return `${out}…`;
    out += ch;
    count++;
  }
  return out;
}

/** Collapse every whitespace run (space, tab, \r, \n, …) to a single space and
 *  trim (fix 2, dual-review finding). Applied to every interpolated free-text
 *  field BEFORE clipping, so embedded newlines in a sub-question label or a
 *  ruling's own statement/trigger/right_way can never fabricate a fake line start
 *  (e.g. a crafted "\n— fake →" prefix) inside renderDenyOnceMessage's
 *  otherwise-fixed 3-line shape. */
function normalizeWs(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** LINE-SAFE flatten (fixer F4): collapse every LINE BREAK and tab to a single
 *  space, WITHOUT trimming or collapsing ordinary space runs. Used on text that
 *  is already a whole rendered line (a pointer line replayed at drain), where
 *  normalizeWs would eat the leading indentation that line's own format carries,
 *  while the property we need is only "this can never become two lines".
 *  Interpolated FRAGMENTS (an id, a status bracket) use normalizeWs instead —
 *  trimming a fragment is correct, trimming a line is not.
 *
 *  The character class below is CR, LF, tab, form feed, vertical tab and the
 *  two Unicode separators U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR
 *  (a reader that splits on them sees a new line). Ordinary spaces are NOT in
 *  the class, which is what preserves a pointer line's own indentation.
 *
 *  It is built with `new RegExp(<string>)` rather than a regex literal because
 *  U+2028/U+2029 are LineTerminators in JS source. WHAT IS ACTUALLY IN THE
 *  STRING: backslash-u ESCAPE TEXT for both separators (the string parser
 *  resolves them to the real characters at load) — the source file is plain
 *  ASCII here, per anti-pattern d7e03137's posture. Verified 2026-08-31: a
 *  raw-control-byte grep over this file matches nothing. */
function flattenToOneLine(text) {
  return String(text ?? '').replace(new RegExp('[\\r\\n\\t\\f\\v\u2028\u2029]+', 'g'), ' ');
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
  let annotation = '';
  try {
    const match = store.articlesBySlug(slug).find((r) => !r.working_tree);
    if (match) {
      head = clip(match.what_it_does, 140);
      annotation = statusAnnotation(match);
    }
  } catch {
    head = '(lookup failed)';
  }
  return `  → ${kind} [[${slug}]]: ${head}${annotation}`;
}

/** Budget for the untestable_because reason clip, same class as
 *  DECISION_REJECTED_CLIP: a beneath-the-headline annotation, not the primary
 *  field — an unbounded reason would land uncapped in H19's injected payload
 *  (S4b fixer pass). */
export const UNTESTABLE_REASON_CLIP = 140;

/** Oversize-body guard (board 725299c8). Rendering a large what_it_does inline
 *  overflowed the RECEIVING agent's tool-result view: the real 'knowledge-
 *  delivery' article's own what_it_does is ~15k chars and its full block
 *  reached ~18.9KB, past the ~17KB view threshold — delivery degraded exactly
 *  at the surface it exists to serve. Past ARTICLE_BODY_FLOOR chars of body,
 *  renderArticle DIGESTS: a bounded head excerpt plus a knowledge_get pointer
 *  to the full record (its id, so the reader can fetch the withheld body),
 *  never the whole thing. Delivery degrades to a pointer, it NEVER denies
 *  (decision 9950dfff lineage / AC7 — this is not a gate). Below the floor,
 *  delivery is byte-identical to before, so small articles are untouched. */
export const ARTICLE_BODY_FLOOR = 4096;

/** Head-excerpt budget in the digest branch. Small enough that the excerpt plus
 *  the pointer line stays far under the 8192-byte delivery ceiling even when
 *  charCap is large; large enough to still orient the reader before they fetch. */
export const ARTICLE_DIGEST_EXCERPT = 1200;

/** Clip bound for slug/concept_family in the digest header — the only otherwise
 *  unbounded inputs to a digested block (board 725299c8, outside-family review).
 *  Generous vs real kebab slugs (which are far shorter), so normal rendering is
 *  unchanged while a pathological slug can no longer breach the delivery ceiling. */
export const ARTICLE_SLUG_CLIP = 256;

// ---------------------------------------------------------------------------
// KNOWN_GAPS INLINE DELIVERY (decision db3392db Part 3, ship-ruled by decision
// 53fd6f62 known-gaps-inline-ships-with-probe-seam-boarded; board 3dbbdb35).
// A delivered article's known_gaps ({site, kind, evidence, recorded_run} —
// packages/schemas records.ts) render inline beside the article: site + a
// whitespace-normalized FIRST SENTENCE of evidence only (normalized BEFORE
// sentence-splitting so an embedded newline in stored evidence can never
// fabricate a fake delivery line), ~400 chars/gap, a GLOBAL 3-gap budget PER
// DELIVERY — summed across every owning article touched in ONE hook
// invocation, never per-article (a per-article budget multiplies unboundedly
// when several articles own one path) — with the elision disclosed. A
// mutation_survivor gap is prefixed 'WRONG-ON-PURPOSE test survivor'; an
// 'other'-kind gap never is. The article's own knowledge_get pointer is
// retained beside the inlined gaps even for a small article whose normal
// (non-digest) render carries no pointer of its own. NO site-based filtering
// (the schema has no path/scope field on a gap yet) — every known_gaps entry
// on a delivered article is eligible for the budget.
//
// DEDUP rides the EXISTING per-article lineage/session guard (isDelivered/
// markDelivered above): an article that does not re-render this session
// (already guarded) never reaches renderArticle again, so its gaps never
// re-render either — there is no separate per-gap ledger to maintain.
//
// THE BASH/PROBE-OUTPUT SEAM (board f1489964, closing what this section used
// to describe as an accepted exclusion — decision known-gaps-inline-ships-
// with-probe-seam-boarded 53fd6f62's ship condition): the Bash pointer path
// (h19-bash-delivery.mjs / bashPointerBlock below) still never calls
// renderArticle — a pointer stays a pointer, never the article body — but it
// now reuses renderKnownGapsLines/budgetKnownGaps directly to append the SAME
// gap substance (budget, normalization, WRONG-ON-PURPOSE prefix, cap
// disclosure) beside its pointer line, through its OWN bounded dedup
// (guard.gap_articles, see isGapDelivered/markGapDelivered above) — never the
// records/slugs guard the paragraph above describes, which stays the
// Read/Edit path's alone.
// ---------------------------------------------------------------------------

/** Global per-DELIVERY cap on inlined gaps — NOT per article, see header. */
export const GAP_GLOBAL_BUDGET = 3;

/** ~400 chars/gap per the ruling; clip() discloses truncation with its own
 *  ellipsis rather than a silent cut. */
export const GAP_EVIDENCE_CHAR_CAP = 400;

/** Deterministic per-gap render order (spec: "deterministic article/gap
 *  ordering"): a mutation_survivor gap — proven-live evidence a mutation test
 *  actually caught nothing — outranks an ordinary 'other' blind spot,
 *  mirroring HAZARD_RANK's own severity-first precedent above. Ties (same
 *  kind) keep delivery order (owner order, then the owner's own known_gaps
 *  array order). GLOBAL, not per-owner (Codex review finding 3): a survivor
 *  gap on the delivery's SECOND owner must still outrank an 'other' gap on
 *  the FIRST owner for the one shared budget — see budgetKnownGaps below,
 *  which is the only caller. */
const GAP_KIND_RANK = { mutation_survivor: 0, other: 1 };

/** Bound the INPUT to firstSentence before it does any work (Codex review
 *  finding 5): normalizeWs walks its whole argument, so an unbounded stored
 *  evidence field (nothing in the schema caps it) must never reach it whole.
 *  Generous relative to GAP_EVIDENCE_CHAR_CAP — comfortably enough slack to
 *  find a real sentence terminator inside what will render — but still a
 *  hard multiple, not "however long the record is". */
const FIRST_SENTENCE_SCAN_CAP = GAP_EVIDENCE_CHAR_CAP * 4;

/** First sentence terminator, optionally followed by a closing quote/bracket
 *  before the whitespace/end-of-string boundary (Codex review finding 5): a
 *  sentence ending 'He said "stop."' must still cut after the closing quote,
 *  not run on into whatever follows because the char right after the period
 *  was punctuation rather than whitespace. */
const SENTENCE_END_RE = /^.*?[.!?]["'”’)\]]*(?=\s|$)/;

/** Whitespace-normalized FIRST SENTENCE of `text` only — the input is CAPPED
 *  before normalizing (bounded work regardless of stored evidence size), then
 *  normalized (so an embedded newline cannot fabricate a fake boundary), then
 *  matched up to the first sentence terminator (see SENTENCE_END_RE). A run
 *  with no terminator at all within the scan cap (an oversize single
 *  "sentence") falls back to the whole (bounded, normalized) text — clip()
 *  in renderGapLine is what bounds the actually-rendered result to
 *  GAP_EVIDENCE_CHAR_CAP regardless. */
function firstSentence(text) {
  const raw = String(text ?? '');
  const bounded = raw.length > FIRST_SENTENCE_SCAN_CAP ? raw.slice(0, FIRST_SENTENCE_SCAN_CAP) : raw;
  const s = normalizeWs(bounded);
  const m = SENTENCE_END_RE.exec(s);
  return m ? m[0] : s;
}

/** Site-label clip (Codex review finding 4): `site` is free text with no
 *  length bound in the schema, and — unlike evidence — was rendered RAW. A
 *  long or multiline site could otherwise enlarge or fabricate lines in the
 *  digest path. Normalized (so an embedded newline can't fake a new line)
 *  then clipped; clip() already appends its own ellipsis disclosure. */
export const GAP_SITE_CLIP = 120;

/** One rendered gap line. Deliberately carries no repeated section-header
 *  word (never the literal "gap") beside the site: a recorded site is
 *  free-text and can itself contain a digit (e.g. a numbered fixture id), and
 *  a per-line header word would then sit on the very same line as that digit
 *  — indistinguishable from a genuine disclosure to any digit-proximity
 *  reader. The one "KNOWN GAPS" header word lives ONCE, on its own line with
 *  no digit on it, in renderKnownGapsLines below. */
function renderGapLine(gap) {
  const site = clip(normalizeWs(gap.site), GAP_SITE_CLIP);
  const sentence = clip(firstSentence(gap.evidence), GAP_EVIDENCE_CHAR_CAP);
  const prefix = gap.kind === 'mutation_survivor' ? 'WRONG-ON-PURPOSE test survivor: ' : '';
  return `  - ${site}: ${prefix}${sentence}`;
}

/** Slice EVERY owner's known_gaps against ONE shared budget, ranked GLOBALLY
 *  (Codex review finding 3) — every candidate gap across every owner in this
 *  delivery is pooled, sorted by GAP_KIND_RANK (survivor-first) with a
 *  delivery-order tiebreak (owner order, then the owner's own array order),
 *  and only THEN sliced to `budget`. Grouped back per owner afterward, in the
 *  same ranked order, for rendering. Returns a Map keyed by owner id:
 *  {shown, dropped, total, totalDropped}. An owner with no known_gaps at all
 *  (absent or an explicit empty array — the control case) gets NO entry, so a
 *  caller can tell "nothing recorded" from "everything here was dropped by
 *  the budget" (an owner whose gaps all lost the budget still gets an entry,
 *  with shown: [] — see renderKnownGapsLines, Codex review finding 2). */
export function budgetKnownGaps(owners, budget = GAP_GLOBAL_BUDGET) {
  const totals = new Map();
  const candidates = [];
  owners.forEach((owner, ownerIndex) => {
    const raw = Array.isArray(owner.known_gaps) ? owner.known_gaps : [];
    if (!raw.length) return;
    totals.set(owner.id, raw.length);
    raw.forEach((gap, gapIndex) => candidates.push({ owner, gap, ownerIndex, gapIndex }));
  });
  if (!candidates.length) return new Map();
  const ranked = [...candidates].sort((a, b) => {
    const rankDiff = (GAP_KIND_RANK[a.gap.kind] ?? 1) - (GAP_KIND_RANK[b.gap.kind] ?? 1);
    if (rankDiff !== 0) return rankDiff;
    if (a.ownerIndex !== b.ownerIndex) return a.ownerIndex - b.ownerIndex;
    return a.gapIndex - b.gapIndex;
  });
  const byOwner = new Map();
  for (const owner of owners) {
    if (totals.has(owner.id)) byOwner.set(owner.id, { shown: [], dropped: 0, total: totals.get(owner.id) });
  }
  ranked.forEach((c, i) => {
    const info = byOwner.get(c.owner.id);
    if (i < budget) info.shown.push(c.gap);
    else info.dropped += 1;
  });
  const totalDropped = [...byOwner.values()].reduce((sum, info) => sum + info.dropped, 0);
  for (const info of byOwner.values()) info.totalDropped = totalDropped;
  return byOwner;
}

/** The known-gaps block lines for ONE article, or [] only when NOTHING was
 *  recorded for it at all (no map entry). An owner that HAS an entry but
 *  whose whole allocation lost the shared budget (shown: [], dropped: total
 *  > 0 — Codex review finding 2) still renders the header and an explicit
 *  "0 of N shown" elision — silently omitting the block entirely would drop
 *  both the omission AND the total count with no trace. The knowledge_get
 *  pointer is ALWAYS appended when the block renders at all (decision
 *  db3392db Part 3: "the knowledge_get pointer retained even when
 *  rendered") — a small article's normal render carries no pointer of its
 *  own today, so without this the reader would have nothing to follow back
 *  to the full record. */
export function renderKnownGapsLines(article, info) {
  if (!info) return [];
  const lines = ['KNOWN GAPS recorded for this territory:'];
  for (const gap of info.shown) lines.push(renderGapLine(gap));
  if (info.dropped > 0) {
    const totalNote =
      info.totalDropped > info.dropped ? `; ${info.totalDropped} total omitted across this delivery` : '';
    lines.push(
      `  … ${info.shown.length} of ${info.total} known gap(s) shown for this article (global budget ${GAP_GLOBAL_BUDGET} per delivery); ${info.dropped} not shown${totalNote} — knowledge_get ${article.id} for the full set`
    );
  } else {
    lines.push(`  (full record: knowledge_get ${article.id})`);
  }
  return lines;
}

/** Render the delivery payload for one owning feature_article: its substance
 *  (what_it_does, intended_behavior, current ACs) plus one-hop POINTERS —
 *  slugs with one-liners, never full neighbor bodies (grill answer: article +
 *  one-hop pointers; P6 filter-first-capped). `gaps` (optional) is one entry
 *  of budgetKnownGaps's returned Map, keyed by this article's id — inlined
 *  per the known_gaps section above when present. */
export function renderArticle(store, article, charCap, { gaps } = {}) {
  // slug/concept_family are clipped (outside-family review, board 725299c8): they
  // are the only unbounded inputs to the digest block below, so without this a
  // pathological slug/family could push the digested block past the ~8192-byte
  // delivery ceiling that clipping the body alone otherwise guarantees. Real
  // kebab slugs sit far under this bound, so normal rendering is unchanged.
  // `state` is the ARTICLE's build state, the trailing bracket is the RECORD's
  // lifecycle status (decision db3392db part 1) — two different facts, printed
  // side by side rather than collapsed into one token.
  // ID ON THE HEADER (decision 2e8c30e4 human-readable ids — name first, id
  // retained): the 8-char prefix rides in its OWN parenthetical, ahead of the
  // (state, concept_family) group, so a reader citing this article by id never
  // has to fall back to knowledge_query to learn what it even is first.
  const id8 = String(article.id ?? '').slice(0, 8);
  const header = `▸ article '${clip(article.slug, ARTICLE_SLUG_CLIP)}' (${id8}) (${article.state}${article.concept_family ? `, concept family '${clip(article.concept_family, ARTICLE_SLUG_CLIP)}'` : ''})${statusAnnotation(article)}`;
  const body = String(article.what_it_does ?? '');
  // OVERSIZE (board 725299c8): digest the body and POINT to the full record
  // instead of rendering the article whole. Withholding intended_behavior, the
  // AC list and one-hop pointers behind the knowledge_get pointer is what keeps
  // the block bounded no matter how large those fields grow — the measured
  // offender carried a ~5k intended_behavior and 12 ACs on top of a ~15k body.
  const gapLines = renderKnownGapsLines(article, gaps);
  if (body.length > ARTICLE_BODY_FLOOR) {
    return [
      header,
      `WHAT IT DOES (digested — full body is ${body.length} chars, withheld to fit the reader's view): ${clip(body, ARTICLE_DIGEST_EXCERPT)}`,
      `▸ FULL RECORD (intended_behavior, acceptance criteria, one-hop dependencies withheld): knowledge_get ${article.id}` +
        ` — windowed: knowledge_get ${article.id} field:"what_it_does" offset:0 length:4000, then page by offset.`,
      ...gapLines,
    ].join('\n');
  }
  const lines = [
    header,
    `WHAT IT DOES: ${clip(body, charCap)}`,
    `INTENDED BEHAVIOR: ${clip(article.intended_behavior, charCap)}`,
    // The oversize branch above already carries a knowledge_get pointer; this
    // branch (small/normal articles) did not, so a reader could not cite the
    // record by id without a second lookup (decision 2e8c30e4).
    `▸ FULL RECORD: knowledge_get ${article.id}`,
  ];
  // Board a9280db7: on a probe|tool article, current_ac can be the structured
  // not_applicable exemption object instead of an array — `?.length` is
  // undefined on that shape, so this ACCEPTANCE CRITERIA section is silently
  // omitted for such an article, same as any article with zero real ACs;
  // acceptable (never a crash), not a distinct case worth its own line.
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
  lines.push(...gapLines);
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
/** THE ONE HAZARD HEADER LINE BUILDER (consolidation, decision 6f3e334c still
 *  governs: hazards are SUBSTANCE, rendered the SAME WAY wherever they appear
 *  — two header formats for one hazard block, depending on which surface
 *  rendered it, is the "enforced in two places" smell). Both `renderHazards`
 *  (the full/queued rendering) and the porch's own hazard preview
 *  (lib/delivery.mjs renderPorch) call this and NOTHING ELSE builds the line.
 *
 *  `clipTitleBytes`/`clipSlugBytes`, when given, apply a BYTE-safe clip
 *  (clipToBytes) — the porch's own budget constraint, since a pathological
 *  title/slug must never blow its byte ceiling. Omitted (renderHazards' own
 *  call), title/slug render exactly as stored, unclipped — byte-for-byte
 *  today's behavior. */
export function hazardHeaderLine(ap, { clipTitleBytes, clipSlugBytes } = {}) {
  const title = typeof clipTitleBytes === 'number' ? clipToBytes(ap?.title, clipTitleBytes) : ap?.title;
  const slug =
    ap?.slug ? (typeof clipSlugBytes === 'number' ? clipToBytes(ap.slug, clipSlugBytes) : ap.slug) : '';
  return `⚠ ANTI-PATTERN [${(ap?.severity ?? 'warn').toUpperCase()}] for this path — '${title}'${slug ? ` [${slug}]` : ''} (full record: knowledge_get ${ap?.id})${statusAnnotation(ap)}`;
}

/** `total` / `suppressed` (fixer F3) exist for the DRAIN, which is handed only
 *  the ids that were SHOWN in the original payload (some of which may since have
 *  died) and must still replay the ORIGINAL '+N more' tail rather than deriving
 *  a new one from the survivors it happens to have left. Omitted, both fall back
 *  to today's derivation, so every producer call is byte-identical. */
export function renderHazards(hazards, charCap, { cap = HAZARD_CAP, fileKeys = [], remedy, total, suppressed } = {}) {
  const shown = cappedHazards(hazards, cap);
  const fullTotal = total ?? hazards.length;
  const dropped = suppressed ?? hazards.length - shown.length;
  const blocks = shown.map((ap) =>
    [hazardHeaderLine(ap), `TRIGGER: ${clip(ap.trigger, charCap)}`, `RIGHT WAY: ${clip(ap.right_way, charCap)}`].join('\n')
  );
  if (dropped > 0) {
    // `remedy` overrides the widening query for callers whose match was not a
    // file_keys join (the subject channel has no file answer at all — a
    // file_keys:[] query would be unrunnable; review finding 4, 2026-08-10).
    const keys = fileKeys.map((k) => `"${k}"`).join(',');
    const widen = remedy ?? `knowledge_query types:["anti_pattern"] file_keys:[${keys}] cap:${fullTotal}`;
    blocks.push(`… ${dropped} more hazard(s) NOT shown (cap ${cap}) — ${widen} for the full set`);
  }
  return blocks;
}

/** Complete hazard blocks in the porch's indented presentation. */
export function completePorchHazards(hazards) {
  return cappedHazards(hazards ?? []).map((hazard) => [
    hazardHeaderLine(hazard),
    `  TRIGGER: ${hazard.trigger ?? ''}`,
    `  RIGHT WAY: ${hazard.right_way ?? ''}`,
  ].join('\n'));
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

/** AUTHORITY RUNGS for pointer ranking, most authoritative first. An ABSENT or
 *  UNRECOGNISED authority sits on the same rung as an explicitly unstated one:
 *  a value this code does not know is not evidence that the decision carries
 *  LESS weight, so it must never be demoted below a self-declared
 *  `session_scoped`/`one_off`. Ordering only — nothing here reads a rung for
 *  any other purpose. */
const DECISION_AUTHORITY_RANK = { standing: 0, session_scoped: 2, one_off: 3 };
const DECISION_AUTHORITY_UNSTATED = 1;

/** RANK the decisions a FILE TOUCH matched, before DECISION_POINTER_CAP cuts
 *  them (measured 2026-09-06 by the delivery oracle's golden layer).
 *
 *  THE DEFECT: the store returns a file_keys join ordered by overlap count, then
 *  updated_at DESC, then id DESC (packages/store/src/index.ts:2371). With ONE
 *  path every row has overlap 1, so the tiebreak IS the order — H19 was purely
 *  newest-first. On a file carrying more decisions than the cap (CLAUDE.md: 32;
 *  packages/mcp-server/src/server.ts: 22) that silently drops the older fixes,
 *  which are exactly the ones a toucher is most likely to re-break: an incident
 *  ruling earns its keep by being OLD and still true.
 *
 *  THE ORDER, and why each rung is where it is:
 *   1. AUTHORITY — a `standing` ruling governs until superseded, so it outranks
 *      a newer note that only ever spoke for one session. This is the rung that
 *      does the real work; the rest are deterministic tiebreaks.
 *   2. FEWER file_keys FIRST — a decision naming two files is ABOUT those two
 *      files, while one naming thirty is background that will surface on many
 *      other touches anyway. The narrow record has fewer chances to be
 *      delivered, so it gets the slot here.
 *   3. updated_at DESC, then 4. id DESC — the store's own remaining tiebreaks,
 *      kept so ranking never introduces nondeterminism the caller must absorb.
 *
 *  NOT H20 CENTRALITY, and this was measured rather than assumed: on those two
 *  files the target decisions rank 17th and 14th by centrality. Centrality
 *  scores a record against an OUTGOING PROMPT's vocabulary, and a file touch has
 *  no prompt — the reader is opening a file, not asking a question.
 *
 *  PURE and NON-MUTATING (returns a new array): the caller ranks ONCE and uses
 *  the SAME array for the session guard, the render recipe and the renderer, or
 *  the guard marks one set delivered while the payload shows another. */
export function rankFileDecisionPointers(decisions) {
  // Object.hasOwn, NEVER `in` (Codex round 2, item 3): `in` sees INHERITED
  // properties, so authority 'toString' / '__proto__' / 'constructor' resolves
  // to a function or object, the subtraction below becomes NaN, the comparator
  // silently reports "equal" for that pair, and the rung is discarded without a
  // sound. An unrecognised string must land on the unstated rung exactly as this
  // function documents — own-property lookup is what makes the documentation
  // true rather than true-for-most-inputs.
  const authority = (d) => {
    const a = typeof d?.authority === 'string' ? d.authority : '';
    return Object.hasOwn(DECISION_AUTHORITY_RANK, a) ? DECISION_AUTHORITY_RANK[a] : DECISION_AUTHORITY_UNSTATED;
  };
  const breadth = (d) => (Array.isArray(d?.file_keys) ? d.file_keys.length : 0);
  // An unparseable updated_at sorts OLDEST rather than throwing off the
  // comparator — a malformed timestamp must cost a slot, never determinism.
  const updated = (d) => {
    const t = Date.parse(d?.updated_at ?? '');
    return Number.isFinite(t) ? t : -Infinity;
  };
  return [...(decisions ?? [])].sort(
    (a, b) =>
      authority(a) - authority(b) ||
      breadth(a) - breadth(b) ||
      updated(b) - updated(a) ||
      (String(b?.id ?? '') < String(a?.id ?? '') ? -1 : String(b?.id ?? '') > String(a?.id ?? '') ? 1 : 0)
  );
}

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
export function renderDecisionPointers(rel, decisions, cap = DECISION_POINTER_CAP, { remedy, total, suppressed } = {}) {
  const shown = decisions.slice(0, cap);
  // `total` / `suppressed` (fixer F3) — see renderHazards' note: the drain holds
  // only the shown slice and replays the original count and tail.
  const fullTotal = total ?? decisions.length;
  const dropped = suppressed ?? decisions.length - shown.length;
  const lines = [
    `▸ DECISIONS for this path (${fullTotal}) — why it is this way and what was rejected. Pointers only; follow one before contradicting it:`,
  ];
  for (const d of shown) {
    const authorityMarker = d.authority ? `[${d.authority}] ` : '';
    lines.push(`  → ${authorityMarker}${clip(d.statement, DECISION_STATEMENT_CLIP)}${d.slug ? ` [${d.slug}]` : ''} (knowledge_get ${d.id})${statusAnnotation(d)}`);
    const rejected = (Array.isArray(d.alternatives_rejected) ? d.alternatives_rejected : [])
      .map((a) => (typeof a?.option === 'string' ? a.option.trim() : ''))
      .filter(Boolean)
      .join('; ');
    if (rejected) lines.push(`    ✗ ALREADY REJECTED: ${clip(rejected, DECISION_REJECTED_CLIP)}`);
  }
  if (dropped > 0) {
    // Same remedy override as renderHazards: a subject match has no file_keys
    // answer, so the widening query must come from the caller there.
    const widen = remedy ?? `knowledge_query types:["decision"] file_keys:["${rel}"] cap:${fullTotal}`;
    lines.push(`  … ${dropped} more NOT shown (cap ${cap}) — ${widen} for the full set`);
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

/** The line-suspect block DECOMPOSED into `{header, lines: [{id, line}], footer}`
 *  — the same shape bashPointerBlock uses, and for the same reason (fixer M1).
 *
 *  Each advisory line is RECORD-DERIVED: suspectLabel interpolates the record's
 *  own title/slug/id. Replaying the block verbatim at drain therefore serves
 *  cached per-record text for a record that may have been superseded or deleted
 *  since enqueue — the exact leak the pointer channel was fixed for, arriving
 *  through the field the recipe called "advisory text about the FILE". Keyed by
 *  id, the drain can re-resolve each line instead. */
export function lineSuspectBlock(suspects, charCap) {
  return {
    header:
      "⚠ LINE-SUSPECT (H19 advisory) — cited line position(s) below may have rotted: the citing record predates this file's current version.",
    lines: (suspects ?? []).map(({ record, tokens }) => ({
      id: record.id,
      line: `  → ${suspectLabel(record)} cites ${clip(tokens.join(', '), charCap)} — this position may no longer be accurate.`,
    })),
    footer: '  Line numbers rot as a file changes — cite an anchor (function/slug/passage) instead where possible.',
  };
}

/** One trailing block naming every stale-citing record and the token(s) it
 *  cites. `suspects` is `{record, tokens}[]`, already filtered to the stale
 *  ones by the caller's scan — this only renders what it is handed. Returns
 *  `[]` (no block at all) when nothing is suspect, matching the other
 *  render* helpers' empty-array-means-nothing-to-add convention. */
export function renderLineSuspects(suspects, charCap) {
  if (!suspects?.length) return [];
  return [joinSuspectBlock(lineSuspectBlock(suspects, charCap))];
}

/** Join a decomposed suspect block. Returns '' when NO line survives: the header
 *  promises "cited line position(s) BELOW" and the footer advises about them, so
 *  a header+footer with nothing between them is an advisory about nothing. */
export function joinSuspectBlock({ header, lines = [], footer } = {}) {
  if (!lines.length) return '';
  return [header, ...lines.map((l) => l.line), footer].filter((s) => typeof s === 'string' && s).join('\n');
}

/** The delivery envelope. `unowned` swaps the header for the frontier signal:
 *  hazards and decisions can attach to territory NO article owns, and claiming
 *  'owning knowledge for X' above them would be false. With no blocks at all the
 *  unowned payload is exactly the frontier notice — the pre-hazard behavior.
 *
 *  `substantiveCount` (fixer F5) is how many of `blocks` are SUBSTANTIVE —
 *  hazards, owners, decision pointers, trailing advisories. It exists because
 *  renderFrontier's `hasOtherKnowledge` sentence promises "the store DOES hold
 *  the hazards and/or decisions below", and at the DRAIN a block list can consist
 *  entirely of DISCLOSURES about records that died since enqueue. Deriving the
 *  promise from blocks.length there prints the assurance above nothing but
 *  tombstones — precisely the false-assurance failure renderFrontier's own
 *  comment (decision ca23c811) exists to prevent, arriving from the other side.
 *  Omitted, it falls back to blocks.length, so producer calls are unchanged. */
// ---------------------------------------------------------------------------
// THE SUBAGENTSTART "PORCH" (H19 front-porch). On Claude Code 2.1.263 the
// harness shows a spawned subagent only the first ~2KB of a hook's
// additionalContext INLINE and spills the rest to a persisted file the agent
// must choose to open (research_finding 518b7d21) — a hazard block buried
// behind three anti-pattern blocks was measured NEVER SEEN by one of six
// probed agents. The porch is a BOUNDED PREFIX built to survive that cut: the
// H19 header, every rendered hazard (substance, not a pointer — decision
// 6f3e334c's ordering rationale: hazards are substance, decisions are capped
// pointers, and this porch preserves that ordering even inside its own
// budget), then owner pointers with a shrinking digest, then a porch-end line
// disclosing what follows and how to reach it if truncated.
//
// SCOPE (AMENDED 2026-09-08, decision 0050a536 §5, evidence 5d2a527f):
// h19-dispatch-staging.mjs's file-touch (path-channel) payload, AND
// h19-knowledge-delivery.mjs's DIRECT-INJECT tool-time block (the 'read'/
// 'edit' rungs, where the payload is emitted as additionalContext in-process)
// — that surface measured 11-15KB on a governed path and spilled behind the
// harness's 2KB preview exactly like the SubagentStart case did. NOT applied
// at ENQUEUE time (the 'prompt' rung's queued payload) or by h19-delivery-
// drain.mjs (the queued-prompt rung, which injects one turn later) — both
// keep today's block order, no porch, so the queue's own byte-for-byte
// content is unchanged by this amendment.
//
// BYTES, NOT CHARS: every clip in this section measures UTF-8 bytes
// (Buffer.byteLength) — a multibyte hazard title or slug must never push the
// assembled porch past `budget` while looking short in JS string length.
//
// THE INVARIANT: Buffer.byteLength(renderPorch(...)) <= budget ALWAYS, for any
// budget > 0. The cascade that holds it: reduce admitted owners (down to 0)
// until the FIXED lines (header + owner pointer lines + porch-end) fit: then
// split what remains 60/40 between hazards and digests (100% to whichever
// exists alone, redistributed toward the hazard floor first when both exist);
// then, only if that still cannot meet the per-hazard floor, clip hazards
// below it; a final byte-safe hard clip is the absolute last resort so the
// invariant never depends on any single step above being exhaustive. No cut is
// ever silent: the porch-end line states the byte count and what follows, and
// an owner/hazard cap always renders its own "+N more"/"NOT shown" line.
// ---------------------------------------------------------------------------

/** How many owner pointers the porch admits before the rest are disclosed as
 *  '+N owners below' — deliberately small (this is the PREVIEW, not the full
 *  delivery; every owner still gets its full renderArticle/renderReference in
 *  the REMAINDER that follows the porch, porch-admission or not). */
export const PORCH_OWNER_CAP = 3;

/** Soft per-hazard floor (bytes) for the combined TRIGGER+RIGHT WAY clipped
 *  text: the allocator prefers to meet this by reducing owners / borrowing from
 *  the digest share first, and only clips below it as the documented last
 *  resort (never an overrun). Small enough that even a tight budget can host
 *  all HAZARD_CAP hazards at some substance; large enough that a hazard
 *  clipped exactly to it is still legible (a clause or two), not a fragment. */
export const PORCH_HAZARD_FLOOR_BYTES = 90;

/** Clip budget for a hazard's TITLE inside its porch header line — independent
 *  of the trigger/right_way floor above, since a title is identification, not
 *  the substance the floor protects. */
export const PORCH_TITLE_CLIP_BYTES = 70;

/** Clip budget for a slug/title inside an owner pointer line — generous vs a
 *  real kebab slug, bounding only a pathological one (mirrors ARTICLE_SLUG_CLIP
 *  above, byte- rather than char-counted here since porch math is all bytes). */
export const PORCH_OWNER_LABEL_CLIP_BYTES = 90;

/** Clip budget for a hazard's `[<slug>]` suffix in its porch scaffold line —
 *  the HIGH finding a Codex review found (delivery.mjs, hazard scaffold):
 *  `hazard.slug` was interpolated UNBOUNDED, so a single pathological slug
 *  (e.g. a multibyte string repeated a thousand times) blew the skeleton past
 *  ANY budget before a single byte of clippable text was ever considered —
 *  the final clamp then cut everything after the header, losing the owner
 *  disclosure and the porch-end line entirely. Every other variable field a
 *  porch scaffold line interpolates is independently bounded already: the
 *  hazard/owner title/slug via PORCH_TITLE_CLIP_BYTES/PORCH_OWNER_LABEL_CLIP_
 *  BYTES, id8 by construction (`.slice(0, 8)` bounds any input to at most 8
 *  chars), the full uuid by the store's own fixed format, and `state` by its
 *  closed zod enum (packages/schemas/src/records.ts — longest member
 *  'deprecated', 10 chars) — this was the one unclipped variable field left.
 *
 *  LOW (roster reviewer, consolidation round): since hazardHeaderLine unified
 *  the porch's hazard header with renderHazards' own (decision 6f3e334c), the
 *  porch scaffold line also carries statusAnnotation(ap) — a THIRD unclipped
 *  variable field, distinct from title/slug above. It is bounded in practice
 *  the same way `state` is: `status` is a closed enum, `superseded_by` (when
 *  present) is the store's own fixed-format uuid, so its worst case is small
 *  and fixed-width, not attacker-growable the way a free-text title/slug is.
 *  The skeleton still MEASURES it (hazardSectionAt's skeleton pass renders the
 *  real header, statusAnnotation included, before any clipped text is added),
 *  so the byte invariant holds regardless — this note is a completeness
 *  record, not a defect: no dedicated clip constant is warranted for a field
 *  that cannot grow. */
export const PORCH_SLUG_CLIP_BYTES = 60;

/** Clip budget for the PATH LIST portion of the porch's OWN header line —
 *  the SECOND HIGH finding a Codex review found: `payloadHeaderLine(rels.join
 *  (', '))` interpolates the caller's `rel`/`rels` UNBOUNDED, so a single huge
 *  path (or a long multi-file dispatch's joined list) could blow the skeleton
 *  past ANY budget before the header's own fixed check even got a chance —
 *  measured: budget 1800, a 1000-char rel, one hazard, four owners assembled
 *  to ~3442 bytes and the final hard clamp cut everything after the header,
 *  losing the owner disclosure and the porch-end line entirely, exactly the
 *  failure mode PORCH_SLUG_CLIP_BYTES closed for hazard slugs. See
 *  porchHeaderLine below — the REMAINDER's own header (renderPayload, via
 *  payloadHeaderLine) is UNCHANGED and stays unclipped; only the porch's own
 *  copy is bounded, since only the porch is budget-constrained. */
export const PORCH_HEADER_PATH_CLIP_BYTES = 200;

/** Clip budget for the file_keys LIST inside the porch's own hazard-overflow
 *  widening query (consolidation: the porch's overflow line must state the
 *  SAME `knowledge_query types:["anti_pattern"] file_keys:[…] cap:N` widening
 *  disclosure renderHazards emits, decision 6f3e334c — "never drop the
 *  line", clip it instead). Generous vs an ordinary file_keys join; bounds
 *  only a pathological one, mirroring PORCH_HEADER_PATH_CLIP_BYTES for the
 *  porch's own header line. */
export const PORCH_WIDENING_KEYS_CLIP_BYTES = 200;

const PORCH_HAZARD_SHARE = 0.6;
const PORCH_DIGEST_SHARE = 0.4;

/** Reserve width (decimal digits) for the porch-end line's own self-reported
 *  byte count. porchEndLine (below) first renders with this reserved width and
 *  then substitutes the measured count, so the reserve is a substitution slot,
 *  not a true fixed point. 6 digits covers any budget under 1
 *  million bytes, which every configured/derived budget in this mechanism is
 *  many orders of magnitude under. */
const PORCH_BYTE_COUNT_RESERVE = '000000';

function porchByteLen(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8');
}

/** Byte-safe clip: never splits a UTF-8 codepoint, appends a single '…'
 *  (itself budgeted) only when truncation actually happened and there is room
 *  for it. `maxBytes <= 0` yields ''. Distinct from the existing char-counted
 *  `clip()` above — the porch's whole point is a BYTE ceiling the harness
 *  itself measures in, so a multibyte string must never be measured wrong. */
function clipToBytes(text, maxBytes) {
  const s = String(text ?? '');
  if (maxBytes <= 0) return '';
  if (porchByteLen(s) <= maxBytes) return s;
  const ELLIPSIS = '…';
  const ellipsisBytes = porchByteLen(ELLIPSIS);
  const room = maxBytes > ellipsisBytes ? maxBytes - ellipsisBytes : 0;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const chBytes = porchByteLen(ch);
    if (used + chBytes > room) break;
    out += ch;
    used += chBytes;
  }
  return room > 0 ? `${out}${ELLIPSIS}` : out;
}

/** A byte-bounded, JSON-SAFE `[...]` array literal for the porch's widening
 *  `file_keys:[...]` query (Codex review, MEDIUM 2). Two defects a naive
 *  `clipToBytes` over the pre-joined, already-quoted string reproduces: (1) a
 *  clip that lands MID-ENTRY drops the closing quote, so `file_keys:["aaaa…]
 *  cap:4` is not valid JSON-ish query syntax at all; (2) a raw quote or
 *  backslash INSIDE a filename, interpolated unescaped, breaks the query the
 *  same way. Fixed by admitting WHOLE `JSON.stringify`-escaped entries, in
 *  order, only while the running total still fits `maxBytes` — the first
 *  entry that would overrun stops admission (never skip ahead to a shorter
 *  later one, which would silently reorder what the query names) — and the
 *  literal is ALWAYS balanced (`[]` at minimum, comma-joined otherwise).
 *  Dropped keys are disclosed as `(+N keys omitted)` immediately after the
 *  literal, never silently — mirroring every other cut this mechanism makes. */
function clippedFileKeysLiteral(keys, maxBytes) {
  const list = keys ?? [];
  const admitted = [];
  let used = 2; // '[' + ']'
  for (const k of list) {
    const entry = JSON.stringify(String(k));
    const sep = admitted.length ? 1 : 0; // ',' between entries
    const entryBytes = porchByteLen(entry) + sep;
    if (used + entryBytes > Math.max(maxBytes, 2)) break;
    admitted.push(entry);
    used += entryBytes;
  }
  const omitted = list.length - admitted.length;
  const literal = `[${admitted.join(',')}]`;
  return omitted > 0 ? `${literal} (+${omitted} keys omitted)` : literal;
}

/** One owner pointer line: `▸ article '<slug>' (<id8>, <state>) — knowledge_get
 *  <uuid>` or the reference_material equivalent — name first, id retained
 *  (decision 2e8c30e4), same spelling Part 2 gives renderArticle's own header. */
function porchOwnerLine(owner) {
  const id8 = String(owner?.id ?? '').slice(0, 8);
  if (owner?.type === 'reference_material') {
    return `▸ reference '${clipToBytes(owner.title, PORCH_OWNER_LABEL_CLIP_BYTES)}' (${id8}) — knowledge_get ${owner.id}`;
  }
  return `▸ article '${clipToBytes(owner?.slug, PORCH_OWNER_LABEL_CLIP_BYTES)}' (${id8}, ${owner?.state ?? 'unknown'}) — knowledge_get ${owner?.id}`;
}

/** Owner ranking for porch admission: feature_article before reference_material
 *  (an article carries substance a reference pointer does not), then most
 *  recently updated first — a stable, deterministic order so which 3 of N
 *  owners get admitted never depends on query/array order alone. */
function rankOwnersForPorch(owners) {
  return [...(owners ?? [])].sort((a, b) => {
    const ta = a?.type === 'feature_article' ? 0 : 1;
    const tb = b?.type === 'feature_article' ? 0 : 1;
    if (ta !== tb) return ta - tb;
    const ua = Date.parse(a?.updated_at ?? '');
    const ub = Date.parse(b?.updated_at ?? '');
    return (Number.isFinite(ub) ? ub : -Infinity) - (Number.isFinite(ua) ? ua : -Infinity);
  });
}

/** The hazard's clipped substance, given a total byte budget for TRIGGER +
 *  RIGHT WAY combined: split evenly, trigger first (so a very short trigger
 *  never starves right_way of budget it did not use). */
function porchHazardBody(hazard, textBudgetBytes) {
  const half = Math.max(0, Math.floor(textBudgetBytes / 2));
  const trigger = clipToBytes(hazard?.trigger, half);
  const rightBudget = Math.max(0, textBudgetBytes - porchByteLen(trigger));
  const rightWay = clipToBytes(hazard?.right_way, rightBudget);
  return [`  TRIGGER: ${trigger}`, `  RIGHT WAY: ${rightWay}`].join('\n');
}

/** The porch-end line's SUBJECT STAGING clause — whole-block POST-CAP ACTUALS
 *  (decision 0050a536 §5 amendment 2026-09-08, evidence 5d2a527f). A caller
 *  with no subject channel at all (the tool-time hook) states `none` rather
 *  than a hazard/pointer count that was never computed; a caller that DOES
 *  stage a subject channel (SubagentStart) always states its two RENDERED
 *  (post-cap) counts, even when both are zero — the earlier `0 decision
 *  pointer(s)` reading as a contradiction against the path-channel count on the
 *  SAME line was exactly the LOW finding this amendment answers, so the two
 *  channels' counts are now labelled separately rather than sharing one bare
 *  number. */
function subjectStagingClause({ hasSubjectChannel, subjectHazardCount, subjectDecisionPointerCount }) {
  return hasSubjectChannel ? `${subjectHazardCount} hazard(s) / ${subjectDecisionPointerCount} decision pointer(s)` : 'none';
}

/** The porch-end line's ARTICLE-BODY / REFERENCE-POINTER clause (roster
 *  reviewer, same round as the porch's Codex review: a reference_material
 *  owner renders as ONE POINTER LINE via renderReference below, never an
 *  article body — folding it into `articleBodiesCount` made the porch-end
 *  line's own self-report disagree with what actually renders, the exact
 *  self-report-vs-reality defect clause (5) exists to prevent). `K article
 *  body(ies)` covers feature_article owners only; `referencePointerCount`
 *  (R) renders its own trailing clause and is OMITTED ENTIRELY at 0, rather
 *  than stating "0 reference pointer(s)" as noise on the common case where
 *  every owner is a full article. */
function articleBodiesClause({ articleBodiesCount, referencePointerCount = 0 }) {
  return referencePointerCount > 0
    ? `${articleBodiesCount} article body(ies) / ${referencePointerCount} reference pointer(s)`
    : `${articleBodiesCount} article body(ies)`;
}

function porchEndLine(byteCountText, meta) {
  const { pathDecisionPointerCount } = meta;
  return (
    `▸ PORCH END (${byteCountText} bytes) — followed by ${articleBodiesClause(meta)}; ` +
    `path channel: ${pathDecisionPointerCount} decision pointer(s); subject staging: ${subjectStagingClause(meta)}. ` +
    `If this context was shown TRUNCATED with a persisted-file path, open that file before reasoning or ` +
    `acting; normal instruction precedence applies.`
  );
}

/** The MINIMAL-porch fallback (Codex review, HIGH item B): when even the
 *  smallest possible skeleton for THIS call's real header/hazards/owners
 *  (zero admitted owners, every hazard scaffold at zero clipped text) still
 *  exceeds `budget`, no amount of clipping or clamping produces a sensible
 *  preview — the correct answer is not a clamped fragment (which silently
 *  drops the owner disclosure and the porch-end line, exactly the HIGH
 *  finding that motivated this) but a SHORT, COMPLETE porch that states the
 *  shortfall plainly and defers everything — hazards INCLUDED — to the full,
 *  unclipped remainder below (the caller renders hazards itself in this case;
 *  see `hazardsRendered` on renderPorch's return). Reuses the EXACT SAME
 *  "+N owners below" line the normal cascade uses (never a second spelling),
 *  and folds the shortfall into ONE porch-end-shaped line so there is still
 *  exactly one line a caller's own porch-end detector will find. */
function porchDeferredEndLine(byteCountText, hazardCount, budget, meta) {
  const { pathDecisionPointerCount } = meta;
  return (
    `▸ PORCH END (${byteCountText} bytes) — budget (${budget}) too small to preview ${hazardCount} hazard(s); deferred in full below. ` +
    `Followed by ${articleBodiesClause(meta)}; path channel: ${pathDecisionPointerCount} decision pointer(s); ` +
    `subject staging: ${subjectStagingClause(meta)}. normal instruction precedence applies.`
  );
}

/** The PORCH's OWN header line — same wording as payloadHeaderLine, but the
 *  path-list portion is bounded to PORCH_HEADER_PATH_CLIP_BYTES, with an
 *  in-progress '…' plus a '(+N paths)' tail when whole path segments had to
 *  be dropped to fit. Whole segments are kept where possible (never split one
 *  path's bytes mid-string); only when even the FIRST segment alone overflows
 *  the clip budget does this fall back to a byte-safe clip of the joined
 *  text. `rels` is the ARRAY the caller already has (not a pre-joined
 *  string), so the '+N paths' count is exact. The REMAINDER's own header
 *  (renderPayload, via payloadHeaderLine) is a SEPARATE call and stays fully
 *  unclipped — only the porch, which is budget-bounded, needs this. */
export function porchHeaderLine(rels) {
  const list = Array.isArray(rels) ? rels : [rels];
  const full = list.join(', ');
  if (porchByteLen(full) <= PORCH_HEADER_PATH_CLIP_BYTES) return payloadHeaderLine(full);
  const kept = [];
  let usedBytes = 0;
  for (const r of list) {
    const sepBytes = kept.length ? porchByteLen(', ') : 0;
    const rBytes = porchByteLen(r);
    if (usedBytes + sepBytes + rBytes > PORCH_HEADER_PATH_CLIP_BYTES) break;
    kept.push(r);
    usedBytes += sepBytes + rBytes;
  }
  const remainder = list.length - kept.length;
  const clippedList = kept.length
    ? `${kept.join(', ')}${remainder > 0 ? ` … (+${remainder} paths)` : ''}`
    : clipToBytes(full, PORCH_HEADER_PATH_CLIP_BYTES); // even the first segment alone overflows — byte-safe clip
  return payloadHeaderLine(clippedList);
}

/** Fixed byte cost of the payload header TEMPLATE with an EMPTY `rel` — used
 *  only to derive PORCH_MIN_BUDGET_BYTES below, and DELIBERATELY the MINIMAL
 *  (not worst-case-clipped-width) header cost — the same reasoning
 *  PORCH_MINIMAL_HAZARD_SCAFFOLD_BYTES used to carry for the hazard side
 *  before hazard floor was dropped from this floor entirely: PORCH_MIN_
 *  BUDGET_BYTES is a cheap, generic SANITY floor over the CONFIG VALUE, not a
 *  guarantee that covers a genuinely long real `rel` — that case is handled
 *  per-call, with the REAL (now bounded via porchHeaderLine) header, by the
 *  `skeletonBytes > budget` check inside renderPorch below, which degrades to
 *  the MINIMAL porch rather than inflating this floor and misclassifying an
 *  ordinary short-path, tight-but-workable budget as misconfigured. */
const PORCH_HEADER_TEMPLATE_BYTES = porchByteLen(payloadHeaderLine(''));

/** The porch-end line's own template cost: a representative two-digit
 *  K/M/N/P/R (a delivery serving 99+ article bodies, reference pointers or
 *  decision pointers is already far past every existing cap in this
 *  mechanism) and its longer subject-staging spelling (the two-count "N
 *  hazard(s) / P decision pointer(s)" form is longer than the
 *  caller-has-no-subject-channel 'none' spelling) PLUS the reference-pointer
 *  clause (longer than its own omitted-at-zero form) — the template must be
 *  the LONGEST either line can render, never the common case, or a real call
 *  with a reference owner could exceed a floor sized without one. */
const PORCH_END_TEMPLATE_BYTES = porchByteLen(
  porchEndLine(PORCH_BYTE_COUNT_RESERVE, {
    articleBodiesCount: 99,
    referencePointerCount: 99,
    pathDecisionPointerCount: 99,
    hasSubjectChannel: true,
    subjectHazardCount: 99,
    subjectDecisionPointerCount: 99,
  })
);

/** The smallest `preview_budget_bytes` at which a porch can ALWAYS host its
 *  own MINIMAL boilerplate (Codex review, HIGH item B) — COMPUTED from the
 *  templates above, never a guessed round number: the header template (real
 *  `rel` text only ever adds bytes) plus the porch-end line's own template and
 *  the separator between them. NO hazard/owner allowance is folded in here —
 *  that is exactly what the MINIMAL-PORCH fallback above exists for, so this
 *  floor only needs to cover the smallest thing a porch can EVER be (header +
 *  one porch-end-shaped line). A configured budget below this can never host
 *  even that, so it is treated as MISCONFIGURED — the porch is disabled
 *  outright (today's pre-porch rendering applies) rather than attempted and
 *  clamped. A budget ABOVE this floor that still cannot host a SPECIFIC
 *  call's full cascade (real hazards/owners) degrades to the MINIMAL porch
 *  instead (see `skeletonBytes > budget` below) — the two checks compose:
 *  this one catches an unusable CONFIG VALUE, that one catches a call whose
 *  real DATA cannot fit even though the config value itself is sane. */
export const PORCH_MIN_BUDGET_BYTES = PORCH_HEADER_TEMPLATE_BYTES + 2 + PORCH_END_TEMPLATE_BYTES;

/** THE PORCH BUDGET (config.delivery.preview_budget_bytes) — ONE resolver, now
 *  shared by every porch caller (decision 0050a536 §5 amendment 2026-09-08:
 *  the porch extends from SubagentStart to h19-knowledge-delivery.mjs's
 *  direct-inject rungs, and the consolidation rule holds — one source, not a
 *  second hand-copied reader). Measured default 1800: the inline preview
 *  Claude Code 2.1.263 shows before spilling the rest of a hook's
 *  additionalContext to a persisted file (research_finding 518b7d21) — a
 *  platform fact, re-probe on upgrade. 0 DISABLES the porch.
 *
 *  THREE-STATE GUARD (same shape as h1-session-start.mjs's configUnreadable
 *  guard, anti_pattern e0d280ee) — EXCEPT this value is never RENDERED as a
 *  claim about the project the reader could be misled by, it is only an
 *  internal rendering parameter, so every unusable shape (absent, unparseable,
 *  non-object, non-integer, negative) collapses to the SAME documented
 *  default rather than a distinct UNKNOWN state — there is nothing here for a
 *  divergence to be dishonest ABOUT.
 *
 *  LOW (roster reviewer, consolidation round): this resolver's own catch is a
 *  SECOND line of defense, not the ONLY one — both current callers already
 *  reach a hard config-read failure earlier in their own try/catch (the
 *  tddPostureLine/activePlanLine reads in h19-dispatch-staging.mjs; the
 *  charCap read in h19-knowledge-delivery.mjs) before this resolver ever runs,
 *  so a genuinely unreadable config is caught upstream of the porch. A future
 *  caller that reaches `resolvePorchBudget` WITHOUT first surviving its own
 *  config read would still get PORCH_BUDGET_DEFAULT here, but two things that
 *  depend on the upstream catch having already fired would degrade: the
 *  shared-fate suppression pattern this file's hooks use (a config throw is
 *  meant to be visible ONCE, at the earliest read, not swallowed silently at
 *  every subsequent optional-chained call), and the MISCONFIGURED/deferred
 *  porch-end line's own `budget (${budget})` disclosure, which would then
 *  report the SILENT fallback value rather than the value that actually
 *  failed to parse. */
export const PORCH_BUDGET_DEFAULT = 1800;
export function resolvePorchBudget(cwd) {
  try {
    const cfg = loadConfig(cwd);
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) return PORCH_BUDGET_DEFAULT;
    const v = cfg?.delivery?.preview_budget_bytes;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return PORCH_BUDGET_DEFAULT;
    return v;
  } catch {
    return PORCH_BUDGET_DEFAULT;
  }
}

/** Render the SubagentStart porch: a bounded PREFIX of the complete
 *  additionalContext (see the file-header comment above for the full design).
 *
 *  RETURNS `{ text, hazardsRendered }`, never a bare string — `text` is ''
 *  when there is nothing to show (no hazards and no owners), when `budget` is
 *  not a positive finite number, or when `budget` is below the structural
 *  MISCONFIGURED floor; `hazardsRendered` is true only when this porch itself
 *  rendered the hazards' substance. The CALLER MUST check `hazardsRendered`:
 *  false means the porch either doesn't exist (`text === ''`) or exists but
 *  deliberately DEFERRED hazard substance to the remainder (the MINIMAL-porch
 *  fallback, `skeletonBytes > budget` below) — in either case the caller's
 *  OWN renderHazards call is what must run, or the hazards are lost. This is
 *  the one piece of this contract a bare string could not express.
 *
 *  `hazards`/`owners` are the FRESH (unrendered) arrays — this function applies
 *  its own severity cap (cappedHazards, HAZARD_CAP) and owner rank/cap
 *  (PORCH_OWNER_CAP) internally, exactly mirroring what the REMAINDER (the
 *  caller's own renderHazards/renderArticle calls) will do for hazards, and
 *  more narrowly than the remainder for owners (every owner still gets its
 *  full render afterward, porch-admitted or not).
 *
 *  `articleBodiesCount` (K, path channel, feature_article owners ONLY) /
 *  `referencePointerCount` (R, path channel, reference_material owners —
 *  roster reviewer finding: a reference owner renders as ONE POINTER LINE via
 *  renderReference below, never an article body, so folding it into K made
 *  the porch-end line's own self-report disagree with what actually renders)
 *  / `pathDecisionPointerCount` (M, path channel) / `hasSubjectChannel` +
 *  `subjectHazardCount` (N) + `subjectDecisionPointerCount` (P) describe what
 *  the CALLER will render AFTER the porch, as whole-block POST-CAP ACTUALS
 *  (decision 0050a536 §5 amendment) — the porch does not compute these
 *  itself, since the subject-channel block (when the caller has one at all)
 *  is assembled entirely outside this function's view. A caller with no
 *  subject channel (the tool-time hook) passes `hasSubjectChannel: false` and
 *  the porch-end line states `subject staging: none` rather than a count that
 *  was never computed; `referencePointerCount` omitted (or 0) renders no
 *  reference clause at all, rather than a noisy "0 reference pointer(s))" on
 *  the common all-article case.
 *
 *  `fileKeys` (consolidation, decision 6f3e334c): the path(s) this touch
 *  governs — needed ONLY to build the hazard-overflow widening query in the
 *  SAME shape renderHazards emits (`knowledge_query types:["anti_pattern"]
 *  file_keys:[…] cap:N`) when the porch itself caps hazards away. Omitted
 *  (or `[]`), the widening query names no path — callers that always have a
 *  path (both current callers) must pass it, or the overflow line silently
 *  degrades to an unrunnable empty file_keys list. */
export function renderPorch(
  header,
  hazards,
  owners,
  budget,
  {
    articleBodiesCount = 0,
    referencePointerCount = 0,
    pathDecisionPointerCount = 0,
    hasSubjectChannel = false,
    subjectHazardCount = 0,
    subjectDecisionPointerCount = 0,
    fileKeys = [],
  } = {}
) {
  if (!Number.isFinite(budget) || budget <= 0) return { text: '', hazardsRendered: false, deferred_hazard_ids: cappedHazards(hazards ?? []).map((hazard) => hazard.id) };
  // ACCEPTED (Codex review, item C): a touch whose only fresh knowledge is
  // decision pointers (zero hazards, zero owners) gets no porch — a decision-
  // pointer block is a handful of capped one-line pointers (DECISION_POINTER_
  // CAP = 8) and cannot itself spill past the harness's inline preview, so
  // there is nothing here for a porch to protect. The caller only ever
  // builds a porch when freshOwners.length || freshHazards.length ||
  // freshDecisions.length is true, so this branch IS reachable (a decision-
  // only touch) — it is a real, intended no-op, not dead code.
  if (!hazards?.length && !owners?.length) return { text: '', hazardsRendered: false, deferred_hazard_ids: [] };

  // MISCONFIGURED BUDGET (Codex review, HIGH item B, first half): a budget
  // below the structural minimum can never host even the smallest real
  // porch — attempting one would only ever produce a clamped fragment or an
  // empty string with no diagnosis. Disable the porch outright (today's
  // pre-porch rendering applies) and disclose the shortfall loudly, once,
  // rather than silently.
  if (budget < PORCH_MIN_BUDGET_BYTES) {
    try {
      process.stderr.write(
        `H19 porch: preview_budget_bytes=${budget} is below the structural minimum ${PORCH_MIN_BUDGET_BYTES} bytes — MISCONFIGURED, porch disabled for this touch (today's rendering applies)\n`
      );
    } catch {
      /* a failed stderr write must not change the already-decided outcome */
    }
    return { text: '', hazardsRendered: false, deferred_hazard_ids: cappedHazards(hazards ?? []).map((hazard) => hazard.id) };
  }

  const shownHazards = cappedHazards(hazards ?? []);
  const hazardOverflow = (hazards?.length ?? 0) - shownHazards.length;
  const rankedOwners = rankOwnersForPorch(owners);

  const endMeta = {
    articleBodiesCount,
    referencePointerCount,
    pathDecisionPointerCount,
    hasSubjectChannel,
    subjectHazardCount,
    subjectDecisionPointerCount,
  };
  const minOwnerCap = 0; // the ABSOLUTE invariant outranks the documented "reduce owners down to 1" — see file header

  // PER-CALL byte-count placeholder, sized from THIS budget (Codex review,
  // MEDIUM item 2) — PORCH_BYTE_COUNT_RESERVE's fixed 6-digit placeholder
  // assumed every budget stays under 1,000,000 bytes; a budget >= 1,000,000
  // bytes with >1MB of real bodies could assemble to a 7-digit count the
  // fixed reserve never budgeted for, understating the placeholder during
  // the fit-check and reproducing the same self-referential substitution
  // problem the convergence loop below exists to solve, one order of
  // magnitude up. The porch can never legitimately need more digits than the
  // budget it must not exceed, so `String(budget).length` is an exact bound,
  // not a guess — no reserve-outgrows-itself case survives this.
  const byteCountReserve = '0'.repeat(String(budget).length);

  // BUG THIS REPLACES (found via the frozen porch pins, decision 0050a536):
  // the previous "fixed lines" accounting counted ONLY header + owner pointer
  // lines + overflow + porch-end — it left every hazard's scaffold line
  // ("⚠ HAZARD [...] '<title>' (knowledge_get <id>)") and its "  TRIGGER: " /
  // "  RIGHT WAY: " label prefixes as UNCOUNTED overhead riding on top of
  // hazardShare, which only ever budgeted the CLIPPED TEXT. With HAZARD_CAP=3
  // that overhead (~100+ bytes per hazard) silently ate hundreds of bytes the
  // arithmetic never subtracted from anything, so the assembled porch
  // overran its budget and the final hard-clamp cut the string mid-word,
  // before ever reaching the owner-cap disclosure or the porch-end line.
  //
  // THE FIX: build a "SKELETON" — every block at its ZERO-clipped-text form
  // (hazard scaffolding + empty TRIGGER:/RIGHT WAY: values; owner pointer
  // lines with no digest) — through the EXACT SAME section builders and join
  // the final assembly uses, so its measured byte length already contains
  // every header, label, id, and separator with nothing left uncounted.
  // `remaining = budget - skeletonBytes` is then the true room left for
  // CLIPPED TEXT ALONE, and hazardShare + digestShare (drawn from it) can
  // never explain an overrun: total = skeletonBytes + real_clipped_bytes,
  // and real_clipped_bytes <= hazardShare + digestShare <= remaining by
  // construction of Math.floor division, so total <= budget.
  //
  // MEDIUM FIX (independent review, round 2): a SECOND uncounted-overhead bug
  // lived in the owner section specifically. The skeleton called
  // ownerSectionAt(..., 0), which renders a BARE owner line (no digest, no
  // separator) whenever digestBudget is 0 — but the FINAL pass often has
  // perOwner > 0, and `${ownerLines[i]}\n  ${digest}` then adds a "\n  "
  // (3 bytes) per admitted owner that the skeleton never reserved. Measured
  // on a real 3-owner clipped-digest fixture: "▸ PORCH END (1803 bytes)"
  // against a budget of 1800 — a 3-byte overrun, one per admitted owner,
  // silently eaten by the label the skeleton assumed away. Fixed by
  // `reserveDigestSeparator`: the SKELETON pass now always reserves the
  // "\n  " bytes for every admitted owner (a 1-byte-placeholder-digest
  // equivalent, per the review's own suggested alternative), so the real
  // pass can never add bytes the skeleton did not already count — at worst
  // the skeleton over-reserves by 3 bytes for an owner whose final digest
  // happens to clip to nothing, which is conservative, never an overrun.
  function hazardSectionAt(perHazardTextBudget) {
    const blocks = shownHazards.map((hazard) => {
      const whole = completePorchHazards([hazard])[0];
      return porchByteLen(whole) <= perHazardTextBudget
        ? whole
        : `⚠ HAZARD ${clipToBytes(hazard.slug ?? hazard.title ?? hazard.id, PORCH_SLUG_CLIP_BYTES)} (${String(hazard.id).slice(0, 8)}) continues in full below`;
    });
    if (hazardOverflow > 0) {
      // THE SAME OVERFLOW DISCLOSURE renderHazards EMITS (consolidation,
      // decision 6f3e334c: hazards are substance, rendered the SAME WAY
      // wherever they appear) — dropped count + the file_keys-scoped
      // widening query, never a porch-only phrasing. `hazards.length` is the
      // FULL total (the outer, unrendered array), matching what renderHazards
      // would report as `fullTotal` for the identical array. The file_keys
      // list renders as a byte-bounded, JSON-safe literal (clippedFileKeysLiteral)
      // — never a raw clip over the pre-joined string, which can sever a
      // closing quote mid-entry or leave an unescaped quote/backslash inside a
      // filename unrunnable — and a drop is disclosed, never silent (this
      // fixed line is counted in the skeleton like every other, since
      // hazardSectionAt(0) — the skeleton pass — includes it unconditionally,
      // independent of the per-hazard text budget argument).
      const widen = `knowledge_query types:["anti_pattern"] file_keys:${clippedFileKeysLiteral(fileKeys, PORCH_WIDENING_KEYS_CLIP_BYTES)} cap:${hazards.length}`;
      blocks.push(`… ${hazardOverflow} more hazard(s) NOT shown (cap ${HAZARD_CAP}) — ${widen} for the full set`);
    }
    return blocks;
  }
  function ownerSectionAt(admitted, ownerLines, overflowLine, perOwnerDigestBudget, { reserveDigestSeparator = false } = {}) {
    const blocks = admitted.map((owner, i) => {
      const digestBudget = Math.max(0, perOwnerDigestBudget);
      const digest = digestBudget > 0 ? clipToBytes(owner?.what_it_does, digestBudget) : '';
      if (digest) return `${ownerLines[i]}\n  ${digest}`;
      // Reserve the SAME "\n  " bytes a real (non-empty) digest would cost,
      // even though this measurement pass has none — see the MEDIUM fix note
      // above. Never emitted in the FINAL pass (reserveDigestSeparator is
      // only ever true for the skeleton), so the real output never shows a
      // trailing blank digest line.
      return reserveDigestSeparator ? `${ownerLines[i]}\n  ` : ownerLines[i];
    });
    if (overflowLine) blocks.push(overflowLine);
    return blocks;
  }

  // Choose the LARGEST owner cap (PORCH_OWNER_CAP down to minOwnerCap) whose
  // SKELETON (header + hazard scaffolding at zero text + admitted owner
  // pointer lines at zero digest, WITH the digest separator reserved + overflow
  // line + porch-end) leaves room for at least the hazard floor — i.e. reduce
  // owners first, exactly as the design states.
  let pick = null;
  for (let cap = Math.min(PORCH_OWNER_CAP, rankedOwners.length); cap >= minOwnerCap; cap -= 1) {
    const admitted = rankedOwners.slice(0, cap);
    const ownerOverflow = rankedOwners.length - admitted.length;
    const ownerLines = admitted.map(porchOwnerLine);
    const overflowLine = ownerOverflow > 0 ? `  … +${ownerOverflow} owners below` : '';
    const skeletonBody = [
      header,
      ...hazardSectionAt(0),
      ...ownerSectionAt(admitted, ownerLines, overflowLine, 0, { reserveDigestSeparator: true }),
    ].join('\n\n');
    const skeletonBytes = porchByteLen(skeletonBody) + 2 + porchByteLen(porchEndLine(byteCountReserve, endMeta));
    const remaining = Math.max(0, budget - skeletonBytes);
    const fits = skeletonBytes <= budget;
    pick = { admitted, ownerOverflow, ownerLines, overflowLine, remaining, skeletonBytes };
    if (fits || cap === minOwnerCap) break;
  }

  const { admitted, ownerLines, overflowLine, remaining, skeletonBytes } = pick;

  // STRUCTURALLY IMPOSSIBLE FOR THIS CALL (Codex review, HIGH item B, second
  // half): budget cleared PORCH_MIN_BUDGET_BYTES (so it is not a bare
  // misconfiguration), yet even the SMALLEST skeleton this specific call can
  // produce — zero admitted owners, every hazard scaffold at zero clipped
  // text — still exceeds it (a long `rel`, more hazards than a generic floor
  // assumed, or simply many owners to disclose). No amount of clipping fixes
  // a skeleton that already overruns before a single byte of clippable text
  // is considered, so the answer is the documented MINIMAL porch: the header,
  // the SAME "+N owners below" line the normal cascade uses (now naming EVERY
  // owner, since none are admitted), and ONE porch-end-shaped line stating the
  // shortfall — never a clamped fragment. Hazards are DEFERRED to the
  // remainder here (`hazardsRendered: false`), which the caller must render
  // itself — see this function's own doc comment.
  if (skeletonBytes > budget) {
    const allOwnersOverflow = rankedOwners.length > 0 ? `  … +${rankedOwners.length} owners below` : '';
    // Byte-converged assembly, PARAMETERISED on the header — a very tight
    // budget combined with a long (though already porchHeaderLine-clipped)
    // path can still leave no room for the fixed disclosure lines alongside
    // the full-width header (Codex re-check: measured 639 bytes against a
    // 600-byte budget with an ~1.6KB governed path). Retried below with a
    // FURTHER-clipped header rather than falling straight to the hard clamp,
    // so "the header is wide" degrades the header, never the sentence.
    function buildMinimal(hdr) {
      const blocks = [hdr, allOwnersOverflow].filter(Boolean);
      let cnt =
        blocks.reduce((sum, l) => sum + porchByteLen(l) + 2, 0) +
        porchByteLen(porchDeferredEndLine(byteCountReserve, shownHazards.length, budget, endMeta));
      let text = [...blocks, porchDeferredEndLine(String(cnt), shownHazards.length, budget, endMeta)].join('\n\n');
      for (let i = 0; i < 5; i += 1) {
        const actual = porchByteLen(text);
        if (actual === cnt) break;
        cnt = actual;
        text = [...blocks, porchDeferredEndLine(String(cnt), shownHazards.length, budget, endMeta)].join('\n\n');
      }
      return text;
    }
    let minimalPorch = buildMinimal(header);
    if (porchByteLen(minimalPorch) > budget) {
      // Concatenation is byte-additive, so the bytes NOT contributed by the
      // header are exactly this difference — clip the header down to
      // whatever room is left for it specifically, then rebuild (which
      // re-converges the byte count for the new, shorter total).
      const nonHeaderBytes = porchByteLen(minimalPorch) - porchByteLen(header);
      minimalPorch = buildMinimal(clipToBytes(header, Math.max(0, budget - nonHeaderBytes)));
    }
    // Even the MINIMAL porch (now with its header degraded too) is a
    // byte-safe absolute last resort — see the matching note on the normal
    // path's own final clamp below.
    if (porchByteLen(minimalPorch) > budget) {
      try {
        process.stderr.write(
          `H19 porch: accounting regression in the MINIMAL fallback — assembled ${porchByteLen(minimalPorch)} bytes against a ${budget}-byte budget — hard-clamping\n`
        );
      } catch {
        /* a failed stderr write must not change the clamp outcome */
      }
      return { text: clipToBytes(minimalPorch, budget), hazardsRendered: false, deferred_hazard_ids: shownHazards.map((hazard) => hazard.id) };
    }
    return { text: minimalPorch, hazardsRendered: false, deferred_hazard_ids: shownHazards.map((hazard) => hazard.id) };
  }

  // 60/40 hazards/digests, redistributed toward the hazard floor first (borrow
  // from digest), then 100% to whichever axis exists alone.
  const haveHazards = shownHazards.length > 0;
  const haveDigests = admitted.length > 0;
  let hazardShare = 0;
  let digestShare = 0;
  if (haveHazards && haveDigests) {
    hazardShare = Math.floor(remaining * PORCH_HAZARD_SHARE);
    digestShare = remaining - hazardShare;
    const neededFloor = shownHazards.length * PORCH_HAZARD_FLOOR_BYTES;
    if (hazardShare < neededFloor) {
      const borrow = Math.min(digestShare, neededFloor - hazardShare);
      hazardShare += borrow;
      digestShare -= borrow;
    }
  } else if (haveHazards) {
    hazardShare = remaining;
  } else if (haveDigests) {
    digestShare = remaining;
  }

  const perHazard = shownHazards.length ? Math.floor(hazardShare / shownHazards.length) : 0;
  const perOwner = admitted.length ? Math.floor(digestShare / admitted.length) : 0;
  const hazardBlocks = hazardSectionAt(perHazard);
  const ownerBlocks = ownerSectionAt(admitted, ownerLines, overflowLine, perOwner);

  const body = [header, ...hazardBlocks, ...ownerBlocks].join('\n\n');

  // THE PORCH-END LINE MUST STATE THE BYTE COUNT OF THE PORCH AS EMITTED
  // (independent review, MEDIUM fix item 2). Substituting a real (usually
  // narrower) digit string for byteCountReserve's placeholder changes the
  // line's OWN length, which changes the true total — so a single
  // placeholder-then-substitute pass states a number that is no longer true
  // of the string it appears in. This is a genuine fixed-point (count =
  // byteLength of a string that itself contains `count`), so it is SOLVED by
  // iterating: reassemble with the last computed count as the new candidate
  // and re-measure, until the stated count matches the assembled length.
  // Bounded at a handful of iterations — the digit width can only shift once
  // or twice (e.g. 999 -> 1000) before it is stable, never unboundedly, since
  // porchByteLen(body) is fixed and only the count's own digit count can move
  // the total; byteCountReserve is sized from `budget` itself (see above), so
  // the placeholder can never be narrower than any count this loop could ever
  // legitimately produce.
  let count = porchByteLen(body) + 2 + porchByteLen(porchEndLine(byteCountReserve, endMeta));
  let finalPorch = [body, porchEndLine(String(count), endMeta)].join('\n\n');
  for (let i = 0; i < 5; i += 1) {
    const actual = porchByteLen(finalPorch);
    if (actual === count) break;
    count = actual;
    finalPorch = [body, porchEndLine(String(count), endMeta)].join('\n\n');
  }

  // Absolute safety net: the cascade above is designed to hold the invariant
  // unconditionally and to be UNREACHABLE on every real dispatch, but a hard
  // byte-safe clip closes the gap for any input the cascade did not
  // anticipate rather than let the invariant depend on that being exhaustive.
  // LOUD, NEVER SILENT (independent review, item 3): if this ever fires, the
  // arithmetic above it failed to hold its own invariant — that is an
  // accounting REGRESSION, not a normal degrade path, so it is disclosed on
  // stderr naming the overrun rather than swallowed.
  const finalBytes = porchByteLen(finalPorch);
  if (finalBytes > budget) {
    try {
      process.stderr.write(
        `H19 porch: accounting regression — assembled porch is ${finalBytes} bytes against a ${budget}-byte budget ` +
          `(overrun ${finalBytes - budget} bytes); the cascade above should have made this unreachable — hard-clamping\n`
      );
    } catch {
      /* a failed stderr write must not change the clamp outcome */
    }
    return { text: clipToBytes(finalPorch, budget), hazardsRendered: false, deferred_hazard_ids: shownHazards.map((hazard) => hazard.id) };
  }
  const deferred_hazard_ids = shownHazards.filter((hazard, index) => !finalPorch.includes(completePorchHazards([hazard])[0])).map((hazard) => hazard.id);
  return { text: finalPorch, hazardsRendered: deferred_hazard_ids.length === 0, deferred_hazard_ids };
}

/** The owned-territory header line — factored out (was inlined in
 *  renderPayload) so the SubagentStart porch (renderPorch below) can lead
 *  with the IDENTICAL line renderPayload uses, rather than a second hand-
 *  copied string the two could drift apart on. */
// ---------------------------------------------------------------------------
// PER-DELIVERY TOTAL CAP (scale-down Slice 3c, decision
// sterling-claude-code-scale-down-boundary). payload_char_cap bounds one FIELD;
// nothing bounded a delivery as a whole, and one governed Read measured
// 13-17KB. Every delivery surface (H19 tool-time, Bash pointers, dispatch
// staging, H20) now assembles its blocks through capDeliveryParts: hazard
// blocks are PINNED (verbatim, never cut, but they do spend the budget);
// everything else is kept whole while it fits, then clipped at a line
// boundary with a pointer suffix, then reduced to its pointer. Nothing is
// dropped silently: a part with no pointer that cannot fit is counted in a
// trailing omission line.
// ---------------------------------------------------------------------------

/** Default total cap in UTF-8 bytes; config.delivery.total_cap_bytes overrides
 *  it (0 = no total cap). */
export const DELIVERY_TOTAL_CAP_DEFAULT = 3000;

/** Smallest clipped excerpt worth emitting ahead of a pointer. */
export const DELIVERY_EXCERPT_MIN_BYTES = 160;

export function resolveTotalCap(cwd) {
  try {
    const v = loadConfig(cwd)?.delivery?.total_cap_bytes;
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : DELIVERY_TOTAL_CAP_DEFAULT;
  } catch {
    return DELIVERY_TOTAL_CAP_DEFAULT;
  }
}

/** Keep whole lines while they fit `maxBytes`; if not even the first line
 *  fits, byte-clip it. */
function clipLinesToBytes(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const lines = String(text ?? '').split('\n');
  const out = [];
  let used = 0;
  for (const line of lines) {
    const cost = porchByteLen(line) + (out.length ? 1 : 0);
    if (used + cost > maxBytes) break;
    out.push(line);
    used += cost;
  }
  return out.length ? out.join('\n') : clipToBytes(lines[0], maxBytes);
}

/**
 * Decision 301d8a0a: each delivery part is either HAZARD (a complete
 * anti-pattern block) or ORDINARY (everything else). Hazards are whole and
 * unbudgeted; every ordinary byte, including separators and disclosures, is
 * within capBytes. This intentionally does not promise a total payload cap
 * when hazards exist, nor complete ordinary context.
 */
export function capDeliveryParts(parts, capBytes, { sep = '\n\n' } = {}) {
  const items = (parts ?? []).filter((part) => part && typeof part.text === 'string' && part.text).map((part) => ({ ...part, kind: part.kind === 'hazard' ? 'hazard' : 'ordinary' }));
  if (!capBytes || capBytes <= 0) return items.map((part) => part.text);
  const bytes = (text) => porchByteLen(text);
  const hazards = new Set(items.filter((part) => part.kind === 'hazard'));
  const selected = new Map();
  const omitted = [];
  const output = () => items.flatMap((part) => hazards.has(part) ? [part.text] : selected.has(part) ? [selected.get(part)] : []);
  const ordinaryBytes = () => {
    const text = output().join(sep);
    return Math.max(0, bytes(text) - [...hazards].reduce((sum, part) => sum + bytes(part.text), 0));
  };
  const fits = () => ordinaryBytes() <= capBytes;
  const pointerFor = (part) => part.pointer || '';

  for (const part of items) {
    if (part.kind === 'hazard') continue;
    selected.set(part, part.text);
    if (fits()) continue;
    selected.delete(part);

    const suffix = part.suffix || pointerFor(part);
    if (suffix) {
      const lines = part.text.split('\n');
      let clipped = '';
      let best = '';
      for (const line of lines) {
        const candidate = clipped ? `${clipped}\n${line}` : line;
        selected.set(part, `${candidate}\n${suffix}`);
        if (!fits()) {
          break;
        }
        clipped = candidate;
        best = `${candidate}\n${suffix}`;
      }
      if (best) {
        selected.set(part, best);
        continue;
      }
      selected.delete(part);
      selected.set(part, pointerFor(part));
      if (pointerFor(part) && fits()) continue;
      selected.delete(part);
    }
    omitted.push(part);
  }

  if (omitted.length) {
    const aggregatePart = { kind: 'ordinary', text: '' };
    items.push(aggregatePart);
    const aggregate = () => {
      const ids = [...new Set(omitted.flatMap((part) => [...String(part.pointer || part.text).matchAll(/knowledge_get\s+([^\s\])]+)/g)].map((match) => match[1].slice(0, 8))))];
      const prefix = `+${omitted.length} more records: knowledge_query`;
      let line = ids.length ? `${prefix}; knowledge_get ${ids.join(' ')}` : `${prefix}; knowledge_get`;
      while (ids.length && bytes(line) > capBytes) {
        ids.pop();
        line = ids.length ? `${prefix}; knowledge_get ${ids.join(' ')}` : `${prefix}; knowledge_get`;
      }
      return line;
    };
    while (true) {
      aggregatePart.text = aggregate();
      selected.set(aggregatePart, aggregatePart.text);
      if (fits()) break;
      selected.delete(aggregatePart);
      const last = [...items].reverse().find((part) => part !== aggregatePart && selected.has(part));
      if (!last) break;
      selected.delete(last);
      omitted.push(last);
    }
  }
  return output();
}

/** Split a porch only when its rendered hazard substrings are complete. */
export function partitionPorchHazards(text, hazardBlocks) {
  const blocks = (hazardBlocks ?? []).filter(Boolean);
  let cursor = 0;
  const parts = [];
  for (const block of blocks) {
    const at = text.indexOf(block, cursor);
    if (at < 0) return null;
    if (at > cursor) parts.push({ kind: 'ordinary', text: text.slice(cursor, at) });
    parts.push({ kind: 'hazard', text: block });
    cursor = at + block.length;
  }
  if (cursor < text.length) parts.push({ kind: 'ordinary', text: text.slice(cursor) });
  return parts;
}

/** Records whose FULL id appears in the emitted text — the only ones a caller
 *  may mark delivered (never mark delivered what the reader was not shown). */
export function recordsShownIn(text, records) {
  const t = String(text ?? '');
  return (records ?? []).filter((r) => r?.id && t.includes(r.id));
}

/** The capped-delivery pointer for an owning record: its rendered header line
 *  plus the full-record read. */
export function ownerPointer(rendered, record) {
  const head = String(rendered ?? '').split('\n')[0];
  return `${clipToBytes(head, 300)}\n▸ FULL RECORD (delivery cap reached): knowledge_get ${record.id}`;
}

export function ownerSuffix(record) {
  return `▸ FULL RECORD (clipped at the delivery cap): knowledge_get ${record.id}`;
}

/** Pointer for a decision block the cap cannot hold. */
export function decisionBlockPointer(count, widen) {
  return `▸ DECISIONS (${count}) held back by the delivery cap — ${widen}`;
}

export function payloadHeaderLine(rel) {
  return `STERLING KNOWLEDGE DELIVERY (H19) — owning knowledge for '${rel}'. Consult before designing or editing in this territory; the store is current reality AND rationale, the code is only the implementation.`;
}

export function renderPayload(rel, blocks, { unowned = false, substantiveCount } = {}) {
  const substantive = substantiveCount ?? blocks.length;
  return [unowned ? renderFrontier(rel, { hasOtherKnowledge: substantive > 0 }) : payloadHeaderLine(rel), ...blocks].join(
    '\n\n'
  );
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
/** The Bash pointer block, DECOMPOSED into `{header, lines}` where each line is
 *  keyed by the record id it describes (fixer F1). The drain needs per-record
 *  lines, not one pre-joined blob: to serve a still-active pointer verbatim while
 *  REPLACING a superseded one with a stub, it must know which line belongs to
 *  which id. `header` is producer chrome (two fixed sentences, no record field
 *  interpolated), which is why it can be replayed verbatim at drain.
 *
 *  `gapsByOwner` (board f1489964, optional — omitted callers/entries with no
 *  budgeted gap for an owner are byte-identical to before this addition): a
 *  `budgetKnownGaps` Map keyed by owner id. When an owner's id has an entry,
 *  its KNOWN GAPS lines (renderKnownGapsLines — the SAME shared renderer the
 *  Read/Edit path uses, never a divergent copy) attach to that owner's OWN
 *  pointer entry as a SEPARATE `gapLines` array (fixer round, board f1489964
 *  HIGH finding) — NEVER embedded into `line` via a joined newline. This hook
 *  ALWAYS enqueues, and the drain's rebuildPointerPayload unconditionally
 *  flattenToOneLine()s each entry's `line` (F4, a security property against
 *  record-derived text forging fake lines — never removed), so a newline
 *  smuggled into `line` would collapse the whole gap block into one run-on at
 *  drain, both losing the "one header line, no digit beside it" shape
 *  renderGapLine relies on. Carrying gapLines as its own array lets the drain
 *  render — and individually flatten (F4 preserved PER LINE) — each gap line
 *  on its own, only when that owner's drain verdict is LIVE.
 *
 *  Attached to the FIRST pointer entry for a given owner id only (fixer round
 *  MED finding): an owner reachable via two candidate paths in the same
 *  command must not render its gap block twice. `gapAttached` tracks that
 *  across the whole `entries` loop, not per-path. */
export function bashPointerBlock(entries, { gapsByOwner } = {}) {
  const header = [
    'STERLING KNOWLEDGE POINTERS (H19) — governed paths named in a Bash command.',
    'This is a POINTER, not the article: the store owns these paths, so read the record before you design or edit here.',
  ].join('\n');
  const lines = [];
  const gapAttached = new Set();
  for (const e of entries) {
    for (const h of e.hazards) {
      const hazardLabel = h.title && h.slug ? `${h.title} [${h.slug}]` : (h.title ?? h.slug ?? h.id);
      lines.push({
        id: h.id,
        line: `  • ${e.rel} — ⚠ HAZARD anti_pattern '${hazardLabel}' · knowledge_get ${h.id}${statusAnnotation(h)}`,
        hazard: true,
      });
    }
    for (const o of e.owners) {
      const kind = o.type === 'reference_material' ? 'reference' : 'article';
      const label = o.title && o.slug ? `${o.title} [${o.slug}]` : (o.slug ?? o.title ?? o.id);
      // `state` (article build state) and the status bracket are distinct facts
      // — see renderArticle's header comment.
      const state = o.state ? ` (${o.state})` : '';
      const line = `  • ${e.rel} — ${kind} '${label}'${state} · knowledge_get ${o.id}${statusAnnotation(o)}`;
      const entry = { id: o.id, line };
      const gapInfo = gapsByOwner?.get(o.id);
      if (gapInfo && !gapAttached.has(o.id)) {
        gapAttached.add(o.id);
        const gapLines = renderKnownGapsLines(o, gapInfo);
        if (gapLines.length) entry.gapLines = gapLines;
      }
      lines.push(entry);
    }
  }
  return { header, lines };
}

/** Dedup + total-cap a `{header, lines}` pointer block (scale-down Slice 3c).
 *  One line per record id (the first path naming it wins); records `skip(id)`
 *  says were already delivered this session are dropped; hazard lines are
 *  retained for queue recipe semantics; at drain, anti-pattern lines become
 *  complete hazard substance while ordinary owner lines are capped and disclosed
 *  in `tail`. capBytes <= 0 disables the cap (dedup still applies). */
export function capPointerBlock({ header, lines = [] } = {}, capBytes, { skip = () => false } = {}) {
  const seen = new Set();
  const kept = [];
  for (const l of lines) {
    if (!l?.id || seen.has(l.id) || skip(l.id)) continue;
    seen.add(l.id);
    kept.push(l);
  }
  if (!capBytes || capBytes <= 0) return { header, lines: kept, tail: '' };
  const lineBytes = (l) => [l.line, ...(Array.isArray(l.gapLines) ? l.gapLines : [])].reduce((n, x) => n + porchByteLen(x) + 1, 0);
  const TAIL_RESERVE = 160;
  let used = porchByteLen(header) + kept.filter((l) => l.hazard).reduce((n, l) => n + lineBytes(l), 0);
  const out = [];
  let held = 0;
  for (const l of kept) {
    if (l.hazard) {
      out.push(l);
      continue;
    }
    if (used + lineBytes(l) + TAIL_RESERVE <= capBytes) {
      out.push(l);
      used += lineBytes(l);
    } else held++;
  }
  const tail = held
    ? `  (+${held} more pointer line(s) held back by the ${capBytes}-byte delivery cap — knowledge_query the command's governed paths)`
    : '';
  return { header, lines: out, tail };
}

/** Join a `{header, lines, tail}` pointer block into the payload text. ONE
 *  definition (invariant 1) shared by both pointer producers and by the payload
 *  they cache for the drain's fail-open arm. Each entry's optional `gapLines`
 *  (board f1489964) render as their OWN lines directly beneath `line`, never
 *  joined into it — the enqueue-time cached payload keeps the same one-line-
 *  per-array-element shape the drain now rebuilds from `gap_lines`. */
export function joinPointerBlock({ header, lines = [], tail } = {}) {
  const body = [];
  for (const l of lines) {
    body.push(l.line);
    if (Array.isArray(l.gapLines)) body.push(...l.gapLines);
  }
  return [header, ...body, ...(tail ? [tail] : [])].filter((s) => typeof s === 'string' && s).join('\n');
}

export function renderBashPointers(entries) {
  return joinPointerBlock(bashPointerBlock(entries));
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
