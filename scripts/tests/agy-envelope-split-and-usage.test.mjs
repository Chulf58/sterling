// GitHub #317 (agy truncates a systemMessage over ~4,060 chars: the envelope splits long text)
// and #318 (latestUsage reads agy PLANNER_RESPONSE turns with top-level token counts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyInjectEnvelope, splitForAgy, AGY_SYSTEM_MESSAGE_MAX_BYTES } from '../hooks/lib/common.mjs';
import { latestUsage, fillPct } from '../hooks/lib/transcript.mjs';

const msgs = (env) => JSON.parse(env).injectSteps.map((s) => s.systemMessage.systemMessage);

test('agy envelope: a long text splits at line boundaries into ordered chunks that rejoin', () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${'é'.repeat(10)}`).join('\n');
  const out = msgs(agyInjectEnvelope(['head', text, 'tail']));
  assert.equal(out[0], 'head');
  assert.equal(out.at(-1), 'tail');
  const chunks = out.slice(1, -1);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(Buffer.byteLength(c, 'utf8') <= AGY_SYSTEM_MESSAGE_MAX_BYTES);
  assert.equal(chunks.join(''), text);
  for (const c of chunks.slice(0, -1)) assert.ok(c.endsWith('\n'));
});

test('agy envelope: one over-long line is cut between characters, never inside one', () => {
  const text = '€'.repeat(5000) + '😀'.repeat(2000);
  const chunks = splitForAgy(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c, 'utf8') <= AGY_SYSTEM_MESSAGE_MAX_BYTES);
    assert.ok(!c.includes('\uFFFD'));
  }
  assert.equal(chunks.join(''), text);
});

test('agy envelope: short text is unchanged', () => {
  assert.deepEqual(JSON.parse(agyInjectEnvelope(['C', 'S'])), { injectSteps: [{ systemMessage: { systemMessage: 'C' } }, { systemMessage: { systemMessage: 'S' } }] });
  assert.equal(agyInjectEnvelope([]), '{}');
});

function transcript(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  const p = join(dir, 't.jsonl');
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { p, dir };
}

test('latestUsage reads an agy PLANNER_RESPONSE turn', () => {
  const { p, dir } = transcript([
    { type: 'USER_INPUT', content: 'hi' },
    { type: 'PLANNER_RESPONSE', model: 'gemini-x', input_tokens: 1000, cache_read_tokens: 500, output_tokens: 20 },
    { type: 'TOOL_RESULT' },
  ]);
  try {
    const r = latestUsage(p);
    assert.equal(r.reason, null);
    assert.equal(r.model, 'gemini-x');
    assert.equal(fillPct(r.usage, 10000), 15);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('latestUsage: a PLANNER_RESPONSE without token counts is format_unparseable', () => {
  const { p, dir } = transcript([{ type: 'PLANNER_RESPONSE', model: 'm' }]);
  try { assert.equal(latestUsage(p).reason, 'format_unparseable'); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('latestUsage: Claude assistant entries behave as before', () => {
  const { p, dir } = transcript([
    { type: 'assistant', message: { model: 'claude-x', usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } } },
  ]);
  try {
    const r = latestUsage(p);
    assert.deepEqual(r.usage, { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 });
    assert.equal(r.model, 'claude-x');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
