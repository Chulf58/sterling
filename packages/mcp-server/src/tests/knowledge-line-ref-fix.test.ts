// ---------------------------------------------------------------------------
// knowledge_line_ref_fix — the ONE store write the background maintenance
// worker may make on its own (decision
// maintenance-queue-background-haiku-worker-simple-redesign, point 3a,
// user-ruled 2026-09-30: "Line references only"). The worker may move a stale
// path:line reference in a feature_article, and the server accepts the edit
// only when it can verify, against the file as committed at HEAD, that the new
// line carries the quoted anchor. Every refusal writes nothing and names the
// failed check (1-6 of the contract).
//
// Harness conventions copied from attested-close.test.ts (git fixture:
// mkdtempSync + `git init -q -b main` + SterlingTools({..., repoRoot})) and
// server.test.ts (MCP client over InMemoryTransport, for the arg-shape pin).
//
// Review fix round (2026-09-30): no `resolves` (items close only through the
// attested maintenance_remove); a shift only (same width, anchor on the first
// line); the anchor within 120 chars of the reference; a field allowlist.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SterlingStore } from '@sterling/store';
import { createSterlingServer } from '../server.js';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;

const NOW = '2026-09-30T12:00:00.000Z';

const WORKER = 'scripts/hooks/lib/worker.mjs';
const OTHER = 'packages/x/src/other.ts';

const WORKER_SRC = [
  '// worker header', //                        1
  "import { spawn } from 'node:child_process';", // 2
  'const LIMIT = 1;', //                         3
  'export function launchGuard(opts) {', //      4
  '  return opts.ok;', //                        5
  '}', //                                         6
  'export function drainQueue() {', //           7
  '  return 0;', //                               8
  '}', //                                         9
].join('\n') + '\n';

const OTHER_SRC = ['export const a = 1;', 'export function computeTotal(xs) {', '  return xs.length;', '}'].join('\n') + '\n';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-line-ref-fix-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const git = (...a: string[]): string => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  const write = (rel: string, content: string) => {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  };
  write(WORKER, WORKER_SRC);
  write(OTHER, OTHER_SRC);
  git('add', '-A');
  git('commit', '-qm', 'seed');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, tools, git, write, cleanup };
}

