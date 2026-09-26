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
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry, registryPath } from '@sterling/store';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const onlyProjects = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--project' && process.argv[i + 1]) onlyProjects.push(resolve(process.argv[++i]));
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// AGENTS.md/CLAUDE.md split (decision agents-md-is-the-instructions-file-claude-md-is-a-one-line-import,
// 161e2972): each TARGET_LEADS bullet lives in whichever template currently contains it, and
// propagates into the SAME layer file in a sibling. TEMPLATE_RELS is searched in this order to
// find a lead's home; historical ancestry is searched across BOTH files (a bullet may have moved
// from target-claude-md.md to target-agents-md.md at the split commit and keeps its ancestry).
const AGENTS_TEMPLATE_REL = 'templates/target-agents-md.md';
const CLAUDE_TEMPLATE_REL = 'templates/target-claude-md.md';
const TEMPLATE_RELS = [AGENTS_TEMPLATE_REL, CLAUDE_TEMPLATE_REL];

// The propagated bullets, identified by their bold lead at line start.
const TARGET_LEADS = [
  '- **Reconcile _every affected_ article, not just the primary one**',
  '- **Concept articles — capture design the moment it settles',
  '- **Wired, not just asked:**',
  // Added 2026-07-26 so the H19-delivery caveat reaches already-initialized
  // siblings. It rides INSIDE this existing bullet rather than arriving as a new
  // top-level one, so the REPLACE path carries it.
  //
  // CORRECTED 2026-07-26: an earlier version of this comment claimed a new bullet "would need an
  // insert capability this script does not have". That was FALSE — the insert path
  // exists at :127-137. What is true is narrower: that path is INDEX-PINNED, firing
  // only for TARGET_LEADS[1] and anchoring on TARGET_LEADS[0]. A lead appended at
  // any other index gets ANCHOR_MISSING_REFUSED, so folding was still the right
  // call for THIS bullet — but for that reason, not the one first written down.
  // [2026-09-26: the index pinning is gone — inserts are now declared per lead in
  // INSERT_AFTER, the {lead, insertAfter} generalization this note once tracked.]
  '- **Stage retrieval before acting**',
  // Added 2026-07-27. The mirror rule says the template is the SOURCE, but the two
  // had diverged and the stronger text was in Sterling's own CLAUDE.md — so seven
  // siblings were running weaker conduct rules than the repo that ships them. Both
  // bullets ALREADY EXIST in every sibling (they were generated from this template),
  // so these ride the REPLACE path; neither depends on the index-pinned insert above.
  // (The APPEND-ONLY constraint this note once stated died with the index pinning.)
  '- **Anti-speculation:**',
  '- **No false action claims:**',
  // 2026-08-11: the note surface was retired (decision 'note-surface-retired')
  // and the bullet's lead was renamed from "- **Notes are the user's surface.**"
  // to the one below. A renamed lead matches nothing in an already-stamped
  // sibling by itself, so RENAMED_LEADS below carries the old lead: a sibling
  // block found under the OLD lead is replaced by the new bullet under the SAME
  // template-descended guard as the normal replace path.
  '- **Knowledge is born structured.**',
  // 2026-09-26: the Codex and READY TO CLEAR bullets are NEW to older siblings, so they
  // arrive through the insert path — see INSERT_AFTER below. Codex stays BEFORE
  // READY TO CLEAR here: leads are processed in order, and READY TO CLEAR anchors on
  // the Codex bullet, so a sibling missing both gets them back in template order.
  '- **Codex runs through the MCP tool, never the shell.**',
  '- **Say `READY TO CLEAR` plainly when it is time.**',
];

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
]);

// Renamed bullets: new lead → the old lead(s) it replaced. When the new lead is
// absent from a sibling, a block under an old lead is replaced by the new bullet
// ONLY if it matches a historical template variant of that old lead (P5 — a
// hand-tuned old block is refused exactly like the normal replace path).
const RENAMED_LEADS = new Map([
  ['- **Knowledge is born structured.**', ["- **Notes are the user's surface.**"]],
]);

