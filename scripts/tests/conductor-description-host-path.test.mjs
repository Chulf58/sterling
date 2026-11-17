import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// GitHub #266: Codex CLI derives .codex/agents/ from .claude/agents/ by replacing
// "claude" with "codex" in the text, so a literal ".claude/settings.json" in the
// conductor description became a ".codex/settings.json" that does not exist.
// Sterling writes no Codex projection itself, so the description must carry no
// ".claude/" path for that rewrite to mangle.
const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent-templates', 'conductor.md'), 'utf8');
const description = template.match(/^description:(.*)$/m)[1];

test('conductor description carries no .claude/ path a Claude-to-Codex rewrite would turn into .codex/settings.json', () => {
  assert.doesNotMatch(description, /\.claude\//);
  const codexRendering = description.replace(/claude/gi, (m) => (m === 'Claude' ? 'Codex' : 'codex'));
  assert.doesNotMatch(codexRendering, /\.codex\/settings/);
});
