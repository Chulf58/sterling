// Debug-scope registration (spec §6 H3 debug-scope mode, §8.3 step 6): the
// explorer's map registers as the lightweight contract for an inline debug
// play; H3 denies edits outside it. Cleared at debug capture.
//   node scripts/debug-scope.mjs register --path <p> [--path <p>...] [--target <dir>]
//   node scripts/debug-scope.mjs show|clear [--target <dir>]
import { arg, argAll, fail } from './lib/project.mjs';
import { registerDebugScope, clearDebugScope, readDebugScope } from './hooks/lib/contract.mjs';

const action = process.argv[2];
const target = arg('--target') ?? process.cwd();

if (action === 'register') {
  const paths = argAll('--path');
  if (!paths.length) fail('debug-scope register: at least one --path required (the explorer map)');
  registerDebugScope(target, paths);
  console.log(JSON.stringify({ registered: paths.length }));
} else if (action === 'clear') {
  clearDebugScope(target);
  console.log(JSON.stringify({ cleared: true }));
} else if (action === 'show') {
  console.log(JSON.stringify(readDebugScope(target)));
} else {
  fail('usage: debug-scope.mjs register --path <p>... | show | clear');
}
