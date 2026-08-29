// H1 SessionStart — AGENT CURRENCY detection where agents are CONSUMED (fix (a)).
//
// SPEC ONLY. Nothing in scripts/hooks/h1-session-start.mjs, scripts/lib/*.mjs or
// scripts/sync-agents.mjs was read to author this file (H4 read wall). The
// contract below comes from board 6ce18724, research_finding 0038af7c (the
// measurement), decision 946125ff + anti_pattern 02a1ed39 (the three-seam
// precedent this copies), decision 558895a9 (the CLONE-currency signal that is
// explicitly NOT this) and the launching agent's user-ruled shape. The harness
// (runHook / hookInput / envelope / makeProject / h1) is copied from
// scripts/tests/h1-accuracy.test.mjs; the agent fixtures and the installAgents /
// renderInstalledAgent usage from scripts/tests/agent-distribution.test.mjs.
//
// THE DEFECT BEING CLOSED: /sterling:update's agent sync only visits projects in
// the shared project registry, so a project absent from it keeps its installed
// agents frozen at install date forever while its clone updates perfectly
// (measured: two projects 43 and 80 days stale, both `stale` and NOT `modified`,
// never refused — never VISITED). H1 already reads the project at SessionStart,
// so the detection lands where the failure actually lives, registry membership
// or not. This is NOT clone lag (558895a9 already covers that, and it is silent
// in the failing case) and NOT the refusal path.
//
// ---------------------------------------------------------------------------
// INVENTED CONTRACT — the design was SILENT on wire format, so this file FIXES
// it. Every item below is a specification for the implementer, not something
// read out of existing code:
//
//  1. MARKER: the notice is identified by the literal token `AGENT CURRENCY`
//     (matched case-insensitively). Chosen so the assertions cannot collide with
//     H1's other signals (the `stale_research` maintenance lane, the clone
//     currency banner, the hook_node_unresolvable warning of 946125ff).
//  2. SHAPE: ONE notice per SessionStart per surface — a single blank-line
//     delimited block — listing each affected agent on its OWN line, plus the
//     number of stale agents. Judgment call (reported to the conductor): H1's
//     existing idiom is one compact block carrying a COUNT and NAMING the
//     members (the deep-queue signal names the count and its lanes; the
//     delegation clause is one block), so per-project-with-a-count-and-names
//     beats one banner per agent, which on a 15-agent roster would bury the
//     rest of the banner.
//  3. WORDS: a stale agent's line matches /stale/i; a locally-modified agent's
//     line matches /modif/i and must NOT match /stale/i.
//  4. BOTH SURFACES (precedent 946125ff (c): "warns BOTH surfaces"): the human
//     via `systemMessage`, the conductor via `hookSpecificOutput.additionalContext`.
//  5. SILENT WHEN CURRENT: every installed sterling-generated agent matching the
//     clone's current template => no marker anywhere.
//  6. DEGRADE LOUD (P5, and the whole lesson of anti_pattern 02a1ed39, whose
//     staleness check reported `up_to_date` NINE times while the agents were
//     dead): if the clone-side template cannot be read/hashed, the notice fires
//     saying so and never claims up-to-date.
//  7. NEVER BLOCKS: exit 0, parseable JSON, no block/deny, session still starts.
//
// PLUGIN-ROOT SEAM: these tests point STERLING_PLUGIN_ROOT (already honoured by
// H1 — every sibling h1 test sets it) at a synthetic clone carrying its own
// agent-templates/ + registry.json, so BOTH sides of the hash comparison are
// controlled. H1 must perform the currency check against the plugin root it is
// given; if it only works against its own real checkout, these tests fail — and
// that is the correct verdict, since a check that cannot be pointed at a clone
// is a check nobody can test.
//
// NO RED OUTPUT IS CLAIMED: the test-writer holds no Bash. These were never
// executed. Run them with:
//   node --test scripts/tests/agent-currency-h1.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { installAgents } from '../lib/agent-distribution.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const T_INSTALL = '2026-01-01T00:00:00.000Z'; // safely BEFORE any real session start

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// --------------------------- harness (h1-accuracy.test.mjs shape) ---------------------------

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

const BASE_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
};

function makeProject(configOverride = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-agentcur-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ ...BASE_CONFIG, ...configOverride }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup, agentsDir: join(dir, '.claude', 'agents') };
}

