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
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
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
  const store = openStore(cwd);
  let run;
  try {
    run = store ? withRetry(() => store.getRun()) : undefined;
  } catch (e) {
    store?.close();
    throw new Error(`store/resolveRun threw (${(e && e.message) || e})`);
  }
  const runId = run ? run.id : NO_RUN;

  let brief = null;
  if (run) {
    try {
      brief = withRetry(() => store.get(run.brief_ref));
    } catch (e) {
      store?.close();
      throw new Error(`brief resolve threw (${(e && e.message) || e})`);
    }
    if (!brief || brief.type !== 'brief') {
      store?.close();
      // run active but brief unresolvable → fail CLOSED (unlike H3), P5 (AC9f).
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
  let preDirty;
  try {
    preDirty = new Set(JSON.parse(readFileSync(dPath, 'utf8')));
  } catch {
    deny(
      environmentDefectDenial('H17', `attribution record '${dPath}' corrupt/unparseable — cannot attribute writes; failing closed (P5).`, {
        agentId: input.agent_id,
      })
    );
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
        restoreTracked(cwd, p); // may throw (restore fs-error) → outer catch → deny
        violations.push(rel);
      }
    }
  }

  // --- (B) gitignored BASELINE set via the Pre snapshot ---
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
