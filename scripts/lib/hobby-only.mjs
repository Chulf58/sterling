// The refusal shared by the SQLite-only scripts (board 9af3fdd0, issue
// Chulf58/sterling#26 item 7): scripts/domain-doctor.mjs and
// scripts/migration-preflight.mjs do SQLite file forensics and a v1 -> v2 SQLite
// migration preflight. A project whose config.storage is 'postgres' keeps its
// knowledge there, where neither has a meaning, so both refuse before they open
// any store. The verdict is config.storage in any project mode (decision
// sterling-repo-is-hobby-mode-on-served-postgres-as-the-test-project: mode only
// picks the shipping flow, so a hobby project can be on Postgres).
//
// The invoking project is the Sterling root of the cwd. A linked git worktree has
// no `.sterling/` of its own (it is gitignored), so it resolves to its main
// checkout, which holds the config. The storage is read through readProjectStorage, the
// one reader: a missing config or key is sqlite, an invalid value or an unreadable
// config throws and is refused too, because the storage is never guessed.
//
// Exit code HOBBY_ONLY_EXIT (4) is distinct from the 0/2/3 both scripts already
// use for success, an unusable request and a finding.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readProjectStorage } from './handoff-projection.mjs';

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

export function refuseOnPostgresStorage(root, scriptName) {
  let storage;
  try {
    storage = readProjectStorage(root);
  } catch (e) {
    console.error(`${scriptName}: ${e.message}. ${scriptName} works on SQLite store files and cannot tell which storage this project uses (exit ${HOBBY_ONLY_EXIT}).`);
    process.exit(HOBBY_ONLY_EXIT);
  }
  if (storage === 'postgres') {
    console.error(
      `${scriptName}: refused. This project's config.storage is 'postgres', so its knowledge is stored in Postgres, ` +
        `and ${scriptName} works on SQLite store files. Nothing was opened (exit ${HOBBY_ONLY_EXIT}).`,
    );
    process.exit(HOBBY_ONLY_EXIT);
  }
}
