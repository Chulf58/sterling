// H17 — dual-mode Bash write-sweep (v3.1 hardened hybrid). Decision 2422e76a.
// Registered on the coder frontmatter's Bash PreToolUse (baseline snapshot) AND
// PostToolUse (verify + restore). Closes the H14 `node --test <writer>` arbitrary
// -write bypass (decision f404dfb4): after an agent Bash command it detects any
// write to
//   (A) TRACKED files — via `git status --porcelain -z` (HEAD-anchored restore);
//       a VIOLATION iff isEnforcementSurface(rel) || matchesGlob(rel,'hooks/**')
//       OR (run+brief resolvable AND scopeCheck({brief,rel}).deny);
//   (B) the gitignored BASELINE set — `.claude/agents/**` + `.sterling/config.json`
//       + `.claude/settings*.json` (v3.1; NOT sterling.db), snapshotted Pre to
//       os.tmpdir()/sterling-enforce-<runId>.json and diffed Post.
// v3.1 UNIVERSAL FAIL-CLOSED: during an active agent run ANY unexpected error
// (missing/corrupt baseline, restore fs-error, store/git throw, brief-unresolvable)
// DENIES (exit 2), NEVER a non-blocking exit 1. Non-deny only: no agent_id
// (conductor) → allow; no active run (L2) → baseline + always-set (surface|hooks/**).
// v3.2 (decision h17-stamp-honor-loud-restore, 4d9b76e8): FIX-A — before an
// (A) tracked restore for a path NOT dirty at Pre, a FRESH stamp match on the
// file's CURRENT bytes exempts it (no restore, no deny). FIX-B — every ACTUAL
// (A) restore mints one deduped restore_performed maintenance item per path,
// fail-open, only after the restore succeeded. A store that cannot be opened/
// resolved no longer skips the (A) restore sweep entirely — it is deferred
// (captured, not thrown) so the tracked-restore + mint attempt still run on
// what git alone can tell it, and the original deny still fires after.
// v3.3 (decision h17-pre-state-snapshot-closes-false-denial-not-the-restore-
// hole, 7021526c): Pre also snapshots per-path STATE for everything git reports
// dirty, into a PER-CALL record keyed by sha256(tool_use_id), and Post COMPARES
// it. A pre-dirty path therefore no longer denies merely for being dirty —
// (1) state UNCHANGED -> allow, verified by OBSERVATION, no stamp consulted;
// (2) CHANGED -> the fresh stamp is consulted per path against the CURRENT
// state (4d9b76e8's rule is general) -> exact match allows; (3) otherwise deny.
// NEITHER arm restores: a pre-image restore across overlapping Bash windows
// would clobber a concurrent lane's legitimate write (board 0b848342 finding 1,
// deliberately deferred). No usable tool_use_id -> DEGRADED-LOUD: today's
// blanket pre-existing denial, naming tool_use_id as the reason, never a
// silent per-run key (which would let one lane adopt another's tampered bytes).
// v3.4 (two independent reviews of v3.3, all five findings adjudicated REAL):
// (1) FAIL-CLOSED HOLE — Post iterated only the CURRENT git status, so a path
// dirty at Pre and CLEAN at Post was never visited (`git checkout HEAD -- <hook>`
// destroyed conductor work and exited 0); the sweep set is now the UNION of the
// current status and the RECORDED pre-dirty set, in both the compared and the
// degraded path (whose blanket denial a command could otherwise empty by
// cleaning files). (2) A STAMP ATTESTS BYTES, NOT STATE — a {path, sha256} /
// {path, deleted:true} entry cannot express a mode, a type, a link target or an
// index entry, so the stamp is consulted on a changed pre-dirty path ONLY when
// the difference is confined to bytes (or the absent state). (3) NO STAMP-SIDE
// LINK FOLLOWING — every stamp read is lstat-guarded; a path that is not a
// regular file is unattested, and a symlink is never a directory. (4) RECORD
// VALUES are shape-validated and the lookup is a Map (a missing `children` key
// no longer compares equal to an empty directory; a `__proto__` key cannot
// install an inherited state). (5) RESOURCE SHAPE — the record stores a
// per-path raw-byte sha256 instead of base64 bytes (717 KB measured live), and
// the index query is chunked and --literal-pathspecs.
// v3.5 (board 128fedb7): EVERY write/create/delete/restore primitive guards its
// ANCESTOR path components (assertRealAncestors), not just its final one —
// guarding the leaf is not enough when a PARENT can be a link, because mkdir
// -p, a recursive rmSync and `git checkout -- <path>` all resolve the whole
// string first. The (B) delete arm and the (A) tracked restore, previously
// unguarded, now take the same walk the (B) read/write side already took; the
// (B) delete also lost its `recursive` flag (its keys are only ever regular
// files). Disposition on ANY ancestor/type ambiguity: DENY WITHOUT RESTORING.
// Still racing by construction (lstat-then-act); that residual is accepted and
// tracked at board 6c1e0890, not closed here.
// v3.6 (board 11609d1f): the (B) CONTENT BASELINE is keyed PER BASH CALL —
// sterling-enforce-<tag>-<runId>-call-<sha256(tool_use_id)>.baseline.json — the
// same laundering fix 7021526c applied to the (A) STATE record, because a
// run-keyed baseline is one file every concurrent lane overwrites: lane B's Pre
// landing after lane A's tamper made both Posts compare the tamper against
// itself, and on the (B) side the adopted pre-image is then WRITTEN back. Post
// consumes and unlinks the per-call baseline (P4). No usable tool_use_id keeps
// the legacy per-run file — the only way today's no-tool_use_id platforms keep
// working — and the fallback is DISCLOSED ON EVERY PATH (reviewer F1): a
// non-fatal stderr line fires the moment the shared baseline is used, allow path
// included, because the laundering it admits compares EQUAL and would otherwise
// pass silently; the deny path additionally names the (B) writes it applied to.
// Never a silent fallback to a per-run key.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { matchesGlob } from '@sterling/schemas';
import { readStdin, allow, deny, openStore, withRetry, environmentDefectDenial } from './lib/common.mjs';
import { scopeCheck, isEnforcementSurface } from './lib/contract.mjs';

// The (B) gitignored baseline set (v3.1: settings*.json added — the gitignored
// settings.local.json is enforcement surface but git is blind to it).
const BASELINE_GLOBS = ['.claude/agents/**', '.sterling/config.json', '.claude/settings*.json'];
const NO_RUN = 'no-run'; // L2 baseline-file discriminator when no active run

// The baseline path is PROJECT-UNIQUE (audit finding 7/43): two concurrent
// Sterling sessions in different projects previously shared os.tmpdir()/
// sterling-enforce-<runId>.json — and with runId='no-run' (a machine-wide
// constant outside runs) project B's Pre snapshot could overwrite project A's,
// so A's Post restored A's enforcement files from B's bytes. A sha256 prefix of
// the realpath'd cwd discriminates projects; realpath so WSL/symlink aliasing
// can't split a Pre/Post pair (both hooks pass the same input.cwd).
function projectTag(cwd) {
  let root = cwd;
  try {
    root = realpathSync(cwd);
  } catch {
    /* cwd unreadable — fall back to the raw path (still project-distinguishing) */
  }
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

// KEYED PER BASH CALL when the platform gives us a usable tool_use_id (board
// 11609d1f), for exactly the reason the (A) STATE record already is (7021526c
// binding 2, AC14): a run-keyed baseline is ONE FILE SHARED BY EVERY CONCURRENT
// LANE and each Pre OVERWRITES it, so lane A's Pre snapshots a clean file, lane
// A's command tampers, lane B's Pre lands before lane A's Post and overwrites
// the shared baseline with the TAMPERED state, and both Posts then compare the
// tamper against itself and allow it. On the (B) side that is worse than a
// missed denial: this is the branch that RESTORES BY WRITING FILE CONTENT, so
// an adopted-tamper baseline turns the guard into a writer of
// attacker-influenced bytes.
// THE FILENAME DELIBERATELY DOES NOT COLLIDE WITH THE (A) STATE RECORD'S
// (`…-<runId>-call-<hex>.json`): two files cannot share one path, and the (A)
// record is identified BY that exact shape, so the (B) baseline carries a
// further `.baseline` token — `…-<runId>-call-<hex>.baseline.json`.
// A NULL KEY IS NOT A SILENT FALL BACK: it returns the legacy per-run name, and
// the fallback is disclosed on EVERY path — a non-fatal stderr line the moment
// the shared baseline is used, allow path included, plus a named part in any
// denial the (B) writes compose (see `baselineShared` at Post). Keeping the legacy name for the degraded case —
// rather than refusing to verify (B) at all — is what preserves today's
// behaviour for a platform that does not carry tool_use_id, and the disclosure
// is what stops that fallback from being invisible.
function baselineFile(cwd, runId, key) {
  const tag = projectTag(cwd);
  return join(tmpdir(), key ? `sterling-enforce-${tag}-${runId}-call-${key}.baseline.json` : `sterling-enforce-${tag}-${runId}.json`);
}

// The (A) attribution record (decision f76d7c5c): which TRACKED paths were
// already dirty before this command ran. A SEPARATE file rather than a field on
// the (B) baseline, deliberately — the baseline's key-validation loop is the most
// security-critical code in this hook and adding a field would force a change to
// it (smallest safe implementation).
// KEYED PER BASH CALL when the platform gives us a usable tool_use_id (board
// 489554d4), for exactly the reason the (A) STATE record (7021526c) and the (B)
// content baseline (11609d1f) already are: a run-keyed attribution record is ONE
// FILE SHARED BY EVERY CONCURRENT LANE and each Pre OVERWRITES it. The DESTRUCTIVE
// laundering direction here is worse than a missed denial — if lane B's Pre lands
// after lane A's Pre and OMITS a path that was genuinely dirty at lane A's Pre
// (because B's command already cleaned or reverted it, or simply raced), lane A's
// Post reads the overwritten record, finds NO covering pre-dirty entry, falls to
// the clean-at-Pre arm and HEAD-restores (DELETES) that pre-existing dirty path:
// real conductor work destroyed, the harm class of board 7dd39b85.
// THE FILENAME DELIBERATELY DOES NOT COLLIDE WITH EITHER OTHER PER-CALL RECORD:
// the (A) STATE record is `…-<runId>-call-<hex>.json` and the (B) baseline is
// `…-<runId>-call-<hex>.baseline.json`, so this attribution record carries its
// own `.dirty` token — `…-<runId>-call-<hex>.dirty.json`. Two files cannot share
// one path, and a `-call-<hex>.dirty` middle segment is not all-hex, so it can
// never be mistaken for the STATE record's `-call-<hex>.json` name.
// A NULL KEY IS NOT A SILENT FALL BACK: it returns the legacy per-run name (the
// only way today's no-tool_use_id platforms keep working), and Post discloses the
// shared-record exposure LOUDLY on every path (see `attributionShared`). Never a
// silent fallback to a per-run key.
function dirtyFile(cwd, runId, key) {
  const tag = projectTag(cwd);
  return join(tmpdir(), key ? `sterling-enforce-${tag}-${runId}-call-${key}.dirty.json` : `sterling-enforce-${tag}-${runId}.dirty.json`);
}

/** Repo-relative paths of everything git reports as changed, Pre-snapshot shape. */
function dirtyTrackedRels(cwd) {
  const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '-z'], { encoding: 'utf8' });
  if (status.error || status.status !== 0) {
    throw new Error(`git status --porcelain -z failed (status ${status.status}: ${status.stderr || status.error})`);
  }
  const rels = [];
  for (const entry of parsePorcelainZ(status.stdout)) {
    for (const p of entry.paths) {
      const rel = p.replace(/\/+$/, '');
      if (rel) rels.push(rel);
    }
  }
  return rels;
}

// ---------------------------------------------------------------------------
// The (A) PER-CALL Pre-STATE record (decision h17-pre-state-snapshot-closes-
// false-denial-not-the-restore-hole, 7021526c). The paths-only record above let
// Post see only THAT a path was dirty at Pre, never whether the audited command
// touched it — which is the whole (and only) warrant for the blanket
// pre-existing denial. This record carries each dirty path's STATE so Post can
// compare, and the denial's warrant dissolves for a path it can verify itself.
// ---------------------------------------------------------------------------

// KEYED PER BASH CALL, never per run: if lane B's Pre lands after lane A's
// command already tampered, a shared per-run record adopts the tampered bytes
// as B's baseline and Post A then compares them against themselves and ALLOWS a
// real tamper. sha256 of the platform's tool_use_id is the per-call
// discriminator. Returns null when the id is UNUSABLE — absent, not a string,
// or empty/whitespace (a presence check would hash a constant, i.e. a per-run
// key under another name, reopening exactly that false allow). A null key is a
// degraded-LOUD fallback at the call site, never a silent per-run key.
function callKey(toolUseId) {
  if (typeof toolUseId !== 'string') return null;
  const trimmed = toolUseId.trim();
  if (!trimmed) return null;
  return createHash('sha256').update(trimmed).digest('hex').slice(0, 32);
}

