// Debug-scope registration (skills/debug): the scout's map of the code a debug
// play touches is registered as observation and capture metadata — it arms
// H10's capture duty and never refuses an operation (decision
// debug-scope-is-metadata-fs-helpers-stop-refusing). Cleared at debug capture.
//   node scripts/debug-scope.mjs register --path <p> [--path <p>...] [--target <dir>]
//   node scripts/debug-scope.mjs show|clear [--target <dir>]
import { join } from 'node:path';
import { arg, argAll, fail } from './lib/project.mjs';
import { registerDebugScope, clearDebugScope, readDebugScope } from './lib/debug-scope.mjs';
import { appendSessionEventsAt, SESSION_EVENTS_LOCK_HELD } from './hooks/lib/session-events.mjs';

const action = process.argv[2];
const target = arg('--target') ?? process.cwd();

if (action === 'register') {
  const paths = argAll('--path');
  if (!paths.length) fail('debug-scope register: at least one --path required (the explorer map)');
  registerDebugScope(target, paths);

  // Append a debug_scope event to the session-event register (interface slice 1,
  // run r-0501). detail carries the registered scope as a comma-joined list.
  const eventsPath = join(target, '.sterling', 'transient', 'session-events.json');
  try {
    appendSessionEventsAt(eventsPath, [{ kind: 'debug_scope', detail: paths.join(', '), at: new Date().toISOString() }]);
  } catch (e) {
    // Issue #64: a held lock skips the write, named, and never writes unlocked.
    if (e.code === SESSION_EVENTS_LOCK_HELD) fail(`debug-scope register: the scope was registered but its debug_scope session event was NOT: ${e.message}`);
    throw e;
  }

  console.log(JSON.stringify({ registered: paths.length }));
} else if (action === 'clear') {
  clearDebugScope(target);
  console.log(JSON.stringify({ cleared: true }));
} else if (action === 'show') {
  console.log(JSON.stringify(readDebugScope(target)));
} else {
  fail('usage: debug-scope.mjs register --path <p>... | show | clear');
}
