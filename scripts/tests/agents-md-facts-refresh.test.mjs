// GitHub #158: the AGENTS.md "Stack tags" and "Domain stores" lines follow .sterling/config.json
// after the tags change. Re-running /sterling:init and `domains.mjs --apply` rewrite them while
// they still hold a value init rendered; a line edited by hand is kept and reported.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDomain } from '@sterling/store';
import { refreshAgentsMdFacts, STACK_TAGS_LABEL, DOMAINS_LABEL } from '../lib/agents-md-facts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = new Set();
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.add(d);
  return d;
}
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const SUFFIX = ' — each created by init with a description of what belongs in it (§2.3)';
const doc = (stack, domains, eol = '\n') => ['# AGENTS.md — x', '', '## Project facts (generated)', '', `${STACK_TAGS_LABEL}${stack}`, '- Toolchains: node', `${DOMAINS_LABEL}${domains}`, '- Backup path: (opted out — recorded)', ''].join(eol);
const FACTS = { stackTags: ['python', 'sterling'], domainPaths: {} };
const WANT_STACK = 'python, sterling';
const WANT_DOMAINS = `~/.sterling/domains/python/, ~/.sterling/domains/sterling/${SUFFIX}`;

test('generated lines for old tags are rewritten; every other byte stays', () => {
  const before = doc('node, sterling', `~/.sterling/domains/node/, ~/.sterling/domains/sterling/${SUFFIX}`);
  const r = refreshAgentsMdFacts(before, FACTS);
  assert.deepEqual(r.refreshed, ['Stack tags', 'Domain stores']);
  assert.deepEqual(r.kept, []);
  assert.equal(r.text, doc(WANT_STACK, WANT_DOMAINS));
});

test('CRLF line endings survive a refresh', () => {
  const r = refreshAgentsMdFacts(doc('node', `~/.sterling/domains/node/${SUFFIX}`, '\r\n'), FACTS);
  assert.equal(r.text, doc(WANT_STACK, WANT_DOMAINS, '\r\n'));
});

test('an older init render of the Domain stores line and a per-tag domain path override are still generated', () => {
  const r = refreshAgentsMdFacts(doc('node', '~/.sterling/domains/node/ — created lazily on first need (§2.3)'), { stackTags: ['python'], domainPaths: { python: '/srv/py/' } });
  assert.deepEqual(r.refreshed, ['Stack tags', 'Domain stores']);
  assert.ok(r.text.includes(`\n${DOMAINS_LABEL}/srv/py/${SUFFIX}\n`), r.text);
});

test('a configured domain path with spaces and punctuation is recognised as generated when a tag is added', () => {
  const spaced = '/mnt/c/Users/Jane Doe/sterling domains, (shared)/node/';
  const domainPaths = { node: spaced };
  const before = doc('node, sterling', `${spaced}, ~/.sterling/domains/sterling/${SUFFIX}`);
  const r = refreshAgentsMdFacts(before, { stackTags: ['node', 'python', 'sterling'], domainPaths });
  assert.deepEqual(r.kept, []);
  assert.deepEqual(r.refreshed, ['Stack tags', 'Domain stores']);
  assert.ok(r.text.includes(`\n${DOMAINS_LABEL}${spaced}, ~/.sterling/domains/python/, ~/.sterling/domains/sterling/${SUFFIX}\n`), r.text);
  const prose = refreshAgentsMdFacts(doc('node', `${spaced} and a note we wrote${SUFFIX}`), { stackTags: ['node', 'python'], domainPaths });
  assert.deepEqual(prose.kept, [{ name: 'Domain stores', reason: 'the line was edited by hand' }], 'prose after a configured path is still a hand edit');
});

test('a long list of configured paths with a hand-written note is kept as edited, and judged quickly', () => {
  const tags = Array.from({ length: 40 }, (_, i) => `t${i}`);
  // Each configured path also has the default shape, so both branches of the parser apply to it.
  const domainPaths = Object.fromEntries(tags.map((t) => [t, `/srv/d/${t}/`]));
  const value = `${tags.map((t) => domainPaths[t]).join(', ')}, and one note we wrote${SUFFIX}`;
  const started = performance.now();
  const r = refreshAgentsMdFacts(doc(tags.join(', '), value), { stackTags: [...tags, 'extra'], domainPaths });
  const ms = performance.now() - started;
  assert.deepEqual(r.kept, [{ name: 'Domain stores', reason: 'the line was edited by hand' }]);
  assert.ok(ms < 500, `took ${ms.toFixed(1)}ms`);
});

