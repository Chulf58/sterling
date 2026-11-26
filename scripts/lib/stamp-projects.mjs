// The contract stamper [S]: propagate contract-wording bullets from templates/target-agents-md.md
// into the AGENTS.md of each project it is given, outside its generated Sterling layer section.
// Two callers, one list each: scripts/stamp-contract.mjs (the interactive CLI, which reads the
// registry and maps --project values) and /sterling:update (scripts/lib/update.mjs, which passes
// the registry rows it refreshed and checked, minus Sterling source trees). Nothing here reads the
// registry or argv, and every result is structured, so no caller parses text (decision
// 329-rebuild-how-sterling-update-stamps-sibling-projects-as-o).
// CLAUDE.md and GEMINI.md are never read or written: the layer is a generated AGENTS.md section
// that init and update regenerate (decision
// project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer, GitHub #329).
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
//   - an absent bullet is NOT inserted when the project already states the rule under its own
//     bullet (SUBJECT_MARKERS in scripts/lib/contract-bullets.mjs, matched against other
//     bullets' bold leads): one SIMILAR_BULLET_KEPT info line names that bullet, exit stays 0
//     (decision stamp-contract-skips-insert-when-project-bullet-covers-the-rule, issue #111).
//   - dry-run by default; apply writes.
//   - a write touches only a file whose text changed. A file that cannot be written is that
//     project's refusal (WRITE_FAILED_REFUSED), naming the path and the error; its actions are
//     then reported as would_*, never as written. onResult gets each project's result when that
//     project is done, so a later failure cannot hide an earlier write.
//   - applyInserts writes NEW TEXT ONLY (user-ruled 2026-10-04, "Auto-insert, new text
//     only"): a section or tracked bullet that is entirely absent from the file is inserted
//     and listed; a block whose wording is old is reported as would_update / would_rename
//     exactly as the dry run reports it, and is not touched; hand-tuned text is still
//     refused. /sterling:update and the post-update sync run this mode. Replacing existing
//     wording stays the by-hand --apply.
//   - QUIET ON CLEAN (stampResultLines): an in-sync project prints nothing and is counted in the
//     summary; verbose restores the per-bullet listing. The caller that matters is
//     /sterling:update, where this block sits between build/test/check output and a per-bullet
//     inventory would bury the rare refusal (P1).
// Builtins and builtins-only libs, transitively: lib/update.mjs imports this, and it must load on
// an unbuilt clone (BOOTSTRAP INDEPENDENCE in scripts/update.mjs).
import { writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { historicalVariants } from './contract-history.mjs';
import { looksLikeSterlingSourceTree } from './sterling-source-tree.mjs';
import { LayerMarkerError, layerLineRange, plannedAgentsMdRefusal, readAgentsMd } from './sterling-layer.mjs';
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
  findCoveringBullet,
  INSERT_AFTER,
} from './contract-bullets.mjs';

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

// The generated Sterling layer section stands as this one line while bullets are matched.
const LAYER_MASK = '<!-- sterling layer section: generated, never stamped -->';
function unmask(text, layerLines) {
  if (!layerLines.length) return text;
  const lines = text.split('\n');
  const at = lines.indexOf(LAYER_MASK);
  if (at === -1 || lines.indexOf(LAYER_MASK, at + 1) !== -1) throw new Error('stamp-contract: the Sterling layer section mask was lost while stamping AGENTS.md (a bug; nothing was written)');
  lines.splice(at, 1, ...layerLines);
  return lines.join('\n');
}

// What a written action is called when its file could not be written.
const UNWRITTEN = { updated: 'would_update', inserted: 'would_insert', renamed: 'would_rename', section_inserted: 'would_insert_section' };
// Only a bullet that validated THIS run (in sync, or replaced by the current wording) may
// anchor an insert — a refused block is never restructured by an insert beside it.
const VALID_ANCHOR = new Set(['matches', 'updated', 'would_update', 'inserted', 'would_insert', 'renamed', 'would_rename']);
const isRefusal = (a) => a.action.includes('REFUSED');

