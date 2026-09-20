// H19 per-delivery TOTAL cap + cross-entry dedup (Sterling scale-down Slice 3c,
// decision sterling-claude-code-scale-down-boundary; board d0f3647a measured
// 13,010-17,078 bytes per governed article because payload_char_cap clips per
// FIELD and nothing bounded a delivery as a whole).
//
// THE CONTRACT these pins freeze (written before the fix):
//   1. A tool-time delivery (rung 'read'), the Bash pointer delivery and the
//      SubagentStart dispatch staging each stay within
//      config.delivery.total_cap_bytes (default DELIVERY_TOTAL_CAP_DEFAULT,
//      3000 bytes) — EXCEPT hazard substance, which is never cut by the cap.
//   2. What does not fit becomes a pointer (`knowledge_get <id>`), never
//      silently dropped.
//   3. Hazards (anti_pattern TRIGGER + RIGHT WAY) stay verbatim even when they
//      alone exceed the cap.
//   4. The cap is config-overridable.
//   5. An article already delivered this session is not re-delivered in full;
//      a Bash pointer is not repeated for a record a Read already delivered,
//      and one owner reachable through several paths gets one pointer line.
//
// Determinism: fixture stores in tmp dirs, removed in finally.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-09-19T12:00:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const DEFAULT_CAP = 3000;

const oneLine = (s) => (s || '').replace(/\s+/g, ' ').trim();
const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

let SterlingStore;
let DELIVERY_TOTAL_CAP_DEFAULT;
let renderHazards;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ DELIVERY_TOTAL_CAP_DEFAULT, renderHazards } = await import(pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href));
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

function antiPattern(title, trigger, rightWay, paths) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: rightWay,
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: paths,
  };
}

function decision(n, paths) {
  return {
    ...envelope('decision'),
    // distinct created_at so ranking is deterministic
    created_at: `2026-09-${String(10 + n).padStart(2, '0')}T00:00:00.000Z`,
    updated_at: OLD,
    title: `Ruling number ${n} about the delivery surface`,
    statement: `Ruling ${n}: ${'the delivery surface keeps its standing shape because a long statement explains it '.repeat(3)}`,
    alternatives_rejected: [
      { option: `Alternative ${n}a ${'rejected wording '.repeat(8)}`, reason: 'no' },
      { option: `Alternative ${n}b ${'rejected wording '.repeat(8)}`, reason: 'no' },
    ],
    rationale: 'rationale',
    file_keys: paths,
  };
}

function makeProject(delivery = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-totalcap-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, '.sterling', 'config.json'),
    JSON.stringify({ delivery: { injection_rung: 'read', ...delivery } })
  );
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const touch = (dir, rel) => writeFileSync(join(dir, rel), 'x\n');

const postRead = (dir, file) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, file) },
  session_id: 's1',
  cwd: dir,
});

const ctxOf = (r) => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '' : '');

// A ~26KB body (hooks-suite's real offender shape) plus a long intended_behavior.
const bigBody = `BODY_HEAD ${'padding word '.repeat(2000)} BODY_TAIL`;
const bigIntended = `INTENDED_HEAD ${'intended word '.repeat(600)} INTENDED_TAIL`;

function seedLarge(store, paths) {
  const a = store.create(article('huge-article', paths, { what_it_does: bigBody, intended_behavior: bigIntended }));
  for (let n = 1; n <= 8; n++) store.create(decision(n, paths));
  return a;
}

test('CONTROL: the shipped default total cap is 3000 bytes', () => {
  assert.equal(DELIVERY_TOTAL_CAP_DEFAULT, DEFAULT_CAP);
});

test('C1: a tool-time Read of a file owned by a large article plus 8 decisions stays within the default total cap, and the article is still reachable by id', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touch(dir, 'src/a.mjs');
    const a = seedLarge(store, ['src/a.mjs']);
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0, `delivery never blocks: ${oneLine(r.stderr)}`);
    const ctx = ctxOf(r);
    // CONTROL arm: something substantive was delivered, naming the article.
    assert.match(ctx, /STERLING KNOWLEDGE DELIVERY/);
    assert.ok(ctx.includes(`knowledge_get ${a.id}`), 'the article stays reachable through its full id');
    assert.ok(bytes(ctx) <= DEFAULT_CAP, `delivery must fit the ${DEFAULT_CAP}-byte total cap (was ${bytes(ctx)})`);
  } finally {
    cleanup();
  }
});

