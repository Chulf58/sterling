import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { selectReviewers } from '../lib/reviewer-selection.mjs';
import { runWiringCheck } from '../lib/wiring-check.mjs';
import { renderInstalledAgent } from '../lib/agent-distribution.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
let ProjectRegistry;
let parseConfig;
before(async () => {
  ({ SterlingStore, ProjectRegistry } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ parseConfig } = await import(pathToFileURL(join(root, 'packages', 'schemas', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
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

function makeProject({ withRun = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h5-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  let run;
  if (withRun) {
    const brief = store.create({
      ...envelope('brief'),
      slug: 'f',
      title: 'F',
      problem: 'p',
      feature: 'f',
      user_stated: { criteria: [], constraints: [] },
      conductor_proposals: [],
      acceptance_criteria: [{ ac_id: 'AC1', text: 'works', verifiable_at: 'final' }],
      technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
      blast_radius: { files: [{ path: 'src/a.mjs', owning_articles: [] }], reconcile_list: [] },
      incidental_scope: [],
      out_of_scope: [],
      phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
      decisions_made: [],
    });
    run = store.createRun({
      id: 'r-h5',
      brief_ref: brief.id,
      branch: 'sterling/run-r-h5',
      machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
      dispatch_counts: {},
      escalations: [],
      started_at: NOW,
    });
  }
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, run, cleanup };
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
    assert.match(out.hookSpecificOutput.additionalContext, /Anti-speculation/);
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
    assert.match(ctx, /reconcile_needed ×3/, 'the lane split says WHAT is owed, not just how much');
    assert.match(ctx, /article_missing ×2/);
    assert.match(ctx, /\/sterling:drain/, 'and names the remedy');
    assert.match(ctx, /ALREADY DONE/, 'and warns that queue items are detected debt, not necessarily owed debt');
    assert.match(ctx, /Anti-speculation/, 'the conventions injection is unaffected');

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
    assert.match(JSON.parse(broken.stdout).hookSpecificOutput.additionalContext, /Anti-speculation/, 'conventions survive a corrupt config');
  } finally {
    cleanup();
  }
});

test('H1 machine role (todo cabbc10f, decision a9b98b7d): stated only on a Sterling clone itself, one line per declared state', () => {
  const { dir, cleanup } = makeProject();
  try {
    // STERLING_PLUGIN_ROOT makes this tmp project LOOK like the plugin's own
    // clone to pluginRoot() — the real walk-up always resolves to the actual
    // repo the test process runs from, which this tmp dir is not.
    const selfHosted = { NO_COLOR: '1', STERLING_PLUGIN_ROOT: dir };

    // absent → UNDECLARED, the safe posture
    const undeclared = JSON.parse(runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, selfHosted).stdout);
    assert.match(undeclared.hookSpecificOutput.additionalContext, /MACHINE ROLE: UNDECLARED — treat as CONSUMER/);

    // declared 'authoring'
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ machine_role: 'authoring' }));
    const authoring = JSON.parse(runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, selfHosted).stdout);
    assert.match(authoring.hookSpecificOutput.additionalContext, /MACHINE ROLE: AUTHORING \(declared in \.sterling\/config\.json machine_role\)/);

    // declared 'consumer'
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ machine_role: 'consumer' }));
    const consumer = JSON.parse(runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, selfHosted).stdout);
    assert.match(consumer.hookSpecificOutput.additionalContext, /MACHINE ROLE: CONSUMER — this clone consumes via \/sterling:update/);
    assert.match(consumer.hookSpecificOutput.additionalContext, /Anti-speculation/, 'conventions still present alongside the role line');

    // NOT a clone (no STERLING_PLUGIN_ROOT override — this tmp dir is not the
    // real plugin root the unmocked walk-up would find): no role line at all,
    // even with machine_role declared.
    const notAClone = JSON.parse(runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, { NO_COLOR: '1' }).stdout);
    assert.ok(!/MACHINE ROLE/.test(notAClone.hookSpecificOutput.additionalContext), 'no role line off the plugin\'s own clone');
  } finally {
    cleanup();
  }
});

test('H1 machine role: a malformed config on the plugin\'s own clone costs only the role line\'s specificity, never a crash', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not json');
    const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, {
      NO_COLOR: '1',
      STERLING_PLUGIN_ROOT: dir,
    });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /Anti-speculation/, 'conventions survive a corrupt config even on the self-hosted clone');
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

    // TTL 0 → the fetch throttle never reads as fresh, so each run probes
    const env = { NO_COLOR: '1', STERLING_PLUGIN_ROOT: clone, STERLING_CURRENCY_DISABLE: '0', STERLING_CURRENCY_TTL_MS: '0' };
    const behind = JSON.parse(runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, env).stdout);
    assert.match(behind.systemMessage, /Sterling is 1 update\(s\) behind/, 'the human is told, with the double-click remedy');
    assert.match(behind.systemMessage, /sterling-update\.bat/);
    assert.match(behind.hookSpecificOutput.additionalContext, /STERLING CLONE IS BEHIND \(H1\)/, 'the conductor is told');
    assert.match(behind.hookSpecificOutput.additionalContext, /Anti-speculation/, 'conventions intact alongside the signal');
    assert.ok(existsSync(join(clone, '.git', 'sterling-update-check.json')), 'the fetch throttle is stamped');

    // fast-forward the clone → silent IMMEDIATELY: behind is computed locally
    // per session, never served from the cache
    sh(clone, ['merge', '--ff-only', 'origin/main']);
    const current = JSON.parse(runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, env).stdout);
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
    const authoring = JSON.parse(runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart' }), dir, env).stdout);
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
    assert.match(ctx, /Anti-speculation/, 'conventions still present');
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
    assert.match(out.hookSpecificOutput.additionalContext, /machine_rebaked/, 'recovery path names the sync re-bake');

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

// --------------------------- H4 ---------------------------

test('H4: test-writer read wall — denies implementation, allows tests/docs/outside-repo', () => {
  const { dir, cleanup } = makeProject();
  try {
    const read = (p) => runHook('h4-read-wall.mjs', hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: p } }), dir);
    let r = read(join(dir, 'src', 'impl.mjs'));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /never reads code/);
    assert.equal(read(join(dir, 'tests', 'x.test.mjs')).code, 0);
    assert.equal(read(join(dir, 'README.md')).code, 0);
    assert.equal(read(join(dir, 'docs', 'guide.txt')).code, 0);
    assert.equal(read('C:/elsewhere/platform-notes.ts').code, 0, 'outside the repo is not implementation');
  } finally {
    cleanup();
  }
  // fail closed on a CORRUPT config (loadConfig JSON.parse throws): the read wall
  // must DENY, never void itself via a non-blocking exit 1 (the F5 class; found
  // during the F6 review — audit's F5 scoped only H3/H8).
  const corrupt = mkdtempSync(join(tmpdir(), 'sterling-h4c-'));
  mkdirSync(join(corrupt, '.sterling'), { recursive: true });
  writeFileSync(join(corrupt, '.sterling', 'config.json'), '{ not json');
  try {
    const r = runHook('h4-read-wall.mjs', hookInput(corrupt, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(corrupt, 'src', 'impl.mjs') } }), corrupt);
    assert.equal(r.code, 2, 'a corrupt config denies (fail closed), never a voided read wall');
    assert.match(r.stderr, /failing closed/);
  } finally {
    rmSync(corrupt, { recursive: true, force: true });
  }
});

