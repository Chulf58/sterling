// No-capture declaration (board 7bbec3bd — H10 fires on file count, not
// substance): the conductor appends this the moment it judges that direct-mode
// work produced nothing durable to capture. H10's capture duty then treats it
// as SATISFYING the demand for every touch/debug_scope event with a timestamp
// EARLIER than this declaration; work arriving AFTER it re-arms the duty (a
// declaration cannot cover work that hasn't happened yet). detail carries the
// REASON — a false declaration is drift, not a bypass: this is an honesty
// surface, not a silencer.
//   node scripts/no-capture.mjs --reason "<why>" [--target <dir>]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { arg, fail } from './lib/project.mjs';

const reason = arg('--reason');
const target = arg('--target') ?? process.cwd();
if (!reason || !reason.trim()) {
  fail('no-capture: --reason "<why>" is required (a false declaration is drift, so say why there is nothing durable)');
}

const eventsPath = join(target, '.sterling', 'transient', 'session-events.json');
mkdirSync(dirname(eventsPath), { recursive: true });
const events = existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')) : [];
const at = new Date().toISOString();
events.push({ kind: 'no_capture', detail: reason, at });
writeFileSync(eventsPath, JSON.stringify(events));
console.log(JSON.stringify({ declared: reason, at }));
