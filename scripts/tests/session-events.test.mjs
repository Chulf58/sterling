// The session-event register writer, shared by H16 (Claude Code) and the OpenCode plugin's
// research recorder. Golden tests pin the bytes H16 wrote before the writer was extracted:
// a compact JSON array, one object per event, keys in kind/detail/at/agent_id order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_EVENTS_REL, appendSessionEvent, researchToolEvent } from '../hooks/lib/session-events.mjs';

const AT = '2026-10-02T12:00:00.000Z';

test('researchToolEvent: the research_tool shape H16 records, agent_id only for a non-empty id', () => {
  assert.equal(JSON.stringify(researchToolEvent('rate limits', { at: AT })), '{"kind":"research_tool","detail":"rate limits","at":"2026-10-02T12:00:00.000Z"}');
  assert.equal(JSON.stringify(researchToolEvent('https://x.dev/a', { at: AT, agentId: 'a1' })), '{"kind":"research_tool","detail":"https://x.dev/a","at":"2026-10-02T12:00:00.000Z","agent_id":"a1"}');
  assert.equal(JSON.stringify(researchToolEvent(undefined, { at: AT, agentId: '' })), '{"kind":"research_tool","detail":"","at":"2026-10-02T12:00:00.000Z"}');
});

test('appendSessionEvent: creates the register, appends in order, never dedups, writes compact JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-events-'));
  try {
    assert.equal(SESSION_EVENTS_REL, join('.sterling', 'transient', 'session-events.json'));
    const e = researchToolEvent('q', { at: AT });
    appendSessionEvent(dir, e);
    appendSessionEvent(dir, e);
    appendSessionEvent(dir, { kind: 'agent_dispatch', detail: 'researcher', at: AT, tool_use_id: 't1' });
    assert.equal(
      readFileSync(join(dir, SESSION_EVENTS_REL), 'utf8'),
      '[{"kind":"research_tool","detail":"q","at":"2026-10-02T12:00:00.000Z"},{"kind":"research_tool","detail":"q","at":"2026-10-02T12:00:00.000Z"},{"kind":"agent_dispatch","detail":"researcher","at":"2026-10-02T12:00:00.000Z","tool_use_id":"t1"}]',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendSessionEvent: an unparsable register throws instead of being overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-events-'));
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, SESSION_EVENTS_REL), '{ broken');
    assert.throws(() => appendSessionEvent(dir, researchToolEvent('q', { at: AT })), SyntaxError);
    assert.equal(readFileSync(join(dir, SESSION_EVENTS_REL), 'utf8'), '{ broken');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
