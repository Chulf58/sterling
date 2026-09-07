// H31 — plan lock (PostToolUse, matcher ExitPlanMode). Binds the plan the user
// just APPROVED into .sterling/plan-lock.json so every later re-entry (H1's
// SessionStart section, the rotation note's plan_path, H19's dispatch staging)
// can put the governing plan back in front of the conductor.
// Spec: decision `plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry`.
// Every primitive — sanitise, bounded hash, title, validated read, atomic write
// — lives in lib/plan-lock.mjs and is shared with H1, H19 and the manual CLI.
//
// THE APPROVAL FACT IS THE SUCCESSFUL PostToolUse EVENT. PostToolUse runs only
// after a tool completes SUCCESSFULLY; a plan rejection is a manual permission
// denial, which fires PreToolUse and NEITHER PostToolUse nor PostToolUseFailure
// (Claude Code hooks docs, verified at build 2026-09-06; corroborated by
// research_finding `posttooluse-skips-failed-calls-h29-seam-gap`, measured on
// this machine). So a rejected plan can never reach this hook and no
// response-text discriminator is needed — the "Your plan has been saved to:"
// sentence is undocumented and is deliberately NOT relied on. H31 is not
// registered on PostToolUseFailure.
//
// NEVER BLOCKS, NEVER EXITS NON-ZERO: this is delivery, not enforcement. A
// binding failure (no path, a relative path, an unreadable plan file, a failed
// write) PRESERVES the prior lock and writes one bounded
// .sterling/transient/plan-lock-unresolved.json instead — authority without a
// readable authority is worse than none. On supersession the NEW lock is
// written FIRST and the plan-lock-previous.json disclosure second, so a crash
// can lose the disclosure but never claim a supersession that did not happen.
//
// WHAT THIS DOES NOT GUARANTEE: that the conductor FOLLOWS the plan (the lock
// delivers the authority at every re-entry; the judgement stays the
// conductor's); that a plan edited after approval was re-approved (a changed
// file is DISCLOSED as MODIFIED, approval provenance is never re-stamped); that
// the lock survives a project whose .sterling/ is recreated.
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { readStdin, allow } from './lib/common.mjs';
import {
  PATH_MAX,
  REASON_MAX,
  TITLE_MAX,
  extractTitle,
  hashPlanFile,
  isAbsolutePlanPath,
  isSterlingProject,
  readLock,
  sanitizeForContext,
  sha256Of,
  sterlingDirOf,
  writeLock,
  writeMarker,
} from './lib/plan-lock.mjs';

function unresolved(sterlingDir, reason, rawPath) {
  // The marker is RENDERED by H1, so its strings are sanitised and bounded
  // here — unlike the lock's plan_path, which stays raw because it must resolve.
  writeMarker(sterlingDir, 'plan-lock-unresolved.json', {
    reason: sanitizeForContext(reason, REASON_MAX),
    planFilePath: sanitizeForContext(rawPath ?? '', PATH_MAX) || null,
    at: new Date().toISOString(),
  });
}

