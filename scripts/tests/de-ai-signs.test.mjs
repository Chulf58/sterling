// de-ai-writing scanner (skills/de-ai-writing/scripts/check-ai-signs.mjs): the pattern-matchable
// signs from references/signs.md, the --summary and stdin modes, and the skipped-text rules.
// Decision de-ai-writing-skill-replaces-plain-prose-with-a-node-scanner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from '../../skills/de-ai-writing/scripts/check-ai-signs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillDir = join(root, 'skills', 'de-ai-writing');
const scanner = join(skillDir, 'scripts', 'check-ai-signs.mjs');
const skillText = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');

function run(args, input) {
  const r = spawnSync(process.execPath, [scanner, ...args], { encoding: 'utf8', input });
  assert.equal(r.status, 0, `scanner always exits 0 (stderr: ${r.stderr})`);
  return r;
}

/** Sign numbers that have a header line in the plain-text report. */
function signsIn(stdout) {
  return new Set([...stdout.matchAll(/^(\d\.\d) [A-Z]/gm)].map((m) => m[1]));
}

/** The item lines printed under one sign's header. */
function itemsUnder(stdout, sign) {
  const lines = stdout.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${sign} `));
  if (at < 0) return [];
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('  - ')) break;
    out.push(l.slice(4));
  }
  return out;
}

/** The skill's worked example: the blockquote after the given bold label, prefixes removed. */
function exampleBlock(label) {
  const lines = skillText.split('\n');
  const start = lines.indexOf(`**${label}**`);
  assert.ok(start >= 0, `SKILL.md has a **${label}** example`);
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('>')) out.push(line.replace(/^>\s?/, ''));
    else if (out.length) break;
  }
  return out.join('\n');
}

function withTempFile(name, content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'de-ai-signs-'));
  try {
    const file = join(dir, name);
    writeFileSync(file, content);
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the skill's example Input paragraph hits the signs it is built to show", () => {
  const input = exampleBlock('Input');
  const r = withTempFile('input.txt', input, (f) => run([f]));
  const hit = signsIn(r.stdout);
  for (const sign of ['1.1', '1.4', '2.1', '2.4', '3.4', '4.2', '5.1']) {
    assert.ok(hit.has(sign), `Input should hit ${sign}; got ${[...hit].join(', ')}\n${r.stdout}`);
  }
});

test("the skill's example Output paragraph hits nothing", () => {
  const output = exampleBlock('Output');
  const r = withTempFile('output.txt', output, (f) => run([f]));
  assert.deepEqual([...signsIn(r.stdout)], [], r.stdout);
  assert.match(r.stdout, /No pattern-matchable signs found\./);
});

test('blockquotes, code fences, inline code, quoted spans and front matter are skipped', () => {
  const doc = [
    '---',
    'description: Additionally, this is a testament to the vibrant landscape.',
    '---',
    '',
    '> Additionally, the café stands as a testament to its vibrant, rich heritage.',
    '',
    '```',
    'It is important to note that we delve into the tapestry.',
    '```',
    '',
    'Run `delve` here. She said "It is crucial to leverage the pivotal tapestry" and left.',
    '',
    'The cat sat on the mat.',
  ].join('\n');
  const r = withTempFile('skipped.md', doc, (f) => run([f]));
  assert.deepEqual([...signsIn(r.stdout)], [], r.stdout);
});

test('the same sentences outside a quote or fence are flagged', () => {
  const r = withTempFile('plain.md', 'It is important to note that we delve into the tapestry.\n', (f) => run([f]));
  const hit = signsIn(r.stdout);
  assert.ok(hit.has('5.1') && hit.has('2.1'), r.stdout);
});

test('--summary prints counts per sign and no sentences', () => {
  const doc = 'Additionally, it is crucial. Additionally, it is pivotal. In conclusion, it may vary.\n';
  const r = withTempFile('s.txt', doc, (f) => run([f, '--summary']));
  assert.match(r.stdout, /^2\.1 +2 +AI vocabulary$/m);
  assert.match(r.stdout, /^5\.1 +1 /m);
  assert.match(r.stdout, /^5\.2 +1 /m);
  assert.doesNotMatch(r.stdout, /^ {2}- /m, 'summary lists no sentences');
});

