import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildSeamHook } from './lib/seam-hook.mjs';
import { renderInstalledAgent } from '../lib/agent-distribution.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
let ProjectRegistry;
let parseConfig;
// The seam-spawnable H15 bundle (decision 95c2c109 F2): H15 reads
// STERLING_PLUGIN_ROOT only when its own walk-up finds no plugin tree, so the
// one H15 test below that names a fixture root through the seam must spawn a
// bundle built into a marker-free temp dir, never the source under scripts/hooks/.
let H15_SEAM;
// Same F2 hardening applies to H1's pluginRoot() resolution
// (walkUpPluginRoot() || process.env.STERLING_PLUGIN_ROOT): scripts/hooks/h1-session-start.mjs
// lives inside THIS repo, so its own walk-up always finds this checkout and the
// STERLING_PLUGIN_ROOT seam goes inert. Every H1 test below that fakes the
// plugin root through that env var must spawn a bundle built into a
// marker-free temp dir instead, so the walk-up genuinely fails and the seam is
// legitimately reached (the same seam-hook shape H15 already uses).
let H1_SEAM;
after(() => {
  H15_SEAM?.cleanup();
  H1_SEAM?.cleanup();
});
before(async () => {
  H15_SEAM = await buildSeamHook('h15-store-guard.mjs');
  H1_SEAM = await buildSeamHook('h1-session-start.mjs');
  ({ SterlingStore, ProjectRegistry } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ parseConfig } = await import(pathToFileURL(join(root, 'packages', 'schemas', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd, env = {}) {
  return runHookAt(join(HOOKS, script), input, cwd, env);
}
// Same envelope, explicit hook path — for a bundle built outside scripts/hooks/.
function runHookAt(hookPath, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    // H1's clone-currency probe is disabled by default: this battery runs
    // DURING /sterling:update, so a hook test must never fetch. The currency
    // test re-enables it against a local file remote.
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
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

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  // The pressure tests' model is MAPPED (as the shipped default-config maps the
  // live tier models); the unmapped-model gauge warning has its own test.
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h5-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

function article(store, slug, files) {
  return store.create({
    ...envelope('feature_article'),
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: files.map((path) => ({ path, role: 'impl' })),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
  });
}

// --------------------------- H1 ---------------------------

test('H1: banner art to stderr (env-only suppression), counts to the human, conventions to Claude; quiet outside Sterling projects', () => {
  const ART_ROW = '▀▀▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ ▀▀▀ ▀  ▀ ▀▀▀▀'; // letterform row 3
  const { dir, store, cleanup } = makeProject();
  try {
    store.create({ ...envelope('todo'), text: 'a', source: 'user' });
    store.create({ ...envelope('todo'), text: 'b', source: 'user' });
    store.create({ ...envelope('todo'), text: 'm', source: 'system', system_reason: 'reconcile_needed' });
    const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '1' });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, /^2 tasks · 1 maintenance item pending/);
    // CHANGED 2026-09-19 (slice 3, conductor context diet): H1's hardcoded
    // conventions block (which carried "Anti-speculation") is deleted; H1 now
    // injects docs/conductor-contract.md verbatim. This runHook() spawn runs
    // scripts/hooks/h1-session-start.mjs from its real source location inside
    // this repo, so pluginRoot()'s walk-up finds the real clone and the real
    // contract file is read — its own heading is the new liveness marker.
    assert.match(out.hookSpecificOutput.additionalContext, /You are the delegator, not the worker/);
    assert.ok(r.stderr.includes(ART_ROW), 'banner art on stderr');
    assert.ok(!r.stderr.includes('\x1b['), 'NO_COLOR strips ANSI');
    assert.match(r.stderr, /v\d+\.\d+\.\d+/, 'plugin version read live (fail-open contract)');
    const colored = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '' });
    assert.ok(colored.stderr.includes('\x1b[38;2;'), 'truecolor gradient by default');
    const suppressed = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { STERLING_NO_BANNER: '1' });
    assert.equal(suppressed.code, 0);
    assert.ok(!suppressed.stderr.includes('▀'), 'STERLING_NO_BANNER=1 silences the art');
    assert.match(JSON.parse(suppressed.stdout).systemMessage, /^2 tasks/, 'counts line survives suppression');
  } finally {
    cleanup();
  }
  const bare = mkdtempSync(join(tmpdir(), 'sterling-bare-'));
  try {
    const r = runHook('h1-session-start.mjs', hookInput(bare, { hook_event_name: 'SessionStart' }), bare);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'no ceremony outside Sterling projects (P1)');
    assert.ok(!r.stderr.includes('▀'), 'no banner art outside Sterling projects (P1)');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('H1 deep-queue signal: a queue at threshold reaches the CONDUCTOR with its lane split; a shallow one stays silent to the model (P1)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // SHALLOW: counts still go to the human, nothing to the model. This is the
    // pre-existing contract and it must survive — an event-drained shallow queue
    // is noise to the conductor.
    for (let i = 0; i < 3; i++) {
      store.create({ ...envelope('todo'), text: `m${i}`, source: 'system', system_reason: 'reconcile_needed' });
    }
    const shallow = JSON.parse(runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '1' }).stdout);
    assert.match(shallow.systemMessage, /3 maintenance items pending/, 'the human still gets the count');
    assert.ok(!/MAINTENANCE QUEUE IS DEEP/.test(shallow.hookSpecificOutput.additionalContext), 'silent to the model below threshold');

    // DEEP: cross the configured threshold and the CONDUCTOR is told, because the
    // human seeing a number never drained anything — a consuming project reached
    // 63 items, most already-finished work never closed (reported 2026-07-29).
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ maintenance_queue: { deep_threshold: 5 } }));
    for (let i = 0; i < 2; i++) {
      store.create({ ...envelope('todo'), text: `a${i}`, source: 'system', system_reason: 'article_missing' });
    }
    const deep = JSON.parse(runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '1' }).stdout);
    const ctx = deep.hookSpecificOutput.additionalContext;
    assert.match(ctx, /MAINTENANCE QUEUE IS DEEP — 5 drainable items/);
    // Lane phrasing changed with board 18a22b56: "N item(s) in lane <reason>" —
    // the "×N" form collided with h1-accuracy's truncation-artifact guard.
    assert.match(ctx, /3 items in lane reconcile_needed/, 'the lane split says WHAT is owed, not just how much');
    assert.match(ctx, /2 items in lane article_missing/);
    assert.match(ctx, /\/sterling:drain/, 'and names the remedy');
    assert.match(ctx, /ALREADY DONE/, 'and warns that queue items are detected debt, not necessarily owed debt');
    // CHANGED 2026-09-19 (slice 3): see the note at :131 — same runHook() shape,
    // same real-contract marker.
    assert.match(ctx, /You are the delegator, not the worker/, 'the conductor-contract injection is unaffected');

    // file_parked closes at branch merge, never by drain — it must not trip the
    // drain signal (2026-08-09 consuming project: 15 by-design-open file_parked
    // items tripped this warning every session start; a standing warning about
    // undrainable items trains the operator to ignore the warning). Park enough
    // items to cross the threshold on their own: still silent.
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ maintenance_queue: { deep_threshold: 5 } }));
    const { dir: parkedDir, store: parkedStore, cleanup: cleanupParked } = makeProject();
    try {
      writeFileSync(join(parkedDir, '.sterling', 'config.json'), JSON.stringify({ maintenance_queue: { deep_threshold: 5 } }));
      for (let i = 0; i < 6; i++) {
        parkedStore.create({ ...envelope('todo'), text: `p${i}`, source: 'system', system_reason: 'file_parked' });
      }
      const parkedOnly = JSON.parse(runHook('h1-session-start.mjs', hookInput(parkedDir, { hook_event_name: 'SessionStart' }), parkedDir, { NO_COLOR: '1' }).stdout);
      assert.ok(
        !/MAINTENANCE QUEUE IS DEEP/.test(parkedOnly.hookSpecificOutput.additionalContext),
        'a queue of only file_parked items never cries wolf'
      );
      // With drainable items past the threshold, parked items are disclosed but
      // not counted, and never appear as a drainable lane.
      for (let i = 0; i < 5; i++) {
        parkedStore.create({ ...envelope('todo'), text: `r${i}`, source: 'system', system_reason: 'reconcile_needed' });
      }
      const mixed = JSON.parse(runHook('h1-session-start.mjs', hookInput(parkedDir, { hook_event_name: 'SessionStart' }), parkedDir, { NO_COLOR: '1' }).stdout);
      const mixedCtx = mixed.hookSpecificOutput.additionalContext;
      assert.match(mixedCtx, /MAINTENANCE QUEUE IS DEEP — 5 drainable items/);
      assert.match(mixedCtx, /plus 6 file_parked \(close at branch merge, not by drain — excluded from this count\)/);
      assert.ok(!/file_parked ×/.test(mixedCtx), 'file_parked never appears as a drainable lane');
      assert.match(mixed.systemMessage, /11 maintenance items pending/, 'the HUMAN banner still reports the true total, parked included');
    } finally {
      cleanupParked();
    }

    // A malformed config costs the THRESHOLD, never the conventions: H1 is soft,
    // unlike the gates that fail closed on this same input (anti_pattern e13f0fb5).
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not json');
    const broken = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '1' });
    assert.equal(broken.code, 0, broken.stderr);
    assert.match(JSON.parse(broken.stdout).hookSpecificOutput.additionalContext, /You are the delegator, not the worker/, 'the conductor-contract injection survives a corrupt config');
  } finally {
    cleanup();
  }
});

test('H1 machine role (todo cabbc10f, decision a9b98b7d): stated only on a Sterling clone itself, one line per declared state', () => {
  const { dir, cleanup } = makeProject();
  try {
    // STERLING_PLUGIN_ROOT makes this tmp project LOOK like the plugin's own
    // clone to pluginRoot() — but only when the SPAWNED hook's own walk-up
    // fails to find a real plugin tree first (decision 95c2c109 F2). Spawning
    // scripts/hooks/h1-session-start.mjs from its source location inside THIS
    // repo would let that walk-up win every time and ignore the fixture, so
    // this fakes the plugin root through H1_SEAM.hookPath — a bundle built
    // into a marker-free temp dir where the walk-up genuinely fails and the
    // env seam is legitimately reached.
    const selfHosted = { NO_COLOR: '1', STERLING_PLUGIN_ROOT: dir };

    // absent → UNDECLARED, the safe posture
    const undeclared = JSON.parse(runHookAt(H1_SEAM.hookPath, hookInput(dir, { hook_event_name: 'SessionStart' }), dir, selfHosted).stdout);
    assert.match(undeclared.hookSpecificOutput.additionalContext, /MACHINE ROLE: UNDECLARED — treat as CONSUMER/);

    // declared 'authoring'
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ machine_role: 'authoring' }));
    const authoring = JSON.parse(runHookAt(H1_SEAM.hookPath, hookInput(dir, { hook_event_name: 'SessionStart' }), dir, selfHosted).stdout);
    assert.match(authoring.hookSpecificOutput.additionalContext, /MACHINE ROLE: AUTHORING \(declared in \.sterling\/config\.json machine_role\)/);

    // declared 'consumer'
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ machine_role: 'consumer' }));
    const consumer = JSON.parse(runHookAt(H1_SEAM.hookPath, hookInput(dir, { hook_event_name: 'SessionStart' }), dir, selfHosted).stdout);
    assert.match(consumer.hookSpecificOutput.additionalContext, /MACHINE ROLE: CONSUMER — this clone consumes via \/sterling:update/);
    // CHANGED 2026-09-19 (slice 3): H1's hardcoded conventions block is
    // deleted; H1 now reads docs/conductor-contract.md from pluginRoot(). This
    // fixture's STERLING_PLUGIN_ROOT (`dir`, a bare makeProject() tmp dir) has
    // no docs/ subdirectory, so the read genuinely fails and H1's fail-LOUD
    // fallback fires — asserting that fallback text is present is itself the
    // "never a crash, always something rendered" proof this line existed for.
    assert.match(consumer.hookSpecificOutput.additionalContext, /CONDUCTOR CONTRACT UNAVAILABLE/, 'the contract fallback still renders alongside the role line');

    // NOT a clone (no STERLING_PLUGIN_ROOT override — and the seam bundle's
    // marker-free temp location means its own walk-up finds no plugin tree
    // either): no role line at all, even with machine_role declared.
    const notAClone = JSON.parse(runHookAt(H1_SEAM.hookPath, hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '1' }).stdout);
    assert.ok(!/MACHINE ROLE/.test(notAClone.hookSpecificOutput.additionalContext), 'no role line off the plugin\'s own clone');
  } finally {
    cleanup();
  }
});

test('H1 machine role (isolates the notAClone arm at :290-291): a fixture root with NO .claude-plugin marker at all never renders a MACHINE ROLE line', () => {
  // Isolates the notAClone arm above (:290-291) as its own standalone pin —
  // it does NOT cover board fb7c43fb (b)'s separately-named "root resolves
  // but differs from cwd" branch, which needs a DIFFERENT, marker-carrying
  // fixture root (see RW-5 in h1-receipt-remedy-wording.test.mjs for that
  // shape) and remains unexercised here. makeProject()'s dir carries no
  // .claude-plugin marker of any kind, and H1_SEAM.hookPath is a bundle
  // built into a marker-free temp dir (decision 95c2c109 F2) — so both the
  // project cwd's walk-up AND the hook's own walk-up find no plugin tree,
  // with no STERLING_PLUGIN_ROOT override to name a differing root either:
  // this is the unresolvable-root path only.
  const { dir, cleanup } = makeProject();
  try {
    const r = JSON.parse(runHookAt(H1_SEAM.hookPath, hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '1' }).stdout);
    const ctx = r.hookSpecificOutput.additionalContext;
    // NON-VACUITY, checked before the absence claim is trusted: without this,
    // `/MACHINE ROLE/.test(undefined)` tests the literal string "undefined"
    // and passes vacuously even if H1 crashed or returned garbage instead of
    // real additionalContext.
    assert.equal(typeof ctx, 'string', 'additionalContext must be a real string, not absent/undefined');
    // CHANGED 2026-09-19 (slice 3): see the note at :254 — no resolvable plugin
    // root here either, so H1's fail-LOUD contract fallback is the proof of
    // real (non-crashed) rendering.
    assert.match(ctx, /CONDUCTOR CONTRACT UNAVAILABLE/, 'H1 produced its normal banner — proof the hook actually ran and rendered content, not that it crashed silently');
    assert.ok(!/MACHINE ROLE/.test(ctx), 'no role line off the plugin\'s own clone');
  } finally {
    cleanup();
  }
});
// Named sabotage: render a MACHINE ROLE line (of any state — UNDECLARED,
// AUTHORING, or CONSUMER) when pluginRoot() resolves to null instead of
// suppressing the line entirely — this test goes red.

test('H1 machine role: a malformed config on the plugin\'s own clone costs only the role line\'s specificity, never a crash', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not json');
    // H1_SEAM.hookPath (decision 95c2c109 F2, see the block comment above): the
    // source hook's own walk-up would find THIS repo and ignore the
    // STERLING_PLUGIN_ROOT fixture below.
    const r = runHookAt(H1_SEAM.hookPath, hookInput(dir, { hook_event_name: 'SessionStart' }), dir, {
      NO_COLOR: '1',
      STERLING_PLUGIN_ROOT: dir,
    });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    // CHANGED 2026-09-19 (slice 3): see the note at :254 — this fixture's
    // STERLING_PLUGIN_ROOT has no docs/ subdirectory, so H1's fail-LOUD
    // fallback is what "never a crash" now looks like.
    assert.match(out.hookSpecificOutput.additionalContext, /CONDUCTOR CONTRACT UNAVAILABLE/, 'the contract fallback survives a corrupt config even on the self-hosted clone');
    assert.match(out.hookSpecificOutput.additionalContext, /MACHINE ROLE: UNDECLARED/, 'a malformed config reads as absent, the safe default — never a crash');
  } finally {
    cleanup();
  }
});

