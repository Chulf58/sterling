// H1 SessionStart — WALK-UP ROOT SITES pins (spec-only, red-first).
// Objective dome-farmer-issues-2026-09-05, board fb7c43fb, item N-3.
//
// IN ONE SENTENCE: pluginVersion() (~h1-session-start.mjs:197), the currency
// git probe (~:593-607) and the stale-server guard's server-dist resolution
// (~:1159) must all derive the active plugin root by WALKING UP from H1's own
// module location — never from the agent-settable STERLING_PLUGIN_ROOT env
// var, which is a TEST-ONLY seam consulted solely when that walk-up finds no
// plugin tree (decision 95c2c109 F2's shape, extended by this board item to
// these remaining sites). roleContext (~:557) is NOT separately pinned here —
// board fb7c43fb groups it with the other three but gives no distinct
// observable surface for it; C1-C3 already exercise the shared root-derivation
// path it presumably calls into.
//
// THE SECURITY CORE (C1): board fb7c43fb states it verbatim — "The git probe
// is the sharp one: spawnSync git with cwd inside the env-named tree means a
// planted .git/config there is CODE EXECUTION AT SESSION START." This is the
// reason this file exists and the reason C1 is written first.
//
// ---------------------------------------------------------------------------
// Written BLIND to scripts/hooks/h1-session-start.mjs and
// scripts/hooks/lib/sanctioned-provenance.mjs (H4 read wall; neither opened by
// this author). Harness idioms (spawnSync + JSON stdin, makeH1Project(),
// flat()) are COPIED, not imported, from scripts/tests/h1-receipt-remedy-wording.test.mjs.
// That file is neither modified for this purpose nor referenced at runtime;
// this file is standalone.
//
// The stale-server guard's file shapes (packages/mcp-server/dist/.build-id;
// <project>/.sterling/transient/mcp-runtime.json holding {build_id, pid,
// booted_at}; a mismatch on a confirmed-alive writer WARNS, an orphaned
// (confirmed-dead) writer is SILENT) are taken from feature_article 9c83b485
// ("stale-server-guard") and decisions 132177d2 / c71d676f — spec records, not
// code, and the only way to construct C3 without inventing a schema.
//
// MUTATION DISCIPLINE (decision 23afbc83): every pin carries a SABOTAGE
// comment naming the one-line change that must turn it RED. None is executed
// here — this file's author holds no Bash by design, and no mutation result is
// claimed.
// ---------------------------------------------------------------------------

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, normalize } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildSeamHook } from './lib/seam-hook.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H1_HOOK = join(HOOKS, 'h1-session-start.mjs');

const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// HARNESS FIX (post-review, coordinator-reported): every sibling H1 test file
// (h15-active-root-provenance.test.mjs, agent-currency-h1.test.mjs,
// h1-accuracy.test.mjs) opens a REAL SterlingStore at .sterling/sterling.db
// before spawning H1 — "project-root resolution keys on it actually
// existing." This file originally wrote only config.json and never created
// the store, so H1 produced NO output at all (an empty additionalContext plus
// a stray node:sqlite ExperimentalWarning on stderr — evidence H1 reached a
// store-open attempt and failed before emitting any JSON). Every fixture
// below now opens and closes a real store, exactly like the three sibling
// files.
// ---------------------------------------------------------------------------

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function makeH1Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1sites-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(
    join(dir, '.sterling', 'config.json'),
    JSON.stringify({
      toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
      caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
      context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
    })
  );
  // A REAL store db — project-root resolution keys on it actually existing
  // (the exact convention h15-active-root-provenance.test.mjs:247 documents).
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { dir, cleanup };
}