test('H4: content-mode Grep hits the same wall — the r-ea9e bypass replay (denied Read, denied content Grep, allowed locate Grep)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const call = (tool, tool_input) => runHook('h4-read-wall.mjs', hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input }), dir);
    const impl = join(dir, 'src', 'records.mjs');

    // the incident, replayed: Read denied → the same file's content re-fetched via Grep -C
    assert.equal(call('Read', { file_path: impl }).code, 2);
    const bypass = call('Grep', { pattern: 'schema', path: impl, output_mode: 'content', '-C': 3 });
    assert.equal(bypass.code, 2, 'content-mode Grep on a Read-denied file is the same read');
    assert.match(bypass.stderr, /H4/);

    // locating is fine — paths-only and count reveal no content
    assert.equal(call('Grep', { pattern: 'schema', path: impl, output_mode: 'files_with_matches' }).code, 0);
    assert.equal(call('Grep', { pattern: 'schema' }).code, 0, 'default output mode locates, repo-wide');
    assert.equal(call('Grep', { pattern: 'schema', path: impl, output_mode: 'count' }).code, 0);

    // content mode stays available exactly where Read is allowed
    assert.equal(call('Grep', { pattern: 'x', path: join(dir, 'tests', 'x.test.mjs'), output_mode: 'content' }).code, 0);
    assert.equal(call('Grep', { pattern: 'x', path: join(dir, 'docs', 'guide.txt'), output_mode: 'content' }).code, 0);
    assert.equal(call('Grep', { pattern: 'x', path: 'C:/elsewhere/notes.ts', output_mode: 'content' }).code, 0, 'outside the repo is not implementation');

    // unscoped content sweeps fail closed (P5): pathless, repo root, dir-scoped source
    assert.equal(call('Grep', { pattern: 'x', output_mode: 'content' }).code, 2, 'pathless content grep = repo-wide read');
    assert.equal(call('Grep', { pattern: 'x', path: dir, output_mode: 'content' }).code, 2, 'repo-root content grep');
    assert.equal(call('Grep', { pattern: 'x', path: '.', output_mode: 'content' }).code, 2, 'relative-root content grep');
    assert.equal(call('Grep', { pattern: 'x', path: join(dir, 'src'), output_mode: 'content' }).code, 2, 'dir-scoped content grep over source');

    // An UNRECOGNIZED output_mode fails closed into the content branch — right —
    // but the denial used to advise 'locate with output_mode files_with_matches',
    // which is what the caller believes it just did. Name the observed value.
    const typo = call('Grep', { pattern: 'x', output_mode: 'files_with_match' });
    assert.equal(typo.code, 2, 'an unrecognized mode still fails closed');
    assert.match(typo.stderr, /output_mode 'files_with_match' is NOT a value this gate recognizes/);
    assert.match(typo.stderr, /fail CLOSED into the content path/, 'and says WHY that routed it here');
    // The recognized-mode denials must NOT claim an unrecognized mode.
    const pathless = call('Grep', { pattern: 'x', output_mode: 'content' });
    assert.match(pathless.stderr, /output_mode was 'content'/);
    assert.match(pathless.stderr, /No path was given/, 'and which unscoping applied');
    assert.doesNotMatch(pathless.stderr, /NOT a value this gate recognizes/);
  } finally {
    cleanup();
  }
});

// --------------------------- H7 ---------------------------

test('H7 [pipeline]: owning articles land on run.reconcile_needed, idempotently', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    const a = article(store, 'feat-a', ['src/a.mjs']);
    const edit = () =>
      runHook('h7-file-touch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'a.mjs') } }), dir);
    assert.equal(edit().code, 0);
    assert.equal(edit().code, 0);
    assert.deepEqual(store.getRun('r-h5').reconcile_needed, [a.id], 'marked once, not duplicated');
  } finally {
    cleanup();
  }
});

test('H7 [direct]: maintenance queue item (deduped) + transient touch register for H10', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const a = article(store, 'feat-a', ['src/a.mjs']);
    const edit = () =>
      runHook('h7-file-touch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'a.mjs') } }), dir);
    assert.equal(edit().code, 0);
    assert.equal(edit().code, 0);
    const queue = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'reconcile_needed');
    assert.equal(queue.length, 1, 'deduped per article');
    assert.equal(queue[0].feature_link, a.id);
    const touches = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'touches.json'), 'utf8'));
    assert.equal(touches.length, 2);
    assert.equal(touches[0].path, 'src/a.mjs');

    // .git/** is machinery, never governed work (live incident 2026-06-12:
    // a commit-message temp file fed H10 a junk article demand)
    const gitWrite = runHook(
      'h7-file-touch.mjs',
      hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(dir, '.git', 'COMMIT_MSG_TMP.txt') } }),
      dir
    );
    assert.equal(gitWrite.code, 0);
    const after = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'touches.json'), 'utf8'));
    assert.equal(after.length, 2, '.git/** paths never enter the touch register');
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

test('H7 [§3.2.5 direct]: repo-located reference doc trips reconcile_needed (deduped); url-kind trips nothing', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const doc = referenceDoc(store, 'Build Spec', 'doc', 'docs/spec.md');
    referenceDoc(store, 'External', 'url', 'https://example.com/spec');
    const edit = () =>
      runHook('h7-file-touch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'docs', 'spec.md') } }), dir);
    assert.equal(edit().code, 0);
    assert.equal(edit().code, 0);
    const queue = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'reconcile_needed');
    assert.equal(queue.length, 1, 'doc reference marked once (deduped); the url reference never');
    assert.equal(queue[0].feature_link, doc.id);
    assert.match(queue[0].text, /refresh summary \+ source_date/);
  } finally {
    cleanup();
  }
});

test('H7 [§3.2.5 pipeline]: a Sterling-governed touch lands the reference doc on run.reconcile_needed', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    const doc = referenceDoc(store, 'Build Spec', 'doc', 'docs/spec.md');
    const r = runHook('h7-file-touch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'docs', 'spec.md') } }), dir);
    assert.equal(r.code, 0);
    assert.deepEqual(store.getRun('r-h5').reconcile_needed, [doc.id]);
  } finally {
    cleanup();
  }
});

// --------------------------- H8 ---------------------------

test('H8: dispatch cap — probe-verified blocking PreToolUse on the Agent tool', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    // SLICE-WAIVED first line so the AC4 slice-presence guard lets this dispatch
    // reach the cap-increment path (conductor-authorized, intent-preserving fixture
    // adaptation — the coder is fail-closed on test globs per H5). Assertions below
    // are unchanged: this test still pins the cap semantics only.
    const spawn = () =>
      runHook('h8-dispatch-cap.mjs', hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'coder', prompt: 'SLICE-WAIVED: cap-path fixture (pre-existing test, adapted for AC4)\ngo' } }), dir);
    store.updateRunOptimistic('r-h5', (run) => ({ ...run, dispatch_counts: { coder: 24 } }));
    assert.equal(spawn().code, 0, '25th dispatch is within the cap');
    assert.equal(store.getRun('r-h5').dispatch_counts.coder, 25);
    const denied = spawn();
    assert.equal(denied.code, 2);
    assert.match(denied.stderr, /dispatch cap exceeded/);
    assert.ok(store.getRun('r-h5').escalations.some((e) => e.kind === 'dispatch_cap_exceeded'), 'deny + escalate (§6 H8)');
  } finally {
    cleanup();
  }
  const noRun = makeProject();
  try {
    const r = runHook('h8-dispatch-cap.mjs', hookInput(noRun.dir, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'coder' } }), noRun.dir);
    assert.equal(r.code, 0, 'the cap is per-run');
  } finally {
    noRun.cleanup();
  }
});

// --------------------------- H9 ---------------------------

