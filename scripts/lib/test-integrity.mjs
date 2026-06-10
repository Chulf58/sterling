// Test-integrity (spec §6 H10, §9.2): the fix loop can never weaken its own
// oracle. Pipeline mode: frozen baseline written at the red check, compared at
// per-phase completeness. Direct mode: current test files vs git HEAD.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchesGlob } from '@sterling/schemas';

const sha = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

function baselinePath(runDir, phaseId) {
  return join(runDir, `test-baseline-${phaseId}.json`);
}

/** Written at the red check: the phase's frozen oracle. */
export function writeBaseline({ cwd, runDir, phaseId, testFiles }) {
  const entries = testFiles.map((file) => ({ file: file.replace(/\\/g, '/'), hash: sha(readFileSync(join(cwd, file), 'utf8')) }));
  const p = baselinePath(runDir, phaseId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ phase_id: phaseId, frozen_at: new Date().toISOString(), entries }));
  return entries.length;
}

/** Compared at per-phase completeness: modified or deleted baseline tests = integrity violations. */
export function compareBaseline({ cwd, runDir, phaseId }) {
  const p = baselinePath(runDir, phaseId);
  if (!existsSync(p)) return { baseline_missing: true, modified: [], deleted: [] };
  const baseline = JSON.parse(readFileSync(p, 'utf8'));
  const modified = [];
  const deleted = [];
  for (const entry of baseline.entries) {
    const full = join(cwd, entry.file);
    if (!existsSync(full)) deleted.push(entry.file);
    else if (sha(readFileSync(full, 'utf8')) !== entry.hash) modified.push(entry.file);
  }
  return { baseline_missing: false, modified, deleted };
}

/** Direct mode (§8.2): test files changed vs git HEAD. */
export function gitTestIntegrity({ cwd, testGlobs }) {
  const r = spawnSync('git', ['diff', 'HEAD', '--name-status'], { cwd, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) return { no_git: true, modified: [], deleted: [] };
  const modified = [];
  const deleted = [];
  for (const line of (r.stdout ?? '').trim().split('\n').filter(Boolean)) {
    const [status, file] = line.split(/\t/);
    const rel = (file ?? '').replace(/\\/g, '/');
    if (!testGlobs.some((g) => matchesGlob(rel, g))) continue;
    if (status.startsWith('D')) deleted.push(rel);
    else if (status.startsWith('M')) modified.push(rel);
    // additions are new tests — fine
  }
  return { no_git: false, modified, deleted };
}
