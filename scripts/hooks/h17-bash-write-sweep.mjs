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
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
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

function baselineFile(cwd, runId) {
  return join(tmpdir(), `sterling-enforce-${projectTag(cwd)}-${runId}.json`);
}

// The (A) attribution record (decision f76d7c5c): which TRACKED paths were
// already dirty before this command ran. A SEPARATE file rather than a field on
// the (B) baseline, deliberately — the baseline's key-validation loop is the most
// security-critical code in this hook and adding a field would force a change to
// it (smallest safe implementation).
function dirtyFile(cwd, runId) {
  return join(tmpdir(), `sterling-enforce-${projectTag(cwd)}-${runId}.dirty.json`);
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

function toRel(cwd, abs) {
  return relative(cwd, abs).replace(/\\/g, '/');
}

// Snapshot every existing (B)-set file as { repoRelPath -> bytes }.
function collectBaseline(cwd) {
  const map = {};
  const walk = (absDir) => {
    if (!existsSync(absDir)) return;
    for (const name of readdirSync(absDir)) {
      const abs = join(absDir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else map[toRel(cwd, abs)] = readFileSync(abs, 'utf8');
    }
  };
  walk(join(cwd, '.claude', 'agents')); // .claude/agents/** (recursive)
  const claudeDir = join(cwd, '.claude'); // .claude/settings*.json (top level)
  if (existsSync(claudeDir)) {
    for (const name of readdirSync(claudeDir)) {
      const rel = '.claude/' + name;
      if (matchesGlob(rel, '.claude/settings*.json')) map[rel] = readFileSync(join(cwd, rel), 'utf8');
    }
  }
  const cfg = join(cwd, '.sterling', 'config.json'); // .sterling/config.json
  if (existsSync(cfg)) map['.sterling/config.json'] = readFileSync(cfg, 'utf8');
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

function writeUnder(cwd, rel, content) {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
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
function verifyStampAttestation(cwd, preExistingRels) {
  try {
    const stampPath = join(cwd, '.sterling', 'transient', 'enforcement-stamp.json');
    if (!existsSync(stampPath)) return { attested: false, stampPresent: false, failedPath: null };
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    if (!Array.isArray(stamp)) return { attested: false, stampPresent: true, failedPath: null };
    const byPath = new Map();
    for (const entry of stamp) {
      if (entry && typeof entry.path === 'string') byPath.set(entry.path, entry);
    }
    for (const rel of preExistingRels) {
      const entry = byPath.get(rel);
      if (!entry) return { attested: false, stampPresent: true, failedPath: rel };
      const abs = join(cwd, rel);
      // FIX L1 (upgrade-polish, 2026-08-21): a stamped DELETION attests iff the
      // path is STILL absent — the path reappearing is not the attested state,
      // so no exemption (fail-closed, no partial credit).
      if (entry.deleted === true) {
        if (existsSync(abs)) return { attested: false, stampPresent: true, failedPath: rel };
        continue;
      }
      if (typeof entry.sha256 !== 'string') return { attested: false, stampPresent: true, failedPath: rel };
      if (!existsSync(abs)) return { attested: false, stampPresent: true, failedPath: rel };
      const current = createHash('sha256').update(readFileSync(abs)).digest('hex');
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
    const stampPath = join(cwd, '.sterling', 'transient', 'enforcement-stamp.json');
    if (!existsSync(stampPath)) return false;
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    if (!Array.isArray(stamp)) return false;
    const entry = stamp.find((e) => e && e.path === rel);
    if (!entry) return false;
    const abs = join(cwd, rel);
    // Review fix 5: a stamped DELETION (enforcement-stamp.mjs writes
    // {path, deleted:true} for a dirty path with no bytes) attests iff the
    // path is STILL absent — mirrors verifyStampAttestation's deleted arm.
    // Without this, an attested in-window deletion was silently resurrected.
    if (!existsSync(abs)) return entry.deleted === true;
    if (typeof entry.sha256 !== 'string') return false;
    const current = createHash('sha256').update(readFileSync(abs)).digest('hex');
    return current === entry.sha256;
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
        if (de.isDirectory()) walk(childRel);
        else files.push(childRel);
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
function restoreTracked(cwd, relRaw) {
  const rel = relRaw.replace(/\/+$/, ''); // untracked dir collapses to `?? dir/`
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
    writeFileSync(baselineFile(cwd, runId), JSON.stringify(collectBaseline(cwd)));
    // Attribution record for the (A) branch: without it, Post can only see that a
    // tracked path is dirty NOW, not whether this command made it so.
    writeFileSync(dirtyFile(cwd, runId), JSON.stringify(dirtyTrackedRels(cwd)));
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
  // Paths this Post ACTUALLY restored (FIX-B, 4d9b76e8) — one deduped
  // restore_performed maintenance item is minted per path here, once every
  // restore attempt below has run.
  const restoredPaths = [];

  // No working store → no runId to key the attribution record on, so
  // `preDirty` stays empty: unverifiable attribution is never treated as
  // pre-existing (P5) — every glob-matched tracked violation restores.
  let preDirty = new Set();
  if (!storeErr) {
    const dPath = dirtyFile(cwd, runId);
    if (!existsSync(dPath)) {
      // Same posture as the missing (B) baseline: unverifiable attribution denies.
      // Reached when Pre did not run, when a run boundary moved the runId between
      // Pre and Post, or when a Pre written by an OLDER bundle predates this file.
      deny(
        environmentDefectDenial(
          'H17',
          `attribution record '${dPath}' absent at Post — cannot tell this command's writes from pre-existing ones; failing closed (P5). ` +
            `If a run started or completed between Pre and Post, the runId in the filename moved; rerun the command.`,
          { agentId: input.agent_id }
        )
      );
    }
    try {
      preDirty = new Set(JSON.parse(readFileSync(dPath, 'utf8')));
    } catch {
      deny(
        environmentDefectDenial('H17', `attribution record '${dPath}' corrupt/unparseable — cannot attribute writes; failing closed (P5).`, {
          agentId: input.agent_id,
        })
      );
    }
  }

  // --- (A) TRACKED writes via git ---
  const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '-z'], { encoding: 'utf8' });
  if (status.error || status.status !== 0) {
    throw new Error(`git status --porcelain -z failed (status ${status.status}: ${status.stderr || status.error})`);
  }
  for (const entry of parsePorcelainZ(status.stdout)) {
    for (const p of entry.paths) {
      const rel = p.replace(/\/+$/, '');
      if (!rel) continue;
      const isViolation =
        isEnforcementSurface(rel) ||
        matchesGlob(rel, 'hooks/**') ||
        (brief && !!scopeCheck({ brief, rel, amendments: (run.scope_amendments ?? []).map((a) => a.path) }).deny);
      if (isViolation) {
        if (preDirty.has(rel)) {
          // Already dirty at Pre — not this command's write. Reverting here is
          // what destroyed a conductor's uncommitted enforcement-surface work and
          // reported it as the agent's.
          preExisting.push(rel);
          continue;
        }
        // FIX-A (h17-stamp-honor-loud-restore, 4d9b76e8): an IN-WINDOW change
        // (not in the Pre dirty-set) gets one fresh-stamp chance before the
        // restore — a stamped conductor edit landing inside an agent's Bash
        // window used to be silently HEAD-restored (the measured defect). Read
        // the stamp NOW, hash the CURRENT bytes: an exact match exempts this
        // path from both the restore and the deny; no match falls straight
        // through to the restore+deny exactly as before.
        const isDir = (() => {
          try {
            return statSync(join(cwd, rel)).isDirectory();
          } catch {
            return false;
          }
        })();
        if (isDir ? stampAttestsDirectory(cwd, rel) : stampAttestsCurrentBytes(cwd, rel)) continue;
        restoreTracked(cwd, p); // may throw (restore fs-error) → outer catch → deny
        violations.push(rel);
        restoredPaths.push(rel); // FIX-B: mints a restore_performed item below
      }
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
    const bPath = baselineFile(cwd, runId);
    if (!existsSync(bPath)) {
      deny(
        environmentDefectDenial(
          'H17',
          `Baseline '${bPath}' absent at Post (no Pre snapshot) — cannot verify the enforcement surface; failing closed (P5). ` +
            `Same three causes as a missing attribution record: Pre genuinely did not run, a run started or completed between Pre and ` +
            `Post so the runId in the filename moved, or realpathSync succeeded at one end and threw at the other (two project tags); rerun the command.`,
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
      } else if (current[rel] !== content) {
        writeUnder(cwd, rel, content); // modified → restore bytes
        violations.push(rel);
      }
    }
    for (const rel of Object.keys(current)) {
      if (!(rel in valid)) {
        rmSync(join(cwd, rel), { recursive: true, force: true }); // new → delete
        violations.push(rel);
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
  // firing the enforcement-surface-dirty denial for the PRE-EXISTING set, give
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

  if (violations.length || preExisting.length) {
    const parts = [];
    if (violations.length) {
      parts.push(
        `H17: write(s) BY THIS COMMAND outside its contract, reverted: ${violations.join(', ')} — exit contract-violated, never route around. ` +
          `A path may be here for any of three reasons: it is enforcement surface, it is under hooks/, or it failed the brief's scope check — ` +
          `only the last is amendable by scope (the first two are denied unconditionally, before the brief is consulted).`
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
          `PRE-EXISTING change(s), already dirty before this command and therefore NOT attributed to it and NOT reverted: ${preExisting.join(', ')}. ` +
            `Nothing of yours was undone. The command is still denied because the enforcement surface cannot be verified while it is dirty from outside ` +
            `(the conductor's own work, e.g. a mid-run bundle rebuild).` +
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
