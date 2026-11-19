import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SOURCE_DIR, adopt, planAdoption, readSourceFiles, sha256 } from '../lib/agent-adoption.mjs';

const BODY = '---\nname: scout\nmodel: sonnet\n---\nFind things.\n';
const scout = (over = {}) => ({ host: 'opencode', name: 'team/scout', file: '.opencode/agents/team/scout.md', content: BODY, ...over });
const state = (over = {}) => ({ sourceFiles: [], configKeys: [], others: [], ...over });
const codes = (plan) => plan.refusals.map((r) => r.code);

test('plan: moves the file to agent-sources/<key>.md under a custom- key', () => {
  const plan = planAdoption(scout(), state());
  assert.equal(plan.ok, true);
  assert.equal(plan.key, 'custom-team-scout');
  assert.deepEqual(plan.move, { from: '.opencode/agents/team/scout.md', to: 'agent-sources/custom-team-scout.md' });
  assert.equal(plan.contentHash, sha256(BODY));
});

test('plan refuses a slug collision on the same host (team/scout vs team-scout), naming both', () => {
  const plan = planAdoption(scout(), state({ others: [{ host: 'opencode', name: 'team-scout', content: BODY }] }));
  assert.deepEqual(codes(plan), ['key-collision']);
  assert.match(plan.refusals[0].message, /opencode:team\/scout and opencode:team-scout/);
});

test('plan: same name on another host is a duplicate when identical and ambiguous when not', () => {
  const same = planAdoption(scout(), state({ others: [{ host: 'claude', name: 'team/scout', content: BODY }] }));
  assert.equal(same.ok, true);
  assert.deepEqual(same.duplicates, [{ host: 'claude', name: 'team/scout' }]);
  const differs = planAdoption(scout(), state({ others: [{ host: 'claude', name: 'team/scout', content: `${BODY}more\n` }] }));
  assert.deepEqual(codes(differs), ['ambiguous-duplicate']);
});

test('plan refuses a file outside the project, a generated copy, an unreadable file and taken names', () => {
  assert.deepEqual(codes(planAdoption(scout({ file: '../x/.opencode/agents/s.md' }), state())), ['outside-project']);
  assert.deepEqual(codes(planAdoption(scout({ file: '/etc/agents/s.md' }), state())), ['outside-project']);
  assert.deepEqual(codes(planAdoption(scout({ file: 'agents/team/scout.md' }), state())), ['outside-project']);
  assert.deepEqual(codes(planAdoption(scout({ content: `${BODY}<!-- sterling-full renderer=x -->` }), state())), ['generated']);
  assert.deepEqual(codes(planAdoption(scout({ content: undefined }), state())), ['unreadable']);
  assert.deepEqual(codes(planAdoption(scout(), state({ configKeys: ['custom-team-scout'] }))), ['key-in-use']);
  assert.deepEqual(codes(planAdoption(scout(), state({ sourceFiles: ['custom-team-scout.md'] }))), ['source-exists']);
  assert.deepEqual(codes(planAdoption(scout({ name: '!!!' }), state())), ['invalid-name']);
});

test('source folder is one no host serves', () => {
  assert.equal(AGENT_SOURCE_DIR, 'agent-sources');
  for (const served of ['agents', '.claude/agents', '.opencode/agents', '.opencode/agent', '.agents/agents']) assert.notEqual(AGENT_SOURCE_DIR, served);
});

function project() {
  return mkdtempSync(join(tmpdir(), 'adopt-'));
}

