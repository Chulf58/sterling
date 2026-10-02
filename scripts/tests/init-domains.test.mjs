// /sterling:init creates each declared domain's store with a description
// (decision projects-mount-domains-and-sibling-projects, board 275b29ac): a new
// domain needs one, supplied with `--domain-description <name>=<text>` (repeatable);
// the forced 'sterling' domain ships a default; an existing store is untouched; a
// domain with no description refuses before anything is written.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SterlingStore, createDomain } from '@sterling/store';
import { DEFAULT_DOMAIN_DESCRIPTIONS } from '../lib/domain-defaults.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE_FLAGS = ['--project-name', 'domains-test', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups'];

const scratch = new Set();
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.add(d);
  return d;
}
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// A spawn of init isolated from the machine: scratch HOME (so ~/.sterling/domains is a
// scratch tree), registry, plugin-root match and Claude config dir.
function init(dir, home, args) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'init.mjs'), '--target', dir, ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 180_000,
    env: {
      ...process.env,
      HOME: home,
      STERLING_REGISTRY_DB: join(dir, 'registry.db'),
      STERLING_PLUGIN_ROOT_MATCH: tmp('sterling-dom-root-'),
      CLAUDE_CONFIG_DIR: tmp('sterling-dom-cfg-'),
      STERLING_CODEX_PROBE: 'absent',
      STERLING_CLAUDE_PROBE: 'ok',
      STERLING_OPENCODE_SETUP_DISABLE: '1',
    },
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

const domainDb = (home, name) => join(home, '.sterling', 'domains', name, 'sterling.db');
function descriptionOf(path) {
  const s = new SterlingStore(path);
  try {
    return s.getMeta('description');
  } finally {
    s.close();
  }
}

test('a new domain is created with the description the user gave', () => {
  const dir = tmp('sterling-dom-proj-');
  const home = tmp('sterling-dom-home-');
  const r = init(dir, home, [...BASE_FLAGS, '--stack-tags', 'python', '--domain-description', 'python=Python language and tooling facts']);
  assert.equal(r.code, 0, r.out);
  assert.equal(descriptionOf(domainDb(home, 'python')), 'Python language and tooling facts');
});

test('the description may contain "=" and is split at the first one only', () => {
  const dir = tmp('sterling-dom-proj-');
  const home = tmp('sterling-dom-home-');
  const r = init(dir, home, [...BASE_FLAGS, '--stack-tags', 'go', '--domain-description', 'go=a=b and more']);
  assert.equal(r.code, 0, r.out);
  assert.equal(descriptionOf(domainDb(home, 'go')), 'a=b and more');
});

test('a new domain with no description refuses, names the flag and the domain, and writes nothing', () => {
  const dir = tmp('sterling-dom-proj-');
  const home = tmp('sterling-dom-home-');
  const r = init(dir, home, [...BASE_FLAGS, '--stack-tags', 'python']);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /--domain-description python=/);
  assert.equal(existsSync(domainDb(home, 'python')), false, 'no store is created for the refused domain');
  assert.equal(existsSync(join(dir, '.sterling', 'config.json')), false, 'a refused init writes no config');
  assert.equal(existsSync(join(home, '.sterling')), false, 'a refused init creates no sterling domain either');
});

test('a blank description refuses like a missing one', () => {
  const dir = tmp('sterling-dom-proj-');
  const home = tmp('sterling-dom-home-');
  const r = init(dir, home, [...BASE_FLAGS, '--stack-tags', 'python', '--domain-description', 'python=   ']);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /--domain-description .*non-blank description/);
  assert.equal(existsSync(domainDb(home, 'python')), false);
});

test('a description for a domain the project does not declare refuses', () => {
  const dir = tmp('sterling-dom-proj-');
  const home = tmp('sterling-dom-home-');
  const r = init(dir, home, [...BASE_FLAGS, '--stack-tags', 'python', '--domain-description', 'python=P', '--domain-description', 'rust=R']);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /rust/);
  assert.equal(existsSync(domainDb(home, 'python')), false);
});

