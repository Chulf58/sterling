// H1 SessionStart — the undeclared-source-disclosure CONFIG LADDER
// (board 44ef6838; decision `undeclared-source-disclosure-per-file-coverage-
// live-h1-scan`, knowledge_get b128f79c-043a-45ab-b3cf-125f5d44f234).
//
// This file is a NEW sibling, not an extension of h1-accuracy.test.mjs: that
// file governs a different concern (uncapped queue counts, the delegation
// ceiling literal). This one owns exactly one concern — the config-ladder
// refinement in scripts/hooks/h1-session-start.mjs (~:1365-1385) that
// decides, for the undeclared-source section ONLY, whether to render the
// normal bucket report or the bounded UNAVAILABLE line — per the local
// one-file-per-concern convention (h1-objective-count / h1-tmpdir-janitor /
// h1-session-residue are each split the same way).
//
// THE RULING THIS PINS (decision b128f79c, "abnormal shapes render, never
// vanish"): on git absent / timeout / output cap / UNPARSEABLE CONFIG, H1
// prints one bounded 'UNDECLARED SOURCE CHECK UNAVAILABLE: <reason>' line
// and exits 0. Malformed config is UNAVAILABLE, NEVER "zero toolchains" —
// a project that VALIDLY configures zero toolchains (parseable config,
// toolchains: [] deliberately) discloses everything as uncovered (the pure
// module's own edge pin, scripts/tests/undeclared-source.test.mjs); a
// project whose config could not be READ AT ALL must never be silently
// treated as that same "zero toolchains" case, because that would flood
// every directory as a finding from a config problem, not a real gap.
//
// Pins (a)-(g) below were named by the roster review (MED-4) against a
// shipped-but-unpinned config-ladder refinement:
//   (a) config file missing entirely -> UNAVAILABLE
//   (b) config.json present but invalid JSON -> UNAVAILABLE
//   (c) toolchains present but not an array -> UNAVAILABLE
//   (d) a toolchain ENTRY that is not an object, or whose path_globs is not
//       an array of strings -> UNAVAILABLE — EXPECTED RED: the review found
//       H1's per-entry validation does not yet reject these shapes, so (d1)
//       and (d2) are expected to FAIL until the coder closes that gap.
//   (e) undeclared_source_exclude_globs ABSENT -> treated as [] (normal
//       rendering, no UNAVAILABLE line)
//   (f) undeclared_source_exclude_globs present but the WRONG TYPE ->
//       UNAVAILABLE
//   (g) isolation: when the section's own scan fails, the REST of the H1
//       banner (task-count clause, systemMessage) still renders and the
//       hook still exits 0 — one section's failure never takes down the rest.
//
// Every test here is EXPECTED RED against the current H1 except where noted,
// because the config-ladder refinement was shipped without these pins.

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
const NOW = '2026-08-31T12:00:00.000Z';

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

// A minimally valid config: one toolchain covering src/**, plus the caps
// block H1 needs elsewhere so unrelated sections don't warn/misbehave and
// pollute these assertions (mirrors h1-accuracy.test.mjs's BASE_CONFIG).
function validConfig(overrides = {}) {
  return JSON.stringify({
    toolchains: [{ adapter: 'node', path_globs: ['src/**'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } }],
    caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
    ...overrides,
  });
}

/** git init + stage files, so `git ls-files` (what H1's live scan spawns) has
 *  a deterministic tracked-file list without needing a commit. */