test('H9: Stop blocked only while completing, naming outstanding promotion conditions; loop-guarded', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    const stop = (over = {}) => runHook('h9-stop-backstop.mjs', hookInput(dir, { hook_event_name: 'Stop', ...over }), dir);
    assert.equal(stop().code, 0, 'running: stopping is not H9 business');

    store.casTransition('running', { ...store.getRun('r-h5'), machine_state: 'completing' });
    const blocked = stop();
    assert.equal(blocked.code, 2);
    assert.match(blocked.stderr, /mid-completion/);
    assert.match(blocked.stderr, /feature_article_missing/, 'outstanding conditions are named from the shared promotion definition');
    assert.equal(stop({ stop_hook_active: true }).code, 0, 'loop guard');

    store.casTransition('completing', { ...store.getRun('r-h5'), machine_state: 'awaiting_merge_gate' });
    assert.equal(stop().code, 0, 'awaiting_merge_gate: stopping is legitimate (the human decides at leisure)');
  } finally {
    cleanup();
  }
});

// --------------------------- H10 ---------------------------

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
    assert.ok(
      refreshed && refreshed.text.includes('direct-mode work touched'),
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

test('H15 store guard: shell references to the store are denied naming the §10 tools; sanctioned scripts and unrelated commands pass', () => {
  const { dir, cleanup } = makeProject();
  try {
    const run = (command) =>
      runHook('h15-store-guard.mjs', hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command } }), dir);

    const nodeWrite = run(`node -e "import('.../store/dist/index.js').then(s => new s.SterlingStore('.sterling/sterling.db'))"`);
    assert.equal(nodeWrite.code, 2, 'ad-hoc node script against the store is denied');
    assert.match(nodeWrite.stderr, /§10 MCP tool surface/);
    assert.match(nodeWrite.stderr, /maintenance_enqueue/, 'the deny message teaches the full write surface');
    assert.match(nodeWrite.stderr, /RESTART THE SESSION/);

    assert.equal(run('sqlite3 .sterling/sterling.db "SELECT * FROM records"').code, 2, 'reads are denied too — use knowledge_query');
    assert.equal(run('Get-Content .sterling\\config.json').code, 2, 'backslash store paths are caught');

    // bare `.sterling` — the whole-store command class (audit finding 4/43, board 1aba8ace)
    assert.equal(run('rm -rf .sterling').code, 2, 'whole-store delete names no separator but is still gated');
    assert.equal(run('mv .sterling .sterling.bak').code, 2, 'whole-store rename is gated');
    assert.equal(run('tar czf x.tgz .sterling').code, 2, 'whole-store archive is gated');
    assert.equal(run('rm -rf .sterling-backups').code, 0, 'suffixed sibling names stay out of the gate');
    assert.equal(run('echo .sterlingfoo').code, 0, 'word-joined mentions stay out of the gate');

    assert.equal(run('node scripts/dispose-run.mjs r-0001 --store .sterling/sterling.db').code, 0, 'sanctioned script passes');
    assert.equal(run('node scripts/init.mjs --backup-path .sterling/backups').code, 0, 'init passes');
    assert.equal(run('node packages/tui/bundle/sterling-tui.mjs --store .sterling/sterling.db').code, 0, 'TUI launcher passes');
    assert.equal(run('npm test').code, 0, 'unrelated commands untouched');
    assert.equal(run('git status').code, 0);

    // PROSE trips the gate too, and the denial now SAYS so (decision a8bec43f).
    // Hit live by a `git commit -F -` whose heredoc message described store work:
    // nothing is accessed, the deny is still correct by the gate's rule, and the
    // old wording ('shell access is denied') misdiagnosed exactly that case.
    const prose = run('git commit -F - <<EOF\nchore: teach the .sterling guard to explain itself\nEOF');
    assert.equal(prose.code, 2, 'the matcher is NOT narrowed — prose still denies, the allow surface is unchanged');
    assert.match(prose.stderr, /THIS GATE MATCHES COMMAND TEXT/, 'the discriminator is named, not just the rule');
    assert.match(prose.stderr, /git commit -F <file>/, 'and the remedy is spelled out');
    assert.match(nodeWrite.stderr, /THIS GATE MATCHES COMMAND TEXT/, 'the line is unconditional — no prose-detection heuristic to get wrong');

    // malformed config: the gate FAILS CLOSED on the protected branch (review finding)
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not json');
    const broken = run('sqlite3 .sterling/sterling.db ".tables"');
    assert.equal(broken.code, 2, 'unreadable config denies rather than voiding the gate');
    assert.match(broken.stderr, /fails closed/);
    assert.doesNotMatch(broken.stderr, /THIS GATE MATCHES COMMAND TEXT/, 'the fail-closed path keeps its own distinct message');
  } finally {
    cleanup();
  }
  // outside a Sterling project: silent pass-through (P1)
  const bare = mkdtempSync(join(tmpdir(), 'sterling-bare-'));
  try {
    const r = runHook(
      'h15-store-guard.mjs',
      hookInput(bare, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sqlite3 .sterling/sterling.db ".tables"' } }),
      bare
    );
    assert.equal(r.code, 0, 'no ceremony outside Sterling projects');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

// Project-root resolution from a SUBDIRECTORY cwd (board 51b1e2c0). The platform
// hands a hook the SHELL's working directory, which follows a Bash `cd` — every
// hook test before this one passed cwd = the project root, which is exactly why
// 538 green tests never caught it. A `cd` into any subdirectory used to make H3
// fail closed on 'no Sterling store' while H7/H9/H13/H15/H16/H19 went SILENTLY
// inert. lib/common.mjs readStdin now normalizes cwd to the nearest ancestor
// holding .sterling/sterling.db.
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

    // H3 must resolve the store from below it. Targeting a NEW file exercises the
    // creation exemption, so a correctly-resolved H3 ALLOWS — the pre-fix failure
    // was a deny naming 'no Sterling store', which must not reappear.
    const creation = runHook(
      'h3-contract-gate.mjs',
      hookInput(sub, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(dir, 'brand-new.mjs') } }),
      sub
    );
    assert.doesNotMatch(creation.stderr, /no Sterling store/, 'H3 found the store from a subdirectory cwd');
    assert.equal(creation.code, 0, 'creation is exempt once the contract can actually be evaluated');
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
    assert.equal(r.code, 0, 'a bare .sterling directory must not be mistaken for a project root');
  } finally {
    rmSync(trap, { recursive: true, force: true });
  }
});

// H3/H8 fail-closed (audit finding 5/43, board ea2742e0): a BLOCKING gate whose
// store access throws must DENY (exit 2), never void itself via an uncaught
// exit 1 (decision 2422e76a's rule, previously applied only to H17/H15).
test('H3/H8: an unreadable store denies (fail closed) instead of voiding the blocking gate', () => {
  // Built by hand (no real store ever opened on the db path, so no WAL sidecar
  // holds a valid schema): the garbage file genuinely fails to open, forcing the
  // gate's store access to throw — which must surface as a deny, not a void.
  const dir = mkdtempSync(join(tmpdir(), 'sterling-failclosed-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
    writeFileSync(join(dir, 'src.mjs'), 'export {};');
    writeFileSync(join(dir, '.sterling', 'sterling.db'), 'not a sqlite database — corrupt on purpose. '.repeat(100));

    const h3 = runHook(
      'h3-contract-gate.mjs',
      hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'src.mjs') } }),
      dir
    );
    assert.equal(h3.code, 2, 'H3 denies when it cannot evaluate the contract');
    assert.match(h3.stderr, /failing closed/);

    const h8 = runHook(
      'h8-dispatch-cap.mjs',
      hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'coder', prompt: 'SLICE-WAIVED: test' } }),
      dir
    );
    assert.equal(h8.code, 2, 'H8 denies when it cannot evaluate the cap');
    assert.match(h8.stderr, /failing closed/);
  } finally {
    cleanup();
  }
});

