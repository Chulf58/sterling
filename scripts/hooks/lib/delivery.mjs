// H19 knowledge-delivery plumbing (decision foreign_6dfbe675, concept family
// knowledge-delivery): guard ledger, notice state, payload rendering.
// Transient, session-lifecycle-bound (P4): guard files live below a directory
// named for their Claude session. h19-clear-session removes only the current
// session's directory on compaction; a new session selects a new directory.
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



/** A path component derived from an externally supplied Claude session id.
 *  Percent encoding keeps separators and traversal syntax out of the
 *  filesystem path; dot-only components are additionally encoded. */
export function sanitizeSessionId(sessionId) {
  // encodeURIComponent THROWS URIError on a lone surrogate. An unparseable id
  // is an ABSENT id, not a crash: returning null routes it to the same
  // disclosed no-dedup path as a missing one (P5 — degrade loud, not fatal).
  let encoded;
  try { encoded = encodeURIComponent(String(sessionId)); }
  catch { return null; }
  if (!encoded) return '%00';
  return encoded === '.' ? '%2E' : encoded === '..' ? '%2E%2E' : encoded;
}

/** The per-session delivery directory, or null when there is no session
 *  identity. There is deliberately NO flat-path fallback: sharing a guard
 *  between sessions would restore the cross-session suppression defect. */
export function deliverySessionDir(cwd, sessionId) {
  const normalizedSessionId = sessionId == null ? '' : String(sessionId);
  if (!normalizedSessionId) {
    process.stderr.write('H19: session_id missing — delivery deduplication disabled; guard will not be read or written\n');
    return null;
  }
  const component = sanitizeSessionId(normalizedSessionId);
  if (component === null) {
    process.stderr.write('H19: session_id is not encodable — delivery deduplication disabled; guard will not be read or written\n');
    return null;
  }
  return join(deliveryDir(cwd), component);
}

/** Per-agent guard: which records were delivered in this session and context.
 *  The conductor (no agent_id) and every subagent get their own file below the
 *  session directory, mirroring H13's per-agent read ledgers. */
export function guardPath(cwd, agentId, sessionId) {
  const dir = deliverySessionDir(cwd, sessionId);
  return dir ? join(dir, agentId ? `guard-agent-${agentId}.json` : 'guard-conductor.json') : null;
}

/** GUARD SCHEMA VERSION 2 (decision 92088a62, delivery-migration step 3): the
 *  flat `records`/`slugs` ledger is replaced by TWO revision-keyed ledgers,
 *  `substance` and `discovery` (each `[{id, revision}]`) — a record shown only
 *  as a pointer/discovery must still qualify for a later FULL delivery, and a
 *  record whose content changed (a forward-fix `knowledge_update`, which bumps
 *  `updated_at` without minting a new id) must qualify again rather than
 *  staying silently suppressed by a stale lineage mark. This is a BUMP, not a
 *  migration: an old-shape guard on disk simply resets to empty (see
 *  `readGuard`) — a lost mark this session costs at most one duplicate
 *  delivery, which decision 92088a62 rules acceptable; a false 'delivered'
 *  mark is not. */
export const DELIVERY_GUARD_VERSION = 2;

/** The guard's declared shape. `pointer_files` is a SEPARATE namespace from
 *  `substance`/`discovery` on purpose: a Bash pointer must never consume the
 *  record's full-article guard entry, or pointing at a path would silently
 *  suppress the real delivery on a later Read of it — a pointer would then
 *  COST knowledge instead of adding it. Pointers dedupe per FILE; records
 *  dedupe per (id, revision). `gap_articles` (board f1489964) is a FOURTH,
 *  independent namespace: the bash/probe-output seam's own known_gaps
 *  re-emission dedup, keyed per ARTICLE lineage (see `lineageKey`) and
 *  deliberately separate from `pointer_files` (would starve the pointer line
 *  itself) and from `substance`/`discovery` (the Read-path record guard —
 *  riding it would either silently suppress the bash re-emission after an
 *  unrelated Read, or vice versa; the board asks for this seam's OWN bounded
 *  dedup). */
export function emptyDeliveryGuard() {
  return { version: DELIVERY_GUARD_VERSION, substance: [], discovery: [], frontier_files: [], pointer_files: [], gap_articles: [] };
}

/** The lineage key for a record: its slug when it has one (feature_article,
 *  reference_material — stable across a knowledge_update supersede, which
 *  mints a NEW id for the SAME slug), else its id (decision/anti_pattern have
 *  no slug, so id-churn IS lineage-churn for them — a genuinely different
 *  record, not a reconcile of the same one). Used ONLY by the gap_articles
 *  seam now — the substance/discovery ledgers key on (id, revision) instead,
 *  see `recordRevision`. */
export function lineageKey(record) {
  return record?.slug ?? record?.id;
}

/** THE REVISION a record carries for guard-keying purposes (decision 92088a62
 *  STATE clause) — a forward-fix (`knowledge_update` in place, same id,
 *  CLAUDE.md's documented "fix forward" pattern) must re-qualify the record
 *  for delivery rather than staying silently suppressed by a mark minted
 *  against the wrong content.
 *
 *  KEYED PRIMARILY ON `version` (fix-round HIGH 3): every record — not only
 *  feature_article, whose zod schema happens to also expose it as a BODY
 *  field — carries a STORE-MANAGED `version` integer column (`records.version`
 *  DEFAULT 1, packages/store/src/index.ts), bumped by exactly 1 on every
 *  `updateRecord`/`knowledge_update` (`nextVersion = identity.version + 1`)
 *  and mirrored into the body `decodeLiveRecordRow` returns — so `record.
 *  version` is populated and strictly monotonic for EVERY type (measured:
 *  `store.create({type:'anti_pattern', ...})` returns `version: 1` with no
 *  `version` field in that type's own schema). `updated_at`, by contrast, is
 *  NOT store-stamped on an update — the row's `updated_at` "comes from the
 *  CANDIDATE BODY" (store/src/index.ts:1872), so a caller that resubmits or
 *  backdates a timestamp on an in-place edit can still match the PRIOR (id,
 *  updated_at) mark and suppress the corrected content, exactly the collision
 *  HIGH 3 reports. `updated_at` is kept only as a legacy fallback for the
 *  pathological case where `version` is somehow absent; `id` last, so every
 *  record always has SOME revision to key on. */
export function recordRevision(record) {
  return record?.version ?? record?.updated_at ?? record?.id;
}

/** Was this exact (id, revision) already marked delivered in `list`? */
function revisionDelivered(list, record) {
  const rev = recordRevision(record);
  return (list ?? []).some((e) => e?.id === record?.id && e?.revision === rev);
}

/** Add each `{identity, revision}` entry (the assembler's OWN returned shape —
 *  see `assembleDelivery`) to `list`, deduped on (id, revision). Never takes a
 *  raw record: callers persist ONLY what the assembler says actually rendered
 *  (decision 92088a62's ONE ASSEMBLER CONTRACT — "callers persist only the
 *  returned sets, after successful output"). An entry with no identity is
 *  silently skipped (chrome/framing carries none, by construction). */
