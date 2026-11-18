// Three-way host fences (Antigravity CLI slice 2): the agy-only kind, renderAgyText and the
// generalized no-counterpart marker, plus a golden check that the three existing renders are
// byte-identical to the base module frozen in fixtures/agent-fences-base.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fences from '../lib/agent-fences.mjs';
import * as base from './fixtures/agent-fences-base.mjs';

const { validateFences, renderClaudeText, renderOpenCodeFullText, renderPortableText, renderAgyText, noCounterpartHosts } = fences;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const kinds = (text) => validateFences(text, 't').map((v) => v.kind);

test('golden: existing renders of every template equal the base module output', () => {
  const files = readdirSync(join(repoRoot, 'agent-templates')).filter((f) => f.endsWith('.md')).map((f) => `agent-templates/${f}`);
  files.push('templates/target-claude-md.md');
  assert.ok(files.length > 1);
  for (const rel of files) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    assert.equal(renderClaudeText(text, rel), base.renderClaudeText(text, rel), `${rel} claude`);
    assert.equal(renderOpenCodeFullText(text, rel), base.renderOpenCodeFullText(text, rel), `${rel} opencode-full`);
    assert.equal(renderPortableText(text, rel), base.renderPortableText(text, rel), `${rel} portable`);
  }
});

test('agy-only: reaches only the agy render', () => {
  const text = 'a\n<!-- agy-only -->\nagy\n<!-- /agy-only -->\n<!-- sterling-only -->\nst\n<!-- /sterling-only -->\nz\n';
  assert.deepEqual(validateFences(text, 't'), []);
  assert.equal(renderAgyText(text, 't'), 'a\nagy\nst\nz\n');
  assert.equal(renderClaudeText(text, 't'), 'a\nst\nz\n');
  assert.equal(renderOpenCodeFullText(text, 't'), 'a\nst\nz\n');
  assert.equal(renderPortableText(text, 't'), 'a\nz\n');
});

test('agy render drops claude-only, opencode-only and portable-only blocks', () => {
  const text = '<!-- claude-only -->\nc\n<!-- /claude-only -->\n<!-- opencode-only -->\no\n<!-- /opencode-only -->\n<!-- portable-only -->\np\n<!-- /portable-only -->\nz';
  assert.equal(renderAgyText(text, 't'), 'z');
});

test('agy-only: structural errors are refused', () => {
  assert.deepEqual(kinds('<!-- agy-only -->\nx'), ['fence_unclosed']);
  assert.deepEqual(kinds('x\n<!-- /agy-only -->'), ['fence_unopened']);
  assert.deepEqual(kinds('<!-- agy-only -->\nx\n<!-- /opencode-only -->'), ['fence_mismatched', 'fence_unclosed']);
  assert.deepEqual(kinds('<!-- agy-only -->\n<!-- sterling-only -->\n'), ['fence_nested', 'fence_unclosed']);
  assert.deepEqual(kinds('<!-- agy-only -->\n\n<!-- /agy-only -->'), ['fence_empty_block']);
  assert.deepEqual(kinds('<!-- AGY-only -->\nx\n<!-- /agy-only -->'), ['fence_malformed', 'fence_unopened']);
  assert.throws(() => renderAgyText('<!-- agy-only -->\nx', 't'), /fence_unclosed/);
});

test('no-counterpart marker: legacy form keeps its meaning and is dropped from every render', () => {
  assert.deepEqual(noCounterpartHosts('<!-- no-opencode-counterpart -->'), ['opencode']);
  const text = 'a\n<!-- claude-only -->\n<!-- no-opencode-counterpart -->\nc\n<!-- /claude-only -->\nz';
  assert.deepEqual(validateFences(text, 't'), []);
  assert.equal(renderClaudeText(text, 't'), 'a\nc\nz');
  assert.equal(renderOpenCodeFullText(text, 't'), 'a\nz');
  assert.equal(renderAgyText(text, 't'), 'a\nz');
});

test('no-counterpart marker: general form names hosts, including agy', () => {
  assert.deepEqual(noCounterpartHosts('<!-- no-counterpart: opencode, agy -->'), ['opencode', 'agy']);
  const text = 'a\n<!-- claude-only -->\n<!-- no-counterpart: opencode, agy -->\nc\n<!-- /claude-only -->\nz';
  assert.deepEqual(validateFences(text, 't'), []);
  assert.equal(renderClaudeText(text, 't'), 'a\nc\nz');
  assert.equal(renderAgyText(text, 't'), 'a\nz');
  // an agy-only block needs no pairing, and may declare the others have no counterpart
  const agy = '<!-- agy-only -->\n<!-- no-counterpart: claude -->\nx\n<!-- /agy-only -->';
  assert.deepEqual(validateFences(agy, 't'), []);
  assert.equal(renderAgyText(agy, 't'), 'x');
});

test('no-counterpart marker: general form that names opencode satisfies the claude-only pairing rule; one that omits it does not', () => {
  assert.deepEqual(kinds('<!-- claude-only -->\n<!-- no-counterpart: agy -->\nc\n<!-- /claude-only -->'), ['fence_claude_only_unpaired']);
});

test('no-counterpart marker: validation errors', () => {
  assert.deepEqual(kinds('<!-- claude-only -->\n<!-- no-counterpart: vim, opencode -->\nc\n<!-- /claude-only -->'), ['fence_counterpart_host']);
  assert.deepEqual(kinds('<!-- claude-only -->\n<!-- no-counterpart: agy, agy, opencode -->\nc\n<!-- /claude-only -->'), ['fence_counterpart_host']);
  assert.deepEqual(kinds('<!-- claude-only -->\n<!-- no-counterpart:agy -->\nc\n<!-- /claude-only -->'), ['fence_counterpart_malformed', 'fence_claude_only_unpaired']);
  assert.deepEqual(kinds('<!-- no-opencode-counterpart --> trailing'), ['fence_counterpart_malformed']);
  assert.deepEqual(kinds('<!-- agy-only -->\nx\n<!-- no-counterpart: claude -->\n<!-- /agy-only -->'), ['fence_counterpart_misplaced']);
  assert.deepEqual(kinds('<!-- agy-only -->\n<!-- no-counterpart: agy -->\nx\n<!-- /agy-only -->'), ['fence_counterpart_self']);
  assert.throws(() => renderAgyText('<!-- agy-only -->\n<!-- no-counterpart: agy -->\nx\n<!-- /agy-only -->', 't'), /fence_counterpart_self/);
});
