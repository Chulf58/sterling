// The stamp-contract tracked bullets: which template files carry them, which leads are
// tracked, renamed leads, and how a bullet block is located in a file. Shared by
// scripts/stamp-contract.mjs (the propagation run) and scripts/lib/bundled-artifacts.mjs
// (build:bin writes bin/contract-history.json from the same leads, so an installed copy
// with no git history still knows every older template-descended block).
//
// Builtins only (bundled into bin/stamp-contract.mjs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractHistorySnapshot } from './contract-history.mjs';
import { renderClaudeText } from './agent-fences.mjs';

// AGENTS.md/CLAUDE.md split (decision agents-md-is-the-instructions-file-claude-md-is-a-one-line-import,
// 161e2972): each TARGET_LEADS bullet lives in whichever template currently contains it, and
// propagates into the SAME layer file in a sibling. TEMPLATE_RELS is searched in this order to
// find a lead's home; historical ancestry is searched across BOTH files (a bullet may have moved
// from target-claude-md.md to target-agents-md.md at the split commit and keeps its ancestry).
export const AGENTS_TEMPLATE_REL = 'templates/target-agents-md.md';
export const CLAUDE_TEMPLATE_REL = 'templates/target-claude-md.md';
export const TEMPLATE_RELS = [AGENTS_TEMPLATE_REL, CLAUDE_TEMPLATE_REL];

// The bullets of the Domains section, in template order. The third lead runs past its bold
// part: '- **What not to do:**' alone could match a project's own bullet anywhere in either file.
const DOMAINS_LEADS = [
  '- **A domain is a shared knowledge store for one subject.**',
  '- **Mount every subject the project works with, its own subject included.**',
  '- **What not to do:** a Salesforce project',
  '- **A domain needs a description**',
  '- **Run `/sterling:domains` to see and change mounts.**',
];

// The propagated bullets, identified by their bold lead at line start.
export const TARGET_LEADS = [
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
  // INSERT_AFTER (scripts/stamp-contract.mjs), the {lead, insertAfter} generalization this
  // note once tracked.]
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
  // arrive through the insert path — see INSERT_AFTER in scripts/stamp-contract.mjs. Codex
  // stays BEFORE READY TO CLEAR here: leads are processed in order, and READY TO CLEAR
  // anchors on the Codex bullet, so a sibling missing both gets them back in template order.
  '- **Codex runs through the MCP tool, never the shell.**',
  '- **Say `READY TO CLEAR` plainly when it is time.**',
  // 2026-09-28: auto-memory is off (decision sterling-projects-run-with-claude-code-auto-memory-off),
  // and the new bullet replacing it reads right after "Ask, don't guess" in the template, so
  // that bullet is tracked here too (it was not before) purely to serve as this insert's anchor —
  // its own wording was already stable and unchanged, so tracking it adds no drift risk.
  "- **Ask, don't guess — through the AskUserQuestion tool.**",
  '- **Instruction-file proposals replace memory.**',
  // 2026-09-30: the plain-writing pair (decision write-plainly-everywhere-de-ai-pass-on-prose-deliverables).
  // Both are NEW to every sibling, so both arrive through INSERT_AFTER; the plain-writing bullet
  // is AGENTS.md-homed, the de-ai-writing pass bullet is CLAUDE.md-homed.
  '- **Write plainly; no AI tells.**',
  // 2026-10-05: lint and tests before a code change is reported done (user-ruled through the
  // question form). NEW to every sibling, so it arrives through INSERT_AFTER, anchored on the
  // two bullets above it in the template, which were already tracked. It stays AFTER the
  // plain-writing lead here: both anchor on "No false action claims", so a sibling missing
  // both gets them back in template order.
  '- **Lint and tests before done.**',
  '- **Run `sterling:de-ai-writing` on prose deliverables before they ship.**',
  // 2026-10-01: board every user ask at intake (decision
  // every-user-ask-is-boarded-at-intake-with-slim-blocked-by). Both bullets already exist in
  // most siblings under these same leads, so the REPLACE path carries the new wording; a
  // sibling that predates them gets them through INSERT_AFTER. Solve stays BEFORE Close-on-commit
  // here because Close-on-commit anchors on it.
  "- **Solve, don't board.**",
  '- **Close-on-commit: a commit that fulfils a board item pays it**',
  // 2026-10-02: Sterling defects are filed as scrubbed GitHub issues through report-issue.mjs
  // (decision projects-file-sterling-issues-as-scrubbed-github-issues-automatically). The bullet
  // already exists in every sibling under this lead, so the REPLACE path carries the new wording.
  "- **Stamp Sterling's version when reporting on Sterling.**",
  // 2026-10-04: the Domains section of AGENTS.md (decision
  // consumers-learn-domain-mounting-from-agents-md-and-a-domain-check-command). A project
  // initialized before the section existed has none of these and no heading for them, so the
  // whole section arrives through TARGET_SECTIONS below; from then on each bullet is an
  // ordinary tracked lead (replace, hand-tuned refusal, re-insert after the bullet before it).
  ...DOMAINS_LEADS,
];

