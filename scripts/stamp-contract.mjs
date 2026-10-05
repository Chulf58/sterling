// stamp-contract [S] — propagate contract-wording bullets from
// templates/target-claude-md.md to every registered sibling project's CLAUDE.md
// (decision foreign_7208729b wiring; second propagation after foreign_c76f63fa proved the need
// recurs). Deterministic (P3) and guarded:
//   - a sibling bullet is replaced ONLY when its current text matches some
//     HISTORICAL version of that bullet in the template's git history (a clean
//     template-descended block). Anything else is hand-tuned → refuse loudly,
//     print the diff, leave the file untouched (P5).
//   - a missing anchor bullet is drift → reported, never invented.
//   - a tracked SECTION (TARGET_SECTIONS: a heading plus its bullets) that a sibling lacks
//     entirely is inserted whole before the heading it sits ahead of in the template; a
//     sibling with no such heading is refused, and its bullets are then not reported one by one.
//   - dry-run by default; --apply writes.
//   - a write touches only a file whose text changed. A file that cannot be written is that
//     project's refusal (WRITE_FAILED_REFUSED, exit 2), naming the path and the error; its
//     actions are then reported as would_*, never as written. Each project's result is
//     printed when that project is done, so a later failure cannot hide an earlier write.
//   - --apply-inserts writes NEW TEXT ONLY (user-ruled 2026-10-04, "Auto-insert, new text
//     only"): a section or tracked bullet that is entirely absent from the file is inserted
//     and listed; a block whose wording is old is reported as would_update / would_rename
//     exactly as the dry run reports it, and is not touched; hand-tuned text is still
//     refused. /sterling:update and the post-update sync run this mode. Replacing existing
//     wording stays the by-hand --apply.
//   - QUIET ON CLEAN: an in-sync project prints nothing and is counted in the
//     summary; --verbose restores the per-bullet listing. The caller that matters
//     is /sterling:update, where this block sits between build/test/check output
//     and a per-bullet inventory would bury the rare refusal (P1).
//   node scripts/stamp-contract.mjs [--apply | --apply-inserts] [--verbose] [--project <repo_path>...]
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
  TARGET_SECTIONS,
  RENAMED_LEADS,
  HISTORY_LEADS,
  FENCE,
  fenceSpans,
  extractBlock,
  extractTemplateBlock,
  headingIndex,
  readTemplateBullets,
} from './lib/contract-bullets.mjs';

const APPLY = process.argv.includes('--apply');
// --apply wins when both are given: it is the wider mode.
const APPLY_INSERTS = !APPLY && process.argv.includes('--apply-inserts');
const WRITE_INSERTS = APPLY || APPLY_INSERTS;
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
  ['- **Lint and tests before done.**', ['- **No false action claims:**', '- **Anti-speculation:**']],
  ['- **Run `sterling:de-ai-writing` on prose deliverables before they ship.**', ['- **Instruction-file proposals replace memory.**', "- **Ask, don't guess — through the AskUserQuestion tool.**"]],
  ["- **Solve, don't board.**", ['- **Run `sterling:de-ai-writing` on prose deliverables before they ship.**', '- **Instruction-file proposals replace memory.**', "- **Ask, don't guess — through the AskUserQuestion tool.**"]],
  ['- **Close-on-commit: a commit that fulfils a board item pays it**', ["- **Solve, don't board.**"]],
]);
// A section bullet missing from a sibling that has the section goes after the nearest
// section bullet above it. The first bullet has no anchor: without it the section's start is
// unknown, and that is ANCHOR_MISSING_REFUSED.
for (const section of TARGET_SECTIONS) {
  section.leads.forEach((lead, i) => {
    if (i > 0) INSERT_AFTER.set(lead, section.leads.slice(0, i).reverse());
  });
}

