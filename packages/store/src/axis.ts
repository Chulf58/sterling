// MECHANISM-AXIS MATCHING — the ONE shared matcher/extractor behind H20's
// dispatch delivery, H19's dispatch-staging subject channel, and the
// knowledge_preflight MCP tool (H19/H20 relevance slice 4). Moved here from
// scripts/hooks/lib/delivery.mjs (which re-exports it for hook consumers) so
// the MCP server and the hooks import ONE definition — the one-mechanism
// constraint from decision f5638a84's build. Pure functions: no fs, no store
// handle, no imports — safe in hook bundles (esbuild resolves the workspace
// import at build, exactly as h20's MAX_RANK_TERMS import already does) and in
// the server alike.
//
// TWO STAGES, because one is not enough. Stage 1 is the store's FTS: rank_terms
// genuinely NARROW (index.ts builds `... AND records_fts MATCH ?`), so zero
// hits is a real zero and a caller can stay silent. But that index spans
// rationale/right_way/guidance too — far too much surface to inject from.
// Stage 2 (axisHits + the floors below) re-checks against the NARROW fields
// only: triggers and titles.

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

/** A term shorter than this is too generic to carry a mechanism. */
export const AXIS_MIN_TERM_LEN = 4;

/** How many DISTINCT extracted terms must land in a record's narrow fields
 *  before it is worth injecting. One shared word is coincidence; two is signal.
 *  HONEST NOTE: 2 is a starting threshold chosen on the two motivating cases,
 *  NOT on measured data — tune it on hit rates, the way board 8390f8fa says
 *  size thresholds should be set. */
export const AXIS_MIN_HITS = 2;

/** The minimal record shape the axis functions read. */
export interface AxisRecord {
  type?: string;
  title?: string;
  trigger?: string;
  statement?: string;
  // preflight coverage (board 39c3d762): article territory + finding subject
  slug?: string;
  concept_family?: string;
  question?: string;
}

/** Extract candidate mechanism terms from outgoing prompt text, most
 *  discriminating first. Ranked by TERM FREQUENCY: a dispatch prompt repeats
 *  what it is ABOUT, so a term used three times beats a one-off mention. Ties
 *  break by length (longer is more specific) then lexicographically, so the
 *  result is fully deterministic for a given prompt — the same prompt must
 *  always produce the same query. `maxTerms` is supplied by the CALLER: the
 *  real ceiling is MAX_RANK_TERMS, and writing 16 in a second place is the
 *  exact drift decision b47889b7 removed. */
export function extractAxisTerms(text: unknown, maxTerms: number): string[] {
  const counts = new Map<string, number>();
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
 *  turn this into noise. Since board 39c3d762 (preflight coverage): a
 *  feature_article's slug/family/title state its TERRITORY (what_it_does is
 *  excluded — tens of KB of discussion), and a research_finding's or
 *  disconfirmed_hypothesis's question IS its subject (answer/rejected_answer
 *  excluded, same reason). H20 delivery passes all five types since board
 *  e7157d0b; H19 delivery remains anti_pattern/decision. */
export function axisNarrowText(record: AxisRecord | null | undefined): string {
  if (!record || typeof record !== 'object') return '';
  if (record.type === 'anti_pattern') return `${record.title ?? ''}\n${record.trigger ?? ''}`;
  if (record.type === 'decision') return `${record.title ?? ''}\n${record.statement ?? ''}`;
  if (record.type === 'feature_article') return `${record.slug ?? ''} ${record.concept_family ?? ''}\n${record.title ?? ''}`;
  if (record.type === 'research_finding') return `${record.question ?? ''}`;
  // Board e7157d0b (prior-answer check): a refuted trail's subject is its
  // question, exactly the research_finding rule — rejected_answer/evidence are
  // discussion, matching them would be noise.
  if (record.type === 'disconfirmed_hypothesis') return `${record.question ?? ''}`;
  return '';
}

/** LIMITATION, STATED UP FRONT: this returns text BYTE-IDENTICAL to
 *  axisNarrowText for feature_article, research_finding and
 *  disconfirmed_hypothesis — those three narrow texts are already subject-only,
 *  so the title-union below is a strict NO-OP for 3 of the 5 delivered types.
 *  The union changes retrieval for `decision` and `anti_pattern` ONLY, which are
 *  the two types whose narrow text appends a long body (statement / trigger) to
 *  the title. Do not read a measurement taken on a decision as evidence about an
 *  article.
 *
 *  The record's own SUBJECT LINE — the narrow text's title-ish half, per type,
 *  mirroring axisNarrowText's shape above. Exists ONLY for centrality (below):
 *  axisNarrowText concatenates a record's title and its body into ONE flat
 *  frequency pool, so a 178-char title cannot out-count a 4106-char statement
 *  and a ruling becomes unretrievable BY ITS OWN SUBJECT the more thoroughly it
 *  is evidenced — measured 2026-08-30 on decision e9387b85, whose title says
 *  'attestation' twice while the term ranks 12th in its own top-K
 *  (research_finding 5f3e0a42). For every type this is a SUBSET of
 *  axisNarrowText (identical for feature_article / research_finding /
 *  disconfirmed_hypothesis, whose narrow text is already subject-only), which
 *  is what keeps the union below from ever growing a terse record's central
 *  set — see hasRecordCentralityHit. Unknown types return '' exactly as
 *  axisNarrowText does, preserving its vacuous-pass behaviour. */