function stateFile(cwd, runId, key) {
  return join(tmpdir(), `sterling-enforce-${projectTag(cwd)}-${runId}-call-${key}.json`);
}

// Current INDEX entries (`mode:oid:stage`, conflict stages joined) for the given
// repo-relative paths, as a Map path -> string. Its own term in the comparison
// because a staged-index-only change (`git add`) moves nothing in the worktree:
// bytes, type and mode all still compare equal, and the porcelain XY code can be
// held constant, so without this term the change is invisible. Any git failure
// throws -> AC9 fail-closed.
function indexEntriesFor(cwd, rels) {
  const map = new Map();
  if (!rels.length) return map;
  const staged = new Map();
  // CHUNKED + --literal-pathspecs (review finding 5, resource shape): one
  // spawn carrying every dirty path can exceed the OS argument limit (E2BIG)
  // on a large dirty set, and a guard that dies of E2BIG dies OUTSIDE its own
  // fail-closed control flow, where AC9 cannot reach it. --literal-pathspecs
  // so a dirty filename containing pathspec magic (a leading ':' or a glob
  // metacharacter) is treated as a PATH and cannot widen or narrow what the
  // index query reports. A git failure in ANY chunk still throws -> AC9 deny.
  const CHUNK_ARGS = 256;
  const CHUNK_CHARS = 32 * 1024;
  for (let i = 0; i < rels.length; ) {
    const chunk = [];
    let chars = 0;
    while (i < rels.length && chunk.length < CHUNK_ARGS && chars < CHUNK_CHARS) {
      chars += rels[i].length + 1;
      chunk.push(rels[i++]); // at least one per chunk — a single huge path still progresses
    }
    const r = spawnSync('git', ['-C', cwd, '--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...chunk], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) {
      throw new Error(`git ls-files --stage -z failed (status ${r.status}: ${r.stderr || r.error})`);
    }
    for (const tok of (r.stdout || '').split('\0')) {
      if (!tok) continue;
      const tab = tok.indexOf('\t');
      if (tab < 0) throw new Error(`git ls-files --stage -z produced an unparseable entry ('${tok.slice(0, 60)}')`);
      const p = tok.slice(tab + 1);
      const list = staged.get(p) ?? [];
      list.push(tok.slice(0, tab).trim().replace(/\s+/g, ':')); // "<mode> <oid> <stage>" -> "mode:oid:stage"
      staged.set(p, list);
    }
  }
  for (const [p, list] of staged) map.set(p, list.sort().join(','));
  return map;
}

// One path's STATE. "State" is deliberately NOT bytes alone: each term below is
// an escape a bytes-only comparison would miss and today's blanket denial does
// catch — a mode flip with identical bytes; a regular file replaced by a symlink
// whose target holds identical bytes; a symlink re-pointed at another
// identical-content target; a staged-index-only change. BYTES ARE CARRIED AS A
// RAW-BYTE SHA-256, never as base64 and never as a UTF-8 string (review finding
// 5): the comparison only ever needs EQUALITY, and the bytes themselves existed
// solely for a pre-image restore that decision 7021526c puts explicitly out of
// scope — while base64 made the record grow with the size of the dirt (717 KB
// measured live, ~5.6 MB for one 4 MiB dirty file), so a big enough dirty tree
// could OOM or time out the guard OUTSIDE its own fail-closed control flow. The
// digest is over the WHOLE file's RAW bytes, never a prefix and never a decoded
// string: two different invalid-UTF-8 sequences decode to the same U+FFFD, so a
// text snapshot is lossy exactly where tampering hides, and a raw-byte digest
// keeps that escape visible. A symlink's target is read with readlink and NEVER
// followed. An unsupported file type (fifo, socket, device) throws -> AC9
// fail-closed, never a silent "unchanged".
function pathState(cwd, rel, idx) {
  const abs = join(cwd, rel);
  const index = idx.get(rel) ?? null;
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false, index };
    throw e; // any OTHER lstat error is unverifiable -> AC9 fail-closed
  }
  const mode = st.mode & 0o7777; // PERMISSION bits only; the type is its own term
  if (st.isSymbolicLink()) return { exists: true, type: 'symlink', mode, index, target: readlinkSync(abs) };
  if (st.isFile()) return { exists: true, type: 'file', mode, index, sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') };
  if (st.isDirectory()) {
    // An untracked directory reaches the sweep as its COLLAPSED path (`?? dir/`),
    // so comparing the directory alone would let a write to a file inside it pass
    // as unchanged. Recurse: every child is a state of its own. NULL-PROTOTYPE:
    // a child literally named `__proto__` must be an ordinary key here, never a
    // prototype write (the same hazard review finding 4(b) names on the record's
    // own lookup).
    const children = Object.create(null);
    for (const name of readdirSync(abs)) {
      const childRel = `${rel}/${name}`;
      children[childRel] = pathState(cwd, childRel, idx);
    }
    return { exists: true, type: 'dir', mode, index, children };
  }
  throw new Error(`unsupported file type at '${rel}' — cannot snapshot its state, so this command's writes are unverifiable`);
}

// Term-by-term equality. Each term is checked SEPARATELY and observably (never
// folded into one opaque digest) so that a defect in any single term is
// diagnosable — and so the mutation battery this slice is verified by can tell
// the terms apart. Anything unrecognized is NOT equal (fail-closed).
function sameState(a, b) {
  if (!isStateObject(a) || !isStateObject(b)) return false;
  if (a.exists !== b.exists) return false; // EXISTENCE
  if (a.index !== b.index) return false; // INDEX ENTRY (stage, mode, blob OID)
  if (!a.exists) return true;
  if (a.type !== b.type) return false; // FILE TYPE
  if (a.mode !== b.mode) return false; // MODE
  if (a.type === 'symlink') return a.target === b.target; // SYMLINK TARGET (readlink)
  if (a.type === 'file') return a.sha256 === b.sha256; // BYTES (raw-byte sha256, whole file)
  if (a.type === 'dir') {
    // NO `?? {}` FALLBACK (review finding 4(a)): reading a missing children map
    // as an empty object made a recorded directory state that OMITS `children`
    // compare EQUAL to a really-empty directory, so emptying a dirty untracked
    // enforcement directory passed as "unchanged". A shape that cannot be
    // compared is NOT equal (fail-closed); the record loader rejects it outright.
    if (!isStateObject(a.children) || !isStateObject(b.children)) return false;
    const ak = ownKeys(a.children).sort();
    const bk = ownKeys(b.children).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
      if (!sameState(a.children[ak[i]], b.children[bk[i]])) return false;
    }
    return true;
  }
  return false;
}

function isStateObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function ownKeys(o) {
  return Object.keys(o).filter((k) => Object.prototype.hasOwnProperty.call(o, k));
}

// The EXACT field set a per-path state carries, per shape (board 1f4b7af0 item
// 3). pathState emits precisely these and nothing else, so any own field
// outside the set is a crafted shape — an absent state carrying a type/mode/
// digest, a file carrying stray `children`/`target`, a directory carrying a
// `sha256`. An unexpected field is refused so validation is EXACT rather than
// merely "the required fields are present" (AC12/AC14: an unexpected shape
// denies).
const STATE_FIELDS = {
  absent: ['exists', 'index'],
  file: ['exists', 'type', 'mode', 'index', 'sha256'],
  symlink: ['exists', 'type', 'mode', 'index', 'target'],
  dir: ['exists', 'type', 'mode', 'index', 'children'],
};

// Returns a reason when `v` carries any OWN field outside `allowed`, else null.
function strayFieldError(v, allowed, where) {
  for (const k of ownKeys(v)) {
    if (!allowed.includes(k)) return `'${where}' carries an unexpected field '${k}' (allowed for this shape: ${allowed.join(', ')})`;
  }
  return null;
}

// Per-path VALUE validation for the Pre-STATE record (review finding 4). The
// loader used to validate only the top-level object and its KEYS, so any value
// shape at all was trusted by the comparison — and two shapes then compared
// EQUAL that must not: a directory state with no `children` key (read as `{}`)
// matched a really-empty directory. Returns null when the value is a state this
// comparison can speak for, or a human-readable reason when it is not; an
// unexpected shape DENIES (AC12: "an absent or unparseable record denies
// fail-closed" — a per-path value that is malformed is unparseable in every
// sense that matters). Child keys are validated for containment exactly like
// top-level keys, so a crafted child path cannot smuggle a traversal in.
function stateShapeError(cwd, v, where) {
  if (!isStateObject(v)) return `'${where}' is not a state object`;
  if (typeof v.exists !== 'boolean') return `'${where}' has no boolean 'exists'`;
  if (!(v.index === null || typeof v.index === 'string')) return `'${where}' has a non-string, non-null 'index'`;
  if (!v.exists) return strayFieldError(v, STATE_FIELDS.absent, where); // absence carries existence + index and NOTHING else
  if (v.type !== 'file' && v.type !== 'symlink' && v.type !== 'dir') return `'${where}' has an unrecognized 'type' (${JSON.stringify(v.type)})`;
  if (!Number.isInteger(v.mode) || v.mode < 0 || v.mode > 0o7777) return `'${where}' has an invalid 'mode' (${JSON.stringify(v.mode)})`;
  if (v.type === 'file') {
    if (typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256)) return `'${where}' is a file with no sha256 digest`;
    return strayFieldError(v, STATE_FIELDS.file, where);
  }
  if (v.type === 'symlink') {
    if (typeof v.target !== 'string') return `'${where}' is a symlink with no string 'target'`;
    return strayFieldError(v, STATE_FIELDS.symlink, where);
  }
  // NOTE: an EMPTY `children` map is deliberately NOT rejected here. A gitlink /
  // submodule (index mode 160000) whose worktree directory is dirty produces a
  // genuine `{exists:true,type:'dir',...,children:{}}` at the top level, so a
  // non-empty requirement would false-DENY a real snapshot. The crafted
  // empty-children pair stays in the forged-record class accepted by 2422e76a.
  if (!isStateObject(v.children)) return `'${where}' is a directory with no explicit 'children' object`;
  const stray = strayFieldError(v, STATE_FIELDS.dir, where);
  if (stray) return stray;
  for (const k of ownKeys(v.children)) {
    if (!validateStateKey(cwd, k)) return `'${where}' carries a child key that is not a repo-relative path inside the project ('${k}')`;
    const bad = stateShapeError(cwd, v.children[k], k);
    if (bad) return bad;
  }
  return null;
}

// WHAT A STAMP CAN ATTEST (review finding 2). A stamp entry is only
// {path, sha256} or {path, deleted:true} (decision 4d9b76e8) — it structurally
// cannot express a MODE, a file TYPE, a symlink TARGET or the git INDEX entry.
// Decision 7021526c step 2 says the stamp is consulted against the CURRENT
// STATE, so a state difference the stamp cannot speak for falls to step 3 and
// DENIES without any consult: otherwise a chmod-only change, or a `git add`
// that moves only the index, or a regular file swapped for a symlink leaves the
// bytes identical, matches the stamp, and is wrongly allowed. Returns true only
// when the difference between the recorded and current state is confined to
// what a byte hash (or a {deleted:true} entry) can attest.
function stampCouldAttest(recorded, current) {
  if (!isStateObject(recorded) || !isStateObject(current)) return false;
  if (recorded.index !== current.index) return false; // INDEX: unattestable
  if (!current.exists) return recorded.exists === true; // present -> absent: {path, deleted:true}
  if (!recorded.exists) return false; // absent -> present: an existence flip, unattestable
  if (recorded.type !== current.type) return false; // TYPE: unattestable
  if (recorded.mode !== current.mode) return false; // MODE: unattestable
  if (current.type === 'file') return true; // only the bytes can still differ
  if (current.type === 'symlink') return false; // link TARGET: unattestable
  if (current.type === 'dir') {
    // A directory attests through its child FILES (stampAttestsDirectory walks
    // what is there NOW), so a child that was ADDED or REMOVED leaves nothing
    // for the walk to attest — fail closed on any change to the child key set,
    // and require every differing child to be bytes-only in the same sense.
    if (!isStateObject(recorded.children) || !isStateObject(current.children)) return false;
    const ak = ownKeys(recorded.children);
    const bk = ownKeys(current.children);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(current.children, k)) return false;
      const a = recorded.children[k];
      const b = current.children[k];
      if (sameState(a, b)) continue;
      if (!stampCouldAttest(a, b)) return false;
    }
    return true;
  }
  return false;
}

