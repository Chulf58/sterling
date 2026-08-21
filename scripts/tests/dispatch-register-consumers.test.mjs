// Script-side dispatch-register consumers (board 54c451b4, decision ec9eacaa):
// liveDispatches filters by the same staleness TTL H10 uses, and
// inFlightAdvisory renders the one advisory line check-projection-fresh and
// build-hooks print. Advisory-only — nothing here gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveDispatches, inFlightAdvisory } from '../lib/dispatch-register.mjs';

function project(entries, config) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-reg-consumers-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  if (entries !== undefined) {
    writeFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), typeof entries === 'string' ? entries : JSON.stringify(entries));
  }
  if (config) writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const entry = (id, agoMs) => ({ agent_id: id, agent_type: 'coder', session_id: 's1', files: ['src/x.mjs'], at: new Date(Date.now() - agoMs).toISOString() });

test('liveDispatches: fresh entries count, stale and future-stamped entries do not, TTL comes from config', () => {
  const { dir, cleanup } = project(
    [entry('fresh', 60_000), entry('stale', 10 * 60_000), entry('future', -120_000)],
    { dispatch_register: { stale_minutes: 5 } }
  );
  try {
    const live = liveDispatches(dir);
    assert.deepEqual(live.map((e) => e.agent_id), ['fresh'], 'only the in-TTL, past-stamped entry is live');
  } finally {
    cleanup();
  }
});

test('liveDispatches: missing register, corrupt JSON, and non-array shapes all read as empty — never a throw', () => {
  const none = project(undefined);
  const corrupt = project('{not json');
  const wrongShape = project({ agent_id: 'x' });
  try {
    assert.deepEqual(liveDispatches(none.dir), []);
    assert.deepEqual(liveDispatches(corrupt.dir), []);
    assert.deepEqual(liveDispatches(wrongShape.dir), []);
  } finally {
    none.cleanup();
    corrupt.cleanup();
    wrongShape.cleanup();
  }
});

test('inFlightAdvisory: names count, agent identities, and the consumer-supplied consequence; null when quiet', () => {
  const busy = project([entry('a1', 1000), entry('a2', 2000)]);
  const quiet = project([]);
  try {
    const line = inFlightAdvisory(busy.dir, 'the consequence clause.');
    assert.match(line, /^2 dispatch\(es\) in flight/);
    assert.match(line, /coder:a1/);
    assert.match(line, /coder:a2/);
    assert.match(line, /the consequence clause\.$/);
    assert.equal(inFlightAdvisory(quiet.dir, 'x'), null, 'no line when nothing is in flight');
  } finally {
    busy.cleanup();
    quiet.cleanup();
  }
});