function markRevisionDelivered(list, entries) {
  for (const e of entries ?? []) {
    if (!e?.identity) continue;
    if (!list.some((x) => x.id === e.identity && x.revision === e.revision)) {
      list.push({ id: e.identity, revision: e.revision ?? null });
    }
  }
}

/** Was this record already delivered as full SUBSTANCE this session (at this
 *  exact revision)? A record shown only as `discovery` (a pointer) does NOT
 *  count here — it must still qualify for a later substance delivery
 *  (decision 92088a62: "a record shown as discovery still qualifies for
 *  substance later"). This is the ONE check that guards against the false-
 *  'delivered' trap: it is never satisfied by a record's id merely APPEARING
 *  in rendered text, only by the assembler's own returned emittedSubstance
 *  set having been persisted here. */
export function isSubstanceDelivered(guard, record) {
  return revisionDelivered(guard.substance, record);
}

/** Was this record already delivered as a DISCOVERY pointer this session (at
 *  this exact revision)? Independent of `isSubstanceDelivered` — see there. */
export function isDiscoveryDelivered(guard, record) {
  return revisionDelivered(guard.discovery, record);
}

/** Either ledger — the conservative "have we shown this at all" check used to
 *  pre-filter CANDIDATES before a surface decides which content class each
 *  will render as (H20's mixed hazard/decision/article/prior-answer pool). */
export function isKnownDelivered(guard, record) {
  return isSubstanceDelivered(guard, record) || isDiscoveryDelivered(guard, record);
}

/** Persist the assembler's `emittedSubstance` set — and ONLY that set, and
 *  ONLY after the corresponding stdout write has actually succeeded (the
 *  side-effect-first-guard-second rule every caller already follows). */
export function markSubstanceDelivered(guard, emittedSubstance) {
  markRevisionDelivered(guard.substance, emittedSubstance);
}

/** Persist the assembler's `emittedDiscovery` set — see `markSubstanceDelivered`. */
export function markDiscoveryDelivered(guard, emittedDiscovery) {
  markRevisionDelivered(guard.discovery, emittedDiscovery);
}

/** Bash/probe-output-seam known_gaps dedup (board f1489964) — its OWN bounded
 *  register, keyed by `lineageKey` (the same lineage handle used before the
 *  guard split), reading/writing the separate `gap_articles` namespace above.
 *  Never consult or populate `substance`/`discovery` here: this seam re-emits
 *  gap substance independently of whether the article's full body was ever
 *  delivered via the Read/Edit path (the high-signal exception the board item
 *  names). */
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
  // A missing session id is an announced degraded mode (guardPath returns
  // null): every read must start empty so this invocation cannot deduplicate.
  if (!path) return emptyDeliveryGuard();
  // Self-healing: a torn/corrupt guard resets to empty (worst case a duplicate
  // delivery) instead of disabling delivery for the rest of the session.
  try {
    if (!existsSync(path)) return emptyDeliveryGuard();
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    // SCHEMA BUMP, NOT MIGRATION (decision 92088a62): a guard minted under a
    // prior version (missing entirely on the old flat `records`/`slugs` shape,
    // or a future version this build cannot read) resets to empty rather than
    // being coerced — coercing `records: [id, ...]` into `substance:
    // [{id,revision}, ...]` cannot recover the revision each id was shown at,
    // and guessing one risks exactly the false-negative-turned-false-positive
    // this rebuild exists to close. Reset costs at most one duplicate
    // delivery this session, which the decision rules acceptable.
    if (parsed?.version !== DELIVERY_GUARD_VERSION) return emptyDeliveryGuard();
    // Tolerate a guard written before a field existed (mid-session upgrade):
    // a missing array must read as empty, never as undefined.
    return { ...emptyDeliveryGuard(), ...parsed };
  } catch {
    process.stderr.write(`H19: corrupt delivery guard at ${path} — reset to empty\n`);
    return emptyDeliveryGuard();
  }
}

export function writeGuard(path, guard) {
  // See readGuard: never create a shared fallback guard without a session id.
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  // tmp+rename (torn-guard prevention, board 5e3d6ff4 fixer pass): NOT locked —
  // a lost update here costs at most one duplicate pointer/guard entry, and
  // readGuard already self-heals a torn file, so the cheaper fix is enough.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(guard));
  renameSync(tmp, path);
}

/** Record types the deny-once floor treats as a "ruling" — decision is the
 *  measured case (recorded in the dome-farmer project's own store — that id is
 *  deliberately not cited here, where it cannot resolve), anti_pattern is included
 *  because it is equally prescriptive ("do not do X") and carries the same
 *  status/scope/supersession fields the denial must disclose. feature_article/
 *  research_finding/disconfirmed_hypothesis stay OUT: they describe or answer,
 *  they do not rule, so denying a question because it merely OVERLAPS one is
 *  not what this decision asks for. (Decision foreign_68332e4b does not enumerate the
 *  type set explicitly — this scoping is this build's choice, flagged here.) */
export const DENY_RULING_TYPES = ['decision', 'anti_pattern'];

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

/** THE ONE LIFECYCLE-STATUS SPELLING (decision foreign_db3392db, part 1). The bracket
 *  CONTENT `status·scope[, superseded_by: <id>]` is shared verbatim with every
 *  pointer surface, so a reader never has to learn a second spelling for the same fact.
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
 *  is noise on the one channel that fires constantly (P1). Anything NOT
 *  exactly 'active' annotates, including an absent
 *  or unrecognised status: suppressing an unknown lifecycle would hide exactly
 *  the case the annotation exists for. */
export function statusAnnotation(record) {
  return record?.status === 'active' ? '' : ` [${statusBracket(record)}]`;
}

