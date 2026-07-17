import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';
import { createSterlingServer } from '../server.js';
import { SterlingTools } from '../tools.js';

const SERVED_TOOLS = [
  'knowledge_create',
  'knowledge_query',
  'knowledge_get',
  'knowledge_update',
  'knowledge_promote',
  'knowledge_link',
  'board_add',
  'board_query',
  'board_remove',
  'note_remove',
  'run_state',
  'run_escalate',
  'agent_exit',
  'run_signal',
  'maintenance_enqueue',
  'maintenance_query',
  'handoff_write',
  'handoff_read',
];

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mcp-'));
  const { server, store } = createSterlingServer(join(dir, 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const cleanup = async () => {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { client, store, cleanup };
}

function payload(result: unknown): unknown {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text);
}

test('main.ts refuses an unexpanded ${...} --store path loudly — no phantom store is created (P5, research_finding e518f9e5)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-phantom-'));
  try {
    const mainJs = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.js');
    const r = spawnSync(
      process.execPath,
      [mainJs, '--store', '${CLAUDE_PROJECT_DIR}/.sterling/sterling.db'],
      { cwd: dir, input: '', encoding: 'utf8', timeout: 15_000 }
    );
    assert.equal(r.status, 2, `an unexpanded placeholder must refuse boot (got status ${r.status}; stderr: ${r.stderr})`);
    assert.match(r.stderr ?? '', /unexpanded/);
    assert.ok(
      !existsSync(join(dir, '${CLAUDE_PROJECT_DIR}')),
      'no literal placeholder directory is created at the server cwd'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP integration: the spine tool surface is served and callable end-to-end', async () => {
  const { client, store, cleanup } = await harness();
  try {
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(listed, [...SERVED_TOOLS].sort(), 'exactly the §10 tool surface is served');

    // knowledge round trip over the wire
    const created = payload(
      await client.callTool({
        name: 'knowledge_create',
        arguments: {
          type: 'decision',
          fields: { title: 'T', statement: 'S', alternatives_rejected: [], rationale: 'R', file_keys: ['src\\x.ts'] },
        },
      })
    ) as { record: { id: string; file_keys: string[] }; check_skipped: unknown[] };
    assert.deepEqual(created.record.file_keys, ['src/x.ts'], 'path invariant holds across the MCP boundary');
    assert.equal(created.check_skipped.length, 1, 'check_skipped surfaces in the tool result');

    const queried = payload(
      await client.callTool({ name: 'knowledge_query', arguments: { types: ['decision'], rank_terms: ['T'] } })
    ) as unknown[];
    assert.equal(queried.length, 1);

    // protocol loop over the wire
    store.createRun({
      id: 'r-0001',
      brief_ref: randomUUID(),
      branch: 'sterling/run-r-0001',
      machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
      dispatch_counts: {},
      escalations: [],
      started_at: '2026-06-10T12:00:00.000Z',
    });

    const badExit = await client.callTool({
      name: 'agent_exit',
      arguments: { phase_id: 'p1', agent_role: 'coder', signal: 'victory' },
    });
    assert.equal(badExit.isError, true, 'invalid signal rejected in-band so the agent can self-correct');
    assert.match((badExit.content as { text: string }[])[0].text, /enum is closed/);

    await client.callTool({
      name: 'handoff_write',
      arguments: {
        handoff: {
          phase_id: 'p1',
          agent_role: 'coder',
          what_changed: [{ path: 'src/x.ts', change_role: 'implemented' }],
          wired: [],
          deferred: [],
          decisions_made: [],
          tests_produced: [],
          exit_signal: 'complete',
          unresolved: [],
        },
      },
    });
    await client.callTool({
      name: 'agent_exit',
      arguments: { phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } },
    });
    const signal = payload(await client.callTool({ name: 'run_signal', arguments: {} })) as {
      action: { action: string };
      machine_state: string;
    };
    assert.equal(signal.action.action, 'complete_run', 'single-phase run goes straight to the completion sequence');
    assert.equal(signal.machine_state, 'completing');

    const state = payload(await client.callTool({ name: 'run_state', arguments: {} })) as { machine_state: string };
    assert.equal(state.machine_state, 'completing');

    const handoffs = payload(
      await client.callTool({ name: 'handoff_read', arguments: { files: ['src\\x.ts'] } })
    ) as unknown[];
    assert.equal(handoffs.length, 1, 'handoff file-key read joins across the path boundary');
  } finally {
    await cleanup();
  }
});

