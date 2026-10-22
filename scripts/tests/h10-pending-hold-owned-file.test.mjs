// H10 capture_pending hold for a NAMED lane past its lease (GitHub #195).
//
// A lane parked on its own background work outlives dispatch_register.stale_minutes:
// its H22 row is 'unknown' (lease-expired), never presumed-active, yet it has
// sent no terminal hook. A declaration that names that lane's agent_id must keep
// holding while the row stays unended; before the fix it got one grace Stop and
// was then converted to capture_owed debt and cleared, so the conductor had to
// re-declare. An UNNAMED lease-expired row still holds nothing (an orphan the
// declaration never mentioned cannot hold it), and a lane whose row has ended
// follows the normal grace-then-convert path.
//
// Harness shape duplicated from h10-capture-pending-grace.test.mjs (the
// h10-*.test.mjs siblings do not import each other's test files).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(root, 'scripts', 'hooks', 'h10-direct-capture.mjs');
const PENDING_AT = '2026-06-10T12:30:00.000Z';
const OWN_FILE = 'src/pending/work.mjs';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-named-hold-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const transient = (dir, name) => join(dir, '.sterling', 'transient', name);
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

function stopOnce(dir) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, hook_event_name: 'Stop' }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stderr: r.stderr ?? '' };
}

// The conductor's own touched file (NOT owned by the lane's `files`), a
// declaration naming `declaredText`, and one unended row for lane `agentId`
// registered `ageMinutes` ago (past the 60-minute lease when > 60).
function seed(dir, { declaredText, agentId, ageMinutes, ended = null }) {
  mkdirSync(dirname(join(dir, OWN_FILE)), { recursive: true });
  writeFileSync(join(dir, OWN_FILE), '// touched\n');
  writeFileSync(transient(dir, 'touches.json'), JSON.stringify([{ path: OWN_FILE, at: '2026-06-10T12:00:00.000Z' }]));
  writeFileSync(
    transient(dir, 'session-events.json'),
    JSON.stringify([{ kind: 'capture_pending', detail: `${declaredText} — decision rides the lane`, target: declaredText, at: PENDING_AT }])
  );
  writeFileSync(
    transient(dir, 'dispatch-register.json'),
    JSON.stringify([
      {
        agent_id: agentId,
        agent_type: 'coder',
        session_id: 's1',
        files: ['src/elsewhere/lane.mjs'],
        at: minutesAgo(ageMinutes),
        ...(ended ? { ended: { at: ended, event: 'subagent-stop' } } : {}),
      },
    ])
  );
}

const hasDeclaration = (dir) =>
  existsSync(transient(dir, 'session-events.json')) &&
  JSON.parse(readFileSync(transient(dir, 'session-events.json'), 'utf8')).some((e) => e.kind === 'capture_pending');
const captureOwed = (store) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'capture_owed');

test('NH-a (named lease-expired lane holds): a declaration naming an unended lane past its lease stays held across many Stops, never debt', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seed(dir, { declaredText: 'lane-aaa111', agentId: 'lane-aaa111', ageMinutes: 90 });
    for (let i = 1; i <= 4; i += 1) {
      const r = stopOnce(dir);
      assert.equal(r.code, 0, `Stop ${i}: held, never re-demanded (stderr: ${r.stderr})`);
      assert.equal(captureOwed(store).length, 0, `Stop ${i}: CONVERTED-UNDER-LIVE-LANE SHAPE — the named lane has not stopped, so the declaration must not become debt`);
      assert.equal(hasDeclaration(dir), true, `Stop ${i}: the held declaration survives on disk`);
      assert.equal(existsSync(transient(dir, 'touches.json')), true, `Stop ${i}: the hold is non-terminal`);
    }
  } finally {
    cleanup();
  }
});

test('NH-b (hold ends with the lane): once the named lane ends outside the resume window, one grace Stop, then conversion', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seed(dir, { declaredText: 'lane-bbb222', agentId: 'lane-bbb222', ageMinutes: 90 });
    assert.equal(stopOnce(dir).code, 0, 'held');
    assert.equal(hasDeclaration(dir), true);

    seed(dir, { declaredText: 'lane-bbb222', agentId: 'lane-bbb222', ageMinutes: 90, ended: minutesAgo(30) });
    assert.equal(stopOnce(dir).code, 0, 'grace Stop');
    assert.equal(captureOwed(store).length, 0, 'one grace Stop after the lane ended');
    assert.equal(stopOnce(dir).code, 0, 'converting Stop');
    assert.equal(captureOwed(store).length, 1, 'then the lapsed declaration becomes debt');
    assert.equal(hasDeclaration(dir), false, 'the conversion is terminal');
  } finally {
    cleanup();
  }
});

test('NH-c (unnamed or look-alike rows hold nothing): a lease-expired row the declaration does not name as a whole token still converts after one grace Stop', () => {
  for (const [declaredText, agentId] of [
    ['commit-7f3a9c', 'lane-ccc333'],
    ['lane-ddd4440', 'lane-ddd444'],
  ]) {
    const { dir, store, cleanup } = makeProject();
    try {
      seed(dir, { declaredText, agentId, ageMinutes: 90 });
      assert.equal(stopOnce(dir).code, 0, `${declaredText}: grace Stop`);
      assert.equal(captureOwed(store).length, 0, `${declaredText}: one grace Stop`);
      assert.equal(stopOnce(dir).code, 0, `${declaredText}: converting Stop`);
      assert.equal(captureOwed(store).length, 1, `${declaredText}: ORPHAN-HOLD SHAPE if 0 — an unnamed lease-expired row must not hold the declaration`);
    } finally {
      cleanup();
    }
  }
});
