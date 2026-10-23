// Pure core of the record-hygiene REPORTING arm (scripts/check-record-hygiene.mjs;
// board 7a75851c step 3). Spec: decisions
// record-audit-dead-records-superseded-stale-findings-by-age-report-arm-plus-sampled-audit
// and make-records-findable-authoring-rule-disclosure-lint-then-blind-experiment,
// part 3 of each. No store handle, no fs beyond loading the filler list: the caller
// hands in the records and the set of paths that exist at HEAD.
//
// Central terms come from recordCentralTerms (packages/store/src/axis.ts), the
// exact set push delivery and knowledge_preflight match a record on. This file
// defines no second centrality function.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordCentralTerms, MODELS_CATALOG_LOCATION, openForeignDbReadOnly } from '@sterling/store';
import { collectRetiredTerms, retiredTermUses } from '@sterling/schemas';

const here = dirname(fileURLToPath(import.meta.url));

/** Filler words as data: scripts/lib/record-hygiene-filler.json, and only that list. The store's GENERIC_DEV_TERMS are not filler here: the centrality code already discounts them. */
export const FILLER_WORDS = JSON.parse(readFileSync(join(here, 'record-hygiene-filler.json'), 'utf8')).words;
const FILLER = new Set(FILLER_WORDS);

/** Every knowledge record type; board items and attestations are not knowledge. */
export const AUDITED_TYPES = [
  'decision',
  'anti_pattern',
  'research_finding',
  'reference_material',
  'disconfirmed_hypothesis',
  'open_question',
  'feature_article',
];

const slash = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const hasGlob = (p) => /[*?[\]{}]/.test(p);

/** A repo path is live when it is a file at HEAD or a directory prefix of one. */
export function pathLive(path, headFiles) {
  const p = slash(path).replace(/\/+$/, '');
  if (headFiles.has(p)) return true;
  const prefix = `${p}/`;
  for (const f of headFiles) if (f.startsWith(prefix)) return true;
  return false;
}

/** The seeded 'Models catalog' (issue #98): its location is a synthetic name for
 *  content the record holds in its own `catalog` field, never a file. */
const isSeededCatalog = (rec) => rec.type === 'reference_material' && rec.location === MODELS_CATALOG_LOCATION;

/** The repo-path claims one record makes. A reference_material location is a
 *  path only for kind 'doc'; url and pdf locations are external, and so is the
 *  seeded catalog's synthetic one. */
function pathClaims(rec) {
  if (rec.type === 'feature_article') return (rec.files ?? []).map((f) => ({ path: f.path, field: 'files' }));
  if (rec.type === 'reference_material') return rec.kind === 'doc' && rec.location && !isSeededCatalog(rec) ? [{ path: rec.location, field: 'location' }] : [];
  return (rec.file_keys ?? []).map((p) => ({ path: p, field: 'file_keys' }));
}

const carriesPaths = (rec) => !(rec.type === 'reference_material' && (rec.kind !== 'doc' || isSeededCatalog(rec)));
const label = (rec) => rec.slug || rec.title || rec.question || rec.id;

/**
 * @param {object[]} records  active knowledge records (full bodies)
 * @param {{ headFiles: Set<string>, domainDecisions?: object[] }} deps  repo-relative POSIX paths at HEAD; the active rename decisions held by mounted domains (readDomainRetiredDecisions)
 * @returns {{ scanned: number, findings: { kind: string, type: string, ids: string[], detail: string }[] }}
 */
