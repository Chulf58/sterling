// scripts/lib/debug-scope.mjs — debug-scope registration (register / read /
// clear). The registered map is observation and capture metadata only: it arms
// H10's capture duty through scripts/debug-scope.mjs's register event and never
// refuses an edit or a file operation (decision
// debug-scope-is-metadata-fs-helpers-stop-refusing, which removed the scope
// check fs-remove and fs-move used to run against it).
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function debugScopePath(cwd) {
  return join(cwd, '.sterling', 'transient', 'debug-scope.json');
}

export function readDebugScope(cwd) {
  const p = debugScopePath(cwd);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export function registerDebugScope(cwd, paths) {
  const p = debugScopePath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ paths: paths.map((x) => x.replace(/\\/g, '/')), registered_at: new Date().toISOString() }));
}

export function clearDebugScope(cwd) {
  rmSync(debugScopePath(cwd), { force: true });
}
