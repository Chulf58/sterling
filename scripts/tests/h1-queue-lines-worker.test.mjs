// H1's two maintenance lines name who drains what: the DEEP-queue line separates
// the lanes the background worker drains (reconcile_needed) from the conductor's,
// and the RECONCILE BACKLOG line names the worker's real state instead of a bare
// "worker not running" (board 27c87783; the user asked on 2026-10-03 why the
// conductor drained by hand when a worker exists). The lines are pure text over
// state files, so these tests call the shared lib directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queueDepthLine, readMaintenanceState, reconcileBacklog } from '../hooks/lib/maintenance-state.mjs';

const MIN = 60_000;
const inLane = (n, r) => `${n} item${n === 1 ? '' : 's'} in lane ${r}`;

function depth(entries, parked = 0, deepThreshold = 15) {
  const drainable = entries.reduce((s, [, n]) => s + n, 0);
  return queueDepthLine({
    drainable,
    parked,
    queueReasonEntries: entries,
    queueReasons: entries.map(([r, n]) => inLane(n, r)),
    deepThreshold,
  });
}

test('DEEP line: the conductor count and lanes exclude reconcile_needed, which is named as the background worker\'s', () => {
  const line = depth([['capture_owed', 16], ['reconcile_needed', 4]]);
  assert.match(line, /^MAINTENANCE QUEUE IS DEEP — 16 drainable items \(16 items in lane capture_owed\)/);
  assert.match(line, /4 items in lane reconcile_needed[^.]*drained by the background worker/);
  assert.match(line, /Drain the lanes listed above with \/sterling:drain before taking new work/);
  assert.doesNotMatch(line.split('\n')[0], /reconcile_needed/, 'the headline lists only the conductor\'s lanes');
});

test('DEEP line: a queue that is deep only through the worker\'s lane stays silent (nothing for the conductor to drain)', () => {
  assert.equal(depth([['reconcile_needed', 20]]), '');
  assert.equal(depth([['capture_owed', 3], ['reconcile_needed', 20]]), '', 'the threshold counts the conductor\'s lanes');
});

test('DEEP line: no reconcile_needed lane means no worker clause', () => {
  const line = depth([['capture_owed', 15]]);
  assert.match(line, /^MAINTENANCE QUEUE IS DEEP — 15 drainable items \(15 items in lane capture_owed\)/);
  assert.doesNotMatch(line, /background worker/);
});

test('VERY DEEP line: the biggest conductor lane is named and reconcile_needed is still the worker\'s', () => {
  const line = depth([['reconcile_needed', 300], ['stale_research', 100], ['article_missing', 60]]);
  assert.match(line, /^MAINTENANCE QUEUE IS VERY DEEP — 160 drainable items across 2 lane\(s\)/);
  assert.match(line, /Drain the biggest lane now \(100 items in lane stale_research\)/);
  assert.match(line, /300 items in lane reconcile_needed[^.]*drained by the background worker/);
  assert.doesNotMatch(line, /biggest lanes?:.*reconcile_needed/, 'the worker lane is not offered as a lane to drain');
});

function makeDir(config = { toolchains: [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1qw-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  if (config !== null) writeFileSync(join(dir, '.sterling', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

const iso = (ms) => new Date(ms).toISOString();

// A reconcile state as readMaintenanceState returns it. `unjudged` and
// `oldestUnjudged` are what the worker still has to look at (items judged 'owes
// prose' for their current file_keys are not).
function reconcile(now, { count = 1, unjudged = count, ageMin = 8 } = {}) {
  const oldest = iso(now - ageMin * MIN);
  return { count, owesProse: count - unjudged, oldest, unjudged, oldestUnjudged: unjudged > 0 ? oldest : null };
}

function backlog(dir, rec, now, extra = {}) {
  return reconcileBacklog({ reconcile: rec, cwd: dir, nowMs: now, env: {}, ...extra });
}

const withDir = (config, fn) => {
  const dir = makeDir(config);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('BACKLOG worker state: waiting to batch names the numbers', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const b = backlog(dir, reconcile(now, { count: 1, ageMin: 8 }), now);
    assert.match(b.banner, /, oldest 8m, worker waiting to batch: 1 of 5 unjudged, oldest 8m of 30m$/);
    assert.match(b.line, /worker waiting to batch: 1 of 5 unjudged, oldest 8m of 30m\.$/);
    assert.doesNotMatch(b.line, /worker not running/);
  });
});

test('BACKLOG worker state: a full batch (5 unjudged) is due at the next trigger', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const b = backlog(dir, reconcile(now, { count: 5, ageMin: 3 }), now);
    assert.match(b.banner, /worker due to launch at the next Stop or git commit \(5 unjudged, oldest 3m\)$/);
  });
});

