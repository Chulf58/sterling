// Restored from custom-agents-roster.test.ts (removed with the settings redesign; main lines 85-161): custom-agent
// discovery itself is unchanged, only the roster rows around it moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCustomAgents, installedGovernedAgents } from '../custom-agents.js';

function project(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-custom-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('discoverCustomAgents reads the three agent folders, skips Sterling roles at their managed location and stamped files, and marks a malformed file', () => {
  const { dir, cleanup } = project({
    '.claude/agents/helper.md': '---\nname: helper\nmodel: claude-haiku-5\n---\nbody\n',
    '.claude/agents/implementor.md': '---\nname: implementor\nmodel: x\n---\n',
    '.claude/agents/stamped.md': '---\nname: stamped\n---\n<!-- sterling-generated v=1 -->\n',
    '.opencode/agents/team/plain.md': 'no frontmatter\n',
    '.opencode/agents/sterling/reviewer.md': '---\nmodel: y\n---\n',
    '.agents/agents/agyone/agent.md': '---\nname: agyone\nmodel: "gemini-4-argon-low"\n---\n',
    '.agents/agents/badone/agent.md': '---\nname: badone\nmodel: z\n',
  });
  try {
    assert.deepEqual(discoverCustomAgents(dir), [
      { name: 'agyone', source: 'agy', model: 'gemini-4-argon-low' },
      { name: 'badone', source: 'agy', error: 'frontmatter is not closed' },
      { name: 'helper', source: 'claude', model: 'claude-haiku-5' },
      { name: 'team/plain', source: 'opencode' },
    ]);
    assert.deepEqual(discoverCustomAgents(join(dir, 'nowhere')), []);
  } finally {
    cleanup();
  }
});

// Review fix (issue #307): a governed basename outside Sterling's managed location is the user's own agent.
test('a Sterling role name outside its managed location is a custom agent under its own path, and does not count as installed', () => {
  const { dir, cleanup } = project({
    '.opencode/agents/team/scout.md': '---\nmodel: openai/own\n---\n',
    '.opencode/agents/sterling/reviewer.md': '---\nmodel: y\n---\n',
    '.agents/agents/team/scout/agent.md': '---\nmodel: gemini-4-argon-low\n---\n',
  });
  try {
    assert.deepEqual(discoverCustomAgents(dir), [
      { name: 'team/scout', source: 'agy', model: 'gemini-4-argon-low' },
      { name: 'team/scout', source: 'opencode', model: 'openai/own' },
    ]);
    assert.deepEqual(installedGovernedAgents(dir), { claude: [], opencode: ['reviewer'], agy: [] }, 'scout is not installed anywhere; only the managed reviewer is');
  } finally {
    cleanup();
  }
});

test('a governed role at its managed location counts as installed per host and is not a custom row', () => {
  const { dir, cleanup } = project({
    '.claude/agents/scout.md': '---\nmodel: m\n---\n',
    '.opencode/agents/sterling/scout.md': '---\nmodel: m\n---\n',
    '.agents/agents/scout/agent.md': '---\nmodel: m\n---\n',
  });
  try {
    assert.deepEqual(installedGovernedAgents(dir), { claude: ['scout'], opencode: ['scout'], agy: ['scout'] });
    assert.deepEqual(discoverCustomAgents(dir), []);
  } finally {
    cleanup();
  }
});

// Review fix: the frontmatter is parsed as YAML, not matched with a regex.
test('a quoted model with a trailing comment shows the model; a model that does not parse is an error row', () => {
  const { dir, cleanup } = project({
    '.claude/agents/quoted.md': '---\nmodel: "openai/a" # pinned\n---\n',
    '.claude/agents/broken.md': '---\nmodel: [\n---\n',
    '.claude/agents/listed.md': '---\nmodel:\n  - a\n  - b\n---\n',
  });
  try {
    const found = discoverCustomAgents(dir);
    assert.deepEqual(found.find((a) => a.name === 'quoted'), { name: 'quoted', source: 'claude', model: 'openai/a' });
    assert.match(found.find((a) => a.name === 'broken')?.error ?? '', /not valid YAML/);
    assert.equal(found.find((a) => a.name === 'listed')?.error, 'frontmatter model is not a scalar');
  } finally {
    cleanup();
  }
});
