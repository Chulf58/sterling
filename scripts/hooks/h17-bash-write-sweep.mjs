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
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { matchesGlob } from '@sterling/schemas';
import { readStdin, allow, deny, openStore } from './lib/common.mjs';
import { scopeCheck, isEnforcementSurface } from './lib/contract.mjs';

// The (B) gitignored baseline set (v3.1: settings*.json added — the gitignored
// settings.local.json is enforcement surface but git is blind to it).
const BASELINE_GLOBS = ['.claude/agents/**', '.sterling/config.json', '.claude/settings*.json'];
const NO_RUN = 'no-run'; // L2 baseline-file discriminator when no active run

function baselineFile(runId) {
  return join(tmpdir(), 'sterling-enforce-' + runId + '.json');
}

function toRel(cwd, abs) {
  return relative(cwd, abs).replace(/\\/g, '/');
}

// Synchronous sleep for the store busy-retry (no async in a hook body).
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Retry a store op past a transient SQLITE_BUSY (the live MCP server can hold a
// brief lock); a persistent / non-busy throw (corrupt db) propagates → deny.
function withRetry(fn) {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      return fn();
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!/SQLITE_BUSY|database is locked|is locked|busy/i.test(msg)) throw e;
      last = e;
      sleepMs(25 * (i + 1));
    }
  }
  throw last;
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
    writeFileSync(baselineFile(runId), JSON.stringify(collectBaseline(cwd)));
    allow();
  } catch (e) {
    // A snapshot failure during an active agent run cannot be verified later —
    // fail closed (P5).
    deny(`H17 [pre]: baseline snapshot failed (${(e && e.message) || e}) — failing closed (P5).`);
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
      deny(`H17: run '${runId}' active but brief '${run.brief_ref}' unresolvable — cannot verify contract; failing closed (P5).`);
    }
  }
  store?.close();

  const violations = [];

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
        isEnforcementSurface(rel) || matchesGlob(rel, 'hooks/**') || (brief && !!scopeCheck({ brief, rel }).deny);
      if (isViolation) {
        restoreTracked(cwd, p); // may throw (restore fs-error) → outer catch → deny
        violations.push(rel);
      }
    }
  }

  // --- (B) gitignored BASELINE set via the Pre snapshot ---
  const bPath = baselineFile(runId);
  if (!existsSync(bPath)) {
    deny(`H17: baseline '${bPath}' absent at Post (no Pre snapshot) — cannot verify the enforcement surface; failing closed (P5).`);
  }
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(bPath, 'utf8'));
  } catch {
    deny(`H17: baseline '${bPath}' corrupt/unparseable — cannot verify the enforcement surface; failing closed (P5).`);
  }

  // Validate EVERY key BEFORE any restore write — a bad key (traversal/absolute/
  // off-glob) is a crafted baseline; deny with NO out-of-tree write (AC10).
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

  if (violations.length) {
    deny(
      `H17: out-of-contract write(s) detected and reverted: ${violations.join(', ')} — a denial exits contract-violated, never route around; reverted.`
    );
  }
  allow();
} catch (e) {
  // Universal fail-closed catch-all: anything unforeseen during an active agent
  // run denies (exit 2), never a non-blocking exit 1.
  deny(
    `H17: enforcement verification failed (${(e && e.message) || e}) — a denial exits contract-violated, never route around; failing closed (P5).`
  );
}
