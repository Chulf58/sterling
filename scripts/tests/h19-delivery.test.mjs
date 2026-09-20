// H19 knowledge delivery (decision 6dfbe675, brief retrieval-first-knowledge-
// delivery): file-touch delivery + frontier signal + session guard + drain.
// AC7 pins the floor everywhere: no path through these hooks may exit 2.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { renderHazards, assembleDelivery } from '../hooks/lib/delivery.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-07-19T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Execute an ephemeral sibling copy with only statSync replaced. Keeping the
// hook's relative imports intact exercises its real outer warning boundary.
function runHookWithThrowingStat(script, input, cwd) {
  const token = randomUUID();
  const shim = join(HOOKS, `.h19-stat-throw-${token}.mjs`);
  const copy = join(HOOKS, `.h19-stat-hook-${token}.mjs`);
  try {
    writeFileSync(shim, "export const statSync = () => { throw new TypeError('injected stat TypeError'); };\n");
    const source = readFileSync(join(HOOKS, script), 'utf8').replace("from 'node:fs';", `from './${shim.split('/').pop()}';`);
    writeFileSync(copy, source);
    return runHook(copy.split('/').pop(), input, cwd);
  } finally {
    rmSync(copy, { force: true });
    rmSync(shim, { force: true });
  }
}

function envelope(type) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function article(slug, paths, extra = {}) {
  return {
    ...envelope('feature_article'),
    slug,
    title: slug,
    what_it_does: `${slug} does the ${slug} thing`,
    intended_behavior: `${slug} intends`,
    files: paths.map((p) => ({ path: p, role: 'owner' })),
    current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [],
    live_test_refs: [],
    ...extra,
  };
}

function makeProject({ rung = 'read' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: rung } }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const pendingOf = (dir) => {
  const p = join(dir, '.sterling', 'transient', 'delivery', 'pending.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};

const postRead = (dir, file, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, file) },
  session_id: 's1',
  cwd: dir,
  ...extra,
});
const preEdit = (dir, file, extra = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: join(dir, file) },
  session_id: 's1',
  cwd: dir,
  ...extra,
});









// 2026-09-19 re-pointed from prompt-drain aggregation to the direct cap
// assembler; 2026-09-20 re-pointed AGAIN from the deleted UUID-scanning
// helper (the rejected design, decision knowledge-delivery-target-design-no-
// delayed-delivery) to the assembler's own returned emittedDiscovery set: a
// record's id appearing in the composed text is no longer what marks it
// delivered — only assembleDelivery saying the part survived WHOLE does.
test('review H3: aggregate prefixes do not spend a record guard; the overflowed record can deliver in full later', () => {
  const id = '1e419452-1111-4111-8111-111111111111';
  const otherId = (i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const parts = Array.from({ length: 40 }, (_, i) => {
    const rid = i === 5 ? id : otherId(i);
    return {
      kind: 'ordinary',
      contentClass: 'discovery',
      identity: rid,
      revision: 'r1',
      text: `ordinary ${i} ${'x'.repeat(800)} knowledge_get ${rid}`,
      pointer: `knowledge_get ${rid}`,
    };
  });
  const overflow = assembleDelivery(parts, 300);
  assert.match(overflow.text, /knowledge_get 1e419452/);
  assert.doesNotMatch(overflow.text, new RegExp(id));
  assert.ok(!overflow.emittedDiscovery.some((e) => e.identity === id), 'a prefix is disclosure, not delivery');
  const later = assembleDelivery(
    [{ kind: 'ordinary', contentClass: 'discovery', identity: id, revision: 'r1', text: `FULL RECORD knowledge_get ${id}` }],
    3000
  );
  assert.deepEqual(later.emittedDiscovery, [{ identity: id, revision: 'r1' }], 'a later touch still delivers the full record id');
});

// Step 3 (decision knowledge-delivery-target-design-no-delayed-delivery,
// item 4): Bash hazards now render WHOLE, through the SAME renderHazards the
// Read rung uses, and are therefore capped at HAZARD_CAP (3) — never a
// per-hazard pointer line, and never the 8-per-command owner-pointer count
// this test pinned under the old Step 2 pointer-only contract. Superseded
// 2026-09-20 (pre-authorized, see brief item 4 / C5): the old assertion was
// `for (const hazard of hazards.slice(0, 8)) assert.match(ctx,
// new RegExp(hazard.id), 'each admitted hazard has a direct pointer')`.
test('review H3: Bash pointer package stays capped and admits exactly HAZARD_CAP whole hazards', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: 'read', total_cap_bytes: 3000 } }));
    const hazards = [];
    for (let i = 0; i < 40; i++) hazards.push(store.create(antiPattern(`bash-danger-${i}`, [`src/${i}.mjs`], { trigger: `TRIGGER_START ${'t'.repeat(120)} TRIGGER_END_${i}`, right_way: `RIGHT_START ${'r'.repeat(120)} RIGHT_END_${i}` })));
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `src/${i}.mjs`), 'x\n');
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, `wc -l ${hazards.map((_, i) => `src/${i}.mjs`).join(' ')}`), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    // BASH_POINTER_PATH_CAP (8) admits only the first 8 named paths as
    // candidates at all, so only hazards[0..7] are ever in play here —
    // HAZARD_CAP (3) then keeps the first 3 of THOSE.
    const consideredHazards = hazards.slice(0, 8);
    const hazardBytes = Buffer.byteLength(
      renderHazards(consideredHazards, Number.MAX_SAFE_INTEGER, { fileKeys: consideredHazards.map((_, i) => `src/${i}.mjs`) }).join('\n\n')
    );
    assert.ok(Buffer.byteLength(ctx) - hazardBytes <= 3000, 'ordinary (non-hazard) bytes stay within the cap');
    for (const hazard of hazards.slice(0, 3)) assert.match(ctx, new RegExp(hazard.id), 'each of the 3 admitted hazards renders whole, with its full trigger/right_way');
    for (const hazard of hazards.slice(3)) assert.doesNotMatch(ctx, new RegExp(hazard.id), 'a hazard beyond HAZARD_CAP is disclosed as a count, not shown');
    assert.match(ctx, /5 more hazard\(s\) NOT shown \(cap 3\)/, '5 of the 8 considered hazards are disclosed as an overflow count');
  } finally { cleanup(); }
});
test('review H3: a Read porch with a hazard and large article keeps ordinary bytes within the cap', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: 'read', total_cap_bytes: 3000 } }));
    const hazard = store.create(antiPattern('read-danger', ['src/read.mjs'], { trigger: `TRIGGER ${'t'.repeat(1800)} TRIGGER_END`, right_way: `RIGHT ${'r'.repeat(1800)} RIGHT_END` }));
    store.create(article('read-large', ['src/read.mjs'], { what_it_does: `ARTICLE ${'a'.repeat(7000)}`, intended_behavior: `BEHAVIOR ${'b'.repeat(7000)}` }));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/read.mjs'), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    const hazardBytes = Buffer.byteLength(renderHazards([hazard], 2400, { fileKeys: ['src/read.mjs'] }).join('\n\n'));
    assert.ok(Buffer.byteLength(ctx) - hazardBytes <= 3000, 'porch, article, and all other ordinary text stay within cap');
    assert.match(ctx, /TRIGGER_END/);
    assert.match(ctx, /RIGHT_END/);
  } finally { cleanup(); }
});



