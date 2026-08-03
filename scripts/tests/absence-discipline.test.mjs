// Tests for the absence-claim discipline rule (board 00d8d8c6). The rule enforces
// that the two roles which most often report negatives CARRY the instruction —
// it cannot enforce that an agent obeys it, and these tests are deliberately
// scoped to what is actually checkable so nothing here overstates the mechanism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  lintAbsenceDiscipline,
  lintAgentPrompt,
  ABSENCE_REPORTING_TEMPLATES,
  PROMPT_CONTRACT_SECTIONS,
  collectAgentTemplates,
} from '../lib/checks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const templateDir = join(root, 'agent-templates');

test('a listed template WITHOUT an Absence claims section fails the rule', () => {
  const v = lintAbsenceDiscipline('# Role\n# Inputs\n', 'explorer.md');
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'missing_absence_discipline');
  assert.match(v[0].detail, /explorer\.md/);
  assert.match(v[0].detail, /00d8d8c6/, 'the violation must cite the board item that motivated it');
});

test('a listed template WITH the section passes', () => {
  const v = lintAbsenceDiscipline('# Role\n\n# Absence claims\n\nOpen the thing that would do the job.\n', 'debugger.md');
  assert.deepEqual(v, []);
});

test('the section matches case-insensitively and at any heading depth', () => {
  for (const heading of ['# Absence claims', '## ABSENCE CLAIMS', '### Absence Claims and evidence']) {
    assert.deepEqual(lintAbsenceDiscipline(`${heading}\n`, 'explorer.md'), [], `${heading} should satisfy the rule`);
  }
});

test('an UNLISTED template is not required to carry the section (scope is deliberate)', () => {
  for (const other of ['coder.md', 'test-writer.md', 'librarian.md', 'reviewer-correctness.md']) {
    assert.deepEqual(lintAbsenceDiscipline('# Role\n', other), [], `${other} is out of scope for this rule`);
  }
});

test('the SHIPPED explorer and debugger templates satisfy the rule', () => {
  for (const file of ABSENCE_REPORTING_TEMPLATES) {
    const content = readFileSync(join(templateDir, file), 'utf8');
    assert.deepEqual(lintAbsenceDiscipline(content, file), [], `${file} must carry the section`);
  }
});

test('adding the section did NOT break the seven-section §7.3 contract or its ordering', () => {
  // The new heading sits between 'output contract' and 'scope boundaries'. The
  // order check walks the seven known sections by index, so an extra heading in
  // between must not disturb it — this is the regression that would bite.
  const templates = collectAgentTemplates(templateDir).filter((t) => t.file !== 'registry.json');
  assert.ok(templates.length >= 11, `expected the full roster, saw ${templates.length}`);
  for (const t of templates) {
    assert.deepEqual(lintAgentPrompt(t.content, t.file), [], `${t.file} must still satisfy the seven sections in order`);
  }
});

test('the shipped absence sections tell the agent to READ, not to search', () => {
  // The rule checks for a heading; this test checks the heading is not hollow.
  for (const file of ABSENCE_REPORTING_TEMPLATES) {
    const content = readFileSync(join(templateDir, file), 'utf8');
    const section = content.slice(content.search(/^#+\s*absence claims\b/im));
    assert.match(section, /OPEN/, `${file}: must instruct opening the thing that would do the job`);
    assert.match(section, /guessed/i, `${file}: must name the guessed-name mechanism`);
    assert.match(section, /NOT verified by reading|not verified by reading/, `${file}: must give the honest label for a search-only negative`);
  }
});

test('PROMPT_CONTRACT_SECTIONS is unchanged by this rule (still exactly seven)', () => {
  assert.equal(PROMPT_CONTRACT_SECTIONS.length, 7, 'the §7.3 contract must stay at seven sections; this rule is targeted, not universal');
});