function initGitWithFiles(dir, files) {
  const initR = spawnSync('git', ['init', '--initial-branch=main'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  assert.equal(initR.status, 0, `fixture setup: git init failed: ${initR.stderr}`);
  for (const f of files) {
    const full = join(dir, f);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, '// fixture source\n');
  }
  const addR = spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  assert.equal(addR.status, 0, `fixture setup: git add failed: ${addR.stderr}`);
}

function makeProject({ configContent = validConfig(), writeConfig = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1usc-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  if (writeConfig) writeFileSync(join(dir, '.sterling', 'config.json'), configContent);
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

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

/** Combined banner text — deliberately NOT scoped to one field, since exactly
 *  which H1 field carries the undeclared-source line is an implementation
 *  detail this file does not pin; only the line's PRESENCE is pinned. */
function bannerText(res) {
  return `${res.out && res.out.systemMessage ? res.out.systemMessage : ''}\n${additionalContext(res) ?? ''}`;
}

// =========================================================================
// (a) config file missing entirely
// =========================================================================

test('(a) config.json missing entirely -> UNDECLARED SOURCE CHECK UNAVAILABLE, hook still exits 0', () => {
  const { dir, cleanup } = makeProject({ writeConfig: false });
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 even with no config.json at all (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must still emit parseable JSON');
    assert.match(
      bannerText(r),
      /UNDECLARED SOURCE CHECK UNAVAILABLE/,
      'a missing config file must render the unavailable line — never silently treated as "zero toolchains", which would flood every directory as a finding'
    );
  } finally {
    cleanup();
  }
  // sabotage: treat a missing config file as an empty toolchains array (fall through to the "everything uncovered" render) -> the UNAVAILABLE match fails -> red
});

// =========================================================================
// (b) invalid JSON
// =========================================================================

test('(b) config.json present but not valid JSON -> UNAVAILABLE', () => {
  const { dir, cleanup } = makeProject({ configContent: '{ this is not json,,, ' });
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 on unparseable config (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must still emit parseable JSON on its own output, even though the PROJECT config failed to parse');
    assert.match(bannerText(r), /UNDECLARED SOURCE CHECK UNAVAILABLE/, 'unparseable config renders the unavailable line for this section');
  } finally {
    cleanup();
  }
  // sabotage: swallow the JSON.parse error and default to toolchains:[] silently -> UNAVAILABLE match fails -> red
});

// =========================================================================
// (c) toolchains present but not an array
// =========================================================================

test('(c) config.toolchains is present but not an array -> UNAVAILABLE', () => {
  const { dir, cleanup } = makeProject({ configContent: validConfig({ toolchains: 'not-an-array' }) });
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0: ${r.stderr}`);
    assert.ok(r.out);
    assert.match(bannerText(r), /UNDECLARED SOURCE CHECK UNAVAILABLE/, 'a non-array toolchains value is malformed config, not "zero toolchains"');
  } finally {
    cleanup();
  }
  // sabotage: coerce a non-array toolchains value to [] instead of refusing it -> UNAVAILABLE match fails -> red
});

// =========================================================================
// (d) malformed toolchain ENTRY — MEASURED RED (per-entry validation gap:
// the shipped ladder was read and confirmed to absorb malformed entries
// rather than refusing them; verified live, not predicted from the review
// comment alone). Both fixtures below git-init and stage a real participating
// source file so the git arm of the ladder SUCCEEDS — the no-work-tree/no-git
// branch is unreachable here, so UNAVAILABLE (if it renders) can only come
// from per-entry config validation, not from git having nothing to answer.
// Without this, (d1)/(d2) were measured GREEN for the wrong reason: the
// no-git-work-tree fallback rendered UNAVAILABLE regardless of what the
// malformed entry actually was.
// =========================================================================

test('(d1) MEASURED RED: a toolchain entry that is not an object -> UNAVAILABLE (per-entry validation gap, confirmed by reading the shipped ladder)', () => {
  const { dir, cleanup } = makeProject({ configContent: validConfig({ toolchains: ['not-an-object'] }) });
  try {
    initGitWithFiles(dir, ['src/participating.ts']); // git arm succeeds — nothing left to make UNAVAILABLE true except entry validation
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0: ${r.stderr}`);
    assert.ok(r.out);
    assert.match(
      bannerText(r),
      /UNDECLARED SOURCE CHECK UNAVAILABLE/,
      'a non-object toolchain entry must refuse the whole ladder as UNAVAILABLE — MEASURED RED today: the shipped ladder validates the array shape but absorbs a malformed entry instead of refusing it'
    );
  } finally {
    cleanup();
  }
  // sabotage (for when this is fixed): skip/ignore a malformed entry instead of refusing -> UNAVAILABLE match fails -> stays red for the wrong reason, which is exactly today's gap
});

test('(d2) MEASURED RED: a toolchain entry whose path_globs is not an array of strings -> UNAVAILABLE (per-entry validation gap, confirmed by reading the shipped ladder)', () => {
  const { dir, cleanup } = makeProject({
    configContent: validConfig({
      toolchains: [{ adapter: 'node', path_globs: 'src/**', test_globs: ['tests/**'], run_commands: { test: 'node --test' } }],
    }),
  });
  try {
    initGitWithFiles(dir, ['src/participating.ts']); // git arm succeeds — isolates the failure to entry validation
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0: ${r.stderr}`);
    assert.ok(r.out);
    assert.match(
      bannerText(r),
      /UNDECLARED SOURCE CHECK UNAVAILABLE/,
      'path_globs as a bare string (not an array) is malformed — MEASURED RED today: this per-entry field shape is not yet validated by the shipped ladder'
    );
  } finally {
    cleanup();
  }
  // sabotage (for when this is fixed): iterate a string path_globs value character-by-character as if it were an array of one-char globs (a real JS footgun) instead of refusing -> UNAVAILABLE match fails -> stays red for the wrong reason
});

// =========================================================================
// (h) NON-OBJECT root config — a bare array is valid JSON, not null, and not
// an object. Final-pass review (cited alongside decision b128f79c) + gap
// analysis of the shipped ladder: it checks `config === null` and per-entry
// shapes, but never the root value's own type, so a root `[]` currently
// falls through instead of being refused. Same discrimination discipline as
// the fixed (d1)/(d2): git-init + stage a participating source file so the
// git arm succeeds and the ONLY reachable UNAVAILABLE branch is root-shape
// validation. MEASURED RED today per the final-pass review; the conductor
// verifies (this agent cannot run tests).
// =========================================================================

test('(h) MEASURED RED: config.json is a bare array ([]) — valid JSON, not null, not an object — must render UNAVAILABLE, never a flood of uncovered files', () => {
  const { dir, cleanup } = makeProject({ configContent: '[]' });
  try {
    initGitWithFiles(dir, ['src/participating.ts']); // git arm succeeds — isolates the failure to root-shape validation
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0: ${r.stderr}`);
    assert.ok(r.out);
    assert.match(
      bannerText(r),
      /UNDECLARED SOURCE CHECK UNAVAILABLE/,
      'a bare-array root config is malformed — MEASURED RED today: the shared ladder checks config === null and per-entry shapes but not the root value\'s own type, so this falls through instead of refusing'
    );
  } finally {
    cleanup();
  }
  // sabotage (for when this is fixed): treat a non-null, non-array-check root value as "no toolchains configured" (fall through to the empty-toolchains render) instead of refusing it as malformed -> UNAVAILABLE match fails -> stays red for the wrong reason, which is exactly today's gap
});