test('guard: same file and same-article new file stay silent; a NEW owning article re-arms', () => { const {dir,store,cleanup}=makeProject(); try { store.create(article('alpha',['src/a.mjs','src/a2.mjs'])); assert.match(JSON.parse(runHook('h19-knowledge-delivery.mjs',postRead(dir,'src/a.mjs'),dir).stdout).hookSpecificOutput.additionalContext,/alpha/); assert.equal(runHook('h19-knowledge-delivery.mjs',postRead(dir,'src/a2.mjs'),dir).stdout,''); store.create(article('beta',['src/b.mjs'])); assert.match(JSON.parse(runHook('h19-knowledge-delivery.mjs',postRead(dir,'src/b.mjs'),dir).stdout).hookSpecificOutput.additionalContext,/beta/); } finally {cleanup();} });
test('rung read: PostToolUse injects directly, nothing queued; PreToolUse stays silent', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const pre = runHook('h19-knowledge-delivery.mjs', preEdit(dir, 'src/a.mjs'), dir);
    assert.equal(pre.code, 0);
    assert.equal(pre.stdout, '');
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /alpha does the alpha thing/);
    assert.equal(pendingOf(dir).length, 0);
  } finally {
    cleanup();
  }
});

// 2026-09-19 re-pointed: legacy edit now maps directly to Read and announces the migration.
test('legacy rung edit: Read injects directly with a migration notice', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'edit' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /obsolete and now behaves as 'read'/);
    assert.match(ctx, /alpha does the alpha thing/);
    assert.equal(pendingOf(dir).length, 0);
  } finally { cleanup(); }
});
test('migration notice: missing, prompt, and edit configurations announce once on Read even without fresh knowledge', () => {
  for (const rung of [undefined, 'prompt', 'edit']) {
    const { dir, cleanup } = makeProject({ rung });
    try {
      if (rung === undefined) writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: {} }));
      const first = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/no-fresh.mjs'), dir);
      assert.equal(first.code, 0, first.stderr);
      assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /injection_rung .*obsolete.*read/i);
      const repeat = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/no-fresh.mjs'), dir);
      assert.equal(repeat.stdout, '', `${String(rung)} repeats must not re-announce`);
    } finally { cleanup(); }
  }
});
test('migration notice: missing, prompt, and edit configurations announce once on Bash even without matches', () => {
  for (const rung of [undefined, 'prompt', 'edit']) {
    const { dir, cleanup } = makeProject({ rung });
    try {
      if (rung === undefined) writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: {} }));
      writeFileSync(join(dir, 'plain.mjs'), 'x\n');
      const input = postBash(dir, 'wc -l plain.mjs');
      const first = runHook('h19-bash-delivery.mjs', input, dir);
      assert.equal(first.code, 0, first.stderr);
      assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /injection_rung .*obsolete.*read/i);
      const repeat = runHook('h19-bash-delivery.mjs', input, dir);
      assert.equal(repeat.stdout, '', `${String(rung)} repeats must not re-announce`);
    } finally { cleanup(); }
  }
});
test('migration notice: Read and Bash share one marker in either order', () => {
  for (const order of ['read-bash', 'bash-read']) {
    const { dir, cleanup } = makeProject({ rung: undefined });
    try {
      writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: {} }));
      writeFileSync(join(dir, 'plain.mjs'), 'x\n');
      const read = () => runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/no-fresh.mjs'), dir);
      const bash = () => runHook('h19-bash-delivery.mjs', postBash(dir, 'wc -l plain.mjs'), dir);
      const [first, second] = order === 'read-bash' ? [read(), bash()] : [bash(), read()];
      assert.equal(first.code, 0, first.stderr);
      assert.equal(second.code, 0, second.stderr);
      const allOutput = `${first.stdout}\n${second.stdout}`;
      assert.equal((allOutput.match(/injection_rung .*obsolete.*read/gi) ?? []).length, 1, `${order} announces exactly once overall`);
    } finally { cleanup(); }
  }
});

test('filesystem programming errors are loud in the Read line-suspect scan and Bash candidate scan', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    store.create(article('owner', ['src/a.mjs']));
    const read = runHookWithThrowingStat('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(read.code, 1, read.stderr);
    assert.match(read.stderr, /knowledge delivery failed.*injected stat TypeError/i);
    const bash = runHookWithThrowingStat('h19-bash-delivery.mjs', postBash(dir, 'cat src/a.mjs'), dir);
    assert.equal(bash.code, 1, bash.stderr);
    assert.match(bash.stderr, /bash pointer delivery failed.*injected stat TypeError/i);
  } finally { cleanup(); }
});
test('frontier signal: unowned territory notices once per file; owned territory never notices', () => { const {dir,store,cleanup}=makeProject(); try { const first=runHook('h19-knowledge-delivery.mjs',postRead(dir,'src/new.mjs'),dir); assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext,/FRONTIER SIGNAL/); assert.equal(runHook('h19-knowledge-delivery.mjs',postRead(dir,'src/new.mjs'),dir).stdout,''); store.create(article('alpha',['src/a.mjs'])); assert.doesNotMatch(JSON.parse(runHook('h19-knowledge-delivery.mjs',postRead(dir,'src/a.mjs'),dir).stdout).hookSpecificOutput.additionalContext,/FRONTIER SIGNAL/); } finally {cleanup();} });
test('reference_material owner: pointer delivered, no frontier signal', () => { const {dir,store,cleanup}=makeProject(); try {store.create({...envelope('reference_material'),title:'Design notes',kind:'doc',location:'docs/notes.md',summary:'notes',source_date:'2026-07-01',capture_date:'2026-07-01'}); const ctx=JSON.parse(runHook('h19-knowledge-delivery.mjs',postRead(dir,'docs/notes.md'),dir).stdout).hookSpecificOutput.additionalContext; assert.match(ctx,/reference 'Design notes'/);assert.doesNotMatch(ctx,/FRONTIER SIGNAL/);}finally{cleanup();} });
test('one-hop pointers: relies_on sibling renders as slug + one-liner, never a full body', () => {const {dir,store,cleanup}=makeProject();try{store.create(article('alpha',['src/a.mjs']));store.create(article('beta',['src/b.mjs'],{dependencies:{relies_on:['alpha'],relied_by:[]}}));const ctx=JSON.parse(runHook('h19-knowledge-delivery.mjs',postRead(dir,'src/b.mjs'),dir).stdout).hookSpecificOutput.additionalContext;assert.match(ctx,/relies_on \[\[alpha\]\]: alpha does the alpha thing/);assert.ok(!ctx.includes('alpha intends'));}finally{cleanup();}});
test('one-hop pointers: relied_by is DERIVED — a sibling naming this article in relies_on shows up even when the owning article\'s own STORED relied_by is empty (board 9641e01b, the exact drift case measured)', () => {const {dir,store,cleanup}=makeProject();try{store.create(article('alpha',['src/a.mjs']));store.create(article('beta',['src/b.mjs'],{dependencies:{relies_on:['alpha'],relied_by:[]}}));const ctx=JSON.parse(runHook('h19-knowledge-delivery.mjs',postRead(dir,'src/a.mjs'),dir).stdout).hookSpecificOutput.additionalContext;assert.match(ctx,/relied_by \[\[beta\]\]: beta does the beta thing/);}finally{cleanup();}});

