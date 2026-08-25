// knowledge-export.mjs — knowledge-transfer-export payload generator (board
// item c3705a15, step 2). Mechanizes what the owning article's own history
// names as a standing gap: both existing payloads (2026-07-19-chulf,
// 2026-07-26-chulf) were hand-assembled — a recorded P3 violation. Follows
// the knowledge-transfer-export article's payload convention exactly
// (feature_article 'knowledge-transfer-export', ca9b783f-9f0a-4acf-992b-
// e6f4b8af27e8) — read it (knowledge_get) before changing this script's
// output shape; it is the spec.
//
//   node scripts/knowledge-export.mjs <root> <outDir> --ids <id1>,<id2>,...
//     [--type <t> ...] [--rank-term <t> ...] [--file-key <path> ...]
//     [--stack-tag <tag> ...] [--cap <n>]
//
// <root> is a Sterling project root (opened via openMounted, same convention
// as check-record-citations.mjs's sole positional root argument); <outDir>
// is the destination payload directory. --ids is a comma-separated list of
// full ids or unambiguous 8-char prefixes — the common case, an explicit
// short list. The --type/--rank-term/--file-key/--stack-tag/--cap flags are
// an alternative selection shape (a store query filter, exportPayload()'s
// `filter` option) for a caller selecting by criteria instead of naming ids;
// --ids takes precedence when both are given. Neither given is a usage
// error, not a silent export-of-nothing.
//
// REFUSES (loud, named, non-zero exit) — never ships a payload it cannot
// vouch for:
//   - a requested --id that does not resolve in the SOURCE store;
//   - an 8-char --id prefix matching more than one record (ambiguous);
//   - any prose citation (the durable long-text fields named below) or
//     links[].target_id / history[].target_id in an EXPORTED record that
//     does not resolve in the SOURCE store, or resolves ambiguously;
//   - a non-empty --out directory (never silently overwrites or merges).
// An id that resolves in the source but sits OUTSIDE the exported set is not
// a citation defect — it is auto-listed in provenance.json's `collateral`
// array instead (rule 5: the exporter can only confirm a collateral id
// EXISTS here, not what it means on the receiving store; the receiver
// verifies and acts on it).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMounted, arg, argAll, fail } from './lib/project.mjs';
import { buildResolver } from './lib/citations.mjs';
import { collectRecordCitations } from './lib/checks.mjs';

