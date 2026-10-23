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
//   whitespace, so 'North Barn' also finds 'north\nbarn'. The term is matched
//   in both its NFC and NFD forms, so a composed term finds decomposed text;
// - the OUTER boundaries are Unicode-aware and work on code points: an edge of
//   the term that is a letter, digit, combining mark or underscore must not
//   touch another one, so 'écurie' is not found inside 'écuries' (or 'e' at
//   the start of a decomposed 'écurie'), 'C++' is found in 'C++ code', and an
//   astral letter such as '𝒜' is not found inside 'x𝒜y' (plain \b and
//   UTF-16 indexing get all of these wrong);
// - protected spans (see protectedSpans) are text inside double quotes and
//   blockquotes. An occurrence that overlaps a protected span at all is
//   protected: it is counted but never reported as a use and never rewritten;
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
  /** Inside an occurrence of the replacement: already the new name. */
  resolved: boolean;
}

// \p{M}: a combining mark continues the word it follows.
const WORD_CLASS = String.raw`\p{L}\p{N}\p{M}_`;
const WORD_CHAR = new RegExp(`[${WORD_CLASS}]`, 'u');

/** The regex that finds `term` as a whole word (global, case-insensitive, Unicode, code-point based). */
export function retiredTermRegex(term: string): RegExp {
  const trimmed = term.trim();
  const variants = [...new Set([trimmed.normalize('NFC'), trimmed.normalize('NFD')])];
  const alternatives = variants.map((t) => {
    const points = Array.from(t);
    const body = t
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    const lead = WORD_CHAR.test(points[0] ?? '') ? `(?<![${WORD_CLASS}])` : '';
    const trail = WORD_CHAR.test(points[points.length - 1] ?? '') ? `(?![${WORD_CLASS}])` : '';
    return `${lead}${body}${trail}`;
  });
  return new RegExp(`(?:${alternatives.join('|')})`, 'giu');
}

/**
 * [start, end) ranges of protected text:
 * - straight double quotes pair up in order over the WHOLE text, and a curly
 *   opening mark runs to the next closing mark anywhere after it, so a
 *   balanced quotation that spans paragraphs is protected whole;
 * - only an opening quote with no closing partner is bounded: it protects to
 *   the end of its paragraph (a paragraph ends at a blank line). An unclosed
 *   quote is ambiguous about where the quoted words stop, and the safe answer
 *   for a rewrite is to leave them alone and hand the record back, but it must
 *   not silence the rest of the record;
 * - a blockquote line (leading '>') protects from its line start to the end of
 *   its paragraph, since a markdown blockquote carries on over the unmarked
 *   lines that follow it.
 * Pairing over the whole text can mis-pair after a stray quote; that only
 * ever protects MORE text, never less.
 */
export function protectedSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const paragraphEnd = (at: number): number => {
    const sep = /\n[ \t]*\n/g;
    sep.lastIndex = at;
    const m = sep.exec(text);
    return m ? m.index : text.length;
  };
  const straight = [...text.matchAll(/"/g)].map((m) => m.index ?? 0);
  for (let i = 0; i < straight.length; i += 2) spans.push([straight[i], i + 1 < straight.length ? straight[i + 1] + 1 : paragraphEnd(straight[i])]);
  for (let i = text.indexOf('\u201c'); i !== -1; ) {
    const close = text.indexOf('\u201d', i + 1);
    if (close === -1) {
      spans.push([i, paragraphEnd(i)]);
      i = text.indexOf('\u201c', i + 1);
    } else {
      spans.push([i, close + 1]);
      i = text.indexOf('\u201c', close + 1);
    }
  }
  for (const m of text.matchAll(/^[ \t]*>/gm)) {
    const at = m.index ?? 0;
    spans.push([at, paragraphEnd(at)]);
  }
  return spans;
}

/**
 * Every whole-word occurrence of `term` in `text`, each marked protected (it
 * overlaps a quote or blockquote) and resolved (it lies inside a whole-word
 * occurrence of `replacement`, so it IS the new name: with the rename
 * 'Barn' -> 'North Barn', the 'Barn' in 'North Barn' is not an old mention).
 * The replacement is found case-insensitively like the term, except when the
 * rename only changes case ('north barn' -> 'North Barn'): then only the
 * replacement's exact spelling counts as resolved. Only an occurrence that is
 * neither protected nor resolved is a use, is rewritten, and blocks the close
 * of a retired_term_use item.
 */
export function findTermOccurrences(text: string, term: string, replacement?: string): TermOccurrence[] {
  if (!text || !term.trim()) return [];
  const spans = protectedSpans(text);
  const canonical: [number, number][] = [];
  if (replacement?.trim()) {
    const fold = (t: string) => t.normalize('NFC').trim().split(/\s+/).join(' ').toLowerCase();
    const caseOnly = fold(term) === fold(replacement);
    const re = retiredTermRegex(replacement);
    const exact = caseOnly ? new RegExp(re.source, 'gu') : re;
    for (const m of text.matchAll(exact)) canonical.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const out: TermOccurrence[] = [];
  for (const m of text.matchAll(retiredTermRegex(term))) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    out.push({
      start,
      end,
      protected: spans.some(([s, e]) => start < e && s < end),
      resolved: canonical.some(([s, e]) => start >= s && end <= e),
    });
  }
  return out;
}

/** An occurrence that still owes a rewrite: neither quoted nor already the new name. */
const owed = (o: TermOccurrence): boolean => !o.protected && !o.resolved;

/**
 * `text` with every unprotected occurrence of each term replaced by its
 * replacement. `replaced` counts the rewrites, `protected` the occurrences
 * left alone because they sit in a quote or a blockquote line. An occurrence
 * that already lies inside the replacement is neither (findTermOccurrences).
 */
export function replaceRetiredTerms(text: string, terms: readonly RetiredTermEntry[]): { text: string; replaced: number; protected: number } {
  let out = text;
  let replaced = 0;
  let kept = 0;
  for (const { term, replacement } of terms) {
    const occ = findTermOccurrences(out, term, replacement);
    kept += occ.filter((o) => o.protected && !o.resolved).length;
    const hits = occ.filter(owed);
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
      const occ = findTermOccurrences(text, t.term, t.replacement);
      kept += occ.filter((o) => o.protected && !o.resolved).length;
      if (occ.some(owed)) hitFields.push(path);
    }
    if (hitFields.length) out.push({ term: t.term, replacement: t.replacement, decision_id: t.decision_id, ...(t.decision_slug ? { decision_slug: t.decision_slug } : {}), fields: hitFields, protected: kept });
  }
  return out;
}

/** The retired terms a free text (a brief, a question, a record being written) uses outside protected spans. */
export function retiredTermsInText(text: string, terms: readonly RetiredTerm[]): RetiredTerm[] {
  return terms.filter((t) => findTermOccurrences(text, t.term, t.replacement).some(owed));
}

/** One advisory line per retired term found in a text. */
export function retiredTermWarning(t: RetiredTerm): string {
  return `retired term '${t.term}': renamed to '${t.replacement}' by decision ${t.decision_slug ?? t.decision_id} (knowledge_get ${t.decision_id}); use '${t.replacement}' unless you are quoting.`;
}
