// H22 DISPATCH OWNERSHIP — a declared REVIEW-TERRITORY decides `files`, a
// resumed agent keeps its prior round's `files`, and H10 defers a touched file
// to the agent that actually owns it.
//
// RULING: decision h22-dispatch-files-from-review-territory-and-resume-
// inherits-prior-round (e841facd). ROOT CAUSE: research_finding h10-deferral-
// owner-from-brief-free-prose-and-resume-owns-nothing-september-2026
// (95241ec6). INCIDENT: Dome Farmer docs/sterling-issues.md:438-443 — H10
// deferred game/main.gd, game/net/snapshot_codec.gd and game/ui/front_end.gd
// to a FRESH lane F whose brief named them only under "NEVER write", while a
// RESUMED fix-round implementor, the one actually editing them, owned nothing.
//
// Harness: real H22 PreToolUse/PostToolUse/SubagentStart/SubagentStop events
// spawned against the SOURCE hooks, then a real H10 Stop reading the register
// H22 wrote — the same idiom as h22-files-free-prose.test.mjs and
// dispatch-state-hooks.test.mjs, duplicated locally rather than imported.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-ownership-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const h22 = (input, dir) => runHook('h22-dispatch-register.mjs', input, dir);
const out = (r) => `${r.stdout}\n${r.stderr}`;

const task = (dir, event, { tool_use_id, subagent_type, prompt, agentId }) => ({
  hook_event_name: event,
  tool_name: 'Task',
  tool_use_id,
  tool_input: { subagent_type, prompt, description: 'a lane' },
  ...(event === 'PostToolUse'
    ? { tool_response: { isAsync: true, status: 'async_launched', agentId, description: 'a lane', resolvedModel: 'claude-x', prompt, outputFile: join(dir, 'out.txt'), canReadOutputFile: true } }
    : {}),
  session_id: 's1',
  cwd: dir,
  transcript_path: join(dir, 't', 'parent.jsonl'),
  prompt_id: 'pr-1',
});
const lifecycle = (dir, event, agent_id, agent_type = 'implementor') => ({
  hook_event_name: event,
  session_id: 's1',
  transcript_path: join(dir, 't', 'no-such-parent-transcript.jsonl'),
  cwd: dir,
  prompt_id: 'pr-1',
  agent_id,
  agent_type,
  ...(event === 'SubagentStop' ? { last_assistant_message: 'done' } : {}),
});

// A dispatch whose Pre and Post both land, then its own Start: source 'post'.
function dispatch(dir, { tool_use_id, agent_id, prompt, subagent_type = 'implementor' }) {
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const r = h22(task(dir, event, { tool_use_id, subagent_type, prompt, agentId: agent_id }), dir);
    assert.equal(r.code, 0, `${event}: ${r.stderr}`);
  }
  const s = h22(lifecycle(dir, 'SubagentStart', agent_id, subagent_type), dir);
  assert.equal(s.code, 0, `SubagentStart: ${s.stderr}`);
  return s;
}

const registerPath = (dir) => join(dir, '.sterling', 'transient', 'dispatch-register.json');
const readRegister = (dir) => JSON.parse(readFileSync(registerPath(dir), 'utf8'));
const roundsFor = (dir, agentId) => readRegister(dir).filter((e) => e.agent_id === agentId);

function touch(dir, paths) {
  const at = new Date().toISOString();
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '# touched\n');
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at }))));
}

