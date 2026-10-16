// knowledge_move (GitHub issue #110, decision move-a-record-between-domains-with-knowledge-move-same-id)
// through the real SterlingTools surface over a project plus two mounted domains. The store-level
// mechanics and crash states are pinned in packages/store/src/tests/record-move.test.ts; this file
// pins the tool's policy refusals, its receipt and the recovery run it starts every call with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SterlingStore } from '@sterling/store';
import { harnessMounted } from './test-helpers/mounted-harness.js';
import { SterlingTools, mountedDomainSurface } from '../tools.js';
import { parseConfig } from '@sterling/schemas';

const NOW = '2026-10-16T12:00:00.000Z';

function harness() {
  return harnessMounted(['alpha', 'beta'], { now: NOW, prefix: 'sterling-knowledge-move-' });
}

const decisionFields = (scope: string, title: string) => ({ scope, title, statement: `${title} statement`, alternatives_rejected: [], rationale: 'r' });

test('knowledge_move moves a domain record to another domain under the same id and slug, with versions and links', () => {
  const h = harness();
  try {
    const target = h.tools.knowledgeCreate('decision', decisionFields('domain:beta', 'Beta target')).record;
    const x = h.tools.knowledgeCreate('decision', decisionFields('domain:alpha', 'Move this rule')).record;
    h.tools.knowledgeUpdate(x.id, { rationale: 'second version' });
    h.tools.knowledgeLink(x.id, 'cites', target.id);
    const citer = h.tools.knowledgeCreate('decision', decisionFields('project', 'Project citer')).record;
    h.tools.knowledgeLink(citer.id, 'cites', x.id);
    const before = h.tools.knowledgeGet(x.id) as unknown as { slug: string; version: number };

    const out = h.tools.knowledgeMove(before.slug, 'beta', before.version);
    assert.equal(out.record.id, x.id, 'the id does not change');
    assert.equal(out.from, 'domain:alpha');
    assert.equal(out.to, 'domain:beta');
    assert.deepEqual(out.recovered_moves, []);
    assert.equal(out.record.scope, 'domain:beta');

    const after = h.tools.knowledgeGet(x.id) as unknown as { slug: string; version: number; rationale: string; links: { rel: string; target_id: string }[] };
    assert.equal(after.slug, before.slug);
    assert.equal(after.version, before.version);
    assert.equal(after.rationale, 'second version');
    assert.ok(after.links.some((l) => l.rel === 'cites' && l.target_id === target.id), 'outbound link kept');
    assert.equal(h.store.scopeOfHolder(x.id), 'domain:beta');
    assert.ok(h.store.getRecordVersion(x.id, 1), 'version 1 snapshot moved with the record');
    const citerLinks = (h.tools.knowledgeGet(citer.id) as unknown as { links: { target_id: string }[] }).links;
    assert.ok(citerLinks.some((l) => l.target_id === x.id), 'the inbound edge still names the moved id');
    assert.equal(h.tools.knowledgeGet(citerLinks.find((l) => l.target_id === x.id)!.target_id).id, x.id, 'and it resolves');
  } finally {
    h.cleanup();
  }
});

