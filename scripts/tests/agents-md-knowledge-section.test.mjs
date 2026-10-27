// GitHub #218: the AGENTS.md Knowledge section names architecture.md and rulings.md only while the
// handoff projection is on. With handoff off it says the knowledge is in the Sterling store.
// init renders the right variant, and init/update flip an existing shipped-wording section when the
// setting differs; a hand-edited section is left alone and reported.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDomain } from '@sterling/store';
import { KNOWLEDGE_VARIANTS, refreshAgentsMdKnowledge, renderKnowledgeSection } from '../lib/agents-md-facts.mjs';

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

const { projected, store } = KNOWLEDGE_VARIANTS;
const section = (v) => `${v.heading}\n\n${v.body}`;
const page = (v, eol = '\n') => ['# AGENTS.md — x', '', section(v), '', '## Conduct rules', '', '- a rule', ''].join('\n').replaceAll('\n', eol);

test('the template carries the projection variant verbatim (what refresh and the swap key on)', () => {
  const template = readFileSync(join(root, 'templates', 'target-agents-md.md'), 'utf8');
  assert.ok(template.includes(section(projected)));
  assert.ok(!/rulings\.md|architecture\.md/.test(store.body), 'the store wording names no projection file');
  assert.match(store.body, /knowledge_query/);
  assert.match(store.body, /knowledge_get/);
});

test('renderKnowledgeSection: projected keeps the template, off swaps in the store wording', () => {
  const template = page(projected);
  assert.equal(renderKnowledgeSection(template, true), template);
  assert.equal(renderKnowledgeSection(template, false), page(store));
});

test('refresh flips a shipped section both ways and keeps every other byte, CRLF included', () => {
  const off = refreshAgentsMdKnowledge(page(projected), false);
  assert.equal(off.refreshed, true);
  assert.equal(off.text, page(store));
  const on = refreshAgentsMdKnowledge(page(store), true);
  assert.equal(on.refreshed, true);
  assert.equal(on.text, page(projected));
  const crlf = refreshAgentsMdKnowledge(page(projected, '\r\n'), false);
  assert.equal(crlf.text, page(store, '\r\n'));
  const same = refreshAgentsMdKnowledge(page(store), false);
  assert.deepEqual({ refreshed: same.refreshed, kept: same.kept, absent: same.absent }, { refreshed: false, kept: null, absent: false });
});

test('a hand-edited section is kept and reported, and a missing section is never added', () => {
  const edited = page(projected).replace('Read the entries', 'Skim the entries');
  const r = refreshAgentsMdKnowledge(edited, false);
  assert.equal(r.refreshed, false);
  assert.equal(r.kept, 'the section was edited by hand');
  assert.equal(r.text, edited);
  const extra = page(store).replace(store.body, `${store.body}\n- We also keep notes in docs/.`);
  assert.equal(refreshAgentsMdKnowledge(extra, true).kept, 'the section was edited by hand');
  const none = '# AGENTS.md — x\n\n## Conduct rules\n\n- a rule\n';
  const a = refreshAgentsMdKnowledge(none, false);
  assert.deepEqual({ text: a.text, absent: a.absent, kept: a.kept }, { text: none, absent: true, kept: null });
});

// ---- end to end: a temp project through init ----

function run(dir, home, args) {
  // Init detects its host; inside an OpenCode session these would steer it (anti-pattern ddf7ad45).
  const { OPENCODE, OPENCODE_SESSION_ID, ...base } = process.env;
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'init.mjs'), '--target', dir, ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 180_000,
    env: {
      ...base,
      HOME: home,
      STERLING_REGISTRY_DB: join(home, 'registry.db'),
      STERLING_PLUGIN_ROOT_MATCH: tmp('sterling-aks-root-'),
      CLAUDE_CONFIG_DIR: tmp('sterling-aks-cfg-'),
      STERLING_CODEX_PROBE: 'absent',
      STERLING_CLAUDE_PROBE: 'ok',
      STERLING_OPENCODE_SETUP_DISABLE: '1',
    },
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const INIT_FLAGS = ['--project-name', 'aks', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups', '--stack-tags', 'node'];

// A project whose config already carries the handoff setting when init first runs.
function project(handoff) {
  const dir = tmp('sterling-aks-proj-');
  const home = tmp('sterling-aks-home-');
  createDomain('node', 'Node facts', join(home, '.sterling', 'domains', 'node', 'sterling.db'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'aks', handoff: { enabled: handoff } }));
  return { dir, home };
}
function setHandoff(dir, enabled) {
  const p = join(dir, '.sterling', 'config.json');
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), handoff: { enabled } }, null, 2));
}

test('init with handoff off renders the store wording', () => {
  const { dir, home } = project(false);
  const r = run(dir, home, INIT_FLAGS);
  assert.equal(r.code, 0, r.out);
  const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes(section(store)));
  assert.ok(!text.includes(projected.heading));
  assert.ok(!/rulings\.md/.test(text), 'no mention of the unprojected files');
});

test('init with handoff on renders the projection wording', () => {
  const { dir, home } = project(true);
  run(dir, home, INIT_FLAGS);
  const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes(section(projected)));
  assert.ok(!text.includes(`${store.heading}\n`));
});

test('init re-run flips an existing shipped section when the handoff setting changes, both ways', () => {
  const { dir, home } = project(false);
  assert.equal(run(dir, home, INIT_FLAGS).code, 0);
  const agentsPath = join(dir, 'AGENTS.md');
  setHandoff(dir, true);
  run(dir, home, []);
  assert.ok(readFileSync(agentsPath, 'utf8').includes(section(projected)), 'on -> projection wording');
  setHandoff(dir, false);
  const r = run(dir, home, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^AGENTS\.md\s+refreshed\s+rewrote the Knowledge section/m);
  assert.ok(readFileSync(agentsPath, 'utf8').includes(section(store)), 'off -> store wording');
});

test('init re-run leaves a hand-edited Knowledge section alone and says so', () => {
  const { dir, home } = project(false);
  assert.equal(run(dir, home, INIT_FLAGS).code, 0);
  const agentsPath = join(dir, 'AGENTS.md');
  const edited = readFileSync(agentsPath, 'utf8').replace('Read it through', 'Our team reads it through');
  writeFileSync(agentsPath, edited);
  setHandoff(dir, true);
  const r = run(dir, home, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^AGENTS\.md\s+kept\s+.*left the Knowledge section alone \(the section was edited by hand\)/m);
  assert.equal(readFileSync(agentsPath, 'utf8'), edited);
});