test('BACKLOG worker state: an oldest item that waited 30 minutes is due even below 5', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const b = backlog(dir, reconcile(now, { count: 2, ageMin: 31 }), now);
    assert.match(b.banner, /worker due to launch at the next Stop or git commit \(2 unjudged, oldest 31m\)$/);
  });
});

test('BACKLOG worker state: idle when every open item is already judged owes-prose', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const b = backlog(dir, reconcile(now, { count: 2, unjudged: 0, ageMin: 90 }), now);
    assert.match(b.banner, /worker idle, nothing to judge \(every open item is already judged 'owes prose'\)$/);
  });
});

test('BACKLOG worker state: disabled by config', () => {
  const now = Date.now();
  withDir({ maintenance_worker: { enabled: false } }, (dir) => {
    const b = backlog(dir, reconcile(now), now);
    assert.match(b.banner, /worker disabled by config \(reconcile items wait for \/sterling:drain\)$/);
  });
});

test('BACKLOG worker state: disabled by an injected config object wins over the file', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const b = backlog(dir, reconcile(now), now, { config: { maintenance_worker: { enabled: false } } });
    assert.match(b.banner, /worker disabled by config/);
  });
});

test('BACKLOG worker state: disabled by the environment switch', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const b = backlog(dir, reconcile(now), now, { env: { STERLING_MAINTENANCE_WORKER_DISABLE: '1' } });
    assert.match(b.banner, /worker disabled by STERLING_MAINTENANCE_WORKER_DISABLE \(reconcile items wait for \/sterling:drain\)$/);
  });
});

test('BACKLOG worker state: backing off after a failed run, with the time left', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const at = iso(now - 10 * MIN);
    writeFileSync(join(dir, '.sterling', 'transient', 'maintenance-worker.state.json'), JSON.stringify({ last_run: { ok: false, at, error: 'exit 3' } }));
    const b = backlog(dir, reconcile(now), now);
    assert.match(b.banner, /worker backing off after a failed run \(next launch in 20m\); last worker run FAILED at .*: exit 3 \(log: \.sterling\/maintenance-worker\.log\)$/);
  });
});

test('BACKLOG worker state: backing off after a run that made no progress', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const at = iso(now - 25 * MIN);
    writeFileSync(join(dir, '.sterling', 'transient', 'maintenance-worker.state.json'), JSON.stringify({ last_run: { ok: true, no_progress: true, at } }));
    const b = backlog(dir, reconcile(now), now);
    assert.match(b.banner, /worker backing off after a run that made no progress \(next launch in 5m\)$/);
  });
});

test('BACKLOG worker state: a failed run older than the back-off no longer backs off', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const at = iso(now - 45 * MIN);
    writeFileSync(join(dir, '.sterling', 'transient', 'maintenance-worker.state.json'), JSON.stringify({ last_run: { ok: false, at, error: 'exit 3' } }));
    const b = backlog(dir, reconcile(now), now);
    assert.match(b.banner, /worker waiting to batch: 1 of 5 unjudged, oldest 8m of 30m; last worker run FAILED/);
    assert.doesNotMatch(b.banner, /backing off/);
  });
});

const stateUnknown = (reason) =>
  `worker state unknown (worker state file .sterling/transient/maintenance-worker.state.json unreadable: ${reason})`;

test('BACKLOG worker state: a malformed state file gives "state unknown" with a stable reason, never its content', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    // JSON.parse's own message can quote a prefix of the file, so the marker leads the content
    writeFileSync(join(dir, '.sterling', 'transient', 'maintenance-worker.state.json'), 'SECRET-MARKER-7f3a <html>not json');
    // one hour-old unjudged item: without the state file this reads "due to launch"
    const b = backlog(dir, reconcile(now, { ageMin: 60 }), now);
    assert.ok(b.banner.endsWith(`, ${stateUnknown('invalid JSON')}`), b.banner);
    assert.ok(b.line.endsWith(`${stateUnknown('invalid JSON')}.`), b.line);
    assert.doesNotMatch(b.banner, /SECRET-MARKER/);
    assert.doesNotMatch(b.line, /SECRET-MARKER/);
    assert.doesNotMatch(b.banner, /due to launch|waiting to batch|backing off|idle/);
  });
});