test('a line that already matches is left alone and nothing is reported', () => {
  const before = doc(WANT_STACK, WANT_DOMAINS);
  const r = refreshAgentsMdFacts(before, FACTS);
  assert.equal(r.text, before);
  assert.deepEqual(r.refreshed, []);
  assert.deepEqual(r.kept, []);
});

test('a hand-edited line is kept with a reason; the generated one beside it is still refreshed', () => {
  const edited = 'node (see `docs/stack.md`), sterling';
  const r = refreshAgentsMdFacts(doc(edited, `~/.sterling/domains/node/${SUFFIX}`), FACTS);
  assert.deepEqual(r.refreshed, ['Domain stores']);
  assert.deepEqual(r.kept, [{ name: 'Stack tags', reason: 'the line was edited by hand' }]);
  assert.ok(r.text.includes(`${STACK_TAGS_LABEL}${edited}\n`), 'the edited line is byte-identical');
  const prose = refreshAgentsMdFacts(doc('node', '~/.sterling/domains/node/ plus a note we wrote'), FACTS);
  assert.deepEqual(prose.kept, [{ name: 'Domain stores', reason: 'the line was edited by hand' }]);
});

test('a missing line is listed as absent and never added; a duplicated line is kept and reported', () => {
  const missing = doc('node', `~/.sterling/domains/node/${SUFFIX}`).replace(/^- Domain stores.*\n/m, '');
  const r = refreshAgentsMdFacts(missing, FACTS);
  assert.deepEqual(r.absent, ['Domain stores']);
  assert.deepEqual(r.kept, []);
  assert.deepEqual(r.refreshed, ['Stack tags']);
  assert.ok(!r.text.includes(DOMAINS_LABEL));
  const twice = `${doc('node', `~/.sterling/domains/node/${SUFFIX}`)}${STACK_TAGS_LABEL}node\n`;
  const d = refreshAgentsMdFacts(twice, FACTS);
  assert.deepEqual(d.kept, [{ name: 'Stack tags', reason: 'the line appears 2 times' }]);
});

// ---- end to end: a temp project through init and domains.mjs ----

function run(script, dir, home, args) {
  // Init detects its host; inside an OpenCode session these would steer it (anti-pattern ddf7ad45).
  const { OPENCODE, OPENCODE_SESSION_ID, ...base } = process.env;
  const r = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 180_000,
    env: {
      ...base,
      HOME: home,
      STERLING_REGISTRY_DB: join(home, 'registry.db'),
      STERLING_PLUGIN_ROOT_MATCH: tmp('sterling-amf-root-'),
      CLAUDE_CONFIG_DIR: tmp('sterling-amf-cfg-'),
      STERLING_CODEX_PROBE: 'absent',
      STERLING_CLAUDE_PROBE: 'ok',
      STERLING_OPENCODE_SETUP_DISABLE: '1',
    },
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const INIT_FLAGS = ['--project-name', 'amf', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups', '--stack-tags', 'node'];
const domainDb = (home, name) => join(home, '.sterling', 'domains', name, 'sterling.db');
const lineOf = (text, label) => text.split('\n').find((l) => l.startsWith(label));

function initedProject() {
  const dir = tmp('sterling-amf-proj-');
  const home = tmp('sterling-amf-home-');
  createDomain('node', 'Node facts', domainDb(home, 'node'));
  createDomain('python', 'Python facts', domainDb(home, 'python'));
  const first = run('init.mjs', dir, home, ['--target', dir, ...INIT_FLAGS]);
  assert.equal(first.code, 0, first.out);
  return { dir, home };
}
function retag(dir, tags) {
  const p = join(dir, '.sterling', 'config.json');
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), stack_tags: tags }, null, 2));
}

test('init re-run after a stack-tag rename rewrites both generated lines', () => {
  const { dir, home } = initedProject();
  const agentsPath = join(dir, 'AGENTS.md');
  assert.equal(lineOf(readFileSync(agentsPath, 'utf8'), STACK_TAGS_LABEL), `${STACK_TAGS_LABEL}node, sterling`);
  retag(dir, ['python', 'sterling']);
  const r = run('init.mjs', dir, home, ['--target', dir]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^AGENTS\.md\s+refreshed\s+rewrote the Stack tags and Domain stores lines/m);
  const after1 = readFileSync(agentsPath, 'utf8');
  assert.equal(lineOf(after1, STACK_TAGS_LABEL), `${STACK_TAGS_LABEL}python, sterling`);
  assert.equal(lineOf(after1, DOMAINS_LABEL), `${DOMAINS_LABEL}~/.sterling/domains/python/, ~/.sterling/domains/sterling/${SUFFIX}`);
  const again = run('init.mjs', dir, home, ['--target', dir]);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /^AGENTS\.md\s+ok\s+/m);
  assert.equal(readFileSync(agentsPath, 'utf8'), after1, 'a second run changes nothing');
});

