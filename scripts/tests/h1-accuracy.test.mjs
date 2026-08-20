// H1 SessionStart — session-start ACCURACY (board 18a22b56).
//
// Spec under test (given by the launching agent, not inferred from implementation).
// Two independently-reported defects from the 2026-08-14→20 feedback batch:
//
//   AC1 (uncapped counts): H1's queue-depth summary (the deep-queue signal,
//   decision 44e45931/e23f38f8 — additionalContext names the drainable maintenance
//   count once config.maintenance_queue.deep_threshold is met) was built from a
//   CAPPED read: with 250 system maintenance items seeded (well above any plausible
//   default query cap), the true total (250) must appear verbatim in H1's
//   additionalContext. A capped implementation reports some smaller number instead
//   (the historical instance under-reported 60 against a true 102) — this test pins
//   the EXACT total, not "some number", so a capped read cannot pass by coincidence.
//
//   AC2 (config-driven ceiling): the delegation-conventions text H1 injects
//   (the "N concurrent subagents is a CEILING" conductor-contract bullet) must derive
//   its concurrent-subagent ceiling from config.delegation.max_concurrent rather than
//   a hardcoded literal. With the fixture config setting 15, the injected text must
//   say 15 near the "concurrent" mention and must never say "five"/"FIVE" or a bare
//   5 there. With the delegation config section entirely absent, the shipped default
//   (5) must appear instead. This exact contradiction (5 injected after the user
//   ruled 15) recurred on this machine 2026-08-20 — decision
//   concurrent-subagent-ceiling-raised-to-15-on-this-machine-use.
//
//   AC3 (regression smoke): whatever the EXISTING h1 tests
//   (h1-session-residue.test.mjs, h1-objective-count.test.mjs) pin about H1's
//   banner/injection behavior must keep working when a config carrying
//   delegation.max_concurrent is present — this file does not duplicate those
//   assertions, it only proves the new config block does not break H1's normal
//   output shape (parseable JSON, a systemMessage banner, the task-count clause).
//
// This file follows scripts/tests/h1-session-residue.test.mjs's harness style
// (runHook / hookInput / envelope / makeProject / h1) so it runs in isolation. H1
// does not have the uncapped-count fix or the config-driven ceiling yet — every
// test below is expected to FAIL against the current H1.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

function envelope(type, at = NOW) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

// Base toolchain/caps config every fixture project needs — mirrors the sibling h1
// test files' CONFIG so H1's other guarded reads (context_watch, caps) don't warn
// or misbehave and pollute the assertions below.
const BASE_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
};

function makeProject(configOverride = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1acc-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const config = { ...BASE_CONFIG, ...configOverride };
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

// --------------------------- H1 invocation ---------------------------

function h1(dir, source = 'startup', envOverride = {}) {
  const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart', source }), dir, {
    NO_COLOR: '1',
    STERLING_NO_BANNER: '1',
    STERLING_PLUGIN_ROOT: root,
    ...envOverride,
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // caller asserts
  }
  return { ...r, out };
}

function additionalContext(res) {
  return res.out && res.out.hookSpecificOutput ? res.out.hookSpecificOutput.additionalContext : undefined;
}

/** The window of text around a "concurrent" mention — where the delegation-conventions
 *  ceiling number lives, per the conductor-contract bullet ("N concurrent subagents is
 *  a CEILING, not a target"). Scoping the assertion to this window (rather than the
 *  whole context blob) avoids false matches on unrelated digits elsewhere in H1's output. */
function delegationClause(text) {
  if (!text) return '';
  const idx = text.search(/concurrent/i);
  if (idx === -1) return '';
  return text.slice(Math.max(0, idx - 80), idx + 80);
}

// --------------------------- board/maintenance fixtures ---------------------------

const maintenanceItem = (store, text, over = {}) =>
  store.create({ ...envelope('todo'), text, source: 'system', system_reason: 'reconcile_needed', author: 'system', ...over });

// --------------------------- tests ---------------------------

test('AC1: 250 system maintenance items across lanes — H1 reports the TRUE total (250), not a capped number', () => {
  const { dir, store, cleanup } = makeProject({ maintenance_queue: { deep_threshold: 15 } });
  try {
    // spread across multiple registered system_reason lanes, well above any plausible
    // default query/read cap (25, 50, 60, 100 are all common cap literals in this repo)
    for (let i = 0; i < 100; i++) maintenanceItem(store, `reconcile article ${i}`, { system_reason: 'reconcile_needed' });
    for (let i = 0; i < 100; i++) maintenanceItem(store, `stale research ${i}`, { system_reason: 'stale_research' });
    for (let i = 0; i < 50; i++) maintenanceItem(store, `article missing ${i}`, { system_reason: 'article_missing' });

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');

    const ctx = additionalContext(r) ?? '';
    assert.match(ctx, /\b250\b/, 'the TRUE total (250) appears verbatim in the deep-queue signal — an under-reported (capped) total would not contain this exact number');
    // guard against the specific, plausible capped-read regression: a default read
    // cap of 100 (used elsewhere in this codebase, e.g. captureOwedItems' cap:100
    // convention) silently truncating the true 250 down to 100
    assert.doesNotMatch(ctx, /\b100\b(?!\s*items? in lane)/, 'the total is not silently truncated to a common default cap of 100');
  } finally {
    cleanup();
  }
});

test('AC2: with config.delegation.max_concurrent = 15, the injected delegation-conventions ceiling says 15 and never "five"/5', () => {
  const { dir, cleanup } = makeProject({ delegation: { max_concurrent: 15 } });
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');

    const ctx = additionalContext(r) ?? '';
    const clause = delegationClause(ctx);
    assert.notEqual(clause, '', 'the delegation-conventions text (mentioning "concurrent") is injected into additionalContext');
    assert.match(clause, /15/, 'the ceiling reflects config.delegation.max_concurrent (15), not a hardcoded literal');
    assert.doesNotMatch(clause, /\bfive\b/i, 'the stale hardcoded wording "five concurrent" must not appear once config sets 15');
    assert.doesNotMatch(clause, /\b5\b/, 'the stale hardcoded ceiling of 5 must not appear once config sets 15 (this exact contradiction recurred 2026-08-20)');
  } finally {
    cleanup();
  }
});

test('AC2: with config.delegation entirely absent, the shipped default ceiling (5) appears', () => {
  const { dir, cleanup } = makeProject(); // no `delegation` key at all
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');

    const ctx = additionalContext(r) ?? '';
    const clause = delegationClause(ctx);
    assert.notEqual(clause, '', 'the delegation-conventions text (mentioning "concurrent") is injected even with no delegation config block');
    assert.match(clause, /\b5\b|\bfive\b/i, 'the shipped default ceiling (5) is used when config.delegation is absent');
  } finally {
    cleanup();
  }
});

test('AC3 (regression smoke): H1 still emits its normal sections with a config carrying delegation.max_concurrent', () => {
  const { dir, store, cleanup } = makeProject({ delegation: { max_concurrent: 8 } });
  try {
    store.create({ ...envelope('todo'), text: 'a standalone task', source: 'user' });
    store.create({ ...envelope('todo'), text: 'another standalone task', source: 'user' });

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 still emits parseable JSON with a delegation config block present');
    assert.equal(typeof r.out.systemMessage, 'string', 'H1 still emits a systemMessage banner');
    assert.match(r.out.systemMessage, /\b2 task/, 'the task-count clause still reports the open task total normally');
  } finally {
    cleanup();
  }
});
