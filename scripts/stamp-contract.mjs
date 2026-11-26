// stamp-contract [S] — propagate contract-wording bullets from templates/target-agents-md.md to
// every registered sibling project's AGENTS.md, outside its generated Sterling layer section.
// The stamping itself, its guards and its output lines live in scripts/lib/stamp-projects.mjs,
// which /sterling:update calls in-process with the registry rows it refreshed (decision
// 329-rebuild-how-sterling-update-stamps-sibling-projects-as-o). This file is the interactive
// CLI: it reads the registry, maps --project values to registry rows, and prints the results.
//   - dry-run by default; --apply writes; --apply-inserts writes new text only.
//   - QUIET ON CLEAN: an in-sync project prints nothing and is counted in the summary;
//     --verbose restores the per-bullet listing.
//   - exit 2 on any refusal, and when a --project value matches no registered project.
//   node scripts/stamp-contract.mjs [--apply | --apply-inserts] [--verbose] [--project <repo_path>...]
import { realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry, registryPath } from '@sterling/store';
import { resolveLinkedWorktree } from './lib/worktree-root.mjs';
import { stampProjects, stampRefusalCount, stampResultLines, stampSummaryLine } from './lib/stamp-projects.mjs';

const USAGE = 'usage: node scripts/stamp-contract.mjs [--apply | --apply-inserts] [--verbose] [--project <repo_path>...] [--help]';
const KNOWN_FLAGS = new Set(['--apply', '--apply-inserts', '--verbose', '--project']);
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
for (const a of argv) {
  if (a.startsWith('-') && !KNOWN_FLAGS.has(a)) {
    console.error(`stamp-contract: unknown option ${a}\n${USAGE}`);
    process.exit(2);
  }
}
const APPLY = process.argv.includes('--apply');
// --apply wins when both are given: it is the wider mode.
const APPLY_INSERTS = !APPLY && process.argv.includes('--apply-inserts');
const VERBOSE = process.argv.includes('--verbose');
const onlyProjects = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--project' && process.argv[i + 1]) onlyProjects.push(resolve(process.argv[++i]));
}
// A --project value that is a linked git worktree matches its registered MAIN project, but the
// contract files read and written are the worktree's own, so the stamp lands on that branch
// (user-ruled 2026-10-27, "The worktree's copy"). value: what was typed; match: the path the
// registry is compared against; dir: where AGENTS.md lives.
const realOrResolved = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const projectTargets = onlyProjects.map((value) => {
  const linked = resolveLinkedWorktree(value);
  return linked ? { value, match: linked.mainRoot, dir: linked.worktree, worktree: true } : { value, match: value, dir: value, worktree: false };
});

// The plugin root, from this file's location: scripts/.. in a clone, and the same root
// when run as bin/stamp-contract.mjs, whose bundle rewrites import.meta.url to this source
// path (sourceIdentityPlugin in scripts/lib/bundled-artifacts.mjs).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const registry = new ProjectRegistry(registryPath());
let projects;
try {
  projects = registry.list();
} finally {
  registry.close();
}

const matchedProjects = new Set();
// The directories to stamp for a registered project: itself, or, when --project named one or
// more of its linked worktrees, only those worktree copies (null: --project excludes it).
function stampDirs(p) {
  if (!onlyProjects.length) return [p.repo_path];
  const hits = projectTargets.filter((t) => t.match === resolve(p.repo_path) || t.match === realOrResolved(p.repo_path));
  for (const t of hits) matchedProjects.add(t.value);
  if (!hits.length) return null;
  const worktrees = hits.filter((t) => t.worktree);
  return worktrees.length ? worktrees.map((t) => t.dir) : [p.repo_path];
}

const rows = projects.flatMap((p) => (stampDirs(p) ?? []).map((dir) => ({ name: p.name, repo_path: p.repo_path, dir })));
// Each project is printed as soon as it is done, so what was written is on record whatever
// happens to a later project.
const results = stampProjects(rows, {
  repoRoot,
  apply: APPLY,
  applyInserts: APPLY_INSERTS,
  onResult: (r) => {
    for (const line of stampResultLines(r, { verbose: VERBOSE })) console.log(line);
  },
});
console.log(stampSummaryLine(results, { apply: APPLY, applyInserts: APPLY_INSERTS, verbose: VERBOSE }));
const unmatched = onlyProjects.filter((p) => !matchedProjects.has(p));
if (unmatched.length) {
  console.error(`stamp-contract: --project matched no registered project: ${unmatched.join(', ')} (the value must equal a registered repo_path)`);
  process.exit(2);
}
if (results.some((r) => stampRefusalCount(r) > 0)) {
  console.error('stamp-contract: refused above — resolve each by hand (sibling text that differs from every template version, a missing anchor, or a file that could not be written) and re-run.');
  process.exit(2);
}