export function axisTitleText(record: AxisRecord | null | undefined): string {
  if (!record || typeof record !== 'object') return '';
  if (record.type === 'anti_pattern') return `${record.title ?? ''}`;
  if (record.type === 'decision') return `${record.title ?? ''}`;
  if (record.type === 'feature_article') return `${record.slug ?? ''} ${record.concept_family ?? ''}\n${record.title ?? ''}`;
  if (record.type === 'research_finding') return `${record.question ?? ''}`;
  if (record.type === 'disconfirmed_hypothesis') return `${record.question ?? ''}`;
  return '';
}

/** How many DISTINCT terms appear in the record's narrow fields. Substring
 *  match on a word-ish boundary so 'latch' hits 'latches' and 'one-way-latch'
 *  but not an unrelated token that merely contains the letters. */
export function axisHits(record: AxisRecord, terms: string[]): string[] {
  const hay = axisNarrowText(record).toLowerCase();
  if (!hay) return [];
  return terms.filter((t) => new RegExp(`(^|[^a-z0-9_])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(hay));
}

/** UNIVERSAL coding vocabulary — words that show up in essentially every
 *  dispatch prompt regardless of SUBJECT, so a match confined to this set
 *  cannot discriminate between one dispatch and the next. Tuned on the
 *  measured 15/15 fire rate (board 648bb497, research_finding bf74c65f,
 *  2026-08-04). DELIBERATELY EXCLUDES Sterling domain words ('board',
 *  'decision', 'article', ...) even though several read as ordinary English —
 *  in THIS store they discriminate, because the store's subject IS Sterling's
 *  own mechanism (decision 3b09bc8f). */
export const GENERIC_DEV_TERMS = new Set([
  'test', 'tests', 'testing', 'script', 'scripts', 'commit', 'commits', 'branch', 'merge',
  'build', 'builds', 'check', 'checks', 'node', 'file', 'files', 'path', 'paths', 'run', 'runs',
  'running', 'item', 'items', 'text', 'change', 'changed', 'changes', 'code', 'repo', 'line',
  'lines', 'error', 'errors', 'string', 'value', 'values', 'field', 'fields', 'message',
  'messages', 'output', 'input', 'name', 'names', 'list', 'exact', 'existing', 'touched',
  'untouched', 'through', 'actually', 'behavior', 'still',
]);

/** True once at least one matched term escapes GENERIC_DEV_TERMS. Two hits of
 *  pure universal vocabulary ("test", "check") describe every dispatch ever
 *  written — a real match needs at least one term that actually says something
 *  about THIS prompt's subject. */
export function hasDiscriminatingHit(hits: string[]): boolean {
  return hits.some((t) => !GENERIC_DEV_TERMS.has(String(t).toLowerCase()));
}

/** RECORD CENTRALITY — the third stage-2 floor (decision 599a28ed). The first
 *  two floors ask whether the OUTGOING prompt is specific enough; this one asks
 *  whether the matched terms are central to the RECORD — a record may not fire
 *  on words that appear only in passing in its own trigger. */
export const AXIS_RECORD_TOP_K = 6;
export const AXIS_MIN_RECORD_TERMS = 2;

export interface CentralityOpts {
  topK?: number;
  minTerms?: number;
}

/** The record's central terms that the outgoing text actually covers.
 *  SYMMETRIC prefix matching (review finding 2, 2026-08-10): axisHits tests the
 *  prompt's term as a prefix inside the record ('latch' hits 'latches'), but the
 *  record's own extracted term is the full inflected word — one-directional
 *  matching here would let the earlier floor COUNT an inflected pair and this
 *  floor SILENCE it, failing closed on a technicality. So a central term is
 *  covered when it and a prompt word prefix each other, either direction. */
/** The PRE-UNION central set: the top-K terms of the record's narrow text, and
 *  nothing else. At most topK entries, always. This is the set the H20 strict
 *  DENY rung evaluates (hasFullNarrowCentralityCoverage below) — it must never
 *  silently acquire the title arm, because a LARGER central set makes full
 *  coverage a WEAKER per-term demand and that rung blocks a user's question. */
function narrowCentralTerms(record: AxisRecord, topK: number): string[] {
  return extractAxisTerms(axisNarrowText(record), topK);
}

/** The RETRIEVAL central set: the narrow top-K UNIONED with the top-K terms of
 *  the record's own subject line (axisTitleText) — decision 00b23915, so a long
 *  statement can no longer crowd out the principle in its own title. Up to 2*topK
 *  entries. Narrow-first, so the existing frequency order is preserved and only
 *  genuinely new subject terms are appended. Used by the two RECALL-side
 *  functions below (preflight, the H19/H20 loose audit) and by nothing else —
 *  the union's purpose is retrieval and ranking, never deny eligibility.
 *  NO-OP for feature_article / research_finding / disconfirmed_hypothesis; see
 *  the limitation on axisTitleText. */
function unionCentralTerms(record: AxisRecord, topK: number): string[] {
  return [
    ...new Set([...narrowCentralTerms(record, topK), ...extractAxisTerms(axisTitleText(record), topK)]),
  ];
}

/** Which of `central` the outgoing text covers, by symmetric prefix match. */
function coveredCentralTerms(central: string[], outgoingText: unknown): string[] {
  const words = [
    ...new Set(
      String(outgoingText ?? '')
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((w) => w.length >= AXIS_MIN_TERM_LEN)
    ),
  ];
  if (!words.length) return [];
  return central.filter((c) => words.some((w) => w.startsWith(c) || c.startsWith(w)));
}

export function recordCentralityHits(record: AxisRecord, outgoingText: unknown, opts: CentralityOpts = {}): string[] {
  const topK = opts.topK ?? AXIS_RECORD_TOP_K;
  return coveredCentralTerms(unionCentralTerms(record, topK), outgoingText);
}

export function hasRecordCentralityHit(record: AxisRecord, outgoingText: unknown, opts: CentralityOpts = {}): boolean {
  const topK = opts.topK ?? AXIS_RECORD_TOP_K;
  const minTerms = opts.minTerms ?? AXIS_MIN_RECORD_TERMS;
  const central = unionCentralTerms(record, topK);
  const covered = coveredCentralTerms(central, outgoingText);
  // A terse record scales the requirement down to what it can offer (one
  // extractable own term needs only that one present). Zero extractable terms
  // passes vacuously — NOT provably unreachable (a narrow text of pure
  // stopwords can in principle clear the earlier floors via prefix matches
  // into its raw tokens; review finding 3), but the deliberate direction here
  // is fail-open: this floor removes noise, it never manufactures silence.
  // Known limit (review finding 1, accepted): a record with <= topK extractable
  // own terms makes EVERY term central, so the floor only bites on verbose
  // records — frequency cannot discriminate where there is no repetition.
  // THE TITLE UNION CANNOT RAISE THIS BAR at the ordinary minTerms=2 floor:
  // axisTitleText's terms are drawn from text that is a SUBSET of
  // axisNarrowText for every type, so (a) a terse record — <= topK extractable
  // narrow terms — already has every one of them central, hence the union adds
  // nothing and central.length is unchanged; (b) a verbose record already has
  // central.length === topK >= minTerms, so Math.min() is already pinned at
  // minTerms and growth cannot move it. The requirement therefore never rises
  // from 1 to 2 for a terse record.
  //
  // THE UNION *DOES* WEAKEN THE PER-TERM DEMAND WHENEVER central.length EXCEEDS
  // minTerms — Math.min() then caps the requirement at minTerms while the set it
  // is drawn from has grown to as many as 2*topK, i.e. "any minTerms of a bigger
  // set". That is acceptable HERE, where this floor only decides whether to
  // SHOW a record. It is NOT acceptable at H20's AskUserQuestion deny rung,
  // which EXITS 2 and blocks a question from ever reaching the user: there,
  // firing more readily is fail-CLOSED toward the user, not fail-open, and a
  // weaker demand means MORE false denials. That rung therefore does not call
  // this function at all — it calls hasFullNarrowCentralityCoverage below,
  // which has no minTerms knob and no title arm.

  return covered.length >= Math.min(minTerms, central.length);
}

/** FULL coverage of the record's PRE-UNION narrow top-K — every one of its own
 *  dominant narrow terms present in the outgoing text, not merely most of them.
 *  The H20 AskUserQuestion DENY rung's centrality floor (scripts/hooks/
 *  h20-mechanism-axis.mjs), and deliberately a SEPARATE function rather than an
 *  option on hasRecordCentralityHit:
 *   - it takes NO minTerms, so the requirement cannot be tuned down by a caller;
 *   - it takes NO union flag, so a future caller cannot reach the union here by
 *     accident — a default that silently unioned is exactly how the deny rung
 *     was weakened once already (both reviewers, 2026-08-30).
 *  Because narrowCentralTerms yields at most topK entries, `>= central.length`
 *  is literally full coverage — no Math.min() trick, and identical to the
 *  behaviour that shipped before the title union existed. Zero extractable
 *  terms still passes vacuously (0 >= 0), unchanged. */
export function hasFullNarrowCentralityCoverage(
  record: AxisRecord,
  outgoingText: unknown,
  opts: { topK?: number } = {}
): boolean {
  const central = narrowCentralTerms(record, opts.topK ?? AXIS_RECORD_TOP_K);
  return coveredCentralTerms(central, outgoingText).length >= central.length;
}
