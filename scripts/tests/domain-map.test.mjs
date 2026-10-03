// The domain map (scripts/lib/domain-map.mjs): the join of the domain stores a
// user has on the machine with the registered projects' stack tags, and the
// proposal for the current project (decision
// consumers-learn-domain-mounting-from-agents-md-and-a-domain-check-command).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDomainMap, renderDomainMap, MAP_LIMITS } from '../lib/domain-map.mjs';

const store = (name, over = {}) => ({ name, path: `/home/u/.sterling/domains/${name}/sterling.db`, description: `${name} facts`, format: 'current', unreadable: null, ...over });
const project = (name, tags, over = {}) => ({ name, path: `/work/${name}`, stack_tags: tags, exists: true, ...over });
const current = (name, tags, over = {}) => ({ name, path: `/work/${name}`, stack_tags: tags, ...over });
const domain = (map, name) => map.domains.find((d) => d.name === name);

test('the join: a domain two projects mount, one nobody mounts, a tag with no store, an undescribed and an old-format store', () => {
  const map = buildDomainMap({
    stores: [store('node'), store('sterling'), store('orphan'), store('bare', { description: null }), store('legacy', { description: null, format: 'old' }), store('broken', { description: null, unreadable: 'file is not a database' })],
    projects: [project('alpha', ['node', 'bare', 'legacy', 'sterling']), project('beta', ['node', 'ghost', 'sterling'])],
    current: current('alpha', ['node', 'bare', 'legacy', 'sterling']),
  });
  assert.deepEqual(domain(map, 'node').mounted_by, ['alpha', 'beta']);
  assert.equal(domain(map, 'node').has_store, true);
  assert.deepEqual(domain(map, 'orphan').mounted_by, []);
  assert.deepEqual(map.unmounted, ['broken', 'orphan']);
  assert.deepEqual(map.tags_without_store, [{ tag: 'ghost', projects: ['beta'] }]);
  assert.equal(domain(map, 'ghost').has_store, false);
  assert.deepEqual(map.undescribed, ['bare'], 'an old-format or unreadable store is reported as that, not as undescribed');
  assert.deepEqual(map.old_format, ['legacy']);
  assert.deepEqual(map.unreadable, [{ name: 'broken', error: 'file is not a database' }]);
  assert.deepEqual(map.domains.map((d) => d.name), ['bare', 'broken', 'ghost', 'legacy', 'node', 'orphan', 'sterling'], 'every store and every tag, by name');
});

test('a registry entry whose path is gone is listed apart and mounts nothing', () => {
  const map = buildDomainMap({
    stores: [store('node'), store('sterling'), store('python')],
    projects: [project('alpha', ['node', 'sterling']), project('gone', ['python', 'node', 'sterling'], { exists: false })],
    current: current('alpha', ['node', 'sterling']),
  });
  assert.deepEqual(map.missing_projects, [{ name: 'gone', path: '/work/gone' }]);
  assert.deepEqual(domain(map, 'node').mounted_by, ['alpha']);
  assert.deepEqual(map.unmounted, ['python']);
  assert.deepEqual(map.siblings, []);
});

test('the current project uses its own live tags and is added when the registry does not list it', () => {
  const map = buildDomainMap({
    stores: [store('node'), store('sterling')],
    projects: [project('beta', ['node', 'sterling'])],
    current: current('alpha', ['node', 'sterling']),
  });
  assert.equal(map.current.registered, false);
  assert.deepEqual(domain(map, 'node').mounted_by, ['alpha', 'beta']);

  const stale = buildDomainMap({
    stores: [store('node'), store('python'), store('sterling')],
    projects: [project('alpha', ['node', 'sterling'])],
    current: current('alpha', ['node', 'python', 'sterling']),
  });
  assert.equal(stale.current.registered, true);
  assert.deepEqual(domain(stale, 'python').mounted_by, ['alpha'], 'the config the project has now wins over the tags the registry recorded at init');
});

test('Salesforce and Genesys each mounting only the other: the proposal is that both mount salesforce and genesys', () => {
  const input = {
    stores: [store('salesforce'), store('genesys'), store('sterling')],
    projects: [project('Salesforce', ['genesys', 'sterling']), project('Genesys', ['salesforce', 'sterling'])],
  };
  const map = buildDomainMap({ ...input, current: current('Salesforce', ['genesys', 'sterling']) });
  assert.deepEqual(map.siblings, [{ name: 'Genesys', path: '/work/Genesys', mounts: ['salesforce', 'sterling'], shared: ['sterling'], shared_subjects: [] }]);
  assert.deepEqual(map.proposal.add.map((a) => a.domain), ['salesforce']);
  assert.equal(map.proposal.add[0].has_store, true);
  assert.match(map.proposal.add[0].reason, /own subject/);
  assert.deepEqual(map.proposal.sibling_steps, [{ project: 'Genesys', path: '/work/Genesys', add: ['genesys'] }]);

  // After both sides apply, each mounts salesforce and genesys and nothing is proposed.
  const both = ['genesys', 'salesforce', 'sterling'];
  const fixed = buildDomainMap({
    stores: input.stores,
    projects: [project('Salesforce', both), project('Genesys', both)],
    current: current('Salesforce', both),
  });
  assert.deepEqual(fixed.siblings[0].shared_subjects, ['genesys', 'salesforce']);
  assert.deepEqual(fixed.proposal, { add: [], sibling_steps: [] });
});