test('H1 clone-currency signal (the gap decision be9168e8 parked): a consumer clone behind origin warns BOTH surfaces; current or declared-authoring stays silent', () => {
  const { dir, cleanup } = makeProject();
  const base = mkdtempSync(join(tmpdir(), 'sterling-currency-'));
  // real git against a LOCAL file remote — the probe's fetch works offline
  const sh = (cwd, args) => {
    const r = spawnSync('git', ['-c', 'user.email=t@sterling.test', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  try {
    const origin = join(base, 'origin.git');
    const author = join(base, 'author');
    const clone = join(base, 'clone');
    mkdirSync(author);
    sh(base, ['init', '--bare', '--initial-branch=main', origin]);
    sh(base, ['init', '--initial-branch=main', author]);
    writeFileSync(join(author, 'f.txt'), 'v1\n');
    sh(author, ['add', '-A']);
    sh(author, ['commit', '-m', 'one']);
    sh(author, ['remote', 'add', 'origin', origin]);
    sh(author, ['push', '-u', 'origin', 'main']);
    sh(base, ['clone', origin, clone]);
    // origin moves ahead of the clone
    writeFileSync(join(author, 'f.txt'), 'v2\n');
    sh(author, ['add', '-A']);
    sh(author, ['commit', '-m', 'two']);
    sh(author, ['push']);

    // TTL 0 → the fetch throttle never reads as fresh, so each run probes.
    // Spawned via H1_SEAM.hookPath (decision 95c2c109 F2, see the block comment
    // above): the source hook's own walk-up would find THIS repo (whose
    // .sterling/config.json declares machine_role: authoring) and the
    // STERLING_PLUGIN_ROOT=clone fixture below would never be consulted at all.
    const env = { NO_COLOR: '1', STERLING_PLUGIN_ROOT: clone, STERLING_CURRENCY_DISABLE: '0', STERLING_CURRENCY_TTL_MS: '0' };
    const behind = JSON.parse(runHookAt(H1_SEAM.hookPath, hookInput(dir, { hook_event_name: 'SessionStart' }), dir, env).stdout);
    assert.match(behind.systemMessage, /Sterling is 1 update\(s\) behind/, 'the human is told, with the double-click remedy');
    assert.match(behind.systemMessage, /sterling-update\.bat/);
    assert.match(behind.hookSpecificOutput.additionalContext, /STERLING CLONE IS BEHIND \(H1\)/, 'the conductor is told');
    // CHANGED 2026-09-19 (slice 3): see the note at :254 — the fixture `clone`
    // git repo has no docs/conductor-contract.md, so the fail-LOUD fallback is
    // what "intact alongside the signal" now means.
    assert.match(behind.hookSpecificOutput.additionalContext, /CONDUCTOR CONTRACT UNAVAILABLE/, 'the contract fallback is intact alongside the signal');
    assert.ok(existsSync(join(clone, '.git', 'sterling-update-check.json')), 'the fetch throttle is stamped');

    // fast-forward the clone → silent IMMEDIATELY: behind is computed locally
    // per session, never served from the cache
    sh(clone, ['merge', '--ff-only', 'origin/main']);
    const current = JSON.parse(runHookAt(H1_SEAM.hookPath, hookInput(dir, { hook_event_name: 'SessionStart' }), dir, env).stdout);
    assert.doesNotMatch(current.systemMessage, /behind/, 'silent once current (P1)');
    assert.doesNotMatch(current.hookSpecificOutput.additionalContext, /STERLING CLONE IS BEHIND/);

    // a declared-authoring clone is never probed, even when genuinely behind
    // (it lives on branches and ahead-of-origin states, where "behind" is noise)
    writeFileSync(join(author, 'f.txt'), 'v3\n');
    sh(author, ['add', '-A']);
    sh(author, ['commit', '-m', 'three']);
    sh(author, ['push']);
    mkdirSync(join(clone, '.sterling'), { recursive: true });
    writeFileSync(join(clone, '.sterling', 'config.json'), JSON.stringify({ machine_role: 'authoring' }));
    const authoring = JSON.parse(runHookAt(H1_SEAM.hookPath, hookInput(dir, { hook_event_name: 'SessionStart' }), dir, env).stdout);
    assert.doesNotMatch(authoring.systemMessage, /behind/, 'authoring machines opt out via their declared role');
  } finally {
    cleanup();
    rmSync(base, { recursive: true, force: true });
  }
});

test('H1: shared project registry — touches this project last_seen + makes the CONDUCTOR aware of live siblings via additionalContext, not systemMessage (decision 8f9e6db2)', () => {
  const { dir, cleanup } = makeProject();
  const regPath = join(dir, 'registry.db');
  const cwdPosix = dir.replace(/\\/g, '/');
  try {
    const seed = new ProjectRegistry(regPath);
    try {
      seed.register({ repo_path: cwdPosix, name: 'current', stack_tags: ['node'], toolchains: ['node'], sterling_version: '0.1.0', at: NOW });
      seed.register({ repo_path: root.replace(/\\/g, '/'), name: 'sib-live', stack_tags: ['node'], toolchains: ['node'], sterling_version: '0.1.0', at: NOW }); // root exists
      seed.register({ repo_path: 'C:/nope/gone-xyz', name: 'sib-missing', stack_tags: ['genesys'], toolchains: ['node'], sterling_version: '0.1.0', at: NOW });
    } finally {
      seed.close();
    }

    const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '1', STERLING_REGISTRY_DB: regPath });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    // CONDUCTOR awareness goes to additionalContext (Claude's context), with the
    // live sibling + its domains; the human systemMessage stays counts-only.
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /Sibling Sterling projects/);
    assert.match(ctx, /- sib-live: node/, 'live sibling listed with its domains');
    // CHANGED 2026-09-19 (slice 3): see the note at :131 — real runHook() spawn,
    // real contract file read.
    assert.match(ctx, /You are the delegator, not the worker/, 'the conductor-contract injection is still present');
    assert.doesNotMatch(ctx, /sib-missing/, 'a missing (stale) sibling is excluded from conductor awareness');
    assert.doesNotMatch(out.systemMessage, /sibling/, 'the human systemMessage is not used for sibling awareness');
    assert.match(out.systemMessage, /pending$/, 'systemMessage is counts-only');

    // last_seen touched for THIS project only
    const after = new ProjectRegistry(regPath);
    try {
      const me = after.list().find((p) => p.repo_path === cwdPosix);
      assert.ok(me.last_seen_at && /^\d{4}-\d{2}-\d{2}T/.test(me.last_seen_at), 'this project last_seen_at touched at session start');
      assert.equal(after.list().find((p) => p.repo_path === 'C:/nope/gone-xyz').last_seen_at, null, 'a sibling is NOT touched');
    } finally {
      after.close();
    }
  } finally {
    cleanup();
  }
});

test('H1 machine-activation guard: unresolvable baked hook node warns human + conductor; resolvable or foreign installs stay quiet (anti_pattern 60e8463d)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const template = [
      '---',
      'name: probe-agent',
      'description: machine-guard fixture',
      'tools: Read',
      'hooks:',
      '  PreToolUse:',
      '    - matcher: "Read"',
      '      hooks:',
      '        - type: command',
      "          command: '{{NODE}} \"{{HOOKS_DIR}}/h.mjs\"'",
      '---',
      '',
      'Body.',
      '',
    ].join('\n');
    // baked by "another machine": the node path does not resolve here
    const flipped = renderInstalledAgent(template, 'probe-agent.md', {
      pluginVersion: '0.1.0',
      now: NOW,
      vars: { NODE: '"/other-context/bin/node"', HOOKS_DIR: '/other-context/hooks' },
    }).installedContent;
    writeFileSync(join(agentsDir, 'probe-agent.md'), flipped);
    const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '1', STERLING_NO_BANNER: '1' });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, /baked for ANOTHER machine context/, 'human warned in systemMessage');
    assert.match(out.systemMessage, /probe-agent\.md/, 'offending agent named');
    assert.match(out.hookSpecificOutput.additionalContext, /MACHINE-CONTEXT DRIFT \(H1/, 'conductor told in additionalContext');
    // 2026-09-19 deliberate change (4): H1 compresses machine-drift notices
    // to counted state lines with names instead of sync-status jargon.
    assert.match(out.hookSpecificOutput.additionalContext, /sync-agents/i, 'recovery path names the sync repair');

    // this machine's node AND hook script resolve — quiet
    const liveHooksDir = join(dir, 'hooks-live');
    mkdirSync(liveHooksDir, { recursive: true });
    writeFileSync(join(liveHooksDir, 'h.mjs'), '// probe fixture');
    const activated = renderInstalledAgent(template, 'probe-agent.md', {
      pluginVersion: '0.1.0',
      now: NOW,
      vars: { NODE: `"${process.execPath.replace(/\\/g, '/')}"`, HOOKS_DIR: liveHooksDir.replace(/\\/g, '/') },
    }).installedContent;
    writeFileSync(join(agentsDir, 'probe-agent.md'), activated);
    const quiet = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '1', STERLING_NO_BANNER: '1' });
    const qo = JSON.parse(quiet.stdout);
    assert.doesNotMatch(qo.systemMessage, /machine context/, 'resolvable node stays quiet');
    assert.doesNotMatch(qo.hookSpecificOutput.additionalContext, /MACHINE-CONTEXT DRIFT/);

    // a foreign (non-generated) file is never judged
    writeFileSync(join(agentsDir, 'hand-made.md'), "---\nname: hand-made\n---\ncommand: '\"/other-context/bin/node\" \"/x/h.mjs\"'\n");
    const foreign = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '1', STERLING_NO_BANNER: '1' });
    assert.doesNotMatch(JSON.parse(foreign.stdout).systemMessage, /machine context/, 'foreign files are not ours to judge');
  } finally {
    cleanup();
  }
});

test('H1 stale-server guard: a marker build-id differing from the current build warns the human to restart; matching, absent, or orphaned (dead or reused-pid writer) is silent (P1)', async () => {
  const { dir, cleanup } = makeProject();
  const serverDist = mkdtempSync(join(tmpdir(), 'sterling-dist-'));
  const markerPath = join(dir, '.sterling', 'transient', 'mcp-runtime.json');
  // The genuinely-stale RUNNING-server case needs a live writer that the identity
  // probe recognizes as the server: a decoy child whose cmdline carries the
  // 'mcp-server' marker substring (real servers run .../packages/mcp-server/dist).
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'mcp-server-decoy'], { stdio: 'ignore' });
  const writeMarker = (buildId, pid) => {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ build_id: buildId, pid, booted_at: NOW }));
  };
  const run = () =>
    JSON.parse(
      runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, {
        NO_COLOR: '1',
        STERLING_NO_BANNER: '1',
        STERLING_SERVER_DIST: serverDist,
      }).stdout
    );
  try {
    writeFileSync(join(serverDist, '.build-id'), 'BUILD_CURRENT');
    if (process.platform === 'linux') {
      // wait until the decoy has exec'd (its /proc cmdline shows the decoy argv)
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          if (readFileSync(`/proc/${decoy.pid}/cmdline`, 'utf8').includes('mcp-server-decoy')) break;
        } catch {}
        assert.ok(Date.now() < deadline, 'decoy server process failed to start');
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    // fresh: the running server's recorded build matches the current build → no warning
    writeMarker('BUILD_CURRENT', decoy.pid);
    let out = run();
    assert.doesNotMatch(out.systemMessage, /STALE/, 'matching build-id → no stale warning');
    assert.match(out.systemMessage, /^0 tasks/, 'systemMessage is counts-only when fresh');

    // stale: the running server (live writer, server cmdline) predates the current
    // build → loud restart warning — the case the guard exists for
    writeMarker('BUILD_OLD', decoy.pid);
    out = run();
    assert.match(out.systemMessage, /STALE.*running build BUILD_OLD.*current BUILD_CURRENT/s, 'mismatch → stale warning naming both builds');
    assert.match(out.systemMessage, /RESTART THE SESSION/);
    assert.match(out.systemMessage, /pending$/, 'the counts line still follows the warning');

    // absent marker → unknown, never a false alarm (first boot / pre-guard server)
    rmSync(markerPath, { force: true });
    out = run();
    assert.doesNotMatch(out.systemMessage, /STALE/, 'no marker → no warning (P1: no false alarm)');

    // orphaned marker: a stale build-id whose WRITER process is DEAD — the server
    // we just replaced on restart, before the freshly-spawned one overwrote the
    // marker. There is no SessionStart↔server-boot ordering guarantee, so H1 can
    // read it first; the pid-liveness gate must NOT cry wolf here (the
    // restart-after-rebuild false positive this fix closes).
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid; // child has exited by the time spawnSync returns
    writeMarker('BUILD_OLD', deadPid);
    out = run();
    assert.doesNotMatch(out.systemMessage, /STALE/, 'stale build-id but DEAD writer pid → orphaned marker → no warning (P1)');

    // reused pid: after a reboot (pid numbering resets — the WSL case, observed
    // 2026-07-02) the orphan marker's pid can point at a LIVE but UNRELATED
    // process; kill(0) alone reports "alive" and cries wolf. The Linux identity
    // probe reads /proc/<pid>/cmdline and confirms not-the-writer → silent.
    if (process.platform === 'linux') {
      writeMarker('BUILD_OLD', process.pid); // this test process: live, cmdline is the node test runner — not an mcp-server
      out = run();
      assert.doesNotMatch(out.systemMessage, /STALE/, 'stale build-id but the live pid is NOT an mcp-server → reused pid → no warning (P1)');
    }
  } finally {
    decoy.kill('SIGKILL');
    rmSync(serverDist, { recursive: true, force: true });
    cleanup();
  }
});

// --------------------------- H2 ---------------------------

test('H2: selection row consumed one-shot, transactionally, from the store — never a file (P4)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const d = store.create({ ...envelope('decision'), title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' });
    store.writeSelection('decision', d.id, NOW);
    const r1 = runHook('h2-selection-inject.mjs', hookInput(dir, { hook_event_name: 'UserPromptSubmit' }), dir);
    assert.match(JSON.parse(r1.stdout).hookSpecificOutput.additionalContext, new RegExp(d.id));
    const r2 = runHook('h2-selection-inject.mjs', hookInput(dir, { hook_event_name: 'UserPromptSubmit' }), dir);
    assert.equal(r2.stdout, '', 'one-shot: second prompt sees nothing');
    assert.equal(existsSync(join(dir, '.sterling', 'selection.json')), false, 'no signal file exists');
  } finally {
    cleanup();
  }
});

// board c198866d: direct-mode Arm 1 stops minting reconcile_needed at TOUCH
// time — it only registers the candidate path in touches.json (Arm 2,
// unchanged). Minting moves to SETTLEMENT (H10's Stop), hashing final touched
// content against the owning record's file_baselines (sha256 of the owned
// file's bytes, decision 57d9a52d). Pipeline-mode minting-on-touch is
// UNCHANGED (untouched below).
// Restored here (its original position sat between the deleted H4 test and
// this one — swept away with that test's segment by my line-range deletion,
// same class of gap as H16_REGISTER above).
function sha256hex(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const reconcileQueue = (store) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'reconcile_needed');
const settleStop = (dir) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