test('per-agent guards (rung read): a subagent gets its own injection even after the conductor was served', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const first = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /alpha/);
    const agent = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs', { agent_id: 'a9' }), dir);
    assert.match(JSON.parse(agent.stdout).hookSpecificOutput.additionalContext, /alpha/, 'own guard, own delivery');
  } finally {
    cleanup();
  }
});


test('self-healing: corrupt guard resets and delivers directly', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const d = join(dir, '.sterling', 'transient', 'delivery', 's1'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'guard-conductor.json'), '{not json');
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /alpha does the alpha thing/);
  } finally { cleanup(); }
});
// SHARED-FATE (outside-family review finding; decision 04982f45 absorbed
// h13-clear-conductor's pruneUnhashed(ledgerPath) into THIS hook, same
// UserPromptSubmit event as the pending-delivery drain below). A failure in
// the ABSORBED prune half must not swallow this hook's OWN pending-delivery
// drain — the two concerns share an event, not a fate. Failure is injected
// the same way the "ordering" tests above force enqueuePending to throw
// EISDIR: the target path exists but is a DIRECTORY, so the prune's own
// readFileSync throws before it ever reaches the pending-delivery drain.
// Sabotage: letting the prune's thrown EISDIR propagate uncaught past the
// whole handler (instead of catching it around ONLY the prune half) crashes
// the drain before it reaches the pending-delivery logic — the
// additionalContext match above goes red. RED AT THE CURRENT TREE until the
// fold isolates the two absorbed concerns' failure paths.

// 2026-09-19 re-pointed: an unknown rung follows the direct read compatibility path and announces it.
test('unknown injection_rung maps to direct read with a migration notice', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'sideways' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /alpha does the alpha thing/);
    assert.match(ctx, /legacy|read/i);
    assert.equal(pendingOf(dir).length, 0);
  } finally { cleanup(); }
});
test('never blocks (AC7): no store, outside-repo path, .sterling tree — always exit 0', () => {
  const bare = mkdtempSync(join(tmpdir(), 'sterling-h19-bare-'));
  try {
    assert.equal(runHook('h19-knowledge-delivery.mjs', postRead(bare, 'src/a.mjs'), bare).code, 0);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
  const { dir, cleanup } = makeProject();
  try {
    assert.equal(runHook('h19-knowledge-delivery.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'C:/elsewhere/x.mjs' }, cwd: dir }, dir).code, 0);
    assert.equal(runHook('h19-knowledge-delivery.mjs', postRead(dir, '.sterling/config.json'), dir).code, 0);
  } finally {
    cleanup();
  }
});

// Ordering contract (council wf_db9a59aa-0af): the guard is what makes delivery
// once-per-session, so it must be written only AFTER the delivery side effect
// actually completed. Written first, any failure becomes permanent silent loss —
// the next touch sees the article already marked and the `fresh.length === 0`
// short-circuit turns it into a session-long no-op with no residue.
// Failure is injected by making pending.json a DIRECTORY: enqueuePending reads
// before it writes, so readFileSync throws EISDIR.
test('ordering: a delivery that FAILS leaves the guard unwritten, so the next touch retries instead of losing the article', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const dDir = join(dir, '.sterling', 'transient', 'delivery', 's1');
    mkdirSync(join(dDir, 'guard-conductor.json'), { recursive: true });

    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    // AC7 is "never DENIES a tool call" — exit 2 is the only blocking code. A
    // delivery failure exits 1: loud on stderr (P5) but non-blocking.
    assert.notEqual(r.code, 2, 'a delivery failure must never DENY the tool call (AC7)');
    assert.match(r.stderr, /H19/, 'the failure is loud, not swallowed (P5)');
    const gPath = join(dDir, 'guard-conductor.json');
    assert.ok(existsSync(gPath));

    rmSync(join(dDir, 'guard-conductor.json'), { recursive: true, force: true });
    const retry = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.match(JSON.parse(retry.stdout).hookSpecificOutput.additionalContext, /alpha does the alpha thing/, 'the retry delivers directly — the article was never silently written off');
  } finally {
    cleanup();
  }
});

test('ordering (frontier): a failed unowned-territory notice leaves the file unmarked, so it retries', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // no owning article for src/orphan.mjs — the frontier path
    const dDir = join(dir, '.sterling', 'transient', 'delivery', 's1');
    mkdirSync(join(dDir, 'guard-conductor.json'), { recursive: true });

    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/orphan.mjs'), dir);
    assert.notEqual(r.code, 2, 'a frontier-notice failure must never DENY the tool call (AC7)');
    const gPath = join(dDir, 'guard-conductor.json');
    assert.ok(existsSync(gPath));

    rmSync(join(dDir, 'guard-conductor.json'), { recursive: true, force: true });
    const retry = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/orphan.mjs'), dir);
    assert.match(JSON.parse(retry.stdout).hookSpecificOutput.additionalContext, /unowned|frontier|nothing owns/i);

  } finally {
    cleanup();
  }
});

test('h19-clear-session: compact removes this session delivery guard (P4)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    const deliveryDir = join(dir, '.sterling', 'transient', 'delivery', 's1');
    assert.ok(existsSync(deliveryDir));
    const r = runHook('h19-clear-session.mjs', { hook_event_name: 'SessionStart', source: 'compact', session_id: 's1', cwd: dir }, dir);
    assert.equal(r.code, 0);
    assert.ok(!existsSync(deliveryDir));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Hazards and rationale for the touched path (decision ca23c811). Delivery had
// been articles-only, so an anti_pattern naming the EXACT file being edited was
// never delivered while H10 asked at Stop whether a hazard had been RECORDED.
// ---------------------------------------------------------------------------

function antiPattern(title, paths, extra = {}) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger: `${title} trigger text`,
    guidance: `${title} guidance`,
    wrong_way: `${title} wrong way`,
    right_way: `${title} right way text`,
    source_evidence: `${title} evidence`,
    basis: 'codebase',
    file_keys: paths,
    ...extra,
  };
}