// LINE ENDINGS. Comparisons run on a CR-stripped copy, so a CRLF sibling is never spuriously
// treated as hand-tuned (the recorded stamp-contract CRLF hazard). A write puts every line
// that was already in the file back with the line ending it had, and gives each new line the
// ending of the line before it (of the line after it, at the top of the file). So a CRLF
// file stays CRLF, an LF file stays LF, and a file with mixed endings keeps every existing
// byte. The old and new line lists are aligned by their longest common subsequence, taking
// the earliest match, so pure inserts leave the original lines in place and in order.
const normalizeEol = (text) => text.replace(/\r\n/g, '\n');
function withOriginalEols(raw, finalLf) {
  const pieces = raw.split('\n');
  const oldLines = pieces.map((l, i) => (i < pieces.length - 1 && l.endsWith('\r') ? l.slice(0, -1) : l));
  const oldEols = pieces.map((l, i) => (i === pieces.length - 1 ? null : l.endsWith('\r') ? '\r\n' : '\n'));
  const newLines = finalLf.split('\n');
  const n = oldLines.length;
  const m = newLines.length;
  // lcs[i][j]: the longest common subsequence of oldLines[i:] and newLines[j:].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const eols = new Array(m).fill(null);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (oldLines[i] === newLines[j] && lcs[i][j] === lcs[i + 1][j + 1] + 1) eols[j++] = oldEols[i++];
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  const fallback = oldEols.find(Boolean) ?? '\n';
  let out = '';
  for (let j = 0; j < m - 1; j++) {
    // A new line, or the old last line (which had no ending) now followed by more text.
    if (!eols[j]) eols[j] = (j > 0 ? eols[j - 1] : eols.slice(1).find(Boolean)) ?? fallback;
    out += newLines[j] + eols[j];
  }
  return out + newLines[m - 1];
}

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
  extractBlock: extractTemplateBlock,
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

// QUIET ON CLEAN, LOUD ON DRIFT (P1). A fully in-sync project prints nothing —
// it is counted in the summary instead. This runs inside /sterling:update between
// the build/test/check blocks, where one 'matches' line per bullet per project
// (28 lines for seven clean siblings, observed 2026-07-27) buries the rare ✗ in a
// wall of green. Attention is spent only where something needs doing; --verbose
// restores the full per-bullet listing when you actually want the inventory.
// A project is printed as soon as it is done, so what was written is on record
// whatever happens to a later project.
let inSync = 0;
function record(r) {
  results.push(r);
  if (r.status !== 'processed') {
    console.log(`✗ ${r.project}: ${r.status} (${r.detail})`);
    return;
  }
  const notable = r.actions.filter((a) => a.action !== 'matches');
  if (!notable.length) {
    inSync++;
    if (!VERBOSE) return;
  }
  console.log(`${r.actions.some((a) => a.action.includes('REFUSED')) ? '✗' : '•'} ${r.project} (${r.file})`);
  for (const a of VERBOSE ? r.actions : notable) {
    console.log(`    ${a.action}  ${a.lead.slice(0, 60)}…`);
    if (a.detail) console.log(`      ${a.detail}`);
    if (a.have) console.log(`      sibling text (hand-tuned, NOT touched):\n      ${a.have.split('\n').join('\n      ')}`);
  }
}
// What a written action is called when its file could not be written.
const UNWRITTEN = { updated: 'would_update', inserted: 'would_insert', renamed: 'would_rename', section_inserted: 'would_insert_section' };

