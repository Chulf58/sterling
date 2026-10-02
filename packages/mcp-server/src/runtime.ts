// Stale-server guard (P5/P7): record which build this server process is running
// so H1 can detect a server older than the current dist (the domain-stores
// incident). FAIL-OPEN throughout — the marker is a diagnostic; nothing here may
// block server boot. The build-id and marker shapes/paths are the ONE definition
// in @sterling/schemas, shared with the H1 reader.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildIdPath, runtimeMarkerPath, runtimeMarkerSchema, type RuntimeMarker } from '@sterling/schemas';

/**
 * Read the build-id beside the server entry (serverDir/.build-id), fail-open to
 * 'unknown', and write {build_id, pid, booted_at} to the project's transient
 * marker (<project>/.sterling/transient/mcp-runtime.json). Returns the marker,
 * or null if the write itself failed (never throws — boot continues regardless).
 */
export function recordRuntimeMarker(
  storePath: string,
  serverDir: string,
  now: () => string = () => new Date().toISOString()
): RuntimeMarker | null {
  try {
    let buildId = 'unknown';
    try {
      const raw = readFileSync(buildIdPath(serverDir), 'utf8').trim();
      if (raw) buildId = raw;
    } catch {
      // no .build-id (unbuilt tree, or a build predating the stamp step) → 'unknown';
      // stalenessVerdict treats unknown as no-alarm, so this never false-warns.
    }
    const marker = runtimeMarkerSchema.parse({ build_id: buildId, pid: process.pid, booted_at: now() });
    const markerPath = runtimeMarkerPath(storePath);
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, JSON.stringify(marker));
    return marker;
  } catch {
    return null; // diagnostic only — a stale-marker write must never sink the server
  }
}
