// scripts/commit-reviewed.mjs — CONDUCTOR-run CLI for part B of decision
// 12a26ca6-a301-466d-a45c-5e1eeff36694 (slug review-receipt-ledger; board
// 7814acc3-bb22-4cc5-abd7-789d6396743f).
//
// Structure mirrors scripts/enforcement-stamp.mjs: cwd-relative "target",
// fail() from scripts/lib/project.mjs (stderr + exit 1), no --target flag.
//
//   node scripts/commit-reviewed.mjs -m "<message>"
//
// Contract (decision 12a26ca6, part 2 of MECHANISM):
//   - Not a Sterling project root (no .sterling/ under cwd): refuse before
//     anything else — no message parsing, no git call.
//   - No -m / missing message: refuse (exit 1), no commit.
//   - Ledger entries are VALIDATED before stamping: only entries whose
//     agent_type is a string matching /^reviewer-[A-Za-z0-9_-]+$/ are
//     eligible (one line blocks \r/\n trailer-smuggling). A rejected entry
//     gets a one-line stderr warning naming why and is LEFT un-consumed in
//     the ledger — never silently dropped. Duplicate valid agent_types still
//     stamp one trailer each (no dedupe).
//   - Zero VALID entries in .sterling/review-ledger.json (missing file,
//     empty array, malformed JSON, or every entry rejected by validation —
//     all treated as empty): refuse (exit 1) with guidance — dispatch a
//     reviewer, or commit bare and answer at the merge gate — and make NO
//     commit.
//   - >=1 valid entry AND staged changes present: commit with the given
//     message plus one `Reviewed-By-Agent: <agent_type>` trailer per valid
//     entry (readable via the exact read scripts/direct-merge.mjs:143
//     uses), then CONSUME: RE-READ the ledger (it may have gained a fresh
//     entry while `git commit` ran — hooks can take seconds) and write back
//     every entry NOT identity-matched (agent_type + at) to the set just
//     stamped, so a receipt promoted mid-commit survives — P4: the artifact
//     that uses the evidence removes exactly that evidence, nothing more.
//     This read-modify-write is lock-guarded (withLedgerLock below) against
//     a concurrent H22 promotion write.
//   - >=1 valid entry but NOTHING STAGED: refuse (exit 1), do NOT consume
//     the ledger (P5 — never mint an empty commit that silently eats real
//     review evidence for nothing).
//   - The commit SUCCEEDS but the post-commit consume write fails: this is
//     NOT a refusal — the commit already exists. Print a distinct loud
//     message naming the ledger path and instructing manual cleanup, then
//     exit 1.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { arg, fail } from './lib/project.mjs';

const target = process.cwd();

// Guard the cwd before anything else (FIX 6): a bare directory has no
// review ledger and no meaningful contract to enforce.
if (!existsSync(join(target, '.sterling'))) {
  fail('commit-reviewed: not a Sterling project root — no .sterling/ directory under the current working directory');
}

const message = arg('-m') ?? arg('--message');
if (!message) {
  fail('commit-reviewed: missing required -m/--message <commit message>');
}

// Tiny shared-convention lock guarding the review-ledger read-modify-write
// (duplicated here and in scripts/hooks/h22-dispatch-register.mjs — hooks
// stay dependency-light, so this is ~15 lines copied rather than a shared
// import; see the mirror copy there). mkdirSync is the atomic primitive: two
// processes racing to create the same directory, exactly one wins and the
// other gets EEXIST — no extra library needed. A lock dir older than 10s is
// treated as abandoned (a crashed holder) and removed. On timeout this
// proceeds UNLOCKED with a loud stderr note rather than crashing (P5).
function withLedgerLock(sterlingDir, run) {
  const lockPath = join(sterlingDir, 'review-ledger.lock');
  let acquired = false;
  for (let i = 0; i < 200 && !acquired; i++) {
    try {
      mkdirSync(lockPath);
      acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 10_000) {
          rmSync(lockPath, { recursive: true, force: true }); // stale — remove and retry immediately
          continue;
        }
      } catch {
        continue; // lock vanished under us (released concurrently) — retry immediately
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // ~5ms, no async available here
    }
  }
  if (!acquired) {
    console.error('commit-reviewed: review-ledger lock timed out — proceeding UNLOCKED (degraded-loud); a concurrent writer may lose this update');
    return run();
  }
  try {
    return run();
  } finally {
    rmdirSync(lockPath);
  }
}

const ledgerPath = join(target, '.sterling', 'review-ledger.json');
let ledger = [];
try {
  if (existsSync(ledgerPath)) {
    const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    if (Array.isArray(raw)) ledger = raw;
  }
} catch {
  ledger = []; // malformed ledger degrades to empty — treated identically to
  // a missing/empty ledger, never a crash
}

const guidance =
  'commit-reviewed: no un-consumed review-ledger entries — dispatch a reviewer before committing, or commit bare and answer at the merge gate';
if (ledger.length === 0) {
  fail(guidance);
}