test('H7 [direct]: touch registers as a settlement candidate (NO immediate mint); settlement at Stop mints exactly once, deduped per article (board c198866d)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const original = 'export const a = 1;\n';
    const changed = 'export const a = 2;\n';
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), changed);
    const a = store.create({
      ...envelope('feature_article'),
      slug: 'feat-a',
      title: 'feat-a',
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path: 'src/a.mjs', role: 'impl' }],
      file_baselines: { 'src/a.mjs': sha256hex(original) },
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'originating brief' }],
      live_test_refs: [],
    });
    const edit = () =>
      runHook('h7-file-touch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'a.mjs') } }), dir);
    assert.equal(edit().code, 0);
    assert.equal(edit().code, 0);

    // NEW CONTRACT: no mint at touch time, however many times the file was touched.
    assert.equal(reconcileQueue(store).length, 0, 'H7 Arm 1 no longer mints reconcile_needed at touch time — minting moves to settlement');

    const touches = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'touches.json'), 'utf8'));
    assert.equal(touches.length, 2, 'the candidate register (Arm 2) is unchanged — still one entry per touch');
    assert.equal(touches[0].path, 'src/a.mjs');

    // .git/** is machinery, never governed work (live incident 2026-06-12:
    // a commit-message temp file fed H10 a junk article demand) — unchanged.
    const gitWrite = runHook(
      'h7-file-touch.mjs',
      hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(dir, '.git', 'COMMIT_MSG_TMP.txt') } }),
      dir
    );
    assert.equal(gitWrite.code, 0);
    const after = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'touches.json'), 'utf8'));
    assert.equal(after.length, 2, '.git/** paths never enter the touch register');

    // SETTLEMENT: satisfy the capture duty so Stop releases clean on the first
    // call, then mint happens as a side effect of settlement, deduped per article.
    // h7-file-touch.mjs ran as a real subprocess and stamped touches.json with a
    // genuine new Date() (today), NOT the file's fixed NOW constant — the capture
    // record must postdate that real touch or the capture duty stays unmet.
    store.create({ ...envelope('decision', new Date(Date.now() + 1000).toISOString()), title: 'learned things', statement: 's', alternatives_rejected: [], rationale: 'r' });
    const stop = settleStop(dir);
    assert.equal(stop.code, 0, `settlement Stop must release clean once capture is satisfied and the file is owned — stderr=${stop.stderr}`);

    const queue = reconcileQueue(store);
    assert.equal(queue.length, 1, 'settlement mints exactly once, deduped per article, despite two prior touches');
    assert.equal(queue[0].feature_link, a.id);
  } finally {
    cleanup();
  }
});

test('working_tree records are invisible to root-session ownership (comsoft-juiced): H7 never flags them on a root touch; H10 does not count them as owners', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // a detached-copy article owning the same rel path a root session touches
    store.create({
      ...envelope('feature_article'),
      slug: 'juiced-mods',
      title: 'juiced-mods',
      what_it_does: 'x',
      intended_behavior: 'x',
      working_tree: 'juiced',
      files: [{ path: 'src/a.mjs', role: 'impl' }, { path: 'src/b.mjs', role: 'impl' }, { path: 'src/c.mjs', role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'copy article' }],
      live_test_refs: [],
    });
    // H7: a root touch of src/a.mjs must NOT reconcile-flag the copy article
    const edit = runHook('h7-file-touch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'a.mjs') } }), dir);
    assert.equal(edit.code, 0);
    assert.equal(
      store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'reconcile_needed').length,
      0,
      'a same-named root path is not the copy article’s file — no reconcile item'
    );
    // H10: the copy article grants NO ownership — three root touches in its
    // declared paths are UNOWNED at threshold and the article demand fires
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (const f of ['src/a.mjs', 'src/b.mjs', 'src/c.mjs']) writeFileSync(join(dir, f), 'x');
    writeFileSync(
      join(dir, '.sterling', 'transient', 'touches.json'),
      JSON.stringify(['src/a.mjs', 'src/b.mjs', 'src/c.mjs'].map((path) => ({ path, at: NOW })))
    );
    const stop = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(stop.code, 2, 'unowned at threshold — the copy article does not satisfy root ownership');
    assert.match(stop.stderr, /article demand/i);
  } finally {
    cleanup();
  }
});

function referenceDoc(store, title, kind, location) {
  return store.create({
    ...envelope('reference_material'),
    title,
    kind,
    location,
    summary: 'section map',
    source_date: NOW,
    capture_date: NOW,
    basis: 'codebase',
  });
}

test('H7 [§3.2.5 direct]: touch registers as a settlement candidate (NO immediate mint); settlement at Stop mints reconcile_needed for a repo-located reference doc (deduped); url-kind trips nothing (board c198866d)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const original = 'section map v1\n';
    const changed = 'section map v2\n';
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'spec.md'), changed);
    const doc = store.create({
      ...envelope('reference_material'),
      title: 'Build Spec',
      kind: 'doc',
      location: 'docs/spec.md',
      summary: 'section map',
      source_date: NOW,
      capture_date: NOW,
      basis: 'codebase',
      file_baselines: { 'docs/spec.md': sha256hex(original) },
    });
    referenceDoc(store, 'External', 'url', 'https://example.com/spec');
    const edit = () =>
      runHook('h7-file-touch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'docs', 'spec.md') } }), dir);
    assert.equal(edit().code, 0);
    assert.equal(edit().code, 0);

    // NEW CONTRACT: no mint at touch time.
    assert.equal(reconcileQueue(store).length, 0, 'H7 Arm 1 no longer mints at touch time for reference docs either — minting moves to settlement');
    const touches = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'touches.json'), 'utf8'));
    assert.ok(touches.some((t) => t.path === 'docs/spec.md'), 'the touch still registers as a settlement candidate (Arm 2 unchanged)');

    // SETTLEMENT: satisfy the capture duty so Stop releases clean on the first call.
    // h7-file-touch.mjs ran as a real subprocess and stamped touches.json with a
    // genuine new Date() (today), NOT the file's fixed NOW constant — the capture
    // record must postdate that real touch or the capture duty stays unmet.
    store.create({ ...envelope('decision', new Date(Date.now() + 1000).toISOString()), title: 'learned things', statement: 's', alternatives_rejected: [], rationale: 'r' });
    const stop = settleStop(dir);
    assert.equal(stop.code, 0, `settlement Stop must release clean — stderr=${stop.stderr}`);

    const queue = reconcileQueue(store);
    assert.equal(queue.length, 1, 'doc reference marked once at settlement (deduped); the url reference never');
    assert.equal(queue[0].feature_link, doc.id);
    assert.match(queue[0].text, /refresh summary \+ source_date/);
  } finally {
    cleanup();
  }
});

test('H10: capture nag once (no reviewer-selection block — board cac61a95, that is H2s job), then capture_owed and release; capture clears it', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'src', 'auth', 'login.mjs'), '// x\n');
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify([{ path: 'src/auth/login.mjs', at: NOW }]));
    const stop = (over = {}) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop', ...over }), dir);

    const nag = stop();
    assert.equal(nag.code, 2);
    assert.match(nag.stderr, /nothing was captured/);
    assert.doesNotMatch(nag.stderr, /Reviewer selection for this diff/, 'the reviewer-selection block is demoted out of the H10 nag (board cac61a95)');
    assert.doesNotMatch(nag.stderr, /"reviewer":/, 'no reviewer-selection JSON leaks into the capture nag');

    const second = stop();
    assert.equal(second.code, 0, 'second stop releases the session');
    const owed = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'capture_owed');
    assert.equal(owed.length, 1);
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'touches.json')), false, 'register cleared (P4)');
  } finally {
    cleanup();
  }
  const captured = makeProject();
  try {
    mkdirSync(join(captured.dir, 'src'), { recursive: true });
    writeFileSync(join(captured.dir, 'src', 'a.mjs'), '// x\n');
    mkdirSync(join(captured.dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(captured.dir, '.sterling', 'transient', 'touches.json'), JSON.stringify([{ path: 'src/a.mjs', at: NOW }]));
    captured.store.create({ ...envelope('decision', '2026-06-10T13:00:00.000Z'), title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' });
    const r = runHook('h10-direct-capture.mjs', hookInput(captured.dir, { hook_event_name: 'Stop' }), captured.dir);
    assert.equal(r.code, 0, 'capture after the touches satisfies H10');
    assert.equal(existsSync(join(captured.dir, '.sterling', 'transient', 'touches.json')), false);
  } finally {
    captured.cleanup();
  }
});

function touchRegister(dir, paths) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n'); // H10 acts only on files that still exist
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at: NOW }))));
}

function captureDecision(store) {
  store.create({
    ...envelope('decision', '2026-06-10T13:00:00.000Z'),
    title: 'learned things',
    statement: 's',
    alternatives_rejected: [],
    rationale: 'r',
  });
}

test('H10 article demand (§6): capture alone does not satisfy unowned territory at threshold; article_missing survives the session', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
    captureDecision(store);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'capture alone does not satisfy the article demand');
    assert.match(nag.stderr, /article demand/);
    assert.match(nag.stderr, /no owner \(feature_article or repo-located reference doc\)/);
    assert.doesNotMatch(nag.stderr, /nothing was captured/, 'the capture duty itself is satisfied');

    const release = stop();
    assert.equal(release.code, 0, 'second stop releases the session (P1)');
    const missing = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'article_missing');
    assert.equal(missing.length, 1, 'the owed article survives as a durable item');
    assert.deepEqual([...missing[0].file_keys].sort(), ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'touches.json')), false, 'register cleared (P4)');
  } finally {
    cleanup();
  }
});

test('H10 article demand: creating the owning article clears the demand mechanically; under-threshold stays advisory-level', () => {
  const owned = makeProject();
  try {
    touchRegister(owned.dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
    captureDecision(owned.store);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(owned.dir, { hook_event_name: 'Stop' }), owned.dir);
    assert.equal(stop().code, 2, 'demand raised');
    article(owned.store, 'feat-x', ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
    assert.equal(stop().code, 0, 'ownership satisfies the demand');
    assert.equal(owned.store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'article_missing').length, 0, 'no item once owned');
  } finally {
    owned.cleanup();
  }
  const small = makeProject();
  try {
    touchRegister(small.dir, ['src/x.mjs', 'src/y.mjs']);
    captureDecision(small.store);
    const r = runHook('h10-direct-capture.mjs', hookInput(small.dir, { hook_event_name: 'Stop' }), small.dir);
    assert.equal(r.code, 0, 'two unowned files are under the default threshold of 3');
    assert.equal(small.store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'article_missing').length, 0);
  } finally {
    small.cleanup();
  }
  // a governing document's owner is its repo-located reference_material record
  // (§3.2.5) — the demand join matches H7's (adjudicated 2026-06-12 after the
  // spec itself was demanded a feature article); 3 docs = at threshold, so this
  // passes ONLY through the reference_material side of the join
  const docs = makeProject();
  try {
    touchRegister(docs.dir, ['docs/a.md', 'docs/b.md', 'docs/c.md']);
    captureDecision(docs.store);
    referenceDoc(docs.store, 'Doc A', 'doc', 'docs/a.md');
    referenceDoc(docs.store, 'Doc B', 'doc', 'docs/b.md');
    referenceDoc(docs.store, 'Doc C', 'doc', 'docs/c.md');
    const r = runHook('h10-direct-capture.mjs', hookInput(docs.dir, { hook_event_name: 'Stop' }), docs.dir);
    assert.equal(r.code, 0, 'reference-doc ownership satisfies the article demand');
    assert.equal(docs.store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'article_missing').length, 0);
  } finally {
    docs.cleanup();
  }
});

test('H10 article demand: an open article_missing item with overlapping file keys is not duplicated', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
    captureDecision(store);
    store.create({
      ...envelope('todo'),
      text: 'article missing: earlier session',
      source: 'system',
      system_reason: 'article_missing',
      file_keys: ['src/x.mjs'],
      author: 'system',
    });
    // a non-overlapping article_missing item (other territory) must NOT suppress —
    // pins overlap-scoped dedup against a reason-wide-dedup mutant
    store.create({
      ...envelope('todo'),
      text: 'article missing: unrelated territory',
      source: 'system',
      system_reason: 'article_missing',
      file_keys: ['lib/unrelated.mjs'],
      author: 'system',
    });
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(stop().code, 2);
    assert.equal(stop().code, 0);
    const items = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'article_missing');
    assert.equal(items.length, 2, 'overlapping item dedupes; non-overlapping item does not suppress');
    // Superseded pin (board f30b9263, 2026-08-20): suppress-WITHOUT-refresh let items
    // go stale while the situation escalated — the surviving item now updates in
    // place through enqueueSystemTodo (same key + different text → refresh).
    const refreshed = items.find((t) => t.file_keys?.includes('src/x.mjs'));
    // Stable substring of the live h10-direct-capture.mjs mint template
    // ('article missing: ${demandKeys.length} file(s) nothing owns
    // (feature_article or repo-located reference doc)...') — chosen because it
    // survives the count/newly-created suffix. The old pinned phrase
    // ('direct-mode work touched') is a fossil from an earlier mint template
    // and exists nowhere at HEAD, which let this assertion pass vacuously
    // against ANY text (including the stale seed) — SABOTAGE: revert
    // enqueueSystemTodo's refresh path so it re-writes the OLD seed text
    // ('article missing: earlier session') instead of the escalated template
    // -> refreshed.text no longer contains 'file(s) nothing owns' -> red.
    assert.ok(
      refreshed && refreshed.text.includes('file(s) nothing owns'),
      'the overlapping seed is REFRESHED in place — escalation updates the surviving item, never suppresses silently'
    );
    const unrelated = items.find((t) => t.file_keys?.includes('lib/unrelated.mjs'));
    assert.equal(unrelated?.text, 'article missing: unrelated territory', 'non-overlapping territory stays untouched');
  } finally {
    cleanup();
  }
});

test('H10: a touched file deleted before Stop is skipped — no demand, no article_missing (created-then-deleted needs no owner)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // touches registered for paths that do NOT exist on disk (created then rm'd in-session;
    // raw rm leaves the H7 entry stale). H10 must not demand an owner for a deleted file.
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(
      join(dir, '.sterling', 'transient', 'touches.json'),
      JSON.stringify([{ path: 'scripts/_throwaway.mjs', at: NOW }, { path: 'src/also-gone.mjs', at: NOW }])
    );
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'no demand for files that no longer exist');
    const items = store.query({ types: ['todo'], cap: 100 });
    assert.equal(items.filter((t) => t.system_reason === 'article_missing').length, 0, 'no article_missing for a deleted file');
    assert.equal(items.filter((t) => t.system_reason === 'capture_owed').length, 0, 'no capture_owed — no durable change remained');
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'touches.json')), false, 'register cleared (P4)');
  } finally {
    cleanup();
  }
});

test('H10: an internal throw (corrupt config) degrades loud via check_skipped, not a silent exit-1 (audit finding 34/43)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // a touch gives H10 a reason to proceed past the empty-register early-out
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.mjs'), 'export {};');
    writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify([{ path: 'src/x.mjs', at: NOW }]));
    // config that PARSES as JSON but FAILS the zod parseConfig (min_unowned_files must be a number)
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ ...CONFIG, article_demand: { min_unowned_files: 'three' } }));

    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 1, 'internal failure exits non-blocking (lets the session end) — not a hard block');
    assert.match(r.stderr, /session-end duties skipped/);
    const skipped = store.listCheckSkipped().filter((c) => c.check_name === 'h10-stop-duties');
    assert.equal(skipped.length, 1, 'the skip was recorded as a durable check_skipped trail (AC4)');
  } finally {
    cleanup();
  }
});

// --------------------------- H15 ---------------------------

