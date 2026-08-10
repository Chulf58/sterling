// domain-doctor [S] (board 4cb9d525): forensics + GUARDED repair for the shared
// domain stores under the per-user roots. The incident class it exists for:
// a record promoted to a domain store resolves in NO store any session mounts —
// a domains-root/homedir flip (native Windows ↔ WSL both ran on this machine)
// strands the old store file, and §2.3 lazy-create silently shadows it with a
// fresh empty one. The project store still holds the promotion tombstone whose
// superseded_by dangles at the lost copy, so the CONTENT survives — what is
// missing is a sanctioned way to see the stranding and repair it (H15 rightly
// denies ad-hoc shell access to store files; this script is the sanctioned
// probe, listed in config.store_guard.allow_scripts).
//
//   node scripts/domain-doctor.mjs scan [--roots <dir,dir>]
//     List every domain store file under each root: record count, scope/type
//     breakdown, clock range, first/last record ids. Default roots: this
//     context's <home>/.sterling/domains plus, under WSL, the Windows-side
//     /mnt/c/Users/<user>/.sterling/domains when it exists — the two contexts
//     this machine actually runs (the flip between them is the leading
//     stranding cause). READ-ONLY.
//
//   node scripts/domain-doctor.mjs sweep --project <dir> [--roots <dir,dir>]
//     Every superseded_by pointer in the project's store whose target resolves
//     in NO store — not the project store, not a mounted domain, not any store
//     under the roots. Exit 3 when dangling pointers exist (0 clean). READ-ONLY.
//
//   node scripts/domain-doctor.mjs restore --project <dir> --tombstone <id> --domain <name> [--apply]
//     Recreate a lost promoted copy FROM the tombstone body, UNDER THE DANGLING
//     ID (tombstone.superseded_by) — so the tombstone's server-owned pointer
//     becomes consistent again without hand-editing it — with scope
//     domain:<name>, status active, and the same informed_by-origin link
//     knowledge_promote writes. Content fields are copied verbatim; clocks are
//     stamped at restore time (the restore is an event, not a forgery of the
//     original write). REFUSES when the target id already resolves anywhere.
//     Dry-run by default; --apply writes (and lazily creates the domain store,
//     which is the normal §2.3 mount behavior).
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SterlingStore, resolveDomainMounts } from '@sterling/store';
import { parseConfig } from '@sterling/schemas';

function fail(msg, code = 2) {
  console.error(`domain-doctor: ${msg}`);
  process.exit(code);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const POSIX = (p) => p.replace(/\\/g, '/');

/** The domain roots this machine can plausibly hold: the current context's home,
 *  plus the Windows-side home when running under WSL (the machine's other
 *  launcher context — the flip between the two is the incident's leading cause). */
function defaultRoots() {
  const roots = [join(homedir(), '.sterling', 'domains')];
  const user = basename(homedir());
  const winHome = join('/mnt/c/Users', user, '.sterling', 'domains');
  if (existsSync(winHome)) roots.push(winHome);
  return roots;
}

function roots() {
  const given = arg('roots');
  return (given ? given.split(',') : defaultRoots()).map(POSIX);
}

/** Read-only open — the doctor's diagnosis paths never take a write lock. */
function openRO(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** Every store file under the given roots: root/<domain>/sterling.db. */
function storeFilesUnder(rootList) {
  const found = [];
  for (const root of rootList) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const dbPath = POSIX(join(root, name, 'sterling.db'));
      if (existsSync(dbPath)) found.push({ root: POSIX(root), domain: name, dbPath });
    }
  }
  return found;
}

function projectContext(projectDir) {
  if (!projectDir) fail('--project <dir> is required');
  const dotDir = join(projectDir, '.sterling');
  const configPath = join(dotDir, 'config.json');
  if (!existsSync(configPath)) fail(`no Sterling config at ${POSIX(configPath)} — is this an init'd project?`);
  // store.db is the standard name; fall back to the single *.db in .sterling so
  // an older/differently-named project store is still sweepable.
  let storePath = POSIX(join(dotDir, 'store.db'));
  if (!existsSync(storePath)) {
    const dbs = readdirSync(dotDir).filter((f) => f.endsWith('.db'));
    if (dbs.length === 1) storePath = POSIX(join(dotDir, dbs[0]));
    else fail(`no project store at ${storePath}${dbs.length ? ` (found ${dbs.join(', ')} — ambiguous, pass a project with a store.db)` : ''}`);
  }
  const config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  return { config, storePath };
}