// Validate a per-call record key BEFORE the record is trusted: repo-relative
// POSIX only, no absolute path, no drive prefix, no NUL, no `..` traversal, and
// containment under the project root PROVEN by resolution. The record is not a
// restore source in this slice and must never become one by accident — same
// posture as validateBaselineKey (AC10), and the same reasoning: the audited
// agent can write arbitrary bytes into os.tmpdir(), so a crafted record is
// conduct, not environment.
function validateStateKey(cwd, key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  if (key.includes('\0')) return null;
  const fwd = key.replace(/\\/g, '/');
  if (fwd.startsWith('/') || /^[A-Za-z]:/.test(fwd)) return null; // absolute / drive prefix
  if (fwd.split('/').includes('..')) return null; // traversal
  const root = resolve(cwd);
  const abs = resolve(root, fwd);
  if (abs !== root && !abs.startsWith(root + sep)) return null; // containment
  return fwd;
}

// ANCESTOR-AWARE MEMBERSHIP in the recorded pre-dirty set (board 7dd39b85).
// `git status --porcelain` COLLAPSES an untracked directory into ONE entry
// (`?? hooks/newdir/`), so the recorded set holds `hooks/newdir` and never a
// single one of its children. An EXACT-match membership test therefore read a
// child that the audited command merely STAGED (`git add -A` gives the child
// its own `A  hooks/newdir/a.mjs` porcelain entry) as a write BY this command:
// it took the clean-at-Pre arm and — the child not being in HEAD — was DELETED,
// destroying the conductor's brand-new untracked enforcement file and blaming
// the agent for it. Coverage is computed HERE, per swept path, and deliberately
// NOT by expanding the recorded set into every child at Pre: that unbounded
// enumeration is the resource shape review finding 5 removed, and bringing it
// back would let a big dirty tree kill the guard OUTSIDE its own fail-closed
// control flow, where AC9 cannot reach it. Returns the recorded path COVERING
// `rel` (`rel` itself when it is recorded), or null when nothing covers it.
function coveringPreDirtyPath(preDirty, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  if (preDirty.has(rel)) return rel; // exact match first — today's test, unchanged
  // Only a well-formed repo-relative POSIX path may be climbed: '', '.', a
  // leading or trailing '/', or an empty segment would produce prefixes that
  // mean the REPO ROOT, and a "recorded root" would cover — i.e. exempt from
  // restore — every path in the tree. Refuse them rather than give them root
  // semantics. (`split('/').includes('')` catches all four at once.)
  if (rel === '.' || rel.split('/').includes('')) return null;
  // Walk up on '/' BOUNDARIES only. A bare `startsWith` is precisely the bug to
  // avoid: `hooks/newdir2/x` must NOT be covered by a recorded `hooks/newdir`.
  // `i > 0` so the loop can never manufacture '' (the repo root) as a candidate.
  for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) {
    const candidate = rel.slice(0, i);
    if (preDirty.has(candidate)) return candidate;
  }
  return null;
}

// The state RECORDED at Pre for a path covered by (but not equal to) a recorded
// pre-dirty ancestor. `pathState` keys a directory's `children` map by FULL
// repo-relative child paths at EVERY level (`${rel}/${name}`, see pathState),
// so this descends from the ancestor's recorded state along the successive path
// PREFIXES of `rel` — `hooks/newdir/sub`, then `hooks/newdir/sub/deep.mjs`.
// Returns the recorded state; returns null when the recorded children map has
// NO ENTRY for the path (the caller treats that as RECORDED-ABSENT, never as
// "this command created it"); THROWS when the recorded topology disagrees with
// the path being resolved — a non-directory node en route means the record
// cannot speak for this path at all, which is unverifiable -> AC9 fail-closed,
// the same posture as the record-disagreement throw in the sweep below.
function recordedDescendantState(ancestorState, ancestor, rel) {
  let node = ancestorState;
  let at = ancestor;
  let i = ancestor.length; // rel[i] is the '/' boundary right after the ancestor
  while (i < rel.length) {
    if (!isStateObject(node) || node.type !== 'dir' || !isStateObject(node.children)) {
      throw new Error(
        `per-call Pre-STATE record has '${at}' as a NON-DIRECTORY while resolving '${rel}' under the recorded pre-dirty path '${ancestor}' — ` +
          `the recorded topology and the swept path disagree, so this command's writes cannot be told from pre-existing ones`
      );
    }
    const next = rel.indexOf('/', i + 1);
    const childKey = next === -1 ? rel : rel.slice(0, next);
    // hasOwnProperty, never a bare `in` or a truthiness test: the record is
    // JSON-parsed agent-writable data, and an INHERITED entry must never
    // satisfy the lookup (finding 4(b), the same hazard the top-level Map
    // closes). An absent OWN entry returns null — a distinct outcome from a
    // recorded state, decided by the caller, never silently "unchanged".
    if (!Object.prototype.hasOwnProperty.call(node.children, childKey)) return null;
    node = node.children[childKey];
    at = childKey;
    i = next === -1 ? rel.length : next;
  }
  return node;
}

// What a path IS, WITHOUT ever following a link (review finding 3). 'absent' is
// kept distinct from 'error' so a stamped deletion attests only on a genuine
// ENOENT — an EACCES must never read as "gone, as attested".
function lstatKind(abs) {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isFile()) return 'file';
    if (st.isDirectory()) return 'dir';
    return 'other'; // fifo, socket, device: never attestable, never a directory
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'absent' : 'error';
  }
}

// LSTAT, not stat (review finding 3): a symlink is NEVER a directory for this
// purpose, so a link pointing at a directory can never route the stamp consult
// into a recursive walk outside the repo.
function isDirectoryAt(cwd, rel) {
  return lstatKind(join(cwd, rel)) === 'dir';
}

// The stamp's entries, as { present, entries }. `entries` is null whenever the
// stamp cannot be used (absent, not a JSON array, or — review finding 3 — not a
// REGULAR FILE: the stamp is read through lstat too, so
// .sterling/transient/enforcement-stamp.json cannot be a symlink pointing the
// consult at bytes outside the repo). `present` keeps the existing message
// distinction between "no stamp at all" and "a stamp that attests nothing".
// A parse error propagates to the caller's fail-closed catch, unchanged.
function readStamp(cwd) {
  const stampPath = join(cwd, '.sterling', 'transient', 'enforcement-stamp.json');
  const kind = lstatKind(stampPath);
  if (kind !== 'file') return { present: kind !== 'absent', entries: null };
  const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
  return { present: true, entries: Array.isArray(stamp) ? stamp : null };
}

// One path's CURRENT bytes hashed for a stamp comparison — only ever for a
// REGULAR FILE (review finding 3). Returns null for anything else, so the
// consult can never hash THROUGH a symlink: the attack that closes is replacing
// a stamped enforcement file with a link to an out-of-repo file holding the
// stamped bytes, which the hook loader would then execute from outside every
// sweep's reach.
function sha256OfRegularFile(abs) {
  if (lstatKind(abs) !== 'file') return null;
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

function toRel(cwd, abs) {
  return relative(cwd, abs).replace(/\\/g, '/');
}

// Classify EVERY path COMPONENT of a (B)-relative path, from the repo root
// down, by lstat — before any read, walk, or write touches it (board 8b53dc84,
// round 2 outside-family review). Checking only the final joined path (or only
// the entries a readdirSync happens to enumerate) is NOT enough: path
// resolution still FOLLOWS an INTERMEDIATE symlink component when the OS
// resolves the rest of the string — lstat refuses to follow only the LAST
// component. A `.sterling` replaced by a symlink to an outside directory still
// let `.sterling/config.json` resolve THROUGH it, on both the read and the
// restore write, when only the final component was ever lstat-checked.
// This walks segment-by-segment, extending the path ONLY after the PRIOR
// segment is confirmed a real directory (never a symlink): by induction, every
// path this function ever hands to lstat has zero symlinks in its
// already-verified prefix, so the OS cannot follow one on the way to the
// segment being checked. `cwd` (the repo root) is the TRUST ANCHOR and is
// never itself lstat'd — the walk starts at its first-level children.
// Returns the FINAL segment's lstat kind ('file' | 'dir' | 'absent'); throws
// on the first symlink or other non-regular kind found at ANY component,
// intermediate or final — so a directory is always classified BEFORE it is
// walked or listed, never interleaved with the walk itself.
// OUT OF SCOPE (boarded separately, 6c1e0890): the check/use TOCTOU between
// this classification and the read/write that follows — a descriptor-based
// O_NOFOLLOW open is a platform-parity design question (Windows included).
// `what` names the surface in the refusal so one walk can serve the (B) read,
// the (B) restore write, the (B) delete arm and the (A) tracked restore
// without four copies of the most security-critical loop in this hook.
function classifyPathComponents(cwd, rel, what = '(B) baseline') {
  const segments = rel.split('/');
  let abs = cwd;
  let soFar = '';
  for (let i = 0; i < segments.length; i++) {
    abs = join(abs, segments[i]);
    soFar = soFar ? `${soFar}/${segments[i]}` : segments[i];
    const kind = lstatKind(abs);
    if (kind === 'absent') return 'absent'; // nothing further to resolve — not a violation
    if (i === segments.length - 1) return kind;
    if (kind !== 'dir') {
      throw new Error(
        `${what} path component '${soFar}' (an ancestor of '${rel}') is not a directory (lstat kind: ${kind}) — refusing to read/walk/write ` +
          `through it; a symlink or other non-regular ancestor is denied on sight, never followed`
      );
    }
  }
  return 'absent'; // unreachable — rel is always non-empty
}

// THE ANCESTOR GUARD EVERY WRITE, CREATE, DELETE AND RESTORE PRIMITIVE TAKES
// FIRST (board 128fedb7). Guarding the FINAL component is not enough when a
// PARENT can be a link: `mkdirSync(dirname(abs), {recursive:true})` traverses
// every ancestor, `rmSync(abs, {recursive:true})` resolves the whole string
// before it starts deleting, and `git checkout HEAD -- <rel>` writes wherever
// the resolved path lands — so a symlink planted at `.claude`, `.sterling`, or
// any directory inside a normal `hooks/`/`.claude/agents` tree re-aims the
// primitive OUTSIDE the repository even when the leaf lstat is clean.
// THE DISPOSITION IS THE SETTLED CHEAP ONE, not descriptor-based no-follow I/O:
// on ANY type ambiguity in the ancestor chain this THROWS, which reaches the
// caller's fail-closed catch and DENIES WITHOUT RESTORING — the same answer the
// (A) side already settled on for attribution ambiguity (decision
// h17-coverage-is-ancestor-aware-and-an-ambiguous-descendant-denies-without-
// restoring): removing the write from the ambiguous case entirely rather than
// trying to make it safe. This check STILL RACES with the primitive that
// follows it (lstat-then-write is not atomic); that residual is knowingly
// accepted and tracked separately (board 6c1e0890) — an lstat guard shrinks the
// window, only an O_NOFOLLOW descriptor closes it, and that is a Windows-parity
// design question this slice deliberately does not open.
// Returns the IMMEDIATE PARENT's own kind ('dir' when it is already there,
// 'absent' when the primitive may create it fresh — nothing to follow yet);
// throws on anything else, and on the first non-directory component above it.
function assertRealAncestors(cwd, rel, what) {
  const segments = rel.replace(/\/+$/, '').split('/');
  const ancestorRel = segments.slice(0, -1).join('/');
  if (!ancestorRel) return 'dir'; // a repo-root child: the root is the trust anchor, never lstat'd
  const kind = classifyPathComponents(cwd, ancestorRel, what);
  if (kind !== 'dir' && kind !== 'absent') {
    throw new Error(
      `${what}: refusing to act on '${rel}' — its ancestor '${ancestorRel}' is not a directory (lstat kind: ${kind}); a symlink or other ` +
        `non-regular ancestor is never created through, written through, deleted through or restored through`
    );
  }
  return kind;
}

// Snapshot every existing (B)-set file as { repoRelPath -> raw bytes, base64 }.
// LSTAT-GUARDED AT EVERY LEVEL, ancestors included (board 8b53dc84): the old
// walk used existsSync/statSync/readFileSync, which all FOLLOW a symlink — a
// symlink planted at a (B) path was read through at Pre (baseline capture
// out-of-repo content as the file's own) and a symlink to a DIRECTORY under
// .claude/agents/** was walked into (readdirSync/statSync following it),
// enumerating a tree outside the repository. This function is called from
// BOTH Pre (whose caller denies immediately on throw, PHASE: PRE — a
// non-regular (B) path predates the command and is an environment defect)
// and Post-as-"current" (whose throw reaches the same fail-closed catch
// BEFORE any restore write is attempted, PHASE: POST — a kind transition
// across the window is conduct) — one code path governs both instead of two
// guards that could drift apart. `classifyPathComponents` is consulted for
// EVERY (B) surface root — '.claude/agents', '.claude', '.sterling/config.json'
// — BEFORE that root is walked or listed (round-2 finding: '.claude/agents'
// must never be walked before '.claude' itself is classified). Descendants
// beneath an already-classified root are still classified per-entry via
// readdirSync's Dirent (which reflects the entry's own lstat kind, never a
// symlink target's), so a symlink is denied on sight and never opened at any
// depth. Bytes are stored as base64 of the RAW file bytes (never a decoded
// utf8 string): two different invalid-UTF-8 sequences can decode to the same
// U+FFFD text, so a string snapshot is lossy exactly where tampering hides.
function collectBaseline(cwd) {
  const map = {};
  const walkDir = (absDir, relDir) => {
    // Belt-and-suspenders per-recursion recheck (Codex delta re-review):
    // callers classify `absDir` via classifyPathComponents before the FIRST
    // call, but every RECURSIVE call already trusts the parent's own Dirent
    // classification (`de.isDirectory()`) alone. Re-lstat `absDir` itself
    // here too — narrows the TOCTOU window between that Dirent read and this
    // readdirSync, even though closing it fully is the boarded, out-of-scope
    // item (6c1e0890): this recheck cannot eliminate a race, only shrink it.
    const kind = lstatKind(absDir);
    if (kind === 'absent') return; // raced away between classification and here — nothing to snapshot, not a violation
    if (kind !== 'dir') {
      throw new Error(
        `(B) baseline path '${relDir}' is not a directory (lstat kind: ${kind}) — refusing to read through it; a symlink or other non-regular ` +
          `entry standing in for a (B) directory is denied on sight, never followed`
      );
    }
    for (const de of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, de.name);
      const rel = relDir ? `${relDir}/${de.name}` : de.name;
      if (de.isSymbolicLink()) {
        throw new Error(
          `(B) baseline path '${rel}' is a symlink — refusing to read through it (it may point outside the repository); denied on sight, never followed`
        );
      }
      if (de.isDirectory()) {
        walkDir(abs, rel);
      } else if (de.isFile()) {
        map[toRel(cwd, abs)] = readFileSync(abs).toString('base64');
      } else {
        throw new Error(`(B) baseline path '${rel}' is not a regular file or directory (unsupported type) — refusing to read it`);
      }
    }
  };

  // .claude/agents/** (recursive) — '.claude' AND '.claude/agents' are BOTH
  // classified, component by component, BEFORE any readdirSync ever touches
  // either of them (round-2 finding (b): walking 'agents' before classifying
  // '.claude' let an out-of-repo traversal happen before the denial).
  const agentsKind = classifyPathComponents(cwd, '.claude/agents');
  if (agentsKind === 'dir') {
    walkDir(join(cwd, '.claude', 'agents'), '.claude/agents');
  } else if (agentsKind !== 'absent') {
    throw new Error(`'.claude/agents' is not a directory (lstat kind: ${agentsKind}) — refusing to read/walk through it; denied on sight, never followed`);
  }

  // .claude/settings*.json (top level only) — '.claude' classified before it
  // is listed.
  const claudeKind = classifyPathComponents(cwd, '.claude');
  if (claudeKind === 'dir') {
    for (const de of readdirSync(join(cwd, '.claude'), { withFileTypes: true })) {
      const rel = '.claude/' + de.name;
      if (!matchesGlob(rel, '.claude/settings*.json')) continue;
      if (!de.isFile()) {
        throw new Error(
          `(B) baseline path '${rel}' is not a regular file (lstat kind: ${de.isSymbolicLink() ? 'symlink' : 'other'}) — refusing to read through it; ` +
            `denied on sight, never followed`
        );
      }
      map[rel] = readFileSync(join(cwd, rel)).toString('base64');
    }
  } else if (claudeKind !== 'absent') {
    throw new Error(`'.claude' is not a directory (lstat kind: ${claudeKind}) — refusing to read the (B) baseline surface through it`);
  }

  // .sterling/config.json — every component ('.sterling' AND 'config.json')
  // classified before the file is read (round-2 finding (a): a '.sterling'
  // symlink to an outside directory previously resolved straight through to
  // whatever 'config.json' sat there).
  const cfgRel = '.sterling/config.json';
  const cfgKind = classifyPathComponents(cwd, cfgRel);
  if (cfgKind === 'file') {
    map[cfgRel] = readFileSync(join(cwd, cfgRel)).toString('base64');
  } else if (cfgKind !== 'absent') {
    throw new Error(`(B) baseline path '${cfgRel}' is not a regular file (lstat kind: ${cfgKind}) — refusing to read through it; denied on sight, never followed`);
  }
  return map;
}

