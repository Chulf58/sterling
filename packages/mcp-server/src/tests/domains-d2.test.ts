import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { MountedStores, createDomain, type DomainMount } from '@sterling/store';
import { SterlingTools, mountedDomainSurface } from '../tools.js';

// Domains D2, the MCP surface (board 25c0d858; decision
// projects-mount-domains-and-sibling-projects, amended head): knowledge_create
// lists the mounted domains and refuses a domain-scoped record that carries
// repo paths; domain_describe reads and sets a domain's description; the
// promotion_review mint is driven by the description fit; knowledge_promote
// shows the target's description; knowledge_query and knowledge_preflight label
// each record's source store and disclose configured domains that are missing.

const DESCRIPTIONS: Record<string, string> = {
  salesforce: 'Salesforce CRM: Apex triggers, opportunity objects, Lightning flows',
  genesys: 'Genesys Cloud telephony: call routing, IVR queues, Architect flows',
  sterling: 'Sterling plugin: knowledge store, board, hooks, conductor agents',
};

function harness(domains: string[], opts: { missing?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-d2-'));
  const dbPath = (name: string) => join(dir, 'domains', name, 'sterling.db');
  const mounts: DomainMount[] = domains.map((name) => ({ name, dbPath: dbPath(name) }));
  for (const m of mounts) createDomain(m.name, DESCRIPTIONS[m.name] ?? `${m.name} domain`, m.dbPath);
  const missing = (opts.missing ?? []).map((name) => ({ name, dbPath: dbPath(name) }));
  const all = [...mounts, ...missing];
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), all, { skipMissing: true });
  const config = parseConfig({ stack_tags: all.map((m) => m.name) });
  const tools = new SterlingTools({
    store,
    config,
    domains: mountedDomainSurface(store, all),
    now: () => '2026-10-03T12:00:00.000Z',
    newId: randomUUID,
  });
  return {
    store,
    tools,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const decision = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  statement: title,
  alternatives_rejected: [],
  rationale: 'r',
  ...extra,
});

const article = (slug: string, title: string, files: { path: string; role: string }[], extra: Record<string, unknown> = {}) => ({
  slug,
  title,
  what_it_does: title,
  intended_behavior: title,
  files,
  current_ac: [{ ac_id: 'AC1', text: 'works', verifiable_at: 'final' }],
  dependencies: { relies_on: [], relied_by: [] },
  state: 'active',
  version: 1,
  history: [{ date: '2026-10-03T12:00:00.000Z', event: 'originating brief' }],
  live_test_refs: [],
  ...extra,
});

const reviews = (tools: SterlingTools) =>
  tools.maintenanceQuery({ system_reason: 'promotion_review', cap: 100 }) as unknown as { id: string; text: string; feature_link?: string }[];

// -- 1. knowledge_create ------------------------------------------------------

test('knowledge_create lists every mounted domain with its description on the receipt', () => {
  const { tools, cleanup } = harness(['salesforce', 'genesys', 'sterling']);
  try {
    const res = tools.knowledgeCreate('decision', decision('a plain project decision')) as unknown as {
      mounted_domains: { name: string; description: string | null }[];
    };
    assert.deepEqual(res.mounted_domains, [
      { name: 'salesforce', description: DESCRIPTIONS.salesforce },
      { name: 'genesys', description: DESCRIPTIONS.genesys },
      { name: 'sterling', description: DESCRIPTIONS.sterling },
    ]);
  } finally {
    cleanup();
  }
});

test('knowledge_create with no mounted domain carries no mounted_domains key', () => {
  const { tools, cleanup } = harness([]);
  try {
    const res = tools.knowledgeCreate('decision', decision('a plain project decision')) as unknown as Record<string, unknown>;
    assert.equal('mounted_domains' in res, false);
  } finally {
    cleanup();
  }
});

test('knowledge_create refuses scope domain:<x> with non-empty file_keys, and writes nothing', () => {
  const { store, tools, cleanup } = harness(['genesys']);
  try {
    const before = store.count({});
    assert.throws(
      () => tools.knowledgeCreate('decision', decision('genesys call routing retry', { scope: 'domain:genesys', file_keys: ['src/routing.ts'] })),
      (err: Error) => {
        assert.match(err.message, /domain:genesys/);
        assert.match(err.message, /file_keys/);
        assert.match(err.message, /src\/routing\.ts/);
        assert.match(err.message, /nothing was written/i);
        return true;
      }
    );
    assert.equal(store.count({}), before, 'no record in any store');
    assert.equal(reviews(tools).length, 0, 'no maintenance item either');
    // the same record without file_keys lands in the domain store
    const ok = tools.knowledgeCreate('decision', decision('genesys call routing retry', { scope: 'domain:genesys', file_keys: [] })).record;
    assert.equal(store.scopeOfHolder(ok.id), 'domain:genesys');
  } finally {
    cleanup();
  }
});

