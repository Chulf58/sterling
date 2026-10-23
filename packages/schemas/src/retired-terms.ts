// Retired terms (GitHub #188, decision
// retiring-a-renamed-term-a-retired-terms-field-on-the-rename): a decision that
// rules a rename carries `retired_terms: [{term, replacement}]`. This module is
// the ONE matcher every surface uses: knowledge_preflight, H19/H20 delivery,
// the retired_term_use maintenance mint, the maintenance worker's narrow
// rewrite permission and the record-hygiene listing.
//
// Matching (user ruling 3, 'Whole word, skip quotes and history'):
// - the term is a literal (regex metacharacters escaped), matched
//   case-insensitively; a run of whitespace inside the term matches any run of
//   whitespace, so 'North Barn' also finds 'north\nbarn';
// - the OUTER boundaries are Unicode-aware: an edge of the term that is a
//   letter, digit or underscore must not touch another one, so 'écurie' is not
//   found inside 'écuries' and 'C++' is found in 'C++ code' (plain \b gets
//   both wrong);
// - protected spans are text inside straight or curly double quotes and
//   blockquote lines (a line starting with '>'); an occurrence there is
//   counted but never reported as a use and never rewritten;
// - history entries are excluded structurally (the field is never scanned),
//   and so is the rename decision itself and any superseded or retired record.
import { z } from 'zod';

export const retiredTermSchema = z
  .object({
    term: z.string().trim().min(1),
    replacement: z.string().trim().min(1),
  })
  .strict();
export type RetiredTermEntry = z.infer<typeof retiredTermSchema>;

/** A retired term together with the decision that retired it. */
export interface RetiredTerm extends RetiredTermEntry {
  decision_id: string;
  decision_slug?: string;
}

export interface TermOccurrence {
  start: number;
  end: number;
  protected: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** The regex that finds `term` as a whole word (global, case-insensitive, Unicode). */
export function retiredTermRegex(term: string): RegExp {
  const t = term.trim();
  const body = t
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const lead = WORD_CHAR.test(t[0] ?? '') ? '(?<![\\p{L}\\p{N}_])' : '';
  const trail = WORD_CHAR.test(t[t.length - 1] ?? '') ? '(?![\\p{L}\\p{N}_])' : '';
  return new RegExp(`${lead}${body}${trail}`, 'giu');
}

/** [start, end) ranges of quoted text and blockquote lines. */
export function protectedSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const re of [/"[^"]*"/g, /\u201c[^\u201d]*\u201d/g, /^[ \t]*>.*$/gm]) {
    for (const m of text.matchAll(re)) spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return spans;
}

/** Every whole-word occurrence of `term` in `text`, each marked protected or not. */
export function findTermOccurrences(text: string, term: string): TermOccurrence[] {
  if (!text || !term.trim()) return [];
  const spans = protectedSpans(text);
  const out: TermOccurrence[] = [];
  for (const m of text.matchAll(retiredTermRegex(term))) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    out.push({ start, end, protected: spans.some(([s, e]) => start >= s && end <= e) });
  }
  return out;
}

/**
 * `text` with every unprotected occurrence of each term replaced by its
 * replacement. `replaced` counts the rewrites, `protected` the occurrences
 * left alone because they sit in a quote or a blockquote line.
 */
export function replaceRetiredTerms(text: string, terms: readonly RetiredTermEntry[]): { text: string; replaced: number; protected: number } {
  let out = text;
  let replaced = 0;
  let kept = 0;
  for (const { term, replacement } of terms) {
    const occ = findTermOccurrences(out, term);
    kept += occ.filter((o) => o.protected).length;
    const hits = occ.filter((o) => !o.protected);
    replaced += hits.length;
    for (const o of [...hits].reverse()) out = out.slice(0, o.start) + replacement + out.slice(o.end);
  }
  return { text: out, replaced, protected: kept };
}

/**
 * Top-level fields never scanned: history (excluded structurally by the
 * ruling), the rename field itself, and identity, lifecycle and path fields,
 * which are not prose.
 */
