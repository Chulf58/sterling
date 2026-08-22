// No-capture declaration (board 7bbec3bd — H10 fires on file count, not
// substance): the conductor appends this the moment it judges that direct-mode
// work produced nothing durable to capture. H10's capture duty then treats it
// as SATISFYING the demand for every touch/debug_scope event with a timestamp
// EARLIER than this declaration; work arriving AFTER it re-arms the duty (a
// declaration cannot cover work that hasn't happened yet). detail carries the
// REASON — a false declaration is drift, not a bypass: this is an honesty
// surface, not a silencer.
//
// LANE-SCOPED (decision no-capture-discharge-is-lane-scoped,
// 51ebe0dd-099e-40a9-abc5-d3c8cc767883; USER-RULED 2026-08-22): the declaration
// discharges only the duty LANE it claims. A BARE declaration covers the
// CAPTURE lane only — exactly its pre-2026-08-22 behavior — so clearing the
// RESEARCH duty takes an explicit `--lane research` (or `--lane all`). WHY: a
// single global cutoff turned a locally-TRUE declaration ("typo fix, nothing
// durable") into a globally-FALSE one that silently cleared an unrelated
// earlier research duty, dropping the research_owed enqueue and losing the
// knowledge with no trace. An unrecognized value is REFUSED, never coerced:
// a discharge must be no broader than the claim the human actually made.
//   node scripts/no-capture.mjs --reason "<why>" [--lane research|capture|all] [--target <dir>]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { arg, fail } from './lib/project.mjs';
import { NO_CAPTURE_LANES } from '@sterling/schemas';

const reason = arg('--reason');
const target = arg('--target') ?? process.cwd();
if (!reason || !reason.trim()) {
  fail('no-capture: --reason "<why>" is required (a false declaration is drift, so say why there is nothing durable)');
}

// Presence, not value: `--lane` with a missing or unrecognized value is a
// refusal, not a silent fall-through to the bare default — a mistyped lane must
// never be read as a narrower OR a broader claim than the one intended (P5: the
// refusal names its discriminator). Absence of the flag entirely is the bare
// declaration, which H10 reads as the capture lane.
const laneGiven = process.argv.slice(2).includes('--lane');
const laneArg = arg('--lane');
if (laneGiven && (laneArg === undefined || !NO_CAPTURE_LANES.includes(laneArg))) {
  fail(
    `no-capture: --lane ${laneArg === undefined ? '(missing value)' : `'${laneArg}'`} is not a valid duty lane — use one of ${NO_CAPTURE_LANES.join(' | ')}. ` +
      `A bare declaration (no --lane) covers 'capture' only; discharging the research duty requires --lane research or --lane all. ` +
      `Nothing was written (decision no-capture-discharge-is-lane-scoped).`
  );
}
const lane = laneGiven ? laneArg : undefined;

const eventsPath = join(target, '.sterling', 'transient', 'session-events.json');
mkdirSync(dirname(eventsPath), { recursive: true });
const events = existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')) : [];
const at = new Date().toISOString();
// `lane` is omitted entirely on a bare declaration, so a bare event is
// byte-identical to a legacy pre-ruling one — one shape, one reading (capture).
events.push(lane ? { kind: 'no_capture', detail: reason, at, lane } : { kind: 'no_capture', detail: reason, at });
writeFileSync(eventsPath, JSON.stringify(events));
console.log(JSON.stringify({ declared: reason, at, lane: lane ?? 'capture (bare declaration)' }));
