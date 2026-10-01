// historicalVariants (scripts/lib/contract-history.mjs): the template-descended bullet
// set stamp-contract replaces from. With no git repository (an installed plugin copy)
// the set is the current template text plus bin/contract-history.json; with that file
// missing or unparseable only the CURRENT template text counts, said once on stderr;
// any other git failure still throws (P5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historicalVariants } from '../lib/contract-history.mjs';

const LEAD = '- **Lead**';
const extractBlock = (text, lead) => (text.includes(lead) ? { block: text } : null);

test('no git repository: the current template block is the whole variant set, and one stderr line says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-nogit-'));
  const warned = [];
  try {
    const v = historicalVariants({
      repoRoot: dir,
      templateRels: ['templates/a.md', 'templates/b.md'],
      leads: [LEAD, '- **Old lead**'],
      extractBlock,
      currentBlocks: new Map([[LEAD, `${LEAD} now`]]),
      warn: (m) => warned.push(m),
    });
    assert.deepEqual([...v.get(LEAD)], [`${LEAD} now`]);
    assert.deepEqual([...v.get('- **Old lead**')], [], 'a renamed lead has no current text, so nothing matches it');
    assert.deepEqual(warned, [`stamp-contract: DEGRADED — no git history at ${dir} (installed plugin copy) and ${join(dir, 'bin', 'contract-history.json')} is missing — only the current template text counts as template-descended; older bullets read as drift`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('any OTHER git failure in a real repository still throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-gitfail-'));
  try {
    mkdirSync(join(dir, '.git'));
    assert.throws(
      () => historicalVariants({
        repoRoot: dir,
        templateRels: ['templates/a.md'],
        leads: [LEAD],
        extractBlock,
        currentBlocks: new Map([[LEAD, LEAD]]),
        warn: () => {},
        git: () => ({ status: 128, stdout: '', stderr: 'fatal: bad default revision' }),
      }),
      /git log failed/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no git repository with bin/contract-history.json: the snapshot blocks are unioned with the current block, no warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-nogit-snap-'));
  const warned = [];
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'contract-history.json'), JSON.stringify({ [LEAD]: [`${LEAD} old`], '- **Old lead**': ['- **Old lead** gone'] }));
    const v = historicalVariants({
      repoRoot: dir,
      templateRels: ['templates/a.md'],
      leads: [LEAD, '- **Old lead**'],
      extractBlock,
      currentBlocks: new Map([[LEAD, `${LEAD} now`]]),
      warn: (m) => warned.push(m),
    });
    assert.deepEqual([...v.get(LEAD)].sort(), [`${LEAD} now`, `${LEAD} old`]);
    assert.deepEqual([...v.get('- **Old lead**')], ['- **Old lead** gone']);
    assert.deepEqual(warned, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no git repository with an unparseable bin/contract-history.json: degraded to the current block, announced once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-nogit-bad-'));
  const warned = [];
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'contract-history.json'), '{ not json');
    const v = historicalVariants({
      repoRoot: dir,
      templateRels: ['templates/a.md'],
      leads: [LEAD],
      extractBlock,
      currentBlocks: new Map([[LEAD, `${LEAD} now`]]),
      warn: (m) => warned.push(m),
    });
    assert.deepEqual([...v.get(LEAD)], [`${LEAD} now`]);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /^stamp-contract: DEGRADED — no git history at .* is unparseable \(/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
