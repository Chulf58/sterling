// The contract stamp's verdict, classified once for /sterling:update and the post-update sync
// (GitHub #329). A write or safety refusal means AGENTS.md could not be updated: a failed
// instruction-file update, never tolerated wording drift. A project the stamper could not check at
// all (no AGENTS.md) fails the same way. A skipped project (a stale registry path, a Sterling source
// tree) is not a failure. Every other *_REFUSED action (hand-tuned text, a missing anchor, a
// duplicate) is drift, which both callers tolerate. Builtins only (bundled into hooks).
//
// /sterling:update calls the stamper in-process and reads its structured results
// (stampResultFailures). The post-update sync runs the INSTALLED copy's bin/stamp-contract.mjs
// as a child against the session's checkout, which may be an unregistered linked worktree that
// only the CLI's registry mapping reaches, so it reads the CLI's printed lines (stampFailures).

export const STAMP_FAILURE_CODES = ['WRITE_FAILED_REFUSED', 'PLANNED_AGENTS_MD_REFUSED', 'AGENTS_MD_REFUSED', 'LAYER_MARKERS_REFUSED'];
/** Project statuses stamp-contract prints as `✗ <project> (<AGENTS.md path>): <status> (<detail>)`: nothing in it was checked. */
export const STAMP_UNCHECKED_STATUSES = ['not_migrated'];
const FAILURE_LINE = new RegExp(`^\\s+(${STAMP_FAILURE_CODES.join('|')})\\s`);
const UNCHECKED_LINE = new RegExp(`^✗ .*\\): (${STAMP_UNCHECKED_STATUSES.join('|')}) \\((.*)\\)$`);
const DETAIL_LINE = /^\s{6}\S/;

/**
 * The failures in one stampProjects result (scripts/lib/stamp-projects.mjs): each failure action
 * as "CODE lead — detail", or the unchecked status as "status — reason".
 */
export function stampResultFailures(result) {
  if (STAMP_UNCHECKED_STATUSES.includes(result.status)) return [`${result.status} — ${result.reason}`];
  return result.actions.filter((a) => STAMP_FAILURE_CODES.includes(a.action)).map((a) => [`${a.action} ${a.lead}`, a.detail].filter(Boolean).join(' — '));
}

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
