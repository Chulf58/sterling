// stamp-contract [S] — propagate contract-wording bullets from
// templates/target-claude-md.md to every registered sibling project's CLAUDE.md
// (decision foreign_7208729b wiring; second propagation after foreign_c76f63fa proved the need
// recurs). Deterministic (P3) and guarded:
//   - a sibling bullet is replaced ONLY when its current text matches some
//     HISTORICAL version of that bullet in the template's git history (a clean
//     template-descended block). Anything else is hand-tuned → refuse loudly,
//     print the diff, leave the file untouched (P5).
//   - a missing anchor bullet is drift → reported, never invented.
//   - dry-run by default; --apply writes.
//   - QUIET ON CLEAN: an in-sync project prints nothing and is counted in the
//     summary; --verbose restores the per-bullet listing. The caller that matters
//     is /sterling:update, where this block sits between build/test/check output
//     and a per-bullet inventory would bury the rare refusal (P1).
//   node scripts/stamp-contract.mjs [--apply] [--verbose] [--project <repo_path>...]
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry, registryPath } from '@sterling/store';
import { historicalVariants } from './lib/contract-history.mjs';
import {
  AGENTS_TEMPLATE_REL,
  CLAUDE_TEMPLATE_REL,
  TEMPLATE_RELS,
  TARGET_LEADS,
  RENAMED_LEADS,
  HISTORY_LEADS,
  FENCE,
  fenceSpans,
  extractBlock,
  readTemplateBullets,
} from './lib/contract-bullets.mjs';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const onlyProjects = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--project' && process.argv[i + 1]) onlyProjects.push(resolve(process.argv[++i]));
}

// The plugin root, from this file's location: scripts/.. in a clone, and the same root
// when run as bin/stamp-contract.mjs, whose bundle rewrites import.meta.url to this source
// path (sourceIdentityPlugin in scripts/lib/bundled-artifacts.mjs).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// The tracked leads, the template files and block extraction live in
// scripts/lib/contract-bullets.mjs, shared with build:bin's bin/contract-history.json.
//
// Insertable bullets: lead → the anchor lead(s) it goes after, tried in order. A lead
// absent from a sibling (and not renamed) is inserted after the FIRST anchor the sibling
// carries; with no anchor present it is ANCHOR_MISSING_REFUSED. Declared per lead, so
// reordering TARGET_LEADS no longer retargets an insert (the old index-pinned hazard).
// READY TO CLEAR sits after the Codex bullet in the template; when the Codex bullet is
// refused (e.g. present only in the wrong layer) the Knowledge bullet is the fallback.
const INSERT_AFTER = new Map([
  ['- **Concept articles — capture design the moment it settles', ['- **Reconcile _every affected_ article, not just the primary one**']],
  ['- **Codex runs through the MCP tool, never the shell.**', ['- **Knowledge is born structured.**']],
  ['- **Say `READY TO CLEAR` plainly when it is time.**', ['- **Codex runs through the MCP tool, never the shell.**', '- **Knowledge is born structured.**']],
  ['- **Instruction-file proposals replace memory.**', ["- **Ask, don't guess — through the AskUserQuestion tool.**"]],
  ['- **Write plainly; no AI tells.**', ['- **No false action claims:**', '- **Anti-speculation:**']],
  ['- **Run `sterling:de-ai-writing` on prose deliverables before they ship.**', ['- **Instruction-file proposals replace memory.**', "- **Ask, don't guess — through the AskUserQuestion tool.**"]],
]);

// CRLF handling (Sol review fix round, finding 6): comparisons run on a CR-stripped copy so a
// CRLF sibling is never spuriously treated as hand-tuned (the recorded stamp-contract CRLF
// hazard); a write converts back to the sibling's OWN original EOL, never forcing LF onto it.
const normalizeEol = (text) => text.replace(/\r\n/g, '\n');
const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const withEol = (lfText, eol) => (eol === '\r\n' ? lfText.replace(/\n/g, '\r\n') : lfText);