// Article rule 8's ORIGIN-ONLY marker in RECORD PROSE. A payload README
// legitimately lists ids that resolve on the ORIGIN machine (here, now) but
// are never meant to resolve once imported elsewhere. The file-side
// 'not-a-citation' opt-out (scripts/lib/checks.mjs) is a single-line marker
// and does not transfer cleanly to a whole id LIST (board item c3705a15's own
// framing of the gap) — this is the prose-region equivalent: content inside
// the marked block is exempt from THIS exporter's own citation scan, the
// same way a receiver's recorded id map must not re-trip a resolver over ids
// that are provenance, not fresh citations.
export const ORIGIN_IDS_OPEN = '[origin-ids: origin-only, do not resolve here]';
export const ORIGIN_IDS_CLOSE = '[/origin-ids]';
const ORIGIN_IDS_BLOCK_RE = /\[origin-ids:[\s\S]*?\[\/origin-ids\]/g;
const ORIGIN_IDS_OPEN_RE = /\[origin-ids:/g;
const ORIGIN_IDS_CLOSE_RE = /\[\/origin-ids\]/g;

export function originIdsBlock(ids) {
  return `${ORIGIN_IDS_OPEN} ${ids.join(', ')} ${ORIGIN_IDS_CLOSE}`;
}

// Durable long-text fields (packages/schemas/src/records.ts) that legitimately
// carry a record-id prose citation — exactly the set named in the board
// item's brief: statement/rationale (decision), what_it_does/
// intended_behavior (feature_article), guidance (anti_pattern), plus every
// type's history entries (a comment naming the decision that originally
// justified a design — history is exactly what SHOULD cite it).
const LONG_TEXT_FIELDS = ['statement', 'rationale', 'what_it_does', 'intended_behavior', 'guidance'];

// One entry per durable long-text field PLUS one per history[].event — kept
// SEPARATE (never pre-joined) so an origin-ids region is matched and balance-
// checked within a single field's own text, never across fields (review
// finding, c3705a15: proseOf used to join every field into one string before
// matching, so an unclosed '[origin-ids:' in one field could silently pair
// with an unrelated '[/origin-ids]' in a LATER field of the same record).
function proseFieldsOf(record) {
  const entries = [];
  for (const f of LONG_TEXT_FIELDS) if (typeof record[f] === 'string') entries.push({ field: f, text: record[f] });
  if (Array.isArray(record.history)) {
    record.history.forEach((h, i) => {
      if (h && typeof h.event === 'string') entries.push({ field: `history[${i}].event`, text: h.event });
    });
  }
  return entries;
}

// Strip origin-ids regions from ONE field's text, REFUSING loud (naming the
// record and field) when the field's open/close marker counts differ — an
// unbalanced '[origin-ids:' cannot be trusted to bound what it exempts, so
// shipping it silently would risk exempting citations it was never meant to
// cover (or none at all, if the real close lives in another field — no
// longer reachable now that fields are matched independently).
function stripOriginIdsRegion(rec, field, text) {
  const opens = (text.match(ORIGIN_IDS_OPEN_RE) ?? []).length;
  const closes = (text.match(ORIGIN_IDS_CLOSE_RE) ?? []).length;
  if (opens !== closes) {
    fail(
      `knowledge-export FAILED: ${rec.type} ${rec.id} field '${field}' has ${opens} '[origin-ids:' marker(s) but ${closes} '[/origin-ids]' closer(s) — an unbalanced origin-ids region cannot be trusted to bound what it exempts; balance or remove the marker before shipping`
    );
  }
  return text.replace(ORIGIN_IDS_BLOCK_RE, '');
}

function proseOf(record) {
  return proseFieldsOf(record)
    .map(({ field, text }) => stripOriginIdsRegion(record, field, text))
    .join('\n\n');
}

// Every structured (non-prose) cross-reference a record carries: links[] plus
// any history[].target_id — checked directly against the resolver rather
// than through the prose-citation grammar, since these are typed fields, not
// text a record-word window has to find.
function structuredRefs(record) {
  const refs = [];
  for (const link of record.links ?? []) if (link?.target_id) refs.push({ site: 'links[].target_id', id: link.target_id });
  if (Array.isArray(record.history)) {
    for (const h of record.history) if (h?.target_id) refs.push({ site: 'history[].target_id', id: h.target_id });
  }
  return refs;
}

function slugify(text) {
  const s = (text ?? '')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'record';
}

function fileStemFor(record) {
  if (typeof record.slug === 'string' && record.slug) return slugify(record.slug);
  return slugify(record.title ?? record.question ?? record.text ?? record.artifact_key ?? record.id);
}

// Rules 2-3 (knowledge-transfer-export): strip file_baselines (server-side
// content hashes the receiving server recomputes at create/reconcile — an
// imported baseline would assert a reconcile that never happened against
// that machine's files) and read-time-only annotations (staleness,
// verify_before_use — computed by the mcp-server tool layer from the two
// clocks, never stored facts; a raw store read like this script's never
// carries them, so this strip is defensive rather than load-bearing here).
function exportableRecord(record) {
  const { file_baselines, staleness, verify_before_use, ...rest } = record;
  if (file_baselines === undefined) return rest;
  return {
    ...rest,
    _export_note:
      "file_baselines stripped at export (knowledge-transfer-export rule 2) — the receiving server recomputes them at create/reconcile; importing them would assert a reconcile that never happened against that machine's files. Not a schema field: drop it at import, never submit it.",
  };
}

/**
 * @param {{ids?: string[], filter?: import('@sterling/store').QueryOptions, outDir: string}} opts
 */
export function exportPayload({ ids, filter, outDir }, { cwd = process.cwd() } = {}) {
  if ((!ids || ids.length === 0) && !filter) {
    fail('knowledge-export: one of --ids or a --type/--filter selection is required — a call with neither would export nothing silently');
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    fail(`knowledge-export: --out '${outDir}' already exists and is non-empty — refusing to overwrite or merge into it`);
  }

  const { store } = openMounted(cwd);
  try {
    const resolver = buildResolver(store);
    const records = [];
    const seen = new Set();

    // Alias (historical-id) -> canonical-id map, built lazily only if a hit
    // ever turns out to be an alias row — most exports never touch one. A
    // citation to a pre-migration historical id resolves via buildResolver's
    // synthetic alias rows (type 'alias'), whose `.id` IS the dead id, never
    // the live record's id — so membership in the exported set must be
    // checked against the CANONICAL id the alias forwards to, or an in-set
    // citation reads as collateral just because it named the record's old id
    // (review finding, c3705a15).
    let aliasCanonical = null;
    const canonicalIdOf = (hit) => {
      if (hit.type !== 'alias') return hit.id;
      if (!aliasCanonical) {
        aliasCanonical = new Map();
        for (const a of store.recordAliases()) aliasCanonical.set(a.historical_id, a.canonical_id);
      }
      return aliasCanonical.get(hit.id) ?? hit.id;
    };

    for (const id of ids ?? []) {
      const hit = resolver.resolve(id);
      if (hit === 'ambiguous') {
        fail(`knowledge-export: '${id}' is an ambiguous 8-char prefix — matches more than one record in the source store; cite more of the id`);
      }
      if (!hit) {
        fail(`knowledge-export: requested id '${id}' does not resolve to any record in the source store`);
      }
      const full = store.get(hit.id);
      if (!full) {
        fail(
          `knowledge-export: '${hit.id}' resolves in the id index (type '${hit.type}') but carries no live record body — likely a historical/superseded id with no current row; export the live/canonical id instead`
        );
      }
      if (!seen.has(full.id)) {
        seen.add(full.id);
        records.push(full);
      }
    }

    if (filter) {
      for (const rec of store.query(filter)) {
        if (!seen.has(rec.id)) {
          seen.add(rec.id);
          records.push(rec);
        }
      }
    }

    if (records.length > 99) {
      fail(`knowledge-export: ${records.length} records selected — over the 99-record NN two-digit naming ceiling; narrow the selection or split the payload`);
    }

    // -- pre-ship citation check: the export-script half of the gap the board
    // item names as cheaper than catching it at the receiver's merge gate.
    // Every prose citation and every structured cross-reference in an
    // exported record must resolve in the SOURCE store; a hit outside the
    // exported set is collateral (rule 5), not a violation.
    const violations = [];
    const collateralIds = new Set();
    const noteHit = (rec, site, id, hit) => {
      if (hit === 'ambiguous') {
        violations.push(`${rec.type} ${rec.id} (${fileStemFor(rec)}): ${site} '${id}' is an ambiguous 8-char prefix`);
      } else if (!hit) {
        violations.push(`${rec.type} ${rec.id} (${fileStemFor(rec)}): ${site} '${id}' resolves to no record in the source store`);
      } else {
        const canonicalId = canonicalIdOf(hit);
        if (!seen.has(canonicalId)) collateralIds.add(canonicalId);
      }
    };
    for (const rec of records) {
      for (const c of collectRecordCitations(proseOf(rec))) noteHit(rec, `'${c.word}' citation`, c.id, resolver.resolve(c.id));
      for (const ref of structuredRefs(rec)) noteHit(rec, ref.site, ref.id, resolver.resolve(ref.id));
    }
    if (violations.length > 0) {
      fail(
        `knowledge-export FAILED: ${violations.length} unresolved cross-reference(s) in the exported set — fix the citation or drop the id before shipping:\n${violations.map((v) => `  ${v}`).join('\n')}`
      );
    }

    // -- write the payload ---------------------------------------------------
    mkdirSync(outDir, { recursive: true });
    const files = records.map((rec, i) => {
      const n = String(i + 1).padStart(2, '0');
      const name = `${n}-${rec.type}-${fileStemFor(rec)}.json`;
      writeFileSync(join(outDir, name), JSON.stringify(exportableRecord(rec), null, 2) + '\n');
      return { name, id: rec.id, type: rec.type, scope: rec.scope, slug: rec.slug };
    });

    const collateral = [...collateralIds].map((id) => {
      const row = resolver.getById(id);
      return { id, type: row?.type, status: row?.status };
    });

    const originIds = files.map((f) => f.id);
    const provenance = {
      generated_at: new Date().toISOString(),
      generated_by: 'scripts/knowledge-export.mjs',
      record_count: records.length,
      files: files.map((f) => f.name),
      origin_ids: originIds,
      origin_ids_block: originIdsBlock(originIds),
      collateral,
    };
    writeFileSync(join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');

    const projectFiles = files.filter((f) => (f.scope ?? 'project') === 'project');
    const domainFiles = files.filter((f) => (f.scope ?? 'project') !== 'project');
    const table = (rows) => (rows.length ? rows.map((f) => `| ${f.name} | ${f.type} | ${f.slug ?? ''} |`).join('\n') : '| (none) | | |');
    const collateralLine =
      collateral.length === 0 ? 'None referenced outside this payload.' : collateral.map((c) => `${c.type ?? 'unknown'} ${c.id}`).join(', ');

    const readme = `# Knowledge export — ${new Date().toISOString().slice(0, 10)}

Generated mechanically by \`scripts/knowledge-export.mjs\` (knowledge-transfer-export
payload convention — feature_article \`knowledge-transfer-export\`). ${records.length}
record(s) exported. This directory is TRANSIENT (P4 / AC5): delete it from the
receiving repo once imported, after recording the origin->local id map in
that article's history (rule 8).

## Contents (scope-split)

### project-scoped (→ the receiving project's store)

| file | type | slug |
| --- | --- | --- |
${table(projectFiles)}

### domain-scoped (→ the receiving \`~/.sterling/domains/<tag>/\` store)

| file | type | slug |
| --- | --- | --- |
${table(domainFiles)}

## Import notes

- Rules 2-3: \`file_baselines\` (rule 2) and read-time annotations
  \`staleness\`/\`verify_before_use\` (rule 3) are stripped from every payload
  file; an article/reference_material file that carried \`file_baselines\`
  says so via its own \`_export_note\`.
- Rule 5 (collateral — verified by the RECEIVER, not asserted here): this
  exporter can only confirm the ids below exist in the SOURCE store, not what
  they mean on the receiving one. ${collateralLine}
- Rule 8 (id map): the ids in the block below are THIS machine's ids for the
  records in this payload — record the origin->local map in
  knowledge-transfer-export's history before deleting this directory. The
  block is pre-formatted so it can be pasted as-is; ids inside it are
  provenance, not citations this or any receiving check should try to
  resolve.

${originIdsBlock(originIds)}
`;
    writeFileSync(join(outDir, 'README.md'), readme);

    return { outDir, files, provenance };
  } finally {
    store.close();
  }
}

// -- CLI --------------------------------------------------------------------
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/knowledge-export.mjs');
if (isMain) {
  // First two POSITIONAL (non-flag) tokens are <root> and <outDir> — the flags
  // (--ids and the optional filter flags) come after, exactly as invoked above.
  const argv = process.argv.slice(2);
  const positional = [];
  for (let i = 0; i < argv.length && positional.length < 2; i++) {
    if (argv[i].startsWith('--')) break; // flags never precede both positionals
    positional.push(argv[i]);
  }
  const [cliRoot, outDir] = positional;
  if (!cliRoot || !outDir) {
    fail('usage: knowledge-export.mjs <root> <outDir> --ids <id1>,<id2>,... [--type <t> ...] [--rank-term <t> ...] [--file-key <path> ...] [--stack-tag <tag> ...] [--cap <n>]');
  }
  const rest = argv.slice(positional.length);

  const idsArg = arg('--ids', rest);
  const ids = idsArg
    ? idsArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const types = argAll('--type', rest);
  const rankTerms = argAll('--rank-term', rest);
  const fileKeys = argAll('--file-key', rest);
  const stackTags = argAll('--stack-tag', rest);
  const capArg = arg('--cap', rest);

  const hasFilter = types.length > 0 || rankTerms.length > 0 || fileKeys.length > 0 || stackTags.length > 0 || capArg !== undefined;
  const filter = hasFilter
    ? {
        ...(types.length ? { types } : {}),
        ...(rankTerms.length ? { rank_terms: rankTerms } : {}),
        ...(fileKeys.length ? { file_keys: fileKeys } : {}),
        ...(stackTags.length ? { stack_tags: stackTags } : {}),
        ...(capArg !== undefined ? { cap: Number(capArg) } : {}),
      }
    : undefined;

  const result = exportPayload({ ids: ids.length ? ids : undefined, filter, outDir }, { cwd: cliRoot });
  console.log(`knowledge-export: wrote ${result.files.length} record(s) + README.md + provenance.json to ${result.outDir}`);
}
