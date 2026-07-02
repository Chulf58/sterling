// Debug-scope registration (spec §6 H3 debug-scope mode, §8.3 step 6): the
// explorer's map registers as the lightweight contract for an inline debug
// play; H3 denies edits outside it. Cleared at debug capture.
//   node scripts/debug-scope.mjs register --path <p> [--path <p>...] [--target <dir>]
//   node scripts/debug-scope.mjs show|clear [--target <dir>]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { arg, argAll, fail } from './lib/project.mjs';
import { registerDebugScope, clearDebugScope, readDebugScope } from './hooks/lib/contract.mjs';

const action = process.argv[2];
const target = arg('--target') ?? process.cwd();

if (action === 'register') {
  const paths = argAll('--path');
  if (!paths.length) fail('debug-scope register: at least one --path required (the explorer map)');
  registerDebugScope(target, paths);

  // Append a debug_scope event to the session-event register (interface slice 1,
  // run r-0501). detail carries the registered scope as a comma-joined list.
  const eventsPath = join(target, '.sterling', 'transient', 'session-events.json');
  mkdirSync(dirname(eventsPath), { recursive: true });
  const events = existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')) : [];
  events.push({ kind: 'debug_scope', detail: paths.join(', '), at: new Date().toISOString() });
  writeFileSync(eventsPath, JSON.stringify(events));

  console.log(JSON.stringify({ registered: paths.length }));
} else if (action === 'clear') {
  clearDebugScope(target);
  console.log(JSON.stringify({ cleared: true }));
} else if (action === 'show') {
  console.log(JSON.stringify(readDebugScope(target)));
} else {
  fail('usage: debug-scope.mjs register --path <p>... | show | clear');
}