test('BACKLOG worker state: a state file that is valid JSON but not an object gives "not a JSON object"', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    writeFileSync(join(dir, '.sterling', 'transient', 'maintenance-worker.state.json'), '["SECRET-MARKER-7f3a"]');
    const b = backlog(dir, reconcile(now, { ageMin: 60 }), now);
    assert.ok(b.banner.endsWith(`, ${stateUnknown('not a JSON object')}`), b.banner);
    assert.doesNotMatch(b.banner, /SECRET-MARKER/);
  });
});

test('BACKLOG worker state: a state file that cannot be read (a directory at its path) names only the error code', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    mkdirSync(join(dir, '.sterling', 'transient', 'maintenance-worker.state.json'));
    const b = backlog(dir, reconcile(now, { ageMin: 60 }), now);
    assert.ok(b.banner.endsWith(`, ${stateUnknown('EISDIR')}`), b.banner);
    assert.ok(b.line.endsWith(`${stateUnknown('EISDIR')}.`), b.line);
    assert.doesNotMatch(b.banner, /illegal operation/);
    assert.doesNotMatch(b.banner, /due to launch|waiting to batch|backing off|idle/);
  });
});

test('BACKLOG worker state: a malformed config.json gives "invalid JSON", never its content', () => {
  const now = Date.now();
  withDir('SECRET-MARKER-9c1e <html>not json', (dir) => {
    const b = backlog(dir, reconcile(now), now, { config: undefined });
    assert.ok(b.banner.endsWith(', worker state unknown (config.json unreadable: invalid JSON)'), b.banner);
    assert.ok(b.line.endsWith('worker state unknown (config.json unreadable: invalid JSON).'), b.line);
    assert.doesNotMatch(b.banner, /SECRET-MARKER/);
    assert.doesNotMatch(b.line, /SECRET-MARKER/);
  });
});

test('BACKLOG worker state: a config.json that cannot be read (a directory at its path) names only the error code', () => {
  const now = Date.now();
  withDir(null, (dir) => {
    mkdirSync(join(dir, '.sterling', 'config.json'));
    const b = backlog(dir, reconcile(now), now, { config: undefined });
    assert.ok(b.banner.endsWith(', worker state unknown (config.json unreadable: EISDIR)'), b.banner);
    assert.doesNotMatch(b.banner, /illegal operation/);
  });
});

test('BACKLOG worker state: any other caught error says "internal error" plus its code, never its message', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const boom = (err) => ({
      count: 1, owesProse: 0, oldest: iso(now - 8 * MIN), oldestUnjudged: iso(now - 8 * MIN),
      get unjudged() { throw err; },
    });
    const withCode = backlog(dir, boom(Object.assign(new Error('SECRET-MARKER-9c1e'), { code: 'EBOOM' })), now);
    assert.ok(withCode.banner.endsWith(', worker state unknown (internal error: EBOOM)'), withCode.banner);
    assert.ok(withCode.line.endsWith('worker state unknown (internal error: EBOOM).'), withCode.line);
    const noCode = backlog(dir, boom(new Error('SECRET-MARKER-9c1e')), now);
    assert.ok(noCode.banner.endsWith(', worker state unknown (internal error)'), noCode.banner);
    for (const text of [withCode.banner, withCode.line, noCode.banner, noCode.line]) assert.doesNotMatch(text, /SECRET-MARKER/);
  });
});

test('BACKLOG worker state: an absent state file means no run recorded, so due is still inferred', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const b = backlog(dir, reconcile(now, { ageMin: 60 }), now);
    assert.match(b.banner, /worker due to launch at the next Stop or git commit \(1 unjudged, oldest 1h\)$/);
    assert.doesNotMatch(b.banner, /state unknown/);
  });
});

