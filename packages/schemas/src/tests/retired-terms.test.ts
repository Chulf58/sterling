// The one retired-term matcher (GitHub #188): literal, case-insensitive,
// Unicode-aware outer boundaries, protected quote and blockquote spans,
// history excluded structurally, the rename decision itself skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectRetiredTerms, decisionSchema, findTermOccurrences, replaceRetiredTerms, retiredTermUses, retiredTermsInText, SYSTEM_REASONS, DRAIN_VERBS, WORKER_POLICY_LANES } from '../index.js';

const hits = (text: string, term: string) => findTermOccurrences(text, term).map((o) => [text.slice(o.start, o.end), o.protected]);

test('whole word, case-insensitive, whitespace-tolerant inside the term', () => {
  assert.deepEqual(hits('the north barn and North Barn and NORTH\nBARN', 'North Barn'), [['north barn', false], ['North Barn', false], ['NORTH\nBARN', false]]);
  assert.deepEqual(hits('Northern Barnyard, NorthBarn, North Barns', 'North Barn'), []);
});

test('Unicode boundaries: écurie is a whole word, not a prefix of écuries; plain \\b would get this wrong', () => {
  assert.deepEqual(hits('Une écurie, deux écuries, Écurie.', 'écurie'), [['écurie', false], ['Écurie', false]]);
  assert.deepEqual(hits('xécurie', 'écurie'), []);
});

test('punctuation in the term is literal: C++ matches C++ and not C or C#', () => {
  assert.deepEqual(hits('We use C++ and C++17 but not C or C#.', 'C++'), [['C++', false], ['C++', false]]);
  assert.deepEqual(hits('a.b and axb', 'a.b'), [['a.b', false]]);
  assert.deepEqual(hits('MC++ code', 'C++'), [], 'a leading word character still bounds the term');
});

test('straight and curly double quotes and blockquote lines are protected', () => {
  const text = 'North Barn here; "North Barn" quoted; \u201cNorth Barn\u201d curly;\n> North Barn in a blockquote\n  > North Barn indented quote';
  assert.deepEqual(
    hits(text, 'North Barn').map(([, p]) => p),
    [false, true, true, true, true]
  );
  const r = replaceRetiredTerms(text, [{ term: 'North Barn', replacement: 'Hay Barn' }]);
  assert.equal(r.replaced, 1);
  assert.equal(r.protected, 4);
  assert.ok(r.text.startsWith('Hay Barn here; "North Barn" quoted'));
});

test('retiredTermUses: history excluded structurally, rename decision and superseded records skipped', () => {
  const terms = collectRetiredTerms([
    { id: 'd1', type: 'decision', status: 'active', slug: 'rename', retired_terms: [{ term: 'North Barn', replacement: 'Hay Barn' }] },
    { id: 'd2', type: 'decision', status: 'superseded', retired_terms: [{ term: 'Old Shed', replacement: 'Tool Shed' }] },
  ]);
  assert.deepEqual(terms.map((t) => t.term), ['North Barn'], 'a superseded rename retires nothing');
  const article = { id: 'a1', type: 'feature_article', status: 'active', what_it_does: 'feeds the north barn', history: [{ event: 'North Barn built' }], files: [{ path: 'src/north barn.ts', role: 'North Barn feeder' }] };
  const uses = retiredTermUses(article, terms);
  assert.equal(uses.length, 1);
  assert.deepEqual(uses[0].fields, ['what_it_does', 'files[0].role']);
  assert.deepEqual(retiredTermUses({ ...article, status: 'superseded' }, terms), []);
  assert.deepEqual(retiredTermUses({ id: 'd1', type: 'decision', status: 'active', statement: 'North Barn is now Hay Barn' }, terms), []);
  assert.deepEqual(retiredTermsInText('the "North Barn" only', terms), []);
});

