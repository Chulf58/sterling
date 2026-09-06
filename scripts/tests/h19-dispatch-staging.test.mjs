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

/** Raw path: pipe an arbitrary (possibly non-JSON, possibly empty) string —
 * used by the H28-absorption pins below to exercise the parse-failure path. */
function runRaw(script, rawInput, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: rawInput,
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

function makeProject(configOverride = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-stage-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(configOverride));
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

// POST-FOLD (decision 04982f45): H28's contract injection was unconditional
// for every non-exempt agent_type, with zero dependency on transcript
// content, project state, or the staging guard — "byte-preserved, only
// relocated". So a dispatch with nothing to STAGE is no longer silent: it is
// now contract-only. "AC5 undeclared dispatches unchanged" now describes the
// STAGING side alone; the net platform output changed by design.
test('no Task/Agent tool_use in the transcript: contract-only, exit 0 (nothing to stage, contract still fires)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = writeTranscript(dir, [assistantLine([{ type: 'text', text: 'just thinking, no dispatch' }])]);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'non-exempt agent_type (general-purpose) always gets the absorbed contract');
    assert.doesNotMatch(ctx, /STERLING KNOWLEDGE DELIVERY/, 'no knowledge-staging payload when nothing was staged');
    assert.doesNotMatch(ctx, /alpha does the alpha thing/, 'no article content leaks in when there is nothing to stage');
    assert.equal(guardOf(dir, 'agent-1'), null, 'no staging guard written — nothing was staged, only the contract fired');

    // SHAPE PIN (decision d6acfc54): the emit stays exactly
    // {hookSpecificOutput:{hookEventName, additionalContext}} — nothing else
    // at top level, nothing else inside hookSpecificOutput. The fold must not
    // widen this (e.g. a separate contract field, or permissionDecision —
    // both already rejected by that decision as non-channels).
    assert.deepEqual(Object.keys(out).sort(), ['hookSpecificOutput'], 'nothing added at the top level');
    assert.deepEqual(
      Object.keys(out.hookSpecificOutput).sort(),
      ['additionalContext', 'hookEventName'],
      'nothing added inside hookSpecificOutput'
    );
    assert.equal(typeof ctx, 'string', 'additionalContext stays a single string, not split into multiple fields');
  } finally {
    cleanup();
  }
});
// Sabotage (contract-only property): drop the unconditional contract emit —
// e.g. only inject when staging found something to deliver — and the
// STERLING DEFAULT RETURN CONTRACT match above goes red.
// Sabotage (shape pin): the fold adds a second top-level or hookSpecificOutput
// field (e.g. a separate `contract` key, or permissionDecision) instead of
// concatenating into the single additionalContext string — either
// Object.keys assertion above goes red.

test('prompt names no repo paths: contract-only, exit 0 (AC5 "undeclared dispatches unchanged" now scoped to the STAGING side)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = writeTranscript(dir, [assistantLine([taskBlock('Please investigate the login flow and report back.')])]);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'non-exempt agent_type still gets the absorbed contract even with a pathless prompt');
    assert.doesNotMatch(ctx, /STERLING KNOWLEDGE DELIVERY/, 'no governed paths named -> no knowledge-staging payload');
    assert.doesNotMatch(ctx, /alpha does the alpha thing/);
  } finally {
    cleanup();
  }
});
// Sabotage: drop the unconditional contract emit (only inject when a governed
// path was found) — the STERLING DEFAULT RETURN CONTRACT match above goes red.