// H9 fail-closed (anti_pattern af5382e4, the F5 class): H9 was the last BLOCKING
// gate whose store/config access sat in a try/FINALLY with no catch — an
// unreadable store threw past it and exited 1 (non-blocking), silently voiding
// the completion backstop. Probed live 2026-07-27: exit 1, uncaught
// 'file is not a database' from openStore. Absent store vs UNEVALUABLE store
// must stay distinct: the first is 'not a Sterling project' (allow, P1), only
// the second is a voided gate (deny, P5).
test('H9: an unreadable store denies (fail closed); an ABSENT store still allows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h9fc-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));

    // no sterling.db at all — not an initialized project, nothing to gate (P1)
    const absent = runHook('h9-stop-backstop.mjs', hookInput(dir, { hook_event_name: 'Stop', stop_hook_active: false }), dir);
    assert.equal(absent.code, 0, 'an absent store is not a Sterling project — allow, never a spurious block');

    // present but unreadable — the gate cannot evaluate, so it must DENY
    writeFileSync(join(dir, '.sterling', 'sterling.db'), 'not a sqlite database — corrupt on purpose. '.repeat(100));
    const corrupt = runHook('h9-stop-backstop.mjs', hookInput(dir, { hook_event_name: 'Stop', stop_hook_active: false }), dir);
    assert.equal(corrupt.code, 2, 'a corrupt store denies (fail closed), never a non-blocking exit 1');
    assert.match(corrupt.stderr, /failing closed/);

    // the loop guard still wins, so a fail-closed H9 can never trap the conductor
    const looped = runHook('h9-stop-backstop.mjs', hookInput(dir, { hook_event_name: 'Stop', stop_hook_active: true }), dir);
    assert.equal(looped.code, 0, 'stop_hook_active short-circuits before any store access — one denial per stop, never a trap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------- H18 (test-writer write wall, audit finding 6/43) ---------------------------

test('H18 test-write wall: the test-writer writes ONLY test files; source / enforcement-surface / outside-repo denied; fails closed with no toolchains', () => {
  const { dir, cleanup } = makeProject();
  try {
    const w = (file_path, tool = 'Write') =>
      runHook('h18-test-write-wall.mjs', hookInput(dir, { agent_id: 'tw-1', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path } }), dir);

    // ALLOWED — test files, per config test_globs (tests/**, **/*.test.mjs)
    assert.equal(w(join(dir, 'tests', 'export.test.mjs')).code, 0, 'a test under tests/ is allowed');
    assert.equal(w(join(dir, 'packages', 'store', 'src', 'foo.test.mjs')).code, 0, '**/*.test.mjs anywhere is allowed');

    // DENIED — implementation source (the core gap: the test-writer could write ANY file)
    const src = w(join(dir, 'src', 'index.mjs'));
    assert.equal(src.code, 2, 'a source file is denied');
    assert.match(src.stderr, /matches NO declared test glob/i);
    // NAME THE GLOBS. Two causes reach this deny — genuine source, or a test file
    // at a path no declared glob matches — and the old message asserted the file
    // "is not a test file" while withholding the one fact that discriminates them.
    // Its sibling H5 denial already named its matched glob.
    assert.match(src.stderr, /Compared against:/);
    assert.match(src.stderr, /tests\/\*\*|\*\*\/\*\.test\.mjs/, 'the actual configured globs appear');
    assert.match(src.stderr, /\(node\)/, 'attributed to the declaring toolchain');
    assert.match(src.stderr, /If this IS meant to be a test/, 'and the misnamed-test case is addressed, not just the source case');

    // DENIED — enforcement surface (self-protection, unconditional)
    assert.equal(w(join(dir, '.claude', 'agents', 'coder.md')).code, 2, 'installed agents (enforcement surface) denied');
    assert.equal(w(join(dir, '.sterling', 'config.json')).code, 2, 'config (enforcement surface) denied');

    // DENIED — outside the repository
    assert.equal(w('/etc/passwd').code, 2, 'a path outside the repo is denied');

    // MultiEdit and Edit are gated identically (Edit joined the grant + matcher
    // 2026-08-11 so incremental test additions don't force wholesale rewrites)
    assert.equal(w(join(dir, 'src', 'x.mjs'), 'MultiEdit').code, 2, 'MultiEdit to source is denied too');
    assert.equal(w(join(dir, 'src', 'x.mjs'), 'Edit').code, 2, 'Edit to source is denied too');
    assert.equal(w(join(dir, 'tests', 'export.test.mjs'), 'Edit').code, 0, 'Edit within a test glob is allowed');
  } finally {
    cleanup();
  }

  // fail closed: no toolchains → cannot resolve test globs → deny (P5)
  const bare = mkdtempSync(join(tmpdir(), 'sterling-h18-'));
  mkdirSync(join(bare, '.sterling'), { recursive: true });
  writeFileSync(join(bare, '.sterling', 'config.json'), JSON.stringify({}));
  try {
    const r = runHook(
      'h18-test-write-wall.mjs',
      hookInput(bare, { agent_id: 'tw-1', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(bare, 'tests', 'a.test.mjs') } }),
      bare
    );
    assert.equal(r.code, 2, 'no toolchains → fail closed, even for a would-be test path');
    assert.match(r.stderr, /failing closed|toolchains/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }

  // fail closed on a CORRUPT config (loadConfig JSON.parse throws) — a voided
  // gate would let the write through (the F5 fail-open class)
  const corrupt = mkdtempSync(join(tmpdir(), 'sterling-h18c-'));
  mkdirSync(join(corrupt, '.sterling'), { recursive: true });
  writeFileSync(join(corrupt, '.sterling', 'config.json'), '{ not json');
  try {
    const r = runHook(
      'h18-test-write-wall.mjs',
      hookInput(corrupt, { agent_id: 'tw-1', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(corrupt, 'src', 'x.mjs') } }),
      corrupt
    );
    assert.equal(r.code, 2, 'a corrupt config denies (fail closed), never a non-blocking exit 1');
    assert.match(r.stderr, /failing closed/);
  } finally {
    rmSync(corrupt, { recursive: true, force: true });
  }
});

// --------------------------- reviewer selection + H12 units ---------------------------

