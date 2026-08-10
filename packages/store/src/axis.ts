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
 *  turn this into noise. */
export function axisNarrowText(record: AxisRecord | null | undefined): string {
  if (!record || typeof record !== 'object') return '';
  if (record.type === 'anti_pattern') return `${record.title ?? ''}\n${record.trigger ?? ''}`;
  if (record.type === 'decision') return `${record.title ?? ''}\n${record.statement ?? ''}`;
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
export function recordCentralityHits(record: AxisRecord, outgoingText: unknown, opts: CentralityOpts = {}): string[] {
  const topK = opts.topK ?? AXIS_RECORD_TOP_K;
  const central = extractAxisTerms(axisNarrowText(record), topK);
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

export function hasRecordCentralityHit(record: AxisRecord, outgoingText: unknown, opts: CentralityOpts = {}): boolean {
  const topK = opts.topK ?? AXIS_RECORD_TOP_K;
  const minTerms = opts.minTerms ?? AXIS_MIN_RECORD_TERMS;
  const central = extractAxisTerms(axisNarrowText(record), topK);
  const covered = recordCentralityHits(record, outgoingText, { topK });
  // A terse record scales the requirement down to what it can offer (one
  // extractable own term needs only that one present). Zero extractable terms
  // passes vacuously — NOT provably unreachable (a narrow text of pure
  // stopwords can in principle clear the earlier floors via prefix matches
  // into its raw tokens; review finding 3), but the deliberate direction here
  // is fail-open: this floor removes noise, it never manufactures silence.
  // Known limit (review finding 1, accepted): a record with <= topK extractable
  // own terms makes EVERY term central, so the floor only bites on verbose
  // records — frequency cannot discriminate where there is no repetition.
  return covered.length >= Math.min(minTerms, central.length);
}