// Tracked sections: a heading plus its bullets, inserted as one block before the `before`
// heading when the home file has neither the heading nor any of the bullets. A file with
// no `before` heading is refused (SECTION_ANCHOR_MISSING_REFUSED in scripts/stamp-contract.mjs),
// because a place for the section is never invented. A file that has a heading starting with
// the section's own heading but none of its bullets is refused too
// (SECTION_HEADING_WITHOUT_BULLETS_REFUSED): that heading is the project's, or the bullets
// were deleted on purpose. See headingIndex for how the two headings are matched.
export const TARGET_SECTIONS = [{ heading: '## Domains', before: '## Conventions', leads: DOMAINS_LEADS }];

// Renamed bullets: new lead → the old lead(s) it replaced. When the new lead is
// absent from a sibling, a block under an old lead is replaced by the new bullet
// ONLY if it matches a historical template variant of that old lead (P5 — a
// hand-tuned old block is refused exactly like the normal replace path).
export const RENAMED_LEADS = new Map([
  ['- **Knowledge is born structured.**', ["- **Notes are the user's surface.**"]],
  // 2026-10-01: Sterling's own CLAUDE.md carried these two bullets under shorter leads
  // that no template version ever used. Mapping them here means a sibling holding the
  // old wording is refused (or replaced, if it ever matches a template variant) instead
  // of getting a second copy through INSERT_AFTER.
  ["- **Solve, don't board.**", ["- **Solve, don't board**"]],
  ['- **Close-on-commit: a commit that fulfils a board item pays it**', ['- **Close-on-commit:**']],
]);

// Every lead whose historical variants are collected: the tracked leads plus the old
// leads of renamed bullets.
export const HISTORY_LEADS = [...TARGET_LEADS, ...[...RENAMED_LEADS.values()].flat()];

// A block = the bullet line plus continuation lines until the next top-level
// bullet, heading, or blank line (template bullets are single long lines today;
// the continuation rule keeps this robust if they ever wrap).
// Lines inside a fenced code block (``` or ~~~) are examples, never bullets (Sol review of
// b41f29d..f32c48a, HIGH): a lead is only ever located outside every fence.
// A fence closes only on a line of the SAME character with a run at least as long as its
// opener's (CommonMark; Sol re-check of af99713) — a ~~~ line inside a ``` fence is content.
// An unclosed fence runs to the end of the text, as in CommonMark.
export const FENCE = /^\s*(```|~~~)/;
// fenceSpans(lines) → Map(openerIndex → closerIndex) for every fenced block.
export function fenceSpans(lines) {
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
// The index of the first line outside every fence that is `heading`; -1 when there is none.
// Strict (the default, used to find where a section goes): the whole line, or the heading
// followed by ' (' as the templates write '## Conventions (lean …)'. A project's
// '## Conventions of naming' is not that heading. Loose (used to ask whether a project
// already has a heading of its own by that name): the heading followed by any text.
export function headingIndex(text, heading, { loose = false } = {}) {
  const lines = text.split('\n');
  const tail = loose ? ' ' : ' (';
  return unfencedLineIndexes(lines).find((i) => lines[i].trimEnd() === heading || lines[i].startsWith(`${heading}${tail}`)) ?? -1;
}
export function extractBlock(text, lead) {
  const lines = text.split('\n');
  const start = unfencedLineIndexes(lines).find((i) => lines[i].startsWith(lead)) ?? -1;
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^(- |#|\s*$)/.test(lines[end]) && !FENCE.test(lines[end])) end++;
  return { start, end, block: lines.slice(start, end).join('\n') };
}

// A template's bullets are read from its CLAUDE render (decision
// sterling-layer-is-one-source-with-host-blocks): siblings receive what init writes to
// CLAUDE.md, never a fence marker or an opencode-only line. A sibling's own text is never
// rendered, because its line indexes are where stamp-contract writes.
export function extractTemplateBlock(text, lead) {
  return extractBlock(renderClaudeText(text, 'template'), lead);
}

/**
 * Read both working-tree templates under repoRoot and locate every TARGET_LEADS bullet.
 * Throws when a lead is in neither template (P5).
 * @returns {{templates: Map<string,string>, leadLayer: Map<string,string>, current: Map<string,string>}}
 *   leadLayer: lead → the template rel it currently lives in; current: lead → its block there.
 */
export function readTemplateBullets(repoRoot) {
  const templates = new Map(TEMPLATE_RELS.map((rel) => [rel, readFileSync(join(repoRoot, rel), 'utf8')]));
  const leadLayer = new Map();
  const current = new Map();
  for (const lead of TARGET_LEADS) {
    const home = TEMPLATE_RELS.find((rel) => extractTemplateBlock(templates.get(rel), lead));
    if (!home) throw new Error(`stamp-contract: no template carries target bullet '${lead}' — refusing (P5)`);
    leadLayer.set(lead, home);
    current.set(lead, extractTemplateBlock(templates.get(home), lead).block);
  }
  return { templates, leadLayer, current };
}

/** The bin/contract-history.json content for the templates under repoRoot (requires git history). */
export function contractHistoryJson(repoRoot) {
  return contractHistorySnapshot({
    repoRoot,
    templateRels: TEMPLATE_RELS,
    leads: HISTORY_LEADS,
    extractBlock: extractTemplateBlock,
    currentBlocks: readTemplateBullets(repoRoot).current,
  });
}