test('prompt names a governed file: payload contains the article, the guard is written, and the contract rides alongside (combined emit)', () => {
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
    assert.match(
      out.hookSpecificOutput.additionalContext,
      /STERLING DEFAULT RETURN CONTRACT/,
      'non-exempt agent_type — the absorbed contract rides alongside the staged payload in the same emit'
    );

    const guard = guardOf(dir, 'agent-1');
    assert.ok(guard, 'guard file written for the spawned agent');
    const alphaId = store.query({ types: ['feature_article'], rank_terms: ['alpha'], cap: 5 }).find((a) => a.slug === 'alpha').id;
    assert.ok(guard.records.includes(alphaId));

    // Re-running the same dispatch: the STAGING guard suppresses re-delivery of
    // the knowledge payload (nothing fresh to stage) — but the contract
    // injection carries NO such guard (h28's own behavior was unconditional,
    // byte-preserved per decision 04982f45), so the second call is
    // contract-only, not silent.
    const again = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript), dir);
    assert.equal(again.code, 0, again.stderr);
    const againOut = JSON.parse(again.stdout);
    const againCtx = againOut.hookSpecificOutput.additionalContext;
    assert.match(againCtx, /STERLING DEFAULT RETURN CONTRACT/, 'the contract still fires on the second call — it is not gated by the staging guard');
    assert.doesNotMatch(againCtx, /STERLING KNOWLEDGE DELIVERY/, 'guarded — nothing fresh to stage');
    assert.doesNotMatch(againCtx, /alpha does the alpha thing/, 'guarded — the article is not re-delivered');
  } finally {
    cleanup();
  }
});
// Sabotage (coexistence): the fold clobbers one output with the other (e.g.
// `additionalContext = CONTRACT_TEXT` instead of appending onto the staged
// payload) — one of the three assert.match calls on the first response goes
// red. Sabotage (guard scope): the fold reuses the STAGING guard to also
// suppress the contract on repeat calls — the "still fires on the second
// call" assertion goes red.

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

test('malformed transcript (corrupt JSONL): contract-only, never a throw the caller must special-case — staging silently finds nothing', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = join(dir, 'broken.jsonl');
    writeFileSync(transcript, 'not json at all\n{"type":"assistant","message":{"content":[{');
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript), dir);
    assert.notEqual(r.code, 2, 'never denies (AC7 precedent)');
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'a corrupt transcript must not suppress the unconditional contract');
    assert.doesNotMatch(ctx, /STERLING KNOWLEDGE DELIVERY/, 'staging found nothing parseable — no knowledge payload');
  } finally {
    cleanup();
  }
});
// Sabotage: let the transcript parse failure early-return before the
// contract-injection branch runs (instead of only short-circuiting staging)
// — the STERLING DEFAULT RETURN CONTRACT match above goes red.

test('missing transcript_path / nonexistent file: contract-only — staging finds nothing to read', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, join(dir, 'does-not-exist.jsonl')), dir);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'a missing transcript must not suppress the unconditional contract');
    assert.doesNotMatch(ctx, /STERLING KNOWLEDGE DELIVERY/, 'no transcript to read from -> no knowledge payload');
  } finally {
    cleanup();
  }
});
// Sabotage: bail out entirely (no output at all) when transcript_path is
// missing/nonexistent, instead of only skipping the staging half — the
// STERLING DEFAULT RETURN CONTRACT match above goes red.

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