/**
 * Stamp each row's AGENTS.md. One result per row, in row order:
 * { row, project, path, status, actions, reason }
 *   status 'skipped'      nothing read: reason 'stale_path' (the directory does not exist),
 *                         'running_clone' (repoRoot itself) or 'sterling_source_tree';
 *          'not_migrated' no AGENTS.md; reason says what to run;
 *          'refused'      at least one *_REFUSED action;
 *          'stamped'      something to report (an insert, old wording, a kept bullet);
 *          'in_sync'      every tracked bullet matches.
 *   actions [{ lead, action, file, detail?, have?, info? }]
 * An empty `rows` reads nothing and returns []. A thrown error (an unreadable template, a bug)
 * propagates: the caller decides what a crash means.
 * @param {Array<{name: string, repo_path: string, dir?: string}>} rows `dir` is where AGENTS.md
 *   lives when it is not repo_path (a linked worktree of the registered project).
 * @param {object} o
 * @param {string} o.repoRoot the Sterling root whose templates and history are stamped
 * @param {boolean} [o.apply] replace old wording too (the by-hand --apply)
 * @param {boolean} [o.applyInserts] write only text that is entirely absent
 * @param {(line: string) => void} [o.warn] a DEGRADED history notice
 * @param {(result: object) => void} [o.onResult] called as each project is done
 */