test('C2: hazards are NEVER cut by the total cap — every trigger and right-way arrives verbatim even when hazards alone exceed it', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touch(dir, 'src/b.mjs');
    // Unowned territory (no porch): three hazards whose fields are each ~1.4KB,
    // under payload_char_cap (2400) but together far over 3000 bytes. Each
    // field ends in a unique sentinel a truncation would lose.
    const sentinels = [];
    const hazardRecords = [];
    for (let i = 1; i <= 3; i++) {
      const t = `TRIG_END_${i}`;
      const w = `RIGHT_END_${i}`;
      sentinels.push(t, w);
      hazardRecords.push(store.create(
        antiPattern(`Hazard ${i}`, `${'trigger words here '.repeat(70)}${t}`, `${'right way words '.repeat(85)}${w}`, ['src/b.mjs'])
      ));
    }
    for (let n = 1; n <= 8; n++) store.create(decision(n, ['src/b.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/b.mjs'), dir);
    assert.equal(r.code, 0, oneLine(r.stderr));
    const ctx = ctxOf(r);
    for (const s of sentinels) assert.ok(ctx.includes(s), `hazard text '${s}' must arrive whole`);
    // UPDATED 2026-09-19 for decision 301d8a0a's structured hazard budget:
    // hazard substance may exceed the total cap, but every other byte — header,
    // decisions and pointers — is still bounded by it. The prior query-pointer
    // expectation treated hazards as consuming ordinary budget, contradicting
    // the adjudicated cap-plus-hazards contract.
    const hazardBytes = bytes(renderHazards(hazardRecords, 2400, { fileKeys: ['src/b.mjs'] }).join('\n\n'));
    assert.ok(bytes(ctx) - hazardBytes <= DEFAULT_CAP, `ordinary delivery exceeds ${DEFAULT_CAP} bytes (total ${bytes(ctx)}, hazards ${hazardBytes})`);
  } finally {
    cleanup();
  }
});

test('C3: the total cap is config-overridable through delivery.total_cap_bytes', () => {
  const { dir, store, cleanup } = makeProject({ total_cap_bytes: 20000 });
  try {
    touch(dir, 'src/a.mjs');
    seedLarge(store, ['src/a.mjs']);
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    const ctx = ctxOf(r);
    assert.ok(bytes(ctx) > DEFAULT_CAP, `a raised cap admits more than the default (was ${bytes(ctx)})`);
    assert.ok(bytes(ctx) <= 20000, `and still stays within the configured cap (was ${bytes(ctx)})`);
  } finally {
    cleanup();
  }
});

test('C4: an article already delivered this session is not re-delivered in full on a second governed Read', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touch(dir, 'src/a.mjs');
    touch(dir, 'src/c.mjs');
    store.create(article('shared-article', ['src/a.mjs', 'src/c.mjs'], { what_it_does: 'SHARED_BODY_SENTINEL does things' }));
    const first = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));
    assert.ok(first.includes('SHARED_BODY_SENTINEL'), 'CONTROL: the first touch delivers the body');
    const second = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/c.mjs'), dir));
    assert.ok(!second.includes('SHARED_BODY_SENTINEL'), 'the second touch must not repeat the article body');
  } finally {
    cleanup();
  }
});

// --- Bash pointer delivery ---------------------------------------------------

const postBash = (dir, command) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  session_id: 's1',
  cwd: dir,
});

test('review H2: wholly held-back and partially served Bash paths remain retryable; tail never points at unprinted paths above', () => {
  const { dir, store, cleanup } = makeProject({ total_cap_bytes: 800 });
  try {
    const rels = ['src/first.mjs', 'src/partial.mjs', 'src/held.mjs'];
    rels.forEach((rel) => touch(dir, rel));
    const first = store.create(article('first', [rels[0]]));
    const partial = [0, 1, 2, 3].map((i) => store.create(article(`partial-${i}`, [rels[1]])));
    const held = store.create(article('held', [rels[2]]));
    const result = runHook('h19-bash-delivery.mjs', postBash(dir, `cat ${rels.join(' ')}`), dir);
    assert.equal(result.code, 0, result.stderr);
    const payload = ctxOf(result);
    assert.ok(payload.includes(first.id), 'control: early path was served');
    const partialShown = partial.filter((r) => payload.includes(r.id));
    assert.ok(partialShown.length > 0 && partialShown.length < partial.length, 'fixture actually partly serves the middle path');
    assert.ok(!payload.includes(held.id) && !payload.includes(rels[2]), 'last path has no printed record');
    assert.match(payload, /more pointer line/);
    assert.doesNotMatch(payload, /paths? (?:printed )?above/, 'the overflow remedy includes paths absent from the printed block');
    const guard = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'delivery', 's1', 'guard-conductor.json'), 'utf8'));
    assert.ok(guard.pointer_files.includes(rels[0]));
    assert.ok(!guard.pointer_files.includes(rels[1]) && !guard.pointer_files.includes(rels[2]), 'partial and wholly omitted paths are unspent');
    const retry = ctxOf(runHook('h19-bash-delivery.mjs', postBash(dir, `cat ${rels[2]}`), dir));
    assert.ok(retry.includes(held.id), 'a later command delivers the wholly held-back record');
    assert.match(ctxOf(runHook('h19-bash-delivery.mjs', postBash(dir, `cat ${rels[1]}`), dir)), /partial-/, 'partly served path retries too');
  } finally { cleanup(); }
});

