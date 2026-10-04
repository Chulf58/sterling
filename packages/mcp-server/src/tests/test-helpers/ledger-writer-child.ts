// Child process for domain-write-ledger.test.ts's concurrency case: one MCP
// server's worth of SterlingTools with its OWN project and domain stores (so
// SQLite locking is not what is under test) and a repoRoot SHARED with its
// sibling processes, which is where the domain-write ledger lives.
// argv: <shared repoRoot> <number of domain creates>. Prints the created ids
// as a JSON array on stdout.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { MountedStores, createDomain } from '@sterling/store';
import { SterlingTools } from '../../tools.js';

const [root, countArg] = process.argv.slice(2);
const count = Number(countArg);
if (!root || !Number.isInteger(count) || count < 1) throw new Error('usage: ledger-writer-child <repoRoot> <count>');

const dir = mkdtempSync(join(tmpdir(), 'sterling-ledger-child-'));
const domainDb = join(dir, 'domains', 'genesys', 'sterling.db');
createDomain('genesys', 'test domain genesys', domainDb);
const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'genesys', dbPath: domainDb }]);
try {
  const tools = new SterlingTools({ store, config: parseConfig({ stack_tags: ['genesys'] }), newId: randomUUID, repoRoot: root });
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const made = tools.knowledgeCreate('decision', {
      scope: 'domain:genesys',
      title: `ruling ${process.pid}-${i}`,
      statement: `statement ${process.pid}-${i}`,
      alternatives_rejected: [],
      rationale: 'r',
    });
    ids.push(made.record.id);
  }
  process.stdout.write(JSON.stringify(ids));
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