test('- reads stdin', () => {
  const r = run(['-'], 'Nestled in the heart of town, the café is a testament to craft.\n');
  assert.match(r.stdout, /== \(stdin\)/);
  assert.ok(signsIn(r.stdout).has('1.4'), r.stdout);
});

test('html tags are stripped, headings and entities survive the conversion', () => {
  const html = '<h2>Impact Of Technology And Digitalization</h2><p>Additionally, we<script>delve()</script> ship&mdash;fast.</p>';
  const r = withTempFile('page.html', html, (f) => run([f]));
  const hit = signsIn(r.stdout);
  assert.ok(hit.has('3.1') && hit.has('2.1') && hit.has('3.4'), r.stdout);
  assert.doesNotMatch(r.stdout, /<\/?p>|delve\(\)/);
});

test('formatting signs 3.1 to 3.8 fire on a formatted document', () => {
  const doc = [
    '# Impact Of Technology And Digitalization',
    '',
    '- **Scalability:** The system grows.',
    '- **Security:** The system is safe.',
    '',
    '---',
    '',
    '## Second Section Of Text',
    '',
    'We **ship** **fast** and **well** and **often** and **cheaply** today 🚀.',
    '',
    '---',
  ].join('\n');
  const r = withTempFile('fmt.md', doc, (f) => run([f]));
  const hit = signsIn(r.stdout);
  for (const sign of ['3.1', '3.2', '3.3', '3.5', '3.8']) assert.ok(hit.has(sign), `${sign} in ${[...hit].join(', ')}`);
});

test('em dashes are flagged only above the allowance for the text length', () => {
  const filler = 'The station has eight tracks and six platforms. '.repeat(60);
  const two = `${filler}It opened in 1901 — late for the region. ${filler}Trains run hourly — more at peak.\n`;
  const r = withTempFile('long.txt', two, (f) => run([f]));
  assert.ok(!signsIn(r.stdout).has('3.4'), 'two em dashes in a long piece are fine');
  const many = `${two}${'A — B. '.repeat(6)}\n`;
  const r2 = withTempFile('dashes.txt', many, (f) => run([f]));
  assert.ok(signsIn(r2.stdout).has('3.4'), 'many em dashes are flagged');
});

test('the report always says the judgement signs are not scanned, and an unreadable file still exits 0', () => {
  const r = run(['/nonexistent/de-ai-signs-missing.txt']);
  assert.match(r.stderr, /cannot read/);
  assert.match(r.stdout, /Not scanned \(judgement signs, read by hand\): 1\.6-1\.8, 2\.5, 2\.6, 3\.6, 3\.7/);
});

test("the skill's own prose hits only the signs it names or models on purpose", () => {
  const r = withTempFile('SKILL.md', skillText, (f) => run([f]));
  assert.deepEqual([...signsIn(r.stdout)], ['2.2', '3.3'], r.stdout);
  assert.match(r.stdout, /serves as\/boasts/);
  // The user's rewrite rules are **Label**: bullets, which 3.3 exists to flag. The skill text stays
  // verbatim (decision de-ai-writing-skill-replaces-plain-prose-with-a-node-scanner), so the guard
  // pins exactly those lines ("Contrasts" has a parenthetical before its colon and "Don't over-correct."
  // has none, so neither is a label bullet): a new label bullet in the skill fails here.
  const labels = itemsUnder(r.stdout, '3.3').map((l) => l.split(':')[0]);
  assert.deepEqual(labels, [
    "Keep the author's voice and conventions",
    'Em dashes',
    'Unknowns',
    'Plain words',
  ]);
});

