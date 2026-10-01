// .claude-plugin/marketplace.json (decision
// sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
// slice S4): the repo is its own single-plugin marketplace. Field rules are from
// https://code.claude.com/docs/en/plugins/marketplace-reference (fetched 2026-10-01):
// name, owner{name} and plugins are required; each entry needs name and source;
// a relative source resolves from the marketplace root (the directory holding
// .claude-plugin/), "." means the root itself; when an entry and plugin.json both
// set version, plugin.json wins and `claude plugin validate` warns on a mismatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Reserved marketplace names, same page: the official, community and
// Claude-Code-internal names a repo here could plausibly collide with.
const RESERVED = new Set([
  'claude-code-marketplace', 'claude-code-plugins', 'claude-plugins-official', 'anthropic-marketplace',
  'anthropic-plugins', 'agent-skills', 'anthropic-agent-skills', 'knowledge-work-plugins',
  'inline', 'builtin', 'skills-dir', 'synced', 'claude-plugin-test', 'npm', 'pip', 'uv', 'cargo', 'github', 'gh',
]);

const marketplace = readJson('.claude-plugin/marketplace.json');
const plugin = readJson('.claude-plugin/plugin.json');

test('marketplace.json carries the required top-level fields with valid names', () => {
  assert.equal(typeof marketplace.name, 'string');
  assert.match(marketplace.name, NAME_RE);
  assert.ok(!marketplace.name.includes('..'), 'marketplace name must not contain ".."');
  assert.ok(!RESERVED.has(marketplace.name), `"${marketplace.name}" is a reserved marketplace name`);
  assert.ok(!marketplace.name.startsWith('claudeai-'), 'claudeai- prefix is reserved for claude.ai marketplaces');
  assert.equal(typeof marketplace.owner?.name, 'string');
  assert.ok(marketplace.owner.name.length > 0, 'owner.name must be non-empty');
  assert.ok(Array.isArray(marketplace.plugins));
  assert.ok(marketplace.plugins.length >= 1);
  assert.equal(typeof marketplace.description, 'string', 'validate warns when description is missing');
});

test('the plugin entry matches plugin.json by name and (when declared) version', () => {
  const entries = marketplace.plugins.filter((p) => p.name === plugin.name);
  assert.equal(entries.length, 1, `exactly one entry named "${plugin.name}" (the install id is entry-name@marketplace)`);
  const entry = entries[0];
  assert.match(entry.name, NAME_RE);
  assert.equal(new Set(marketplace.plugins.map((p) => p.name)).size, marketplace.plugins.length, 'no duplicate plugin names');
  if ('version' in entry) {
    assert.equal(entry.version, plugin.version, 'entry version must equal plugin.json version (plugin.json wins at install)');
  }
});

test('the entry source resolves to the repo root, which holds the plugin manifest', () => {
  const entry = marketplace.plugins.find((p) => p.name === plugin.name);
  assert.equal(typeof entry.source, 'string', 'a relative-path source is a string');
  assert.ok(entry.source === '.' || entry.source.startsWith('./'), `relative source must be "." or start with "./", got ${JSON.stringify(entry.source)}`);
  assert.ok(!entry.source.split('/').includes('..'), 'a source containing ".." fails validation');
  assert.ok(!entry.source.includes('\\'), 'backslashes are refused on macOS/Linux');
  const resolved = resolve(root, entry.source);
  assert.equal(resolved, resolve(root), 'source must resolve to the marketplace root (the repo root)');
  assert.ok(existsSync(join(resolved, '.claude-plugin', 'plugin.json')));
});

test('the entry sets no component fields: plugin.json stays the single manifest', () => {
  const entry = marketplace.plugins.find((p) => p.name === plugin.name);
  for (const field of ['commands', 'agents', 'skills', 'hooks', 'outputStyles', 'themes', 'mcpServers']) {
    assert.ok(!(field in entry), `entry must not declare ${field}`);
  }
});