function decisionRecord(statement, paths, extra = {}) {
  return {
    ...envelope('decision'),
    title: statement,
    statement,
    alternatives_rejected: [],
    rationale: `${statement} rationale`,
    file_keys: paths,
    ...extra,
  };
}

test('H19: an anti_pattern owning the touched path delivers as SUBSTANCE (trigger + right_way), leading the payload', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern('one-way latch', ['src/a.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /ANTI-PATTERN \[WARN\] for this path — 'one-way latch'/, 'the hazard is named, with its severity');
    assert.match(ctx, /TRIGGER: one-way latch trigger text/, 'trigger renders as substance, not a pointer');
    assert.match(ctx, /RIGHT WAY: one-way latch right way text/, 'right_way renders as substance');
    assert.ok(
      ctx.indexOf('ANTI-PATTERN') < ctx.indexOf("article 'alpha'"),
      'hazards LEAD: "do not do this here" outranks what the territory is'
    );
  } finally {
    cleanup();
  }
});

test('H19: a hazard in UNOWNED territory delivers WITH the frontier signal — the case the early return used to swallow', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    // No article owns this path: only the hazard does. Before ca23c811 the
    // frontier branch returned early and the hazard was never seen.
    store.create(antiPattern('latch', ['src/orphan.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/orphan.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING FRONTIER SIGNAL/, 'territory is still UNOWNED — a hazard is not ownership');
    assert.match(ctx, /H10 will demand the owning article/, "H10's demand surface is unchanged");
    assert.match(ctx, /ANTI-PATTERN \[WARN\] for this path — 'latch'/, 'and the hazard arrives anyway');
    // The notice must not tell the reader there is nothing here while a hazard
    // prints underneath it — a reader who believes that sentence stops reading.
    assert.doesNotMatch(ctx, /There is no knowledge to deliver/, 'the frontier header cannot claim emptiness above a hazard');
    assert.match(ctx, /KEEP READING/, 'it points the reader at what the store DOES hold for this path');
  } finally {
    cleanup();
  }
});

test('H19: the pure-frontier notice (no hazards, no decisions) is unchanged — it still says there is nothing to deliver', () => {
  const { dir, cleanup } = makeProject({ rung: 'read' });
  try {
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/nothing.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /There is no knowledge to deliver/, 'unowned AND empty is still stated plainly');
    assert.doesNotMatch(ctx, /KEEP READING/);
  } finally {
    cleanup();
  }
});

test('H19: hazards render most-severe-first; absent severity reads as warn', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern('info one', ['src/a.mjs'], { severity: 'info' }));
    store.create(antiPattern('no severity', ['src/a.mjs']));
    store.create(antiPattern('blocker', ['src/a.mjs'], { severity: 'block' }));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(ctx.indexOf("'blocker'") < ctx.indexOf("'no severity'"), 'block outranks the warn default');
    assert.ok(ctx.indexOf("'no severity'") < ctx.indexOf("'info one'"), 'the warn default outranks info');
    assert.match(ctx, /ANTI-PATTERN \[WARN\] for this path — 'no severity'/, 'absent severity renders as WARN');
  } finally {
    cleanup();
  }
});