test('not a Sterling project (no store): contract-only — the absorbed injection needs no store', () => {
  const bare = mkdtempSync(join(tmpdir(), 'sterling-h19-stage-bare-'));
  try {
    const transcript = writeTranscript(bare, [assistantLine([taskBlock('work on src/a.mjs')])]);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(bare, transcript), bare);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'the absorbed contract injection does not depend on a Sterling store existing');
    assert.doesNotMatch(ctx, /STERLING KNOWLEDGE DELIVERY/, 'no store -> no knowledge-staging payload');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
// Sabotage: gate the contract injection behind a store-existence check (e.g.
// bail out entirely before the injection when no .sterling store is found)
// — the STERLING DEFAULT RETURN CONTRACT match above goes red.

// ===========================================================================
// H28 ABSORPTION (decision 04982f45 / s7-small-hook-absorption-measured-two-
// fold-two-keep): the STERLING DEFAULT RETURN CONTRACT injection formerly
// lived in its own SubagentStart hook (h28-return-contract.mjs, deleted —
// 68 lines, ~15 of substance) and now fires from THIS hook on the SAME
// SubagentStart event ("clean license pass" per the decision: absorber grows
// ~15-18 lines to delete 68). The pins below are MIGRATED from
// scripts/tests/h28-return-contract.test.mjs verbatim in meaning — only the
// spawned hook path changed (h28-return-contract.mjs -> h19-dispatch-staging.
// mjs). Each points transcript_path at a file that does NOT exist, which
// this file's OWN staging logic already treats as "nothing to stage" (see
// the "missing transcript_path" pin above) — isolating the contract-
// injection assertions from the staging behavior. The staging+contract
// interaction is pinned separately, below, by the combined-emit test.
// ===========================================================================

test('H28 PIN 1 (migrated, control): non-exempt agent_type gets STERLING DEFAULT RETURN CONTRACT injected, exit 0', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(
      'h19-dispatch-staging.mjs',
      subagentStart(dir, join(dir, 'nope.jsonl'), { agent_type: 'reviewer-correctness' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(
      out.hookSpecificOutput.additionalContext,
      /STERLING DEFAULT RETURN CONTRACT/,
      'the literal contract marker must be present for a non-exempt agent'
    );
  } finally {
    cleanup();
  }
});
// Sabotage: comment out / null-out the absorbed additionalContext injection
// (e.g. skip it and only ever return the staging-only output) — the
// literal-string match above goes red.

test('H28 PIN 2 (migrated): exempt agent_type (statusline-setup) is allowed with no injection', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(
      'h19-dispatch-staging.mjs',
      subagentStart(dir, join(dir, 'nope.jsonl'), { agent_type: 'statusline-setup' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(
      r.stdout,
      /STERLING DEFAULT RETURN CONTRACT/,
      'an exempt agent_type must never receive the contract block'
    );
    if (r.stdout.trim()) {
      const out = JSON.parse(r.stdout);
      const ctx = out?.hookSpecificOutput?.additionalContext;
      assert.ok(!ctx || !/STERLING DEFAULT RETURN CONTRACT/.test(ctx), 'no contract text for an exempt agent');
    }
  } finally {
    cleanup();
  }
});
// Sabotage: remove/invert the exemption check so every agent_type (including
// 'statusline-setup') gets the contract injected — this pin goes red.

test('H28 PIN 3a (migrated): empty stdin never blocks (exit != 2), no injection (parse failure)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runRaw('h19-dispatch-staging.mjs', '', dir);
    assert.notEqual(r.code, 2, `empty stdin must never deny a spawn: stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout, /STERLING DEFAULT RETURN CONTRACT/, 'no injection on malformed (unparseable) stdin');
  } finally {
    cleanup();
  }
});

test('H28 PIN 3a (migrated): non-JSON stdin never blocks (exit != 2), no injection (parse failure)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runRaw('h19-dispatch-staging.mjs', 'this is not { json at all', dir);
    assert.notEqual(r.code, 2, `non-JSON stdin must never deny a spawn: stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout, /STERLING DEFAULT RETURN CONTRACT/, 'no injection on malformed (unparseable) stdin');
  } finally {
    cleanup();
  }
});
// Sabotage (both 3a pins): change the parse-failure catch branch to
// process.exit(2) (or otherwise deny the spawn) instead of allowing/warning
// without injecting — the `assert.notEqual(r.code, 2)` line goes red.

test('H28 PIN 3b (migrated): valid JSON stdin missing agent_type never blocks (exit != 2) AND still injects (default-on, not exempt)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const { agent_type, ...withoutType } = subagentStart(dir, join(dir, 'nope.jsonl'));
    const r = runHook('h19-dispatch-staging.mjs', withoutType, dir);
    assert.notEqual(r.code, 2, `missing agent_type must never deny a spawn: stderr=${r.stderr}`);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(
      out.hookSpecificOutput.additionalContext,
      /STERLING DEFAULT RETURN CONTRACT/,
      'undefined agent_type is not in the exempt set — default-on injection still fires'
    );
  } finally {
    cleanup();
  }
});
// Sabotage: treat a missing/undefined agent_type as exempt (suppress
// injection) instead of default-on — the assert.match(... CONTRACT) line
// goes red.