test('reviewer-selection: deterministic, logs why dispatched AND why skipped (§7.1)', () => {
  const config = parseConfig({});
  const sel = (diff, brief) => selectReviewers({ config, diff, brief });
  const base = sel([{ path: 'src/util.mjs', added_lines: ['export const x = 1;'] }]);
  assert.deepEqual(base.dispatch.map((d) => d.reviewer), ['correctness'], 'correctness is the floor');
  assert.equal(base.skipped.length, 3, 'every non-dispatch is explained');
  assert.ok(base.skipped.every((s) => s.why.length > 0));

  assert.ok(sel([{ path: 'src/auth/login.mjs', added_lines: [] }]).dispatch.some((d) => d.reviewer === 'security'), 'path signal');
  assert.ok(sel([{ path: 'src/x.mjs', added_lines: ['const q = "SELECT * FROM t WHERE id=" + id;'] }]).dispatch.some((d) => d.reviewer === 'security'), 'content signal');
  assert.ok(sel([{ path: 'package.json', added_lines: [] }]).dispatch.some((d) => d.reviewer === 'security'), 'dependency manifest');
  assert.ok(sel([{ path: 'src/x.mjs', added_lines: [] }], { risk_flags: ['perf_sensitive'] }).dispatch.some((d) => d.reviewer === 'performance'), 'brief risk flag');
  const bigDiff = [{ path: 'src/big.mjs', added_lines: Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`) }];
  assert.ok(sel(bigDiff).dispatch.some((d) => d.reviewer === 'skeptic'), 'size threshold');
  assert.deepEqual(sel([]).dispatch, [], 'no diff, no reviewers');
});

test('H12 wiring check: capability-absent skips loudly; offenders block; dormancy routes to wire_in_dormant', () => {
  const { store, cleanup } = makeProject();
  try {
    const absent = runWiringCheck({ adapterModule: { name: 'node', capabilities: { static_wiring: false } }, cwd: '.', scope: [], store, now: NOW });
    assert.deepEqual(absent.skipped, { check: 'wiring-zero-consumer', reason: 'capability_absent:node' });

    const capable = {
      name: 'fake',
      capabilities: { static_wiring: true },
      staticWiring: () => ({ test_only_exports: [{ file: 'src/a.mjs', name: 'exportedButUnwired' }] }),
    };
    const blocked = runWiringCheck({ adapterModule: capable, cwd: '.', scope: [], article: undefined, store, now: NOW });
    assert.equal(blocked.violations.length, 1);
    assert.match(blocked.violations[0], /built-but-not-wired/);

    const dormant = store.create({
      ...envelope('feature_article'),
      slug: 'dormant-feat',
      title: 'd',
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path: 'src/a.mjs', role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'dormant',
      state_reason: 'wired next phase',
      wiring_todo_id: randomUUID(),
      version: 1,
      history: [{ date: NOW, event: 'originating brief' }],
      live_test_refs: [],
    });
    const declared = runWiringCheck({ adapterModule: capable, cwd: '.', scope: [], article: dormant, store, now: NOW });
    assert.deepEqual(declared.violations, []);
    assert.equal(declared.dormant, true);
    const todo = store.get(declared.wire_in_dormant_todo);
    assert.equal(todo.system_reason, 'wire_in_dormant', 'declared dormancy is tracked, never silent');
  } finally {
    cleanup();
  }
});

// --------------------------- dispose-run union (H7 → promotion) ---------------------------

test('dispose-run verifies the union: H7-accumulated reconcile_needed blocks disposal until reconciled', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    writeFileSync(
      join(dir, '.sterling', 'config.json'),
      JSON.stringify({ ...CONFIG, backup_path: join(dir, 'backups').replace(/\\/g, '/') })
    );
    // article created BEFORE the run, marked by H7 mid-run, never reconciled
    const stale = store.create({
      ...envelope('feature_article', '2026-06-09T12:00:00.000Z'),
      slug: 'stale-feat',
      title: 's',
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path: 'src/a.mjs', role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: '2026-06-09T12:00:00.000Z', event: 'originating brief' }],
      live_test_refs: [],
    });
    store.updateRunOptimistic('r-h5', (run) => ({ ...run, reconcile_needed: [stale.id] }));
    // every other condition passes
    const brief = store.get(store.getRun('r-h5').brief_ref);
    store.create({
      ...envelope('feature_article', '2026-06-10T13:00:00.000Z'),
      slug: 'f',
      title: 'F',
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path: 'src/a.mjs', role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'originating brief', target_id: brief.id }],
      live_test_refs: [{ ac_id: 'AC1', test_paths: ['tests/x.test.mjs'] }],
    });
    store.casTransition('running', { ...store.getRun('r-h5'), machine_state: 'completing' });

    const dispose = () =>
      spawnSync(process.execPath, [join(root, 'scripts', 'dispose-run.mjs'), '--run', 'r-h5', '--target', dir], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
    const refused = dispose();
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr ?? '', new RegExp(`article_unreconciled.*${stale.id}`));

    // reconciling the H7-marked article clears the refusal
    store.supersede(stale.id, {
      ...stale,
      id: randomUUID(),
      version: 2,
      what_it_does: 'reconciled',
      created_at: '2026-06-10T14:00:00.000Z',
      updated_at: '2026-06-10T14:00:00.000Z',
      status: 'active',
      superseded_by: null,
      links: [],
    });
    const ok = dispose();
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  } finally {
    cleanup();
  }
});

// --------------------------- H16 (session-event register, run r-0501) ---------------------------

const H16_REGISTER = ['.sterling', 'transient', 'session-events.json'];
function readSessionEvents(dir) {
  const p = join(dir, ...H16_REGISTER);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
}

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

test('AC6: H16 records in direct mode but is silent (allow, NO write) while a run is active', () => {
  assert.ok(existsSync(join(HOOKS, 'h16-event-register.mjs')), 'h16-event-register.mjs must exist for this behavior to be tested');
  const active = makeProject({ withRun: true });
  try {
    const r = runHook('h16-event-register.mjs', hookInput(active.dir, { hook_event_name: 'PostToolUse', tool_name: 'WebSearch', tool_input: { query: 'x' } }), active.dir);
    assert.equal(r.code, 0, 'an active run never blocks the tool');
    assert.equal(readSessionEvents(active.dir).length, 0, 'with a run active the pipeline owns capture — H16 records nothing');
  } finally {
    active.cleanup();
  }
  const direct = makeProject();
  try {
    const r = runHook('h16-event-register.mjs', hookInput(direct.dir, { hook_event_name: 'PostToolUse', tool_name: 'WebSearch', tool_input: { query: 'x' } }), direct.dir);
    assert.equal(r.code, 0);
    assert.equal(readSessionEvents(direct.dir).length, 1, 'direct mode (no active run) records');
  } finally {
    direct.cleanup();
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
    assert.match(nag.stderr, /touched 1 file/, 'only the post-declaration touch counts — the declared one does not');
    assert.match(nag.stderr, /no-capture\.mjs/, 'the nag names the no-capture escape hatch');
    assert.match(nag.stderr, /false declaration is drift/, 'and warns that a false declaration is drift');

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

test('H10 AC6: every terminal path clears touches.json + session-events.json + the nag marker together; allow-only while a run is active', () => {
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
  // (c) allow-only while a run is active — the pipeline owns capture, H10 does not act
  const active = makeProject({ withRun: true });
  try {
    touchRegister(active.dir, ['src/a.mjs']);
    writeSessionEvents(active.dir, [rEvent('a query'), dEvent('src/a.mjs')]);
    const r = runHook('h10-direct-capture.mjs', hookInput(active.dir, { hook_event_name: 'Stop' }), active.dir);
    assert.equal(r.code, 0, 'a live run: H10 is allow-only');
    assert.equal(owed(active.store, 'capture_owed').length + owed(active.store, 'research_owed').length, 0, 'no items enqueued while a run is active');
    assert.equal(existsSync(eventsPath(active.dir)), true, 'allow-only means the register is left untouched, not cleared');
  } finally {
    active.cleanup();
  }
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

// --------------------------- H17 (bash write sweep — coder-frontmatter registration + bundled) ---------------------------
test('H17 is registered on the coder frontmatter Pre AND Post ToolUse Bash matchers (matcher-coverage; H11 silent-dead lesson)', () => {
  const coder = readFileSync(join(root, 'agent-templates', 'coder.md'), 'utf8');
  const fm = (coder.match(/^---\n([\s\S]*?)\n---\n/) ?? [])[1];
  assert.ok(fm, 'coder template has a frontmatter block');
  const postIdx = fm.indexOf('PostToolUse:');
  assert.ok(postIdx > 0, 'coder frontmatter declares PostToolUse');
  const pre = fm.slice(0, postIdx);
  const post = fm.slice(postIdx);
  // Pre: H17 rides the Bash matcher beside H14 to snapshot the baseline BEFORE the command.
  assert.match(pre, /matcher:\s*"Bash"[\s\S]*?h17-bash-write-sweep\.mjs/, 'H17 must be on the PreToolUse Bash matcher');
  // Post: H17 rides a Bash matcher to sweep AFTER the command — else the guard silently never fires.
  assert.match(post, /matcher:\s*"Bash"[\s\S]*?h17-bash-write-sweep\.mjs/, 'H17 must be on a PostToolUse Bash matcher — else the sweep silently never runs');
});

test('H17 bundle runs standalone (no runtime workspace resolution); conductor (no agent_id) short-circuits to allow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-bundle-'));
  try {
    const r = spawnSync(process.execPath, [join(root, 'hooks', 'h17-bash-write-sweep.mjs')], {
      input: JSON.stringify({ cwd: dir, hook_event_name: 'PostToolUse', tool_input: { command: 'echo hi' } }),
      encoding: 'utf8',
      cwd: dir,
      timeout: 60_000,
    });
    assert.doesNotMatch(r.stderr ?? '', /Cannot find module|ERR_MODULE_NOT_FOUND/, 'H17 must be esbuild-bundled — no workspace import at runtime');
    assert.equal(r.status, 0, `conductor (no agent_id) must short-circuit to allow (exit 0); stderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------- H8 slice-presence guard (run r-d630 phase 3, AC4) ---------------------------
//
// The NEW check H8 gains: during an active run, a guarded pipeline-agent dispatch
// whose prompt carries neither the STERLING-SLICE marker nor a SLICE-WAIVED: <reason>
// line is DENIED (teaching both formats) BEFORE the cap increment. 'coder' is a proven
// guarded pipeline type (the cap test above increments dispatch_counts.coder). Marker,
// waiver, non-pipeline, and no-run paths behave exactly as today; the cap is untouched.

const SLICE = (role = 'coder') => `STERLING-SLICE run=r-h5 phase=p1 role=${role} staged=2026-06-10T12:00:00.000Z`;

test('H8 AC4: a guarded pipeline dispatch with neither marker nor waiver is DENIED, teaching both formats, and consumes NO cap slot', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    const dispatch = (over = {}) =>
      runHook('h8-dispatch-cap.mjs', hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'coder', ...over } }), dir);

    const denied = dispatch({ prompt: 'Implement the export feature end to end.' });
    assert.equal(denied.code, 2, 'a markerless/waiverless guarded pipeline dispatch during an active run is denied');
    assert.match(denied.stderr, /STERLING-SLICE/, 'the deny message teaches the marker format');
    assert.match(denied.stderr, /SLICE-WAIVED/, 'the deny message teaches the waiver format');
    // the slice guard is ordered BEFORE the cap increment — no slot consumed
    assert.equal(store.getRun('r-h5').dispatch_counts.coder ?? 0, 0, 'a slice-denied dispatch consumes no cap slot');
    // and it is NOT a cap escalation — this is the slice deny, not the cap deny
    assert.ok(!(store.getRun('r-h5').escalations ?? []).some((e) => e.kind === 'dispatch_cap_exceeded'), 'the slice deny is not a cap-exceeded escalation');
  } finally {
    cleanup();
  }
});

