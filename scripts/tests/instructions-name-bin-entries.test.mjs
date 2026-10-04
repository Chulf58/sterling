// Shipped instruction text must name the bundled bin/ entry, never scripts/<name>.mjs, wherever
// bin/<name>.mjs exists (GitHub issue #16). scripts/<name>.mjs imports @sterling/* packages and
// fails on an installed plugin copy; the bin bundle runs on both an authoring clone and an
// installed copy. A script with no bin bundle is not flagged: there is nothing better to name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function markdownUnder(dir) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs)) {
    const rel = join(dir, entry);
    if (statSync(join(root, rel)).isDirectory()) out.push(...markdownUnder(rel));
    else if (entry.endsWith('.md')) out.push(rel);
  }
  return out;
}

const SHIPPED = [
  ...['agent-templates', 'skills', 'commands', 'templates'].flatMap(markdownUnder),
  'CLAUDE.md',
  'AGENTS.md',
].filter((f) => existsSync(join(root, f)));

// scripts/<name>.mjs directly under scripts/, not a skill's own scripts/ folder
// (skills/<skill>/scripts/x.mjs ships with the skill) and not a file:line source citation.
const SCRIPT_REF = /(?<!skills\/[\w-]+\/)\bscripts\/([\w-]+)\.mjs(?!:\d)/g;

function offenders() {
  const found = [];
  for (const file of SHIPPED) {
    readFileSync(join(root, file), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(SCRIPT_REF)) {
        if (existsSync(join(root, 'bin', `${m[1]}.mjs`))) found.push(`${file}:${i + 1} names scripts/${m[1]}.mjs; name bin/${m[1]}.mjs`);
      }
    });
  }
  return found;
}

test('the scan covers the shipped instruction files', () => {
  assert.ok(SHIPPED.includes('agent-templates/conductor.md'));
  assert.ok(SHIPPED.includes('templates/target-claude-md.md'));
  assert.ok(SHIPPED.some((f) => f.startsWith('commands/')));
  assert.ok(SHIPPED.some((f) => f.startsWith('skills/')));
});

test('the reference pattern ignores skill-local scripts, hooks and file:line citations', () => {
  const hit = (s) => [...s.matchAll(SCRIPT_REF)].map((m) => m[1]);
  assert.deepEqual(hit('node <clone>/scripts/rotation-note.mjs --x'), ['rotation-note']);
  assert.deepEqual(hit('node scripts/direct-merge.mjs'), ['direct-merge']);
  assert.deepEqual(hit('skills/de-ai-writing/scripts/check-ai-signs.mjs'), []);
  assert.deepEqual(hit('scripts/hooks/h10-direct-capture.mjs:1353'), []);
  assert.deepEqual(hit('called from `scripts/direct-merge.mjs:287`'), []);
});

test('no shipped instruction names scripts/<name>.mjs when bin/<name>.mjs exists', () => {
  assert.deepEqual(offenders(), []);
});
