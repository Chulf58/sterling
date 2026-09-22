// H13's read ledger has been deleted (scale-down decision sterling-claude-code-scale-down-boundary,
// 2ad87dd1) along with the H3 evidence-gate it fed. This file now carries only
// the two exports h19-delivery-drain still needs: ledgerPath (path derivation)
// and pruneUnhashed (drop hashless legacy entries at UserPromptSubmit). The
// read/write/hash/freshness machinery that supported H3's evidence check
// (readLedger's tear-salvage, appendRead, hasRead, hasFreshRead, fileHash,
// clearLedger, isLedgerTorn) died with H13/H3/H25.
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function ledgerPath(cwd, runId, agentId) {
  if (runId && agentId) return join(cwd, '.sterling', 'runs', runId, 'reads', `agent-${agentId}.json`);
  if (agentId) return join(cwd, '.sterling', 'transient', 'reads', `agent-${agentId}.json`);
  return join(cwd, '.sterling', 'transient', 'conductor-reads.json');
}

// Internal: same tear-salvage as the deleted readLedger export (board c7b81456) —
// pruneUnhashed must not throw on a torn file either.
function readLedgerEntries(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    try {
      const salvaged = JSON.parse(raw.slice(0, raw.indexOf(']') + 1));
      return Array.isArray(salvaged) ? salvaged : [];
    } catch {
      return [];
    }
  }
}

/** Drop hashless legacy entries; hashed entries expire by content, not by prompt. */
export function pruneUnhashed(path) {
  if (!existsSync(path)) return;
  const kept = readLedgerEntries(path).filter((e) => e.sha256);
  if (kept.length) writeFileSync(path, JSON.stringify(kept));
  else rmSync(path);
}