function h1(dir, pluginRoot, envOverride = {}) {
  const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart', source: 'startup' }), dir, {
    NO_COLOR: '1',
    STERLING_NO_BANNER: '1',
    STERLING_PLUGIN_ROOT: pluginRoot,
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

const contextOf = (res) => (res.out && res.out.hookSpecificOutput ? res.out.hookSpecificOutput.additionalContext ?? '' : '');
const messageOf = (res) => (res.out && typeof res.out.systemMessage === 'string' ? res.out.systemMessage : '');

/** The AGENT CURRENCY notice: one blank-line-delimited block (contract item 2). */
function currencySection(text) {
  if (!text) return '';
  const i = text.search(/AGENT CURRENCY/i);
  if (i === -1) return '';
  const rest = text.slice(i);
  const end = rest.indexOf('\n\n');
  return end === -1 ? rest : rest.slice(0, end);
}
const lineFor = (section, name) => section.split('\n').find((l) => l.includes(name)) ?? '';
const markerCount = (text) => (String(text).match(/AGENT CURRENCY/gi) || []).length;

// --------------------------- synthetic clone (plugin root) ---------------------------

/** A fixture agent template. Machine vars are RESOLVABLE (real node + a real
 *  hook file) so H1's pre-existing hook_node_unresolvable warning (946125ff (c))
 *  never fires and can never be mistaken for the notice under test. */
const TPL = (name, body) => `---
name: ${name}
description: Fixture agent for the agent-currency tests.
tools: Read
hooks:
  PreToolUse:
    - matcher: "Read"
      hooks:
        - type: command
          command: '{{NODE}} "{{HOOKS_DIR}}/h.mjs"'
---

${body}
`;

/** Real roster names on purpose: whether the implementation enumerates the
 *  clone's agent-templates/registry.json or the shipped roster, it finds these. */
function makeClone(templates) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-clone-'));
  const templatesDir = join(dir, 'agent-templates');
  mkdirSync(templatesDir, { recursive: true });
  const agents = [];
  for (const [file, content] of Object.entries(templates)) {
    writeFileSync(join(templatesDir, file), content);
    agents.push({ name: content.match(/^name:\s*(\S+)/m)[1], file });
  }
  const registryPath = join(templatesDir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ version: 1, agents }, null, 2));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'sterling-fixture-clone', version: '0.0.0-fixture' }));
  const hooksDir = join(dir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'h.mjs'), '// resolvable hook fixture\n');
  const vars = { NODE: `"${process.execPath.replace(/\\/g, '/')}"`, HOOKS_DIR: hooksDir.replace(/\\/g, '/') };
  return { dir, templatesDir, registryPath, vars, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Installs every fixture template into the project, unmodified and current. */
function installInto(clone, agentsDir) {
  installAgents({
    templatesDir: clone.templatesDir,
    registryPath: clone.registryPath,
    targetAgentsDir: agentsDir,
    pluginVersion: '0.1.0',
    now: T_INSTALL,
    vars: clone.vars,
  });
}

/** Bumps the CLONE's template so the already-installed copy's header
 *  template_hash goes stale — the measured case exactly: valid header, old
 *  template_hash, content_hash still self-consistent (state `stale`, NOT
 *  `modified`). */
const bumpTemplate = (clone, file, name) =>
  writeFileSync(join(clone.templatesDir, file), TPL(name, `Fixture body v2 for ${name}.`));

/** A genuine local edit of an installed agent — content_hash no longer matches
 *  its own header (state `modified`, the refusal path of agent-distribution). */
function editInstalled(agentsDir, file) {
  const p = join(agentsDir, file);
  writeFileSync(p, readFileSync(p, 'utf8') + '\nA local hand edit.\n');
}

// =============================================================================
// CONTROL ARM — PLACED FIRST. This pin must pass for the OPPOSITE reason to
// every pin below it: identical fixture, identical H1 invocation, the ONLY
// difference being that no template was bumped. A green control alone cannot
// distinguish "the check ran and found nothing" from "the check never ran"; the
// control and the stale pin below are one pair, and the pair is what carries
// the verdict.
// =============================================================================

test('CONTROL: every installed agent matches the clone template_hash — H1 says NOTHING about agent currency', () => {
  const clone = makeClone({ 'coder.md': TPL('coder', 'Fixture body v1 for coder.'), 'test-writer.md': TPL('test-writer', 'Fixture body v1 for test-writer.') });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON against a fixture plugin root: ${r.stdout}${r.stderr}`);

    assert.equal(markerCount(messageOf(r)), 0, 'a current install produces NO agent-currency banner — a warning that fires always is a warning nobody reads');
    assert.equal(markerCount(contextOf(r)), 0, 'a current install injects NO agent-currency notice for the conductor either');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// SABOTAGE: emit the AGENT CURRENCY notice unconditionally (drop the
// `if (installedHash !== currentTemplateHash)` guard, or invert it) — both
// markerCount assertions flip 0→1, caught. This is the ONLY arm that catches an
// always-warn implementation; every other test in this file would stay green
// under it.

// =============================================================================
// THE MEASURED CASE (research_finding 0038af7c)
// =============================================================================

test('MEASURED CASE: an unmodified install whose header template_hash is OLD is reported STALE, naming the agent', () => {
  const clone = makeClone({ 'coder.md': TPL('coder', 'Fixture body v1 for coder.') });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    bumpTemplate(clone, 'coder.md', 'coder'); // the clone moved on; the project never got visited

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);

    const section = currencySection(contextOf(r));
    assert.notEqual(section, '', 'H1 must emit an AGENT CURRENCY notice when an installed agent is behind the clone template');
    const line = lineFor(section, 'coder');
    assert.notEqual(line, '', 'the notice NAMES the stale agent — "some agents are stale" is not actionable');
    assert.match(line, /stale/i, 'the named agent is described as stale');
    assert.doesNotMatch(section, /up[-_ ]to[-_ ]date/i, 'the notice never claims up-to-date while reporting staleness (anti_pattern 02a1ed39)');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// SABOTAGE: delete the template_hash comparison and treat every parsed header as
// current (`const stale = []`) — `section` is '' and the notEqual fails, caught.
// Narrower sabotage: keep the detection but print only a count with no names —
// lineFor('coder') returns '' and the second assertion fails.

test('one notice per session per surface, carrying the COUNT and every stale agent name, on BOTH surfaces', () => {
  const clone = makeClone({
    'coder.md': TPL('coder', 'Fixture body v1 for coder.'),
    'test-writer.md': TPL('test-writer', 'Fixture body v1 for test-writer.'),
    'librarian.md': TPL('librarian', 'Fixture body v1 for librarian.'),
  });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    bumpTemplate(clone, 'coder.md', 'coder');
    bumpTemplate(clone, 'test-writer.md', 'test-writer'); // librarian stays current

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);

    const msg = messageOf(r);
    const ctx = contextOf(r);
    assert.equal(markerCount(msg), 1, 'exactly ONE notice for the human — not one banner per stale agent (H1 banner idiom: count + names)');
    assert.equal(markerCount(ctx), 1, 'exactly ONE notice for the conductor (946125ff (c): both surfaces warned, once each)');

    const section = currencySection(ctx);
    assert.match(section, /\b2\b/, 'the notice states HOW MANY agents are stale');
    assert.match(lineFor(section, 'coder'), /stale/i, 'coder is listed on its own line as stale');
    assert.match(lineFor(section, 'test-writer'), /stale/i, 'test-writer is listed on its own line as stale');
    assert.equal(lineFor(section, 'librarian'), '', 'the CURRENT agent is not listed — the notice reports the exceptions, not the roster');
    assert.notEqual(currencySection(msg), '', 'the human-facing systemMessage carries the notice too, not just the conductor context');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// SABOTAGE (any one of three, each caught by a different assertion): (1) emit
// the notice only into additionalContext and not systemMessage — markerCount(msg)
// 1→0; (2) emit one notice per stale agent instead of one block —
// markerCount(ctx) 1→2; (3) list every installed agent rather than only the
// stale ones — lineFor('librarian') stops being '', caught.

// =============================================================================
// THE DISTINCTION THAT MUST SURVIVE: stale vs locally modified
// =============================================================================

test('a LOCALLY MODIFIED agent is never reported as merely stale — the stale / refused_local_modification distinction survives', () => {
  const clone = makeClone({
    'coder.md': TPL('coder', 'Fixture body v1 for coder.'),
    'test-writer.md': TPL('test-writer', 'Fixture body v1 for test-writer.'),
  });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    bumpTemplate(clone, 'coder.md', 'coder');               // clean + behind  -> stale
    bumpTemplate(clone, 'test-writer.md', 'test-writer');   // behind AND
    editInstalled(agentsDir, 'test-writer.md');             //   hand-edited   -> modified

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);

    const section = currencySection(contextOf(r));
    assert.notEqual(section, '', 'the notice still fires for the genuinely stale agent');
    assert.match(lineFor(section, 'coder'), /stale/i, 'the unmodified-but-behind agent is stale');

    const modifiedLine = lineFor(section, 'test-writer');
    assert.doesNotMatch(modifiedLine, /stale/i, 'a locally MODIFIED install is not describable as stale — sync refuses it, it is not a missed refresh');
    if (modifiedLine !== '') assert.match(modifiedLine, /modif/i, 'if the modified install is mentioned at all, it is classified as locally modified');
    assert.match(section, /\b1\b/, 'the stale COUNT is 1 — the modified agent is not counted as stale');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// SABOTAGE: classify on template_hash alone (drop the isLocallyModified/content_hash
// check, so any hash difference reads `stale`) — the modified agent's line then
// matches /stale/i and the doesNotMatch fires; the count also flips 1→2, caught
// twice. NOTE for the reviewer: two assertions cover this on purpose — if only
// the count assertion goes red under the mutation, the implementation is
// counting correctly but labelling wrongly, and vice versa.

test('a FOREIGN file (no sterling-generated header) is not Sterling\'s to judge — never reported as stale', () => {
  const clone = makeClone({
    'coder.md': TPL('coder', 'Fixture body v1 for coder.'),
    'test-writer.md': TPL('test-writer', 'Fixture body v1 for test-writer.'),
  });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    // hand-written agent under a roster name, with NO sterling-generated header
    writeFileSync(join(agentsDir, 'test-writer.md'), '---\nname: test-writer\n---\nhand-written by the user\n');
    bumpTemplate(clone, 'test-writer.md', 'test-writer'); // the clone moved on; still none of Sterling's business

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);

    assert.equal(markerCount(contextOf(r)), 0, 'coder is current and the only other file is foreign — no agent-currency notice at all');
    assert.equal(markerCount(messageOf(r)), 0, 'and nothing shown to the human either');
    assert.ok(readFileSync(join(agentsDir, 'test-writer.md'), 'utf8').includes('hand-written by the user'), 'the foreign file is never rewritten by a SessionStart check');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// SABOTAGE: treat a missing/unparseable sterling header as "hash mismatch =>
// stale" (i.e. compare against a null header instead of skipping the file) —
// the notice appears and both markerCount assertions flip 0→1, caught. Also
// caught: any implementation that "helpfully" re-renders the file, via the
// final readFileSync assertion.

// =============================================================================
// NON-BLOCKING (the user's ruling: (a) warns, it never blocks)
// =============================================================================

test('NON-BLOCKING: a project full of stale agents still starts — exit 0, no block, no deny', () => {
  const clone = makeClone({
    'coder.md': TPL('coder', 'Fixture body v1 for coder.'),
    'test-writer.md': TPL('test-writer', 'Fixture body v1 for test-writer.'),
  });
  const { dir, store, cleanup, agentsDir } = makeProject();
  try {
    store.create({
      id: randomUUID(), type: 'todo', created_at: T_INSTALL, updated_at: T_INSTALL, author: 'conductor',
      status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
      text: 'a standalone task', source: 'user',
    });
    installInto(clone, agentsDir);
    bumpTemplate(clone, 'coder.md', 'coder');
    bumpTemplate(clone, 'test-writer.md', 'test-writer');

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `SessionStart must not be aborted by stale agents (exit code): ${r.stderr}`);
    assert.ok(r.out, `H1 must still emit parseable JSON: ${r.stdout}${r.stderr}`);
    assert.notEqual(r.out.continue, false, 'the warning never halts the session');
    assert.doesNotMatch(JSON.stringify(r.out), /"(decision|permissionDecision)"\s*:\s*"(block|deny)"/, 'the warning is advisory — it never denies');
    assert.equal(typeof r.out.systemMessage, 'string', 'H1 still emits its normal banner alongside the warning');
    assert.match(r.out.systemMessage, /\b1 task/, 'H1\'s normal task-count clause still reports, i.e. the currency check did not short-circuit the rest of the banner');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// SABOTAGE: make the stale branch exit 2 (the check-agents-visible idiom of
// 946125ff (b), which the user explicitly ruled OUT for this build) — the
// exit-code assertion flips, caught. Or return `{ continue: false }` / a block
// decision — caught by the next two. Or `return` out of H1 right after emitting
// the notice — the task-count assertion goes red, catching a warning that eats
// the rest of the banner.

// =============================================================================
// DEGRADE LOUD, NEVER SILENT (P5; the entire lesson of anti_pattern 02a1ed39,
// whose staleness check reported up_to_date NINE times while the agents were dead)
// =============================================================================

test('DEGRADE LOUD: the clone template for an installed agent cannot be read — the notice says so and never claims up-to-date', () => {
  const clone = makeClone({ 'coder.md': TPL('coder', 'Fixture body v1 for coder.') });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    rmSync(join(clone.templatesDir, 'coder.md'), { force: true }); // registry still lists it; the file is gone

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `a degraded probe still never blocks: ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);

    const section = currencySection(contextOf(r));
    assert.notEqual(section, '', 'an unreadable clone template is reported LOUDLY, not swallowed into silence');
    assert.match(section, /(cannot|could not|can't|unable|unreadable|unknown|missing)/i, 'the notice states that currency could not be determined');
    assert.match(section, /coder/, 'and names the agent whose currency is unknown');
    assert.doesNotMatch(section, /up[-_ ]to[-_ ]date/i, 'an unverifiable agent is NEVER reported as up to date (02a1ed39: nine consecutive up_to_date lies)');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// SABOTAGE: wrap the template read in `try { ... } catch { return; }` (or
// `catch { continue; }` in the per-agent loop) so an unreadable template is
// treated as "nothing to report" — `section` becomes '' and the notEqual fires,
// caught. This is the exact one-line shape that produced 02a1ed39.

test('DEGRADE LOUD: the clone has no agent-templates directory at all — H1 still reports the check could not run', () => {
  const clone = makeClone({ 'coder.md': TPL('coder', 'Fixture body v1 for coder.') });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    rmSync(clone.templatesDir, { recursive: true, force: true }); // a broken / half-updated clone

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `a broken clone must not break SessionStart: ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON even against a broken clone: ${r.stdout}${r.stderr}`);

    const section = currencySection(contextOf(r));
    assert.notEqual(section, '', 'a clone with no templates cannot certify currency — say so');
    assert.match(section, /(cannot|could not|can't|unable|unreadable|unknown|missing)/i, 'the notice names the degraded state');
    assert.doesNotMatch(section, /up[-_ ]to[-_ ]date/i, 'never "up to date" from a check that could not run');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// SABOTAGE: `if (!existsSync(templatesDir)) return;` — a silent early return is
// indistinguishable from "all current" at the surface the user reads; `section`
// becomes '' and the notEqual fires, caught. NOTE this pin and the one above
// are NOT redundant defence-in-depth: the missing-FILE path and the missing-DIR
// path are usually two different early returns, and the measured incident
// (02a1ed39) was one of them being silent while the other was loud.

// #############################################################################
// APPENDED 2026-08-29 — REVIEW-FIX PINS.
//
// READ THIS BEFORE READING A GREEN RUN AS A NO-OP. Every arm ABOVE this banner
// was written BEFORE the implementation and went red-then-green in the usual
// way. Every arm BELOW it is the INVERSE situation: the fixes it pins are
// ALREADY IN THE CODE, so these are expected GREEN on an unmodified tree and
// RED only under the one-line sabotage named beneath each one. A green run here
// is the pin holding, not the pin doing nothing — the only way to tell those
// two apart is to apply the named sabotage, which is the mutation discipline
// these arms exist to serve.
//
// WHY THEY EXIST: a fixer applied eleven review findings and then measured that
// the suites above catch almost none of them. Two were provably unpinned — the
// F2 swallow (this file stayed 8/8 green under it) and the F3 dedupe (the
// coverage suite stayed 5/5 green under it). A fix nobody pins regresses the
// first time somebody tidies the code, which is the whole shape of anti_pattern
// 02a1ed39: a check that reported `up_to_date` nine times while every hook it
// was guarding was dead.
//
// STILL SPEC-ONLY: scripts/hooks/h1-session-start.mjs was NOT read (H4 read
// wall). These expectations come from the fix list in the dispatch brief, the
// contract at the top of this file, anti_pattern 02a1ed39 and research_finding
// 0038af7c — never from the implementation.
//
// Run with:  node --test scripts/tests/agent-currency-h1.test.mjs
// #############################################################################

import { chmodSync } from 'node:fs';

/** Rewrites the synthetic clone's roster. Used to manufacture a roster MISS and
 *  a path-traversing roster ENTRY without touching the installed copies. */
const rewriteRegistry = (clone, agents) =>
  writeFileSync(clone.registryPath, JSON.stringify({ version: 1, agents }, null, 2));

/** A truncated sterling-generated header: the MARKER is present (this file is
 *  ours) but the attributes are cut off mid-token, so nothing can be parsed out
 *  of it. "Unparseable" and "not ours" are different verdicts — F8 exists
 *  because collapsing them silently reclassifies a damaged install as a foreign
 *  file and stops reporting it forever. */
const DAMAGED_INSTALL = `---
name: test-writer
description: Fixture agent for the agent-currency tests.
---
<!-- sterling-generated v=0.11.4 template=test-writer template_hash=deadbe

Body was truncated by a bad copy.
`;

/** chmod is advisory-to-absent as root and on some mounts. Rather than let an
 *  EACCES arm pass vacuously (a green that proves nothing is the exact failure
 *  this whole append exists to prevent), probe the capability and skip LOUDLY. */
function chmodDenialWorks() {
  const d = mkdtempSync(join(tmpdir(), 'sterling-chmod-probe-'));
  const f = join(d, 'probe.txt');
  try {
    writeFileSync(f, 'probe');
    chmodSync(f, 0o000);
    try {
      readFileSync(f, 'utf8');
      return false; // read succeeded despite mode 000 — probably root
    } catch {
      return true;
    }
  } catch {
    return false;
  } finally {
    try {
      chmodSync(f, 0o644);
    } catch {
      /* best effort */
    }
    rmSync(d, { recursive: true, force: true });
  }
}

// =============================================================================
// F7 CONTROL — PLACED FIRST IN THIS BLOCK, and REQUIRED by the F7 pin below it.
//
// F7 makes H1 report a template-CURRENT agent that was hand-edited. On its own,
// that pin is satisfied by an implementation that warns about EVERY installed
// agent — and such an implementation is worse than useless, because a banner
// that fires every session is a banner nobody reads (P1). This arm must pass
// for the OPPOSITE reason: a matching template_hash with NO body edit stays
// SILENT even though its rendered BYTES differ from a fresh render, which is
// exactly the machine_rebaked / deliberate-divergence shape of 02a1ed39. The
// pair carries the verdict; neither half does alone.
// =============================================================================

test('F7 CONTROL: same template_hash, no body edit, DIFFERENT baked machine vars — H1 stays SILENT (machine divergence is not a local modification)', () => {
  const clone = makeClone({ 'coder.md': TPL('coder', 'Fixture body v1 for coder.'), 'test-writer.md': TPL('test-writer', 'Fixture body v1 for test-writer.') });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    // A SECOND resolvable hooks dir: the installed copies bake a different
    // HOOKS_DIR than clone.vars, so their rendered bodies differ byte-for-byte
    // from what a fresh render with clone.vars would produce — while the
    // template is untouched and the content_hash is self-consistent.
    const otherHooks = join(clone.dir, 'hooks-other');
    mkdirSync(otherHooks, { recursive: true });
    writeFileSync(join(otherHooks, 'h.mjs'), '// resolvable hook fixture (second machine context)\n');
    installAgents({
      templatesDir: clone.templatesDir,
      registryPath: clone.registryPath,
      targetAgentsDir: agentsDir,
      pluginVersion: '0.1.0',
      now: T_INSTALL,
      vars: { NODE: clone.vars.NODE, HOOKS_DIR: otherHooks.replace(/\\/g, '/') },
    });

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);

    assert.equal(markerCount(contextOf(r)), 0, 'a template-current, unedited install is SILENT even when its baked machine vars differ — otherwise the F7 pin below is satisfied by an implementation that warns about everything');
    assert.equal(markerCount(messageOf(r)), 0, 'and nothing is shown to the human either');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// EXPECTED: GREEN on the current tree.
// SABOTAGE (one line): decide `locallyModified` by comparing the installed bytes
// against a freshly-rendered template body instead of against the header's own
// content_hash — the machine-var divergence is then read as a hand edit, both
// markerCount assertions flip 0→1, caught. This is the ONLY arm in the file that
// catches a warn-on-everything implementation of F7.

// =============================================================================
// F7 — templateCurrent and locallyModified are computed INDEPENDENTLY
// =============================================================================

test('F7: a template-CURRENT agent that was hand-edited is REPORTED as locally modified — currency and modification are independent axes', () => {
  const clone = makeClone({ 'coder.md': TPL('coder', 'Fixture body v1 for coder.'), 'test-writer.md': TPL('test-writer', 'Fixture body v1 for test-writer.') });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    editInstalled(agentsDir, 'coder.md'); // template NOT bumped: current template_hash, edited body

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);

    const section = currencySection(contextOf(r));
    assert.notEqual(section, '', 'a hand-edited install is reported even though its template_hash is CURRENT — sync will not refresh it, so nothing else will ever tell anyone');
    const line = lineFor(section, 'coder');
    assert.notEqual(line, '', 'and the notice NAMES it');
    assert.match(line, /modif/i, 'classified as locally modified');
    assert.doesNotMatch(line, /stale/i, 'it is NOT stale — it is level with the template and hand-edited, a different remedy');
    assert.equal(lineFor(section, 'test-writer'), '', 'the untouched agent is not listed — the notice still reports exceptions, not the roster');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// EXPECTED: GREEN on the current tree.
// SABOTAGE (one line): restore the early `if (templateHash === currentTemplateHash) continue;`
// ahead of the modification check — the hand-edited agent is skipped before it is
// ever examined, `section` becomes '' and the first notEqual fires, caught.
// NOTE this arm and its CONTROL above are one pair: strip only this arm and you
// see a false negative, strip only the control and you see a false positive.

// =============================================================================
// F2 — enumeration and per-file reads are INDIVIDUALLY guarded
// =============================================================================

test('F2: one unreadable agent file does NOT silence the report for the agents that WERE readable', (t) => {
  if (!chmodDenialWorks()) {
    t.skip('mode 000 does not deny reads on this host (root, or a mount without POSIX modes) — the EACCES branch is unreachable here');
    return;
  }
  const clone = makeClone({
    'coder.md': TPL('coder', 'Fixture body v1 for coder.'),
    'test-writer.md': TPL('test-writer', 'Fixture body v1 for test-writer.'),
    'librarian.md': TPL('librarian', 'Fixture body v1 for librarian.'),
  });
  const { dir, cleanup, agentsDir } = makeProject();
  const locked = join(agentsDir, 'librarian.md');
  try {
    installInto(clone, agentsDir);
    bumpTemplate(clone, 'coder.md', 'coder');             // readable + stale
    bumpTemplate(clone, 'test-writer.md', 'test-writer'); // readable + stale
    chmodSync(locked, 0o000);                             // EACCES, not ENOENT

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `an EACCES on one file must never abort SessionStart: ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);

    const section = currencySection(contextOf(r));
    assert.notEqual(section, '', 'ONE unreadable file must not swallow the whole notice — that is the 02a1ed39 shape exactly');
    assert.match(lineFor(section, 'coder'), /stale/i, 'the readable stale agent is STILL named');
    assert.match(lineFor(section, 'test-writer'), /stale/i, 'and so is the second one');

    const lockedLine = lineFor(section, 'librarian');
    assert.notEqual(lockedLine, '', 'the unreadable agent is REPORTED, not dropped — EACCES is not absence');
    assert.match(lockedLine, /(unknown|cannot|could not|can't|unable|unreadable|denied|permission)/i, 'and its currency is stated as UNKNOWN');
    assert.doesNotMatch(section, /up[-_ ]to[-_ ]date/i, 'nothing here is claimed up to date');
  } finally {
    try {
      chmodSync(locked, 0o644);
    } catch {
      /* best effort — rmSync force follows */
    }
    cleanup();
    clone.cleanup();
  }
});
// EXPECTED: GREEN on the current tree. This is one of the two findings MEASURED
// unpinned: before the fix this file stayed 8/8 GREEN under the swallow.
// SABOTAGE (one line): wrap the enumeration + per-file reads back in a single
// outer `try { ... } catch {}` — the EACCES escapes the per-file guard, the
// whole block is abandoned, `section` becomes '' and BOTH halves fire (the two
// stale agents vanish AND the unreadable one is unreported), caught twice.
// The two halves are deliberate: a red only on the librarian assertion means the
// per-file guard reports but mis-words; a red on the stale assertions means one
// bad file still costs the whole report.

// =============================================================================
// F8 — a DAMAGED sterling-generated file is UNKNOWN, never silently foreign
// =============================================================================

test('F8: a file carrying the sterling-generated marker but damaged is UNKNOWN — unparseable is not the same as not-ours', () => {
  const clone = makeClone({ 'coder.md': TPL('coder', 'Fixture body v1 for coder.'), 'test-writer.md': TPL('test-writer', 'Fixture body v1 for test-writer.') });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    writeFileSync(join(agentsDir, 'test-writer.md'), DAMAGED_INSTALL); // marker present, header truncated

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `a damaged install must never abort SessionStart: ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);

    const section = currencySection(contextOf(r));
    assert.notEqual(section, '', 'a damaged OURS file is reported — reclassifying it as foreign retires it from every future check, silently and permanently');
    const line = lineFor(section, 'test-writer');
    assert.notEqual(line, '', 'and the notice NAMES it');
    assert.match(line, /(unknown|cannot|could not|can't|unable|damaged|corrupt|unparse|invalid|unreadable)/i, 'its currency is UNKNOWN, not "fine" and not "someone else\'s"');
    assert.doesNotMatch(section, /up[-_ ]to[-_ ]date/i, 'never up-to-date from a header that could not be parsed');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// EXPECTED: GREEN on the current tree.
// SABOTAGE (one line): restore `.filter(a => a.header)` over the enumerated
// installs — the damaged file drops out of the set entirely and is treated as a
// foreign hand-written agent; `section` becomes '' and the first notEqual fires,
// caught. The foreign-file arm ABOVE this block is the control for this one: it
// proves the implementation is not simply reporting every unrecognised file.

test('F8 (zero-byte sub-case): an EMPTY file at a roster agent path is UNKNOWN, not silently foreign', () => {
  const clone = makeClone({ 'coder.md': TPL('coder', 'Fixture body v1 for coder.'), 'test-writer.md': TPL('test-writer', 'Fixture body v1 for test-writer.') });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    writeFileSync(join(agentsDir, 'test-writer.md'), ''); // truncated to nothing by a failed write

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `a zero-byte install must never abort SessionStart: ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);

    const section = currencySection(contextOf(r));
    assert.notEqual(section, '', 'a zero-byte file at a ROSTER path is a damaged install, not a user\'s hand-written agent');
    assert.match(lineFor(section, 'test-writer'), /(unknown|cannot|could not|can\'t|unable|damaged|empty|corrupt|unparse|invalid|unreadable)/i, 'reported with its currency UNKNOWN');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// EXPECTED: GREEN on the current tree — but FLAGGED to the conductor as the one
// arm here whose greenness I am least certain of, because a zero-byte file
// cannot carry the marker and an implementation could defensibly route it down
// the foreign-file path instead. It is pinned SEPARATELY from the arm above so a
// red is diagnosable in one read: if this one alone goes red, the disagreement is
// about the zero-byte classification, not about F8's damaged-header property.
// SABOTAGE (one line): same `.filter(a => a.header)` restoration — the empty file
// disappears from the set and `section` becomes '', caught.

// =============================================================================
// F9 — the roster is the authority: a MISS is unknown, and an entry that
//      escapes agent-templates/ is refused
// =============================================================================

test('F9(a): an installed agent MISSING from the roster is UNKNOWN — an orphan <name>.md template must never certify it as current', () => {
  const clone = makeClone({
    'coder.md': TPL('coder', 'Fixture body v1 for coder.'),
    'retired.md': TPL('retired', 'Fixture body v1 for retired.'),
  });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir); // both installed, both current
    // The clone then drops `retired` from the roster while agent-templates/retired.md
    // stays on disk — an ORPHAN template. A `<name>.md` fallback would read it,
    // find a matching hash, and certify a retired agent as perfectly current.
    rewriteRegistry(clone, [{ name: 'coder', file: 'coder.md' }]);

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `a roster miss must never abort SessionStart: ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);

    const section = currencySection(contextOf(r));
    assert.notEqual(section, '', 'an installed agent the roster does not list cannot be certified by anything — say so');
    const line = lineFor(section, 'retired');
    assert.notEqual(line, '', 'the notice NAMES the off-roster agent');
    assert.match(line, /(unknown|cannot|could not|can't|unable|not in|no longer|unrecognis|unrecogniz|orphan|missing)/i, 'its currency is UNKNOWN — the roster is the authority, not the filename');
    assert.doesNotMatch(section, /up[-_ ]to[-_ ]date/i, 'and it is never reported up to date');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// EXPECTED: GREEN on the current tree.
// SABOTAGE (one line): restore the `<name>.md` fallback — `agent-templates/retired.md`
// is read, its hash matches the installed header, `retired` is certified current,
// `coder` is current too, `section` becomes '' and the first notEqual fires,
// caught. The failure this prevents is the worst kind: a certification produced
// by a file that no longer means anything.

test('F9(b) SECURITY: a roster entry whose file escapes agent-templates/ is REFUSED LOUDLY and never certifies an install', () => {
  const clone = makeClone({ 'coder.md': TPL('coder', 'Fixture body v1 for coder.') });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    // A byte-identical copy OUTSIDE agent-templates/, and a roster entry that
    // reaches it by traversal. If the basename constraint is dropped, this file's
    // hash matches the installed header and the traversal silently CERTIFIES the
    // install — a file from anywhere on disk deciding that Sterling's agents are
    // current. That is the property under test, and it is a security property.
    const templateBytes = readFileSync(join(clone.templatesDir, 'coder.md'), 'utf8');
    writeFileSync(join(clone.dir, 'escape.md'), templateBytes);
    rewriteRegistry(clone, [{ name: 'coder', file: '../escape.md' }]);

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `a refused roster entry must still never abort SessionStart: ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);

    const section = currencySection(contextOf(r));
    assert.notEqual(
      section,
      '',
      'SECURITY: a roster template path that leaves agent-templates/ must be REFUSED LOUDLY. Silence here means the traversal was followed and a file from outside the template directory was allowed to certify an installed agent as current.'
    );
    const line = lineFor(section, 'coder');
    assert.notEqual(line, '', 'SECURITY: the refusal NAMES the agent whose roster entry was rejected');
    assert.match(
      line,
      /(refus|reject|invalid|unsafe|outside|escape|traversal|basename|unknown|cannot|could not|can't|unable)/i,
      'SECURITY: the refusal states that the roster entry — not the agent — is the defect'
    );
    assert.doesNotMatch(section, /up[-_ ]to[-_ ]date/i, 'SECURITY: a refused entry can never yield an up-to-date verdict');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// EXPECTED: GREEN on the current tree.
// SABOTAGE (one line): drop the plain-`.md`-basename constraint and join the
// roster's `file` onto templatesDir unchecked — `../escape.md` resolves, its
// bytes are identical to the real template, `coder` is certified CURRENT, the
// notice disappears and the first notEqual fires, caught. The escape file is
// byte-identical ON PURPOSE: a different-content fixture would go red under the
// sabotage for the boring reason (hash mismatch => stale) and would not
// distinguish "the traversal was refused" from "the traversal was followed and
// happened to disagree".

// =============================================================================
// F11 — the wording follows what SYNC ACTUALLY DOES, per case
// =============================================================================

test('F11: a hand-edited agent that is LEVEL with its template is worded differently from one that is BEHIND — sync does different things to them', () => {
  const clone = makeClone({
    'coder.md': TPL('coder', 'Fixture body v1 for coder.'),
    'test-writer.md': TPL('test-writer', 'Fixture body v1 for test-writer.'),
  });
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    editInstalled(agentsDir, 'coder.md');                 // modified, template CURRENT
    bumpTemplate(clone, 'test-writer.md', 'test-writer'); // modified AND behind
    editInstalled(agentsDir, 'test-writer.md');           //   -> sync REFUSES this one

    const r = h1(dir, clone.dir);
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);

    const section = currencySection(contextOf(r));
    const levelLine = lineFor(section, 'coder');
    const behindLine = lineFor(section, 'test-writer');

    assert.notEqual(levelLine, '', 'the hand-edited but level agent is reported (F7)');
    assert.notEqual(behindLine, '', 'so is the hand-edited agent that is behind');

    // The wording-independent half: strip the names and the two must still differ.
    const shape = (l) => l.replace(/coder|test-writer/g, '<agent>').replace(/\s+/g, ' ').trim();
    assert.notEqual(
      shape(levelLine),
      shape(behindLine),
      'the two cases must NOT collapse to one sentence — sync leaves the level one alone and REFUSES the behind one, which are different problems with different remedies'
    );

    assert.match(behindLine, /(refus|will not|won\'t|blocked|declin)/i, 'the behind-and-edited agent is the one sync refuses');
    assert.doesNotMatch(levelLine, /(refus|will not|won\'t|blocked|declin)/i, 'the level-and-edited agent is NOT described as refused — nothing is being withheld from it; it is simply hand-owned now');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// EXPECTED: GREEN on the current tree.
// SABOTAGE (one line): collapse the per-case wording to a single
// "sync REFUSES it" string for any locally-modified install — `shape(levelLine)`
// and `shape(behindLine)` become equal AND `levelLine` starts matching /refus/i,
// caught twice. The `shape()` comparison is deliberately wording-AGNOSTIC: it
// still fires no matter which single sentence the collapse picks, so this pin
// survives a later rewording of the notice that a literal-string assertion
// would break for no reason.
//
// NOT PINNED HERE, and reported as such: the `header_repaired` case. A fixture
// for "a header sync would REPAIR" needs the repair rule itself, which is
// implementation I cannot read; guessing at it would produce an arm that pins my
// guess rather than the fix.