export function auditRecords(records, { headFiles, domainDecisions = [] }) {
  const findings = [];
  const add = (rec, kind, detail) =>
    findings.push({ kind, type: rec.type, ids: [rec.id], detail: `${rec.type} ${label(rec)} (${rec.id.slice(0, 8)}): ${detail}` });

  // Retired terms (GitHub #188): the active rename decisions among these
  // records plus those held by mounted domains (a rename held in a domain
  // covers every project mounting it), matched by the one schemas matcher
  // (quotes, blockquotes, history and the rename decision itself skipped).
  // Only the project's own records are audited; domain records are not.
  const retiredTerms = collectRetiredTerms([...records, ...domainDecisions]);
  const groups = new Map();
  for (const rec of records) {
    for (const use of retiredTerms.length ? retiredTermUses(rec, retiredTerms) : []) {
      add(rec, 'retired_term_use', `still uses retired term '${use.term}' (now '${use.replacement}', decision ${use.decision_slug ?? use.decision_id.slice(0, 8)}) in ${use.fields.join(', ')}`);
    }
    const claims = pathClaims(rec);
    if (carriesPaths(rec) && claims.length === 0) add(rec, 'no_file_paths', 'carries no file paths');
    for (const c of claims) {
      if (hasGlob(c.path)) continue;
      if (!pathLive(c.path, headFiles)) add(rec, 'dead_path', `${c.field} '${c.path}' is absent at HEAD`);
    }

    if (rec.type === 'feature_article') {
      const acs = Array.isArray(rec.current_ac) ? rec.current_ac : [];
      const refs = Array.isArray(rec.live_test_refs) ? rec.live_test_refs : [];
      const covered = new Set(refs.filter((r) => Array.isArray(r.test_paths) && r.test_paths.length > 0).map((r) => r.ac_id));
      for (const ac of acs) {
        if (ac.untestable_because) continue;
        if (!covered.has(ac.ac_id)) add(rec, 'ac_without_test_ref', `${ac.ac_id} has no live_test_ref`);
      }
      for (const ref of refs) {
        for (const tp of ref.test_paths ?? []) {
          if (!hasGlob(tp) && !pathLive(tp, headFiles)) add(rec, 'dead_test_path', `${ref.ac_id} live_test_ref '${tp}' is absent at HEAD`);
        }
      }
    }

    const central = recordCentralTerms(rec);
    if (central.length > 0) {
      const key = [...central].sort().join(' ');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rec);
    }
    const filler = central.filter((t) => FILLER.has(t));
    if (filler.length > 0) add(rec, 'filler_central_terms', `filler among central terms: ${filler.join(', ')}`);
  }

  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    findings.push({
      kind: 'shared_central_terms',
      type: [...new Set(members.map((m) => m.type))].join('/'),
      ids: members.map((m) => m.id),
      detail: `${members.length} records share the central terms [${key.split(' ').join(', ')}]: ${members
        .map((m) => `${label(m)} (${m.id.slice(0, 8)})`)
        .join('; ')}`,
    });
  }
  return { scanned: records.length, findings };
}

/**
 * The active rename decisions held by the given domain mounts, read through a
 * read-only open of each domain store (nothing is written beside it) with one
 * narrow query, so no unrelated record is decoded. A domain store that
 * exists but cannot be read is listed in `unread` with the reason, never
 * silently skipped; one that was never created holds no rename and is not.
 * @param {{ name: string, dbPath: string }[]} mounts
 * @returns {{ decisions: object[], unread: { name: string, error: string }[] }}
 */
export function readDomainRetiredDecisions(mounts) {
  const decisions = [];
  const unread = [];
  for (const m of mounts) {
    let db;
    try {
      db = openForeignDbReadOnly(m.dbPath, 1000);
      const rows = db
        .prepare("SELECT body FROM records WHERE type = 'decision' AND status = 'active' AND body LIKE '%retired_terms%'")
        .all();
      for (const r of rows) {
        const body = JSON.parse(r.body);
        if (Array.isArray(body.retired_terms)) decisions.push({ ...body, source_store: `domain:${m.name}` });
      }
    } catch (e) {
      // A mounted domain whose store was never created holds no rename.
      if (!String(e?.message ?? e).startsWith('no database at ')) unread.push({ name: m.name, error: String(e?.message ?? e) });
    } finally {
      db?.close();
    }
  }
  return { decisions, unread };
}