test('H19: decisions render as CAPPED POINTERS, never bodies, and the overflow is stated with the widening query', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    for (let i = 0; i < 11; i += 1) store.create(decisionRecord(`choice ${i}`, ['src/a.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /DECISIONS for this path \(11\)/, 'the true total is stated, not the shown count');
    assert.equal(ctx.match(/\(knowledge_get [0-9a-f-]{36}\)/g).length, 8, 'exactly the cap renders as pointers');
    assert.doesNotMatch(ctx, /choice \d+ rationale/, 'pointers carry the statement only — never the decision body');
    assert.match(ctx, /3 more NOT shown \(cap 8\)/, 'the drop is disclosed — a silent cap reads as "that is all there is"');
    assert.match(ctx, /knowledge_query types:\["decision"\] file_keys:\["src\/a\.mjs"\] cap:11/, 'and names the query that widens it');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// RANKED DECISION POINTERS (rankFileDecisionPointers, lib/delivery.mjs
// ~1340-1400): before the cap is applied, file-touch delivery ranks
// candidate decisions by (1) authority rung — standing 0, unstated/
// unrecognised 1, session_scoped 2, one_off 3 — then (2) FEWER file_keys
// first, then (3) updated_at DESC, then (4) id DESC. Ranked ONCE at
// h19-knowledge-delivery.mjs ~111-121 where freshDecisions is born, so the
// guard slice (~153) and the renderer (~216) see the identical array — never
// re-derived independently by either consumer.
//
// CONTROL (unchanged, not duplicated here): the existing cap test above
// ('H19: decisions render as CAPPED POINTERS...') already proves 11
// decisions -> exactly 8 pointers with the drop disclosed and a widening
// query named. It stays green, unedited, and is this section's baseline —
// every PIN below only adds a SHAPE to the candidate set (authority, file
// breadth, ties) and checks how that shape moves through the SAME cap.
// ---------------------------------------------------------------------------

test('H19 (rank PIN 1): a standing-authority decision renders ahead of ten same-recency unstated decisions — recency never beats the authority rung', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const RECENT = '2026-09-05T12:00:00.000Z';
    for (let i = 0; i < 10; i += 1) {
      store.create(decisionRecord(`recent choice ${i}`, ['src/a.mjs'], { updated_at: RECENT }));
    }
    // No authority field at all -> rung 1 (unstated), and dated far NEWER
    // than the standing ruling below — a recency-only sort would evict it.
    store.create(decisionRecord('the old standing ruling', ['src/a.mjs'], { authority: 'standing', updated_at: '2026-01-01T00:00:00.000Z' }));

    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /the old standing ruling/, 'the standing ruling — despite being dated over eight months OLDER than every rival — must render within the cap of 8');
    assert.equal(ctx.match(/\(knowledge_get [0-9a-f-]{36}\)/g).length, 8, 'exactly the cap renders as pointers');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the authority rung from the sort key (sort by updated_at
// DESC alone, or by authority-then-nothing) — the standing ruling, dated
// 2026-01-01, sorts LAST among the 11 candidates and is evicted by the cap;
// the `/the old standing ruling/` match above goes red.

test('H19 (rank PIN 2): FEWER file_keys renders first even when the BROAD decision is strictly MORE RECENT — breadth outranks recency, not merely ties with it', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    // Deliberately NOT tied: the broad decision is strictly NEWER than the
    // narrow one. If the file_keys-count rung is dropped, the sort falls
    // through to updated_at DESC — which would then DETERMINISTICALLY put
    // the (newer) broad decision first, flipping this assertion every run
    // rather than merely going coin-flip-flaky on two random ids at a tie.
    const NARROW_AT = '2026-08-01T00:00:00.000Z';
    const BROAD_AT = '2026-08-02T00:00:00.000Z'; // strictly newer than NARROW_AT
    const broadPaths = ['src/a.mjs', ...Array.from({ length: 9 }, (_, i) => `src/b${i}.mjs`)];
    store.create(decisionRecord('the narrow one', ['src/a.mjs'], { updated_at: NARROW_AT }));
    store.create(decisionRecord('the broad one', broadPaths, { updated_at: BROAD_AT }));

    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.indexOf('the narrow one') < ctx.indexOf('the broad one'),
      'at equal authority, the decision naming FEWER files must render before the one naming more, EVEN THOUGH the broad one is more recent'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the file_keys-count tiebreak (fall straight through to
// updated_at DESC at equal authority) — the broad decision is strictly
// NEWER, so it deterministically sorts FIRST under updated_at DESC, and the
// `ctx.indexOf('the narrow one') < ctx.indexOf('the broad one')` assertion
// above goes red on every run, not merely sometimes.

test('H19 (rank PIN 2, CONTROL — breadth reversed): swapping which statement is narrow reverses the render order — the ordering follows BREADTH, not statement identity or recency', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const NARROW_AT = '2026-08-01T00:00:00.000Z';
    const BROAD_AT = '2026-08-02T00:00:00.000Z'; // strictly newer than NARROW_AT
    const broadPaths = ['src/a.mjs', ...Array.from({ length: 9 }, (_, i) => `src/b${i}.mjs`)];
    // Same two labels as PIN 2, but breadth (and its date) SWAPPED: here
    // "the narrow one" is the decision naming ALL 10 files (and gets the
    // NEWER date), while "the broad one" names only one file (and gets the
    // OLDER date) — the actually-narrow decision must still win despite
    // being the older of the two, exactly mirroring PIN 2's own asymmetry.
    store.create(decisionRecord('the narrow one', broadPaths, { updated_at: BROAD_AT }));
    store.create(decisionRecord('the broad one', ['src/a.mjs'], { updated_at: NARROW_AT }));

    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.indexOf('the broad one') < ctx.indexOf('the narrow one'),
      'CONTROL BROKEN if not reversed: with breadth (and its date) swapped, the decision that ACTUALLY names fewer files (labeled "the broad one" in this fixture, and the OLDER of the two) must still render first — proving PIN 2\'s order came from the file_keys COUNT, not from label identity, creation order, or recency'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the file_keys-count tiebreak here too — the actually-broad
// decision (labeled "the narrow one", holding the NEWER date) then sorts
// first under updated_at DESC, and the assertion above goes red
// deterministically, on every run.

test('H19 (rank PIN 3): three decisions identical except id render in id-DESC order — deterministic, never insertion-order-dependent', () => {
  // ASSUMPTION, stated plainly (the read wall forbids checking it directly):
  // a caller-supplied `id` in the decisionRecord/envelope payload may or may
  // not be honored verbatim by store.create() (ids are server-managed per
  // decision stable-identity-design-v2). Rather than assume either way, this
  // arm reads the ACTUAL id off store.create()'s OWN return value for every
  // record — which is correct regardless of override behaviour — and proves
  // determinism as a property that holds INDEPENDENTLY in two projects
  // seeded via differently-shaped insertion loops, rather than by forcing
  // two projects to share one literal id set.
  function seed(order) {
    const { dir, store, cleanup } = makeProject({ rung: 'read' });
    try {
      store.create(article('alpha', ['src/a.mjs']));
      const ids = order.map(() => store.create(decisionRecord('identical tie statement', ['src/a.mjs'])).id);
      const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
      assert.equal(r.code, 0);
      const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      const rendered = [...ctx.matchAll(/\(knowledge_get ([0-9a-f-]{36})\)/g)].map((m) => m[1]);
      assert.equal(rendered.length, 3, 'FIXTURE LIVENESS: all three identical-tie decisions must render (well under the cap)');
      return { ids, rendered };
    } finally {
      cleanup();
    }
  }

  const a = seed([0, 1, 2]);
  assert.deepEqual(a.rendered, [...a.ids].sort().reverse(), 'the pointer-id sequence equals the three minted ids sorted DESC as strings');

  const b = seed([2, 1, 0]); // a differently-shaped insertion loop; still yields its OWN fresh ids
  assert.deepEqual(b.rendered, [...b.ids].sort().reverse(), 'a second project, seeded via a different insertion-loop shape, ALSO renders its own ids in DESC order — the tiebreak is a pure function of id value, never of insertion/creation sequence');
});
// SABOTAGE: break ties by insertion/creation order (or leave them dependent
// on an unstable sort) instead of id DESC — either project's rendered
// sequence would then diverge from ITS OWN ids sorted DESC, failing the
// corresponding deepEqual assertion above.

test('H19 (rank PIN 4): a second touch of the SAME file delivers the remaining ranked decisions, none repeated, in the SAME ranked order computed once at the birth point', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    for (let i = 0; i < 11; i += 1) store.create(decisionRecord(`choice ${i}`, ['src/a.mjs']));
    const allCreated = store.query({ types: ['decision'], rank_terms: ['choice'], cap: 20 }).map((d) => d.id);
    assert.equal(allCreated.length, 11, 'FIXTURE LIVENESS: all 11 decisions are queryable before touching anything');

    const first = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(first.code, 0);
    const firstCtx = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
    const firstIds = [...firstCtx.matchAll(/\(knowledge_get ([0-9a-f-]{36})\)/g)].map((m) => m[1]);
    assert.equal(firstIds.length, 8, 'the cap holds on the first touch');

    const second = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(second.code, 0);
    const secondCtx = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
    const secondIdsClean = [...secondCtx.matchAll(/\(knowledge_get ([0-9a-f-]{36})\)/g)].map((m) => m[1]);
    assert.equal(secondIdsClean.length, 3, 'the remaining 3 render on the SAME-file second touch');
    assert.deepEqual(
      firstIds.filter((id) => secondIdsClean.includes(id)),
      [],
      'none of the first 8 reappear on the second touch of the same file'
    );

    // All 11 decisions here are tied on authority (none), updated_at (the
    // shared envelope NOW) and file_keys (all name exactly ['src/a.mjs']),
    // so the only remaining tiebreak is id DESC — the ranked order is the
    // full 11-id set sorted DESC, sliced at the birth point into an
    // 8-then-3 rotation.
    const rankedDesc = [...allCreated].sort().reverse();
    assert.deepEqual(
      secondIdsClean,
      rankedDesc.slice(8),
      'the second batch renders in the SAME ranked order computed once at the birth point'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: re-sort inside the renderer (recompute a fresh order from
// whatever decisions happen to still be unguarded at render time) instead of
// ranking ONCE at the birth point (freshDecisions) that both the guard slice
// and the renderer consume — the deepEqual(secondIdsClean, rankedDesc.slice(8))
// assertion above goes red if the renderer's own re-derived order diverges
// from the one the guard sliced against.

test('H19: a decision pointer carries its rejected OPTIONS beneath the statement (decision 6a3b1a46)', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(
      decisionRecord('breach timing is never shown to the player', ['src/a.mjs'], {
        alternatives_rejected: [
          { option: 'a numeric countdown in the HUD', reason: 'destroys the dread the mechanic exists for' },
          { option: 'a graphical arc that fills', reason: 'the same information in a prettier costume' },
        ],
      })
    );
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(
      ctx,
      /ALREADY REJECTED: a numeric countdown in the HUD; a graphical arc that fills/,
      'option texts render joined — recognising the thing you were about to propose is what stops you'
    );
    assert.doesNotMatch(ctx, /destroys the dread/, 'REASONS do not render — the option text is the recognition surface, the id carries the rest');
    assert.ok(
      ctx.indexOf('breach timing is never shown') < ctx.indexOf('ALREADY REJECTED'),
      'the statement ORIENTS before the rejected list STOPS'
    );
  } finally {
    cleanup();
  }
});

test('H19: a decision that rejected nothing renders no empty REJECTED line', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(decisionRecord('chose x', ['src/a.mjs'])); // helper defaults alternatives_rejected: []
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /→ chose x/, 'the statement pointer still renders');
    assert.doesNotMatch(ctx, /ALREADY REJECTED/, 'no empty artifact for a decision with nothing rejected');
  } finally {
    cleanup();
  }
});

test('H19: a long rejected list is clipped to its budget, not emitted whole', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(
      decisionRecord('s', ['src/a.mjs'], {
        alternatives_rejected: Array.from({ length: 12 }, (_, i) => ({
          option: `rejected option number ${i} carrying enough padding text to overrun the budget`,
          reason: 'r',
        })),
      })
    );
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    const line = ctx.split('\n').find((l) => l.includes('ALREADY REJECTED'));
    assert.ok(line, 'the rejected line renders');
    assert.ok(line.endsWith('…'), 'and is CLIPPED rather than emitted whole — the flood half of P6 still binds');
    assert.ok(line.length < 200, `the line stays bounded (was ${line.length} chars)`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4b rendering markers (a): decision.authority renders "[authority] "
// prefixed directly before the statement pointer; a decision without
// authority renders byte-identical to before (no marker, no extra space).
// ---------------------------------------------------------------------------

test('H19 (S4b a): a decision with authority renders its statement pointer prefixed "[authority] "', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(decisionRecord('chose x', ['src/a.mjs'], { authority: 'one_off' }));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /→ \[one_off\] chose x/, 'authority renders as a bracketed prefix directly before the statement');
  } finally {
    cleanup();
  }
});

test('H19 (S4b a): the same prefix renders for each of the three authority values', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(decisionRecord('standing choice', ['src/a.mjs'], { authority: 'standing' }));
    store.create(decisionRecord('session choice', ['src/a.mjs'], { authority: 'session_scoped' }));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /→ \[standing\] standing choice/);
    assert.match(ctx, /→ \[session_scoped\] session choice/);
  } finally {
    cleanup();
  }
});

test('H19 (S4b a): a decision WITHOUT authority renders its statement pointer with no marker and no extra space (unchanged)', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(decisionRecord('chose y', ['src/a.mjs'])); // no authority field at all
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /→ chose y/, 'the plain pointer still renders');
    assert.doesNotMatch(ctx, /\[(standing|session_scoped|one_off)\] chose y/, 'no authority → no bracketed marker, no extra space before the statement');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4b rendering markers (b): current_ac[].untestable_because appends
// " [untestable: <reason> — blocking <id8>]" to the AC line; unmarked ACs are
// unchanged; a very long reason is clipped, never emitted whole.
// ---------------------------------------------------------------------------

test('H19 (S4b b): an AC marked untestable_because renders " [untestable: <reason> — blocking <id8>]" appended to its AC line', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    const blockingId = randomUUID();
    store.create(
      article('alpha', ['src/a.mjs'], {
        current_ac: [
          {
            ac_id: 'AC1',
            text: 'alpha works',
            verifiable_at: 'final',
            untestable_because: { reason: 'no harness can drive a real browser download', blocking_record_id: blockingId },
          },
        ],
      })
    );
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    const id8 = blockingId.slice(0, 8);
    assert.match(
      ctx,
      new RegExp(`AC1: alpha works \\[untestable: no harness can drive a real browser download — blocking ${id8}\\]`),
      'the untestable annotation is appended to the AC line'
    );
  } finally {
    cleanup();
  }
});