// =========================================================================
// (e) undeclared_source_exclude_globs absent -> treated as []
// =========================================================================

test('(e) undeclared_source_exclude_globs absent from config -> treated as [], section renders normally (no UNAVAILABLE line)', () => {
  const { dir, cleanup } = makeProject({ configContent: validConfig() }); // no undeclared_source_exclude_globs key at all
  try {
    initGitWithFiles(dir, ['tools/orphan.py']); // uncovered: no toolchain path_globs match tools/**
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0: ${r.stderr}`);
    assert.ok(r.out);
    const text = bannerText(r);
    assert.doesNotMatch(text, /UNDECLARED SOURCE CHECK UNAVAILABLE/, 'an absent exclude-globs key is valid config (defaults to []), not a malformed one');
    assert.match(text, /tools/, 'the normal bucket report still names the uncovered tools/ directory');
  } finally {
    cleanup();
  }
  // sabotage: treat an absent undeclared_source_exclude_globs key as malformed config (refuse into UNAVAILABLE) instead of defaulting to [] -> doesNotMatch fails -> red
});

// =========================================================================
// (f) undeclared_source_exclude_globs present but wrong type
// =========================================================================

test('(f) undeclared_source_exclude_globs present but the wrong type (a string, not an array) -> UNAVAILABLE', () => {
  const { dir, cleanup } = makeProject({ configContent: validConfig({ undeclared_source_exclude_globs: 'src/vendor/**' }) });
  try {
    initGitWithFiles(dir, ['tools/orphan.py']);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0: ${r.stderr}`);
    assert.ok(r.out);
    assert.match(bannerText(r), /UNDECLARED SOURCE CHECK UNAVAILABLE/, 'a non-array exclude-globs value is malformed config for this section, not silently ignored or silently used as a single-glob array');
  } finally {
    cleanup();
  }
  // sabotage: coerce a bare string exclude-globs value into a one-element array ([value]) instead of refusing it -> UNAVAILABLE match fails -> red
});

