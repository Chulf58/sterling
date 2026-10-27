// knowledge_retire(id, reason: 'feature_removed') — the gated no-successor
// retirement (GitHub #217, user-ruled 2026-10-27 "Gated no-successor retire
// (Recommended)", narrowing decision 9948475b for this shape only). A deprecated
// feature_article whose files are all gone (and not parked on another branch)
// and that no active article relies on, in either direction, is retired with no
// successor: kept, status superseded, superseded_by null, retired_reason
// 'feature_removed', and knowledge_get discloses "retired: feature removed".
// Every other shape is refused naming what failed, and nothing is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, MountedStores, createDomain } from '@sterling/store';
import { parseConfig } from '@sterling/schemas';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SterlingTools } from '../tools.js';
import { createSterlingServer } from '../server.js';

const NOW = '2026-10-27T12:00:00.000Z';
type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-retire-removed-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  return { dir, store, tools, git, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** Commit `path` on main, then delete it in a second commit: history exists and no live ref holds it. */
function goneFile(h: ReturnType<typeof harness>, path: string) {
  mkdirSync(join(h.dir, path, '..'), { recursive: true });
  writeFileSync(join(h.dir, path), 'export const x = 1;\n');
  h.git('add', '-A');
  h.git('commit', '-qm', `add ${path}`);
  h.git('rm', '-q', path);
  h.git('commit', '-qm', `remove ${path}`);
}

function article(slug: string, files: string[], over: Loose = {}): Loose {
  return {
    id: randomUUID(), type: 'feature_article', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
    slug, title: slug, what_it_does: 'x', intended_behavior: 'x',
    files: files.map((path) => ({ path, role: 'impl' })),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] }, state: 'deprecated', state_reason: 'feature deleted', version: 1,
    history: [{ date: NOW, event: 'seed' }], live_test_refs: [], ...over,
  };
}

const retireRemoved = (tools: SterlingTools, id: string) => tools.knowledgeRetire(id, undefined, 'feature_removed');

function assertUntouched(store: SterlingStore, id: string) {
  const r = store.get(id) as unknown as Loose;
  assert.equal(r.status, 'active', 'a refusal writes nothing');
  assert.equal(r.retired_reason, undefined);
}

test('reason feature_removed retires an eligible article with no successor, keeps it, and hides it from ordinary queries', () => {
  const h = harness();
  try {
    goneFile(h, 'src/old.ts');
    goneFile(h, 'src/old-helper.ts');
    const target = h.store.create(article('old-feature', ['src/old.ts', 'src/old-helper.ts']));
    // A deprecated, a dormant and an active-but-unrelated article do not block.
    h.store.create(article('dep-user', [], { dependencies: { relies_on: ['old-feature'], relied_by: [] } }));
    h.store.create(article('dormant-user', [], { state: 'dormant', wiring_todo_id: randomUUID(), dependencies: { relies_on: ['old-feature'], relied_by: [] } }));
    h.store.create(article('bystander', [], { state: 'active' }));

    const { retired } = retireRemoved(h.tools, target.id);
    const r = retired as unknown as Loose;
    assert.equal(r.id, target.id);
    assert.equal(r.status, 'superseded');
    assert.equal(r.superseded_by, null);
    assert.equal(r.retired_reason, 'feature_removed');
    const history = r.history as { event: string }[];
    assert.match(history[history.length - 1].event, /retired: feature removed/);
    assert.deepEqual((r.files as { path: string }[]).map((f) => f.path), ['src/old.ts', 'src/old-helper.ts'], 'dead paths stay as historical ownership');

    const got = h.tools.knowledgeGet(target.id) as Loose;
    assert.equal(got.status, 'superseded');
    assert.deepEqual(got.terminus, { id: target.id, status: 'superseded', hops: 0, retired: 'feature removed' });

    const served = h.tools.knowledgeQuery({ types: ['feature_article'] }) as unknown as Loose[];
    assert.ok(!served.some((x) => x.id === target.id), 'knowledge_query no longer serves the retired article');
    assert.ok(!h.store.query({ types: ['feature_article'], cap: 100 }).some((x) => x.id === target.id), 'store.query excludes it');
    assert.ok(served.some((x) => x.slug === 'bystander'));

    assert.throws(() => retireRemoved(h.tools, target.id), /already superseded/);
  } finally {
    h.cleanup();
  }
});

