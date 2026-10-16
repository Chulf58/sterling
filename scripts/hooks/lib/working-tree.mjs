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
//
// A NAME MAPPED in config.working_trees resolves to its mapped path first —
// absolute as given, relative joined onto the root — exactly as the MCP
// server's treeRootFor does (decision a0fc8743), so a name mapped to the root
// owns root paths at every hook site as it already does on the server (GitHub
// issues #112, #115). Every caller passes the project's working_trees; a site
// that only knows the root reads them with workingTreesAt.
import { join } from 'node:path';
import { isAbsolutePathAnyHost, sameLocationAnyHost } from '@sterling/schemas';
import { loadConfig } from './common.mjs';

/** True when `record` declares a working_tree that is NOT `root`. No
 *  working_tree → false (a root record). A name mapped in `workingTrees`
 *  compares by its resolved path; an unmapped one by its own spelling. No
 *  `root` to compare against → any declared working_tree stays foreign, the
 *  pre-existing direction. */
export function isForeignTree(record, root, workingTrees) {
  const wt = record?.working_tree;
  if (!wt) return false;
  if (!root) return true;
  const mapped = workingTrees && Object.hasOwn(workingTrees, wt) ? String(workingTrees[wt]) : undefined;
  const location = mapped === undefined ? String(wt) : isAbsolutePathAnyHost(mapped) ? mapped : join(root, mapped);
  return !sameLocationAnyHost(location, root);
}

/** The project's config.working_trees map ({} when unset). A corrupt
 *  config.json throws, as loadConfig does at every other read. */
export function workingTreesAt(root) {
  const trees = root ? loadConfig(root)?.working_trees : undefined;
  return trees && typeof trees === 'object' ? trees : {};
}

/** The ownership filter every hook site applies: keeps a record unless it
 *  names a foreign tree. Reads config.working_trees once per call. */
export function ownsHere(root, workingTrees = workingTreesAt(root)) {
  return (record) => !isForeignTree(record, root, workingTrees);
}