test('init re-run keeps a hand-edited line and warns; the generated line is still rewritten', () => {
  const { dir, home } = initedProject();
  const agentsPath = join(dir, 'AGENTS.md');
  const edited = readFileSync(agentsPath, 'utf8').replace(`${STACK_TAGS_LABEL}node, sterling`, `${STACK_TAGS_LABEL}node and sterling (we chose these in 2025)`);
  writeFileSync(agentsPath, edited);
  retag(dir, ['python', 'sterling']);
  const r = run('init.mjs', dir, home, ['--target', dir]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^AGENTS\.md\s+kept\s+rewrote the Domain stores line .*left the Stack tags line alone \(the line was edited by hand\); config says: python, sterling/m);
  assert.match(r.out, /⚠ AGENTS\.md: left the Stack tags line alone .* Update that line by hand\./);
  const text = readFileSync(agentsPath, 'utf8');
  assert.equal(lineOf(text, STACK_TAGS_LABEL), `${STACK_TAGS_LABEL}node and sterling (we chose these in 2025)`);
  assert.match(lineOf(text, DOMAINS_LABEL), /domains\/python\//);
});

test('domains.mjs --apply refreshes the AGENTS.md lines for the added tag', () => {
  const { dir, home } = initedProject();
  const r = run('domains.mjs', dir, home, ['--apply', '--add', 'python']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /AGENTS\.md: rewrote the Stack tags and Domain stores lines/);
  const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.equal(lineOf(text, STACK_TAGS_LABEL), `${STACK_TAGS_LABEL}node, python, sterling`);
  assert.doesNotMatch(r.out, /by hand/);
});

// #329 fix round, finding 10: domains.mjs writes AGENTS.md through the same checks as every other
// writer, so a refresh that would take the file past agy's 24,000-byte cap writes nothing and the
// run fails loudly, naming what it already applied.
test("domains.mjs --apply refuses (exit 2) an AGENTS.md refresh that would pass agy's 24,000-byte cap, and AGENTS.md is byte-identical", () => {
  const { dir, home } = initedProject();
  const agentsPath = join(dir, 'AGENTS.md');
  const base = readFileSync(agentsPath, 'utf8');
  const pad = `<!-- ${'x'.repeat(24_000 - Buffer.byteLength(base) - 10)} -->\n`;
  const padded = base.replace('\n', `\n${pad}`);
  assert.ok(Buffer.byteLength(padded) <= 24_000 && Buffer.byteLength(padded) > 23_990, 'fixture: the file sits just under the cap');
  writeFileSync(agentsPath, padded);
  const r = run('domains.mjs', dir, home, ['--apply', '--add', 'python']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /domains REFUSED: AGENTS\.md was not updated \(AGENTS\.md would be [\d,]+ bytes .*over agy's 24,000-byte cap/);
  assert.match(r.out, /Already applied in this run: .*stack_tags in \.sterling\/config\.json/);
  assert.equal(readFileSync(agentsPath, 'utf8'), padded, 'nothing written');
});

// #329 re-check, gap 2: a file system error writing AGENTS.md (here the project directory cannot
// take the atomic write's temp file) comes after the mount and the registry tags were changed. It is
// the same loud partial-apply refusal (exit 2) as a validation refusal, never a stack trace.
test('domains.mjs --apply: an AGENTS.md that cannot be written is a partial-apply refusal (exit 2); the new mount stays and AGENTS.md is byte-identical', { skip: process.getuid?.() === 0 && 'root writes into a read-only directory' }, () => {
  const { dir, home } = initedProject();
  const agentsPath = join(dir, 'AGENTS.md');
  const before = readFileSync(agentsPath, 'utf8');
  chmodSync(dir, 0o555);
  let r;
  try {
    r = run('domains.mjs', dir, home, ['--apply', '--add', 'python']);
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /domains REFUSED: AGENTS\.md was not updated \(EACCES: /);
  assert.match(r.out, /Already applied in this run: .*stack_tags in \.sterling\/config\.json: node, python, sterling/);
  assert.doesNotMatch(r.out, /^\s+at /m, 'no stack trace');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8')).stack_tags, ['node', 'python', 'sterling'], 'the new mount is present');
  assert.equal(readFileSync(agentsPath, 'utf8'), before, 'AGENTS.md is byte-identical');
});
