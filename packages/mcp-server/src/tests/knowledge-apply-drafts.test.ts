// GitHub #290: on OpenCode an agent's file reader cuts every line at 2,000
// characters, so a librarian could not apply a drafted field longer than that
// from a file. knowledge_apply_drafts reads a drafts file in the project's
// .sterling/drafts/ folder server-side and runs each op through the same code
// as knowledge_update / knowledge_append / knowledge_edit / knowledge_array_remove.
// Every test goes through the served MCP path (tools/call over the SDK client).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSterlingServer } from '../server.js';

type Loose = Record<string, unknown>;

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-apply-drafts-'));
  mkdirSync(join(dir, '.sterling', 'drafts'), { recursive: true });
  // The store sits at <project>/.sterling/sterling.db, so the project root is dir.
  const { server, store, tools } = createSterlingServer(join(dir, '.sterling', 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const cleanup = async () => {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  const draft = (name: string, ops: unknown) => {
    const path = join(dir, '.sterling', 'drafts', name);
    writeFileSync(path, typeof ops === 'string' ? ops : JSON.stringify(ops));
    return path;
  };
  const apply = (args: Loose) => client.callTool({ name: 'knowledge_apply_drafts', arguments: args });
  const decision = (title = 'apply drafts fixture decision'): string =>
    (tools.knowledgeCreate('decision', { title, statement: 'the statement before', alternatives_rejected: [], rationale: 'short' }).record as unknown as { id: string }).id;
  const get = (id: string) => tools.knowledgeGet(id) as unknown as Loose;
  return { dir, client, store, tools, cleanup, draft, apply, decision, get };
}

// The tool refuses off Linux (it pins the drafts folder through /proc/self/fd),
// so every test that expects it to open a draft runs on Linux only.
const linuxOnly = { skip: process.platform !== 'linux' ? 'the tool pins the drafts folder through /proc/self/fd (Linux/WSL)' : false };

const text = (res: unknown): string => ((res as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n');

// A value well past the 2,000-character line limit, with multi-byte characters,
// quotes, backslashes and newlines, so a byte-exact round trip is a real test.
const LONG = Array.from({ length: 5000 }, (_, i) => (i % 97 === 0 ? '\n' : i % 89 === 0 ? 'æ' : i % 83 === 0 ? '"' : i % 79 === 0 ? '\\' : String.fromCharCode(97 + (i % 26)))).join('');

test('the tool is served with a strict top-level schema of {path, dry_run}', async () => {
  const h = await harness();
  try {
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'knowledge_apply_drafts');
    assert.ok(tool, 'knowledge_apply_drafts is registered');
    assert.deepEqual(Object.keys((tool!.inputSchema as { properties: Loose }).properties).sort(), ['dry_run', 'path']);
    const res = await h.apply({ path: 'x.json', zz_unknown: 1 });
    assert.equal(res.isError, true);
    assert.match(text(res), /unrecognized_keys/);
  } finally {
    await h.cleanup();
  }
});

test('a 5,000-character field value is applied byte-exact, with update, append and edit ops in one file', linuxOnly, async () => {
  const h = await harness();
  try {
    assert.equal(LONG.length, 5000);
    const id = h.decision();
    h.draft('long.json', [
      { op: 'update', id, body: { rationale: LONG } },
      { op: 'append', id, field: 'alternatives_rejected', entries: [{ option: 'chunked drafts', reason: 'many round trips' }] },
      { op: 'edit', id, field: 'statement', find: 'before', replace: 'after' },
    ]);
    const res = await h.apply({ path: 'long.json' });
    assert.notEqual(res.isError, true, text(res));
    const rec = h.get(id);
    assert.equal(rec.rationale, LONG, 'the stored value equals the drafted value exactly');
    assert.equal(createHash('sha256').update(rec.rationale as string).digest('hex'), createHash('sha256').update(LONG).digest('hex'));
    assert.equal(rec.statement, 'the statement after');
    assert.deepEqual(rec.alternatives_rejected, [{ option: 'chunked drafts', reason: 'many round trips' }]);
    const receipt = JSON.parse(text(res)) as { path: string; applied: Loose[]; file_removed: boolean };
    assert.equal(receipt.path, '.sterling/drafts/long.json');
    assert.equal(receipt.file_removed, true, 'a fully applied drafts file is removed, and the receipt says so');
    assert.equal(existsSync(join(h.dir, '.sterling', 'drafts', 'long.json')), false, 'the drafts file is gone after a full apply');
    assert.deepEqual(
      receipt.applied.map((a) => [a.index, a.op, a.id, a.version]),
      [
        [0, 'update', id, 2],
        [1, 'append', id, 3],
        [2, 'edit', id, 4],
      ]
    );
    assert.deepEqual(receipt.applied[0]!.written, { rationale: { chars: 5000, utf8_bytes: Buffer.byteLength(LONG, 'utf8') } });
    assert.deepEqual(receipt.applied[1]!.written, { alternatives_rejected: { entries: 1 } });
    assert.deepEqual(receipt.applied[2]!.written, { statement: { chars: 'the statement after'.length, utf8_bytes: 'the statement after'.length } });
  } finally {
    await h.cleanup();
  }
});

test('an absolute path outside the drafts folder and a relative path climbing out of it are refused, nothing written', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    const ops = JSON.stringify([{ op: 'update', id, body: { rationale: 'escaped' } }]);
    const outside = join(h.dir, 'outside.json');
    writeFileSync(outside, ops);
    writeFileSync(join(h.dir, '.sterling', 'beside.json'), ops);
    for (const path of [outside, '../beside.json', '../../outside.json']) {
      const res = await h.apply({ path });
      assert.equal(res.isError, true, `${path} was accepted: ${text(res)}`);
      assert.match(text(res), /outside the drafts folder/);
      assert.match(text(res), /Nothing was written/);
    }
    assert.equal(h.get(id).rationale, 'short');
    assert.equal(h.get(id).version, 1);
  } finally {
    await h.cleanup();
  }
});

test('a symlink inside the drafts folder that points outside it is refused, and so is a drafts folder that is itself a symlink', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    const outside = join(h.dir, 'outside.json');
    writeFileSync(outside, JSON.stringify([{ op: 'update', id, body: { rationale: 'escaped' } }]));
    symlinkSync(outside, join(h.dir, '.sterling', 'drafts', 'link.json'));
    const res = await h.apply({ path: 'link.json' });
    assert.equal(res.isError, true, text(res));
    assert.match(text(res), /outside the drafts folder/);

    rmSync(join(h.dir, '.sterling', 'drafts'), { recursive: true });
    mkdirSync(join(h.dir, 'elsewhere'));
    writeFileSync(join(h.dir, 'elsewhere', 'ops.json'), JSON.stringify([{ op: 'update', id, body: { rationale: 'escaped' } }]));
    symlinkSync(join(h.dir, 'elsewhere'), join(h.dir, '.sterling', 'drafts'));
    const viaDir = await h.apply({ path: 'ops.json' });
    assert.equal(viaDir.isError, true, text(viaDir));
    assert.match(text(viaDir), /not a real directory/);
    assert.equal(h.get(id).rationale, 'short');
  } finally {
    await h.cleanup();
  }
});

