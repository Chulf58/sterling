// GitHub #319 (decision project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer):
// the instruction-file proposal rule targets AGENTS.md on every host, and sync warns about a
// CLAUDE.md bullet that is not Sterling's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderClaudeText, renderOpenCodeFullText, renderAgyText } from '../lib/agent-fences.mjs';
import { foreignClaudeMdBullets, foreignBulletWarning } from '../lib/claude-md-extras.mjs';

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

function project(claudeMd) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-md-extras-'));
  writeFileSync(join(dir, 'CLAUDE.md'), claudeMd);
  return dir;
}

test('sync warns, naming the line, for a CLAUDE.md bullet that is not Sterling\'s', () => {
  const stock = renderClaudeText(read('templates/target-claude-md.md'), 't');
  const dir = project(stock + '\n- **Always squash on merge.** Our own rule.\n');
  try {
    const found = foreignClaudeMdBullets(root, dir);
    assert.equal(found.length, 1);
    assert.equal(found[0].lead, '**Always squash on merge.**');
    const msg = foreignBulletWarning(found[0]);
    assert.match(msg, /CLAUDE\.md:\d+ holds a bullet that is not part of Sterling's layer: \*\*Always squash on merge\.\*\*/);
    assert.match(msg, /Move it to AGENTS\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sync stays quiet for a stock CLAUDE.md and for a project with none', () => {
  const dir = project(renderClaudeText(read('templates/target-claude-md.md'), 't'));
  try {
    assert.deepEqual(foreignClaudeMdBullets(root, dir), []);
    rmSync(join(dir, 'CLAUDE.md'));
    assert.deepEqual(foreignClaudeMdBullets(root, dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("this repo's CLAUDE.md carries no project bullet that moved to AGENTS.md, and AGENTS.md carries them", () => {
  const claude = read('CLAUDE.md');
  const agents = read('AGENTS.md');
  for (const lead of ['- **The MACHINE ROLE line at session start says what this clone is.**', '- **This repo runs in hobby mode on local SQLite:**', '- **Task-end review in this repo is 3 Sol reviewers in parallel, not 1.**']) {
    assert.ok(!claude.includes(lead), lead);
    assert.ok(agents.includes(lead), lead);
  }
  assert.ok(agents.includes('## Project rules'));
});