// Validate a baseline key: repo-relative POSIX + matches a (B) glob; reject
// traversal / absolute. Returns the normalized rel or null (a bad key → no write).
function validateBaselineKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  const fwd = key.replace(/\\/g, '/');
  if (fwd.startsWith('/') || /^[A-Za-z]:/.test(fwd)) return null; // absolute
  if (fwd.split('/').includes('..')) return null; // traversal
  if (!BASELINE_GLOBS.some((g) => matchesGlob(fwd, g))) return null;
  return fwd;
}

// The restore's OWN write primitive (board 8b53dc84, ROUND 2 — folds in board
// 4d7d188d) — the serious half of the defect: a plain writeFileSync to a path
// currently occupied by a symlink FOLLOWS it, landing baseline bytes on a
// destination the agent chose, outside the repository; and
// mkdirSync(dirname(abs), {recursive:true}) creates directories THROUGH an
// existing symlinked ANCESTOR exactly the same way. Guarded here with its own
// component-by-component classification (`classifyPathComponents`, ancestors
// AND the final segment), deliberately SEPARATE from collectBaseline's
// read-side scan above (which already denies before this is ever reached in
// the ordinary flow, since a kind transition makes "current" throw first) — a
// write primitive that can be aimed is worse than one that can merely be
// evaded, so it is never trusted to be safe only because an earlier scan said
// so. `content` is base64 of the raw bytes to restore (collectBaseline's own
// encoding), decoded back to a Buffer so the write is byte-exact.
function writeUnder(cwd, rel, content) {
  const abs = join(cwd, rel);
  // Every ancestor directory must be real (never a symlink) BEFORE mkdirSync
  // or writeFileSync touches any of them — see assertRealAncestors, which
  // throws on the first non-directory component and whose return value here is
  // the immediate parent's own kind ('dir' already there, or 'absent' so
  // mkdirSync creates it fresh — safe, nothing to follow yet).
  assertRealAncestors(cwd, rel, `(B) baseline restore of '${rel}'`);
  // The FINAL component's own kind — by the ancestor check above, every
  // component of `abs` up to but not including this final segment is already
  // confirmed a real directory, so this lstat cannot be fooled by an
  // intermediate symlink either.
  const kind = lstatKind(abs);
  if (kind !== 'file' && kind !== 'absent') {
    throw new Error(
      `refusing to restore (B) baseline path '${rel}': the existing entry is not a regular file (lstat kind: ${kind}) — a symlink or other ` +
        `non-regular entry is never written through by a restore`
    );
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.from(content, 'base64'));
}

// The (B) sweep's DELETE primitive (board 128fedb7 site 2) — a delete aimed the
// same way writeUnder can be aimed, and previously the only (B) primitive with
// no guard of its own: `rmSync(join(cwd, rel), {recursive:true, force:true})`
// resolves the WHOLE path before it deletes, so a linked ancestor pointed the
// recursive delete at a tree outside the repository. collectBaseline's own
// no-follow walk denies before this is normally reached, but a primitive that
// can be AIMED is never trusted to be safe only because an earlier scan said so
// (the reasoning writeUnder already carries).
// Two narrowings, both deliberate:
//   * `recursive` is GONE — every key collectBaseline produces is a REGULAR
//     FILE (`de.isFile()`), so recursion was never needed here, and a hook that
//     holds no recursive-delete primitive cannot have one aimed.
//   * the final component must be a regular file (or already absent): a (B)
//     entry that turned into a symlink/directory since the walk is a TYPE
//     AMBIGUITY, and the settled disposition is deny WITHOUT touching it.
function removeUnder(cwd, rel) {
  assertRealAncestors(cwd, rel, `(B) baseline removal of '${rel}'`);
  const abs = join(cwd, rel);
  const kind = lstatKind(abs);
  if (kind !== 'file' && kind !== 'absent') {
    throw new Error(
      `refusing to remove (B) baseline path '${rel}': the entry is not a regular file (lstat kind: ${kind}) — a symlink, directory or other ` +
        `non-regular entry standing where the baseline walk saw a file is denied without being deleted, never removed through`
    );
  }
  rmSync(abs, { force: true });
}

// Parse `git status --porcelain -z`: NUL-separated entries `XY <path>`; a
// rename/copy (R/C) consumes a SECOND field `XY NEW\0OLD` — evaluate BOTH.
function parsePorcelainZ(out) {
  const tokens = out.split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const xy = tok.slice(0, 2);
    const paths = [tok.slice(3)];
    if (xy[0] === 'R' || xy[0] === 'C') paths.push(tokens[++i]); // OLD path follows
    entries.push({ xy, paths });
  }
  return entries;
}

// Decision h17-enforcement-stamp-conductor-attested-dirt (6e132e19): a
// CONDUCTOR-written stamp (.sterling/transient/enforcement-stamp.json, written
// by scripts/enforcement-stamp.mjs — never by an agent, which cannot self-
// attest its own tamper) lists each dirty enforcement path with the sha256 of
// its bytes at stamp time. When EVERY path in `preExistingRels` is listed with
// a hash matching its CURRENT bytes, the pre-existing dirt is conductor-
// attested work-in-flight rather than an unverifiable defect. FAIL-CLOSED:
// any error reading/parsing the stamp, any unlisted path, or any hash mismatch
// yields no exemption — never partial credit for a subset that DID match.
// NARROWED by decision 7021526c: `preExistingRels` is now populated ONLY on the
// degraded fallback (no per-call Pre-STATE record to compare against), so this
// all-or-nothing consult governs the degraded path alone. A pre-dirty path whose
// state genuinely CHANGED is attested PER PATH by stampAttestsCurrentBytes /
// stampAttestsDirectory in the sweep, because one unstamped unchanged path must
// never collapse attestation for a changed stamped one.
function verifyStampAttestation(cwd, preExistingRels) {
  try {
    const { present, entries } = readStamp(cwd);
    if (!present) return { attested: false, stampPresent: false, failedPath: null };
    if (!entries) return { attested: false, stampPresent: true, failedPath: null };
    const byPath = new Map();
    for (const entry of entries) {
      if (entry && typeof entry.path === 'string') byPath.set(entry.path, entry);
    }
    for (const rel of preExistingRels) {
      const entry = byPath.get(rel);
      if (!entry) return { attested: false, stampPresent: true, failedPath: rel };
      const abs = join(cwd, rel);
      // FIX L1 (upgrade-polish, 2026-08-21): a stamped DELETION attests iff the
      // path is STILL absent — the path reappearing is not the attested state,
      // so no exemption (fail-closed, no partial credit). LSTAT-guarded (review
      // finding 3): a dangling symlink is present, not absent, so it can never
      // pass as an attested deletion.
      if (entry.deleted === true) {
        if (lstatKind(abs) !== 'absent') return { attested: false, stampPresent: true, failedPath: rel };
        continue;
      }
      if (typeof entry.sha256 !== 'string') return { attested: false, stampPresent: true, failedPath: rel };
      // Only a REGULAR FILE can be hashed for attestation — never a symlink
      // (whose bytes may live outside the repo), a directory, or a device.
      const current = sha256OfRegularFile(abs);
      if (current === null) return { attested: false, stampPresent: true, failedPath: rel };
      if (current !== entry.sha256) return { attested: false, stampPresent: true, failedPath: rel };
    }
    return { attested: true, stampPresent: true, failedPath: null };
  } catch {
    // Fail-closed (P5): an unreadable/corrupt stamp exempts nothing.
    return { attested: false, stampPresent: true, failedPath: null };
  }
}

