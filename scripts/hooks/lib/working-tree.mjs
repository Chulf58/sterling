// The ONE hooks-side answer to "does this record's working_tree name a tree
// other than this project?" — shared by every hook site that decides root
// ownership (H10's article demand, H19 delivery, H23's owned-path gate, the
// delivery pointer lookup, settlement's reconcile mint) and by the delivery
// oracle that mirrors them, so no site restates the check and none can
// disagree with H10 about who owns a path.
//
// A record declaring a working_tree owns files in a DIFFERENT tree and never
// grants ownership of this root's same-named path (comsoft-juiced 2026-07-17) —
// EXCEPT a working_tree that resolves to THIS project's own root, in its Windows
// drive or WSL /mnt spelling (trailing slash and DrvFs case aside): that names
// the project itself (Dome Farmer issue entry 454; user ruling 2026-09-28
// "Code: self-root = own"). packages/mcp-server/src/tools.ts asks the same
// question in its private declaresForeignTree, through the same
// sameLocationAnyHost.
import { sameLocationAnyHost } from '@sterling/schemas';

/** True when `record` declares a working_tree that is NOT `root`. No
 *  working_tree → false (a root record). No `root` to compare against → any
 *  declared working_tree stays foreign, the pre-existing direction. */
export function isForeignTree(record, root) {
  const wt = record?.working_tree;
  if (!wt) return false;
  return !(root && sameLocationAnyHost(String(wt), root));
}