function pendingPayloads(dir) {
  const p = join(dir, '.sterling', 'transient', 'delivery', 'pending.json');
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8'));
}

// SUPERSEDED 2026-09-20 (pre-authorized, decision knowledge-delivery-target-
// design-no-delayed-delivery item 4): a Bash hazard now renders WHOLE, through
// the SAME renderHazards the Read rung uses — never a one-line pointer — and
// is therefore capped at HAZARD_CAP (3), not "every hazard named, however
// many". The old assertion was `for (const id of hazardIds)
// assert.ok(payload.includes(id), 'hazard ${id} pointer is never capped
// away')` over all 8 hazard ids; superseded by the HAZARD_CAP-bounded pair of
// assertions below.
test('C5: a read-rung Bash command naming 8 governed paths injects its pointer block within the total cap, exactly HAZARD_CAP hazards whole, the rest disclosed as a count', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const rels = [];
    const hazards = [];
    for (let i = 1; i <= 8; i++) {
      const rel = `src/f${i}.mjs`;
      touch(dir, rel);
      rels.push(rel);
      for (const k of ['alpha', 'beta']) {
        store.create(article(`owner-${k}-${i}-${'long-slug-segment-'.repeat(3)}`, [rel], { title: `Owner ${k} ${i} ${'with a long descriptive title '.repeat(2)}` }));
      }
      hazards.push(store.create(antiPattern(`Hazard for f${i}`, 'trigger', 'right', [rel])));
    }
    const hazardIds = hazards.map((h) => h.id);
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, `wc -l ${rels.join(' ')}`), dir);
    assert.equal(r.code, 0, oneLine(r.stderr));
    const payload = ctxOf(r);
    assert.match(payload, /STERLING KNOWLEDGE POINTERS/, 'CONTROL: one pointer block is injected at tool time');
    assert.equal(pendingPayloads(dir).length, 0, 'read-rung Bash does not wait for a prompt drain');
    for (const id of hazardIds.slice(0, 3)) assert.ok(payload.includes(id), `hazard ${id} renders whole — never capped away (HAZARD_CAP)`);
    for (const id of hazardIds.slice(3)) assert.ok(!payload.includes(id), `hazard ${id} is beyond HAZARD_CAP — disclosed as a count, not shown`);
    assert.match(payload, /more hazard\(s\) NOT shown \(cap 3\)/, 'the hazards beyond HAZARD_CAP are disclosed as a count');
    // Hazards are pinned/unbudgeted (decision 301d8a0a) — only the ORDINARY
    // (non-hazard) bytes are bound by the cap, same rule C2 pins for the Read
    // rung.
    const hazardBytes = bytes(renderHazards(hazards, Number.MAX_SAFE_INTEGER, { fileKeys: rels }).join('\n\n'));
    assert.ok(bytes(payload) - hazardBytes <= DEFAULT_CAP, `ordinary (non-hazard) bytes must fit ${DEFAULT_CAP} bytes (was ${bytes(payload) - hazardBytes})`);
    assert.match(payload, /more pointer/i, 'the capped-away owner lines are disclosed as a count');
  } finally {
    cleanup();
  }
});

test('C6: Bash pointers dedup — one line per owner across paths, and no line for an owner a Read already delivered this session', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    for (const f of ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs']) touch(dir, f);
    const shared = store.create(article('shared-owner', ['src/a.mjs', 'src/b.mjs', 'src/c.mjs']));
    const readFirst = store.create(article('read-first-owner', ['src/d.mjs']));
    // Read delivers read-first-owner in full (conductor guard).
    const rd = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/d.mjs'), dir));
    assert.ok(rd.includes(readFirst.id), 'CONTROL: the Read delivered the article');
    const bash = runHook('h19-bash-delivery.mjs', postBash(dir, 'cat src/a.mjs src/b.mjs src/c.mjs src/d.mjs'), dir);
    const payload = ctxOf(bash);
    assert.match(payload, /STERLING KNOWLEDGE POINTERS/, 'CONTROL: a pointer block arrives before the next action');
    const sharedLines = payload.split('\n').filter((l) => l.includes(shared.id));
    assert.equal(sharedLines.length, 1, `one pointer line for an owner of three named paths (saw ${sharedLines.length})`);
    assert.ok(!payload.includes(readFirst.id), 'an owner already delivered by a Read is not pointed at again');
  } finally {
    cleanup();
  }
});