const mkArticle = (tools: SterlingTools, whatItDoes: string, files: { path: string; role?: string }[] = [{ path: WORKER }, { path: OTHER }]): Loose =>
  (
    tools.knowledgeCreate('feature_article', {
      slug: 'line-ref-fixture',
      title: 'line ref fixture',
      what_it_does: whatItDoes,
      intended_behavior: 'x',
      files: files.map((f) => ({ path: f.path, role: f.role ?? 'impl' })),
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose }
  ).record;

const PROSE = `The guard lives in ${WORKER}:3 (function launchGuard) and the tally in other.ts:2 (computeTotal); the block worker.mjs:1-3 too.`;

function field(tools: SterlingTools, id: string, name: string): unknown {
  return (tools.knowledgeGet(id) as unknown as Loose)[name];
}
function versionOf(tools: SterlingTools, id: string): number {
  return (tools.knowledgeGet(id) as unknown as { version: number }).version;
}

/** Every refusal: throws naming the check, and the record's version and field are untouched. */
function assertRefused(tools: SterlingTools, id: string, fieldName: string, fn: () => unknown, check: number, detail: RegExp): void {
  const before = versionOf(tools, id);
  const beforeText = JSON.stringify(field(tools, id, fieldName));
  assert.throws(fn, (err: Error) => {
    assert.match(err.message, new RegExp(`^knowledge_line_ref_fix: refused at check ${check} `), err.message);
    assert.match(err.message, detail, err.message);
    assert.match(err.message, /Nothing was written\.$/, err.message);
    return true;
  });
  assert.equal(versionOf(tools, id), before, 'no version minted on a refusal');
  assert.equal(JSON.stringify(field(tools, id, fieldName)), beforeText, 'field untouched on a refusal');
}

// --- SUCCESS -----------------------------------------------------------------

test('success, single line: a full-path reference moves to the HEAD line carrying the anchor; only that substring changes; receipt names the verification', () => {
  const { tools, git, cleanup } = fixture();
  try {
    const a = mkArticle(tools, PROSE);
    const res = tools.knowledgeLineRefFix(a.id as string, 'what_it_does', `${WORKER}:3`, `${WORKER}:4`, 'launchGuard');
    assert.equal(field(tools, a.id as string, 'what_it_does'), PROSE.replace(`${WORKER}:3`, `${WORKER}:4`));
    assert.equal(versionOf(tools, a.id as string), 2, 'the same versioned write path: version bumped');
    assert.deepEqual(
      { ...res.verification, head_commit: undefined },
      { path: WORKER, lines: '4', anchor: 'launchGuard', head_commit: undefined, blob: res.verification.blob }
    );
    assert.equal(res.verification.head_commit, git('rev-parse', 'HEAD'), 'receipt names the commit it verified against');
    assert.deepEqual(res.replaced, { field: 'what_it_does', find: `${WORKER}:3`, replace: `${WORKER}:4` });
  } finally {
    cleanup();
  }
});

test('success, range with a short-form path: the suffix resolves unambiguously and the anchor lies inside the range', () => {
  const { tools, cleanup } = fixture();
  try {
    const prose = 'See worker.mjs:1-3 for launchGuard.';
    const a = mkArticle(tools, prose);
    const res = tools.knowledgeLineRefFix(a.id as string, 'what_it_does', 'worker.mjs:1-3', 'worker.mjs:4-6', 'launchGuard');
    assert.equal(field(tools, a.id as string, 'what_it_does'), 'See worker.mjs:4-6 for launchGuard.');
    assert.equal(res.verification.path, WORKER);
    assert.equal(res.verification.lines, '4-6');
  } finally {
    cleanup();
  }
});

test('success, bare :N when the article owns exactly one file; also through an arr[key=value].sub selector', () => {
  const { tools, cleanup } = fixture();
  try {
    const a = mkArticle(tools, 'x', [{ path: WORKER, role: 'the drain loop at :4 (drainQueue)' }]);
    const sel = `files[path=${WORKER}].role`;
    const res = tools.knowledgeLineRefFix(a.id as string, sel, ':4', ':7', 'drainQueue');
    const files = field(tools, a.id as string, 'files') as { path: string; role: string }[];
    assert.equal(files[0]?.role, 'the drain loop at :7 (drainQueue)');
    assert.equal(res.verification.path, WORKER);
  } finally {
    cleanup();
  }
});

test('resolves is not an argument: the MCP surface rejects it as an unknown key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-line-ref-fix-mcp-'));
  const { server, store } = createSterlingServer(join(dir, 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    const schema = listed.tools.find((t) => t.name === 'knowledge_line_ref_fix')?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    assert.ok(schema, 'the tool is served');
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ['anchor', 'field', 'find', 'id', 'projection', 'replace']);
    const res = await client.callTool({
      name: 'knowledge_line_ref_fix',
      arguments: { id: 'x', field: 'what_it_does', find: 'a.mjs:1', replace: 'a.mjs:2', anchor: 'launchGuard', resolves: ['00000000-0000-4000-8000-000000000000'] },
    });
    assert.equal(res.isError, true, 'an unknown resolves arg is refused, never silently ignored');
    assert.match((res.content as { text: string }[])[0]!.text, /resolves/, 'the refusal names the offending key');
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CHECK 1: record, field, match --------------------------------------------

test('check 1: a non-feature_article record is refused', () => {
  const { tools, cleanup } = fixture();
  try {
    const d = tools.knowledgeCreate('decision', {
      title: 'line ref decision fixture',
      statement: `Guard at ${WORKER}:3 (launchGuard).`,
      alternatives_rejected: [],
      rationale: 'fixture',
      file_keys: [WORKER],
    }).record as unknown as Loose;
    assertRefused(tools, d.id as string, 'statement', () => tools.knowledgeLineRefFix(d.id as string, 'statement', `${WORKER}:3`, `${WORKER}:4`, 'launchGuard'), 1, /is a decision, not a feature_article/);
  } finally {
    cleanup();
  }
});

test('check 1: a non-string field and a find that matches twice are refused', () => {
  const { tools, cleanup } = fixture();
  try {
    const a = mkArticle(tools, `${WORKER}:3 launchGuard and again ${WORKER}:3.`);
    assertRefused(tools, a.id as string, 'what_it_does', () => tools.knowledgeLineRefFix(a.id as string, 'steps_runbook', `${WORKER}:3`, `${WORKER}:4`, 'launchGuard'), 1, /absent, not a string/);
    assertRefused(tools, a.id as string, 'what_it_does', () => tools.knowledgeLineRefFix(a.id as string, 'what_it_does', `${WORKER}:3`, `${WORKER}:4`, 'launchGuard'), 1, /appears 2 times/);
  } finally {
    cleanup();
  }
});

test('check 1: a find that is only part of a longer reference (worker.mjs:4 inside worker.mjs:41) is refused', () => {
  const { tools, cleanup } = fixture();
  try {
    const a = mkArticle(tools, `The guard (launchGuard) at ${WORKER}:41.`);
    assertRefused(tools, a.id as string, 'what_it_does', () => tools.knowledgeLineRefFix(a.id as string, 'what_it_does', `${WORKER}:4`, `${WORKER}:5`, 'launchGuard'), 1, /not a whole reference/);
  } finally {
    cleanup();
  }
});

test('check 1: only the allowlisted fields are editable — history, title and files[].path are refused', () => {
  const { tools, cleanup } = fixture();
  try {
    const a = mkArticle(tools, PROSE);
    const id = a.id as string;
    tools.knowledgeAppend(id, 'history', [{ date: NOW, event: `moved launchGuard to ${WORKER}:3` }]);
    assertRefused(tools, id, 'history', () => tools.knowledgeLineRefFix(id, `history[date=${NOW}].event`, `${WORKER}:3`, `${WORKER}:4`, 'launchGuard'), 1, /not one of the fields/);
    assertRefused(tools, id, 'title', () => tools.knowledgeLineRefFix(id, 'title', `${WORKER}:3`, `${WORKER}:4`, 'launchGuard'), 1, /not one of the fields/);
    assertRefused(tools, id, 'files', () => tools.knowledgeLineRefFix(id, `files[path=${WORKER}].path`, `${WORKER}:3`, `${WORKER}:4`, 'launchGuard'), 1, /not one of the fields/);
  } finally {
    cleanup();
  }
});

test('success through the allowlisted current_ac[..].text selector', () => {
  const { tools, cleanup } = fixture();
  try {
    const a = mkArticle(tools, PROSE);
    const id = a.id as string;
    tools.knowledgeAppend(id, 'current_ac', [{ ac_id: 'AC2', text: `launchGuard refuses at ${WORKER}:3`, verifiable_at: 'final' }]);
    tools.knowledgeLineRefFix(id, 'current_ac[ac_id=AC2].text', `${WORKER}:3`, `${WORKER}:4`, 'launchGuard');
    const ac = (field(tools, id, 'current_ac') as { ac_id: string; text: string }[]).find((e) => e.ac_id === 'AC2');
    assert.equal(ac?.text, `launchGuard refuses at ${WORKER}:4`);
  } finally {
    cleanup();
  }
});

// --- CHECK 2: line-reference form ---------------------------------------------

test('check 2: prose inside find or replace, a different path, and a bare :N that files[] cannot resolve are refused', () => {
  const { tools, cleanup } = fixture();
  try {
    const a = mkArticle(tools, `The guard lives in ${WORKER}:3 (launchGuard); also :2 (computeTotal).`);
    const id = a.id as string;
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', `in ${WORKER}:3`, `in ${WORKER}:4`, 'launchGuard'), 2, /'find' is not a line reference/);
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', `${WORKER}:3`, `${WORKER}:4 (moved)`, 'launchGuard'), 2, /'replace' is not a line reference/);
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', `${WORKER}:3`, `${OTHER}:2`, 'computeTotal'), 2, /must keep find's path/);
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', ':2', ':3', 'computeTotal'), 2, /bare ':N'.*owns 2 files/);
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', `${WORKER}:3`, ` ${WORKER}:3 `, 'launchGuard'), 2, /no-op: replace equals find/);
  } finally {
    cleanup();
  }
});

