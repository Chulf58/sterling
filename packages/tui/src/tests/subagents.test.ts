import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeSubagentBlock,
  contextPercent,
  contextWindowFor,
  createSubagentTracker,
  formatElapsed,
  readContextUsage,
  readSubagents,
  subagentTranscriptPath,
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

test('register: rows with no ended are running; a recent ended row is done; an old ended row is left out', () => {
  const root = project();
  try {
    writeRegister(root, [
      row('a1', 'implementor', 65_000),
      row('a2', 'implementor', 5_000),
      row('a3', 'reviewer', 120_000, { ended: { at: iso(30_000), event: 'subagent-stop' } }),
      row('a4', 'scout', 3_600_000, { ended: { at: iso(3_000_000), event: 'subagent-stop' } }),
    ]);
    const src = readSubagents(root, NOW);
    assert.equal(src.availability, 'ok');
    assert.deepEqual(src.rows.map((r) => [r.agentId, r.status]), [['a1', 'running'], ['a2', 'running'], ['a3', 'done']]);
    const a1 = src.rows[0]!;
    assert.equal(a1.agentType, 'implementor');
    assert.equal(a1.elapsedMs, 65_000);
    // a done row's elapsed time is its round's run time, not time since it ended
    assert.equal(src.rows[2]!.elapsedMs, 90_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register: a row H10 stamped residue_reported_at is done at that stamp, never running, and lingers out like an ended one', () => {
  const root = project();
  try {
    writeRegister(root, [
      row('a1', 'implementor', 600_000, { residue_reported_at: iso(30_000) }),
      row('a2', 'implementor', 600_000, { residue_reported_at: iso(3_000_000) }),
      row('a3', 'implementor', 20_000),
      row('a4', 'reviewer', 600_000, { ended: { at: iso(100_000), event: 'subagent-stop' }, residue_reported_at: iso(20_000) }),
    ]);
    const src = readSubagents(root, NOW);
    assert.deepEqual(src.rows.map((r) => [r.agentId, r.status]), [['a3', 'running'], ['a1', 'done'], ['a4', 'done']]);
    const a1 = src.rows.find((r) => r.agentId === 'a1')!;
    assert.equal(a1.endedAt, NOW - 30_000);
    assert.equal(a1.elapsedMs, 570_000);
    assert.equal(src.rows.find((r) => r.agentId === 'a4')!.endedAt, NOW - 100_000, 'a real ended wins over the residue stamp');
    // only residue-stamped rows: nothing is active, so the animation timer (active > 0) stays off
    writeRegister(root, [row('a1', 'implementor', 600_000, { residue_reported_at: iso(30_000) })]);
    const v = createSubagentTracker(root, { readIntervalMs: 0, claudeConfigDir: join(root, 'none') }).view(NOW);
    assert.equal(v.active, 0);
    assert.equal(v.agents[0]!.status, 'done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register: a resumed agent is one row, keyed by its agent_id, with the latest round deciding its status', () => {
  const root = project();
  try {
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

const AGENT = (agentId: string, avatar: number, status: 'running' | 'done' = 'running') => ({
  agentId, avatar, type: 'implementor', description: 'Build the reader', model: 'claude-opus-5-5', status, elapsedMs: 65_000, contextPct: 42 as number | null,
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

test('block: the agents are cards side by side in ONE row, each an 8x3 tile with its three text lines below; no frame, no avatar numbers', () => {
  const b = composeSubagentBlock(view([AGENT('a1', 7), AGENT('a2', 31), AGENT('a3', 2, 'done')]), 160, 30, 0);
  assert.equal(b.height, SPRITE_ROWS + 3, 'one card row: the tile and three text lines');
  const type = b.puts.filter((p) => p.text === 'implementor');
  assert.deepEqual(type.map((p) => [p.x, p.y]), [[0, 3], [26, 3], [52, 3]], 'three cards side by side, text on the row under the tile');
  const statusRow = b.puts.filter((p) => p.y === 4).map((p) => p.text);
  assert.ok(statusRow.includes('running · 42% ctx') && statusRow.includes(' · cla…') && statusRow.includes('done · 42% ctx'), JSON.stringify(statusRow));
  assert.deepEqual(b.puts.filter((p) => p.text === 'Build the reader').map((p) => p.y), [5, 5, 5]);
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

test('block: the status line clips to the card width, keeping the status part first', () => {
  const b = composeSubagentBlock(view([AGENT('a1', 3)]), 160, 30, 0);
  const line = b.puts.filter((p) => p.y === 4);
  assert.equal(line.map((p) => p.text).join(''), 'running · 42% ctx · cla…');
  assert.ok(line.every((p) => p.x + [...p.text].length <= 24), 'nothing past the 24-column card');
});

test('block: only running portraits animate; a done portrait rests on frame 0', () => {
  const running = (tick: number) => composeSubagentBlock(view([AGENT('a1', 5)]), 160, 30, tick).pixels;
  const done = (tick: number) => composeSubagentBlock(view([AGENT('a1', 5, 'done')]), 160, 30, tick).pixels;
  const differs = [0, 1, 2, 3, 4, 5, 6, 7].some((t) => JSON.stringify(running(t)) !== JSON.stringify(running(0)));
  assert.ok(differs, 'a running portrait changes frame over a cycle');
  for (const t of [1, 2, 3, 5]) assert.deepEqual(done(t), done(0));
});

test('block: a narrow pane wraps cards to the next row, and what does not fit is counted', () => {
  const agents = [AGENT('a1', 1), AGENT('a2', 2), AGENT('a3', 3)];
  // 60 columns hold two 24-column cards; 13 rows hold two card rows
  const wrapped = composeSubagentBlock(view(agents), 60, 13, 0);
  assert.equal(wrapped.height, 2 * (SPRITE_ROWS + 3) + 1, 'two card rows with a blank row between');
  assert.equal(wrapped.pixels.length, 3 * TILE_COLS * SPRITE_ROWS);
  assert.deepEqual(wrapped.puts.filter((p) => p.text === 'implementor').map((p) => [p.x, p.y]), [[0, 3], [26, 3], [0, 10]]);
  // one card row of room: two cards show and the rest is counted below them
  const one = composeSubagentBlock(view(agents), 60, 7, 0);
  assert.equal(one.pixels.length, 2 * TILE_COLS * SPRITE_ROWS);
  assert.ok(one.puts.some((p) => p.text === '1 more not shown' && p.y === 6));
  assert.ok(one.puts.every((p) => p.x + [...p.text].length <= 60));
  // no room for a card row: a note, no portraits
  const tight = composeSubagentBlock(view(agents), 60, 5, 0);
  assert.equal(tight.pixels.length, 0);
  assert.deepEqual(tight.puts.map((p) => p.text), ['3 sub-agents, no room to show them']);
  assert.equal(composeSubagentBlock(view(agents), 60, 0, 0).height, 0);
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
    assert.ok(text.includes('running · 25% ctx') && text.includes(' · cla…'), JSON.stringify(text));
    assert.ok(text.includes('running · ? ctx') && text.includes(' · model…'), JSON.stringify(text));
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