test('AC2 over the wire: a reviewer handoff without exact review_mandatory coverage is refused in-band (missing id named) with nothing written; exact coverage lands; non-reviewers untouched', async () => {
  const { client, store, cleanup } = await harness();
  try {
    store.createRun({
      id: 'r-0001',
      brief_ref: randomUUID(),
      branch: 'sterling/run-r-0001',
      machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
      dispatch_counts: {},
      escalations: [],
      started_at: '2026-06-10T12:00:00.000Z',
    });
    const m1 = randomUUID();
    store.setRunReviewMandatory('r-0001', 'p1', [{ record_id: m1, reason: 'blocking anti-pattern' }]);

    const base = {
      phase_id: 'p1',
      what_changed: [],
      wired: [],
      deferred: [],
      decisions_made: [],
      tests_produced: [],
      exit_signal: 'complete',
      unresolved: [],
    };

    // reviewer with NO dispositions against a non-empty mandatory set → refused in-band
    const refused = await client.callTool({
      name: 'handoff_write',
      arguments: { handoff: { ...base, agent_role: 'reviewer-correctness' } },
    });
    assert.equal(refused.isError, true, 'uncovered reviewer handoff refused in-band so the agent can self-correct');
    assert.match((refused.content as { text: string }[])[0].text, new RegExp(m1), 'the missing mandatory id is named in the refusal');

    let read = payload(await client.callTool({ name: 'handoff_read', arguments: { phase_id: 'p1' } })) as unknown[];
    assert.equal(read.length, 0, 'the refused reviewer handoff wrote nothing over the wire');

    // reviewer with exact coverage → lands
    const ok = await client.callTool({
      name: 'handoff_write',
      arguments: {
        handoff: { ...base, agent_role: 'reviewer-correctness', dispositions: [{ record_id: m1, disposition: 'addressed' }] },
      },
    });
    assert.notEqual(ok.isError, true, 'exact-coverage reviewer handoff lands over the wire');
    read = payload(await client.callTool({ name: 'handoff_read', arguments: { phase_id: 'p1' } })) as unknown[];
    assert.equal(read.length, 1, 'exact-coverage reviewer handoff persisted');

    // non-reviewer against the same non-empty mandatory set, no dispositions → untouched, lands
    const coder = await client.callTool({
      name: 'handoff_write',
      arguments: { handoff: { ...base, agent_role: 'coder' } },
    });
    assert.notEqual(coder.isError, true, 'non-reviewer handoff is unaffected by review_mandatory');
    read = payload(await client.callTool({ name: 'handoff_read', arguments: { phase_id: 'p1' } })) as unknown[];
    assert.equal(read.length, 2, 'the non-reviewer handoff landed alongside the reviewer one');
  } finally {
    await cleanup();
  }
});

