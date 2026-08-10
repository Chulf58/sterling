// domain-doctor tests (board 4cb9d525): the forensics + guarded-repair script
// for shared domain stores. The incident it exists for: a promoted record's
// domain copy resolves in NO store any session mounts (a homedir/root flip
// stranded the old store file; lazy-create silently shadowed it with a fresh
// empty one), while the project store still holds the tombstone whose
// superseded_by dangles at the lost copy.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = () => new Date().toISOString();

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function doctor(args, cwd) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'domain-doctor.mjs'), ...args], {
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A project dir with .sterling/{config.json,store.db}, one domains root, and a
 *  promotion-then-loss: the original was retired in favor of an id that exists
 *  in NO store (the lost domain copy). */
function lossScenario() {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-'));
  const projectDir = join(dir, 'proj');
  const domainsRoot = join(dir, 'domains');
  mkdirSync(join(projectDir, '.sterling'), { recursive: true });
  mkdirSync(domainsRoot, { recursive: true });
  writeFileSync(
    join(projectDir, '.sterling', 'config.json'),
    JSON.stringify({ stack_tags: ['genesys-cloud'], domain_paths: { 'genesys-cloud': join(domainsRoot, 'genesys-cloud', 'sterling.db').replace(/\\/g, '/') } })
  );
  const store = new SterlingStore(join(projectDir, '.sterling', 'store.db'));
  const originalId = randomUUID();
  const lostId = randomUUID();
  store.create({
    id: originalId,
    type: 'research_finding',
    created_at: NOW(),
    updated_at: NOW(),
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['genesys-cloud'],
    question: 'What are the tenant facts?',
    answer: 'The tenant facts are X, Y and Z.',
    source_urls: ['https://example.test'],
    source_date: '2026-06-22',
    capture_date: '2026-06-22',
    volatility_hint: 'medium',
  });
  // the promotion tombstone whose target was lost with the stranded store file
  store.retireInFavorOf(originalId, lostId, NOW(), 'promoted');
  store.close();
  return { dir, projectDir, domainsRoot, originalId, lostId };
}

test('sweep reports a superseded_by that resolves in no store, and is silent once it resolves', () => {
  const { projectDir, lostId, originalId } = lossScenario();
  const swept = doctor(['sweep', '--project', projectDir], projectDir);
  assert.equal(swept.code, 3, 'dangling pointers exit 3 so a caller can branch on the finding');
  assert.match(swept.stdout, new RegExp(lostId), 'names the missing target id');
  assert.match(swept.stdout, new RegExp(originalId), 'names the tombstone holding the pointer');
  assert.match(swept.stdout, /DANGLING/i);
});

test('restore is dry-run by default, applies only with --apply, resurrects the DANGLING id, and refuses a second apply', () => {
  const { projectDir, domainsRoot, originalId, lostId } = lossScenario();

  const dry = doctor(['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud'], projectDir);
  assert.equal(dry.code, 0, `dry-run succeeds: ${dry.stderr}`);
  assert.match(dry.stdout, /DRY-RUN/i, 'says nothing was written');
  assert.match(dry.stdout, new RegExp(lostId), 'plans to resurrect exactly the dangling target id');

  const domainDb = join(domainsRoot, 'genesys-cloud', 'sterling.db');
  const applied = doctor(
    ['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud', '--apply'],
    projectDir
  );
  assert.equal(applied.code, 0, `apply succeeds: ${applied.stderr}`);
  assert.match(applied.stdout, /RESTORED/i);

  const domain = new SterlingStore(domainDb);
  const restored = domain.get(lostId);
  domain.close();
  assert.ok(restored, 'the domain store now holds the record under the previously-dangling id');
  assert.equal(restored.status, 'active');
  assert.equal(restored.scope, 'domain:genesys-cloud');
  assert.equal(restored.answer, 'The tenant facts are X, Y and Z.', 'content restored from the tombstone body');
  assert.ok(
    restored.links.some((l) => l.rel === 'informed_by' && l.target_id === originalId),
    'provenance link back to the tombstone, same shape knowledge_promote writes'
  );

  // the sweep is now clean …
  const swept = doctor(['sweep', '--project', projectDir], projectDir);
  assert.equal(swept.code, 0, 'no dangling pointers after the restore');

  // … and a second apply refuses: the id resolves, there is nothing to restore.
  const again = doctor(
    ['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud', '--apply'],
    projectDir
  );
  assert.notEqual(again.code, 0, 'restoring an id that already resolves is refused');
  assert.match(again.stdout + again.stderr, /already resolves/i);
});

test('scan lists per-domain store files with record counts from an explicit root', () => {
  const { projectDir, domainsRoot, originalId, lostId } = lossScenario();
  // materialize the domain store via a real restore so scan has something to count
  doctor(['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud', '--apply'], projectDir);
  const scanned = doctor(['scan', '--roots', domainsRoot], projectDir);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.match(scanned.stdout, /genesys-cloud/);
  assert.match(scanned.stdout, /records: 1/, 'counts the restored record');
  assert.match(scanned.stdout, new RegExp(lostId.slice(0, 8)), '--find-free scan still lists earliest/latest ids per store');
});

test('migrate copies records verbatim from a stranded store into the current one, skipping ids that already exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-mig-'));
  const oldDb = join(dir, 'old', 'sterling.db');
  const newDb = join(dir, 'new', 'sterling.db');
  mkdirSync(dirname(oldDb), { recursive: true });
  mkdirSync(dirname(newDb), { recursive: true });
  const shared = randomUUID();
  const strandedOnly = randomUUID();
  const mk = (id, answer) => ({
    id, type: 'research_finding', created_at: '2026-06-22T10:00:00.000Z', updated_at: '2026-06-22T10:00:00.000Z',
    author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'domain:genesys-cloud',
    stack_tags: ['genesys-cloud'], question: `q-${id}`, answer, source_urls: [], source_date: '2026-06-22', capture_date: '2026-06-22',
  });
  const old = new SterlingStore(oldDb);
  old.create(mk(shared, 'shared answer'));
  old.create(mk(strandedOnly, 'stranded answer'));
  old.close();
  const nu = new SterlingStore(newDb);
  nu.create(mk(shared, 'shared answer'));
  nu.close();

  const dry = doctor(['migrate', '--from', oldDb, '--to', newDb], dir);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /DRY-RUN/i);
  assert.match(dry.stdout, new RegExp(strandedOnly), 'plans to copy exactly the missing record');
  assert.match(dry.stdout, /skipped 1/i, 'discloses the skipped shared id');

  const applied = doctor(['migrate', '--from', oldDb, '--to', newDb, '--apply'], dir);
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /MIGRATED: 1/i);

  const check = new SterlingStore(newDb);
  const restored = check.get(strandedOnly);
  const stillOne = check.get(shared);
  check.close();
  assert.ok(restored, 'the stranded record now resolves in the current store');
  assert.equal(restored.answer, 'stranded answer', 'body copied verbatim');
  assert.equal(restored.created_at, '2026-06-22T10:00:00.000Z', 'original clocks preserved — a migration is not a new write');
  assert.ok(stillOne, 'existing records untouched');
});