test('knowledge_move refuses what it cannot carry, with nothing written', () => {
  const h = harness();
  try {
    const x = h.tools.knowledgeCreate('decision', decisionFields('domain:alpha', 'Alpha rule')).record;
    const p = h.tools.knowledgeCreate('decision', decisionFields('project', 'Project rule')).record;
    assert.throws(() => h.tools.knowledgeMove(p.id, 'beta'), /held by the project store.*knowledge_promote/);
    assert.throws(() => h.tools.knowledgeMove(x.id, 'gamma'), /domain 'gamma' is not mounted/);
    assert.throws(() => h.tools.knowledgeMove(x.id, 'alpha'), /already lives in domain:alpha/);
    assert.throws(() => h.tools.knowledgeMove(x.id, 'beta', 7), /version conflict/);

    const survivor = h.tools.knowledgeCreate('decision', decisionFields('domain:alpha', 'Alpha survivor')).record;
    const dup = h.tools.knowledgeCreate('decision', decisionFields('domain:alpha', 'Alpha duplicate')).record;
    h.tools.knowledgeRetire(dup.id, survivor.id);
    assert.throws(() => h.tools.knowledgeMove(dup.id, 'beta'), /not active/);

    const art = h.store.create({
      id: randomUUID(), type: 'feature_article', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null,
      links: [], scope: 'domain:alpha', stack_tags: [], slug: 'misplaced-article', title: 'x', what_it_does: 'x', intended_behavior: 'x',
      files: [{ path: 'src/x.ts', role: 'impl' }], current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1, history: [{ date: NOW, event: 'x' }], live_test_refs: [],
    });
    assert.throws(() => h.tools.knowledgeMove(art.id, 'beta'), /feature_article belongs in the project store/);

    // A live record in beta already using x's slug (written below the tool layer's create check).
    const slug = (h.tools.knowledgeGet(x.id) as unknown as { slug: string }).slug;
    h.store.create({
      id: randomUUID(), type: 'decision', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null,
      links: [], scope: 'domain:beta', stack_tags: [], slug, title: 'Clash', statement: 's', alternatives_rejected: [], rationale: 'r',
    });
    assert.throws(() => h.tools.knowledgeMove(x.id, 'beta'), /slug '.*' is already used in domain:beta/);

    for (const id of [x.id, p.id, dup.id, art.id]) assert.notEqual(h.store.scopeOfHolder(id), 'domain:beta', `${id} did not move`);
  } finally {
    h.cleanup();
  }
});

test('knowledge_move first finishes a move a crash interrupted, and reports it', () => {
  const h = harness();
  try {
    const stranded = h.tools.knowledgeCreate('decision', decisionFields('domain:alpha', 'Stranded rule')).record;
    const next = h.tools.knowledgeCreate('decision', decisionFields('domain:alpha', 'Next rule')).record;
    // Phase 1 alone through a second connection: the state a crash between phases leaves.
    const alpha = new SterlingStore(h.domainDbPath('alpha'));
    const beta = new SterlingStore(h.domainDbPath('beta'));
    try {
      const token = randomUUID();
      beta.importMoveBundle(alpha.claimMoveOut(stranded.id, { token, target: 'beta', at: NOW }), 'domain:beta', { source: 'alpha', at: NOW, token });
    } finally {
      alpha.close();
      beta.close();
    }
    assert.throws(() => h.store.scopeOfHolder(stranded.id), /ambiguous holder/);

    const out = h.tools.knowledgeMove(next.id, 'beta');
    assert.deepEqual(out.recovered_moves, [{ id: stranded.id, from: 'domain:alpha', to: 'domain:beta', outcome: 'completed' }]);
    assert.equal(h.store.scopeOfHolder(stranded.id), 'domain:beta');
    assert.equal(h.store.scopeOfHolder(next.id), 'domain:beta');
    assert.deepEqual(h.tools.knowledgeMove(next.id, 'alpha').recovered_moves, [], 'nothing left to recover; and the move back works');
    assert.equal(h.store.scopeOfHolder(next.id), 'domain:alpha');
  } finally {
    h.cleanup();
  }
});

test('knowledge_move holds expected_version to the copy the protocol takes, not to the earlier tool-layer read', () => {
  const h = harness();
  try {
    const x = h.tools.knowledgeCreate('decision', decisionFields('domain:alpha', 'Raced rule')).record;
    const read = (h.tools.knowledgeGet(x.id) as unknown as { version: number }).version;
    const surface = mountedDomainSurface(h.store);
    // A write lands between the tool's own read and the storage protocol's export.
    const racing = new SterlingTools({
      store: h.store,
      config: parseConfig({ stack_tags: ['alpha', 'beta'] }),
      now: () => NOW,
      newId: randomUUID,
      domains: {
        ...surface,
        moveRecord: (id, domain, at, expected) => {
          h.store.updateRecord(id, { ...h.store.get(id)!, rationale: 'raced edit' });
          return surface.moveRecord(id, domain, at, expected);
        },
      },
    });
    assert.throws(() => racing.knowledgeMove(x.id, 'beta', read), /version conflict/);
    assert.equal(h.store.scopeOfHolder(x.id), 'domain:alpha', 'nothing moved');
  } finally {
    h.cleanup();
  }
});
