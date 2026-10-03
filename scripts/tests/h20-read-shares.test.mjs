// H20's display caps follow the per-store read shares (user ruling
// h20-subject-fan-applies-domain-read-shares, board 817b16bc): each store's
// candidates are ranked on their own and allocateShares splits the hazard,
// decision and article caps, project first. Before this, one sort by hit count
// across every store let domain records with more hits take every slot.
// Compose-level: the store is a stand-in that returns records tagged
// source_store the way the subject fan tags them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeMechanismAxis } from '../hooks/lib/axis-compose.mjs';

const PROMPT = 'Rewire the flux capacitor manifold coupling and recalibrate the plasma injector before the turbine spins.';
// Narrow-field text: the project record hits three prompt terms, a domain record six.
const FEW = 'flux capacitor manifold';
const MANY = 'flux capacitor manifold coupling plasma injector';

const base = (type, source, n, extra) => ({
  id: randomUUID(), type, lifecycle: 'live', freshness: 'fresh', version: 1, status: 'active', superseded_by: null,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', source_store: source, slug: `${source}-${type.replace('_', '-')}-${n}`, ...extra,
});
const hazard = (source, n, words, extra = {}) =>
  base('anti_pattern', source, n, { title: `${source} hazard ${n}: ${words}`, trigger: `Working on the ${words} (${source} ${n})`, right_way: `Right way ${source} ${n}.`, severity: 'warn', ...extra });
const decision = (source, n, words) =>
  base('decision', source, n, { title: `${source} decision ${n}: ${words}`, statement: `Ruling on the ${words} (${source} ${n}).`, alternatives_rejected: [], authority: 'standing' });
const article = (source, n, words) =>
  base('feature_article', source, n, { title: `${source} article ${n}: ${words}`, what_it_does: `Covers the ${words}.`, files: [] });

function compose(records) {
  const root = mkdtempSync(join(tmpdir(), 'h20-shares-'));
  try {
    const store = {
      query: ({ types }) => records.filter((r) => types.includes(r.type)),
      inboundSupersedes: () => [],
    };
    const composed = composeMechanismAxis(store, {
      root, outgoing: PROMPT, toolInput: { prompt: PROMPT, subagent_type: 'implementor' }, surface: 'dispatch', subagentType: 'implementor', guardFor: () => ({}), host: 'claude',
    });
    assert.ok(composed, 'H20 composed a carriage');
    return composed.assembled.text;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const at = (text, r) => text.indexOf(r.id.slice(0, 8));

test('hazards: a project hazard with fewer hits than three domain hazards keeps a slot and leads', () => {
  const mine = hazard('project', 1, FEW);
  const theirs = [1, 2, 3].map((n) => hazard('sterling', n, MANY));
  const text = compose([mine, ...theirs]);
  assert.ok(text.includes(`(full record: knowledge_get ${mine.id})`), 'the project hazard is rendered whole');
  assert.ok(text.includes('RIGHT WAY: Right way project 1.'));
  assert.ok(at(text, theirs[0]) > at(text, mine) && at(text, theirs[1]) > at(text, mine), 'two domain hazards follow as lines');
  assert.equal(at(text, theirs[2]), -1, 'the third domain hazard is the one the cap drops');
  assert.match(text, /1 more hazard\(s\) NOT shown \(cap 3\)/);
});

test('hazards: a more severe domain hazard still leads, because severity is a record field and not a cross-store score', () => {
  const mine = hazard('project', 1, FEW);
  const block = hazard('sterling', 1, MANY, { severity: 'block' });
  const text = compose([mine, block, hazard('sterling', 2, MANY)]);
  assert.ok(text.includes(`(full record: knowledge_get ${block.id})`), 'the block-severity domain hazard is the whole lead');
  assert.ok(at(text, mine) > at(text, block), 'the project hazard follows as a line');
});

test('hazards: a domain share the domain does not use spills back to the project', () => {
  const mine = [1, 2, 3, 4].map((n) => hazard('project', n, FEW));
  const text = compose(mine);
  for (const h of mine.slice(0, 3)) assert.notEqual(at(text, h), -1);
  assert.equal(at(text, mine[3]), -1);
});

test('decisions: a project decision with fewer hits than five domain decisions keeps a pointer', () => {
  const mine = decision('project', 1, FEW);
  const theirs = [1, 2, 3, 4, 5].map((n) => decision('sterling', n, MANY));
  const text = compose([mine, ...theirs]);
  assert.notEqual(at(text, mine), -1, 'the project decision is shown');
  assert.ok(theirs.slice(0, 4).every((d) => at(text, d) > at(text, mine)), 'four domain decisions follow it');
  assert.equal(at(text, theirs[4]), -1, 'the fifth domain decision is the one the cap drops');
  assert.match(text, /DECISIONS for this subject \(6\)/);
});

test('articles: a project article with fewer hits than three domain articles keeps a pointer', () => {
  const mine = article('project', 1, FEW);
  const theirs = [1, 2, 3].map((n) => article('sterling', n, MANY));
  const text = compose([mine, ...theirs]);
  assert.notEqual(at(text, mine), -1, 'the project article is shown');
  assert.ok(at(text, theirs[0]) > at(text, mine) && at(text, theirs[1]) > at(text, mine));
  assert.equal(at(text, theirs[2]), -1);
  assert.match(text, /ARTICLES matching this prompt's SUBJECT \(4\)/);
});

test('two domains: shares follow the order the stores first appear in, project first', () => {
  const mine = hazard('project', 1, FEW);
  const node = hazard('node', 1, MANY);
  const sterling = [1, 2].map((n) => hazard('sterling', n, MANY));
  const text = compose([mine, node, ...sterling]);
  // cap 3: project quota 2 (uses 1), one each for node and sterling, no spare.
  assert.ok(at(text, mine) !== -1 && at(text, node) > at(text, mine) && at(text, sterling[0]) > at(text, node));
  assert.equal(at(text, sterling[1]), -1);
});