test('knowledge_create refuses a domain-scoped feature_article that owns files', () => {
  const { store, tools, cleanup } = harness(['genesys']);
  try {
    const before = store.count({});
    assert.throws(
      () =>
        tools.knowledgeCreate(
          'feature_article',
          article('genesys-routing-article', 'Genesys routing', [{ path: 'src/routing.ts', role: 'impl' }], { scope: 'domain:genesys' })
        ),
      /domain:genesys[\s\S]*src\/routing\.ts/
    );
    assert.equal(store.count({}), before);
  } finally {
    cleanup();
  }
});

// -- 2. domain_describe -------------------------------------------------------

test('domain_describe reads the description when none is given, and sets it when given', () => {
  const { store, tools, cleanup } = harness(['genesys']);
  try {
    assert.deepEqual(tools.domainDescribe({ domain: 'genesys' }), { domain: 'genesys', description: DESCRIPTIONS.genesys });
    const set = tools.domainDescribe({ domain: 'genesys', description: '  Genesys Cloud contact center: queues and routing  ' });
    assert.deepEqual(set, {
      domain: 'genesys',
      description: 'Genesys Cloud contact center: queues and routing',
      previous_description: DESCRIPTIONS.genesys,
      updated: true,
    });
    assert.equal(store.domainDescription('genesys'), 'Genesys Cloud contact center: queues and routing', 'the mounted handle reads the new value');
    assert.equal(tools.domainDescribe({ domain: 'genesys' }).description, 'Genesys Cloud contact center: queues and routing');
  } finally {
    cleanup();
  }
});

test('domain_describe refuses an unmounted domain (naming the mounted set) and a blank description', () => {
  const { store, tools, cleanup } = harness(['genesys'], { missing: ['salesforce'] });
  try {
    assert.throws(() => tools.domainDescribe({ domain: 'nope' }), /'nope' is not mounted[\s\S]*genesys/);
    assert.throws(() => tools.domainDescribe({ domain: 'salesforce', description: 'x y' }), /'salesforce' is not mounted[\s\S]*no store/);
    assert.throws(() => tools.domainDescribe({ domain: 'genesys', description: '   ' }), /blank/);
    assert.throws(() => tools.domainDescribe({ domain: 'genesys', description: '' }), /blank/);
    assert.equal(store.domainDescription('genesys'), DESCRIPTIONS.genesys, 'a refused set leaves the description untouched');
  } finally {
    cleanup();
  }
});

// -- 3. promotion_review from the description fit -----------------------------

test('promotion: a project decision with no file_keys that fits exactly one domain mints one drainable item and warns on the receipt', () => {
  const { tools, cleanup } = harness(['salesforce', 'genesys', 'sterling']);
  try {
    const res = tools.knowledgeCreate('decision', decision('Apex triggers must bulkify opportunity updates'));
    const items = reviews(tools);
    assert.equal(items.length, 1);
    const item = items[0];
    assert.equal(item.feature_link, res.record.id);
    assert.match(item.text, /domain:salesforce/);
    assert.ok(item.text.includes(DESCRIPTIONS.salesforce), 'the item quotes the description');
    const matched = /matched: ([^)]*)\)/.exec(item.text)?.[1].split(', ').sort();
    assert.deepEqual(matched, ['apex', 'opportunity', 'triggers'], 'the item names the matched description terms');
    assert.match(item.text, /exactly one fit: drainable/);
    assert.doesNotMatch(item.text, /domain:genesys/);
    assert.ok(
      res.warnings.some((w) => /domain:salesforce/.test(w) && w.includes(DESCRIPTIONS.salesforce)),
      `the receipt warns naming the suggested domain: ${JSON.stringify(res.warnings)}`
    );
  } finally {
    cleanup();
  }
});

test('promotion: a record fitting several domains says to ask the user', () => {
  const { tools, cleanup } = harness(['salesforce', 'genesys']);
  try {
    tools.knowledgeCreate('research_finding', {
      question: 'Do Apex triggers fire when Genesys call routing updates an opportunity?',
      answer: 'Yes: the Genesys IVR queues write the opportunity, which fires the Apex triggers.',
      source_urls: ['https://example.com'],
      source_date: '2026-10-03',
      capture_date: '2026-10-03',
    });
    const items = reviews(tools);
    assert.equal(items.length, 1);
    assert.match(items[0].text, /domain:salesforce/);
    assert.match(items[0].text, /domain:genesys/);
    assert.match(items[0].text, /several fit: ask the user/);
  } finally {
    cleanup();
  }
});