test('H8 AC4: a dispatch carrying the STERLING-SLICE marker (any line) passes and consumes its slot; a SLICE-WAIVED: <reason> line passes; a reasonless SLICE-WAIVED: is denied', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    const dispatch = (over = {}) =>
      runHook('h8-dispatch-cap.mjs', hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'coder', ...over } }), dir);

    // marker on a line other than the first — the check is line-anchored, not string-start
    const passed = dispatch({ prompt: `Here is your dispatch.\n${SLICE()}\n- decision …` });
    assert.equal(passed.code, 0, 'a dispatch whose prompt contains the STERLING-SLICE marker line passes');
    assert.equal(store.getRun('r-h5').dispatch_counts.coder, 1, 'a passing dispatch consumes its cap slot exactly as today');

    const waived = dispatch({ prompt: 'SLICE-WAIVED: fixer-mode targeted one-line patch\napply it' });
    assert.equal(waived.code, 0, 'a SLICE-WAIVED: <reason> line passes (fixer-mode waiver)');
    assert.equal(store.getRun('r-h5').dispatch_counts.coder, 2, 'the waived dispatch also consumes its slot');

    const emptyWaiver = dispatch({ prompt: 'SLICE-WAIVED:' });
    assert.equal(emptyWaiver.code, 2, 'a reasonless SLICE-WAIVED: does not satisfy the waiver (^SLICE-WAIVED: .+)');
    assert.equal(store.getRun('r-h5').dispatch_counts.coder, 2, 'the denied empty-waiver dispatch consumed no slot');
  } finally {
    cleanup();
  }
});

test('H8 AC4: non-pipeline and no-run dispatches behave exactly as today (no slice guard)', () => {
  const withRun = makeProject({ withRun: true });
  try {
    // a NON-pipeline subagent_type (the platform default, not a Sterling pipeline
    // agent) is not slice-guarded even markerless during an active run
    const nonPipe = runHook(
      'h8-dispatch-cap.mjs',
      hookInput(withRun.dir, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'markerless direct dispatch' } }),
      withRun.dir
    );
    assert.equal(nonPipe.code, 0, 'a non-pipeline subagent_type is not slice-guarded (behaves exactly as today)');
  } finally {
    withRun.cleanup();
  }
  const noRun = makeProject();
  try {
    // no active run → the slice guard does not apply, markerless is fine
    const r = runHook(
      'h8-dispatch-cap.mjs',
      hookInput(noRun.dir, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'coder', prompt: 'markerless' } }),
      noRun.dir
    );
    assert.equal(r.code, 0, 'no active run → no slice guard (behaves exactly as today)');
  } finally {
    noRun.cleanup();
  }
});

test('H8 AC4: existing cap semantics are unchanged — at the limit the cap still denies even with a valid marker (the slice guard never shadows the cap)', () => {
  const { dir, store, cleanup } = makeProject({ withRun: true });
  try {
    store.updateRunOptimistic('r-h5', (run) => ({ ...run, dispatch_counts: { coder: 25 } }));
    const capped = runHook(
      'h8-dispatch-cap.mjs',
      hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'coder', prompt: `${SLICE()}\nbody` } }),
      dir
    );
    assert.equal(capped.code, 2, 'a marker-carrying dispatch at the cap limit is still denied by the cap');
    assert.match(capped.stderr, /dispatch cap exceeded/, 'it is the cap deny, not the slice deny — cap semantics unchanged');
  } finally {
    cleanup();
  }
});

// --------------------------- H8 breadth backstop (run r-68eb phase 2, AC2) ---------------------------
//
// The NEW check H8 gains for two-axis phase discipline: breadthDenial. During an
// active run, a guarded pipeline dispatch whose STERLING-SLICE marker names a phase
// whose interface count STRICTLY EXCEEDS config.difficulty.split_interface_threshold
// (default 3) is DENIED, naming phase/count/threshold. breadthDenial is ordered AFTER
// sliceDenial (so the marker is already present) and BEFORE the cap increment (a
// breadth-denied dispatch consumes NO cap slot). Markerless / SLICE-WAIVED /
// unknown-phase / within-threshold prompts pass breadth unchecked. The same config
// field governs (a custom threshold widens/tightens the gate). Probe interface counts
// are chosen distinct (5, 3, 2) so an off-by-one (>= vs >) mutant is caught by the
// exactly-at-threshold case.
//
// These tests build their own over-wide brief + run r-h5 inline (makeProject's default
// brief is within-threshold), mirroring makeProject's withRun block.

const breadthMarker = (phase, role = 'coder') => `STERLING-SLICE run=r-h5 phase=${phase} role=${role} staged=2026-06-10T12:00:00.000Z`;