// CRLF handling (Sol review fix round, finding 6): comparisons run on a CR-stripped copy so a
// CRLF sibling is never spuriously treated as hand-tuned (the recorded stamp-contract CRLF
// hazard); a write converts back to the sibling's OWN original EOL, never forcing LF onto it.
const normalizeEol = (text) => text.replace(/\r\n/g, '\n');
const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const withEol = (lfText, eol) => (eol === '\r\n' ? lfText.replace(/\n/g, '\r\n') : lfText);

// A block = the bullet line plus continuation lines until the next top-level
// bullet, heading, or blank line (template bullets are single long lines today;
// the continuation rule keeps this robust if they ever wrap).
// Lines inside a fenced code block (``` or ~~~) are examples, never bullets (Sol review of
// b41f29d..f32c48a, HIGH): a lead is only ever located outside every fence.
// A fence closes only on a line of the SAME character with a run at least as long as its
// opener's (CommonMark; Sol re-check of af99713) — a ~~~ line inside a ``` fence is content.
// An unclosed fence runs to the end of the text, as in CommonMark.
const FENCE = /^\s*(```|~~~)/;
// fenceSpans(lines) → Map(openerIndex → closerIndex) for every fenced block.
function fenceSpans(lines) {
  const spans = new Map();
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (!open) continue;
    const ch = open[1][0];
    const closer = new RegExp(`^\\s*\\${ch}{${open[1].length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !closer.test(lines[j])) j++;
    spans.set(i, Math.min(j, lines.length - 1));
    i = j;
  }
  return spans;
}
function unfencedLineIndexes(lines) {
  const fenced = new Set();
  for (const [open, close] of fenceSpans(lines)) for (let k = open; k <= close; k++) fenced.add(k);
  return lines.map((_, i) => i).filter((i) => !fenced.has(i));
}
function extractBlock(text, lead) {
  const lines = text.split('\n');
  const start = unfencedLineIndexes(lines).find((i) => lines[i].startsWith(lead)) ?? -1;
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^(- |#|\s*$)/.test(lines[end]) && !FENCE.test(lines[end])) end++;
  return { start, end, block: lines.slice(start, end).join('\n') };
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

// Every historical variant of each target bullet, from BOTH templates' git log — the "clean
// template-descended" set a sibling block must match to be replaced. Searched across both files
// (not just the lead's current home) so a bullet that moved at the AGENTS.md/CLAUDE.md split
// commit keeps its pre-split ancestry.
function historicalVariants() {
  const allLeads = [...TARGET_LEADS, ...[...RENAMED_LEADS.values()].flat()];
  const variants = new Map(allLeads.map((l) => [l, new Set()]));
  for (const rel of TEMPLATE_RELS) {
    const log = spawnSync('git', ['log', '--format=%H', '--', rel], { cwd: repoRoot, encoding: 'utf8' });
    if (log.status !== 0) throw new Error(`stamp-contract: git log failed in ${repoRoot}: ${log.stderr}`);
    for (const sha of log.stdout.split('\n').filter(Boolean)) {
      const show = spawnSync('git', ['show', `${sha}:${rel}`], { cwd: repoRoot, encoding: 'utf8' });
      if (show.status !== 0) continue;
      for (const lead of allLeads) {
        const found = extractBlock(show.stdout, lead);
        if (found) variants.get(lead).add(found.block);
      }
    }
  }
  return variants;
}

const templates = new Map(TEMPLATE_RELS.map((rel) => [rel, readFileSync(join(repoRoot, rel), 'utf8')]));
const current = new Map();
const leadLayer = new Map(); // lead -> template rel it currently lives in (= the sibling file it propagates to)
for (const lead of TARGET_LEADS) {
  const home = TEMPLATE_RELS.find((rel) => extractBlock(templates.get(rel), lead));
  if (!home) throw new Error(`stamp-contract: no template carries target bullet '${lead}' — refusing (P5)`);
  leadLayer.set(lead, home);
  current.set(lead, extractBlock(templates.get(home), lead).block);
}
const variants = historicalVariants();
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
