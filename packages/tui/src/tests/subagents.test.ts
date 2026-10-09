import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeSubagentBlock,
  contextPercent,
  contextWindowFor,
  createSubagentTracker,
  endsOnHandback,
  formatElapsed,
  formatIdle,
  readContextUsage,
  readSubagents,
  subagentTranscriptPath,
  TRANSCRIPT_ALIVE_MS,
  type SubagentView,
} from '../subagents.js';
import { QUADRANTS, SPRITE_ROWS, TILE_BG, TILE_COLS } from '../avatars/index.js';
import { clearPixels, paintPixels } from '../render.js';

// The terminal dashboard's live-subagent source is H22's dispatch register
// (.sterling/transient/dispatch-register.json), read without its lock. These
// tests pin the live/ended/resumed/corrupt reading and the block composition.

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const iso = (msBefore: number) => new Date(NOW - msBefore).toISOString();

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'sterling-subagents-'));
  mkdirSync(join(root, '.sterling', 'transient', 'dispatch-state'), { recursive: true });
  return root;
}

function writeRegister(root: string, body: unknown): void {
  writeFileSync(join(root, '.sterling', 'transient', 'dispatch-register.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

function row(agent_id: string, agent_type: string, atMsBefore: number, extra: Record<string, unknown> = {}) {
  return { agent_id, agent_type, session_id: 's1', files: [], at: iso(atMsBefore), round: 1, tool_use_id: `toolu_${agent_id}`, ...extra };
}

function writeSession(root: string, sessionId: string): void {
  writeFileSync(join(root, '.sterling', 'transient', 'session.json'), JSON.stringify({ session_id: sessionId, source: 'startup', at: iso(0) }));
}

function writeState(root: string, name: string, record: Record<string, unknown>): void {
  writeFileSync(join(root, '.sterling', 'transient', 'dispatch-state', name), JSON.stringify(record));
}

test('register: an absent register is "absent" with no rows', () => {
  const root = project();
  try {
    const src = readSubagents(root, NOW);
    assert.equal(src.availability, 'absent');
    assert.deepEqual(src.rows, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register: in the current session a row with no ended is running and an ended row is resumable however long ago it ended', () => {
  const root = project();
  try {
    writeSession(root, 's1');
    writeRegister(root, [
      row('a1', 'implementor', 65_000),
      row('a2', 'implementor', 5_000),
      row('a3', 'reviewer', 120_000, { ended: { at: iso(30_000), event: 'subagent-stop' } }),
      row('a4', 'scout', 3_600_000, { ended: { at: iso(3_000_000), event: 'subagent-stop' } }),
    ]);
    const src = readSubagents(root, NOW);
    assert.equal(src.availability, 'ok');
    // running first (oldest start first), then resumable, newest ended first
    assert.deepEqual(src.rows.map((r) => [r.agentId, r.status]), [['a1', 'running'], ['a2', 'running'], ['a3', 'resumable'], ['a4', 'resumable']]);
    const a1 = src.rows[0]!;
    assert.equal(a1.agentType, 'implementor');
    assert.equal(a1.elapsedMs, 65_000);
    // a resumable row's elapsed time is its round's run time, not time since it ended
    assert.equal(src.rows[2]!.elapsedMs, 90_000);
    assert.equal(src.rows[3]!.endedAt, NOW - 3_000_000, 'the 3,000 s old row is kept, with its end time for the idle figure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register: a live row from another session is listed and counted as foreign, an ended row from another session is not listed', () => {
  const root = project();
  try {
    writeSession(root, 's2');
    writeRegister(root, [
      row('a1', 'implementor', 65_000),
      row('a2', 'reviewer', 120_000, { ended: { at: iso(30_000), event: 'subagent-stop' } }),
      row('a3', 'scout', 60_000, { session_id: 's2' }),
      row('a4', 'scout', 3_600_000, { session_id: 's2', ended: { at: iso(3_000_000), event: 'subagent-stop' } }),
    ]);
    const src = readSubagents(root, NOW);
    assert.deepEqual(src.rows.map((r) => [r.agentId, r.status]), [['a1', 'running'], ['a3', 'running'], ['a4', 'resumable']], 'a1 is live in s1 while session.json names s2: listed; a2 ended in s1: not listed');
    assert.equal(src.foreignLive, 1);
    assert.equal(src.rows[0]!.sessionId, 's1', 'the row keeps its own session, which names its transcript directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register: a residue-stamped row from another session whose transcript ends on the handback is not listed and not foreign-live; a quiet one is listed and counted foreign; the foreign count is 0 when every listed row is in the current session', () => {
  const root = project();
  try {
    writeSession(root, 's2');
    const home = claudeHome(root, 's1', 'a1', HANDBACK_TRANSCRIPT);
    writeRegister(root, [
      row('a1', 'implementor', 600_000, { residue_reported_at: iso(30_000) }),
      row('a2', 'scout', 60_000, { session_id: 's2' }),
    ]);
    const src = readSubagents(root, NOW, undefined, home);
    assert.deepEqual(src.rows.map((r) => r.agentId), ['a2']);
    assert.equal(src.foreignLive, 0);
    // a3 in s1 has no transcript to say it ended: quiet, so it stays listed and is counted with the foreign rows
    writeRegister(root, [
      row('a1', 'implementor', 600_000, { residue_reported_at: iso(30_000) }),
      row('a2', 'scout', 60_000, { session_id: 's2' }),
      row('a3', 'implementor', 600_000, { residue_reported_at: iso(30_000) }),
    ]);
    const withQuiet = readSubagents(root, NOW, undefined, home);
    assert.deepEqual(withQuiet.rows.map((r) => [r.agentId, r.status]), [['a2', 'running'], ['a3', 'quiet']]);
    assert.equal(withQuiet.foreignLive, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register: without a readable session.json the old rule holds: running rows listed, ended rows linger DONE_LINGER_MS as done, nothing is resumable', () => {
  const root = project();
  try {
    const body = [
      row('a1', 'implementor', 65_000),
      row('a2', 'implementor', 5_000, { session_id: 'other' }),
      row('a3', 'reviewer', 120_000, { ended: { at: iso(30_000), event: 'subagent-stop' } }),
      row('a4', 'scout', 3_600_000, { ended: { at: iso(3_000_000), event: 'subagent-stop' } }),
    ];
    writeRegister(root, body);
    const expected = [['a1', 'running'], ['a2', 'running'], ['a3', 'done']];
    assert.deepEqual(readSubagents(root, NOW).rows.map((r) => [r.agentId, r.status]), expected, 'session.json missing');
    writeFileSync(join(root, '.sterling', 'transient', 'session.json'), '{"session_id": ');
    assert.deepEqual(readSubagents(root, NOW).rows.map((r) => [r.agentId, r.status]), expected, 'session.json unparseable');
    writeFileSync(join(root, '.sterling', 'transient', 'session.json'), JSON.stringify({ session_id: '' }));
    assert.deepEqual(readSubagents(root, NOW).rows.map((r) => [r.agentId, r.status]), expected, 'session.json without a session id');
    assert.deepEqual(readSubagents(root, NOW, 4_000_000).rows.map((r) => r.agentId), ['a1', 'a2', 'a3', 'a4'], 'the linger window is still the fallback cutoff');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register: a row H10 stamped residue_reported_at whose transcript ends on the handback is ended at that stamp, never running, never resumable: done for the linger window, then dropped, even in the current session', () => {
  const root = project();
  try {
    writeSession(root, 's1');
    const home = claudeHome(root, 's1', 'a1', HANDBACK_TRANSCRIPT);
    claudeHome(root, 's1', 'a2', HANDBACK_TRANSCRIPT);
    writeRegister(root, [
      row('a1', 'implementor', 600_000, { residue_reported_at: iso(30_000) }),
      row('a2', 'implementor', 600_000, { residue_reported_at: iso(3_000_000) }),
      row('a3', 'implementor', 20_000),
      row('a4', 'reviewer', 600_000, { ended: { at: iso(100_000), event: 'subagent-stop' }, residue_reported_at: iso(20_000) }),
    ]);
    const src = readSubagents(root, NOW, undefined, home);
    assert.deepEqual(src.rows.map((r) => [r.agentId, r.status]), [['a3', 'running'], ['a1', 'done'], ['a4', 'resumable']], 'a 30 s old residue row is done, a 3,000 s old one is not listed, a real ended stays resumable');
    const a1 = src.rows.find((r) => r.agentId === 'a1')!;
    assert.equal(a1.endedAt, NOW - 30_000);
    assert.equal(a1.elapsedMs, 570_000);
    assert.equal(src.rows.find((r) => r.agentId === 'a4')!.endedAt, NOW - 100_000, 'a real ended wins over the residue stamp');
    // only residue-stamped rows: nothing is active, so the animation timer (active > 0) stays off
    writeRegister(root, [row('a1', 'implementor', 600_000, { residue_reported_at: iso(30_000) })]);
    const v = createSubagentTracker(root, { readIntervalMs: 0, claudeConfigDir: home }).view(NOW);
    assert.equal(v.active, 0);
    assert.equal(v.agents[0]!.status, 'done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Write the subagent's transcript under a claude home and set its mtime to msBefore NOW. */
function transcriptAged(root: string, sessionId: string, agentId: string, msBefore: number): string {
  const home = claudeHome(root, sessionId, agentId, [transcriptLine('user')]);
  const file = join(home, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), sessionId, 'subagents', `agent-${agentId}.jsonl`);
  utimesSync(file, (NOW - msBefore) / 1000, (NOW - msBefore) / 1000);
  return home;
}

test('register: an H10 residue stamp is unconfirmed, a stamped agent whose transcript was written within TRANSCRIPT_ALIVE_MS is still running and counted, even past the 60 min H10 stamps at', () => {
  const root = project();
  try {
    writeSession(root, 's1');
    const home = transcriptAged(root, 's1', 'a1', 30_000);
    writeRegister(root, [row('a1', 'researcher', 2 * 3_600_000, { residue_reported_at: iso(3_600_000) })]);
    const src = readSubagents(root, NOW, undefined, home);
    assert.deepEqual(src.rows.map((r) => [r.agentId, r.status, r.endedAt]), [['a1', 'running', null]]);
    assert.equal(src.rows[0]!.elapsedMs, 2 * 3_600_000);
    assert.equal(createSubagentTracker(root, { readIntervalMs: 0, claudeConfigDir: home }).view(NOW).active, 1, 'the tab count includes it');
    // a stamped live row from another session is listed and counted foreign, like any live row
    writeSession(root, 's2');
    const foreign = readSubagents(root, NOW, undefined, home);
    assert.equal(foreign.rows.length, 1);
    assert.equal(foreign.foreignLive, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register: a stamped agent whose transcript is stale or missing is quiet, not ended at the stamp, and a real ended is never revived by a fresh transcript', () => {
  const root = project();
  try {
    writeSession(root, 's1');
    const home = transcriptAged(root, 's1', 'a1', TRANSCRIPT_ALIVE_MS + 1_000);
    transcriptAged(root, 's1', 'a3', 1_000);
    writeRegister(root, [
      row('a1', 'researcher', 7_200_000, { residue_reported_at: iso(30_000) }),
      row('a2', 'researcher', 7_200_000, { residue_reported_at: iso(30_000) }),
      row('a3', 'researcher', 7_200_000, { ended: { at: iso(100_000), event: 'subagent-stop' }, residue_reported_at: iso(20_000) }),
    ]);
    const src = readSubagents(root, NOW, undefined, home);
    assert.deepEqual(src.rows.map((r) => [r.agentId, r.status]), [['a1', 'quiet'], ['a2', 'quiet'], ['a3', 'resumable']], 'a1: stale transcript, a2: no transcript, a3: a real ended wins over a fresh transcript');
    assert.equal(src.rows[0]!.endedAt, null, 'a stamp without an end marker is not the end');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register (#34 regression): a live agent silent past TRANSCRIPT_ALIVE_MS inside one long tool call is quiet: listed, out of the running count, never dropped as done, and running again once it writes', () => {
  const root = project();
  try {
    writeSession(root, 's1');
    // the last entry is the tool call it is still waiting on; nothing has been written for 11 minutes
    const home = claudeHome(root, 's1', 'a1', [transcriptLine('user'), TOOL_USE_LINE]);
    const file = join(home, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), 's1', 'subagents', 'agent-a1.jsonl');
    utimesSync(file, (NOW - TRANSCRIPT_ALIVE_MS - 60_000) / 1000, (NOW - TRANSCRIPT_ALIVE_MS - 60_000) / 1000);
    // stamped 50 min ago: as an ended row it would be past the 5 min linger and gone
    writeRegister(root, [row('a1', 'researcher', 2 * 3_600_000, { residue_reported_at: iso(3_000_000) })]);
    const src = readSubagents(root, NOW, undefined, home);
    assert.deepEqual(src.rows.map((r) => [r.agentId, r.status, r.endedAt]), [['a1', 'quiet', null]]);
    assert.equal(src.rows[0]!.elapsedMs, 2 * 3_600_000, 'a quiet row keeps counting its run time');
    const v = createSubagentTracker(root, { readIntervalMs: 0, claudeConfigDir: home }).view(NOW);
    assert.equal(v.active, 0, 'quiet is not counted as running');
    assert.deepEqual(v.agents.map((a) => [a.agentId, a.status, a.idleMs]), [['a1', 'quiet', null]], 'and not shown as done');
    // the tool call returns and the transcript is written again
    utimesSync(file, (NOW - 1_000) / 1000, (NOW - 1_000) / 1000);
    assert.equal(createSubagentTracker(root, { readIntervalMs: 0, claudeConfigDir: home }).view(NOW).active, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register (#34 regression): an agent that finished without a stop event is done once its transcript ends on the handback, though the transcript is still fresh', () => {
  const root = project();
  try {
    writeSession(root, 's1');
    const home = claudeHome(root, 's1', 'a1', HANDBACK_TRANSCRIPT);
    const file = join(home, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), 's1', 'subagents', 'agent-a1.jsonl');
    utimesSync(file, (NOW - 30_000) / 1000, (NOW - 30_000) / 1000);
    writeRegister(root, [row('a1', 'researcher', 2 * 3_600_000, { residue_reported_at: iso(20_000) })]);
    const src = readSubagents(root, NOW, undefined, home);
    assert.deepEqual(src.rows.map((r) => [r.agentId, r.status, r.endedAt]), [['a1', 'done', NOW - 20_000]]);
    assert.equal(createSubagentTracker(root, { readIntervalMs: 0, claudeConfigDir: home }).view(NOW).active, 0, 'not counted as running');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transcript end marker: the last user or assistant entry decides, hook attachments after it do not, and a truncated first tail line is skipped', () => {
  const root = project();
  try {
    const at = (lines: string[]) => {
      const home = claudeHome(root, 's1', 'a1', lines);
      return join(home, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), 's1', 'subagents', 'agent-a1.jsonl');
    };
    assert.equal(endsOnHandback(at(HANDBACK_TRANSCRIPT)), true, 'handback result, then a SubagentStop hook attachment');
    assert.equal(endsOnHandback(at([...HANDBACK_TRANSCRIPT, transcriptLine('user')])), false, 'a resumed round wrote a new prompt after the marker');
    assert.equal(endsOnHandback(at([transcriptLine('user'), TOOL_USE_LINE])), false, 'waiting on a tool call');
    assert.equal(endsOnHandback(at([transcriptLine('user'), transcriptLine('assistant')])), false, 'a plain reply carries no marker');
    // a line longer than the tail window: the window starts inside it, so that part does not parse
    assert.equal(endsOnHandback(at([JSON.stringify({ type: 'user', message: { content: 'x'.repeat(70_000) } }), ...HANDBACK_TRANSCRIPT])), true);
    assert.equal(endsOnHandback(at([])), false, 'an empty transcript');
    assert.equal(endsOnHandback(join(root, 'no-such-file.jsonl')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register: a resumed agent is one row, keyed by its agent_id, with the latest round deciding its status', () => {
  const root = project();
  try {
    writeSession(root, 's1');
    writeRegister(root, [
      row('a1', 'implementor', 600_000, { ended: { at: iso(400_000), event: 'subagent-stop' } }),
      row('a1', 'implementor', 20_000, { round: 2, tool_use_id: null, files_source: 'resume-inherited' }),
    ]);
    writeState(root, 'done-raw-toolu_a1~none.json', { tool_use_id: 'toolu_a1', subagent_type: 'implementor', description: 'Fix the parser', prompt: null });
    const src = readSubagents(root, NOW);
    assert.equal(src.rows.length, 1);
    const r = src.rows[0]!;
    assert.equal(r.agentId, 'a1');
    assert.equal(r.status, 'running');
    assert.equal(r.elapsedMs, 20_000);
    // the resumed round carries no tool_use_id: the description comes from the round that has one
    assert.equal(r.toolUseId, 'toolu_a1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register: a non-JSON or non-array file is "corrupt", never a throw', () => {
  const root = project();
  try {
    writeRegister(root, '[{"agent_id": "a1", "sess');
    assert.equal(readSubagents(root, NOW).availability, 'corrupt');
    writeRegister(root, { agent_id: 'a1' });
    assert.equal(readSubagents(root, NOW).availability, 'corrupt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracker: descriptions come from the dispatch-state record, models from the installed agent; portraits stick across a resume', () => {
  const root = project();
  try {
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(root, '.claude', 'agents', 'implementor.md'), '---\nname: implementor\nmodel: claude-opus-5-5\neffort: high\n---\nbody\n');
    writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify({ models: { reviewer: { model: 'claude-fable-1', effort: 'high' } } }));
    writeState(root, 'live-raw-toolu_a1.json', { tool_use_id: 'toolu_a1', subagent_type: 'implementor', description: 'Build the reader' });
    writeState(root, 'live-raw-toolu_a2.json', { tool_use_id: 'toolu_a2', subagent_type: 'reviewer', description: 'Review the diff' });
    // a record whose body names a different tool_use_id is never trusted
    writeState(root, 'live-raw-toolu_a3.json', { tool_use_id: 'toolu_other', description: 'wrong' });
    writeRegister(root, [row('a1', 'implementor', 10_000), row('a2', 'reviewer', 10_000), row('a3', 'Explore', 10_000)]);
    let n = 0;
    const tracker = createSubagentTracker(root, { rng: () => ((n += 0.37) % 1), readIntervalMs: 0, claudeConfigDir: join(root, 'no-claude-home') });
    const v1 = tracker.view(NOW);
    assert.equal(v1.availability, 'ok');
    assert.equal(v1.active, 3);
    assert.deepEqual(v1.agents.map((a) => [a.type, a.description, a.model]), [
      ['implementor', 'Build the reader', 'claude-opus-5-5'],
      ['reviewer', 'Review the diff', 'claude-fable-1'],
      ['Explore', null, null],
    ]);
    const faces = new Set(v1.agents.map((a) => a.avatar));
    assert.equal(faces.size, 3, 'live agents never share a portrait while the pool has room');
    const a1Face = v1.agents[0]!.avatar;

    // a1 stops, then resumes with the same agent_id: it keeps its portrait
    writeRegister(root, [
      row('a1', 'implementor', 10_000, { ended: { at: iso(5_000), event: 'subagent-stop' } }),
      row('a1', 'implementor', 1_000, { round: 2, tool_use_id: null }),
      row('a2', 'reviewer', 10_000),
    ]);
    const v2 = tracker.view(NOW);
    assert.equal(v2.agents.find((a) => a.agentId === 'a1')!.avatar, a1Face);
    assert.equal(v2.agents.find((a) => a.agentId === 'a1')!.description, 'Build the reader');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracker: reads the register at most once per interval', () => {
  const root = project();
  try {
    writeRegister(root, [row('a1', 'implementor', 10_000)]);
    const tracker = createSubagentTracker(root, { readIntervalMs: 1000, claudeConfigDir: join(root, 'no-claude-home') });
    assert.equal(tracker.view(NOW).active, 1);
    writeRegister(root, [row('a1', 'implementor', 10_000, { ended: { at: iso(0), event: 'subagent-stop' } })]);
    assert.equal(tracker.view(NOW + 300).active, 1, 'an animation tick inside the interval reuses the last read');
    assert.equal(tracker.view(NOW + 1000).active, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function view(agents: SubagentView['agents'], availability: SubagentView['availability'] = 'ok'): SubagentView {
  return { availability, active: agents.filter((a) => a.status === 'running').length, agents };
}

const AGENT = (agentId: string, avatar: number, status: SubagentView['agents'][number]['status'] = 'running') => ({
  agentId, avatar, type: 'implementor', description: 'Build the reader', model: 'claude-sonnet-5-5' as string | null, status, elapsedMs: 65_000, contextPct: 42 as number | null,
  idleMs: null as number | null, contextTokens: null as number | null,
});

test('block: no agents draws one dim line, a readable register is never blank; no room draws nothing', () => {
  for (const availability of ['ok', 'absent'] as const) {
    const b = composeSubagentBlock(view([], availability), 160, 30, 0);
    assert.equal(b.height, 1);
    assert.deepEqual(b.puts.map((p) => [p.text, p.attr.dim]), [['(no sub-agents)', true]]);
    assert.equal(b.pixels.length, 0);
  }
  assert.equal(composeSubagentBlock(view([]), 160, 0, 0).height, 0);
});

test('block: a corrupt register is one dim line that says the state is unknown', () => {
  const b = composeSubagentBlock(view([], 'corrupt'), 160, 30, 0);
  assert.equal(b.height, 1);
  assert.equal(b.pixels.length, 0);
  const text = b.puts.map((p) => p.text).join('\n');
  assert.match(text, /Sub-agents/);
  assert.match(text, /unknown/);
  assert.ok(b.puts.every((p) => p.attr.dim));
});

test('block: on a wide pane the agents are cards side by side in ONE row, each an 8x3 tile with its text lines to the right of it; no frame, no avatar numbers', () => {
  const b = composeSubagentBlock(view([AGENT('a1', 7), AGENT('a2', 31), AGENT('a3', 2, 'done')]), 160, 30, 0);
  assert.equal(b.height, 4, 'one card row: the tile and four text lines share the same rows');
  // 3 cards share 160 columns with a 2-column gap: 52 wide each, so x0 is 0, 54, 108 and the text starts after the 8-column tile and a 1-column gap
  const type = b.puts.filter((p) => p.text === 'implementor');
  assert.deepEqual(type.map((p) => [p.x, p.y]), [[9, 0], [63, 0], [117, 0]], 'text starts right of the tile, on the tile top row');
  assert.deepEqual(b.puts.filter((p) => p.y === 1).map((p) => [p.x, p.text]), [[9, 'running · 42% ctx'], [63, 'running · 42% ctx'], [117, 'done · 42% ctx']]);
  assert.deepEqual(b.puts.filter((p) => p.text === 'claude-sonnet-5-5').map((p) => [p.x, p.y]), [[9, 2], [63, 2], [117, 2]], 'the full model name has its own line');
  assert.deepEqual(b.puts.filter((p) => p.text === 'Build the reader').map((p) => [p.x, p.y]), [[9, 3], [63, 3], [117, 3]]);
  const text = b.puts.map((p) => p.text);
  assert.ok(!text.some((t) => /#\s?\d|\b(7|31)\b/.test(t)), 'no avatar number is printed');
  assert.ok(!text.some((t) => /[┌┐└┘│─]/.test(t)), 'no drawn frame');
  // every agent gets one 8x3 tile: 6x3 portrait cells plus a padding column each side, all on the tile colour
  assert.equal(b.pixels.length, 3 * TILE_COLS * SPRITE_ROWS);
  assert.ok(b.pixels.every((p) => p.bg !== undefined), 'a bg on every tile cell');
  assert.ok(b.pixels.every((p) => [...QUADRANTS].includes(p.ch)), 'composition only emits quadrant glyphs');
  const first = b.pixels[0]!;
  assert.deepEqual({ x: first.x, y: first.y, ch: first.ch, bg: first.bg }, { x: 0, y: 0, ch: ' ', bg: TILE_BG });
  assert.ok(b.pixels.some((p) => p.ch !== ' ' && p.fg !== undefined && p.bg !== undefined), 'a quadrant cell carries both colours');
  assert.ok(b.pixels.every((p) => p.x < 160 && p.y < b.height));
  assert.ok(b.puts.every((p) => p.x + [...p.text].length <= 160));
});

test('block: one agent on a wide pane is a 4-row card: the tile fills the left columns of rows 0-2, the text starts one column to its right on the same rows', () => {
  const b = composeSubagentBlock(view([AGENT('a1', 7)]), 120, 30, 0);
  assert.equal(b.height, 4);
  assert.deepEqual([...new Set(b.pixels.map((p) => p.y))].sort(), [0, 1, 2]);
  assert.equal(Math.min(...b.pixels.map((p) => p.x)), 0);
  assert.equal(Math.max(...b.pixels.map((p) => p.x)), TILE_COLS - 1);
  assert.deepEqual(b.puts.map((p) => [p.x, p.y, p.text]), [
    [TILE_COLS + 1, 0, 'implementor'],
    [TILE_COLS + 1, 1, 'running · 42% ctx'],
    [TILE_COLS + 1, 2, 'claude-sonnet-5-5'],
    [TILE_COLS + 1, 3, 'Build the reader'],
  ]);
});

test('block: no cell is written by both the tile and the text, wide or narrow', () => {
  for (const [agents, width] of [[[AGENT('a1', 7)], 120], [[AGENT('a1', 7), AGENT('a2', 9), AGENT('a3', 4)], 100], [[AGENT('a1', 7), AGENT('a2', 9)], 30]] as const) {
    const b = composeSubagentBlock(view([...agents]), width, 40, 0);
    const tile = new Set(b.pixels.map((p) => `${p.x},${p.y}`));
    for (const p of b.puts) {
      for (let i = 0; i < [...p.text].length; i++) assert.ok(!tile.has(`${p.x + i},${p.y}`), `text "${p.text}" overlaps a tile cell at width ${width}`);
    }
  }
});

test('block: the action line is not cut at 24 columns on a wide pane and is cut at the computed text width', () => {
  const long = 'Rewrite the dispatch register reader so that a corrupt line no longer hides the rows after it';
  const wide = composeSubagentBlock(view([{ ...AGENT('a1', 3), description: long }]), 120, 30, 0);
  assert.ok(wide.puts.some((p) => p.text === long), 'the whole description fits in the 111-column text block');
  // one card on 60 columns: 60 - 8 tile - 1 gap = 51 text columns
  const mid = composeSubagentBlock(view([{ ...AGENT('a1', 3), description: long }]), 60, 30, 0);
  const line = mid.puts.find((p) => p.y === 3)!;
  assert.equal([...line.text].length, 51);
  assert.equal(line.text, [...long].slice(0, 50).join('') + '…');
  assert.ok(mid.puts.every((p) => p.x + [...p.text].length <= 60));
});

test('block: a card without a description is as tall as its tile, and the band takes the tallest card in it', () => {
  const bare = { ...AGENT('a1', 3), description: null };
  assert.equal(composeSubagentBlock(view([bare]), 120, 30, 0).height, SPRITE_ROWS);
  assert.equal(composeSubagentBlock(view([bare, AGENT('a2', 4)]), 120, 30, 0).height, 4, 'two side by side: the described card sets the band');
});

test('block: the agents on a wide pane share the row evenly and wrap once a card would be narrower than the minimum', () => {
  // minimum card = 8 tile + 1 gap + 24 text = 33 columns, 2 between cards
  const xs = (b: ReturnType<typeof composeSubagentBlock>) => b.puts.filter((p) => p.text === 'implementor').map((p) => [p.x - 9, p.y]);
  const n = (count: number) => view(Array.from({ length: count }, (_, i) => AGENT(`a${i}`, i + 1)));
  // 70 columns hold two 34-wide cards: 4 agents wrap onto two bands with a blank row between them
  const two = composeSubagentBlock(n(4), 70, 30, 0);
  assert.deepEqual(xs(two), [[0, 0], [36, 0], [0, 5], [36, 5]]);
  assert.equal(two.height, 4 + 1 + 4);
  // 33 + 2 + 33 = 68 columns is the smallest pane that holds two cards; 67 holds one per row
  assert.deepEqual(xs(composeSubagentBlock(n(2), 68, 30, 0)), [[0, 0], [35, 0]]);
  assert.deepEqual(xs(composeSubagentBlock(n(2), 67, 30, 0)), [[0, 0], [0, 5]], 'one per row, each taking the whole row');
  // 140 columns hold four 33-wide cards; the fifth starts a new band at the same width
  const five = composeSubagentBlock(n(5), 140, 30, 0);
  assert.deepEqual(xs(five), [[0, 0], [35, 0], [70, 0], [105, 0], [0, 5]]);
  assert.ok(five.puts.every((p) => p.x + [...p.text].length <= 140));
});

test('block: a done card is dimmed, a running one is not; the same portrait is faded when done', () => {
  const running = composeSubagentBlock(view([AGENT('a1', 5)]), 160, 30, 0);
  const done = composeSubagentBlock(view([AGENT('a1', 5, 'done')]), 160, 30, 0);
  assert.ok(running.puts.some((p) => p.attr.color === 'green'), 'a running status is green');
  assert.ok(done.puts.every((p) => p.attr.dim), 'every text line of a done card is dim');
  assert.ok(!running.puts.find((p) => p.text === 'implementor')!.attr.dim);
  const coloured = (b: typeof running) => b.pixels.filter((p) => p.fg !== undefined);
  assert.equal(coloured(done).length, coloured(running).length);
  assert.notDeepEqual(coloured(done).map((p) => p.fg), coloured(running).map((p) => p.fg), 'the done portrait is faded');
  assert.ok(done.pixels.every((p) => /^#[0-9a-f]{6}$/.test(p.bg ?? '')), 'faded colours stay valid hex');
});

test('block: a quiet card says quiet in yellow, rests faded like a done one, and is not counted as running', () => {
  const v = view([AGENT('a1', 5, 'quiet')]);
  assert.equal(v.active, 0);
  const b = composeSubagentBlock(v, 160, 30, 0);
  const status = b.puts.find((p) => p.y === 1)!;
  assert.deepEqual([status.text, status.attr], ['quiet · 42% ctx', { color: 'yellow' }]);
  assert.ok(!b.puts.some((p) => p.attr.color === 'green'));
  assert.deepEqual(b.pixels, composeSubagentBlock(view([AGENT('a1', 5, 'done')]), 160, 30, 0).pixels, 'the portrait is the faded done portrait');
});

const RESUMABLE = (agentId: string, avatar: number, idleMs: number | null, contextTokens: number | null, contextPct: number | null = 39) => ({
  ...AGENT(agentId, avatar, 'resumable'), idleMs, contextTokens, contextPct,
});

test('block: a resumable card is dimmed and faded like a done one, rests on frame 0, and is not counted as running', () => {
  const v = view([RESUMABLE('a1', 5, 720_000, 78_400)]);
  assert.equal(v.active, 0);
  const b = composeSubagentBlock(v, 160, 30, 0);
  assert.ok(b.puts.every((p) => p.attr.dim), 'every text line is dim');
  assert.ok(!b.puts.some((p) => p.attr.color === 'green'));
  const done = composeSubagentBlock(view([AGENT('a1', 5, 'done')]), 160, 30, 0);
  assert.deepEqual(b.pixels, done.pixels, 'the portrait is the faded done portrait');
  for (const t of [1, 2, 5]) assert.deepEqual(composeSubagentBlock(v, 160, 30, t).pixels, b.pixels);
});

test('block: the resumable status line is "resumable · idle <t> · <n>k ctx", shortened to fit the text block', () => {
  const status = (a: ReturnType<typeof RESUMABLE>, width: number) => composeSubagentBlock(view([a]), width, 30, 0).puts.filter((p) => p.text.startsWith('resumable')).map((p) => p.text);
  const a = RESUMABLE('a1', 3, 720_000, 78_400);
  // side by side on 160 columns there is room for the percent as well
  assert.deepEqual(status(a, 160), ['resumable · idle 12m · 78k ctx (39%)']);
  // 80 columns hold two cards of 30 text columns each: the percent is dropped, the rest is whole
  const two = composeSubagentBlock(view([a, RESUMABLE('a2', 4, 5_000, 1_000)]), 80, 30, 0).puts.filter((p) => p.text.startsWith('resumable')).map((p) => p.text);
  assert.deepEqual(two, ['resumable · idle 12m · 78k ctx', 'resumable · idle 5s · 1k ctx']);
  // the stacked card is 24 columns: "idle" and the first separator go
  assert.deepEqual(status(a, 30), ['resumable 12m · 78k ctx']);
  assert.deepEqual(status(RESUMABLE('a1', 3, 7_500_000, 178_400), 30), ['resumable 2h 05m · 178k'], 'a long idle time drops the word ctx before it clips the figure');
  // an unknown token count says so, like the unknown percent of a running card
  assert.deepEqual(status(RESUMABLE('a1', 3, 45_000, null, null), 160), ['resumable · idle 45s · ? ctx']);
  // under a thousand tokens is not rounded to 0k
  assert.deepEqual(status(RESUMABLE('a1', 3, 45_000, 640, null), 160), ['resumable · idle 45s · 640 ctx']);
});

test('formatIdle: compact idle time', () => {
  assert.equal(formatIdle(45_000), '45s');
  assert.equal(formatIdle(0), '0s');
  assert.equal(formatIdle(-5), '0s');
  assert.equal(formatIdle(59_999), '59s');
  assert.equal(formatIdle(60_000), '1m');
  assert.equal(formatIdle(12 * 60_000 + 40_000), '12m');
  assert.equal(formatIdle(3_599_000), '59m');
  assert.equal(formatIdle(3_600_000), '1h 00m');
  assert.equal(formatIdle(2 * 3_600_000 + 5 * 60_000), '2h 05m');
});

test('block: the model is shown whole unless longer than the text block, and an unknown model says so', () => {
  const at = (model: string | null, width = 160) => composeSubagentBlock(view([{ ...AGENT('a1', 3), model }]), width, 30, 0).puts.filter((p) => p.y === 2);
  assert.deepEqual(at('claude-sonnet-5-5').map((p) => p.text), ['claude-sonnet-5-5']);
  assert.deepEqual(at('claude-opus-5-5').map((p) => p.text), ['claude-opus-5-5']);
  assert.deepEqual(at(null).map((p) => p.text), ['model unknown']);
  // a wide pane no longer cuts a long model name at 24 columns
  assert.deepEqual(at('claude-a-model-name-longer-than-the-card').map((p) => p.text), ['claude-a-model-name-longer-than-the-card']);
  // one card on 40 columns has 31 text columns
  assert.deepEqual(at('claude-a-model-name-longer-than-the-card', 40).map((p) => p.text), ['claude-a-model-name-longer-tha…']);
});

test('block: a stacked card (pane under 33 columns) still cuts the model at the 24-column card', () => {
  const b = composeSubagentBlock(view([{ ...AGENT('a1', 3), model: 'claude-a-model-name-longer-than-the-card' }]), 30, 30, 0);
  assert.deepEqual(b.puts.filter((p) => p.y === 5).map((p) => p.text), ['claude-a-model-name-lon…']);
  assert.ok(b.puts.every((p) => [...p.text].length <= 24), 'nothing past the 24-column card');
});

test('block: only running portraits animate; a done portrait rests on frame 0', () => {
  const running = (tick: number) => composeSubagentBlock(view([AGENT('a1', 5)]), 160, 30, tick).pixels;
  const done = (tick: number) => composeSubagentBlock(view([AGENT('a1', 5, 'done')]), 160, 30, tick).pixels;
  const differs = [0, 1, 2, 3, 4, 5, 6, 7].some((t) => JSON.stringify(running(t)) !== JSON.stringify(running(0)));
  assert.ok(differs, 'a running portrait changes frame over a cycle');
  for (const t of [1, 2, 3, 5]) assert.deepEqual(done(t), done(0));
});

test('block: a pane under 33 columns falls back to the stacked card: tile above four 24-column text lines, one card per row', () => {
  const agents = [AGENT('a1', 1), AGENT('a2', 2), AGENT('a3', 3)];
  const stacked = composeSubagentBlock(view(agents), 30, 30, 0);
  assert.equal(stacked.height, 3 * (SPRITE_ROWS + 4) + 2, 'three stacked cards, a blank row between');
  assert.equal(stacked.pixels.length, 3 * TILE_COLS * SPRITE_ROWS);
  assert.deepEqual(stacked.puts.filter((p) => p.text === 'implementor').map((p) => [p.x, p.y]), [[0, 3], [0, 11], [0, 19]]);
  assert.ok(stacked.puts.every((p) => p.x + [...p.text].length <= 30));
  assert.equal(composeSubagentBlock(view([AGENT('a1', 1)]), 32, 30, 0).height, SPRITE_ROWS + 4, '32 columns is still stacked');
  assert.equal(composeSubagentBlock(view([AGENT('a1', 1)]), 33, 30, 0).height, 4, '33 columns is the smallest side-by-side card');
});

test('block: what does not fit in the height is counted below the cards; no room for a card row is a note', () => {
  const agents = [AGENT('a1', 1), AGENT('a2', 2), AGENT('a3', 3)];
  // 40 columns: one card per row, 4 rows each. 9 rows hold two bands (4 + 1 + 4)
  const wrapped = composeSubagentBlock(view(agents), 40, 9, 0);
  assert.equal(wrapped.height, 9, 'two card rows with a blank row between');
  assert.equal(wrapped.pixels.length, 2 * TILE_COLS * SPRITE_ROWS);
  assert.deepEqual(wrapped.puts.filter((p) => p.text === 'implementor').map((p) => [p.x, p.y]), [[9, 0], [9, 5]]);
  // one band of room, plus a row for the count of the two that are left out
  const one = composeSubagentBlock(view(agents), 40, 5, 0);
  assert.equal(one.pixels.length, 1 * TILE_COLS * SPRITE_ROWS);
  assert.ok(one.puts.some((p) => p.text === '2 more not shown' && p.y === 4));
  assert.ok(one.puts.every((p) => p.x + [...p.text].length <= 40));
  // no room for a card row: a note, no portraits
  const tight = composeSubagentBlock(view(agents), 40, 3, 0);
  assert.equal(tight.pixels.length, 0);
  assert.deepEqual(tight.puts.map((p) => p.text), ['3 sub-agents, no room to show them']);
  assert.equal(composeSubagentBlock(view(agents), 40, 0, 0).height, 0);
});

test('animation condition: the timer runs only while the Agents tab shows a running agent', () => {
  // main.ts starts the 3 Hz timer when `active > 0 && block.pixels.length > 0`, and composes an empty block
  // off the Agents tab, so both halves are properties of what compose returns
  const live = composeSubagentBlock(view([AGENT('a1', 1)]), 160, 30, 0);
  assert.ok(view([AGENT('a1', 1)]).active > 0 && live.pixels.length > 0);
  const allDone = view([AGENT('a1', 1, 'done')]);
  assert.equal(allDone.active, 0, 'a done-only view has no running agent, so the timer stays off');
});

function transcriptLine(type: string, usage?: Record<string, number>, model = 'claude-opus-5-5'): string {
  return JSON.stringify(usage ? { type, message: { model, usage } } : { type, message: { content: 'x' } });
}

/** An assistant entry calling a tool (the shape Claude Code writes, cut down to the fields that matter). */
const TOOL_USE_LINE = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: {} }], stop_reason: null } });

/** How a subagent's transcript ends when it hands back: the SubagentHandback call, its
 *  tool_result carrying toolEndsTurn: true, then a SubagentStop hook attachment. */
const HANDBACK_TRANSCRIPT = [
  transcriptLine('user'),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_h', name: 'SubagentHandback', input: { message: 'complete' } }], stop_reason: null } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_h', content: 'Report delivered to your caller.' }] }, toolEndsTurn: true }),
  JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'SubagentStop' } }),
];

function claudeHome(root: string, sessionId: string, agentId: string, lines: string[], slug = root.replace(/[^A-Za-z0-9]/g, '-')): string {
  const home = join(root, 'claude-home');
  const dir = join(home, 'projects', slug, sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), lines.join('\n') + '\n');
  return home;
}

test('transcript: the subagent transcript is found under the project slug, or by session id under another slug', () => {
  const root = project();
  try {
    const home = claudeHome(root, 's1', 'a1', [transcriptLine('user')]);
    assert.equal(subagentTranscriptPath(root, 's1', 'a1', home), join(home, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), 's1', 'subagents', 'agent-a1.jsonl'));
    // a session started from another directory (e.g. a worktree) lives under that directory's slug
    claudeHome(root, 's2', 'a2', [transcriptLine('user')], '-somewhere-else');
    assert.equal(subagentTranscriptPath(root, 's2', 'a2', home), join(home, 'projects', '-somewhere-else', 's2', 'subagents', 'agent-a2.jsonl'));
    assert.equal(subagentTranscriptPath(root, 's9', 'a9', home), null);
    assert.equal(subagentTranscriptPath(root, 's1', 'a1', join(root, 'no-such-home')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transcript tail: the latest assistant usage counts input plus both cache fields; no assistant usage or no file is null', () => {
  const root = project();
  try {
    const home = claudeHome(root, 's1', 'a1', [
      transcriptLine('assistant', { input_tokens: 10, cache_read_input_tokens: 10, cache_creation_input_tokens: 10, output_tokens: 99 }),
      transcriptLine('user'),
      transcriptLine('assistant', { input_tokens: 1000, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 49_000, output_tokens: 500 }),
      transcriptLine('user'),
    ]);
    const path = subagentTranscriptPath(root, 's1', 'a1', home)!;
    assert.deepEqual(readContextUsage(path), { tokens: 200_000, model: 'claude-opus-5-5' });
    writeFileSync(path, transcriptLine('user') + '\n');
    assert.equal(readContextUsage(path), null, 'until the first assistant usage exists');
    assert.equal(readContextUsage(join(root, 'missing.jsonl')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('context window: project entry, then the shared table, by model then base model, then the defaults', () => {
  const shared = { 'claude-opus-5': 1_000_000, 'claude-haiku-4-5': 200_000, default: 300_000 };
  assert.equal(contextWindowFor('claude-opus-5', {}, shared), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-5[1m]', {}, shared), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-5', { 'claude-opus-5': 500_000 }, shared), 500_000);
  assert.equal(contextWindowFor('claude-new-1', { default: 400_000 }, shared), 400_000);
  assert.equal(contextWindowFor('claude-new-1', {}, shared), 300_000);
  assert.equal(contextWindowFor('claude-new-1', {}, { 'claude-opus-5': 1 }), null);
  assert.equal(contextWindowFor('claude-new-1', {}, null), null);
  assert.equal(contextPercent(200_000, 1_000_000), 20);
  assert.equal(contextPercent(200_000, 100_000), null, 'over 100% means the window is wrong, so it is unknown');
});

test('tracker: context % from the subagent transcript and the window table, "?" until it is known', () => {
  const root = project();
  try {
    writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify({ context_watch: { windows: { 'claude-opus-5-5': 400_000 } } }));
    const home = claudeHome(root, 's1', 'a1', [transcriptLine('assistant', { input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
    writeRegister(root, [row('a1', 'implementor', 10_000), row('a2', 'implementor', 10_000)]);
    const v = createSubagentTracker(root, { readIntervalMs: 0, claudeConfigDir: home }).view(NOW);
    assert.equal(v.agents[0]!.contextPct, 25);
    assert.equal(v.agents[0]!.model, 'claude-opus-5-5', 'the transcript names the model that actually ran');
    assert.equal(v.agents[1]!.contextPct, null);
    const text = composeSubagentBlock(v, 160, 30, 0).puts.map((p) => p.text);
    assert.ok(text.includes('running · 25% ctx') && text.includes('claude-opus-5-5'), JSON.stringify(text));
    assert.ok(text.includes('running · ? ctx') && text.includes('model unknown'), JSON.stringify(text));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracker: a missing description is retried while the row runs, so the live-to-done rename race heals', () => {
  const root = project();
  try {
    writeRegister(root, [row('a1', 'implementor', 10_000)]);
    const tracker = createSubagentTracker(root, { readIntervalMs: 0, claudeConfigDir: join(root, 'none') });
    assert.equal(tracker.view(NOW).agents[0]!.description, null);
    writeState(root, 'done-raw-toolu_a1~none.json', { tool_use_id: 'toolu_a1', subagent_type: 'implementor', description: 'Fix the parser' });
    assert.equal(tracker.view(NOW + 1000).agents[0]!.description, 'Fix the parser');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracker: a resumable row with no dispatch-state record is read once, not on every refresh; resumed and running, it is retried', () => {
  const root = project();
  try {
    writeSession(root, 's1');
    writeRegister(root, [row('a1', 'implementor', 600_000, { ended: { at: iso(400_000), event: 'subagent-stop' } })]);
    const tracker = createSubagentTracker(root, { readIntervalMs: 0, claudeConfigDir: join(root, 'none') });
    assert.equal(tracker.view(NOW).agents[0]!.description, null);
    // the record appearing later is not seen: the miss was final, so no read happens again for this row
    writeState(root, 'done-raw-toolu_a1~none.json', { tool_use_id: 'toolu_a1', subagent_type: 'implementor', description: 'Fix the parser' });
    assert.equal(tracker.view(NOW + 1000).agents[0]!.description, null, 'the cached miss of a resumable row is not re-read');
    assert.equal(tracker.view(NOW + 2000).agents[0]!.description, null);
    // resumed: the row runs again, the cached miss is dropped and the record is found
    writeRegister(root, [
      row('a1', 'implementor', 600_000, { ended: { at: iso(400_000), event: 'subagent-stop' } }),
      row('a1', 'implementor', 5_000, { round: 2, tool_use_id: null }),
    ]);
    const v = tracker.view(NOW + 3000);
    assert.equal(v.agents[0]!.status, 'running');
    assert.equal(v.agents[0]!.description, 'Fix the parser');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register: rows come out in one order whatever the register order: running by start, then quiet by start, then done and resumable together by end, newest first', () => {
  const root = project();
  try {
    writeSession(root, 's1');
    // d1 and d2 handed back; q1 and q2 have no transcript, so they are quiet
    const home = claudeHome(root, 's1', 'd1', HANDBACK_TRANSCRIPT);
    claudeHome(root, 's1', 'd2', HANDBACK_TRANSCRIPT);
    const rows = [
      row('r1', 'implementor', 50_000),
      row('r2', 'implementor', 90_000),
      row('d1', 'scout', 600_000, { residue_reported_at: iso(30_000) }),
      row('u1', 'reviewer', 600_000, { ended: { at: iso(100_000), event: 'subagent-stop' } }),
      row('u2', 'reviewer', 600_000, { ended: { at: iso(10_000), event: 'subagent-stop' } }),
      row('d2', 'scout', 600_000, { residue_reported_at: iso(200_000) }),
      row('q1', 'scout', 4_000_000, { residue_reported_at: iso(30_000) }),
      row('q2', 'scout', 5_000_000, { residue_reported_at: iso(30_000) }),
    ];
    const expected = ['r2', 'r1', 'q2', 'q1', 'u2', 'd1', 'u1', 'd2'];
    for (const order of [rows, [...rows].reverse(), [rows[6]!, rows[3]!, rows[5]!, rows[0]!, rows[7]!, rows[2]!, rows[4]!, rows[1]!]]) {
      writeRegister(root, order);
      assert.deepEqual(readSubagents(root, NOW, undefined, home).rows.map((r) => r.agentId), expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracker: a missing transcript is not searched again within the retry interval, and an agent that left the register is forgotten', () => {
  const root = project();
  try {
    writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify({ context_watch: { windows: { 'claude-opus-5-5': 400_000 } } }));
    writeRegister(root, [row('a1', 'implementor', 10_000)]);
    const home = join(root, 'claude-home');
    const tracker = createSubagentTracker(root, { readIntervalMs: 0, claudeConfigDir: home });
    assert.equal(tracker.view(NOW).agents[0]!.contextPct, null, 'no transcript yet');
    claudeHome(root, 's1', 'a1', [transcriptLine('assistant', { input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
    assert.equal(tracker.view(NOW + 1000).agents[0]!.contextPct, null, 'the miss is remembered for the retry interval');
    assert.equal(tracker.view(NOW + 60_000).agents[0]!.contextPct, 25, 'then the transcript is found');
    // a1 leaves the register, then a resumed a1 shows up in another session with a bigger transcript
    writeRegister(root, []);
    tracker.view(NOW + 61_000);
    claudeHome(root, 's2', 'a1', [transcriptLine('assistant', { input_tokens: 200_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
    writeRegister(root, [row('a1', 'implementor', 10_000, { session_id: 's2' })]);
    assert.equal(tracker.view(NOW + 62_000).agents[0]!.contextPct, 50, 'no stale path or usage survives the gap');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracker: a resumable agent carries its idle time and the tokens its transcript would re-send, and the tab count stays the running agents', () => {
  const root = project();
  try {
    writeSession(root, 's1');
    writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify({ context_watch: { windows: { 'claude-opus-5-5': 400_000 } } }));
    const home = claudeHome(root, 's1', 'a2', [transcriptLine('assistant', { input_tokens: 78_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
    writeRegister(root, [
      row('a1', 'implementor', 4_000_000, { ended: { at: iso(3_000_000), event: 'subagent-stop' } }),
      row('a2', 'reviewer', 900_000, { ended: { at: iso(720_000), event: 'subagent-stop' } }),
      row('a3', 'scout', 20_000),
      row('a4', 'scout', 600_000, { session_id: 'older', ended: { at: iso(60_000), event: 'subagent-stop' } }),
    ]);
    const v = createSubagentTracker(root, { readIntervalMs: 0, claudeConfigDir: home }).view(NOW);
    assert.equal(v.active, 1, 'active counts running agents only; it is the number in "Agents (N)"');
    assert.deepEqual(v.agents.map((a) => [a.agentId, a.status]), [['a3', 'running'], ['a2', 'resumable'], ['a1', 'resumable']], 'running first, then resumable newest ended first; the other session is absent');
    const a2 = v.agents[1]!;
    assert.equal(a2.idleMs, 720_000);
    assert.equal(a2.contextTokens, 78_000);
    assert.equal(a2.contextPct, 20);
    assert.equal(v.agents[0]!.idleMs, null);
    assert.equal(v.agents[2]!.contextTokens, null, 'no transcript: unknown, not zero');
    // idle time keeps growing with the clock between register reads
    const tracker = createSubagentTracker(root, { readIntervalMs: 60_000, claudeConfigDir: home });
    assert.equal(tracker.view(NOW).agents[1]!.idleMs, 720_000);
    assert.equal(tracker.view(NOW + 30_000).agents[1]!.idleMs, 750_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracker: a resumed agent (round 2, no ended) is running again with the same portrait, and an agent that ended stays listed', () => {
  const root = project();
  try {
    writeSession(root, 's1');
    writeRegister(root, [row('a1', 'implementor', 600_000, { ended: { at: iso(400_000), event: 'subagent-stop' } })]);
    const tracker = createSubagentTracker(root, { readIntervalMs: 0, claudeConfigDir: join(root, 'none') });
    const before = tracker.view(NOW);
    assert.deepEqual(before.agents.map((a) => a.status), ['resumable']);
    writeRegister(root, [
      row('a1', 'implementor', 600_000, { ended: { at: iso(400_000), event: 'subagent-stop' } }),
      row('a1', 'implementor', 5_000, { round: 2, tool_use_id: null }),
    ]);
    const after = tracker.view(NOW + 1000);
    assert.deepEqual(after.agents.map((a) => [a.status, a.idleMs]), [['running', null]]);
    assert.equal(after.active, 1);
    assert.equal(after.agents[0]!.avatar, before.agents[0]!.avatar);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracker: the view carries the foreign-live count from the source', () => {
  const root = project();
  try {
    writeSession(root, 's2');
    writeRegister(root, [row('a1', 'implementor', 10_000), row('a2', 'scout', 10_000, { session_id: 's2' })]);
    const v = createSubagentTracker(root, { readIntervalMs: 0, claudeConfigDir: join(root, 'none') }).view(NOW);
    assert.equal(v.foreignLive, 1);
    assert.equal(v.active, 2, 'both live agents are running');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('block: live agents from another session add one dim line saying the session marker names another session; none when the count is 0 or unset', () => {
  const agents = [AGENT('a1', 7)];
  const plain = composeSubagentBlock(view(agents), 160, 30, 0);
  assert.equal(plain.puts.some((p) => /another session/.test(p.text)), false);
  assert.equal(composeSubagentBlock({ ...view(agents), foreignLive: 0 }, 160, 30, 0).height, plain.height);
  const b = composeSubagentBlock({ ...view(agents), foreignLive: 1 }, 160, 30, 0);
  assert.equal(b.height, plain.height + 1);
  const line = b.puts.find((p) => /another session/.test(p.text))!;
  assert.equal(line.text, 'session.json names another session; live agents from the other one are listed');
  assert.deepEqual([line.x, line.y, line.attr.dim], [0, plain.height, true]);
  assert.equal(composeSubagentBlock({ ...view(agents), foreignLive: 1 }, 160, plain.height, 0).height, plain.height, 'no room: the cards win');
  const none = composeSubagentBlock({ ...view(agents), foreignLive: 1 }, 0, 30, 0);
  assert.deepEqual([none.height, none.puts.length, none.pixels.length], [0, 0, 0], 'width < 1: the cards block is empty, so the note is not appended on its own');
});

test('formatElapsed', () => {
  assert.equal(formatElapsed(4_000), '4s');
  assert.equal(formatElapsed(65_000), '1m05s');
  assert.equal(formatElapsed(3_725_000), '1h02m');
  assert.equal(formatElapsed(-5), '0s');
});

test('paintPixels: 24-bit cells at 1-based positions, and only changed cells on a repeat paint', () => {
  const calls: string[] = [];
  const term = {
    moveTo: (x: number, y: number) => calls.push(`move ${x},${y}`),
    colorRgbHex: (h: string) => calls.push(`fg ${h}`),
    bgColorRgbHex: (h: string) => calls.push(`bg ${h}`),
    styleReset: () => calls.push('reset'),
    noFormat: (s: string) => calls.push(`put ${s}`),
  };
  const first = paintPixels(term, [
    { x: 0, y: 0, ch: '▀', fg: '#112233', bg: '#445566' },
    { x: 1, y: 0, ch: ' ' },
  ]);
  assert.deepEqual(calls, ['reset', 'move 1,1', 'fg #112233', 'bg #445566', 'put ▀', 'reset', 'move 2,1', 'put  ', 'reset']);
  calls.length = 0;
  paintPixels(term, [
    { x: 0, y: 0, ch: '▀', fg: '#112233', bg: '#445566' },
    { x: 1, y: 0, ch: '▄', fg: '#ffffff' },
  ], first);
  assert.deepEqual(calls, ['reset', 'move 2,1', 'fg #ffffff', 'put ▄', 'reset']);

  // the block moved: cells the next paint no longer covers are blanked, kept ones are not touched
  calls.length = 0;
  clearPixels(term, first, [{ x: 1, y: 0, ch: ' ' }]);
  assert.deepEqual(calls, ['reset', 'move 1,1', 'put  ']);

  // trueColor writes the 24-bit SGR itself, so a 16-colour guess by terminal-kit cannot flatten it
  calls.length = 0;
  paintPixels(term, [{ x: 2, y: 3, ch: '▀', fg: '#112233', bg: '#ff0080' }], undefined, true);
  assert.deepEqual(calls, ['reset', 'move 3,4', 'put \x1b[38;2;17;34;51m', 'put \x1b[48;2;255;0;128m', 'put ▀', 'reset']);
});