test('promotion: covers every promotable durable type, but never feature_article, todo or a refused case', () => {
  const { tools, cleanup } = harness(['salesforce', 'sterling']);
  try {
    const subject = 'Apex triggers bulkify opportunity updates';
    const ap = tools.knowledgeCreate('anti_pattern', {
      title: subject,
      trigger: subject,
      guidance: 'g',
      wrong_way: 'w',
      right_way: 'r',
      source_evidence: 'e',
    }).record;
    const ref = tools.knowledgeCreate('reference_material', {
      title: subject,
      kind: 'url',
      location: 'https://example.com/apex',
      summary: subject,
      source_date: '2026-10-03',
      capture_date: '2026-10-03',
      basis: 'platform',
    }).record;
    // not candidates: has file_keys; already domain-scoped; fits only sterling; no fit at all
    tools.knowledgeCreate('decision', decision(`${subject} (repo bound)`, { file_keys: ['src/apex.ts'] }));
    tools.knowledgeCreate('decision', decision(`${subject} (shared)`, { scope: 'domain:salesforce' }));
    tools.knowledgeCreate('decision', decision('Sterling knowledge store hooks for conductor agents'));
    const noFit = tools.knowledgeCreate('decision', decision('Prefer composition over inheritance'));
    assert.equal(noFit.warnings.some((w) => /promotion/.test(w)), false, 'no fit, no warning');
    tools.knowledgeCreate('feature_article', article('apex-trigger-article', subject, []));
    tools.boardAdd({ text: subject, source: 'user', objective: 'standalone' });

    const links = reviews(tools).map((r) => r.feature_link).sort();
    assert.deepEqual(links, [ap.id, ref.id].sort());
  } finally {
    cleanup();
  }
});

test('promotion: no mounted domain with a description means no item', () => {
  const { tools, cleanup } = harness(['sterling']);
  try {
    tools.knowledgeCreate('decision', decision('Sterling knowledge store hooks for conductor agents'));
    assert.equal(reviews(tools).length, 0, 'the sterling domain is never a promotion target here');
  } finally {
    cleanup();
  }
});

// -- 4. knowledge_promote receipt ---------------------------------------------

test('knowledge_promote: the receipt shows the target domain description and drains the review', () => {
  const { tools, cleanup } = harness(['salesforce']);
  try {
    const rec = tools.knowledgeCreate('decision', decision('Apex triggers must bulkify opportunity updates')).record;
    const out = tools.knowledgePromote(rec.id, 'salesforce');
    assert.equal(out.domain_description, DESCRIPTIONS.salesforce);
    assert.ok(out.drained_review, 'the minted review was drained');
    assert.equal(reviews(tools).length, 0);
  } finally {
    cleanup();
  }
});

// -- 5. source labels and missing domains on reads ----------------------------

test('knowledge_query labels each record with its source store, in full and digest, and discloses missing domains', () => {
  const { tools, cleanup } = harness(['genesys'], { missing: ['salesforce'] });
  try {
    const p = tools.knowledgeCreate('decision', decision('Queue overflow retry policy')).record;
    const d = tools.knowledgeCreate('decision', decision('Queue overflow retry policy for IVR', { scope: 'domain:genesys' })).record;
    for (const projection of ['full', 'digest'] as const) {
      const res = tools.knowledgeQueryResult({ types: ['decision'], cap: 10, projection });
      const byId = new Map(res.records.map((r) => [r.id, r]));
      assert.equal(byId.get(p.id)?.source, 'project', projection);
      assert.equal(byId.get(d.id)?.source, 'domain:genesys', projection);
      assert.deepEqual(res.missing_domains, ['salesforce'], projection);
    }
    const counted = tools.knowledgeQueryResult({ types: ['decision'], projection: 'count' });
    assert.deepEqual(counted.missing_domains, ['salesforce']);
  } finally {
    cleanup();
  }
});

test('knowledge_query carries no missing_domains key when every configured domain is mounted', () => {
  const { tools, cleanup } = harness(['genesys']);
  try {
    const res = tools.knowledgeQueryResult({ cap: 5 });
    assert.equal('missing_domains' in res, false);
  } finally {
    cleanup();
  }
});

test('knowledge_preflight labels each match with its source store and discloses missing domains', () => {
  const { tools, cleanup } = harness(['genesys'], { missing: ['salesforce'] });
  try {
    const p = tools.knowledgeCreate('decision', decision('Overflow queue retry backoff policy')).record;
    const d = tools.knowledgeCreate('decision', decision('Overflow queue retry backoff policy in IVR', { scope: 'domain:genesys' })).record;
    const res = tools.knowledgePreflight('overflow queue retry backoff policy');
    const byId = new Map(res.matches.map((m) => [m.id, m]));
    assert.equal(byId.get(p.id)?.source, 'project');
    assert.equal(byId.get(d.id)?.source, 'domain:genesys');
    assert.deepEqual(res.missing_domains, ['salesforce']);
  } finally {
    cleanup();
  }
});
