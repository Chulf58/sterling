// stamp-contract's output, classified once for /sterling:update and the post-update sync (GitHub
// #329). A write or safety refusal means AGENTS.md could not be updated: a failed instruction-file
// update, never tolerated wording drift. Every other *_REFUSED action (hand-tuned text, a missing
// anchor, a duplicate) is drift, which both callers tolerate. Builtins only (bundled into hooks).

export const STAMP_FAILURE_CODES = ['WRITE_FAILED_REFUSED', 'PLANNED_AGENTS_MD_REFUSED', 'AGENTS_MD_REFUSED', 'LAYER_MARKERS_REFUSED'];
const FAILURE_LINE = new RegExp(`^\\s+(${STAMP_FAILURE_CODES.join('|')})\\s`);
const DETAIL_LINE = /^\s{6}\S/;

/**
 * The failure actions in stamp-contract output `out`, each as "CODE lead — detail". With
 * `agentsMdPath`, only the block of the project whose header names that AGENTS.md is read.
 */
export function stampFailures(out, agentsMdPath = null) {
  const lines = String(out ?? '').split('\n');
  let from = 0;
  let to = lines.length;
  if (agentsMdPath !== null) {
    const at = lines.findIndex((l) => /^[✗•] /.test(l) && l.includes(`(${agentsMdPath})`));
    if (at === -1) return [];
    from = at + 1;
    to = from;
    while (to < lines.length && /^\s/.test(lines[to])) to++;
  }
  const found = [];
  for (let i = from; i < to; i++) {
    if (!FAILURE_LINE.test(lines[i])) continue;
    found.push([lines[i].trim(), DETAIL_LINE.test(lines[i + 1] ?? '') ? lines[i + 1].trim() : ''].filter(Boolean).join(' — '));
  }
  return found;
}

/** True when stamp-contract reports that it processed no project (it checked nothing). */
export const stampProcessedNothing = (out) => /—\s*0 project\(s\) processed/.test(String(out ?? ''));