/** migrate --from <store.db> --to <store.db> [--apply]: copy every record the
 *  destination does not hold, BYTE-VERBATIM (envelope included — ids, clocks,
 *  scope, status all preserved: this heals ONE logical store split across two
 *  physical files by a context flip; it is not a new write event). Records are
 *  inserted through the validated write path, so a record that no longer
 *  parses against the current schemas is REPORTED and skipped, never silently
 *  dropped or half-written. */
function migrate() {
  const from = arg('from') ?? fail('--from <store.db> is required');
  const to = arg('to') ?? fail('--to <store.db> is required');
  const apply = process.argv.includes('--apply');
  if (!existsSync(from)) fail(`no source store at ${from}`);
  if (!existsSync(to)) fail(`no destination store at ${to} — migrate merges into an existing store; create it by mounting first`);
  const have = idsIn(to);
  const db = openRO(from);
  let rows;
  try {
    rows = db.prepare('SELECT body FROM records').all().map((r) => JSON.parse(r.body));
  } finally {
    db.close();
  }
  const missing = rows.filter((r) => !have.has(r.id));
  console.log(`migrate ${from} → ${to}: ${rows.length} source record(s), skipped ${rows.length - missing.length} already present, ${missing.length} to copy`);
  for (const r of missing) console.log(`  copy: ${r.id} (${r.type}, ${r.status}, ${r.created_at})`);
  if (!apply) {
    console.log('DRY-RUN: nothing written — re-run with --apply to migrate');
    return;
  }
  const dest = new SterlingStore(to);
  let copied = 0;
  const refused = [];
  try {
    for (const r of missing) {
      try {
        dest.create(r); // validated path: schema + indexes + FTS
        copied++;
      } catch (e) {
        refused.push({ id: r.id, reason: e.message });
      }
    }
  } finally {
    dest.close();
  }
  console.log(`MIGRATED: ${copied} record(s)`);
  for (const r of refused) console.log(`REFUSED: ${r.id} — ${r.reason}`);
  if (refused.length) process.exit(3);
}

