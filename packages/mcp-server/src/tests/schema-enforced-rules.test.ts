import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SterlingStore } from '@sterling/store';
import { RECORD_TYPES, LINK_RELS, WRITE_REFUSED_LINK_RELS, REPO_PATH_FORMAT, exampleRecordFor, fieldShapeAt } from '@sterling/schemas';
import type { FieldShape } from '@sterling/schemas';
import { createSterlingServer } from '../server.js';
import { SterlingTools } from '../tools.js';

// Finding knowledge-schema-describes-field-shapes-only-enforced-rules-undescribed-october-2026:
// the rules the TOOL layer enforces above the zod schema. In each test the
// write path is the oracle: a rule is printed by knowledge_schema exactly where
// a write is refused for it.

const NOW = '2026-06-10T12:00:00.000Z';
const TYPES = Object.keys(RECORD_TYPES);

type Rec = Record<string, unknown>;
type Described = FieldShape & { server_owned?: boolean };

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-schema-rules-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'a-directory'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, repoRoot: dir, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { tools, cleanup };
}

let handles = 0;

/**
 * A create body made of the type's own printed examples, minus what a caller
 * may not send. Each body gets its own slug, so only a test that passes one
 * explicitly meets the collision refusal.
 */
function createBody(tools: SterlingTools, type: string, overrides: Rec = {}): Rec {
  const body = structuredClone(exampleRecordFor(type)!) as Rec;
  for (const f of tools.knowledgeSchema(type).fields as Described[]) {
    if (f.server_owned) delete body[f.name];
  }
  // The example link target, feature_link and blocker are placeholders no
  // store holds, and a named working tree no config maps switches the
  // directory check off.
  delete body.links;
  delete body.feature_link;
  delete body.blocked_by;
  delete body.working_tree;
  if ('slug' in body) body.slug = `handle-${++handles}`;
  return { ...body, ...overrides };
}