// Where to INSERT after a list item: past its whole extent, including blank-separated INDENTED
// continuation paragraphs, so an insert never lands inside an item. extractBlock's stop at the
// first blank line stays as it is — it defines the compared block, not the item's extent.
// An INDENTED fenced block continues the item and is taken whole, through its closing fence
// (Sol re-check of af99713); an unindented fence starts a new top-level block and ends it.
function itemEnd(text, start) {
  const lines = text.split('\n');
  const spans = fenceSpans(lines);
  let end = start + 1;
  let i = start + 1;
  while (i < lines.length) {
    if (/^\s*$/.test(lines[i])) {
      let j = i;
      while (j < lines.length && /^\s*$/.test(lines[j])) j++;
      if (j < lines.length && /^\s+\S/.test(lines[j])) {
        i = j;
        continue;
      }
      break;
    }
    if (/^\s+/.test(lines[i]) && spans.has(i)) {
      end = i = spans.get(i) + 1;
      continue;
    }
    if (/^(- |#)/.test(lines[i]) || FENCE.test(lines[i])) break;
    end = ++i;
  }
  return end;
}

// leadLayer: lead -> template rel it currently lives in (= the sibling file it propagates to).
const { leadLayer, current } = readTemplateBullets(repoRoot);
// Historical variants (scripts/lib/contract-history.mjs): the git history of both
// templates, or on an installed copy with no history bin/contract-history.json plus the
// current text.
const variants = historicalVariants({
  repoRoot,
  templateRels: TEMPLATE_RELS,
  leads: HISTORY_LEADS,
  extractBlock,
  currentBlocks: current,
});
const layerFileName = (rel) => (rel === AGENTS_TEMPLATE_REL ? 'AGENTS.md' : 'CLAUDE.md');

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
  if (realpathSync(repo) === selfPath) continue; // the Sterling repo's own contract files are hand-maintained in sync with the templates
  const agentsMd = join(repo, 'AGENTS.md');
  const claudeMd = join(repo, 'CLAUDE.md');
  if (!existsSync(agentsMd)) {
    results.push({ project: p.name, status: 'not_migrated', detail: `no AGENTS.md — run: node scripts/init.mjs --target ${repo}` });
    drift++;
    continue;
  }
  if (!existsSync(claudeMd)) {
    results.push({ project: p.name, status: 'no_claude_md', detail: claudeMd });
    drift++;
    continue;
  }

  const loadSibling = (path) => {
    const raw = readFileSync(path, 'utf8');
    return { path, eol: detectEol(raw), text: normalizeEol(raw) };
  };
  const siblingFiles = new Map([[AGENTS_TEMPLATE_REL, loadSibling(agentsMd)], [CLAUDE_TEMPLATE_REL, loadSibling(claudeMd)]]);
  const actions = [];
  // Only a bullet that validated THIS run (in sync, or replaced by the current wording) may
  // anchor an insert — a refused block is never restructured by an insert beside it.
  const VALID_ANCHOR = new Set(['matches', 'updated', 'would_update', 'inserted', 'would_insert', 'renamed', 'would_rename']);
  const outcome = (lead) => [...actions].reverse().find((a) => a.lead === lead)?.action;
  for (const lead of TARGET_LEADS) {
    const home = leadLayer.get(lead);
    const other = TEMPLATE_RELS.find((rel) => rel !== home);
    const want = current.get(lead);
    const target = siblingFiles.get(home);
    const foundInOther = extractBlock(siblingFiles.get(other).text, lead);
    if (foundInOther) {
      // A bullet present in the WRONG layer must never gain a second copy in the home file —
      // checked BEFORE any replace/rename/insert path, whether or not it is ALSO present (a true
      // duplicate) in the home layer (Sol review fix round, finding 6).
      const foundHome = extractBlock(target.text, lead);
      if (foundHome) {
        actions.push({ lead, action: 'DUPLICATE_REFUSED', file: layerFileName(home), have: foundHome.block });
      } else {
        actions.push({ lead, action: 'WRONG_LAYER_REFUSED', file: layerFileName(other), have: foundInOther.block });
      }
      drift++;
      continue;
    }
    const found = extractBlock(target.text, lead);
    if (found) {
      if (found.block === want) {
        actions.push({ lead, action: 'matches', file: layerFileName(home) });
        continue;
      }
      if (variants.get(lead).has(found.block)) {
        // clean template-descended block → replace
        const lines = target.text.split('\n');
        lines.splice(found.start, found.end - found.start, ...want.split('\n'));
        target.text = lines.join('\n');
        actions.push({ lead, action: APPLY ? 'updated' : 'would_update', file: layerFileName(home) });
      } else {
        actions.push({ lead, action: 'HAND_TUNED_REFUSED', file: layerFileName(home), have: found.block });
        drift++;
      }
      continue;
    }
    // Bullet absent. A RENAMED bullet may still sit under its old lead — replace
    // a clean template-descended old block with the new bullet; a hand-tuned old
    // block is refused (P5), same as the normal replace path.
    let renamed = false;
    for (const oldLead of RENAMED_LEADS.get(lead) ?? []) {
      const oldFound = extractBlock(target.text, oldLead);
      if (!oldFound) continue;
      renamed = true;
      if (variants.get(oldLead).has(oldFound.block)) {
        const lines = target.text.split('\n');
        lines.splice(oldFound.start, oldFound.end - oldFound.start, ...want.split('\n'));
        target.text = lines.join('\n');
        actions.push({ lead, action: APPLY ? 'renamed' : 'would_rename', file: layerFileName(home) });
      } else {
        actions.push({ lead, action: 'HAND_TUNED_REFUSED', file: layerFileName(home), have: oldFound.block });
        drift++;
      }
      break;
    }
    if (renamed) continue;
    // An insertable bullet goes after the first anchor in its chain that validated this run,
    // past that anchor's whole list item; everything else missing = drift.
    const anchor = (INSERT_AFTER.get(lead) ?? [])
      .filter((a) => VALID_ANCHOR.has(outcome(a)))
      .map((a) => extractBlock(target.text, a))
      .find(Boolean);
    if (anchor) {
      const lines = target.text.split('\n');
      lines.splice(itemEnd(target.text, anchor.start), 0, ...want.split('\n'));
      target.text = lines.join('\n');
      actions.push({ lead, action: APPLY ? 'inserted' : 'would_insert', file: layerFileName(home) });
      continue;
    }
    actions.push({ lead, action: 'ANCHOR_MISSING_REFUSED', file: layerFileName(home) });
    drift++;
  }

  const dirty = actions.some((a) => ['updated', 'inserted', 'renamed'].includes(a.action));
  if (APPLY && dirty) {
    for (const { path, text, eol } of siblingFiles.values()) writeFileSync(path, withEol(text, eol));
  }
  results.push({ project: p.name, status: 'processed', file: `${agentsMd} + ${claudeMd}`, actions });
}

// QUIET ON CLEAN, LOUD ON DRIFT (P1). A fully in-sync project prints nothing —
// it is counted in the summary instead. This runs inside /sterling:update between
// the build/test/check blocks, where one 'matches' line per bullet per project
// (28 lines for seven clean siblings, observed 2026-07-27) buries the rare ✗ in a
// wall of green. Attention is spent only where something needs doing; --verbose
// restores the full per-bullet listing when you actually want the inventory.
let inSync = 0;
for (const r of results) {
  if (r.status !== 'processed') {
    console.log(`✗ ${r.project}: ${r.status} (${r.detail})`);
    continue;
  }
  const notable = r.actions.filter((a) => a.action !== 'matches');
  if (!notable.length) {
    inSync++;
    if (!VERBOSE) continue;
  }
  console.log(`${r.actions.some((a) => a.action.includes('REFUSED')) ? '✗' : '•'} ${r.project} (${r.file})`);
  for (const a of VERBOSE ? r.actions : notable) {
    console.log(`    ${a.action}  ${a.lead.slice(0, 60)}…`);
    if (a.have) console.log(`      sibling text (hand-tuned, NOT touched):\n      ${a.have.split('\n').join('\n      ')}`);
  }
}
const processed = results.filter((r) => r.status === 'processed').length;
console.log(
  `\n${APPLY ? 'APPLIED' : 'DRY-RUN (no writes; pass --apply)'} — ${processed} project(s) processed, ` +
    `${inSync} already in sync, ${drift} refusal(s).` +
    (!VERBOSE && inSync ? ' Pass --verbose to list the in-sync bullets.' : '')
);
if (drift) {
  console.error('stamp-contract: drift refused above — resolve by hand (the sibling text differs from every template version) and re-run.');
  process.exit(2);
}