test('an existing domain store is untouched: its description is kept and a new one is not applied', () => {
  const dir = tmp('sterling-dom-proj-');
  const home = tmp('sterling-dom-home-');
  const path = domainDb(home, 'python');
  createDomain('python', 'the original description', path);
  const r = init(dir, home, [...BASE_FLAGS, '--stack-tags', 'python', '--domain-description', 'python=a different description']);
  assert.equal(r.code, 0, r.out);
  assert.equal(descriptionOf(path), 'the original description');
  assert.match(r.out, /python.*already (has a store|exists)/i);
});

test('an existing domain needs no description flag', () => {
  const dir = tmp('sterling-dom-proj-');
  const home = tmp('sterling-dom-home-');
  createDomain('python', 'already described', domainDb(home, 'python'));
  const r = init(dir, home, [...BASE_FLAGS, '--stack-tags', 'python']);
  assert.equal(r.code, 0, r.out);
  assert.equal(descriptionOf(domainDb(home, 'python')), 'already described');
});

test('the sterling domain gets the shipped default description with no flag', () => {
  const dir = tmp('sterling-dom-proj-');
  const home = tmp('sterling-dom-home-');
  const path = domainDb(home, 'sterling');
  const r = init(dir, home, [...BASE_FLAGS, '--stack-tags', 'python', '--domain-description', 'python=P']);
  assert.equal(r.code, 0, r.out);
  assert.equal(descriptionOf(path), DEFAULT_DOMAIN_DESCRIPTIONS.sterling);
  assert.match(DEFAULT_DOMAIN_DESCRIPTIONS.sterling, /Claude Code and OpenCode/);
});

test('a project can change the sterling description with the flag', () => {
  const dir = tmp('sterling-dom-proj-');
  const home = tmp('sterling-dom-home-');
  const r = init(dir, home, [...BASE_FLAGS, '--stack-tags', 'python', '--domain-description', 'python=P', '--domain-description', 'sterling=My own sterling scope']);
  assert.equal(r.code, 0, r.out);
  assert.equal(descriptionOf(domainDb(home, 'sterling')), 'My own sterling scope');
});

test('a re-run needs no flags: stores exist, nothing is recreated or changed', () => {
  const dir = tmp('sterling-dom-proj-');
  const home = tmp('sterling-dom-home-');
  const first = init(dir, home, [...BASE_FLAGS, '--stack-tags', 'python', '--domain-description', 'python=P']);
  assert.equal(first.code, 0, first.out);
  const again = init(dir, home, []);
  assert.equal(again.code, 0, again.out);
  assert.equal(descriptionOf(domainDb(home, 'python')), 'P');
});

test('a re-run whose recorded domain store is gone refuses and names the flag', () => {
  const dir = tmp('sterling-dom-proj-');
  const home = tmp('sterling-dom-home-');
  const first = init(dir, home, [...BASE_FLAGS, '--stack-tags', 'python', '--domain-description', 'python=P']);
  assert.equal(first.code, 0, first.out);
  rmSync(join(home, '.sterling', 'domains', 'python'), { recursive: true, force: true });
  const again = init(dir, home, []);
  assert.notEqual(again.code, 0, again.out);
  assert.match(again.out, /--domain-description python=/);
});

test('the /sterling:update ensure pass skips a recorded domain whose store is gone, loudly, instead of refusing the whole init', () => {
  // Task-end review 2026-10-03: a refusal there failed every later ensure item of
  // the update's re-bake. An interactive re-run still refuses (test above).
  const dir = tmp('sterling-dom-proj-');
  const home = tmp('sterling-dom-home-');
  const first = init(dir, home, [...BASE_FLAGS, '--stack-tags', 'python', '--domain-description', 'python=P']);
  assert.equal(first.code, 0, first.out);
  rmSync(join(home, '.sterling', 'domains', 'python'), { recursive: true, force: true });
  rmSync(join(dir, '.claude', 'agents', 'scout.md'), { force: true });
  const again = init(dir, home, ['--update-ensure']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /domain 'python' is recorded but has no store at .*python.* SKIPPED/);
  assert.match(again.out, /--domain-description python=/, 'the line names the remedy');
  assert.equal(existsSync(domainDb(home, 'python')), false, 'no store is created without a description');
  assert.ok(existsSync(join(dir, '.claude', 'agents', 'scout.md')), 'the rest of the ensure pass still ran');
});
