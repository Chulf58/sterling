// 2026-09-19 step-2 migration pins: direct delivery and immutable notices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '@sterling/schemas';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hook = join(root, 'scripts/hooks/h19-delivery-drain.mjs');
const helper = join(root, 'scripts/hooks/lib/delivery.mjs');
const project = () => { const dir = mkdtempSync(join(tmpdir(), 'sterling-step2-')); mkdirSync(join(dir, '.sterling'), { recursive: true }); return dir; };
const drain = (cwd) => spawnSync(process.execPath, [hook], { cwd, input: JSON.stringify({ cwd }), encoding: 'utf8' });

test('step 2: legacy prompt parses and maps to read', () => {
  assert.equal(parseConfig({ delivery: { injection_rung: 'prompt' } }).delivery.injection_rung, 'read');
});

test('step 2: concurrent immutable H10 notice producers cannot overwrite each other', () => {
  const cwd = project();
  const publish = (text) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { publishNotice } from ${JSON.stringify(helper)}; publishNotice(${JSON.stringify(cwd)}, ${JSON.stringify(text)});`], { encoding: 'utf8' });
  assert.equal(publish('first pressure').status, 0);
  assert.equal(publish('second unknown-window').status, 0);
  const files = readdirSync(join(cwd, '.sterling/transient/notices'));
  assert.equal(files.length, 2);
  assert.match(files.map((f) => readFileSync(join(cwd, '.sterling/transient/notices', f), 'utf8')).join('\n'), /first pressure/);
  assert.match(files.map((f) => readFileSync(join(cwd, '.sterling/transient/notices', f), 'utf8')).join('\n'), /second unknown-window/);
});

test('step 2: notices and obsolete pending queue are removed only after prompt emission', () => {
  const cwd = project();
  const notices = join(cwd, '.sterling/transient/notices'); mkdirSync(notices, { recursive: true });
  writeFileSync(join(notices, 'h10-test.json'), JSON.stringify({ text: 'pressure notice' }));
  const pending = join(cwd, '.sterling/transient/delivery/pending.json'); mkdirSync(dirname(pending), { recursive: true }); writeFileSync(pending, JSON.stringify([{ payload: 'obsolete' }]));
  const r = drain(cwd); assert.equal(r.status, 0); assert.match(r.stdout, /pressure notice/); assert.match(r.stdout, /1 pending entry/);
  assert.equal(existsSync(join(notices, 'h10-test.json')), false); assert.equal(existsSync(pending), false);
  const second = drain(cwd); assert.equal(second.status, 0); assert.doesNotMatch(second.stdout, /obsolete delayed delivery queue/);
});

test('step 2: malformed obsolete pending queue is disclosed once and removed after emission', () => {
  const cwd = project();
  const pending = join(cwd, '.sterling/transient/delivery/pending.json');
  mkdirSync(dirname(pending), { recursive: true }); writeFileSync(pending, '{truncated');
  const first = drain(cwd);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /obsolete delayed delivery queue.*unreadable/i);
  assert.equal(existsSync(pending), false);
  const repeat = drain(cwd);
  assert.doesNotMatch(repeat.stdout, /obsolete delayed delivery queue/i);
});

test('step 2: a directory in place of the obsolete pending queue is disclosed once and removed recursively', () => {
  const cwd = project();
  const pending = join(cwd, '.sterling/transient/delivery/pending.json');
  mkdirSync(pending, { recursive: true });
  const first = drain(cwd);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /obsolete delayed delivery queue.*unreadable/i);
  assert.equal(existsSync(pending), false, 'recursive removal clears the directory');
  const repeat = drain(cwd);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.doesNotMatch(repeat.stdout, /obsolete delayed delivery queue/i);
});

test('step 2: syntactically valid malformed notice is disclosed and removed', () => {
  const cwd = project();
  const notices = join(cwd, '.sterling/transient/notices');
  const malformed = join(notices, 'h10-malformed.json');
  mkdirSync(notices, { recursive: true });
  writeFileSync(malformed, '{}');
  const first = drain(cwd);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /malformed immutable notice.*unreadable/i);
  assert.equal(existsSync(malformed), false);
  const repeat = drain(cwd);
  assert.equal(repeat.stdout, '');
});

test('step 2: unreadable notices directory is visible and is not treated as empty', () => {
  const cwd = project();
  const notices = join(cwd, '.sterling/transient/notices');
  mkdirSync(dirname(notices), { recursive: true });
  writeFileSync(notices, 'not a directory');
  const r = drain(cwd);
  assert.equal(r.status, 1, 'visible hook failures use the non-blocking failure exit');
  assert.match(r.stderr, /notice drain failed.*ENOTDIR|ENOTDIR.*notice drain failed/i);
});

test('step 2: an unreadable legacy ledger does not swallow notice delivery', () => {
  const cwd = project();
  const ledger = join(cwd, '.sterling/transient/conductor-reads.json');
  mkdirSync(ledger, { recursive: true });
  const notices = join(cwd, '.sterling/transient/notices'); mkdirSync(notices, { recursive: true });
  writeFileSync(join(notices, 'h10-test.json'), JSON.stringify({ text: 'surviving pressure notice' }));
  const r = drain(cwd);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /ledger prune failed/i);
  assert.match(r.stdout, /surviving pressure notice/);
  assert.equal(existsSync(join(notices, 'h10-test.json')), false);
});

test('step 2: no runtime producer writes pending.json', () => {
  const source = readFileSync(join(root, 'scripts/hooks/lib/delivery.mjs'), 'utf8') + readFileSync(join(root, 'scripts/hooks/h19-knowledge-delivery.mjs'), 'utf8') + readFileSync(join(root, 'scripts/hooks/h19-bash-delivery.mjs'), 'utf8') + readFileSync(join(root, 'scripts/hooks/h23-output-axis.mjs'), 'utf8');
  assert.doesNotMatch(source, /export function (enqueuePending|pendingPath)|writeFileSync\([^\n]*pending\.json/);
});
