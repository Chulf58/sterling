// The search-text fold for Postgres search (decision
// postgres-search-ranking-per-query-idf-no-stats-triggers, item 4): the one
// normalization applied to record text at every write site and to every query
// term, so a stored token and a searched token meet in the same form.
//
// The policy, in order:
//   1. lowercase;
//   2. decompose (NFD) and drop the combining marks that follow a Latin letter
//      (å -> a, é -> e, ü -> u, ï -> i). Letters that have no decomposition stay
//      as they are: æ, ø and ß, and also đ, ł, ð and the like. A mark after a
//      non-Latin letter is kept, and the string is recomposed (NFC) so й, or a
//      Hangul syllable, comes back whole;
//   3. every character outside \p{L}\p{N}\p{Co} becomes a space. Punctuation,
//      symbols, emoji, control characters and NUL all end up here, so U+0000
//      never reaches Postgres text;
//   4. runs of whitespace collapse to one space and the ends are trimmed.
//
// This is a tested normalization policy, not a claim of parity with SQLite's
// unicode61 tokenizer (which keeps some marks, e.g. the dot below in ộ).
// Pure: no I/O, no imports.

const LATIN_LETTER = /^\p{Script=Latin}$/u;
const LETTER_OR_NUMBER_OR_PRIVATE = /^[\p{L}\p{N}\p{Co}]$/u;
const COMBINING_MARK = /^\p{M}$/u;

export function foldSearchText(s: string): string {
  let kept = '';
  let afterLatinLetter = false;
  for (const ch of s.toLowerCase().normalize('NFD')) {
    if (COMBINING_MARK.test(ch)) {
      if (!afterLatinLetter) kept += ch;
      continue;
    }
    afterLatinLetter = LATIN_LETTER.test(ch) && /^\p{L}$/u.test(ch);
    kept += ch;
  }
  let out = '';
  for (const ch of kept.normalize('NFC')) out += LETTER_OR_NUMBER_OR_PRIVATE.test(ch) ? ch : ' ';
  return out.replace(/ {2,}/g, ' ').trim();
}