test('3.3 flags a label bullet whether the colon is inside the bold, outside it, or a dash', () => {
  const doc = [
    '- **Inside:** text one.',
    '- **Outside**: text two.',
    '- **Dash** \u2014 text three.',
    '- **Hyphen** - text four.',
    '- __Under__: text five.',
    '1. **Numbered**: text six.',
  ].join('\n');
  const r = withTempFile('labels.md', doc, (f) => run([f]));
  assert.equal(itemsUnder(r.stdout, '3.3').length, 6, r.stdout);
  const thirty = Array.from({ length: 30 }, (_, i) => `- **Item ${i}**: The system does thing ${i}.`).join('\n');
  const r2 = withTempFile('thirty.md', thirty, (f) => run([f, '--summary']));
  assert.match(r2.stdout, /^3\.3 +30 /m, r2.stdout);
});

test('3.3 flags an unbolded "Label: text" bullet but not a sentence that happens to contain a colon', () => {
  const r = withTempFile('plain-label.md', '- Scalability: the system grows.\n- Security: the system is safe.\n', (f) => run([f]));
  assert.equal(itemsUnder(r.stdout, '3.3').length, 2, r.stdout);
  const r2 = withTempFile('sentence.md', '- Read the record first. Then rewrite these fields: one, two.\n- Ship it.\n', (f) => run([f]));
  assert.ok(!signsIn(r2.stdout).has('3.3'), r2.stdout);
});

test('a document with nothing scannable says so instead of printing the pass line', () => {
  const r = withTempFile('quoted.md', '> Additionally, this is crucial.\n\n```\ndelve\n```\n', (f) => run([f]));
  assert.match(r.stdout, /nothing scanned: every line was skipped \(front matter\/fence\/blockquote\/table\)/);
  assert.doesNotMatch(r.stdout, /No pattern-matchable signs found/);
});

test('a leading thematic break is not front matter unless a key: line sits inside a block closed within 40 lines', () => {
  const r = withTempFile('hr.md', '---\nAdditionally, it is crucial.\n---\nBody text here.\n', (f) => run([f]));
  assert.ok(signsIn(r.stdout).has('2.1'), 'text between two --- rules is prose, not front matter');
  const far = `---\nname: x\n${'filler line\n'.repeat(45)}---\nAdditionally, it is crucial.\n`;
  const r2 = withTempFile('far.md', far, (f) => run([f]));
  assert.ok(signsIn(r2.stdout).has('2.1'), 'a closing --- beyond 40 lines is not front matter');
  const fm = '---\nname: x\ndescription: Additionally, crucial.\n---\nBody text here.\n';
  const r3 = withTempFile('fm.md', fm, (f) => run([f]));
  assert.deepEqual([...signsIn(r3.stdout)], [], 'real front matter is still skipped');
});

test('an unclosed code fence warns on stderr and still scans the text before it', () => {
  const r = withTempFile('open.md', 'Additionally, it is crucial.\n\n```\ncode that never closes\n', (f) => run([f]));
  assert.match(r.stderr, /unclosed code fence/);
  assert.ok(signsIn(r.stdout).has('2.1'), r.stdout);
});

test('a stray inch mark does not mask the prose after it', () => {
  const r = withTempFile('inch.md', 'The pipe is 5" wide. Additionally, it is crucial. She said "hello there" and left.\n', (f) => run([f]));
  assert.ok(signsIn(r.stdout).has('2.1'), r.stdout);
});

test('the scanner runs when invoked through a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'de-ai-link-'));
  try {
    const link = join(dir, 'scan.mjs');
    symlinkSync(scanner, link);
    const r = spawnSync(process.execPath, [link, '-'], { encoding: 'utf8', input: 'Additionally, it is crucial.\n' });
    assert.match(r.stdout, /== \(stdin\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('4.3 flags a bracket placeholder but not the text of a markdown link', () => {
  const r = withTempFile('ph.md', 'Dear [Your Name], see [Add a task](https://example.com/task) and [Insert link here](x).\n', (f) => run([f]));
  const items = itemsUnder(r.stdout, '4.3');
  assert.equal(items.length, 1, r.stdout);
  assert.match(items[0], /\[Your Name\]/);
  assert.doesNotMatch(items[0], /\| |Add a task\]/);
});

test('a long line of "not only" does not blow up the 2.4 pattern', () => {
  const t0 = Date.now();
  scanText('not only '.repeat(22000));
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0}ms`);
});
