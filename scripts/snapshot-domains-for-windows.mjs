// snapshot-domains-for-windows [S] (P5, AC8) — the WSL side of the
// domain-knowledge snapshot bridge. A native-Windows process cannot live-read
// the WSL-resident WAL domain stores (research_finding 5c6437d8: WAL-over-9p
// `database is locked`), so at native-launcher startup we VACUUM-INTO a snapshot
// of each WSL-resident domain store into the Windows-local default path. The
// native TUI then opens those snapshots — local NTFS, so WAL works — via P4's
// skip-missing MountedStores. Snapshots are stale-as-of-launch; the time printed
// here is the staleness indicator surfaced at launch.
//
//   node scripts/snapshot-domains-for-windows.mjs \
//        --target <projectDir> --win-domains-root <destDir>
//
// Reads <projectDir>/.sterling/config.json, resolves the project's mounted domain
// stores (honoring config.domain_paths via resolveDomainMounts — the ONE resolver
// the MCP server and dispose-run share, so the snapshotted set never drifts from
// the mounted set), and for each domain SOURCE store that EXISTS on disk,
// VACUUM-INTOs it to <destDir>/<tag>/sterling.db. A configured domain whose source
// store is absent is SKIPPED LOUDLY (reported by name, never created, never
// crashes). Exits 0 on success/partial-skip.
//
// --win-domains-root is an override that exists FOR TESTABILITY; in production the
// launcher passes the /mnt/c translation of the Windows homedir's ~/.sterling/domains.
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore, resolveDomainMounts } from '@sterling/store';
import { arg, fail } from './lib/project.mjs';

const target = arg('--target') ?? process.cwd();
const winRoot = arg('--win-domains-root');
if (!winRoot) fail('snapshot-domains-for-windows: --win-domains-root <dir> is required', 2);

// Read the project's config directly: a snapshot run only needs the domain
// manifest, NOT the project store (it may not exist on disk — the bridge is about
// the DOMAIN stores), so we never go through openProject's store guard.
const configPath = join(target, '.sterling', 'config.json');
if (!existsSync(configPath)) fail(`snapshot-domains-for-windows: no config at ${configPath} — not an initialized project`, 2);
let config;
try {
  config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
} catch (e) {
  fail(`snapshot-domains-for-windows: malformed .sterling/config.json — failing loud, never half-applying (P5): ${e.message}`, 2);
}

const mounts = resolveDomainMounts(config);
const snapshotAt = new Date().toISOString();
const snapshotted = [];
const skipped = [];

for (const { name, dbPath } of mounts) {
  // skip-missing, LOUD: a configured domain whose SOURCE store is absent is
  // reported and skipped — never created, never crashes (P4 skip-missing on the
  // read side tolerates the absent snapshot).
  if (!existsSync(dbPath)) {
    skipped.push(name);
    console.log(`  skip  ${name} — source store absent (${dbPath}); leaving its snapshot untouched`);
    continue;
  }

  const dest = join(winRoot, name, 'sterling.db');
  // SterlingStore.snapshot REFUSES to overwrite an existing target, but this step
  // runs at EVERY launch — so clear any prior snapshot (db + WAL/SHM siblings)
  // before VACUUM-INTO. This is the startup REFRESH: the new snapshot reflects the
  // latest source.
  for (const sibling of ['', '-wal', '-shm']) {
    rmSync(dest + sibling, { force: true });
  }
  mkdirSync(dirname(dest), { recursive: true });

  const src = new SterlingStore(dbPath);
  try {
    src.snapshot(dest); // VACUUM INTO — same mechanism as snapshotAll / dispose-run
  } finally {
    src.close();
  }
  snapshotted.push(name);
  console.log(`  snap  ${name} -> ${dest}`);
}

// Summary INCLUDING the snapshot time — staleness surfaced honestly at launch.
console.log(
  `snapshot-domains-for-windows: ${snapshotted.length} snapshotted` +
    (snapshotted.length ? ` [${snapshotted.join(', ')}]` : '') +
    `, ${skipped.length} skipped` +
    (skipped.length ? ` [${skipped.join(', ')}]` : '') +
    ` — as of ${snapshotAt} (snapshots are stale-as-of this time)`
);