/** All record ids in a store file (any status, tombstones included). */
function idsIn(dbPath) {
  const db = openRO(dbPath);
  try {
    return new Set(db.prepare('SELECT id FROM records').all().map((r) => r.id));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------

function scan() {
  const rootList = roots();
  console.log(`domain-doctor scan — roots: ${rootList.join(', ')}`);
  const files = storeFilesUnder(rootList);
  if (!files.length) {
    console.log('no domain store files found under any root');
    return;
  }
  for (const f of files) {
    const db = openRO(f.dbPath);
    try {
      const n = db.prepare('SELECT COUNT(*) AS n FROM records').get().n;
      const range = db.prepare('SELECT MIN(created_at) AS lo, MAX(created_at) AS hi FROM records').get();
      const first = db.prepare('SELECT id FROM records ORDER BY created_at ASC LIMIT 1').get();
      const last = db.prepare('SELECT id FROM records ORDER BY created_at DESC LIMIT 1').get();
      const byScope = db.prepare('SELECT scope, COUNT(*) AS n FROM records GROUP BY scope').all();
      console.log(`\n[${f.domain}] ${f.dbPath}`);
      console.log(`  records: ${n}${n ? ` — created ${range.lo} … ${range.hi}` : ''}`);
      if (n) {
        console.log(`  first: ${first.id}  last: ${last.id}`);
        console.log(`  scopes: ${byScope.map((s) => `${s.scope}=${s.n}`).join(', ')}`);
      }
    } finally {
      db.close();
    }
  }
}

function sweep() {
  const { config, storePath } = projectContext(arg('project'));
  const rootList = roots();
  // resolution universe: the project store, its mounted domain paths, and every
  // store file under the roots (mounted or stranded — that is the point).
  const universe = new Set(idsIn(storePath));
  const seenPaths = new Set([storePath]);
  for (const m of resolveDomainMounts(config)) {
    const p = POSIX(m.dbPath);
    if (!seenPaths.has(p) && existsSync(p)) {
      for (const id of idsIn(p)) universe.add(id);
      seenPaths.add(p);
    }
  }
  for (const f of storeFilesUnder(rootList)) {
    if (seenPaths.has(f.dbPath)) continue;
    for (const id of idsIn(f.dbPath)) universe.add(id);
    seenPaths.add(f.dbPath);
  }

  const db = openRO(storePath);
  let rows;
  try {
    rows = db.prepare("SELECT id, type, superseded_by FROM records WHERE superseded_by IS NOT NULL").all();
  } finally {
    db.close();
  }
  const dangling = rows.filter((r) => !universe.has(r.superseded_by));
  console.log(
    `domain-doctor sweep — ${rows.length} superseded_by pointer(s) in ${storePath}, resolved against ${seenPaths.size} store file(s)`
  );
  if (!dangling.length) {
    console.log('clean: every pointer resolves');
    return;
  }
  for (const d of dangling) {
    console.log(`DANGLING: tombstone ${d.id} (${d.type}) → superseded_by ${d.superseded_by} resolves in NO store`);
  }
  process.exit(3);
}

function restore() {
  const { config, storePath } = projectContext(arg('project'));
  const tombstoneId = arg('tombstone') ?? fail('--tombstone <id> is required');
  const domain = arg('domain') ?? fail('--domain <name> is required');
  const apply = process.argv.includes('--apply');

  const db = openRO(storePath);
  let row;
  try {
    row = db.prepare('SELECT body FROM records WHERE id = ?').get(tombstoneId);
  } finally {
    db.close();
  }
  if (!row) fail(`no record '${tombstoneId}' in ${storePath}`);
  const tombstone = JSON.parse(row.body);
  if (tombstone.status !== 'superseded' || !tombstone.superseded_by) {
    fail(`record '${tombstoneId}' is not a tombstone (status ${tombstone.status}, superseded_by ${tombstone.superseded_by ?? 'null'}) — nothing to restore from it`);
  }
  const targetId = tombstone.superseded_by;

  // refuse when the target already resolves ANYWHERE the sweep can see —
  // restoring over a live record would mint a duplicate identity.
  const rootList = roots();
  const resolvesIn = [];
  if (idsIn(storePath).has(targetId)) resolvesIn.push(storePath);
  for (const m of resolveDomainMounts(config)) {
    const p = POSIX(m.dbPath);
    if (existsSync(p) && idsIn(p).has(targetId)) resolvesIn.push(p);
  }
  for (const f of storeFilesUnder(rootList)) {
    if (idsIn(f.dbPath).has(targetId)) resolvesIn.push(f.dbPath);
  }
  if (resolvesIn.length) {
    fail(`target '${targetId}' already resolves in: ${[...new Set(resolvesIn)].join(', ')} — nothing to restore`);
  }

  const domainDb = POSIX(config.domain_paths[domain] ?? join(homedir(), '.sterling', 'domains', domain, 'sterling.db'));
  const now = new Date().toISOString();
  // content verbatim from the tombstone body; envelope rebuilt exactly as
  // knowledge_promote builds it, except the id is the DANGLING one — restoring
  // the identity the tombstone already points at, so no server-owned field on
  // the tombstone needs touching.
  const { id: _i, created_at: _c, updated_at: _u, status: _s, superseded_by: _sb, scope: _sc, links: _l, ...content } = tombstone;
  const record = {
    ...content,
    id: targetId,
    created_at: now,
    updated_at: now,
    status: 'active',
    superseded_by: null,
    scope: `domain:${domain}`,
    links: [{ rel: 'informed_by', target_id: tombstoneId }],
  };

  console.log(`restore plan: ${tombstone.type} '${targetId}' ← tombstone ${tombstoneId}`);
  console.log(`  into: ${domainDb}`);
  console.log(`  scope: domain:${domain}; provenance: informed_by ${tombstoneId}; clocks stamped ${now}`);
  if (!apply) {
    console.log('DRY-RUN: nothing written — re-run with --apply to restore');
    return;
  }
  mkdirSync(dirname(domainDb), { recursive: true });
  const store = new SterlingStore(domainDb); // lazy-creates the file, §2.3
  try {
    store.create(record); // the one validated write path — schema + indexes + FTS
  } finally {
    store.close();
  }
  console.log(`RESTORED: '${targetId}' now resolves in ${domainDb}`);
}

const mode = process.argv[2];
if (mode === 'scan') scan();
else if (mode === 'sweep') sweep();
else if (mode === 'restore') restore();
else if (mode === 'migrate') migrate();
else fail(`usage: domain-doctor.mjs scan|sweep|restore|migrate … (got '${mode ?? ''}')`);
