// Stale-server guard (P5 fail-loud / P7 prevention). A running MCP server
// process older than the current built server silently serves OLD behavior —
// the domain-stores incident, where a stale server accepted domain-scoped
// writes but stored them flat, with no error. The build stamps a content-hash
// build-id beside the server entry (dist/.build-id); the server records the id
// it loaded at boot into the project's transient marker; H1 compares the two
// and warns the human loudly to restart.
//
// This module is the ONE definition (invariant 1) of the marker shape, the two
// file locations, and the comparison — shared by the server (writer, packages/
// mcp-server) and the H1 hook (reader). PURE: no fs here — callers read/write.
// The paths are real OS filesystem paths (not stored repo-relative paths), so
// node:path join/dirname is correct.
import { z } from 'zod';
import { dirname, join } from 'node:path';

/** Content build-id file, written by scripts/build-stamp.mjs beside the server
 *  entry (dist/main.js → dist/.build-id) after every build. */
export const BUILD_ID_FILE = '.build-id';

export const runtimeMarkerSchema = z
  .object({
    /** the content build-id the running server loaded at boot */
    build_id: z.string(),
    pid: z.number().int(),
    booted_at: z.string(),
  })
  .strict();
export type RuntimeMarker = z.infer<typeof runtimeMarkerSchema>;

/** The build-id sits beside the server entry: serverDir is dist/ (where main.js lives). */
export function buildIdPath(serverDir: string): string {
  return join(serverDir, BUILD_ID_FILE);
}

/** The runtime marker lives in the project's transient dir. storePath is the
 *  server's --store arg (<project>/.sterling/sterling.db); the marker sits at
 *  <project>/.sterling/transient/mcp-runtime.json. */
export function runtimeMarkerPath(storePath: string): string {
  return join(dirname(storePath), 'transient', 'mcp-runtime.json');
}

export type StalenessVerdict =
  | { state: 'fresh'; running: string; current: string }
  | { state: 'stale'; running: string; current: string }
  | { state: 'unknown' };

/**
 * STALE iff a present marker's build_id differs from the current build-id (the
 * running server predates the current dist). A missing build-id OR a missing
 * marker is UNKNOWN — never a false alarm (P1): a first boot, a timing race
 * before the server writes its marker, or a server predating this guard must
 * not be asserted stale.
 */
export function stalenessVerdict(currentBuildId: string | null, marker: RuntimeMarker | null): StalenessVerdict {
  if (!currentBuildId || !marker) return { state: 'unknown' };
  return marker.build_id === currentBuildId
    ? { state: 'fresh', running: marker.build_id, current: currentBuildId }
    : { state: 'stale', running: marker.build_id, current: currentBuildId };
}