test('§3.2.5 repo-located docs: only a real content change (not an mtime-only bump) → verify_before_use + exactly one refresh_reference item; url-kind inert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ref-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, repoRoot: dir });
  try {
    const docPath = join(dir, 'docs', 'spec.md');
    writeFileSync(docPath, 'v1');
    utimesSync(docPath, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    // created with content 'v1' on disk → baseline = sha256('v1')
    const { record: doc } = tools.knowledgeCreate('reference_material', {
      title: 'Build Spec',
      kind: 'doc',
      location: 'docs/spec.md',
      summary: 'section map',
      source_date: '2026-06-01T00:00:00.000Z',
      capture_date: '2026-06-01T00:00:00.000Z',
    });
    assert.ok((doc as unknown as { file_baselines?: Record<string, string> }).file_baselines?.['docs/spec.md'], 'doc records a content baseline at create');
    tools.knowledgeCreate('reference_material', {
      title: 'External',
      kind: 'url',
      location: 'https://example.com/spec',
      summary: 'ext',
      source_date: '2020-01-01T00:00:00.000Z',
      capture_date: '2020-01-01T00:00:00.000Z',
    });

    // mtime older than source_date: clean read, nothing enqueued
    let refs = tools.knowledgeQuery({ types: ['reference_material'] });
    assert.equal(refs.find((r) => r.id === doc.id)?.verify_before_use, undefined, 'in-date doc is not flagged');
    assert.equal(tools.maintenanceQuery({ system_reason: 'refresh_reference' }).length, 0);

    // mtime-only bump (a git merge/checkout resets mtimes), content STILL 'v1':
    // mtime is now past source_date but the content baseline matches — NOT an
    // out-of-band edit, so no flag and nothing enqueued (the false-positive fix)
    utimesSync(docPath, new Date('2026-06-10T00:00:00Z'), new Date('2026-06-10T00:00:00Z'));
    for (let i = 0; i < 3; i++) {
      refs = tools.knowledgeQuery({ types: ['reference_material'] });
      assert.equal(refs.find((r) => r.id === doc.id)?.verify_before_use, undefined, `mtime-only bump not flagged (read ${i + 1})`);
    }
    assert.equal(tools.maintenanceQuery({ system_reason: 'refresh_reference' }).length, 0, 'mtime-only bump enqueues nothing');

    // genuine out-of-band edit: content changes AND mtime is past source_date —
    // flagged on EVERY read, but a hundred stale reads make one queue entry
    writeFileSync(docPath, 'v2');
    utimesSync(docPath, new Date('2026-06-10T00:00:00Z'), new Date('2026-06-10T00:00:00Z'));
    for (let i = 0; i < 3; i++) {
      refs = tools.knowledgeQuery({ types: ['reference_material'] });
      assert.equal(refs.find((r) => r.id === doc.id)?.verify_before_use, true, `content edit flagged at read ${i + 1}`);
    }
    const queue = tools.maintenanceQuery({ system_reason: 'refresh_reference' });
    assert.equal(queue.length, 1, 'deduplicated across repeated reads');
    assert.equal((queue[0] as { feature_link?: string }).feature_link, doc.id);

    // url-kind: tripped by neither wire (no file_key, no mtime to compare)
    const ext = refs.find((r) => (r as unknown as { kind?: string }).kind === 'url')!;
    assert.equal(ext.verify_before_use, undefined, 'url-kind reference is never doc-flagged');
    assert.equal(tools.maintenanceQuery({ system_reason: 'refresh_reference' }).length, 1, 'and enqueues nothing');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§3.2.3 article drift: only a real content change (not an mtime-only merge bump) or deletion flags; no baseline → abstain; reconciliation clears; H7 items dedup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-art-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, repoRoot: dir });
  const article = (slug: string, path: string) =>
    tools.knowledgeCreate('feature_article', {
      slug,
      title: slug,
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path, role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: '2026-06-01T00:00:00.000Z', event: 'originating brief' }],
      live_test_refs: [],
    }).record;
  const old = new Date('2026-01-01T00:00:00Z');
  const reconciled = (slug: string) =>
    tools.maintenanceQuery({ system_reason: 'reconcile_needed', cap: 1000 }).filter((t) => new RegExp(`'${slug}'`).test((t as { text: string }).text));
  try {
    const future = new Date(Date.now() + 3_600_000);
    const aPath = join(dir, 'src', 'a.mjs');
    writeFileSync(aPath, 'v1');
    utimesSync(aPath, old, old);
    const a = article('feat-a', 'src/a.mjs'); // baseline = sha256('v1')
    assert.ok((a as unknown as { file_baselines?: Record<string, string> }).file_baselines?.['src/a.mjs'], 'article records a content baseline at create');

    // owned file older than updated_at: clean read, nothing enqueued
    let arts = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts.find((r) => r.id === a.id)?.verify_before_use, undefined, 'fresh article not flagged');
    assert.equal(reconciled('feat-a').length, 0);

    // mtime-only bump past updated_at, content STILL 'v1' (the git merge/checkout
    // case): the content baseline matches, so NOT drift — no flag, nothing enqueued.
    // This is the false-positive the baseline wire exists to kill.
    utimesSync(aPath, future, future);
    for (let i = 0; i < 3; i++) {
      arts = tools.knowledgeQuery({ types: ['feature_article'] });
      assert.equal(arts.find((r) => r.id === a.id)?.verify_before_use, undefined, `mtime-only bump not flagged (read ${i + 1})`);
    }
    assert.equal(reconciled('feat-a').length, 0, 'mtime-only bump enqueues nothing');

    // genuine out-of-band edit: content changes AND mtime is past updated_at —
    // flagged every read, ONE item
    writeFileSync(aPath, 'v2');
    utimesSync(aPath, future, future);
    for (let i = 0; i < 3; i++) {
      arts = tools.knowledgeQuery({ types: ['feature_article'] });
      assert.equal(arts.find((r) => r.id === a.id)?.verify_before_use, true, `content edit flagged at read ${i + 1}`);
    }
    assert.equal(reconciled('feat-a').length, 1, 'deduplicated across repeated reads');
    assert.match((reconciled('feat-a')[0] as { text: string }).text, /out-of-band edit/);

    // reconciliation clears mechanically: knowledge_update re-baselines to the
    // current content ('v2') AND bumps updated_at, so the article reads clean
    const v2 = tools.knowledgeUpdate(a.id, { what_it_does: 'trued up' });
    arts = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts.find((r) => r.id === v2.id)?.verify_before_use, undefined, 'reconciled article reads clean');
    // and the re-baseline immunizes against the next merge: bump mtime, same content
    utimesSync(aPath, future, future);
    arts = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts.find((r) => r.id === v2.id)?.verify_before_use, undefined, 'post-reconcile mtime bump stays clean');

    // no baseline → abstain: an article created while its owned file was absent
    // carries no baseline; a later mtime past updated_at cannot be confirmed as a
    // content change, so the check abstains (mtime alone is not trusted) rather
    // than raise a false flag — the legacy/migration path
    const dPath = join(dir, 'src', 'd.mjs');
    const d = article('feat-d', 'src/d.mjs'); // d.mjs absent at create → no baseline
    assert.equal((d as unknown as { file_baselines?: unknown }).file_baselines, undefined, 'no baseline when the owned file is absent at create');
    writeFileSync(dPath, 'v1');
    utimesSync(dPath, future, future);
    arts = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts.find((r) => r.id === d.id)?.verify_before_use, undefined, 'no baseline → mtime alone does not flag');
    assert.equal(reconciled('feat-d').length, 0, 'no baseline → nothing enqueued');

    // deletion is drift: missing owned file flags + names the file (baseline-independent)
    const bPath = join(dir, 'src', 'b.mjs');
    writeFileSync(bPath, 'v1');
    utimesSync(bPath, old, old);
    const b = article('feat-b', 'src/b.mjs');
    rmSync(bPath);
    arts = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts.find((r) => r.id === b.id)?.verify_before_use, true, 'deleted owned file flags the article');
    assert.match((reconciled('feat-b')[0] as { text: string }).text, /no longer exists/);

    // an open H7-style reconcile_needed item (same feature_link) suppresses a
    // second enqueue — seeded with a DIFFERENT file key so this pins that the
    // dedup is feature_link-based, not file_keys-based. A REAL content edit
    // triggers the drift wire so the dedup path is actually exercised.
    const cPath = join(dir, 'src', 'c.mjs');
    writeFileSync(cPath, 'v1');
    utimesSync(cPath, old, old);
    const c = article('feat-c', 'src/c.mjs');
    tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: "reconcile article 'feat-c' — files it owns were touched in direct mode", file_keys: ['src/other.mjs'], feature_link: c.id });
    writeFileSync(cPath, 'v2');
    utimesSync(cPath, future, future);
    tools.knowledgeQuery({ types: ['feature_article'] });
    const cItems = tools.maintenanceQuery({ system_reason: 'reconcile_needed', cap: 1000 }).filter((t) => (t as { feature_link?: string }).feature_link === c.id);
    assert.equal(cItems.length, 1, 'H7 item and drift wire share one drain surface');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generated projections (regen↔baseline circularity): a config-registered generated file never content-flags — regen churn is not drift; deletion still flags; unregistered files unaffected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-genproj-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({
    store,
    repoRoot: dir,
    config: parseConfig({ generated_projections: ['architecture.md', 'gen-doc.md'] }),
  });
  const article = (slug: string, path: string) =>
    tools.knowledgeCreate('feature_article', {
      slug,
      title: slug,
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path, role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: '2026-06-01T00:00:00.000Z', event: 'originating brief' }],
      live_test_refs: [],
    }).record;
  const items = (slug: string) =>
    tools.maintenanceQuery({ system_reason: 'reconcile_needed', cap: 1000 }).filter((t) => new RegExp(`'${slug}'`).test((t as { text: string }).text));
  try {
    const old = new Date('2026-01-01T00:00:00Z');
    const future = new Date(Date.now() + 3_600_000);

    // the projection article owns the generated file (baseline = sha256('as of v1'))
    const projPath = join(dir, 'architecture.md');
    writeFileSync(projPath, 'as of v1');
    utimesSync(projPath, old, old);
    const proj = article('projection', 'architecture.md');

    // 1. regen churn: content changes AND mtime moves past updated_at — the exact
    // sequence that re-armed the detector after every drain (the circularity).
    // Registered generated file → no flag, nothing enqueued, on repeated reads.
    writeFileSync(projPath, 'as of v2');
    utimesSync(projPath, future, future);
    for (let i = 0; i < 3; i++) {
      const arts = tools.knowledgeQuery({ types: ['feature_article'] });
      assert.equal(arts.find((r) => r.id === proj.id)?.verify_before_use, undefined, `regen churn not flagged (read ${i + 1})`);
    }
    assert.equal(items('projection').length, 0, 'regen churn enqueues nothing');

    // 2. deletion is STILL drift — the exemption covers only the content arm
    rmSync(projPath);
    const arts = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts.find((r) => r.id === proj.id)?.verify_before_use, true, 'deleted generated file still flags');
    assert.match((items('projection')[0] as { text: string }).text, /no longer exists/);

    // 3. path-scoped, not config-global: an unregistered file in the same store
    // still content-flags
    const srcPath = join(dir, 'src', 'a.mjs');
    writeFileSync(srcPath, 'v1');
    utimesSync(srcPath, old, old);
    const plain = article('plain', 'src/a.mjs');
    writeFileSync(srcPath, 'v2');
    utimesSync(srcPath, future, future);
    const arts2 = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts2.find((r) => r.id === plain.id)?.verify_before_use, true, 'unregistered file still content-flags');
    assert.match((items('plain')[0] as { text: string }).text, /out-of-band edit/);

    // 4. the reference_material wire honors the same registration: a generated
    // doc's content churn neither flags nor enqueues refresh_reference
    const genDocPath = join(dir, 'gen-doc.md');
    writeFileSync(genDocPath, 'v1');
    utimesSync(genDocPath, old, old);
    const { record: genDoc } = tools.knowledgeCreate('reference_material', {
      title: 'Gen Doc',
      kind: 'doc',
      location: 'gen-doc.md',
      summary: 'generated',
      source_date: '2026-06-01T00:00:00.000Z',
      capture_date: '2026-06-01T00:00:00.000Z',
    });
    writeFileSync(genDocPath, 'v2');
    utimesSync(genDocPath, future, future);
    const refs = tools.knowledgeQuery({ types: ['reference_material'] });
    assert.equal(refs.find((r) => r.id === genDoc.id)?.verify_before_use, undefined, 'generated doc churn not refresh-flagged');
    assert.equal(tools.maintenanceQuery({ system_reason: 'refresh_reference' }).length, 0, 'generated doc churn enqueues nothing');

    // 5. per-path within ONE article (correctness-review observation A): the
    // exemption neither suppresses a normal sibling nor promotes drift itself.
    // Registered file FIRST in files[] — the loop must continue past it and
    // still flag the normal sibling's content change:
    const mixedArticle = (slug: string, paths: string[]) =>
      tools.knowledgeCreate('feature_article', {
        slug,
        title: slug,
        what_it_does: 'x',
        intended_behavior: 'x',
        files: paths.map((path) => ({ path, role: 'impl' })),
        current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
        dependencies: { relies_on: [], relied_by: [] },
        state: 'active',
        version: 1,
        history: [{ date: '2026-06-01T00:00:00.000Z', event: 'originating brief' }],
        live_test_refs: [],
      }).record;
    const mixPath = join(dir, 'src', 'mix.mjs');
    writeFileSync(mixPath, 'v1');
    utimesSync(mixPath, old, old);
    const mixed = mixedArticle('mixed', ['gen-doc.md', 'src/mix.mjs']);
    writeFileSync(genDocPath, 'v3');
    utimesSync(genDocPath, future, future);
    writeFileSync(mixPath, 'v2');
    utimesSync(mixPath, future, future);
    const arts3 = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts3.find((r) => r.id === mixed.id)?.verify_before_use, true, 'normal sibling still content-flags past the exempted projection');
    assert.match((items('mixed')[0] as { text: string }).text, /src\/mix\.mjs/);
    // Reverse composition — normal sibling UNCHANGED, registered file churned:
    // the exemption must not promote drift; the article reads clean.
    const mix2Path = join(dir, 'src', 'mix2.mjs');
    writeFileSync(mix2Path, 'v1');
    utimesSync(mix2Path, old, old);
    const mixed2 = mixedArticle('mixed2', ['src/mix2.mjs', 'gen-doc.md']);
    writeFileSync(genDocPath, 'v4');
    utimesSync(genDocPath, future, future);
    const arts4 = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts4.find((r) => r.id === mixed2.id)?.verify_before_use, undefined, 'projection churn alone never flags a mixed article');
    assert.equal(items('mixed2').length, 0, 'projection churn alone enqueues nothing');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('working_tree resolution (comsoft-juiced incident): copy files resolve against the mapped tree, not the project root; unmapped name abstains loud; the false-deletion item drains BY the fix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-root-'));
  const copy = mkdtempSync(join(tmpdir(), 'sterling-copy-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(copy, 'src'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, repoRoot: dir, config: parseConfig({ working_trees: { juiced: copy } }) });
  const article = (slug: string, path: string, extra: Record<string, unknown> = {}) =>
    tools.knowledgeCreate('feature_article', {
      slug,
      title: slug,
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path, role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: '2026-06-01T00:00:00.000Z', event: 'originating brief' }],
      live_test_refs: [],
      ...extra,
    }).record;
  const items = (slug: string) =>
    tools.maintenanceQuery({ system_reason: 'reconcile_needed', cap: 1000 }).filter((t) => new RegExp(`'${slug}'`).test((t as { text: string }).text));
  const old = new Date('2026-01-01T00:00:00Z');
  const future = new Date(Date.now() + 3_600_000);
  try {
    // 1. COPY-ONLY file (the incident): exists in the mapped tree, absent from the
    // project root. With working_tree declared, the article reads CLEAN — no false
    // "out-of-band deletion", no queue item — and its baseline hashes the COPY's bytes.
    writeFileSync(join(copy, 'src', 'juice.mjs'), 'jv1');
    utimesSync(join(copy, 'src', 'juice.mjs'), old, old);
    const j = article('juice-feel', 'src/juice.mjs', { working_tree: 'juiced' });
    assert.ok((j as unknown as { file_baselines?: Record<string, string> }).file_baselines?.['src/juice.mjs'], 'baseline computed from the mapped tree even though the root lacks the file');
    let arts = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts.find((r) => r.id === j.id)?.verify_before_use, undefined, 'copy-only file is NOT a deletion');
    assert.equal(items('juice-feel').length, 0, 'no false deletion item');

    // 2. SAME-NAMED file in both trees, different content: the baseline is the
    // COPY's — an out-of-band edit to the ROOT file must NOT flag the copy article,
    // an edit to the COPY file must.
    writeFileSync(join(dir, 'src', 'modules.mjs'), 'root-v');
    writeFileSync(join(copy, 'src', 'modules.mjs'), 'copy-v');
    utimesSync(join(dir, 'src', 'modules.mjs'), old, old);
    utimesSync(join(copy, 'src', 'modules.mjs'), old, old);
    const m = article('mods', 'src/modules.mjs', { working_tree: 'juiced' });
    writeFileSync(join(dir, 'src', 'modules.mjs'), 'root-v2');
    utimesSync(join(dir, 'src', 'modules.mjs'), future, future);
    arts = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts.find((r) => r.id === m.id)?.verify_before_use, undefined, 'a ROOT edit never flags a copy article');
    writeFileSync(join(copy, 'src', 'modules.mjs'), 'copy-v2');
    utimesSync(join(copy, 'src', 'modules.mjs'), future, future);
    arts = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts.find((r) => r.id === m.id)?.verify_before_use, true, 'a COPY edit flags the copy article');
    assert.match((items('mods')[0] as { text: string }).text, /out-of-band edit/);

    // 3. Deletion IN THE COPY is real drift — the tree-aware check still catches it.
    rmSync(join(copy, 'src', 'juice.mjs'));
    arts = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts.find((r) => r.id === j.id)?.verify_before_use, true, 'a file deleted in ITS tree still flags');
    assert.match((items('juice-feel')[0] as { text: string }).text, /no longer exists/);

    // 4. UNMAPPED tree name: abstain LOUD — verify_before_use, no queue item, no
    // resolution against the wrong tree.
    const g = article('ghost-tree', 'src/whatever.mjs', { working_tree: 'ghost' });
    assert.equal((g as unknown as { file_baselines?: unknown }).file_baselines, undefined, 'no baseline fabricated for an unmapped tree');
    arts = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts.find((r) => r.id === g.id)?.verify_before_use, true, 'unmapped tree name reads loud');
    assert.equal(items('ghost-tree').length, 0, 'and enqueues nothing');

    // 5. ACCEPTANCE REPLAY — the incident's nine false todos drain BY the fix:
    // an article WITHOUT working_tree owning a copy-only path gets the false
    // deletion item (the bug); knowledge_update adding working_tree re-baselines
    // against the right tree AND auto-drains the item through the supersede chain.
    writeFileSync(join(copy, 'src', 'hull.mjs'), 'hv1');
    utimesSync(join(copy, 'src', 'hull.mjs'), old, old);
    const h = article('hull-traits', 'src/hull.mjs'); // no working_tree → resolves against root → false deletion
    tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(items('hull-traits').length, 1, 'the incident: root resolution mints a false deletion item');
    const healed = tools.knowledgeUpdate(h.id, { working_tree: 'juiced' });
    assert.equal(items('hull-traits').length, 0, 'the fix drains the item — knowledge_update auto-drain, no manual deletion');
    assert.ok((healed as unknown as { file_baselines?: Record<string, string> }).file_baselines?.['src/hull.mjs'], 're-baselined against the correct tree');
    arts = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts.find((r) => r.id === healed.id)?.verify_before_use, undefined, 'healed article reads clean');

    // 6. A root-tree deletion still flags (the mechanism is scoped, not weakened).
    writeFileSync(join(dir, 'src', 'rootfile.mjs'), 'rv1');
    utimesSync(join(dir, 'src', 'rootfile.mjs'), old, old);
    const r = article('root-feat', 'src/rootfile.mjs');
    rmSync(join(dir, 'src', 'rootfile.mjs'));
    arts = tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(arts.find((x) => x.id === r.id)?.verify_before_use, true, 'root deletions still flag');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  }
});
