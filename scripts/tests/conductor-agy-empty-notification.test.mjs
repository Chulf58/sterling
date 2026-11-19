// GitHub #316: agy 1.5.11 rejects a turn with neither text nor a tool call, so the agy render of the
// conductor answers a report-less notification with one short status line. Claude Code and OpenCode
// keep the 2026-10-02 "Silent" rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderClaudeText, renderOpenCodeFullText, renderPortableText, renderAgyText } from '../lib/agent-fences.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(repoRoot, 'agent-templates', 'conductor.md'), 'utf8');
const SLUG = 'on-agy-the-conductor-ends-an-empty-notification-turn-with-one-short-line';
const SILENT = 'End the turn without text';
const SHORT_LINE = 'gets one short status line and nothing more';

test('the agy render carries the short-line rule, cites its decision, and drops the silent rule', () => {
  const agy = renderAgyText(SRC, 'conductor.md');
  assert.ok(agy.includes(SHORT_LINE));
  assert.ok(agy.includes(SLUG));
  assert.ok(!agy.includes(SILENT));
});

test('the Claude, OpenCode and portable renders keep the silent rule and not the short-line rule', () => {
  for (const [name, render] of [['claude', renderClaudeText], ['opencode', renderOpenCodeFullText], ['portable', renderPortableText]]) {
    const out = render(SRC, 'conductor.md');
    assert.ok(out.includes(SILENT), name);
    assert.ok(!out.includes(SHORT_LINE), name);
    assert.ok(!out.includes(SLUG), name);
  }
});
