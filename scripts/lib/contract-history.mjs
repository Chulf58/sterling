// Every historical variant of each stamp-contract target bullet, from the templates'
// git log — the "clean template-descended" set a sibling block must match to be
// replaced. Searched across every template file (not just a lead's current home) so a
// bullet that moved at the AGENTS.md/CLAUDE.md split commit keeps its pre-split
// ancestry.
//
// NO GIT REPOSITORY (an installed plugin copy, decision
// sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone): there is no
// history to read, so only the CURRENT template text counts as template-descended, and
// an older sibling bullet reads as drift (exit 2, which H1's post-update sync
// tolerates) instead of crashing the whole run at module load. Said once on stderr.
// Every OTHER git failure still throws (P5).
//
// Builtins only (bundled into bin/stamp-contract.mjs).
import { spawnSync } from 'node:child_process';
import { isInstalledCopy } from './installed-copy.mjs';

/**
 * @param {object} o
 * @param {string} o.repoRoot the plugin root holding the templates
 * @param {string[]} o.templateRels repo-relative template paths
 * @param {string[]} o.leads every lead to collect variants for
 * @param {(text: string, lead: string) => ({block: string} | null)} o.extractBlock
 * @param {Map<string, string>} o.currentBlocks lead → its current template block
 * @param {(line: string) => void} [o.warn]
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string}} [o.git]
 * @returns {Map<string, Set<string>>}
 */
export function historicalVariants({
  repoRoot,
  templateRels,
  leads,
  extractBlock,
  currentBlocks,
  warn = (line) => console.error(line),
  git = (args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' }),
}) {
  const variants = new Map(leads.map((l) => [l, new Set()]));
  for (const rel of templateRels) {
    const log = git(['log', '--format=%H', '--', rel]);
    if (log.status !== 0) {
      if (isInstalledCopy(repoRoot) || /not a git repository/i.test(log.stderr ?? '')) {
        warn(`stamp-contract: no git history at ${repoRoot} (installed plugin copy) — only the current template text counts as template-descended; older bullets read as drift`);
        return new Map(leads.map((l) => [l, new Set(currentBlocks.has(l) ? [currentBlocks.get(l)] : [])]));
      }
      throw new Error(`stamp-contract: git log failed in ${repoRoot}: ${log.stderr}`);
    }
    for (const sha of log.stdout.split('\n').filter(Boolean)) {
      const show = git(['show', `${sha}:${rel}`]);
      if (show.status !== 0) continue;
      for (const lead of leads) {
        const found = extractBlock(show.stdout, lead);
        if (found) variants.get(lead).add(found.block);
      }
    }
  }
  return variants;
}