// Validate BEFORE stamping (FIX 4 — single line blocks \r/\n trailer
// smuggling): only entries whose agent_type matches the reviewer-* roster
// shape are eligible. A rejected entry is warned about and LEFT in the
// ledger un-consumed — never silently dropped.
const VALID_AGENT_TYPE = /^reviewer-[A-Za-z0-9_-]+$/;
const validEntries = [];
for (const e of ledger) {
  if (e && typeof e.agent_type === 'string' && VALID_AGENT_TYPE.test(e.agent_type)) {
    validEntries.push(e);
  } else {
    console.error(
      `commit-reviewed: skipping malformed ledger entry (agent_type ${JSON.stringify(e && e.agent_type)} does not match ^reviewer-[A-Za-z0-9_-]+$) — left un-consumed in the ledger`
    );
  }
}
if (validEntries.length === 0) {
  fail(guidance);
}

const staged = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: target, encoding: 'utf8', timeout: 30_000 });
if (staged.error) {
  fail(`commit-reviewed: git diff --cached --quiet failed: ${staged.error.message}`);
}
if (staged.status === 0) {
  // No staged differences: refuse WITHOUT consuming the ledger (P5) — an
  // empty commit would silently eat real review evidence for nothing.
  fail('commit-reviewed: nothing staged — refusing to create an empty commit that would consume review evidence for nothing');
} else if (staged.status !== 1) {
  // FIX 5: 0 and 1 are git's only documented outcomes for --quiet; anything
  // else is a real failure (git itself errored) and must not be silently
  // read as "staged".
  fail(`commit-reviewed: git diff --cached --quiet exited unexpectedly (${staged.status}): ${(staged.stderr || '').trim()}`);
}

const trailerLines = validEntries.map((e) => `Reviewed-By-Agent: ${e.agent_type}`);
const fullMessage = `${message}\n\n${trailerLines.join('\n')}`;

const commit = spawnSync('git', ['commit', '-m', fullMessage], { cwd: target, encoding: 'utf8', timeout: 30_000 });
if (commit.error) {
  // R2: spawnSync surfaces a spawn failure/timeout via .error (status stays
  // null and stderr/stdout stay empty in that case) — mirror the staged-check
  // pattern above rather than falling through to a bare, contentless message.
  fail(`commit-reviewed: git commit failed: ${commit.error.message}`);
}
if (commit.status !== 0) {
  fail(`commit-reviewed: git commit failed: ${(commit.stderr || commit.stdout || '').trim()}`);
}

// CONSUME the stamped entries: the commit that used the evidence removes it
// (P4). RE-READ rather than reuse `ledger` — `git commit` runs hooks inline
// and can take seconds, during which a reviewer's SubagentStop may have
// promoted a fresh entry into the ledger; that entry must survive. Only
// entries identity-matched (agent_type + at) to what was just stamped are
// removed. Lock-guarded (FIX 2) against a concurrent H22 promotion write.
try {
  withLedgerLock(join(target, '.sterling'), () => {
    let freshLedger = [];
    try {
      if (existsSync(ledgerPath)) {
        const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
        if (Array.isArray(raw)) freshLedger = raw;
      }
    } catch {
      freshLedger = []; // malformed at consume time degrades to empty, same posture as the initial read
    }
    // R1: identity is a MULTISET, not a Set. Two stamped entries can share
    // an identity key (same agent_type + Start-timestamp millisecond, e.g.
    // a parallel dispatch batch) — the ledger entry shape stays frozen
    // ({agent_type, files, at}), so identity collisions are handled here by
    // counting stamped occurrences and removing exactly one matching
    // re-read entry per stamped occurrence. Any excess occurrence (a fresh
    // receipt appended mid-commit that happens to collide with a stamped
    // identity) is left over and survives.
    const stampedCounts = new Map();
    for (const e of validEntries) {
      const key = `${e.agent_type} ${e.at}`;
      stampedCounts.set(key, (stampedCounts.get(key) || 0) + 1);
    }
    const survivors = freshLedger.filter((e) => {
      const key = e && `${e.agent_type} ${e.at}`;
      const remaining = key && stampedCounts.get(key);
      if (remaining) {
        stampedCounts.set(key, remaining - 1);
        return false; // consumes exactly one stamped occurrence
      }
      return true;
    });
    const tmpPath = join(target, '.sterling', `review-ledger.json.tmp-${process.pid}`);
    writeFileSync(tmpPath, JSON.stringify(survivors));
    renameSync(tmpPath, ledgerPath);
  });
} catch (e) {
  // FIX 3: the commit ALREADY EXISTS — this is not a refusal, it is a
  // distinct failure mode where evidence was used but could not be removed.
  // Loud and specific, never conflated with a normal refusal message.
  console.error(
    `commit-reviewed: COMMIT SUCCEEDED but the review ledger was NOT consumed (${(e && e.message) || e}) — ${ledgerPath} still carries the entries just stamped into this commit; remove them by hand before the next commit-reviewed invocation`
  );
  process.exit(1);
}

console.log(JSON.stringify({ committed: true, reviewed_by: validEntries.map((e) => e.agent_type) }));