test('knowledge_get labels the terminus when an older duplicate forwards into a removed feature, and not for a chain ending at a live survivor', () => {
  const h = harness();
  try {
    goneFile(h, 'src/old.ts');
    const survivor = h.store.create(article('old-feature', ['src/old.ts']));
    const dup = h.store.create(article('old-feature-dup', ['src/old.ts']));
    h.tools.knowledgeRetire(dup.id, survivor.id);
    const before = h.tools.knowledgeGet(dup.id) as Loose;
    assert.deepEqual(before.terminus, { id: survivor.id, status: 'active', hops: 1 }, 'a chain ending at a live record carries no removed label');

    retireRemoved(h.tools, survivor.id);
    const after = h.tools.knowledgeGet(dup.id) as Loose;
    assert.deepEqual(after.terminus, { id: survivor.id, status: 'superseded', hops: 1, retired: 'feature removed' });
  } finally {
    h.cleanup();
  }
});

test('a chain whose successor no store holds is truncated and is never labelled feature removed', () => {
  const h = harness();
  try {
    const live = h.store.create(article('ghost-target', [], { state: 'active' }));
    // Legacy insert shape: retired with a forward pointer to a record that does not exist.
    const broken = h.store.create(article('broken-chain', [], { status: 'superseded', superseded_by: randomUUID() }));
    const got = h.tools.knowledgeGet(broken.id) as Loose;
    const terminus = got.terminus as Loose;
    assert.equal(terminus.truncated, true);
    assert.equal(terminus.retired, undefined);
    assert.ok(live.id);
  } finally {
    h.cleanup();
  }
});

test('refusals: wrong type, not deprecated, a file still present, and a parked file each name what failed', () => {
  const h = harness();
  try {
    goneFile(h, 'src/old.ts');
    const decision = h.store.create({
      id: randomUUID(), type: 'decision', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null,
      links: [], scope: 'project', stack_tags: [], slug: 'some-decision', title: 'A decision', statement: 'We do X.',
      alternatives_rejected: [], rationale: 'because', file_keys: [],
    });
    assert.throws(() => retireRemoved(h.tools, decision.id), /only for a deprecated feature_article, and '.*' is a decision/);

    const active = h.store.create(article('still-active', ['src/old.ts'], { state: 'active' }));
    assert.throws(() => retireRemoved(h.tools, active.id), /its state is 'active', not 'deprecated'/);
    assertUntouched(h.store, active.id);

    mkdirSync(join(h.dir, 'src'), { recursive: true });
    writeFileSync(join(h.dir, 'src', 'here.ts'), 'x\n');
    const present = h.store.create(article('present', ['src/old.ts', 'src/here.ts']));
    assert.throws(() => retireRemoved(h.tools, present.id), /'src\/here\.ts' is still present in /);
    assertUntouched(h.store, present.id);

    // Parked: the file lives on an unmerged branch, and main deleted it.
    h.git('checkout', '-q', '-b', 'feat/keep');
    writeFileSync(join(h.dir, 'src', 'parked.ts'), 'p\n');
    h.git('add', 'src/parked.ts');
    h.git('commit', '-qm', 'parked work');
    h.git('checkout', '-q', 'main');
    const parked = h.store.create(article('parked', ['src/old.ts', 'src/parked.ts']));
    assert.throws(() => retireRemoved(h.tools, parked.id), /'src\/parked\.ts' is absent here but parked on branch 'feat\/keep'/);
    assertUntouched(h.store, parked.id);
  } finally {
    h.cleanup();
  }
});