function clip(text, cap) {
  const s = String(text ?? '');
  // Code-point safe AND early-stopping (fix 5b, deny-once compaction round 2,
  // decision foreign_80d0ab62): the old `Array.from(s)` splits by code point (so a
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
 *  (e.g. a crafted "\n— fake →" prefix) inside a rendered fixed-shape
 *  message. */
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
 *  ASCII here, per anti-pattern foreign_d7e03137's posture. Verified 2026-08-31: a
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

/** Oversize-body guard (board 725299c8). Rendering a large what_it_does inline
 *  overflowed the RECEIVING agent's tool-result view: the real 'knowledge-
 *  delivery' article's own what_it_does is ~15k chars and its full block
 *  reached ~18.9KB, past the ~17KB view threshold — delivery degraded exactly
 *  at the surface it exists to serve. Past ARTICLE_BODY_FLOOR chars of body,
 *  renderArticle DIGESTS: a bounded head excerpt plus a knowledge_get pointer
 *  to the full record (its id, so the reader can fetch the withheld body),
 *  never the whole thing. Delivery degrades to a pointer, it NEVER denies
 *  (decision foreign_9950dfff lineage / AC7 — this is not a gate). Below the floor,
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

/** Did `renderArticle` take the DIGEST branch for this article (fix-round
 *  HIGH 2)? A digest is an explicitly bounded, explicitly disclosed PARTIAL
 *  view — never the complete record — so a caller must tag its assembler
 *  part `contentClass:'discovery'`, not `'substance'`: crediting a digest as
 *  fully-emitted substance is the same false-mark shape as a pointer counted
 *  as delivery. Callers check this BEFORE calling `renderArticle`, from the
 *  same `body.length > ARTICLE_BODY_FLOOR` condition it uses internally, so
 *  the two never drift apart. */
export function isArticleDigested(article) {
  return String(article?.what_it_does ?? '').length > ARTICLE_BODY_FLOOR;
}

/** Will this owner ONLY EVER render as a discovery pointer — never as full
 *  substance (fix-round MEDIUM 3, decision 92088a62)? A `reference_material`
 *  owner is always `renderReference` (a one-line pointer, never a body); an
 *  oversize `feature_article` always takes `renderArticle`'s DIGEST branch
 *  while it stays oversize. The ONE definition callers must consult BEFORE
 *  freshness filtering (which ledger — substance or discovery — decides
 *  "already delivered") AND when tagging the rendered part's `contentClass`,
 *  so the two never drift apart: filtering an owner against the WRONG ledger
 *  is exactly how a discovery-only owner that can never earn a substance mark
 *  re-delivered on every single touch, forever — a deterministic failure of
 *  the once-per-context guard, not the acceptable duplicate a lost concurrent
 *  guard write can cause. */
export function isOwnerDiscoveryOnly(record) {
  return record?.type === 'reference_material' || isArticleDigested(record);
}

// ---------------------------------------------------------------------------
// KNOWN_GAPS INLINE DELIVERY (decision foreign_db3392db Part 3, ship-ruled by decision
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
// DEDUP rides the EXISTING per-record session guard (isSubstanceDelivered/
// markSubstanceDelivered above): an article that does not re-render this
// session (already guarded at its current revision) never reaches
// renderArticle again, so its gaps never re-render either — there is no
// separate per-gap ledger to maintain.
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
// substance/discovery guard the paragraph above describes, which stays the
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
export function renderArticle(store, article, { gaps } = {}) {
  // slug/concept_family are clipped (outside-family review, board 725299c8): they
  // are the only unbounded inputs to the digest block below, so without this a
  // pathological slug/family could push the digested block past the ~8192-byte
  // delivery ceiling that clipping the body alone otherwise guarantees. Real
  // kebab slugs sit far under this bound, so normal rendering is unchanged.
  // `state` is the ARTICLE's build state, the trailing bracket is the RECORD's
  // lifecycle status (decision foreign_db3392db part 1) — two different facts, printed
  // side by side rather than collapsed into one token.
  // ID ON THE HEADER (decision foreign_2e8c30e4 human-readable ids — name first, id
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
  // COMPLETE TEXT, NOT PRE-CLIPPED (fix-round HIGH 2, decision 92088a62's ONE
  // ASSEMBLER CONTRACT: "structured inputs {..., complete text}"): this used
  // to `clip(body, charCap)`/`clip(intended_behavior, charCap)` HERE, before
  // the assembler ever saw the field — a body between charCap (2400) and
  // ARTICLE_BODY_FLOOR (4096) was silently cut with no disclosure and no
  // pointer, yet the assembler still credited it as fully emitted (it had no
  // way to know otherwise). The assembler owns degradation now: it receives
  // the whole field and, if it does not fit the caller's cap, clips it itself
  // via the part's `suffix`/`pointer` — and, exactly because it did the
  // clipping, correctly WITHHOLDS the substance mark for a clipped result.
  const lines = [
    header,
    `WHAT IT DOES: ${body}`,
    `INTENDED BEHAVIOR: ${String(article.intended_behavior ?? '')}`,
    // The oversize branch above already carries a knowledge_get pointer; this
    // branch (small/normal articles) did not, so a reader could not cite the
    // record by id without a second lookup (decision foreign_2e8c30e4).
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
          // COMPLETE TEXT, NOT PRE-CLIPPED (fix-round HIGH 2 remainder): this
          // used to `clip(u.reason, UNTESTABLE_REASON_CLIP)` HERE, before the
          // assembler ever saw the field — the same silent-pre-truncation
          // shape already fixed for WHAT IT DOES/INTENDED BEHAVIOR. A reason
          // over 140 chars was cut with no disclosure, yet the whole article
          // part still earned a substance mark. The assembler owns
          // degradation now: it gets the whole field and, if the ENCLOSING
          // part does not fit its cap, clips the part itself — correctly
          // withholding the mark when it does.
          const suffix = u ? ` [untestable: ${u.reason} — blocking ${String(u.blocking_record_id).slice(0, 8)}]` : '';
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
 *  decision foreign_ca23c811): delivery's owner query was articles-only, so an
 *  anti_pattern naming the EXACT file being edited was never delivered, while
 *  H10 asked at Stop whether a hazard had been RECORDED. The two directions were
 *  asymmetric, and anti_pattern is precisely the type whose whole value is being
 *  seen BEFORE the mistake is repeated — the reporting project shipped a
 *  one-way-latch bug in territory that had a stored one-way-latch anti_pattern.
 *  Substance (trigger + right_way), not a pointer: a pointer to a hazard the
 *  reader must choose to follow reproduces the skippable step delivery deletes. */
/** THE ONE HAZARD HEADER LINE BUILDER (consolidation, decision foreign_6f3e334c still
 *  governs: hazards are SUBSTANCE, rendered the SAME WAY wherever they appear
 *  — two header formats for one hazard block, depending on which surface
 *  rendered it, is the "enforced in two places" smell). Both `renderHazards`
 *  (the full/queued rendering) call this and NOTHING ELSE builds the line.
 *
 *  `clipTitleBytes`/`clipSlugBytes`, when given, apply a byte-safe clip.
 *  Omitted (renderHazards' own call), title/slug render exactly as stored,
 *  unclipped — byte-for-byte today's behavior. */
export function hazardHeaderLine(ap, { clipTitleBytes, clipSlugBytes, matchLabel = 'for this path' } = {}) {
  const title = typeof clipTitleBytes === 'number' ? clipToBytes(ap?.title, clipTitleBytes) : ap?.title;
  const slug =
    ap?.slug ? (typeof clipSlugBytes === 'number' ? clipToBytes(ap.slug, clipSlugBytes) : ap.slug) : '';
  return `⚠ ANTI-PATTERN [${(ap?.severity ?? 'warn').toUpperCase()}] ${matchLabel} — '${title}'${slug ? ` [${slug}]` : ''} (full record: knowledge_get ${ap?.id})${statusAnnotation(ap)}`;
}

/** `total` / `suppressed` (fixer F3) exist for the DRAIN, which is handed only
 *  the ids that were SHOWN in the original payload (some of which may since have
 *  died) and must still replay the ORIGINAL '+N more' tail rather than deriving
 *  a new one from the survivors it happens to have left. Omitted, both fall back
 *  to today's derivation, so every producer call is byte-identical. */
export function renderHazards(hazards, charCap, { cap = HAZARD_CAP, fileKeys = [], remedy, total, suppressed, matchLabel } = {}) {
  const shown = cappedHazards(hazards, cap);
  const fullTotal = total ?? hazards.length;
  const dropped = suppressed ?? hazards.length - shown.length;
  const blocks = shown.map((ap) =>
    [hazardHeaderLine(ap, { matchLabel }), `TRIGGER: ${clip(ap.trigger, charCap)}`, `RIGHT WAY: ${clip(ap.right_way, charCap)}`].join('\n')
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

/** Hazard blocks as ASSEMBLER PARTS (decision 92088a62), paired 1:1 with the
 *  records that produced them: each SHOWN hazard (the same `cappedHazards`
 *  selection `renderHazards` uses internally, called here with the identical
 *  args so the two never diverge) is `kind:'hazard'` (pinned, unbudgeted —
 *  decision 301d8a0a) and `contentClass:'substance'` — a WHOLE hazard IS
 *  substance, never a mere pointer, on every surface that renders one
 *  (item 4: Bash now included). The trailing '+N more' disclosure line, if
 *  any, carries no identity and `contentClass:'chrome'`, so it can never earn
 *  a delivery mark for a hazard the reader never actually saw. */
export function hazardParts(hazards, { cap = HAZARD_CAP, fileKeys = [], remedy, total, suppressed, matchLabel } = {}) {
  const shown = cappedHazards(hazards, cap);
  const blocks = renderHazards(hazards, Number.MAX_SAFE_INTEGER, { cap, fileKeys, remedy, total, suppressed, matchLabel });
  return blocks.map((text, i) =>
    i < shown.length
      ? {
          kind: 'hazard', contentClass: 'substance', identity: shown[i].id, revision: recordRevision(shown[i]), name: shown[i].slug || shown[i].title, text,
          // TRANSPORT-OVERFLOW FALLBACK (fix-round HIGH 1, decision 92088a62
          // NOT GUARANTEED clause): a hazard whose OWN whole block cannot fit
          // the hard transport ceiling degrades to this bare notice — never a
          // partial trigger/right_way (the HAZARDS clause: "each whole") —
          // and the assembler then correctly withholds its substance mark.
          pointer: hazardOverflowPointer(shown[i], matchLabel),
        }
      : { kind: 'hazard', contentClass: 'chrome', text }
  );
}

/** The degraded notice a hazard renders as when its own whole block cannot
 *  fit the hard transport ceiling — see `hazardParts`. Distinct wording from
 *  the ordinary "held back by the delivery cap" pointers: this is never our
 *  own configured cap turning it away (hazards are exempt from that), only
 *  the platform's transport boundary. */
export function hazardOverflowPointer(record, matchLabel = 'for this path') {
  return `⚠ ANTI-PATTERN [${(record?.severity ?? 'warn').toUpperCase()}] ${matchLabel} — TOO LARGE to show in full (exceeds the transport limit) · knowledge_get ${record?.id}${statusAnnotation(record)}`;
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

/** Per-pointer clip budgets (decision foreign_6a3b1a46). The statement ORIENTS — what was
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
 *  SECOND LINE ADDED 2026-08-03 (decision foreign_6a3b1a46, board 82e2969a): the header
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
export function renderDecisionPointers(rel, decisions, cap = DECISION_POINTER_CAP, { remedy, total, suppressed, matchLabel = 'for this path' } = {}) {
  const shown = decisions.slice(0, cap);
  // `total` / `suppressed` (fixer F3) — see renderHazards' note: the drain holds
  // only the shown slice and replays the original count and tail.
  const fullTotal = total ?? decisions.length;
  const dropped = suppressed ?? decisions.length - shown.length;
  const lines = [
    `▸ DECISIONS ${matchLabel} (${fullTotal}) — why it is this way and what was rejected. Pointers only; follow one before contradicting it:`,
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
 *  comment (decision foreign_ca23c811) exists to prevent, arriving from the other side.
 *  Omitted, it falls back to blocks.length, so producer calls are unchanged. */
// UTF-8 byte utilities shared by the delivery assembler and renderers.
function byteLen(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8');
}

/** Byte-safe clip: never splits a UTF-8 codepoint, appends a single '…'
 *  (itself budgeted) only when truncation actually happened and there is room
 *  for it. `maxBytes <= 0` yields ''. Distinct from the existing char-counted
 *  `clip()` above; multibyte input must never be measured wrong. */
function clipToBytes(text, maxBytes) {
  const s = String(text ?? '');
  if (maxBytes <= 0) return '';
  if (byteLen(s) <= maxBytes) return s;
  const ELLIPSIS = '…';
  const ellipsisBytes = byteLen(ELLIPSIS);
  const room = maxBytes > ellipsisBytes ? maxBytes - ellipsisBytes : 0;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const chBytes = byteLen(ch);
    if (used + chBytes > room) break;
    out += ch;
    used += chBytes;
  }
  return room > 0 ? `${out}${ELLIPSIS}` : out;
}

// ---------------------------------------------------------------------------
// PER-DELIVERY TOTAL CAP (scale-down Slice 3c, decision
// sterling-claude-code-scale-down-boundary; assembler contract, decision
// 92088a62). payload_char_cap bounds one FIELD; nothing bounded a delivery as
// a whole, and one governed Read measured 13-17KB. Every delivery surface
// (H19 tool-time, H19 Bash, dispatch staging, H20) now assembles its blocks
// through assembleDelivery: hazard blocks are PINNED and UNCHARGED against
// the CONFIGURED cap (never cut by `total_cap_bytes`, and their bytes do not
// spend that budget) — but, since fix-round HIGH 1/4, NEITHER hazards NOR
// pinned chrome are unconditionally whole against the separate, unwaivable
// TRANSPORT ceiling (DELIVERY_TRANSPORT_VISIBLE_BYTES): chrome degrades
// through the ordinary excerpt/pointer/omission path like any other part,
// and a hazard that still cannot fit degrades to its OWN bare "TOO LARGE to
// show" notice (never a partial trigger/right_way) — see `tryDegradeHazard`
// and the omitted-aggregate loop's own hazard-degrade fallback below for
// exactly when each is reached. Everything else (plain ordinary content) is
// kept whole while it fits, then clipped at a line boundary with a pointer
// suffix, then reduced to its pointer. Nothing is dropped silently: a part
// with no pointer that cannot fit is counted in a trailing omission line,
// which is itself never allowed to vanish — and nothing that degraded, in
// any of these ways, ever earns a delivery mark (see assembleDelivery's own
// doc).
// ---------------------------------------------------------------------------

/** Default total cap in UTF-8 bytes; config.delivery.total_cap_bytes overrides
 *  it (0 = no total cap). */
export const DELIVERY_TOTAL_CAP_DEFAULT = 3000;

/** THE HARD TRANSPORT CEILING (decision 92088a62 NOT GUARANTEED clause,
 *  fix-round HIGH 1/4): "Claude Code persists hook output over 10,000 chars
 *  and previews about 2,000; oversized hidden substance is a degraded notice
 *  and is not marked delivered." This is NOT `config.delivery.total_cap_bytes`
 *  — it is the platform's own hard boundary, and unlike the configured cap it
 *  is NEVER disabled (0 for `total_cap_bytes` means "no CONFIGURED cap", never
 *  "ignore the transport too"). Measured in UTF-8 bytes here (as every other
 *  cap in this file is) as a conservative proxy for the documented ~10,000
 *  CHARS — bytes >= chars for any text, so bounding by bytes never UNDER-
 *  protects the transport boundary. */
export const DELIVERY_TRANSPORT_VISIBLE_BYTES = 10000;

/** Smallest clipped excerpt worth emitting ahead of a pointer. */
export const DELIVERY_EXCERPT_MIN_BYTES = 160;

/** SCHEMA MINIMUM (decision 92088a62 item 7): the smallest positive
 *  `total_cap_bytes` this build will actually use. A tiny or misconfigured
 *  positive value (say `1`) would still let hazards and pinned chrome render
 *  in full — those are never subject to this cap — but it would squeeze every
 *  ordinary record down to nothing while the pinned parts alone still spend
 *  bytes, which is a degrade users almost certainly did not intend. `0`
 *  remains the documented, UNCLAMPED "no cap at all" sentinel — a deliberate
 *  disable, not a misconfiguration — so it is the one value this floor never
 *  touches. */
export const DELIVERY_TOTAL_CAP_MIN = 500;

export function resolveTotalCap(cwd) {
  try {
    const v = loadConfig(cwd)?.delivery?.total_cap_bytes;
    if (!(typeof v === 'number' && Number.isInteger(v) && v >= 0)) return DELIVERY_TOTAL_CAP_DEFAULT;
    if (v === 0) return 0; // explicit disable — never clamped
    return Math.max(v, DELIVERY_TOTAL_CAP_MIN);
  } catch {
    return DELIVERY_TOTAL_CAP_DEFAULT;
  }
}

/**
 * THE ONE ASSEMBLER (decision 92088a62 knowledge-delivery-target-design-no-
 * delayed-delivery, ONE ASSEMBLER CONTRACT clause): structured parts →
 * `{text, emittedSubstance, emittedDiscovery, omitted, omittedCount,
 * degraded}`. PURE — no I/O, no guard access, no clock. Every caller persists
 * ONLY `emittedSubstance`/`emittedDiscovery`, and only after its stdout write
 * has actually succeeded; nothing else may ever mark a record delivered. This
 * is the fix for the false-'delivered' trap both the UUID-scanning design
 * (the deleted UUID-scanning-the-rendered-text helper) and a "mark what was
 * SELECTED" design share: a
 * record dropped for cap, or shown only as a degraded excerpt/pointer, must
 * spend no mark at all, and stay eligible for a later, real delivery.
 *
 * A part is `{text, kind, contentClass, pinned, identity, revision,
 * identities, pointer, suffix}`. "PINNED" below means exempt from the
 * ordinary excerpt-then-pointer CLIPPING path — it is NOT a guarantee of
 * unconditional wholeness (fix-round HIGH 1/4 correction: pinned parts
 * used to be described as "always whole", which stopped being true once
 * the hard transport ceiling below could still force them down to a bare
 * pointer, an omission, or — for the omitted-count disclosure specifically —
 * force an already-embedded hazard to give up its own room):
 *  - `kind: 'hazard'` — PINNED and UNCHARGED against `capBytes` (decision
 *    301d8a0a): never clipped to a partial excerpt, and its bytes do NOT
 *    count against the CONFIGURED cap (hazards can push the ordinary total
 *    over `capBytes` by design). It is NOT exempt from the separate, hard
 *    TRANSPORT ceiling, though: a hazard whose own whole block cannot fit
 *    that ceiling degrades to a bare "TOO LARGE to show" notice instead
 *    (`tryDegradeHazard`), and an already-embedded hazard can be pushed down
 *    to that same notice, after the fact, purely to keep the omitted-count
 *    disclosure itself from being silently dropped (see the aggregate loop
 *    below) — either way it earns no substance mark once degraded.
 *  - `kind: 'ordinary'` (default) with `pinned: true` — PINNED but CHARGED:
 *    tried whole first, and its bytes DO count against `capBytes` so it
 *    reduces the room left for clippable ordinary parts (item 6: "pass
 *    envelope/posture/chrome to the assembler as parts so they are charged"
 *    — the total cap is charged on the FINAL composed context, not the
 *    knowledge payload alone). If it still does not fit EITHER budget it
 *    degrades through the SAME excerpt/pointer/omission path as unpinned
 *    ordinary content — this is how envelope/posture/return-contract CHROME
 *    is charged, and it is not exempt from ever being clipped.
 *  - `kind: 'ordinary'`, not pinned — the clippable default: whole while it
 *    fits, then a byte-safe excerpt + `suffix`, then a bare `pointer`, then
 *    folded into one trailing '+N more records' aggregate line.
 *
 * `contentClass` is `'substance' | 'discovery' | 'chrome'`, the caller's own
 * declaration of what the part conveys — the assembler never infers it.
 * `identity`/`revision` (or, for a part whose text speaks for SEVERAL records
 * at once — e.g. one joined decision-pointer block — the plural
 * `identities: [{identity, revision}, ...]`) name the record(s) the part is
 * about; a part with none (chrome framing) never earns a mark regardless of
 * how it renders. A record earns a mark in `emittedSubstance`/
 * `emittedDiscovery` ONLY when its part's FULL text survived un-clipped —
 * never for an excerpt, a bare pointer, or an aggregated omission (decision
 * 92088a62: "Omitted, pointer-only, unavailable and transport-overflow
 * content never consumes a substance-delivery mark").
 */
export function assembleDelivery(parts, capBytes, { sep = '\n\n', aggregateLabel } = {}) {
  const items = (parts ?? [])
    .filter((part) => part && typeof part.text === 'string' && part.text)
    .map((part) => ({
      ...part,
      kind: part.kind === 'hazard' ? 'hazard' : 'ordinary',
      contentClass: part.contentClass ?? 'chrome',
      pinned: part.kind === 'hazard' ? true : !!part.pinned,
    }));

  // `name` (optional, per identity entry or on a single-identity part) is the
  // record's human name — slug or title — used ONLY to title the '+N more'
  // disclosure line; it never affects credit, dedupe or omission counts.
  const idsOf = (part) => part.identities ?? (part.identity ? [{ identity: part.identity, revision: part.revision, name: part.name }] : []);
  const dedupeEntries = (entries) => {
    const seen = new Set();
    const out = [];
    for (const e of entries) {
      if (!e?.identity) continue;
      const key = `${e.identity}\u0000${e.revision}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ identity: e.identity, revision: e.revision });
    }
    return out;
  };
  const creditsFor = (survivors) => {
    const emittedSubstance = [];
    const emittedDiscovery = [];
    for (const part of survivors) {
      if (part.contentClass !== 'substance' && part.contentClass !== 'discovery') continue;
      const bucket = part.contentClass === 'substance' ? emittedSubstance : emittedDiscovery;
      for (const entry of idsOf(part)) {
        if (entry?.identity) bucket.push({ identity: entry.identity, revision: entry.revision });
      }
    }
    return { emittedSubstance, emittedDiscovery };
  };

  const bytes = (text) => byteLen(text);
  const isHazard = (part) => part.kind === 'hazard';
  const isChrome = (part) => part.kind !== 'hazard' && part.pinned;

  // TWO BUDGETS, ALWAYS BOTH ACTIVE (fix-round HIGH 1/4, decision 92088a62 NOT
  // GUARANTEED clause): `ordinaryCeiling` is OUR configured cap — hazards stay
  // exempt from it (301d8a0a) — but `DELIVERY_TRANSPORT_VISIBLE_BYTES` is
  // Claude Code's OWN hard boundary and applies to the FINAL composed string
  // as a whole, with NO exemptions — including hazards, including a disabled
  // (`0`) configured cap. `0` only ever meant "no CONFIGURED cap"; it never
  // meant "the platform transport limit does not apply either".
  const ordinaryCeiling = capBytes > 0 ? Math.min(capBytes, DELIVERY_TRANSPORT_VISIBLE_BYTES) : DELIVERY_TRANSPORT_VISIBLE_BYTES;

  const selected = new Map(); // part -> { text, full }
  const omitted = [];
  const output = () => items.flatMap((part) => (selected.has(part) ? [selected.get(part).text] : []));
  const totalBytes = () => bytes(output().join(sep));
  const hazardBytesUsed = () =>
    [...selected.entries()].reduce((sum, [part, sel]) => sum + (isHazard(part) ? bytes(sel.text) : 0), 0);
  const ordinaryBytesUsed = () => Math.max(0, totalBytes() - hazardBytesUsed());
  // `extra` is room held back for bytes not yet selected — the reserved
  // pointers of later ordinary parts (see RESERVED POINTERS below).
  const fitsOrdinaryCap = (extra = 0) => ordinaryBytesUsed() + extra <= ordinaryCeiling;
  const fitsTransport = (extra = 0) => totalBytes() + extra <= DELIVERY_TRANSPORT_VISIBLE_BYTES;
  const pointerFor = (part) => part.pointer || '';

  // ORDINARY/CHROME DEGRADE: whole while it fits both budgets, then a
  // byte-safe excerpt + `suffix`, then a bare `pointer`, then full omission.
  // `fitsFn(stage)` is told which rendering it judges — 'whole', 'excerpt' or
  // 'pointer' — so a caller can hold back more room from an excerpt than
  // from a whole part or a pointer (see RESERVED POINTERS below).
  const tryDegradeOrdinary = (part, fitsFn) => {
    selected.set(part, { text: part.text, full: true });
    if (fitsFn('whole')) return;
    selected.delete(part);

    const ptr = pointerFor(part);
    const suffix = part.suffix || ptr;
    if (suffix) {
      const lines = part.text.split('\n');
      // A block whose first line IS its pointer (the H19 Bash shape) already
      // carries it: appending it again would render the pointer twice.
      const carriesSuffix = lines[0] === suffix;
      const render = (candidate) => (carriesSuffix ? candidate : `${candidate}\n${suffix}`);
      let clipped = '';
      let best = '';
      let bestLines = 0;
      for (const line of lines) {
        const candidate = clipped ? `${clipped}\n${line}` : line;
        selected.set(part, { text: render(candidate), full: false });
        if (!fitsFn('excerpt')) break;
        clipped = candidate;
        best = render(candidate);
        bestLines += 1;
      }
      // HEADING-ONLY EXCERPT (H20 decision crowd-out, 2026-09-24): a
      // multi-line block cut to its FIRST line keeps only the block's heading
      // ("▸ DECISIONS (5) — …") over a separate `suffix` ("… the rest held
      // back — knowledge_query …") and names none of its records. The
      // pointer wins when it fits; when it does not, the part is omitted so
      // the '+N more' line names it. A part with no separate suffix renders
      // heading + pointer, which already names what the pointer names.
      if (best && bestLines === 1 && lines.length > 1 && part.suffix && part.suffix !== ptr) {
        selected.set(part, { text: ptr, full: false });
        if (ptr && fitsFn('pointer')) return;
        selected.delete(part);
        omitted.push(part);
        return;
      }
      if (best) {
        selected.set(part, { text: best, full: false });
        return;
      }
      selected.delete(part);
      selected.set(part, { text: ptr, full: false });
      if (ptr && fitsFn('pointer')) return;
      selected.delete(part);
    }
    omitted.push(part);
  };

  // HAZARD DEGRADE: WHOLE OR A BARE POINTER ONLY — never a partial excerpt
  // (decision 92088a62 HAZARDS clause: "each whole"; a hazard that cannot fit
  // the transport ceiling becomes a "degraded notice", per the NOT GUARANTEED
  // clause, rather than a truncated trigger/right_way).
  const tryDegradeHazard = (part) => {
    selected.set(part, { text: part.text, full: true });
    if (fitsTransport()) return;
    selected.delete(part);
    const ptr = pointerFor(part);
    if (ptr) {
      selected.set(part, { text: ptr, full: false });
      if (fitsTransport()) return;
      selected.delete(part);
    }
    omitted.push(part);
  };

  // PROCESSING ORDER decides who wins scarce budget when both are tight; it
  // is independent of the FINAL TEXT order, which `output()` always takes
  // from `items`' original (caller-supplied) order. Chrome goes first — it is
  // small, structural, and "bound pinned chrome before ordinary selection" is
  // literal (fix-round HIGH 4) — then hazards (the priority SUBSTANCE, and
  // the realistic source of transport overflow, per HIGH 1's own reproduction
  // of an oversized single hazard), then ordinary.
  for (const part of items) if (isChrome(part)) tryDegradeOrdinary(part, () => fitsOrdinaryCap() && fitsTransport());
  for (const part of items) if (isHazard(part)) tryDegradeHazard(part);

  // DISCLOSURE HELPERS — shared by the '+N more' line below and by the room
  // the ordinary phase reserves for it.
  // IDS FOR THE DISCLOSURE COME FROM PART METADATA FIRST (item 7 —
  // "aggregate from record metadata"): `identity`/`identities` is the SAME
  // structured field the assembler already uses to credit an emitted mark,
  // so a part the caller tagged has its id(s) surface here without any text
  // scan. A part with NO identity (bare chrome, or a caller that has not
  // been migrated onto the tagged shape) falls back to the old regex scan
  // of its own pointer/text — cosmetic only, never a delivery mark, and
  // scoped to exactly the omitted part being described.
  const idsForDisclosure = (part) => {
    const tagged = idsOf(part).map((e) => e.identity).filter(Boolean);
    if (tagged.length) return tagged;
    return [...String(part.pointer || part.text).matchAll(/knowledge_get\s+([^\s\])]+)/g)].map((m) => m[1]);
  };
  // TITLED ENTRIES (user ruling 2026-09-24): an omitted record is named
  // `name (id8)`, name first. Names are derived from the CURRENT omission set
  // on every render, so a part evicted late is named like any other.
  // ONE FORMAT: entries are always space-separated, named or not — an
  // id-only line is byte-identical to the pre-2026-09-24 one, and `(id8)`
  // closes each named entry, so a title's own spaces stay unambiguous.
  const disclosureEntries = (list) => {
    const names = new Map();
    for (const e of list.flatMap(idsOf)) {
      if (e?.identity && typeof e.name === 'string' && e.name.trim() && !names.has(e.identity)) {
        names.set(e.identity, clipToBytes(e.name.replace(/\s+/g, ' ').trim(), 80));
      }
    }
    return [...new Set(list.flatMap(idsForDisclosure))].map((id) => ({ id8: id.slice(0, 8), name: names.get(id) }));
  };
  // COUNT BY IDENTITY, DEDUPED (fix-round MEDIUM 7): one omitted part
  // naming several records (a joined decision-pointer block) must disclose
  // ALL of them, not read as "+1" — matching the returned `omittedCount`
  // computed the same way below. Falls back to the PART count only when
  // NOTHING omitted carries any identity at all (pure chrome/framing —
  // never "+0 more records" over content that visibly vanished).
  const disclosureCount = (list) => dedupeEntries(list.flatMap(idsOf)).length || list.length;
  const renderDisclosure = (count, entries) => {
    const prefix = `+${count} more records: knowledge_query`;
    return entries.length
      ? `${prefix}; knowledge_get ${entries.map((e) => (e.name ? `${e.name} (${e.id8})` : e.id8)).join(' ')}`
      : `${prefix}; knowledge_get`;
  };
  // The fully-named line for a candidate omission set — what the ordinary
  // phase reserves room for (a custom `aggregateLabel` is sized as given).
  const disclosureSize = (list, named) =>
    aggregateLabel
      ? bytes(aggregateLabel(disclosureCount(list), disclosureEntries(list).map((e) => e.id8)))
      : bytes(renderDisclosure(disclosureCount(list), disclosureEntries(list).map((e) => (named ? e : { id8: e.id8 }))));
  const sepCost = (renderedBefore) => (renderedBefore > 0 ? bytes(sep) : 0);

  // RESERVED POINTERS (decision 301d8a0a: "Each later block's pointer is
  // reserved up front so an early large block cannot crowd it out"; restored
  // 2026-09-24 after H20 dropped the one decision that answered the question
  // to a bare id). Once chrome and hazards hold their bytes, each ordinary
  // part's pointer is reserved in caller order against BOTH budgets — the
  // configured cap and the transport ceiling — charged a separator only when
  // one will render before it. From what the pointers leave, room for the
  // '+N more' line of whatever this placement omits is held back too: its
  // ids-only size from whole renderings, its fully-named size from excerpts. While an
  // ordinary part is placed, the pointers reserved for the parts AFTER it,
  // and the disclosure's room, are held back, so it degrades (excerpt, then
  // pointer) rather than spend them. The
  // disclosure's size depends on what is omitted, so placement re-runs until
  // the reserved room covers it (at most 4 passes; the eviction loop below
  // stays the last resort, and evicts a reserved pointer only after every
  // unreserved part). A pointer that does not fit the room left at
  // reservation time is not reserved: that part competes for whatever room
  // remains and, failing that, is counted and named in the '+N more' line
  // and reported `degraded` — loud and deterministic, never silent.
  const ordinaryParts = items.filter((part) => !isHazard(part) && !isChrome(part));
  const baseOmitted = [...omitted];
  const reserved = new Map();
  const placeOrdinary = (disclosure) => {
    for (const part of ordinaryParts) selected.delete(part);
    omitted.length = 0;
    omitted.push(...baseOmitted);
    reserved.clear();
    let rendered = selected.size;
    let room = Math.min(ordinaryCeiling - ordinaryBytesUsed(), DELIVERY_TRANSPORT_VISIBLE_BYTES - totalBytes());
    for (const part of ordinaryParts) {
      const ptr = pointerFor(part);
      if (!ptr) continue;
      const cost = bytes(ptr) + sepCost(rendered);
      if (cost > room) continue;
      reserved.set(part, cost);
      rendered += 1;
      room -= cost;
    }
    const roomFor = (size) => (size > 0 ? Math.max(0, Math.min(room, size + bytes(sep))) : 0);
    const disclosureRoom = { whole: roomFor(disclosure.ids), excerpt: roomFor(disclosure.named), pointer: 0 };
    ordinaryParts.forEach((part, i) => {
      const later = ordinaryParts.slice(i + 1).reduce((sum, next) => sum + (reserved.get(next) ?? 0), 0);
      tryDegradeOrdinary(part, (stage) => {
        const extra = later + disclosureRoom[stage];
        return fitsOrdinaryCap(extra) && fitsTransport(extra);
      });
    });
  };
  {
    // The disclosure's room, from what the reserved pointers leave: its
    // ids-only size is held back from whole renderings and its fully-NAMED
    // size from excerpts (an omitted record's name outranks another block's
    // extra excerpt lines), never from a reserved pointer. When even that
    // room is missing, the eviction loop below takes an unreserved part
    // before a reserved one.
    let wanted = { ids: 0, named: 0 };
    placeOrdinary(wanted);
    for (let pass = 0; pass < 3 && omitted.length; pass++) {
      const need = { ids: disclosureSize(omitted, false), named: disclosureSize(omitted, true) };
      if (need.ids <= wanted.ids && need.named <= wanted.named) break;
      wanted = { ids: Math.max(need.ids, wanted.ids), named: Math.max(need.named, wanted.named) };
      placeOrdinary(wanted);
    }
  }

  if (omitted.length) {
    const aggregatePart = { kind: 'ordinary', contentClass: 'chrome', text: '' };
    items.push(aggregatePart);
    // `aggregateLabel(count, ids)` (optional) lets a caller with its OWN
    // established overflow wording (e.g. the Bash rung's "+N more pointer
    // line(s) held back by the M-byte delivery cap") keep it verbatim instead
    // of the generic '+N more records' line below — purely presentational,
    // never a behavior change: the credit rules (an omitted part earns no
    // mark) are identical either way.
    // Names are shed lowest-ranked first to fit the room still free beside
    // the content already selected; only then are ids dropped (for the cap).
    const aggregate = () => {
      const count = disclosureCount(omitted);
      const entries = disclosureEntries(omitted);
      if (aggregateLabel) {
        const ids = entries.map((e) => e.id8);
        let line = aggregateLabel(count, ids);
        while (ids.length && bytes(line) > ordinaryCeiling) {
          ids.pop();
          line = aggregateLabel(count, ids);
        }
        return line;
      }
      const sepBytes = sepCost([...selected.keys()].filter((part) => part !== aggregatePart).length);
      const room = Math.min(ordinaryCeiling - ordinaryBytesUsed() - sepBytes, DELIVERY_TRANSPORT_VISIBLE_BYTES - totalBytes() - sepBytes);
      let line = renderDisclosure(count, entries);
      for (let i = entries.length - 1; i >= 0 && bytes(line) > room; i--) {
        if (!entries[i].name) continue;
        entries[i].name = undefined;
        line = renderDisclosure(count, entries);
      }
      while (entries.length && bytes(line) > ordinaryCeiling) {
        entries.pop();
        line = renderDisclosure(count, entries);
      }
      return line;
    };
    // THE DISCLOSURE ITSELF MUST NEVER SILENTLY VANISH (fix-round HIGH 1,
    // decision 92088a62 HAZARDS clause: "with the omitted count stated" — a
    // cap that drops the "+N more" line is the exact silent-omission failure
    // the disclosure exists to prevent, even when the thing crowding it out
    // is a legitimately whole, unbudgeted hazard). Priority for what gives up
    // room, in order: (1) evict an already-selected ORDINARY/chrome part —
    // never a hazard, first pass, preserving 301d8a0a's "hazards are never
    // cut by the [CONFIGURED] cap"; unreserved parts go before a part holding
    // a reserved pointer (review 2026-09-24: the reserved decision pointer
    // was the eviction victim); (2) if nothing ordinary is left, degrade
    // the LAST already-whole hazard down to its OWN transport notice (never a
    // partial excerpt — the same whole-or-pointer rule `tryDegradeHazard`
    // enforces) — this is the aggregate's own final resort against the HARD
    // transport ceiling, not the configured cap, so it does not contradict
    // 301d8a0a; (3) if truly nothing can be freed (no ordinary content, no
    // hazard has a pointer fallback), accept the aggregate line even though
    // it overruns — stating the count imperfectly beats not stating it.
    while (true) {
      const text = aggregate();
      aggregatePart.text = text;
      selected.set(aggregatePart, { text, full: false });
      // Captured BEFORE deleting the aggregate below: `fitsTransport()` on
      // its OWN, post-delete, reports the state WITHOUT the disclosure line
      // at all — which fits almost by definition (that is exactly the
      // problem) — so the branch beneath must judge whether the COMBINATION
      // (already-selected content + this disclosure) fit, not the emptier
      // state deleting it produces.
      const ordinaryOk = fitsOrdinaryCap();
      const transportOk = fitsTransport();
      if (ordinaryOk && transportOk) break;
      selected.delete(aggregatePart);
      const evictable = [...items].reverse().filter((part) => part !== aggregatePart && !isHazard(part) && selected.has(part));
      const last =
        evictable.find((part) => !isChrome(part) && !reserved.has(part)) ??
        evictable.find((part) => !isChrome(part)) ??
        evictable[0];
      if (last) {
        selected.delete(last);
        omitted.push(last);
        continue;
      }
      // Only reach for a hazard when the HARD TRANSPORT CEILING itself is
      // what still fails to fit — never for the CONFIGURED cap alone
      // (`fitsOrdinaryCap`, decision 301d8a0a): a pathologically tiny
      // `total_cap_bytes` with nothing ordinary left to evict must fall
      // straight to the final "accept the overrun" resort below, not start
      // shrinking whole hazard substance the configured cap was never
      // allowed to touch in the first place.
      const degradable = !transportOk
        ? [...items].reverse().find((part) => isHazard(part) && selected.has(part) && selected.get(part).full && pointerFor(part))
        : null;
      if (degradable) {
        selected.set(degradable, { text: pointerFor(degradable), full: false });
        continue;
      }
      selected.set(aggregatePart, { text, full: false });
      break;
    }
  }

  const survivors = items.filter((part) => selected.has(part) && selected.get(part).full);
  const { emittedSubstance, emittedDiscovery } = creditsFor(survivors);
  const omittedEntries = dedupeEntries(omitted.flatMap(idsOf));
  const partial = items.some((part) => selected.has(part) && !selected.get(part).full);
  return {
    text: output().join(sep),
    emittedSubstance,
    emittedDiscovery,
    omitted: omittedEntries,
    omittedCount: omittedEntries.length,
    degraded: omitted.length > 0 || partial,
  };
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

/** Pointer for a decision block the cap cannot hold. `top` (optional, the
 *  highest-ranked decision record) is named in it, name first, so the block's
 *  reserved pointer never degrades the answer to a bare id. */
export function decisionBlockPointer(count, widen, top) {
  const name = top ? clipToBytes(String(top.slug || top.title || '').replace(/\s+/g, ' ').trim(), 120) : '';
  const lead = top?.id ? ` — top: ${name ? `'${name}' ` : ''}(knowledge_get ${top.id})` : '';
  return `▸ DECISIONS (${count}) held back by the delivery cap${lead} — ${widen}`;
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
export function bashPointerBlock(entries, { gapsByOwner, includeHazardLines = true } = {}) {
  const header = [
    'STERLING KNOWLEDGE POINTERS (H19) — governed paths named in a Bash command.',
    'This is a POINTER, not the article: the store owns these paths, so read the record before you design or edit here.',
  ].join('\n');
  const lines = [];
  const gapAttached = new Set();
  for (const e of entries) {
    // `includeHazardLines: false` (delivery-migration step 3, decision
    // 92088a62 item 4): the h19-bash-delivery.mjs caller now renders hazards
    // as WHOLE blocks via `hazardParts` — a hazard is substance, not a
    // pointer, on every surface — so this one-line-per-hazard form is
    // skipped there. Kept default-on for any other caller (there is none
    // today) so the function's own contract does not silently change shape.
    if (includeHazardLines) for (const h of e.hazards) {
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
  const lineBytes = (l) => [l.line, ...(Array.isArray(l.gapLines) ? l.gapLines : [])].reduce((n, x) => n + byteLen(x) + 1, 0);
  const TAIL_RESERVE = 160;
  let used = byteLen(header) + kept.filter((l) => l.hazard).reduce((n, l) => n + lineBytes(l), 0);
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