export function stampProjects(rows, { repoRoot, apply = false, applyInserts = false, warn, onResult = () => {} }) {
  if (!rows.length) return [];
  if (!repoRoot) throw new Error('stampProjects: repoRoot is required');
  // --apply wins when both are given: it is the wider mode.
  const APPLY = apply;
  const APPLY_INSERTS = !apply && applyInserts;
  const WRITE_INSERTS = APPLY || APPLY_INSERTS;
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
    ...(warn ? { warn } : {}),
  });
  const selfPath = realpathSync(repoRoot);
  const results = [];
  const done = (r) => {
    results.push(r);
    onResult(r);
  };

  for (const row of rows) {
    const repo = row.dir ?? row.repo_path;
    const project = repo === row.repo_path ? row.name : `${row.name} [worktree ${repo}; the main checkout is not touched]`;
    const agentsMd = join(repo, 'AGENTS.md');
    const result = (status, actions = [], reason = null) => done({ row, project, path: agentsMd, status, actions, reason });
    // A registered path that no longer exists is a stale registry entry, not a failure of this run.
    if (!existsSync(repo)) {
      result('skipped', [], 'stale_path');
      continue;
    }
    // The Sterling repo's own contract files are hand-maintained in sync with the templates, and
    // so are any other Sterling checkout's (review loop 7 of #329).
    if (realpathSync(repo) === selfPath) {
      result('skipped', [], 'running_clone');
      continue;
    }
    if (looksLikeSterlingSourceTree(repo)) {
      result('skipped', [], 'sterling_source_tree');
      continue;
    }
    // AGENTS.md is read only as a plain, singly linked, lossless UTF-8 file inside the project
    // (readAgentsMd): a symlink or hard link would carry the stamp into another file.
    let agentsFile;
    try {
      agentsFile = readAgentsMd(repo);
    } catch (err) {
      if (!(err instanceof LayerMarkerError)) throw err;
      result('refused', [{ lead: 'AGENTS.md', action: 'AGENTS_MD_REFUSED', file: 'AGENTS.md', detail: `${err.message}. Nothing was stamped.` }]);
      continue;
    }
    if (!agentsFile.exists) {
      result('not_migrated', [], `no AGENTS.md — run: node "<Sterling root>/bin/init.mjs" --target ${repo}`);
      continue;
    }
    // Only the project's own text is stamped: the generated layer section is swapped for one mask
    // line while the bullets are matched, and put back, unchanged, before the write. The bullets of
    // templates/target-claude-md.md are not stamped anywhere (the layer section carries them).
    const raw = agentsFile.text;
    const normalized = normalizeEol(raw);
    let range;
    try {
      range = layerLineRange(normalized);
    } catch (err) {
      if (!(err instanceof LayerMarkerError)) throw err;
      result('refused', [{ lead: 'Sterling layer section', action: 'LAYER_MARKERS_REFUSED', file: 'AGENTS.md', detail: `${err.message}; nothing in AGENTS.md was stamped. Fix the markers by hand, then rerun /sterling:update.` }]);
      continue;
    }
    const normalizedLines = normalized.split('\n');
    const layerLines = range.begin === null ? [] : normalizedLines.slice(range.begin, range.end + 1);
    const masked = range.begin === null ? normalized : [...normalizedLines.slice(0, range.begin), LAYER_MASK, ...normalizedLines.slice(range.end + 1)].join('\n');
    const agents = { path: agentsMd, raw, original: masked, text: masked };
    const noHostFile = { path: null, raw: '', original: '', text: '' };
    const siblingFiles = new Map([[AGENTS_TEMPLATE_REL, agents], [CLAUDE_TEMPLATE_REL, noHostFile]]);
    const layerName = () => 'AGENTS.md';
    const actions = [];
    // Whole sections first. A sibling with the heading, or with any of the section's bullets
    // in either file, is left to the per-lead loop below.
    const sectionRefused = new Set();
    for (const section of TARGET_SECTIONS) {
      const home = leadLayer.get(section.leads[0]);
      if (home === CLAUDE_TEMPLATE_REL) continue;
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
          file: layerName(home),
          detail: `${layerName(home)} already has a '${target.text.split('\n')[own].trim()}' heading and none of the '${section.heading}' bullets. To get Sterling's section, rename that heading and re-run; or copy the bullets from ${home} under it.`,
        });
        for (const lead of section.leads) sectionRefused.add(lead);
        continue;
      }
      const at = headingIndex(target.text, section.before);
      if (at === -1) {
        actions.push({
          lead: label,
          action: 'SECTION_ANCHOR_MISSING_REFUSED',
          file: layerName(home),
          detail: `${layerName(home)} has no '${section.before}' heading to put the section before. Copy the '${section.heading}' section from ${home} to where it belongs and re-run.`,
        });
        for (const lead of section.leads) sectionRefused.add(lead);
        continue;
      }
      const lines = target.text.split('\n');
      const block = [section.heading, '', ...section.leads.flatMap((lead) => current.get(lead).split('\n')), ''];
      if (at > 0 && lines[at - 1].trim() !== '') block.unshift('');
      lines.splice(at, 0, ...block);
      target.text = lines.join('\n');
      actions.push({ lead: label, action: WRITE_INSERTS ? 'section_inserted' : 'would_insert_section', file: layerName(home) });
    }
    // The per-lead pass: `files` maps each template rel to the sibling file its leads land in,
    // `wantOf` gives a lead's current text and `variantsOf` the template-descended texts that
    // may be replaced. Pushes to `pass`.
    const stampLeads = ({ files, leads, wantOf, variantsOf, nameOf, pass }) => {
      const outcome = (lead) => [...pass].reverse().find((a) => a.lead === lead)?.action;
      for (const lead of leads) {
        const home = leadLayer.get(lead);
        const other = TEMPLATE_RELS.find((rel) => rel !== home);
        const want = wantOf(lead);
        const target = files.get(home);
        const foundInOther = extractBlock(files.get(other).text, lead);
        if (foundInOther) {
          // A bullet present in the WRONG layer must never gain a second copy in the home file —
          // checked BEFORE any replace/rename/insert path, whether or not it is ALSO present (a true
          // duplicate) in the home layer (Sol review fix round, finding 6).
          const foundHome = extractBlock(target.text, lead);
          if (foundHome) {
            pass.push({ lead, action: 'DUPLICATE_REFUSED', file: nameOf(home), have: foundHome.block });
          } else {
            pass.push({ lead, action: 'WRONG_LAYER_REFUSED', file: nameOf(other), have: foundInOther.block });
          }
          continue;
        }
        const found = extractBlock(target.text, lead);
        if (found) {
          if (found.block === want) {
            pass.push({ lead, action: 'matches', file: nameOf(home) });
            continue;
          }
          if (variantsOf(lead).has(found.block)) {
            // clean template-descended block → replace. Not in applyInserts: that mode
            // writes the text it holds, so the old wording has to stay in it.
            if (!APPLY_INSERTS) {
              const lines = target.text.split('\n');
              lines.splice(found.start, found.end - found.start, ...want.split('\n'));
              target.text = lines.join('\n');
            }
            pass.push({ lead, action: APPLY ? 'updated' : 'would_update', file: nameOf(home) });
          } else {
            pass.push({ lead, action: 'HAND_TUNED_REFUSED', file: nameOf(home), have: found.block });
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
          if (variantsOf(oldLead).has(oldFound.block)) {
            if (!APPLY_INSERTS) {
              const lines = target.text.split('\n');
              lines.splice(oldFound.start, oldFound.end - oldFound.start, ...want.split('\n'));
              target.text = lines.join('\n');
            }
            pass.push({ lead, action: APPLY ? 'renamed' : 'would_rename', file: nameOf(home) });
          } else {
            pass.push({ lead, action: 'HAND_TUNED_REFUSED', file: nameOf(home), have: oldFound.block });
          }
          break;
        }
        if (renamed) continue;
        // The project may already state the rule under its own bullet (a different lead, maybe under
        // another heading): keep it and insert nothing. Information, not a refusal and not drift.
        const covering = [...files.entries()]
          .map(([rel, f]) => ({ rel, hit: findCoveringBullet(f.text, lead) }))
          .find((c) => c.hit);
        if (covering) {
          pass.push({
            lead,
            action: 'SIMILAR_BULLET_KEPT',
            file: nameOf(home),
            info: true,
            detail: `kept the project's own bullet in ${nameOf(covering.rel)}, nothing inserted: ${covering.hit.bullet.slice(0, 100)}`,
          });
          continue;
        }
        // An insertable bullet goes after the first anchor in its chain that validated this run,
        // past that anchor's whole list item; everything else missing = drift.
        const anchor = (INSERT_AFTER.get(lead) ?? [])
          .filter((a) => VALID_ANCHOR.has(outcome(a)))
          // In applyInserts a would_rename anchor still sits under its old lead.
          .map((a) => extractBlock(target.text, a) ?? (RENAMED_LEADS.get(a) ?? []).map((old) => extractBlock(target.text, old)).find(Boolean))
          .find(Boolean);
        if (anchor) {
          const lines = target.text.split('\n');
          lines.splice(itemEnd(target.text, anchor.start), 0, ...want.split('\n'));
          target.text = lines.join('\n');
          pass.push({ lead, action: WRITE_INSERTS ? 'inserted' : 'would_insert', file: nameOf(home) });
          continue;
        }
        pass.push({ lead, action: 'ANCHOR_MISSING_REFUSED', file: nameOf(home) });
      }
    };
    stampLeads({
      files: siblingFiles,
      leads: TARGET_LEADS.filter((lead) => !sectionRefused.has(lead) && leadLayer.get(lead) === AGENTS_TEMPLATE_REL),
      wantOf: (lead) => current.get(lead),
      variantsOf: (lead) => variants.get(lead),
      nameOf: layerName,
      pass: actions,
    });
    // Only a file whose text changed is written. In a dry run nothing is; in applyInserts
    // the text holds inserts only.
    if (WRITE_INSERTS && agents.text !== agents.original) {
      const file = 'AGENTS.md';
      const planned = withOriginalEols(agents.raw, unmask(agents.text, layerLines));
      // The exact bytes about to be written must fit agy's cap with trusted markers, and the file
      // must still be the plain file read above. Otherwise nothing is written.
      const refusal = plannedAgentsMdRefusal(planned) ?? (() => {
        try {
          readAgentsMd(repo);
          return null;
        } catch (err) {
          if (err instanceof LayerMarkerError) return err.message;
          throw err;
        }
      })();
      if (refusal) {
        for (const a of actions) if (a.file === file && UNWRITTEN[a.action]) a.action = UNWRITTEN[a.action];
        actions.push({ lead: `${file} (write)`, action: 'PLANNED_AGENTS_MD_REFUSED', file, detail: `${refusal}. Nothing in AGENTS.md was changed.` });
      } else {
        try {
          writeFileSync(agents.path, planned);
        } catch (err) {
          for (const a of actions) if (a.file === file && UNWRITTEN[a.action]) a.action = UNWRITTEN[a.action];
          actions.push({
            lead: `${file} (write)`,
            action: 'WRITE_FAILED_REFUSED',
            file,
            detail: `${agents.path} could not be written (${err?.code ?? 'error'}: ${err?.message ?? err}). Nothing in it was changed; make the file writable and re-run.`,
          });
        }
      }
    }
    result(actions.some(isRefusal) ? 'refused' : actions.some((a) => a.action !== 'matches') ? 'stamped' : 'in_sync', actions);
  }
  return results;
}