test('H19 (S4b b): an AC without untestable_because renders unchanged — no [untestable: ...] suffix', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs'])); // default current_ac carries no untestable_because
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /AC1: alpha works/, 'the plain AC line still renders');
    assert.doesNotMatch(ctx, /\[untestable:/, 'no marker at all when nothing is untestable');
  } finally {
    cleanup();
  }
});

// SUPERSEDED 2026-09-20 (fix-round HIGH 2 remainder): the old body pinned a
// SILENT pre-clip — `clip(u.reason, UNTESTABLE_REASON_CLIP)` inside
// renderArticle, before the assembler ever saw the field — as CORRECT. That
// is precisely the false-substance-mark shape this whole step exists to
// remove: a >140-char reason was cut with no disclosure, yet the enclosing
// article part still earned a substance mark. Old assertions: `assert.ok(
// !line.includes(longReason), 'the raw 500-char reason is not emitted whole
// — clip() bounds it (P6 flood half)'); assert.ok(line.length <
// longReason.length, ...)`. renderArticle now renders the field whole and
// lets the assembler own degradation (matching WHAT IT DOES/INTENDED
// BEHAVIOR, fixed earlier in this same step) — this test now pins the
// OPPOSITE: the complete reason arrives, and P6 flood protection is still the
// assembler's job (the total/transport caps), not a silent per-field clip.
test('H19 (S4b b): a very long untestable_because reason arrives WHOLE on the AC line — no silent pre-clip', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    const blockingId = randomUUID();
    const longReason = `REASON_START ${'x'.repeat(500)} REASON_END`;
    store.create(
      article('alpha', ['src/a.mjs'], {
        current_ac: [
          { ac_id: 'AC1', text: 'alpha works', verifiable_at: 'final', untestable_because: { reason: longReason, blocking_record_id: blockingId } },
        ],
      })
    );
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    const line = ctx.split('\n').find((l) => l.includes('AC1: alpha works'));
    assert.ok(line, 'the AC line renders');
    assert.ok(line.includes(longReason), 'the complete reason arrives, start to end — no more silent per-field pre-clip');
  } finally {
    cleanup();
  }
});

