// The session-end duty rules H10 (scripts/hooks/h10-direct-capture.mjs) and the
// OpenCode settlement (packages/opencode-plugin/src/settle.mjs) share: what
// discharges a duty, what satisfies it, who owns a path, and the exact queue
// item each duty leaves behind. H10 keeps the Claude-only machinery around
// them (the touches claim, dispatch deferral, capture_pending grace, the Stop
// block); this file holds only the rules, so the two hosts cannot drift apart
// on what "owed" means. The rationale for each rule stays at its H10 call site.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWLEDGE_WRITES_DIR_REL, KNOWLEDGE_WRITES_PROCESS_FILE, KNOWLEDGE_WRITES_REL, knowledgeWriteSchema, matchesGlob } from '@sterling/schemas';
import { SterlingStore, resolveDomainMounts } from '@sterling/store';
import { openRoutedStores } from '@sterling/store/routing';
import { isForeignTree } from './working-tree.mjs';

// Register timestamps are compared LEXICALLY, so only a canonical ISO stamp is
// comparable (see the isValidAt note in h10-direct-capture.mjs).
export const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const isValidAt = (a) => typeof a === 'string' && ISO_AT.test(a) && Number.isFinite(Date.parse(a));

/** A touched image or PDF carries no capture duty (board 05e298f0). */
export const IMAGE_BINARY_EXT = /\.(png|jpe?g|gif|webp|pdf)$/i;

export const NO_CAPTURE_LANES = ['research', 'capture', 'all'];

/** A no_capture declaration's lane: absent is the legacy capture lane; an unknown one is null (covers nothing). */
export const noCaptureLaneOf = (e) => {
  if (e.lane === undefined || e.lane === null) return 'capture';
  return NO_CAPTURE_LANES.includes(e.lane) ? e.lane : null;
};

/** The latest VALID no_capture declaration per lane ('all' covers both), or null. */
export function noCaptureCutoffs(sessionEvents) {
  const noCaptureEvents = sessionEvents.filter((e) => e.kind === 'no_capture');
  const cutoffForLane = (lane) =>
    noCaptureEvents
      .filter((e) => {
        const declared = noCaptureLaneOf(e);
        return declared === lane || declared === 'all';
      })
      .map((e) => e.at)
      .filter(isValidAt)
      .sort()
      .at(-1) ?? null;
  return { capture: cutoffForLane('capture'), research: cutoffForLane('research') };
}

/** Covered only when the event's own `at` is canonical and at or before the cutoff. */
export const dischargedByCutoff = (at, cutoff) => cutoff !== null && isValidAt(at) && at <= cutoff;

/** concept_designed events deduped to family -> earliest VALID at (null when the family has none). */
export function conceptFamiliesFrom(sessionEvents) {
  const conceptFamilies = new Map();
  for (const e of sessionEvents.filter((ev) => ev.kind === 'concept_designed' && ev.detail)) {
    const at = isValidAt(e.at) ? e.at : null;
    if (!conceptFamilies.has(e.detail)) {
      conceptFamilies.set(e.detail, at);
      continue;
    }
    const prior = conceptFamilies.get(e.detail);
    if (at !== null && (prior === null || at < prior)) conceptFamilies.set(e.detail, at);
  }
  return conceptFamilies;
}