// Builds a project with run r-h5 whose brief's single phase p1 declares `interfaceCount`
// interfaces (all also in technical_design.interfaces, per the briefSchema superRefine).
// splitThreshold, when set, is written onto config.difficulty.split_interface_threshold —
// the SAME field prep and the gate flag read; omitted → the schema default (3) governs.
function makeBreadthRun({ interfaceCount = 5, splitThreshold = null } = {}) {
  const { dir, store, cleanup } = makeProject();
  if (splitThreshold != null) {
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ ...CONFIG, difficulty: { split_interface_threshold: splitThreshold } }));
  }
  const names = Array.from({ length: interfaceCount }, (_, i) => `iface_${i}`);
  const brief = store.create({
    ...envelope('brief'),
    slug: 'f',
    title: 'F',
    problem: 'p',
    feature: 'f',
    user_stated: { criteria: [], constraints: [] },
    conductor_proposals: [],
    acceptance_criteria: [{ ac_id: 'AC1', text: 'works', verifiable_at: 'final' }],
    technical_design: { approach: 'a', interfaces: names.map((n) => ({ name: n, contract: `${n}() -> void` })), shared_structures: [] },
    blast_radius: { files: [{ path: 'src/a.mjs', owning_articles: [] }], reconcile_list: [] },
    incidental_scope: [],
    out_of_scope: [],
    phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], interfaces: names, difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
    decisions_made: [],
  });
  const run = store.createRun({
    id: 'r-h5',
    brief_ref: brief.id,
    branch: 'sterling/run-r-h5',
    machine_state: 'running',
    phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
  });
  return { dir, store, brief, run, names, cleanup };
}

const breadthDispatch = (dir, prompt) =>
  runHook('h8-dispatch-cap.mjs', hookInput(dir, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'coder', prompt } }), dir);

test('H8 AC2: a dispatch whose STERLING-SLICE marker names an OVER-WIDE phase is breadth-DENIED (naming phase/count/threshold) and consumes NO cap slot', () => {
  const { dir, store, cleanup } = makeBreadthRun({ interfaceCount: 5 }); // 5 > default 3 → over-wide
  try {
    const denied = breadthDispatch(dir, `${breadthMarker('p1')}\nImplement it.`);
    assert.equal(denied.code, 2, 'an over-wide-phase marker is breadth-denied');
    assert.match(denied.stderr, /p1/, 'the deny names the over-wide phase');
    assert.match(denied.stderr, /\b5\b/, 'the deny names the interface count (5)');
    assert.match(denied.stderr, /\b3\b/, 'the deny names the threshold in effect (default 3)');
    assert.doesNotMatch(denied.stderr, /dispatch cap exceeded/, 'it is the breadth deny, not the cap deny');
    // ordered AFTER sliceDenial (marker present → slice guard satisfied) and BEFORE the cap increment
    assert.equal(store.getRun('r-h5').dispatch_counts.coder ?? 0, 0, 'a breadth-denied dispatch consumes no cap slot');
    assert.ok(!(store.getRun('r-h5').escalations ?? []).some((e) => e.kind === 'dispatch_cap_exceeded'), 'the breadth deny is not a cap-exceeded escalation');
  } finally {
    cleanup();
  }
});

test('H8 slice guard: a marker that is PRESENT but not line-anchored says so, instead of "neither was present"', () => {
  const { dir, cleanup } = makeBreadthRun({ interfaceCount: 3 });
  try {
    // Both slice regexes are /^…/m, so an indented or bulleted marker does not
    // match. The caller is looking straight at the token in the prompt it just
    // sent, so "Neither token appears" reads as a falsehood and gets resolved by
    // trial-and-error re-indenting — the H14 quoting failure shape.
    const indented = breadthDispatch(dir, `  ${breadthMarker('p1')}\nbody`);
    assert.equal(indented.code, 2, 'an indented marker still fails the line-anchored match');
    assert.match(indented.stderr, /IS present but did not match/, 'the presence is acknowledged');
    assert.match(indented.stderr, /must start its own line/, 'and the actual discriminator is named');
    assert.match(indented.stderr, /not indented/);
    assert.doesNotMatch(indented.stderr, /Neither token appears/, 'the false claim is gone');

    // A waiver with an EMPTY reason fails the `.+` — same acknowledgement path.
    const emptyWaiver = breadthDispatch(dir, 'SLICE-WAIVED:\nbody');
    assert.equal(emptyWaiver.code, 2);
    assert.match(emptyWaiver.stderr, /non-empty reason after the colon/);

    // Genuinely absent keeps the plain wording — the new branch must not fire here.
    const absent = breadthDispatch(dir, 'Implement it, no marker at all.');
    assert.equal(absent.code, 2);
    assert.match(absent.stderr, /Neither token appears anywhere in the prompt/);
    assert.doesNotMatch(absent.stderr, /IS present but did not match/);
  } finally {
    cleanup();
  }
});

test('H8 AC2: a marker naming a WITHIN-threshold phase passes breadth and consumes its slot (strictly-greater: interfaces exactly AT the threshold are allowed)', () => {
  const { dir, store, cleanup } = makeBreadthRun({ interfaceCount: 3 }); // 3 === default threshold → NOT over-wide
  try {
    const passed = breadthDispatch(dir, `${breadthMarker('p1')}\nbody`);
    assert.equal(passed.code, 0, 'a phase with interfaces exactly at the threshold is within bounds — breadth passes');
    assert.equal(store.getRun('r-h5').dispatch_counts.coder, 1, 'a breadth-passing dispatch consumes its cap slot exactly as today');
  } finally {
    cleanup();
  }
});

test('H8 AC2: a SLICE-WAIVED prompt passes breadth unchecked even when the run brief has an over-wide phase (the waiver stays the fixer-mode escape)', () => {
  const { dir, store, cleanup } = makeBreadthRun({ interfaceCount: 5 });
  try {
    const waived = breadthDispatch(dir, 'SLICE-WAIVED: fixer-mode targeted one-line patch\ngo');
    assert.equal(waived.code, 0, 'the waiver bypasses the breadth backstop as it bypasses the slice guard');
    assert.equal(store.getRun('r-h5').dispatch_counts.coder, 1, 'the waived dispatch consumes its slot');
  } finally {
    cleanup();
  }
});

test('H8 AC2: a marker naming a phase NOT in the brief passes breadth unchecked (unknown phase ⇒ null, never a deny)', () => {
  const { dir, store, cleanup } = makeBreadthRun({ interfaceCount: 5 }); // brief has only the over-wide p1; the marker names p9
  try {
    const r = breadthDispatch(dir, `${breadthMarker('p9')}\nbody`);
    assert.equal(r.code, 0, 'a marker phase absent from the brief is not breadth-judged');
    assert.equal(store.getRun('r-h5').dispatch_counts.coder, 1, 'and it consumes its slot like any passing dispatch');
  } finally {
    cleanup();
  }
});

test('H8 AC2: a markerless prompt in an over-wide-phase run is denied by the slice guard, not the breadth backstop (breadth passes markerless prompts unchecked)', () => {
  const { dir, store, cleanup } = makeBreadthRun({ interfaceCount: 5 });
  try {
    const denied = breadthDispatch(dir, 'implement it, no marker');
    assert.equal(denied.code, 2, 'markerless is still denied — by the slice-presence guard');
    assert.match(denied.stderr, /STERLING-SLICE/, 'it is the slice deny (teaches the marker format), not a breadth deny');
    assert.match(denied.stderr, /SLICE-WAIVED/, 'and the waiver format');
    assert.equal(store.getRun('r-h5').dispatch_counts.coder ?? 0, 0, 'a slice-denied dispatch consumes no cap slot');
  } finally {
    cleanup();
  }
});