test('hook cwd: a SUBDIRECTORY resolves to the project root; a bare .sterling dir is NOT a root', () => {
  const { dir, cleanup } = makeProject();
  try {
    const sub = join(dir, 'packages', 'deep', 'nested');
    mkdirSync(sub, { recursive: true });

    // H15 must still recognise the project from below it — otherwise the store
    // guard is disarmed by a `cd` (it keys on .sterling/ next to input.cwd)
    const guarded = runHook(
      'h15-store-guard.mjs',
      hookInput(sub, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sqlite3 .sterling/sterling.db ".tables"' } }),
      sub
    );
    assert.equal(guarded.code, 2, 'H15 gates store access from a subdirectory cwd, not just from the root');
    // The H3 half of this test (h3-contract-gate.mjs resolving the store from a
    // subdirectory cwd) was deleted with H3 — scale-down decision
    // sterling-claude-code-scale-down-boundary, 2ad87dd1.
  } finally {
    cleanup();
  }

  // The ~/.sterling trap: a bare .sterling DIRECTORY with no sterling.db is NOT a
  // project root (on every machine ~/.sterling holds the domain stores + registry.db).
  // Resolution must key on the DB FILE, so this stays a non-project — silent (P1).
  const trap = mkdtempSync(join(tmpdir(), 'sterling-trap-'));
  try {
    mkdirSync(join(trap, '.sterling', 'domains'), { recursive: true });
    const sub = join(trap, 'sub');
    mkdirSync(sub, { recursive: true });
    const r = runHook(
      'h15-store-guard.mjs',
      hookInput(sub, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sqlite3 .sterling/sterling.db ".tables"' } }),
      sub
    );
    assert.equal(r.code, 2, 'H15 seals the database by PATH SHAPE, project or not (2026-09-19 one-rule rebuild: ~/.sterling/domains/*/sterling.db is exactly what this protects) — the bare-.sterling-is-not-a-root rule is pinned by the H3 arm above');
  } finally {
    rmSync(trap, { recursive: true, force: true });
  }
});

// H3/H8 fail-closed (audit finding 5/43, board ea2742e0): a BLOCKING gate whose
// store access throws must DENY (exit 2), never void itself via an uncaught
// exit 1 (decision 2422e76a's rule, previously applied only to H17/H15).
test('H16 hooks.json matcher covers WebSearch, WebFetch, Task, Agent on PostToolUse (H11 lesson: direct-invocation tests bypass the platform matcher, so assert the registration itself)', () => {
  const hooksJson = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  const entry = (hooksJson.hooks.PostToolUse ?? []).find((e) =>
    (e.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes('h16-event-register.mjs'))
  );
  assert.ok(entry, 'hooks.json must register H16 on PostToolUse');
  const matcher = new RegExp(entry.matcher);
  for (const tool of ['WebSearch', 'WebFetch', 'Task', 'Agent']) {
    assert.ok(matcher.test(tool), `H16 matcher must cover ${tool} — else the register silently never fires for it`);
  }
});

test('AC3: H16 records WebSearch/WebFetch as research_tool (query/url in detail) and EVERY agent dispatch regardless of type (append log, no dedup)', () => {
  assert.ok(existsSync(join(HOOKS, 'h16-event-register.mjs')), 'h16-event-register.mjs must exist for this behavior to be tested');
  const { dir, cleanup } = makeProject();
  try {
    const post = (tool, tool_input) =>
      runHook('h16-event-register.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: tool, tool_input }), dir);

    assert.equal(post('WebSearch', { query: 'genesys rate limit scope' }).code, 0, 'never blocks');
    assert.equal(post('WebFetch', { url: 'https://developer.genesys.cloud/x' }).code, 0);
    assert.equal(post('Task', { subagent_type: 'explorer', prompt: 'map the store' }).code, 0);
    assert.equal(post('Agent', { subagent_type: 'researcher', prompt: 'go' }).code, 0);

    const ev = readSessionEvents(dir);
    assert.equal(ev.length, 4, 'each recordable call appended once, in order, never deduped (the register is an append log)');

    assert.equal(ev[0].kind, 'research_tool');
    assert.match(ev[0].detail, /genesys rate limit scope/, 'the WebSearch query lands in detail');
    assert.equal(ev[1].kind, 'research_tool');
    assert.match(ev[1].detail, /developer\.genesys\.cloud/, 'the WebFetch url lands in detail');

    assert.equal(ev[2].kind, 'agent_dispatch');
    assert.match(ev[2].detail, /explorer/, 'a NON-research agent dispatch is still recorded — the recorder is policy-free (research-duty filtering is phase 2)');
    assert.equal(ev[3].kind, 'agent_dispatch');
    assert.match(ev[3].detail, /researcher/, 'a researcher dispatch is recorded');

    for (const e of ev) assert.ok(typeof e.at === 'string' && e.at.length > 0, 'every event carries an at timestamp');
  } finally {
    cleanup();
  }
});

test('AC3: two identical dispatches both land (append log never dedups)', () => {
  assert.ok(existsSync(join(HOOKS, 'h16-event-register.mjs')), 'h16-event-register.mjs must exist for this behavior to be tested');
  const { dir, cleanup } = makeProject();
  try {
    const post = () =>
      runHook('h16-event-register.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'coder', prompt: 'go' } }), dir);
    assert.equal(post().code, 0);
    assert.equal(post().code, 0);
    assert.equal(readSessionEvents(dir).filter((e) => e.kind === 'agent_dispatch').length, 2, 'no dedup: both identical dispatches are appended');
  } finally {
    cleanup();
  }
});

test('H16: missing store → allow with no recording, never blocks (fail-open, mirrors H7)', () => {
  assert.ok(existsSync(join(HOOKS, 'h16-event-register.mjs')), 'h16-event-register.mjs must exist for this behavior to be tested');
  const bare = mkdtempSync(join(tmpdir(), 'sterling-h16-bare-'));
  try {
    const r = runHook('h16-event-register.mjs', hookInput(bare, { hook_event_name: 'PostToolUse', tool_name: 'WebSearch', tool_input: { query: 'x' } }), bare);
    assert.equal(r.code, 0, 'no .sterling store → allow, no ceremony');
    assert.equal(readSessionEvents(bare).length, 0, 'nothing recorded without a store');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

// H16_REGISTER / readSessionEvents: restored here (their original position
// sat between the deleted 'dispose-run verifies the union' test and this one
// — a shared top-level const+function my line-range test deletion swept away
// along with that test's body since it happened to fall in the gap between
// them). Referenced above (the AC3/H16 tests) and below (H10/H16 tests
// further down this file) — function declarations hoist, so the earlier
// references resolve fine at call time (tests run after the module fully
// loads), but the definition lives here to mirror base's original grouping.
const H16_REGISTER = ['.sterling', 'transient', 'session-events.json'];
function readSessionEvents(dir) {
  const p = join(dir, ...H16_REGISTER);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
}

test('debug-scope.mjs register appends a debug_scope event to the register (third writer, interface slice 1)', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'inmap.mjs'), 'x');
    const r = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'debug-scope.mjs'), 'register', '--path', 'src/inmap.mjs', '--target', dir],
      { encoding: 'utf8', cwd: dir, timeout: 60_000 }
    );
    assert.equal(r.status, 0, r.stderr);
    const ev = readSessionEvents(dir).filter((e) => e.kind === 'debug_scope');
    assert.equal(ev.length, 1, 'scope registration writes exactly one debug_scope event');
    assert.ok(typeof ev[0].detail === 'string' && ev[0].detail.length > 0, 'the debug_scope event carries a non-empty detail');
    assert.ok(typeof ev[0].at === 'string' && ev[0].at.length > 0, 'the debug_scope event carries an at timestamp');
  } finally {
    cleanup();
  }
});

// ---- H10 evaluation of the session-event register (run r-a6cf, phase 2) ----
//
// Phase 1 built the WRITERS (H16 / debug-scope) + schema + lanes; those are frozen
// and green above. This phase makes H10 READ session-events.json at Stop: a dual
// register entry, a widened captured-type set, a debug-aware capture duty, and a
// research duty with a query-citing nag and a deduped research_owed enqueue — all
// registers clearing together on every terminal path. We SEED session-events.json
// directly (interface slice 3), exactly as the frozen H10 tests seed touches.json.
//
// Timeline: events precede the capture that would satisfy a duty, because both the
// captured set and the research duty count only records created SINCE the earliest
// event/touch. NOW (12:00) is the touch clock; events sit at 11:00; satisfying
// captures at 13:00.
const R_EVENT_AT = '2026-06-10T11:00:00.000Z';
const CAPTURE_AT = '2026-06-10T13:00:00.000Z';
const LATE_EVENT_AT = '2026-06-10T14:00:00.000Z';

const rEvent = (detail, at = R_EVENT_AT) => ({ kind: 'research_tool', detail, at });
const aEvent = (detail, at = R_EVENT_AT) => ({ kind: 'agent_dispatch', detail, at }); // detail = bare subagent_type (phase-1 writer format)
const dEvent = (detail = 'src/probe.mjs', at = R_EVENT_AT) => ({ kind: 'debug_scope', detail, at });

function writeSessionEvents(dir, events) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, ...H16_REGISTER), typeof events === 'string' ? events : JSON.stringify(events));
}
// H10 must resolve research_agents from config; make the block explicit so the tests
// do not depend on H10's own defaulting when config membership is the point under test.
function seedEventsConfig(dir, research_agents = ['researcher', 'claude-code-guide']) {
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ ...CONFIG, session_events: { research_agents } }));
}
function researchFinding(store, at = CAPTURE_AT) {
  return store.create({
    ...envelope('research_finding', at),
    question: 'genesys webhook signature scope?',
    answer: 'per-org secret, validated at the edge',
    source_urls: ['https://developer.genesys.cloud/x'],
    source_date: '2026-06-10',
    capture_date: '2026-06-10',
  });
}
function disconfirmed(store, at = CAPTURE_AT) {
  return store.create({
    ...envelope('disconfirmed_hypothesis', at),
    question: 'was the cache the cause?',
    rejected_answer: 'no — TTL was correct',
    evidence: 'traces show clock skew',
  });
}
function decisionAfter(store, at = CAPTURE_AT) {
  return store.create({ ...envelope('decision', at), title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' });
}
const owed = (store, reason) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === reason);
const eventsPath = (dir) => join(dir, ...H16_REGISTER);

test('H10 AC1: a research-only session (no touches, no capture) soft-blocks EXACTLY once citing the actual queries/agents, then enqueues one research_owed carrying them and ends', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    // A file-LESS session: a WebSearch query and a researcher dispatch, nothing captured.
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation'), aEvent('researcher')]);
    const stop = (over = {}) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop', ...over }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'session-events alone (no touches) must still make H10 proceed and soft-block — the new dual-register entry');
    assert.match(nag.stderr, /genesys webhook signature validation/, 'the nag cites the ACTUAL query verbatim, not a generic message');
    assert.match(nag.stderr, /researcher/, 'the configured research agent is cited too');
    assert.match(nag.stderr, /research/i, 'the nag is the research duty');

    const second = stop();
    assert.equal(second.code, 0, 'soft-blocked exactly once — the second Stop releases');
    const items = owed(store, 'research_owed');
    assert.equal(items.length, 1, 'exactly one research_owed enqueued on release');
    assert.equal(items[0].source, 'system');
    assert.match(items[0].text, /genesys webhook signature validation/, 'the item carries the session queries verbatim (interface slice 2)');
    assert.equal(existsSync(eventsPath(dir)), false, 'session-events register cleared once the session ends (P4)');
  } finally {
    cleanup();
  }
});

test('H10 AC2: a research event followed by a research_finding passes Stop with no research nag; both registers clear', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation')]);
    researchFinding(store); // created AFTER the earliest research event → satisfies the duty
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'a research_finding since the earliest research event satisfies the research duty');
    assert.doesNotMatch(r.stderr, /research duty|nothing was researched/i, 'no research nag when satisfied');
    assert.equal(existsSync(eventsPath(dir)), false, 'session-events register cleared on the satisfied terminal path');
    assert.equal(owed(store, 'research_owed').length, 0, 'nothing owed when the duty is met');
  } finally {
    cleanup();
  }
  // a decision (or anti_pattern) created after the event equally satisfies the duty
  const alt = makeProject();
  try {
    seedEventsConfig(alt.dir);
    writeSessionEvents(alt.dir, [rEvent('some query')]);
    decisionAfter(alt.store);
    const r = runHook('h10-direct-capture.mjs', hookInput(alt.dir, { hook_event_name: 'Stop' }), alt.dir);
    assert.equal(r.code, 0, 'a decision created since the research event also satisfies the duty');
    assert.equal(owed(alt.store, 'research_owed').length, 0);
  } finally {
    alt.cleanup();
  }
});

test('H10 AC3: only config research_agents drive the research duty — a non-research dispatch never nags; a researcher dispatch self-clears with a finding after it', () => {
  // an Explore / general-purpose dispatch alone: recorded, but NOT a research event
  const explore = makeProject();
  try {
    seedEventsConfig(explore.dir); // default ['researcher','claude-code-guide']
    writeSessionEvents(explore.dir, [aEvent('explorer'), aEvent('general-purpose')]);
    const r = runHook('h10-direct-capture.mjs', hookInput(explore.dir, { hook_event_name: 'Stop' }), explore.dir);
    assert.equal(r.code, 0, 'non-research dispatches drive no duty — no nag');
    assert.equal(owed(explore.store, 'research_owed').length, 0, 'and nothing owed');
    assert.equal(existsSync(eventsPath(explore.dir)), false, 'the register still clears on this terminal path');
  } finally {
    explore.cleanup();
  }
  // a researcher dispatch WITH a finding created after it → self-clears
  const cleared = makeProject();
  try {
    seedEventsConfig(cleared.dir);
    writeSessionEvents(cleared.dir, [aEvent('researcher')]);
    researchFinding(cleared.store);
    const r = runHook('h10-direct-capture.mjs', hookInput(cleared.dir, { hook_event_name: 'Stop' }), cleared.dir);
    assert.equal(r.code, 0, 'a configured research agent dispatch is satisfied by a finding created after it');
  } finally {
    cleared.cleanup();
  }
  // config is authoritative: with research_agents narrowed to exclude 'researcher',
  // a researcher dispatch is NOT a research event — pins config-driven, not hardcoded
  const narrowed = makeProject();
  try {
    seedEventsConfig(narrowed.dir, ['claude-code-guide']);
    writeSessionEvents(narrowed.dir, [aEvent('researcher')]);
    const r = runHook('h10-direct-capture.mjs', hookInput(narrowed.dir, { hook_event_name: 'Stop' }), narrowed.dir);
    assert.equal(r.code, 0, 'researcher is not a research agent under this config → no research duty');
    assert.equal(owed(narrowed.store, 'research_owed').length, 0);
  } finally {
    narrowed.cleanup();
  }
});

test('H10 AC4: a file-touching session whose only capture is a research_finding or a disconfirmed_hypothesis is NOT falsely capture-nagged (widened captured set)', () => {
  const rf = makeProject();
  try {
    touchRegister(rf.dir, ['src/a.mjs']); // one file: under the article-demand threshold
    researchFinding(rf.store); // created after the touch
    const r = runHook('h10-direct-capture.mjs', hookInput(rf.dir, { hook_event_name: 'Stop' }), rf.dir);
    assert.equal(r.code, 0, 'a research_finding now counts as capture for a file-touching session');
    assert.equal(owed(rf.store, 'capture_owed').length, 0, 'no capture_owed — the duty is satisfied');
    assert.equal(existsSync(join(rf.dir, '.sterling', 'transient', 'touches.json')), false, 'register cleared');
  } finally {
    rf.cleanup();
  }
  const dh = makeProject();
  try {
    touchRegister(dh.dir, ['src/b.mjs']);
    disconfirmed(dh.store);
    const r = runHook('h10-direct-capture.mjs', hookInput(dh.dir, { hook_event_name: 'Stop' }), dh.dir);
    assert.equal(r.code, 0, 'a disconfirmed_hypothesis now counts as capture too');
    assert.equal(owed(dh.store, 'capture_owed').length, 0);
  } finally {
    dh.cleanup();
  }
});

test('H10 AC5: a debug_scope event with zero touches and no capture triggers the capture nag naming disconfirmed_hypothesis / anti_pattern', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [dEvent('src/suspect.mjs')]); // debugging happened, nothing captured, nothing touched
    const stop = (over = {}) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop', ...over }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'a debug_scope event alone (no touches) triggers the capture duty');
    assert.match(nag.stderr, /disconfirmed_hypothesis/, 'the debug-aware nag names disconfirmed_hypothesis as an expected type');
    assert.match(nag.stderr, /anti_pattern/, 'and anti_pattern');

    const second = stop();
    assert.equal(second.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'capture_owed').length, 1, 'the unmet debug capture duty enqueues capture_owed');
    assert.equal(existsSync(eventsPath(dir)), false, 'register cleared');
  } finally {
    cleanup();
  }
});

// ---- no-capture declaration (board 7bbec3bd: H10 fires on file count, not substance) ----
// scripts/no-capture.mjs writes a no_capture session event; H10's capture duty treats
// it as satisfying every touch/debug_scope event EARLIER than the declaration, while
// work arriving AFTER it re-arms the duty.
function writeTouchesAt(dir, entries) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const { path } of entries) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), '// touched\n');
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(entries));
}
const ncEvent = (reason, at = R_EVENT_AT) => ({ kind: 'no_capture', detail: reason, at });

