import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldSearchText } from '../search-fold.js';

// The fold is the normalization policy of Postgres search (decision
// postgres-search-ranking-per-query-idf-no-stats-triggers). These pins are the
// policy: a change to any expected string below is a change of policy.

const fold = foldSearchText;

test('lowercases and keeps a phrase as separate words in order', () => {
  assert.equal(fold('Review Sparsely Before Commit'), 'review sparsely before commit');
  assert.equal(fold('"Exact Phrase"'), 'exact phrase');
});

test('repeated words are kept: the fold is not a de-duplicator, term frequency is the ranker\'s input', () => {
  assert.equal(fold('aa bb aa xx bb'), 'aa bb aa xx bb');
  assert.equal(fold('Fold FOLD fold'), 'fold fold fold');
});

test('a prefix stem loses its star; the caller turns a trailing star into :* on the last word', () => {
  assert.equal(fold('deliver*'), 'deliver');
  assert.equal(fold('store sch*'), 'store sch');
  assert.equal(fold('*'), '');
});

test('Danish: å, é and the like lose their mark; æ, ø and ß stay', () => {
  assert.equal(fold('på'), 'pa');
  assert.equal(fold('Århus'), 'arhus');
  assert.equal(fold('blåbærgrød'), 'blabærgrød');
  assert.equal(fold('ærø'), 'ærø');
  assert.equal(fold('øl'), 'øl');
  assert.equal(fold('Ærø Øl'), 'ærø øl');
  assert.equal(fold('Straße'), 'straße');
});

test('other Latin marks: é, ü, ï, ñ, ç and stacked marks all reduce to the base letter', () => {
  assert.equal(fold('café'), 'cafe');
  assert.equal(fold('Über'), 'uber');
  assert.equal(fold('naïve'), 'naive');
  assert.equal(fold('Pequeño Façade'), 'pequeno facade');
  assert.equal(fold('ǻ'), 'a');
  assert.equal(fold('ộ'), 'o', 'unicode61 keeps this mark; the fold does not claim parity with it');
});

test('a mark written as a separate code point folds the same as the precomposed letter', () => {
  assert.equal(fold('a\u030a'), fold('å'));
  assert.equal(fold('Cafe\u0301'), 'cafe');
  assert.equal(fold('\u0130stanbul'), 'istanbul', 'capital dotted I lowercases to i plus a mark, and the mark goes');
});

test('letters with no decomposition are kept', () => {
  assert.equal(fold('Łódź'), 'łodz');
  assert.equal(fold('Đorđe'), 'đorđe');
});

test('non-Latin letters keep their marks and come back composed', () => {
  assert.equal(fold('Йога'), 'йога');
  assert.equal(fold('\u0438\u0306'), '\u0439', 'и plus a breve recomposes to й');
  assert.equal(fold('한글'), '한글');
  assert.equal(fold('日本語 テスト'), '日本語 テスト');
});

test('digits stay and private-use characters count as token characters', () => {
  assert.equal(fold('Item 4 of 0.18.89'), 'item 4 of 0 18 89');
  assert.equal(fold('\uE000x'), '\uE000x');
});

test('punctuation and symbols become word breaks, including in paths and identifiers', () => {
  assert.equal(fold('scripts/knowledge-eval.mjs'), 'scripts knowledge eval mjs');
  assert.equal(fold('packages/store/src/index.ts:3856'), 'packages store src index ts 3856');
  assert.equal(fold("don't stop_now"), 'don t stop now');
  assert.equal(fold('a,b;c(d)[e]{f}'), 'a b c d e f');
  assert.equal(fold('C:\\Users\\cuj'), 'c users cuj');
  assert.equal(fold('x+y=z \u2014 w'), 'x y z w');
});

test('emoji and other symbols are separators', () => {
  assert.equal(fold('ship \u{1F680} it'), 'ship it');
  assert.equal(fold('\u{1F680}'), '');
  assert.equal(fold('a\u{1F468}\u200D\u{1F469}b'), 'a b');
});

test('empty and whitespace-only input fold to the empty string', () => {
  assert.equal(fold(''), '');
  assert.equal(fold(' '), '');
  assert.equal(fold(' \t\r\n  '), '');
  assert.equal(fold('\u00A0\u2003'), '');
});

test('runs of whitespace collapse to one space and the ends are trimmed', () => {
  assert.equal(fold('  a \t\n b   c  '), 'a b c');
  assert.equal(fold('a --- b'), 'a b');
});

test('NUL is a separator, so it can never reach Postgres text', () => {
  assert.equal(fold('a\u0000b'), 'a b');
  assert.equal(fold('\u0000'), '');
  assert.equal(fold('\u0000\u0000x\u0000'), 'x');
  assert.ok(!fold('before\u0000after').includes('\u0000'));
});

test('the fold is idempotent', () => {
  for (const s of ['Blåbærgrød på Ærø!', 'scripts/knowledge-eval.mjs', '\u0130stanbul \u{1F680} Йога', ' a  b ', '']) {
    assert.equal(fold(fold(s)), fold(s), JSON.stringify(s));
  }
});