try {
  const input = readStdin();
  const cwd = input?.cwd;
  if (!cwd) allow();
  // A bare .sterling directory is NOT a project (~/.sterling exists on every
  // machine): the same sterling.db predicate readStdin's project-root walk and
  // scripts/lib/project.mjs both use. No ceremony outside a Sterling project (P1).
  if (!isSterlingProject(cwd)) allow();
  const sterlingDir = sterlingDirOf(cwd);

  if (input.hook_event_name !== 'PostToolUse') allow();
  if (input.tool_name !== 'ExitPlanMode') allow();

  const toolInput = input.tool_input;
  const planText = typeof toolInput?.plan === 'string' ? toolInput.plan : null;
  // RAW AND VERBATIM (no trim, no sanitise, no truncation): this value must
  // still open on disk, and any edit to it names a DIFFERENT file.
  const rawPath = typeof toolInput?.planFilePath === 'string' ? toolInput.planFilePath : '';

  if (!rawPath) {
    unresolved(sterlingDir, 'the ExitPlanMode approval carried no planFilePath, so the approved plan could not be bound to a file — any prior lock is preserved unchanged', rawPath);
    allow();
  }
  if (!isAbsolutePlanPath(rawPath)) {
    unresolved(sterlingDir, 'the ExitPlanMode planFilePath was RELATIVE, not absolute, so it could not be bound (a relative plan path has no unambiguous meaning outside the session that produced it) — any prior lock is preserved unchanged', rawPath);
    allow();
  }
  if (planText === null) {
    unresolved(sterlingDir, 'the ExitPlanMode approval carried no plan text, so the approved content could not be hashed — any prior lock is preserved unchanged', rawPath);
    allow();
  }

  const hashed = hashPlanFile(rawPath);
  if (hashed.unreadable) {
    unresolved(sterlingDir, `the plan file at the approved planFilePath ${hashed.unreadable} — any prior lock is preserved unchanged`, rawPath);
    allow();
  }

  // An existing lock is superseded whether or not it validates; only a VALID
  // one can be described in the disclosure below.
  const priorRead = readLock(sterlingDir);
  const previous = priorRead.lock ?? null;

  // Provenance is NULLABLE by design: a git read that fails must never discard
  // an otherwise trustworthy binding.
  const git = (args) => {
    try {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000 });
      return r.status === 0 ? (r.stdout ?? '').trim() || null : null;
    } catch {
      return null;
    }
  };

  const approvedSha = sha256Of(Buffer.from(planText, 'utf8'));
  const lock = {
    schema_version: 1,
    plan_path: rawPath,
    title: extractTitle(planText, basename(rawPath)),
    approved_at: new Date().toISOString(),
    // TWO HASHES, TWO QUESTIONS. approved_sha256 hashes the APPROVED TEXT (what
    // the user said yes to); file_sha256_at_approval hashes the FILE BYTES at
    // that moment, and is the ONLY baseline a later live-status check may
    // compare against — comparing the file against approved_sha256 would make a
    // text/file mismatch read as permanently MODIFIED.
    approved_sha256: approvedSha,
    file_sha256_at_approval: hashed.sha256,
    text_file_mismatch: approvedSha !== hashed.sha256,
    approved_session_id: typeof input.session_id === 'string' ? input.session_id : null,
    approved_branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    approved_head: git(['rev-parse', 'HEAD']),
    source: 'exit_plan_mode',
  };

  // A FAILED WRITE IS A BINDING FAILURE like any other (decision: "no path,
  // unreadable file, WRITE FAILURE ... writes ONE bounded marker"). renameSync
  // is atomic, so an EACCES/ENOSPC/EPERM here leaves the PRIOR lock exactly as
  // it was — what must not happen is that the failure passes silently, leaving
  // the conductor re-entering under a plan that was superseded in conversation
  // but never on disk.
  try {
    writeLock(sterlingDir, lock);
  } catch (e) {
    unresolved(
      sterlingDir,
      `the approved plan could not be WRITTEN to .sterling/plan-lock.json (${(e && e.message) || e}) — any prior lock is preserved unchanged and does NOT describe this approval`,
      rawPath
    );
    allow();
  }
  // LOCK FIRST, DISCLOSURE SECOND: a crash may lose the disclosure, never claim
  // a supersession before the new lock exists.
  if (previous) {
    writeMarker(sterlingDir, 'plan-lock-previous.json', {
      title: sanitizeForContext(previous.title, TITLE_MAX) || '(untitled)',
      plan_path: sanitizeForContext(previous.plan_path, PATH_MAX) || null,
      approved_at: sanitizeForContext(previous.approved_at, 64) || null,
      superseded_at: new Date().toISOString(),
    });
  }
  allow();
} catch (e) {
  // Loud on stderr, never non-zero: a plan lock that could not be written must
  // not fail the tool call it rode in on.
  try {
    process.stderr.write(`H31: plan lock failed: ${(e && e.message) || e}\n`);
  } catch {
    /* a failed stderr note must not change the outcome */
  }
  allow();
}