test('H19: hazards and decisions are guarded per record like articles — a repeat touch re-delivers nothing', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern('latch', ['src/a.mjs']));
    store.create(decisionRecord('chose x', ['src/a.mjs']));
    const first = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /ANTI-PATTERN/);
    const second = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '', 'nothing fresh — no second delivery (AC4)');

    // Scope-growth re-arm still holds for a hazard added mid-session.
    store.create(antiPattern('new latch', ['src/a.mjs'], { severity: 'block' }));
    const third = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    const ctx = JSON.parse(third.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /'new latch'/, 'a NEW hazard mid-session delivers');
    assert.doesNotMatch(ctx, /'latch'\)/, 'the already-delivered hazard does not repeat');
  } finally {
    cleanup();
  }
});

test('H19: a hazard-only touch never denies the tool call (AC7 floor holds on the new path)', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'edit' });
  try {
    store.create(antiPattern('latch', ['src/orphan.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', preEdit(dir, 'src/orphan.mjs'), dir);
    assert.notEqual(r.code, 2, 'delivery is an aid, never a gate');
  } finally {
    cleanup();
  }
});

test('H19: capped-away decisions are NOT marked delivered — they surface on the next touch instead of vanishing', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    // 11 decisions governing BOTH files. Guarding all 11 on the first touch used
    // to leave the second file with no DECISIONS block at all — not even a count
    // (correctness review 2026-07-30).
    store.create(article('alpha', ['src/a.mjs']));
    store.create(article('beta', ['src/b.mjs']));
    for (let i = 0; i < 11; i += 1) store.create(decisionRecord(`choice ${i}`, ['src/a.mjs', 'src/b.mjs']));

    const first = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    const firstCtx = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
    assert.equal(firstCtx.match(/\(knowledge_get [0-9a-f-]{36}\)/g).length, 8, 'the cap still holds on the first touch');

    const second = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/b.mjs'), dir);
    assert.equal(second.code, 0);
    const secondCtx = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
    assert.match(secondCtx, /DECISIONS for this path \(3\)/, 'the 3 never-rendered decisions reach the second file');
    assert.equal(secondCtx.match(/\(knowledge_get [0-9a-f-]{36}\)/g).length, 3);
    assert.doesNotMatch(secondCtx, /NOT shown/, 'nothing is dropped this time, so nothing is disclosed as dropped');

    // And a third touch of the first file re-delivers nothing: everything governing
    // it has now actually been shown.
    const third = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(third.stdout, '', 'the guard still converges — no endless re-delivery (AC4)');
  } finally {
    cleanup();
  }
});

test('H19: a one-hop pointer resolves a sibling that loses its own bm25 top-5 — no false "(not in store)"', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('owner', ['src/a.mjs'], { dependencies: { relies_on: ['popular'], relied_by: [] } }));
    store.create(article('popular', ['src/p.mjs'], { what_it_does: 'popular is the sibling that matters' }));
    // Decoys that cite the sibling's slug far more than it names itself — the live
    // shape that made the old ranked cap-5 pointer lookup report it absent
    // (decision 3db7095f).
    for (let i = 0; i < 6; i += 1) {
      store.create(
        article(`citer-${i}`, [`src/c${i}.mjs`], {
          what_it_does: 'popular popular popular popular popular',
          intended_behavior: 'popular popular popular',
        })
      );
    }

    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /→ relies_on \[\[popular\]\]: popular is the sibling that matters/, 'the pointer resolves to real substance');
    assert.doesNotMatch(ctx, /\(not in store\)/, 'a live sibling is never reported absent');
  } finally {
    cleanup();
  }
});

test('H19: a one-hop pointer to a genuinely absent slug still says so', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('owner', ['src/a.mjs'], { dependencies: { relies_on: ['never-written'], relied_by: [] } }));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /→ relies_on \[\[never-written\]\]: \(not in store\)/, 'absence is still reported — the fix removes FALSE absence only');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// BASH POINTER DELIVERY (board 841195b1). Delivery rode Edit|Write|MultiEdit and
// Read only, while surveying happens through grep/wc/git log — the net had a
// hole exactly where the traffic is, and it was SILENT. These tests pin the
// three deliberate differences from full delivery: pointer not article, always
// direct on its own PostToolUse (no enqueue/drain — that path was deleted in
// delivery-migration step 2, decision knowledge-delivery-target-design-no-
// delayed-delivery), and silence on unowned territory. AC7 still holds: no
// path may exit 2.
// ---------------------------------------------------------------------------

const postBash = (dir, command, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  session_id: 's1',
  cwd: dir,
  ...extra,
});

/** The extractor is PURE, so it is tested directly rather than through a hook. */
async function extractor() {
  const m = await import(pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href);
  return m.extractCommandPathCandidates;
}

test('bash extractor: keeps real path shapes, drops flags, globs and bare words', async () => {
  const extract = await extractor();
  assert.deepEqual(extract('grep -n needle src/a.mjs'), ['src/a.mjs'], 'flag and pattern dropped, path kept');
  assert.deepEqual(extract('wc -l packages/store/src/index.ts'), ['packages/store/src/index.ts']);
  assert.deepEqual(extract('git log --oneline -5 -- scripts/init.mjs'), ['scripts/init.mjs'], '`--` separator is not a path');
  assert.deepEqual(extract('ls -la'), [], 'no path-shaped token at all');
  assert.deepEqual(extract('rm -rf scripts/tests/*.test.mjs'), [], 'a glob is dropped, never half-expanded');
  assert.deepEqual(extract('cat "packages/a b/c.ts"'), ['packages/a b/c.ts'], 'quoted path with a space is one token');
  assert.deepEqual(extract('sed -n 1,5p scripts/a.mjs:12'), ['scripts/a.mjs'], 'grep -n style path:line is stripped');
  assert.deepEqual(extract('node --test scripts/x.mjs scripts/x.mjs'), ['scripts/x.mjs'], 'deduped');
  assert.deepEqual(extract('echo $HOME/x.ts'), [], 'shell expansion is unresolvable, so dropped');
  assert.deepEqual(extract('cat package.json'), ['package.json'], 'extension with no slash still qualifies');
});

