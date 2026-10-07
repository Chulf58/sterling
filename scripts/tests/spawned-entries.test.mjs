// SPAWNED_ENTRIES (scripts/lib/bundled-artifacts.mjs) feeds the entry-reachability
// check: each member names an entry and the shipped file that spawns it by a
// path built at run time. A member whose files moved would pass nothing, so
// this test pins both files and the quoted basename the check looks for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPAWNED_ENTRIES } from '../lib/bundled-artifacts.mjs';
import { EntryReachability } from '../../packages/mcp-server/dist/entry-reachability.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('SPAWNED_ENTRIES: every member is an existing top-level script whose spawner exists and names it as a quoted string', () => {
  assert.ok(Object.keys(SPAWNED_ENTRIES).length > 0);
  for (const [entry, spawner] of Object.entries(SPAWNED_ENTRIES)) {
    assert.match(entry, /^scripts\/[^/]+\.mjs$/, `${entry} is a top-level scripts/ entry`);
    assert.ok(existsSync(join(root, entry)), `${entry} exists`);
    assert.ok(existsSync(join(root, spawner)), `${spawner} (spawner of ${entry}) exists`);
    const name = basename(entry);
    const text = readFileSync(join(root, spawner), 'utf8');
    // the reachability check reads the same file by text; it must see what the module exports
    const verdict = new EntryReachability(root).judge(entry, '');
    assert.equal(verdict?.reached, true, `${entry}: ${verdict?.detail}`);
    assert.match(verdict?.detail ?? '', /^SPAWNED_ENTRIES maps it to/);
    assert.ok([`'${name}'`, `"${name}"`, `\`${name}\``].some((q) => text.includes(q)), `${spawner} holds ${name} as a quoted string`);
  }
});