// Runs H1 (by default the REAL source hook, never a copy, from its own source
// location, so its own walk-up resolves THIS repo). `env` is merged over a
// minimal, quiet base; nothing here sets STERLING_CURRENCY_DISABLE by default,
// since C1 specifically needs the currency probe to run — callers that don't
// care about it (C2, C3) set the flag themselves. `hookPath` is an override
// (used by C1/C1-probe-engaged-control to spawn a currency-enabled walk-up
// FIXTURE bundle instead of the real source hook — see
// makeCurrencyEnabledWalkUpFixture — because this repo's OWN
// .sterling/config.json declares machine_role: authoring, which makes H1 SKIP
// the currency probe entirely; see that fixture's docstring).
function runH1(projectDir, env = {}, hookPath = H1_HOOK) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      session_id: 's1',
      transcript_path: join(projectDir, 't', 's1.jsonl'),
      cwd: projectDir,
      permission_mode: 'default',
      hook_event_name: 'SessionStart',
      source: 'startup',
    }),
    encoding: 'utf8',
    cwd: projectDir,
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1', STERLING_NO_BANNER: '1', ...env },
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // caller asserts
  }
  const ctx = (out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
  const sysMsg = (out && out.systemMessage) || '';
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out, combined: `${ctx}\n${sysMsg}\n${r.stderr ?? ''}` };
}

function makePlantedMarkerRoot(base, name = 'planted-root') {
  const dir = join(base, name);
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: '0.0.0-fixture-plugin-root-sites' }));
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
  return dir;
}

// =============================================================================
// LIVENESS CONTROL — MUST BE GREEN BEFORE ANY OTHER PIN IN THIS FILE MEANS
// ANYTHING. Every C1/C2/C3 pin below is an ABSENCE or MISMATCH claim about
// H1's output; every one of them is satisfiable vacuously by "H1 produced no
// output at all" (exactly the harness defect the coordinator caught via
// C3-control going red for the wrong reason, and C1 going green for the wrong
// reason — a security pin that passes because the subject never ran).
//
// The marker is a fact MEASURED by a sibling file, not invented here:
// h1-receipt-remedy-wording.test.mjs's own docstring (written against a real
// red gate) states "H1's ordinary SessionStart banner ALREADY carries the
// phrase 'by hand' in its delegation-conventions prose ('reading files by
// hand', h1-session-start.mjs:89, coordinator-supplied)". That phrase is
// present on EVERY ordinary SessionStart regardless of ledger/fixture
// content, which is exactly the property a liveness check needs.
// =============================================================================