for (const p of projects) {
  const repo = p.repo_path;
  if (onlyProjects.length && !onlyProjects.includes(resolve(repo))) continue;
  if (!existsSync(repo)) {
    record({ project: p.name, status: 'missing_path', detail: repo });
    continue;
  }
  if (realpathSync(repo) === selfPath) continue; // the Sterling repo's own contract files are hand-maintained in sync with the templates
  const agentsMd = join(repo, 'AGENTS.md');
  const claudeMd = join(repo, 'CLAUDE.md');
  if (!existsSync(agentsMd)) {
    record({ project: p.name, status: 'not_migrated', detail: `no AGENTS.md — run: node "<Sterling root>/bin/init.mjs" --target ${repo}` });
    drift++;
    continue;
  }
  if (!existsSync(claudeMd)) {
    record({ project: p.name, status: 'no_claude_md', detail: claudeMd });
    drift++;
    continue;
  }

  const loadSibling = (path) => {
    const raw = readFileSync(path, 'utf8');
    const text = normalizeEol(raw);
    return { path, raw, original: text, text };
  };
  const siblingFiles = new Map([[AGENTS_TEMPLATE_REL, loadSibling(agentsMd)], [CLAUDE_TEMPLATE_REL, loadSibling(claudeMd)]]);
  const actions = [];
  // Only a bullet that validated THIS run (in sync, or replaced by the current wording) may
  // anchor an insert — a refused block is never restructured by an insert beside it.
  const VALID_ANCHOR = new Set(['matches', 'updated', 'would_update', 'inserted', 'would_insert', 'renamed', 'would_rename']);
  const outcome = (lead) => [...actions].reverse().find((a) => a.lead === lead)?.action;
  // Whole sections first. A sibling with the heading, or with any of the section's bullets
  // in either file, is left to the per-lead loop below.
  const sectionRefused = new Set();
  for (const section of TARGET_SECTIONS) {
    const home = leadLayer.get(section.leads[0]);
    const target = siblingFiles.get(home);
    if (section.leads.some((lead) => [...siblingFiles.values()].some((f) => extractBlock(f.text, lead)))) continue;
    const label = `${section.heading} (section)`;
    // A heading by that name with none of the section's bullets is the project's own
    // section, or Sterling's with every bullet deleted. One refusal, not one per bullet.
    const own = headingIndex(target.text, section.heading, { loose: true });
    if (own !== -1) {
      actions.push({
        lead: label,
        action: 'SECTION_HEADING_WITHOUT_BULLETS_REFUSED',
        file: layerFileName(home),
        detail: `${layerFileName(home)} already has a '${target.text.split('\n')[own].trim()}' heading and none of the '${section.heading}' bullets. To get Sterling's section, rename that heading and re-run; or copy the bullets from ${home} under it.`,
      });
      drift++;
      for (const lead of section.leads) sectionRefused.add(lead);
      continue;
    }
    const at = headingIndex(target.text, section.before);
    if (at === -1) {
      actions.push({
        lead: label,
        action: 'SECTION_ANCHOR_MISSING_REFUSED',
        file: layerFileName(home),
        detail: `${layerFileName(home)} has no '${section.before}' heading to put the section before. Copy the '${section.heading}' section from ${home} to where it belongs and re-run.`,
      });
      drift++;
      for (const lead of section.leads) sectionRefused.add(lead);
      continue;
    }
    const lines = target.text.split('\n');
    const block = [section.heading, '', ...section.leads.flatMap((lead) => current.get(lead).split('\n')), ''];
    if (at > 0 && lines[at - 1].trim() !== '') block.unshift('');
    lines.splice(at, 0, ...block);
    target.text = lines.join('\n');
    actions.push({ lead: label, action: WRITE_INSERTS ? 'section_inserted' : 'would_insert_section', file: layerFileName(home) });
  }
  for (const lead of TARGET_LEADS) {
    if (sectionRefused.has(lead)) continue;
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
        // clean template-descended block → replace. Not in --apply-inserts: that mode
        // writes the text it holds, so the old wording has to stay in it.
        if (!APPLY_INSERTS) {
          const lines = target.text.split('\n');
          lines.splice(found.start, found.end - found.start, ...want.split('\n'));
          target.text = lines.join('\n');
        }
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
        if (!APPLY_INSERTS) {
          const lines = target.text.split('\n');
          lines.splice(oldFound.start, oldFound.end - oldFound.start, ...want.split('\n'));
          target.text = lines.join('\n');
        }
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
      // In --apply-inserts a would_rename anchor still sits under its old lead.
      .map((a) => extractBlock(target.text, a) ?? (RENAMED_LEADS.get(a) ?? []).map((old) => extractBlock(target.text, old)).find(Boolean))
      .find(Boolean);
    if (anchor) {
      const lines = target.text.split('\n');
      lines.splice(itemEnd(target.text, anchor.start), 0, ...want.split('\n'));
      target.text = lines.join('\n');
      actions.push({ lead, action: WRITE_INSERTS ? 'inserted' : 'would_insert', file: layerFileName(home) });
      continue;
    }
    actions.push({ lead, action: 'ANCHOR_MISSING_REFUSED', file: layerFileName(home) });
    drift++;
  }

  // Only a file whose text changed is written. In a dry run nothing is; in --apply-inserts
  // the text holds inserts only.
  if (WRITE_INSERTS) {
    for (const [rel, f] of siblingFiles) {
      if (f.text === f.original) continue;
      try {
        writeFileSync(f.path, withOriginalEols(f.raw, f.text));
      } catch (err) {
        const file = layerFileName(rel);
        for (const a of actions) if (a.file === file && UNWRITTEN[a.action]) a.action = UNWRITTEN[a.action];
        actions.push({
          lead: `${file} (write)`,
          action: 'WRITE_FAILED_REFUSED',
          file,
          detail: `${f.path} could not be written (${err?.code ?? 'error'}: ${err?.message ?? err}). Nothing in it was changed; make the file writable and re-run.`,
        });
        drift++;
      }
    }
  }
  record({ project: p.name, status: 'processed', file: `${agentsMd} + ${claudeMd}`, actions });
}

const processed = results.filter((r) => r.status === 'processed').length;
console.log(
  `\n${APPLY ? 'APPLIED' : APPLY_INSERTS ? 'INSERTS APPLIED (new text only; existing wording is never replaced without --apply)' : 'DRY-RUN (no writes; pass --apply)'} — ${processed} project(s) processed, ` +
    `${inSync} already in sync, ${drift} refusal(s).` +
    (!VERBOSE && inSync ? ' Pass --verbose to list the in-sync bullets.' : '')
);
if (drift) {
  console.error('stamp-contract: refused above — resolve each by hand (sibling text that differs from every template version, a missing anchor, or a file that could not be written) and re-run.');
  process.exit(2);
}
