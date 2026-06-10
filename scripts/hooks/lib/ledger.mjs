// H13 reads ledger (spec §6 H13): transient, lifecycle-bound (P4).
// pipeline -> <project>/.sterling/runs/<run-id>/reads/agent-<id>.json (dies with the run dir)
// direct   -> <project>/.sterling/transient/conductor-reads.json (cleared on every UserPromptSubmit)
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function ledgerPath(cwd, runId, agentId) {
  if (runId && agentId) return join(cwd, '.sterling', 'runs', runId, 'reads', `agent-${agentId}.json`);
  if (agentId) return join(cwd, '.sterling', 'transient', 'reads', `agent-${agentId}.json`);
  return join(cwd, '.sterling', 'transient', 'conductor-reads.json');
}

export function readLedger(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
}

export function appendRead(path, entry) {
  const entries = readLedger(path);
  entries.push(entry);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries));
}

export function hasRead(path, repoRelPath) {
  return readLedger(path).some((e) => e.path === repoRelPath);
}

export function clearLedger(path) {
  if (existsSync(path)) rmSync(path);
}
