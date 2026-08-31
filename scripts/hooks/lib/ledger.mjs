// H13 reads ledger (spec §6 H13): transient, lifecycle-bound (P4).
// pipeline -> <project>/.sterling/runs/<run-id>/reads/agent-<id>.json (dies with the run dir)
// direct   -> <project>/.sterling/transient/conductor-reads.json
//
// EVIDENCE EXPIRES WITH THE FILE, NOT THE PROMPT (board 776d2b65): entries
// carry the file's content hash at read time, and H3 accepts one only while
// the current bytes still match — the gate's purpose is read-before-edit
// FRESHNESS, and "the file changed" is the truth that per-prompt clearing only
// approximated (at the cost of ~7 forced re-reads of byte-current files in one
// measured session). Hashless legacy entries keep the old per-prompt window:
// h19-delivery-drain prunes exactly those at each UserPromptSubmit (folded in
// from h13-clear-conductor, decision 04982f45). Context
// The two cases a hash cannot vouch for get an explicit clear in H1:
// SessionStart source=compact (compaction can drop a read from the model's
// window with the bytes unchanged — the old per-prompt clear never covered
// this either) and source=startup|clear (a new session has read nothing, so a
// dead session's hashed entries must not vouch for it).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

export function ledgerPath(cwd, runId, agentId) {
  if (runId && agentId) return join(cwd, '.sterling', 'runs', runId, 'reads', `agent-${agentId}.json`);
  if (agentId) return join(cwd, '.sterling', 'transient', 'reads', `agent-${agentId}.json`);
  return join(cwd, '.sterling', 'transient', 'conductor-reads.json');
}

// SELF-HEALING (caught live 2026-08-20): two concurrent PostToolUse:Read hook
// processes raced this file's read-modify-write on a DrvFs mount and tore it —
// a valid array followed by fragment bytes. An unguarded JSON.parse then threw
// inside H3's evidence check on EVERY Edit, bricking the agent repo-wide, and
// appendRead died on the same throw before it could ever overwrite the tear.
// The ledger is re-derivable evidence (worst case: H3 asks for a re-Read), so
// the degrade is salvage-the-leading-array, else empty — never a crash. Entries
// are flat objects, so the array's first ']' is its closing bracket.
export function readLedger(path) {
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

export function appendRead(path, entry) {
  const entries = readLedger(path);
  entries.push(entry);
  mkdirSync(dirname(path), { recursive: true });
  // tmp+rename: a concurrent writer can still lose an entry (last rename wins,
  // costing one re-Read), but no interleaving can tear the file itself.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(entries));
  renameSync(tmp, path);
}

export function hasRead(path, repoRelPath) {
  return readLedger(path).some((e) => e.path === repoRelPath);
}

/** sha256 of the file's current bytes; undefined when unreadable (deleted, permission). */
export function fileHash(absPath) {
  try {
    return createHash('sha256').update(readFileSync(absPath)).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Read-evidence with FRESHNESS (board 776d2b65): a hashed entry counts only
 * while the file's current bytes still match its read-time hash; a hashless
 * (legacy) entry counts unconditionally — it lives inside the old per-prompt
 * window, because h19-delivery-drain prunes exactly those at each prompt
 * (folded in from h13-clear-conductor, decision 04982f45).
 */
export function hasFreshRead(path, repoRelPath, absPath) {
  return readLedger(path).some((e) => {
    if (e.path !== repoRelPath) return false;
    if (!e.sha256) return true;
    return e.sha256 === fileHash(absPath);
  });
}

/** Drop hashless legacy entries; hashed entries expire by content, not by prompt. */
export function pruneUnhashed(path) {
  if (!existsSync(path)) return;
  const kept = readLedger(path).filter((e) => e.sha256);
  if (kept.length) writeFileSync(path, JSON.stringify(kept));
  else rmSync(path);
}

export function clearLedger(path) {
  if (existsSync(path)) rmSync(path);
}

/**
 * Whether the ledger file's RAW bytes are TORN — present, non-empty, and not
 * valid JSON (board c7b81456, the same 2026-08-20 race documented above:
 * concurrent PostToolUse:Read hooks interleaved two appendRead writes).
 * readLedger() already SALVAGES a torn file (leading array, else empty) so a
 * consumer never throws — but that silent recovery is exactly why a torn
 * ledger's resulting "no evidence" denial reads like ordinary "you never read
 * it" misconduct: the entries are just gone, and nothing said so. This lets a
 * caller (H3's evidenceDenial) tell the two apart before wording the denial.
 */
export function isLedgerTorn(path) {
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return false;
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}
