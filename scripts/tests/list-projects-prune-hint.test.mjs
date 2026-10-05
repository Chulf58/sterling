// /sterling:projects prints a prune hint for registry entries whose path is gone. The hint is
// plain text the model reads, so it names the bundled bin entry in the Sterling root form
// (decision session-start-prints-the-sterling-root-plain-text-instructions-use-it): scripts/
// imports @sterling/* packages and fails on an installed plugin copy, and ${CLAUDE_PLUGIN_ROOT}
// is unset in the Bash tool.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'list-projects.mjs');

let ProjectRegistry;
before(async () => {
  ({ ProjectRegistry } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

test('the MISSING-projects hint names node "<Sterling root>/bin/list-projects.mjs" --prune-missing, never scripts/ or CLAUDE_PLUGIN_ROOT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-list-projects-'));
  try {
    const dbPath = join(dir, 'registry.db');
    const registry = new ProjectRegistry(dbPath);
    registry.register({ repo_path: join(dir, 'gone-project'), name: 'gone-project', stack_tags: [], toolchains: [], sterling_version: null, at: '2026-10-04T10:00:00.000Z' });
    registry.close();
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, STERLING_REGISTRY_DB: dbPath } });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /1 project MISSING \(path gone\)/, r.stdout);
    assert.ok(r.stdout.includes('Prune with: node "<Sterling root>/bin/list-projects.mjs" --prune-missing'), `names the bin entry in the Sterling root form: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /scripts\/list-projects/, 'never the scripts/ file');
    assert.doesNotMatch(r.stdout, /CLAUDE_PLUGIN_ROOT/, 'never the unsubstituted plugin-root variable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