test('strict parked probe: a file only on the 41st branch, past the read path\'s 40-branch cap, still refuses', () => {
  const h = harness();
  try {
    goneFile(h, 'src/old.ts');
    for (let i = 0; i < 40; i++) h.git('branch', `b${String(i).padStart(2, '0')}`);
    h.git('checkout', '-q', '-b', 'b40');
    mkdirSync(join(h.dir, 'src'), { recursive: true });
    writeFileSync(join(h.dir, 'src', 'late.ts'), 'late\n');
    h.git('add', 'src/late.ts');
    h.git('commit', '-qm', 'late work');
    h.git('checkout', '-q', 'main');
    const a = h.store.create(article('late-parked', ['src/old.ts', 'src/late.ts']));
    // The read path keeps its best-effort cap: it scans 40 branches and misses b40.
    const readProbe = (h.tools as unknown as { parkedOnRef: (rel: string, root: string) => { status: string } }).parkedOnRef('src/late.ts', h.dir);
    assert.notEqual(readProbe.status, 'parked', 'the capped read-path probe is unchanged');
    assert.throws(() => retireRemoved(h.tools, a.id), /'src\/late\.ts' is absent here but parked on branch 'b40'/);
    assertUntouched(h.store, a.id);
  } finally {
    h.cleanup();
  }
});

test('strict parked probe: a branch and a tag both named release do not make an eligible article refuse', () => {
  const h = harness();
  try {
    goneFile(h, 'src/old.ts');
    // Under %(refname:short) this branch prints as 'heads/release' because the tag shares its name.
    h.git('branch', 'release');
    h.git('tag', 'release');
    const a = h.store.create(article('tag-collision', ['src/old.ts']));
    assert.equal((retireRemoved(h.tools, a.id).retired as unknown as Loose).retired_reason, 'feature_removed');
  } finally {
    h.cleanup();
  }
});