test('bash delivery: rung read injects its capped POINTER on this tool call, never queues it', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
    store.create(article('owner', ['src/a.mjs']));
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'grep -n export src/a.mjs'), dir);
    assert.equal(r.code, 0, 'AC7: delivery never blocks');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING KNOWLEDGE POINTERS \(H19\)/, 'the pointer arrives before the next action');
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, 'PostToolUse', 'Bash is a PostToolUse hook');
    const q = pendingOf(dir);
    assert.equal(q.length, 0, 'read-rung Bash never waits for UserPromptSubmit');
    assert.match(ctx, /src\/a\.mjs — article 'owner \[owner\]' \(active\) · knowledge_get /, 'title and slug both render (title === slug in this fixture)');
    assert.doesNotMatch(ctx, /does the owner thing/, 'the article BODY is never in a pointer payload');
  } finally {
    cleanup();
  }
});

test('bash delivery: a search PATTERN that looks like a path delivers nothing', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    store.create(article('owner', ['src/a.mjs']));
    // 'lib/missing.ts' is the grep PATTERN and exists nowhere: the existence
    // check is what makes a shape-only extractor safe.
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'grep -rn lib/missing.ts .'), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'a direct pointer would make this negative case fail');
    assert.equal(pendingOf(dir).length, 0, 'a non-existent path-shaped token is not a touch');
  } finally {
    cleanup();
  }
});

test('bash delivery: unowned territory is SILENT (no frontier signal on every grep)', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'lonely.mjs'), 'x\n');
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'wc -l src/lonely.mjs'), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'unowned survey territory has no direct context');
    assert.equal(pendingOf(dir).length, 0, 'the frontier signal is right for an edit, wrong for a survey');
  } finally {
    cleanup();
  }
});

test('bash delivery: a directory argument never fans out across the files beneath it', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    store.create(article('owner', ['src/a.mjs']));
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'ls -la src/'), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'directories have no direct pointer');
    assert.equal(pendingOf(dir).length, 0, 'ownership is declared per FILE');
  } finally {
    cleanup();
  }
});

// Superseded 2026-09-20 (Step 3, decision knowledge-delivery-target-design-
// no-delayed-delivery item 4): a Bash hazard now renders WHOLE via the SAME
// hazardHeaderLine every other surface uses, never the old one-line
// "⚠ HAZARD anti_pattern '<title>'" pointer form — a whole hazard is
// substance, never a mere pointer.
test('bash delivery: hazards lead, and are rendered whole even in unowned territory',()=>{const {dir,store,cleanup}=makeProject();try{mkdirSync(join(dir,'src'),{recursive:true});writeFileSync(join(dir,'src','h.mjs'),'x');store.create(antiPattern('never do the bad thing',['src/h.mjs']));const r=runHook('h19-bash-delivery.mjs',postBash(dir,'cat src/h.mjs'),dir);const ctx=JSON.parse(r.stdout).hookSpecificOutput.additionalContext;assert.match(ctx,/⚠ ANTI-PATTERN \[WARN\] for this path — 'never do the bad thing'/);assert.match(ctx,/TRIGGER: /);assert.match(ctx,/RIGHT WAY: /);}finally{cleanup();}});
// 2026-09-19 deliberate change (3): Bash pointers inject at the read rung,
// rather than queueing for the next prompt.  The pointer/full separation remains.
test('bash delivery: a pointer NEVER suppresses the later full-article delivery for that file', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    store.create(article('owner', ['src/a.mjs']));

    const bash = runHook('h19-bash-delivery.mjs', postBash(dir, 'grep -n x src/a.mjs'), dir);
    assert.equal(bash.code, 0);
    assert.equal(pendingOf(dir).length, 0, 'tool-time pointer is not queued');
    const pointer = JSON.parse(bash.stdout).hookSpecificOutput.additionalContext;
    assert.match(pointer, /src\/a\.mjs/, 'Bash injects the pointer at tool time');

    // The whole point of the separate pointer_files namespace: pointing is not
    // delivering, so a pointer must not cost the reader the real article.
    const read = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(read.code, 0);
    const ctx = JSON.parse(read.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /owning knowledge for 'src\/a\.mjs'/, 'the full article still delivers after a pointer');
    assert.match(ctx, /does the owner thing/, 'and it carries the body the pointer withheld');
  } finally {
    cleanup();
  }
});

test('bash delivery: the same path is pointed at once per session',()=>{const {dir,store,cleanup}=makeProject();try{mkdirSync(join(dir,'src'),{recursive:true});writeFileSync(join(dir,'src','a.mjs'),'x');store.create(article('owner',['src/a.mjs']));const first=runHook('h19-bash-delivery.mjs',postBash(dir,'grep -n x src/a.mjs'),dir);const second=runHook('h19-bash-delivery.mjs',postBash(dir,'wc -l src/a.mjs'),dir);assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext,/src\/a\.mjs/);assert.equal(second.stdout,'');}finally{cleanup();}});
test('bash delivery: a subagent gets read-rung delivery in its own tool context', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    store.create(article('owner', ['src/a.mjs']));
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'grep -n x src/a.mjs', { agent_id: 'coder-1' }), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /src\/a\.mjs/, 'the child receives the pointer before continuing');
    assert.equal(pendingOf(dir).length, 0, 'a child touch is never queued into the conductor context');
  } finally {
    cleanup();
  }
});

test('bash delivery: one command cannot deliver an unbounded number of pointers',()=>{const {dir,store,cleanup}=makeProject();try{mkdirSync(join(dir,'src'),{recursive:true});const paths=[];for(let i=0;i<12;i++){const q=`src/f${i}.mjs`;writeFileSync(join(dir,q),'x');paths.push(q);store.create(article(`owner${i}`,[q]));}const r=runHook('h19-bash-delivery.mjs',postBash(dir,`wc -l ${paths.join(' ')}`),dir);const lines=JSON.parse(r.stdout).hookSpecificOutput.additionalContext.split('\n').filter(l=>l.startsWith('  • '));assert.equal(lines.length,8);}finally{cleanup();}});
test('bash delivery: the store tree and .git are never governed territory', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('owner', ['.sterling/config.json']));
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'cat .sterling/config.json'), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'the store tree has no direct pointer');
    assert.equal(pendingOf(dir).length, 0);
  } finally {
    cleanup();
  }
});

test('bash delivery: a malformed or pathless command is a clean no-op', () => {
  const { dir, cleanup } = makeProject();
  try {
    for (const cmd of ['', 'ls', 'echo hello world']) {
      const r = runHook('h19-bash-delivery.mjs', postBash(dir, cmd), dir);
      assert.equal(r.code, 0, `AC7 holds for '${cmd}'`);
      assert.equal(r.stdout, '', `malformed command '${cmd}' has no direct context`);
    }
    const noInput = runHook('h19-bash-delivery.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, cwd: dir }, dir);
    assert.equal(noInput.code, 0, 'a missing command string never blocks');
    assert.equal(noInput.stdout, '', 'a missing command string has no direct context');
    assert.equal(pendingOf(dir).length, 0);
  } finally {
    cleanup();
  }
});