test('a create op is refused and the whole file writes nothing, even the valid op before it', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    h.draft('create.json', [
      { op: 'update', id, body: { rationale: 'would land' } },
      { op: 'create', type: 'decision', fields: { title: 'new', statement: 's', alternatives_rejected: [], rationale: 'r' } },
    ]);
    const res = await h.apply({ path: 'create.json' });
    assert.equal(res.isError, true, text(res));
    assert.match(text(res), /op 1: op 'create' is refused/);
    assert.match(text(res), /knowledge_create/);
    assert.match(text(res), /nothing was written/);
    assert.equal(h.get(id).version, 1);
    assert.equal(h.get(id).rationale, 'short');
    assert.equal(existsSync(join(h.dir, '.sterling', 'drafts', 'create.json')), true, 'a refused file is kept');
  } finally {
    await h.cleanup();
  }
});

test('a malformed op (unknown argument, unknown op) is refused before any write, naming each bad op', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    h.draft('bad.json', [
      { op: 'update', id, body: { rationale: 'would land' } },
      { op: 'append', id, field: 'alternatives_rejected', entries: [], projection: 'full' },
      { op: 'replace', id },
    ]);
    const res = await h.apply({ path: 'bad.json' });
    assert.equal(res.isError, true, text(res));
    assert.match(text(res), /op 1 \(append\):.*"projection"/);
    assert.match(text(res), /op 2: op must be one of update, append, edit, array_remove/);
    assert.equal(h.get(id).version, 1);
    h.draft('notjson.json', '[{"op":');
    const notJson = await h.apply({ path: 'notjson.json' });
    assert.match(text(notJson), /is not valid JSON/);
  } finally {
    await h.cleanup();
  }
});