test('no-capture.mjs: --reason is required and refused when blank; a valid declaration appends a no_capture event', () => {
  const { dir, cleanup } = makeProject();
  try {
    const run = (args) => spawnSync(process.execPath, [join(root, 'scripts', 'no-capture.mjs'), ...args], { encoding: 'utf8', cwd: dir, timeout: 60_000 });

    assert.notEqual(run([]).status, 0, 'no --reason at all is refused');
    assert.notEqual(run(['--reason', '   ']).status, 0, 'a blank/whitespace-only reason is refused');
    assert.equal(readSessionEvents(dir).length, 0, 'a refused declaration writes nothing');

    const ok = run(['--reason', 'read-only investigation, nothing durable']);
    assert.equal(ok.status, 0, ok.stderr);
    const ev = readSessionEvents(dir).filter((e) => e.kind === 'no_capture');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].detail, 'read-only investigation, nothing durable');
    assert.ok(typeof ev[0].at === 'string' && ev[0].at.length > 0);
  } finally {
    cleanup();
  }
});

test('H10 no-capture duty: a declaration BEFORE the Stop covers earlier touches/debug events — no nag, registers clear', () => {
  const touches = makeProject();
  try {
    writeTouchesAt(touches.dir, [{ path: 'src/a.mjs', at: R_EVENT_AT }]);
    writeSessionEvents(touches.dir, [ncEvent('nothing durable', LATE_EVENT_AT)]); // declared AFTER the touch
    const r = runHook('h10-direct-capture.mjs', hookInput(touches.dir, { hook_event_name: 'Stop' }), touches.dir);
    assert.equal(r.code, 0, 'a no_capture declaration later than the touch satisfies the capture duty');
    assert.equal(existsSync(join(touches.dir, '.sterling', 'transient', 'touches.json')), false, 'touches.json cleared');
    assert.equal(existsSync(eventsPath(touches.dir)), false, 'session-events.json cleared');
    assert.equal(owed(touches.store, 'capture_owed').length, 0, 'nothing owed — the duty was satisfied, not deferred');
  } finally {
    touches.cleanup();
  }
  const debug = makeProject();
  try {
    writeSessionEvents(debug.dir, [dEvent('src/probe.mjs', R_EVENT_AT), ncEvent('dead end, nothing to capture', LATE_EVENT_AT)]);
    const r = runHook('h10-direct-capture.mjs', hookInput(debug.dir, { hook_event_name: 'Stop' }), debug.dir);
    assert.equal(r.code, 0, 'a no_capture declaration later than the debug_scope event also satisfies the duty');
    assert.equal(existsSync(eventsPath(debug.dir)), false, 'session-events.json cleared');
  } finally {
    debug.cleanup();
  }
});

test('H10 no-capture duty: work arriving AFTER the declaration re-arms it — nag fires for the new touch only', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeTouchesAt(dir, [{ path: 'src/old.mjs', at: R_EVENT_AT }, { path: 'src/new.mjs', at: LATE_EVENT_AT }]);
    writeSessionEvents(dir, [ncEvent('old work already declared', CAPTURE_AT)]); // between old and new
    const stop = (over = {}) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop', ...over }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'the touch AFTER the declaration re-arms the capture duty');
    // Wording tracks the compact one-line-per-duty format (commit bad0817:
    // "Stop output gets SHORTER and FEWER") — explanatory clauses (the old
    // per-command escape-hatch sentence and its "false declaration is drift"
    // warning) were deliberately dropped in favor of an executable remedy
    // token; CLAUDE.md/H1 carry the explanation now.
    assert.match(nag.stderr, /capture · 1 file\(s\)/, 'only the post-declaration touch counts — the declared one does not');
    assert.match(nag.stderr, /no_capture --reason/, 'the nag names the no-capture escape hatch');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    const items = owed(store, 'capture_owed');
    assert.equal(items.length, 1);
    assert.deepEqual([...items[0].file_keys], ['src/new.mjs'], 'the owed item carries only the re-armed touch');
  } finally {
    cleanup();
  }
});

test('H10 no-capture duty: an old declaration does not retroactively cover a LATER unrelated debug_scope event', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [ncEvent('first thing, nothing durable', R_EVENT_AT), dEvent('src/second.mjs', LATE_EVENT_AT)]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 2, 'the debug_scope event postdates the declaration, so the duty is armed again');
  } finally {
    cleanup();
  }
});

test('H10 test-repair evidence: a test_repair event later than the touch of its named path satisfies the capture duty PER PATH; an unrelated path stays armed', () => {
  const satisfied = makeProject();
  try {
    writeTouchesAt(satisfied.dir, [{ path: 'tests/foo.test.mjs', at: R_EVENT_AT }]);
    writeSessionEvents(satisfied.dir, [
      { kind: 'test_repair', detail: 'tests/foo.test.mjs — fixture asserted an unsatisfiable oracle', at: LATE_EVENT_AT },
    ]);
    const r = runHook('h10-direct-capture.mjs', hookInput(satisfied.dir, { hook_event_name: 'Stop' }), satisfied.dir);
    assert.equal(r.code, 0, 'a test_repair event later than the touch of its named path satisfies the capture duty');
    assert.equal(owed(satisfied.store, 'capture_owed').length, 0, 'nothing owed — the repair evidence IS the capture');
  } finally {
    satisfied.cleanup();
  }
  const unrelated = makeProject();
  try {
    writeTouchesAt(unrelated.dir, [{ path: 'src/other.mjs', at: R_EVENT_AT }]);
    writeSessionEvents(unrelated.dir, [
      { kind: 'test_repair', detail: 'tests/foo.test.mjs — fixture asserted an unsatisfiable oracle', at: LATE_EVENT_AT },
    ]);
    const r = runHook('h10-direct-capture.mjs', hookInput(unrelated.dir, { hook_event_name: 'Stop' }), unrelated.dir);
    assert.equal(r.code, 2, 'a test_repair event covers ONLY its named path — an unrelated touch stays armed');
  } finally {
    unrelated.cleanup();
  }
  const rearmed = makeProject();
  try {
    writeTouchesAt(rearmed.dir, [{ path: 'tests/foo.test.mjs', at: LATE_EVENT_AT }]);
    writeSessionEvents(rearmed.dir, [
      { kind: 'test_repair', detail: 'tests/foo.test.mjs — fixture asserted an unsatisfiable oracle', at: R_EVENT_AT },
    ]);
    const r = runHook('h10-direct-capture.mjs', hookInput(rearmed.dir, { hook_event_name: 'Stop' }), rearmed.dir);
    assert.equal(r.code, 2, 'a touch AFTER the repair event re-arms the duty — evidence cannot cover future work');
  } finally {
    rearmed.cleanup();
  }
});

test('H10 test-repair evidence: coverage is EXACT-PATH — a longer sibling path or evidence text naming the path never covers it', () => {
  const sibling = makeProject();
  try {
    writeTouchesAt(sibling.dir, [{ path: 'tests/foo.test.mjs', at: R_EVENT_AT }]);
    writeSessionEvents(sibling.dir, [
      { kind: 'test_repair', detail: 'x-tests/foo.test.mjs — repaired the OTHER suite', at: LATE_EVENT_AT },
    ]);
    const r = runHook('h10-direct-capture.mjs', hookInput(sibling.dir, { hook_event_name: 'Stop' }), sibling.dir);
    assert.equal(r.code, 2, 'a repair of a longer sibling path never covers the shorter touch');
  } finally {
    sibling.cleanup();
  }
  const evidenceLeak = makeProject();
  try {
    writeTouchesAt(evidenceLeak.dir, [{ path: 'src/gate.mjs', at: R_EVENT_AT }]);
    writeSessionEvents(evidenceLeak.dir, [
      { kind: 'test_repair', detail: 'tests/foo.test.mjs — the assertion about src/gate.mjs was wrong', at: LATE_EVENT_AT },
    ]);
    const r = runHook('h10-direct-capture.mjs', hookInput(evidenceLeak.dir, { hook_event_name: 'Stop' }), evidenceLeak.dir);
    assert.equal(r.code, 2, 'free-text evidence naming a path never discharges that path\'s duty');
  } finally {
    evidenceLeak.cleanup();
  }
});

// ---- capture-pending deferral (board 1af5d630: the truthful middle state) ----
// capture_pending declares the capture EXISTS and its write is in flight on a
// named target. Unlike no_capture it covers LATER work too — wave work keeps
// arriving while the capture rides a pending commit, and per-batch
// re-declaration is the boilerplate loop that trains false declarations.
const cpEvent = (detail, at = CAPTURE_AT) => ({ kind: 'capture_pending', detail, at });

test('H10 capture-pending: covers later work, defers one Stop with registers PRESERVED, then converts to ONE capture_owed citing the target', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeTouchesAt(dir, [{ path: 'src/old.mjs', at: R_EVENT_AT }, { path: 'src/new.mjs', at: LATE_EVENT_AT }]);
    writeSessionEvents(dir, [cpEvent('commit wave-3 — decisions drafted, riding the gated commit')]); // touches exist BOTH before and after it
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const first = stop();
    assert.equal(first.code, 0, 'pending covers touches before AND after the declaration — no nag, no re-declaration loop');
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'touches.json')), true, 'registers survive the deferral — this release is deliberately NOT terminal, so a landed write can settle the duty cleanly');
    assert.equal(owed(store, 'capture_owed').length, 0, 'no debt minted on the first deferral');

    const second = stop();
    assert.equal(second.code, 0, 'still pending on the next Stop — released, not trapped (P1)');
    const items = owed(store, 'capture_owed');
    assert.equal(items.length, 1, 'the debt lands on the queue exactly once');
    assert.match(items[0].text, /declared pending \(commit wave-3 — decisions drafted, riding the gated commit\)/, 'the owed item cites the pending target, so the drain can verify it landed');
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'touches.json')), false, 'conversion IS terminal — registers clear together (P4)');
    assert.equal(existsSync(eventsPath(dir)), false);
  } finally {
    cleanup();
  }
});

test('H10 capture-pending: a write landing between Stops settles the duty cleanly — zero queue noise', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeTouchesAt(dir, [{ path: 'src/a.mjs', at: R_EVENT_AT }]);
    writeSessionEvents(dir, [cpEvent('librarian lane — article append in flight')]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(stop().code, 0, 'deferred');
    decisionAfter(store); // the in-flight write lands
    assert.equal(stop().code, 0);
    assert.equal(owed(store, 'capture_owed').length, 0, 'no debt — the landed write paid the duty, which is why the registers had to survive the deferral');
    assert.equal(existsSync(eventsPath(dir)), false, 'the satisfied path clears the registers as ever');
  } finally {
    cleanup();
  }
});

test('H10 capture-pending: a declaration survives a quiet Stop and still defers later capture work', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [cpEvent('commit quiet-window — capture riding')]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    assert.equal(stop().code, 0, 'the declaration-only Stop releases');
    assert.deepEqual(readSessionEvents(dir), [cpEvent('commit quiet-window — capture riding')], 'the still-effective declaration survives Stop N');
    assert.equal(stop().code, 0, 'a quiet Stop does not consume the declaration');
    assert.deepEqual(readSessionEvents(dir), [cpEvent('commit quiet-window — capture riding')], 'the declaration survives quiet Stop N+1');

    writeTouchesAt(dir, [{ path: 'src/later.mjs', at: LATE_EVENT_AT }]);
    assert.equal(stop().code, 0, 'the surviving declaration defers capture work arriving at Stop N+2');
    assert.equal(owed(store, 'capture_owed').length, 0, 'no premature debt while the declaration gets its first deferral');
    assert.equal(existsSync(eventsPath(dir)), true, 'the outstanding pending declaration remains registered');
  } finally {
    cleanup();
  }
});

test('H10 research: a settled dispatch declaration is consumed so later research is not satisfied by its earlier capture', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    writeSessionEvents(dir, [aEvent('researcher', R_EVENT_AT)]);
    researchFinding(store, CAPTURE_AT);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    assert.equal(stop().code, 0, 'the earlier research declaration is settled');
    assert.equal(existsSync(eventsPath(dir)), false, 'settled work evidence is consumed rather than retained');
    assert.equal(stop().code, 0, 'an intervening quiet Stop remains quiet');

    writeSessionEvents(dir, [aEvent('researcher', LATE_EVENT_AT)]);
    const later = stop();
    assert.equal(later.code, 2, 'the earlier finding cannot satisfy research declared after it');
    assert.match(later.stderr, /researcher/, 'the re-armed research duty names the new work');
  } finally {
    cleanup();
  }
});

test('H10 capture-pending: satisfied research does not consume a declaration with no capture work', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    writeSessionEvents(dir, [cpEvent('commit research-window — capture riding'), aEvent('researcher', R_EVENT_AT)]);
    researchFinding(store, CAPTURE_AT);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    assert.equal(stop().code, 0, 'the satisfied research duty releases without capture work');
    assert.deepEqual(readSessionEvents(dir), [cpEvent('commit research-window — capture riding')], 'only the still-effective capture declaration survives');

    writeTouchesAt(dir, [{ path: 'src/deferred-target.mjs', at: LATE_EVENT_AT }]);
    const later = stop();
    assert.equal(later.code, 0, 'later capture work is deferred by the surviving declaration, not nagged');
    assert.doesNotMatch(later.stderr, /capture ·/, 'the capture lane remains suppressed for its first pending Stop');
    assert.equal(owed(store, 'capture_owed').length, 0, 'no capture debt is minted before the pending grace is spent');
  } finally {
    cleanup();
  }
});

test('H10 capture-pending: queued research does not consume a declaration with no capture work', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    writeSessionEvents(dir, [cpEvent('commit queued-research — capture riding'), aEvent('researcher', R_EVENT_AT)]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    assert.equal(stop().code, 2, 'the unmet research duty receives its one soft-block');
    assert.equal(stop().code, 0, 'the next Stop queues research debt and releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'research work is durably queued');
    assert.deepEqual(readSessionEvents(dir), [cpEvent('commit queued-research — capture riding')], 'queueing research does not consume the forward capture declaration');

    writeTouchesAt(dir, [{ path: 'src/queued-deferred-target.mjs', at: LATE_EVENT_AT }]);
    const later = stop();
    assert.equal(later.code, 0, 'later capture work is deferred by the surviving declaration');
    assert.doesNotMatch(later.stderr, /capture ·/, 'the capture lane does not nag before pending grace is spent');
  } finally {
    cleanup();
  }
});

test('H10 capture-pending: the deferral survives stop_hook_active — a prior hook block never costs the grace period (review finding 1)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeTouchesAt(dir, [{ path: 'src/a.mjs', at: R_EVENT_AT }]);
    writeSessionEvents(dir, [cpEvent('commit y — capture riding')]);
    // stop_hook_active guards against re-BLOCKING in a deny loop; the deferral
    // ALLOWS, so it must not collapse the grace into an immediate capture_owed.
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop', stop_hook_active: true }), dir);
    assert.equal(r.code, 0);
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'touches.json')), true, 'still the non-terminal deferral, not a straight-to-queue conversion');
    assert.equal(owed(store, 'capture_owed').length, 0, 'no false debt minted on the first pending Stop');
  } finally {
    cleanup();
  }
});

test('H10 capture-pending: a pending declaration never mutes the article demand — it speaks only for the capture duty', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTouchesAt(dir, [
      { path: 'src/u1.mjs', at: R_EVENT_AT },
      { path: 'src/u2.mjs', at: R_EVENT_AT },
      { path: 'src/u3.mjs', at: R_EVENT_AT },
    ]); // three unowned touches — at the article-demand threshold
    writeSessionEvents(dir, [cpEvent('commit x — capture riding')]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 2, 'the article demand still soft-blocks');
    assert.match(r.stderr, /article demand/);
    assert.ok(!/H10: direct-mode work touched/.test(r.stderr), 'while the capture nag itself stays suppressed by the pending declaration');
  } finally {
    cleanup();
  }
});