/** The refusals in one result: each *_REFUSED action, and a not_migrated project. */
export const stampRefusalCount = (r) => (r.status === 'not_migrated' ? 1 : r.actions.filter(isRefusal).length);

const SKIP_WHY = {
  stale_path: 'the registered path does not exist (a stale registry entry)',
  sterling_source_tree: 'a Sterling source tree, whose instruction files are hand-maintained',
};

/**
 * The lines one result prints: none for an in-sync project (unless verbose) or the running clone;
 * one `– ` line for a skip; a `✗`/`•` header naming the AGENTS.md path, then its actions.
 */
export function stampResultLines(r, { verbose = false } = {}) {
  if (r.status === 'skipped') return SKIP_WHY[r.reason] ? [`– ${r.project} (${r.path}): skipped — ${SKIP_WHY[r.reason]}; nothing stamped`] : [];
  if (r.status === 'not_migrated') return [`✗ ${r.project} (${r.path}): not_migrated (${r.reason})`];
  const notable = r.actions.filter((a) => a.action !== 'matches');
  if (!notable.length && !verbose) return [];
  const lines = [`${r.actions.some(isRefusal) ? '✗' : '•'} ${r.project} (${r.path})`];
  for (const a of verbose ? r.actions : notable) {
    // An info action (SIMILAR_BULLET_KEPT) is one line: the lead and what was kept.
    if (a.info) {
      lines.push(`    ${a.action}  ${a.lead.slice(0, 60)}… — ${a.detail}`);
      continue;
    }
    lines.push(`    ${a.action}  ${a.lead.slice(0, 60)}…`);
    if (a.detail) lines.push(`      ${a.detail}`);
    if (a.have) lines.push(`      sibling text (hand-tuned, NOT touched):\n      ${a.have.split('\n').join('\n      ')}`);
  }
  return lines;
}

/** The closing summary line of a run over `results`. */
export function stampSummaryLine(results, { apply = false, applyInserts = false, verbose = false } = {}) {
  const processed = results.filter((r) => ['in_sync', 'stamped', 'refused'].includes(r.status)).length;
  const inSync = results.filter((r) => r.status === 'in_sync').length;
  const drift = results.reduce((n, r) => n + stampRefusalCount(r), 0);
  const mode = apply ? 'APPLIED' : applyInserts ? 'INSERTS APPLIED (new text only; existing wording is never replaced without --apply)' : 'DRY-RUN (no writes; pass --apply)';
  return `\n${mode} — ${processed} project(s) processed, ${inSync} already in sync, ${drift} refusal(s).` + (!verbose && inSync ? ' Pass --verbose to list the in-sync bullets.' : '');
}
