import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitDomains, DOMAIN_FIT_MIN_TERMS } from '../domain-fit.js';

const salesforce = {
  name: 'salesforce',
  description: 'Salesforce CRM platform: accounts, opportunities, Apex triggers, Lightning components',
};
const genesys = {
  name: 'genesys',
  description: 'Genesys Cloud contact center: queues, routing, flows, agents telephony',
};
const sterlingDomain = {
  name: 'sterling',
  description: 'Sterling knowledge store: records, hooks, domains, promotion',
};
const domains = [salesforce, genesys, sterlingDomain];

test('one clear fit returns only that domain, with its score and matched terms', () => {
  const text = 'Apex triggers on Salesforce accounts and opportunities fire twice when a Lightning component saves.';
  const fits = fitDomains(text, domains);
  assert.equal(fits.length, 1);
  assert.equal(fits[0].name, 'salesforce');
  assert.ok(fits[0].score > 0 && fits[0].score <= 1);
  for (const t of ['salesforce', 'accounts', 'opportunities', 'apex', 'triggers']) {
    assert.ok(fits[0].matched.includes(t), `matched includes ${t}`);
  }
});

test('a record about both Salesforce and Genesys fits both, best score first', () => {
  const text =
    'Salesforce opportunities and accounts sync into Genesys Cloud: the Apex trigger creates a routing flow entry for the contact center queues.';
  const fits = fitDomains(text, domains);
  assert.deepEqual(fits.map((f) => f.name).sort(), ['genesys', 'salesforce']);
  assert.ok(fits[0].score >= fits[1].score, 'ordered by score, descending');
});

test('no domain fits an unrelated record', () => {
  assert.deepEqual(fitDomains('Rename the build output directory and bump the version.', domains), []);
});

test('a domain with a missing, null, empty or stopword-only description never fits', () => {
  const text = 'Salesforce accounts and opportunities with Apex triggers.';
  const noDesc = [
    { name: 'a' },
    { name: 'b', description: null },
    { name: 'c', description: '' },
    { name: 'd', description: '   ' },
    { name: 'e', description: 'this that with from' },
  ];
  assert.deepEqual(fitDomains(text, noDesc), []);
});

test('the same input gives the same output, independent of domain order', () => {
  const text = 'Genesys routing flows push contact center queues into Salesforce accounts and opportunities.';
  const a = fitDomains(text, [salesforce, genesys, sterlingDomain]);
  const b = fitDomains(text, [sterlingDomain, genesys, salesforce]);
  assert.deepEqual(a, b);
  assert.deepEqual(a, fitDomains(text, [salesforce, genesys, sterlingDomain]));
});

test('equal scores are ordered by name', () => {
  const x = { name: 'zeta', description: 'alpha beta' };
  const y = { name: 'omega', description: 'alpha beta' };
  assert.deepEqual(fitDomains('alpha beta', [x, y]).map((f) => f.name), ['omega', 'zeta']);
});

test('threshold: the default needs two matched terms, minTerms raises or lowers it', () => {
  assert.equal(DOMAIN_FIT_MIN_TERMS, 2);
  const oneWord = 'The Salesforce limit was hit during the nightly batch.';
  assert.deepEqual(fitDomains(oneWord, domains), [], 'one shared word is coincidence');
  assert.deepEqual(fitDomains(oneWord, domains, { minTerms: 1 }).map((f) => f.name), ['salesforce']);
  const twoWords = 'Salesforce accounts were hit during the nightly batch.';
  assert.deepEqual(fitDomains(twoWords, domains).map((f) => f.name), ['salesforce']);
  assert.deepEqual(fitDomains(twoWords, domains, { minTerms: 3 }), []);
});

test('threshold scales down for a short description so it can still fit', () => {
  const terse = { name: 'genesys', description: 'Genesys' };
  assert.deepEqual(fitDomains('Genesys outage during the weekend.', [terse]).map((f) => f.name), ['genesys']);
});

test('terms match across inflections by prefix, in either direction', () => {
  const d = { name: 'crm', description: 'trigger accounts' };
  assert.deepEqual(fitDomains('triggers and account', [d]).map((f) => f.name), ['crm']);
});

test('universal dev vocabulary alone never fits a domain', () => {
  const d = { name: 'generic', description: 'test build check output' };
  assert.deepEqual(fitDomains('test build check output', [d]), []);
});

test('exclude drops the named domains, case-insensitively, and does not change the others', () => {
  const text = 'Sterling hooks and records: the promotion of domains happens in the knowledge store.';
  assert.deepEqual(fitDomains(text, domains, { minTerms: 1 }).map((f) => f.name), ['sterling']);
  assert.deepEqual(fitDomains(text, domains, { minTerms: 1, exclude: ['Sterling'] }), []);
});

test('bad input fails loud', () => {
  assert.throws(() => fitDomains(undefined as never, domains), TypeError);
  assert.throws(() => fitDomains(42 as never, domains), TypeError);
  assert.throws(() => fitDomains('text', 'nope' as never), TypeError);
  assert.throws(() => fitDomains('text', [{ name: '', description: 'x' }]), TypeError);
  assert.throws(() => fitDomains('text', [{ name: 'a', description: 7 as never }]), TypeError);
  assert.throws(() => fitDomains('text', [null as never]), TypeError);
  assert.throws(() => fitDomains('text', domains, { minTerms: 0 }), RangeError);
  assert.throws(() => fitDomains('text', domains, { minTerms: 1.5 }), RangeError);
  assert.throws(() => fitDomains('text', domains, { exclude: 'sterling' as never }), TypeError);
});

test('a duplicate domain name throws, even when one copy is excluded or has no description', () => {
  assert.throws(() => fitDomains('text', [salesforce, { ...salesforce }]), /duplicate domain name 'salesforce'/);
  assert.throws(() => fitDomains('text', [salesforce, { name: 'Salesforce' }]), /duplicate/);
  assert.throws(() => fitDomains('text', [sterlingDomain, { name: 'sterling' }], { exclude: ['sterling'] }), /duplicate/);
});
