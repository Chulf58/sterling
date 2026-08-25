// SHARED DEAD-DISPATCH RESIDUE + EXCLUSIVE-RESOURCE CLAIM PRIMITIVES
// (boards 03ed9d35, 31565253; design pass approved 2026-08-24; pinned by
// scripts/tests/dispatch-residue-and-resources.test.mjs).
//
// One module, three consumers, so the orphan predicate, the git-dirty probe,
// the residue line shape, and the resource-claim scan cannot drift apart:
//   - h10-direct-capture.mjs  — Stop-time orphan residue + print-once stamp
//   - h1-session-start.mjs    — SessionStart residue before the register wipe
//   - h22-dispatch-register.mjs — SubagentStop kill-signature residue,
//     SubagentStart resource-claim write + "you do not hold" notice
//   - h26-dispatch-overlap.mjs — outgoing-brief resource-claim overlap check
//
// Dependency-light by design (invariant 4): node builtins plus the sibling
// negation module only; no config reads here — callers pass stale_minutes and
// the configured resource names, because each hook already owns its own
// config/read posture (soft vs gate).

import { spawnSync } from 'node:child_process';
import { hasUnsuppressedMatch, escapeRe } from './dispatch-advisory.mjs';

/**
 * An ORPHAN is a register entry that outlived config.dispatch_register
 * .stale_minutes without its SubagentStop firing. An unparseable/absent `at`
 * cannot prove liveness, so it counts as orphaned (fail toward reporting,
 * P5) — a live H22 write always stamps a valid ISO `at`.
 */
export function isOrphan(entry, staleMinutes, nowMs = Date.now()) {
  const t = Date.parse(entry?.at ?? '');
  if (Number.isNaN(t)) return true;
  return nowMs - t > staleMinutes * 60_000;
}

/**
 * Which of an entry's declared files are git-dirty right now.
 * Returns { verified: true, dirty: string[] } on a successful probe, or
 * { verified: false, dirty: <all declared>, reason } when the probe itself
 * fails — the CALLER must still report residue then, marked
 * tree-state-unverified, never silently drop it (SPEC A item 7).
 * No declared files → { verified: true, dirty: [] } (nothing can be held).
 */
export function probeDirtyPaths(projectDir, files) {
  const declared = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && f);
  if (declared.length === 0) return { verified: true, dirty: [] };
  let r;
  try {
    // -uall: without it, a killed agent's new file under a brand-new directory
    // reports as the collapsed '?? new-dir/' line and a declared
    // 'new-dir/x.mjs' never matches. -z: NUL-delimited records with paths
    // printed VERBATIM — no core.quotepath C-style quoting/escaping to
    // mis-decode, and rename records carry the new path then the old path as
    // two separate NUL-terminated fields (no ' -> ' arrow to split, which
    // could otherwise appear inside a quoted name under the non-z format).
    r = spawnSync('git', ['status', '--porcelain', '-z', '-uall', '--', ...declared], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch (err) {
    return { verified: false, dirty: declared, reason: String(err?.message ?? err).slice(0, 200) };
  }
  if (r.error || r.status !== 0) {
    const reason = String(r.error?.message || r.stderr || 'git status failed').trim().slice(0, 200);
    return { verified: false, dirty: declared, reason };
  }
  const flagged = new Set();
  const tokens = String(r.stdout ?? '').split('\0').filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 3) continue;
    const status = token.slice(0, 2);
    const path = token.slice(3);
    flagged.add(path);
    // Rename/copy records (status starting with R or C on either side) carry
    // the ORIGINAL path as the NEXT NUL-separated field — flag it too: an
    // entry that declared the old (now-deleted) path is genuinely dirty.
    if ((status[0] === 'R' || status[1] === 'R' || status[0] === 'C' || status[1] === 'C') && i + 1 < tokens.length) {
      flagged.add(tokens[i + 1]);
      i++; // consume the original-path field so it is never re-parsed as its own status record
    }
  }
  return { verified: true, dirty: declared.filter((f) => flagged.has(f)) };
}

/**
 * The one residue line, shared verbatim across H10/H1/H22 so the shape is
 * pinned once: `dispatch <type>:<id> stopped holding uncommitted edits to
 * <paths>; its gates did not complete.` — with a `[tree-state-unverified: …]`
 * marker inserted when the git probe could not run.
 */
export function formatResidueLine(entry, paths, { verified = true, reason = '' } = {}) {
  const identity = `${entry?.agent_type ?? 'unknown'}:${entry?.agent_id ?? 'unknown'}`;
  const list = (Array.isArray(paths) && paths.length ? paths : ['<no declared files>']).join(', ');
  const marker = verified ? '' : ` [tree-state-unverified${reason ? `: ${reason}` : ''}]`;
  return `dispatch ${identity} stopped holding uncommitted edits to ${list}${marker}; its gates did not complete.`;
}

/**
 * Which configured exclusive resource names a dispatch prompt CLAIMS —
 * an unsuppressed literal mention, using the shared negation semantics
 * (lib/dispatch-advisory.mjs): a prohibition marker anywhere earlier in the
 * clause, or a bare negator within its bounded comma-terminated window,
 * means the mention is NOT a claim ("No windowed-godot run for this
 * dispatch" claims nothing). checkSubjectVerb is OFF: a resource is
 * territory-shaped, not a tool/capability mention, so "review X and run the
 * <resource> session" still claims it. Names are matched literally
 * (escapeRe), so a configured name carrying regex-special characters is
 * matched and reported plainly, never dropped (SPEC B item 5).
 */
export function claimedResources(promptText, configuredNames) {
  const names = (Array.isArray(configuredNames) ? configuredNames : []).filter(
    (n) => typeof n === 'string' && n.trim().length > 0
  );
  if (names.length === 0) return [];
  const prompt = String(promptText ?? '');
  const claimed = [];
  for (const name of names) {
    const pattern = new RegExp(escapeRe(name), 'i');
    if (hasUnsuppressedMatch(prompt, pattern, { checkSubjectVerb: false })) claimed.push(name);
  }
  return claimed;
}
