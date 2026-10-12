// Shared gate for the check arms whose verdict compares Sterling's COMMITTED
// files against the local knowledge store (GitHub issues #84 and #86): the
// record-citation check and the projection-freshness check.
//
// Those files are minted on the AUTHORING machine's store. A consumer clone
// holds its own store, which cannot judge them, so failing there aborted
// /sterling:update at its check step on every rerun. When the checked root IS
// the clone the calling script ships in, only machine_role 'authoring'
// enforces; 'consumer' and undeclared report in full and pass. Every OTHER
// project root (a consuming project run through sterling-check) keeps plain
// enforcement: init never writes machine_role there, and that project's own
// store minted what its tree holds.
import { realpathSync } from 'node:fs';

// Returns null when the arm must enforce, else { roleText } for the reason
// line: the checked root is the Sterling clone itself and this machine is not
// declared authoring.
export function nonAuthoringSelfRoot(root, selfRoot, config) {
  if (realpathSync(root) !== realpathSync(selfRoot)) return null;
  const role = config?.machine_role;
  if (role === 'authoring') return null;
  return { roleText: role === undefined ? 'machine_role undeclared' : `machine_role=${role}` };
}
