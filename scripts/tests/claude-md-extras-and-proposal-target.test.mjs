// GitHub #319 (decision project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer):
// the instruction-file proposal rule targets AGENTS.md on every host. (The sync warning about a
// foreign CLAUDE.md bullet went with scripts/lib/claude-md-extras.mjs: a CLAUDE.md that is not
// pure Sterling text is now kept whole and named in one warning, see sterling-layer.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderClaudeText, renderOpenCodeFullText, renderAgyText } from '../lib/agent-fences.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const SLUG = 'project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer';

test('the proposal bullet in the Sterling layer targets AGENTS.md, in every render', () => {
  const template = read('templates/target-claude-md.md');
  for (const [name, text] of [['claude', renderClaudeText(template, 't')], ['opencode', renderOpenCodeFullText(template, 't')], ['agy', renderAgyText(template, 't')]]) {
    const bullet = text.split('\n').find((l) => l.startsWith('- **Instruction-file proposals replace memory.**'));
    assert.ok(bullet, `${name} render has the bullet`);
    assert.ok(bullet.includes("draft the bullet in AGENTS.md's own style"), name);
    assert.ok(bullet.includes(SLUG), name);
    assert.ok(!bullet.includes('CLAUDE.md when it is Sterling- or Claude-specific'), name);
  }
});

test('the conductor tells every host that durable rules go in AGENTS.md alone', () => {
  const template = read('agent-templates/conductor.md');
  for (const [name, text] of [['claude', renderClaudeText(template, 'c')], ['opencode', renderOpenCodeFullText(template, 'c')], ['agy', renderAgyText(template, 'c')]]) {
    assert.ok(text.includes('**Durable rules go in `AGENTS.md` or this file'), name);
    assert.ok(text.includes(SLUG), name);
    assert.ok(!/Durable rules go in `AGENTS\.md`\/`(CLAUDE|GEMINI)\.md`/.test(text), name);
  }
});

test('the generated AGENTS.md section tells every host to put project rules in AGENTS.md outside its markers', () => {
  const section = read('templates/sterling-layer-agents.md');
  const bullet = section.split('\n').find((l) => l.startsWith('- **Instruction-file proposals replace memory.**'));
  assert.ok(bullet, 'the section has the bullet');
  assert.ok(bullet.includes('outside the generated block'));
});