test('H28 PIN 4 (migrated): the injected contract block is self-subordinating (a brief/role contract takes precedence)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(
      'h19-dispatch-staging.mjs',
      subagentStart(dir, join(dir, 'nope.jsonl'), { agent_type: 'coder' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'sanity: this is the injected block');
    assert.match(ctx, /take[s]? precedence/i, 'the block must state that a brief/role contract takes precedence over it');
  } finally {
    cleanup();
  }
});
// Sabotage: reword the injected text to drop the precedence clause (e.g.
// delete "takes precedence over this default" from the block) — the regex
// match above goes red.

// ===========================================================================
// COMBINED-EMIT (new pin, not present in either pre-fold suite): when BOTH
// this hook's own staging output (governed-territory delivery) AND the
// absorbed return-contract injection apply in the same SubagentStart call,
// BOTH must appear in the single additionalContext emitted — the fold must
// not clobber one output with the other.
// ===========================================================================

test('H19+H28 combined-emit: own staging output AND the absorbed return-contract text BOTH appear when both apply', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = writeTranscript(dir, [assistantLine([taskBlock('Go read src/a.mjs and fix the bug there.')])]);
    const r = runHook(
      'h19-dispatch-staging.mjs',
      subagentStart(dir, transcript, { agent_type: 'reviewer-correctness' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING KNOWLEDGE DELIVERY/, 'this file\'s OWN staging output is present');
    assert.match(ctx, /alpha does the alpha thing/, 'the staged governed-territory article is present');
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'the absorbed return-contract text is present in the SAME emit');
  } finally {
    cleanup();
  }
});
// Sabotage: the fold clobbering one output with the other (e.g. the
// return-contract branch does `additionalContext = CONTRACT_TEXT` instead of
// appending/concatenating onto the staging result, or vice versa) flips
// exactly one of the three assert.match calls above red — whichever output
// got overwritten.

// ===========================================================================
// SHARED-FATE (outside-family review finding): the fold put staging and the
// absorbed contract injection in the SAME function on the SAME event. If
// staging throws AFTER stdin has already parsed — not the parse-failure path
// PIN 3a covers, a genuine internal failure mid-staging — an unguarded fold
// lets that exception propagate and swallow the contract too. The two
// concerns must not share a fate: a staging failure should still leave the
// contract emitted. Cheapest reproducible internal failure: a Sterling
// project whose .sterling/config.json is malformed JSON, corrupted AFTER
// project setup so only staging's OWN config read (mid-flight) throws — the
// hook's OWN stdin (the SubagentStart JSON) parses fine.
// ===========================================================================