// FIX-A (decision h17-stamp-honor-loud-restore, 4d9b76e8): a fresh conductor
// attestation for a SINGLE in-window path — read the stamp NOW and hash the
// file's CURRENT bytes. Deliberately separate from verifyStampAttestation
// above (FIX C): that one attests a whole preExisting SET at once, all-or-
// nothing; this one gates a single restore decision for a path that was NOT
// dirty at Pre. FAIL-CLOSED: any error (missing/corrupt stamp, unlisted path,
// hash mismatch, deleted-entry shape) attests nothing.
function stampAttestsCurrentBytes(cwd, rel) {
  try {
    const { entries } = readStamp(cwd);
    if (!entries) return false;
    const entry = entries.find((e) => e && e.path === rel);
    if (!entry) return false;
    const abs = join(cwd, rel);
    // Review fix 5: a stamped DELETION (enforcement-stamp.mjs writes
    // {path, deleted:true} for a dirty path with no bytes) attests iff the
    // path is STILL absent — mirrors verifyStampAttestation's deleted arm.
    // Without this, an attested in-window deletion was silently resurrected.
    const kind = lstatKind(abs);
    if (kind === 'absent') return entry.deleted === true;
    // Review finding 3: a path that is not a REGULAR FILE is UNATTESTED, full
    // stop. The old existsSync/readFileSync pair FOLLOWED a link, so a stamped
    // file replaced by a symlink to an out-of-repo file holding the stamped
    // bytes was attested and allowed — and the hook loader would then execute
    // content from outside the repo that no sweep covers.
    if (kind !== 'file') return false;
    if (typeof entry.sha256 !== 'string') return false;
    const current = sha256OfRegularFile(abs);
    return current !== null && current === entry.sha256;
  } catch {
    return false;
  }
}

// Review fix 6 (h17-stamp-honor-loud-restore adjudication): an untracked
// DIRECTORY reaches the (A) restore point as its bare collapsed path (`?? dir/`
// → `dir`), while the stamp CLI expands a dirty dir into its child FILES — so
// a per-path lookup can never match and an attested dir was rmSync'd. Attest
// the dir by walking its child files: EVERY child stamp-attested → the dir is
// conductor work-in-flight (skip restore + deny). Empty dir, any unattested or
// mismatched child, or any fs error → false (fail-closed, restore as before).
function stampAttestsDirectory(cwd, relDir) {
  try {
    const files = [];
    const walk = (rel) => {
      for (const de of readdirSync(join(cwd, rel), { withFileTypes: true })) {
        const childRel = `${rel}/${de.name}`;
        // Review finding 3: Dirent classification is lstat-shaped, and this
        // walk keeps it that way — a symlink is never recursed into and never
        // counted as an attestable file, so the recursion cannot leave the repo
        // and no child's bytes are ever hashed through a link. Anything that is
        // neither a real directory nor a regular file aborts the walk into the
        // catch below (fail-closed: the directory attests nothing).
        if (de.isDirectory()) walk(childRel);
        else if (de.isFile()) files.push(childRel);
        else throw new Error(`unattestable entry '${childRel}' (not a regular file or directory)`);
      }
    };
    walk(relDir);
    if (!files.length) return false;
    return files.every((f) => stampAttestsCurrentBytes(cwd, f));
  } catch {
    return false;
  }
}

