// GitHub #319 (decision project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer):
// the instruction-file proposal rule targets AGENTS.md on every host, and sync warns about a
// CLAUDE.md bullet that is not Sterling's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderClaudeText, renderOpenCodeFullText, renderAgyText } from '../lib/agent-fences.mjs';
import { foreignClaudeMdBullets, foreignBulletWarning, claudeMdWarnings } from '../lib/claude-md-extras.mjs';
import { renderGeminiMd } from '../lib/agy-setup.mjs';

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
    assert.equal(found[0].file, 'CLAUDE.md');
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

test('plain top-level bullets are inspected too, fenced code is not, and stock plain bullets stay quiet', () => {
  const stock = renderClaudeText(read('templates/target-claude-md.md'), 't');
  const dir = project(stock + '\n- Always squash on merge.\n  - nested note, not top level\n\n```\n- a bullet inside a code block\n```\n');
  try {
    const found = foreignClaudeMdBullets(root, dir);
    assert.deepEqual(found.map((f) => f.lead), ['Always squash on merge.']);
    assert.match(foreignBulletWarning(found[0]), /holds a bullet that is not part of Sterling's layer: Always squash on merge\./);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const plainTemplate = mkdtempSync(join(tmpdir(), 'plain-tpl-'));
  try {
    mkdirSync(join(plainTemplate, 'templates'));
    writeFileSync(join(plainTemplate, 'templates', 'target-claude-md.md'), '- Keep the plain rule here.\n- **Bold rule.** text\n');
    const d2 = project('- Keep the plain rule here, reworded.\n- **Bold rule.** other text\n- Brand new plain rule.\n');
    try {
      assert.deepEqual(foreignClaudeMdBullets(plainTemplate, d2).map((f) => f.lead), ['Brand new plain rule.']);
    } finally { rmSync(d2, { recursive: true, force: true }); }
  } finally { rmSync(plainTemplate, { recursive: true, force: true }); }
});

test("this repo's CLAUDE.md reports no project bullet, bold or plain", () => {
  assert.deepEqual(foreignClaudeMdBullets(root, root), []);
});

test('a scanner failure becomes one diagnostic line, never a throw (a directory at CLAUDE.md)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-md-dir-'));
  mkdirSync(join(dir, 'CLAUDE.md'));
  try {
    const lines = claudeMdWarnings(root, dir);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^⚠ CLAUDE\.md check skipped: /);
    assert.match(lines[0], /EISDIR/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a scanner failure becomes one diagnostic line (an unreadable CLAUDE.md)', { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'root reads any file' : false }, () => {
  const dir = project('- **x.** y\n');
  try {
    chmodSync(join(dir, 'CLAUDE.md'), 0o000);
    const lines = claudeMdWarnings(root, dir);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^⚠ CLAUDE\.md check skipped: /);
  } finally { chmodSync(join(dir, 'CLAUDE.md'), 0o644); rmSync(dir, { recursive: true, force: true }); }
});

test('claudeMdWarnings returns the foreign-bullet lines for a normal file', () => {
  const dir = project('- Plain extra rule.\n');
  try {
    const lines = claudeMdWarnings(root, dir);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /not part of Sterling's layer: Plain extra rule\./);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const geminiRef = () => renderGeminiMd({ pluginRoot: root, root, projectName: 'p' });
function geminiProject(text) {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-extras-'));
  if (text !== undefined) writeFileSync(join(dir, 'GEMINI.md'), text);
  return dir;
}

test('GEMINI.md: an extra bullet warns naming GEMINI.md:<line>', () => {
  const dir = geminiProject(geminiRef() + '\n- **Always squash on merge.** Our own rule.\n- A plain extra rule.\n');
  try {
    const lines = claudeMdWarnings(root, dir, geminiRef);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^⚠ GEMINI\.md:\d+ holds a bullet that is not part of Sterling's layer: \*\*Always squash on merge\.\*\*/);
    assert.match(lines[1], /GEMINI\.md:\d+ .*A plain extra rule\./);
    assert.match(lines[0], /Move it to AGENTS\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GEMINI.md: a stock rendered file is quiet, and no GEMINI.md prints nothing', () => {
  const stock = geminiProject(geminiRef());
  const none = geminiProject(undefined);
  try {
    assert.deepEqual(claudeMdWarnings(root, stock, geminiRef), []);
    assert.deepEqual(claudeMdWarnings(root, none, geminiRef), []);
  } finally { rmSync(stock, { recursive: true, force: true }); rmSync(none, { recursive: true, force: true }); }
});

test('GEMINI.md: a directory at the path or a failing render is one diagnostic line, never a throw', () => {
  const dir = geminiProject(undefined);
  mkdirSync(join(dir, 'GEMINI.md'));
  try {
    const lines = claudeMdWarnings(root, dir, geminiRef);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^⚠ GEMINI\.md check skipped: .*EISDIR/);
    const file = geminiProject('- x\n');
    try {
      assert.deepEqual(claudeMdWarnings(root, file, () => { throw new Error('render failed'); }), ['⚠ GEMINI.md check skipped: render failed']);
    } finally { rmSync(file, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