/**
 * The records a "was one written since X" duty read covers, as a store-like
 * `{ query, close }`: the project store plus every mounted domain store that
 * exists on disk (GitHub issue #12). A record with scope `domain:<name>` is
 * written to that domain's own store, never to the project store, so a read of
 * the project store alone cannot see it and the duty it paid stays open.
 *
 * - `store` is the caller's open project store; it is read, never closed here.
 * - The mounts are `resolveDomainMounts(config)` (the manifest the MCP server
 *   mounts); `config` is the parsed project config. They are opened on the
 *   first query, with `opener(dbPath)`, and closed by `close()`.
 * - A missing domain store is skipped and never created.
 * - A domain store that cannot be opened, or whose query throws, is dropped,
 *   reported once through `onUnreadable(name, errorText)` and counts as holding
 *   nothing, so the duty stays armed.
 * - `query` returns each store's own result for the same options, project
 *   first, concatenated: `cap` applies per store.
 * - `close()` closes every domain store it opened and never throws: it returns
 *   the stores that failed to close as [{name, error}], for the caller to
 *   report. The reads are already done, so a close error changes no duty.
 *
 * - `pays(record, since)` is the "written since X" test for one record a
 *   `query` returned. A project-store record pays on its own timestamps. A
 *   mounted domain store is shared by every project on the machine and its
 *   records carry no origin project, so a domain record pays only when this
 *   project's MCP server logged a write of it: the domain-write ledger (the
 *   files readKnowledgeWrites reads under `root`, written by
 *   packages/mcp-server) holds an entry with the same id AND an `at` at or
 *   after `since`. The id alone
 *   is not enough: an old entry of ours must not let a later write by another
 *   project pay. A domain record with no entry, which includes every record
 *   written before the ledger existed, never pays (decision
 *   domain-record-duty-credit-comes-from-a-per-project-write-ledger).
 * - The ledger is read once, on the first domain record weighed, and never
 *   written, cleared or removed here. An absent ledger is empty. Each ledger
 *   file that cannot be read, or that holds lines and no valid entry, is
 *   reported once through `onLedgerUnreadable(errorText, file)` (`file` is
 *   its path relative to `root`) and counts as empty: nothing logged in THAT
 *   file pays, and the entries of the other files still count. A line that
 *   does not parse, is not the shared shape or whose `at` is not a canonical
 *   stamp is skipped; the lines around it still count. With no `root` there
 *   is no ledger to read and no domain record pays.
 *
 * Not for ownership reads: a feature_article is always project-scoped, and a
 * domain record's file_keys name files in other repos.
 *
 * Deliberately separate from subject-fan.mjs's openSubjectFan, which splits one
 * cap across the stores by shares; a "since X" read needs each store's full cap.
 */
export function openDutyRecords(store, config, { opener = (dbPath) => new SterlingStore(dbPath), onUnreadable, root, onLedgerUnreadable }) {
  let domains = null;
  const domainRows = new WeakSet();
  let ledger = null;
  const loggedWrites = () => {
    if (ledger === null) {
      const read = root ? readKnowledgeWrites(root) : { latestAt: new Map(), unreadable: [] };
      for (const u of read.unreadable) onLedgerUnreadable(u.error, u.file);
      ledger = read.latestAt;
    }
    return ledger;
  };
  const unreadable = (name, e) => onUnreadable(name, String((e && e.message) || e));
  const mounted = () => {
    if (domains === null) {
      domains = [];
      if (config.storage === 'postgres') {
        domains = routedDutyDomains(config, root, unreadable);
        return domains;
      }
      for (const m of resolveDomainMounts(config)) {
        if (!existsSync(m.dbPath)) continue;
        try {
          domains.push({ name: m.name, store: opener(m.dbPath) });
        } catch (e) {
          unreadable(m.name, e);
        }
      }
    }
    return domains;
  };
  return {
    query(opts) {
      const out = [...store.query(opts)];
      for (const d of [...mounted()]) {
        try {
          const rows = d.store.query(opts);
          for (const r of rows) domainRows.add(r);
          out.push(...rows);
        } catch (e) {
          domains = domains.filter((x) => x !== d);
          unreadable(d.name, e);
          try {
            d.store.close();
          } catch {
            /* the domain is already reported unreadable; a failed close adds nothing */
          }
        }
      }
      return out;
    },
    pays(r, since) {
      if (!writtenSince(r, since)) return false;
      if (!domainRows.has(r)) return true;
      const loggedAt = loggedWrites().get(r.id);
      return loggedAt !== undefined && loggedAt >= since;
    },
    close() {
      const open = domains ?? [];
      domains = [];
      const errors = [];
      for (const d of open) {
        try {
          d.store.close();
        } catch (e) {
          errors.push({ name: d.name, error: String((e && e.message) || e) });
        }
      }
      return errors;
    },
  };
}

/**
 * openDutyRecords' domains for a Postgres-storage project: every configured
 * domain, read through one routed MountedStores at `root`. Nothing is skipped
 * as missing (the router names a missing domain), and a failure is never
 * silent: when the stores cannot be opened every configured domain is reported
 * through `unreadable` with the named error and counts as holding nothing, so
 * the duty stays armed exactly as for an unreadable SQLite domain. A domain
 * whose read fails later is reported by openDutyRecords' query the same way.
 */