test('BACKLOG worker state: disabled still wins over an unreadable state file', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    writeFileSync(join(dir, '.sterling', 'transient', 'maintenance-worker.state.json'), 'not json');
    const b = backlog(dir, reconcile(now), now, { env: { STERLING_MAINTENANCE_WORKER_DISABLE: '1' } });
    assert.match(b.banner, /worker disabled by STERLING_MAINTENANCE_WORKER_DISABLE/);
  });
});

test('BACKLOG worker state: running wins over an unreadable state file', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    writeFileSync(join(dir, '.sterling', 'transient', 'maintenance-worker.lock'), JSON.stringify({ pid: process.pid, started_at: iso(now - MIN) }));
    writeFileSync(join(dir, '.sterling', 'transient', 'maintenance-worker.state.json'), 'not json');
    const b = backlog(dir, reconcile(now), now);
    assert.match(b.banner, /worker running \(pid /);
  });
});

test('BACKLOG worker state: running keeps its pid and start time, and wins over a recorded back-off', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const since = iso(now - MIN);
    writeFileSync(join(dir, '.sterling', 'transient', 'maintenance-worker.lock'), JSON.stringify({ pid: process.pid, started_at: since }));
    writeFileSync(join(dir, '.sterling', 'transient', 'maintenance-worker.state.json'), JSON.stringify({ last_run: { ok: true, no_progress: true, at: iso(now - 5 * MIN) } }));
    const b = backlog(dir, reconcile(now), now);
    assert.match(b.banner, new RegExp(`worker running \\(pid ${process.pid}, since ${since.replace(/\./g, '\\.')}\\)$`));
  });
});

test('BACKLOG worker state: an unreadable verdict journal gives "state unknown", never a guess', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const b = backlog(dir, { count: 1, owesProse: null, oldest: iso(now - 8 * MIN), unjudged: null, oldestUnjudged: null }, now);
    assert.match(b.banner, /worker state unknown \(verdict journal unreadable\)$/);
    assert.match(b.line, /worker state unknown \(verdict journal unreadable\)\.$/);
  });
});

test('BACKLOG worker state: an unparseable config.json gives "state unknown", never a guess', () => {
  const now = Date.now();
  withDir('{ not json', (dir) => {
    const b = backlog(dir, reconcile(now), now);
    assert.match(b.banner, /worker state unknown \(config\.json unreadable: /);
  });
});

test('BACKLOG: silent with no reconcile item', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    assert.deepEqual(backlog(dir, { count: 0, owesProse: 0, oldest: null, unjudged: 0, oldestUnjudged: null }, now), { banner: '', line: '' });
  });
});

test('readMaintenanceState: unjudged excludes items judged owes-prose for their current file_keys, and dates the oldest unjudged', () => {
  const now = Date.now();
  withDir({ toolchains: [] }, (dir) => {
    const mk = (id, ageMin) => ({ id, system_reason: 'reconcile_needed', file_keys: ['src/a.mjs'], created_at: iso(now - ageMin * MIN) });
    const items = [mk('judged', 500), mk('new1', 20), mk('new2', 4)];
    writeFileSync(join(dir, '.sterling', 'maintenance-worker.jsonl'), JSON.stringify({ kind: 'verdict', item_id: 'judged', verdict: 'owes_prose', file_keys: ['src/a.mjs'], evidence: true }) + '\n');
    const store = { count: () => items.length, query: () => items };
    const m = readMaintenanceState(store, dir);
    assert.equal(m.reconcile.count, 3);
    assert.equal(m.reconcile.owesProse, 1);
    assert.equal(m.reconcile.unjudged, 2);
    assert.equal(m.reconcile.oldestUnjudged, items[1].created_at);
  });
});

test('readMaintenanceState: an unreadable verdict journal makes unjudged null', () => {
  withDir({ toolchains: [] }, (dir) => {
    // a directory where the journal file should be: readFileSync fails with EISDIR, not ENOENT
    mkdirSync(join(dir, '.sterling', 'maintenance-worker.jsonl'));
    const items = [{ id: 'a', system_reason: 'reconcile_needed', file_keys: [], created_at: iso(Date.now() - MIN) }];
    const m = readMaintenanceState({ count: () => 1, query: () => items }, dir);
    assert.equal(m.reconcile.owesProse, null);
    assert.equal(m.reconcile.unjudged, null);
  });
});