test('an op knowledge_update refuses is refused with the same message; earlier ops stay written and later ones are not attempted', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    const other = h.decision('second fixture decision');
    const direct = await h.client.callTool({ name: 'knowledge_update', arguments: { id, body: { status: 'superseded' } } });
    assert.equal(direct.isError, true, 'knowledge_update refuses a server-owned field');
    h.draft('refused.json', [
      { op: 'update', id: other, body: { rationale: 'first op lands' } },
      { op: 'update', id, body: { status: 'superseded' } },
      { op: 'update', id, body: { rationale: 'never attempted' } },
    ]);
    const res = await h.apply({ path: 'refused.json' });
    assert.equal(res.isError, true, text(res));
    assert.ok(text(res).includes(text(direct)), `the refusal carries knowledge_update's own message:\n${text(direct)}\n---\n${text(res)}`);
    assert.match(text(res), /op 1 \(update '.*'\) in \.sterling\/drafts\/refused\.json was refused by knowledge_update/);
    assert.match(text(res), /Ops 0-0 were written and stay written/);
    assert.match(text(res), /Ops 2-2 were not attempted/);
    assert.match(text(res), /The drafts file was kept\. Re-running it applies those ops again/);
    assert.equal(existsSync(join(h.dir, '.sterling', 'drafts', 'refused.json')), true, 'a partial apply keeps the drafts file');
    assert.equal(h.get(other).rationale, 'first op lands');
    assert.equal(h.get(id).rationale, 'short');
    assert.equal(h.get(id).version, 1);
  } finally {
    await h.cleanup();
  }
});

test('array_remove keeps its exact-uuid rule inside a drafts file', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    h.draft('remove.json', [{ op: 'array_remove', id: id.slice(0, 8), selector: 'alternatives_rejected[option=x]', expected_version: 1 }]);
    const res = await h.apply({ path: 'remove.json' });
    assert.equal(res.isError, true, text(res));
    assert.match(text(res), /refused by knowledge_array_remove/);
    assert.match(text(res), /full uuid|FULL UUID|exact/i);
  } finally {
    await h.cleanup();
  }
});

test('resolves on a drafted op closes the named maintenance item, as on knowledge_update', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    const now = new Date().toISOString();
    const itemId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    h.store.create({
      id: itemId,
      type: 'todo',
      created_at: now,
      updated_at: now,
      author: 'system',
      status: 'active',
      superseded_by: null,
      links: [],
      scope: 'project',
      stack_tags: [],
      version: 1,
      text: 'decision drifted',
      source: 'system',
      system_reason: 'state_review',
      file_keys: [],
      feature_link: id,
      priority: 'normal',
    } as never);
    const open = async () =>
      (JSON.parse(text(await h.client.callTool({ name: 'maintenance_query', arguments: {} }))) as { records: Loose[] }).records.map((r) => r.id);
    assert.ok((await open()).includes(itemId), 'the item is open before the apply');
    h.draft('resolves.json', [{ op: 'update', id, body: { rationale: 'reviewed' }, resolves: [itemId] }]);
    const res = await h.apply({ path: 'resolves.json' });
    assert.notEqual(res.isError, true, text(res));
    assert.equal(h.get(id).rationale, 'reviewed');
    assert.ok(!(await open()).includes(itemId), 'the named item is closed by the drafted write');
  } finally {
    await h.cleanup();
  }
});

test('dry_run resolves every record and writes nothing; a missing file is refused', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    h.draft('dry.json', [{ op: 'update', id: id.slice(0, 8), body: { rationale: LONG } }]);
    const res = await h.apply({ path: 'dry.json', dry_run: true });
    assert.notEqual(res.isError, true, text(res));
    assert.deepEqual(JSON.parse(text(res)), { path: '.sterling/drafts/dry.json', dry_run: true, ops: [{ index: 0, op: 'update', id, version: 1 }] });
    assert.equal(h.get(id).rationale, 'short');
    assert.equal(existsSync(join(h.dir, '.sterling', 'drafts', 'dry.json')), true, 'dry_run never deletes the drafts file');
    const missing = await h.apply({ path: 'nope.json' });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /'nope\.json' does not exist/);
  } finally {
    await h.cleanup();
  }
});

