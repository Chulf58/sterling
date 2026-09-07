// The ONE MountedStores test harness for the mcp-server package: a genuine
// project store plus N mounted domain stores, driven through the same real
// SterlingTools surface the conductor drives. Extracted verbatim (2026-09-06)
// from the three per-file copies that had drifted apart —
// resolves-append-join.test.ts's `harnessMounted`, knowledge-extract.test.ts's
// `domainHarness`, and domain-routing.test.ts's `harness` — so a mount-boundary
// pin lands on shared ground instead of a per-file fake.
//
// Use it ONLY where the pin is about the PHYSICAL project/domain store
// boundary; a plain project-only SterlingStore harness stays the right tool
// everywhere that boundary is not the point.
//
// packages/store/src/tests/mounted.test.ts deliberately keeps its OWN local
// harness and is not a caller: it tests MountedStores one level down, with no
// SterlingTools/config layer, and packages/store cannot depend on SterlingTools
// without a circular dependency.
//
// TWO PROPERTIES THIS HELPER MUST NOT CHANGE, because call sites assert on them:
//  1. LAZY-CREATE SEMANTICS ARE MountedStores' OWN. The constructor is called
//     with the default options (no `skipMissing`), so every mounted domain db
//     is materialized BY THE MOUNT (mounted.ts `open()` → mkdirSync + open),
//     exactly as before. This helper never pre-touches, stats, or otherwise
//     materializes a domain file itself — `domainDbPath()` is pure path
//     arithmetic and opens nothing.
//  2. THE CLOCK IS THE CALLER'S. `now` is REQUIRED (no default) and `domains`
//     takes no default, so no call site can silently inherit another file's
//     frozen timestamp or another file's mount directory name.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { MountedStores } from '@sterling/store';
import { SterlingTools } from '../../tools.js';

export interface MountedHarnessOptions {
  /** The frozen clock this file's tests were written against. Required — a
   *  shared default is exactly how one suite silently adopts another's time. */
  now: string;
  /** mkdtemp prefix, so a leaked temp dir still names its suite. */
  prefix?: string;
}

export interface MountedHarness {
  dir: string;
  store: MountedStores;
  tools: SterlingTools;
  /** Path arithmetic only — resolves the mount path for a domain name without
   *  opening or creating anything. */
  domainDbPath: (name: string) => string;
  cleanup: () => void;
}

export function harnessMounted(domains: string[], opts: MountedHarnessOptions): MountedHarness {
  const dir = mkdtempSync(join(tmpdir(), opts.prefix ?? 'sterling-mounted-'));
  const domainDbPath = (name: string) => join(dir, 'domains', name, 'sterling.db');
  const mounts = domains.map((name) => ({ name, dbPath: domainDbPath(name) }));
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), mounts);
  const config = parseConfig({ stack_tags: domains });
  const tools = new SterlingTools({ store, config, now: () => opts.now, newId: randomUUID });
  return {
    dir,
    store,
    tools,
    domainDbPath,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
