// Record-hygiene check arm (board 7a75851c step 3). REPORTING ONLY: it lists what
// it finds, loudly, and ALWAYS exits 0 — it never fails the battery. Spec:
// decisions record-audit-dead-records-superseded-stale-findings-by-age-report-arm-
// plus-sampled-audit and make-records-findable-authoring-rule-disclosure-lint-then-
// blind-experiment, part 3 of each. Over every knowledge record type it reports:
//   dead_path             file_keys / files[].path / doc location absent at HEAD
//   no_file_paths         a type that carries file paths, with none
//   ac_without_test_ref   feature-article acceptance criterion with no live_test_ref
//   dead_test_path        a live_test_ref naming a test path absent at HEAD
//   shared_central_terms  records whose central-term sets are identical
//   filler_central_terms  filler words among a record's central terms
// Central terms are recordCentralTerms from packages/store/src/axis.ts.
//
//   node scripts/check-record-hygiene.mjs [root] [--all]
//
// Reads the store through openProjectReadOnly (a read-only snapshot copy): the live
// file is never opened for writing. Paths are checked against `git ls-tree HEAD` in
// root, so an uncommitted file does not count as present. Without --all each kind
// prints its first PRINT_CAP details; the counts are always complete.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { openProjectReadOnly } from './lib/project.mjs';
import { auditRecords, AUDITED_TYPES } from './lib/record-hygiene.mjs';

const PRINT_CAP = 10;
const args = process.argv.slice(2);
const showAll = args.includes('--all');
const root = args.find((a) => !a.startsWith('--')) ?? join(dirname(fileURLToPath(import.meta.url)), '..');

// A reporting arm never fails the battery, including when a shared helper calls
// process.exit(1) on a malformed config or unreadable store: force the exit code
// to 0 and say so.
process.on('exit', (code) => {
  if (code !== 0) console.log(`record hygiene: could not run (a helper exited ${code}, see above) — REPORTING ONLY, exit code forced to 0`);
  process.exitCode = 0;
});

function main() {
  if (!existsSync(join(root, '.sterling', 'sterling.db'))) {
    console.log('record hygiene: skipped (no store)');
    return;
  }
  const tree = spawnSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], {
    cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024,
  });
  if (tree.status !== 0) {
    console.log(`record hygiene: could not run (git ls-tree HEAD failed in '${root}': ${(tree.stderr ?? '').trim()}) — REPORTING ONLY, exit code unaffected`);
    return;
  }
  const headFiles = new Set(tree.stdout.split('\0').filter(Boolean));

  const { store, close } = openProjectReadOnly(root);
  let records;
  try {
    records = store.query({ types: AUDITED_TYPES, cap: 1_000_000 });
  } finally {
    close();
  }
  if (records.length === 0) {
    console.log('record hygiene: skipped (project store holds no knowledge records — a consumer clone)');
    return;
  }

  const { scanned, findings } = auditRecords(records, { headFiles });
  const byKind = new Map();
  for (const f of findings) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind).push(f);
  }
  const counts = [...byKind].map(([k, v]) => `${k}=${v.length}`).join(' ');
  if (findings.length === 0) {
    console.log(`record hygiene: 0 finding(s) across ${scanned} record(s) — REPORTING ONLY, exit code unaffected`);
    return;
  }
  console.log(`record hygiene: ${findings.length} finding(s) across ${scanned} record(s) — REPORTING ONLY, exit code unaffected`);
  console.log(`  ${counts}`);
  for (const [kind, list] of byKind) {
    console.log(`  [${kind}] ${list.length}`);
    for (const f of showAll ? list : list.slice(0, PRINT_CAP)) console.log(`    ${f.detail}`);
    if (!showAll && list.length > PRINT_CAP) console.log(`    ... ${list.length - PRINT_CAP} more (--all prints every one)`);
  }
}

try {
  main();
} catch (e) {
  console.log(`record hygiene: could not run (${e?.message ?? e}) — REPORTING ONLY, exit code unaffected`);
}