test('a delete that fails after a full apply is reported in the receipt, and the writes stand', { skip: process.platform !== 'linux' ? linuxOnly.skip : process.getuid?.() === 0 ? 'directory write permission is not enforced for root' : false }, async () => {
  const h = await harness();
  const drafts = join(h.dir, '.sterling', 'drafts');
  try {
    const id = h.decision();
    h.draft('locked.json', [{ op: 'update', id, body: { rationale: 'landed' } }]);
    chmodSync(drafts, 0o555);
    const res = await h.apply({ path: 'locked.json' });
    assert.notEqual(res.isError, true, text(res));
    const receipt = JSON.parse(text(res)) as Loose;
    assert.equal(receipt.file_removed, false);
    assert.match(String(receipt.file_remove_error), /EACCES|EPERM/);
    assert.equal(h.get(id).rationale, 'landed', 'the write is not undone');
    assert.equal(existsSync(join(drafts, 'locked.json')), true);
  } finally {
    chmodSync(drafts, 0o755);
    await h.cleanup();
  }
});

// Race tests (task-end review of #290): containment checked once by pathname and
// the file then re-opened and unlinked by pathname let a swap between the check
// and the use redirect the read and the delete outside the drafts folder. The
// swap is injected deterministically through a fake fs layer: the CJS `fs`
// functions are wrapped and syncBuiltinESMExports() pushes the wrappers into
// the `node:fs` named imports server.ts uses, so the swap runs at a chosen fs
// call inside the tool, the same way for any implementation. Linux only: the
// tool pins the drafts folder through /proc/self/fd.
const cjsFs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
const WRAPPED = ['openSync', 'lstatSync', 'statSync', 'realpathSync', 'rmSync', 'unlinkSync', 'readFileSync', 'existsSync'] as const;

/** Runs `action` once, before or after the first wrapped fs call whose string
 *  path satisfies `match`. Returns a restore function. */
function injectSwap(match: (path: string) => boolean, when: 'before' | 'after', action: () => void, only?: (typeof WRAPPED)[number]): () => void {
  const orig: Record<string, (...a: unknown[]) => unknown> = {};
  let fired = false;
  let busy = false;
  for (const name of WRAPPED) {
    const fn = cjsFs[name] as (...a: unknown[]) => unknown;
    orig[name] = fn;
    const wrapped = function (this: unknown, ...a: unknown[]) {
      const p = typeof a[0] === 'string' ? a[0] : undefined;
      const hit = !fired && !busy && p !== undefined && (only === undefined || only === name) && (() => { busy = true; try { return match(p); } finally { busy = false; } })();
      const fire = () => { fired = true; busy = true; try { action(); } finally { busy = false; } };
      if (hit && when === 'before') fire();
      const r = fn.apply(this, a);
      if (hit && when === 'after') fire();
      return r;
    };
    if (name === 'realpathSync') (wrapped as unknown as { native: unknown }).native = (fn as unknown as { native: unknown }).native;
    cjsFs[name] = wrapped;
  }
  syncBuiltinESMExports();
  return () => {
    for (const name of WRAPPED) cjsFs[name] = orig[name];
    syncBuiltinESMExports();
  };
}


test('race: the draft swapped for a symlink to an outside file right after it is located is refused, nothing applied', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    const draft = h.draft('leafswap.json', [{ op: 'update', id, body: { rationale: 'from the draft' } }]);
    const outside = join(h.dir, 'outside.json');
    writeFileSync(outside, JSON.stringify([{ op: 'update', id, body: { rationale: 'escaped' } }]));
    const restore = injectSwap((p) => p.endsWith('/leafswap.json'), 'after', () => {
      renameSync(draft, draft + '.orig');
      symlinkSync(outside, draft);
    });
    let res;
    try {
      res = await h.apply({ path: 'leafswap.json' });
    } finally {
      restore();
    }
    assert.notEqual(h.get(id).rationale, 'escaped', 'ops from the outside file were applied');
    assert.equal(res.isError, true, text(res));
    assert.match(text(res), /changed while it was read/);
    assert.equal(h.get(id).version, 1, 'nothing was applied');
    assert.equal(existsSync(outside), true);
  } finally {
    await h.cleanup();
  }
});

test('race: the drafts folder swapped for a symlink to an outside folder right after it is located is refused, nothing applied', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    const drafts = join(h.dir, '.sterling', 'drafts');
    h.draft('ancswap.json', [{ op: 'update', id, body: { rationale: 'from the draft' } }]);
    const outsideDir = join(h.dir, 'outside');
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, 'ancswap.json'), JSON.stringify([{ op: 'update', id, body: { rationale: 'escaped' } }]));
    const restore = injectSwap((p) => p.endsWith('/drafts'), 'after', () => {
      renameSync(drafts, drafts + '.real');
      symlinkSync(outsideDir, drafts);
    });
    let res;
    try {
      res = await h.apply({ path: 'ancswap.json' });
    } finally {
      restore();
    }
    assert.notEqual(h.get(id).rationale, 'escaped', 'ops from the outside folder were applied');
    assert.equal(res.isError, true, text(res));
    assert.match(text(res), /changed while it was read/);
    assert.equal(h.get(id).version, 1, 'nothing was applied');
  } finally {
    await h.cleanup();
  }
});