function thrown(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

function pathFields(fields: FieldShape[], prefix = ''): { path: string; shape: FieldShape }[] {
  return fields.flatMap((f) => [
    ...(f.format === REPO_PATH_FORMAT ? [{ path: `${prefix}${f.name}`, shape: f }] : []),
    ...pathFields(f.element_fields ?? [], `${prefix}${f.name}[].`),
    ...pathFields(f.member_fields ?? [], `${prefix}${f.name}.`),
  ]);
}

/** Put `value` at a knowledge_schema field path, wrapping it in an array where the leaf is one. */
function setPath(record: Rec, path: string, value: string, leafIsArray: boolean): void {
  const segments = path.split('.');
  let target: Rec = record;
  segments.forEach((segment, i) => {
    const intoElements = segment.endsWith('[]');
    const name = intoElements ? segment.slice(0, -2) : segment;
    if (i === segments.length - 1) {
      target[name] = leafIsArray ? [value] : value;
      return;
    }
    const next = target[name];
    target = (intoElements ? (next as Rec[])[0] : next) as Rec;
  });
}

test('type: marked with the condition that knowledge_create takes it once (top level or fields.type), which the served input schema advertises', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-schema-rules-mcp-'));
  const { server, store, tools } = createSterlingServer(join(dir, 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = (await client.listTools()).tools;
    const createTool = listed.find((t) => t.name === 'knowledge_create');
    const variants = (createTool!.inputSchema as unknown as { properties: { fields: { anyOf: { properties: Rec; required?: string[] }[] } } }).properties.fields.anyOf;
    for (const variant of variants) {
      const type = (variant.properties.type as { const: string }).const;
      assert.ok(!variant.required?.includes('type'), `${type}: the served create schema leaves fields.type optional (type is given once)`);
      const field = (tools.knowledgeSchema(type).fields as Described[]).find((f) => f.name === 'type');
      assert.equal(field?.server_owned, true);
      assert.match(field?.condition ?? '', new RegExp(`knowledge_create takes type once, .* set to '${type}'`));
      assert.match(field?.condition ?? '', /every other write refuses it/);
      assert.ok(
        tools.knowledgeSchema(type).rules.includes('knowledge_create takes type once, as the top-level type argument or as fields.type; if both are given they must match.'),
        `${type}: rules state the one-copy type contract`
      );
    }
    const schemaTool = listed.find((t) => t.name === 'knowledge_schema');
    for (const key of ['rules', 'member_fields', 'min_length', 'format', 'default', 'condition']) {
      assert.match(schemaTool!.description ?? '', new RegExp(`\\b${key}\\b`), `knowledge_schema's description documents ${key}`);
    }
    assert.match(schemaTool!.description ?? '', /except `type`/);

    // board_add: feature_link is uuid-only in the todo schema, and the tool input now says so.
    const boardAdd = listed.find((t) => t.name === 'board_add');
    const featureLink = (boardAdd!.inputSchema as unknown as { properties: Record<string, { description?: string }> }).properties.feature_link;
    assert.match(featureLink.description ?? '', /uuid/);
    assert.match(fieldShapeAt(tools.knowledgeSchema('todo').fields, 'feature_link')!.type, /uuid/);
    assert.ok(!('slug' in (boardAdd!.inputSchema as unknown as { properties: Rec }).properties), 'board_add takes no slug');
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board_add: the no-handle notice names a remedy the tool has, not a slug parameter', () => {
  const { tools, cleanup } = harness();
  try {
    const res = tools.boardAdd({ text: '日本語のタスク', source: 'user', objective: 'standalone' }) as { notice?: string };
    assert.match(res.notice ?? '', /no handle could be derived/);
    assert.doesNotMatch(res.notice ?? '', /\{slug:/);
    assert.match(res.notice ?? '', /board_add takes no slug/);
  } finally {
    cleanup();
  }
});

test('scope: the creation-only condition sits on exactly the fields a later write refuses', () => {
  const { tools, cleanup } = harness();
  try {
    const { record } = tools.knowledgeCreate('decision', createBody(tools, 'decision'));
    const samples: Rec = { scope: 'domain:other', author: 'user', stack_tags: ['node'], title: 'renamed' };
    const refusedOnUpdate = Object.keys(samples).filter((name) => /creation-only|cannot be changed|immutable/i.test(thrown(() => tools.knowledgeUpdate(record.id, { [name]: samples[name] })) ?? ''));
    const marked = tools.knowledgeSchema('decision').fields.filter((f) => /^Creation-only/.test(f.condition ?? '')).map((f) => f.name);
    assert.deepEqual(marked, refusedOnUpdate);
    assert.deepEqual(marked, ['scope']);
    for (const type of TYPES) {
      assert.match(fieldShapeAt(tools.knowledgeSchema(type).fields, 'scope')?.condition ?? '', /^Creation-only/, type);
    }
  } finally {
    cleanup();
  }
});

test('links[].rel: the condition names exactly the rels knowledge_create and knowledge_link refuse', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: target } = tools.knowledgeCreate('decision', createBody(tools, 'decision', { title: 'the link target' }));
    const refused = LINK_RELS.filter((rel) => {
      const message = thrown(() => tools.knowledgeCreate('decision', createBody(tools, 'decision', { title: `links by ${rel}`, links: [{ rel, target_id: target.id }] })));
      if (message !== undefined) assert.match(message, /knowledge_supersede/, `${rel} is refused for being a lifecycle rel`);
      return message !== undefined;
    });
    assert.deepEqual([...refused], [...WRITE_REFUSED_LINK_RELS]);
    const { record: source } = tools.knowledgeCreate('decision', createBody(tools, 'decision', { title: 'the link source' }));
    const refusedByLink = LINK_RELS.filter((rel) => {
      const message = thrown(() => tools.knowledgeLink(source.id, rel, target.id));
      if (message !== undefined) assert.match(message, /lifecycle transition/, `knowledge_link ${rel} is refused for being a lifecycle rel`);
      return message !== undefined;
    });
    assert.deepEqual([...refusedByLink], [...refused], 'knowledge_link refuses the same rels');
    for (const type of TYPES) {
      const rel = fieldShapeAt(tools.knowledgeSchema(type).fields, 'links[].rel');
      assert.deepEqual(rel?.enum_values, [...LINK_RELS], `${type}: the enum still lists every registered rel`);
      assert.deepEqual(
        LINK_RELS.filter((r) => rel?.condition?.includes(`'${r}'`)),
        [...refused],
        `${type}: the condition names the refused rels`
      );
      assert.match(rel?.condition ?? '', /knowledge_supersede/);
      for (const tool of ['knowledge_create', 'knowledge_link', 'knowledge_update']) {
        assert.match(rel?.condition ?? '', new RegExp(`\\b${tool}\\b`), `${type}: the condition names ${tool}`);
      }
    }
  } finally {
    cleanup();
  }
});