test('H19+H28 shared-fate: a staging-internal failure after stdin parses still emits the contract', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = writeTranscript(dir, [assistantLine([taskBlock('Go read src/a.mjs and fix the bug there.')])]);
    // corrupt config.json AFTER project setup: this is a staging-INTERNAL
    // failure, distinct from PIN 3a's stdin-parse-failure path.
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not valid json');
    const r = runHook(
      'h19-dispatch-staging.mjs',
      subagentStart(dir, transcript, { agent_type: 'reviewer-correctness' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(
      ctx,
      /STERLING DEFAULT RETURN CONTRACT/,
      'a staging-internal throw (bad config mid-staging) must not swallow the unconditional contract'
    );
    assert.doesNotMatch(ctx, /STERLING KNOWLEDGE DELIVERY/, 'staging itself failed — no knowledge payload');
    assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert.deepEqual(Object.keys(out).sort(), ['hookSpecificOutput'], 'emit shape intact even on the staging-internal failure path');
    assert.deepEqual(
      Object.keys(out.hookSpecificOutput).sort(),
      ['additionalContext', 'hookEventName'],
      'emit shape intact even on the staging-internal failure path'
    );
  } finally {
    cleanup();
  }
});
// Sabotage: removing the catch-path contract emit (letting the staging
// exception propagate uncaught past the whole handler, or catching it but
// forgetting to still emit the contract) flips the STERLING DEFAULT RETURN
// CONTRACT match above red. GREEN AT HEAD — the fold's shared-fate
// regression has been fixed; this arm is kept as a standing regression pin,
// not a today-red spec.

// ===========================================================================
// EXEMPT + APPLICABLE PAYLOAD (outside-family review finding): PIN 2 proves
// an exempt agent_type gets no contract when there is nothing to stage
// either — that alone cannot distinguish "exemption suppresses the contract"
// from "exemption suppresses everything". This arm supplies a governed-file
// dispatch (a real staging payload applies) to an EXEMPT agent_type and
// requires the staging half to still fire.
// ===========================================================================

test('H28 exemption suppresses ONLY the contract, not staging: exempt agent_type still gets the knowledge payload', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = writeTranscript(dir, [assistantLine([taskBlock('Go read src/a.mjs and fix the bug there.')])]);
    const r = runHook(
      'h19-dispatch-staging.mjs',
      subagentStart(dir, transcript, { agent_type: 'statusline-setup' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING KNOWLEDGE DELIVERY/, 'exempt agent_type still gets the staged knowledge payload');
    assert.match(ctx, /alpha does the alpha thing/, 'the governed article is still staged for an exempt agent');
    assert.doesNotMatch(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'exempt agent_type suppresses ONLY the contract, never staging');
  } finally {
    cleanup();
  }
});
// Sabotage: an exemption check that early-returns before staging runs at all
// (instead of only skipping the contract-injection branch) flips the
// STERLING KNOWLEDGE DELIVERY / alpha match above red.

// ===========================================================================
// TDD/MUTATION-VERIFICATION POSTURE LINE (slice 3C, board 7e7279c4,
// objective dome-farmer-issues-2026-09-05). SPEC-ONLY, blind to the coder's
// parallel implementation.
//
// Governing knowledge: decision 752caf98 (tdd-and-mutation-toggles-in-
// system-tab); decision 466ac94f (H25 is warn-only — the same
// never-a-gate posture the toggle checks extend, though this hook is H19,
// not H25). Board 7e7279c4's fix shape item (3): H19's combinedContext()
// pushes the SAME one-line posture (see scripts/tests/h1-tdd-posture-line.
// test.mjs for the exact string) into `coder` and `test-writer` dispatch
// context, so the SPAWNED agent reads live config rather than a template
// copy. This is independent of the STAGING half (governed-file delivery) —
// it is keyed off the SPAWNED agent's OWN `agent_type` field on stdin, not
// off anything found in the parent transcript, so a transcript with no
// Task/Agent block (contract-only) still carries the posture line for a
// coder/test-writer spawn.
//
// CURRENT STATE: h19-dispatch-staging.mjs now reads config.tdd /
// config.mutation_verification and injects the posture line for coder/
// test-writer dispatches; the tests below are green at HEAD and prove the
// gating (not merely that the string once failed to appear). The ABSENCE
// test (reviewer-correctness) is a genuine negative pin: the posture line is
// scoped away from that dispatch class, not silent because nothing exists.
// ===========================================================================

const POSTURE_SUFFIX =
  '(config.tdd.enabled / config.mutation_verification.enabled — TUI System tab; explicit asks still work)';

function postureLine(tddOn, mutOn) {
  return `TDD posture: tests-first ${tddOn ? 'ON' : 'OFF'} · mutation verification ${mutOn ? 'ON' : 'OFF'} ${POSTURE_SUFFIX}`;
}

test('posture line (OFF/OFF) is injected into a CODER dispatch context, contract-only transcript', () => {
  const { dir, cleanup } = makeProject({ tdd: { enabled: false }, mutation_verification: { enabled: false } });
  try {
    const transcript = writeTranscript(dir, [assistantLine([{ type: 'text', text: 'no dispatch here' }])]);
    const r = runHook(
      'h19-dispatch-staging.mjs',
      subagentStart(dir, transcript, { agent_type: 'coder' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes(postureLine(false, false)),
      `expected the OFF/OFF posture line verbatim in a coder dispatch's context; got: ${ctx}`
    );
  } finally {
    cleanup();
  }
});
// Sabotage: drop 'coder' from the set of agent_types that receive the
// posture line (leave only 'test-writer') — this test goes red.

test('posture line (ON/ON, config-driven not hardcoded) is injected into a TEST-WRITER dispatch context', () => {
  const { dir, cleanup } = makeProject({ tdd: { enabled: true }, mutation_verification: { enabled: true } });
  try {
    const transcript = writeTranscript(dir, [assistantLine([{ type: 'text', text: 'no dispatch here' }])]);
    const r = runHook(
      'h19-dispatch-staging.mjs',
      subagentStart(dir, transcript, { agent_type: 'test-writer' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes(postureLine(true, true)),
      `expected the ON/ON posture line verbatim in a test-writer dispatch's context; got: ${ctx}`
    );
    assert.ok(
      !ctx.includes(postureLine(false, false)),
      'must not print the OFF/OFF line when config says ON/ON (rules out a hardcoded string)'
    );
  } finally {
    cleanup();
  }
});
// Sabotage: hardcode the injected posture line (e.g. always OFF/OFF, a copy-
// pasted literal instead of a live config read) — the first assert.ok goes
// red (the ON/ON line is never found).

test('posture line ABSENT for a dispatch class where it does not apply (reviewer-correctness)', () => {
  const { dir, cleanup } = makeProject({ tdd: { enabled: false }, mutation_verification: { enabled: false } });
  try {
    const transcript = writeTranscript(dir, [assistantLine([{ type: 'text', text: 'no dispatch here' }])]);
    const r = runHook(
      'h19-dispatch-staging.mjs',
      subagentStart(dir, transcript, { agent_type: 'reviewer-correctness' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'sanity: the unrelated contract injection still fires for this class');
    assert.doesNotMatch(
      ctx,
      /TDD posture:/,
      'the posture line is scoped to coder/test-writer dispatches only, never a reviewer'
    );
  } finally {
    cleanup();
  }
});
// Sabotage: widen the posture-line injection to fire for every non-exempt
// agent_type (instead of only 'coder'/'test-writer') — the doesNotMatch
// assertion above goes red.

// ===========================================================================
// COVERAGE GAP (external review): every H19 posture arm above uses explicit
// `true`/`false` for both keys, so H19 had NO absent-key pin at all — a
// sabotage inverting the absent-key default (e.g. reading
// `cfg?.tdd?.enabled === true` instead of defaulting via `?? true`) would
// pass every existing H19 arm. The two tests below isolate each key's
// absent-default independently.
// ===========================================================================

test('GAP: config has NO tdd key at all (mutation_verification explicit false) -> tdd half still defaults ON', () => {
  const { dir, cleanup } = makeProject({ mutation_verification: { enabled: false } });
  try {
    const transcript = writeTranscript(dir, [assistantLine([{ type: 'text', text: 'no dispatch here' }])]);
    const r = runHook(
      'h19-dispatch-staging.mjs',
      subagentStart(dir, transcript, { agent_type: 'coder' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes(postureLine(true, false)),
      `expected "tests-first ON" (absent tdd key defaults ON) alongside the explicit "mutation verification OFF"; got: ${ctx}`
    );
  } finally {
    cleanup();
  }
});
// Named sabotage (verbatim from review): read the tdd flag as `cfg?.tdd?.
// enabled === true` instead of `cfg?.tdd?.enabled ?? true` — an absent key
// is `undefined`, and `undefined === true` is false, so the line would
// wrongly read "tests-first OFF" instead of "ON". This test goes red.

test('GAP: config has NO mutation_verification key at all (tdd explicit false) -> mutation half still defaults ON', () => {
  const { dir, cleanup } = makeProject({ tdd: { enabled: false } });
  try {
    const transcript = writeTranscript(dir, [assistantLine([{ type: 'text', text: 'no dispatch here' }])]);
    const r = runHook(
      'h19-dispatch-staging.mjs',
      subagentStart(dir, transcript, { agent_type: 'test-writer' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes(postureLine(false, true)),
      `expected "mutation verification ON" (absent key defaults ON) alongside the explicit "tests-first OFF"; got: ${ctx}`
    );
  } finally {
    cleanup();
  }
});
// Named sabotage (verbatim from review, same class applied to the other
// key): read the mutation_verification flag as `cfg?.mutation_verification?.
// enabled === true` instead of defaulting via `?? true` for an absent key —
// this test goes red (the line would wrongly read "mutation verification
// OFF" instead of "ON").

// ===========================================================================
// COVERAGE GAP (external review, same battery as scripts/tests/
// h1-tdd-posture-line.test.mjs GAP 5/6): H19 renders the SAME one-line TDD/
// mutation posture into a coder/test-writer dispatch context that H1 renders
// at SessionStart for an unreadable or JSON-legal-but-non-object config —
// H1's own suite pins that case must render "TDD posture: UNKNOWN" and never
// a confident ON/OFF, because in THIS repo both toggles are actually OFF, so
// a fallback ON/ON would state the exact opposite of the truth. H19 had
// ZERO arms for this case. The one corrupt-config arm already in this file
// (the H19+H28 shared-fate test above) spawns with
// agent_type: 'reviewer-correctness' — precisely the dispatch class that
// receives NO posture line at all — so it proves nothing about this axis.
//
// Both currently-reachable wrong outcomes are bad: H19 could render a
// confident "tests-first ON · mutation verification ON" to a spawned coder
// while H1's own banner says UNKNOWN for the identical corrupt config (a
// false posture, and a DIVERGENT one between the conductor and its own
// subagent reading the same project) — or H19 could drop the line silently
// while H1 says UNKNOWN, a quieter but still real divergence.
//
// A coder is fixing the implementation in parallel and has been told it MAY
// legitimately choose to SUPPRESS the line for H19 instead of rendering
// UNKNOWN, provided it discloses that choice and records the divergence from
// H1. So the arms below pin the ANTI-DEFECT FIRST AND FOREMOST — no
// confident tests-first ON/OFF text for a non-object config — which holds
// regardless of which of the two legitimate choices the coder made. The
// positive half (which of UNKNOWN-vs-absent) is pinned only as an explicit
// disjunction, flagged for tightening once the coder's actual choice is
// known — the same discipline this dispatch already applied to
// scripts/tests/delivery-oracle.mjs's expected_reason arms rather than
// guessing.
// ===========================================================================

test('GAP: config UNPARSEABLE for a CODER dispatch -> no confident tests-first ON/OFF text (the anti-defect, pinned first)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = writeTranscript(dir, [assistantLine([{ type: 'text', text: 'no dispatch here' }])]);
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not valid json');
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript, { agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(
      ctx,
      /tests-first (ON|OFF)/,
      'an unreadable config must never render a confident ON/OFF posture to a spawned coder — in THIS repo both toggles are actually OFF, so a fallback ON/ON would state the exact opposite of the truth'
    );
  } finally {
    cleanup();
  }
});
// Named sabotage: remove the whole-config shape guard from H19's posture
// block (let a parse failure fall through to the same default-ON path used
// for a genuinely absent file) — a confident "tests-first ON · mutation
// verification ON" appears and this test goes red.

test('GAP: config JSON-legal but NOT AN OBJECT ([]) for a CODER dispatch -> no confident tests-first ON/OFF text (the anti-defect, pinned first)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = writeTranscript(dir, [assistantLine([{ type: 'text', text: 'no dispatch here' }])]);
    writeFileSync(join(dir, '.sterling', 'config.json'), '[]');
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript, { agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(
      ctx,
      /tests-first (ON|OFF)/,
      'a JSON-legal but non-object config (here: an array) must not fall through optional-chaining (config?.tdd?.enabled) to a confident ON/OFF default'
    );
  } finally {
    cleanup();
  }
});
// Named sabotage: same as above — dropping the whole-config shape guard lets
// `config?.tdd?.enabled` optional-chain through the non-object straight to
// `undefined`, and the `?? true` default renders a confident ON/ON; this
// test goes red.

// Copied VERBATIM from scripts/tests/h1-tdd-posture-line.test.mjs:298, which
// already pins H1's exact line for this same unusable-config case — H19 is
// deliberately matching H1's wording (see the disclosure note above), so the
// two suites assert the identical full sentence rather than each trusting a
// looser prefix-only match of the other.
const UNKNOWN_POSTURE_LINE =
  'TDD posture: UNKNOWN — the project config could not be read, so neither config.tdd.enabled nor config.mutation_verification.enabled could be determined. This is NOT the default posture: repair the config, or state your posture explicitly.';

test('GAP (positive half, TIGHTENED): an UNPARSEABLE config for a CODER dispatch renders the TDD posture: UNKNOWN line H1 uses', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = writeTranscript(dir, [assistantLine([{ type: 'text', text: 'no dispatch here' }])]);
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not valid json');
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript, { agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes(UNKNOWN_POSTURE_LINE),
      `expected the FULL UNKNOWN posture sentence including its remedy clause (matching H1) for an unparseable config; got: ${ctx}`
    );
  } finally {
    cleanup();
  }
});
// Named sabotage: change the unusable-config branch to omit the posture line
// entirely, render any confident ON/OFF, or render a truncated/reworded
// UNKNOWN line missing the remedy clause — this test goes red.

test('GAP (positive half, TIGHTENED): a NON-OBJECT ([]) config for a CODER dispatch renders the TDD posture: UNKNOWN line H1 uses', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const transcript = writeTranscript(dir, [assistantLine([{ type: 'text', text: 'no dispatch here' }])]);
    writeFileSync(join(dir, '.sterling', 'config.json'), '[]');
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript, { agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes(UNKNOWN_POSTURE_LINE),
      `expected the FULL UNKNOWN posture sentence including its remedy clause (matching H1) for a non-object config; got: ${ctx}`
    );
  } finally {
    cleanup();
  }
});
// Named sabotage: same as the unparseable-config positive-half arm above —
// change the non-object-config branch to omit the posture line entirely,
// render any confident ON/OFF, or render a truncated/reworded UNKNOWN line
// missing the remedy clause.

// ---------------------------------------------------------------------------
// RANKED DECISION POINTERS IN DISPATCH STAGING (conductor follow-up, mirrors
// scripts/tests/h19-delivery.test.mjs "H19 (rank PIN 1)"). Staging a coder
// dispatch's governed-file pointers must rank candidate decisions the SAME
// way file-touch delivery does — h19-dispatch-staging.mjs:248 is expected to
// call the SAME rankFileDecisionPointers used at the birth point in
// h19-knowledge-delivery.mjs, not re-derive its own order.
// ---------------------------------------------------------------------------

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

test('rank: a standing-authority decision stages among a coder dispatch\'s pointers ahead of ten same-recency unstated decisions (mirrors h19-delivery rank PIN 1)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const RECENT = '2026-09-05T12:00:00.000Z';
    for (let i = 0; i < 10; i += 1) {
      store.create(decisionRecord(`recent choice ${i}`, ['src/a.mjs'], { updated_at: RECENT }));
    }
    // No authority field at all -> rung 1 (unstated), dated far NEWER than
    // the standing ruling below — a recency-only staging order would evict it.
    store.create(decisionRecord('the old standing ruling', ['src/a.mjs'], { authority: 'standing', updated_at: '2026-01-01T00:00:00.000Z' }));

    const transcript = writeTranscript(dir, [assistantLine([taskBlock('Go read src/a.mjs and fix the bug there.')])]);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript, { agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(
      ctx,
      /the old standing ruling/,
      'the standing ruling — despite being dated over eight months OLDER than every rival — must be staged among the dispatch\'s pointers, matching h19-delivery rank PIN 1'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: dropping rankFileDecisionPointers at h19-dispatch-staging.mjs:248
// (staging its own unranked/differently-ordered decision list instead of the
// shared ranking function) evicts the standing ruling from the capped staged
// set — the `/the old standing ruling/` match above goes red.