test('race: the drafts folder swapped for a symlink after the apply and before the delete leaves the outside file alone and keeps the draft', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    const drafts = join(h.dir, '.sterling', 'drafts');
    h.draft('delswap.json', [{ op: 'update', id, body: { rationale: 'landed' } }]);
    const outsideDir = join(h.dir, 'outside');
    mkdirSync(outsideDir);
    const unrelated = join(outsideDir, 'delswap.json');
    writeFileSync(unrelated, 'an unrelated file outside the drafts folder');
    // Fires at the first fs call after the op's write has landed.
    const restore = injectSwap(() => (h.store.get(id) as Loose | undefined)?.rationale === 'landed', 'before', () => {
      renameSync(drafts, drafts + '.real');
      symlinkSync(outsideDir, drafts);
    });
    let res;
    try {
      res = await h.apply({ path: 'delswap.json' });
    } finally {
      restore();
    }
    assert.equal(existsSync(unrelated), true, 'the unrelated outside file was deleted');
    assert.equal(existsSync(join(drafts + '.real', 'delswap.json')), true, 'the real draft is kept');
    assert.notEqual(res.isError, true, text(res));
    const receipt = JSON.parse(text(res)) as Loose;
    assert.equal(receipt.file_removed, false);
    assert.match(String(receipt.file_remove_error), /drafts folder/);
    assert.equal(h.get(id).rationale, 'landed', 'the write stands');
  } finally {
    await h.cleanup();
  }
});

test('a .sterling folder that is a symlink is refused', linuxOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-apply-drafts-link-'));
  mkdirSync(join(dir, 'real-sterling', 'drafts'), { recursive: true });
  symlinkSync(join(dir, 'real-sterling'), join(dir, '.sterling'));
  const { server, store, tools } = createSterlingServer(join(dir, '.sterling', 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const id = (tools.knowledgeCreate('decision', { title: 'linked sterling fixture', statement: 's', alternatives_rejected: [], rationale: 'short' }).record as unknown as { id: string }).id;
    writeFileSync(join(dir, 'real-sterling', 'drafts', 'ops.json'), JSON.stringify([{ op: 'update', id, body: { rationale: 'via link' } }]));
    const res = await client.callTool({ name: 'knowledge_apply_drafts', arguments: { path: 'ops.json' } });
    assert.equal(res.isError, true, text(res));
    assert.match(text(res), /\.sterling is not a real directory/);
    assert.equal((tools.knowledgeGet(id) as unknown as Loose).rationale, 'short');
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Re-check of the descriptor fix: identity checks alone pass an IN-PLACE edit
// (same inode), so the tool applied the old ops and then deleted the file that
// held the new, unapplied ones. The content read from the open file is now
// compared again before the apply and before the delete.
test('in-place edit right after the read is refused before anything is applied', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    const draft = h.draft('inplace.json', [{ op: 'update', id, body: { rationale: 'first version' } }]);
    // The first lstat of the draft's own name is the identity check that runs after the read.
    const restore = injectSwap((p) => p.endsWith('/inplace.json'), 'before', () => {
      writeFileSync(draft, JSON.stringify([{ op: 'update', id, body: { rationale: 'second version, longer' } }]));
    }, 'lstatSync');
    let res;
    try {
      res = await h.apply({ path: 'inplace.json' });
    } finally {
      restore();
    }
    assert.equal(h.get(id).version, 1, `ops were applied from content that changed after it was read: ${text(res)}`);
    assert.equal(res.isError, true, text(res));
    assert.match(text(res), /changed after it was read/);
    assert.equal(existsSync(draft), true, 'the edited draft is kept');
  } finally {
    await h.cleanup();
  }
});

test('in-place edit after the apply keeps the file, so the new ops are not lost', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    const draft = h.draft('inplace2.json', [{ op: 'update', id, body: { rationale: 'landed' } }]);
    const newer = JSON.stringify([{ op: 'update', id, body: { rationale: 'the next draft' } }]);
    const restore = injectSwap(() => (h.store.get(id) as Loose | undefined)?.rationale === 'landed', 'before', () => writeFileSync(draft, newer));
    let res;
    try {
      res = await h.apply({ path: 'inplace2.json' });
    } finally {
      restore();
    }
    assert.notEqual(res.isError, true, text(res));
    assert.equal(h.get(id).rationale, 'landed', 'the applied write stands');
    assert.equal(existsSync(draft), true, 'the file holding the unapplied ops was deleted');
    assert.equal(readFileSync(draft, 'utf8'), newer);
    const receipt = JSON.parse(text(res)) as Loose;
    assert.equal(receipt.file_removed, false);
    assert.match(String(receipt.file_remove_error), /changed after it was read/);
  } finally {
    await h.cleanup();
  }
});

