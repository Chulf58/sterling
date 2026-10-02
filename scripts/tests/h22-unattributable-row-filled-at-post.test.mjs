// H22: an UNATTRIBUTABLE register row gets its files from the PostToolUse that
// binds its lane, and a resume of that lane inherits them.
//
// RULING: decision h22-dispatch-files-from-review-territory-and-resume-
// inherits-prior-round (e841facd), option A only: files come from the bound
// brief's REVIEW-TERRITORY, never from the lane's actual writes. INCIDENT:
// research_finding h10-article-demand-misses-live-lanes-same-type-fanout-and-
// out-of-territory-files-october-2026 (79e20118), board 18a80a56. In Dome
// Farmer three implementor-graphic lanes started within one second, every
// Start gave up as unattributable('same-type-siblings-in-flight') and wrote
// files: [], the Posts that bound the lanes about 0.6s later wrote only the
// dispatch-state file, and every resume round copied the empty list. H10 then
// demanded articles for files those live lanes were still writing.
//
// Harness: real H22 PreToolUse/PostToolUse/SubagentStart/SubagentStop events
// spawned against the SOURCE hook, the same idiom as
// h22-review-territory-and-resume-ownership.test.mjs, duplicated locally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const H22 = join(root, 'scripts', 'hooks', 'h22-dispatch-register.mjs');
const TYPE = 'implementor-graphic';

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-post-fill-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const env = { ...process.env, STERLING_CURRENCY_DISABLE: '1' };

function h22(input, cwd) {
  const r = spawnSync(process.execPath, [H22], { input: JSON.stringify(input), encoding: 'utf8', cwd, timeout: 60_000, env });
  assert.equal(r.status, 0, `${input.hook_event_name}: ${r.stderr}`);
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// The same hook, spawned without waiting, so several Starts run at once.
function h22Async(input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [H22], { cwd, env });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ stderr }) : reject(new Error(`${input.hook_event_name} exited ${code}: ${stderr}`))));
    child.stdin.end(JSON.stringify(input));
  });
}

const task = (dir, event, { tool_use_id, prompt, agentId }) => ({
  hook_event_name: event,
  tool_name: 'Agent',
  tool_use_id,
  tool_input: { subagent_type: TYPE, prompt, description: 'a lane', run_in_background: true },
  ...(event === 'PostToolUse'
    ? { tool_response: { isAsync: true, status: 'async_launched', agentId, description: 'a lane', prompt, outputFile: join(dir, 'out.txt'), canReadOutputFile: true } }
    : {}),
  session_id: 's1',
  cwd: dir,
  transcript_path: join(dir, 't', 'parent.jsonl'),
  prompt_id: 'pr-1',
});

const lifecycle = (dir, event, agent_id) => ({
  hook_event_name: event,
  session_id: 's1',
  transcript_path: join(dir, 't', 'no-such-parent-transcript.jsonl'),
  cwd: dir,
  prompt_id: 'pr-1',
  agent_id,
  agent_type: TYPE,
  ...(event === 'SubagentStop' ? { last_assistant_message: 'done' } : {}),
});

const readRegister = (dir) => JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), 'utf8'));
const roundsFor = (dir, agentId) => readRegister(dir).filter((e) => e.agent_id === agentId);
const brief = (lane, territory) => [`Lane ${lane}: graphics pass.`, `REVIEW-TERRITORY: ${JSON.stringify(territory)}`].join('\n');

// Pre for every lane, then every Start at once: each Start sees all of its
// same-type siblings pending and gives up after the bounded wait.
async function fanOut(dir, lanes) {
  for (const l of lanes) h22(task(dir, 'PreToolUse', l), dir);
  const t0 = Date.now();
  const starts = lanes.map((l) => h22Async(lifecycle(dir, 'SubagentStart', l.agentId), dir));
  const launchedWithinMs = Date.now() - t0;
  await Promise.all(starts);
  return launchedWithinMs;
}