test('registry: retired_terms on decision, retired_term_use registered with a drain verb and a worker lane', () => {
  const base = { id: '00000000-0000-4000-8000-000000000001', type: 'decision', created_at: '2026-10-23T00:00:00.000Z', updated_at: '2026-10-23T00:00:00.000Z', author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' };
  assert.ok(decisionSchema.safeParse({ ...base, retired_terms: [{ term: 'North Barn', replacement: 'Hay Barn' }] }).success);
  assert.equal(decisionSchema.safeParse({ ...base, retired_terms: [] }).success, false);
  assert.equal(decisionSchema.safeParse({ ...base, retired_terms: [{ term: 'x' }] }).success, false);
  assert.ok((SYSTEM_REASONS as readonly string[]).includes('retired_term_use'));
  assert.equal(DRAIN_VERBS.retired_term_use, 'renamed');
  assert.ok((WORKER_POLICY_LANES as readonly string[]).includes('retired_term_use'));
});

test('an occurrence that overlaps a protected span is protected, not only one wholly inside it', () => {
  // The blockquote line is broken mid-term by a newline: still one blockquote paragraph.
  assert.deepEqual(hits('> North\nBarn stays', 'North Barn'), [['North\nBarn', true]]);
  assert.deepEqual(hits('say "go to the North Barn', 'North Barn'), [['North Barn', true]], 'an unclosed quote protects to the end of its paragraph');
  const r = replaceRetiredTerms('> North\nBarn stays', [{ term: 'North Barn', replacement: 'Hay Barn' }]);
  assert.equal(r.text, '> North\nBarn stays');
  assert.equal(r.protected, 1);
});

test('unclosed quotes and blockquotes end at the paragraph, never later', () => {
  const text = 'He said "unclosed North Barn here\n\nNext paragraph about North Barn.';
  assert.deepEqual(hits(text, 'North Barn').map(([, p]) => p), [true, false]);
  const curly = 'She said \u201cunclosed North Barn\n\nLater North Barn.';
  assert.deepEqual(hits(curly, 'North Barn').map(([, p]) => p), [true, false]);
  const bq = '> quoted North Barn\ncontinuation North Barn\n\nPlain North Barn.';
  assert.deepEqual(hits(bq, 'North Barn').map(([, p]) => p), [true, true, false]);
});

test('boundaries work on code points and treat combining marks as part of the word', () => {
  assert.deepEqual(hits('x\u{1D49C}y and \u{1D49C} alone', '\u{1D49C}'), [['\u{1D49C}', false]], 'an astral letter is not found inside a word');
  assert.deepEqual(hits('x\u{1D49C}', '\u{1D49C}'), []);
  // decomposed écurie = e + U+0301; the bare term 'e' must not match the start of it.
  assert.deepEqual(hits('e\u0301curie', 'e'), []);
  assert.deepEqual(hits('un e seul', 'e'), [['e', false]]);
  // the composed term finds the decomposed spelling and the reverse
  assert.deepEqual(hits('une e\u0301curie ici', '\u00e9curie'), [['e\u0301curie', false]]);
  assert.deepEqual(hits('une \u00e9curie ici', 'e\u0301curie'), [['\u00e9curie', false]]);
  assert.deepEqual(hits('e\u0301curies', '\u00e9curie'), [], 'a plural is still a different word');
});

test('a balanced quote that spans paragraphs is protected whole (straight and curly)', () => {
  const straight = 'Intro North Barn.\n\n"North Barn first\n\nNorth Barn second" and North Barn after.';
  assert.deepEqual(hits(straight, 'North Barn').map(([, p]) => p), [false, true, true, false]);
  const curly = 'Intro North Barn.\n\n\u201cNorth Barn first\n\nNorth Barn second\u201d and North Barn after.';
  assert.deepEqual(hits(curly, 'North Barn').map(([, p]) => p), [false, true, true, false]);
  const r = replaceRetiredTerms(straight, [{ term: 'North Barn', replacement: 'Hay Barn' }]);
  assert.equal(r.text, 'Intro Hay Barn.\n\n"North Barn first\n\nNorth Barn second" and Hay Barn after.');
  // A second, unclosed curly opener later on still protects only to the end of its own paragraph.
  const mixed = '\u201cclosed North Barn\u201d\n\n\u201cunclosed North Barn\n\nPlain North Barn.';
  assert.deepEqual(hits(mixed, 'North Barn').map(([, p]) => p), [true, true, false]);
});

test('replacement contains the term (Barn -> North Barn): the new name is resolved, never a use or a rewrite', () => {
  const rename = [{ term: 'Barn', replacement: 'North Barn' }];
  assert.deepEqual(findTermOccurrences('North Barn holds hay; the Barn is red.', 'Barn', 'North Barn').map((o) => o.resolved), [true, false]);
  const r = replaceRetiredTerms('North Barn holds hay; the Barn is red.', rename);
  assert.equal(r.text, 'North Barn holds hay; the North Barn is red.');
  assert.equal(r.replaced, 1);
  assert.equal(replaceRetiredTerms(r.text, rename).replaced, 0, 'idempotent: the rewritten text owes nothing');
  const terms = collectRetiredTerms([{ id: 'd', type: 'decision', status: 'active', retired_terms: rename }]);
  assert.deepEqual(retiredTermUses({ id: 'a', type: 'decision', status: 'active', statement: 'North Barn holds hay.' }, terms), []);
  assert.deepEqual(retiredTermsInText('north barn holds hay', terms), [], 'resolution is case-insensitive like the term');
});

test('term contains the replacement (North Barn -> Barn): the shorter new name is not mistaken for the old one', () => {
  const rename = [{ term: 'North Barn', replacement: 'Barn' }];
  const r = replaceRetiredTerms('Feed in North Barn; the Barn is red.', rename);
  assert.equal(r.text, 'Feed in Barn; the Barn is red.');
  assert.equal(replaceRetiredTerms(r.text, rename).replaced, 0);
});

test('a case-only rename still finds the old spelling', () => {
  const rename = [{ term: 'north barn', replacement: 'North Barn' }];
  const r = replaceRetiredTerms('the north barn and the North Barn', rename);
  assert.equal(r.text, 'the North Barn and the North Barn');
  assert.equal(r.replaced, 1);
});