// --- SubagentStart dispatch staging -------------------------------------------

function stageDispatch(dir, prompt, subagent_type = 'general-purpose') {
  const noTranscript = join(dir, 'no-such-parent-transcript.jsonl');
  const r = spawnSync(process.execPath, [join(HOOKS, 'h22-dispatch-register.mjs')], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: `toolu_${randomUUID().slice(0, 8)}`,
      tool_input: { subagent_type, prompt, description: 'a lane' },
      session_id: 's1',
      cwd: dir,
      transcript_path: noTranscript,
      prompt_id: 'p1',
    }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
  assert.notEqual(r.status, 2);
  return noTranscript;
}

test('C7: dispatch staging of a path owned by a large article plus 8 decisions keeps its knowledge payload within the total cap', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touch(dir, 'src/a.mjs');
    const a = seedLarge(store, ['src/a.mjs']);
    const transcript = stageDispatch(dir, 'Go work on src/a.mjs and report back.');
    const r = runHook(
      'h19-dispatch-staging.mjs',
      {
        hook_event_name: 'SubagentStart',
        session_id: 's1',
        transcript_path: transcript,
        cwd: dir,
        prompt_id: 'p1',
        agent_id: 'agent-1',
        agent_type: 'general-purpose',
      },
      dir
    );
    assert.equal(r.code, 0, oneLine(r.stderr));
    const ctx = ctxOf(r);
    assert.ok(ctx.includes(`knowledge_get ${a.id}`), 'CONTROL: the staged payload names the article');
    // MEASURE THE FINAL COMPOSED CONTEXT, NOT THE KNOWLEDGE PAYLOAD ALONE
    // (fix-round test-integrity requirement — decision 92088a62: "the cap is
    // charged on the FINAL composed context string"). Stripping the fixed
    // chrome (return contract) before measuring — the old body here — could
    // never detect a cap failure caused BY that chrome (fix-round HIGH 4: the
    // return contract used to be appended after capping, escaping the cap
    // entirely; it is now a charged part of this same string).
    assert.ok(bytes(ctx) <= DEFAULT_CAP, `the FULL staged context (knowledge + chrome) must fit ${DEFAULT_CAP} bytes (was ${bytes(ctx)})`);
  } finally {
    cleanup();
  }
});

test('C8: under the default cap the porch-end self-report still equals what follows — its decision-pointer count is the post-cap actual', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touch(dir, 'src/a.mjs');
    seedLarge(store, ['src/a.mjs']);
    const decisionIds = store.query({ types: ['decision'], file_keys: ['src/a.mjs'], cap: 100 }).map((r) => r.id);
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    const ctx = ctxOf(r);
    const endLine = ctx.split('\n').find((l) => /PORCH END/.test(l));
    assert.ok(endLine, `CONTROL: a porch rendered; ctx=${ctx.slice(0, 400)}`);
    const m = endLine.match(/path channel[^0-9]{0,16}(\d+)\s*decision/i);
    assert.ok(m, `the porch-end line states a path-channel count: ${endLine}`);
    const below = ctx.slice(ctx.indexOf(endLine) + endLine.length);
    const rendered = decisionIds.filter((id) => below.includes(id)).length;
    assert.equal(Number(m[1]), rendered, `porch says ${m[1]} decision pointer(s) follow; ${rendered} actually do`);
  } finally {
    cleanup();
  }
});

test('C9: dispatch staging under the default cap — the porch-end decision-pointer count is the post-cap actual', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touch(dir, 'src/a.mjs');
    seedLarge(store, ['src/a.mjs']);
    const decisionIds = store.query({ types: ['decision'], file_keys: ['src/a.mjs'], cap: 100 }).map((r) => r.id);
    const transcript = stageDispatch(dir, 'Go work on src/a.mjs and report back.');
    const r = runHook(
      'h19-dispatch-staging.mjs',
      { hook_event_name: 'SubagentStart', session_id: 's1', transcript_path: transcript, cwd: dir, prompt_id: 'p1', agent_id: 'agent-1', agent_type: 'general-purpose' },
      dir
    );
    const ctx = ctxOf(r);
    const endLine = ctx.split('\n').find((l) => /PORCH END/.test(l));
    assert.ok(endLine, 'CONTROL: a porch rendered');
    const m = endLine.match(/path channel[^0-9]{0,16}(\d+)\s*decision/i);
    assert.ok(m, `the porch-end line states a path-channel count: ${endLine}`);
    const below = ctx.slice(ctx.indexOf(endLine) + endLine.length);
    const rendered = decisionIds.filter((id) => below.includes(id)).length;
    assert.equal(Number(m[1]), rendered, `porch says ${m[1]} decision pointer(s) follow; ${rendered} actually do`);
  } finally {
    cleanup();
  }
});