test('H10 AC6: every terminal path clears touches.json + session-events.json + the nag marker together', () => {
  // (a) satisfied path clears both registers AND the nag marker (proven by a fresh nag afterward)
  const sat = makeProject();
  try {
    touchRegister(sat.dir, ['src/a.mjs']);
    writeSessionEvents(sat.dir, [dEvent('src/a.mjs')]);
    decisionAfter(sat.store); // satisfies the (touch ∪ debug) capture duty
    const stop = (over = {}) => runHook('h10-direct-capture.mjs', hookInput(sat.dir, { hook_event_name: 'Stop', ...over }), sat.dir);
    const r = stop();
    assert.equal(r.code, 0, 'both duties satisfied → pass');
    assert.equal(existsSync(join(sat.dir, '.sterling', 'transient', 'touches.json')), false, 'touches.json cleared');
    assert.equal(existsSync(eventsPath(sat.dir)), false, 'session-events.json cleared together with it');
    // marker cleared: a fresh unmet debug event (dated AFTER the earlier decision) must
    // draw a FIRST nag again — not silently auto-release from a stuck marker.
    writeSessionEvents(sat.dir, [dEvent('src/a.mjs', LATE_EVENT_AT)]);
    assert.equal(stop().code, 2, 'the nag marker cleared on the satisfied terminal path — the next unmet Stop nags afresh');
  } finally {
    sat.cleanup();
  }
  // (b) nag→release path clears both registers together
  const rel = makeProject();
  try {
    touchRegister(rel.dir, ['src/a.mjs']);
    writeSessionEvents(rel.dir, [dEvent('src/a.mjs')]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(rel.dir, { hook_event_name: 'Stop' }), rel.dir);
    assert.equal(stop().code, 2, 'unmet capture duty nags');
    assert.equal(stop().code, 0, 'release');
    assert.equal(existsSync(join(rel.dir, '.sterling', 'transient', 'touches.json')), false, 'touches.json cleared on release');
    assert.equal(existsSync(eventsPath(rel.dir)), false, 'session-events.json cleared on release too');
  } finally {
    rel.cleanup();
  }
  // (c) "allow-only while a run is active" sub-case deleted — the pipeline
  // arm it pinned (H10 deferring to the run) is gone with the staged
  // pipeline (scale-down decision sterling-claude-code-scale-down-boundary,
  // 2ad87dd1); a consumer store's orphaned `runs` row must never suppress
  // capture, so H10 no longer branches on it at all.
});

test('H10 boundary: research + debug + touches in ONE session compose into a single nag, then enqueue both capture_owed and research_owed on release', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    touchRegister(dir, ['src/a.mjs']); // one file → no article demand to muddy the duties
    writeSessionEvents(dir, [rEvent('genesys webhook validation'), dEvent('src/a.mjs')]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'a single soft-block covers both unmet duties (shared one-nag marker)');
    assert.match(nag.stderr, /genesys webhook validation/, 'the research duty cites its query');
    assert.match(nag.stderr, /disconfirmed_hypothesis/, 'the capture duty names debug types (debug event present)');
    assert.match(nag.stderr, /anti_pattern/);

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases the whole session');
    assert.equal(owed(store, 'capture_owed').length, 1, 'one capture_owed for the unmet capture duty');
    assert.equal(owed(store, 'research_owed').length, 1, 'one research_owed for the unmet research duty');
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'touches.json')), false, 'touches.json cleared');
    assert.equal(existsSync(eventsPath(dir)), false, 'session-events.json cleared');
  } finally {
    cleanup();
  }
});

test('H10 boundary: malformed session-events.json degrades to empty (never crashes the Stop) — touches still drive the capture duty', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/m.mjs']);
    writeSessionEvents(dir, '{ this is not valid json'); // H16 appends untrusted bytes; H10 must tolerate
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.notEqual(nag.code, 1, 'a parse failure must not crash the Stop hook');
    assert.doesNotMatch(nag.stderr, /SyntaxError|Unexpected token|TypeError|Cannot read/i, 'no uncaught exception surfaced');
    assert.equal(nag.code, 2, 'the valid touch register still drives the capture duty (events degraded to empty)');
    assert.match(nag.stderr, /nothing was captured/, 'the standard capture nag, not a research nag from garbage');

    const release = stop();
    assert.equal(release.code, 0, 'release proceeds normally');
    assert.equal(owed(store, 'research_owed').length, 0, 'unparseable events yield no research duty and no research_owed');
    assert.equal(existsSync(eventsPath(dir)), false, 'the malformed register is cleared like any other on the terminal path');
  } finally {
    cleanup();
  }
});

test('H10 boundary: a research_tool event with an empty detail (schema-invalid per H16 append) is tolerated — no crash, session still ends', () => {
  // Phase-1 reviewer advisory: H16 appends without validating sessionEventSchema
  // (detail: min(1)); H10's read side must degrade gracefully on an empty detail.
  const { dir, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [{ kind: 'research_tool', detail: '', at: R_EVENT_AT }]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    const r1 = stop();
    assert.notEqual(r1.code, 1, 'an empty-detail entry must not crash the Stop');
    assert.doesNotMatch(r1.stderr, /SyntaxError|TypeError|Cannot read/i, 'no uncaught exception building the nag/item text');
    const r2 = stop();
    assert.notEqual(r2.code, 1, 'still no crash on the second Stop');
    assert.equal(existsSync(eventsPath(dir)), false, 'the session ends cleanly — the register is cleared');
  } finally {
    cleanup();
  }
});

test('H10 boundary: research_owed is deduped — an already-open research_owed item suppresses a second on release', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [rEvent('a fresh query')]);
    store.create({
      ...envelope('todo'),
      text: 'research owed: earlier session queries',
      source: 'system',
      system_reason: 'research_owed',
      author: 'system',
    });
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(stop().code, 2, 'the unmet research duty nags');
    assert.equal(stop().code, 0, 'release');
    assert.equal(owed(store, 'research_owed').length, 1, 'at most one open research_owed item (interface slice 2 dedup)');
    assert.equal(existsSync(eventsPath(dir)), false, 'register cleared');
  } finally {
    cleanup();
  }
});

test('H10 AC7 (SOP half): the drain skill text routes the research_owed lane (fulfil = write the record from the cited queries)', () => {
  const skill = readFileSync(join(root, 'skills', 'drain', 'SKILL.md'), 'utf8');
  assert.match(skill, /research_owed/, 'the drain SOP must name the research_owed lane');
  assert.match(skill, /research_owed[\s\S]{0,400}quer/i, 'the lane routes to writing the durable record from the cited queries');
});

// ---- H10 concept duty (decision 7208729b, concept-article-layer-wiring) ----
// A concept_designed event (detail = FAMILY slug, appended by concept-designed.mjs
// the moment a design settles) demands that family's concept article — a
// feature_article with concept_family === family created/updated since the event.
// General capture does NOT satisfy it; a wrong-family article does not either.
const cEvent = (family, at = R_EVENT_AT) => ({ kind: 'concept_designed', detail: family, at });
function conceptArticle(store, family, at = CAPTURE_AT) {
  return store.create({
    ...envelope('feature_article', at),
    slug: `${family}-concept`,
    title: `${family} (concept)`,
    what_it_does: `what ${family} IS + members`,
    intended_behavior: 'INTENT + INTERACTIONS',
    concept_family: family,
    files: [],
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'concept article created' }],
    live_test_refs: [],
  });
}

test('H10 concept duty AC9: a fileless design session (concept_designed, no article) soft-blocks once naming the family, then enqueues one concept_article_missing per family and ends', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    writeSessionEvents(dir, [cEvent('weapons'), cEvent('turrets')]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'concept events alone (no touches) must soft-block at Stop — the fileless design window closes');
    assert.match(nag.stderr, /weapons/, 'the nag names the unmet family verbatim');
    assert.match(nag.stderr, /turrets/, 'every unmet family is named');
    assert.match(nag.stderr, /concept_family/, 'the nag teaches the satisfying artifact (feature_article with concept_family)');

    const second = stop();
    assert.equal(second.code, 0, 'soft-blocked exactly once — the second Stop releases');
    const items = owed(store, 'concept_article_missing');
    assert.equal(items.length, 2, 'one concept_article_missing per unmet family');
    assert.ok(items.some((t) => t.text.includes("'weapons'")) && items.some((t) => t.text.includes("'turrets'")), 'each item carries its family');
    assert.equal(existsSync(eventsPath(dir)), false, 'session-events register cleared once the session ends (P4)');
  } finally {
    cleanup();
  }
});

test('H10 concept duty: the family concept article satisfies it; general capture or a wrong-family article does NOT', () => {
  // satisfied: article with concept_family === family created after the event
  const met = makeProject();
  try {
    seedEventsConfig(met.dir);
    writeSessionEvents(met.dir, [cEvent('weapons')]);
    conceptArticle(met.store, 'weapons');
    const r = runHook('h10-direct-capture.mjs', hookInput(met.dir, { hook_event_name: 'Stop' }), met.dir);
    assert.equal(r.code, 0, 'the family concept article created since the event satisfies the duty');
    assert.equal(owed(met.store, 'concept_article_missing').length, 0, 'nothing owed when met');
    assert.equal(existsSync(eventsPath(met.dir)), false, 'register cleared on the satisfied path');
  } finally {
    met.cleanup();
  }
  // NOT satisfied by general capture (a decision) — the concept lane mirrors article-demand semantics
  const unmet = makeProject();
  try {
    seedEventsConfig(unmet.dir);
    writeSessionEvents(unmet.dir, [cEvent('weapons')]);
    decisionAfter(unmet.store);
    const nag = runHook('h10-direct-capture.mjs', hookInput(unmet.dir, { hook_event_name: 'Stop' }), unmet.dir);
    assert.equal(nag.code, 2, 'a decision does not satisfy the concept duty — only the family article does');
    assert.match(nag.stderr, /weapons/);
  } finally {
    unmet.cleanup();
  }
  // NOT satisfied by a different family's article
  const wrong = makeProject();
  try {
    seedEventsConfig(wrong.dir);
    writeSessionEvents(wrong.dir, [cEvent('weapons')]);
    conceptArticle(wrong.store, 'turrets');
    const nag = runHook('h10-direct-capture.mjs', hookInput(wrong.dir, { hook_event_name: 'Stop' }), wrong.dir);
    assert.equal(nag.code, 2, 'a wrong-family concept article does not satisfy the weapons duty');
    assert.match(nag.stderr, /weapons/);
  } finally {
    wrong.cleanup();
  }
});

test('H10 concept duty: concept_article_missing is deduped per family — an open item for the same family suppresses a duplicate; a new family still enqueues', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    // pre-existing open item for weapons (a prior session's release)
    store.create({
      ...envelope('todo'),
      text: "concept article missing: design settled for concept family 'weapons' and the session ended without its concept article — create/update the feature_article with concept_family 'weapons' (decision 7208729b)",
      source: 'system',
      system_reason: 'concept_article_missing',
    });
    writeSessionEvents(dir, [cEvent('weapons'), cEvent('shields')]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    stop(); // nag
    const second = stop(); // release + enqueue
    assert.equal(second.code, 0);
    const items = owed(store, 'concept_article_missing');
    assert.equal(items.length, 2, 'weapons deduped against the open item; shields enqueued fresh');
    assert.equal(items.filter((t) => t.text.includes("'weapons'")).length, 1, 'no duplicate weapons item');
    assert.equal(items.filter((t) => t.text.includes("'shields'")).length, 1, 'the new family got its item');
  } finally {
    cleanup();
  }
});

test('H10 concept duty (SOP half): concept-designed.mjs appends the event, and the drain skill routes the concept_article_missing lane', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'concept-designed.mjs'), '--family', 'weapons', '--family', 'turrets', '--target', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, `concept-designed.mjs exits 0: ${r.stderr}`);
    const events = JSON.parse(readFileSync(eventsPath(dir), 'utf8'));
    assert.equal(events.length, 2, 'one event per --family');
    assert.ok(events.every((e) => e.kind === 'concept_designed' && e.at), 'kind + timestamp present');
    assert.deepEqual(events.map((e) => e.detail).sort(), ['turrets', 'weapons'], 'detail carries the family slug');
  } finally {
    cleanup();
  }
  const skill = readFileSync(join(root, 'skills', 'drain', 'SKILL.md'), 'utf8');
  assert.match(skill, /concept_article_missing/, 'the drain SOP must name the concept_article_missing lane');
});

// ---- FIX A (upgrade-polish, 2026-08-21): H10 concept duty SESSION-WINDOW start ----
// Spec: the demand is satisfied by a family article whose created_at/updated_at is
// at-or-after the SESSION WINDOW START, defined as the MINIMUM of (this family's
// earliest concept_designed event `at`) and (the earliest `at` across ALL
// session-register events of ANY kind this session) — not merely "at-or-after the
// concept_designed registration itself". The legitimate write-the-article-THEN-
// register flow (seconds apart) must satisfy the duty even when the article lands
// before the concept_designed event but after some earlier same-session event; a
// family article predating the WHOLE session must still demand it.
//
// EXPECTED FAILURE TODAY (test 1 only — see its own note): H10 currently accepts
// an article only when it is at-or-after the concept_designed event's OWN `at`.
// Tests 2 and 3 below pin boundaries that already hold under the CURRENT (buggy)
// implementation too — they are regression guards for the fix, not red assertions;
// disclosed rather than dressed up as red.

test('H10 concept duty (session-window fix) (1): an article created between an EARLIER session event and the concept_designed registration satisfies the duty', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const EARLY_AT = '2026-06-10T09:00:00.000Z'; // earliest event of the WHOLE session
    const CONCEPT_AT = '2026-06-10T12:00:00.000Z'; // the concept_designed registration itself
    const ARTICLE_AT = '2026-06-10T10:00:00.000Z'; // BEFORE the registration, AFTER the earlier event
    // an unrelated no_capture declaration covering nothing — present only to set
    // the session's earliest-event floor earlier than the concept registration
    writeSessionEvents(dir, [ncEvent('unrelated early note', EARLY_AT), cEvent('weapons', CONCEPT_AT)]);
    conceptArticle(store, 'weapons', ARTICLE_AT);

    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    // EXPECTED FAILURE TODAY: this fires — actual code 2 (nag), expected 0. The
    // current implementation compares ARTICLE_AT only against CONCEPT_AT (10:00 <
    // 12:00 → unmet); the fixed session-window floor is EARLY_AT (09:00), against
    // which 10:00 satisfies.
    assert.equal(r.code, 0, 'the article lands after the SESSION WINDOW START (the earlier event), even though it precedes the concept_designed registration itself');
    assert.equal(owed(store, 'concept_article_missing').length, 0, 'nothing owed — the duty was satisfied, not deferred');
    assert.equal(existsSync(eventsPath(dir)), false, 'session-events register cleared on the satisfied path');
  } finally {
    cleanup();
  }
});

test('H10 concept duty (session-window fix) (2): a family article predating EVERY session event still demands its concept article', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const STALE_ARTICLE_AT = '2026-06-01T00:00:00.000Z'; // long before the session
    const EARLY_AT = '2026-06-10T09:00:00.000Z';
    const CONCEPT_AT = '2026-06-10T12:00:00.000Z';
    writeSessionEvents(dir, [ncEvent('unrelated early note', EARLY_AT), cEvent('weapons', CONCEPT_AT)]);
    conceptArticle(store, 'weapons', STALE_ARTICLE_AT);

    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    const nag = stop();
    assert.equal(nag.code, 2, 'a stale, untouched family article — predating even the earliest session event — never satisfies the duty');
    assert.match(nag.stderr, /weapons/);
    const release = stop();
    assert.equal(release.code, 0, 'second stop releases');
    assert.equal(owed(store, 'concept_article_missing').filter((t) => t.text.includes("'weapons'")).length, 1, 'the owed item still lands');
  } finally {
    cleanup();
  }
});

test('H10 concept duty (session-window fix) (3): the register-first flow (article created after the concept_designed event) still satisfies, even with other earlier session events present', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const EARLY_AT = '2026-06-10T09:00:00.000Z';
    const CONCEPT_AT = '2026-06-10T12:00:00.000Z';
    const ARTICLE_AT = '2026-06-10T13:00:00.000Z'; // after the registration
    writeSessionEvents(dir, [aEvent('explorer', EARLY_AT), cEvent('weapons', CONCEPT_AT)]);
    conceptArticle(store, 'weapons', ARTICLE_AT);

    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'register-then-write still satisfies, unaffected by the session-window widening');
    assert.equal(owed(store, 'concept_article_missing').length, 0);
  } finally {
    cleanup();
  }
});

