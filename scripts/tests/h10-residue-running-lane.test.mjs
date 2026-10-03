// H10 DEAD-DISPATCH RESIDUE NEVER CALLS A LANE "STOPPED" ON AGE ALONE — board
// 526710de (Dome Farmer 2026-10-03 near-miss). A lane registered 1h11m ago
// with no SubagentStop is past dispatch_register.stale_minutes (60), so H10's
// orphan check reported "dispatch implementor-graphic:<id> stopped holding
// uncommitted edits to <paths>; its gates did not complete." while ListAgents
// showed the lane running. The lease is measured from registration and never
// refreshed, so age proves only that no Stop was SEEN. The H10 line must say
// that: it names the lane, its dirty paths and its registered age, says it may
// still be running, and keeps "gates did not complete" conditional on the lane
// having stopped. H1 (the session boundary, where the lane is gone) and H22's
// kill-signature path keep the unconditional "stopped" line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-residue-running-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'residue@sterling.test']);
  git(dir, ['config', 'user.name', 'Residue Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  mkdirSync(join(dir, 'game', 'sim'), { recursive: true });
  writeFileSync(join(dir, 'game', 'sim', 'swarm.gd'), 'extends Node\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(
    join(dir, '.sterling', 'config.json'),
    JSON.stringify({
      toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } }],
      caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
      context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
      dispatch_register: { stale_minutes: 60 },
    })
  );
  return dir;
}

function runH10(dir) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h10-direct-capture.mjs')], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop' }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, text: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

test('a lane registered past the lease, no Stop seen, is reported as possibly still running, never as stopped', () => {
  const dir = makeProject();
  try {
    writeFileSync(join(dir, 'game', 'sim', 'swarm.gd'), 'extends Node\nvar half_written = true\n');
    writeFileSync(
      join(dir, '.sterling', 'transient', 'dispatch-register.json'),
      JSON.stringify([
        {
          agent_id: 'a5d21bb78a5a8e7d9',
          agent_type: 'implementor-graphic',
          session_id: 's1',
          files: ['game/sim/swarm.gd'],
          at: new Date(Date.now() - 71 * 60_000).toISOString(),
          attribution: 'block',
        },
      ])
    );
    const r = runH10(dir);
    const line = r.text.split(/\\n|\n/).find((l) => l.includes('implementor-graphic:a5d21bb78a5a8e7d9') && /uncommitted/.test(l));
    assert.ok(line, `H10 reports the dirty lane: ${r.text}`);
    assert.match(line, /game\/sim\/swarm\.gd/, `names the dirty path: ${line}`);
    assert.doesNotMatch(line, /\bstopped holding\b/, `age alone never proves the lane stopped: ${line}`);
    assert.match(line, /may still be running/i, `says the lane may still be running: ${line}`);
    assert.match(line, /1h11m/, `names how long it has been registered: ${line}`);
    assert.match(line, /if it has stopped, its gates did not complete/i, `the gates claim is conditional on a stop: ${line}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Decision h10-lane-liveness-from-recent-touches-past-the-lease (board 526710de):
// a lane past the lease whose agent_id has an H7 touch newer than the lease is
// running, so H10 prints no residue line for it at all. One whose newest touch
// is older than the lease still ages out and gets the wording above.
function setUpExpiredLane(dir, touchMinutesAgo, touchesFile = 'touches.json') {
  writeFileSync(join(dir, 'game', 'sim', 'swarm.gd'), 'extends Node\nvar half_written = true\n');
  writeFileSync(
    join(dir, '.sterling', 'transient', 'dispatch-register.json'),
    JSON.stringify([
      {
        agent_id: 'a5d21bb78a5a8e7d9',
        agent_type: 'implementor-graphic',
        session_id: 's1',
        files: ['game/sim/swarm.gd'],
        at: new Date(Date.now() - 71 * 60_000).toISOString(),
        attribution: 'block',
      },
    ])
  );
  writeFileSync(
    join(dir, '.sterling', 'transient', touchesFile),
    JSON.stringify([{ path: 'game/sim/swarm.gd', at: new Date(Date.now() - touchMinutesAgo * 60_000).toISOString(), agent_id: 'a5d21bb78a5a8e7d9' }])
  );
}

test('a lane past the lease with a recent touch by its agent_id gets no residue line', () => {
  const dir = makeProject();
  try {
    setUpExpiredLane(dir, 3);
    const r = runH10(dir);
    assert.equal(r.code, 0, `H10 ran and released (exit ${r.code}): ${r.text}`);
    assert.doesNotMatch(r.text, /implementor-graphic:a5d21bb78a5a8e7d9/, `a lane that is still writing is not residue: ${r.text}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A Stop that died between claiming touches.json and releasing it leaves the
// touches in touches.json.claim; the residue probe reads both files.
test('a lane past the lease whose recent touch exists only in touches.json.claim gets no residue line', () => {
  const dir = makeProject();
  try {
    setUpExpiredLane(dir, 3, 'touches.json.claim');
    const r = runH10(dir);
    assert.equal(r.code, 0, `H10 ran and released (exit ${r.code}): ${r.text}`);
    assert.doesNotMatch(r.text, /implementor-graphic:a5d21bb78a5a8e7d9/, `a lane still writing per the claim file is not residue: ${r.text}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lane past the lease whose newest touch is older than the lease still gets the residue line', () => {
  const dir = makeProject();
  try {
    setUpExpiredLane(dir, 90);
    const r = runH10(dir);
    assert.equal(r.code, 0, `H10 ran and released (exit ${r.code}): ${r.text}`);
    assert.match(r.text, /implementor-graphic:a5d21bb78a5a8e7d9 holds uncommitted edits/, r.text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
