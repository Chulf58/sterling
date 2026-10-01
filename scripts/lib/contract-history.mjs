// Every historical variant of each stamp-contract target bullet, from the templates'
// git log — the "clean template-descended" set a sibling block must match to be
// replaced. Searched across every template file (not just a lead's current home) so a
// bullet that moved at the AGENTS.md/CLAUDE.md split commit keeps its pre-split
// ancestry.
//
// NO GIT REPOSITORY (an installed plugin copy, decision
// sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone): there is no
// history to read, so the historical set comes from bin/contract-history.json, which
// build:bin writes from the same git walk (contractHistorySnapshot below), unioned with
// the CURRENT template text. The snapshot leaves out every block equal to the current
// working-tree template block, so committing a template edit does not change it and
// bin/ stays fresh across that commit. With the snapshot missing or unparseable only
// the current text counts and an older sibling bullet reads as drift (exit 2, which
// H1's post-update sync tolerates); that degraded path is said once on stderr. Every
// OTHER git failure, and every other snapshot read error, still throws (P5).
//
// Builtins only (bundled into bin/stamp-contract.mjs).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInstalledCopy } from './installed-copy.mjs';

export const CONTRACT_HISTORY_REL = 'bin/contract-history.json';

// lead → Set of every block found in every committed version of every template, or
// null when there is no git repository at repoRoot. An installed copy returns null
// before git runs: nested inside some unrelated repo, `git log -- <rel>` would walk up
// to that repo, exit 0 with no commits, and hide the missing history.
function gitVariants({ repoRoot, templateRels, leads, extractBlock, git }) {
  if (isInstalledCopy(repoRoot)) return null;
  const variants = new Map(leads.map((l) => [l, new Set()]));
  for (const rel of templateRels) {
    const log = git(['log', '--format=%H', '--', rel]);
    if (log.status !== 0) {
      if (/not a git repository/i.test(log.stderr ?? '')) return null;
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

// The shipped snapshot as {ok: true, blocks} or {ok: false, reason}. Only a missing
// file or bad content degrades; any other read error throws.
function loadSnapshot(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, reason: `${path} is missing` };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `${path} is unparseable (${err.message})` };
  }
  const valid =
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Object.values(parsed).every((v) => Array.isArray(v) && v.every((b) => typeof b === 'string'));
  if (!valid) return { ok: false, reason: `${path} is unparseable (expected an object of lead → string[])` };
  return { ok: true, blocks: parsed };
}

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
  const fromGit = gitVariants({ repoRoot, templateRels, leads, extractBlock, git });
  if (fromGit) return fromGit;
  const currentOnly = () => new Map(leads.map((l) => [l, new Set(currentBlocks.has(l) ? [currentBlocks.get(l)] : [])]));
  const snapshot = loadSnapshot(join(repoRoot, CONTRACT_HISTORY_REL));
  if (!snapshot.ok) {
    warn(`stamp-contract: DEGRADED — no git history at ${repoRoot} (installed plugin copy) and ${snapshot.reason} — only the current template text counts as template-descended; older bullets read as drift`);
    return currentOnly();
  }
  const variants = currentOnly();
  const absent = leads.filter((l) => !Object.hasOwn(snapshot.blocks, l));
  if (absent.length) {
    warn(`stamp-contract: DEGRADED — ${join(repoRoot, CONTRACT_HISTORY_REL)} has no entry for ${absent.length} lead(s) (${absent.join(' | ')}) — only their current template text counts as template-descended`);
  }
  for (const lead of leads) for (const block of snapshot.blocks[lead] ?? []) variants.get(lead).add(block);
  return variants;
}

/**
 * The bin/contract-history.json content: for each lead, every distinct block from every
 * committed version of every template, minus the lead's current working-tree block.
 * Sorted keys, sorted arrays, trailing newline, so the output is deterministic. Throws
 * when there is no git history to read (a snapshot of nothing would ship silently).
 * @param {object} o same shape as historicalVariants' input, minus warn
 * @returns {string}
 */
export function contractHistorySnapshot({
  repoRoot,
  templateRels,
  leads,
  extractBlock,
  currentBlocks,
  git = (args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' }),
}) {
  const variants = gitVariants({ repoRoot, templateRels, leads, extractBlock, git });
  if (!variants) throw new Error(`contract history: no git history at ${repoRoot} — ${CONTRACT_HISTORY_REL} can only be built from a clone`);
  const out = {};
  for (const lead of [...leads].sort()) {
    out[lead] = [...variants.get(lead)].filter((b) => b !== currentBlocks.get(lead)).sort();
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}