test('H8 AC2: the SAME config field governs the breadth backstop — a custom difficulty.split_interface_threshold widens and tightens it', () => {
  // 5 interfaces would be over-wide at the default 3, but a custom threshold of 10 lets it pass
  const wide = makeBreadthRun({ interfaceCount: 5, splitThreshold: 10 });
  try {
    const r = breadthDispatch(wide.dir, `${breadthMarker('p1')}\nbody`);
    assert.equal(r.code, 0, '5 interfaces is within a custom threshold of 10 — H8 reads difficulty.split_interface_threshold');
    assert.equal(wide.store.getRun('r-h5').dispatch_counts.coder, 1, 'the breadth-passing dispatch consumes its slot');
  } finally {
    wide.cleanup();
  }
  // 3 interfaces exceeds a custom threshold of 2 → breadth-denied (proves the field, not a hardcoded 3)
  const tight = makeBreadthRun({ interfaceCount: 3, splitThreshold: 2 });
  try {
    const r = breadthDispatch(tight.dir, `${breadthMarker('p1')}\nbody`);
    assert.equal(r.code, 2, '3 interfaces exceeds a custom threshold of 2 — breadth-denied');
    assert.doesNotMatch(r.stderr, /dispatch cap exceeded/, 'it is the breadth deny, not the cap deny');
    assert.equal(tight.store.getRun('r-h5').dispatch_counts.coder ?? 0, 0, 'no slot consumed on the breadth deny');
  } finally {
    tight.cleanup();
  }
});

// ---------------------------------------------------------------------------
// RECONCILE RELEVANCE (board b7269100 / feedback §2.9+§2.10). An item said only
// that a file changed, so on a 2717-line file it fired against every article
// owning the path — 27 items audited, FOUR needed a prose change. The material
// for a better item was always in hand and always discarded: PostToolUse carries
// the tool_input of the very call that fired the hook.
// ---------------------------------------------------------------------------

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

test('H7 names WHERE the file changed, so a co-owner can dismiss an irrelevant item in seconds', () => {
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
    const [item] = store.query({ types: ['todo'], cap: 10 });
    assert.match(item.text, /owned file src\/big\.mjs was touched in direct mode, near line 25/);
  } finally {
    cleanup();
  }
});

test('H7 omits the hint rather than inventing one when the tool gives it nothing', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'w.mjs'), 'whole file replaced\n');
    article(store, 'owner', ['src/w.mjs']);

    // Write carries no new_string: there is no honest range to report.
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
    const [item] = store.query({ types: ['todo'], cap: 10 });
    assert.match(item.text, /owned file src\/w\.mjs was touched in direct mode$/, 'no trailing "near lines" clause');
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

test('H10 conductor pressure: hard denies ONCE per session naming fill, threshold and the delegation remedy; spent marker releases the next Stop', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeConductorTranscript(dir, 170_000); // 85% — past hard 50 default
    const first = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(first.code, 2, 'hard pressure soft-blocks once');
    assert.match(first.stderr, /conductor context pressure/i);
    assert.match(first.stderr, /85\.0%/, 'names the fill');
    assert.match(first.stderr, /50%/, 'names the threshold');
    assert.match(first.stderr, /delegat/i, 'names the delegation remedy');
    assert.doesNotMatch(first.stderr, /\/clear/, 'slice 1 never instructs /clear');
    assert.equal(readPressureFile(dir).level, 'hard');
    const second = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(second.code, 0, 'once per session — marker spent');
  } finally {
    cleanup();
  }
});

test('H10 conductor pressure: an UNMAPPED model warns loudly ONCE at any fill level — the gauge names the model, the default window, and the config key to add', () => {
  const { dir, cleanup } = makeProject();
  try {
    // 25% of the 200k DEFAULT — a plausible-looking number, previously silent:
    // the dangerous case (2026-08-11 retrospective: 48% believed at ~10% of real
    // capacity because the project config lacked the model's window entry).
    writeConductorTranscript(dir, 50_000, { model: 'claude-novel-9' });
    const first = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(first.code, 2, 'the gauge warning soft-blocks once even below every threshold');
    assert.match(first.stderr, /claude-novel-9/, 'names the unmapped model');
    assert.match(first.stderr, /context_watch\.windows/, 'names the config key to add');
    assert.match(first.stderr, /200000|200[,_]000|200k/i, 'names the default window it fell back to');
    const sample = readPressureFile(dir);
    assert.equal(sample.unmapped_model, 'claude-novel-9', 'the sample carries the unmapped model');
    assert.equal(sample.level, 'below_soft', 'classification still runs against the default');
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
    assert.match(nag.stderr, /conductor context pressure/i, 'pressure part rides the same deny');
    const second = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(second.code, 0, 'second Stop releases (queue path) with no separate pressure deny');
  } finally {
    cleanup();
  }
});

test('H10 conductor pressure: pipeline runs are untouched — no pressure file, no deny (H9 territory)', () => {
  const { dir, cleanup } = makeProject({ withRun: true });
  try {
    writeConductorTranscript(dir, 170_000);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'active run releases to H9');
    assert.equal(readPressureFile(dir), null, 'no conductor pressure accounting during a run');
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

test('H10 conductor pressure: config thresholds govern (custom soft/hard flip a below-soft fill to hard)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeFileSync(
      join(dir, '.sterling', 'config.json'),
      JSON.stringify({ ...CONFIG, context_watch: { conductor: { soft_pct: 10, hard_pct: 20 } } })
    );
    writeConductorTranscript(dir, 50_000); // 25% — hard under the custom 20 threshold
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 2, 'custom hard threshold fires');
    assert.match(r.stderr, /20%/, 'names the configured threshold');
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

test('H10 slice boundary: soft pressure + dirty tree soft-blocks ONCE naming the commit boundary; clean release after', () => {
  const { dir, dirty, cleanup } = gitProject();
  try {
    writeConductorTranscript(dir, 80_000); // 40% of the 200k default — soft
    dirty();
    const first = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(first.code, 2, 'soft + dirty tree blocks once');
    assert.match(first.stderr, /commit boundary/i);
    assert.match(first.stderr, /uncommitted/i, 'names the dirty state');
    assert.match(first.stderr, /once per session/i);
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

test('H10 slice boundary: hard pressure + dirty tree carries the boundary addendum in the hard block', () => {
  const { dir, dirty, cleanup } = gitProject();
  try {
    writeConductorTranscript(dir, 170_000); // 85% — hard
    dirty();
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /conductor context pressure/i);
    assert.match(r.stderr, /commit boundary/i, 'hard message names the boundary when dirty');
  } finally {
    cleanup();
  }
});

test('H10 slice boundary: soft-boundary block does not suppress a later hard escalation; hard marker ends it', () => {
  const { dir, dirty, cleanup } = gitProject();
  try {
    writeConductorTranscript(dir, 80_000);
    dirty();
    assert.equal(runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir).code, 2, 'soft boundary block');
    writeConductorTranscript(dir, 170_000); // escalate to hard
    const hard = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(hard.code, 2, 'escalation still notifies');
    assert.match(hard.stderr, /hard threshold/);
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
      assert.match(r.out.hookSpecificOutput.additionalContext, /Sterling conventions/, 'conventions intact');
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

test('H10 hard pressure names the rotation protocol: rotation note + READY TO CLEAR', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeConductorTranscript(dir, 170_000); // 85% — hard
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /rotation-note\.mjs/, 'names the writer');
    assert.match(r.stderr, /READY TO CLEAR/, 'names the protocol');
  } finally {
    cleanup();
  }
});