// FIX-B (decision h17-stamp-honor-loud-restore, 4d9b76e8): every ACTUAL
// restore mints ONE deduped maintenance item per restored path, so a restore
// that used to be conductor-invisible (reported only on the agent's own
// stderr, recorded nowhere) leaves a durable trace. enqueueSystemTodo does the
// per-path dedup (system_reason, feature_link, file_keys) INSIDE its own
// insert transaction — a repeat restore of the same path refreshes the one
// open item rather than minting a second (PIN4). FAIL-OPEN by construction:
// called only AFTER the restore(s) it names already succeeded, and every
// failure here is caught and disclosed on stderr — it never throws, so it can
// never turn the restore/deny that already happened into anything else
// (PIN5). Agent-facing deny stderr is composed elsewhere and stays unchanged.
function mintRestorePerformed(cwd, paths, agentId) {
  let mstore = null;
  try {
    mstore = openStore(cwd);
    if (!mstore) {
      // Review fix 4: a null store loses the queue item — disclose, never silent.
      process.stderr.write(`H17: restore_performed maintenance item(s) NOT written (store unavailable); restore/deny proceed regardless.\n`);
      return;
    }
    const now = new Date().toISOString();
    for (const rel of paths) {
      try {
        mstore.enqueueSystemTodo({
          id: randomUUID(),
          type: 'todo',
          created_at: now,
          updated_at: now,
          author: 'system',
          status: 'active',
          superseded_by: null,
          links: [],
          scope: 'project',
          stack_tags: [],
          text: `H17 restored '${rel}' to HEAD, reverting a Bash write by agent '${agentId}' at ${now} (no matching conductor stamp).`,
          source: 'system',
          system_reason: 'restore_performed',
          file_keys: [rel],
        });
      } catch (e) {
        process.stderr.write(`H17: restore_performed maintenance item failed to write for '${rel}': ${(e && e.message) || e}\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`H17: restore_performed maintenance queue unavailable (${(e && e.message) || e}); restore/deny proceed regardless.\n`);
  } finally {
    try {
      mstore?.close();
    } catch {
      /* best-effort close — never blocks the deny path */
    }
  }
}

// Restore a tracked path: in HEAD → git checkout (modified/deleted/rename-origin);
// not in HEAD → new/untracked/added → remove (file or `?? dir/`).
// ANCESTOR-GUARDED (board 128fedb7 site 3): both arms are aimable primitives —
// `git checkout HEAD -- <rel>` writes wherever the resolved path lands and the
// recursive `rmSync` resolves the whole string before deleting, so a symlink at
// any DIRECTORY component (a linked `hooks/`, or a linked subdirectory inside a
// legitimately dirty untracked tree) redirects the restore or the delete out of
// the repository. A non-directory ancestor throws → the caller's fail-closed
// catch → deny WITHOUT restoring.
// The FINAL component is deliberately NOT kind-restricted here, unlike the (B)
// primitives: `git checkout` replaces a symlink standing in for a tracked file
// with HEAD's blob without following it (which is exactly what makes the
// clean-at-Pre symlink swap recoverable), and unlinking a planted symlink leaf
// removes the LINK, never its target — refusing there would leave an
// attacker-planted link live at an enforcement path, which is strictly worse
// than removing it.
function restoreTracked(cwd, relRaw) {
  const rel = relRaw.replace(/\/+$/, ''); // untracked dir collapses to `?? dir/`
  assertRealAncestors(cwd, rel, `(A) tracked restore of '${rel}'`);
  const inHead = spawnSync('git', ['-C', cwd, 'cat-file', '-e', 'HEAD:' + rel], { encoding: 'utf8' }).status === 0;
  if (inHead) {
    const r = spawnSync('git', ['-C', cwd, 'checkout', 'HEAD', '--', rel], { encoding: 'utf8' });
    if (r.error || r.status !== 0) throw new Error(`checkout HEAD -- ${rel} failed: ${r.stderr || r.error}`);
  } else {
    rmSync(join(cwd, rel), { recursive: true, force: true });
  }
}

const input = readStdin();
const cwd = input.cwd;

// (conductor) — legitimately edits the enforcement surface. Short-circuit BEFORE
// any store/git/baseline touch (AC5).
if (!input.agent_id) allow();

const event = input.hook_event_name;

// ---------------------------------------------------------------------------
// PreToolUse — snapshot the (B) baseline to os.tmpdir()/sterling-enforce-<runId>.json
// ---------------------------------------------------------------------------
if (event === 'PreToolUse') {
  try {
    const store = openStore(cwd);
    let runId = NO_RUN;
    try {
      const run = store ? withRetry(() => store.getRun()) : undefined;
      if (run) runId = run.id;
    } finally {
      store?.close();
    }
    // ONE key for this Bash call, used by BOTH per-call records below (board
    // 11609d1f): the (B) content baseline and the (A) Pre-STATE snapshot are
    // keyed identically, so they can never disagree about which call they
    // belong to. A null key writes the legacy per-run baseline and NO state
    // record — degraded, and Post says so on both counts.
    const key = callKey(input.tool_use_id);
    // The (B) baseline is written ONCE, under the per-call key when there is
    // one: writing the legacy per-run copy as well would leave a shared file
    // behind after the per-call one is consumed, which is precisely the shared
    // transient state this keying removes (P4).
    writeFileSync(baselineFile(cwd, runId, key), JSON.stringify(collectBaseline(cwd)));
    // Attribution record for the (A) branch: without it, Post can only see that a
    // tracked path is dirty NOW, not whether this command made it so. KEYED PER
    // CALL under the SAME `key` as the (B) baseline and the (A) STATE record
    // (board 489554d4): a run-keyed record is one file every concurrent lane
    // overwrites, and an overwrite that OMITS a genuinely pre-dirty path makes
    // Post restore-delete it. Written ONCE — per-call when there is a key, the
    // legacy per-run name (degraded, disclosed LOUDLY at Post) when there is not;
    // writing the legacy copy as well would leave a shared file behind after the
    // per-call one is consumed, exactly the shared transient state this keying
    // removes (P4).
    const dirtyRels = dirtyTrackedRels(cwd);
    writeFileSync(dirtyFile(cwd, runId, key), JSON.stringify(dirtyRels));
    // PER-CALL Pre-STATE record (7021526c): the STATE of every dirty path, so
    // Post can compare rather than deny the whole result for being unable to.
    // Written ONLY when tool_use_id is usable — a null key degrades LOUDLY at
    // Post (the blanket pre-existing denial, naming the reason), never silently
    // to a per-run key. Derived from the SAME git status as the attribution
    // record above, so the two records can never disagree about which paths
    // were dirty.
    if (key) {
      const idx = indexEntriesFor(cwd, dirtyRels);
      const states = {};
      for (const rel of dirtyRels) states[rel] = pathState(cwd, rel, idx);
      writeFileSync(stateFile(cwd, runId, key), JSON.stringify(states));
    }
    allow();
  } catch (e) {
    // A snapshot failure during an active agent run cannot be verified later —
    // fail closed (P5).
    deny(environmentDefectDenial('H17', `[pre] Baseline snapshot failed (${(e && e.message) || e}) — failing closed (P5).`, { agentId: input.agent_id }));
  }
}

// ---------------------------------------------------------------------------
// PostToolUse — verify + restore. The ENTIRE body is fail-closed: ANY unexpected
// error during an active agent run denies (exit 2), NEVER a non-blocking exit 1.
// ---------------------------------------------------------------------------
try {
  // FIX-B (h17-stamp-honor-loud-restore, 4d9b76e8), PIN5: an unopenable/
  // throwing store must never suppress the tracked-write restore below —
  // captured here, not thrown, so section (A) still runs on what git alone can
  // tell it (glob-only violations; no brief, no pre-existing attribution, both
  // of which need a working store to resolve). The original deny still fires,
  // but only AFTER the restore (and its mint attempt) had their chance —
  // denying immediately here is exactly what silently dropped the restore.
  // ONE key for this Bash call, resolved before anything reads a record: BOTH
  // per-call records (the (A) Pre-STATE snapshot and the (B) content baseline,
  // board 11609d1f) are addressed by it, and both degrade LOUDLY — never
  // silently — when it is unusable.
  const callId = callKey(input.tool_use_id);
  let storeErr = null;
  let store = null;
  try {
    store = openStore(cwd);
  } catch (e) {
    storeErr = new Error(`store/resolveRun threw (${(e && e.message) || e})`);
  }

  let run;
  if (store) {
    try {
      run = withRetry(() => store.getRun());
    } catch (e) {
      storeErr = new Error(`store/resolveRun threw (${(e && e.message) || e})`);
      store.close();
      store = null;
    }
  }
  const runId = run ? run.id : NO_RUN;

  let brief = null;
  if (run && store) {
    try {
      brief = withRetry(() => store.get(run.brief_ref));
    } catch (e) {
      storeErr = new Error(`brief resolve threw (${(e && e.message) || e})`);
      store.close();
      store = null;
    }
    if (store && (!brief || brief.type !== 'brief')) {
      store.close();
      // run active but brief unresolvable → fail CLOSED (unlike H3), P5 (AC9f).
      // Unchanged: this is an invalid brief_ref, not a broken store, and no
      // restore has been attempted yet — it stays an immediate deny exactly as
      // before (only the store/resolveRun-throw path below is deferred).
      deny(
        environmentDefectDenial(
          'H17',
          `Run '${runId}' active but brief '${run.brief_ref}' unresolvable — cannot verify contract; failing closed (P5).`,
          { agentId: input.agent_id }
        )
      );
    }
  }
  store?.close();

  const violations = [];
  // Dirty BEFORE this command — reported, never reverted, never blamed on the
  // agent (decision f76d7c5c). Safe to skip the revert because an agent cannot
  // produce this state: H3's self-protection denies spawned agents every
  // Edit/Write inside the bundled hooks dir or matching ENFORCEMENT_SURFACE, and
  // its only other write vector is Bash — which this very branch reverts, so a
  // previous command's dirt is already gone by the next Pre.
  const preExisting = [];
  // Pre-dirty paths whose recorded STATE CHANGED inside this command's window
  // (7021526c step 3): denied and NAMED, and deliberately NOT restored.
  const changedPreDirty = [];
  // Paths this Post ACTUALLY restored (FIX-B, 4d9b76e8) — one deduped
  // restore_performed maintenance item is minted per path here, once every
  // restore attempt below has run.
  const restoredPaths = [];

  // No working store → no runId to key the attribution record on, so
  // `preDirty` stays empty: unverifiable attribution is never treated as
  // pre-existing (P5) — every glob-matched tracked violation restores.
  let preDirty = new Set();
  // The per-call Pre-STATE map (7021526c), or null when this command has no
  // comparable record — in which case the pre-dirty branch keeps the OLD blanket
  // denial and `degradedReason` says why (degraded LOUD, never silent).
  let preState = null;
  let degradedReason = null;
  // Set when the (B) stage had to fall back to the SHARED per-run baseline
  // because this call carries no usable tool_use_id (board 11609d1f). Disclosed
  // NON-FATALLY on stderr on EVERY path the moment the fallback is taken
  // (reviewer F1 — the laundering it admits compares EQUAL and allows, so a
  // disclosure gated on a violation is silent when it matters), and ADDITIONALLY
  // named in the denial alongside the (B) paths it acted on. A degraded key that
  // changes what the guard trusts and says nothing is the defect, not the
  // degradation.
  let baselineShared = null;
  // The (B) paths this Post restored/removed, kept beside `violations` (which
  // mixes (A) and (B)) so the shared-baseline disclosure can name exactly the
  // writes it applies to.
  const baselineViolations = [];
  // Set when the (A) ATTRIBUTION record had to fall back to the SHARED per-run
  // file because this call carries no usable tool_use_id (board 489554d4), the
  // mirror of `baselineShared` on the (B) side. Disclosed NON-FATALLY on stderr
  // the moment the fallback is taken, ALLOW path included: the destructive
  // laundering it admits (a genuinely pre-dirty path missing from an overwritten
  // shared record is HEAD-restored as this command's write) produces a DENY, but
  // a clean-allow degraded call must still say the pre-dirty set it trusted was
  // not this call's own. A degraded key that changes what the guard trusts and
  // says nothing is the defect, not the degradation.
  let attributionShared = null;
  if (!storeErr) {
    const dPath = dirtyFile(cwd, runId, callId);
    if (!callId) {
      attributionShared =
        'this hook call carries no usable `tool_use_id` (absent, empty/whitespace, or not a string), so the (A) ATTRIBUTION record in play is the ' +
        'legacy PER-RUN, RUN-KEYED file SHARED by every concurrent Bash lane in this run instead of one keyed to this call — while it is shared, a ' +
        "second lane's Pre can OVERWRITE it after this lane's Pre ran, and a path that was genuinely dirty at this lane's Pre but MISSING from the " +
        'overwritten record is then treated as clean-at-Pre and HEAD-restored (DELETED) as this command\'s write, destroying pre-existing conductor ' +
        'work (that is exactly why the per-call key exists, board 489554d4, and why this fallback is reported rather than assumed harmless)';
    }
    // The two early-deny paths just below (a MISSING or CORRUPT attribution
    // record) return BEFORE the "on every path" stderr disclosure at the end of
    // this block would fire, so without this they would omit that the record
    // consulted was the legacy SHARED per-run file (Codex review, the mirror of
    // the (B) F1 lesson: degraded-loud on EVERY path, deny paths included). When
    // the key was unusable, the record's very absence or corruption IS a
    // degraded-mode observation, so the deny says so. Verdict-safe: text only, on
    // an already-DENY path.
    const sharedNote = attributionShared
      ? ` DEGRADED MODE — the record consulted here is the legacy SHARED per-run attribution file, not one keyed to this call: ${attributionShared}. Its absence or corruption is itself a degraded-mode observation, not necessarily a Pre that never ran.`
      : '';
    if (!existsSync(dPath)) {
      // Same posture as the missing (B) baseline: unverifiable attribution denies.
      // Reached when Pre did not run, when a run boundary moved the runId between
      // Pre and Post, or when a Pre written by an OLDER bundle predates this file.
      deny(
        environmentDefectDenial(
          'H17',
          `attribution record '${dPath}' absent at Post — cannot tell this command's writes from pre-existing ones; failing closed (P5). ` +
            `If a run started or completed between Pre and Post, the runId in the filename moved; rerun the command.` +
            sharedNote,
          { agentId: input.agent_id }
        )
      );
    }
    let recordedDirty;
    try {
      recordedDirty = JSON.parse(readFileSync(dPath, 'utf8'));
    } catch {
      deny(
        environmentDefectDenial('H17', `attribution record '${dPath}' corrupt/unparseable — cannot attribute writes; failing closed (P5).` + sharedNote, {
          agentId: input.agent_id,
        })
      );
    }
    // LIFECYCLE-BOUND (P4, board 489554d4): a PER-CALL attribution record's life
    // ends with the Post that read it — the paths are already in memory, so the
    // unlink is best-effort and can never change the verdict, and the validation
    // below runs on `recordedDirty` in memory, not on the file. The legacy per-run
    // file is deliberately left alone: it is not this call's to consume (a
    // concurrent lane may still need it) and the next Pre overwrites it as before.
    if (callId) {
      try {
        rmSync(dPath, { force: true });
      } catch {
        /* leaked temp record only; the attribution already happened in memory */
      }
    }
    // DEGRADED-LOUD ON EVERY PATH (board 489554d4), the (A) mirror of
    // `baselineShared`'s stderr disclosure: the moment the attribution record fell
    // back to the SHARED per-run file, say so — allow path included — because the
    // destructive laundering a shared record admits (a genuinely pre-dirty path
    // missing from an overwritten record HEAD-restored as this command's write)
    // must never be inferred from silence. Best-effort/wrapped exactly like
    // mintRestorePerformed: a throwing stderr must never flip the verdict.
    if (attributionShared) {
      try {
        process.stderr.write(
          `H17: DEGRADED (A) ATTRIBUTION — this Bash call carries no usable \`tool_use_id\`, so the attribution record it compared against was the ` +
            `legacy PER-RUN, RUN-KEYED file SHARED by every concurrent lane in this run, not one keyed to this call. A concurrent lane's Pre could have ` +
            `OVERWRITTEN it after this lane's Pre ran — in which case a genuinely pre-dirty path MISSING from it is treated as this command's write and ` +
            `HEAD-restored (deleted). The verdict stands; what is unverifiable is that the pre-dirty set it trusted belonged to this call. (board 489554d4)\n`
        );
      } catch {
        /* best-effort trace — a failed write must never change the verdict */
      }
    }
    // VALIDATE AND NORMALIZE EVERY ENTRY before the set is trusted — the same
    // posture the per-call STATE record's keys already get (validateStateKey),
    // and it became load-bearing when coverage went ancestor-aware (board
    // 7dd39b85): the recorded set no longer answers only "is this exact path
    // dirty" but "does a recorded ancestor PROTECT this path from restore", so
    // an entry that fails to match is no longer inert — it is a conductor's
    // file DELETED. A trailing slash is the measured shape: `hooks/newdir/`
    // does not cover `hooks/newdir/a.mjs`, because every candidate the walk
    // builds is a boundary slice with no trailing slash. Pre always strips
    // (dirtyTrackedRels), so a divergent entry means a corrupt or tampered
    // record, and a record that cannot be trusted denies rather than quietly
    // protecting less than it claims to (P5).
    if (!Array.isArray(recordedDirty)) {
      deny(
        environmentDefectDenial('H17', `attribution record '${dPath}' is not an array of paths — cannot attribute writes; failing closed (P5).`, {
          agentId: input.agent_id,
        })
      );
    }
    for (const entry of recordedDirty) {
      const norm = typeof entry === 'string' ? entry.replace(/\/+$/, '') : '';
      // EVERY SEGMENT, not just the trailing slash. `hooks/newdir/.` and
      // `hooks//newdir` are non-empty strings that survive the strip and then
      // match nothing the boundary walk builds, which withdraws coverage just
      // as silently as the trailing-slash shape did — and the deny that the
      // unmatched entry eventually triggers arrives AFTER the sweep has already
      // deleted the child, because the sweep visits current porcelain entries
      // first. Refusing HERE is what makes the refusal safe: it lands before
      // the sweep runs, so nothing has been restored yet. `..` is rejected for
      // the ordinary traversal reason. NOT rejected: a backslash — on POSIX it
      // is an ordinary filename character, and normalizing it (as
      // validateStateKey does for the state record's keys) would produce a key
      // that no longer matches preState's and wedge every sweep touching such
      // a file.
      const segments = norm ? norm.split('/') : [];
      const malformed = !norm || segments.some((s) => s === '' || s === '.' || s === '..');
      if (malformed) {
        deny(
          `H17: crafted attribution record entry rejected (${JSON.stringify(entry)} — not a well-formed repo-relative path: empty, '.', '..' or an empty segment). ` +
            `An entry that cannot be matched silently withdraws restore protection from everything under it, so it is refused BEFORE the sweep runs; ` +
            `no write performed, failing closed (P5). NOTE the limit of this check: it rejects malformed SHAPES, and cannot detect a tampered entry that ` +
            `names a different WELL-FORMED path — that residual is the forged-record class decision 2422e76a already accepts.`
        );
      }
      // Beyond the malformed-SHAPE check above, mirror the per-call STATE
      // record's key posture (validateStateKey, AC10/AC14) on this loaded entry:
      // it must be a repo-relative POSIX path CONTAINED under the project root —
      // no absolute path, no drive prefix, no NUL, no traversal resolving out
      // (board 1f4b7af0 item 2). The attribution record became a PROTECTIVE input
      // when coverage went ancestor-aware (board 7dd39b85): a recorded ancestor
      // EXEMPTS its descendants from restore, so an entry that fails validation
      // must DENY — the stated invariant "a recorded path failing key validation
      // denies" — never be silently added to a set where it matches no
      // enforcement predicate and is quietly ignored. validateStateKey is used
      // here ONLY as a validator: its backslash-normalized RESULT is discarded and
      // the original backslash-preserved `norm` is what enters preDirty, because
      // preDirty keys are matched against raw porcelain paths and normalizing a
      // POSIX backslash would wedge every sweep touching such a file (the same
      // reason stated above for not normalizing backslashes here).
      if (!validateStateKey(cwd, norm)) {
        deny(
          `H17: crafted attribution record entry rejected (${JSON.stringify(entry)} — not a repo-relative path contained within the project root: ` +
            `absolute, drive-prefixed, NUL-bearing, or escaping the root). A recorded path that fails key validation is a PROTECTIVE input that cannot be ` +
            `trusted, so it is refused BEFORE the sweep runs rather than silently ignored (board 1f4b7af0 item 2); no write performed, failing closed (P5).`
        );
      }
      preDirty.add(norm);
    }

    // The PER-CALL Pre-STATE record (7021526c). Present and valid -> the
    // pre-dirty branch below COMPARES instead of denying blindly. Absent or
    // corrupt -> AC9 fail-closed (a pre-dirty path whose Pre state cannot be
    // read is exactly as unverifiable as it ever was). No usable tool_use_id ->
    // the record was never written, so the OLD blanket denial stands and says so.
    const key = callId;
    if (!key) {
      degradedReason =
        'this hook call carries no usable `tool_use_id` (absent, empty, or not a string), so there is no per-call Pre-STATE record to compare against — ' +
        'and H17 will NOT fall back to a per-run key, because one shared record lets a second lane adopt the first lane\'s tampered bytes as its own baseline';
    } else {
      const sPath = stateFile(cwd, runId, key);
      if (!existsSync(sPath)) {
        deny(
          environmentDefectDenial(
            'H17',
            `per-call Pre-STATE record '${sPath}' absent at Post — the pre-existing dirt cannot be compared against its state at Pre; failing closed (P5). ` +
              `Same causes as a missing attribution record, plus one more: the tool_use_id carried at Pre and at Post must be the SAME Bash call's.`,
            { agentId: input.agent_id }
          )
        );
      }
      let recorded;
      try {
        recorded = JSON.parse(readFileSync(sPath, 'utf8'));
      } catch {
        deny(
          environmentDefectDenial('H17', `per-call Pre-STATE record '${sPath}' corrupt/unparseable — cannot compare pre-existing dirt; failing closed (P5).`, {
            agentId: input.agent_id,
          })
        );
      }
      if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) {
        deny(
          environmentDefectDenial('H17', `per-call Pre-STATE record '${sPath}' is not a path->state object — cannot compare pre-existing dirt; failing closed (P5).`, {
            agentId: input.agent_id,
          })
        );
      }
      // Validate EVERY key AND EVERY VALUE before the record is trusted (AC10
      // posture + review finding 4): the audited agent can write arbitrary
      // bytes into os.tmpdir(), so a crafted record is conduct, not
      // environment. A MAP, never a plain object (finding 4(b)): copying parsed
      // keys into an object routes an own `__proto__` key through [[Set]] and
      // really does change the lookup's prototype, after which a real pre-dirty
      // path resolves an INHERITED state, compares "unchanged", and defeats the
      // absent-entry check. A Map has no prototype chain to poison.
      preState = new Map();
      for (const k of ownKeys(recorded)) {
        const norm = validateStateKey(cwd, k);
        if (!norm) {
          deny(
            `H17: crafted per-call Pre-STATE record key rejected ('${k}' — not a repo-relative path inside the project); no write performed, failing closed (P5).`
          );
        }
        const shapeError = stateShapeError(cwd, recorded[k], norm);
        if (shapeError) {
          deny(
            `H17: per-call Pre-STATE record '${sPath}' carries an unexpected per-path state shape (${shapeError}) — an unvalidated state can compare EQUAL to a tampered path, so it is refused; no write performed, failing closed (P5).`
          );
        }
        preState.set(norm, recorded[k]);
      }
      // Lifecycle-bound (P4): the record's life ends with the Post that consumed
      // it. Best-effort — a failed unlink must never change the verdict.
      try {
        rmSync(sPath, { force: true });
      } catch {
        /* leaked temp record only; the comparison already happened in memory */
      }
    }
  }

  // --- (A) TRACKED writes via git ---
  const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '-z'], { encoding: 'utf8' });
  if (status.error || status.status !== 0) {
    throw new Error(`git status --porcelain -z failed (status ${status.status}: ${status.stderr || status.error})`);
  }
  const postEntries = parsePorcelainZ(status.stdout);
  // THE SWEEP SET = the UNION of what git reports dirty NOW and what the record
  // says was dirty at Pre (review finding 1, CRITICAL — a fail-closed
  // violation). Iterating only the CURRENT status skipped every path that was
  // dirty at Pre and is CLEAN at Post, so it was never compared, never
  // stamp-consulted and never denied: a command running
  // `git checkout HEAD -- hooks/h3-contract-gate.mjs` destroyed the conductor's
  // uncommitted enforcement work and exited 0. Dirty-at-Pre + clean-at-Post is
  // a STATE CHANGE like any other — it lands on the ordinary comparison below
  // (the bytes moved from the in-flight image to HEAD's), reaches the stamp
  // consult, then the deny, so ONE code path governs and there is no
  // special-cased unconditional denial to keep in sync.
  // Value = the RAW porcelain path (a `?? dir/` keeps its trailing slash for
  // restoreTracked); a recorded-only path is its own raw form.
  const sweep = new Map();
  for (const entry of postEntries) {
    for (const p of entry.paths) {
      const rel = p.replace(/\/+$/, '');
      if (rel && !sweep.has(rel)) sweep.set(rel, p);
    }
  }
  for (const rel of preDirty) {
    if (typeof rel === 'string' && rel && !sweep.has(rel)) sweep.set(rel, rel);
  }
  // Current INDEX entries for the whole sweep set, in ONE chunked call — the
  // index term of the state comparison. Skipped entirely when there is no
  // record to compare against, so the degraded path keeps exactly today's
  // behaviour and gains no new failure mode. A git failure throws -> deny (AC9).
  let postIndex = new Map();
  if (preState) postIndex = indexEntriesFor(cwd, [...sweep.keys()]);
  for (const [rel, p] of sweep) {
    const isViolation =
      isEnforcementSurface(rel) ||
      matchesGlob(rel, 'hooks/**') ||
      (brief && !!scopeCheck({ brief, rel, amendments: (run.scope_amendments ?? []).map((a) => a.path) }).deny);
    if (isViolation) {
      // MEMBERSHIP IS ANCESTOR-AWARE (board 7dd39b85): the recorded set holds a
      // dirty untracked DIRECTORY as one collapsed path, so a swept path may be
      // covered by a recorded ANCESTOR rather than recorded itself. See
      // coveringPreDirtyPath for why coverage is computed per swept path here
      // and never expanded into the record at Pre.
      //
      // ORDERING HAZARD, and the rule that closes it. The sweep Map holds the
      // CURRENT porcelain entries BEFORE the recorded-only ancestors, so a
      // descendant is visited FIRST: were a covered descendant ever
      // destructively restored, the deletion would land before the ancestor's
      // own recursive comparison ran, and that comparison would then be
      // observing state H17 ITSELF mutated (it would report the ancestor as
      // changed because of the hook's own write, and the agent would be blamed
      // for it). THE RULE, stated so it is explicit rather than true by
      // accident: NO PATH COVERED BY A RECORDED DIRTY ANCESTOR IS EVER
      // DESTRUCTIVELY RESTORED — every arm inside this branch either continues
      // or pushes onto `changedPreDirty`, and none of them calls
      // restoreTracked. Anything that wants to restore must first prove no
      // recorded ancestor covers it, i.e. take the clean-at-Pre arm below.
      //
      // THAT RULE IS CONDITIONAL ON A WORKING STORE, and the condition is
      // stated because a reader will otherwise take it as absolute (the same
      // conditionality AC12 already carries for "a pre-dirty path is never
      // restored"). Under `storeErr` there is no runId to key the attribution
      // record on, so `preDirty` stays EMPTY by design (see the comment above
      // it): nothing is covered, and every enforcement-surface dirty path —
      // a covered descendant included — is restored to HEAD before the deny.
      // Coverage protects work only as far as the record can be read at all.
      const coveringPre = coveringPreDirtyPath(preDirty, rel);
      if (coveringPre) {
          // Already dirty at Pre — not this command's write, and never reverted:
          // reverting here is what destroyed a conductor's uncommitted
          // enforcement-surface work and reported it as the agent's (f76d7c5c).
          //
        // Decision 7021526c: it is no longer DENIED merely for being dirty
        // either. The order is exactly (1) compare the recorded Pre STATE with
        // the CURRENT state — unchanged means the surface is verified BY
        // OBSERVATION and no stamp is consulted or needed; (2) changed ->
        // consult the stamp FRESH against the CURRENT state, PER PATH
        // (4d9b76e8's rule is general, not confined to the clean-at-Pre arm:
        // a stamp can only be written by a deliberate conductor-run CLI,
        // 6e132e19, so a match means the change is conductor-attested);
        // (3) otherwise deny. No arm restores — a pre-image restore across
        // overlapping Bash windows would clobber a concurrent lane's
        // legitimate write (board 0b848342 finding 1, deferred by decision).
        if (!preState) {
          // DEGRADED-LOUD: nothing to compare against, so the old blanket
          // pre-existing denial stands and names its reason below. Reached for
          // every RECORDED pre-dirty path, whether or not git still reports it
          // dirty (review finding 1, second half): populating this set only
          // while walking the current status let a command that CLEANED every
          // pre-dirty enforcement path leave it empty, so the safety net that
          // backs up the whole comparison failed OPEN.
          preExisting.push(rel);
          continue;
        }
        if (!preState.has(coveringPre)) {
          // The attribution record says this path (or the ancestor covering it)
          // was dirty at Pre and the state record has no entry for it — the two
          // disagree, so the write is unattributable. Fail closed (AC9); an
          // absent entry must NEVER read as "unchanged", and must never be
          // satisfiable through a prototype (finding 4(b): the lookup is a Map
          // for exactly that).
          throw new Error(
            `per-call Pre-STATE record has no entry for the pre-dirty path '${coveringPre}'` +
              (coveringPre === rel ? '' : ` (the recorded ancestor covering the swept path '${rel}')`) +
              ` — the attribution record and the state record disagree, so this command's writes cannot be told from pre-existing ones`
          );
        }
        let wasState = preState.get(coveringPre);
        if (coveringPre !== rel) {
          // Covered by a recorded ancestor: resolve the child's OWN recorded
          // state out of the ancestor's recursive children map (throws when the
          // recorded topology disagrees — AC9).
          const recordedChild = recordedDescendantState(wasState, coveringPre, rel);
          // RECORDED-ABSENT, not "created by this command". An absent entry in
          // the children map does NOT prove the audited command created the
          // path: pathState recurses but is not ATOMIC, so a conductor's
          // concurrent creation can predate the command and still be missing
          // from the map; and an agent that edits the temp record can delete a
          // child entry while leaving a structurally valid record. Restoring
          // under that ambiguity is exactly what this branch's overlapping-
          // window rule forbids (see the comment above). So synthesize the
          // absent state and run the SAME comparison: it compares CHANGED, and
          // stampCouldAttest refuses an absent -> present flip, so it lands in
          // `changedPreDirty` — DENIED and NOT restored.
          wasState = recordedChild ?? { exists: false, index: null };
        }
        const nowState = pathState(cwd, rel, postIndex);
        if (sameState(wasState, nowState)) continue; // (1) verified by observation
        // (2) conductor-attested — but ONLY where a stamp can actually speak
        // for the difference (review finding 2). A {path, sha256} /
        // {path, deleted:true} entry attests BYTES or an ABSENCE and nothing
        // else, so a mode flip, an index-only move, a type swap or a retargeted
        // link is unattestable by construction and falls straight to (3): those
        // leave the bytes identical, match the stamp, and were wrongly allowed.
        if (stampCouldAttest(wasState, nowState)) {
          if (isDirectoryAt(cwd, rel) ? stampAttestsDirectory(cwd, rel) : stampAttestsCurrentBytes(cwd, rel)) continue;
        }
        changedPreDirty.push(rel); // (3) denied, and still not restored
        continue;
      }
      // FIX-A (h17-stamp-honor-loud-restore, 4d9b76e8): an IN-WINDOW change
      // (no recorded pre-dirty path covers it — neither itself nor any
      // ancestor, board 7dd39b85) gets one fresh-stamp chance before the
      // restore — a stamped conductor edit landing inside an agent's Bash
      // window used to be silently HEAD-restored (the measured defect). Read
      // the stamp NOW, hash the CURRENT bytes: an exact match exempts this
      // path from both the restore and the deny; no match falls straight
      // through to the restore+deny exactly as before. UNCHANGED by the
      // finding-2 gate above: this arm has no recorded Pre state to diff, so
      // there is no "difference confined to bytes" to establish — AC13's
      // clean-at-Pre behaviour stays exactly as it was.
      if (isDirectoryAt(cwd, rel) ? stampAttestsDirectory(cwd, rel) : stampAttestsCurrentBytes(cwd, rel)) continue;
      restoreTracked(cwd, p); // may throw (restore fs-error) → outer catch → deny
      violations.push(rel);
      restoredPaths.push(rel); // FIX-B: mints a restore_performed item below
    }
  }

  // FIX-B (4d9b76e8): mint one deduped restore_performed item PER RESTORED
  // PATH — immediately after the (A) sweep, BEFORE the (B) baseline stage,
  // whose immediate denies process.exit(2) and would otherwise drop the mint
  // for a restore that already happened (review fix 2). Fail-open: any store
  // failure inside is disclosed on stderr and never thrown, so it can never
  // turn an already-completed restore into a crash or a non-blocking exit 1
  // (PIN5).
  if (restoredPaths.length) mintRestorePerformed(cwd, restoredPaths, input.agent_id);

  // --- (B) gitignored BASELINE set via the Pre snapshot ---
  // Guarded on a working store (PIN5): the baseline file is keyed on the
  // store-resolved runId, so with no runId there is no honest baseline file to
  // consult — skipped rather than misread against the wrong run's snapshot.
  // The storeErr deny below still fires; only the (A) tracked-restore sweep
  // above (which needs no runId for its glob-only violations) runs regardless.
  if (!storeErr) {
    // PER-CALL when this call carries a usable tool_use_id (board 11609d1f);
    // the legacy per-run file only when it does not — and that fallback is
    // DISCLOSED ON EVERY PATH (a non-fatal stderr line at the end of the (B)
    // sweep, allow path included, plus a named part in any denial the (B) writes
    // compose — `baselineShared` below), never silent, because a shared baseline
    // is the laundering hole itself: one lane's Pre overwrites another's and a
    // tamper is adopted as the legitimate pre-image, and that tamper compares
    // EQUAL — so a disclosure gated on a violation would be silent when it matters.
    const bPath = baselineFile(cwd, runId, callId);
    if (!callId) {
      baselineShared =
        'this hook call carries no usable `tool_use_id` (absent, empty/whitespace, or not a string), so the (B) content baseline in play is the ' +
        'legacy PER-RUN, RUN-KEYED file SHARED by every concurrent Bash lane in this run instead of one keyed to this call — while it is shared, a ' +
        'second lane\'s Pre can overwrite it after this lane\'s command has already written, and the overwritten state would be adopted as this ' +
        'lane\'s legitimate pre-image (that is exactly why the per-call key exists, and why this fallback is reported rather than assumed harmless)';
    }
    if (!existsSync(bPath)) {
      deny(
        environmentDefectDenial(
          'H17',
          `Baseline '${bPath}' absent at Post (no Pre snapshot) — cannot verify the enforcement surface; failing closed (P5). ` +
            `Same three causes as a missing attribution record: Pre genuinely did not run, a run started or completed between Pre and ` +
            `Post so the runId in the filename moved, or realpathSync succeeded at one end and threw at the other (two project tags); ` +
            `plus one more since the baseline became per-call: the tool_use_id carried at Pre and at Post must be the SAME Bash call's. Rerun the command.`,
          { agentId: input.agent_id }
        )
      );
    }
    let baseline;
    try {
      baseline = JSON.parse(readFileSync(bPath, 'utf8'));
    } catch {
      deny(
        environmentDefectDenial('H17', `Baseline '${bPath}' corrupt/unparseable — cannot verify the enforcement surface; failing closed (P5).`, {
          agentId: input.agent_id,
        })
      );
    }
    // LIFECYCLE-BOUND (P4, board 11609d1f): a PER-CALL baseline's life ends with
    // the Post that read it — the bytes are already in memory, so the unlink is
    // best-effort and can never change the verdict. The legacy per-run file is
    // deliberately left alone: it is not this call's to consume (a concurrent
    // lane may still need it), and the next Pre overwrites it exactly as before.
    if (callId) {
      try {
        rmSync(bPath, { force: true });
      } catch {
        /* leaked temp record only; the comparison already happened in memory */
      }
    }

    // Validate EVERY key BEFORE any restore write — a bad key (traversal/absolute/
    // off-glob) is a crafted baseline; deny with NO out-of-tree write (AC10).
    // UNWRAPPED, deliberately (review finding F4), unlike the corrupt-baseline
    // branch one line up: a CORRUPT baseline (unparseable JSON) can only arise
    // from something damaging the file out from under the gate — an environment
    // defect. A CRAFTED key (well-formed JSON, but a key that is absolute, a
    // traversal, or off the (B) glob set) implies an AUTHOR: the same agent
    // whose Bash command this hook is auditing can itself write arbitrary bytes
    // to os.tmpdir() (no store/enforcement-surface guard covers that path), so
    // a hand-shaped payload here is conduct, not environment — the misconduct
    // framing (and its fail-closed-with-no-write remedy) stays correct.
    const valid = {};
    for (const key of Object.keys(baseline)) {
      const norm = validateBaselineKey(key);
      if (!norm) {
        deny(`H17: crafted baseline key rejected ('${key}' — not a repo-relative (B)-set path); no write performed, failing closed (P5).`);
      }
      valid[norm] = baseline[key];
    }

    const current = collectBaseline(cwd); // reading a swapped dir throws → outer catch → deny (AC9c)
    for (const [rel, content] of Object.entries(valid)) {
      if (!(rel in current)) {
        writeUnder(cwd, rel, content); // baseline file deleted → recreate
        violations.push(rel);
        baselineViolations.push(rel);
      } else if (current[rel] !== content) {
        writeUnder(cwd, rel, content); // modified → restore bytes
        violations.push(rel);
        baselineViolations.push(rel);
      }
    }
    for (const rel of Object.keys(current)) {
      if (!(rel in valid)) {
        removeUnder(cwd, rel); // new → delete, ancestor- and kind-guarded (board 128fedb7)
        violations.push(rel);
        baselineViolations.push(rel);
      }
    }
    // DEGRADED-LOUD ON EVERY PATH (board 11609d1f, reviewer F1). The deny-path
    // notice below fires only when the (B) comparison found a DIFFERENCE — but
    // the laundering failure the per-call key exists to close produces NO
    // difference (a shared baseline overwritten with already-tampered bytes
    // compares EQUAL and the call ALLOWs), so a disclosure gated on a violation
    // stays silent exactly when the shared baseline was most dangerous. Emit a
    // NON-FATAL stderr line the moment the fallback was taken — allow path
    // included — using the same fire-and-continue idiom mintRestorePerformed
    // uses: it changes no verdict, no allow/deny outcome, and no key. This is
    // the ONLY audible trace on a clean-allow degraded call.
    if (baselineShared) {
      // WRAPPED (delta-review LOW): this write is UNGUARDED inside the outer
      // fail-closed try, so a throwing stderr (EPIPE/EBADF) on the clean-ALLOW
      // path would reach the outer catch and flip allow -> deny — a verdict
      // change. mintRestorePerformed wraps its body for exactly this reason;
      // match it so a best-effort trace can never alter the outcome.
      try {
        process.stderr.write(
          `H17: DEGRADED (B) VERIFICATION — this Bash call carries no usable \`tool_use_id\`, so the (B) content baseline it verified against was the ` +
            `legacy PER-RUN, RUN-KEYED file SHARED by every concurrent lane in this run, not one keyed to this call. A concurrent lane's Pre could have ` +
            `OVERWRITTEN it after this lane's command already wrote — in which case a tamper would compare EQUAL and be adopted as this call's legitimate ` +
            `pre-image. The verdict stands; what is unverifiable is that the pre-image belonged to this call. (board 11609d1f)\n`
        );
      } catch {
        /* best-effort trace — a failed write must never change the verdict */
      }
    }
  }

  // A store that failed to open/resolve earlier still owes its original deny
  // — but only now, AFTER the tracked-restore sweep (and its mint attempt)
  // ran on whatever git alone could tell it. Denying any earlier is exactly
  // what silently dropped the restore in the first place (PIN5). Wording is
  // HEAD's original outer-catch shape, class label preserved (review fix 3);
  // any restore performed under the broken store is named — a restore must
  // never be invisible (review fix 1).
  if (storeErr) {
    const restoredNote = restoredPaths.length
      ? ` NOTE: ${restoredPaths.length} enforcement path(s) were HEAD-restored during this sweep despite the broken store: ${restoredPaths.join(', ')} — verify none were conductor work-in-flight.`
      : '';
    deny(
      environmentDefectDenial(
        'H17',
        `Enforcement verification failed (${(storeErr && storeErr.message) || storeErr}) — failing closed (P5).${restoredNote}`,
        {
          agentId: input.agent_id,
        }
      )
    );
  }

  // Decision h17-enforcement-stamp-conductor-attested-dirt (6e132e19): before
  // firing the enforcement-surface-dirty denial for the PRE-EXISTING set (which
  // since 7021526c only fills on the degraded fallback — see above), give
  // a conductor-written stamp its one sanctioned exemption chance. Attested in
  // full → the pre-existing dirt is conductor-work-in-flight, not an
  // unverifiable defect; drop it from `preExisting` entirely so it composes no
  // denial. Anything short of full attestation (unlisted path, hash mismatch,
  // missing/corrupt stamp) changes nothing — the existing denial fires exactly
  // as before, optionally naming which path failed attestation when a stamp
  // was present but did not fully cover the dirt.
  let stampFailedPath = null;
  if (preExisting.length) {
    const verdict = verifyStampAttestation(cwd, preExisting);
    if (verdict.attested) {
      preExisting.length = 0;
    } else if (verdict.stampPresent) {
      stampFailedPath = verdict.failedPath;
    }
  }

  if (violations.length || preExisting.length || changedPreDirty.length) {
    const parts = [];
    if (changedPreDirty.length) {
      // Decision 7021526c step 3. NOT the environment-defect class: the state
      // moved INSIDE this command's window, so it is attributable — and not the
      // "reverted" class either, because a pre-image restore stays out of scope.
      parts.push(
        `H17: PRE-EXISTING dirty path(s) whose state CHANGED inside this command's window, and which are therefore NOT verifiable as untouched: ${changedPreDirty.join(
          ', '
        )}. ` +
          `The state recorded at PreToolUse (existence, file type, mode, symlink target, index entry, bytes) differs from the state now, and no fresh conductor stamp attests the current state. ` +
          `These paths are deliberately NOT reverted — restoring a pre-image could clobber a concurrent lane's legitimate write — so the bytes stand as they are; ` +
          `exit contract-violated, never route around.`
      );
    }
    if (violations.length) {
      parts.push(
        `H17: write(s) BY THIS COMMAND outside its contract, reverted: ${violations.join(', ')} — exit contract-violated, never route around. ` +
          `A path may be here for any of three reasons: it is enforcement surface, it is under hooks/, or it failed the brief's scope check — ` +
          `only the last is amendable by scope (the first two are denied unconditionally, before the brief is consulted).`
      );
    }
    // DEGRADED-LOUD ON THE (B) SIDE (board 11609d1f), the mirror of
    // `degradedReason` on the (A) side: the verdict above stands, but it was
    // reached against a baseline SHARED with every other lane in this run, so
    // the exposure is stated rather than left for a reader to infer. Composed
    // only when the (B) stage actually acted — a call that touched no (B) path
    // gains nothing from the notice (P1).
    if (baselineShared && baselineViolations.length) {
      parts.push(
        `H17: DEGRADED (B) VERIFICATION — the (B)-set path(s) above (${baselineViolations.join(', ')}) were compared and restored against a SHARED ` +
          `PER-RUN baseline, not one keyed to this Bash call: ${baselineShared}. The verdict stands; what is degraded is the confidence that the ` +
          `pre-image it restored was this call's own.`
      );
    }
    // DEGRADED-LOUD ON THE (A) SIDE (board 489554d4), the mirror of the (B) block
    // above: a tracked path HEAD-restored while the attribution record was the
    // shared per-run file may have been PRE-EXISTING dirt missing from an
    // overwritten record rather than this command's write. Composed only when the
    // (A) stage actually restored something (P1).
    if (attributionShared && restoredPaths.length) {
      parts.push(
        `H17: DEGRADED (A) ATTRIBUTION — the tracked path(s) HEAD-restored above (${restoredPaths.join(', ')}) were attributed to this command against a ` +
          `SHARED PER-RUN attribution record, not one keyed to this Bash call: ${attributionShared}. The verdict stands; what is degraded is the ` +
          `confidence that a restored path was this command's own write rather than pre-existing dirt missing from an overwritten shared record.`
      );
    }
    if (preExisting.length) {
      // ENVIRONMENT DEFECT, not misconduct (decision f76d7c5c, review finding
      // F3): this state existed BEFORE the command ran, by construction never
      // the calling agent's doing — yet the old wording read as misconduct
      // and prescribed remedies (commit/revert) the agent cannot perform (no
      // Bash path to the enforcement surface, H15/H3 deny it). h17 always
      // short-circuits to allow() when input.agent_id is absent (line ~155),
      // so the audience here is unconditionally an agent — no conductor case
      // to compose with F2.
      parts.push(
        environmentDefectDenial(
          'H17',
          // "or inside one that was" is load-bearing since coverage became
          // ancestor-aware (board 7dd39b85): a path here may be a DESCENDANT of
          // a recorded dirty directory rather than recorded itself, and for a
          // file the command genuinely created inside such a directory the bare
          // claim "already dirty before this command" is false. The disposition
          // is unchanged and still correct — not attributed, not reverted —
          // but a denial that states a falsehood about the agent's own write is
          // exactly the misdirection the discriminator rule forbids.
          `PRE-EXISTING change(s), already dirty before this command (or inside a directory that was) and therefore NOT attributed to it and NOT reverted: ${preExisting.join(', ')}. ` +
            `Nothing of yours was undone. The command is still denied because the enforcement surface cannot be verified while it is dirty from outside ` +
            `(the conductor's own work, e.g. a mid-run bundle rebuild).` +
            // DEGRADED-LOUD (7021526c): since the per-call Pre-STATE record
            // landed, this blanket denial fires ONLY when there is no record to
            // compare against — so it must say which input it lacked, or the
            // degrade is silent and indistinguishable from the old behaviour.
            (degradedReason ? ` This blanket denial is a DEGRADED FALLBACK: ${degradedReason}.` : '') +
            (stampFailedPath ? ` A conductor-attested stamp exists but does not attest '${stampFailedPath}' — no exemption.` : ''),
          { agentId: input.agent_id }
        )
      );
    }
    deny(parts.join('\n'));
  }
  allow();
} catch (e) {
  // Universal fail-closed catch-all: anything unforeseen during an active agent
  // run denies (exit 2), never a non-blocking exit 1. This branch is reached
  // only by UNEXPECTED internal failures (git errors, restore fs-errors, a
  // corrupt store) — never by an actual verified contract violation, which
  // denies explicitly above with its own contract-violated wording untouched.
  deny(
    environmentDefectDenial('H17', `Enforcement verification failed (${(e && e.message) || e}) — failing closed (P5).`, {
      agentId: input.agent_id,
    })
  );
}