// =========================================================================
// (i) an exclude-globs ELEMENT that is not a string (e.g. a bare array
// containing a number). Final-pass review (decision b128f79c) + gap
// analysis: today this throws INSIDE glob matching and lands on UNAVAILABLE
// by accident, with whatever generic reason the catch-all produces — the
// marker is real (GREEN today) but the specific reason text is not a
// contract this pin should lock in. Pin only the marker, not the reason.
// =========================================================================

test('(i) an exclude-globs element that is not a string (e.g. [42]) -> UNAVAILABLE (marker only pinned, not the accidental reason text)', () => {
  const { dir, cleanup } = makeProject({ configContent: validConfig({ undeclared_source_exclude_globs: [42] }) });
  try {
    initGitWithFiles(dir, ['tools/orphan.py']);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0: ${r.stderr}`);
    assert.ok(r.out);
    assert.match(
      bannerText(r),
      /UNDECLARED SOURCE CHECK UNAVAILABLE/,
      'a non-string exclude-globs element must render the unavailable marker — GREEN today (it throws inside glob matching and lands here), but the reason text is not pinned since today it is accidental, not a designed message'
    );
  } finally {
    cleanup();
  }
  // sabotage: catch the glob-matching throw and silently skip only the bad element (continuing with the rest of exclude_globs) instead of refusing the whole section -> UNAVAILABLE match fails -> red
});

// =========================================================================
// (g) isolation: the rest of the H1 banner survives this section's failure
// =========================================================================

test('(g) isolation: when the undeclared-source scan fails (malformed toolchains), the REST of the H1 banner still renders and the hook still exits 0', () => {
  const { dir, store, cleanup } = makeProject({ configContent: validConfig({ toolchains: 'not-an-array' }) });
  try {
    store.create({ ...envelope('todo'), text: 'a standalone task', source: 'user' });
    store.create({ ...envelope('todo'), text: 'another standalone task', source: 'user' });

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 even though one section failed: ${r.stderr}`);
    assert.ok(r.out, 'H1 must still emit parseable JSON');
    assert.equal(typeof r.out.systemMessage, 'string', 'H1 still emits a systemMessage banner');
    assert.match(r.out.systemMessage, /\b2 task/, 'the task-count clause still reports normally — one section failing must not take the rest of the banner down with it');
    assert.match(bannerText(r), /UNDECLARED SOURCE CHECK UNAVAILABLE/, 'the failed section still discloses its own failure rather than silently vanishing');
  } finally {
    cleanup();
  }
  // sabotage: let the undeclared-source section's thrown/caught error propagate uncaught instead of being isolated -> H1 exits non-zero or emits unparseable stdout -> both assert.equal(r.code, 0) and assert.ok(r.out) fail -> red
});