test('slug: the collision condition is printed for exactly the types whose create refuses a held slug', () => {
  const { tools, cleanup } = harness();
  try {
    for (const type of TYPES) {
      const slug = fieldShapeAt(tools.knowledgeSchema(type).fields, 'slug');
      if (!slug) continue;
      const handle = `held-by-${type.replace(/_/g, '-')}`;
      const first = thrown(() => tools.knowledgeCreate(type, createBody(tools, type, { slug: handle })));
      assert.equal(first, undefined, `${type}: the first create under the slug is accepted`);
      const second = thrown(() => tools.knowledgeCreate(type, createBody(tools, type, { slug: handle, dedup_override: true })));
      const refused = second !== undefined && second.includes(`slug '${handle}'`);
      assert.equal(/already holds is refused/.test(slug.condition ?? ''), refused, `${type}: condition '${slug.condition}' against the second create (${second ?? 'accepted'})`);
    }
  } finally {
    cleanup();
  }
});

test('dedup_override: rules state it for every type, and the near-duplicate refusal for the one type that has it', () => {
  const { tools, cleanup } = harness();
  try {
    for (const type of TYPES) {
      const { rules } = tools.knowledgeSchema(type);
      assert.ok(rules.some((r) => /^dedup_override: true is accepted in the fields of every knowledge_create/.test(r)), type);

      // The same content three times, each under its own slug.
      assert.equal(thrown(() => tools.knowledgeCreate(type, createBody(tools, type))), undefined, `${type}: a first create is accepted`);
      const duplicate = thrown(() => tools.knowledgeCreate(type, createBody(tools, type)));
      const dedupRefused = duplicate !== undefined && /dedup_override/.test(duplicate);
      if (duplicate !== undefined && !dedupRefused) assert.fail(`${type}: refused for another reason: ${duplicate}`);
      assert.equal(rules.some((r) => /overlaps an existing one is refused unless dedup_override: true/.test(r)), dedupRefused, `${type}: ${duplicate ?? 'accepted'}`);
      assert.equal(
        thrown(() => tools.knowledgeCreate(type, createBody(tools, type, { dedup_override: true }))),
        undefined,
        `${type}: the same create with dedup_override: true is accepted`
      );
    }
  } finally {
    cleanup();
  }
});

test('repo path fields: "an existing directory" is printed on exactly the fields whose directory claim a create refuses', () => {
  const { tools, cleanup } = harness();
  try {
    let checked = 0;
    for (const type of TYPES) {
      for (const { path, shape } of pathFields(tools.knowledgeSchema(type).fields)) {
        const body = createBody(tools, type, { dedup_override: true });
        setPath(body, path, 'a-directory', shape.type.endsWith('[]'));
        const message = thrown(() => tools.knowledgeCreate(type, body));
        const refused = message !== undefined && /existing DIRECTORY/.test(message);
        if (message !== undefined && !refused) assert.fail(`${type}.${path}: refused for another reason: ${message}`);
        assert.equal(/Also refused:.*an existing directory/.test(shape.condition ?? ''), refused, `${type}.${path}`);
        checked++;
      }
    }
    assert.ok(checked >= 12, `every path field was probed (${checked})`);
  } finally {
    cleanup();
  }
});

test('repo path fields: "any path when scope is domain:<name>" is printed on exactly the fields a domain-scoped create refuses', () => {
  const { tools, cleanup } = harness();
  try {
    for (const type of TYPES) {
      const fields = tools.knowledgeSchema(type).fields;
      const marked = fields.filter((f) => /any path when scope is domain:<name>/.test(f.condition ?? '')).map((f) => f.name);
      const withPaths = thrown(() => tools.knowledgeCreate(type, createBody(tools, type, { scope: 'domain:somewhere' })));
      const refusedField = /declares repo paths in (\w+)/.exec(withPaths ?? '')?.[1];
      assert.deepEqual(marked, refusedField ? [refusedField] : [], `${type}: ${withPaths}`);
      if (refusedField) {
        const without = createBody(tools, type, { scope: 'domain:somewhere' });
        without[refusedField] = [];
        assert.doesNotMatch(thrown(() => tools.knowledgeCreate(type, without)) ?? '', /declares repo paths/, `${type}: no paths, no path refusal`);
      }
    }
  } finally {
    cleanup();
  }
});