// ---- FIX A PIN (upgrade-polish review round, 2026-08-21): malformed `at` must
// not widen the session-window floor. A naive fix that folds EVERY session-event
// `at` into the MIN() without validating it first is exposed by a malformed value
// (e.g. '0' or 'n/a') that a bare `new Date(x).getTime()` — or a `|| 0` epoch
// fallback on a NaN parse — would otherwise drag arbitrarily far back, wide
// enough to satisfy even a family article that predates every VALID session
// timestamp. The malformed event must be excluded from the floor computation
// entirely, leaving the floor at the earliest VALID timestamp — against which a
// genuinely stale article still fails to satisfy the duty (armed-duty shape:
// nag once, release on the second Stop, one owed item lands). This is additive
// to FIX A tests (1)-(3) above and does not modify them.
test("H10 concept duty (session-window fix) malformed-`at` guard: a session-register event with a malformed `at` ('0' / 'n/a') must not drag the window floor back far enough to satisfy an article that predates every VALID session timestamp — the duty still nags", () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const STALE_ARTICLE_AT = '2026-06-01T00:00:00.000Z'; // predates every VALID session timestamp below
    const EARLY_AT = '2026-06-10T09:00:00.000Z'; // earliest VALID event this session
    const CONCEPT_AT = '2026-06-10T12:00:00.000Z';
    writeSessionEvents(dir, [
      { kind: 'agent_dispatch', detail: 'explorer', at: '0' }, // malformed — must be excluded from the floor
      { kind: 'no_capture', detail: 'unrelated malformed note', at: 'n/a' }, // malformed, different kind — same guard
      ncEvent('a genuinely early valid note', EARLY_AT),
      cEvent('weapons', CONCEPT_AT),
    ]);
    conceptArticle(store, 'weapons', STALE_ARTICLE_AT);

    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    const nag = stop();
    // EXPECTED FAILURE MODE this pins against: if the floor computation folds
    // the malformed timestamps in unguarded (NaN poisoning the MIN, or a `|| 0`
    // epoch fallback), the floor collapses to something at-or-before
    // STALE_ARTICLE_AT and the duty would wrongly report satisfied (code 0).
    // Correct behavior excludes the malformed entries, leaves the floor at
    // EARLY_AT, and the stale article still fails to satisfy it.
    assert.equal(nag.code, 2, 'a malformed session-event timestamp must not widen the window back far enough to satisfy a stale article — the duty still nags');
    assert.match(nag.stderr, /weapons/, 'the nag names the unmet family verbatim');
    const release = stop();
    assert.equal(release.code, 0, "second stop releases, per the suite's armed-duty shape");
    assert.equal(owed(store, 'concept_article_missing').filter((t) => t.text.includes("'weapons'")).length, 1, 'the owed item still lands');
  } finally {
    cleanup();
  }
});

// --------------------------- H17 (bash write sweep — coder-frontmatter registration + bundled) ---------------------------
test('changedLineRanges: locates an Edit, merges adjacent MultiEdit hunks, and refuses to guess', async () => {
  const { changedLineRanges, formatLineRanges } = await import(pathToFileURL(join(HOOKS, 'lib', 'common.mjs')).href);
  const content = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');

  assert.deepEqual(changedLineRanges({ new_string: 'c' }, content), [[3, 3]], 'single line');
  assert.deepEqual(changedLineRanges({ new_string: 'c\nd' }, content), [[3, 4]], 'a span');
  assert.deepEqual(
    changedLineRanges({ edits: [{ new_string: 'b' }, { new_string: 'g' }] }, content),
    [[2, 2], [7, 7]],
    'two separate hunks stay separate'
  );
  assert.deepEqual(
    changedLineRanges({ edits: [{ new_string: 'b' }, { new_string: 'c' }] }, content),
    [[2, 3]],
    'adjacent hunks MERGE — "2-2, 3-3" is noise where "2-3" is a fact'
  );

  // The honest-absence cases: no guessing.
  assert.deepEqual(changedLineRanges({}, content), [], 'a Write carries no new_string — no hint rather than a guess');
  assert.deepEqual(changedLineRanges({ new_string: 'zzz' }, content), [], 'text not present (a later edit moved it) reports nothing');
  assert.deepEqual(changedLineRanges({ new_string: '' }, content), [], 'a pure deletion is skipped — indexOf("") would report line 1');
  assert.deepEqual(changedLineRanges({ new_string: 'a' }, undefined), [], 'no content, no claim');

  assert.equal(formatLineRanges([[3, 3], [7, 9]]), '3, 7-9');
  assert.equal(formatLineRanges([]), '');
});

// board c198866d: the WHERE-hint text ("near line N") was carried on the
// TOUCH-TIME mint, computed from the PostToolUse tool_input's exact
// old_string/new_string delta. That delta is not preserved anywhere between
// the touch and settlement (the candidate register — touches.json — carries
// only {path, at}, per the board item's own description of what H7 already
// writes for H10), so the hint has no settlement-time equivalent to move to —
// it is RETIRED BY DESIGN for direct mode. changedLineRanges/formatLineRanges
// themselves stay covered by the pure-function unit tests above (unchanged);
// these two tests now pin only that the touch still lands as a settlement
// candidate, with no touch-time mint left to carry (or omit) a hint on.
test('H7 [retired hint pin]: an Edit touch registers as a settlement candidate — no touch-time mint exists to carry a WHERE hint (board c198866d)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    lines[24] = 'CHANGED HERE';
    writeFileSync(join(dir, 'src', 'big.mjs'), lines.join('\n'));
    article(store, 'owner', ['src/big.mjs']);

    const r = runHook(
      'h7-file-touch.mjs',
      hookInput(dir, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: join(dir, 'src', 'big.mjs'), old_string: 'line 25', new_string: 'CHANGED HERE' },
      }),
      dir
    );
    assert.equal(r.code, 0);
    assert.equal(reconcileQueue(store).length, 0, 'no touch-time mint exists any more to carry a "near line" hint on — Arm 1 minting moved to settlement');
    const touches = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'touches.json'), 'utf8'));
    assert.ok(touches.some((t) => t.path === 'src/big.mjs'), 'the touch still registers as a settlement candidate (Arm 2 unchanged)');
  } finally {
    cleanup();
  }
});

test('H7 [retired hint pin]: a Write touch (no new_string) registers as a settlement candidate — no touch-time mint exists to omit a hint from (board c198866d)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'w.mjs'), 'whole file replaced\n');
    article(store, 'owner', ['src/w.mjs']);

    // Write carries no new_string: there was never an honest range to report,
    // but that is now moot — there is no touch-time mint at all.
    const r = runHook(
      'h7-file-touch.mjs',
      hookInput(dir, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(dir, 'src', 'w.mjs'), content: 'whole file replaced\n' },
      }),
      dir
    );
    assert.equal(r.code, 0);
    assert.equal(reconcileQueue(store).length, 0, 'Arm 1 no longer mints at touch time regardless of hint availability');
    const touches = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'touches.json'), 'utf8'));
    assert.ok(touches.some((t) => t.path === 'src/w.mjs'), 'the touch still registers as a settlement candidate (Arm 2 unchanged)');
  } finally {
    cleanup();
  }
});

// --------------------------- H10 conductor context pressure (slice 1) ---------------------------
// Direct-conductor pressure at the Stop seam: H6's transcript machinery pointed at the
// conductor's OWN transcript. Advisory + fail-open: a pressure failure never costs a duty.

function writeConductorTranscript(dir, inputTokens, { cacheRead = 0, model = 'claude-fable-5' } = {}) {
  const p = join(dir, 't', 's1.jsonl');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: inputTokens, cache_read_input_tokens: cacheRead }, model } }) + '\n'
  );
}

function readPressureFile(dir) {
  const p = join(dir, '.sterling', 'transient', 'conductor-pressure.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

test('H10 conductor pressure: below-soft classifies below_soft, no deny, sample persisted at the Stop seam', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeConductorTranscript(dir, 50_000); // 25% of the 200k default window
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, `clean session releases: ${r.stderr}`);
    const sample = readPressureFile(dir);
    assert.ok(sample, 'pressure sample persisted');
    assert.equal(sample.level, 'below_soft');
    assert.equal(sample.session_id, 's1');
    assert.ok(Math.abs(sample.fill_pct - 25) < 0.01, `fill_pct ~25, got ${sample.fill_pct}`);
  } finally {
    cleanup();
  }
});

test('H10 conductor pressure: soft classifies soft — advisory only, never a standalone deny', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeConductorTranscript(dir, 80_000); // 40% — between soft 35 and hard 50 defaults
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'soft pressure never blocks on its own (P1)');
    assert.equal(readPressureFile(dir).level, 'soft');
  } finally {
    cleanup();
  }
});

// 2026-09-19 deliberate change (1): pressure is a non-blocking system message
// plus next-prompt queue entry; its once-per-session content remains explicit.
test('H10 conductor pressure: hard warns ONCE per session naming fill, threshold and the delegation remedy; spent marker releases the next Stop', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeConductorTranscript(dir, 170_000); // 85% — past hard 50 default
    const first = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(first.code, 0, 'hard pressure is non-blocking');
    const firstMessage = JSON.parse(first.stdout).systemMessage;
    assert.match(firstMessage, /H10 context warning/i);
    assert.match(firstMessage, /85\.0%/, 'names the fill');
    assert.match(firstMessage, /50%/, 'names the threshold');
    assert.match(firstMessage, /delegat/i, 'names the delegation remedy');
    assert.doesNotMatch(firstMessage, /\/clear/, 'slice 1 never instructs /clear');
    assert.equal(readPressureFile(dir).level, 'hard');
    const second = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(second.code, 0, 'once per session — marker spent');
  } finally {
    cleanup();
  }
});

// 2026-09-19 deliberate change (1): unknown-window pressure remains loud but
// no longer denies Stop.
test('H10 conductor pressure: an UNMAPPED model warns loudly ONCE that the fill is UNRELIABLE — names the model and the config key, prints no percentage against a default (slice 4)', () => {
  const { dir, cleanup } = makeProject();
  try {
    // 25% of the 200k DEFAULT would be a plausible-looking number — the
    // dangerous case (2026-08-11 retrospective: 48% believed at ~10% of real
    // capacity; 2026-09-19: 66.2% on a 1M session). Slice 4: no default
    // denominator at all — the fill is reported as unreliable instead.
    writeConductorTranscript(dir, 50_000, { model: 'claude-novel-9' });
    const first = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(first.code, 0, 'the gauge warning is non-blocking');
    const firstMessage = JSON.parse(first.stdout).systemMessage;
    assert.match(firstMessage, /claude-novel-9/, 'names the unmapped model');
    assert.match(firstMessage, /context_watch\.windows/, 'names the config key to add');
    assert.match(firstMessage, /unreliable/i, 'says the fill is unreliable');
    assert.doesNotMatch(firstMessage, /\d+(\.\d+)?%/, 'no percentage against a default');
    const sample = readPressureFile(dir);
    assert.equal(sample.unmapped_model, 'claude-novel-9', 'the sample carries the unmapped model');
    assert.equal(sample.level, 'unknown', 'no classification without a real window');
    assert.equal(sample.fill_pct, null, 'no fill number without a real window');
    const second = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(second.code, 0, 'once per session — gauge marker spent');
  } finally {
    cleanup();
  }
});

test('H10 conductor pressure: a MAPPED model stays silent below thresholds — no gauge warning, no unmapped_model in the sample', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeConductorTranscript(dir, 50_000); // claude-fable-5, mapped in CONFIG
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'mapped + below-soft releases clean');
    assert.equal(readPressureFile(dir).unmapped_model, undefined);
  } finally {
    cleanup();
  }
});

test('H10 conductor pressure: hard + open capture duty ride ONE deny (pressure appended to the duty nag, no second block after)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeConductorTranscript(dir, 170_000);
    writeFileSync(join(dir, 'src.mjs'), '// touched\n');
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify([{ path: 'src.mjs', at: NOW }]));
    const nag = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(nag.code, 2);
    assert.match(nag.stderr, /nothing was captured/, 'duty nag present');
    assert.match(nag.stderr, /H10 context warning/i, 'pressure part rides the same deny');
    const second = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(second.code, 0, 'second Stop releases (queue path) with no separate pressure deny');
  } finally {
    cleanup();
  }
});

test('H10 conductor pressure: missing transcript degrades LOUD to unknown — check_skipped recorded, duties unaffected', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'unknown pressure never blocks');
    const sample = readPressureFile(dir);
    assert.equal(sample.level, 'unknown');
    assert.equal(sample.reason, 'transcript_missing');
    assert.ok(
      store.listCheckSkipped().some((c) => c.check_name === 'conductor-pressure' && c.reason === 'transcript_missing'),
      'degradation recorded via check_skipped'
    );
  } finally {
    cleanup();
  }
});

// 2026-09-19 deliberate change (1): configured hard pressure changes the
// warning level, not the Stop exit code.
test('H10 conductor pressure: config thresholds govern (custom soft/hard flip a below-soft fill to hard)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeFileSync(
      join(dir, '.sterling', 'config.json'),
      JSON.stringify({ ...CONFIG, context_watch: { ...CONFIG.context_watch, conductor: { soft_pct: 10, hard_pct: 20 } } })
    );
    writeConductorTranscript(dir, 50_000); // 25% — hard under the custom 20 threshold
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'custom hard threshold warns without blocking');
    assert.match(JSON.parse(r.stdout).systemMessage, /20%/, 'names the configured threshold');
  } finally {
    cleanup();
  }
});

test('H10 conductor pressure: stop_hook_active suppresses the standalone hard deny (no deny loops) but the sample still lands', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeConductorTranscript(dir, 170_000);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop', stop_hook_active: true }), dir);
    assert.equal(r.code, 0);
    assert.equal(readPressureFile(dir).level, 'hard');
  } finally {
    cleanup();
  }
});

test('H10 conductor pressure: fill > 100% is window MISCONFIGURATION, not pressure — unknown + check_skipped, no false hard block (live 2026-08-09)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeConductorTranscript(dir, 260_000); // 130% of the 200k default — impossible with a correct denominator
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'misconfigured window never blocks');
    const sample = readPressureFile(dir);
    assert.equal(sample.level, 'unknown');
    assert.equal(sample.reason, 'window_mismatch');
    assert.ok(sample.fill_pct > 100, 'raw fill preserved as evidence');
    assert.ok(
      store.listCheckSkipped().some((c) => c.check_name === 'conductor-pressure' && /window_mismatch/.test(c.reason)),
      'misconfiguration recorded loud'
    );
  } finally {
    cleanup();
  }
});

// --------------------------- H10 slice-boundary advisory (context-rotation slice 2) ---------------------------
// At elevated pressure a DIRTY working tree means the open slice has not reached its
// commit boundary. Advisory via the same once-per-session marker; fail-open on no-git.

function gitProject() {
  const { dir, store, cleanup } = makeProject();
  const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  // Mirror a real init'd project: .sterling/ is gitignored (init ensures the entry), and
  // t/ holds the fixture's conductor transcript, which lives outside the repo in reality —
  // so the hook's own pressure-sample write never counts as slice dirt.
  writeFileSync(join(dir, '.gitignore'), '.sterling/\nt/\n');
  writeFileSync(join(dir, 'base.mjs'), '// base\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return { dir, store, cleanup, dirty: () => writeFileSync(join(dir, 'wip.mjs'), '// uncommitted\n') };
}

// 2026-09-19 deliberate change (1): boundary pressure is non-blocking while
// retaining its once-per-session commit-boundary guidance.
test('H10 slice boundary: soft pressure + dirty tree warns ONCE naming the commit boundary; clean release after', () => {
  const { dir, dirty, cleanup } = gitProject();
  try {
    writeConductorTranscript(dir, 80_000); // 40% of the 200k default — soft
    dirty();
    const first = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(first.code, 0, 'soft + dirty tree warns without blocking');
    const firstMessage = JSON.parse(first.stdout).systemMessage;
    assert.match(firstMessage, /commit boundary/i);
    assert.match(firstMessage, /uncommitted/i, 'names the dirty state');
    assert.match(firstMessage, /once per session/i);
    const second = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(second.code, 0, 'marker spent — no repeat');
  } finally {
    cleanup();
  }
});

test('H10 slice boundary: soft pressure + CLEAN tree stays advisory-silent (commit-ready needs no nudge)', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeConductorTranscript(dir, 80_000);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'clean tree at soft never blocks');
  } finally {
    cleanup();
  }
});