function routedDutyDomains(config, root, unreadable) {
  // Postgres domains are named by stack_tags alone; domain_paths names SQLite files.
  const names = [...(config.stack_tags ?? [])];
  if (!names.length) return [];
  let stores;
  try {
    if (typeof root !== 'string') throw new Error("config.storage is 'postgres', so the project root is required to read its domain stores");
    ({ stores } = openRoutedStores(root, { mount: true }));
  } catch (e) {
    const named = new Error(`${e?.constructor?.name ?? e?.name ?? 'Error'}: ${(e && e.message) || e}`);
    for (const name of names) unreadable(name, named);
    return [];
  }
  // One handle serves every domain. Each domain's close releases its share, and
  // the handle closes with the last one, so dropping one failed domain leaves
  // the others readable.
  let shares = names.length;
  return names.map((name) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      shares -= 1;
      if (shares === 0) stores.close();
    };
    return { name, store: { query: (opts) => stores.querySource(name, opts), close } };
  });
}

/** A record created or updated at or after `since` (lexical compare of canonical stamps). */
const writtenSince = (r, since) => r.created_at >= since || r.updated_at >= since;

/**
 * The domain-write ledger under `root` (JSON Lines, appended by the MCP
 * server): `{ latestAt, unreadable }`. `latestAt` is a Map of record id to the
 * latest `at` logged for it, over the UNION of the legacy single file
 * (KNOWLEDGE_WRITES_REL) and every file in KNOWLEDGE_WRITES_DIR_REL whose name
 * is exactly a per-process ledger name (KNOWLEDGE_WRITES_PROCESS_FILE): each
 * server process appends to its own file. Any other name, a compaction temp
 * file included, is not read. The server appends a line per write, so one id
 * can have many lines in many files; the latest `at` is all an "at or after X"
 * read needs. A line that does not parse (a torn or garbage line), is not the
 * shared shape, or whose `at` is not a canonical stamp is skipped: `at` is
 * compared lexically against the window start.
 *
 * `unreadable` lists, as [{ file, error }] with `file` relative to `root`, each
 * file that could not be read and each file that holds lines but no valid
 * entry (an unterminated last line alone, a first append caught half written,
 * is not a report), plus the folder itself when it cannot be listed. Such a file adds
 * nothing; the other files still count. A file that vanishes between the
 * listing and the read (the server removed it at its start) is not an error.
 *
 * Read-only: this never writes, compacts or removes a ledger file.
 */
export function readKnowledgeWrites(root) {
  const latestAt = new Map();
  const unreadable = [];
  // err.code only: an fs error message holds the absolute path, and this text lands in one-line notices.
  const errorText = (e) => (e && typeof e.code === 'string' && e.code) || 'unknown error';
  let names;
  try {
    names = readdirSync(join(root, KNOWLEDGE_WRITES_DIR_REL));
  } catch (e) {
    if (e && e.code === 'ENOENT') return { latestAt, unreadable };
    unreadable.push({ file: KNOWLEDGE_WRITES_DIR_REL, error: errorText(e) });
    return { latestAt, unreadable };
  }
  const legacy = KNOWLEDGE_WRITES_REL.slice(KNOWLEDGE_WRITES_DIR_REL.length + 1);
  for (const name of names.filter((n) => n === legacy || KNOWLEDGE_WRITES_PROCESS_FILE.test(n)).sort()) {
    const file = `${KNOWLEDGE_WRITES_DIR_REL}/${name}`;
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) unreadable.push({ file, error: errorText(e) });
      continue;
    }
    let lines = 0;
    let valid = 0;
    let completeLines = 0;
    const parts = text.split('\n');
    const unterminatedAt = parts.length - 1; // the text after the final newline: a first append can be caught half written
    for (const [i, line] of parts.entries()) {
      if (line === '') continue;
      lines += 1;
      if (i !== unterminatedAt) completeLines += 1;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a torn or garbage line carries no entry
      }
      if (!knowledgeWriteSchema.safeParse(entry).success || !isValidAt(entry.at)) continue;
      valid += 1;
      const prior = latestAt.get(entry.id);
      if (prior === undefined || entry.at > prior) latestAt.set(entry.id, entry.at);
    }
    if (completeLines > 0 && valid === 0) unreadable.push({ file, error: `none of its ${lines} line(s) is a valid entry` });
  }
  return { latestAt, unreadable };
}

/**
 * Whether `r`, a record `store.query` returned, pays a duty whose window opens
 * at `since`. `store` is an openDutyRecords result, whose `pays` applies the
 * domain-write ledger; a bare project store holds only project records, which
 * pay on their own timestamps.
 */
export const paysSince = (store, r, since) => (typeof store.pays === 'function' ? store.pays(r, since) : writtenSince(r, since));