const stop = (dir) =>
  runHook('h10-direct-capture.mjs', { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop' }, dir);

// The H10 disclosure names the owning agent_ids, then the deferred paths.
function deferralLine(r) {
  const line = out(r).split(/\\n|\n/).find((l) => /deferred: \d+ file\(s\) owned by live dispatch/.test(l));
  assert.ok(line, `H10 disclosed a deferral: ${out(r)}`);
  return line;
}

// ---------------------------------------------------------------------------
// The Dome Farmer shapes, reduced to what the defect depends on.
// ---------------------------------------------------------------------------

const HELD = ['game/main.gd', 'game/net/snapshot_codec.gd', 'game/ui/front_end.gd'];

const FIX_ROUND_BRIEF = [
  'Fix round: the snapshot codec regressions from review.',
  `Own ${HELD.join(', ')}.`,
].join('\n');

const LANE_F_BRIEF = [
  'Lane F: farm plots and crop growth.',
  'REVIEW-TERRITORY: ["game/farm", "game/test/farm"]',
  'Held by an uncommitted slice — NEVER write:',
  ...HELD.map((p) => `- ${p}`),
].join('\n');

// ===========================================================================
// (B) REVIEW-TERRITORY is the authority for `files`.
// ===========================================================================

test('the incident: a lane whose REVIEW-TERRITORY is ["game/farm","game/test/farm"] does not own the paths its brief lists under NEVER write', () => {
  const { dir, cleanup } = makeProject();
  try {
    const s = dispatch(dir, { tool_use_id: 'toolu_laneF', agent_id: 'lane-f', prompt: LANE_F_BRIEF });
    const [entry] = roundsFor(dir, 'lane-f');
    assert.deepEqual(entry.files, ['game/farm', 'game/test/farm'], 'files is exactly the declared territory');
    assert.equal(entry.files_source, 'review-territory');
    assert.equal(entry.attribution, 'block');
    for (const p of HELD) assert.ok(!entry.files.includes(p), `${p} is named only under NEVER write and is not lane F's`);
    assert.doesNotMatch(s.stderr, /territory_declaration_malformed/, 'a valid declaration is not disclosed as malformed');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the declaration branch in H22 (free-prose only, as at
// 703a327) — files becomes the three HELD paths and every assertion goes red.

test('a MALFORMED REVIEW-TERRITORY falls back to free-prose extraction, and says so both on stderr and in files_source', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = ['Lane G.', 'REVIEW-TERRITORY: ["game/farm", game/test/farm]', 'Own game/farm/plot.gd.'].join('\n');
    const s = dispatch(dir, { tool_use_id: 'toolu_laneG', agent_id: 'lane-g', prompt });
    const [entry] = roundsFor(dir, 'lane-g');
    assert.deepEqual(entry.files, ['game/farm/plot.gd'], 'the free-prose fallback still gives the lane its prose territory');
    assert.equal(entry.files_source, 'free-prose-malformed-territory', 'the fallback is marked durably in the register, not only in a transient line');
    assert.match(s.stderr, /\[territory_declaration_malformed\]/, `disclosed: ${s.stderr}`);
    assert.match(s.stderr, /REVIEW-TERRITORY: \["game\/farm", game\/test\/farm\]/, 'the bad line is quoted so it can be fixed');
  } finally {
    cleanup();
  }
});

test('REVIEW-TERRITORY entries that are not canonical repo-relative paths (absolute, parent escape, glob, trailing slash) are malformed, never partially honoured', () => {
  for (const bad of ['["/abs/game"]', '["../game"]', '["game/**"]', '["game/farm/"]', '{"files":["game"]}', '["game", 3]']) {
    const { dir, cleanup } = makeProject();
    try {
      const s = dispatch(dir, { tool_use_id: 'toolu_bad', agent_id: 'lane-bad', prompt: `Lane.\nREVIEW-TERRITORY: ${bad}\nOwn game/x.gd.` });
      const [entry] = roundsFor(dir, 'lane-bad');
      assert.equal(entry.files_source, 'free-prose-malformed-territory', `${bad} is malformed`);
      assert.deepEqual(entry.files, ['game/x.gd'], `${bad}: only the free-prose fallback contributes`);
      assert.match(s.stderr, /\[territory_declaration_malformed\]/, `${bad} disclosed: ${s.stderr}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// (A) A resumed agent keeps its prior round's `files`.
// ===========================================================================

test('a RESUMED round inherits the files of the same agent_id\'s most recent prior round, and still stages nothing', () => {
  const { dir, cleanup } = makeProject();
  try {
    dispatch(dir, { tool_use_id: 'toolu_fix1', agent_id: 'fix-round', prompt: FIX_ROUND_BRIEF });
    assert.deepEqual([...roundsFor(dir, 'fix-round')[0].files].sort(), [...HELD].sort(), 'sanity: round 1 owns the held files');
    assert.equal(h22(lifecycle(dir, 'SubagentStop', 'fix-round'), dir).code, 0);

    // SendMessage resume: SubagentStart re-fires with the same agent_id, no Pre/Post.
    const s = h22(lifecycle(dir, 'SubagentStart', 'fix-round'), dir);
    assert.equal(s.code, 0, s.stderr);
    const rounds = roundsFor(dir, 'fix-round');
    assert.equal(rounds.length, 2, 'the resume appends round 2');
    const resumed = rounds.find((e) => !e.ended);
    assert.equal(resumed.attribution_case, 'resume', 'sanity: classified as a resume');
    assert.deepEqual([...resumed.files].sort(), [...HELD].sort(), 'the resumed round keeps the territory it was editing');
    assert.equal(resumed.files_source, 'resume-inherited');
    assert.equal(resumed.attribution, 'none', 'no brief was attributed to the resume — it stages nothing (17c6d781)');
    assert.equal(resumed.tool_use_id, null, 'a resume carries no fresh binding');
  } finally {
    cleanup();
  }
});
// SABOTAGE: write files: [] for a resume (703a327 behaviour) — the inherited
// files assertion goes red.

test('a resume inherits from the MOST RECENT prior round, which itself may be an inherited round', () => {
  const { dir, cleanup } = makeProject();
  try {
    dispatch(dir, { tool_use_id: 'toolu_r1', agent_id: 'chain', prompt: 'Own game/a.gd.' });
    for (let i = 0; i < 2; i += 1) {
      assert.equal(h22(lifecycle(dir, 'SubagentStop', 'chain'), dir).code, 0);
      assert.equal(h22(lifecycle(dir, 'SubagentStart', 'chain'), dir).code, 0);
    }
    const rounds = roundsFor(dir, 'chain');
    assert.equal(rounds.length, 3);
    assert.deepEqual(rounds.map((e) => e.files), [['game/a.gd'], ['game/a.gd'], ['game/a.gd']]);
    assert.deepEqual(rounds.map((e) => e.round), [1, 2, 3]);
  } finally {
    cleanup();
  }
});

test('a resume never inherits from ANOTHER session\'s round of the same agent_id', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeFileSync(
      registerPath(dir),
      JSON.stringify([
        { agent_id: 'x', agent_type: 'implementor', session_id: 's0', files: ['game/foreign.gd'], files_source: 'free-prose-fallback', attribution: 'block', at: new Date().toISOString(), round: 1, ended: { at: new Date().toISOString(), event: 'subagent-stop' } },
        { agent_id: 'x', agent_type: 'implementor', session_id: 's1', files: ['game/mine.gd'], files_source: 'free-prose-fallback', attribution: 'block', at: new Date().toISOString(), round: 1, ended: { at: new Date().toISOString(), event: 'subagent-stop' } },
      ])
    );
    assert.equal(h22(lifecycle(dir, 'SubagentStart', 'x'), dir).code, 0);
    const resumed = readRegister(dir).find((e) => e.session_id === 's1' && !e.ended);
    assert.deepEqual(resumed.files, ['game/mine.gd']);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// H10 — the deferral join credits the agent that owns the path.
// ===========================================================================

test('the incident end to end: H10 defers the held files to the RESUMED fix round, not to lane F, and a file under game/farm/ to lane F', () => {
  const { dir, cleanup } = makeProject();
  try {
    dispatch(dir, { tool_use_id: 'toolu_fix1', agent_id: 'fix-round', prompt: FIX_ROUND_BRIEF });
    assert.equal(h22(lifecycle(dir, 'SubagentStop', 'fix-round'), dir).code, 0);
    dispatch(dir, { tool_use_id: 'toolu_laneF', agent_id: 'lane-f', prompt: LANE_F_BRIEF });
    assert.equal(h22(lifecycle(dir, 'SubagentStart', 'fix-round'), dir).code, 0, 'the fix round is resumed by SendMessage');

    touch(dir, [...HELD, 'game/farm/crop.gd']);
    const r = stop(dir);
    const line = deferralLine(r);
    assert.match(line, /deferred: 4 file\(s\)/, `all four touched files are owned by a live dispatch: ${line}`);
    assert.match(line, /\[fix-round, lane-f\]|\[lane-f, fix-round\]/, `both owners are named: ${line}`);

    // Per-path ownership, read from the register H10 joined against.
    const live = readRegister(dir).filter((e) => !e.ended);
    const owners = (p) => live.filter((e) => e.files.some((f) => f === p || p.startsWith(`${f}/`))).map((e) => e.agent_id);
    for (const p of HELD) assert.deepEqual(owners(p), ['fix-round'], `${p} belongs to the resumed fix round only`);
    assert.deepEqual(owners('game/farm/crop.gd'), ['lane-f']);
  } finally {
    cleanup();
  }
});

test('H10 matches a declared directory on a "/" boundary only: game/farm owns game/farm/crop.gd but not game/farmhouse.gd', () => {
  const { dir, cleanup } = makeProject();
  try {
    dispatch(dir, { tool_use_id: 'toolu_laneF', agent_id: 'lane-f', prompt: LANE_F_BRIEF });
    touch(dir, ['game/farm/crop.gd', 'game/farmhouse.gd']);
    const line = deferralLine(stop(dir));
    assert.match(line, /deferred: 1 file\(s\) owned by live dispatch\(es\) \[lane-f\]: game\/farm\/crop\.gd/, line);
    assert.doesNotMatch(line, /farmhouse/, 'a sibling that merely shares the prefix string is not inside the directory');
  } finally {
    cleanup();
  }
});

test('H10 keeps EXACT matching for a file entry: game/a.gd owns game/a.gd and nothing beside it', () => {
  const { dir, cleanup } = makeProject();
  try {
    dispatch(dir, { tool_use_id: 'toolu_f', agent_id: 'lane-file', prompt: 'Own game/a.gd and game/b.gd.' });
    touch(dir, ['game/a.gd', 'game/c.gd']);
    const line = deferralLine(stop(dir));
    assert.match(line, /deferred: 1 file\(s\) owned by live dispatch\(es\) \[lane-file\]: game\/a\.gd/, line);
  } finally {
    cleanup();
  }
});

test('H10 matches a DOTTED directory entry too: vendor/cache.v2 owns vendor/cache.v2/blob.bin (no file-vs-directory guess)', () => {
  const { dir, cleanup } = makeProject();
  try {
    dispatch(dir, { tool_use_id: 'toolu_v', agent_id: 'lane-v', prompt: 'Lane V.\nREVIEW-TERRITORY: ["vendor/cache.v2"]' });
    touch(dir, ['vendor/cache.v2/blob.bin', 'vendor/other.bin']);
    const line = deferralLine(stop(dir));
    assert.match(line, /deferred: 1 file\(s\) owned by live dispatch\(es\) \[lane-v\]: vendor\/cache\.v2\/blob\.bin/, line);
  } finally {
    cleanup();
  }
});