/** Put a `git` first on PATH that fails `ls-tree` for any ref naming `zz-broken` and runs the real git otherwise. */
function withBrokenLsTree<T>(dir: string, fn: () => T): T {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(real, 'git is on PATH');
  const bin = join(dir, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\ncase " $* " in *" ls-tree "*zz-broken*) echo "fatal: injected ls-tree failure" >&2; exit 128;; esac\nexec "${real}" "$@"\n`
  );
  chmodSync(join(bin, 'git'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved ?? ''}`;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

test('strict parked probe: a git failure while checking one branch refuses and names the failed command', () => {
  const h = harness();
  try {
    goneFile(h, 'src/old.ts');
    h.git('branch', 'zz-broken');
    const a = h.store.create(article('probe-fails', ['src/old.ts']));
    withBrokenLsTree(h.dir, () => {
      assert.throws(
        () => retireRemoved(h.tools, a.id),
        /'src\/old\.ts' is absent, but git could not prove it is not parked on another branch \(git ls-tree refs\/heads\/zz-broken: fatal: injected ls-tree failure\)/
      );
    });
    assertUntouched(h.store, a.id);
    // Without the injected failure the same article is eligible.
    assert.equal((retireRemoved(h.tools, a.id).retired as unknown as Loose).retired_reason, 'feature_removed');
  } finally {
    h.cleanup();
  }
});

test('refusals: an active article relying on it blocks in both directions (its relies_on, and the derived relied_by)', () => {
  const h = harness();
  try {
    goneFile(h, 'src/old.ts');
    const a = h.store.create(article('needed', ['src/old.ts']));
    h.store.create(article('consumer', [], { state: 'wired_in', dependencies: { relies_on: ['needed'], relied_by: [] } }));
    // The store derives relied_by at read time from other articles' relies_on
    // (a stored relied_by is replaced and marked relied_by_stored_stale), so the
    // same live consumer shows up in both directions of the check.
    assert.deepEqual((h.store.get(a.id) as unknown as { dependencies: { relied_by: string[] } }).dependencies.relied_by, ['consumer']);
    assert.throws(() => retireRemoved(h.tools, a.id), (err: Error) => {
      assert.match(err.message, /active article\(s\) consumer rely on it \(relies_on\)/);
      assert.match(err.message, /its relied_by names active article\(s\) consumer/);
      return true;
    });
    assertUntouched(h.store, a.id);

    // An active article relying on it by legacy id (not slug) blocks too.
    const b = h.store.create(article('needed-by-id', ['src/old.ts']));
    h.store.create(article('id-consumer', [], { state: 'active', dependencies: { relies_on: [b.id], relied_by: [] } }));
    assert.throws(() => retireRemoved(h.tools, b.id), /active article\(s\) id-consumer rely on it/);
    assertUntouched(h.store, b.id);
  } finally {
    h.cleanup();
  }
});

test('refusals: both or neither of in_favor_of and reason, an unknown reason, and a slug or prefix instead of the full uuid', () => {
  const h = harness();
  try {
    goneFile(h, 'src/old.ts');
    const a = h.store.create(article('old-feature', ['src/old.ts']));
    const b = h.store.create(article('other', [], { state: 'active' }));
    assert.throws(() => h.tools.knowledgeRetire(a.id, b.id, 'feature_removed'), /pass in_favor_of OR reason, never both/);
    assert.throws(() => h.tools.knowledgeRetire(a.id), /pass in_favor_of .* or reason 'feature_removed'/);
    assert.throws(() => h.tools.knowledgeRetire(a.id, undefined, 'obsolete'), /reason 'obsolete' is not one of feature_removed/);
    assert.throws(() => retireRemoved(h.tools, 'old-feature'), /needs the record's full uuid/);
    assert.throws(() => retireRemoved(h.tools, a.id.slice(0, 8)), /needs the record's full uuid/);
    assertUntouched(h.store, a.id);
    assertUntouched(h.store, b.id);
  } finally {
    h.cleanup();
  }
});

test('refusal: a domain-held article is refused by its physical store, whatever its body scope says', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-retire-removed-domain-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const domainDb = join(dir, 'domains', 'shared', 'sterling.db');
    createDomain('shared', 'test domain shared', domainDb);
    const raw = new SterlingStore(domainDb);
    // scope 'project' in the body on purpose: the holder is what decides.
    const held = raw.create(article('domain-feature', ['src/gone.ts']));
    raw.close();
    const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'shared', dbPath: domainDb }]);
    try {
      const tools = new SterlingTools({ store, config: parseConfig({ stack_tags: ['shared'] }), now: () => NOW, repoRoot: dir });
      assert.throws(() => tools.knowledgeRetire(held.id, undefined, 'feature_removed'), /held by the 'domain:shared' store, not the project store/);
      assert.equal((store.get(held.id) as unknown as Loose).status, 'active');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP registration: knowledge_retire takes the reason form with no in_favor_of, and refuses an unknown reason and both arguments', async () => {
  const h = harness();
  h.store.close();
  writeFileSync(join(h.dir, '.sterling', 'config.json'), '{}');
  const { server, store } = createSterlingServer(join(h.dir, '.sterling', 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    goneFile(h, 'src/old.ts');
    const target = store.create(article('old-feature', ['src/old.ts']));
    const other = store.create(article('other', [], { state: 'active' }));
    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

    const bad = await client.callTool({ name: 'knowledge_retire', arguments: { id: target.id, reason: 'obsolete' } });
    assert.equal(bad.isError, true, 'the input schema refuses a reason outside RETIRED_REASONS');
    const both = await client.callTool({ name: 'knowledge_retire', arguments: { id: target.id, in_favor_of: other.id, reason: 'feature_removed' } });
    assert.equal(both.isError, true);
    assert.match(text(both), /pass in_favor_of OR reason, never both/);
    assert.equal((store.get(target.id) as unknown as Loose).status, 'active');

    const ok = await client.callTool({ name: 'knowledge_retire', arguments: { id: target.id, reason: 'feature_removed' } });
    assert.notEqual(ok.isError, true, text(ok));
    const retired = (JSON.parse(text(ok)) as { retired: Loose }).retired;
    assert.equal(retired.status, 'superseded');
    assert.equal(retired.superseded_by, null);
    assert.equal(retired.retired_reason, 'feature_removed');
    const got = JSON.parse(text(await client.callTool({ name: 'knowledge_get', arguments: { id: target.id } }))) as Loose;
    assert.equal((got.terminus as Loose).retired, 'feature removed');
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});
