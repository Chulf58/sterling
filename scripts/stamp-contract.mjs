// stamp-contract [S] — propagate contract-wording bullets from
// templates/target-claude-md.md to every registered sibling project's CLAUDE.md
// (decision 7208729b wiring; second propagation after c76f63fa proved the need
// recurs). Deterministic (P3) and guarded:
//   - a sibling bullet is replaced ONLY when its current text matches some
//     HISTORICAL version of that bullet in the template's git history (a clean
//     template-descended block). Anything else is hand-tuned → refuse loudly,
//     print the diff, leave the file untouched (P5).
//   - a missing anchor bullet is drift → reported, never invented.
//   - dry-run by default; --apply writes.
//   node scripts/stamp-contract.mjs [--apply] [--project <repo_path>...]
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry, registryPath } from '@sterling/store';

const APPLY = process.argv.includes('--apply');
const onlyProjects = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--project' && process.argv[i + 1]) onlyProjects.push(resolve(process.argv[++i]));
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_REL = 'templates/target-claude-md.md';

// The propagated bullets, identified by their bold lead at line start.
const TARGET_LEADS = [
  '- **Reconcile _every affected_ article, not just the primary one**',
  '- **Concept articles — capture design the moment it settles',
  '- **Wired, not just asked:**',
];

// A block = the bullet line plus continuation lines until the next top-level
// bullet, heading, or blank line (template bullets are single long lines today;
// the continuation rule keeps this robust if they ever wrap).
function extractBlock(text, lead) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(lead));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^(- |#|\s*$)/.test(lines[end])) end++;
  return { start, end, block: lines.slice(start, end).join('\n') };
}

// Every historical variant of each target bullet, from the template's git log —
// the "clean template-descended" set a sibling block must match to be replaced.
function historicalVariants() {
  const log = spawnSync('git', ['log', '--format=%H', '--', TEMPLATE_REL], { cwd: repoRoot, encoding: 'utf8' });
  if (log.status !== 0) throw new Error(`stamp-contract: git log failed in ${repoRoot}: ${log.stderr}`);
  const variants = new Map(TARGET_LEADS.map((l) => [l, new Set()]));
  for (const sha of log.stdout.split('\n').filter(Boolean)) {
    const show = spawnSync('git', ['show', `${sha}:${TEMPLATE_REL}`], { cwd: repoRoot, encoding: 'utf8' });
    if (show.status !== 0) continue;
    for (const lead of TARGET_LEADS) {
      const found = extractBlock(show.stdout, lead);
      if (found) variants.get(lead).add(found.block);
    }
  }
  return variants;
}

const template = readFileSync(join(repoRoot, TEMPLATE_REL), 'utf8');
const current = new Map();
for (const lead of TARGET_LEADS) {
  const found = extractBlock(template, lead);
  if (!found) throw new Error(`stamp-contract: template lost target bullet '${lead}' — refusing (P5)`);
  current.set(lead, found.block);
}
const variants = historicalVariants();

const registry = new ProjectRegistry(registryPath());
let projects;
try {
  projects = registry.list();
} finally {
  registry.close();
}

const selfPath = realpathSync(repoRoot);
const results = [];
let drift = 0;

for (const p of projects) {
  const repo = p.repo_path;
  if (onlyProjects.length && !onlyProjects.includes(resolve(repo))) continue;
  if (!existsSync(repo)) {
    results.push({ project: p.name, status: 'missing_path', detail: repo });
    continue;
  }
  if (realpathSync(repo) === selfPath) continue; // the Sterling repo's own CLAUDE.md is hand-maintained in sync with the template
  const claudeMd = join(repo, 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    results.push({ project: p.name, status: 'no_claude_md', detail: claudeMd });
    drift++;
    continue;
  }

  let text = readFileSync(claudeMd, 'utf8');
  const actions = [];
  for (const lead of TARGET_LEADS) {
    const want = current.get(lead);
    const found = extractBlock(text, lead);
    if (found) {
      if (found.block === want) {
        actions.push({ lead, action: 'matches' });
        continue;
      }
      if (variants.get(lead).has(found.block)) {
        // clean template-descended block → replace
        const lines = text.split('\n');
        lines.splice(found.start, found.end - found.start, ...want.split('\n'));
        text = lines.join('\n');
        actions.push({ lead, action: APPLY ? 'updated' : 'would_update' });
      } else {
        actions.push({ lead, action: 'HAND_TUNED_REFUSED', have: found.block });
        drift++;
      }
      continue;
    }
    // Bullet absent. The Concept bullet is NEW — insert it after the sibling's
    // Reconcile bullet when that anchor is clean; everything else missing = drift.
    if (lead === TARGET_LEADS[1]) {
      const anchor = extractBlock(text, TARGET_LEADS[0]);
      if (anchor) {
        const lines = text.split('\n');
        lines.splice(anchor.end, 0, ...want.split('\n'));
        text = lines.join('\n');
        actions.push({ lead, action: APPLY ? 'inserted' : 'would_insert' });
        continue;
      }
    }
    actions.push({ lead, action: 'ANCHOR_MISSING_REFUSED' });
    drift++;
  }

  const dirty = actions.some((a) => ['updated', 'inserted'].includes(a.action));
  if (APPLY && dirty) writeFileSync(claudeMd, text);
  results.push({ project: p.name, status: 'processed', file: claudeMd, actions });
}

for (const r of results) {
  if (r.status !== 'processed') {
    console.log(`✗ ${r.project}: ${r.status} (${r.detail})`);
    continue;
  }
  console.log(`${r.actions.some((a) => a.action.includes('REFUSED')) ? '✗' : '•'} ${r.project} (${r.file})`);
  for (const a of r.actions) {
    console.log(`    ${a.action}  ${a.lead.slice(0, 60)}…`);
    if (a.have) console.log(`      sibling text (hand-tuned, NOT touched):\n      ${a.have.split('\n').join('\n      ')}`);
  }
}
console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN (no writes; pass --apply)'} — ${results.filter((r) => r.status === 'processed').length} project(s) processed, ${drift} refusal(s).`);
if (drift) {
  console.error('stamp-contract: drift refused above — resolve by hand (the sibling text differs from every template version) and re-run.');
  process.exit(2);
}