export const RETIRED_TERM_SKIPPED_FIELDS: ReadonlySet<string> = new Set([
  'history',
  'retired_terms',
  'id',
  'type',
  'slug',
  'status',
  'scope',
  'author',
  'version',
  'created_at',
  'updated_at',
  'superseded_by',
  'links',
  'file_keys',
  'file_baselines',
  'aliases',
  'stack_tags',
  'source_date',
  'capture_date',
  'location',
]);
/** Keys skipped at any depth: paths and ids inside arrays of objects. */
const NESTED_SKIPPED_KEYS: ReadonlySet<string> = new Set(['path', 'id', 'ac_id', 'target_id']);

/**
 * The fields the maintenance worker may rewrite on a retired_term_use item, by
 * record type (decision titles and statements, article text). Every other
 * field holding the term is handed back to the conductor.
 */
export const RETIRED_TERM_REWRITE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  decision: ['title', 'statement'],
  feature_article: ['title', 'what_it_does', 'intended_behavior'],
};

/** Every scanned string leaf of a record, as [field path, text]. */
export function retiredTermScanFields(record: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'string') out.push([path, value]);
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (!NESTED_SKIPPED_KEYS.has(k)) walk(v, `${path}.${k}`);
    }
  };
  for (const [k, v] of Object.entries(record)) if (!RETIRED_TERM_SKIPPED_FIELDS.has(k)) walk(v, k);
  return out;
}

/** The active retired terms the given decisions carry (superseded and retired decisions are skipped). */
export function collectRetiredTerms(decisions: readonly unknown[]): RetiredTerm[] {
  const out: RetiredTerm[] = [];
  for (const d of decisions as Record<string, unknown>[]) {
    if (!d || d.type !== 'decision' || (d.status !== undefined && d.status !== 'active')) continue;
    if (!Array.isArray(d.retired_terms)) continue;
    for (const entry of d.retired_terms) {
      const parsed = retiredTermSchema.safeParse(entry);
      if (!parsed.success) continue;
      out.push({ ...parsed.data, decision_id: String(d.id), ...(typeof d.slug === 'string' ? { decision_slug: d.slug } : {}) });
    }
  }
  return out;
}

export interface RetiredTermUse {
  term: string;
  replacement: string;
  decision_id: string;
  decision_slug?: string;
  /** Field paths holding an unprotected use. */
  fields: string[];
  /** Occurrences left alone in quotes or blockquotes. */
  protected: number;
}

/**
 * The retired terms `record` still uses outside protected spans. A superseded
 * or retired record, and the decision that retired a term, report nothing for
 * that term.
 */
export function retiredTermUses(record: Record<string, unknown>, terms: readonly RetiredTerm[]): RetiredTermUse[] {
  if (record.status !== undefined && record.status !== 'active') return [];
  const fields = retiredTermScanFields(record);
  const out: RetiredTermUse[] = [];
  for (const t of terms) {
    if (t.decision_id === record.id) continue;
    const hitFields: string[] = [];
    let kept = 0;
    for (const [path, text] of fields) {
      const occ = findTermOccurrences(text, t.term);
      kept += occ.filter((o) => o.protected).length;
      if (occ.some((o) => !o.protected)) hitFields.push(path);
    }
    if (hitFields.length) out.push({ term: t.term, replacement: t.replacement, decision_id: t.decision_id, ...(t.decision_slug ? { decision_slug: t.decision_slug } : {}), fields: hitFields, protected: kept });
  }
  return out;
}

/** The retired terms a free text (a brief, a question, a record being written) uses outside protected spans. */
export function retiredTermsInText(text: string, terms: readonly RetiredTerm[]): RetiredTerm[] {
  return terms.filter((t) => findTermOccurrences(text, t.term).some((o) => !o.protected));
}

/** One advisory line per retired term found in a text. */
export function retiredTermWarning(t: RetiredTerm): string {
  return `retired term '${t.term}': renamed to '${t.replacement}' by decision ${t.decision_slug ?? t.decision_id} (knowledge_get ${t.decision_id}); use '${t.replacement}' unless you are quoting.`;
}
