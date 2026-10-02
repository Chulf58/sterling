// The subject fan (board c10f139b, decision projects-mount-domains-and-sibling-projects):
// a store-like object over the project store plus the domains the project mounts,
// for the delivery hooks' SUBJECT matching (H20, H23, the H19 dispatch-staging
// subject arm) and the OpenCode axis, which passes its own opener.
//
// What it guarantees:
// - The domain list is config.stack_tags, with config.domain_paths overriding a
//   store path, resolved by @sterling/store's resolveDomainMounts (the resolver the
//   MCP server uses). A configured domain whose store does not exist is skipped and
//   listed on missingDomains; no domain store is ever created here.
// - A query with no file_keys reads every open store at the full cap, and
//   allocateShares decides how many of each store's own ranked list make the cap
//   (project first). Scores are never compared across databases.
// - A query WITH file_keys reads the project store only: a domain record's
//   file_keys name files in other repos, so they must never drive path delivery
//   here (the hazard the decision's sparring round recorded).
// - Every record returned carries source_store: 'project' or the domain name.
//   The key is not a record field (todo records already own `source`).
// What it does NOT do: write, read board or queue state, or fan articlesBySlug
// (feature articles are project-scoped and never promote).
//
// Hooks bundle this module: builtins, sibling libs and @sterling/* only.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore, resolveDomainMounts, allocateShares, DEFAULT_QUERY_CAP, DOMAIN_DESCRIPTION_KEY } from '@sterling/store';
import { loadConfig } from './common.mjs';

const defaultOpener = (dbPath) => new SterlingStore(dbPath);

/**
 * The domain mounts a raw project config declares, as [{name, dbPath}] in
 * manifest order. A null config (no config file) mounts nothing. Only stack_tags
 * and domain_paths are validated, through the config schema, so a malformed value
 * there throws instead of reading as "no domains".
 */
export function domainMountsFromConfig(config) {
  if (config === null || config === undefined) return [];
  return resolveDomainMounts(parseConfig({ stack_tags: config.stack_tags, domain_paths: config.domain_paths }));
}

const tag = (records, source) => records.map((r) => ({ ...r, source_store: source }));

/**
 * Open the subject fan for the project at `cwd`, or null when the project has no
 * store (not Sterling-initialized; nothing is created). `opener(dbPath)` opens one
 * store and defaults to `new SterlingStore(dbPath)`. Any open failure closes the
 * handles opened so far and throws.
 */
export function openSubjectFan(cwd, { opener = defaultOpener } = {}) {
  const projectPath = join(cwd, '.sterling', 'sterling.db');
  if (!existsSync(projectPath)) return null;
  const mounts = domainMountsFromConfig(loadConfig(cwd));
  const project = opener(projectPath);
  const domains = [];
  const missingDomains = [];
  try {
    for (const m of mounts) {
      if (!existsSync(m.dbPath)) {
        missingDomains.push({ name: m.name, dbPath: m.dbPath });
        continue;
      }
      domains.push({ name: m.name, store: opener(m.dbPath) });
    }
  } catch (e) {
    for (const d of domains) d.store.close();
    project.close();
    throw e;
  }
  const sources = [{ name: 'project', store: project }, ...domains];

  return {
    project,
    domainNames: domains.map((d) => d.name),
    missingDomains,
    query(opts = {}) {
      if (opts.file_keys !== undefined || !domains.length) return tag(project.query(opts), 'project');
      const cap = opts.cap ?? DEFAULT_QUERY_CAP;
      const perStore = sources.map((s) => s.store.query({ ...opts, cap }));
      const shares = allocateShares(perStore.map((r) => r.length), cap);
      return perStore.flatMap((records, i) => tag(records.slice(0, shares[i]), sources[i].name));
    },
    /** Supersedes edges live with their SOURCE record, so every mount is read; first seen wins. */
    inboundSupersedes(id) {
      const seen = new Set();
      const out = [];
      for (const s of sources) {
        for (const r of s.store.inboundSupersedes(id)) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          out.push({ ...r, source_store: s.name });
        }
      }
      return out;
    },
    articlesBySlug(slug) {
      return project.articlesBySlug(slug);
    },
    close() {
      let first;
      for (const s of sources) {
        try {
          s.store.close();
        } catch (e) {
          first ??= e;
        }
      }
      if (first) throw first;
    },
  };
}

/**
 * Each configured domain's state for the session-start lines, in manifest order:
 * {name, dbPath, state, description?, error?} with state 'described',
 * 'undescribed' (the store exists but has no description), 'missing' (no store;
 * never created here) or 'unreadable' (the store or its description could not be
 * read; `error` says why). Throws only when the config's domain fields are malformed.
 */
export function describeMountedDomains(config, { opener = defaultOpener } = {}) {
  return domainMountsFromConfig(config).map((m) => {
    if (!existsSync(m.dbPath)) return { name: m.name, dbPath: m.dbPath, state: 'missing' };
    let store;
    try {
      store = opener(m.dbPath);
      const description = store.getMeta(DOMAIN_DESCRIPTION_KEY);
      return description ? { name: m.name, dbPath: m.dbPath, state: 'described', description } : { name: m.name, dbPath: m.dbPath, state: 'undescribed' };
    } catch (e) {
      return { name: m.name, dbPath: m.dbPath, state: 'unreadable', error: String((e && e.message) || e) };
    } finally {
      store?.close();
    }
  });
}