test('a read error on the final content check keeps the receipt: applied, file_removed false, the error reported', linuxOnly, async () => {
  const h = await harness();
  const origReadSync = cjsFs.readSync as (...a: unknown[]) => unknown;
  try {
    const id = h.decision();
    const draft = h.draft('eio.json', [{ op: 'update', id, body: { rationale: 'landed' } }]);
    // Once the op has landed, the next read of the draft is the final check before the unlink.
    cjsFs.readSync = function (this: unknown, ...a: unknown[]) {
      if ((h.store.get(id) as Loose | undefined)?.rationale === 'landed') throw new Error('EIO: injected read failure');
      return origReadSync.apply(this, a);
    };
    syncBuiltinESMExports();
    let res;
    try {
      res = await h.apply({ path: 'eio.json' });
    } finally {
      cjsFs.readSync = origReadSync;
      syncBuiltinESMExports();
    }
    assert.notEqual(res.isError, true, text(res));
    assert.equal(h.get(id).rationale, 'landed', 'the applied write stands');
    assert.equal(existsSync(draft), true, 'the draft is kept');
    const receipt = JSON.parse(text(res)) as Loose;
    assert.equal((receipt.applied as unknown[]).length, 1);
    assert.equal(receipt.file_removed, false);
    assert.match(String(receipt.file_remove_error), /EIO: injected read failure/);
  } finally {
    await h.cleanup();
  }
});

test('on a platform other than Linux the tool refuses, naming the platform', async () => {
  const h = await harness();
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    const id = h.decision();
    h.draft('mac.json', [{ op: 'update', id, body: { rationale: 'would land' } }]);
    Object.defineProperty(process, 'platform', { ...real, value: 'darwin' });
    let res;
    try {
      res = await h.apply({ path: 'mac.json' });
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
    assert.equal(res.isError, true, text(res));
    assert.match(text(res), /exists only on Linux/);
    assert.match(text(res), /'darwin' is refused/);
    assert.equal(h.get(id).version, 1);
  } finally {
    await h.cleanup();
  }
});

test('when /proc/self/fd is unavailable the refusal names that, not a missing drafts folder', linuxOnly, async () => {
  const h = await harness();
  try {
    const id = h.decision();
    h.draft('noproc.json', [{ op: 'update', id, body: { rationale: 'would land' } }]);
    // Simulates a Linux without /proc mounted: every /proc/self/fd path is absent.
    const orig: Record<string, (...a: unknown[]) => unknown> = {};
    for (const name of WRAPPED) {
      const fn = cjsFs[name] as (...a: unknown[]) => unknown;
      orig[name] = fn;
      const wrapped = function (this: unknown, ...a: unknown[]) {
        if (typeof a[0] === 'string' && a[0].startsWith('/proc/self/fd')) {
          if (name === 'existsSync') return false;
          throw Object.assign(new Error(`ENOENT: no such file or directory, '${a[0]}'`), { code: 'ENOENT' });
        }
        return fn.apply(this, a);
      };
      if (name === 'realpathSync') (wrapped as unknown as { native: unknown }).native = (fn as unknown as { native: unknown }).native;
      cjsFs[name] = wrapped;
    }
    syncBuiltinESMExports();
    let res;
    try {
      res = await h.apply({ path: 'noproc.json' });
    } finally {
      for (const name of WRAPPED) cjsFs[name] = orig[name];
      syncBuiltinESMExports();
    }
    assert.equal(res.isError, true, text(res));
    assert.match(text(res), /\/proc\/self\/fd is not available/);
    assert.doesNotMatch(text(res), /does not exist/);
    assert.equal(h.get(id).version, 1);
  } finally {
    await h.cleanup();
  }
});