test('INCIDENT: three same-type Starts within one second are unattributable; each Post fills its own row from REVIEW-TERRITORY, a repeated Post changes nothing, and a resume inherits the files', async () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'game', 'c'), { recursive: true });
    writeFileSync(join(dir, 'game', 'shared.gd'), '# exists at Post\n');
    const lanes = [
      { tool_use_id: 'toolu_a', agentId: 'aaaa1111', prompt: brief('A', ['game/a']), files: ['game/a'], file_entries: [] },
      { tool_use_id: 'toolu_b', agentId: 'bbbb2222', prompt: brief('B', ['game/b', 'game/b/hud.gd']), files: ['game/b', 'game/b/hud.gd'], file_entries: [] },
      { tool_use_id: 'toolu_c', agentId: 'cccc3333', prompt: brief('C', ['game/c', 'game/shared.gd']), files: ['game/c', 'game/shared.gd'], file_entries: ['game/shared.gd'] },
    ];

    const launchedWithinMs = await fanOut(dir, lanes);
    assert.ok(launchedWithinMs < 1000, `the three Starts launched within one second (took ${launchedWithinMs}ms)`);
    for (const l of lanes) {
      const [row] = roundsFor(dir, l.agentId);
      assert.equal(row.files_source, 'unattributable', `${l.agentId}: the Start could not attribute`);
      assert.equal(row.attribution_case, 'same-type-siblings-in-flight');
      assert.deepEqual(row.files, []);
      assert.equal(row.tool_use_id, null);
    }

    for (const l of lanes) {
      const r = h22(task(dir, 'PostToolUse', l), dir);
      assert.doesNotMatch(r.stderr, /\[dispatch_unattributable\]/, `${l.agentId}: an unambiguous fill is not a degraded path`);
    }
    for (const l of lanes) {
      const rounds = roundsFor(dir, l.agentId);
      assert.equal(rounds.length, 1, `${l.agentId}: the Post fills the row, it never appends one`);
      const [row] = rounds;
      assert.deepEqual(row.files, l.files, `${l.agentId}: owns its declared territory`);
      assert.deepEqual(row.file_entries, l.file_entries, `${l.agentId}: an entry that is a file on disk at Post owns only itself`);
      assert.equal(row.files_source, 'review-territory');
      assert.equal(row.tool_use_id, l.tool_use_id);
      assert.equal(row.attribution_case, 'same-type-siblings-in-flight', 'what the Start saw is kept');
      assert.equal(row.ended, undefined, 'the fill leaves the round live');
    }

    const before = readFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), 'utf8');
    const again = h22(task(dir, 'PostToolUse', lanes[0]), dir);
    assert.doesNotMatch(again.stderr, /\[dispatch_unattributable\]/);
    assert.equal(readFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), 'utf8'), before, 'a repeated Post is idempotent');

    h22(lifecycle(dir, 'SubagentStop', lanes[0].agentId), dir);
    h22(lifecycle(dir, 'SubagentStart', lanes[0].agentId), dir);
    const rounds = roundsFor(dir, lanes[0].agentId);
    assert.equal(rounds.length, 2);
    const resumed = rounds.find((e) => e.round === 2);
    assert.equal(resumed.files_source, 'resume-inherited');
    assert.deepEqual(resumed.files, ['game/a'], 'the resume round inherits the files the Post filled in');
  } finally {
    cleanup();
  }
});

test('AMBIGUOUS: when the lane already has two rows (a resume came before the Post), the Post fills nothing and says so', async () => {
  const { dir, cleanup } = makeProject();
  try {
    const lanes = [
      { tool_use_id: 'toolu_a', agentId: 'aaaa1111', prompt: brief('A', ['game/a']) },
      { tool_use_id: 'toolu_b', agentId: 'bbbb2222', prompt: brief('B', ['game/b']) },
    ];
    await fanOut(dir, lanes);
    h22(lifecycle(dir, 'SubagentStop', lanes[0].agentId), dir);
    h22(lifecycle(dir, 'SubagentStart', lanes[0].agentId), dir);
    const before = readFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), 'utf8');

    const r = h22(task(dir, 'PostToolUse', lanes[0]), dir);
    assert.match(r.stderr, /\[dispatch_unattributable\]/, 'the refused fill is disclosed');
    assert.match(r.stderr, /aaaa1111/);
    assert.match(r.stderr, /2 register rows/);
    assert.equal(readFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), 'utf8'), before, 'neither row is touched');
  } finally {
    cleanup();
  }
});

test('NO DECLARATION: a bound brief without a valid REVIEW-TERRITORY leaves the row empty and says so; option A never falls back to prose', async () => {
  const { dir, cleanup } = makeProject();
  try {
    const lanes = [
      { tool_use_id: 'toolu_a', agentId: 'aaaa1111', prompt: 'Lane A: edit game/a/sprite.gd and nothing else.' },
      { tool_use_id: 'toolu_b', agentId: 'bbbb2222', prompt: 'Lane B.\nREVIEW-TERRITORY: ["game/*"]' },
    ];
    await fanOut(dir, lanes);
    for (const l of lanes) {
      const r = h22(task(dir, 'PostToolUse', l), dir);
      assert.match(r.stderr, /\[dispatch_unattributable\]/, `${l.agentId}: the unfilled row is disclosed`);
      assert.match(r.stderr, new RegExp(l.agentId));
      const [row] = roundsFor(dir, l.agentId);
      assert.deepEqual(row.files, []);
      assert.equal(row.files_source, 'unattributable');
      assert.equal(row.tool_use_id, null);
    }
  } finally {
    cleanup();
  }
});
