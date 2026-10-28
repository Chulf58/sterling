// List expired board claims across every project in this machine's registry (slice 4 of the
// multi-session toolkit). Read-only inspection: it never renews or takes over a claim, and it does
// not need multi_session.enabled. Each project is read in its own child process with a 5 s
// deadline; a project that times out or cannot be read is listed as degraded, never as empty.
//   node scripts/expired-claims.mjs [--json]
// Exit 0 when the read is complete (with or without expired claims), 1 when any project was degraded.
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expiredClaimsReport } from './lib/board-claims-watch.mjs';

function usage(msg) {
  console.error(`expired-claims REFUSED: ${msg}\nusage: expired-claims.mjs [--json]`);
  process.exit(2);
}

export function render(report) {
  const lines = [];
  if (report.expired.length === 0) lines.push(`no expired claims in ${report.projects_read} project(s)`);
  for (const c of report.expired) {
    lines.push(`${c.project}  ${c.id8}  ${c.label}  holder ${c.holder_session} @ ${c.checkout}  ${c.age_minutes} min since renewal (lease ${c.lease_minutes})`);
  }
  for (const d of report.degraded) lines.push(`DEGRADED ${d.project}: ${d.reason}`);
  return lines.join('\n');
}

async function main(argv) {
  let json = false;
  for (const a of argv) {
    if (a === '--json') json = true;
    else usage(`unknown argument '${a}'`);
  }
  let report;
  try {
    report = await expiredClaimsReport();
  } catch (e) {
    console.error(`expired-claims FAILED: ${e?.message ?? String(e)}`);
    process.exit(2);
  }
  console.log(json ? JSON.stringify(report, null, 2) : render(report));
  process.exit(report.degraded.length > 0 ? 1 : 0);
}

// import.meta.url is rewritten to name this scripts/ source inside the bin/ bundle (hazard
// 6b1c51f4), so the guard accepts the source and any file named expired-claims.mjs (the shipped bundle, or one built with --out-dir).
// The reader's child re-enters the launched file with --claim-reader and must not run main.
const launchedAs = process.argv[1] && resolve(process.argv[1]);
const isMain = launchedAs !== undefined && (launchedAs === fileURLToPath(import.meta.url) || basename(launchedAs) === 'expired-claims.mjs');
if (isMain && process.argv[2] !== '--claim-reader') await main(process.argv.slice(2));
