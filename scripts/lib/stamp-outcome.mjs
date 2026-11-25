// stamp-contract's output, classified once for /sterling:update and the post-update sync (GitHub
// #329). A write or safety refusal means AGENTS.md could not be updated: a failed instruction-file
// update, never tolerated wording drift. A project stamp-contract could not check at all (no
// AGENTS.md) fails the same way. A skipped project (a stale registry path, a Sterling source tree)
// is printed as a `– ` line and is not a failure. Every other *_REFUSED action (hand-tuned text, a
// missing anchor, a duplicate) is drift, which both callers tolerate. Builtins only (bundled into
// hooks).

export const STAMP_FAILURE_CODES = ['WRITE_FAILED_REFUSED', 'PLANNED_AGENTS_MD_REFUSED', 'AGENTS_MD_REFUSED', 'LAYER_MARKERS_REFUSED'];
/** Project statuses stamp-contract prints as `✗ <project> (<AGENTS.md path>): <status> (<detail>)`: nothing in it was checked. */
export const STAMP_UNCHECKED_STATUSES = ['not_migrated'];
const FAILURE_LINE = new RegExp(`^\\s+(${STAMP_FAILURE_CODES.join('|')})\\s`);
const UNCHECKED_LINE = new RegExp(`^✗ .*\\): (${STAMP_UNCHECKED_STATUSES.join('|')}) \\((.*)\\)$`);
const DETAIL_LINE = /^\s{6}\S/;

/**
 * The failure actions in stamp-contract output `out`, each as "CODE lead — detail", and each
 * project it could not check, as "status — detail". With `agentsMdPath`, only the block of the
 * project whose header names that AGENTS.md is read.
 */
export function stampFailures(out, agentsMdPath = null) {
  const lines = String(out ?? '').split('\n');
  let from = 0;
  let to = lines.length;
  if (agentsMdPath !== null) {
    const at = lines.findIndex((l) => /^[✗•] /.test(l) && l.includes(`(${agentsMdPath})`));
    if (at === -1) return [];
    from = at;
    to = at + 1;
    while (to < lines.length && /^\s/.test(lines[to])) to++;
  }
  const found = [];
  for (let i = from; i < to; i++) {
    const unchecked = UNCHECKED_LINE.exec(lines[i]);
    if (unchecked && (agentsMdPath === null || lines[i].includes(`(${agentsMdPath}): `))) {
      found.push(`${unchecked[1]} — ${unchecked[2]}`);
      continue;
    }
    if (!FAILURE_LINE.test(lines[i])) continue;
    found.push([lines[i].trim(), DETAIL_LINE.test(lines[i + 1] ?? '') ? lines[i + 1].trim() : ''].filter(Boolean).join(' — '));
  }
  return found;
}

/** True when stamp-contract reports that it processed no project (it checked nothing). */
export const stampProcessedNothing = (out) => /—\s*0 project\(s\) processed/.test(String(out ?? ''));