test('LIVENESS CONTROL (must be GREEN before any other pin in this file is trusted): H1 produces its ordinary banner in this file\'s base fixture shape (a project with a real store, no env overrides)', () => {
  const { dir: project, cleanup } = makeH1Project();
  try {
    const r = runH1(project, {});
    assert.notEqual(r.code, null, `H1 must not crash on a plain project fixture — stderr=${flat(r.stderr)}`);
    assert.ok(
      r.out,
      `H1 must emit parseable JSON on a plain project with a real store — if this fails, every C1/C2/C3 pin below is meaningless, because they all depend on H1 actually running. stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`
    );
    assert.match(
      r.combined,
      /reading files by hand/i,
      `H1 never reached its ordinary delegation-conventions banner in this exact fixture shape — every pin below this one asserts something about that banner (or the surviving-receipt/currency/version/stale-server text alongside it) and would be vacuous until this is green. combined=${flat(r.combined)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: none — this is the harness-validity control, not a claim about
// walk-up vs env-seam. If this is ever red, the finding is about the FIXTURE
// (a broken project, a missing store, a crashing H1), never about C1-C3.

// =============================================================================
// SECTION 1 (C1) — THE CURRENCY GIT PROBE'S SPAWN CWD.
//
// REBUILT (coder-measured, 2026-09-06). The original fsmonitor-trap design was
// VACUOUS under either implementation: H1's currency probe invokes
// `rev-parse --abbrev-ref HEAD` then `remote`, and only goes on to
// `symbolic-ref`/`fetch`/`rev-list` when a remote EXISTS — the planted fixture
// repo had none, so the probe never reached a subcommand that fires
// core.fsmonitor, and the trap could not distinguish "ran safely" from
// "never ran at all".
//
// REPLACEMENT MECHANISM: a `git` SHIM placed first on PATH that appends every
// invocation's cwd + argv to a log file before exec'ing the real git. This
// observes EVERY git call regardless of subcommand, so it cannot be defeated
// by a subcommand change the way the fsmonitor trap was — it pins the actual
// invariant ("no git runs with that cwd"), not a side effect of one
// subcommand.
//
// SECOND TRAP HANDLED HERE (also coder-measured): the walk-up root for the
// REAL source hook is THIS repo, whose OWN .sterling/config.json declares
// machine_role: authoring — and H1 SKIPS the currency probe entirely for that
// role. Spawning h1-session-start.mjs from its real location would therefore
// make the probe emit ZERO git calls regardless of correctness, and "no git
// in the planted tree" would again be true for the wrong reason. C1 and its
// engagement control below spawn a FIXTURE walk-up root instead (a built
// bundle — never a raw source copy, invariant #4 is about bundles, not
// sources — placed at scripts/hooks/h1-session-start.mjs under a root
// carrying a full plugin layout AND its own .sterling/config.json declaring
// machine_role: 'consumer'), so the probe actually engages.
//
// PROOF ORDER, and what proves the probe RAN (not just "no git in the planted
// tree"): C1-shim-control proves the shim mechanism itself logs a
// directly-invoked git call's cwd correctly (fixture validity, no H1
// involved). C1-probe-engaged-control proves that, in the EXACT fixture shape
// C1 uses, H1's currency probe logs at least one git invocation at all — this
// is what rules out "the probe was skipped" as the reason C1 passes. C1 itself
// then asserts that NONE of those logged invocations had cwd inside the
// STERLING_PLUGIN_ROOT-named planted tree.
// =============================================================================

function gitOk(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`fixture setup: git ${args.join(' ')} failed in ${cwd}: ${flat(r.stderr)}`);
  }
  return r;
}

// Locates the REAL git binary by scanning PATH directly (never `which`, to
// avoid a second shell-out dependency) — the shim script execs THIS absolute
// path, never the literal name `git`, so it never recurses into itself once
// its own directory is prepended to PATH.
function resolveRealGitBinary() {
  const dirs = String(process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, 'git');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('fixture setup: could not locate a real `git` binary anywhere on PATH');
}

// A `git` shim, placed on a directory meant to be PREPENDED to PATH. Every
// invocation — of ANY git subcommand, from ANY caller (H1's currency probe or
// a direct test call) — appends its cwd + argv to a log file, then execs the
// real binary. This is the mechanism REPAIR 1(a) recommends: it observes every
// git call, so a subcommand change (the defeat that voided the fsmonitor trap)
// cannot silently void it again.
function makeGitShimWorld() {
  const base = mkdtempSync(join(tmpdir(), 'sterling-h1-gitshim-'));
  const shimDir = join(base, 'shim-bin');
  mkdirSync(shimDir, { recursive: true });
  const logPath = join(base, 'git-invocations.log');
  writeFileSync(logPath, '');
  const realGit = resolveRealGitBinary();
  const shimScript = join(shimDir, 'git');
  writeFileSync(shimScript, `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> "${logPath}"\nexec "${realGit}" "$@"\n`);
  chmodSync(shimScript, 0o755);
  const cleanup = () => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return {
    shimDir,
    logPath,
    cleanup,
    shimmedPath: () => `${shimDir}:${process.env.PATH}`,
    readLoggedCwds: () =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => normalize(line.split('\t')[0])),
  };
}

// A currency-enabled walk-up root: a full plugin layout (so H1's own
// walk-up — never STERLING_PLUGIN_ROOT — resolves it), a BUILT bundle of
// h1-session-start.mjs at the same relative depth the real repo uses (reusing
// buildSeamHook, the already-proven call this file's H15 sibling uses — a raw
// source copy dies on the workspace-import problem the H15 repair already
// measured), and its OWN .sterling/config.json declaring machine_role:
// 'consumer' — never 'authoring', which is what THIS repo's config declares
// and what makes H1 skip the currency probe entirely. A minimal, remote-less
// git repo is initialized at the root itself: the measured subcommand table
// shows the probe's first two calls (`rev-parse --abbrev-ref HEAD`, `remote`)
// fire regardless of a remote's existence, which is all the shim-log evidence
// needs — no fsmonitor trap, no remote, is required here at all.
async function makeCurrencyEnabledWalkUpFixture(base) {
  const fixtureRoot = join(base, 'walkup-currency-root');
  mkdirSync(join(fixtureRoot, '.claude-plugin'), { recursive: true });
  writeFileSync(join(fixtureRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: '0.0.0-fixture-currency' }));
  mkdirSync(join(fixtureRoot, 'hooks'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
  mkdirSync(join(fixtureRoot, '.sterling'), { recursive: true });
  writeFileSync(join(fixtureRoot, '.sterling', 'config.json'), JSON.stringify({ machine_role: 'consumer' }));
  mkdirSync(join(fixtureRoot, 'scripts', 'hooks'), { recursive: true });
  const built = await buildSeamHook('h1-session-start.mjs');
  try {
    cpSync(built.hookPath, join(fixtureRoot, 'scripts', 'hooks', 'h1-session-start.mjs'));
  } finally {
    await built.cleanup();
  }
  gitOk(['init', '-q'], fixtureRoot);
  gitOk(['config', 'user.email', 'fixture@example.invalid'], fixtureRoot);
  gitOk(['config', 'user.name', 'fixture'], fixtureRoot);
  writeFileSync(join(fixtureRoot, 'tracked.txt'), 'v1\n');
  gitOk(['add', 'tracked.txt'], fixtureRoot);
  gitOk(['commit', '-q', '-m', 'init'], fixtureRoot);
  return fixtureRoot;
}

test('C1-shim-control (CONTROL, NON-VACUITY, expect GREEN today and after): the git-invocation shim logs a directly-invoked git call\'s exact cwd', () => {
  const shim = makeGitShimWorld();
  const probeDir = mkdtempSync(join(tmpdir(), 'sterling-h1-shimprobe-'));
  try {
    const r = spawnSync('git', ['status'], { cwd: probeDir, encoding: 'utf8', env: { ...process.env, PATH: shim.shimmedPath() } });
    assert.notEqual(r.status, null, 'the shimmed git must not crash on a plain `git status`');
    const logged = shim.readLoggedCwds();
    assert.ok(
      logged.includes(normalize(probeDir)),
      `FIXTURE VALIDITY, checked before it is trusted as evidence: a directly-invoked \`git status\` with cwd=${probeDir}, run through the shim, must be logged with that exact cwd — without this, C1's absence claim below would be meaningless, because the shim might simply never log anything in this environment. logged=${JSON.stringify(logged)}`
    );
  } finally {
    shim.cleanup();
    rmSync(probeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: none — this is the shim-mechanism-validity control, not a claim
// about H1. If this is ever red, neither C1-probe-engaged-control nor C1 below
// proves anything, and the finding is about the SHIM, not the hook.

test('C1-probe-engaged-control (CONTROL, NON-VACUITY, expect GREEN today and after): H1\'s currency probe, spawned from a non-authoring walk-up root, invokes at least one git command', async () => {
  const shim = makeGitShimWorld();
  const base = mkdtempSync(join(tmpdir(), 'sterling-h1-currencyworld-'));
  const { dir: project, cleanup: cleanupProject } = makeH1Project();
  try {
    const fixtureRoot = await makeCurrencyEnabledWalkUpFixture(base);
    const hookPath = join(fixtureRoot, 'scripts', 'hooks', 'h1-session-start.mjs');
    const r = runH1(project, { PATH: shim.shimmedPath() }, hookPath);
    assert.notEqual(r.code, null, `H1 must not crash when spawned from the currency-enabled walk-up fixture — stderr=${flat(r.stderr)}`);
    const logged = shim.readLoggedCwds();
    assert.ok(
      logged.length > 0,
      `EVIDENCE THE PROBE RAN, checked before C1 is trusted: this repo's OWN .sterling/config.json declares machine_role: authoring, and H1 SKIPS the currency probe entirely for that role (coder-measured) — spawning the REAL source hook directly would walk up to the real repo and silently skip the probe, making "no git in the planted tree" trivially, vacuously true. This fixture root instead declares machine_role: 'consumer', so the probe must actually invoke git at least once here. If this list is empty, C1 below proves nothing. logged=${JSON.stringify(logged)}`
    );
  } finally {
    cleanupProject();
    shim.cleanup();
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: none isolates this control by itself — its purpose is proving the
// non-authoring walk-up fixture makes the currency probe ENGAGE at all; C1 is
// the pin that isolates WHICH cwd the engaged probe's git calls used.

test('C1 (board fb7c43fb N-3, THE SECURITY CORE, expect RED today): the currency probe never spawns git with cwd inside a STERLING_PLUGIN_ROOT-named planted tree', async () => {
  const shim = makeGitShimWorld();
  const base = mkdtempSync(join(tmpdir(), 'sterling-h1-currencyworld-'));
  const planted = makePlantedMarkerRoot(base, 'planted-attacker-root');
  // FIX (security review, 2026-09-06): makePlantedMarkerRoot() gives the tree
  // a plugin layout but NO `.git` directory. H1's currency probe gates on
  // `existsSync(join(root, '.git')) && statSync(...).isDirectory()` BEFORE
  // spawning anything (h1-session-start.mjs:608-610) — so under this pin's
  // OWN named sabotage, `root` becomes `planted`, that .git check fails, and
  // the probe returns WITHOUT ever spawning git. The pin still went red under
  // sabotage, but only via the liveness guard below ("the probe never ran") —
  // the exact failure mode this rebuild exists to eliminate, not the security
  // claim it advertises. A genuine exploit ALSO requires a real `.git`
  // directory to exist (the threat is a planted `.git/config` carrying
  // core.fsmonitor), so this is the correct fixture shape, not a workaround.
  gitOk(['init', '-q'], planted);
  gitOk(['config', 'user.email', 'fixture@example.invalid'], planted);
  gitOk(['config', 'user.name', 'fixture'], planted);
  // Models the REAL exploit shape from board fb7c43fb ("a planted
  // .git/config there is CODE EXECUTION AT SESSION START"). The SHIM, not
  // this trap, is what actually observes the probe's cwd now — the config is
  // kept so the fixture still represents the genuine threat, not merely an
  // arbitrary directory that happens to contain a `.git` folder.
  const trapScript = join(planted, 'fsmonitor-trap.sh');
  writeFileSync(trapScript, '#!/bin/sh\nprintf "TRAPPED-IF-THIS-EVER-RUNS" > /dev/null\nprintf "/\\n"\n');
  chmodSync(trapScript, 0o755);
  gitOk(['config', 'core.fsmonitor', trapScript], planted);
  const { dir: project, cleanup: cleanupProject } = makeH1Project();
  try {
    const fixtureRoot = await makeCurrencyEnabledWalkUpFixture(base);
    const hookPath = join(fixtureRoot, 'scripts', 'hooks', 'h1-session-start.mjs');
    // STERLING_CURRENCY_DISABLE is deliberately NOT set — this pin is
    // specifically about what the (enabled) currency probe does.
    const r = runH1(project, { STERLING_PLUGIN_ROOT: planted, PATH: shim.shimmedPath() }, hookPath);
    assert.notEqual(r.code, null, `H1 must not crash on a plugin-root-planted shim world — stderr=${flat(r.stderr)}`);
    const logged = shim.readLoggedCwds();
    assert.ok(
      logged.length > 0,
      `precondition proven in isolation by C1-probe-engaged-control, re-checked here so this specific run's absence assertion cannot be vacuous: the probe must have logged at least one git invocation in THIS run too. logged=${JSON.stringify(logged)}`
    );
    assert.ok(
      !logged.includes(normalize(planted)),
      `THE SECURITY CORE. ${JSON.stringify(logged)} lists every cwd H1 spawned ANY git subcommand with in this run. If ${planted} (the STERLING_PLUGIN_ROOT-named tree — an env var ANY agent can set) appears among them, the currency probe ran git with a cwd an attacker names, and a planted .git/config there is CODE EXECUTION AT SESSION START. The probe's spawn cwd must be the walk-up root (${fixtureRoot}) instead. stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanupProject();
    shim.cleanup();
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: resolve the currency probe's git cwd from the env-first
// pluginRoot() instead of walkUpPluginRoot() — this pin goes red ON THE
// SUBSTANTIVE ASSERTION (the `!logged.includes(normalize(planted))` line
// above, THE SECURITY CORE), NOT on the liveness guard. `planted` now HAS a
// real `.git` directory (see the fix above), so under this sabotage the
// probe's existsSync(.git) gate still passes, it genuinely spawns git with
// cwd=planted, and that cwd lands in the shim log — making `planted` appear
// among logged cwds. The liveness guard (`logged.length > 0`) STAYS GREEN
// under this sabotage: the probe still runs, it just runs with the wrong
// cwd — which is exactly what proves the pin now tests the claim it
// ADVERTISES (root provenance), not merely "the probe executed at all".
// C1-shim-control and C1-probe-engaged-control both stay green throughout
// (neither ever sets STERLING_PLUGIN_ROOT to a tree the probe is checked
// against). WHICH GUARD CARRIES THE VERDICT: the root-derivation order
// alone — this pin does not depend on which git subcommand fires, unlike the
// fsmonitor-trap design it replaces.

// =============================================================================
// SECTION 2 (C2) — pluginVersion() READS THE WALK-UP ROOT'S plugin.json.
// =============================================================================

const REAL_PLUGIN_JSON = (() => {
  try {
    return JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  } catch {
    return null; // C2 fails loud on this below rather than crashing the module
  }
})();

test('C2 (board fb7c43fb N-3, expect RED today): pluginVersion() reads the WALK-UP root\'s plugin.json, not the STERLING_PLUGIN_ROOT-named planted tree\'s', () => {
  assert.ok(REAL_PLUGIN_JSON && typeof REAL_PLUGIN_JSON.version === 'string', 'fixture precondition: could not read this repo\'s own .claude-plugin/plugin.json — C2 cannot state its target claim without a known real version to compare against');

  const PLANTED_VERSION = '0.0.0-PLANTED-C2-DOES-NOT-EXIST-IN-THE-REAL-CLONE';
  const base = mkdtempSync(join(tmpdir(), 'sterling-h1-pluginversion-'));
  const planted = makePlantedMarkerRoot(base);
  writeFileSync(join(planted, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: PLANTED_VERSION }));

  const { dir: project, cleanup: cleanupProject } = makeH1Project();
  try {
    // REPAIR (coder-measured, 2026-09-06): runH1() hardcodes
    // STERLING_NO_BANNER: '1' in its base env, and pluginVersion()'s only
    // reachable output is the banner's version line — so with the banner
    // suppressed no version can ever reach any stream and the non-vacuity
    // assertion below could never pass. Override it here, for C2 only
    // (C1 and C3 keep it suppressed).
    const r = runH1(project, { STERLING_CURRENCY_DISABLE: '1', STERLING_PLUGIN_ROOT: planted, STERLING_NO_BANNER: '0' });
    assert.notEqual(r.code, null, `H1 must not crash — stderr=${flat(r.stderr)}`);
    assert.ok(r.out, `H1 must emit parseable JSON — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);

    assert.match(
      r.combined,
      /\d+\.\d+\.\d+/,
      `NON-VACUITY: H1 must report SOME version-shaped string at all, or the absence assertion below would mean nothing. combined=${flat(r.combined)}`
    );
    assert.doesNotMatch(
      r.combined,
      new RegExp(escapeRe(PLANTED_VERSION)),
      `pluginVersion() must resolve via walkUpPluginRoot(), never the env-first pluginRoot() (board fb7c43fb N-3). The planted tree's DISTINCTIVE version string must never appear in H1's output. combined=${flat(r.combined)}`
    );
    assert.ok(
      r.combined.includes(REAL_PLUGIN_JSON.version),
      `the reported version must be the REAL clone's version (${REAL_PLUGIN_JSON.version}), read via walk-up. combined=${flat(r.combined)}`
    );
  } finally {
    cleanupProject();
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: read the plugin version from the STERLING_PLUGIN_ROOT-named
// plugin.json instead of the walk-up root's — this pin goes red (the planted
// version string appears, or the real version disappears) while the
// non-vacuity regex assertion (a version-shaped string exists at all) stays
// green.

// =============================================================================
// SECTION 3 (C3) — THE STALE-SERVER GUARD'S server-dist RESOLUTION.
//
// Per feature_article 9c83b485: H1 compares packages/mcp-server/dist/.build-id
// (resolved via the plugin-root walk-up) against the project's runtime marker
// (<project>/.sterling/transient/mcp-runtime.json: {build_id, pid,
// booted_at}). A mismatch WARNS iff the marker's writer is not confirmed gone
// (decision 132177d2); on Linux a live pid whose /proc/<pid>/cmdline lacks
// 'mcp-server' is confirmed NOT the writer (decision c71d676f) and the marker
// is silently orphaned instead. So the marker's pid must be a LIVE process
// whose own invocation contains 'mcp-server', or a genuine mismatch would be
// silenced by the writer-identity gate rather than by the root question this
// pin is actually about.
// =============================================================================

function makePlantedServerDistRoot(base, buildId) {
  const dir = makePlantedMarkerRoot(base, 'planted-dist-root');
  mkdirSync(join(dir, 'packages', 'mcp-server', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'mcp-server', 'dist', '.build-id'), buildId);
  return dir;
}

function writeRuntimeMarker(projectDir, marker) {
  mkdirSync(join(projectDir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(projectDir, '.sterling', 'transient', 'mcp-runtime.json'), JSON.stringify(marker));
}

// A genuine, long-lived background process whose OWN invocation names a
// 'mcp-server'-looking script, so H1's Linux writer-identity check (decision
// c71d676f) classifies its pid as the (still-live) writer rather than
// orphaning the marker — which would otherwise silence the mismatch this pin
// needs to observe.
function spawnDecoyServerProcess(scratchDir) {
  const scriptPath = join(scratchDir, 'fixture-mcp-server-decoy.mjs');
  writeFileSync(scriptPath, 'setInterval(() => {}, 60_000);\n');
  return spawn(process.execPath, [scriptPath], { stdio: 'ignore' });
}

async function waitForProcCmdline(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      readFileSync(`/proc/${pid}/cmdline`);
      return;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`pid ${pid} never became live under /proc within ${timeoutMs}ms (${err && err.code})`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

test('C3-control (CONTROL, NON-VACUITY, expect GREEN today and after): an obviously-wrong marker build-id against a live, identity-matching writer WARNS in this fixture shape', async () => {
  const base = mkdtempSync(join(tmpdir(), 'sterling-h1-serverdist-control-'));
  const { dir: project, cleanup: cleanupProject } = makeH1Project();
  const decoy = spawnDecoyServerProcess(project);
  try {
    await waitForProcCmdline(decoy.pid);
    writeRuntimeMarker(project, { build_id: 'OBVIOUSLY-WRONG-CONTROL-VALUE-MATCHES-NOTHING', pid: decoy.pid, booted_at: new Date().toISOString() });
    const r = runH1(project, {});
    assert.notEqual(r.code, null, `H1 must not crash — stderr=${flat(r.stderr)}`);
    assert.match(
      r.combined,
      /restart|stale|out of date/i,
      `FIXTURE VALIDITY, checked before C3 is trusted as evidence: a build-id that matches NEITHER the real clone NOR any planted value, compared against a live writer with a matching cmdline, must WARN regardless of which root is consulted — if this is silent, the mismatch/liveness machinery is disabled or broken in this environment, and C3's result below would prove nothing about ROOT provenance specifically. combined=${flat(r.combined)}`
    );
  } finally {
    decoy.kill();
    cleanupProject();
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: none isolates this control by itself — it proves the mismatch+
// liveness machinery fires at all in this fixture shape; C3 is the pin that
// isolates WHICH root's .build-id was compared.

test('C3 (board fb7c43fb N-3, expect RED today): the stale-server guard reads .build-id from the WALK-UP root, not the STERLING_PLUGIN_ROOT-named planted tree', async () => {
  const PLANTED_BUILD_ID = 'PLANTED-BUILD-ID-C3-DOES-NOT-EXIST-IN-THE-REAL-CLONE';
  // REPAIR (coder-measured, 2026-09-06): the stale warning, BY DESIGN, prints
  // the marker's build_id verbatim on its "running" side — so a blanket
  // "PLANTED_BUILD_ID must appear nowhere" assertion contradicted the fixture,
  // which deliberately sets the marker's build_id to that literal. Narrowed to
  // the CURRENT side only, and strengthened by reading the REAL clone's
  // current build-id at test runtime (never hardcoded) so the assertion
  // states what the CURRENT side must equal, not just what it must not.
  const REAL_BUILD_ID = readFileSync(join(root, 'packages', 'mcp-server', 'dist', '.build-id'), 'utf8').trim();
  assert.ok(REAL_BUILD_ID.length > 0, 'fixture precondition: could not read this repo\'s own packages/mcp-server/dist/.build-id — C3 cannot state its target claim without a known real build-id to compare against');
  const base = mkdtempSync(join(tmpdir(), 'sterling-h1-serverdist-'));
  const planted = makePlantedServerDistRoot(base, PLANTED_BUILD_ID);
  const { dir: project, cleanup: cleanupProject } = makeH1Project();
  const decoy = spawnDecoyServerProcess(project);
  try {
    await waitForProcCmdline(decoy.pid);
    // The marker CLAIMS the build-id the PLANTED tree carries. If H1 reads the
    // current build-id from the planted tree (the env-seam bug), marker and
    // "current" agree and the verdict is FRESH — silent. If H1 correctly
    // walks up to the REAL clone, the real .build-id can only equal this
    // fixture literal by astronomical coincidence, so the verdict must be
    // STALE, and the writer (confirmed alive, cmdline naming this decoy
    // script) must not be silenced as orphaned.
    writeRuntimeMarker(project, { build_id: PLANTED_BUILD_ID, pid: decoy.pid, booted_at: new Date().toISOString() });

    const r = runH1(project, { STERLING_PLUGIN_ROOT: planted });
    assert.notEqual(r.code, null, `H1 must not crash — stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(
      r.combined,
      new RegExp(`current[^\\n]*${escapeRe(PLANTED_BUILD_ID)}`, 'i'),
      `the CURRENT side of the comparison (as opposed to the "running <marker build_id>" side, which legitimately echoes the planted literal by fixture design) must never be the PLANTED literal — its presence there means the planted tree's .build-id was read as CURRENT instead of the walk-up root's. combined=${flat(r.combined)}`
    );
    assert.ok(
      r.combined.includes(REAL_BUILD_ID),
      `the reported CURRENT build-id must be the REAL clone's actual .build-id (${REAL_BUILD_ID}, read at test runtime from packages/mcp-server/dist/.build-id — never hardcoded), proving the guard's server-dist resolution walked up rather than reading the planted tree. combined=${flat(r.combined)}`
    );
    assert.match(
      r.combined,
      /restart|stale|out of date/i,
      `feature_article 9c83b485 AC3: a marker whose build_id differs from the current build-id, with a writer not confirmed gone, must WARN. The marker's build_id (the planted literal) can only equal the REAL clone's actual .build-id by astronomical coincidence, so a correctly walked-up comparison MUST mismatch and MUST warn — compare C3-control, which proves the mismatch+liveness machinery fires in this exact fixture shape. combined=${flat(r.combined)}`
    );
  } finally {
    decoy.kill();
    cleanupProject();
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: resolve packages/mcp-server/dist/.build-id from the env-first
// pluginRoot() instead of walkUpPluginRoot() — this pin goes red (either the
// planted literal appears, meaning it was read and matched -> FRESH/silent, or
// no warning fires at all) while C3-control stays green (it never sets
// STERLING_PLUGIN_ROOT and never plants a competing .build-id).
