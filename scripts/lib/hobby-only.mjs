// The refusal shared by the hobby-only scripts (board 9af3fdd0, issue
// Chulf58/sterling#26 item 7): scripts/domain-doctor.mjs and
// scripts/migration-preflight.mjs do SQLite file forensics and a v1 -> v2 SQLite
// migration preflight. A work-mode project keeps its knowledge in Postgres, where
// neither has a meaning, so both refuse there before they open any store.
//
// The invoking project is the Sterling root of the cwd. A linked git worktree has
// no `.sterling/` of its own (it is gitignored), so it resolves to its main
// checkout, which holds the config. The mode is read through readProjectMode, the
// one reader: a missing config or key is hobby, an invalid value throws and is
// refused too, because the mode is never guessed.
//
// Exit code HOBBY_ONLY_EXIT (4) is distinct from the 0/2/3 both scripts already
// use for success, an unusable request and a finding.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readProjectMode } from './handoff-projection.mjs';

export const HOBBY_ONLY_EXIT = 4;

export function invokingRoot(cwd = process.cwd()) {
  if (existsSync(join(cwd, '.sterling'))) return cwd;
  const r = spawnSync('git', ['rev-parse', '--git-dir', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 30_000 });
  if (r.error || r.status !== 0) return cwd;
  const [gitDir, commonDir] = r.stdout.split('\n').map((l) => l.trim());
  if (!gitDir || !commonDir) return cwd;
  const commonReal = realpathSync(resolve(cwd, commonDir));
  if (realpathSync(resolve(cwd, gitDir)) === commonReal || basename(commonReal) !== '.git') return cwd;
  return dirname(commonReal);
}

export function refuseInWorkMode(root, scriptName) {
  let mode;
  try {
    mode = readProjectMode(root);
  } catch (e) {
    console.error(`${scriptName}: ${e.message}. ${scriptName} is hobby-only and cannot tell which mode this project is in (exit ${HOBBY_ONLY_EXIT}).`);
    process.exit(HOBBY_ONLY_EXIT);
  }
  if (mode === 'work') {
    console.error(
      `${scriptName}: hobby-only. This project is in work mode, where knowledge is stored in Postgres, ` +
        `and ${scriptName} works on SQLite store files. Nothing was opened (exit ${HOBBY_ONLY_EXIT}).`,
    );
    process.exit(HOBBY_ONLY_EXIT);
  }
}