// 2026-09-19 deliberate change (1): hard pressure guidance no longer blocks.
test('H10 slice boundary: hard pressure + dirty tree carries the boundary addendum in the hard warning', () => {
  const { dir, dirty, cleanup } = gitProject();
  try {
    writeConductorTranscript(dir, 170_000); // 85% — hard
    dirty();
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, /H10 context warning/i);
    assert.match(JSON.parse(r.stdout).systemMessage, /commit boundary/i, 'hard message names the boundary when dirty');
  } finally {
    cleanup();
  }
});

// 2026-09-19 deliberate change (1): escalation remains separately visible but
// both levels are non-blocking.
test('H10 slice boundary: soft-boundary warning does not suppress a later hard escalation; hard marker ends it', () => {
  const { dir, dirty, cleanup } = gitProject();
  try {
    writeConductorTranscript(dir, 80_000);
    dirty();
    assert.equal(runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir).code, 0, 'soft boundary warning');
    writeConductorTranscript(dir, 170_000); // escalate to hard
    const hard = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(hard.code, 0, 'escalation still notifies without blocking');
    assert.match(JSON.parse(hard.stdout).systemMessage, /past the 50% target/);
    assert.equal(runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir).code, 0, 'hard marker spent — done for the session');
  } finally {
    cleanup();
  }
});

test('H10 slice boundary: no git degrades LOUD and open — soft + non-repo never blocks, check_skipped recorded', () => {
  const { dir, store, cleanup } = makeProject(); // no git init
  try {
    writeConductorTranscript(dir, 80_000);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'advisory fails open');
    assert.ok(
      store.listCheckSkipped().some((c) => c.check_name === 'conductor-pressure' && /boundary_no_git/.test(c.reason)),
      'degradation recorded'
    );
  } finally {
    cleanup();
  }
});

// --------------------------- Rotation note + H1 restore (context-rotation slice 3) ---------------------------
// scripts/rotation-note.mjs writes the single-slot transient note; H1 injects and
// CONSUMES it on SessionStart source=clear only. Fail-open everywhere (H1 is soft).

const ROTATION_SCRIPT = join(root, 'scripts', 'rotation-note.mjs');

function runRotationNote(dir, args) {
  return spawnSync(process.execPath, [ROTATION_SCRIPT, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
}

function readRotationNote(dir) {
  const p = join(dir, '.sterling', 'transient', 'rotation-note.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function h1(dir, over = {}) {
  const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart', ...over }), dir, {
    STERLING_NO_BANNER: '1',
    STERLING_PLUGIN_ROOT: root,
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // caller asserts
  }
  return { ...r, out };
}

test('rotation-note.mjs: refuses a missing/empty --next-slice; refuses outside a Sterling project', () => {
  const { dir, cleanup } = gitProject();
  try {
    const bare = runRotationNote(dir, []);
    assert.notEqual(bare.status, 0, 'missing --next-slice refused');
    assert.match(bare.stderr + bare.stdout, /next-slice/);
    const empty = runRotationNote(dir, ['--next-slice', '   ']);
    assert.notEqual(empty.status, 0, 'blank --next-slice refused');
    const outside = spawnSync(process.execPath, [ROTATION_SCRIPT, '--next-slice', 'x'], { cwd: tmpdir(), encoding: 'utf8' });
    assert.notEqual(outside.status, 0, 'non-Sterling cwd refused');
  } finally {
    cleanup();
  }
});

test('rotation-note.mjs: writes the single-slot note with git anchors; a rewrite supersedes (latest wins)', () => {
  const { dir, cleanup } = gitProject();
  try {
    const r = runRotationNote(dir, ['--next-slice', 'Finish Goblin animations', '--objective', 'Animation pass', '--risks', 'shader cache flaky']);
    assert.equal(r.status, 0, r.stderr);
    const note = readRotationNote(dir);
    assert.equal(note.next_slice, 'Finish Goblin animations');
    assert.equal(note.objective, 'Animation pass');
    assert.equal(note.risks, 'shader cache flaky');
    assert.match(note.head_sha, /^[0-9a-f]{40}$/, 'git HEAD anchored');
    assert.ok(note.branch, 'branch anchored');
    assert.ok(note.at, 'timestamped');
    assert.equal(runRotationNote(dir, ['--next-slice', 'Skeleton instead']).status, 0);
    assert.equal(readRotationNote(dir).next_slice, 'Skeleton instead', 'single slot — latest wins');
  } finally {
    cleanup();
  }
});

test('H1 rotation restore: source=clear injects the note into additionalContext and CONSUMES it (single shot)', () => {
  const { dir, cleanup } = gitProject();
  try {
    assert.equal(runRotationNote(dir, ['--next-slice', 'Finish Goblin animations', '--risks', 'shader cache flaky']).status, 0);
    const r = h1(dir, { source: 'clear' });
    assert.equal(r.code, 0, r.stderr);
    const ctx = r.out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/);
    assert.match(ctx, /Finish Goblin animations/);
    assert.match(ctx, /shader cache flaky/);
    assert.equal(readRotationNote(dir), null, 'note consumed by the injection');
    const again = h1(dir, { source: 'clear' });
    assert.doesNotMatch(again.out.hookSpecificOutput.additionalContext, /ROTATION RESTORE/, 'no re-injection');
  } finally {
    cleanup();
  }
});

test('H1 rotation restore: source=startup/resume neither injects nor consumes; conventions intact throughout', () => {
  const { dir, cleanup } = gitProject();
  try {
    assert.equal(runRotationNote(dir, ['--next-slice', 'Finish Goblin animations']).status, 0);
    for (const source of ['startup', 'resume']) {
      const r = h1(dir, { source });
      assert.doesNotMatch(r.out.hookSpecificOutput.additionalContext, /ROTATION RESTORE/, `${source} does not inject`);
      // CHANGED 2026-09-19 (slice 3): see the note at :131 — real runHook()
      // spawn (via the local h1() wrapper), real contract file read.
      assert.match(r.out.hookSpecificOutput.additionalContext, /You are the delegator, not the worker/, 'conductor-contract injection intact');
      assert.ok(readRotationNote(dir), `${source} does not consume`);
    }
  } finally {
    cleanup();
  }
});

test('H1 rotation restore: a HEAD moved since the note is disclosed as a CAUTION, injection still lands', () => {
  const { dir, dirty, cleanup } = gitProject();
  try {
    assert.equal(runRotationNote(dir, ['--next-slice', 'Finish Goblin animations']).status, 0);
    dirty();
    const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['add', '-A']);
    g(['commit', '-qm', 'moved']);
    const r = h1(dir, { source: 'clear' });
    const ctx = r.out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/);
    assert.match(ctx, /HEAD has MOVED/i, 'delta disclosed');
  } finally {
    cleanup();
  }
});

// --------------------------- commits_ahead (N15) ---------------------------
// docs/feedback/sterling-plugin-*2026-08-24*: the rotation note's prose fields
// carried counts nothing recomputed — a note said 'FOURTEEN commits', the
// conductor told the user fifteen, the real figure was 39. rotation-note.mjs
// now stamps a computed commits_ahead (vs the resolved base branch) at write
// time; H1 recomputes it at injection and discloses drift exactly like the
// existing head_sha check above.

test('rotation-note.mjs (N15): stamps commits_ahead (vs the resolved base branch) at write time', () => {
  const { dir, cleanup } = gitProject();
  try {
    const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    const base = g(['branch', '--show-current']).stdout.trim(); // master (or main) — the only branch so far
    g(['checkout', '-qb', 'feat/slice']);
    for (const f of ['a.mjs', 'b.mjs', 'c.mjs']) {
      writeFileSync(join(dir, f), `// ${f}\n`);
      g(['add', '-A']);
      g(['commit', '-qm', `add ${f}`]);
    }
    const r = runRotationNote(dir, ['--next-slice', 'next thing']);
    assert.equal(r.status, 0, r.stderr);
    const note = readRotationNote(dir);
    // EXPECTED FAILURE SHAPE (red before the fix): the unhardened writer
    // never computes or stamps this field at all, so `note.commits_ahead`
    // is `undefined` — the two assertions below are the ones expected to
    // fail red against it.
    assert.equal(note.commits_ahead, 3, 'three commits landed on feat/slice since the base branch');
    assert.equal(note.base_branch, base);
  } finally {
    cleanup();
  }
});

test('H1 rotation restore (N15): commits_ahead drift (more commits landed after the note was written) is disclosed, naming both counts', () => {
  const { dir, cleanup } = gitProject();
  try {
    const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['checkout', '-qb', 'feat/slice']);
    writeFileSync(join(dir, 'a.mjs'), '// a\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'add a']);
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    assert.equal(readRotationNote(dir).commits_ahead, 1, 'fixture guard: the note was written at 1 commit ahead');

    // More work lands on the branch AFTER the note was written but BEFORE
    // the /clear actually happens — the note's stamped count is now stale.
    writeFileSync(join(dir, 'b.mjs'), '// b\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'add b']);

    const r = h1(dir, { source: 'clear' });
    const ctx = r.out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/);
    // EXPECTED FAILURE SHAPE (red before the fix): H1 recomputes head_sha
    // drift only — it never re-runs `git rev-list --count` against the
    // note's base_branch, so no commits_ahead disclosure is ever produced.
    // This match is the one expected to fail red against that shape.
    assert.match(ctx, /commits_ahead drift.*note says 1.*actual is 2/is, 'drift disclosed with both the stamped and the actual count');
  } finally {
    cleanup();
  }
});

test('H1 rotation restore (N15 roster review, control): a MATCHING commits_ahead count produces NO drift line', () => {
  const { dir, cleanup } = gitProject();
  try {
    const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['checkout', '-qb', 'feat/slice']);
    writeFileSync(join(dir, 'a.mjs'), '// a\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'add a']);
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    assert.equal(readRotationNote(dir).commits_ahead, 1, 'fixture guard: the note was written at 1 commit ahead');

    // NOTHING lands on the branch between the note and the /clear — the
    // stamped count and the actual count agree.
    const r = h1(dir, { source: 'clear' });
    const ctx = r.out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/);
    // EXPECTED FAILURE SHAPE (red against an UNCONDITIONAL-emit
    // implementation, e.g. one that always appends the drift caution
    // whenever it runs the recount regardless of whether the numbers
    // actually differ): this control would then ALSO show a spurious
    // drift line even though nothing drifted. The doesNotMatch below is
    // the one expected to fail red against that shape.
    assert.doesNotMatch(ctx, /commits_ahead drift/i, 'a matching count must never produce a drift caution');
    const rotationSection = ctx.slice(ctx.indexOf('ROTATION RESTORE'), ctx.indexOf('Resume from next_slice'));
    assert.match(rotationSection, /commits_ahead: 1 \(vs /, 'the matching count is still printed plainly');
    assert.doesNotMatch(rotationSection, /unverified/i, 'a successfully-verified matching count is not marked unverified');
  } finally {
    cleanup();
  }
});

test('H1 rotation restore (Codex P2-B): a note with NO base_branch (commits_ahead unavailable to stamp) produces NO drift line and no commits_ahead field at all', () => {
  const { dir, cleanup } = gitProject();
  try {
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    const note = readRotationNote(dir);
    // Simulate the "commits_ahead unavailable at write time" shape directly
    // (a repo with no origin/HEAD, no main, no master is hard to construct
    // from gitProject()'s single-branch fixture) — this note otherwise
    // matches exactly what rotation-note.mjs itself would have written.
    delete note.base_branch;
    delete note.commits_ahead;
    writeFileSync(join(dir, '.sterling', 'transient', 'rotation-note.json'), JSON.stringify(note, null, 2) + '\n');

    const r = h1(dir, { source: 'clear' });
    const ctx = r.out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/);
    assert.doesNotMatch(ctx, /commits_ahead/i, 'no commits_ahead field/caution is fabricated when the note never carried one');
  } finally {
    cleanup();
  }
});

test('H1 rotation restore (Codex P2-B): a commits_ahead present but base_branch UNRESOLVABLE at restore time is marked unverified, never claimed as drift', () => {
  const { dir, cleanup } = gitProject();
  try {
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    const note = readRotationNote(dir);
    // A base that resolved at write time (e.g. a --base ref, or a branch
    // since deleted) but no longer resolves at restore time — the recount
    // itself fails, which must read as UNVERIFIABLE, never as drift (a
    // failed recount is not evidence the stamped number is wrong).
    note.base_branch = 'this-ref-does-not-exist';
    note.commits_ahead = 3;
    writeFileSync(join(dir, '.sterling', 'transient', 'rotation-note.json'), JSON.stringify(note, null, 2) + '\n');

    const r = h1(dir, { source: 'clear' });
    const ctx = r.out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/);
    assert.doesNotMatch(ctx, /commits_ahead drift/i, 'an unresolvable base is never reported as drift');
    assert.match(ctx, /commits_ahead: 3 \(vs this-ref-does-not-exist\) \(unverified — base unavailable\)/, 'the stamped count is shown with an explicit unverified marker');
  } finally {
    cleanup();
  }
});

test('rotation-note.mjs (Codex P1-B): a clone with origin/main but NO local main branch still gets a numeric commits_ahead (never a false null)', () => {
  const { dir, cleanup } = gitProject();
  const bareOutside = mkdtempSync(join(tmpdir(), 'sterling-rotation-bare-'));
  try {
    const g = (args, cwd = dir) => spawnSync('git', args, { cwd, encoding: 'utf8' });
    // Simulate a plain clone: an origin whose default branch is 'main', but
    // THIS working copy never checked out a local 'main' — only the
    // feature branch it's already on. resolveBaseBranch's old
    // unconditional `origin/main` -> `main` strip would then try to diff
    // against a local branch that does not exist.
    const originDir = join(bareOutside, 'origin.git');
    assert.equal(g(['init', '--bare', '-b', 'main', originDir], bareOutside).status, 0);
    assert.equal(g(['remote', 'add', 'origin', originDir]).status, 0);
    assert.equal(g(['push', 'origin', 'HEAD:main']).status, 0);
    assert.equal(g(['fetch', 'origin']).status, 0);
    assert.equal(g(['remote', 'set-head', 'origin', 'main']).status, 0);
    assert.equal(g(['branch', '--list', 'main']).stdout.trim(), '', 'fixture guard: no LOCAL main branch exists in this working copy');

    g(['checkout', '-qb', 'feat/off-origin-main']);
    writeFileSync(join(dir, 'a.mjs'), '// a\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'add a']);

    const r = runRotationNote(dir, ['--next-slice', 'next thing']);
    assert.equal(r.status, 0, r.stderr);
    const note = readRotationNote(dir);
    assert.equal(note.commits_ahead, 1, 'a numeric count, not a false null, even with no local main');
    assert.equal(note.base_branch, 'origin/main', 'the actual ref used (the remote-tracking ref) is disclosed, not a stripped name that never resolved');
  } finally {
    cleanup();
    rmSync(bareOutside, { recursive: true, force: true });
  }
});

// 2026-09-19 deliberate change (1): the hard warning is advisory at Stop.
test('H10 hard pressure is a WARNING to finish and commit — it never demands a clear or names the rotation protocol (slice 4; was: names READY TO CLEAR)', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeConductorTranscript(dir, 170_000); // 85% — hard
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0);
    const message = JSON.parse(r.stdout).systemMessage;
    assert.match(message, /finish the open work and commit/, 'names the finish-and-commit remedy');
    assert.doesNotMatch(message, /rotation-note\.mjs/, 'no rotation writer');
    assert.doesNotMatch(message, /READY TO CLEAR/, 'no clear demand');
  } finally {
    cleanup();
  }
});
