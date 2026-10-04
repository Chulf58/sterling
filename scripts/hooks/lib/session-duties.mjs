// The session-end duty rules H10 (scripts/hooks/h10-direct-capture.mjs) and the
// OpenCode settlement (packages/opencode-plugin/src/settle.mjs) share: what
// discharges a duty, what satisfies it, who owns a path, and the exact queue
// item each duty leaves behind. H10 keeps the Claude-only machinery around
// them (the touches claim, dispatch deferral, capture_pending grace, the Stop
// block); this file holds only the rules, so the two hosts cannot drift apart
// on what "owed" means. The rationale for each rule stays at its H10 call site.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { matchesGlob } from '@sterling/schemas';
import { SterlingStore, resolveDomainMounts } from '@sterling/store';
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
 *
 * Not for ownership reads: a feature_article is always project-scoped, and a
 * domain record's file_keys name files in other repos.
 */
export function openDutyRecords(store, config, { opener = (dbPath) => new SterlingStore(dbPath), onUnreadable }) {
  let domains = null;
  const unreadable = (name, e) => onUnreadable(name, String((e && e.message) || e));
  const mounted = () => {
    if (domains === null) {
      domains = [];
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
          out.push(...d.store.query(opts));
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
    close() {
      const open = domains ?? [];
      domains = [];
      for (const d of open) d.store.close();
    },
  };
}

/** Record types whose write since `earliest` pays the capture duty. */
export const CAPTURE_TYPES = ['decision', 'anti_pattern', 'feature_article', 'research_finding', 'disconfirmed_hypothesis', 'open_question'];
export const capturedSince = (store, earliest) =>
  store.query({ types: CAPTURE_TYPES, cap: 1000 }).some((r) => r.created_at >= earliest || r.updated_at >= earliest);

/** Record types whose write since `earliest` pays the research duty. */
export const RESEARCH_TYPES = ['research_finding', 'decision', 'anti_pattern'];
export const researchCapturedSince = (store, earliest) =>
  store.query({ types: RESEARCH_TYPES, cap: 1000 }).some((r) => r.created_at >= earliest || r.updated_at >= earliest);

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
