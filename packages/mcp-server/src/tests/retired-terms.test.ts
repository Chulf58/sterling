// Retired terms (GitHub #188, decision
// retiring-a-renamed-term-a-retired-terms-field-on-the-rename): the schema
// field, the preflight warning, the write warning, the idempotent
// retired_term_use mint with its scope rule, and the worker's narrow rewrite
// permission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSterlingServer } from '../server.js';
import type { SterlingTools } from '../tools.js';
import { WorkerGuard, WorkerPolicyRefusal } from '../worker-policy.js';
import { harnessMounted } from './test-helpers/mounted-harness.js';

type Rec = { id: string; [k: string]: unknown };
const RENAME = { term: 'North Barn', replacement: 'Hay Barn' };

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-retired-terms-'));
  const { store, tools } = createSterlingServer(join(dir, 'sterling.db'));
  return { dir, store, tools, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const decision = (tools: SterlingTools, fields: Record<string, unknown>) =>
  tools.knowledgeCreate('decision', { alternatives_rejected: [], rationale: 'r', ...fields } as never) as unknown as { record: Rec; warnings: string[] };

const article = (tools: SterlingTools, slug: string, what: string) =>
  (tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: what,
    intended_behavior: 'intends.',
    files: [{ path: `src/${slug}.ts`, role: 'r' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    history: [{ date: '2026-10-23T00:00:00.000Z', event: 'the North Barn was built' }],
    live_test_refs: [],
  } as never) as unknown as { record: Rec }).record;

const termItems = (tools: SterlingTools) =>
  (tools.maintenanceQuery({ system_reason: 'retired_term_use', cap: 100 }) as unknown as { id: string; feature_link: string; text: string }[]);

test('knowledge_schema shows retired_terms on decision, and an empty entry is refused', () => {
  const h = harness();
  try {
    const schema = h.tools.knowledgeSchema('decision') as unknown as { fields: { name: string }[] };
    assert.ok(schema.fields.some((f) => f.name === 'retired_terms'), 'retired_terms is a listed decision field');
    assert.throws(() => decision(h.tools, { title: 'bad', statement: 's', retired_terms: [{ term: ' ', replacement: 'x' }] }));
  } finally {
    h.cleanup();
  }
});

test('recording a rename queues one item per record still using the term, skips quotes, history, superseded records and the rename itself, and is idempotent', () => {
  const h = harness();
  try {
    const plain = article(h.tools, 'feeding', 'Feeds the cows in the north barn every morning.');
    const quoted = article(h.tools, 'quoted', 'The user said "keep the North Barn name" once.');
    const historyOnly = article(h.tools, 'history-only', 'Unrelated text.');
    const old = decision(h.tools, { title: 'Milking happens in North Barn', statement: 'North Barn holds the milking line.' }).record;
    const created = decision(h.tools, { title: 'Rename North Barn to Hay Barn', statement: 'North Barn is now Hay Barn.', retired_terms: [RENAME] });
    const rename = created.record;
    const items = termItems(h.tools);
    const targets = new Set(items.map((i) => i.feature_link));
    assert.deepEqual([...targets].sort(), [plain.id, old.id].sort(), 'only the plain uses are queued');
    assert.ok(!targets.has(quoted.id) && !targets.has(historyOnly.id) && !targets.has(rename.id));
    const plainItem = items.find((i) => i.feature_link === plain.id)!;
    assert.match(plainItem.text, /'North Barn' \(now 'Hay Barn'/);
    assert.match(plainItem.text, /in what_it_does/);
    assert.ok(created.warnings.some((w) => /retired_terms recorded: 2 record\(s\)/.test(w)), created.warnings.join('\n'));

    // Idempotent: a second sweep adds nothing and changes no text.
    const again = h.tools.retiredTermSweep();
    assert.equal(again.records, 2);
    assert.deepEqual(termItems(h.tools).map((i) => [i.id, i.text]).sort(), items.map((i) => [i.id, i.text]).sort());

    // A superseded record is skipped: supersede the old decision with clean text.
    h.tools.knowledgeSupersede(old.id, { title: 'Milking happens in Hay Barn', statement: 'Hay Barn holds the milking line.', alternatives_rejected: [], rationale: 'r' } as never);
    const fresh = h.tools.retiredTermSweep();
    assert.equal(fresh.records, 1, 'the superseded decision no longer counts');
  } finally {
    h.cleanup();
  }
});

test('knowledge_preflight warns on a retired term outside quotes and stays silent inside them', () => {
  const h = harness();
  try {
    decision(h.tools, { title: 'Rename North Barn to Hay Barn', statement: 'North Barn is now Hay Barn.', retired_terms: [RENAME] });
    const hit = h.tools.knowledgePreflight('Write fixtures for the north   barn feeding schedule tests');
    assert.equal(hit.retired_terms?.length, 1);
    assert.match(hit.retired_terms![0], /retired term 'North Barn': renamed to 'Hay Barn'/);
    const quoted = h.tools.knowledgePreflight('The user once said "North Barn" in a fixture name for feeding');
    assert.equal(quoted.retired_terms, undefined);
    const short = h.tools.knowledgePreflight('North Barn');
    assert.equal(short.retired_terms?.length, 1, 'the warning does not depend on vocabulary');
  } finally {
    h.cleanup();
  }
});

test('a write whose record uses a retired term carries the warning', () => {
  const h = harness();
  try {
    decision(h.tools, { title: 'Rename North Barn to Hay Barn', statement: 'North Barn is now Hay Barn.', retired_terms: [RENAME] });
    const res = h.tools.knowledgeCreate('decision', { title: 'Feed in North Barn', statement: 's', alternatives_rejected: [], rationale: 'r' } as never) as unknown as { warnings: string[] };
    assert.ok(res.warnings.some((w) => /retired term 'North Barn'.*still uses it in title/.test(w)), res.warnings.join('\n'));
    const art = article(h.tools, 'clean', 'Clean text.');
    const upd = h.tools.knowledgeUpdateResult(art.id, { what_it_does: 'Moves hay to North Barn.' });
    assert.ok(upd.warnings.some((w) => /retired term 'North Barn'/.test(w)), upd.warnings.join('\n'));
  } finally {
    h.cleanup();
  }
});

test('scope: a domain-held rename covers its domain and the project store; a project-held rename never reaches a domain record', () => {
  const h = harnessMounted(['farm'], { now: '2026-10-23T12:00:00.000Z', prefix: 'sterling-retired-domain-' });
  try {
    const tools = h.tools as SterlingTools;
    const domainRec = (tools.knowledgeCreate('decision', { scope: 'domain:farm', title: 'Domain feeding in North Barn and Old Shed', statement: 's', alternatives_rejected: [], rationale: 'r' } as never) as unknown as { record: Rec }).record;
    const projectRec = (tools.knowledgeCreate('decision', { title: 'Project feeding in North Barn', statement: 's', alternatives_rejected: [], rationale: 'r' } as never) as unknown as { record: Rec }).record;
    tools.knowledgeCreate('decision', { scope: 'domain:farm', title: 'Rename North Barn', statement: 'renamed', alternatives_rejected: [], rationale: 'r', retired_terms: [RENAME] } as never);
    const afterDomain = new Set(termItems(tools).map((i) => i.feature_link));
    assert.ok(afterDomain.has(domainRec.id) && afterDomain.has(projectRec.id), 'a domain rename covers the domain and the project');
    tools.knowledgeCreate('decision', { title: 'Retire Old Shed', statement: 'renamed', alternatives_rejected: [], rationale: 'r', retired_terms: [{ term: 'Old Shed', replacement: 'Tool Shed' }] } as never);
    const domainItem = termItems(tools).find((i) => i.feature_link === domainRec.id)!;
    assert.doesNotMatch(domainItem.text, /now 'Tool Shed'/, 'a project-held rename does not cover a domain record');
    assert.ok(h.store.project.get(domainItem.id), 'the item for a domain-held record is project-local');
  } finally {
    h.cleanup();
  }
});

test('worker policy: retired_term_use allows exactly the term swap outside quotes, and refuses anything else', () => {
  const h = harness();
  try {
    const target = decision(h.tools, { title: 'Feed in North Barn', statement: 'Hay goes to north barn; the user said "North Barn".' }).record;
    decision(h.tools, { title: 'Rename North Barn to Hay Barn', statement: 'North Barn is now Hay Barn.', retired_terms: [RENAME] });
    const item = termItems(h.tools).find((i) => i.feature_link === target.id)!;
    const path = join(h.dir, 'eligible.json');
    writeFileSync(path, JSON.stringify({ policy_version: 1, token: 't', run_id: 'r', policy_items: [{ id: item.id, lane: 'retired_term_use', target_id: target.id, file_keys: [] }] }));
    const guard = new WorkerGuard({ path, token: 't' }, h.store);
    const update = (body: Record<string, unknown>) => guard.authorize('knowledge_update', { id: target.id, body, expected_version: 1, resolves: [item.id] });
    const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof WorkerPolicyRefusal && re.test(e.message));

    assert.ok(update({ title: 'Feed in Hay Barn', statement: 'Hay goes to Hay Barn; the user said "North Barn".' }), 'the exact swap is allowed');
    refused(() => update({ statement: 'Hay goes to Hay Barn; the user said "Hay Barn".' }), /not the stored value with the retired term/);
    refused(() => update({ statement: 'Something else entirely.' }), /not the stored value/);
    refused(() => update({ rationale: 'r2' }), /not in lane retired_term_use's allow-list/);
    refused(() => guard.authorize('knowledge_edit', { id: target.id, field: 'title', find: 'North', replace: 'Hay', resolves: [item.id] }), /only a knowledge_update/);
    const other = randomUUID();
    refused(() => guard.authorize('knowledge_update', { id: other, body: { title: 'x' }, expected_version: 1 }), /not the target_id/);
  } finally {
    h.cleanup();
  }
});

test('retiredTermDecisions: the narrow read returns only active decisions that carry retired_terms, across the project and a mounted domain', () => {
  const h = harnessMounted(['farm'], { now: '2026-10-23T12:00:00.000Z', prefix: 'sterling-retired-narrow-' });
  try {
    const tools = h.tools as SterlingTools;
    assert.deepEqual(h.store.retiredTermDecisions(), [], 'no rename recorded: nothing returned');
    const mk = (fields: Record<string, unknown>) => (tools.knowledgeCreate('decision', { alternatives_rejected: [], rationale: 'r', statement: 's', ...fields } as never) as unknown as { record: Rec }).record;
    const plain = mk({ title: 'A decision that merely mentions retired_terms in prose', statement: 'retired_terms are a field' });
    const mine = mk({ title: 'Project rename', retired_terms: [RENAME] });
    const theirs = mk({ scope: 'domain:farm', title: 'Domain rename', retired_terms: [{ term: 'Old Shed', replacement: 'Tool Shed' }] });
    const old = mk({ title: 'Superseded rename', retired_terms: [{ term: 'Gone', replacement: 'Here' }] });
    tools.knowledgeSupersede(old.id, { title: 'Clean', statement: 's', alternatives_rejected: [], rationale: 'r' } as never);
    const rows = h.store.retiredTermDecisions();
    assert.deepEqual(rows.map((r) => r.id).sort(), [mine.id, theirs.id].sort());
    assert.ok(!rows.some((r) => r.id === plain.id), 'a body that only mentions the word is dropped by the field check');
    assert.deepEqual(h.store.project.retiredTermDecisions().map((r) => r.id), [mine.id], 'the project store alone holds only its own');
  } finally {
    h.cleanup();
  }
});