test('adopt writes the source, verifies, then removes the original', () => {
  const root = project();
  try {
    mkdirSync(join(root, '.opencode/agents/team'), { recursive: true });
    writeFileSync(join(root, '.opencode/agents/team/scout.md'), BODY);
    const plan = planAdoption(scout(), state({ sourceFiles: readSourceFiles(root) }));
    const done = adopt(root, plan);
    assert.deepEqual(done, { from: '.opencode/agents/team/scout.md', to: 'agent-sources/custom-team-scout.md', key: 'custom-team-scout' });
    assert.equal(readFileSync(join(root, 'agent-sources/custom-team-scout.md'), 'utf8'), BODY.replace('---\n', '---\nsterling-origin: opencode\n'), 'the original plus its origin line');
    assert.equal(existsSync(join(root, '.opencode/agents/team/scout.md')), false);
    assert.deepEqual(readdirSync(join(root, 'agent-sources')), ['custom-team-scout.md'], 'no temp file left');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adopt of an agy agent removes the emptied <name>/ folder', () => {
  const root = project();
  try {
    mkdirSync(join(root, '.agents/agents/helper'), { recursive: true });
    writeFileSync(join(root, '.agents/agents/helper/agent.md'), BODY);
    const plan = planAdoption({ host: 'agy', name: 'helper', file: '.agents/agents/helper/agent.md', content: BODY }, state());
    adopt(root, plan);
    assert.equal(existsSync(join(root, '.agents/agents/helper')), false);
    assert.equal(existsSync(join(root, 'agent-sources/custom-helper.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adopt refuses and changes nothing when the original changed, the target exists or the plan is refused', () => {
  const root = project();
  try {
    mkdirSync(join(root, '.opencode/agents/team'), { recursive: true });
    const from = join(root, '.opencode/agents/team/scout.md');
    writeFileSync(from, BODY);
    const plan = planAdoption(scout(), state());
    writeFileSync(from, `${BODY}edited\n`);
    assert.throws(() => adopt(root, plan), /changed since it was planned/);
    assert.equal(existsSync(join(root, 'agent-sources')), false);
    writeFileSync(from, BODY);
    mkdirSync(join(root, 'agent-sources'));
    writeFileSync(join(root, 'agent-sources/custom-team-scout.md'), 'mine');
    assert.throws(() => adopt(root, plan), /already exists/);
    assert.equal(readFileSync(join(root, 'agent-sources/custom-team-scout.md'), 'utf8'), 'mine');
    assert.equal(readFileSync(from, 'utf8'), BODY);
    assert.throws(() => adopt(root, planAdoption(scout({ file: 'x/y.md' }), state())), /not adoptable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── review fixes: the origin host is recorded, unrepresentable restrictions refuse up front, no symlinks ──

test('adopt records the origin host in the source frontmatter; the rest of the file is byte-for-byte the original', () => {
  const root = project();
  try {
    mkdirSync(join(root, '.opencode/agents/team'), { recursive: true });
    writeFileSync(join(root, '.opencode/agents/team/scout.md'), BODY);
    adopt(root, planAdoption(scout(), state()));
    assert.equal(readFileSync(join(root, 'agent-sources/custom-team-scout.md'), 'utf8'), BODY.replace('---\n', '---\nsterling-origin: opencode\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plan refuses up front when an installed host could only get a broader agent, naming the host and the rule', () => {
  const ask = '---\ndescription: d\npermission:\n  bash: ask\n---\nBody.\n';
  const plan = planAdoption(scout({ content: ask }), state({ hosts: ['claude', 'opencode'] }));
  assert.deepEqual(codes(plan), ['permission-unrepresentable']);
  assert.match(plan.refusals[0].message, /claude: .*asks before bash/);
  assert.equal(planAdoption(scout({ content: ask }), state({ hosts: ['opencode'] })).ok, true, 'its own host renders it as written');
  assert.deepEqual(codes(planAdoption(scout({ content: 'no frontmatter\n' }), state())), ['no-frontmatter']);
  assert.deepEqual(codes(planAdoption(scout({ content: '---\nsterling-origin: claude\n---\nx\n' }), state())), ['origin-present']);
});

test('adopt refuses a symlinked host folder and never deletes the file behind it', () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), 'adopt-outside-'));
  try {
    mkdirSync(join(outside, 'team'), { recursive: true });
    writeFileSync(join(outside, 'team/scout.md'), BODY);
    mkdirSync(join(root, '.opencode'));
    symlinkSync(outside, join(root, '.opencode/agents'));
    const plan = planAdoption(scout(), state());
    assert.throws(() => adopt(root, plan), /symlink/);
    assert.equal(readFileSync(join(outside, 'team/scout.md'), 'utf8'), BODY, 'the external original is intact');
    assert.equal(existsSync(join(root, 'agent-sources')), false, 'nothing written');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('adopt refuses a symlinked agent-sources folder and writes nothing outside the project', () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), 'adopt-outside-'));
  try {
    mkdirSync(join(root, '.opencode/agents/team'), { recursive: true });
    writeFileSync(join(root, '.opencode/agents/team/scout.md'), BODY);
    symlinkSync(outside, join(root, 'agent-sources'));
    assert.throws(() => adopt(root, planAdoption(scout(), state())), /symlink/);
    assert.deepEqual(readdirSync(outside), [], 'nothing written through the link');
    assert.equal(readFileSync(join(root, '.opencode/agents/team/scout.md'), 'utf8'), BODY);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('plan refuses adoption when agy is installed and the agent denies an MCP tool agy cannot deny, denylist-only and mixed (item-G review finding 2)', () => {
  for (const content of ['---\nname: scout\ndescription: d\ndisallowedTools: mcp__private__delete\n---\nBody.\n', '---\nname: scout\ndescription: d\ntools: Read, Grep\ndisallowedTools: mcp__private__delete\n---\nBody.\n']) {
    const plan = planAdoption(scout({ host: 'claude', file: '.claude/agents/team/scout.md', content }), state({ hosts: ['claude', 'agy'] }));
    assert.deepEqual(codes(plan), ['permission-unrepresentable'], content);
    assert.match(plan.refusals[0].message, /agy: .*denial of mcp__private__delete/);
  }
});