test('the same case seen from the Genesys project, with no salesforce or genesys store yet', () => {
  const map = buildDomainMap({
    stores: [store('sterling')],
    projects: [project('Salesforce', ['genesys', 'sterling']), project('Genesys', ['salesforce', 'sterling'])],
    current: current('Genesys', ['salesforce', 'sterling']),
  });
  assert.deepEqual(map.proposal.add, [{ domain: 'genesys', reason: map.proposal.add[0].reason, has_store: false }]);
  assert.deepEqual(map.proposal.sibling_steps, [{ project: 'Salesforce', path: '/work/Salesforce', add: ['salesforce'] }]);
});

test('a project that already mounts its own subject gets no proposal', () => {
  const map = buildDomainMap({
    stores: [store('salesforce'), store('genesys'), store('sterling')],
    projects: [project('Salesforce', ['salesforce', 'genesys', 'sterling']), project('Genesys', ['salesforce', 'sterling'])],
    current: current('Salesforce', ['salesforce', 'genesys', 'sterling']),
  });
  assert.deepEqual(map.proposal, { add: [], sibling_steps: [] });
});

test('the own-subject match also uses the directory name, case-insensitively, and never proposes sterling', () => {
  const map = buildDomainMap({
    stores: [store('billing'), store('sterling')],
    projects: [project('other', ['billing'])],
    current: { name: 'My Billing App', path: '/work/Billing', stack_tags: ['node'] },
  });
  assert.deepEqual(map.proposal.add.map((a) => a.domain), ['billing']);

  const sterling = buildDomainMap({ stores: [store('sterling')], projects: [], current: current('sterling', ['node']) });
  assert.deepEqual(sterling.proposal.add, [], 'sterling is the universal domain, not a subject to propose');
});

test('projects that overlap only in sterling share nothing', () => {
  const map = buildDomainMap({
    stores: [store('node'), store('python'), store('sterling')],
    projects: [project('alpha', ['node', 'sterling']), project('beta', ['python', 'sterling'])],
    current: current('alpha', ['node', 'sterling']),
  });
  assert.deepEqual(map.siblings[0].shared, ['sterling']);
  assert.deepEqual(map.siblings[0].shared_subjects, []);
  assert.match(renderDomainMap(map), /beta .*\n\s+shares no subject domain with this project \(only 'sterling', which every project mounts\)/);
});

test('the proposal never removes a tag', () => {
  const map = buildDomainMap({
    stores: [store('sterling')],
    projects: [project('alpha', ['ghost', 'unused', 'sterling'])],
    current: current('alpha', ['ghost', 'unused', 'sterling']),
  });
  assert.deepEqual(Object.keys(map.proposal).sort(), ['add', 'sibling_steps']);
  assert.deepEqual(map.proposal.add, []);
});

test('the text names every finding and states the limits', () => {
  const map = buildDomainMap({
    stores: [store('salesforce'), store('orphan'), store('bare', { description: null }), store('legacy', { description: null, format: 'old' }), store('sterling')],
    projects: [project('Salesforce', ['genesys', 'bare', 'legacy', 'sterling']), project('Genesys', ['salesforce', 'sterling']), project('gone', ['node'], { exists: false })],
    current: current('Salesforce', ['genesys', 'bare', 'legacy', 'sterling']),
  });
  const text = renderDomainMap(map, { applyCommand: 'node bin/domains.mjs' });
  assert.match(text, /^Current project: Salesforce \(\/work\/Salesforce\)\n\s+mounts: genesys, bare, legacy, sterling$/m);
  assert.match(text, /^\s+salesforce\s+mounted by: Genesys$/m);
  assert.match(text, /^Stores no project mounts: orphan$/m);
  assert.match(text, /^Tags that name no store: genesys \(Salesforce\)$/m);
  assert.match(text, /^Stores with no description: bare$/m);
  assert.match(text, /^Stores in the old format: legacy$/m);
  assert.match(text, /knowledge_query and knowledge_get fail/);
  assert.match(text, /^Registered projects whose folder is gone \(not counted above\): gone \(\/work\/gone\)$/m);
  assert.match(text, /add 'salesforce'/);
  assert.match(text, /In Genesys \(\/work\/Genesys\): add 'genesys'/);
  assert.match(text, /node bin\/domains\.mjs --apply --add salesforce/);
  for (const limit of MAP_LIMITS) assert.ok(text.includes(limit), `the text states: ${limit}`);
  assert.equal(MAP_LIMITS.length, 3);
  assert.doesNotMatch(text, /—/, 'plain text, no em dashes');
});
