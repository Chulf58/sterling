// The H20 and H23 output composition has one copy (scripts/hooks/lib/axis-compose.mjs),
// called by both Claude Code hooks and the OpenCode plugin's axis.mjs, so the two
// hosts cannot drift (decision sterling-is-fully-standalone-on-opencode-2-full-parity-with-claude-code).
// The hooks' own suites (h20-*.test.mjs, h23-output-axis.test.mjs) pin that the
// rendered output is unchanged; this pins that no caller keeps a private copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB = 'scripts/hooks/lib/axis-compose.mjs';
const CALLERS = ['scripts/hooks/h20-mechanism-axis.mjs', 'scripts/hooks/h23-output-axis.mjs', 'packages/opencode-plugin/src/axis.mjs'];
const read = (rel) => readFileSync(join(repo, rel), 'utf8');

test('the H20 and H23 composition lives only in scripts/hooks/lib/axis-compose.mjs, and every caller imports it', () => {
  assert.ok(existsSync(join(repo, LIB)), `${LIB} exists`);
  const shared = read(LIB);
  const literals = [
    'you have just put a CHOICE TO THE USER',
    'PRIOR ANSWERS in the store',
    'STERLING OUTPUT-AXIS DELIVERY (H23)',
  ];
  for (const literal of literals) {
    assert.ok(shared.includes(literal), `${LIB} holds '${literal}'`);
    for (const caller of CALLERS) assert.ok(!read(caller).includes(literal), `${caller} keeps no copy of '${literal}'`);
  }
  for (const caller of CALLERS) assert.match(read(caller), /from '[^']*axis-compose\.mjs'/, `${caller} imports the shared composition`);
});

test('no axis caller touches a codex tool call: the model pin, the MCP-server disabling and the codex matcher are gone', async () => {
  const lib = await import('../hooks/lib/axis-compose.mjs');
  for (const name of ['codexModelPin', 'codexMcpDisable', 'codexUserMcpServers']) assert.equal(lib[name], undefined, `${name} is no longer exported`);
  const { axisSurface } = await import('../../packages/opencode-plugin/src/axis.mjs');
  assert.equal(axisSurface('codex_codex'), null);
  assert.equal(axisSurface('codex.codex-reply'), null);
  assert.equal(axisSurface('subagent'), 'dispatch');
  const hooks = JSON.parse(read('hooks/hooks.json'));
  const matchers = (hooks.hooks.PreToolUse ?? []).map((e) => e.matcher);
  assert.ok(!matchers.some((m) => /codex/.test(m)), 'hooks.json registers no codex matcher');
  for (const caller of CALLERS) assert.ok(!/mcp__codex__|sparring_partner/.test(read(caller)), `${caller} reads no codex tool call or sparring_partner`);
});
