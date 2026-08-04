// H19 — dispatch staging (AC5, board 7b01f139-7341-4d3c-9991-6c1c27ceafc7).
// SubagentStart hook: recovers the dispatch prompt(s) from the parent
// transcript (no prompt field on stdin — research_finding 35a89a0f) and stages
// the same governed-territory payload h19-knowledge-delivery.mjs computes for
// a file touch. AC7 precedent holds here too: never a gate, exit 0/1 only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-04T12:00:00.000Z';

let SterlingStore;
const { before } = await import('node:test');
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

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-stage-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

// --- transcript fixture helpers -------------------------------------------

function taskBlock(prompt, name = 'Task') {
  return { type: 'tool_use', name, input: { prompt } };
}

function assistantLine(blocks) {
  return JSON.stringify({ type: 'assistant', message: { content: blocks } });
}

function writeTranscript(dir, lines) {
  const p = join(dir, `transcript-${randomUUID()}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

const subagentStart = (dir, transcriptPath, extra = {}) => ({
  hook_event_name: 'SubagentStart',
  session_id: 's1',
  transcript_path: transcriptPath,
  cwd: dir,
  prompt_id: 'p1',
  agent_id: 'agent-1',
  agent_type: 'general-purpose',
  ...extra,
});

const guardOf = (dir, agentId) => {
  const p = join(dir, '.sterling', 'transient', 'delivery', `guard-agent-${agentId}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

test('no Task/Agent tool_use in the transcript: silent, exit 0', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = writeTranscript(dir, [assistantLine([{ type: 'text', text: 'just thinking, no dispatch' }])]);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(guardOf(dir, 'agent-1'), null);
  } finally {
    cleanup();
  }
});

test('prompt names no repo paths: silent, exit 0 (AC5 "undeclared dispatches unchanged")', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = writeTranscript(dir, [assistantLine([taskBlock('Please investigate the login flow and report back.')])]);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally {
    cleanup();
  }
});

test('prompt names a governed file: payload contains the article, and the guard is written', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = writeTranscript(dir, [assistantLine([taskBlock('Go read src/a.mjs and fix the bug there.')])]);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert.match(out.hookSpecificOutput.additionalContext, /STERLING KNOWLEDGE DELIVERY/);
    assert.match(out.hookSpecificOutput.additionalContext, /alpha does the alpha thing/);

    const guard = guardOf(dir, 'agent-1');
    assert.ok(guard, 'guard file written for the spawned agent');
    const alphaId = store.query({ types: ['feature_article'], rank_terms: ['alpha'], cap: 5 }).find((a) => a.slug === 'alpha').id;
    assert.ok(guard.records.includes(alphaId));

    // Re-running the same dispatch (e.g. a second SubagentStart oddity) does not
    // re-deliver what this agent's guard already marked.
    const again = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript), dir);
    assert.equal(again.stdout, '', 'guarded — nothing fresh to stage');
  } finally {
    cleanup();
  }
});

test('parallel two-dispatch message: the union of both Task prompts is considered (both governed files staged)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(article('beta', ['src/b.mjs']));
    const transcript = writeTranscript(dir, [
      assistantLine([taskBlock('Agent one: work on src/a.mjs'), taskBlock('Agent two: work on src/b.mjs')]),
    ]);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /alpha does the alpha thing/, 'first dispatch block in the message is included');
    assert.match(ctx, /beta does the beta thing/, 'second dispatch block in the SAME message is included too — the union');
  } finally {
    cleanup();
  }
});

test('malformed transcript (corrupt JSONL): silent, exit 0 — never a throw the caller must special-case', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = join(dir, 'broken.jsonl');
    writeFileSync(transcript, 'not json at all\n{"type":"assistant","message":{"content":[{');
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript), dir);
    assert.notEqual(r.code, 2, 'never denies (AC7 precedent)');
    assert.equal(r.stdout, '');
  } finally {
    cleanup();
  }
});

test('missing transcript_path / nonexistent file: silent, exit 0', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, join(dir, 'does-not-exist.jsonl')), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally {
    cleanup();
  }
});

test('only the LAST assistant message with a Task/Agent block is used — an earlier stale dispatch is ignored', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(article('beta', ['src/b.mjs']));
    const transcript = writeTranscript(dir, [
      assistantLine([taskBlock('stale dispatch about src/a.mjs')]),
      assistantLine([{ type: 'text', text: 'some interstitial reasoning, no dispatch' }]),
      assistantLine([taskBlock('current dispatch about src/b.mjs')]),
    ]);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /beta does the beta thing/);
    assert.doesNotMatch(ctx, /alpha does the alpha thing/, 'the earlier message is not consulted once a later one has a dispatch');
  } finally {
    cleanup();
  }
});

test('not a Sterling project (no store): silent, exit 0', () => {
  const bare = mkdtempSync(join(tmpdir(), 'sterling-h19-stage-bare-'));
  try {
    const transcript = writeTranscript(bare, [assistantLine([taskBlock('work on src/a.mjs')])]);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(bare, transcript), bare);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