/** Record types whose write since `earliest` pays the capture duty. */
export const CAPTURE_TYPES = ['decision', 'anti_pattern', 'feature_article', 'research_finding', 'disconfirmed_hypothesis', 'open_question'];
export const capturedSince = (store, earliest) => store.query({ types: CAPTURE_TYPES, cap: 1000 }).some((r) => paysSince(store, r, earliest));

/** Record types whose write since `earliest` pays the research duty. */
export const RESEARCH_TYPES = ['research_finding', 'decision', 'anti_pattern'];
export const researchCapturedSince = (store, earliest) => store.query({ types: RESEARCH_TYPES, cap: 1000 }).some((r) => paysSince(store, r, earliest));

/** An article written up to this long BEFORE its family's concept_designed event still satisfies it (item c520be20). */
export const CONCEPT_PRE_EVENT_WINDOW_MS = 15 * 60_000;

/** The families in `conceptFamilies` with no concept article written inside their window. */
export function unmetConceptFamilies(store, conceptFamilies, earliestSessionAt) {
  const articles = store.query({ types: ['feature_article'], cap: 1000 });
  return [...conceptFamilies.entries()]
    .filter(([family, since]) => {
      if (since === null) return true;
      const windowStart = since < earliestSessionAt ? since : earliestSessionAt;
      const sinceMs = Date.parse(since);
      const preStart = Number.isFinite(sinceMs) ? sinceMs - CONCEPT_PRE_EVENT_WINDOW_MS : null;
      return !articles.some((a) => {
        if (a.concept_family !== family) return false;
        if (a.created_at >= windowStart || a.updated_at >= windowStart) return true;
        if (preStart === null) return false;
        const created = Date.parse(a.created_at);
        const updated = Date.parse(a.updated_at);
        return (
          (Number.isFinite(created) && created >= preStart && created <= sinceMs) ||
          (Number.isFinite(updated) && updated >= preStart && updated <= sinceMs)
        );
      });
    })
    .map(([family]) => family);
}

/**
 * The ownership join (feature_article and reference_material, minus records
 * naming a foreign working tree), over the whole matched set rather than a
 * capped window. `ownerRows(p)` is memoized per join.
 */
export function ownershipJoin(store, root) {
  const ownersSeen = new Map();
  const ownerRows = (p) => {
    if (ownersSeen.has(p)) return ownersSeen.get(p);
    const filter = { types: ['feature_article', 'reference_material'], file_keys: [p] };
    const total = store.count(filter);
    const rows = total === 0 ? [] : store.query({ ...filter, cap: total });
    ownersSeen.set(p, rows);
    return rows;
  };
  const isUnowned = (p) => !ownerRows(p).some((r) => !isForeignTree(r, root));
  return { ownerRows, isUnowned };
}

/** A path the article demand never names: a generated projection, or a per-project ignore glob. */
export function demandExemption(config, generatedProjections) {
  const ignoreGlobs = config.article_demand.ignore_globs;
  return (p) => generatedProjections.has(p) || ignoreGlobs.some((g) => matchesGlob(p, g));
}

export function articleMissingText(fileKeys, { newlyCreated = 0 } = {}) {
  return `article missing: ${fileKeys.length} file(s) nothing owns (feature_article or repo-located reference doc)${newlyCreated ? ` (${newlyCreated} newly created)` : ''} — create the owning article(s) (§6 H10 / §12 accretion)`;
}

export const conceptArticleMissingText = (family) =>
  `concept article missing: design settled for concept family '${family}' and the session ended without its concept article — create/update the feature_article with concept_family '${family}'`;

export const researchOwedText = (queryTexts) => `research owed: session research not captured (queries/agents: ${queryTexts})`;

export const captureOwedText = (count, clipped) => `capture owed: direct-mode session touched ${count} file(s) and ended without capture${clipped}`;

/** A system queue item with H10's envelope; `fields` is { text, system_reason, file_keys? }. */
export function systemTodo(now, fields) {
  return {
    id: randomUUID(),
    type: 'todo',
    created_at: now,
    updated_at: now,
    author: 'system',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    text: fields.text,
    source: 'system',
    system_reason: fields.system_reason,
    ...(fields.file_keys !== undefined ? { file_keys: fields.file_keys } : {}),
  };
}

/** Whether any open system item with this reason exists (the capture_owed and research_owed mint gate). */
export const hasOpenSystemTodo = (store, reason) =>
  store.query({ types: ['todo'], cap: 1000 }).some((t) => t.source === 'system' && t.system_reason === reason);