test('check 2: a shift only — a point stays a point, and a range keeps its width', () => {
  const { tools, cleanup } = fixture();
  try {
    const a = mkArticle(tools, `The guard (launchGuard) at ${WORKER}:3 and the block worker.mjs:1-3 (launchGuard again).`);
    const id = a.id as string;
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', `${WORKER}:3`, `${WORKER}:4-6`, 'launchGuard'), 2, /shift only/);
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', 'worker.mjs:1-3', 'worker.mjs:4', 'launchGuard'), 2, /shift only/);
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', 'worker.mjs:1-3', 'worker.mjs:4-7', 'launchGuard'), 2, /shift only/);
  } finally {
    cleanup();
  }
});

// --- CHECK 3: path in files[] --------------------------------------------------

test('check 3: a path that is not one of the article files[] is refused', () => {
  const { tools, cleanup } = fixture();
  try {
    const a = mkArticle(tools, 'The guard (launchGuard) at scripts/other/worker2.mjs:3.');
    assertRefused(tools, a.id as string, 'what_it_does', () => tools.knowledgeLineRefFix(a.id as string, 'what_it_does', 'scripts/other/worker2.mjs:3', 'scripts/other/worker2.mjs:4', 'launchGuard'), 3, /matches none of the article's files\[\]/);
  } finally {
    cleanup();
  }
});

// --- CHECK 4: the line at HEAD --------------------------------------------------

test('check 4: a line past EOF and an anchor not on the new line are refused', () => {
  const { tools, cleanup } = fixture();
  try {
    const a = mkArticle(tools, PROSE);
    const id = a.id as string;
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', `${WORKER}:3`, `${WORKER}:40`, 'launchGuard'), 4, /has 9 lines at HEAD/);
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', 'worker.mjs:1-3', 'worker.mjs:8-10', 'launchGuard'), 4, /has 9 lines at HEAD/);
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', `${WORKER}:3`, `${WORKER}:7`, 'launchGuard'), 4, /does not contain the anchor/);
  } finally {
    cleanup();
  }
});

test('check 4: in a range, the anchor must be on the FIRST line, not merely inside the range', () => {
  const { tools, cleanup } = fixture();
  try {
    // launchGuard is on line 4: inside 3-5, but 3 is the first line.
    const a = mkArticle(tools, 'See worker.mjs:1-3 for launchGuard.');
    assertRefused(tools, a.id as string, 'what_it_does', () => tools.knowledgeLineRefFix(a.id as string, 'what_it_does', 'worker.mjs:1-3', 'worker.mjs:3-5', 'launchGuard'), 4, /first line/);
  } finally {
    cleanup();
  }
});

test('check 4: a line that carries the anchor only in the WORKING TREE, not at HEAD, is refused', () => {
  const { tools, write, cleanup } = fixture();
  try {
    // Uncommitted: one inserted line moves launchGuard to line 5 on disk only.
    write(WORKER, WORKER_SRC.replace('const LIMIT = 1;\n', 'const LIMIT = 1;\nconst EXTRA = 2;\n'));
    const a = mkArticle(tools, PROSE);
    assertRefused(tools, a.id as string, 'what_it_does', () => tools.knowledgeLineRefFix(a.id as string, 'what_it_does', `${WORKER}:3`, `${WORKER}:5`, 'launchGuard'), 4, /does not contain the anchor/);
  } finally {
    cleanup();
  }
});

// --- CHECK 5: the anchor --------------------------------------------------------

test('check 5: an anchor quoted in the field but more than 120 characters from the reference is refused', () => {
  const { tools, cleanup } = fixture();
  try {
    const far = `launchGuard is described first. ${'filler text '.repeat(12)}Then the reference ${WORKER}:3 on its own.`;
    const a = mkArticle(tools, far);
    assertRefused(tools, a.id as string, 'what_it_does', () => tools.knowledgeLineRefFix(a.id as string, 'what_it_does', `${WORKER}:3`, `${WORKER}:4`, 'launchGuard'), 5, /anchor is not next to the reference/);
  } finally {
    cleanup();
  }
});

test('check 5: a short anchor, a punctuation-only anchor, and an anchor absent from the field are refused', () => {
  const { tools, cleanup } = fixture();
  try {
    const a = mkArticle(tools, PROSE);
    const id = a.id as string;
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', `${WORKER}:3`, `${WORKER}:4`, 'launc'), 5, /at least 6 characters/);
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', `${WORKER}:3`, `${WORKER}:6`, ' (){}[]; =>'), 5, /only whitespace or punctuation/);
    // drainQueue IS on HEAD line 7, but the article never mentions it: the worker invented it.
    assertRefused(tools, id, 'what_it_does', () => tools.knowledgeLineRefFix(id, 'what_it_does', `${WORKER}:3`, `${WORKER}:7`, 'drainQueue'), 5, /does not appear in the field's own text/);
  } finally {
    cleanup();
  }
});

test('check 5: an anchor that appears in the field only inside the reference being replaced is refused', () => {
  const { tools, cleanup } = fixture();
  try {
    // "worker" is on HEAD line 1 ('// worker header') and in the field, but only
    // inside the find text itself, never in the prose around it.
    const a = mkArticle(tools, 'Guard at scripts/hooks/lib/worker.mjs:3.');
    assertRefused(tools, a.id as string, 'what_it_does', () => tools.knowledgeLineRefFix(a.id as string, 'what_it_does', `${WORKER}:3`, `${WORKER}:1`, 'worker'), 5, /does not appear in the field's own text/);
  } finally {
    cleanup();
  }
});

// --- CHECK 6: substitution only ---------------------------------------------
//
// No INPUT can make more than the reference change: the new value is built as
// field[0, at) + replace + field[at + find.length, end) from the one validated
// site, and the body names only that field (or that one array element), so an
// input-crafted check-6 refusal is unreachable by construction — the success
// tests pin the exact resulting field instead. What CAN make more change is a
// write landing between the checks' read and this write: the stale copy of the
// field would then overwrite it. That is the check-6 refusal pinned here.

test('check 6: a write landing between the checks and the write is refused, and the concurrent write survives', () => {
  const { tools, cleanup } = fixture();
  try {
    const a = mkArticle(tools, PROSE);
    const id = a.id as string;
    // Seam: the tree lookup runs after the record read and before the write,
    // exactly where another session's write could land.
    const t = tools as unknown as { treeRootFor: (r: Record<string, unknown>) => unknown };
    const original = t.treeRootFor.bind(tools);
    let fired = false;
    t.treeRootFor = (r) => {
      if (!fired) {
        fired = true;
        tools.knowledgeEdit(id, 'what_it_does', 'the tally', 'the running tally');
      }
      return original(r);
    };
    const concurrent = PROSE.replace('the tally', 'the running tally');
    assert.throws(
      () => tools.knowledgeLineRefFix(id, 'what_it_does', `${WORKER}:3`, `${WORKER}:4`, 'launchGuard'),
      /^Error: knowledge_line_ref_fix: refused at check 6 \(substitution only\) — .*moved from version 1 to version 2.*Nothing was written\.$/
    );
    assert.equal(field(tools, id, 'what_it_does'), concurrent, 'the concurrent write is kept, not overwritten by a stale copy');
    assert.equal(versionOf(tools, id), 2);
  } finally {
    cleanup();
  }
});
